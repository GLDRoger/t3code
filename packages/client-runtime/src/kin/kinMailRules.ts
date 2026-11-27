import {
  EnvironmentAuthorizationError,
  formatKinWhen,
  KIN_MAIL_RULE_CARD_ACTIONS,
  KinChatError,
  KinMailRuleCardState,
  KIN_MAIL_RULE_CLASS_NAMES,
  kinMailRuleMatchLine,
  kinMailRuleSenderWords,
  kinWhenParts,
  type EnvironmentId,
  type KinMailRule,
  type KinMailRuleHistory,
  type KinMailRuleHoldReason,
  type KinMailRulePreview,
  type KinMailRuleRef,
  type KinMailRuleRunNow,
  type KinMailRulesListInput,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinQueryAtomFamily, createKinRpcCommand, type KinPermission } from "./kinAccess.ts";
import { KIN_CHECK_CONNECTION, kinFailureText } from "./kinAnswers.ts";
import { kinListSend } from "./kinLists.ts";
import type { AtomCommandResult } from "../state/runtime.ts";
import type { kinGuardedRead } from "./kinClient.ts";
import { createKinCardActions, type KinCardStatus } from "./kinDeferralPresentation.ts";
import { kinHostLacksCall } from "./kinHost.ts";
import { createKinRefreshTriggers } from "./kinRefresh.ts";
import { kinSentences } from "./kinScreenState.ts";

/**
 * Mail rules under a company mailbox in Settings → Connections, said once for web and phone.
 * A rule is made only from a lead's card in chat, so nothing here writes one.
 */

type KinMailRuleState = KinMailRule["state"];
type KinMailRuleEntry = KinMailRuleHistory["entries"][number];

/** Where a rule's times are read: the reader's zone and locale; the device's own when left out. */
export interface KinMailRuleWords {
  readonly zone?: string | undefined;
  readonly locale?: string | undefined;
}

/** A lead a rule may name, as `kin.leads.list` (with retired ones) sends it. */
export interface KinMailRuleLead {
  readonly agentId: string;
  readonly name: string;
  /** Present, or true, for a retired one. */
  readonly retired?: unknown;
}

/** What Settings calls. A rule is made only from its card in chat, so `create` isn't here. */
export const KIN_MAIL_RULE_METHODS = {
  list: "kin.mailRules.list",
  pause: "kin.mailRules.pause",
  resume: "kin.mailRules.resume",
  remove: "kin.mailRules.remove",
  history: "kin.mailRules.history",
  preview: "kin.mailRules.preview",
  runNow: "kin.mailRules.runNow",
} as const;

