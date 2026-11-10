import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { askedIn, turnChat } from "./Audience.ts";

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};
type Condition = (
  turn: Turn,
  args: unknown,
) => Effect.Effect<boolean, SqlError, SqlClient.SqlClient>;

/**
 * What a tool may do in a turn someone besides the owner can read. Every tool on the Kin MCP
 * endpoint has a line here, and the endpoint's gate refuses any tool without one, so a new tool
 * stays refused in such turns until it is added. Conditions read stored rows; arguments only
 * name what the call is about.
 */
export type SharedToolPolicy = "allowed" | "refused" | Condition;

const field = (args: unknown, name: string) =>
  Predicate.hasProperty(args, name) ? args[name] : undefined;

/** Writes into the chat the turn answers; `destination` checks the same inside the write. */
const inTurnChat: Condition = Effect.fnUntraced(function* (turn, args) {
  const chatId = field(args, "chatId");
  return typeof chatId === "string" && (yield* turnChat(turn))?.chatId === chatId;
});

const inAskedChat: Condition = Effect.fnUntraced(function* (turn, args) {
  const chatId = field(args, "chatId");
  return typeof chatId === "string" && (yield* askedIn(turn, chatId));
});

/** Every message, tap and reaction the turn answers is the owner's own, by stored author. */
const ownerAsked = Effect.fnUntraced(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ fromOwner: number }>`
    SELECT CASE
        WHEN json_extract(e.json, '$.origin.personId') IS NOT NULL THEN 0
        WHEN e.tag IN ('chat.message', 'widget.action') THEN
          m.author_kind = 'human' AND m.author_person_id = a.owner_person_id
            AND m.chat_id = json_extract(e.json, '$.chatId')
        WHEN e.tag = 'chat.reaction' THEN
          json_extract(e.json, '$.provenance._tag') = 'human'
            AND json_extract(e.json, '$.provenance.personId') = a.owner_person_id
        ELSE 0 END AS "fromOwner"
    FROM kin_events e
    JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId}
      AND e.wakeup_id = ${turn.wakeupId}
    ORDER BY e.event_id`;
  return rows.length > 0 && rows.every((row) => row.fromOwner === 1);
});

/** The owner asked, and the worker is this lead's and was asked for in the chat this turn answers. */
const ownerAskedAboutWorkerHere: Condition = Effect.fnUntraced(function* (turn, args) {
  const workerId = field(args, "workerId");
  if (typeof workerId !== "string" || !(yield* ownerAsked(turn))) return false;
  const chat = yield* turnChat(turn);
  if (chat === undefined) return false;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_workers
    WHERE org_id = ${turn.orgId} AND worker_id = ${workerId} AND agent_id = ${turn.agentId}
      AND chat_id = ${chat.chatId}
    LIMIT 1`;
  return rows.length > 0;
});

/** The owner may start work from a team chat, but no note of theirs goes with it. */
const ownerDelegates: Condition = Effect.fnUntraced(function* (turn, args) {
  const memory = field(args, "memoryItemIds");
  if (memory !== undefined && !(Array.isArray(memory) && memory.length === 0)) return false;
  return yield* ownerAsked(turn);
});

export const SHARED_TOOLS = {
  kin_chat_post: inTurnChat,
  kin_widget_upsert: inTurnChat,
  // These two take no chat: they go to the turn's own chat, and `destination` checks it.
  kin_ask: "allowed",
  kin_react: "allowed",
  kin_chat_read: inAskedChat,
  // Lists only the names of the leads in the asked chat (`KinHandoff.leads`).
  kin_leads: "allowed",
  // Ends the turn; a shared turn's summary reaches no journal (`LeadMemory.end`).
  kin_end: "allowed",
  kin_delegate: ownerDelegates,
  kin_follow_up: ownerAskedAboutWorkerHere,
  kin_worker_stop: ownerAskedAboutWorkerHere,
  kin_hand_off: "refused",
  memory_search: "refused",
  memory_read: "refused",
  memory_write: "refused",
  kin_defer: "refused",
  kin_schedule: "refused",
  kin_cancel: "refused",
  kin_journal: "refused",
  kin_github_repos: "refused",
  kin_github_prs: "refused",
  kin_github_pr: "refused",
  kin_github_runs: "refused",
  request_action: "refused",
} satisfies Record<string, SharedToolPolicy>;

/** Whether `name` may run with these arguments in a turn someone besides the owner reads. */
export const sharedToolAllowed = Effect.fn("KinSharedTools.allowed")(
  function* (turn: Turn, name: string, args: unknown) {
    const policy: SharedToolPolicy | undefined = Object.hasOwn(SHARED_TOOLS, name)
      ? SHARED_TOOLS[name as keyof typeof SHARED_TOOLS]
      : undefined;
    if (policy === undefined || policy === "refused") return false;
    if (policy === "allowed") return true;
    return yield* policy(turn, args);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin shared tool check failed; refusing", { cause }).pipe(Effect.as(false)),
  ),
);
