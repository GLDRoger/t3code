import { formatKinWhen, isKinCurrency, KIN_TEXT_LOCALE, kinWhenParts } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { DAY_MS, HOUR_MS } from "../durations.ts";
import { hoursEndAfter, hoursStartAfter } from "../triggers/quietHours.ts";

/**
 * A person's working day, as their profile's hours give it: `start` after `end` is a shift that
 * ends the next morning. Without hours a question's day ends at 19:30 and a raise comes at 10:30,
 * on their clock, Monday to Friday.
 */
export type Workday = {
  readonly days: ReadonlyArray<number>;
  readonly start: string;
  readonly end: string;
};
const WEEKDAYS: ReadonlyArray<number> = [1, 2, 3, 4, 5];
/** Their own hours, on their own days else Monday to Friday; hours of no minutes keep the defaults. */
const shift = (work: Workday | undefined): Workday => {
  const days = work === undefined || work.days.length === 0 ? WEEKDAYS : work.days;
  return work !== undefined && work.start !== work.end
    ? { days, start: work.start, end: work.end }
    : { days, start: "10:30", end: "19:30" };
};
/** A day the asker names is at least this far off, and at most a month. */
const SOONEST_MS = HOUR_MS;
const LATEST_MS = 31 * DAY_MS;

const wallTime = (
  day: { readonly year: number; readonly month: number; readonly day: number },
  time: string,
  zone: string,
) => {
  const [hour, minute] = time.split(":").map(Number);
  return DateTime.toEpochMillis(
    DateTime.makeZonedUnsafe(
      { year: day.year, month: day.month, day: day.day, hour: hour ?? 0, minute: minute ?? 0 },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  );
};

/**
 * The day a question is answered by when the asker names none: the end of the next stretch of
 * their hours after today's end, on their clock.
 */
export const defaultDue = (now: number, zone: string, work?: Workday) => {
  const hours = shift(work);
  const endOfToday = Math.max(now, wallTime(kinWhenParts(now, zone), hours.end, zone));
  return hoursEndAfter(hours, zone, endOfToday) ?? endOfToday + DAY_MS;
};

/**
 * A `YYYY-MM-DD` the asker named, as the end of that day's stretch on the person's clock (the next
 * morning for a shift past midnight); why not, when it can't be.
 */
export const namedDue = (
  by: string,
  now: number,
  zone: string,
  work?: Workday,
): { readonly at: number } | { readonly refused: string } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(by.trim());
  const hours = shift(work);
  const named =
    match === null
      ? undefined
      : DateTime.toParts(
          DateTime.add(
            DateTime.makeZonedUnsafe(
              { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 12 },
              { timeZone: zone, adjustForTimeZone: true },
            ),
            { days: hours.start > hours.end ? 1 : 0 },
          ),
        );
  const at = named === undefined ? Number.NaN : wallTime(named, hours.end, zone);
  if (!Number.isFinite(at) || at < now + SOONEST_MS || at > now + LATEST_MS)
    return {
      refused:
        "by is the day you'll take your default, YYYY-MM-DD, from today to a month out; leave it out for the end of their next working day.",
    };
  return { at };
};

/** When a question with no safe default is raised once more: the next start of their hours after its day. */
export const raiseAt = (due: number, zone: string, work?: Workday) =>
  hoursStartAfter(shift(work), zone, due) ?? due + DAY_MS;

const STOP = new Set(
  "a an the to for of on in at by with and or should shall i we you me my our us it its them they this that these those please can could will would do does did be is are was were if about any some let".split(
    " ",
  ),
);
const stem = (word: string) =>
  word.length > 5 && word.endsWith("ing")
    ? word.slice(0, -3)
    : word.length > 4 && word.endsWith("ed")
      ? word.slice(0, -2)
      : word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word;

/** An asker's intent in a stable form: "Draft the payment reminders" and "draft payment reminder" match. */
export const normaliseIntent = (intent: string | undefined) =>
  [
    ...new Set(
      (intent ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((word) => word !== "" && !STOP.has(word))
        .map(stem),
    ),
  ]
    .toSorted()
    .slice(0, 12)
    .join(" ");

/** A pull request as Kin's GitHub events and `kin_github_link` name it, in one spelling. */
export const pullRequestAbout = (repo: string, number: number) =>
  `https://github.com/${repo.toLowerCase()}/pull/${number}`;
const PULL_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,8})\/?$/i;

/**
 * What a question is about: records by their keys (INV-8, C-2) and pull requests by their URL;
 * anything else is dropped.
 */
