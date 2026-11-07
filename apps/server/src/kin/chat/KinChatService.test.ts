import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessagesSendInput,
  KinOrgId,
  KinPersonId,
  KinTaskCardState,
  KinWaitingId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Hub from "./KinChatHub.ts";
import * as Repository from "./KinChatRepository.ts";
import * as Identity from "./KinIdentity.ts";
import * as Service from "./KinChatService.ts";

const decodeKinOrgId = Schema.decodeSync(KinOrgId);
const decodeKinPersonId = Schema.decodeSync(KinPersonId);
const decodeKinWaitingId = Schema.decodeSync(KinWaitingId);
const decodeKinChatId = Schema.decodeSync(KinChatId);
const decodeKinMemberId = Schema.decodeSync(KinMemberId);
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeSend = Schema.decodeUnknownEffect(KinMessagesSendInput);
const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const repositories = Layer.provideMerge(Repository.layer, database);
const dependencies = Layer.provideMerge(Hub.layer, repositories);
const layer = Layer.provideMerge(Service.layer, dependencies);
const identityLayer = Identity.KinIdentity.layer.pipe(
  Layer.provide(
    Layer.succeed(Identity.KinIdentityConfig, {
      orgName: "Kin",
      ownerHandle: "owner",
      ownerDisplayName: "Owner",
    }),
  ),
);
const session: AuthenticatedSession = {
  sessionId: Schema.decodeSync(AuthSessionId)("session"),
  subject: "browser",
  method: "browser-session-cookie",
  scopes: AuthStandardClientScopes,
};
const agentId = Schema.decodeSync(KinAgentId)("lead");
const threadId = decodeThreadId("lead-thread");
const caller: McpInvocationScope = {
  environmentId: Schema.decodeSync(EnvironmentId)("environment"),
  capabilities: new Set(),
  issuedAt: 0,
  requestNamespace: "test",
  client: undefined,
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: Schema.decodeSync(ProviderInstanceId)("provider"),
  },
};
const timestamp = "1970-01-01T00:00:00.000Z";
const state = Schema.decodeSync(KinTaskCardState)({
  taskId: "task",
  environmentId: "environment",
  threadId,
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: timestamp,
});
const seed = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  const service = yield* Service.KinChatService;
  const identity = yield* Identity.KinIdentity.pipe(Effect.provide(identityLayer));
  const [person] = yield* identity.resolve(session);
  assert.isDefined(person);
  yield* repo.insertAgent({
    orgId: person.orgId,
    agentId,
    ownerPersonId: person.personId,
    displayName: "Lead",
    role: "lead",
    createdAt: timestamp,
  });
  yield* identity.registerAgentThread({ orgId: person.orgId, agentId, threadId });
  const agent = yield* identity.resolveAgent(caller);
  const chat = yield* service.createDirect(person, { orgId: person.orgId, agentId });
  return { repo, service, identity, person, agent, chat };
});

