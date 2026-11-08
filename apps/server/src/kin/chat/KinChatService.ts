import {
  KinChatError,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinWaitingId,
  KinWidgetId,
  KinMessagesSendInput,
  KinWidgetsActInput,
  KinAgentIntent,
  type KinAuthor,
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
import * as Hub from "./KinChatHub.ts";
import * as Repository from "./KinChatRepository.ts";
import type { AgentIdentity, PersonIdentity } from "./KinIdentity.ts";

type Identity = PersonIdentity | AgentIdentity;
type Viewers = ReadonlyArray<PersonIdentity>;
type Caller = Identity | Viewers;
type PersonCaller = PersonIdentity | Viewers;
type ServiceError = Repository.RepositoryError;
type SendInput = KinMessagesSendInput & { readonly intent?: KinAgentIntent };
type WidgetUpsertInput = {
  readonly chatId: KinChatId;
  readonly widgetId?: KinWidgetId | undefined;
  readonly revision?: number | undefined;
  readonly replyTo?: KinMessageId | undefined;
  readonly type: string;
  readonly state: unknown;
  readonly awaiting?: ReadonlyArray<KinPersonId> | undefined;
  readonly closed?: boolean;
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
    readonly act: (
      identity: PersonCaller,
      input: KinWidgetsActInput,
    ) => Effect.Effect<KinMessage, ServiceError>;
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
const decodeAct = Schema.decodeEffect(KinWidgetsActInput);
const encodeAction = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const invalidState = new KinChatError({ reason: "invalid_state", message: "Invalid chat input." });
const notFound = new KinChatError({ reason: "not_found", message: "Kin record not found." });
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

const make = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
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
        agent.ownerPersonId !== identity.ownerPersonId
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
    if (member.role === "guest") return yield* notAllowed;
    if (
      identity._tag === "agent" &&
      member.mutedUntil !== null &&
      Date.parse(member.mutedUntil) > (yield* Clock.currentTimeMillis)
    )
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
      readonly clientId: { readonly kind: "send" | "act"; readonly id: string } | null;
    },
  ) {
    const messageId = yield* decodeMessageId(SecureRandom.uuidV4Unsafe()).pipe(Effect.orDie);
    const message = yield* repo.insertMessage({
      orgId: identity.orgId,
      chatId: input.chatId,
      messageId,
      author: authorFor(identity, member),
      kind: input.kind,
      body: input.body,
      intent: input.intent,
      mentions: input.mentions,
      replyTo: input.replyTo,
      widgetId: input.widgetId,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: input.clientId,
      createdAt: yield* now,
      editedAt: null,
    });
    if (message.messageId !== messageId || input.publish === false) return message;
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
          const resumed = yield* repo.resume({ ...member, afterSeq: input.afterSeq ?? 0 });
          const backlog: KinChatStreamEvent = resumed.reset
            ? { _tag: "reset", lastSeq: resumed.lastSeq }
            : {
                _tag: "backlog",
                lastSeq: resumed.lastSeq,
                messages: resumed.messages,
                widgets: resumed.widgets,
              };
          const lastHistorySeq = backlog.lastSeq;
          const revisions = new Map(
            backlog._tag === "backlog" ? backlog.widgets.map((w) => [w.widgetId, w.revision]) : [],
          );
          return Stream.concat(
            Stream.succeed(backlog),
            live.pipe(
              Stream.map((event) => {
                switch (event.type) {
                  case "message.posted": {
                    if (
                      event.message.chatId !== input.chatId ||
                      event.message.seq <= lastHistorySeq
                    )
                      return Option.none();
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
      return yield* post(identity, member, {
        ...request,
        kind: "text",
        intent,
        mentions: request.mentions ?? [],
        replyTo: request.replyTo ?? null,
        widgetId: null,
        clientId: { kind: "send", id: request.clientMessageId },
      });
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
        return yield* repo.history({
          ...input,
          orgId: identity.orgId,
          viewerMemberId: member.memberId,
        });
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
    upsertWidget: Effect.fn("KinChatService.upsertWidget")(function* (identity, input) {
      const member = yield* memberFor(identity, input.chatId);
      yield* canWrite(identity, member);
      if (input.type === "approval")
        return yield* new KinChatError({
          reason: "use_approvals",
          message: "Use the signed approvals service.",
        });
      const state = yield* validateState(input.type, input.state);
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
        widget = yield* repo.updateWidget({
          ...existing,
          state,
          awaiting:
            input.closed === true || (input.closed === undefined && existing.closedAt !== null)
              ? []
              : (input.awaiting ?? existing.awaiting),
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
      const body = yield* encodeAction({
        widgetId: request.widgetId,
        revision: request.revision,
        actionId: request.actionId,
        ...(request.value === undefined ? {} : { value: request.value }),
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
      return message;
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

export const layer = Layer.effect(KinChatService, make);
