import type {
  KinOrgId,
  KinPersonId,
  KinRecord,
  KinRecordChange,
  KinRecordDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { sensitiveNow } from "./recordRows.ts";

/**
 * What a teammate sees of Work: tasks in the Work list that are not sensitive, by their own label or
 * their client's or project's, and that the owner shared with the team or are theirs (they hold it,
 * made it, or gave it to whoever holds it). Everything else looks like no entry at all: not listed,
 * not counted, not found by key or id, and never announced. Lists, money and docs stay the owner's.
 */
export const teamSees = (sql: SqlClient.SqlClient, personId: KinPersonId | Statement.Fragment) =>
  sql`(r.register_id = 'work' AND NOT ${sensitiveNow(sql)} AND (r.team_shared = 1
    OR (r.owner_kind = 'person' AND r.owner_id = ${personId})
    OR (r.created_by_kind = 'person' AND r.created_by_id = ${personId})
    OR r.assigned_by_person_id = ${personId}))`;

/** A teammate changes only a task they hold or gave to whoever holds it, never one they only see. */
const teamWrites = (sql: SqlClient.SqlClient, personId: KinPersonId) =>
  sql`(${teamSees(sql, personId)} AND ((r.owner_kind = 'person' AND r.owner_id = ${personId})
    OR r.assigned_by_person_id = ${personId}))`;

/** The record ids of these this teammate may see, read through the caller's transaction. */
export const teamVisible = Effect.fn("KinTeamView.visible")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${teamSees(sql, personId)}
    ORDER BY r.record_id`;
  return new Set(rows.map((row) => row.recordId));
});

/** Whether this teammate may change the task: they hold it or gave it to whoever holds it. */
export const teamMayWrite = Effect.fn("KinTeamView.mayWrite")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} AND ${teamWrites(sql, personId)}
    LIMIT 1`;
  return rows.length > 0;
});

/**
 * The latest change number among the tasks this teammate may see, so a change to anything else
 * never moves the number they are shown.
 */
export const teamSeq = Effect.fn("KinTeamView.seq")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(c.seq) AS seq
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND ${teamSees(sql, personId)}`;
  return row?.seq ?? 0;
});

/** The keys of every task this teammate may see now, for telling them when one is hidden. */
export const teamKeys = Effect.fn("KinTeamView.keys")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
    WHERE r.org_id = ${orgId} AND ${teamSees(sql, personId)} ORDER BY r.key`;
  return new Set(rows.map((row) => row.key));
});

/** A Work task as a teammate reads it: no amount, balance, list fields, files or payments. */
export const teamRecord = <
  A extends KinRecord & { readonly files?: unknown; readonly payments?: unknown },
>({
  amount: _amount,
  balance: _balance,
  received: _received,
  tdsDeducted: _tds,
  fields: _fields,
  list: _list,
  listCategory: _listCategory,
  dateAt: _dateAt,
  dateAllDay: _dateAllDay,
  sensitiveInherited: _inherited,
  files: _files,
  payments: _payments,
  ...record
}: A) => record;

/** History lines a teammate reads: what the task says and who holds it, never money or labels. */
const TEAM_FIELDS = new Set([
  "title",
  "state",
  "owner",
  "due",
  "dueAllDay",
  "waitingOn",
  "category",
  "side",
  "repo",
  "notes",
  "confirmed",
]);
const teamChanges = (changes: ReadonlyArray<KinRecordChange>) =>
  changes.flatMap((change): ReadonlyArray<KinRecordChange> => {
    if (change.kind === "linked") return [];
    const fields = change.fields.filter((field) => TEAM_FIELDS.has(field.field));
    return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
  });

/**
 * A task's sheet as a teammate reads it. Links keep pull requests, web addresses and tasks they
 * may see; messages, workers and memory are the owner's. Where it was first asked is not theirs.
 */
export const teamDetail = Effect.fn("KinTeamView.detail")(function* (
  detail: KinRecordDetail,
  personId: KinPersonId,
) {
  const linked = detail.links.flatMap((link) =>
    link.kind === "record" && link.record !== undefined ? [link.record.recordId] : [],
  );
  const visible = yield* teamVisible(detail.orgId, personId, linked);
  const sheet: KinRecordDetail = {
    ...teamRecord(detail),
    source: { chatId: null, messageId: null },
    links: detail.links.filter((link) =>
      link.kind === "pull_request" || link.kind === "url"
        ? true
        : link.kind === "record" && link.record !== undefined && visible.has(link.record.recordId),
    ),
    changes: teamChanges(detail.changes),
  };
  return sheet;
});
