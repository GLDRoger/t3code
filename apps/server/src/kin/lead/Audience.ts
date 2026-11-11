import type { KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who can read a lead turn's reply. Invariant: only an `owner_only` turn sees or changes the
 * owner's private context (memory, files, GitHub, other chats). Every capability that touches it
 * asks `effectiveAudience`, and every tool call passes `SharedTools` first; anything it can't
 * settle from stored rows is `shared`.
 */
export type TurnAudience = "owner_only" | "shared";

/** Events that answer in the chat they name: a worker report names the chat its work was asked in. */
export const CHAT_ANSWER_TAGS = ["chat.message", "widget.action", "chat.reaction", "worker.report"];

/**
 * `owner_only` when only the owner can read the reply: every chat it answers or was asked from was
 * never shared (`shared_at`) and has no one else in it, every stored author and reactor is the
 * owner, and every reported worker is private. From stored rows only, never model text.
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
      workerContext: string | null;
    }>`
      SELECT e.tag, json_extract(e.json, '$.chatId') AS "chatId",
        (SELECT k.context FROM kin_workers k WHERE k.org_id = e.org_id AND e.tag = 'worker.report'
          AND k.worker_id = json_extract(e.json, '$.workerId')) AS "workerContext",
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
      } else if (event.tag === "worker.report" && event.chatId !== null) {
        // A report answers in the chat its worker was asked for in, read by everyone there.
        answersChat = true;
        chats.add(event.chatId);
      }
      // Shared work never reports into a private turn, whichever chat it now answers in.
      if (event.tag === "worker.report" && event.workerContext !== "private")
        return "shared" as const;
      if (event.originPersonId !== null) return "shared" as const;
      if (event.originChatId !== null) chats.add(event.originChatId);
    }
    if (!answersChat) chats.add(lead.ownerChatId);
    const rows = yield* sql<{ others: number; sharedAt: number | null }>`
      SELECT (SELECT COUNT(*) FROM kin_chat_members m
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
            AND m.left_at IS NULL AND m.person_id IS NOT ${lead.owner}) AS others,
        c.shared_at AS "sharedAt"
      FROM kin_chats c WHERE c.org_id = ${input.orgId} AND c.chat_id IN ${sql.in([...chats])}
      ORDER BY c.chat_id`;
    return rows.length === chats.size &&
      rows.every((row) => row.others === 0 && row.sharedAt === null)
      ? ("owner_only" as const)
      : ("shared" as const);
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin turn audience unavailable; treating the turn as shared", {
      cause,
    }).pipe(Effect.as<TurnAudience>("shared")),
  ),
);

type Turn = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
};

/**
 * The one audience every capability check uses. `owner_only` only while the prompt was built for
 * the owner alone and the turn still is: unrecorded counts as shared, and a turn found shared once
 * stays shared until it ends (`shared_since`), whoever leaves the chat afterwards.
 */
export const effectiveAudience = Effect.fn("KinAudience.effectiveAudience")(
  function* (turn: Turn) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      audience: string | null;
      sharedSince: number | null;
      abortedAt: number | null;
    }>`
      SELECT audience, shared_since AS "sharedSince", aborted_at AS "abortedAt" FROM kin_wakeups
      WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
      ORDER BY wakeup_id`;
    if (row?.audience !== "owner_only" || row.sharedSince !== null || row.abortedAt !== null)
      return "shared" as const;
    if ((yield* turnAudience(turn)) === "owner_only") return "owner_only" as const;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`UPDATE kin_wakeups SET shared_since = COALESCE(shared_since, ${now})
      WHERE org_id = ${turn.orgId} AND wakeup_id = ${turn.wakeupId}`;
    return "shared" as const;
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin turn audience unavailable; treating the turn as shared", {
      cause,
    }).pipe(Effect.as<TurnAudience>("shared")),
  ),
);

/** Whether the prompt may carry the owner's context: recorded owner-only, or never recorded. */
const promptPrivate = Effect.fnUntraced(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ audience: string | null }>`
    SELECT audience FROM kin_wakeups WHERE org_id = ${turn.orgId}
      AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
    ORDER BY wakeup_id`;
  return row?.audience !== "shared";
});

/**
 * An owner-only prompt whose turn someone else can now read: it must not speak there, and takes
 * no more messages. A shared prompt never changed.
 */
export const audienceChanged = Effect.fn("KinAudience.audienceChanged")(
  function* (turn: Turn) {
    if (!(yield* promptPrivate(turn))) return false;
    return (yield* effectiveAudience(turn)) === "shared";
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin turn audience record unavailable", { cause }).pipe(Effect.as(true)),
  ),
);

/**
 * The chat a turn answers in, from its stored events: the first chat event's or reported work's,
 * else the lead's owner chat. `asked` when such an event woke it there.
 */
export const turnChat = Effect.fn("KinAudience.turnChat")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const [human] = yield* sql<{ chatId: string | null }>`
    SELECT json_extract(json, '$.chatId') AS "chatId" FROM kin_events
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
      AND tag IN ${sql.in(CHAT_ANSWER_TAGS)} AND json_extract(json, '$.chatId') IS NOT NULL
    ORDER BY priority, received_at, event_id LIMIT 1`;
  if (human?.chatId !== undefined && human.chatId !== null)
    return { chatId: human.chatId, asked: true };
  const [lead] = yield* sql<{ ownerChatId: string }>`
    SELECT owner_chat_id AS "ownerChatId" FROM kin_leads
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} ORDER BY agent_id`;
  return lead === undefined ? undefined : { chatId: lead.ownerChatId, asked: false };
});

