import { isKinCurrency, kinCurrency, parseKinMoney } from "@t3tools/contracts";
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
export const decodeAlertRead = Schema.decodeUnknownOption(AlertRead);

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

const DAY_MS = 86_400_000;
const distance = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

/** The day the alert names, read either way round, nearest the day it arrived; else that day. */
const namedDay = (text: string, mailDay: string) => {
  const days = DATES.flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) =>
      (["dmy", "mdy"] as const).flatMap((order) => parseDay(match[0], order) ?? []),
    ),
  );
  return days.toSorted((a, b) => distance(a, mailDay) - distance(b, mailDay))[0] ?? mailDay;
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
 * The plain reader: one alert's fields from its words, or undefined when its amount, direction
 * or account isn't there. A balance it states and a reference are taken only when labelled.
 */
export const readAlertText = (mail: AlertMail): AlertRead | undefined => {
  const text = `${mail.subject}\n${mail.text}`.slice(0, TEXT_CHARS);
  const mentions = mentionsIn(text, mail.home);
  const amount = mentions.find((one) => !one.balance);
  const direction = directionIn(text);
  const account = accountIn(text);
  if (amount === undefined || direction === undefined || account === undefined) return undefined;
  const balance = mentions.find((one) => one.balance && one.currency === amount.currency);
  const reference = REFERENCE.exec(text)?.[1];
  return {
    amountMinor: amount.minor,
    currency: amount.currency,
    direction,
    day: namedDay(text, mail.mailDay),
    account,
    party: partyIn(text, direction, amount.end),
    balanceMinor: balance?.minor ?? null,
    reference:
      reference !== undefined && /\d/.test(reference) ? reference.toUpperCase().slice(0, 40) : null,
  };
};

/** Why an alert isn't counted; the owner reads each in Settings, in client words. */
export type AlertReason =
  | "unreadable"
  | "other_account"
  | "other_currency"
  | "future"
  | "covered"
  | "repeat"
  | "failed_check"
  | "not_checked";

/**
 * The server's checks on one read alert, over stored rows: the account the owner confirmed for
 * this sender, its currency, a day that has come and that no confirmed statement already covers.
 */
export const judgeAlert = (
  read: AlertRead,
  sender: {
    readonly account: string;
    readonly currency: string;
    readonly today: string;
    readonly coveredThrough: string | null;
  },
): AlertReason | undefined => {
  if (read.account !== sender.account) return "other_account";
  if (read.currency !== sender.currency) return "other_currency";
  if (read.day > sender.today) return "future";
  if (sender.coveredThrough !== null && read.day <= sender.coveredThrough) return "covered";
  return undefined;
};

/**
 * Whether the receiving mail server checked the sender. Only the topmost Authentication-Results
 * is the receiver's own: a sender can write any below it. DMARC must pass for the From's own
 * domain, or DKIM must pass signed by it.
 */
export const alertSenderCheck = (
  results: ReadonlyArray<string>,
  address: string,
): "passed" | "failed" | "not checked" => {
  const top = (results[0] ?? "").toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const aligned = (name: string) => name === domain || domain.endsWith(`.${name}`);
  const dmarc = /\bdmarc=(\w+)([^;]*)/.exec(top);
  if (dmarc !== null) {
    const from = /header\.from=([^\s;]+)/.exec(dmarc[2] ?? "")?.[1];
    if (dmarc[1] === "pass") return from === undefined || from === domain ? "passed" : "failed";
    if (dmarc[1] === "fail") return "failed";
  }
  const signed = [...top.matchAll(/\bdkim=(\w+)([^;]*)/g)];
  if (
    signed.some(
      (one) =>
        one[1] === "pass" &&
        aligned(/header\.(?:d|i)=@?([^\s;]+)/.exec(one[2] ?? "")?.[1] ?? "\u0000"),
    )
  )
    return "passed";
  if (signed.some((one) => one[1] === "fail") || /\bspf=fail\b/.test(top)) return "failed";
  return "not checked";
};

const REPLY_OR_FORWARD =
  /^\s*(?:(?:re|fwd?|aw|wg|tr|rv|sv|vs|antw|enc|res|doorst|vb|r|i)\s*(?:\[\d+\])?\s*[:：]\s*)+/iu;
/** A reply or a forward is someone writing about an alert, not the bank's alert. */
export const isReplyOrForward = (subject: string) => REPLY_OR_FORWARD.test(subject);
