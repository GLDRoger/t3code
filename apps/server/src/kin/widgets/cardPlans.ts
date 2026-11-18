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
const CARD_ACTIONS = ["done", "drop", "start", "create_list", "take_default"] as const;
export const CardActionInput = Schema.Struct({
  kind: Schema.Literals(CARD_ACTIONS),
  target: KinTrimmedText.check(Schema.isMaxLength(200)),
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
  /** The list's revision when the proposal adds to one; null when it makes a new one. */
  listRev: Schema.NullOr(Schema.Number),
  draw: CardDraw,
});
const RunPlan = Schema.Union([RecordPlan, StartPlan, ListPlan]);
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
export const CardPlan = Schema.Union([RecordPlan, StartPlan, ListPlan, DefaultPlan]);
export type CardPlan = typeof CardPlan.Type;
const PlanJson = Schema.fromJsonString(CardPlan);
const encodePlan = Schema.encodeEffect(PlanJson);
const decodePlan = Schema.decodeUnknownOption(PlanJson);

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
  readonly widgetId: string;
  readonly optionId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ json: string; ran: string | null }>`SELECT plan_json AS json,
      ran_message_id AS ran FROM kin_card_plans
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND option_id = ${input.optionId}`;
  if (row === undefined) return undefined;
  // A row nobody can read runs nothing: the tap is refused rather than taken as plain.
  const plan = Option.getOrUndefined(decodePlan(row.json));
  return { plan, ran: row.ran === null ? null : KinMessageId.make(row.ran) };
});

/** Every option of a card that runs an action, by option id. */
export const plansOf = Effect.fn("KinCardPlans.plansOf")(function* (
  orgId: KinOrgId,
  widgetId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ optionId: string; json: string }>`SELECT option_id AS "optionId",
      plan_json AS json FROM kin_card_plans
    WHERE org_id = ${orgId} AND widget_id = ${widgetId} ORDER BY option_id`;
  return new Map(
    rows.flatMap((row) => {
      const plan = Option.getOrUndefined(decodePlan(row.json));
      return plan === undefined ? [] : [[row.optionId, plan] as const];
    }),
  );
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
