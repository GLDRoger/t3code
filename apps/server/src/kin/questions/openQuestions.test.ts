import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  KinMemoryItemId,
  type KinMessageId,
  KinOrgId,
  type KinWakeupId,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinGroups } from "../chat/KinGroups.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { inheritOutside, markOutside, outsideStamp, storedStamp } from "../lead/OutsideContent.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import type { KinDecision } from "../memory/MemoryWriter.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Team from "../team/KinTeam.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { presetDefinition } from "../work/registers.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as Provision from "../lead/KinLeadProvision.ts";
import * as Reach from "../lead/Reach.ts";
import { encodeLeadModel } from "../lead/leadModels.ts";
import * as AskPerson from "./askPerson.ts";
import * as Questions from "./openQuestions.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { holdLine } from "../triggers/quietHold.ts";
import { defaultDue } from "./rules.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";
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
const scopeOf = (agent: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: agent,
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agent}-thread`),
    providerSessionId: agent,
    providerInstanceId,
  },
});

const kinServices = Layer.unwrap(
  Effect.gen(function* () {
    const services = Option.getOrThrow((yield* Kin.KinServer).services);
    return Layer.mergeAll(Handoff.layer, Team.layer, Layer.mock(LeadMemory)({})).pipe(
      Layer.provideMerge(Layer.succeedContext(services)),
    );
  }),
);
const layer = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
  KinToolGate.layer,
).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(kinServices),
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

/** A tool call exactly as an agent's provider sends it: its JSON answer, or its refusal. */
const callAs = Effect.fn("test.callAs")(function* (
  agent: string,
  name: string,
  args: Record<string, unknown>,
) {
  const server = yield* McpServer.McpServer;
  const identity = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinIdentity);
  const result = yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext, scopeOf(agent)),
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return { ok: result.isError !== true, value: JSON.parse(text) as Record<string, unknown> };
});

/**
 * Ambermill Studio (invented): Rhea owns it, Meera co-owns it, Dev is a member. Two agents, the
 * Chief of staff and Finance, each with a chat with Rhea; the company keeps India's clock.
 */
const ambermill = Effect.gen(function* () {
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
  yield* sql`UPDATE kin_people SET display_name = 'Rhea Rao' WHERE person_id = ${owner.personId}`;
  for (const [id, name, access] of [
    ["meera", "Meera Shah", "co_owner"],
    ["dev", "Dev Malhotra", "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, ${access})`;
  const chatOf = new Map<string, KinChatId>();
  for (const [id, name, domain] of [
    ["chief", "Chief of staff", "chief-of-staff"],
    ["finance", "Finance", "finance"],
  ] as const) {
    const agentId = KinAgentId.make(id);
    const threadId = ThreadId.make(`${id}-thread`);
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, ${name}, 'lead', ${owner.personId}, ${at})`;
    yield* identity.registerAgentThread({ orgId, agentId, threadId });
    const chatId = (yield* chats.createDirect(owner, { orgId, agentId })).chatId;
    chatOf.set(id, chatId);
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agentId}, ${orgId}, ${name}, 0, ${threadId}, '{}', '[]', ${chatId}, ${domain})`;
  }
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')
    ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
  yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
    VALUES (${orgId}, 'chief', ${owner.personId}, 0)`;
  /** A turn of `agent`'s, woken on `message` or, without one, on Kin's own event. */
  const wake = Effect.fn("test.wake")(function* (
    agent: string,
    message?: Effect.Success<ReturnType<typeof chats.send>>,
  ) {
    return yield* startAgentWakeup({
      orgId,
      agentId: KinAgentId.make(agent),
      threadId: ThreadId.make(`${agent}-thread`),
      ...(message === undefined ? {} : { message }),
    });
  });
  return { sql, chats, owner, orgId, services, chatOf: (id: string) => chatOf.get(id)!, wake };
});

const IST_MON_1130 = Date.UTC(2026, 10, 16, 6);
const TUE_1930 = Date.UTC(2026, 10, 17, 14);
const TUE_1930_ISO = "2026-11-17T14:00:00.000Z";

const reminderAsk = {
  question: "Shall I draft VIOM's payment reminder for INV-8?",
  options: [{ label: "Draft it" }, { label: "Leave it" }],
  default: "Draft it",
  about: ["INV-8"],
  intent: "draft payment reminder",
};

const questionRow = (sql: SqlClient.SqlClient, id: string) =>
  sql<{ state: string; raised: number | null; raiseWidget: string | null; answer: string | null }>`
    SELECT state, raised_at AS raised, raise_widget_id AS "raiseWidget", answer
    FROM kin_questions WHERE question_id = ${id}`.pipe(Effect.map((rows) => rows[0]!));
const dueEvents = (sql: SqlClient.SqlClient, orgId: string) =>
  sql<{ agent: string; key: string }>`SELECT agent_id AS agent, dedupe_key AS key FROM kin_events
    WHERE org_id = ${orgId} AND dedupe_key LIKE 'question:%' ORDER BY rowid`;

const settle = Effect.fn("test.settle")(function* (orgId: string, at: number) {
  yield* TestClock.setTime(at);
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  return yield* Questions.settleDue(KinOrgId.make(orgId), at, {
    chat: Context.get(services, KinChatService),
    queue: Context.get(services, KinEventQueue.KinEventQueue),
    records: Context.get(services, KinRecords),
  });
});

// Finance asks the owner with a default; the Chief of staff asking the same is refused; at the
// day Finance's default is taken once and its card says so; the card takes no tap after.
it.effect("a question is asked once, and its default is taken once at its day", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, services, chatOf, wake } = yield* ambermill;
      const repo = Context.get(services, KinChatRepository);
      yield* wake(
        "finance",
        yield* chats.send(owner, {
          chatId: chatOf("finance"),
          body: "What about VIOM?",
          clientMessageId: "m1",
        }),
      );
      const asked = yield* callAs("finance", "kin_ask", reminderAsk);
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      assert.strictEqual(asked.value.by, TUE_1930_ISO);
      const questionId = asked.value.question as string;
      // The card keeps taking taps past a day; Waiting on you says what Finance will do, and when.
      const [waiting] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.deepInclude(waiting!.ask!, { agent: "Finance", default: "Draft it" });
      assert.strictEqual(waiting!.ask!.by, TUE_1930_ISO);
      assert.deepStrictEqual(
        waiting!.ask!.options.map((option) => option.label),
        ["Draft it", "Leave it"],
      );

      // The Chief of staff asks the same thing about the same invoice: refused, nothing posted.
      yield* wake(
        "chief",
        yield* chats.send(owner, {
          chatId: chatOf("chief"),
          body: "Anything on money?",
          clientMessageId: "m2",
        }),
      );
      const again = yield* callAs("chief", "kin_ask", {
        ...reminderAsk,
        question: "Should Finance draft the payment reminders?",
        options: [{ label: "Yes" }, { label: "No" }],
        default: "Yes",
        about: ["INV-8", "INV-9"],
        intent: "Draft the payment reminders",
      });
      assert.isFalse(again.ok);
      assert.match(
        String(again.value.message ?? JSON.stringify(again.value)),
        /Already asked by Finance today: .*Default “Draft it” tomorrow/,
      );
      const cards = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
        WHERE chat_id = ${chatOf("chief")} AND type = 'choice'`;
      assert.strictEqual(cards[0]!.n, 0);
      // Every agent's turn in a chat with Rhea lists it.
      const section = yield* Questions.openQuestionsSection({
        orgId: KinOrgId.make(orgId),
        chatId: chatOf("chief"),
        ownerOnly: true,
        now: IST_MON_1130,
      });
      assert.include(section!.body, `${questionId}, Finance, today:`);
      assert.include(section!.body, "default “Draft it” tomorrow");

      // Never before its day; once at it; never twice. Her quiet hours hold the news of it.
      yield* sql`UPDATE kin_people SET quiet_hours_json = '{"from":"19:00","to":"21:00"}'
        WHERE person_id = ${owner.personId}`;
      const told = sql<{ author: string; body: string; widget: string | null }>`SELECT
          m.author_agent_id AS author, m.body, m.widget_id AS widget
        FROM kin_pulse_told t JOIN kin_messages m ON m.org_id = t.org_id AND m.message_id = t.event_id
        WHERE t.org_id = ${orgId} AND t.fact_key = ${`default_taken:${questionId}`}`;
      assert.strictEqual(yield* settle(orgId, TUE_1930 - 60_000), 0);
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "open");
      // Paused, the company or Finance alone, its turn isn't started and the card stays open.
      const asking = Option.getOrThrow(
        yield* repo.getWidget({
          orgId,
          widgetId: KinWidgetId.make(asked.value.widgetId as string),
        }),
      );
      // More of paused Finance's due than a pass takes, between two of the Chief of staff's.
      const crowd = (id: string, agent: string, kind: "card" | "text", actAt: number) =>
        sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
            question, default_label, safe, asked_at, due_at, act_at, state)
          VALUES (${id}, ${orgId}, ${agent}, ${owner.personId}, ${chatOf(agent)}, ${kind},
            ${`Invented question ${id}?`}, ${kind === "card" ? "Yes" : null},
            ${kind === "card" ? 1 : 0}, 0, ${actAt}, ${actAt}, 'open')`;
      yield* crowd("q-chief-first", "chief", "text", -1);
      for (let index = 0; index < 50; index += 1)
        yield* crowd(`q-paused-${index}`, "finance", "card", 0);
      yield* crowd("q-chief-last", "chief", "text", 1);
      yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by, reason)
        VALUES (${orgId}, 1, ${TUE_1930}, ${owner.personId}, 'Invented pause')
        ON CONFLICT (org_id) DO UPDATE SET paused = 1, paused_at = ${TUE_1930},
          paused_by = ${owner.personId}, reason = 'Invented pause'`;
      assert.strictEqual(yield* settle(orgId, TUE_1930), 0);
      assert.strictEqual((yield* questionRow(sql, "q-chief-first")).state, "open");
      yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL,
          reason = NULL
        WHERE org_id = ${orgId}`;
      yield* sql`UPDATE kin_agents SET paused_at = ${at} WHERE agent_id = 'finance'`;
      assert.strictEqual(yield* settle(orgId, TUE_1930), 2);
      assert.strictEqual((yield* questionRow(sql, "q-chief-last")).state, "withdrawn");
      yield* sql`DELETE FROM kin_questions WHERE question_id LIKE 'q-paused-%'`;
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "open");
      assert.lengthOf(yield* dueEvents(sql, orgId), 0);
      assert.strictEqual(
        Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId: asking.widgetId })).revision,
        asking.revision,
      );
      yield* sql`UPDATE kin_agents SET paused_at = NULL WHERE agent_id = 'finance'`;
      assert.strictEqual(yield* settle(orgId, TUE_1930), 1);
      assert.strictEqual(yield* settle(orgId, TUE_1930 + 60_000), 0);
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "default_taken");
      assert.deepStrictEqual(yield* dueEvents(sql, orgId), [
        { agent: "finance", key: `question:${questionId}` },
      ]);
      assert.lengthOf(yield* told, 0);
      // At 21:00 her time she is told once, from Finance, as a line: Finance's turn does the
      // default, so there is nothing for Kin to put back.
      yield* settle(orgId, TUE_1930 + 90 * 60_000);
      yield* settle(orgId, TUE_1930 + 91 * 60_000);
      assert.deepStrictEqual(yield* told, [
        {
          author: "finance",
          body: "Nobody answered, so I went with “Draft it” on “Shall I draft VIOM's payment reminder for INV-8?”.",
          widget: null,
        },
      ]);
      const card = Option.getOrThrow(
        yield* repo.getWidget({
          orgId,
          widgetId: KinWidgetId.make(asked.value.widgetId as string),
        }),
      );
      assert.isNotNull(card.closedAt);
      // The notice above says nobody answered; the card only reads as closed.
      assert.deepStrictEqual((card.state as { outcome: unknown }).outcome, {
        title: "Went with “Draft it”",
        text: 'Went with “Draft it”. Say "undo it" in the chat to reverse.',
      });
      // A tap after the default was taken changes nothing: the card is closed.
      const late = yield* chats
        .act(owner, {
          widgetId: card.widgetId,
          revision: card.revision,
          actionId: "choose",
          value: "option-2",
          clientActionId: "late",
        })
        .pipe(Effect.flip);
      assert.include(late, { reason: "invalid_state" });
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "default_taken");
      // The turn Kin starts tells Finance to do it, and that Kin tells Rhea.
      const due = yield* Questions.dueTurnText(KinOrgId.make(orgId), questionId, TUE_1930);
      assert.include(
        due!.text,
        "Kin tells Rhea Rao it went with “Draft it”, so don't say that again.",
      );
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);

      // Once INV-8 is a real invoice, any default about it waits for Rhea.
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'rec_inv8', 'invoices', 'INV-8', 'VIOM retainer', 'person',
          ${owner.personId}, 'person', 'inv8', 0, 0)`;
      yield* wake(
        "finance",
        yield* chats.send(owner, {
          chatId: chatOf("finance"),
          body: "VIOM still hasn't paid.",
          clientMessageId: "m3",
        }),
      );
      const money = yield* callAs("finance", "kin_ask", {
        ...reminderAsk,
        question: "Shall I draft VIOM's second reminder for INV-8?",
        intent: "draft second reminder",
      });
      assert.isTrue(money.ok, JSON.stringify(money.value));
      const [unsafe] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.isNull(unsafe!.ask!.default);

      // A whole-day row stored before it meant "not set" names no working days: a question asked
      // on a Saturday is due on Monday, as with no hours, not on Sunday.
      yield* sql`UPDATE kin_people SET work_hours_json = '{"days":[0,1,2,3,4,5,6],"start":"00:00","end":"23:59"}'
        WHERE person_id = ${owner.personId}`;
      yield* TestClock.setTime(Date.UTC(2026, 10, 21, 6));
      yield* wake(
        "chief",
        yield* chats.send(owner, {
          chatId: chatOf("chief"),
          body: "Is the studio free on Monday?",
          clientMessageId: "m4",
        }),
      );
      const weekend = yield* callAs("chief", "kin_ask", {
        question: "Shall I book the studio for Monday's shoot?",
        options: [{ label: "Book it" }, { label: "Leave it" }],
        default: "Book it",
        about: ["W-3"],
        intent: "book the studio",
      });
      assert.strictEqual(
        weekend.value.by,
        "2026-11-23T14:00:00.000Z",
        JSON.stringify(weekend.value),
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// A default that sends mail is never taken: at its day nothing happens, the next working
// morning it is raised once as a fresh card, and then it waits in Waiting on you until tapped.
it.effect("no card is raised about what is set aside, but its owner may be asked in person", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, chatOf, wake } = yield* ambermill;
      for (const [list, prefix] of [
        ["clients", "C"],
        ["invoices", "INV"],
      ] as const)
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
            created_at)
          VALUES (${orgId}, ${list}, ${list}, ${prefix}, 1, 0) ON CONFLICT DO NOTHING`;
      for (const [id, list, key, party] of [
        ["r-c8", "clients", "C-8", null],
        ["r-inv8", "invoices", "INV-8", "r-c8"],
      ] as const)
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, party_id, fields_json, created_by_kind, created_by_id,
            origin_key, created_at, updated_at)
          VALUES (${orgId}, ${id}, ${list}, ${key}, ${`Invented ${key}`}, 'open', 'agent',
            'finance', ${party}, '{}', 'person', ${owner.personId}, ${`origin-${id}`}, 0, 0)`;
      // Finance set the client aside on Rhea's word until Thursday.
      yield* sql`INSERT INTO kin_holds (hold_id, org_id, record_id, for_person_id, until_at,
          set_by_kind, set_by_id, on_word_of, note, set_at)
        VALUES ('hold-c8', ${orgId}, 'r-c8', NULL, ${IST_MON_1130 + 3 * 86_400_000}, 'agent',
          'finance', ${owner.personId}, NULL, ${IST_MON_1130 - 86_400_000})`;
      const ask = (n: number) => callAs("chief", "kin_ask", { ...reminderAsk, intent: `ask ${n}` });
      const checkIn = startAgentWakeup({
        orgId,
        agentId: KinAgentId.make("chief"),
        threadId: ThreadId.make("chief-thread"),
        event: (base) => ({
          ...base,
          _tag: "pulse",
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId: KinMemoryItemId.make("check-in"),
            title: "Check-in",
            what: "Check-in.",
            slot: "d",
          },
        }),
      });
      yield* checkIn;
      const refused = yield* ask(1);
      assert.isFalse(refused.ok);
      assert.match(
        String(refused.value.message),
        /^C-8 Invented C-8 and everything under it is set aside until 2026-11-19, by Finance on Rhea Rao's word \(2026-11-15\)\. Kin won't ask about it before then\.$/,
      );
      // Rhea's own message about it: she may be asked.
      yield* wake(
        "chief",
        yield* chats.send(owner, {
          chatId: chatOf("chief"),
          body: "What about C-8?",
          clientMessageId: "held-1",
        }),
      );
      assert.isTrue((yield* ask(2)).ok);
      // Its day come, any turn may ask again.
      yield* TestClock.setTime(IST_MON_1130 + 3 * 86_400_000);
      yield* checkIn;
      assert.isTrue((yield* ask(3)).ok);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a question with no safe default is raised once, then waits for its answer", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, services, chatOf, wake } = yield* ambermill;
      const repo = Context.get(services, KinChatRepository);
      const decisions: Array<KinDecision> = [];
      const saved = yield* Deferred.make<void>();
      yield* Context.get(services, KinMemoryChanges).attachWriter({
        undo: () => Effect.die("unused"),
        relabel: () => Effect.die("unused"),
        retire: () => Effect.die("unused"),
        restore: () => Effect.die("unused"),
        items: () => Effect.succeed([]),
        recordDecision: (_org, decision) =>
          Effect.sync(() => decisions.push(decision)).pipe(
            Effect.andThen(Deferred.succeed(saved, undefined)),
            Effect.as({ recorded: true }),
          ),
      });
      yield* wake(
        "finance",
        yield* chats.send(owner, {
          chatId: chatOf("finance"),
          body: "VIOM is late again.",
          clientMessageId: "m1",
        }),
      );
      const asked = yield* callAs("finance", "kin_ask", {
        question: "Send VIOM the reminder mail I drafted?",
        options: [{ label: "Send it" }, { label: "Hold it" }],
        default: "Send it",
        about: ["INV-8"],
        intent: "send payment reminder",
      });
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      const questionId = asked.value.question as string;
      const [waiting] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.isNull(waiting!.ask!.default);

      // Its day passes with nothing taken and no turn started.
      assert.strictEqual(yield* settle(orgId, TUE_1930), 0);
      assert.lengthOf(yield* dueEvents(sql, orgId), 0);
      // Wednesday 10:30 IST: raised once as a fresh card; the first closes as replaced.
      const morning = Date.UTC(2026, 10, 18, 5);
      assert.strictEqual(yield* settle(orgId, morning), 1);
      assert.strictEqual(yield* settle(orgId, morning + 3 * 86_400_000), 0);
      const row = yield* questionRow(sql, questionId);
      assert.strictEqual(row.state, "open");
      assert.isNotNull(row.raiseWidget);
      const open = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.deepStrictEqual(
        open.map((item) => [item.widgetId, item.question, item.ask?.default]),
        [[row.raiseWidget, "Still open: Send VIOM the reminder mail I drafted?", null]],
      );
      assert.lengthOf(yield* dueEvents(sql, orgId), 0);

      // A tap on the raised card, days later, answers it.
      const raised = Option.getOrThrow(
        yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(row.raiseWidget!) }),
      );
      yield* chats.act(owner, {
        widgetId: raised.widgetId,
        revision: raised.revision,
        actionId: "choose",
        value: "option-2",
        clientActionId: "hold",
      });
      assert.deepInclude(yield* questionRow(sql, questionId), {
        state: "answered",
        answer: "Hold it",
      });
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);
      // The answer is a decision memory keeps, in the card's own words, once.
      yield* Deferred.await(saved);
      assert.lengthOf(decisions, 1);
      assert.deepInclude(decisions[0], {
        title: "Send VIOM the reminder mail I drafted?",
        trust: "owner",
        chat: chatOf("finance"),
        link: `card:${raised.widgetId}`,
      });
      assert.match(decisions[0]!.body, /^Chose “Hold it” over “Send it”\./);
    }).pipe(Effect.provide(layer)),
  ),
);

