// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import type { KinMoney, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { dayIn, formatMoney, monthOf, shiftMonth } from "./money.ts";
import { moneyDay, ownerZone, startOfDay } from "./recordRows.ts";

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
const budgetIdOf = (target: BudgetTarget) =>
  `bg_${NodeCrypto.createHash("sha256")
    .update(
      `${target.category?.toLowerCase() ?? ""}\u0000${target.projectId ?? ""}\u0000${target.currency}`,
    )
    .digest("hex")
    .slice(0, 24)}`;

/** Sets a limit, replacing the one for the same target; `null` removes it. */
export const setBudget = Effect.fn("KinBudgets.set")(function* (
  orgId: KinOrgId,
  target: BudgetTarget,
  limitMinor: number | null,
  by: { readonly kind: "agent" | "person"; readonly id: string },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const budgetId = budgetIdOf(target);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (limitMinor === null)
        yield* sql`DELETE FROM kin_money_budgets WHERE org_id = ${orgId} AND budget_id = ${budgetId}`;
      else
        yield* sql`INSERT INTO kin_money_budgets (org_id, budget_id, category, project_id, currency,
            limit_minor, set_by_kind, set_by_id, set_at)
          VALUES (${orgId}, ${budgetId}, ${target.category}, ${target.projectId}, ${target.currency},
            ${limitMinor}, ${by.kind}, ${by.id}, ${now})
          ON CONFLICT (org_id, budget_id) DO UPDATE SET limit_minor = excluded.limit_minor,
            category = excluded.category, set_by_kind = excluded.set_by_kind,
            set_by_id = excluded.set_by_id, set_at = excluded.set_at`;
      yield* (yield* KinRefreshObserver).touch(orgId, "moneyBudgets");
    }),
  );
  return budgetId;
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
      AND r.amount_minor IS NOT NULL AND ${moneyDay(sql)} >= ${from} AND ${moneyDay(sql)} < ${to}
    ORDER BY r.key`;
  return {
    month: shown,
    budgets: budgets.map((budget) => {
      const members = spent.filter(
        (one) =>
          one.currency === budget.currency &&
          (budget.category === null ||
            one.category?.toLowerCase() === budget.category.toLowerCase()) &&
          (budget.projectId === null || one.projectId === budget.projectId),
      );
      const total = members.reduce((sum, one) => sum + BigInt(one.minor), 0n);
      const limit = BigInt(budget.limitMinor);
      return {
        ...budget,
        spent: total,
        expenses: members.length,
        status: statusOf(total, limit),
      };
    }),
  };
});
export type BudgetsView = Effect.Success<ReturnType<typeof budgetsView>>;

const money = (minor: bigint, currency: string): KinMoney => ({ minor: Number(minor), currency });

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
      limit: formatMoney(money(BigInt(one.limitMinor), one.currency)),
      spent: formatMoney(money(one.spent, one.currency)),
      ...(left >= 0n
        ? { left: formatMoney(money(left, one.currency)) }
        : { over: formatMoney(money(-left, one.currency)) }),
      expenses: one.expenses,
      status: one.status,
    };
  }),
  ...(view.budgets.length === 0 ? { none: "No budgets are set." } : {}),
  basis: `Spent is paid expenses dated in ${view.month} in the owner's time zone. over is past the limit; near is at the limit or past ${NEAR_PERCENT}% of it.`,
});

/** This month's budgets over or near their limit, for the morning brief; nothing when none are. */
export const budgetFlags = Effect.fn("KinBudgets.flags")(function* (orgId: KinOrgId, now: number) {
  const answer = budgetsAnswer(yield* budgetsView(orgId, now));
  const flagged = answer.budgets.filter((one) => one.status !== "ok");
  return flagged.length === 0 ? undefined : { month: answer.month, budgets: flagged };
});
