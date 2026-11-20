import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The owner's line on a review someone asked for in Kin ends with this (`reviewAsk.ts`). */
export const askedForLine = (name: string) => `${name} asked for it.`;

/** The name a turn's asked review ends its owner line with, when one of its events carries it. */
export const askedForSuffix = Effect.fn("KinGitHubReviewAsk.askedFor")(function* (
  orgId: KinOrgId,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  // Not when the agent's owner asked: the line is in his own chat.
  const [person] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_events e
    JOIN kin_people p ON p.org_id = e.org_id AND p.person_id = json_extract(e.json, '$.askedBy')
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId} AND e.tag = 'github'
      AND a.owner_person_id <> p.person_id
    ORDER BY e.event_id LIMIT 1`;
  return person === undefined ? undefined : askedForLine(person.name);
});
