import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthKinChatScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import {
  TrimmedNonEmptyString,
  KinTrimmedText,
  KinText,
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
import { KinEmbed, KIN_MESSAGE_FIGURES_MAX } from "./kinEmbed.ts";
export { KinText, KinTrimmedText } from "./baseSchemas.ts";
import { TimeZone } from "./kinTime.ts";

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
/** A Team room discussion, such as `TD-3`. */
export const KinDiscussionId = Schema.String.check(Schema.isPattern(/^TD-[1-9]\d{0,8}$/)).pipe(
  Schema.brand("KinDiscussionId"),
);
export type KinDiscussionId = typeof KinDiscussionId.Type;

// Markdown keeps its whitespace, so this checks blank without trimming.
const isBlankBody = (value: string) => value.trim().length === 0;
const isNonBlankBody = Schema.makeFilter((value: string) => !isBlankBody(value), {
  expected: "a non-blank message body",
});

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

/** The sheet an entry opens in. */
const KinRecordLinkKind = Schema.Literals(["task", "client", "project", "doc", "entry"]);
/** Where a name in a message goes: a chat, a teammate's profile, an entry by its key, or Settings. */
export const KinMessageLinkTarget = Schema.Union([
  Schema.TaggedStruct("chat", { chatId: TrimmedNonEmptyString }),
  Schema.TaggedStruct("person", { personId: TrimmedNonEmptyString }),
  Schema.TaggedStruct("record", {
    key: KinRefKey,
    kind: KinRecordLinkKind,
  }),
  Schema.TaggedStruct("settings", {}),
]);
export type KinMessageLinkTarget = typeof KinMessageLinkTarget.Type;
/**
 * Text in a message that names something this reader may open, worked out by the host for each
 * reader. `note` is the entry's one line, such as "Logo files · Open".
 */
export const KinMessageLink = Schema.Struct({
  text: KinTrimmedText,
  to: KinMessageLinkTarget,
  note: Schema.NullOr(KinText),
  /** Where `text` is an entry's key: what this reader calls it (its number, else its title). */
  name: Schema.optional(KinTrimmedText),
});
export type KinMessageLink = typeof KinMessageLink.Type;
export const KIN_MESSAGE_LINKS_CAP = 24;

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
  // `KIN_COMPANY_CHAT_TEAM_ID` on the company chat while it is on.
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
  // When this member pinned the chat to the top of their list; absent when it isn't pinned.
  pinnedAt: Schema.optionalKey(IsoDateTime),
});
export type KinChatMember = typeof KinChatMember.Type;

export const KinOrg = Schema.Struct({
  orgId: KinOrgId,
  name: KinTrimmedText,
  createdAt: IsoDateTime,
});
export type KinOrg = typeof KinOrg.Type;
/** What a person is in the company. Owner and co-owner are owner-level; a member is a teammate. */
export const KIN_PERSON_ACCESS = ["owner", "co_owner", "member"] as const;
export const KinPersonAccess = Schema.Literals(KIN_PERSON_ACCESS);
export type KinPersonAccess = typeof KinPersonAccess.Type;
export const kinOwnerLevel = (access: KinPersonAccess | undefined) =>
  access === "owner" || access === "co_owner";

