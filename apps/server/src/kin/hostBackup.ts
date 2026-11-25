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
import * as DateTime from "effect/DateTime";
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
import { personHoldNow } from "./triggers/quietHold.ts";

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
  "No agent is running\n\nNobody is watching for you right now: Kin is stopped or every agent is paused or retired. Resume one, or add one, in Settings, Agents.";

const epochOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

/**
 * Whether a lead (as `liveLead` counts them) is awake: not retired, not paused, and the company's
 * stop switch off. Asleep, `since` is when the last of them went down, which names the episode.
 */
const leadsAwake = Effect.fn("KinHostBackup.leadsAwake")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
) {
  const leads = yield* sql<{
    pausedAt: string | null;
    retiredAt: string | null;
    listed: number;
  }>`SELECT a.paused_at AS "pausedAt", a.retired_at AS "retiredAt",
      CASE WHEN l.agent_id IS NULL THEN 0 ELSE 1 END AS listed
    FROM kin_agents a
    LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.role = 'lead'
    ORDER BY a.created_at, a.agent_id`;
  const [stop] = yield* sql<{ pausedAt: number }>`SELECT paused_at AS "pausedAt"
    FROM kin_org_state WHERE org_id = ${orgId} AND paused = 1 ORDER BY org_id`;
  const leadAwake = leads.some(
    (lead) => lead.listed === 1 && lead.pausedAt === null && lead.retiredAt === null,
  );
  if (leadAwake && stop === undefined) return { awake: true as const };
  const downs = leads.flatMap((lead) => {
    const at = [lead.pausedAt, lead.retiredAt].flatMap((iso) =>
      iso === null ? [] : [epochOf(iso)],
    );
    return at.length === 0 ? [] : [Math.min(...at)];
  });
  const starts = [
    ...(stop === undefined ? [] : [stop.pausedAt]),
    ...(leadAwake || downs.length === 0 ? [] : [Math.max(...downs)]),
  ];
  return { awake: false as const, since: starts.length === 0 ? 0 : Math.min(...starts) };
});

/**
 * One notice in the owner's private chat per episode under `prefix`: posted while `episode` is
 * set and none is open, closed once it is undefined. Plain reads and writes: no turn, no model.
 */
export const episodeNotice = Effect.fn("KinHostBackup.episodeNotice")(function* (
  orgId: KinOrgId,
  prefix: string,
  episode:
    | { readonly id: string; readonly body: string; readonly outsideQuietHours?: true }
    | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* Chat.KinChatService;
  const repo = yield* Repository.KinChatRepository;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const open = yield* sql<{ waitingId: string }>`SELECT waiting_id AS "waitingId"
        FROM kin_waiting WHERE org_id = ${orgId} AND resolved_at IS NULL
          AND substr(message_id, 1, ${prefix.length}) = ${prefix}
        ORDER BY waiting_id`;
      if (episode === undefined) {
        for (const { waitingId } of open)
          yield* chat.resolveNotice({
            orgId,
            waitingId: KinWaitingId.make(waitingId),
            resolution: "closed",
          });
        return;
      }
      if (open.length > 0) return;
      const messageId = KinMessageId.make(`${prefix}${episode.id}`);
      if (Option.isSome(yield* repo.getMessage({ orgId, messageId }))) return;
      const [owner] = yield* sql<{ personId: KinPersonId }>`SELECT p.person_id AS "personId"
        FROM kin_people p WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
          AND ${sql.literal(accessSql("p"))} = 'owner'
        ORDER BY p.created_at, p.person_id LIMIT 1`;
      if (owner === undefined) return;
      // Held in the owner's quiet hours: the next hourly check tries again.
      if (
        episode.outsideQuietHours === true &&
        (yield* personHoldNow(orgId, owner.personId)) !== undefined
      )
        return;
      let chatId = yield* ownerPrivateChat(sql, orgId, owner.personId);
      if (chatId === undefined) {
        // A company that has never added an agent may have no chat for a private notice.
        chatId = KinChatId.make(`kin-notices:${orgId}:${owner.personId}`);
        const at = DateTime.formatIso(DateTime.makeUnsafe(now));
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
        body: episode.body,
        audience: "owner",
        waitingFor: owner.personId,
      });
    }),
  );
});

/** One notice while no lead is awake, closed once one is; a new episode is told again. */
export const checkLeadNotice = Effect.fn("KinHostBackup.checkLeadNotice")(function* (
  orgId: KinOrgId,
) {
  const leads = yield* leadsAwake(yield* SqlClient.SqlClient, orgId);
  yield* episodeNotice(
    orgId,
    `kin-no-lead:${orgId}:`,
    leads.awake ? undefined : { id: `since:${leads.since}`, body: NO_LEAD_NOTICE },
  );
});

const DREAM_NIGHTS_NOTICE = 3;
/** The first failing check, in words a person reads: the file it names means nothing to them. */
const dreamReason = (failure: string) =>
  (failure.split("\n")[0] ?? "")
    .replace(/^\S+\.md\b/, "A memory note")
    .replace(/\bdream\.json\b/, "The night's report")
    .trim();

/**
 * One notice once the nightly memory update has failed three nights in a row, closed by the next
 * night that succeeds. Nothing remembered is lost: a failed night's material is read again.
 */
export const checkDreamNotice = Effect.fn("KinHostBackup.checkDreamNotice")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* sql<{ ownerDate: string; status: string; failure: string | null }>`
    SELECT owner_date AS "ownerDate", status, failure FROM kin_dream_runs
    WHERE org_id = ${orgId} AND status IN ('failed', 'succeeded')
    ORDER BY owner_date DESC LIMIT ${DREAM_NIGHTS_NOTICE}`;
  const failing =
    runs.length === DREAM_NIGHTS_NOTICE && runs.every((run) => run.status === "failed");
  if (!failing && runs[0]?.status !== "succeeded") return;
  const first = runs.at(-1);
  const reason = dreamReason(runs[0]?.failure ?? "");
  yield* episodeNotice(
    orgId,
    `kin-dream-failed:${orgId}:`,
    failing && first !== undefined
      ? {
          id: first.ownerDate,
          outsideQuietHours: true,
          body: `Kin's nightly memory update has failed three nights in a row\n\nEach night Kin reads the day and writes down what is worth remembering. That has not finished for three nights, so nothing new was remembered from them. Nothing Kin already remembered was lost, and tonight it will read those days again.${reason === "" ? "" : `\n\nFor whoever looks after Kin, the last night stopped on: ${reason}${/[.!?]$/.test(reason) ? "" : "."}`}`,
        }
      : undefined,
  );
});

/**
 * `checkLeadNotice` right after a pause, resume, retire or stop, so the notice isn't up to an
 * hour late. Skipped where the chat services aren't provided; the hourly check covers that.
 */
export const checkLeadNoticeNow = Effect.fn("KinHostBackup.checkLeadNoticeNow")(function* (
  orgId: KinOrgId,
) {
  const chat = yield* Effect.serviceOption(Chat.KinChatService);
  const repo = yield* Effect.serviceOption(Repository.KinChatRepository);
  if (Option.isNone(chat) || Option.isNone(repo)) return;
  yield* checkLeadNotice(orgId).pipe(
    Effect.provideService(Chat.KinChatService, chat.value),
    Effect.provideService(Repository.KinChatRepository, repo.value),
    Effect.catchCause((cause) => Effect.logWarning("Kin no-agent notice failed", { orgId, cause })),
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
