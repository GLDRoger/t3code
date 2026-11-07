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
  const overdue = (item: IndexItem) =>
    dateOrder(item.review_by) < now || (item.status === "open" && dateOrder(item.due) < now);
  const section = (item: IndexItem) => {
    if (item.misleading) return 6;
    if (item.status === "open" && item.invalid_at === null) {
      if (item.on_due === "ask") return 0;
      const due = dateOrder(item.due);
      if (due >= now && due < dueThrough) return 1;
      if (item.kind === "objective") return 2;
      if (item.kind === "commitment") return 3;
    }
    if (overdue(item)) return 4;
    return 5;
  };
  const entries = items
    .filter(
      (item) =>
        now -
          (Object.hasOwn(readHistory, item.id)
            ? (readHistory[item.id] ?? memoryDateMillis(item.recorded_at))
            : memoryDateMillis(item.recorded_at)) <
        8 * week,
    )
    .map((item) => ({ item, section: section(item) }))
    .sort(
      (a, b) =>
        a.section - b.section ||
        dateOrder(a.item.due) - dateOrder(b.item.due) ||
        dateOrder(a.item.review_by) - dateOrder(b.item.review_by) ||
        compareText(a.item.id, b.item.id) ||
        compareText(a.item.path, b.item.path) ||
        compareText(a.item.title, b.item.title),
    );
  const lines = [`As of ${DateTime.formatIso(DateTime.makeUnsafe(now))}`];
  let previousSection = -1;
  for (const [index, { item, section: currentSection }] of entries.entries()) {
    const header = currentSection === previousSection ? [] : ["", `## ${sections[currentSection]}`];
    const reserved = index < entries.length - 1 ? 1 : 0;
    if (lines.length + header.length + 1 + reserved > 200) {
      lines.push(`${entries.length - index} more`);
      break;
    }
    lines.push(
      ...header,
      `- [${item.kind}] ${oneLine(item.title)} (${oneLine(item.path)})${item.invalid_at !== null ? " [invalid]" : ""}${(counts.get(item.id) ?? 0) > 1 ? " [duplicate id]" : ""}${overdue(item) ? " ⚠ review" : ""}${item.misleading ? " [misleading]" : ""}`,
    );
    previousSection = currentSection;
  }
  return lines.join("\n") + "\n";
}