/** A word for what someone does, such as tech, design or sales: a short lowercase slug. */
export const KinRoleTag = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,23}$/));
export const KIN_ROLE_TAGS_MAX = 6;
export const KinRoleTags = Schema.Array(KinRoleTag).check(Schema.isMaxLength(KIN_ROLE_TAGS_MAX));
export type KinRoleTags = typeof KinRoleTags.Type;
export const KinPerson = Schema.Struct({
  personId: KinPersonId,
  orgId: KinOrgId,
  handle: KinTrimmedText,
  displayName: KinTrimmedText,
  githubLogin: Schema.NullOr(KinTrimmedText),
  // Absent from a host older than kinds.
  access: Schema.optional(KinPersonAccess),
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

/** Longest reason an agent gives when it takes a message back; people read it in the chat. */
export const KIN_WITHDRAW_WHY_MAX = 80;
/**
 * An agent's message it took back before anyone in the chat read it, kept and shown as one line
 * (`status` is "deleted", so an older client draws "Message deleted"). `said` is the original
 * text, sent to the owner and co-owners only.
 */
export const KinMessageWithdrawn = Schema.Struct({
  why: KinText.check(Schema.isMaxLength(KIN_WITHDRAW_WHY_MAX)),
  at: IsoDateTime,
  said: Schema.optional(KinText),
});
export type KinMessageWithdrawn = typeof KinMessageWithdrawn.Type;

/**
 * A message one agent sent into another's chat (`sent_by`, drawn on the viewer's side as "Sent by
 * <agent>", as a T3 thread draws a message from another thread), or the answer carried back to the
 * agent that asked (`reply_from`, a small callout naming who replied).
 */
export const KinMessageRelay = Schema.Struct({
  kind: Schema.Literals(["sent_by", "reply_from"]),
  agentId: KinAgentId,
  /**
   * A person's words an agent passed on to another person (`kin_relay`): the agent's own message
   * in the receiver's chat, drawn as "Sent by <person>, via <agent>". Absent on agent-to-agent rows.
   */
  personId: Schema.optional(KinPersonId),
  /** Their name when it was passed on, so any reader can say whose words these are. */
  personName: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  /**
   * What the sending agent's turn had read from outside (a mail, a web page) before it sent this,
   * as a person reads it: the words follow that text, not only the asker's own. Absent otherwise.
   */
  afterReading: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});
export type KinMessageRelay = typeof KinMessageRelay.Type;

/**
 * A person's own words Kin posted again in another of their chats (`kin_hand_off`): the agent
 * that passed them on, and the chat and message they were first written in. Never a person's send.
 */
export const KinMessageOrigin = Schema.Struct({
  agentId: KinAgentId,
  chatId: KinChatId,
  messageId: KinMessageId,
});
export type KinMessageOrigin = typeof KinMessageOrigin.Type;

/**
 * A time the body names, such as when a held message arrives: `text` is how the body writes it,
 * on `zone`'s clock. A client puts the reader's own clock in its place (`kinMessageBody`).
 */
export const KinMessageWhen = Schema.Struct({
  at: IsoDateTime,
  zone: TimeZone,
  text: TrimmedNonEmptyString,
  /** Whose clock `zone` is, when it is a person's: "Zoya Sheikh". */
  of: Schema.optional(TrimmedNonEmptyString),
});
export type KinMessageWhen = typeof KinMessageWhen.Type;

export const KIN_TURN_CHANGES_SHOWN = 5;
/**
 * One record change an agent's wake-up made, as the reader may see it. `what` is Kin's own short
 * phrase ("given to Finance"); `change` is what `kin.lead.undoChange` takes with the org.
 */
export const KinTurnChange = Schema.Struct({
  key: KinRefKey,
  // Absent from an older host.
  kind: Schema.optional(KinRecordLinkKind),
  /** A contact's client, whose page lists it, when this reader sees it; absent from an older host. */
  party: Schema.optional(KinRefKey),
  title: Schema.String,
  what: Schema.String,
  change: Schema.Struct({ agentId: KinAgentId, seq: PositiveInt }),
  // This reader may put it back now; false for a teammate, and once undone or changed since.
  undoable: Schema.Boolean,
  undone: Schema.Boolean,
});
export type KinTurnChange = typeof KinTurnChange.Type;
/** What one wake-up changed, oldest first: `count` of them this reader sees, `more` not listed. */
export const KinTurnChanges = Schema.Struct({
  count: NonNegativeInt,
  items: Schema.Array(KinTurnChange).check(Schema.isMaxLength(KIN_TURN_CHANGES_SHOWN)),
  more: NonNegativeInt,
});
export type KinTurnChanges = typeof KinTurnChanges.Type;

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
  // What this reader may open from the text; absent when it names nothing they can.
  links: Schema.optional(Schema.Array(KinMessageLink)),
  embeds: Schema.optional(
    Schema.Array(KinEmbed).check(Schema.isMaxLength(KIN_MESSAGE_FIGURES_MAX)),
  ),
  // An agent's check-in or weekly brief, drawn as one; absent on everything else.
  form: Schema.optional(Schema.Literal("brief")),
  intent: Schema.NullOr(KinAgentIntent),
  mentions: Schema.Array(KinMemberId),
  replyTo: Schema.NullOr(KinMessageId),
  widgetId: Schema.NullOr(KinWidgetId),
  floorRunId: Schema.NullOr(TrimmedNonEmptyString),
  status: KinMessageStatus,
  sentBy: Schema.NullOr(KinPersonId),
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
  // The Team room discussion it is part of, or an outcome or row that links to. Absent elsewhere.
  discussionId: Schema.optional(KinDiscussionId),
  // With `discussionId`: whether that discussion is still going, as of reading. Absent from
  // older hosts.
  discussionOpen: Schema.optional(Schema.Boolean),
  // Absent on a message no agent sent across.
  relay: Schema.optional(KinMessageRelay),
  // Absent on everything but a person's words Kin passed on for them.
  origin: Schema.optional(KinMessageOrigin),
  // Absent on a message that names no time.
  when: Schema.optional(KinMessageWhen),
  // An agent's reply from a wake-up, for each reader; absent on every other message.
  turnChanges: Schema.optional(KinTurnChanges),
  // Absent on every message its agent didn't take back.
  withdrawn: Schema.optional(KinMessageWithdrawn),
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
  /** Set by the server when a tap on this option runs a fixed action: what it does, in its words. */
  action: Schema.optionalKey(Schema.Struct({ line: KinText.check(Schema.isMaxLength(200)) })),
});
export type KinChoiceOption = typeof KinChoiceOption.Type;
/**
 * What the server adds to a choice card's `detail` for options that run an action, so a client
 * that doesn't know `action` still shows each line; one that does shows them under the options.
 */
