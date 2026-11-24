import {
  KIN_DISMISSED_FIELD,
  KinAgentId,
  KinChatError,
  type KinOrgId,
  type KinPersonId,
  KinWidgetId,
  mentionsKinMoney,
} from "@t3tools/contracts";
import { answerNumbersChange } from "../numbers/answer.ts";
import { shellDecision } from "../shell/changes.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { isPrivateWriteRefused } from "../chat/KinChatRepository.ts";
import {
  type ChoiceAnswerHandler,
  type ChoiceDismissHandler,
  type ChoiceRefusedHandler,
  KinChatService,
} from "../chat/KinChatService.ts";
import { isNotChecked, KinConnections, type StaleAsk } from "../connections/ConnectionsService.ts";
import { cardDecision } from "../memory/decisions.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { answerCard } from "../questions/openQuestions.ts";
import { dismissQuestion, undismissQuestion } from "../questions/dismissed.ts";
import { answerReceiptCard } from "../gendocs/receiptProposals.ts";
import { receiptDocument } from "../gendocs/receipts.ts";
import { answerCurrencyCard } from "./statements/statementReview.ts";
import * as CardActions from "../widgets/cardActions.ts";
import { KinRecords } from "./KinRecords.ts";
import { answerUnconfirmed } from "./unconfirmedFacts.ts";

/**
 * The owner's answer on a choice card Kin asked for itself, run in the tap's transaction. Work
 * that takes long, such as a receipt's PDF, starts once the tap commits.
 */
export const answerChoice = Effect.fn("KinCardAnswers.answer")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  scope: Scope.Scope,
) {
  const sql = yield* SqlClient.SqlClient;
  const followOn = <E, R>(message: string, work: Effect.Effect<void, E, R>) =>
    sql
      .withTransaction(work)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(message, { widgetId: input.widget.widgetId, cause }),
        ),
      );
  // Kin's own route, suggestion and leaver cards answer nothing else; no decision to remember.
  if (
    input.plan?.kind === "let_talk" ||
    input.plan?.kind === "recommend" ||
    input.plan?.kind === "leaver"
  )
    return yield* CardActions.run(input, input.plan, {
      records: yield* KinRecords,
      chat: yield* KinChatService,
    });
  // The option's sealed action runs here, as this tap, before anything the card answers.
  const ran =
    input.plan === undefined
      ? undefined
      : yield* CardActions.run(input, input.plan, {
          records: yield* KinRecords,
          chat: yield* KinChatService,
        });
  // A numbers card applies here, before anything else the tap answers, so a refusal stops it all.
  const watched = yield* answerNumbersChange({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    confirmed: input.option.kind === "yes",
    via: input.via,
    now: input.now,
  });
  // A client's unconfirmed details are written here, as this tap, or dropped.
  const details = yield* answerUnconfirmed({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    confirmed: input.option.kind === "yes",
    via: input.via,
    now: input.now,
  });
  // An agent's open question on this card is answered: its default is never taken.
  const sentBack = yield* answerCard(
    {
      orgId: input.orgId,
      widgetId: input.widget.widgetId,
      personId: input.personId,
      label: input.option.label,
      approves: input.option.kind === "yes",
      via: input.via,
      now: input.now,
    },
    yield* KinChatService,
  );
  if (input.plan === undefined && input.via === "tap" && input.option.kind === "yes")
    yield* followOn("Kin couldn't track the card answer", chosenWork(input));
  const currency = yield* answerCurrencyCard({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    code: input.option.label,
    now: input.now,
  });
  const made = yield* answerReceiptCard({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    confirmed: input.option.kind === "yes",
    via: input.via,
    now: input.now,
  });
  const asked = yield* (yield* KinConnections).answerAsk({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    confirmed: input.option.kind === "yes",
    via: input.via,
    now: input.now,
    ...(input.checkedSent === undefined ? {} : { checkedSent: input.checkedSent }),
  });
  if (asked !== undefined && asked._tag !== "declined")
    yield* sql.afterCommit(afterTap(sendAsked(input, asked), scope));
  // A cancelled mail's Tasks row stops offering it.
  if (asked?._tag === "declined") yield* sql.afterCommit(tasksReread(input.orgId));
  // An agent's question the owner level answered is a decision; Kin's own cards record elsewhere.
  // An Approve that found its long draft changed decided nothing.
  if (
    asked === undefined &&
    made === undefined &&
    currency === undefined &&
    !(sentBack !== undefined && "refused" in sentBack)
  )
    yield* followOn("Kin couldn't prepare the card decision", saveDecision(input, scope));
  if (made?._tag === "made")
    yield* sql.afterCommit(
      afterTap(
        receiptDocument({
          orgId: input.orgId,
          key: made.key,
          number: made.number,
          requester: { _tag: "owner", personId: made.personId as KinPersonId, writer: made.writer },
          admit: Effect.void,
        }),
        scope,
      ),
    );
  if (ran !== undefined) return ran;
  if (watched !== undefined) return watched;
  if (details !== undefined) return details;
  if (made?._tag === "made") return made.outcome;
  if (made?._tag === "declined")
    return { title: "Not recorded", text: "You said no, so nothing was recorded or numbered." };
  if (asked?._tag === "declined")
    return { title: "Not sent", text: "You cancelled it, so nothing was sent." };
  if (currency !== undefined)
    return {
      title: "Currency set",
      text: `The statement is read in ${input.option.label}.`,
    };
  return sentBack;
});