export const KIN_MAIL_RULES = {
  title: "Rules",
  description: "When mail like this arrives here, a lead does what its rule says.",
  loading: "Loading mail rules",
  loadFailed: "Couldn't load mail rules.",
  emptyTitle: "No rules yet",
  empty: "A lead proposes a rule when you ask for one in chat, and a tap on its card turns it on.",
  /** The phone's list of every mailbox's rules, and its row in Settings. */
  allTitle: "Mail rules",
  allDescription: "What leads do when mail like this arrives in a company mailbox.",
  open: "Open rule",
  pause: "Pause",
  resume: "Resume",
  remove: "Remove",
  pauseFailed: "Couldn't pause it.",
  resumeFailed: "Couldn't resume it.",
  removeFailed: "Couldn't remove it.",
  removeTitle: "Remove this mail rule?",
  removeDetail: "It won't run again. To have it back, ask a lead in chat to set it up again.",
  removeConfirm: "Remove rule",
  resumeTitle: "Resume this mail rule?",
  resumeDetail: (lead: string) =>
    `From now on it runs for you, and its runs post in your chat with ${lead}.`,
  resumeChoose:
    "Choose the lead that runs it from now on. Its runs post in your chat with that lead.",
  resumeNoLeads: "There's no active lead to run it. Add or restore a lead first.",
  leadLabel: "Lead",
  changedTitle: "Changed outside Kin",
  pageWhat: "What the lead is asked to do",
  facts: {
    mailbox: "Mailbox",
    from: "From",
    subjectHas: "Subject has",
    withFile: "With a file",
    kinds: "Kinds of mail",
    lead: "Lead",
    setBy: "Set by",
    created: "Created",
    limit: "Monthly limit",
  },
  anyone: "Anyone",
  anySubject: "Any subject",
  fileNeeded: "Yes",
  fileNotNeeded: "Not needed",
  anyKind: "Any kind",
  goneLead: "A lead no longer here",
  goneSetter: "Someone no longer on the team",
  retired: (name: string) => `${name} (retired)`,
  capLine: (cap: number) =>
    cap === 1 ? "Runs at most once a month" : `Runs at most ${cap} times a month`,
  limitLine: (cap: number, fired: number) => `${KIN_MAIL_RULES.capLine(cap)} · ${fired} this month`,
  counts: (fired: number, cap: number) => `${fired} of ${cap} this month`,
  lastRan: (when: string) => `last ran ${when}`,
  neverRan: "hasn't run yet",
  states: {
    on: "On",
    atLimit: "At its limit",
    paused: "Paused",
    changed: "Won't run",
    proposed: "Not on yet",
    removed: "Removed",
  },
  heldUntil: (day: string) => `Held until ${day}: its monthly limit.`,
  pausedWhy: {
    person: "Paused by the owner or a co-owner.",
    left: (setter: string) =>
      setter === ""
        ? "Paused because the person who set it up left the team."
        : `Paused because ${setter} left the team.`,
    mailbox: "Paused because this mailbox was disconnected.",
    agent: (lead: string | null) =>
      `Paused because ${lead ?? "its lead"} was retired. Choose a lead to resume it.`,
    unknown: "Paused.",
  },
  changed:
    "This mail rule was changed outside Kin, so it won't run. Remove it and set it up again.",
  proposed: "It waits for a tap on Turn on in chat.",
  historyTitle: "Runs in the last 30 days",
  historyEmpty: "No mail has matched this rule in the last 30 days.",
  historyFailed: "Couldn't load its runs.",
  historyShowAll: (count: number) => `Show all ${count}`,
  unknownSender: "Unknown sender",
  happened: {
    running: "Running",
    ran: "Ran",
    draft: "Drafted a reply; the card waits for you",
    task: (key: string | null) => (key === null ? "Made a task" : `Made task ${key}`),
    filed: (key: string | null) => (key === null ? "Filed it" : `Filed ${key}`),
    nothing: "Nothing needed doing",
    batched: "Joined a run with mail from the same 10 minutes",
    held_cap: "Held: limit reached",
    held_unverified: "Held: sender not verified",
    held_paused: "Held: paused",
  },
  /** Why a matched mail didn't run, one sentence per reason the host records. */
  heldBecause: {
    paused: "Held: the rule was paused",
    removed: "Held: the rule was removed",
    setter_left: "Held: the person who set it up left the team",
    setter_demoted: "Held: the person who set it up is no longer an owner or co-owner",
    mailbox_unavailable: "Held: the mailbox was no longer connected",
    destination_unavailable: "Held: its lead or chat was no longer available",
    wording_changed: "Held: the rule was changed outside Kin",
    monthly_limit: "Held: limit reached",
    sender_unverified: "Held: sender not verified",
  } satisfies Record<KinMailRuleHoldReason, string>,
  /** What a run did, from what Kin saw it post. */
  ranAnd: {
    posted_message: "Ran: the lead answered in the rule's chat",
    raised_card: "Ran: a card waits for a tap",
    nothing: "Nothing needed doing",
  },
  gap: (from: string, to: string) => `Kin couldn't see mail between ${from} and ${to}`,
  previewTitle: "What would have matched in the last 30 days",
  previewDescription: "Checks recent mail against this rule. Nothing runs and nothing is sent.",
  preview: "Preview",
  previewing: "Checking recent mail",
  previewFailed: "Couldn't check recent mail.",
  previewEmpty: "No mail in the last 30 days would have matched.",
  previewChecked: "Subject words checked on the latest 200.",
  previewPartial: "Subject words checked on the latest 200, so older mail may be missing.",
  wouldHave: {
    match: "Would have run",
    held_cap: "Would have waited: monthly limit",
    held_unverified: "Would have been held: sender not verified",
  },
  runNowTitle: "Run now",
  runNowDescription: "Runs it once on the newest mail it matches, even past its monthly limit.",
  runNow: "Run now",
  running: "Looking for mail",
  runNowFailed: "Couldn't run it.",
  runNowDone: "Queued. The lead answers in the chat where this rule's runs post.",
  runNowNothing: "Nothing ran.",
  actionsTitle: "Pause or remove",
  pageTitle: "Mail rule",
  matchesTitle: "What it matches",
  gone: "Kin can't find that mail rule. It may have been removed.",
  backToMailbox: "Back to the mailbox",
  previewIdle: "Preview shows which mail would have matched.",
  pauseRow: "Stops it until it's resumed. Mail it matches meanwhile shows in its runs as held.",
  resumeRow: "Turns it on again. From then on it runs for you.",
  removeRow: "Stops it for good.",
  goneMailbox: "A mailbox no longer connected",
  notHere: "Mail rules aren't available here.",
} as const;

