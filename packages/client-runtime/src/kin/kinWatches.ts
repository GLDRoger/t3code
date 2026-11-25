import {
  formatKinWhen,
  kinWhenParts,
  KIN_WATCH_AGAIN_DAYS,
  type EnvironmentId,
  type KinWatchActor,
  type KinWatchDid,
  type KinWatchesFollowUpsInput,
  type KinWatchesListInput,
  type KinWatchesLogInput,
  type KinWatchLine,
  type KinWatchLogRow,
  type KinWatchWhy,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinQueryAtomFamily, createKinRpcCommand } from "./kinAccess.ts";
import type { kinGuardedRead } from "./kinClient.ts";
import { createKinRefreshTriggers } from "./kinRefresh.ts";

/** Where a watch's times are read: the reader's zone and locale; the device's own when left out. */
export interface KinWatchWords {
  readonly zone?: string | undefined;
  readonly locale?: string | undefined;
}

const DAY_MS = 86_400_000;
const zoneOf = (words: KinWatchWords) =>
  words.zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
const ms = (iso: string) => Date.parse(iso);

/** "14:10" today, "Mon 14:10" on any other day, in the reader's zone. */
function kinWatchTime(at: number, now: number, words: KinWatchWords = {}): string {
  const zone = zoneOf(words);
  const time = formatKinWhen(at, "time", { zone, locale: words.locale });
  if (kinWhenParts(at, zone).isoDay === kinWhenParts(now, zone).isoDay) return time;
  return `${formatKinWhen(at, "weekdayShort", { zone, locale: words.locale })} ${time}`;
}

/** What Kin is doing, after "Kin is", by kind: "watching for the payment". */
export function kinWatchAbout(watch: Pick<KinWatchLine, "kind" | "about">): string {
  switch (watch.kind) {
    case "invoice_paid":
      return "watching for the payment";
    case "reply_owed":
      return `watching for ${watch.about}'s reply`;
    case "task_out":
      return "watching this work";
    case "pr":
      return "watching for the merge";
    case "turn_failed":
      return "watching for the work to run again";
    case "prepare":
      return `getting ready for ${watch.about}`;
    case "asked":
      return `watching: ${watch.about.slice(0, 120)}`;
    default:
      return "watching this";
  }
}

const stoppedBy = (by: KinWatchActor | null) =>
  by === null || by.you ? "You" : (by.name ?? (by.kind === "code" ? "Kin" : "Someone"));

/** The buttons a watch line offers, in order. */
export type KinWatchAction = "look" | "stop" | "again";

export interface KinWatchLineView {
  readonly text: string;
  readonly actions: ReadonlyArray<KinWatchAction>;
}

/**
 * The one grey line on a record Kin watches, as the design words it, or null once a closed or
 * stopped watch is past its days for Watch again.
 */
export function kinWatchLine(
  watch: KinWatchLine,
  now: number,
  words: KinWatchWords = {},
): KinWatchLineView | null {
  const time = (iso: string) => kinWatchTime(ms(iso), now, words);
  if (watch.state !== "open") {
    if (watch.closedAt === null || now - ms(watch.closedAt) > KIN_WATCH_AGAIN_DAYS * DAY_MS)
      return null;
    const text =
      watch.state === "closed"
        ? `Kin stopped watching: ${watch.closedHow ?? "it no longer applies"}`
        : `${stoppedBy(watch.closedBy)} stopped Kin watching this`;
    return { text, actions: ["again"] };
  }
  if (watch.looking) return { text: "Kin is looking now", actions: ["stop"] };
  if (watch.aside !== null)
    return {
      text:
        watch.aside.until === null
          ? "Kin will look again after the hold is lifted"
          : `Kin will look again after the hold ends on ${formatKinWhen(ms(watch.aside.until), "date", { zone: zoneOf(words), locale: words.locale })}`,
      actions: ["stop"],
    };
  const about = `Kin is ${kinWatchAbout(watch)}`;
  const next = watch.nextLookAt === null ? "" : ` · next look about ${time(watch.nextLookAt)}`;
  const actions: ReadonlyArray<KinWatchAction> = ["look", "stop"];
  switch (watch.lastOutcome) {
    case "skipped_limit":
      return { text: `${about} · next look after today's daily limit resets`, actions };
    case "cant_tell":
      return {
        text: `${about} · can't check yet: ${watch.lastLine ?? "nothing to read"}`,
        actions,
      };
    case "changed":
    case "problem":
      return {
        text:
          watch.lookedAt === null
            ? `${about}${next}`
            : `${about} · ${time(watch.lookedAt)}: ${watch.lastLine ?? "something changed"}${next}`,
        actions,
      };
    default:
      return {
        text:
          watch.lookedAt === null
            ? `${about}${next}`
            : `${about} · looked ${time(watch.lookedAt)}, nothing new${next}`,
        actions,
      };
  }
}

export const KIN_WATCH_LOG_TITLE = "What Kin checked";
export const KIN_WATCH_LOG_INTRO = "Kin looks at open loops every 45 minutes, day and night.";

/** The line's buttons, the log's paging, and what a failed tap or read says. */
export const KIN_WATCH_COPY = {
  look: "Look now",
  stop: "Stop watching",
  again: "Watch again",
  failed: {
    look: "Couldn't ask Kin to look.",
    stop: "Couldn't stop watching.",
    again: "Couldn't start watching again.",
  },
  earlier: "Earlier",
  unreadable: "Couldn't load what Kin checked.",
} as const;

/** Whether a log row was a look that waited on the Daily limit, and from when. */
export function kinWatchLimitFrom(rows: ReadonlyArray<KinWatchLogRow>): number | null {
  let from: number | null = null;
  for (const row of rows)
    if (row._tag === "look" && row.look.outcome === "skipped_limit") {
      const at = ms(row.look.at);
      if (from === null || at < from) from = at;
    }
  return from;
}

