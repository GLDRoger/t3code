import {
  KinPersonAccess,
  kinOwnerLevel,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";

// The one owner-level rule: `kin_people.access` is owner or co_owner; a row with none set yet is
// the owner when it owns a lead, as before kinds were stored. Read per request; no agent writes it.

/** SQL over a trusted row alias, for `sql.literal`: the row's kind, unset read as above. */
export const accessSql = (p: string) =>
  `COALESCE(${p}.access, CASE WHEN EXISTS (SELECT 1 FROM kin_leads al
    JOIN kin_agents aa ON aa.org_id = al.org_id AND aa.agent_id = al.agent_id
    WHERE al.org_id = ${p}.org_id AND aa.owner_person_id = ${p}.person_id) THEN 'owner'
    ELSE 'member' END)`;

/** SQL over trusted column names, for `sql.literal`: `person` is an owner-level person of `org`. */
export const ownerLevelSql = (org: string, person: string) =>
  `EXISTS (SELECT 1 FROM kin_people ol WHERE ol.org_id = ${org} AND ol.person_id = ${person}
    AND ${accessSql("ol")} IN ('owner', 'co_owner'))`;

const decodeAccess = Schema.decodeUnknownOption(KinPersonAccess);

export const accessOf = Effect.fn("KinAccess.accessOf")(
  function* (orgId: KinOrgId, personId: KinPersonId) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ access: string }>`SELECT ${sql.literal(accessSql("p"))} AS access
      FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${personId}
      ORDER BY p.person_id`;
    return row === undefined ? undefined : Option.getOrUndefined(decodeAccess(row.access));
  },
  Effect.mapError(toPersistenceSqlError("KinAccess.accessOf")),
);

export const ownerLevel = Effect.fn("KinAccess.ownerLevel")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  return kinOwnerLevel(yield* accessOf(orgId, personId));
});

/** The org's owner-level people. */
export const ownerLevelPeople = Effect.fn("KinAccess.ownerLevelPeople")(function* (
  orgId: KinOrgId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ personId: string }>`SELECT p.person_id AS "personId"
    FROM kin_people p WHERE p.org_id = ${orgId}
      AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
    ORDER BY p.person_id`;
  return new Set(rows.map((row) => row.personId));
});
