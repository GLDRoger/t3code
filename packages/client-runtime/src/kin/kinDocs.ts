// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KinDocCardState,
  type KinChatId,
  type KinChatSummary,
  type KinDocDetail,
  type KinDocDiff,
  type KinDocEmbed,
  type KinDocRow,
  type KinDocSection,
  type KinDocVersion,
  type KinMessageRef,
  type KinMessageRefInput,
  type KinOrgId,
  type KinPersonId,
  type KinSearchHit,
  type KinSearchKind,
  type KinSearchResult,
  type KinWidget,
  type KinWorkActor,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import { kinDocBlockIndex, kinDocBlocks, kinDocParts } from "@t3tools/shared/kinDocBlocks";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import {
  isKinChatError,
  kinWorkName,
  kinWorkPrincipalKey,
  kinWorkRefused,
  type KinWorkNames,
} from "./kinWork.ts";

export const KIN_DOCS = {
  title: "Docs",
  search: "Search docs",
  loading: "Loading docs",
  loadFailed: "Couldn't load docs",
  archived: "Archived",
  current: "Current",
  contents: "Contents",
  history: "History",
  changes: "See changes",
  ask: "Ask about this",
  change: "Change this",
  copyLink: "Copy link",
  copied: "Link copied",
  export: "Export as Markdown",
  restore: "Restore this version",
  restoring: "Restoring…",
  compare: "Compare with the latest",
  private: "Private. Only you can see this.",
  privateInherited: "Private, because its client or project is. Only you can see this.",
  top: "Introduction",
  empty: {
    title: "No docs yet",
    detail:
      "Ask an agent for a plan, a brief, a runbook or meeting notes. It lands here, and the agent keeps it current.",
  },
  noMatch: {
    title: "No doc says that",
    detail: "Try other words, or look in the archived ones.",
  },
  passages: "Where it says so",
  emptyArchived: {
    title: "Nothing archived",
    detail: "A doc an agent archives is kept here, with its whole history.",
  },
  // A teammate, until docs are shared with the team.
  unavailable: {
    title: "Docs aren't available to you yet",
    detail: "For now only the person who runs this workspace can read them.",
  },
  gone: {
    title: "This doc isn't here any more",
    detail: "Open Docs to see what there is now.",
  },
  failed: {
    title: "Couldn't load this doc",
    detail: "Check your connection to the server and try again.",
  },
  noChanges: {
    title: "Nothing changed",
    detail: "These two versions read the same.",
  },
  firstVersion: {
    title: "This is the first version",
    detail: "There is nothing earlier to compare it with.",
  },
  noAgent: "No agent keeps this doc, so there is nobody to ask yet.",
  // The host drew nothing for the block: it predates them, or the block is new since it drew.
  undrawn: { chart: "This chart can't be shown.", visual: "This visual can't be shown." },
} as const;

/** A stretch of a doc's markdown, or what the host drew for one of its blocks. */
export type KinDocPiece =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "embed"; readonly embed: KinDocEmbed };

/**
 * `text` (the body, or a section of it) cut around its `kin_chart` and `kin_visual` blocks, each
 * with the embed the host drew for that block of the body. A block it drew nothing for, or
 * something of the other kind, reads as broken rather than as its raw JSON or HTML.
 */
export function kinDocPieces(
  text: string,
  doc: Pick<KinDocDetail, "body" | "embeds">,
): ReadonlyArray<KinDocPiece> {
  const blocks = kinDocBlocks(doc.body);
  return kinDocParts(text).map((part): KinDocPiece => {
    if (part.type === "text") return part;
    const { kind, content } = part.block;
    const embed = doc.embeds?.[kinDocBlockIndex(blocks, kind, content)];
    return embed !== undefined && (embed._tag === kind || embed._tag === "broken")
      ? { type: "embed", embed }
      : { type: "embed", embed: { _tag: "broken", message: KIN_DOCS.undrawn[kind] } };
  });
}

/** A piece's React key. A visual's frame keeps the first page it loads, so a new page gets a new one. */
export const kinDocPieceKey = (piece: KinDocPiece, index: number) =>
  piece.type === "embed" && piece.embed._tag === "visual"
    ? `${index}:${piece.embed.attachmentId}`
    : `${index}:${piece.type}`;

