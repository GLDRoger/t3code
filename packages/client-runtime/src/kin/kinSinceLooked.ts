// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KIN_RECORD_CHANGES_CAP,
  type KinDocDetail,
  type KinDocLatestSlim,
  type KinPersonId,
  type KinProjectPage,
  type KinRecordChange,
  type KinRecordComment,
  type KinRecordDetail,
  type KinRecordId,
  type KinRecordKey,
  type KinWorkActor,
  type KinWorkHistoryItem,
  kinWhenFormat,
  kinWhenParts,
} from "@t3tools/contracts";

import { kinWorkActorName, kinWorkChangeText, kinWorkName, type KinWorkNames } from "./kinWork.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_MAX = 80;
const TITLE_MAX = 48;

const weekdayFormat = kinWhenFormat("weekday", { zone: "UTC" });
const dateFormat = kinWhenFormat("date", { zone: "UTC" });
const dateYearFormat = kinWhenFormat("dateYear", { zone: "UTC" });

export type KinSinceLookedOpens =
  | { readonly kind: "history" }
  | { readonly kind: "diff"; readonly from: number; readonly to: number }
  | { readonly kind: "projectHistory" };

export interface KinSinceLookedView {
  /** "3 changes since Tuesday" or "50+ changes since 12 Nov". */
  readonly lead: string;
  /** Up to 3 named lines (2 when `more` is present). */
  readonly lines: ReadonlyArray<string>;
  /** "and 2 more" or "and many more", or null. */
  readonly more: string | null;
  /** The full one-line summary shown in secondary text. */
  readonly text: string;
  /** Summary variants from fullest to shortest, dropping whole trailing fragments and raising "and N more". */
  readonly variants: ReadonlyArray<string>;
  /** Where tapping the line navigates or scrolls. */
  readonly opens: KinSinceLookedOpens;
  /** Spoken label naming both the summary and what tapping opens. */
  readonly accessibilityLabel: string;
}

const civilDay = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

function dayInZone(date: Date, zone: string | null): Date {
  const local = civilDay(date.getFullYear(), date.getMonth() + 1, date.getDate());
  if (zone === null) return local;
  try {
    const part = kinWhenParts(date, zone);
    return civilDay(part.year, part.month, part.day);
  } catch {
    return local;
  }
}

/**
 * When the person last looked, in words relative to `now` on the reader's calendar:
 * "since earlier today", "since yesterday", "since Tuesday" (2–6 days back), or "since 12 Nov".
 */
export function kinSinceWhen(
  lookedAt: string,
  now: Date,
  names: Pick<KinWorkNames, "zone" | "readerZone">,
): string {
  const date = new Date(lookedAt);
  if (Number.isNaN(date.getTime())) return "since your last visit";
  const zone = names.readerZone ?? names.zone ?? null;
  const markDay = dayInZone(date, zone);
  const today = dayInZone(now, zone);
  const daysAgo = Math.round((today.getTime() - markDay.getTime()) / DAY_MS);
  if (daysAgo <= 0) return "since earlier today";
  if (daysAgo === 1) return "since yesterday";
  if (daysAgo <= 6) return `since ${weekdayFormat.format(markDay)}`;
  return markDay.getUTCFullYear() === today.getUTCFullYear()
    ? `since ${dateFormat.format(markDay)}`
    : `since ${dateYearFormat.format(markDay)}`;
}

const clamp = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

const isDirectByMe = (actor: KinWorkActor, me: KinPersonId | null): boolean =>
  me !== null && actor._tag === "person" && actor.personId === me;

type ChangeList = Parameters<typeof kinWorkChangeText>[3];
const KNOWN_LISTS: ReadonlySet<string> = new Set([
  "work",
  "clients",
  "contacts",
  "projects",
  "invoices",
  "receipts",
]);

const changeListOf = (list: string | undefined): ChangeList =>
  list !== undefined && KNOWN_LISTS.has(list) ? (list as ChangeList) : "work";

/** Who did a change when an agent acted for someone: for the reader, "<Agent>, for you"; for others, "<Person>, via <Agent>". */
function formatChangeText(
  change: KinRecordChange,
  names: KinWorkNames,
  now: Date,
  list: ChangeList,
  notesWord: string,
): string {
  const full = kinWorkChangeText(change, names, now, list, notesWord);
  if (change.by._tag !== "agent" || change.askedBy === undefined) return full;
  const actor = kinWorkActorName(change.by, names);
  if (!full.startsWith(`${actor} `)) return full;
  const rest = full.slice(actor.length + 1);
  if (change.askedBy === names.me) return `${actor}, for you, ${rest}`;
  const person = kinWorkName({ _tag: "person", personId: change.askedBy }, names);
  return `${person}, via ${actor}, ${rest}`;
}

