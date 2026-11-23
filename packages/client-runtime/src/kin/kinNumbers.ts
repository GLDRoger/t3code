// @effect-diagnostics globalDate:off - Pure view helpers work out calendar days for React render, outside an Effect runtime.
import {
  formatKinMoney,
  kinWhenParts,
  isKinCurrency,
  kinCurrency,
  type KinChartSpec,
  type KinChartUnit,
  type KinNumber,
  type KinNumberDefinition,
  type KinNumberSaveInput,
} from "@t3tools/contracts";

/**
 * Watched numbers, one model for web and phone: their words, how a value reads in the viewer's
 * locale, what the inline field accepts, and the page's chart, limits and history.
 */

export const KIN_NUMBERS = {
  title: "Numbers",
  add: "Watch a number",
  edit: "Change number",
  save: "Save",
  archive: "Archive",
  restore: "Restore",
  archived: "Archived",
  share: "Teammates who see Money can see it",
  noValue: "No value yet",
  off: "Outside its limit",
  stale: "Not updated lately",
  today: "Today's value",
  type: "Type today's value",
  typeCorrection: "Type the right value",
  saving: "Saving…",
  saved: "Saved",
  correct: "Correct",
  correctOf: (day: string) => `Correct the value for ${day}`,
  correctionsKept:
    "A correction is a newer value for the same day. The one it replaces stays in the history.",
  replaced: "Replaced",
  history: "History",
  chartTitle: "Each day's value",
  noHistory: "Nothing recorded yet.",
  computed: (source: string) => `Kin works this out from ${source} each time it's opened.`,
  computedPlain: "Kin works this out from its own records each time it's opened.",
  limits: "Limits",
  noLimits: "No limits set.",
  empty: {
    title: "Watch the numbers your company lives by",
    detail:
      "A watched number has a value for each day or week: daily users, refund rate, stock on hand, money collected. Type it here, and Kin tells you when it goes outside its limits.",
    agent: "An agent can keep one filled when you ask it in chat.",
  },
  emptyMember: "Nothing has been shared with you yet.",
  refused: {
    title: "Numbers aren't open to you",
    detail: "The owner hasn't shared a number with you.",
  },
  offline: { title: "You're offline", detail: "Numbers come back when the connection does." },
  loadFailed: "Couldn't load numbers",
  pageFailed: "Couldn't load this number",
  back: "Back to Numbers",
  open: (name: string) => `Open ${name}`,
  gone: "This number isn't watched any more, or isn't open to you.",
  saveFailed: "Couldn't save that value.",
  formFailed: "Couldn't save the number.",
  form: {
    name: "Name",
    namePlaceholder: "For example: Daily users",
    unit: "Unit",
    unitPlaceholder: "users, %, INR, boxes",
    direction: "Which way is good",
    every: "Expected",
    source: "Where it comes from",
    sourcePlaceholder: "For example: the Daily sales mail",
    above: "Speak up when it goes above",
    below: "Speak up when it goes below",
    optional: "Optional",
  },
  directions: { either: "Either way", up: "Up is good", down: "Down is good" },
  everies: { none: "Whenever", day: "Every day", week: "Every week", month: "Every month" },
} as const;

export type KinNumberDirectionChoice = keyof typeof KIN_NUMBERS.directions;
export type KinNumberEveryChoice = keyof typeof KIN_NUMBERS.everies;

/** How this viewer's locale writes a number: its two separators and whether it groups lakh. */
export interface KinNumberLocale {
  readonly group: string;
  readonly decimal: string;
  readonly indian: boolean;
}

export const KIN_NUMBER_LOCALE_PLAIN: KinNumberLocale = { group: ",", decimal: ".", indian: false };

export function kinNumberLocale(locale?: string): KinNumberLocale {
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.5);
    const group = parts.find((part) => part.type === "group")?.value ?? ",";
    const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    const integers = parts.filter((part) => part.type === "integer").map((part) => part.value);
    return { group, decimal, indian: integers.length === 3 && integers[1]?.length === 2 };
  } catch {
    return KIN_NUMBER_LOCALE_PLAIN;
  }
}

const MINUS = "−";

const groupDigits = (digits: string, locale: KinNumberLocale) =>
  (locale.indian && digits.length > 3
    ? `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, "\u0000")}\u0000${digits.slice(-3)}`
    : digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u0000")
  ).replaceAll("\u0000", locale.group);

/** An exact decimal string ("-1234.50") in this locale's separators; never rounded. */
export function kinDecimalText(decimal: string, locale: KinNumberLocale): string {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction] = (negative ? decimal.slice(1) : decimal).split(".");
  return `${negative ? MINUS : ""}${groupDigits(whole, locale)}${fraction === undefined ? "" : `${locale.decimal}${fraction}`}`;
}