const KIN_WATCH_WHY_LABELS: Readonly<Record<KinWatchWhy, string>> = {
  asked: "You asked",
  again: "Worth another look",
  routine: "Routine round",
};

const KIN_WATCH_DID_LABELS: Readonly<Record<KinWatchDid, string>> = {
  problem: "Spotted a problem",
  closed: "Closed a loop",
  checked_work: "Checked work",
  prepared: "Prepared for a decision",
  nothing_new: "Nothing new",
};

/** A day of the log as its heading reads: "Today", "Yesterday", "Fri 20 Nov". `day` is `2026-11-20`. */
export function kinWatchLogDay(day: string, now: number, words: KinWatchWords = {}): string {
  const zone = zoneOf(words);
  const today = kinWhenParts(now, zone).isoDay;
  if (day === today) return "Today";
  if (day === kinWhenParts(now - DAY_MS, zone).isoDay) return "Yesterday";
  // Noon UTC on that day falls on it in every zone within 12 hours of UTC; the label is the day's own.
  return formatKinWhen(Date.parse(`${day}T12:00:00Z`), "day", {
    zone: "UTC",
    locale: words.locale,
  });
}

/**
 * Each row of one day of the log, newest first, as it reads: a look is "time · why it ran · what it
 * did · what it was about: what it found" (a "Nothing new" look stops at what it was about); a fold of
 * nothing-new looks is "time · 9 more looks, nothing new" ("9 looks" on a day with nothing else).
 */
export function kinWatchLogRows(
  rows: ReadonlyArray<KinWatchLogRow>,
  words: KinWatchWords = {},
): ReadonlyArray<string> {
  const zone = zoneOf(words);
  const time = (iso: string) => formatKinWhen(ms(iso), "time", { zone, locale: words.locale });
  const more = rows.some((row) => row._tag === "look") ? " more" : "";
  return rows.map((row) =>
    row._tag === "look"
      ? `${time(row.look.at)} · ${KIN_WATCH_WHY_LABELS[row.look.why]} · ${KIN_WATCH_DID_LABELS[row.look.did]} · ${row.look.about}${row.look.did === "nothing_new" ? "" : `: ${row.look.line}`}`
      : `${time(row.folded.at)} · ${row.folded.count}${more} looks, nothing new`,
  );
}

/** The log's line where the Daily limit stopped the checks that need a model. */
export function kinWatchLimitLine(at: number, words: KinWatchWords = {}): string {
  const time = formatKinWhen(at, "time", { zone: zoneOf(words), locale: words.locale });
  return `From ${time} Kin only did the checks that need no model: today's daily limit was reached.`;
}

/** The log with no watches at all: the owner level is told how to start one. */
export function kinWatchNoneText(ownerLevel: boolean): string {
  return ownerLevel
    ? 'Kin isn\'t watching anything yet. Ask any agent to keep an eye on something, such as "keep an eye on whether Lumen pays".'
    : "Kin isn't watching anything of yours.";
}

/** Today's page of the log before any look. */
export function kinWatchNothingToday(nextLookAt: string | null, words: KinWatchWords = {}): string {
  if (nextLookAt === null) return "No checks yet today.";
  const time = formatKinWhen(ms(nextLookAt), "time", { zone: zoneOf(words), locale: words.locale });
  return `No checks yet today. The next round is about ${time}.`;
}

/** The watch list, the log and the three buttons, on one app's runtime. */
export function makeKinWatches<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  guardedRead: typeof kinGuardedRead,
) {
  const refreshOn = createKinRefreshTriggers(runtime);
  const readList = guardedRead(
    createKinRpcCommand(runtime, { label: "kin:watches:read", tag: "kin.watches.list" }),
  );
  const readFollowUps = guardedRead(
    createKinRpcCommand(runtime, {
      label: "kin:watches:follow-ups:read",
      tag: "kin.watches.followUps",
    }),
  );
  const readLog = guardedRead(
    createKinRpcCommand(runtime, { label: "kin:watches:log:read", tag: "kin.watches.log" }),
  );
  return {
    /** Every watch the reader may see, or one record's. */
    watches: createKinQueryAtomFamily(runtime, {
      label: "kin:watches",
      execute: Effect.fn("KinClient.watches")(function* (input: KinWatchesListInput) {
        return yield* readList(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinWatchesListInput;
      }) => refreshOn("watches")(target),
    }),
    followUps: createKinQueryAtomFamily(runtime, {
      label: "kin:watches:follow-ups",
      execute: readFollowUps,
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinWatchesFollowUpsInput;
      }) => refreshOn("watches")(target),
    }),
    /** One day of What Kin checked. */
    watchLog: createKinQueryAtomFamily(runtime, {
      label: "kin:watches:log",
      execute: Effect.fn("KinClient.watchLog")(function* (input: KinWatchesLogInput) {
        return yield* readLog(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinWatchesLogInput;
      }) => refreshOn("watches")(target),
    }),
    /** Look now: a second tap before the look runs queues nothing more. */
    watchLook: createKinRpcCommand(runtime, {
      label: "kin:watch:look",
      tag: "kin.watches.look",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.watchId },
    }),
    watchStop: createKinRpcCommand(runtime, {
      label: "kin:watch:stop",
      tag: "kin.watches.stop",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.watchId },
    }),
    watchAgain: createKinRpcCommand(runtime, {
      label: "kin:watch:again",
      tag: "kin.watches.again",
      concurrency: { mode: "singleFlight", key: ({ input }) => input.watchId },
    }),
  };
}
