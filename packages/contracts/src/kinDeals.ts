import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinText, KinTrimmedText } from "./kinChat.ts";
import { KinDay, KinMoney } from "./kinMoney.ts";
import {
  KinRecord,
  KinRecordChange,
  KinRecordId,
  KinRecordKey,
  KinPartyCreateInput,
  KinPartyDetail,
  KinRecordRef,
  KinWorkPrincipal,
} from "./kinWork.ts";

/**
 * Deals: what we hope to win from a client or prospect, and the company's stages they move
 * through. Stored as entries of the built-in `deals` list; every rule is the host's (`deals.ts`).
 */

const KIN_DEAL_STAGES_MAX = 12;
export const KinDealStageId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/));
export type KinDealStageId = typeof KinDealStageId.Type;
export const KinDealStageName = KinTrimmedText.check(Schema.isMinLength(1), Schema.isMaxLength(40));
export const KinDealStage = Schema.Struct({ id: KinDealStageId, name: KinDealStageName });
export type KinDealStage = typeof KinDealStage.Type;
/** Open while in the pipeline; won and lost are its two fixed ends. */
export const KinDealState = Schema.Literals(["open", "won", "lost"]);
export type KinDealState = typeof KinDealState.Type;

const Title = KinTrimmedText.check(Schema.isMaxLength(280));
const Source = KinTrimmedText.check(Schema.isMaxLength(120));
const Reason = KinTrimmedText.check(Schema.isMinLength(1), Schema.isMaxLength(280));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(120));

/** The deal's soonest open follow-up of ours. */
export const KinDealNext = Schema.Struct({
  key: KinRecordKey,
  title: KinTrimmedText,
  dueAt: Schema.NullOr(IsoDateTime),
  dueAllDay: Schema.Boolean,
  late: Schema.Boolean,
});
export type KinDealNext = typeof KinDealNext.Type;
/** A quote linked to the deal, for a reader who may see it; `accepted` offers Mark won. */
export const KinDealQuote = Schema.Struct({ ...KinRecordRef.fields, accepted: Schema.Boolean });
export type KinDealQuote = typeof KinDealQuote.Type;
/** What the reader may do to the deal, as the host's checks would answer each. */
export const KinDealCan = Schema.Struct({
  /** Title, value, expected day, came from, notes and the linked quote. */
  edit: Schema.Boolean,
  /** Its stage, Won, Lost and Reopen. */
  move: Schema.Boolean,
  /** Give it to someone else to look after. */
  give: Schema.Boolean,
  /** Keep private, or take that off. */
  mark: Schema.Boolean,
});
export type KinDealCan = typeof KinDealCan.Type;

/** A worry raised on a deal: a short label in the company's own words, and what was said. */
export const KinDealConcern = Schema.Struct({
  label: KinTrimmedText.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  heard: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(200))),
});
export type KinDealConcern = typeof KinDealConcern.Type;
/** One concern across the deals the reader sees: how many raised it, and how those stand. */
export const KinDealConcernCount = Schema.Struct({
  label: KinDealConcern.fields.label,
  deals: NonNegativeInt,
  open: NonNegativeInt,
  won: NonNegativeInt,
  lost: NonNegativeInt,
});
export type KinDealConcernCount = typeof KinDealConcernCount.Type;

