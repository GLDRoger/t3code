import { KinChatError, KinDay } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TurnEvent } from "../lead/eventIds.ts";
import { MAX_BILL_BOXES } from "./billCutterProtocol.ts";
import { addFromMessage, answer, cut as cutPage } from "./bills.ts";
import { KinToolText } from "./leadSchemas.ts";
import { admitted, type Lead, leadTool, sourceOf } from "./leadWork.ts";

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

export const CutInput = Schema.Struct({
  bill: ReadInput.fields.bill,
  page: Schema.optional(Schema.Int).annotate({
    description: "The PDF page number, starting at 1. Omit for a photo.",
  }),
  boxes: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Int]))
    .check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BILL_BOXES))
    .annotate({
      description:
        "One box per bill: [x, y, width, height] on the upright page's 0–1000 grid, with 0,0 at the top left. Each side must be at least 50.",
    }),
});
const runCut = Effect.fnUntraced(function* (lead: Lead, input: typeof CutInput.Type) {
  yield* admitted(lead, "bill_cut", input).pipe(
    Effect.mapError(
      (error) =>
        new KinChatError({ reason: error.reason, message: `${error.message} Nothing was cut.` }),
    ),
  );
  return yield* cutPage(lead, input);
});
export const cut = leadTool("KinBillTools.cut", runCut);
