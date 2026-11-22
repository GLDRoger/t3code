import { type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords } from "../work/KinRecords.ts";

type Turn = { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string };

/**
 * The Work task this agent holds that its turn's task events are about, when they are about one:
 * a card asked there is about it too. Woken by several, a card's own `about` says which.
 */
export const turnTaskKeys = Effect.fn("KinCardTask.turnTaskKeys")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT DISTINCT r.key FROM kin_events e
    JOIN kin_records r ON r.org_id = e.org_id AND r.record_id = json_extract(e.json, '$.recordId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
      AND e.tag = 'record.changed' AND json_extract(e.json, '$.reason') <> 'withdrawn'
      AND r.register_id = 'work' AND r.owner_kind = 'agent' AND r.owner_id = ${turn.agentId}
    ORDER BY r.key`;
  return rows.length === 1 ? [rows[0]!.key] : [];
});

/**
 * A card just asked about a task this agent closed done earlier in the same turn: the task was not
 * done, so it waits on the card's person again until they answer (`KinRecords.update`).
 */
export const reopenAsked = Effect.fn("KinCardTask.reopenAsked")(function* (
  turn: Turn & { readonly personId: string; readonly about: ReadonlyArray<string> },
) {
  if (turn.about.length === 0) return;
  const records = yield* Effect.serviceOption(KinRecords);
  if (Option.isNone(records)) return;
  const sql = yield* SqlClient.SqlClient;
  const closed = yield* sql<{ key: string }>`SELECT DISTINCT r.key FROM kin_records r
    JOIN kin_record_changes c ON c.org_id = r.org_id AND c.record_id = r.record_id
    WHERE r.org_id = ${turn.orgId} AND r.register_id = 'work' AND r.state = 'done'
      AND r.key IN ${sql.in(turn.about)} AND c.wakeup_id = ${turn.wakeupId}
      AND c.actor_kind = 'agent' AND c.actor_id = ${turn.agentId}
      AND EXISTS (SELECT 1 FROM json_each(c.fields_json) f
        WHERE json_extract(f.value, '$.field') = 'state' AND json_extract(f.value, '$.to') = 'done')
    ORDER BY r.key`;
  for (const { key } of closed)
    yield* records.value.update(
      turn.orgId,
      { actor: { _tag: "system" }, via: "lead", wakeupId: turn.wakeupId },
      key,
      {
        state: "waiting",
        waitingOn: { _tag: "person", personId: KinPersonId.make(turn.personId) },
      },
    );
});