const MAX_WHAT_ON_LIST = 140;

/** "a", "a or b", "a, b or c". */
const orList = (items: ReadonlyArray<string>) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const quoted = (phrases: ReadonlyArray<string>) => orList(phrases.map((phrase) => `“${phrase}”`));

/** The list's shortened words, cut at a word edge; a rule's page shows them whole. */
export function kinMailRuleWhatShort(what: string): string {
  const flat = what.trim().replace(/\s+/g, " ");
  if (flat.length <= MAX_WHAT_ON_LIST) return flat;
  const cut = flat.slice(0, MAX_WHAT_ON_LIST);
  const edge = cut.lastIndexOf(" ");
  return `${(edge > 0 ? cut.slice(0, edge) : cut).trimEnd()}…`;
}

const zoneOf = (words: KinMailRuleWords) =>
  words.zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (at: number, words: KinMailRuleWords) =>
  formatKinWhen(at, "dateTime", { zone: zoneOf(words), locale: words.locale });
const day = (at: number, now: number, words: KinMailRuleWords) => {
  const zone = zoneOf(words);
  const style = kinWhenParts(at, zone).year === kinWhenParts(now, zone).year ? "date" : "dateYear";
  return formatKinWhen(at, style, { zone, locale: words.locale });
};
/** "1 Dec": the first of the month after a rule's `YYYY-MM`. */
const firstOfNextMonth = (month: string, words: KinMailRuleWords) => {
  const [year, number] = month.split("-").map((part) => Number.parseInt(part, 10));
  return formatKinWhen(Date.UTC(year ?? 1970, number ?? 1, 1, 12), "date", {
    zone: "UTC",
    locale: words.locale,
  });
};

const leadOf = (leads: ReadonlyArray<KinMailRuleLead>, agentId: string) =>
  leads.find((lead) => lead.agentId === agentId) ?? null;
const isRetired = (lead: KinMailRuleLead) => lead.retired !== undefined && lead.retired !== false;

export interface KinMailRuleStateView {
  readonly label: string;
  /** `ok` says nothing beside the row; the others are its badge or quiet text. */
  readonly tone: "ok" | "quiet" | "attention" | "error";
  readonly detail: string | null;
  /** Resume must ask which lead: its own retired, or is gone. */
  readonly needsLead: boolean;
}

/** A rule's state in words: on, held at its limit, paused and why, or changed outside Kin. */
export function kinMailRuleState(
  rule: KinMailRule,
  options: {
    readonly leads: ReadonlyArray<KinMailRuleLead>;
    readonly words?: KinMailRuleWords | undefined;
  },
): KinMailRuleStateView {
  const copy = KIN_MAIL_RULES;
  if (rule.wordingChanged || rule.match === null)
    return { label: copy.states.changed, tone: "error", detail: copy.changed, needsLead: false };
  const state: KinMailRuleState = rule.state;
  if (state === "proposed")
    return { label: copy.states.proposed, tone: "quiet", detail: copy.proposed, needsLead: false };
  if (state === "removed")
    return { label: copy.states.removed, tone: "quiet", detail: null, needsLead: false };
  if (state === "on") {
    if (!rule.atLimit) return { label: copy.states.on, tone: "ok", detail: null, needsLead: false };
    return {
      label: copy.states.atLimit,
      tone: "attention",
      detail: copy.heldUntil(firstOfNextMonth(rule.month, options.words ?? {})),
      needsLead: false,
    };
  }
  const lead = leadOf(options.leads, rule.agentId);
  const needsLead = rule.pausedWhy === "agent" || lead === null || isRetired(lead);
  const why = copy.pausedWhy;
  const detail =
    rule.pausedWhy === "person"
      ? why.person
      : rule.pausedWhy === "left"
        ? why.left(rule.setterName.trim())
        : rule.pausedWhy === "mailbox"
          ? why.mailbox
          : rule.pausedWhy === "agent"
            ? why.agent(lead?.name ?? null)
            : why.unknown;
  return { label: copy.states.paused, tone: "quiet", detail, needsLead };
}

const leadName = (leads: ReadonlyArray<KinMailRuleLead>, agentId: string) =>
  leadOf(leads, agentId)?.name ?? KIN_MAIL_RULES.goneLead;

export interface KinMailRuleRowView {
  readonly ruleId: string;
  /** What it matches. */
  readonly title: string;
  /** Which lead, and what it is asked to do, shortened at a word edge. */
  readonly does: string;
  readonly counts: string;
  readonly state: KinMailRuleStateView;
}

