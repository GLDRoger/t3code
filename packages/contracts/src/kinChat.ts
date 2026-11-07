import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "./auth.ts";
import {
  TrimmedNonEmptyString,
  NonNegativeInt,
  PositiveInt,
  IsoDateTime,
  ThreadId,
  EnvironmentId,
  NodeId,
  TurnItemId,
} from "./baseSchemas.ts";

export const KinOrgId = TrimmedNonEmptyString.pipe(Schema.brand("KinOrgId"));
export type KinOrgId = typeof KinOrgId.Type;
export const KinPersonId = TrimmedNonEmptyString.pipe(Schema.brand("KinPersonId"));
export type KinPersonId = typeof KinPersonId.Type;
export const KinAgentId = TrimmedNonEmptyString.pipe(Schema.brand("KinAgentId"));
export type KinAgentId = typeof KinAgentId.Type;
export const KinChatId = TrimmedNonEmptyString.pipe(Schema.brand("KinChatId"));
export type KinChatId = typeof KinChatId.Type;
export const KinMemberId = TrimmedNonEmptyString.pipe(Schema.brand("KinMemberId"));
export type KinMemberId = typeof KinMemberId.Type;
export const KinMessageId = TrimmedNonEmptyString.pipe(Schema.brand("KinMessageId"));
export type KinMessageId = typeof KinMessageId.Type;
export const KinWidgetId = TrimmedNonEmptyString.pipe(Schema.brand("KinWidgetId"));
export type KinWidgetId = typeof KinWidgetId.Type;

export const KinChatKind = Schema.Literals(["direct", "team_group", "project_group", "router"]);
export type KinChatKind = typeof KinChatKind.Type;
export const KinRole = Schema.Literals(["owner", "member", "guest"]);
export type KinRole = typeof KinRole.Type;
export const KinAgentRole = Schema.Literals([
  "lead",
  "architect",
  "builder",
  "qa",
  "release",
  "router",
  "specialist",
]);
export type KinAgentRole = typeof KinAgentRole.Type;

export const KinChat = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  kind: KinChatKind,
  title: Schema.NullOr(TrimmedNonEmptyString),
  teamId: Schema.NullOr(TrimmedNonEmptyString),
  lastSeq: NonNegativeInt,
  lastMessageAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type KinChat = typeof KinChat.Type;

export const KinPrincipal = Schema.Union([
  Schema.TaggedStruct("person", { personId: KinPersonId }),
  Schema.TaggedStruct("agent", { agentId: KinAgentId }),
]);
export type KinPrincipal = typeof KinPrincipal.Type;

export const KinChatMember = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  memberId: KinMemberId,
  principal: KinPrincipal,
  role: KinRole,
  joinedAt: IsoDateTime,
  leftAt: Schema.NullOr(IsoDateTime),
  mutedUntil: Schema.NullOr(IsoDateTime),
});
export type KinChatMember = typeof KinChatMember.Type;

export const KinOrg = Schema.Struct({
  orgId: KinOrgId,
  name: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type KinOrg = typeof KinOrg.Type;
export const KinPerson = Schema.Struct({
  personId: KinPersonId,
  orgId: KinOrgId,
  handle: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  githubLogin: Schema.optional(TrimmedNonEmptyString),
});
export type KinPerson = typeof KinPerson.Type;
export const KinAgent = Schema.Struct({
  agentId: KinAgentId,
  orgId: KinOrgId,
  displayName: TrimmedNonEmptyString,
  role: KinAgentRole,
  ownerPersonId: KinPersonId,
});
export type KinAgent = typeof KinAgent.Type;

export const KinAuthor = Schema.Union([
  Schema.TaggedStruct("human", { personId: KinPersonId, memberId: KinMemberId }),
  Schema.TaggedStruct("agent", {
    agentId: KinAgentId,
    memberId: KinMemberId,
    ownerPersonId: KinPersonId,
    threadId: ThreadId,
  }),
  Schema.TaggedStruct("system", {}),
]);
export type KinAuthor = typeof KinAuthor.Type;

export const KinAgentIntent = Schema.Literals([
  "answer",
  "evidence",
  "objection",
  "decision",
  "question",
]);
export type KinAgentIntent = typeof KinAgentIntent.Type;
export const KinMessageKind = Schema.Literals(["text", "widget_action", "system"]);
export type KinMessageKind = typeof KinMessageKind.Type;
export const KinMessageStatus = Schema.Literals(["posted", "suggested", "dismissed", "deleted"]);
export type KinMessageStatus = typeof KinMessageStatus.Type;

export const KinMessage = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  messageId: KinMessageId,
  seq: PositiveInt,
  author: KinAuthor,
  authorRole: KinRole,
  kind: KinMessageKind,
  body: Schema.String,
  intent: Schema.NullOr(KinAgentIntent),
  mentions: Schema.Array(KinMemberId),
  replyTo: Schema.NullOr(KinMessageId),
  widgetId: Schema.NullOr(KinWidgetId),
  floorRunId: Schema.NullOr(TrimmedNonEmptyString),
  status: KinMessageStatus,
  sentBy: Schema.NullOr(KinPersonId),
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
});
export type KinMessage = typeof KinMessage.Type;

