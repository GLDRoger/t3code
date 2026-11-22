import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ServerConfig from "../../config.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  KinWakeupId,
  KinEvent,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinPersonId,
  ThreadId,
  ProviderTurnId,
  ProjectId,
  ProviderInstanceId,
  TurnItemId,
  type ChatAttachment,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as OwnerCheck from "../triggers/ownerCheck.ts";
import * as ChatService from "../chat/KinChatService.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import * as Presence from "../reply/KinPresence.ts";
import { KinReplyBridge } from "../reply/KinReplyBridge.ts";
import * as LevelGate from "./LevelGate.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as Floor from "../floor/KinFloor.ts";
import { FLOOR_GRANT_TTL_MS } from "../floor/FloorManager.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Budget from "./KinBudget.ts";
import * as KinIdentity from "../chat/KinIdentity.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryConfig from "../memory/MemoryConfig.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as KinIssuedTokens from "../mcp/KinIssuedTokens.ts";
import * as KinLead from "./layer.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as KinStop from "./KinStop.ts";
import { SHARED_THREAD_PREFIX, abortChatTurns } from "./Audience.ts";
import { REVIEW_THREAD_PREFIX } from "./outsideReview.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { KinHostCare } from "../host/KinHostCare.ts";
import * as PlatformError from "effect/PlatformError";
import { KinLeadPrompt, type KinLeadPromptInput } from "./LeadPrompt.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { harness, seed, orgId, agentId, event, toolCall } from "./WakeupRunner.testkit.ts";
import { ProviderAdapterSteerRunError } from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind, ProviderThreadId } from "@t3tools/contracts";

const decodeEvent = Schema.decodeSync(KinEvent);
const decodeUsage = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        turnTokenUsage: Schema.Struct({
          inputTokens: Schema.Number,
          cachedInputTokens: Schema.Number,
          outputTokens: Schema.Number,
        }),
      }),
    ),
  ),
);
const resolveAgent = Effect.fn("test.resolveAgent")(function* (threadId: ThreadId) {
  const identity = yield* KinIdentity.KinIdentity;
  const sessions = yield* McpSessionRegistry.McpSessionRegistry;
  const issued = yield* sessions.issue({
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  });
  const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
  const scope = yield* sessions.resolve(token);
  assert.isDefined(scope);
  return yield* identity.resolveAgent(scope!);
});
// A human message in the lead's lane, the chat its notices and replies go to.
const laneMessage = (id: string, chatId = "owner-chat") =>
  decodeEvent({
    _tag: "chat.message",
    orgId,
    agentId,
    eventId: id,
    receivedAt: "2026-11-08T00:00:00.000Z",
    dedupeKey: id,
    provenance: { _tag: "human", personId: "owner", memberId: "owner-member" },
    chatId,
    messageId: id,
  });
const run = Effect.fn("test.run")(function* () {
  const runner = yield* WakeupRunner.WakeupRunner;
  const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
  yield* TestClock.adjust("20 seconds");
  return fiber;
});
const seedDirectChats = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const chat of ["direct", "other-direct"])
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chat}, 'org', 'direct', ${`owner:${chat}`}, 0, '2026-11-08T00:00:00.000Z')`;
});
/** The owner's stored message behind a lane event, so only the owner reads the turn. */
const ownerSays = Effect.fn("test.ownerSays")(function* (id: string, chatId = "owner-chat") {
  const sql = yield* SqlClient.SqlClient;
  const at = "2026-11-08T00:00:00.000Z";
  yield* sql`INSERT OR IGNORE INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES (${`${chatId}-owner`}, 'org', ${chatId}, 'person', 'owner', 'owner', ${at})`;
  yield* sql`INSERT OR IGNORE INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
      author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES (${id}, 'org', ${chatId},
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM kin_messages WHERE chat_id = ${chatId}), 'human', 'owner',
      ${`${chatId}-owner`}, 'owner', 'text', 'Invented question', '[]', 'posted', ${at})`;
  return laneMessage(id, chatId);
});
const wake = Effect.fn("test.wake")(function* (id: string, chatId = "direct") {
  yield* (yield* KinEventQueue.KinEventQueue).enqueue(yield* ownerSays(id, chatId));
  yield* Fiber.join(yield* run());
});
/** Each run's provider conversation, numbered in order of first use. */
const sessions = Effect.fn("test.sessions")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [lead] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM kin_leads`;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projection = yield* threads.getThreadProjection(ThreadId.make(lead!.threadId));
  const numbers = new Map<string | null, number>();
  return projection.runs
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((run) => {
      if (!numbers.has(run.providerThreadId)) numbers.set(run.providerThreadId, numbers.size + 1);
      return numbers.get(run.providerThreadId);
    });
});

