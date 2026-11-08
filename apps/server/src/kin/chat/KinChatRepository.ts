import { ACTIVE_RUN_STATUSES } from "../../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadCaller } from "../../mcp/McpInvocationContext.ts";
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
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { messageForViewer } from "./messageView.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";

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
export type RepositoryError = PersistenceSqlError | PersistenceDecodeError | KinChatError;
type Scope = { readonly orgId: KinOrgId };
type ChatScope = Scope & { readonly chatId: KinChatId };
type MemberScope = ChatScope & { readonly memberId: KinMemberId };
type InsertMessage = Omit<KinMessage, "seq" | "authorRole" | "clientMessageId"> & {
  readonly caller?: McpThreadCaller | undefined;
  // Only the server-only task card creator may attribute a message outside an agent wake-up.
  readonly serverTaskCard?: true;
  readonly clientMessageId: {
    readonly kind: "send" | "act" | "task-card";
    readonly id: typeof TrimmedNonEmptyString.Type;
  } | null;
};

const isKinChatError = Schema.is(KinChatError);
const isDecodeError = Schema.is(PersistenceDecodeError);
const isSqlError = Schema.is(PersistenceSqlError);
const encodeMentions = Schema.encodeEffect(Schema.fromJsonString(KinMessage.fields.mentions));
const encodeWidgetState = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.state));
const encodeAwaiting = Schema.encodeEffect(Schema.fromJsonString(KinWidget.fields.awaiting));
const decodeChatTitle = Schema.decodeEffect(KinChat.fields.title);
const decodeWidgetText = Schema.decodeEffect(
  Schema.Struct({ type: KinWidget.fields.type, feed: KinWidget.fields.feed }),
);
const decodeWidgetFeed = Schema.decodeEffect(KinWidget.fields.feed);
const decodeBody = Schema.decodeEffect(KinMessage.fields.body);
const decodeHistory = Schema.decodeEffect(KinChatHistoryInput);
const decodeSeq = Schema.decodeEffect(NonNegativeInt);
const decodeResume = Schema.decodeEffect(
  Schema.Struct({
    afterSeq: NonNegativeInt,
    limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
  }),
);

