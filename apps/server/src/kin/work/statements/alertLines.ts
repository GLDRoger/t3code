import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { Statement } from "./statementTable.ts";

/**
 * Bank alert lines beside a statement. The statement is the truth: on its Confirm, the counted
 * alerts its period covers are matched to its lines and replaced by them; one it hasn't is kept
 * out of every figure. Undo puts them back.
 */

export type AlertLine = {
  readonly alertId: string;
  readonly day: string;
  readonly amountMinor: number;
  readonly direction: "credit" | "debit";
  readonly reference: string | null;
};

const DAY_MS = 86_400_000;
const apart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** What a statement covers: its printed period, else its first and last row's day. */
const periodOf = (statement: Statement) => {
  const days = statement.rows.map((row) => row.date).toSorted();
  const from = statement.from ?? days[0];
  const to = statement.to ?? days.at(-1);
  return from === undefined || to === undefined ? undefined : { from, to };
};

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

/** Counted alerts of the statement's account inside its period, oldest first. */
const alertsCovered = Effect.fn("KinBankAlerts.covered")(function* (
  orgId: KinOrgId,
  statement: Statement,
) {
  const sql = yield* SqlClient.SqlClient;
  const period = periodOf(statement);
  if (statement.kind !== "account" || period === undefined) return [];
  if (statement.account === null || !/^\d{4}$/.test(statement.account)) return [];
  return yield* sql<AlertLine>`SELECT a.alert_id AS "alertId", a.day,
      a.amount_minor AS "amountMinor", a.direction, a.reference
    FROM kin_bank_alerts a
    JOIN kin_bank_alert_senders s ON s.org_id = a.org_id AND s.connection_id = a.connection_id
      AND s.address = a.address AND s.account = a.account
    WHERE a.org_id = ${orgId} AND a.state = 'counted' AND s.state = 'counted'
      AND a.account = ${statement.account} AND a.currency = ${statement.currency}
      AND a.day >= ${period.from} AND a.day <= ${period.to}
    ORDER BY a.day, a.received_at, a.alert_id`;
});

/** The alerts in the statement's period it has no line for: shown on its card, never counted. */
export const alertsNotOn = Effect.fn("KinBankAlerts.notOn")(function* (
  orgId: KinOrgId,
  statement: Statement,
) {
  const alerts = yield* alertsCovered(orgId, statement);
  const pairs = matchAlertLines(alerts, statement.rows);
  return alerts
    .filter((one) => !pairs.has(one.alertId))
    .map((one) => ({ day: one.day, amountMinor: one.amountMinor, direction: one.direction }));
});

/**
 * On the statement's Confirm, in its transaction: alerts it has a line for are replaced by it,
 * the rest in its period are not on it. Returns the alerts replaced and those left out.
 */
export const settleAlerts = Effect.fn("KinBankAlerts.settle")(function* (
  orgId: KinOrgId,
  statementId: string,
  statement: Statement,
) {
  const sql = yield* SqlClient.SqlClient;
  const alerts = yield* alertsCovered(orgId, statement);
  const pairs = matchAlertLines(alerts, statement.rows);
  const replaced = alerts.filter((one) => pairs.has(one.alertId)).map((one) => one.alertId);
  const missing = alerts.filter((one) => !pairs.has(one.alertId));
  for (let at = 0; at < replaced.length; at += 500)
    yield* sql`UPDATE kin_bank_alerts SET state = 'replaced', statement_id = ${statementId}
      WHERE org_id = ${orgId} AND state = 'counted'
        AND alert_id IN ${sql.in(replaced.slice(at, at + 500))}`;
  const missed = missing.map((one) => one.alertId);
  for (let at = 0; at < missed.length; at += 500)
    yield* sql`UPDATE kin_bank_alerts SET state = 'not_on_statement', statement_id = ${statementId}
      WHERE org_id = ${orgId} AND state = 'counted'
        AND alert_id IN ${sql.in(missed.slice(at, at + 500))}`;
  return { replaced, missing };
});

/** Undo of the statement: the alerts it replaced or left out count again. */
export const unsettleAlerts = Effect.fn("KinBankAlerts.unsettle")(function* (
  orgId: KinOrgId,
  statementId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_bank_alerts SET state = 'counted', statement_id = NULL
    WHERE org_id = ${orgId} AND statement_id = ${statementId}
      AND state IN ('replaced', 'not_on_statement')`;
});
