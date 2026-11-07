import { assert, describe, it } from "@effect/vitest";
import {
  KinOrgId,
  KinPersonId,
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinWidgetId,
  KinWaitingId,
  KinChat,
  KinChatMember,
  KinMessage,
  KinWidget,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Repository from "./KinChatRepository.ts";

const decodeMessage = Schema.decodeSync(KinMessage);
const decodeMessageId = Schema.decodeSync(KinMessageId);
const decodeMemberId = Schema.decodeSync(KinMemberId);
const decodePersonId = Schema.decodeSync(KinPersonId);
const decodeChatId = Schema.decodeSync(KinChatId);
const decodeThreadId = Schema.decodeSync(ThreadId);
const decodeWidgetId = Schema.decodeSync(KinWidgetId);
const decodeAgentId = Schema.decodeSync(KinAgentId);
const decodeWaitingId = Schema.decodeSync(KinWaitingId);
const decodeOrgId = Schema.decodeSync(KinOrgId);
const decodeTurnItemId = Schema.decodeSync(TurnItemId);

const timestamp = "2026-11-07T00:00:00.000Z";
const later = "2026-11-07T01:00:00.000Z";
const orgId = decodeOrgId("org-b");
const personId = decodePersonId("owner");
const agentId = decodeAgentId("lead");
const threadId = decodeThreadId("lead-thread");
const chatId = decodeChatId("chat");
const memberId = decodeMemberId("owner-member");
const agentMemberId = decodeMemberId("lead-member");
const widgetId = decodeWidgetId("widget");
const waitingId = decodeWaitingId("waiting");
const scope = { orgId, chatId, memberId };
const chat: KinChat = {
  orgId,
  chatId,
  kind: "direct",
  title: null,
  teamId: null,
  lastSeq: 0,
  lastMessageAt: null,
  createdAt: timestamp,
  archivedAt: null,
};
const owner: KinChatMember = {
  orgId,
  chatId,
  memberId,
  principal: { _tag: "person", personId },
  role: "owner",
  joinedAt: timestamp,
  leftAt: null,
  mutedUntil: null,
};
const agentMember: KinChatMember = {
  ...owner,
  memberId: agentMemberId,
  principal: { _tag: "agent", agentId },
  role: "member",
};
const message = (id: string, overrides: Partial<Omit<KinMessage, "seq">> = {}) =>
  ({
    orgId,
    chatId,
    messageId: decodeMessageId(id),
    author: { _tag: "human", personId, memberId },
    authorRole: "owner",
    kind: "text",
    body: id,
    intent: null,
    mentions: [agentMemberId],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt: timestamp,
    editedAt: null,
    ...overrides,
    clientMessageId: { kind: "send", id },
  }) satisfies Omit<KinMessage, "seq"> & { clientMessageId: { kind: "send" | "act"; id: string } };
const widget: KinWidget = {
  orgId,
  chatId,
  widgetId,
  messageId: decodeMessageId("first"),
  widgetClass: "native",
  type: "task",
  revision: 1,
  state: { title: "Work", items: [1, true, null] },
  source: { threadId, itemId: decodeTurnItemId("item") },
  feed: { kind: "thread", key: "lead-thread" },
  awaiting: [personId],
  pinnedAt: timestamp,
  closedAt: null,
  updatedAt: timestamp,
};
const database = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const layer = Layer.provideMerge(Repository.layer, database);
const seed = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  yield* repo.insertOrg({ orgId, name: "Kin", createdAt: timestamp });
  yield* repo.insertPerson({
    orgId,
    personId,
    handle: "owner",
    displayName: "Owner",
    githubLogin: null,
    createdAt: timestamp,
  });
  yield* repo.insertAgent({
    orgId,
    agentId,
    displayName: "Lead",
    role: "lead" as const,
    ownerPersonId: personId,
    createdAt: timestamp,
  });
  yield* repo.registerAgentThread({
    orgId,
    agentId,
    threadId,
    startedAt: timestamp,
    endedAt: null,
  });
  yield* repo.createChat({ ...chat, directKey: "owner:lead" });
  yield* repo.addMember(owner);
  yield* repo.addMember(agentMember);
  return repo;
});

