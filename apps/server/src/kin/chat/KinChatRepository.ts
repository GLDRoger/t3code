import {
  KinOrg,
  KinOrgId,
  KinPerson,
  KinPersonId,
  KinAgent,
  KinAgentId,
  KinChat,
  KinChatId,
  KinChatMember,
  KinMemberId,
  KinMessage,
  KinMessageId,
  KinWidget,
  KinWidgetId,
  KinWaitingItem,
  KinWaitingId,
  KinChatError,
  KinChatHistoryInput,
  type KinChatHistoryResult,
  ThreadId,
  IsoDateTime,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

const KinAgentThread = Schema.Struct({
  orgId: KinOrgId,
  threadId: ThreadId,
  agentId: KinAgentId,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
type KinAgentThread = typeof KinAgentThread.Type;
const KinReadState = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  memberId: KinMemberId,
  lastReadSeq: NonNegativeInt,
  updatedAt: IsoDateTime,
});
type KinReadState = typeof KinReadState.Type;
type RepositoryError = PersistenceSqlError | PersistenceDecodeError | KinChatError;
type Scope = { readonly orgId: KinOrgId };
type ChatScope = Scope & { readonly chatId: KinChatId };
type MemberScope = ChatScope & { readonly memberId: KinMemberId };
type InsertMessage = Omit<KinMessage, "seq"> & { readonly clientMessageId: string | null };

const isKinChatError = Schema.is(KinChatError);
const isDecodeError = Schema.is(PersistenceDecodeError);
const isSqlError = Schema.is(PersistenceSqlError);
const encodeMentions = Schema.encodeEffect(Schema.fromJsonString(KinMessage.fields.mentions));
const encodeWidgetState = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.state));
const encodeAwaiting = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.awaiting));
const decodeHistory = Schema.decodeEffect(KinChatHistoryInput);
const decodeSeq = Schema.decodeEffect(NonNegativeInt);
const decodeResume = Schema.decodeEffect(
  Schema.Struct({ afterSeq: NonNegativeInt, limit: Schema.Int.check(Schema.isGreaterThan(0)) }),
);

function toRepositoryError(operation: string) {
  return (cause: unknown): RepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : isKinChatError(cause) || isDecodeError(cause) || isSqlError(cause)
        ? cause
        : new PersistenceSqlError({ operation, cause });
}
const OrgRow = KinOrg;
const orgColumns = `org_id AS "orgId", name AS "name", created_at AS "createdAt"`;
const PersonRow = KinPerson;
const personColumns = `person_id AS "personId", org_id AS "orgId", handle AS "handle", display_name AS "displayName", github_login AS "githubLogin"`;
const AgentRow = KinAgent;
const agentColumns = `agent_id AS "agentId", org_id AS "orgId", display_name AS "displayName", role AS "role", owner_person_id AS "ownerPersonId"`;
const ChatRow = KinChat;
const chatColumns = `org_id AS "orgId", chat_id AS "chatId", kind AS "kind", title AS "title", team_id AS "teamId", last_seq AS "lastSeq", last_message_at AS "lastMessageAt", created_at AS "createdAt", archived_at AS "archivedAt"`;
const MemberRow = Schema.Struct({
  ...KinChatMember.fields,
  principal: Schema.fromJsonString(KinChatMember.fields.principal),
});
const memberColumns = `org_id AS "orgId", chat_id AS "chatId", member_id AS "memberId", role AS "role", joined_at AS "joinedAt", left_at AS "leftAt", muted_until AS "mutedUntil", CASE principal_kind WHEN 'person' THEN json_object('_tag', 'person', 'personId', person_id)
 ELSE json_object('_tag', principal_kind, 'agentId', agent_id) END AS principal`;
const MessageRow = Schema.Struct({
  ...KinMessage.fields,
  author: Schema.fromJsonString(KinMessage.fields.author),
  mentions: Schema.fromJsonString(KinMessage.fields.mentions),
});
const messageColumns = `org_id AS "orgId", chat_id AS "chatId", message_id AS "messageId", seq AS "seq", author_role AS "authorRole", kind AS "kind", body AS "body", intent AS "intent", mentions_json AS "mentions", reply_to AS "replyTo", widget_id AS "widgetId", floor_run_id AS "floorRunId", status AS "status", sent_by AS "sentBy", created_at AS "createdAt", edited_at AS "editedAt", CASE author_kind WHEN 'human' THEN json_object('_tag', 'human', 'personId', author_person_id, 'memberId', author_member_id)
 WHEN 'agent' THEN json_object('_tag', 'agent', 'agentId', author_agent_id, 'memberId', author_member_id,
 'ownerPersonId', author_owner_person_id, 'threadId', author_thread_id)
 ELSE json_object('_tag', author_kind) END AS author`;
