import {
  KIN_GROUP_MAX_MEMBERS,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinChatsCreateGroupInput,
  KinGroupRenameInput,
  KinMemberId,
  type KinChat,
  type KinChatMember,
  type KinChatMembersInput,
  type KinChatMembersResult,
  type KinGroupAddMemberInput,
  type KinGroupDeleteInput,
  type KinGroupRemoveMemberInput,
  type KinGroupSetLeadInput,
  type KinOrgId,
  type KinPrincipal,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinPresence, syncQueued } from "../reply/KinPresence.ts";
import * as Hub from "./KinChatHub.ts";
import * as Repository from "./KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "./KinIdentity.ts";

type Viewers = ReadonlyArray<PersonIdentity>;
type GroupError = Repository.RepositoryError;

/**
 * Groups: a chat of the owner with any mix of their leads and people. Only the organization's
 * owner makes one or changes who is in it, who leads it and what it is called; everyone in it
 * may read who is there. The RPC handlers, and any later caller, go through these methods.
 */
export class KinGroups extends Context.Service<
  KinGroups,
  {
    readonly create: (
      caller: Viewers,
      input: KinChatsCreateGroupInput,
    ) => Effect.Effect<KinChat, GroupError>;
    /** The chat and everyone who is or was in it, by name. Any current member may ask. */
    readonly members: (
      caller: Viewers,
      input: KinChatMembersInput,
    ) => Effect.Effect<KinChatMembersResult, GroupError>;
    readonly addMember: (
      caller: Viewers,
      input: KinGroupAddMemberInput,
    ) => Effect.Effect<KinChatMember, GroupError>;
    readonly removeMember: (
      caller: Viewers,
      input: KinGroupRemoveMemberInput,
    ) => Effect.Effect<void, GroupError>;
    readonly setLead: (
      caller: Viewers,
      input: KinGroupSetLeadInput,
    ) => Effect.Effect<KinChat, GroupError>;
    readonly rename: (
      caller: Viewers,
      input: KinGroupRenameInput,
    ) => Effect.Effect<KinChat, GroupError>;
    /** Ends the group for everyone: nobody reads or posts in it afterwards. */
    readonly remove: (
      caller: Viewers,
      input: KinGroupDeleteInput,
    ) => Effect.Effect<void, GroupError>;
  }
>()("t3/kin/chat/KinGroups") {}

