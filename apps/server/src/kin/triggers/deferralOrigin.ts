import {
  KinAgentId,
  KinChatId,
  KinEvent,
  type KinOrgId,
  KinPersonId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerOnlyChat } from "../lead/Audience.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { ownsAgent } from "../people/KinAccess.ts";

export type DeferralSource = Pick<MemoryItemHead, "chat" | "source_event">;

const decodeStoredEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));

/**
 * Where a deferral was asked, from its stored source event and never tool input: that event's
 * origin, else its chat, else the lead's owner chat (undefined, so it runs as always). It names a
 * teammate whose message was in the wake-up that made it, whichever event the lead cited.
 */
export const deferralOrigin = Effect.fn("Deferrals.origin")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: DeferralSource | undefined,
  // Without one, an origin in some lead's owner chat comes back as that chat, not undefined.
  lead?: { readonly agentId: KinAgentId; readonly ownerChatId: KinChatId },
) {
  const [row] =
    item?.source_event === undefined
      ? []
      : yield* sql<{
          agentId: string;
          json: string;
          ownerChatId: string;
          ownerPersonId: string;
          wakeupId: string | null;
        }>`
          SELECT e.agent_id AS "agentId", e.json, l.owner_chat_id AS "ownerChatId",
            a.owner_person_id AS "ownerPersonId", e.wakeup_id AS "wakeupId" FROM kin_events e
          JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
          JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
          WHERE e.org_id = ${orgId} AND e.event_id = ${item.source_event} ORDER BY e.event_id`;
  const event =
    row === undefined
      ? undefined
      : Option.getOrUndefined(yield* decodeStoredEvent(row.json).pipe(Effect.option));
  const origin: KinLevels.KinOrigin | undefined =
    row === undefined || event === undefined
      ? item?.chat === undefined || lead === undefined
        ? undefined
        : { agentId: lead.agentId, chatId: item.chat }
      : (event._tag === "deferral.due" || event._tag === "chat.message") &&
          event.origin !== undefined
        ? // Made while answering a due deferral or a passed-on request: where that was first asked.
          event.origin
        : event._tag === "chat.message" ||
            event._tag === "widget.action" ||
            event._tag === "chat.reaction"
          ? { agentId: KinAgentId.make(row.agentId), chatId: event.chatId }
          : event._tag === "task.finished"
            ? { agentId: KinAgentId.make(row.agentId), chatId: event.chatId }
            : { agentId: KinAgentId.make(row.agentId), chatId: KinChatId.make(row.ownerChatId) };
  const asker =
    origin === undefined ||
    origin.personId !== undefined ||
    row === undefined ||
    event === undefined
      ? undefined
      : ((row.wakeupId === null
          ? undefined
          : (yield* KinLevels.askers({
              orgId,
              agentId: KinAgentId.make(row.agentId),
              wakeupId: row.wakeupId,
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)))[0]) ??
        (event.provenance._tag === "human" && !ownsAgent(row, event.provenance.personId)
          ? event.provenance.personId
          : undefined));
  if (origin !== undefined && asker !== undefined) return { ...origin, personId: asker };
  return origin === undefined ||
    (lead !== undefined &&
      origin.personId === undefined &&
      origin.agentId === lead.agentId &&
      origin.chatId === lead.ownerChatId)
    ? undefined
    : origin;
});

/**
 * One rule for the owner's index and dreams: an item asked by a teammate, or from a chat that was
 * ever shared or has someone else in it, is not the owner's. Naming a chat or source event whose
 * provenance stored rows can't resolve counts as shared; naming neither is the owner's own note.
 */
export const askedWhereOthersRead = Effect.fn("Deferrals.askedWhereOthersRead")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: DeferralSource | undefined,
) {
  if (item === undefined || (item.chat === undefined && item.source_event === undefined))
    return false;
  if (item.source_event === undefined) return true;
  const [row] = yield* sql<{ agentId: string; ownerChatId: string; json: string }>`
    SELECT e.agent_id AS "agentId", l.owner_chat_id AS "ownerChatId", e.json FROM kin_events e
    JOIN kin_leads l ON l.org_id = e.org_id AND l.agent_id = e.agent_id
    WHERE e.org_id = ${orgId} AND e.event_id = ${item.source_event} ORDER BY e.event_id`;
  if (row === undefined || Option.isNone(yield* decodeStoredEvent(row.json).pipe(Effect.option)))
    return true;
  const lead = {
    agentId: KinAgentId.make(row.agentId),
    ownerChatId: KinChatId.make(row.ownerChatId),
  };
  const origin = yield* deferralOrigin(sql, orgId, item, lead);
  if (origin?.personId !== undefined) return true;
  return !(yield* ownerOnlyChat(
    { orgId, agentId: origin?.agentId ?? lead.agentId },
    origin?.chatId ?? lead.ownerChatId,
  ).pipe(Effect.provideService(SqlClient.SqlClient, sql)));
});

/**
 * The origin a due reminder, deferral or scheduled run carries when it fires. Private work (set
 * up by an owner-only turn, `kin_wakeups.audience`, with no teammate asking) whose chat was
 * shared since no longer speaks there: it fires in its lead's owner chat, as an owner-only turn.
 * Everything else keeps `deferralOrigin`'s.
 */