/** The ISO currency a unit names ("inr", "USD"), else null. */
export const kinNumberCurrency = (unit: string | undefined) => {
  const code = unit?.trim().toUpperCase();
  return code !== undefined && /^[A-Z]{3}$/.test(code) && isKinCurrency(code) ? code : null;
};

const minorOf = (decimal: string, decimals: number) => {
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const minor = BigInt(`${whole}${fraction.padEnd(decimals, "0").slice(0, decimals)}`);
  return negative ? -minor : minor;
};

/** A value with its unit: "4,210 users", "2.5%", "₹1,20,000"; money totals per currency. */
export function kinNumberValueText(
  value: KinNumber["value"],
  unit: string | undefined,
  locale: KinNumberLocale,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    if (value.length === 0) return formatKinZero(unit);
    return value
      .map(({ minor, currency }) =>
        formatKinMoney(minor, currency, { cents: "some", minus: MINUS }),
      )
      .join(" · ");
  }
  const currency = kinNumberCurrency(unit);
  if (currency !== null) {
    const decimals = kinCurrency(currency).decimals;
    const fraction = value.split(".")[1] ?? "";
    if (fraction.length <= decimals)
      return formatKinMoney(minorOf(value, decimals), currency, { cents: "some", minus: MINUS });
  }
  const text = kinDecimalText(value, locale);
  const shown = unit?.trim() ?? "";
  if (shown === "") return text;
  return shown === "%" ? `${text}%` : `${text} ${shown}`;
}

