import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EventId,
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
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
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import { KinGroups } from "../chat/KinGroups.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as ChatWake from "../lead/ChatWake.ts";
import { draftReplyText, SILENCE_MARKERS, stripTrailingSilenceMarker } from "./classify.ts";
import { KinPresence } from "./KinPresence.ts";
import * as ReplyBridge from "./KinReplyBridge.ts";

const threadId = ThreadId.make("lead-thread");
const agentId = KinAgentId.make("lead");
const rescueRunId = RunId.make("rescue-run");

const layer = Kin.layer.pipe(
  Layer.provide(kinSecretsTest),
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

const turnEvent = (id: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(`event:turn:${id}`),
  threadId,
  occurredAt: at,
  type: "provider-turn.updated",
  payload: {
    id: ProviderTurnId.make("turn"),
    providerThreadId: ProviderThreadId.make("provider-thread"),
    nodeId: NodeId.make("node"),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: at,
    completedAt: null,
  },
});

/** A lead at `level` with its direct chat; `ask` is an owner message that wakes it. */
const setup = Effect.fn("test.setup")(function* (input: {
  readonly level?: "L0" | "L1";
  readonly ask?: string;
  /**
   * `own-group`: a group the owner owns, with no one else in it yet; `shared-group`: the same,
   * shared with `mate` before the ask, and the wake-up a shared turn begun after.
   */
  readonly lane?: "direct" | "group" | "own-group" | "shared-group";
  readonly reaction?: "👍";
  readonly changedFrom?: "👎";
}) {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(AuthSessionId.make("owner"));
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
    // Someone else's group: the lead's owner is only a member, so the owner did not place it.
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('other', ${owner.orgId}, 'other', 'Other', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('group-other', ${owner.orgId}, 'group', 'person', 'other', 'owner', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('group-owner', ${owner.orgId}, 'group', 'person', ${owner.personId}, 'member', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at) VALUES ('group-lead', ${owner.orgId}, 'group', 'agent', ${agentId}, 'member', '1970-01-01T00:00:00.000Z')`;
  }
  if (input.lane === "own-group" || input.lane === "shared-group") {
    chatId = KinChatId.make("group");
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at) VALUES ('group', ${owner.orgId}, 'team_group', 'Launch', 0, '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('mate', ${owner.orgId}, 'mate', 'Mate', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at) VALUES ('group-owner', ${owner.orgId}, 'group', 'person', ${owner.personId}, 'owner', '1970-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at) VALUES ('group-lead', ${owner.orgId}, 'group', 'agent', ${agentId}, 'member', '1970-01-01T00:00:00.000Z')`;
  }
  if (input.lane === "shared-group") {
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at, joined_seq) VALUES ('group-mate', ${owner.orgId}, 'group', 'person', 'mate', 'member', '1970-01-01T00:00:00.000Z', 1)`;
    yield* sql`UPDATE kin_chats SET shared_at = -1, shared_from_seq = 1 WHERE chat_id = 'group'`;
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
      ...(input.reaction === undefined ? {} : { reaction: input.reaction }),
      ...(input.changedFrom === undefined ? {} : { changedFrom: input.changedFrom }),
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

it.effect("labels each phase of a wake-up once per change and clears when the reply settles", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, bridge, owner, wakeupId, services, sql, direct } =
      yield* setup({ ask: "Remind me Friday" });
    const presence = Context.get(services, KinPresence);
    const shown = () =>
      presence
        .lines(owner.orgId, direct.chatId)
        .map((line) => [line.state, line.label, line.wakeupId]);
    // Begun, before the model starts: never `seen`.
    assert.deepStrictEqual(shown(), [["starting", "Catching up", wakeupId]]);
    const updates = yield* Queue.unbounded<string | null>();
    const all = yield* Context.get(services, KinChatHub).subscribeAll;
    yield* all.pipe(
      Stream.runForEach((event) =>
        event.type === "presence.updated"
          ? Queue.offer(updates, event.presence?.label ?? null)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    const note = text("a", 1, "Checking your reminders", runId);
    const call = tool("b", 2, "mcp__kin__kin_defer", runId);
    const calling = { ...call, status: "running" } as OrchestrationV2TurnItem;
    const answer = text("c", 3, "Done: I'll remind you Friday at 9:00.", runId);
    const streaming = (body: string) =>
      ({ ...answer, text: body, streaming: true }) as OrchestrationV2TurnItem;
    // Repeats of a phase (a second turn update, the tool's progress, each text delta) send nothing.
    for (const event of [
      turnEvent("1"),
      turnEvent("2"),
      itemEvent(note),
      itemEvent(calling),
      itemEvent(calling),
      itemEvent(call),
      itemEvent(streaming("Done:")),
      itemEvent(streaming("Done: I'll remind")),
    ])
      yield* Queue.offer(fake.live, event);
    // The model's own note before the call is never the label: the table's words are.
    assert.deepStrictEqual(yield* Queue.takeN(updates, 4), [
      "Thinking",
      "Setting a reminder",
      "Thinking",
      "Writing",
    ]);
    fake.items = [note, call, answer];
    yield* complete;
    // The reply is settled: what the wake-up does next isn't work on the owner's message.
    assert.strictEqual(yield* Queue.take(updates), null);
    // A late event after settle doesn't bring the line back.
    yield* Queue.offer(fake.live, itemEvent(calling));
    yield* Queue.offer(fake.live, turnEvent("3"));
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      ["Done: I'll remind you Friday at 9:00."],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT first_token_at IS NOT NULL AS "firstToken", posted_at IS NOT NULL AS posted
        FROM kin_wakeups WHERE org_id = ${owner.orgId} AND wakeup_id = ${wakeupId} ORDER BY wakeup_id`,
      [{ firstToken: 1, posted: 1 }],
    );
    yield* bridge.end({ orgId: owner.orgId, agentId, wakeupId });
    assert.deepStrictEqual(shown(), []);
    // A wake-up's line wins over a queue line, and a queue line's relabel keeps its start.
    yield* presence.queued(owner.orgId, direct.chatId, agentId, "Catching up", 0);
    yield* presence.queued(owner.orgId, direct.chatId, agentId, "Finishing something else", 5_000);
    assert.deepStrictEqual(
      presence.lines(owner.orgId, direct.chatId).map((line) => [line.label, line.startedAt]),
      [["Finishing something else", "1970-01-01T00:00:00.000Z"]],
    );
    // A wake-up that ends before it begins drops the queue line where no message waits any more.
    yield* bridge.end({ orgId: owner.orgId, agentId, wakeupId: KinWakeupId.make("never-began") });
    assert.deepStrictEqual(shown(), []);
    assert.strictEqual(yield* Queue.size(updates), 3);
  }).pipe(Effect.provide(layer)),
);

