import type {
  KinAgentId,
  KinAuthor,
  KinChatId,
  KinEvent,
  KinOrgId,
  KinPersonId,
  KinWorkerId,
  OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";
import { eventWithdrawn, workerMayResume, workerWithdrawn } from "./workerAttempts.ts";

/**
 * Work entries moved by code from worker and pull request events, never by a model: a worker is an
 * attempt at an entry, so starting one makes or moves its entry, and its merge closes it.
 */

const byWorker = (via: Writer["via"]): Writer => ({ actor: { _tag: "system" }, via });

/** Entries a worker is an attempt at. */
const entriesOf = Effect.fn("KinWorkEntries.entriesOf")(function* (
  orgId: KinOrgId,
  workerId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ recordId: string; key: string; state: string; originKey: string }>`
    SELECT r.record_id AS "recordId", r.key, r.state, r.origin_key AS "originKey"
    FROM kin_record_links l JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE l.org_id = ${orgId} AND l.kind = 'worker' AND l.target = ${workerId}
    ORDER BY r.record_id`;
});

/** Whether another worker's attempt at the entry is still open. */
const othersAt = Effect.fn("KinWorkEntries.othersAt")(function* (
  input: { readonly orgId: KinOrgId; readonly workerId: KinWorkerId },
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* sql`SELECT 1 FROM kin_record_links l
    JOIN kin_workers k ON k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.org_id = ${input.orgId} AND l.record_id = ${recordId} AND l.kind = 'worker'
      AND k.worker_id != ${input.workerId} AND k.ended_at IS NULL
    ORDER BY k.worker_id LIMIT 1`;
  return open.length > 0;
});

/** What a lead hears when the entry or event it started work from no longer gives it the work. */
export const WORK_NOT_YOURS =
  "That Work entry is closed or isn't yours now, so nothing started. Don't start work on it unless the owner gives it to you again.";

/**
 * In the worker row's transaction: whether the turn's event and named entry still let this lead
 * start work. An event whose work the owner withdrew authorises nothing again; a record event only
 * while the owner's assignment of that open entry stands; a report only from a worker the owner
 * never withdrew; a named entry must be open and this lead's.
 */
export const workMayStart = Effect.fn("KinWorkEntries.workMayStart")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly ownerPersonId: string;
  /** The turn's wake-up, which the event belongs to. */
  readonly wakeupId: string;
  readonly event: KinEvent;
  readonly entryKey?: string;
  /** A follow-up or restart of this worker, which `workerMayResume` must allow. */
  readonly followsUp?: KinWorkerId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const held = (row: EntryRow | undefined) =>
    row !== undefined &&
    row.state !== "done" &&
    row.state !== "dropped" &&
    row.ownerKind === "agent" &&
    row.ownerId === input.agentId;
  if (yield* eventWithdrawn(input)) return false;
  if (input.event._tag === "record.changed") {
    if (input.event.reason !== "assigned") return false;
    const [row] = yield* sql<EntryRow>`${entryColumns(sql)}
      WHERE org_id = ${input.orgId} AND record_id = ${input.event.recordId} ORDER BY record_id`;
    if (!held(row) || row?.assignedBy !== input.ownerPersonId) return false;
  }
  if (
    input.event._tag === "worker.report" &&
    (yield* workerWithdrawn({ orgId: input.orgId, workerId: input.event.workerId }))
  )
    return false;
  if (
    input.followsUp !== undefined &&
    !(yield* workerMayResume({ ...input, workerId: input.followsUp }))
  )
    return false;
  if (input.entryKey !== undefined) {
    const [row] = yield* sql<EntryRow>`${entryColumns(sql)}
      WHERE org_id = ${input.orgId} AND key = ${input.entryKey} ORDER BY record_id`;
    // An unknown key starts a new entry of the lead's, as `workerStarted` does.
    if (row !== undefined && !held(row)) return false;
  }
  return true;
});
type EntryRow = {
  readonly state: string;
  readonly ownerKind: string;
  readonly ownerId: string;
  readonly assignedBy: string | null;
};
const entryColumns = (sql: SqlClient.SqlClient) =>
  sql`SELECT state, owner_kind AS "ownerKind", owner_id AS "ownerId",
    assigned_by_person_id AS "assignedBy" FROM kin_records`;

/**
 * In the worker row's transaction: the entry it serves, made when it names none. A review is an
 * attempt at the entry of the work it reviews and moves nothing.
 */