const decodeCreate = Schema.decodeEffect(KinChatsCreateGroupInput);
const decodeRename = Schema.decodeEffect(KinGroupRenameInput);
const decodeChatId = Schema.decodeEffect(KinChatId);
const decodeMemberId = Schema.decodeEffect(KinMemberId);
const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const ownerOnly = new KinChatError({
  reason: "not_allowed",
  message: "Only the owner can change a group.",
});
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const CHAT_EVENT_TAGS = ["chat.message", "widget.action", "chat.reaction"] as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const { owner } = yield* KinIdentity;
  const presence = yield* Effect.serviceOption(KinPresence);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause)
            ? toPersistenceSqlError("KinGroups.transaction")(cause)
            : cause,
        ),
      );
  const query =
    (operation: string) =>
    <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
      effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));

  const isOwner = (person: PersonIdentity) =>
    person.orgId === owner.orgId && person.personId === owner.personId;

  /** The caller's own membership of a chat they are in; a chat they are not in does not exist. */
  const memberOf = Effect.fn("KinGroups.memberOf")(function* (caller: Viewers, chatId: KinChatId) {
    for (const person of caller) {
      const chat = yield* repo.getChat({ orgId: person.orgId, chatId });
      if (Option.isNone(chat) || chat.value.archivedAt !== null) continue;
      const member = yield* repo.activeMember({
        orgId: person.orgId,
        chatId,
        principal: { _tag: "person", personId: person.personId },
      });
      if (Option.isSome(member)) return { person, chat: chat.value, member: member.value };
    }
    return yield* notFound;
  });

  /** A group the caller owns, as the organization's owner. Read from stored rows only. */
  const ownedGroup = Effect.fn("KinGroups.ownedGroup")(function* (
    caller: Viewers,
    chatId: KinChatId,
  ) {
    const found = yield* memberOf(caller, chatId);
    if (!isOwner(found.person) || found.member.role !== "owner") return yield* ownerOnly;
    if (found.chat.kind === "direct")
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "A direct chat stays between the two of you. Make a group instead.",
      });
    return found;
  });

  /** A live lead the owner made or was given: the only agents a group takes. */
  const ownersLead = Effect.fn("KinGroups.ownersLead")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const rows = yield* query("KinGroups.ownersLead")(sql<{ agentId: string }>`
      SELECT l.agent_id AS "agentId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId} AND a.role = 'lead'
        AND a.retired_at IS NULL AND a.owner_person_id = ${owner.personId}
      ORDER BY l.agent_id`);
    if (rows.length === 0) return yield* notFound;
  });

  const join = Effect.fn("KinGroups.join")(function* (
    chat: KinChat,
    principal: KinPrincipal,
    role: KinChatMember["role"],
    joinedAt: KinChatMember["joinedAt"],
  ) {
    return yield* repo.addMember({
      orgId: chat.orgId,
      chatId: chat.chatId,
      memberId: yield* decodeMemberId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
      principal,
      role,
      joinedAt,
      leftAt: null,
      mutedUntil: null,
    });
  });

  /** A lead no longer hears a chat it left: what was queued for it there never runs. */
  const dropQueued = Effect.fn("KinGroups.dropQueued")(function* (
    chat: Pick<KinChat, "orgId" | "chatId">,
    agentId?: KinAgentId,
  ) {
    const dropped = yield* query("KinGroups.dropQueued")(sql<{ agentId: string }>`
      UPDATE kin_events SET state = 'expired'
      WHERE org_id = ${chat.orgId} AND state = 'queued' AND tag IN ${sql.in(CHAT_EVENT_TAGS)}
        AND json_extract(json, '$.chatId') = ${chat.chatId}
        AND (${agentId ?? null} IS NULL OR agent_id = ${agentId ?? null})
      RETURNING agent_id AS "agentId"`);
    if (Option.isNone(presence)) return;
    const line = presence.value;
    yield* sql.afterCommit(
      Effect.forEach(
        new Set(dropped.map((row) => row.agentId)),
        (id) =>
          syncQueued(line, chat.orgId, KinAgentId.make(id)).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        { discard: true },
      ),
    );
  });

  /** Tells everyone still in the chat that who is in it, its name or its lead changed. */
  const changed = (member: KinChatMember) =>
    hub.publish({ type: "member.updated", orgId: member.orgId, chatId: member.chatId, member });

  return KinGroups.of({
    create: Effect.fn("KinGroups.create")(function* (caller, raw) {
      const input = yield* decodeCreate(raw).pipe(
        Effect.mapError(() => invalid("A group needs a name.")),
      );
      const person = caller.find((entry) => entry.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      if (!isOwner(person))
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner can make a group.",
        });
      const agentIds = [...new Set(input.agentIds)];
      const personIds = [...new Set(input.personIds)].filter((id) => id !== person.personId);
      if (agentIds.length + personIds.length === 0)
        return yield* invalid("Add at least one lead or person.");
      if (agentIds.length + personIds.length >= KIN_GROUP_MAX_MEMBERS)
        return yield* invalid(`A group holds up to ${KIN_GROUP_MAX_MEMBERS}.`);
      for (const agentId of agentIds) yield* ownersLead(input.orgId, agentId);
      for (const personId of personIds)
        if (Option.isNone(yield* repo.getPerson({ orgId: input.orgId, personId })))
          return yield* notFound;
      const createdAt = yield* now;
      const chat = yield* repo.createChat({
        orgId: input.orgId,
        chatId: yield* decodeChatId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
        kind: "team_group",
        directKey: null,
        title: input.title,
        teamId: null,
        lastMessageAt: null,
        createdAt,
        archivedAt: null,
        leadAgentId: agentIds[0] ?? null,
      });
      yield* join(chat, { _tag: "person", personId: person.personId }, "owner", createdAt);
      for (const agentId of agentIds)
        yield* join(chat, { _tag: "agent", agentId }, "member", createdAt);
      for (const personId of personIds)
        yield* join(chat, { _tag: "person", personId }, "member", createdAt);
      yield* hub.publish({ type: "chat.created", orgId: chat.orgId, chat });
      return chat;
    }, transaction),

    members: Effect.fn("KinGroups.members")(function* (caller, input) {
      const { chat } = yield* memberOf(caller, input.chatId);
      const members = yield* repo.listMembers(chat);
      const people = new Map(
        (yield* repo.listPeople(chat)).map((row) => [row.personId as string, row.displayName]),
      );
      const agents = new Map(
        (yield* repo.listAgents(chat)).map((row) => [row.agentId as string, row.displayName]),
      );
      // The owner, then the leads, then the people; within each, who joined first, then by name.
      const rank = (member: KinChatMember) =>
        member.role === "owner" ? 0 : member.principal._tag === "agent" ? 1 : 2;
      return {
        chat,
        members: members
          .flatMap((member) => {
            const displayName =
              member.principal._tag === "person"
                ? people.get(member.principal.personId)
                : agents.get(member.principal.agentId);
            return displayName === undefined ? [] : [{ ...member, displayName }];
          })
          .toSorted(
            (a, b) =>
              rank(a) - rank(b) ||
              a.joinedAt.localeCompare(b.joinedAt) ||
              a.displayName.localeCompare(b.displayName),
          ),
      };
    }),

    addMember: Effect.fn("KinGroups.addMember")(function* (caller, input) {
      const { chat } = yield* ownedGroup(caller, input.chatId);
      const { principal } = input;
      if (principal._tag === "agent") yield* ownersLead(chat.orgId, principal.agentId);
      else if (Option.isNone(yield* repo.getPerson({ orgId: chat.orgId, ...principal })))
        return yield* notFound;
      const rows = yield* repo.listMembers(chat);
      const earlier = rows.find((row) =>
        row.principal._tag === "person"
          ? principal._tag === "person" && row.principal.personId === principal.personId
          : principal._tag === "agent" && row.principal.agentId === principal.agentId,
      );
      if (earlier !== undefined && earlier.leftAt === null) return earlier;
      if (rows.filter((row) => row.leftAt === null).length >= KIN_GROUP_MAX_MEMBERS)
        return yield* invalid(`A group holds up to ${KIN_GROUP_MAX_MEMBERS}.`);
      const joinedAt = yield* now;
      const member =
        earlier === undefined
          ? yield* join(chat, principal, "member", joinedAt)
          : // Someone who was here before keeps their member id, so their old messages stay theirs.
            yield* repo.addMember({ ...earlier, role: "member", joinedAt, leftAt: null });
      if (principal._tag === "agent" && (chat.leadAgentId ?? null) === null)
        yield* repo.updateChat({
          orgId: chat.orgId,
          chatId: chat.chatId,
          leadAgentId: principal.agentId,
        });
      yield* changed(member);
      return member;
    }, transaction),

    removeMember: Effect.fn("KinGroups.removeMember")(function* (caller, input) {
      const { chat, member: ownerMember } = yield* ownedGroup(caller, input.chatId);
      const member = yield* repo.getMember({ orgId: chat.orgId, memberId: input.memberId });
      if (Option.isNone(member) || member.value.chatId !== chat.chatId) return yield* notFound;
      if (member.value.role === "owner")
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "The owner can't be removed. Delete the group instead.",
        });
      if (member.value.leftAt !== null) return;
      const { principal } = member.value;
      for (const item of yield* repo.leaveChat({ ...member.value, leftAt: yield* now }))
        yield* hub.publish({ type: "waiting.updated", orgId: chat.orgId, item });
      if (principal._tag === "agent") {
        yield* dropQueued(chat, principal.agentId);
        if (chat.leadAgentId === principal.agentId) {
          // The group still needs someone to answer: the lead who has been in it longest.
          const [next] = yield* query("KinGroups.nextLead")(sql<{ agentId: string }>`
            SELECT m.agent_id AS "agentId" FROM kin_chat_members m
            JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.agent_id
            JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
            WHERE m.org_id = ${chat.orgId} AND m.chat_id = ${chat.chatId}
              AND m.principal_kind = 'agent' AND m.left_at IS NULL AND a.retired_at IS NULL
            ORDER BY m.joined_at, m.rowid LIMIT 1`);
          yield* repo.updateChat({
            orgId: chat.orgId,
            chatId: chat.chatId,
            leadAgentId: next === undefined ? null : KinAgentId.make(next.agentId),
          });
        }
      }
      const removed = yield* repo.getMember(member.value);
      if (Option.isNone(removed)) return yield* notFound;
      yield* hub.publish({ type: "member.removed", orgId: chat.orgId, member: removed.value });
      // Those who stay hear it as a change by an active member: a departed one reads as their own exit.
      yield* changed(ownerMember);
    }, transaction),

    setLead: Effect.fn("KinGroups.setLead")(function* (caller, input) {
      const { chat, member } = yield* ownedGroup(caller, input.chatId);
      yield* ownersLead(chat.orgId, input.agentId);
      const lead = yield* repo.activeMember({
        ...chat,
        principal: { _tag: "agent", agentId: input.agentId },
      });
      if (Option.isNone(lead)) return yield* invalid("That lead isn't in this group.");
      if (chat.leadAgentId === input.agentId) return chat;
      const updated = yield* repo.updateChat({
        orgId: chat.orgId,
        chatId: chat.chatId,
        leadAgentId: input.agentId,
      });
      yield* changed(member);
      return updated;
    }, transaction),

    rename: Effect.fn("KinGroups.rename")(function* (caller, raw) {
      const input = yield* decodeRename(raw).pipe(
        Effect.mapError(() => invalid("A group needs a name.")),
      );
      const { chat, member } = yield* ownedGroup(caller, input.chatId);
      if (chat.title === input.title) return chat;
      const updated = yield* repo.updateChat({
        orgId: chat.orgId,
        chatId: chat.chatId,
        title: input.title,
      });
      yield* changed(member);
      return updated;
    }, transaction),

    remove: Effect.fn("KinGroups.remove")(function* (caller, input) {
      const { chat } = yield* ownedGroup(caller, input.chatId);
      const at = yield* now;
      yield* repo.updateChat({ orgId: chat.orgId, chatId: chat.chatId, archivedAt: at });
      yield* dropQueued(chat);
      for (const member of yield* repo.listMembers(chat)) {
        if (member.leftAt !== null) continue;
        for (const item of yield* repo.leaveChat({ ...member, leftAt: at }))
          yield* hub.publish({ type: "waiting.updated", orgId: chat.orgId, item });
        yield* hub.publish({
          type: "member.removed",
          orgId: chat.orgId,
          member: { ...member, leftAt: at },
        });
      }
    }, transaction),
  });
});

export const layer = Layer.effect(KinGroups, make);
