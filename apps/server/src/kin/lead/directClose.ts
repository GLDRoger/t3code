import {
  type KinAgentId,
  type KinChatId,
  KinMessageId,
  type KinOrgId,
  type KinPersonId,
  kinPeopleChatTeamId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { KinChatHub } from "../chat/KinChatHub.ts";
import type { KinChatRepository } from "../chat/KinChatRepository.ts";
import { type KinPresence, syncQueued } from "../reply/KinPresence.ts";
import { tellStaleRoutes } from "./KinEventQueue.ts";
import * as LeadAccess from "./LeadAccess.ts";

export type DirectCloseDeps = {
  readonly repo: KinChatRepository["Service"];
  readonly hub: KinChatHub["Service"];
  readonly presence: Option.Option<KinPresence["Service"]>;
};

/**
 * Ends a person's writing in their direct chat with a lead, inside the caller's transaction:
 * nothing they send wakes it and what was waiting is dropped; a reply under way still lands.
 * The chat stays theirs to read, and one they never wrote in leaves their list. `notice` is
 * one fixed line said there first.
 */
export const closeDirect = Effect.fn("KinLeadProvision.closeDirect")(function* (
  deps: DirectCloseDeps,
  lead: { readonly orgId: KinOrgId; readonly agentId: KinAgentId },
  personId: KinPersonId,
  notice: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const { repo, hub, presence } = deps;
  const now = yield* DateTime.now;
  const [chat] = yield* sql<{ chatId: KinChatId; lastSeq: number }>`
    SELECT chat_id AS "chatId", last_seq AS "lastSeq" FROM kin_chats
    WHERE org_id = ${lead.orgId} AND kind = 'direct'
      AND direct_key = ${LeadAccess.directKey(personId, lead.agentId)}
    ORDER BY chat_id`.pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.closeDirect")));
  if (chat === undefined) return;
  const dropped = yield* LeadAccess.dropQueued(lead, chat.chatId).pipe(
    Effect.mapError(toPersistenceSqlError("KinLeadProvision.closeDirect")),
  );
  // A routed request of theirs that will now never start: they hear so now, whoever runs next.
  yield* tellStaleRoutes(
    { repo: Option.some(repo), hub: Option.some(hub) },
    lead.orgId,
    lead.agentId,
  ).pipe(Effect.mapError(toPersistenceSqlError("KinLeadProvision.closeDirect")));
  if (dropped > 0 && Option.isSome(presence))
    yield* sql.afterCommit(
      syncQueued(presence.value, lead.orgId, lead.agentId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    );
  const member = yield* repo.activeMember({
    orgId: lead.orgId,
    chatId: chat.chatId,
    principal: { _tag: "person", personId },
  });
  if (Option.isNone(member) || member.value.role === "guest") return;
  if (chat.lastSeq === 0) {
    for (const item of yield* repo.leaveChat({
      ...member.value,
      leftAt: DateTime.formatIso(now),
    }))
      yield* hub.publish({ type: "waiting.updated", orgId: lead.orgId, item });
    const gone = yield* repo.getMember(member.value);
    if (Option.isSome(gone))
      yield* hub.publish({ type: "member.removed", orgId: lead.orgId, member: gone.value });
    return;
  }
  if (notice !== null) {
    const line = yield* repo.insertMessage({
      orgId: lead.orgId,
      chatId: chat.chatId,
      // Fixed words naming only agents, in the person's own chat.
      audience: "chat",
      // One line per chat state: the chat's sequence moves with every message.
      messageId: KinMessageId.make(`kin-team-agent:${chat.chatId}:${chat.lastSeq}`),
      author: { _tag: "system" },
      kind: "system",
      body: notice,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(now),
      editedAt: null,
    });
    yield* hub.publish({ type: "message.posted", orgId: lead.orgId, message: line });
  }
  // Guests read and never write: the chat service refuses their sends, taps and reactions.
  const guest = yield* repo.setRole({ ...member.value, role: "guest" });
  if (Option.isSome(guest))
    yield* hub.publish({
      type: "member.updated",
      orgId: lead.orgId,
      chatId: chat.chatId,
      member: guest.value,
    });
});

/**
 * Inside the transaction that makes a co-owner a member: closes each of their direct chats with
 * a live lead they don't own whose pair with them is restricted (`Reach`).
 */
export const closeUngranted = Effect.fn("KinDirectClose.closeUngranted")(function* (
  deps: DirectCloseDeps,
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const leads = yield* sql<{ agentId: KinAgentId }>`SELECT a.agent_id AS "agentId"
    FROM kin_agents a
    JOIN kin_chats c ON c.org_id = a.org_id AND c.kind = 'direct'
      AND c.direct_key = ${personId} || ':' || a.agent_id
    WHERE a.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
      AND a.owner_person_id IS NOT ${personId}
      AND EXISTS (SELECT 1 FROM kin_reach_limits r WHERE r.org_id = a.org_id
        AND r.one_kind = 'agent' AND r.one_id = a.agent_id AND r.other_kind = 'person'
        AND r.other_id = ${personId} AND r.lifted_at IS NULL)
    ORDER BY a.agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinDirectClose.closeUngranted")),
  );
  for (const { agentId } of leads) yield* closeDirect(deps, { orgId, agentId }, personId, null);
});

/**
 * Inside the caller's transaction: two people's own chat is read-only for both while their pair
 * is restricted (`Reach`), and theirs to write in again once it is lifted.
 */
export const setPeoplePair = Effect.fn("KinDirectClose.setPeoplePair")(function* (
  deps: DirectCloseDeps,
  orgId: KinOrgId,
  pair: readonly [KinPersonId, KinPersonId],
  role: "guest" | "member",
) {
  const sql = yield* SqlClient.SqlClient;
  const { repo, hub } = deps;
  const [chat] = yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId" FROM kin_chats
    WHERE org_id = ${orgId} AND kind = 'team_group'
      AND team_id = ${kinPeopleChatTeamId(pair[0], pair[1])} AND archived_at IS NULL
    ORDER BY created_at LIMIT 1`.pipe(
    Effect.mapError(toPersistenceSqlError("KinDirectClose.setPeoplePair")),
  );
  if (chat === undefined) return;
  for (const personId of pair) {
    const member = yield* repo.activeMember({
      orgId,
      chatId: chat.chatId,
      principal: { _tag: "person", personId },
    });
    if (Option.isNone(member) || member.value.role === role) continue;
    const set = yield* repo.setRole({ ...member.value, role });
    if (Option.isSome(set))
      yield* hub.publish({ type: "member.updated", orgId, chatId: chat.chatId, member: set.value });
  }
});