export const KinWidgetClass = Schema.Literals(["native", "generated", "live"]);
export type KinWidgetClass = typeof KinWidgetClass.Type;
export const KinNativeCardType = Schema.Literals([
  "approval",
  "decision",
  "task",
  "deferral",
  "poll",
  "checklist",
  "form",
  "date",
]);
export type KinNativeCardType = typeof KinNativeCardType.Type;

export const KinWidget = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  widgetId: KinWidgetId,
  messageId: KinMessageId,
  widgetClass: KinWidgetClass,
  type: TrimmedNonEmptyString,
  revision: PositiveInt,
  state: Schema.Unknown,
  source: Schema.NullOr(Schema.Struct({ threadId: ThreadId, itemId: TurnItemId })),
  feed: Schema.NullOr(Schema.Struct({ kind: TrimmedNonEmptyString, key: TrimmedNonEmptyString })),
  awaiting: Schema.Array(KinPersonId),
  pinnedAt: Schema.NullOr(IsoDateTime),
  closedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type KinWidget = typeof KinWidget.Type;

export const KinTaskCardState = Schema.Struct({
  taskId: NodeId,
  environmentId: EnvironmentId,
  threadId: Schema.NullOr(ThreadId),
  remoteEnvironmentId: Schema.NullOr(EnvironmentId),
  title: TrimmedNonEmptyString,
  model: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "working",
    "waiting",
    "needs_decision",
    "blocked",
    "done",
    "failed",
    "cancelled",
  ]),
  pullRequests: Schema.Array(Schema.Struct({ url: Schema.String, number: Schema.Int })),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type KinTaskCardState = typeof KinTaskCardState.Type;

export const KinWaitingReason = Schema.Literals([
  "approval",
  "decision",
  "question",
  "suggestion",
  "mention",
]);
export type KinWaitingReason = typeof KinWaitingReason.Type;
export const KinWaitingItem = Schema.Struct({
  waitingId: TrimmedNonEmptyString,
  orgId: KinOrgId,
  personId: KinPersonId,
  chatId: KinChatId,
  messageId: Schema.NullOr(KinMessageId),
  widgetId: Schema.NullOr(KinWidgetId),
  reason: KinWaitingReason,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolution: Schema.NullOr(TrimmedNonEmptyString),
});
export type KinWaitingItem = typeof KinWaitingItem.Type;
export const KinChatSummary = Schema.Struct({
  ...KinChat.fields,
  members: Schema.Array(KinChatMember),
  lastMessage: Schema.NullOr(KinMessage),
  unread: NonNegativeInt,
});
export type KinChatSummary = typeof KinChatSummary.Type;

export const KinChatListEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", {
    chats: Schema.Array(KinChatSummary),
    waiting: Schema.Array(KinWaitingItem),
  }),
  Schema.TaggedStruct("chat", { chat: KinChatSummary }),
  Schema.TaggedStruct("waiting", { item: KinWaitingItem }),
]);
export type KinChatListEvent = typeof KinChatListEvent.Type;

export const KinChatStreamEvent = Schema.Union([
  Schema.TaggedStruct("backlog", {
    messages: Schema.Array(KinMessage),
    widgets: Schema.Array(KinWidget),
    lastSeq: NonNegativeInt,
  }),
  Schema.TaggedStruct("reset", { lastSeq: NonNegativeInt }),
  Schema.TaggedStruct("message", { message: KinMessage }),
  Schema.TaggedStruct("widget", { widget: KinWidget }),
  Schema.TaggedStruct("member", { member: KinChatMember }),
  Schema.TaggedStruct("read", { memberId: KinMemberId, seq: NonNegativeInt }),
]);
export type KinChatStreamEvent = typeof KinChatStreamEvent.Type;

