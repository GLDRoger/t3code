import {
  kinOwnerLevel,
  KIN_DEAL_QUIET_DAYS_MAX,
  KIN_DEAL_STEP_FIELD,
  type KinDealMove,
  type KinDealNumbers,
  type KinDealPage,
  type KinDealPersonNumbers,
  type KinDealRow,
  type KinDealStage,
  type KinDealState,
  type KinDealsInput,
  type KinDealsResult,
  type KinDealTotals,
  type KinDealUpdateInput,
  type KinDealWeekRow,
  type KinMoney,
  type KinOrgId,
  type KinPersonAccess,
  type KinPersonId,
  type KinRecordChange,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { kinTotalsEstimate, type KinRates } from "./kinCurrency.ts";
import { kinHostLacksCall } from "./kinHost.ts";
import { kinMoneyText, kinParseMoney } from "./kinLists.ts";
import {
  kinWorkActorName,
  kinWorkAllDay,
  kinWorkChangeText,
  kinWorkDueText,
  kinWorkName,
  type KinWorkNames,
} from "./kinWork.ts";
import type { KinWorkReadState } from "./kinWorkForms.ts";
import type { KinMineCount } from "./kinWorkClients.ts";

/** A deal's key: the built-in Deals list's fixed prefix. */
export const kinIsDealKey = (key: string) => key.startsWith("DL-");

/** The deals a list's own search box keeps: its title or client has the words, or its key is typed whole. */
export function kinDealsMatching(deals: ReadonlyArray<KinDealRow>, text: string) {
  const folded = text.trim().toLocaleLowerCase();
  if (folded === "") return deals;
  return deals.filter(
    (deal) =>
      deal.key.toLocaleLowerCase() === folded ||
      deal.title.toLocaleLowerCase().includes(folded) ||
      deal.party.title.toLocaleLowerCase().includes(folded),
  );
}

/** Every word Deals shows, on the web and the phone alike. */
export const KIN_DEALS = {
  stagesFailed: "Stages didn't load",
  title: "Deals",
  newDeal: "New deal",
  search: "Search deals",
  open: "Open",
  won: "Won",
  lost: "Lost",
  reopen: "Reopen",
  markWon: "Mark won",
  moveTo: "Move to…",
  stage: "Stage",
  noNextStep: "No next step",
  nextHidden: "Next step isn't shared with you",
  noneYet: "None yet",
  mine: "Mine",
  everyone: "Everyone",
  me: "Me",
  someone: "Someone…",
  whose: "Whose deals",
  showEveryone: "Clear to show everyone's",
  /** The By person row a list was opened from, as its chip names it. */
  personChip: (name: string) => `Looked after by ${name}`,
  clearPerson: "Clear it",
  which: "Which deals",
  dropWon: "Drop to win",
  dropLost: "Drop to lose",
  lostAsk: "Why was it lost?",
  lostHint: "In a word or a line, for the next time.",
  lostConfirm: "Mark lost",
  startProject: "Start a project",
  details: "Details",
  clientField: "Client",
  lookedAfterBy: "Looked after by",
  nextStep: "Next step",
  cameFrom: "Came from",
  quote: "Quote",
  lastStage: "Last stage",
  activity: "Activity",
  addStep: "Add a next step",
  stepNeeded: "Add a next step, or choose None yet.",
  what: "What",
  value: "Value",
  expected: "Expected",
  valueHint: "Leave it empty if you don't know yet",
  notAmount: "That isn't an amount.",
  add: "Add deal",
  boardHint: "Each deal keeps its own currency. Dragging a card changes its stage; Lost asks why.",
  section: "Deals",
  sectionNone: "No deals with them yet.",
  loadFailed: "Deals didn't load.",
  gone: "This deal is gone, or no longer yours to see.",
  olderHost: {
    title: "Deals need a newer Kin",
    detail: "The computer Kin runs on is older than this app. Update it to see deals here.",
  },
  refused: {
    title: "Deals aren't yours to see",
    detail: "They're for the owner, co-owners and teammates with Clients on.",
  },
  more: (n: number) => `${n} more not shown; narrow the filters to see them.`,
  estimate: (about: string) => `${about}, an estimate at the company's rates`,
  dealCount: (n: number) => (n === 1 ? "1 deal" : `${n} deals`),
  late: (title: string) => `Late: ${title}`,
  next: (title: string, due: string | null) => `Next: ${title}${due === null ? "" : `, ${due}`}`,
  moveToStage: (stage: string) => `Move to ${stage}`,
  invoiceFrom: (quote: string) => `Invoice from ${quote}`,
  becameClient: (party: string) => `${party} was a prospect and is now a client.`,
  whatNext: "What comes next is yours to start:",
  lostWhy: (reason: string) => `Why: ${reason}`,
  quoteAccepted: (quote: string) => `${quote} · accepted`,
  quoteAcceptedHint: (quote: string) => `${quote} was accepted. Mark the deal won?`,
  edit: "Edit",
  editTitle: (key: string) => `Edit ${key}`,
  save: "Save",
  change: "Change",
  changeOwner: "Change who looks after it",
  changeQuote: "Change quote",
  none: "None",
  noQuotes: (party: string) => `No quotes for ${party} to link.`,
  openQuote: (quote: string) => `Open ${quote}`,
  clientStays: "A deal stays with its client. For another, add a new deal.",
  concernsRaised: "Concerns raised",
  whatWeHear: "What we hear",
  whatWeHearHint:
    "Concerns are the words your team and agents put on deals, counted across the deals you see.",
  heard: (words: string) => `“${words}”`,
  removeConcern: (label: string) => `Remove ${label}`,
  concernStands: (open: number, won: number, lost: number) =>
    `${open} open · ${won} won · ${lost} lost`,
  raisedBy: "The deals that raised it, as you see them.",
  openConcern: (label: string) => `Deals that raised ${label}`,
  close: "Close",
} as const;

/** Under a new deal's next step while Add deal waits on it: a step or None yet. */
export function kinDealStepHint(step: string, noneYet: boolean) {
  return noneYet || step.trim() !== "" ? undefined : KIN_DEALS.stepNeeded;
}

/**
 * What Deals says in place of deals it couldn't read: refused, or a host that has no deals at all
 * (it lacks the call). Null for any other failure, which offers Retry.
 */
export function kinDealsNotRead(state: KinWorkReadState<unknown>) {
  if (state._tag === "refused" || state._tag === "gone") return KIN_DEALS.refused;
  if (state._tag === "failed" && Cause.isCause(state.cause) && kinHostLacksCall(state.cause))
    return KIN_DEALS.olderHost;
  return null;
}

/** A deal's change that takes one concern off, through the deal's own edit. */
export function kinDealWithoutConcern(deal: KinDealRow, label: string) {
  return {
    key: deal.key,
    rev: deal.rev,
    concerns: (deal.concerns ?? []).filter((concern) => concern.label !== label),
  };
}

/** One line of What we hear: the concern, how many deals raised it, and how those stand. */
export function kinDealConcernRows(concerns: KinDealsResult["concerns"]) {
  return (concerns ?? []).map((concern) => ({
    label: concern.label,
    deals: KIN_DEALS.dealCount(concern.deals),
    stands: KIN_DEALS.concernStands(concern.open, concern.won, concern.lost),
  }));
}

/** Settings → Deals. */
export const KIN_DEAL_STAGES = {
  title: "Deals",
  detail: "How every deal in the company moves. Only you and co-owners change this.",
  stages: "Stages",
  ends: "Always at the end",
  wonHint: "turns a prospect into a client",
  lostHint: "asks why, in a word",
  add: "Add a stage",
  rename: "Rename",
  remove: "Remove…",
  up: "Move up",
  down: "Move down",
  save: "Save stages",
  hint: "Renaming keeps every deal where it is. Removing a stage asks where its deals go first.",
  readOnly: "The owner and co-owners set the stages. Ask them to change one.",
  openDeals: (n: number) => (n === 1 ? "1 open deal" : `${n} open deals`),
  removeTitle: (stage: string) => `Remove “${stage}”?`,
  removeDetail: (n: number) =>
    n === 1 ? "1 open deal is in it. It moves to:" : `${n} open deals are in it. They move to:`,
  removeNote: "Each move is logged on its deal.",
  removeConfirm: (n: number) => (n === 0 ? "Remove" : `Move ${n} and remove`),
  stageName: "Stage name",
  limit: "At most 12 stages.",
  searchTerms: ["deals", "stages", "pipeline", "won", "lost"],
} as const;

/** Settings → Deals: when a deal with nothing moving reaches whoever looks after it. */
export const KIN_DEAL_QUIET = {
  title: "A deal goes quiet after",
  label: "Days before a deal is quiet",
  days: (n: number) => (n === 1 ? "1 day" : `${n} days`),
  unit: (text: string) => (text.trim() === "1" ? "day" : "days"),
  detail:
    "No contact, note, stage move or next-step change for this long, and whoever looks after it hears.",
  readOnly: "The owner and co-owners set this.",
  save: "Save",
} as const;

/** Why a number of quiet days can't be saved, or null when it can. */
export function kinDealQuietProblem(text: string): string | null {
  const days = Number(text.trim());
  return text.trim() === "" || !Number.isInteger(days) || days < 1 || days > KIN_DEAL_QUIET_DAYS_MAX
    ? `Say a whole number of days, 1 to ${KIN_DEAL_QUIET_DAYS_MAX}.`
    : null;
}

/** Why a stage list can't be saved, or null when it can. */
export function kinDealStagesProblem(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return "Keep at least one stage.";
  if (names.length > 12) return KIN_DEAL_STAGES.limit;
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name === "") return "Every stage needs a name.";
    if (name.length > 40) return "Keep a stage's name to 40 letters.";
    const folded = name.toLocaleLowerCase();
    if (seen.has(folded)) return `“${name}” is there twice.`;
    seen.add(folded);
  }
  return null;
}

