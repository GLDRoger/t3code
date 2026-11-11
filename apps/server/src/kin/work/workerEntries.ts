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

/** After a run ends: its PR is linked; a run that failed or was stopped leaves the work open. */
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
    else if (input.status !== "completed")
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