/**
 * After a Confirm refused for its sent-mail tick: a card that doesn't show the warning that stands
 * is redrawn with it, so the person has the box to tick.
 */
export const refusedChoice = Effect.fn("KinCardAnswers.refused")(function* (
  input: Parameters<ChoiceRefusedHandler>[0],
) {
  if (!isNotChecked(input.error)) return;
  const chat = yield* KinChatService;
  let redrawn = false;
  yield* (yield* KinConnections).redrawWarning(input.orgId, input.widgetId, (card) =>
    chat
      .setSendCard({ ...card, orgId: input.orgId, widgetId: KinWidgetId.make(card.widgetId) })
      .pipe(
        Effect.tap(() => Effect.sync(() => (redrawn = true))),
        Effect.mapError((cause) =>
          isChatError(cause)
            ? cause
            : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
        ),
      ),
  );
  if (redrawn) yield* tasksReread(input.orgId);
});

/** A mail card's warning moved: Tasks rows read again, so a row offers what its card now does. */
const tasksReread = (orgId: KinOrgId) =>
  Effect.flatMap(KinRecords, (records) => records.announce(orgId)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin couldn't tell Tasks to read again", { cause }),
    ),
  );

/** A task's title from a card's question and the chosen option: at most this long. */
const CHOSEN_TITLE = 160;

/**
 * Work an owner-level person chose with an option marked yes is tracked: the agent's task the card
 * is about stops waiting on them (reopened if closed), or Kin makes one from the question and the
 * option. The tap already wakes the agent, so this write wakes nobody.
 */
const chosenWork = Effect.fn("KinCardAnswers.chosenWork")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
) {
  const sql = yield* SqlClient.SqlClient;
  const [question] = yield* sql<{
    questionId: string;
    agentId: string;
    question: string;
    intent: string;
    about: string;
  }>`SELECT question_id AS "questionId", agent_id AS "agentId", question, intent, about
    FROM kin_questions
    WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND state = 'answered'
      AND (widget_id = ${input.widget.widgetId} OR raise_widget_id = ${input.widget.widgetId})
      AND answer = ${input.option.label} AND closed_at = ${input.now} AND draft_json IS NULL
    ORDER BY question_id LIMIT 1`;
  if (question === undefined || question.intent.trim() === "") return;
  if (!(yield* ownerLevel(input.orgId, input.personId))) return;
  const records = yield* KinRecords;
  const writer = { actor: { _tag: "person", personId: input.personId }, via: "owner" } as const;
  const keys = question.about === "" ? [] : question.about.split(" ");
  const held =
    keys.length === 0
      ? []
      : yield* sql<{ key: string; state: string; waitingOnId: string | null }>`SELECT key, state,
            waiting_on_id AS "waitingOnId" FROM kin_records
          WHERE org_id = ${input.orgId} AND register_id = 'work' AND key IN ${sql.in(keys)}
            AND owner_kind = 'agent' AND owner_id = ${question.agentId} AND state <> 'dropped'
          ORDER BY key`;
  if (held.length > 0) {
    for (const task of held)
      if (
        task.state === "done" ||
        (task.state === "waiting" && task.waitingOnId === input.personId)
      )
        yield* records.update(input.orgId, writer, task.key, { state: "open" });
    return;
  }
  const asked = question.question.trim().replace(/[?？]+$/u, "");
  const title = `${asked}: ${input.option.label}`.slice(0, CHOSEN_TITLE);
  const questionTitle = `Follow up on question ${question.questionId}`;
  const subjectTitle = keys.length === 0 ? questionTitle : `Follow up on ${keys.join(", ")}`;
  yield* records.create(input.orgId, writer, {
    originKey: `chosen:${question.questionId}`,
    title: !mentionsKinMoney(title)
      ? title
      : mentionsKinMoney(subjectTitle)
        ? questionTitle
        : subjectTitle,
    owner: { _tag: "agent", agentId: KinAgentId.make(question.agentId) },
  });
});