export type KinDealsWho =
  | { readonly _tag: "everyone" }
  | { readonly _tag: "me" }
  | { readonly _tag: "person"; readonly personId: KinPersonId };

export interface KinDealsFilter {
  readonly who: KinDealsWho;
  readonly state: KinDealState;
}

/**
 * Where the tab starts: the owner level on everyone's deals, a teammate on their own ("Mine").
 * Null while the host hasn't said which the viewer is (`undefined`), so nothing is read on a guess.
 */
export function kinDealsStartFilter(
  access: KinPersonAccess | null | undefined,
): KinDealsFilter | null {
  if (access === undefined) return null;
  return {
    who: kinOwnerLevel(access ?? undefined) ? { _tag: "everyone" } : { _tag: "me" },
    state: "open",
  };
}

/**
 * What the tab reads: the person's own choice once they make one, else where it starts. Null
 * while either is unknown: who the viewer is, or (for "Mine") their own id.
 */
export function kinDealsQuery(
  orgId: KinOrgId,
  chosen: KinDealsFilter | null,
  start: KinDealsFilter | null,
  me: KinPersonId | null,
): { readonly filter: KinDealsFilter; readonly input: KinDealsInput } | null {
  const filter = chosen ?? start;
  if (filter === null) return null;
  const personId =
    filter.who._tag === "person" ? filter.who.personId : filter.who._tag === "me" ? me : null;
  if (filter.who._tag === "me" && personId === null) return null;
  return {
    filter,
    input: {
      orgId,
      state: filter.state,
      ...(personId === null ? {} : { owner: { _tag: "person", personId } }),
    },
  };
}

