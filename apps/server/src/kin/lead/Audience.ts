import { KinPersonId, type KinAgentId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ownerLevelPeople, ownerLevelSql } from "../people/KinAccess.ts";

/**
 * Who can read a lead turn's reply. Invariant: only an `owner_only` turn sees or changes the
 * owner's private context (memory, files, GitHub, other chats). Every capability that touches it
 * asks `effectiveAudience`, and every tool call passes `SharedTools` first; anything it can't
 * settle from stored rows is `shared`.
 */
export type TurnAudience = "owner_only" | "shared";

/**
 * Events that answer in the chat they name: a finished task names the chat its work was asked in,
 * and a teammate's task their direct chat with the lead.
 */
export const CHAT_ANSWER_TAGS = [
  "chat.message",
  "widget.action",
  "chat.reaction",
  "record.changed",
  "task.finished",
];

/**
 * A chat's people, for the owner tier: `others`, those in it now who are not owner-level, and
 * `formerOthers`, everyone who ever was. A chat someone else could once read stays below it.
 */
interface ChatPeople {
  readonly others: number;
  readonly formerOthers: number;
  readonly sharedAt: number | null;
}
const ownerTierChat = (row: ChatPeople) =>
  row.others === 0 && (row.sharedAt === null || row.formerOthers === 0);
const othersIn = (sql: SqlClient.SqlClient, current: boolean, agentId: string) =>
  sql`(SELECT COUNT(*) FROM kin_chat_members m
    WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'person'
      ${sql.literal(current ? "AND m.left_at IS NULL" : "")}
      AND m.person_id IS NOT (SELECT a.owner_person_id FROM kin_agents a
        WHERE a.org_id = c.org_id AND a.agent_id = ${agentId})
      AND NOT ${sql.literal(ownerLevelSql("m.org_id", "m.person_id"))})`;

/**
 * `owner_only` when only owner-level people can read the reply: no one else is or ever was in a
 * chat it answers or was asked from, and every stored author, reactor and asker is owner-level.
 * From stored rows only, never model text.
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
    const level = (yield* ownerLevelPeople(input.orgId)).add(lead.owner);
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
        AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
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
        if (event.authorKind === "human" && !level.has(event.authorPersonId ?? ""))
          return "shared" as const;
        chats.add(event.chatId);
      } else if (event.tag === "chat.reaction") {
        answersChat = true;
        if (event.chatId === null) return "shared" as const;
        if (event.provenance === "human" && !level.has(event.provenancePersonId ?? ""))
          return "shared" as const;
        chats.add(event.chatId);
      } else if (
        (event.tag === "record.changed" || event.tag === "task.finished") &&
        event.chatId !== null
      ) {
        // A finished task answers in the chat it was asked for in, read by everyone there.
        answersChat = true;
        chats.add(event.chatId);
      }
      if (event.originPersonId !== null && !level.has(event.originPersonId))
        return "shared" as const;
      if (event.originChatId !== null) chats.add(event.originChatId);
    }
    if (!answersChat) chats.add(lead.ownerChatId);
    const rows = yield* sql<ChatPeople>`
      SELECT ${othersIn(sql, true, input.agentId)} AS others,
        ${othersIn(sql, false, input.agentId)} AS "formerOthers", c.shared_at AS "sharedAt"
      FROM kin_chats c WHERE c.org_id = ${input.orgId} AND c.chat_id IN ${sql.in([...chats])}
      ORDER BY c.chat_id`;
    return rows.length === chats.size && rows.every(ownerTierChat)
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
 * The people behind a turn, from stored rows only. Readers: every current human member of each
 * chat it answers in or was asked from (else the lead's owner chat). Askers: whoever's act it
 * carries out, by stored author, reactor, `origin.personId` or a task's assigner. Someone whose
 * words a task quotes is neither. `owner` is the lead's owner.
 */
