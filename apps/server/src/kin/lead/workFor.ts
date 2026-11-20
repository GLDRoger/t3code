import type { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelSql } from "../people/KinAccess.ts";

/**
 * Who delegated work was for, when the owner side started it answering a teammate's request:
 * the wake-up that ran `runIds` answered an owner-level message that came next after Kin's relay
 * of that teammate's request in the same chat (`KinHandoff.relay`). Read from stored rows only.
 */
export const workFor = Effect.fn("KinWorkFor.workFor")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly runIds: ReadonlyArray<string>;
}) {
  if (input.runIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ personId: KinPersonId; name: string }>`SELECT DISTINCT
      p.person_id AS "personId", p.display_name AS name
    FROM kin_wakeups w
    JOIN kin_events e ON e.org_id = w.org_id AND e.wakeup_id = w.wakeup_id
      AND e.agent_id = w.agent_id AND e.tag IN ('chat.message', 'widget.action')
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId') AND m.author_kind = 'human'
      AND ${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))}
    JOIN kin_messages r ON r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.seq < m.seq
      AND json_extract(r.relay_json, '$.kind') = 'sent_by'
      AND json_extract(r.relay_json, '$.personId') IS NOT NULL
    JOIN kin_people p ON p.org_id = r.org_id
      AND p.person_id = json_extract(r.relay_json, '$.personId') AND p.removed_at IS NULL
      AND NOT ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
    WHERE w.org_id = ${input.orgId} AND w.agent_id = ${input.agentId}
      AND w.run_id IN ${sql.in(input.runIds)}
      AND NOT EXISTS (SELECT 1 FROM kin_messages o WHERE o.org_id = m.org_id
        AND o.chat_id = m.chat_id AND o.seq > r.seq AND o.seq < m.seq
        AND (o.author_kind = 'human' OR json_extract(o.relay_json, '$.personId') IS NOT NULL))
    ORDER BY p.person_id`;
});
