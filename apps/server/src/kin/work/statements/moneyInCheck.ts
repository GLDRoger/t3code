import {
  KinChatError,
  KinDay,
  KinMoneyInCheckCard,
  KinRecordKey,
  KinWidgetId,
  KIN_MONEY_IN_CHECK_CARD,
  type KinOrgId,
} from "@t3tools/contracts";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { turnChat } from "../../lead/Audience.ts";
import { MONEY_IN_CHECK_REFUSAL, toolAdmitted } from "../../lead/SharedTools.ts";
import { ownerLevelAsked } from "../../people/KinAccess.ts";
import { leadTool, type Lead } from "../leadWork.ts";
import { parseFields } from "../lists.ts";
import { dayIn, formatMinor } from "../money.ts";
import { countedEntry, endOfDay, ownerZone, startOfDay } from "../recordRows.ts";
import type { ListDef } from "../registers.ts";
import { shortDay, type BankCoverage } from "./bankKnown.ts";
import { bankStates, directionOf, findBankList } from "./bankList.ts";
import { bankSource, noAgentHand, notRemovedAlert, rankAll } from "./invoiceCredits.ts";
import { cardText, changesSince, groupHeads, groups } from "./moneyInCheckText.ts";
import { checkDay, coverageOf, dayGap, niceRange } from "./moneyInCoverage.ts";
import { citedNumber, nameIn, paymentOffer } from "./statementMatch.ts";
import { postCard, recordedPayments, updateCard } from "./statementReview.ts";
import type { StatementRow } from "./statementTable.ts";

const TYPE = KIN_MONEY_IN_CHECK_CARD;
const MATCH_DAYS = 3;
const PAIR_DAYS = 10;
const NO_BANK_LINES =
  "Kin has no bank lines yet: approve a bank's alert address in Settings → Connections, or add a statement here.";

export const MoneyInCheckInput = Schema.Struct({
  from: KinDay.annotate({ description: "First day to check, in the owner's time zone." }),
  through: KinDay.annotate({
    description: "Last day to check, inclusive and no later than today in the owner's time zone.",
  }),
  account: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}$/))).annotate({
    description: "One bank account, by its last four digits.",
  }),
  client: Schema.optional(KinRecordKey).annotate({
    description: "One client's Kin key, such as C-3.",
  }),
});
type Input = typeof MoneyInCheckInput.Type;
type Card = KinMoneyInCheckCard;
type Line = Card["lines"][number];
type Group = Line["group"];
type Payment = Effect.Success<ReturnType<typeof recordedPayments>>[number];
const { from, through, counts, covered } = KinMoneyInCheckCard.fields;
export const MoneyInCheckResult = Schema.Struct({
  card: KinWidgetId,
  from,
  through,
  counts,
  covered,
  reply: Schema.String,
  lines: Schema.Array(
    Schema.Struct({
      group: KinMoneyInCheckCard.fields.lines.value.fields.group,
      bank: Schema.optional(KinRecordKey),
      invoice: Schema.optional(KinRecordKey),
    }),
  ),
});

const rangeHas = ({ from, through }: { from: string; through: string }, day: string) =>
  from <= day && day <= through;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const amount = (minor: number | bigint, currency: string) => formatMinor(BigInt(minor), currency);

