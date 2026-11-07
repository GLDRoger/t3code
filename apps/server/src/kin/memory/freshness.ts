import type { MemoryItemFrontMatter } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const day = 24 * 60 * 60 * 1000;

export function defaultReviewBy(
  item: Pick<MemoryItemFrontMatter, "kind" | "due">,
  now: number,
  nextMilestone: string | null = null,
): string | null {
  switch (item.kind) {
    case "person":
      return DateTime.formatIso(DateTime.makeUnsafe(now + 90 * day));
    case "claim":
      return DateTime.formatIso(DateTime.makeUnsafe(now + 30 * day));
    case "objective":
      return nextMilestone ?? item.due;
    case "commitment":
    case "deferral":
      return item.due;
    case "decision":
      return null;
  }
}
