import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who can read a lead turn's reply. Invariant: only an `owner_only` turn sees or changes the
 * owner's private context (memory, files, GitHub, other chats). Every capability that touches it
 * asks this one function; anything it can't settle from stored rows is `shared`.
 */
export type TurnAudience = "owner_only" | "shared";

/**
 * `owner_only` when everyone who can read the reply is the lead's owner: every person still in
 * the chat it answers (its owner chat when no chat event woke it) and in every chat a due
 * deferral or passed-on request came from, every stored author of the messages and taps it
 * answers, and every reacting person. Read from stored rows only, never from model text.
 */
export const turnAudience = Effect.fn("KinAudience.turnAudience")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const [lead] = yield* sql<{ owner: string; ownerChatId: string }>`
      SELECT a.owner_person_id AS owner, l.owner_chat_id AS "ownerChatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
        AND a.role = 'lead' AND a.retired_at IS NULL
      ORDER BY l.agent_id`;
    if (lead === undefined) return "shared" as const;
    const events = yield* sql<{
      tag: string;
      chatId: string | null;
      originChatId: string | null;
      originPersonId: string | null;
      provenance: string | null;
      provenancePersonId: string | null;
      messageChatId: string | null;
      authorKind: string | null;
      authorPersonId: string | null;
    }>`
      SELECT e.tag, json_extract(e.json, '$.chatId') AS "chatId",
        json_extract(e.json, '$.origin.chatId') AS "originChatId",
        json_extract(e.json, '$.origin.personId') AS "originPersonId",
        json_extract(e.json, '$.provenance._tag') AS provenance,
        json_extract(e.json, '$.provenance.personId') AS "provenancePersonId",
        m.chat_id AS "messageChatId", m.author_kind AS "authorKind",
        m.author_person_id AS "authorPersonId"
      FROM kin_events e
      LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
        AND m.message_id = json_extract(e.json, '$.messageId')
      WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
        AND e.wakeup_id = ${input.wakeupId}
      ORDER BY e.event_id`;
    if (events.length === 0) return "shared" as const;
    const chats = new Set<string>();
    let answersChat = false;
    for (const event of events) {
      if (event.tag === "chat.message" || event.tag === "widget.action") {
        answersChat = true;
        if (event.chatId === null || event.messageChatId !== event.chatId) return "shared" as const;
        if (event.authorKind === "human" && event.authorPersonId !== lead.owner)
          return "shared" as const;
        chats.add(event.chatId);
      } else if (event.tag === "chat.reaction") {
        answersChat = true;
        if (event.chatId === null) return "shared" as const;
        if (event.provenance === "human" && event.provenancePersonId !== lead.owner)
          return "shared" as const;
        chats.add(event.chatId);
      }
      if (event.originPersonId !== null) return "shared" as const;
      if (event.originChatId !== null) chats.add(event.originChatId);
    }
    if (!answersChat) chats.add(lead.ownerChatId);
    const rows = yield* sql<{ others: number }>`
      SELECT (SELECT COUNT(*) FROM kin_chat_members m
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
            AND m.left_at IS NULL AND m.person_id IS NOT ${lead.owner}) AS others
      FROM kin_chats c WHERE c.org_id = ${input.orgId} AND c.chat_id IN ${sql.in([...chats])}
      ORDER BY c.chat_id`;
    return rows.length === chats.size && rows.every((row) => row.others === 0)
      ? ("owner_only" as const)
      : ("shared" as const);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin turn audience unavailable; treating the turn as shared", {
      cause,
    }).pipe(Effect.as<TurnAudience>("shared")),
  ),
);

/**
 * The audience a turn's prompt was built for, never wider than what it is now: an owner-only
 * prompt whose chat gained someone else since must not speak there. Unrecorded counts as
 * owner-only, so a turn from before the record never slips through.
 */
export const audienceChanged = Effect.fn("KinAudience.audienceChanged")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ audience: string | null }>`
      SELECT audience FROM kin_wakeups WHERE org_id = ${input.orgId}
        AND agent_id = ${input.agentId} AND wakeup_id = ${input.wakeupId}
      ORDER BY wakeup_id`;
    if (row?.audience === "shared") return false;
    return (yield* turnAudience(input)) === "shared";
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin turn audience record unavailable", { cause }).pipe(Effect.as(true)),
  ),
);

/** Records what the prompt was built for; shared, once recorded, stays shared. */
export const recordAudience = Effect.fn("KinAudience.recordAudience")(function* (
  input: { readonly orgId: KinOrgId; readonly wakeupId: string },
  audience: TurnAudience,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_wakeups SET audience = CASE WHEN audience = 'shared' THEN 'shared'
      ELSE ${audience} END
    WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
});

/** A shared turn's lead thread; `LeadIsolation` gives it no file tools. */
export const SHARED_THREAD_PREFIX = "kin-shared:";

/** The audience the wake-up's prompt was built for; unrecorded reads as shared. */
export const recordedAudience = Effect.fn("KinAudience.recordedAudience")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ audience: string | null }>`
    SELECT audience FROM kin_wakeups WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}
    ORDER BY wakeup_id`;
  return row?.audience === "owner_only" ? ("owner_only" as const) : ("shared" as const);
});

/** What a lead may say when a shared chat asks for something only the owner's turns have. */
export const SHARED_NOTES =
  "You don't use your notes in chats with other people. Answer from this chat alone, without mentioning notes.";
export const SHARED_GITHUB =
  "You don't read GitHub in chats with other people. Answer from this chat alone.";
export const SHARED_OTHER_CHAT =
  "In a chat with other people you read only the chat you were asked in.";
export const AUDIENCE_MOVED =
  "Someone else joined this chat while you were working, so nothing was sent.";
