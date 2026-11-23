import {
  KinChatError,
  KinDocumentLine,
  type KinCashInput,
  type KinEntryLinesInput,
  type KinInvoiceFromQuoteInput,
  type KinMoneyBudgetSetInput,
  type KinNewExpenseInput,
  type KinNewInvoiceInput,
  type KinMoneyBudgetsInput,
  type KinOrgId,
  type KinOutlookInput,
  type KinMatchPartnerInput,
  KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { makeDocument } from "../gendocs/make.ts";
import { invoiceFromQuote as draftFromQuote, quotedInputs } from "../gendocs/quotes.ts";
import { defaultRecipes } from "../gendocs/recipeDefaults.ts";
import { KinWorkspace, type StoredRecipe } from "../gendocs/workspace.ts";
import { budgetsView, setBudget as setBudgetFor } from "./budgets.ts";
import { countryFirst, homeCurrency } from "./companyProfile.ts";
import { askSlip, dayIn, linesBeforeTax } from "./money.ts";
import { cashEstimate, cashPosition, outlook as outlookOf } from "./moneyAnswers.ts";
import type { AlertBalance } from "./statements/bankAlerts.ts";
import { KinRecords, requestHashOf } from "./KinRecords.ts";
import { dueMillis, ownFiles, ownerWriter, theOwner } from "./ownerWork.ts";
import { iso, notFound, type RecordRow, workFailure } from "./recordRows.ts";
import { matchPartner as matchPartnerOf } from "./partnersOwed.ts";
import { listDef, listOrPreset, presetList } from "./registers.ts";

/** Money's answers as the owner's apps read them: the agent's own figures, never re-added here. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const OUTLOOK_DAYS = 30;
const ITEMS_SHOWN = 20;

const signed = (minor: bigint, currency: string) => ({ minor: Number(minor), currency });

export const cash = Effect.fn("KinMoneyAnswers.rpc.cash")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinCashInput,
) {
  yield* theOwner(people, input.orgId);
  const view = yield* cashPosition(input.orgId, yield* Clock.currentTimeMillis);
  return {
    asOf: iso(view.asOf),
    today: view.today,
    timeZone: view.timeZone,
    known: view.known,
    accounts: view.accounts.map((one) => ({
      label: one.label,
      kind: one.kind,
      balance: { minor: one.minor, currency: one.currency },
      on: one.on,
      ageDays: one.ageDays,
      stale: one.stale,
      check: one.check,
      cannotTellApart: one.cannotTellApart,
      newerRead:
        one.newerRead === undefined || one.newerRead.standing === undefined
          ? null
          : {
              balance: { minor: one.newerRead.minor, currency: one.newerRead.currency },
              on: one.newerRead.on,
              standing: one.newerRead.standing,
            },
      ...(one.alert === undefined ? {} : { alert: alertOf(one.alert) }),
    })),
    notOfRecord: view.notOfRecord.flatMap((one) =>
      one.standing === undefined
        ? []
        : [
            {
              label: one.label,
              kind: one.kind,
              balance: { minor: one.minor, currency: one.currency },
              on: one.on,
              standing: one.standing,
            },
          ],
    ),
    byCurrency: view.byCurrency.map((one) => {
      const estimate = cashEstimate(one);
      return {
        currency: one.currency,
        accounts: one.accounts,
        total: one.total === null ? null : signed(one.total, one.currency),
        since: one.since,
        sameDay: one.sameDay,
        stale: one.stale,
        receivedSince: signed(one.receivedSince, one.currency),
        spentSince: signed(one.spentSince, one.currency),
        estimate: estimate === null ? null : signed(estimate, one.currency),
      };
    }),
    bankKnown: { through: view.bank.through },
    // Only when there are any: Money is read on every change.
    ...(view.alertAccounts.length === 0
      ? {}
      : {
          alertAccounts: view.alertAccounts.map((one) => ({
            label: `${one.bank} ••${one.account}`,
            alert: alertOf(one),
          })),
        }),
  };
}, workFailure);
const alertOf = (one: AlertBalance) => ({
  balance: { minor: one.balanceMinor, currency: one.currency },
  at: iso(one.sentAt),
});

export const outlook = Effect.fn("KinMoneyAnswers.rpc.outlook")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinOutlookInput,
) {
  yield* theOwner(people, input.orgId);
  const view = yield* outlookOf(input.orgId, yield* Clock.currentTimeMillis, OUTLOOK_DAYS);
  const window = view.windows[0]!;
  const item = (one: (typeof view.incoming)[number]) => ({
    key: one.key,
    title: one.title,
    list: one.list,
    on: dayIn(one.at, view.timeZone),
    money: one.money,
    repeats: one.kind === "repeat",
  });
  return {
    today: view.today,
    days: OUTLOOK_DAYS,
    through: window.through,
    expectedIn: window.expectedIn,
    expectedOut: window.expectedOut,
    net: window.net.map((one) => signed(one.minor, one.currency)),
    comingIn: view.incoming.slice(0, ITEMS_SHOWN).map(item),
    moreComingIn: Math.max(view.incoming.length - ITEMS_SHOWN, 0),
    goingOut: view.dueOut.slice(0, ITEMS_SHOWN).map(item),
    moreGoingOut: Math.max(view.dueOut.length - ITEMS_SHOWN, 0),
    pastDueOut: view.overdueOut.slice(0, ITEMS_SHOWN).map(item),
    overdueIn: view.overdueIn.slice(0, ITEMS_SHOWN).map((one) => ({
      key: one.key,
      title: one.title,
      list: "Invoices",
      on: dayIn(one.dueAt, view.timeZone),
      money: one.money,
      repeats: false,
    })),
    ...(view.partners.length === 0
      ? {}
      : {
          owedToPartners: view.partners.map((one) => ({
            personId: one.personId === null ? null : KinPersonId.make(one.personId),
            name: one.name,
            address: one.address,
            owed: one.owed,
            expenses: one.entries.length,
            oldest: dayIn(one.entries[0]!.at, view.timeZone),
            ...(one.personId === null
              ? { entries: one.entries.map((entry) => ({ key: entry.key, rev: entry.rev })) }
              : {}),
          })),
        }),
    ...(view.unsaid.length === 0
      ? {}
      : {
          partnersUnsaid: view.unsaid.map((one) => ({
            address: one.address,
            expenses: one.expenses,
            total: one.total,
            oldest: dayIn(one.at, view.timeZone),
            entries: one.seen,
          })),
        }),
    incomplete: view.incomplete,
    runway: view.runway.map((one) => ({
      currency: one.currency,
      months: one.months.map((month) => ({
        month: month.month,
        received: signed(month.received, one.currency),
        spent: signed(month.spent, one.currency),
        net: signed(month.net, one.currency),
      })),
      averageNet: signed(one.averageNet, one.currency),
      balance:
        one.balance === null
          ? null
          : {
              money: signed(one.balance.minor, one.currency),
              oldest: one.balance.oldest,
              stale: one.balance.stale,
            },
      withheld: one.withheld,
      enoughHistory: one.enoughHistory,
      historySince: one.historySince,
      runwayTenths: one.runwayTenths === null ? null : Number(one.runwayTenths),
    })),
  };
}, workFailure);

const budgetsOf = Effect.fn("KinMoneyAnswers.budgetsOf")(function* (orgId: KinOrgId) {
  const view = yield* budgetsView(orgId, yield* Clock.currentTimeMillis);
  return {
    month: view.month,
    budgets: view.budgets.map((one) => ({
      budgetId: one.budgetId,
      category: one.category,
      project: one.projectId === null ? null : { key: one.projectKey, title: one.projectTitle },
      limit: { minor: one.limitMinor, currency: one.currency },
      spent: signed(one.spent, one.currency),
      expenses: one.expenses,
      status: one.status,
      ...(one.notCounted.length === 0
        ? {}
        : {
            notCounted: one.notCounted.map((money) => ({ currency: money.currency, spent: money })),
          }),
    })),
  };
});

export const budgets = Effect.fn("KinMoneyAnswers.rpc.budgets")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMoneyBudgetsInput,
) {
  yield* theOwner(people, input.orgId);
  return yield* budgetsOf(input.orgId);
}, workFailure);

/** The owner's own set, change or removal of a budget; a retry of one request repeats it. */
export const setBudget = Effect.fn("KinMoneyAnswers.rpc.setBudget")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMoneyBudgetSetInput,
) {
  const person = yield* theOwner(people, input.orgId);
  if (input.category === null && input.project === null)
    return yield* invalid("A budget is for a category, a project, or a category in a project.");
  if (input.limitMinor !== null) yield* countryFirst(input.orgId);
  const expenses = yield* listDef(input.orgId, "expenses");
  if (expenses === undefined)
    return yield* invalid("There is no expenses list yet, so nothing to budget.");
  const category =
    input.category === null
      ? null
      : expenses.categories.find((one) => one.toLowerCase() === input.category!.toLowerCase());
  if (category === undefined)
    return yield* invalid(`Expenses have no category ${input.category!.slice(0, 60)}.`);
  let projectId: string | null = null;
  if (input.project !== null) {
    const project = yield* (yield* KinRecords).get(input.orgId, input.project);
    if (project === undefined || project.registerId !== "projects")
      return yield* notFound(input.project);
    projectId = project.recordId;
  }
  yield* setBudgetFor(
    input.orgId,
    {
      category,
      projectId,
      currency: input.currency,
      limitMinor: input.limitMinor,
      sourceEventId: `owner:${person.personId}:${input.clientRequestId}`,
    },
    { kind: "person", id: person.personId },
    yield* Clock.currentTimeMillis,
  );
  return yield* budgetsOf(input.orgId);
}, workFailure);

