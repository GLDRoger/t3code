import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "./layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  type KinMessage,
  KinMemoryItemId,
  type KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import { agentServices } from "../mcp/KinChatToolkit.ts";
import { handlers as pulseHandlers, KinPulseToolkit } from "../pulse/mcp.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "./Handoff.ts";
import * as Team from "../team/KinTeam.ts";
import { LeadMemory } from "./LeadMemory.ts";
import { handlers as leadHandlers } from "./mcp/handlers.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { reholdAfter } from "../triggers/quietHold.ts";
import { SHARED_REFUSAL } from "./Audience.ts";
import { listedOnSharedThread } from "./SharedTools.ts";

const chief = KinAgentId.make("chief");
const threadId = ThreadId.make("chief-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "chief",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: { threadId, providerSessionId: "chief", providerInstanceId },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// The tools as a lead's thread reaches them, with Kin's own services behind them.
const kinServices = Layer.unwrap(
  Effect.gen(function* () {
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    return Layer.mergeAll(
      Handoff.layer,
      Team.layer,
      Layer.mock(LeadMemory)({
        defer: (_scope, input) =>
          Effect.succeed({ itemId: KinMemoryItemId.make(`def-${input.what}`) }),
        cancel: (_scope, input) => Effect.succeed({ itemId: input.itemId }),
      }),
    ).pipe(Layer.provideMerge(Layer.succeedContext(services)));
  }),
);
const layer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
  McpHttpServer.toolkitRegistration(KinPulseToolkit, pulseHandlers),
  McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers),
  KinToolGate.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(kinServices),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
    }),
  ),
  Layer.provideMerge(
    Kin.layer.pipe(
      Layer.provide(kinSecretsTest),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      Layer.provideMerge(environment),
    ),
  ),
  Layer.provideMerge(authorityLayer),
  Layer.provideMerge(kinSecretsTest),
);

/** A tool call exactly as the lead's provider sends it; its JSON answer, or its refusal. */
const call = Effect.fn("test.call")(function* (name: string, args: Record<string, unknown>) {
  const server = yield* McpServer.McpServer;
  // As the Kin endpoint runs every call: its identity decides which tools a thread has.
  const identity = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinIdentity);
  const result = yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return { ok: result.isError !== true, value: JSON.parse(text) as Record<string, unknown> };
});

const rowsIn = (sql: SqlClient.SqlClient, orgId: KinOrgId, chatId: KinChatId) =>
  sql<{ author: string; body: string }>`SELECT author_kind AS author, body FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY seq`;

type Phase = "day" | "night" | "urgent" | "off";
// Everyone here is on UTC, and quiet hours are 22:00 to 07:00. In "off" the teammates are in
// India and work Monday to Friday, 10:00 to 18:00 their time; it is Monday 18:30 there.
const START: Record<Phase, number> = {
  day: Date.UTC(2026, 10, 16, 12),
  night: Date.UTC(2026, 10, 15, 23, 30),
  urgent: Date.UTC(2026, 10, 15, 23, 30),
  off: Date.UTC(2026, 10, 16, 13),
};
/** When what was held is free to go: 07:00 UTC, or Tuesday 10:00 in India. */
const WAKE: Record<Phase, { at: number; clock: string }> = {
  day: { at: Date.UTC(2026, 10, 16, 7), clock: "07:00" },
  night: { at: Date.UTC(2026, 10, 16, 7), clock: "07:00" },
  urgent: { at: Date.UTC(2026, 10, 16, 7), clock: "07:00" },
  off: { at: Date.UTC(2026, 10, 17, 4, 30), clock: "10:00" },
};