export const kinChoiceActionNote = (options: ReadonlyArray<KinChoiceOption>) => {
  const lines = options.flatMap((option) =>
    option.action === undefined ? [] : [`${option.label}: ${option.action.line}`],
  );
  return lines.length === 0 ? "" : lines.join("\n");
};
/** A `choice` card's buttons post `actionId: "choose"` with the option id as `value`. */
export const KIN_CHOICE_CARD_ACTION = "choose";
/**
 * Closes an open choice card without choosing, for the person it asks; posts nothing in the chat.
 * A Confirm card for something leaving the company (`send`) is never dismissed.
 */
export const KIN_CHOICE_DISMISS_ACTION = "dismiss";
/** The dismisser's Undo: the card opens again as it was while nothing else closed its question. */
export const KIN_CHOICE_UNDISMISS_ACTION = "undismiss";
/**
 * An unanswered choice card stops taking taps this long after it was posted (its revision-1
 * `updatedAt`): the same day-long window after which Kin stops waking a lead for old messages.
 */
export const KIN_CHOICE_CARD_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * What an "Ask me" call to a connection would send, in full, as the owner's Confirm will send
 * it. `outcome` is set by the server after the tap: sending, then sent or failed with a reason.
 */
/** One try at a mail: the ask that sent it, and when it ended. */
export const KinSendTry = Schema.Struct({
  tryId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  at: IsoDateTime,
});
export type KinSendTry = typeof KinSendTry.Type;
export const KinSendCard = Schema.Struct({
  service: KinTrimmedText.check(Schema.isMaxLength(80)),
  action: Schema.Literals(["email", "reply", "event", "call"]),
  /** The address it goes from; on cards from before accounts, the signed-in account. */
  from: Schema.NullOr(KinText.check(Schema.isMaxLength(320))),
  /** The From name shown beside the address, such as "Ana Rao". */
  fromName: Schema.optionalKey(Schema.NullOr(KinText.check(Schema.isMaxLength(200)))),
  /** The connected account it goes from, or whose calendar an event is on. */
  account: Schema.optionalKey(Schema.NullOr(KinText.check(Schema.isMaxLength(320)))),
  /** What the owner may switch From to before Confirm; `id` is what the switch names. */
  fromChoices: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: KinTrimmedText.check(Schema.isMaxLength(400)),
        account: KinText.check(Schema.isMaxLength(320)),
        address: KinText.check(Schema.isMaxLength(320)),
        name: Schema.NullOr(KinText.check(Schema.isMaxLength(200))),
      }),
    ).check(Schema.isMaxLength(30)),
  ),
  /** A reply's thread as it stands: so the owner sees it is the right one. */
  thread: Schema.optionalKey(
    Schema.Struct({
      subject: KinText.check(Schema.isMaxLength(400)),
      replyingTo: KinText.check(Schema.isMaxLength(400)),
      date: Schema.NullOr(KinText.check(Schema.isMaxLength(100))),
      lines: KinText.check(Schema.isMaxLength(600)),
    }),
  ),
  /** The earlier message quoted under the body, as Gmail quotes it; sent after the body. */
  quoted: Schema.optionalKey(Schema.NullOr(KinText.check(Schema.isMaxLength(6_000)))),
  to: Schema.Array(KinText.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
  cc: Schema.Array(KinText.check(Schema.isMaxLength(320))).check(Schema.isMaxLength(50)),
  /** The subject, or an event's title, or the tool for a plain call. */
  subject: KinText.check(Schema.isMaxLength(400)),
  /** The whole body, an event's time and notes, or a call's arguments. */
  body: KinText.check(Schema.isMaxLength(24_000)),
  attachments: Schema.Array(
    Schema.Struct({
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
      /** "Invoice INV/26-27/004 · ₹1,18,000.00", read by the server from the record. */
      label: Schema.NullOr(KinText.check(Schema.isMaxLength(200))),
      bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      /** An invoice's, drawn while the company had no bank account or UPI id to be paid to. */
      bankMissing: Schema.optionalKey(Schema.Literal(true)),
    }),
  ).check(Schema.isMaxLength(10)),
  outcome: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(["sending", "sent", "failed"]),
      reason: Schema.NullOr(KinText.check(Schema.isMaxLength(500))),
      at: IsoDateTime,
    }),
  ),
  /**
   * Set on an unanswered mail card while an earlier try at the same mail may already have gone
   * (which try, and when it ended). Its Confirm then carries that try as `checkedSent`; the host
   * refuses one without.
   */
  mayHaveGone: Schema.optionalKey(KinSendTry),
  /** Set while the words shown are a person's saved edit, not the agent's draft: who, by name. */
  edited: Schema.optionalKey(
    Schema.Struct({
      personId: KinPersonId,
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
    }),
  ),
});
export type KinSendCard = typeof KinSendCard.Type;
export const KinChoiceCardState = Schema.Struct({
  question: KinTrimmedText.check(Schema.isMaxLength(240)),
  detail: Schema.NullOr(KinText.check(Schema.isMaxLength(2000))),
  /**
   * Asked for someone else: who asks, and through which agent, as the card's first line, above
   * the question. `detail` opens with the same line for older clients.
   */
  askedBy: Schema.optionalKey(KinTrimmedText.check(Schema.isMaxLength(500))),
  /**
   * What holds only until someone answers, such as "Until someone chooses, …": shown while the
   * card is open, never once it is settled. `detail` opens with it for older clients.
   */
  whileOpen: Schema.optionalKey(KinTrimmedText.check(Schema.isMaxLength(600))),
  /**
   * A teammate's draft sent up for approval, as written (markdown): shown rendered, as a doc is.
   * `detail` carries the same words for older clients.
   */
  draft: Schema.optionalKey(KinText.check(Schema.isMaxLength(2000))),
  /**
   * Set when `draft` is only the opening of a longer one: the doc and the version that went up,
   * which is the one an Approve approves. `detail` says so for older clients.
   */
  draftDoc: Schema.optionalKey(
    Schema.Struct({ recordId: KinTrimmedText, key: KinRefKey, version: PositiveInt }),
  ),
  // An agent's kin_ask offers at most four; Kin's own cards, such as a statement's currency, up to eight.
  options: Schema.Array(KinChoiceOption).check(Schema.isMinLength(2), Schema.isMaxLength(8)),
  /** A picture of what is asked about, such as a new logo: a file in this card's chat. */
  image: Schema.optionalKey(
    Schema.Struct({
      attachmentId: KinTrimmedText,
      mimeType: KinTrimmedText.check(Schema.isMaxLength(100)),
    }),
  ),
  /** Set on a card that asks to send something out of the company: exactly what goes. */
  send: Schema.optionalKey(KinSendCard),
  /** Set when a newer card for the same thing closed this one. */
  replaced: Schema.optionalKey(Schema.Literal(true)),
  /** On a replaced card: the newer one, and once that was answered, who chose what on it. */
  replacedBy: Schema.optionalKey(
    Schema.Struct({
      widgetId: KinWidgetId,
      decided: Schema.optionalKey(
        Schema.Struct({
          name: KinTrimmedText.check(Schema.isMaxLength(200)),
          label: KinTrimmedText.check(Schema.isMaxLength(80)),
        }),
      ),
    }),
  ),
  /** Who settled the card, by name at the time; set by the host beside `answer`. */
  decidedBy: Schema.optionalKey(
    Schema.Struct({
      personId: KinPersonId,
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
    }),
  ),
  /** An agent's open question: it takes taps until the question closes, not for a day. */
  untilAnswered: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Set while the person it asked dismissed it without choosing: by whom, by name then, and when.
   * The card is closed; its Undo (`KIN_CHOICE_UNDISMISS_ACTION`) opens it again as it was.
   */
  dismissed: Schema.optionalKey(
    Schema.Struct({
      personId: KinPersonId,
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
      at: IsoDateTime,
    }),
  ),
  /**
   * What the answer did, in the owner's words, set by the server on a card Kin asked itself: a
   * past-tense title ("Money recorded") and what happened ("Receipt RCT/26-27/001 for ₹25,000…").
   */
  outcome: Schema.optionalKey(
    Schema.Struct({
      title: KinTrimmedText.check(Schema.isMaxLength(120)),
      text: KinText.check(Schema.isMaxLength(600)),
      /** Where what the tap made lives, for the card to open: a list, in its place. */
      open: Schema.optionalKey(
        Schema.Struct({
          place: Schema.Literals(["money", "clients", "docs"]),
          list: KinTrimmedText.check(Schema.isMaxLength(40)),
          /** Money's Subscriptions, which shows this list. */
          subscriptions: Schema.optionalKey(Schema.Literal(true)),
        }),
      ),
      /** Set when the person undid what a default Kin took: who, by name then, and when. */
      undone: Schema.optionalKey(
        Schema.Struct({
          personId: KinPersonId,
          name: KinTrimmedText.check(Schema.isMaxLength(200)),
          at: IsoDateTime,
        }),
      ),
    }),
  ),
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
export type KinChoiceOutcome = NonNullable<KinChoiceCardState["outcome"]>;

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

/** A failed task's cause the server can tell from its provider's failure. */
export const KinTaskFailure = Schema.Literals([
  "model_not_offered",
  "signed_out",
  "unreachable",
  "usage_limit",
]);
export type KinTaskFailure = typeof KinTaskFailure.Type;

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
  /** Why a failed task stopped, where the server can tell; null when it can't, absent from older servers. */
  failure: Schema.optional(Schema.NullOr(KinTaskFailure)),
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
/** An agent's open question waiting on a card: what it does, and on which day, unless answered. */
export const KinWaitingAsk = Schema.Struct({
  agent: KinTrimmedText.check(Schema.isMaxLength(80)),
  /** The option it takes on `by`; null when nothing is safe to do without the person. */
  default: Schema.NullOr(KinTrimmedText.check(Schema.isMaxLength(80))),
  by: IsoDateTime,
  revision: Schema.Int,
  options: Schema.Array(
    Schema.Struct({
      optionId: KinTrimmedText.check(Schema.isMaxLength(40)),
      label: KinTrimmedText.check(Schema.isMaxLength(80)),
    }),
  ).check(Schema.isMaxLength(8)),
});
export type KinWaitingAsk = typeof KinWaitingAsk.Type;
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
  /** The card's question, when a card waits; absent from servers without it. */
  question: Schema.optional(Schema.NullOr(KinTrimmedText)),
  /** Set while an agent's question on that card is open; absent from servers without it. */
  ask: Schema.optional(KinWaitingAsk),
  /** What the waiting card is, when more than a question: a mail ready to send, a draft sent up. */
  card: Schema.optional(Schema.Literals(["mail", "draft"])),
  /** The first lines of what the card asks about, such as a draft or a doc; absent without one. */
  excerpt: Schema.optional(KinTrimmedText.check(Schema.isMaxLength(300))),
  /**
   * Set when this waits for someone else, not the viewer: whom, by name. Sent only to a client
   * that asks for it; the viewer may look but not answer, and the host refuses any answer.
   */
  waitsFor: Schema.optional(
    Schema.Struct({
      personId: KinPersonId,
      name: KinTrimmedText.check(Schema.isMaxLength(200)),
    }),
  ),
});
export type KinWaitingItem = typeof KinWaitingItem.Type;
/** A page's line for a chat row, sent with `acceptPreview` instead of the page's whole body. */
export const KinChatPreview = Schema.Struct({
  /** `kinPageGist` of the whole body. */
  gist: KinText,
  /** The page is a brief, whose line reads after its greeting. */
  brief: Schema.Boolean,
});
export type KinChatPreview = typeof KinChatPreview.Type;
export const KinChatSummary = Schema.Struct({
  ...KinChat.fields,
  // A direct chat's two members. A group's row carries only the viewer's own, with `leftAt` set
  // once they are no longer in it; `kin.chat.members` lists the rest.
  members: Schema.Array(KinChatMember),
  lastMessage: Schema.NullOr(KinMessage),
  /**
   * With `acceptPreview`, when `lastMessage` is a page: its line, and that message then comes with
   * its body cut short and without embeds or turn changes. Absent otherwise.
   */
  lastPreview: Schema.optional(KinChatPreview),
  // In a group, the person who wrote `lastMessage`, when it wasn't the viewer.
  lastAuthorName: Schema.optional(KinTrimmedText),
  unread: NonNegativeInt,
  /** An agent in the chat is on a live wake-up. Absent from servers without it. */
  working: Schema.optional(Schema.Boolean),
  /** The Team room has something the viewer hasn't read: a quiet dot, never a count. */
  fresh: Schema.optional(Schema.Boolean),
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
      /**
       * The company's other agents, by name only: everyone on the team may know who holds a task,
       * not message them. Absent from older hosts.
       */
      otherAgents: Schema.optional(
        Schema.Array(
          Schema.Struct({
            agentId: KinAgentId,
            displayName: Schema.String,
            retired: Schema.Boolean,
          }),
        ),
      ),
    }),
  ),
  me: Schema.Array(
    Schema.Struct({
      orgId: KinOrgId,
      personId: KinPersonId,
      // Absent from a host older than briefs.
      displayName: Schema.optional(Schema.String),
    }),
  ),
});
export type KinOrgsListResult = typeof KinOrgsListResult.Type;
export const KinChatsSubscribeInput = Schema.Struct({
  orgId: Schema.optional(KinOrgId),
  /** The client reads `lastPreview`; older servers ignore it and send whole messages. */
  acceptPreview: Schema.optional(Schema.Boolean),
  /** The client shows `waitsFor` rows read-only; others get none of them. */
  acceptWaitsFor: Schema.optional(Schema.Boolean),
});
export type KinChatsSubscribeInput = typeof KinChatsSubscribeInput.Type;
export const KinChatsCreateDirectInput = Schema.Struct({ orgId: KinOrgId, agentId: KinAgentId });
export type KinChatsCreateDirectInput = typeof KinChatsCreateDirectInput.Type;
/** Anyone opens their chat with a teammate: the same one every time, made the first time. */
export const KinChatsWithPersonInput = Schema.Struct({ orgId: KinOrgId, personId: KinPersonId });
export type KinChatsWithPersonInput = typeof KinChatsWithPersonInput.Type;
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
/**
 * Other agents a chat's messages were handed to, while that work is queued or running. Each
 * names its agent and the chat it runs in (null when the caller isn't in that chat).
 */