describe("KinChatService", () => {
  it.effect(
    "creates exactly two members, derives authors from identity, and deduplicates sends",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed;
        const retries = yield* Effect.all(
          Array.from({ length: 5 }, () =>
            service.createDirect(person, { orgId: person.orgId, agentId }),
          ),
          { concurrency: "unbounded" },
        );
        assert.isTrue(retries.every((row) => row.chatId === chat.chatId));
        const members = yield* repo.listMembers(chat);
        assert.strictEqual(members.length, 2);
        assert.deepStrictEqual(members.map((row) => row.role).sort(), ["member", "owner"]);
        const forged = yield* decodeSend({
          chatId: chat.chatId,
          clientMessageId: "first",
          body: "Hello",
          author: { _tag: "system" },
          authorRole: "owner",
          status: "posted",
        });
        const mixedPerson = { ...person, agentId };
        const first = yield* service.send(mixedPerson, forged);
        assert.strictEqual(first.author._tag, "human");
        assert.include(first.author, { personId: person.personId });
        assert.strictEqual(first.authorRole, "owner");
        assert.strictEqual(first.intent, null);
        assert.deepStrictEqual(yield* service.send(person, forged), first);
        for (const changed of [
          { body: "Changed retry" },
          { mentions: members.map((row) => row.memberId) },
          { replyTo: first.messageId },
        ])
          assert.include(yield* Effect.flip(service.send(person, { ...forged, ...changed })), {
            reason: "not_allowed",
          });
        const agentMember = members.find((row) => row.principal._tag === "agent");
        assert.isDefined(agentMember);
        const mixedAgent = { ...agent, personId: person.personId };
        const posted = yield* service.send(mixedAgent, {
          chatId: chat.chatId,
          clientMessageId: "first",
          body: "Evidence",
          intent: "evidence",
        });
        assert.deepStrictEqual(posted.author, {
          _tag: "agent",
          agentId,
          ownerPersonId: person.personId,
          threadId,
          memberId: agentMember.memberId,
        });
        assert.include(
          yield* Effect.flip(
            service.send(agent, {
              chatId: chat.chatId,
              clientMessageId: "first",
              body: "Evidence",
              intent: "answer",
            }),
          ),
          { reason: "not_allowed" },
        );
        assert.strictEqual(posted.authorRole, "member");
        assert.strictEqual(posted.seq, 2);
        const resumed = decodeThreadId("new-thread");
        yield* repo.registerAgentThread({
          orgId: agent.orgId,
          agentId,
          threadId: resumed,
          startedAt: timestamp,
          endedAt: null,
        });
        assert.include(
          yield* Effect.flip(
            service.send(
              { ...agent, threadId: resumed },
              { chatId: chat.chatId, clientMessageId: "first", body: "Retry", intent: "evidence" },
            ),
          ),
          { reason: "not_allowed" },
        );
        for (const operation of [
          service.send(agent, { chatId: chat.chatId, clientMessageId: "no-intent", body: "Hello" }),
          service.send(person, {
            chatId: chat.chatId,
            clientMessageId: "human-intent",
            body: "Hello",
            intent: "decision",
          }),
          service.send(person, { chatId: chat.chatId, clientMessageId: "blank", body: " " }),
        ])
          assert.include(yield* Effect.flip(operation), { reason: "invalid_state" });
        assert.deepStrictEqual(
          (yield* service.history(person, { chatId: chat.chatId, beforeSeq: 3, limit: 1 }))
            .messages,
          [posted],
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides foreign org ids on every method and checks active membership and roles", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed;
      const widget = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        type: "task",
        state,
        awaiting: [person.personId],
      });
      const [waiting] = yield* repo.listOpenWaiting(person);
      assert.isDefined(waiting);
      const foreign = {
        _tag: "person",
        orgId: decodeKinOrgId("other-org"),
        personId: decodeKinPersonId("other-person"),
      } as const;
      yield* repo.insertOrg({ orgId: foreign.orgId, name: "Other", createdAt: timestamp });
      yield* repo.insertPerson({
        ...foreign,
        handle: "other",
        displayName: "Other",
        githubLogin: null,
        createdAt: timestamp,
      });
      for (const operation of [
        service.createDirect(foreign, { orgId: person.orgId, agentId }),
        service.send(foreign, { chatId: chat.chatId, body: "Hidden", clientMessageId: "foreign" }),
        service.history(foreign, { chatId: chat.chatId, beforeSeq: 99, limit: 100 }),
        service.markRead(foreign, { chatId: chat.chatId, seq: 1 }),
        service.upsertWidget(foreign, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: 1,
          type: "task",
          state,
        }),
        service.act(foreign, {
          widgetId: widget.widgetId,
          revision: 1,
          actionId: "done",
          clientActionId: "foreign",
        }),
        service.addWaiting(foreign, {
          chatId: chat.chatId,
          personId: person.personId,
          messageId: null,
          widgetId: null,
          reason: "question",
        }),
        service.resolveWaiting(foreign, { waitingId: waiting.waitingId, resolution: "answered" }),
      ])
        assert.include(yield* Effect.flip(operation), { reason: "not_found" });
      const outsider = { ...person, personId: decodeKinPersonId("outsider") };
      yield* repo.insertPerson({
        ...outsider,
        handle: "outsider",
        displayName: "Outsider",
        githubLogin: null,
        createdAt: timestamp,
      });
      assert.include(
        yield* Effect.flip(
          service.history(outsider, { chatId: chat.chatId, beforeSeq: 99, limit: 100 }),
        ),
        { reason: "not_found" },
      );
      const guest = yield* repo.addMember({
        ...chat,
        memberId: decodeKinMemberId("guest-member"),
        principal: { _tag: "person", personId: outsider.personId },
        role: "guest",
        joinedAt: timestamp,
        leftAt: null,
        mutedUntil: null,
      });
      for (const operation of [
        service
          .send(outsider, { chatId: chat.chatId, body: "Guest", clientMessageId: "guest" })
          .pipe(Effect.asVoid),
        service
          .act(outsider, {
            widgetId: widget.widgetId,
            revision: 1,
            actionId: "done",
            clientActionId: "guest",
          })
          .pipe(Effect.asVoid),
        service
          .upsertWidget(outsider, { chatId: chat.chatId, type: "task", state })
          .pipe(Effect.asVoid),
      ])
        assert.include(yield* Effect.flip(operation), { reason: "not_allowed" });
      const guestWaiting = yield* service.addWaiting(person, {
        chatId: chat.chatId,
        personId: outsider.personId,
        messageId: null,
        widgetId: null,
        reason: "mention",
      });
      assert.include(
        yield* Effect.flip(
          service.resolveWaiting(outsider, {
            waitingId: guestWaiting.waitingId,
            resolution: "done",
          }),
        ),
        { reason: "not_allowed" },
      );
      yield* service.markRead(outsider, { chatId: chat.chatId, seq: 1 });
      yield* repo.leaveChat({ ...guest, leftAt: timestamp });
      assert.include(
        yield* Effect.flip(service.markRead(outsider, { chatId: chat.chatId, seq: 1 })),
        { reason: "not_found" },
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repo.getWaiting(guestWaiting)).resolution,
        "cancelled",
      );
      const rejoined = yield* repo.addMember({ ...guest, role: "member" });
      assert.strictEqual(rejoined.role, "member");
      yield* service.send(outsider, {
        chatId: chat.chatId,
        body: "Rejoined",
        clientMessageId: "rejoined",
      });
      yield* service.markRead(outsider, { chatId: chat.chatId, seq: 1 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_chat_members SET muted_until = '2099-01-01T00:00:00.000Z' WHERE org_id = ${person.orgId} AND agent_id = ${agentId}`;
      assert.include(
        yield* Effect.flip(
          service.send(agent, {
            chatId: chat.chatId,
            body: "Muted",
            clientMessageId: "muted",
            intent: "answer",
          }),
        ),
        { reason: "not_allowed" },
      );
      yield* sql`UPDATE kin_chat_members SET muted_until = NULL WHERE org_id = ${person.orgId} AND agent_id = ${agentId}`;
      yield* repo.endAgentThread({ orgId: agent.orgId, threadId, endedAt: timestamp });
      assert.include(
        yield* Effect.flip(
          service.send(agent, {
            chatId: chat.chatId,
            body: "Ended",
            clientMessageId: "ended",
            intent: "answer",
          }),
        ),
        { reason: "not_allowed" },
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "validates widget states, owns ids and revisions, resolves awaiting, and makes actions retryable",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed;
        for (const input of [
          { type: "approval", state },
          { type: "unknown", state },
          { type: "task", state: {} },
          { type: "task", state, revision: 8 },
        ]) {
          assert.include(
            yield* Effect.flip(service.upsertWidget(agent, { chatId: chat.chatId, ...input })),
            { reason: input.type === "approval" ? "use_approvals" : "invalid_state" },
          );
        }
        assert.strictEqual(Option.getOrThrow(yield* repo.getChat(chat)).lastSeq, 0);
        const widget = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          type: "task",
          state,
          awaiting: [person.personId],
        });
        assert.strictEqual(widget.revision, 1);
        assert.strictEqual(
          Option.getOrThrow(yield* repo.getMessage(widget)).widgetId,
          widget.widgetId,
        );
        const input = {
          widgetId: widget.widgetId,
          revision: 1,
          actionId: "done",
          clientActionId: "action",
          value: { checked: true },
        };
        assert.include(yield* Effect.flip(service.act(person, { ...input, revision: 2 })), {
          reason: "widget_changed",
        });
        const action = yield* service.act(person, input);
        assert.strictEqual(action.kind, "widget_action");
        assert.strictEqual(action.author._tag, "human");
        assert.deepStrictEqual(JSON.parse(action.body), {
          widgetId: widget.widgetId,
          revision: 1,
          actionId: "done",
          value: { checked: true },
        });
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const updated = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: 1,
          type: "task",
          state: { ...state, status: "done" },
          awaiting: [person.personId],
        });
        assert.strictEqual(updated.revision, 2);
        assert.deepStrictEqual(yield* service.act(person, input), action);
        assert.include(yield* Effect.flip(service.act(person, { ...input, actionId: "changed" })), {
          reason: "not_allowed",
        });
        assert.strictEqual((yield* repo.listOpenWaiting(person)).length, 1);
        yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          widgetId: widget.widgetId,
          revision: 2,
          type: "task",
          state,
          awaiting: [],
        });
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const another = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          type: "task",
          state,
          awaiting: [person.personId],
        });
        assert.include(
          yield* Effect.flip(service.act(person, { ...input, widgetId: another.widgetId })),
          { reason: "not_allowed" },
        );
        yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          widgetId: another.widgetId,
          revision: 1,
          type: "task",
          state,
          closed: true,
        });
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_widgets SET type = 'approval' WHERE org_id = ${person.orgId} AND widget_id = ${another.widgetId}`;
        assert.include(
          yield* Effect.flip(
            service.act(person, {
              ...input,
              widgetId: another.widgetId,
              revision: 2,
              clientActionId: "approval",
            }),
          ),
          { reason: "use_approvals" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "publishes question waiting and reply resolution, rolls back atomically, and keeps read state monotonic",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed;
        const hub = yield* Hub.KinChatHub;
        const events = yield* hub.subscribe(person.orgId);
        const sql = yield* SqlClient.SqlClient;
        const input = {
          chatId: chat.chatId,
          body: "Ready?",
          intent: "question",
          clientMessageId: "question",
        } as const;
        yield* sql
          .withTransaction(service.send(agent, input).pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.flip);
        assert.deepStrictEqual(yield* PubSub.takeUpTo(events, 20), []);
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const question = yield* service.send(agent, input);
        assert.strictEqual(question.seq, 1);
        assert.strictEqual((yield* PubSub.take(events)).type, "message.posted");
        assert.strictEqual((yield* PubSub.take(events)).type, "waiting.updated");
        assert.strictEqual((yield* repo.listOpenWaiting(person)).length, 1);
        assert.deepStrictEqual(yield* service.send(agent, input), question);
        assert.deepStrictEqual(yield* PubSub.takeUpTo(events, 20), []);
        yield* service.send(person, { chatId: chat.chatId, body: "Yes", clientMessageId: "reply" });
        assert.strictEqual((yield* PubSub.take(events)).type, "message.posted");
        const resolved = yield* PubSub.take(events);
        assert.strictEqual(resolved.type, "waiting.updated");
        if (resolved.type === "waiting.updated")
          assert.strictEqual(resolved.item.resolution, "answered");
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const member = (yield* repo.listMembersByPerson(person))[0];
        assert.isDefined(member);
        assert.strictEqual(yield* repo.unreadCount(member), 1);
        yield* service.markRead(person, { chatId: chat.chatId, seq: 999 });
        yield* service.markRead(person, { chatId: chat.chatId, seq: 0 });
        assert.strictEqual(Option.getOrThrow(yield* repo.getReadState(member)).lastReadSeq, 2);
        assert.strictEqual(yield* repo.unreadCount(member), 0);
        const read = yield* PubSub.take(events);
        assert.include(read, { type: "read.updated", seq: 2 });
        assert.deepStrictEqual(yield* PubSub.takeUpTo(events, 20), []);
        const approval = {
          orgId: person.orgId,
          chatId: chat.chatId,
          waitingId: decodeKinWaitingId("server-approval"),
          personId: person.personId,
          messageId: question.messageId,
          widgetId: null,
          reason: "approval",
          createdAt: timestamp,
          resolvedAt: null,
          resolution: null,
        } as const;
        yield* repo.addWaiting(approval);
        const humanQuestion = yield* service.send(person, {
          chatId: chat.chatId,
          body: "Another question",
          clientMessageId: "human-question",
        });
        const anotherQuestion = yield* service.addWaiting(person, {
          ...approval,
          reason: "question",
          messageId: humanQuestion.messageId,
        });
        const ownQuestion = yield* service.addWaiting(agent, {
          ...approval,
          reason: "question",
        });
        for (const operation of [
          service.addWaiting(agent, { ...approval }),
          service.resolveWaiting(agent, { waitingId: approval.waitingId, resolution: "approved" }),
          service.resolveWaiting(agent, {
            waitingId: anotherQuestion.waitingId,
            resolution: "answered",
          }),
        ])
          assert.include(yield* Effect.flip(operation), { reason: "not_allowed" });
        const approvalWidget = yield* service.upsertWidget(agent, {
          chatId: chat.chatId,
          type: "task",
          state,
        });
        yield* sql`UPDATE kin_widgets SET type = 'approval' WHERE org_id = ${person.orgId} AND widget_id = ${approvalWidget.widgetId}`;
        for (const identity of [person, agent])
          for (const widgetId of [null, approvalWidget.widgetId])
            assert.include(
              yield* Effect.flip(
                service.addWaiting(identity, {
                  ...approval,
                  reason: "question",
                  widgetId,
                  messageId: approvalWidget.messageId,
                }),
              ),
              { reason: "not_allowed" },
            );
        assert.strictEqual(
          (yield* service.resolveWaiting(agent, {
            waitingId: ownQuestion.waitingId,
            resolution: "answered",
          })).resolution,
          "answered",
        );
        const waiting = yield* service.addWaiting(agent, {
          chatId: chat.chatId,
          personId: person.personId,
          messageId: question.messageId,
          widgetId: null,
          reason: "mention",
        });
        const done = yield* service.resolveWaiting(person, {
          waitingId: waiting.waitingId,
          resolution: "done",
        });
        assert.strictEqual(done.resolution, "done");
        assert.deepStrictEqual(
          yield* service.resolveWaiting(person, {
            waitingId: waiting.waitingId,
            resolution: "again",
          }),
          done,
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("filters every hub event against current viewer membership at delivery", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed;
      const hub = yield* Hub.KinChatHub;
      const viewer = yield* hub.subscribeForViewer(person);
      const other = yield* repo.createChat({
        ...chat,
        chatId: decodeKinChatId("other-chat"),
        kind: "project_group",
        directKey: null,
      });
      const agentMember = (yield* repo.listMembers(chat)).find(
        (row) => row.principal._tag === "agent",
      );
      const personMember = (yield* repo.listMembers(chat)).find(
        (row) => row.principal._tag === "person",
      );
      assert.isDefined(agentMember);
      assert.isDefined(personMember);
      yield* repo.addMember({
        ...agentMember,
        chatId: other.chatId,
        memberId: decodeKinMemberId("other-agent"),
      });
      const message = yield* service.send(agent, {
        chatId: other.chatId,
        body: "Private",
        clientMessageId: "private",
        intent: "answer",
      });
      const widget = yield* service.upsertWidget(agent, {
        chatId: other.chatId,
        type: "task",
        state,
      });
      const events: ReadonlyArray<Hub.KinChatHubEvent> = [
        { type: "chat.created", orgId: person.orgId, chat: other },
        { type: "message.posted", orgId: person.orgId, message },
        {
          type: "message.posted",
          orgId: person.orgId,
          message: { ...message, status: "suggested" },
        },
        { type: "widget.updated", orgId: person.orgId, widget },
        {
          type: "waiting.updated",
          orgId: person.orgId,
          item: {
            orgId: person.orgId,
            chatId: other.chatId,
            waitingId: decodeKinWaitingId("private-waiting"),
            personId: person.personId,
            messageId: message.messageId,
            widgetId: null,
            reason: "suggestion",
            createdAt: timestamp,
            resolvedAt: null,
            resolution: null,
          },
        },
        {
          type: "read.updated",
          orgId: person.orgId,
          chatId: other.chatId,
          memberId: agentMember.memberId,
          seq: 1,
        },
      ];
      for (const event of events) yield* hub.publish(event);
      const marker: Hub.KinChatHubEvent = {
        type: "read.updated",
        orgId: person.orgId,
        chatId: chat.chatId,
        memberId: personMember.memberId,
        seq: 0,
      };
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
      const joined = yield* repo.addMember({
        ...personMember,
        chatId: other.chatId,
        memberId: decodeKinMemberId("other-person"),
      });
      for (const event of events) yield* hub.publish(event);
      yield* repo.leaveChat({ ...joined, leftAt: timestamp });
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
      yield* repo.addMember(joined);
      for (const event of events) yield* hub.publish(event);
      assert.deepStrictEqual(
        yield* Stream.runCollect(viewer.pipe(Stream.take(events.length))),
        events,
      );
      const agentViewer = yield* hub.subscribeForViewer(agent);
      const suggestion: Hub.KinChatHubEvent = {
        type: "message.posted",
        orgId: person.orgId,
        message: {
          ...message,
          chatId: chat.chatId,
          status: "suggested",
          author: { _tag: "human", personId: person.personId, memberId: personMember.memberId },
        },
      };
      yield* hub.publish(suggestion);
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(agentViewer)), marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), suggestion);
    }).pipe(Effect.provide(layer)),
  );
});
