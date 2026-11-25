import {
  formatKinWhen,
  KIN_HOST_USAGE_PARTS,
  kinBytesText,
  KIN_HOST_TROUBLE_CARD,
  KinChatError,
  KinChatId,
  KinEventId,
  KinHostTroubleCard,
  KinMessageId,
  KinScheduledTaskCard,
  KIN_TROUBLE_WHY,
  KinWidgetId,
  kinTroubleWords,
  type KinAgentId,
  type KinHostBackUpResult,
  type KinHostFreeSpaceResult,
  type KinHostStatus,
  type KinHostUsage,
  type KinOrgId,
  type KinPersonId,
  type KinTroubleCause,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
import { ownerPrivateChat } from "../chat/executionNotices.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as HostBackup from "../hostBackup.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { personHoldNow } from "../triggers/quietHold.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import { offlineCatchUpWords, type OfflineCounts } from "./offlineWords.ts";

/** How long a held turn waits before it tries again by itself, by cause. */
export const HOLD_MS: Readonly<Partial<Record<KinTroubleCause, number>>> = {
  space: 5 * 60_000,
  signin: 15 * 60_000,
  access: 15 * 60_000,
  model: 15 * 60_000,
  program: 15 * 60_000,
  usage_limit: 15 * 60_000,
  memory: KinEventQueue.FIRST_RETRY_MS,
};
/** Causes any stopped agent's next good turn proves gone; the rest clear agent by agent. */
const HOST_WIDE: ReadonlySet<KinTroubleCause> = new Set(["space"]);
// A low-space warning cleans at most this often; an out-of-space failure always cleans.
const LOW_CLEAN_EVERY_MS = 10 * 60_000;
const LOW_PERCENT = 20;
const OUT_BYTES = 64 * 1024 * 1024;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeCardValue = Schema.decodeUnknownOption(KinHostTroubleCard);
const decodeRunCard = Schema.decodeUnknownOption(KinScheduledTaskCard);
const encodeRunCard = Schema.encodeSync(KinScheduledTaskCard);
const encodeCard = Schema.encodeSync(KinHostTroubleCard);
const encodeCardJson = Schema.encodeSync(Schema.fromJsonString(KinHostTroubleCard));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
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
/**
 * What uses the space, as Settings splits it, and plainly when Kin can't make room alone: what it
 * may clear (temporary files, old builds and backups) is under a tenth of what is used.
 */
export const usingText = (
  usage: KinHostUsage | null,
  space: { readonly freeBytes: number; readonly totalBytes: number } | undefined,
) => {
  if (usage === null) return undefined;
  const sum = (keys: ReadonlyArray<(typeof KIN_HOST_USAGE_PARTS)[number]["key"]>) =>
    keys.reduce((total, key) => total + (usage[key] ?? 0), 0);
  const kin = sum(
    KIN_HOST_USAGE_PARTS.map((part) => part.key).filter((key) => key !== "temporary"),
  );
  const temporary = usage.temporary ?? 0;
  const used = space === undefined ? undefined : space.totalBytes - space.freeBytes;
  const parts = [
    { name: "Kin's data", bytes: kin },
    { name: "temporary files", bytes: temporary },
    ...(used === undefined
      ? []
      : [{ name: "everything else on this computer", bytes: Math.max(0, used - kin - temporary) }]),
  ]
    .filter((part) => part.bytes >= MB)
    .toSorted((a, b) => b.bytes - a.bytes);
  if (parts.length === 0) return undefined;
  const line = `What's using the space: ${parts.map((part) => `${part.name} ${kinBytesText(part.bytes)}`).join(", ")}.`;
  const clearable = sum(["temporary", "builds", "backups"]);
  return used === undefined || clearable * 10 >= used
    ? line
    : `${line} Kin can't free this by itself: it can clear about ${kinBytesText(clearable)} of the ${kinBytesText(used)} in use. Whoever set up Kin's computer can make room.`;
};

/** The clean script's summary line under `--now` (`ops/kin/host/clean-temp.sh`). */
const parseCleanSummary = (stdout: string) => {
  const match =
    /^kin-clean removed=(\d+) freed_kb=(\d+) failed=(\d+)(?: builds=(\d+) backups=(\d+))?$/m.exec(
      stdout,
    );
  return match === null
    ? undefined
    : {
        removed: Number(match[1]),
        freedBytes: Number(match[2]) * 1024,
        failed: Number(match[3]),
        ...(match[4] === undefined ? {} : { builds: Number(match[4]), backups: Number(match[5]) }),
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
    /** Runs the clean now; a run already going is shared, never doubled. */
    readonly clean: (
      why: "out_of_space" | "low_on_space" | "asked",
    ) => Effect.Effect<KinHostFreeSpaceResult>;
    /**
     * A turn of `agentId` failed for space: records it on the space trouble and, the first time
     * for that trouble, runs its one automatic clean. True when this was that clean, so the turn
     * may try once more at once.
     */
    readonly spaceFailed: (orgId: KinOrgId, agentId: KinAgentId) => Effect.Effect<boolean>;
    /**
     * Kin's own storage failed for space before a turn could start (its database could not
     * write): the clean runs once until writes work again, and the queue is left as it was.
     */
    readonly storageFailed: (orgId: KinOrgId) => Effect.Effect<void>;
    /** Writes work again: a storage failure seen meanwhile becomes the space trouble, told. */
    readonly storageRecovered: (orgId: KinOrgId) => Effect.Effect<void>;
    /** Dev stand-in only: fails as a full disk would while `$TMPDIR/kin-dev-disk-full` exists. */
    readonly devFullDisk: Effect.Effect<void, KinHostSpaceFull>;
    /**
     * A turn failed for `cause`: opens that cause's trouble, or counts its turns on the open one.
     * True when the owner has been told of it in a chat only they read.
     */
    readonly failed: (input: TroubleInput) => Effect.Effect<boolean>;
    /** A turn of `agentId` ran: the notices it proves cleared close, and their held turns run. */
    readonly succeeded: (orgId: KinOrgId, agentId: KinAgentId) => Effect.Effect<void>;
    /** Whether a notice for `cause` is open in the org. */
    readonly troubleOpen: (orgId: KinOrgId, cause: KinTroubleCause) => Effect.Effect<boolean>;
    /** The open trouble that stops `agentId` now, if one does, and whether the owner was told. */
    readonly causeFor: (
      orgId: KinOrgId,
      agentId: KinAgentId,
    ) => Effect.Effect<{ readonly cause: KinTroubleCause; readonly told: boolean } | undefined>;
    /** Redraws open notices and any still showing as open after the trouble closed. */
    readonly refresh: (
      orgId: KinOrgId,
      options?: { readonly closedOnly: true },
    ) => Effect.Effect<void>;
    /** The hourly backup check: one notice while there is no recent good backup, closed after. */
    readonly checkBackup: (
      orgId: KinOrgId,
      problem: { readonly lastGoodAt: number | null } | undefined,
    ) => Effect.Effect<void>;
    readonly postOfflineNotice: (
      orgId: KinOrgId,
      notice: OfflineCounts & { readonly from: number; readonly to: number },
    ) => Effect.Effect<boolean, KinChatError>;
    readonly status: (orgId: KinOrgId) => Effect.Effect<KinHostStatus, KinChatError>;
    readonly freeSpace: (orgId: KinOrgId) => Effect.Effect<KinHostFreeSpaceResult, KinChatError>;
    readonly backUpNow: (orgId: KinOrgId) => Effect.Effect<KinHostBackUpResult, KinChatError>;
    readonly retry: (orgId: KinOrgId) => Effect.Effect<{ readonly requeued: number }, KinChatError>;
  }
>()("t3/kin/host/KinHostCare") {}

const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Kin couldn't read its computer just now. Try again.",
});