// Ambermill, run 4 (16 Nov 2026): kin_relay to a teammate was refused by the floor, and later in
// their quiet hours. Each route a message to a person takes, by the agent's tool call, through
// the gate, the chat service and the floor into their chat; in quiet hours, held until 07:00.
const routes = (phase: Phase) =>
  // Set before Kin's schedules start. Each route waits 11 minutes, so none answers a fresh message.
  Effect.andThen(
    TestClock.setTime(START[phase]),
    Effect.gen(function* () {
      const kin = yield* Kin.KinServer;
      const services = Option.getOrThrow(kin.services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(AuthSessionId.make("owner"));
      const [resolved] = yield* identity.resolve({
        sessionId: AuthSessionId.make("owner"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      });
      const owner = resolved!;
      const { orgId } = owner;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30', '03:00',
          0, 1, '09:00', '{"from":"22:00","to":"07:00"}')
        ON CONFLICT (org_id) DO UPDATE SET time_zone = 'UTC'`;
      const later = TestClock.adjust("11 minutes");
      const urgent = phase === "urgent" ? { urgent: "Invented: the client demo is at 08:00" } : {};
      /** A relay as the agent sends it, a while after what it answers. */
      const relay = (args: Record<string, unknown>) =>
        Effect.andThen(later, call("kin_relay", { ...args, ...urgent }));
      yield* sql`UPDATE kin_people SET display_name = 'Rhea Kapoor' WHERE person_id = ${owner.personId}`;
      const hours =
        phase === "off"
          ? '{"days":[1,2,3,4,5],"start":"10:00","end":"18:00"}'
          : '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}';
      const zone = phase === "off" ? "Asia/Kolkata" : "UTC";
      for (const [id, name, access] of [
        ["zoya", "Zoya Sheikh", "member"],
        ["dev", "Dev Kulkarni", "member"],
        ["meera", "Meera Iyer", "co_owner"],
      ] as const) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone, work_hours_json)
        VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, ${access}, ${zone}, ${hours})`;
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
          VALUES (${`${id}-session`}, ${orgId}, ${id}, 0)`;
      }
      const person = (id: string) => ({
        _tag: "person" as const,
        orgId,
        personId: KinPersonId.make(id),
      });
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
      yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
      const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
        'chief-of-staff')`;
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
      VALUES (${orgId}, ${chief}, ${owner.personId}, 0)`;
      const direct = Effect.fn("test.direct")(function* (id: string) {
        return (yield* chats.createDirect(person(id), { orgId, agentId: chief })).chatId;
      });
      const zoyasChat = yield* direct("zoya");
      const meerasChat = yield* direct("meera");

      /** Someone writes; the lead wakes on it, as the queue claims it. Returns the event id. */
      const says = Effect.fn("test.says")(function* (
        who: typeof owner | ReturnType<typeof person>,
        chatId: KinChatId,
        body: string,
      ) {
        const message: KinMessage = yield* chats.send(who, {
          chatId,
          body,
          clientMessageId: body,
        });
        const wakeupId = yield* startAgentWakeup({ orgId, agentId: chief, threadId, message });
        return `event:${wakeupId}`;
      });
      /** The lead's own reply in the chat its turn answers, as the reply bridge posts it. */
      const replies = Effect.fn("test.replies")(function* (chatId: KinChatId, body: string) {
        const { agent, post } = yield* agentServices.pipe(
          Effect.provideService(McpInvocationContext, scope),
        );
        return yield* post(agent, { chatId, body, intent: "answer", clientMessageId: body });
      });
      const lastIn = (chatId: KinChatId) =>
        rowsIn(sql, orgId, chatId).pipe(Effect.map((rows) => rows.at(-1)));

      // The owner's setup turn: a project Dev leads and two late tasks of Zoya's.
      const setup = yield* says(owner, ownerChat, "Set up the Lumen Grove work.");
      // Haiku 5.5 evals: 10 writes refused for a message id passed as the event. Kin fills it in.
      const created = yield* call("record_create", {
        records: [
          { list: "projects", title: "Lumen Grove booking app", owner: "Dev Kulkarni" },
          { title: "Booking flow copy", owner: "Zoya Sheikh", due: "2026-11-10" },
          { title: "Clinic photo shortlist", owner: "Zoya Sheikh", due: "2026-11-12" },
        ],
      });
      assert.isTrue(created.ok, JSON.stringify(created.value));
      const task = (created.value.records as ReadonlyArray<{ key: string }>)[1]!.key;
      const [made] = yield* sql<{ origin: string }>`SELECT origin_key AS origin
        FROM kin_records WHERE org_id = ${orgId} AND key = ${task}`;
      assert.include(made?.origin, `:${setup}:`);
      const devsChat = yield* direct("dev");

      const outcomes: Array<readonly [string, string]> = [];
      const held: Array<{ route: string; chatId: KinChatId; author: string; body: string }> = [];
      const copies = (chatId: KinChatId, expected: { author: string; body: string }) =>
        rowsIn(sql, orgId, chatId).pipe(
          Effect.map(
            (rows) =>
              rows.filter(
                (row) => row.author === expected.author && row.body.includes(expected.body),
              ).length,
          ),
        );
      /** It is in their chat now; or nothing is, it waits in the store, and the agent was told 07:00. */
      const arrived = Effect.fn("test.arrived")(function* (
        route: string,
        result: { ok: boolean; value: Record<string, unknown> },
        chatId: KinChatId,
        expected: { author: string; body: string },
      ) {
        const last = yield* lastIn(chatId);
        if (!result.ok) return outcomes.push([route, `refused: ${JSON.stringify(result.value)}`]);
        if (last?.author === expected.author && last.body.includes(expected.body))
          return outcomes.push([route, "arrived"]);
        const [waiting] = yield* sql`SELECT 1 FROM kin_held_posts WHERE org_id = ${orgId}
          AND chat_id = ${chatId} AND delivered_at IS NULL AND instr(body, ${expected.body}) > 0`;
        const note = result.value.note;
        if (waiting === undefined || (yield* copies(chatId, expected)) > 0)
          return outcomes.push([route, `missing: ${JSON.stringify(last)}`]);
        if (typeof note === "string" && !note.includes(`${WAKE[phase].clock} their time`))
          return outcomes.push([route, `held, but the agent was told: ${note}`]);
        held.push({ route, chatId, ...expected });
        return outcomes.push([route, "held"]);
      });

      // Owner's chat → a teammate whose chat with the agent is empty.
      yield* sql`DELETE FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${devsChat}`;
      const ask = yield* says(owner, ownerChat, "Ask Dev whether the booking app is on track.");
      yield* arrived(
        "owner's chat → teammate, empty chat",
        yield* relay({
          to: "Dev",
          text: "Is the Lumen Grove booking app on track for the 30 Nov review?",
          sourceEventId: (yield* sql<{ messageId: string }>`SELECT json_extract(json, '$.messageId')
            AS "messageId" FROM kin_events WHERE event_id = ${ask}`)[0]!.messageId,
        }),
        devsChat,
        { author: "agent", body: "on track for the 30 Nov review" },
      );

      // Owner's chat → a teammate the agent answered last.
      const zoyaAsks = yield* says(person("zoya"), zoyasChat, "Can the copy task move a week?");
      yield* replies(zoyasChat, "I've sent this to Rhea and will tell you what she decides.");
      yield* arrived(
        "teammate → owner",
        yield* relay({
          to: "Rhea Kapoor",
          text: "Can the booking flow copy move a week?",
          sourceEventId: zoyaAsks,
        }),
        ownerChat,
        { author: "agent", body: '"Can the booking flow copy move a week?"' },
      );
      const answer = yield* says(owner, ownerChat, "Yes, move it to 18 December.");
      yield* call("record_update", { key: task, sourceEventId: answer, due: "2026-12-18" });
      yield* arrived(
        "owner's answer → the teammate who asked, agent spoke last",
        yield* relay({
          to: "Zoya",
          text: "Rhea says yes: the booking flow copy is now due 18 December.",
          sourceEventId: answer,
        }),
        zoyasChat,
        { author: "agent", body: "now due 18 December" },
      );

      // Teammate → the lead of a project they work on.
      const toLead = yield* says(person("zoya"), zoyasChat, "Can Dev review my copy first?");
      yield* arrived(
        "teammate → project lead",
        yield* relay({
          to: "Dev Kulkarni",
          text: "Could you review the booking flow copy before it ships?",
          sourceEventId: toLead,
        }),
        devsChat,
        { author: "agent", body: "review the booking flow copy" },
      );

      // Owner's chat → a teammate whose own message waits on the agent's reply: the relay posts,
      // and the reply she is owed still does.
      yield* chats.send(person("zoya"), {
        chatId: zoyasChat,
        body: "Also, where are the brand files?",
        clientMessageId: "brand-files",
      });
      const meeting = yield* says(owner, ownerChat, "Ask Zoya how the meeting went.");
      yield* arrived(
        "owner's chat → teammate, her reply pending",
        yield* relay({
          to: "Zoya Sheikh",
          text: "How did yesterday's booking-flow review with Lumen Grove go?",
          sourceEventId: meeting,
        }),
        zoyasChat,
        { author: "agent", body: "How did yesterday's booking-flow review" },
      );
      const owed = yield* chats.send(person("zoya"), {
        chatId: zoyasChat,
        body: "And the brand files?",
        clientMessageId: "brand-files-again",
      });
      yield* startAgentWakeup({ orgId, agentId: chief, threadId, message: owed });
      yield* replies(zoyasChat, "The brand files are in the shared drive under Lumen Grove.");
      yield* arrived("the teammate's own reply after a relay", { ok: true, value: {} }, zoyasChat, {
        author: "agent",
        body: "shared drive",
      });

      // A co-owner's chat → a teammate.
      const coOwner = yield* says(person("meera"), meerasChat, "Tell Dev the client call moved.");
      yield* arrived(
        "co-owner's chat → teammate",
        yield* relay({
          to: "Dev",
          text: "The Lumen Grove call moved to Thursday at 3 pm.",
          sourceEventId: coOwner,
        }),
        devsChat,
        { author: "agent", body: "moved to Thursday" },
      );

      // A check-in → a teammate: its nudge and its relay, one path.
      const checkIn = yield* startAgentWakeup({
        orgId,
        agentId: chief,
        threadId,
        event: (base) => ({
          ...base,
          _tag: "pulse",
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId: KinMemoryItemId.make("checkin-morning"),
            title: "Morning check-in",
            what: "Morning check-in.",
            slot: "2026-11-16T06:00:00.000Z",
          },
        }),
      });
      const pulse = yield* call("pulse_read", {});
      yield* later;
      const late = (pulse.value.facts as ReadonlyArray<{ key: string }>).find((fact) =>
        fact.key.startsWith("task_late"),
      );
      assert.isDefined(late, JSON.stringify(pulse.value));
      yield* arrived(
        "check-in nudge → teammate",
        yield* call("pulse_nudge", {
          person: "Zoya Sheikh",
          factKey: late!.key,
          text: "The booking flow copy is past its date: is anything blocking it?",
        }),
        zoyasChat,
        { author: "agent", body: "is anything blocking it?" },
      );
      yield* arrived(
        "check-in relay → teammate",
        yield* relay({
          to: "Dev Kulkarni",
          text: "Morning: the booking app review is Thursday.",
          sourceEventId: `event:${checkIn}`,
        }),
        devsChat,
        { author: "agent", body: "review is Thursday" },
      );

      // Assignment and hand-back notices: Kin's own rows, in the person's chat with the agent.
      const give = yield* says(owner, ownerChat, "Give the copy task to Dev.");
      yield* later;
      yield* arrived(
        "assignment notice → new holder",
        yield* call("record_assign", {
          sourceEventId: give,
          tasks: [{ key: task, to: "Dev Kulkarni", reason: "Zoya is on leave" }],
        }),
        devsChat,
        { author: "system", body: `Chief of staff gave you ${task}` },
      );
      // As the owner's own Tasks screen gives it: handed back, it goes to him, not the agent.
      yield* sql`UPDATE kin_records SET assigned_by_person_id = ${owner.personId}, assigned_by_agent_id = NULL
        WHERE org_id = ${orgId} AND key = ${task}`;
      const handBack = yield* says(person("dev"), devsChat, "I can't take the copy task.");
      yield* later;
      yield* arrived(
        "hand-back notice → who gave it",
        yield* call("record_hand_back", {
          key: task,
          sourceEventId: handBack,
          note: "No time before the release",
        }),
        ownerChat,
        { author: "system", body: `Dev Kulkarni handed ${task} Booking flow copy back` },
      );

      // A message to a person never takes a chat's floor: the agent answered Zoya twice, once each.
      const [run] = yield* sql<{ turns: number }>`SELECT agent_turns AS turns FROM kin_floor_runs
      WHERE org_id = ${orgId} AND chat_id = ${zoyasChat} ORDER BY opened_at DESC, rowid DESC LIMIT 1`;
      assert.strictEqual(run?.turns, 1);

      // Whatever the hour, a relay answering what she wrote a few minutes ago goes now.
      yield* chats.send(person("zoya"), {
        chatId: zoyasChat,
        body: "Is Thursday's review still on?",
        clientMessageId: "review-on",
      });
      yield* TestClock.adjust("5 minutes");
      const fresh = yield* says(owner, ownerChat, "Tell Zoya the review is still on.");
      yield* arrived(
        "a relay answering her message from 5 minutes ago",
        yield* call("kin_relay", {
          to: "Zoya",
          text: "Yes, Thursday's review is still on.",
          sourceEventId: fresh,
        }),
        zoyasChat,
        { author: "agent", body: "still on" },
      );

      // When they are free: each held message is in its chat once, Dev's in the order sent.
      yield* TestClock.setTime(WAKE[phase].at - 60_000);
      assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
      yield* TestClock.setTime(WAKE[phase].at);
      yield* deliverHeld(orgId, chats);
      assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
      for (const one of held)
        outcomes.push([
          one.route,
          (yield* copies(one.chatId, one)) === 1 ? "arrived when free, once" : "not delivered once",
        ]);
      const devs = yield* rowsIn(sql, orgId, devsChat);
      const order = held
        .filter((one) => one.chatId === devsChat)
        .map((one) => devs.findIndex((row) => row.body.includes(one.body)));
      assert.deepStrictEqual(
        order,
        order.toSorted((a, b) => a - b),
      );

      return outcomes;
    }).pipe(Effect.provide(layer)),
  );

const ROUTES = [
  "owner's chat → teammate, empty chat",
  "teammate → owner",
  "owner's answer → the teammate who asked, agent spoke last",
  "teammate → project lead",
  "owner's chat → teammate, her reply pending",
  "the teammate's own reply after a relay",
  "co-owner's chat → teammate",
  "check-in nudge → teammate",
  "check-in relay → teammate",
  "assignment notice → new holder",
  "hand-back notice → who gave it",
  "a relay answering her message from 5 minutes ago",
];
/** Every route, `now` arriving at once and the rest held, then each of those delivered once. */
const expected = (now: ReadonlyArray<string>): Array<readonly [string, string]> => [
  ...ROUTES.map((route) => [route, now.includes(route) ? "arrived" : "held"] as const),
  ...ROUTES.filter((route) => !now.includes(route)).map(
    (route) => [route, "arrived when free, once"] as const,
  ),
];
const ANSWERS = ["the teammate's own reply after a relay", ROUTES[11]!];

it.effect("every route a message to a person takes arrives in their chat", () =>
  Effect.map(routes("day"), (outcomes) => assert.deepStrictEqual(outcomes, expected(ROUTES))),
);

it.effect("in their quiet hours every route is held and arrives at 07:00, once", () =>
  Effect.map(routes("night"), (outcomes) => assert.deepStrictEqual(outcomes, expected(ANSWERS))),
);

it.effect("an urgent relay arrives in their quiet hours; nudges and notices wait", () =>
  Effect.map(routes("urgent"), (outcomes) =>
    assert.deepStrictEqual(
      outcomes,
      expected(
        ROUTES.filter(
          (route) =>
            !["check-in nudge → teammate", "assignment notice → new holder", ROUTES[10]].includes(
              route,
            ),
        ),
      ),
    ),
  ),
);

it.effect("outside their working hours, on their own clock, it waits until they start", () =>
  Effect.map(routes("off"), (outcomes) =>
    assert.deepStrictEqual(
      outcomes,
      expected([...ANSWERS, "teammate → owner", "hand-back notice → who gave it"]),
    ),
  ),
);

it.effect("a visual in a teammate's chat goes only when everyone there may see its figures", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(AuthSessionId.make("owner"));
      const [resolved] = yield* identity.resolve({
        sessionId: AuthSessionId.make("owner"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      });
      const owner = resolved!;
      const { orgId } = owner;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone)
        VALUES ('zoya', ${orgId}, 'zoya', 'Zoya Sheikh', ${at}, 'member', 'UTC')`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
      yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
      const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
          worker_projects_json, owner_chat_id, domain)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
          'chief-of-staff')`;
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, ${chief}, ${owner.personId}, 0)`;
      const zoya = { _tag: "person" as const, orgId, personId: KinPersonId.make("zoya") };
      const zoyasChat = (yield* chats.createDirect(zoya, { orgId, agentId: chief })).chatId;
      const says = Effect.fn("test.says")(function* (
        who: typeof owner | typeof zoya,
        chatId: KinChatId,
        body: string,
      ) {
        const message: KinMessage = yield* chats.send(who, { chatId, body, clientMessageId: body });
        return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
      });
      // An invoice only the owner sees: its sum is a figure Zoya may not read.
      const asked = yield* says(owner, ownerChat, "Track invoices");
      const setup = yield* call("record_create", {
        sourceEventId: asked,
        records: [{ list: "invoices", title: "Invented retainer", amount: "47,200" }],
      });
      assert.isTrue(setup.ok, JSON.stringify(setup.value));
      const visual = (title: string, figure: string) =>
        call("kin_visual", {
          title,
          html: `<div><b>${title}</b><p>${figure}</p></div>`,
          height: 120,
        });
      yield* says(zoya, zoyasChat, "Show me my week as a picture");
      // This fixture stores no files, so a page that passes every check stops at storing it.
      const mine = yield* visual("Your week", "7 tasks done, 2 waiting");
      assert.strictEqual(mine.value.message, "Attachments are unavailable.");
      const hidden = yield* visual("This month", "47200 billed");
      assert.isFalse(hidden.ok);
      assert.match(String(hidden.value.message), /not everyone in this chat may see/);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a teammate sets a reminder for themselves, in their own chat, and nothing more", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(AuthSessionId.make("owner"));
      const [resolved] = yield* identity.resolve({
        sessionId: AuthSessionId.make("owner"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      });
      const owner = resolved!;
      const { orgId } = owner;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone)
        VALUES ('zoya', ${orgId}, 'zoya', 'Zoya Sheikh', ${at}, 'member', 'UTC')`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
      yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
      const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
          worker_projects_json, owner_chat_id, domain)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
          'chief-of-staff')`;
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, ${chief}, ${owner.personId}, 0)`;
      const zoya = { _tag: "person" as const, orgId, personId: KinPersonId.make("zoya") };
      const zoyasChat = (yield* chats.createDirect(zoya, { orgId, agentId: chief })).chatId;
      const message = yield* chats.send(zoya, {
        chatId: zoyasChat,
        body: "Remind me Friday at 10 to send the Lumen mockups",
        clientMessageId: "remind-friday",
      });
      const asked = `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
      const defer = (args: Record<string, unknown>) =>
        call("kin_defer", {
          what: "Send the Lumen mockups",
          due: "2026-11-20T10:00:00+00:00",
          onDue: "remind",
          chatId: zoyasChat,
          sourceEventId: asked,
          ...args,
        });
      // Listed on her turns, and hers, in her chat with the agent: set.
      assert.isTrue(listedOnSharedThread("kin_defer"));
      const set = yield* defer({});
      assert.isTrue(set.ok, JSON.stringify(set.value));
      assert.strictEqual(set.value.itemId, "def-Send the Lumen mockups");
      // Anything that would message someone else or start work: refused.
      for (const other of [
        { chatId: ownerChat },
        { onDue: "start" },
        { onDue: "chase" },
        { onDue: "ask" },
      ]) {
        const refused = yield* defer({ ...other, what: `Other ${JSON.stringify(other)}` }).pipe(
          Effect.flip,
        );
        assert.strictEqual(refused.message, SHARED_REFUSAL, JSON.stringify(other));
      }
      // Moving or cancelling one reaches LeadMemory, which lets through only her own.
      assert.isTrue(listedOnSharedThread("kin_cancel"));
      assert.isTrue((yield* defer({ replaces: "def-Send the Lumen mockups" })).ok);
      assert.isTrue(
        (yield* call("kin_cancel", { itemId: "def-Send the Lumen mockups", sourceEventId: asked }))
          .ok,
      );
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a held message follows its reader's changed clock", () =>
  Effect.andThen(
    // Monday 18:30 in India: Zoya, there, works 10:00 to 18:00, so a relay waits for Tuesday.
    TestClock.setTime(Date.UTC(2026, 10, 16, 13)),
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      const sql = yield* SqlClient.SqlClient;
      yield* pairSession(AuthSessionId.make("owner"));
      const [resolved] = yield* identity.resolve({
        sessionId: AuthSessionId.make("owner"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: AuthStandardClientScopes,
      });
      const owner = resolved!;
      const { orgId } = owner;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone, work_hours_json)
        VALUES ('zoya', ${orgId}, 'zoya', 'Zoya Sheikh', ${at}, 'member', 'Asia/Kolkata',
          '{"days":[1,2,3,4,5],"start":"10:00","end":"18:00"}')`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
      yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
      const ownerChat = (yield* chats.createDirect(owner, { orgId, agentId: chief })).chatId;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
          worker_projects_json, owner_chat_id, domain)
        VALUES (${chief}, ${orgId}, 'Chief of staff', 0, ${threadId}, '{}', '[]', ${ownerChat},
          'chief-of-staff')`;
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, ${chief}, ${owner.personId}, 0)`;
      const zoya = { _tag: "person" as const, orgId, personId: KinPersonId.make("zoya") };
      yield* chats.createDirect(zoya, { orgId, agentId: chief });
      const says = Effect.fn("test.says")(function* (body: string) {
        const message = yield* chats.send(owner, {
          chatId: ownerChat,
          body,
          clientMessageId: body,
        });
        return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
      });
      const deliverAt = sql<{ at: number }>`SELECT deliver_at AS at FROM kin_held_posts
        WHERE org_id = ${orgId} AND person_id = 'zoya' AND delivered_at IS NULL`;
      const ask = yield* says("Tell Zoya the review moved to Thursday.");
      const sent = yield* call("kin_relay", {
        to: "Zoya",
        text: "The review moved to Thursday.",
        sourceEventId: ask,
      });
      assert.isTrue(sent.ok, JSON.stringify(sent.value));
      assert.deepStrictEqual(yield* deliverAt, [{ at: Date.UTC(2026, 10, 17, 4, 30) }]);
      // She moves to London, where it is 13:00 on a working day: it goes now.
      yield* says("Zoya is in London now.");
      const moved = yield* call("people_update", {
        person: "Zoya Sheikh",
        timeZone: "Europe/London",
      });
      assert.isTrue(moved.ok, JSON.stringify(moved.value));
      assert.deepStrictEqual(yield* deliverAt, [{ at: yield* Clock.currentTimeMillis }]);
      // Away until Thursday on her calendar: what waits for her waits for her first working hour
      // back, and the asking chat says when it arrives. "I'm back" lets it all go.
      const zoyaId = KinPersonId.make("zoya");
      const setAway = (day: string | null) =>
        reholdAfter(
          orgId,
          zoyaId,
          sql`UPDATE kin_people SET away_until = ${day} WHERE person_id = ${zoyaId}`,
        );
      yield* setAway("2026-11-19");
      const thursday = Date.UTC(2026, 10, 19, 10);
      assert.deepStrictEqual(yield* deliverAt, [{ at: thursday }]);
      const signed = yield* says("Tell Zoya the client signed.");
      const away = yield* call("kin_relay", {
        to: "Zoya",
        text: "The client signed.",
        sourceEventId: signed,
      });
      assert.include(
        String(away.value.note),
        "Zoya Sheikh is away until 10:00 their time (Thu 19 Nov)",
      );
      const [arrives] = yield* sql<{ body: string; when: string }>`SELECT body, when_json AS "when"
        FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${ownerChat}
          AND message_id LIKE 'kin-arrives:%' ORDER BY seq DESC LIMIT 1`;
      assert.strictEqual(
        arrives?.body,
        "Zoya Sheikh is away: it arrives at 10:00 am their time (Thu 19 Nov).",
      );
      assert.deepStrictEqual(JSON.parse(arrives?.when ?? "null"), {
        at: DateTime.formatIso(DateTime.makeUnsafe(thursday)),
        zone: "Europe/London",
        text: "10:00 am their time (Thu 19 Nov)",
        of: "Zoya Sheikh",
      });
      yield* setAway(null);
      const now = yield* Clock.currentTimeMillis;
      assert.deepStrictEqual(yield* deliverAt, [{ at: now }, { at: now }]);
    }).pipe(Effect.provide(layer)),
  ),
);
