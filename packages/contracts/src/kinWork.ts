import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinText,
  KinTrimmedText,
} from "./kinChat.ts";

/**
 * Work: everything someone owes someone, as entries in lists. Slice 1 has the built-in Work list
 * only, owner-only reads, and two owner mutations (create, assign). People and amounts come later.
 */
export const KinRecordId = TrimmedNonEmptyString.pipe(Schema.brand("KinRecordId"));
export type KinRecordId = typeof KinRecordId.Type;
/** The short handle leads cite and people see small, such as `W-142`. Server-issued per list. */
export const KinRecordKey = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}$/),
);
export type KinRecordKey = typeof KinRecordKey.Type;

/** Five fixed classes; a list may rename their labels later, never add one. */
const KIN_RECORD_STATES = ["open", "doing", "waiting", "done", "dropped"] as const;
export const KinRecordState = Schema.Literals(KIN_RECORD_STATES);
export type KinRecordState = typeof KinRecordState.Type;
/** The Work list's kinds: one field, so a request that turns out to be a bug keeps its key. */
export const KinRecordCategory = Schema.Literals(["task", "issue", "obligation"]);
export type KinRecordCategory = typeof KinRecordCategory.Type;
/** Who has to do it: `theirs` when the other party owes it and the owner is whoever chases. */
export const KinRecordSide = Schema.Literals(["ours", "theirs"]);
export type KinRecordSide = typeof KinRecordSide.Type;

/** An owner, assigner or the one waited on: a person or a lead, always someone on our side. */
export const KinWorkPrincipal = Schema.Union([
  Schema.TaggedStruct("person", { personId: KinPersonId }),
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
]);
export type KinWorkPrincipal = typeof KinWorkPrincipal.Type;
/** Who made a change: a principal, or Kin itself from a worker or GitHub event. */
export const KinWorkActor = Schema.Union([
  ...KinWorkPrincipal.members,
  Schema.TaggedStruct("system", {}),
]);
export type KinWorkActor = typeof KinWorkActor.Type;

const KinPullRequestRef = Schema.Struct({ url: Schema.String, number: NonNegativeInt });