describe("KinChatRepository", () => {
  it.effect(
    "round-trips records, deduplicates direct chats and sends, and separates action ids",
    () =>
      Effect.gen(function* () {
        const repo = yield* seed;
        const org = { orgId, name: "Kin", createdAt: timestamp };
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getOrg({ orgId })), org);
        assert.deepStrictEqual(yield* repo.listAllOrgs(), [org]);
        const person = {
          orgId,
          personId,
          handle: "owner",
          displayName: "Owner",
          githubLogin: null,
        };
        assert.deepStrictEqual(
          Option.getOrThrow(yield* repo.getPerson({ orgId, personId })),
          person,
        );
        assert.deepStrictEqual(yield* repo.listPeople({ orgId }), [person]);
        const agent = {
          orgId,
          agentId,
          displayName: "Lead",
          role: "lead" as const,
          ownerPersonId: personId,
        };
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getAgent({ orgId, agentId })), {
          ...agent,
          retiredAt: null,
        });
        assert.deepStrictEqual(yield* repo.listAgents({ orgId }), [{ ...agent, retiredAt: null }]);
        assert.deepStrictEqual(
          yield* repo.createChat({
            ...chat,
            chatId: decodeChatId("duplicate"),
            directKey: "owner:lead",
          }),
          chat,
        );
        assert.deepStrictEqual(yield* repo.listChats({ orgId }), [chat]);
        assert.deepStrictEqual(yield* repo.listMembers(scope), [agentMember, owner]);
        assert.deepStrictEqual(yield* repo.listMembersByPerson({ orgId, personId }), [owner]);
        assert.deepStrictEqual(yield* repo.listMembersByAgent({ orgId, agentId }), [agentMember]);
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getMember(scope)), owner);
        const indexSql = yield* SqlClient.SqlClient;
        for (const [principal, column] of [
          [owner.principal, "person_id"],
          [agentMember.principal, "agent_id"],
        ] as const) {
          assert.isTrue(Option.isSome(yield* repo.activeMember({ ...scope, principal })));
          const plan = yield* indexSql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN ${Repository.activeMemberStatement(indexSql, { ...scope, principal })}`;
          assert.isTrue(plan.some((row) => row.detail.includes(`(chat_id=? AND ${column}=?)`)));
        }

        for (const retry of [owner, agentMember]) {
          assert.deepStrictEqual(yield* repo.addMember(retry), retry);
        }
        assert.deepStrictEqual(
          yield* repo.registerAgentThread({
            orgId,
            agentId,
            threadId,
            startedAt: later,
            endedAt: null,
          }),
          { orgId, agentId, threadId, startedAt: timestamp, endedAt: null },
        );
        const secondPerson = decodePersonId("second-person");
        yield* repo.insertPerson({
          orgId,
          personId: secondPerson,
          handle: "second",
          displayName: "Second",
          githubLogin: null,
          createdAt: timestamp,
        });
        for (const retry of [
          {
            ...owner,
            memberId: decodeMemberId("second-owner"),
            principal: { _tag: "person", personId: secondPerson },
          },
          { ...owner, principal: { _tag: "person", personId: secondPerson } },
          { ...owner, memberId: decodeMemberId("retry-member") },
          { ...agentMember, memberId: decodeMemberId("retry-agent-member") },
          { ...agentMember, memberId },
        ] as const) {
          const failure = yield* Effect.flip(repo.addMember(retry));
          assert.strictEqual(failure._tag, "KinChatError");
          if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_allowed");
        }
        yield* repo.insertAgent({
          orgId,
          agentId: decodeAgentId("second"),
          ownerPersonId: personId,
          displayName: "Second",
          role: "lead",
          createdAt: timestamp,
        });
        const conflict = yield* Effect.flip(
          repo.registerAgentThread({
            orgId,
            threadId,
            agentId: decodeAgentId("second"),
            startedAt: timestamp,
            endedAt: null,
          }),
        );
        assert.strictEqual(conflict._tag, "KinChatError");
        if (conflict._tag === "KinChatError") assert.strictEqual(conflict.reason, "not_allowed");
        for (const input of [
          { ...chat, kind: "direct", directKey: null },
          { ...chat, kind: "team_group", directKey: "invalid" },
        ] as const) {
          const failure = yield* Effect.flip(repo.createChat(input));
          assert.strictEqual(failure._tag, "KinChatError");
          if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "invalid_state");
        }
        for (const write of [
          repo
            .addMember({
              ...owner,
              memberId: decodeMemberId("already-left"),
              principal: { _tag: "person", personId: secondPerson },
              leftAt: later,
            })
            .pipe(Effect.asVoid),
          repo
            .registerAgentThread({
              orgId,
              agentId,
              threadId: decodeThreadId("already-ended"),
              startedAt: timestamp,
              endedAt: later,
            })
            .pipe(Effect.asVoid),
        ]) {
          const failure = yield* Effect.flip(write);
          assert.strictEqual(failure._tag, "KinChatError");
          if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "invalid_state");
        }
        const initialChat = { ...chat, lastSeq: 99 };
        const team = yield* repo.createChat({
          ...initialChat,
          chatId: decodeChatId("team"),
          kind: "team_group",
          directKey: null,
        });
        assert.strictEqual(team.lastSeq, 0);
        assert.deepStrictEqual(
          yield* repo.createChat({ ...chat, chatId: team.chatId, directKey: "owner:lead" }),
          chat,
        );
        const wrongChat = yield* Effect.flip(
          repo.createChat({ ...chat, chatId: team.chatId, directKey: "new-direct-key" }),
        );
        assert.strictEqual(wrongChat._tag, "KinChatError");
        if (wrongChat._tag === "KinChatError") assert.strictEqual(wrongChat.reason, "not_found");
        assert.deepStrictEqual(yield* repo.leaveChat({ ...scope, leftAt: later }), []);
        assert.deepStrictEqual(yield* repo.leaveChat({ ...scope, leftAt: timestamp }), []);
        assert.strictEqual(
          (yield* Effect.flip(repo.insertMessage(message("left-post"))))._tag,
          "KinChatError",
        );
        assert.strictEqual(Option.getOrThrow(yield* repo.getMember(scope)).leftAt, later);
        const rejoined = yield* repo.addMember({ ...owner, joinedAt: later });
        assert.deepStrictEqual(rejoined, { ...owner, joinedAt: later });
        const first = yield* repo.insertMessage(message("first"));
        assert.deepStrictEqual(first, decodeMessage({ ...message("first"), seq: 1 }));
        const repeated = yield* Effect.all(
          Array.from({ length: 5 }, (_, i) =>
            repo.insertMessage({
              ...message("first"),
              messageId: decodeMessageId(`retry-${i}`),
              body: first.body,
              createdAt: later,
            }),
          ),
          { concurrency: "unbounded" },
        );
        for (const retried of repeated) assert.deepStrictEqual(retried, first);
        yield* repo.leaveChat({ ...scope, leftAt: later });
        assert.deepStrictEqual(yield* repo.insertMessage(message("first")), first);
        yield* repo.addMember({ ...owner, joinedAt: later });
        assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 1);
        assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastMessageAt, timestamp);
        const action = yield* repo.insertMessage({
          ...message("action", { kind: "system" }),
          clientMessageId: { kind: "act", id: "first" },
        });
        assert.strictEqual(action.seq, 2);
        assert.strictEqual(action.messageId, decodeMessageId("action"));
        assert.deepStrictEqual(
          yield* repo.insertMessage({
            ...message("repeated-action", { kind: "system", body: "action" }),
            clientMessageId: { kind: "act", id: "first" },
          }),
          action,
        );
        yield* repo.insertWidget(widget);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId })),
          widget,
        );
        const suppliedRevision = {
          ...widget,
          widgetId: decodeWidgetId("server-revision"),
          revision: 99,
        };
        yield* repo.insertWidget(suppliedRevision);
        assert.strictEqual(
          Option.getOrThrow(
            yield* repo.getWidget({ orgId, widgetId: decodeWidgetId("server-revision") }),
          ).revision,
          1,
        );
        yield* repo.markRead({ ...scope, seq: 1, updatedAt: timestamp });
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getReadState(scope)), {
          ...scope,
          lastReadSeq: 1,
          updatedAt: timestamp,
        });
        const waiting = {
          orgId,
          waitingId,
          personId,
          chatId,
          messageId: first.messageId,
          widgetId,
          reason: "decision",
          createdAt: timestamp,
          resolvedAt: null,
          resolution: null,
        } as const;
        assert.include(yield* Effect.flip(repo.addWaiting({ ...waiting, resolvedAt: later })), {
          reason: "invalid_state",
        });
        assert.strictEqual(yield* repo.addWaiting(waiting), true);
        assert.strictEqual(
          yield* repo.addWaiting({ ...waiting, waitingId: decodeWaitingId("duplicate-waiting") }),
          false,
        );
        assert.deepStrictEqual(
          Option.getOrThrow(yield* repo.getWaiting({ orgId, waitingId })),
          waiting,
        );
        for (const retried of yield* Effect.all(
          Array.from({ length: 5 }, () => repo.addWaiting(waiting)),
          { concurrency: "unbounded" },
        ))
          assert.strictEqual(retried, true);
        for (const retry of [
          { ...waiting, reason: "question" },
          { ...waiting, messageId: null },
          { ...waiting, createdAt: later },
        ] as const) {
          const failure = yield* Effect.flip(repo.addWaiting(retry));
          assert.strictEqual(failure._tag, "KinChatError");
          if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_allowed");
        }
        assert.deepStrictEqual(yield* repo.listOpenWaiting({ orgId, personId }), [waiting]);
        assert.strictEqual(
          yield* repo.resolveWaiting({
            orgId,
            waitingId,
            resolvedAt: later,
            resolution: "answered",
          }),
          true,
        );
        assert.strictEqual(
          yield* repo.resolveWaiting({
            orgId,
            waitingId,
            resolvedAt: timestamp,
            resolution: "again",
          }),
          false,
        );
        assert.strictEqual(yield* repo.addWaiting(waiting), true);
        assert.deepStrictEqual(yield* repo.listOpenWaiting({ orgId, personId }), []);
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getWaiting({ orgId, waitingId })), {
          ...waiting,
          resolvedAt: later,
          resolution: "answered",
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getAgentThread({ orgId, threadId })), {
          orgId,
          agentId,
          threadId,
          startedAt: timestamp,
          endedAt: null,
        });
        assert.strictEqual(yield* repo.endAgentThread({ orgId, threadId, endedAt: later }), true);
        assert.strictEqual(
          yield* repo.endAgentThread({ orgId, threadId, endedAt: timestamp }),
          false,
        );
        assert.strictEqual(
          Option.getOrThrow(yield* repo.getAgentThread({ orgId, threadId })).endedAt,
          later,
        );
        const endedRetry = yield* Effect.flip(
          repo.registerAgentThread({
            orgId,
            threadId,
            agentId,
            startedAt: timestamp,
            endedAt: null,
          }),
        );
        assert.strictEqual(endedRetry._tag, "KinChatError");
        if (endedRetry._tag === "KinChatError")
          assert.strictEqual(endedRetry.reason, "not_allowed");
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT typeof(seq) AS type FROM kin_messages WHERE org_id = ${orgId}`,
          [{ type: "integer" }, { type: "integer" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT typeof(revision) AS type FROM kin_widgets WHERE org_id = ${orgId}`,
          [{ type: "integer" }, { type: "integer" }],
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects left mentions and retired authors inside the post transaction", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.leaveChat({ ...scope, memberId: agentMemberId, leftAt: later });
      assert.include(yield* Effect.flip(repo.insertMessage(message("left-mention"))), {
        reason: "not_found",
      });
      yield* repo.addMember(agentMember);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_agents SET retired_at = ${later} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      assert.deepStrictEqual(yield* repo.listActiveAgentThreads(), []);
      assert.include(
        yield* Effect.flip(
          repo.insertMessage(
            message("retired", {
              author: {
                _tag: "agent",
                agentId,
                memberId: agentMemberId,
                ownerPersonId: personId,
                threadId,
              },
              intent: "answer",
            }),
          ),
        ),
        { reason: "not_found" },
      );
      assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("allocates gapless seqs under 20 concurrent sends", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      const sent = yield* Effect.all(
        Array.from({ length: 20 }, (_, i) => repo.insertMessage(message(`message-${i}`))),
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual(
        sent.map((m) => m.seq).sort((a, b) => a - b),
        Array.from({ length: 20 }, (_, i) => i + 1),
      );
      assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 20);
      const failed = yield* Effect.flip(
        repo.insertMessage({
          ...message("message-0"),
          clientMessageId: { kind: "send", id: "new-id" },
        }),
      );
      assert.include(failed, { reason: "not_found" });
      assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 20);
      assert.strictEqual((yield* repo.insertMessage(message("next"))).seq, 21);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pages history exclusively in ascending order and resumes after a seq", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      for (let i = 1; i <= 5; i++) {
        if (i === 4) yield* repo.insertWidget(widget);
        yield* repo.insertMessage(
          message(
            i === 3 ? "first" : `message-${i}`,
            i === 5 ? { kind: "widget_action", widgetId } : {},
          ),
        );
      }
      for (const [beforeSeq, limit, seqs, hasMore] of [
        [6, 2, [4, 5], true],
        [4, 2, [2, 3], true],
        [2, 2, [1], false],
        [1, 2, [], false],
        [6, 5, [1, 2, 3, 4, 5], false],
        [99, 100, [1, 2, 3, 4, 5], false],
      ] as const) {
        const page = yield* repo.history({ orgId, chatId, beforeSeq, limit });
        assert.deepStrictEqual(
          page.messages.map((m) => m.seq),
          [...seqs],
        );
        assert.strictEqual(page.hasMore, hasMore);
        assert.deepStrictEqual(
          page.widgets,
          seqs.some((seq) => seq === 3 || seq === 5) ? [widget] : [],
        );
      }
      for (const limit of [0, 101, 1.5]) {
        assert.strictEqual(
          (yield* Effect.flip(repo.history({ orgId, chatId, beforeSeq: 6, limit })))._tag,
          "PersistenceDecodeError",
        );
      }
      for (const limit of [0, 201, 1.5]) {
        assert.strictEqual(
          (yield* Effect.flip(repo.messagesAfter({ orgId, chatId, afterSeq: 0, limit })))._tag,
          "PersistenceDecodeError",
        );
      }
      for (const [afterSeq, limit, expected] of [
        [0, 200, [1, 2, 3, 4, 5]],
        [0, 2, [1, 2]],
        [2, 100, [3, 4, 5]],
        [5, 2, []],
      ] as const) {
        assert.deepStrictEqual(
          (yield* repo.messagesAfter({ orgId, chatId, afterSeq, limit })).map((m) => m.seq),
          [...expected],
        );
      }
      for (const status of ["suggested", "dismissed"] as const)
        yield* repo.insertMessage(message(status, { status }));
      yield* repo.insertMessage(message("visible"));
      for (const [viewerMemberId, seqs] of [
        [agentMemberId, [5, 8]],
        [memberId, [7, 8]],
      ] as const) {
        const page = yield* repo.history({ orgId, chatId, beforeSeq: 9, limit: 2, viewerMemberId });
        assert.deepStrictEqual(
          page.messages.map((row) => row.seq),
          [...seqs],
        );
        assert.strictEqual(page.hasMore, true);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isolates every read and refuses writes against another org's records", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.insertMessage(message("first"));
      yield* repo.insertWidget(widget);
      yield* repo.markRead({ ...scope, seq: 1, updatedAt: timestamp });
      yield* repo.addWaiting({
        orgId,
        waitingId,
        personId,
        chatId,
        messageId: widget.messageId,
        widgetId,
        reason: "question",
        createdAt: timestamp,
        resolvedAt: null,
        resolution: null,
      });
      const orgA = decodeOrgId("org-a");
      yield* repo.insertOrg({ orgId: orgA, name: "A", createdAt: timestamp });
      const otherPerson = decodePersonId("other-owner");
      const otherChat = decodeChatId("other-chat");
      const sameOrgChat = decodeChatId("same-org-chat");
      yield* repo.createChat({ ...chat, chatId: sameOrgChat, directKey: "second-chat" });
      yield* repo.insertPerson({
        orgId: orgA,
        personId: otherPerson,
        handle: "other",
        displayName: "Other",
        githubLogin: null,
        createdAt: timestamp,
      });
      yield* repo.createChat({ ...chat, orgId: orgA, chatId: otherChat, directKey: "other" });
      yield* repo.insertAgent({
        orgId,
        agentId: decodeAgentId("other-agent"),
        ownerPersonId: personId,
        displayName: "Other",
        role: "lead",
        createdAt: timestamp,
      });
      for (const [id, agent] of [
        ["ended-thread", agentId],
        ["other-thread", decodeAgentId("other-agent")],
      ] as const) {
        yield* repo.registerAgentThread({
          orgId,
          agentId: agent,
          threadId: decodeThreadId(id),
          startedAt: timestamp,
          endedAt: null,
        });
      }
      yield* repo.endAgentThread({
        orgId,
        threadId: decodeThreadId("ended-thread"),
        endedAt: later,
      });
      const foreignMember = decodeMemberId("foreign-member");
      yield* repo.addMember({
        ...owner,
        orgId: orgA,
        chatId: otherChat,
        memberId: foreignMember,
        principal: { _tag: "person", personId: otherPerson },
      });
      const sameChatMember = decodeMemberId("same-org-other-chat-member");
      yield* repo.addMember({ ...owner, chatId: sameOrgChat, memberId: sameChatMember });
      for (const fields of [
        { sentBy: otherPerson },
        { sentBy: decodePersonId("unknown-sender") },
        { mentions: [foreignMember] },
        { mentions: [decodeMemberId("unknown-member")] },
        { mentions: [sameChatMember] },
      ]) {
        const failure = yield* Effect.flip(
          repo.insertMessage(message("invalid-reference", fields)),
        );
        assert.strictEqual(failure._tag, "KinChatError");
        if (failure._tag === "KinChatError") {
          assert.strictEqual(failure.reason, "not_found");
          assert.strictEqual(failure.message, "Kin record not found.");
        }
      }
      const hidden = { ...scope, orgId: orgA };
      const sql = yield* SqlClient.SqlClient;
      for (const [id, author] of [
        ["wrong-principal", { _tag: "human", personId, memberId: agentMemberId }],
        ["wrong-person", { _tag: "human", personId: decodePersonId("other"), memberId }],
        [
          "wrong-agent",
          {
            _tag: "agent",
            agentId: decodeAgentId("other"),
            memberId: agentMemberId,
            ownerPersonId: personId,
            threadId,
          },
        ],
        [
          "agent-as-person",
          { _tag: "agent", agentId, memberId, ownerPersonId: personId, threadId },
        ],
        ...[
          { ownerPersonId: otherPerson, threadId },
          { ownerPersonId: personId, threadId: decodeThreadId("unknown") },
          { ownerPersonId: personId, threadId: decodeThreadId("ended-thread") },
          { ownerPersonId: personId, threadId: decodeThreadId("other-thread") },
        ].map(
          (fields) =>
            [
              fields.threadId + fields.ownerPersonId,
              {
                _tag: "agent",
                agentId,
                memberId: agentMemberId,
                ...fields,
              },
            ] as const,
        ),
        ["left-member", { _tag: "human", personId, memberId }],
      ] as const) {
        if (id === "left-member")
          yield* sql`UPDATE kin_chat_members SET left_at = ${later} WHERE member_id = ${memberId}`;
        const failure = yield* Effect.flip(repo.insertMessage(message(id, { author })));
        assert.strictEqual(failure._tag, "KinChatError");
        if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_found");
      }
      assert.deepStrictEqual(Option.getOrThrow(yield* repo.getOrg(hidden)).name, "A");
      assert.deepStrictEqual(
        (yield* repo.listAllOrgs()).map((org) => org.orgId),
        [orgA, orgId],
      );
      for (const read of [
        repo.getChat(hidden),
        repo.getPerson({ ...hidden, personId }),
        repo.getAgent({ ...hidden, agentId }),
        repo.getMember(hidden),
        repo.getMessage({ ...hidden, messageId: widget.messageId }),
        repo.getWidget({ ...hidden, widgetId }),
        repo.getWaiting({ ...hidden, waitingId }),
        repo.getAgentThread({ ...hidden, threadId }),
        repo.getReadState(hidden),
      ])
        assert.strictEqual((yield* read)._tag, "None");
      for (const read of [
        repo.listAgents(hidden),
        repo.listMembers(hidden),
        repo.listMembersByPerson({ ...hidden, personId }),
        repo.listMembersByAgent({ ...hidden, agentId }),
        repo.listOpenWaiting({ ...hidden, personId }),
        repo.messagesAfter({ ...hidden, afterSeq: 0, limit: 100 }),
      ])
        assert.deepStrictEqual(yield* read, []);
      assert.deepStrictEqual(yield* repo.history({ ...hidden, beforeSeq: 10, limit: 100 }), {
        messages: [],
        widgets: [],
        hasMore: false,
      });
      assert.strictEqual(yield* repo.unreadCount(hidden), 0);
      assert.deepStrictEqual(
        (yield* repo.listChats(hidden)).map((row) => row.chatId),
        [otherChat],
      );
      assert.deepStrictEqual(
        (yield* repo.listPeople(hidden)).map((row) => row.personId),
        [otherPerson],
      );
      yield* repo.insertAgent({
        orgId: orgA,
        agentId: decodeAgentId("org-a-agent"),
        ownerPersonId: otherPerson,
        displayName: "A",
        role: "lead",
        createdAt: timestamp,
      });
      yield* repo.registerAgentThread({
        orgId: orgA,
        agentId: decodeAgentId("org-a-agent"),
        threadId: decodeThreadId("foreign-thread"),
        startedAt: timestamp,
        endedAt: null,
      });
      for (const refs of [
        { source: { threadId: decodeThreadId("other-thread"), itemId: decodeTurnItemId("item") } },
        { awaiting: [otherPerson] },
        { awaiting: [decodePersonId("unknown-person")] },
        {
          source: { threadId: decodeThreadId("foreign-thread"), itemId: decodeTurnItemId("item") },
        },
        {
          source: { threadId: decodeThreadId("unknown-thread"), itemId: decodeTurnItemId("item") },
        },
      ]) {
        for (const write of [
          repo.insertWidget({ ...widget, widgetId: decodeWidgetId("invalid-widget"), ...refs }),
          repo.updateWidget({ ...widget, expectedRevision: 1, ...refs }),
        ]) {
          const failure = yield* Effect.flip(write);
          assert.strictEqual(failure._tag, "KinChatError");
          if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_found");
        }
      }
      const foreignAnchor = yield* repo.insertMessage({
        ...message("foreign-anchor"),
        orgId: orgA,
        chatId: otherChat,
        author: { _tag: "system" },
        mentions: [],
        clientMessageId: null,
      });
      for (const collision of [
        repo
          .insertMessage({
            ...message("first"),
            orgId: orgA,
            chatId: otherChat,
            author: { _tag: "system" },
            mentions: [],
            clientMessageId: null,
          })
          .pipe(Effect.asVoid),
        repo.insertWidget({
          ...widget,
          orgId: orgA,
          chatId: otherChat,
          messageId: foreignAnchor.messageId,
          awaiting: [],
          source: null,
          feed: null,
        }),
      ])
        assert.include(yield* Effect.flip(collision), { reason: "not_found" });
      for (const retry of [
        repo
          .addWaiting({
            orgId: orgA,
            chatId: otherChat,
            personId: otherPerson,
            waitingId,
            messageId: null,
            widgetId: null,
            reason: "question",
            createdAt: timestamp,
            resolvedAt: null,
            resolution: null,
          })
          .pipe(Effect.asVoid),
        repo
          .registerAgentThread({
            orgId: orgA,
            agentId: decodeAgentId("org-a-agent"),
            threadId,
            startedAt: timestamp,
            endedAt: null,
          })
          .pipe(Effect.asVoid),
        repo
          .addMember({
            ...owner,
            orgId: orgA,
            chatId: otherChat,
            principal: { _tag: "person", personId: otherPerson },
          })
          .pipe(Effect.asVoid),
      ]) {
        const failure = yield* Effect.flip(retry);
        assert.strictEqual(failure._tag, "KinChatError");
        if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_found");
      }
      for (const write of [
        ...[
          { messageId: widget.messageId, widgetId: null },
          { messageId: null, widgetId },
        ].map((refs) =>
          repo.addWaiting({
            orgId: orgA,
            chatId: otherChat,
            personId: otherPerson,
            waitingId: decodeWaitingId("cross-wait"),
            reason: "question",
            createdAt: timestamp,
            resolvedAt: null,
            resolution: null,
            ...refs,
          }),
        ),
        ...[{ replyTo: widget.messageId }, { widgetId }].map((refs) =>
          repo.insertMessage({
            ...message("cross-ref"),
            orgId: orgA,
            chatId: otherChat,
            author: { _tag: "system" },
            ...refs,
          }),
        ),
        ...[
          { messageId: widget.messageId, widgetId: null },
          { messageId: null, widgetId },
        ].map((refs) =>
          repo.addWaiting({
            orgId,
            chatId: sameOrgChat,
            personId,
            waitingId: decodeWaitingId("cross-chat-wait"),
            reason: "question",
            createdAt: timestamp,
            resolvedAt: null,
            resolution: null,
            ...refs,
          }),
        ),
        ...[{ replyTo: widget.messageId }, { widgetId }].map((refs) =>
          repo.insertMessage({
            ...message("cross-chat-ref"),
            chatId: sameOrgChat,
            author: { _tag: "system" },
            ...refs,
          }),
        ),
        repo.insertWidget({ ...widget, orgId: orgA }),
        repo.addMember({ ...owner, orgId: orgA }),
        repo.addWaiting({
          orgId: orgA,
          waitingId: decodeWaitingId("cross"),
          personId,
          chatId,
          messageId: widget.messageId,
          widgetId,
          reason: "question",
          createdAt: timestamp,
          resolvedAt: null,
          resolution: null,
        }),
        repo.createChat({ ...chat, orgId: orgA, directKey: "owner:lead" }),
        repo.markRead({ ...hidden, seq: 9, updatedAt: later }),
        repo.updateWidget({ ...widget, orgId: orgA, expectedRevision: 1 }),
        repo.insertMessage({ ...message("cross-org"), orgId: orgA }),
      ])
        assert.strictEqual((yield* Effect.flip(write))._tag, "KinChatError");
      assert.strictEqual(
        yield* repo.endAgentThread({ ...hidden, threadId, endedAt: later }),
        false,
      );
      assert.strictEqual(
        yield* repo.resolveWaiting({
          ...hidden,
          waitingId,
          resolvedAt: later,
          resolution: "wrong",
        }),
        false,
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repo.getAgentThread({ orgId, threadId })).endedAt,
        null,
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repo.getWaiting({ orgId, waitingId })).resolvedAt,
        null,
      );
      assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("advances read state monotonically and counts only others' posted messages", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      const agentAuthor = {
        _tag: "agent",
        agentId,
        memberId: agentMemberId,
        ownerPersonId: personId,
        threadId,
      } as const;
      for (const input of [
        message("own"),
        message("agent", { author: agentAuthor, authorRole: "member", intent: "answer" }),
        message("system", { author: { _tag: "system" }, authorRole: "member", kind: "system" }),
        ...(["suggested", "deleted", "dismissed"] as const).map((status) =>
          message(status, { author: agentAuthor, authorRole: "member", status }),
        ),
      ])
        yield* repo.insertMessage(input);
      const resumedThread = decodeThreadId("resumed-thread");
      yield* repo.registerAgentThread({
        orgId,
        agentId,
        threadId: resumedThread,
        startedAt: later,
        endedAt: null,
      });
      const retry = yield* Effect.flip(
        repo.insertMessage(
          message("agent", {
            author: { ...agentAuthor, threadId: resumedThread },
            authorRole: "member",
            intent: "answer",
          }),
        ),
      );
      assert.strictEqual(retry._tag, "KinChatError");
      if (retry._tag === "KinChatError") assert.strictEqual(retry.reason, "not_allowed");
      assert.strictEqual(yield* repo.unreadCount(scope), 2);
      yield* Effect.all(
        [
          repo.markRead({ ...scope, seq: 3, updatedAt: later }),
          repo.markRead({ ...scope, seq: 1, updatedAt: later }),
          repo.markRead({ ...scope, seq: 2, updatedAt: later }),
        ],
        { concurrency: "unbounded" },
      );
      yield* repo.markRead({ ...scope, seq: 0, updatedAt: timestamp });
      assert.deepStrictEqual(Option.getOrThrow(yield* repo.getReadState(scope)), {
        ...scope,
        lastReadSeq: 3,
        updatedAt: later,
      });
      assert.strictEqual(yield* repo.unreadCount(scope), 0);
      yield* repo.markRead({ ...scope, seq: 999, updatedAt: later });
      yield* repo.insertMessage(
        message("after-read", { author: agentAuthor, authorRole: "member" }),
      );
      assert.strictEqual(yield* repo.unreadCount(scope), 1);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repo.getMessage({ orgId, messageId: decodeMessageId("agent") }))
          .author,
        agentAuthor,
      );
      const guestPerson = decodePersonId("guest");
      const guestMember = decodeMemberId("guest-member");
      yield* repo.insertPerson({
        orgId,
        personId: guestPerson,
        handle: "guest",
        displayName: "Guest",
        githubLogin: null,
        createdAt: timestamp,
      });
      yield* repo.addMember({
        ...owner,
        memberId: guestMember,
        principal: { _tag: "person", personId: guestPerson },
        role: "guest",
      });
      const guestPost = yield* repo.insertMessage(
        message("guest-post", {
          author: { _tag: "human", personId: guestPerson, memberId: guestMember },
          authorRole: "owner",
          sentBy: personId,
        }),
      );
      assert.strictEqual(guestPost.authorRole, "guest");
      for (const sentBy of [guestPerson, personId]) {
        if (sentBy === personId) yield* repo.leaveChat({ ...scope, leftAt: later });
        const failure = yield* Effect.flip(
          repo.insertMessage(
            message("invalid-sender", {
              author: { _tag: "human", personId: guestPerson, memberId: guestMember },
              sentBy,
            }),
          ),
        );
        assert.strictEqual(failure._tag, "KinChatError");
        if (failure._tag === "KinChatError") assert.strictEqual(failure.reason, "not_found");
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses stale widget revisions and safely reports corrupt rows", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      yield* repo.insertMessage(message("first"));
      yield* repo.insertWidget(widget);
      const updated = {
        ...widget,
        revision: 2,
        state: { status: "done" },
        awaiting: [],
        source: null,
        feed: null,
        closedAt: later,
        updatedAt: later,
      };
      assert.deepStrictEqual(
        yield* repo.updateWidget({ ...updated, expectedRevision: 1 }),
        updated,
      );
      const identityChange = {
        ...updated,
        type: "approval",
        widgetClass: "feed",
        chatId: decodeChatId("other"),
        messageId: decodeMessageId("other"),
        revision: 99,
      };
      assert.strictEqual(
        (yield* repo.updateWidget({ ...identityChange, expectedRevision: 2 })).type,
        "task",
      );
      const stale = yield* Effect.flip(repo.updateWidget({ ...widget, expectedRevision: 1 }));
      assert.strictEqual(stale._tag, "KinChatError");
      if (stale._tag === "KinChatError") assert.strictEqual(stale.reason, "widget_changed");
      assert.deepStrictEqual(Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId })), {
        ...updated,
        revision: 3,
      });
      const sql = yield* SqlClient.SqlClient;
      for (const corrupt of [
        sql`UPDATE kin_messages SET mentions_json = 'not-json-secret' WHERE org_id = ${orgId}`,
        sql`UPDATE kin_widgets SET state_json = 'not-json-secret' WHERE org_id = ${orgId}`,
        sql`UPDATE kin_widgets SET state_json = '{}', awaiting_json = '[99]' WHERE org_id = ${orgId}`,
        sql`UPDATE kin_widgets SET awaiting_json = '[]', source_item_id = 'orphan' WHERE org_id = ${orgId}`,
      ]) {
        yield* corrupt;
        const failure = yield* Effect.flip(
          repo.history({ orgId, chatId, beforeSeq: 2, limit: 100 }),
        );
        assert.strictEqual(failure._tag, "PersistenceDecodeError");
        assert.notInclude(failure.message, "not-json-secret");
        yield* sql`UPDATE kin_messages SET mentions_json = '[]' WHERE org_id = ${orgId}`;
      }
    }).pipe(Effect.provide(layer)),
  );
});