export const firingOrigin = Effect.fn("Deferrals.firingOrigin")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: DeferralSource | undefined,
  lead: { readonly agentId: KinAgentId; readonly ownerChatId: KinChatId },
) {
  const origin = yield* deferralOrigin(sql, orgId, item, lead);
  if (origin === undefined || origin.personId !== undefined || item?.source_event === undefined)
    return origin;
  const [row] = yield* sql<{ shared: number; private: number }>`
    SELECT EXISTS (SELECT 1 FROM kin_chats c WHERE c.org_id = ${orgId}
        AND c.chat_id = ${origin.chatId} AND c.shared_at IS NOT NULL) AS shared,
      EXISTS (SELECT 1 FROM kin_events e JOIN kin_wakeups w ON w.org_id = e.org_id
        AND w.wakeup_id = e.wakeup_id
        WHERE e.org_id = ${orgId} AND e.event_id = ${item.source_event}
          AND w.audience = 'owner_only') AS private`;
  return row?.shared === 1 && row.private === 1 ? undefined : origin;
});

/** Where a reminder's or routine's card goes: its chat, or `fallback` once that was shared. */
export const cardChatFor = Effect.fn("Deferrals.cardChatFor")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  chatId: string,
  fallback: KinChatId | null,
) {
  const [row] = yield* sql<{ shared: number }>`SELECT shared_at IS NOT NULL AS shared
    FROM kin_chats WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY chat_id`;
  if (row === undefined) return null;
  return row.shared === 1 ? fallback : KinChatId.make(chatId);
});

/**
 * Someone's own direct chat with an agent, not a lead's owner chat: their reminders go back there.
 * `theirs` says they set it themselves, so their turn may move it (`LeadMemory.cancelOwn`).
 */
export const askersChat = Effect.fn("Deferrals.askersChat")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: { readonly chat?: string | undefined; readonly said_by: string } | undefined,
) {
  if (item?.chat === undefined) return undefined;
  const [row] = yield* sql<{ handle: string | null }>`SELECT p.handle FROM kin_chats c
    LEFT JOIN kin_people p ON p.org_id = c.org_id
      AND p.person_id = substr(c.direct_key, 1, instr(c.direct_key, ':') - 1)
    WHERE c.org_id = ${orgId}
    AND c.chat_id = ${item.chat} AND c.kind = 'direct' AND c.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM kin_leads l WHERE l.org_id = c.org_id
      AND l.owner_chat_id = c.chat_id) ORDER BY c.chat_id`;
  return row === undefined
    ? undefined
    : { chatId: KinChatId.make(item.chat), theirs: row.handle === item.said_by };
});

/**
 * A shared chat's own reminder or routine: set in a chat that is not a direct one, and not the
 * owner's private work in a chat shared since (`firingOrigin`). It fires back into that chat as
 * the agent that set it. `open` is false once the chat is archived or gone, or that agent left it.
 */
export const sharedChatOf = Effect.fn("Deferrals.sharedChatOf")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: DeferralSource | undefined,
) {
  if (item?.chat === undefined || item.source_event === undefined) return undefined;
  const [row] = yield* sql<{
    agentId: string;
    audience: string | null;
    kind: string | null;
    title: string | null;
    shared: number | null;
    open: number;
    leadName: string | null;
    ownerChatId: string | null;
  }>`SELECT e.agent_id AS "agentId", w.audience, c.kind, c.title,
      c.shared_at IS NOT NULL AS shared,
      (c.archived_at IS NULL AND EXISTS (SELECT 1 FROM kin_chat_members m
        WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'agent'
          AND m.agent_id = e.agent_id AND m.left_at IS NULL)) AS open,
      l.name AS "leadName", l.owner_chat_id AS "ownerChatId"
    FROM kin_events e
    LEFT JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
    LEFT JOIN kin_chats c ON c.org_id = e.org_id AND c.chat_id = ${item.chat}
    LEFT JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE e.org_id = ${orgId} AND e.event_id = ${item.source_event}
      AND json_extract(e.json, '$.chatId') = ${item.chat}
    ORDER BY e.event_id`;
  if (row === undefined || row.kind === "direct") return undefined;
  // A chat that is gone counts only when a turn others read set it there.
  if (
    row.kind === null
      ? row.audience !== "shared"
      : row.shared === 1 && row.audience === "owner_only"
  )
    return undefined;
  return {
    chatId: KinChatId.make(item.chat),
    agentId: KinAgentId.make(row.agentId),
    name: row.title ?? "a group chat",
    open: row.kind !== null && row.open === 1 && row.leadName !== null,
    lead:
      row.leadName === null || row.ownerChatId === null
        ? undefined
        : { name: row.leadName, ownerChatId: KinChatId.make(row.ownerChatId) },
  };
});

/** Who asked, for a shared chat's card: by person id or handle, and whether they left. */
export const askerOf = Effect.fn("Deferrals.askerOf")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  saidBy: string,
) {
  const [row] = yield* sql<{ personId: string; name: string; removed: number }>`
    SELECT person_id AS "personId", display_name AS name, removed_at IS NOT NULL AS removed
    FROM kin_people WHERE org_id = ${orgId} AND (person_id = ${saidBy} OR handle = ${saidBy})
    ORDER BY person_id LIMIT 1`;
  return row === undefined
    ? undefined
    : {
        personId: KinPersonId.make(row.personId),
        name: row.name,
        ...(row.removed === 1 ? { left: true as const } : {}),
      };
});

/**
 * Someone's own direct chat with `agentId` (the lead's owner chat for its owner), where what they
 * asked to come to them alone goes; undefined when they have none open.
 */
export const directChatWith = Effect.fn("Deferrals.directChatWith")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  personId: string,
  agentId: string,
) {
  const [row] = yield* sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
    JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
    WHERE c.org_id = ${orgId} AND c.kind = 'direct' AND c.archived_at IS NULL
      AND c.direct_key = ${directKey(KinPersonId.make(personId), KinAgentId.make(agentId))}
    ORDER BY c.chat_id LIMIT 1`;
  return row === undefined ? undefined : KinChatId.make(row.chatId);
});
