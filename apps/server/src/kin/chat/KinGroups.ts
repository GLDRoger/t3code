import {
  KIN_COMPANY_CHAT_TEAM_ID,
  KIN_TEAM_ROOM_TEAM_ID,
  KIN_GROUP_MAX_MEMBERS,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinChatsCreateGroupInput,
  KinGroupRenameInput,
  kinIsPeopleChat,
  kinPeopleChatTeamId,
  KinMemberId,
  KinWakeupId,
  type KinChat,
  type KinChatMember,
  type KinChatMembersInput,
  type KinChatMembersResult,
  type KinChatWorkingResult,
  type KinChatsWithPersonInput,
  type KinGroupAddMemberInput,
  type KinGroupDeleteInput,
  type KinGroupRemoveMemberInput,
  type KinGroupSetCompanyInput,
  type KinGroupSetCompanyResult,
  type KinGroupSetLeadInput,
  type KinOrgId,
  type KinPersonId,
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
import { freezeMovedCard, onPersonJoined, settleCards, tellStopped } from "../lead/ChatSharing.ts";
import { KinStop } from "../lead/KinStop.ts";
import * as Reach from "../lead/Reach.ts";
import { ownerLevel } from "../people/KinAccess.ts";
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
    /**
     * The caller's chat with one teammate, made the first time: anyone may start one with anyone
     * still on the team. Only the two of them are in it, and nobody else reads it.
     */
    readonly withPerson: (
      caller: Viewers,
      input: KinChatsWithPersonInput,
    ) => Effect.Effect<KinChat, GroupError>;
    /** The chat and everyone who is or was in it, by name. Any current member may ask. */
    readonly members: (
      caller: Viewers,
      input: KinChatMembersInput,
    ) => Effect.Effect<KinChatMembersResult, GroupError>;
    /** What the chat's messages were handed to other agents for, while queued or running. */
    readonly working: (
      caller: Viewers,
      input: KinChatMembersInput,
    ) => Effect.Effect<KinChatWorkingResult, GroupError>;
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
    /**
     * The company chat: on, one group with everyone on the team and the owner's agents, the picked
     * one answering; off, its agents leave and its history stays readable. On again reopens it.
     */
    readonly setCompany: (
      caller: Viewers,
      input: KinGroupSetCompanyInput,
    ) => Effect.Effect<KinGroupSetCompanyResult, GroupError>;
    /** Someone let onto the team joins the company chat while it is on. Run in their accept. */
    readonly joinCompany: (
      orgId: KinOrgId,
      personId: KinPersonId,
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
  message: "Only the person who made a group can change it.",
});
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const CHAT_EVENT_TAGS = ["chat.message", "widget.action", "chat.reaction"] as const;
const COMPANY_OFF = `${KIN_COMPANY_CHAT_TEAM_ID}:off`;
const COMPANY_TITLE = "Company chat";

const openingWords = (body: string) => {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
};

