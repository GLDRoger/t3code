import * as KinShell from "../shell/KinShell.ts";
import {
  KinChatError,
  KinCompanyBank,
  KinCompanyBrand,
  KinCompanyProfileSetInput,
  type KinDateRow,
  kinDateRowLate,
  KinDay,
  KinGstin,
  KinWritableListFieldType,
  KinListId,
  type KinMoney,
  KinRecordKey,
  KinChatId,
  KinRecordState,
  KinSacCode,
  KinWakeupId,
  KinWidgetId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KinToolText } from "./leadSchemas.ts";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { takeLogo } from "../gendocs/brand.ts";
import { KinDocRenderer } from "../gendocs/render.ts";
import { turnChat } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as CardActions from "../widgets/cardActions.ts";
import { sealPlans } from "../widgets/cardPlans.ts";
import { budgetsAnswer, budgetsView, setBudget } from "./budgets.ts";
import {
  agentProfile,
  attachChangeCard,
  changeLines,
  countryFirst,
  proposeChange,
  readProfile,
  replaceOlderChanges,
} from "./companyProfile.ts";
import { KinRecords } from "./KinRecords.ts";
import {
  admitted,
  type Lead,
  leadTool,
  ownerAsked,
  Project,
  refOrNull,
  retryKey,
  sourceOf,
  viewOf,
  writerFor,
  countryWorded,
} from "./leadWork.ts";
import { cashAnswer, cashPosition, outlook, outlookAnswer } from "./moneyAnswers.ts";
import { partnersAnswer, partnersOwed, partnersUnsaid } from "./partnersOwed.ts";
import { BankAnswer, bankAnswer, bankKnown } from "./statements/bankKnown.ts";
import { homeCurrency, notRegisteredFact } from "./companyProfile.ts";
import { dayIn, formatMinor, formatMoney, parseAmount, timeIn } from "./money.ts";
import { parseFields } from "./lists.ts";
import {
  dates,
  datesOnce,
  invoiceDays,
  isInvoice,
  moneySection,
  moneySummaryForAgent,
  ownerLevelStillToInvoice,
} from "./moneyViews.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "./teamView.ts";
import {
  endOfDay,
  iso,
  isSuggestion,
  notFound,
  ownerZone,
  recordName,
  suggestedStateLabel,
} from "./recordRows.ts";
import {
  attachCard,
  carryOut,
  checkText,
  type FieldDef,
  OWN_DATE,
  remindTarget,
  isUnissuedDraft,
  listDef,
  PRESET_IDS,
  propose,
  proposalFor,
  stateLabel,
  storedProposal,
  isRecipeList,
  listOrPreset,
  unknownList,
} from "./registers.ts";
import { TurnEvent } from "../lead/eventIds.ts";
import { DAY_MS } from "../durations.ts";
import { setAsideOverdue } from "../pulse/invoiceAsides.ts";

/** The lead tools for lists and money. Model-facing text lives in `mcp/tools.ts`. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** The most a choice card's detail holds (`KinChoiceCardState`). */
const CARD_DETAIL_MAX = 2000;
const tooLongForCard = (detail: string) =>
  detail.length <= CARD_DETAIL_MAX
    ? undefined
    : invalid(
        "The owner's card can't show all of this change, so nothing was stored or asked. Change fewer fields per request.",
      );

/**
 * A yes/no choice card Kin posts for a lead, so the owner's tap answers exactly the one thing it
 * was made for, bound to it by `bind` in the card's own commit. A retry with the same
 * `clientMessageId` finds the same card. Its detail is shown whole or not at all.
 */
/** The yes option's id on an `askOwner` card: it is listed first. */
const OWNER_CARD_YES = "option-1";