const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const bankCredits = Effect.fn("KinMoneyInCheck.credits")(function* (
  orgId: KinOrgId,
  def: ListDef,
  zone: string,
  range: { from: string; through: string },
  tied?: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  if (tied?.length === 0) return [];
  const tiedIds = tied === undefined ? undefined : yield* encodeIds(tied);
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    rev: number;
    amountMinor: number;
    currency: string;
    dateAt: number;
    fieldsJson: string;
    category: string | null;
    state: string;
    clean: number;
    trusted: number;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.rev, r.amount_minor AS "amountMinor",
      COALESCE(r.currency, ${def.currency}) AS currency, r.date_at AS "dateAt", r.fields_json AS "fieldsJson",
      r.category, r.state, (${noAgentHand(sql)}) AS clean,
      (${bankSource(sql)} AND ${notRemovedAlert(sql)}) AS trusted
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = ${def.id} AND ${countedEntry(sql)}
      AND r.amount_minor > 0 AND r.date_at IS NOT NULL AND ${
        tiedIds === undefined
          ? sql`r.date_at BETWEEN ${startOfDay(range.from, zone)} AND ${endOfDay(range.through, zone)}`
          : sql`r.record_id IN (SELECT value FROM json_each(${tiedIds}))`
      }
    ORDER BY r.date_at, r.record_id`;
  return rows.flatMap(({ fieldsJson, ...one }) => {
    const fields = parseFields(fieldsJson);
    if (directionOf(fields) !== "credit") return [];
    const date = dayIn(one.dateAt, zone);
    const account = typeof fields.account === "string" ? fields.account : undefined;
    const row: StatementRow = {
      index: 0,
      date,
      description: one.title,
      reference: typeof fields.reference === "string" ? fields.reference : null,
      amountMinor: one.amountMinor,
      direction: "credit",
      balanceMinor: null,
      foreign: null,
    };
    return [{ ...one, date, account, row }];
  });
});
type Credit = Effect.Success<ReturnType<typeof bankCredits>>[number];

const cash = (p: Payment) =>
  p.receivedMinor !== null && p.receivedCurrency !== null
    ? { ...p, amountMinor: p.receivedMinor, currency: p.receivedCurrency }
    : p;

const paymentLine = (p: Payment) => ({
  id: p.paymentId,
  key: p.key,
  day: p.paidOn,
  amount: amount(p.amountMinor, p.currency),
});
const bankLine = (
  b: Credit,
  group: Group,
  text: string,
  payments: ReadonlyArray<Payment> = [],
  detail: Pick<Line, "invoice" | "difference"> = {},
): Line => ({
  id: `bank:${b.key}`,
  group,
  bank: b.key,
  day: b.date,
  ...(b.account === undefined ? {} : { account: b.account }),
  amount: amount(b.amountMinor, b.currency),
  payments: payments.map(paymentLine),
  text,
  printed: b.title,
  ...detail,
});
const bankWords = (b: Credit) =>
  `${b.key}, ${amount(b.amountMinor, b.currency)} received ${shortDay(b.date)}`;
const names = (p: { readonly client: string | null }) =>
  p.client === null ? "" : ` from ${p.client}`;
const onKin = (p: Payment) =>
  `${p.key}: ${amount(p.amountMinor, p.currency)} recorded as received ${shortDay(p.paidOn)}`;
const matched = (b: Credit, payments: ReadonlyArray<Payment>) =>
  bankLine(b, "matched", `${bankWords(b)}; ${payments.map(onKin).join("; ")}.`, payments);

type Client = { id: string; key: string; name: string };
const otherPayer = (b: Credit, p: Payment, clients: ReadonlyArray<Client>) =>
  p.client !== null && nameIn(p.client, b.title) >= 0.5
    ? undefined
    : clients.find((client) => client.id !== p.clientId && nameIn(client.name, b.title) >= 0.5);

const tiedLine = (b: Credit, payments: ReadonlyArray<Payment>, clients: ReadonlyArray<Client>) => {
  const keys = [...new Set(payments.map((p) => p.key))].join(", ");
  const sum = payments
    .filter((p) => p.currency === b.currency)
    .reduce((total, p) => total + BigInt(p.amountMinor), 0n);
  if (sum !== BigInt(b.amountMinor) || payments.some((p) => p.currency !== b.currency))
    return bankLine(
      b,
      "differs",
      keys === ""
        ? `${bankWords(b)}: no live tied payments remain; the sum is ${amount(sum, b.currency)}.`
        : `${bankWords(b)}, is tied to payments on ${keys} that now add up to ${amount(sum, b.currency)}${payments.some((p) => p.currency !== b.currency) ? " in the bank's currency" : ""}.`,
      payments,
      { difference: "sum" },
    );
  const payer = payments.find((p) => otherPayer(b, p, clients) !== undefined);
  if (payer !== undefined) {
    const other = otherPayer(b, payer, clients)!;
    return bankLine(
      b,
      "differs",
      `${bankWords(b)}, is tied to ${payer.key}${payer.client === null ? "" : ` of ${payer.client}`}, but the bank names ${other.name}.`,
      payments,
      { difference: "payer" },
    );
  }
  return matched(b, payments);
};

type Pair = { b: Credit; p: Payment; score: number; gap: number; amountDiffers: boolean };
const pairedLine = ({ b, p, gap, amountDiffers }: Pair) => {
  const recorded = amount(p.amountMinor, p.currency);
  if (amountDiffers) {
    const delta = BigInt(b.amountMinor) - BigInt(p.amountMinor);
    const identified = named(b, p) ? `names ${p.client}` : `cites ${p.key}`;
    return bankLine(
      b,
      "differs",
      `${bankWords(b)}, ${identified}; ${p.key} has ${recorded} recorded for ${shortDay(p.paidOn)}. The amounts differ by ${amount(delta < 0n ? -delta : delta, b.currency)}.`,
      [p],
      { difference: "amount" },
    );
  }
  return gap <= MATCH_DAYS
    ? matched(b, [p])
    : bankLine(
        b,
        "differs",
        `${bankWords(b)}, is the ${recorded} recorded on ${p.key} for ${shortDay(p.paidOn)}: the days are ${gap} apart, and the two aren't tied.`,
        [p],
        { difference: "day" },
      );
};