export const peopleBehind = Effect.fn("KinAudience.peopleBehind")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ owner: string; ownerChatId: string }>`
    SELECT a.owner_person_id AS owner, l.owner_chat_id AS "ownerChatId" FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${turn.orgId} AND l.agent_id = ${turn.agentId} ORDER BY l.agent_id`;
  if (lead === undefined) return undefined;
  const events = yield* sql<{
    chatId: string | null;
    originChatId: string | null;
    asker: string | null;
    originPersonId: string | null;
  }>`
    SELECT CASE WHEN e.tag IN ${sql.in(CHAT_ANSWER_TAGS)} THEN json_extract(e.json, '$.chatId') END AS "chatId",
      json_extract(e.json, '$.origin.chatId') AS "originChatId",
      json_extract(e.json, '$.origin.personId') AS "originPersonId",
      CASE
        WHEN e.tag IN ('chat.message', 'widget.action') THEN (SELECT m.author_person_id
          FROM kin_messages m WHERE m.org_id = e.org_id AND m.author_kind = 'human'
            AND m.message_id = json_extract(e.json, '$.messageId')
            AND m.chat_id = json_extract(e.json, '$.chatId'))
        WHEN e.tag IN ('chat.reaction', 'record.changed')
          AND json_extract(e.json, '$.provenance._tag') = 'human'
          THEN json_extract(e.json, '$.provenance.personId')
        END AS asker
    FROM kin_events e
    WHERE e.org_id = ${turn.orgId} AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
    ORDER BY e.event_id`;
  const chats = new Set<string>();
  const askers = new Set<KinPersonId>();
  let answersChat = false;
  for (const event of events) {
    if (event.chatId !== null) {
      answersChat = true;
      chats.add(event.chatId);
    }
    if (event.originChatId !== null) chats.add(event.originChatId);
    if (event.asker !== null) askers.add(KinPersonId.make(event.asker));
    if (event.originPersonId !== null) askers.add(KinPersonId.make(event.originPersonId));
  }
  if (!answersChat) chats.add(lead.ownerChatId);
  const members = yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${turn.orgId} AND chat_id IN ${sql.in([...chats])}
      AND principal_kind = 'person' AND left_at IS NULL AND person_id IS NOT NULL
    ORDER BY person_id`;
  return {
    owner: KinPersonId.make(lead.owner),
    readers: new Set(members.map((row) => KinPersonId.make(row.personId))),
    askers,
    level: (yield* ownerLevelPeople(turn.orgId)).add(lead.owner),
  };
});

/**
 * The people behind a turn whose view a `view` tool reads at: every one who is not owner-level,
 * and which of them asked. Empty means the owner alone.
 */
export const turnPeople = Effect.fn("KinAudience.turnPeople")(function* (turn: Turn) {
  const behind = yield* peopleBehind(turn);
  if (behind === undefined) return undefined;
  const people = [...new Set([...behind.readers, ...behind.askers])]
    .filter((person) => !behind.level.has(person))
    .toSorted();
  return {
    people,
    askers: people.filter((person) => behind.askers.has(person)),
    owner: behind.owner,
  };
});

/** The one person whose act the turn carries out, or null when there is none or more than one. */
export const turnAsker = Effect.fn("KinAudience.turnAsker")(function* (turn: Turn) {
  const askers = [...((yield* peopleBehind(turn))?.askers ?? [])];
  return askers.length === 1 ? (askers[0] ?? null) : null;
});

/**
 * Whether the lead's owner alone is behind the turn: then it runs on the lead's one owner thread.
 * A co-owner's owner-tier turn runs on its chat's own, so the owner's chats stay his.
 */
export const ownerAlone = Effect.fn("KinAudience.ownerAlone")(function* (turn: Turn) {
  const behind = yield* peopleBehind(turn);
  if (behind === undefined) return false;
  return [...behind.readers, ...behind.askers].every((person) => person === behind.owner);
});

/** Whether every person behind the turn is in `chatId` now: what an owner-tier turn may read. */
export const behindAllIn = Effect.fn("KinAudience.behindAllIn")(function* (
  turn: Turn,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const behind = yield* peopleBehind(turn);
  if (behind === undefined) return false;
  const people = [...new Set([...behind.readers, ...behind.askers])];
  if (people.length === 0) return false;
  const rows = yield* sql<{ personId: string }>`SELECT DISTINCT person_id AS "personId"
    FROM kin_chat_members WHERE org_id = ${turn.orgId} AND chat_id = ${chatId}
      AND principal_kind = 'person' AND left_at IS NULL AND person_id IN ${sql.in(people)}
    ORDER BY person_id`;
  return rows.length === people.length;
});

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

/** `chatId` is this turn's asker's own direct chat with this agent: theirs alone to be reminded in. */
export const askersDirectChat = Effect.fn("KinAudience.askersDirectChat")(function* (
  turn: Turn,
  chatId: string,
) {
  if (!(yield* askedIn(turn, chatId))) return false;
  const sql = yield* SqlClient.SqlClient;
  const suffix = `:${turn.agentId}`;
  const rows = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${turn.orgId}
    AND chat_id = ${chatId} AND kind = 'direct' AND archived_at IS NULL
    AND substr(direct_key, ${-suffix.length}) = ${suffix} LIMIT 1`;
  return rows.length > 0;
});

