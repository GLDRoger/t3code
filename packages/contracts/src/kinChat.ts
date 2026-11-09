import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
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
export const KinWaitingId = TrimmedNonEmptyString.pipe(Schema.brand("KinWaitingId"));
export type KinWaitingId = typeof KinWaitingId.Type;
export const KinWakeupId = TrimmedNonEmptyString.pipe(Schema.brand("KinWakeupId"));
export type KinWakeupId = typeof KinWakeupId.Type;

// Markdown keeps its whitespace, so this checks non-blank without trimming.
const isNonBlankBody = Schema.makeFilter((value: string) => value.trim().length > 0, {
  expected: "a non-blank message body",
});

// node:sqlite truncates TEXT results at NUL, even when the full value was stored.
const isNulFree = Schema.makeFilter((value: string) => !value.includes("\u0000"), {
  expected: "text without NUL characters",
});
export const KinText = Schema.String.check(isNulFree);
export const KinTrimmedText = TrimmedNonEmptyString.check(isNulFree);

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
  title: Schema.NullOr(KinTrimmedText),
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
  name: KinTrimmedText,
  createdAt: IsoDateTime,
});
export type KinOrg = typeof KinOrg.Type;
export const KinPerson = Schema.Struct({
  personId: KinPersonId,
  orgId: KinOrgId,
  handle: KinTrimmedText,
  displayName: KinTrimmedText,
  githubLogin: Schema.NullOr(KinTrimmedText),
});
export type KinPerson = typeof KinPerson.Type;
export const KinAgent = Schema.Struct({
  agentId: KinAgentId,
  orgId: KinOrgId,
  displayName: KinTrimmedText,
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
  changeSeq: Schema.optional(NonNegativeInt),
  clientMessageId: Schema.optional(TrimmedNonEmptyString),
  author: KinAuthor,
  authorRole: KinRole,
  kind: KinMessageKind,
  body: KinText,
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
  "choice",
]);
export type KinNativeCardType = typeof KinNativeCardType.Type;

/** The fixed reaction set: two yes, two no, two feelings. */
export const KIN_REACTION_EMOJI = ["👍", "✅", "👎", "❌", "❤️", "👀"] as const;
export const KinReactionEmoji = Schema.Literals(KIN_REACTION_EMOJI);
export type KinReactionEmoji = typeof KinReactionEmoji.Type;
export const KIN_YES_REACTIONS = ["👍", "✅"] as const satisfies ReadonlyArray<KinReactionEmoji>;
export const KIN_NO_REACTIONS = ["👎", "❌"] as const satisfies ReadonlyArray<KinReactionEmoji>;

export const KinReaction = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  messageId: KinMessageId,
  memberId: KinMemberId,
  emoji: KinReactionEmoji,
  createdAt: IsoDateTime,
  // Set when the member withdrew it; stream consumers drop the reaction.
  removedAt: Schema.NullOr(IsoDateTime),
});
export type KinReaction = typeof KinReaction.Type;

export const KinChoiceOption = Schema.Struct({
  optionId: KinTrimmedText.check(Schema.isMaxLength(40)),
  label: KinTrimmedText.check(Schema.isMaxLength(80)),
  // Marks the yes/no pair a 👍/👎 reaction can answer.
  kind: Schema.optional(Schema.Literals(["yes", "no"])),
});
export type KinChoiceOption = typeof KinChoiceOption.Type;
/** A `choice` card's buttons post `actionId: "choose"` with the option id as `value`. */
export const KIN_CHOICE_CARD_ACTION = "choose";
export const KinChoiceCardState = Schema.Struct({
  question: KinTrimmedText.check(Schema.isMaxLength(240)),
  detail: Schema.NullOr(KinText.check(Schema.isMaxLength(2000))),
  options: Schema.Array(KinChoiceOption).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
  // The first answer settles the card.
  answer: Schema.NullOr(
    Schema.Struct({
      optionId: KinTrimmedText,
      personId: KinPersonId,
      via: Schema.Literals(["tap", "reaction"]),
      emoji: Schema.NullOr(KinReactionEmoji),
      answeredAt: IsoDateTime,
    }),
  ),
});
export type KinChoiceCardState = typeof KinChoiceCardState.Type;