export const KinDealRow = Schema.Struct({
  recordId: KinRecordId,
  key: KinRecordKey,
  title: KinTrimmedText,
  state: KinDealState,
  /** A stage id; a won or lost deal keeps the stage it left from. */
  stage: Schema.NullOr(KinDealStageId),
  /** In its own currency, never converted. */
  value: Schema.optional(KinMoney),
  /** The day it is expected; `expectedAllDay` as a task's `dueAllDay`. */
  expectedAt: Schema.NullOr(IsoDateTime),
  expectedAllDay: Schema.Boolean,
  party: Schema.Struct({
    ...KinRecordRef.fields,
    prospect: Schema.optional(Schema.Literal(true)),
  }),
  owner: KinWorkPrincipal,
  source: Schema.optional(Source),
  lostReason: Schema.optional(KinTrimmedText),
  /** Private, by its own label or its client's. */
  sensitive: Schema.Boolean,
  next: Schema.NullOr(KinDealNext),
  /** With `next` null: it has an open follow-up this reader isn't shown. Absent from older hosts. */
  nextHidden: Schema.optional(Schema.Boolean),
  quote: Schema.optional(KinDealQuote),
  /** The worries raised on it, in the order they were put; absent from older hosts and when none. */
  concerns: Schema.optional(Schema.Array(KinDealConcern)),
  can: KinDealCan,
  rev: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type KinDealRow = typeof KinDealRow.Type;

/** Deals counted, with their value per currency; a deal with no value counts only in `count`. */
export const KinDealTotals = Schema.Struct({
  count: NonNegativeInt,
  values: Schema.Array(KinMoney),
});
export type KinDealTotals = typeof KinDealTotals.Type;

/** A deal as "This week in deals" lists it; `from` and `to` are a move's stage names. */
export const KinDealWeekRow = Schema.Struct({
  key: KinRecordKey,
  title: KinTrimmedText,
  party: KinTrimmedText,
  owner: KinWorkPrincipal,
  value: Schema.optional(KinMoney),
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
});
export type KinDealWeekRow = typeof KinDealWeekRow.Type;
/** One person's (or agent's) deals by who looks after them. */
export const KinDealPersonNumbers = Schema.Struct({
  owner: KinWorkPrincipal,
  open: KinDealTotals,
  wonThisMonth: KinDealTotals,
  /** Open deals whose next step's day is behind today. */
  late: NonNegativeInt,
});
export type KinDealPersonNumbers = typeof KinDealPersonNumbers.Type;
/**
 * The Deals tab's figures, counted by the host over the deals the reader sees, each per currency.
 * Months, the week (from Monday) and today are the company's, in its zone.
 */
export const KinDealNumbers = Schema.Struct({
  /** `2026-11`, and the month before. */
  month: Schema.String,
  lastMonth: Schema.String,
  /** The week's first day, `YYYY-MM-DD`. */
  weekStart: KinDay,
  open: KinDealTotals,
  stages: Schema.Array(Schema.Struct({ name: Schema.String, ...KinDealTotals.fields })),
  wonThisMonth: KinDealTotals,
  /** The owner level only, from here on to `late`. */
  wonLastMonth: Schema.optional(KinDealTotals),
  lostThisMonth: Schema.optional(KinDealTotals),
  lostLastMonth: Schema.optional(KinDealTotals),
  /** Deals decided in the last 90 days, and how many of those were won. */
  winRate: Schema.optional(Schema.Struct({ won: NonNegativeInt, decided: NonNegativeInt })),
  /** Prospects added this month, by where they came from (`null`: not said). */
  sources: Schema.optional(
    Schema.Array(Schema.Struct({ source: Schema.NullOr(Schema.String), count: NonNegativeInt })),
  ),
  late: Schema.optional(NonNegativeInt),
  /** This week: the owner level's of every deal, a sales person's of their own; absent otherwise. */
  week: Schema.optional(
    Schema.Struct({
      won: Schema.Array(KinDealWeekRow),
      lost: Schema.Array(KinDealWeekRow),
      new: Schema.Array(KinDealWeekRow),
      moved: Schema.Array(KinDealWeekRow),
      /** Each group's whole count, past the 50 listed. */
      counts: Schema.Struct({
        won: NonNegativeInt,
        lost: NonNegativeInt,
        new: NonNegativeInt,
        moved: NonNegativeInt,
      }),
    }),
  ),
  /** Everyone's for the owner level; a sales person's own only. */
  people: Schema.Array(KinDealPersonNumbers),
});
export type KinDealNumbers = typeof KinDealNumbers.Type;

export const KIN_DEALS_CAP = 1_000;
export const KinDealsInput = Schema.Struct({
  orgId: KinOrgId,
  /** One client's or prospect's deals, open first. */
  party: Schema.optional(KinRecordKey),
  owner: Schema.optional(KinWorkPrincipal),
  /** Only the deals that raised this concern, by its label as What we hear counts it. */
  concern: Schema.optional(KinDealConcern.fields.label),
  /** Default every state with `party` or `concern`, open without them. */
  state: Schema.optional(KinDealState),
  /** The deals a campaign's results count: those at clients and prospects that came from it. */
  campaign: Schema.optional(KinRecordKey),
});
export type KinDealsInput = typeof KinDealsInput.Type;
export const KinDealsResult = Schema.Struct({
  stages: Schema.Array(KinDealStage),
  /** Open by stage and expected day; won and lost newest first. At most `KIN_DEALS_CAP`. */
  deals: Schema.Array(KinDealRow),
  /** Deals past the cap, left out. */
  more: NonNegativeInt,
  /** Every open deal the reader sees under these filters, past the cap too. */
  open: KinDealTotals,
  /** Whether the reader may add a deal (on `party`, when given). */
  canCreate: Schema.Boolean,
  /**
   * The concerns raised on the deals the reader sees under these filters, whatever their state,
   * most deals first; absent from older hosts.
   */
  concerns: Schema.optional(Schema.Array(KinDealConcernCount)),
  /**
   * The figures, whatever the filters: only without `party`, and only once the reader sees a deal;
   * absent from older hosts.
   */
  numbers: Schema.optional(KinDealNumbers),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinDealsResult = typeof KinDealsResult.Type;

export const KinDealPageInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinDealPageInput = typeof KinDealPageInput.Type;
export const KinDealPage = Schema.Struct({
  deal: KinDealRow,
  stages: Schema.Array(KinDealStage),
  notes: KinText,
  /** Newest first, at most 50, as far as the reader may read them. */
  changes: Schema.Array(KinRecordChange),
  /** Open follow-ups linked to it, soonest first. */
  steps: Schema.Array(KinDealNext),
  /** Its client's quotes the reader may see and link, newest first; only when it may edit. */
  quotes: Schema.optional(Schema.Array(KinDealQuote)),
  /** Promises linked to it that the reader sees, not dropped: ours, then theirs, each by day. */
  promises: Schema.optional(Schema.Array(KinRecord)),
  seq: NonNegativeInt,
});
export type KinDealPage = typeof KinDealPage.Type;

/** A follow-up: a task we owe the client, held by whoever makes it, linked to the deal. */
export const KinDealStepInput = Schema.Struct({
  title: Title,
  /** A `YYYY-MM-DD` day with `dueAllDay` is that day in the owner's zone. */
  dueAt: Schema.optional(IsoDateTime),
  dueAllDay: Schema.optional(Schema.Boolean),
});
export type KinDealStepInput = typeof KinDealStepInput.Type;

export const KinDealCreateInput = Schema.Struct({
  orgId: KinOrgId,
  /** A client's or prospect's key; a vendor is refused. */
  party: KinRecordKey,
  title: Title,
  /** Default the first stage. */
  stage: Schema.optional(KinDealStageId),
  value: Schema.optional(KinMoney),
  expectedOn: Schema.optional(KinDay),
  /** Default the client's own. */
  source: Schema.optional(Source),
  /** Default whoever adds it. */
  owner: Schema.optional(KinWorkPrincipal),
  sensitive: Schema.optional(Schema.Boolean),
  notes: Schema.optional(KinText.check(Schema.isMaxLength(4_000))),
  /** A quote of the same client to link. */
  quote: Schema.optional(KinRecordKey),
  /** Its first next step, made in the same step. */
  next: Schema.optional(KinDealStepInput),
  clientRequestId: RequestId,
});
export type KinDealCreateInput = typeof KinDealCreateInput.Type;

/** Only the fields given change; `null` clears one. `owner` hands it over. */
export const KinDealUpdateInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  title: Schema.optional(Title),
  notes: Schema.optional(KinText.check(Schema.isMaxLength(4_000))),
  value: Schema.optional(Schema.NullOr(KinMoney)),
  expectedOn: Schema.optional(Schema.NullOr(KinDay)),
  source: Schema.optional(Schema.NullOr(Source)),
  owner: Schema.optional(KinWorkPrincipal),
  sensitive: Schema.optional(Schema.Boolean),
  quote: Schema.optional(Schema.NullOr(KinRecordKey)),
  /** The whole list as it should stand, such as one taken off; empty or null clears them. */
  concerns: Schema.optional(Schema.NullOr(Schema.Array(KinDealConcern))),
});
export type KinDealUpdateInput = typeof KinDealUpdateInput.Type;

export const KinDealMove = Schema.Union([
  Schema.TaggedStruct("stage", { stage: KinDealStageId }),
  Schema.TaggedStruct("won", {}),
  /** One line on why. */
  Schema.TaggedStruct("lost", { reason: Reason }),
  /** Back to open, in its last stage if that is still there. */
  Schema.TaggedStruct("reopen", {}),
]);
export type KinDealMove = typeof KinDealMove.Type;
export const KinDealMoveInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  rev: NonNegativeInt,
  to: KinDealMove,
});
export type KinDealMoveInput = typeof KinDealMoveInput.Type;
export const KinDealResult = Schema.Struct({
  deal: KinDealRow,
  /** Winning it made its prospect a client, in the same step. */
  becameClient: Schema.optional(Schema.Literal(true)),
});
export type KinDealResult = typeof KinDealResult.Type;