const named = (b: Credit, p: Payment) => p.client !== null && nameIn(p.client, b.title) >= 0.5;
const possiblePair = (b: Credit, p: Payment) => {
  const gap = Math.abs(dayGap(p.paidOn, b.date));
  if (gap > PAIR_DAYS || p.currency !== b.currency) return [];
  const offered = paymentOffer(b.row, p, b.currency);
  if (offered !== undefined) return [{ b, p, gap, score: offered.score, amountDiffers: false }];
  const cited = citedNumber(b.row, p) !== undefined;
  if (p.amountMinor === b.amountMinor || (!cited && !named(b, p))) return [];
  return [{ b, p, gap, score: (cited ? 20 : 10) - gap, amountDiffers: true }];
};

const best = (choices: ReadonlyArray<Pair>) => {
  const [first, second] = choices.toSorted((a, b) => b.score - a.score || a.gap - b.gap);
  return first !== undefined &&
    (second === undefined || first.score !== second.score || first.gap !== second.gap)
    ? first
    : undefined;
};
const pairPayments = (
  credits: ReadonlyArray<Credit>,
  payments: ReadonlyArray<Payment>,
  clients: ReadonlyArray<Client>,
) => {
  const byDay = Map.groupBy(payments, (p) => `${p.currency}:${p.paidOn}`);
  const offers = credits.flatMap((b) =>
    Array.from({ length: 2 * PAIR_DAYS + 1 }, (_, i) => checkDay(b.date, i - PAIR_DAYS))
      .flatMap((day) =>
        (byDay.get(`${b.currency}:${day}`) ?? []).flatMap((p) => possiblePair(b, p)),
      )
      .filter(({ p }) => otherPayer(b, p, clients) === undefined),
  );
  const payOffers = Map.groupBy(offers, (pair) => pair.p.paymentId);
  return [...Map.groupBy(offers, (pair) => pair.b.recordId).values()].flatMap((options) => {
    const winner = best(options);
    return winner !== undefined && best(payOffers.get(winner.p.paymentId) ?? []) === winner
      ? [winner]
      : [];
  });
};