export const askOwner = Effect.fn("KinOwnerCards.ask")(function* (
  lead: Lead,
  input: {
    readonly chatId: string;
    readonly clientMessageId: string;
    readonly question: string;
    readonly detail: string;
    readonly yes: string;
    readonly no: string;
    readonly image?: { readonly attachmentId: string; readonly mimeType: string };
  },
  bind: (widgetId: string) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>,
) {
  const refused = tooLongForCard(input.detail);
  if (refused !== undefined) return yield* refused;
  const sql = yield* SqlClient.SqlClient;
  const widget = yield* (yield* KinLevelGate).ask(
    { ...lead, wakeupId: KinWakeupId.make(lead.wakeupId) },
    {
      chatId: KinChatId.make(input.chatId),
      clientMessageId: input.clientMessageId,
      question: input.question,
      detail: input.detail,
      options: [
        { label: input.yes, kind: "yes" },
        { label: input.no, kind: "no" },
      ],
      ...(input.image === undefined ? {} : { image: input.image }),
    },
    (card) => bind(card.widgetId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  );
  return widget.widgetId;
});

const Label = KinToolText(60);
const FieldInput = Schema.Struct({
  label: Label,
  type: Schema.Literals([...KinWritableListFieldType.literals, "number", "yesno"]),
  choices: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  link: Schema.optional(Schema.Literals(["clients", "projects"])),
  sensitive: Schema.optional(Schema.Boolean),
});
const StateNames = Schema.Struct({
  open: Schema.optional(Label),
  doing: Schema.optional(Label),
  waiting: Schema.optional(Label),
  done: Schema.optional(Label),
  dropped: Schema.optional(Label),
});

export const DefineInput = Schema.Struct({
  sourceEventId: TurnEvent,
  proposal: Schema.optional(KinToolText(40)).annotate({
    description: "A proposal this tool returned in an earlier turn: creates exactly that.",
  }),
  template: Schema.optional(Schema.Literals(PRESET_IDS)).annotate({
    description: "Start from Kin's expenses, invoices, dates, receipts or quotes list.",
  }),
  list: Schema.optional(KinListId).annotate({
    description: "An existing defined list to add fields, choices or categories to.",
  }),
  name: Schema.optional(Label),
  noun: Schema.optional(Label).annotate({ description: 'One entry, such as "leave request".' }),
  prefix: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,5}$/))),
  fields: Schema.optional(Schema.Array(FieldInput).check(Schema.isMaxLength(20))),
  categories: Schema.optional(Schema.Array(Label).check(Schema.isMaxLength(30))),
  states: Schema.optional(Schema.Array(KinRecordState).check(Schema.isMinLength(1))),
  stateNames: Schema.optional(StateNames),
  amount: Schema.optional(Schema.Boolean).annotate({
    description: "Entries carry an amount (sums and totals come with it).",
  }),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
  sensitive: Schema.optional(Schema.Boolean),
  team: Schema.optional(Schema.Boolean).annotate({
    description:
      "True when the whole team works on this list: every teammate sees and adds its entries.",
  }),
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
  section: Schema.optional(Schema.Boolean).annotate({
    description: "Also show the list as a section of its own.",
  }),
  dock: Schema.optional(Schema.Boolean).annotate({
    description: "With section: in the phone's dock too.",
  }),
  remindOn: Schema.optional(Schema.NullOr(Label)).annotate({
    description:
      "The date Kin reminds an entry's holder on, as on a task's due day: a date field or the list's own date; null stops.",
  }),
  check: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        field: Label,
        below: Schema.optional(Schema.Union([Label, Schema.Finite])),
        above: Schema.optional(Schema.Union([Label, Schema.Finite])),
      }),
    ),
  ).annotate({
    description:
      "Warn once per entry when a number field is below or above a number or field; null stops.",
  }),
});
const ShownField = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.String,
  choices: Schema.optional(Schema.Array(Schema.String)),
});
export const DefineResult = Schema.Struct({
  status: Schema.Literals(["proposed", "defined"]),
  proposal: Schema.optional(Schema.String),
  list: Schema.String,
  name: Schema.String,
  fields: Schema.Array(ShownField),
  categories: Schema.Array(Schema.String),
  states: Schema.Array(Schema.String),
  amount: Schema.Boolean,
  next: Schema.String,
});

const shownFields = (fields: ReadonlyArray<FieldDef>) =>
  fields
    .filter((one) => one.retired !== true)
    .map((one) => ({
      key: one.key,
      label: one.label,
      type: one.type,
      ...(one.choices === undefined ? {} : { choices: [...one.choices] }),
    }));

function fieldLine(field: (typeof ShownField)["Type"]) {
  const type =
    field.choices !== undefined
      ? `one of: ${field.choices.join(", ")}`
      : field.type === "money"
        ? "amount"
        : field.type === "yesno"
          ? "yes or no"
          : field.type
              .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
              .replace(/_/g, " ")
              .toLowerCase();
  return `${field.label} (${type})`;
}

const describeDefined = Effect.fn("KinWorkTools.describeDefined")(function* (
  lead: Lead,
  id: string,
) {
  const def = yield* listDef(lead.orgId, id);
  if (def === undefined) return yield* unknownList(id);
  return {
    list: def.id,
    name: def.name,
    fields: shownFields(def.fields),
    categories: [...def.categories],
    states: def.states.map((state) => `${state} (${stateLabel(def, state)})`),
    amount: def.amount,
  };
});

