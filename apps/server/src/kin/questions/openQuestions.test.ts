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
  KinOrgId,
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
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import type { KinDecision } from "../memory/MemoryWriter.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Team from "../team/KinTeam.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { presetDefinition } from "../work/registers.ts";
import * as Questions from "./openQuestions.ts";

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

// A plain-text question stays open for every agent until the person writes back. A carded one
// is answered in words only by its asker, in a turn woken by its person's own message in its chat
// since it was asked; the note that says so lets her, and only her, undo it.
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
      yield* refused("chief", /Only Finance/);
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
      const meera = { _tag: "person" as const, orgId, personId: KinPersonId.make("meera") };
      const group = (yield* Context.get(services, KinGroups).create([owner], {
        orgId,
        title: "Collections",
        agentIds: [KinAgentId.make("finance")],
        personIds: [meera.personId],
      })).chatId;
      yield* wake("finance", yield* say(group, "Finance, draft the VIOM one."));
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
      const tap = (who: typeof owner, option: string) =>
        widget(note!.widgetId!).pipe(
          Effect.flatMap((shown) =>
            chats.act(who, {
              widgetId: shown.widgetId,
              revision: shown.revision,
              actionId: "choose",
              value: option,
              clientActionId: `${who.personId}-${option}`,
            }),
          ),
        );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(tap(meera as typeof owner, "option-1"))));
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "answered");

      // Her Undo puts it back as it was: open, its card taking taps, its default on its day.
      yield* tap(owner, "option-1");
      assert.deepInclude(yield* questionRow(sql, questionId), { state: "open", answer: null });
      const reopened = yield* widget(card!.widgetId);
      assert.isNull(reopened.closedAt);
      assert.notProperty(reopened.state, "outcome");
      assert.deepInclude((yield* widget(note!.widgetId!)).state, {
        outcome: {
          title: "Undone",
          text: "“Shall I draft VIOM's payment reminder for INV-8?” is open again: Finance goes with “Draft it” tomorrow unless you answer.",
          undone: {
            personId: owner.personId,
            name: "Rhea Rao",
            at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          },
        },
      });
      const [waiting] = yield* repo.listOpenWaiting({ orgId, personId: owner.personId });
      assert.strictEqual(waiting!.widgetId, card!.widgetId);
      assert.deepInclude(waiting!.ask!, { agent: "Finance", default: "Draft it" });
      const told = yield* sql<{ key: string }>`SELECT dedupe_key AS key FROM kin_events
        WHERE org_id = ${orgId} AND agent_id = 'finance'
          AND dedupe_key LIKE 'question-answer-undone:%'`;
      assert.lengthOf(told, 1);
      assert.match(
        String(yield* Questions.undoneTurnText(KinOrgId.make(orgId), questionId)),
        /open again/,
      );
      assert.strictEqual(yield* settle(orgId, TUE_1930), 1);
      assert.strictEqual((yield* questionRow(sql, questionId)).state, "default_taken");
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