/** A new client's first deal, made with it: what it is and about how much. */
export const KinPartyFirstDeal = Schema.Struct({
  title: Title,
  value: KinMoney,
  /** Default the first stage. */
  stage: Schema.optional(KinDealStageId),
  expectedOn: Schema.optional(KinDay),
  next: Schema.optional(KinDealStepInput),
});
export type KinPartyFirstDeal = typeof KinPartyFirstDeal.Type;
/** A new client and its deal in one step when Deals is on. */
export const KinPartyWithDealCreateInput = Schema.Struct({
  ...KinPartyCreateInput.fields,
  deal: KinPartyFirstDeal,
  acceptDealLeftOut: Schema.optional(Schema.Literal(true)),
});
export type KinPartyWithDealCreateInput = typeof KinPartyWithDealCreateInput.Type;
export const KinPartyWithDealResult = Schema.Union([
  Schema.Struct({ party: KinPartyDetail, deal: KinDealRow }),
  Schema.Struct({ party: KinPartyDetail, dealLeftOut: KinTrimmedText }),
]);
export type KinPartyWithDealResult = typeof KinPartyWithDealResult.Type;

export const KinDealAddStepInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  step: KinDealStepInput,
  clientRequestId: RequestId,
});
export type KinDealAddStepInput = typeof KinDealAddStepInput.Type;