export const KinChatWorkingResult = Schema.Struct({
  handoffs: Schema.Array(
    Schema.Struct({
      agentId: KinAgentId,
      chatId: Schema.NullOr(KinChatId),
      // Null while queued; a running one can be stopped by its wake-up.
      wakeupId: Schema.NullOr(KinWakeupId),
      state: Schema.Literals(["queued", "running"]),
      // The asking message's opening words, which the caller can already read in this chat.
      asked: KinText.check(Schema.isMaxLength(80)),
      since: IsoDateTime,
    }),
  ),
});
export type KinChatWorkingResult = typeof KinChatWorkingResult.Type;
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
/** `KinChat.teamId` of the company chat while it is on: the one group everyone on the team is in. */
export const KIN_COMPANY_CHAT_TEAM_ID = "company";
/**
 * `KinChat.teamId` of a chat between two people starts with this, then their two person ids in
 * order: one chat per pair. Only the two of them are in it; nobody else reads it.
 */
export const KIN_PEOPLE_CHAT_TEAM_PREFIX = "people:";
export const kinPeopleChatTeamId = (one: string, other: string) =>
  `${KIN_PEOPLE_CHAT_TEAM_PREFIX}${[one, other].sort().join(":")}`;
export const kinIsPeopleChat = (chat: {
  readonly kind: string;
  readonly teamId: string | null;
}): boolean =>
  chat.kind === "team_group" && (chat.teamId?.startsWith(KIN_PEOPLE_CHAT_TEAM_PREFIX) ?? false);