const runDefine = Effect.fnUntraced(function* (lead: Lead, input: typeof DefineInput.Type) {
  yield* admitted(lead, "list_define", input);
  yield* sourceOf(lead, input.sourceEventId);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  if (input.proposal !== undefined) {
    const done = yield* sql.withTransaction(
      carryOut({
        orgId: lead.orgId,
        agentId: lead.agentId,
        wakeupId: lead.wakeupId,
        proposalId: input.proposal,
        now,
      }),
    );
    return {
      status: "defined" as const,
      proposal: input.proposal,
      ...(yield* describeDefined(lead, done.id)),
      next: "Created. Say so in one line, without listing the fields again.",
    };
  }
  // Only the template named: the preset as it ships, which a recipe already knows.
  const plainRecipe =
    input.template !== undefined &&
    isRecipeList(input.template) &&
    Object.entries(input).every(
      ([key, value]) => key === "sourceEventId" || key === "template" || value === undefined,
    );
  if (plainRecipe) {
    const def = yield* listOrPreset(lead.orgId, input.template!, now);
    if (def !== undefined) {
      const made: typeof DefineResult.Type = {
        status: "defined",
        ...(yield* describeDefined(lead, def.id)),
        next: "Kin's own list, made as it ships; no card needed. Go on with the quote or invoice.",
      };
      return made;
    }
  }
  const asked = yield* proposalFor(lead.orgId, input);
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("This turn has no chat to propose a list in.");
  const proposalId = yield* propose({
    orgId: lead.orgId,
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
    chatId: chat.chatId,
    proposal: asked,
    now,
  });
  // An open proposal of this list is the one its card shows, so the turn reads that one.
  const proposal = (yield* storedProposal(lead.orgId, proposalId)) ?? asked;
  const shown =
    proposal._tag === "new"
      ? {
          list: proposal.id,
          name: proposal.name,
          fields: shownFields(proposal.definition.fields),
          categories: [...proposal.definition.categories],
          states: proposal.definition.states.map(
            (state) => `${state} (${proposal.definition.stateLabels[state] ?? state})`,
          ),
          amount: proposal.definition.amount,
        }
      : {
          ...(yield* describeDefined(lead, proposal.id)),
          fields: shownFields(proposal.fields),
          categories: [...proposal.categories],
        };
  // A new list's yes runs as the card's own action, so the tap makes it with no turn to wake;
  // a turn that couldn't make it here offers the plain card. A typed yes works without either.
  const chatId = KinChatId.make(chat.chatId);
  const create =
    proposal._tag === "new"
      ? yield* CardActions.draw(lead, chatId, { kind: "create_list", target: proposalId }).pipe(
          Effect.map((drawn) => drawn.plan),
          Effect.catchTags({ KinChatError: () => Effect.undefined }),
        )
      : undefined;
  const teamChange = proposal._tag === "new" ? proposal.definition.team : proposal.team;
  const had = proposal._tag === "new" ? undefined : yield* listDef(lead.orgId, proposal.id);
  const watched =
    proposal._tag === "new"
      ? proposal.definition
      : { ...proposal, fields: [...(had?.fields ?? []), ...proposal.fields] };
  const labels: {
    readonly dateLabel?: string | undefined;
    readonly dueLabel?: string | undefined;
  } = proposal._tag === "new" ? proposal.definition : (had ?? {});
  const label = (key: string) => watched.fields.find((one) => one.key === key)?.label ?? key;
  const onDue =
    typeof input.remindOn === "string" &&
    remindTarget(watched.fields, labels, input.remindOn) === "due";
  const reminder =
    watched.remindOn === OWN_DATE
      ? (labels.dateLabel ?? "date")
      : watched.remindOn !== undefined
        ? label(watched.remindOn)
        : onDue
          ? (labels.dueLabel ?? "due")
          : undefined;
  // The card is how a tap answers this proposal and no other; a typed yes still works without it.
  const card = yield* askOwner(
    lead,
    {
      chatId: chat.chatId,
      clientMessageId: `kin-list:${proposalId}`,
      question: `${proposal._tag === "new" ? "Create the list" : "Add to"} ${shown.name}?`,
      detail: [
        ...shown.fields.map(fieldLine),
        ...(shown.categories.length === 0 ? [] : [`Categories: ${shown.categories.join(", ")}`]),
        ...(teamChange === true
          ? ["The whole team will see and add entries."]
          : teamChange === false && proposal._tag === "extend"
            ? ["The team will no longer see this list."]
            : []),
        ...(proposal.section === true
          ? [
              `${shown.name} will show as a section of its own${proposal.dock === true ? ", and in the phone's dock" : ""}.`,
            ]
          : []),
        ...(watched.check === undefined
          ? []
          : [`Kin will warn about each entry whose ${checkText(watched.fields, watched.check)}.`]),
        ...(reminder === undefined
          ? []
          : [`Kin will remind whoever holds an entry on its ${reminder} day.`]),
        ...(proposal._tag === "extend" && proposal.unwatch?.includes("check") === true
          ? ["Kin will stop warning about its entries."]
          : []),
        ...(proposal._tag === "extend" && proposal.unwatch?.includes("remindOn") === true && !onDue
          ? ["Kin will stop reminding on its entries' date."]
          : []),
      ].join("\n"),
      yes: proposal._tag === "new" ? "Create it" : "Add them",
      no: "Not now",
    },
    (widgetId) =>
      Effect.gen(function* () {
        yield* attachCard({ orgId: lead.orgId, proposalId, widgetId });
        if (create !== undefined)
          yield* sealPlans({
            orgId: lead.orgId,
            chatId,
            widgetId: KinWidgetId.make(widgetId),
            plans: [{ optionId: OWNER_CARD_YES, plan: create }],
            now,
          });
      }),
  ).pipe(
    Effect.catchTags({
      KinChatError: (error) =>
        Effect.logWarning("Kin couldn't show a list proposal card", { reason: error.reason }).pipe(
          Effect.as(undefined),
        ),
    }),
  );
  return {
    status: "proposed" as const,
    proposal: proposalId,
    ...shown,
    next:
      card === undefined
        ? "Nothing is created yet. Put these fields to the owner in one short message and ask. Once they say yes, call list_define with this proposal in that later turn."
        : "Nothing is created yet. Kin has posted the card that asks the owner, with Create it and Not now: add no kin_ask or card of your own. Ask in one short line without listing the fields again. Once they tap yes or say yes, call list_define with this proposal in that later turn.",
  };
});
export const define = leadTool("KinWorkTools.define", runDefine);

