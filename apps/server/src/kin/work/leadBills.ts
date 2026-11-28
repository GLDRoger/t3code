import {
  KIN_BILLS_PER_TURN,
  KinBillBatchId,
  KinBillRead,
  KinBillSaid,
  KinBillSaidBy,
  KinBillState,
  KinChatError,
  KinDay,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { TurnEvent } from "../lead/eventIds.ts";
import { MAX_BILL_BOXES } from "./billCutterProtocol.ts";
import {
  addFromMessage,
  answerMany,
  cutMany,
  listForChat,
  recutForChat,
  setForChat,
} from "./bills.ts";
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
const ReadEntry = Schema.Struct({
  bill: KinToolText(8, "The bill's id as this turn names it, such as B1."),
  readable: Schema.Boolean.annotate({
    description: "false when it isn't a bill you can read at all.",
  }),
  vendor: Printed(200, "Who was paid, as printed."),
  date: Schema.optional(KinDay).annotate({ description: "The bill's date as YYYY-MM-DD." }),
  amount: Printed(
    60,
    "The total as a plain number, dot for decimals, no symbol or separators: 1200.50.",
  ),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))).annotate({
    description: "ISO code of the printed currency; left out when the bill doesn't show one.",
  }),
  currencyMark: KinBillRead.fields.currencyMark.annotate({
    description:
      "The currency symbol or word exactly as printed, up to 8 characters, when no code is printed.",
  }),
  tax: Printed(60, "The tax as a plain number, as amount."),
  category: Printed(60, "One of Expenses' categories."),
  number: Printed(80, "The bill's own number."),
  cannotRead: Printed(300, "What you couldn't read, in plain words."),
});
const entries = <S extends Schema.Constraint>(item: S) =>
  Schema.Array(item).check(Schema.isMinLength(1), Schema.isMaxLength(KIN_BILLS_PER_TURN));

// Discovery shows the entry shape. Decode members individually so one invalid member cannot
// stop the call. Hidden fields let old, already-issued calls still answer a bill.
const batchInput = <Batch extends Schema.Constraint, Entry extends Schema.Constraint>(
  batch: Batch,
  documented: Schema.Constraint,
  entry: Entry,
) => {
  const spec = Schema.toJsonSchemaDocument(documented).schema;
  const legacy = Schema.toJsonSchemaDocument(entry).schema;
  return Schema.Any.check(
    Schema.makeFilter(() => undefined, {
      toJsonSchema: () => ({
        ...spec,
        properties: Object.assign({}, spec.properties, legacy.properties),
      }),
    }),
  ).pipe(Schema.decodeTo(Schema.Union([batch, Schema.toCodecJson(entry)])));
};

const runEntries = Effect.fnUntraced(function* <T, E, R>(
  raw: ReadonlyArray<unknown>,
  decode: (input: unknown) => Option.Option<T>,
  run: (
    inputs: ReadonlyArray<T>,
  ) => Effect.Effect<ReadonlyArray<Result.Result<BillResult, KinChatError>>, E, R>,
  refused: string,
) {
  const parsed = raw.map(decode);
  const results = (yield* run(
    parsed.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
  )).values();
  return {
    results: raw.map((entry, index) => {
      const name =
        Predicate.isObject(entry) && typeof entry.bill === "string"
          ? entry.bill.trim().toUpperCase()
          : "";
      const bill = /^B\d{1,6}$/u.test(name) ? name : `Entry ${index + 1}`;
      if (Option.isNone(parsed[index]!)) return { bill, result: `${bill} ${refused}` };
      const result = results.next().value!;
      return Result.isSuccess(result)
        ? result.success
        : { bill, result: result.failure.message.replace(/\s+/gu, " ") };
    }),
  };
});

const BillResult = Schema.Struct({ bill: Schema.String, result: Schema.String });
type BillResult = typeof BillResult.Type;
export const ReadResult = Schema.Struct({ results: Schema.Array(BillResult) });

export const ReadInput = batchInput(
  Schema.Struct({ bills: entries(Schema.Unknown) }),
  Schema.Struct({ bills: entries(ReadEntry) }),
  ReadEntry,
);
export const legacyReadFields = Object.keys(ReadEntry.fields);
const decodeReadEntry = Schema.decodeUnknownOption(Schema.toCodecJson(ReadEntry));
const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof ReadInput.Type) {
  const bills = "bills" in input ? input.bills : [input];
  return yield* runEntries(
    bills,
    decodeReadEntry,
    (entries) =>
      answerMany(
        lead,
        entries.map(({ bill, readable, cannotRead, ...read }) => ({
          bill,
          readable,
          cannotRead,
          read,
        })),
      ),
    "was not saved. Check its fields.",
  );
});
export const read = leadTool("KinBillTools.read", runRead);

