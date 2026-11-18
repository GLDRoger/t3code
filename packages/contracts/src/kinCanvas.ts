import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { KinAgentId, KinChatError, KinChatId, KinOrgId, KinPresenceState } from "./kinChat.ts";
import { KinRecordKey, KinRecordRef, KinWorkActor } from "./kinWork.ts";

/**
 * The canvas stores only where Kin's own records sit, its widgets and each person's last look.
 * Entries reach it through Work's and Docs' live streams, so every viewer rule is theirs.
 */

/** A widget's id, server-issued. */
export const KinCanvasWidgetId = Schema.String.check(Schema.isPattern(/^cw_[a-z0-9]{6,32}$/));
export type KinCanvasWidgetId = typeof KinCanvasWidgetId.Type;

/** What sits on the canvas at a stored place: an entry by key, or a widget by id. */
export const KinCanvasItemKey = Schema.Union([KinRecordKey, KinCanvasWidgetId]);
export type KinCanvasItemKey = typeof KinCanvasItemKey.Type;

const KinCanvasCoord = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: -1e6, maximum: 1e6 }),
);

/** Where one card sits, in canvas units. One layout per company; each person keeps their own view. */
export const KinCanvasPlace = Schema.Struct({
  key: KinCanvasItemKey,
  x: KinCanvasCoord,
  y: KinCanvasCoord,
});
export type KinCanvasPlace = typeof KinCanvasPlace.Type;

/**
 * `progress`: a project's tasks done of all of them. `countdown`: time left to an entry's due
 * day, or a project's target. `facts`: a project's open, doing, waiting and late tasks.
 */
export const KinCanvasWidgetKind = Schema.Literals(["progress", "countdown", "facts"]);
export type KinCanvasWidgetKind = typeof KinCanvasWidgetKind.Type;

/** A widget's value, worked out by the server from the viewer's own read of its source. */
export const KinCanvasWidgetValue = Schema.Union([
  Schema.TaggedStruct("progress", { done: NonNegativeInt, total: NonNegativeInt }),
  /** `at` is null when the source has no due day or target. The client counts with its own clock. */
  Schema.TaggedStruct("countdown", {
    at: Schema.NullOr(IsoDateTime),
    allDay: Schema.Boolean,
    /** The source is done or dropped. */
    closed: Schema.Boolean,
  }),
  Schema.TaggedStruct("facts", {
    /** Every task not done or dropped; `doing` and `waiting` are among them. */
    open: NonNegativeInt,
    doing: NonNegativeInt,
    waiting: NonNegativeInt,
    late: NonNegativeInt,
  }),
  /** The source was removed. A source the viewer can't read sends no widget at all. */
  Schema.TaggedStruct("gone", {}),
]);
export type KinCanvasWidgetValue = typeof KinCanvasWidgetValue.Type;

export const KinCanvasWidget = Schema.Struct({
  id: KinCanvasWidgetId,
  kind: KinCanvasWidgetKind,
  /** The entry it counts. Its title is as it is now; a gone source keeps the last title seen. */
  source: KinRecordRef,
  value: KinCanvasWidgetValue,
  addedBy: KinWorkActor,
  addedAt: IsoDateTime,
});
export type KinCanvasWidget = typeof KinCanvasWidget.Type;

/** One entry someone else changed since the viewer last looked, its changes folded into one. */
export const KinCanvasChange = Schema.Struct({
  key: KinRecordKey,
  title: Schema.String,
  /** The latest change's author; `others` counts anyone else who changed it too. */
  by: KinWorkActor,
  others: NonNegativeInt,
  /** How many changes were folded. */
  count: NonNegativeInt,
  at: IsoDateTime,
  /** A new entry, as opposed to a change to one the viewer could already see. */
  created: Schema.Boolean,
});
export type KinCanvasChange = typeof KinCanvasChange.Type;

/** What changed since the viewer's last look, newest first, at most 40. */
export const KinCanvasSince = Schema.Struct({
  /** Null on a first visit: nothing is called new. */
  seenAt: Schema.NullOr(IsoDateTime),
  changes: Schema.Array(KinCanvasChange),
  /** Changed entries beyond the 40 sent. */
  more: NonNegativeInt,
});
export type KinCanvasSince = typeof KinCanvasSince.Type;

/**
 * An agent with a status line in a chat the viewer is in, and the entries its running wake-up
 * has changed so far that the viewer may read.
 */
export const KinCanvasActivity = Schema.Struct({
  agentId: KinAgentId,
  name: Schema.String,
  chatId: KinChatId,
  state: KinPresenceState,
  label: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  keys: Schema.Array(KinRecordKey),
});
export type KinCanvasActivity = typeof KinCanvasActivity.Type;