export const PaymentInput = Schema.Struct({
  sourceEventId: TurnEvent,
  key: KinRecordKey.annotate({ description: "The invoice, such as INV-4." }),
  amount: Schema.optional(KinToolText(60)).annotate({
    description:
      'The cash that came in, as said: "1,20,000" or "1.2 lakh". In the invoice\'s currency.',
  }),
  withheld: Schema.optional(KinToolText(60)).annotate({
    description:
      'TDS the client deducted, as said, such as "18,000": it settles the invoice but is not cash received.',
  }),
  paidOn: Schema.optional(KinDay).annotate({
    description: "The day it was received, in the owner's time zone.",
  }),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  void: Schema.optional(KinToolText(60)).annotate({
    description: "A paymentId from record_get to take back instead.",
  }),
});
export const PaymentResult = Schema.Struct({
  key: Schema.String,
  state: Schema.String,
  amount: Schema.String,
  /** Cash received only; TDS the client deducted is `tdsWithheld`. */
  received: Schema.String,
  tdsWithheld: Schema.optional(Schema.String),
  balance: Schema.String,
  paymentId: Schema.optional(Schema.String),
  tdsPaymentId: Schema.optional(Schema.String),
  sensitive: Schema.Literal(true),
});

const runPayment = Effect.fnUntraced(function* (lead: Lead, input: typeof PaymentInput.Type) {
  yield* admitted(lead, "payment_record", input);
  yield* sourceOf(lead, input.sourceEventId);
  const records = yield* KinRecords;
  const writer = yield* writerFor(lead);
  const before = yield* records.get(lead.orgId, input.key);
  if (before === undefined) return yield* notFound(input.key);
  // A suggestion's refusal says who keeps it, which comes before issuing it.
  if (
    input.void === undefined &&
    !isSuggestion(before) &&
    (yield* isUnissuedDraft(lead.orgId, before))
  )
    return yield* invalid(
      `${before.key} is a draft, so nothing is owed on it yet. Issue it first with kin_issue, which takes its date as the issue day (else today; set date with record_update first if the owner gave another), then record the payment.`,
    );
  let paymentId: string | undefined;
  let tdsPaymentId: string | undefined;
  if (input.void !== undefined) {
    yield* records.voidPayment(lead.orgId, writer, input.key, input.void);
  } else {
    const paidOn = input.paidOn;
    if ((input.amount === undefined && input.withheld === undefined) || paidOn === undefined)
      return yield* invalid(
        "A payment needs amount (cash received), withheld (TDS) or both, and paidOn; or void to take one back.",
      );
    const fallback = before.currency ?? (yield* homeCurrency(lead.orgId));
    const parsed = (text: string | undefined) => {
      if (text === undefined) return Effect.undefined;
      const one = parseAmount(text, fallback);
      return "error" in one ? Effect.fail(one.error) : Effect.succeed(one.money);
    };
    const cash = yield* parsed(input.amount);
    const tds = yield* parsed(input.withheld);
    // One settlement per owner message, entry and day, whatever its parts: a retry finds it.
    const settlement = `lead:${lead.agentId}:${input.sourceEventId}:${retryKey(`${input.key}|settlement|${paidOn}`)}`;
    const sql = yield* SqlClient.SqlClient;
    // The cash and the tax withheld are recorded together or not at all.
    const settled = yield* sql.withTransaction(
      Effect.gen(function* () {
        const earlier = yield* sql<{ part: string; minor: number; note: string }>`SELECT
            substr(origin_key, ${settlement.length + 2}) AS part, amount_minor AS minor, note
          FROM kin_record_payments
          WHERE org_id = ${lead.orgId} AND origin_key IN (${`${settlement}:cash`},
            ${`${settlement}:tds`})
          ORDER BY origin_key`;
        const was = (part: string) => earlier.find((one) => one.part === part);
        const same = (part: string, money: KinMoney | undefined) =>
          money === undefined
            ? was(part) === undefined
            : was(part)?.minor === money.minor && was(part)?.note === (input.note ?? "");
        if (earlier.length > 0 && !(same("cash", cash) && same("tds", tds)))
          return yield* new KinChatError({
            reason: "not_allowed",
            message: `This message already recorded a different payment on ${recordName(before.key, parseFields(before.fieldsJson).number)} for ${paidOn}. Nothing was recorded. To correct it, void the earlier payment and record the right one from the owner's next message.`,
          });
        const one = (money: KinMoney | undefined, withheld: boolean) =>
          money === undefined
            ? Effect.undefined
            : records
                .pay(lead.orgId, writer, input.key, {
                  amount: money,
                  paidOn,
                  ...(input.note === undefined ? {} : { note: input.note }),
                  ...(withheld ? { withheld: true } : {}),
                  originKey: `${settlement}:${withheld ? "tds" : "cash"}`,
                })
                .pipe(Effect.map((paid) => paid.paymentId));
        return { cash: yield* one(cash, false), tds: yield* one(tds, true) };
      }),
    );
    paymentId = settled.cash ?? settled.tds;
    tdsPaymentId = settled.tds;
  }
  const after = yield* records.get(lead.orgId, input.key);
  if (after === undefined) return yield* notFound(input.key);
  const currency = after.currency ?? (yield* homeCurrency(lead.orgId));
  const amount = after.amountMinor ?? 0;
  return {
    key: after.key,
    state: after.state,
    amount: formatMoney({ minor: amount, currency }),
    received: formatMoney({ minor: after.paid - after.withheld, currency }),
    ...(after.withheld === 0
      ? {}
      : { tdsWithheld: formatMoney({ minor: after.withheld, currency }) }),
    balance: formatMoney({ minor: Math.max(amount - after.paid, 0), currency }),
    ...(paymentId === undefined ? {} : { paymentId }),
    ...(tdsPaymentId === undefined ? {} : { tdsPaymentId }),
    sensitive: true as const,
  };
});
export const payment = leadTool("KinWorkTools.payment", runPayment);