export const KinOrgsListInput = Schema.Struct({});
export type KinOrgsListInput = typeof KinOrgsListInput.Type;
export const KinOrgsListResult = Schema.Struct({
  orgs: Schema.Array(KinOrg),
  me: Schema.Array(Schema.Struct({ orgId: KinOrgId, personId: KinPersonId })),
});
export type KinOrgsListResult = typeof KinOrgsListResult.Type;
export const KinChatsSubscribeInput = Schema.Struct({ orgId: Schema.optional(KinOrgId) });
export type KinChatsSubscribeInput = typeof KinChatsSubscribeInput.Type;
export const KinChatsCreateDirectInput = Schema.Struct({ orgId: KinOrgId, agentId: KinAgentId });
export type KinChatsCreateDirectInput = typeof KinChatsCreateDirectInput.Type;
export const KinChatSubscribeInput = Schema.Struct({
  chatId: KinChatId,
  afterSeq: Schema.optional(NonNegativeInt),
});
export type KinChatSubscribeInput = typeof KinChatSubscribeInput.Type;
export const KinChatHistoryInput = Schema.Struct({
  chatId: KinChatId,
  beforeSeq: PositiveInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
});
export type KinChatHistoryInput = typeof KinChatHistoryInput.Type;
export const KinChatHistoryResult = Schema.Struct({
  messages: Schema.Array(KinMessage),
  widgets: Schema.Array(KinWidget),
  hasMore: Schema.Boolean,
});
export type KinChatHistoryResult = typeof KinChatHistoryResult.Type;
export const KinMessagesSendInput = Schema.Struct({
  chatId: KinChatId,
  clientMessageId: TrimmedNonEmptyString,
  body: Schema.String.check(Schema.isMaxLength(16_000)),
  mentions: Schema.optional(Schema.Array(KinMemberId)),
  replyTo: Schema.optional(KinMessageId),
});
export type KinMessagesSendInput = typeof KinMessagesSendInput.Type;
export const KinMessagesMarkReadInput = Schema.Struct({ chatId: KinChatId, seq: NonNegativeInt });
export type KinMessagesMarkReadInput = typeof KinMessagesMarkReadInput.Type;
export const KinMessagesMarkReadResult = Schema.Struct({});
export type KinMessagesMarkReadResult = typeof KinMessagesMarkReadResult.Type;
export const KinWidgetsActInput = Schema.Struct({
  widgetId: KinWidgetId,
  revision: PositiveInt,
  actionId: TrimmedNonEmptyString,
  value: Schema.optional(Schema.Unknown),
  clientActionId: TrimmedNonEmptyString,
});
export type KinWidgetsActInput = typeof KinWidgetsActInput.Type;

export class KinChatError extends Schema.TaggedError<KinChatError>()("KinChatError", {
  reason: Schema.Literals([
    "not_found",
    "not_allowed",
    "widget_changed",
    "use_approvals",
    "invalid_state",
    "limit",
    "floor_not_granted",
    "floor_closed",
  ]),
  message: Schema.String,
}) {}

export const KIN_CHAT_WS_METHODS = {
  orgsList: "kin.orgs.list",
  chatsSubscribe: "kin.chats.subscribe",
  chatsCreateDirect: "kin.chats.createDirect",
  chatSubscribe: "kin.chat.subscribe",
  chatHistory: "kin.chat.history",
  messagesSend: "kin.messages.send",
  messagesMarkRead: "kin.messages.markRead",
  widgetsAct: "kin.widgets.act",
} as const;

export const KinChatRpcs = [
  Rpc.make(KIN_CHAT_WS_METHODS.orgsList, {
    payload: KinOrgsListInput,
    success: KinOrgsListResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatsSubscribe, {
    payload: KinChatsSubscribeInput,
    success: KinChatListEvent,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatsCreateDirect, {
    payload: KinChatsCreateDirectInput,
    success: KinChat,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatSubscribe, {
    payload: KinChatSubscribeInput,
    success: KinChatStreamEvent,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
    stream: true,
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatHistory, {
    payload: KinChatHistoryInput,
    success: KinChatHistoryResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.messagesSend, {
    payload: KinMessagesSendInput,
    success: KinMessage,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.messagesMarkRead, {
    payload: KinMessagesMarkReadInput,
    success: KinMessagesMarkReadResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.widgetsAct, {
    payload: KinWidgetsActInput,
    success: KinMessage,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_CHAT_RPC_SCOPES = {
  [KIN_CHAT_WS_METHODS.orgsList]: "orchestration:read",
  [KIN_CHAT_WS_METHODS.chatsSubscribe]: "orchestration:read",
  [KIN_CHAT_WS_METHODS.chatsCreateDirect]: "orchestration:operate",
  [KIN_CHAT_WS_METHODS.chatSubscribe]: "orchestration:read",
  [KIN_CHAT_WS_METHODS.chatHistory]: "orchestration:read",
  [KIN_CHAT_WS_METHODS.messagesSend]: "orchestration:operate",
  [KIN_CHAT_WS_METHODS.messagesMarkRead]: "orchestration:read",
  [KIN_CHAT_WS_METHODS.widgetsAct]: "orchestration:operate",
} as const satisfies Record<
  (typeof KIN_CHAT_WS_METHODS)[keyof typeof KIN_CHAT_WS_METHODS],
  AuthEnvironmentScope
>;

export const kinMessageLink = ({
  orgId,
  chatId,
  messageId,
}: {
  orgId: KinOrgId;
  chatId: KinChatId;
  messageId: KinMessageId;
}) => `kin-chat://${orgId}/${chatId}/${messageId}`;