export const KinDealStagesInput = Schema.Struct({ orgId: KinOrgId });
export type KinDealStagesInput = typeof KinDealStagesInput.Type;
export const KinDealStagesResult = Schema.Struct({
  stages: Schema.Array(KinDealStage),
  /** The stages' version; a change names the one it was made on. */
  rev: NonNegativeInt,
  /** Whether the reader may change them: the owner and co-owners. */
  can: Schema.Boolean,
  /** Open deals in each stage, by stage id, of every deal in the company. */
  open: Schema.Record(Schema.String, NonNegativeInt),
  /** Days with no contact, note, stage move or next-step change before a deal is quiet; absent from older hosts. */
  quietDays: Schema.optional(NonNegativeInt),
});
export type KinDealStagesResult = typeof KinDealStagesResult.Type;

export const KIN_DEAL_QUIET_DAYS_MAX = 365;
/** "A deal goes quiet after N days": written to the playbook that sets it. Owner and co-owners. */
export const KinDealQuietDaysSetInput = Schema.Struct({
  orgId: KinOrgId,
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: KIN_DEAL_QUIET_DAYS_MAX })),
});
export type KinDealQuietDaysSetInput = typeof KinDealQuietDaysSetInput.Type;
/**
 * The whole list in its new order: a stage without an id is new. A stage left out is removed, and
 * its open deals move to `moveTo[id]`, each logged.
 */
export const KinDealStagesSetInput = Schema.Struct({
  orgId: KinOrgId,
  rev: NonNegativeInt,
  stages: Schema.Array(
    Schema.Struct({ id: Schema.optional(KinDealStageId), name: KinDealStageName }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(KIN_DEAL_STAGES_MAX)),
  moveTo: Schema.optional(Schema.Record(KinDealStageId, KinDealStageId)),
});
export type KinDealStagesSetInput = typeof KinDealStagesSetInput.Type;

const KIN_DEAL_WS_METHODS = {
  deals: "kin.work.deals",
  deal: "kin.work.deal",
  createDeal: "kin.work.createDeal",
  createPartyWithDeal: "kin.work.createPartyWithDeal",
  updateDeal: "kin.work.updateDeal",
  moveDeal: "kin.work.moveDeal",
  dealStep: "kin.work.dealStep",
  dealStages: "kin.work.dealStages",
  setDealStages: "kin.work.setDealStages",
  setDealQuietDays: "kin.work.setDealQuietDays",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinDealRpcs = [
  Rpc.make(KIN_DEAL_WS_METHODS.deals, { payload: KinDealsInput, success: KinDealsResult, error }),
  Rpc.make(KIN_DEAL_WS_METHODS.deal, { payload: KinDealPageInput, success: KinDealPage, error }),
  Rpc.make(KIN_DEAL_WS_METHODS.createDeal, {
    payload: KinDealCreateInput,
    success: KinDealResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.createPartyWithDeal, {
    payload: KinPartyWithDealCreateInput,
    success: KinPartyWithDealResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.updateDeal, {
    payload: KinDealUpdateInput,
    success: KinDealResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.moveDeal, {
    payload: KinDealMoveInput,
    success: KinDealResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.dealStep, {
    payload: KinDealAddStepInput,
    success: KinDealResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.dealStages, {
    payload: KinDealStagesInput,
    success: KinDealStagesResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.setDealStages, {
    payload: KinDealStagesSetInput,
    success: KinDealStagesResult,
    error,
  }),
  Rpc.make(KIN_DEAL_WS_METHODS.setDealQuietDays, {
    payload: KinDealQuietDaysSetInput,
    success: KinDealStagesResult,
    error,
  }),
] as const;

export const KIN_DEAL_RPC_SCOPES = {
  // A teammate's session reaches deals; the service shows and changes only what is theirs.
  [KIN_DEAL_WS_METHODS.deals]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.deal]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.createDeal]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.createPartyWithDeal]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.updateDeal]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.moveDeal]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.dealStep]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.dealStages]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.setDealStages]: AuthKinChatScope,
  [KIN_DEAL_WS_METHODS.setDealQuietDays]: AuthKinChatScope,
} as const;
