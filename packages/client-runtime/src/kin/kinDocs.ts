// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import { KIN_SCOPE_ALL, type KinViewerScope } from "./kinViewerScope.ts";
import { KIN_CHECK_CONNECTION, kinFailureText } from "./kinAnswers.ts";
import { kinIsDealKey } from "./kinDeals.ts";
import {
  KinDocCardState,
  type KinDocCardDraft,
  type KinChatId,
  type KinChatSummary,
  type KinDocDetail,
  type KinDocDiff,
  type KinDocEditSectionInput,
  type KinDocEmbed,
  type KinDocRenderInput,
  type KinDocFileInput,
  KIN_DOC_KINDS,
  type KinDocKind,
  type KinDocLatestSlim,
  type KinDocListRow,
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
  kinPlainBody,
  kinSalesLead,
  kinThreadLinksAsWords,
  kinWhenFormat,
} from "@t3tools/contracts";
import { kinDocBlockIndex, kinDocBlocks, kinDocParts } from "@t3tools/shared/kinDocBlocks";
import type { PhrasingContent, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import {
  isKinChatError,
  kinMidSentence,
  kinWorkName,
  kinWorkRefused,
  type KinWorkNames,
} from "./kinWork.ts";
import { kinCount } from "./kinCount.ts";
import { kinIsMine, type KinMineCount, type KinMineHeld } from "./kinWorkClients.ts";

export const KIN_DOCS = {
  earlierVersions: "Show earlier versions",
  oldVersion: (version: number, latest: number) =>
    `You're reading version ${version}. The latest is version ${latest}.`,
  openLatest: "Open the latest",
  changesFailed: "Couldn't load the changes",
  historyFailed: "Couldn't load the history",
  restoreOffline: "You're offline. Restore it when the connection is back.",
  restored: (version: number) => `Restored. This is now version ${version}, and nothing was lost.`,
  restoreDetail: (version: number | undefined) =>
    `The doc will read as it did at version ${version ?? ""}. Nothing is lost: the restore is saved as a new version, and you can undo it.`,
  noText: "This doc has no text yet.",
  title: "Docs",
  docsAndLists: "Docs and lists",
  which: "Which",
  search: "Search docs",
  searchWithLists: "Search docs and lists",
  loading: "Loading docs",
  loadFailed: "Couldn't load docs",
  archived: "Archived",
  current: "Current",
  contents: "Contents",
  history: "History",
  changes: "See changes",
  ask: "Ask about this",
  change: "Change this",
  suggest: "Suggest a change",
  copyLink: "Copy link",
  copied: "Link copied",
  copyText: "Copy text",
  textCopied: "Text copied",
  more: "More",
  sharePdf: "Share as PDF",
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
  editing: (section: string) => `Changing ${section}`,
  saved: (version: number) =>
    `Saved as version ${version}. The one before is in History, and can be restored.`,
  editMoved:
    "This section changed since you opened it, so your change wasn't saved. Copy what you wrote, then open the doc again.",
  editFailed: "Couldn't save your change.",
  editOffline: "You're offline. Save it when the connection is back; your text stays here.",
  discard: { title: "Discard your change?", keep: "Keep changing", confirm: "Discard" },
  export: "Export as Markdown",
  exportPdf: "Export PDF",
  exportingPdf: "Making the PDF…",
  exportPdfFailed: "Couldn't make the PDF.",
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
  noneMine: {
    title: "Nothing of yours yet",
    detail:
      "Docs you keep, and docs on the clients and projects you look after or are on, show here. Everyone has the rest.",
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
    detail: KIN_CHECK_CONNECTION,
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
  draft: "Draft",
  sendTo: (name: string) => `Send to ${name}`,
  sending: "Sending…",
  sentTo: (name: string) => `Sent to ${name} to approve.`,
  sentHeld: (name: string) => `Sent. ${name} gets it to approve when they're back.`,
  sendFailed: "Couldn't send it.",
  sendOffline: "You're offline. Send it when the connection is back.",
  noAccount: (service: string, by: string | null) =>
    `No ${service} account is connected. ${by === null ? "You can connect one in Settings on your computer." : `${by} can connect one on their computer.`}`,
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
  placeholder: "Search tasks, clients, docs and money",
  hint: {
    title: "Search everything",
    detail: "Tasks, clients, contacts, projects, docs and money, by any words in them.",
  },
  failed: "Couldn't search",
  includeClosed: "Include closed and archived",
} as const;

/** What the empty search box says it looks through: the owner level finds what memory keeps too. */
export const kinSearchHint = (scope: KinViewerScope) =>
  scope.all
    ? {
        title: KIN_SEARCH.hint.title,
        detail:
          "Tasks, clients, contacts, projects, docs, money, and the decisions your agents remember, by any words in them.",
      }
    : {
        title: KIN_SEARCH.hint.title,
        detail:
          "Tasks, clients, contacts, projects, docs and money you can see, by any words in them.",
      };

// When and who

const DAY_MS = 24 * 60 * 60 * 1000;
const clockFormat = kinWhenFormat("time");
const dayFormat = kinWhenFormat("date");
const dayYearFormat = kinWhenFormat("dateYear");
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
  const lead = `${verb} ${kinDocWhen(change.at, now)} by ${kinMidSentence(actorName(change.by, names, "you"))}`;
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

const changeOf = (version: KinDocVersion | KinDocLatestSlim): Change => ({
  at: version.at,
  kind: version.kind,
  summary: version.summary,
  by: version.provenance.by,
});

/** The version before this one to compare with; null for a doc's first. */
export const kinDocPrevious = (version: Pick<KinDocVersion, "version">): number | null =>
  version.version > 1 ? version.version - 1 : null;

// The list

/** What each kind reads as, on a row and in the filter. */
export const KIN_DOC_KIND_LABELS: Record<
  KinDocKind,
  { readonly one: string; readonly many: string }
> = {
  prd: { one: "PRD", many: "PRDs" },
  proposal: { one: "Proposal", many: "Proposals" },
  quote: { one: "Quote", many: "Quotes" },
  spec: { one: "Spec", many: "Specs" },
  notes: { one: "Notes", many: "Notes" },
  report: { one: "Report", many: "Reports" },
  playbook: { one: "Playbook", many: "Playbooks" },
  policy: { one: "Policy", many: "Policies" },
  other: { one: "Other", many: "Other docs" },
};

export const KIN_DOC_HOMES = {
  recent: "Recent",
  company: "Company",
  unfiled: "Unfiled",
  noClient: "No client",
  files: "Made files",
  file: "File",
  fileTitle: "File this doc",
  kind: "Kind",
  home: "Home",
  fileAll: "Ask to file these",
  fileAllMessage:
    "File every unfiled doc in Docs: give each its kind, and its client and project or the company.",
  unfiledDetail: "No client, project or company yet.",
  playbooks: "Playbooks",
  playbooksLine: (count: number) =>
    count === 1 ? "1 playbook your agents follow" : `${count} playbooks your agents follow`,
  lists: "Lists",
  seeAllLists: "See all lists",
  fewerLists: "Show fewer",
  filesDetail: "Invoices, receipts and exports also show on the record they were made for.",
} as const;

export interface KinDocRowView {
  readonly key: string;
  readonly title: string;
  readonly line: string;
  /** What we sell, pinned first in Docs. */
  readonly pinned: boolean;
  /** "Proposal", or null for one nobody gave a kind. */
  readonly kind: string | null;
  /** "Acme · Website relaunch", "Company", or null when it has no home. */
  readonly under: string | null;
  readonly unfiled: boolean;
  readonly private: boolean;
  readonly archived: boolean;
  readonly accessibilityLabel: string;
}

export const kinDocKindOf = (row: Pick<KinDocListRow, "kind">): KinDocKind => row.kind ?? "other";
export const kinDocUnfiled = (row: Pick<KinDocListRow, "party" | "project" | "company">) =>
  row.party === undefined && row.project === undefined && row.company !== true;

export function kinDocRow(row: KinDocListRow, names: KinWorkNames, now: Date): KinDocRowView {
  const { text } = kinDocChangeLine(changeOf(row.latest), names, now);
  const pinned = row.whatWeSell === true;
  const under =
    row.company === true
      ? KIN_DOC_HOMES.company
      : [row.party?.title, row.project?.title].filter(Boolean).join(" · ");
  const isPrivate = row.sensitive || row.sensitiveInherited === true;
  const kind = kinDocKindOf(row);
  const kindLabel = kind === "other" ? null : KIN_DOC_KIND_LABELS[kind].one;
  return {
    key: row.key,
    title: row.title,
    line: kindLabel === null ? text : `${kindLabel} · ${text}`,
    pinned,
    kind: kindLabel,
    under: under === "" ? null : under,
    unfiled: kinDocUnfiled(row),
    private: isPrivate,
    archived: row.archived,
    accessibilityLabel: [
      row.title,
      pinned ? KIN_WHAT_WE_SELL.pinned : null,
      kindLabel,
      under === "" ? KIN_DOC_HOMES.unfiled : under,
      text,
      isPrivate ? "Private" : null,
      row.archived ? "Archived" : null,
    ]
      .filter(Boolean)
      .join(". "),
  };
}

export interface KinDocHome {
  readonly id: string;
  readonly kind: "client" | "company" | "unfiled";
  readonly title: string;
  readonly rows: ReadonlyArray<KinDocListRow>;
}

const NO_PARTY = "\u0000project";
const RECENT_MAX = 4;

/**
 * Docs by home: each client with its projects' docs, most recently changed client first, then
 * the company's own, then the unfiled. Inside each, latest change first, What we sell before the
 * rest (`pinned`, read on its own, as a page may not hold it). `recent` is the last few changed,
 * shown above them once there are enough docs for them to be worth a strip.
 */
export function kinDocLibrary(
  rows: ReadonlyArray<KinDocListRow>,
  pinned: KinDocListRow | null = null,
): {
  readonly recent: ReadonlyArray<KinDocListRow>;
  readonly homes: ReadonlyArray<KinDocHome>;
  /** The company's playbooks, folded into one row until opened; by title. */
  readonly playbooks: ReadonlyArray<KinDocListRow>;
} {
  const latestFirst = kinDocsPinned(
    [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    pinned,
  );
  const clients = new Map<string, { title: string; rows: Array<KinDocListRow> }>();
  const company: Array<KinDocListRow> = [];
  const unfiled: Array<KinDocListRow> = [];
  const playbooks: Array<KinDocListRow> = [];
  for (const row of latestFirst) {
    if (kinDocKindOf(row) === "playbook" && row.party === undefined && row.project === undefined)
      playbooks.push(row);
    else if (row.company === true) company.push(row);
    else if (row.party !== undefined || row.project !== undefined) {
      const id = row.party?.key ?? NO_PARTY;
      const title = row.party?.title ?? KIN_DOC_HOMES.noClient;
      const held = clients.get(id);
      if (held === undefined) clients.set(id, { title, rows: [row] });
      else held.rows.push(row);
    } else unfiled.push(row);
  }
  return {
    recent:
      rows.length > RECENT_MAX * 3
        ? [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_MAX)
        : [],
    homes: [
      ...[...clients.entries()].map(([id, held]) => ({
        id: `client:${id}`,
        kind: "client" as const,
        title: held.title,
        rows: held.rows,
      })),
      ...(company.length === 0
        ? []
        : [
            {
              id: "company",
              kind: "company" as const,
              title: KIN_DOC_HOMES.company,
              rows: company,
            },
          ]),
      ...(unfiled.length === 0
        ? []
        : [
            {
              id: "unfiled",
              kind: "unfiled" as const,
              title: KIN_DOC_HOMES.unfiled,
              rows: unfiled,
            },
          ]),
    ],
    playbooks: [...playbooks].sort((a, b) => a.title.localeCompare(b.title)),
  };
}

/** The phone's Docs: an agent's character is changed on its page, so the list leaves it out. */
export const kinDocsOnPhone = <Row extends Pick<KinDocListRow, "character">>(
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> => rows.filter((row) => row.character !== true);

/**
 * The viewer's clients and projects for `kinIsMine`: the clients they look after among those read,
 * and the projects they lead or are on.
 */
export function kinDocsMineHeld(
  me: KinPersonId | null,
  clients: ReadonlyArray<{ readonly key: string; readonly owner: KinWorkPrincipal }>,
  projects: ReadonlyArray<{ readonly key: string }>,
): KinMineHeld {
  return {
    me,
    clients: new Set(
      clients
        .filter((one) => one.owner._tag === "person" && one.owner.personId === me)
        .map((one) => one.key),
    ),
    projects: new Set(projects.map((one) => one.key)),
  };
}

/**
 * Docs' Mine among the rows the list holds, and both sides' counts: exact once it holds every doc
 * the host has, "at least" before. Everyone is the same rows, so Mine never shows more.
 */
export function kinDocsMine<Row extends Parameters<typeof kinIsMine>[0]>(
  rows: ReadonlyArray<Row>,
  held: KinMineHeld,
  complete: boolean,
): {
  readonly mine: ReadonlyArray<Row>;
  readonly counts: { readonly mine: KinMineCount; readonly everyone: KinMineCount };
} {
  const mine = rows.filter((row) => kinIsMine(row, held));
  const atLeast = complete ? {} : { atLeast: true };
  return {
    mine,
    counts: { mine: { n: mine.length, ...atLeast }, everyone: { n: rows.length, ...atLeast } },
  };
}

/** The rows with What we sell first, once: `pinned` as read on its own, else the page's copy. */
export function kinDocsPinned(
  rows: ReadonlyArray<KinDocListRow>,
  pinned: KinDocListRow | null,
): Array<KinDocListRow> {
  const pin = pinned ?? rows.find((row) => row.whatWeSell === true) ?? null;
  return pin === null ? [...rows] : [pin, ...rows.filter((row) => row.recordId !== pin.recordId)];
}

/** What Docs shows: everything, one kind, a shelf, the unfiled, or the files made from recipes. */
export type KinDocsShow =
  | { readonly _tag: "all" }
  | { readonly _tag: "kind"; readonly kind: KinDocKind }
  | { readonly _tag: "company" }
  | { readonly _tag: "unfiled" }
  | { readonly _tag: "files" };

export interface KinDocsFilter {
  readonly archived: boolean;
  /** Words in a title or the latest text, matched by the host across every doc. */
  readonly text: string;
  readonly show: KinDocsShow;
}
export const KIN_DOCS_ALL: KinDocsShow = { _tag: "all" };
export const KIN_DOCS_DEFAULT_FILTER: KinDocsFilter = {
  archived: false,
  text: "",
  show: KIN_DOCS_ALL,
};
const showKey = (show: KinDocsShow) => (show._tag === "kind" ? `kind:${show.kind}` : show._tag);
export const kinDocsSameShow = (a: KinDocsShow, b: KinDocsShow) => showKey(a) === showKey(b);
export const kinDocsSameFilter = (a: KinDocsFilter, b: KinDocsFilter) =>
  a.archived === b.archived && a.text.trim() === b.text.trim() && kinDocsSameShow(a.show, b.show);

/** The shelf one tap from the top of Docs; the playbooks fold into their own row below. */
export const KIN_DOC_SHELVES: ReadonlyArray<{
  readonly label: string;
  readonly show: KinDocsShow;
}> = [{ label: KIN_DOC_HOMES.company, show: { _tag: "company" } }];

/** Every choice the Filter menu offers for what to show, in its order. */
export const KIN_DOCS_SHOWS: ReadonlyArray<{ readonly label: string; readonly show: KinDocsShow }> =
  [
    { label: "All docs", show: KIN_DOCS_ALL },
    { label: KIN_DOC_HOMES.company, show: { _tag: "company" } },
    { label: KIN_DOC_HOMES.unfiled, show: { _tag: "unfiled" } },
    ...KIN_DOC_KINDS.map((kind) => ({
      label: KIN_DOC_KIND_LABELS[kind].many,
      show: { _tag: "kind" as const, kind },
    })),
    { label: KIN_DOC_HOMES.files, show: { _tag: "files" } },
  ];

const showLabel = (show: KinDocsShow) =>
  KIN_DOCS_SHOWS.find((one) => kinDocsSameShow(one.show, show))?.label ?? null;

/** The one removable chip: what the filter narrows to, or null when it shows everything current. */
export function kinDocsChip(filter: KinDocsFilter): string | null {
  const shown = filter.show._tag === "all" ? null : showLabel(filter.show);
  const parts = [shown, filter.archived ? KIN_DOCS.archived : null].filter(Boolean);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** One page of the Docs list as the host is asked for it. */
export const kinDocsQuery = (orgId: KinOrgId, filter: KinDocsFilter) => ({
  orgId,
  archived: filter.archived,
  ...(filter.text.trim() === "" ? {} : { text: filter.text.trim() }),
  // Files made from recipes live on their record; they show here only when asked for.
  files: filter.show._tag === "files",
  ...(filter.show._tag === "kind" ? { kind: filter.show.kind } : {}),
  ...(filter.show._tag === "company" || filter.show._tag === "unfiled"
    ? { home: filter.show._tag }
    : {}),
});

// What we sell

export const KIN_WHAT_WE_SELL = {
  title: "What we sell",
  pinned: "Pinned",
  empty: {
    title: "Tell Kin what you sell",
    detail:
      "Your agents read this before they answer a customer, judge a prospect or plan a deal. Start from what you already have.",
  },
  startFailed: "Couldn't start What we sell.",
} as const;

export type KinWhatWeSellWay = "website" | "brochure" | "talk";

/** The empty state's three ways in, each opening the sales agent's chat with its first words. */
export const kinWhatWeSellWays = (
  agent: string,
): ReadonlyArray<{
  readonly way: KinWhatWeSellWay;
  readonly label: string;
  readonly draft: string;
}> => [
  {
    way: "website",
    label: "Send your website",
    draft: "Here's our website. Read what it says we sell and draft What we sell from it: ",
  },
  {
    way: "brochure",
    label: "Send a brochure or price list",
    draft: "Here's our brochure and price list. Draft What we sell from them.",
  },
  {
    way: "talk",
    label: `Tell ${agent} about it`,
    draft: "Let's write What we sell together. Ask me what you need, one question at a time.",
  },
];

/** The one read that finds What we sell for this viewer, whichever page of Docs holds it. */
export const kinWhatWeSellQuery = (orgId: KinOrgId) => ({
  orgId,
  whatWeSell: true,
  limit: 1,
  acceptSlimLatest: true,
});

/** Docs pins What we sell, or offers to start it, on the current docs, everything or the company's. */
export const kinWhatWeSellShown = (filter: KinDocsFilter) =>
  !filter.archived &&
  filter.text.trim() === "" &&
  (filter.show._tag === "all" || filter.show._tag === "company");

/** The agent whose chat the ways in open: the one the host makes keeper (`kinSalesLead`). */
export const kinWhatWeSellAgent = <
  Lead extends { readonly agentId: string; readonly domain: string; readonly retired?: unknown },
>(
  leads: ReadonlyArray<Lead>,
): Lead | null => kinSalesLead(leads.filter((lead) => lead.retired === undefined)) ?? null;

export function kinDocsFooter(shown: number, total: number | null, more: boolean): string | null {
  if (!more || total === null) return null;
  return `Showing ${shown} of ${kinCount(total, "doc")}`;
}

/** What the File sheet starts from, and what it sends. */
export interface KinDocFileDraft {
  readonly kind: KinDocKind;
  /** `company`, `none`, or a client's key. */
  readonly home: string;
  readonly project: string | null;
}
export const kinDocFileDraft = (
  row: Pick<KinDocListRow, "kind" | "company" | "party" | "project">,
): KinDocFileDraft => ({
  kind: kinDocKindOf(row),
  home: row.company === true ? "company" : (row.party?.key ?? "none"),
  project: row.project?.key ?? null,
});
export function kinDocFileInput(
  orgId: KinOrgId,
  row: Pick<KinDocListRow, "key" | "rev">,
  draft: KinDocFileDraft,
): KinDocFileInput {
  const company = draft.home === "company";
  return {
    orgId,
    key: row.key,
    rev: row.rev,
    kind: draft.kind,
    company,
    ...(company
      ? {}
      : {
          party: draft.home === "none" ? null : (draft.home as KinDocFileInput["key"]),
          project: draft.project as KinDocFileInput["key"] | null,
        }),
  };
}

// Copy text

const copyParser = unified().use(remarkParse).use(remarkGfm);

const inlineText = (nodes: ReadonlyArray<PhrasingContent>): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          return node.value;
        case "break":
          return "\n";
        case "image":
          return node.alt ?? "";
        case "html":
          return node.value.replace(/<[^>]*>/g, "");
        case "link": {
          const words = inlineText(node.children);
          return /^https?:/i.test(node.url) && words !== node.url && words !== ""
            ? `${words} (${node.url})`
            : words === ""
              ? node.url
              : words;
        }
        case "emphasis":
        case "strong":
        case "delete":
          return inlineText(node.children);
        default:
          return "";
      }
    })
    .join("");

const blockText = (node: RootContent): ReadonlyArray<string> => {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return [inlineText(node.children)];
    case "code":
      return [node.value];
    case "html":
      return [node.value.replace(/<[^>]*>/g, "")];
    case "blockquote":
      return node.children.flatMap(blockText);
    case "list":
      return [
        node.children
          .map((item, index) => {
            const lines = item.children.flatMap(blockText).filter((line) => line !== "");
            const number = node.ordered === true ? `${(node.start ?? 1) + index}. ` : "";
            return `${number}${lines.join("\n")}`;
          })
          .join("\n"),
      ];
    case "table":
      return [
        node.children
          .map((row) =>
            row.children.map((cell) => inlineText(cell.children).replace(/\s+/g, " ")).join("\t"),
          )
          .join("\n"),
      ];
    default:
      return [];
  }
};

/**
 * A doc's markdown as text to paste anywhere: no marks, a list's items one per line, a table's
 * rows as tab-separated cells, and its charts and visuals left out.
 */
export function kinDocCopyText(markdown: string): string {
  const tree = copyParser.parse(kinThreadLinksAsWords(kinPlainBody(markdown)));
  return tree.children
    .flatMap(blockText)
    .filter((block) => block.trim() !== "")
    .join("\n\n");
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
  doc: Pick<KinDocListRow, "sensitive" | "sensitiveInherited">,
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
    changed > 0 ? `${kinCount(changed, "section")} changed` : null,
    removed > 0 ? `${removed} removed` : null,
    `${unchanged} unchanged`,
    `${kinCount(diff.additions, "line")} added, ${diff.deletions} removed`,
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
  // A playbook version whose settings no longer hold says why in words meant for people.
  if (
    isKinChatError(error) &&
    error.reason === "invalid_state" &&
    !/[a-z]+_[a-z]+/.test(error.message)
  )
    return { _tag: "refused", moved: false, text: error.message };
  return { _tag: "refused", moved: false, text: kinFailureText(error, "Couldn't restore it.") };
}

// Changing a section by hand

/** Whether this reader changes the shown version's sections by hand: the host said so, on the latest. */
export const kinDocCanEdit = (
  doc: Pick<KinDocDetail, "editable" | "version" | "latest">,
): boolean =>
  doc.editable === true &&
  doc.version.version === doc.latest.version &&
  doc.version.file === undefined;

/**
 * A doc's one Change item, the same on web and phone: by hand, on its sections, where the host lets
 * this reader; else through the doc's agent, a suggestion below the owner level.
 */
export const kinDocChangeItem = (input: {
  readonly byHand: boolean;
  readonly ownerLevel: boolean;
}) =>
  input.byHand
    ? { by: "hand" as const, label: KIN_DOCS.change }
    : { by: "agent" as const, label: input.ownerLevel ? KIN_DOCS.change : KIN_DOCS.suggest };

/**
 * What a hand edit is opened on, taken all at once: the doc, the section, its hash and its text as
 * read then. The doc may refresh while the editor is open; the save still names what was opened,
 * so a newer change to that section is refused, and one to another section is not.
 */
export interface KinDocEditOpened {
  readonly key: KinDocDetail["key"];
  readonly section: string;
  readonly title: string;
  readonly hash: string;
  /** The section's markdown as opened, heading included: the editor's starting text. */
  readonly was: string;
}

/** The section to open for a hand edit, or null when the body and the outline disagree. */
export function kinDocEditOpen(
  doc: Pick<KinDocDetail, "key" | "body" | "outline">,
  section: string,
): KinDocEditOpened | null {
  const read = doc.outline.find((one) => one.id === section);
  const text = kinDocSections(doc.body, doc.outline)?.find((one) => one.id === section);
  return read === undefined || text === undefined
    ? null
    : { key: doc.key, section: read.id, title: text.title, hash: read.hash, was: text.text };
}

/** What the save sends: what was opened, never the doc as it reads now. */
export const kinDocEditInput = (
  orgId: KinOrgId,
  opened: KinDocEditOpened,
  text: string,
  clientRequestId: string,
): KinDocEditSectionInput => ({
  orgId,
  key: opened.key,
  section: opened.section,
  hash: opened.hash,
  text,
  clientRequestId,
});

export type KinDocEditOutcome =
  | { readonly _tag: "saved"; readonly doc: KinDocDetail }
  | { readonly _tag: "refused"; readonly text: string; readonly moved: boolean };

/** The host's answer to a hand edit: the new version, or why not in words, the typed text kept. */
export function kinDocEditOutcome(
  result: AtomCommandResult<KinDocDetail, unknown>,
): KinDocEditOutcome {
  if (AsyncResult.isSuccess(result)) return { _tag: "saved", doc: result.value };
  const error = squashAtomCommandFailure(result);
  if (isKinChatError(error) && error.reason === "conflict")
    return { _tag: "refused", moved: true, text: KIN_DOCS.editMoved };
  return {
    _tag: "refused",
    moved: false,
    text: kinFailureText(error, KIN_DOCS.editFailed, { gone: KIN_DOCS.gone.title }),
  };
}

// Pointing at a part

/** A teammate can't change a company doc; they suggest, and the agent asks the owner. */
export type KinDocAsk = "ask" | "change" | "suggest";

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
  return pending.intent === "ask"
    ? `Ask about ${about}`
    : pending.intent === "suggest"
      ? `Say what you'd change in ${about}. The owner decides.`
      : `Say what to change in ${about}`;
};

