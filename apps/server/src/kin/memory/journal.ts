import { formatKinWhen, KIN_TEXT_LOCALE, kinWhenParts } from "@t3tools/contracts";
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
  const at = Date.parse(ctx.startedAt);
  if (Number.isNaN(at)) throw new RangeError("Invalid journal date");
  const [year, month, day] = kinWhenParts(at, ctx.timeZone).isoDay.split("-");
  return {
    path: `journal/${year}/${month}-${day}.md`,
    text: `\n## ${formatKinWhen(at, "time", { zone: ctx.timeZone, locale: KIN_TEXT_LOCALE })} · wake-up ${oneLine(ctx.wakeupId)} · ${oneLine(ctx.agentId)} · ${ctx.level}\n\nOutcome: ${outcome}\nEvents: ${ctx.eventIds.map(oneLine).join(", ")}\n\n${lines.map((line) => `- ${oneLine(line)}\n`).join("")}`,
  };
};

export const journalEntry = Effect.fn("Memory.journalEntry")(
  (ctx: JournalContext, outcome: "completed" | "failed", lines: ReadonlyArray<string>) =>
    Effect.try({
      try: () => renderJournalEntry(ctx, outcome, lines),
      catch: () => new MemoryJournalError({ reason: "Invalid journal date or time zone" }),
    }),
);
