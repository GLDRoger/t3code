import type { MemoryItemFrontMatter } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { DAY_MS } from "../durations.ts";

export function defaultReviewBy(
  item: Pick<MemoryItemFrontMatter, "kind" | "due"> &
    Partial<Pick<MemoryItemFrontMatter, "review_by">>,
  recordedAt: number,
  nextMilestone: string | null = null,
): string | null {
  if (item.review_by !== undefined) return item.review_by;
  switch (item.kind) {
    case "person":
    case "relationship":
      return DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 90 * DAY_MS));
    case "claim":
      return DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 30 * DAY_MS));
    case "objective":
      return (
        nextMilestone ??
        item.due ??
        DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 30 * DAY_MS))
      );
    case "commitment":
    case "deferral":
      return item.due;
    case "decision":
      return null;
  }
}