/** The company chat while it is on, and who answers there by default. */
export const companyChatOf = Effect.fn("KinGroups.companyChatOf")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ chatId: KinChatId; leadAgentId: KinAgentId | null }>`
    SELECT chat_id AS "chatId", lead_agent_id AS "leadAgentId" FROM kin_chats
    WHERE org_id = ${orgId} AND kind = 'team_group' AND archived_at IS NULL
      AND team_id = ${KIN_COMPANY_CHAT_TEAM_ID}
    ORDER BY created_at DESC LIMIT 1`.pipe(
    Effect.mapError(toPersistenceSqlError("KinGroups.companyChatOf")),
  );
  return row ?? null;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const identity = yield* KinIdentity;
  const { owner } = identity;
  const presence = yield* Effect.serviceOption(KinPresence);
  const stop = yield* Effect.serviceOption(KinStop);
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

  /** The owner or a co-owner: who makes and runs groups. */
  const isOwner = (person: PersonIdentity) =>
    person.orgId === owner.orgId
      ? ownerLevel(person.orgId, person.personId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinGroups.isOwner")),
        )
      : Effect.succeed(false);

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
    if (!(yield* isOwner(found.person)) || found.member.role !== "owner") return yield* ownerOnly;
    if (found.chat.kind === "direct" || kinIsPeopleChat(found.chat))
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

  /**
   * In the join's transaction (`onPersonJoined`): no turn that may hold the owner's context, or
   * read the chat before it was shared, continues once someone else can read it. What was asked
   * there before stays the owner's: unanswered, it expires and the chat hears once who didn't.
   */
  const shareWith = Effect.fn("KinGroups.shareWith")(function* (
    chat: Pick<KinChat, "orgId" | "chatId">,
    personId: string,
  ) {
    const shared = yield* query("KinGroups.shareWith")(
      onPersonJoined({ orgId: chat.orgId, chatId: chat.chatId, personId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
    );
    const withChat = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        SqlClient.SqlClient | Repository.KinChatRepository | Hub.KinChatHub
      >,
    ) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(Repository.KinChatRepository, repo),
        Effect.provideService(Hub.KinChatHub, hub),
      );
    yield* withChat(settleCards(chat)).pipe(
      Effect.catchTags({
        SqlError: (cause) => Effect.fail(toPersistenceSqlError("KinGroups.settleCards")(cause)),
      }),
    );
    for (const task of shared.moved)
      yield* withChat(
        freezeMovedCard({
          orgId: chat.orgId,
          chatId: chat.chatId,
          threadId: task.threadId,
          leadName: task.leadName,
        }),
      ).pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(toPersistenceSqlError("KinGroups.freezeCard")(cause)),
        }),
      );
    if (shared.expired.length > 0 && Option.isSome(presence)) {
      const line = presence.value;
      yield* sql.afterCommit(
        Effect.forEach(
          new Set(shared.expired.map((row) => row.agentId)),
          (id) =>
            syncQueued(line, chat.orgId, KinAgentId.make(id)).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
          { discard: true },
        ),
      );
    }
    if (shared.stopped.length > 0)
      yield* sql.afterCommit(
        withChat(tellStopped({ ...chat, lines: shared.stopped })).pipe(
          Effect.ignore({ log: "Warn", message: "KinGroups.tellStopped" }),
        ),
      );
    if (shared.threads.length > 0)
      yield* sql.afterCommit(
        Effect.forEach(
          shared.threads,
          (threadId) =>
            identity.endAgentThread({ orgId: chat.orgId, threadId }).pipe(Effect.ignore),
          { discard: true },
        ),
      );
    if (shared.turns.length === 0 || Option.isNone(stop)) return;
    yield* sql.afterCommit(
      stop.value.abortTurns(
        chat.orgId,
        shared.turns.map((turn) => KinWakeupId.make(turn.wakeupId)),
      ),
    );
  });

  /** Tells everyone still in the chat that who is in it, its name or its lead changed. */
  const changed = (member: KinChatMember) =>
    hub.publish({ type: "member.updated", orgId: member.orgId, chatId: member.chatId, member });

  /** Puts a lead or person in a group, or back in it; one already there stays as they are. */
  const admit = Effect.fn("KinGroups.admit")(function* (chat: KinChat, principal: KinPrincipal) {
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
    if (principal._tag === "person") yield* shareWith(chat, principal.personId);
    if (principal._tag === "agent" && (chat.leadAgentId ?? null) === null)
      yield* repo.updateChat({
        orgId: chat.orgId,
        chatId: chat.chatId,
        leadAgentId: principal.agentId,
      });
    yield* changed(member);
    return member;
  });

  /** Takes a member out of a group; a lead leaving hands the group to the lead in it longest. */
  const dismiss = Effect.fn("KinGroups.dismiss")(function* (chat: KinChat, member: KinChatMember) {
    const { principal } = member;
    for (const item of yield* repo.leaveChat({ ...member, leftAt: yield* now }))
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
    const removed = yield* repo.getMember(member);
    if (Option.isNone(removed)) return yield* notFound;
    yield* hub.publish({ type: "member.removed", orgId: chat.orgId, member: removed.value });
  });

  /** The org's company chat, on or off, newest first; none until the owner first turns it on. */
  const companyChat = Effect.fn("KinGroups.companyChat")(function* (orgId: KinOrgId) {
    const [row] = yield* query("KinGroups.companyChat")(sql<{ chatId: string }>`
      SELECT chat_id AS "chatId" FROM kin_chats
      WHERE org_id = ${orgId} AND kind = 'team_group' AND archived_at IS NULL
        AND team_id IN (${KIN_COMPANY_CHAT_TEAM_ID}, ${COMPANY_OFF})
      ORDER BY team_id = ${KIN_COMPANY_CHAT_TEAM_ID} DESC, created_at DESC LIMIT 1`);
    if (row === undefined) return undefined;
    const chat = yield* repo.getChat({ orgId, chatId: KinChatId.make(row.chatId) });
    return Option.getOrUndefined(chat);
  });

  const markCompany = (chat: KinChat, teamId: string) =>
    query("KinGroups.markCompany")(sql`UPDATE kin_chats SET team_id = ${teamId}
      WHERE org_id = ${chat.orgId} AND chat_id = ${chat.chatId}`);

  return KinGroups.of({
    create: Effect.fn("KinGroups.create")(function* (caller, raw) {
      const input = yield* decodeCreate(raw).pipe(
        Effect.mapError(() => invalid("A group needs a name.")),
      );
      const person = caller.find((entry) => entry.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      if (!(yield* isOwner(person)))
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner or a co-owner can make a group.",
        });
      const agentIds = [...new Set(input.agentIds)];
      const personIds = [...new Set(input.personIds)].filter((id) => id !== person.personId);
      if (agentIds.length + personIds.length === 0)
        return yield* invalid("Add at least one agent or person.");
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

    withPerson: Effect.fn("KinGroups.withPerson")(function* (caller, input) {
      const person = caller.find((entry) => entry.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      if (input.personId === person.personId)
        return yield* invalid("Pick a teammate other than yourself.");
      const [other] = yield* query("KinGroups.withPerson")(sql<{ name: string }>`
        SELECT display_name AS name FROM kin_people
        WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND removed_at IS NULL`);
      if (other === undefined) return yield* notFound;
      const reach = yield* query("KinGroups.withPerson")(
        Reach.mayReach(
          input.orgId,
          Reach.person(person.personId),
          Reach.person(input.personId),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      if (reach === "restricted")
        return yield* new KinChatError({
          reason: "not_allowed",
          message: `You and ${other.name} can't message each other here.`,
        });
      if (reach !== "allowed") return yield* notFound;
      const teamId = kinPeopleChatTeamId(person.personId, input.personId);
      const [held] = yield* query("KinGroups.withPerson")(sql<{ chatId: string }>`
        SELECT chat_id AS "chatId" FROM kin_chats
        WHERE org_id = ${input.orgId} AND kind = 'team_group' AND team_id = ${teamId}
          AND archived_at IS NULL
        ORDER BY created_at LIMIT 1`);
      const pair = [person.personId, input.personId] as const;
      if (held !== undefined) {
        const chat = yield* repo.getChat({
          orgId: input.orgId,
          chatId: KinChatId.make(held.chatId),
        });
        if (Option.isNone(chat)) return yield* notFound;
        // Either of them taken off the team and let back on is in it again, with their history.
        const rows = yield* repo.listMembers(chat.value);
        for (const personId of pair) {
          const row = rows.find(
            (member) =>
              member.principal._tag === "person" && member.principal.personId === personId,
          );
          if (row !== undefined && row.leftAt === null) continue;
          const joinedAt = yield* now;
          const member =
            row === undefined
              ? yield* join(chat.value, { _tag: "person", personId }, "member", joinedAt)
              : yield* repo.addMember({ ...row, joinedAt, leftAt: null });
          yield* changed(member);
        }
        return chat.value;
      }
      const createdAt = yield* now;
      const chat = yield* repo.createChat({
        orgId: input.orgId,
        chatId: yield* decodeChatId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
        kind: "team_group",
        directKey: null,
        title: null,
        teamId,
        lastMessageAt: null,
        createdAt,
        archivedAt: null,
        leadAgentId: null,
      });
      // Neither holds the chat's owner role: nobody may add a third person or rename it.
      for (const personId of pair)
        yield* join(chat, { _tag: "person", personId }, "member", createdAt);
      yield* hub.publish({ type: "chat.created", orgId: chat.orgId, chat });
      return chat;
    }, transaction),

    setCompany: Effect.fn("KinGroups.setCompany")(function* (caller, input) {
      const person = caller.find((entry) => entry.orgId === input.orgId);
      if (person === undefined) return yield* notFound;
      if (!(yield* isOwner(person))) return yield* ownerOnly;
      const found = yield* companyChat(input.orgId);
      if (input.leadAgentId === null) {
        if (found === undefined) return { chat: null };
        yield* markCompany(found, COMPANY_OFF);
        // Nobody answers there any more; the people stay, so its history stays readable.
        for (const member of yield* repo.listMembers(found))
          if (member.principal._tag === "agent" && member.leftAt === null)
            yield* dismiss(found, member);
        const off = yield* repo.updateChat({
          orgId: found.orgId,
          chatId: found.chatId,
          leadAgentId: null,
        });
        const owners = yield* repo.activeMember({
          ...found,
          principal: { _tag: "person", personId: person.personId },
        });
        if (Option.isSome(owners)) yield* changed(owners.value);
        return { chat: off };
      }
      const leadAgentId = input.leadAgentId;
      yield* ownersLead(input.orgId, leadAgentId);
      const agents = yield* query("KinGroups.companyAgents")(sql<{ agentId: KinAgentId }>`
        SELECT l.agent_id AS "agentId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${input.orgId} AND a.role = 'lead' AND a.retired_at IS NULL
          AND a.owner_person_id = ${owner.personId}
        ORDER BY a.created_at, l.agent_id`);
      const people = yield* query("KinGroups.companyPeople")(sql<{ personId: KinPersonId }>`
        SELECT DISTINCT b.person_id AS "personId" FROM kin_session_bindings b
        WHERE b.org_id = ${input.orgId} AND b.revoked_at IS NULL
          AND b.person_id <> ${person.personId}
        ORDER BY b.person_id`);
      const createdAt = yield* now;
      const chat =
        found ??
        (yield* repo.createChat({
          orgId: input.orgId,
          chatId: yield* decodeChatId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          kind: "team_group",
          directKey: null,
          title: COMPANY_TITLE,
          teamId: KIN_COMPANY_CHAT_TEAM_ID,
          lastMessageAt: null,
          createdAt,
          archivedAt: null,
          leadAgentId,
        }));
      if (found === undefined)
        yield* join(chat, { _tag: "person", personId: person.personId }, "owner", createdAt);
      const reopened = found !== undefined && found.teamId !== KIN_COMPANY_CHAT_TEAM_ID;
      if (found === undefined || reopened) {
        yield* markCompany(chat, KIN_COMPANY_CHAT_TEAM_ID);
        // Every agent the owner has, so a question finds its agent in the room; he removes any.
        for (const { agentId } of agents) yield* admit(chat, { _tag: "agent", agentId });
      } else yield* admit(chat, { _tag: "agent", agentId: leadAgentId });
      for (const { personId } of people) yield* admit(chat, { _tag: "person", personId });
      const updated = yield* repo.updateChat({
        orgId: chat.orgId,
        chatId: chat.chatId,
        leadAgentId,
      });
      if (found === undefined)
        yield* hub.publish({ type: "chat.created", orgId: chat.orgId, chat: updated });
      else {
        const owners = yield* repo.activeMember({
          ...chat,
          principal: { _tag: "person", personId: person.personId },
        });
        if (Option.isSome(owners)) yield* changed(owners.value);
      }
      return { chat: updated };
    }, transaction),

    joinCompany: Effect.fn("KinGroups.joinCompany")(function* (orgId, personId) {
      const chat = yield* companyChat(orgId);
      if (chat === undefined || chat.teamId !== KIN_COMPANY_CHAT_TEAM_ID) return;
      yield* admit(chat, { _tag: "person", personId });
    }, transaction),

    working: Effect.fn("KinGroups.working")(function* (caller, input) {
      const { person, chat } = yield* memberOf(caller, input.chatId);
      const rows = yield* query("KinGroups.working")(sql<{
        agentId: string;
        toChatId: string | null;
        wakeupId: string | null;
        since: number;
        body: string;
        inTarget: number;
      }>`SELECT h.to_agent_id AS "agentId", h.to_chat_id AS "toChatId",
          w.wakeup_id AS "wakeupId", COALESCE(w.started_at, e.queued_at) AS "since",
          m.body AS "body",
          EXISTS (SELECT 1 FROM kin_chat_members cm WHERE cm.org_id = h.org_id
            AND cm.chat_id = h.to_chat_id AND cm.principal_kind = 'person'
            AND cm.person_id = ${person.personId} AND cm.left_at IS NULL) AS "inTarget"
        FROM kin_handoffs h
        JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
        JOIN kin_events e ON e.org_id = h.org_id AND e.event_id = h.event_id
        LEFT JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
          AND w.status = 'running'
        WHERE h.org_id = ${chat.orgId} AND m.chat_id = ${chat.chatId}
          AND m.author_kind = 'human' AND m.status = 'posted'
          AND (h.to_chat_id IS NULL OR h.to_chat_id <> m.chat_id)
          AND (e.state = 'queued' OR (e.state = 'claimed' AND w.wakeup_id IS NOT NULL))
        ORDER BY "since", h.message_id`);
      return {
        handoffs: rows.map((row) => ({
          agentId: KinAgentId.make(row.agentId),
          chatId: row.toChatId !== null && row.inTarget === 1 ? KinChatId.make(row.toChatId) : null,
          wakeupId: row.wakeupId === null ? null : KinWakeupId.make(row.wakeupId),
          state: row.wakeupId === null ? ("queued" as const) : ("running" as const),
          asked: openingWords(row.body),
          since: DateTime.formatIso(DateTime.makeUnsafe(row.since)),
        })),
      };
    }),

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
      // Kin keeps the Team room's members itself: the agents, the owner and co-owners.
      if (chat.teamId === KIN_TEAM_ROOM_TEAM_ID)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "The Team room is your agents' room; only you and co-owners read it.",
        });
      return yield* admit(chat, input.principal);
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
      yield* dismiss(chat, member.value);
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
      if (Option.isNone(lead)) return yield* invalid("That agent isn't in this group.");
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
