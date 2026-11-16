import { type KinOrgId, type KinPersonId, KinWidgetId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { type ChoiceAnswerHandler, KinChatService } from "../chat/KinChatService.ts";
import { KinConnections, type StaleAsk } from "../connections/ConnectionsService.ts";
import { answerReceiptCard } from "../gendocs/receiptProposals.ts";
import { answerReviewCard } from "../github/PullRequestCare.ts";
import { receiptDocument } from "../gendocs/receipts.ts";
import { answerCurrencyCard } from "./statements/statementReview.ts";

/**
 * The owner's answer on a choice card Kin asked for itself, run in the tap's transaction. Work
 * that takes long, such as a receipt's PDF, starts once the tap commits.
 */
export const answerChoice = Effect.fn("KinCardAnswers.answer")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  scope: Scope.Scope,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* answerReviewCard({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    confirmed: input.option.kind === "yes",
    now: input.now,
  });
  yield* answerCurrencyCard({
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
  });
  if (asked !== undefined && asked._tag !== "declined")
    yield* sql.afterCommit(afterTap(sendAsked(input, asked), scope));
  if (made !== undefined)
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
});

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
  yield* chat.setSendOutcome({
    orgId,
    widgetId: KinWidgetId.make(widgetId),
    outcome: { state, reason, at: at(yield* Clock.currentTimeMillis) },
  });
  if (fresh === undefined) return;
  const again = yield* connections.freshAsk(orgId, fresh, now);
  const card = yield* chat.ask(again.agent, {
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
  yield* again.bind(card.widgetId);
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
