import { type KinPersonId, KinWidgetId } from "@t3tools/contracts";
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

/**
 * After the owner's Confirm on a send card: the card says sending, then sent or failed with
 * the reason. A card whose file changed says so and a fresh card with the file as it is follows.
 */
const sendAsked = Effect.fn("KinCardAnswers.send")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  asked: Exclude<
    NonNullable<Effect.Success<ReturnType<KinConnections["Service"]["answerAsk"]>>>,
    { _tag: "declined" }
  >,
) {
  const chat = yield* KinChatService;
  const connections = yield* KinConnections;
  const widgetId = KinWidgetId.make(input.widget.widgetId);
  const outcome = (state: "sending" | "sent" | "failed", reason: string | null) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        chat.setSendOutcome({
          orgId: input.orgId,
          widgetId,
          outcome: { state, reason, at: at(now) },
        }),
      ),
    );
  const again = Effect.fnUntraced(function* (stale: StaleAsk) {
    const fresh = yield* connections.freshAsk(input.orgId, stale, input.now);
    const card = yield* chat.ask(fresh.agent, {
      chatId: fresh.chatId,
      clientMessageId: `kin-connection-ask:${fresh.askId}`,
      question: fresh.card.question,
      detail: fresh.card.detail,
      options: [
        { label: "Confirm", kind: "yes" },
        { label: "Cancel", kind: "no" },
      ],
      send: fresh.card.send,
    });
    yield* fresh.bind(card.widgetId);
  });
  if (asked._tag === "stale") {
    yield* outcome("failed", asked.reason);
    if (asked.fresh !== undefined) yield* again(asked.fresh);
    return;
  }
  yield* outcome("sending", null);
  const done = yield* connections.sendAsk(input.orgId, asked.askId);
  yield* outcome(done.state, done.reason);
  if (done.fresh !== undefined) yield* again(done.fresh);
});

/** Runs once the tap committed, on its own; a failure is logged, and asking again makes it. */
const afterTap = <A, E, R>(effect: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Kin couldn't finish a card's work", { cause })),
    Effect.forkIn(scope),
    Effect.asVoid,
  );