export const MoneyResult = Schema.Struct({
  asOf: Schema.String,
  summary: Schema.optional(Schema.Unknown),
  /** Per open project: what is agreed but not invoiced yet, beside what is owed on invoices. */
  stillToInvoice: Schema.optional(Schema.Unknown),
  nothing: Schema.optional(Schema.Literal(true)),
  bank: Schema.optional(BankAnswer),
  /** The company said it is not registered for its tax. */
  taxNote: Schema.optional(Schema.String),
  sensitive: Schema.Literal(true),
});
const runMoney = Effect.fnUntraced(function* (lead: Lead, _input: unknown) {
  const now = yield* Clock.currentTimeMillis;
  // In a turn others read: figures of only the money lines they all see, such as their project's.
  const team = yield* viewOf(lead);
  const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people);
  const shell = yield* KinShell.get(lead.orgId);
  const invoices = KinShell.sectionOn(shell, "invoices");
  const clientsOn = KinShell.sectionOn(shell, "clients");
  const summary = yield* moneySummaryForAgent(lead.orgId, now, viewer);
  const section = moneySection(
    summary,
    summary.timeZone,
    invoices ? yield* setAsideOverdue({ orgId: lead.orgId, now, viewer, clientsOn }) : [],
    clientsOn,
  );
  const toInvoice =
    team === undefined && invoices ? yield* ownerLevelStillToInvoice(lead.orgId) : [];
  const taxNote =
    team === undefined ? notRegisteredFact(yield* readProfile(lead.orgId)) : undefined;
  return {
    asOf: iso(now),
    ...(section === undefined && toInvoice.length === 0
      ? { nothing: true as const }
      : { summary: section }),
    ...(toInvoice.length === 0 ? {} : { stillToInvoice: toInvoice }),
    bank: bankAnswer(yield* bankKnown(lead.orgId)),
    ...(taxNote === undefined ? {} : { taxNote }),
    sensitive: true as const,
  };
});
export const money = leadTool("KinWorkTools.money", runMoney);

