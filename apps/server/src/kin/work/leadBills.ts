import { KinChatError, KinDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TurnEvent } from "../lead/eventIds.ts";
import { addFromMessage, answer } from "./bills.ts";
import { KinToolText } from "./leadSchemas.ts";
import { admitted, type Lead, leadTool, sourceOf } from "./leadWork.ts";

/** The lead tools for bills in bulk: start a batch from a message, and answer one bill read. */

export const AddInput = Schema.Struct({ sourceEventId: TurnEvent });
export const AddResult = Schema.Struct({
  added: Schema.Number,
  alreadyAdded: Schema.Number,
  notBills: Schema.Number,
  next: Schema.String,
});

const runAdd = Effect.fnUntraced(function* (lead: Lead, input: typeof AddInput.Type) {
  yield* admitted(lead, "bills_add", input);
  const source = yield* sourceOf(lead, input.sourceEventId);
  if (source === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "sourceEventId must be the message with the bills.",
    });
  const made = yield* addFromMessage({
    orgId: lead.orgId,
    agentId: lead.agentId,
    eventId: input.sourceEventId,
    chatId: source.chatId,
    messageId: source.messageId,
  });
  return addAnswer({
    added: made.added.length,
    alreadyAdded: made.already.length,
    notBills: made.refused.length,
  });
});
/** `bills_add`'s answer for how many bills the add took. */
export const addAnswer = (counts: {
  readonly added: number;
  readonly alreadyAdded: number;
  readonly notBills: number;
}) => ({
  ...counts,
  next:
    counts.added === 0
      ? "Nothing new to read. Say so in one line."
      : "Kin reads them in the background; its card in the chat shows how it goes. Say so in one line and stop.",
});
export const add = leadTool("KinBillTools.add", runAdd);

const Printed = (max: number, description: string) =>
  Schema.optional(KinToolText(max, description));
export const ReadInput = Schema.Struct({
  bill: KinToolText(8, "The bill's id as this turn names it, such as B1."),
  readable: Schema.Boolean.annotate({
    description: "false when it isn't a bill you can read at all.",
  }),
  vendor: Printed(200, "Who was paid, as printed."),
  date: Schema.optional(KinDay),
  amount: Printed(
    60,
    "The total as a plain number, dot for decimals, no symbol or separators: 1200.50.",
  ),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))).annotate({
    description: "ISO code of the printed currency; left out when the bill doesn't show one.",
  }),
  tax: Printed(60, "The tax as a plain number, as amount."),
  category: Printed(60, "One of Expenses' categories."),
  number: Printed(80, "The bill's own number."),
  cannotRead: Printed(300, "What you couldn't read, in plain words."),
});
export const ReadResult = Schema.Struct({ bill: Schema.String, result: Schema.String });

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof ReadInput.Type) {
  const { bill, readable, cannotRead, ...read } = input;
  return yield* answer(
    { orgId: lead.orgId, agentId: lead.agentId, wakeupId: lead.wakeupId },
    { bill, readable, read, cannotRead },
  );
});
export const read = leadTool("KinBillTools.read", runRead);