export const workerStarted = Effect.fn("KinWorkEntries.workerStarted")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly workerId: KinWorkerId;
  readonly wakeupId: string;
  readonly title: string;
  readonly reviewOf?: KinWorkerId | null;
  readonly event: KinEvent;
  readonly entryKey?: string;
}) {
  const records = yield* KinRecords;
  const attempt = {
    kind: "worker" as const,
    target: input.workerId,
    relation: "attempt" as const,
    label: input.title.slice(0, 280),
  };
  const lead: Writer = {
    actor: { _tag: "agent", agentId: input.agentId },
    via: "worker",
    wakeupId: input.wakeupId,
    ...(chatOf(input.event) === undefined ? {} : { chatId: chatOf(input.event)! }),
  };
  if (input.reviewOf !== undefined && input.reviewOf !== null) {
    for (const entry of yield* entriesOf(input.orgId, input.reviewOf))
      yield* records.link(input.orgId, lead, entry.recordId, attempt);
    return;
  }
  if (input.entryKey !== undefined) {
    const entry = yield* records.get(input.orgId, input.entryKey);
    if (entry !== undefined) {
      yield* records.link(input.orgId, lead, entry.recordId, attempt);
      if (entry.state === "open" || entry.state === "waiting")
        yield* records.update(input.orgId, byWorker("worker"), entry.key, { state: "doing" });
      return;
    }
  }
  const source =
    input.event._tag === "chat.message" || input.event._tag === "widget.action"
      ? { chatId: input.event.chatId, messageId: input.event.messageId }
      : undefined;
  yield* records.create(
    input.orgId,
    { ...lead, askedBy: humanOf(input.event.provenance) },
    {
      originKey: `worker:${input.workerId}`,
      title: input.title.trim().slice(0, 280) || "Coding task",
      state: "doing",
      owner: { _tag: "agent", agentId: input.agentId },
      category: "task",
      ...(source === undefined ? {} : { source }),
      links: [attempt],
    },
  );
});

/**
 * After a run ends: its PR is linked; a run that failed or was stopped leaves the work open,
 * unless another attempt at it is still running.
 */
export const workerEnded = Effect.fn("KinWorkEntries.workerEnded")(function* (input: {
  readonly orgId: KinOrgId;
  readonly workerId: KinWorkerId;
  readonly kind: string;
  readonly status: OrchestrationV2RunStatus;
  readonly pullRequest: { readonly url: string; readonly number: number } | null;
}) {
  const records = yield* KinRecords;
  const writer = byWorker("worker");
  for (const entry of yield* entriesOf(input.orgId, input.workerId)) {
    if (input.pullRequest !== null)
      yield* records.link(input.orgId, writer, entry.recordId, {
        kind: "pull_request",
        target: input.pullRequest.url,
        relation: "relates",
        label: `PR #${input.pullRequest.number}`,
      });
    if (entry.state !== "doing") continue;
    // Research is done when it reports; built work is done when its PR merges.
    if (
      input.status === "completed" &&
      input.kind === "research" &&
      entry.originKey === `worker:${input.workerId}`
    )
      yield* records.update(input.orgId, writer, entry.key, { state: "done" });
    else if (input.status !== "completed" && !(yield* othersAt(input, entry.recordId)))
      yield* records.update(input.orgId, writer, entry.key, { state: "open" });
  }
});

/**
 * A merged pull request closes every entry linked to it, directly or through the worker that
 * opened it, with the merge as evidence. No lead turn is involved.
 */
export const pullRequestMerged = Effect.fn("KinWorkEntries.pullRequestMerged")(function* (input: {
  readonly orgId: KinOrgId;
  readonly repo: string;
  readonly number: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const url = `https://github.com/${input.repo}/pull/${input.number}`;
  const rows = yield* sql<{ recordId: string; key: string; state: string }>`
    SELECT DISTINCT r.record_id AS "recordId", r.key, r.state FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND (
      EXISTS (SELECT 1 FROM kin_record_links l WHERE l.org_id = r.org_id
        AND l.record_id = r.record_id AND l.kind = 'pull_request' AND lower(l.target) = lower(${url}))
      OR EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_workers k
          ON k.org_id = l.org_id AND k.worker_id = l.target
        WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'worker'
          AND lower(k.repository_key) = lower(${`github.com/${input.repo}`})
          AND k.pull_request_number = ${input.number}))
    ORDER BY r.record_id`;
  const writer = byWorker("github");
  for (const row of rows) {
    yield* records.link(input.orgId, writer, row.recordId, {
      kind: "pull_request",
      target: url,
      relation: "evidence",
      label: `PR #${input.number} merged`,
    });
    if (row.state !== "done" && row.state !== "dropped")
      yield* records.update(input.orgId, writer, row.key, { state: "done" });
  }
  return rows.length;
});

const chatOf = (event: KinEvent): KinChatId | undefined =>
  "chatId" in event && typeof event.chatId === "string" ? event.chatId : undefined;
const humanOf = (author: KinAuthor): KinPersonId | null =>
  author._tag === "human" ? author.personId : null;
