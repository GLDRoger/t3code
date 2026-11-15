import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The message id prefix of a relay a wake-up made (`KinHandoff.relay`). */
export const relayPrefix = (wakeupId: string) => `kin-relay:${wakeupId}:`;

const PROMISE =
  /\bI(?:'ll|’ll| will|'m going to|’m going to| am going to)\s+(?:now\s+|also\s+)?(?:put|pass|tell|ask|let|check with|flag|raise|forward|relay|mention|bring|nudge|ping|message|follow up with)\b[^.!?\n]{0,80}/gi;
const PRONOUN = /\b(?:him|her|the owner)\b/i;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Who a wake-up's reply said it would tell, ask or pass something to, when nothing in the turn
 * did: no relay, nudge, reminder, hand-off, assignment notice or post in another chat. Someone
 * in the chat itself is the reader, so a promise to them is no hand-over.
 */
export const unkeptPromise = Effect.fn("KinReplyPromises.unkept")(function* (wake: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly threadId: string;
  readonly startedAt: number;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const since = iso(wake.startedAt);
  const said = yield* sql<{ body: string }>`SELECT body FROM kin_messages
    WHERE org_id = ${wake.orgId} AND chat_id = ${wake.chatId} AND author_kind = 'agent'
      AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
      AND created_at >= ${since}
    ORDER BY seq`;
  const spans = said.flatMap((row) => [...row.body.matchAll(PROMISE)].map((hit) => hit[0]));
  if (spans.length === 0) return undefined;
  const people = yield* sql<{ name: string; here: number; owner: number }>`SELECT
      p.display_name AS name,
      EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = p.org_id
        AND m.chat_id = ${wake.chatId} AND m.person_id = p.person_id AND m.left_at IS NULL) AS here,
      EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id AND a.agent_id = ${wake.agentId}
        AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE p.org_id = ${wake.orgId} ORDER BY p.person_id LIMIT 200`;
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  const owner = people.find((person) => person.owner === 1);
  let named: string | undefined;
  for (const span of spans) {
    const person = people.find(
      (one) =>
        one.here === 0 &&
        first(one.name).length > 1 &&
        new RegExp(`\\b${first(one.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
          span,
        ),
    );
    if (person !== undefined) {
      named = first(person.name);
      break;
    }
    if (PRONOUN.test(span) && owner !== undefined && owner.here === 0) {
      named = first(owner.name);
      break;
    }
  }
  if (named === undefined) return undefined;
  const kept = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${wake.orgId}
      AND substr(message_id, 1, ${relayPrefix(wake.wakeupId).length}) = ${relayPrefix(wake.wakeupId)}
    UNION ALL SELECT 1 FROM kin_messages WHERE org_id = ${wake.orgId} AND created_at >= ${since}
      AND ((author_kind = 'agent' AND author_agent_id = ${wake.agentId} AND chat_id <> ${wake.chatId})
        OR substr(message_id, 1, 11) = 'kin-assign-')
    UNION ALL SELECT 1 FROM kin_pulse_nudges WHERE org_id = ${wake.orgId}
      AND agent_id = ${wake.agentId} AND sent_at >= ${wake.startedAt}
    UNION ALL SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${wake.orgId}
      AND wakeup_id = ${wake.wakeupId} AND substr(call_key, 1, 9) = 'item:def-'
    UNION ALL SELECT 1 FROM kin_handoffs WHERE org_id = ${wake.orgId}
      AND from_agent_id = ${wake.agentId} AND created_at >= ${wake.startedAt}
    LIMIT 1`;
  return kept.length > 0 ? undefined : named;
});