export const KIN_SEARCH = {
  title: "Search",
  placeholder: "Search tasks, clients, projects and docs",
  hint: {
    title: "Search everything in Work",
    detail: "Tasks, clients, contacts, projects and docs, by any words in them.",
  },
  failed: "Couldn't search. Check your connection and try again.",
  includeClosed: "Include closed and archived",
} as const;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

// When and who

const DAY_MS = 24 * 60 * 60 * 1000;
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "today 14:02", "yesterday 09:10", "12 Nov", or "12 Nov 2025" for another year. */
function kinDocWhen(at: string, now: Date): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `today ${clockFormat.format(date)}`;
  if (days === -1) return `yesterday ${clockFormat.format(date)}`;
  return date.getFullYear() === now.getFullYear()
    ? dayFormat.format(date)
    : dayYearFormat.format(date);
}

const actorName = (actor: KinWorkActor, names: KinWorkNames, you: string) =>
  actor._tag === "system" ? "Kin" : kinWorkName(actor, names, you);

const VERB: Record<KinDocVersion["kind"], string> = {
  created: "Written",
  edited: "Updated",
  rewritten: "Rewritten",
  restored: "Restored",
};

type Change = Pick<KinDocVersion, "at" | "kind" | "summary"> & { readonly by: KinWorkActor };

export interface KinDocChangeLine {
  /** "Updated today 14:02 by Growth". */
  readonly lead: string;
  /** What changed, in the agent's words; null when it gave none. */
  readonly summary: string | null;
  /** Both, for a row or a screen reader. */
  readonly text: string;
}

/** The line under a doc's title: when, who, and what changed. */
export function kinDocChangeLine(change: Change, names: KinWorkNames, now: Date): KinDocChangeLine {
  const said = change.summary.replace(/\s+/g, " ").trim();
  // The host's own words for a new doc and for a restore repeat the verb: say each once.
  const restoredTo =
    change.kind === "restored" ? (/^restored (version \d+)$/i.exec(said)?.[1] ?? null) : null;
  const verb = restoredTo === null ? VERB[change.kind] : `${VERB.restored} ${restoredTo}`;
  const lead = `${verb} ${kinDocWhen(change.at, now)} by ${actorName(change.by, names, "you")}`;
  const summary =
    restoredTo !== null || (change.kind === "created" && said.toLowerCase() === "created")
      ? ""
      : said;
  return {
    lead,
    summary: summary === "" ? null : summary,
    text: summary === "" ? lead : `${lead} · ${summary}`,
  };
}

const changeOf = (version: KinDocVersion): Change => ({
  at: version.at,
  kind: version.kind,
  summary: version.summary,
  by: version.provenance.by,
});

/** The version before this one to compare with; null for a doc's first. */
export const kinDocPrevious = (version: Pick<KinDocVersion, "version">): number | null =>
  version.version > 1 ? version.version - 1 : null;

// The list

export interface KinDocRowView {
  readonly key: string;
  readonly title: string;
  readonly line: string;
  /** "Acme · Website relaunch", or null when it is linked to neither. */
  readonly under: string | null;
  readonly private: boolean;
  readonly archived: boolean;
  readonly accessibilityLabel: string;
}

export function kinDocRow(row: KinDocRow, names: KinWorkNames, now: Date): KinDocRowView {
  const { text } = kinDocChangeLine(changeOf(row.latest), names, now);
  const under = [row.party?.title, row.project?.title].filter(Boolean).join(" · ");
  const isPrivate = row.sensitive || row.sensitiveInherited === true;
  return {
    key: row.key,
    title: row.title,
    line: text,
    under: under === "" ? null : under,
    private: isPrivate,
    archived: row.archived,
    accessibilityLabel: [
      row.title,
      under === "" ? null : under,
      text,
      isPrivate ? "Private" : null,
      row.archived ? "Archived" : null,
    ]
      .filter(Boolean)
      .join(". "),
  };
}

export type KinDocGrouping = "client" | "project" | "agent";

export const KIN_DOC_GROUPINGS: ReadonlyArray<{
  readonly id: KinDocGrouping;
  readonly label: string;
}> = [
  { id: "client", label: "Client" },
  { id: "project", label: "Project" },
  { id: "agent", label: "Agent" },
];

export interface KinDocGroup {
  readonly id: string;
  readonly title: string;
  readonly rows: ReadonlyArray<KinDocRow>;
}