/** The line a teammate's suggestion starts with, ready in the box for them to finish. */
export const kinDocSuggestStarter = (ref: Pick<KinMessageRef, "title" | "sectionTitle">) =>
  `I'd like to suggest a change to ${kinDocRefLabel(ref)}: `;

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
  readonly orgId: KinOrgId;
  readonly widgetId: KinWidget["widgetId"];
  readonly chatId: KinChatId;
  readonly key: string;
  readonly title: string;
  readonly version: number;
  readonly change: Change;
  /** The version before, for "See changes"; null for a new doc. */
  readonly previousVersion: number | null;
  /** One draft an agent wrote, with its text and where it goes up; null for any other doc. */
  readonly draft: KinDocCardDraft | null;
}

export function kinDocCardView(widget: KinWidget): KinDocCardView | null {
  const state = Option.getOrNull(decodeDocCard(widget.state));
  if (state === null) return null;
  return {
    orgId: widget.orgId,
    widgetId: widget.widgetId,
    chatId: widget.chatId,
    draft: state.draft ?? null,
    key: state.key,
    title: state.title,
    version: state.version,
    change: state.change,
    previousVersion: state.previousVersion,
  };
}

/** What a draft's card offers its reader: the text to copy, Send to, and what Kin can't do. */
export interface KinDocCardDraftView {
  /** The draft as clean text, without the markdown marks (Copy text). */
  readonly copyText: string;
  /** The "Send to" button's label, or null when this reader has nothing to send up. */
  readonly sendTo: string | null;
  /** That it went up, and to whom, once sent. */
  readonly sent: string | null;
  /** Why Kin can't post it, and who can fix that. */
  readonly noAccount: string | null;
}