// An agent retired before its questions were closed with it: raising one closes it instead.
it.effect("a question of a retired agent can close", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, services, chatOf, wake } = yield* ambermill;
      const repo = Context.get(services, KinChatRepository);
      yield* wake(
        "finance",
        yield* chats.send(owner, {
          chatId: chatOf("finance"),
          body: "VIOM is late again.",
          clientMessageId: "m1",
        }),
      );
      const asked = yield* callAs("finance", "kin_ask", {
        question: "Send VIOM the reminder mail I drafted?",
        options: [{ label: "Send it" }, { label: "Hold it" }],
        default: "Send it",
        about: ["INV-8"],
        intent: "send payment reminder",
      });
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      const questionId = asked.value.question as string;
      const [waiting] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      yield* sql`UPDATE kin_agents SET retired_at = ${TUE_1930_ISO} WHERE agent_id = 'finance'`;

      assert.strictEqual(yield* settle(orgId, Date.UTC(2026, 10, 18, 5)), 1);
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "withdrawn");
      const card = Option.getOrThrow(
        yield* repo.getWidget({ orgId, widgetId: waiting!.widgetId! }),
      );
      assert.isNotNull(card.closedAt);
      assert.deepInclude(card.state, {
        outcome: { title: "Closed", text: "Finance was retired; nothing will happen on this." },
      });
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);
    }).pipe(Effect.provide(layer)),
  ),
);