/** How many deals a read finds under its filters, the ones past the cap included. */
export const kinDealsCount = (
  result: Pick<KinDealsResult, "deals" | "more" | "open">,
  state: KinDealState,
): KinMineCount => ({
  n: state === "open" ? result.open.count : result.deals.length + result.more,
});

export const KIN_DEALS_STATES: ReadonlyArray<{
  readonly id: KinDealState;
  readonly label: string;
}> = [
  { id: "open", label: KIN_DEALS.open },
  { id: "won", label: KIN_DEALS.won },
  { id: "lost", label: KIN_DEALS.lost },
];

/** Per-currency totals, each in its own currency: never added across them. */
const kinDealValues = (values: ReadonlyArray<KinMoney>): string =>
  values.map((money) => kinMoneyText(money)).join(" · ");

export interface KinDealsHeader {
  readonly count: string;
  /** One line per currency. */
  readonly values: ReadonlyArray<string>;
  /** "about €142,500 in all", only for the owner level with rates for every currency. */
  readonly estimate: string | null;
  readonly estimateBasis: ReadonlyArray<string>;
}

export function kinDealsHeader(
  open: KinDealsResult["open"],
  rates: KinRates | null,
): KinDealsHeader {
  const estimate = open.values.length > 1 ? kinTotalsEstimate(open.values, rates) : null;
  return {
    count: KIN_DEALS.dealCount(open.count),
    values: open.values.map((money) => kinMoneyText(money)),
    estimate: estimate?.all ?? null,
    estimateBasis: estimate?.basis ?? [],
  };
}

export type KinDealNextTone = "plain" | "missing" | "late";

export interface KinDealNextView {
  readonly tone: KinDealNextTone;
  readonly text: string;
}

/**
 * An open deal's next step, or that it has none (amber), or that it is late (red); one the reader
 * isn't shown reads as such, plainly, for it isn't missing.
 */
export function kinDealNext(
  deal: Pick<KinDealRow, "state" | "next" | "nextHidden">,
  names: Pick<KinWorkNames, "zone">,
  now: Date,
): KinDealNextView | null {
  if (deal.state !== "open") return null;
  if (deal.next === null)
    return deal.nextHidden === true
      ? { tone: "plain", text: KIN_DEALS.nextHidden }
      : { tone: "missing", text: KIN_DEALS.noNextStep };
  if (deal.next.late) return { tone: "late", text: KIN_DEALS.late(deal.next.title) };
  return {
    tone: "plain",
    text: KIN_DEALS.next(
      deal.next.title,
      kinWorkDueText({ dueAt: deal.next.dueAt, dueAllDay: deal.next.dueAllDay }, names, now),
    ),
  };
}

export const kinDealStageName = (
  stages: ReadonlyArray<KinDealStage>,
  id: string | null,
): string | null => (id === null ? null : (stages.find((stage) => stage.id === id)?.name ?? null));

