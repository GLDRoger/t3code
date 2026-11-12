import {
  KinChatError,
  type KinAgentId,
  type KinEvent,
  type KinOrgId,
  type KinWorkerId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sensitiveNow } from "./recordRows.ts";

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
  /** GitHub's visibility of the repository as Kin last read it, for `reviewedSha`. */
  readonly visibility: Visibility | null;
  readonly reviewedSha: string | null;
  readonly filesJson: string | null;
  /** Sticky: the repository was ever public or unreadable, or the work ever sensitive. */
  readonly publicAt: number | null;
  readonly sensitiveAt: number | null;
  /** The commit and title held for the owner, and the card that asks them. */
  readonly readyAt: number | null;
  readonly readySha: string | null;
  readonly readyTitle: string | null;
  readonly readyCardId: string | null;
  /** The owner's tap, bound to one commit and one title of this attempt. */
  readonly approvedSha: string | null;
  readonly approvedTitle: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  readonly declinedBy: string | null;
  readonly declinedAt: number | null;
};
export type Visibility = "public" | "private" | "unknown";
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
    unchecked_at AS "uncheckedAt", noticed_at AS "noticedAt", visibility,
    reviewed_sha AS "reviewedSha", files_json AS "filesJson", public_at AS "publicAt",
    sensitive_at AS "sensitiveAt", ready_at AS "readyAt", ready_sha AS "readySha",
    ready_title AS "readyTitle", ready_card_id AS "readyCardId", approved_sha AS "approvedSha",
    approved_title AS "approvedTitle", approved_by AS "approvedBy", approved_at AS "approvedAt",
    declined_by AS "declinedBy", declined_at AS "declinedAt"
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
  // The wake-up that starts it, or an entry a retry or follow-up already serves, may be sensitive.
  yield* noteSensitivity(attempt);
});

/** The row for an attempt started before K061: every later one is written as it begins. */
const ensure = (sql: SqlClient.SqlClient, attempt: Attempt) =>
  sql`INSERT INTO kin_worker_attempts (org_id, worker_id, started_at, agent_id, legacy)
    SELECT org_id, worker_id, started_at, agent_id, 1 FROM kin_workers
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
      withdrawn_at, stopped_at, stop_reason, stop_key, stop_label, stop_state, legacy)
    SELECT k.org_id, k.worker_id, k.started_at, k.agent_id, ${input.at},
      CASE WHEN k.ended_at IS NULL THEN ${input.at} END,
      CASE WHEN k.ended_at IS NULL THEN ${WITHDRAWN_REASON} END,
      CASE WHEN k.ended_at IS NULL THEN 'kin-withdrawn:' || k.worker_id || ':' || ${input.seq} END,
      CASE WHEN k.ended_at IS NULL THEN ${input.key} END,
      CASE WHEN k.ended_at IS NULL THEN 'pending' END, 1
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
 * In a write's transaction: whether the attempt's work is sensitive now, through an entry it is an
 * attempt at, or a wake-up that started or followed it up having been shown a sensitive entry. A
 * legacy attempt (pre-K061) can't show what started it, so it counts as sensitive.
 * Once true it stays true on the row, so detaching or relabelling mid-run changes nothing.
 */
export const noteSensitivity = Effect.fn("KinWorkerAttempts.noteSensitivity")(function* (
  attempt: Attempt,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_worker_attempts SET sensitive_at = ${at}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt} AND sensitive_at IS NULL AND (legacy = 1
        OR EXISTS (SELECT 1 FROM kin_record_links l
          JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
          WHERE l.org_id = ${attempt.orgId} AND l.kind = 'worker' AND l.target = ${attempt.workerId}
            AND ${sensitiveNow(sql)})
        OR EXISTS (SELECT 1 FROM kin_workers k
          JOIN kin_wakeup_sensitive_reads w ON w.org_id = k.org_id AND w.wakeup_id = k.wakeup_id
          WHERE k.org_id = ${attempt.orgId} AND k.worker_id = ${attempt.workerId})
        OR EXISTS (SELECT 1 FROM kin_events e
          JOIN kin_wakeup_sensitive_reads w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
          WHERE e.org_id = ${attempt.orgId} AND e.event_id = kin_worker_attempts.source_event_id))`;
});

/**
 * What the publisher found before any write reaches GitHub: the repository's visibility then and
 * the commit and files it would publish. Public or unreadable sticks for the attempt.
 */
