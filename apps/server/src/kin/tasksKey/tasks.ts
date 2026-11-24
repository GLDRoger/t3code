import {
  KinChatError,
  type KinRecordKey,
  type KinRecordState,
  type KinWorkPrincipal,
  type KinWorkHandBackInput,
  type KinWorkTickStepInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { keySentClientId } from "../chat/keySent.ts";
import {
  type CodingAgentConnection,
  connectionOf,
  connectionReaches,
  keyHidden,
} from "../work/codingAgent.ts";
import { CodingAgentCall } from "../work/keyCall.ts";
import { KinRecords, requestHashOf as entryHashOf } from "../work/KinRecords.ts";
import * as Clients from "../work/ownerClients.ts";
import {
  connectionViewer,
  create,
  get,
  handBack,
  handOver,
  nudge,
  tickStep,
  list,
  listSeen,
  update,
  updateAndGive,
} from "../work/ownerWork.ts";
import { requestHashOf } from "../work/recordComments.ts";
import { notFound, workFailure } from "../work/recordRows.ts";
import { comment } from "../work/workComments.ts";
import { commentResult, MATERIAL, taskRows, taskSheet } from "../you/projection.ts";
import { whoNamed } from "./people.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/** The states a coding agent may set: start, finish, or put a task back to open. */
export type TaskState = Extract<KinRecordState, "open" | "doing" | "done">;

const LIST_CAP = 100;

/** The key's person, as their own screens' Work methods take them, with the key's connection. */
export const asPerson = (holder: TasksKeyHolder, kind?: CodingAgentConnection["kind"]) => {
  const connection: CodingAgentConnection = connectionOf(holder, kind);
  const people: ReadonlyArray<PersonIdentity> = [
    { _tag: "person", orgId: holder.orgId, personId: holder.personId },
  ];
  return { connection, people };
};

/**
 * `run` as the key's person, as their own screen's method runs it, with the key's checks in the
 * same transaction: the key still theirs and live.
 */
export const keyed = Effect.fn("KinTasksKey.keyed")(function* <
  A,
  E extends { readonly _tag: string },
  R,
>(holder: TasksKeyHolder, run: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<A, E, R>) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  return yield* connectionViewer(people, connection, holder.orgId).pipe(
    Effect.andThen(run(people)),
    sql.withTransaction,
    workFailure,
    Effect.provideService(CodingAgentCall, holder.sessionId),
  );
});