const WidgetRow = Schema.Struct({
  ...KinWidget.fields,
  state: Schema.fromJsonString(KinWidget.fields.state),
  awaiting: Schema.fromJsonString(KinWidget.fields.awaiting),
  source: Schema.fromJsonString(KinWidget.fields.source),
  feed: Schema.fromJsonString(KinWidget.fields.feed),
});
const widgetColumns = `org_id AS "orgId", chat_id AS "chatId", widget_id AS "widgetId", message_id AS "messageId", widget_class AS "widgetClass", type AS "type", revision AS "revision", state_json AS "state", awaiting_json AS "awaiting", pinned_at AS "pinnedAt", closed_at AS "closedAt", updated_at AS "updatedAt", CASE WHEN source_thread_id IS NULL AND source_item_id IS NULL THEN 'null'
 ELSE json_object('threadId', source_thread_id, 'itemId', source_item_id) END AS source,
 CASE WHEN feed_kind IS NULL AND feed_key IS NULL THEN 'null'
 ELSE json_object('kind', feed_kind, 'key', feed_key) END AS feed`;
const WaitingRow = KinWaitingItem;
const waitingColumns = `waiting_id AS "waitingId", org_id AS "orgId", person_id AS "personId", chat_id AS "chatId", message_id AS "messageId", widget_id AS "widgetId", reason AS "reason", created_at AS "createdAt", resolved_at AS "resolvedAt", resolution AS "resolution"`;
const AgentThreadRow = KinAgentThread;
const agentThreadColumns = `org_id AS "orgId", thread_id AS "threadId", agent_id AS "agentId", started_at AS "startedAt", ended_at AS "endedAt"`;
const ReadStateRow = KinReadState;
const readStateColumns = `org_id AS "orgId", chat_id AS "chatId", member_id AS "memberId", last_read_seq AS "lastReadSeq", updated_at AS "updatedAt"`;