// Only finish's partway branch leaves a failed event attached to its wake-up.
const strandedEvent = (sql: SqlClient.SqlClient) =>
  sql`e.state = 'failed' AND e.wakeup_id IS NOT NULL`;

/** In the retirement transaction, close troubles with no other agent still stopped. */
export const closeRetiredTroubles = Effect.fn("KinHostCare.closeRetiredTroubles")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_troubles AS t SET closed_at = ${at}
    WHERE t.org_id = ${orgId} AND t.closed_at IS NULL AND t.cause <> 'backup'
      AND EXISTS (SELECT 1 FROM kin_trouble_agents a WHERE a.org_id = t.org_id
        AND a.trouble_id = t.trouble_id AND a.agent_id = ${agentId})
      AND NOT EXISTS (SELECT 1 FROM kin_trouble_agents a JOIN kin_agents l
        ON l.org_id = a.org_id AND l.agent_id = a.agent_id AND l.retired_at IS NULL
        WHERE a.org_id = t.org_id AND a.trouble_id = t.trouble_id AND a.worked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM kin_events e
        WHERE e.org_id = t.org_id AND e.held_by = t.trouble_id AND ${strandedEvent(sql)})`;
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
  let measuredAt: number | undefined;
  let measuring = false;
  const walk = Effect.gen(function* () {
    const temporary = yield* duBytes(tmp);
    const data = yield* duBytes(config.baseDir);
    const builds = devCheckout === undefined ? yield* duBytes(path.join(home, "kin-builds")) : null;
    const backups =
      devCheckout === undefined ? yield* duBytes(path.join(home, "kin-update-backups")) : null;
    const at = yield* Clock.currentTimeMillis;
    usage = { temporary, data, builds, backups, measuredAt: iso(at) };
    measuredAt = at;
  });
  /**
   * Walks only Kin's own folders, in the background and one walk at a time; a request reads the
   * last measure. It walks at start, after a clean, and when something reads it an hour on: never
   * on a timer, so an idle Kin walks nothing and a clock that jumps can't make it walk per hour.
   */
  const measure = Effect.fn("KinHostCare.measure")(function* (when: "stale" | "now" = "stale") {
    if (!host || measuring) return;
    const now = yield* Clock.currentTimeMillis;
    if (when === "stale" && measuredAt !== undefined && now - measuredAt < 60 * 60_000) return;
    measuring = true;
    yield* walk.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Kin disk measure failed", { cause })),
      Effect.ensuring(Effect.sync(() => (measuring = false))),
      Effect.forkDetach,
    );
  });

  let lastCleanAt = 0;
  // The one clean running now, if any: a second caller gets its result instead of another run.
  let running: Deferred.Deferred<KinHostFreeSpaceResult> | undefined;
  const nothing: KinHostFreeSpaceResult = { ran: false, removed: 0, freedBytes: 0, failed: 0 };
  const runClean = Effect.fn("KinHostCare.runClean")(
    function* (why: "out_of_space" | "low_on_space" | "asked") {
      const root = checkout ?? devCheckout;
      if (root === undefined) return nothing;
      const script = path.join(root, "ops", "kin", "host", "clean-temp.sh");
      // A fixed script and fixed flags: nothing a person or an agent typed reaches it.
      const out = yield* runner.run({
        command: "bash",
        args: [
          script,
          "--now",
          // Only a turn that failed for space makes two hours old; a tap keeps the day rule
          // unless the script finds space low itself.
          ...(why === "out_of_space" ? ["--space-failed"] : []),
          ...(devCheckout === undefined ? [] : ["--tmpdir-only"]),
        ],
        timeout: "15 minutes",
        maxOutputBytes: 16_384,
        outputMode: "truncate",
      });
      const summary = parseCleanSummary(out.stdout);
      yield* Effect.logInfo("Kin cleared temporary files", {
        why,
        line: out.stdout.split("\n")[0],
      });
      yield* measure("now");
      return summary === undefined ? nothing : { ran: true, ...summary };
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin's temporary clean failed", { cause }).pipe(Effect.as(nothing)),
    ),
  );
  const clean = Effect.fn("KinHostCare.clean")(function* (
    why: "out_of_space" | "low_on_space" | "asked",
  ) {
    if (running !== undefined) return yield* Deferred.await(running);
    const now = yield* Clock.currentTimeMillis;
    if (why === "low_on_space" && now - lastCleanAt < LOW_CLEAN_EVERY_MS) return nothing;
    lastCleanAt = now;
    const shared = Deferred.makeUnsafe<KinHostFreeSpaceResult>();
    running = shared;
    return yield* runClean(why).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          running = undefined;
        }).pipe(
          Effect.andThen(Deferred.succeed(shared, exit._tag === "Success" ? exit.value : nothing)),
        ),
      ),
    );
  });

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

  // One writer of troubles at a time in this process; the open-cause index guards the rest.
  const troubleLock = yield* Semaphore.make(1);
  type Trouble = {
    readonly troubleId: string;
    readonly cause: KinTroubleCause;
    readonly openedAt: number;
    readonly closedAt: number | null;
    readonly autoCleanAt: number | null;
    readonly toldAt: number | null;
    readonly resetAt: string | null;
    readonly detail: string | null;
    readonly backupConfigured: number | null;
    readonly lastGoodAt: string | null;
  };
  const troubleColumns = sql`trouble_id AS "troubleId", cause, opened_at AS "openedAt",
    closed_at AS "closedAt", auto_clean_at AS "autoCleanAt", told_at AS "toldAt",
    reset_at AS "resetAt", detail, backup_configured AS "backupConfigured",
    last_good_at AS "lastGoodAt"`;
  const openTroubles = (orgId: KinOrgId) =>
    sql<Trouble>`SELECT ${troubleColumns} FROM kin_troubles
      WHERE org_id = ${orgId} AND closed_at IS NULL ORDER BY trouble_id`;
  const troubleById = (orgId: KinOrgId, troubleId: string) =>
    sql<Trouble>`SELECT ${troubleColumns} FROM kin_troubles
      WHERE org_id = ${orgId} AND trouble_id = ${troubleId} ORDER BY trouble_id`.pipe(
      Effect.map((rows) => rows[0]),
    );
  const stranded = strandedEvent(sql);
  const heldIds = (orgId: KinOrgId, troubleId: string, automatic: boolean, agentId?: KinAgentId) =>
    sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events e
      WHERE org_id = ${orgId} AND held_by = ${troubleId} AND state IN ('queued', 'failed')
        AND (${agentId ?? null} IS NULL OR agent_id = ${agentId ?? null})
        AND (NOT ${automatic} OR NOT (${stranded}))
      ORDER BY event_id`.pipe(
      Effect.map((rows) => rows.map((row) => KinEventId.make(row.eventId))),
    );

  /**
   * A scheduled run's card says it waits, and why, while a trouble holds its turn (`why`), and
   * stops saying so once the turn is let go (`why` undefined). Its result settles the card later.
   */
  const noteRuns = Effect.fn("KinHostCare.noteRuns")(
    function* (orgId: KinOrgId, eventIds: ReadonlyArray<KinEventId>, why: string | undefined) {
      if (eventIds.length === 0) return;
      const cards = yield* sql<{ widgetId: string }>`SELECT DISTINCT widget_id AS "widgetId"
        FROM kin_lead_deliveries WHERE org_id = ${orgId} AND kind = 'scheduled_task'
          AND status = 'pending' AND widget_id IS NOT NULL
          AND event_id IN (SELECT value FROM json_each(${yield* encodeIds(eventIds)}))
        ORDER BY widget_id`;
      for (const { widgetId } of cards) {
        const existing = yield* repo
          .getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) })
          .pipe(Effect.map(Option.getOrUndefined));
        if (existing === undefined) continue;
        const card = decodeRunCard(existing.state);
        if (Option.isNone(card)) continue;
        const run = card.value.lastRun;
        if (run === null || run.status !== "running" || run.note === why) continue;
        const { note: _note, ...rest } = run;
        const state = encodeRunCard({
          ...card.value,
          lastRun: why === undefined ? rest : { ...rest, note: why },
        });
        const widget = yield* repo.updateWidget({
          ...existing,
          audience: "owner",
          expectedRevision: existing.revision,
          state,
          updatedAt: iso(yield* Clock.currentTimeMillis),
        });
        yield* publish({ type: "widget.updated", orgId, widget });
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin run card not noted", { cause })),
  );

  /** The notice's facts, read from the trouble and its turns' own rows. */
  const cardOf = Effect.fn("KinHostCare.cardOf")(function* (orgId: KinOrgId, trouble: Trouble) {
    const agents = yield* sql<{
      agentId: string;
      name: string;
      instanceId: string | null;
    }>`SELECT a.agent_id AS "agentId", a.name, a.instance_id AS "instanceId"
      FROM kin_trouble_agents a
      WHERE a.org_id = ${orgId} AND a.trouble_id = ${trouble.troubleId}
        AND (${trouble.closedAt} IS NOT NULL OR (a.worked_at IS NULL AND EXISTS (
          SELECT 1 FROM kin_agents l WHERE l.org_id = a.org_id AND l.agent_id = a.agent_id
            AND l.retired_at IS NULL)))
      ORDER BY a.rowid`;
    const [counts] = yield* sql<{
      held: number | null;
      done: number | null;
      expiring: number | null;
      stopped: number | null;
      stranded: number | null;
    }>`SELECT
        SUM(CASE WHEN e.state = 'queued' THEN 1 ELSE 0 END) AS held,
        SUM(CASE WHEN e.state = 'failed' THEN 1 ELSE 0 END) AS stopped,
        SUM(CASE WHEN ${stranded} THEN 1 ELSE 0 END) AS stranded,
        SUM(CASE WHEN e.state = 'done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN e.state = 'queued' AND EXISTS (SELECT 1 FROM kin_lead_deliveries d
          WHERE d.org_id = e.org_id AND d.event_id = e.event_id AND d.status = 'pending')
          THEN 1 ELSE 0 END) AS expiring
      FROM kin_events e WHERE e.org_id = ${orgId} AND e.held_by = ${trouble.troubleId}`;
    if (trouble.cause === "space" && trouble.closedAt === null) yield* measure();
    const using =
      trouble.cause === "space"
        ? usingText(usage, Option.getOrUndefined(yield* readSpace()))
        : undefined;
    return {
      cause: trouble.cause,
      agents: agents.slice(0, 50).map((agent) => ({
        agentId: agent.agentId as KinAgentId,
        name: agent.name,
        ...(agent.instanceId === null ? {} : { instanceId: agent.instanceId }),
      })),
      count: counts?.held ?? 0,
      openedAt: iso(trouble.openedAt),
      ...(trouble.resetAt === null ? {} : { resetAt: trouble.resetAt }),
      ...(using === undefined ? {} : { using }),
      ...(trouble.backupConfigured === null
        ? {}
        : { backupConfigured: trouble.backupConfigured === 1 }),
      ...(trouble.lastGoodAt === null ? {} : { lastGoodAt: trouble.lastGoodAt }),
      ...(trouble.detail === null ? {} : { detail: trouble.detail }),
      ...((counts?.expiring ?? 0) > 0 && trouble.closedAt === null
        ? { expiring: counts!.expiring! }
        : {}),
      ...((counts?.stopped ?? 0) > 0 && trouble.closedAt === null
        ? { stopped: counts!.stopped! }
        : {}),
      ...((counts?.stranded ?? 0) > 0 && trouble.closedAt === null
        ? { stranded: counts!.stranded! }
        : {}),
      closed:
        trouble.closedAt === null ? null : { at: iso(trouble.closedAt), ran: counts?.done ?? 0 },
    } satisfies KinHostTroubleCard;
  });

  const noticeWhen = Effect.fn("KinHostCare.noticeWhen")(function* (orgId: KinOrgId) {
    const zone = yield* ownerZone(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const now = yield* Clock.currentTimeMillis;
    const locale = yield* textLocale(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const options = { zone, locale };
    const today = formatKinWhen(now, "date", options);
    // Today's time alone, as the notice is read the same day; another day names it.
    return (ms: number) =>
      formatKinWhen(
        ms,
        formatKinWhen(ms, "date", options) === today ? "time" : "dateTime",
        options,
      );
  });

  const words = Effect.fn("KinHostCare.words")(function* (
    orgId: KinOrgId,
    card: KinHostTroubleCard,
  ) {
    const at = yield* noticeWhen(orgId);
    // The message says what is wrong; its card carries what changes (the count, the fix).
    return kinTroubleWords(card, (value) => at(Date.parse(value))).what;
  });

  const noticeOwner = (orgId: KinOrgId) => liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  const noticeHeld = (orgId: KinOrgId, personId: KinPersonId) =>
    personHoldNow(orgId, personId).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  /** Where the owner is told: a chat only they read, else nowhere (Settings still shows it). */
  const noticeChat = Effect.fn("KinHostCare.noticeChat")(function* (orgId: KinOrgId) {
    const lead = yield* noticeOwner(orgId);
    return lead === undefined ? undefined : yield* ownerPrivateChat(sql, orgId, lead.ownerPersonId);
  });

  const insertNotice = Effect.fn("KinHostCare.insertNotice")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    messageId: KinMessageId,
    body: string,
    now: number,
  ) {
    return yield* repo.insertMessage({
      orgId,
      chatId,
      audience: "owner",
      messageId,
      author: { _tag: "system" },
      kind: "system",
      body,
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
  });

  const postOfflineNotice = Effect.fn("KinHostCare.postOfflineNotice")(
    function* (
      orgId: KinOrgId,
      notice: OfflineCounts & { readonly from: number; readonly to: number },
    ) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const messageId = KinMessageId.make(`kin-offline:${notice.from}`);
          if (Option.isSome(yield* repo.getMessage({ orgId, messageId }))) return true;
          const lead = yield* noticeOwner(orgId);
          if (lead === undefined || (yield* noticeHeld(orgId, lead.ownerPersonId)) !== undefined)
            return false;
          const chatId = yield* ownerPrivateChat(sql, orgId, lead.ownerPersonId);
          if (chatId === undefined) return false;
          const at = yield* noticeWhen(orgId);
          const message = yield* insertNotice(
            orgId,
            chatId,
            messageId,
            offlineCatchUpWords(at(notice.from), at(notice.to), notice),
            yield* Clock.currentTimeMillis,
          );
          yield* publish({ type: "message.posted", orgId, message });
          return true;
        }),
      );
    },
    Effect.mapError(() => unavailable),
  );

  /**
   * Draws the trouble's notice from its stored state: redraws a posted one when its facts changed,
   * and posts it when `announce` and nothing was posted yet. Posting records that the owner was
   * told; a refused post leaves the trouble as it is, still shown in Settings.
   */
  const project = Effect.fn("KinHostCare.project")(function* (
    orgId: KinOrgId,
    troubleId: string,
    announce: boolean,
  ) {
    const trouble = yield* troubleById(orgId, troubleId);
    if (trouble === undefined) return;
    const card = yield* cardOf(orgId, trouble);
    const state = encodeCard(card);
    const now = yield* Clock.currentTimeMillis;
    const widgetId = KinWidgetId.make(troubleId);
    const existing = yield* repo
      .getWidget({ orgId, widgetId })
      .pipe(Effect.map(Option.getOrUndefined));
    if (existing !== undefined) {
      const shown = decodeCardValue(existing.state);
      if (Option.isSome(shown) && encodeCardJson(shown.value) === encodeCardJson(card)) return;
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
    const messageId = KinMessageId.make(widgetId);
    const body = announce && trouble.closedAt === null ? yield* words(orgId, card) : undefined;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (Option.isSome(yield* repo.getWidget({ orgId, widgetId }))) return;
        const [bare] = yield* sql<{
          chatId: KinChatId;
        }>`SELECT chat_id AS "chatId" FROM kin_messages
          WHERE org_id = ${orgId} AND message_id = ${messageId} AND kind = 'system'
            AND author_kind = 'system' AND status = 'posted' AND widget_id IS NULL
          ORDER BY message_id`;
        if (bare === undefined && body === undefined) return;
        const chatId = bare?.chatId ?? (yield* noticeChat(orgId));
        if (chatId === undefined) return;
        if (bare === undefined && body !== undefined)
          yield* insertNotice(orgId, chatId, messageId, body, now);
        const widget = {
          orgId,
          chatId,
          messageId,
          widgetId,
          widgetClass: "native" as const,
          type: KIN_HOST_TROUBLE_CARD,
          state,
          source: null,
          feed: null,
          // Nobody is awaited: the message's own push is the one ring, and redraws ring no one.
          awaiting: [],
          pinnedAt: null,
          closedAt: card.closed?.at ?? null,
          updatedAt: iso(now),
        };
        yield* repo.insertWidget({ ...widget, audience: "owner" });
        yield* sql`UPDATE kin_troubles SET told_at = COALESCE(told_at, ${now})
          WHERE org_id = ${orgId} AND trouble_id = ${troubleId}`;
        const linked = yield* repo.getMessage({ orgId, messageId });
        if (Option.isSome(linked))
          yield* publish({
            type: bare === undefined ? "message.posted" : "message.changed",
            orgId,
            message: linked.value,
          });
        yield* publish({ type: "widget.updated", orgId, widget: { ...widget, revision: 1 } });
      }),
    );
  });
  /** A notice that can't be drawn never undoes the trouble it shows. */
  const projectQuietly = (orgId: KinOrgId, troubleId: string, announce: boolean) =>
    project(orgId, troubleId, announce).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin trouble notice not drawn", { orgId, troubleId, cause }),
      ),
    );

  /** The open trouble for `cause`, opened now if there is none. Inside a transaction. */
  const openOrGet = Effect.fn("KinHostCare.openOrGet")(function* (
    orgId: KinOrgId,
    cause: KinTroubleCause,
    now: number,
  ) {
    const [open] = yield* sql<{ troubleId: string }>`SELECT trouble_id AS "troubleId"
      FROM kin_troubles WHERE org_id = ${orgId} AND cause = ${cause} AND closed_at IS NULL
      ORDER BY trouble_id`;
    if (open !== undefined) return open.troubleId;
    const prefix = `kin-trouble:${orgId}:${cause}:`;
    // Numbered after every earlier one, including notices drawn before troubles had a table.
    const [{ before } = { before: 0 }] = yield* sql<{ before: number }>`SELECT MAX(
        (SELECT COUNT(*) FROM kin_troubles WHERE org_id = ${orgId} AND cause = ${cause}),
        (SELECT COUNT(*) FROM kin_widgets WHERE org_id = ${orgId}
          AND type = ${KIN_HOST_TROUBLE_CARD} AND substr(widget_id, 1, ${prefix.length}) = ${prefix})
      ) AS before`;
    const troubleId = `${prefix}${before + 1}`;
    yield* sql`INSERT INTO kin_troubles (trouble_id, org_id, cause, opened_at)
      VALUES (${troubleId}, ${orgId}, ${cause}, ${now})`;
    return troubleId;
  });

  const agentActive = Effect.fn("KinHostCare.agentActive")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const [found] = yield* sql`SELECT 1 FROM kin_agents
      WHERE org_id = ${orgId} AND agent_id = ${agentId} AND retired_at IS NULL`;
    return found !== undefined;
  });

  /** `agentId` is stopped by the trouble (again, if it had worked since). */
  const stopped = (orgId: KinOrgId, troubleId: string, agentId: KinAgentId) =>
    sql`INSERT INTO kin_trouble_agents (trouble_id, org_id, agent_id, name, instance_id)
      SELECT ${troubleId}, l.org_id, l.agent_id, l.name,
        COALESCE(json_extract(l.models_json, '$.instanceId'), json_extract(l.models_json, '$.provider'))
      FROM kin_leads l WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
      ON CONFLICT (trouble_id, agent_id) DO UPDATE SET worked_at = NULL`;

  const spaceFailed = Effect.fn("KinHostCare.spaceFailed")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      if (!host) return false;
      const first = yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!(yield* agentActive(orgId, agentId))) return false;
            const troubleId = yield* openOrGet(orgId, "space", now);
            yield* stopped(orgId, troubleId, agentId);
            const spent = yield* sql`UPDATE kin_troubles SET auto_clean_at = ${now}
              WHERE org_id = ${orgId} AND trouble_id = ${troubleId} AND auto_clean_at IS NULL
              RETURNING trouble_id`;
            return spent.length > 0;
          }),
        ),
      );
      if (first) yield* clean("out_of_space");
      return first;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin space trouble not recorded", { cause }).pipe(Effect.as(false)),
    ),
  );

  // Nothing can be written while storage is full, so what it saw waits here until it can be.
  const storageSeen = new Set<string>();
  const storageCleaned = new Set<string>();
  const storageFailed = Effect.fn("KinHostCare.storageFailed")(function* (orgId: KinOrgId) {
    storageSeen.add(orgId);
    if (!host || storageCleaned.has(orgId)) return;
    storageCleaned.add(orgId);
    yield* clean("out_of_space");
  });
  const storageRecovered = Effect.fn("KinHostCare.storageRecovered")(
    function* (orgId: KinOrgId) {
      if (!storageSeen.has(orgId)) return;
      const cleaned = storageCleaned.has(orgId);
      const troubleId = yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const troubleId = yield* openOrGet(orgId, "space", now);
            if (cleaned)
              yield* sql`UPDATE kin_troubles SET auto_clean_at = COALESCE(auto_clean_at, ${now})
                WHERE org_id = ${orgId} AND trouble_id = ${troubleId}`;
            return troubleId;
          }),
        ),
      );
      storageSeen.delete(orgId);
      storageCleaned.delete(orgId);
      yield* projectQuietly(orgId, troubleId, true);
      // Room again: the notice says what happened and that it is over.
      const space = yield* readSpace();
      if (Option.isSome(space) && levelOf(space.value) !== "out") yield* close(orgId, troubleId);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin space trouble still can't be written", { cause }),
    ),
  );

  const failed = Effect.fn("KinHostCare.failed")(
    function* (input: TroubleInput) {
      const { orgId } = input;
      const recorded = yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (!(yield* agentActive(orgId, input.agentId))) return undefined;
            const troubleId = yield* openOrGet(orgId, input.cause, now);
            yield* stopped(orgId, troubleId, input.agentId);
            yield* sql`UPDATE kin_troubles SET
                detail = COALESCE(${input.detail?.slice(0, 600) ?? null}, detail),
                reset_at = COALESCE(${input.resetAt ?? null}, reset_at)
              WHERE org_id = ${orgId} AND trouble_id = ${troubleId}`;
            const held = yield* queue.hold(orgId, input.agentId, troubleId, input.eventIds);
            return { troubleId, held };
          }),
        ),
      );
      if (recorded === undefined) return false;
      yield* projectQuietly(orgId, recorded.troubleId, true);
      yield* noteRuns(orgId, recorded.held, KIN_TROUBLE_WHY[input.cause]);
      const trouble = yield* troubleById(orgId, recorded.troubleId);
      return trouble?.toldAt != null;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin trouble not recorded", { cause }).pipe(Effect.as(false)),
    ),
  );

  const release = Effect.fn("KinHostCare.release")(function* (
    orgId: KinOrgId,
    eventIds: ReadonlyArray<KinEventId>,
  ) {
    const requeued = yield* queue.wake(orgId, eventIds);
    yield* noteRuns(orgId, eventIds, undefined);
    return requeued;
  });

  const closeAndRelease = Effect.fn("KinHostCare.closeAndRelease")(function* (
    orgId: KinOrgId,
    troubleId: string,
    now: number,
  ) {
    const [open] = yield* sql`SELECT 1 FROM kin_troubles
      WHERE org_id = ${orgId} AND trouble_id = ${troubleId} AND closed_at IS NULL`;
    if (open === undefined) return false;
    const [manual] = yield* sql`SELECT 1 FROM kin_events e
      WHERE org_id = ${orgId} AND held_by = ${troubleId} AND ${stranded} LIMIT 1`;
    if (manual === undefined)
      yield* sql`UPDATE kin_troubles SET closed_at = ${now}
        WHERE org_id = ${orgId} AND trouble_id = ${troubleId} AND closed_at IS NULL`;
    else
      yield* sql`UPDATE kin_trouble_agents SET worked_at = ${now}
        WHERE org_id = ${orgId} AND trouble_id = ${troubleId} AND worked_at IS NULL`;
    yield* release(orgId, yield* heldIds(orgId, troubleId, true));
    return true;
  });

  const close = Effect.fn("KinHostCare.close")(function* (orgId: KinOrgId, troubleId: string) {
    const now = yield* Clock.currentTimeMillis;
    const closed = yield* troubleLock.withPermits(1)(
      sql.withTransaction(closeAndRelease(orgId, troubleId, now)),
    );
    if (closed) yield* projectQuietly(orgId, troubleId, false);
  });

  const succeeded = Effect.fn("KinHostCare.succeeded")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      for (const { troubleId, cause } of yield* openTroubles(orgId)) {
        if (cause === "backup") continue;
        const updated = yield* troubleLock.withPermits(1)(
          sql.withTransaction(
            Effect.gen(function* () {
              const [affected] = yield* sql`SELECT 1 FROM kin_trouble_agents a JOIN kin_troubles t
                ON t.org_id = a.org_id AND t.trouble_id = a.trouble_id AND t.closed_at IS NULL
                WHERE a.org_id = ${orgId} AND a.trouble_id = ${troubleId} AND a.agent_id = ${agentId}`;
              if (affected === undefined || !(yield* agentActive(orgId, agentId))) return false;
              const now = yield* Clock.currentTimeMillis;
              if (HOST_WIDE.has(cause)) return yield* closeAndRelease(orgId, troubleId, now);

              yield* sql`UPDATE kin_trouble_agents SET worked_at = ${now}
                WHERE org_id = ${orgId} AND trouble_id = ${troubleId} AND agent_id = ${agentId}`;
              const [still] = yield* sql`SELECT 1 FROM kin_trouble_agents a JOIN kin_agents l
                ON l.org_id = a.org_id AND l.agent_id = a.agent_id AND l.retired_at IS NULL
                WHERE a.org_id = ${orgId} AND a.trouble_id = ${troubleId} AND a.worked_at IS NULL
                  AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = a.org_id
                    AND e.held_by = a.trouble_id AND e.agent_id = a.agent_id
                    AND e.state IN ('queued', 'failed'))
                LIMIT 1`;
              if (still === undefined) return yield* closeAndRelease(orgId, troubleId, now);
              yield* release(orgId, yield* heldIds(orgId, troubleId, true, agentId));
              return true;
            }),
          ),
        );
        if (updated) yield* projectQuietly(orgId, troubleId, false);
      }
      // A closed notice counts its held turns as they finish, for a day after it closed.
      const since = (yield* Clock.currentTimeMillis) - 24 * 60 * 60_000;
      const settling = yield* sql<{ troubleId: string }>`SELECT t.trouble_id AS "troubleId"
        FROM kin_troubles t WHERE t.org_id = ${orgId} AND t.closed_at >= ${since}
          AND EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = t.org_id
            AND e.held_by = t.trouble_id AND e.agent_id = ${agentId})
        ORDER BY t.trouble_id`;
      for (const { troubleId } of settling) yield* projectQuietly(orgId, troubleId, false);
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin trouble close failed", { cause })),
  );

  const troubleOpen = (orgId: KinOrgId, cause: KinTroubleCause) =>
    openTroubles(orgId).pipe(
      Effect.map((troubles) => troubles.some((one) => one.cause === cause)),
      Effect.orElseSucceed(() => false),
    );

  const causeFor = Effect.fn("KinHostCare.causeFor")(
    function* (orgId: KinOrgId, agentId: KinAgentId) {
      if (!(yield* agentActive(orgId, agentId))) return;
      for (const trouble of yield* openTroubles(orgId)) {
        if (trouble.cause === "backup") continue;
        const found = { cause: trouble.cause, told: trouble.toldAt !== null };
        if (HOST_WIDE.has(trouble.cause)) {
          const [recovered] = yield* sql`SELECT 1 FROM kin_trouble_agents a
            WHERE a.org_id = ${orgId} AND a.trouble_id = ${trouble.troubleId} AND a.worked_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM kin_trouble_agents b WHERE b.org_id = a.org_id
                AND b.trouble_id = a.trouble_id AND b.worked_at IS NULL)
            LIMIT 1`;
          if (recovered === undefined) return found;
          continue;
        }
        const [affected] = yield* sql`SELECT 1 FROM kin_trouble_agents
          WHERE org_id = ${orgId} AND trouble_id = ${trouble.troubleId} AND agent_id = ${agentId}
            AND worked_at IS NULL`;
        if (affected !== undefined) return found;
      }
      return undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const refresh = Effect.fn("KinHostCare.refresh")(
    function* (orgId: KinOrgId, options?: { readonly closedOnly: true }) {
      const redraw = yield* sql<{ troubleId: string }>`SELECT t.trouble_id AS "troubleId"
        FROM kin_troubles t LEFT JOIN kin_widgets w
          ON w.org_id = t.org_id AND w.widget_id = t.trouble_id
        WHERE t.org_id = ${orgId} AND ((${options?.closedOnly ? 0 : 1} AND t.closed_at IS NULL)
          OR (t.closed_at IS NOT NULL AND w.widget_id IS NOT NULL AND w.closed_at IS NULL)
          OR (w.widget_id IS NULL AND EXISTS (SELECT 1 FROM kin_messages m
            WHERE m.org_id = t.org_id AND m.message_id = t.trouble_id AND m.widget_id IS NULL
              AND m.kind = 'system' AND m.author_kind = 'system' AND m.status = 'posted')))
        ORDER BY t.trouble_id`;
      for (const { troubleId } of redraw) yield* projectQuietly(orgId, troubleId, false);
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin trouble redraw failed", { cause })),
  );

  const backupConfigured = fs.exists(backupEnv).pipe(Effect.orElseSucceed(() => false));
  const checkBackup = Effect.fn("KinHostCare.checkBackup")(
    function* (orgId: KinOrgId, problem: { readonly lastGoodAt: number | null } | undefined) {
      const open = (yield* openTroubles(orgId)).find((one) => one.cause === "backup");
      if (problem === undefined) {
        if (open !== undefined) yield* close(orgId, open.troubleId);
        return;
      }
      const configured = (yield* backupConfigured) ? 1 : 0;
      const lastGoodAt = problem.lastGoodAt === null ? null : iso(problem.lastGoodAt);
      if (open !== undefined) {
        if (open.backupConfigured === configured && open.lastGoodAt === lastGoodAt) return;
        yield* sql`UPDATE kin_troubles SET backup_configured = ${configured},
            last_good_at = ${lastGoodAt}
          WHERE org_id = ${orgId} AND trouble_id = ${open.troubleId}`;
        yield* projectQuietly(orgId, open.troubleId, open.toldAt === null);
        return;
      }
      // Opened outside the owner's quiet hours: the next hourly check tries again.
      const lead = yield* noticeOwner(orgId);
      if (lead === undefined || (yield* noticeHeld(orgId, lead.ownerPersonId)) !== undefined)
        return;
      const troubleId = yield* troubleLock.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const troubleId = yield* openOrGet(orgId, "backup", yield* Clock.currentTimeMillis);
            yield* sql`UPDATE kin_troubles SET backup_configured = ${configured},
                last_good_at = ${lastGoodAt}
              WHERE org_id = ${orgId} AND trouble_id = ${troubleId}`;
            return troubleId;
          }),
        ),
      );
      yield* projectQuietly(orgId, troubleId, true);
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
      yield* measure();
      const space = yield* readSpace();
      const [counts] = yield* sql<{ running: number; held: number }>`SELECT
          (SELECT COUNT(*) FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running') AS running,
          (SELECT COUNT(*) FROM kin_events WHERE org_id = ${orgId} AND state = 'queued'
            AND attempts > 0) AS held`;
      const troubles = yield* Effect.forEach(yield* openTroubles(orgId), (trouble) =>
        cardOf(orgId, trouble).pipe(
          Effect.map((card) => ({ widgetId: KinWidgetId.make(trouble.troubleId), card })),
        ),
      );
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
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          let requeued = 0;
          for (const trouble of yield* openTroubles(orgId))
            if (trouble.cause !== "backup")
              requeued += yield* release(orgId, yield* heldIds(orgId, trouble.troubleId, false));
          return { requeued };
        }),
      );
    },
    Effect.mapError(() => unavailable),
  );

  const freeSpace = Effect.fn("KinHostCare.freeSpace")(
    function* (orgId: KinOrgId) {
      const result = yield* clean("asked");
      // Real room again is the proof: the space trouble closes and its held turns run now.
      const space = yield* readSpace();
      if (Option.isSome(space) && levelOf(space.value) !== "out") {
        const open = (yield* openTroubles(orgId)).find((one) => one.cause === "space");
        if (open !== undefined) yield* close(orgId, open.troubleId);
      }
      return result;
    },
    Effect.mapError(() => unavailable),
  );

  /** After a backup ends: every company's backup notice follows what it recorded. */
  const recheckBackup = Effect.gen(function* () {
    const file = yield* fs
      .readFileString(path.join(config.stateDir, HostBackup.BACKUP_STATUS_FILE))
      .pipe(Effect.option, Effect.map(Option.getOrUndefined));
    const problem = HostBackup.backupProblem(file, yield* Clock.currentTimeMillis);
    const orgs = yield* sql<{ orgId: KinOrgId }>`SELECT org_id AS "orgId" FROM kin_orgs
      ORDER BY org_id`;
    for (const { orgId } of orgs) yield* checkBackup(orgId, problem);
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Kin backup recheck failed", { cause })));

  const backUpNow = Effect.fn("KinHostCare.backUpNow")(
    function* (_orgId: KinOrgId) {
      if (!host || !(yield* backupConfigured))
        return { started: false, reason: "not_set_up" } satisfies KinHostBackUpResult;
      if (devCheckout !== undefined) {
        // Dev stand-in for backup.sh's own record of a good run, so the notice's way out shows.
        const now = yield* Clock.currentTimeMillis;
        yield* fs.writeFileString(
          path.join(config.stateDir, HostBackup.BACKUP_STATUS_FILE),
          `${encodeDevRecord({ ranAt: now, ok: true, lastGoodAt: now, error: "" })}\n`,
        );
        yield* recheckBackup;
        return { started: true } satisfies KinHostBackUpResult;
      }
      const unit = yield* runner
        .run({
          command: "systemctl",
          args: ["--user", "cat", "kin-backup.service"],
          timeout: "30 seconds",
          maxOutputBytes: 1024,
          outputMode: "truncate",
        })
        .pipe(Effect.option);
      if (Option.isNone(unit))
        return { started: false, reason: "failed" } satisfies KinHostBackUpResult;
      if (unit.value.code !== 0)
        return { started: false, reason: "unit_missing" } satisfies KinHostBackUpResult;
      // The same unit the nightly timer starts; systemd runs one at a time. Waited for in the
      // background, so the backup notice follows its result as soon as it ends.
      yield* runner
        .run({
          command: "systemctl",
          args: ["--user", "start", "--wait", "kin-backup.service"],
          timeout: "2 hours",
          maxOutputBytes: 4096,
          outputMode: "truncate",
        })
        .pipe(
          Effect.andThen(recheckBackup),
          Effect.catchCause((cause) => Effect.logWarning("Kin backup run failed", { cause })),
          Effect.forkDetach,
        );
      return { started: true } satisfies KinHostBackUpResult;
    },
    Effect.mapError(() => unavailable),
  );

  yield* measure("now");

  return KinHostCare.of({
    host,
    clean,
    spaceFailed,
    storageFailed,
    storageRecovered,
    devFullDisk,
    failed,
    succeeded,
    troubleOpen,
    causeFor,
    refresh,
    checkBackup,
    postOfflineNotice,
    status,
    freeSpace,
    backUpNow,
    retry,
  });
});

export const layerWithoutRunner = Layer.effect(KinHostCare, make);
export const layer = layerWithoutRunner.pipe(Layer.provide(ProcessRunner.layer));
