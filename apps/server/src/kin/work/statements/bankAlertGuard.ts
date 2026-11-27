import { isKinCurrency, parseKinMoney } from "@t3tools/contracts";

import { DAY_MS } from "../../durations.ts";
import type { AlertProposal } from "./BankAlertReader.ts";
import type { BankAlert } from "./bankAlerts.ts";
import { parseDay } from "./statementTable.ts";

const DEBIT =
  /\b(?:debit(?:ed)?|spent|spend|paid out|paid to|sent to|used (?:for|at)|purchased?|withdraw(?:al|n)?|money (?:out|left))\b/i;
const CREDIT = /\b(?:credit(?:ed)?|received|deposit(?:ed)?|paid in|money (?:in|arrived))\b/i;
// "Debit card" and "credit card" name a card, not a way money moved.
const CARD_NAME = /\b(?:debit|credit)\s+card\b/gi;
// A credit card's spend is the card's debt, not money out of a bank account.
const CARD_DEBT = /\bcredit\s+card\b[\s\S]*\b(?:used (?:for|at)|purchased?|spent|spend)\b/i;
const BALANCE = /\b(?:balance|bal)\b/i;
const NON_AMOUNT_LABEL =
  /\b(?:account|a\/c|card)(?:\s+(?:no\.?|number|ending(?:\s+(?:in|with))?))?\s*:?\s*$|\b(?:ref(?:erence)?|utr)(?:\s+(?:no\.?|number))?\s*:?\s*$/i;
const NOT_MOVED =
  /\b(?:not|never|failed|declined|rejected|reversed|scheduled|pending|will|ignore|reply|due|upcoming|hold|blocked|requested|to be)\b/i;
const CURRENCY_LABEL = /\bcurrency(?: code)?\s*:\s*(\S+)/gi;
const CURRENCY_TOKEN = String.raw`(?:[A-Z]{3}|[A-Za-z]{0,3}\p{Sc}|[Rr][Ss]\.?)`;
const currencyBefore = new RegExp(String.raw`(?<![\p{L}\p{Sc}])(${CURRENCY_TOKEN})[ \t]*$`, "u");
const currencyAfter = new RegExp(String.raw`^[ \t]*(${CURRENCY_TOKEN})(?![\p{L}\p{Sc}])`, "u");
const ENDING =
  /(?:\b(?:account|a\/c|card)(?:\s+(?:no\.?|number|ending(?:\s+(?:in|with))?))?\s*:?\s*[*x•]*|[*x•]{2,})(\d{4,})(?!\d)/gi;

const currencyCode = (token: string) => {
  if (!/^(?:[A-Za-z]{3}|[A-Za-z]{0,3}\p{Sc}|rs\.?)$/iu.test(token)) return undefined;
  const result = parseKinMoney(`${token} 0`, "");
  return "money" in result ? result.money.currency : undefined;
};

const minorOf = (printed: string, currency: string) => {
  if (printed.length > 40 || !/^[-−]?\d+(?:[,.]\d+)*$/.test(printed)) return undefined;
  const result = parseKinMoney(printed, currency);
  return "money" in result ? result.money.minor : undefined;
};

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const wayOf = (block: string) => {
  const words = block.replace(CARD_NAME, " ");
  const debit = DEBIT.test(words);
  return debit === CREDIT.test(words)
    ? debit
      ? ("both" as const)
      : null
    : debit
      ? "debit"
      : "credit";
};
/** A block that says, plainly and once, that money moved one way. */
const movedWay = (block: string) => {
  const way = wayOf(block);
  return way === "debit" || way === "credit"
    ? BALANCE.test(block) || NOT_MOVED.test(block) || CARD_DEBT.test(block)
      ? null
      : way
    : null;
};

const BLOCK = /[\r\n;!?]|\.(?=\s|$)(?<!\b(?:rs|no|ref|avl|bal)\.)/i;