/**
 * A draft card for its reader: Copy text for everyone; Send to only for the teammate whose own
 * draft it is, until sent, while they may still write in that chat. The owner and a co-owner
 * have nothing to send up, so Copy text only.
 */
export function kinDocCardDraft(
  card: Pick<KinDocCardView, "draft">,
  ownerLevel: boolean,
  readOnly: boolean,
): KinDocCardDraftView | null {
  const { draft } = card;
  if (draft === null) return null;
  return {
    copyText: kinDocCopyText(draft.text),
    sendTo:
      draft.sendTo === undefined || draft.sent !== undefined || ownerLevel || readOnly
        ? null
        : KIN_DOCS.sendTo(draft.sendTo.name),
    sent:
      draft.sent === undefined
        ? null
        : draft.sent.held === true
          ? KIN_DOCS.sentHeld(draft.sent.name)
          : KIN_DOCS.sentTo(draft.sent.name),
    noAccount:
      draft.noAccount === undefined
        ? null
        : KIN_DOCS.noAccount(draft.noAccount.service, ownerLevel ? null : draft.noAccount.by.name),
  };
}

/** What a "Send to" tap came to: nothing to say once sent (the card says it), else why not. */
export function kinDocSendUpProblem(result: AtomCommandResult<unknown, unknown>): string | null {
  if (AsyncResult.isSuccess(result)) return null;
  return kinFailureText(squashAtomCommandFailure(result), KIN_DOCS.sendFailed, {
    gone: KIN_DOCS.gone.title,
  });
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
  invoices: "Invoice",
  quotes: "Quote",
  expenses: "Expense",
  receipts: "Receipt",
  memory: "Remembered",
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
  /** A contact's client, whose page opens for it; null for anything else or from an older host. */
  readonly clientKey: string | null;
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
  const text = snippetText(hit.snippet);
  const snippet = text === hit.title ? "" : text;
  const section =
    hit.section === undefined || hit.section.id === "top"
      ? null
      : { id: hit.section.id, title: hit.section.title };
  const closed = !hit.closed ? null : hit.kind === "docs" ? "Archived" : "Closed";
  const kindLabel = hit.kind === "work" && kinIsDealKey(hit.key) ? "Deal" : KIND_LABEL[hit.kind];
  return {
    id: `${hit.recordId}:${hit.section?.id ?? ""}`,
    key: hit.key,
    kind: hit.kind,
    kindLabel,
    title: hit.title,
    snippet: snippet === "" ? null : snippet,
    section,
    clientKey: hit.client ?? null,
    // Everything memory keeps is the owner level's; only an entry's own label reads as private.
    private: hit.sensitive && hit.kind !== "memory",
    closed,
    accessibilityLabel: [
      `${kindLabel}: ${hit.title}`,
      section?.title ?? null,
      snippet === "" ? null : snippet,
      hit.sensitive && hit.kind !== "memory" ? "Private" : null,
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
  /** Why the last search failed, said through `kinFailure`; null when it didn't. */
  readonly failed: { readonly cause: unknown } | null;
}

export const KIN_SEARCH_INITIAL: KinSearchState = {
  text: "",
  closed: false,
  hits: null,
  answered: "",
  loading: false,
  failed: null,
};

const KIN_SEARCH_TYPING_MS = 250;
const KIN_SEARCH_MAX = 200;

export const kinSearchNothing = (text: string, scope: KinViewerScope = KIN_SCOPE_ALL) => ({
  title: scope.all ? "Nothing found" : "Nothing you can see matches",
  detail: `Nothing ${scope.all ? "" : "you can see "}matches “${text.trim()}”. Try fewer or different words.`,
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
      set({ hits: result.value.hits, answered: text, loading: false, failed: null });
    else set({ loading: false, failed: { cause: result } });
  };
  const queue = (ms: number) => {
    cancel?.();
    cancel = null;
    generation++;
    if (state.text.trim() === "") {
      set({ hits: null, answered: "", loading: false, failed: null });
      return;
    }
    set({ loading: true, failed: null });
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

/** A text doc laid out as a PDF by the report recipe; null for a doc that is already a file. */
export function kinDocPdfInput(
  orgId: KinOrgId,
  doc: KinDocDetail,
  clientRequestId: string,
): KinDocRenderInput | null {
  if (doc.version.file !== undefined) return null;
  return { orgId, recipe: "report", doc: doc.key, title: doc.title.slice(0, 120), clientRequestId };
}