// Finance is retired with one question already raised and one not yet; restored, each is raised
// on its fresh day as a card Rhea can tap, once.
it.effect("a restored agent's questions are raised again as open cards, once", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, services, chatOf, wake } = yield* ambermill;
      const repo = Context.get(services, KinChatRepository);
      const ask = Effect.fn("test.ask")(function* (n: number, ref: string) {
        yield* wake(
          "finance",
          yield* chats.send(owner, {
            chatId: chatOf("finance"),
            body: `${ref} is late again.`,
            clientMessageId: `late-${n}`,
          }),
        );
        const asked = yield* callAs("finance", "kin_ask", {
          question: `Send the reminder mail I drafted for ${ref}?`,
          options: [{ label: "Send it" }, { label: "Hold it" }],
          default: "Send it",
          about: [ref],
          intent: "send payment reminder",
        });
        assert.isTrue(asked.ok, JSON.stringify(asked.value));
        return asked.value.question as string;
      });
      const before = yield* ask(1, "INV-8");
      const wednesday = Date.UTC(2026, 10, 18, 5);
      assert.strictEqual(yield* settle(orgId, wednesday), 1);
      const firstRaise = (yield* questionRow(sql, before)).raiseWidget;
      assert.isNotNull(firstRaise);
      const never = yield* ask(2, "INV-9");

      // Retired and restored as the owner does it, so its lead row needs a model.
      yield* sql`UPDATE kin_leads SET models_json = ${encodeLeadModel({ instanceId: providerInstanceId, model: "gpt-5.5" })}`;
      const provision = Effect.provideContext(services);
      yield* Provision.retireOnHost(KinAgentId.make("finance")).pipe(provision);
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);
      yield* TestClock.adjust("1 day");
      yield* Provision.restoreOnHost(KinAgentId.make("finance")).pipe(provision);

      const later = wednesday + 7 * 86_400_000;
      assert.strictEqual(yield* settle(orgId, later), 2);
      const cards = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      const rows = [yield* questionRow(sql, before), yield* questionRow(sql, never)];
      assert.notStrictEqual(rows[0]!.raiseWidget, firstRaise);
      assert.sameMembers(
        cards.map((item) => item.widgetId),
        rows.map((row) => row.raiseWidget),
      );
      for (const row of rows) {
        const card = Option.getOrThrow(
          yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(row.raiseWidget!) }),
        );
        assert.isNull(card.closedAt);
      }
      // The day's worker again draws nothing more.
      const drawn = yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${orgId}`;
      assert.strictEqual(yield* settle(orgId, later), 0);
      assert.lengthOf(
        yield* sql`SELECT widget_id FROM kin_widgets WHERE org_id = ${orgId}`,
        drawn.length,
      );
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 2);
    }).pipe(Effect.provide(layer)),
  ),
);

// A plain-text question stays open for every agent until the person writes back. A carded one
// is answered in words only by its asker, in a turn woken by its person's own message in its chat
// since its card and its last Undo, never by Kin's copy; the note that says so lets her, and only
// her, undo it while its asker is here, and it then waits for her with no default.
it.effect("only the asker takes an answer from the person's own words, and she can undo it", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, services, chatOf, wake } = yield* ambermill;
      const repo = Context.get(services, KinChatRepository);
      const text = yield* Questions.recordTextQuestion({
        orgId: KinOrgId.make(orgId),
        agentId: KinAgentId.make("chief"),
        chatId: chatOf("chief"),
        wakeupId: "w-text",
        question: "Is P-3 finished?",
        now: IST_MON_1130,
      });
      yield* TestClock.adjust("1 minute");
      yield* chats.send(owner, {
        chatId: chatOf("chief"),
        body: "Yes, it's done.",
        clientMessageId: "m3",
      });
      assert.strictEqual((yield* questionRow(sql, text!)).state, "answered");

      const say = (chatId: KinChatId, body: string, who = owner) =>
        chats.send(who, { chatId, body, clientMessageId: body });
      const answer = (agent: string) =>
        callAs(agent, "kin_ask_close", {
          question: questionId,
          outcome: "answered",
          answer: "Draft it",
        });
      const refused = Effect.fn("test.refused")(function* (agent: string, why: RegExp) {
        const result = yield* answer(agent);
        assert.isFalse(result.ok);
        assert.match(String(result.value.message), why);
        assert.strictEqual((yield* questionRow(sql, questionId)).state, "open");
      });
      yield* wake("finance", yield* say(chatOf("finance"), "VIOM?"));
      const asked = yield* callAs("finance", "kin_ask", reminderAsk);
      const questionId = asked.value.question as string;
      // The words that woke the turn that asked were written before it.
      yield* refused("finance", /own message/);
      // The Chief of staff, in a chat with Rhea too, may neither withdraw it nor answer it.
      yield* wake("chief", yield* say(chatOf("chief"), "Tell Finance: draft it."));
      const withdraw = yield* callAs("chief", "kin_ask_close", {
        question: questionId,
        outcome: "withdrawn",
      });
      assert.isFalse(withdraw.ok);
      yield* refused("chief", /only Finance records/);
      // Finance woken by Kin's own event, by Rhea's words in another chat, or by Meera.
      yield* startAgentWakeup({
        orgId,
        agentId: KinAgentId.make("finance"),
        threadId: ThreadId.make("finance-thread"),
        event: (base) => ({
          ...base,
          _tag: "pulse",
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId: KinMemoryItemId.make("check-in"),
            title: "Check-in",
            what: "Check-in.",
            slot: "d",
          },
        }),
      });
      yield* refused("finance", /own message/);
      // A file sent with no words is not words: it takes no answer.
      const fileOnly = yield* say(chatOf("finance"), "a file, no caption");
      yield* sql`UPDATE kin_messages SET body = '' WHERE org_id = ${orgId}
        AND message_id = ${fileOnly.messageId}`;
      yield* wake("finance", fileOnly);
      yield* refused("finance", /own message/);
      const meera = { _tag: "person" as const, orgId, personId: KinPersonId.make("meera") };
      const group = (yield* Context.get(services, KinGroups).create([owner], {
        orgId,
        title: "Collections",
        agentIds: [KinAgentId.make("finance")],
        personIds: [meera.personId],
      })).chatId;
      const textThere = yield* Questions.recordTextQuestion({
        orgId: KinOrgId.make(orgId),
        agentId: KinAgentId.make("finance"),
        chatId: chatOf("finance"),
        wakeupId: "w-text-finance",
        question: "Which month is INV-8 for?",
        now: yield* Clock.currentTimeMillis,
      });
      const inGroup = yield* wake("finance", yield* say(group, "Finance, draft the VIOM one."));
      yield* refused("finance", /own message/);
      // Taken private, her group words are Kin's copy in her chat with Finance, known by its
      // claim's key: they answer neither the text question waiting there nor the card in the turn
      // they wake there.
      const taken = yield* callAs("finance", "kin_take_private", {
        sourceEventId: `event:${inGroup}`,
      });
      assert.isTrue(taken.ok, JSON.stringify(taken.value));
      assert.strictEqual((yield* questionRow(sql, textThere!)).state, "open");
      const [copy] = yield* sql<{ messageId: KinMessageId }>`SELECT message_id AS "messageId"
        FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${chatOf("finance")}
          AND body = 'Finance, draft the VIOM one.'`;
      yield* wake(
        "finance",
        Option.getOrThrow(yield* repo.getMessage({ orgId, messageId: copy!.messageId })),
      );
      yield* refused("finance", /own message/);
      yield* wake("finance", yield* say(group, "Draft it.", meera));
      yield* refused("finance", /own message/);

      yield* wake("finance", yield* say(chatOf("finance"), "Yes, draft it."));
      const answered = yield* answer("finance");
      assert.isTrue(answered.ok, JSON.stringify(answered.value));
      const closed = yield* questionRow(sql, questionId);
      assert.strictEqual(closed.state, "answered");
      assert.lengthOf(yield* dueEvents(sql, orgId), 0);
      const [card] = yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
        FROM kin_questions WHERE question_id = ${questionId}`;
      const widget = (id: string) =>
        repo
          .getWidget({ orgId, widgetId: KinWidgetId.make(id) })
          .pipe(Effect.map(Option.getOrThrow));
      assert.deepInclude((yield* widget(card!.widgetId)).state, {
        outcome: { title: "Answered", text: "Finance took this from what you wrote: Draft it" },
      });
      const [note] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.match(String(note!.question), /^I took “Draft it” from what you wrote/);
      const tap = (who: typeof owner, widgetId: string, option: string) =>
        widget(widgetId).pipe(
          Effect.flatMap((shown) =>
            chats.act(who, {
              widgetId: shown.widgetId,
              revision: shown.revision,
              actionId: "choose",
              value: option,
              clientActionId: `${who.personId}-${widgetId}-${option}`,
            }),
          ),
        );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(tap(meera as typeof owner, note!.widgetId!, "option-1"))),
      );
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "answered");

      // Her Undo opens it again on its card, waiting for her: no default, nothing at its day.
      yield* tap(owner, note!.widgetId!, "option-1");
      assert.deepInclude(yield* questionRow(sql, questionId), { state: "open", answer: null });
      const reopened = yield* widget(card!.widgetId);
      assert.isNull(reopened.closedAt);
      assert.notProperty(reopened.state, "outcome");
      assert.deepInclude((yield* widget(note!.widgetId!)).state, {
        outcome: {
          title: "Undone",
          text: "“Shall I draft VIOM's payment reminder for INV-8?” is open again, and Finance waits for your answer. What was already done from the first answer stands.",
          undone: {
            personId: owner.personId,
            name: "Rhea Rao",
            at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          },
        },
      });
      const [waiting] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.strictEqual(waiting!.widgetId, card!.widgetId);
      assert.deepInclude(waiting!.ask!, { agent: "Finance", default: null });
      const told = sql<{ json: string }>`SELECT json FROM kin_events
        WHERE org_id = ${orgId} AND agent_id = 'finance'
          AND dedupe_key LIKE 'question-answer-undone:%'`;
      const [undoneEvent] = yield* told;
      const subject = JSON.parse(undoneEvent!.json).subject;
      assert.deepInclude(subject, { undone: true, words: true });
      const toldFinance = Questions.undoneTurnText(KinOrgId.make(orgId), subject);
      assert.match(String(yield* toldFinance), /open again on its card, waiting for their answer/);
      // The words it was taken from, retried in the turn they woke, no longer answer it.
      yield* refused("finance", /own message/);
      assert.strictEqual(yield* settle(orgId, TUE_1930), 0);
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "open");

      // Her new words do. Told of the Undo after that, Finance reads it was undone all the same.
      yield* wake("finance", yield* say(chatOf("finance"), "Draft it after all."));
      assert.isTrue((yield* answer("finance")).ok);
      assert.strictEqual(
        yield* toldFinance,
        "Your question to Rhea Rao, “Shall I draft VIOM's payment reminder for INV-8?”: Rhea Rao undid the answer you took from their words. It has since been answered: “Draft it”. Don't act on the undone answer, and don't ask again.",
      );
      // Finance retired since: her Undo keeps the answer, says why, and leaves nothing waiting.
      const [second] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      yield* sql`UPDATE kin_agents SET retired_at = ${TUE_1930_ISO} WHERE agent_id = 'finance'`;
      yield* tap(owner, second!.widgetId!, "option-1");
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "answered");
      assert.deepInclude((yield* widget(second!.widgetId!)).state, {
        outcome: {
          title: "Nothing was undone",
          text: "Finance is no longer here, so the question stays closed and its answer stands as taken. You can raise it with another agent.",
        },
      });
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);
      assert.lengthOf(yield* told, 1);
    }).pipe(Effect.provide(layer)),
  ),
);

