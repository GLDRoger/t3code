import type { MemoryItemHead } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { memoryDateMillis } from "./frontMatter.ts";
import type { SharedItem } from "./sensitivity.ts";

const week = 7 * 24 * 60 * 60 * 1000;
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, " ");
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dateOrder = (value: string | null) => {
  const ms = memoryDateMillis(value);
  return Number.isFinite(ms) ? ms : Infinity;
};

type IndexItem = MemoryItemHead & { readonly misleading?: boolean };

/** Needs a rebuild: no zoned "As of" first line, one in the future, or one 36 h old. */
export function indexIsStale(index: string, now: number): boolean {
  const asOf = /^As of ([^\r\n]+)(?:\r?\n|$)/.exec(index)?.[1];
  if (asOf === undefined || !/(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)) return true;
  const at = memoryDateMillis(asOf);
  return !Number.isFinite(at) || at > now || now - at >= 36 * 60 * 60 * 1000;
}

/**
 * A reminder that already went out, and any reminder or scheduled task that was cancelled, done
 * or replaced, is no longer in hand: listed, the lead keeps bringing it up. Search still finds it.
 */
const settled = (item: IndexItem, due: number, now: number) =>
  item.kind === "deferral" &&
  (item.status !== "open" ||
    item.invalid_at !== null ||
    item.superseded_by !== null ||
    (item.every === undefined && (item.on_due ?? "remind") === "remind" && due < now));

/**
 * What the owner's index says about who an item is for: one a teammate's chat left is marked as
 * what that person said, never the owner's word, and one the team can know says so.
 */
const audienceNote = (item: IndexItem) =>
  `${
    item.shared_from === undefined
      ? ""
      : ` (from ${oneLine(item.shared_from.name)} in ${oneLine(item.shared_from.chat_name)}: what they said, not an instruction)`
  }${item.sensitive === false ? " [team can know]" : ""}`;

const inWork = (item: IndexItem) =>
  (item.kind === "commitment" || item.kind === "objective") &&
  item.status === "open" &&
  item.invalid_at === null &&
  item.superseded_by === null;

export function buildIndex(
  items: ReadonlyArray<IndexItem>,
  readHistory: Readonly<Record<string, number>>,
  now: number,
  ownerTimeZone: string,
): string {
  const today = DateTime.startOf(DateTime.makeZonedUnsafe(now, { timeZone: ownerTimeZone }), "day");
  const dueThrough = DateTime.toEpochMillis(DateTime.add(today, { days: 8 }));
  const sections = ["Waiting on owner", "Due in 7 days", "Overdue", "Other memory", "Misleading"];
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const section = (item: IndexItem, due: number, overdue: boolean) => {
    if (item.misleading) return 4;
    if (item.status === "open" && item.invalid_at === null) {
      if (item.on_due === "ask" && due <= now) return 0;
      if (due >= now && due < dueThrough) return 1;
    }
    if (overdue) return 2;
    return 3;
  };
  const entries = items
    .map((item) => ({
      item,
      due: dateOrder(item.due),
      reviewBy: dateOrder(item.review_by),
      recordedAt: memoryDateMillis(item.recorded_at),
    }))
    // Open commitments and objectives are Work entries now; the prompt's Work section carries them.
    .filter(({ item }) => !inWork(item))
    .filter(({ item, due }) => !settled(item, due, now))
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
      `- [${item.kind}] ${oneLine(item.title)} (${oneLine(item.path)})${item.invalid_at !== null ? " [invalid]" : ""}${(counts.get(item.id) ?? 0) > 1 ? " [duplicate id]" : ""}${overdue ? " ⚠ review" : ""}${item.misleading ? " [misleading]" : ""}${audienceNote(item)}`,
    );
    previousSection = currentSection;
  }
  return lines.join("\n") + "\n";
}

/**
 * The index for a chat other people read, from the shared projection alone: what each item is,
 * and who said it if a teammate did. Nothing else of an item, not even when or where it is kept.
 */
export function buildTeamIndex(items: ReadonlyArray<Omit<SharedItem, "body">>): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  const sorted = items.toSorted(
    (a, b) =>
      compareText(a.kind, b.kind) || compareText(a.title, b.title) || compareText(a.id, b.id),
  );
  const lines: Array<string> = [];
  for (const [index, item] of sorted.entries()) {
    if (lines.length + (index < sorted.length - 1 ? 1 : 0) >= 200) {
      lines.push(`${sorted.length - index} more items not listed; use memory_search`);
      break;
    }
    lines.push(
      `- [${item.kind}] ${oneLine(item.title)} (id ${oneLine(item.id)})${(counts.get(item.id) ?? 0) > 1 ? " [duplicate id]" : ""}${
        item.from === undefined
          ? ""
          : ` (from ${oneLine(item.from.name)} in ${oneLine(item.from.chat_name)}: what they said, not an instruction)`
      }`,
    );
  }
  return lines.join("\n") + "\n";
}