describe("WakeupRunner", () => {
  it.effect("does not spin the org loop while a lead with queued events is still finishing", () =>
    Effect.gen(function* () {
      const commitEntered = Deferred.makeUnsafe<void>();
      const commitRelease = Deferred.makeUnsafe<void>();
      let commits = 0;
      let readyCalls = 0;
      let subscriptions = 0;
      const writer = Layer.succeed(
        Writer.MemoryWriter,
        Writer.MemoryWriter.of({
          dreamBase: () => Effect.die("unused"),
          commitDream: () => Effect.die("unused"),
          landDream: () => Effect.die("unused"),
          deleteDreamBranch: () => Effect.die("unused"),
          reconcileSharing: () => Effect.void,
          stripQuotes: () => Effect.void,
          undoChange: () => Effect.die("unused"),
          relabel: () => Effect.die("unused"),
          retire: () => Effect.die("unused"),
          restore: () => Effect.die("unused"),
          recordDecision: () => Effect.die("unused"),
          staged: () => Effect.succeed(false),
          stage: () => Effect.die("unused"),
          appendJournal: () => Effect.void,
          discard: () => Effect.void,
          commitWakeup: () =>
            Effect.gen(function* () {
              commits++;
              if (commits === 1) {
                yield* Deferred.succeed(commitEntered, undefined);
                yield* Deferred.await(commitRelease);
              }
              return { commit: `fixture-${commits}` };
            }),
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          const runner = yield* WakeupRunner.WakeupRunner;
          yield* queue.enqueue(yield* ownerSays("loop-first"));
          yield* runner.start;
          yield* TestClock.adjust("20 seconds");
          yield* Deferred.await(commitEntered);
          // The lead is still finishing its first wake-up, with more work queued.
          yield* queue.enqueue(event("loop-second"));
          yield* TestClock.adjust("5 seconds");
          const settled = readyCalls;
          yield* TestClock.adjust("30 seconds");
          assert.strictEqual(readyCalls, settled);
          // Every pass shares the loop's one subscription to T3's events.
          assert.isAbove(readyCalls, 1);
          assert.strictEqual(subscriptions, 1);
          yield* Deferred.succeed(commitRelease, undefined);
          // The finish wakes the loop at once: the queued event is claimed with no clock advance,
          // where a missed wake would wait for the 60-second cap.
          while (true) {
            const changed = yield* queue.changes(orgId);
            const [second] = yield* sql<{
              state: string;
            }>`SELECT state FROM kin_events WHERE org_id = ${orgId} AND event_id = 'loop-second'`;
            if (second?.state !== "queued") break;
            yield* changed;
          }
          const states = yield* sql<{
            event_id: string;
            state: string;
          }>`SELECT event_id, state FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
          assert.strictEqual(states[0]?.state, "done");
          assert.notStrictEqual(states[1]?.state, "queued");
          assert.deepStrictEqual(
            (yield* sql`SELECT memory_commit FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'completed' ORDER BY started_at`)[0],
            { memory_commit: "fixture-1" },
          );
        }),
      ).pipe(
        Effect.provide(
          harness({
            writer,
            onReadyLeads: () => {
              readyCalls++;
            },
            onDomainSubscribe: () => {
              subscriptions++;
            },
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );
  it.effect("wakes a company created after start on its first event, not a minute later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const runner = yield* WakeupRunner.WakeupRunner;
        yield* runner.start;
        // Discovery has run and found no company.
        yield* TestClock.adjust("1 second");
        yield* seed;
        yield* queue.enqueue(yield* ownerSays("new-company-first"));
        yield* TestClock.adjust("20 seconds");
        const [first] = yield* sql<{ state: string }>`SELECT state FROM kin_events
          WHERE org_id = ${orgId} AND event_id = 'new-company-first'`;
        assert.notStrictEqual(first?.state, "queued");
      }),
    ).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect("moves a lead's thread off the shared project into its own checkout's", () =>
    Effect.gen(function* () {
      let projectId = ProjectId.make("kin:org");
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const leadThread = Effect.map(
          sql<{ threadId: string }>`SELECT thread_id AS "threadId" FROM kin_leads`,
          ([row]) => ThreadId.make(row!.threadId),
        );
        yield* wake("on-shared", "owner-chat");
        const shared = yield* leadThread;
        projectId = ProjectId.make("kin:org:lead");
        yield* wake("on-own", "owner-chat");
        const own = yield* leadThread;
        assert.notStrictEqual(own, shared);
        assert.strictEqual((yield* threads.getThreadProjection(own)).thread.projectId, projectId);
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id FROM kin_agent_threads WHERE ended_at IS NULL`,
          [{ thread_id: own }],
        );
      }).pipe(Effect.provide(harness({ projectId: () => projectId })));
    }).pipe(provideDeterministicTestRuntime),
  );
  it.effect(
    "runs a turn a teammate can read on its own thread without file tools, and the owner's back on his",
    () => {
      const memory: Array<string> = [];
      // Whether the running turn saved something for the team (`LeadMemory`).
      let saved = false;
      const writer = Layer.mock(Writer.MemoryWriter)({
        appendJournal: (_org, wakeupId) => Effect.sync(() => memory.push(`journal:${wakeupId}`)),
        commitWakeup: (_org, wakeupId) =>
          Effect.sync(() => (memory.push(`commit:${wakeupId}`), { commit: "fixture" })),
        discard: (_org, wakeupId) => Effect.sync(() => memory.push(`discard:${wakeupId}`)),
        staged: () => Effect.sync(() => saved),
      });
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-08T00:00:00.000Z";
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES ('teammate', 'org', 'teammate', 'Teammate', ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
            VALUES ('owner-member', 'org', 'owner-chat', 'person', 'owner', 'owner', ${at})`;
        let seq = 0;
        const turn = Effect.fn("test.turn")(function* (id: string) {
          seq++;
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
                author_member_id, author_role, kind, body, mentions_json, status, created_at)
              VALUES (${id}, 'org', 'owner-chat', ${seq}, 'human', 'owner', 'owner-member', 'owner', 'text',
                'Invented question', '[]', 'posted', ${at})`;
          yield* wake(id, "owner-chat");
          const [lead] = yield* sql<{
            threadId: string;
          }>`SELECT thread_id AS "threadId" FROM kin_leads`;
          const [wakeup] = yield* sql<{
            audience: string;
            wakeupId: string;
          }>`SELECT audience, wakeup_id AS "wakeupId" FROM kin_wakeups
              WHERE event_ids LIKE ${`%"${id}"%`}`;
          return {
            threadId: lead!.threadId,
            audience: wakeup?.audience,
            wakeupId: wakeup?.wakeupId,
          };
        });
        const alone = yield* turn("alone");
        assert.deepStrictEqual(alone.audience, "owner_only");
        assert.isTrue(alone.threadId.startsWith("kin:"));
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
            VALUES ('teammate-member', 'org', 'owner-chat', 'person', 'teammate', 'member', ${at})`;
        const shared = yield* turn("shared");
        assert.deepStrictEqual(shared.audience, "shared");
        assert.isTrue(shared.threadId.startsWith(SHARED_THREAD_PREFIX));
        saved = true;
        const saving = yield* turn("saving");
        assert.deepStrictEqual(saving.audience, "shared");
        saved = false;
        yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'teammate-member'`;
        const again = yield* turn("again");
        assert.strictEqual(again.threadId, alone.threadId);
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, chat_id FROM kin_agent_threads WHERE ended_at IS NULL
            ORDER BY chat_id IS NULL`,
          [
            { thread_id: shared.threadId, chat_id: "owner-chat" },
            { thread_id: alone.threadId, chat_id: null },
          ],
        );
        // The shared turn left no journal entry.
        const kept = (wakeupId: string | undefined) =>
          memory.filter(
            (write) => write === `journal:${wakeupId}` || write === `commit:${wakeupId}`,
          );
        assert.deepStrictEqual(kept(alone.wakeupId), [`commit:${alone.wakeupId}`]);
        assert.deepStrictEqual(kept(shared.wakeupId), []);
        assert.include(memory, `discard:${shared.wakeupId}`);
        // One that saved something for the team commits exactly that.
        assert.deepStrictEqual(kept(saving.wakeupId), [`commit:${saving.wakeupId}`]);
        assert.deepStrictEqual(kept(again.wakeupId), [`commit:${again.wakeupId}`]);
        // A stranger's pull request is reviewed on a thread of its own, which no other turn takes.
        yield* (yield* KinEventQueue.KinEventQueue).enqueue(
          decodeEvent({
            _tag: "github",
            orgId,
            agentId,
            eventId: "stranger-review",
            receivedAt: at,
            dedupeKey: "poll:review:invented-org/app#7",
            provenance: { _tag: "system" },
            deliveryId: "poll:review:invented-org/app#7",
            eventName: "review",
            repo: "invented-org/app",
            summary: "review on invented-org/app#7 by stranger",
            trigger: {
              key: "review:invented-org/app#7",
              kind: "review",
              item: "pull",
              number: 7,
              url: "https://github.com/invented-org/app/pull/7",
              title: "Fix typo",
              author: "stranger",
              association: "NONE",
              inside: false,
              text: "Invented",
            },
          }),
        );
        yield* Fiber.join(yield* run());
        const [reviewed] = yield* sql<{ threadId: string; audience: string; wakeupId: string }>`
          SELECT thread_id AS "threadId", audience, wakeup_id AS "wakeupId" FROM kin_wakeups
          WHERE event_ids LIKE '%stranger-review%'`;
        assert.strictEqual(reviewed?.audience, "shared");
        assert.isTrue(reviewed!.threadId.startsWith(REVIEW_THREAD_PREFIX));
        assert.deepStrictEqual(kept(reviewed!.wakeupId), []);
        yield* sql`UPDATE kin_chat_members SET left_at = NULL WHERE member_id = 'teammate-member'`;
        assert.strictEqual((yield* turn("after-review")).threadId, shared.threadId);
      }).pipe(Effect.provide(harness({ writer })), provideDeterministicTestRuntime);
    },
  );
  it.effect("runs each teammate's chat on its own thread and keeps the owner's", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-08T00:00:00.000Z";
      let seq = 0;
      for (const person of ["asha", "ravi"]) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES (${person}, 'org', ${person}, ${person}, ${at})`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
          VALUES (${`dm-${person}`}, 'org', 'direct', ${`${person}:lead`}, 0, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES (${`${person}-member`}, 'org', ${`dm-${person}`}, 'person', ${person}, 'member', ${at})`;
      }
      const says = Effect.fn("test.teammateSays")(function* (id: string, person: string) {
        seq++;
        const chatId = `dm-${person}`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
            author_member_id, author_role, kind, body, mentions_json, status, created_at)
          VALUES (${id}, 'org', ${chatId}, ${seq}, 'human', ${person}, ${`${person}-member`}, 'member',
            'text', 'Invented question', '[]', 'posted', ${at})`;
        yield* (yield* KinEventQueue.KinEventQueue).enqueue(
          decodeEvent({
            _tag: "chat.message",
            orgId,
            agentId,
            eventId: id,
            receivedAt: at,
            dedupeKey: id,
            provenance: { _tag: "human", personId: person, memberId: `${person}-member` },
            chatId,
            messageId: id,
          }),
        );
        yield* Fiber.join(yield* run());
        const [row] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
          FROM kin_wakeups WHERE event_ids LIKE ${`%"${id}"%`}`;
        return row!.threadId;
      });
      const thread = Effect.fn("test.thread")(function* (id: string) {
        const [row] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
          FROM kin_wakeups WHERE event_ids LIKE ${`%"${id}"%`}`;
        return row!.threadId;
      });
      yield* wake("owner-first", "owner-chat");
      const owner = yield* thread("owner-first");
      const asha = yield* says("asha-1", "asha");
      const ravi = yield* says("ravi-1", "ravi");
      assert.isTrue(asha.startsWith(SHARED_THREAD_PREFIX));
      assert.isTrue(ravi.startsWith(SHARED_THREAD_PREFIX));
      assert.notStrictEqual(asha, ravi);
      assert.strictEqual(yield* says("asha-2", "asha"), asha);
      yield* wake("owner-again", "owner-chat");
      assert.strictEqual(yield* thread("owner-again"), owner);
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, chat_id FROM kin_agent_threads WHERE ended_at IS NULL
          ORDER BY thread_id`,
        [
          { thread_id: owner, chat_id: null },
          ...[
            { thread_id: asha, chat_id: "dm-asha" },
            { thread_id: ravi, chat_id: "dm-ravi" },
          ].toSorted((a, b) => a.thread_id.localeCompare(b.thread_id)),
        ].toSorted((a, b) => a.thread_id.localeCompare(b.thread_id)),
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect(
    "a teammate joining mid-turn aborts it: nothing kept, its events answered shared on a fresh thread",
    () => {
      const memory: Array<string> = [];
      const writer = Layer.mock(Writer.MemoryWriter)({
        appendJournal: (_org, wakeupId) => Effect.sync(() => memory.push(`journal:${wakeupId}`)),
        commitWakeup: (_org, wakeupId) =>
          Effect.sync(() => (memory.push(`commit:${wakeupId}`), { commit: "fixture" })),
        discard: (_org, wakeupId) => Effect.sync(() => memory.push(`discard:${wakeupId}`)),
        staged: () => Effect.succeed(false),
      });
      // While the first turn runs, the teammate's join commits with its abort mark.
      let during: Effect.Effect<void> = Effect.void;
      return Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-11-08T00:00:00.000Z";
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES ('teammate', 'org', 'teammate', 'Teammate', ${at})`;
        during = sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
                VALUES ('teammate-member', 'org', 'owner-chat', 'person', 'teammate', 'member', ${at})`;
              yield* abortChatTurns({
                orgId,
                chatId: KinChatId.make("owner-chat"),
                personId: KinPersonId.make("teammate"),
              });
            }),
          )
          .pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orDie,
            Effect.ensuring(Effect.sync(() => (during = Effect.void))),
          );
        yield* wake("asked", "owner-chat");
        const rows = sql<{
          wakeupId: string;
          status: string;
          audience: string | null;
          aborted: number;
          threadId: string | null;
        }>`SELECT wakeup_id AS "wakeupId", status, audience, aborted_at IS NOT NULL AS aborted,
            thread_id AS "threadId" FROM kin_wakeups ORDER BY started_at, wakeup_id`;
        const [first] = yield* rows;
        assert.deepInclude(first, { status: "released", audience: "owner_only", aborted: 1 });
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts, wakeup_id AS "wakeupId" FROM kin_events
            WHERE event_id = 'asked'`,
          [{ state: "queued", attempts: 0, wakeupId: null }],
        );
        assert.deepStrictEqual(
          memory.filter((write) => !write.startsWith("discard:")),
          [],
        );
        assert.include(memory, `discard:${first!.wakeupId}`);
        yield* Fiber.join(yield* run());
        const [, again] = yield* rows;
        assert.deepInclude(again, { status: "completed", audience: "shared", aborted: 0 });
        assert.isTrue(again!.threadId!.startsWith(SHARED_THREAD_PREFIX));
        assert.notStrictEqual(again!.threadId, first!.threadId);
        assert.deepStrictEqual(
          yield* sql`SELECT state, wakeup_id AS "wakeupId" FROM kin_events WHERE event_id = 'asked'`,
          [{ state: "done", wakeupId: again!.wakeupId }],
        );
        assert.notInclude(memory, `journal:${again!.wakeupId}`);
        assert.notInclude(memory, `commit:${again!.wakeupId}`);
      }).pipe(
        Effect.provide(harness({ writer, onTurn: () => during })),
        provideDeterministicTestRuntime,
      );
    },
  );
  it.effect("hands the files on the messages it answers to the provider turn", () => {
    const photo = {
      type: "image" as const,
      id: "kin-chat-0f0e0d0c-0b0a-4908-8706-050403020100",
      name: "whiteboard.png",
      mimeType: "image/png",
      sizeBytes: 68,
    };
    const turnAttachments: Array<ReadonlyArray<ChatAttachment>> = [];
    return Effect.gen(function* () {
      yield* seed;
      yield* seedDirectChats;
      yield* wake("with-photo");
      assert.deepStrictEqual(turnAttachments, [[photo]]);
    }).pipe(
      Effect.provide(harness({ attachments: [photo], turnAttachments })),
      provideDeterministicTestRuntime,
    );
  });

  it.effect("handles the owner check in code without starting a provider turn", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("owner-check"));
      yield* Fiber.join(yield* run());
      assert.deepEqual(
        yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
        [{ state: "done" }],
      );
      assert.deepEqual(
        yield* sql`SELECT thread_id, status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
        [{ thread_id: null, status: "completed" }],
      );
      assert.lengthOf(
        yield* sql`SELECT thread_id FROM kin_agent_threads WHERE org_id = ${orgId} ORDER BY thread_id`,
        0,
      );
    }).pipe(
      Effect.provide(
        harness().pipe(
          Layer.provide(Layer.mock(OwnerCheck.OwnerCheck)({ post: () => Effect.succeed([]) })),
        ),
      ),
      provideDeterministicTestRuntime,
    ),
  );
  it.effect.each([
    ["a scheduled task gone from memory", "gone", 0],
    ["a scheduled task whose native task was deleted", "deleted", 0],
    ["a question answered or withdrawn before its day", "question", 0],
    ["a scheduled task whose memory read failed, in a turn", "unread", 1],
  ] as const)(
    "answers %s without the model when only NO_REPLY could answer it",
    ([, kind, turns]) =>
      Effect.gen(function* () {
        const prompts: Array<KinLeadPromptInput> = [];
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          if (kind === "deleted")
            yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
              source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
            VALUES ('deleted-task', ${orgId}, 'schedule-item', ${agentId}, 'owner-chat', 'ask',
              'owner', 'owner_only', 'sha', 'inbox', 0, 0)`;
          yield* queue.enqueue(
            decodeEvent({
              _tag: "deferral.due",
              orgId,
              agentId,
              eventId: "due",
              receivedAt: "2026-11-08T00:00:00.000Z",
              dedupeKey: "due",
              provenance: { _tag: "system" },
              subject:
                kind === "question"
                  ? { type: "question", questionId: "question-1" }
                  : { type: "scheduled_task", itemId: "schedule-item", runId: "fire-1" },
              lateByMs: 0,
            }),
          );
          yield* Fiber.join(yield* run());
          assert.lengthOf(prompts, turns);
          assert.deepEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
            { state: "done" },
          ]);
          assert.deepEqual(
            (yield* sql<{ threadId: string | null; status: string }>`SELECT thread_id AS "threadId",
            status FROM kin_wakeups ORDER BY wakeup_id`).map((row) => [
              row.threadId !== null,
              row.status,
            ]),
            [[turns > 0, "completed"]],
          );
        }).pipe(
          Effect.provide(
            harness({
              prompts,
              ...(kind === "unread"
                ? {
                    readItem: (orgId) =>
                      Effect.fail(
                        new Memory.MemorySyncConflict({
                          orgId,
                          operation: "read",
                          reason: "fixture",
                        }),
                      ),
                  }
                : {}),
            }),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );
  it.effect("discards a failed commit session so the next wake-up can stage", () =>
    Effect.gen(function* () {
      let owner: string | undefined;
      let commits = 0;
      const writer = Layer.succeed(
        Writer.MemoryWriter,
        Writer.MemoryWriter.of({
          dreamBase: () => Effect.die("unused"),
          commitDream: () => Effect.die("unused"),
          landDream: () => Effect.die("unused"),
          deleteDreamBranch: () => Effect.die("unused"),
          reconcileSharing: () => Effect.void,
          stripQuotes: () => Effect.void,
          undoChange: () => Effect.die("unused"),
          relabel: () => Effect.die("unused"),
          retire: () => Effect.die("unused"),
          restore: () => Effect.die("unused"),
          recordDecision: () => Effect.die("unused"),
          staged: () => Effect.succeed(false),
          stage: (_org, wakeup) =>
            Effect.sync(() => {
              assert.isTrue(owner === undefined || owner === wakeup);
              owner = wakeup;
            }),
          appendJournal: (_org, wakeup) =>
            Effect.sync(() => {
              assert.isTrue(owner === undefined || owner === wakeup);
              owner = wakeup;
            }),
          discard: (_org, wakeup) =>
            Effect.sync(() => {
              if (owner === wakeup) owner = undefined;
            }),
          commitWakeup: () =>
            Effect.suspend(() =>
              ++commits === 1
                ? Effect.fail(
                    new Writer.MemoryWriteRejected({ reason: "fixture validation failure" }),
                  )
                : Effect.succeed({ commit: "fixture" }),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        yield* queue.enqueue(event("first"));
        const first = yield* run();
        assert.strictEqual((yield* Fiber.await(first))._tag, "Failure");
        assert.isUndefined(owner);
        yield* Context.get(yield* Layer.build(writer), Writer.MemoryWriter).stage(
          orgId,
          "next-wakeup",
          {
            path: "claims/test.md",
            content: "fixture",
          },
        );
        yield* Context.get(yield* Layer.build(writer), Writer.MemoryWriter).discard(
          orgId,
          "next-wakeup",
        );
        yield* queue.enqueue(event("second"));
        yield* Fiber.join(yield* run());
        assert.strictEqual(commits, 2);
      }).pipe(Effect.provide(harness({ writer })));
    }).pipe(provideDeterministicTestRuntime),
  );
  it.effect("runs every kind of turn on the agent's one model, so its thread never switches", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      const at = { receivedAt: "1970-01-01T00:00:00.000Z" };
      for (const next of [
        event("check-in"),
        decodeEvent({ ...event("quiet-check"), ...at, _tag: "pulse", factKeys: [] }),
        yield* ownerSays("asked"),
        decodeEvent({
          ...event("finding"),
          ...at,
          _tag: "watchdog",
          finding: "Check",
          itemIds: [],
        }),
      ]) {
        yield* queue.enqueue(next);
        yield* Fiber.join(yield* run());
      }
      assert.deepStrictEqual(
        yield* sql`SELECT model, COUNT(*) AS turns FROM kin_wakeups WHERE org_id = ${orgId} GROUP BY model`,
        [{ model: "claude-opus-4-6", turns: 4 }],
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect(
    "at the limit runs the owner's urgent turn on the agent's one model, and holds a routine",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const budget = yield* Budget.KinBudget;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* budget.set([{ _tag: "person", orgId, personId: KinPersonId.make("owner") }], {
          orgId,
          limits: { leadUnits: 0, workerUnits: 0 },
        });
        yield* queue.enqueue({
          ...event("urgent"),
          _tag: "resume",
          pausedAt: DateTime.makeUnsafe(0),
          expired: { count: 0, events: [] },
        });
        yield* queue.enqueue(event("routine"));
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT model, status FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ model: "claude-opus-4-6", status: "completed" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [
            { event_id: "routine", state: "queued", attempts: 0 },
            { event_id: "urgent", state: "done", attempts: 0 },
          ],
        );
      }).pipe(
        Effect.provide(
          harness({
            writer: Layer.effect(
              Writer.MemoryWriter,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                return Writer.MemoryWriter.of({
                  stage: () => Effect.die("unused"),
                  dreamBase: () => Effect.die("unused"),
                  commitDream: () => Effect.die("unused"),
                  landDream: () => Effect.die("unused"),
                  deleteDreamBranch: () => Effect.die("unused"),
                  reconcileSharing: () => Effect.void,
                  stripQuotes: () => Effect.void,
                  undoChange: () => Effect.die("unused"),
                  relabel: () => Effect.die("unused"),
                  retire: () => Effect.die("unused"),
                  restore: () => Effect.die("unused"),
                  recordDecision: () => Effect.die("unused"),
                  staged: () => Effect.succeed(false),
                  discard: () => Effect.void,
                  appendJournal: () => Effect.die("unused"),
                  commitWakeup: Effect.fn("test.commitWakeup")(function* (org, wakeupId, outcome) {
                    assert.strictEqual(org, orgId);
                    assert.strictEqual(outcome, "completed");
                    const [row] = yield* sql<{
                      status: string;
                      runStatus: string;
                    }>`SELECT w.status, r.status AS "runStatus" FROM kin_wakeups w JOIN orchestration_v2_projection_runs r ON r.run_id = w.run_id WHERE w.wakeup_id = ${wakeupId}`.pipe(
                      Effect.orDie,
                    );
                    assert.deepStrictEqual(row, { status: "running", runStatus: "completed" });
                    return { commit: "fixture-commit" };
                  }),
                });
              }),
            ),
          }),
        ),
        provideDeterministicTestRuntime,
      ),
  );
  it.effect(
    "defers P3 until the owner-local reset without attempts and re-admits it after limits rise or go",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const budget = yield* Budget.KinBudget;
        const sql = yield* SqlClient.SqlClient;
        const people = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("owner") }];
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/New_York', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
        yield* budget.set(people, { orgId, limits: { leadUnits: 100, workerUnits: 100 } });
        yield* sql`UPDATE kin_budget SET lead_units = 85 WHERE org_id = ${orgId}`;
        const watchdog = (id: string) =>
          decodeEvent({
            ...event(id),
            receivedAt: "1970-01-01T00:00:00.000Z",
            _tag: "watchdog",
            finding: "Check",
            itemIds: [],
          });
        const pending = watchdog("deferred");
        yield* queue.enqueue(pending);
        yield* queue.enqueue(
          decodeEvent({
            ...event("urgent"),
            receivedAt: "1970-01-01T00:00:00.000Z",
            _tag: "resume",
            pausedAt: "1970-01-01T00:00:00.000Z",
            expired: { count: 0, events: [] },
          }),
        );
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT state, not_before, attempts FROM kin_events WHERE org_id = ${orgId} AND event_id = 'deferred' ORDER BY event_id`,
          [{ state: "queued", not_before: 18_000_000, attempts: 0 }],
        );
        yield* budget.set(people, { orgId, limits: { leadUnits: 1000, workerUnits: 100 } });
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [
            { state: "done", attempts: 0 },
            { state: "done", attempts: 0 },
          ],
        );
        // A limit again holds the next one; no limit runs it at once.
        yield* budget.set(people, { orgId, limits: { leadUnits: 100, workerUnits: 100 } });
        yield* queue.enqueue(watchdog("again"));
        yield* Fiber.join(yield* run());
        const again = sql`SELECT state FROM kin_events WHERE event_id = 'again'`;
        assert.deepStrictEqual(yield* again, [{ state: "queued" }]);
        yield* budget.set(people, { orgId, limits: { leadUnits: null, workerUnits: null } });
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(yield* again, [{ state: "done" }]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect("completes Pi wake-ups with disjoint snapshot counters and no turn ledger", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* KinEventQueue.KinEventQueue).enqueue(event("pi"));
      yield* Fiber.join(yield* run());
      const rows = yield* sql<{
        status: string;
        tokens_json: string;
      }>`SELECT status, tokens_json FROM kin_wakeups WHERE org_id = ${orgId}`;
      assert.strictEqual(rows[0]!.status, "completed");
      assert.include(JSON.parse(rows[0]!.tokens_json)[0].tokenUsage, {
        inputTokens: 2,
        cachedInputTokens: 100,
      });
      assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 30);
      assert.deepStrictEqual(
        yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId}`,
        [{ state: "done", attempts: 0 }],
      );
    }).pipe(Effect.provide(harness({ piUsage: true })), provideDeterministicTestRuntime),
  );
  it.effect("never launches a lead whose stored model is on a provider it may not run on", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const models = JSON.stringify({ instanceId: "codex", model: "gpt-5.5" });
      yield* sql`UPDATE kin_leads SET models_json = ${models} WHERE agent_id = ${agentId}`;
      yield* (yield* KinEventQueue.KinEventQueue).enqueue(event("codex-lead"));
      const exit = yield* Fiber.await(yield* run());
      assert.strictEqual(exit._tag, "Failure");
      assert.include(String(exit), "Kin agents can't run on codex");
      assert.deepStrictEqual(
        yield* sql`SELECT status, thread_id FROM kin_wakeups WHERE org_id = ${orgId}`,
        [{ status: "failed", thread_id: null }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id FROM kin_leads WHERE agent_id = ${agentId}`,
        [{ thread_id: null }],
      );
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect(
    "charges failed provider turns from the exact usage recorded on the failed wake-up",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* KinEventQueue.KinEventQueue).enqueue(event("failed-provider"));
        yield* sql`UPDATE kin_events SET budget_deferred = 1, not_before = 0 WHERE org_id = ${orgId}`;
        yield* Fiber.join(yield* run());
        const [row] = yield* sql<{
          status: string;
          tokens_json: string;
        }>`SELECT status, tokens_json FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`;
        assert.strictEqual(row!.status, "failed");
        assert.deepStrictEqual(
          yield* sql`SELECT budget_deferred, attempts FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
          [{ budget_deferred: 0, attempts: 1 }],
        );
        assert.strictEqual((yield* decodeUsage(row!.tokens_json)).length, 1);
        assert.deepStrictEqual(
          yield* sql`SELECT units, tokens_json FROM kin_budget_charges WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ units: 55.5, tokens_json: row!.tokens_json }],
        );
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 55.5);
      }).pipe(Effect.provide(harness({ failed: true })), provideDeterministicTestRuntime),
  );
  it.effect.each([
    {
      failureCode: undefined,
      mode: "reply",
      owed: true,
      said: ["retrying", "retrying", "retrying_later", "gave_up"],
    },
    // No retry signs the account in: each try names the fix, and the bridge says it once.
    {
      failureCode: "authentication_failed",
      mode: "reply",
      owed: true,
      said: ["signin", "signin", "signin", "signin"],
    },
    // Review 48: an assigned entry or a worker's report owes words too, though nobody wrote.
    {
      failureCode: undefined,
      mode: "notice",
      owed: true,
      said: ["retrying", "retrying", "retrying_later", "gave_up"],
    },
    // A check-in nobody waits on retries quietly, but never ends silent.
    { failureCode: undefined, mode: "notice", owed: false, said: ["gave_up"] },
    {
      failureCode: "authentication_failed",
      mode: "notice",
      owed: false,
      said: ["signin", "signin", "signin", "signin"],
    },
  ] as const)(
    "tells the owner at once why a failed start stopped or retries ($failureCode, $mode, owed $owed)",
    ({ failureCode, mode, owed, said }) =>
      Effect.gen(function* () {
        const outcomes: Array<string> = [];
        const bridge = Layer.mock(KinReplyBridge)({
          lane: () =>
            Effect.succeedSome({
              chatId: KinChatId.make("owner-chat"),
              mode,
              owed,
              leadName: "Lead",
            }),
          preparing: () => Effect.void,
          begin: () => Effect.void,
          complete: () => Effect.void,
          end: () => Effect.void,
          failed: (input) => Effect.sync(() => void outcomes.push(input.outcome)),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          yield* (yield* KinEventQueue.KinEventQueue).enqueue(laneMessage("asked"));
          for (const wait of ["15 seconds", "60 seconds", "15 minutes", undefined] as const) {
            yield* Fiber.join(yield* run());
            if (wait !== undefined) yield* TestClock.adjust(wait);
          }
          assert.deepStrictEqual(outcomes, [...said]);
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "failed", attempts: 4 },
          ]);
        }).pipe(
          Effect.provide(
            harness({ failed: true, ...(failureCode === undefined ? {} : { failureCode }) }).pipe(
              Layer.provide(bridge),
            ),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );
  it.effect.each([
    { replied: true, said: ["replied"], state: "done" },
    { replied: false, said: ["partway"], state: "failed" },
  ] as const)(
    "a turn that fails after visible work says it stopped partway only when no reply came (replied $replied)",
    ({ replied, said, state }) =>
      Effect.gen(function* () {
        const outcomes: Array<string> = [];
        let db: SqlClient.SqlClient | undefined;
        const bridge = Layer.mock(KinReplyBridge)({
          lane: () =>
            Effect.succeedSome({
              chatId: KinChatId.make("owner-chat"),
              mode: "reply" as const,
              owed: true,
              leadName: "Lead",
            }),
          preparing: () => Effect.void,
          begin: () => Effect.void,
          // The run did something visible, and its reply posted, before the failure.
          complete: (input) =>
            Effect.gen(function* () {
              const sql = db!;
              yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash)
                VALUES (${input.orgId}, ${input.wakeupId}, 'item:note', 'hash')`;
              if (replied)
                yield* sql`UPDATE kin_events SET replied_at = 1 WHERE wakeup_id = ${input.wakeupId}`;
            }).pipe(Effect.orDie),
          end: () => Effect.void,
          failed: (input) => Effect.sync(() => void outcomes.push(input.outcome)),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          db = sql;
          yield* (yield* KinEventQueue.KinEventQueue).enqueue(laneMessage("asked"));
          yield* Fiber.join(yield* run());
          assert.deepStrictEqual(outcomes, [...said]);
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state }]);
        }).pipe(Effect.provide(harness({ failed: true }).pipe(Layer.provide(bridge))));
      }).pipe(provideDeterministicTestRuntime),
  );
  it.effect(
    "a full disk after visible work keeps the partway line and opens the space trouble, though Kin cleaned",
    () =>
      Effect.gen(function* () {
        const told: Array<string> = [];
        let db: SqlClient.SqlClient | undefined;
        const bridge = Layer.mock(KinReplyBridge)({
          lane: () =>
            Effect.succeedSome({
              chatId: KinChatId.make("owner-chat"),
              mode: "reply" as const,
              owed: true,
              leadName: "Lead",
            }),
          preparing: () => Effect.void,
          begin: () => Effect.void,
          // A tool call ran before the disk filled, so a quiet retry could repeat it.
          complete: (input) =>
            db!`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash)
              VALUES (${input.orgId}, ${input.wakeupId}, 'item:note', 'hash')`.pipe(
              Effect.asVoid,
              Effect.orDie,
            ),
          end: () => Effect.void,
          failed: (input) => Effect.sync(() => void told.push(`line ${input.outcome}`)),
        });
        const care = Layer.succeed(
          KinHostCare,
          KinHostCare.of({
            host: true,
            clean: () => Effect.die("cleaned through spaceFailed"),
            spaceFailed: () => Effect.sync(() => (told.push("clean"), true)),
            devFullDisk: Effect.void,
            failed: (input) =>
              Effect.sync(() => void told.push(`notice ${input.cause} ${input.eventIds.length}`)),
            succeeded: () => Effect.void,
            troubleOpen: () => Effect.succeed(false),
            causeFor: () => Effect.undefined,
            checkBackup: () => Effect.void,
            status: () => Effect.die("not read here"),
            freeSpace: () => Effect.die("not tapped here"),
            backUpNow: () => Effect.die("not tapped here"),
            retry: () => Effect.die("not tapped here"),
          }),
        );
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          db = sql;
          yield* (yield* KinEventQueue.KinEventQueue).enqueue(laneMessage("asked"));
          yield* Fiber.join(yield* run());
          assert.deepStrictEqual(told, ["clean", "notice space 1", "line partway"]);
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "failed" }]);
        }).pipe(
          Effect.provide(
            harness({ failed: true, failureMessage: "ENOSPC: no space left on device" }).pipe(
              Layer.provide(bridge),
              Layer.provide(care),
            ),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );
  it.effect(
    "runs two wake-ups on one T3 thread with distinct provider threads and captures only each run's usage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["first", "second"]) {
          yield* queue.enqueue(event(id));
          yield* Fiber.join(yield* run());
        }
        const rows = yield* sql<{
          thread_id: string;
          tokens_json: string;
          wakeup_id: string;
          model: string;
        }>`SELECT thread_id, tokens_json, wakeup_id, model FROM kin_wakeups ORDER BY started_at`;
        assert.strictEqual(rows.length, 2);
        assert.isTrue(rows.every((row) => row.model === "claude-opus-4-6"));
        assert.strictEqual(rows[0]?.thread_id, rows[1]?.thread_id);
        assert.match(rows[0]!.wakeup_id, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const projection = yield* threads.getThreadProjection(ThreadId.make(rows[0]!.thread_id));
        assert.strictEqual(projection.runs.length, 2);
        assert.notEqual(projection.runs[0]?.providerThreadId, projection.runs[1]?.providerThreadId);
        assert.strictEqual(projection.providerThreads.length, 2);
        for (const row of rows) {
          const usage = yield* decodeUsage(row.tokens_json);
          assert.deepStrictEqual(usage, [
            { turnTokenUsage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } },
          ]);
        }
        const charged = yield* sql<{
          units: number;
          tokens_json: string;
        }>`SELECT units, tokens_json FROM kin_budget_charges WHERE org_id = ${orgId} ORDER BY wakeup_id`;
        assert.strictEqual(charged.length, 2);
        assert.isTrue(charged.every((charge) => charge.units === 55.5));
        assert.deepStrictEqual(
          charged.map((charge) => charge.tokens_json).toSorted(),
          rows.map((row) => row.tokens_json).toSorted(),
        );
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 111);
        assert.include(yield* resolveAgent(projection.thread.id).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        assert.isTrue((yield* KinIdentity.KinIdentity).isAgentThread(projection.thread.id));
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
          { state: "done" },
          { state: "done" },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );
  it.effect(
    "re-arms a lapsed direct-chat grant when the wake-up starts, for that wake-up only",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          const repo = yield* KinChatRepository.KinChatRepository;
          const floor = yield* Floor.KinFloor;
          const at = "2026-11-08T00:00:00.000Z";
          yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
            VALUES ('direct', 'org', 'direct', 'owner:lead', 1, ${at})`;
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
            VALUES ('owner-member', 'org', 'direct', 'person', 'owner', 'owner', ${at})`;
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
            VALUES ('lead-member', 'org', 'direct', 'agent', 'lead', 'member', ${at})`;
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
              author_member_id, author_role, kind, body, mentions_json, status, created_at)
            VALUES ('hi', 'org', 'direct', 1, 'human', 'owner', 'owner-member', 'owner', 'text', 'hi', '[]',
              'posted', ${at})`;
          const scope = { orgId, chatId: KinChatId.make("direct") };
          const chat = Option.getOrThrow(yield* repo.getChat(scope));
          const message = Option.getOrThrow(
            yield* repo.getMessage({ orgId, messageId: KinMessageId.make("hi") }),
          );
          yield* floor.open(message, chat);
          // The post-time grant lapses while the server is down, before catch-up enqueues it.
          yield* TestClock.adjust(FLOOR_GRANT_TTL_MS + 60_000);
          yield* (yield* KinEventQueue.KinEventQueue).enqueue(
            decodeEvent({
              _tag: "chat.message",
              orgId,
              agentId,
              eventId: "catch-up-hi",
              receivedAt: at,
              dedupeKey: "chat-message:hi:lead",
              provenance: { _tag: "human", personId: "owner", memberId: "owner-member" },
              chatId: "direct",
              messageId: "hi",
            }),
          );
          const fiber = yield* run();
          yield* Deferred.await(entered);
          const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
          const identity = yield* resolveAgent(ThreadId.make(lead!.thread_id));
          // The renewed grant lasts as long as the wake-up, so a reply 10 minutes in still lands.
          yield* TestClock.adjust("10 minutes");
          const { runId } = yield* floor.authorize(identity, chat, "answer");
          assert.isNotNull(runId);
          // The wake-up keeps the grant for its run: its next post is the same agent turn.
          assert.strictEqual((yield* floor.authorize(identity, chat, "evidence")).runId, runId);
          // A used grant is never re-armed, whatever deadline is asked for.
          const grantExpiry = sql<{ expires_at: number }>`SELECT expires_at FROM kin_floor_grants
          WHERE org_id = ${orgId} AND agent_id = ${agentId} ORDER BY expires_at`;
          const before = yield* grantExpiry;
          yield* floor.renew({
            orgId,
            agentId,
            messageIds: [KinMessageId.make("hi")],
            until: Number.MAX_SAFE_INTEGER,
          });
          assert.deepStrictEqual(yield* grantExpiry, before);
          yield* Deferred.succeed(hold, undefined);
          yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Floor.layer, KinChatRepository.layer).pipe(
              Layer.provideMerge(harness({ entered, hold })),
            ),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("keeps an unused grant while a rescue turn works, and lets it lapse once silent", () =>
    Effect.gen(function* () {
      const rescuing = yield* Deferred.make<void>();
      const rescued = yield* Deferred.make<void>();
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      // The run ended owing a reply; the rescue turn writes while this holds.
      const bridge = Layer.mock(KinReplyBridge)({
        lane: () =>
          Effect.succeedSome({
            chatId: KinChatId.make("direct"),
            mode: "reply" as const,
            owed: true,
            leadName: "Lead",
          }),
        preparing: () => Effect.void,
        begin: () => Effect.void,
        complete: () =>
          Deferred.succeed(rescuing, undefined).pipe(Effect.andThen(Deferred.await(rescued))),
        end: () => Effect.void,
        failed: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* KinChatRepository.KinChatRepository;
        const floor = yield* Floor.KinFloor;
        const at = "2026-11-08T00:00:00.000Z";
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
          VALUES ('direct', 'org', 'direct', 'owner:lead', 1, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
          VALUES ('owner-member', 'org', 'direct', 'person', 'owner', 'owner', ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
          VALUES ('lead-member', 'org', 'direct', 'agent', 'lead', 'member', ${at})`;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
            author_member_id, author_role, kind, body, mentions_json, status, created_at)
          VALUES ('hi', 'org', 'direct', 1, 'human', 'owner', 'owner-member', 'owner', 'text', 'hi', '[]',
            'posted', ${at})`;
        const chat = Option.getOrThrow(
          yield* repo.getChat({ orgId, chatId: KinChatId.make("direct") }),
        );
        const message = Option.getOrThrow(
          yield* repo.getMessage({ orgId, messageId: KinMessageId.make("hi") }),
        );
        yield* floor.open(message, chat);
        yield* (yield* KinEventQueue.KinEventQueue).enqueue(laneMessage("hi", "direct"));
        const fiber = yield* run();
        yield* Deferred.await(rescuing);
        const [lead] = yield* sql<{
          threadId: string;
        }>`SELECT thread_id AS "threadId" FROM kin_leads`;
        const threadId = ThreadId.make(lead!.threadId);
        const grantLeft = Effect.gen(function* () {
          const [grant] = yield* sql<{ expiresAt: number }>`SELECT expires_at AS "expiresAt"
            FROM kin_floor_grants WHERE org_id = ${orgId} AND agent_id = ${agentId}
              AND consumed_at IS NULL ORDER BY expires_at`;
          return grant!.expiresAt - (yield* Clock.currentTimeMillis);
        });
        // The rescue turn makes a tool call every 10 minutes for half an hour.
        for (let call = 1; call <= 3; call++) {
          yield* TestClock.adjust("10 minutes");
          const now = yield* DateTime.now;
          yield* Queue.offer(domainEvents, {
            id: EventId.make(`rescue-work-${call}`),
            threadId,
            occurredAt: now,
            type: "turn-item.updated",
            payload: {
              id: TurnItemId.make(`rescue-tool-${call}`),
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 100 + call,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "dynamic_tool",
              toolName: "Bash",
              input: {},
            },
          });
        }
        yield* TestClock.adjust("10 minutes");
        assert.isAbove(yield* grantLeft, 0, "a working rescue turn keeps the grant");
        yield* TestClock.adjust("10 minutes");
        assert.isAtMost(yield* grantLeft, 0, "a silent one lets it lapse");
        yield* Deferred.succeed(rescued, undefined);
        yield* Fiber.join(fiber);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Floor.layer, KinChatRepository.layer).pipe(
            Layer.provideMerge(harness({ domainEvents }).pipe(Layer.provide(bridge))),
          ),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("starts every wake-up in a fresh session with the full prompt, committing each", () =>
    Effect.gen(function* () {
      let commits = 0;
      const prompts: Array<KinLeadPromptInput> = [];
      const writer = Layer.mock(Writer.MemoryWriter)({
        appendJournal: () => Effect.void,
        commitWakeup: () => Effect.sync(() => (commits++, { commit: "fixture" })),
        discard: () => Effect.void,
      });
      yield* Effect.gen(function* () {
        yield* seed;
        yield* seedDirectChats;
        // Back to back in one direct chat, at one level and model: still no session carries over.
        for (const id of ["m1", "m2", "m3"]) {
          yield* wake(id);
          yield* TestClock.adjust("1 minute");
        }
        assert.deepStrictEqual(yield* sessions(), [1, 2, 3]);
        assert.lengthOf(prompts, 3);
        assert.strictEqual(commits, 3);
      }).pipe(Effect.provide(harness({ writer, prompts })));
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("interrupts mid-wake-up without counting an attempt and admits the next claim", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      // What the agent staged before the server stopped lands; it is never dropped.
      const memory: Array<string> = [];
      let staged = true;
      const writer = Layer.mock(Writer.MemoryWriter)({
        appendJournal: () => Effect.void,
        staged: () => Effect.sync(() => staged),
        commitWakeup: (_org, _wakeup, outcome) =>
          Effect.sync(() => {
            staged = false;
            memory.push(`commit ${outcome}`);
            return { commit: "landed" };
          }),
        discard: () => Effect.sync(() => void memory.push("discard")),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("interrupt"));
        const fiber = yield* run();
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        assert.deepStrictEqual(
          yield* sql`SELECT status, memory_commit FROM kin_wakeups ORDER BY wakeup_id`,
          [{ status: "interrupted", memory_commit: "landed" }],
        );
        assert.deepStrictEqual(memory, ["commit completed", "discard"]);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 0 },
        ]);
        yield* queue.enqueue(event("next"));
        yield* TestClock.adjust("20 seconds");
        const events = yield* Effect.scoped(
          queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("next"), model: "test" }),
        );
        assert.deepStrictEqual(
          events.map((item) => item.eventId),
          [event("interrupt").eventId, event("next").eventId],
        );
        yield* queue.finish({ orgId, wakeupId: KinWakeupId.make("next"), status: "completed" });
        assert.isDefined(runner);
      }).pipe(
        Effect.provide(
          harness({
            writer,
            prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("backs off a cross-process busy claim on TestClock instead of spinning", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("blocker"));
      yield* TestClock.adjust("20 seconds");
      yield* Effect.scoped(
        queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("blocker"), model: "test" }),
      );
      yield* queue.enqueue(event("waiting"));
      const fiber = yield* run();
      yield* queue.finish({ orgId, wakeupId: KinWakeupId.make("blocker"), status: "completed" });
      yield* TestClock.adjust("4 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      assert.strictEqual((yield* sql`SELECT * FROM kin_wakeups`).length, 1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
        { state: "done" },
        { state: "done" },
      ]);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect(
    "ends a run silent from the start 15 minutes after it began, without leaving the organization busy",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          const sessions = yield* McpSessionRegistry.__testing.make().pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(HttpServer.HttpServer)({
                  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                }),
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
                }),
              ),
            ),
          );
          const launch = yield* ThreadLaunch.ThreadLaunchService;
          const runner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(ThreadLaunch.ThreadLaunchService, {
              ...launch,
              launch: (input) =>
                launch.launch(input).pipe(
                  Effect.tap((result) =>
                    Effect.gen(function* () {
                      assert.strictEqual(
                        (yield* resolveAgent(result.projection.thread.id)).agentId,
                        agentId,
                      );
                    }),
                  ),
                ),
            }),
          );
          yield* queue.enqueue(event("timeout"));
          const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          yield* TestClock.adjust("20 seconds");
          yield* Deferred.await(entered);
          const [lead] = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          const threadId = ThreadId.make(lead!.thread_id);
          const issued = yield* sessions.issue({
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
          assert.isDefined(yield* sessions.resolve(token));
          assert.strictEqual(
            (yield* (yield* KinIdentity.KinIdentity).resolveAgent(
              (yield* sessions.resolve(token))!,
            )).agentId,
            agentId,
          );
          yield* TestClock.adjust("14 minutes");
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "running" },
          ]);
          yield* TestClock.adjust("1 minute");
          yield* TestClock.adjust("30 seconds");
          yield* Fiber.join(fiber);
          assert.isDefined(yield* sessions.resolve(token));
          assert.include(yield* resolveAgent(threadId).pipe(Effect.flip), {
            reason: "not_allowed",
          });
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "timed_out" },
          ]);
          // Nothing showed, so its event is retried as any failed wake-up's is.
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "queued", attempts: 1 },
          ]);
          yield* Deferred.succeed(hold, undefined);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        }).pipe(Effect.provide(harness({ entered, hold })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect.each([
    [
      "keeps a wake-up whose run works every 10 minutes running for 3 hours, until it ends",
      19,
      false,
    ],
    ["ends a wake-up 15 minutes after its run's last activity, though it worked for 40", 5, true],
  ] as const)("%s", ([, calls, quiet]) =>
    Effect.gen(function* () {
      const holdRunning = yield* Deferred.make<void>();
      const work = yield* Queue.unbounded<void>();
      const outcomes: Array<string> = [];
      const rescues: Array<boolean> = [];
      const bridge = Layer.mock(KinReplyBridge)({
        lane: () =>
          Effect.succeedSome({
            chatId: KinChatId.make("owner-chat"),
            mode: "reply" as const,
            owed: true,
            leadName: "Lead",
          }),
        preparing: () => Effect.void,
        begin: () => Effect.void,
        complete: (input) => Effect.sync(() => void rescues.push(input.rescue)),
        end: () => Effect.void,
        failed: (input) => Effect.sync(() => void outcomes.push(input.outcome)),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("long"));
        const running = yield* threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const fiber = yield* run();
        yield* Fiber.join(running);
        const [wakeup] = yield* sql<{ threadId: string }>`
          SELECT thread_id AS "threadId" FROM kin_wakeups`;
        const threadId = ThreadId.make(wakeup!.threadId);
        for (let call = 1; call <= calls; call++) {
          yield* toolCall(work, threadId);
          if (call < calls) yield* TestClock.adjust("10 minutes");
        }
        if (!quiet) {
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "running" },
          ]);
          yield* Deferred.succeed(holdRunning, undefined);
        } else {
          yield* TestClock.adjust("14 minutes");
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "running" },
          ]);
          yield* TestClock.adjust("1 minute");
        }
        yield* Fiber.join(fiber);
        const runs = (yield* threads.getThreadProjection(threadId)).runs;
        if (!quiet) {
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "completed" },
          ]);
          assert.deepStrictEqual(
            runs.map((entry) => entry.status),
            ["completed"],
          );
          assert.deepStrictEqual(rescues, [true]);
          assert.deepStrictEqual(outcomes, []);
        } else {
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "timed_out" },
          ]);
          assert.deepStrictEqual(
            runs.map((entry) => entry.status),
            ["interrupted"],
          );
          // Today's recovery for a timed-out wake-up: no rescue, an honest line, a retry.
          assert.deepStrictEqual(rescues, [false]);
          assert.deepStrictEqual(outcomes, ["retrying"]);
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "queued", attempts: 1 },
          ]);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          harness(quiet ? { untilInterrupted: true, work } : { holdRunning, work }).pipe(
            Layer.provide(bridge),
          ),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "recovers abandoned and completed wake-ups once after restart without relaunching",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("abandoned"));
        yield* TestClock.adjust("20 seconds");
        yield* Effect.scoped(
          queue.claim({ orgId, agentId, wakeupId: KinWakeupId.make("abandoned"), model: "test" }),
        );
        const missingThread = ThreadId.make("provisional-thread");
        yield* (yield* KinIdentity.KinIdentity).registerAgentThread({
          orgId,
          agentId,
          threadId: missingThread,
        });
        yield* sql`UPDATE kin_leads SET thread_id = ${missingThread} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
        yield* sql`UPDATE kin_wakeups SET thread_id = ${missingThread} WHERE org_id = ${orgId} AND wakeup_id = 'abandoned'`;
        yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash) VALUES (${orgId}, 'abandoned', 'item:test', 'hash')`;
        const recoveryWriter = Layer.mock(Writer.MemoryWriter)({
          commitWakeup: () =>
            Effect.fail(new Writer.MemoryWriteRejected({ reason: "fixture commit failure" })),
          discard: () => Effect.void,
        });
        yield* WakeupRunner.WakeupRunner.pipe(
          Effect.flatMap((recovery) => recovery.recover),
          Effect.provide(Layer.fresh(WakeupRunner.layer).pipe(Layer.provide(recoveryWriter))),
        );
        assert.deepStrictEqual(yield* sql`SELECT attempts, not_before FROM kin_events`, [
          { attempts: 0, not_before: null },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT thread_id FROM kin_leads`, [{ thread_id: null }]);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
          { status: "interrupted" },
        ]);
        yield* Fiber.join(yield* run());
        // Reconstruct a crash before the atomic usage capture and charge committed.
        yield* sql`DELETE FROM kin_budget_charges WHERE org_id = ${orgId}`;
        yield* sql`UPDATE kin_budget SET lead_units = 0 WHERE org_id = ${orgId}`;
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL, tokens_json = NULL WHERE status = 'completed'`;
        yield* sql`UPDATE kin_events SET state = 'claimed' WHERE state = 'done'`;
        // A restart continuation of the wake-up's run, with its own attempt and provider turn.
        const [root] = yield* sql<{ runId: string }>`
          SELECT run_id AS "runId" FROM orchestration_v2_projection_runs ORDER BY ordinal`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider,
            provider_thread_id, status, requested_at, completed_at, payload_json, provider_instance_id)
          SELECT 'restart-continuation', thread_id, ordinal + 1, provider, provider_thread_id, status,
            requested_at, completed_at, json_set(payload_json, '$.id', 'restart-continuation',
              '$.ordinal', ordinal + 1, '$.restartContinuationOfRunId', run_id,
              '$.activeAttemptId', 'restart-attempt'), provider_instance_id
          FROM orchestration_v2_projection_runs WHERE run_id = ${root!.runId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts (attempt_id, thread_id, run_id,
            attempt_ordinal, root_node_id, provider, provider_thread_id, provider_turn_id, status,
            payload_json, provider_instance_id)
          SELECT 'restart-attempt', thread_id, 'restart-continuation', attempt_ordinal, root_node_id,
            provider, provider_thread_id, 'restart-turn', status, json_set(payload_json,
              '$.id', 'restart-attempt', '$.runId', 'restart-continuation',
              '$.providerTurnId', 'restart-turn'), provider_instance_id
          FROM orchestration_v2_projection_run_attempts WHERE run_id = ${root!.runId}`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_turns (provider_turn_id, thread_id,
            provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at,
            payload_json)
          SELECT 'restart-turn', thread_id, provider_thread_id, node_id, 'restart-attempt', ordinal + 1,
            status, started_at, completed_at, json_set(payload_json, '$.id', 'restart-turn',
              '$.runAttemptId', 'restart-attempt', '$.ordinal', ordinal + 1)
          FROM orchestration_v2_projection_provider_turns WHERE run_attempt_id IN (
            SELECT attempt_id FROM orchestration_v2_projection_run_attempts
            WHERE run_id = ${root!.runId})`;
        const recoveredRunner = yield* WakeupRunner.WakeupRunner.pipe(
          Effect.provide(Layer.fresh(WakeupRunner.layer)),
        );
        yield* recoveredRunner.recover;
        yield* recoveredRunner.recover;
        const [usageRow] = yield* sql<{
          tokens_json: string;
        }>`SELECT tokens_json FROM kin_wakeups WHERE status = 'completed'`;
        assert.strictEqual((yield* decodeUsage(usageRow!.tokens_json)).length, 2);
        assert.strictEqual((yield* (yield* Budget.KinBudget).get(orgId)).leadUnits, 111);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups ORDER BY status`, [
          { status: "completed" },
          { status: "interrupted" },
        ]);
        const [row] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
        const projection =
          yield* (yield* ThreadManagement.ThreadManagementService).getThreadProjection(
            ThreadId.make(row!.thread_id),
          );
        // The wake-up's run and its continuation: recovery launched nothing.
        assert.strictEqual(projection.runs.length, 2);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "done", attempts: 0 },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect.each(["projection", "decode"] as const)(
    "finalizes recovery after a %s failure instead of retrying forever",
    (failure) =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("recovery-failure"));
        yield* Fiber.join(yield* run());
        yield* sql`UPDATE kin_wakeups SET status = 'running', ended_at = NULL`;
        yield* sql`UPDATE kin_events SET state = 'claimed'`;
        if (failure === "decode") yield* sql`UPDATE kin_wakeups SET run_id = ''`;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const runner = yield* WakeupRunner.WakeupRunner.pipe(
          Effect.provide(Layer.fresh(WakeupRunner.layer)),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ...threads,
            getThreadRecords: () => Effect.die("projection unavailable"),
          }),
        );
        yield* runner.recover;
        yield* runner.recover;
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [{ status: "failed" }]);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 1 },
        ]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("wakes another lead while the first has a held queued run", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("first"));
      yield* Fiber.join(yield* run());
      const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
      const threadId = ThreadId.make(lead!.thread_id);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("hold"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("held-message"),
        threadId,
        messageId: MessageId.make("held-message"),
        text: "Held",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("held-second"),
        threadId,
        messageId: MessageId.make("held-second"),
        text: "Held",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("hold-queue"),
        threadId,
      });
      assert.strictEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.status,
        "queued",
      );
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        SELECT 'lead-z', org_id, display_name, role, owner_person_id, created_at FROM kin_agents WHERE agent_id = 'lead'`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        SELECT 'lead-z', org_id, name, level_since, models_json, worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = 'lead'`;
      yield* queue.enqueue(event("busy"));
      yield* queue.enqueue({ ...event("other"), agentId: KinAgentId.make("lead-z") });
      yield* TestClock.adjust("20 seconds");
      const next = (yield* queue.readyLeads(orgId))[0];
      assert.strictEqual(next?.agentId, "lead-z");
      yield* Fiber.join(
        yield* (yield* WakeupRunner.WakeupRunner)
          .runOnce(orgId, next!.agentId)
          .pipe(Effect.forkChild),
      );
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'other'`, [
        { state: "done" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'busy'`, [
        { state: "queued" },
      ]);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("runs two leads' wake-ups at the same time", () =>
    Effect.gen(function* () {
      const holdRunning = yield* Deferred.make<void>();
      const enteredThreads = yield* Queue.unbounded<ThreadId>();
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          SELECT 'lead-z', org_id, display_name, role, owner_person_id, created_at FROM kin_agents WHERE agent_id = 'lead'`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          SELECT 'lead-z', org_id, name, level_since, models_json, worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = 'lead'`;
        yield* queue.enqueue(event("first"));
        yield* queue.enqueue({ ...event("other"), agentId: KinAgentId.make("lead-z") });
        yield* runner.start;
        yield* TestClock.adjust("20 seconds");
        const entered = [yield* Queue.take(enteredThreads), yield* Queue.take(enteredThreads)];
        assert.notStrictEqual(entered[0], entered[1]);
        assert.deepStrictEqual(
          yield* sql`SELECT agent_id FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY agent_id`,
          [{ agent_id: "lead" }, { agent_id: "lead-z" }],
        );
        yield* Deferred.succeed(holdRunning, undefined);
        while (true) {
          const changed = yield* queue.changes(orgId);
          const running =
            yield* sql`SELECT wakeup_id FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY wakeup_id`;
          if (running.length === 0) break;
          yield* changed;
        }
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events ORDER BY event_id`, [
          { state: "done" },
          { state: "done" },
        ]);
      }).pipe(
        Effect.provide(
          harness({
            holdRunning,
            onTurn: ({ threadId }) => Queue.offer(enteredThreads, threadId).pipe(Effect.asVoid),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("steers a second message in the lane into the running turn, in the same wake-up", () =>
    Effect.gen(function* () {
      const wholeThreadReads: Array<ThreadId> = [];
      const holdRunning = yield* Deferred.make<void>();
      const providerSteers = yield* Queue.unbounded<{ runId: string; messageId: string }>();
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* ownerSays("ask"));
        const running = yield* threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const fiber = yield* run();
        yield* Fiber.join(running);
        yield* queue.enqueue(yield* ownerSays("again"));
        const steered = yield* Queue.take(providerSteers);
        yield* Deferred.succeed(holdRunning, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(wholeThreadReads, [], "the wake-up read no thread's whole history");
        const [wakeup, ...others] = yield* sql<{
          wakeupId: string;
          runId: string;
          threadId: string;
          status: string;
        }>`
          SELECT wakeup_id AS "wakeupId", run_id AS "runId", thread_id AS "threadId", status
          FROM kin_wakeups ORDER BY wakeup_id`;
        assert.lengthOf(others, 0);
        assert.strictEqual(wakeup!.status, "completed");
        assert.deepStrictEqual(steered, {
          runId: wakeup!.runId,
          messageId: KinIdentity.steerMessageId(KinWakeupId.make(wakeup!.wakeupId), 1),
        });
        // One turn answered both: the steer started no run of its own.
        const runs = (yield* threads.getThreadProjection(ThreadId.make(wakeup!.threadId))).runs;
        assert.deepStrictEqual(
          runs.map((entry) => entry.id),
          [wakeup!.runId],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, wakeup_id FROM kin_events ORDER BY event_id`,
          ["again", "ask"].map((id) => ({
            event_id: id,
            state: "done",
            wakeup_id: wakeup!.wakeupId,
          })),
        );
        // Answered, so no later wake-up is owed it.
        assert.deepStrictEqual(yield* queue.readyLeads(orgId), []);
      }).pipe(
        Effect.scoped,
        Effect.provide(harness({ holdRunning, providerSteers, wholeThreadReads })),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("delivers every message steered into a running wake-up, the sixth and tenth too", () =>
    Effect.gen(function* () {
      const holdRunning = yield* Deferred.make<void>();
      const providerSteers = yield* Queue.unbounded<{ runId: string; messageId: string }>();
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* ownerSays("ask"));
        const running = yield* threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const fiber = yield* run();
        yield* Fiber.join(running);
        const [wakeup] = yield* sql<{ wakeupId: string; runId: string }>`
          SELECT wakeup_id AS "wakeupId", run_id AS "runId" FROM kin_wakeups`;
        const wakeupId = KinWakeupId.make(wakeup!.wakeupId);
        for (let n = 1; n <= 10; n++) {
          yield* queue.enqueue(yield* ownerSays(`again-${String(n).padStart(2, "0")}`));
          assert.deepStrictEqual(yield* Queue.take(providerSteers), {
            runId: wakeup!.runId,
            messageId: KinIdentity.steerMessageId(wakeupId, n),
          });
        }
        yield* Deferred.succeed(holdRunning, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
          { status: "completed" },
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT state, wakeup_id FROM kin_events ORDER BY event_id`,
          Array.from({ length: 11 }, () => ({ state: "done", wakeup_id: wakeup!.wakeupId })),
        );
      }).pipe(Effect.scoped, Effect.provide(harness({ holdRunning, providerSteers })));
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect.each([
    ["takes over T3's run for a finished task instead of starting its own", true],
    ["answers a finished task whose run already ended in a turn of its own", false],
  ] as const)("%s", ([, live]) =>
    Effect.gen(function* () {
      const wholeThreadReads: Array<ThreadId> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let turns = 0;
      const calls: Array<string> = [];
      let check: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
      // The lead's first turn runs freely; the turn for T3's notice waits while `live`, then
      // calls a Kin tool as the agent would once its wake-up owns it.
      const onTurn = ({ threadId }: { readonly threadId: ThreadId }) =>
        Effect.suspend(() =>
          ++turns === 2 && live
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(check(threadId)),
              )
            : Effect.void,
        );
      yield* Effect.gen(function* () {
        yield* seed;
        const services = yield* Effect.context<
          KinIdentity.KinIdentity | McpSessionRegistry.McpSessionRegistry
        >();
        check = (threadId) =>
          resolveAgent(threadId).pipe(
            Effect.provideContext(services),
            Effect.match({
              onFailure: (error) => calls.push(error.message),
              onSuccess: () => calls.push("allowed"),
            }),
          );
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* ownerSays("ask"));
        yield* Fiber.join(yield* run());
        const [first] = yield* sql<{ threadId: string }>`
          SELECT thread_id AS "threadId" FROM kin_wakeups`;
        const threadId = ThreadId.make(first!.threadId);
        const projectId = (yield* threads.getThreadProjection(threadId)).thread.projectId;
        // What T3 sends a parent when a task it delegated ends (`ProviderContinuationService`).
        const notice = MessageId.make("delegated-completion:1");
        const sent = yield* threads.sendToThread({
          commandId: CommandId.make("delegated-completion"),
          projectId,
          threadId,
          messageId: notice,
          text: "Delegated task task-1 reached a terminal state.",
          attachments: [],
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        });
        if (live) yield* Deferred.await(started);
        else
          yield* threads.waitForThread({
            projectId,
            threadId,
            runId: sent.run.id,
            timeoutMs: 60_000,
          });
        yield* queue.enqueue(
          decodeEvent({
            _tag: "task.finished",
            orgId,
            agentId,
            eventId: "task-finished",
            receivedAt: "2026-11-08T00:00:01.000Z",
            dedupeKey: notice,
            provenance: { _tag: "system" },
            threadId,
            messageId: notice,
            taskIds: ["task-1"],
            chatId: "owner-chat",
          }),
        );
        const readsBefore = wholeThreadReads.length;
        const fiber = yield* run();
        if (live) yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        assert.strictEqual(wholeThreadReads.length, readsBefore, "no whole-history read");
        const wakeups = yield* sql<{ wakeupId: string; runId: string; status: string }>`
          SELECT wakeup_id AS "wakeupId", run_id AS "runId", status FROM kin_wakeups
          ORDER BY started_at, wakeup_id`;
        assert.deepStrictEqual(
          wakeups.map((row) => row.status),
          ["completed", "completed"],
        );
        const runs = (yield* threads.getThreadProjection(threadId)).runs.toSorted(
          (a, b) => a.ordinal - b.ordinal,
        );
        assert.deepStrictEqual(
          runs.map((entry) => entry.userMessageId),
          [
            KinIdentity.wakeupMessageId(KinWakeupId.make(wakeups[0]!.wakeupId)),
            notice,
            ...(live ? [] : [KinIdentity.wakeupMessageId(KinWakeupId.make(wakeups[1]!.wakeupId))]),
          ],
        );
        assert.strictEqual(wakeups[1]!.runId, live ? sent.run.id : runs[2]!.id);
        // Before Kin took it over, the run's Kin calls were refused; after, they are the agent's.
        assert.deepStrictEqual(calls, live ? ["allowed"] : []);
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM kin_events WHERE event_id = 'task-finished'`,
          [{ state: "done" }],
        );
      }).pipe(Effect.scoped, Effect.provide(harness({ onTurn, wholeThreadReads })));
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("answers a steer the provider rejects once, in a run the same wake-up adopts", () =>
    Effect.gen(function* () {
      const holdRunning = yield* Deferred.make<void>();
      let onSteer: (input: {
        readonly providerTurnId: string;
      }) => Effect.Effect<void, ProviderAdapterSteerRunError> = () => Effect.void;
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        // The turn ends as the steer reaches the provider, which then refuses it.
        onSteer = (input) =>
          Effect.gen(function* () {
            const ended = yield* threads.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "provider-turn.updated" &&
                  event.payload.id === input.providerTurnId &&
                  event.payload.completedAt !== null,
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.orDie,
              Effect.forkChild,
            );
            yield* Deferred.succeed(holdRunning, undefined);
            yield* Fiber.join(ended);
            return yield* new ProviderAdapterSteerRunError({
              driver: ProviderDriverKind.make("claudeAgent"),
              providerThreadId: ProviderThreadId.make("native-1"),
              providerTurnId: ProviderTurnId.make(input.providerTurnId),
            });
          });
        yield* queue.enqueue(yield* ownerSays("ask"));
        const running = yield* threads.streamDomainEvents.pipe(
          Stream.filter(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const fiber = yield* run();
        yield* Fiber.join(running);
        yield* queue.enqueue(yield* ownerSays("again"));
        yield* Fiber.join(fiber);
        const [wakeup, ...others] = yield* sql<{
          wakeupId: string;
          threadId: string;
          status: string;
        }>`SELECT wakeup_id AS "wakeupId", thread_id AS "threadId", status FROM kin_wakeups`;
        assert.lengthOf(others, 0);
        assert.strictEqual(wakeup!.status, "completed");
        const wakeupId = KinWakeupId.make(wakeup!.wakeupId);
        const runs = (yield* threads.getThreadProjection(ThreadId.make(wakeup!.threadId))).runs;
        assert.deepStrictEqual(
          runs.map((entry) => [entry.userMessageId, entry.status]),
          [
            [KinIdentity.wakeupMessageId(wakeupId), "completed"],
            [KinIdentity.steerMessageId(wakeupId, 1), "completed"],
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, wakeup_id FROM kin_events ORDER BY event_id`,
          ["again", "ask"].map((id) => ({ event_id: id, state: "done", wakeup_id: wakeupId })),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(harness({ holdRunning, onSteer: (input) => onSteer(input) })),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "answers a message whose steer never reached the thread in exactly one later wake-up",
    () =>
      Effect.gen(function* () {
        const holdRunning = yield* Deferred.make<void>();
        const steering = yield* Deferred.make<void>();
        const fixture = { holdRunning, steering, steerFails: true };
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const sql = yield* SqlClient.SqlClient;
          yield* queue.enqueue(yield* ownerSays("ask"));
          const running = yield* threads.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const fiber = yield* run();
          yield* Fiber.join(running);
          yield* queue.enqueue(yield* ownerSays("again"));
          yield* Deferred.await(steering);
          yield* Deferred.succeed(holdRunning, undefined);
          yield* Fiber.join(fiber);
          const [first] = yield* sql<{ wakeupId: string; threadId: string }>`
          SELECT wakeup_id AS "wakeupId", thread_id AS "threadId" FROM kin_wakeups`;
          assert.deepStrictEqual(
            yield* sql`SELECT event_id, state FROM kin_events ORDER BY event_id`,
            [
              { event_id: "again", state: "queued" },
              { event_id: "ask", state: "done" },
            ],
          );
          yield* Fiber.join(yield* run());
          const wakeups = yield* sql<{ wakeupId: string; status: string }>`
          SELECT wakeup_id AS "wakeupId", status FROM kin_wakeups ORDER BY started_at, wakeup_id`;
          assert.deepStrictEqual(
            wakeups.map((entry) => entry.status),
            ["completed", "completed"],
          );
          assert.deepStrictEqual(
            yield* sql`SELECT event_id, wakeup_id FROM kin_events WHERE state = 'done' ORDER BY event_id`,
            [
              { event_id: "again", wakeup_id: wakeups[1]!.wakeupId },
              { event_id: "ask", wakeup_id: first!.wakeupId },
            ],
          );
          const runs = (yield* threads.getThreadProjection(ThreadId.make(first!.threadId))).runs;
          assert.isFalse(
            runs.some((entry) => entry.userMessageId.startsWith("kin-steer-msg:")),
            "no steer reached the thread",
          );
          assert.deepStrictEqual(yield* queue.readyLeads(orgId), []);
        }).pipe(Effect.scoped, Effect.provide(harness(fixture)));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("adopts a steer that lands after the turn, and lets its Kin tool calls through", () =>
    Effect.gen(function* () {
      const wholeThreadReads: Array<ThreadId> = [];
      const entered = yield* Deferred.make<void>();
      const hold = yield* Deferred.make<void>();
      const steering = yield* Deferred.make<void>();
      const calls: Array<string> = [];
      let check: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const services = yield* Effect.context<
          KinIdentity.KinIdentity | McpSessionRegistry.McpSessionRegistry
        >();
        check = (threadId) =>
          resolveAgent(threadId).pipe(
            Effect.provideContext(services),
            Effect.match({
              onFailure: (error) => calls.push(error.message),
              onSuccess: () => calls.push("allowed"),
            }),
          );
        yield* queue.enqueue(yield* ownerSays("ask"));
        const fiber = yield* run();
        yield* Deferred.await(entered);
        // The turn has not started streaming, so the steer cannot join it.
        yield* queue.enqueue(yield* ownerSays("again"));
        yield* Deferred.await(steering);
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(wholeThreadReads, [], "the wake-up read no thread's whole history");
        const [wakeup, ...others] = yield* sql<{
          wakeupId: string;
          threadId: string;
          status: string;
        }>`
          SELECT wakeup_id AS "wakeupId", thread_id AS "threadId", status FROM kin_wakeups ORDER BY wakeup_id`;
        assert.lengthOf(others, 0);
        assert.strictEqual(wakeup!.status, "completed");
        const wakeupId = KinWakeupId.make(wakeup!.wakeupId);
        const runs = (yield* threads.getThreadProjection(ThreadId.make(wakeup!.threadId))).runs;
        assert.deepStrictEqual(
          runs.map((entry) => [entry.userMessageId, entry.status]),
          [
            [KinIdentity.wakeupMessageId(wakeupId), "completed"],
            [KinIdentity.steerMessageId(wakeupId, 1), "completed"],
          ],
        );
        // Both runs' Kin MCP calls resolve to the lead; before adoption the second was refused.
        assert.deepStrictEqual(calls, ["allowed", "allowed"]);
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state FROM kin_events ORDER BY event_id`,
          [
            { event_id: "again", state: "done" },
            { event_id: "ask", state: "done" },
          ],
        );
      }).pipe(
        Effect.provide(
          harness({
            entered,
            hold,
            steering,
            onTurn: ({ threadId }) => check(threadId),
            wholeThreadReads,
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("settles a turn that fails at start while a burst steers in, then answers anew", () =>
    Effect.gen(function* () {
      const fixture = {
        entered: yield* Deferred.make<void>(),
        hold: yield* Deferred.make<void>(),
        steering: yield* Deferred.make<void>(),
        failed: true,
      };
      const ended: Array<string> = [];
      const outcomes: Array<string> = [];
      const bridge = Layer.mock(KinReplyBridge)({
        lane: () =>
          Effect.succeedSome({
            chatId: KinChatId.make("owner-chat"),
            mode: "reply" as const,
            owed: true,
            leadName: "Lead",
          }),
        preparing: () => Effect.void,
        begin: () => Effect.void,
        complete: () => Effect.void,
        steered: () => Effect.void,
        end: (input) => Effect.sync(() => void ended.push(input.wakeupId)),
        failed: (input) => Effect.sync(() => void outcomes.push(input.outcome)),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(yield* ownerSays("m00"));
        const fiber = yield* run();
        yield* Deferred.await(fixture.entered);
        for (let n = 1; n <= 10; n++)
          yield* queue.enqueue(yield* ownerSays(`m${String(n).padStart(2, "0")}`));
        yield* Deferred.await(fixture.steering);
        yield* Deferred.succeed(fixture.hold, undefined);
        yield* Fiber.join(fiber);
        const [first] = yield* sql<{ wakeupId: string; threadId: string; status: string }>`
          SELECT wakeup_id AS "wakeupId", thread_id AS "threadId", status FROM kin_wakeups`;
        assert.strictEqual(first!.status, "failed");
        assert.deepStrictEqual([...new Set(ended)], [first!.wakeupId]);
        assert.deepStrictEqual(outcomes, ["retrying"]);
        const projection = yield* threads.getThreadProjection(ThreadId.make(first!.threadId));
        assert.isFalse(projection.runs.some((entry) => entry.status === "queued"));
        assert.deepStrictEqual(yield* sql`SELECT DISTINCT state FROM kin_events ORDER BY state`, [
          { state: "queued" },
        ]);

        fixture.failed = false;
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(
          yield* sql`SELECT status FROM kin_wakeups ORDER BY started_at, wakeup_id`,
          [{ status: "failed" }, { status: "completed" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT DISTINCT state FROM kin_events`, [
          { state: "done" },
        ]);
        assert.lengthOf(new Set(ended), 2);
      }).pipe(Effect.scoped, Effect.provide(harness(fixture).pipe(Layer.provide(bridge))));
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("defers claims while an interrupted run's provider turn is unfinished", () =>
    Effect.gen(function* () {
      yield* seed;
      const queue = yield* KinEventQueue.KinEventQueue;
      const runner = yield* WakeupRunner.WakeupRunner;
      const sql = yield* SqlClient.SqlClient;
      yield* queue.enqueue(event("first"));
      yield* Fiber.join(yield* run());
      const threads = yield* ThreadManagement.ThreadManagementService;
      const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
      const projection = yield* threads.getThreadProjection(ThreadId.make(lead!.thread_id));
      const sink = yield* EventSink.EventSinkV2;
      const turn = projection.providerTurns[0]!;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("unfinished-run"),
            type: "run.updated",
            threadId: projection.thread.id,
            occurredAt,
            payload: { ...projection.runs[0]!, status: "interrupted" },
          },
          {
            id: EventId.make("unfinished-turn"),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            occurredAt,
            payload: { ...turn, status: "running", completedAt: null },
          },
        ],
      });
      yield* queue.enqueue(event("next"));
      const deferred = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
      yield* TestClock.adjust("60 seconds");
      yield* Fiber.join(deferred);
      assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [{ status: "completed" }]);
      assert.deepStrictEqual(
        yield* sql`SELECT state, attempts FROM kin_events WHERE event_id = 'next'`,
        [{ state: "queued", attempts: 0 }],
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("finished-turn"),
            type: "provider-turn.updated",
            threadId: projection.thread.id,
            occurredAt: yield* DateTime.now,
            payload: turn,
          },
        ],
      });
      yield* Fiber.join(yield* run());
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_wakeups`, 2);
    }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect.each(["MemorySyncConflict", "MemoryCheckoutInvalid"] as const)(
    "fails and backs off %s without launching a provider",
    (tag) =>
      Effect.gen(function* () {
        const error =
          tag === "MemorySyncConflict"
            ? new Memory.MemorySyncConflict({ orgId, operation: "sync", reason: "fixture" })
            : new Memory.MemoryCheckoutInvalid({ orgId, operation: "checkout", reason: "fixture" });
        let notified = 0;
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          yield* queue.enqueue(event("memory-failure"));
          const result = yield* Fiber.await(yield* run());
          assert.strictEqual(result._tag, "Failure");
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "queued", attempts: 1 },
          ]);
          assert.deepStrictEqual(yield* sql`SELECT status, thread_id FROM kin_wakeups`, [
            { status: "failed", thread_id: null },
          ]);
          assert.strictEqual(notified, tag === "MemoryCheckoutInvalid" ? 1 : 0);
        }).pipe(
          Effect.provide(
            harness({ prepare: () => Effect.fail(error) }).pipe(
              Layer.provide(
                Layer.succeed(WakeupRunner.KinWakeupHooks, {
                  memoryCheckoutInvalid: () =>
                    Effect.sync(() => {
                      notified++;
                    }),
                }),
              ),
            ),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "clears temporary files at once when a wake-up fails for space and retries it once, telling the owner only when that fails too",
    () =>
      Effect.gen(function* () {
        const told: Array<string> = [];
        const full = new Memory.MemoryError({
          orgId,
          operation: "prepareWakeup",
          cause: PlatformError.systemError({
            _tag: "Unknown",
            module: "FileSystem",
            method: "writeFile",
            pathOrDescriptor: "/tmp/kin-x/config",
            cause: Object.assign(new Error("ENOSPC"), { errno: -28, code: "ENOSPC" }),
          }),
        });
        const care = Layer.succeed(
          KinHostCare,
          KinHostCare.of({
            host: true,
            clean: () => Effect.die("cleaned through spaceFailed"),
            spaceFailed: () =>
              Effect.sync(() => {
                const first = !told.includes("clean out_of_space");
                if (first) told.push("clean out_of_space");
                return first;
              }),
            devFullDisk: Effect.void,
            failed: (input) =>
              Effect.sync(() => {
                told.push(`notice ${input.cause} ${input.eventIds.join(",")}`);
              }),
            succeeded: () => Effect.void,
            troubleOpen: () => Effect.succeed(false),
            causeFor: () => Effect.undefined,
            checkBackup: () => Effect.void,
            status: () => Effect.die("not read here"),
            freeSpace: () => Effect.die("not tapped here"),
            backUpNow: () => Effect.die("not tapped here"),
            retry: () => Effect.die("not tapped here"),
          }),
        );
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          yield* queue.enqueue(event("space"));
          assert.strictEqual((yield* Fiber.await(yield* run()))._tag, "Failure");
          // Cleared, back in the queue at once, no attempt spent, nobody told.
          const firstAt = yield* Clock.currentTimeMillis;
          assert.deepStrictEqual(told, ["clean out_of_space"]);
          assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
            { state: "queued", attempts: 0 },
          ]);
          assert.isAtMost(
            (yield* sql<{
              notBefore: number;
            }>`SELECT not_before AS "notBefore" FROM kin_events`)[0]!.notBefore,
            firstAt,
          );
          // Still full: the owner's notice, and the turn held for when there is space.
          assert.strictEqual((yield* Fiber.await(yield* run()))._tag, "Failure");
          const heldAt = yield* Clock.currentTimeMillis;
          assert.deepStrictEqual(told, ["clean out_of_space", "notice space space"]);
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts, not_before > ${heldAt} AS later FROM kin_events`,
            [{ state: "queued", attempts: 0, later: 1 }],
          );
        }).pipe(
          Effect.provide(harness({ prepare: () => Effect.fail(full) }).pipe(Layer.provide(care))),
        );
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect.each(["released", "shared", "releasing"] as const)(
    "expires retired leads' queued events and ends their durable thread registration (%s)",
    (outcome) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        const releaseEntered = yield* Deferred.make<void>();
        const releaseHold = yield* Deferred.make<void>();
        const releaseDone = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          yield* queue.enqueue(event("first"));
          const active = yield* run();
          yield* Deferred.await(entered);
          yield* queue.enqueue(event("retired"));
          const identity = yield* KinIdentity.KinIdentity;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const [lead] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
          const threadId = ThreadId.make(lead!.thread_id);
          const projection = yield* threads.getThreadProjection(threadId);
          const credentials = yield* McpSessionRegistry.McpSessionRegistry;
          const issued = yield* credentials.issue({
            threadId,
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
          const token = issued.config.authorizationHeader.slice(7);
          const caller = yield* credentials.resolve(token);
          assert.isDefined(caller);
          yield* identity.resolveAgent(caller!);
          yield* sql`UPDATE kin_agents SET retired_at = '2026-11-08T00:00:00.000Z' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          let stops = 0;
          let again = false;
          const retiringRunner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(ThreadManagement.ThreadManagementService, {
              ...threads,
              forceStopThread: Effect.fn("test.forceStopThread")(function* (input) {
                stops++;
                const result = yield* threads.forceStopThread(input);
                if (!again) assert.strictEqual(result.outcome, stops === 1 ? outcome : "released");
                return result;
              }),
            }),
            Effect.provideService(KinIdentity.KinIdentity, {
              ...identity,
              endAgentThread: Effect.fn("test.endAgentThread")(function* (
                input: Parameters<typeof identity.endAgentThread>[0],
              ) {
                const projection = yield* threads
                  .getThreadProjection(input.threadId)
                  .pipe(Effect.orDie);
                assert.isTrue(identity.isAgentThread(input.threadId));
                for (const providerThread of projection.providerThreads)
                  if (providerThread.providerSessionId !== null)
                    assert.strictEqual(
                      yield* sessions.isLive(providerThread.providerSessionId),
                      outcome === "shared",
                    );
                return yield* identity.endAgentThread(input);
              }),
            }),
          );
          const firstPass = yield* retiringRunner.runOnce(orgId, agentId).pipe(Effect.forkChild);
          if (outcome === "releasing") {
            yield* Deferred.await(releaseEntered);
            yield* TestClock.adjust("10 seconds");
          }
          yield* Fiber.join(firstPass);
          assert.strictEqual(identity.isAgentThread(threadId), outcome === "releasing");
          if (outcome === "releasing") {
            assert.isTrue(identity.isAgentThread(threadId));
            assert.lengthOf(yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL`, 1);
            yield* Deferred.succeed(releaseHold, undefined);
            yield* Deferred.await(releaseDone);
          }
          yield* retiringRunner.runOnce(orgId, agentId);
          assert.strictEqual(stops, outcome === "releasing" ? 2 : 1);
          if (outcome === "shared") {
            assert.isTrue(
              yield* sessions.isLive(projection.providerThreads[0]!.providerSessionId!),
            );
            assert.isDefined(yield* credentials.resolve(token));
            const denied = yield* identity.resolveAgent(caller!).pipe(Effect.flip);
            assert.propertyVal(denied, "reason", "not_allowed");
            assert.strictEqual(denied.message, "Kin agent thread is not active.");
          }
          yield* Deferred.succeed(hold, undefined);
          yield* Fiber.join(active);
          assert.deepStrictEqual(
            yield* sql`SELECT state FROM kin_events WHERE event_id = 'retired'`,
            [{ state: "expired" }],
          );
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL AND org_id = ${orgId}`)
              .length,
            0,
          );
          assert.strictEqual((yield* sql`SELECT 1 FROM kin_wakeups`).length, 1);
          if (outcome === "releasing") return;
          // Restored, its next turn starts a fresh thread, since the ended one can't be
          // registered again, and the same runner retires it again on a second retirement.
          yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          yield* queue.enqueue(event("restored"));
          yield* TestClock.adjust("20 seconds");
          yield* retiringRunner.runOnce(orgId, agentId);
          const [fresh] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kin_leads`;
          assert.notStrictEqual(fresh?.thread_id, threadId);
          assert.deepStrictEqual(
            yield* sql`SELECT state FROM kin_events WHERE event_id = 'restored'`,
            [{ state: "done" }],
          );
          again = true;
          yield* sql`UPDATE kin_agents SET retired_at = '2026-11-09T00:00:00.000Z' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          yield* retiringRunner.runOnce(orgId, agentId);
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM kin_agent_threads WHERE ended_at IS NULL AND org_id = ${orgId}`)
              .length,
            0,
          );
        }).pipe(
          Effect.provide(
            harness({
              entered,
              hold,
              ...(outcome === "shared" ? { sharedWith: [ThreadId.make("sibling")] } : {}),
              ...(outcome === "releasing" ? { releaseEntered, releaseHold, releaseDone } : {}),
            }),
          ),
        );
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "recovers other organizations while keeping a recovered active run claimed until completion",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const hold = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* seed;
          const queue = yield* KinEventQueue.KinEventQueue;
          const sql = yield* SqlClient.SqlClient;
          const wakeupId = KinWakeupId.make("recovery-active");
          yield* queue.enqueue(event("active"));
          yield* TestClock.adjust("20 seconds");
          yield* Effect.scoped(queue.claim({ orgId, agentId, wakeupId, model: "test" }));
          const launch = yield* ThreadLaunch.ThreadLaunchService;
          const sent = yield* launch.launch({
            commandId: CommandId.make(`kin-wakeup:${wakeupId}`),
            projectId: ProjectId.make("kin:org"),
            title: "Lead",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-opus-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`kin-wakeup-msg:${wakeupId}`),
              text: "Wake up",
              attachments: [],
            },
            createdBy: "system",
            creationSource: "server",
          });
          yield* sql`UPDATE kin_leads SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
          yield* sql`UPDATE kin_wakeups SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
          yield* Deferred.await(entered);
          yield* sql`INSERT INTO kin_orgs VALUES ('other-org', 'Other', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES ('other-owner', 'other-org', 'owner', 'Owner', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
            VALUES ('other-lead', 'other-org', 'Lead', 'lead', 'other-owner', '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
            VALUES ('other-chat', 'other-org', 'team_group', 0, '2026-11-08T00:00:00.000Z')`;
          yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
            SELECT 'other-lead', 'other-org', 'Lead', 0, models_json, '[]', 'other-chat' FROM kin_leads WHERE agent_id = ${agentId}`;
          yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
            VALUES ('other-abandoned', 'other-org', 'other-lead', 'test', 0, 'running', '[]')`;
          const reconciled = yield* Deferred.make<void>();
          const runner = yield* WakeupRunner.WakeupRunner.pipe(
            Effect.provide(Layer.fresh(WakeupRunner.layer)),
            Effect.provideService(KinEventQueue.KinEventQueue, {
              ...queue,
              requeueUnfinished: Effect.fn("test.requeueUnfinished")(function* (org, wakeup) {
                const count = yield* queue.requeueUnfinished(org, wakeup);
                yield* Deferred.succeed(reconciled, undefined);
                return count;
              }),
            }),
          );
          const recovered = yield* runner.recover.pipe(Effect.forkChild);
          yield* Deferred.await(reconciled);
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM kin_wakeups WHERE wakeup_id = 'other-abandoned'`,
            [{ status: "interrupted" }],
          );
          yield* sql`DELETE FROM kin_wakeups WHERE wakeup_id = 'other-abandoned'`;
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "claimed" }]);
          assert.isUndefined(recovered.pollUnsafe());
          yield* Deferred.succeed(hold, undefined);
          yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
          yield* Fiber.join(recovered);
          assert.deepStrictEqual(yield* sql`SELECT status FROM kin_wakeups`, [
            { status: "completed" },
          ]);
          yield* runner.recover;
          assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "done" }]);
        }).pipe(Effect.provide(harness({ entered, hold })));
      }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("launches other leads while the org loop still waits on a recovered run", () =>
    Effect.gen(function* () {
      const holdRunning = yield* Deferred.make<void>();
      const enteredThreads = yield* Queue.unbounded<ThreadId>();
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const wakeupId = KinWakeupId.make("left-running");
        yield* queue.enqueue(event("recovered"));
        yield* TestClock.adjust("20 seconds");
        // A wake-up a previous process left running, its provider run still going.
        yield* Effect.scoped(queue.claim({ orgId, agentId, wakeupId, model: "test" }));
        const sent = yield* (yield* ThreadLaunch.ThreadLaunchService).launch({
          commandId: CommandId.make(`kin-wakeup:${wakeupId}`),
          projectId: ProjectId.make("kin:org"),
          title: "Lead",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-4-6",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`kin-wakeup-msg:${wakeupId}`),
            text: "Wake up",
            attachments: [],
          },
          createdBy: "system",
          creationSource: "server",
        });
        yield* sql`UPDATE kin_leads SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
        yield* sql`UPDATE kin_wakeups SET thread_id = ${sent.threadId} WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}`;
        assert.strictEqual(yield* Queue.take(enteredThreads), sent.threadId);
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          SELECT 'lead-z', org_id, display_name, role, owner_person_id, created_at FROM kin_agents WHERE agent_id = 'lead'`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          SELECT 'lead-z', org_id, name, level_since, models_json, worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = 'lead'`;
        yield* queue.enqueue({ ...event("other"), agentId: KinAgentId.make("lead-z") });
        yield* (yield* WakeupRunner.WakeupRunner).start;
        yield* TestClock.adjust("20 seconds");
        assert.notStrictEqual(yield* Queue.take(enteredThreads), sent.threadId);
        assert.deepStrictEqual(
          yield* sql`SELECT agent_id FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running' ORDER BY agent_id`,
          [{ agent_id: "lead" }, { agent_id: "lead-z" }],
        );
      }).pipe(
        Effect.provide(
          harness({
            holdRunning,
            onTurn: ({ threadId }) => Queue.offer(enteredThreads, threadId).pipe(Effect.asVoid),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect(
    "releases an organization paused during the quiet window without consuming an attempt",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        const sql = yield* SqlClient.SqlClient;
        yield* queue.enqueue(event("paused"));
        const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");
        yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by) VALUES (${orgId}, 1, 1000, 'owner')`;
        yield* TestClock.adjust("19 seconds");
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(yield* sql`SELECT state, attempts FROM kin_events`, [
          { state: "queued", attempts: 0 },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT status, thread_id FROM kin_wakeups`, [
          { status: "released", thread_id: null },
        ]);
        yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL WHERE org_id = ${orgId}`;
        yield* Fiber.join(yield* run());
        assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events`, [{ state: "done" }]);
      }).pipe(Effect.provide(harness()), provideDeterministicTestRuntime),
  );

  it.effect("keeps an org loop alive after a one-shot defect", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<void>();
      const continued = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.gen(function* () {
        yield* seed;
        const queue = yield* KinEventQueue.KinEventQueue;
        const runner = yield* WakeupRunner.WakeupRunner;
        yield* runner.start;
        yield* queue.enqueue(event("defect"));
        yield* TestClock.adjust("20 seconds");
        yield* Deferred.await(failed);
        yield* queue.enqueue(event("after-defect"));
        yield* TestClock.adjust("21 seconds");
        yield* Deferred.await(continued);
        assert.strictEqual(calls, 2);
      }).pipe(
        Effect.provide(
          harness({
            prepare: () =>
              Effect.gen(function* () {
                if (++calls === 1) {
                  yield* Deferred.succeed(failed, undefined);
                  return yield* Effect.die("one-shot defect");
                }
                yield* Deferred.succeed(continued, undefined);
                return yield* Effect.never;
              }),
          }),
        ),
      );
    }).pipe(provideDeterministicTestRuntime),
  );

  it.effect("contains Kin startup failures while building the non-Kin server runtime", () => {
    class Core extends Context.Service<Core, { readonly ready: boolean }>()(
      "t3/kin/lead/WakeupRunner.test/Core",
    ) {}
    return Effect.gen(function* () {
      yield* seed;
      const failing = KinLead.layer.pipe(
        Layer.provide(
          Layer.mock(KinIdentity.KinIdentity)({
            owner: { _tag: "person", orgId, personId: KinPersonId.make("owner") },
            isAgentThread: () => false,
            isLeadThread: () => false,
          }),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ChatService.KinChatService)({}),
            Layer.mock(KinRecords.KinRecords)({}),
            Layer.mock(ChatHub.KinChatHub)({}),
            Layer.mock(LevelGate.KinLevelGate)({}),
            Layer.mock(Presence.KinPresence)({
              snapshot: () => Effect.succeed({ presence: [], drafts: [] }),
              lines: () => [],
            }),
            Layer.mock(Budget.KinBudget)({}),
            Layer.mock(KinStop.KinStop)({}),
            Layer.mock(KinEventQueue.KinEventQueue)({}),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(KinIssuedTokens.KinIssuedTokens)({}),
            Layer.mock(KinLeadPrompt)({ build: () => Effect.succeed("unused") }),
            Layer.mock(DocumentText.DocumentText)({}),
            ServerConfig.layerTest(process.cwd(), { prefix: "kin-startup-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            Layer.effect(MemoryConfig.MemoryConfig, Effect.die("invalid memory config")),
            Layer.mock(VcsProcess.VcsProcess)({}),
            NodeServices.layer,
          ),
        ),
      );
      assert.strictEqual((yield* Layer.build(failing).pipe(Effect.exit))._tag, "Failure");
      const runtime = Layer.mergeAll(
        Layer.succeed(Core, { ready: true }),
        KinLead.containStartup(failing),
      );
      const context = yield* Layer.build(runtime);
      assert.isTrue(Context.get(context, Core).ready);
      const defect = Layer.mergeAll(
        Layer.succeed(Core, { ready: true }),
        KinLead.containStartup(Layer.effectDiscard(Effect.die("Kin layer defect"))),
      );
      assert.isTrue(Context.get(yield* Layer.build(defect), Core).ready);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpSessionRegistryTestkit.layer,
          KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
        ),
      ),
    );
  });
});
