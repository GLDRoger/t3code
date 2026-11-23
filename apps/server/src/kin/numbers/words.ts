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
