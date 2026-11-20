import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { bankKey, periodOf } from "./bankAccounts.ts";
import type { Statement } from "./statementTable.ts";

/**
 * Bank alert lines beside a statement. The statement is the truth: on its Confirm, the counted
 * alerts of the approval bound to its account, inside its period, are matched to its lines and
 * replaced by them, whether their sender still counts or was stopped; one it hasn't is kept out of
 * every figure. Each match is stored, and Undo puts them back.
 */

export type AlertLine = {
  readonly alertId: string;
  readonly day: string;
  readonly amountMinor: number;
  readonly direction: "credit" | "debit";
  readonly reference: string | null;
  /** The payment the owner recorded from its card, while it stands. */
  readonly paymentId: string | null;
  readonly recordId: string | null;
  readonly key: string | null;
  readonly title: string | null;
};

const DAY_MS = 86_400_000;
const apart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Each alert to one statement line: the same reference, else the same direction and amount within
 * two days, nearest first. One line answers one alert.
 */
const matchAlertLines = (
  alerts: ReadonlyArray<AlertLine>,
  rows: Statement["rows"],
): ReadonlyMap<string, number> => {
  const used = new Set<number>();
  const pairs = new Map<string, number>();
  const take = (alert: AlertLine, index: number) => {
    used.add(index);
    pairs.set(alert.alertId, index);
  };
  for (const alert of alerts) {
    if (alert.reference === null || squash(alert.reference).length < 6) continue;
    const ref = squash(alert.reference);
    const row = rows.find(
      (one) =>
        !used.has(one.index) &&
        one.direction === alert.direction &&
        one.amountMinor === alert.amountMinor &&
        ((one.reference !== null && squash(one.reference) === ref) ||
          squash(one.description).includes(ref)),
    );
    if (row !== undefined) take(alert, row.index);
  }
  for (const alert of alerts) {
    if (pairs.has(alert.alertId)) continue;
    const row = rows
      .filter(
        (one) =>
          !used.has(one.index) &&
          one.direction === alert.direction &&
          one.amountMinor === alert.amountMinor &&
          apart(one.date, alert.day) <= 2,
      )
      .toSorted((a, b) => apart(a.date, alert.day) - apart(b.date, alert.day))[0];
    if (row !== undefined) take(alert, row.index);
  }
  return pairs;
};

/**
 * Counted alerts inside the statement's period of the approvals bound to its account (with
 * `open`, those not bound yet that would be), oldest first, whatever their sender's state now.
 */
const alertsCovered = Effect.fn("KinBankAlerts.covered")(function* (
  orgId: KinOrgId,
  statement: Statement,
  open: boolean,
) {
  const sql = yield* SqlClient.SqlClient;
  const period = periodOf(statement);
  if (statement.kind !== "account" || period === undefined) return [];
  if (statement.account === null || !/^\d{4}$/.test(statement.account)) return [];
  const bank = bankKey(statement.bank);
  return yield* sql<AlertLine>`SELECT a.alert_id AS "alertId", a.day,
      a.amount_minor AS "amountMinor", a.direction, a.reference, p.payment_id AS "paymentId",
      r.record_id AS "recordId", r.key, r.title
    FROM kin_bank_alerts a
    JOIN kin_bank_alert_senders s ON s.org_id = a.org_id AND s.sender_id = a.sender_id
    LEFT JOIN kin_record_payments p ON p.org_id = a.org_id AND p.payment_id = a.payment_id
      AND p.voided_at IS NULL
    LEFT JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE a.org_id = ${orgId} AND a.state = 'counted'
      AND s.account = ${statement.account} AND s.currency = ${statement.currency}
      AND ((s.bound = 'bound' AND (s.bound_bank = '' OR ${bank} = '' OR s.bound_bank = ${bank}))
        OR (${open ? 1 : 0} = 1 AND s.bound = 'open'))
      AND a.day >= ${period.from} AND a.day <= ${period.on}
    ORDER BY a.day, a.received_at, a.alert_id`;
});

/**
 * What a statement's review shows of the alerts in its period: those it has no line for, kept out
 * of every figure, and the lines that are an alert's payment the owner already recorded from its
 * card, so the review never offers that money for another invoice.
 */
export const alertsOnReview = Effect.fn("KinBankAlerts.onReview")(function* (
  orgId: KinOrgId,
  statement: Statement,
) {
  const alerts = yield* alertsCovered(orgId, statement, true);
  const pairs = matchAlertLines(alerts, statement.rows);
  const recorded = new Map<
    number,
    {
      readonly paymentId: string;
      readonly recordId: string;
      readonly key: string;
      readonly title: string;
    }
  >();
  for (const alert of alerts) {
    const line = pairs.get(alert.alertId);
    if (
      line !== undefined &&
      alert.paymentId !== null &&
      alert.recordId !== null &&
      alert.key !== null &&
      alert.title !== null
    )
      recorded.set(line, {
        paymentId: alert.paymentId,
        recordId: alert.recordId,
        key: alert.key,
        title: alert.title,
      });
  }
  return {
    missing: alerts
      .filter((one) => !pairs.has(one.alertId))
      .map((one) => ({ day: one.day, amountMinor: one.amountMinor, direction: one.direction })),
    recorded,
  };
});

/**
 * On the statement's Confirm, in its transaction, once open approvals that now fit one account
 * are bound (`bindApprovals`): alerts it has a line for are replaced by that line, the rest in its
 * period are not on it. Returns the alerts replaced and those left out.
 */
export const settleAlerts = Effect.fn("KinBankAlerts.settle")(function* (
  orgId: KinOrgId,
  statementId: string,
  statement: Statement,
) {
  const sql = yield* SqlClient.SqlClient;
  const alerts = yield* alertsCovered(orgId, statement, false);
  const pairs = matchAlertLines(alerts, statement.rows);
  for (const alert of alerts) {
    const line = pairs.get(alert.alertId);
    yield* sql`UPDATE kin_bank_alerts
      SET state = ${line === undefined ? "not_on_statement" : "replaced"},
        statement_id = ${statementId}, statement_line = ${line ?? null}
      WHERE org_id = ${orgId} AND alert_id = ${alert.alertId} AND state = 'counted'`;
  }
  return {
    replaced: alerts.filter((one) => pairs.has(one.alertId)).map((one) => one.alertId),
    missing: alerts.filter((one) => !pairs.has(one.alertId)),
  };
});

/** Undo of the statement: the alerts it replaced or left out count again, their lines unlinked. */
export const unsettleAlerts = Effect.fn("KinBankAlerts.unsettle")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_bank_alerts SET state = 'counted', statement_id = NULL, statement_line = NULL
    WHERE org_id = ${orgId} AND statement_id = ${statementId}
      AND state IN ('replaced', 'not_on_statement')`;
});