const CutEntry = Schema.Struct({
  bill: ReadEntry.fields.bill,
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
export const CutInput = batchInput(
  Schema.Struct({ cuts: entries(Schema.Unknown) }),
  Schema.Struct({ cuts: entries(CutEntry) }),
  CutEntry,
);
export const legacyCutFields = Object.keys(CutEntry.fields);
const decodeCutEntry = Schema.decodeUnknownOption(Schema.toCodecJson(CutEntry));
const runCut = Effect.fnUntraced(function* (lead: Lead, input: typeof CutInput.Type) {
  yield* admitted(lead, "bill_cut", input).pipe(
    Effect.mapError(
      (error) =>
        new KinChatError({ reason: error.reason, message: `${error.message} Nothing was cut.` }),
    ),
  );
  return yield* runEntries(
    "cuts" in input ? input.cuts : [input],
    decodeCutEntry,
    (entries) => cutMany(lead, entries),
    "has an invalid cut. Nothing was cut.",
  );
});
export const cut = leadTool("KinBillTools.cut", runCut);

const BatchId = Schema.optional(KinBillBatchId).annotate({
  description: "The id of a batch in this chat. Omit for the latest batch.",
});
const ShortBill = Schema.String.check(
  Schema.isPattern(/^[PF]\d{1,4}(?:@\d{1,5})?(?:\.\d{1,2}){0,2}$/u),
);
export const ListInput = Schema.Struct({ batchId: BatchId });
export const ListResult = Schema.Struct({
  batchId: KinBillBatchId,
  bills: Schema.Array(
    Schema.Struct({
      bill: ShortBill,
      state: KinBillState,
      read: KinBillRead,
      missing: Schema.Array(Schema.String),
      problem: Schema.optional(Schema.String),
      said: Schema.optional(KinBillSaid),
      saidBy: Schema.optional(KinBillSaidBy),
    }),
  ),
});
export const listBills = leadTool(
  "KinBillTools.list",
  Effect.fnUntraced(function* (lead: Lead, input: typeof ListInput.Type) {
    yield* admitted(lead, "bills_list", input);
    return yield* listForChat(lead, input.batchId);
  }),
);

export const SetInput = Schema.Struct({
  batchId: BatchId,
  sourceEventId: TurnEvent,
  bills: Schema.Array(ShortBill).check(Schema.isMinLength(1), Schema.isMaxLength(2400)).annotate({
    description: "The names from bills_list, such as P3.2. Each gets the same fields.",
  }),
  fields: Schema.Struct({
    vendor: Printed(200, "The payee the person gave."),
    date: Schema.optional(KinDay).annotate({
      description: "The date the person gave, as YYYY-MM-DD.",
    }),
    amount: Printed(60, "The amount the person gave, as a plain number with a decimal point."),
    currency: KinBillSaid.fields.currency,
    tax: Printed(60, "The tax the person gave, as a plain number with a decimal point."),
    category: Printed(60, "The Expenses category the person gave."),
    number: Printed(80, "The bill number the person gave."),
    paidBy: Printed(200, 'Use "me" for the author of the message, or the name the author gave.'),
  }),
});
export const set = leadTool(
  "KinBillTools.set",
  Effect.fnUntraced(function* (lead: Lead, input: typeof SetInput.Type) {
    yield* admitted(lead, "bill_set", input);
    return yield* setForChat(lead, input);
  }),
);

export const RecutInput = Schema.Struct({
  batchId: BatchId,
  sourceEventId: TurnEvent,
  photo: Schema.Int.check(Schema.isGreaterThan(0)).annotate({
    description: "The photo number in the batch, such as 3 for Photo 3.",
  }),
  words: KinToolText(300, "The person's exact words about where the bills are on the photo."),
});
export const RecutResult = Schema.Struct({ result: Schema.String });
export const recut = leadTool(
  "KinBillTools.recut",
  Effect.fnUntraced(function* (lead: Lead, input: typeof RecutInput.Type) {
    yield* admitted(lead, "bill_recut", input);
    return yield* recutForChat(lead, input);
  }),
);
