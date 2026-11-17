// @effect-diagnostics globalDate:off - A brief's greeting and date read the reader's local clock in React render.
import {
  ComposerContextId,
  kinGreeting,
  kinIsGreeting,
  kinPageGist,
  kinIsBrief,
  kinPageSections,
  kinPageShape,
  type KinMessage,
  type KinMessageLink,
  type KinPageSection,
  kinWhenFormat,
} from "@t3tools/contracts";
import {
  formatComposerContextHref,
  parseComposerContextHref,
} from "@t3tools/shared/composerContextReferences";

/**
 * How a message is drawn: a bubble, a page (an agent's long or structured message, full width
 * with real headings), or a brief (an agent's check-in, a page under a greeting).
 */
export type KinMessageLayout = "bubble" | "page" | "brief";

export function kinMessageLayout(
  message: Pick<KinMessage, "author" | "body" | "form" | "status">,
): KinMessageLayout {
  if (message.status === "deleted" || message.author._tag === "human") return "bubble";
  if (kinIsBrief(message.body, message.form)) return "brief";
  return kinPageShape(message.body);
}

// On the web a link rides T3's context-reference href, which its markdown keeps; the phone's
// renderer draws those as chips, so there it is a plain `kin-link:<n>`.
const LINK_KIND = "kin-link";
const PLAIN_LINK = /^kin-link:(\d{1,3})$/;
export type KinLinkHref = "context" | "plain";
const FENCED = /^\s{0,3}(```|~~~)[^\n]*\n[\s\S]*?(?:^\s{0,3}\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE = /`[^`\n]*`/g;
const MARKDOWN_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/g;
const BARE_URL = /<?https?:\/\/[^\s<>()]+>?/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The body with each link's text, the first place it is written outside code and existing links,
 * made an in-app link. Longer texts go first, so "Orbit Dental retainer" isn't cut by "Orbit Dental".
 */
export function kinLinkedMarkdown(
  body: string,
  links: ReadonlyArray<KinMessageLink> | undefined,
  href: KinLinkHref = "context",
) {
  if (links === undefined || links.length === 0) return body;
  const taken: Array<{ at: number; end: number; index: number }> = [];
  for (const pattern of [FENCED, INLINE_CODE, MARKDOWN_LINK, BARE_URL])
    for (const match of body.matchAll(pattern))
      taken.push({ at: match.index, end: match.index + match[0].length, index: -1 });
  const free = (at: number, end: number) => taken.every((one) => end <= one.at || at >= one.end);
  const order = links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => !/[[\]\n]/.test(link.text))
    .sort((a, b) => b.link.text.length - a.link.text.length);
  for (const { link, index } of order) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escape(link.text)}(?![\\p{L}\\p{N}])`, "gu");
    for (const match of body.matchAll(pattern)) {
      const end = match.index + link.text.length;
      if (!free(match.index, end)) continue;
      taken.push({ at: match.index, end, index });
      break;
    }
  }
  let out = "";
  let from = 0;
  for (const one of taken.filter((t) => t.index >= 0).sort((a, b) => a.at - b.at)) {
    const target =
      href === "plain"
        ? `${LINK_KIND}:${one.index}`
        : formatComposerContextHref(LINK_KIND, ComposerContextId.make(String(one.index)));
    out += `${body.slice(from, one.at)}[${body.slice(one.at, one.end)}](${target})`;
    from = one.end;
  }
  return out + body.slice(from);
}

/** The link an in-app href made by `kinLinkedMarkdown` stands for, or null for any other href. */
export function kinLinkOf(
  href: string,
  links: ReadonlyArray<KinMessageLink> | undefined,
): KinMessageLink | null {
  const plain = PLAIN_LINK.exec(href)?.[1];
  if (plain !== undefined) return links?.[Number(plain)] ?? null;
  const reference = parseComposerContextHref(href);
  if (reference === null || reference.kind !== LINK_KIND) return null;
  return links?.[Number(reference.contextId)] ?? null;
}

export interface KinPageView {
  /** The text before the first heading, without a greeting a brief already shows. */
  readonly lead: string | null;
  readonly sections: ReadonlyArray<KinPageSection & { readonly title: string }>;
}

export function kinPageView(markdown: string, brief = false): KinPageView {
  const all = kinPageSections(markdown);
  const first = all[0]?.title === null ? all[0] : undefined;
  const lines = first?.markdown.split("\n") ?? [];
  // "Good morning Rhea. A quiet day." keeps "A quiet day."; the greeting is the heading's.
  const opening = lines[0] ?? "";
  if (brief && kinIsGreeting(opening)) lines[0] = opening.replace(/^[^.!?]*[.!?]?\s*/, "");
  const lead = lines.join("\n").trim();
  return {
    lead: lead === "" ? null : lead,
    sections: all.filter(
      (section): section is KinPageSection & { title: string } => section.title !== null,
    ),
  };
}

const briefDate = kinWhenFormat("longDay");

/** A brief's head: "Good morning, Rhea" by the reader's time of day when it came, and its date. */
export function kinBriefHead(createdAt: string, firstName: string | null) {
  const date = new Date(createdAt);
  const greeting = kinGreeting(date.getHours());
  return {
    greeting: firstName === null || firstName === "" ? greeting : `${greeting}, ${firstName}`,
    date: briefDate.format(date),
  };
}

/** A long page shows its start on the phone, with Read more. */
export const kinPageCollapses = (markdown: string) =>
  markdown.length > 900 || markdown.split("\n").length > 22;

/**
 * The line a chat list shows for an agent's message, still markdown: a page's first thing under
 * "Needs you" (else its first line), after the greeting for a brief.
 */
export function kinMessageGistMarkdown(
  message: Pick<KinMessage, "author" | "body" | "form" | "status" | "createdAt">,
): string {
  const layout = kinMessageLayout(message);
  if (layout === "bubble") return message.body;
  const gist = kinPageGist(message.body);
  return layout === "brief" ? `${kinBriefHead(message.createdAt, null).greeting} · ${gist}` : gist;
}