/**
 * A person's Dismiss on a card, or their Undo of it, in the tap's transaction. A question it asks
 * closes as dismissed, and each of its asker's tasks that waited on this person for it alone opens
 * again, with its history saying why (`KIN_DISMISSED_FIELD`). The Undo puts back those still as
 * the dismissal left them.
 */
export const dismissChoice = Effect.fn("KinCardAnswers.dismiss")(function* (
  input: Parameters<ChoiceDismissHandler>[0],
) {
  const sql = yield* SqlClient.SqlClient;
  const card = { orgId: input.orgId, widgetId: input.widget.widgetId, personId: input.personId };
  const question = input.undo
    ? yield* undismissQuestion({ ...card, dismissedAt: input.dismissedAt, now: input.now })
    : yield* dismissQuestion({ ...card, now: input.now });
  if (question === undefined) return;
  const records = yield* KinRecords;
  const writer = { actor: { _tag: "person", personId: input.personId }, via: "owner" } as const;
  if (!input.undo) {
    const about = ` ${question.about.join(" ")} `;
    const [asked] = yield* sql<{ wakeupId: string | null }>`SELECT source_wakeup_id AS "wakeupId"
      FROM kin_messages WHERE org_id = ${input.orgId} AND message_id = ${input.widget.messageId}`;
    const turn = asked?.wakeupId ?? null;
    // Waiting for this question: named in its `about`, or set waiting in the turn that asked it.
    const held = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
      WHERE r.org_id = ${input.orgId} AND r.register_id = 'work' AND r.owner_kind = 'agent'
        AND r.owner_id = ${question.agentId} AND r.state = 'waiting'
        AND r.waiting_on_kind = 'person' AND r.waiting_on_id = ${input.personId}
        AND (${about} LIKE ('% ' || r.key || ' %') OR EXISTS (SELECT 1 FROM kin_record_changes c
          WHERE c.org_id = r.org_id AND c.record_id = r.record_id AND c.wakeup_id = ${turn}
            AND EXISTS (SELECT 1 FROM json_each(c.fields_json) f
              WHERE json_extract(f.value, '$.field') = 'waitingOn')))
        AND NOT EXISTS (SELECT 1 FROM kin_questions q
          LEFT JOIN kin_widgets w ON w.org_id = q.org_id AND w.widget_id = q.widget_id
          LEFT JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
          WHERE q.org_id = r.org_id AND q.state = 'open' AND q.person_id = ${input.personId}
            AND ((' ' || q.about || ' ') LIKE ('% ' || r.key || ' %')
              OR m.source_wakeup_id = ${turn}))
      ORDER BY r.key`;
    for (const task of held)
      yield* records.update(input.orgId, writer, task.key, { state: "open" }, undefined, [
        { field: KIN_DISMISSED_FIELD, from: null, to: question.questionId },
      ]);
    return;
  }
  const released = yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'work' AND r.owner_kind = 'agent'
      AND r.owner_id = ${question.agentId} AND r.state = 'open'
      AND EXISTS (SELECT 1 FROM json_each((SELECT c.fields_json FROM kin_record_changes c
          WHERE c.org_id = r.org_id AND c.record_id = r.record_id ORDER BY c.seq DESC LIMIT 1)) f
        WHERE json_extract(f.value, '$.field') = ${KIN_DISMISSED_FIELD}
          AND json_extract(f.value, '$.to') = ${question.questionId})
    ORDER BY r.key`;
  for (const task of released)
    yield* records.update(input.orgId, writer, task.key, {
      state: "waiting",
      waitingOn: { _tag: "person", personId: input.personId },
    });
});

/** Saves the answer to memory once the tap commits, when the owner or a co-owner gave it. */
const saveDecision = Effect.fn("KinCardAnswers.saveDecision")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  scope: Scope.Scope,
) {
  const memory = yield* Effect.serviceOption(KinMemoryChanges);
  if (Option.isNone(memory) || !(yield* ownerLevel(input.orgId, input.personId))) return;
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ handle: string }>`SELECT handle FROM kin_people
    WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`;
  const card = cardDecision({
    orgId: input.orgId,
    widget: input.widget,
    label: input.option.label,
    by: person?.handle ?? input.personId,
  });
  // A sections card is remembered in Kin's own words, never its text.
  const sections = yield* shellDecision(
    input.orgId,
    input.widget.widgetId,
    input.option.kind === "yes",
  );
  const decision =
    card === undefined || sections === undefined
      ? card
      : { ...card, title: "How Kin is set up for the company", body: sections };
  if (decision !== undefined)
    yield* sql.afterCommit(afterTap(memory.value.recordDecision(input.orgId, decision), scope));
});

