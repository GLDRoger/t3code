import { isKinCurrency } from "@t3tools/contracts";

import { encoded } from "../lead/quote.ts";

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A watched number as the prompt names it: its name as the company wrote it, and its key. */
export const named = (number: { readonly key: string; readonly name: string }) =>
  `${encoded(number.name)} (${number.key})`;

export const namedList = (
  numbers: ReadonlyArray<{ readonly key: string; readonly name: string }>,
) => listed(numbers.map(named));

const grouped = (decimal: string) => {
  const [whole = "", fraction] = decimal.split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = whole.slice(sign.length).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${digits}${fraction === undefined ? "" : `.${fraction}`}`;
};

/** A decimal with its unit: "1,000", "3%", "USD 1,200"; any other unit is the company's word. */
export const figure = (decimal: string, unit: string | undefined) => {
  if (unit === undefined) return grouped(decimal);
  if (unit === "%") return `${grouped(decimal)}%`;
  if (isKinCurrency(unit.toUpperCase())) return `${unit.toUpperCase()} ${grouped(decimal)}`;
  return `${grouped(decimal)} ${encoded(unit)}`;
};

/** When a number with limits makes Kin speak up: "speak up below 1,000 or above 5,000". */
export const limitText = (number: {
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
}) => {
  const sides = [
    ...(number.below === undefined ? [] : [`below ${figure(number.below, number.unit)}`]),
    ...(number.above === undefined ? [] : [`above ${figure(number.above, number.unit)}`]),
  ];
  return sides.length === 0 ? undefined : `speak up ${sides.join(" or ")}`;
};

/** What the keeper of a number outside its limit is woken with. */
export const offTurnText = (number: {
  readonly key: string;
  readonly name: string;
  readonly unit?: string | undefined;
  readonly value: string;
  readonly asOf: string;
  readonly side: "above" | "below";
  readonly limit: string;
}) =>
  `${named(number)} is ${figure(number.value, number.unit)} as of ${number.asOf}, ${number.side} its limit of ${figure(number.limit, number.unit)}. Look at what moved (numbers_read gives the days before), then do the first useful thing yourself: a suggested task, a mail drafted on a Confirm card, or a list entry. Post one line to the owner saying what moved and what you drafted. Don't ask a question and don't assign anyone.`;

/** What a feed's scheduled run tells its keeper. */
export const feedTurnText = (
  numbers: ReadonlyArray<{ readonly key: string; readonly name: string }>,
  source: string,
  period: string,
) =>
  `Record ${namedList(numbers)} from ${encoded(source)} as of ${period}. If this is the first run, record up to 28 days back. If the source can't be read, say so in one line and record nothing.`;

/** How often a feed runs, as the keeper's prompt line says it. */
export const cadenceText = (every: "day" | "week" | "month") =>
  every === "day" ? "every day" : every === "week" ? "every Monday" : "every month";

interface CardNumber {
  readonly name: string;
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
  readonly compute?: unknown;
}
interface CardFeed {
  readonly source: string;
  readonly every: "day" | "week" | "month";
  readonly at: string;
}
interface CardExisting {
  readonly key: string;
  readonly name: string;
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
}
const quoted = (word: string) => `"${word}"`;
const plain = (decimal: string, unit: string | undefined) =>
  unit === undefined || unit === "%"
    ? figure(decimal, unit)
    : `${figure(decimal, undefined)} ${unit}`;
const limitOf = (number: {
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
}) => {
  const sides = [
    ...(number.below === undefined ? [] : [`below ${plain(number.below, number.unit)}`]),
    ...(number.above === undefined ? [] : [`above ${plain(number.above, number.unit)}`]),
  ];
  return sides.length === 0 ? undefined : sides.join(" or ");
};

/** One card line per number: its limit, where its value comes from and when it is fetched. */
export const cardLine = (
  number: CardNumber,
  feed: CardFeed | undefined,
  existing: CardExisting | undefined,
  extra: { readonly keptBy?: string | undefined } = {},
) => {
  const unit = number.unit ?? existing?.unit;
  const next = {
    unit,
    above: number.above ?? existing?.above,
    below: number.below ?? existing?.below,
  };
  const sides = limitOf(next);
  const limit = sides === undefined ? "no limit" : `speak up ${sides}`;
  const before = existing === undefined ? undefined : (limitOf(existing) ?? "no limit");
  const origin =
    number.compute !== undefined
      ? "Kin works it out from its own records"
      : feed !== undefined
        ? `from ${quoted(feed.source)}, fetched ${cadenceText(feed.every)} at ${feed.at}`
        : existing === undefined
          ? "typed in by you"
          : undefined;
  const parts = [
    before !== undefined && before !== (sides ?? "no limit") ? `${limit} (now ${before})` : limit,
    ...(origin === undefined ? [] : [origin]),
    ...(extra.keptBy === undefined ? [] : [extra.keptBy]),
  ];
  return existing === undefined
    ? `Watch ${quoted(number.name)}: ${parts.join("; ")}`
    : `Change ${quoted(existing.name)} (${existing.key}): ${parts.join("; ")}`;
};

export const WATCH_NEXT =
  "Nothing is watched yet. Kin showed this on a card in this chat; it applies when they tap Confirm. Say so in one line.";
/** The tool's answer for numbers not watched yet: each line of the owner's card, and what to say. */
export const proposedAnswer = (numbers: ReadonlyArray<CardNumber>, feed: CardFeed | undefined) => ({
  proposed: numbers.map((number) => cardLine(number, feed, undefined)),
  next: WATCH_NEXT,
});