// Rhea is away six weeks and Finance's default is taken in the first: she is told once she is
// back, counted in her chat itself. Later, Meera, still away, has more held notices than one pass
// tells: Rhea, who is back, is told of her next one in that same pass.
it.effect("a taken default is owed until told, and held ones don't crowd out people back", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, chatOf, wake } = yield* ambermill;
      const chatId = chatOf("finance");
      const ask = Effect.fn("test.ask")(function* (body: string, input: typeof reminderAsk) {
        yield* wake("finance", yield* chats.send(owner, { chatId, body, clientMessageId: body }));
        const asked = yield* callAs("finance", "kin_ask", input);
        assert.isTrue(asked.ok, JSON.stringify(asked.value));
        return { id: asked.value.question as string, due: Date.parse(asked.value.by as string) };
      });
      const told = (questionId: string) =>
        sql`SELECT 1 FROM kin_pulse_told
          WHERE org_id = ${orgId} AND fact_key = ${`default_taken:${questionId}`}`;
      const posted = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatId}`.pipe(Effect.map((rows) => rows[0]!.n));
      const day = 86_400_000;

      const first = yield* ask("What about VIOM?", reminderAsk);
      const back = DateTime.formatIsoDate(DateTime.makeUnsafe(first.due + 42 * day));
      yield* sql`UPDATE kin_people SET away_until = ${back} WHERE person_id = ${owner.personId}`;
      assert.strictEqual(yield* settle(orgId, first.due), 1);
      yield* settle(orgId, first.due + 31 * day);
      assert.lengthOf(yield* told(first.id), 0);
      const away = yield* posted;
      const home = Date.parse(`${back}T06:00:00.000Z`);
      yield* settle(orgId, home);
      yield* settle(orgId, home + 60_000);
      assert.lengthOf(yield* told(first.id), 1);
      assert.strictEqual(yield* posted, away + 1);

      const meera = { _tag: "person" as const, orgId, personId: KinPersonId.make("meera") };
      const meeraChat = (yield* chats.createDirect(meera, {
        orgId,
        agentId: KinAgentId.make("finance"),
      })).chatId;
      yield* sql`UPDATE kin_people SET away_until = '2027-12-31' WHERE person_id = 'meera'`;
      for (let index = 0; index < 51; index += 1)
        yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id,
            kind, question, default_label, safe, asked_at, due_at, act_at, state, raised_at,
            closed_at)
          VALUES (${`q-held-${index}`}, ${orgId}, 'finance', 'meera', ${meeraChat}, 'card',
            ${`Invented held question ${index}?`}, 'Yes', 1, 0, 0, 0, 'default_taken',
            ${index + 1}, ${index + 1})`;
      const second = yield* ask("And the Apex receipts?", {
        question: "Shall I file the Apex receipts under October?",
        options: [{ label: "File them" }, { label: "Leave them" }],
        default: "File them",
        about: [],
        intent: "file the Apex receipts",
      });
      assert.strictEqual(yield* settle(orgId, second.due), 1);
      assert.lengthOf(yield* told(second.id), 1);
    }).pipe(Effect.provide(layer)),
  ),
);

