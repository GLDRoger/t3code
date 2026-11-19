import { laneFor } from "../reply/replyLane.ts";
import type { PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import * as Floor from "../floor/KinFloor.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as TaskCard from "../widgets/taskCard.ts";
import {
  KIN_CHOICE_CARD_ACTION,
  KIN_MESSAGE_FIGURES_MAX,
  KIN_MESSAGE_PAGES_MAX,
  KIN_FIGURE_SCHEME,
  KinEmbed,
  KIN_TEAM_ROOM_TEAM_ID,
  kinIsPeopleChat,
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinWaitingId,
  KinWidgetId,
  KinOwnerCheckCard,
  KinDeferralCard,
  KIN_MEMORY_CHANGES_CARD,
  KIN_DOC_CARD,
  type KinMessageRefInput,
  KIN_SOCIAL_PACK_CARD,
  KIN_SOCIAL_WEEK_CARD,
  KinMessagesReactInput,
  KinMessagesSendInput,
  KinWidgetsActInput,
  KinChoiceCardState,
  type KinChoiceOutcome,
  type KinSendCard,
  type KinSendTry,
  KinAgentIntent,
  type KinAuthor,
  type KinAgentId,
  type ThreadId,
  type NodeId,
  type KinChat,
  type KinChatListEvent,
  type KinChatStreamEvent,
  type KinChatSubscribeInput,
  type KinChatsSubscribeInput,
  type KinOrgsListResult,
  type KinChatSummary,
  type KinPresenceState,
  type KinChatHistoryInput,
  type KinChatHistoryResult,
  type KinChatMember,
  type KinChatsCreateDirectInput,
  type KinAttachment,
  type KinDiscussionId,
  type KinMessage,
  type KinMessageOrigin,
  type KinMessageRelay,
  type KinMessageWhen,
  type KinMessagesMarkReadInput,
  type KinChatsMuteInput,
  type KinChatsClearInput,
  type KinChatsClearResult,
  type KinPersonId,
  type KinOrgId,
  type KinReaction,
  type KinReactionEmoji,
  type KinWaitingItem,
  type KinWidget,
} from "@t3tools/contracts";
import {
  KIN_VISUAL_CARD_TYPE,
  KIN_VISUAL_FILE_SCHEME,
  kinVisualFileReferences,
} from "@t3tools/shared/kinVisual";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { validateState } from "../widgets/registry.ts";
import { deferralCardActions, deferralCardActionsReady } from "../widgets/deferralCard.ts";
import * as ChartCard from "../widgets/chartCard.ts";
import * as VisualCard from "../widgets/visualCard.ts";
import * as CardPlans from "../widgets/cardPlans.ts";
import * as ChoiceCard from "../widgets/choiceCard.ts";
import { answerByReply, askedForCard } from "../questions/openQuestions.ts";
import { undoDeferral } from "../triggers/KinTriggerService.ts";
import * as ScheduledTasks from "../widgets/scheduledTaskCard.ts";
import * as ReminderCard from "../widgets/reminderCard.ts";
import * as SocialCards from "../social/cards.ts";
import { answerChange } from "../work/companyProfile.ts";
import { KinRefreshObserver } from "./KinRefreshHub.ts";
import { docsForViewer } from "./privateDocs.ts";
import * as Hub from "./KinChatHub.ts";
import { KinPresence, syncQueued } from "../reply/KinPresence.ts";
import { effectiveAudience } from "../lead/Audience.ts";
import { KinStop } from "../lead/KinStop.ts";
import { isOrgOwner } from "../lead/orgState.ts";
import { docPageSources } from "../work/docFiles.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import * as Repository from "./KinChatRepository.ts";
import type { WriteAudience } from "./KinChatRepository.ts";
import { KinAttachmentStore } from "./KinAttachmentStore.ts";
import type { AgentIdentity, PersonIdentity } from "./KinIdentity.ts";
import * as Reactions from "./reactions.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { ownerLevel, ownsAgent } from "../people/KinAccess.ts";
import { memberReads } from "./sharing.ts";

const decodeChoiceCard = Schema.decodeUnknownEffect(KinChoiceCardState);
type Identity = PersonIdentity | AgentIdentity;
type Viewers = ReadonlyArray<PersonIdentity>;
type Caller = Identity | Viewers;
type PersonCaller = PersonIdentity | Viewers;
type ServiceError = Repository.RepositoryError;
type SendInput = KinMessagesSendInput & {
  readonly intent?: KinAgentIntent;
  readonly floorGrant?: string | undefined;
  /** The authenticated session sending, set by the transport; only its own uploads are claimed. */
  readonly uploader?: PendingUploadOwner;
  /**
   * A message for the one person in this direct chat (`KinLevelGate.postTo`): words checked for
   * them, not the owner's, and admitted outside the chat's floor (`KinFloor.admitToPerson`).
   */
  readonly placeReplyFigures?: true;
  readonly forChat?: true;
  /** With `forChat`: another person's words the agent passes on (`kin_relay`). */
  readonly relay?: KinMessageRelay;
  /** A person's words Kin posts again for them (`kin_hand_off`): no reply of theirs here. */
  readonly passedOn?: KinMessageOrigin;
  /** Their words from a group Kin posts again here (`kin_take_private`): no reply of theirs. */
  readonly replies?: false;
};
type WidgetUpsertInput = {
  readonly chatId: KinChatId;
  readonly widgetId?: KinWidgetId | undefined;
  readonly revision?: number | undefined;
  readonly replyTo?: KinMessageId | undefined;
  readonly type: string;
  readonly state: unknown;
  readonly awaiting?: ReadonlyArray<KinPersonId> | undefined;
  readonly closed?: boolean | undefined;
};
/** After a refused choice tap rolled back, as its own step: a redraw that offers what it lacked. */
export type ChoiceRefusedHandler = (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: KinWidgetId;
  readonly error: unknown;
}) => Effect.Effect<void>;
/**
 * Server work an owner's answer on a choice card carries out, in the tap's own transaction:
 * attached by the layer that has records and documents, which the chat layer sits under.
 */
export type ChoiceAnswerHandler = (input: {
  readonly orgId: KinOrgId;
  readonly widget: KinWidget;
  readonly personId: KinPersonId;
  readonly memberId: KinMemberId;
  readonly option: { readonly label: string; readonly kind?: "yes" | "no" | undefined };
  /** The fixed action the option runs, sealed when the card was drawn (`cardActions.ts`). */
  readonly plan?: CardPlans.CardPlan;
  readonly via: "tap" | "reaction";
  readonly now: number;
  /** The try the person's sent-mail tick acknowledges (`KinWidgetsActInput.checkedSent`). */
  readonly checkedSent?: KinSendTry;
}) => Effect.Effect<
  KinChoiceOutcome | undefined,
  KinChatError | Repository.RepositoryError | SqlError.SqlError | Schema.SchemaError
>;
type WaitingInput = Pick<
  KinWaitingItem,
  "chatId" | "personId" | "messageId" | "widgetId" | "reason"
>;

export class KinChatService extends Context.Service<
  KinChatService,
  {
    /** `refused`: after a refused tap on a choice card rolled back, as its own step. */
    readonly attachChoiceAnswers: (
      handler: ChoiceAnswerHandler,
      refused?: ChoiceRefusedHandler,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly notice: (input: {
      readonly messageId: KinMessageId;
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly body: string;
      /** Files Kin already stored, such as a worker's screenshots; never a member's upload. */
      readonly attachments?: ReadonlyArray<KinAttachment>;
      readonly waitingFor?: KinPersonId;
      /** Who `body` is for (`WriteAudience`), checked against the chat in the write's transaction. */
      readonly audience: WriteAudience;
      /** Posted as this lead while it is in the chat, such as a relay held through quiet hours. */
      readonly from?: KinAgentId;
      /** A row one agent sent into another's chat, or the answer carried back (`KinMessageRelay`). */
      readonly relay?: KinMessageRelay;
      readonly discussionId?: KinDiscussionId;
      /** Shown, but never pushed or counted as unread. */
      readonly silent?: true;
      /** The time `body` names, which each reader's client puts on their own clock. */
      readonly when?: KinMessageWhen;
    }) => Effect.Effect<
      { readonly message: KinMessage; readonly waiting: KinWaitingItem | null },
      ServiceError
    >;
    readonly resolveNotice: (input: {
      readonly orgId: KinOrgId;
      readonly waitingId: KinWaitingId;
      readonly resolution: "answered" | "closed";
    }) => Effect.Effect<void, ServiceError>;
    readonly orgs: (
      identities: ReadonlyArray<PersonIdentity>,
    ) => Effect.Effect<KinOrgsListResult, ServiceError>;
    readonly subscribe: (
      identity: PersonCaller,
      input: KinChatSubscribeInput,
    ) => Stream.Stream<KinChatStreamEvent, ServiceError>;
    readonly subscribeChats: (
      identities: ReadonlyArray<PersonIdentity>,
      input: KinChatsSubscribeInput,
    ) => Stream.Stream<KinChatListEvent, ServiceError>;
    readonly mute: (
      identity: PersonCaller,
      input: KinChatsMuteInput,
    ) => Effect.Effect<KinChatMember, ServiceError>;
    /**
     * Empties a chat for everyone in it, for good; memory, members and settings stay. The
     * organisation's owner clears a group; a direct chat with a lead is cleared by the one
     * person in it. A lead's turn answering a deleted message stops without a reply.
     */
    readonly clear: (
      identity: PersonCaller,
      input: KinChatsClearInput,
    ) => Effect.Effect<KinChatsClearResult, ServiceError>;
    readonly leaveChat: (
      identity: PersonIdentity,
      input: { readonly chatId: KinChatId; readonly memberId: KinMemberId },
    ) => Effect.Effect<void, ServiceError>;
    readonly createDirect: (
      identity: PersonCaller,
      input: KinChatsCreateDirectInput,
    ) => Effect.Effect<KinChat, ServiceError>;
    readonly send: (identity: Caller, input: SendInput) => Effect.Effect<KinMessage, ServiceError>;
    /** A wake-up's one reply in a chat grows by a later segment of the same turn, in place. */
    readonly extendReply: (
      agent: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly messageId: KinMessageId;
        readonly body: string;
        readonly lead?: true;
      },
    ) => Effect.Effect<KinMessage, ServiceError>;
    /** Whether this person is in the chat whose message carries the stored file. */
    readonly attachmentReadable: (
      caller: PersonCaller,
      attachmentId: string,
    ) => Effect.Effect<boolean, ServiceError>;
    readonly read: (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly afterSeq?: number | undefined;
        readonly limit?: number | undefined;
      },
    ) => Effect.Effect<ReadonlyArray<KinMessage>, ServiceError>;
    readonly history: (
      identity: Caller,
      input: KinChatHistoryInput,
    ) => Effect.Effect<KinChatHistoryResult, ServiceError>;
    readonly markRead: (
      identity: Caller,
      input: KinMessagesMarkReadInput,
    ) => Effect.Effect<void, ServiceError>;
    readonly upsertWidget: (
      identity: Identity,
      input: WidgetUpsertInput,
    ) => Effect.Effect<KinWidget, ServiceError>;
    readonly createTaskCard: (input: {
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly audience: WriteAudience;
      readonly authorAgentId: KinAgentId;
      readonly threadId: ThreadId;
      /** T3's id for the delegated task, which task_cancel takes; else the thread's. */
      readonly taskId?: NodeId;
      readonly title: string;
      readonly model: string | null;
    }) => Effect.Effect<KinWidget, ServiceError, OrchestratorV2 | ServerEnvironment>;
    /**
     * Server-only: closes an unanswered choice card, as replaced by a newer one for the same
     * thing, or with `outcome` saying what became of it (an open question's default taken).
     */
    readonly closeReplaced: (input: {
      readonly orgId: KinOrgId;
      readonly widgetId: KinWidgetId;
      readonly outcome?: KinChoiceOutcome;
    }) => Effect.Effect<void, ServiceError>;
    /**
     * Server-only: a choice card `closeReplaced` closed with an outcome takes taps again, as it was
     * asked, from `awaiting`. False when it is not such a card.
     */
    readonly reopenClosed: (input: {
      readonly orgId: KinOrgId;
      readonly widgetId: KinWidgetId;
      readonly awaiting: ReadonlyArray<KinPersonId>;
    }) => Effect.Effect<boolean, ServiceError>;
    /** Server-only: what became of a send card's Confirm: sending, then sent or failed. */
    readonly setSendOutcome: (input: {
      readonly orgId: KinOrgId;
      readonly widgetId: KinWidgetId;
      readonly outcome: NonNullable<KinSendCard["outcome"]>;
      /** "chat" when the chat turned shared since the Confirm: the caller passes no reason. */
      readonly audience?: "owner" | "chat";
    }) => Effect.Effect<KinWidget, ServiceError>;
    /**
     * Server-only: the owner switched an unanswered send card's From. Bound to the revision he
     * saw, and keeps the card's posted time, so its expiry doesn't move.
     */
    readonly setSendCard: (input: {
      readonly orgId: KinOrgId;
      readonly widgetId: KinWidgetId;
      readonly revision: number;
      readonly detail: string;
      readonly send: KinSendCard;
    }) => Effect.Effect<KinWidget, ServiceError>;
    readonly act: (
      identity: PersonCaller,
      input: KinWidgetsActInput,
    ) => Effect.Effect<KinMessage, ServiceError>;
    /** Whether `act` would let this person tap the card at all: an active writing member who reads it. */
    readonly canTap: (
      identity: PersonIdentity,
      input: { readonly widgetId: KinWidgetId },
    ) => Effect.Effect<void, ServiceError>;
    /** Posts a lead's choice card under the same floor and flood rules as its text replies. */
    /**
     * Turns the caller's reaction on or off; one per member per message, so a new one replaces
     * theirs. An owner's 👍/👎 answers a yes/no choice card like a tap, and on the lead's latest
     * question wakes it as a soft reply; a 👎 elsewhere wakes it once. Privileged cards refuse.
     */
    readonly react: (
      identity: Caller,
      // `chatId` pins the message to one chat: `kin_react` passes its wake-up's lane.
      input: KinMessagesReactInput & { readonly chatId?: KinChatId },
    ) => Effect.Effect<KinReaction, ServiceError>;
    readonly ask: (
      identity: AgentIdentity,
      input: ChoiceCard.AskInput & {
        readonly chatId: KinChatId;
        readonly clientMessageId: string;
        /** For the one person whose chat it is, its words already checked for them (`askTo`). */
        readonly forChat?: true;
        /** Kin's own unprompted card: it waits in Needs you but never rings. */
        readonly silent?: true;
      },
    ) => Effect.Effect<KinWidget, ServiceError>;
    /** A card Kin fills from stored rows, such as a doc card; no tap answers it. */
    readonly showCard: (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly clientMessageId: string;
        readonly type: typeof KIN_DOC_CARD;
        readonly state: unknown;
      },
    ) => Effect.Effect<KinWidget, ServiceError>;
    /** `kin_chart`'s card: the agent's own message in that chat, limited like any other post. */
    readonly chart: (
      identity: AgentIdentity,
      input: ChartCard.ChartInput & {
        readonly chatId: KinChatId;
        readonly clientMessageId: string;
        /** The intent the turn's text reply carries: an answer, or evidence when nobody asked. */
        readonly intent: "answer" | "evidence";
      },
    ) => Effect.Effect<KinWidget | { readonly figure: string }, ServiceError>;
    /** `kin_visual`'s card: the page is kept as a file of that chat and the card points at it. */
    readonly visual: (
      identity: AgentIdentity,
      input: VisualCard.VisualInput & {
        readonly chatId: KinChatId;
        readonly clientMessageId: string;
        readonly intent: "answer" | "evidence";
      },
    ) => Effect.Effect<KinWidget | { readonly figure: string }, ServiceError>;
    readonly replyCard: (
      agent: AgentIdentity,
      chatId: KinChatId,
    ) => Effect.Effect<KinMessageId | null, ServiceError>;
    readonly settleFigures: (
      agent: AgentIdentity,
      chatId: KinChatId,
      intent: "answer" | "evidence",
    ) => Effect.Effect<void, ServiceError>;
    readonly discardFigures: (input: {
      orgId: KinOrgId;
      agentId: KinAgentId;
      wakeupId: NonNullable<AgentIdentity["wakeupId"]>;
      chatId?: KinChatId;
    }) => Effect.Effect<number, ServiceError>;
    readonly setChoiceOutcome: (
      agent: AgentIdentity,
      input: { chatId: KinChatId; text: string },
    ) => Effect.Effect<boolean, ServiceError>;
    /** What the route serving a chat's page needs: the org it belongs to and that chat's files. */
    readonly visualSources: (attachmentId: string) => Effect.Effect<
      Option.Option<{
        readonly orgId: KinOrgId;
        readonly files: ReadonlyArray<{
          readonly attachmentId: string;
          readonly mimeType: string | null;
        }>;
      }>,
      ServiceError
    >;
    readonly addWaiting: (
      identity: Identity,
      input: WaitingInput,
    ) => Effect.Effect<KinWaitingItem, ServiceError>;
    readonly resolveWaiting: (
      identity: Identity,
      input: { readonly waitingId: KinWaitingId; readonly resolution: string },
    ) => Effect.Effect<KinWaitingItem, ServiceError>;
  }
