import {
  KinOrgId,
  KinTriggerId,
  ModelSelection,
  type KinRoutine,
  type KinTriggerFireId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import * as KinBudget from "../lead/KinBudget.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as SecretScan from "../memory/secretScan.ts";
import * as KinTriggerInbox from "../triggers/KinTriggerInbox.ts";
import * as KinTriggerStore from "../triggers/KinTriggerStore.ts";
import { checkDream, DreamJson } from "./checkDream.ts";
import * as DreamSession from "./DreamSession.ts";
import { collectMaterial, type DreamMaterial } from "./material.ts";

export class DreamRunnerError extends Schema.TaggedError<DreamRunnerError>()("DreamRunnerError", {
  orgId: KinOrgId,
  cause: Schema.Defect(),
}) {}

export type DreamOutcome =
  | {
      readonly _tag: "succeeded";
      readonly dreamId: string;
      readonly branch: string;
      readonly head: string;
      readonly dream: DreamJson;
    }
  | {
      readonly _tag: "failed";
      readonly dreamId: string;
      readonly branch: string;
      readonly failures: ReadonlyArray<string>;
    }
  | { readonly _tag: "cancelled"; readonly dreamId: string; readonly branch: string }
  | { readonly _tag: "busy" };

export class DreamRunner extends Context.Service<
  DreamRunner,
  {
    /** Keyed by `(orgId, ownerDate)`; a rerun replaces that night's branch. */
    readonly run: (
      orgId: KinOrgId,
      options: { readonly full: boolean; readonly ownerDate?: string },
    ) => Effect.Effect<DreamOutcome, DreamRunnerError>;
    readonly cancel: (orgId: KinOrgId) => Effect.Effect<boolean>;
    /** Consumes pending `dream` and `dream_full` fires; the scheduler tick calls this. */
    readonly drain: (orgId: KinOrgId) => Effect.Effect<void, DreamRunnerError>;
  }
>()("t3/kin/dreaming/DreamRunner") {}

const dreamRoutines: ReadonlyArray<KinRoutine> = ["dream", "dream_full"];
const scratch = ".kin-dream";
const Models = Schema.fromJsonString(
  Schema.Struct({ strong: ModelSelection, cheap: ModelSelection }),
);
const decodeModels = Schema.decodeUnknownEffect(Models);
const decodeDream = Schema.decodeUnknownEffect(Schema.fromJsonString(DreamJson));
const encodeDream = Schema.encodeEffect(Schema.fromJsonString(DreamJson));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const zoned = (ms: number, timeZone: string) => DateTime.makeZonedUnsafe(ms, { timeZone });

const extractPrompt = (input: { orgId: string; head: string; full: boolean }) =>
  `You are Kin's nightly dream for organization ${input.orgId}. Your working directory is a scratch copy of the memory repository at main ${input.head}.

Read ${scratch}/material.json. It lists every original since the last good dream${input.full ? ", plus every current item" : ""}. Cite entries by their "ref".

1. Extract durable facts into item files under objectives/, commitments/, deferrals/, decisions/, people/ or claims/, and fold journal/ entries. Merge duplicates and mark replaced items with invalid_at and superseded_by.
2. Edit only item files and journal/. Never delete a file. Never edit rules.md or INDEX.md. Do not run git.
3. A new item, or one whose source changes, takes source = the material ref, and said_by and trust = that entry's saidBy and trust.
4. Write ${scratch}/dream.json:
{"changes":[{"path":"...","sources":["ref"]}],"merges":[{"into":"id","from":["id"],"sources":["ref"]}],"supersessions":[{"id":"...","invalid_at":"...","superseded_by":"id","sources":["ref"]}],"contradictions":[{"items":["id"],"summary":"...","sources":["ref"]}]}
List every file you changed in "changes". Use empty arrays when there is nothing to report.`;

const resolvePrompt = `Read .kin-dream/dream.json and .kin-dream/material.json. For each entry in "contradictions", add either "resolution" (what memory should say, citing the material) or "question" (one question for the owner). Change nothing else in dream.json and edit no other file.`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const memory = yield* Memory.Memory;
  const notices = yield* Memory.MemoryRecoveryHooks;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const scanner = yield* SecretScan.KinSecretScan;
  const cache = yield* MemoryCache.MemoryCache;
  const session = yield* DreamSession.DreamSession;
  const budget = yield* KinBudget.KinBudget;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const store = yield* KinTriggerStore.KinTriggerStore;
  const ticks = yield* Scheduler.Scheduler;
  const vcs = yield* VcsProcess;
  /** One dream per org, reserved before its claim. `decided` marks whether the dream or `cancel` won. */
  const live = new Map<
    KinOrgId,
    { dreamId: string; signal: Deferred.Deferred<void>; decided: boolean }
  >();
  const fail = (orgId: KinOrgId) =>
    Effect.mapError(
      (cause: unknown) =>
        new DreamRunnerError({
          orgId,
          cause: isSqlError(cause) ? toPersistenceSqlError("DreamRunner")(cause) : cause,
        }),
    );

  const settings = Effect.fn("DreamRunner.settings")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{
      fullRebuildWeekday: number;
      dream: string;
    }>`SELECT full_rebuild_weekday AS "fullRebuildWeekday", dream FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
    return {
      timeZone: yield* cache.ownerTimeZone(orgId),
      fullRebuildWeekday: row?.fullRebuildWeekday ?? 0,
      dream: row?.dream ?? "03:00",
    };
  });

  const newDreamId = Effect.fn("DreamRunner.newDreamId")(function* (ownerDate: string) {
    let suffix = "";
    for (let i = 0; i < 12; i++)
      suffix += "0123456789abcdefghjkmnpqrstvwxyz".charAt(yield* Random.nextIntBetween(0, 31));
    return `dream_${ownerDate.replaceAll("-", "")}_${suffix}`;
  });

  const claim = Effect.fn("DreamRunner.claim")(function* (
    orgId: KinOrgId,
    dreamId: string,
    ownerDate: string,
    full: boolean,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const branch = `dream/${ownerDate}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [lead] = yield* sql<{
          models: string;
        }>`SELECT l.models_json AS models FROM kin_leads l
          JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
        if (lead === undefined) return yield* Effect.fail("No active lead for this organization");
        const [previous] = yield* sql<{
          until: number;
        }>`SELECT material_until AS until FROM kin_dream_runs
          WHERE org_id = ${orgId} AND status = 'succeeded' AND owner_date < ${ownerDate}
          ORDER BY material_until DESC LIMIT 1`;
        const from = previous?.until ?? 0;
        const inserted = yield* sql`INSERT INTO kin_dream_runs
          (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at)
          VALUES (${orgId}, ${ownerDate}, ${dreamId}, ${full ? 1 : 0}, 'running', ${branch}, ${from}, ${now}, ${now})
          ON CONFLICT DO NOTHING RETURNING dream_id`;
        const replaced =
          inserted.length > 0
            ? inserted
            : yield* sql`UPDATE kin_dream_runs SET dream_id = ${dreamId}, full = ${full ? 1 : 0},
                status = 'running', branch = ${branch}, base_head = NULL, head = NULL,
                material_from = ${from}, material_until = ${now}, thread_id = NULL, dream_json = NULL,
                failure = NULL, started_at = ${now}, ended_at = NULL
              WHERE org_id = ${orgId} AND owner_date = ${ownerDate} AND status <> 'running'
              RETURNING dream_id`;
        if (replaced.length === 0) return undefined;
        return { dreamId, branch, from, until: now, models: yield* decodeModels(lead.models) };
      }),
    );
  });

  const settle = Effect.fn("DreamRunner.settle")(function* (
    orgId: KinOrgId,
    dreamId: string,
    branch: string,
    outcome: DreamOutcome,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (outcome._tag === "succeeded") {
      yield* sql`UPDATE kin_dream_runs SET status = 'succeeded', head = ${outcome.head},
        dream_json = ${yield* encodeDream(outcome.dream)}, ended_at = ${now}
        WHERE org_id = ${orgId} AND dream_id = ${dreamId} AND status = 'running' RETURNING dream_id`;
      return;
    }
    const failure =
      outcome._tag === "failed" ? outcome.failures.join("\n").slice(0, 4000) : "Cancelled";
    if (Option.isSome(writer))
      yield* writer.value
        .deleteDreamBranch(orgId, branch)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Kin dream branch cleanup failed", { orgId, branch, cause }),
          ),
        );
    yield* sql`UPDATE kin_dream_runs SET status = ${outcome._tag === "failed" ? "failed" : "cancelled"},
      failure = ${failure}, ended_at = ${now}
      WHERE org_id = ${orgId} AND dream_id = ${dreamId} AND status = 'running' RETURNING dream_id`;
    if (outcome._tag !== "failed") return;
    const leaked = yield* scanner
      .scan({
        orgId,
        files: [{ path: "dream-failure", content: new TextEncoder().encode(failure) }],
      })
      .pipe(
        Effect.orElseSucceed(() => [{ path: "dream-failure", ruleId: "unavailable", line: 0 }]),
      );
    yield* notices.notify({
      orgId,
      branch,
      reason: `Last night's dream failed and merged nothing; the next dream retries the same material.\n${
        leaked.length > 0 ? "Details withheld: they did not pass the secret scan." : failure
      }`,
    });
  });

  const prepareCheckout = Effect.fn("DreamRunner.prepareCheckout")(function* (
    orgId: KinOrgId,
    dreamId: string,
    files: ReadonlyMap<string, Buffer>,
    material: DreamMaterial,
  ) {
    const paths = yield* memory.ensureCheckouts(orgId);
    const dreams = path.join(path.dirname(paths.writer), "dreams");
    const root = path.join(dreams, dreamId);
    // Only this org's live dream uses `dreams/`; anything else was left by a crash.
    if (yield* fs.exists(dreams))
      for (const entry of yield* fs.readDirectory(dreams))
        yield* fs.remove(path.join(dreams, entry), { recursive: true, force: true });
    yield* fs.makeDirectory(path.join(root, scratch), { recursive: true });
    for (const [relative, bytes] of files) {
      const target = path.join(root, relative);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFile(target, bytes);
    }
    // Scratch sits inside other repos (in dev, the t3code worktree); stray `git` hits this one.
    yield* vcs.run({
      operation: "DreamRunner.scratchRepo",
      command: "git",
      cwd: root,
      args: ["init", "--quiet", "--", root],
      env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "" },
    });
    yield* fs.writeFileString(
      path.join(root, scratch, "material.json"),
      yield* encodeJson(material),
    );
    return root;
  });

  const readCheckout = Effect.fn("DreamRunner.readCheckout")(function* (root: string) {
    const tree = new Map<string, string>();
    const special: Array<string> = [];
    for (const relative of (yield* fs.readDirectory(root, { recursive: true })).toSorted()) {
      const normalized = relative.split(path.sep).join("/");
      if ([scratch, ".git"].some((dir) => normalized === dir || normalized.startsWith(`${dir}/`)))
        continue;
      const info = yield* fs.lstat(path.join(root, relative));
      if (info.type === "Directory") continue;
      if (info.type !== "File" || (Option.isSome(info.nlink) && info.nlink.value > 1)) {
        special.push(normalized);
        continue;
      }
      tree.set(normalized, yield* fs.readFileString(path.join(root, relative)));
    }
    const dreamPath = path.join(root, scratch, "dream.json");
    const dreamInfo = yield* fs.lstat(dreamPath).pipe(Effect.option);
    const dreamJson =
      Option.isSome(dreamInfo) && dreamInfo.value.type === "File"
        ? yield* fs.readFileString(dreamPath)
        : undefined;
    return { tree, special, dreamJson };
  });

  const dream = Effect.fn("DreamRunner.dream")(function* (
    orgId: KinOrgId,
    claimed: NonNullable<Effect.Success<ReturnType<typeof claim>>>,
    ownerDate: string,
    full: boolean,
    timeZone: string,
  ) {
    const { dreamId, branch } = claimed;
    const failed = (failures: ReadonlyArray<string>): DreamOutcome => ({
      _tag: "failed",
      dreamId,
      branch,
      failures,
    });
    if (Option.isNone(writer)) return failed(["The memory writer is not available"]);
    const base = yield* writer.value.dreamBase(orgId);
    yield* sql`UPDATE kin_dream_runs SET base_head = ${base.head}
      WHERE org_id = ${orgId} AND dream_id = ${dreamId} AND status = 'running' RETURNING dream_id`;
    const baseText = new Map(
      [...base.files].map(([file, bytes]) => [file, bytes.toString("utf8")]),
    );
    const material = yield* collectMaterial({
      orgId,
      from: claimed.from,
      until: claimed.until,
      full,
      timeZone,
      files: baseText,
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const root = yield* prepareCheckout(orgId, dreamId, base.files, material);
    return yield* Effect.gen(function* () {
      const turn = Effect.fn("DreamRunner.turn")(function* (
        name: "extract" | "resolve",
        model: ModelSelection,
        text: string,
      ) {
        const result = yield* session.run({
          orgId,
          dreamId,
          turn: name,
          workspaceRoot: root,
          model,
          text,
        });
        yield* sql`UPDATE kin_dream_runs SET thread_id = ${result.threadId}
          WHERE org_id = ${orgId} AND dream_id = ${dreamId} AND status = 'running' RETURNING dream_id`;
        return result.status;
      });
      const extracted = yield* turn(
        "extract",
        claimed.models.cheap,
        extractPrompt({ orgId, head: base.head, full }),
      );
      if (extracted !== "completed") return failed([`The dream session ${extracted}`]);
      let checkout = yield* readCheckout(root);
      const draft =
        checkout.dreamJson === undefined
          ? undefined
          : yield* decodeDream(checkout.dreamJson).pipe(Effect.option);
      if (
        draft?._tag === "Some" &&
        draft.value.contradictions.some((entry) => !entry.resolution && !entry.question)
      ) {
        const resolved = yield* turn("resolve", claimed.models.strong, resolvePrompt);
        if (resolved !== "completed") return failed([`The contradiction session ${resolved}`]);
        checkout = yield* readCheckout(root);
      }
      const checked = yield* checkDream({
        orgId,
        base: baseText,
        tree: checkout.tree,
        special: checkout.special,
        dreamJson: checkout.dreamJson,
        material: material.entries,
        requireResolutions: true,
      });
      const findings = yield* scanner.scan({
        orgId,
        files: [
          ...[...checked.changes].map(([file, text]) => ({
            path: file,
            content: new TextEncoder().encode(text),
          })),
          ...(checkout.dreamJson === undefined
            ? []
            : [
                {
                  path: `${scratch}/dream.json`,
                  content: new TextEncoder().encode(checkout.dreamJson),
                },
              ]),
        ],
      });
      const failures = [
        ...checked.failures,
        ...(findings.length > 0 ? [`The secret scan found ${findings.length} findings`] : []),
      ];
      if (failures.length > 0 || checked.dream === undefined) return failed(failures);
      const { commit } = yield* writer.value.commitDream(orgId, {
        branch,
        base: base.head,
        files: checked.changes,
        message: `kin(dream): ${ownerDate}\n\nKin-Dream: ${dreamId}\nMaterial-Until: ${iso(claimed.until)}\n`,
      });
      return {
        _tag: "succeeded",
        dreamId,
        branch,
        head: commit,
        dream: checked.dream,
      } satisfies DreamOutcome;
    }).pipe(Effect.ensuring(fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore)));
  });

  const attempt = Effect.fn("DreamRunner.attempt")(function* (
    orgId: KinOrgId,
    claimed: NonNullable<Effect.Success<ReturnType<typeof claim>>>,
    slot: { readonly signal: Deferred.Deferred<void>; decided: boolean },
    ownerDate: string,
    full: boolean,
    timeZone: string,
  ) {
    const { dreamId, branch } = claimed;
    const cancelled: DreamOutcome = { _tag: "cancelled", dreamId, branch };
    const outcome = yield* Effect.raceFirst(
      dream(orgId, claimed, ownerDate, full, timeZone).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => {
            const error = Cause.squash(cause);
            return Effect.logWarning("Kin dream failed", { orgId, dreamId, cause }).pipe(
              Effect.as<DreamOutcome>({
                _tag: "failed",
                dreamId,
                branch,
                failures: [
                  error instanceof Error ? `${error.name}: ${error.message}` : "The dream failed",
                ],
              }),
            );
          },
        ),
        Effect.flatMap((outcome) => {
          if (slot.decided) return Effect.never;
          slot.decided = true;
          return Effect.succeed(outcome);
        }),
      ),
      Deferred.await(slot.signal).pipe(Effect.as(cancelled)),
    ).pipe(
      Effect.onInterrupt(() =>
        settle(orgId, dreamId, branch, cancelled).pipe(Effect.ignore, Effect.uninterruptible),
      ),
    );
    yield* settle(orgId, dreamId, branch, outcome).pipe(Effect.uninterruptible);
    return outcome;
  });

  const run = Effect.fn("DreamRunner.run")(
    function* (orgId: KinOrgId, options: { readonly full: boolean; readonly ownerDate?: string }) {
      const { timeZone } = yield* settings(orgId);
      const ownerDate =
        options.ownerDate ??
        DateTime.formatIsoDate(zoned(yield* Clock.currentTimeMillis, timeZone));
      const dreamId = yield* newDreamId(ownerDate);
      if (live.has(orgId)) return { _tag: "busy" } satisfies DreamOutcome;
      const slot = { dreamId, signal: Deferred.makeUnsafe<void>(), decided: false };
      live.set(orgId, slot);
      return yield* Effect.gen(function* () {
        const claimed = yield* claim(orgId, dreamId, ownerDate, options.full);
        if (claimed === undefined) return { _tag: "busy" } satisfies DreamOutcome;
        return yield* attempt(orgId, claimed, slot, ownerDate, options.full, timeZone);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (live.get(orgId) === slot) live.delete(orgId);
          }),
        ),
      );
    },
    (effect, orgId) => effect.pipe(fail(orgId)),
  );

  const recoverStale = Effect.fn("DreamRunner.recoverStale")(function* (orgId: KinOrgId) {
    const rows = yield* sql<{
      dreamId: string;
      branch: string;
    }>`SELECT dream_id AS "dreamId", branch FROM kin_dream_runs
      WHERE org_id = ${orgId} AND status = 'running' ORDER BY started_at, dream_id`;
    for (const row of rows) {
      if (live.get(orgId)?.dreamId === row.dreamId) continue;
      yield* settle(orgId, row.dreamId, row.branch, {
        _tag: "failed",
        dreamId: row.dreamId,
        branch: row.branch,
        failures: ["The server restarted during the dream"],
      });
    }
  });

  const ensureTriggers = Effect.fn("DreamRunner.ensureTriggers")(function* (orgId: KinOrgId) {
    const config = yield* settings(orgId);
    const now = yield* Clock.currentTimeMillis;
    const active =
      yield* sql`SELECT 1 FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
    const enabled = active.length > 0 && Option.isSome(writer);
    for (const routine of dreamRoutines) {
      const id = KinTriggerId.make(`routine:${routine}`);
      const existing = yield* store.get(orgId, id);
      if (existing !== undefined && existing.enabled === enabled) continue;
      const schedule =
        routine === "dream"
          ? { type: "fixed_time" as const, timeOfDay: config.dream }
          : {
              type: "fixed_time" as const,
              timeOfDay: config.dream,
              weekdays: [config.fullRebuildWeekday],
            };
      const next = enabled ? nextScheduledRunAt(schedule, zoned(now, config.timeZone)) : null;
      yield* store.put({
        id,
        orgId,
        subject: { type: "routine", routine },
        schedule,
        timeZone: config.timeZone,
        enabled,
        nextRunAt: next === null ? null : DateTime.formatIso(next),
        createdAt: existing?.createdAt ?? iso(now),
        updatedAt: iso(Math.max(now, Date.parse(existing?.updatedAt ?? iso(now)))),
      });
    }
  });

  const drain = Effect.fn("DreamRunner.drain")(
    function* (orgId: KinOrgId) {
      yield* recoverStale(orgId);
      const config = yield* settings(orgId);
      const pending = yield* inbox.listPending(orgId, 100, dreamRoutines);
      for (const fire of pending.toSorted(
        (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || (a.fireId < b.fireId ? -1 : 1),
      )) {
        if (fire.payload.kind !== "time" || fire.payload.subject.type !== "routine") continue;
        const routine = fire.payload.subject.routine;
        if (routine !== "dream" && routine !== "dream_full") continue;
        const consume = (fireId: KinTriggerFireId) => inbox.markConsumed(orgId, [fireId]);
        const due = zoned(Date.parse(fire.dueAt), config.timeZone);
        const parts = DateTime.toParts(due);
        if (routine === "dream" && parts.weekDay === config.fullRebuildWeekday) {
          yield* consume(fire.fireId);
          continue;
        }
        let cutoff = DateTime.setParts(due, { hour: 8, minute: 0, second: 0, millisecond: 0 });
        if (DateTime.toEpochMillis(cutoff) <= DateTime.toEpochMillis(due))
          cutoff = DateTime.add(cutoff, { days: 1 });
        if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(cutoff)) {
          yield* Effect.logInfo("Kin dream skipped: past 08:00 owner time", {
            orgId,
            fireId: fire.fireId,
          });
          yield* consume(fire.fireId);
          continue;
        }
        const paused =
          yield* sql`SELECT 1 FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1 ORDER BY org_id`;
        if (paused.length > 0) continue;
        if (!(yield* budget.admit(orgId, "P4")).allowed) continue;
        const outcome = yield* run(orgId, {
          full: routine === "dream_full",
          ownerDate: DateTime.formatIsoDate(due),
        });
        if (outcome._tag === "busy") continue;
        yield* consume(fire.fireId);
      }
    },
    (effect, orgId) => effect.pipe(fail(orgId)),
  );

  if (Option.isSome(writer))
    yield* ticks.register(
      "kin-dreams",
      Effect.gen(function* () {
        // Scheduler maintenance scans organizations; all work below stays org-scoped.
        const orgs = yield* sql<{
          orgId: string;
        }>`SELECT DISTINCT org_id AS "orgId" FROM kin_leads ORDER BY org_id`;
        for (const row of orgs) {
          const orgId = KinOrgId.make(row.orgId);
          yield* Effect.gen(function* () {
            yield* ensureTriggers(orgId).pipe(fail(orgId));
            yield* drain(orgId);
          }).pipe(
            Effect.catch((cause) => Effect.logWarning("Kin dream tick failed", { orgId, cause })),
          );
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin dream scan failed", { cause }))),
    );

  return DreamRunner.of({
    run,
    cancel: Effect.fn("DreamRunner.cancel")(function* (orgId) {
      const slot = live.get(orgId);
      if (slot === undefined || slot.decided) return false;
      slot.decided = true;
      return yield* Deferred.succeed(slot.signal, undefined);
    }),
    drain,
  });
});

export const layer = Layer.effect(DreamRunner, make);
