import { scanKinDocFences } from "./kinDocFences.ts";

/**
 * How an agent's message is laid out, read from its own text so web, phone, the chat list and
 * pushes agree: a short reply stays a bubble; one with headings, a table or a run of items reads
 * as a page, cut into sections at its headings.
 */

export interface KinPageSection {
  /** The heading as written, without its markers; null for the text before the first one. */
  readonly title: string | null;
  readonly markdown: string;
}

export type KinPageShape = "bubble" | "page";

// The names a brief's sections go by; a bare "Money:" line counts as a heading only for these.
const SECTION_NAMES =
  /^(needs you|needs your attention|for you|money|cash|work|tasks|clients|people|team|coming up|this week|next week|today|later|decisions?|risks?|done|wins|notes?)$/i;
const FENCE = /^\s{0,3}(```|~~~)/;
const ATX = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
const BOLD_LINE = /^\s{0,3}(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const LABEL_LINE = /^\s{0,3}([A-Za-z][A-Za-z ]{1,30}):\s*$/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const GREETING =
  /^(?:good (?:morning|afternoon|evening)|morning|afternoon|evening|hi|hello|hey)\b[^\n]{0,60}$/i;

/** The heading a line is, or null: `## Money`, a line that is all bold, or `Money:` for a known name. */
function headingOf(line: string): string | null {
  const atx = ATX.exec(line)?.[1];
  if (atx !== undefined) return atx.replace(/\*\*|__/g, "").trim() || null;
  const bold = BOLD_LINE.exec(line)?.[1]?.trim();
  if (bold !== undefined && bold.length <= 60 && !bold.includes("**")) return bold;
  const label = LABEL_LINE.exec(line)?.[1]?.trim();
  return label !== undefined && SECTION_NAMES.test(label) ? label : null;
}

/** The text split at its headings; text in a code block is never a heading. */
export function kinPageSections(body: string): ReadonlyArray<KinPageSection> {
  const sections: Array<{ title: string | null; lines: Array<string> }> = [
    { title: null, lines: [] },
  ];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    const title = fenced ? null : headingOf(line);
    if (title === null) sections[sections.length - 1]!.lines.push(line);
    else sections.push({ title, lines: [] });
  }
  return (
    sections
      .map((section) => ({ title: section.title, markdown: section.lines.join("\n").trim() }))
      // A heading with nothing under it is left out, as an empty section of a brief is.
      .filter((section) => section.markdown !== "")
  );
}

/**
 * A page when the text has a heading (or two section labels such as "Money:"), a table, four or
 * more items in lists, or is long and in several paragraphs; anything else is a bubble.
 */
export function kinPageShape(body: string): KinPageShape {
  if (scanKinDocFences(body).found.length > 0) return "page";
  let fenced = false;
  let items = 0;
  let paragraphs = 0;
  let blank = true;
  let labels = 0;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (TABLE_RULE.test(line)) return "page";
    if (headingOf(line) !== null) {
      // One "Today:" in a short reply is a label; a written heading, or two labels, make sections.
      if (LABEL_LINE.test(line) && !ATX.test(line)) labels += 1;
      else return "page";
      if (labels >= 2) return "page";
    }
    if (LIST_ITEM.test(line)) items += 1;
    const empty = line.trim() === "";
    if (!empty && blank) paragraphs += 1;
    blank = empty;
  }
  if (items >= 4) return "page";
  return body.length > 600 && paragraphs >= 3 ? "page" : "bubble";
}

/**
 * Whether the text is cut into titled sections: a written heading, or two section labels. One
 * "Today:" line is a label, as `kinPageShape` reads it, not a section.
 */
function kinHasSections(body: string): boolean {
  let fenced = false;
  let labels = 0;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || headingOf(line) === null) continue;
    if (!LABEL_LINE.test(line) || ATX.test(line)) return true;
    labels += 1;
    if (labels >= 2) return true;
  }
  return false;
}

/** Text a brief's page can be as written: titled sections, not one label over a line. */
export const kinIsPage = (body: string) =>
  kinHasSections(body) && kinPageSections(body).some(({ title }) => title !== null);

/** A brief reads under a greeting only with sections; a check-in that came back as one line doesn't. */
export const kinIsBrief = (body: string, form: string | null | undefined) =>
  form === "brief" && kinPageSections(body).some(({ title }) => title !== null);

/** "Good morning", "Good afternoon" or "Good evening" for an hour of the reader's day. */
export const kinGreeting = (hour: number) =>
  hour < 5
    ? "Good evening"
    : hour < 12
      ? "Good morning"
      : hour < 17
        ? "Good afternoon"
        : "Good evening";

/** A brief's opening line when it is only a greeting, which the layout already says. */
export const kinIsGreeting = (line: string) => GREETING.test(line.trim());

const firstLine = (markdown: string) =>
  markdown
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ""))
    .find((line) => line !== "" && !kinIsGreeting(line) && !FENCE.test(line) && !/^\|/.test(line));

/**
 * The one line a list or a push shows for a page: the first thing under "Needs you" when there is
 * one, else the first line that says something. Still markdown; callers make it plain.
 */
export function kinPageGist(body: string): string {
  const plain = kinPlainBody(body);
  if (plain.trim() === "") return scanKinDocFences(body).found[0]?.block.info ?? "";
  body = plain;
  const sections = kinPageSections(body);
  const needs = sections.find(
    (section) =>
      section.title !== null && /^(needs you|needs your attention|for you)$/i.test(section.title),
  );
  for (const section of needs === undefined ? sections : [needs, ...sections]) {
    const line = firstLine(section.markdown);
    if (line !== undefined) return line;
  }
  return firstLine(body) ?? "";
}

const THREAD_LINK = /(?<!!)\[([^\]]*)\]\(\s*<?t3-thread:[^)]*\)/gi;
const BARE_THREAD_LINK = /[^\S\n]*<?t3-thread:[^\s<>()]*[^\s<>().,;:!?'"]>?/gi;

/** Kin has no thread screen, so a link to a T3 thread reads as its words and a bare one goes. */
export const kinThreadLinksAsWords = (body: string) =>
  body.replace(THREAD_LINK, "$1").replace(BARE_THREAD_LINK, "");

export function kinPlainBody(body: string): string {
  const { lines, found } = scanKinDocFences(body);
  if (found.length === 0) return body;
  let at = 0;
  const text = found.flatMap(({ from, to }) => {
    const part = lines.slice(at, from);
    at = to + 1;
    return part;
  });
  return [...text, ...lines.slice(at)].join("\n").trim();
}
