import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, KinText, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinOrgId } from "./kinChat.ts";
import { TimeZone } from "./kinTime.ts";

/**
 * What Kin keeps watch on (`kin_watches`): one open loop, its next look and what the last one found.
 * A kind names how the loop is found and checked; a host may add kinds, so it is a plain string.
 */
const KIN_WATCH_KINDS = [
  "asked",
  "invoice_paid",
  "reply_owed",
  "task_out",
  "turn_failed",
  "pr",
  "host",
  "prepare",
  "arrival",
] as const;
export type KinWatchKind = (typeof KIN_WATCH_KINDS)[number];

export const KinWatchState = Schema.Literals(["open", "closed", "stopped"]);
export type KinWatchState = typeof KinWatchState.Type;

/** What one look found. `skipped_limit`: a look that needed a model waited on the Daily limit. */
export const KinWatchOutcome = Schema.Literals([
  "nothing_new",
  "closed",
  "changed",
  "problem",
  "cant_tell",
  "skipped_limit",
]);
export type KinWatchOutcome = typeof KinWatchOutcome.Type;

/** Why a look ran: a person asked (their watch, Look now, Watch again), an agent's mark, or the round. */
export const KinWatchWhy = Schema.Literals(["asked", "again", "routine"]);
export type KinWatchWhy = typeof KinWatchWhy.Type;

/** What a look did, as the log names it. */
export const KinWatchDid = Schema.Literals([
  "problem",
  "closed",
  "checked_work",
  "prepared",
  "nothing_new",
]);
export type KinWatchDid = typeof KinWatchDid.Type;

/** Who closed or stopped a watch. `you` is the reader. */
export const KinWatchActor = Schema.Struct({
  kind: Schema.Literals(["person", "agent", "code"]),
  name: Schema.NullOr(KinText),
  you: Schema.Boolean,
});
export type KinWatchActor = typeof KinWatchActor.Type;

/**
 * Exactly what one watch line shows (`kinWatchLine` in client-runtime words it). A record read
 * carries this for the record's watch; nothing more rides on every record.
 */
export const KinWatchLine = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  /** What it is about, such as "Brightwell Labs' INV-11", or a person's own words. */
  about: KinText,
  state: KinWatchState,
  lookedAt: Schema.NullOr(IsoDateTime),
  nextLookAt: Schema.NullOr(IsoDateTime),
  lastOutcome: Schema.NullOr(KinWatchOutcome),
  /** What the last look found, in code's words: "the work failed". */
  lastLine: Schema.NullOr(KinText),
  /** Look now was asked and the look hasn't run yet. */
  looking: Schema.Boolean,
  /** Its record is set aside: no look until the hold ends (null: until someone lifts it). */
  aside: Schema.NullOr(Schema.Struct({ until: Schema.NullOr(IsoDateTime) })),
  closedAt: Schema.NullOr(IsoDateTime),
  /** How it closed: "INV-11 was paid on 25 Nov". */
  closedHow: Schema.NullOr(KinText),
  closedBy: Schema.NullOr(KinWatchActor),
});
export type KinWatchLine = typeof KinWatchLine.Type;