function formatCommentText(comment: KinRecordComment, names: KinWorkNames): string {
  const actor = kinWorkActorName(comment.by, names);
  if (comment.by._tag === "agent" && comment.askedBy !== undefined) {
    if (comment.askedBy === names.me) return `${actor}, for you, commented`;
    const person = kinWorkName({ _tag: "person", personId: comment.askedBy }, names);
    return `${person}, via ${actor}, commented`;
  }
  return `${actor} commented`;
}

const DOC_FALLBACK_VERB: Record<KinDocLatestSlim["kind"], string> = {
  created: "wrote it",
  edited: "updated it",
  rewritten: "rewrote it",
  restored: "restored an earlier version",
};

function formatDocVersionText(version: KinDocLatestSlim, names: KinWorkNames): string {
  const actor = kinWorkActorName(version.provenance.by, names);
  const byAgentFor =
    version.provenance.by._tag === "agent" && version.askedBy !== undefined
      ? version.askedBy === names.me
        ? `${actor}, for you`
        : `${kinWorkName({ _tag: "person", personId: version.askedBy }, names)}, via ${actor}`
      : null;
  const who = byAgentFor ?? actor;
  const said = version.summary.replace(/\s+/g, " ").trim();
  const restoredTo =
    version.kind === "restored" ? (/^restored (version \d+)$/i.exec(said)?.[1] ?? null) : null;
  if (restoredTo !== null)
    return byAgentFor === null ? `${who} restored ${restoredTo}` : `${who}, restored ${restoredTo}`;
  if (said === "" || (version.kind === "created" && said.toLowerCase() === "created")) {
    const verb = DOC_FALLBACK_VERB[version.kind];
    return byAgentFor === null ? `${who} ${verb}` : `${who}, ${verb}`;
  }
  return `${who}: ${clamp(said, SUMMARY_MAX)}`;
}

function formatProjectItemText(
  item: KinWorkHistoryItem,
  projectKey: KinRecordKey,
  names: KinWorkNames,
  now: Date,
): string {
  const list = changeListOf(
    item.record.list === "milestones" || item.record.list === "goals" ? "work" : item.record.list,
  );
  const base = formatChangeText(item, names, now, list, "notes");
  if (item.record.key === projectKey) return base;
  const title = clamp(item.record.title, TITLE_MAX);
  return title === "" ? base : `${base} (${title})`;
}

const OPENS_LABEL: Record<KinSinceLookedOpens["kind"], string> = {
  history: "Open history.",
  diff: "Compare with the version you last saw.",
  projectHistory: "Open project history.",
};

interface CollapsedLine {
  readonly text: string;
  readonly count: number;
}

function collapseNeighbouringLines(lines: ReadonlyArray<string>): ReadonlyArray<CollapsedLine> {
  const runs: Array<{ readonly raw: string; count: number }> = [];
  for (const line of lines) {
    const prev = runs.at(-1);
    if (prev !== undefined && prev.raw === line) prev.count += 1;
    else runs.push({ raw: line, count: 1 });
  }
  return runs.map((run) => ({
    text: run.count > 1 ? `${run.raw} (${run.count})` : run.raw,
    count: run.count,
  }));
}

