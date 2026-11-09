import { environment } from "./TaskCard.testkit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { CommandId } from "@t3tools/contracts";
import { startWakeupRun, authorityLayer, startAgentWakeup } from "./WakeupAuthority.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinMessagesSendInput,
  KinOrgId,
  KinPersonId,
  KinTaskCardState,
  KinWaitingId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
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
const decodeTask = Schema.decodeUnknownEffect(KinTaskCardState);
const decodeSend = Schema.decodeUnknownEffect(KinMessagesSendInput);
const database = authorityLayer;
const repositories = Layer.provideMerge(Repository.layer, database);
const dependencies = Layer.provideMerge(Hub.layer, repositories);
const layer = Layer.provideMerge(Service.layer, dependencies).pipe(Layer.provideMerge(environment));
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
  taskId: "worker",
  environmentId: "environment",
  threadId: decodeThreadId("worker"),
  remoteEnvironmentId: null,
  title: "Work",
  model: null,
  status: "working",
  pullRequests: [],
  lastError: null,
  updatedAt: timestamp,
});
const seed = Effect.fn("test.seed")(function* (notice = false) {
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
  const chat = yield* service.createDirect(person, { orgId: person.orgId, agentId });
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${person.orgId}, 'Lead', 0, '{}', '[]', ${chat.chatId})`;
  const prompt = notice
    ? undefined
    : yield* service.send(person, {
        chatId: chat.chatId,
        body: "Owner question",
        clientMessageId: "seed-human",
      });
  yield* startAgentWakeup({
    orgId: person.orgId,
    agentId,
    threadId,
    ...(prompt === undefined ? {} : { message: prompt }),
  });
  yield* startWakeupRun(state.threadId!, "worker");
  const agent = yield* identity.resolveAgent(caller);
  return { repo, service, identity, person, agent, chat };
});

describe("KinChatService", () => {
  it.effect(
    "creates exactly two members, derives authors from identity, and deduplicates sends",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
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
          intent: "answer",
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
              intent: "evidence",
            }),
          ),
          { reason: "not_allowed" },
        );
        assert.strictEqual(posted.authorRole, "member");
        assert.strictEqual(posted.seq, 3);
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
        const { clientMessageId: _postedId, ...postedForPerson } = posted;
        assert.deepStrictEqual(
          (yield* service.history(person, { chatId: chat.chatId, beforeSeq: 4, limit: 1 }))
            .messages,
          [postedForPerson],
        );
        const widget = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("end-service-wakeup"),
          threadId,
          runId: run.id,
        });
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              type: "task",
              state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              revision: widget.revision,
              type: "task",
              state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "settles a choice card on its first tap and refuses stale, foreign and expired taps",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const ask = {
          chatId: chat.chatId,
          clientMessageId: "ask-1",
          question: "Ship today?",
          options: [
            { label: "Ship it", kind: "yes" as const },
            { label: "Wait", kind: "no" as const },
          ],
        };
        const card = yield* service.ask(agent, ask);
        assert.deepStrictEqual(card.awaiting, [person.personId]);
        assert.deepStrictEqual(yield* service.ask(agent, ask), card);
        const later = yield* service.ask(agent, { ...ask, clientMessageId: "ask-2" });
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: card.widgetId,
              revision: 1,
              type: "choice",
              state: card.state,
            })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        const tap = (clientActionId: string, revision = 1, widgetId = card.widgetId) => ({
          widgetId,
          revision,
          actionId: "choose",
          value: "option-1",
          clientActionId,
        });
        const outsider = { ...person, personId: decodeKinPersonId("outsider") };
        yield* repo.insertPerson({
          ...outsider,
          handle: "outsider",
          displayName: "Outsider",
          githubLogin: null,
          createdAt: timestamp,
        });
        assert.include(yield* service.act(outsider, tap("outsider")).pipe(Effect.flip), {
          reason: "not_found",
        });
        yield* repo.addMember({
          ...chat,
          memberId: decodeKinMemberId("late-member"),
          principal: { _tag: "person", personId: outsider.personId },
          role: "member",
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
        assert.include(yield* service.act(outsider, tap("member")).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        assert.include(
          yield* service.act(person, { ...tap("bad"), value: "option-9" }).pipe(Effect.flip),
          { reason: "invalid_state" },
        );

        const message = yield* service.act(person, tap("tap-1"));
        assert.include(JSON.parse(message.body), { text: 'Chose "Ship it" on "Ship today?"' });
        assert.deepStrictEqual(yield* service.act(person, tap("tap-1")), message);
        const answered = Option.getOrThrow(yield* repo.getWidget(card));
        assert.strictEqual(answered.revision, 2);
        assert.deepStrictEqual(answered.awaiting, []);
        assert.include((answered.state as { answer: object }).answer, {
          optionId: "option-1",
          personId: person.personId,
          via: "tap",
        });
        assert.notInclude(
          (yield* repo.listOpenWaiting(person)).map((item) => item.widgetId),
          card.widgetId,
        );
        for (const stale of [tap("tap-2"), tap("tap-3", 2)])
          assert.include(yield* service.act(person, stale).pipe(Effect.flip), {
            reason: "widget_changed",
          });

        yield* TestClock.adjust("24 hours");
        assert.include(
          yield* service.act(person, tap("late", 1, later.widgetId)).pipe(Effect.flip),
          { reason: "invalid_state", message: "This question expired." },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "takes reactions as replies: 👍 answers a yes/no card once, wakes on the lead's latest message, refuses privileged cards",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed();
        const sql = yield* SqlClient.SqlClient;
        const react = (messageId: KinMessageId, emoji: "👍" | "✅" | "❤️", on = true) =>
          service.react(person, { messageId, emoji, on });
        const card = yield* service.ask(agent, {
          chatId: chat.chatId,
          clientMessageId: "ask-react",
          question: "Ship today?",
          options: [
            { label: "Ship it", kind: "yes" },
            { label: "Wait", kind: "no" },
          ],
        });
        const first = yield* react(card.messageId, "👍");
        // A retried reaction changes nothing.
        assert.deepStrictEqual(yield* react(card.messageId, "👍"), first);
        const answered = Option.getOrThrow(yield* repo.getWidget(card));
        assert.include((answered.state as { answer: object }).answer, {
          optionId: "option-1",
          via: "reaction",
          emoji: "👍",
        });
        assert.include(yield* react(card.messageId, "✅").pipe(Effect.flip), {
          reason: "widget_changed",
        });
        const tap = {
          widgetId: card.widgetId,
          revision: answered.revision,
          actionId: "choose",
          value: "option-2",
          clientActionId: "tap-after-reaction",
        };
        assert.include(yield* service.act(person, tap).pipe(Effect.flip), {
          reason: "widget_changed",
        });
        // A card tap wakes the lead through its widget_action message, so the reaction doesn't.
        const woke = () =>
          sql<{ messageId: string; emoji: string }>`SELECT message_id AS "messageId", emoji
            FROM kin_reactions WHERE org_id = ${person.orgId} AND woke_at IS NOT NULL
            ORDER BY woke_at, message_id`;
        assert.deepStrictEqual(yield* woke(), []);

        const older = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-older",
          body: "Shall I merge it?",
          intent: "answer",
        });
        const latest = yield* service.send(agent, {
          chatId: chat.chatId,
          clientMessageId: "lead-latest",
          body: "Merged. Anything else?",
          intent: "answer",
        });
        yield* react(older.messageId, "👍");
        yield* react(latest.messageId, "❤️");
        assert.deepStrictEqual(yield* woke(), []);
        yield* react(latest.messageId, "👍");
        // The second yes inside the 30 s cooldown is recorded, not a second wake-up.
        yield* react(latest.messageId, "✅");
        assert.deepStrictEqual(yield* woke(), [{ messageId: latest.messageId, emoji: "👍" }]);
        assert.deepStrictEqual(
          yield* sql`SELECT 1 AS opened FROM kin_floor_runs
            WHERE org_id = ${person.orgId} AND opened_by = ${latest.messageId} AND state = 'open'`,
          [{ opened: 1 }],
        );
        yield* TestClock.adjust("30 seconds");
        yield* react(latest.messageId, "✅", false);
        yield* react(latest.messageId, "✅");
        assert.lengthOf(yield* woke(), 2);
        const history = yield* service.history(person, {
          chatId: chat.chatId,
          beforeSeq: latest.seq + 1,
          limit: 10,
        });
        assert.deepStrictEqual(
          history.reactions
            ?.filter((reaction) => reaction.messageId === latest.messageId)
            .map((reaction) => reaction.emoji)
            .toSorted(),
          ["✅", "❤️", "👍"].toSorted(),
        );

        // Approval and other privileged cards refuse; so do non-members and unknown emoji.
        const notice = yield* service.notice({
          orgId: person.orgId,
          chatId: chat.chatId,
          messageId: KinMessageId.make("approval-anchor"),
          body: "Approve the merge?",
        });
        yield* repo.insertWidget({
          ...card,
          widgetId: KinWidgetId.make("approval-card"),
          messageId: notice.message.messageId,
          type: "approval",
          state: {},
        });
        assert.include(yield* react(notice.message.messageId, "👍").pipe(Effect.flip), {
          reason: "not_allowed",
        });
        const outsider = { ...person, personId: decodeKinPersonId("reaction-outsider") };
        yield* repo.insertPerson({
          ...outsider,
          handle: "reaction-outsider",
          displayName: "Outsider",
          githubLogin: null,
          createdAt: timestamp,
        });
        assert.include(
          yield* service
            .react(outsider, { messageId: latest.messageId, emoji: "👍", on: true })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
        assert.include(
          yield* service
            .react(person, {
              messageId: latest.messageId,
              emoji: "🔥" as "👍",
              on: true,
            })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
        // kin_react pins the message to its wake-up's chat.
        assert.include(
          yield* service
            .react(agent, {
              messageId: latest.messageId,
              emoji: "👍",
              on: true,
              chatId: decodeKinChatId("other-chat"),
            })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("hides foreign org ids on every method and checks active membership and roles", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      const widget = yield* service.createTaskCard({
        orgId: person.orgId,
        chatId: chat.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
      });
      yield* service.addWaiting(agent, {
        chatId: chat.chatId,
        personId: person.personId,
        messageId: widget.messageId,
        widgetId: widget.widgetId,
        reason: "question",
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

  it.effect("creates trusted cards idempotently and enforces ownership and server fields", () =>
    Effect.gen(function* () {
      const { repo, service, person, agent, chat } = yield* seed();
      for (const caller of [agent, person])
        assert.include(
          yield* service
            .upsertWidget(caller, { chatId: chat.chatId, type: "task", state })
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      const input = {
        orgId: person.orgId,
        chatId: chat.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
      };
      for (const patch of [
        { orgId: KinOrgId.make("foreign") },
        { threadId: ThreadId.make("missing") },
        { chatId: KinChatId.make("missing") },
        { authorAgentId: KinAgentId.make("missing") },
      ])
        assert.include(yield* service.createTaskCard({ ...input, ...patch }).pipe(Effect.flip), {
          reason: "not_found",
        });
      const widget = yield* service.createTaskCard(input);
      assert.deepStrictEqual(yield* service.createTaskCard(input), widget);
      assert.include(
        yield* service.createTaskCard({ ...input, title: "Changed" }).pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.strictEqual(
        (yield* repo.history({ ...chat, beforeSeq: 99, limit: 100 })).messages.length,
        2,
      );
      const anchor = Option.getOrThrow(yield* repo.getMessage(widget));
      assert.include(anchor.author, { _tag: "agent", agentId: agent.agentId });
      for (const input of [
        { type: "approval", state },
        { type: "unknown", state },
        { type: "task", state: {}, widgetId: widget.widgetId, revision: 1 },
      ])
        assert.include(
          yield* service.upsertWidget(agent, { chatId: chat.chatId, ...input }).pipe(Effect.flip),
          { reason: input.type === "approval" ? "use_approvals" : "invalid_state" },
        );
      const otherId = KinAgentId.make("other");
      const otherThread = ThreadId.make("other-thread");
      yield* repo.insertAgent({
        ...person,
        agentId: otherId,
        ownerPersonId: person.personId,
        displayName: "Other",
        role: "lead",
        createdAt: timestamp,
      });
      const identity = yield* Identity.KinIdentity.pipe(Effect.provide(identityLayer));
      yield* identity.registerAgentThread({ ...person, agentId: otherId, threadId: otherThread });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES (${otherId}, ${person.orgId}, 'Other', 0, '{}', '[]', ${chat.chatId})`;
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const otherRun = yield* startWakeupRun(otherThread, "other-wakeup");
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids) VALUES ('other-wakeup', ${person.orgId}, ${otherId}, ${otherThread}, ${otherRun.id}, 'test', 0, 'running', '[]')`;
      const other = yield* identity.resolveAgent({
        ...caller,
        thread: { ...caller.thread!, threadId: otherThread },
      });
      yield* repo.addMember({
        ...chat,
        memberId: KinMemberId.make("other-member"),
        principal: { _tag: "agent", agentId: otherId },
        role: "member",
        joinedAt: timestamp,
        leftAt: null,
        mutedUntil: null,
      });
      assert.include(
        yield* service
          .upsertWidget(other, {
            chatId: chat.chatId,
            widgetId: widget.widgetId,
            revision: widget.revision,
            type: "task",
            state: widget.state,
            closed: true,
          })
          .pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'other-wakeup'`;
      yield* sql`UPDATE kin_wakeups SET status = 'running' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const updated = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: 1,
        type: "task",
        state: { ...state, status: "done", lastError: "invented" },
        awaiting: [person.personId],
      });
      assert.strictEqual(
        (yield* decodeTask(updated.state)).status,
        (yield* decodeTask(widget.state)).status,
      );
      assert.isNull((yield* decodeTask(updated.state)).lastError);
      const actionInput = {
        widgetId: widget.widgetId,
        revision: updated.revision,
        actionId: "done",
        clientActionId: "action",
        value: { checked: true },
      };
      assert.include(
        yield* service.act(person, { ...actionInput, revision: 99 }).pipe(Effect.flip),
        { reason: "widget_changed" },
      );
      const action = yield* service.act(person, actionInput);
      assert.strictEqual(action.kind, "widget_action");
      assert.deepStrictEqual(yield* service.act(person, actionInput), action);
      assert.include(
        yield* service.act(person, { ...actionInput, actionId: "changed" }).pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
      for (const patch of [
        {},
        { revision: updated.revision, replyTo: anchor.messageId },
        { revision: updated.revision, state: { ...state, threadId: "foreign" } },
      ])
        assert.include(
          yield* service
            .upsertWidget(agent, {
              chatId: chat.chatId,
              widgetId: widget.widgetId,
              type: "task",
              state,
              ...patch,
            })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
      const closed = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: updated.revision,
        type: "task",
        state,
        closed: true,
      });
      assert.isNotNull(closed.closedAt);
      assert.deepStrictEqual(yield* service.createTaskCard(input), closed);
      const reopened = yield* service.upsertWidget(agent, {
        chatId: chat.chatId,
        widgetId: widget.widgetId,
        revision: closed.revision,
        type: "task",
        state: { ...state, title: "Edited" },
        closed: false,
      });
      assert.isNull(reopened.closedAt);
      assert.deepStrictEqual(yield* service.createTaskCard(input), reopened);
      assert.include(
        yield* service
          .upsertWidget(agent, {
            chatId: chat.chatId,
            widgetId: widget.widgetId,
            revision: closed.revision,
            type: "task",
            state,
          })
          .pipe(Effect.flip),
        { reason: "widget_changed" },
      );
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${person.orgId} AND thread_id = ${threadId}`;
      const serverThread = ThreadId.make("server-only");
      yield* startWakeupRun(serverThread, "server-only");
      assert.strictEqual(
        (yield* service.createTaskCard({ ...input, threadId: serverThread })).revision,
        1,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "publishes question waiting and reply resolution, rolls back atomically, and keeps read state monotonic",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, agent, chat } = yield* seed(true);
        const hub = yield* Hub.KinChatHub;
        const events = yield* Stream.toQueue(yield* hub.subscribeForViewer(person), {
          capacity: "unbounded",
        });
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
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        assert.deepStrictEqual(yield* repo.listOpenWaiting(person), []);
        const question = yield* service.send(agent, input);
        assert.strictEqual(question.seq, 1);
        assert.strictEqual((yield* Queue.take(events)).type, "message.posted");
        assert.strictEqual((yield* Queue.take(events)).type, "waiting.updated");
        assert.strictEqual((yield* repo.listOpenWaiting(person)).length, 1);
        assert.deepStrictEqual(yield* service.send(agent, input), question);
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        yield* service.send(person, { chatId: chat.chatId, body: "Yes", clientMessageId: "reply" });
        assert.strictEqual((yield* Queue.take(events)).type, "message.posted");
        const resolved = yield* Queue.take(events);
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
        const read = yield* Queue.take(events);
        assert.include(read, { type: "read.updated", seq: 2 });
        assert.isTrue(Option.isNone(yield* Queue.poll(events)));
        const approvalWidget = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: state.threadId!,
          title: state.title,
          model: state.model,
        });
        yield* sql`UPDATE kin_widgets SET type = 'approval' WHERE org_id = ${person.orgId} AND widget_id = ${approvalWidget.widgetId}`;
        const approval = {
          orgId: person.orgId,
          chatId: chat.chatId,
          waitingId: decodeKinWaitingId("server-approval"),
          personId: person.personId,
          messageId: approvalWidget.messageId,
          widgetId: approvalWidget.widgetId,
          reason: "approval",
          createdAt: timestamp,
          resolvedAt: null,
          resolution: null,
        } as const;
        assert.include(yield* Effect.flip(repo.addWaiting(approval)), { reason: "not_allowed" });
        yield* repo.addApprovalWaiting(approval);
        const humanQuestion = yield* service.send(person, {
          chatId: chat.chatId,
          body: "Another question",
          clientMessageId: "human-question",
        });
        const anotherQuestion = yield* service.addWaiting(person, {
          ...approval,
          reason: "question",
          messageId: humanQuestion.messageId,
          widgetId: null,
        });
        const ownQuestion = yield* service.addWaiting(agent, {
          ...approval,
          messageId: question.messageId,
          widgetId: null,
          reason: "question",
        });
        for (const operation of [
          service.addWaiting(agent, { ...approval }),
          service.resolveWaiting(agent, { waitingId: approval.waitingId, resolution: "approved" }),
          service.resolveWaiting(person, { waitingId: approval.waitingId, resolution: "approved" }),
          service.resolveWaiting(agent, {
            waitingId: anotherQuestion.waitingId,
            resolution: "answered",
          }),
        ])
          assert.include(yield* Effect.flip(operation), { reason: "not_allowed" });
        const secondaryThread = ThreadId.make("secondary");
        yield* startWakeupRun(secondaryThread, "secondary");
        const secondaryAnchor = yield* service.createTaskCard({
          orgId: person.orgId,
          chatId: chat.chatId,
          authorAgentId: agent.agentId,
          threadId: secondaryThread,
          title: state.title,
          model: state.model,
        });
        yield* repo.insertWidget({
          ...secondaryAnchor,
          widgetId: KinWidgetId.make("secondary-approval"),
          type: "approval",
        });
        const secondaryWaiting = {
          ...approval,
          waitingId: KinWaitingId.make("secondary-waiting"),
          reason: "question" as const,
          messageId: secondaryAnchor.messageId,
          widgetId: secondaryAnchor.widgetId,
        };
        for (const attempt of [
          repo.addWaiting(secondaryWaiting).pipe(Effect.asVoid),
          service.addWaiting(person, secondaryWaiting).pipe(Effect.asVoid),
          repo.addWaiting({ ...secondaryWaiting, messageId: null }).pipe(Effect.asVoid),
          service.addWaiting(person, { ...secondaryWaiting, messageId: null }).pipe(Effect.asVoid),
        ])
          assert.include(yield* Effect.flip(attempt), { reason: "not_allowed" });
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
      const { repo, service, person, agent, chat } = yield* seed(true);
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
        intent: "evidence",
      });
      const widget = yield* service.createTaskCard({
        orgId: person.orgId,
        chatId: other.chatId,
        authorAgentId: agent.agentId,
        threadId: state.threadId!,
        title: state.title,
        model: state.model,
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
        events.map((event) => {
          if (event.type !== "message.posted") return event;
          const { clientMessageId: _id, ...visible } = event.message;
          return { ...event, message: visible };
        }),
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
      const waitingEvent = events.find((event) => event.type === "waiting.updated");
      assert.isDefined(waitingEvent);
      if (waitingEvent.type === "waiting.updated")
        yield* hub.publish({
          ...waitingEvent,
          item: { ...waitingEvent.item, personId: KinPersonId.make("someone-else") },
        });
      yield* hub.publish(marker);
      assert.deepStrictEqual(Option.getOrThrow(yield* Stream.runHead(viewer)), marker);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "requires an owner to remove members and publishes cancelled waiting only after commit",
    () =>
      Effect.gen(function* () {
        const { repo, service, person, chat } = yield* seed();
        const hub = yield* Hub.KinChatHub;
        const sql = yield* SqlClient.SqlClient;
        const other = { ...person, personId: KinPersonId.make("other-person") };
        yield* repo.insertPerson({
          ...other,
          handle: "other",
          displayName: "Other",
          githubLogin: null,
          createdAt: timestamp,
        });
        const member = yield* repo.addMember({
          orgId: person.orgId,
          chatId: chat.chatId,
          memberId: KinMemberId.make("other-member"),
          principal: other,
          role: "member",
          joinedAt: timestamp,
          leftAt: null,
          mutedUntil: null,
        });
        const waiting = yield* service.addWaiting(person, {
          chatId: chat.chatId,
          personId: other.personId,
          messageId: null,
          widgetId: null,
          reason: "mention",
        });
        const published: Array<Hub.KinChatHubEvent> = [];
        const monitored = yield* Service.KinChatService.pipe(
          Effect.provide(
            Layer.fresh(Service.layer).pipe(
              Layer.provide(
                Layer.succeed(Hub.KinChatHub, {
                  ...hub,
                  publish: (event) =>
                    hub.publish(event).pipe(
                      Effect.andThen(
                        sql.afterCommit(
                          Effect.sync(() => {
                            published.push(event);
                          }),
                        ),
                      ),
                    ),
                }),
              ),
            ),
          ),
        );
        assert.include(yield* Effect.flip(monitored.leaveChat(other, member)), {
          reason: "not_allowed",
        });
        yield* sql
          .withTransaction(
            monitored.leaveChat(person, member).pipe(Effect.andThen(Effect.fail("rollback"))),
          )
          .pipe(Effect.flip);
        assert.deepStrictEqual(published, []);
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), [waiting]);
        const chatEvents = yield* Stream.toQueue(
          service.subscribe(other, { chatId: chat.chatId }),
          { capacity: "unbounded" },
        );
        assert.strictEqual((yield* Queue.take(chatEvents))._tag, "backlog");
        const updates = yield* Stream.toQueue(service.subscribeChats([other], {}), {
          capacity: "unbounded",
        });
        assert.strictEqual((yield* Queue.take(updates))._tag, "snapshot");
        yield* monitored.leaveChat(person, member);
        const cancelled = Option.getOrThrow(yield* repo.getWaiting(waiting));
        assert.strictEqual(cancelled.resolution, "cancelled");
        const markerChat = yield* repo.createChat({
          ...chat,
          chatId: KinChatId.make("marker-chat"),
          kind: "project_group",
          directKey: null,
        });
        yield* repo.addMember({
          ...member,
          memberId: KinMemberId.make("marker-member"),
          chatId: markerChat.chatId,
        });
        yield* hub.publish({ type: "chat.created", orgId: other.orgId, chat: markerChat });
        assert.deepStrictEqual(yield* Queue.take(updates), { _tag: "waiting", item: cancelled });
        assert.strictEqual(published.length, 2);
        assert.strictEqual((yield* Queue.take(updates))._tag, "chat");
        assert.deepStrictEqual(yield* Queue.take(chatEvents), {
          _tag: "member",
          member: Option.getOrThrow(yield* repo.getMember(member)),
        });
        assert.isTrue(Cause.isDone(yield* Queue.take(chatEvents).pipe(Effect.flip)));
        assert.deepStrictEqual(published[0], {
          type: "waiting.updated",
          orgId: person.orgId,
          item: cancelled,
        });
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), []);
        yield* repo.addMember(member);
        assert.deepStrictEqual(yield* repo.listOpenWaiting(other), []);
      }).pipe(Effect.provide(layer)),
  );
});
