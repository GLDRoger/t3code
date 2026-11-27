import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinShell from "../shell/KinShell.ts";
import { sectionOfTool } from "../shell/sections.ts";
import { seatOf } from "./characterDefaults.ts";
import { isEngineeringDomain } from "./t3Tools.ts";

/**
 * Money and pipeline tools an engineering or social lead leaves to the seat they belong to, once
 * the company has a lead in it; with none, every lead keeps them.
 */
const SEAT_HOME: Readonly<Record<string, string>> = {
  statement_read: "finance",
  statement_rows: "finance",
  bills_add: "finance",
  bill_read: "finance",
  money_query: "finance",
  money_summary: "finance",
  payment_record: "finance",
  budget_set: "finance",
  kin_receipt: "finance",
  pipeline_read: "growth",
  deal_stages: "growth",
};
const LEAVES_TO_HOME: ReadonlySet<string> = new Set(["engineering", "social"]);

export const seatHomeOf = (name: string) =>
  Object.hasOwn(SEAT_HOME, name) ? SEAT_HOME[name] : undefined;

/** Whether a lead in `lead.seat` leaves `name` to the company's lead in its home seat. */
export const leftToHome = (
  name: string,
  lead: { readonly seat: string; readonly others: ReadonlyArray<string> },
) => {
  const home = seatHomeOf(name);
  return home !== undefined && LEAVES_TO_HOME.has(lead.seat) && lead.others.includes(home);
};

/**
 * Whether a lead's own owner-only thread lists `name`, as `visibleOnKinEndpoint` decides it: its
 * section on, and not a tool its seat leaves to another lead.
 */
export const leadListsTool = Effect.fn("KinSeatHome.leadListsTool")(
  function* (orgId: KinOrgId, agentId: KinAgentId, name: string) {
    const section = sectionOfTool(name);
    if (section !== null && !(yield* KinShell.sectionOnFor(orgId, section))) return false;
    if (seatHomeOf(name) === undefined) return true;
    const sql = yield* SqlClient.SqlClient;
    const leads = yield* sql<{ domain: string; own: number }>`SELECT l.domain,
        l.agent_id = ${agentId} AS own FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId} ORDER BY own DESC, l.agent_id`;
    const own = leads[0];
    if (own === undefined || own.own !== 1) return false;
    return !leftToHome(name, {
      seat: isEngineeringDomain(own.domain) ? "engineering" : seatOf(own.domain),
      others: leads.slice(1).map((lead) => seatOf(lead.domain)),
    });
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin seat tool check failed", { cause }).pipe(Effect.as(false)),
  ),
);