it.effect("holds a claimed wake-up's line from its claim, and drops it if it never begins", () =>
  Effect.gen(function* () {
    const { bridge, owner, services, direct } = yield* setup({ ask: "Hi" });
    const presence = Context.get(services, KinPresence);
    const shown = () => presence.lines(owner.orgId, direct.chatId).map((line) => line.wakeupId);
    const next = KinWakeupId.make("next");
    const lane = { chatId: direct.chatId, mode: "reply", leadName: "Ada" } as const;
    yield* bridge.preparing({ orgId: owner.orgId, agentId, wakeupId: next, lane, startedAt: 0 });
    assert.deepStrictEqual(shown(), [next]);
    yield* bridge.end({ orgId: owner.orgId, agentId, wakeupId: next });
    assert.deepStrictEqual(shown(), []);
  }).pipe(Effect.provide(layer)),
);

const thought = (id: string, ordinal: number, runId: RunId): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, runId),
  type: "reasoning",
  text: "Thinking",
  streaming: false,
});
const githubAnswer =
  "GitHub access works now: GLDRoger/t3code has one open PR (#87, the live status change), its checks are green and it waits on one review. The last Actions run on kin passed. I cancelled the old reminder to retry GitHub, since you no longer need it. Tell me if you want me to watch #87.";
