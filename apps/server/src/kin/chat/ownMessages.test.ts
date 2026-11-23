import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  KinEvent,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { KinLeadPrompt, PROMPT_HEADINGS, UNREAD_RULE } from "../lead/LeadPrompt.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Memory from "../memory/Memory.ts";
import { handlers as pulseHandlers, KinPulseToolkit } from "../pulse/mcp.ts";
import { REVIEW_UNREAD_MS, reviewWakes } from "../pulse/reviewWake.ts";
import * as Team from "../team/KinTeam.ts";
import { presetDefinition } from "../work/registers.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import { KinChatService } from "./KinChatService.ts";
import { KinIdentity } from "./KinIdentity.ts";
import { OWN_MESSAGE_REFUSALS, OWN_UNREAD_SHOWN } from "./ownMessages.ts";
import { environment } from "./TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "./WakeupAuthority.testkit.ts";

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
  McpHttpServer.toolkitRegistration(KinPulseToolkit, pulseHandlers),
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
  return { ok: result.isError !== true, text, value: JSON.parse(text) as Record<string, unknown> };
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const IST_MON_0930 = Date.UTC(2026, 10, 16, 4);
const HOUR = 60 * 60_000;

/**
 * Ambermill Studio (invented): Rhea owns it, Meera co-owns it. Finance and the Chief of staff each
 * have a chat with Rhea; `say` posts as one of them, as a turn's reply would.
 */