>()("t3/kin/chat/KinChatService") {}

const decodeRead = Schema.decodeUnknownEffect(
  Schema.Struct({
    chatId: KinChatId,
    afterSeq: Schema.optional(
      Schema.Number.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(0),
        Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
      ),
    ),
    limit: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
    ),
  }),
);
const decodeChatId = Schema.decodeEffect(KinChatId);
const decodeMemberId = Schema.decodeEffect(KinMemberId);
const decodeMessageId = Schema.decodeEffect(KinMessageId);
const decodeWidgetId = Schema.decodeEffect(KinWidgetId);
const decodeWaitingId = Schema.decodeEffect(KinWaitingId);
const decodeSend = Schema.decodeEffect(KinMessagesSendInput);
const decodeIntent = Schema.decodeEffect(KinAgentIntent);
const decodeOwnerCheckCard = Schema.decodeUnknownEffect(KinOwnerCheckCard);
const decodeDeferralCard = Schema.decodeUnknownEffect(KinDeferralCard);
const decodeAct = Schema.decodeEffect(KinWidgetsActInput);
const decodeReact = Schema.decodeEffect(KinMessagesReactInput);
const decodeChoice = Schema.decodeUnknownEffect(KinChoiceCardState);
/** Cards a reaction may land on; every other type (approval, level, review, deferral) refuses. */
const REACTABLE_WIDGETS = new Set(["choice", "task", "routine"]);
/** Matches the choice card's window and the wake-up catch-up: older messages are not worth a wake. */
const SOFT_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
const encodeAction = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const invalidState = new KinChatError({ reason: "invalid_state", message: "Invalid chat input." });
const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
const isKinChatError = Schema.is(KinChatError);
// Live inserts also advance change_seq, so refresh the client's frozen change cursor well under
// resume's 200-message reset cap.
const checkpointEvery = 100;
/** The flood bound on one wake-up's posts in one chat, natural replies and kin_chat_post alike. */
const PREVIEW_LOOKBACK = 20;
const BOOKKEEPING_TEXT = /^(?:(?:Remembered|Forgot|Updated|Replaced|Memory): |Deferred to )/;
const deferralCardOption = Schema.decodeUnknownOption(KinDeferralCard);
export const KIN_WAKEUP_MESSAGE_LIMIT = 8;
export const KIN_WAKEUP_CHAR_LIMIT = 32_000;
/** A person's mute with no end: it lasts until they unmute. */
const KIN_MUTED_FOREVER = "9999-12-31T23:59:59.999Z";
/** Guests never write; a muted agent stays silent until its mute ends. */
const mayWrite = (member: KinChatMember, agent: boolean, now: number) =>
  member.role !== "guest" &&
  !(agent && member.mutedUntil !== null && Date.parse(member.mutedUntil) > now);
const notAllowed = new KinChatError({
  reason: "not_allowed",
  message: "Chat operation not allowed.",
});
const requireRecord = Effect.fn("KinChatService.requireRecord")(function* <A, E, R>(
  effect: Effect.Effect<Option.Option<A>, E, R>,
) {
  const value = yield* effect;
  return Option.isSome(value) ? value.value : yield* notFound;
});

/** A card tap's failure as the client sees it: the refusal, a storage error, or a stale card. */
const cardTapError = (cause: KinChatError | SqlError.SqlError | Schema.SchemaError) =>
  isKinChatError(cause)
    ? cause
    : SqlError.isSqlError(cause)
      ? toPersistenceSqlError("KinChatService.cardTap")(cause)
      : new KinChatError({ reason: "invalid_state", message: "Invalid widget state." });

const taskCardWidgetId = (input: { readonly chatId: KinChatId; readonly threadId: ThreadId }) =>
  encodeAction([input.chatId, input.threadId]).pipe(
    Effect.orDie,
    Effect.map((key) => KinWidgetId.make(`task:${key}`)),
  );

/** Presence states of an agent run still under way, for the chat list's `working`. */
const WORKING_PRESENCE: ReadonlySet<KinPresenceState> = new Set([
  "starting",
  "thinking",
  "working",
  "writing",
  "stalled",
]);

/** What waits on a person in chats they are still in: the chat list's rule, and the open list's. */
export const waitingFor = Effect.fn("KinChatService.waitingFor")(function* (
  identity: PersonIdentity,
) {
  const repo = yield* Repository.KinChatRepository;
  const waiting: Array<KinWaitingItem> = [];
  for (const item of yield* repo.listOpenWaiting(identity))
    if (Option.isSome(yield* repo.activeMember({ ...item, principal: identity })))
      waiting.push(item);
  return waiting;
});