const secondAnswer = `GitHub works now. I can read GLDRoger/t3code myself: ${"one open PR, green checks, ".repeat(20)}`;

it.effect.each([
  {
    name: "the reply, kin_end, then the same answer again",
    items: (runId: RunId) => [
      tool("t1", 1, "mcp__kin__kin_github_repos", runId),
      thought("r1", 2, runId),
      tool("t2", 3, "mcp__kin__kin_github_prs", runId),
      thought("r2", 4, runId),
      tool("t3", 5, "mcp__kin__kin_cancel", runId),
      tool("t4", 6, "mcp__kin__kin_github_runs", runId),
      thought("r3", 7, runId),
      tool("t5", 8, "mcp__kin__kin_journal", runId),
      text("a", 9, githubAnswer, runId),
      tool("end", 10, "mcp__kin__kin_end", runId),
      text("b", 11, secondAnswer, runId),
    ],
    expected: [githubAnswer],
  },
  {
    name: "a short reply right before kin_end is the reply, not a status note",
    items: (runId: RunId) => [
      text("a", 1, "Done: deferred to Fri 9:00.", runId),
      tool("end", 2, "mcp__kin__kin_end", runId),
      text("b", 3, secondAnswer, runId),
    ],
    expected: ["Done: deferred to Fri 9:00."],
  },
  {
    name: "kin_end with nothing posted, then the reply",
    items: (runId: RunId) => [
      tool("t1", 1, "mcp__kin__kin_journal", runId),
      tool("end", 2, "mcp__kin__kin_end", runId),
      text("a", 3, "CI is green on main.", runId),
    ],
    expected: ["CI is green on main."],
  },
])("a lead replies once: nothing posts after a reply and kin_end ($name)", ({ items, expected }) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted } = yield* setup({ ask: "Try now" });
    fake.items = items(runId);
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      expected,
    );
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("never streams a message the lead starts after its reply and kin_end", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, services, owner, chatId } = yield* setup({
      ask: "Try now",
    });
    const all = yield* Context.get(services, KinChatHub).subscribeAll;
    const answer = text("a", 1, githubAnswer, runId);
    const end = tool("end", 2, "mcp__kin__kin_end", runId);
    const again = text("b", 3, secondAnswer, runId);
    const seen = yield* all.pipe(
      Stream.filter((event) => event.type === "presence.updated" && event.presence !== null),
      Stream.takeUntil(
        (event) =>
          event.type === "presence.updated" && event.presence?.label === "Setting a reminder",
      ),
      Stream.runCollect,
      Effect.forkScoped,
    );
    // The running call after it is the sync point: by then the streamed text was handled.
    const call = { ...tool("t", 4, "mcp__kin__kin_defer", runId), status: "running" as const };
    for (const item of [answer, end, { ...again, streaming: true }, call])
      yield* Queue.offer(fake.live, itemEvent(item));
    const events = yield* Fiber.join(seen);
    assert.deepStrictEqual(
      (yield* Context.get(services, KinPresence).snapshot(owner.orgId, chatId)).drafts,
      [],
    );
    assert.isFalse(
      events.some(
        (event) => event.type === "presence.updated" && event.presence?.state === "writing",
      ),
    );
    fake.items = [answer, end, again];
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      [githubAnswer],
    );
  }).pipe(Effect.provide(layer)),
);

