import {
  KinChatError,
  KinCompanyBank,
  KinDay,
  KinGstin,
  KinListFieldType,
  KinListId,
  KinRecordKey,
  KinRecordState,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChat } from "../lead/Audience.ts";
import { readProfile, setProfile } from "./companyProfile.ts";
import { KinRecords } from "./KinRecords.ts";
import {
  admitted,
  askedBy,
  type Lead,
  leadTool,
  retryKey,
  sourceOf,
  writerFor,
} from "./leadWork.ts";
import { dayIn, formatMoney, isCurrency, parseAmount } from "./money.ts";
import { dates, moneySection, moneySummary } from "./moneyViews.ts";
import { endOfDay, iso, notFound, ownerZone } from "./recordRows.ts";
import {
  carryOut,
  checkDraft,
  type FieldDef,
  idFor,
  isBuiltIn,
  keyFor,
  listDef,
  PRESET_IDS,
  PRESETS,
  prefixFor,
  type Proposal,
  propose,
  stateLabel,
  type StoredDefinition,
  unknownList,
} from "./registers.ts";

/** The lead tools for lists and money. Model-facing text lives in `mcp/tools.ts`. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const Label = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
const FieldInput = Schema.Struct({
  label: Label,
  type: KinListFieldType,
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
  sourceEventId: TrimmedNonEmptyString,
  proposal: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(40))).annotate({
    description: "A proposal this tool returned in an earlier turn: creates exactly that.",
  }),
  template: Schema.optional(Schema.Literals(PRESET_IDS)).annotate({
    description: "Start from Kin's expenses, invoices or dates list.",
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
  dueLabel: Schema.optional(Label),
  dateLabel: Schema.optional(Label),
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

const fieldDefs = (fields: ReadonlyArray<typeof FieldInput.Type>) => {
  const defs: Array<FieldDef> = [];
  for (const one of fields) {
    const key = keyFor(one.label);
    if (key === undefined) return invalid(`${one.label} needs a name made of letters.`);
    defs.push({
      key,
      label: one.label,
      type: one.type,
      ...(one.choices === undefined ? {} : { choices: one.choices }),
      ...(one.link === undefined ? {} : { link: one.link }),
      sensitive: one.type === "money" || one.type === "file" || one.sensitive === true,
    });
  }
  return defs;
};

/** The proposal a call describes: a preset with any extras, a new list, or additions to one. */
const proposalFor = Effect.fn("KinWorkTools.proposalFor")(function* (
  lead: Lead,
  input: typeof DefineInput.Type,
) {
  const fields = fieldDefs(input.fields ?? []);
  if (!Array.isArray(fields)) return yield* fields;
  if (input.list !== undefined) {
    const def = yield* listDef(lead.orgId, input.list);
    if (def === undefined) return yield* unknownList(input.list);
    if (def.builtIn !== null)
      return yield* invalid(`${def.name} is built in; its fields are fixed.`);
    // A field named again with new choices adds those choices to it.
    const choices: Record<string, ReadonlyArray<string>> = {};
    const added = fields.filter((one) => {
      const existing = def.fields.find((field) => field.key === one.key);
      if (existing?.type === "choice" && one.type === "choice") {
        choices[one.key] = one.choices ?? [];
        return false;
      }
      return true;
    });
    return {
      _tag: "extend",
      id: def.id,
      fields: added,
      categories: input.categories ?? [],
      choices,
      stateLabels: input.stateNames ?? {},
    } satisfies Proposal;
  }
  const named = input.template ?? (input.name === undefined ? undefined : idFor(input.name));
  if (named === undefined)
    return yield* invalid("Name the list, start from a template, or say which list to add to.");
  const preset = (PRESET_IDS as ReadonlyArray<string>).includes(named)
    ? PRESETS[named as (typeof PRESET_IDS)[number]]
    : undefined;
  if (preset === undefined && (isBuiltIn(named) || named === "docs"))
    return yield* invalid(`${input.name ?? named} is one of Kin's own lists already.`);
  const name = preset?.name ?? input.name ?? named;
  const amount = input.amount ?? preset?.amount ?? false;
  const states = input.states ?? preset?.states ?? ["open", "done", "dropped"];
  const definition: StoredDefinition = {
    noun: input.noun ?? preset?.noun ?? name.toLowerCase().replace(/s$/, ""),
    states,
    stateLabels: { ...preset?.stateLabels, ...input.stateNames },
    defaultState:
      preset !== undefined && states.includes(preset.defaultState)
        ? preset.defaultState
        : states.includes("open")
          ? "open"
          : states[0]!,
    categories: [...new Set([...(preset?.categories ?? []), ...(input.categories ?? [])])],
    fields: [
      ...(preset?.fields ?? []),
      ...fields.filter((one) => !(preset?.fields ?? []).some((field) => field.key === one.key)),
    ],
    sensitive: input.sensitive ?? preset?.sensitive ?? amount,
    amount,
    currency: input.currency ?? preset?.currency ?? "INR",
    ...((input.dueLabel ?? preset?.dueLabel)
      ? { dueLabel: (input.dueLabel ?? preset?.dueLabel)! }
      : {}),
    ...((input.dateLabel ?? preset?.dateLabel)
      ? { dateLabel: (input.dateLabel ?? preset?.dateLabel)! }
      : {}),
  };
  if (!isCurrency(definition.currency))
    return yield* invalid(`${definition.currency} is not a currency code.`);
  const draft = {
    id: named,
    name,
    prefix: input.prefix ?? preset?.prefix ?? prefixFor(name),
    definition,
  };
  const refused = checkDraft(draft);
  if (refused !== undefined) return yield* refused;
  if ((yield* listDef(lead.orgId, draft.id)) !== undefined)
    return yield* invalid(
      `There is already a list ${draft.name}; propose fields to add to it with list instead.`,
    );
  return { _tag: "new", ...draft } satisfies Proposal;
});

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
  const proposal = yield* proposalFor(lead, input);
  const chat = yield* turnChat(lead);
  if (chat === undefined) return yield* invalid("This turn has no chat to propose a list in.");
  const proposalId = yield* propose({
    orgId: lead.orgId,
    agentId: lead.agentId,
    wakeupId: lead.wakeupId,
    chatId: chat.chatId,
    proposal,
    now,
  });
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
  return {
    status: "proposed" as const,
    proposal: proposalId,
    ...shown,
    next: "Nothing is created yet. Put these fields to the owner in one short message and ask. Once they say yes, call list_define with this proposal in that later turn.",
  };
});
export const define = leadTool("KinWorkTools.define", runDefine);

