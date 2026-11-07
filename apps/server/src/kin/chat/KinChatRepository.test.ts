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
    clientMessageId: id,
  }) satisfies Omit<KinMessage, "seq"> & { clientMessageId: string };
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
        assert.deepStrictEqual(yield* repo.listOrgs({ orgId }), [org]);
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
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getAgent({ orgId, agentId })), agent);
        assert.deepStrictEqual(yield* repo.listAgents({ orgId }), [agent]);
        assert.deepStrictEqual(
          yield* repo.createChat({
            ...chat,
            chatId: decodeChatId("duplicate"),
            directKey: "owner:lead",
          }),
          chat,
        );
        assert.deepStrictEqual(yield* repo.listChats({ orgId }), [chat]);
        assert.deepStrictEqual(yield* repo.listMembers(scope), [owner, agentMember]);
        assert.deepStrictEqual(yield* repo.listMembersByPerson({ orgId, personId }), [owner]);
        assert.deepStrictEqual(yield* repo.listMembersByAgent({ orgId, agentId }), [agentMember]);
        assert.deepStrictEqual(Option.getOrThrow(yield* repo.getMember(scope)), owner);
        const first = yield* repo.insertMessage(message("first"));
        assert.deepStrictEqual(first, decodeMessage({ ...message("first"), seq: 1 }));
        const repeated = yield* Effect.all(
          Array.from({ length: 5 }, (_, i) =>
            repo.insertMessage({
              ...message("first"),
              messageId: decodeMessageId(`retry-${i}`),
              body: "changed",
              createdAt: later,
            }),
          ),
          { concurrency: "unbounded" },
        );
        for (const retried of repeated) assert.deepStrictEqual(retried, first);
        assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 1);
        assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastMessageAt, timestamp);
        const action = yield* repo.insertMessage({
          ...message("action", { kind: "widget_action" }),
          clientMessageId: "first",
        });
        assert.strictEqual(action.seq, 2);
        assert.strictEqual(action.messageId, decodeMessageId("action"));
        assert.deepStrictEqual(
          yield* repo.insertMessage({
            ...message("repeated-action", { kind: "widget_action" }),
            clientMessageId: "first",
          }),
          action,
        );
        yield* repo.insertWidget(widget);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId })),
          widget,
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
        yield* repo.addWaiting(waiting);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* repo.getWaiting({ orgId, waitingId })),
          waiting,
        );
        assert.deepStrictEqual(yield* repo.listOpenWaiting({ orgId, personId }), [waiting]);
        yield* repo.resolveWaiting({ orgId, waitingId, resolvedAt: later, resolution: "answered" });
        yield* repo.resolveWaiting({
          orgId,
          waitingId,
          resolvedAt: timestamp,
          resolution: "again",
        });
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
        yield* repo.endAgentThread({ orgId, threadId, endedAt: later });
        yield* repo.endAgentThread({ orgId, threadId, endedAt: timestamp });
        assert.strictEqual(
          Option.getOrThrow(yield* repo.getAgentThread({ orgId, threadId })).endedAt,
          later,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT typeof(seq) AS type FROM kin_messages WHERE org_id = ${orgId}`,
          [{ type: "integer" }, { type: "integer" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT typeof(revision) AS type FROM kin_widgets WHERE org_id = ${orgId}`,
          [{ type: "integer" }],
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("allocates gapless seqs for 20 concurrent sends and rolls back failed inserts", () =>
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
        repo.insertMessage({ ...message("message-0"), clientMessageId: "new-id" }),
      );
      assert.strictEqual(failed._tag, "PersistenceSqlError");
      assert.strictEqual(Option.getOrThrow(yield* repo.getChat(scope)).lastSeq, 20);
      assert.strictEqual((yield* repo.insertMessage(message("next"))).seq, 21);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pages history exclusively in ascending order and resumes after a seq", () =>
    Effect.gen(function* () {
      const repo = yield* seed;
      for (let i = 1; i <= 5; i++)
        yield* repo.insertMessage(message(i === 3 ? "first" : `message-${i}`));
      yield* repo.insertWidget(widget);
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
        assert.deepStrictEqual(page.widgets, seqs.some((seq) => seq === 3) ? [widget] : []);
      }
      for (const limit of [0, 101, 1.5]) {
        assert.strictEqual(
          (yield* Effect.flip(repo.history({ orgId, chatId, beforeSeq: 6, limit })))._tag,
          "PersistenceDecodeError",
        );
      }
      for (const [afterSeq, limit, expected] of [
        [0, 2, [1, 2]],
        [2, 100, [3, 4, 5]],
        [5, 2, []],
      ] as const) {
        assert.deepStrictEqual(
          (yield* repo.messagesAfter({ orgId, chatId, afterSeq, limit })).map((m) => m.seq),
          [...expected],
        );
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
      const hidden = { ...scope, orgId: orgA };
      assert.deepStrictEqual(Option.getOrThrow(yield* repo.getOrg(hidden)).name, "A");
      assert.deepStrictEqual(
        (yield* repo.listOrgs(hidden)).map((org) => org.orgId),
        [orgA],
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
        repo.listChats(hidden),
        repo.listPeople(hidden),
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
      for (const write of [
        repo.markRead({ ...hidden, seq: 9, updatedAt: later }),
        repo.updateWidget({ ...widget, orgId: orgA, revision: 2, expectedRevision: 1 }),
        repo.insertMessage({ ...message("cross-org"), orgId: orgA }),
      ])
        assert.strictEqual((yield* Effect.flip(write))._tag, "KinChatError");
      yield* repo.endAgentThread({ ...hidden, threadId, endedAt: later });
      yield* repo.resolveWaiting({ ...hidden, waitingId, resolvedAt: later, resolution: "wrong" });
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
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repo.getMessage({ orgId, messageId: decodeMessageId("agent") }))
          .author,
        agentAuthor,
      );
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
      const stale = yield* Effect.flip(
        repo.updateWidget({ ...widget, revision: 2, expectedRevision: 1 }),
      );
      assert.strictEqual(stale._tag, "KinChatError");
      if (stale._tag === "KinChatError") assert.strictEqual(stale.reason, "widget_changed");
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId })),
        updated,
      );
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