export class KinChatRepository extends Context.Service<
  KinChatRepository,
  {
    readonly getOrg: (input: Scope) => Effect.Effect<Option.Option<KinOrg>, RepositoryError>;
    readonly getPerson: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<Option.Option<KinPerson>, RepositoryError>;
    readonly getAgent: (
      input: Scope & { readonly agentId: KinAgentId },
    ) => Effect.Effect<Option.Option<KinAgent>, RepositoryError>;
    readonly getChat: (
      input: Scope & { readonly chatId: KinChatId },
    ) => Effect.Effect<Option.Option<KinChat>, RepositoryError>;
    readonly getMember: (
      input: Scope & { readonly memberId: KinMemberId },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly getMessage: (
      input: Scope & { readonly messageId: KinMessageId },
    ) => Effect.Effect<Option.Option<KinMessage>, RepositoryError>;
    readonly getWidget: (
      input: Scope & { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<Option.Option<KinWidget>, RepositoryError>;
    readonly getWaiting: (
      input: Scope & { readonly waitingId: KinWaitingId },
    ) => Effect.Effect<Option.Option<KinWaitingItem>, RepositoryError>;
    readonly getAgentThread: (
      input: Scope & { readonly threadId: ThreadId },
    ) => Effect.Effect<Option.Option<KinAgentThread>, RepositoryError>;
    readonly listOrgs: (input: Scope) => Effect.Effect<ReadonlyArray<KinOrg>, RepositoryError>;
    readonly listPeople: (input: Scope) => Effect.Effect<ReadonlyArray<KinPerson>, RepositoryError>;
    readonly listAgents: (input: Scope) => Effect.Effect<ReadonlyArray<KinAgent>, RepositoryError>;
    readonly listChats: (input: Scope) => Effect.Effect<ReadonlyArray<KinChat>, RepositoryError>;
    readonly listMembers: (
      input: ChatScope,
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly listMembersByPerson: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly listMembersByAgent: (
      input: Scope & { readonly agentId: KinAgentId },
    ) => Effect.Effect<ReadonlyArray<KinChatMember>, RepositoryError>;
    readonly listOpenWaiting: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly insertOrg: (input: KinOrg) => Effect.Effect<void, RepositoryError>;
    readonly insertPerson: (
      input: KinPerson & { readonly createdAt: string },
    ) => Effect.Effect<void, RepositoryError>;
    readonly insertAgent: (
      input: KinAgent & { readonly createdAt: string },
    ) => Effect.Effect<void, RepositoryError>;
    readonly addMember: (input: KinChatMember) => Effect.Effect<void, RepositoryError>;
    readonly addWaiting: (input: KinWaitingItem) => Effect.Effect<void, RepositoryError>;
    readonly registerAgentThread: (input: KinAgentThread) => Effect.Effect<void, RepositoryError>;
    readonly createChat: (
      input: KinChat & { readonly directKey: string | null },
    ) => Effect.Effect<KinChat, RepositoryError>;
    readonly insertMessage: (input: InsertMessage) => Effect.Effect<KinMessage, RepositoryError>;
    readonly history: (
      input: Scope & KinChatHistoryInput,
    ) => Effect.Effect<KinChatHistoryResult, RepositoryError>;
    readonly messagesAfter: (
      input: ChatScope & { readonly afterSeq: number; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<KinMessage>, RepositoryError>;
    readonly insertWidget: (input: KinWidget) => Effect.Effect<void, RepositoryError>;
    readonly updateWidget: (
      input: KinWidget & { readonly expectedRevision: number },
    ) => Effect.Effect<KinWidget, RepositoryError>;
    readonly getReadState: (
      input: MemberScope,
    ) => Effect.Effect<Option.Option<KinReadState>, RepositoryError>;
    readonly markRead: (
      input: MemberScope & { readonly seq: number; readonly updatedAt: string },
    ) => Effect.Effect<void, RepositoryError>;
    readonly unreadCount: (input: MemberScope) => Effect.Effect<number, RepositoryError>;
    readonly resolveWaiting: (
      input: Scope & {
        readonly waitingId: KinWaitingId;
        readonly resolvedAt: string;
        readonly resolution: string;
      },
    ) => Effect.Effect<void, RepositoryError>;
    readonly endAgentThread: (
      input: Scope & { readonly threadId: ThreadId; readonly endedAt: string },
    ) => Effect.Effect<void, RepositoryError>;
  }
>()("t3/kin/chat/KinChatRepository") {}

const requireRecord = Effect.fn("KinChatRepository.requireRecord")(function* <A, E, R>(
  effect: Effect.Effect<Option.Option<A>, E, R>,
) {
  const record = yield* effect;
  return Option.isSome(record)
    ? record.value
    : yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orgOne = Effect.fn("KinChatRepository.findOrg")(function (input: Scope) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: OrgRow,
      execute: () =>
        sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs WHERE org_id = ${input.orgId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const personOne = Effect.fn("KinChatRepository.findPerson")(function (
    input: Scope & { readonly personId: KinPersonId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: PersonRow,
      execute: () =>
        sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const agentOne = Effect.fn("KinChatRepository.findAgent")(function (
    input: Scope & { readonly agentId: KinAgentId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: AgentRow,
      execute: () =>
        sql`SELECT ${sql.literal(agentColumns)} FROM kin_agents WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const chatOne = Effect.fn("KinChatRepository.findChat")(function (
    input: Scope & { readonly chatId: KinChatId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: ChatRow,
      execute: () =>
        sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const memberOne = Effect.fn("KinChatRepository.findMember")(function (
    input: Scope & { readonly memberId: KinMemberId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: MemberRow,
      execute: () =>
        sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND member_id = ${input.memberId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const messageOne = Effect.fn("KinChatRepository.findMessage")(function (
    input: Scope & { readonly messageId: KinMessageId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: MessageRow,
      execute: () =>
        sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId} AND message_id = ${input.messageId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const widgetOne = Effect.fn("KinChatRepository.findWidget")(function (
    input: Scope & { readonly widgetId: KinWidgetId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: WidgetRow,
      execute: () =>
        sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const waitingOne = Effect.fn("KinChatRepository.findWaiting")(function (
    input: Scope & { readonly waitingId: KinWaitingId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: WaitingRow,
      execute: () =>
        sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  const agentThreadOne = Effect.fn("KinChatRepository.findAgentThread")(function (
    input: Scope & { readonly threadId: ThreadId },
  ) {
    return SqlSchema.findOneOption({
      Request: Schema.Unknown,
      Result: AgentThreadRow,
      execute: () =>
        sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId}`,
    })(input).pipe(NodeSqliteClient.readOnly);
  });
  return KinChatRepository.of({
    getOrg: Effect.fn("KinChatRepository.getOrg")(
      function* (input) {
        return yield* orgOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getOrg")),
    ),
    getPerson: Effect.fn("KinChatRepository.getPerson")(
      function* (input) {
        return yield* personOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getPerson")),
    ),
    getAgent: Effect.fn("KinChatRepository.getAgent")(
      function* (input) {
        return yield* agentOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getAgent")),
    ),
    getChat: Effect.fn("KinChatRepository.getChat")(
      function* (input) {
        return yield* chatOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getChat")),
    ),
    getMember: Effect.fn("KinChatRepository.getMember")(
      function* (input) {
        return yield* memberOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getMember")),
    ),
    getMessage: Effect.fn("KinChatRepository.getMessage")(
      function* (input) {
        return yield* messageOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getMessage")),
    ),
    getWidget: Effect.fn("KinChatRepository.getWidget")(
      function* (input) {
        return yield* widgetOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getWidget")),
    ),
    getWaiting: Effect.fn("KinChatRepository.getWaiting")(
      function* (input) {
        return yield* waitingOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getWaiting")),
    ),
    getAgentThread: Effect.fn("KinChatRepository.getAgentThread")(
      function* (input) {
        return yield* agentThreadOne(input);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getAgentThread")),
    ),
    listOrgs: Effect.fn("KinChatRepository.listOrgs")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: OrgRow,
          execute: () =>
            sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs WHERE org_id = ${input.orgId} `,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listOrgs")),
    ),
    listPeople: Effect.fn("KinChatRepository.listPeople")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: PersonRow,
          execute: () =>
            sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} `,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listPeople")),
    ),
    listAgents: Effect.fn("KinChatRepository.listAgents")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: AgentRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentColumns)} FROM kin_agents WHERE org_id = ${input.orgId} `,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listAgents")),
    ),
    listChats: Effect.fn("KinChatRepository.listChats")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: ChatRow,
          execute: () =>
            sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} `,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listChats")),
    ),
    listMembers: Effect.fn("KinChatRepository.listMembers")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembers")),
    ),
    listMembersByPerson: Effect.fn("KinChatRepository.listMembersByPerson")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembersByPerson")),
    ),
    listMembersByAgent: Effect.fn("KinChatRepository.listMembersByAgent")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () =>
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembersByAgent")),
    ),
    listOpenWaiting: Effect.fn("KinChatRepository.listOpenWaiting")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingRow,
          execute: () =>
            sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND resolved_at IS NULL`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listOpenWaiting")),
    ),
    insertOrg: Effect.fn("KinChatRepository.insertOrg")(
      function* (input) {
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${input.orgId}, ${input.name}, ${input.createdAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertOrg")),
    ),
    insertPerson: Effect.fn("KinChatRepository.insertPerson")(
      function* (input) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at) VALUES (${input.personId}, ${input.orgId}, ${input.handle}, ${input.displayName}, ${input.githubLogin}, ${input.createdAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertPerson")),
    ),
    insertAgent: Effect.fn("KinChatRepository.insertAgent")(
      function* (input) {
        yield* requireRecord(personOne({ orgId: input.orgId, personId: input.ownerPersonId }));
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${input.agentId}, ${input.orgId}, ${input.displayName}, ${input.role}, ${input.ownerPersonId}, ${input.createdAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertAgent")),
    ),
    addMember: Effect.fn("KinChatRepository.addMember")(
      function* (input) {
        yield* requireRecord(chatOne(input));
        if (input.principal._tag === "person") {
          yield* requireRecord(
            personOne({ orgId: input.orgId, personId: input.principal.personId }),
          );
        } else {
          yield* requireRecord(agentOne({ orgId: input.orgId, agentId: input.principal.agentId }));
        }
        yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, role, joined_at, left_at, muted_until, principal_kind, person_id, agent_id) VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, ${input.role}, ${input.joinedAt}, ${input.leftAt}, ${input.mutedUntil}, ${input.principal._tag}, ${input.principal._tag === "person" ? input.principal.personId : null}, ${input.principal._tag === "agent" ? input.principal.agentId : null})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.addMember")),
    ),
    addWaiting: Effect.fn("KinChatRepository.addWaiting")(
      function* (input) {
        yield* requireRecord(chatOne(input));
        yield* requireRecord(personOne(input));
        yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution) VALUES (${input.waitingId}, ${input.orgId}, ${input.personId}, ${input.chatId}, ${input.messageId}, ${input.widgetId}, ${input.reason}, ${input.createdAt}, ${input.resolvedAt}, ${input.resolution})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.addWaiting")),
    ),
    registerAgentThread: Effect.fn("KinChatRepository.registerAgentThread")(
      function* (input) {
        yield* requireRecord(agentOne({ orgId: input.orgId, agentId: input.agentId }));
        yield* sql`INSERT INTO kin_agent_threads (org_id, thread_id, agent_id, started_at, ended_at) VALUES (${input.orgId}, ${input.threadId}, ${input.agentId}, ${input.startedAt}, ${input.endedAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.registerAgentThread")),
    ),
    createChat: Effect.fn("KinChatRepository.createChat")(
      function* (input) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at)
 VALUES (${input.chatId}, ${input.orgId}, ${input.kind}, ${input.title}, ${input.teamId}, ${input.directKey}, ${input.lastSeq}, ${input.lastMessageAt}, ${input.createdAt}, ${input.archivedAt})
 ON CONFLICT (org_id, direct_key) DO NOTHING`;
            return yield* requireRecord(
              SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: ChatRow,
                execute:
                  () => sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId}
 AND (chat_id = ${input.chatId} OR (direct_key = ${input.directKey} AND ${input.directKey} IS NOT NULL))`,
              })(input),
            );
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.createChat")),
    ),
    insertMessage: Effect.fn("KinChatRepository.insertMessage")(
      function* (input) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const author = input.author;
            const memberId = author._tag === "system" ? null : author.memberId;
            const clientId =
              input.clientMessageId === null
                ? null
                : `${input.kind === "widget_action" ? "act" : "send"}:${input.clientMessageId}`;
            if (memberId !== null && clientId !== null) {
              const existing = yield* SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND author_member_id = ${memberId} AND client_message_id = ${clientId}`,
              })(input);
              if (Option.isSome(existing)) return existing.value;
            }
            if (memberId !== null) {
              const member = yield* requireRecord(memberOne({ orgId: input.orgId, memberId }));
              if (member.chatId !== input.chatId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin member not found.",
                });
            }
            const mentions = yield* encodeMentions(input.mentions);
            const allocated = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: Schema.Struct({ last_seq: NonNegativeInt }),
              execute:
                () => sql`UPDATE kin_chats SET last_seq = last_seq + 1, last_message_at = ${input.createdAt}
 WHERE chat_id = ${input.chatId} AND org_id = ${input.orgId} RETURNING last_seq`,
            })(input);
            const seq = (yield* requireRecord(Effect.succeed(allocated))).last_seq;
            yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id, author_agent_id,
 author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, intent, mentions_json, reply_to,
 widget_id, floor_run_id, status, sent_by, client_message_id, created_at, edited_at)
 VALUES (${input.messageId}, ${input.orgId}, ${input.chatId}, ${seq}, ${author._tag},
 ${author._tag === "human" ? author.personId : null}, ${author._tag === "agent" ? author.agentId : null},
 ${author._tag === "agent" ? author.ownerPersonId : null}, ${author._tag === "agent" ? author.threadId : null},
 ${memberId}, ${input.authorRole}, ${input.kind}, ${input.body}, ${input.intent}, ${mentions}, ${input.replyTo},
 ${input.widgetId}, ${input.floorRunId}, ${input.status}, ${input.sentBy}, ${clientId}, ${input.createdAt}, ${input.editedAt})`;
            return yield* requireRecord(messageOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertMessage")),
    ),
    history: Effect.fn("KinChatRepository.history")(
      function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const request = yield* decodeHistory(input);
              const rows = yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq < ${request.beforeSeq} ORDER BY seq DESC LIMIT ${request.limit + 1}`,
              })(input);
              const messages = rows.slice(0, request.limit).reverse();
              const widgets =
                messages.length === 0
                  ? []
                  : yield* SqlSchema.findAll({
                      Request: Schema.Unknown,
                      Result: WidgetRow,
                      execute:
                        () => sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND message_id IN ${sql.in(messages.map((message) => message.messageId))}`,
                    })(input);
              return { messages, widgets, hasMore: rows.length > request.limit };
            }),
          )
          .pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.history")),
    ),
    messagesAfter: Effect.fn("KinChatRepository.messagesAfter")(
      function* (input) {
        const request = yield* decodeResume(input);
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute:
            () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq > ${request.afterSeq} ORDER BY seq LIMIT ${request.limit}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.messagesAfter")),
    ),
    insertWidget: Effect.fn("KinChatRepository.insertWidget")(
      function* (input) {
        yield* requireRecord(chatOne(input));
        const message = yield* requireRecord(messageOne(input));
        if (message.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        const state = yield* encodeWidgetState(input.state);
        const awaiting = yield* encodeAwaiting(input.awaiting);
        yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json,
 source_thread_id, source_item_id, feed_kind, feed_key, awaiting_json, pinned_at, closed_at, updated_at)
 VALUES (${input.widgetId}, ${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.widgetClass}, ${input.type},
 ${input.revision}, ${state}, ${input.source?.threadId ?? null}, ${input.source?.itemId ?? null},
 ${input.feed?.kind ?? null}, ${input.feed?.key ?? null}, ${awaiting}, ${input.pinnedAt}, ${input.closedAt}, ${input.updatedAt})`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.insertWidget")),
    ),
    updateWidget: Effect.fn("KinChatRepository.updateWidget")(
      function* (input) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* requireRecord(widgetOne(input));
            if (existing.chatId !== input.chatId || existing.messageId !== input.messageId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (
              existing.revision !== input.expectedRevision ||
              input.revision !== input.expectedRevision + 1
            )
              return yield* new KinChatError({
                reason: "widget_changed",
                message: "Widget revision changed.",
              });
            const state = yield* encodeWidgetState(input.state);
            const awaiting = yield* encodeAwaiting(input.awaiting);
            const updated = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: WidgetRow,
              execute:
                () => sql`UPDATE kin_widgets SET revision = ${input.revision}, state_json = ${state}, awaiting_json = ${awaiting},
 widget_class = ${input.widgetClass}, type = ${input.type}, source_thread_id = ${input.source?.threadId ?? null},
 source_item_id = ${input.source?.itemId ?? null}, feed_kind = ${input.feed?.kind ?? null}, feed_key = ${input.feed?.key ?? null},
 pinned_at = ${input.pinnedAt}, closed_at = ${input.closedAt}, updated_at = ${input.updatedAt}
 WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND revision = ${input.expectedRevision}
 RETURNING ${sql.literal(widgetColumns)}`,
            })(input);
            return yield* requireRecord(Effect.succeed(updated));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.updateWidget")),
    ),
    getReadState: Effect.fn("KinChatRepository.getReadState")(
      function* (input) {
        return yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: ReadStateRow,
          execute:
            () => sql`SELECT ${sql.literal(readStateColumns)} FROM kin_read_state WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND member_id = ${input.memberId}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.getReadState")),
    ),
    markRead: Effect.fn("KinChatRepository.markRead")(
      function* (input) {
        const seq = yield* decodeSeq(input.seq);
        const member = yield* requireRecord(memberOne(input));
        if (member.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
 VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, ${seq}, ${input.updatedAt})
 ON CONFLICT (chat_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at
 WHERE kin_read_state.org_id = excluded.org_id AND excluded.last_read_seq > kin_read_state.last_read_seq`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.markRead")),
    ),
    unreadCount: Effect.fn("KinChatRepository.unreadCount")(
      function* (input) {
        const row = yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: Schema.Struct({ count: NonNegativeInt }),
          execute:
            () => sql`SELECT COUNT(*) AS count FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND status = 'posted' AND (author_member_id IS NULL OR author_member_id != ${input.memberId})
 AND seq > COALESCE((SELECT last_read_seq FROM kin_read_state WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND member_id = ${input.memberId}), 0)`,
        })(input).pipe(NodeSqliteClient.readOnly);
        return Option.isSome(row) ? row.value.count : 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.unreadCount")),
    ),
    resolveWaiting: Effect.fn("KinChatRepository.resolveWaiting")(
      function* (input) {
        yield* sql`UPDATE kin_waiting SET resolved_at = ${input.resolvedAt}, resolution = ${input.resolution}
 WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId} AND resolved_at IS NULL`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.resolveWaiting")),
    ),
    endAgentThread: Effect.fn("KinChatRepository.endAgentThread")(
      function* (input) {
        yield* sql`UPDATE kin_agent_threads SET ended_at = ${input.endedAt}
 WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId} AND ended_at IS NULL`;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.endAgentThread")),
    ),
  });
});
export const layer = Layer.effect(KinChatRepository, make);
