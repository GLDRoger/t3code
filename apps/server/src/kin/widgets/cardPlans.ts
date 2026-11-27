import {
  type KinChatId,
  KinMessageId,
  KinMoney,
  type KinOrgId,
  KinPersonId,
  KinRecordState,
  KinTrimmedText,
  type KinWidgetId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** The fixed actions a `kin_ask` option may run (`cardActions.ts`), and what each names. */
const CARD_ACTIONS = [
  "done",
  "drop",
  "start",
  "create_list",
  "take_default",
  "record_payment",
  "apply_credit",
  "mark_repaid",
  "record_bill",
  "mark_bill_paid",
] as const;
export const CardActionInput = Schema.Struct({
  kind: Schema.Literals(CARD_ACTIONS),
  target: KinTrimmedText.check(Schema.isMaxLength(200)).annotate({
    description:
      "done, drop: a task key such as W-4. start: a due deferral's id. create_list: a list_define proposal id for a new list. take_default: the id of an open question of yours. record_payment: a Bank transactions credit's key (BNK-1) when Kin ranks one invoice first for it, else the credit's key, a space and the key or number of an invoice Kin ranks first for it (BNK-1 INV-1). mark_repaid: a Bank transactions debit's key (BNK-4) that Kin reads as paying a partner back. record_payment may name more invoices of that client after the first (BNK-4 INV-12 INV-14); when Kin can't tell which invoice a credit pays, the first may be any of them. apply_credit: a client's credit and that client's invoice (RCT-3 INV-14). record_bill: the key of an Expenses entry you suggested as a bill to pay (EXP-7). mark_bill_paid: a Bank transactions debit's key (BNK-4) that Kin matches to one bill to pay.",
  }),
}).annotate({
  description: "What Kin itself does when this option is tapped; Kin writes its button.",
});
export type CardActionInput = typeof CardActionInput.Type;

/**
 * Who drew a card's action: the lead, its turn, and the people it acted for then. `owner` turns
 * act for owner-level people; `team` turns for teammates, `askers` being the ones who asked.
 */
export const CardDraw = Schema.Struct({
  agentId: Schema.String,
  wakeupId: Schema.String,
  ceiling: Schema.Literals(["owner", "team"]),
  people: Schema.Array(Schema.String),
  askers: Schema.Array(Schema.String),
});
export type CardDraw = typeof CardDraw.Type;

const RecordPlan = Schema.Struct({
  kind: Schema.Literals(["done", "drop"]),
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  rev: Schema.Number,
  /** A meeting whose time has passed: its buttons say what happened, not the verb. */
  heldMeeting: Schema.optional(Schema.Literal(true)),
  draw: CardDraw,
});
const StartPlan = Schema.Struct({
  kind: Schema.Literal("start"),
  itemId: Schema.String,
  dueAt: Schema.Number,
  title: Schema.String,
  /** The deferral's own chat and source event, read from memory at draw: who its work goes to. */
  chat: Schema.NullOr(Schema.String),
  sourceEvent: Schema.NullOr(Schema.String),
  draw: CardDraw,
});
const ListPlan = Schema.Struct({
  kind: Schema.Literal("create_list"),
  proposalId: Schema.String,
  /** The proposal's stored definition as validated; a different one at tap runs nothing. */
  definition: Schema.String,
  name: Schema.String,
  draw: CardDraw,
});
/**
 * A Bank transactions credit recorded as an invoice's payment, as the statement matcher ranked the
 * pair when drawn: the credit at its revision, the invoice at what it owed then (`seen`), and what
 * the card said from the records: the invoice's printed number, its client and what stays owed.
 */
const PaymentTerms = Schema.Struct({
  kind: Schema.Literal("record_payment"),
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  number: Schema.String,
  client: Schema.Union([
    Schema.NullOr(Schema.String),
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ]),
  splits: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        recordId: Schema.String,
        key: Schema.String,
        number: Schema.String,
        seen: Schema.String,
        rev: Schema.optionalKey(Schema.Number),
        amountMinor: Schema.Number,
        owedAfterMinor: Schema.Number,
      }),
    ),
  ),
  leftMinor: Schema.optionalKey(Schema.Number),
  seen: Schema.String,
  bankRecordId: Schema.String,
  bankKey: Schema.String,
  rev: Schema.Number,
  amountMinor: Schema.Number,
  currency: Schema.String,
  received: Schema.optionalKey(KinMoney),
  rate: Schema.optionalKey(Schema.String),
  day: Schema.String,
  /** Tax the client withheld, when the matcher read the credit as the amount less it. */
  withheldMinor: Schema.NullOr(Schema.Number),
  /** What the invoice still owes once this is recorded: zero settles it. */
  owedAfterMinor: Schema.Number,
  invoiceRev: Schema.optionalKey(Schema.Number),
});
export type PaymentTerms = typeof PaymentTerms.Type;
const PaymentPlan = Schema.Struct({ ...PaymentTerms.fields, draw: CardDraw });
export type PaymentPlan = typeof PaymentPlan.Type;
/**
 * A Bank transactions debit that pays a partner back, as Kin's matcher read it when drawn: the
 * debit (`recordId`, `key`) at its revision, the partner it names, and each owed expense it
 * repays in full at its revision, amount and day. What stays owed to them is for the line.
 */
