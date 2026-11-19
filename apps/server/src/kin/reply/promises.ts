import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The message id prefix of a relay a wake-up made (`KinHandoff.relay`). */
export const relayPrefix = (wakeupId: string) => `kin-relay:${wakeupId}:`;
/** The message id prefix of a pulse nudge (`pulse/nudge.ts`). */
export const NUDGE_PREFIX = "pulse-nudge:";

const PROMISE =
  /\bI(?:'ll|’ll| will|'m going to|’m going to| am going to)\s+(?:now\s+|also\s+)?(?:put|pass|tell|ask|let|check with|flag|raise|forward|relay|mention|bring|nudge|ping|message|follow up with)\b[^.!?\n]{0,80}/gi;
const PRONOUN = /\b(?:him|her|the owner)\b/i;
/** "Finance will send the reminder": what another agent is said to do next. */
const AGENT_ACTS =
  "\\s+(?:will|'ll|’ll|is going to|can then)\\s+(?:now\\s+|then\\s+)?(?:send|draft|chase|remind|follow up|handle|take|reply|prepare|pick up|look into|check|do|sort|deal)\\b";
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Who a reply said it would tell, ask or pass something to, when nothing in the turn did: no relay,
 * nudge, reminder, open question to them with a safe default, hand-off, assignment notice or post
 * elsewhere. Someone in the chat reads it already. Else an agent said to act, not handed it.
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
  const people = yield* sql<{ personId: string; name: string; here: number; owner: number }>`SELECT
      p.person_id AS "personId", p.display_name AS name,
      EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = p.org_id
        AND m.chat_id = ${wake.chatId} AND m.person_id = p.person_id AND m.left_at IS NULL) AS here,
      EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id AND a.agent_id = ${wake.agentId}
        AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE p.org_id = ${wake.orgId} ORDER BY p.person_id LIMIT 200`;
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  const owner = people.find((person) => person.owner === 1);
  let named: { readonly personId: string; readonly first: string } | undefined;
  for (const span of spans) {
    const person = people.find(
      (one) =>
        one.here === 0 &&
        first(one.name).length > 1 &&
        new RegExp(`\\b${escaped(first(one.name))}\\b`, "i").test(span),
    );
    if (person !== undefined) {
      named = { personId: person.personId, first: first(person.name) };
      break;
    }
    if (PRONOUN.test(span) && owner !== undefined && owner.here === 0) {
      named = { personId: owner.personId, first: first(owner.name) };
      break;
    }
  }
  if (named === undefined) {
    // A promise about another agent stands only when this turn handed it over.
    const agents = yield* sql<{ agentId: string; name: string }>`SELECT a.agent_id AS "agentId",
        a.display_name AS name FROM kin_agents a
      WHERE a.org_id = ${wake.orgId} AND a.agent_id <> ${wake.agentId} AND a.role = 'lead'
        AND a.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM kin_handoffs h WHERE h.org_id = a.org_id
          AND h.from_agent_id = ${wake.agentId} AND h.to_agent_id = a.agent_id
          AND h.created_at >= ${wake.startedAt}
          AND (h.route_state IS NULL OR h.route_state = 'passed'))
      ORDER BY a.agent_id LIMIT 50`;
    const text = said.map((row) => row.body).join("\n");
    return agents.find((agent) =>
      new RegExp(`\\b${escaped(agent.name)}${AGENT_ACTS}`, "i").test(text),
    )?.name;
  }
  const kept = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${wake.orgId}
      AND substr(message_id, 1, ${relayPrefix(wake.wakeupId).length}) = ${relayPrefix(wake.wakeupId)}
    UNION ALL SELECT 1 FROM kin_messages WHERE org_id = ${wake.orgId} AND created_at >= ${since}
      AND ((author_kind = 'agent' AND author_agent_id = ${wake.agentId} AND chat_id <> ${wake.chatId})
        OR substr(message_id, 1, 11) = 'kin-assign-')
    UNION ALL SELECT 1 FROM kin_held_posts WHERE org_id = ${wake.orgId}
      AND (substr(kind, 1, ${relayPrefix(wake.wakeupId).length}) = ${relayPrefix(wake.wakeupId)}
        OR (held_at >= ${wake.startedAt} AND substr(kind, 1, 11) = 'kin-assign-'))
    UNION ALL SELECT 1 FROM kin_pulse_nudges WHERE org_id = ${wake.orgId}
      AND agent_id = ${wake.agentId} AND sent_at >= ${wake.startedAt}
    UNION ALL SELECT 1 FROM kin_lead_tool_calls WHERE org_id = ${wake.orgId}
      AND wakeup_id = ${wake.wakeupId} AND substr(call_key, 1, 9) = 'item:def-'
    UNION ALL SELECT 1 FROM kin_questions WHERE org_id = ${wake.orgId}
      AND agent_id = ${wake.agentId} AND person_id = ${named.personId}
      AND asked_at >= ${wake.startedAt} AND state = 'open' AND safe = 1
      AND default_label IS NOT NULL
    UNION ALL SELECT 1 FROM kin_handoffs WHERE org_id = ${wake.orgId}
      AND from_agent_id = ${wake.agentId} AND created_at >= ${wake.startedAt}
      AND (route_state IS NULL OR route_state = 'passed')
    LIMIT 1`;
  return kept.length > 0 ? undefined : named.first;
});

const CARD = /\b(?:card|tap confirm)\b/i;

/**
 * A wake-up's reply pointed at a card ("the card below", "tap Confirm") and the wake-up posted
 * none, as when its turn failed after replying and before the card.
 */
export const missingCard = Effect.fn("KinReplyPromises.missingCard")(function* (wake: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ agentId: string; threadId: string | null; startedAt: number }>`
    SELECT agent_id AS "agentId", thread_id AS "threadId", started_at AS "startedAt"
    FROM kin_wakeups WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}`;
  if (row === undefined || row.threadId === null) return false;
  const said = yield* sql<{ body: string; card: number }>`SELECT body,
      widget_id IS NOT NULL AS card FROM kin_messages
    WHERE org_id = ${wake.orgId} AND author_kind = 'agent' AND author_agent_id = ${row.agentId}
      AND author_thread_id = ${row.threadId} AND created_at >= ${iso(row.startedAt)}
    ORDER BY seq`;
  return (
    said.some((one) => one.card === 0 && CARD.test(one.body)) && !said.some((one) => one.card === 1)
  );
});