const notAtBank = (p: Payment, statements: ReadonlyArray<BankCoverage>): Line => {
  const span = statements.find((one) => one.currency === p.currency && rangeHas(one, p.paidOn));
  return {
    id: `payment:${p.paymentId}`,
    group: span === undefined ? "notSeenYet" : "kinOnly",
    day: p.paidOn,
    payments: [paymentLine(p)],
    text:
      span === undefined
        ? `${onKin(p)}; no statement covers that day, and no alert shows it.`
        : `${onKin(p)}${names(p)}; the confirmed statement for ${niceRange(span.from, span.through)} has no credit like it.`,
  };
};

const readCheck = Effect.fn("KinMoneyInCheck.read")(function* (
  orgId: KinOrgId,
  input: Input,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const today = dayIn(now, zone);
  if (input.from > input.through || input.through > today)
    return yield* invalid("from must be on or before through, and through no later than today.");
  if (dayGap(input.from, input.through) >= 366)
    return yield* invalid("Check at most a year at a time.");
  const clients = yield* sql<Client>`SELECT record_id AS id, key, title AS name FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'clients' AND state <> 'dropped' ORDER BY key`;
  const client =
    input.client === undefined ? undefined : clients.find((one) => one.key === input.client);
  if (input.client !== undefined && client === undefined)
    return yield* invalid(`No client ${input.client}.`);
  const def = yield* findBankList(orgId);
  const { covered, statements, seen } = yield* coverageOf(orgId, input, zone, now, def?.id);
  if (input.account !== undefined && !seen.has(input.account))
    return yield* invalid(
      `No bank account ending ${input.account} in Bank transactions or the confirmed statements.`,
    );
  const lookAhead = checkDay(input.through, PAIR_DAYS);
  const widened = {
    from: checkDay(input.from, -PAIR_DAYS),
    through: lookAhead < today ? lookAhead : today,
  };
  const all = def === undefined ? [] : yield* bankCredits(orgId, def, zone, widened);
  const accountFits = (b: Credit) =>
    input.account === undefined || b.account?.endsWith(input.account);
  const creditCounts = (b: Credit) => b.clean === 1 && b.trusted === 1;
  const credits = all.filter(creditCounts);
  const byIds = (bankIds: ReadonlyArray<string>) =>
    recordedPayments(orgId, widened.from, {
      through: input.through,
      bankIds,
    });
  const periodPayments = yield* byIds(credits.map((b) => b.recordId));
  const creditIds = new Set(all.map((b) => b.recordId));
  const more =
    def === undefined
      ? []
      : yield* bankCredits(orgId, def, zone, widened, [
          ...new Set(
            periodPayments.flatMap((p) =>
              p.bankId === null || creditIds.has(p.bankId) ? [] : [p.bankId],
            ),
          ),
        ]);
  const extra = more.filter(creditCounts);
  const banks = [...credits, ...extra];
  const payments = (
    extra.length === 0 ? periodPayments : yield* byIds(banks.map((b) => b.recordId))
  ).map(cash);
  const byBank = new Map(banks.map((b) => [b.recordId, b]));
  const tied = Map.groupBy(
    payments.filter((p) => p.bankId !== null && byBank.has(p.bankId)),
    (p) => p.bankId,
  );
  const paymentFits = (p: Payment) => client === undefined || p.clientId === client.id;
  const bankInRange = (b: Credit) => rangeHas(input, b.date);
  const paymentInRange = (p: Payment) => rangeHas(input, p.paidOn);
  const pending = payments.filter((p) => p.bankId === null || !tied.has(p.bankId));
  const state = def === undefined ? undefined : bankStates(def);
  const otherMoney = (b: Credit) =>
    b.state === state?.explained &&
    b.state !== state.open &&
    b.category !== null &&
    b.category !== "payment received";
  const lostTie = (b: Credit) =>
    b.state === state?.explained && b.state !== state.open && b.category === "payment received";
  const paired = pairPayments(
    credits.filter((b) => !tied.has(b.recordId) && !otherMoney(b) && !lostTie(b)),
    pending,
    clients,
  );
  const pairedBank = new Set(paired.map(({ b }) => b.recordId));
  const pairedPay = new Set(paired.map(({ p }) => p.paymentId));
  const lines: Array<Line> = [];
  for (const b of banks) {
    const paid = tied.get(b.recordId) ?? [];
    if (
      accountFits(b) &&
      (paid.length > 0 || lostTie(b)) &&
      (client === undefined || paid.some(paymentFits)) &&
      (bankInRange(b) || paid.some(paymentInRange))
    )
      lines.push(tiedLine(b, paid, clients));
  }
  for (const pair of paired) {
    if (
      accountFits(pair.b) &&
      paymentFits(pair.p) &&
      (bankInRange(pair.b) || paymentInRange(pair.p))
    )
      lines.push(pairedLine(pair));
  }
  for (const p of pending)
    if (paymentFits(p) && paymentInRange(p) && !pairedPay.has(p.paymentId))
      lines.push(notAtBank(p, statements));

  const left = credits.filter(
    (b) => accountFits(b) && bankInRange(b) && !tied.has(b.recordId) && !pairedBank.has(b.recordId),
  );
  const explained = client === undefined ? left.filter(otherMoney).length : 0;
  const unmatched = left.filter((b) => !otherMoney(b) && !lostTie(b));
  const ranked = new Map(
    (yield* rankAll(
      orgId,
      unmatched.filter((b) => b.state === state?.open),
    )).map((r) => [r.credit.recordId, r]),
  );
  for (const b of unmatched) {
    const offer = ranked.get(b.recordId);
    const first =
      offer?.recorded === undefined && offer?.first.length === 1
        ? offer.first[0]?.invoice
        : undefined;
    const choice = offer?.recorded === undefined ? offer?.choice : undefined;
    if (
      client !== undefined &&
      first?.clientId !== client.id &&
      !choice?.options.some(({ invoice }) => invoice.clientId === client.id) &&
      nameIn(client.name, b.title) < 0.5
    )
      continue;
    lines.push(
      first !== undefined
        ? bankLine(
            b,
            "bankOnly",
            `${bankWords(b)}, looks like ${first.key}'s payment${names(first)}.`,
            [],
            { invoice: first.key },
          )
        : choice !== undefined
          ? bankLine(
              b,
              "bankOnly",
              `${bankWords(b)}, names ${choice.client}, and Kin can't tell which of ${choice.client}'s open invoices it pays.`,
            )
          : bankLine(b, "bankOnly", `${bankWords(b)}: Kin can't tell what it is.`),
    );
  }

  const leftOut = all.filter((b) => b.clean !== 1 && accountFits(b) && bankInRange(b)).length;
  if (leftOut > 0)
    covered.push(
      `${leftOut} Bank transactions ${leftOut === 1 ? "entry" : "entries"} that an agent wrote or changed ${leftOut === 1 ? "is" : "are"} not counted as the bank's word.`,
    );
  if (input.account !== undefined)
    covered.push("Kin does not know which account an unpaired payment went into.");
  if (def === undefined) covered.push(NO_BANK_LINES);

  const counts = { matched: explained, bankOnly: 0, kinOnly: 0, notSeenYet: 0, differs: 0 };
  for (const line of lines) counts[line.group]++;
  const filters = [
    client?.name,
    input.account === undefined ? undefined : `••${input.account}`,
  ].filter(Boolean);
  const card: Omit<Card, "text"> = {
    ...input,
    checkedOn: today,
    title: `Money in, ${niceRange(input.from, input.through)}, against the bank${filters.length === 0 ? "" : ` for ${filters.join(" and ")}`}`,
    counts,
    explained,
    covered,
    lines: lines.toSorted(
      (a, b) =>
        groups.indexOf(a.group) - groups.indexOf(b.group) ||
        a.day.localeCompare(b.day) ||
        a.id.localeCompare(b.id),
    ),
  };
  return { ...card, text: cardText(card) };
});