/**
 * Ambermill's floor for questions asked of someone outside the chat: Zoya and Arjun are members
 * too, and Arjun leads the open Monsoon shoot. The Chief of staff is the team agent, so anyone may
 * message it; only Rhea and Meera may message Finance.
 */
const askingTeam = Effect.gen(function* () {
  const studio = yield* ambermill;
  const { sql, chats, owner, orgId, services } = studio;
  for (const [id, name] of [
    ["zoya", "Zoya Sheikh"],
    ["arjun", "Arjun Nair"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, 'member')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'projects', 'Projects', 'P', 1, 0) ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
      owner_kind, owner_id, created_by_kind, origin_key, created_at, updated_at)
    VALUES (${orgId}, 'rec_shoot', 'projects', 'P-4', 'Monsoon shoot', 'open', 'person', 'arjun',
      'person', 'shoot', 0, 0)`;
  const person = (id: string) => ({
    _tag: "person" as const,
    orgId,
    personId: KinPersonId.make(id),
  });
  const chief = KinAgentId.make("chief");
  /** Someone's own direct chat with the Chief of staff. */
  const chiefChat = (id: string) =>
    id === "rhea"
      ? Effect.succeed(studio.chatOf("chief"))
      : chats.createDirect(person(id), { orgId, agentId: chief }).pipe(Effect.map((c) => c.chatId));
  const lead = (agent: string, wakeupId: KinWakeupId) => ({
    _tag: "agent" as const,
    orgId,
    agentId: KinAgentId.make(agent),
    ownerPersonId: owner.personId,
    threadId: ThreadId.make(`${agent}-thread`),
    wakeupId,
  });
  const askFor = (
    agent: string,
    wakeupId: KinWakeupId,
    input: Partial<typeof AskPerson.AskPersonInput.Type> & { readonly to: string },
  ) =>
    AskPerson.askPerson(
      lead(agent, wakeupId),
      {
        question: "Does the shoot move to Friday?",
        options: [{ label: "Friday" }, { label: "Keep the date" }],
        about: ["P-4"],
        intent: "shoot date",
        ...input,
      },
      { chat: chats, gate: Context.get(services, KinLevelGate) },
    );
  /** A turn of `agent`'s woken by `who`'s words in their own chat with it. */
  const wakeOn = Effect.fn("test.wakeOn")(function* (
    agent: string,
    who: string,
    chatId: KinChatId,
    body: string,
  ) {
    return yield* studio.wake(
      agent,
      yield* chats.send(who === "rhea" ? owner : person(who), {
        chatId,
        body,
        clientMessageId: `${who}:${body}`,
      }),
    );
  });
  const cardOf = (questionId: string) =>
    sql<{ widgetId: string | null; chatId: string; forChatId: string; forPersonId: string | null }>`
      SELECT widget_id AS "widgetId", chat_id AS "chatId", for_chat_id AS "forChatId",
        for_person_id AS "forPersonId" FROM kin_questions WHERE question_id = ${questionId}`.pipe(
      Effect.map((rows) => rows[0]!),
    );
  const widgetOf = (widgetId: string) =>
    Context.get(services, KinChatRepository)
      .getWidget({ orgId, widgetId: KinWidgetId.make(widgetId) })
      .pipe(Effect.map(Option.getOrThrow));
  /** What Kin itself said in a chat, oldest first. */
  const kinLines = (chatId: KinChatId) =>
    sql<{ body: string }>`SELECT body FROM kin_messages WHERE org_id = ${orgId}
      AND chat_id = ${chatId} AND author_kind = 'system' ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => row.body)),
    );
  const answeredWakes = sql<{ key: string; origin: string | null }>`SELECT dedupe_key AS key,
      json_extract(json, '$.origin') AS origin FROM kin_events
    WHERE org_id = ${orgId} AND dedupe_key LIKE 'question-answered:%' ORDER BY rowid`;
  return {
    ...studio,
    person,
    chiefChat,
    askFor,
    wakeOn,
    cardOf,
    widgetOf,
    kinLines,
    answeredWakes,
  };
});

