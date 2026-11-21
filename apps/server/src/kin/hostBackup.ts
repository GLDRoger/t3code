import { KinMessageId, KinOrgId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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

/** Written by ops/kin/host/backup.sh into the server's state directory after every run. */
export const BACKUP_STATUS_FILE = "kin-backup-status.json";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const STALE_AFTER = 36 * HOUR;
const CHECK_EVERY = HOUR;

const BackupStatus = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    lastGoodAt: Schema.NullOr(Schema.Number),
    error: Schema.String,
  }),
);
const decodeStatus = Schema.decodeUnknownOption(BackupStatus);

const ago = (ms: number) =>
  ms < 2 * DAY ? `${Math.floor(ms / HOUR)} hours ago` : `${Math.floor(ms / DAY)} days ago`;

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

/**
 * Tells each company's owner when this host's backup is old or failing, at most once a UTC day,
 * and when none ever worked, at most once a week.
 */
export const check = Effect.fn("KinHostBackup.check")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
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
    ? `week:${Math.floor(now / WEEK)}`
    : Math.floor(now / DAY);
  // The host's backup covers every company it serves.
  const orgs = yield* sql<{
    orgId: string;
  }>`SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`;
  for (const { orgId } of orgs) {
    const org = KinOrgId.make(orgId);
    const lead = yield* liveLead(sql, org, { prefer: CHIEF_OF_STAFF_DOMAIN }).pipe(
      NodeSqliteClient.readOnly,
    );
    if (lead === undefined) continue;
    // A notice with this id already posted makes the call a no-op: one a period at most.
    yield* chat.notice({
      orgId: org,
      chatId: lead.ownerChatId,
      messageId: KinMessageId.make(`kin-host:backup:${orgId}:${period}`),
      audience: "owner",
      body: problem,
    });
  }
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
