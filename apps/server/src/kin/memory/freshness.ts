import type { MemoryItemFrontMatter } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const day = 24 * 60 * 60 * 1000;

export function defaultReviewBy(
  item: Pick<MemoryItemFrontMatter, "kind" | "due"> &
    Partial<Pick<MemoryItemFrontMatter, "review_by">>,
  recordedAt: number,
  nextMilestone: string | null = null,
): string | null {
  if (item.review_by !== undefined) return item.review_by;
  switch (item.kind) {
    case "person":
      return DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 90 * day));
    case "claim":
      return DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 30 * day));
    case "objective":
      return (
        nextMilestone ?? item.due ?? DateTime.formatIso(DateTime.makeUnsafe(recordedAt + 30 * day))
      );
    case "commitment":
    case "deferral":
      return item.due;
    case "decision":
      return null;
  }
}
