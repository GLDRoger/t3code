import type { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelSql } from "../people/KinAccess.ts";

/** A message that carries someone's words relayed to the chat's person (`KinHandoff.relay`). */
const relayedSql = (m: string) =>
  `(${m}.relay_json IS NOT NULL OR substr(${m}.message_id, 1, 10) = 'kin-relay:'
    OR substr(${m}.client_message_id, 1, 15) = 'send:kin-relay:')`;

/**
 * Who delegated work was for: the owner side started it in the turn woken by the owner-level
 * message that came next after Kin's relay of a teammate's request in that chat. The work's run
 * is that turn's, and the turn's events name the message. A relay its teammate sent answering
 * words relayed to them is an answer, never a request. Read from stored rows only.
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
      AND NOT EXISTS (SELECT 1 FROM kin_events te
        JOIN kin_messages tm ON tm.org_id = te.org_id AND tm.author_kind = 'human'
          AND tm.message_id = json_extract(te.json, '$.messageId')
        WHERE te.org_id = r.org_id AND te.tag = 'chat.message' AND te.wakeup_id IS NOT NULL
          AND te.agent_id = json_extract(r.relay_json, '$.agentId')
          AND substr(r.message_id, 1, length(te.wakeup_id) + 11) = 'kin-relay:' || te.wakeup_id || ':'
          AND EXISTS (SELECT 1 FROM kin_messages pr WHERE pr.org_id = tm.org_id
            AND pr.chat_id = tm.chat_id AND pr.author_kind <> 'human'
            AND pr.seq = (SELECT MAX(x.seq) FROM kin_messages x WHERE x.org_id = tm.org_id
              AND x.chat_id = tm.chat_id AND x.seq < tm.seq
              AND (x.author_kind = 'human' OR ${sql.literal(relayedSql("x"))}))))
    ORDER BY p.person_id`;
});
