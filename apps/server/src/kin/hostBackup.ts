import {
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWaitingId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerPrivateChat } from "./chat/executionNotices.ts";
import * as Repository from "./chat/KinChatRepository.ts";
import * as Chat from "./chat/KinChatService.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "./lead/orgLeads.ts";
import { DAY_MS, HOUR_MS } from "./durations.ts";
import { accessSql } from "./people/KinAccess.ts";

/** Written by ops/kin/host/backup.sh into the server's state directory after every run. */
export const BACKUP_STATUS_FILE = "kin-backup-status.json";

const STALE_AFTER = 36 * HOUR_MS;

const BackupStatus = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    lastGoodAt: Schema.NullOr(Schema.Number),
    error: Schema.String,
    ranAt: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);
const decodeStatus = Schema.decodeUnknownOption(BackupStatus);
const statusOf = (statusFile: string | undefined) =>
  statusFile === undefined ? Option.none() : decodeStatus(statusFile);
/** What `backup.sh` last recorded, as Settings › Kin's computer shows it. */
export const backupRecord = statusOf;

/**
 * Whether the owner should hear about this server's backups: none ever good, or the last good one
 * over 36 hours old. Undefined while the last good one is recent.
 */
export const backupProblem = (statusFile: string | undefined, now: number) => {
  const status = statusOf(statusFile);
  const lastGoodAt = Option.isSome(status) ? status.value.lastGoodAt : null;
  if (lastGoodAt !== null && now - lastGoodAt <= STALE_AFTER) return undefined;
  return { lastGoodAt };
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

const NO_LEAD_NOTICE =
  "No agent is running\n\nNobody is watching for you right now: every agent is paused or retired. Resume one, or add one, in Settings, Agents.";

export const checkLeadNotice = Effect.fn("KinHostBackup.checkLeadNotice")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
  const repo = yield* Repository.KinChatRepository;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const live = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
      const prefix = `kin-no-lead:${orgId}:`;
      const now = yield* Clock.currentTimeMillis;
      const messageId = KinMessageId.make(`${prefix}${Math.floor(now / DAY_MS)}`);
      const notices = yield* sql<{ waitingId: string }>`SELECT waiting_id AS "waitingId"
        FROM kin_waiting WHERE org_id = ${orgId} AND resolved_at IS NULL
          AND substr(message_id, 1, ${prefix.length}) = ${prefix}
          AND (${live === undefined ? 0 : 1} OR message_id <> ${messageId})
        ORDER BY waiting_id`;
      for (const { waitingId } of notices)
        yield* chat.resolveNotice({
          orgId,
          waitingId: KinWaitingId.make(waitingId),
          resolution: "closed",
        });
      if (live !== undefined) return;
      if (Option.isSome(yield* repo.getMessage({ orgId, messageId }))) return;
      const [owner] = yield* sql<{ personId: KinPersonId }>`SELECT p.person_id AS "personId"
        FROM kin_people p WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
          AND ${sql.literal(accessSql("p"))} = 'owner'
        ORDER BY p.created_at, p.person_id LIMIT 1`;
      if (owner === undefined) return;
      let chatId = yield* ownerPrivateChat(sql, orgId, owner.personId);
      if (chatId === undefined) {
        // A company that has never added an agent may have no chat for a private notice.
        chatId = KinChatId.make(`kin-notices:${orgId}:${owner.personId}`);
        const at = new Date(now).toISOString();
        yield* repo.createChat({
          orgId,
          chatId,
          kind: "router",
          title: "Kin notices",
          teamId: null,
          directKey: null,
          lastMessageAt: null,
          createdAt: at,
          archivedAt: null,
        });
        yield* repo.addMember({
          orgId,
          chatId,
          memberId: KinMemberId.make(chatId),
          principal: { _tag: "person", personId: owner.personId },
          role: "owner",
          joinedAt: at,
          leftAt: null,
          mutedUntil: null,
        });
      }
      yield* chat.notice({
        orgId,
        chatId,
        messageId,
        body: NO_LEAD_NOTICE,
        audience: "owner",
        waitingFor: owner.personId,
      });
    }),
  );
});

export const LOW_ON_SPACE =
  "Kin's computer is running low on space, and agents will stop working if it runs out. Kin cleared out old temporary files, but it's still low. Settings › Kin's computer shows what's using the space, and Free up space now clears again.";

const LOW_SPACE_PERCENT = 20;

export interface SpaceReading {
  readonly folder: string;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

class SpaceReadError extends Schema.TaggedError<SpaceReadError>()("KinHostSpaceReadError", {
  folder: Schema.String,
  cause: Schema.Defect(),
}) {}

/** One statfs; none when the folder can't be read. */
export const readSpace = (folder: string) =>
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

const lowOf = (readings: ReadonlyArray<Option.Option<SpaceReading>>) =>
  readings
    .flatMap((reading) => Option.toArray(reading))
    .filter(
      (reading) =>
        reading.totalBytes > 0 && reading.freeBytes * 100 < reading.totalBytes * LOW_SPACE_PERCENT,
    );

/**
 * When a folder's disk has less than 20% left: clears old temporary files at once (`clean`), and
 * if it is still low, warns in the log and tells a company's owners at most once a UTC day. A
 * folder it can't read is skipped. The notice is only on a Kin host.
 */
export const warnIfLowOnSpace = Effect.fn("KinHostBackup.warnIfLowOnSpace")(function* (
  org: KinOrgId,
  folders: ReadonlyArray<string>,
  read: (folder: string) => Effect.Effect<Option.Option<SpaceReading>> = readSpace,
  clean: Effect.Effect<{ readonly ran: boolean }> = Effect.succeed({ ran: false }),
) {
  if (lowOf(yield* Effect.forEach(folders, read)).length === 0) return;
  const cleaned = yield* clean;
  const low = lowOf(yield* Effect.forEach(folders, read));
  if (low.length === 0) return;
  yield* Effect.logWarning("Kin host is low on space", {
    orgId: org,
    cleaned: cleaned.ran,
    low: low.map((reading) => ({
      ...reading,
      percentLeft: Math.floor((reading.freeBytes * 100) / reading.totalBytes),
    })),
  });
  if (Option.isNone(yield* Config.option(Config.String("KIN_CHECKOUT")))) return;
  const day = Math.floor((yield* Clock.currentTimeMillis) / DAY_MS);
  yield* tellOwners(org, `kin-host:low-space:${org}:${day}`, LOW_ON_SPACE);
});