const decodeLines = Schema.decodeUnknownOption(Schema.Array(KinDocumentLine));

export const entryLines = Effect.fn("KinMoneyAnswers.rpc.entryLines")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinEntryLinesInput,
) {
  yield* theOwner(people, input.orgId);
  const given = yield* quotedInputs(input.orgId, input.key);
  // Lines are kept as they were given; an agent may have said a quantity or rate as a number.
  const said = Array.isArray(given.lines)
    ? given.lines.map((row: unknown) =>
        typeof row === "object" && row !== null
          ? Object.fromEntries(
              Object.entries(row).map(([name, cell]) => [
                name,
                typeof cell === "number" ? String(cell) : cell,
              ]),
            )
          : row,
      )
    : null;
  return { lines: Option.getOrNull(decodeLines(said)) };
}, workFailure);

/** The template invoices are made with: the list's default, else the first there is. */
const invoiceTemplate = Effect.fn("KinMoneyAnswers.invoiceTemplate")(function* (orgId: KinOrgId) {
  const recipes = (yield* (yield* KinWorkspace).recipes(orgId)).filter(
    (one) => one.list === "invoices",
  );
  const defaults = yield* defaultRecipes(orgId, recipes);
  return recipes.find((one) => defaults.has(one.name)) ?? recipes[0];
});