const RepaidPlan = Schema.Struct({
  kind: Schema.Literal("mark_repaid"),
  recordId: Schema.String,
  key: Schema.String,
  rev: Schema.Number,
  amountMinor: Schema.Number,
  currency: Schema.String,
  day: Schema.String,
  /** What the debit says, as the bank wrote it: shown on the card as a quotation only. */
  narration: Schema.String,
  partner: Schema.Struct({ id: Schema.String, name: Schema.String }),
  repays: Schema.Array(
    Schema.Struct({
      recordId: Schema.String,
      key: Schema.String,
      rev: Schema.Number,
      amountMinor: Schema.Number,
      day: Schema.String,
    }),
  ),
  owedAfterMinor: Schema.Number,
  expense: Schema.optionalKey(
    Schema.Struct({
      recordId: Schema.String,
      key: Schema.String,
      rev: Schema.Number,
      open: Schema.Boolean,
      day: Schema.NullOr(Schema.String),
    }),
  ),
  asExpense: Schema.optionalKey(Schema.Literal(true)),
  draw: CardDraw,
});
export type RepaidPlan = typeof RepaidPlan.Type;
const RepaidUndoRecord = Schema.Struct({
  recordId: Schema.String,
  key: Schema.String,
  rev: Schema.Number,
  change: Schema.Number,
});
const RepaidUndoPlan = Schema.Struct({
  kind: Schema.Literal("undo_repaid"),
  personId: KinPersonId,
  bank: Schema.Struct({
    ...RepaidUndoRecord.fields,
    state: KinRecordState,
    category: Schema.NullOr(Schema.String),
  }),
  expenses: Schema.Array(
    Schema.Struct({
      ...RepaidUndoRecord.fields,
      reimbursement: Schema.NullOr(Schema.String),
      repaidOn: Schema.NullOr(Schema.String),
      evidence: Schema.Boolean,
      relates: Schema.Boolean,
    }),
  ),
});
export type RepaidUndoPlan = typeof RepaidUndoPlan.Type;
const ApplyPlan = Schema.Struct({
  kind: Schema.Literal("apply_credit"),
  key: Schema.String,
  receipt: Schema.String,
  client: Schema.String,
  receiptRev: Schema.Number,
  invoiceRev: Schema.Number,
  paymentId: Schema.String,
  number: Schema.String,
  amount: KinMoney,
  receivedOn: Schema.String,
  owedAfterMinor: Schema.Number,
  draw: CardDraw,
});
export type ApplyPlan = typeof ApplyPlan.Type;
const BillPlan = Schema.Struct({
  kind: Schema.Literal("record_bill"),
  recordId: Schema.String,
  key: Schema.String,
  rev: Schema.Number,
  vendor: Schema.String,
  amountMinor: Schema.Number,
  currency: Schema.String,
  dueDay: Schema.NullOr(Schema.String),
  draw: CardDraw,
});
export type BillPlan = typeof BillPlan.Type;
const BillPaidPlan = Schema.Struct({
  kind: Schema.Literal("mark_bill_paid"),
  recordId: Schema.String,
  key: Schema.String,
  rev: Schema.Number,
  amountMinor: Schema.Number,
  currency: Schema.String,
  day: Schema.String,
  bill: Schema.Struct({
    recordId: Schema.String,
    key: Schema.String,
    rev: Schema.Number,
    vendor: Schema.String,
  }),
  draw: CardDraw,
});
export type BillPaidPlan = typeof BillPaidPlan.Type;
const RunPlan = Schema.Union([
  RecordPlan,
  StartPlan,
  ListPlan,
  PaymentPlan,
  RepaidPlan,
  ApplyPlan,
  BillPlan,
  BillPaidPlan,
]);
export type RunPlan = typeof RunPlan.Type;
const DefaultPlan = Schema.Struct({
  kind: Schema.Literal("take_default"),
  questionId: Schema.String,
  question: Schema.String,
  /** The question's card and its default option, bound by id. */
  widgetId: Schema.String,
  optionId: Schema.String,
  label: Schema.String,
  /** That option's own sealed action, run by this tap; null when it has none. */
  final: Schema.NullOr(RunPlan),
  draw: CardDraw,
});
/**
 * Kin's own card on a teammate's request for an agent they may not message (`routeCard.ts`):
 * let them, and pass on that one message, or tell them it wasn't. Never drawn by an agent.
 */
