import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** A pre-tool segment up to this long, in one paragraph, is a status note, not a message. */
export const NOTE_MAX_CHARS = 160;
/** Presence labels are cut to this length. */
const LABEL_MAX_CHARS = 60;
/** The whole text of a notice wake-up that has nothing worth saying. */
export const SILENT_REPLY = "NO_REPLY";

/** What follows a segment in its run: decides whether a short segment was a status note. */
export type SegmentNext = "tool" | "text" | "end";
export type SegmentClass = "post" | "note" | "silent" | "empty";

const isStructured = (text: string) =>
  text.length > NOTE_MAX_CHARS ||
  /\n[ \t]*\n/.test(text) ||
  /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/m.test(text) ||
  text.includes("```");

/**
 * Plain code decides what a segment is, so a model can't misroute it. Long or structured text
 * is content wherever it sits; short single-paragraph text right before a tool call is status.
 */
export function classifySegment(text: string, next: SegmentNext | null): SegmentClass | null {
  const trimmed = text.trim();
  if (trimmed === "") return "empty";
  if (trimmed === SILENT_REPLY) return "silent";
  if (isStructured(trimmed)) return "post";
  // Unknown yet: a short segment waits for the next item or the run's end.
  if (next === null) return null;
  return next === "tool" ? "note" : "post";
}

export function cutLabel(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const chars = Array.from(line);
  return chars.length <= LABEL_MAX_CHARS
    ? line
    : `${chars.slice(0, LABEL_MAX_CHARS - 1).join("")}…`;
}

const TOOL_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);
export const isToolItem = (item: OrchestrationV2TurnItem) => TOOL_TYPES.has(item.type);

// Labels come from this table, never from the model's own words about what it is doing.
const LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:^|__|\.)(?:memory_search|memory_read|Read|Grep|Glob)$/, "Checking memory"],
  [/(?:^|__|\.)kin_defer$/, "Setting a reminder"],
  [/(?:^|__|\.)kin_delegate$/, "Starting a worker"],
  [/(?:^|__|\.)request_action$/, "Preparing a request"],
];
export function toolLabel(item: OrchestrationV2TurnItem): string {
  if (item.type === "file_search") return "Checking memory";
  const name = item.type === "dynamic_tool" ? (item.toolName ?? "") : (item.title ?? "");
  return LABELS.find(([pattern]) => pattern.test(name))?.[1] ?? "Working";
}