/** One line per rule under its mailbox. */
export function kinMailRuleRowView(
  rule: KinMailRule,
  options: {
    readonly leads: ReadonlyArray<KinMailRuleLead>;
    readonly now: number;
    readonly words?: KinMailRuleWords | undefined;
  },
): KinMailRuleRowView {
  const words = options.words ?? {};
  const copy = KIN_MAIL_RULES;
  return {
    ruleId: rule.ruleId,
    title: kinMailRuleMatchLine(rule.match),
    does: `${leadName(options.leads, rule.agentId)}: ${kinMailRuleWhatShort(rule.what)}`,
    counts: `${copy.counts(rule.fired, rule.monthlyCap)} · ${
      rule.lastWakeAt === null ? copy.neverRan : copy.lastRan(when(rule.lastWakeAt, words))
    }`,
    state: kinMailRuleState(rule, { leads: options.leads, words }),
  };
}

export interface KinMailRulePageView {
  readonly title: string;
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  /** The instruction whole, as the setter's card had it. */
  readonly what: string;
  readonly state: KinMailRuleStateView;
}

/** One rule's own page: its filters, the lead, who set it and when, and its limit. */
export function kinMailRulePageView(
  rule: KinMailRule,
  options: {
    readonly leads: ReadonlyArray<KinMailRuleLead>;
    /** The mailbox's address, as its row on Connections says it. */
    readonly mailbox: string;
    readonly now: number;
    readonly words?: KinMailRuleWords | undefined;
  },
): KinMailRulePageView {
  const copy = KIN_MAIL_RULES;
  const words = options.words ?? {};
  const match = rule.wordingChanged ? null : rule.match;
  const lead = leadOf(options.leads, rule.agentId);
  const facts = [
    { label: copy.facts.mailbox, value: options.mailbox },
    ...(match === null
      ? []
      : [
          {
            label: copy.facts.from,
            value:
              match.from.length === 0
                ? copy.anyone
                : orList(match.from.map((sender) => kinMailRuleSenderWords(sender))),
          },
          {
            label: copy.facts.subjectHas,
            value: match.subjectHas.length === 0 ? copy.anySubject : quoted(match.subjectHas),
          },
          {
            label: copy.facts.withFile,
            value: match.withFile === true ? copy.fileNeeded : copy.fileNotNeeded,
          },
          {
            label: copy.facts.kinds,
            value:
              match.classes === null
                ? copy.anyKind
                : capitalize(orList(match.classes.map((one) => KIN_MAIL_RULE_CLASS_NAMES[one]))),
          },
        ]),
    {
      label: copy.facts.lead,
      value: lead === null ? copy.goneLead : isRetired(lead) ? copy.retired(lead.name) : lead.name,
    },
    { label: copy.facts.setBy, value: rule.setterName.trim() || copy.goneSetter },
    { label: copy.facts.created, value: day(rule.createdAt, options.now, words) },
    { label: copy.facts.limit, value: copy.limitLine(rule.monthlyCap, rule.fired) },
  ];
  return {
    title: kinMailRuleMatchLine(match),
    facts,
    what: rule.what,
    state: kinMailRuleState(rule, { leads: options.leads, words }),
  };
}

export interface KinMailRulePermissions {
  /** False for a teammate: the block is not drawn at all. */
  readonly visible: boolean;
  /** The viewer's level is known and allows the list. */
  readonly ready: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly remove: boolean;
  readonly history: boolean;
  readonly preview: boolean;
  readonly runNow: boolean;
}

/** What the guarded commands' permission atoms allow; the host stays the authority. */
export function kinMailRulePermissions(input: {
  readonly list: KinPermission;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly remove: boolean;
  readonly history: boolean;
  readonly preview: boolean;
  readonly runNow: boolean;
}): KinMailRulePermissions {
  const visible = input.list !== "refused";
  const ready = input.list === "granted";
  return {
    visible,
    ready,
    pause: ready && input.pause,
    resume: ready && input.resume,
    remove: ready && input.remove,
    history: ready && input.history,
    preview: ready && input.preview,
    runNow: ready && input.runNow,
  };
}

export interface KinMailRuleActions {
  readonly open: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly remove: boolean;
  readonly runNow: boolean;
  readonly preview: boolean;
  readonly history: boolean;
}

/**
 * What one rule offers: what the viewer may do and what the host would accept for its state. A
 * rule changed outside Kin can still be stopped, never run or looked into.
 */