/**
 * `KinChat.teamId` of the Team room: the agents and the owner-level people, where agents hold
 * discussions with each other. It never notifies or counts as unread, and teammates are never in it.
 */
export const KIN_TEAM_ROOM_TEAM_ID = "team-room";
/** Turns the company chat on with this agent answering by default, or off with null. Owner only. */
export const KinGroupSetCompanyInput = Schema.Struct({
  orgId: KinOrgId,
  leadAgentId: Schema.NullOr(KinAgentId),
});
export type KinGroupSetCompanyInput = typeof KinGroupSetCompanyInput.Type;
export const KinGroupSetCompanyResult = Schema.Struct({ chat: Schema.NullOr(KinChat) });
export type KinGroupSetCompanyResult = typeof KinGroupSetCompanyResult.Type;
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
  /**
   * Doc sections the message is about; the host quotes their text to the agent. A teammate points
   * only at docs everyone in the chat reads.
   */
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
/** Pins or unpins one chat at the top of the caller's own list. */
export const KinChatsPinInput = Schema.Struct({ chatId: KinChatId, pinned: Schema.Boolean });
export type KinChatsPinInput = typeof KinChatsPinInput.Type;
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
  /**
   * The person checked the account's sent mail for the try a card's `send.mayHaveGone` names.
   * A tick for another try does not count.
   */
  checkedSent: Schema.optional(KinSendTry),
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
  /** On a send refused for its sent-mail tick: the try, for the words that were refused. */
  mayHaveGone: Schema.optionalKey(KinSendTry),
  /** On a person's save whose amount reads like a slip: the list and its largest entry, if any. */
  farAbove: Schema.optionalKey(
    Schema.Struct({
      list: Schema.String,
      largest: Schema.NullOr(Schema.Struct({ minor: Schema.Number, currency: Schema.String })),
    }),
  ),
}) {}

