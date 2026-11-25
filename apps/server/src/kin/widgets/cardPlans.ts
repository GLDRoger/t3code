import {
  type KinChatId,
  KinMessageId,
  type KinOrgId,
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
  "mark_repaid",
] as const;
export const CardActionInput = Schema.Struct({
  kind: Schema.Literals(CARD_ACTIONS),
  target: KinTrimmedText.check(Schema.isMaxLength(200)).annotate({
    description:
      "done, drop: a task key such as W-4. start: a due deferral's id. create_list: a list_define proposal id for a new list. take_default: the id of an open question of yours. record_payment: a Bank transactions credit's key (BNK-1) when Kin ranks one invoice first for it, else the credit's key, a space and the key or number of an invoice Kin ranks first for it (BNK-1 INV-1). mark_repaid: a Bank transactions debit's key (BNK-4) that Kin reads as paying a partner back.",
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
const PaymentPlan = Schema.Struct({
  kind: Schema.Literal("record_payment"),
  recordId: Schema.String,
  key: Schema.String,
  title: Schema.String,
  number: Schema.String,
  client: Schema.NullOr(Schema.String),
  seen: Schema.String,
  bankRecordId: Schema.String,
  bankKey: Schema.String,
  rev: Schema.Number,
  amountMinor: Schema.Number,
  currency: Schema.String,
  day: Schema.String,
  /** Tax the client withheld, when the matcher read the credit as the amount less it. */
  withheldMinor: Schema.NullOr(Schema.Number),
  /** What the invoice still owes once this is recorded: zero settles it. */
  owedAfterMinor: Schema.Number,
  draw: CardDraw,
});
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
  draw: CardDraw,
});
export type RepaidPlan = typeof RepaidPlan.Type;
const RunPlan = Schema.Union([RecordPlan, StartPlan, ListPlan, PaymentPlan, RepaidPlan]);
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
export const CardPlan = Schema.Union([
  RecordPlan,
  StartPlan,
  ListPlan,
  PaymentPlan,
  RepaidPlan,
  DefaultPlan,
  RoutePlan,
  TakenPlan,
  RecommendPlan,
  AnsweredPlan,
  LeaverPlan,
]);
export type CardPlan = typeof CardPlan.Type;
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
