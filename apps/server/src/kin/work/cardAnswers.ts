import { KinChatError, type KinOrgId, type KinPersonId, KinWidgetId } from "@t3tools/contracts";
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
  type ChoiceRefusedHandler,
  KinChatService,
} from "../chat/KinChatService.ts";
import { isNotChecked, KinConnections, type StaleAsk } from "../connections/ConnectionsService.ts";
import { cardDecision } from "../memory/decisions.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { answerCard } from "../questions/openQuestions.ts";
import { answerReceiptCard } from "../gendocs/receiptProposals.ts";
import { receiptDocument } from "../gendocs/receipts.ts";
import { answerCurrencyCard } from "./statements/statementReview.ts";
import * as CardActions from "../widgets/cardActions.ts";
import { KinRecords } from "./KinRecords.ts";

/**
 * The owner's answer on a choice card Kin asked for itself, run in the tap's transaction. Work
 * that takes long, such as a receipt's PDF, starts once the tap commits.
 */
export const answerChoice = Effect.fn("KinCardAnswers.answer")(function* (
  input: Parameters<ChoiceAnswerHandler>[0],
  scope: Scope.Scope,
) {
  const sql = yield* SqlClient.SqlClient;
  // Kin's own route and recommendation cards answer nothing else, and are no decision to remember.
  if (input.plan?.kind === "let_talk" || input.plan?.kind === "recommend")
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
  // An agent's open question on this card is answered: its default is never taken.
  yield* answerCard({
    orgId: input.orgId,
    widgetId: input.widget.widgetId,
    personId: input.personId,
    label: input.option.label,
    now: input.now,
  });
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
  // An agent's question the owner level answered is a decision; Kin's own cards record elsewhere.
  if (asked === undefined && made === undefined && currency === undefined)
    yield* saveDecision(input, scope);
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
  return undefined;
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
  const decision = cardDecision({
    orgId: input.orgId,
    widget: input.widget,
    label: input.option.label,
    by: person?.handle ?? input.personId,
  });
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
  // Another card for the same mail takes the warning that this try may have gone, or loses it.
  if (state !== "sending") {
    const redrawn = yield* connections.openWarnings(orgId, widgetId);
    for (const one of redrawn)
      yield* chat
        .setSendCard({ ...one, orgId, widgetId: KinWidgetId.make(one.widgetId) })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't redraw a card for the same mail", { cause }),
          ),
        );
    if (redrawn.length > 0) yield* tasksReread(orgId);
  }
  if (!told || fresh === undefined) return;
  const again = yield* connections.freshAsk(orgId, fresh, now);
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