/** A key a key never carries (labelled, or under a labelled client or project) is unknown. */
export const reachKey = Effect.fn("KinTasksKey.reachKey")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
  missing = (key: string) => new KinChatError({ reason: "not_found", message: `No ${key} here.` }),
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
    WHERE org_id = ${holder.orgId} AND key = ${key}`.pipe(workFailure);
  if (row !== undefined && (yield* keyHidden(holder.orgId, [row.id]).pipe(workFailure)).size > 0)
    return yield* missing(key);
  return key;
});
export const reachable = <K extends KinRecordKey | null | undefined>(
  holder: TasksKeyHolder,
  key: K,
) =>
  key === undefined || key === null
    ? Effect.succeed(key)
    : reachKey(holder, key).pipe(Effect.as(key));

/** The same request from the same key is the same request id, so a retry makes nothing new. */
export const requestIdOf = (holder: TasksKeyHolder, kind: string, request: object) =>
  keySentClientId(
    holder.sessionId,
    `${kind}:${entryHashOf({ clientRequestId: "", ...request }).slice(0, 40)}`,
  );

const due = (day: string | null | undefined) =>
  day === undefined ? {} : day === null ? { dueAt: null } : { dueAt: day, dueAllDay: true };

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

const sheetOf = Effect.fn("KinTasksKey.sheetOf")(function* (holder: TasksKeyHolder, key: string) {
  return yield* getMine(holder, key);
});

/**
 * What the person's Tasks list shows them, by holder (a name `list_people` gives), project or
 * state, soonest due first; open, doing and waiting unless a state is asked for.
 */
export const listSeenBy = Effect.fn("KinTasksKey.listSeen")(function* (
  holder: TasksKeyHolder,
  input: {
    readonly holder?: string | undefined;
    readonly project?: KinRecordKey | undefined;
    readonly state?: Exclude<KinRecordState, "dropped"> | undefined;
    readonly cursor?: string | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const { connection, people } = asPerson(holder);
  const owner = input.holder === undefined ? undefined : yield* whoNamed(holder, input.holder);
  const project = yield* reachable(holder, input.project);
  const page = yield* listSeen(
    people,
    {
      orgId: holder.orgId,
      limit: LIST_CAP,
      ...(owner === undefined ? {} : { owner }),
      ...(project === undefined ? {} : { project }),
      ...(input.state === undefined ? { open: true } : { states: [input.state] }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    connection,
  ).pipe(workFailure);
  if (!("records" in page)) return yield* Effect.die("Work answered a key's list in compact rows");
  const rows = yield* taskRows(connection, page.records, page.nextCursor !== null).pipe(
    sql.withTransaction,
    workFailure,
  );
  return { ...rows, next: page.nextCursor };
});

const withTask = <A, R>(
  holder: TasksKeyHolder,
  key: KinRecordKey,
  run: (people: ReadonlyArray<PersonIdentity>) => Effect.Effect<A, KinChatError, R>,
) =>
  keyed(holder, (people) =>
    Effect.gen(function* () {
      const row = yield* (yield* KinRecords).get(holder.orgId, key);
      if (
        row === undefined ||
        !(yield* connectionReaches(asPerson(holder).connection, row.recordId).pipe(workFailure))
      )
        return yield* notFound(key);
      return yield* run(people);
    }),
  );

export const tickTaskStep = Effect.fn("KinTasksKey.tickTaskStep")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinWorkTickStepInput, "orgId">,
) {
  const task = yield* withTask(holder, input.key, (people) =>
    tickStep(people, { orgId: holder.orgId, ...input }),
  );
  return { key: task.key, checklist: task.checklist ?? [], material: MATERIAL };
});

export const handTaskBack = Effect.fn("KinTasksKey.handTaskBack")(function* (
  holder: TasksKeyHolder,
  input: Omit<KinWorkHandBackInput, "orgId">,
) {
  return yield* withTask(holder, input.key, (people) =>
    handBack(people, { orgId: holder.orgId, ...input }),
  );
});

export const nudgeTask = Effect.fn("KinTasksKey.nudgeTask")(function* (
  holder: TasksKeyHolder,
  key: KinRecordKey,
) {
  return yield* withTask(holder, key, (people) => nudge(people, { orgId: holder.orgId, key }));
});

export const handOverTasks = Effect.fn("KinTasksKey.handOverTasks")(function* (
  holder: TasksKeyHolder,
  input: { readonly from: string; readonly to: string },
) {
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const from = yield* whoNamed(holder, input.from);
      const to = yield* whoNamed(holder, input.to);
      return yield* handOver(people, { orgId: holder.orgId, from, to });
    }),
  );
});

/** The other entries a call names, for the write's own reach check (`ownerWork.keyedWrite`). */
const named = (...keys: ReadonlyArray<KinRecordKey | null | undefined>) =>
  keys.filter((key): key is KinRecordKey => key !== undefined && key !== null);

export type TaskFields = {
  readonly title?: string | undefined;
  readonly brief?: string | undefined;
  readonly project?: KinRecordKey | null | undefined;
  readonly client?: KinRecordKey | null | undefined;
  readonly due?: string | null | undefined;
  readonly alsoOn?: ReadonlyArray<string> | undefined;
};
const principals = (holder: TasksKeyHolder, names: ReadonlyArray<string> | undefined) =>
  names === undefined ? Effect.undefined : Effect.forEach(names, (name) => whoNamed(holder, name));

/**
 * A new task, as the person makes one in the app: given to a holder by name (the person when
 * none), who is told as from the app. The same request again from this key is the same task.
 */
export const createTask = Effect.fn("KinTasksKey.createTask")(function* (
  holder: TasksKeyHolder,
  input: TaskFields & { readonly title: string; readonly holder?: string | undefined },
) {
  const { connection, people } = asPerson(holder);
  const owner: KinWorkPrincipal | undefined =
    input.holder === undefined ? undefined : yield* whoNamed(holder, input.holder);
  const alsoOn = yield* principals(holder, input.alsoOn);
  const project = yield* reachable(holder, input.project);
  const party = yield* reachable(holder, input.client);
  const request = {
    title: input.title,
    ...(input.brief === undefined ? {} : { notes: input.brief }),
    ...(owner === undefined ? {} : { owner }),
    ...(project === undefined || project === null ? {} : { project }),
    ...(party === undefined || party === null ? {} : { party }),
    ...(input.due === undefined || input.due === null ? {} : { dueAt: input.due, dueAllDay: true }),
    ...(alsoOn === undefined ? {} : { alsoOn }),
  };
  const made = yield* create(
    people,
    { orgId: holder.orgId, clientRequestId: requestIdOf(holder, "task", request), ...request },
    { ...connection, names: named(project, party) },
  ).pipe(workFailure);
  return yield* sheetOf(holder, made.key);
});

/**
 * Changes a task as the person's screen may, and gives it to someone else by name; who it was
 * given to is told as from the app. A field left out stays as it is.
 */
export const updateTask = Effect.fn("KinTasksKey.updateTask")(function* (
  holder: TasksKeyHolder,
  input: TaskFields & { readonly key: KinRecordKey; readonly holder?: string | undefined },
) {
  const { connection, people } = asPerson(holder);
  const to = input.holder === undefined ? undefined : yield* whoNamed(holder, input.holder);
  const alsoOn = yield* principals(holder, input.alsoOn);
  const project = yield* reachable(holder, input.project);
  const party = yield* reachable(holder, input.client);
  const patch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.brief === undefined ? {} : { notes: input.brief }),
    ...(project === undefined ? {} : { project }),
    ...(party === undefined ? {} : { party }),
    ...due(input.due),
    ...(alsoOn === undefined ? {} : { alsoOn }),
  };
  if (Object.keys(patch).length === 0 && to === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "Nothing to change: give a field to change or someone to give it to.",
    });
  yield* updateAndGive(people, { orgId: holder.orgId, key: input.key, ...patch }, to, {
    ...connection,
    names: named(project, party),
  }).pipe(workFailure);
  return yield* sheetOf(holder, input.key);
});

export type ProjectFields = {
  readonly title?: string | undefined;
  readonly client?: KinRecordKey | null | undefined;
  readonly lead?: string | undefined;
  readonly target?: string | null | undefined;
  readonly notes?: string | undefined;
};
const projectPatch = Effect.fn("KinTasksKey.projectPatch")(function* (
  holder: TasksKeyHolder,
  input: ProjectFields,
) {
  const party = yield* reachable(holder, input.client);
  const owner = input.lead === undefined ? undefined : yield* whoNamed(holder, input.lead);
  return {
    ...(input.title === undefined ? {} : { name: input.title }),
    ...(party === undefined ? {} : { party }),
    ...(owner === undefined ? {} : { owner }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
});
const target = (day: string | null | undefined) =>
  day === undefined
    ? {}
    : day === null
      ? { targetAt: null }
      : { targetAt: day, targetAllDay: true };

/** A new project, as the person's Projects screen makes one; the same request again is the same. */
export const createProject = Effect.fn("KinTasksKey.createProject")(function* (
  holder: TasksKeyHolder,
  input: ProjectFields & { readonly title: string },
) {
  const { party, ...patch } = yield* projectPatch(holder, input);
  const request = {
    ...patch,
    name: input.title,
    ...(party === undefined || party === null ? {} : { party }),
    ...(input.target === undefined || input.target === null
      ? {}
      : { targetAt: input.target, targetAllDay: true }),
  };
  return yield* keyed(holder, (people) =>
    Clients.createProject(people, {
      orgId: holder.orgId,
      clientRequestId: requestIdOf(holder, "project", request),
      ...request,
    }),
  );
});

/** Changes a project as the person's project page may, at its revision now. */
export const updateProject = Effect.fn("KinTasksKey.updateProject")(function* (
  holder: TasksKeyHolder,
  input: ProjectFields & {
    readonly key: KinRecordKey;
    readonly state?: "open" | "done" | undefined;
  },
) {
  yield* reachKey(holder, input.key);
  const patch = yield* projectPatch(holder, input);
  return yield* keyed(holder, (people) =>
    Effect.gen(function* () {
      const page = yield* Clients.project(people, { orgId: holder.orgId, key: input.key });
      return yield* Clients.updateProject(people, {
        orgId: holder.orgId,
        key: input.key,
        rev: page.project.rev,
        ...patch,
        ...target(input.target),
        ...(input.state === undefined ? {} : { state: input.state }),
      });
    }),
  );
});
