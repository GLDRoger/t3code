import { KinMessageId, KinOrgId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Chat from "./chat/KinChatService.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./lead/orgLeads.ts";
import { DAY_MS, HOUR_MS, WEEK_MS } from "./durations.ts";

/** Written by ops/kin/host/backup.sh into the server's state directory after every run. */
export const BACKUP_STATUS_FILE = "kin-backup-status.json";

const STALE_AFTER = 36 * HOUR_MS;
const CHECK_EVERY = HOUR_MS;

const BackupStatus = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    lastGoodAt: Schema.NullOr(Schema.Number),
    error: Schema.String,
  }),
);
const decodeStatus = Schema.decodeUnknownOption(BackupStatus);

const ago = (ms: number) =>
  ms < 2 * DAY_MS ? `${Math.floor(ms / HOUR_MS)} hours ago` : `${Math.floor(ms / DAY_MS)} days ago`;

const statusOf = (statusFile: string | undefined) =>
  statusFile === undefined ? Option.none() : decodeStatus(statusFile);
const neverGood = (status: ReturnType<typeof statusOf>) =>
  Option.isNone(status) || status.value.lastGoodAt === null;

/** What the owner is told about this server's backups, or nothing while the last good one is recent. */
export const backupProblem = (statusFile: string | undefined, now: number) => {
  const status = statusOf(statusFile);
  if (Option.isNone(status) || status.value.lastGoodAt === null) {
    const failed = Option.isSome(status) && status.value.error !== "";
    return `This server has no good backup on record${failed ? `: the last try failed: ${status.value.error}` : "."} Set up or fix the nightly backup (ops/kin/host/README.md, Backups) so a failed disk can't lose the company's data.`;
  }
  const { lastGoodAt, ok, error } = status.value;
  if (now - lastGoodAt <= STALE_AFTER) return undefined;
  return `This server's last good backup was ${ago(now - lastGoodAt)}. ${
    !ok && error !== "" ? `The last try failed: ${error}` : "The nightly backup hasn't run since."
  }`;
};

/** Posts `body` to the owner level of a company's lead chat; a `messageId` already posted is a no-op. */
const tellOwners = Effect.fn("KinHostBackup.tellOwners")(function* (
  org: KinOrgId,
  messageId: string,
  body: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
  const lead = yield* liveLead(sql, org, { prefer: CHIEF_OF_STAFF_DOMAIN }).pipe(
    NodeSqliteClient.readOnly,
  );
  if (lead === undefined) return;
  yield* chat.notice({
    orgId: org,
    chatId: lead.ownerChatId,
    messageId: KinMessageId.make(messageId),
    audience: "owner",
    body,
  });
});

export const OUT_OF_SPACE =
  "Kin's computer has run out of temporary space, so agents can't run until some is freed. Kin clears out old temporary files every hour, so this usually sorts itself out within the hour. If agents are still stuck after that, ask whoever looks after Kin's computer to free up space: the Storage section of Kin's setup guide says how.";

// ENOSPC and EDQUOT as Node reports them on Linux; an errno Node has no name for keeps only the number.
const SPACE_ERRNOS: ReadonlySet<unknown> = new Set([-28, -122]);
const SPACE_CODES: ReadonlySet<unknown> = new Set(["ENOSPC", "EDQUOT"]);

/** True when a full disk or quota is anywhere in a failure's cause chain. */
const outOfSpace = (failure: unknown): boolean => {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (Cause.isCause(value))
      return value.reasons.some((reason) =>
        Cause.isFailReason(reason)
          ? visit(reason.error)
          : Cause.isDieReason(reason) && visit(reason.defect),
      );
    if ("errno" in value && SPACE_ERRNOS.has(value.errno)) return true;
    if ("code" in value && SPACE_CODES.has(value.code)) return true;
    return (
      ("cause" in value && visit(value.cause)) ||
      ("reason" in value && visit(value.reason)) ||
      ("error" in value && visit(value.error))
    );
  };
  return visit(failure);
};

/**
 * Tells a company's owners, at most once a UTC day, that a wake-up failed because this host's
 * disk or quota is full. Only on a Kin host, which clears its temporary files hourly.
 */