export function kinMailRuleActions(
  rule: KinMailRule,
  can: KinMailRulePermissions,
): KinMailRuleActions {
  const sound = !rule.wordingChanged && rule.match !== null;
  const runnable = rule.state === "on" || rule.state === "paused";
  return {
    open: can.ready,
    pause: can.pause && rule.state === "on",
    resume: can.resume && sound && rule.state === "paused",
    remove: can.remove && rule.state !== "removed",
    runNow: can.runNow && sound && runnable,
    preview: can.preview && sound,
    history: can.history && sound,
  };
}

export type KinMailRulesBlock =
  /** A teammate, or a host that predates mail rules: nothing is drawn. */
  | { readonly _tag: "absent" }
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed"; readonly text: string }
  | { readonly _tag: "empty" }
  | { readonly _tag: "ready"; readonly rules: ReadonlyArray<KinMailRule> };

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The Rules block from its permission and its list read. */
export function kinMailRulesRead(
  permission: KinPermission,
  result: AsyncResult.AsyncResult<{ readonly rules: ReadonlyArray<KinMailRule> }, unknown>,
): KinMailRulesBlock {
  if (permission === "refused") return { _tag: "absent" };
  if (permission === "failed")
    return { _tag: "failed", text: `${KIN_MAIL_RULES.loadFailed} ${KIN_CHECK_CONNECTION}` };
  if (permission === "unknown" || result._tag === "Initial") return { _tag: "loading" };
  if (result._tag === "Success")
    return result.value.rules.length === 0
      ? { _tag: "empty" }
      : { _tag: "ready", rules: result.value.rules };
  if (kinHostLacksCall(result.cause)) return { _tag: "absent" };
  const error = Cause.squash(result.cause);
  if (isAuthorizationError(error) || (isChatError(error) && error.reason === "not_allowed"))
    return { _tag: "absent" };
  return { _tag: "failed", text: kinFailureText(result.cause, KIN_MAIL_RULES.loadFailed) };
}

export interface KinMailRuleLineView {
  readonly key: string;
  readonly title: string;
  readonly detail: string | null;
  readonly tone: "ok" | "attention";
}

const recordKey = (refs: unknown): string | null => {
  if (typeof refs !== "object" || refs === null || !("records" in refs)) return null;
  const records = refs.records;
  if (!Array.isArray(records)) return null;
  for (const record of records) {
    if (typeof record === "object" && record !== null && "key" in record) {
      const key = record.key;
      if (typeof key === "string" && key.trim() !== "") return key.trim();
    }
  }
  return null;
};

function happened(entry: Extract<KinMailRuleEntry, { kind: "mail" }>): string {
  const copy = KIN_MAIL_RULES.happened;
  if (entry.holdReason !== undefined && entry.holdReason !== null)
    return KIN_MAIL_RULES.heldBecause[entry.holdReason];
  if (entry.state !== "woke") return copy[entry.state];
  if (entry.runOutcome !== undefined && entry.runOutcome !== null && entry.runOutcome !== "held")
    return KIN_MAIL_RULES.ranAnd[entry.runOutcome];
  switch (entry.outcome) {
    case "draft":
      return copy.draft;
    case "task":
      return copy.task(recordKey(entry.refs));
    case "filed":
      return copy.filed(recordKey(entry.refs));
    case "nothing":
      return copy.nothing;
    default:
      return entry.settledAt === null ? copy.running : copy.ran;
  }
}

/** A rule's runs, newest first as the host sends them: what matched, when, and what happened. */
export function kinMailRuleHistoryRows(
  entries: KinMailRuleHistory["entries"],
  options: { readonly now: number; readonly words?: KinMailRuleWords | undefined },
): ReadonlyArray<KinMailRuleLineView> {
  const words = options.words ?? {};
  return entries.map((entry): KinMailRuleLineView => {
    if (entry.kind === "gap")
      return {
        key: entry.arrivalId,
        title: KIN_MAIL_RULES.gap(when(entry.from, words), when(entry.to, words)),
        detail: null,
        tone: "attention",
      };
    return {
      key: entry.arrivalId,
      title: entry.fromAddress ?? KIN_MAIL_RULES.unknownSender,
      detail: `${when(entry.receivedAt ?? entry.noticedAt, words)} · ${happened(entry)}`,
      tone: entry.state.startsWith("held_") ? "attention" : "ok",
    };
  });
}

