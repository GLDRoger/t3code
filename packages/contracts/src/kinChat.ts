import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthKinChatScope,
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
import {
  ChatFileAttachment,
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";

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

// Markdown keeps its whitespace, so this checks blank without trimming.
const isBlankBody = (value: string) => value.trim().length === 0;
const isNonBlankBody = Schema.makeFilter((value: string) => !isBlankBody(value), {
  expected: "a non-blank message body",
});

// node:sqlite truncates TEXT results at NUL, even when the full value was stored.
const isNulFree = Schema.makeFilter((value: string) => !value.includes("\u0000"), {
  expected: "text without NUL characters",
});
export const KinText = Schema.String.check(isNulFree);
export const KinTrimmedText = TrimmedNonEmptyString.check(isNulFree);
const isPlainLine = Schema.makeFilter((value: string) => !/\p{Cc}/u.test(value), {
  expected: "text without control characters",
});
/** A name or label shown to clients and in agents' prompts: one line, no control characters. */
export const KinLabelText = KinTrimmedText.check(isPlainLine);

/** A doc section's id: its heading as a slug, unique in the doc; `top` is the text before any. */
export const KinDocSectionId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/));
export type KinDocSectionId = typeof KinDocSectionId.Type;
// Docs' keys, such as `D-12`; `KinRecordKey` lives in kinWork, which imports this file.
const KinRefKey = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}$/));
/** What a person points at from the composer: a doc, or one section of it, at a version. */
export const KinMessageRefInput = Schema.TaggedStruct("doc", {
  key: KinRefKey,
  version: PositiveInt,
  section: Schema.NullOr(KinDocSectionId),
});
export type KinMessageRefInput = typeof KinMessageRefInput.Type;
/** A stored reference, with the titles the host read when it was sent, for the quote chip. */
export const KinMessageRef = Schema.TaggedStruct("doc", {
  ...KinMessageRefInput.fields,
  title: KinTrimmedText,
  sectionTitle: Schema.NullOr(KinText),
});
export type KinMessageRef = typeof KinMessageRef.Type;
export const KIN_MESSAGE_REFS_CAP = 5;

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
  // A group's lead, who answers a message that names nobody. Absent from servers without groups.
  leadAgentId: Schema.optional(Schema.NullOr(KinAgentId)),
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

const { source: _imageSource, ...kinImageAttachmentFields } = ChatImageAttachment.fields;
const { source: _fileSource, ...kinFileAttachmentFields } = ChatFileAttachment.fields;
/**
 * A file stored by the thread composer's upload path. A message carries the reference and size,
 * never the bytes; clients read it the way a thread reads its own attachments.
 */
export const KinAttachment = Schema.Union([
  Schema.Struct(kinImageAttachmentFields),
  Schema.Struct(kinFileAttachmentFields),
]);
export type KinAttachment = typeof KinAttachment.Type;

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
  // Absent on a message without files, so those stay the size they were.
  attachments: Schema.optional(Schema.Array(KinAttachment)),
  // Absent on a message that points at nothing.
  refs: Schema.optional(Schema.Array(KinMessageRef)),
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

/** The one reaction set: what a person's menu offers and what a lead may react with. */
export const KIN_REACTION_EMOJI = [
  "👍",
  "✅",
  "👎",
  "❌",
  "❤️",
  "👀",
  "😂",
  "🎉",
  "😮",
  "🔥",
  "🙏",
  "😢",
  "💯",
] as const;
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
/**
 * An unanswered choice card stops taking taps this long after it was posted (its revision-1
 * `updatedAt`): the same day-long window after which Kin stops waking a lead for old messages.
 */