export const KIN_CHAT_WS_METHODS = {
  orgsList: "kin.orgs.list",
  chatsSubscribe: "kin.chats.subscribe",
  chatsCreateDirect: "kin.chats.createDirect",
  chatsWithPerson: "kin.chats.withPerson",
  chatsMute: "kin.chats.mute",
  chatsPin: "kin.chats.pin",
  chatsClear: "kin.chats.clear",
  chatMembers: "kin.chat.members",
  chatWorking: "kin.chat.working",
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
  Rpc.make(KIN_CHAT_WS_METHODS.chatsWithPerson, {
    payload: KinChatsWithPersonInput,
    success: KinChat,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatsMute, {
    payload: KinChatsMuteInput,
    success: KinChatMember,
    error: Schema.Union([KinChatError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(KIN_CHAT_WS_METHODS.chatsPin, {
    payload: KinChatsPinInput,
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
  Rpc.make(KIN_CHAT_WS_METHODS.chatWorking, {
    payload: KinChatMembersInput,
    success: KinChatWorkingResult,
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
  [KIN_CHAT_WS_METHODS.chatsWithPerson]: AuthKinChatScope,
  // Only quiets the caller's own pushes, like marking a chat read.
  [KIN_CHAT_WS_METHODS.chatsMute]: AuthKinChatScope,
  // Only orders the caller's own list, like a mute.
  [KIN_CHAT_WS_METHODS.chatsPin]: AuthKinChatScope,
  // A teammate clears their own direct chat with a lead, so chat access reaches the method; the
  // chat service decides per chat, and refuses a group to anyone but the owner.
  [KIN_CHAT_WS_METHODS.chatsClear]: AuthKinChatScope,
  // Names of the people and leads in a chat the caller is in.
  [KIN_CHAT_WS_METHODS.chatMembers]: AuthKinChatScope,
  // What a chat the caller is in handed to other agents; membership is checked per chat.
  [KIN_CHAT_WS_METHODS.chatWorking]: AuthKinChatScope,
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
  Rpc.make("kin.groups.setCompany", {
    payload: KinGroupSetCompanyInput,
    success: KinGroupSetCompanyResult,
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
