import type { KinAgentId, KinEvent, KinOrgId, KinWorkerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A worker attempt's durable state (`kin_worker_attempts`): its stop, each publish write's intent
 * and outcome, and the owner's notice. Every decision about stopping and publishing reads and
 * writes these rows in one transaction, and SQLite's single writer orders them, so a fresh
 * process over the same database decides exactly what the old one would have.
 */

export const WITHDRAWN_REASON = "The owner closed this work or took it back.";

export type Attempt = {
  readonly orgId: KinOrgId;
  readonly workerId: KinWorkerId;
  readonly startedAt: number;
};
export type PublishStep = "commit" | "push" | "pull_request";
export type AttemptRow = {
  readonly agentId: KinAgentId;
  readonly withdrawnAt: number | null;
  readonly stoppedAt: number | null;
  readonly stopReason: string | null;
  readonly stopKey: string | null;
  /** What the owner calls the work: the entry key of a withdrawal; null for the worker's title. */
  readonly stopLabel: string | null;
  readonly stopState: "pending" | "sent" | "failed" | null;
  /** A write begun and not yet known to have landed or not: ambiguous until reconciled. */
  readonly intent: PublishStep | null;
  readonly intentSha: string | null;
  readonly committedSha: string | null;
  readonly pushedSha: string | null;
  readonly pullRequestNumber: number | null;
  readonly pullRequestUrl: string | null;
  /** A reconciliation couldn't reach GitHub, and the owner was told Kin couldn't check. */
  readonly uncheckedAt: number | null;
  readonly noticedAt: number | null;
};
export type Stop = AttemptRow & {
  readonly stoppedAt: number;
  readonly stopKey: string;
  readonly stopReason: string;
};
export const isStopped = (row: AttemptRow | undefined): row is Stop =>
  row !== undefined && row.stoppedAt !== null;

const selectAttempt = (sql: SqlClient.SqlClient) => sql`SELECT agent_id AS "agentId",
    withdrawn_at AS "withdrawnAt", stopped_at AS "stoppedAt", stop_reason AS "stopReason",
    stop_key AS "stopKey", stop_label AS "stopLabel", stop_state AS "stopState", intent,
    intent_sha AS "intentSha", committed_sha AS "committedSha", pushed_sha AS "pushedSha",
    pull_request_number AS "pullRequestNumber", pull_request_url AS "pullRequestUrl",
    unchecked_at AS "uncheckedAt", noticed_at AS "noticedAt"
  FROM kin_worker_attempts`;

export const attemptOf = Effect.fn("KinWorkerAttempts.attemptOf")(function* (attempt: Attempt) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<AttemptRow>`${selectAttempt(sql)}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt} ORDER BY started_at`;
  return row;
});

/** In the transaction that starts an attempt: the event that authorised it. */
export const attemptBegun = Effect.fn("KinWorkerAttempts.attemptBegun")(function* (
  attempt: Attempt & { readonly agentId: KinAgentId; readonly sourceEventId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id,
      source_event_id)
    VALUES (${attempt.orgId}, ${attempt.workerId}, ${attempt.startedAt}, ${attempt.agentId},
      ${attempt.sourceEventId})
    ON CONFLICT (org_id, worker_id, started_at) DO NOTHING`;
});

/** The row for an attempt started before K061, or one written by a path that names no event. */
const ensure = (sql: SqlClient.SqlClient, attempt: Attempt) =>
  sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id)
    SELECT org_id, worker_id, started_at, agent_id FROM kin_workers
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt}
    ON CONFLICT (org_id, worker_id, started_at) DO NOTHING`;

/**
 * In a transaction, before anything is interrupted: the stop of the worker's current attempt, or
 * of `startedAt` only. The first stop's details stand; a later one changes nothing.
 */
export const stopAttempt = Effect.fn("KinWorkerAttempts.stopAttempt")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly workerId: KinWorkerId;
  readonly startedAt?: number;
  readonly reason: string;
  readonly key: string;
  readonly at: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [worker] = yield* sql<{ startedAt: number; endedAt: number | null }>`SELECT
      started_at AS "startedAt", ended_at AS "endedAt" FROM kin_workers
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND worker_id = ${input.workerId}
    ORDER BY worker_id`;
  if (worker === undefined) return { _tag: "missing" } as const;
  if (worker.endedAt !== null) return { _tag: "ended" } as const;
  // A follow-up since started a newer attempt, which this stop never covered.
  if (input.startedAt !== undefined && input.startedAt !== worker.startedAt)
    return { _tag: "ended" } as const;
  const attempt = { orgId: input.orgId, workerId: input.workerId, startedAt: worker.startedAt };
  yield* ensure(sql, attempt);
  yield* sql`UPDATE kin_worker_attempts SET stopped_at = ${input.at}, stop_reason = ${input.reason},
      stop_key = ${input.key}, stop_state = 'pending'
    WHERE org_id = ${input.orgId} AND worker_id = ${input.workerId}
      AND started_at = ${worker.startedAt} AND stopped_at IS NULL`;
  const row = yield* attemptOf(attempt);
  if (!isStopped(row)) return yield* Effect.die("a stopped attempt has no stop");
  return { _tag: "stopped", startedAt: worker.startedAt, row } as const;
});