const NONE = "\u0000none";
const NO_GROUP: Record<KinDocGrouping, string> = {
  client: "No client",
  project: "No project",
  agent: "Nobody",
};

/**
 * The docs under their clients, projects or keepers. Groups run by name with the unlinked ones
 * last; inside a group the host's order stands, which is latest change first.
 */
export function kinDocGroups(
  rows: ReadonlyArray<KinDocRow>,
  by: KinDocGrouping,
  names: KinWorkNames,
): ReadonlyArray<KinDocGroup> {
  const groups = new Map<string, { title: string; rows: Array<KinDocRow> }>();
  for (const row of rows) {
    const ref = by === "client" ? row.party : by === "project" ? row.project : undefined;
    const id = by === "agent" ? kinWorkPrincipalKey(row.owner) : (ref?.key ?? NONE);
    const title =
      by === "agent" ? kinWorkName(row.owner, names, "You") : (ref?.title ?? NO_GROUP[by]);
    const held = groups.get(id);
    if (held === undefined) groups.set(id, { title, rows: [row] });
    else held.rows.push(row);
  }
  return [...groups.entries()]
    .map(([id, group]) => ({ id, ...group }))
    .sort((a, b) => (a.id === NONE ? 1 : b.id === NONE ? -1 : a.title.localeCompare(b.title)));
}

export interface KinDocsFilter {
  readonly archived: boolean;
  /** Words in a title or the latest text, matched by the host across every doc. */
  readonly text: string;
}
export const KIN_DOCS_DEFAULT_FILTER: KinDocsFilter = { archived: false, text: "" };
export const kinDocsSameFilter = (a: KinDocsFilter, b: KinDocsFilter) =>
  a.archived === b.archived && a.text.trim() === b.text.trim();

/** One page of the Docs list as the host is asked for it. */
export const kinDocsQuery = (orgId: KinOrgId, filter: KinDocsFilter) => ({
  orgId,
  archived: filter.archived,
  ...(filter.text.trim() === "" ? {} : { text: filter.text.trim() }),
});

export function kinDocsFooter(shown: number, total: number | null, more: boolean): string | null {
  if (!more || total === null) return null;
  return `Showing ${shown} of ${plural(total, "doc")}`;
}

// The reader

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface KinDocSectionText {
  readonly id: string;
  /** The heading's words; `KIN_DOCS.top` for the text before the first heading. */
  readonly title: string;
  readonly level: number;
  /** The section's own markdown, heading included. */
  readonly text: string;
  /** The line of the body its heading is on. */
  readonly line: number;
}

/**
 * The body cut where the host cut it: at every heading outside a code fence. Null when the cut
 * disagrees with the host's outline, so a caller shows the body whole instead of mislabelling
 * a section.
 */
export function kinDocSections(
  body: string,
  outline: ReadonlyArray<KinDocSection>,
): ReadonlyArray<KinDocSectionText> | null {
  const lines = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "").split("\n");
  const starts: Array<number> = [];
  let fence: string | undefined;
  lines.forEach((line, index) => {
    const opened = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length)
        fence = undefined;
      return;
    }
    if (opened !== undefined) fence = opened;
    else if (HEADING.test(line)) starts.push(index);
  });
  const headings = outline.filter((section) => section.id !== "top");
  if (headings.length !== starts.length) return null;
  const cut = (from: number, to: number) => lines.slice(from, to).join("\n");
  const top = cut(0, starts[0] ?? lines.length);
  const hasTop = outline[0]?.id === "top";
  if (hasTop !== (top.trim() !== "")) return null;
  return [
    ...(hasTop ? [{ id: "top", title: KIN_DOCS.top, level: 0, text: top, line: 0 }] : []),
    ...headings.map((section, index) => {
      const line = starts[index]!;
      return {
        id: section.id,
        title: section.title === "" ? "Untitled section" : section.title,
        level: section.level,
        text: cut(line, starts[index + 1] ?? lines.length),
        line,
      };
    }),
  ];
}

export interface KinDocOutlineRow {
  readonly id: string;
  readonly title: string;
  /** 0 for the shallowest heading in the doc, 1 for the next level down, and so on. */
  readonly depth: number;
}

