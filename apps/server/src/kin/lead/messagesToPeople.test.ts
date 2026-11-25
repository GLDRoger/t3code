import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "./layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  type KinMessage,
  KinMessageId,
  KinMemoryItemId,
  type KinOrgId,
  KinPersonId,
  KinWakeupId,
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
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
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
import * as OwnerWork from "../work/ownerWork.ts";
import { reholdAfter } from "../triggers/quietHold.ts";
import * as People from "../people/KinPeople.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { SHARED_REFUSAL } from "./Audience.ts";
import { listedOnSharedThread } from "./SharedTools.ts";

const chief = KinAgentId.make("chief");
const threadId = ThreadId.make("chief-thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";

/** `personId` has signed in to Kin: a device session bound to them that is still live. */
const signIn = (orgId: string, personId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${`${personId}-session`}, ${personId}, '[]', 'bearer-access-token', ${at},
        '9999-12-31T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES (${`${personId}-session`}, ${orgId}, ${personId}, 0)`;
  });
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
          Effect.succeed({
            itemId: KinMemoryItemId.make(`def-${input.what}`),
            scheduled: "reminder" as const,
          }),
        // Says which event reached it, so a test sees what the tool gate filled in.
        cancel: (_scope, input) =>
          Effect.succeed({
            itemId: input.itemId,
            outcome: "stopped" as const,
            title: input.sourceEventId,
          }),
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
      Layer.provide(
        Layer.mock(KinAttachmentStore)({
          storePage: () => Effect.succeed("kin-chat-team-week-html"),
        }),
      ),
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
        yield* signIn(orgId, id);
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
          (yield* copies(one.chatId, one)) === 1
            ? "arrived when free, once"
            : one.route === UNHEARD && (yield* copies(one.chatId, one)) === 0
              ? "dropped, no longer theirs"
              : "not delivered once",
        ]);
      const devs = yield* rowsIn(sql, orgId, devsChat);
      const order = held
        .filter((one) => one.chatId === devsChat && one.route !== UNHEARD)
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
// Dev hands the task back before his held notice of it posts: it is no longer his to hear of.
const UNHEARD = ROUTES[9]!;
/** Every route, `now` arriving at once and the rest held, then each of those delivered once. */
const expected = (now: ReadonlyArray<string>): Array<readonly [string, string]> => [
  ...ROUTES.map((route) => [route, now.includes(route) ? "arrived" : "held"] as const),
  ...ROUTES.filter((route) => !now.includes(route)).map(
    (route) =>
      [route, route === UNHEARD ? "dropped, no longer theirs" : "arrived when free, once"] as const,
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
      const mine = yield* visual("Your week", "7 tasks done, 2 waiting");
      assert.isTrue(mine.ok);
      assert.match(String(mine.value.figure), /kin-figure:f_[A-Za-z0-9_-]{10}/);
      // The result says where the person sees it, so the reply needs no marker of its own.
      assert.match(String(mine.value.next), /^Made\. The page shows under your reply/);
      const hidden = yield* visual("This month", "47200 billed");
      assert.isFalse(hidden.ok);
      assert.match(String(hidden.value.message), /not everyone in this chat may see/);
      const chart = (values: ReadonlyArray<number>, money: boolean) =>
        call("kin_chart", {
          chart: "bar",
          title: "This week",
          unit: money ? { kind: "money", currency: "INR" } : { kind: "count" },
          labels: ["Mon", "Tue", "Wed"],
          series: [{ name: "Invoiced", values }],
        });
      const hiddenChart = yield* chart([4_720_000, 100, 200], true);
      assert.isFalse(hiddenChart.ok);
      assert.match(String(hiddenChart.value.message), /not everyone in this chat may see/);
      const shared = yield* chart([7, 2, 1], false);
      assert.isTrue(shared.ok, String(shared.value.message));
      assert.match(String(shared.value.figure), /kin-figure:f_[A-Za-z0-9_-]{10}/);
      assert.match(String(shared.value.next), /^Made\. The chart shows under your reply/);
      const [turn] = yield* sql<{
        wakeupId: string;
      }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
        WHERE org_id = ${orgId} AND agent_id = ${chief} AND status = 'running'`;
      const lead = Option.getOrThrow(
        yield* identity.agentForWakeup({ orgId, wakeupId: KinWakeupId.make(turn!.wakeupId) }),
      );
      yield* chats.send(lead, {
        chatId: zoyasChat,
        body: "A few tasks this week.",
        clientMessageId: "shared-figure",
        placeReplyFigures: true,
        intent: "answer",
      });
      const history = yield* chats.history(zoya, { chatId: zoyasChat, beforeSeq: 99, limit: 20 });
      const replies = history.messages.filter((message) => message.author._tag === "agent");
      assert.lengthOf(replies, 1);
      assert.deepStrictEqual(
        replies[0]?.embeds?.map((embed) => embed._tag),
        ["visual", "chart"],
      );
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
      // An event from an earlier turn, such as the message that set it up, names this turn.
      const earlier = yield* call("kin_cancel", {
        itemId: "def-Send the Lumen mockups",
        sourceEventId: "event:an-earlier-turn",
      });
      assert.strictEqual(earlier.value.title, asked);
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
      yield* signIn(orgId, "zoya");
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

// Ambermill, 22 Nov: a long message held for a teammate's next morning was sent again as urgent,
// and the held copy stayed queued to arrive a second time.
it.effect("an urgent message replaces what the agent held for them from the same chat", () =>
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
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone)
        VALUES ('meera', ${orgId}, 'meera', 'Meera Iyer', ${at}, 'co_owner', 'Asia/Kolkata')`;
      yield* signIn(orgId, "zoya");
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
      const person = (id: string) => ({
        _tag: "person" as const,
        orgId,
        personId: KinPersonId.make(id),
      });
      const zoyasChat = (yield* chats.createDirect(person("zoya"), { orgId, agentId: chief }))
        .chatId;
      const meerasChat = (yield* chats.createDirect(person("meera"), { orgId, agentId: chief }))
        .chatId;
      const says = Effect.fn("test.says")(function* (
        who: typeof owner | ReturnType<typeof person>,
        chatId: KinChatId,
        body: string,
      ) {
        const message = yield* chats.send(who, { chatId, body, clientMessageId: body });
        return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
      });
      const waiting = sql<{ body: string }>`SELECT body FROM kin_held_posts
        WHERE org_id = ${orgId} AND person_id = 'zoya' AND delivered_at IS NULL ORDER BY held_at`;
      const inHerChat = (text: string) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
          WHERE org_id = ${orgId} AND chat_id = ${zoyasChat} AND body = ${text}`.pipe(
          Effect.map((rows) => rows[0]!.n),
        );

      // A message with the pointers asked for is well past a line; past 2,000 it is refused.
      const pointers = Array.from(
        { length: 9 },
        (_, n) => `Pointer ${n + 1}: open Tasks, pick the Lumen Grove brochure, and add a note.`,
      ).join(" ");
      assert.isAbove(pointers.length, 600);
      const ask = yield* says(owner, ownerChat, "Give Zoya some pointers for using Kin.");
      const tooLong = yield* Effect.flip(
        call("kin_relay", { to: "Zoya", text: "x".repeat(2_001), sourceEventId: ask }),
      );
      assert.include(tooLong.message, "text is 2001 characters; at most 2000");
      const first = yield* call("kin_relay", { to: "Zoya", text: pointers, sourceEventId: ask });
      assert.isTrue(first.ok, JSON.stringify(first.value));
      // Meera's own request to her, held from another chat, is not this one.
      const meeras = yield* says(person("meera"), meerasChat, "Tell Zoya the call moved.");
      const other = yield* call("kin_relay", {
        to: "Zoya",
        text: "The Lumen Grove call moved to Thursday.",
        sourceEventId: meeras,
      });
      assert.isTrue(other.ok, JSON.stringify(other.value));
      assert.deepStrictEqual(yield* waiting, [
        { body: pointers },
        { body: "The Lumen Grove call moved to Thursday." },
      ]);
      // As an older build left it: the held copy stays after the urgent one went.
      yield* sql`CREATE TEMP TABLE old_hold AS SELECT * FROM kin_held_posts
        WHERE org_id = ${orgId} AND body = ${pointers}`;

      const now = yield* says(owner, ownerChat, "Alert her today anyway.");
      const urgent = yield* call("kin_relay", {
        to: "Zoya",
        text: pointers,
        sourceEventId: now,
        urgent: "The owner asked for it today",
      });
      assert.isTrue(urgent.ok, JSON.stringify(urgent.value));
      assert.strictEqual(
        urgent.value.note,
        "Sent in Zoya Sheikh's chat with you; their answer arrives there. This replaced your held message to Zoya Sheikh.",
      );
      assert.deepStrictEqual(yield* waiting, [{ body: "The Lumen Grove call moved to Thursday." }]);
      assert.strictEqual(yield* inHerChat(pointers), 1);

      // Her morning: what an older build held is dropped, as its urgent twin went; Meera's goes.
      yield* sql`INSERT INTO kin_held_posts SELECT * FROM old_hold`;
      yield* TestClock.setTime(Date.UTC(2026, 10, 17, 4, 30));
      assert.strictEqual(yield* deliverHeld(orgId, chats), 1);
      assert.strictEqual(yield* inHerChat(pointers), 1);
      assert.strictEqual(yield* inHerChat("The Lumen Grove call moved to Thursday."), 1);
      assert.deepStrictEqual(
        yield* sql`SELECT body FROM kin_held_posts WHERE org_id = ${orgId} AND body = ${pointers}`,
        [],
      );
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect(
  "a teammate says she is away in her own chat: what waits for her goes once she is back",
  () =>
    Effect.andThen(
      // Monday 11:30 in India, inside Zoya's working hours there.
      TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
      Effect.gen(function* () {
        const services = Option.getOrThrow((yield* Kin.KinServer).services);
        const identity = Context.get(services, KinIdentity);
        const chats = Context.get(services, KinChatService);
        const sql = yield* SqlClient.SqlClient;
        yield* pairSession(AuthSessionId.make("owner"));
        const session = {
          sessionId: AuthSessionId.make("owner"),
          subject: "browser",
          method: "browser-session-cookie",
          scopes: AuthStandardClientScopes,
        } as const;
        const owner = (yield* identity.resolve(session))[0]!;
        const { orgId } = owner;
        const zoyaId = KinPersonId.make("zoya");
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone, work_hours_json)
        VALUES (${zoyaId}, ${orgId}, 'zoya', 'Zoya Sheikh', ${at}, 'member', 'Asia/Kolkata',
          '{"days":[1,2,3,4,5],"start":"10:00","end":"18:00"}')`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, time_zone)
        VALUES ('dev', ${orgId}, 'dev', 'Dev Kulkarni', ${at}, 'member', 'Asia/Kolkata')`;
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30',
            '18:30', '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')
          ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
        yield* signIn(orgId, zoyaId);
        yield* sql`UPDATE kin_people SET display_name = 'Rhea Kapoor' WHERE person_id = ${owner.personId}`;
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
        const zoya = { _tag: "person" as const, orgId, personId: zoyaId };
        const zoyasChat = (yield* chats.createDirect(zoya, { orgId, agentId: chief })).chatId;
        const says = Effect.fn("test.says")(function* (
          who: typeof owner | typeof zoya,
          chatId: KinChatId,
          body: string,
        ) {
          const message = yield* chats.send(who, { chatId, body, clientMessageId: body });
          return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
        });
        // Her profile as agents read it: the same column her profile screen reads and sets.
        // The answer is the roster itself, not the roster encoded again inside a string.
        const awayUntil = call("people_read", {}).pipe(
          Effect.map(({ value }) => {
            assert.isArray(value.people);
            assert.isArray(value.agents);
            const people = value.people as ReadonlyArray<Record<string, unknown>>;
            return people.find((person) => person.name === "Zoya Sheikh")?.awayUntil;
          }),
        );

        const setup = yield* says(owner, ownerChat, "Set up the brochure work.");
        const created = yield* call("record_create", {
          sourceEventId: setup,
          records: [
            { title: "Invented brochure copy", owner: "Zoya Sheikh", due: "2026-11-10" },
            { title: "Invented brochure proof", owner: "Zoya Sheikh", due: "2026-11-17" },
            { title: "Invented price sheet", owner: "Rhea Kapoor" },
            { title: "Invented venue list", owner: "Rhea Kapoor" },
            { title: "Invented poster", owner: "Rhea Kapoor" },
            { title: "Invented flyer", owner: "Rhea Kapoor" },
            { title: "Invented banner", owner: "Rhea Kapoor" },
          ],
        });
        assert.isTrue(created.ok, JSON.stringify(created.value));
        const [, proof, prices, venues, poster, flyer, banner] = (
          created.value.records as ReadonlyArray<{ key: string }>
        ).map((record) => record.key);

        // In her own chat, her own words: her date, on the same field her profile screen sets.
        yield* says(zoya, zoyasChat, "I'm off till Wednesday.");
        const away = yield* call("away_set", { until: "2026-11-18" });
        assert.isTrue(away.ok, JSON.stringify(away.value));
        assert.deepInclude(away.value, {
          person: "Zoya Sheikh",
          until: "2026-11-18",
          dueWhileAway: 1,
          keys: [proof],
        });
        assert.strictEqual(yield* awayUntil, "2026-11-19");

        // Said in the team group and taken private, it is a copy in her chat, not her own word.
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
          VALUES ('ambermill-team', ${orgId}, 'team_group', 'Ambermill team', 0, ${at})`;
        for (const [member, kind, who] of [
          ["team-rhea", "person", owner.personId],
          ["team-zoya", "person", zoyaId],
          ["team-chief", "agent", chief],
        ] as const)
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
              person_id, agent_id, role, joined_at)
            VALUES (${member}, ${orgId}, 'ambermill-team', ${kind}, ${kind === "person" ? who : null},
              ${kind === "agent" ? who : null}, ${member === "team-rhea" ? "owner" : "member"}, ${at})`;
        const inGroup = yield* says(zoya, KinChatId.make("ambermill-team"), "I'm off till Monday.");
        const taken = yield* call("kin_take_private", { sourceEventId: inGroup });
        assert.isTrue(taken.ok, JSON.stringify(taken.value));
        const [copy] = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId"
          FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${zoyasChat}
            AND author_person_id = ${zoyaId} AND body = 'I''m off till Monday.'`;
        const copied = Option.getOrThrow(
          yield* Context.get(services, KinChatRepository).getMessage({
            orgId,
            messageId: KinMessageId.make(copy!.messageId),
          }),
        );
        yield* startAgentWakeup({ orgId, agentId: chief, threadId, message: copied });
        const fromCopy = yield* call("away_set", { until: "2026-11-23" });
        assert.isFalse(fromCopy.ok, JSON.stringify(fromCopy.value));
        assert.strictEqual(yield* awayUntil, "2026-11-19");

        // The owner, in his own chat, can't set it for her: there is no one else to name.
        yield* TestClock.adjust("11 minutes");
        yield* says(owner, ownerChat, "Zoya is away till Monday.");
        const forHer = yield* Effect.flip(
          call("away_set", { until: "2026-11-23", person: "Zoya" }),
        );
        assert.include(String(forHer.message), 'Unknown argument "person"');
        assert.strictEqual(yield* awayUntil, "2026-11-19");

        // An assignment notice, a hand-over, a relay and a late-work nudge each wait for her.
        const give = yield* says(owner, ownerChat, "Give the price sheet to Zoya.");
        const given = yield* call("record_assign", {
          sourceEventId: give,
          tasks: [{ key: prices, to: "Zoya Sheikh", reason: "She knows the client" }],
        });
        assert.isTrue(given.ok, JSON.stringify(given.value));
        // The giver reads that she waits, and until when on the owner's calendar, not that she knows.
        assert.deepStrictEqual(given.value, {
          toldLater: [
            "Zoya Sheikh is away until Thu 19 Nov, so they'll be told when they're back.",
          ],
          tasks: [{ key: prices, to: "Zoya Sheikh" }],
        });
        const handed = yield* OwnerWork.handOver([owner], {
          orgId,
          from: { _tag: "person", personId: owner.personId },
          to: { _tag: "person", personId: zoyaId },
          keys: [venues!],
        }).pipe(Effect.provide(Layer.succeedContext(services)));
        assert.deepStrictEqual(handed, { keys: [venues], kept: 0 });
        const signed = yield* says(owner, ownerChat, "Tell Zoya the client signed.");
        const relayed = yield* call("kin_relay", {
          to: "Zoya",
          text: "The client signed.",
          sourceEventId: signed,
        });
        assert.include(
          String(relayed.value.note),
          "Zoya Sheikh is away until 10:00 their time (Thu 19 Nov)",
        );
        yield* startAgentWakeup({
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
        const facts = (yield* call("pulse_read", {})).value.facts as ReadonlyArray<{ key: string }>;
        const late = facts.find((fact) => fact.key.startsWith("task_late"));
        assert.isDefined(late, JSON.stringify(facts));
        const nudged = yield* call("pulse_nudge", {
          person: "Zoya Sheikh",
          factKey: late!.key,
          text: "The brochure copy is past its date: is anything blocking it?",
        });
        assert.isTrue(nudged.ok, JSON.stringify(nudged.value));

        // A third task waits with the others; one moved on to Dev before she is back is never
        // hers to hear of, and Dev hears of it now; one given with tell: false holds nothing.
        const more = yield* says(owner, ownerChat, "Give Zoya the poster and the flyer.");
        for (const key of [poster, flyer]) {
          const one = yield* call("record_assign", {
            sourceEventId: more,
            tasks: [{ key, to: "Zoya Sheikh", reason: "She drew the last one" }],
          });
          assert.isTrue(one.ok, JSON.stringify(one.value));
        }
        const onward = yield* says(owner, ownerChat, "Actually, the flyer is Dev's.");
        assert.deepInclude(
          (yield* call("record_assign", {
            sourceEventId: onward,
            tasks: [{ key: flyer, to: "Dev Kulkarni", reason: "Zoya is away" }],
          })).value,
          { told: ["Dev Kulkarni"] },
        );
        const quiet = yield* says(owner, ownerChat, "Give Zoya the banner, don't tell her yet.");
        assert.deepStrictEqual(
          (yield* call("record_assign", {
            sourceEventId: quiet,
            tell: false,
            tasks: [{ key: banner, to: "Zoya Sheikh", reason: "She has the files" }],
          })).value,
          { held: ["Zoya Sheikh"], tasks: [{ key: banner, to: "Zoya Sheikh" }] },
        );
        const holders = yield* sql<{ key: string; owner: string }>`SELECT key, owner_id AS owner
          FROM kin_records WHERE org_id = ${orgId} AND key IN ${sql.in([prices!, venues!, poster!, flyer!, banner!])}
          ORDER BY key`;
        assert.deepStrictEqual(Object.fromEntries(holders.map((row) => [row.key, row.owner])), {
          [prices!]: zoyaId,
          [venues!]: zoyaId,
          [poster!]: zoyaId,
          [flyer!]: "dev",
          [banner!]: zoyaId,
        });
        const told = (rows: ReadonlyArray<{ body: string }>) =>
          rows.filter((row) =>
            [prices!, venues!, poster!, flyer!, banner!].some((key) => row.body.includes(key)),
          );
        assert.deepStrictEqual(told(yield* rowsIn(sql, orgId, zoyasChat)), []);
        const [devsChat] = yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId"
          FROM kin_chats WHERE org_id = ${orgId} AND direct_key = ${`dev:${chief}`}`;

        // Thursday 10:00 her time, her first working hour back: each goes once.
        const back = Date.UTC(2026, 10, 19, 4, 30);
        const waiting = yield* sql<{ at: number }>`SELECT deliver_at AS at FROM kin_held_posts
        WHERE org_id = ${orgId} AND person_id = ${zoyaId} AND delivered_at IS NULL`;
        assert.deepStrictEqual(
          waiting,
          Array.from({ length: 5 }, () => ({ at: back })),
        );
        yield* TestClock.setTime(back - 60_000);
        assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
        yield* TestClock.setTime(back);
        assert.strictEqual(yield* deliverHeld(orgId, chats), 3);
        assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
        const hers = yield* rowsIn(sql, orgId, zoyasChat);
        const [notice, ...again] = told(hers);
        assert.deepStrictEqual(again, []);
        // One message, worded from each task as it stands now. What Rhea gave on her screen is
        // no chat line: it is told in her banner, at the same minute.
        assert.strictEqual(
          notice?.body,
          [
            "Chief of staff gave you 2 tasks:",
            `• ${prices} Invented price sheet`,
            `• ${poster} Invented poster`,
          ].join("\n"),
        );
        assert.deepStrictEqual(
          yield* sql`SELECT json_extract(body, '$.key') AS key FROM kin_held_posts
            WHERE org_id = ${orgId} AND person_id = ${zoyaId} AND delivered_at = ${back}
              AND substr(kind, 1, 14) = 'kin-task-news:'`,
          [{ key: venues }],
        );
        for (const key of [flyer!, banner!])
          assert.isFalse(
            hers.some((row) => row.body.includes(key)),
            `${key}: ${JSON.stringify(hers)}`,
          );
        assert.lengthOf(
          (yield* rowsIn(sql, orgId, devsChat!.chatId)).filter((row) => row.body.includes(flyer!)),
          1,
        );
        for (const said of ["The client signed.", "anything blocking it?"])
          assert.strictEqual(
            hers.filter((row) => row.body.includes(said)).length,
            1,
            `${said}: ${JSON.stringify(hers)}`,
          );
        assert.isUndefined(yield* awayUntil);
      }).pipe(Effect.provide(layer)),
    ),
);

/**
 * Arjun writes in his chat that he is off and sets it on his Profile; minutes later the owner and a
 * co-owner give him tasks on their screens and Chief of staff gives two more. Then he is back: by
 * his date, by "I'm back", or across a restart after the walk's clock tool moved stored times.
 */
const awayThenBack = (how: "date" | "early" | "restart") =>
  Effect.andThen(
    // Thursday 19 Nov, 09:38 in India.
    TestClock.setTime(Date.UTC(2026, 10, 19, 4, 8)),
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      const identity = Context.get(services, KinIdentity);
      const chats = Context.get(services, KinChatService);
      // Profile's own service, as `kin.people.updateProfile` calls it.
      const people = yield* People.KinPeople.pipe(
        Effect.provide(
          People.layer.pipe(
            Layer.provide(
              Layer.mock(SessionStore)({ cookieName: "kin", legacyCookieName: undefined }),
            ),
            Layer.provide(Layer.succeedContext(services)),
          ),
        ),
      );
      const work = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(Layer.succeedContext(services)));
      const sql = yield* SqlClient.SqlClient;
      const sessionOf = (id: string) =>
        ({
          sessionId: AuthSessionId.make(id),
          subject: "browser",
          method: "browser-session-cookie",
          scopes: id === "owner" ? AuthStandardClientScopes : [AuthKinChatScope],
        }) as const;
      yield* pairSession(AuthSessionId.make("owner"));
      const owner = (yield* identity.resolve(sessionOf("owner")))[0]!;
      const { orgId } = owner;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:30',
          '18:30', '03:00', 0, 1, '09:00', '{"from":"22:00","to":"07:00"}')
        ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
      yield* sql`UPDATE kin_people SET display_name = 'Rhea Kapoor' WHERE person_id = ${owner.personId}`;
      for (const [id, name, access] of [
        ["arjun", "Arjun Rao", "member"],
        ["zoya", "Zoya Sheikh", "member"],
        ["meera", "Meera Iyer", "co_owner"],
      ] as const) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access, time_zone)
          VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, ${access}, 'Asia/Kolkata')`;
        yield* signIn(orgId, id);
      }
      const arjunId = KinPersonId.make("arjun");
      const arjun = { _tag: "person" as const, orgId, personId: arjunId };
      const meera = (yield* identity.resolve(sessionOf("meera-session")))[0]!;
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
      const arjunsChat = (yield* chats.createDirect(arjun, { orgId, agentId: chief })).chatId;
      const says = Effect.fn("test.says")(function* (body: string) {
        const message = yield* chats.send(owner, {
          chatId: ownerChat,
          body,
          clientMessageId: body,
        });
        return `event:${yield* startAgentWakeup({ orgId, agentId: chief, threadId, message })}`;
      });
      const created = yield* call("record_create", {
        sourceEventId: yield* says("Set up the reminder work."),
        records: [
          { title: "Invented reminder wording", owner: "Rhea Kapoor" },
          { title: "Invented clinic list", owner: "Rhea Kapoor" },
          { title: "Invented opt-out link", owner: "Rhea Kapoor" },
          { title: "Invented phone number screen", owner: "Rhea Kapoor" },
        ],
      });
      assert.isTrue(created.ok, JSON.stringify(created.value));
      const [wording, clinics, optOut, phone] = (
        created.value.records as ReadonlyArray<{ key: string }>
      ).map((record) => record.key);
      const keys = [wording!, clinics!, optOut!, phone!];

      // His own words in his chat, and the date on his Profile, as he sets it there.
      yield* chats.send(arjun, {
        chatId: arjunsChat,
        body: "I'm off till Monday 23 Nov.",
        clientMessageId: "off",
      });
      const set = yield* people.updateProfile(sessionOf("arjun-session"), {
        orgId,
        personId: arjunId,
        awayUntil: "2026-11-23",
      });
      assert.propertyVal(set, "awayUntil", "2026-11-23");

      // Minutes later: the owner and a co-owner on the Tasks screen, then Chief of staff.
      yield* TestClock.adjust("1 minute");
      const toArjun = { _tag: "person", personId: arjunId } as const;
      yield* work(OwnerWork.assign([owner], { orgId, key: wording!, to: toArjun }));
      yield* work(OwnerWork.assign([meera], { orgId, key: clinics!, to: toArjun }));
      const arjunReads = sql<{ body: string }>`SELECT m.body FROM kin_messages m
        JOIN kin_chat_members c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
          AND c.principal_kind = 'person' AND c.person_id = ${arjunId}
        WHERE m.org_id = ${orgId} ORDER BY m.created_at, m.seq`.pipe(
        Effect.map((rows) => rows.filter((row) => keys.some((key) => row.body.includes(key)))),
      );
      const toldOn = (who: typeof owner, key: string) =>
        work(OwnerWork.get([who], { orgId, key })).pipe(Effect.map((one) => one.toldWhenBack));
      // Nothing reaches him meanwhile (no line, so nothing rings); each giver reads the day.
      assert.deepStrictEqual(yield* arjunReads, []);
      assert.strictEqual(yield* toldOn(owner, wording!), "2026-11-23");
      assert.strictEqual(yield* toldOn(meera, clinics!), "2026-11-23");
      const given = yield* call("record_assign", {
        sourceEventId: yield* says("Give Arjun the opt-out link and the phone number screen."),
        tasks: [
          { key: optOut, to: "Arjun Rao", reason: "He built the reminders" },
          { key: phone, to: "Arjun Rao", reason: "He built the reminders" },
        ],
      });
      assert.deepStrictEqual(given.value, {
        toldLater: ["Arjun Rao is away until Mon 23 Nov, so they'll be told when they're back."],
        tasks: [
          { key: optOut, to: "Arjun Rao" },
          { key: phone, to: "Arjun Rao" },
        ],
      });
      assert.deepStrictEqual(yield* arjunReads, []);
      assert.strictEqual(yield* toldOn(owner, phone!), "2026-11-23");

      // One moved on to Zoya before he is back is never his to hear of.
      yield* work(
        OwnerWork.assign([owner], {
          orgId,
          key: optOut!,
          to: { _tag: "person", personId: KinPersonId.make("zoya") },
        }),
      );
      assert.isUndefined(yield* toldOn(owner, optOut!));
      assert.deepStrictEqual(yield* arjunReads, []);

      // Monday 07:00 his time: his quiet hours end on the day he is back.
      const back = Date.UTC(2026, 10, 23, 1, 30);
      if (how === "date") {
        yield* TestClock.setTime(back - 60_000);
        assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
        yield* TestClock.setTime(back);
      } else if (how === "early") {
        // Saturday noon his time, "I'm back" on his Profile.
        yield* TestClock.setTime(Date.UTC(2026, 10, 21, 6, 30));
        assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
        yield* people.updateProfile(sessionOf("arjun-session"), {
          orgId,
          personId: arjunId,
          awayUntil: null,
        });
      } else {
        // As `kv clock advance 6d` does with the server stopped: stored times move 144h back.
        const shift = 144 * 3_600_000;
        yield* sql`UPDATE kin_held_posts SET deliver_at = deliver_at - ${shift},
          held_at = held_at - ${shift} WHERE org_id = ${orgId}`;
        yield* sql`UPDATE kin_people SET away_until = date(away_until, '-6 days')
          WHERE org_id = ${orgId} AND away_until IS NOT NULL`;
      }
      // The first run (at start, then every tick) posts it once; later runs post nothing.
      assert.strictEqual(yield* deliverHeld(orgId, chats), 1);
      assert.strictEqual(yield* deliverHeld(orgId, chats), 0);
      assert.deepStrictEqual(yield* arjunReads, [
        {
          body: `Chief of staff gave you ${phone} Invented phone number screen.`,
        },
      ]);
      // What the owner and the co-owner gave on their screens is no chat line: one banner each
      // went with it, once.
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(body, '$.name') AS name, json_extract(body, '$.key') AS key
          FROM kin_held_posts WHERE org_id = ${orgId} AND person_id = ${arjunId}
            AND substr(kind, 1, 14) = 'kin-task-news:' AND delivered_at IS NOT NULL
          ORDER BY held_at, rowid`,
        [
          { name: "Rhea Kapoor", key: wording },
          { name: "Meera Iyer", key: clinics },
        ],
      );
      assert.isUndefined(yield* toldOn(owner, wording!));
    }).pipe(Effect.provide(layer)),
  );

it.effect("a task given to someone away waits for their date, as one message", () =>
  awayThenBack("date"),
);
it.effect("a task given to someone away reaches them once when they end it early", () =>
  awayThenBack("early"),
);
it.effect("a task given to someone away reaches them once after a restart past their date", () =>
  awayThenBack("restart"),
);
