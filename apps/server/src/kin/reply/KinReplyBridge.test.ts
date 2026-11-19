import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  KIN_DOC_CARD,
  ProviderInstanceId,
  KIN_CHOICE_CARD_ACTION,
  AuthStandardClientScopes,
  EventId,
  KinAgentId,
  KinChatId,
  KinEventId,
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
  KinMemberId,
  KinMemoryItemId,
  KinRecordId,
  ScheduledTaskId,
  ScheduledTaskWebhookDeliveryId,
  type KinEvent,
  type KinMessage,
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

import {
  CLAUDE_PROVIDER,
  claudeThinkingItemId,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import { KinGroups } from "../chat/KinGroups.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, steerMessageId, type PersonIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import {
  authorityLayer,
  startAgentWakeup,
  type WakeupEventBase,
} from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as LeadDocs from "../work/leadDocs.ts";
import * as ChatWake from "../lead/ChatWake.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import {
  CAPTION_PROMPT,
  draftReplyText,
  RESCUE_PROMPT,
  SILENCE_MARKERS,
  stripTrailingSilenceMarker,
} from "./classify.ts";
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
  prompts: Array<string>;
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
        sendToThread: (input) =>
          Effect.gen(function* () {
            fake.rescues++;
            fake.prompts.push(input.text);
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
const failure = (
  id: string,
  ordinal: number,
  code: string,
  runId: RunId,
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, runId),
  status: "failed",
  type: "error",
  failure: {
    class: "provider_error",
    message: "Claude could not authenticate.",
    code,
    retryable: null,
  },
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
  /** Wakes on this event instead, given the org and the lead's direct chat. */
  readonly event?: (context: {
    readonly owner: PersonIdentity;
    readonly direct: KinChatId;
    readonly message: KinMessage | undefined;
    readonly ownerMember: KinMemberId;
  }) => Effect.Effect<
    (base: WakeupEventBase) => KinEvent,
    never,
    Kin.KinServer | SqlClient.SqlClient | Orchestrator.OrchestratorV2
  >;
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
  const event =
    input.event === undefined
      ? undefined
      : yield* input.event({
          owner,
          direct: direct.chatId,
          message,
          ownerMember: KinMemberId.make(
            (yield* sql<{ memberId: string }>`SELECT member_id AS "memberId"
              FROM kin_chat_members WHERE chat_id = ${direct.chatId}
                AND person_id = ${owner.personId}`)[0]!.memberId,
          ),
        });
  const wakeupId = KinWakeupId.make(
    yield* startAgentWakeup({
      orgId: owner.orgId,
      agentId,
      threadId,
      ...(event === undefined ? {} : { event }),
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
    prompts: [],
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
    widgetId: string | null;
  }>`SELECT body, author_kind AS "authorKind", intent, floor_run_id AS "floorRunId", widget_id AS "widgetId" FROM kin_messages
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
    projectId,
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
      [["Yes, CI is green on main.\n\nThe flaky test passed twice.", "agent", "answer"]],
    );
    const [run] = yield* sql<{ runId: string; turns: number }>`
      SELECT run_id AS "runId", agent_turns AS turns FROM kin_floor_runs
      WHERE opened_by = ${message!.messageId} ORDER BY run_id`;
    assert.deepStrictEqual(
      rows.map((row) => row.floorRunId),
      [run!.runId],
    );
    assert.strictEqual(run!.turns, 1);
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["checkin-morning", "One client has gone quiet. A reminder is drafted.", true],
  ["checkin-morning", "## Needs you\nOne card waits.", false],
  ["checkin-afternoon", "One client has gone quiet. A reminder is drafted.", false],
] as const)(
  "the morning check-in's reply opens under a heading when written with none (%s, %s)",
  ([scheduleId, written, headed]) =>
    Effect.gen(function* () {
      const { fake, runId, complete, sql, chatId } = yield* setup({
        event: () =>
          Effect.succeed((base) => ({
            ...base,
            _tag: "pulse",
            provenance: { _tag: "system" },
            factKeys: [],
            checkIn: {
              scheduleId: KinMemoryItemId.make(scheduleId),
              title: "Check-in",
              what: "Look.",
              slot: "s",
            },
          })),
      });
      fake.items = [text("a", 1, written, runId), text("b", 2, "Nothing else today.", runId)];
      yield* complete;
      assert.deepStrictEqual(
        yield* sql`SELECT body, form FROM kin_messages
          WHERE chat_id = ${chatId} AND author_kind = 'agent' ORDER BY seq`,
        [
          {
            body: `${headed ? "## Today\n\n" : ""}${written}\n\nNothing else today.`,
            form: "brief",
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["choice", "intervening item", "doc"] as const)(
  "joins its own last card only (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const {
        services,
        sql,
        chats,
        identity,
        owner,
        chatId,
        wakeupId,
        fake,
        runId,
        complete,
        posted,
      } = yield* setup({
        ask: scenario === "doc" ? "Write the Lumen kickoff brief." : "When should we launch?",
      });
      if (scenario === "doc") {
        yield* sql`UPDATE kin_leads SET thread_id = ${threadId} WHERE org_id = ${owner.orgId} AND agent_id = ${agentId}`;
        const made = yield* LeadDocs.create(
          {
            environmentId: EnvironmentId.make("fixture"),
            requestNamespace: "fixture",
            issuedAt: 0,
            capabilities: new Set(),
            client: undefined,
            thread: {
              threadId,
              providerSessionId: "fixture",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
          },
          {
            sourceEventId: `event:${wakeupId}`,
            title: "Lumen kickoff brief",
            body: "## Kickoff\nReview the launch plan.",
          },
        ).pipe(Effect.provide(services));
        fake.items = [text("a", 1, "Wrote the brief.", runId)];
        yield* complete;
        const history = yield* chats.history(owner, { chatId, beforeSeq: 99, limit: 20 });
        const card = history.widgets.find((widget) => widget.type === KIN_DOC_CARD);
        assert.isDefined(card);
        assert.deepInclude(card.state as object, { key: made.key, title: made.title, version: 1 });
        const rows = (yield* posted).filter((row) => row.authorKind === "agent");
        assert.deepStrictEqual(
          rows.map((row) => [row.body, row.widgetId]),
          [["Wrote the brief.", card.widgetId]],
        );
        return;
      }
      const intervening = scenario === "intervening item";
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
      );
      const card = yield* chats.ask(lead, {
        chatId,
        clientMessageId: "launch-question",
        question: "Which launch day?",
        options: [{ label: "Monday" }, { label: "Wednesday" }],
      });
      if (intervening)
        yield* chats.notice({
          orgId: owner.orgId,
          chatId,
          messageId: KinMessageId.make("next"),
          audience: "chat",
          body: "A new update arrived.",
        });
      fake.items = [text("a", 1, "Friday won't hold.", runId)];
      yield* complete;
      const rows = (yield* posted).filter((row) => row.authorKind === "agent");
      assert.deepStrictEqual(
        rows.map((row) => [row.body, row.widgetId]),
        intervening
          ? [
              ["", card.widgetId],
              ["Friday won't hold.", null],
            ]
          : [["Friday won't hold.", card.widgetId]],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each([true, false])(
  "settles a staged chart with and without a text reply (%s)",
  (hasReply) =>
    Effect.gen(function* () {
      const { chats, identity, owner, chatId, wakeupId, fake, runId, complete, posted, sql } =
        yield* setup({ ask: "How were signups this week?" });
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
      );
      const staged = yield* chats.chart(lead, {
        chatId,
        clientMessageId: "signups",
        intent: "answer",
        chart: "bar",
        title: "Signups",
        unit: { kind: "count" },
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "Signups", values: [4, 6, 8] }],
      });
      assert.isTrue("figure" in staged);
      assert.lengthOf(yield* posted, 0);
      fake.items = hasReply ? [text("a", 1, "Signups doubled.", runId)] : [];
      yield* complete;
      const rows = (yield* posted).filter((row) => row.authorKind === "agent");
      assert.lengthOf(rows, 1);
      if (hasReply) {
        assert.include(rows[0]?.body, "Signups doubled.\n\n```kin_chart");
        assert.isNull(rows[0]?.widgetId);
      } else {
        assert.strictEqual(rows[0]?.body, "");
        assert.match(rows[0]?.widgetId ?? "", /^chart:/);
      }
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_turn_figures WHERE message_id IS NOT NULL`, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { reply: "Noted.", ownOutcome: false, separate: false },
  {
    reply: "Takeaway: launch moved.\n\n## Schedule\nThe revised draft starts Wednesday.",
    ownOutcome: false,
    separate: true,
  },
  { reply: "Noted.", ownOutcome: true, separate: true },
])(
  "settles a tapped choice inline only for a short follow-up (%#)",
  ({ reply, ownOutcome, separate }) =>
    Effect.gen(function* () {
      const { chats, owner, chatId, fake, runId, complete, posted } = yield* setup({
        event: ({ owner, direct, ownerMember }) =>
          Effect.gen(function* () {
            const services = Option.getOrThrow((yield* Kin.KinServer).services);
            const chats = Context.get(services, KinChatService);
            const identity = Context.get(services, KinIdentity);
            const prompt = yield* chats.send(owner, {
              chatId: direct,
              body: "Plan the launch.",
              clientMessageId: "question-origin",
            });
            const id = yield* startAgentWakeup({
              orgId: owner.orgId,
              agentId,
              threadId,
              message: prompt,
            });
            const lead = Option.getOrThrow(
              yield* identity.agentForWakeup({
                orgId: owner.orgId,
                wakeupId: KinWakeupId.make(id),
              }),
            );
            const card = yield* chats.ask(lead, {
              chatId: direct,
              clientMessageId: "launch-choice",
              question: "Which day?",
              options: [{ label: "Monday" }, { label: "Wednesday" }],
            });
            const action = yield* chats.act(owner, {
              widgetId: card.widgetId,
              revision: card.revision,
              actionId: KIN_CHOICE_CARD_ACTION,
              value: "option-2",
              clientActionId: "picked",
            });
            if (ownOutcome) {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE kin_widgets SET state_json = json_set(state_json, '$.outcome', json(${JSON.stringify({ title: "Updated", text: "Kin recorded it." })}))
            WHERE widget_id = ${card.widgetId}`;
            }
            return (base: WakeupEventBase) =>
              ({
                ...base,
                _tag: "widget.action",
                chatId: direct,
                messageId: action.messageId,
                actionId: KIN_CHOICE_CARD_ACTION,
                provenance: human(owner, ownerMember),
              }) as const;
          }).pipe(Effect.orDie),
      });
      fake.items = [text("a", 1, reply, runId)];
      yield* complete;
      const rows = yield* posted;
      assert.deepStrictEqual(
        rows.filter((row) => row.widgetId === null).map((row) => row.body),
        separate ? [reply] : [],
      );
      const history = yield* chats.history(owner, { chatId, beforeSeq: 99, limit: 20 });
      const card = history.widgets.find((widget) => widget.type === "choice");
      assert.isNotNull(card?.closedAt);
      const expected = ownOutcome
        ? { title: "Updated", text: "Kin recorded it." }
        : separate
          ? undefined
          : { title: "You chose “Wednesday”", text: reply };
      assert.deepStrictEqual((card?.state as { outcome?: unknown } | undefined)?.outcome, expected);
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
    const lane = { chatId: direct.chatId, mode: "reply", owed: true, leadName: "Ada" } as const;
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
/** The owner's message the runner steered into the running turn. */
const steered = (
  id: string,
  ordinal: number,
  wakeupId: KinWakeupId,
  runId: RunId,
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal, runId),
  type: "user_message",
  createdBy: "system",
  creationSource: "server",
  messageId: MessageId.make(steerMessageId(wakeupId, 1)),
  inputIntent: "steer",
  text: "Sorry, I meant pears.",
  attachments: [],
});
const githubAnswer =
  "GitHub access works now: GLDRoger/t3code has one open PR (#87, the live status change), its checks are green and it waits on one review. The last Actions run on kin passed. I cancelled the old reminder to retry GitHub, since you no longer need it. Tell me if you want me to watch #87.";