/** One slim list row, about 150 bytes: what a list, the profile and the prompt show. */
export const KinRecord = Schema.Struct({
  recordId: KinRecordId,
  orgId: KinOrgId,
  key: KinRecordKey,
  title: KinTrimmedText,
  state: KinRecordState,
  /** Set only while `waiting`. */
  waitingOn: Schema.NullOr(KinWorkPrincipal),
  owner: KinWorkPrincipal,
  category: Schema.NullOr(KinRecordCategory),
  side: KinRecordSide,
  /** When it is due. `dueAllDay` means a calendar day in the owner's time zone; `dueAt` is its end. */
  dueAt: Schema.NullOr(IsoDateTime),
  dueAllDay: Schema.Boolean,
  /** Computed, never stored: due has passed and it is neither done nor dropped. */
  late: Schema.Boolean,
  /** False while a lead only inferred it. */
  confirmed: Schema.Boolean,
  sensitive: Schema.Boolean,
  /** A worker linked to it is running now. */
  working: Schema.Boolean,
  /** The latest pull request linked to it. */
  pullRequest: Schema.NullOr(KinPullRequestRef),
  rev: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type KinRecord = typeof KinRecord.Type;

export const KinRecordLinkKind = Schema.Literals([
  "message",
  "worker",
  "pull_request",
  "record",
  "memory",
  "url",
]);
export type KinRecordLinkKind = typeof KinRecordLinkKind.Type;
/** `source`: where it came from. `attempt`: a worker doing it. `evidence`: proof it happened. */
export const KinRecordRelation = Schema.Literals([
  "source",
  "attempt",
  "evidence",
  "relates",
  "blocks",
  "parent",
]);
export type KinRecordRelation = typeof KinRecordRelation.Type;
export const KinRecordLink = Schema.Struct({
  kind: KinRecordLinkKind,
  relation: KinRecordRelation,
  /** A message, worker, record or memory item id, or a URL. */
  target: Schema.String,
  /** Message links name their chat so a client can open it. */
  chatId: Schema.NullOr(KinChatId),
  // Server-written: a PR number, a worker title. Plain text, never markup.
  label: Schema.NullOr(KinText),
  createdAt: IsoDateTime,
});
export type KinRecordLink = typeof KinRecordLink.Type;

export const KinRecordChangeVia = Schema.Literals(["lead", "owner", "worker", "github", "import"]);
export type KinRecordChangeVia = typeof KinRecordChangeVia.Type;
/** One line of an entry's history. Values are shown as text: a state, a key, an ISO time. */
export const KinRecordChange = Schema.Struct({
  seq: NonNegativeInt,
  at: IsoDateTime,
  by: KinWorkActor,
  via: KinRecordChangeVia,
  kind: Schema.Literals(["created", "updated", "linked"]),
  fields: Schema.Array(
    Schema.Struct({
      field: TrimmedNonEmptyString,
      from: Schema.NullOr(Schema.String),
      to: Schema.NullOr(Schema.String),
    }),
  ),
});
export type KinRecordChange = typeof KinRecordChange.Type;

/** An entry with everything the entry sheet shows. */
export const KinRecordDetail = Schema.Struct({
  ...KinRecord.fields,
  notes: KinText,
  /** The chat and message it came from, when it came from one. */
  source: Schema.Struct({
    chatId: Schema.NullOr(KinChatId),
    messageId: Schema.NullOr(KinMessageId),
  }),
  /** The human who gave it to its current owner. The only authority a lead's work on it has. */
  assignedBy: Schema.NullOr(KinWorkPrincipal),
  assignedAt: Schema.NullOr(IsoDateTime),
  createdBy: KinWorkActor,
  links: Schema.Array(KinRecordLink),
  /** Newest first, at most `KIN_RECORD_CHANGES_CAP`. */
  changes: Schema.Array(KinRecordChange),
});
export type KinRecordDetail = typeof KinRecordDetail.Type;
export const KIN_RECORD_CHANGES_CAP = 50;
export const KIN_RECORDS_PAGE_CAP = 100;

export const KinWorkListInput = Schema.Struct({
  orgId: KinOrgId,
  /** A lead's profile and the per-owner rows of the Work screen. */
  owner: Schema.optional(KinWorkPrincipal),
  states: Schema.optional(Schema.Array(KinRecordState)),
  /** Neither done nor dropped. Ignored when `states` is set. */
  open: Schema.optional(Schema.Boolean),
  late: Schema.optional(Schema.Boolean),
  /** Due at or before this time. */
  dueBy: Schema.optional(IsoDateTime),
  /** Case-insensitive match on title and notes. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  /** From the previous page's `nextCursor`. */
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
  ),
});
export type KinWorkListInput = typeof KinWorkListInput.Type;
/** Ordered open first, then soonest due, then key. `seq` is the change number the page is as of. */
export const KinWorkListResult = Schema.Struct({
  records: Schema.Array(KinRecord),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinWorkListResult = typeof KinWorkListResult.Type;

export const KinWorkGetInput = Schema.Struct({ orgId: KinOrgId, key: KinRecordKey });
export type KinWorkGetInput = typeof KinWorkGetInput.Type;

/** Counts for the pinned row and the Work screen's people and leads section; under 2 KB. */
const KinWorkCounts = {
  open: NonNegativeInt,
  doing: NonNegativeInt,
  waiting: NonNegativeInt,
  late: NonNegativeInt,
  dueThisWeek: NonNegativeInt,
};
export const KinWorkSummaryInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkSummaryInput = typeof KinWorkSummaryInput.Type;
export const KinWorkSummary = Schema.Struct({
  ...KinWorkCounts,
  /** Every owner with an open entry, most open first. */
  owners: Schema.Array(Schema.Struct({ owner: KinWorkPrincipal, ...KinWorkCounts })),
  seq: NonNegativeInt,
  asOf: IsoDateTime,
});
export type KinWorkSummary = typeof KinWorkSummary.Type;

/**
 * Live updates without lists on the socket: the latest change number now, then again after each
 * change. A client with a list, entry or count open refetches it, debounced.
 */
export const KinWorkSubscribeInput = Schema.Struct({ orgId: KinOrgId });
export type KinWorkSubscribeInput = typeof KinWorkSubscribeInput.Type;
export const KinWorkEvent = Schema.Union([Schema.TaggedStruct("changed", { seq: NonNegativeInt })]);
export type KinWorkEvent = typeof KinWorkEvent.Type;

/** The owner's "New": a short form. Long text belongs in chat. */
export const KinWorkCreateInput = Schema.Struct({
  orgId: KinOrgId,
  title: KinTrimmedText.check(Schema.isMaxLength(280)),
  /** Defaults to the owner. A lead given work this way is woken to do it. */
  owner: Schema.optional(KinWorkPrincipal),
  dueAt: Schema.optional(IsoDateTime),
  dueAllDay: Schema.optional(Schema.Boolean),
  notes: Schema.optional(KinText.check(Schema.isMaxLength(4_000))),
  category: Schema.optional(KinRecordCategory),
  /** A retry with the same id returns the same entry. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type KinWorkCreateInput = typeof KinWorkCreateInput.Type;

/** The owner gives an entry to a lead or a person. Given to a lead, it is an instruction to do it. */
export const KinWorkAssignInput = Schema.Struct({
  orgId: KinOrgId,
  key: KinRecordKey,
  to: KinWorkPrincipal,
  /** The revision the owner saw; a different current one is refused as a conflict. */
  rev: Schema.optional(NonNegativeInt),
});
export type KinWorkAssignInput = typeof KinWorkAssignInput.Type;

const KIN_WORK_WS_METHODS = {
  summary: "kin.work.summary",
  list: "kin.work.list",
  get: "kin.work.get",
  subscribe: "kin.work.subscribe",
  create: "kin.work.create",
  assign: "kin.work.assign",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
// Owner only, on the server; a chat-only session is refused before any handler runs.
export const KinWorkRpcs = [
  Rpc.make(KIN_WORK_WS_METHODS.summary, {
    payload: KinWorkSummaryInput,
    success: KinWorkSummary,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.list, {
    payload: KinWorkListInput,
    success: KinWorkListResult,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.get, { payload: KinWorkGetInput, success: KinRecordDetail, error }),
  Rpc.make(KIN_WORK_WS_METHODS.subscribe, {
    payload: KinWorkSubscribeInput,
    success: KinWorkEvent,
    error,
    stream: true,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.create, {
    payload: KinWorkCreateInput,
    success: KinRecordDetail,
    error,
  }),
  Rpc.make(KIN_WORK_WS_METHODS.assign, {
    payload: KinWorkAssignInput,
    success: KinRecordDetail,
    error,
  }),
] as const;

export const KIN_WORK_RPC_SCOPES = {
  [KIN_WORK_WS_METHODS.summary]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.list]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.get]: AuthOrchestrationReadScope,
  [KIN_WORK_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  // Giving a lead work starts agent work on the owner's budget, as a message to it does.
  [KIN_WORK_WS_METHODS.create]: AuthOrchestrationOperateScope,
  [KIN_WORK_WS_METHODS.assign]: AuthOrchestrationOperateScope,
} as const;