/** The contents sheet: every section, indented from the doc's own shallowest heading. */
export function kinDocOutline(
  outline: ReadonlyArray<KinDocSection>,
): ReadonlyArray<KinDocOutlineRow> {
  const levels = outline.filter((section) => section.level > 0).map((section) => section.level);
  const base = levels.length === 0 ? 1 : Math.min(...levels);
  return outline.map((section) => ({
    id: section.id,
    title:
      section.id === "top"
        ? KIN_DOCS.top
        : section.title === ""
          ? "Untitled section"
          : section.title,
    depth: section.level === 0 ? 0 : Math.min(section.level - base, 3),
  }));
}

/** A long doc earns a contents button; a note with one heading doesn't. */
export const kinDocHasContents = (outline: ReadonlyArray<KinDocSection>) =>
  outline.filter((section) => section.id !== "top").length > 1;

/** Why a doc is marked private, in words; null when the whole team may read it. */
export const kinDocPrivacy = (
  doc: Pick<KinDocRow, "sensitive" | "sensitiveInherited">,
): string | null =>
  doc.sensitive
    ? KIN_DOCS.private
    : doc.sensitiveInherited === true
      ? KIN_DOCS.privateInherited
      : null;

export type KinDocReadState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "gone" }
  | { readonly _tag: "refused" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly doc: KinDocDetail; readonly stale: boolean };

export function kinDocExport(doc: Pick<KinDocDetail, "title" | "body" | "key">): {
  readonly filename: string;
  readonly text: string;
} {
  const slug = doc.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return { filename: `${slug === "" ? doc.key.toLowerCase() : slug}.md`, text: doc.body };
}

// Versions

export interface KinDocVersionView {
  readonly version: number;
  /** "Version 7", with "Current" for the latest. */
  readonly label: string;
  readonly current: boolean;
  readonly line: KinDocChangeLine;
  /** "Asked by you", when the agent was answering someone. */
  readonly asked: string | null;
  /** The version to compare it with; null for the first. */
  readonly previous: number | null;
  readonly accessibilityLabel: string;
}

export function kinDocVersionView(
  version: KinDocVersion,
  latest: number,
  names: KinWorkNames,
  now: Date,
): KinDocVersionView {
  const line = kinDocChangeLine(changeOf(version), names, now);
  const current = version.version === latest;
  const label = `Version ${version.version}`;
  const { answered } = version.provenance;
  const asked = answered === null ? null : `Asked by ${kinWorkName(answered.author, names, "you")}`;
  const restored =
    version.restoredFrom === null ? null : `Brought back version ${version.restoredFrom}`;
  return {
    version: version.version,
    label,
    current,
    line: restored !== null && line.summary === null ? { ...line, summary: restored } : line,
    asked,
    previous: kinDocPrevious(version),
    accessibilityLabel: [label, current ? "Current" : null, line.text, asked]
      .filter(Boolean)
      .join(". "),
  };
}