// A turn's reply is the text the lead writes, wherever it falls among its tool calls: one message
// per request, never its thinking, and never the same answer twice.
it.effect.each([
  {
    name: "the reply, a tool, then the same answer again",
    items: (runId: RunId) => [
      tool("t1", 1, "mcp__kin__kin_github_watch", runId),
      thought("r1", 2, runId),
      tool("t2", 3, "mcp__kin__kin_github_review", runId),
      thought("r2", 4, runId),
      tool("t3", 5, "mcp__kin__kin_cancel", runId),
      text("a", 6, githubAnswer, runId),
      tool("t5", 7, "mcp__kin__kin_journal", runId),
      text("b", 8, githubAnswer, runId),
    ],
    expected: [githubAnswer],
  },
  {
    name: "a short reply at the run's end is the reply, not a status note",
    items: (runId: RunId) => [
      tool("t1", 1, "mcp__kin__kin_defer", runId),
      text("a", 2, "Done: deferred to Fri 9:00.", runId),
    ],
    expected: ["Done: deferred to Fri 9:00."],
  },
  {
    name: "a long message, a tool, then more, as one message",
    items: (runId: RunId) => [
      text("a", 1, githubAnswer, runId),
      tool("t1", 2, "mcp__kin__kin_github_review", runId),
      text("b", 3, "And #87 has a second approval now.", runId),
    ],
    expected: [`${githubAnswer}\n\nAnd #87 has a second approval now.`],
  },
  {
    name: "a status line, a tool, then the reply",
    items: (runId: RunId) => [
      text("a", 1, "Checking CI", runId),
      tool("t1", 2, "mcp__kin__kin_github_review", runId),
      text("b", 3, "CI is green on main.", runId),
    ],
    expected: ["CI is green on main."],
  },
  {
    name: "thinking, then the reply",
    items: (runId: RunId) => [
      narration(1, runId),
      tool("t1", 2, "mcp__kin__kin_journal", runId),
      text("a", 3, "CI is green on main.", runId),
    ],
    expected: ["CI is green on main."],
  },
  {
    name: "a message steered in after the reply gets its own answer, once",
    items: (runId: RunId, wakeupId: KinWakeupId) => [
      text("a", 1, "Apples, red and round.", runId),
      steered("s", 2, wakeupId, runId),
      text("b", 3, "Pears, gold and sweet.", runId),
      tool("t1", 4, "mcp__kin__kin_journal", runId),
      text("c", 5, "Pears, gold and sweet.", runId),
    ],
    expected: ["Apples, red and round.", "Pears, gold and sweet."],
  },
])("a turn's reply is the text it writes, posted once ($name)", ({ items, expected }) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, wakeupId } = yield* setup({ ask: "Try now" });
    fake.items = items(runId, wakeupId);
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      expected,
    );
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a posted reply answers what the lead had read: a restart asks again only for the rest",
  () =>
    Effect.gen(function* () {
      const { fake, runId, complete, posted, wakeupId, owner, bridge, sql, services } =
        yield* setup({
          ask: "Apples?",
        });
      // A second message steered in, whose answer the restart cuts off.
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      VALUES ('pears', ${owner.orgId}, ${agentId}, 'chat.message', 'P1', '{}', 0, 0, 'claimed',
        ${wakeupId})`;
      yield* bridge.steered(owner.orgId, wakeupId, { n: 1, eventIds: ["pears"] });
      fake.items = [
        text("a", 1, "Apples, red and round.", runId),
        steered("s", 2, wakeupId, runId),
      ];
      yield* complete;
      assert.deepStrictEqual(
        (yield* posted).map((row) => row.body),
        ["Apples, red and round."],
      );
      assert.strictEqual(
        yield* Context.get(services, KinEventQueue.KinEventQueue).requeueUnfinished(
          owner.orgId,
          wakeupId,
        ),
        1,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT event_id AS "eventId", state FROM kin_events ORDER BY event_id`,
        [
          { eventId: `event:${wakeupId}`, state: "done" },
          { eventId: "pears", state: "queued" },
        ],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("a reply and its answered mark commit together: a crash between them can't re-ask", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, wakeupId, owner, sql, services } = yield* setup({
      ask: "Apples?",
    });
    // The process dies as the mark is written, after the reply's own insert.
    yield* sql`CREATE TRIGGER crash_at_mark BEFORE UPDATE OF replied_at ON kin_events
      BEGIN SELECT RAISE(ABORT, 'crashed between the reply and its mark'); END`;
    fake.items = [text("a", 1, "Apples, red and round.", runId)];
    yield* complete;
    const stored = (yield* posted).some((row) => row.body === "Apples, red and round.");
    const askedAgain = yield* Context.get(services, KinEventQueue.KinEventQueue).requeueUnfinished(
      owner.orgId,
      wakeupId,
    );
    assert.deepStrictEqual({ stored, askedAgain }, { stored: false, askedAgain: 1 });
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { reply: "Here is the invoice. I've put up a card to send it.", after: ["kin-no-card"] },
  { reply: "The invoice total is 59,000.", after: [] },
])(
  "a turn that fails after its reply adds a line only for a card it named ($after)",
  ({ reply, after }) =>
    Effect.gen(function* () {
      const { fake, runId, posted, wakeupId, owner, bridge, sql, projectId } = yield* setup({
        ask: "Send the invoice?",
      });
      fake.items = [text("a", 1, reply, runId)];
      yield* bridge.complete({
        orgId: owner.orgId,
        wakeupId,
        projectId,
        rootRunId: runId,
        rescueUntil: null,
      });
      const lane = Option.getOrThrow(yield* bridge.lane({ orgId: owner.orgId, agentId, wakeupId }));
      yield* bridge.failed({ orgId: owner.orgId, wakeupId, lane, outcome: "replied" });
      assert.deepStrictEqual(
        (yield* posted).map((row) => row.body),
        [
          reply,
          ...(after.length > 0
            ? ["Ada stopped before posting the card it mentioned. Ask again for it."]
            : []),
        ],
      );
      assert.deepStrictEqual(
        (yield* sql<{ id: string }>`SELECT message_id AS id FROM kin_messages
        WHERE author_kind = 'system' ORDER BY seq`).map((row) => row.id.split(":")[0]),
        after,
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

// G01: a co-owner's chat is owner-level, so a reply with money in it posts there.
it.effect.each(["co_owner", "member"] as const)(
  "an owner-only reply posts where everyone reading is owner-level, never silently held (%s)",
  (access) =>
    Effect.gen(function* () {
      const { fake, runId, complete, posted, sql, wakeupId } = yield* setup({
        lane: "shared-group",
        ask: "Draft the December retainer invoice",
      });
      yield* sql`UPDATE kin_people SET access = ${access} WHERE person_id = 'mate'`;
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = ${wakeupId}`;
      fake.items = [text("a", 1, "Draft INV-2 is ready: ₹40,000 + GST.", runId)];
      yield* complete;
      assert.deepStrictEqual(
        (yield* posted).map((row) => `${row.authorKind}:${row.body}`),
        access === "co_owner"
          ? ["agent:Draft INV-2 is ready: ₹40,000 + GST."]
          : ["system:Ada didn't reply: someone joined while it was working. Send it again."],
      );
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
        text("a", 2, "I keep track of your repos, start tasks and remind you of things.", runId),
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

it.effect("keeps a run that couldn't sign in out of the chat, and says so once per burst", () =>
  Effect.gen(function* () {
    const { fake, runId, bridge, owner, wakeupId, posted, chats, chatId, projectId } = yield* setup(
      { ask: "Is CI green?" },
    );
    fake.items = [
      text("a", 1, "Not logged in · Please run /login", runId),
      failure("e", 2, "authentication_failed", runId),
    ];
    yield* bridge.complete({
      orgId: owner.orgId,
      wakeupId,
      projectId,
      rootRunId: runId,
      rescueUntil: null,
    });
    const lane = { chatId, mode: "reply" as const, owed: true, leadName: "Ada" };
    const fail = (id: KinWakeupId) =>
      bridge.failed({ orgId: owner.orgId, wakeupId: id, lane, outcome: "signin" });
    const retry = () =>
      startAgentWakeup({ orgId: owner.orgId, agentId, threadId }).pipe(
        Effect.map((id) => KinWakeupId.make(id)),
      );
    yield* fail(wakeupId);
    yield* fail(yield* retry());
    const line = "Ada couldn't start: its model account needs signing in again on the server.";
    assert.deepStrictEqual(
      (yield* posted).map((row) => [row.body, row.authorKind]),
      [[line, "system"]],
    );
    yield* chats.send(owner, { chatId, body: "Still there?", clientMessageId: "again" });
    yield* fail(yield* retry());
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      [line, line],
    );
    // QA Q3: a model the provider doesn't know names the fix too.
    yield* chats.send(owner, { chatId, body: "And now?", clientMessageId: "model" });
    yield* bridge.failed({ orgId: owner.orgId, wakeupId: yield* retry(), lane, outcome: "model" });
    assert.strictEqual(
      (yield* posted).at(-1)?.body,
      "Ada couldn't start: its model account doesn't offer the model it's set to use. Choose another model for it.",
    );
    yield* chats.send(owner, { chatId, body: "Hello?", clientMessageId: "program" });
    yield* bridge.failed({
      orgId: owner.orgId,
      wakeupId: yield* retry(),
      lane,
      outcome: "program",
    });
    assert.strictEqual(
      (yield* posted).at(-1)?.body,
      "Ada couldn't start: the server couldn't run its model program. Check the provider's binary path in Settings.",
    );
    // A retry says so once; the next retry before anyone writes adds nothing.
    yield* chats.send(owner, { chatId, body: "Again?", clientMessageId: "retry" });
    const before = (yield* posted).length;
    yield* bridge.failed({
      orgId: owner.orgId,
      wakeupId: yield* retry(),
      lane,
      outcome: "retrying",
    });
    yield* bridge.failed({
      orgId: owner.orgId,
      wakeupId: yield* retry(),
      lane,
      outcome: "retrying",
    });
    assert.deepStrictEqual(
      (yield* posted).slice(before).map((row) => row.body),
      ["Ada couldn't start. Trying again in a moment."],
    );
  }).pipe(Effect.provide(layer)),
);

// QA Q3: the CLI's synthetic "API Error: …" reply reached the chat as the lead's own words.
it.effect("keeps a provider's error text out of the chat when its run failed", () =>
  Effect.gen(function* () {
    const { fake, runId, bridge, owner, wakeupId, posted, projectId } = yield* setup({
      ask: "Is CI green?",
    });
    fake.items = [
      text("a", 1, "API Error: 529 Overloaded", runId),
      failure("e", 2, "api_error_529", runId),
    ];
    yield* bridge.complete({
      orgId: owner.orgId,
      wakeupId,
      projectId,
      rootRunId: runId,
      rescueUntil: null,
    });
    assert.deepStrictEqual(yield* posted, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("tells a shared chat only that the lead is unavailable when its account fails", () =>
  Effect.gen(function* () {
    const { bridge, owner, wakeupId, posted, chatId } = yield* setup({
      ask: "Who owns launch?",
      lane: "shared-group",
    });
    yield* bridge.failed({
      orgId: owner.orgId,
      wakeupId,
      lane: { chatId, mode: "reply", owed: true, leadName: "Ada" },
      outcome: "access",
    });
    assert.deepStrictEqual(
      (yield* posted).map((row) => row.body),
      ["Ada is unavailable right now."],
    );
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

it.effect.each([
  { reply: "Should I take it over?", expected: [] },
  { reply: "should i  take it over", expected: [] },
  // Digits and inner punctuation are what the sentence says: they are never normalised away.
  { question: "Cost is $1.00?", reply: "Cost is $100.", expected: ["Cost is $100."] },
  { question: "Merge PR #87?", reply: "Merge PR #8-7.", expected: ["Merge PR #8-7."] },
  { question: "Cost is $1.00?", reply: "cost is $1.00", expected: [] },
  { reply: "Tech owns the API. Should I take it over?", expected: ["Tech owns the API."] },
  {
    reply: "Should I take it over?\n\nTech has been quiet for a day.",
    expected: ["Tech has been quiet for a day."],
  },
  { reply: "Tech is on it already.", expected: ["Tech is on it already."] },
  // A paraphrase of the card is the card again; it goes, and what else the reply says stays.
  {
    question: "Mark QT-1 accepted and draft the 30% advance invoice?",
    reply:
      "Meera accepted on the thread. Shall I mark QT-1 accepted and draft the 30% advance invoice now? It would be ₹3,18,600 with IGST.",
    expected: ["Meera accepted on the thread. It would be ₹3,18,600 with IGST."],
  },
  {
    reply: "Should I take it over?\nTech is out until Thursday.\nThe client wants it Friday.",
    expected: ["Tech is out until Thursday.\nThe client wants it Friday."],
  },
  {
    question: "Mark QT-1 accepted and draft the 30% advance invoice?",
    reply: "Want me to mark QT-1 as accepted and draft the advance invoice (30%)?",
    expected: [],
  },
])("a reply doesn't repeat the question its card asks ($reply)", ({ question, reply, expected }) =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted, identity, chats, owner, wakeupId, chatId } =
      yield* setup({ ask: "The API is stuck" });
    const lead = Option.getOrThrow(
      yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
    );
    yield* chats.ask(lead, {
      chatId,
      clientMessageId: "take-over",
      question: question ?? "Should I take it over?",
      options: [
        { label: "Yes", kind: "yes" },
        { label: "No", kind: "no" },
      ],
    });
    fake.items = [text("a", 1, reply, runId)];
    yield* complete;
    assert.strictEqual(fake.rescues, 0);
    assert.deepStrictEqual(
      (yield* posted).filter((row) => row.body !== "").map((row) => row.body),
      expected,
    );
  }).pipe(Effect.provide(layer)),
);

// Sonnet 5.5 evals: 14 of 93 turns posted a chart, statement or file and no words. A card that
// asks or shows its result answers; a chart or file alone gets one request for its line.
it.effect.each([
  { card: "question", rescue: [], prompts: [], expected: [] },
  { card: "chart", rescue: ["Signups dipped midweek."], expected: ["Signups dipped midweek."] },
  // No line came: the chart stands, and "didn't reply" under it would be false.
  { card: "chart", rescue: [], expected: [] },
] as const)("a card that only shows something asks once for its line ($card, $rescue)", (input) =>
  Effect.gen(function* () {
    const { fake, runId, complete, identity, chats, owner, wakeupId, chatId, sql } = yield* setup({
      ask: "How did signups go?",
    });
    const lead = Option.getOrThrow(
      yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
    );
    if (input.card === "question")
      yield* chats.ask(lead, {
        chatId,
        clientMessageId: "which-week",
        question: "This week or last?",
        options: [{ label: "This week" }, { label: "Last week" }],
      });
    else
      yield* chats.chart(lead, {
        chatId,
        clientMessageId: "signups",
        intent: "answer",
        chart: "bar",
        title: "Signups",
        unit: { kind: "count" },
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "This week", values: [12, 9, 14] }],
      });
    fake.items = [narration(1, runId), tool("t", 2, "mcp__kin__kin_chart", runId)];
    fake.rescueItems = input.rescue.map((body, n) => text(`r${n}`, 10 + n, body, rescueRunId));
    yield* complete;
    assert.deepStrictEqual(fake.prompts, input.card === "chart" ? [CAPTION_PROMPT] : []);
    const said = yield* sql<{ line: string }>`SELECT author_kind || ':' || body AS line
      FROM kin_messages WHERE chat_id = ${chatId} AND author_kind != 'human' AND body != ''
      ORDER BY seq`;
    assert.deepStrictEqual(
      said.map((row) => row.line),
      input.expected.map((body) => `agent:${body}`),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps a turn's reply to one message however many segments, live, with kin_chat_post bounded",
  () =>
    Effect.gen(function* () {
      const { fake, runId, complete, posted, identity, chats, owner, wakeupId, chatId, services } =
        yield* setup({ ask: "Tell me everything" });
      const all = yield* Context.get(services, KinChatHub).subscribeAll;
      const paragraph = (n: number) => `Part ${n}. ${`Detail ${n} `.repeat(40).trim()}`;
      fake.items = Array.from({ length: 12 }, (_, n) => [
        text(`p${n}`, 2 * n + 1, paragraph(n), runId),
        tool(`t${n}`, 2 * n + 2, "mcp__kin__kin_journal", runId),
      ]).flat();
      const live = yield* all.pipe(
        Stream.filter(
          (event) => event.type === "message.posted" && event.message.author._tag === "agent",
        ),
        Stream.take(12),
        Stream.runCollect,
        Effect.forkScoped,
      );
      for (const item of fake.items) yield* Queue.offer(fake.live, itemEvent(item));
      const updates = yield* Fiber.join(live);
      yield* complete;
      const body = Array.from({ length: 12 }, (_, n) => paragraph(n)).join("\n\n");
      assert.deepStrictEqual(
        (yield* posted).map((row) => row.body),
        [body],
      );
      // Each segment reaches clients as the same message, grown, through the live stream.
      const ids = new Set(
        updates.map((event) => (event.type === "message.posted" ? event.message.messageId : "")),
      );
      assert.strictEqual(ids.size, 1);
      const last = updates.at(-1);
      assert.strictEqual(last?.type === "message.posted" ? last.message.body : "", body);
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
      );
      const send = (n: number) =>
        chats.send(lead, {
          chatId,
          body: `More ${n}`,
          clientMessageId: `extra-${n}`,
          intent: "answer",
        });
      for (const n of [1, 2, 3, 4, 5, 6, 7]) yield* send(n);
      assert.include(yield* send(8).pipe(Effect.flip), { reason: "limit" });
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

// Walk of 19 Nov: Kin's own "Passed on to Finance" line already answered the teammate.
it.effect.each([
  {
    items: ["I'll pass this to Finance.", "kin_hand_off"],
    rescues: 0,
    expected: [],
  },
  { items: ["kin_hand_off", "NO_REPLY"], rescues: 0, expected: [] },
  {
    items: ["kin_hand_off", "Finance keeps the March figures."],
    rescues: 0,
    expected: ["agent:Finance keeps the March figures."],
  },
  // A second message in the same wake-up went nowhere: it is still owed words.
  { items: ["kin_hand_off"], another: true, rescues: 1, expected: ["system:Ada didn't reply."] },
])(
  "a request passed on is answered by Kin's line, and only that request (%#)",
  ({ items, another, rescues, expected }) =>
    Effect.gen(function* () {
      const { fake, runId, complete, posted, message, owner, wakeupId, sql } = yield* setup({
        ask: "What did we spend on travel in March?",
      });
      yield* sql`INSERT INTO kin_handoffs (org_id, message_id, from_agent_id, to_agent_id, event_id,
          created_at, route_state)
        VALUES (${owner.orgId}, ${message!.messageId}, ${agentId}, 'finance', 'forward-travel', 0,
          'passed')`;
      if (another === true)
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
            received_at, queued_at, state, wakeup_id)
          VALUES ('hotels', ${owner.orgId}, ${agentId}, 'chat.message', 'P1', '{}', 0, 0, 'claimed',
            ${wakeupId})`;
      fake.items = items.map((item, n) =>
        item === "kin_hand_off"
          ? tool(`t${n}`, n + 1, "mcp__kin__kin_hand_off", runId)
          : text(`a${n}`, n + 1, item, runId),
      );
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

it.effect.each([
  { id: (_wakeupId: string) => "pulse-nudge:person:2026-11-16", body: "Did the client pay?" },
  { id: (wakeupId: string) => `kin-relay:${wakeupId}:abc`, body: "Asha says the deck is Friday." },
])(
  "a nudge or relay Kin sends the asker mid-turn is not the reply they are owed (%#)",
  ({ id, body }) =>
    Effect.gen(function* () {
      const { identity, chats, owner, wakeupId, complete, fake, posted, runId, direct } =
        yield* setup({ ask: "Did the deploy finish?" });
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId: owner.orgId, wakeupId }),
      );
      yield* chats.send(lead, {
        chatId: direct.chatId,
        body,
        clientMessageId: id(wakeupId),
        intent: "question",
        forChat: true,
      });
      fake.items = [text("a", 1, "NO_REPLY", runId)];
      yield* complete;
      assert.strictEqual(fake.rescues, 1);
      assert.deepStrictEqual(
        (yield* posted).map((row) => `${row.authorKind}:${row.body}`),
        [`agent:${body}`, "system:Ada didn't reply."],
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

const otherLead = KinAgentId.make("cos");
type WakeCase = {
  readonly event?: NonNullable<Parameters<typeof setup>[0]["event"]>;
  readonly ask?: string;
  readonly reaction?: "👍";
  /** Someone waits on words: silence gets one rescue, then a plain line. */
  readonly owed: boolean;
};
const human = (owner: PersonIdentity, memberId: KinMemberId) =>
  ({ _tag: "human", personId: owner.personId, memberId }) as const;
// Every kind of wake-up, so a new one can't ship without deciding what its silence means.
const WAKE_KINDS: Record<KinEvent["_tag"] | "hand-over", WakeCase> = {
  "chat.message": { ask: "What is the plan?", owed: true },
  "chat.reaction": { ask: "Ship it Friday?", reaction: "👍", owed: true },
  "widget.action": {
    ask: "Pick one",
    owed: true,
    event: ({ owner, direct, message, ownerMember }) =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "widget.action",
        provenance: human(owner, ownerMember),
        chatId: direct,
        messageId: message!.messageId,
        actionId: "yes",
      })),
  },
  // What `KinHandoff.handOff` writes: Kin's row in the lead's chat, woken as a passed-on request.
  "hand-over": {
    owed: true,
    event: ({ owner, direct }) =>
      Effect.gen(function* () {
        const kin = yield* Kin.KinServer;
        const services = Option.getOrThrow(kin.services);
        const chats = Context.get(services, KinChatService);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES (${otherLead}, ${owner.orgId}, 'Chief', 'lead', ${owner.personId}, '1970-01-01T00:00:00.000Z')`;
        const asked = yield* chats.createDirect(owner, { orgId: owner.orgId, agentId: otherLead });
        const { message } = yield* chats.notice({
          orgId: owner.orgId,
          chatId: direct,
          audience: "owner",
          messageId: KinMessageId.make("kin-handoff:test"),
          body: 'Passed on by Chief\n"Can Tech estimate phase 2?"',
        });
        return (base: WakeupEventBase): KinEvent => ({
          ...base,
          _tag: "chat.message",
          provenance: {
            _tag: "agent",
            agentId: otherLead,
            memberId: KinMemberId.make("cos-member"),
            ownerPersonId: owner.personId,
            threadId: ThreadId.make("cos-thread"),
          },
          chatId: direct,
          messageId: message.messageId,
          origin: { agentId: otherLead, chatId: asked.chatId },
        });
      }).pipe(Effect.orDie),
  },
  "record.changed": {
    owed: true,
    event: ({ owner, ownerMember }) =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "record.changed",
        provenance: human(owner, ownerMember),
        recordId: KinRecordId.make("record-19"),
        key: "W-19",
        seq: 1,
        reason: "assigned",
      })),
  },
  // T3's notice that a task the owner asked for ended: what changed, the PR, the screenshots.
  "task.finished": {
    owed: true,
    event: ({ direct }) =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "task.finished",
        provenance: { _tag: "system" },
        threadId,
        messageId: MessageId.make("delegated-completion:1"),
        taskIds: [NodeId.make("task-1")],
        chatId: direct,
      })),
  },
  // Reminders, briefs and scheduled runs owe their words through `LeadDelivery`'s fallback.
  "deferral.due": {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "deferral.due",
        provenance: { _tag: "system" },
        subject: { type: "reminder", itemId: KinMemoryItemId.make("item-1") },
        lateByMs: 0,
      })),
  },
  routine: { owed: false },
  github: {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "github",
        provenance: { _tag: "system" },
        deliveryId: "delivery-1",
        eventName: "push",
        repo: "acme/site",
        summary: "A push to main.",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        webhookDeliveryId: ScheduledTaskWebhookDeliveryId.make("hook-1"),
      })),
  },
  watchdog: {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "watchdog",
        provenance: { _tag: "system" },
        finding: "A note is stale.",
        itemIds: [],
      })),
  },
  pulse: {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "pulse",
        provenance: { _tag: "system" },
        factKeys: ["task_late:W-1:due=0"],
      })),
  },
  "action.resolved": {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "action.resolved",
        provenance: { _tag: "system" },
        pendingActionId: "action-1",
        outcome: "executed",
      })),
  },
  resume: {
    owed: false,
    event: () =>
      Effect.succeed((base) => ({
        ...base,
        _tag: "resume",
        provenance: { _tag: "system" },
        pausedAt: base.receivedAt,
        expired: { count: 0, events: [] },
      })),
  },
};

const reply = "Phase 2 is about three weeks: booking first, then reports.";
// Run 4: Claude's summarised reasoning restating the answer, which its adapter shows as an
// update (`ClaudeAdapterV2.test.ts` makes it from the same blocks). It posted in place of the
// answer the model wrote after it. Its id is the adapter's own, so a new format still skips.
const narration = (ordinal: number, runId: RunId): OrchestrationV2TurnItem => ({
  ...text("narration", ordinal, "The Orbit invoice went out to Anita from hello@.", runId),
  nativeItemRef: {
    driver: CLAUDE_PROVIDER,
    nativeId: claudeThinkingItemId("msg_finance", 1),
    strength: "strong",
  },
});
it.effect.each([false, true])(
  "a hand-back may end on NO_REPLY unless the wake also has an owner message (owner message: %s)",
  (withOwnerMessage) =>
    Effect.gen(function* () {
      const handOver = WAKE_KINDS["hand-over"].event!;
      const { fake, runId, complete, posted, sql, wakeupId } = yield* setup({
        event: (context) =>
          Effect.gen(function* () {
            if (withOwnerMessage) {
              const kin = yield* Kin.KinServer;
              const services = Option.getOrThrow(kin.services);
              const chats = Context.get(services, KinChatService);
              const message = yield* chats.send(context.owner, {
                chatId: context.direct,
                body: "What should we do next?",
                clientMessageId: "owner-question",
              });
              yield* Context.get(services, KinEventQueue.KinEventQueue).enqueue({
                _tag: "chat.message",
                orgId: context.owner.orgId,
                agentId,
                eventId: KinEventId.make("owner-question"),
                receivedAt: yield* DateTime.now,
                dedupeKey: null,
                provenance: message.author,
                chatId: message.chatId,
                messageId: message.messageId,
              });
            }
            const event = yield* handOver(context);
            return (base: WakeupEventBase) => ({
              ...event(base),
              eventId: KinEventId.make("handoff-back-test"),
              dedupeKey: "handoff-back:test",
            });
          }).pipe(Effect.orDie),
      });
      assert.deepStrictEqual(
        yield* sql`SELECT event_id = 'handoff-back-test' AS back FROM kin_events
          WHERE wakeup_id = ${wakeupId} AND tag = 'chat.message' ORDER BY back DESC`,
        withOwnerMessage ? [{ back: 1 }, { back: 0 }] : [{ back: 1 }],
      );
      fake.items = [text("a", 1, "NO_REPLY", runId)];
      yield* complete;
      assert.strictEqual(fake.rescues, withOwnerMessage ? 1 : 0);
      assert.deepStrictEqual(
        (yield* posted).filter((row) => row.body === "Ada didn't reply.").map((row) => row.body),
        withOwnerMessage ? ["Ada didn't reply."] : [],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(
  Object.entries(WAKE_KINDS).flatMap(([kind, wake]) =>
    (
      [
        "reply",
        "a tool then the reply",
        "a tool only",
        "reasoning, a tool, then the reply",
        "reasoning and a tool only",
      ] as const
    ).map((order) => ({
      kind,
      wake,
      order,
    })),
  ),
)(
  "every wake-up posts its one reply in its chat, or says it didn't ($kind, $order)",
  ({ wake, order }) =>
    Effect.gen(function* () {
      const { fake, runId, complete, sql, owner, direct } = yield* setup({
        ...(wake.ask === undefined ? {} : { ask: wake.ask }),
        ...(wake.reaction === undefined ? {} : { reaction: wake.reaction }),
        ...(wake.event === undefined ? {} : { event: wake.event }),
      });
      const call = tool("t", 2, "mcp__kin__kin_journal", runId);
      fake.items =
        order === "reply"
          ? [text("a", 1, reply, runId)]
          : order === "a tool then the reply"
            ? [{ ...call, ordinal: 1 }, text("a", 2, reply, runId)]
            : order === "reasoning, a tool, then the reply"
              ? [narration(1, runId), call, text("a", 3, reply, runId)]
              : order === "reasoning and a tool only"
                ? [narration(1, runId), call]
                : [{ ...call, ordinal: 1 }];
      const replied = !order.endsWith("only");
      for (const item of fake.items) yield* Queue.offer(fake.live, itemEvent(item));
      yield* complete;
      const said = yield* sql<{ body: string; authorKind: string }>`
      SELECT body, author_kind AS "authorKind" FROM kin_messages
      WHERE org_id = ${owner.orgId} AND chat_id = ${direct.chatId} AND author_kind != 'human'
        AND message_id NOT LIKE 'kin-handoff:%' ORDER BY seq`;
      assert.deepStrictEqual(
        said.map((row) => `${row.authorKind}:${row.body}`),
        replied ? [`agent:${reply}`] : wake.owed ? ["system:Ada didn't reply."] : [],
      );
      assert.deepStrictEqual(fake.prompts, !replied && wake.owed ? [RESCUE_PROMPT] : []);
    }).pipe(Effect.provide(layer)),
);

// Review 48: ten notices this hour refused a hand-over or task reply, and it counted as answered.
it.effect.each(["hand-over", "record.changed", "task.finished", "github"] as const)(
  "the hourly notice limit holds back only unprompted notices, never an owed reply (%s)",
  (kind) =>
    Effect.gen(function* () {
      const wake = WAKE_KINDS[kind];
      const { fake, runId, complete, sql, owner, direct } = yield* setup(
        wake.event === undefined ? {} : { event: wake.event },
      );
      for (const n of Array.from({ length: 10 }, (_, index) => index)) {
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
            author_role, kind, body, mentions_json, status, created_at)
          VALUES (${`earlier-${n}`}, ${owner.orgId}, ${direct.chatId}, ${1000 + n}, 'system',
            'member', 'text', 'Earlier notice', '[]', 'posted', '1970-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_floor_notices (org_id, message_id, chat_id, agent_id, posted_at)
          VALUES (${owner.orgId}, ${`earlier-${n}`}, ${direct.chatId}, ${agentId}, 0)`;
      }
      fake.items = [text("a", 1, reply, runId)];
      yield* complete;
      const said = yield* sql<{ body: string; authorKind: string }>`
        SELECT body, author_kind AS "authorKind" FROM kin_messages
        WHERE org_id = ${owner.orgId} AND chat_id = ${direct.chatId} AND author_kind != 'human'
          AND message_id NOT LIKE 'kin-handoff:%' AND message_id NOT LIKE 'earlier-%' ORDER BY seq`;
      assert.deepStrictEqual(
        said.map((row) => `${row.authorKind}:${row.body}`),
        wake.owed ? [`agent:${reply}`] : [],
      );
      assert.strictEqual(fake.rescues, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("a reply Kin refused is not an answer: the owner sees that none came", () =>
  Effect.gen(function* () {
    const { fake, runId, complete, posted } = yield* setup({ ask: "Is CI green?" });
    // The message's grant lapsed before the reply landed, so the floor refuses it.
    yield* TestClock.adjust("6 minutes");
    fake.items = [text("a", 1, "Yes, CI is green on main.", runId)];
    yield* complete;
    assert.deepStrictEqual(
      (yield* posted).map((row) => `${row.authorKind}:${row.body}`),
      [
        "system:Ada's reply couldn't be posted: it came after the time to answer ran out. Send your message again.",
      ],
    );
    // The rescue's text would be refused the same way.
    assert.strictEqual(fake.rescues, 0);
  }).pipe(Effect.provide(layer)),
);