function buildView(input: {
  readonly lookedAt: string;
  readonly total: number;
  readonly capped: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly opens: KinSinceLookedOpens;
  readonly names: Pick<KinWorkNames, "zone" | "readerZone">;
  readonly now: Date;
}): KinSinceLookedView | null {
  if (input.total <= 0 || input.lines.length === 0) return null;
  const since = kinSinceWhen(input.lookedAt, input.now, input.names);
  const countLabel = input.capped
    ? `${input.total >= KIN_RECORD_CHANGES_CAP ? KIN_RECORD_CHANGES_CAP : input.total}+ changes`
    : `${input.total} ${input.total === 1 ? "change" : "changes"}`;
  const lead = `${countLabel} ${since}`;
  const runs = collapseNeighbouringLines(input.lines);
  const coveredByThree = runs.slice(0, 3).reduce((sum, run) => sum + run.count, 0);
  const overflow = input.capped || input.total > coveredByThree;
  const shownRuns = overflow ? runs.slice(0, 2) : runs.slice(0, 3);
  const shown = shownRuns.map((run) => run.text);
  const shownCount = shownRuns.reduce((sum, run) => sum + run.count, 0);
  const remaining = Math.max(0, input.total - shownCount);
  const more = input.capped ? "and many more" : remaining > 0 ? `and ${remaining} more` : null;
  const formatKept = (keep: number) => {
    const kept = shownRuns.slice(0, keep);
    const covered = kept.reduce((sum, run) => sum + run.count, 0);
    const unshown = Math.max(0, input.total - covered);
    const tail = input.capped ? "and many more" : unshown > 0 ? `and ${unshown} more` : null;
    const parts =
      tail === null ? kept.map((run) => run.text) : [...kept.map((run) => run.text), tail];
    return `${lead}: ${parts.join(" · ")}`;
  };
  const variants: Array<string> = [];
  for (let keep = shownRuns.length; keep >= 1; keep -= 1) {
    variants.push(formatKept(keep));
  }
  const text = variants[0]!;
  return {
    lead,
    lines: shown,
    more,
    text,
    variants,
    opens: input.opens,
    accessibilityLabel: `${text}. ${OPENS_LABEL[input.opens.kind]}`,
  };
}

/** Newest displayed ISO time on an entry, for `kin.work.looked`. Null on older hosts or keyed reads. */
export function kinEntryLookedUpTo(
  item: Pick<KinRecordDetail, "lookedAt" | "createdAt" | "updatedAt" | "changes" | "comments">,
): string | null {
  if (item.lookedAt === undefined) return null;
  let bestIso: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  const consider = (iso: string) => {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      bestIso = iso;
    }
  };
  consider(item.createdAt);
  consider(item.updatedAt);
  for (const change of item.changes) consider(change.at);
  for (const comment of item.comments ?? []) consider(comment.at);
  return bestIso;
}

/** What changed on a task, milestone or list entry since `pinnedLookedAt`. Null when nothing qualifies. */
export function kinEntrySinceLooked(
  item: Pick<KinRecordDetail, "list" | "changes" | "comments" | "olderComments">,
  pinnedLookedAt: string | null | undefined,
  names: KinWorkNames,
  now: Date,
): KinSinceLookedView | null {
  if (pinnedLookedAt == null) return null;
  const markMs = Date.parse(pinnedLookedAt);
  if (Number.isNaN(markMs)) return null;

  const list = changeListOf(item.list);
  const notesWord = item.list === undefined ? "brief" : "notes";
  const events: Array<{ readonly at: number; readonly order: number; readonly text: string }> = [];

  for (const change of item.changes) {
    const at = Date.parse(change.at);
    if (Number.isNaN(at) || at <= markMs) continue;
    if (isDirectByMe(change.by, names.me)) continue;
    events.push({
      at,
      order: change.seq,
      text: formatChangeText(change, names, now, list, notesWord),
    });
  }

  for (const comment of item.comments ?? []) {
    if (comment.removed !== undefined) continue;
    const at = Date.parse(comment.at);
    if (Number.isNaN(at) || at <= markMs) continue;
    if (isDirectByMe(comment.by, names.me)) continue;
    events.push({
      at,
      order: comment.seq,
      text: formatCommentText(comment, names),
    });
  }

  if (events.length === 0) return null;
  events.sort((a, b) => b.at - a.at || b.order - a.order);

  const oldestChange = item.changes.at(-1);
  const oldestComment = item.comments?.[0];
  const changesCapped =
    item.changes.length >= KIN_RECORD_CHANGES_CAP &&
    oldestChange !== undefined &&
    Date.parse(oldestChange.at) > markMs;
  const commentsCapped =
    item.olderComments === true &&
    oldestComment !== undefined &&
    Date.parse(oldestComment.at) > markMs;

  return buildView({
    lookedAt: pinnedLookedAt,
    total: events.length,
    capped: changesCapped || commentsCapped || events.length >= KIN_RECORD_CHANGES_CAP,
    lines: events.map((event) => event.text),
    opens: { kind: "history" },
    names,
    now,
  });
}