/** "1 section changed · 4 unchanged", from what the host says differs. */
export function kinDocDiffSummary(diff: KinDocDiff, sections: number): string {
  const changed = diff.changedSections.length;
  const removed = diff.removedSections.length;
  const unchanged = Math.max(sections - changed, 0);
  return [
    changed > 0 ? `${plural(changed, "section")} changed` : null,
    removed > 0 ? `${removed} removed` : null,
    `${unchanged} unchanged`,
    `${plural(diff.additions, "line")} added, ${diff.deletions} removed`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type KinDocRestoreOutcome =
  | { readonly _tag: "restored"; readonly doc: KinDocDetail }
  | { readonly _tag: "refused"; readonly text: string; readonly moved: boolean };

/** The host's answer to a restore, as the new latest version or a reason in words. */
export function kinDocRestoreOutcome(
  result: AtomCommandResult<KinDocDetail, unknown>,
): KinDocRestoreOutcome {
  if (AsyncResult.isSuccess(result)) return { _tag: "restored", doc: result.value };
  const error = squashAtomCommandFailure(result);
  if (isKinChatError(error) && error.reason === "conflict")
    return {
      _tag: "refused",
      moved: true,
      text: "An agent changed this doc while you were reading. Look at the latest version, then restore again if you still want to.",
    };
  if (kinWorkRefused(error))
    return {
      _tag: "refused",
      moved: false,
      text: "Only the person who runs this workspace can restore a version.",
    };
  if (isKinChatError(error) && error.reason === "not_found")
    return { _tag: "refused", moved: false, text: "That version isn't there any more." };
  return {
    _tag: "refused",
    moved: false,
    text: "Couldn't restore it. Check your connection and try again.",
  };
}

// Pointing at a part

export type KinDocAsk = "ask" | "change";

/** What a person pointed at, waiting above the composer of the chat it will be sent in. */
export interface KinPendingRef {
  readonly ref: KinMessageRef;
  readonly intent: KinDocAsk;
}

/** The doc, or one of its sections, at the version on screen. */
export function kinDocRef(
  doc: Pick<KinDocDetail, "key" | "title" | "version" | "outline">,
  sectionId: string | null,
): KinMessageRef {
  const section = sectionId === null ? undefined : doc.outline.find((s) => s.id === sectionId);
  return {
    _tag: "doc",
    key: doc.key,
    version: doc.version.version,
    section: section?.id ?? null,
    title: doc.title,
    sectionTitle:
      section === undefined ? null : section.id === "top" ? KIN_DOCS.top : section.title,
  };
}

/** "Launch plan › Pricing". */
export const kinDocRefLabel = (ref: Pick<KinMessageRef, "title" | "sectionTitle">): string =>
  ref.sectionTitle === null || ref.sectionTitle === ""
    ? ref.title
    : `${ref.title} › ${ref.sectionTitle}`;

export const kinDocRefInput = (ref: KinMessageRef): KinMessageRefInput => ({
  _tag: "doc",
  key: ref.key,
  version: ref.version,
  section: ref.section,
});

export const kinDocAskPlaceholder = (pending: KinPendingRef): string => {
  const about = pending.ref.sectionTitle ?? pending.ref.title;
  return pending.intent === "ask" ? `Ask about ${about}` : `Say what to change in ${about}`;
};

/** One waiting reference per chat, set where a doc is read and taken where the chat is typed. */
export const kinPendingRefAtom = Atom.family((chat: string) =>
  Atom.make<KinPendingRef | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`kin:pending-ref:${chat}`),
  ),
);

export const kinPendingRefKey = (environmentId: string, chatId: string) =>
  `${environmentId}\u0000${chatId}`;

/**
 * The chat to ask about a doc in: the viewer's own with the agent that keeps it, else with the
 * agent that last wrote it. Null when neither has one, such as a doc a person keeps.
 */
export function kinDocChat(
  chats: ReadonlyArray<KinChatSummary>,
  doc: { readonly owner: KinWorkPrincipal; readonly latest: KinDocVersion },
  me: KinPersonId | null,
): { readonly chatId: KinChatId; readonly agentId: string } | null {
  const by = doc.latest.provenance.by;
  const wanted = [doc.owner, by].flatMap((who) => (who._tag === "agent" ? [who.agentId] : []));
  for (const agentId of wanted) {
    const chat = chats.find(
      (held) =>
        held.kind === "direct" &&
        held.members.some(
          (member) => member.principal._tag === "agent" && member.principal.agentId === agentId,
        ) &&
        held.members.some(
          (member) =>
            member.principal._tag === "person" && (me === null || member.principal.personId === me),
        ),
    );
    if (chat !== undefined) return { chatId: chat.chatId, agentId };
  }
  return null;
}

// The card in chat

const decodeDocCard = Schema.decodeUnknownOption(KinDocCardState);

export interface KinDocCardView {
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly change: Change;
  /** The version before, for "See changes"; null for a new doc. */
  readonly previousVersion: number | null;
}

export function kinDocCardView(widget: KinWidget): KinDocCardView | null {
  const state = Option.getOrNull(decodeDocCard(widget.state));
  if (state === null) return null;
  return {
    key: state.key,
    title: state.title,
    version: state.version,
    change: state.change,
    previousVersion: state.previousVersion,
  };
}

/** A card names agents only, and the chat knows those by id. */
export function kinDocCardLine(
  card: KinDocCardView,
  agentNames: ReadonlyMap<string, string>,
  now: Date,
): KinDocChangeLine {
  return kinDocChangeLine(
    card.change,
    { people: new Map(), agents: agentNames, me: null, zone: null },
    now,
  );
}

// Search

const KIND_LABEL: Record<KinSearchKind, string> = {
  work: "Task",
  clients: "Client",
  contacts: "Contact",
  projects: "Project",
  docs: "Doc",
};