/** The 30-day preview: each mail that would have matched, and what would have happened. */
export function kinMailRulePreviewView(
  preview: KinMailRulePreview,
  options: { readonly now: number; readonly words?: KinMailRuleWords | undefined },
): {
  readonly rows: ReadonlyArray<KinMailRuleLineView>;
  readonly empty: string | null;
  readonly note: string | null;
} {
  const words = options.words ?? {};
  const rows = preview.matches.map((one): KinMailRuleLineView => ({
    key: one.arrivalId,
    title: one.fromAddress ?? KIN_MAIL_RULES.unknownSender,
    detail: [
      ...(one.receivedAt === null ? [] : [when(one.receivedAt, words)]),
      ...(one.subject === null || one.subject.trim() === "" ? [] : [one.subject.trim()]),
      KIN_MAIL_RULES.wouldHave[one.state],
    ].join(" · "),
    tone: one.state === "match" ? "ok" : "attention",
  }));
  return {
    rows,
    empty: rows.length === 0 ? KIN_MAIL_RULES.previewEmpty : null,
    note:
      preview.subjectCheckLimit === null
        ? null
        : preview.partial
          ? KIN_MAIL_RULES.previewPartial
          : KIN_MAIL_RULES.previewChecked,
  };
}

/**
 * What Run now answered, in the host's own sentence: "not yet" and "no match" ran nothing; any
 * other answer a later host gives means a run started.
 */
export function kinMailRuleRunNowAnswer(result: KinMailRuleRunNow): {
  readonly text: string;
  readonly ran: boolean;
} {
  const status: string = result.status;
  const ran = status !== "no_match" && status !== "not_yet";
  const said = "message" in result ? result.message.trim() : "";
  return {
    text: said !== "" ? said : ran ? KIN_MAIL_RULES.runNowDone : KIN_MAIL_RULES.runNowNothing,
    ran,
  };
}

/**
 * Where a line may break: after each `@`, and after each `.` inside a word, so an address or a
 * domain is never cut and never broken anywhere else. The pieces join back to the text.
 */
export function kinMailRuleBreaks(text: string): ReadonlyArray<string> {
  return text.split(/(?<=@)|(?<=\.)(?=\S)/);
}

/**
 * Resume: the viewer's own direct chat with the lead (made the first time), then the rule turned
 * on with a fresh tap. The host makes whoever resumes it the setter and checks everything again.
 */