const RoutePlan = Schema.Struct({
  kind: Schema.Literal("let_talk"),
  answer: Schema.Literals(["let", "decline"]),
  personId: Schema.String,
  personName: Schema.String,
  /** The agent that owns the request, and the one it was asked of. */
  agentId: Schema.String,
  agentName: Schema.String,
  fromName: Schema.String,
  /** The teammate's own message, in their direct chat with the agent it was asked of. */
  messageId: Schema.String,
  chatId: Schema.String,
  draw: CardDraw,
});
export type RoutePlan = typeof RoutePlan.Type;
/**
 * On Kin's note that a question's default was taken at its day: Undo puts back the one change it
 * made (`seq`, which left the entry at `rev`), Keep leaves it. Sealed by the server, never drawn.
 */
const TakenPlan = Schema.Struct({
  kind: Schema.Literals(["undo_default", "keep_default"]),
  questionId: Schema.String,
  agentId: Schema.String,
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  label: Schema.String,
  seq: Schema.Number,
  rev: Schema.Number,
  /** Its person couldn't see the entry when told: its words never name it (`key`, `title`). */
  hidden: Schema.optional(Schema.Literal(true)),
});
export type TakenPlan = typeof TakenPlan.Type;
/** The one setting a recommendation's Do it changes, as the setting's own place would. */
export const RecommendChange = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("bank_sender"),
    address: Schema.String,
    bankName: Schema.String,
    accounts: Schema.Array(Schema.String),
    siblingAddress: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("lead_access"),
    personId: Schema.String,
    personName: Schema.String,
    agentId: Schema.String,
    agentName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("daily_limit"),
    /** The agents' limits the card was drawn at, both of them, and the next choice up it offers. */
    fromLeadUnits: Schema.Number,
    fromWorkerUnits: Schema.Number,
    fromName: Schema.String,
    toLeadUnits: Schema.Number,
    toWorkerUnits: Schema.Number,
    toName: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("connection_resume"),
    connectionId: Schema.String,
    connectionName: Schema.String,
    /** When the pause the card was drawn for began: a later pause is another one. */
    pausedAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("agent_resume"),
    agentId: Schema.String,
    agentName: Schema.String,
    pausedAt: Schema.Number,
  }),
]);
/** Kin's own suggestion to the owner (`recommend/KinRecommend.ts`): Do it, or Not now. */
const RecommendPlan = Schema.Struct({
  kind: Schema.Literal("recommend"),
  answer: Schema.Literals(["do", "not_now"]),
  recId: Schema.String,
  rule: Schema.String,
  subject: Schema.String,
  change: RecommendChange,
});
export type RecommendPlan = typeof RecommendPlan.Type;
export type RecommendChange = typeof RecommendChange.Type;
/**
 * On Kin's note that the asker took a question's answer from its person's words: Undo opens the
 * question again, Keep leaves it. Bound to that one answer by when it closed. Never drawn.
 */
const AnsweredPlan = Schema.Struct({
  kind: Schema.Literals(["undo_answer", "keep_answer"]),
  questionId: Schema.String,
  agentId: Schema.String,
  answer: Schema.NullOr(Schema.String),
  closedAt: Schema.Number,
});
export type AnsweredPlan = typeof AnsweredPlan.Type;
/**
 * Kin's own card when someone who looked after clients left (`people/leaver.ts`): give it all to
 * one person, or leave it as it is. Bound to that removal by its instant. Never drawn by an agent.
 */
