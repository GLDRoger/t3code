import {
  isKinCurrency,
  type KinBankAlertNotCounted,
  kinCurrency,
  parseKinMoney,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { parseDay } from "./statementTable.ts";

/**
 * A bank's alert mail as plain code reads it, for any bank, country, currency or language: the
 * stable signs (an amount with its currency, a credit or debit word, the account's last digits)
 * and the fields of one alert. Whatever reads an alert, its fields are checked here by the server
 * against stored rows before anything counts; nothing here decides what to record.
 */

export type Direction = "credit" | "debit";
export type AlertRead = typeof AlertRead.Type;

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const Minor = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-Number.MAX_SAFE_INTEGER),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
/** One alert's fields, bounded: what any reader may hand back, and nothing else. */
export const AlertRead = Schema.Struct({
  amountMinor: Minor.check(Schema.isGreaterThan(0)),
  currency: Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)),
  direction: Schema.Literals(["credit", "debit"]),
  day: Day,
  account: Schema.String.check(Schema.isPattern(/^\d{4}$/)),
  party: Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  balanceMinor: Schema.NullOr(Minor),
  reference: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
});

/** The mail as a reader gets it: its words only, and the day it arrived in the company's zone. */
export type AlertMail = {
  readonly subject: string;
  readonly text: string;
  readonly mailDay: string;
  /** The company's home currency: what a bare "$" reads as when it is one of the dollars. */
  readonly home: string;
};

const TEXT_CHARS = 4_000;
const NUMBER = String.raw`\d{1,3}(?:[\u00a0\u202f' ]\d{3})+(?:[.,]\d{1,3})?|\d[\d.,]*\d|\d`;
// Prefix forms ("INR 500", "€500", "Rs.500") come first; a suffix form ("500,00 EUR") counts only
// where none overlaps it, and never right after a date's or a masked account's digits.
const PREFIXED = new RegExp(
  String.raw`(?<![\p{L}\d])(?:(?<code>[A-Z]{3})|(?<symbol>[A-Z]{0,3}\p{Sc}|Rs\.?))\s?(?<num>${NUMBER})`,
  "gu",
);
const SUFFIXED = new RegExp(
  String.raw`(?<![\p{L}\d*•·∗#/.\-])(?<num>${NUMBER})\s?(?:(?<code>[A-Z]{3})(?![\p{L}])|(?<symbol>\p{Sc}))`,
  "gu",
);
// A card's name is not the alert's direction.
const CARD_WORDS =
  /(?:credit|debit)\s+card|tarjeta\s+de\s+(?:cr[ée]dito|d[ée]bito)|cart[ãa]o\s+de\s+(?:cr[ée]dito|d[ée]bito)|carte\s+de\s+(?:cr[ée]dit|d[ée]bit)|(?:kredit|debit)karte/giu;
const CREDIT_WORDS = [
  "credited",
  "credit",
  "received",
  "deposited",
  "deposit",
  "money in",
  "incoming",
  "refunded",
  "refund",
  "abono",
  "abonado",
  "abonada",
  "acreditado",
  "acreditada",
  "crédito",
  "recibido",
  "recibida",
  "recebido",
  "recebida",
  "reçu",
  "crédité",
  "créditée",
  "gutschrift",
  "gutgeschrieben",
  "zahlungseingang",
  "eingang",
  "accredito",
  "accreditato",
  "bijgeschreven",
  "ontvangen",
  "diterima",
  "masuk",
  "kredit",
  "जमा",
  "入金",
  "入账",
  "存入",
];
const DEBIT_WORDS = [
  "debited",
  "debit",
  "withdrawn",
  "withdrawal",
  "spent",
  "sent",
  "paid",
  "purchase",
  "charged",
  "cargo",
  "cargado",
  "debitado",
  "debitada",
  "débito",
  "compra",
  "retiro",
  "retirada",
  "débité",
  "débitée",
  "prélèvement",
  "paiement",
  "lastschrift",
  "abgebucht",
  "belastung",
  "belastet",
  "abbuchung",
  "addebito",
  "addebitato",
  "afgeschreven",
  "didebit",
  "keluar",
  "डेबिट",
  "निकासी",
  "出金",
  "支出",
  "扣款",
];
const wordsPattern = (words: ReadonlyArray<string>) =>
  new RegExp(
    `(?<![\\p{L}])(?:${words
      .toSorted((a, b) => b.length - a.length)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?![\\p{L}])`,
    "iu",
  );