const ambermill = Effect.gen(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const repo = Context.get(services, KinChatRepository);
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
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('meera', ${orgId}, 'meera', 'Meera Shah', ${at}, 'co_owner')`;
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
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
      created_at, definition_json)
    VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
  const say = Effect.fn("test.say")(function* (agent: string, id: string, body: string) {
    const chatId = chatOf.get(agent)!;
    const [member] = yield* sql<{ memberId: string }>`SELECT member_id AS "memberId"
      FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId} AND agent_id = ${agent}`;
    return yield* repo.insertMessage({
      audience: "owner",
      orgId,
      chatId,
      messageId: KinMessageId.make(id),
      author: {
        _tag: "agent",
        agentId: KinAgentId.make(agent),
        memberId: KinMemberId.make(member!.memberId),
        ownerPersonId: owner.personId,
        threadId: ThreadId.make(`${agent}-thread`),
      },
      kind: "text",
      body,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: iso(yield* Clock.currentTimeMillis),
      editedAt: null,
      serverPosted: true,
    });
  });
  const wake = (agent: string) =>
    startAgentWakeup({
      orgId,
      agentId: KinAgentId.make(agent),
      threadId: ThreadId.make(`${agent}-thread`),
    });
  return { sql, chats, repo, owner, orgId, chatOf: (id: string) => chatOf.get(id)!, say, wake };
});

const decodeEvent = Schema.decodeUnknownSync(KinEvent);
const promptLayer = KinLeadPrompt.layer.pipe(
  Layer.provide(
    Layer.mock(Memory.Memory)({
      readPromptSnapshot: () =>
        Effect.succeed({ rules: "", index: "", items: [], bodies: new Map() }),
      query: () => Effect.succeed([]),
      readItemQuietly: (org, id) => Effect.fail(new Memory.MemoryNotFound({ orgId: org, id })),
    }),
  ),
);
const unreadSection = (built: string) =>
  built.split(`${PROMPT_HEADINGS.unread}\n\n`)[1]?.split("\n\n# ")[0];

it.effect("an agent takes back or puts right only its own message that no one has read", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_0930),
    Effect.gen(function* () {
      const { sql, chats, repo, owner, orgId, chatOf, say, wake } = yield* ambermill;
      const chase = yield* say(
        "finance",
        "m-chase",
        "Lumen Grove still owes INV-14 (₹85,000), 12 days late.",
      );
      yield* say("finance", "m-gst", "The October GST return is due Thursday 26 Nov.");
      const asked = yield* chats.send(owner, {
        chatId: chatOf("finance"),
        body: "ok",
        clientMessageId: "m1",
      });
      yield* wake("finance");
      const withdraw = (agent: string, messageId: string, why = "Lumen Grove paid") =>
        callAs(agent, "message_withdraw", { messageId, why });
      const refused = (result: { ok: boolean; text: string }, text: string) => {
        assert.isFalse(result.ok, result.text);
        assert.include(result.text, text);
      };

      // Nothing there to change: unknown, a person's words, another agent's.
      refused(yield* withdraw("finance", "m-none"), OWN_MESSAGE_REFUSALS.unknown);
      refused(yield* withdraw("finance", asked.messageId), OWN_MESSAGE_REFUSALS.person);
      refused(
        yield* callAs("finance", "message_replace", { messageId: asked.messageId, body: "x" }),
        OWN_MESSAGE_REFUSALS.person,
      );
      yield* wake("chief");
      const byChief = yield* withdraw("chief", "m-chase");
      assert.isFalse(byChief.ok, byChief.text);
      assert.notInclude(byChief.text, '"withdrawn":true');
      yield* wake("finance");

      // A Confirm card refuses both tools; another card still waiting on someone refuses withdraw.
      for (const [widget, message, type, awaiting] of [
        ["w-confirm", "m-confirm", "approval", "[]"],
        ["w-choice", "m-choice", "choice", JSON.stringify([owner.personId])],
      ] as const) {
        yield* say(
          "finance",
          message,
          type === "approval" ? "Send INV-9 to Orbit?" : "Which first?",
        );
        yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
            type, revision, state_json, awaiting_json, updated_at)
          VALUES (${widget}, ${orgId}, ${chatOf("finance")}, ${message}, 'native', ${type}, 1,
            '{}', ${awaiting}, ${at})`;
      }
      refused(yield* withdraw("finance", "m-confirm"), OWN_MESSAGE_REFUSALS.confirm);
      refused(
        yield* callAs("finance", "message_replace", { messageId: "m-confirm", body: "New" }),
        OWN_MESSAGE_REFUSALS.confirm,
      );
      refused(yield* withdraw("finance", "m-choice"), OWN_MESSAGE_REFUSALS.openCard);
      // A brief's page is withdrawn whole, never rewritten.
      yield* say("finance", "m-brief", "Monday brief: two invoices late.");
      yield* sql`UPDATE kin_messages SET form = 'brief' WHERE message_id = 'm-brief'`;
      refused(
        yield* callAs("finance", "message_replace", { messageId: "m-brief", body: "New" }),
        OWN_MESSAGE_REFUSALS.brief,
      );

      // The turn lists what Rhea hasn't read, newest first, cards marked.
      const turnOf = Effect.fn("test.turnOf")(function* () {
        const turn = yield* wake("finance");
        const stored = yield* sql<{ json: string }>`SELECT json FROM kin_events
          WHERE org_id = ${orgId} AND wakeup_id = ${turn} ORDER BY rowid`;
        return yield* Effect.flatMap(KinLeadPrompt, (prompt) =>
          prompt.build({
            orgId,
            agentId: KinAgentId.make("finance"),
            wakeupId: turn,
            events: stored.map((row) => decodeEvent(JSON.parse(row.json))),
            memoryHead: "fixture",
            lane: { chatId: chatOf("finance"), mode: "reply" },
          }),
        ).pipe(Effect.provide(promptLayer));
      });
      const listed = unreadSection(yield* turnOf())!;
      assert.isTrue(listed.startsWith(UNREAD_RULE), listed);
      assert.include(
        listed,
        '- m-chase, 09:30: "Lumen Grove still owes INV-14 (₹85,000), 12 days late."',
      );
      assert.include(listed, 'its "approval" card is open');
      assert.isBelow(listed.indexOf("m-brief"), listed.indexOf("m-gst"));
      assert.notInclude(listed, "older ones");

      // Withdrawn: one quiet line for everyone, its words for the owner, out of the unread count.
      const unreadBefore = (yield* repo.unreadCounts(owner)).get(chatOf("finance"));
      const done = yield* withdraw("finance", "m-chase");
      assert.isTrue(done.ok, done.text);
      assert.deepStrictEqual(done.value, { messageId: "m-chase", withdrawn: true });
      assert.isTrue((yield* withdraw("finance", "m-chase")).ok, "the same retry answers as before");
      refused(
        yield* withdraw("finance", "m-chase", "Changed my mind"),
        OWN_MESSAGE_REFUSALS.withdrawn,
      );
      refused(
        yield* callAs("finance", "message_replace", { messageId: "m-chase", body: "New" }),
        OWN_MESSAGE_REFUSALS.withdrawn,
      );
      assert.strictEqual(
        (yield* repo.unreadCounts(owner)).get(chatOf("finance")),
        unreadBefore! - 1,
      );
      const history = yield* chats.history(owner, {
        chatId: chatOf("finance"),
        beforeSeq: 1000,
        limit: 100,
      });
      const line = history.messages.find((one) => one.messageId === chase.messageId)!;
      assert.strictEqual(line.body, "");
      assert.include(line.withdrawn!, { why: "Lumen Grove paid", said: chase.body });
      assert.notInclude(unreadSection(yield* turnOf())!, "m-chase");

      // Replaced: in place, marked updated, and named as a new post would be.
      const replaced = yield* callAs("finance", "message_replace", {
        messageId: "m-gst",
        body: "The October GST return is due Friday 27 Nov.",
      });
      assert.isTrue(replaced.ok, replaced.text);
      const replacedAt = iso(yield* Clock.currentTimeMillis);
      const [gst] = yield* sql<{ body: string; edited: string | null }>`SELECT body,
          edited_at AS edited FROM kin_messages WHERE message_id = 'm-gst'`;
      assert.deepStrictEqual(gst, {
        body: "The October GST return is due Friday 27 Nov.",
        edited: replacedAt,
      });

      // Once Rhea has read it, it is hers as written: both tools refuse and name her.
      const [latest] = yield* sql<{ seq: number }>`SELECT MAX(seq) AS seq FROM kin_messages
        WHERE chat_id = ${chatOf("finance")}`;
      yield* chats.markRead(owner, { chatId: chatOf("finance"), seq: latest!.seq });
      const read = OWN_MESSAGE_REFUSALS.read("Rhea Rao");
      refused(yield* withdraw("finance", "m-gst"), read);
      refused(yield* callAs("finance", "message_replace", { messageId: "m-gst", body: "x" }), read);
      assert.isUndefined(unreadSection(yield* turnOf()), "no section once all is read");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a question card goes with its message, and Waiting on you lets it go", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_0930),
    Effect.gen(function* () {
      const { sql, chats, repo, owner, orgId, chatOf, wake } = yield* ambermill;
      yield* chats.send(owner, { chatId: chatOf("finance"), body: "VIOM?", clientMessageId: "m1" });
      yield* wake("finance");
      const asked = yield* callAs("finance", "kin_ask", {
        question: "Shall I draft VIOM's payment reminder for INV-8?",
        options: [{ label: "Draft it" }, { label: "Leave it" }],
        default: "Draft it",
        about: ["INV-8"],
        intent: "draft payment reminder",
      });
      assert.isTrue(asked.ok, asked.text);
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 1);
      const [card] = yield* sql<{ messageId: string }>`SELECT COALESCE(w.message_id,
          (SELECT m.message_id FROM kin_messages m WHERE m.widget_id = w.widget_id)) AS "messageId"
        FROM kin_questions q JOIN kin_widgets w ON w.widget_id = COALESCE(q.widget_id, q.raise_widget_id)
        WHERE q.question_id = ${asked.value.question as string}`;
      const gone = yield* callAs("finance", "message_withdraw", {
        messageId: card!.messageId,
        why: "VIOM paid this morning",
      });
      assert.isTrue(gone.ok, gone.text);
      const [question] = yield* sql<{ state: string }>`SELECT state FROM kin_questions
        WHERE question_id = ${asked.value.question as string}`;
      assert.notStrictEqual(question!.state, "open");
      assert.lengthOf(yield* repo.listOpenWaiting({ orgId, personId: owner.personId }), 0);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a turn shows the newest unread and counts the rest", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_0930),
    Effect.gen(function* () {
      const { sql, orgId, chatOf, say, wake } = yield* ambermill;
      for (let n = 1; n <= OWN_UNREAD_SHOWN + 3; n++) yield* say("finance", `m-${n}`, `Note ${n}`);
      const turn = yield* wake("finance");
      const stored = yield* sql<{ json: string }>`SELECT json FROM kin_events
        WHERE org_id = ${orgId} AND wakeup_id = ${turn} ORDER BY rowid`;
      const built = yield* Effect.flatMap(KinLeadPrompt, (prompt) =>
        prompt.build({
          orgId,
          agentId: KinAgentId.make("finance"),
          wakeupId: turn,
          events: stored.map((row) => decodeEvent(JSON.parse(row.json))),
          memoryHead: "fixture",
          lane: { chatId: chatOf("finance"), mode: "reply" },
        }),
      ).pipe(Effect.provide(promptLayer));
      const listed = unreadSection(built)!;
      assert.lengthOf(
        listed.split("\n").filter((one) => one.startsWith("- m-")),
        OWN_UNREAD_SHOWN,
      );
      assert.include(listed, `- m-${OWN_UNREAD_SHOWN + 3},`);
      assert.notInclude(listed, "- m-3,");
      assert.include(listed, "And 3 older ones.");
    }).pipe(Effect.provide(layer)),
  ),
);

