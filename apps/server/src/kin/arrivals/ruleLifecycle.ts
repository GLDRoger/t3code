import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const pauseMailRulesFor = Effect.fn("KinMailRules.pauseFor")(function* (
  orgId: KinOrgId,
  cause: { readonly kind: "left" | "mailbox" | "agent"; readonly id: string },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const column =
    cause.kind === "left" ? "said_by" : cause.kind === "mailbox" ? "connection_id" : "agent_id";
  return yield* sql<{ connectionId: string }>`UPDATE kin_mail_rules
    SET state = 'paused', paused_why = ${cause.kind}, updated_at = ${now}
    WHERE org_id = ${orgId} AND ${sql(column)} = ${cause.id} AND state = 'on'
    RETURNING connection_id AS "connectionId"`;
});
