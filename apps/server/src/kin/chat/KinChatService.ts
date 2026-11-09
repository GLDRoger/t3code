import { JudgeShadow } from "../floor/JudgeShadow.ts";
import * as Floor from "../floor/KinFloor.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as TaskCard from "../widgets/taskCard.ts";
import {
  KIN_CHOICE_CARD_ACTION,
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinWaitingId,
  KinWidgetId,
  KinOwnerCheckCard,
  KinDeferralCard,
  KinMessagesReactInput,
  KinMessagesSendInput,
  KinWidgetsActInput,
  KinChoiceCardState,
  KinAgentIntent,
  type KinAuthor,
  type KinAgentId,
  type ThreadId,
  type KinChat,
  type KinChatListEvent,
  type KinChatStreamEvent,
  type KinChatSubscribeInput,
  type KinChatsSubscribeInput,
  type KinOrgsListResult,
  type KinChatSummary,
  type KinChatHistoryInput,
  type KinChatHistoryResult,
  type KinChatMember,
  type KinChatsCreateDirectInput,
  type KinMessage,
  type KinMessagesMarkReadInput,
  type KinPersonId,
  type KinOrgId,
  type KinReaction,
  type KinReactionEmoji,
  type KinWaitingItem,
  type KinWidget,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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
import * as ChoiceCard from "../widgets/choiceCard.ts";
import { undoDeferral } from "../triggers/KinTriggerService.ts";
import * as Hub from "./KinChatHub.ts";
import { KinPresence } from "../reply/KinPresence.ts";
import * as Repository from "./KinChatRepository.ts";
import type { AgentIdentity, PersonIdentity } from "./KinIdentity.ts";
import * as Reactions from "./reactions.ts";

type Identity = PersonIdentity | AgentIdentity;
type Viewers = ReadonlyArray<PersonIdentity>;
type Caller = Identity | Viewers;
type PersonCaller = PersonIdentity | Viewers;
type ServiceError = Repository.RepositoryError;
type SendInput = KinMessagesSendInput & {
  readonly intent?: KinAgentIntent;
  readonly floorGrant?: string | undefined;
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
type WaitingInput = Pick<
  KinWaitingItem,
  "chatId" | "personId" | "messageId" | "widgetId" | "reason"
>;

export class KinChatService extends Context.Service<
  KinChatService,
  {
    readonly notice: (input: {
      readonly messageId: KinMessageId;
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly body: string;
      readonly waitingFor?: KinPersonId;
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
    readonly leaveChat: (
      identity: PersonIdentity,
      input: { readonly chatId: KinChatId; readonly memberId: KinMemberId },
    ) => Effect.Effect<void, ServiceError>;
    readonly createDirect: (
      identity: PersonCaller,
      input: KinChatsCreateDirectInput,
    ) => Effect.Effect<KinChat, ServiceError>;
    readonly send: (identity: Caller, input: SendInput) => Effect.Effect<KinMessage, ServiceError>;
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
      readonly authorAgentId: KinAgentId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly model: string | null;
    }) => Effect.Effect<KinWidget, ServiceError, OrchestratorV2 | ServerEnvironment>;
    /** Server-only, like createTaskCard: Kin's worker launcher closes and reopens worker cards. */
    readonly setTaskCardClosed: (input: {
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly threadId: ThreadId;
      readonly closed: boolean;
    }) => Effect.Effect<KinWidget, ServiceError>;
    readonly act: (
      identity: PersonCaller,
      input: KinWidgetsActInput,
    ) => Effect.Effect<KinMessage, ServiceError>;
    /** Posts a lead's choice card under the same floor and flood rules as its text replies. */
    /**
     * Turns the caller's reaction on or off. An owner's 👍/👎 answers a yes/no choice card like a
     * tap, and on the lead's latest message wakes it as a soft reply. Privileged cards refuse.
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
      },
    ) => Effect.Effect<KinWidget, ServiceError>;
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
export const KIN_WAKEUP_MESSAGE_LIMIT = 8;
export const KIN_WAKEUP_CHAR_LIMIT = 32_000;
/** Guests never write; a muted agent stays silent until its mute ends. */
export const mayWrite = (member: KinChatMember, agent: boolean, now: number) =>
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

const taskCardWidgetId = (input: { readonly chatId: KinChatId; readonly threadId: ThreadId }) =>
  encodeAction([input.chatId, input.threadId]).pipe(
    Effect.orDie,
    Effect.map((key) => KinWidgetId.make(`task:${key}`)),
  );

const make = Effect.gen(function* () {
  const floor = yield* Floor.KinFloor;
  const shadow = yield* JudgeShadow;
  const cards = yield* TaskCard.TaskCardIndex;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const presence = yield* Effect.serviceOption(KinPresence);
  const sql = yield* SqlClient.SqlClient;
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
    if (identity._tag === "agent") {
      const agent = yield* requireRecord(repo.getAgent(identity));
      const thread = yield* requireRecord(repo.getAgentThread(identity));
      if (
        agent.retiredAt !== null ||
        thread.endedAt !== null ||
        thread.agentId !== agent.agentId ||
        agent.ownerPersonId !== identity.ownerPersonId ||
        !(identity.wakeupId !== undefined
          ? yield* repo.wakeupRunning({ ...identity, wakeupId: identity.wakeupId })
          : identity.caller !== undefined &&
            (yield* repo.hasRunningWakeup({ ...identity, caller: identity.caller })))
      )
        return yield* notAllowed;
    }
    return member;
  });
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
      yield* hub.publish({ type: "waiting.updated", orgId: identity.orgId, item });
      return item;
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
      readonly intent: KinAgentIntent | null;
      readonly mentions: ReadonlyArray<KinMemberId>;
      readonly replyTo: KinMessageId | null;
      readonly widgetId: KinWidgetId | null;
      readonly kind: "text" | "widget_action";
      readonly publish?: boolean;
      readonly floorRunId?: string | null;
      readonly clientId: { readonly kind: "send" | "act"; readonly id: string } | null;
    },
  ) {
    const messageId = yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
    const message = yield* repo.insertMessage({
      orgId: identity.orgId,
      caller: identity._tag === "agent" ? identity.caller : undefined,
      wakeupId: identity._tag === "agent" ? identity.wakeupId : undefined,
      chatId: input.chatId,
      messageId,
      author: authorFor(identity, member),
      kind: input.kind,
      body: input.body,
      intent: input.intent,
      mentions: input.mentions,
      replyTo: input.replyTo,
      widgetId: input.widgetId,
      floorRunId: input.floorRunId ?? null,
      status: "posted",
      sentBy: null,
      clientMessageId: input.clientId,
      createdAt: yield* now,
      editedAt: null,
    });
    if (message.messageId !== messageId) return message;
    if (message.author._tag === "human") {
      const decision = yield* floor.open(message, yield* requireRecord(repo.getChat(member)));
      yield* shadow.observe(message, decision);
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
    if (identity._tag === "person") {
      for (const item of yield* repo.listOpenWaiting(identity)) {
        if (item.chatId !== message.chatId || item.reason !== "question" || item.messageId === null)
          continue;
        const question = yield* requireRecord(
          repo.getMessage({ orgId: identity.orgId, messageId: item.messageId }),
        );
        if (question.seq < message.seq) yield* resolve(item, "answered");
      }
    }
    return message;
  });
  // A tap, or an owner's yes/no reaction mapped to its option: the same checks and compare-and-set.
  const actOn = Effect.fn("KinChatService.actOn")(function* (
    identity: PersonIdentity,
    member: KinChatMember,
    widget: KinWidget,
    request: KinWidgetsActInput,
    reaction: { readonly emoji: KinReactionEmoji } | null,
  ) {
    const choice = widget.type === "choice" ? yield* ChoiceCard.readChoice(widget, request) : null;
    const body = yield* encodeAction({
      widgetId: request.widgetId,
      revision: request.revision,
      actionId: request.actionId,
      ...(request.value === undefined ? {} : { value: request.value }),
      ...(choice === null ? {} : { text: choice.text }),
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
    if (widget.revision !== request.revision)
      return yield* new KinChatError({
        reason: "widget_changed",
        message: "Widget revision changed.",
      });
    if (widget.closedAt !== null) return yield* invalidState;
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
        expectedRevision: widget.revision,
        closedAt: at,
        updatedAt: at,
      });
      yield* sql.afterCommit(
        hub.publish({ type: "widget.updated", orgId: identity.orgId, widget: closed }),
      );
    }
    const answer =
      choice === null
        ? null
        : yield* ChoiceCard.settleChoice(widget, choice, {
            personId: identity.personId,
            now: yield* Clock.currentTimeMillis,
            emoji: reaction?.emoji ?? null,
          });
    const message = yield* post(identity, member, {
      chatId: widget.chatId,
      kind: "widget_action",
      body,
      intent: null,
      mentions: [],
      replyTo: widget.messageId,
      widgetId: widget.widgetId,
      clientId: { kind: "act", id: request.clientActionId },
    });
    for (const item of yield* repo.listOpenWaiting(identity))
      if (item.widgetId === widget.widgetId) yield* resolve(item, "acted");
    if (answer !== null) {
      // Compare-and-set on the revision the tap saw: the first answer settles the card.
      const answered = yield* repo.updateWidget({
        ...widget,
        state: answer,
        awaiting: [],
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
  const summary = Effect.fn("KinChatService.summary")(function* (
    identity: PersonIdentity,
    chatId: KinChatId,
  ): Effect.fn.Return<KinChatSummary, ServiceError> {
    const member = yield* memberFor(identity, chatId);
    const chat = yield* requireRecord(repo.getChat({ orgId: identity.orgId, chatId }));
    const history = yield* repo.history({
      ...chat,
      beforeSeq: chat.lastSeq + 1,
      limit: 1,
      viewerMemberId: member.memberId,
    });
    return {
      ...chat,
      members: yield* repo.listMembers(chat),
      lastMessage: history.messages[0] ?? null,
      unread: yield* repo.unreadCount(member),
    };
  });
  const snapshot = Effect.fn("KinChatService.snapshot")(
    function* (identities: ReadonlyArray<PersonIdentity>) {
      const chats: Array<KinChatSummary> = [];
      const waiting: Array<KinWaitingItem> = [];
      for (const identity of identities) {
        for (const member of yield* repo.listMembersByPerson(identity)) {
          if (member.leftAt !== null) continue;
          chats.push(yield* summary(identity, member.chatId));
        }
        for (const item of yield* repo.listOpenWaiting(identity)) {
          if (Option.isSome(yield* repo.activeMember({ ...item, principal: identity })))
            waiting.push(item);
        }
      }
      return { _tag: "snapshot" as const, chats, waiting };
    },
    (effect) => transaction(effect).pipe(NodeSqliteClient.readOnly),
  );
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
          message.author._tag !== "system" ||
          message.chatId !== input.chatId ||
          message.body !== input.body ||
          (waiting?.personId ?? undefined) !== input.waitingFor
        )
          return yield* notAllowed;
        return { message, waiting };
      }
      const message = yield* repo.insertMessage({
        orgId: input.orgId,
        chatId: input.chatId,
        messageId,
        author: { _tag: "system" },
        kind: "system",
        body: input.body,
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
          return {
            ...org,
            agents: agents.map(({ agentId, displayName, retiredAt }) => ({
              agentId,
              displayName,
              retired: retiredAt !== null,
            })),
          };
        }),
      );
      return { orgs, me: identities.map(({ orgId, personId }) => ({ orgId, personId })) };
    }),
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
          const resumed = yield* repo.resume({
            ...member,
            afterSeq: input.afterSeq ?? 0,
            afterChangeSeq: input.afterChangeSeq,
          });
          const backlog: KinChatStreamEvent = resumed.reset
            ? { _tag: "reset", lastSeq: resumed.lastSeq, lastChangeSeq: resumed.lastChangeSeq }
            : {
                _tag: "backlog",
                lastSeq: resumed.lastSeq,
                lastChangeSeq: resumed.lastChangeSeq,
                messages: resumed.messages,
                widgets: resumed.widgets,
                // The chat's live reactions in full, so a resumed client drops withdrawn ones.
                reactions: yield* Reactions.liveReactions({
                  orgId: identity.orgId,
                  chatId: input.chatId,
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                ...(Option.isSome(presence)
                  ? presence.value.snapshot(identity.orgId, input.chatId)
                  : {}),
              };
          const messageChanges = new Map<string, number>();
          const revisions = new Map(
            backlog._tag === "backlog" ? backlog.widgets.map((w) => [w.widgetId, w.revision]) : [],
          );
          let cursor = { lastSeq: resumed.lastSeq, lastChangeSeq: resumed.lastChangeSeq };
          let delivered = 0;
          const checkpoint = Effect.fn("KinChatService.subscribeCheckpoint")(function* () {
            const next = yield* repo.resume({
              ...member,
              afterSeq: cursor.lastSeq,
              afterChangeSeq: cursor.lastChangeSeq,
            });
            cursor = { lastSeq: next.lastSeq, lastChangeSeq: next.lastChangeSeq };
            delivered = 0;
            if (next.reset) return { _tag: "reset", ...cursor } satisfies KinChatStreamEvent;
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
                  case "message.posted": {
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
                  case "member.removed":
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
              Stream.takeUntil((event) => event._tag === "member" && event.member.leftAt !== null),
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
                // Reactions don't change a chat's row.
                if (event.type === "reaction.updated") return yield* notFound;
                if (event.type === "waiting.updated")
                  return yield* requireRecord(repo.getWaiting(event.item)).pipe(
                    Effect.map((item) => ({ _tag: "waiting" as const, item })),
                  );
                const chatId =
                  event.type === "chat.created"
                    ? event.chat.chatId
                    : event.type === "message.posted"
                      ? event.message.chatId
                      : event.type === "widget.updated"
                        ? event.widget.chatId
                        : event.type === "member.removed"
                          ? event.member.chatId
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
      if (agent.ownerPersonId !== person.personId || agent.retiredAt !== null)
        return yield* notAllowed;
      const chatId = yield* decodeChatId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
      const chat = yield* repo.createChat({
        orgId: identity.orgId,
        chatId,
        kind: "direct",
        directKey: `${person.personId}:${agent.agentId}`,
        title: null,
        teamId: null,
        lastMessageAt: null,
        createdAt: yield* now,
        archivedAt: null,
      });
      if (chat.chatId !== chatId) {
        yield* memberFor(identity, chat.chatId);
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
          role: principal._tag === "person" ? "owner" : "member",
          joinedAt: chat.createdAt,
          leftAt: null,
          mutedUntil: null,
        });
      }
      yield* hub.publish({ type: "chat.created", orgId: identity.orgId, chat });
      return chat;
    }, transaction),
    send: Effect.fn("KinChatService.send")(function* (identity, input) {
      identity = yield* identityFor(identity, input);
      const request = yield* decodeSend(input).pipe(Effect.mapError(() => invalidState));
      const member = yield* memberFor(identity, request.chatId);
      yield* canWrite(identity, member);
      if (request.mentions !== undefined && request.mentions.length > 100)
        return yield* invalidState;
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
      const authorization =
        identity._tag === "agent" && Option.isNone(existing)
          ? yield* floor.authorize(identity, chat, intent ?? "answer", input.floorGrant)
          : { runId: null };
      const message = yield* post(identity, member, {
        ...request,
        kind: "text",
        intent,
        floorRunId: authorization.runId,
        mentions: request.mentions ?? [],
        replyTo: request.replyTo ?? null,
        widgetId: null,
        clientId: { kind: "send", id: request.clientMessageId },
      });
      if (Option.isNone(existing) && identity._tag === "agent" && authorization.runId === null)
        yield* floor.recordNotice(identity, message);
      return message;
    }, transaction),
    read: Effect.fn("KinChatService.read")(function* (identity, input) {
      const request = yield* decodeRead(input).pipe(Effect.mapError(() => invalidState));
      const member = yield* memberFor(identity, request.chatId);
      return yield* repo.messagesAfter({
        orgId: identity.orgId,
        chatId: request.chatId,
        afterSeq: request.afterSeq ?? 0,
        limit: request.limit ?? 50,
        viewerMemberId: member.memberId,
      });
    }, transaction),
    history: Effect.fn("KinChatService.history")(
      function* (identity, input) {
        identity = yield* identityFor(identity, input);
        const member = yield* memberFor(identity, input.chatId);
        const page = yield* repo.history({
          ...input,
          orgId: identity.orgId,
          viewerMemberId: member.memberId,
        });
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
        taskId: input.threadId,
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
        messageId: KinMessageId.make(SecureRandom.uuidV4Unsafe()),
        author: {
          _tag: "agent",
          agentId: agent.agentId,
          ownerPersonId: agent.ownerPersonId,
          threadId: thread.threadId,
          memberId: member.memberId,
        },
        serverTaskCard: true,
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
      yield* repo.insertWidget(widget);
      const anchor = yield* requireRecord(
        repo.getMessage({ ...input, messageId: message.messageId }),
      );
      yield* hub.publish({ type: "message.posted", orgId: input.orgId, message: anchor });
      yield* hub.publish({ type: "widget.updated", orgId: input.orgId, widget });
      yield* sql.afterCommit(cards.track(widget));
      return widget;
    }, transaction),
    setTaskCardClosed: Effect.fn("KinChatService.setTaskCardClosed")(function* (input) {
      const existing = yield* requireRecord(
        repo.getWidget({ orgId: input.orgId, widgetId: yield* taskCardWidgetId(input) }),
      );
      if (existing.type !== "task" || existing.chatId !== input.chatId) return yield* notFound;
      if ((existing.closedAt !== null) === input.closed) return existing;
      const widget = yield* repo.updateWidget({
        ...existing,
        awaiting: input.closed ? [] : existing.awaiting,
        expectedRevision: existing.revision,
        closedAt: input.closed ? yield* now : null,
        updatedAt: yield* now,
      });
      if (input.closed)
        for (const item of yield* repo.waitingForWidget(widget)) yield* resolve(item, "closed");
      yield* sql.afterCommit(cards.track(widget));
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
        // Only kin_ask posts one, and only a tap answers it.
        input.type === "choice" ||
        (input.type === "task" && input.widgetId === undefined)
      )
        return yield* notAllowed;
      let state = yield* validateState(input.type, input.state);
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
        yield* repo.insertWidget(widget);
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
      const widget = yield* requireRecord(
        repo.getWidget({ orgId: identity.orgId, widgetId: request.widgetId }),
      );
      const member = yield* memberFor(identity, widget.chatId);
      yield* canWrite(identity, member);
      if (widget.type === "approval")
        return yield* new KinChatError({
          reason: "use_approvals",
          message: "Use the signed approvals service.",
        });
      // Verdicts and raises go to the owner-only kin.levels methods, never the lead's queue.
      if (widget.type === "shadow_review" || widget.type === "promotion") return yield* notAllowed;
      if (widget.type === "owner_check") {
        if (member.role !== "owner") return yield* notAllowed;
        const card = yield* decodeOwnerCheckCard(widget.state).pipe(
          Effect.mapError(() => invalidState),
        );
        if (
          !["keep", "update", "drop"].includes(request.actionId) ||
          !card.items.some((item) => item.itemId === request.value)
        )
          return yield* invalidState;
      }
      // Any writing member of the card's chat may undo; the other taps wait on the dispatcher.
      if (
        widget.type === "deferral" &&
        request.actionId !== "undo" &&
        (member.role !== "owner" ||
          !deferralCardActionsReady ||
          !deferralCardActions.some((action) => action === request.actionId))
      )
        return yield* notAllowed;
      return yield* actOn(identity, member, widget, request, null);
    }, transaction),
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
      // The owner's yes/no on the lead's latest message, in their direct chat, is a soft reply.
      const woke =
        request.on &&
        !answered &&
        identity._tag === "person" &&
        member.role === "owner" &&
        chat.kind === "direct" &&
        message.author._tag === "agent" &&
        Reactions.reactionAnswer(request.emoji) !== null &&
        nowMs - Date.parse(message.createdAt) < SOFT_REPLY_WINDOW_MS &&
        (yield* isLatestLeadMessage(message)) &&
        !(yield* Reactions.recentlyWoke({ ...key, now: nowMs }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ));
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
      const { reaction, changed } = yield* Reactions.setReaction({
        ...key,
        on: request.on,
        now: nowMs,
        woke,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (reaction === null) return yield* notFound;
      if (changed)
        yield* hub.publish({
          type: "reaction.updated",
          orgId: identity.orgId,
          chatId: message.chatId,
          reaction,
          woke,
          by: authorFor(identity, member),
        });
      return reaction;
    }, transaction),
    ask: Effect.fn("KinChatService.ask")(function* (identity, input) {
      const member = yield* memberFor(identity, input.chatId);
      yield* canWrite(identity, member);
      const state = yield* validateState("choice", ChoiceCard.choiceCardState(input));
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
        if (Option.isNone(widget) || widget.value.type !== "choice") return yield* notAllowed;
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
      const authorization = yield* floor.authorize(identity, chat, "question");
      const message = yield* post(identity, member, {
        chatId: input.chatId,
        body: "",
        intent: "question",
        kind: "text",
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: authorization.runId,
        clientId: { kind: "send", id: input.clientMessageId },
        publish: false,
      });
      if (authorization.runId === null) yield* floor.recordNotice(identity, message);
      const awaiting = (yield* repo.listMembers(member)).flatMap((row) =>
        row.leftAt === null && row.role !== "guest" && row.principal._tag === "person"
          ? [row.principal.personId]
          : [],
      );
      const widget: KinWidget = {
        orgId: identity.orgId,
        chatId: input.chatId,
        widgetId: yield* decodeWidgetId(`choice:${message.messageId}`).pipe(Effect.orDie),
        messageId: message.messageId,
        widgetClass: "native",
        type: "choice",
        revision: 1,
        state,
        source: null,
        feed: null,
        awaiting,
        pinnedAt: null,
        closedAt: null,
        updatedAt: yield* now,
      };
      yield* repo.insertWidget(widget);
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
    }, transaction),
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
      } else if (member.role !== "owner" && identity.personId !== item.personId) {
        return yield* notAllowed;
      }
      return yield* resolve(item, input.resolution);
    }, transaction),
  });
});

export const layer = Layer.effect(KinChatService, make).pipe(
  Layer.provideMerge(TaskCard.layer),
  Layer.provide(Floor.layer),
);
