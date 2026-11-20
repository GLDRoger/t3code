import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn, formatMoney } from "../work/money.ts";
import { countedEntry, ownerZone } from "../work/recordRows.ts";
import * as Touches from "../work/touches.ts";

const CAP = 8;
const QUOTE_STATES: Record<string, string> = {
  open: "draft",
  waiting: "sent, no answer",
  done: "accepted",
  dropped: "declined or void",
};

/**
 * What we have done with a client, for a fact about them going quiet or cold: their projects,
 * what was quoted and how it went, what they were invoiced, and the last contacts. The agent
 * builds its suggestion from this; the relationship file is in memory (client:<key>).
 */
export const clientHistory = Effect.fn("KinPulse.clientHistory")(function* (
  orgId: KinOrgId,
  partyId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const day = (ms: number | null) => (ms === null ? undefined : dayIn(ms, zone));
  const money = (minor: number | null, currency: string | null) =>
    minor === null || currency === null ? undefined : formatMoney({ minor, currency });
  const rows = yield* sql<{
    list: string;
    key: string;
    title: string;
    state: string;
    closedAt: number | null;
    dateAt: number | null;
    createdAt: number;
    minor: number | null;
    currency: string | null;
    billing: string | null;
    renewsOn: string | null;
  }>`SELECT r.register_id AS list, r.key, r.title, r.state, r.closed_at AS "closedAt",
      r.date_at AS "dateAt", r.created_at AS "createdAt", r.amount_minor AS minor, r.currency,
      json_extract(r.fields_json, '$.billing') AS billing,
      json_extract(r.fields_json, '$.renewsOn') AS "renewsOn"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id IN ('projects', 'quotes', 'invoices')
      AND (r.register_id = 'projects' OR ${countedEntry(sql, ["dropped"])})
      AND (r.party_id = ${partyId} OR r.project_id IN (SELECT p.record_id FROM kin_records p
        WHERE p.org_id = r.org_id AND p.register_id = 'projects' AND p.party_id = ${partyId}))
    ORDER BY COALESCE(r.closed_at, r.date_at, r.created_at) DESC, r.key
    LIMIT ${CAP * 3}`;
  const of = (list: string) => rows.filter((row) => row.list === list).slice(0, CAP);
  const touches = yield* Touches.touchesOf(orgId, partyId, now, 3);
  return {
    projects: of("projects").map((row) => ({
      key: row.key,
      title: row.title,
      state: row.state,
      ...(row.billing === null ? {} : { billing: row.billing }),
      ...(row.closedAt === null ? {} : { ended: day(row.closedAt) }),
      ...(row.renewsOn === null ? {} : { renewsOn: row.renewsOn }),
    })),
    quotes: of("quotes").map((row) => ({
      key: row.key,
      title: row.title,
      answer: QUOTE_STATES[row.state] ?? row.state,
      ...(money(row.minor, row.currency) === undefined
        ? {}
        : { amount: money(row.minor, row.currency) }),
      on: day(row.dateAt ?? row.createdAt),
    })),
    invoices: of("invoices")
      .filter((row) => row.state !== "dropped" && row.state !== "open")
      .map((row) => ({
        key: row.key,
        title: row.title,
        ...(money(row.minor, row.currency) === undefined
          ? {}
          : { amount: money(row.minor, row.currency) }),
        paid: row.state === "done",
        on: day(row.dateAt),
      })),
    lastContacts: touches.map((touch) => ({ at: touch.at, kind: touch.kind, note: touch.note })),
  };
});
