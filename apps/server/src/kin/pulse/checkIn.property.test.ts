import { it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { nextScheduledRunAt } from "../../scheduledTasks/Schedule.ts";
import {
  isAround,
  LOOSE_AFTER_MINUTES,
  LOOSE_BEFORE_MINUTES,
  looseSpanMinutes,
  type NativeTask,
} from "../triggers/kinSchedules.ts";
import { looseOffsetMs } from "./checkIn.ts";

const MINUTE = 60_000;
const task: NativeTask = {
  title: "Morning check-in",
  prompt: "Morning check-in.",
  enabled: 1,
  projectId: "project",
  threadId: null,
  threadMode: "new_thread",
  scheduleType: "fixed_time",
  timeOfDay: null,
  weekdays: null,
  nextRunAt: null,
};
const int = (min: number, max: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })));
const text = Arbitrary.schema(Schema.String);
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

it.prop(
  "a loose slot's minute is a whole minute inside its window, the same every time it is worked out",
  [text, text],
  ([scheduleId, slot]) => {
    const offset = looseOffsetMs(scheduleId, slot);
    return (
      offset % MINUTE === 0 &&
      offset >= 0 &&
      offset <= (LOOSE_BEFORE_MINUTES + LOOSE_AFTER_MINUTES) * MINUTE &&
      looseOffsetMs(scheduleId, slot) === offset
    );
  },
);

it.prop(
  "a check-in around a time comes at a minute from five before it to twenty after",
  [int(0, 24 * 60 - 1), text, text],
  ([minutes, scheduleId, slot]) => {
    const at = clock(minutes);
    // The native task's time Kin keeps for "around `at`" is the one it still reads as around.
    const start = Array.from({ length: 24 * 60 }, (_, m) => m).find((m) =>
      isAround({ ...task, timeOfDay: clock(m) }, at),
    );
    if (start === undefined) return false;
    const fires = start + looseOffsetMs(scheduleId, slot, looseSpanMinutes(at)) / MINUTE;
    return fires >= minutes - LOOSE_BEFORE_MINUTES && fires <= minutes + LOOSE_AFTER_MINUTES;
  },
);

const ZONES = [
  "Asia/Kolkata",
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "America/Santiago",
] as const;
const YEAR_START = Date.parse("2026-01-01T00:00:00Z");
const dayOf = (at: DateTime.Zoned) => {
  const { year, month, day } = DateTime.toParts(at);
  return Date.UTC(year, month - 1, day);
};

it.prop(
  "a daily slot fires once on each day in the host's zone, through clock changes",
  [Arbitrary.schema(Schema.Literals(ZONES)), int(0, 364 * 24 * 60), int(0, 24 * 60 - 1)],
  ([timeZone, startMinute, minutes]) => {
    const schedule = { type: "fixed_time", timeOfDay: clock(minutes) } as const;
    let from = DateTime.makeZonedUnsafe(YEAR_START + startMinute * MINUTE, { timeZone });
    let previous: number | undefined;
    for (let run = 0; run < 3; run += 1) {
      const next = nextScheduledRunAt(schedule, from);
      if (next === null || !DateTime.isZoned(next)) return false;
      const wait = DateTime.toEpochMillis(next) - DateTime.toEpochMillis(from);
      // Never now or earlier, and never a whole day past one it should have taken.
      if (wait <= 0 || wait > 25 * 60 * MINUTE) return false;
      const day = dayOf(next);
      if (previous !== undefined && day !== previous + 86_400_000) return false;
      previous = day;
      from = next;
    }
    return true;
  },
);
