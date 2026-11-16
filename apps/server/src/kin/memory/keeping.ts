import type { MemoryItemHead } from "@t3tools/contracts";

import { memoryDateMillis } from "./frontMatter.ts";

/** What memory is for, written once: `memory_write` carries it and the nightly pass extracts by it. */
export const MEMORY_RULE =
  'Save only what will still matter weeks from now and that you could not cheaply find out again: a lasting fact about the company, a client, a person or a project; how the owner wants things done; a decision with its reason; a promise made to or by someone, with its date as due. One item holds one thing, in a few sentences: two facts are two items. What someone said keeps their exact words as its quote. Everything else stays out of memory. Something to do later today, or a follow-up minutes or hours away ("get back to them after the pause", "recheck access"), is a reminder: kin_defer. So is a promise due in under a day. A promise further out is an item, plus a reminder only if you must act on the day. Where work stands right now, progress, and what you are waiting for are not memory: the work and its report already hold them, and kin_journal takes what nothing else records. Anything you can read again where it lives (a repo, a PR, a check, whether you have access) is saved nowhere, and neither is small talk or a one-off request.';

/** One item holds one thing; a body past this is several. */
export const BODY_MAX = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A follow-up minutes or hours away is over a day later; other to-dos and progress get a week. */
const SOON_SPENT_MS = DAY_MS;
const SPENT_MS = 7 * DAY_MS;

const TODO_REFUSAL =
  "Not saved: that is something to do, not something to remember. Set it as a reminder with kin_defer, or leave it out if it is done. A lasting fact goes in worded as the fact.";
const PROGRESS_REFUSAL =
  "Not saved: that is where work stands right now, which the work itself already records. Leave it out, or note it with kin_journal if nothing else holds it.";
const NEAR_DUE_REFUSAL =
  "Not saved: its date is under a day away, so it is a reminder. Set it with kin_defer.";
const LONG_REFUSAL = `Not saved: one item holds one thing, in at most ${BODY_MAX} characters. Split it into separate items of a few sentences each.`;

const DURATION =
  "(?:\\d+|a|an|one|two|three|five|ten|a few|a couple of|half an?)[ -]?(?:s|secs?|seconds?|mins?|minutes?|hrs?|hours?)\\b";
const NEAR = new RegExp(
  `\\b(?:in|after|for) (?:another |about |the next )?${DURATION}|\\b(?:later today|this afternoon|this evening|tonight|in a (?:moment|bit|while)|shortly)\\b`,
  "i",
);
const AFTER_A_PAUSE =
  /\bafter (?:the|that|this|their|his|her|a) (?:[\w-]+ ){0,2}(?:pause|sleep|wait|timer)\b/i;
const FOLLOW_UP =
  /\b(?:get(?:ting)? back to|check back|circle back|report back|come back to|follow(?:ing)? up|remind(?:er)?s?|re-?check|re-?try|ping)\b/i;
const TODO_TITLE =
  /^(?:(?:i |we )?(?:need|have|must|should|remember) to )?(?:to-?do\b|re-?check\b|check (?:whether|if|back|again)\b|verify (?:whether|if)\b|confirm (?:whether|if)\b|retry\b|look into\b)/i;
