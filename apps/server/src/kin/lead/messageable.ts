import type { KinLeadMessageable } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as Reach from "./Reach.ts";

/**
 * Every live lead of the company this person may message, chat or not yet, oldest first: name,
 * what the owner lets teammates read about it, and who owns it (and so can see that chat).
 */
export const messageable = Effect.fn("KinLeadProvision.messageable")(function* (
  person: PersonIdentity,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<KinLeadMessageable>`
    SELECT l.org_id AS "orgId", l.agent_id AS "agentId", l.name, l.public_intro AS intro,
      o.display_name AS "ownerName"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    JOIN kin_people o ON o.org_id = a.org_id AND o.person_id = a.owner_person_id
    JOIN kin_people me ON me.org_id = l.org_id AND me.person_id = ${person.personId}
    WHERE l.org_id = ${person.orgId}
      AND NOT ${sql.literal(Reach.restrictedSql("l.org_id", "l.agent_id", "me.person_id"))}
    ORDER BY a.created_at, l.agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.messageable")),
  );
});