// Question 1's table: from the owner side anyone who may message the agent; from a teammate's own
// chat only the owner side or a project's lead; never a group, themselves or an agent.
it.effect("who may be asked for someone else, and what refuses it", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const { sql, orgId, owner, services, chatOf, chiefChat, askFor, wakeOn, cardOf, widgetOf } =
        yield* askingTeam;
      const refused = <A, E extends { readonly message: string }, R>(
        asking: Effect.Effect<A, E, R>,
        why: RegExp,
      ) =>
        Effect.flip(asking).pipe(
          Effect.map((error) => {
            assert.match(error.message, why);
            assert.match(error.message, /Nothing was asked\.$/);
          }),
        );
      const cards = (chatId: KinChatId) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
          WHERE chat_id = ${chatId} AND type = 'choice'`.pipe(Effect.map((rows) => rows[0]!.n));

      // Rhea, in her own chat with the Chief of staff.
      const rhea = yield* wakeOn("chief", "rhea", chatOf("chief"), "Ask Dev about the shoot.");
      const toDev = yield* askFor("chief", rhea, { to: "Dev" });
      // Dev never signed in: it still waits in his chat, and the result says no one was alerted.
      assert.deepInclude(toDev, {
        to: "Dev Malhotra",
        state: "posted",
        retry: false,
        signedIn: false,
        note: "Dev Malhotra hasn't signed in to Kin yet: it waits in their chat with you and reaches them when they do. Nobody was alerted. Their answer comes back here.",
      });
      const devChat = yield* chiefChat("dev");
      const stored = yield* cardOf(toDev.questionId);
      assert.deepStrictEqual(stored, {
        widgetId: stored.widgetId,
        chatId: devChat,
        forChatId: chatOf("chief"),
        forPersonId: owner.personId,
      });
      const card = yield* widgetOf(stored.widgetId!);
      assert.deepStrictEqual(card.awaiting, [KinPersonId.make("dev")]);
      assert.include(card.state, {
        question: "Does the shoot move to Friday?",
        detail: "Rhea Rao asks, through Chief of staff.",
      });
      // The same call again is a retry: the same question, no second card.
      assert.deepInclude(yield* askFor("chief", rhea, { to: "Dev" }), {
        questionId: toDev.questionId,
        retry: true,
      });
      assert.strictEqual(yield* cards(devChat), 1);
      // Rhea's chat with the agent knows what waits on Dev; Dev's chat lists it as for her.
      const waits = yield* Questions.askedForSection({
        orgId: KinOrgId.make(orgId),
        agentId: KinAgentId.make("chief"),
        chatId: chatOf("chief"),
        now: IST_MON_1130,
      });
      assert.include(waits!.body, `- ${toDev.questionId}, to Dev Malhotra, today:`);
      const his = yield* Questions.openQuestionsSection({
        orgId: KinOrgId.make(orgId),
        chatId: devChat,
        ownerOnly: false,
        now: IST_MON_1130,
      });
      assert.include(his!.body, `- ${toDev.questionId}, Chief of staff for Rhea Rao, today:`);
      // A co-owner is asked in her own chat with the agent, as anyone else.
      const toMeera = yield* askFor("chief", rhea, { to: "Meera", intent: "shoot budget" });
      assert.strictEqual(toMeera.state, "posted");
      yield* refused(
        askFor("chief", rhea, { to: "Rhea", intent: "x" }),
        /ask them here with kin_ask/,
      );
      yield* refused(askFor("chief", rhea, { to: "Finance" }), /No one called Finance/);
      // Through Finance, once Rhea restricted Dev and Finance, nothing is asked.
      yield* Reach.setLimit({
        orgId: KinOrgId.make(orgId),
        by: owner.personId,
        a: Reach.person(KinPersonId.make("dev")),
        b: Reach.agent(KinAgentId.make("finance")),
        restricted: true,
      });
      const viaFinance = yield* wakeOn("finance", "rhea", chatOf("finance"), "Ask Dev.");
      assert.strictEqual(
        (yield* Effect.flip(askFor("finance", viaFinance, { to: "Dev", intent: "y" }))).message,
        "Dev Malhotra and Finance can't message each other here, so nothing was sent. The owner can lift that.",
      );
      // The same thing Chief of staff already put to Meera, through Finance: a repeat.
      yield* refused(
        askFor("finance", viaFinance, { to: "Meera", intent: "shoot budget", about: [] }),
        /Chief of staff already asked Meera Shah that/,
      );

      // Dev, a member, in his own chat with the Chief of staff.
      const dev = yield* wakeOn("chief", "dev", devChat, "Can someone decide the shoot date?");
      const toRhea = yield* askFor("chief", dev, { to: "Rhea", intent: "shoot date for dev" });
      assert.strictEqual(toRhea.state, "posted");
      const rheaCard = yield* cardOf(toRhea.questionId);
      assert.deepInclude(rheaCard, {
        chatId: chatOf("chief"),
        forChatId: devChat,
        forPersonId: "dev",
      });
      assert.include((yield* widgetOf(rheaCard.widgetId!)).state, {
        detail: "Dev Malhotra asks, through Chief of staff.",
      });
      const toArjun = yield* askFor("chief", dev, { to: "Arjun", intent: "call sheet" });
      assert.strictEqual(toArjun.state, "posted");
      // Dev and Zoya restricted: no agent asks her for him.
      const pair = (restricted: boolean) =>
        Reach.setLimit({
          orgId: KinOrgId.make(orgId),
          by: owner.personId,
          a: Reach.person(KinPersonId.make("dev")),
          b: Reach.person(KinPersonId.make("zoya")),
          restricted,
        });
      yield* pair(true);
      assert.strictEqual(
        (yield* Effect.flip(askFor("chief", dev, { to: "Zoya", intent: "cover friday" }))).message,
        "Zoya Sheikh and Dev Malhotra can't message each other here, so nothing was sent. Tell Dev Malhotra in one line that the owner can lift it. Don't try another way.",
      );
      yield* pair(false);
      // Anyone in the company, not only someone who decides for him.
      assert.strictEqual(
        (yield* askFor("chief", dev, { to: "Zoya", intent: "cover friday" })).state,
        "posted",
      );
      // What Arjun may not read never reaches him through the question.
      yield* refused(
        askFor("chief", dev, {
          to: "Arjun",
          intent: "crew budget",
          detail: "The crew budget is ₹40,000 in all.",
        }),
        /Not for Arjun Nair: “₹40,000” reads as an amount of money/,
      );

      // At most three asked for others wait on one person, from all agents together.
      const again = yield* wakeOn("chief", "rhea", chatOf("chief"), "And two more for Dev.");
      for (const intent of ["lights", "van"])
        assert.strictEqual((yield* askFor("chief", again, { to: "Dev", intent })).state, "posted");
      yield* refused(
        askFor("chief", again, { to: "Dev", intent: "lunch" }),
        /3 questions asked for others already wait on Dev Malhotra/,
      );
      // Neither intent nor records: Kin couldn't tell a repeat, so it isn't asked.
      yield* refused(askFor("chief", again, { to: "Zoya", intent: "", about: [] }), /intent/);

      // A check-in asks for the owner, as "Chief of staff asks.", one at a time per person.
      yield* startAgentWakeup({
        orgId,
        agentId: KinAgentId.make("chief"),
        threadId: ThreadId.make("chief-thread"),
        event: (base) => ({
          ...base,
          _tag: "pulse",
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId: KinMemoryItemId.make("check-in"),
            title: "Check-in",
            what: "Check-in.",
            slot: "d",
          },
        }),
      });
      const [checkIn] = yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
        FROM kin_wakeups WHERE org_id = ${orgId} AND status = 'running'`;
      const unasked = yield* askFor("chief", checkIn!.wakeupId, { to: "Zoya", intent: "props" });
      const zoyaCard = yield* cardOf(unasked.questionId);
      assert.deepInclude(zoyaCard, { forChatId: chatOf("chief"), forPersonId: null });
      assert.include((yield* widgetOf(zoyaCard.widgetId!)).state, {
        detail: "Chief of staff asks.",
      });
      yield* refused(
        askFor("chief", checkIn!.wakeupId, { to: "Zoya", intent: "costumes" }),
        /nobody asked you for/,
      );

      // Dev's turn may read none of what others asked for: his refusals quote none of it.
      const devAgain = yield* wakeOn("chief", "dev", devChat, "Ask Meera and Zoya too.");
      assert.strictEqual(
        (yield* Effect.flip(
          askFor("chief", devAgain, { to: "Meera", intent: "shoot budget", about: [] }),
        )).message,
        "Meera Shah already has an open question on this; don't ask it again. Nothing was asked.",
      );
      assert.strictEqual(
        (yield* askFor("chief", again, { to: "Zoya", intent: "wardrobe" })).state,
        "posted",
      );
      assert.strictEqual(
        (yield* Effect.flip(askFor("chief", devAgain, { to: "Zoya", intent: "catering" }))).message,
        "3 questions asked for others already wait on Zoya Sheikh. Nothing was asked.",
      );
      // Rhea's own turn may read every one of them, so hers says which.
      yield* refused(
        askFor("chief", again, { to: "Zoya", intent: "catering" }),
        /wait on Zoya Sheikh: “Does the shoot move to Friday\?” \(Chief of staff\), /,
      );

      // A group asks nobody for anyone.
      const group = (yield* Context.get(services, KinGroups).create([owner], {
        orgId,
        title: "Shoot",
        agentIds: [KinAgentId.make("chief")],
        personIds: [KinPersonId.make("meera")],
      })).chatId;
      const inGroup = yield* wakeOn("chief", "rhea", group, "Ask Zoya about props.");
      yield* refused(
        askFor("chief", inGroup, { to: "Zoya", intent: "props again" }),
        /never a group/,
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// The tap answers in the asked person's chat and the answer lands in the asker's: Kin's line
// there, one turn of the asker there, and no turn in the chat of the person who tapped.
it.effect("a tap on a question asked for someone goes back to the chat that asked, once", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const team = yield* askingTeam;
      const { sql, chats, orgId, owner, person, chatOf, chiefChat, askFor, wakeOn } = team;
      const tap = Effect.fn("test.tap")(function* (
        who: Parameters<typeof chats.act>[0],
        questionId: string,
        option: string,
        clientActionId: string,
      ) {
        const card = yield* team.widgetOf((yield* team.cardOf(questionId)).widgetId!);
        return yield* chats.act(who, {
          widgetId: card.widgetId,
          revision: card.revision,
          actionId: "choose",
          value: option,
          clientActionId,
        });
      });
      const turnsIn = (chatId: KinChatId) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_events WHERE org_id = ${orgId}
          AND tag IN ('chat.message', 'widget.action') AND json_extract(json, '$.chatId') = ${chatId}`.pipe(
          Effect.map((rows) => rows[0]!.n),
        );

      const rhea = yield* wakeOn("chief", "rhea", chatOf("chief"), "Ask Dev about the shoot.");
      const asked = yield* askFor("chief", rhea, { to: "Dev" });
      const devChat = yield* chiefChat("dev");
      const before = yield* turnsIn(devChat);
      // Only the person it waits on answers it: Rhea isn't in Dev's chat with the agent.
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(tap(owner, asked.questionId, "option-1", "rhea-tap"))),
      );
      assert.strictEqual((yield* questionRow(sql, asked.questionId)).state, "open");

      const tapped = yield* team.widgetOf((yield* team.cardOf(asked.questionId)).widgetId!);
      const devTap = {
        widgetId: tapped.widgetId,
        revision: tapped.revision,
        actionId: "choose",
        value: "option-1",
        clientActionId: "dev-tap",
      };
      yield* chats.act(person("dev"), devTap);
      assert.deepInclude(yield* questionRow(sql, asked.questionId), {
        state: "answered",
        answer: "Friday",
      });
      const card = yield* team.widgetOf((yield* team.cardOf(asked.questionId)).widgetId!);
      assert.deepInclude(card.state, { outcome: { title: "Answered", text: "Sent to Rhea Rao." } });
      assert.deepStrictEqual(yield* team.kinLines(chatOf("chief")), [
        "Dev Malhotra answered “Friday” to “Does the shoot move to Friday?”",
      ]);
      // One turn of the asker, in her own chat: no origin to cap it, and none in Dev's.
      assert.deepStrictEqual(yield* team.answeredWakes, [
        { key: `question-answered:${asked.questionId}`, origin: null },
      ]);
      // Asked by a turn that read nothing from outside, it carries no stamp.
      const [answer] = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
        FROM kin_events WHERE dedupe_key = ${`question-answered:${asked.questionId}`}`;
      assert.isUndefined(yield* storedStamp(KinOrgId.make(orgId), answer!.eventId));
      assert.strictEqual(yield* turnsIn(devChat), before);
      // That turn is told the answer, and that Rhea already heard it.
      const told = yield* Questions.answeredTurnText(KinOrgId.make(orgId), asked.questionId);
      assert.include(told!.text, "Dev Malhotra answered your question for Rhea Rao");
      assert.include(told!.text, "Kin already told Rhea Rao, so don't repeat it.");
      assert.deepInclude(told!.data, { answer: "Friday", about: ["P-4"] });
      // The same tap again, or another, adds nothing.
      yield* chats.act(person("dev"), devTap);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(tap(person("dev"), asked.questionId, "option-2", "dev-again")),
        ),
      );
      assert.lengthOf(yield* team.kinLines(chatOf("chief")), 1);
      assert.lengthOf(yield* team.answeredWakes, 1);

      // Its turn would be claimed ahead of Dev's message; this test drives Dev's instead.
      yield* sql`UPDATE kin_events SET state = 'done' WHERE org_id = ${orgId}
        AND dedupe_key LIKE 'question-answered:%'`;
      // Dev asks Rhea: her tap comes back to Dev's chat, and the turn there works at Dev's access.
      const dev = yield* wakeOn("chief", "dev", devChat, "Can someone decide the shoot date?");
      const up = yield* askFor("chief", dev, { to: "Rhea", intent: "shoot date for dev" });
      yield* tap(owner, up.questionId, "option-2", "rhea-answer");
      assert.deepStrictEqual(yield* team.kinLines(devChat), [
        "Rhea Rao answered “Keep the date” to “Does the shoot move to Friday?”",
      ]);
      const wakes = yield* team.answeredWakes;
      assert.lengthOf(wakes, 2);
      assert.deepStrictEqual(JSON.parse(wakes[1]!.origin!), {
        agentId: "chief",
        chatId: devChat,
        personId: "dev",
      });
    }).pipe(Effect.provide(layer)),
  ),
);