export const KinWatch = Schema.Struct({
  ...KinWatchLine.fields,
  source: TrimmedNonEmptyString,
  /** What would close it, in words. */
  closesWhen: KinText,
  /** The record it is about, when it is about one. */
  recordKey: Schema.NullOr(TrimmedNonEmptyString),
  agentId: Schema.NullOr(KinAgentId),
  agentName: Schema.NullOr(KinText),
  latestBy: Schema.NullOr(IsoDateTime),
  /** Set after an agent read outside text, such as a client's mail. */
  setAfterOutside: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type KinWatch = typeof KinWatch.Type;

/** Every watch this reader may see, or only those on one record. Open first, then newest. */
export const KinWatchesListInput = Schema.Struct({
  orgId: KinOrgId,
  recordKey: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type KinWatchesListInput = typeof KinWatchesListInput.Type;

export const KinWatchesListResult = Schema.Struct({ watches: Schema.Array(KinWatch) });
export type KinWatchesListResult = typeof KinWatchesListResult.Type;

/** One look in the log, with the watch it was about. */
export const KinWatchLogLook = Schema.Struct({
  lookId: TrimmedNonEmptyString,
  at: IsoDateTime,
  why: KinWatchWhy,
  did: KinWatchDid,
  outcome: KinWatchOutcome,
  line: KinText,
  watchId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  about: KinText,
  recordKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type KinWatchLogLook = typeof KinWatchLogLook.Type;

/** A run of nothing-new looks, newest first, folded on the host: `count` of them, `looks` at most 50. */
export const KinWatchLogFolded = Schema.Struct({
  at: IsoDateTime,
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  looks: Schema.Array(KinWatchLogLook),
});
export type KinWatchLogFolded = typeof KinWatchLogFolded.Type;

export const KinWatchLogRow = Schema.Union([
  Schema.TaggedStruct("look", { look: KinWatchLogLook }),
  Schema.TaggedStruct("folded", { folded: KinWatchLogFolded }),
]);
export type KinWatchLogRow = typeof KinWatchLogRow.Type;

/**
 * One day of the log in `timeZone` (the reader's; the company's when left out): `day` when given,
 * else today. Only looks on watches this reader may see.
 */
export const KinWatchesLogInput = Schema.Struct({
  orgId: KinOrgId,
  timeZone: Schema.optional(TimeZone),
  /** `2026-11-25`. */
  day: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
  watchId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
});
export type KinWatchesLogInput = typeof KinWatchesLogInput.Type;

export const KinWatchesLogResult = Schema.Struct({
  /** The day shown, `2026-11-25`; today when nothing was looked at yet. */
  day: Schema.String,
  /** Newest first. */
  rows: Schema.Array(KinWatchLogRow),
  /** The latest earlier day with a look, to page to. */
  earlier: Schema.NullOr(Schema.String),
  /** The soonest next look on an open watch this reader sees. */
  nextLookAt: Schema.NullOr(IsoDateTime),
  /** Open watches this reader sees. */
  watching: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type KinWatchesLogResult = typeof KinWatchesLogResult.Type;

export const KinWatchActInput = Schema.Struct({
  orgId: KinOrgId,
  watchId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type KinWatchActInput = typeof KinWatchActInput.Type;

/** Look now, Stop watching and Watch again answer with the watch as it stands after. */
export const KinWatchActResult = Schema.Struct({ watch: KinWatch });
export type KinWatchActResult = typeof KinWatchActResult.Type;

const KIN_WATCH_WS_METHODS = {
  list: "kin.watches.list",
  log: "kin.watches.log",
  look: "kin.watches.look",
  stop: "kin.watches.stop",
  again: "kin.watches.again",
} as const;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);

export const KinWatchRpcs = [
  Rpc.make(KIN_WATCH_WS_METHODS.list, {
    payload: KinWatchesListInput,
    success: KinWatchesListResult,
    error,
  }),
  Rpc.make(KIN_WATCH_WS_METHODS.log, {
    payload: KinWatchesLogInput,
    success: KinWatchesLogResult,
    error,
  }),
  Rpc.make(KIN_WATCH_WS_METHODS.look, {
    payload: KinWatchActInput,
    success: KinWatchActResult,
    error,
  }),
  Rpc.make(KIN_WATCH_WS_METHODS.stop, {
    payload: KinWatchActInput,
    success: KinWatchActResult,
    error,
  }),
  Rpc.make(KIN_WATCH_WS_METHODS.again, {
    payload: KinWatchActInput,
    success: KinWatchActResult,
    error,
  }),
] as const;

export const KIN_WATCH_RPC_SCOPES = {
  [KIN_WATCH_WS_METHODS.list]: AuthKinChatScope,
  [KIN_WATCH_WS_METHODS.log]: AuthKinChatScope,
  [KIN_WATCH_WS_METHODS.look]: AuthKinChatScope,
  [KIN_WATCH_WS_METHODS.stop]: AuthKinChatScope,
  [KIN_WATCH_WS_METHODS.again]: AuthKinChatScope,
} as const;

/** The longest a watch line offers Watch again after it closed or was stopped. */
export const KIN_WATCH_AGAIN_DAYS = 3;
