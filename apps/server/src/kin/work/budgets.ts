// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { addUp, dayIn, formatMinor, formatMoney, monthOf, shiftMonth } from "./money.ts";
import { countedEntry, keyWithheld, moneyDay, ownerZone, startOfDay } from "./recordRows.ts";

/**
 * Monthly spending limits on paid expenses: per category, per project, or a category within a
 * project, in one currency. Spent is read from the expenses each time, in the owner's zone.
 */

/** Spent at or past this share of a limit (in percent) is near it. */
const NEAR_PERCENT = 80n;

export type BudgetTarget = {
  readonly category: string | null;
  readonly projectId: string | null;
  readonly currency: string;
};
const digest = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
const targetOf = (target: Omit<BudgetTarget, "currency">) =>
  `${target.category?.toLowerCase() ?? ""}\u0000${target.projectId ?? ""}`;
const budgetIdOf = (target: BudgetTarget) =>
  `bg_${digest(`${targetOf(target)}\u0000${target.currency}`)}`;

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });

/**
 * Sets a limit, replacing the one for the same target; `null` removes it. A removal with no
 * currency takes the target's one budget, and asks when it has several. One source event sets a
 * target once: its retry repeats the outcome, and a different value under it is refused.
 */
export const setBudget = Effect.fn("KinBudgets.set")(function* (
  orgId: KinOrgId,
  input: Omit<BudgetTarget, "currency"> & {
    readonly currency: string | undefined;
    readonly limitMinor: number | null;
    readonly sourceEventId: string;
  },
  by: { readonly kind: "agent" | "person"; readonly id: string },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const targetKey = `${targetOf(input)}\u0000${input.currency ?? ""}`;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [receipt] = yield* sql<{
        limitMinor: number | null;
        wasMinor: number | null;
        currency: string | null;
        outcome: "set" | "removed" | "none";
      }>`SELECT limit_minor AS "limitMinor", was_minor AS "wasMinor", currency, outcome
        FROM kin_money_budget_receipts WHERE org_id = ${orgId}
          AND source_event_id = ${input.sourceEventId} AND target_key = ${targetKey}`;
      if (receipt !== undefined) {
        if (receipt.limitMinor !== input.limitMinor)
          return yield* refused(
            "This message already set that budget to another value. Nothing changed; ask the owner which they meant.",
          );
        return {
          outcome: receipt.outcome,
          currency: receipt.currency,
          was: receipt.wasMinor === null ? null : BigInt(receipt.wasMinor),
        };
      }
      const held = yield* sql<{ budgetId: string; currency: string; limitMinor: number }>`
        SELECT budget_id AS "budgetId", currency, limit_minor AS "limitMinor"
        FROM kin_money_budgets WHERE org_id = ${orgId}
          AND COALESCE(lower(category), '') = ${input.category?.toLowerCase() ?? ""}
          AND COALESCE(project_id, '') = ${input.projectId ?? ""}
        ORDER BY currency`;
      const currency =
        input.currency ?? (input.limitMinor === null ? held[0]?.currency : undefined);
      if (input.currency === undefined && input.limitMinor === null && held.length > 1)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: `There is a budget for this in ${held.map((one) => one.currency).join(" and ")}. Say which currency to remove; nothing changed.`,
        });
      const existing = held.find((one) => one.currency === currency);
      let outcome: "set" | "removed" | "none" = "none";
      if (currency !== undefined && input.limitMinor !== null) {
        yield* sql`INSERT INTO kin_money_budgets (org_id, budget_id, category, project_id, currency,
            limit_minor, set_by_kind, set_by_id, set_at)
          VALUES (${orgId}, ${budgetIdOf({ ...input, currency })}, ${input.category},
            ${input.projectId}, ${currency}, ${input.limitMinor}, ${by.kind}, ${by.id}, ${now})
          ON CONFLICT (org_id, budget_id) DO UPDATE SET limit_minor = excluded.limit_minor,
            category = excluded.category, set_by_kind = excluded.set_by_kind,
            set_by_id = excluded.set_by_id, set_at = excluded.set_at`;
        outcome = "set";
      } else if (existing !== undefined) {
        yield* sql`DELETE FROM kin_money_budgets
          WHERE org_id = ${orgId} AND budget_id = ${existing.budgetId}`;
        outcome = "removed";
      }
      yield* sql`INSERT INTO kin_money_budget_receipts (org_id, source_event_id, target_key,
          budget_id, currency, limit_minor, was_minor, outcome, at)
        VALUES (${orgId}, ${input.sourceEventId}, ${targetKey}, ${existing?.budgetId ?? null},
          ${currency ?? null}, ${input.limitMinor}, ${existing?.limitMinor ?? null}, ${outcome},
          ${now})`;
      if (outcome !== "none") yield* (yield* KinRefreshObserver).touch(orgId, "moneyBudgets");
      return {
        outcome,
        currency: currency ?? null,
        was: existing === undefined ? null : BigInt(existing.limitMinor),
      };
    }),
  );
});