const CREDIT = wordsPattern(CREDIT_WORDS);
const DEBIT = wordsPattern(DEBIT_WORDS);
const MASKED = /(?<![\p{L}\d])(?:[Xx*•·∗#]{2,}|\.{2,})[\s-]?(\d{4})(?!\d)/u;
const ENDING =
  /(?:ending(?:\s+(?:in|with))?|terminad[ao]\s+en|final(?:izada)?\s+(?:em|en)|endet\s+auf|endend\s+auf|se\s+terminant\s+par|terminant\s+par|eindigend\s+op|berakhiran)\s*[:#]?\s*(\d{4})(?!\d)/iu;
const ACCOUNT =
  /(?<![\p{L}])(?:a\/c|acct|account|cuenta|conta|compte|konto|rekening|खाता)\.?\s*(?:no\.?|number|nº|n°|#)?\s*[:#]?\s*[Xx*•.]*(\d{4})(?!\d)/iu;
const BALANCE =
  /(?:avail(?:able)?\.?\s*bal(?:ance)?|avl\.?\s*bal|bal(?:ance)?|saldo|solde|kontostand|disponible|disponível|शेष)[^\d\n]{0,12}$/iu;
const REFERENCE =
  /(?<![\p{L}])(?:ref(?:erence)?|réf(?:érence)?|referencia|referência|referenz|rif(?:erimento)?|txn|transaction|trx)\.?\s*(?:id|no\.?|number|nr\.?|#)?\s*[:#.-]?\s*([A-Z0-9][A-Z0-9/-]{5,29})/iu;
const DATES = [
  /(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/gu,
  /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/gu,
  /(?<!\d)\d{1,2}(?:st|nd|rd|th)?[\s/.-]?[A-Za-z]{3,9}[\s/.,-]*(?:\d{4}|\d{2})(?!\d)/gu,
  /(?<![\p{L}])[A-Za-z]{3,9}\s\d{1,2},?\s\d{4}(?!\d)/gu,
];
const PARTY_FROM = /(?<![\p{L}])(?:from|by|de|von|da|dari|par|desde)\s+/giu;
const PARTY_TO = /(?<![\p{L}])(?:to|at|towards|para|an|à|ke|chez|bei|presso|naar|aan|for)\s+/giu;
const PARTY_END =
  /\s+(?:on|via|ref|reference|with|using|el|le|am|em|il|op|pada|at|in|is|has|was|avl|available|bal|en|auf|sur|dans|na|no|for|and|y|e|et|und)(?![\p{L}])|[\n.;,:()]|\s{2,}/iu;
const LABELLED_PARTY =
  /(?:^|\n)\s*(?:merchant|payee|payer|beneficiary|remitter|counterparty|sender|recipient|from|to|ordenante|beneficiario|comercio|empfänger|auftraggeber|bénéficiaire|émetteur|favorecido|pagador)\s*:\s*([^\n]{2,80})/iu;
const NOT_A_PARTY =
  /(?:a\/c|acct|account|cuenta|conta|compte|konto|rekening|your|you|tu|su|votre|ihr|ihrem|ihre|seu|sua)(?![\p{L}])|[Xx*•]{2,}\d/iu;

type Mention = {
  readonly at: number;
  readonly end: number;
  readonly minor: number;
  readonly currency: string;
  readonly balance: boolean;
};

/** A symbol's currency: a bare "$" is the company's own when its currency is a dollar. */
const symbolCurrency = (symbol: string, home: string) => {
  if (symbol === "$" && kinCurrency(home).symbol.endsWith("$")) return home;
  const read = parseKinMoney(`${symbol.replace(/\.$/, "")}1`, "XXX");
  return "money" in read && read.money.currency !== "XXX" ? read.money.currency : undefined;
};

const mentionsOf = (text: string, home: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].flatMap((match): ReadonlyArray<Mention> => {
    const { code, symbol, num } = match.groups ?? {};
    const currency =
      code !== undefined
        ? isKinCurrency(code)
          ? code
          : undefined
        : symbol === undefined
          ? undefined
          : symbolCurrency(symbol, home);
    const number = (num ?? "").replace(/[\u00a0\u202f' ]/gu, "");
    if (currency === undefined || number === "") return [];
    const read = parseKinMoney(`${number} ${currency}`, currency);
    if (!("money" in read) || read.money.minor <= 0) return [];
    const at = match.index;
    return [
      {
        at,
        end: at + match[0].length,
        minor: read.money.minor,
        currency: read.money.currency,
        balance: BALANCE.test(text.slice(Math.max(0, at - 40), at)),
      },
    ];
  });
const mentionsIn = (text: string, home: string): ReadonlyArray<Mention> => {
  const prefixed = mentionsOf(text, home, PREFIXED);
  const suffixed = mentionsOf(text, home, SUFFIXED).filter(
    (one) => !prefixed.some((other) => one.at < other.end && other.at < one.end),
  );
  return [...prefixed, ...suffixed].toSorted((a, b) => a.at - b.at);
};

const directionIn = (text: string): Direction | undefined => {
  const plain = text.replace(CARD_WORDS, " ");
  const credit = CREDIT.exec(plain)?.index;
  const debit = DEBIT.exec(plain)?.index;
  if (credit === undefined) return debit === undefined ? undefined : "debit";
  return debit === undefined || credit < debit ? "credit" : "debit";
};

const accountIn = (text: string) =>
  (MASKED.exec(text) ?? ENDING.exec(text) ?? ACCOUNT.exec(text))?.[1];

/**
 * Whether mail looks like a bank's alert, from its subject and the text the poll already holds:
 * an amount with its currency, a credit or debit word and an account's last four digits. Plain
 * code on stable signs, never a model; the account is what the card asks about.
 */
export const alertSigns = (text: string, home: string) => {
  const said = text.slice(0, TEXT_CHARS);
  const money = mentionsIn(said, home).find((one) => !one.balance);
  const direction = directionIn(said);
  const account = accountIn(said);
  if (money === undefined || direction === undefined || account === undefined) return undefined;
  return {
    amount: { minor: money.minor, currency: money.currency },
    direction,
    account,
  };
};

/** Money that hasn't moved, or no money at all: the plain reader leaves these to a reader that understands them. */
const NOT_MOVED = wordsPattern([
  "declined",
  "decline",
  "failed",
  "failure",
  "unsuccessful",
  "rejected",
  "reversed",
  "cancelled",
  "canceled",
  "pending",
  "scheduled",
  "will be",
  "due",
  "authorisation",
  "authorization",
  "hold",
  "otp",
  "one-time",
  "one time",
  "verification",
  "code",
  "statement",
  "rechazada",
  "rechazado",
  "denegada",
  "pendiente",
  "programado",
  "refusé",
  "refusée",
  "en attente",
  "abgelehnt",
  "ausstehend",
  "vorgemerkt",
  "recusada",
  "pendente",
  "rifiutato",
  "in sospeso",
  "geweigerd",
  "ditolak",
  "अस्वीकृत",
  "拒否",
  "失败",
]);

const ACCOUNTS = [
  new RegExp(MASKED.source, "gu"),
  new RegExp(ENDING.source, "giu"),
  new RegExp(ACCOUNT.source, "giu"),
];
const accountsIn = (text: string) =>
  new Set(
    ACCOUNTS.flatMap((pattern) => [...text.matchAll(pattern)].flatMap((one) => one[1] ?? [])),
  );

/** The one real calendar day the text names, undefined when it names none, null when it can't be told. */
const namedDay = (text: string): string | null | undefined => {
  const days = new Set<string>();
  for (const pattern of DATES)
    for (const match of text.matchAll(pattern)) {
      const read = new Set(
        (["dmy", "mdy"] as const).flatMap((order) => parseDay(match[0], order) ?? []),
      );
      // A date that is no real day, or one read two ways, can't be told.
      if (read.size !== 1) return null;
      days.add([...read][0]!);
    }
  if (days.size > 1) return null;
  return [...days][0];
};

const partyIn = (text: string, direction: Direction, after: number) => {
  const labelled = LABELLED_PARTY.exec(text)?.[1]?.trim();
  if (labelled !== undefined && !NOT_A_PARTY.test(labelled)) return labelled.slice(0, 80);
  const pattern = direction === "credit" ? PARTY_FROM : PARTY_TO;
  const tail = text.slice(after);
  for (const source of [tail, text]) {
    for (const match of source.matchAll(pattern)) {
      const rest = source.slice(match.index + match[0].length);
      const stop = PARTY_END.exec(rest);
      const name = (stop === null ? rest : rest.slice(0, stop.index)).trim().slice(0, 80);
      if (Array.from(name).length >= 2 && !NOT_A_PARTY.test(name) && !/^\d/.test(name)) return name;
    }
  }
  return null;
};

/**
 * The plain reader: one alert's fields only when its words leave no doubt. Exactly one amount (a
 * balance aside), one direction, one account, at most one real day, and nothing saying the money
 * didn't move; anything else is left unread for a reader that understands it. Never a guess.
 */
export const readAlertText = (mail: AlertMail): AlertRead | undefined => {
  const text = `${mail.subject}\n${mail.text}`.slice(0, TEXT_CHARS);
  const plain = text.replace(CARD_WORDS, " ");
  if (NOT_MOVED.test(plain)) return undefined;
  const mentions = mentionsIn(text, mail.home);
  const amounts = mentions.filter((one) => !one.balance);
  const amount = amounts[0];
  if (
    amount === undefined ||
    amounts.some((one) => one.minor !== amount.minor || one.currency !== amount.currency)
  )
    return undefined;
  const credit = CREDIT.test(plain);
  const debit = DEBIT.test(plain);
  if (credit === debit) return undefined;
  const direction = credit ? "credit" : "debit";
  const accounts = accountsIn(text);
  if (accounts.size !== 1) return undefined;
  const day = namedDay(text);
  if (day === null) return undefined;
  const balances = mentions.filter((one) => one.balance && one.currency === amount.currency);
  const reference = REFERENCE.exec(text)?.[1];
  return {
    amountMinor: amount.minor,
    currency: amount.currency,
    direction,
    day: day ?? mail.mailDay,
    account: [...accounts][0]!,
    party: partyIn(text, direction, amount.end),
    balanceMinor: balances.length === 1 ? balances[0]!.minor : null,
    reference:
      reference !== undefined && /\d/.test(reference) ? reference.toUpperCase().slice(0, 40) : null,
  };
};

/** Why an alert isn't counted; the owner reads each in Settings, in client words. */
export type AlertReason = KinBankAlertNotCounted;

/** Whether `minor` of `currency` is written in the text, in any way it may be printed. */
const amountWritten = (text: string, minor: number, currency: string) =>
  [...text.matchAll(new RegExp(NUMBER, "gu"))].some((match) => {
    const read = parseKinMoney(
      `${match[0].replace(/[\u00a0\u202f' ]/gu, "")} ${currency}`,
      currency,
    );
    return "money" in read && read.money.minor === minor;
  });

const realDay = (day: string) =>
  DateTime.make(`${day}T00:00:00Z`).pipe(
    Option.match({
      onNone: () => false,
      onSome: (at) => DateTime.formatIsoDate(at) === day,
    }),
  );

/**
 * The server's checks on one reading, whoever read it, against the mail's own text and stored
 * rows: its account and currency are the approval's, its amount and digits are in the mail, and
 * its day is real, has come, is not before the sender counted and no confirmed statement covers it.
 */
export const judgeAlert = (
  read: AlertRead,
  mail: { readonly text: string },
  approval: {
    readonly account: string;
    readonly currency: string;
    readonly today: string;
    readonly since: string;
    readonly covered: (day: string) => boolean;
  },
): AlertReason | undefined => {
  if (read.account !== approval.account) return "other_account";
  if (read.currency !== approval.currency) return "other_currency";
  if (
    !new RegExp(`(?<!\\d)${read.account}(?!\\d)`).test(mail.text) ||
    !amountWritten(mail.text, read.amountMinor, read.currency)
  )
    return "not_in_text";
  if (!realDay(read.day)) return "unreadable";
  if (read.day > approval.today) return "future";
  if (read.day < approval.since) return "before_start";
  if (approval.covered(read.day)) return "covered";
  return undefined;
};

const REPLY_OR_FORWARD =
  /^\s*(?:(?:re|fwd?|aw|wg|tr|rv|sv|vs|antw|enc|res|doorst|vb|r|i)\s*(?:\[\d+\])?\s*[:：]\s*)+/iu;
/** A reply or a forward is someone writing about an alert, never the bank's alert itself. */
export const isReplyOrForward = (mail: {
  readonly subject: string;
  readonly inReplyTo?: string | null;
  readonly references?: string | null;
}) =>
  REPLY_OR_FORWARD.test(mail.subject) ||
  (mail.inReplyTo ?? "").trim() !== "" ||
  (mail.references ?? "").trim() !== "";

// Where quoted or forwarded text starts: a `>` line, a reply's "On … wrote:", a forward's header.
const QUOTE_START =
  /^(?:\s*>|\s*-{2,}\s*(?:original message|forwarded message|mensaje original|message d'origine|ursprüngliche nachricht|mensagem original|messaggio originale)|\s*_{5,}\s*$|\s*(?:from|de|von|da|van|dari)\s*:\s.+@|.*\b(?:wrote|escribió|a écrit|schrieb|escreveu|ha scritto|schreef|menulis)\s*:\s*$)/imu;
/** The mail's own words only: everything from the first quoted or forwarded line on is cut. */
export const cutQuoted = (text: string) => {
  const at = QUOTE_START.exec(text)?.index;
  return (at === undefined ? text : text.slice(0, at)).trimEnd();
};
