import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";

/** The company's live Finance agent, else its Chief of staff, else its first live agent. */
export const billReader = Effect.fn("KinBills.readerOf")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const finance = yield* liveLead(sql, orgId, { prefer: "finance" });
  if (finance === undefined || finance.domain === "finance") return finance;
  return yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
});
