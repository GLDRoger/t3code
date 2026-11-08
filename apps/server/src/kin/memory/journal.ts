import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MemoryJournalError extends Schema.TaggedError<MemoryJournalError>()(
  "MemoryJournalError",
  { reason: Schema.String },
) {}

export interface JournalContext {
  readonly wakeupId: string;
  readonly agentId: string;
  readonly level: string;
  readonly startedAt: string;
  readonly timeZone: string;
  readonly eventIds: ReadonlyArray<string>;
}
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, " ");
const renderJournalEntry = (
  ctx: JournalContext,
  outcome: "completed" | "failed",
  lines: ReadonlyArray<string>,
) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ctx.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(Date.parse(ctx.startedAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return {
    path: `journal/${part("year")}/${part("month")}-${part("day")}.md`,
    text: `\n## ${part("hour")}:${part("minute")} · wake-up ${oneLine(ctx.wakeupId)} · ${oneLine(ctx.agentId)} · ${ctx.level}\n\nOutcome: ${outcome}\nEvents: ${ctx.eventIds.map(oneLine).join(", ")}\n\n${lines.map((line) => `- ${oneLine(line)}\n`).join("")}`,
  };
};

export const journalEntry = Effect.fn("Memory.journalEntry")(
  (ctx: JournalContext, outcome: "completed" | "failed", lines: ReadonlyArray<string>) =>
    Effect.try({
      try: () => renderJournalEntry(ctx, outcome, lines),
      catch: () => new MemoryJournalError({ reason: "Invalid journal date or time zone" }),
    }),
);
