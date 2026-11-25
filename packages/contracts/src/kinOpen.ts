import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { KinChatError, KinOrgId, KinWaitingItem } from "./kinChat.ts";
import { CanonicalUtcTimestamp } from "./kinLead.ts";
import { KinPulseFact, KinPulseListInput } from "./kinPulse.ts";
import { KinRecordKey } from "./kinWork.ts";

/**
 * Everything open for one person, computed by the host at read time: what needs attention, what
 * waits on them in chats, the tasks Tasks counts under their Needs you, and overdue invoices as
 * one row.
 */

export const KinOpenItem = Schema.Union([
  Schema.TaggedStruct("fact", { fact: KinPulseFact }),
  Schema.TaggedStruct("waiting", { waiting: KinWaitingItem }),
  Schema.TaggedStruct("task", {
    key: KinRecordKey,
    title: Schema.String.check(Schema.isMaxLength(300)),
    /** Absent for an undated task that waits on them, such as one handed back. */
    dueAt: Schema.optional(CanonicalUtcTimestamp),
    /** A day, not a time: shown as the day where the owner is. */
    dueAllDay: Schema.optional(Schema.Boolean),
    projectTitle: Schema.optional(Schema.String),
    clientTitle: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("money", { invoices: PositiveInt }),
]);
export type KinOpenItem = typeof KinOpenItem.Type;

export const KinOpenRow = Schema.Struct({
  /** "fact:<factKey>" | "waiting:<waitingId>" | "task:<recordKey>" | "money:overdue" */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(340)),
  late: Schema.Boolean,
  item: KinOpenItem,
});
export type KinOpenRow = typeof KinOpenRow.Type;

export const KinOpenCounts = Schema.Struct({
  /** Every row, uncapped: what Needs attention, or On me, counts. */
  needsYou: NonNegativeInt,
  /** The waiting rows, uncapped: Waiting on you and the evening summary. */
  waiting: NonNegativeInt,
  /**
   * The tasks Tasks counts under Needs you, uncapped, those a fact or a card stands for included:
   * the Tasks badge with the list's deal facts. Absent from older hosts.
   */
  tasks: Schema.optional(NonNegativeInt),
});
export type KinOpenCounts = typeof KinOpenCounts.Type;

export const KinOpenRead = Schema.Struct({
  asOf: CanonicalUtcTimestamp,
  counts: KinOpenCounts,
  /** At most 200, in the order Needs you shows them. */
  rows: Schema.Array(KinOpenRow),
});
export type KinOpenRead = typeof KinOpenRead.Type;

export const KinOpenReadInput = Schema.Struct({
  orgId: KinOrgId,
  acceptSenses: KinPulseListInput.fields.acceptSenses,
});
export type KinOpenReadInput = typeof KinOpenReadInput.Type;

export const KinOpenSubscribeInput = Schema.Struct({
  ...KinOpenReadInput.fields,
  /** The `hash` of the read held from an earlier session; unchanged, the stream starts `current`. */
  held: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type KinOpenSubscribeInput = typeof KinOpenSubscribeInput.Type;

/** The first read whole, or `current` when the held one stands; then what moved (`kinOpenApply`). */
export const KinOpenEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { read: KinOpenRead, hash: Schema.String }),
  Schema.TaggedStruct("current", { hash: Schema.String }),
  Schema.TaggedStruct("changed", {
    asOf: CanonicalUtcTimestamp,
    counts: KinOpenCounts,
    /** New rows, and held ones that changed. */
    updated: Schema.Array(KinOpenRow),
    removed: Schema.Array(KinOpenRow.fields.id),
    /** Every id in order; absent when it is the held order less `removed`, new ones last. */
    order: Schema.optional(Schema.Array(KinOpenRow.fields.id)),
    hash: Schema.String,
  }),
]);
export type KinOpenEvent = typeof KinOpenEvent.Type;
export type KinOpenChange = Extract<KinOpenEvent, { readonly _tag: "changed" }>;

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

const naturalOrder = (
  held: ReadonlyArray<string>,
  removed: ReadonlySet<string>,
  updated: ReadonlyArray<KinOpenRow>,
) => {
  const kept = held.filter((id) => !removed.has(id));
  const known = new Set(kept);
  return [...kept, ...updated.map((row) => row.id).filter((id) => !known.has(id))];
};

/**
 * What moved from `held` to `next`, as `kin.open.subscribe` sends it; null when nothing did.
 * `kinOpenApply(held, change)` gives `next` back.
 */
export function kinOpenDiff(
  held: KinOpenRead,
  next: KinOpenRead,
): Omit<KinOpenChange, "_tag" | "hash"> | null {
  const before = new Map(held.rows.map((row) => [row.id, JSON.stringify(row)]));
  const nextIds = new Set(next.rows.map((row) => row.id));
  const removed = held.rows.map((row) => row.id).filter((id) => !nextIds.has(id));
  const updated = next.rows.filter((row) => before.get(row.id) !== JSON.stringify(row));
  const order = next.rows.map((row) => row.id);
  const natural = naturalOrder(
    held.rows.map((row) => row.id),
    new Set(removed),
    updated,
  );
  const orderMoved = !sameIds(natural, order);
  const countsMoved =
    held.counts.needsYou !== next.counts.needsYou ||
    held.counts.waiting !== next.counts.waiting ||
    held.counts.tasks !== next.counts.tasks;
  if (removed.length === 0 && updated.length === 0 && !orderMoved && !countsMoved) return null;
  return {
    asOf: next.asOf,
    counts: next.counts,
    updated,
    removed,
    ...(orderMoved ? { order } : {}),
  };
}

/** The read `held` with `change` applied: what the host read when it sent it. */
export function kinOpenApply(
  held: KinOpenRead,
  change: Omit<KinOpenChange, "_tag" | "hash">,
): KinOpenRead {
  const byId = new Map(held.rows.map((row) => [row.id, row]));
  for (const id of change.removed) byId.delete(id);
  for (const row of change.updated) byId.set(row.id, row);
  const order =
    change.order ??
    naturalOrder(
      held.rows.map((row) => row.id),
      new Set(change.removed),
      change.updated,
    );
  return {
    asOf: change.asOf,
    counts: change.counts,
    rows: order.flatMap((id) => byId.get(id) ?? []),
  };
}

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinOpenRpcs = [
  Rpc.make("kin.open.read", { payload: KinOpenReadInput, success: KinOpenRead, error }),
  Rpc.make("kin.open.subscribe", {
    payload: KinOpenSubscribeInput,
    success: KinOpenEvent,
    error,
    stream: true,
  }),
] as const;
export const KIN_OPEN_RPC_SCOPES = {
  "kin.open.read": AuthKinChatScope,
  "kin.open.subscribe": AuthKinChatScope,
} as const;