function* figuresIn(text: string) {
  for (const block of text.split(BLOCK)) {
    for (const match of block.matchAll(/[-−]?\d+(?:[,.]\d+)*/g)) {
      const before = block.slice(0, match.index);
      const after = block.slice(match.index + match[0].length);
      if (NON_AMOUNT_LABEL.test(before)) continue;
      const prefix = currencyBefore.exec(before)?.[1];
      const suffix = currencyAfter.exec(after)?.[1];
      if (
        (prefix === undefined && /[\p{L}\d*/#-]$/u.test(before)) ||
        (suffix === undefined && /^[\p{L}\d/]|^[-−]\d/u.test(after))
      )
        continue;
      const currencies = [prefix, suffix].filter((v) => v !== undefined);
      yield {
        printed: match[0],
        currencies,
        // A bare figure without a separator is as likely a phone number, a code or a count.
        moneyLike: currencies.length > 0 || /[,.]\d/.test(match[0]),
        before,
        block,
      };
    }
  }
}

const hasReference = (text: string, reference: string) =>
  reference.length >= 6 &&
  reference.length <= 40 &&
  /^[a-z0-9](?:[a-z0-9/_.-]*[a-z0-9])?$/i.test(reference) &&
  /\d/.test(reference) &&
  parseDay(reference, "dmy") === undefined &&
  parseDay(reference, "mdy") === undefined &&
  new RegExp(String.raw`(?<![a-z0-9/_])${escaped(reference)}(?![a-z0-9/_]|[.-][a-z0-9])`, "i").test(
    text,
  );

const endingsIn = (text: string) => [...text.matchAll(ENDING)].map((m) => m[1]!.slice(-4));

export const printedAccountEndings = (text: string) => new Set(endingsIn(text));

export const verifyBankAlert = (
  text: string,
  read: AlertProposal,
  fallbackCurrency: string,
  sentAt: number,
): BankAlert | null => {
  const { direction, date, date_printed: printedDay, reference } = read;
  const day = Date.parse(`${date}T00:00:00Z`);
  if (
    printedDay === "" ||
    !text.includes(printedDay) ||
    (parseDay(printedDay, "dmy") !== date && parseDay(printedDay, "mdy") !== date) ||
    day < sentAt - 8 * DAY_MS ||
    day > sentAt + DAY_MS ||
    reference === null ||
    !hasReference(text, reference) ||
    !/^\d{4,34}$/.test(read.account)
  )
    return null;

  const figures = [...figuresIn(text)];
  const currencyLabels = [...text.matchAll(CURRENCY_LABEL)].map((m) => m[1]!);
  const currency = read.currency === null ? fallbackCurrency : currencyCode(read.currency);
  if (currency === undefined || !isKinCurrency(currency)) return null;
  if (
    read.currency === null &&
    (currencyLabels.length > 0 ||
      figures.some((figure) =>
        figure.currencies.some(
          (token) => currencyCode(token) !== undefined || /\p{Sc}/u.test(token),
        ),
      ))
  )
    return null;

  const amountMinor = minorOf(read.amount, currency);
  if (amountMinor === undefined || amountMinor <= 0) return null;
  const moneyOf = (figure: (typeof figures)[number]) => {
    const named = figure.currencies.map(currencyCode).filter((code) => code !== undefined);
    return (named.length === 0 ? [currency] : named).flatMap((code) => {
      const minor = minorOf(figure.printed, code);
      return minor === undefined || minor <= 0 ? [] : [{ code, minor }];
    });
  };
  const isAmount = (figure: (typeof figures)[number]) =>
    moneyOf(figure).every(({ code, minor }) => code === currency && minor === amountMinor);
  // A labelled layout's amount line may name no way: then the mail as a whole must, one way
  // only, with nothing in it negated or not yet done, and no other money in it.
  const mailWay = () => {
    if (NOT_MOVED.test(text) || CARD_DEBT.test(text)) return null;
    if (figures.some((f) => f.moneyLike && !BALANCE.test(f.block) && !isAmount(f))) return null;
    return wayOf(
      text
        .split(BLOCK)
        .filter((block) => !BALANCE.test(block))
        .join("\n"),
    );
  };
  const at = figures.find(({ printed, block, currencies, moneyLike }) => {
    const named = [...currencies, ...currencyLabels];
    return (
      printed === read.amount &&
      moneyLike &&
      (movedWay(block) === direction ||
        (wayOf(block) === null && !BALANCE.test(block) && mailWay() === direction)) &&
      (read.currency === null ||
        (named.some((token) => currencyCode(token) === currency) &&
          named.every(
            (token) =>
              currencyCode(token) === currency ||
              (currencyCode(token) === undefined && !/\p{Sc}/u.test(token)),
          )))
    );
  });
  if (at === undefined) return null;

  // Every other figure that a line about money moving prints must be this same movement, or the
  // balance that line names before it: a mail with a second movement is not one transaction.
  for (const figure of figures) {
    if (!figure.moneyLike || wayOf(figure.block) === null) continue;
    if (figure.printed === read.balance && BALANCE.test(figure.before)) continue;
    if (!isAmount(figure)) return null;
    const way = movedWay(figure.block);
    if (way !== null && way !== direction && moneyOf(figure).length > 0) return null;
  }

  // The account's last four, printed as an account or card; with several, the movement's own.
  const lastFour = read.account.slice(-4);
  const endings = new Set(endingsIn(text));
  if (!endings.has(lastFour) || (endings.size > 1 && endingsIn(at.block)[0] !== lastFour))
    return null;

  const balanceMinor =
    read.balance !== null &&
    figures.some(
      ({ printed, block, currencies }) =>
        printed === read.balance &&
        BALANCE.test(block) &&
        currencies.every((token) => currencyCode(token) === currency),
    )
      ? (minorOf(read.balance, currency) ?? null)
      : null;
  const counterparty =
    read.counterparty === null || read.counterparty.length > 120 ? "" : tidy(read.counterparty);
  return {
    direction,
    amountMinor,
    currency,
    account: lastFour,
    date,
    reference,
    counterparty:
      counterparty !== "" && tidy(text).toLowerCase().includes(counterparty.toLowerCase())
        ? counterparty
        : null,
    balanceMinor,
    sentAt,
  };
};
