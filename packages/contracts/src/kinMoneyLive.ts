import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { AuthKinChatScope, EnvironmentAuthorizationError } from "./auth.ts";
import { KinChatError, KinOrgId } from "./kinChat.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { KinListsResult, KinMoneySummary, KinReceiptsResult } from "./kinFinance.ts";
import { KinListId } from "./kinMoney.ts";
import { KinCash, KinMoneyBudgets, KinOutlook } from "./kinMoneyAnswers.ts";
import { KinGoalsResult } from "./kinPulse.ts";

/**
 * `kin.money.subscribe`: Money's figures for the owner level, kept current on the host. Each part
 * is the read of the same name (`kin.work.money` without its rows, `kin.work.cash`, …), built again
 * when something that can move it changes and sent only when it differs from what was sent.
 */
export const KIN_MONEY_PARTS = [
  "summary",
  "cash",
  "outlook",
  "budgets",
  "receipts",
  "goals",
  "lists",
] as const;
export const KinMoneyPart = Schema.Literals(KIN_MONEY_PARTS);
export type KinMoneyPart = typeof KinMoneyPart.Type;

export const KinMoneySubscribeInput = Schema.Struct({
  orgId: KinOrgId,
  parts: Schema.Array(KinMoneyPart).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(KIN_MONEY_PARTS.length),
  ),
  /** The `hash` of the parts held from an earlier session; unchanged, the stream starts `current`. */
  held: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
});
export type KinMoneySubscribeInput = typeof KinMoneySubscribeInput.Type;

/** The parts asked for, as their reads answer; `summary` with `upcoming` empty. */
export const KinMoneyLive = Schema.Struct({
  summary: Schema.optional(KinMoneySummary),
  cash: Schema.optional(KinCash),
  outlook: Schema.optional(KinOutlook),
  budgets: Schema.optional(KinMoneyBudgets),
  receipts: Schema.optional(KinReceiptsResult),
  goals: Schema.optional(KinGoalsResult),
  /** The lists' definitions with their open counts, archived ones left out (`kin.work.lists`). */
  lists: Schema.optional(KinListsResult),
});
export type KinMoneyLive = typeof KinMoneyLive.Type;

/** The summary's fields that moved; a task moves only `upcomingTotal`. */
export const KinMoneySummaryChange = KinMoneySummary.mapFields(Struct.map(Schema.optionalKey));
export type KinMoneySummaryChange = typeof KinMoneySummaryChange.Type;

export const KinMoneyEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", { live: KinMoneyLive, hash: Schema.String }),
  Schema.TaggedStruct("current", { hash: Schema.String }),
  Schema.TaggedStruct("changed", {
    summary: Schema.optional(KinMoneySummaryChange),
    cash: Schema.optional(KinCash),
    outlook: Schema.optional(KinOutlook),
    budgets: Schema.optional(KinMoneyBudgets),
    receipts: Schema.optional(KinReceiptsResult),
    goals: Schema.optional(KinGoalsResult),
    lists: Schema.optional(KinListsResult),
    /** Lists whose open count alone moved: a task opened or closed moves Work's. */
    listsOpen: Schema.optional(
      Schema.Array(Schema.Struct({ list: KinListId, open: NonNegativeInt })).check(
        Schema.isMaxLength(200),
      ),
    ),
    hash: Schema.String,
  }),
]);
export type KinMoneyEvent = typeof KinMoneyEvent.Type;
export type KinMoneyChange = Extract<KinMoneyEvent, { readonly _tag: "changed" }>;

/** `held` with a `changed` applied: the summary's moved fields over it, other parts whole. */
export function kinMoneyApply(held: KinMoneyLive, change: KinMoneyChange): KinMoneyLive {
  const { _tag, hash: _hash, summary, listsOpen, ...whole } = change;
  const open = new Map((listsOpen ?? []).map((one) => [one.list, one.open]));
  return {
    ...held,
    ...whole,
    ...(summary === undefined || held.summary === undefined
      ? {}
      : { summary: { ...held.summary, ...summary } }),
    ...(open.size === 0 || held.lists === undefined || whole.lists !== undefined
      ? {}
      : {
          lists: {
            ...held.lists,
            lists: held.lists.lists.map((def) =>
              open.has(def.list) ? { ...def, open: open.get(def.list)! } : def,
            ),
          },
        }),
  };
}

/**
 * A part as two builds are compared: without when it was read, and goals without their pace
 * (`expected`), which moves with the clock. Sent, a part carries both as of its build.
 */
export function kinMoneySettled(part: KinMoneyPart, value: unknown): unknown {
  if (value === undefined) return undefined;
  const { asOf: _asOf, ...rest } = value as { readonly asOf?: unknown };
  if (part !== "goals") return rest;
  const { goals } = value as KinGoalsResult;
  return { ...rest, goals: goals.map(({ expected: _expected, ...goal }) => goal) };
}

/** What changed from `before` to `after`, as `kinMoneySettled` compares them; null when nothing. */
export function kinMoneyDiff(
  before: KinMoneyLive,
  after: KinMoneyLive,
): Omit<KinMoneyChange, "_tag" | "hash"> | null {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: Record<string, unknown> = {};
  for (const part of KIN_MONEY_PARTS) {
    if (part === "summary" || part === "lists") continue;
    const next = after[part];
    if (
      next !== undefined &&
      !same(kinMoneySettled(part, before[part]), kinMoneySettled(part, next))
    )
      out[part] = next;
  }
  const lists = listsChange(before.lists, after.lists);
  if (lists !== null) Object.assign(out, lists);
  const { summary } = after;
  if (summary !== undefined) {
    const held = before.summary as Record<string, unknown> | undefined;
    const moved = Object.entries(summary).filter(
      ([field, value]) => field !== "asOf" && !same(held?.[field], value),
    );
    if (moved.length > 0)
      out.summary = { asOf: summary.asOf, ...Object.fromEntries(moved) } as KinMoneySummaryChange;
  }
  return Object.keys(out).length === 0 ? null : (out as Omit<KinMoneyChange, "_tag" | "hash">);
}

/** The lists whole, or only the open counts that moved when nothing else did; null when neither. */
function listsChange(
  before: KinListsResult | undefined,
  after: KinListsResult | undefined,
): Pick<KinMoneyChange, "lists" | "listsOpen"> | null {
  if (after === undefined) return null;
  const shape = (result: KinListsResult | undefined) =>
    JSON.stringify(result?.lists.map(({ open: _open, ...def }) => def));
  if (before === undefined || shape(before) !== shape(after)) return { lists: after };
  const moved = after.lists.flatMap((def, index) =>
    def.open === before.lists[index]!.open ? [] : [{ list: def.list, open: def.open }],
  );
  return moved.length === 0 ? null : { listsOpen: moved };
}

const error = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
export const KinMoneyLiveRpcs = [
  Rpc.make("kin.money.subscribe", {
    payload: KinMoneySubscribeInput,
    success: KinMoneyEvent,
    error,
    stream: true,
  }),
] as const;

export const KIN_MONEY_LIVE_RPC_SCOPES = {
  "kin.money.subscribe": AuthKinChatScope,
} as const;
