import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

export const TimeOfDay = ScheduledTaskUpsertSchedule.members[1].fields.timeOfDay;

export const TimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter((timeZone) => {
    try {
      const resolved = new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
      return !/^[+-]/.test(resolved) || "Expected an IANA time zone.";
    } catch {
      return "Expected an IANA time zone.";
    }
  }),
);