export const PaymentInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString,
  key: KinRecordKey.annotate({ description: "The invoice, such as INV-4." }),
  amount: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))).annotate({
    description:
      'What was received, as said: "1,20,000" or "1.2 lakh". In the invoice\'s currency.',
  }),
  paidOn: Schema.optional(KinDay).annotate({
    description: "The day it was received, in the owner's time zone.",
  }),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  void: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(60))).annotate({
    description: "A paymentId from record_get to take back instead.",
  }),
});
export const PaymentResult = Schema.Struct({
  key: Schema.String,
  state: Schema.String,
  amount: Schema.String,
  received: Schema.String,
  balance: Schema.String,
  paymentId: Schema.optional(Schema.String),
  sensitive: Schema.Literal(true),
});

const runPayment = Effect.fnUntraced(function* (lead: Lead, input: typeof PaymentInput.Type) {
  yield* admitted(lead, "payment_record", input);
  yield* sourceOf(lead, input.sourceEventId);
  const records = yield* KinRecords;
  const writer = yield* writerFor(lead);
  const before = yield* records.get(lead.orgId, input.key);
  if (before === undefined) return yield* notFound(input.key);
  let paymentId: string | undefined;
  if (input.void !== undefined) {
    yield* records.voidPayment(lead.orgId, writer, input.key, input.void);
  } else {
    if (input.amount === undefined || input.paidOn === undefined)
      return yield* invalid("A payment needs amount and paidOn, or void to take one back.");
    const parsed = parseAmount(input.amount, before.currency ?? "INR");
    if ("error" in parsed) return yield* parsed.error;
    paymentId = (yield* records.pay(lead.orgId, writer, input.key, {
      amount: parsed.money,
      paidOn: input.paidOn,
      ...(input.note === undefined ? {} : { note: input.note }),
      originKey: `lead:${lead.agentId}:${input.sourceEventId}:${retryKey(`${input.key}|${parsed.money.minor}|${input.paidOn}`)}`,
    })).paymentId;
  }
  const after = yield* records.get(lead.orgId, input.key);
  if (after === undefined) return yield* notFound(input.key);
  const currency = after.currency ?? "INR";
  const amount = after.amountMinor ?? 0;
  return {
    key: after.key,
    state: after.state,
    amount: formatMoney({ minor: amount, currency }),
    received: formatMoney({ minor: after.paid, currency }),
    balance: formatMoney({ minor: Math.max(amount - after.paid, 0), currency }),
    ...(paymentId === undefined ? {} : { paymentId }),
    sensitive: true as const,
  };
});
export const payment = leadTool("KinWorkTools.payment", runPayment);