const PROGRESS =
  /\b(?:i am|i'm|i’m|still|currently) waiting (?:for|on)\b|\bwaiting (?:for|on) (?:the |a |its |their )?(?:worker|owner|reply|response|answer|report|results?)\b|\b(?:worker|task) (?:is |was |has been |has )?(?:started|still running|running|in progress|kicked off|queued|under ?way)\b|\bwork in progress\b/i;
const PROGRESS_TITLE = /^(?:progress|status) (?:note|update)\b/i;
// Words of a standing fact: "always get back to clients in two hours" is how things are done.
const STANDING =
  /\b(?:always|never|every|each time|whenever|usually|by default|policy|rule|prefers?)\b/i;

interface Words {
  readonly title: string;
  readonly what?: string | undefined;
  readonly body: string;
}

/**
 * The obvious cases of a note that is not memory: `soon` is a follow-up minutes or hours away,
 * `todo` a to-do with no time, `progress` where work stands. Anything unclear is memory.
 */
export const notMemory = (item: Words): "soon" | "todo" | "progress" | undefined => {
  const title = item.title.trim();
  const text = [title, item.what ?? "", item.body].join("\n");
  if (STANDING.test(text)) return undefined;
  if (AFTER_A_PAUSE.test(text) || (NEAR.test(text) && FOLLOW_UP.test(text))) return "soon";
  if (TODO_TITLE.test(title)) return "todo";
  if (PROGRESS_TITLE.test(title) || PROGRESS.test(text)) return "progress";
  return undefined;
};

/**
 * Why a lead's write is refused, with the tool that takes it instead; undefined when it may be
 * saved. Closing an item (invalidate, or any status but open) always goes through, so what is
 * already saved can always be retired.
 */
export const writeRefusal = (
  input: {
    readonly op: "create" | "update" | "supersede" | "invalidate";
    readonly item: Words & Pick<MemoryItemHead, "kind" | "status" | "due">;
  },
  now: number,
): string | undefined => {
  const { op, item } = input;
  if (op === "invalidate" || item.kind === "deferral" || item.status !== "open") return undefined;
  const what = notMemory(item);
  if (what === "progress") return PROGRESS_REFUSAL;
  if (what !== undefined) return TODO_REFUSAL;
  // A bare date is a day; only a time of day can be hours away.
  if (item.due !== null && item.due.includes("T")) {
    const left = memoryDateMillis(item.due) - now;
    if (left > 0 && left < DAY_MS) return NEAR_DUE_REFUSAL;
  }
  if (op !== "update" && item.body.length > BODY_MAX) return LONG_REFUSAL;
  return undefined;
};

/** A current note that was never memory and whose moment has passed: the nightly pass retires it. */
export const spent = (
  item: { readonly head: MemoryItemHead; readonly body: string },
  now: number,
) => {
  const { head } = item;
  if (
    head.kind === "deferral" ||
    head.status !== "open" ||
    head.invalid_at !== null ||
    head.superseded_by !== null
  )
    return false;
  const what = notMemory({ title: head.title, what: head.what, body: item.body });
  if (what === undefined) return false;
  const age = now - memoryDateMillis(head.recorded_at);
  return age > (what === "soon" ? SOON_SPENT_MS : SPENT_MS);
};

/** Most characters a memory item's `quote` holds. */
export const QUOTE_MAX = 400;
/** Fewer folded characters than this match almost any message, unless they are all of it. */
const QUOTE_MIN = 12;
const QUOTE_TOO_LONG = `a quote is at most ${QUOTE_MAX} characters; quote only the words that say it`;
const QUOTE_NO_WORDS =
  "that event has no words to quote; cite the person's own message that says it";
const QUOTE_NOT_SAID = "that quote isn't in the message; quote it exactly or don't save it";
const QUOTE_TOO_SHORT =
  "that quote is too short to show where this came from; quote the words that say it";
export const QUOTE_MISSING = `this says what someone said, so pass quote: their exact words from that message that say it, at most ${QUOTE_MAX} characters; quote it exactly or don't save it`;

/** Case, Unicode forms, curly quotes and runs of whitespace never decide whether words match. */
const fold = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const bare = (text: string) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * Why `quote` does not show the cited message said it, as a clause the lead can act on;
 * undefined when it is that message's own words. `said` is the message, undefined for an
 * event with no words, such as a tap.
 */
export const quoteRefusal = (quote: string, said: string | undefined): string | undefined => {
  if (quote.length > QUOTE_MAX) return QUOTE_TOO_LONG;
  if (said === undefined) return QUOTE_NO_WORDS;
  const words = fold(quote);
  const message = fold(said);
  if (words === "" || !message.includes(words)) return QUOTE_NOT_SAID;
  if (words.length < QUOTE_MIN && bare(words) !== bare(message)) return QUOTE_TOO_SHORT;
  return undefined;
};
/** The writer's quote refusals: about the cited message only, never about what is stored. */
export const QUOTE_REFUSALS: ReadonlySet<string> = new Set([
  QUOTE_TOO_LONG,
  QUOTE_NO_WORDS,
  QUOTE_NOT_SAID,
  QUOTE_TOO_SHORT,
  QUOTE_MISSING,
]);