/** `upTo` for a doc, only when showing the current latest version on a host that tracks looks. */
export function kinDocLookedUpTo(
  doc: Pick<KinDocDetail, "lookedAt" | "version" | "latest">,
  options: { readonly isLatest: boolean },
): string | null {
  if (!options.isLatest || doc.lookedAt === undefined) return null;
  if (doc.version.version !== doc.latest.version) return null;
  return Number.isNaN(Date.parse(doc.version.at)) ? null : doc.version.at;
}

/** What changed on a doc since `pinnedLookedAt`, from the host's filtered `sinceLooked`. */
export function kinDocSinceLooked(
  doc: Pick<KinDocDetail, "version" | "latest">,
  pinnedLookedAt: string | null | undefined,
  sinceLooked: KinDocDetail["sinceLooked"],
  names: KinWorkNames,
  now: Date,
): KinSinceLookedView | null {
  if (pinnedLookedAt == null || sinceLooked === undefined) return null;
  if (sinceLooked.total <= 0 || sinceLooked.versions.length === 0) return null;
  const to = doc.latest.version;
  if (sinceLooked.from >= to) return null;
  // The doc's own Updated line already names `doc.version`, so a lone change for it would repeat it.
  if (
    sinceLooked.total === 1 &&
    sinceLooked.versions.length === 1 &&
    sinceLooked.versions[0]!.version === doc.version.version
  ) {
    return null;
  }
  return buildView({
    lookedAt: pinnedLookedAt,
    total: sinceLooked.total,
    capped: false,
    lines: sinceLooked.versions.map((version) => formatDocVersionText(version, names)),
    opens: { kind: "diff", from: sinceLooked.from, to },
    names,
    now,
  });
}

/** `upTo` for a project page (`asOf`), or null on older hosts / keyed reads. */
export function kinProjectLookedUpTo(
  page: Pick<KinProjectPage, "lookedAt" | "asOf">,
): string | null {
  if (page.lookedAt === undefined) return null;
  return Number.isNaN(Date.parse(page.asOf)) ? null : page.asOf;
}

/** What changed on a project since `pinnedLookedAt`, from the host's filtered `sinceLooked`. */
export function kinProjectSinceLooked(
  page: Pick<KinProjectPage, "project">,
  pinnedLookedAt: string | null | undefined,
  sinceLooked: KinProjectPage["sinceLooked"],
  names: KinWorkNames,
  now: Date,
): KinSinceLookedView | null {
  if (pinnedLookedAt == null || sinceLooked === undefined) return null;
  if (sinceLooked.total <= 0 || sinceLooked.items.length === 0) return null;
  return buildView({
    lookedAt: pinnedLookedAt,
    total: sinceLooked.total,
    capped: false,
    lines: sinceLooked.items.map((item) =>
      formatProjectItemText(item, page.project.key, names, now),
    ),
    opens: { kind: "projectHistory" },
    names,
    now,
  });
}

// Visit pinning: keeps the summary steady after `kin.work.looked` advances the server mark.

export interface KinPinnedEntryLook {
  readonly recordId: KinRecordId;
  readonly lookedAt: string | null;
}

export function pinEntryLookedAt(
  held: KinPinnedEntryLook | null,
  recordId: KinRecordId,
  lookedAt: string | null | undefined,
): KinPinnedEntryLook | null {
  if (lookedAt === undefined) return held?.recordId === recordId ? held : null;
  if (held !== null && held.recordId === recordId) return held;
  return { recordId, lookedAt };
}

export interface KinPinnedDocLook {
  readonly recordId: KinRecordId;
  readonly lookedAt: string | null;
  readonly lastMark: string | null;
  /** The last server `sinceLooked` seen, so repeated renders return the same reference. */
  readonly lastSinceLooked: KinDocDetail["sinceLooked"];
  /** Accumulated summary up to `lastMark` when `lastMark` moved past `lookedAt`. */
  readonly base: KinDocDetail["sinceLooked"];
  readonly sinceLooked: KinDocDetail["sinceLooked"];
}

function combineDocSinceLooked(
  base: KinDocDetail["sinceLooked"],
  incoming: KinDocDetail["sinceLooked"],
): KinDocDetail["sinceLooked"] {
  if (incoming === undefined || incoming.versions.length === 0) return base;
  if (base === undefined || base.versions.length === 0) return incoming;
  const seen = new Set(base.versions.map((v) => v.version));
  const added = incoming.versions.filter((v) => !seen.has(v.version));
  if (added.length === 0) return base;
  return {
    from: base.from,
    total: base.total + incoming.total,
    versions: [...added, ...base.versions].slice(0, 3),
  };
}

