import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Who mail to a client goes to: a contact with an email, and whether it is its billing contact. */
export type ClientRecipient = {
  readonly name: string;
  readonly email: string;
  readonly billing: boolean;
};

/**
 * Each client's active contact with an email that its mail goes to: for money (`billing`), its
 * billing contact first; otherwise, and when it has none, the first by name.
 */
export const clientRecipients = Effect.fn("KinWork.clientRecipients")(function* (
  orgId: KinOrgId,
  partyIds: ReadonlyArray<string>,
  billing: boolean,
) {
  const out = new Map<string, ClientRecipient>();
  if (partyIds.length === 0) return out;
  const sql = yield* SqlClient.SqlClient;
  for (const row of yield* sql<{ partyId: string; name: string; email: string; billing: number }>`
    SELECT party_id AS "partyId", title AS name, trim(json_extract(fields_json, '$.email')) AS email,
      (json_extract(fields_json, '$.billing') IS NOT NULL) AS billing
    FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'contacts' AND state = 'open'
      AND party_id IN ${sql.in([...new Set(partyIds)])}
      AND trim(COALESCE(json_extract(fields_json, '$.email'), '')) <> ''
    ORDER BY party_id, ${sql.literal(billing ? "billing DESC," : "")} lower(title), key`)
    if (!out.has(row.partyId))
      out.set(row.partyId, {
        name: row.name,
        email: row.email,
        billing: billing && row.billing === 1,
      });
  return out;
});