export const KinCanvasRead = Schema.Struct({
  /** Stored places of entries and widgets the viewer may see. Anything else sits where the client lays it out. */
  places: Schema.Array(KinCanvasPlace),
  widgets: Schema.Array(KinCanvasWidget),
  since: KinCanvasSince,
  activity: Schema.Array(KinCanvasActivity),
  /** Whether this viewer may move cards and add or remove widgets. */
  canArrange: Schema.Boolean,
});
export type KinCanvasRead = typeof KinCanvasRead.Type;

export const KinCanvasInput = Schema.Struct({ orgId: KinOrgId });
export type KinCanvasInput = typeof KinCanvasInput.Type;

/**
 * `kin.canvas.subscribe`: the read whole, then what moved. Places and widgets come as the
 * changed items; activity always as the whole list, which is short.
 */
export const KinCanvasEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { read: KinCanvasRead }),
  Schema.TaggedStruct("placed", { places: Schema.Array(KinCanvasPlace) }),
  Schema.TaggedStruct("unplaced", { keys: Schema.Array(KinCanvasItemKey) }),
  Schema.TaggedStruct("widget", { widget: KinCanvasWidget }),
  Schema.TaggedStruct("widgetRemoved", { id: KinCanvasWidgetId }),
  Schema.TaggedStruct("activity", { activity: Schema.Array(KinCanvasActivity) }),
]);
export type KinCanvasEvent = typeof KinCanvasEvent.Type;

export const KinCanvasPlaceInput = Schema.Struct({
  orgId: KinOrgId,
  places: Schema.Array(KinCanvasPlace).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type KinCanvasPlaceInput = typeof KinCanvasPlaceInput.Type;

/** Back to where the canvas lays them out by itself. */
export const KinCanvasUnplaceInput = Schema.Struct({
  orgId: KinOrgId,
  keys: Schema.Array(KinCanvasItemKey).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export type KinCanvasUnplaceInput = typeof KinCanvasUnplaceInput.Type;

export const KinCanvasPlacesResult = Schema.Struct({ places: Schema.Array(KinCanvasPlace) });
export type KinCanvasPlacesResult = typeof KinCanvasPlacesResult.Type;

/** `progress` and `facts` count a project; `countdown` any entry with a due day or target. */
export const KinCanvasWidgetAddInput = Schema.Struct({
  orgId: KinOrgId,
  kind: KinCanvasWidgetKind,
  source: KinRecordKey,
  place: Schema.optional(Schema.Struct({ x: KinCanvasCoord, y: KinCanvasCoord })),
});
export type KinCanvasWidgetAddInput = typeof KinCanvasWidgetAddInput.Type;

export const KinCanvasWidgetRemoveInput = Schema.Struct({ orgId: KinOrgId, id: KinCanvasWidgetId });
export type KinCanvasWidgetRemoveInput = typeof KinCanvasWidgetRemoveInput.Type;

export const KinCanvasRemoved = Schema.Struct({ id: KinCanvasWidgetId });
export type KinCanvasRemoved = typeof KinCanvasRemoved.Type;

/** Moves the viewer's last look to now, so the next visit calls only later changes new. */
export const KinCanvasSeenResult = Schema.Struct({ seenAt: IsoDateTime });
export type KinCanvasSeenResult = typeof KinCanvasSeenResult.Type;

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinCanvasRpcs = [
  Rpc.make("kin.canvas.read", { payload: KinCanvasInput, success: KinCanvasRead, error }),
  Rpc.make("kin.canvas.subscribe", {
    payload: KinCanvasInput,
    success: KinCanvasEvent,
    error,
    stream: true,
  }),
  Rpc.make("kin.canvas.place", {
    payload: KinCanvasPlaceInput,
    success: KinCanvasPlacesResult,
    error,
  }),
  Rpc.make("kin.canvas.unplace", {
    payload: KinCanvasUnplaceInput,
    success: KinCanvasPlacesResult,
    error,
  }),
  Rpc.make("kin.canvas.widgetAdd", {
    payload: KinCanvasWidgetAddInput,
    success: KinCanvasWidget,
    error,
  }),
  Rpc.make("kin.canvas.widgetRemove", {
    payload: KinCanvasWidgetRemoveInput,
    success: KinCanvasRemoved,
    error,
  }),
  Rpc.make("kin.canvas.seen", { payload: KinCanvasInput, success: KinCanvasSeenResult, error }),
] as const;

export const KIN_CANVAS_RPC_SCOPES = {
  "kin.canvas.read": AuthKinChatScope,
  "kin.canvas.subscribe": AuthKinChatScope,
  "kin.canvas.place": AuthKinChatScope,
  "kin.canvas.unplace": AuthKinChatScope,
  "kin.canvas.widgetAdd": AuthKinChatScope,
  "kin.canvas.widgetRemove": AuthKinChatScope,
  "kin.canvas.seen": AuthKinChatScope,
} as const;
