import type { KinMailRuleRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { readOwnerZone } from "../work/recordRows.ts";
import { mailRuleContentHash } from "./ruleContent.ts";

export const monthlyMailRuleLimit = (
  rule: { readonly month: string | null; readonly fired: number; readonly monthlyCap: number },
  at: number,
  zone: string,
) => {
  const month = DateTime.formatIsoDate(DateTime.makeZonedUnsafe(at, { timeZone: zone })).slice(
    0,
    7,
  );
  const fired = rule.month === month ? rule.fired : 0;
  return { month, fired, atLimit: fired >= rule.monthlyCap };
};

// A feed caller must keep this and the corresponding enqueue in the same transaction.
export const recordMailRuleWake = Effect.fn("KinMailRules.recordWake")(function* (
  { orgId, ruleId }: KinMailRuleRef,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [rule] = yield* sql<{
    month: string | null;
    fired: number;
    monthlyCap: number;
    matchJson: string;
    what: string;
    contentHash: string;
  }>`SELECT month, fired, monthly_cap AS "monthlyCap", match_json AS "matchJson", what,
      content_sha256 AS "contentHash" FROM kin_mail_rules
    WHERE org_id = ${orgId} AND rule_id = ${ruleId} AND state = 'on'`;
  if (rule === undefined || mailRuleContentHash(rule.matchJson, rule.what) !== rule.contentHash)
    return { status: "inactive" } as const;
  const { month, fired, atLimit } = monthlyMailRuleLimit(rule, at, yield* readOwnerZone(orgId));
  if (atLimit) return { status: "held", month, fired } as const;
  const updated = yield* sql`UPDATE kin_mail_rules
    SET month = ${month}, fired = ${fired + 1}, last_wake_at = ${at},
      cap_told = CASE WHEN month = ${month} THEN cap_told ELSE NULL END
    WHERE org_id = ${orgId} AND rule_id = ${ruleId} AND state = 'on'
      AND content_sha256 = ${rule.contentHash} AND month IS ${rule.month} AND fired = ${rule.fired}
    RETURNING rule_id`;
  return updated.length > 0
    ? ({ status: "counted", month, fired: fired + 1 } as const)
    : ({ status: "inactive" } as const);
});
