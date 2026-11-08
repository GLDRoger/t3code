import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export const TimeOfDay = ScheduledTaskUpsertSchedule.members[1].fields.timeOfDay;

// The result follows the runtime's ICU data (Node 25 resolves Asia/Kolkata to Asia/Calcutta).
export const canonicalTimeZone = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;

export const TimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter((timeZone) => {
    try {
      const resolved = canonicalTimeZone(timeZone);
      return !/^[+-]/.test(resolved) || "Expected an IANA time zone.";
    } catch {
      return "Expected an IANA time zone.";
    }
  }),
);