export const tellIfOutOfSpace = Effect.fn("KinHostBackup.tellIfOutOfSpace")(function* (
  org: KinOrgId,
  failure: unknown,
) {
  if (!outOfSpace(failure)) return;
  if (Option.isNone(yield* Config.option(Config.String("KIN_CHECKOUT")))) return;
  const day = Math.floor((yield* Clock.currentTimeMillis) / DAY_MS);
  yield* tellOwners(org, `kin-host:space:${org}:${day}`, OUT_OF_SPACE);
});

export const LOW_ON_SPACE =
  "Kin's computer is running low on space, and agents will stop working if it runs out. Kin clears out old temporary files every hour, which may be enough. If this message comes back tomorrow, ask whoever looks after Kin's computer to free up space: the Storage section of Kin's setup guide says how.";

const LOW_SPACE_PERCENT = 20;

export interface SpaceReading {
  readonly folder: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** One statfs; none when the folder can't be read. */
class SpaceReadError extends Schema.TaggedError<SpaceReadError>()("KinHostSpaceReadError", {
  folder: Schema.String,
  cause: Schema.Defect(),
}) {}

const readSpace = (folder: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.statfs(folder),
    catch: (cause) => new SpaceReadError({ folder, cause }),
  }).pipe(
    Effect.map((stats): SpaceReading => ({
      folder,
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
    })),
    Effect.option,
  );

/** Kin's temp folder, the system one agents also write to (skipped where it doesn't exist), and the T3 home. */
export const spaceFolders = (baseDir: string) => [...new Set([NodeOS.tmpdir(), "/tmp", baseDir])];

/**
 * Warns in the log, and tells a company's owners at most once a UTC day, when a folder's disk has
 * less than 20% left. A folder it can't read is skipped. The notice is only on a Kin host.
 */
export const warnIfLowOnSpace = Effect.fn("KinHostBackup.warnIfLowOnSpace")(function* (
  org: KinOrgId,
  folders: ReadonlyArray<string>,
  read: (folder: string) => Effect.Effect<Option.Option<SpaceReading>> = readSpace,
) {
  const readings = yield* Effect.forEach(folders, read);
  const low = readings
    .flatMap((reading) => Option.toArray(reading))
    .filter(
      (reading) =>
        reading.totalBytes > 0 && reading.freeBytes * 100 < reading.totalBytes * LOW_SPACE_PERCENT,
    );
  if (low.length === 0) return;
  yield* Effect.logWarning("Kin host is low on space", {
    orgId: org,
    low: low.map((reading) => ({
      ...reading,
      percentLeft: Math.floor((reading.freeBytes * 100) / reading.totalBytes),
    })),
  });
  if (Option.isNone(yield* Config.option(Config.String("KIN_CHECKOUT")))) return;
  const day = Math.floor((yield* Clock.currentTimeMillis) / DAY_MS);
  yield* tellOwners(org, `kin-host:low-space:${org}:${day}`, LOW_ON_SPACE);
});

/**
 * Tells each company's owner when this host's backup is old or failing, at most once a UTC day,
 * and when none ever worked, at most once a week.
 */
export const check = Effect.fn("KinHostBackup.check")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig;
  const now = yield* Clock.currentTimeMillis;
  const file = yield* fs
    .readFileString(path.join(stateDir, BACKUP_STATUS_FILE))
    .pipe(Effect.option, Effect.map(Option.getOrUndefined));
  const problem = backupProblem(file, now);
  if (problem === undefined) return;
  const period = neverGood(statusOf(file))
    ? `week:${Math.floor(now / WEEK_MS)}`
    : Math.floor(now / DAY_MS);
  // The host's backup covers every company it serves.
  const orgs = yield* sql<{
    orgId: string;
  }>`SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`;
  for (const { orgId } of orgs)
    yield* tellOwners(KinOrgId.make(orgId), `kin-host:backup:${orgId}:${period}`, problem);
});

/** Only on a Kin host (its unit sets `KIN_CHECKOUT`): a dev or desktop server has no nightly backup. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const host = yield* Config.option(Config.String("KIN_CHECKOUT"));
    if (Option.isNone(host)) return;
    let nextAt = 0;
    yield* (yield* Scheduler.Scheduler).register(
      "kin-host-backup",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < nextAt) return;
        nextAt = now + CHECK_EVERY;
        yield* check();
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin backup check failed", { cause }))),
    );
  }),
);