const LeaverPlan = Schema.Struct({
  kind: Schema.Literal("leaver"),
  personId: Schema.String,
  personName: Schema.String,
  removedAt: Schema.Number,
  /** Who takes it all; null is "Leave them as they are". */
  to: Schema.NullOr(Schema.Struct({ personId: Schema.String, name: Schema.String })),
});
export type LeaverPlan = typeof LeaverPlan.Type;
/**
 * What every card Kin posts about one pulse fact names (`pulse/factCards.ts`): the fact it stands
 * on, the card's round on it, the one person who may answer, and the agent whose chat it is in.
 */
const FactCardFields = {
  factKey: Schema.String,
  round: Schema.Number,
  personId: Schema.String,
  personName: Schema.String,
  agentId: Schema.String,
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  rev: Schema.Number,
};
/**
 * The person a task has waited on too long answers: what it waited on is done, it will be by a
 * day (`until`, the end of `day`), or it doesn't wait on them. Never drawn by an agent.
 */
const WaitedPlan = Schema.Struct({
  kind: Schema.Literal("waited_answer"),
  answer: Schema.Literals(["done", "by", "not_mine"]),
  ...FactCardFields,
  /** The person who holds the task: told of each answer. */
  holder: Schema.Struct({ personId: Schema.String, name: Schema.String }),
  until: Schema.NullOr(Schema.Number),
  day: Schema.NullOr(Schema.String),
});
export type WaitedPlan = typeof WaitedPlan.Type;
/**
 * A task's holder answers that it has been in progress with no change: still on it, which holds
 * the fact until `until` (on `day`, in their words), or done. Never drawn by an agent.
 */
const StallPlan = Schema.Struct({
  kind: Schema.Literal("stall_answer"),
  answer: Schema.Literals(["still", "done"]),
  ...FactCardFields,
  until: Schema.Number,
  day: Schema.String,
});
export type StallPlan = typeof StallPlan.Type;
/**
 * A milestone slipping behind its open tasks: move its due day from `from` to `to`, its last open
 * task's, or leave it. `factKey` names the milestone and its day, whether late or at risk.
 */
const DuePlan = Schema.Struct({
  kind: Schema.Literals(["move_due", "keep_due"]),
  ...FactCardFields,
  from: Schema.Number,
  to: Schema.Number,
  fromDay: Schema.String,
  toDay: Schema.String,
});
export type DuePlan = typeof DuePlan.Type;
/**
 * A contract's notice day (`recordId` its project): let it renew, as agreed. Giving notice is the
 * card's plain answer, which wakes its agent to draft the mail. Never drawn by an agent.
 */
const NoticePlan = Schema.Struct({
  kind: Schema.Literal("notice_renew"),
  ...FactCardFields,
  noticeBy: Schema.String,
  renewsOn: Schema.String,
});
export type NoticePlan = typeof NoticePlan.Type;

const InvoiceChoicePlan = Schema.Struct({
  kind: Schema.Literal("invoice_choice"),
  ...FactCardFields,
  payment: Schema.NullOr(Schema.Struct({ ...PaymentTerms.fields, invoiceRev: Schema.Number })),
});
export type InvoiceChoicePlan = typeof InvoiceChoicePlan.Type;

const QuietPlan = Schema.Struct({
  kind: Schema.Literals(["quiet_keep", "quiet_stop"]),
  wakeupId: Schema.String,
  agentId: Schema.String,
  askers: Schema.Array(Schema.String),
  ask: Schema.Literals([1, 2]),
});
export type QuietPlan = typeof QuietPlan.Type;
export const isQuiet = Schema.is(QuietPlan);
export const CardPlan = Schema.Union([
  RecordPlan,
  StartPlan,
  ListPlan,
  PaymentPlan,
  ApplyPlan,
  RepaidPlan,
  RepaidUndoPlan,
  DefaultPlan,
  RoutePlan,
  TakenPlan,
  RecommendPlan,
  AnsweredPlan,
  LeaverPlan,
  WaitedPlan,
  StallPlan,
  DuePlan,
  NoticePlan,
  InvoiceChoicePlan,
  BillPlan,
  BillPaidPlan,
  QuietPlan,
]);
export type CardPlan = typeof CardPlan.Type;
export type FactCardPlan = WaitedPlan | StallPlan | DuePlan | NoticePlan | InvoiceChoicePlan;
const FACT_CARD_KINDS: ReadonlySet<string> = new Set<FactCardPlan["kind"]>([
  "waited_answer",
  "stall_answer",
  "move_due",
  "keep_due",
  "notice_renew",
  "invoice_choice",
]);
/** Kin's own card about a pulse fact: it answers nothing else and no agent draws or redraws it. */
export const isFactCard = (plan: CardPlan): plan is FactCardPlan => FACT_CARD_KINDS.has(plan.kind);
export const FACT_CARD_KIND_LIST = [...FACT_CARD_KINDS];
const PlanJson = Schema.fromJsonString(CardPlan);
const encodePlan = Schema.encodeEffect(PlanJson);
const decodePlan = Schema.decodeUnknownOption(PlanJson);