// Each condition alone wakes no one: unread long enough, a change since, none pending, and the
// last review before that change. One review per chat at a time.
it.effect("a review wake needs time unread, a change since, and no review pending", () =>
  Effect.andThen(
    TestClock.setTime(IST_MON_0930),
    Effect.gen(function* () {
      const { sql, owner, orgId, chatOf, say } = yield* ambermill;
      const org = KinOrgId.make(orgId);
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'rec-inv14', 'invoices', 'INV-14', 'Lumen Grove retainer', 'person',
          ${owner.personId}, 'person', 'inv14', 0, 0)`;
      let rev = 1;
      const moved = Effect.fn("test.moved")(function* (when: number) {
        rev += 1;
        yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind,
            actor_id, via, kind, fields_json)
          VALUES (${orgId}, 'rec-inv14', ${rev}, ${when}, 'person', ${owner.personId}, 'owner',
            'updated', '[{"field":"state","from":"waiting","to":"done"}]')`;
      });
      const sweep = Effect.fn("test.sweep")(function* (when: number) {
        yield* TestClock.setTime(when);
        return yield* reviewWakes({ orgId: org, at: when });
      });
      // A change from before the message is no change since it.
      yield* moved(IST_MON_0930 - HOUR);
      yield* say("finance", "m-chase", "Lumen Grove still owes INV-14 (₹85,000).");
      yield* say("chief", "m-plan", "Your week has three client calls.");

      // Changed, but not unread long enough.
      yield* moved(IST_MON_0930 + HOUR);
      assert.deepStrictEqual(yield* sweep(IST_MON_0930 + HOUR + 1), []);
      // Unread long enough: Finance's changed; the Chief's has nothing changed.
      const due = IST_MON_0930 + REVIEW_UNREAD_MS;
      assert.deepStrictEqual(yield* sweep(due), [
        { agentId: "finance", chatId: chatOf("finance") },
      ]);
      // One pending per chat.
      yield* moved(due + 1);
      assert.deepStrictEqual(yield* sweep(due + 2), []);
      const [event] = yield* sql<{ json: string }>`SELECT json FROM kin_events
        WHERE org_id = ${orgId} AND dedupe_key LIKE 'review:%'`;
      assert.include(JSON.parse(event!.json), { review: true, chatId: chatOf("finance") });
      // Done: the change made while it was pending is looked at once more, then nothing.
      yield* sql`UPDATE kin_events SET state = 'done' WHERE dedupe_key LIKE 'review:%'`;
      assert.lengthOf(yield* sweep(due + 3), 1);
      yield* sql`UPDATE kin_events SET state = 'done' WHERE dedupe_key LIKE 'review:%'`;
      assert.deepStrictEqual(yield* sweep(due + 4), []);
      // A change after the last review wakes it once more.
      yield* moved(due + HOUR);
      assert.lengthOf(yield* sweep(due + HOUR + 1), 1);
      yield* sql`UPDATE kin_events SET state = 'done' WHERE dedupe_key LIKE 'review:%'`;

      // Rhea's working day about to start is a change too, for the Chief's message.
      yield* sql`UPDATE kin_people SET quiet_hours_json = '{"from":"20:00","to":"10:00"}'
        WHERE person_id = ${owner.personId}`;
      const tuesday0945 = Date.UTC(2026, 10, 17, 4, 15);
      assert.deepStrictEqual((yield* sweep(tuesday0945)).map((one) => one.agentId).toSorted(), [
        "chief",
        "finance",
      ]);
      // Once read, nothing is reviewed.
      yield* sql`UPDATE kin_events SET state = 'done' WHERE dedupe_key LIKE 'review:%'`;
      yield* moved(tuesday0945 + 1);
      const [latest] = yield* sql<{ seq: number }>`SELECT MAX(seq) AS seq FROM kin_messages
        WHERE chat_id = ${chatOf("finance")}`;
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      yield* Context.get(services, KinChatService).markRead(owner, {
        chatId: chatOf("finance"),
        seq: latest!.seq,
      });
      assert.deepStrictEqual(yield* sweep(tuesday0945 + 2), []);
    }).pipe(Effect.provide(layer)),
  ),
);