export async function kinMailRuleResumeSend(input: {
  readonly rule: Pick<KinMailRule, "orgId" | "ruleId">;
  readonly agentId: KinMailRule["agentId"];
  readonly newId: () => string;
  readonly online: () => boolean;
  readonly openChat: (chat: {
    readonly orgId: KinMailRule["orgId"];
    readonly agentId: KinMailRule["agentId"];
  }) => Promise<AtomCommandResult<{ readonly chatId: KinMailRule["chatId"] }, unknown>>;
  readonly resume: (resume: {
    readonly orgId: KinMailRule["orgId"];
    readonly ruleId: string;
    readonly agentId: KinMailRule["agentId"];
    readonly chatId: KinMailRule["chatId"];
    readonly tapId: string;
  }) => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
  const { orgId, ruleId } = input.rule;
  const chat = await kinListSend({
    online: input.online,
    send: () => input.openChat({ orgId, agentId: input.agentId }),
  });
  if (!chat.ok) return { ok: false, problem: chat.problem || KIN_MAIL_RULES.resumeFailed };
  const tapId = input.newId();
  const done = await kinListSend({
    online: input.online,
    send: () =>
      input.resume({ orgId, ruleId, agentId: input.agentId, chatId: chat.value.chatId, tapId }),
  });
  return done.ok
    ? { ok: true }
    : { ok: false, problem: done.problem || KIN_MAIL_RULES.resumeFailed };
}

export type KinMailRuleCardAction = (typeof KIN_MAIL_RULE_CARD_ACTIONS)[number];

export const KIN_MAIL_RULE_CARD = {
  eyebrow: "Mail rule",
  turnOn: "Turn on",
  notNow: "Not now",
  open: (until: string) => `Nothing runs until Turn on is tapped. The card is open until ${until}.`,
  on: (at: string) => `Turned on ${at}.`,
  dismissed: (at: string) => `Not now was tapped ${at}, so nothing was turned on.`,
  expired: "This card expired, so nothing was turned on. Ask the lead for a new one.",
  closed: "This card closed, so nothing was turned on.",
  replaced: "A newer card replaced this one, so nothing was turned on.",
} as const;

/** A lead's proposed mail rule in chat, exactly as the host sealed it. */
export interface KinMailRuleCardView {
  readonly orgId: KinWidget["orgId"];
  readonly widgetId: KinWidget["widgetId"];
  readonly revision: number;
  readonly connectionId: string;
  readonly eyebrow: string;
  /** What it matches, with the host's ASCII spelling beside any sender that differs. */
  readonly title: string;
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly whatLabel: string;
  /** The lead's instruction whole: never shortened, its line breaks kept. */
  readonly what: string;
  readonly status: string;
  /** Empty unless it is open and this viewer may answer it; the host decides in any case. */
  readonly actions: ReadonlyArray<{ readonly id: KinMailRuleCardAction; readonly label: string }>;
  readonly accessibilityLabel: string;
}

const decodeMailRuleCard = Schema.decodeUnknownOption(KinMailRuleCardState);

// A model or an outsider chose these words: a character that draws nothing, or turns the text
// around it, is shown by its code instead.
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const visible = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(HIDDEN, (char) =>
      char === "\n" || char === "\t"
        ? char
        : `[U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`,
    );

/** The proposal card's view; null when its state can't be read. */
export function kinMailRuleCardView(
  widget: KinWidget,
  options: {
    readonly nowMs: number;
    /** False below the owner level; unknown offers the buttons, and the host decides. */
    readonly ownerLevel?: boolean | undefined;
    /** The viewer may only read this chat. */
    readonly readOnly?: boolean | undefined;
    readonly words?: KinMailRuleWords | undefined;
  },
): KinMailRuleCardView | null {
  const decoded = decodeMailRuleCard(widget.state);
  if (Option.isNone(decoded)) return null;
  const card = decoded.value;
  const copy = KIN_MAIL_RULE_CARD;
  const words = options.words ?? {};
  const closedAt = widget.closedAt === null ? null : Date.parse(widget.closedAt);
  const settledAt = closedAt === null || Number.isNaN(closedAt) ? null : when(closedAt, words);
  const proposed = card.decision.status === "proposed";
  const open = proposed && closedAt === null && options.nowMs < card.expiresAt;
  const status =
    card.decision.status === "on"
      ? settledAt === null
        ? "Turned on."
        : copy.on(settledAt)
      : card.decision.status === "dismissed"
        ? settledAt === null
          ? "Not now was tapped, so nothing was turned on."
          : copy.dismissed(settledAt)
        : card.decision.status === "replaced"
          ? copy.replaced
          : closedAt !== null
            ? copy.closed
            : open
              ? copy.open(when(card.expiresAt, words))
              : copy.expired;
  const match = {
    ...card.match,
    from: card.match.from.map((sender) =>
      sender.address !== undefined
        ? { address: visible(sender.address) }
        : { domain: visible(sender.domain) },
    ),
    subjectHas: card.match.subjectHas.map(visible),
  };
  const title = kinMailRuleMatchLine(match, card.fromAscii.map(visible));
  const labels = KIN_MAIL_RULES.facts;
  const facts = [
    { label: labels.mailbox, value: visible(card.mailbox.label) },
    { label: labels.lead, value: visible(card.lead.name) },
    { label: labels.limit, value: KIN_MAIL_RULES.capLine(card.monthlyCap) },
  ];
  const what = visible(card.what);
  const answers = open && options.ownerLevel !== false && options.readOnly !== true;
  return {
    orgId: widget.orgId,
    widgetId: widget.widgetId,
    revision: widget.revision,
    connectionId: card.mailbox.connectionId,
    eyebrow: copy.eyebrow,
    title,
    facts,
    whatLabel: KIN_MAIL_RULES.pageWhat,
    what,
    status,
    actions: answers
      ? [
          { id: "turn_on", label: copy.turnOn },
          { id: "not_now", label: copy.notNow },
        ]
      : [],
    accessibilityLabel: kinSentences([
      `${copy.eyebrow}: ${title}`,
      ...facts.map((fact) => `${fact.label}: ${fact.value}`),
      `${KIN_MAIL_RULES.pageWhat}: ${what.replace(/\s+/g, " ")}`,
      status,
    ]),
  };
}

/** The Settings rule lists that show a rule this card turned on: its mailbox's, and the company's. */
export const kinMailRuleListsAfterTurnOn = (
  card: Pick<KinMailRuleCardView, "orgId" | "connectionId">,
): ReadonlyArray<KinMailRulesListInput> => [
  { orgId: card.orgId, connectionId: card.connectionId },
  { orgId: card.orgId },
];

/**
 * The card's taps through the shared action queue: a double tap posts once, and a retry after a
 * dropped send reuses its id. A refusal shows the host's own sentence; one that says the card is
 * behind keeps the buttons held until its newer revision arrives.
 */
export function createKinMailRuleCardActions(options: {
  readonly post: (
    input: KinWidgetsActInput,
  ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly cause: unknown }>;
  readonly newId: () => string;
  /** After Turn on is taken: read the Settings lists again (`kinMailRuleListsAfterTurnOn`). */
  readonly onTurnedOn: () => void;
}) {
  const queue = createKinCardActions<
    Pick<KinMailRuleCardView, "widgetId" | "revision">,
    KinMailRuleCardAction
  >({
    post: options.post,
    newId: options.newId,
    toInput: (card, actionId, clientActionId) => ({
      widgetId: card.widgetId,
      revision: card.revision,
      actionId,
      clientActionId,
    }),
    failureNotice: (cause) => ({
      kind: cause.reason === "widget_changed" ? "stale" : "error",
      text: cause.message,
    }),
  });
  return async (
    card: Pick<KinMailRuleCardView, "widgetId" | "revision">,
    actionId: KinMailRuleCardAction,
    onStart?: () => void,
  ): Promise<KinCardStatus | null> => {
    const outcome = await queue(card, actionId, onStart);
    if (outcome.status === "ignored") return null;
    if (outcome.status === "failed")
      return { revision: card.revision, notice: outcome.notice, holding: outcome.behind === true };
    if (actionId === "turn_on") options.onTurnedOn();
    return { revision: card.revision, notice: null, holding: true };
  };
}

/** Stands in for a read the viewer may not make, so no request goes out. */
export const KIN_MAIL_RULES_IDLE: Atom.Atom<
  AsyncResult.AsyncResult<{ readonly rules: ReadonlyArray<KinMailRule> }, unknown>
> = Atom.make(AsyncResult.initial());
export const KIN_MAIL_RULE_HISTORY_IDLE: Atom.Atom<
  AsyncResult.AsyncResult<KinMailRuleHistory, unknown>
> = Atom.make(AsyncResult.initial());

const byRule = ({ input }: { readonly input: KinMailRuleRef }) => `${input.orgId}:${input.ruleId}`;

/** The guarded mail rule reads and commands for one app runtime. Nothing here creates a rule. */
export function makeKinMailRules<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  guardedRead: typeof kinGuardedRead,
) {
  const refreshOn = createKinRefreshTriggers(runtime);
  const mailRulesList = createKinRpcCommand(runtime, {
    label: "kin:mail-rules:list",
    tag: KIN_MAIL_RULE_METHODS.list,
  });
  const mailRuleHistoryRead = createKinRpcCommand(runtime, {
    label: "kin:mail-rules:history",
    tag: KIN_MAIL_RULE_METHODS.history,
  });
  const readList = guardedRead(mailRulesList);
  const readHistory = guardedRead(mailRuleHistoryRead);
  return {
    mailRulesList,
    /** A company's rules, or one mailbox's. A disconnected mailbox pauses its rules. */
    mailRules: createKinQueryAtomFamily(runtime, {
      label: "kin:mail-rules",
      execute: Effect.fn("KinClient.mailRules")(function* (input: KinMailRulesListInput) {
        return yield* readList(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinMailRulesListInput;
      }) => refreshOn("connections")(target),
    }),
    mailRuleHistoryRead,
    /** One rule's runs in the last 30 days, with the mailbox's blind stretches. */
    mailRuleHistory: createKinQueryAtomFamily(runtime, {
      label: "kin:mail-rule-history",
      execute: Effect.fn("KinClient.mailRuleHistory")(function* (input: KinMailRuleRef) {
        return yield* readHistory(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: KinMailRuleRef;
      }) => refreshOn("connections")(target),
    }),
    mailRulePause: createKinRpcCommand(runtime, {
      label: "kin:mail-rule:pause",
      tag: KIN_MAIL_RULE_METHODS.pause,
      concurrency: { mode: "singleFlight", key: byRule },
    }),
    mailRuleResume: createKinRpcCommand(runtime, {
      label: "kin:mail-rule:resume",
      tag: KIN_MAIL_RULE_METHODS.resume,
      concurrency: { mode: "singleFlight", key: byRule },
    }),
    mailRuleRemove: createKinRpcCommand(runtime, {
      label: "kin:mail-rule:remove",
      tag: KIN_MAIL_RULE_METHODS.remove,
      concurrency: { mode: "singleFlight", key: byRule },
    }),
    /** Reads up to 200 headers on the host and calls no model; run on a tap, never on open. */
    mailRulePreview: createKinRpcCommand(runtime, {
      label: "kin:mail-rule:preview",
      tag: KIN_MAIL_RULE_METHODS.preview,
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => ("ruleId" in input ? `${input.orgId}:${input.ruleId}` : input.orgId),
      },
    }),
    mailRuleRunNow: createKinRpcCommand(runtime, {
      label: "kin:mail-rule:run-now",
      tag: KIN_MAIL_RULE_METHODS.runNow,
      concurrency: { mode: "singleFlight", key: byRule },
    }),
  };
}