/** The status pill: its stage while open, then Won or Lost. */
export function kinDealPill(deal: KinDealRow, stages: ReadonlyArray<KinDealStage>): string {
  if (deal.state === "won") return KIN_DEALS.won;
  if (deal.state === "lost") return KIN_DEALS.lost;
  return kinDealStageName(stages, deal.stage) ?? stages[0]?.name ?? KIN_DEALS.open;
}

/** "expected 15 Jan", "won Wed 18 Nov", "lost today"; null with nothing to say. */
export function kinDealWhen(
  deal: Pick<KinDealRow, "state" | "expectedAt" | "expectedAllDay" | "closedAt">,
  names: Pick<KinWorkNames, "zone">,
  now: Date,
): string | null {
  if (deal.state !== "open") {
    const day = kinWorkDueText({ dueAt: deal.closedAt, dueAllDay: true }, names, now);
    return day === null ? null : `${deal.state} ${day}`;
  }
  const day = kinWorkDueText(
    { dueAt: deal.expectedAt, dueAllDay: deal.expectedAllDay },
    names,
    now,
  );
  return day === null ? null : `expected ${day}`;
}

export interface KinDealRowView {
  readonly key: KinRecordKey;
  readonly title: string;
  /** "Brightwater Clinics · Zoya · expected 15 Jan", leaving out what the place already says. */
  readonly line: string;
  readonly value: string | null;
  readonly next: KinDealNextView | null;
  readonly owner: string;
  readonly private: boolean;
  readonly accessibilityLabel: string;
}

