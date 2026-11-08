import type { MemoryItemHead } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { memoryDateMillis } from "./frontMatter.ts";

const week = 7 * 24 * 60 * 60 * 1000;
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, " ");
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dateOrder = (value: string | null) => {
  const ms = memoryDateMillis(value);
  return Number.isFinite(ms) ? ms : Infinity;
};

type IndexItem = MemoryItemHead & { readonly misleading?: boolean };

export function buildIndex(
  items: ReadonlyArray<IndexItem>,
  readHistory: Readonly<Record<string, number>>,
  now: number,
  ownerTimeZone: string,
): string {
  const today = DateTime.startOf(DateTime.makeZonedUnsafe(now, { timeZone: ownerTimeZone }), "day");
  const dueThrough = DateTime.toEpochMillis(DateTime.add(today, { days: 8 }));
  const sections = [
    "Waiting on owner",
    "Due in 7 days",
    "Open objectives",
    "Open commitments",
    "Overdue",
    "Other memory",
    "Misleading",
  ];
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const section = (item: IndexItem, due: number, overdue: boolean) => {
    if (item.misleading) return 6;
    if (item.status === "open" && item.invalid_at === null) {
      if (item.on_due === "ask" && due <= now) return 0;
      if (due >= now && due < dueThrough) return 1;
      if (item.kind === "objective") return 2;
      if (item.kind === "commitment") return 3;
    }
    if (overdue) return 4;
    return 5;
  };
  const entries = items
    .map((item) => ({
      item,
      due: dateOrder(item.due),
      reviewBy: dateOrder(item.review_by),
      recordedAt: memoryDateMillis(item.recorded_at),
    }))
    .filter(
      ({ item, recordedAt }) =>
        now -
          (Object.hasOwn(readHistory, item.id)
            ? (readHistory[item.id] ?? recordedAt)
            : recordedAt) <
        8 * week,
    )
    .map(({ item, due, reviewBy }) => {
      const overdue = reviewBy < now || (item.status === "open" && due < now);
      return { item, due, reviewBy, overdue, section: section(item, due, overdue) };
    })
    .sort(
      (a, b) =>
        a.section - b.section ||
        a.due - b.due ||
        a.reviewBy - b.reviewBy ||
        compareText(a.item.id, b.item.id) ||
        compareText(a.item.path, b.item.path) ||
        compareText(a.item.title, b.item.title),
    );
  const lines = [`As of ${DateTime.formatIso(DateTime.makeUnsafe(now))}`];
  let previousSection = -1;
  for (const [index, { item, overdue, section: currentSection }] of entries.entries()) {
    const header = currentSection === previousSection ? [] : ["", `## ${sections[currentSection]}`];
    const reserved = index < entries.length - 1 ? 1 : 0;
    if (lines.length + header.length + 1 + reserved > 200) {
      lines.push(`${entries.length - index} more items not listed; use memory_search`);
      break;
    }
    lines.push(
      ...header,
      `- [${item.kind}] ${oneLine(item.title)} (${oneLine(item.path)})${item.invalid_at !== null ? " [invalid]" : ""}${(counts.get(item.id) ?? 0) > 1 ? " [duplicate id]" : ""}${overdue ? " ⚠ review" : ""}${item.misleading ? " [misleading]" : ""}`,
    );
    previousSection = currentSection;
  }
  return lines.join("\n") + "\n";
}