const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])$/));
export const MoneyQueryInput = Schema.Struct({
  view: Schema.Literals(["cash", "outlook", "budgets", "partners"]).annotate({
    description:
      "cash: balances from the bank statements Kin read. outlook: due in and out ahead, and runway. budgets: this month's spending against each limit. partners: what the company owes each partner back for expenses they paid themselves.",
  }),
  days: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(366)),
  ).annotate({
    description: "outlook only: one window this many days ahead instead of 30, 60 and 90.",
  }),
  month: Schema.optional(Month).annotate({
    description: "budgets only: another month, such as 2026-10.",
  }),
});
export const MoneyQueryResult = Schema.Struct({
  asOf: Schema.String,
  view: Schema.String,
  answer: Schema.Unknown,
  bank: Schema.optional(BankAnswer),
  sensitive: Schema.Literal(true),
});
const runMoneyQuery = Effect.fnUntraced(function* (lead: Lead, input: typeof MoneyQueryInput.Type) {
  yield* admitted(lead, "money_query", input);
  const now = yield* Clock.currentTimeMillis;
  const cash = input.view === "cash" ? yield* cashPosition(lead.orgId, now) : undefined;
  const answer =
    cash !== undefined
      ? cashAnswer(cash)
      : input.view === "outlook"
        ? outlookAnswer(yield* outlook(lead.orgId, now, input.days))
        : input.view === "partners"
          ? partnersAnswer(
              yield* partnersOwed(lead.orgId, yield* homeCurrency(lead.orgId)),
              yield* partnersUnsaid(lead.orgId, yield* homeCurrency(lead.orgId)),
              yield* ownerZone(lead.orgId),
            )
          : budgetsAnswer(yield* budgetsView(lead.orgId, now, input.month));
  const bank = bankAnswer(cash?.bank ?? (yield* bankKnown(lead.orgId)), cash !== undefined);
  return { asOf: iso(now), view: input.view, answer, bank, sensitive: true as const };
});
export const moneyQuery = leadTool("KinWorkTools.moneyQuery", runMoneyQuery);

export const BudgetInput = Schema.Struct({
  sourceEventId: TurnEvent,
  category: Schema.optional(Label).annotate({
    description: "One of the expenses list's categories.",
  }),
  project: Schema.optional(Project),
  limit: Schema.NullOr(KinToolText(60)).annotate({
    description: 'The monthly limit as said: "50k", "₹1,20,000". null removes the budget.',
  }),
  currency: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/))),
});
export const BudgetResult = Schema.Struct({
  status: Schema.Literals(["set", "removed", "none"]),
  was: Schema.String,
  now: Schema.String,
  next: Schema.String,
  answer: Schema.Unknown,
  sensitive: Schema.Literal(true),
});
const runBudget = Effect.fnUntraced(function* (lead: Lead, input: typeof BudgetInput.Type) {
  yield* admitted(lead, "budget_set", input);
  yield* sourceOf(lead, input.sourceEventId);
  if (!(yield* ownerAsked(lead, input.sourceEventId)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message:
        "A budget is set only from the owner's own message or tap; this turn wasn't one (a routine, schedule, hand-over or report). Nothing changed. Propose it to the owner instead: the budget, the limit and why.",
    });
  if (input.category === undefined && input.project === undefined)
    return yield* invalid("A budget is for a category, a project, or a category in a project.");
  if (input.limit !== null) yield* countryWorded(lead, true, countryFirst(lead.orgId));
  const expenses = yield* listDef(lead.orgId, "expenses");
  if (expenses === undefined)
    return yield* invalid("There is no expenses list yet: track expenses first.");
  const category =
    input.category === undefined
      ? null
      : expenses.categories.find((one) => one.toLowerCase() === input.category!.toLowerCase());
  if (category === undefined)
    return yield* invalid(
      `Expenses have no category ${input.category!.slice(0, 60)}. They have: ${expenses.categories.join(", ")}.`,
    );
  const projectId = (yield* refOrNull(lead, input.project, "projects")) ?? null;
  const parsed =
    input.limit === null
      ? undefined
      : parseAmount(input.limit, input.currency ?? expenses.currency);
  if (parsed !== undefined && "error" in parsed) return yield* parsed.error;
  const now = yield* Clock.currentTimeMillis;
  const done = yield* setBudget(
    lead.orgId,
    {
      category,
      projectId,
      currency: parsed?.money.currency ?? input.currency,
      limitMinor: parsed?.money.minor ?? null,
      sourceEventId: input.sourceEventId,
    },
    { kind: "agent", id: lead.agentId },
    now,
  );
  const amount = (minor: bigint | null) =>
    minor === null || done.currency === null ? "none" : formatMinor(minor, done.currency);
  const was = amount(done.was);
  const after = amount(parsed === undefined ? null : BigInt(parsed.money.minor));
  return {
    status: done.outcome,
    was,
    now: after,
    next:
      done.outcome === "none"
        ? "There was no such budget, so nothing was removed. Say so in one line."
        : `Tell the owner in one line that it was ${was} and is now ${after}.`,
    answer: budgetsAnswer(yield* budgetsView(lead.orgId, now)),
    sensitive: true as const,
  };
});
export const budget = leadTool("KinWorkTools.budget", runBudget);