export const KinPresenceState = Schema.Literals([
  "seen",
  "starting",
  "thinking",
  "working",
  "writing",
  "stalled",
  "paused",
  "deferred",
]);
export type KinPresenceState = typeof KinPresenceState.Type;
/**
 * One agent's live status line in a chat. Never persisted. Clients render it statically and
 * keep their own elapsed timer from `startedAt` (wake-up start) and `since` (state start; for
 * `stalled`, the last output).
 */
export const KinPresence = Schema.Struct({
  agentId: KinAgentId,
  wakeupId: Schema.NullOr(KinWakeupId),
  state: KinPresenceState,
  // A fixed label ("Checking memory"), a short note from the agent, or a refusal
  // ("Couldn't post: notice limit"), at most 60 characters.
  label: Schema.NullOr(KinText.check(Schema.isMaxLength(60))),
  startedAt: IsoDateTime,
  since: IsoDateTime,
});
export type KinPresence = typeof KinPresence.Type;
/** An agent reply still streaming. `text` in a backlog is the whole draft so far. */
export const KinDraft = Schema.Struct({
  draftId: TrimmedNonEmptyString,
  agentId: KinAgentId,
  text: KinText,
});
export type KinDraft = typeof KinDraft.Type;

export const KinWidget = Schema.Struct({
  orgId: KinOrgId,
  chatId: KinChatId,
  widgetId: KinWidgetId,
  messageId: KinMessageId,
  widgetClass: KinWidgetClass,
  type: KinTrimmedText,
  revision: PositiveInt,
  state: Schema.Unknown,
  source: Schema.NullOr(Schema.Struct({ threadId: ThreadId, itemId: TurnItemId })),
  feed: Schema.NullOr(Schema.Struct({ kind: KinTrimmedText, key: KinTrimmedText })),
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
  title: KinTrimmedText,
  model: Schema.NullOr(KinText),
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
  lastError: Schema.NullOr(KinText),
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
  waitingId: KinWaitingId,
  orgId: KinOrgId,
  personId: KinPersonId,
  chatId: KinChatId,
  messageId: Schema.NullOr(KinMessageId),
  widgetId: Schema.NullOr(KinWidgetId),
  reason: KinWaitingReason,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
  resolution: Schema.NullOr(KinTrimmedText),
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
    lastChangeSeq: Schema.optional(NonNegativeInt),
    // Live reactions on the backlog's messages; absent from servers without reactions.
    reactions: Schema.optional(Schema.Array(KinReaction)),
    presence: Schema.optional(Schema.Array(KinPresence)),
    drafts: Schema.optional(Schema.Array(KinDraft)),
  }),
  Schema.TaggedStruct("reset", {
    lastSeq: NonNegativeInt,
    lastChangeSeq: Schema.optional(NonNegativeInt),
  }),
  Schema.TaggedStruct("message", { message: KinMessage }),
  Schema.TaggedStruct("widget", { widget: KinWidget }),
  Schema.TaggedStruct("member", { member: KinChatMember }),
  Schema.TaggedStruct("read", { memberId: KinMemberId, seq: NonNegativeInt }),
  // Appends `text` at `offset`. A client whose draft length isn't `offset` ignores the
  // deltas until `end`, the durable message, or the next backlog.
  Schema.TaggedStruct("draft", {
    draftId: TrimmedNonEmptyString,
    agentId: KinAgentId,
    offset: NonNegativeInt,
    text: KinText,
    // On the last event: the message it became (sent before this event), or null when the
    // text was not posted. Drop the draft either way.
    end: Schema.optional(Schema.Struct({ messageId: Schema.NullOr(KinMessageId) })),
  }),
  // Sent on state change only; null clears the agent's line.
  Schema.TaggedStruct("presence", { agentId: KinAgentId, presence: Schema.NullOr(KinPresence) }),
  Schema.TaggedStruct("reaction", { reaction: KinReaction }),
]);
export type KinChatStreamEvent = typeof KinChatStreamEvent.Type;