// A turn built for the owner alone streams nothing more once a teammate can read its chat.
it.effect("a teammate joining mid-draft sees none of it, and the draft ends unsent", () =>
  Effect.gen(function* () {
    const { fake, runId, bridge, owner, services, chats, chatId, wakeupId, sql } = yield* setup({
      lane: "own-group",
      ask: "Plan the launch",
    });
    const hub = Context.get(services, KinChatHub);
    const presence = Context.get(services, KinPresence);
    const mate = {
      _tag: "person",
      orgId: owner.orgId,
      personId: KinPersonId.make("mate"),
    } as const;
    const isSentinel = (event: KinChatHubEvent) =>
      event.type === "message.posted" && event.message.body === "Sentinel";
    const untilSentinel = <E>(stream: Stream.Stream<KinChatHubEvent, E>) =>
      stream.pipe(Stream.takeUntil(isSentinel), Stream.runCollect, Effect.forkScoped);
    // One subscription each: a subscription's events go to whichever consumer takes them.
    const everything = yield* untilSentinel(yield* hub.subscribeAll);
    const toMate = yield* untilSentinel(yield* hub.subscribeForViewer(mate));
    const firstDraft = yield* (yield* hub.subscribeAll).pipe(
      Stream.filter((event) => event.type === "draft.updated" && event.draft.text !== ""),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const labelled = yield* (yield* hub.subscribeAll).pipe(
      Stream.filter(
        (event) =>
          event.type === "presence.updated" && event.presence?.label === "Setting a reminder",
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const answer = text("a", 1, "", runId);
    const streaming = (body: string) =>
      itemEvent({ ...answer, text: body, streaming: true } as OrchestrationV2TurnItem);
    // Long enough to stream as a draft at once rather than wait to see if it is a short note, and
    // past the first throttle window, so each delta below is sent as it arrives.
    yield* TestClock.adjust("1 second");
    const plan = `Invented private plan: ${"step after step, ".repeat(10)}`;
    yield* Queue.offer(fake.live, streaming(plan));
    yield* Fiber.join(firstDraft);
    const groups = Context.get(services, KinGroups);
    yield* groups.addMember([owner], {
      chatId,
      principal: { _tag: "person", personId: mate.personId },
    });
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_wakeups WHERE wakeup_id = ${wakeupId} AND aborted_at IS NOT NULL`,
      1,
    );
    // Past the throttle again, so the next delta is sent at once; the running call after it syncs.
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(fake.live, streaming(`${plan}with the owner's notes`));
    yield* Queue.offer(
      fake.live,
      itemEvent({ ...tool("t", 2, "mcp__kin__kin_defer", runId), status: "running" }),
    );
    yield* Fiber.join(labelled);
    assert.deepStrictEqual((yield* presence.snapshot(owner.orgId, chatId)).drafts, []);
    yield* bridge.abort(owner.orgId, wakeupId);
    yield* chats.send(owner, { chatId, body: "Sentinel", clientMessageId: "sentinel" });
    const drafts = (yield* Fiber.join(everything)).filter(
      (event): event is Extract<KinChatHubEvent, { type: "draft.updated" }> =>
        event.type === "draft.updated",
    );
    // The owner's view ends the draft it saw; nothing past the join is sent to anyone.
    assert.deepStrictEqual(
      drafts.map((event) => [event.draft.text, event.draft.end !== undefined, event.personId]),
      [
        [plan, false, undefined],
        ["", true, owner.personId],
      ],
    );
    assert.isFalse((yield* Fiber.join(toMate)).some((event) => event.type === "draft.updated"));
  }).pipe(Effect.provide(layer)),
);

// Review of cc5b670e33: a shared turn read the group from its latest join; a later one aborts it.
it.effect("someone joining a shared group mid-draft sees none of it, and the turn is aborted", () =>
  Effect.gen(function* () {
    const { fake, runId, owner, services, chatId, wakeupId, sql } = yield* setup({
      lane: "shared-group",
      ask: "Plan the launch",
    });
    yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = ${wakeupId}`;
    const hub = Context.get(services, KinChatHub);
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('pat', ${owner.orgId}, 'pat', 'Pat', '1970-01-01T00:00:00.000Z')`;
    const pat = { _tag: "person", orgId: owner.orgId, personId: KinPersonId.make("pat") } as const;
    const toPat = yield* (yield* hub.subscribeForViewer(pat)).pipe(
      Stream.takeUntil(
        (event) => event.type === "message.posted" && event.message.body === "Sentinel",
      ),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const firstDraft = yield* (yield* hub.subscribeAll).pipe(
      Stream.filter((event) => event.type === "draft.updated" && event.draft.text !== ""),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const labelled = yield* (yield* hub.subscribeAll).pipe(
      Stream.filter(
        (event) =>
          event.type === "presence.updated" && event.presence?.label === "Setting a reminder",
      ),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const streaming = (body: string) =>
      itemEvent({
        ...text("a", 1, "", runId),
        text: body,
        streaming: true,
      } as OrchestrationV2TurnItem);
    yield* TestClock.adjust("1 second");
    const plan = `Invented launch plan: ${"step after step, ".repeat(10)}`;
    yield* Queue.offer(fake.live, streaming(plan));
    yield* Fiber.join(firstDraft);
    yield* Context.get(services, KinGroups).addMember([owner], {
      chatId,
      principal: { _tag: "person", personId: pat.personId },
    });
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_wakeups WHERE wakeup_id = ${wakeupId} AND aborted_at IS NOT NULL`,
      1,
    );
    yield* TestClock.adjust("1 second");
    yield* Queue.offer(fake.live, streaming(`${plan}and what was said before Pat came`));
    yield* Queue.offer(
      fake.live,
      itemEvent({ ...tool("t", 2, "mcp__kin__kin_defer", runId), status: "running" }),
    );
    yield* Fiber.join(labelled);
    yield* Context.get(services, KinChatService).send(owner, {
      chatId,
      body: "Sentinel",
      clientMessageId: "sentinel",
    });
    assert.isFalse((yield* Fiber.join(toPat)).some((event) => event.type === "draft.updated"));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "leaves no presence after an owner's reaction is queued during the wake-up and withdrawn",
  () =>
    Effect.gen(function* () {
      const { fake, runId, complete, owner, services, chats, direct, posted, sql } = yield* setup({
        ask: "What can you do?",
      });
      const all = yield* Context.get(services, KinChatHub).subscribeAll;
      const presence = Context.get(services, KinPresence);
      const lines = () => presence.lines(owner.orgId, direct.chatId);
      // Mid-run, the lead is working; then its answer posts and the run ends.
      yield* Queue.offer(fake.live, itemEvent(tool("t", 1, "mcp__kin__kin_journal", runId)));
      fake.items = [
        text("a", 2, "I keep track of your repos, run workers and remind you of things.", runId),
        tool("t2", 3, "Write", runId),
      ];
      yield* complete;
      // Started once the ask is answered: the fixture's wake-up event lacks the dedupe key a real
      // one has, so an earlier catch-up would queue the ask a second time.
      yield* Layer.build(ChatWake.layer.pipe(Layer.provide(Layer.succeedContext(services))));
      assert.deepStrictEqual(lines(), []);
      assert.lengthOf(yield* posted, 1);
      const [reply] = yield* sql<{ messageId: KinMessageId }>`SELECT message_id AS "messageId"
        FROM kin_messages WHERE chat_id = ${direct.chatId} AND author_kind = 'agent' ORDER BY seq`;
      const seen = (label: "Finishing something else" | null) =>
        all.pipe(
          Stream.filter(
            (event) =>
              event.type === "presence.updated" &&
              (label === null ? event.presence === null : event.presence?.label === label),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkScoped,
        );
      // While the wake-up still runs (its memory commit), the owner 👎s and withdraws it.
      // The wake-up still runs, so the reaction waits behind it.
      const shown = yield* seen("Finishing something else");
      yield* chats.react(owner, { messageId: reply!.messageId, emoji: "👎", on: true });
      assert.lengthOf(yield* Fiber.join(shown), 1);
      const gone = yield* seen(null);
      yield* chats.react(owner, { messageId: reply!.messageId, emoji: "👎", on: false });
      assert.lengthOf(yield* Fiber.join(gone), 1);
      assert.deepStrictEqual(lines(), []);
      // Feedback such as ❤️ wakes nothing and shows nothing.
      yield* chats.react(owner, { messageId: reply!.messageId, emoji: "❤️", on: true });
      assert.deepStrictEqual(lines(), []);
    }).pipe(Effect.provide(layer)),
);

it.effect("posts nothing for an L0 lead's reply in a chat its owner didn't place it in", () =>
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
      yield* sql`SELECT entry_id FROM kin_shadow_entries WHERE org_id = ${owner.orgId}`,
      [],
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
  { rescue: [], rescues: 1, expected: ["system:Ada didn't reply."] },
  {
    rescue: ["Sorry, here it is: the deploy is done."],
    rescues: 1,
    expected: ["agent:Sorry, here it is: the deploy is done."],
  },
  // A 👍 that only acknowledged a statement may end its turn silently.
  { reaction: "👍" as const, rescue: [], rescues: 0, expected: [] },
  // A changed answer is owed words: what the lead now does about it.
  {
    reaction: "👍" as const,
    changedFrom: "👎" as const,
    rescue: [],
    rescues: 1,
    expected: ["system:Ada didn't reply."],
  },
])(
  "rescues a run that owed a reply once, then says so (%#)",
  ({ reaction, changedFrom, rescue, rescues, expected }) =>
    Effect.gen(function* () {
      const { fake, runId, complete, posted } = yield* setup({
        ask: "Did the deploy finish?",
        ...(reaction === undefined ? {} : { reaction }),
        ...(changedFrom === undefined ? {} : { changedFrom }),
      });
      // NO_REPLY can't answer an owner's message.
      fake.items = [text("a", 1, "NO_REPLY", runId)];
      fake.rescueItems = rescue.map((body, n) => text(`r${n}`, 10 + n, body, rescueRunId));
      yield* complete;
      assert.strictEqual(fake.rescues, rescues);
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
    expected: ["system:Ada didn't reply."],
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

it.effect.each([
  ...SILENCE_MARKERS.map((marker) => `(${marker})`),
  ...SILENCE_MARKERS.map((marker) => marker),
  "(NO REPLY NEEDED)",
  "(silent)\n(nothing to add)",
])("posts nothing for a marker-only notice text (%s)", (body) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted } = yield* setup({});
    fake.items = [text("a", 1, body, runId)];
    yield* complete;
    assert.deepStrictEqual(yield* posted, []);
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { body: "Deploy is done.\n(no reply needed)", expected: ["Deploy is done."] },
  { body: "Deploy is done. (Nothing To Add)", expected: ["Deploy is done."] },
  {
    body: "(nothing to add) was his reply, but CI is green.",
    expected: ["(nothing to add) was his reply, but CI is green."],
  },
  { body: "All good here (no rush).", expected: ["All good here (no rush)."] },
  { body: "Silent mode is on.", expected: ["Silent mode is on."] },
])("strips only a trailing silence marker from a reply (%#)", ({ body, expected }) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted } = yield* setup({ ask: "Status?" });
    fake.items = [text("a", 1, body, runId)];
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      expected,
    );
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.each([
  ["Hello (no reply nee", "Hello"],
  ["Hello (no reply needed)", "Hello"],
  ["(no rep", ""],
  ["no reply nee", ""],
  ["Hello (see the log", "Hello (see the log"],
  ["Hello (nothing to add) and more", "Hello (nothing to add) and more"],
  ["Deploy is done.\n(staying quiet)", "Deploy is done."],
])("a streaming draft never shows a silence marker (%#)", (body, expected) => {
  assert.strictEqual(draftReplyText(body!), expected);
  assert.strictEqual(stripTrailingSilenceMarker("Done. (silent)"), "Done.");
});