/**
 * In the owner's change's transaction: every attempt of the lead's at the entry is withdrawn, and
 * the open ones are stopped. Returns the open ones, which the stop then reaches.
 */
export const withdrawAttempts = Effect.fn("KinWorkerAttempts.withdrawAttempts")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly recordId: string;
  readonly key: string;
  readonly seq: number;
  readonly at: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const open = yield* sql<{ workerId: KinWorkerId; startedAt: number }>`
    SELECT k.worker_id AS "workerId", k.started_at AS "startedAt"
    FROM kin_record_links l JOIN kin_workers k ON k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.org_id = ${input.orgId} AND l.record_id = ${input.recordId} AND l.kind = 'worker'
      AND k.agent_id = ${input.agentId} AND k.ended_at IS NULL
    ORDER BY k.worker_id`;
  yield* sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id,
      withdrawn_at, stopped_at, stop_reason, stop_key, stop_label, stop_state)
    SELECT k.org_id, k.worker_id, k.started_at, k.agent_id, ${input.at},
      CASE WHEN k.ended_at IS NULL THEN ${input.at} END,
      CASE WHEN k.ended_at IS NULL THEN ${WITHDRAWN_REASON} END,
      CASE WHEN k.ended_at IS NULL THEN 'kin-withdrawn:' || k.worker_id || ':' || ${input.seq} END,
      CASE WHEN k.ended_at IS NULL THEN ${input.key} END,
      CASE WHEN k.ended_at IS NULL THEN 'pending' END
    FROM kin_record_links l JOIN kin_workers k ON k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.org_id = ${input.orgId} AND l.record_id = ${input.recordId} AND l.kind = 'worker'
      AND k.agent_id = ${input.agentId}
    ON CONFLICT (org_id, worker_id, started_at) DO UPDATE SET
      withdrawn_at = COALESCE(kin_worker_attempts.withdrawn_at, excluded.withdrawn_at),
      stop_reason = COALESCE(kin_worker_attempts.stop_reason, excluded.stop_reason),
      stop_key = COALESCE(kin_worker_attempts.stop_key, excluded.stop_key),
      stop_label = CASE WHEN kin_worker_attempts.stopped_at IS NULL THEN excluded.stop_label
        ELSE kin_worker_attempts.stop_label END,
      stop_state = COALESCE(kin_worker_attempts.stop_state, excluded.stop_state),
      stopped_at = COALESCE(kin_worker_attempts.stopped_at, excluded.stopped_at)`;
  return open;
});

/**
 * One transaction before a publish write: refused when the attempt is stopped or no longer the
 * worker's open one, otherwise the write's intent is recorded. "stopped" and "admitted" are then
 * strictly ordered by the database, whichever process asks.
 */
export const beginWrite = Effect.fn("KinWorkerAttempts.beginWrite")(function* (
  attempt: Attempt,
  intent: { readonly step: PublishStep; readonly sha: string | null },
) {
  const sql = yield* SqlClient.SqlClient;
  const [worker] = yield* sql<{ startedAt: number; endedAt: number | null }>`SELECT
      started_at AS "startedAt", ended_at AS "endedAt" FROM kin_workers
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId} ORDER BY worker_id`;
  if (worker === undefined || worker.endedAt !== null || worker.startedAt !== attempt.startedAt)
    return false;
  yield* ensure(sql, attempt);
  const begun = yield* sql`UPDATE kin_worker_attempts SET intent = ${intent.step},
      intent_sha = ${intent.sha}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt} AND stopped_at IS NULL RETURNING worker_id`;
  return begun.length > 0;
});

export type PublishOutcome =
  | { readonly step: "commit"; readonly sha: string }
  | { readonly step: "push"; readonly sha: string }
  | { readonly step: "pull_request"; readonly url: string; readonly number: number };

/** What a write left, recorded as soon as it is known; its intent, if it had one, is resolved. */
export const recordOutcome = Effect.fn("KinWorkerAttempts.recordOutcome")(function* (
  attempt: Attempt,
  outcome: PublishOutcome,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ensure(sql, attempt);
  const where = sql`WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
    AND started_at = ${attempt.startedAt}`;
  const clear = sql`intent = CASE WHEN intent = ${outcome.step} THEN NULL ELSE intent END,
    intent_sha = CASE WHEN intent = ${outcome.step} THEN NULL ELSE intent_sha END`;
  if (outcome.step === "commit")
    yield* sql`UPDATE kin_worker_attempts SET committed_sha = ${outcome.sha}, ${clear} ${where}`;
  else if (outcome.step === "push")
    yield* sql`UPDATE kin_worker_attempts SET pushed_sha = ${outcome.sha}, ${clear} ${where}`;
  else {
    yield* sql`UPDATE kin_worker_attempts SET pull_request_number = ${outcome.number},
      pull_request_url = ${outcome.url}, ${clear} ${where}`;
    // The worker's card and Work entry show the PR Kin opened.
    yield* sql`UPDATE kin_workers SET pull_request_url = ${outcome.url},
        pull_request_number = ${outcome.number}
      WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}`;
  }
});

/** GitHub as Kin found it for the worker's branch. */
export type Found = {
  readonly branchSha: string | null;
  readonly pullRequest: { readonly url: string; readonly number: number } | null;
};

/**
 * An ambiguous write settled against what GitHub holds: a push landed when the branch is at the
 * sha it pushed, and then any open PR from the branch carries it; a PR create landed when one is
 * open from the branch. A commit never reaches GitHub, so it only clears.
 */
export const recordFound = Effect.fn("KinWorkerAttempts.recordFound")(function* (
  attempt: Attempt,
  found: Found,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* attemptOf(attempt);
  if (row === undefined || row.intent === null) return;
  const pushed =
    row.intent === "push" && row.intentSha !== null && found.branchSha === row.intentSha;
  const carried =
    (pushed || row.intent === "pull_request" || row.pushedSha !== null) &&
    found.pullRequest !== null;
  if (pushed) yield* recordOutcome(attempt, { step: "push", sha: row.intentSha! });
  if (carried) yield* recordOutcome(attempt, { step: "pull_request", ...found.pullRequest! });
  yield* sql`UPDATE kin_worker_attempts SET intent = NULL, intent_sha = NULL
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt}`;
});

/** Claims the owner's one notice for this attempt; false when it was already sent. */
export const claimNotice = Effect.fn("KinWorkerAttempts.claimNotice")(function* (
  attempt: Attempt,
  column: "noticed_at" | "unchecked_at",
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const claimed = yield* sql`UPDATE kin_worker_attempts SET ${sql(column)} = ${at}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt} AND ${sql(column)} IS NULL RETURNING worker_id`;
  return claimed.length > 0;
});

/** Records a stop's send; true when this call moved it from pending, so it alone reports a failure. */
export const stopSent = Effect.fn("KinWorkerAttempts.stopSent")(function* (
  attempt: Attempt,
  state: "sent" | "failed",
) {
  const sql = yield* SqlClient.SqlClient;
  const moved = yield* sql`UPDATE kin_worker_attempts SET stop_state = ${state}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt} AND stop_state = 'pending' RETURNING worker_id`;
  return moved.length > 0;
});

/** Stops stored and never sent, of attempts still open: a process died between the two. */
export const pendingStops = Effect.fn("KinWorkerAttempts.pendingStops")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Attempt>`SELECT a.org_id AS "orgId", a.worker_id AS "workerId",
      a.started_at AS "startedAt" FROM kin_worker_attempts a
    JOIN kin_workers k ON k.org_id = a.org_id AND k.worker_id = a.worker_id
      AND k.started_at = a.started_at AND k.ended_at IS NULL
    WHERE a.stop_state = 'pending' AND a.org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
    ORDER BY a.org_id, a.worker_id`;
});

/**
 * Stopped attempts that still owe the owner the truth: a write whose outcome isn't known, or what
 * reached GitHub not yet said.
 */
export const unsettledStops = Effect.fn("KinWorkerAttempts.unsettledStops")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Attempt>`SELECT org_id AS "orgId", worker_id AS "workerId",
      started_at AS "startedAt" FROM kin_worker_attempts
    WHERE stopped_at IS NOT NULL AND noticed_at IS NULL
      AND (intent IS NOT NULL OR pushed_sha IS NOT NULL OR pull_request_number IS NOT NULL
        OR unchecked_at IS NOT NULL)
      AND org_id IN (SELECT org_id FROM kin_leads GROUP BY org_id)
    ORDER BY org_id, worker_id, started_at`;
});

/**
 * Whether the owner withdrew work this event started. The same authorisation is the event itself,
 * and any event of the wake-up that started that work naming the same chat message (a widget tap
 * or reaction on it, or the message delivered again); other messages are other instructions.
 */
export const eventWithdrawn = Effect.fn("KinWorkerAttempts.eventWithdrawn")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly event: KinEvent;
}) {
  const sql = yield* SqlClient.SqlClient;
  const event = input.event;
  const same = [sql`a.source_event_id = ${event.eventId}`];
  if (
    event._tag === "chat.message" ||
    event._tag === "widget.action" ||
    event._tag === "chat.reaction"
  )
    same.push(sql`(e.wakeup_id = ${input.wakeupId}
      AND json_extract(e.json, '$.chatId') = ${event.chatId}
      AND json_extract(e.json, '$.messageId') = ${event.messageId})`);
  const found = yield* sql`SELECT 1 FROM kin_worker_attempts a
    LEFT JOIN kin_events e ON e.org_id = a.org_id AND e.event_id = a.source_event_id
    WHERE a.org_id = ${input.orgId} AND a.agent_id = ${input.agentId}
      AND a.withdrawn_at IS NOT NULL AND ${sql.or(same)}
    LIMIT 1`;
  return found.length > 0;
});

/** Whether the owner withdrew any attempt of this worker. */
export const workerWithdrawn = Effect.fn("KinWorkerAttempts.workerWithdrawn")(function* (input: {
  readonly orgId: KinOrgId;
  readonly workerId: KinWorkerId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const withdrawn = yield* sql`SELECT 1 FROM kin_worker_attempts
    WHERE org_id = ${input.orgId} AND worker_id = ${input.workerId} AND withdrawn_at IS NOT NULL
    LIMIT 1`;
  return withdrawn.length > 0;
});

/**
 * Whether the worker may run again for this lead: no attempt of it was withdrawn, and every entry
 * it is an attempt at is still open and this lead's.
 */
export const workerMayResume = Effect.fn("KinWorkerAttempts.workerMayResume")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly workerId: KinWorkerId;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (yield* workerWithdrawn(input)) return false;
  const closed = yield* sql`SELECT 1 FROM kin_record_links l
    JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE l.org_id = ${input.orgId} AND l.kind = 'worker' AND l.target = ${input.workerId}
      AND (r.state IN ('done', 'dropped')
        OR NOT (r.owner_kind = 'agent' AND r.owner_id = ${input.agentId}))
    LIMIT 1`;
  return closed.length === 0;
});
