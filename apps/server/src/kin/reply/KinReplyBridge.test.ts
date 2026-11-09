import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EventId,
  KinAgentId,
  KinChatId,
  KinWakeupId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as ReplyBridge from "./KinReplyBridge.ts";

const threadId = ThreadId.make("lead-thread");
const agentId = KinAgentId.make("lead");
const rescueRunId = RunId.make("rescue-run");

const layer = Kin.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(environment),
  Layer.provideMerge(authorityLayer),
);

type Fake = {
  readonly live: Queue.Queue<OrchestrationV2DomainEvent>;
  items: ReadonlyArray<OrchestrationV2TurnItem>;
  rescueItems: ReadonlyArray<OrchestrationV2TurnItem>;
  rescues: number;
};

// The lead thread as the bridge sees it: the real wake-up run, with turn items the test scripts.
const fakeThreads = (fake: Fake, wakeupId: KinWakeupId) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projection = Effect.gen(function* () {
        const real = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
        const root = real.runs.at(-1)!;
        const rescue = {
          ...root,
          id: rescueRunId,
          ordinal: root.ordinal + 1,
          userMessageId: MessageId.make(ReplyBridge.rescueMessageId(wakeupId)),
        };
        return {
          ...real,
          runs: fake.rescues === 0 ? real.runs : [...real.runs, rescue],
          turnItems: [...fake.items, ...(fake.rescues === 0 ? [] : fake.rescueItems)],
        };
      });
      return Layer.mock(ThreadManagement.ThreadManagementService)({
        streamDomainEvents: Stream.fromQueue(fake.live),
        getThreadProjection: () => projection,
        sendToThread: () =>
          Effect.gen(function* () {
            fake.rescues++;
            const current = yield* projection;
            return {
              dispatch: { sequence: 0, storedEvents: [] },
              projection: current,
              message: current.messages[0]!,
              run: current.runs.at(-1)!,
              turnItem: null,
              delivery: "queued" as const,
            };
          }),
        waitForThread: () => Effect.succeed({ threadId, run: null, timedOut: false }),
      });
    }),
  );

const at = DateTime.makeUnsafe(0);
const base = (id: string, ordinal: number, runId: RunId) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const text = (
  id: string,
  ordinal: number,
  body: string,
  runId: RunId,
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, runId),
  type: "assistant_message",
  messageId: MessageId.make(`assistant:${id}`),
  text: body,
  streaming: false,
});
const tool = (
  id: string,
  ordinal: number,
  name: string,
  runId: RunId,
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, runId),
  type: "dynamic_tool",
  toolName: name,
  input: {},
});
const itemEvent = (item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:${item.id}`),
  threadId,
  occurredAt: at,
  type: "turn-item.updated",
  payload: item,
});

/** A lead at `level` with its direct chat; `ask` is an owner message that wakes it. */
const setup = Effect.fn("test.setup")(function* (input: {
  readonly level?: "L0" | "L1";
  readonly ask?: string;
  readonly lane?: "direct" | "group";
}) {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* identity.resolve({
    sessionId: AuthSessionId.make("owner"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  });
  const owner = person!;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${agentId}, ${owner.orgId}, 'Lead', 'lead', ${owner.personId}, '1970-01-01T00:00:00.000Z')`;
  yield* identity.registerAgentThread({ orgId: owner.orgId, agentId, threadId });
  const direct = yield* chats.createDirect(owner, { orgId: owner.orgId, agentId });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${owner.orgId}, 'Ada', ${input.level ?? "L1"}, 0, '{}', '[]', ${direct.chatId})`;
  let chatId = direct.chatId;
  if (input.lane === "group") {
    chatId = KinChatId.make("group");
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('group', ${owner.orgId}, 'team_group', 0, '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('group-owner', ${owner.orgId}, 'group', 'person', ${owner.personId}, 'owner', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at) VALUES ('group-lead', ${owner.orgId}, 'group', 'agent', ${agentId}, 'member', '1970-01-01T00:00:00.000Z')`;
  }
  const message =
    input.ask === undefined
      ? undefined
      : yield* chats.send(owner, { chatId, body: input.ask, clientMessageId: "ask" });
  const wakeupId = KinWakeupId.make(
    yield* startAgentWakeup({
      orgId: owner.orgId,
      agentId,
      threadId,
      ...(message === undefined ? {} : { message }),
    }),
  );
  const [row] = yield* sql<{ runId: string; startedAt: number }>`
    SELECT run_id AS "runId", started_at AS "startedAt" FROM kin_wakeups WHERE wakeup_id = ${wakeupId}`;
  const fake: Fake = {
    live: yield* Queue.unbounded<OrchestrationV2DomainEvent>(),
    items: [],
    rescueItems: [],
    rescues: 0,
  };
  const context = yield* Layer.build(
    ReplyBridge.layer.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeedContext(services), fakeThreads(fake, wakeupId))),
    ),
  );
  const bridge = Context.get(context, ReplyBridge.KinReplyBridge);
  const runId = RunId.make(row!.runId);
  yield* bridge.begin({
    orgId: owner.orgId,
    agentId,
    wakeupId,
    threadId,
    startedAt: row!.startedAt,
  });
  const projectId = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
    .thread.projectId;
  const complete = bridge.complete({
    orgId: owner.orgId,
    wakeupId,
    projectId,
    rootRunId: runId,
    rescueUntil: Number.MAX_SAFE_INTEGER,
  });
  const posted = sql<{
    body: string;
    authorKind: string;
    intent: string | null;
    floorRunId: string | null;
  }>`SELECT body, author_kind AS "authorKind", intent, floor_run_id AS "floorRunId" FROM kin_messages
    WHERE org_id = ${owner.orgId} AND chat_id = ${chatId} AND author_kind != 'human' ORDER BY seq`;
  return {
    services,
    owner,
    chats,
    identity,
    sql,
    bridge,
    fake,
    runId,
    wakeupId,
    chatId,
    direct,
    message,
    complete,
    posted,
  };
});