export type BudgetStatus = "over" | "near" | "ok";
/** Over is past the limit; exactly at it, or past `NEAR_PERCENT` of it, is near. */
const statusOf = (spent: bigint, limit: bigint): BudgetStatus =>
  spent > limit ? "over" : limit > 0n && spent * 100n >= limit * NEAR_PERCENT ? "near" : "ok";

/** Every budget against what was spent in `month` (default this month), in the owner's zone. */
export const budgetsView = Effect.fn("KinBudgets.view")(function* (
  orgId: KinOrgId,
  now: number,
  month?: string,
  keyed = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const shown = month ?? monthOf(dayIn(now, zone));
  const from = startOfDay(`${shown}-01`, zone);
  const to = startOfDay(`${shiftMonth(shown, 1)}-01`, zone);
  const budgets = yield* sql<{
    budgetId: string;
    category: string | null;
    projectId: string | null;
    projectKey: string | null;
    projectTitle: string | null;
    currency: string;
    limitMinor: number;
  }>`SELECT b.budget_id AS "budgetId", b.category, b.project_id AS "projectId",
      p.key AS "projectKey", p.title AS "projectTitle", b.currency, b.limit_minor AS "limitMinor"
    FROM kin_money_budgets b
    LEFT JOIN kin_records p ON p.org_id = b.org_id AND p.record_id = b.project_id
    WHERE b.org_id = ${orgId}
      ${
        keyed
          ? sql`AND NOT EXISTS (SELECT 1 FROM kin_records r
        WHERE r.org_id = b.org_id AND r.record_id = b.project_id AND ${keyWithheld(sql)})`
          : sql``
      }
    ORDER BY b.category IS NULL, lower(b.category), p.key, b.currency`;
  if (budgets.length === 0) return { month: shown, budgets: [] };
  const spent = yield* sql<{
    minor: number;
    currency: string;
    category: string | null;
    projectId: string | null;
  }>`SELECT r.amount_minor AS minor, r.currency, r.category, r.project_id AS "projectId"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL AND ${moneyDay(sql)} >= ${from} AND ${moneyDay(sql)} < ${to}
      ${keyed ? sql`AND NOT ${keyWithheld(sql)}` : sql``}
    ORDER BY r.key`;
  return {
    month: shown,
    budgets: budgets.map((budget) => {
      const onTarget = spent.filter(
        (one) =>
          (budget.category === null ||
            one.category?.toLowerCase() === budget.category.toLowerCase()) &&
          (budget.projectId === null || one.projectId === budget.projectId),
      );
      const members = onTarget.filter((one) => one.currency === budget.currency);
      // A currency with its own budget on this target is counted there, not left out here.
      const budgeted = new Set(
        budgets
          .filter((other) => targetOf(other) === targetOf(budget))
          .map((other) => other.currency),
      );
      const total = members.reduce((sum, one) => sum + BigInt(one.minor), 0n);
      const limit = BigInt(budget.limitMinor);
      return {
        ...budget,
        spent: total,
        expenses: members.length,
        status: statusOf(total, limit),
        notCounted: addUp(
          onTarget.filter((one) => !budgeted.has(one.currency)),
          budget.currency,
        ),
      };
    }),
  };
});
export type BudgetsView = Effect.Success<ReturnType<typeof budgetsView>>;

/** The budgets as an agent quotes them: every figure formatted by code. */
export const budgetsAnswer = (view: BudgetsView) => ({
  month: view.month,
  budgets: view.budgets.map((one) => {
    const left = BigInt(one.limitMinor) - one.spent;
    return {
      for: [
        one.category ?? undefined,
        one.projectId === null
          ? undefined
          : one.projectKey === null
            ? "a removed project"
            : `${one.projectTitle} (${one.projectKey})`,
      ]
        .filter((part) => part !== undefined)
        .join(" in "),
      limit: formatMinor(BigInt(one.limitMinor), one.currency),
      spent: formatMinor(one.spent, one.currency),
      ...(left >= 0n
        ? { left: formatMinor(left, one.currency) }
        : { over: formatMinor(-left, one.currency) }),
      expenses: one.expenses,
      status: one.status,
      ...(one.notCounted.length === 0
        ? {}
        : {
            notCounted: one.notCounted.map((money) => ({
              currency: money.currency,
              spent: formatMoney(money),
            })),
          }),
    };
  }),
  ...(view.budgets.length === 0 ? { none: "No budgets are set." } : {}),
  basis: `Spent is paid expenses dated in ${view.month} in the owner's time zone. over is past the limit; near is at the limit or past ${NEAR_PERCENT}% of it. notCounted is spending on the same target in other currencies, which the budget's spent does not include.`,
});

/** This month's budgets over or near their limit, for the morning brief; nothing when none are. */
export const budgetFlags = Effect.fn("KinBudgets.flags")(function* (orgId: KinOrgId, now: number) {
  const answer = budgetsAnswer(yield* budgetsView(orgId, now));
  const flagged = answer.budgets.filter((one) => one.status !== "ok");
  return flagged.length === 0 ? undefined : { month: answer.month, budgets: flagged };
});