export interface KinSearchHitView {
  readonly id: string;
  readonly key: string;
  readonly kind: KinSearchKind;
  readonly kindLabel: string;
  readonly title: string;
  readonly snippet: string | null;
  /** The doc section the words are in, to open it there. */
  readonly section: { readonly id: string; readonly title: string } | null;
  readonly private: boolean;
  /** "Closed" for an entry, "Archived" for a doc; null while it is live. */
  readonly closed: string | null;
  readonly accessibilityLabel: string;
}

/** A snippet is a cut of the source: read as a line of prose, its markdown marks are noise. */
const snippetText = (snippet: string) =>
  snippet
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\s)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/g, "$1· ")
    .replace(/(^|[\s|]):?-{2,}:?(?=$|[\s|])/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:· )+/, "")
    .replace(/(?:· )+(?=·)/g, "")
    .trim();

export function kinSearchHit(hit: KinSearchHit): KinSearchHitView {
  const snippet = snippetText(hit.snippet);
  const section =
    hit.section === undefined || hit.section.id === "top"
      ? null
      : { id: hit.section.id, title: hit.section.title };
  const closed = !hit.closed ? null : hit.kind === "docs" ? "Archived" : "Closed";
  return {
    id: `${hit.recordId}:${hit.section?.id ?? ""}`,
    key: hit.key,
    kind: hit.kind,
    kindLabel: KIND_LABEL[hit.kind],
    title: hit.title,
    snippet: snippet === "" ? null : snippet,
    section,
    private: hit.sensitive,
    closed,
    accessibilityLabel: [
      `${KIND_LABEL[hit.kind]}: ${hit.title}`,
      section?.title ?? null,
      snippet === "" ? null : snippet,
      hit.sensitive ? "Private" : null,
      closed,
    ]
      .filter(Boolean)
      .join(". "),
  };
}

export interface KinSearchState {
  readonly text: string;
  readonly closed: boolean;
  /** Null before anything was asked. */
  readonly hits: ReadonlyArray<KinSearchHit> | null;
  /** The words `hits` answer. */
  readonly answered: string;
  readonly loading: boolean;
  readonly failed: boolean;
}

export const KIN_SEARCH_INITIAL: KinSearchState = {
  text: "",
  closed: false,
  hits: null,
  answered: "",
  loading: false,
  failed: false,
};

const KIN_SEARCH_TYPING_MS = 250;
const KIN_SEARCH_MAX = 200;

export const kinSearchNothing = (text: string) => ({
  title: "Nothing found",
  detail: `Nothing matches “${text.trim()}”. Try fewer or different words.`,
});

/**
 * One search box: asks once typing pauses, and only the latest words' answer is kept, so a slow
 * earlier answer never lands over a newer one.
 */
export function createKinSearch(options: {
  readonly read: (input: {
    readonly text: string;
    readonly closed: boolean;
  }) => Promise<AtomCommandResult<KinSearchResult, unknown>>;
  readonly onChange: (state: KinSearchState) => void;
  /** Runs `run` after `ms`; returns its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
}) {
  let state = KIN_SEARCH_INITIAL;
  let generation = 0;
  let cancel: (() => void) | null = null;
  const set = (patch: Partial<KinSearchState>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const ask = async () => {
    const mine = ++generation;
    const text = state.text.trim().slice(0, KIN_SEARCH_MAX);
    const result = await options.read({ text, closed: state.closed });
    if (mine !== generation) return;
    if (AsyncResult.isSuccess(result))
      set({ hits: result.value.hits, answered: text, loading: false, failed: false });
    else set({ loading: false, failed: true });
  };
  const queue = (ms: number) => {
    cancel?.();
    cancel = null;
    generation++;
    if (state.text.trim() === "") {
      set({ hits: null, answered: "", loading: false, failed: false });
      return;
    }
    set({ loading: true, failed: false });
    cancel = options.schedule(() => {
      cancel = null;
      void ask();
    }, ms);
  };
  return {
    setText: (text: string) => {
      if (text === state.text) return;
      set({ text });
      queue(KIN_SEARCH_TYPING_MS);
    },
    setClosed: (closed: boolean) => {
      if (closed === state.closed) return;
      set({ closed });
      queue(0);
    },
    retry: () => queue(0),
    dispose: () => {
      cancel?.();
      cancel = null;
      generation++;
    },
  };
}
