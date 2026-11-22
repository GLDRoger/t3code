import {
  formatKinWhen,
  KIN_HOST_USAGE_PARTS,
  kinBytesText,
  KIN_HOST_TROUBLE_CARD,
  KinChatError,
  KinHostTroubleCard,
  KinMessageId,
  KinWidgetId,
  kinTroubleWords,
  type KinAgentId,
  type KinEventId,
  type KinHostFreeSpaceResult,
  type KinHostStatus,
  type KinHostUsage,
  type KinOrgId,
  type KinTroubleCause,
  type KinWidget,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";

import packageJson from "../../../package.json" with { type: "json" };
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as HostBackup from "../hostBackup.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { personHoldNow } from "../triggers/quietHold.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";

/** How long a held turn waits before it tries again by itself, by cause. */
export const HOLD_MS: Readonly<Partial<Record<KinTroubleCause, number>>> = {
  space: 5 * 60_000,
  signin: 15 * 60_000,
  access: 15 * 60_000,
  model: 15 * 60_000,
  program: 15 * 60_000,
  usage_limit: 15 * 60_000,
};
/** Causes any agent's next good turn proves gone; the rest clear per agent. */
const HOST_WIDE: ReadonlySet<KinTroubleCause> = new Set(["space", "unreachable"]);
const HELD_IDS_KEPT = 500;
// A low-space warning cleans at most this often; an out-of-space failure always cleans.
const LOW_CLEAN_EVERY_MS = 10 * 60_000;
const LOW_PERCENT = 20;
const OUT_BYTES = 64 * 1024 * 1024;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(KinHostTroubleCard));
const encodeCard = Schema.encodeSync(KinHostTroubleCard);
const decodeDevSpace = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ freeBytes: Schema.Number, totalBytes: Schema.Number })),
);

const encodeDevRecord = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ranAt: Schema.Number,
      ok: Schema.Boolean,
      lastGoodAt: Schema.Number,
      error: Schema.String,
    }),
  ),
);

const MB = 1024 ** 2;

