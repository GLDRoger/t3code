import { KinChatError, type KinRecordState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { dayIn } from "../work/money.ts";
import { latestComments, personSeesRecord, requestHashOf } from "../work/recordComments.ts";
import { comment } from "../work/workComments.ts";
import { iso, notFound, ownerZone, workFailure } from "../work/recordRows.ts";
import { holderOf, type TasksKeyHolder } from "./TasksKeys.ts";

/** The states a coding agent may set: start, finish, or put a task back to open. */
export type TaskState = Extract<KinRecordState, "open" | "doing" | "done">;

const LIST_CAP = 100;
const COMMENTS_SHOWN = 10;

const ended = new KinChatError({
  reason: "not_allowed",
  message: "This coding agent key no longer works. Ask its holder for a new one.",
});

type TaskRow = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly notes: string;
  readonly state: KinRecordState;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
};

/** A Work task this person holds now, as `heldBy` decides at the writer. */
const held = (sql: SqlClient.SqlClient, holder: TasksKeyHolder) =>
  sql`r.org_id = ${holder.orgId} AND r.register_id = 'work' AND r.owner_kind = 'person'
    AND r.owner_id = ${holder.personId} AND r.state <> 'dropped'`;

const rows = (sql: SqlClient.SqlClient) => sql`SELECT r.record_id AS "recordId", r.key, r.title,
    r.notes, r.state, r.due_at AS "dueAt", r.due_all_day AS "dueAllDay",
    r.project_id AS "projectId", p.title AS "projectTitle"
  FROM kin_records r LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id`;

/** In the caller's transaction: the key still acts as the person it was admitted as. */
const stillTheirs = Effect.fn("KinTasksKey.stillTheirs")(function* (holder: TasksKeyHolder) {
  const now = yield* holderOf(holder.sessionId);
  if (Option.isNone(now) || now.value.personId !== holder.personId) return yield* ended;
});

/** The narrow view: no money, client, people, memory or chat; a project only if they see it. */
const shape = Effect.fn("KinTasksKey.shape")(function* (
  holder: TasksKeyHolder,
  found: ReadonlyArray<TaskRow>,
) {
  const zone = yield* ownerZone(holder.orgId);
  const projects = new Set<string>();
  for (const id of new Set(found.flatMap((row) => (row.projectId === null ? [] : [row.projectId]))))
    if (yield* personSeesRecord(holder.orgId, holder.personId, id)) projects.add(id);
  return found.map((row) => ({
    key: row.key,
    title: row.title,
    state: row.state,
    due: row.dueAt === null ? null : row.dueAllDay === 1 ? dayIn(row.dueAt, zone) : iso(row.dueAt),
    project:
      row.projectId !== null && projects.has(row.projectId) ? (row.projectTitle ?? null) : null,
  }));
});

/** The person's open tasks, soonest due first. */
export const listMine = Effect.fn("KinTasksKey.list")(function* (holder: TasksKeyHolder) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    yield* stillTheirs(holder);
    const found = yield* sql<TaskRow>`${rows(sql)}
      WHERE ${held(sql, holder)} AND r.state <> 'done'
      ORDER BY r.due_at IS NULL, r.due_at, r.created_at, r.key LIMIT ${LIST_CAP + 1}`;
    return {
      tasks: yield* shape(holder, found.slice(0, LIST_CAP)),
      more: found.length > LIST_CAP,
    };
  }).pipe(sql.withTransaction, workFailure);
});

const readOne = Effect.fn("KinTasksKey.readOne")(function* (holder: TasksKeyHolder, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<TaskRow>`${rows(sql)} WHERE ${held(sql, holder)} AND r.key = ${key}`;
  if (row === undefined) return yield* notFound(key);
  const [task] = yield* shape(holder, [row]);
  if (task === undefined) return yield* notFound(key);
  const shown = (yield* latestComments(holder.orgId, row.recordId, COMMENTS_SHOWN)).comments;
  const ids = [
    ...new Set(shown.map((one) => (one.by._tag === "person" ? one.by.personId : one.by.agentId))),
  ];
  const names = new Map(
    ids.length === 0
      ? []
      : (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
            FROM kin_people WHERE org_id = ${holder.orgId} AND person_id IN ${sql.in(ids)}
          UNION ALL SELECT agent_id AS id, display_name AS name
            FROM kin_agents WHERE org_id = ${holder.orgId} AND agent_id IN ${sql.in(ids)}
          ORDER BY id`).map((one) => [one.id, one.name] as const),
  );
  return {
    ...task,
    brief: row.notes,
    comments: shown.map((one) => {
      const id = one.by._tag === "person" ? one.by.personId : one.by.agentId;
      return {
        by: id === holder.personId ? "you" : (names.get(id) ?? "someone"),
        at: one.at,
        text: one.body,
      };
    }),
  };
});

/** One task the person holds, with its brief and newest comments; any other is not found. */
export const getMine = Effect.fn("KinTasksKey.get")(function* (
  holder: TasksKeyHolder,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    yield* stillTheirs(holder);
    return yield* readOne(holder, key);
  }).pipe(sql.withTransaction, workFailure);
});

/**
 * As the person, through this key, by the app's own comment path, so the same people are told.
 * The same words again from this key are the same comment.
 */
export const commentMine = Effect.fn("KinTasksKey.comment")(function* (
  holder: TasksKeyHolder,
  input: { readonly key: string; readonly text: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const written = yield* comment(
    [{ _tag: "person", orgId: holder.orgId, personId: holder.personId }],
    {
      orgId: holder.orgId,
      key: input.key,
      body: input.text,
      clientRequestId: `key:${holder.sessionId}:${requestHashOf(input.text, [])}`,
    },
    undefined,
    {
      sessionId: holder.sessionId,
      // In the comment's own transaction: the key is still live and the task still theirs.
      sees: (recordId) =>
        stillTheirs(holder).pipe(
          Effect.provideService(KinIdentity, identity),
          Effect.andThen(
            sql`SELECT 1 FROM kin_records r WHERE ${held(sql, holder)} AND r.record_id = ${recordId}`,
          ),
          Effect.map((found) => found.length > 0),
        ),
    },
  );
  return { key: input.key, posted: written.created };
});

/** Starts, finishes or reopens a task the person holds, as them, through this key. */
export const setStateMine = Effect.fn("KinTasksKey.setState")(function* (
  holder: TasksKeyHolder,
  input: { readonly key: string; readonly state: TaskState },
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const writer: Writer = {
    actor: { _tag: "person", personId: holder.personId },
    via: "owner",
    askedBy: holder.personId,
    codingAgentKey: holder.sessionId,
  };
  return yield* Effect.gen(function* () {
    yield* stillTheirs(holder);
    yield* records.update(holder.orgId, writer, input.key, { state: input.state });
    return yield* readOne(holder, input.key);
  }).pipe(sql.withTransaction, workFailure);
});