const make = Effect.gen(function* () {
  const floor = yield* Floor.KinFloor;
  const cards = yield* TaskCard.TaskCardIndex;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const presence = yield* Effect.serviceOption(KinPresence);
  // Absent where no attachments directory exists; a send with files is then refused.
  const attachmentStore = yield* Effect.serviceOption(KinAttachmentStore);
  const stop = yield* Effect.serviceOption(KinStop);
  /** For a stream event; left out of a chat that was never cleared. */
  const clearedAt = (clearedSeq: number) => (clearedSeq > 0 ? { clearedSeq } : {});
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  let onChoice: ChoiceAnswerHandler | undefined;
  let onRefused: ChoiceRefusedHandler | undefined;
  const transaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause)
            ? toPersistenceSqlError("KinChatService.transaction")(cause)
            : cause,
        ),
      );
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const identityFor = Effect.fn("KinChatService.identityFor")(function* (
    caller: Caller,
    target: {
      readonly orgId?: KinOrgId;
      readonly chatId?: KinChatId;
      readonly widgetId?: KinWidgetId | undefined;
    },
  ) {
    if ("_tag" in caller) return caller;
    for (const identity of caller) {
      if (target.orgId !== undefined && target.orgId !== identity.orgId) continue;
      if (
        target.chatId !== undefined &&
        Option.isNone(yield* repo.getChat({ ...identity, chatId: target.chatId }))
      )
        continue;
      if (
        target.widgetId !== undefined &&
        Option.isNone(yield* repo.getWidget({ ...identity, widgetId: target.widgetId }))
      )
        continue;
      return identity;
    }
    return yield* notFound;
  });
  const personFor = Effect.fn("KinChatService.personFor")(function* (
    caller: PersonCaller,
    target: Parameters<typeof identityFor>[1],
  ) {
    const person = yield* identityFor(caller, target);
    return person._tag === "person" ? person : yield* notFound;
  });
  /** The Team room's viewer rule: a membership row alone never lets a teammate read it. */
  const roomReadable = (identity: PersonIdentity, chat: { readonly teamId: string | null }) =>
    chat.teamId !== KIN_TEAM_ROOM_TEAM_ID
      ? Effect.succeed(true)
      : ownerLevel(identity.orgId, identity.personId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
  const memberFor = Effect.fn("KinChatService.memberFor")(function* (
    identity: Identity,
    chatId: KinChatId,
  ) {
    const chat = yield* requireRecord(repo.getChat({ orgId: identity.orgId, chatId }));
    const members = yield* repo.listMembers(chat);
    const member = members.find(
      (row) =>
        row.leftAt === null &&
        (identity._tag === "person"
          ? row.principal._tag === "person" && row.principal.personId === identity.personId
          : row.principal._tag === "agent" && row.principal.agentId === identity.agentId),
    );
    if (member === undefined) return yield* notFound;
    if (identity._tag === "person" && !(yield* roomReadable(identity, chat)))
      return yield* notFound;
    if (identity._tag === "agent") {
      const agent = yield* requireRecord(repo.getAgent(identity));
      const thread = yield* requireRecord(repo.getAgentThread(identity));
      if (
        agent.retiredAt !== null ||
        thread.endedAt !== null ||
        thread.agentId !== agent.agentId ||
        agent.ownerPersonId !== identity.ownerPersonId ||
        !(
          identity.hostPosted === true ||
          (identity.wakeupId !== undefined
            ? yield* repo.wakeupRunning({ ...identity, wakeupId: identity.wakeupId })
            : identity.caller !== undefined &&
              (yield* repo.hasRunningWakeup({ ...identity, caller: identity.caller })))
        )
      )
        return yield* notAllowed;
    }
    return member;
  });
  /**
   * Another person's direct chat with a lead: the lead reads it only on a turn that person's
   * message there woke, never on its owner's. Stored rows decide.
   */
  const leadMayRead = Effect.fn("KinChatService.leadMayRead")(
    function* (agent: AgentIdentity, chatId: KinChatId) {
      const rows = yield* sql`SELECT 1 FROM kin_chats c
        WHERE c.org_id = ${agent.orgId} AND c.chat_id = ${chatId} AND c.kind = 'direct'
          AND c.direct_key <> ${LeadAccess.directKey(agent.ownerPersonId, agent.agentId)}
        LIMIT 1`;
      if (rows.length === 0) return true;
      const asked = yield* sql`SELECT 1 FROM kin_events e
        JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
          AND w.agent_id = e.agent_id AND w.status = 'running'
        WHERE e.org_id = ${agent.orgId} AND e.agent_id = ${agent.agentId}
          AND (w.wakeup_id = ${agent.wakeupId ?? null}
            OR (${agent.wakeupId ?? null} IS NULL AND w.thread_id = ${agent.threadId}))
          AND e.tag IN ('chat.message', 'widget.action')
          AND json_extract(e.json, '$.chatId') = ${chatId}
        LIMIT 1`;
      return asked.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinChatService.leadMayRead")),
  );
  /** Whether the calling lead's running turn is shared (`effectiveAudience`); none found is. */
  const sharedTurn = Effect.fn("KinChatService.sharedTurn")(
    function* (agent: AgentIdentity) {
      const [row] =
        agent.wakeupId !== undefined
          ? [{ wakeupId: agent.wakeupId }]
          : yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
              WHERE org_id = ${agent.orgId} AND agent_id = ${agent.agentId}
                AND thread_id = ${agent.threadId} AND status = 'running'
              ORDER BY wakeup_id`;
      if (row === undefined) return true;
      const turn = { orgId: agent.orgId, agentId: agent.agentId, wakeupId: row.wakeupId };
      return (
        (yield* effectiveAudience(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
        "shared"
      );
    },
    Effect.mapError(toPersistenceSqlError("KinChatService.sharedTurn")),
  );
  /** Who reads a doc a message points at: a person, or a lead's turn by its stored audience. */
  const docViewer = (identity: Identity) =>
    identity._tag === "agent"
      ? sharedTurn(identity).pipe(Effect.map((shared) => ({ sharedTurn: shared })))
      : Effect.succeed(identity);
  /** A person's words are the chat's; a lead's are the owner's alone on an owner-only turn. */
  const authorAudience = (identity: Identity) =>
    identity._tag === "agent"
      ? sharedTurn(identity).pipe(
          Effect.map((shared): WriteAudience => (shared ? "chat" : "owner")),
        )
      : Effect.succeed<WriteAudience>("chat");
  const authorFor = (identity: Identity, member: KinChatMember): KinAuthor =>
    identity._tag === "person"
      ? { _tag: "human", personId: identity.personId, memberId: member.memberId }
      : {
          _tag: "agent",
          agentId: identity.agentId,
          ownerPersonId: identity.ownerPersonId,
          threadId: identity.threadId,
          memberId: member.memberId,
        };
  const canWrite = Effect.fn("KinChatService.canWrite")(function* (
    identity: Identity,
    member: KinChatMember,
  ) {
    if (!mayWrite(member, identity._tag === "agent", yield* Clock.currentTimeMillis))
      return yield* notAllowed;
  });
  /** The chat's owner, or a co-owner in her own direct chat with a lead: owner-level there. */
  const ownerSide = Effect.fn("KinChatService.ownerSide")(function* (
    identity: Identity,
    member: KinChatMember,
  ) {
    if (member.role === "owner") return true;
    if (identity._tag !== "person" || member.role !== "member") return false;
    const chat = yield* requireRecord(repo.getChat(member));
    return (
      chat.kind === "direct" &&
      (yield* ownerLevel(identity.orgId, identity.personId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ))
    );
  });
  const ownDirectChat = Effect.fn("KinChatService.ownDirectChat")(
    function* (identity: PersonIdentity, chatId: KinChatId) {
      const prefix = `${identity.personId}:`;
      const rows = yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${identity.orgId}
        AND chat_id = ${chatId} AND kind = 'direct'
        AND substr(direct_key, 1, ${prefix.length}) = ${prefix} LIMIT 1`;
      return rows.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinChatService.ownDirectChat")),
  );
  /**
   * A generated doc's file is the owner's alone: the person whose agent's job made it, or who
   * asked. A file a doc's markdown shows is read by whoever reads Docs: the org's owner.
   */
  const docFileReadable = (caller: PersonCaller, attachmentId: string) =>
    Effect.forEach("_tag" in caller ? [caller] : caller, (person) =>
      Effect.gen(function* () {
        const made = yield* sql`SELECT 1 FROM kin_doc_versions v
          JOIN kin_doc_jobs j ON j.org_id = v.org_id AND j.worker_id = v.worker_id
          LEFT JOIN kin_agents a ON a.org_id = j.org_id AND a.agent_id = j.agent_id
          WHERE v.org_id = ${person.orgId} AND v.file_attachment_id = ${attachmentId}
            AND (a.owner_person_id = ${person.personId} OR j.asked_by_person_id = ${person.personId})
          LIMIT 1`;
        if (made.length > 0) return true;
        const shown = yield* sql`SELECT 1 FROM kin_doc_files
          WHERE org_id = ${person.orgId} AND attachment_id = ${attachmentId}
          UNION ALL SELECT 1 FROM kin_company_profile
          WHERE org_id = ${person.orgId}
            AND json_extract(profile_json, '$.logo.attachmentId') = ${attachmentId}
          LIMIT 1`;
        return shown.length > 0 && (yield* isOrgOwner(person.orgId, person.personId));
      }),
    ).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.map((found) => found.some(Boolean)),
      Effect.mapError(toPersistenceSqlError("KinChatService.docFileReadable")),
    );
  /** Whether the member may read the message: nothing from before they joined. */
  const readable = (member: KinChatMember, messageId: string, floorOf?: string) =>
    memberReads(sql, { orgId: member.orgId, memberId: member.memberId, messageId, floorOf }).pipe(
      Effect.mapError(toPersistenceSqlError("KinChatService.readable")),
    );
  /** The card a person's tap is on, and their membership: active, writing, and reading it. */
  const tapTarget = Effect.fn("KinChatService.tapTarget")(function* (
    identity: PersonIdentity,
    widgetId: KinWidgetId,
  ) {
    const widget = yield* requireRecord(repo.getWidget({ orgId: identity.orgId, widgetId }));
    const member = yield* memberFor(identity, widget.chatId);
    yield* canWrite(identity, member);
    if (!(yield* readable(member, widget.messageId))) return yield* notFound;
    return { widget, member };
  });
  /** `readable`, and for a shared turn nothing below the chat's history floor, as `read` gives it. */
  const callerReads = Effect.fn("KinChatService.callerReads")(function* (
    identity: Identity,
    member: KinChatMember,
    messageId: string,
  ) {
    const floorOf =
      identity._tag === "agent" && (yield* sharedTurn(identity)) ? member.chatId : undefined;
    return yield* readable(member, messageId, floorOf);
  });
  const resolve = Effect.fn("KinChatService.resolve")(function* (
    item: KinWaitingItem,
    resolution: string,
  ) {
    if (yield* repo.resolveWaiting({ ...item, resolution, resolvedAt: yield* now })) {
      const updated = yield* requireRecord(repo.getWaiting(item));
      yield* sql.afterCommit(
        hub.publish({ type: "waiting.updated", orgId: item.orgId, item: updated }),
      );
      return updated;
    }
    return item;
  });
  const add = Effect.fn("KinChatService.add")(function* (identity: Identity, input: WaitingInput) {
    const member = yield* memberFor(identity, input.chatId);
    yield* canWrite(identity, member);
    const waitingId = yield* decodeWaitingId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
    const item: KinWaitingItem = {
      ...input,
      orgId: identity.orgId,
      waitingId,
      createdAt: yield* now,
      resolvedAt: null,
      resolution: null,
    };
    if (yield* repo.addWaiting(item)) {
      // As stored, so a card's row has its question.
      const added = Option.getOrElse(yield* repo.getWaiting(item), () => item);
      yield* hub.publish({ type: "waiting.updated", orgId: identity.orgId, item: added });
      return added;
    }
    const existing = (yield* repo.listOpenWaiting({
      orgId: identity.orgId,
      personId: input.personId,
    })).find((row) => row.widgetId === input.widgetId && row.chatId === input.chatId);
    if (existing === undefined) return yield* notFound;
    return existing;
  });
  const post = Effect.fn("KinChatService.post")(function* (
    identity: Identity,
    member: KinChatMember,
    input: {
      readonly chatId: KinChatId;
      readonly body: string;
      readonly attachments?: ReadonlyArray<KinAttachment> | undefined;
      readonly refs?: ReadonlyArray<KinMessageRefInput> | undefined;
      readonly intent: KinAgentIntent | null;
      readonly mentions: ReadonlyArray<KinMemberId>;
      readonly replyTo: KinMessageId | null;
      readonly widgetId: KinWidgetId | null;
      readonly kind: "text" | "widget_action";
      readonly publish?: boolean;
      readonly placeReplyFigures?: true | undefined;
      readonly floorRunId?: string | null;
      readonly clientId: { readonly kind: "send" | "act"; readonly id: string } | null;
      readonly forChat?: boolean;
      readonly relay?: KinMessageRelay | undefined;
      readonly passedOn?: KinMessageOrigin | undefined;
      /** False for a tap whose fixed action the server ran: it answers nothing else here. */
      readonly replies?: false;
      readonly silent?: true | undefined;
    },
  ) {
    // A reply the caller names must be one it may read; a hidden one reads as missing.
    if (
      input.kind === "text" &&
      input.replyTo !== null &&
      !(yield* callerReads(identity, member, input.replyTo))
    )
      return yield* notFound;
    const messageId = yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
    const message = yield* repo.insertMessage({
      orgId: identity.orgId,
      audience: input.forChat === true ? "chat" : yield* authorAudience(identity),
      caller: identity._tag === "agent" ? identity.caller : undefined,
      wakeupId: identity._tag === "agent" ? identity.wakeupId : undefined,
      placeReplyFigures: input.placeReplyFigures,
      ...(identity._tag === "agent" && identity.hostPosted === true
        ? { serverPosted: true as const }
        : {}),
      chatId: input.chatId,
      messageId,
      author: authorFor(identity, member),
      kind: input.kind,
      body: input.body,
      ...(input.attachments === undefined || input.attachments.length === 0
        ? {}
        : { attachments: input.attachments }),
      ...(input.refs === undefined || input.refs.length === 0 ? {} : { refs: input.refs }),
      intent: input.intent,
      mentions: input.mentions,
      replyTo: input.replyTo,
      widgetId: input.widgetId,
      floorRunId: input.floorRunId ?? null,
      ...(input.forChat === true && input.relay !== undefined ? { relay: input.relay } : {}),
      ...(identity._tag === "person" && input.passedOn !== undefined
        ? { origin: input.passedOn }
        : {}),
      ...(input.silent === true ? { silent: true as const } : {}),
      status: "posted",
      sentBy: null,
      clientMessageId: input.clientId,
      createdAt: yield* now,
      editedAt: null,
    });
    if (message.messageId !== messageId) return message;
    if (message.author._tag === "human") {
      yield* floor.open(message, yield* requireRecord(repo.getChat(member)));
    }
    if (input.publish === false) return message;
    yield* hub.publish({ type: "message.posted", orgId: identity.orgId, message });
    if (message.author._tag === "agent" && message.intent === "question") {
      const chat = yield* requireRecord(repo.getChat(member));
      const members = yield* repo.listMembers(member);
      for (const recipient of members) {
        if (recipient.leftAt !== null || recipient.principal._tag !== "person") continue;
        if (chat.kind !== "direct" && !message.mentions.includes(recipient.memberId)) continue;
        yield* add(identity, {
          chatId: message.chatId,
          personId: recipient.principal.personId,
          messageId: message.messageId,
          widgetId: null,
          reason: "question",
        });
      }
    }
    if (identity._tag === "person" && message.origin === undefined && input.replies !== false) {
      // Their words answer an agent's question asked in text here before them.
      yield* answerByReply({
        orgId: identity.orgId,
        chatId: message.chatId,
        personId: identity.personId,
        now: Date.parse(message.createdAt),
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(toPersistenceSqlError("KinChatService.answerByReply")),
      );
      for (const item of yield* repo.listOpenWaiting(identity)) {
        if (item.chatId !== message.chatId || item.reason !== "question" || item.messageId === null)
          continue;
        // A card still taking taps waits for its tap, such as a send card's Confirm.
        if (item.widgetId !== null) {
          const card = yield* repo.getWidget({ orgId: identity.orgId, widgetId: item.widgetId });
          if (
            Option.isSome(card) &&
            card.value.closedAt === null &&
            !ChoiceCard.choiceExpired(card.value, Date.parse(yield* now))
          )
            continue;
        }
        const question = yield* requireRecord(
          repo.getMessage({ orgId: identity.orgId, messageId: item.messageId }),
        );
        if (question.seq < message.seq) yield* resolve(item, "answered");
      }
    }
    return message;
  });
  /** After a refused tap rolled back: what its card's answers hand on, such as a redraw. */
  const refusedTap = (caller: PersonCaller, input: KinWidgetsActInput, error: unknown) => {
    const refused = onRefused;
    if (refused === undefined || !isKinChatError(error) || error.reason !== "conflict")
      return Effect.void;
    return personFor(caller, input).pipe(
      Effect.flatMap((identity) =>
        refused({ orgId: identity.orgId, widgetId: input.widgetId, error }),
      ),
      Effect.ignore,
    );
  };
  /** `act`'s transaction; a refused tap's card answers then run after its rollback. */
  const refusedAfter = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    caller: PersonCaller,
    input: KinWidgetsActInput,
  ) => transaction(effect).pipe(Effect.tapError((error) => refusedTap(caller, input, error)));
  // A tap, or an owner's yes/no reaction mapped to its option: the same checks and compare-and-set.
  const actOn = Effect.fn("KinChatService.actOn")(function* (
    identity: PersonIdentity,
    member: KinChatMember,
    widget: KinWidget,
    request: KinWidgetsActInput,
    reaction: { readonly emoji: KinReactionEmoji } | null,
  ) {
    if (widget.type === "chart" || widget.type === KIN_VISUAL_CARD_TYPE) return yield* invalidState;
    const choice = widget.type === "choice" ? yield* ChoiceCard.readChoice(widget, request) : null;
    const reminder =
      widget.type === "reminder"
        ? yield* ReminderCard.describeReminderTap(widget, request.actionId, request.value)
        : null;
    const scheduled =
      widget.type === "scheduled_task"
        ? yield* ScheduledTasks.describeScheduledTaskTap(
            widget,
            request.actionId,
            request.value,
          ).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(cardTapError))
        : null;
    const socialTap =
      widget.type === KIN_SOCIAL_WEEK_CARD
        ? yield* SocialCards.describeWeekTap(widget, request.actionId, request.value)
        : null;
    const packTap =
      widget.type === KIN_SOCIAL_PACK_CARD
        ? yield* SocialCards.describePackTap(widget, request.actionId)
        : null;
    const tap = choice ?? reminder ?? scheduled ?? socialTap ?? packTap;
    // An option that runs a fixed action runs it for a tap only, never for a reaction.
    const sealed =
      choice === null
        ? undefined
        : yield* CardPlans.planFor({
            orgId: identity.orgId,
            chatId: widget.chatId,
            widgetId: widget.widgetId,
            optionId: choice.option.optionId,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(cardTapError));
    if (sealed !== undefined && (reaction !== null || sealed.plan === undefined))
      return yield* new KinChatError({
        reason: "not_allowed",
        message: "This option runs only from a tap on it.",
      });
    // A question asked for another chat answers there: its tap starts no turn here.
    const runs =
      (sealed?.plan !== undefined && CardPlans.runsItself(sealed.plan)) ||
      (choice !== null &&
        (yield* askedForCard(identity.orgId, widget.widgetId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(cardTapError),
        )));
    const body = yield* encodeAction({
      widgetId: request.widgetId,
      revision: request.revision,
      actionId: request.actionId,
      ...(request.value === undefined ? {} : { value: request.value }),
      ...(tap === null ? {} : { text: tap.text }),
      // The server finished this tap itself, so it doesn't wake the lead.
      ...((reminder ?? scheduled ?? socialTap ?? packTap)?.wake === false || runs
        ? { handled: true }
        : {}),
    }).pipe(Effect.mapError(() => invalidState));
    const previous = yield* repo.findClientMessage({
      ...member,
      kind: "act",
      clientId: request.clientActionId,
    });
    if (Option.isSome(previous)) {
      if (
        previous.value.author._tag !== "human" ||
        previous.value.author.personId !== identity.personId ||
        previous.value.widgetId !== request.widgetId ||
        previous.value.body !== body
      )
        return yield* notAllowed;
      return previous.value;
    }
    // Its action ran once already: any later tap, from any session, gets that tap's answer.
    if (sealed?.ran != null)
      return yield* requireRecord(
        repo.getMessage({ orgId: identity.orgId, messageId: sealed.ran }),
      );
    if (widget.revision !== request.revision)
      return yield* new KinChatError({
        reason: "widget_changed",
        message: "Widget revision changed.",
      });
    if (widget.closedAt !== null && choice?.card.answer == null) return yield* invalidState;
    if (widget.type === "deferral" && request.actionId === "undo") {
      const card = yield* decodeDeferralCard(widget.state).pipe(
        Effect.mapError(() => invalidState),
      );
      if (card.phase !== undefined || card.itemId !== request.value) return yield* invalidState;
      const undone = yield* undoDeferral({
        orgId: identity.orgId,
        itemId: card.itemId,
        dueAt: Date.parse(card.dueAt),
        now: yield* Clock.currentTimeMillis,
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(toPersistenceSqlError("KinChatService.undoDeferral")),
      );
      if (!undone)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Too late to undo: Kin already acted on this deferral.",
        });
      const at = yield* now;
      const closed = yield* repo.updateWidget({
        ...widget,
        // A tap's results are the card's own words, shown to whoever may tap it.
        audience: "chat",
        expectedRevision: widget.revision,
        closedAt: at,
        updatedAt: at,
      });
      yield* sql.afterCommit(
        hub.publish({ type: "widget.updated", orgId: identity.orgId, widget: closed }),
      );
    }
    const ownerCard = socialTap !== null || packTap !== null;
    if (reminder !== null || scheduled !== null || ownerCard) {
      const nowMs = yield* Clock.currentTimeMillis;
      let applied: { readonly state: unknown; readonly closed: boolean } | null = null;
      // The owner's Confirm binds to the posts the card shows; the scheduler hands them over.
      if (socialTap !== null)
        applied = yield* SocialCards.applyWeekTap(widget, socialTap, identity.personId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Repository.KinChatRepository, repo),
          Effect.provideService(Hub.KinChatHub, hub),
          Effect.mapError(cardTapError),
        );
      if (packTap !== null)
        applied = yield* SocialCards.applyPackTap(widget, packTap, identity.personId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(cardTapError),
        );
      if (reminder !== null) {
        const state = yield* ReminderCard.applyReminderTap(widget, reminder, nowMs).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(cardTapError),
        );
        applied = state === null ? null : { state, closed: false };
      } else if (scheduled !== null)
        applied = yield* ScheduledTasks.applyScheduledTaskTap(widget, scheduled, nowMs).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(cardTapError),
        );
      if (applied !== null) {
        const at = yield* now;
        const updated = yield* repo.updateWidget({
          ...widget,
          // Social's cards quote the owner's drafts, so only the owner's chat may hold them.
          audience: ownerCard ? "owner" : "chat",
          state: applied.state,
          ...(socialTap?.action !== "confirm" ? {} : { awaiting: [] }),
          expectedRevision: widget.revision,
          closedAt: applied.closed ? at : widget.closedAt,
          updatedAt: at,
        });
        yield* sql.afterCommit(
          hub.publish({ type: "widget.updated", orgId: identity.orgId, widget: updated }),
        );
      }
    }
    const answer =
      choice === null
        ? null
        : yield* ChoiceCard.settleChoice(widget, choice, {
            personId: identity.personId,
            now: yield* Clock.currentTimeMillis,
            emoji: reaction?.emoji ?? null,
          });
    // A profile change a lead asked for lands only here, from the owner's own answer on its card.
    const changed =
      choice === null
        ? undefined
        : yield* answerChange({
            orgId: identity.orgId,
            widgetId: widget.widgetId,
            personId: identity.personId,
            confirmed: choice.option.kind === "yes",
            via: reaction === null ? "tap" : "reaction",
            now: yield* Clock.currentTimeMillis,
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(KinRefreshObserver, refresh),
            Effect.mapError(cardTapError),
          );
    if (sealed !== undefined && onChoice === undefined)
      return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
    const handled =
      choice === null || onChoice === undefined
        ? undefined
        : yield* onChoice({
            orgId: identity.orgId,
            widget,
            personId: identity.personId,
            memberId: member.memberId,
            option: choice.option,
            ...(sealed?.plan === undefined ? {} : { plan: sealed.plan }),
            via: reaction === null ? "tap" : "reaction",
            now: yield* Clock.currentTimeMillis,
            ...(request.checkedSent === undefined ? {} : { checkedSent: request.checkedSent }),
          }).pipe(
            Effect.mapError((cause) =>
              SqlError.isSqlError(cause) || Schema.isSchemaError(cause)
                ? cardTapError(cause)
                : cause,
            ),
          );
    const message = yield* post(identity, member, {
      chatId: widget.chatId,
      kind: "widget_action",
      body,
      intent: null,
      mentions: [],
      replyTo: widget.messageId,
      widgetId: widget.widgetId,
      clientId: { kind: "act", id: request.clientActionId },
      ...(runs ? { replies: false as const } : {}),
    });
    if (sealed !== undefined && choice !== null)
      yield* CardPlans.markRan({
        orgId: identity.orgId,
        widgetId: widget.widgetId,
        optionId: choice.option.optionId,
        messageId: message.messageId,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(cardTapError));
    for (const item of yield* repo.listOpenWaiting(identity))
      if (item.widgetId === widget.widgetId) yield* resolve(item, "acted");
    if (answer !== null) {
      // Compare-and-set on the revision the tap saw: the first answer settles the card.
      const answered = yield* repo.updateWidget({
        ...widget,
        audience: "chat",
        state: {
          ...answer,
          ...((changed ?? handled) === undefined ? {} : { outcome: changed ?? handled }),
        },
        awaiting: [],
        closedAt: answer.answer?.answeredAt ?? (yield* now),
        expectedRevision: widget.revision,
        updatedAt: yield* now,
      });
      for (const item of yield* repo.waitingForWidget(answered)) yield* resolve(item, "answered");
      yield* sql.afterCommit(
        hub.publish({ type: "widget.updated", orgId: identity.orgId, widget: answered }),
      );
    }
    return message;
  });
  const setChoiceOutcome = Effect.fn("KinChatService.setChoiceOutcome")(function* (
    agent: AgentIdentity,
    input: { chatId: KinChatId; text: string },
  ) {
    if (agent.wakeupId === undefined) return false;
    const member = yield* memberFor(agent, input.chatId);
    yield* canWrite(agent, member);
    const rows = yield* sql<{ widgetId: string }>`SELECT DISTINCT m.widget_id AS "widgetId"
        FROM kin_events e JOIN kin_messages m ON m.org_id = e.org_id
          AND m.message_id = json_extract(e.json, '$.messageId') AND m.kind = 'widget_action'
        JOIN kin_widgets w ON w.org_id = m.org_id AND w.widget_id = m.widget_id AND w.type = 'choice'
        WHERE e.org_id = ${agent.orgId} AND e.agent_id = ${agent.agentId} AND e.wakeup_id = ${agent.wakeupId}
          AND e.tag = 'widget.action' AND m.chat_id = ${input.chatId}
          AND NOT EXISTS (SELECT 1 FROM kin_events h WHERE h.org_id = e.org_id
            AND h.agent_id = e.agent_id AND h.wakeup_id = e.wakeup_id AND h.tag = 'chat.message')
        LIMIT 2`.pipe(Effect.mapError(toPersistenceSqlError("KinChatService.setChoiceOutcome")));
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row === undefined) return false;
    const found = yield* repo.getWidget({
      orgId: agent.orgId,
      widgetId: KinWidgetId.make(row.widgetId),
    });
    if (Option.isNone(found)) return false;
    const widget = found.value;
    const state = yield* decodeChoice(widget.state).pipe(Effect.mapError(cardTapError));
    if (state.answer === null || state.outcome !== undefined || state.send !== undefined)
      return false;
    const label = state.options.find((option) => option.optionId === state.answer?.optionId)?.label;
    if (label === undefined) return false;
    const saved = yield* repo.updateWidget({
      ...widget,
      state: { ...state, outcome: { title: `You chose “${label}”`, text: input.text } },
      expectedRevision: widget.revision,
      audience: yield* authorAudience(agent),
      updatedAt: yield* now,
    });
    yield* sql.afterCommit(
      hub.publish({ type: "widget.updated", orgId: agent.orgId, widget: saved }),
    );
    return true;
  }, transaction);
  const isLatestLeadMessage = Effect.fn("KinChatService.isLatestLeadMessage")(
    function* (message: KinMessage) {
      if (message.author._tag !== "agent") return false;
      const rows = yield* sql<{ messageId: string }>`SELECT m.message_id AS "messageId"
        FROM kin_messages m JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.author_agent_id
        WHERE m.org_id = ${message.orgId} AND m.chat_id = ${message.chatId}
          AND m.author_kind = 'agent' AND m.author_agent_id = ${message.author.agentId}
          AND m.status = 'posted'
        ORDER BY m.seq DESC LIMIT 1`;
      return rows[0]?.messageId === message.messageId;
    },
    Effect.mapError(toPersistenceSqlError("KinChatService.isLatestLeadMessage")),
  );
  // Earlier versions posted Kin's own notes (a memory change, a reminder it set) as system rows.
  // No feed draws them, so none is a chat's last line.
  const isBookkeeping = Effect.fn("KinChatService.isBookkeeping")(function* (message: KinMessage) {
    if (message.author._tag !== "system") return false;
    if (message.widgetId === null) return BOOKKEEPING_TEXT.test(message.body);
    const widget = yield* repo.getWidget({ orgId: message.orgId, widgetId: message.widgetId });
    if (Option.isNone(widget)) return false;
    if (widget.value.type === KIN_MEMORY_CHANGES_CARD) return true;
    if (widget.value.type !== "deferral") return false;
    const phase = Option.getOrUndefined(deferralCardOption(widget.value.state))?.phase;
    // A card still asking the owner something is theirs to see.
    return !(widget.value.closedAt === null && (phase === "heads_up" || phase === "asked"));
  });
  const summary = Effect.fn("KinChatService.summary")(function* (
    identity: PersonIdentity,
    chatId: KinChatId,
  ): Effect.fn.Return<KinChatSummary, ServiceError> {
    const member = yield* memberFor(identity, chatId);
    const chat = yield* requireRecord(repo.getChat({ orgId: identity.orgId, chatId }));
    // Owners' history keeps dismissed messages, which no feed draws; the preview skips them.
    const history = yield* repo.history({
      ...chat,
      beforeSeq: chat.lastSeq + 1,
      limit: PREVIEW_LOOKBACK,
      viewerMemberId: member.memberId,
      receipts: false,
    });
    let lastMessage: KinMessage | null = null;
    for (const message of history.messages.toReversed()) {
      if (message.status === "dismissed" || (yield* isBookkeeping(message))) continue;
      lastMessage = message;
      break;
    }
    const group = chat.kind !== "direct";
    const author =
      group &&
      lastMessage?.author._tag === "human" &&
      lastMessage.author.memberId !== member.memberId
        ? yield* repo.getPerson({ orgId: chat.orgId, personId: lastMessage.author.personId })
        : Option.none();
    const shown =
      lastMessage === null
        ? null
        : (yield* docsForViewer(identity.orgId, identity, {
            messages: [lastMessage],
            widgets: [],
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(toPersistenceSqlError("KinChatService.privateDocs")),
          )).messages[0]!;
    // A chat between two people is called by the other one's name, for each of them.
    const pair = kinIsPeopleChat(chat) ? yield* repo.listMembers(chat) : null;
    const other =
      pair === null
        ? undefined
        : pair.find(
            (row) =>
              row.principal._tag === "person" && row.principal.personId !== identity.personId,
          );
    const otherName =
      other?.principal._tag === "person"
        ? Option.getOrUndefined(
            yield* repo.getPerson({ orgId: chat.orgId, personId: other.principal.personId }),
          )?.displayName
        : undefined;
    return {
      ...chat,
      ...(otherName === undefined ? {} : { title: otherName }),
      // A list row never carries a group's member list, but a pair's two are who it is with.
      members: pair ?? (group ? [member] : yield* repo.listMembers(chat)),
      lastMessage: shown,
      ...(Option.isSome(author) ? { lastAuthorName: author.value.displayName } : {}),
      // The Team room never counts toward a badge: a quiet "new" dot at most.
      ...(chat.teamId === KIN_TEAM_ROOM_TEAM_ID
        ? { unread: 0, fresh: (yield* repo.unreadCount(member)) > 0 }
        : { unread: yield* repo.unreadCount(member) }),
      working:
        Option.isSome(presence) &&
        presence.value
          .lines(identity.orgId, chatId)
          .some((line) => WORKING_PRESENCE.has(line.state)),
    };
  });
  const snapshot = Effect.fn("KinChatService.snapshot")(
    function* (identities: ReadonlyArray<PersonIdentity>) {
      const chats: Array<KinChatSummary> = [];
      const waiting: Array<KinWaitingItem> = [];
      for (const identity of identities) {
        for (const member of yield* repo.listMembersByPerson(identity)) {
          if (member.leftAt !== null) continue;
          const chat = yield* requireRecord(repo.getChat(member));
          if (!(yield* roomReadable(identity, chat))) continue;
          chats.push(yield* summary(identity, member.chatId));
        }
        waiting.push(
          ...(yield* waitingFor(identity).pipe(
            Effect.provideService(Repository.KinChatRepository, repo),
          )),
        );
      }
      return { _tag: "snapshot" as const, chats, waiting };
    },
    (effect) => transaction(effect).pipe(NodeSqliteClient.readOnly),
  );
  // The message itself, once any files are claimed: one transaction, no file work inside it.
  const sendClaimed = Effect.fn("KinChatService.sendClaimed")(function* (
    caller: Caller,
    input: SendInput,
    attachments: ReadonlyArray<KinAttachment>,
  ) {
    const identity = yield* identityFor(caller, input);
    const request = yield* decodeSend(input).pipe(Effect.mapError(() => invalidState));
    const member = yield* memberFor(identity, request.chatId);
    yield* canWrite(identity, member);
    // A lead posts text; only a person's message can be files alone, or point at a doc.
    if (identity._tag === "agent" && request.body.trim().length === 0) return yield* invalidState;
    if (identity._tag === "agent" && (request.refs?.length ?? 0) > 0) return yield* invalidState;
    if (request.mentions !== undefined && request.mentions.length > 100) return yield* invalidState;
    if (
      (identity._tag === "agent" && input.intent === undefined) ||
      (identity._tag === "person" && input.intent !== undefined)
    )
      return yield* invalidState;
    const intent =
      input.intent === undefined
        ? null
        : yield* decodeIntent(input.intent).pipe(Effect.mapError(() => invalidState));
    const existing = yield* repo.findClientMessage({
      orgId: identity.orgId,
      chatId: request.chatId,
      memberId: member.memberId,
      kind: "send",
      clientId: request.clientMessageId,
    });
    if (
      Option.isSome(existing) &&
      !(yield* callerReads(identity, member, existing.value.messageId))
    )
      return yield* notFound;
    const chat = yield* requireRecord(repo.getChat(member));
    if (identity._tag === "agent" && Option.isNone(existing)) {
      const used = yield* repo.wakeupPosts({
        orgId: identity.orgId,
        chatId: request.chatId,
        agentId: identity.agentId,
        threadId: identity.threadId,
      });
      if (
        used.messages >= KIN_WAKEUP_MESSAGE_LIMIT ||
        used.chars + request.body.length > KIN_WAKEUP_CHAR_LIMIT
      )
        return yield* new KinChatError({
          reason: "limit",
          message: "This wake-up has posted all it may in this chat.",
        });
    }
    const toPerson = identity._tag === "agent" && input.forChat === true;
    if (toPerson && Option.isNone(existing)) yield* floor.admitToPerson(identity, chat.chatId);
    const authorization =
      identity._tag === "agent" && Option.isNone(existing) && !toPerson
        ? yield* floor.authorize(identity, chat, intent ?? "answer", input.floorGrant)
        : { runId: null, owed: false };
    const message = yield* post(identity, member, {
      ...request,
      // Never the request's own: those name uploads, these the files kept for the chat.
      attachments,
      kind: "text",
      intent,
      floorRunId: authorization.runId,
      mentions: request.mentions ?? [],
      replyTo: request.replyTo ?? null,
      widgetId: null,
      clientId: { kind: "send", id: request.clientMessageId },
      forChat: toPerson,
      placeReplyFigures: input.placeReplyFigures,
      relay: toPerson ? input.relay : undefined,
      passedOn: input.passedOn,
      ...(input.replies === false ? { replies: false as const } : {}),
    });
    // A reply someone waits on doesn't use up the hourly room for unprompted notices.
    if (
      Option.isNone(existing) &&
      identity._tag === "agent" &&
      authorization.runId === null &&
      authorization.owed !== true
    )
      yield* floor.recordNotice(identity, message);
    return message;
  }, transaction);
  // An agent's card that is its own message: `kin_ask`'s question and `kin_chart`'s chart.
  const postCard = Effect.fn("KinChatService.postCard")(function* (
    identity: AgentIdentity,
    input: {
      readonly chatId: KinChatId;
      readonly clientMessageId: string;
      readonly type: "choice" | "chart" | typeof KIN_DOC_CARD | typeof KIN_VISUAL_CARD_TYPE;
      readonly intent: KinAgentIntent;
      readonly state: Effect.Effect<unknown, KinChatError>;
      /** A stored file the card draws; read under the same rule as the message. */
      readonly file?: string;
      readonly forChat?: true;
      readonly silent?: true | undefined;
    },
  ) {
    const member = yield* memberFor(identity, input.chatId);
    yield* canWrite(identity, member);
    const state = yield* input.state;
    const existing = yield* repo.findClientMessage({
      orgId: identity.orgId,
      chatId: input.chatId,
      memberId: member.memberId,
      kind: "send",
      clientId: input.clientMessageId,
    });
    if (Option.isSome(existing)) {
      const widget =
        existing.value.widgetId === null
          ? Option.none<KinWidget>()
          : yield* repo.getWidget({ orgId: identity.orgId, widgetId: existing.value.widgetId });
      if (Option.isNone(widget) || widget.value.type !== input.type) return yield* notAllowed;
      return widget.value;
    }
    const chat = yield* requireRecord(repo.getChat(member));
    const used = yield* repo.wakeupPosts({
      orgId: identity.orgId,
      chatId: input.chatId,
      agentId: identity.agentId,
      threadId: identity.threadId,
    });
    if (used.messages >= KIN_WAKEUP_MESSAGE_LIMIT)
      return yield* new KinChatError({
        reason: "limit",
        message: "This wake-up has posted all it may in this chat.",
      });
    // Kin's own post is a notice the owner waits on: it never spends the running turn's grant.
    const authorization =
      identity.hostPosted === true
        ? { runId: null, owed: true }
        : yield* floor.authorize(identity, chat, input.intent);
    const message = yield* post(identity, member, {
      chatId: input.chatId,
      body: "",
      intent: input.intent,
      kind: "text",
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: authorization.runId,
      clientId: { kind: "send", id: input.clientMessageId },
      publish: false,
      ...(input.forChat === true ? { forChat: true } : {}),
      silent: input.silent,
    });
    if (authorization.runId === null && authorization.owed !== true)
      yield* floor.recordNotice(identity, message);
    // Only a question waits on the people in the chat.
    const awaiting = (input.type === "choice" ? yield* repo.listMembers(member) : []).flatMap(
      (row) =>
        row.leftAt === null && row.role !== "guest" && row.principal._tag === "person"
          ? [row.principal.personId]
          : [],
    );
    const widget: KinWidget = {
      orgId: identity.orgId,
      chatId: input.chatId,
      widgetId: yield* decodeWidgetId(`${input.type}:${message.messageId}`).pipe(Effect.orDie),
      messageId: message.messageId,
      widgetClass: "native",
      type: input.type,
      revision: 1,
      state,
      source: null,
      feed: null,
      awaiting,
      pinnedAt: null,
      closedAt: null,
      updatedAt: yield* now,
    };
    yield* repo.insertWidget({
      ...widget,
      audience: input.forChat === true ? "chat" : yield* authorAudience(identity),
    });
    if (input.file !== undefined)
      yield* repo.attachCardFile({
        orgId: identity.orgId,
        chatId: input.chatId,
        messageId: message.messageId,
        attachmentId: input.file,
      });
    const anchor = yield* requireRecord(
      repo.getMessage({ orgId: identity.orgId, messageId: message.messageId }),
    );
    for (const personId of new Set(awaiting))
      yield* add(identity, {
        chatId: widget.chatId,
        personId,
        messageId: widget.messageId,
        widgetId: widget.widgetId,
        reason: "question",
      });
    yield* sql.afterCommit(
      Effect.andThen(
        hub.publish({ type: "message.posted", orgId: identity.orgId, message: anchor }),
        hub.publish({ type: "widget.updated", orgId: identity.orgId, widget }),
      ),
    );
    return widget;
  });
  const figureLane = Effect.fn("KinChatService.figureLane")(function* (
    agent: AgentIdentity,
    chatId: KinChatId,
  ) {
    if (agent.wakeupId === undefined) return null;
    const lane = yield* laneFor({ ...agent, wakeupId: agent.wakeupId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    return Option.isSome(lane) && lane.value.chatId === chatId && lane.value.team !== true
      ? agent.wakeupId
      : null;
  });
  const figureRows = Effect.fn("KinChatService.figureRows")(
    function* (agent: AgentIdentity, chatId: KinChatId, pendingOnly: boolean) {
      return yield* sql<{
        id: string;
        json: string;
        clientId: string | null;
        attachmentId: string | null;
        kind: string;
      }>`
        SELECT figure_id AS id, embed_json AS json, client_message_id AS "clientId",
          attachment_id AS "attachmentId", kind
        FROM kin_turn_figures WHERE org_id = ${agent.orgId} AND agent_id = ${agent.agentId}
          AND wakeup_id = ${agent.wakeupId ?? null} AND chat_id = ${chatId}
          AND (${pendingOnly ? 1 : 0} = 0 OR message_id IS NULL)
        ORDER BY created_at, rowid`;
    },
    Effect.mapError(toPersistenceSqlError("KinChatService.figureRows")),
  );
  const storedEmbed = Schema.fromJsonString(KinEmbed);
  const decodeEmbed = Schema.decodeEffect(storedEmbed);
  const encodeEmbed = Schema.encodeEffect(storedEmbed);
  const stageFigure = Effect.fn("KinChatService.stageFigure")(function* (
    agent: AgentIdentity & { wakeupId: NonNullable<AgentIdentity["wakeupId"]> },
    input: { chatId: KinChatId; clientMessageId: string },
    embed: Exclude<KinEmbed, { _tag: "broken" }>,
  ) {
    const member = yield* memberFor(agent, input.chatId);
    yield* canWrite(agent, member);
    const rows = yield* figureRows(agent, input.chatId, false);
    const existing = rows.find((row) => row.clientId === input.clientMessageId);
    const title = (embed._tag === "chart" ? embed.chart.title : embed.title).replace(
      /[[\]\\]/g,
      "",
    );
    const result = (id: string) => ({ figure: `![${title}](${KIN_FIGURE_SCHEME}${id})` });
    if (existing !== undefined) return { ...result(existing.id), kept: false };
    if (
      rows.length >= KIN_MESSAGE_FIGURES_MAX ||
      (embed._tag === "visual" &&
        rows.filter((row) => row.kind === "visual").length >= KIN_MESSAGE_PAGES_MAX)
    )
      return yield* new KinChatError({
        reason: "limit",
        message: `This reply already holds ${rows.length} figures; put more into one kin_visual page.`,
      });
    const id = `f_${Buffer.from(SecureRandom.randomBytesUnsafe(8)).toString("base64url").slice(0, 10)}`;
    const json = yield* encodeEmbed(embed).pipe(Effect.mapError(cardTapError));
    yield* sql`INSERT INTO kin_turn_figures
        (org_id, figure_id, wakeup_id, agent_id, chat_id, kind, embed_json, client_message_id, attachment_id, created_at)
        VALUES (${agent.orgId}, ${id}, ${agent.wakeupId}, ${agent.agentId}, ${input.chatId},
          ${embed._tag}, ${json}, ${input.clientMessageId}, ${embed._tag === "visual" ? embed.attachmentId : null},
          ${yield* Clock.currentTimeMillis})`.pipe(
      Effect.mapError(toPersistenceSqlError("KinChatService.stageFigure")),
    );
    return { ...result(id), kept: true };
  });

  return KinChatService.of({
    // Trusted server callers only; deliberately absent from RPC and MCP.
    notice: Effect.fn("KinChatService.notice")(function* (input) {
      yield* requireRecord(repo.getChat(input));
      if (input.waitingFor !== undefined)
        yield* requireRecord(
          repo.activeMember({
            ...input,
            principal: { _tag: "person", personId: input.waitingFor },
          }),
        );
      const messageId = yield* decodeMessageId(input.messageId).pipe(
        Effect.mapError(() => invalidState),
      );
      const previous = yield* repo.getMessage({ orgId: input.orgId, messageId });
      if (Option.isSome(previous)) {
        const message = previous.value;
        const rows = yield* sql<{ waiting_id: string }>`SELECT waiting_id FROM kin_waiting
          WHERE org_id = ${input.orgId} AND message_id = ${messageId} ORDER BY waiting_id`.pipe(
          Effect.mapError(toPersistenceSqlError("KinChatService.notice")),
        );
        const waiting =
          rows[0] === undefined
            ? null
            : yield* requireRecord(
                repo.getWaiting({
                  orgId: input.orgId,
                  waitingId: yield* decodeWaitingId(rows[0].waiting_id).pipe(
                    Effect.mapError(() => invalidState),
                  ),
                }),
              );
        if (
          (input.from === undefined
            ? message.author._tag !== "system"
            : message.author._tag === "human") ||
          message.chatId !== input.chatId ||
          message.body !== input.body ||
          (waiting?.personId ?? undefined) !== input.waitingFor
        )
          return yield* notAllowed;
        return { message, waiting };
      }
      const [agent] =
        input.from === undefined
          ? []
          : yield* sql<{ memberId: KinMemberId; ownerPersonId: KinPersonId; threadId: ThreadId }>`
              SELECT m.member_id AS "memberId", a.owner_person_id AS "ownerPersonId",
                l.thread_id AS "threadId"
              FROM kin_chat_members m
              JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
              JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
              WHERE m.org_id = ${input.orgId} AND m.chat_id = ${input.chatId}
                AND m.principal_kind = 'agent' AND m.agent_id = ${input.from}
                AND m.left_at IS NULL AND l.thread_id IS NOT NULL
              ORDER BY m.member_id LIMIT 1`.pipe(
              Effect.mapError(toPersistenceSqlError("KinChatService.notice")),
            );
      const message = yield* repo.insertMessage({
        orgId: input.orgId,
        chatId: input.chatId,
        messageId,
        author:
          agent === undefined || input.from === undefined
            ? { _tag: "system" }
            : { _tag: "agent", agentId: input.from, ...agent },
        ...(agent === undefined ? {} : { serverPosted: true as const }),
        audience: input.audience,
        kind: agent === undefined ? "system" : "text",
        body: input.body,
        ...(input.attachments === undefined || input.attachments.length === 0
          ? {}
          : { attachments: input.attachments }),
        ...(input.relay === undefined ? {} : { relay: input.relay }),
        ...(input.discussionId === undefined ? {} : { discussionId: input.discussionId }),
        ...(input.silent === undefined ? {} : { silent: input.silent }),
        ...(input.when === undefined ? {} : { when: input.when }),
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: yield* now,
        editedAt: null,
      });
      yield* sql.afterCommit(hub.publish({ type: "message.posted", orgId: input.orgId, message }));
      let waiting: KinWaitingItem | null = null;
      if (input.waitingFor !== undefined) {
        waiting = {
          orgId: input.orgId,
          chatId: input.chatId,
          waitingId: yield* decodeWaitingId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          personId: input.waitingFor,
          messageId: message.messageId,
          widgetId: null,
          reason: "question",
          createdAt: yield* now,
          resolvedAt: null,
          resolution: null,
        };
        yield* repo.addWaiting(waiting);
        yield* sql.afterCommit(
          hub.publish({ type: "waiting.updated", orgId: input.orgId, item: waiting }),
        );
      }
      return { message, waiting };
    }, transaction),
    attachChoiceAnswers: Effect.fn("KinChatService.attachChoiceAnswers")(
      function* (handler, refused) {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            onChoice = handler;
            onRefused = refused;
          }),
          () =>
            Effect.sync(() => {
              if (onChoice === handler) onChoice = undefined;
              if (onRefused === refused) onRefused = undefined;
            }),
        );
      },
    ),
    resolveNotice: Effect.fn("KinChatService.resolveNotice")(function* (input) {
      const item = yield* requireRecord(repo.getWaiting(input));
      if (item.reason !== "question" || item.messageId === null) return yield* notAllowed;
      const message = yield* requireRecord(
        repo.getMessage({ orgId: input.orgId, messageId: item.messageId }),
      );
      if (message.author._tag !== "system") return yield* notAllowed;
      yield* resolve(item, input.resolution);
    }, transaction),
    orgs: Effect.fn("KinChatService.orgs")(function* (identities) {
      const orgs = yield* Effect.forEach(
        identities,
        Effect.fn("KinChatService.org")(function* (identity) {
          const org = yield* requireRecord(repo.getOrg(identity));
          const agents = yield* repo.listAgents(identity);
          // The agents this person owns (the owner owns every one), may message, or shares a chat
          // with; the rest only by name, so a task's holder is never "an agent".
          const visible = yield* sql<{ agentId: string }>`SELECT a.agent_id AS "agentId"
            FROM kin_agents a WHERE a.org_id = ${identity.orgId} AND (
              a.owner_person_id = ${identity.personId}
              OR EXISTS (SELECT 1 FROM kin_lead_access x WHERE x.org_id = a.org_id
                AND x.agent_id = a.agent_id AND x.person_id = ${identity.personId}
                AND x.revoked_at IS NULL)
              OR EXISTS (SELECT 1 FROM kin_chat_members p JOIN kin_chat_members m
                ON m.org_id = p.org_id AND m.chat_id = p.chat_id AND m.principal_kind = 'agent'
                  AND m.agent_id = a.agent_id AND m.left_at IS NULL
                WHERE p.org_id = a.org_id AND p.principal_kind = 'person'
                  AND p.person_id = ${identity.personId} AND p.left_at IS NULL))`.pipe(
            Effect.map((rows) => new Set(rows.map((row) => row.agentId))),
            Effect.mapError(toPersistenceSqlError("KinChatService.org")),
          );
          const named = ({ agentId, displayName, retiredAt }: (typeof agents)[number]) => ({
            agentId,
            displayName,
            retired: retiredAt !== null,
          });
          return {
            ...org,
            agents: agents.filter(({ agentId }) => visible.has(agentId)).map(named),
            otherAgents: agents.filter(({ agentId }) => !visible.has(agentId)).map(named),
          };
        }),
      );
      const me = yield* Effect.forEach(identities, ({ orgId, personId }) =>
        repo.getPerson({ orgId, personId }).pipe(
          Effect.map((person) => ({
            orgId,
            personId,
            ...(Option.isSome(person) ? { displayName: person.value.displayName } : {}),
          })),
        ),
      );
      return { orgs, me };
    }),
    mute: Effect.fn("KinChatService.mute")(function* (caller, input) {
      const identity = yield* personFor(caller, input);
      const member = yield* memberFor(identity, input.chatId);
      const mutedUntil = input.muted ? KIN_MUTED_FOREVER : null;
      if (member.mutedUntil === mutedUntil) return member;
      const updated = yield* requireRecord(repo.setMute({ ...member, mutedUntil }));
      yield* hub.publish({
        type: "member.updated",
        orgId: identity.orgId,
        chatId: input.chatId,
        member: updated,
      });
      return updated;
    }, transaction),
    clear: Effect.fn("KinChatService.clear")(function* (caller, input) {
      const identity = yield* personFor(caller, input);
      const member = yield* memberFor(identity, input.chatId);
      const chat = yield* requireRecord(repo.getChat(member));
      if (chat.archivedAt !== null) return yield* notFound;
      const people = (yield* repo.listMembers(chat)).filter(
        (row) => row.leftAt === null && row.principal._tag === "person",
      );
      // Read from stored rows: a direct chat is its one person's, a group the organisation
      // owner's. Being in a chat with others is never enough.
      const allowed =
        chat.kind === "direct"
          ? people.length === 1
          : member.role === "owner" &&
            (yield* isOrgOwner(identity.orgId, identity.personId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.mapError(toPersistenceSqlError("KinChatService.clear")),
            ));
      if (!allowed)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner can clear this chat.",
        });
      if (input.preview === true) return { keptFiles: yield* repo.docKeptFiles(chat) };
      const clearedAtMs = yield* Clock.currentTimeMillis;
      const cleared = yield* repo.clearChat({
        orgId: chat.orgId,
        chatId: chat.chatId,
        clearedAt: DateTime.formatIso(DateTime.makeUnsafe(clearedAtMs)),
        clearedAtMs,
      });
      for (const item of cleared.waiting)
        yield* hub.publish({ type: "waiting.updated", orgId: chat.orgId, item });
      if (cleared.endedSuggestion) yield* refresh.touch(chat.orgId, "recommendations");
      yield* hub.publish({
        type: "chat.cleared",
        orgId: chat.orgId,
        chatId: chat.chatId,
        lastSeq: cleared.lastSeq,
        lastChangeSeq: cleared.lastChangeSeq,
      });
      // Nothing below can undo the clear, so none of it may fail it.
      yield* sql.afterCommit(
        Effect.gen(function* () {
          for (const card of cleared.taskCards) {
            const task = yield* TaskCard.decodeTaskCardEffect(card.state).pipe(Effect.option);
            if (Option.isSome(task) && task.value.threadId !== null)
              yield* cards.untrack(task.value.threadId, card.widgetId);
          }
          if (Option.isSome(stop))
            yield* stop.value.abortTurns(chat.orgId, cleared.abortedWakeupIds);
          if (Option.isSome(presence))
            for (const agentId of cleared.agentIds)
              yield* syncQueued(presence.value, chat.orgId, agentId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
          if (Option.isSome(attachmentStore))
            yield* attachmentStore.value.remove(cleared.attachmentIds);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin clear chat follow-up failed", {
              orgId: chat.orgId,
              chatId: chat.chatId,
              cause,
            }),
          ),
        ),
      );
      return { keptFiles: cleared.keptFiles };
    }, transaction),
    leaveChat: Effect.fn("KinChatService.leaveChat")(function* (identity, input) {
      const caller = yield* memberFor(identity, input.chatId);
      if (caller.role !== "owner") return yield* notAllowed;
      const member = yield* requireRecord(
        repo.getMember({ orgId: identity.orgId, memberId: input.memberId }),
      );
      if (member.chatId !== input.chatId) return yield* notFound;
      if (member.role === "owner") return yield* notAllowed;
      for (const item of yield* repo.leaveChat({ ...member, leftAt: yield* now }))
        yield* hub.publish({ type: "waiting.updated", orgId: identity.orgId, item });
      const removed = yield* requireRecord(repo.getMember(member));
      yield* hub.publish({ type: "member.removed", orgId: identity.orgId, member: removed });
    }, transaction),
    subscribe: (caller, input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const identity = yield* personFor(caller, input);
          const live = yield* hub.subscribeForViewer(identity);
          const member = yield* memberFor(identity, input.chatId);
          const viewed = Effect.fn("KinChatService.viewed")(function* <
            T extends {
              readonly messages: ReadonlyArray<KinMessage>;
              readonly widgets: ReadonlyArray<KinWidget>;
            },
          >(page: T) {
            return {
              ...page,
              ...(yield* docsForViewer(identity.orgId, identity, page).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.mapError(toPersistenceSqlError("KinChatService.privateDocs")),
              )),
            };
          });
          const resumed = yield* viewed(
            yield* repo.resume({
              ...member,
              afterSeq: input.afterSeq ?? 0,
              afterChangeSeq: input.afterChangeSeq,
            }),
          );
          const backlog: KinChatStreamEvent = resumed.reset
            ? {
                _tag: "reset",
                lastSeq: resumed.lastSeq,
                lastChangeSeq: resumed.lastChangeSeq,
                ...(resumed.cleared === true ? { cleared: true } : {}),
                ...clearedAt(resumed.clearedSeq),
              }
            : {
                _tag: "backlog",
                lastSeq: resumed.lastSeq,
                lastChangeSeq: resumed.lastChangeSeq,
                ...clearedAt(resumed.clearedSeq),
                messages: resumed.messages,
                widgets: resumed.widgets,
                // The chat's live reactions in full, so a resumed client drops withdrawn ones.
                reactions: yield* Reactions.liveReactions({
                  orgId: identity.orgId,
                  chatId: input.chatId,
                  viewerMemberId: member.memberId,
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                ...(Option.isSome(presence)
                  ? yield* presence.value.snapshot(identity.orgId, input.chatId)
                  : {}),
              };
          const messageChanges = new Map<string, number>();
          const revisions = new Map(
            backlog._tag === "backlog" ? backlog.widgets.map((w) => [w.widgetId, w.revision]) : [],
          );
          let cursor = { lastSeq: resumed.lastSeq, lastChangeSeq: resumed.lastChangeSeq };
          let delivered = 0;
          const checkpoint = Effect.fn("KinChatService.subscribeCheckpoint")(function* () {
            const next = yield* viewed(
              yield* repo.resume({
                ...member,
                afterSeq: cursor.lastSeq,
                afterChangeSeq: cursor.lastChangeSeq,
              }),
            );
            cursor = { lastSeq: next.lastSeq, lastChangeSeq: next.lastChangeSeq };
            delivered = 0;
            if (next.cleared === true) {
              messageChanges.clear();
              revisions.clear();
            }
            if (next.reset)
              return {
                _tag: "reset",
                ...cursor,
                ...(next.cleared === true ? { cleared: true } : {}),
                ...clearedAt(next.clearedSeq),
              } satisfies KinChatStreamEvent;
            // The client already holds rows and widgets at the versions this stream delivered.
            const messages = next.messages.filter(
              (m) => (m.changeSeq ?? m.seq) !== messageChanges.get(m.messageId),
            );
            const widgets = next.widgets.filter(
              (w) => w.revision > (revisions.get(w.widgetId) ?? 0),
            );
            for (const m of messages) messageChanges.set(m.messageId, m.changeSeq ?? m.seq);
            for (const w of widgets) revisions.set(w.widgetId, w.revision);
            return { _tag: "backlog", ...cursor, messages, widgets } satisfies KinChatStreamEvent;
          });
          return Stream.concat(
            Stream.succeed(backlog),
            live.pipe(
              Stream.map((event) => {
                switch (event.type) {
                  case "message.posted":
                  case "message.changed": {
                    const change = event.message.changeSeq ?? event.message.seq;
                    if (
                      event.message.chatId !== input.chatId ||
                      change <= cursor.lastChangeSeq ||
                      change <= (messageChanges.get(event.message.messageId) ?? 0)
                    )
                      return Option.none();
                    messageChanges.set(event.message.messageId, change);
                    return Option.some<KinChatStreamEvent>({
                      _tag: "message",
                      message: event.message,
                    });
                  }
                  case "widget.updated": {
                    if (
                      event.widget.chatId !== input.chatId ||
                      event.widget.revision <= (revisions.get(event.widget.widgetId) ?? 0)
                    )
                      return Option.none();
                    revisions.set(event.widget.widgetId, event.widget.revision);
                    return Option.some<KinChatStreamEvent>({
                      _tag: "widget",
                      widget: event.widget,
                    });
                  }
                  case "chat.cleared": {
                    // One already behind this stream's start was answered by its first event.
                    if (
                      event.chatId !== input.chatId ||
                      event.lastChangeSeq <= cursor.lastChangeSeq
                    )
                      return Option.none();
                    cursor = { lastSeq: event.lastSeq, lastChangeSeq: event.lastChangeSeq };
                    delivered = 0;
                    messageChanges.clear();
                    revisions.clear();
                    return Option.some<KinChatStreamEvent>({
                      _tag: "reset",
                      ...cursor,
                      cleared: true,
                      ...clearedAt(event.lastSeq),
                    });
                  }
                  case "member.removed":
                  case "member.updated":
                    return event.member.chatId === input.chatId
                      ? Option.some<KinChatStreamEvent>({ _tag: "member", member: event.member })
                      : Option.none();
                  case "presence.updated":
                    return event.chatId === input.chatId
                      ? Option.some<KinChatStreamEvent>({
                          _tag: "presence",
                          agentId: event.agentId,
                          presence: event.presence,
                        })
                      : Option.none();
                  case "draft.updated":
                    return event.chatId === input.chatId
                      ? Option.some<KinChatStreamEvent>({ _tag: "draft", ...event.draft })
                      : Option.none();
                  case "reaction.updated":
                    return event.chatId === input.chatId
                      ? Option.some<KinChatStreamEvent>({
                          _tag: "reaction",
                          reaction: event.reaction,
                        })
                      : Option.none();
                  case "read.updated":
                    return event.chatId === input.chatId
                      ? Option.some<KinChatStreamEvent>({
                          _tag: "read",
                          memberId: event.memberId,
                          seq: event.seq,
                        })
                      : Option.none();
                  default:
                    return Option.none();
                }
              }),
              Stream.filter(Option.isSome),
              Stream.map((event) => event.value),
              Stream.mapEffect((event) =>
                event._tag === "message" || event._tag === "widget"
                  ? viewed({
                      messages: event._tag === "message" ? [event.message] : [],
                      widgets: event._tag === "widget" ? [event.widget] : [],
                    }).pipe(
                      Effect.map((page): KinChatStreamEvent =>
                        event._tag === "message"
                          ? { ...event, message: page.messages[0]! }
                          : { ...event, widget: page.widgets[0]! },
                      ),
                    )
                  : Effect.succeed(event),
              ),
              // Widget writes bump their anchor's change_seq, so they count toward the refresh too.
              // The dedupe state above is updated per event; the hub delivers one event per chunk.
              Stream.mapEffect((event) =>
                (event._tag === "message" || event._tag === "widget") &&
                ++delivered >= checkpointEvery
                  ? checkpoint().pipe(
                      Effect.map((next) => [event, next]),
                      // A member who just left gets not_found; the member event that follows ends the stream.
                      Effect.catchIf(
                        (error) => isKinChatError(error) && error.reason === "not_found",
                        () => Effect.succeed([event]),
                      ),
                    )
                  : Effect.succeed([event]),
              ),
              Stream.flattenIterable,
              // Only the viewer's own leaving ends their stream; the others stay in the chat.
              Stream.takeUntil(
                (event) =>
                  event._tag === "member" &&
                  event.member.leftAt !== null &&
                  event.member.memberId === member.memberId,
              ),
            ),
          );
        }),
      ),
    subscribeChats: (identities, input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const viewers =
            input.orgId === undefined
              ? identities
              : identities.filter((identity) => identity.orgId === input.orgId);
          if (input.orgId !== undefined && viewers.length === 0) return yield* notFound;
          const streams = yield* Effect.forEach(viewers, (viewer) =>
            hub
              .subscribeForViewer(viewer)
              .pipe(
                Effect.map((stream) => stream.pipe(Stream.map((event) => ({ viewer, event })))),
              ),
          );
          const initial = yield* snapshot(viewers);
          const summaries = new Map(
            initial.chats.map((chat) => [`${chat.orgId}:${chat.chatId}`, JSON.stringify(chat)]),
          );
          const waiting = new Map(
            initial.waiting.map((item) => [item.waitingId, JSON.stringify(item)]),
          );
          const live = Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
            Stream.mapEffect(({ viewer, event }) =>
              Effect.gen(function* (): Effect.fn.Return<KinChatListEvent, ServiceError> {
                // Reactions, draft deltas and a message read anew don't change a chat's row.
                if (
                  event.type === "reaction.updated" ||
                  event.type === "draft.updated" ||
                  event.type === "message.changed"
                )
                  return yield* notFound;
                if (event.type === "waiting.updated")
                  return yield* requireRecord(repo.getWaiting(event.item)).pipe(
                    Effect.map((item) => ({ _tag: "waiting" as const, item })),
                  );
                // The viewer was taken out, or the group ended: the row leaves their list.
                if (event.type === "member.removed") {
                  const chat = yield* requireRecord(repo.getChat(event.member));
                  return {
                    _tag: "chat" as const,
                    chat: { ...chat, members: [event.member], lastMessage: null, unread: 0 },
                  };
                }
                const chatId =
                  event.type === "chat.created"
                    ? event.chat.chatId
                    : event.type === "message.posted"
                      ? event.message.chatId
                      : event.type === "widget.updated"
                        ? event.widget.chatId
                        : event.chatId;
                return yield* summary(viewer, chatId).pipe(
                  Effect.map((chat) => ({ _tag: "chat" as const, chat })),
                );
              }).pipe(
                Effect.asSome,
                Effect.catch((error) =>
                  Effect.logDebug("Kin chat list event dropped", error).pipe(
                    Effect.as(Option.none()),
                  ),
                ),
              ),
            ),
            Stream.filter(Option.isSome),
            Stream.map((event) => event.value),
          );
          return Stream.concat(
            Stream.succeed(initial),
            live.pipe(
              Stream.filter((event) => {
                if (event._tag === "chat") {
                  const key = `${event.chat.orgId}:${event.chat.chatId}`;
                  const value = JSON.stringify(event.chat);
                  if (summaries.get(key) === value) return false;
                  summaries.set(key, value);
                } else if (event._tag === "waiting") {
                  const value = JSON.stringify(event.item);
                  if (waiting.get(event.item.waitingId) === value) return false;
                  waiting.set(event.item.waitingId, value);
                }
                return true;
              }),
            ),
          );
        }),
      ),

    createDirect: Effect.fn("KinChatService.createDirect")(function* (identity, input) {
      identity = yield* personFor(identity, input);
      if (identity.orgId !== input.orgId) return yield* notFound;
      const person = yield* requireRecord(repo.getPerson(identity));
      const agent = yield* requireRecord(repo.getAgent(input));
      if (agent.retiredAt !== null) return yield* notAllowed;
      const own = ownsAgent(agent, person.personId);
      // Someone else's lead: a co-owner messages every one, anyone else while its owner allows.
      if (
        !own &&
        !(yield* ownerLevel(input.orgId, person.personId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinChatService.createDirect")),
        )) &&
        !(yield* LeadAccess.allowed({ ...input, personId: person.personId }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinChatService.createDirect")),
        ))
      )
        return yield* notAllowed;
      const chatId = yield* decodeChatId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
      const chat = yield* repo.createChat({
        orgId: identity.orgId,
        chatId,
        kind: "direct",
        directKey: LeadAccess.directKey(person.personId, agent.agentId),
        title: null,
        teamId: null,
        lastMessageAt: null,
        createdAt: yield* now,
        archivedAt: null,
      });
      // The chat's owner role carries the lead's owner's rights, so a teammate is a member.
      const role = own ? "owner" : "member";
      if (chat.chatId !== chatId) {
        if (own) {
          yield* memberFor(identity, chat.chatId);
          return chat;
        }
        // Allowed again after being taken out: the same chat, open for writing once more.
        const mine = (yield* repo.listMembers(chat)).find(
          (member) =>
            member.principal._tag === "person" && member.principal.personId === person.personId,
        );
        if (mine === undefined) return yield* notFound;
        if (mine.leftAt === null && mine.role === "member") return chat;
        const back =
          mine.leftAt === null
            ? yield* requireRecord(repo.setRole({ ...mine, role: "member" }))
            : yield* repo.addMember({
                ...mine,
                role: "member",
                joinedAt: yield* now,
                leftAt: null,
                mutedUntil: null,
              });
        yield* hub.publish({
          type: "member.updated",
          orgId: chat.orgId,
          chatId: chat.chatId,
          member: back,
        });
        return chat;
      }
      for (const principal of [
        { _tag: "person", personId: person.personId },
        { _tag: "agent", agentId: agent.agentId },
      ] as const) {
        yield* repo.addMember({
          orgId: chat.orgId,
          chatId: chat.chatId,
          memberId: yield* decodeMemberId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          principal,
          role: principal._tag === "person" ? role : "member",
          joinedAt: chat.createdAt,
          leftAt: null,
          mutedUntil: null,
        });
      }
      yield* hub.publish({ type: "chat.created", orgId: identity.orgId, chat });
      return chat;
    }, transaction),
    attachmentReadable: Effect.fn("KinChatService.attachmentReadable")(
      function* (caller, attachmentId) {
        // Anyone's current picture is for everyone in their org.
        const orgs = "_tag" in caller ? [caller.orgId] : caller.map((viewer) => viewer.orgId);
        const pictures = yield* sql`SELECT 1 FROM kin_people
          WHERE org_id IN ${sql.in(orgs)} AND lower(avatar_attachment_id) = ${attachmentId}
          LIMIT 1`.pipe(
          Effect.mapError(toPersistenceSqlError("KinChatService.attachmentReadable")),
        );
        if (pictures.length > 0) return true;
        const owner = yield* repo.attachmentChat(attachmentId);
        if (Option.isNone(owner)) return yield* docFileReadable(caller, attachmentId);
        const identity =
          "_tag" in caller ? caller : caller.find((viewer) => viewer.orgId === owner.value.orgId);
        if (identity === undefined || identity.orgId !== owner.value.orgId) return false;
        const members = yield* repo.listMembers(owner.value);
        const member = members.find(
          (member) =>
            member.leftAt === null &&
            member.principal._tag === "person" &&
            member.principal.personId === identity.personId,
        );
        // A file on a message from before they joined is not theirs to fetch.
        if (member !== undefined && (yield* readable(member, owner.value.messageId))) return true;
        return yield* docFileReadable(caller, attachmentId);
      },
    ),
    extendReply: Effect.fn("KinChatService.extendReply")(
      function* (agent, input) {
        if (agent.wakeupId === undefined) return yield* notAllowed;
        const member = yield* memberFor(agent, input.chatId);
        yield* canWrite(agent, member);
        const message = yield* repo.extendAgentReply({
          ...input,
          orgId: agent.orgId,
          agentId: agent.agentId,
          threadId: agent.threadId,
          wakeupId: agent.wakeupId,
          audience: yield* authorAudience(agent),
        });
        yield* sql.afterCommit(
          hub.publish({ type: "message.posted", orgId: agent.orgId, message }),
        );
        return message;
      },
      (effect) => transaction(effect),
    ),
    send: Effect.fn("KinChatService.send")(function* (caller, input) {
      const requested = input.attachments ?? [];
      if (requested.length === 0) return yield* sendClaimed(caller, input, []);
      // Files are copied before the message's transaction, never inside it.
      const identity = yield* identityFor(caller, input);
      if (identity._tag !== "person") return yield* invalidState;
      const member = yield* memberFor(identity, input.chatId);
      yield* canWrite(identity, member);
      const sent = repo.findClientMessage({
        orgId: identity.orgId,
        chatId: input.chatId,
        memberId: member.memberId,
        kind: "send",
        clientId: input.clientMessageId,
      });
      const existing = yield* sent;
      // A resend finds its message and its files already kept.
      if (Option.isSome(existing))
        return yield* sendClaimed(identity, input, existing.value.attachments ?? []);
      if (Option.isNone(attachmentStore))
        return yield* new KinChatError({
          reason: "unavailable",
          message: "Attachments are unavailable.",
        });
      if (input.uploader === undefined) return yield* invalidState;
      const store = attachmentStore.value;
      const claimed = yield* store.claim(requested, input.uploader);
      return yield* sendClaimed(identity, input, claimed.attachments).pipe(
        Effect.tap((message) =>
          message.attachments?.[0]?.id === claimed.attachments[0]?.id
            ? store.discardPending(requested)
            : store.release(claimed),
        ),
        // An interrupted send may still have committed; its files go only if no message has them.
        Effect.onError(() =>
          sent.pipe(
            Effect.flatMap((written) =>
              Option.isNone(written) ? store.release(claimed) : Effect.void,
            ),
            Effect.ignore,
          ),
        ),
      );
    }),
    read: Effect.fn("KinChatService.read")(function* (identity, input) {
      const request = yield* decodeRead(input).pipe(Effect.mapError(() => invalidState));
      const member = yield* memberFor(identity, request.chatId);
      if (identity._tag === "agent" && !(yield* leadMayRead(identity, request.chatId)))
        return yield* notFound;
      const viewer = yield* docViewer(identity);
      const messages = yield* repo.messagesAfter({
        orgId: identity.orgId,
        chatId: request.chatId,
        afterSeq: request.afterSeq ?? 0,
        limit: request.limit ?? 50,
        viewerMemberId: member.memberId,
        // Whatever page it asks for, a shared turn sees nothing below the chat's history floor.
        fromHistoryFloor: "sharedTurn" in viewer && viewer.sharedTurn,
      });
      return (yield* docsForViewer(identity.orgId, viewer, { messages, widgets: [] }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(toPersistenceSqlError("KinChatService.privateDocs")),
      )).messages;
    }, transaction),
    history: Effect.fn("KinChatService.history")(
      function* (identity, input) {
        identity = yield* identityFor(identity, input);
        const member = yield* memberFor(identity, input.chatId);
        const stored = yield* repo.history({
          ...input,
          orgId: identity.orgId,
          viewerMemberId: member.memberId,
        });
        const page = {
          ...stored,
          ...(yield* docsForViewer(identity.orgId, yield* docViewer(identity), stored).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.mapError(toPersistenceSqlError("KinChatService.privateDocs")),
          )),
        };
        return {
          ...page,
          reactions: yield* Reactions.liveReactions({
            orgId: identity.orgId,
            chatId: input.chatId,
            messageIds: page.messages.map((message) => message.messageId),
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        };
      },
      (effect) => transaction(effect).pipe(NodeSqliteClient.readOnly),
    ),
    markRead: Effect.fn("KinChatService.markRead")(function* (identity, input) {
      identity = yield* identityFor(identity, input);
      const member = yield* memberFor(identity, input.chatId);
      const previous = yield* repo.getReadState(member);
      yield* repo.markRead({ ...member, seq: input.seq, updatedAt: yield* now });
      const updated = yield* requireRecord(repo.getReadState(member));
      if (Option.isNone(previous) || updated.lastReadSeq !== previous.value.lastReadSeq)
        yield* hub.publish({
          type: "read.updated",
          orgId: identity.orgId,
          chatId: input.chatId,
          memberId: member.memberId,
          seq: updated.lastReadSeq,
        });
    }, transaction),
    createTaskCard: Effect.fn("KinChatService.createTaskCard")(function* (input) {
      if (input.orgId !== "kin-default") return yield* notFound;
      const environment = yield* ServerEnvironment;
      const orchestrator = yield* OrchestratorV2;
      const shell = yield* orchestrator
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) return yield* notFound;
      const agent = yield* requireRecord(
        repo.getAgent({ orgId: input.orgId, agentId: input.authorAgentId }),
      );
      if (agent.role !== "lead" || agent.retiredAt !== null) return yield* notFound;
      yield* requireRecord(repo.getChat(input));
      const member = (yield* repo.listMembers(input)).find(
        (member) =>
          member.leftAt === null &&
          member.principal._tag === "agent" &&
          member.principal.agentId === agent.agentId,
      );
      const thread = (yield* repo.listActiveAgentThreads()).find(
        (thread) => thread.orgId === input.orgId && thread.agentId === agent.agentId,
      );
      if (member === undefined || thread === undefined) return yield* notFound;
      const widgetId = yield* taskCardWidgetId(input);
      const clientId = yield* encodeAction([
        input.threadId,
        input.authorAgentId,
        input.title,
        input.model,
      ]).pipe(Effect.orDie);
      const existing = yield* repo.getWidget({ ...input, widgetId });
      if (Option.isSome(existing)) {
        const original = yield* repo.findClientMessage({
          ...input,
          memberId: member.memberId,
          kind: "task-card",
          clientId,
        });
        if (Option.isNone(original) || original.value.messageId !== existing.value.messageId)
          return yield* notAllowed;
        return existing.value;
      }
      const updatedAt = yield* now;
      const state = yield* TaskCard.decodeTaskCardEffect({
        taskId: input.taskId ?? input.threadId,
        environmentId: yield* environment.getEnvironmentId,
        threadId: input.threadId,
        remoteEnvironmentId: null,
        title: input.title,
        model: input.model,
        status: "waiting",
        pullRequests: [],
        lastError: null,
        updatedAt,
      }).pipe(Effect.mapError(() => invalidState));
      const message = yield* repo.insertMessage({
        orgId: input.orgId,
        chatId: input.chatId,
        audience: input.audience,
        messageId: KinMessageId.make(SecureRandom.uuidV4Unsafe()),
        author: {
          _tag: "agent",
          agentId: agent.agentId,
          ownerPersonId: agent.ownerPersonId,
          threadId: thread.threadId,
          memberId: member.memberId,
        },
        serverPosted: true,
        body: "",
        intent: "answer",
        kind: "text",
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: { kind: "task-card", id: clientId },
        createdAt: updatedAt,
        editedAt: null,
      });
      const widget: KinWidget = {
        orgId: input.orgId,
        chatId: input.chatId,
        widgetId,
        messageId: message.messageId,
        widgetClass: "native",
        type: "task",
        revision: 1,
        state: TaskCard.taskCardState(state, shell, updatedAt),
        source: null,
        feed: null,
        awaiting: [],
        pinnedAt: null,
        closedAt: null,
        updatedAt,
      };
      yield* repo.insertWidget({ ...widget, audience: input.audience });
      const anchor = yield* requireRecord(
        repo.getMessage({ ...input, messageId: message.messageId }),
      );
      yield* hub.publish({ type: "message.posted", orgId: input.orgId, message: anchor });
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
      yield* sql.afterCommit(cards.track(widget));
      return widget;
    }, transaction),
    closeReplaced: Effect.fn("KinChatService.closeReplaced")(function* (input) {
      const existing = yield* repo.getWidget(input);
      if (Option.isNone(existing) || existing.value.type !== "choice") return;
      const card = yield* decodeChoiceCard(existing.value.state).pipe(
        Effect.mapError(() => invalidState),
      );
      if (card.answer !== null || existing.value.closedAt !== null) return;
      const at = yield* now;
      const widget = yield* repo.updateWidget({
        ...existing.value,
        // Closing writes no words.
        audience: "chat",
        state:
          input.outcome === undefined
            ? { ...card, replaced: true }
            : { ...card, outcome: input.outcome },
        awaiting: [],
        expectedRevision: existing.value.revision,
        closedAt: at,
        updatedAt: at,
      });
      for (const item of yield* repo.waitingForWidget(widget)) yield* resolve(item, "closed");
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
    }, transaction),
    reopenClosed: Effect.fn("KinChatService.reopenClosed")(function* (input) {
      const existing = yield* repo.getWidget(input);
      if (Option.isNone(existing) || existing.value.type !== "choice") return false;
      const card = yield* decodeChoiceCard(existing.value.state).pipe(
        Effect.mapError(() => invalidState),
      );
      if (card.answer !== null || existing.value.closedAt === null || card.outcome === undefined)
        return false;
      const { outcome: _outcome, ...asked } = card;
      const at = yield* now;
      const widget = yield* repo.updateWidget({
        ...existing.value,
        audience: "chat",
        state: asked,
        awaiting: input.awaiting,
        expectedRevision: existing.value.revision,
        closedAt: null,
        updatedAt: at,
      });
      for (const personId of new Set(widget.awaiting)) {
        const item: KinWaitingItem = {
          orgId: input.orgId,
          chatId: widget.chatId,
          waitingId: yield* decodeWaitingId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          personId,
          messageId: widget.messageId,
          widgetId: widget.widgetId,
          reason: "question",
          createdAt: at,
          resolvedAt: null,
          resolution: null,
        };
        if (yield* repo.addWaiting(item)) {
          const added = Option.getOrElse(yield* repo.getWaiting(item), () => item);
          yield* hub.publish({ type: "waiting.updated", orgId: input.orgId, item: added });
        }
      }
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
      return true;
    }, transaction),
    setSendOutcome: Effect.fn("KinChatService.setSendOutcome")(function* (input) {
      const existing = yield* requireRecord(
        repo.getWidget({ orgId: input.orgId, widgetId: input.widgetId }),
      );
      if (existing.type !== "choice") return yield* notFound;
      const card = yield* decodeChoiceCard(existing.state).pipe(
        Effect.mapError(() => invalidState),
      );
      if (card.send === undefined) return yield* notFound;
      const updatedAt = yield* now;
      const widget = yield* repo.updateWidget({
        ...existing,
        audience: input.audience ?? "owner",
        state: { ...card, send: { ...card.send, outcome: input.outcome } },
        expectedRevision: existing.revision,
        updatedAt,
      });
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
      return widget;
    }, transaction),
    setSendCard: Effect.fn("KinChatService.setSendCard")(function* (input) {
      const existing = yield* requireRecord(
        repo.getWidget({ orgId: input.orgId, widgetId: input.widgetId }),
      );
      if (existing.type !== "choice") return yield* notFound;
      const card = yield* decodeChoiceCard(existing.state).pipe(
        Effect.mapError(() => invalidState),
      );
      if (card.send === undefined) return yield* notFound;
      if (
        existing.revision !== input.revision ||
        card.answer !== null ||
        existing.closedAt !== null
      )
        return yield* new KinChatError({
          reason: "widget_changed",
          message: "This card changed or was answered. Look at it again.",
        });
      const widget = yield* repo.updateWidget({
        ...existing,
        audience: "owner",
        state: { ...card, detail: input.detail, send: input.send },
        expectedRevision: existing.revision,
        updatedAt: existing.updatedAt,
      });
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
      return widget;
    }, transaction),
    upsertWidget: Effect.fn("KinChatService.upsertWidget")(function* (identity, input) {
      const member = yield* memberFor(identity, input.chatId);
      yield* canWrite(identity, member);
      if (input.type === "approval")
        return yield* new KinChatError({
          reason: "use_approvals",
          message: "Use the signed approvals service.",
        });
      if (
        input.type === "owner_check" ||
        input.type === "deferral" ||
        // Only Kin draws Social's cards, from its stored drafts and the service's own names.
        input.type === KIN_SOCIAL_WEEK_CARD ||
        input.type === KIN_SOCIAL_PACK_CARD ||
        // Only kin_ask posts one, and only a tap answers it.
        input.type === "choice" ||
        // Only the doc tools post one, from the stored doc.
        input.type === KIN_DOC_CARD ||
        // Only kin_chart posts one, and it never changes.
        input.type === "chart" ||
        // Only kin_visual posts one, and its page is stored once.
        input.type === KIN_VISUAL_CARD_TYPE ||
        (input.type === "task" && input.widgetId === undefined)
      )
        return yield* notAllowed;
      let state = yield* validateState(input.type, input.state);
      const audience = yield* authorAudience(identity);
      let widget: KinWidget;
      if (input.widgetId === undefined) {
        if (input.revision !== undefined) return yield* invalidState;
        const message = yield* post(identity, member, {
          chatId: input.chatId,
          body: "",
          intent: identity._tag === "agent" ? "answer" : null,
          kind: "text",
          mentions: [],
          replyTo: input.replyTo ?? null,
          widgetId: null,
          clientId: null,
          publish: false,
        });
        widget = {
          orgId: identity.orgId,
          chatId: input.chatId,
          widgetId: yield* decodeWidgetId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie),
          messageId: message.messageId,
          widgetClass: "native",
          type: input.type,
          revision: 1,
          state,
          source: null,
          feed: null,
          awaiting: input.closed === true ? [] : (input.awaiting ?? []),
          pinnedAt: null,
          closedAt: input.closed === true ? yield* now : null,
          updatedAt: yield* now,
        };
        yield* repo.insertWidget({ ...widget, audience });
        const anchor = yield* requireRecord(
          repo.getMessage({ orgId: identity.orgId, messageId: message.messageId }),
        );
        yield* hub.publish({ type: "message.posted", orgId: identity.orgId, message: anchor });
      } else {
        const existing = yield* requireRecord(
          repo.getWidget({ orgId: identity.orgId, widgetId: input.widgetId }),
        );
        if (existing.chatId !== input.chatId) return yield* notFound;
        if (identity._tag === "agent") {
          const anchor = yield* requireRecord(
            repo.getMessage({ orgId: identity.orgId, messageId: existing.messageId }),
          );
          if (anchor.author._tag !== "agent" || anchor.author.memberId !== member.memberId)
            return yield* notAllowed;
          // Its server-held fields come back to the caller, so a shared turn reads it first.
          if (!(yield* callerReads(identity, member, existing.messageId))) return yield* notFound;
        }
        if (
          existing.type !== input.type ||
          input.revision === undefined ||
          input.replyTo !== undefined
        )
          return yield* invalidState;
        const awaiting =
          input.closed === true || (input.closed === undefined && existing.closedAt !== null)
            ? []
            : (input.awaiting ?? existing.awaiting);
        if (existing.type === "task") {
          const previous = yield* TaskCard.decodeTaskCardEffect(existing.state).pipe(
            Effect.mapError(() => invalidState),
          );
          const next = TaskCard.decodeTaskCard(state);
          if (
            previous.threadId !== next.threadId ||
            previous.taskId !== next.taskId ||
            previous.environmentId !== next.environmentId ||
            previous.remoteEnvironmentId !== next.remoteEnvironmentId
          )
            return yield* invalidState;
          state = {
            ...next,
            status: previous.status,
            pullRequests: previous.pullRequests,
            lastError: previous.lastError,
            updatedAt: previous.updatedAt,
          };
          if (
            existing.revision === input.revision + 1 &&
            TaskCard.taskCardEquivalent(TaskCard.decodeTaskCard(state), previous) &&
            awaiting.length === existing.awaiting.length &&
            awaiting.every((personId, index) => personId === existing.awaiting[index]) &&
            (input.closed === undefined || input.closed === (existing.closedAt !== null))
          )
            return existing;
        }
        widget = yield* repo.updateWidget({
          ...existing,
          audience,
          state,
          awaiting,
          expectedRevision: input.revision,
          closedAt:
            input.closed === undefined ? existing.closedAt : input.closed ? yield* now : null,
          updatedAt: yield* now,
        });
      }
      for (const item of yield* repo.waitingForWidget(widget)) {
        if (widget.closedAt !== null || !widget.awaiting.includes(item.personId))
          yield* resolve(item, widget.closedAt !== null ? "closed" : "superseded");
      }
      if (widget.closedAt === null)
        for (const personId of new Set(widget.awaiting))
          yield* add(identity, {
            chatId: widget.chatId,
            personId,
            messageId: widget.messageId,
            widgetId: widget.widgetId,
            reason: "decision",
          });
      yield* sql.afterCommit(cards.track(widget));
      yield* hub.publish({ type: "widget.updated", orgId: identity.orgId, widget });
      return widget;
    }, transaction),
    act: Effect.fn("KinChatService.act")(function* (identity, input) {
      identity = yield* personFor(identity, input);
      const request = yield* decodeAct(input).pipe(Effect.mapError(() => invalidState));
      const { widget, member } = yield* tapTarget(identity, request.widgetId);
      if (widget.type === "approval")
        return yield* new KinChatError({
          reason: "use_approvals",
          message: "Use the signed approvals service.",
        });
      const owning = yield* ownerSide(identity, member);
      if (widget.type === "owner_check") {
        if (!owning) return yield* notAllowed;
        const card = yield* decodeOwnerCheckCard(widget.state).pipe(
          Effect.mapError(() => invalidState),
        );
        if (
          !["keep", "update", "drop"].includes(request.actionId) ||
          !card.items.some((item) => item.itemId === request.value)
        )
          return yield* invalidState;
      }
      // Reminders and scheduled tasks act for the owner, so only the owner taps them, except a
      // reminder in someone's own direct chat: theirs to finish or snooze.
      if (
        (widget.type === "reminder" ||
          widget.type === "scheduled_task" ||
          widget.type === KIN_SOCIAL_WEEK_CARD ||
          widget.type === KIN_SOCIAL_PACK_CARD) &&
        !owning &&
        !(widget.type === "reminder" && (yield* ownDirectChat(identity, widget.chatId)))
      )
        return yield* notAllowed;
      // Any writing member of the card's chat may undo; the other taps wait on the dispatcher.
      if (
        widget.type === "deferral" &&
        request.actionId !== "undo" &&
        (!owning ||
          !deferralCardActionsReady ||
          !deferralCardActions.some((action) => action === request.actionId))
      )
        return yield* notAllowed;
      return yield* actOn(identity, member, widget, request, null);
    }, refusedAfter),
    canTap: Effect.fn("KinChatService.canTap")(function* (identity, input) {
      yield* tapTarget(identity, input.widgetId);
    }),
    react: Effect.fn("KinChatService.react")(function* (caller, input) {
      const request = yield* decodeReact({
        messageId: input.messageId,
        emoji: input.emoji,
        on: input.on,
      }).pipe(Effect.mapError(() => invalidState));
      let identity: Identity | undefined = "_tag" in caller ? caller : undefined;
      if (identity === undefined)
        for (const candidate of caller as Viewers)
          if (
            Option.isSome(yield* repo.getMessage({ ...candidate, messageId: request.messageId }))
          ) {
            identity = candidate;
            break;
          }
      if (identity === undefined) return yield* notFound;
      const message = yield* requireRecord(
        repo.getMessage({ orgId: identity.orgId, messageId: request.messageId }),
      );
      if (input.chatId !== undefined && message.chatId !== input.chatId) return yield* notFound;
      // Membership of the message's own chat: a non-member, or another org's caller, gets not_found.
      const member = yield* memberFor(identity, message.chatId);
      yield* canWrite(identity, member);
      if (!(yield* callerReads(identity, member, message.messageId))) return yield* notFound;
      if (message.status !== "posted") return yield* notAllowed;
      const widget =
        message.widgetId === null
          ? null
          : yield* requireRecord(
              repo.getWidget({ orgId: identity.orgId, widgetId: message.widgetId }),
            );
      // A reaction never grants anything: approval, level, review and other cards refuse it.
      if (
        (widget !== null &&
          (widget.chatId !== message.chatId || !REACTABLE_WIDGETS.has(widget.type))) ||
        (yield* repo.approvalAtMessage(message))
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "This card can't take reactions.",
        });
      const nowMs = yield* Clock.currentTimeMillis;
      const key = {
        orgId: identity.orgId,
        chatId: message.chatId,
        messageId: message.messageId,
        memberId: member.memberId,
        emoji: request.emoji,
      };
      const held = (yield* Reactions.liveReactions({
        ...key,
        messageIds: [message.messageId],
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql))).find(
        (row) => row.memberId === member.memberId && row.emoji === request.emoji,
      );
      // A retried add or remove changes nothing and answers nothing.
      if (request.on === (held !== undefined))
        return (
          held ??
          ({
            ...key,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
            removedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          } satisfies KinReaction)
        );
      let answered = false;
      if (request.on && identity._tag === "person" && widget?.type === "choice") {
        const card = yield* decodeChoice(widget.state).pipe(Effect.mapError(() => invalidState));
        const option = Reactions.reactionOption(card, request.emoji);
        if (option !== undefined) {
          if (card.answer !== null)
            return yield* new KinChatError({
              reason: "widget_changed",
              message: "This question was already answered.",
            });
          yield* actOn(
            identity,
            member,
            widget,
            {
              widgetId: widget.widgetId,
              revision: widget.revision,
              actionId: KIN_CHOICE_CARD_ACTION,
              value: option.optionId,
              clientActionId: `reaction:${message.messageId}:${request.emoji}`,
            },
            { emoji: request.emoji },
          );
          answered = true;
        }
      }
      const chat = yield* requireRecord(repo.getChat(member));
      const withSql = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      // In the owner's direct chat, a yes/no on the lead's latest message and a 👎 anywhere wake
      // the lead once. A changed answer on the message that last woke it (a yes withdrawn, or yes
      // to no and back) wakes it again, past the cooldown, a few times at most. Every other
      // reaction is feedback it reads on its next wake-up.
      const eligible =
        !answered &&
        identity._tag === "person" &&
        chat.kind === "direct" &&
        (yield* ownerSide(identity, member)) &&
        message.author._tag === "agent" &&
        nowMs - Date.parse(message.createdAt) < SOFT_REPLY_WINDOW_MS;
      const answer = Reactions.reactionAnswer(request.emoji);
      const past = eligible ? yield* withSql(Reactions.reactionWake(message)) : undefined;
      const woke =
        eligible &&
        (past === undefined
          ? request.on &&
            (request.emoji === Reactions.KIN_CLARIFY_REACTION ||
              (answer !== null && (yield* isLatestLeadMessage(message)))) &&
            !(yield* withSql(Reactions.recentlyWoke({ ...key, now: nowMs })))
          : past.latest &&
            past.wakes < Reactions.KIN_REACTION_WAKES_PER_MESSAGE &&
            (request.on
              ? answer !== null && answer !== past.answer
              : answer === "yes" && past.answer === "yes"));
      if (woke)
        yield* withSql(
          Reactions.recordWake({ ...key, answer: request.on ? answer : null, now: nowMs }),
        );
      const changedFrom = woke && past !== undefined && request.on ? past.emoji : undefined;
      if (woke && identity._tag === "person")
        // The lead answers this turn under its own floor run, as it would a message.
        yield* floor.open(
          {
            ...message,
            author: { _tag: "human", personId: identity.personId, memberId: member.memberId },
            authorRole: member.role,
            mentions: [],
            body: "",
          },
          chat,
        );
      const { reaction, changed, replaced } = yield* withSql(
        Reactions.setReaction({ ...key, on: request.on, now: nowMs, woke }),
      );
      if (reaction === null) return yield* notFound;
      const by = authorFor(identity, member);
      for (const withdrawn of replaced)
        yield* hub.publish({
          type: "reaction.updated",
          orgId: identity.orgId,
          chatId: message.chatId,
          reaction: withdrawn,
          woke: false,
          by,
        });
      if (changed)
        yield* hub.publish({
          type: "reaction.updated",
          orgId: identity.orgId,
          chatId: message.chatId,
          reaction,
          woke,
          ...(changedFrom === undefined ? {} : { changedFrom }),
          by,
        });
      return reaction;
    }, transaction),
    ask: Effect.fn("KinChatService.ask")(
      (identity, input) =>
        Effect.andThen(
          input.recheck ?? Effect.void,
          postCard(identity, {
            chatId: input.chatId,
            clientMessageId: input.clientMessageId,
            type: "choice",
            intent: "question",
            state: validateState("choice", ChoiceCard.choiceCardState(input)),
            ...(input.forChat === true ? { forChat: true as const } : {}),
            silent: input.silent,
          }),
        ),
      transaction,
    ),
    replyCard: Effect.fn("KinChatService.replyCard")(function* (agent, chatId) {
      return agent.wakeupId === undefined
        ? null
        : yield* repo.replyCard({ ...agent, wakeupId: agent.wakeupId, chatId });
    }),
    setChoiceOutcome,
    settleFigures: Effect.fn("KinChatService.settleFigures")(function* (agent, chatId, intent) {
      for (const row of yield* figureRows(agent, chatId, true)) {
        const embed = yield* decodeEmbed(row.json).pipe(Effect.mapError(cardTapError));
        if (embed._tag === "broken") continue;
        const widget = yield* postCard(agent, {
          chatId,
          intent,
          clientMessageId: `kin-figure:${row.id}`,
          type: embed._tag === "chart" ? "chart" : KIN_VISUAL_CARD_TYPE,
          state: Effect.succeed(embed._tag === "chart" ? embed.chart : embed),
          ...(embed._tag === "visual" ? { file: embed.attachmentId } : {}),
        });
        yield* sql`UPDATE kin_turn_figures SET message_id = ${widget.messageId}
            WHERE org_id = ${agent.orgId} AND figure_id = ${row.id} AND message_id IS NULL`.pipe(
          Effect.mapError(toPersistenceSqlError("KinChatService.settleFigures")),
        );
      }
    }, transaction),
    discardFigures: Effect.fn("KinChatService.discardFigures")(function* (input) {
      const removed = yield* sql<{ attachmentId: string | null }>`DELETE FROM kin_turn_figures
        WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}
          AND wakeup_id = ${input.wakeupId} AND message_id IS NULL
          ${input.chatId === undefined ? sql`` : sql`AND chat_id = ${input.chatId}`}
        RETURNING attachment_id AS "attachmentId"`.pipe(
        Effect.mapError(toPersistenceSqlError("KinChatService.discardFigures")),
      );
      if (Option.isSome(attachmentStore))
        yield* attachmentStore.value.remove(
          removed.flatMap((row) => (row.attachmentId === null ? [] : [row.attachmentId])),
        );
      return removed.length;
    }),
    chart: Effect.fn("KinChatService.chart")(function* (identity, input) {
      const chart = yield* ChartCard.chartCardState(input);
      const wakeupId = yield* figureLane(identity, input.chatId);
      if (wakeupId !== null) {
        const { figure } = yield* stageFigure({ ...identity, wakeupId }, input, {
          _tag: "chart",
          chart,
        });
        return { figure };
      }
      return yield* postCard(identity, {
        chatId: input.chatId,
        clientMessageId: input.clientMessageId,
        type: "chart",
        intent: input.intent,
        state: validateState("chart", chart),
      });
    }, transaction),
    visual: Effect.fn("KinChatService.visual")(function* (identity, input) {
      const page = yield* VisualCard.visualPage(input);
      const member = yield* memberFor(identity, input.chatId);
      yield* canWrite(identity, member);
      const wanted = kinVisualFileReferences(page.html);
      if (wanted.length > 0) {
        const files = new Set((yield* repo.chatFiles(member)).map((file) => file.attachmentId));
        const missing = wanted.find((id) => !files.has(id));
        if (missing !== undefined)
          return yield* new KinChatError({
            reason: "invalid_state",
            message: `${KIN_VISUAL_FILE_SCHEME}${missing} is not a file in this chat. Use the id of an image, audio or video already sent here, or put your own image in the page as a data: URL.`,
          });
      }
      if (Option.isNone(attachmentStore))
        return yield* new KinChatError({
          reason: "unavailable",
          message: "Attachments are unavailable.",
        });
      const store = attachmentStore.value;
      // The server decides the label, from what the turn was shown; the agent has no say.
      const sensitive =
        identity.wakeupId !== undefined &&
        (yield* turnSensitive(identity.orgId, identity.wakeupId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinChatService.visual")),
        ));
      const attachmentId = yield* store.storePage(page.html);
      const embed = {
        _tag: "visual" as const,
        title: page.title,
        attachmentId,
        height: page.height,
        ...(sensitive ? { sensitive: true as const } : {}),
      };
      const use = Effect.gen(function* () {
        const wakeupId = yield* figureLane(identity, input.chatId);
        if (wakeupId !== null) {
          const { figure, kept } = yield* stageFigure({ ...identity, wakeupId }, input, embed);
          return { result: { figure }, kept };
        }
        const widget = yield* postCard(identity, {
          chatId: input.chatId,
          clientMessageId: input.clientMessageId,
          type: KIN_VISUAL_CARD_TYPE,
          intent: input.intent,
          state: validateState(KIN_VISUAL_CARD_TYPE, embed),
          file: attachmentId,
        });
        const state = widget.state;
        return {
          result: widget,
          kept:
            typeof state === "object" &&
            state !== null &&
            "attachmentId" in state &&
            state.attachmentId === attachmentId,
        };
      });
      return yield* transaction(use).pipe(
        Effect.tap(({ kept }) => (kept ? Effect.void : store.remove([attachmentId]))),
        Effect.onError(() => store.remove([attachmentId])),
        Effect.map(({ result }) => result),
      );
    }),
    visualSources: Effect.fn("KinChatService.visualSources")(function* (attachmentId) {
      const owner = yield* repo.attachmentChat(attachmentId);
      if (Option.isNone(owner))
        return yield* docPageSources(attachmentId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinChatService.visualSources")),
        );
      const files = yield* repo.chatFiles(owner.value);
      return Option.some({
        orgId: owner.value.orgId,
        files: files.flatMap((file) =>
          file.attachmentId === attachmentId
            ? []
            : [{ attachmentId: file.attachmentId, mimeType: file.mimeType }],
        ),
      });
    }),
    showCard: Effect.fn("KinChatService.showCard")(
      (identity, input) =>
        postCard(identity, {
          chatId: input.chatId,
          clientMessageId: input.clientMessageId,
          type: input.type,
          intent: "answer",
          state: validateState(input.type, input.state),
        }),
      transaction,
    ),
    addWaiting: Effect.fn("KinChatService.addWaiting")(function* (identity, input) {
      yield* memberFor(identity, input.chatId);
      if (input.reason === "approval") return yield* notAllowed;
      const message =
        input.messageId === null
          ? null
          : yield* requireRecord(
              repo.getMessage({ orgId: identity.orgId, messageId: input.messageId }),
            );
      if (message !== null && message.chatId !== input.chatId) return yield* notFound;
      if (message !== null && (yield* repo.approvalAtMessage(message))) return yield* notAllowed;
      for (const widgetId of new Set([input.widgetId, message?.widgetId ?? null])) {
        if (widgetId === null) continue;
        const widget = yield* requireRecord(repo.getWidget({ orgId: identity.orgId, widgetId }));
        if (widget.chatId !== input.chatId) return yield* notFound;
        if (widget.type === "approval" || (yield* repo.approvalAtMessage(widget)))
          return yield* notAllowed;
      }
      return yield* add(identity, input);
    }, transaction),
    resolveWaiting: Effect.fn("KinChatService.resolveWaiting")(function* (identity, input) {
      if (input.resolution.trim().length === 0) return yield* invalidState;
      const item = yield* requireRecord(
        repo.getWaiting({ orgId: identity.orgId, waitingId: input.waitingId }),
      );
      const member = yield* memberFor(identity, item.chatId);
      if (member.role === "guest" || item.reason === "approval") return yield* notAllowed;
      const message =
        item.messageId === null
          ? null
          : yield* requireRecord(
              repo.getMessage({ orgId: identity.orgId, messageId: item.messageId }),
            );
      if (message !== null && (yield* repo.approvalAtMessage(message))) return yield* notAllowed;
      for (const widgetId of new Set([item.widgetId, message?.widgetId ?? null])) {
        if (widgetId === null) continue;
        const widget = yield* requireRecord(repo.getWidget({ orgId: identity.orgId, widgetId }));
        if (widget.type === "approval" || (yield* repo.approvalAtMessage(widget)))
          return yield* notAllowed;
      }
      if (identity._tag === "agent") {
        if (item.reason !== "question" || message === null) return yield* notAllowed;
        if (message.author._tag !== "agent" || message.author.agentId !== identity.agentId)
          return yield* notAllowed;
      } else if (identity.personId !== item.personId && !(yield* ownerSide(identity, member))) {
        return yield* notAllowed;
      }
      return yield* resolve(item, input.resolution);
    }, transaction),
  });
});

export const layer = Layer.effect(KinChatService, make).pipe(
  Layer.provideMerge(TaskCard.layer),
  // Statement card taps open the floor from Work's RPCs, through `KinServer`'s services.
  Layer.provideMerge(Floor.layer),
);