const formatKinZero = (unit: string | undefined) => {
  const currency = kinNumberCurrency(unit);
  return currency === null ? "0" : formatKinMoney(0, currency);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21 Nov", with the year when it isn't this one. */
export function kinNumberDay(day: string, today: string): string {
  const [year, month, date] = day.split("-");
  const short = `${Number(date)} ${MONTHS[Number(month) - 1] ?? ""}`;
  return year === today.slice(0, 4) ? short : `${short} ${year}`;
}

/** Today where the company is; this device's day until its zone is known. */
export function kinNumberToday(nowMs: number, zone: string | null): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (zone !== null) {
    try {
      const part = kinWhenParts(nowMs, zone);
      return `${part.year}-${pad(part.month)}-${pad(part.day)}`;
    } catch {
      // An unknown zone falls back to this device's day.
    }
  }
  const at = new Date(nowMs);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function kinShiftDay(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

export interface KinNumberRowView {
  readonly key: string;
  readonly name: string;
  /** Null when nothing is recorded: `KIN_NUMBERS.noValue` says so. */
  readonly value: string | null;
  /** "as of 20 Nov": shown when the value isn't today's, or the number is late. */
  readonly asOf: string | null;
  readonly off: boolean;
  readonly stale: boolean;
  /** The inline field: this viewer may type it and today has no value yet. */
  readonly typeToday: boolean;
  /** One line for a screen reader. */
  readonly label: string;
}

export function kinNumberRow(
  number: KinNumber,
  today: string,
  locale: KinNumberLocale,
): KinNumberRowView {
  const value = kinNumberValueText(number.value, number.unit, locale);
  const asOf =
    number.asOf !== null && (number.asOf !== today || number.stale)
      ? `as of ${kinNumberDay(number.asOf, today)}`
      : null;
  return {
    key: number.key,
    name: number.name,
    value,
    asOf,
    off: number.off,
    stale: number.stale,
    typeToday: number.canType && number.asOf !== today,
    label: [
      number.name,
      value ?? KIN_NUMBERS.noValue,
      asOf,
      number.off ? KIN_NUMBERS.off : null,
      number.stale ? KIN_NUMBERS.stale : null,
    ]
      .filter((part) => part !== null)
      .join(", "),
  };
}

/** The phone's row into Numbers: how many, and how many need a look. */
export function kinNumbersSummary(numbers: ReadonlyArray<KinNumber>): string {
  if (numbers.length === 0) return KIN_NUMBERS.add;
  const off = numbers.filter((number) => number.off).length;
  return [
    `${numbers.length} ${numbers.length === 1 ? "number" : "numbers"}`,
    off === 0 ? null : `${off} outside ${off === 1 ? "its limit" : "their limits"}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Whether Numbers is offered: the owner level always; anyone else while one is theirs to see. */
export const kinNumbersShown = (input: {
  readonly ownerLevel: boolean;
  readonly count: number | null;
}): boolean => input.ownerLevel || (input.count ?? 0) > 0;

export type KinDecimalRead =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly problem: string };

/**
 * What a person typed, as the exact decimal the host takes ("-1234.50"): this locale's separators,
 * a group separator only between whole groups, and no more decimals than the unit's currency has.
 */
export function kinNumberDecimal(
  text: string,
  unit: string | undefined,
  locale: KinNumberLocale,
): KinDecimalRead {
  const typed = text.trim().replaceAll(/[\s  ]/g, "");
  const example = `Type a number, like ${kinDecimalText("1234.5", locale)}.`;
  if (typed === "") return { ok: false, problem: "Type a value first." };
  const negative = /^[-−]/.test(typed);
  const body = negative ? typed.slice(1) : typed;
  const [whole = "", fraction, extra] = body.split(locale.decimal);
  if (extra !== undefined) return { ok: false, problem: example };
  const groups = whole.split(locale.group);
  const groupsOk =
    groups.length === 1
      ? /^\d*$/.test(whole)
      : /^\d{1,3}$/.test(groups[0] ?? "") &&
        groups.slice(1, -1).every((group) => /^\d{2,3}$/.test(group)) &&
        /^\d{3}$/.test(groups[groups.length - 1] ?? "");
  if (!groupsOk || (fraction !== undefined && !/^\d*$/.test(fraction)))
    return { ok: false, problem: example };
  const digits = groups.join("");
  if (digits === "" && (fraction ?? "") === "") return { ok: false, problem: example };
  const value = `${negative ? "-" : ""}${digits === "" ? "0" : digits}${fraction === undefined || fraction === "" ? "" : `.${fraction}`}`;
  if (value.length > 64) return { ok: false, problem: "That number is too long." };
  const currency = kinNumberCurrency(unit);
  const decimals = currency === null ? null : kinCurrency(currency).decimals;
  if (decimals !== null && (fraction?.length ?? 0) > decimals)
    return {
      ok: false,
      problem:
        decimals === 0
          ? `${currency} has no decimals.`
          : `${currency} has ${decimals} decimals at most.`,
    };
  return { ok: true, value };
}

export type KinNumberTone = "good" | "bad" | "plain";

/** The latest move against the day before it, coloured by which way is good. */
export function kinNumberChange(
  values: ReadonlyArray<{ readonly value: string; readonly asOf: string }>,
  number: Pick<KinNumber, "direction" | "unit">,
  today: string,
  locale: KinNumberLocale,
): { readonly text: string; readonly tone: KinNumberTone } | null {
  const days = kinNumberDays(values);
  const last = days[days.length - 1];
  const before = days[days.length - 2];
  if (last === undefined || before === undefined) return null;
  const delta = Number(last.value) - Number(before.value);
  if (!Number.isFinite(delta)) return null;
  const since = `since ${kinNumberDay(before.asOf, today)}`;
  if (delta === 0) return { text: `No change ${since}`, tone: "plain" };
  const places = Math.max(decimalsOf(last.value), decimalsOf(before.value));
  const size = kinNumberValueText(Math.abs(delta).toFixed(places), number.unit, locale);
  const rose = delta > 0;
  const tone =
    number.direction === undefined
      ? "plain"
      : rose === (number.direction === "up")
        ? "good"
        : "bad";
  return { text: `${rose ? "Up" : "Down"} ${size} ${since}`, tone };
}

const decimalsOf = (decimal: string) => decimal.split(".")[1]?.length ?? 0;

/** The value each day ended on, oldest first: history is ascending, a day's last is its latest. */
export function kinNumberDays<V extends { readonly asOf: string }>(
  values: ReadonlyArray<V>,
): ReadonlyArray<V> {
  const days = new Map<string, V>();
  for (const value of values) days.set(value.asOf, value);
  return [...days.values()].sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
}

/** "Kin speaks up above 4.5% or below 1%", or null with no limits. */
export function kinNumberLimitsText(
  number: Pick<KinNumber, "above" | "below" | "unit">,
  locale: KinNumberLocale,
): string | null {
  const parts = [
    number.above === undefined
      ? null
      : `above ${kinNumberValueText(number.above, number.unit, locale)}`,
    number.below === undefined
      ? null
      : `below ${kinNumberValueText(number.below, number.unit, locale)}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `Speaks up ${parts.join(" or ")}`;
}

export interface KinNumberHistoryRow {
  readonly id: string;
  readonly asOf: string;
  readonly day: string;
  readonly value: string;
  /** "Finance, from the Daily sales mail" or "Rhea". */
  readonly by: string;
  /** A later value for the same day replaced it; it stays to be seen. */
  readonly replaced: boolean;
}

/** Every recorded value, newest first, each saying who recorded it and from where. */
export function kinNumberHistory(
  values: ReadonlyArray<{
    readonly value: string;
    readonly asOf: string;
    readonly source?: string | undefined;
    readonly by: { readonly name: string };
  }>,
  unit: string | undefined,
  today: string,
  locale: KinNumberLocale,
): ReadonlyArray<KinNumberHistoryRow> {
  const seen = new Set<string>();
  return values
    .map((entry, index) => ({ entry, index }))
    .slice()
    .reverse()
    .map(({ entry, index }) => {
      const replaced = seen.has(entry.asOf);
      seen.add(entry.asOf);
      return {
        id: `${entry.asOf}:${index}`,
        asOf: entry.asOf,
        day: kinNumberDay(entry.asOf, today),
        value: kinNumberValueText(entry.value, unit, locale) ?? "",
        by: entry.source === undefined ? entry.by.name : `${entry.by.name}, from ${entry.source}`,
        replaced,
      };
    });
}

/** A static line of the value each day ended on; null with fewer than two days to join. */
export function kinNumberChart(
  number: Pick<KinNumber, "name" | "unit">,
  values: ReadonlyArray<{ readonly value: string; readonly asOf: string }>,
): KinChartSpec | null {
  const days = kinNumberDays(values);
  if (days.length < 2) return null;
  const currency = kinNumberCurrency(number.unit);
  const unit: KinChartUnit =
    currency !== null
      ? { kind: "money", currency }
      : number.unit?.trim() === "%"
        ? { kind: "percent" }
        : { kind: "count" };
  const scale = currency === null ? 1 : 10 ** kinCurrency(currency).decimals;
  return {
    chart: "line",
    title: KIN_NUMBERS.chartTitle,
    caption: null,
    unit,
    labelType: "day",
    labels: days.map((day) => day.asOf),
    series: [
      {
        name: number.name.trim().slice(0, 60) || KIN_NUMBERS.title,
        values: days.map((day) =>
          scale === 1 ? Number(day.value) : Math.round(Number(day.value) * scale),
        ),
      },
    ],
    comparison: null,
  };
}

/** How far back the page reads: a year of days. */
export const kinNumberWindow = (today: string) => ({ from: kinShiftDay(today, -365), to: today });

export interface KinNumberDraft {
  readonly name: string;
  readonly unit: string;
  readonly direction: KinNumberDirectionChoice;
  readonly every: KinNumberEveryChoice;
  readonly source: string;
  readonly above: string;
  readonly below: string;
  readonly shared: boolean;
}

export function kinNumberDraft(
  definition: KinNumberDefinition | null,
  locale: KinNumberLocale,
): KinNumberDraft {
  const typed = (decimal: string | undefined) =>
    decimal === undefined ? "" : kinDecimalText(decimal, { ...locale, group: "" });
  return {
    name: definition?.name ?? "",
    unit: definition?.unit ?? "",
    direction: definition?.direction ?? "either",
    every: definition?.every ?? "none",
    source: definition?.source ?? "",
    above: typed(definition?.above).replace(MINUS, "-"),
    below: typed(definition?.below).replace(MINUS, "-"),
    shared: definition?.shared ?? false,
  };
}

/**
 * The save the form sends, or what is wrong with it. An edit clears what was emptied; a new
 * number leaves out what is blank.
 */
export function kinNumberSave(
  draft: KinNumberDraft,
  definition: KinNumberDefinition | null,
  locale: KinNumberLocale,
):
  | { readonly ok: true; readonly input: Omit<KinNumberSaveInput, "orgId" | "clientRequestId"> }
  | { readonly ok: false; readonly problem: string } {
  const name = draft.name.trim();
  if (name === "") return { ok: false, problem: "Give the number a name." };
  const unit = draft.unit.trim();
  const limit = (text: string, which: string) => {
    if (text.trim() === "") return { ok: true as const, value: null };
    const read = kinNumberDecimal(text, unit, locale);
    return read.ok ? read : { ok: false as const, problem: `${which}: ${read.problem}` };
  };
  const above = limit(draft.above, "Above");
  if (!above.ok) return above;
  const below = limit(draft.below, "Below");
  if (!below.ok) return below;
  if (above.value !== null && below.value !== null && Number(below.value) > Number(above.value))
    return { ok: false, problem: "The lower limit is above the upper one." };
  const source = draft.source.trim().replaceAll(/[\r\n]+/g, " ");
  const editing = definition !== null;
  const unitValue = unit === "" ? null : unit.slice(0, 40);
  const direction = draft.direction === "either" ? null : draft.direction;
  const every = draft.every === "none" ? null : draft.every;
  const sourceValue = source === "" ? null : source.slice(0, 240);
  return {
    ok: true,
    input: {
      ...(definition === null ? {} : { key: definition.key, rev: definition.rev }),
      name: name.slice(0, 200),
      ...(unitValue !== null || editing ? { unit: unitValue } : {}),
      ...(direction !== null || editing ? { direction } : {}),
      ...(every !== null || editing ? { every } : {}),
      ...(sourceValue !== null || editing ? { source: sourceValue } : {}),
      ...(above.value !== null || editing ? { above: above.value } : {}),
      ...(below.value !== null || editing ? { below: below.value } : {}),
      ...(definition?.computed === true ? {} : { shared: draft.shared }),
    },
  };
}
