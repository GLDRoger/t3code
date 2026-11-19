import type { KinRecordState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { type CodingAgentConnection, connectionOf } from "../work/codingAgent.ts";
import { get, list, update } from "../work/ownerWork.ts";
import { requestHashOf } from "../work/recordComments.ts";
import { workFailure } from "../work/recordRows.ts";
import { comment } from "../work/workComments.ts";
import { commentResult, taskRows, taskSheet } from "../you/projection.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/** The states a coding agent may set: start, finish, or put a task back to open. */
export type TaskState = Extract<KinRecordState, "open" | "doing" | "done">;

const LIST_CAP = 100;

/** The key's person, as their own screens' Work methods take them, with the key's connection. */
const asPerson = (holder: TasksKeyHolder) => {
  const connection: CodingAgentConnection = connectionOf(holder);
  const people: ReadonlyArray<PersonIdentity> = [
    { _tag: "person", orgId: holder.orgId, personId: holder.personId },
  ];
  return { connection, people };
};

/** The person's open tasks, soonest due first. */
export const listMine = Effect.fn("KinTasksKey.list")(function* (holder: TasksKeyHolder) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  return yield* list(people, { orgId: holder.orgId, limit: LIST_CAP }, connection).pipe(
    Effect.flatMap((page) =>
      "records" in page
        ? taskRows(connection, page.records, page.nextCursor !== null)
        : Effect.die("Work answered a coding agent's list in compact rows"),
    ),
    sql.withTransaction,
    workFailure,
  );
});

/** One task the person holds, with its brief and newest comments; any other is not found. */
export const getMine = Effect.fn("KinTasksKey.get")(function* (
  holder: TasksKeyHolder,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  return yield* get(people, { orgId: holder.orgId, key }, connection).pipe(
    Effect.flatMap((sheet) => taskSheet(connection, sheet)),
    sql.withTransaction,
    workFailure,
  );
});

/**
 * As the person, through this key, by the app's own comment path, so the same people are told.
 * The same words again from this key are the same comment.
 */
export const commentMine = Effect.fn("KinTasksKey.comment")(function* (
  holder: TasksKeyHolder,
  input: { readonly key: string; readonly text: string },
) {
  const { connection, people } = asPerson(holder);
  const written = yield* comment(
    people,
    {
      orgId: holder.orgId,
      key: input.key,
      body: input.text,
      clientRequestId: `key:${holder.sessionId}:${requestHashOf(input.text, [])}`,
    },
    undefined,
    connection,
  );
  return commentResult(input.key, written.created);
});

/** Starts, finishes or reopens a task the person holds, as them, through this key. */
export const setStateMine = Effect.fn("KinTasksKey.setState")(function* (
  holder: TasksKeyHolder,
  input: { readonly key: string; readonly state: TaskState },
) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  return yield* update(
    people,
    { orgId: holder.orgId, key: input.key, state: input.state },
    connection,
  ).pipe(
    Effect.flatMap((sheet) => taskSheet(connection, sheet)),
    sql.withTransaction,
    workFailure,
  );
});