export function mergePinnedDocSinceLooked(
  held: KinPinnedDocLook | null,
  recordId: KinRecordId,
  lookedAt: string | null | undefined,
  sinceLooked: KinDocDetail["sinceLooked"],
): KinPinnedDocLook | null {
  if (lookedAt === undefined) return held?.recordId === recordId ? held : null;
  if (held === null || held.recordId !== recordId) {
    return {
      recordId,
      lookedAt,
      lastMark: lookedAt,
      lastSinceLooked: sinceLooked,
      base: sinceLooked,
      sinceLooked,
    };
  }
  if (held.lookedAt === null) return held;
  if (lookedAt === held.lastMark) {
    if (sinceLooked === held.lastSinceLooked) return held;
    if (lookedAt === held.lookedAt) {
      return { ...held, lastSinceLooked: sinceLooked, base: sinceLooked, sinceLooked };
    }
    return {
      ...held,
      lastSinceLooked: sinceLooked,
      sinceLooked: combineDocSinceLooked(held.base, sinceLooked),
    };
  }
  const prevMs = held.lastMark === null ? Number.NEGATIVE_INFINITY : Date.parse(held.lastMark);
  const nextMs = lookedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lookedAt);
  if (nextMs <= prevMs) return held;
  const nextBase = held.sinceLooked;
  return {
    ...held,
    lastMark: lookedAt,
    lastSinceLooked: sinceLooked,
    base: nextBase,
    sinceLooked: combineDocSinceLooked(nextBase, sinceLooked),
  };
}

export interface KinPinnedProjectLook {
  readonly recordId: KinRecordId;
  readonly lookedAt: string | null;
  readonly lastMark: string | null;
  /** The last server `sinceLooked` seen, so repeated renders return the same reference. */
  readonly lastSinceLooked: KinProjectPage["sinceLooked"];
  /** Accumulated summary up to `lastMark` when `lastMark` moved past `lookedAt`. */
  readonly base: KinProjectPage["sinceLooked"];
  readonly sinceLooked: KinProjectPage["sinceLooked"];
}

function combineProjectSinceLooked(
  base: KinProjectPage["sinceLooked"],
  incoming: KinProjectPage["sinceLooked"],
): KinProjectPage["sinceLooked"] {
  if (incoming === undefined || incoming.items.length === 0) return base;
  if (base === undefined || base.items.length === 0) return incoming;
  const seen = new Set(base.items.map((item) => item.seq));
  const added = incoming.items.filter((item) => !seen.has(item.seq));
  if (added.length === 0) return base;
  return {
    total: base.total + incoming.total,
    items: [...added, ...base.items].slice(0, 3),
  };
}

export function mergePinnedProjectSinceLooked(
  held: KinPinnedProjectLook | null,
  recordId: KinRecordId,
  lookedAt: string | null | undefined,
  sinceLooked: KinProjectPage["sinceLooked"],
): KinPinnedProjectLook | null {
  if (lookedAt === undefined) return held?.recordId === recordId ? held : null;
  if (held === null || held.recordId !== recordId) {
    return {
      recordId,
      lookedAt,
      lastMark: lookedAt,
      lastSinceLooked: sinceLooked,
      base: sinceLooked,
      sinceLooked,
    };
  }
  if (held.lookedAt === null) return held;
  if (lookedAt === held.lastMark) {
    if (sinceLooked === held.lastSinceLooked) return held;
    if (lookedAt === held.lookedAt) {
      return { ...held, lastSinceLooked: sinceLooked, base: sinceLooked, sinceLooked };
    }
    return {
      ...held,
      lastSinceLooked: sinceLooked,
      sinceLooked: combineProjectSinceLooked(held.base, sinceLooked),
    };
  }
  const prevMs = held.lastMark === null ? Number.NEGATIVE_INFINITY : Date.parse(held.lastMark);
  const nextMs = lookedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lookedAt);
  if (nextMs <= prevMs) return held;
  const nextBase = held.sinceLooked;
  return {
    ...held,
    lastMark: lookedAt,
    lastSinceLooked: sinceLooked,
    base: nextBase,
    sinceLooked: combineProjectSinceLooked(nextBase, sinceLooked),
  };
}
