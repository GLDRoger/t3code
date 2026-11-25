import { KinChatError, KinEvent, KinEventId, type KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { type QuestionRow, readQuestion } from "./openQuestions.ts";

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The wake-up a dismissal queues for its asker: one per dismissal, by when it closed. */
const dismissedEventId = (orgId: KinOrgId, questionId: string, at: number) =>
  KinEventId.make(`question_${hash(`${orgId}\0${questionId}\0${at}\0dismissed`).slice(0, 32)}`);

const notNow = new KinChatError({
  reason: "conflict",
  message: "That couldn't be done just now, so nothing changed. Try again.",
});

const tell = Effect.fn("KinQuestionDismissed.tell")(function* (
  orgId: KinOrgId,
  row: QuestionRow,
  at: number,
  now: number,
  kind: "dismissed" | "reopened",
) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ ownerChatId: string }>`SELECT owner_chat_id AS "ownerChatId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${row.agentId}`;
  const event = yield* decodeEvent({
    _tag: "deferral.due",
    eventId:
      kind === "dismissed"
        ? dismissedEventId(orgId, row.questionId, at)
        : KinEventId.make(
            `question_${hash(`${orgId}\0${row.questionId}\0${at}\0reopened`).slice(0, 32)}`,
          ),
    orgId,
    agentId: row.agentId,
    receivedAt: iso(now),
    provenance: { _tag: "system" },
    dedupeKey: `question-${kind}:${row.questionId}:${at}`,
    subject: {
      type: "question",
      questionId: row.questionId,
      dismissed: true,
      ...(kind === "reopened" ? { reopened: true } : {}),
      at,
    },
    lateByMs: 0,
    ...(lead === undefined || lead.ownerChatId === row.chatId
      ? {}
      : { origin: { agentId: row.agentId, chatId: row.chatId, personId: row.personId } }),
  }).pipe(Effect.orDie);
  // A retired asker has no turn to tell; anything else rolls the whole tap back.
  yield* (yield* KinEventQueue.KinEventQueue).enqueue(event).pipe(
    Effect.catchTags({
      KinEventQueueRetiredAgent: () => Effect.void,
      KinEventQueueUnknownAgent: () => Effect.void,
      KinEventQueueConflict: () => Effect.fail(notNow),
      KinEventQueueUnknownEvent: () => Effect.fail(notNow),
    }),
  );
});

/**
 * The person an open question asks dismissed its card without choosing: it closes as dismissed,
 * so nothing at its day takes a default or raises it again, and its asker is woken once to hear
 * it. Undefined when the card asks no stored question, such as one in a group chat.
 */
export const dismissQuestion = Effect.fn("KinQuestionDismissed.dismiss")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [moved] = yield* sql<{ questionId: string }>`UPDATE kin_questions
    SET state = 'dismissed', closed_at = ${input.now}
    WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND state = 'open'
      AND (widget_id = ${input.widgetId} OR raise_widget_id = ${input.widgetId})
    RETURNING question_id AS "questionId"`;
  if (moved === undefined) return undefined;
  const row = yield* readQuestion(input.orgId, moved.questionId);
  if (row === undefined) return undefined;
  yield* tell(input.orgId, row, input.now, input.now, "dismissed");
  return row;
});

/**
 * The dismisser's Undo: the question opens again as it was, while it is still the dismissal they
 * made. Its asker's wake-up is withdrawn when it hasn't started; once it has, the asker hears
 * once more, quietly, that the question is open again. Refused once it closed another way.
 */
export const undismissQuestion = Effect.fn("KinQuestionDismissed.undismiss")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly dismissedAt: number;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [asked] = yield* sql<{ questionId: string; state: string; closedAt: number | null }>`
    SELECT question_id AS "questionId", state, closed_at AS "closedAt" FROM kin_questions
    WHERE org_id = ${input.orgId} AND person_id = ${input.personId}
      AND (widget_id = ${input.widgetId} OR raise_widget_id = ${input.widgetId})
    ORDER BY asked_at DESC, question_id LIMIT 1`;
  if (asked === undefined) return undefined;
  if (asked.state !== "dismissed" || asked.closedAt !== input.dismissedAt)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That question was settled another way since, so it can't be opened again.",
    });
  yield* sql`UPDATE kin_questions SET state = 'open', closed_at = NULL
    WHERE org_id = ${input.orgId} AND question_id = ${asked.questionId} AND state = 'dismissed'
      AND closed_at = ${input.dismissedAt}`;
  const withdrawn = yield* sql`UPDATE kin_events SET state = 'expired'
    WHERE org_id = ${input.orgId}
      AND event_id = ${dismissedEventId(input.orgId, asked.questionId, input.dismissedAt)}
      AND state = 'queued'
    RETURNING event_id`;
  const row = yield* readQuestion(input.orgId, asked.questionId);
  if (withdrawn.length === 0 && row !== undefined)
    yield* tell(input.orgId, row, input.dismissedAt, input.now, "reopened");
  return row;
});

/**
 * Whether a dismissal's wake-up no longer stands when its turn starts: the question is not, or no
 * longer, the dismissal it was queued for. A reopened one always stands.
 */
export const dismissalGone = Effect.fn("KinQuestionDismissed.gone")(function* (
  orgId: KinOrgId,
  subject: {
    readonly questionId: string;
    readonly reopened?: true | undefined;
    readonly at?: number | undefined;
  },
) {
  if (subject.reopened === true) return false;
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ state: string; closedAt: number | null }>`SELECT state,
      closed_at AS "closedAt" FROM kin_questions
    WHERE org_id = ${orgId} AND question_id = ${subject.questionId}`;
  return row === undefined || row.state !== "dismissed" || row.closedAt !== subject.at;
});
