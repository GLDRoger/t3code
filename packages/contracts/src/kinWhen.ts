/**
 * Kin's one way to write a day and a time, in the reader's zone. The locale picks the clock (CLDR:
 * 24-hour en-GB, 12-hour en-US and en-IN). Clients use the device's locale; the server writes a
 * company's people's text in its region's (`textLocale`, server work/companyProfile.ts).
 */

/** The locale of agent-facing text, and of people's text for a company whose region Kin has no row for. */
export const KIN_TEXT_LOCALE = "en-GB";

const STYLES = {
  /** "03:05" or "3:05 AM", by the locale's clock. */
  time: {},
  /** "Tue 17 Nov". */
  day: { weekday: "short", day: "numeric", month: "short" },
  /** "Tue 17 Nov 2026". */
  dayYear: { weekday: "short", day: "numeric", month: "short", year: "numeric" },
  /** "17 Nov". */
  date: { day: "numeric", month: "short" },
  /** "17 Nov 2026". */
  dateYear: { day: "numeric", month: "short", year: "numeric" },
  /** "Tuesday". */
  weekday: { weekday: "long" },
  /** "Tue". */
  weekdayShort: { weekday: "short" },
  /** "Tuesday 17 November". */
  longDay: { weekday: "long", day: "numeric", month: "long" },
  /** "Tue 17 Nov, 03:05". */
  dayTime: { weekday: "short", day: "numeric", month: "short", withTime: true },
  /** "17 Nov, 03:05". */
  dateTime: { day: "numeric", month: "short", withTime: true },
  /** "2026". */
  year: { year: "numeric" },
} as const;
export type KinWhenStyle = keyof typeof STYLES;

export interface KinWhenOptions {
  /** The IANA zone the reader is in; the runtime's own when left out, as on a device. */
  readonly zone?: string | undefined;
  /** Left out on a client: the device's own. */
  readonly locale?: string | undefined;
}

const held = new Map<string, Intl.DateTimeFormat>();
/** The locale's own clock: two-digit 24-hour times where it keeps one, else 12-hour. */
const clockOf = (locale: string | undefined) => {
  const cycle = new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle;
  return cycle === "h23" || cycle === "h24"
    ? ({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const)
    : ({ hour: "numeric", minute: "2-digit", hourCycle: "h12" } as const);
};

/** The formatter for `style`, kept per zone and locale; `.format` and `.formatToParts` as Intl's. */
export const kinWhenFormat = (
  style: KinWhenStyle,
  options: KinWhenOptions = {},
): Intl.DateTimeFormat => {
  const key = `${style}|${options.zone ?? ""}|${options.locale ?? ""}`;
  const found = held.get(key);
  if (found !== undefined) return found;
  const { withTime, ...fields }: { withTime?: boolean } & Intl.DateTimeFormatOptions = {
    ...STYLES[style],
  };
  const made = new Intl.DateTimeFormat(options.locale, {
    ...fields,
    ...(style === "time" || withTime === true ? clockOf(options.locale) : {}),
    ...(options.zone === undefined ? {} : { timeZone: options.zone }),
  });
  held.set(key, made);
  return made;
};

/** An instant written in `style`: `formatKinWhen(at, "time", { zone, locale: KIN_TEXT_LOCALE })`. */
export const formatKinWhen = (
  at: number | Date,
  style: KinWhenStyle,
  options: KinWhenOptions = {},
) => kinWhenFormat(style, options).format(at);

const PARTS = new Map<string, Intl.DateTimeFormat>();
/** An instant's calendar fields in `zone`, as numbers, for working out days and hours. */
export const kinWhenParts = (at: number | Date, zone: string) => {
  let format = PARTS.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    PARTS.set(zone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const number = (type: string) => Number.parseInt(parts[type] ?? "0", 10);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour") % 24,
    minute: number("minute"),
    second: number("second"),
    /** "Mon" to "Sun". */
    weekday: parts.weekday ?? "",
    /** `2026-11-17`. */
    isoDay: `${parts.year}-${parts.month}-${parts.day}`,
  };
};

const HOUR_MS = 3_600_000;
/**
 * How long something has been late or quiet, from `from` to `to`, read after a verb: "for 5 hours"
 * under 48 hours, "for 12 days" under 60 days, else "since 1 Jan 1999" in the reader's zone.
 */
export const formatKinLate = (from: number, to: number, options: KinWhenOptions = {}) => {
  const hours = Math.floor((to - from) / HOUR_MS);
  if (hours < 1) return "for under an hour";
  if (hours < 48) return hours === 1 ? "for 1 hour" : `for ${hours} hours`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `for ${days} days`;
  return `since ${formatKinWhen(from, "dateYear", options)}`;
};