export const normaliseAbout = (about: ReadonlyArray<string> | undefined) =>
  [
    ...new Set(
      (about ?? []).flatMap((said) => {
        const pull = PULL_URL.exec(said.trim());
        if (pull !== null) return [pullRequestAbout(pull[1]!, Number(pull[2]))];
        const key = said.trim().toUpperCase();
        return /^[A-Z]{1,6}-\d{1,6}$/.test(key) ? [key] : [];
      }),
    ),
  ]
    .toSorted()
    .slice(0, 8);

/**
 * Whether a new ask repeats an open one: the same person, the same intent and at least one record
 * in common. Without an intent or records on both, Kin can't tell, so it lets the ask through.
 */
export const repeats = (
  asked: { readonly intent: string; readonly about: ReadonlyArray<string> },
  open: { readonly intent: string; readonly about: ReadonlyArray<string> },
) =>
  asked.intent !== "" &&
  asked.intent === open.intent &&
  asked.about.length > 0 &&
  asked.about.some((key) => open.about.includes(key));

/**
 * Words for doing something that leaves the company or moves money: such a default is never taken.
 * A word joined to another by a hyphen names a field or a thing ("Paid-by", "send-later"), not an act.
 */
const LEAVES =
  /(?<![\w-])(send|sends|sending|sent|post|posts|posting|publish|publishing|tweet|pay|pays|paying|paid|transfer|refund|wire|charge|submit|reply to (the )?client)(?![\w-])/i;

/** A number with a percent sign or a currency symbol beside it, in any script. */
const RATE_OR_SYMBOL = /\p{Nd}\s*[%\u066a\uff05\p{Sc}]|[%\u066a\uff05\p{Sc}]\s*\p{Nd}/u;
const CODE_BESIDE_NUMBER = /\b([A-Z]{3})\s*\p{Nd}|\p{Nd}\s*([A-Z]{3})\b/gu;
/** Whether `text` names an amount or a rate: "40% advance", "₹40,000", "USD 1,200", "1.500 €". */
const moneyTerm = (text: string) =>
  RATE_OR_SYMBOL.test(text) ||
  [...text.matchAll(CODE_BESIDE_NUMBER)].some((found) => isKinCurrency(found[1] ?? found[2] ?? ""));

/**
 * Why Kin may not take `label` on its own at the day, or undefined when it may: never when the
 * asker said "none", when the question is about a money record, when any option names an amount
 * or a rate, or when the default, or a bare yes's question, reads as sending something out or
 * moving money.
 */
export const unsafeDefault = (
  label: string | null,
  question: string,
  terms: { readonly labels?: ReadonlyArray<string>; readonly aboutMoney?: boolean } = {},
): "none" | "money" | "leaves" | undefined => {
  if (label === null) return "none";
  if (terms.aboutMoney === true) return "money";
  const bare = label.trim().split(/\s+/).length <= 3;
  if ([label, ...(terms.labels ?? []), ...(bare ? [question] : [])].some(moneyTerm)) return "money";
  return LEAVES.test(label) || (bare && LEAVES.test(question)) ? "leaves" : undefined;
};
export const safeDefault = (...args: Parameters<typeof unsafeDefault>) =>
  unsafeDefault(...args) === undefined;

/** "today", "tomorrow", "on Wednesday", "on Wed 3 Dec", "yesterday", "on Monday" (past), on `zone`'s clock. */
export const dayWord = (at: number, now: number, zone: string) => {
  const day = (ms: number) =>
    DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone }));
  const diff = Math.round((Date.parse(day(at)) - Date.parse(day(now))) / DAY_MS);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  const format = (style: "weekday" | "day") =>
    formatKinWhen(at, style, { zone, locale: KIN_TEXT_LOCALE }).replace(/,/g, "");
  return Math.abs(diff) <= 6 ? `on ${format("weekday")}` : `on ${format("day")}`;
};

/**
 * The question a reply ends on, when its last line ends with a question mark: that sentence.
 * Best effort: a question in the middle of a reply, or "let me know if…", isn't caught.
 */
export const endingQuestion = (body: string) => {
  const last = body
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "");
  if (last === undefined) return undefined;
  const bare = last.replace(/[\s"'”’)*_]+$/u, "");
  if (!bare.endsWith("?")) return undefined;
  const sentence =
    bare
      .split(/(?<=[.!?])\s+/)
      .at(-1)
      ?.trim() ?? bare;
  return sentence.length < 6 ? undefined : sentence;
};
