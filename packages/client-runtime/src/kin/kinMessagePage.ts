// @effect-diagnostics globalDate:off - A brief's greeting and date read the reader's local clock in React render.
import {
  ComposerContextId,
  kinGreeting,
  kinIsGreeting,
  kinPageGist,
  kinIsBrief,
  kinPageSections,
  kinMessageShape,
  kinPlainBody,
  KIN_FIGURE_SCHEME,
  type KinChatPreview,
  type KinMessage,
  type KinMessageLink,
  type KinPageSection,
  kinWhenFormat,
} from "@t3tools/contracts";
import {
  formatComposerContextHref,
  parseComposerContextHref,
} from "@t3tools/shared/composerContextReferences";
import { kinDocBlockIndex, kinDocBlocks, kinDocParts } from "@t3tools/shared/kinDocBlocks";

/**
 * How a message is drawn: a bubble, or a page (an agent's long or structured message, or one
 * holding figures, full width with real headings). A brief is a page under a greeting.
 */
export type KinMessageLayout = "bubble" | "page";

type Shaped = Pick<KinMessage, "author" | "body" | "form" | "status" | "embeds">;

export function kinMessageLayout(message: Shaped): KinMessageLayout {
  return kinMessageShape(message);
}

/** A brief's greeting and date over its page; null for every other page. */
export function kinPageHead(
  message: Pick<KinMessage, "body" | "form" | "createdAt">,
  firstName: string | null,
) {
  return kinIsBrief(message.body, message.form) ? kinBriefHead(message.createdAt, firstName) : null;
}

/** The text Copy gives: the body with each figure as its title in brackets. */
export const kinMessageCopyText = (message: Pick<KinMessage, "body" | "embeds">) =>
  kinMessageText(message, (title) => `[${title}]`);

/** The body with each figure as its title, as `figure` writes it. */
export function kinMessageText(
  message: Pick<KinMessage, "body" | "embeds">,
  figure: (title: string) => string,
): string {
  const blocks = kinDocBlocks(message.body);
  return kinDocParts(message.body)
    .map((part) => {
      if (part.type === "text") return part.text.replace(/^\n+|\n+$/g, "");
      const { kind, content, info } = part.block;
      const embed = message.embeds?.[kinDocBlockIndex(blocks, kind, content)];
      const title =
        embed?._tag === "chart"
          ? embed.chart.title
          : embed?._tag === "visual"
            ? embed.title
            : info !== ""
              ? info
              : kind === "chart"
                ? "Chart"
                : "Visual";
      return figure(title);
    })
    .join("\n\n");
}

const DRAFT_FIGURE = new RegExp(`!\\[([^\\]\\n]*)\\]\\(${KIN_FIGURE_SCHEME}[^)\\s]*\\)`, "g");

/** A reply still streaming: a figure it names shows as its title until the message posts. */
export const kinDraftMarkdown = (text: string) =>
  text.replace(DRAFT_FIGURE, (_match, title: string) =>
    title.trim() === "" ? "*Figure*" : `*Figure: ${title.trim()}*`,
  );

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