export const checkMoneyIn = Effect.fn("KinMoneyInCheck.snapshot")(function* (
  orgId: KinOrgId,
  input: Input,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* readCheck(orgId, input, now).pipe(sql.withTransaction, readOnly);
});

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(KinMoneyInCheckCard));
const checkChat = Effect.fn("KinMoneyInCheck.chat")(function* (lead: Lead, input: Input) {
  const chat = yield* turnChat(lead);
  if (
    chat?.asked !== true ||
    !(yield* toolAdmitted(lead, TYPE, input)) ||
    !(yield* ownerLevelAsked(lead.orgId, lead.agentId, lead.wakeupId))
  )
    return yield* new KinChatError({ reason: "not_allowed", message: MONEY_IN_CHECK_REFUSAL });
  return chat.chatId;
});

// leadTool owns the span and resolves the stored lead turn.
const postCheck = Effect.fnUntraced(function* (lead: Lead, input: Input) {
  const chatId = yield* checkChat(lead, input);
  const result = yield* checkMoneyIn(lead.orgId, input, yield* Clock.currentTimeMillis);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* checkChat(lead, input)) !== chatId)
        return yield* new KinChatError({ reason: "not_allowed", message: MONEY_IN_CHECK_REFUSAL });
      const [previous] = yield* sql<{ id: string; state: string; closed: string | null }>`SELECT
      w.widget_id AS id, w.state_json AS state, w.closed_at AS closed
      FROM kin_widgets w JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
      WHERE w.org_id = ${lead.orgId} AND w.chat_id = ${chatId} AND w.type = ${TYPE}
        AND m.author_kind = 'system' AND m.kind = 'system' AND w.widget_class = 'native'
        AND json_extract(w.state_json, '$.from') <= ${input.through}
        AND json_extract(w.state_json, '$.through') >= ${input.from}
        AND json_extract(w.state_json, '$.account') IS ${input.account ?? null}
        AND json_extract(w.state_json, '$.client') IS ${input.client ?? null}
      ORDER BY m.seq DESC LIMIT 1`;
      const prior =
        previous === undefined ? undefined : Option.getOrUndefined(decodeState(previous.state));
      const state =
        prior === undefined ? result : { ...result, changes: changesSince(prior, result) };
      const text = cardText(state);
      const card = yield* postCard({
        orgId: lead.orgId,
        chatId,
        agentId: lead.agentId,
        widgetId: `w_${SecureRandom.uuidV4Unsafe()}`,
        type: TYPE,
        text,
        state: { ...state, text },
        needsAnswer: false,
      });
      if (prior !== undefined && previous !== undefined && previous.closed === null)
        yield* updateCard(
          lead.orgId,
          previous.id,
          { ...prior, superseded: true, text: `A newer check is below.\n${prior.text}` },
          true,
        );
      const heads = groupHeads(result.counts);
      const reply = `${heads.matched}, ${heads.bankOnly}, ${heads.kinOnly}, ${heads.notSeenYet}, and ${heads.differs}. The details are on the card.`;
      const lines: Array<(typeof MoneyInCheckResult.Type)["lines"][number]> = [];
      let remainingKeys = 40;
      for (const line of result.lines) {
        if (remainingKeys === 0) break;
        const invoice = line.invoice ?? line.payments[0]?.key;
        const bank = line.bank;
        if (bank !== undefined) remainingKeys--;
        if (invoice !== undefined && remainingKeys > 0) {
          remainingKeys--;
          lines.push({ group: line.group, ...(bank === undefined ? {} : { bank }), invoice });
        } else if (bank !== undefined) lines.push({ group: line.group, bank });
      }
      return {
        card,
        from: input.from,
        through: input.through,
        counts: result.counts,
        covered: result.covered,
        reply,
        lines,
      };
    }),
  );
});
export const moneyInCheck = leadTool("KinMoneyInCheck.run", postCheck);