export const KinOrgsListInput = Schema.Struct({});
export type KinOrgsListInput = typeof KinOrgsListInput.Type;
export const KinOrgsListResult = Schema.Struct({
  orgs: Schema.Array(
    Schema.Struct({
      ...KinOrg.fields,
      agents: Schema.Array(
        Schema.Struct({
          agentId: KinAgentId,
          displayName: Schema.String,
          retired: Schema.Boolean,
        }),
      ),
    }),
  ),
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
  afterChangeSeq: Schema.optional(NonNegativeInt),
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
  reactions: Schema.optional(Schema.Array(KinReaction)),
});
export type KinChatHistoryResult = typeof KinChatHistoryResult.Type;
export const KIN_MESSAGE_BODY_MAX_LENGTH = 16_000;
export const KinMessagesSendInput = Schema.Struct({
  chatId: KinChatId,
  clientMessageId: TrimmedNonEmptyString,
  body: KinText.check(isNonBlankBody, Schema.isMaxLength(KIN_MESSAGE_BODY_MAX_LENGTH)),
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
/** Adds (`on: true`) or withdraws the caller's reaction. Agents can't react. */
export const KinMessagesReactInput = Schema.Struct({
  messageId: KinMessageId,
  emoji: KinReactionEmoji,
  on: Schema.Boolean,
});
export type KinMessagesReactInput = typeof KinMessagesReactInput.Type;
/** Owner-only Stop on a wake-up, from its presence line. */
export const KinLeadInterruptInput = Schema.Struct({ orgId: KinOrgId, wakeupId: KinWakeupId });
export type KinLeadInterruptInput = typeof KinLeadInterruptInput.Type;
export const KinLeadInterruptResult = Schema.Struct({
  // False when the wake-up had already ended.
  interrupted: Schema.Boolean,
});
export type KinLeadInterruptResult = typeof KinLeadInterruptResult.Type;

export class KinChatError extends Schema.TaggedError<KinChatError>()("KinChatError", {
  reason: Schema.Literals([
    "not_found",
    "not_allowed",
    "unavailable",
    "disabled",
    "widget_changed",
    "use_approvals",
    "invalid_state",
    "limit",
    "floor_not_granted",
    "floor_closed",
    "conflict",
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
  messagesReact: "kin.messages.react",
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
  Rpc.make(KIN_CHAT_WS_METHODS.messagesReact, {
    payload: KinMessagesReactInput,
    success: KinReaction,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
] as const;

export const KIN_CHAT_RPC_SCOPES = {
  [KIN_CHAT_WS_METHODS.orgsList]: AuthOrchestrationReadScope,
  [KIN_CHAT_WS_METHODS.chatsSubscribe]: AuthOrchestrationReadScope,
  [KIN_CHAT_WS_METHODS.chatsCreateDirect]: AuthOrchestrationOperateScope,
  [KIN_CHAT_WS_METHODS.chatSubscribe]: AuthOrchestrationReadScope,
  [KIN_CHAT_WS_METHODS.chatHistory]: AuthOrchestrationReadScope,
  [KIN_CHAT_WS_METHODS.messagesSend]: AuthOrchestrationOperateScope,
  [KIN_CHAT_WS_METHODS.messagesMarkRead]: AuthOrchestrationReadScope,
  [KIN_CHAT_WS_METHODS.widgetsAct]: AuthOrchestrationOperateScope,
  [KIN_CHAT_WS_METHODS.messagesReact]: AuthOrchestrationOperateScope,
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