function toRepositoryError(operation: string) {
  return (cause: unknown): RepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(operation, cause)
      : isKinChatError(cause) || isDecodeError(cause) || isSqlError(cause)
        ? cause
        : toPersistenceSqlError(operation)(cause);
}
export class KinIdentityBootstrapError extends Schema.TaggedError<KinIdentityBootstrapError>()(
  "KinIdentityBootstrapError",
  { message: Schema.String },
) {}
const isBootstrapError = Schema.is(KinIdentityBootstrapError);
const defaultOrgId = Schema.decodeSync(KinOrgId)("kin-default");
const defaultOwnerId = Schema.decodeSync(KinPersonId)("kin-default-owner");
const OrgRow = KinOrg;
const orgColumns = `org_id AS "orgId", name AS "name", created_at AS "createdAt"`;
const PersonRow = KinPerson;
const personColumns = `person_id AS "personId", org_id AS "orgId", handle AS "handle", display_name AS "displayName", github_login AS "githubLogin"`;
const AgentIdentityRow = Schema.Struct({
  ...KinAgent.fields,
  retiredAt: Schema.NullOr(IsoDateTime),
});
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
  storedClientMessageId: Schema.NullOr(Schema.String),
  author: Schema.fromJsonString(KinMessage.fields.author),
  mentions: Schema.fromJsonString(KinMessage.fields.mentions),
}).pipe(
  Schema.decodeTo(
    Schema.toType(KinMessage),
    SchemaTransformation.transform({
      decode: ({ storedClientMessageId, ...message }) => ({
        ...message,
        ...(storedClientMessageId?.startsWith("send:")
          ? { clientMessageId: storedClientMessageId.slice(5) }
          : {}),
      }),
      encode: (message) => ({
        ...message,
        storedClientMessageId:
          message.clientMessageId === undefined ? null : `send:${message.clientMessageId}`,
      }),
    }),
  ),
);
const messageColumns = `org_id AS "orgId", chat_id AS "chatId", message_id AS "messageId", seq AS "seq", change_seq AS "changeSeq", client_message_id AS "storedClientMessageId", author_role AS "authorRole", kind AS "kind", body AS "body", intent AS "intent", mentions_json AS "mentions", reply_to AS "replyTo", widget_id AS "widgetId", floor_run_id AS "floorRunId", status AS "status", sent_by AS "sentBy", created_at AS "createdAt", edited_at AS "editedAt", CASE author_kind WHEN 'human' THEN json_object('_tag', 'human', 'personId', author_person_id, 'memberId', author_member_id)
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

export const activeMemberStatement = (
  sql: SqlClient.SqlClient,
  input: ChatScope & { readonly principal: KinChatMember["principal"] },
) =>
  input.principal._tag === "person"
    ? sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.principal.personId} AND left_at IS NULL`
    : sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND agent_id = ${input.principal.agentId} AND left_at IS NULL`;

export class KinChatRepository extends Context.Service<
  KinChatRepository,
  {
    readonly getOrg: (input: Scope) => Effect.Effect<Option.Option<KinOrg>, RepositoryError>;
    readonly getPerson: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<Option.Option<KinPerson>, RepositoryError>;
    readonly getAgent: (
      input: Scope & { readonly agentId: KinAgentId },
    ) => Effect.Effect<Option.Option<typeof AgentIdentityRow.Type>, RepositoryError>;
    readonly getChat: (
      input: Scope & { readonly chatId: KinChatId },
    ) => Effect.Effect<Option.Option<KinChat>, RepositoryError>;
    readonly getMember: (
      input: Scope & { readonly memberId: KinMemberId },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly getMessage: (
      input: Scope & { readonly messageId: KinMessageId },
    ) => Effect.Effect<Option.Option<KinMessage>, RepositoryError>;
    readonly openTaskCards: (
      input: Scope,
    ) => Effect.Effect<ReadonlyArray<KinWidget>, RepositoryError>;
    readonly getWidget: (
      input: Scope & { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<Option.Option<KinWidget>, RepositoryError>;
    readonly getWaiting: (
      input: Scope & { readonly waitingId: KinWaitingId },
    ) => Effect.Effect<Option.Option<KinWaitingItem>, RepositoryError>;
    readonly getAgentThread: (
      input: Scope & { readonly threadId: ThreadId },
    ) => Effect.Effect<Option.Option<KinAgentThread>, RepositoryError>;
    readonly bootstrapIdentity: (input: {
      readonly orgName: string;
      readonly ownerHandle: string;
      readonly ownerDisplayName: string;
      readonly createdAt: IsoDateTime;
    }) => Effect.Effect<KinPerson, RepositoryError | KinIdentityBootstrapError>;
    readonly hasRunningWakeup: (
      input: Scope & {
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly caller: McpThreadCaller;
      },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly findAgentThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<KinAgentThread>, RepositoryError>;
    readonly listActiveAgentThreads: () => Effect.Effect<
      ReadonlyArray<KinAgentThread>,
      RepositoryError
    >;
    readonly listAllOrgs: () => Effect.Effect<ReadonlyArray<KinOrg>, RepositoryError>;
    readonly listPeople: (input: Scope) => Effect.Effect<ReadonlyArray<KinPerson>, RepositoryError>;
    readonly listAgents: (
      input: Scope,
    ) => Effect.Effect<
      ReadonlyArray<KinAgent & { readonly retiredAt: IsoDateTime | null }>,
      RepositoryError
    >;
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
    readonly activeMember: (
      input: ChatScope & { readonly principal: KinChatMember["principal"] },
    ) => Effect.Effect<Option.Option<KinChatMember>, RepositoryError>;
    readonly waitingForWidget: (
      input: Scope & { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly approvalAtMessage: (
      input: ChatScope & { readonly messageId: KinMessageId },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly resume: (
      input: ChatScope & {
        readonly memberId: KinMemberId;
        readonly afterSeq: number;
        readonly afterChangeSeq?: number | undefined;
      },
    ) => Effect.Effect<
      {
        readonly reset: boolean;
        readonly lastSeq: number;
        readonly lastChangeSeq: number;
        readonly messages: ReadonlyArray<KinMessage>;
        readonly widgets: ReadonlyArray<KinWidget>;
      },
      RepositoryError
    >;
    readonly listOpenWaiting: (
      input: Scope & { readonly personId: KinPersonId },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly insertOrg: (input: KinOrg) => Effect.Effect<void, RepositoryError>;
    readonly insertPerson: (
      input: KinPerson & { readonly createdAt: IsoDateTime },
    ) => Effect.Effect<void, RepositoryError>;
    readonly insertAgent: (
      input: KinAgent & { readonly createdAt: IsoDateTime },
    ) => Effect.Effect<void, RepositoryError>;
    readonly addMember: (input: KinChatMember) => Effect.Effect<KinChatMember, RepositoryError>;
    readonly leaveChat: (
      input: MemberScope & { readonly leftAt: IsoDateTime },
    ) => Effect.Effect<ReadonlyArray<KinWaitingItem>, RepositoryError>;
    readonly addApprovalWaiting: (
      input: KinWaitingItem & { readonly reason: "approval"; readonly widgetId: KinWidgetId },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly addWaiting: (input: KinWaitingItem) => Effect.Effect<boolean, RepositoryError>;
    readonly registerAgentThread: (
      input: KinAgentThread,
    ) => Effect.Effect<KinAgentThread, RepositoryError>;
    readonly createChat: (
      input: Omit<KinChat, "lastSeq"> & {
        readonly directKey: typeof TrimmedNonEmptyString.Type | null;
      },
    ) => Effect.Effect<KinChat, RepositoryError>;
    readonly findClientMessage: (
      input: MemberScope & {
        readonly kind: "send" | "act" | "task-card";
        readonly clientId: string;
      },
    ) => Effect.Effect<Option.Option<KinMessage>, RepositoryError>;
    readonly insertMessage: (input: InsertMessage) => Effect.Effect<KinMessage, RepositoryError>;
    readonly history: (
      input: Scope & KinChatHistoryInput & { readonly viewerMemberId?: KinMemberId },
    ) => Effect.Effect<KinChatHistoryResult, RepositoryError>;
    readonly messagesAfter: (
      input: ChatScope & {
        readonly afterSeq: typeof NonNegativeInt.Type;
        readonly limit: number;
        readonly viewerMemberId?: KinMemberId;
      },
    ) => Effect.Effect<ReadonlyArray<KinMessage>, RepositoryError>;
    readonly insertWidget: (
      input: Omit<KinWidget, "revision">,
    ) => Effect.Effect<void, RepositoryError>;
    readonly updateWidget: (
      input: Omit<KinWidget, "revision" | "type" | "widgetClass" | "chatId" | "messageId"> & {
        readonly expectedRevision: typeof NonNegativeInt.Type;
      },
    ) => Effect.Effect<KinWidget, RepositoryError>;
    readonly getReadState: (
      input: MemberScope,
    ) => Effect.Effect<Option.Option<KinReadState>, RepositoryError>;
    readonly markRead: (
      input: MemberScope & {
        readonly seq: typeof NonNegativeInt.Type;
        readonly updatedAt: IsoDateTime;
      },
    ) => Effect.Effect<void, RepositoryError>;
    readonly unreadCount: (input: MemberScope) => Effect.Effect<number, RepositoryError>;
    readonly resolveWaiting: (
      input: Scope & {
        readonly waitingId: KinWaitingId;
        readonly resolvedAt: IsoDateTime;
        readonly resolution: typeof TrimmedNonEmptyString.Type;
      },
    ) => Effect.Effect<boolean, RepositoryError>;
    readonly endAgentThread: (
      input: Scope & { readonly threadId: ThreadId; readonly endedAt: IsoDateTime },
    ) => Effect.Effect<boolean, RepositoryError>;
  }
>()("t3/kin/chat/KinChatRepository") {}

// Record validation shares the enclosing repository operation span.
const requireRecord = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<Option.Option<A>, E, R>,
) {
  const record = yield* effect;
  return Option.isSome(record)
    ? record.value
    : yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orgOne = Effect.fn("KinChatRepository.getOrg")(
    function (input: Scope) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: OrgRow,
        execute: () =>
          sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs WHERE org_id = ${input.orgId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getOrg")),
  );
  const personOne = Effect.fn("KinChatRepository.getPerson")(
    function (input: Scope & { readonly personId: KinPersonId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: PersonRow,
        execute: () =>
          sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getPerson")),
  );
  const agentOne = Effect.fn("KinChatRepository.getAgent")(
    function (input: Scope & { readonly agentId: KinAgentId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: AgentIdentityRow,
        execute: () =>
          sql`SELECT ${sql.literal(agentColumns)}, retired_at AS "retiredAt" FROM kin_agents WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getAgent")),
  );
  const chatOne = Effect.fn("KinChatRepository.getChat")(
    function (input: Scope & { readonly chatId: KinChatId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: ChatRow,
        execute: () =>
          sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getChat")),
  );
  const memberOne = Effect.fn("KinChatRepository.getMember")(
    function (input: Scope & { readonly memberId: KinMemberId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: MemberRow,
        execute: () =>
          sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND member_id = ${input.memberId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getMember")),
  );
  const messageOne = Effect.fn("KinChatRepository.getMessage")(
    function (input: Scope & { readonly messageId: KinMessageId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: MessageRow,
        execute: () =>
          sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId} AND message_id = ${input.messageId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getMessage")),
  );
  const widgetOne = Effect.fn("KinChatRepository.getWidget")(
    function (input: Scope & { readonly widgetId: KinWidgetId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: WidgetRow,
        execute: () =>
          sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getWidget")),
  );
  const waitingOne = Effect.fn("KinChatRepository.getWaiting")(
    function (input: Scope & { readonly waitingId: KinWaitingId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: WaitingRow,
        execute: () =>
          sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getWaiting")),
  );
  const agentThreadOne = Effect.fn("KinChatRepository.getAgentThread")(
    function (input: Scope & { readonly threadId: ThreadId }) {
      return SqlSchema.findOneOption({
        Request: Schema.Unknown,
        Result: AgentThreadRow,
        execute: () =>
          sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId}`,
      })(input).pipe(NodeSqliteClient.readOnly);
    },
    Effect.mapError(toRepositoryError("KinChatRepository.getAgentThread")),
  );
  const hasRunningWakeup = Effect.fn("KinChatRepository.hasRunningWakeup")(
    function* (
      input: Scope & {
        readonly agentId: KinAgentId;
        readonly threadId: ThreadId;
        readonly caller: McpThreadCaller;
      },
    ) {
      if (input.caller.subagent === true || input.caller.threadId !== input.threadId) return false;
      const rows =
        yield* sql`WITH RECURSIVE ancestors(run_id, thread_id, ordinal, payload_json) AS (
        SELECT run_id, thread_id, ordinal, payload_json
        FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
        WHERE thread_id = ${input.threadId} AND status IN ${sql.in(ACTIVE_RUN_STATUSES)}
        UNION
        SELECT p.run_id, p.thread_id, p.ordinal, p.payload_json
        FROM ancestors child JOIN orchestration_v2_projection_runs p
          ON p.thread_id = child.thread_id
          AND (p.run_id = json_extract(child.payload_json, '$.restartContinuationOfRunId')
            OR p.run_id = json_extract(child.payload_json, '$.usageLimitContinuationOfRunId'))
        -- Continuation links plus agent/server provenance come only from the restart and usage-limit workers.
        JOIN orchestration_v2_projection_messages cm
          ON cm.message_id = json_extract(child.payload_json, '$.userMessageId')
          AND cm.thread_id = child.thread_id AND cm.run_id = child.run_id
          AND json_extract(cm.payload_json, '$.createdBy') = 'agent'
          AND json_extract(cm.payload_json, '$.creationSource') = 'server'
      )
      SELECT 1 FROM kin_wakeups w JOIN ancestors root ON root.thread_id = w.thread_id
      JOIN orchestration_v2_projection_messages m
        ON m.message_id = json_extract(root.payload_json, '$.userMessageId')
        AND m.thread_id = root.thread_id AND m.run_id = root.run_id
      WHERE w.org_id = ${input.orgId} AND w.agent_id = ${input.agentId}
        AND w.thread_id = ${input.threadId} AND w.status = 'running'
        AND json_extract(root.payload_json, '$.userMessageId') = 'kin-wakeup-msg:' || w.wakeup_id
        AND json_extract(m.payload_json, '$.createdBy') = 'system'
        AND json_extract(m.payload_json, '$.creationSource') = 'server'
        AND root.run_id = COALESCE(w.run_id, (
          SELECT first.run_id FROM orchestration_v2_projection_runs first
          WHERE first.thread_id = w.thread_id
            AND json_extract(first.payload_json, '$.userMessageId') = 'kin-wakeup-msg:' || w.wakeup_id
          ORDER BY first.ordinal LIMIT 1
        )) LIMIT 1`;
      return rows.length > 0;
    },
    Effect.mapError(toRepositoryError("KinChatRepository.hasRunningWakeup")),
  );
  const validateWidgetReferences = Effect.fn("KinChatRepository.validateWidgetReferences")(
    function* (input: Pick<KinWidget, "orgId" | "chatId" | "awaiting" | "source">) {
      for (const personId of input.awaiting) {
        yield* requireRecord(personOne({ orgId: input.orgId, personId }));
        yield* requireRecord(
          SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: MemberRow,
            execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${personId} AND left_at IS NULL`,
          })(input),
        );
      }
      if (input.source !== null) {
        const thread = yield* requireRecord(
          agentThreadOne({ orgId: input.orgId, threadId: input.source.threadId }),
        );
        yield* requireRecord(
          SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: MemberRow,
            execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND agent_id = ${thread.agentId}`,
          })(input),
        );
      }
    },
  );
  const addWaiting = Effect.fn("KinChatRepository.addWaiting")(
    function* (input: KinWaitingItem, approval: boolean) {
      if (input.resolvedAt !== null || input.resolution !== null)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "New waiting items must be open.",
        });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* requireRecord(chatOne(input));
          yield* requireRecord(personOne(input));
          yield* requireRecord(
            SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: MemberRow,
              execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.personId} AND left_at IS NULL`,
            })(input),
          );
          if (input.messageId !== null) {
            const message = yield* requireRecord(
              messageOne({ orgId: input.orgId, messageId: input.messageId }),
            );
            if (message.chatId !== input.chatId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
          }
          if (input.widgetId !== null) {
            const widget = yield* requireRecord(
              widgetOne({ orgId: input.orgId, widgetId: input.widgetId }),
            );
            if (widget.chatId !== input.chatId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
          }
          const approvalWidgets =
            yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND type = 'approval' AND (widget_id = ${input.widgetId} OR message_id = ${input.messageId} OR message_id IN (SELECT message_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND widget_id = ${input.widgetId})) ORDER BY widget_id`;
          if (
            approval
              ? input.reason !== "approval" ||
                input.widgetId === null ||
                (yield* requireRecord(widgetOne({ orgId: input.orgId, widgetId: input.widgetId })))
                  .type !== "approval"
              : input.reason === "approval" || approvalWidgets.length > 0
          )
            return yield* new KinChatError({
              reason: "not_allowed",
              message: "Chat operation not allowed.",
            });
          const existing = yield* SqlSchema.findOneOption({
            Request: Schema.Unknown,
            Result: WaitingRow,
            execute: () =>
              sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE waiting_id = ${input.waitingId}`,
          })(input);
          if (Option.isSome(existing)) {
            if (existing.value.orgId !== input.orgId)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (
              !(
                [
                  "orgId",
                  "personId",
                  "chatId",
                  "messageId",
                  "widgetId",
                  "reason",
                  "createdAt",
                ] as const
              ).every((key) => existing.value[key] === input[key])
            )
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Kin waiting identity conflict.",
              });
            return true;
          }
          const inserted =
            yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, widget_id, reason, created_at, resolved_at, resolution) VALUES (${input.waitingId}, ${input.orgId}, ${input.personId}, ${input.chatId}, ${input.messageId}, ${input.widgetId}, ${input.reason}, ${input.createdAt}, ${input.resolvedAt}, ${input.resolution}) ON CONFLICT (widget_id, person_id) WHERE resolved_at IS NULL AND widget_id IS NOT NULL DO NOTHING RETURNING waiting_id`;
          return inserted.length > 0;
        }),
      );
    },
    Effect.mapError(toRepositoryError("KinChatRepository.addWaiting")),
  );
  return KinChatRepository.of({
    hasRunningWakeup,
    getOrg: orgOne,
    getPerson: personOne,
    getAgent: agentOne,
    getChat: chatOne,
    getMember: memberOne,
    getMessage: messageOne,
    openTaskCards: Effect.fn("KinChatRepository.openTaskCards")(
      (input) =>
        SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WidgetRow,
          execute: () =>
            sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND type = 'task' AND closed_at IS NULL ORDER BY widget_id`,
        })(input),
      Effect.mapError(toRepositoryError("KinChatRepository.openTaskCards")),
    ),
    getWidget: widgetOne,
    getWaiting: waitingOne,
    getAgentThread: agentThreadOne,
    bootstrapIdentity: Effect.fn("KinChatRepository.bootstrapIdentity")(
      function* (input) {
        const orgId = defaultOrgId;
        const personId = defaultOwnerId;
        const inserted = yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
 SELECT ${orgId}, ${input.orgName}, ${input.createdAt} WHERE NOT EXISTS (SELECT 1 FROM kin_orgs)
 ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
        if (inserted.length > 0) {
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at)
 VALUES (${personId}, ${orgId}, ${input.ownerHandle}, ${input.ownerDisplayName}, NULL, ${input.createdAt})
 ON CONFLICT (person_id) DO NOTHING RETURNING person_id`;
        }
        // Never infer ownership from a handle or whichever person happens to sort first.
        const org = yield* orgOne({ orgId });
        if (Option.isNone(org))
          return yield* new KinIdentityBootstrapError({
            message:
              "Kin tables contain an unknown org instead of reserved org `kin-default`; restore the reserved identity or recreate the Kin tables.",
          });
        const owner = yield* personOne({ orgId, personId });
        if (Option.isNone(owner))
          return yield* new KinIdentityBootstrapError({
            message:
              "Kin org `kin-default` exists without owner person `kin-default-owner`; restore it or recreate the Kin tables.",
          });
        if (org.value.name !== input.orgName || owner.value.handle !== input.ownerHandle)
          yield* Effect.logInfo(
            "Kin identity configuration differs from stored org name or owner handle; keeping stored identity.",
          );
        return owner.value;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError((cause) =>
        isBootstrapError(cause)
          ? cause
          : toRepositoryError("KinChatRepository.bootstrapIdentity")(cause),
      ),
    ),
    // Only trusted caller-thread discovery crosses orgs; subsequent identity reads use the stored org.
    findAgentThread: Effect.fn("KinChatRepository.findAgentThread")(
      function* (threadId) {
        return yield* SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: AgentThreadRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE thread_id = ${threadId}`,
        })(threadId).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.findAgentThread")),
    ),
    listActiveAgentThreads: Effect.fn("KinChatRepository.listActiveAgentThreads")(
      function* () {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: AgentThreadRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads
 WHERE ended_at IS NULL AND EXISTS (SELECT 1 FROM kin_agents a
 WHERE a.org_id = kin_agent_threads.org_id AND a.agent_id = kin_agent_threads.agent_id AND a.retired_at IS NULL)
 ORDER BY org_id, thread_id`,
        })(undefined).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listActiveAgentThreads")),
    ),
    listAllOrgs: Effect.fn("KinChatRepository.listAllOrgs")(
      function* () {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: OrgRow,
          execute: () =>
            sql`SELECT ${sql.literal(orgColumns)} FROM kin_orgs ORDER BY created_at, org_id`,
        })(undefined).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listAllOrgs")),
    ),
    listPeople: Effect.fn("KinChatRepository.listPeople")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: PersonRow,
          execute: () =>
            sql`SELECT ${sql.literal(personColumns)} FROM kin_people WHERE org_id = ${input.orgId} ORDER BY handle, person_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listPeople")),
    ),
    listAgents: Effect.fn("KinChatRepository.listAgents")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: AgentIdentityRow,
          execute: () =>
            sql`SELECT ${sql.literal(agentColumns)}, retired_at AS "retiredAt" FROM kin_agents WHERE org_id = ${input.orgId} ORDER BY display_name, agent_id`,
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
            sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId} ORDER BY last_message_at DESC, chat_id`,
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
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} ORDER BY joined_at, member_id`,
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
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND person_id = ${input.personId} ORDER BY joined_at, member_id`,
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
            sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY joined_at, member_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.listMembersByAgent")),
    ),
    activeMember: Effect.fn("KinChatRepository.activeMember")(
      function (input) {
        return SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: MemberRow,
          execute: () => activeMemberStatement(sql, input),
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.activeMember")),
    ),
    waitingForWidget: Effect.fn("KinChatRepository.waitingForWidget")(
      function (input) {
        return SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingRow,
          execute: () =>
            sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND resolved_at IS NULL ORDER BY created_at, waiting_id`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.waitingForWidget")),
    ),
    approvalAtMessage: Effect.fn("KinChatRepository.approvalAtMessage")(
      function* (input) {
        const rows =
          yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId} AND type = 'approval' ORDER BY widget_id LIMIT 1`;
        return rows.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.approvalAtMessage")),
    ),
    resume: Effect.fn("KinChatRepository.resume")(
      function* (input) {
        const member = yield* requireRecord(memberOne(input));
        if (member.chatId !== input.chatId || member.leftAt !== null)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        const chat = yield* requireRecord(chatOne(input));
        const counters = yield* sql<{
          change_seq: number;
        }>`SELECT change_seq FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}`;
        const lastChangeSeq = counters[0]!.change_seq;
        // Without a change cursor, replay only new messages; change_seq runs ahead of seq.
        const afterChangeSeq = input.afterChangeSeq ?? lastChangeSeq;
        const visible = sql`(${member.role === "owner" ? 1 : 0} = 1 OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${member.memberId})`;
        const messages = yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute: () =>
            sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages
              WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id IN (
                SELECT message_id FROM (SELECT message_id FROM kin_messages
                  WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND seq > ${input.afterSeq} AND ${visible}
                  ORDER BY seq LIMIT 201)
                UNION
                SELECT message_id FROM (SELECT message_id FROM kin_messages
                  WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND change_seq > ${afterChangeSeq} AND ${visible}
                  ORDER BY change_seq, seq LIMIT 201)
              ) ORDER BY seq LIMIT 201`,
        })(input);
        if (messages.length > 200)
          return { reset: true, lastSeq: chat.lastSeq, lastChangeSeq, messages: [], widgets: [] };
        const widgets =
          messages.length === 0
            ? []
            : yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: WidgetRow,
                execute: () =>
                  sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND (message_id IN ${sql.in(messages.map((m) => m.messageId))} OR widget_id IN ${sql.in(messages.flatMap((m) => (m.widgetId === null ? [] : [m.widgetId])))}) ORDER BY message_id, widget_id`,
              })(input);
        return {
          reset: false,
          messages: messages.map((m) => messageForViewer(m, member.principal)),
          widgets,
          lastSeq: chat.lastSeq,
          lastChangeSeq,
        };
      },
      (effect) => sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly),
      Effect.mapError(toRepositoryError("KinChatRepository.resume")),
    ),
    listOpenWaiting: Effect.fn("KinChatRepository.listOpenWaiting")(
      function* (input) {
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: WaitingRow,
          execute: () =>
            sql`SELECT ${sql.literal(waitingColumns)} FROM kin_waiting WHERE org_id = ${input.orgId} AND person_id = ${input.personId} AND resolved_at IS NULL ORDER BY created_at, waiting_id`,
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
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.insertAgent")),
    ),
    addMember: Effect.fn("KinChatRepository.addMember")(
      function* (input) {
        if (input.leftAt !== null)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "New Kin members must be active.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireRecord(chatOne(input));
            if (input.principal._tag === "person") {
              yield* requireRecord(
                personOne({ orgId: input.orgId, personId: input.principal.personId }),
              );
            } else {
              yield* requireRecord(
                agentOne({ orgId: input.orgId, agentId: input.principal.agentId }),
              );
            }
            if (input.principal._tag === "agent" && input.role !== "member")
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Chat operation not allowed.",
              });
            // Global ids must detect hidden cross-org collisions without exposing their rows.
            const existing = yield* SqlSchema.findAll({
              Request: Schema.Unknown,
              Result: MemberRow,
              execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE member_id = ${input.memberId} OR (chat_id = ${input.chatId} AND (person_id = ${input.principal._tag === "person" ? input.principal.personId : null} OR agent_id = ${input.principal._tag === "agent" ? input.principal.agentId : null}))`,
            })(input);
            if (existing.some((member) => member.orgId !== input.orgId))
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            if (input.role === "owner") {
              if (input.principal._tag !== "person")
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Chat operation not allowed.",
                });
              const owners =
                yield* sql`SELECT member_id FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND role = 'owner' AND member_id <> ${input.memberId} ORDER BY member_id LIMIT 1`;
              if (owners.length > 0)
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Chat operation not allowed.",
                });
            }
            for (const member of existing) {
              if (
                member.chatId !== input.chatId ||
                member.memberId !== input.memberId ||
                member.principal._tag !== input.principal._tag ||
                (member.principal._tag === "person" &&
                  input.principal._tag === "person" &&
                  member.principal.personId !== input.principal.personId) ||
                (member.principal._tag === "agent" &&
                  input.principal._tag === "agent" &&
                  member.principal.agentId !== input.principal.agentId)
              )
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Kin member identity conflict.",
                });
              if (member.leftAt === null) {
                if (
                  member.role !== input.role ||
                  member.joinedAt !== input.joinedAt ||
                  member.mutedUntil !== input.mutedUntil
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin member identity conflict.",
                  });
                return member;
              }
              yield* sql`UPDATE kin_chat_members SET left_at = NULL, joined_at = ${input.joinedAt}, role = ${input.role}
 WHERE org_id = ${input.orgId} AND member_id = ${input.memberId}`;
              return yield* requireRecord(memberOne(input));
            }
            yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, role, joined_at, left_at, muted_until, principal_kind, person_id, agent_id) VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, ${input.role}, ${input.joinedAt}, ${input.leftAt}, ${input.mutedUntil}, ${input.principal._tag}, ${input.principal._tag === "person" ? input.principal.personId : null}, ${input.principal._tag === "agent" ? input.principal.agentId : null}) ON CONFLICT DO NOTHING RETURNING member_id`;
            return yield* requireRecord(memberOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.addMember")),
    ),
    leaveChat: Effect.fn("KinChatRepository.leaveChat")(
      function* (input) {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql`UPDATE kin_chat_members SET left_at = ${input.leftAt}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.memberId} AND left_at IS NULL RETURNING member_id`;
            if (changed.length === 0) return [];
            const member = yield* requireRecord(memberOne(input));
            if (member.principal._tag !== "person") return [];
            const personId = member.principal.personId;
            return yield* SqlSchema.findAll({
              Request: Schema.Unknown,
              Result: WaitingRow,
              execute:
                () => sql`UPDATE kin_waiting SET resolved_at = ${input.leftAt}, resolution = 'cancelled'
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${personId} AND resolved_at IS NULL RETURNING ${sql.literal(waitingColumns)}`,
            })(input).pipe(
              Effect.map((rows) => rows.toSorted((a, b) => a.waitingId.localeCompare(b.waitingId))),
            );
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.leaveChat")),
    ),
    addWaiting: Effect.fn("KinChatRepository.addWaiting")((input) => addWaiting(input, false)),
    addApprovalWaiting: Effect.fn("KinChatRepository.addApprovalWaiting")((input) =>
      addWaiting(input, true),
    ),
    registerAgentThread: Effect.fn("KinChatRepository.registerAgentThread")(
      function* (input) {
        if (input.endedAt !== null)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "New Kin agent threads must be active.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const agent = yield* requireRecord(
              agentOne({ orgId: input.orgId, agentId: input.agentId }),
            );
            if (agent.retiredAt !== null)
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Retired Kin agents cannot register threads.",
              });
            const inbox =
              yield* sql`SELECT 1 FROM kin_webhook_sources WHERE inbox_thread_id = ${input.threadId}`;
            if (inbox.length > 0)
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Webhook inbox threads cannot be Kin agents.",
              });
            const existing = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: AgentThreadRow,
              execute: () =>
                sql`SELECT ${sql.literal(agentThreadColumns)} FROM kin_agent_threads WHERE thread_id = ${input.threadId}`,
            })(input);
            if (Option.isSome(existing)) {
              if (existing.value.orgId !== input.orgId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
              if (
                existing.value.agentId !== input.agentId ||
                existing.value.endedAt !== null ||
                input.endedAt !== existing.value.endedAt
              )
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: "Kin agent thread identity conflict.",
                });
              return existing.value;
            }
            yield* sql`INSERT INTO kin_agent_threads (org_id, thread_id, agent_id, started_at, ended_at) VALUES (${input.orgId}, ${input.threadId}, ${input.agentId}, ${input.startedAt}, ${input.endedAt})
 ON CONFLICT (thread_id) DO NOTHING RETURNING thread_id`;
            return yield* requireRecord(agentThreadOne(input));
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.registerAgentThread")),
    ),
    createChat: Effect.fn("KinChatRepository.createChat")(
      function* (input) {
        yield* decodeChatTitle(input.title);
        if ((input.kind === "direct") !== (input.directKey !== null))
          return yield* new KinChatError({
            reason: "invalid_state",
            message: "Kin chat kind and direct key must agree.",
          });
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireRecord(orgOne(input));
            yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, direct_key, last_seq, last_message_at, created_at, archived_at)
 VALUES (${input.chatId}, ${input.orgId}, ${input.kind}, ${input.title}, ${input.teamId}, ${input.directKey}, 0, ${input.lastMessageAt}, ${input.createdAt}, ${input.archivedAt})
 ON CONFLICT DO NOTHING`;
            return yield* requireRecord(
              SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: ChatRow,
                execute:
                  () => sql`SELECT ${sql.literal(chatColumns)} FROM kin_chats WHERE org_id = ${input.orgId}
 AND ${input.kind === "direct" ? sql`kind = 'direct' AND direct_key = ${input.directKey}` : sql`chat_id = ${input.chatId} AND kind = ${input.kind}`}`,
              })(input),
            );
          }),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.createChat")),
    ),
    findClientMessage: Effect.fn("KinChatRepository.findClientMessage")(
      function (input) {
        return SqlSchema.findOneOption({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute: () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND author_member_id = ${input.memberId}
 AND client_message_id = ${`${input.kind}:${input.clientId}`}`,
        })(input).pipe(NodeSqliteClient.readOnly);
      },
      Effect.mapError(toRepositoryError("KinChatRepository.findClientMessage")),
    ),
    insertMessage: Effect.fn("KinChatRepository.insertMessage")(
      function* (input) {
        yield* decodeBody(input.body);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const author = input.author;
            const memberId = author._tag === "system" ? null : author.memberId;
            const clientId =
              input.clientMessageId === null
                ? null
                : `${input.clientMessageId.kind}:${input.clientMessageId.id}`;
            const member =
              author._tag === "system"
                ? null
                : yield* requireRecord(
                    memberOne({ orgId: input.orgId, memberId: author.memberId }),
                  );
            if (member !== null) {
              if (
                member.chatId !== input.chatId ||
                (author._tag === "human" &&
                  (member.principal._tag !== "person" ||
                    member.principal.personId !== author.personId)) ||
                (author._tag === "agent" &&
                  (member.principal._tag !== "agent" ||
                    member.principal.agentId !== author.agentId))
              )
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (memberId !== null && clientId !== null) {
              const existing = yield* SqlSchema.findOneOption({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND author_member_id = ${memberId} AND client_message_id = ${clientId}`,
              })(input);
              if (Option.isSome(existing)) {
                if (
                  author._tag === "agent" &&
                  (existing.value.author._tag !== "agent" ||
                    existing.value.author.threadId !== author.threadId ||
                    existing.value.author.ownerPersonId !== author.ownerPersonId)
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin message author identity conflict.",
                  });
                if (
                  existing.value.body !== input.body ||
                  existing.value.intent !== input.intent ||
                  existing.value.replyTo !== input.replyTo ||
                  existing.value.widgetId !== input.widgetId ||
                  existing.value.kind !== input.kind ||
                  existing.value.mentions.length !== input.mentions.length ||
                  !existing.value.mentions.every((id, index) => id === input.mentions[index])
                )
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: "Kin message retry conflict.",
                  });
                return existing.value;
              }
            }
            if (member !== null && member.leftAt !== null)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
            const agent =
              author._tag === "agent"
                ? yield* requireRecord(agentOne({ orgId: input.orgId, agentId: author.agentId }))
                : null;
            if (author._tag === "agent" && agent !== null) {
              const thread = yield* requireRecord(
                agentThreadOne({ orgId: input.orgId, threadId: author.threadId }),
              );
              if (
                agent.ownerPersonId !== author.ownerPersonId ||
                thread.agentId !== agent.agentId ||
                thread.endedAt !== null ||
                agent.retiredAt !== null
              )
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (
              author._tag === "agent" &&
              input.serverTaskCard !== true &&
              (input.caller === undefined ||
                !(yield* hasRunningWakeup({
                  ...input,
                  agentId: author.agentId,
                  threadId: author.threadId,
                  caller: input.caller,
                })))
            )
              return yield* new KinChatError({
                reason: "not_allowed",
                message: "Kin wake-up is not running.",
              });
            if (input.replyTo !== null) {
              const reply = yield* requireRecord(
                messageOne({ orgId: input.orgId, messageId: input.replyTo }),
              );
              if (reply.chatId !== input.chatId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (input.widgetId !== null) {
              const widget = yield* requireRecord(
                widgetOne({ orgId: input.orgId, widgetId: input.widgetId }),
              );
              if (widget.chatId !== input.chatId)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
            }
            if (input.sentBy !== null) {
              yield* requireRecord(personOne({ orgId: input.orgId, personId: input.sentBy }));
              yield* requireRecord(
                SqlSchema.findOneOption({
                  Request: Schema.Unknown,
                  Result: MemberRow,
                  execute: () => sql`SELECT ${sql.literal(memberColumns)} FROM kin_chat_members
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND person_id = ${input.sentBy}
 AND principal_kind = 'person' AND role = 'owner' AND left_at IS NULL`,
                })(input),
              );
            }
            for (const mention of input.mentions) {
              const mentioned = yield* requireRecord(
                memberOne({ orgId: input.orgId, memberId: mention }),
              );
              if (mentioned.chatId !== input.chatId || mentioned.leftAt !== null)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
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
            const inserted =
              yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id, author_agent_id,
 author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body, intent, mentions_json, reply_to,
 widget_id, floor_run_id, status, sent_by, client_message_id, created_at, edited_at)
 VALUES (${input.messageId}, ${input.orgId}, ${input.chatId}, ${seq}, ${author._tag},
 ${member?.principal._tag === "person" ? member.principal.personId : null}, ${member?.principal._tag === "agent" ? member.principal.agentId : null},
 ${agent?.ownerPersonId ?? null}, ${author._tag === "agent" ? author.threadId : null},
 ${memberId}, ${member?.role ?? "member"}, ${input.kind}, ${input.body}, ${input.intent}, ${mentions}, ${input.replyTo},
 ${input.widgetId}, ${input.floorRunId}, ${input.status}, ${input.sentBy}, ${clientId}, ${input.createdAt}, ${input.editedAt})
 ON CONFLICT DO NOTHING RETURNING message_id`;
            if (inserted.length === 0)
              return yield* new KinChatError({
                reason: "not_found",
                message: "Kin record not found.",
              });
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
              const viewer =
                input.viewerMemberId === undefined
                  ? null
                  : yield* requireRecord(
                      memberOne({ orgId: input.orgId, memberId: input.viewerMemberId }),
                    );
              if (viewer !== null && (viewer.chatId !== input.chatId || viewer.leftAt !== null))
                return yield* new KinChatError({
                  reason: "not_found",
                  message: "Kin record not found.",
                });
              const rows = yield* SqlSchema.findAll({
                Request: Schema.Unknown,
                Result: MessageRow,
                execute:
                  () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq < ${request.beforeSeq}
 AND (${viewer === null || viewer.role === "owner" ? 1 : 0} = 1 OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${viewer?.memberId ?? null})
 ORDER BY seq DESC LIMIT ${request.limit + 1}`,
              })(input);
              const messages = rows
                .slice(0, request.limit)
                .reverse()
                .map((m) => messageForViewer(m, viewer?.principal));
              const widgets =
                messages.length === 0
                  ? []
                  : yield* SqlSchema.findAll({
                      Request: Schema.Unknown,
                      Result: WidgetRow,
                      execute:
                        () => sql`SELECT ${sql.literal(widgetColumns)} FROM kin_widgets WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND (message_id IN ${sql.in(messages.map((message) => message.messageId))} OR widget_id IN ${sql.in(messages.flatMap((message) => (message.widgetId === null ? [] : [message.widgetId])))}) ORDER BY message_id, widget_id`,
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
        const viewer =
          input.viewerMemberId === undefined
            ? undefined
            : yield* requireRecord(
                memberOne({ orgId: input.orgId, memberId: input.viewerMemberId }),
              );
        return yield* SqlSchema.findAll({
          Request: Schema.Unknown,
          Result: MessageRow,
          execute:
            () => sql`SELECT ${sql.literal(messageColumns)} FROM kin_messages WHERE org_id = ${input.orgId}
 AND chat_id = ${input.chatId} AND seq > ${request.afterSeq}
 AND (${input.viewerMemberId ?? null} IS NULL OR status NOT IN ('suggested', 'dismissed') OR author_member_id = ${input.viewerMemberId ?? null} OR EXISTS (SELECT 1 FROM kin_chat_members WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND member_id = ${input.viewerMemberId ?? null} AND role = 'owner')) ORDER BY seq LIMIT ${request.limit}`,
        })(input).pipe(
          NodeSqliteClient.readOnly,
          Effect.map((messages) => messages.map((m) => messageForViewer(m, viewer?.principal))),
        );
      },
      Effect.mapError(toRepositoryError("KinChatRepository.messagesAfter")),
    ),
    insertWidget: Effect.fn("KinChatRepository.insertWidget")(
      function* (input) {
        yield* decodeWidgetText(input);
        yield* requireRecord(chatOne(input));
        const message = yield* requireRecord(messageOne(input));
        if (message.chatId !== input.chatId)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* validateWidgetReferences(input);
        const state = yield* encodeWidgetState(input.state);
        const awaiting = yield* encodeAwaiting(input.awaiting);
        const inserted =
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json,
 source_thread_id, source_item_id, feed_kind, feed_key, awaiting_json, pinned_at, closed_at, updated_at)
 VALUES (${input.widgetId}, ${input.orgId}, ${input.chatId}, ${input.messageId}, ${input.widgetClass}, ${input.type},
 1, ${state}, ${input.source?.threadId ?? null}, ${input.source?.itemId ?? null},
 ${input.feed?.kind ?? null}, ${input.feed?.key ?? null}, ${awaiting}, ${input.pinnedAt}, ${input.closedAt}, ${input.updatedAt})
 ON CONFLICT DO NOTHING RETURNING widget_id`;
        if (inserted.length === 0)
          return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
        yield* sql`UPDATE kin_messages SET widget_id = ${input.widgetId}
 WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND message_id = ${input.messageId} AND widget_id IS NULL`;
      },
      (effect) => sql.withTransaction(effect),
      Effect.mapError(toRepositoryError("KinChatRepository.insertWidget")),
    ),
    updateWidget: Effect.fn("KinChatRepository.updateWidget")(
      function* (input) {
        yield* decodeWidgetFeed(input.feed);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const widget = yield* requireRecord(widgetOne(input));
            yield* validateWidgetReferences({ ...input, chatId: widget.chatId });
            const state = yield* encodeWidgetState(input.state);
            const awaiting = yield* encodeAwaiting(input.awaiting);
            const updated = yield* SqlSchema.findOneOption({
              Request: Schema.Unknown,
              Result: WidgetRow,
              execute:
                () => sql`UPDATE kin_widgets SET revision = revision + 1, state_json = ${state}, awaiting_json = ${awaiting},
 source_thread_id = ${input.source?.threadId ?? null},
 source_item_id = ${input.source?.itemId ?? null}, feed_kind = ${input.feed?.kind ?? null}, feed_key = ${input.feed?.key ?? null},
 pinned_at = ${input.pinnedAt}, closed_at = ${input.closedAt}, updated_at = ${input.updatedAt}
 WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId} AND revision = ${input.expectedRevision}
 RETURNING ${sql.literal(widgetColumns)}`,
            })(input);
            if (Option.isNone(updated))
              return yield* new KinChatError({
                reason: "widget_changed",
                message: "Widget revision changed.",
              });
            return updated.value;
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
 VALUES (${input.orgId}, ${input.chatId}, ${input.memberId}, MIN(${seq}, (SELECT last_seq FROM kin_chats WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId})), ${input.updatedAt})
 ON CONFLICT (chat_id, member_id) DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at
 WHERE kin_read_state.org_id = excluded.org_id AND excluded.last_read_seq > kin_read_state.last_read_seq`;
      },
      (effect) => sql.withTransaction(effect),
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
        const changed =
          yield* sql`UPDATE kin_waiting SET resolved_at = ${input.resolvedAt}, resolution = ${input.resolution}
 WHERE org_id = ${input.orgId} AND waiting_id = ${input.waitingId} AND resolved_at IS NULL RETURNING waiting_id`;
        return changed.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.resolveWaiting")),
    ),
    endAgentThread: Effect.fn("KinChatRepository.endAgentThread")(
      function* (input) {
        const changed = yield* sql`UPDATE kin_agent_threads SET ended_at = ${input.endedAt}
 WHERE org_id = ${input.orgId} AND thread_id = ${input.threadId} AND ended_at IS NULL RETURNING thread_id`;
        return changed.length > 0;
      },
      Effect.mapError(toRepositoryError("KinChatRepository.endAgentThread")),
    ),
  });
});
export const layer = Layer.effect(KinChatRepository, make);