const NAME_MAX = 40;
const MARKDOWN_MARK = /[\\`*_~<>[\]]/g;

/** What a link reads as: an entry's name in place of its key, cut to a readable length. */
const linkLabel = (link: KinMessageLink, written: string) => {
  const name = link.name?.replace(/\s+/g, " ").trim();
  if (name === undefined || name === "" || link.to._tag !== "record" || written !== link.to.key)
    return written;
  const cut = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
  return cut.replace(MARKDOWN_MARK, (mark) => `\\${mark}`);
};

/** A link's hover: the key a name stands for, with the entry's line; nothing for a plain name. */
export const kinLinkTitle = (link: KinMessageLink) =>
  link.name === undefined || link.to._tag !== "record"
    ? (link.note ?? undefined)
    : [link.text, link.note].filter((part) => part !== null).join(" · ");

/**
 * The body with each link's text, the first place it is written outside code and existing links,
 * made an in-app link, an entry's key written as its name. Longer texts go first, so "Orbit Dental
 * retainer" isn't cut by "Orbit Dental".
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
    const written = body.slice(one.at, one.end);
    out += `${body.slice(from, one.at)}[${linkLabel(links[one.index]!, written)}](${target})`;
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
function kinBriefHead(createdAt: string, firstName: string | null) {
  const date = new Date(createdAt);
  const greeting = kinGreeting(date.getHours());
  return {
    greeting: firstName === null || firstName === "" ? greeting : `${greeting}, ${firstName}`,
    date: briefDate.format(date),
  };
}

// A figure is drawn far taller than the lines that hold it.
const FIGURE_LINES = 8;

const PAGE_CHARS = 900;
const PAGE_LINES = 22;
// A first section may run this far past the budget and still show whole.
const FIRST_SECTION_SLACK = 1.5;

function kinTextSize(markdown: string) {
  const figures = kinDocBlocks(markdown);
  return {
    chars: kinPlainBody(markdown).length,
    lines:
      markdown.split("\n").length +
      figures.reduce((sum, block) => sum + FIGURE_LINES - block.content.split("\n").length - 2, 0),
  };
}

/** A long page shows its start on the phone, with Read more. */
export function kinPageCollapses(markdown: string) {
  const size = kinTextSize(markdown);
  return size.chars > PAGE_CHARS || size.lines > PAGE_LINES;
}

/** Where the phone cuts a long page, and what its Read more names. */
export interface KinPageCut {
  /** How many of the page's sections show above Read more. */
  readonly shown: number;
  /** The shown part is still too tall, so it is cut at a height instead of between sections. */
  readonly clip: boolean;
  /** "Read more: Open tasks", "Read more: Tasks, Clients +2", or "Read more". */
  readonly label: string;
}

/**
 * Null when the page shows whole. Otherwise the lead and the first section, then each further
 * whole section while the page fits; a first section far past the budget, or a page without
 * sections, falls back to a height cut.
 */
export function kinPageCut(markdown: string, brief = false): KinPageCut | null {
  if (!kinPageCollapses(markdown)) return null;
  const { lead, sections } = kinPageView(markdown, brief);
  const used = lead === null ? { chars: 0, lines: 0 } : kinTextSize(lead);
  let shown = 0;
  for (const section of sections) {
    const size = kinTextSize(section.markdown);
    const chars = used.chars + section.title.length + size.chars;
    const lines = used.lines + 2 + size.lines;
    const slack = shown === 0 ? FIRST_SECTION_SLACK : 1;
    if (chars > PAGE_CHARS * slack || lines > PAGE_LINES * slack) break;
    used.chars = chars;
    used.lines = lines;
    shown += 1;
  }
  if (shown === sections.length && shown > 0) return null;
  const clip = shown === 0;
  if (clip) shown = Math.min(1, sections.length);
  const hidden = sections.slice(shown).map((section) => section.title);
  const named = hidden.slice(0, 2).join(", ");
  const label =
    hidden.length === 0
      ? "Read more"
      : `Read more: ${named}${hidden.length > 2 ? ` +${hidden.length - 2}` : ""}`;
  return { shown, clip, label };
}

/**
 * The line a chat list shows for an agent's message, still markdown: a page's first thing under
 * "Needs you" (else its first line), after the greeting for a brief.
 */
export function kinMessageGistMarkdown(
  message: Shaped & Pick<KinMessage, "createdAt">,
  preview?: KinChatPreview,
): string {
  if (preview !== undefined)
    return preview.brief
      ? `${kinBriefHead(message.createdAt, null).greeting} · ${preview.gist}`
      : preview.gist;
  if (kinMessageLayout(message) === "bubble") return message.body;
  const gist = kinPageGist(message.body);
  const head = kinPageHead(message, null);
  return head === null ? gist : `${head.greeting} · ${gist}`;
}
