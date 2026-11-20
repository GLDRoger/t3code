import type { KinRecord, KinRecordDetail } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { CodingAgentConnection } from "../work/codingAgent.ts";
import { dayIn } from "../work/money.ts";
import { latestComments, personSeesRecord } from "../work/recordComments.ts";
import { effectivelySensitive, ownerZone } from "../work/recordRows.ts";

/**
 * Everything a person's coding agent is told, built here and only here from what a Work method
 * returned: an allowlist of fields, never the screen's object. A reference is named only if the
 * person reaches it now and it isn't labelled sensitive. Reads run in the caller's transaction.
 */

const COMMENTS_SHOWN = 10;

type Task = Pick<
  KinRecord,
  "recordId" | "key" | "title" | "state" | "dueAt" | "dueAllDay" | "project"
>;

/** The project's title, if the person reaches that project now and it isn't sensitive. */
const projectNamed = Effect.fn("KinYouProjection.projectNamed")(function* (
  connection: CodingAgentConnection,
  task: Task,
) {
  if (task.project === undefined || task.project === null) return null;
  const { recordId, title } = task.project;
  if (!(yield* personSeesRecord(connection.orgId, connection.personId, recordId))) return null;
  return (yield* effectivelySensitive(connection.orgId, recordId)) === false ? title : null;
});

const row = Effect.fn("KinYouProjection.row")(function* (
  connection: CodingAgentConnection,
  task: Task,
  zone: string,
) {
  return {
    key: task.key,
    title: task.title,
    state: task.state,
    due:
      task.dueAt === null
        ? null
        : task.dueAllDay
          ? dayIn(Date.parse(task.dueAt), zone)
          : task.dueAt,
    project: yield* projectNamed(connection, task),
  };
});

/** `list_my_tasks`: the rows `Work.list` gave, as `{ key, title, state, due, project }`. */
export const taskRows = Effect.fn("KinYouProjection.taskRows")(function* (
  connection: CodingAgentConnection,
  tasks: ReadonlyArray<Task>,
  more: boolean,
) {
  const zone = yield* ownerZone(connection.orgId);
  return {
    tasks: yield* Effect.forEach(tasks, (task) => row(connection, task, zone)),
    more,
  };
});

/** `get_task` and `set_task_state`: the row, its brief and its newest comments, by name. */
export const taskSheet = Effect.fn("KinYouProjection.taskSheet")(function* (
  connection: CodingAgentConnection,
  task: Task & Pick<KinRecordDetail, "notes">,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, personId } = connection;
  const shown = (yield* latestComments(orgId, task.recordId, COMMENTS_SHOWN)).comments;
  const idOf = (one: (typeof shown)[number]) =>
    one.by._tag === "person" ? one.by.personId : one.by.agentId;
  const ids = [...new Set(shown.map(idOf))];
  const names = new Map(
    ids.length === 0
      ? []
      : (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
            FROM kin_people WHERE org_id = ${orgId} AND person_id IN ${sql.in(ids)}
          UNION ALL SELECT agent_id AS id, display_name AS name
            FROM kin_agents WHERE org_id = ${orgId} AND agent_id IN ${sql.in(ids)}
          ORDER BY id`).map((one) => [one.id, one.name] as const),
  );
  return {
    ...(yield* row(connection, task, yield* ownerZone(orgId))),
    brief: task.notes,
    comments: shown.map((one) => {
      const id = idOf(one);
      return {
        by: id === personId ? "you" : (names.get(id) ?? "someone"),
        at: one.at,
        text: one.body,
      };
    }),
  };
});

/** `comment_on_task`. */
export const commentResult = (key: string, posted: boolean) => ({ key, posted });