export const DatesInput = Schema.Struct({
  from: KinDay,
  to: KinDay.annotate({ description: "The last day, included." }),
  lists: Schema.optional(Schema.Array(KinListId).check(Schema.isMaxLength(20))),
  open: Schema.optional(Schema.Boolean).annotate({
    description: "Default true: only what is neither done nor dropped.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
});
export const DatesResult = Schema.Struct({
  asOf: Schema.String,
  total: Schema.Number,
  dates: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      list: Schema.String,
      state: Schema.String,
      /** What the day is and the day, for anything but an invoice. */
      what: Schema.optional(Schema.String),
      on: Schema.optional(Schema.String),
      /** An invoice's days in range, on one entry: issued (a suggestion's "date"), and due. */
      issued: Schema.optional(Schema.String),
      date: Schema.optional(Schema.String),
      due: Schema.optional(Schema.String),
      /** Its due day has passed. Nothing else is ever late. */
      late: Schema.optional(Schema.Literal(true)),
      amount: Schema.optional(Schema.String),
      sensitive: Schema.optional(Schema.Literal(true)),
    }),
  ),
});
const runDates = Effect.fnUntraced(function* (lead: Lead, input: typeof DatesInput.Type) {
  const zone = yield* ownerZone(lead.orgId);
  const from = endOfDay(input.from, zone) - DAY_MS + 1;
  const to = endOfDay(input.to, zone) + 1;
  if (to <= from) return yield* invalid("to is on or after from.");
  const now = yield* Clock.currentTimeMillis;
  const team = yield* viewOf(lead);
  const page = yield* dates(
    lead.orgId,
    {
      from,
      to,
      lists: input.lists,
      shell: yield* KinShell.get(lead.orgId),
      open: input.open ?? true,
      limit: input.limit ?? 30,
      viewer: team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people),
    },
    now,
  );
  const entries = datesOnce(page.rows);
  const day = (row: KinDateRow) =>
    row.allDay ? dayIn(Date.parse(row.at), zone) : timeIn(Date.parse(row.at), zone);
  return {
    asOf: iso(now),
    // The total counts an invoice's two days twice wherever both are listed.
    total: page.total - (page.rows.length - entries.length),
    dates: entries.map((entry): (typeof DatesResult.Type)["dates"][number] => {
      const row = entry[0]!;
      const { record } = row;
      return {
        key: record.key,
        title: record.title,
        list: row.listName,
        state:
          record.confirmed || record.state === "dropped"
            ? row.stateLabel
            : suggestedStateLabel(record.list ?? "work", record.state, row.stateLabel),
        ...(isInvoice(entry)
          ? invoiceDays(entry, day)
          : {
              what: row.label,
              on: day(row),
              ...(kinDateRowLate(row) ? { late: true as const } : {}),
            }),
        ...(record.amount === undefined
          ? {}
          : { amount: formatMoney(record.amount), sensitive: true as const }),
        ...(record.sensitive || record.sensitiveInherited === true
          ? { sensitive: true as const }
          : {}),
      };
    }),
  };
});
export const datesQuery = leadTool("KinWorkTools.dates", runDates);