it.effect("posts the lead run's plain text to the chat it answers, as one agent turn", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, message, sql } = yield* setup({ ask: "Is CI green?" });
    fake.items = [
      text("a", 1, "Yes, CI is green on main.", runId),
      text("b", 2, "The flaky test passed twice.", runId),
    ];
    yield* complete;
    const rows = yield* posted;
    assert.deepStrictEqual(
      rows.map((row) => [row.body, row.authorKind, row.intent]),
      [
        ["Yes, CI is green on main.", "agent", "answer"],
        ["The flaky test passed twice.", "agent", "answer"],
      ],
    );
    const [run] = yield* sql<{ runId: string; turns: number }>`
      SELECT run_id AS "runId", agent_turns AS turns FROM kin_floor_runs
      WHERE opened_by = ${message!.messageId} ORDER BY run_id`;
    assert.deepStrictEqual(
      rows.map((row) => row.floorRunId),
      [run!.runId, run!.runId],
    );
    assert.strictEqual(run!.turns, 1);
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("shows a short note before a tool call only on the presence line", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, bridge, owner, wakeupId, services } = yield* setup({
      ask: "Remind me Friday",
    });
    const all = yield* Context.get(services, KinChatHub).subscribeAll;
    const note = text("a", 1, "Checking your reminders", runId);
    const call = tool("b", 2, "mcp__kin__kin_defer", runId);
    const answer = text("c", 3, "Done: I'll remind you Friday at 9:00.", runId);
    const labels = yield* all.pipe(
      Stream.filterMap((event) =>
        event.type === "presence.updated" && event.presence !== null
          ? Result.succeed(event.presence.label)
          : Result.failVoid,
      ),
      Stream.takeUntil((label) => label === "Checking your reminders"),
      Stream.runCollect,
      Effect.forkScoped,
    );
    for (const item of [note, call]) yield* Queue.offer(fake.live, itemEvent(item));
    assert.include(yield* Fiber.join(labels), "Checking your reminders");
    fake.items = [note, call, answer];
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      ["Done: I'll remind you Friday at 9:00."],
    );
    const cleared = yield* all.pipe(
      Stream.filter((event) => event.type === "presence.updated" && event.presence === null),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* bridge.end(owner.orgId, wakeupId);
    assert.lengthOf(yield* Fiber.join(cleared), 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("shadows an L0 lead's reply outside its owner's chat", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, sql, owner } = yield* setup({
      level: "L0",
      lane: "group",
      ask: "Team, status?",
    });
    fake.items = [text("a", 1, "Two PRs are waiting on review.", runId)];
    yield* complete;
    assert.deepStrictEqual(yield* posted, []);
    assert.deepStrictEqual(
      yield* sql`SELECT tool, would_target AS target FROM kin_shadow_entries WHERE org_id = ${owner.orgId} ORDER BY created_at`,
      [{ tool: "reply", target: "group" }],
    );
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("posts nothing in a chat where the lead is muted", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, sql, owner, chatId } = yield* setup({ ask: "Hi" });
    yield* sql`UPDATE kin_chat_members SET muted_until = '2100-01-01T00:00:00.000Z'
      WHERE org_id = ${owner.orgId} AND chat_id = ${chatId} AND agent_id = ${agentId}`;
    fake.items = [text("a", 1, "Hello!", runId)];
    yield* complete;
    assert.deepStrictEqual(yield* posted, []);
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds one wake-up to eight messages in a chat, kin_chat_post included", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, identity, chats, owner, wakeupId, chatId } =
      yield* setup({ ask: "Tell me everything" });
    const paragraph = (n: number) => `Part ${n}. ${"Detail ".repeat(40).trim()}`;
    fake.items = Array.from({ length: 12 }, (_, n) => text(`p${n}`, n + 1, paragraph(n), runId));
    yield* complete;
    const rows = yield* posted;
    assert.lengthOf(rows, 8);
    assert.strictEqual(rows[6]!.body, paragraph(6));
    assert.include(rows[7]!.body, "Part 7.");
    assert.include(rows[7]!.body, "Part 11.");
    const lead = Option.getOrThrow(
      yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
    );
    const extra = yield* chats
      .send(lead, { chatId, body: "One more", clientMessageId: "extra", intent: "answer" })
      .pipe(Effect.flip);
    assert.include(extra, { reason: "limit" });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { rescue: [], expected: ["system:Ada didn't reply. Send your message again to ask again."] },
  {
    rescue: ["Sorry, here it is: the deploy is done."],
    expected: ["agent:Sorry, here it is: the deploy is done."],
  },
])("rescues a run that owed a reply once, then says so (%#)", ({ rescue, expected }) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted } = yield* setup({ ask: "Did the deploy finish?" });
    // NO_REPLY can't answer an owner's message.
    fake.items = [text("a", 1, "NO_REPLY", runId)];
    fake.rescueItems = rescue.map((body, n) => text(`r${n}`, 10 + n, body, rescueRunId));
    yield* complete;
    assert.strictEqual(fake.rescues, 1);
    assert.deepStrictEqual(
      (yield* posted).map((row) => `${row.authorKind}:${row.body}`),
      expected,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { ask: "Thanks, that's all for today.", rescues: 0, expected: [] },
  {
    ask: "Did the deploy finish?",
    rescues: 1,
    expected: ["system:Ada didn't reply. Send your message again to ask again."],
  },
])(
  "a lead's 👍 is its reply only when the owner asked nothing (%#)",
  ({ ask, rescues, expected }) =>
    Effect.gen(function* () {
      const { identity, chats, owner, wakeupId, message, complete, fake, posted } = yield* setup({
        ask,
      });
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
      );
      yield* chats.react(lead, { messageId: message!.messageId, emoji: "👍", on: true });
      yield* complete;
      assert.strictEqual(fake.rescues, rescues);
      assert.deepStrictEqual(
        (yield* posted).map((row) => `${row.authorKind}:${row.body}`),
        expected,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["CI is red on main since 9:00.", "NO_REPLY"])(
  "sends a notice wake-up's text to the owner's chat, or nothing on NO_REPLY (%s)",
  (body) =>
    Effect.gen(function* () {
      const { fake, runId, complete, sql, owner, direct } = yield* setup({});
      fake.items = [text("a", 1, body, runId)];
      yield* complete;
      const rows = yield* sql<{ body: string; intent: string | null; floorRunId: string | null }>`
        SELECT body, intent, floor_run_id AS "floorRunId" FROM kin_messages
        WHERE org_id = ${owner.orgId} AND chat_id = ${direct.chatId} ORDER BY seq`;
      assert.deepStrictEqual(
        rows,
        body === "NO_REPLY" ? [] : [{ body, intent: "evidence", floorRunId: null }],
      );
      assert.strictEqual(fake.rescues, 0);
    }).pipe(Effect.provide(layer)),
);