export const MoneyResult = Schema.Struct({
  asOf: Schema.String,
  summary: Schema.optional(Schema.Unknown),
  nothing: Schema.optional(Schema.Literal(true)),
  sensitive: Schema.Literal(true),
});
const runMoney = Effect.fnUntraced(function* (lead: Lead, _input: unknown) {
  const now = yield* Clock.currentTimeMillis;
  const summary = yield* moneySummary(lead.orgId, now);
  const section = moneySection(summary, summary.timeZone);
  return {
    asOf: iso(now),
    ...(section === undefined ? { nothing: true as const } : { summary: section }),
    sensitive: true as const,
  };
});
export const money = leadTool("KinWorkTools.money", runMoney);

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
      what: Schema.String,
      on: Schema.String,
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
  const page = yield* dates(
    lead.orgId,
    { from, to, lists: input.lists, open: input.open ?? true, limit: input.limit ?? 30 },
    now,
  );
  return {
    asOf: iso(now),
    total: page.total,
    dates: page.rows.map((row) => ({
      key: row.record.key,
      title: row.record.title,
      list: row.listName,
      state: row.stateLabel,
      what: row.label,
      on: row.allDay ? dayIn(Date.parse(row.at), zone) : row.at,
      ...(row.record.late ? { late: true as const } : {}),
      ...(row.record.amount === undefined
        ? {}
        : { amount: formatMoney(row.record.amount), sensitive: true as const }),
      ...(row.record.sensitive || row.record.sensitiveInherited === true
        ? { sensitive: true as const }
        : {}),
    })),
  };
});
export const datesQuery = leadTool("KinWorkTools.dates", runDates);
const DAY_MS = 24 * 60 * 60 * 1000;

const ProfileText = Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500)));
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
      sac: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{4,8}$/)))),
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
    }),
  ),
});
export const ProfileResult = Schema.Struct({
  profile: Schema.Record(Schema.String, Schema.Unknown),
  rev: Schema.Number,
  sensitive: Schema.Literal(true),
});
const runProfile = Effect.fnUntraced(function* (lead: Lead, input: typeof ProfileInput.Type) {
  yield* admitted(lead, "company_profile", input);
  if (input.set !== undefined) {
    if (input.sourceEventId === undefined)
      return yield* invalid("Pass this turn's sourceEventId to change the profile.");
    yield* sourceOf(lead, input.sourceEventId);
    // Only the owner's own words change the company's legal and bank details.
    if ((yield* askedBy(lead)) === null)
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "Only the owner's own message changes the company profile.",
      });
    yield* setProfile(lead.orgId, { _tag: "agent", agentId: lead.agentId }, input.set, undefined);
  }
  const { rev, updatedAt: _updatedAt, bank, ...rest } = yield* readProfile(lead.orgId);
  const kept = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).filter(([, one]) => one !== null));
  const shownBank = kept(bank);
  return {
    profile: { ...kept(rest), ...(Object.keys(shownBank).length === 0 ? {} : { bank: shownBank }) },
    rev,
    sensitive: true as const,
  };
});
export const profile = leadTool("KinWorkTools.profile", runProfile);