export const KIN_CHOICE_CARD_TTL_MS = 24 * 60 * 60 * 1000;
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
  // Older servers only; clients show no line for it.
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
  // What the agent is doing, from the server's fixed table ("Reading memory", "Setting a
  // reminder") or a refusal ("Couldn't post: limit"); never model or user text. At most 60.
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
  /** The docs a document job filed; the card opens them once it is done. */
  documents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        recordId: TrimmedNonEmptyString,
        key: TrimmedNonEmptyString,
        title: KinTrimmedText,
      }),
    ),
  ),
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
  // A direct chat's two members. A group's row carries only the viewer's own, with `leftAt` set
  // once they are no longer in it; `kin.chat.members` lists the rest.
  members: Schema.Array(KinChatMember),
  lastMessage: Schema.NullOr(KinMessage),
  // In a group, the person who wrote `lastMessage`, when it wasn't the viewer.
  lastAuthorName: Schema.optional(KinTrimmedText),
  unread: NonNegativeInt,
  /** An agent in the chat is on a live wake-up. Absent from servers without it. */
  working: Schema.optional(Schema.Boolean),
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
    // The chat's `lastSeq` when it was last cleared: no message is at or below it. Absent
    // when it never was.
    clearedSeq: Schema.optional(NonNegativeInt),
    // Live reactions on the backlog's messages; absent from servers without reactions.
    reactions: Schema.optional(Schema.Array(KinReaction)),
    presence: Schema.optional(Schema.Array(KinPresence)),
    drafts: Schema.optional(Schema.Array(KinDraft)),
  }),
  Schema.TaggedStruct("reset", {
    lastSeq: NonNegativeInt,
    lastChangeSeq: Schema.optional(NonNegativeInt),
    // The chat was cleared: nothing held from before is kept, drafts and reactions included.
    cleared: Schema.optional(Schema.Boolean),
    clearedSeq: Schema.optional(NonNegativeInt),
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
export const KIN_GROUP_TITLE_MAX_LENGTH = 60;
export const KIN_GROUP_MAX_MEMBERS = 50;
export const KinGroupTitle = KinTrimmedText.check(Schema.isMaxLength(KIN_GROUP_TITLE_MAX_LENGTH));
/** A new group: its name and who is in it besides the owner. The first lead listed leads it. */
export const KinChatsCreateGroupInput = Schema.Struct({
  orgId: KinOrgId,
  title: KinGroupTitle,
  agentIds: Schema.Array(KinAgentId).check(Schema.isMaxLength(KIN_GROUP_MAX_MEMBERS)),
  personIds: Schema.Array(KinPersonId).check(Schema.isMaxLength(KIN_GROUP_MAX_MEMBERS)),
});
export type KinChatsCreateGroupInput = typeof KinChatsCreateGroupInput.Type;
export const KinChatMembersInput = Schema.Struct({ chatId: KinChatId });
export type KinChatMembersInput = typeof KinChatMembersInput.Type;
/** Who is in a chat, by name: what a group draws its authors, mentions and details from. */
export const KinChatMembersResult = Schema.Struct({
  chat: KinChat,
  members: Schema.Array(Schema.Struct({ ...KinChatMember.fields, displayName: KinTrimmedText })),
});
export type KinChatMembersResult = typeof KinChatMembersResult.Type;
export const KinGroupAddMemberInput = Schema.Struct({ chatId: KinChatId, principal: KinPrincipal });
export type KinGroupAddMemberInput = typeof KinGroupAddMemberInput.Type;
export const KinGroupRemoveMemberInput = Schema.Struct({
  chatId: KinChatId,
  memberId: KinMemberId,
});
export type KinGroupRemoveMemberInput = typeof KinGroupRemoveMemberInput.Type;
export const KinGroupSetLeadInput = Schema.Struct({ chatId: KinChatId, agentId: KinAgentId });
export type KinGroupSetLeadInput = typeof KinGroupSetLeadInput.Type;
export const KinGroupRenameInput = Schema.Struct({ chatId: KinChatId, title: KinGroupTitle });
export type KinGroupRenameInput = typeof KinGroupRenameInput.Type;
export const KinGroupDeleteInput = Schema.Struct({ chatId: KinChatId });
export type KinGroupDeleteInput = typeof KinGroupDeleteInput.Type;
export const KinGroupDone = Schema.Struct({});
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
/** What an agent may post: text, always. Only a person's message can be files alone. */
export const KinAgentMessageBody = KinText.check(
  isNonBlankBody,
  Schema.isMaxLength(KIN_MESSAGE_BODY_MAX_LENGTH),
);
export const KinMessagesSendInput = Schema.Struct({
  chatId: KinChatId,
  clientMessageId: TrimmedNonEmptyString,
  body: KinText.check(Schema.isMaxLength(KIN_MESSAGE_BODY_MAX_LENGTH)),
  // Uploads still pending from `attachments.createUploadUrl`; the host claims them for the chat.
  attachments: Schema.optional(
    Schema.Array(KinAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  mentions: Schema.optional(Schema.Array(KinMemberId)),
  replyTo: Schema.optional(KinMessageId),
  /** Doc sections the message is about; the host quotes their text to the agent. Owner only. */
  refs: Schema.optional(
    Schema.Array(KinMessageRefInput).check(Schema.isMaxLength(KIN_MESSAGE_REFS_CAP)),
  ),
}).check(
  Schema.makeFilter(
    (input: {
      readonly body: string;
      readonly attachments?: ReadonlyArray<unknown> | undefined;
    }) =>
      isBlankBody(input.body) && (input.attachments?.length ?? 0) === 0
        ? "a message needs text or an attachment"
        : undefined,
  ),
);
export type KinMessagesSendInput = typeof KinMessagesSendInput.Type;
export const KinMessagesMarkReadInput = Schema.Struct({ chatId: KinChatId, seq: NonNegativeInt });
export type KinMessagesMarkReadInput = typeof KinMessagesMarkReadInput.Type;
export const KinMessagesMarkReadResult = Schema.Struct({});
/** Mutes or unmutes the caller's own notifications for one chat; the badge still counts it. */
export const KinChatsMuteInput = Schema.Struct({ chatId: KinChatId, muted: Schema.Boolean });
export type KinChatsMuteInput = typeof KinChatsMuteInput.Type;
export type KinMessagesMarkReadResult = typeof KinMessagesMarkReadResult.Type;
/**
 * Empties a chat for everyone in it, for good: its messages, cards, reactions and files. The chat,
 * its members and what its leads remember stay, and so do files a doc uses. A group's owner, or
 * the one person in a direct chat with a lead, may. `preview` changes nothing and says what stays.
 */
export const KinChatsClearInput = Schema.Struct({
  chatId: KinChatId,
  preview: Schema.optional(Schema.Boolean),
});
export type KinChatsClearInput = typeof KinChatsClearInput.Type;
/** `keptFiles`: the chat's files that stay because a doc uses them. Absent from older servers. */
export const KinChatsClearResult = Schema.Struct({ keptFiles: Schema.optional(NonNegativeInt) });
export type KinChatsClearResult = typeof KinChatsClearResult.Type;
export const KinWidgetsActInput = Schema.Struct({
  widgetId: KinWidgetId,
  revision: PositiveInt,
  actionId: TrimmedNonEmptyString,
  value: Schema.optional(Schema.Unknown),
  clientActionId: TrimmedNonEmptyString,
});
export type KinWidgetsActInput = typeof KinWidgetsActInput.Type;
/** Adds (`on: true`) or withdraws the caller's reaction. A lead reacts only through `kin_react`. */
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
    // The org has no lead yet to copy models from, and the request named none.
    "no_models",
  ]),
  message: Schema.String,
}) {}