export const recordReview = Effect.fn("KinWorkerAttempts.recordReview")(function* (
  attempt: Attempt,
  review: { readonly sha: string; readonly visibility: Visibility; readonly filesJson: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* ensure(sql, attempt);
  yield* sql`UPDATE kin_worker_attempts SET visibility = ${review.visibility},
      reviewed_sha = ${review.sha}, files_json = ${review.filesJson},
      public_at = CASE WHEN ${review.visibility} = 'private' THEN public_at
        ELSE COALESCE(public_at, ${at}) END
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt}`;
});

export type GateReason = "public_repository" | "visibility_unknown" | "sensitive_work";
/** Why the owner must publish this commit, or none when it publishes on its own. */
const gateReasons = (row: AttemptRow, sha: string): ReadonlyArray<GateReason> => {
  const reasons: Array<GateReason> = [];
  // Read for another commit, or never read: unknown, which counts as public.
  const seen = row.reviewedSha === sha ? row.visibility : null;
  if (seen === "public") reasons.push("public_repository");
  else if (seen !== "private") reasons.push("visibility_unknown");
  else if (row.publicAt !== null) reasons.push("public_repository");
  if (row.sensitiveAt !== null) reasons.push("sensitive_work");
  return reasons;
};

export type WriteAdmission =
  | { readonly _tag: "admitted" }
  | { readonly _tag: "refused" }
  | { readonly _tag: "declined" }
  /** Held for the owner; `previousCardId` is a card this commit or title replaces. */
  | {
      readonly _tag: "held";
      readonly row: AttemptRow;
      readonly reasons: ReadonlyArray<GateReason>;
      readonly previousCardId: string | null;
    };

/**
 * One transaction before a publish write, ordered by the database against a stop: refused when the
 * attempt is stopped or not the worker's open one. A gated push or PR also needs the owner's
 * approval of exactly this commit and title; otherwise the attempt is held and other approvals void.
 */
export const beginWrite = Effect.fn("KinWorkerAttempts.beginWrite")(function* (
  attempt: Attempt,
  intent: { readonly step: PublishStep; readonly sha: string | null },
  /** The pull request's title as this publish would write it. */
  title: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [worker] = yield* sql<{ startedAt: number; endedAt: number | null }>`SELECT
      started_at AS "startedAt", ended_at AS "endedAt" FROM kin_workers
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId} ORDER BY worker_id`;
  const refused = { _tag: "refused" } as const;
  if (worker === undefined || worker.endedAt !== null || worker.startedAt !== attempt.startedAt)
    return refused;
  yield* ensure(sql, attempt);
  yield* noteSensitivity(attempt);
  const row = yield* attemptOf(attempt);
  if (row === undefined || row.stoppedAt !== null) return refused;
  if (intent.step !== "commit") {
    if (intent.sha === null) return refused;
    const reasons = gateReasons(row, intent.sha);
    if (reasons.length > 0) {
      if (row.declinedAt !== null) return { _tag: "declined" } as const;
      if (row.approvedSha !== intent.sha || row.approvedTitle !== title) {
        const same = row.readySha === intent.sha && row.readyTitle === title;
        const at = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_worker_attempts SET ready_sha = ${intent.sha},
            ready_title = ${title}, ready_at = ${same ? row.readyAt : at},
            approved_sha = NULL, approved_title = NULL, approved_by = NULL, approved_at = NULL
          WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
            AND started_at = ${attempt.startedAt}`;
        const held = yield* attemptOf(attempt);
        return {
          _tag: "held",
          row: held!,
          reasons,
          previousCardId: same ? null : row.readyCardId,
        } as const;
      }
    }
  }
  yield* sql`UPDATE kin_worker_attempts SET intent = ${intent.step}, intent_sha = ${intent.sha}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt}`;
  return { _tag: "admitted" } as const;
});

/** In the card write's transaction: the card that now asks the owner about this attempt. */
export const readyCard = Effect.fn("KinWorkerAttempts.readyCard")(function* (
  attempt: Attempt,
  cardId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_worker_attempts SET ready_card_id = ${cardId}
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
      AND started_at = ${attempt.startedAt}`;
});

/** The attempt a publish card asks about, found by the card's id. */
export const attemptOfCard = Effect.fn("KinWorkerAttempts.attemptOfCard")(function* (
  orgId: KinOrgId,
  cardId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<Attempt>`SELECT org_id AS "orgId", worker_id AS "workerId",
      started_at AS "startedAt" FROM kin_worker_attempts
    WHERE org_id = ${orgId} AND ready_card_id = ${cardId} ORDER BY worker_id`;
  return found;
});

export type Decision =
  | { readonly _tag: "decided" }
  /** The card no longer describes what Kin holds: another commit, title or attempt since. */
  | { readonly _tag: "stale" }
  | { readonly _tag: "stopped" };

/**
 * In the owner's tap's transaction: their decision on exactly the commit and title the card shows,
 * while the attempt still holds them, is open, and nothing was decided. Publish is single-use: it
 * names one commit and one title, and anything else voids it.
 */
export const decide = Effect.fn("KinWorkerAttempts.decide")(function* (
  attempt: Attempt,
  input: {
    readonly cardId: string;
    readonly sha: string;
    readonly title: string;
    readonly publish: boolean;
    readonly personId: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const [worker] = yield* sql<{ startedAt: number; endedAt: number | null }>`SELECT
      started_at AS "startedAt", ended_at AS "endedAt" FROM kin_workers
    WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId} ORDER BY worker_id`;
  const row = yield* attemptOf(attempt);
  if (row === undefined) return { _tag: "stale" } as Decision;
  if (row.stoppedAt !== null) return { _tag: "stopped" } as Decision;
  if (
    worker === undefined ||
    worker.endedAt !== null ||
    worker.startedAt !== attempt.startedAt ||
    row.readyCardId !== input.cardId ||
    row.readySha !== input.sha ||
    row.readyTitle !== input.title ||
    row.approvedAt !== null ||
    row.declinedAt !== null
  )
    return { _tag: "stale" } as Decision;
  const at = yield* Clock.currentTimeMillis;
  const where = sql`WHERE org_id = ${attempt.orgId} AND worker_id = ${attempt.workerId}
    AND started_at = ${attempt.startedAt} AND stopped_at IS NULL`;
  yield* input.publish
    ? sql`UPDATE kin_worker_attempts SET approved_sha = ${input.sha},
        approved_title = ${input.title}, approved_by = ${input.personId}, approved_at = ${at}
        ${where}`
    : sql`UPDATE kin_worker_attempts SET declined_by = ${input.personId}, declined_at = ${at}
        ${where}`;
  return { _tag: "decided" } as Decision;
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
 * Whether the owner withdrew work this event started: the event itself, or one of its wake-up
 * naming the same chat message (a tap or reaction on it, or the message again).
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
  // A withdrawn legacy attempt names no event, so no event this lead received before that
  // withdrawal authorises any work again, wherever it is claimed and whatever entry it names; an
  // event not found counts as received before. A fresh message or assignment is needed.
  same.push(sql`(a.source_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM kin_events r
    WHERE r.org_id = a.org_id AND r.agent_id = a.agent_id AND r.event_id = ${event.eventId}
      AND r.received_at > a.withdrawn_at AND r.queued_at > a.withdrawn_at))`);
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

/**
 * The lead's wake-up was shown a sensitive Work entry: any worker it starts or follows up counts as
 * sensitive work, named entry or not (`noteSensitivity`).
 */
export const sensitiveShown = Effect.fn("KinWorkerAttempts.sensitiveShown")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
    VALUES (${input.orgId}, ${input.wakeupId}, ${at}) ON CONFLICT (org_id, wakeup_id) DO NOTHING`;
});

/** A refusal that quotes something sensitive, so the tool marks the turn as a result would. */
export class SensitiveRefusal extends KinChatError {}
// @effect-diagnostics-next-line instanceOfSchema:off -- the subclass, not the schema, marks it.
export const isSensitiveRefusal = (error: unknown) => error instanceof SensitiveRefusal;

/** The same for a prompt that shows these entries, when any of them is sensitive now. */
export const entriesShown = Effect.fn("KinWorkerAttempts.entriesShown")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly recordIds: ReadonlyArray<string>;
  readonly keys: ReadonlyArray<string>;
}) {
  if (input.recordIds.length === 0 && input.keys.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const named = [
    ...(input.recordIds.length === 0 ? [] : [sql`r.record_id IN ${sql.in(input.recordIds)}`]),
    ...(input.keys.length === 0 ? [] : [sql`r.key IN ${sql.in(input.keys)}`]),
  ];
  const found = yield* sql`SELECT 1 FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND ${sql.or(named)} AND ${sensitiveNow(sql)} LIMIT 1`;
  if (found.length > 0) yield* sensitiveShown(input);
});

/** Whether a tool result carries an entry marked sensitive anywhere in it. */
export const showsSensitive = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(showsSensitive)
    : typeof value === "object" && value !== null
      ? Reflect.get(value, "sensitive") === true || Object.values(value).some(showsSensitive)
      : false;