/** Whether the turn may read `chatId`, by the rule its chat reads use (`KinLevelGate.read`). */
export const mayReadChat = Effect.fn("KinAudience.mayReadChat")(function* (
  turn: Turn,
  chatId: string,
) {
  if (yield* aborted(turn)) return false;
  if ((yield* effectiveAudience(turn)) === "shared") return yield* askedIn(turn, chatId);
  return (yield* ownerAlone(turn)) || (yield* behindAllIn(turn, chatId));
});

/**
 * Everyone who is or ever was in the chat is owner-level; none is, in a chat that isn't this
 * org's. A chat someone else could once read stays out of owner-tier reach.
 */
export const ownerOnlyChat = Effect.fn("KinAudience.ownerOnlyChat")(function* (
  turn: Pick<Turn, "orgId" | "agentId">,
  chatId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ChatPeople>`
    SELECT ${othersIn(sql, true, turn.agentId)} AS others,
      ${othersIn(sql, false, turn.agentId)} AS "formerOthers", c.shared_at AS "sharedAt"
    FROM kin_chats c WHERE c.org_id = ${turn.orgId} AND c.chat_id = ${chatId}
    ORDER BY c.chat_id`;
  return rows.every(ownerTierChat);
});

/**
 * Whether the turn was aborted because someone besides the owner joined a chat it answers in
 * (`abortChatTurns`): it may do nothing more anywhere.
 */
export const aborted = Effect.fn("KinAudience.aborted")(function* (turn: Turn) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${turn.orgId}
    AND wakeup_id = ${turn.wakeupId} AND aborted_at IS NOT NULL LIMIT 1`;
  return rows.length > 0;
});

/**
 * In the join's transaction: aborts every running turn answering or asked from `chatId`, whatever
 * its audience (its prompt may hold what the newcomer may not read), unless `personId` is its
 * lead's owner or its reply settled. Returns the turns the caller must stop after commit.
 */
export const abortChatTurns = Effect.fn("KinAudience.abortChatTurns")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: string;
  readonly personId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  return yield* sql<{ agentId: KinAgentId; wakeupId: string }>`
    UPDATE kin_wakeups AS w SET aborted_at = ${now}, shared_since = COALESCE(shared_since, ${now})
    WHERE w.org_id = ${input.orgId} AND w.status = 'running' AND w.aborted_at IS NULL
      AND w.settled_at IS NULL
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

/** A shared turn's lead thread; `KinSessions` plans it confined: no file tools. */
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

export const SHARED_OTHER_CHAT =
  "In a chat with other people you read only the chat you were asked in.";
export const OTHERS_CHAT = "You read only chats everyone you are working for here is in.";
export const AUDIENCE_MOVED =
  "Someone else joined this chat while you were working, so nothing was sent.";
/** The one line a tool refused in a chat other people can read answers with. */
export const SHARED_REFUSAL = "I can't do that in a chat other people can read.";
/** Why a full session's hook refused a shell, edit, web or sub-agent call: the model reads it. */
export const SESSION_REFUSAL = {
  shared:
    "Blocked: other people can read this chat, so it has no shell. Ask the owner in their own chat.",
  aborted:
    "Blocked: someone else joined this chat, so this turn stopped. Ask the owner in their own chat.",
  outside:
    "Blocked: this turn read outside content, so it has no shell now. Ask the owner to start it in a fresh turn.",
  none: "Blocked: no owner's turn backs this session, so it has no shell. Ask the owner in their own chat.",
} as const;
export const SHARED_ELSEWHERE =
  "In a chat with other people you post only in the chat you were asked in. Nothing was sent.";
export const PRIVATE_DESTINATION =
  "Other people are in that chat, so nothing was sent there. Kin told the owner.";