/** A draft invoice's document made for the owner level with `given`; why not, the draft standing. */
const draftDocument = Effect.fn("KinMoneyAnswers.draftDocument")(function* (
  person: PersonIdentity,
  invoice: RecordRow,
  recipe: StoredRecipe,
  given: Readonly<Record<string, unknown>>,
  jobKey: string,
) {
  const own = new Set(recipe.inputs.filter((one) => one.from === "agent").map((one) => one.name));
  return yield* makeDocument({
    orgId: person.orgId,
    recipe: recipe.name,
    entry: invoice.key,
    given: Object.fromEntries(Object.entries(given).filter(([name]) => own.has(name))),
    doc: undefined,
    title: recipe.title,
    requester: { _tag: "owner", personId: person.personId, writer: ownerWriter(person) },
    jobKey,
    admit: Effect.void,
  }).pipe(
    Effect.map((document) => ({
      invoice: invoice.key,
      documents: document.documents.map((doc) => ({ key: doc.key, title: doc.title })),
      problems: [] as ReadonlyArray<string>,
    })),
    Effect.catchIf(Schema.is(KinChatError), (error) =>
      Effect.succeed({ invoice: invoice.key, documents: [], problems: [error.message] }),
    ),
  );
});

/**
 * "Make invoice" on a quote: its draft invoice, once per quote, and that invoice's document made
 * with the quote's own lines and client, as `kin_document` with `from` makes it for an agent.
 */
export const invoiceFromQuote = Effect.fn("KinMoneyAnswers.rpc.invoiceFromQuote")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinInvoiceFromQuoteInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const made = yield* draftFromQuote(input.orgId, ownerWriter(person), input.key);
  const recipe = yield* invoiceTemplate(input.orgId);
  if (recipe === undefined)
    return {
      invoice: made.entry.key,
      documents: [],
      problems: ["There is no invoice template yet, so the draft has no PDF."],
    };
  return yield* draftDocument(
    person,
    made.entry,
    recipe,
    made.given,
    `owner:${person.personId}:${input.clientRequestId}`,
  );
}, workFailure);

const recordOf = Effect.fn("KinMoneyAnswers.recordOf")(function* (
  orgId: KinOrgId,
  key: string,
  list: "clients" | "projects",
) {
  const row = yield* (yield* KinRecords).get(orgId, key);
  if (row === undefined || row.registerId !== list) return yield* notFound(key);
  return row.recordId;
});

/**
 * An invoice typed by hand: a Draft for the client, owed by nobody until it is issued, and its
 * document made with the lines typed, which set its amount and tax as Make its PDF does. With no
 * invoice template nothing is saved, since only a document keeps an invoice's lines.
 */
