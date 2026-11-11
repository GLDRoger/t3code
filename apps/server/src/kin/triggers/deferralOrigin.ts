import {
  KinAgentId,
  KinChatId,
  KinEvent,
  type KinOrgId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerOnlyChat } from "../lead/Audience.ts";
import * as KinLevels from "../lead/KinLevels.ts";

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
      : (event._tag === "deferral.due" ||
            event._tag === "chat.message" ||
            event._tag === "worker.report") &&
          event.origin !== undefined
        ? // Made while answering a due deferral, a passed-on request or reported work: where
          // that was first asked.
          event.origin
        : event._tag === "chat.message" ||
            event._tag === "widget.action" ||
            event._tag === "chat.reaction"
          ? { agentId: KinAgentId.make(row.agentId), chatId: event.chatId }
          : event._tag === "worker.report" && event.chatId !== undefined
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
        (event.provenance._tag === "human" && event.provenance.personId !== row.ownerPersonId
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
