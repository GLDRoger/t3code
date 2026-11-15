import {
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  type KinRecord,
  type KinRecordChange,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { notFound, sensitiveNow } from "./recordRows.ts";

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

/** What every one of these people sees: a turn's view (`turnPeople`). None sees nothing. */
export const viewSees = (sql: SqlClient.SqlClient, people: ReadonlyArray<KinPersonId>) =>
  people.length === 0
    ? sql`0 = 1`
    : sql`(${sql.and(people.map((person) => teamSees(sql, person)))})`;

/** Whether every one of these people may see this entry now. */
export const viewVisible = Effect.fn("KinTeamView.viewVisible")(function* (
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} AND ${viewSees(sql, people)} LIMIT 1`;
  return rows.length > 0;
});

/**
 * A turn's write in a chat others read, inside its transaction: every person behind it still sees
 * the task, and each who asked for the change may make it, as their own screens would let them.
 */
export const viewGuard = Effect.fn("KinTeamView.viewGuard")(function* (
  orgId: KinOrgId,
  view: {
    readonly people: ReadonlyArray<KinPersonId>;
    readonly askers: ReadonlyArray<KinPersonId>;
  },
  write: Parameters<typeof teamGuard>[2],
) {
  if (view.people.length === 0) return yield* noLongerTeam;
  for (const person of view.people)
    yield* teamGuard(orgId, person, {
      ...write,
      changes: write.changes && view.askers.includes(person),
    });
});

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

export const TEAM_REFUSED = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner changes that.",
});
const noLongerTeam = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner or a co-owner can do that in Work.",
});

/** What a teammate's write may never touch: labels, sharing, money, list detail, clients, projects. */
const OWNERS_FIELDS = [
  "sensitive",
  "team",
  "confirmed",
  "amount",
  "repeat",
  "dateAt",
  "dateAllDay",
  "fields",
  "partyId",
  "projectId",
  "list",
  "source",
  "links",
] as const;

/**
 * A teammate's write, checked inside its transaction before any retry, revision or other answer:
 * they are still let in, the task is one they see (else it is no task at all) and, for a change,
 * one they hold or gave away. The repository runs this, so no caller's earlier read decides it.
 */
export const teamGuard = Effect.fn("KinTeamView.guard")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  write: {
    readonly row: { readonly recordId: string; readonly key: string } | undefined;
    /** A change to the task, not a retry of the create that made it. */
    readonly changes: boolean;
    readonly input: Readonly<Partial<Record<(typeof OWNERS_FIELDS)[number], unknown>>>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const member = yield* sql`SELECT 1 FROM kin_session_bindings b
    JOIN kin_people p ON p.org_id = b.org_id AND p.person_id = b.person_id
    WHERE b.org_id = ${orgId} AND b.person_id = ${personId} AND b.revoked_at IS NULL LIMIT 1`;
  if (member.length === 0) return yield* noLongerTeam;
  const { row } = write;
  if (row !== undefined) {
    const [seen] = yield* sql<{ writes: number }>`SELECT ${teamWrites(sql, personId)} AS writes
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${row.recordId}
        AND ${teamSees(sql, personId)}`;
    if (seen === undefined) return yield* notFound(row.key);
    if (write.changes && seen.writes !== 1)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: `Only whoever holds ${row.key}, or gave it to them, can change it.`,
      });
  }
  if (OWNERS_FIELDS.some((field) => write.input[field] !== undefined)) return yield* TEAM_REFUSED;
});

/** `p` is a teammate who sees `r`: a person let in by an invite, never the owner's own session. */
export const teammateSees = (sql: SqlClient.SqlClient) =>
  sql`(EXISTS (SELECT 1 FROM kin_session_bindings b WHERE b.org_id = p.org_id
    AND b.person_id = p.person_id) AND ${teamSees(sql, sql`p.person_id`)})`;

/** Who sees which of these entries now, as person and record pairs, through the caller's transaction. */
export const teamPairs = Effect.fn("KinTeamView.pairs")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
) {
  if (recordIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ personId: string; recordId: string }>`
    SELECT p.person_id AS "personId", r.record_id AS "recordId"
    FROM kin_people p JOIN kin_records r ON r.org_id = p.org_id
    WHERE p.org_id = ${orgId} AND r.record_id IN ${sql.in([...new Set(recordIds)])}
      AND ${teammateSees(sql)}
    ORDER BY p.person_id, r.record_id`;
});

/** The tasks whose visibility a client's or project's label can change: theirs, by any route. */
export const dependents = Effect.fn("KinTeamView.dependents")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId" FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND (r.party_id = ${recordId}
      OR r.project_id = ${recordId} OR r.project_id IN (SELECT p.record_id FROM kin_records p
        WHERE p.org_id = r.org_id AND p.register_id = 'projects' AND p.party_id = ${recordId}))
    ORDER BY r.record_id`;
  return rows.map((row) => row.recordId);
});

/**
 * Moves each person's own change number on by one, in the caller's transaction, and returns the
 * new numbers. A teammate's number counts only changes to tasks they could see before or after.
 */
export const bumpTeamSeqs = Effect.fn("KinTeamView.bump")(function* (
  orgId: KinOrgId,
  personIds: ReadonlyArray<string>,
) {
  if (personIds.length === 0) return new Map<string, number>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string; seq: number }>`
    INSERT INTO kin_team_seqs (org_id, person_id, seq)
    SELECT p.org_id, p.person_id, 1 FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.person_id IN ${sql.in([...new Set(personIds)])}
    ON CONFLICT (org_id, person_id) DO UPDATE SET seq = seq + 1
    RETURNING person_id AS "personId", seq`;
  return new Map(rows.map((row) => [row.personId, row.seq]));
});

/**
 * This teammate's own change number: it moves only when a task they could see changes, so it
 * says nothing of anything else. The owner's number is the org's (`latestSeq`).
 */
export const teamSeq = Effect.fn("KinTeamView.seq")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number }>`SELECT seq FROM kin_team_seqs
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  return row?.seq ?? 0;
});

/** Whether this teammate may see the entry with this key now. */
export const teamSeesKey = Effect.fn("KinTeamView.seesKey")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.key = ${key} AND ${teamSees(sql, personId)} LIMIT 1`;
  return rows.length > 0;
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

/** A Work task as a teammate reads it: no client, project, money, list fields, files or payments. */
export const teamRecord = <
  A extends KinRecord & { readonly files?: unknown; readonly payments?: unknown },
>({
  party: _party,
  project: _project,
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
  "handedBack",
]);
/** Numbered among themselves, newest highest: the org's numbers would show what they can't see. */
export const teamChanges = (changes: ReadonlyArray<KinRecordChange>) => {
  const shown = changes.flatMap((change): ReadonlyArray<KinRecordChange> => {
    if (change.kind === "linked") return [];
    const fields = change.fields.filter((field) => TEAM_FIELDS.has(field.field));
    return change.kind === "updated" && fields.length === 0 ? [] : [{ ...change, fields }];
  });
  return shown.map((change, index) => ({ ...change, seq: shown.length - index }));
};

/**
 * A task's sheet as a teammate reads it. Links keep pull requests, web addresses and tasks they
 * may see; messages, workers and memory are the owner's. Where it was first asked is not theirs.
 */
export const teamDetail = Effect.fn("KinTeamView.detail")(function* (
  detail: KinRecordDetail,
  personId: KinPersonId,
  /** Their own change number, read no later than the sheet. */
  seq: number,
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
    seq,
  };
  return sheet;
});