export function kinDealRow(
  deal: KinDealRow,
  names: KinWorkNames,
  now: Date,
  within?: { readonly party?: KinRecordKey },
): KinDealRowView {
  const owner = kinWorkName(deal.owner, names);
  const line = [
    deal.party.key === within?.party ? null : deal.party.title,
    owner,
    kinDealWhen(deal, names, now),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const value = deal.value === undefined ? null : kinMoneyText(deal.value);
  const next = kinDealNext(deal, names, now);
  return {
    key: deal.key,
    title: deal.title,
    line,
    value,
    next,
    owner,
    private: deal.sensitive,
    accessibilityLabel: [
      deal.title,
      value,
      line,
      next?.text ?? null,
      deal.sensitive ? "Private" : null,
    ]
      .filter((part) => part !== null)
      .join(". "),
  };
}

export interface KinDealsColumn {
  readonly id: string;
  readonly name: string;
  readonly count: number;
  /** Its open value, per currency. */
  readonly total: string;
  readonly rows: ReadonlyArray<KinDealRowView>;
  readonly deals: ReadonlyArray<KinDealRow>;
}

/**
 * Open deals under the company's stages, in order. A deal whose stage was removed under it shows in
 * the first stage until the host moves it.
 */
export function kinDealsByStage(
  stages: ReadonlyArray<KinDealStage>,
  deals: ReadonlyArray<KinDealRow>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinDealsColumn> {
  const known = new Set(stages.map((stage) => stage.id));
  const first = stages[0]?.id ?? null;
  return stages.map((stage) => {
    const held = deals.filter(
      (deal) =>
        deal.state === "open" &&
        (deal.stage === stage.id ||
          (stage.id === first && (deal.stage === null || !known.has(deal.stage)))),
    );
    return {
      id: stage.id,
      name: stage.name,
      count: held.length,
      total: kinDealValues(kinDealSum(held)),
      rows: held.map((deal) => kinDealRow(deal, names, now)),
      deals: held,
    };
  });
}

/** Values added up within each currency only. */
function kinDealSum(deals: ReadonlyArray<Pick<KinDealRow, "value">>): ReadonlyArray<KinMoney> {
  const sums = new Map<string, number>();
  for (const deal of deals) {
    if (deal.value === undefined) continue;
    sums.set(deal.value.currency, (sums.get(deal.value.currency) ?? 0) + deal.value.minor);
  }
  return [...sums.entries()].map(([currency, minor]) => ({ currency, minor }));
}

export type KinDealMoveChoice =
  | {
      readonly id: string;
      readonly label: string;
      readonly to: KinDealMove;
      readonly current: boolean;
    }
  | { readonly id: "lost"; readonly label: string; readonly to: null; readonly current: false };

/**
 * "Move to…": each stage (the current one checked), then Won, then Lost, which asks why. A won or
 * lost deal has only Reopen.
 */
export function kinDealMoves(
  deal: Pick<KinDealRow, "state" | "stage">,
  stages: ReadonlyArray<KinDealStage>,
): ReadonlyArray<KinDealMoveChoice> {
  if (deal.state !== "open")
    return [{ id: "reopen", label: KIN_DEALS.reopen, to: { _tag: "reopen" }, current: false }];
  return [
    ...stages.map((stage) => ({
      id: `stage:${stage.id}`,
      label: stage.name,
      to: { _tag: "stage", stage: stage.id } as const,
      current: stage.id === deal.stage,
    })),
    { id: "won", label: KIN_DEALS.won, to: { _tag: "won" }, current: false },
    { id: "lost", label: `${KIN_DEALS.lost}…`, to: null, current: false },
  ];
}

/** The page's one forward move: the stage after this one, while there is one. */
export function kinDealNextStage(
  deal: Pick<KinDealRow, "state" | "stage">,
  stages: ReadonlyArray<KinDealStage>,
): KinDealStage | null {
  if (deal.state !== "open") return null;
  const at = stages.findIndex((stage) => stage.id === deal.stage);
  return stages[at + 1] ?? null;
}

/** Where a key press moves a card on the board: a stage either side, or none at the ends. */
export function kinDealStageBeside(
  deal: Pick<KinDealRow, "stage">,
  stages: ReadonlyArray<KinDealStage>,
  step: -1 | 1,
): KinDealStage | null {
  const at = stages.findIndex((stage) => stage.id === deal.stage);
  return at === -1 ? null : (stages[at + step] ?? null);
}

/** A dropped or keyed move, or null when it changes nothing. */
export function kinDealDrop(
  deal: Pick<KinDealRow, "state" | "stage">,
  target: string,
): KinDealMove | "lost" | null {
  if (deal.state !== "open") return null;
  if (target === "won") return { _tag: "won" };
  if (target === "lost") return "lost";
  return target === deal.stage ? null : { _tag: "stage", stage: target };
}

/** The stage strip: each stage, reached or not, with the current one named. */
export function kinDealStrip(
  deal: Pick<KinDealRow, "stage">,
  stages: ReadonlyArray<KinDealStage>,
): ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly reached: boolean;
  readonly current: boolean;
}> {
  const at = stages.findIndex((stage) => stage.id === deal.stage);
  return stages.map((stage, index) => ({
    id: stage.id,
    name: stage.name,
    reached: index <= at,
    current: index === at,
  }));
}

/** The client page's Deals section: open ones first, at most a handful. */
export function kinDealsSection(
  deals: ReadonlyArray<KinDealRow>,
  names: KinWorkNames,
  now: Date,
  party: KinRecordKey,
  limit = 5,
): {
  readonly rows: ReadonlyArray<
    KinDealRowView & { readonly pill: string; readonly state: KinDealState }
  >;
  readonly more: number;
} {
  const ordered = [...deals].sort(
    (a, b) => Number(a.state !== "open") - Number(b.state !== "open"),
  );
  return {
    rows: ordered.slice(0, limit).map((deal) => ({
      ...kinDealRow(deal, names, now, { party }),
      pill:
        deal.state === "open"
          ? KIN_DEALS.open
          : deal.state === "won"
            ? KIN_DEALS.won
            : KIN_DEALS.lost,
      state: deal.state,
    })),
    more: Math.max(0, ordered.length - limit),
  };
}

/** What a row of What we hear opens: the deals that raised it, under the same whose as its count. */
export function kinDealsRaisedInput(input: KinDealsInput, concern: string): KinDealsInput {
  return {
    orgId: input.orgId,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    concern,
  };
}

/** Those deals as rows, each marked with its stage while open, else Won or Lost. */
export function kinDealsRaised(
  stages: ReadonlyArray<KinDealStage>,
  deals: ReadonlyArray<KinDealRow>,
  names: KinWorkNames,
  now: Date,
): ReadonlyArray<KinDealRowView & { readonly pill: string }> {
  return deals.map((deal) => ({
    ...kinDealRow(deal, names, now),
    pill:
      deal.state === "won"
        ? KIN_DEALS.won
        : deal.state === "lost"
          ? KIN_DEALS.lost
          : (stages.find((stage) => stage.id === deal.stage)?.name ?? KIN_DEALS.open),
  }));
}

/** Why the board shows nothing. */
export function kinDealsNothing(filter: KinDealsFilter): {
  readonly title: string;
  readonly detail: string;
} {
  if (filter.state === "won")
    return { title: "Nothing won yet", detail: "Deals you win show up here." };
  if (filter.state === "lost")
    return { title: "Nothing lost", detail: "Deals you lose show up here, with why." };
  if (filter.who._tag !== "everyone")
    return {
      title: "No open deals here",
      detail: "Deals looked after by someone else are under Everyone.",
    };
  return {
    title: "No deals yet",
    detail:
      "A deal is something you hope to sell to a prospect or a client: what, how much, and when you expect a yes. Each one moves through your stages until it's won or lost.",
  };
}

/** One line of a deal's activity: its moves in the deal's own words, anything else as a task's. */
/** When a change happened, "today, 8:59 AM", on this device's clock as chat reads it. */
export const kinDealChangeWhen = (change: Pick<KinRecordChange, "at">, now: Date) =>
  kinWorkDueText({ dueAt: change.at, dueAllDay: false }, { zone: null }, now);

export function kinDealChangeText(change: KinRecordChange, names: KinWorkNames, now: Date): string {
  const who = kinWorkActorName(change.by, names);
  if (change.kind === "created") return `${who} added this deal`;
  const field = (name: string) => change.fields.find((held) => held.field === name);
  const state = field("state");
  const reason = field("lostReason")?.to ?? null;
  if (state?.to === "done") return `${who} marked it won`;
  if (state?.to === "dropped")
    return `${who} marked it lost${reason === null ? "" : `: ${reason}`}`;
  if (state !== undefined && (state.from === "done" || state.from === "dropped"))
    return `${who} reopened it`;
  const stage = field("stage");
  if (stage !== undefined && stage.to !== null)
    return stage.from === null
      ? `${who} put it in ${stage.to}`
      : `${who} moved it ${stage.from} → ${stage.to}`;
  const concerns = field("concerns");
  if (concerns !== undefined) {
    const before = concernLabels(concerns.from);
    const after = concernLabels(concerns.to);
    const removed = [...before].filter((label) => !after.has(label));
    const added = [...after].some((label) => !before.has(label));
    if (removed.length === 0 || added)
      return concerns.to === null ? `${who} cleared the concerns` : `${who} noted the concerns`;
    const shown = removed.slice(0, 3);
    const rest = removed.length - shown.length;
    const named =
      rest > 0
        ? `${shown.join(", ")} and ${rest} more`
        : shown.length === 1
          ? shown[0]!
          : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
    return `${who} removed ${removed.length === 1 ? "the concern" : "the concerns"} ${named}`;
  }
  const steps = change.fields.flatMap((held) =>
    held.field === KIN_DEAL_STEP_FIELD && held.to !== null ? [held.to] : [],
  );
  const line = kinWorkChangeText(change, names, now);
  if (steps.length === 0) return line;
  const listed =
    steps.length === 1 ? steps[0]! : `${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}`;
  return `${line}, with ${steps.length === 1 ? "its next step" : "its next steps"} ${listed}`;
}

/** A concerns change's labels: the host keeps one a line; a label never holds ": ". */
const concernLabels = (text: string | null) =>
  text === null
    ? new Set<string>()
    : new Set(text.split("\n").map((item) => item.split(": ")[0]!.trim()));

// Editing a deal

/** What the Edit form holds, as typed. The client stays: a deal never moves to another. */
export interface KinDealEditDraft {
  readonly title: string;
  readonly value: string;
  /** A `YYYY-MM-DD` day, or null for none. */
  readonly expected: string | null;
  readonly source: string;
  readonly quote: KinRecordKey | null;
}

export function kinDealEditDraft(
  deal: Pick<KinDealRow, "title" | "value" | "expectedAt" | "expectedAllDay" | "source" | "quote">,
  names: KinWorkNames,
): KinDealEditDraft {
  return {
    title: deal.title,
    value: deal.value === undefined ? "" : kinMoneyText(deal.value),
    expected: kinWorkAllDay(deal.expectedAt, deal.expectedAllDay, names),
    source: deal.source ?? "",
    quote: deal.quote?.key ?? null,
  };
}

export type KinDealEditRequest =
  | { readonly ok: true; readonly input: Omit<KinDealUpdateInput, "orgId"> }
  | { readonly ok: false; readonly problem: string | null };

/**
 * The update both clients send for a draft: only what changed, an emptied field cleared. A value
 * typed without a currency takes the deal's own, else the company's.
 */
export function kinDealEditRequest(
  deal: Pick<
    KinDealRow,
    "key" | "rev" | "title" | "value" | "expectedAt" | "expectedAllDay" | "source" | "quote"
  >,
  draft: KinDealEditDraft,
  names: KinWorkNames,
  home: string | null,
): KinDealEditRequest {
  const was = kinDealEditDraft(deal, names);
  const title = draft.title.trim();
  if (title === "") return { ok: false, problem: null };
  const typed = draft.value.trim();
  const currency = deal.value?.currency ?? home ?? "USD";
  const value = typed === "" ? null : kinParseMoney(typed, currency);
  if (typed !== "" && value === null) return { ok: false, problem: KIN_DEALS.notAmount };
  const source = draft.source.trim();
  const sameValue =
    value === null
      ? deal.value === undefined
      : deal.value !== undefined &&
        value.minor === deal.value.minor &&
        value.currency === deal.value.currency;
  return {
    ok: true,
    input: {
      key: deal.key as KinRecordKey,
      rev: deal.rev,
      ...(title === deal.title ? {} : { title }),
      ...(sameValue ? {} : { value }),
      ...(draft.expected === was.expected ? {} : { expectedOn: draft.expected }),
      ...(source === was.source ? {} : { source: source === "" ? null : source }),
      ...(draft.quote === was.quote ? {} : { quote: draft.quote }),
    },
  };
}

export interface KinDealQuoteChoice {
  /** Null unlinks. */
  readonly key: KinRecordKey | null;
  readonly label: string;
  readonly current: boolean;
}

/**
 * The quotes a deal may link: None, then its client's quotes the viewer sees, newest first. With
 * none to offer and none linked, `empty` says so and there is nothing to pick. Null when the host
 * offers no list (the viewer doesn't read quotes) and none is linked: the deal has no Quote row.
 */
export function kinDealQuoteChoices(
  page: Pick<KinDealPage, "deal" | "quotes">,
  linked: KinRecordKey | null = page.deal.quote?.key ?? null,
): { readonly choices: ReadonlyArray<KinDealQuoteChoice>; readonly empty: string | null } | null {
  const held = page.deal.quote;
  // The host sends no list to someone who doesn't read quotes; with none linked, there's no row.
  if (page.quotes === undefined && held === undefined) return null;
  const offered = [...(page.quotes ?? [])];
  if (held !== undefined && !offered.some((quote) => quote.key === held.key)) offered.push(held);
  if (offered.length === 0 && linked === null)
    return { choices: [], empty: KIN_DEALS.noQuotes(page.deal.party.title) };
  return {
    choices: [
      { key: null, label: KIN_DEALS.none, current: linked === null },
      ...offered.map((quote) => ({
        key: quote.key,
        label: quote.accepted ? KIN_DEALS.quoteAccepted(quote.title) : quote.title,
        current: quote.key === linked,
      })),
    ],
    empty: null,
  };
}

// The Deals tab's figures: every number counted by the host; these only put them in words.

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "November" for `2026-11`. */
const kinMonthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
/** "Monday 16 November": the host's week always starts on a Monday. */
const kinWeekStartName = (day: string) =>
  `Monday ${Number(day.slice(8, 10))} ${kinMonthName(day.slice(0, 7))}`;

/** Every word the figures show, on the web and the phone alike. */
export const KIN_DEAL_NUMBERS = {
  wonIn: (month: string) => `Won in ${kinMonthName(month)}`,
  lostIn: (month: string) => `Lost in ${kinMonthName(month)}`,
  thisWeek: "This week",
  weekLine: (added: number, won: number, lost: number) =>
    `+${added} new · ${won} won · ${lost} lost`,
  seeWhatChanged: "See what changed",
  thisWeekInDeals: "This week in deals",
  since: (day: string) => `From ${kinWeekStartName(day)}`,
  group: (label: string, count: number) => `${label} · ${count}`,
  new: "New",
  moved: "Moved",
  more: (n: number) => `${n} more`,
  byPerson: "By person",
  yours: "Yours",
  person: "Looked after by",
  openValue: "Open",
  wonThisMonth: "Won this month",
  lateFollowUps: "Follow-ups late",
  month: "This month and last",
  winRate: "Win rate, 90 days",
  noneDecided: "None decided yet",
  sources: "New prospects this month",
  notSaid: "Not said",
  nothing: "Nothing",
  openDeals: (name: string) => `Open deals looked after by ${name}`,
  basis: "Each deal keeps its own currency; figures are added up within a currency only.",
} as const;

/** With fewer decided than this, the rate is a count: "2 won of 3". */
const KIN_WIN_RATE_MIN = 5;

/** Totals in words: each currency on its own line, or the count alone with no value. */
const kinTotalsLines = (totals: KinDealTotals) => ({
  values: totals.values.map((money) => kinMoneyText(money)),
  count: KIN_DEALS.dealCount(totals.count),
});

/** "2 won of 3" for a few; "40% (8 won of 20)" from five decided on. */
export function kinWinRateText(rate: { readonly won: number; readonly decided: number }) {
  if (rate.decided === 0) return KIN_DEAL_NUMBERS.noneDecided;
  const count = `${rate.won} won of ${rate.decided}`;
  return rate.decided < KIN_WIN_RATE_MIN
    ? count
    : `${Math.round((rate.won / rate.decided) * 100)}% (${count})`;
}

interface KinDealFigure {
  readonly label: string;
  readonly values: ReadonlyArray<string>;
  readonly count: string;
}

/**
 * The headline after Open: won this month, then this week in one line. Null when the host sent no
 * figures (an older host, or no deal yet), so nothing shows.
 */
export function kinDealFigures(numbers: KinDealNumbers | undefined) {
  if (numbers === undefined) return null;
  const week = numbers.week;
  return {
    won: { label: KIN_DEAL_NUMBERS.wonIn(numbers.month), ...kinTotalsLines(numbers.wonThisMonth) },
    lost:
      numbers.lostThisMonth === undefined
        ? null
        : {
            label: KIN_DEAL_NUMBERS.lostIn(numbers.month),
            ...kinTotalsLines(numbers.lostThisMonth),
          },
    week:
      week === undefined
        ? null
        : KIN_DEAL_NUMBERS.weekLine(week.counts.new, week.counts.won, week.counts.lost),
  } satisfies {
    readonly won: KinDealFigure;
    readonly lost: KinDealFigure | null;
    readonly week: string | null;
  };
}

interface KinDealWeekLine {
  readonly key: KinRecordKey;
  /** "Kestrel Freight: warehouse app". */
  readonly title: string;
  readonly value: string | null;
  /** A move: "In talks → Proposal · Zoya". */
  readonly line: string | null;
}

/** "This week in deals": won, lost, new and moved, each with its count and the deals listed. */
export function kinDealWeekGroups(numbers: KinDealNumbers, names: KinWorkNames) {
  const week = numbers.week;
  if (week === undefined) return [];
  const row = (deal: KinDealWeekRow): KinDealWeekLine => ({
    key: deal.key,
    title: deal.party === "" ? deal.title : `${deal.party}: ${deal.title}`,
    value: deal.value === undefined ? null : kinMoneyText(deal.value),
    line:
      deal.from === undefined || deal.to === undefined
        ? null
        : `${deal.from} → ${deal.to} · ${kinWorkName(deal.owner, names)}`,
  });
  return (
    [
      ["won", KIN_DEALS.won, week.won, week.counts.won],
      ["lost", KIN_DEALS.lost, week.lost, week.counts.lost],
      ["new", KIN_DEAL_NUMBERS.new, week.new, week.counts.new],
      ["moved", KIN_DEAL_NUMBERS.moved, week.moved, week.counts.moved],
    ] as const
  ).map(([id, label, rows, count]) => ({
    id,
    title: KIN_DEAL_NUMBERS.group(label, count),
    rows: rows.map(row),
    more: Math.max(0, count - rows.length),
  }));
}

interface KinDealPersonRow {
  readonly id: string;
  readonly owner: KinDealPersonNumbers["owner"];
  readonly name: string;
  readonly open: ReadonlyArray<string>;
  readonly openCount: number;
  readonly won: ReadonlyArray<string>;
  readonly late: number;
  /** The list's own filter for their open deals, when they are a person. */
  readonly filter: KinDealsFilter | null;
}

/** The per-person table: everyone's for the owner level, a sales person's own row. */
export function kinDealPeopleRows(
  numbers: KinDealNumbers,
  names: KinWorkNames,
): ReadonlyArray<KinDealPersonRow> {
  return numbers.people.map((one) => ({
    id: one.owner._tag === "person" ? one.owner.personId : one.owner.agentId,
    owner: one.owner,
    name: kinWorkName(one.owner, names),
    open: one.open.values.length === 0 ? [String(one.open.count)] : kinTotalsLines(one.open).values,
    openCount: one.open.count,
    won:
      one.wonThisMonth.values.length === 0
        ? [String(one.wonThisMonth.count)]
        : kinTotalsLines(one.wonThisMonth).values,
    late: one.late,
    filter:
      one.owner._tag !== "person"
        ? null
        : one.owner.personId === names.me
          ? { who: { _tag: "me" }, state: "open" }
          : { who: { _tag: "person", personId: one.owner.personId }, state: "open" },
  }));
}

/** The owner level's month figures: won and lost this month and last, the rate, and sources. */
export function kinDealMonthRows(numbers: KinDealNumbers) {
  const totals = (totals: KinDealTotals | undefined) =>
    totals === undefined
      ? null
      : totals.count === 0
        ? KIN_DEAL_NUMBERS.nothing
        : [
            KIN_DEALS.dealCount(totals.count),
            ...totals.values.map((money) => kinMoneyText(money)),
          ].join(" · ");
  const rows = [
    [KIN_DEAL_NUMBERS.wonIn(numbers.month), totals(numbers.wonThisMonth)],
    [KIN_DEAL_NUMBERS.wonIn(numbers.lastMonth), totals(numbers.wonLastMonth)],
    [KIN_DEAL_NUMBERS.lostIn(numbers.month), totals(numbers.lostThisMonth)],
    [KIN_DEAL_NUMBERS.lostIn(numbers.lastMonth), totals(numbers.lostLastMonth)],
    [
      KIN_DEAL_NUMBERS.winRate,
      numbers.winRate === undefined ? null : kinWinRateText(numbers.winRate),
    ],
    [KIN_DEAL_NUMBERS.lateFollowUps, numbers.late === undefined ? null : String(numbers.late)],
  ] as const;
  return {
    rows: rows.flatMap(([label, value]) => (value === null ? [] : [{ label, value }])),
    sources: (numbers.sources ?? []).map((one) => ({
      label: one.source ?? KIN_DEAL_NUMBERS.notSaid,
      value: String(one.count),
    })),
  };
}
