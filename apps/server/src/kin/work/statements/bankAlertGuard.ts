import { isKinCurrency, parseKinMoney } from "@t3tools/contracts";

import { DAY_MS } from "../../durations.ts";
import type { AlertProposal } from "./BankAlertReader.ts";
import type { BankAlert } from "./bankAlerts.ts";
import { referenceKey } from "./bankList.ts";
import { parseDay } from "./statementTable.ts";

const DEBIT = /\b(?:debit(?:ed)?|spent|spend|paid out|withdraw(?:al|n)?|money (?:out|left))\b/i;
const CREDIT = /\b(?:credit(?:ed)?|received|deposit(?:ed)?|paid in|money (?:in|arrived))\b/i;
const BALANCE = /\b(?:balance|bal)\b/i;
const NON_AMOUNT_LABEL =
  /\b(?:account|a\/c|card|ref(?:erence)?|utr)(?:\s+(?:no\.?|number|ending in))?\s*:?\s*$/i;
const NOT_MOVED =
  /\b(?:not|never|failed|declined|rejected|reversed|scheduled|pending|will|ignore|reply)\b/i;
const CURRENCY_LABEL = /\bcurrency(?: code)?\s*:\s*(\S+)/gi;
const CURRENCY_TOKEN = String.raw`(?:[A-Z]{3}|[A-Za-z]{0,3}\p{Sc}|[Rr][Ss]\.?)`;
const currencyBefore = new RegExp(String.raw`(?<![\p{L}\p{Sc}])(${CURRENCY_TOKEN})[ \t]*$`, "u");
const currencyAfter = new RegExp(String.raw`^[ \t]*(${CURRENCY_TOKEN})(?![\p{L}\p{Sc}])`, "u");

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

function* figuresIn(text: string) {
  const blocks = text.split(/[\r\n;!?]|\.(?=\s|$)(?<!\b(?:rs|no|ref|avl|bal)\.)/i);
  for (const block of blocks) {
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
      yield {
        printed: match[0],
        currencies: [prefix, suffix].filter((v) => v !== undefined),
        block,
      };
    }
  }
}

const hasReference = (text: string, reference: string) => {
  const key = referenceKey(reference);
  return (
    reference.length >= 6 &&
    reference.length <= 40 &&
    /^[a-z0-9][a-z0-9 /_.-]*[a-z0-9]$/i.test(reference) &&
    key !== "" &&
    /\d/.test(reference) &&
    new RegExp(
      String.raw`(?<![a-z0-9])0*${[...key].join(String.raw`[ /_.-]{0,3}`)}(?![a-z0-9])`,
      "i",
    ).test(text)
  );
};

const MARKED_ACCOUNT =
  /(?:\b(?:account|a\/c|card)(?:\s+(?:no\.?|number|ending in))?\s*:?\s*[*x•]*|[*x•]{2,})(\d{4,})/gi;

export const printedAccountEndings = (text: string) =>
  new Set([...text.matchAll(MARKED_ACCOUNT)].map((match) => match[1]!.slice(-4)));

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
    !hasReference(text, reference)
  )
    return null;

  const account = read.account.slice(-4);
  if (!/^\d{4,34}$/.test(read.account) || !printedAccountEndings(text).has(account)) return null;
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

  const movements = figures.flatMap(({ block, ...figure }) => {
    if (BALANCE.test(block) || NOT_MOVED.test(block)) return [];
    const debit = DEBIT.test(block);
    if (debit === CREDIT.test(block)) return [];
    return [{ ...figure, way: debit ? "debit" : "credit" }];
  });
  const amountMinor = minorOf(read.amount, currency);
  if (
    amountMinor === undefined ||
    amountMinor <= 0 ||
    !movements.some(({ printed, way, currencies }) => {
      const named = [...currencies, ...currencyLabels];
      return (
        printed === read.amount &&
        way === direction &&
        (read.currency === null ||
          (named.includes(read.currency) &&
            named.every(
              (token) =>
                currencyCode(token) === currency ||
                (currencyCode(token) === undefined && !/\p{Sc}/u.test(token)),
            )))
      );
    })
  )
    return null;

  for (const movement of movements) {
    for (const token of movement.currencies) {
      const named = currencyCode(token);
      if (named === undefined) continue;
      const minor = minorOf(movement.printed, named);
      if (
        minor !== undefined &&
        minor > 0 &&
        (movement.way !== direction || named !== currency || minor !== amountMinor)
      )
        return null;
    }
  }

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
    account,
    date,
    reference,
    counterparty:
      counterparty !== "" &&
      counterparty.length <= 120 &&
      tidy(text).toLowerCase().includes(counterparty.toLowerCase())
        ? counterparty
        : null,
    balanceMinor,
    sentAt,
  };
};
