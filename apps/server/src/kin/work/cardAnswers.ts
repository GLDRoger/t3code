import type { KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import type { ChoiceAnswerHandler } from "../chat/KinChatService.ts";
import { answerReceiptCard } from "../gendocs/receiptProposals.ts";
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

/** Runs once the tap committed, on its own; a failure is logged, and asking again makes it. */
const afterTap = <A, E, R>(effect: Effect.Effect<A, E, R>, scope: Scope.Scope) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Kin couldn't finish a card's work", { cause })),
    Effect.forkIn(scope),
    Effect.asVoid,
  );