/** Whether a chat event or reported work of this turn came from `chatId`: what a shared turn reads. */
export const askedIn = Effect.fn("KinAudience.askedIn")(function* (turn: Turn, chatId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_events
    WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
      AND tag IN ${sql.in(CHAT_ANSWER_TAGS)}
      AND json_extract(json, '$.chatId') = ${chatId}
    LIMIT 1`;
  return rows.length > 0;
});

/**
 * The chat was never shared and every human now in it is the lead's owner; none is, in a chat
 * that isn't this org's. A chat someone else could once read stays out of owner-only reach.
 */
export const ownerOnlyChat = Effect.fn("KinAudience.ownerOnlyChat")(function* (
  turn: Pick<Turn, "orgId" | "agentId">,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ others: number; sharedAt: number | null }>`
    SELECT (SELECT COUNT(*) FROM kin_chat_members m
        WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
          AND m.left_at IS NULL AND m.person_id IS NOT a.owner_person_id) AS others,
      c.shared_at AS "sharedAt"
    FROM kin_chats c JOIN kin_agents a ON a.org_id = c.org_id AND a.agent_id = ${turn.agentId}
    WHERE c.org_id = ${turn.orgId} AND c.chat_id = ${chatId}
    ORDER BY c.chat_id`;
  return rows.every((row) => row.others === 0 && row.sharedAt === null);
});

/**
 * Whether the turn was aborted because someone besides the owner joined a chat it answers in
 * (`abortPrivateTurns`): it may do nothing more anywhere.
 */
export const aborted = Effect.fn("KinAudience.aborted")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${turn.orgId}
    AND wakeup_id = ${turn.wakeupId} AND aborted_at IS NOT NULL LIMIT 1`;
  return rows.length > 0;
});

/**
 * In the join's transaction: aborts every running turn answering or asked from `chatId` that is
 * private or was built before the chat was shared, or any such turn once `floorRaised` (it read
 * below the new history floor), unless `personId` is its lead's owner or its reply settled.
 * Returns the turns the caller must stop after commit.
 */
export const abortPrivateTurns = Effect.fn("KinAudience.abortPrivateTurns")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
  readonly floorRaised: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  return yield* sql<{ agentId: KinAgentId; wakeupId: string }>`
    UPDATE kin_wakeups AS w SET aborted_at = ${now}, shared_since = COALESCE(shared_since, ${now})
    WHERE w.org_id = ${input.orgId} AND w.status = 'running' AND w.aborted_at IS NULL
      AND w.settled_at IS NULL
      AND (${input.floorRaised ? 1 : 0} = 1 OR w.audience IS NOT 'shared' OR EXISTS (SELECT 1 FROM kin_chats c
        WHERE c.org_id = w.org_id AND c.chat_id = ${input.chatId} AND w.started_at <= c.shared_at))
      AND EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = w.org_id
        AND a.agent_id = w.agent_id AND a.owner_person_id IS NOT ${input.personId})
      AND (EXISTS (SELECT 1 FROM kin_events e
          WHERE e.org_id = w.org_id AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id
            AND ((e.tag IN ${sql.in(CHAT_ANSWER_TAGS)}
                AND json_extract(e.json, '$.chatId') = ${input.chatId})
              OR json_extract(e.json, '$.origin.chatId') = ${input.chatId}))
        OR (NOT EXISTS (SELECT 1 FROM kin_events e
            WHERE e.org_id = w.org_id AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id
              AND e.tag IN ${sql.in(CHAT_ANSWER_TAGS)} AND json_extract(e.json, '$.chatId') IS NOT NULL)
          AND EXISTS (SELECT 1 FROM kin_leads l WHERE l.org_id = w.org_id
            AND l.agent_id = w.agent_id AND l.owner_chat_id = ${input.chatId})))
    RETURNING agent_id AS "agentId", wakeup_id AS "wakeupId"`;
});

/**
 * Where a turn may post, card, ask or react: a shared turn only in the chat it answers, and a
 * prompt that may carry the owner's context only where every human is the owner; an aborted
 * turn nowhere. Run it in the write's transaction.
 */
export const destination = Effect.fn("KinAudience.destination")(function* (
  turn: Turn,
  chatId: string,
) {
  if (yield* aborted(turn)) return "aborted" as const;
  const own = yield* turnChat(turn);
  if ((yield* effectiveAudience(turn)) === "shared" && own?.chatId !== chatId)
    return "elsewhere" as const;
  if ((yield* promptPrivate(turn)) && !(yield* ownerOnlyChat(turn, chatId)))
    return own?.chatId === chatId ? ("moved" as const) : ("private" as const);
  return "allowed" as const;
});

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
/** The one line a tool refused in a chat other people can read answers with. */
export const SHARED_REFUSAL = "I can't do that in a chat other people can read.";
export const SHARED_ELSEWHERE =
  "In a chat with other people you post only in the chat you were asked in. Nothing was sent.";
export const PRIVATE_DESTINATION =
  "Other people are in that chat, so nothing was sent there. Kin told the owner.";