export const isTaken = (plan: CardPlan): plan is TakenPlan =>
  plan.kind === "undo_default" || plan.kind === "keep_default";
export const isAnswered = (plan: CardPlan): plan is AnsweredPlan =>
  plan.kind === "undo_answer" || plan.kind === "keep_answer";

/** Whether Kin may take this action as a question's default at its day: a task's done or drop. */
export const takesAsDefault = <P extends { readonly kind: CardPlan["kind"] }>(
  plan: P,
): plan is Extract<P, { readonly kind: "done" | "drop" }> =>
  plan.kind === "done" || plan.kind === "drop";

/** Whether a tap on this plan is finished by the server, so it wakes no lead. */
export const runsItself = (plan: CardPlan) => plan.kind !== "take_default" || plan.final !== null;

/** Seals a drawn card's plans, in the card's own transaction; a retried draw keeps the first. */
export const sealPlans = Effect.fn("KinCardPlans.seal")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly widgetId: KinWidgetId;
  readonly plans: ReadonlyArray<{ readonly optionId: string; readonly plan: CardPlan }>;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  for (const one of input.plans)
    yield* sql`INSERT INTO kin_card_plans (org_id, widget_id, option_id, chat_id, plan_json,
        created_at)
      VALUES (${input.orgId}, ${input.widgetId}, ${one.optionId}, ${input.chatId},
        ${yield* encodePlan(one.plan).pipe(Effect.orDie)}, ${input.now})
      ON CONFLICT (org_id, widget_id, option_id) DO NOTHING`;
});

/** The plan an option runs, and the message of the tap that ran it; undefined for a plain option. */
export const planFor = Effect.fn("KinCardPlans.planFor")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly widgetId: string;
  readonly optionId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string; chatId: string; ran: string | null }>`SELECT
      plan_json AS json, chat_id AS "chatId", ran_message_id AS ran FROM kin_card_plans
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND option_id = ${input.optionId}`;
  if (row === undefined) return undefined;
  // A row nobody can read, or sealed for another chat, runs nothing: the tap is refused rather
  // than taken as plain.
  const plan =
    row.chatId === input.chatId ? Option.getOrUndefined(decodePlan(row.json)) : undefined;
  return { plan, ran: row.ran === null ? null : KinMessageId.make(row.ran) };
});

/** Every option of a card still in its chat that runs an action, by option id. */
export const plansOf = Effect.fn("KinCardPlans.plansOf")(function* (
  orgId: KinOrgId,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ optionId: string; json: string }>`SELECT p.option_id AS "optionId",
      p.plan_json AS json FROM kin_card_plans p
    JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
      AND w.chat_id = p.chat_id
    WHERE p.org_id = ${orgId} AND p.widget_id = ${widgetId} ORDER BY p.option_id`;
  return new Map(
    rows.flatMap((row) => {
      const plan = Option.getOrUndefined(decodePlan(row.json));
      return plan === undefined ? [] : [[row.optionId, plan] as const];
    }),
  );
});

/** Every option of a card sealed with an action, whether or not its plan can still be read. */
export const sealedOptions = Effect.fn("KinCardPlans.sealedOptions")(function* (
  orgId: KinOrgId,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ optionId: string }>`SELECT option_id AS "optionId"
    FROM kin_card_plans WHERE org_id = ${orgId} AND widget_id = ${widgetId} ORDER BY option_id`;
  return new Set(rows.map((row) => row.optionId));
});

/** The tap that ran a card's plan: a later tap on the card returns its message. */
export const markRan = Effect.fn("KinCardPlans.markRan")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly optionId: string;
  readonly messageId: KinMessageId;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_card_plans SET ran_message_id = ${input.messageId}
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND option_id = ${input.optionId} AND ran_message_id IS NULL`;
});