const ProfileText = Schema.NullOr(KinToolText(500));
export const ProfileInput = Schema.Struct({
  sourceEventId: Schema.optional(TrimmedNonEmptyString),
  set: Schema.optional(
    Schema.Struct({
      legalName: Schema.optional(ProfileText),
      tradeName: Schema.optional(ProfileText),
      address: Schema.optional(ProfileText),
      gstin: Schema.optional(Schema.NullOr(KinGstin)),
      pan: Schema.optional(
        Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Z]{5}\d{4}[A-Z]$/))),
      ),
      placeOfSupply: Schema.optional(ProfileText),
      sac: Schema.optional(Schema.NullOr(KinSacCode)),
      lutNumber: KinCompanyProfileSetInput.fields.lutNumber,
      lutDate: KinCompanyProfileSetInput.fields.lutDate,
      bank: Schema.optional(
        Schema.Struct({
          accountName: Schema.optional(KinCompanyBank.fields.accountName),
          accountNumber: Schema.optional(KinCompanyBank.fields.accountNumber),
          ifsc: Schema.optional(KinCompanyBank.fields.ifsc),
          bankName: Schema.optional(KinCompanyBank.fields.bankName),
          branch: Schema.optional(KinCompanyBank.fields.branch),
          upi: Schema.optional(KinCompanyBank.fields.upi),
        }),
      ),
      logo: Schema.optional(Schema.NullOr(KinToolText(128))),
      brand: Schema.optional(
        Schema.Struct({
          primaryColor: Schema.optional(KinCompanyBrand.fields.primaryColor),
          secondaryColor: Schema.optional(KinCompanyBrand.fields.secondaryColor),
          font: Schema.optional(KinCompanyBrand.fields.font),
          footer: Schema.optional(KinCompanyBrand.fields.footer),
        }),
      ),
    }),
  ),
});
export const ProfileResult = Schema.Struct({
  profile: Schema.Record(Schema.String, Schema.Unknown),
  rev: Schema.Number,
  /** What a set asked for, waiting on the owner's Confirm on the card Kin showed them. */
  proposed: Schema.optional(Schema.Array(Schema.String)),
  next: Schema.optional(Schema.String),
  /** The company said it is not registered for its tax. */
  taxNote: Schema.optional(Schema.String),
  /** A new company's country isn't chosen: Kin knows no currency or tax for it yet. */
  countryNeeded: Schema.optional(Schema.String),
  sensitive: Schema.Literal(true),
});
const runProfile = Effect.fnUntraced(function* (lead: Lead, input: typeof ProfileInput.Type) {
  yield* admitted(lead, "company_profile", input);
  const { profile: current, shown, countryNeeded } = yield* agentProfile(lead.orgId);
  const { rev, updatedAt: _updatedAt, bank, ...rest } = shown;
  let proposed: ReadonlyArray<string> | undefined;
  if (input.set !== undefined) {
    if (input.sourceEventId === undefined)
      return yield* invalid("Pass this turn's sourceEventId to change the profile.");
    yield* sourceOf(lead, input.sourceEventId);
    const { logo: logoId, ...fields } = input.set;
    // The logo is an image the owner sent in this chat, copied now so clearing the chat keeps it.
    const taken =
      typeof logoId === "string"
        ? yield* takeLogo(lead.orgId, (yield* writerFor(lead)).chatId, logoId)
        : undefined;
    // Drawn once as documents draw it, where Typst is here already, so the card shows a real logo.
    const renderer = yield* Effect.serviceOption(KinDocRenderer);
    const undrawable =
      taken === undefined || Option.isNone(renderer)
        ? undefined
        : yield* renderer.value.drawable({ bytes: taken.bytes, extension: taken.extension });
    if (undrawable !== undefined)
      return yield* invalid(
        `That logo can't be used: it didn't draw (${undrawable}). Send it again or as a PNG. Nothing changed.`,
      );
    const patch = {
      ...fields,
      ...(logoId === undefined ? {} : { logo: taken?.logo ?? null }),
    };
    const lines = changeLines(current, patch);
    const refused = tooLongForCard(lines.join("\n"));
    if (refused !== undefined) return yield* refused;
    if (lines.length > 0) {
      // Asked where the turn was asked: a co-owner's turn can't post in the owner's own chat.
      const chat = yield* turnChat(lead);
      if (chat === undefined) return yield* invalid("There is no owner chat to confirm this in.");
      const changeId = `pc_${retryKey(`${lead.orgId}|${lead.agentId}|${lead.wakeupId}|${rev}|${stableStringify(patch)}`)}`;
      yield* proposeChange({
        orgId: lead.orgId,
        changeId,
        agentId: lead.agentId,
        wakeupId: lead.wakeupId,
        patch,
        baseRev: rev,
        now: yield* Clock.currentTimeMillis,
      });
      // Bank details and tax ids go on invoices: they change only by the owner's own Confirm.
      yield* askOwner(
        lead,
        {
          chatId: chat.chatId,
          clientMessageId: `kin-profile:${changeId}`,
          question: "Change the company profile?",
          detail: lines.join("\n"),
          yes: "Confirm",
          no: "Cancel",
          ...(taken === undefined ? {} : { image: taken.shown }),
        },
        (widgetId) => attachChangeCard(lead.orgId, changeId, widgetId),
      );
      yield* (yield* KinLevelGate).closeReplaced(
        lead,
        yield* replaceOlderChanges(lead.orgId, changeId, yield* Clock.currentTimeMillis),
      );
      proposed = lines;
    }
  }
  const kept = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([, one]) => one !== null));
  const shownBank = kept(bank);
  const taxNote = notRegisteredFact(current);
  return {
    profile: { ...kept(rest), ...(Object.keys(shownBank).length === 0 ? {} : { bank: shownBank }) },
    rev,
    ...(proposed === undefined
      ? {}
      : {
          proposed: [...proposed],
          next: "Nothing has changed yet. Kin showed this change on a card in this chat; it applies when they tap Confirm. Say so in one line.",
        }),
    ...(taxNote === undefined ? {} : { taxNote }),
    ...(countryNeeded === undefined ? {} : { countryNeeded }),
    sensitive: true as const,
  };
});
export const profile = leadTool("KinWorkTools.profile", runProfile);