// In words, only from the asked person's own message in her chat; withdrawn, only from the side
// that asked, and her card says who withdrew it.
it.effect(
  "a question asked for someone is answered only by them and withdrawn only by its asker",
  () =>
    Effect.andThen(
      TestClock.setTime(IST_MON_1130),
      Effect.gen(function* () {
        const team = yield* askingTeam;
        const { sql, chatOf, chiefChat, askFor, wakeOn } = team;
        const close = (outcome: "answered" | "withdrawn", question: string, answer?: string) =>
          callAs("chief", "kin_ask_close", {
            question,
            outcome,
            ...(answer === undefined ? {} : { answer }),
          });
        const rhea = yield* wakeOn("chief", "rhea", chatOf("chief"), "Ask Dev about the shoot.");
        const first = yield* askFor("chief", rhea, { to: "Dev" });
        const second = yield* askFor("chief", rhea, { to: "Dev", intent: "van" });
        // Rhea can't answer for Dev.
        const forHim = yield* close("answered", first.questionId, "Friday");
        assert.isFalse(forHim.ok);
        assert.match(String(forHim.value.message), /own message/);

        const devChat = yield* chiefChat("dev");
        yield* wakeOn("chief", "dev", devChat, "Friday works for me.");
        // Dev's own turn doesn't withdraw what was asked for Rhea.
        const notHis = yield* close("withdrawn", second.questionId);
        assert.isFalse(notHis.ok);
        assert.match(String(notHis.value.message), /only that chat, or the owner, withdraws it/);
        const answered = yield* close("answered", first.questionId, "Friday works");
        assert.isTrue(answered.ok, JSON.stringify(answered.value));
        const card = yield* team.widgetOf((yield* team.cardOf(first.questionId)).widgetId!);
        assert.deepInclude(card.state, {
          outcome: {
            title: "Answered",
            text: "Chief of staff took this from what you wrote: Friday works. Sent to Rhea Rao.",
          },
        });
        assert.deepStrictEqual(yield* team.kinLines(chatOf("chief")), [
          "Dev Malhotra answered “Friday works” to “Does the shoot move to Friday?”",
        ]);
        assert.lengthOf(yield* team.answeredWakes, 1);
        // Sent on already, it offers Dev no Undo note.
        const [undo] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
        WHERE chat_id = ${devChat} AND client_message_id LIKE '%kin-answer-taken:%'`;
        assert.strictEqual(undo!.n, 0);

        // Rhea's side withdraws the other; Dev's card says she did.
        yield* wakeOn("chief", "rhea", chatOf("chief"), "Forget the van.");
        const withdrawn = yield* close("withdrawn", second.questionId);
        assert.isTrue(withdrawn.ok, JSON.stringify(withdrawn.value));
        const closed = yield* team.widgetOf((yield* team.cardOf(second.questionId)).widgetId!);
        assert.deepInclude(closed.state, {
          outcome: { title: "Withdrawn", text: "Rhea Rao withdrew this question." },
        });
        assert.lengthOf(yield* team.answeredWakes, 1);
      }).pipe(Effect.provide(layer)),
    ),
);

// Dev is away: nothing reaches him, and Rhea's chat says when it will. The first pass after he is
// back posts the card, its day counted from then; at that day it is raised once more, once.
// Restricted after it was held or asked: a held relay is dropped and its asker told, a held
// question or one due to be raised closes, and nothing reaches the pair.
it.effect("what waits for a pair restricted since goes nowhere, and the asker hears so", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const team = yield* askingTeam;
      const { sql, orgId, owner, chats, chatOf, chiefChat, askFor, wakeOn } = team;
      const org = KinOrgId.make(orgId);
      const devChat = yield* chiefChat("dev");
      const zoyaChat = yield* chiefChat("zoya");
      const restrict = (id: string) =>
        Reach.setLimit({
          orgId: org,
          by: owner.personId,
          a: Reach.person(KinPersonId.make(id)),
          b: Reach.agent(KinAgentId.make("chief")),
          restricted: true,
        });
      const agentPosts = (chatId: KinChatId) =>
        sql<{ body: string }>`SELECT body FROM kin_messages WHERE chat_id = ${chatId}
          AND author_kind = 'agent' ORDER BY seq`;
      yield* sql`UPDATE kin_people SET away_until = '2026-11-19' WHERE person_id = 'dev'`;
      const rhea = yield* wakeOn("chief", "rhea", chatOf("chief"), "Ask Dev and Zoya.");
      yield* holdLine({
        orgId: org,
        chatId: devChat,
        personId: KinPersonId.make("dev"),
        key: `kin-relay:${rhea}:van`,
        body: "Is the van booked?",
        audience: "chat",
        at: IST_MON_1130,
        agentId: KinAgentId.make("chief"),
      });
      const held = yield* askFor("chief", rhea, { to: "Dev" });
      assert.strictEqual(held.state, "held");
      const posted = yield* askFor("chief", rhea, { to: "Zoya", intent: "props" });
      assert.strictEqual(posted.state, "posted");
      yield* restrict("dev");
      yield* restrict("zoya");

      // He is back: what waited for him is due now.
      yield* sql`UPDATE kin_people SET away_until = NULL WHERE person_id = 'dev'`;
      assert.strictEqual(yield* deliverHeld(org, chats), 0);
      assert.deepStrictEqual(yield* agentPosts(devChat), []);
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_held_posts WHERE chat_id = ${devChat}`, 0);
      yield* settle(orgId, Date.UTC(2026, 10, 20, 5));
      assert.strictEqual((yield* questionRow(sql, held.questionId)).state, "withdrawn");
      assert.strictEqual((yield* questionRow(sql, posted.questionId)).state, "withdrawn");
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_widgets WHERE chat_id = ${devChat} AND type = 'choice'`,
        0,
      );
      const card = yield* team.widgetOf((yield* team.cardOf(posted.questionId)).widgetId!);
      assert.deepInclude(card.state, {
        outcome: { title: "Closed", text: "You and Chief of staff can't message each other here." },
      });
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_widgets WHERE chat_id = ${zoyaChat} AND type = 'choice'`,
        1,
      );
      assert.includeMembers(yield* team.kinLines(chatOf("chief")), [
        "Dev Malhotra and Chief of staff can't message each other here, so nothing was sent.",
        "“Does the shoot move to Friday?” was closed before Dev Malhotra answered.",
        "“Does the shoot move to Friday?” was closed before Zoya Sheikh answered.",
      ]);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a question asked for someone away waits for them, then is raised once", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_1130),
    Effect.gen(function* () {
      const team = yield* askingTeam;
      const { sql, orgId, chatOf, chiefChat, askFor, wakeOn } = team;
      const devChat = yield* chiefChat("dev");
      const cardsFor = (chatId: KinChatId) =>
        sql<{ question: string; detail: string }>`SELECT json_extract(w.state_json, '$.question')
            AS question, json_extract(w.state_json, '$.detail') AS detail
          FROM kin_widgets w WHERE w.chat_id = ${chatId} AND w.type = 'choice' ORDER BY w.rowid`;
      // Back on Thursday the 19th, on the day stored.
      yield* sql`UPDATE kin_people SET away_until = '2026-11-19' WHERE person_id = 'dev'`;
      const rhea = yield* wakeOn("chief", "rhea", chatOf("chief"), "Ask Dev about the shoot.");
      // Her turn read connected mail first: the question carries that stamp to all it leads to.
      yield* markOutside({ orgId: KinOrgId.make(orgId), wakeupId: rhea }, "mail-connection");
      const stampOf = (key: string) => storedStamp(KinOrgId.make(orgId), key);
      const asked = yield* askFor("chief", rhea, { to: "Dev" });
      assert.strictEqual(yield* stampOf(asked.questionId), "mail-connection");
      assert.strictEqual(asked.state, "held");
      assert.isNull((yield* team.cardOf(asked.questionId)).widgetId);
      assert.lengthOf(yield* cardsFor(devChat), 0);
      const [arrives] = yield* team.kinLines(chatOf("chief"));
      assert.match(arrives!, /^Dev Malhotra is away: it arrives at .+\.$/);

      // Passes while he is away post nothing, and it is never raised before it reached him.
      assert.strictEqual(yield* settle(orgId, Date.UTC(2026, 10, 18, 6)), 0);
      assert.lengthOf(yield* cardsFor(devChat), 0);
      // He is back early: the next pass posts it, due from that minute.
      yield* sql`UPDATE kin_people SET away_until = NULL WHERE person_id = 'dev'`;
      const back = Date.UTC(2026, 10, 18, 7);
      yield* settle(orgId, back);
      const cards = yield* cardsFor(devChat);
      assert.deepStrictEqual(cards, [
        {
          question: "Does the shoot move to Friday?",
          detail: "Rhea Rao asks, through Chief of staff.",
        },
      ]);
      const [row] = yield* sql<{ dueAt: number; widgetId: string | null }>`SELECT due_at AS "dueAt",
          widget_id AS "widgetId" FROM kin_questions WHERE question_id = ${asked.questionId}`;
      assert.isNotNull(row!.widgetId);
      assert.strictEqual(row!.dueAt, defaultDue(back, "Asia/Kolkata"));
      yield* settle(orgId, back + 60_000);
      assert.lengthOf(yield* cardsFor(devChat), 1);

      // At its day nobody answers for him: it is raised once more, saying still who asks.
      const raiseAt = Date.UTC(2026, 10, 20, 5);
      assert.strictEqual(yield* settle(orgId, raiseAt), 1);
      assert.strictEqual(yield* settle(orgId, raiseAt + 86_400_000), 0);
      const raised = yield* cardsFor(devChat);
      assert.lengthOf(raised, 2);
      assert.strictEqual(raised[1]!.question, "Still open: Does the shoot move to Friday?");
      assert.match(
        raised[1]!.detail,
        /^Rhea Rao asks, through Chief of staff\.\nChief of staff asked /,
      );
      assert.strictEqual((yield* questionRow(sql, asked.questionId)).state, "open");
      assert.lengthOf(yield* team.answeredWakes, 0);

      // His tap on the raised card answers it; the turn that answer wakes has read outside text.
      const card = yield* team.widgetOf((yield* questionRow(sql, asked.questionId)).raiseWidget!);
      yield* team.chats.act(team.person("dev"), {
        widgetId: card.widgetId,
        revision: card.revision,
        actionId: "choose",
        value: "option-1",
        clientActionId: "dev-raised-tap",
      });
      const [answered] = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
        FROM kin_events WHERE dedupe_key = ${`question-answered:${asked.questionId}`}`;
      assert.strictEqual(yield* stampOf(answered!.eventId), "mail-connection");
      const next = { orgId: KinOrgId.make(orgId), wakeupId: "answer-turn" };
      yield* inheritOutside({ ...next, eventIds: [answered!.eventId] });
      assert.strictEqual(yield* outsideStamp(next), "mail-connection");
    }).pipe(Effect.provide(layer)),
  ),
);