/** What fills the disk, biggest first, in a person's words; undefined when nothing was measured. */
const usingText = (usage: KinHostUsage | null) => {
  if (usage === null) return undefined;
  const parts = KIN_HOST_USAGE_PARTS.map((part) => ({
    name: part.name.toLowerCase().replace(/^kin's/, "Kin's"),
    bytes: usage[part.key],
  }))
    .flatMap(({ name, bytes }) => (bytes === null || bytes < MB ? [] : [{ name, bytes }]))
    .toSorted((a, b) => b.bytes - a.bytes);
  return parts.length === 0
    ? undefined
    : `What's using the space: ${parts.map((part) => `${part.name} ${kinBytesText(part.bytes)}`).join(", ")}.`;
};

/** The clean script's summary line under `--now` (`ops/kin/host/clean-temp.sh`). */
const parseCleanSummary = (stdout: string) => {
  const match = /^kin-clean removed=(\d+) freed_kb=(\d+) failed=(\d+)$/m.exec(stdout);
  return match === null
    ? undefined
    : {
        removed: Number(match[1]),
        freedBytes: Number(match[2]) * 1024,
        failed: Number(match[3]),
      };
};

export interface TroubleInput {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly cause: KinTroubleCause;
  readonly eventIds: ReadonlyArray<KinEventId>;
  readonly detail?: string | undefined;
  readonly resetAt?: string | undefined;
}

/** The dev stand-in's full disk, shaped as Node reports ENOSPC. */
export class KinHostSpaceFull extends Schema.TaggedError<KinHostSpaceFull>()("KinHostSpaceFull", {
  code: Schema.Literal("ENOSPC"),
  errno: Schema.Literal(-28),
  message: Schema.String,
}) {}

/**
 * Kin's computer, cared for by plain server code: the temp clean run at once (never two at a
 * time), the space and backup facts Settings shows, and one open notice per cause of failing
 * turns, in the owner's chat, that counts the turns it holds and closes itself when the cause
 * clears. No model turn decides any of it.
 */
export class KinHostCare extends Context.Service<
  KinHostCare,
  {
    /** A Kin host (`KIN_CHECKOUT`), or a dev server standing in for one (`KIN_DEV_HOST_CARE`). */
    readonly host: boolean;
    /** Runs the clean now with the low-space rule; a run already going is waited for, not doubled. */
    readonly clean: (
      why: "out_of_space" | "low_on_space" | "asked",
    ) => Effect.Effect<KinHostFreeSpaceResult>;
    /** Dev stand-in only: fails as a full disk would while `$TMPDIR/kin-dev-disk-full` exists. */
    readonly devFullDisk: Effect.Effect<void, KinHostSpaceFull>;
    /** A turn failed for `cause`: opens that cause's notice, or counts its turns on the open one. */
    readonly failed: (input: TroubleInput) => Effect.Effect<void>;
    /** A turn of `agentId` ran: the notices it proves cleared close, and their held turns run. */
    readonly succeeded: (orgId: KinOrgId, agentId: KinAgentId) => Effect.Effect<void>;
    /** Whether a notice for `cause` is open in the org. */
    readonly troubleOpen: (orgId: KinOrgId, cause: KinTroubleCause) => Effect.Effect<boolean>;
    /** The open notice's cause that stops `agentId` now, if one does. */
    readonly causeFor: (
      orgId: KinOrgId,
      agentId: KinAgentId,
    ) => Effect.Effect<KinTroubleCause | undefined>;
    /** The hourly backup check: one notice while there is no recent good backup, closed after. */
    readonly checkBackup: (
      orgId: KinOrgId,
      problem: { readonly lastGoodAt: number | null } | undefined,
    ) => Effect.Effect<void>;
    readonly status: (orgId: KinOrgId) => Effect.Effect<KinHostStatus, KinChatError>;
    readonly freeSpace: (orgId: KinOrgId) => Effect.Effect<KinHostFreeSpaceResult, KinChatError>;
    readonly backUpNow: (
      orgId: KinOrgId,
    ) => Effect.Effect<{ readonly started: boolean }, KinChatError>;
    readonly retry: (orgId: KinOrgId) => Effect.Effect<{ readonly requeued: number }, KinChatError>;
  }
>()("t3/kin/host/KinHostCare") {}

const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't read its computer just now. Try again.",
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const queue = yield* KinEventQueue.KinEventQueue;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const checkout = Option.getOrUndefined(yield* Config.option(Config.String("KIN_CHECKOUT")));
  // Dev only: a checkout whose clean script runs on this server's own temp folder, nothing else.
  const devCheckout =
    checkout === undefined
      ? Option.getOrUndefined(yield* Config.option(Config.String("KIN_DEV_HOST_CARE")))
      : undefined;
  const host = checkout !== undefined || devCheckout !== undefined;
  const startedAt = yield* Clock.currentTimeMillis;
  const home = NodeOS.homedir();
  const tmp = NodeOS.tmpdir();
  const backupEnv =
    devCheckout === undefined
      ? path.join(home, ".config", "kin", "backup.env")
      : path.join(config.stateDir, "kin-dev-backup.env");
  const publish = (event: Parameters<KinChatHub["Service"]["publish"]>[0]) =>
    Option.isSome(hub) ? sql.afterCommit(hub.value.publish(event)) : Effect.void;

  const version = yield* Effect.gen(function* () {
    if (checkout === undefined) return packageJson.version;
    const build = yield* fs.realPath(checkout).pipe(Effect.option);
    const sha = Option.map(build, (dir) => path.basename(dir).slice(0, 12));
    return Option.isSome(sha) && /^[0-9a-f]{7,}$/.test(sha.value)
      ? `${packageJson.version} (${sha.value})`
      : packageJson.version;
  });

  const readSpace = Effect.fn("KinHostCare.readSpace")(function* () {
    if (devCheckout !== undefined) {
      const stand = yield* fs
        .readFileString(path.join(config.stateDir, "kin-dev-space.json"))
        .pipe(Effect.option);
      const parsed = Option.flatMap(stand, decodeDevSpace);
      if (Option.isSome(parsed)) return Option.some(parsed.value);
    }
    const readings = yield* Effect.forEach(
      HostBackup.spaceFolders(config.baseDir),
      HostBackup.readSpace,
    );
    // The fullest disk is the one that stops work.
    const worst = readings
      .flatMap((reading) => Option.toArray(reading))
      .filter((reading) => reading.totalBytes > 0)
      .toSorted((a, b) => a.freeBytes / a.totalBytes - b.freeBytes / b.totalBytes)[0];
    return Option.fromNullishOr(worst);
  });
  const levelOf = (space: { readonly freeBytes: number; readonly totalBytes: number }) =>
    space.freeBytes < OUT_BYTES || space.freeBytes * 100 < space.totalBytes
      ? ("out" as const)
      : space.freeBytes * 100 < space.totalBytes * LOW_PERCENT
        ? ("low" as const)
        : ("ok" as const);

  let usage: KinHostUsage | null = null;
  const duBytes = (folder: string) =>
    runner
      .run({ command: "du", args: ["-skx", folder], timeout: "10 minutes", maxOutputBytes: 4096 })
      .pipe(
        Effect.map((out) => {
          const kb = Number(/^(\d+)/.exec(out.stdout)?.[1]);
          return out.code === 0 && Number.isFinite(kb) ? kb * 1024 : null;
        }),
        Effect.orElseSucceed(() => null),
      );
  // Walks the folders in the background, never on a request: Settings shows the last measure.
  const measure = Effect.fn("KinHostCare.measure")(function* () {
    if (!host) return;
    const temporary = yield* duBytes(tmp);
    const data = yield* duBytes(config.baseDir);
    const builds = devCheckout === undefined ? yield* duBytes(path.join(home, "kin-builds")) : null;
    const backups =
      devCheckout === undefined ? yield* duBytes(path.join(home, "kin-update-backups")) : null;
    usage = { temporary, data, builds, backups, measuredAt: iso(yield* Clock.currentTimeMillis) };
  });

  const cleanLock = yield* Semaphore.make(1);
  let lastCleanAt = 0;
  const nothing: KinHostFreeSpaceResult = { ran: false, removed: 0, freedBytes: 0, failed: 0 };
  const clean = Effect.fn("KinHostCare.clean")(
    function* (why: "out_of_space" | "low_on_space" | "asked") {
      const root = checkout ?? devCheckout;
      if (root === undefined) return nothing;
      return yield* cleanLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (why === "low_on_space" && now - lastCleanAt < LOW_CLEAN_EVERY_MS) return nothing;
          lastCleanAt = now;
          const script = path.join(root, "ops", "kin", "host", "clean-temp.sh");
          // A fixed script and fixed flags: nothing a person or an agent typed reaches it.
          const out = yield* runner.run({
            command: "bash",
            args: [script, "--now", ...(devCheckout === undefined ? [] : ["--tmpdir-only"])],
            timeout: "15 minutes",
            maxOutputBytes: 16_384,
            outputMode: "truncate",
          });
          const summary = parseCleanSummary(out.stdout);
          yield* Effect.logInfo("Kin cleared temporary files", {
            why,
            line: out.stdout.split("\n")[0],
          });
          yield* measure().pipe(Effect.forkDetach);
          return summary === undefined ? nothing : { ran: true, ...summary };
        }),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin's temporary clean failed", { cause }).pipe(Effect.as(nothing)),
    ),
  );

  const devFullDisk = Effect.gen(function* () {
    if (devCheckout === undefined) return;
    const full = yield* fs
      .exists(path.join(tmp, "kin-dev-disk-full"))
      .pipe(Effect.orElseSucceed(() => false));
    if (full)
      return yield* new KinHostSpaceFull({
        code: "ENOSPC",
        errno: -28,
        message: "ENOSPC: no space left on device (dev stand-in)",
      });
  });

  const troubleLock = yield* Semaphore.make(1);
  const openCards = Effect.fn("KinHostCare.openCards")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{ widgetId: string; state: string }>`SELECT widget_id AS "widgetId",
        state_json AS state FROM kin_widgets
      WHERE org_id = ${orgId} AND type = ${KIN_HOST_TROUBLE_CARD} AND closed_at IS NULL
      ORDER BY widget_id`;
    return rows.flatMap((row) =>
      Option.toArray(
        Option.map(decodeCard(row.state), (card) => ({
          widgetId: KinWidgetId.make(row.widgetId),
          card,
        })),
      ),
    );
  });
  const heldOf = (card: KinHostTroubleCard) => (card.held ?? []).map((id) => id as KinEventId);
  const words = Effect.fn("KinHostCare.words")(function* (
    orgId: KinOrgId,
    card: KinHostTroubleCard,
  ) {
    const zone = yield* ownerZone(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const now = yield* Clock.currentTimeMillis;
    const locale = yield* textLocale(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const options = { zone, locale };
    const today = formatKinWhen(now, "date", options);
    // Today's time alone, as the notice is read the same day; another day names it.
    const at = (value: string) => {
      const ms = Date.parse(value);
      return formatKinWhen(
        ms,
        formatKinWhen(ms, "date", options) === today ? "time" : "dateTime",
        options,
      );
    };
    // The message says what is wrong; its card carries what changes (the count, the fix).
    return kinTroubleWords(card, at).what;
  });
  const writeCard = Effect.fn("KinHostCare.writeCard")(function* (
    orgId: KinOrgId,
    existing: KinWidget | undefined,
    card: KinHostTroubleCard,
    now: number,
  ) {
    const state = encodeCard(card);
    if (existing !== undefined) {
      const widget = yield* repo.updateWidget({
        ...existing,
        audience: "owner",
        expectedRevision: existing.revision,
        state,
        closedAt: card.closed === null ? null : card.closed.at,
        updatedAt: iso(now),
      });
      yield* publish({ type: "widget.updated", orgId, widget });
      return;
    }
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    if (lead === undefined) return;
    const prefix = `kin-trouble:${orgId}:${card.cause}:`;
    // Callers hold `troubleLock` in a transaction, so the next number is this one's alone.
    const [{ opened } = { opened: 0 }] = yield* sql<{ opened: number }>`SELECT COUNT(*) AS opened
      FROM kin_widgets WHERE org_id = ${orgId} AND type = ${KIN_HOST_TROUBLE_CARD}
        AND substr(widget_id, 1, ${prefix.length}) = ${prefix}`;
    const widgetId = KinWidgetId.make(`${prefix}${opened + 1}`);
    const message = yield* repo.insertMessage({
      orgId,
      chatId: lead.ownerChatId,
      audience: "owner",
      messageId: KinMessageId.make(widgetId),
      author: { _tag: "system" },
      kind: "system",
      body: yield* words(orgId, card),
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: iso(now),
      editedAt: null,
    });
    const widget = {
      orgId,
      chatId: lead.ownerChatId,
      messageId: message.messageId,
      widgetId,
      widgetClass: "native" as const,
      type: KIN_HOST_TROUBLE_CARD,
      state,
      source: null,
      feed: null,
      // Nobody is awaited: the message's own push is the one ring, and redraws ring no one.
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: iso(now),
    };
    yield* repo.insertWidget({ ...widget, audience: "owner" });
    // The insert links the message to the card; clients only attach a card through that link.
    yield* publish({ type: "message.posted", orgId, message: { ...message, widgetId } });
    yield* publish({ type: "widget.updated", orgId, widget: { ...widget, revision: 1 } });
  });
  const widgetOf = (orgId: KinOrgId, widgetId: KinWidgetId) =>
    repo.getWidget({ orgId, widgetId }).pipe(Effect.map(Option.getOrUndefined));

  const failed = Effect.fn("KinHostCare.failed")(
    function* (input: TroubleInput) {
      const { orgId } = input;
      yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const [agent] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
              WHERE org_id = ${orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
            const open = (yield* openCards(orgId)).find((one) => one.card.cause === input.cause);
            const before = open?.card;
            const held = new Set(before?.held ?? []);
            const fresh = input.eventIds.filter((id) => !held.has(id));
            for (const id of fresh) held.add(id);
            const agents = before?.agents ?? [];
            const named = agents.some((one) => one.agentId === input.agentId)
              ? agents
              : [...agents, { agentId: input.agentId, name: agent?.name ?? "An agent" }];
            const using = input.cause === "space" ? usingText(usage) : undefined;
            const resetAt = input.resetAt ?? before?.resetAt;
            const card: KinHostTroubleCard = {
              cause: input.cause,
              agents: named.slice(0, 50),
              count: (before?.count ?? 0) + fresh.length,
              openedAt: before?.openedAt ?? iso(now),
              ...(resetAt === undefined ? {} : { resetAt }),
              ...(using === undefined ? {} : { using }),
              ...(input.detail === undefined ? {} : { detail: input.detail.slice(0, 600) }),
              held: [...held].slice(-HELD_IDS_KEPT),
              closed: null,
            };
            const widget = open === undefined ? undefined : yield* widgetOf(orgId, open.widgetId);
            yield* writeCard(orgId, widget, card, now);
          }),
        ),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin trouble notice failed", { cause })),
  );

  const close = Effect.fn("KinHostCare.close")(function* (
    orgId: KinOrgId,
    which: (card: KinHostTroubleCard) => boolean,
  ) {
    yield* troubleLock.withPermits(1)(
      Effect.gen(function* () {
        for (const open of yield* openCards(orgId)) {
          if (!which(open.card)) continue;
          const ran = yield* queue.wake(orgId, heldOf(open.card));
          const widget = yield* widgetOf(orgId, open.widgetId);
          if (widget === undefined) continue;
          const now = yield* Clock.currentTimeMillis;
          yield* sql.withTransaction(
            writeCard(orgId, widget, { ...open.card, closed: { at: iso(now), ran } }, now),
          );
        }
      }),
    );
  });

  const succeeded = Effect.fn("KinHostCare.succeeded")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      yield* close(
        orgId,
        (card) =>
          card.cause !== "backup" &&
          (HOST_WIDE.has(card.cause) || card.agents.some((one) => one.agentId === agentId)),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin trouble close failed", { cause })),
  );

  const troubleOpen = (orgId: KinOrgId, cause: KinTroubleCause) =>
    openCards(orgId).pipe(
      Effect.map((cards) => cards.some((one) => one.card.cause === cause)),
      Effect.orElseSucceed(() => false),
    );

  const causeFor = (orgId: KinOrgId, agentId: KinAgentId) =>
    openCards(orgId).pipe(
      Effect.map(
        (cards) =>
          cards.find(
            ({ card }) =>
              card.cause !== "backup" &&
              (HOST_WIDE.has(card.cause) || card.agents.some((one) => one.agentId === agentId)),
          )?.card.cause,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const backupConfigured = fs.exists(backupEnv).pipe(Effect.orElseSucceed(() => false));
  const checkBackup = Effect.fn("KinHostCare.checkBackup")(
    function* (orgId: KinOrgId, problem: { readonly lastGoodAt: number | null } | undefined) {
      const open = (yield* openCards(orgId)).find((one) => one.card.cause === "backup");
      if (problem === undefined) {
        if (open !== undefined) yield* close(orgId, (card) => card.cause === "backup");
        return;
      }
      const configured = yield* backupConfigured;
      const lastGoodAt = problem.lastGoodAt === null ? undefined : iso(problem.lastGoodAt);
      const now = yield* Clock.currentTimeMillis;
      if (open !== undefined) {
        if (open.card.backupConfigured === configured && open.card.lastGoodAt === lastGoodAt)
          return;
        const widget = yield* widgetOf(orgId, open.widgetId);
        if (widget === undefined) return;
        const { lastGoodAt: _was, ...rest } = open.card;
        yield* troubleLock.withPermits(1)(
          sql.withTransaction(
            writeCard(
              orgId,
              widget,
              {
                ...rest,
                backupConfigured: configured,
                ...(lastGoodAt === undefined ? {} : { lastGoodAt }),
              },
              now,
            ),
          ),
        );
        return;
      }
      // Posted outside the owner's quiet hours: the next hourly check tries again.
      const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
      if (lead === undefined) return;
      const hold = yield* personHoldNow(orgId, lead.ownerPersonId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (hold !== undefined) return;
      yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          writeCard(
            orgId,
            undefined,
            {
              cause: "backup",
              agents: [],
              count: 0,
              openedAt: iso(now),
              backupConfigured: configured,
              ...(lastGoodAt === undefined ? {} : { lastGoodAt }),
              closed: null,
            },
            now,
          ),
        ),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin backup notice failed", { cause })),
  );

  const backupStatus = Effect.gen(function* () {
    const file = yield* fs
      .readFileString(path.join(config.stateDir, HostBackup.BACKUP_STATUS_FILE))
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    const record = Option.getOrUndefined(HostBackup.backupRecord(file));
    return {
      configured: yield* backupConfigured,
      lastGoodAt: record?.lastGoodAt == null ? null : iso(record.lastGoodAt),
      lastTriedAt: record?.ranAt == null ? null : iso(record.ranAt),
      failed: record === undefined || record.ok || record.error === "" ? null : record.error,
    };
  });

  const status = Effect.fn("KinHostCare.status")(
    function* (orgId: KinOrgId) {
      const space = yield* readSpace();
      const [counts] = yield* sql<{ running: number; held: number }>`SELECT
          (SELECT COUNT(*) FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running') AS running,
          (SELECT COUNT(*) FROM kin_events WHERE org_id = ${orgId} AND state = 'queued'
            AND attempts > 0) AS held`;
      const troubles = (yield* openCards(orgId)).map(({ widgetId, card }) => {
        const { held: _held, ...shown } = card;
        return { widgetId, card: shown };
      });
      const heldByTroubles = troubles.reduce((total, one) => total + one.card.count, 0);
      return {
        host,
        space: Option.isNone(space)
          ? null
          : {
              freeBytes: Math.max(0, Math.floor(space.value.freeBytes)),
              totalBytes: Math.max(0, Math.floor(space.value.totalBytes)),
              level: levelOf(space.value),
              usage,
            },
        backup: host ? yield* backupStatus : null,
        agents: {
          running: counts?.running ?? 0,
          held: Math.max(heldByTroubles, counts?.held ?? 0),
          troubles,
        },
        version,
        startedAt: iso(startedAt),
      } satisfies KinHostStatus;
    },
    Effect.mapError(() => unavailable),
    NodeSqliteClient.readOnly,
  );

  const retry = Effect.fn("KinHostCare.retry")(
    function* (orgId: KinOrgId) {
      let requeued = 0;
      for (const open of yield* openCards(orgId))
        if (open.card.cause !== "backup") requeued += yield* queue.wake(orgId, heldOf(open.card));
      return { requeued };
    },
    Effect.mapError(() => unavailable),
  );

  const freeSpace = Effect.fn("KinHostCare.freeSpace")(function* (orgId: KinOrgId) {
    const result = yield* clean("asked");
    // Space came back: the held turns try now instead of at their wait's end.
    if (result.ran && result.removed > 0) yield* retry(orgId);
    return result;
  });

  const backUpNow = Effect.fn("KinHostCare.backUpNow")(
    function* (_orgId: KinOrgId) {
      if (!host || !(yield* backupConfigured)) return { started: false };
      if (devCheckout !== undefined) {
        // Dev stand-in for backup.sh's own record of a good run, so the notice's way out shows.
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          path.join(config.stateDir, HostBackup.BACKUP_STATUS_FILE),
          `${encodeDevRecord({ ranAt: now, ok: true, lastGoodAt: now, error: "" })}\n`,
        );
        return { started: true };
      }
      // The same unit the nightly timer starts; systemd runs one at a time.
      const out = yield* runner.run({
        command: "systemctl",
        args: ["--user", "start", "--no-block", "kin-backup.service"],
        timeout: "1 minute",
      });
      return { started: out.code === 0 };
    },
    Effect.mapError(() => unavailable),
  );

  if (host)
    yield* Effect.gen(function* () {
      yield* measure();
      yield* Effect.sleep("1 hour");
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Kin disk measure failed", { cause })),
      Effect.forever,
      Effect.forkScoped,
    );

  return KinHostCare.of({
    host,
    clean,
    devFullDisk,
    failed,
    succeeded,
    troubleOpen,
    causeFor,
    checkBackup,
    status,
    freeSpace,
    backUpNow,
    retry,
  });
});

export const layer = Layer.effect(KinHostCare, make).pipe(Layer.provide(ProcessRunner.layer));
