import type {
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";

/**
 * A failure no retry fixes: the model account needs signing in again (`signin`), cannot use
 * the lead's model (`access`), the provider doesn't know that model (`model`), or its program
 * exited before the turn began, such as a binary path to nothing (`program`). The codes and the
 * last message are the adapters'.
 */
export type SetupFailure = "signin" | "access" | "model" | "program";
export function setupFailure(failure: OrchestrationV2ProviderFailure): SetupFailure | null {
  if (failure.message.includes("program exited before the turn started")) return "program";
  if (failure.code === "authentication_failed" || failure.code === "api_error_401") return "signin";
  if (failure.code === "api_error_403" || failure.class === "permission_error") return "access";
  if (
    (failure.code === "api_error_400" || failure.code === "api_error_404") &&
    /\bmodel\b/i.test(failure.message)
  )
    return "model";
  return null;
}
/** The Claude CLI words a failed API call as the turn's own reply; it is the provider's text. */
export const isProviderErrorText = (text: string) => text.trimStart().startsWith("API Error:");
/** The setup failure that ended a run from `rootRunId` on, if one did. */
export function setupFailureIn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  rootRunId: RunId,
): SetupFailure | null {
  const root = projection.runs.find((run) => run.id === rootRunId);
  if (root === undefined) return null;
  const runs = new Set(
    projection.runs.filter((run) => run.ordinal >= root.ordinal).map((run) => run.id),
  );
  for (const item of projection.turnItems) {
    // A retry the provider recovered from leaves its error item `completed`: it ended nothing.
    if (item.type !== "error" || item.status !== "failed") continue;
    if (item.runId === null || !runs.has(item.runId)) continue;
    const found = setupFailure(item.failure);
    if (found !== null) return found;
  }
  return null;
}

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

/** Kin asks this once when a turn owed words and ended with none (`KinReplyBridge.complete`). */
export const RESCUE_PROMPT =
  "You ended without a reply anyone can see: your thinking is never shown. Write your reply now as plain text.";
/** The same, when the turn's only answer was a chart, visual or file with no words beside it. */
export const CAPTION_PROMPT =
  "What you posted is in the chat with no words beside it. Say in one line what it shows.";

export const normalized = (text: string) => text.trim().replace(/\s+/g, " ");
// Only case, spacing and the closing ? or . differ: "$1.00?" and "$100." stay different.
const comparable = (text: string) =>
  normalized(text)
    .toLowerCase()
    .replace(/[?.]+$/u, "")
    .trimEnd();