export const KIN_CHAT_WS_METHODS = {
  orgsList: "kin.orgs.list",
  chatsSubscribe: "kin.chats.subscribe",
  chatsCreateDirect: "kin.chats.createDirect",
  chatsMute: "kin.chats.mute",
  chatsClear: "kin.chats.clear",
  chatMembers: "kin.chat.members",
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
  Rpc.make(KIN_CHAT_WS_METHODS.chatsMute, {
    payload: KinChatsMuteInput,
    success: KinChatMember,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatsClear, {
    payload: KinChatsClearInput,
    success: KinChatsClearResult,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatMembers, {
    payload: KinChatMembersInput,
    success: KinChatMembersResult,
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

// Chat is what a member's `kin:chat`-only session may use; membership is checked per chat.
export const KIN_CHAT_RPC_SCOPES = {
  [KIN_CHAT_WS_METHODS.orgsList]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.chatsSubscribe]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.chatsCreateDirect]: AuthKinChatScope,
  // Only quiets the caller's own pushes, like marking a chat read.
  [KIN_CHAT_WS_METHODS.chatsMute]: AuthKinChatScope,
  // A teammate clears their own direct chat with a lead, so chat access reaches the method; the
  // chat service decides per chat, and refuses a group to anyone but the owner.
  [KIN_CHAT_WS_METHODS.chatsClear]: AuthKinChatScope,
  // Names of the people and leads in a chat the caller is in.
  [KIN_CHAT_WS_METHODS.chatMembers]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.chatSubscribe]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.chatHistory]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.messagesSend]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.messagesMarkRead]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.widgetsAct]: AuthKinChatScope,
  [KIN_CHAT_WS_METHODS.messagesReact]: AuthKinChatScope,
} as const satisfies Record<
  (typeof KIN_CHAT_WS_METHODS)[keyof typeof KIN_CHAT_WS_METHODS],
  AuthEnvironmentScope
>;

const KinGroupError = Schema.Union([KinChatError, EnvironmentAuthorizationError]);
/** Owner only: making a group and changing who is in it, who leads it and what it is called. */
export const KinGroupRpcs = [
  Rpc.make("kin.groups.create", {
    payload: KinChatsCreateGroupInput,
    success: KinChat,
    error: KinGroupError,
  }),
  Rpc.make("kin.groups.addMember", {
    payload: KinGroupAddMemberInput,
    success: KinChatMember,
    error: KinGroupError,
  }),
  Rpc.make("kin.groups.removeMember", {
    payload: KinGroupRemoveMemberInput,
    success: KinGroupDone,
    error: KinGroupError,
  }),
  Rpc.make("kin.groups.setLead", {
    payload: KinGroupSetLeadInput,
    success: KinChat,
    error: KinGroupError,
  }),
  Rpc.make("kin.groups.rename", {
    payload: KinGroupRenameInput,
    success: KinChat,
    error: KinGroupError,
  }),
  Rpc.make("kin.groups.delete", {
    payload: KinGroupDeleteInput,
    success: KinGroupDone,
    error: KinGroupError,
  }),
] as const;

export const kinMessageLink = ({
  orgId,
  chatId,
  messageId,
}: {
  orgId: KinOrgId;
  chatId: KinChatId;
  messageId: KinMessageId;
}) => `kin-chat://${orgId}/${chatId}/${messageId}`;
