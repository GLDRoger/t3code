import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** A pre-tool segment up to this long, in one paragraph, is a status note, not a message. */
export const NOTE_MAX_CHARS = 160;
/** Presence labels are cut to this length. */
const LABEL_MAX_CHARS = 60;
/** The whole text of a notice wake-up that has nothing worth saying. */
export const SILENT_REPLY = "NO_REPLY";
/** Parenthetical asides a lead appends when it means to say nothing; they never reach a chat. */
export const SILENCE_MARKERS = [
  "no reply needed",
  "no response needed",
  "nothing to add",
  "staying quiet",
  "silent",
] as const;

const markerPattern = SILENCE_MARKERS.map((marker) => marker.replace(/ /g, "\\s+")).join("|");
const trailingMarker = new RegExp(`[ \\t]*\\(\\s*(?:${markerPattern})\\s*\\)\\s*$`, "i");
const markersOnly = new RegExp(`^(?:\\s*\\(\\s*(?:${markerPattern})\\s*\\))+\\s*$`, "i");
const normalizePhrase = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/** The whole text is only silence markers; bare (unparenthesized) counts only as the whole text. */
function isSilenceOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if ((SILENCE_MARKERS as ReadonlyArray<string>).includes(normalizePhrase(trimmed))) return true;
  return markersOnly.test(trimmed);
}

/** Removes silence markers that end a reply, as the last parenthetical or on their own final line. */
export function stripTrailingSilenceMarker(text: string): string {
  let result = text;
  while (trailingMarker.test(result)) result = result.replace(trailingMarker, "").trimEnd();
  return result;
}

const isMarkerPrefix = (fragment: string) => {
  const normalized = normalizePhrase(fragment);
  return SILENCE_MARKERS.some((marker) => marker === normalized || marker.startsWith(normalized));
};

/**
 * What a streaming draft may show: a trailing marker is stripped, and a trailing fragment
 * that could still become one (`(no reply nee`, or the whole text so far) is held back.
 */
export function draftReplyText(text: string): string {
  const stripped = stripTrailingSilenceMarker(text);
  if (isSilenceOnly(stripped)) return "";
  const whole = normalizePhrase(stripped);
  if (whole !== "" && isMarkerPrefix(whole)) return "";
  const open = stripped.lastIndexOf("(");
  if (open >= 0 && !stripped.slice(open).includes(")") && isMarkerPrefix(stripped.slice(open + 1)))
    return stripped.slice(0, open).trimEnd();
  return stripped;
}

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
  if (trimmed === SILENT_REPLY || isSilenceOnly(trimmed)) return "silent";
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
/** The lead's `kin_end` call: the text before it is its reply, and it has nothing more to say. */
export const isEndCall = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" && /(?:^|__|\.)kin_end$/.test(item.toolName ?? "");

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