// Words that carry a sentence's meaning: three letters or more, or any with a digit.
const meaningful = (text: string) =>
  new Set(
    normalized(text)
      .toLowerCase()
      .split(/[\s,;:!?()"“”]+/u)
      .map((word) => word.replace(/^[.'’]+|[.'’]+$/gu, ""))
      .filter((word) => word.length >= 3 || /\d/.test(word)),
  );
/** Most of what the sentence says, the question already says: a restatement, not news. */
const restates = (sentence: string, earlier: ReadonlySet<string>) => {
  const words = [...meaningful(sentence)];
  return (
    words.length >= 3 && words.filter((word) => earlier.has(word)).length / words.length >= 0.6
  );
};
// Odd entries are the separators, kept so a shortened text reads as it was written.
const SENTENCE_BREAK = /((?<=[.?!])[ \t]+|\n+)/;
const sentencesOf = (text: string) =>
  text.split(SENTENCE_BREAK).filter((part, index) => index % 2 === 0 && part.trim() !== "");
/**
 * The segment says again, word for word, what the reply already said: nearly all of its text is
 * sentences the reply has. A model that repeats its answer at the end of a turn sends this.
 */
export const repeats = (text: string, said: string) => {
  const earlier = new Set(sentencesOf(said).map(comparable));
  const parts = sentencesOf(text);
  const length = (list: ReadonlyArray<string>) => list.reduce((sum, one) => sum + one.length, 0);
  const repeated = length(parts.filter((part) => earlier.has(comparable(part))));
  return parts.length > 0 && repeated >= 0.8 * length(parts);
};
/** A reply less the sentences that repeat or restate a card's question, which the card asks. */
export const withoutAsked = (text: string, questions: ReadonlyArray<string>) => {
  const wanted = new Set(questions.map(comparable).filter((one) => one !== ""));
  if (wanted.size === 0) return text;
  const earlier = questions.map(meaningful);
  const parts = text.split(SENTENCE_BREAK);
  const kept: Array<string> = [];
  let dropped = false;
  // The widest break since the last kept sentence: a dropped one never joins two lines.
  let gap = "";
  for (let index = 0; index < parts.length; index += 2) {
    const sentence = parts[index]!;
    const before = parts[index - 1] ?? "";
    if (before.split("\n").length >= gap.split("\n").length) gap = before;
    if (wanted.has(comparable(sentence)) || earlier.some((words) => restates(sentence, words)))
      dropped = true;
    else if (sentence.trim() !== "") {
      kept.push(`${kept.length === 0 ? "" : gap}${sentence}`);
      gap = "";
    }
  }
  return dropped ? kept.join("").trim() : text;
};

/** What follows a segment in its run (`end`: nothing, the run ended): a short one before a tool is status. */
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

// The presence line's only words, as a colleague would say them: fixed text, never tool
// arguments or model text, and never a tool's name or how Kin works inside.
export const PHASE_LABELS = {
  queued: "Finishing something else",
  held: "Waiting until tomorrow",
  preparing: "Catching up",
  thinking: "Thinking",
  writing: "Writing",
  tool: "Working",
  attachments: "Looking at what you sent",
} as const;
// Null leaves the line as it was: the call is bookkeeping, not work the owner waits on.
const TOOL_LABELS: ReadonlyArray<readonly [RegExp, string | null]> = [
  [/(?:^|__|\.)(?:memory_search|memory_read|Read|Grep|Glob)$/, "Checking my notes"],
  [/(?:^|__|\.)memory_\w+$/, "Making a note"],
  [/(?:^|__|\.)kin_defer$/, "Setting a reminder"],
  [/(?:^|__|\.)kin_leads$/, "Checking who handles this"],
  [/(?:^|__|\.)kin_computer$/, "Checking Kin's computer"],
  [/(?:^|__|\.)people_read$/, "Checking who's on the team"],
  [/(?:^|__|\.)people_update$/, "Updating a profile"],
  [/(?:^|__|\.)away_set$/, "Noting when you're away"],
  [/(?:^|__|\.)kin_hand_off$/, "Passing this on"],
  [/(?:^|__|\.)team_(?:open|say)$/, "Talking it over with the team"],
  [/(?:^|__|\.)kin_take_private$/, "Answering you directly"],
  [/(?:^|__|\.)kin_relay$/, "Passing this on"],
  [/(?:^|__|\.)people_read$/, "Checking who's on the team"],
  [/(?:^|__|\.)pulse_read$/, "Checking what needs attention"],
  [/(?:^|__|\.)pulse_handle$/, null],
  [/(?:^|__|\.)pulse_nudge$/, "Nudging a teammate"],
  [/(?:^|__|\.)kin_ask$/, "Writing a question"],
  [/(?:^|__|\.)kin_ask_close$/, "Closing a question"],
  [/(?:^|__|\.)kin_ask_person$/, "Asking a teammate"],
  [/(?:^|__|\.)agent_update$/, "Updating an agent"],
  [/(?:^|__|\.)kin_chart$/, "Drawing a chart"],
  [/(?:^|__|\.)kin_visual$/, "Putting a visual together"],
  [/(?:^|__|\.)kin_picture$/, "Making a picture"],
  [/(?:^|__|\.)kin_schedule$/, "Setting up a schedule"],
  [/(?:^|__|\.)kin_cancel$/, "Cancelling it"],
  [/(?:^|__|\.)kin_github_review$/, "Reviewing a pull request"],
  [/(?:^|__|\.)kin_github_review_ask$/, "Starting a pull request review"],
  [/(?:^|__|\.)kin_github_link$/, "Linking GitHub to Work"],
  [/(?:^|__|\.)kin_github_watch$/, "Checking which repos Kin watches"],
  [/(?:^|__|\.)kin_github_\w+$/, "Checking GitHub"],
  [/(?:^|__|\.)kin_chat_read$/, "Reading the chat"],
  [/(?:^|__|\.)kin_chat_post$/, "Writing"],
  [/(?:^|__|\.)(?:kin_react|kin_journal)$/, null],
];
export function toolLabel(item: OrchestrationV2TurnItem): string | null {
  if (item.type === "file_search") return "Checking my notes";
  const name = item.type === "dynamic_tool" ? (item.toolName ?? "") : (item.title ?? "");
  const found = TOOL_LABELS.find(([pattern]) => pattern.test(name));
  return found === undefined ? PHASE_LABELS.tool : found[1];
}