export const newInvoice = Effect.fn("KinMoneyAnswers.rpc.newInvoice")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinNewInvoiceInput,
) {
  const person = yield* theOwner(people, input.orgId);
  if ((input.client === undefined) === (input.billTo === undefined))
    return yield* invalid(
      "Say who the invoice is for: a client, or a name to bill. Nothing was saved.",
    );
  yield* countryFirst(input.orgId);
  const recipe = yield* invoiceTemplate(input.orgId);
  if (recipe === undefined)
    return yield* invalid(
      "There is no invoice template yet, so Kin can't keep the lines. Nothing was saved. Ask an agent to set one up.",
    );
  const partyId =
    input.client === undefined ? null : yield* recordOf(input.orgId, input.client, "clients");
  const fields =
    input.billTo === undefined
      ? undefined
      : {
          billToName: input.billTo.name,
          billToAddress: input.billTo.address ?? null,
          billToTaxNumber: input.billTo.taxNumber ?? null,
          billToPlace: input.billTo.place ?? null,
          billToEmail: input.billTo.email ?? null,
        };
  const projectId =
    input.project === undefined
      ? undefined
      : yield* recordOf(input.orgId, input.project, "projects");
  const def = yield* listOrPreset(input.orgId, "invoices", yield* Clock.currentTimeMillis);
  const { amountConfirmed, ...request } = input;
  const total = linesBeforeTax(input.lines, yield* homeCurrency(input.orgId));
  if (amountConfirmed === false && def !== undefined && total !== undefined)
    yield* askSlip(input.orgId, def, total);
  const dueAt = input.dueOn === undefined ? null : yield* dueMillis(input.orgId, input.dueOn, true);
  const notes = input.notes?.trim() ?? "";
  const { row } = yield* (yield* KinRecords).create(input.orgId, ownerWriter(person), {
    list: "invoices",
    originKey: `owner:${input.clientRequestId}`,
    requestHash: requestHashOf(request),
    title: input.title,
    owner: { _tag: "person", personId: person.personId },
    state: "open",
    partyId,
    ...(fields === undefined ? {} : { fields }),
    ...(projectId === undefined ? {} : { projectId }),
    dueAt,
    dueAllDay: dueAt !== null,
    ...(notes === "" ? {} : { notes }),
  });
  return yield* draftDocument(
    person,
    row,
    recipe,
    { lines: input.lines, ...(input.gstRate === undefined ? {} : { gstRate: input.gstRate }) },
    `owner:${person.personId}:${input.clientRequestId}`,
  );
}, workFailure);

const sameWord = (choices: ReadonlyArray<string>, given: string | undefined) =>
  given === undefined
    ? undefined
    : (choices.find((one) => one.toLowerCase() === given.toLowerCase()) ?? given);

/**
 * An expense typed by hand, Paid on its day or To pay when that is still ahead. The company's
 * Expenses list is made from its preset the first time, as a statement's expense makes it.
 */
export const newExpense = Effect.fn("KinMoneyAnswers.rpc.newExpense")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinNewExpenseInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const { amountConfirmed, ...request } = input;
  yield* countryFirst(input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const def = yield* presetList(input.orgId, "expenses", yield* Clock.currentTimeMillis);
  if (def === undefined) return yield* invalid("Kin couldn't make the Expenses list.");
  const paidWith = def.fields.find((field) => field.key === "paidWith")?.choices ?? [];
  const fields = {
    ...(input.vendor === undefined ? {} : { vendor: input.vendor }),
    ...(input.paidWith === undefined ? {} : { paidWith: sameWord(paidWith, input.paidWith)! }),
    ...(input.fundedBy === undefined
      ? {}
      : { fundedBy: `person:${input.fundedBy}`, reimbursement: "owed" }),
    ...(input.receipt === undefined || input.receipt.length === 0
      ? {}
      : { receipt: [...input.receipt] }),
  };
  const category = sameWord(def.categories, input.category);
  const dateAt = yield* dueMillis(input.orgId, input.paidOn, true);
  const create = (yield* KinRecords).create(input.orgId, ownerWriter(person), {
    list: "expenses",
    originKey: `owner:${input.clientRequestId}`,
    requestHash: requestHashOf(request),
    title: input.title,
    owner: { _tag: "person", personId: person.personId },
    amount: input.amount,
    ...(amountConfirmed === false ? { askSlip: true } : {}),
    dateAt,
    dateAllDay: true,
    ...(category === undefined ? {} : { category }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  });
  // The files are checked and kept in one transaction, so none slips in between the two.
  const { row } = yield* sql.withTransaction(
    ownFiles(person, "{}", fields).pipe(Effect.andThen(create)),
  );
  return { expense: row.key };
}, workFailure);

/**
 * The owner or a co-owner (owner level, as for `newExpense`) names the Kin person an import's
 * partner address is. Only a current member can fund an expense; the unmatched expenses with that
 * address take them as funder.
 */
export const matchPartner = Effect.fn("KinMoneyAnswers.rpc.matchPartner")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMatchPartnerInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  // The teammate, the rows and their totals are read and written in one transaction.
  const matched = yield* sql.withTransaction(
    matchPartnerOf(
      input.orgId,
      ownerWriter(person),
      input.address ?? null,
      input.personId,
      input.settled,
      input.seen,
    ),
  );
  return { matched };
}, workFailure);