const isChatError = Schema.is(KinChatError);
const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** A send card's outcome line, and the same mail on a fresh card when it came back. */
const showOutcome = Effect.fn("KinCardAnswers.outcome")(function* (
  orgId: KinOrgId,
  widgetId: string,
  state: "sending" | "sent" | "failed",
  reason: string | null,
  fresh: StaleAsk | undefined,
  now: number,
) {
  const chat = yield* KinChatService;
  const connections = yield* KinConnections;
  const card = { orgId, widgetId: KinWidgetId.make(widgetId) };
  const outcome = { state, reason, at: at(yield* Clock.currentTimeMillis) };
  // A chat that turned shared since the Confirm refuses the owner-only write: the status still
  // lands, without its reason, and the mail is not drawn there again.
  const told = yield* chat.setSendOutcome({ ...card, outcome }).pipe(
    Effect.as(true),
    Effect.catchIf(isPrivateWriteRefused, () =>
      chat
        .setSendOutcome({ ...card, outcome: { ...outcome, reason: null }, audience: "chat" })
        .pipe(Effect.as(false)),
    ),
  );
  if (state === "sending") return;
  // Another card for the same mail takes the warning that this try may have gone, or loses it.
  const redrawn = yield* connections.openWarnings(orgId, widgetId);
  for (const one of redrawn)
    yield* chat
      .setSendCard({ ...one, orgId, widgetId: KinWidgetId.make(one.widgetId) })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't redraw a card for the same mail", { cause }),
        ),
      );
  // A Tasks row offers its entry's open card: this one is answered, and the mail may follow.
  yield* drawAgain(orgId, told ? fresh : undefined, now).pipe(Effect.ensuring(tasksReread(orgId)));
});

const drawAgain = Effect.fn("KinCardAnswers.drawAgain")(function* (
  orgId: KinOrgId,
  fresh: StaleAsk | undefined,
  now: number,
) {
  if (fresh === undefined) return;
  const chat = yield* KinChatService;
  const again = yield* (yield* KinConnections).freshAsk(orgId, fresh, now);
  if (again === undefined) return;
  const drawn = yield* chat.ask(again.agent, {
    chatId: again.chatId,
    clientMessageId: `kin-connection-ask:${again.askId}`,
    question: again.card.question,
    detail: again.card.detail,
    options: [
      { label: "Confirm", kind: "yes" },
      { label: "Cancel", kind: "no" },
    ],
    send: again.card.send,
  });
  yield* again.bind(drawn.widgetId);
});

/**
 * After the owner's Confirm on a send card: the card says sending, then sent or failed with
 * the reason. A card whose file changed, or whose send failed, says so and the same mail follows.
 */
const sendAsked = Effect.fn("KinCardAnswers.send")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  asked: Exclude<
    NonNullable<Effect.Success<ReturnType<KinConnections["Service"]["answerAsk"]>>>,
    { _tag: "declined" }
  >,
) {
  const connections = yield* KinConnections;
  const widgetId = input.widget.widgetId;
  if (asked._tag === "stale")
    return yield* showOutcome(
      input.orgId,
      widgetId,
      "failed",
      asked.reason,
      asked.fresh,
      input.now,
    );
  yield* showOutcome(input.orgId, widgetId, "sending", null, undefined, input.now);
  const done = yield* connections.sendAsk(input.orgId, asked.askId);
  yield* showOutcome(input.orgId, widgetId, done.state, done.reason, done.fresh, input.now);
});

/** At start, before any new tap: sends a restart cut off end as failed, with the mail again. */
export const resumeInterruptedSends = Effect.fn("KinCardAnswers.resume")(function* (
  orgId: KinOrgId,
  startedAt: number,
) {
  const outcomes = yield* (yield* KinConnections).interruptedSends(orgId, startedAt);
  for (const one of outcomes)
    yield* showOutcome(orgId, one.widgetId, one.state, one.reason, one.fresh, startedAt).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin couldn't reopen a cut-off send", { cause }),
      ),
    );
});

/** Runs once the tap committed, on its own; a failure is logged, and asking again makes it. */
const afterTap = <A, E, R>(effect: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Kin couldn't finish a card's work", { cause })),
    Effect.forkIn(scope),
    Effect.asVoid,
  );
