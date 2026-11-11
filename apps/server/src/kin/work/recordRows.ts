import {
  KIN_RECORD_CHANGES_CAP,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinRecordId,
  type KinOrgId,
  type KinRecord,
  type KinRecordCategory,
  type KinRecordChange,
  type KinRecordDetail,
  type KinRecordLink,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkActor,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The plain rows behind `KinRecords`: reads and the shapes they decode into. No writes here. */

export type Principal = KinWorkPrincipal;
export type Actor = KinWorkActor;
export type RecordRow = {
  readonly orgId: string;
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly state: KinRecordState;
  readonly waitingOnKind: "person" | "agent" | null;
  readonly waitingOnId: string | null;
  readonly ownerKind: "person" | "agent";
  readonly ownerId: string;
  readonly side: KinRecordSide;
  readonly category: KinRecordCategory | null;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly sensitive: number;
  readonly confirmed: number;
  readonly notes: string;
  readonly rev: number;
  readonly sourceChatId: string | null;
  readonly sourceMessageId: string | null;
  readonly createdByKind: "person" | "agent" | "system";
  readonly createdById: string | null;
  readonly assignedBy: string | null;
  readonly assignedAt: number | null;
  readonly originKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly working: number;
  readonly pullUrl: string | null;
};

export const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Work is unavailable right now. Try again.",
});
export const notFound = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No entry ${key.slice(0, 40)} in Work.` });

export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
export const isClosed = (state: KinRecordState) => state === "done" || state === "dropped";
export const principal = (kind: string | null, id: string | null): Principal | null =>
  id === null
    ? null
    : kind === "person"
      ? { _tag: "person", personId: KinPersonId.make(id) }
      : kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id) }
        : null;
export const principalId = (who: Principal) => (who._tag === "person" ? who.personId : who.agentId);
export const samePrincipal = (left: Principal | null, right: Principal | null) =>
  left === null || right === null
    ? left === right
    : left._tag === right._tag && principalId(left) === principalId(right);
const actorOf = (kind: string, id: string | null): Actor =>
  kind === "system" ? { _tag: "system" } : (principal(kind, id) ?? { _tag: "system" });

/** The columns every read selects, with the two derived ones: a running worker and the last PR. */
export const selectRecords = (sql: SqlClient.SqlClient) => sql`
  SELECT r.org_id AS "orgId", r.record_id AS "recordId", r.key, r.title, r.state,
    r.waiting_on_kind AS "waitingOnKind", r.waiting_on_id AS "waitingOnId",
    r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", r.side, r.category,
    r.due_at AS "dueAt", r.due_all_day AS "dueAllDay", r.sensitive, r.confirmed, r.notes, r.rev,
    r.source_chat_id AS "sourceChatId", r.source_message_id AS "sourceMessageId",
    r.created_by_kind AS "createdByKind", r.created_by_id AS "createdById",
    r.assigned_by_person_id AS "assignedBy", r.assigned_at AS "assignedAt",
    r.origin_key AS "originKey", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    r.closed_at AS "closedAt",
    EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_workers k
        ON k.org_id = l.org_id AND k.worker_id = l.target
      WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'worker'
        AND k.ended_at IS NULL) AS working,
    (SELECT l.target FROM kin_record_links l WHERE l.org_id = r.org_id
      AND l.record_id = r.record_id AND l.kind = 'pull_request'
      ORDER BY l.created_at DESC, l.target LIMIT 1) AS "pullUrl"
  FROM kin_records r`;

export const byKey = Effect.fn("KinRecords.byKey")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.key = ${key} ORDER BY r.record_id`;
  return row;
});
export const byId = Effect.fn("KinRecords.byId")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} ORDER BY r.record_id`;
  return row;
});

const pullNumber = (url: string) => {
  const found = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return found === undefined ? undefined : Number.parseInt(found, 10);
};

export const toRecord = (row: RecordRow, now: number): KinRecord => {
  const number = row.pullUrl === null ? undefined : pullNumber(row.pullUrl);
  return {
    recordId: KinRecordId.make(row.recordId),
    orgId: row.orgId as KinOrgId,
    key: row.key,
    title: row.title as KinRecord["title"],
    state: row.state,
    waitingOn: row.state === "waiting" ? principal(row.waitingOnKind, row.waitingOnId) : null,
    owner: principal(row.ownerKind, row.ownerId) ?? {
      _tag: "agent",
      agentId: KinAgentId.make(row.ownerId),
    },
    category: row.category,
    side: row.side,
    dueAt: row.dueAt === null ? null : iso(row.dueAt),
    dueAllDay: row.dueAllDay === 1,
    late: row.dueAt !== null && row.dueAt < now && !isClosed(row.state),
    confirmed: row.confirmed === 1,
    sensitive: row.sensitive === 1,
    working: row.working === 1,
    pullRequest: row.pullUrl === null || number === undefined ? null : { url: row.pullUrl, number },
    rev: row.rev,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
  };
};

type ChangeRow = {
  readonly seq: number;
  readonly at: number;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly via: KinRecordChange["via"];
  readonly kind: KinRecordChange["kind"];
  readonly fieldsJson: string;
};
type LinkRow = {
  readonly kind: KinRecordLink["kind"];
  readonly relation: KinRecordLink["relation"];
  readonly target: string;
  readonly chatId: string | null;
  readonly label: string | null;
  readonly createdAt: number;
};
export type FieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};

const parseFields = (json: string): ReadonlyArray<FieldChange> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<FieldChange>) : [];
  } catch {
    return [];
  }
};

const changesOf = Effect.fn("KinRecords.changesOf")(function* (
  orgId: KinOrgId,
  recordId: string,
  limit: number = KIN_RECORD_CHANGES_CAP,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ChangeRow>`SELECT seq, at, actor_kind AS "actorKind",
      actor_id AS "actorId", via, kind, fields_json AS "fieldsJson"
    FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${recordId}
    ORDER BY seq DESC LIMIT ${limit}`;
  return rows.map((row): KinRecordChange => ({
    seq: row.seq,
    at: iso(row.at),
    by: actorOf(row.actorKind, row.actorId),
    via: row.via,
    kind: row.kind,
    fields: parseFields(row.fieldsJson).filter((change) => change.field.trim() !== ""),
  }));
});

const linksOf = Effect.fn("KinRecords.linksOf")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<LinkRow>`SELECT kind, relation, target, chat_id AS "chatId", label,
      created_at AS "createdAt"
    FROM kin_record_links WHERE org_id = ${orgId} AND record_id = ${recordId}
    ORDER BY created_at, kind, target`;
  return rows.map((row): KinRecordLink => ({
    kind: row.kind,
    relation: row.relation,
    target: row.target,
    chatId: row.chatId === null ? null : KinChatId.make(row.chatId),
    label: row.label,
    createdAt: iso(row.createdAt),
  }));
});

export const toDetail = Effect.fn("KinRecords.toDetail")(function* (
  row: RecordRow,
  now: number,
  changeLimit?: number,
) {
  const orgId = row.orgId as KinOrgId;
  return {
    ...toRecord(row, now),
    notes: row.notes,
    source: {
      chatId: row.sourceChatId === null ? null : KinChatId.make(row.sourceChatId),
      messageId: row.sourceMessageId === null ? null : KinMessageId.make(row.sourceMessageId),
    },
    assignedBy: principal("person", row.assignedBy),
    assignedAt: row.assignedAt === null ? null : iso(row.assignedAt),
    createdBy: actorOf(row.createdByKind, row.createdById),
    links: yield* linksOf(orgId, row.recordId),
    changes: yield* changesOf(orgId, row.recordId, changeLimit),
  } satisfies KinRecordDetail;
});

/** The latest change number in an org, which clients and cursors compare against. */
export const latestSeq = Effect.fn("KinRecords.latestSeq")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId}`;
  return row?.seq ?? 0;
});

/** The owner's IANA zone, for all-day due dates; UTC when unset. */
export const ownerZone = Effect.fn("KinRecords.ownerZone")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`.pipe(
    Effect.orElseSucceed(() => []),
  );
  const zone = row?.zone ?? "UTC";
  return validZone(zone) ? zone : "UTC";
});
const validZone = (zone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

/** A calendar day's last millisecond in `zone`: an all-day entry is late only once it is over. */
export const endOfDay = (day: string, zone: string) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const start = DateTime.makeZonedUnsafe(
    { year: year ?? 1970, month: month ?? 1, day: date ?? 1 },
    { timeZone: zone, adjustForTimeZone: true },
  );
  return DateTime.toEpochMillis(DateTime.add(start, { days: 1 })) - 1;
};
