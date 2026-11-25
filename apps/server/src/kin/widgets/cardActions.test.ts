import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  type KinChoiceOutcome,
  KinEvent,
  KinMemberId,
  KinMemoryItemId,
  KinPersonId,
  KinWidgetId,
  KIN_TAKEN_DEFAULT_FIELD,
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
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinConnections, NOT_CHECKED } from "../connections/ConnectionsService.ts";
import { fileStore, makeFakeMail } from "../connections/FakeMail.ts";
import * as ServerConfig from "../../config.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { wakeEvent } from "../lead/ChatWake.ts";
import { agentChanges, ownerLevelUndoAgentChange } from "../lead/agentChanges.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as KinOpen from "../open/KinOpen.ts";
import { tellTaken } from "../questions/defaultTaken.ts";
import * as Questions from "../questions/openQuestions.ts";
import * as Team from "../team/KinTeam.ts";
import {
  KinDeferralStopSwitch,
  deferralTriggerId,
  makeDeferralCards,
} from "../triggers/deferrals.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { handlers as workHandlers } from "../work/mcp/handlers.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { handlers as documentHandlers, KinDocumentToolkit } from "../gendocs/mcp.ts";
import {
  defineList,
  listDef,
  listPlace,
  presetDefinition,
  propose,
  proposalFor,
} from "../work/registers.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { DAY_MS } from "../pulse/thresholds.ts";
import * as KinShell from "../shell/KinShell.ts";
import * as CardActions from "./cardActions.ts";
import { plansOf, takesAsDefault } from "./cardPlans.ts";
import { FEWER_THAN_TWO, NOTHING_TIMED } from "./choiceCard.ts";
import { ensureBankList } from "../work/statements/bankList.ts";
import { parseFields } from "../work/lists.ts";
import { buildReview } from "../work/statements/statementReview.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const at = "2026-10-01T00:00:00.000Z";
const MON = Date.UTC(2026, 10, 16, 6);
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
const HELLO = "hello@ambermill.example";
/** As a dev server runs: its mail goes to the fake mailbox, where `HELLO` is connected at start. */
const devMail = Layer.mergeAll(
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      devUrl: new URL("http://localhost:5733"),
    })),
  ),
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ KIN_ENABLED: true, KIN_DEV_FAKE_MAIL: `microsoft:${HELLO}` }),
  ),
).pipe(Layer.provide(kinSecretsTest));
const layerOver = (dev: boolean) =>
  Layer.mergeAll(
    McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
    McpHttpServer.toolkitRegistration(KinWorkToolkit, workHandlers),
    McpHttpServer.toolkitRegistration(KinDocumentToolkit, documentHandlers),
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
        Layer.provide(
          dev
            ? devMail
            : Layer.merge(
                kinSecretsTest,
                ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true })),
              ),
        ),
        Layer.provideMerge(environment),
      ),
    ),
    Layer.provideMerge(authorityLayer),
    Layer.provideMerge(kinSecretsTest),
  );
const layer = layerOver(false);

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
 * Ambermill (invented): Rhea owns it, Meera co-owns it, Dev is a teammate let in by invite. The
 * Chief of staff and Finance each have a chat with Rhea; Work holds a few of Rhea's tasks.
 */
const ambermill = Effect.gen(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const records = Context.get(services, KinRecords);
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
  // The company's clock, which its days, quiet hours and away dates follow, on any host.
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00',
      0, 1, '09:00', '{}') ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
  yield* sql`UPDATE kin_people SET display_name = 'Rhea Rao' WHERE person_id = ${owner.personId}`;
  for (const [id, name, access] of [
    ["meera", "Meera Shah", "co_owner"],
    ["dev", "Dev Malhotra", "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${id}, ${orgId}, ${id}, ${name}, ${at}, ${access})`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('dev-session', ${orgId}, 'dev', 0)`;
  const chatOf = new Map<string, KinChatId>();
  for (const [id, name, domain] of [
    ["chief", "Chief of staff", "chief-of-staff"],
    ["finance", "Finance", "finance"],
  ] as const) {
    const agentId = KinAgentId.make(id);
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, ${name}, 'lead', ${owner.personId}, ${at})`;
    yield* identity.registerAgentThread({
      orgId,
      agentId,
      threadId: ThreadId.make(`${id}-thread`),
    });
    const chatId = (yield* chats.createDirect(owner, { orgId, agentId })).chatId;
    chatOf.set(id, chatId);
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agentId}, ${orgId}, ${name}, 0, ${`${id}-thread`}, '{}', '[]', ${chatId}, ${domain})`;
  }
  const person = (id: string) => ({
    _tag: "person" as const,
    orgId,
    personId: KinPersonId.make(id),
  });
  const task = Effect.fn("test.task")(function* (title: string, holder = owner.personId) {
    const made = yield* records.create(
      orgId,
      {
        actor: { _tag: "person", personId: owner.personId },
        via: "owner",
        askedBy: owner.personId,
      },
      {
        title,
        owner: { _tag: "person", personId: holder },
        originKey: title,
        team: true,
      },
    );
    return made.row;
  });
  /** A turn of `agent`'s, woken on `who`'s message in `chatId`. */
  const turn = Effect.fn("test.turn")(function* (
    agent: string,
    chatId: KinChatId,
    body: string,
    who: { readonly _tag: "person"; readonly personId: KinPersonId } = owner,
  ) {
    const message = yield* chats.send({ ...who, orgId }, { chatId, body, clientMessageId: body });
    return yield* startAgentWakeup({
      orgId,
      agentId: KinAgentId.make(agent),
      threadId: ThreadId.make(`${agent}-thread`),
      message,
    });
  });
  const widget = (widgetId: unknown) =>
    repo
      .getWidget({ orgId, widgetId: KinWidgetId.make(widgetId as string) })
      .pipe(Effect.map(Option.getOrThrow));
  const tap = (
    who: { readonly _tag: "person"; readonly personId: KinPersonId },
    widgetId: unknown,
    option: string,
    clientActionId: string,
  ) =>
    widget(widgetId).pipe(
      Effect.flatMap((card) =>
        chats.act(
          { ...who, orgId },
          {
            widgetId: card.widgetId,
            revision: card.revision,
            actionId: "choose",
            value: option,
            clientActionId,
          },
        ),
      ),
    );
  const stateOf = (key: string) =>
    records.get(orgId, key).pipe(Effect.map((row) => ({ state: row!.state, rev: row!.rev })));
  return {
    sql,
    chats,
    repo,
    records,
    owner,
    orgId,
    services,
    chatOf: (id: string) => chatOf.get(id)!,
    person,
    task,
    turn,
    widget,
    tap,
    stateOf,
    settleDeps: {
      chat: chats,
      queue: Context.get(services, KinEventQueue.KinEventQueue),
      records,
    },
  };
});

type CardState = {
  readonly detail: string | null;
  readonly options: ReadonlyArray<{
    readonly optionId: string;
    readonly label: string;
    readonly kind?: string;
    readonly action?: { readonly line: string };
  }>;
  readonly answer: unknown;
  readonly outcome?: KinChoiceOutcome;
};
const card = (widget: { readonly state: unknown }) => widget.state as CardState;
const decodeEvent = Schema.decodeEffect(KinEvent);
const closeIt = (key: string) => ({
  question: `${key} looks finished. Close it?`,
  options: [{ label: "Close it", action: { kind: "done", target: key } }, { label: "Not yet" }],
  default: "none",
});

// One tap marks the task done in server code: the card shows the server's own line, the tap is
// handled (no turn), and a retry, a second tap and another session all get the first answer.
it.effect("a tap on an action option runs it once, as the server wrote it", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId } = kin;
      const row = yield* kin.task("Set up the appointments API");
      yield* kin.turn("finance", kin.chatOf("finance"), "Where is the API work?");
      const asked = yield* callAs("finance", "kin_ask", {
        ...closeIt(row.key),
        options: [
          { label: "Mark it done", kind: "yes", action: { kind: "done", target: row.key } },
          { label: "Not yet", kind: "no" },
        ],
      });
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      // The agent learns the card, never its plan, and that with no default nothing happens.
      assert.deepStrictEqual(Object.keys(asked.value).toSorted(), [
        "by",
        "messageId",
        "note",
        "question",
        "untaken",
        "widgetId",
      ]);
      assert.strictEqual(asked.value.untaken, "none");
      assert.strictEqual(
        asked.value.note,
        "Kin won't take any answer on its own: no default was set.",
      );
      const drawn = yield* kin.widget(asked.value.widgetId);
      const line = `Mark ${row.key} “Set up the appointments API” done`;
      // The button says what it does, in the server's words; the agent's label isn't shown.
      assert.deepStrictEqual(card(drawn).options[0], {
        optionId: "option-1",
        label: `Mark ${row.key} done`,
        action: { line },
      });
      assert.notInclude(JSON.stringify(drawn.state), "Mark it done");
      // An older client that only reads the card's text still sees what the tap does.
      assert.include(card(drawn).detail, `Mark ${row.key} done: ${line}`);
      // Nothing that runs the plan reaches a client: not in the card, not in chat history.
      const history = yield* kin.chats.history(owner, {
        chatId: kin.chatOf("finance"),
        beforeSeq: 1000,
        limit: 100,
      });
      for (const payload of [JSON.stringify(drawn), JSON.stringify(history)]) {
        assert.notInclude(payload, row.recordId);
        assert.notInclude(payload, '"draw"');
        assert.notInclude(payload, '"ceiling"');
      }

      const first = yield* kin.tap(owner, asked.value.widgetId, "option-1", "tap-1");
      assert.deepInclude(JSON.parse(first.body), { handled: true });
      assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "done", rev: row.rev + 1 });
      const settled = yield* kin.widget(asked.value.widgetId);
      assert.isNotNull(settled.closedAt);
      assert.deepStrictEqual(card(settled).outcome, {
        title: "Done",
        text: `Marked ${row.key} “Set up the appointments API” done.`,
      });
      assert.strictEqual(
        (yield* Questions.readQuestion(orgId, asked.value.question as string))?.state,
        "answered",
      );
      // A retry, the same tap again and a tap from another session do nothing more.
      const retry = yield* kin.chats.act(owner, {
        widgetId: drawn.widgetId,
        revision: drawn.revision,
        actionId: "choose",
        value: "option-1",
        clientActionId: "tap-1",
      });
      const second = yield* kin.tap(owner, asked.value.widgetId, "option-1", "tap-2");
      const otherSession = yield* kin.chats.act(owner, {
        widgetId: drawn.widgetId,
        revision: drawn.revision,
        actionId: "choose",
        value: "option-1",
        clientActionId: "phone-tap",
      });
      for (const again of [retry, second, otherSession])
        assert.strictEqual(again.messageId, first.messageId);
      const swapped = yield* kin.chats
        .act(owner, {
          widgetId: drawn.widgetId,
          revision: drawn.revision,
          actionId: "choose",
          value: "option-2",
          clientActionId: "tap-1",
        })
        .pipe(Effect.flip);
      assert.include(swapped, { reason: "not_allowed" });
      assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "done", rev: row.rev + 1 });
      const changes = yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_changes
        WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
      assert.strictEqual(changes[0]!.n, 2);

      // A task Finance itself holds: closing it tells Finance to stop, as any person's close
      // does, and the tap itself still wakes no one.
      const held = yield* kin.task("Reconcile October");
      yield* kin.records.update(
        orgId,
        {
          actor: { _tag: "person", personId: owner.personId },
          via: "owner",
          askedBy: owner.personId,
        },
        held.key,
        { owner: { _tag: "agent", agentId: KinAgentId.make("finance") } },
      );
      yield* kin.turn("finance", kin.chatOf("finance"), "October?");
      const heldCard = yield* callAs("finance", "kin_ask", closeIt(held.key));
      const stop = yield* kin.tap(owner, heldCard.value.widgetId, "option-1", "tap-held");
      assert.deepInclude(JSON.parse(stop.body), { handled: true });
      assert.strictEqual((yield* kin.stateOf(held.key)).state, "done");
      const told = yield* kin.sql<{
        reason: string;
      }>`SELECT json_extract(json, '$.reason') AS reason
        FROM kin_events WHERE org_id = ${orgId} AND tag = 'record.changed'
          AND json_extract(json, '$.key') = ${held.key} ORDER BY rowid`;
      assert.deepStrictEqual(told.at(-1), { reason: "withdrawn" });

      // A plain option on another card still wakes its agent as before.
      yield* kin.turn("finance", kin.chatOf("finance"), "And the invoices?");
      const plain = yield* callAs("finance", "kin_ask", {
        question: "Chase VIOM today?",
        options: [{ label: "Chase" }, { label: "Wait" }],
        default: "none",
      });
      const chose = yield* kin.tap(owner, plain.value.widgetId, "option-1", "tap-plain");
      assert.notProperty(JSON.parse(chose.body), "handled");
      // Work chosen on a card is tracked: the option marked yes becomes the agent's task, once;
      // the one marked no makes none.
      const chosenTasks = kin.sql<{ title: string; kind: string; state: string }>`SELECT title,
          owner_kind AS kind, state FROM kin_records
        WHERE org_id = ${orgId} AND title LIKE 'Which way for partner reimbursements%'
        ORDER BY key`;
      for (const [option, turn] of [
        ["option-2", "Reimbursements, again?"],
        ["option-1", "Reimbursements?"],
      ] as const) {
        yield* kin.turn("finance", kin.chatOf("finance"), turn);
        const way = yield* callAs("finance", "kin_ask", {
          question: "Which way for partner reimbursements?",
          options: [
            { label: "Paid-by tag", kind: "yes" },
            { label: "Leave it", kind: "no" },
          ],
          default: "none",
          intent: "build the reimbursement tag",
        });
        assert.isTrue(way.ok, JSON.stringify(way.value));
        yield* kin.tap(owner, way.value.widgetId, option, `tap-${option}`);
      }
      assert.deepStrictEqual(yield* chosenTasks, [
        {
          title: "Which way for partner reimbursements: Paid-by tag",
          kind: "agent",
          state: "open",
        },
      ]);

      // A drop the agent labelled "Not yet" says "Drop" on its button, and a plain option that
      // would read the same as an action option is refused.
      const later = yield* kin.task("Order the signage");
      yield* kin.turn("finance", kin.chatOf("finance"), "The signage?");
      const contradicts = yield* callAs("finance", "kin_ask", {
        question: "Order the signage now?",
        options: [
          { label: "Not yet", action: { kind: "drop", target: later.key } },
          { label: "Order it" },
        ],
        default: "none",
      });
      assert.isTrue(contradicts.ok, JSON.stringify(contradicts.value));
      assert.strictEqual(
        card(yield* kin.widget(contradicts.value.widgetId)).options[0]?.label,
        `Drop ${later.key}`,
      );
      const lookalike = yield* callAs("finance", "kin_ask", {
        question: "Drop the signage?",
        options: [
          { label: "Yes", action: { kind: "drop", target: later.key } },
          { label: `drop ${later.key}` },
        ],
        default: "none",
      });
      assert.isFalse(lookalike.ok);
      // Read as a person reads them, two spaces are one: these buttons would look the same.
      const spaced = yield* callAs("finance", "kin_ask", {
        question: "Drop the signage now?",
        options: [
          { label: "Yes", action: { kind: "drop", target: later.key } },
          { label: `Drop  ${later.key}` },
        ],
        default: "none",
      });
      assert.isFalse(spaced.ok);
      // So is a character nobody sees.
      const unseen = yield* callAs("finance", "kin_ask", {
        question: "Drop the signage today?",
        options: [
          { label: "Yes", action: { kind: "drop", target: later.key } },
          { label: `Drop ${later.key.replace("-", "\u200b-")}` },
        ],
        default: "none",
      });
      assert.isFalse(unseen.ok);
      assert.strictEqual((yield* kin.stateOf(later.key)).state, "open");
      // "none" is no default, even when an action option is labelled "none".
      const noneLabelled = yield* callAs("finance", "kin_ask", {
        question: "Is the signage settled?",
        options: [
          { label: "none", action: { kind: "done", target: later.key } },
          { label: "Keep it" },
        ],
        default: "none",
      });
      assert.isTrue(noneLabelled.ok, JSON.stringify(noneLabelled.value));
      assert.isNull(
        (yield* Questions.readQuestion(orgId, noneLabelled.value.question as string))?.defaultLabel,
      );
      // The lines Kin adds for an action take their room from the detail: it is never cut, so a
      // detail past what is left is refused before any card is made.
      const note = `Mark ${later.key} done: Mark ${later.key} “Order the signage” done`;
      const room = 2000 - note.length - 2;
      const closeAsk = (question: string, detail: string) =>
        callAs("finance", "kin_ask", {
          question,
          detail,
          options: [
            { label: "Close it", action: { kind: "done", target: later.key } },
            { label: "Not yet" },
          ],
          default: "none",
        });
      const cardsBefore = yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets`;
      assert.deepStrictEqual(yield* closeAsk("Close the signage?", "x".repeat(room + 1)), {
        ok: false,
        value: {
          _tag: "KinChatError",
          reason: "invalid_state",
          message: `detail is ${(room + 1).toLocaleString("en-US")} characters, and with the lines Kin adds for options with an action this card holds ${room.toLocaleString("en-US")} of it: shorten detail and ask again.`,
        },
      });
      assert.deepStrictEqual(
        yield* kin.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets`,
        cardsBefore,
      );
      const whole = yield* closeAsk("Close the signage now?", "x".repeat(room));
      assert.isTrue(whole.ok, JSON.stringify(whole.value));
      assert.strictEqual(
        card(yield* kin.widget(whole.value.widgetId)).detail,
        `${"x".repeat(room)}\n\n${note}`,
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// The plan binds the entry's revision: a change in the same clock tick, a retired drawer or a
// reaction runs nothing; the timer never takes an action as a default; another org's key is unknown.
it.effect("a tap closes or cancels a list section's entry, and its late fact clears", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json, rev)
        VALUES (${orgId}, 'bookings', 'Bookings', 'BK', 0, 0, ${JSON.stringify({
          noun: "booking",
          states: ["open", "done", "dropped"],
          stateLabels: { open: "Booked", done: "Held", dropped: "Cancelled" },
          defaultState: "open",
          categories: [],
          fields: [],
          sensitive: false,
          amount: false,
          currency: "INR",
          dateLabel: "Booking date",
          remindOn: "date",
        })}, 1)`;
      yield* KinShell.set(orgId, owner.personId, 0, [{ id: "list:bookings", on: true }]).pipe(
        Effect.provide(kin.services),
      );
      const booking = Effect.fn("test.booking")(function* (title: string) {
        const made = yield* kin.records.create(
          orgId,
          {
            actor: { _tag: "person", personId: owner.personId },
            via: "owner",
            askedBy: owner.personId,
          },
          {
            list: "bookings",
            title,
            owner: { _tag: "person", personId: owner.personId },
            originKey: title,
            dateAt: MON - DAY_MS,
            dateAllDay: true,
          },
        );
        return made.row;
      });
      const held = yield* booking("Ananya Rao, room 4");
      const missed = yield* booking("Kabir Sen, room 2");
      const lateKeys = Effect.gen(function* () {
        const ticked = yield* KinPulse.tick(orgId, yield* Clock.currentTimeMillis).pipe(
          Effect.provide(kin.services),
        );
        const open = yield* kin.sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
          WHERE org_id = ${orgId} AND cleared_at IS NULL AND sense = 'entry_late'
          ORDER BY fact_key`;
        return { ticked, keys: open.map((row) => row.key.split(":")[1]) };
      });
      assert.deepStrictEqual((yield* lateKeys).keys, [held.key, missed.key]);
      const ask = (key: string, kind: "done" | "drop") =>
        Effect.gen(function* () {
          yield* kin.turn("chief", kin.chatOf("chief"), `Did ${key} go ahead?`);
          return yield* callAs("chief", "kin_ask", {
            question: `Did ${key} go ahead?`,
            options: [{ label: "Yes", action: { kind, target: key } }, { label: "Not sure" }],
            default: "none",
            about: [key],
          });
        });
      const yes = yield* ask(held.key, "done");
      assert.isTrue(yes.ok, JSON.stringify(yes.value));
      assert.strictEqual(
        card(yield* kin.widget(yes.value.widgetId)).options[0]?.label,
        `Mark ${held.key} done`,
      );
      yield* kin.tap(owner, yes.value.widgetId, "option-1", "tap-held");
      const no = yield* ask(missed.key, "drop");
      assert.isTrue(no.ok, JSON.stringify(no.value));
      yield* kin.tap(owner, no.value.widgetId, "option-1", "tap-missed");
      assert.deepStrictEqual(
        [yield* kin.stateOf(held.key), yield* kin.stateOf(missed.key)],
        [
          { state: "done", rev: held.rev + 1 },
          { state: "dropped", rev: missed.rev + 1 },
        ],
      );
      assert.deepStrictEqual((yield* lateKeys).keys, []);
      // Dev, a member, can't change the company's Bookings: his turn's card is refused.
      const third = yield* booking("Mira Das, room 1");
      const dev = kin.person("dev");
      const devChat = (yield* kin.chats.createDirect(dev, {
        orgId,
        agentId: KinAgentId.make("chief"),
      })).chatId;
      yield* kin.turn("chief", devChat, "Close the room 1 booking", dev);
      const refused = yield* callAs("chief", "kin_ask", {
        question: `Close ${third.key}?`,
        options: [{ label: "Yes", action: { kind: "done", target: third.key } }, { label: "No" }],
        default: "none",
      });
      assert.isFalse(refused.ok);
      assert.deepStrictEqual(yield* kin.stateOf(third.key), { state: "open", rev: third.rev });
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a stale card, a reaction, a passed day or a foreign key runs nothing", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const renamed = yield* kin.task("Draft the clinic brochure");
      const reacted = yield* kin.task("Book the photographer");
      const timed = yield* kin.task("Send the Lumen proposal");
      const retired = yield* kin.task("Renew the domain");
      yield* kin.turn("finance", kin.chatOf("finance"), "What can we close?");
      const stale = yield* callAs("finance", "kin_ask", closeIt(renamed.key));
      assert.isTrue(stale.ok, JSON.stringify(stale.value));
      // Same millisecond: only the revision tells the change.
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        renamed.key,
        { title: "Draft the clinic brochure v2" },
      );
      const staleTap = yield* kin.tap(owner, stale.value.widgetId, "option-1", "stale");
      assert.deepInclude(JSON.parse(staleTap.body), { handled: true });
      assert.strictEqual((yield* kin.stateOf(renamed.key)).state, "open");
      const closed = yield* kin.widget(stale.value.widgetId);
      assert.isNotNull(closed.closedAt);
      assert.deepStrictEqual(card(closed).outcome, {
        title: "Nothing was done",
        text: `${renamed.key} changed since this was offered, so nothing was done.`,
      });

      // A plan sealed for another chat runs nothing on this card, and isn't taken as plain.
      const moved = yield* kin.task("Print the menus");
      yield* kin.turn("finance", kin.chatOf("finance"), "Menus?");
      const elsewhere = yield* callAs("finance", "kin_ask", closeIt(moved.key));
      yield* sql`UPDATE kin_card_plans SET chat_id = ${kin.chatOf("chief")}
        WHERE widget_id = ${elsewhere.value.widgetId as string}`;
      const misfiled = yield* kin
        .tap(owner, elsewhere.value.widgetId, "option-1", "misfiled")
        .pipe(Effect.flip);
      assert.include(misfiled, { reason: "not_allowed" });
      assert.strictEqual((yield* kin.stateOf(moved.key)).state, "open");

      // A reaction never runs it: the action option carries no yes/no kind, and a stored one
      // that says otherwise is refused rather than run.
      yield* kin.turn("finance", kin.chatOf("finance"), "And the photographer?");
      const asked = yield* callAs("finance", "kin_ask", {
        ...closeIt(reacted.key),
        options: [
          { label: "Yes", kind: "yes", action: { kind: "done", target: reacted.key } },
          { label: "No", kind: "no" },
        ],
      });
      const drawn = yield* kin.widget(asked.value.widgetId);
      assert.notProperty(card(drawn).options[0], "kind");
      yield* kin.chats.react(owner, { messageId: drawn.messageId, emoji: "👍", on: true });
      assert.strictEqual((yield* kin.stateOf(reacted.key)).state, "open");
      assert.isNull(card(yield* kin.widget(asked.value.widgetId)).answer);
      yield* sql`UPDATE kin_widgets SET state_json = json_set(state_json, '$.options[0].kind', 'yes')
        WHERE widget_id = ${drawn.widgetId}`;
      yield* kin.chats.react(owner, { messageId: drawn.messageId, emoji: "👍", on: false });
      const forced = yield* kin.chats
        .react(owner, { messageId: drawn.messageId, emoji: "👍", on: true })
        .pipe(Effect.flip);
      assert.include(forced, { reason: "not_allowed" });
      assert.strictEqual((yield* kin.stateOf(reacted.key)).state, "open");

      // Its default is the action, on a task that repeats: at its day it is raised again, never
      // taken, though the question is about sending (a done is judged by what it does).
      const byRhea = {
        actor: { _tag: "person" as const, personId: owner.personId },
        via: "owner" as const,
      };
      yield* kin.records.update(orgId, byRhea, timed.key, {
        dueAt: MON + 7 * 86_400_000,
        repeat: { every: "month" },
      });
      const timedRev = (yield* kin.stateOf(timed.key)).rev;
      yield* kin.turn("finance", kin.chatOf("finance"), "And the proposal?");
      const daily = yield* callAs("finance", "kin_ask", {
        ...closeIt(timed.key),
        question: `${timed.key} looks finished. Close it, or send it first?`,
        default: "Close it",
      });
      assert.isTrue(daily.ok, JSON.stringify(daily.value));
      assert.strictEqual(daily.value.untaken, "repeats");
      const due = Date.parse(daily.value.by as string);
      yield* TestClock.setTime(due + 60_000);
      yield* Questions.settleDue(orgId, due + 60_000, kin.settleDeps);
      assert.notStrictEqual(
        (yield* Questions.readQuestion(orgId, daily.value.question as string))?.state,
        "default_taken",
      );
      assert.strictEqual((yield* kin.stateOf(timed.key)).state, "open");
      const taken = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
        AND dedupe_key LIKE 'question:%'`;
      assert.lengthOf(taken, 0);

      // Raised on its next morning, the card's action is drawn again: a tap on the raised card
      // runs it once. One whose task closed before the raise closed with it, and isn't raised.
      const shut = yield* kin.task("Return the sample tiles");
      yield* kin.turn("finance", kin.chatOf("finance"), "And the tiles?");
      const gone = yield* callAs("finance", "kin_ask", {
        ...closeIt(shut.key),
        options: [...closeIt(shut.key).options, { label: "Ask me Friday" }],
        default: "Close it",
      });
      assert.isTrue(gone.ok, JSON.stringify(gone.value));
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        shut.key,
        { state: "done" },
      );
      // One whose task was edited since is left off too: the question was about the task as it was.
      const edited = yield* kin.task("Draft the Lumen cover note");
      yield* kin.turn("finance", kin.chatOf("finance"), "And the cover note?");
      const reworded = yield* callAs("finance", "kin_ask", {
        ...closeIt(edited.key),
        options: [...closeIt(edited.key).options, { label: "Ask me Friday" }],
      });
      assert.isTrue(reworded.ok, JSON.stringify(reworded.value));
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        edited.key,
        { title: "Send the signed Lumen proposal" },
      );
      const question = (id: unknown) => Questions.readQuestion(orgId, id as string);
      const raiseAt = Math.max(
        (yield* question(daily.value.question))!.actAt,
        (yield* question(gone.value.question))!.actAt,
        (yield* question(reworded.value.question))!.actAt,
      );
      yield* TestClock.setTime(raiseAt);
      yield* Questions.settleDue(orgId, raiseAt, kin.settleDeps);
      // The tiles' default no longer held at its day, so it waits for Rhea: raised a morning on.
      const tilesAt = (yield* question(gone.value.question))!.actAt;
      yield* TestClock.setTime(tilesAt);
      yield* Questions.settleDue(orgId, tilesAt, kin.settleDeps);
      const raised = (yield* question(daily.value.question))!;
      assert.isNotNull(raised.raiseWidgetId);
      assert.strictEqual(raised.defaultLabel, `Mark ${timed.key} done`);
      assert.deepStrictEqual(card(yield* kin.widget(raised.raiseWidgetId)).options[0], {
        optionId: "option-1",
        label: `Mark ${timed.key} done`,
        action: { line: `Mark ${timed.key} “Send the Lumen proposal” done` },
      });
      const ran = yield* kin.tap(owner, raised.raiseWidgetId, "option-1", "raised");
      assert.deepInclude(JSON.parse(ran.body), { handled: true });
      assert.deepStrictEqual(yield* kin.stateOf(timed.key), { state: "done", rev: timedRev + 1 });
      const again = yield* kin.tap(owner, raised.raiseWidgetId, "option-1", "raised-again");
      assert.strictEqual(again.messageId, ran.messageId);
      assert.strictEqual((yield* kin.stateOf(timed.key)).rev, timedRev + 1);
      const without = (yield* question(gone.value.question))!;
      assert.strictEqual(without.state, "withdrawn");
      assert.isNull(without.raiseWidgetId);
      assert.deepStrictEqual(card(yield* kin.widget(gone.value.widgetId)).outcome, {
        title: "Closed with its task",
        text: `Closed with its task: ${shut.key} is done now.`,
      });
      assert.deepStrictEqual(
        card(yield* kin.widget((yield* question(reworded.value.question))!.raiseWidgetId)).options,
        [
          { optionId: "option-1", label: "Not yet" },
          { optionId: "option-2", label: "Ask me Friday" },
        ],
      );
      const plain = JSON.stringify(
        (yield* kin.widget((yield* question(reworded.value.question))!.raiseWidgetId)).state,
      );
      assert.notInclude(plain, `Mark ${edited.key}`);
      assert.notInclude(plain, '"action"');

      // The lead that drew it retired: the owner's tap can't commit its plan.
      yield* kin.turn("chief", kin.chatOf("chief"), "Renewals?");
      const byChief = yield* callAs("chief", "kin_ask", closeIt(retired.key));
      assert.isTrue(byChief.ok, JSON.stringify(byChief.value));
      yield* sql`UPDATE kin_agents SET retired_at = ${at} WHERE agent_id = 'chief'`;
      yield* kin.tap(owner, byChief.value.widgetId, "option-1", "after-retire");
      assert.strictEqual((yield* kin.stateOf(retired.key)).state, "open");
      assert.include(
        card(yield* kin.widget(byChief.value.widgetId)).outcome?.text,
        "The agent that offered it is retired",
      );

      // Drawn for Meera as a co-owner, then she is a member again: Rhea's tap runs nothing.
      const demoted = yield* kin.task("Approve the logo");
      yield* kin.repo.addMember({
        orgId,
        chatId: kin.chatOf("finance"),
        memberId: KinMemberId.make("meera-in-finance"),
        principal: { _tag: "person", personId: KinPersonId.make("meera") },
        role: "member",
        joinedAt: at,
        leftAt: null,
        mutedUntil: null,
      });
      yield* kin.turn(
        "finance",
        kin.chatOf("finance"),
        "Close the logo task.",
        kin.person("meera"),
      );
      const forMeera = yield* callAs("finance", "kin_ask", closeIt(demoted.key));
      assert.isTrue(forMeera.ok, JSON.stringify(forMeera.value));
      yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'meera'`;
      yield* kin.tap(owner, forMeera.value.widgetId, "option-1", "after-demotion");
      assert.strictEqual((yield* kin.stateOf(demoted.key)).state, "open");
      assert.include(
        card(yield* kin.widget(forMeera.value.widgetId)).outcome?.text,
        "no longer an owner",
      );

      // Another company's key is no entry at all.
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('elsewhere', 'Other', ${at})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        SELECT 'elsewhere', register_id, name, key_prefix, built_in, created_at, definition_json
        FROM kin_registers WHERE org_id = ${orgId} AND register_id = 'work'`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('elsewhere', 'rec_far', 'work', 'W-90', 'Not ours', 'person', 'x', 'person',
          'far', 0, 0)`;
      yield* kin.turn("finance", kin.chatOf("finance"), "W-90?");
      const foreign = yield* callAs("finance", "kin_ask", closeIt("W-90"));
      assert.isFalse(foreign.ok);
      assert.match(String(foreign.value.message ?? JSON.stringify(foreign.value)), /No entry W-90/);
    }).pipe(Effect.provide(layer)),
  ),
);

// In a chat Dev reads, the card is drawn for Dev's own task. A tap by Dev once let go is refused
// and leaves it open; a later member it never awaited is refused; the owner's tap then finds Dev
// can no longer change it and runs nothing. A shared turn can't draw what only an owner may.
it.effect("in a shared chat only an awaited person who may do it runs it", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const dev = kin.person("dev");
      const chatId = kin.chatOf("finance");
      yield* kin.repo.addMember({
        orgId,
        chatId,
        memberId: KinMemberId.make("dev-in-finance"),
        principal: { _tag: "person", personId: dev.personId },
        role: "member",
        joinedAt: at,
        leftAt: null,
        mutedUntil: null,
      });
      const devs = yield* kin.task("Shortlist clinic photos", dev.personId);
      const rheas = yield* kin.task("Sign the lease");
      // In Dev's own chat Finance asks to close Dev's task, then Rhea takes it back as private:
      // taking that question's default is drawn afresh and can't name it to Dev any more.
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, 'finance', ${owner.personId}, 0)`;
      const devChat = (yield* kin.chats.createDirect(dev, {
        orgId,
        agentId: KinAgentId.make("finance"),
      })).chatId;
      const retouch = yield* kin.task("Retouch the clinic photos", dev.personId);
      yield* kin.turn("finance", devChat, "Are the photos done?", dev);
      const devQuestion = yield* callAs("finance", "kin_ask", {
        ...closeIt(retouch.key),
        default: "Close it",
      });
      assert.isTrue(devQuestion.ok, JSON.stringify(devQuestion.value));
      yield* sql`UPDATE kin_records SET owner_id = ${owner.personId}, sensitive = 1
        WHERE org_id = ${orgId} AND record_id = ${retouch.recordId}`;
      yield* kin.turn("finance", devChat, "Anything else open?", dev);
      const copied = yield* callAs("finance", "kin_ask", {
        question: "Still open from earlier.",
        options: [
          { label: "Go", action: { kind: "take_default", target: devQuestion.value.question } },
          { label: "Later" },
        ],
        default: "none",
      });
      assert.isFalse(copied.ok);
      const devCards = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
        WHERE org_id = ${orgId} AND chat_id = ${devChat}`;
      assert.strictEqual(devCards[0]!.n, 1);

      yield* kin.turn("finance", chatId, "I finished the photo shortlist.", dev);
      // Rhea's own task: Dev can't change it, so the turn acting for Dev can't offer it.
      const notDevs = yield* callAs("finance", "kin_ask", closeIt(rheas.key));
      assert.isFalse(notDevs.ok);

      const listProposal = yield* callAs("finance", "kin_ask", {
        question: "Make a Vendors list?",
        options: [
          { label: "Create it", action: { kind: "create_list", target: "proposal-x" } },
          { label: "Not now" },
        ],
        default: "none",
      });
      assert.isFalse(listProposal.ok);
      const asked = yield* callAs("finance", "kin_ask", closeIt(devs.key));
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      // Not one person's chat: a card, but no question, default or day is kept, and it says so.
      assert.strictEqual(asked.value.untaken, "group");
      assert.strictEqual(asked.value.note, NOTHING_TIMED);
      assert.isUndefined(asked.value.by);

      yield* sql`UPDATE kin_session_bindings SET revoked_at = 1 WHERE person_id = 'dev'`;
      const refused = yield* kin
        .tap(dev, asked.value.widgetId, "option-1", "dev-tap")
        .pipe(Effect.flip);
      assert.include(refused, { reason: "not_allowed" });
      const open = yield* kin.widget(asked.value.widgetId);
      assert.isNull(open.closedAt);
      assert.strictEqual((yield* kin.stateOf(devs.key)).state, "open");

      yield* kin.repo.addMember({
        orgId,
        chatId,
        memberId: KinMemberId.make("meera-in-finance"),
        principal: { _tag: "person", personId: KinPersonId.make("meera") },
        role: "member",
        joinedAt: at,
        leftAt: null,
        mutedUntil: null,
      });
      // Joined after it was asked, she isn't awaited and can't see the card at all.
      const latecomer = yield* kin
        .tap(kin.person("meera"), asked.value.widgetId, "option-1", "meera-tap")
        .pipe(Effect.flip);
      assert.include(latecomer, { reason: "not_found" });
      assert.isNull((yield* kin.widget(asked.value.widgetId)).closedAt);

      yield* kin.tap(owner, asked.value.widgetId, "option-1", "rhea-tap");
      assert.strictEqual((yield* kin.stateOf(devs.key)).state, "open");
      assert.include(
        card(yield* kin.widget(asked.value.widgetId)).outcome?.text,
        `can no longer change ${devs.key}`,
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// "Take the default" binds the question's default option by id and is drawn afresh: a task that
// changed since, a source card that is gone, or a cleared chat runs nothing. A list proposal is
// only ever created, as drawn; an extension, or an id, prefix or name taken since, creates nothing.
it.effect("take the default runs the default's own action; a list is made as proposed", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const ask = (key: string) =>
        callAs("finance", "kin_ask", { ...closeIt(key), default: "Close it" });
      const takeDefault = (question: unknown) =>
        callAs("finance", "kin_ask", {
          question: "Still open from earlier.",
          options: [
            { label: "Go with it", action: { kind: "take_default", target: question } },
            { label: "Later" },
          ],
          default: "none",
        });
      const row = yield* kin.task("File the GST return");
      yield* kin.turn("finance", chatId, "Is the return filed?");
      const question = yield* ask(row.key);
      assert.isTrue(question.ok, JSON.stringify(question.value));

      // The task it would close changed since that card was drawn: no default card for it.
      const licence = yield* kin.task("Renew the trade licence");
      const licenceAsk = yield* ask(licence.key);
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        licence.key,
        { title: "Renew the trade licence for 2027" },
      );
      yield* kin.turn("finance", chatId, "And the licence?");
      assert.isFalse((yield* takeDefault(licenceAsk.value.question)).ok);

      // The question's own card is gone by the tap: the default card runs nothing.
      const auditor = yield* kin.task("Book the auditor");
      const auditorAsk = yield* ask(auditor.key);
      yield* kin.turn("finance", chatId, "The auditor?");
      const orphan = yield* takeDefault(auditorAsk.value.question);
      assert.isTrue(orphan.ok, JSON.stringify(orphan.value));
      yield* sql`UPDATE kin_waiting SET widget_id = NULL WHERE org_id = ${orgId}
        AND widget_id = ${auditorAsk.value.widgetId as string}`;
      yield* sql`DELETE FROM kin_widgets WHERE org_id = ${orgId}
        AND widget_id = ${auditorAsk.value.widgetId as string}`;
      yield* kin.tap(owner, orphan.value.widgetId, "option-1", "orphan");
      assert.strictEqual((yield* kin.stateOf(auditor.key)).state, "open");
      assert.strictEqual(
        card(yield* kin.widget(orphan.value.widgetId)).outcome?.title,
        "Nothing was done",
      );

      // A default that only takes another question's default can't be taken in turn.
      yield* kin.turn("finance", chatId, "What else is waiting?");
      const relay = yield* callAs("finance", "kin_ask", {
        question: "Go with the GST default?",
        options: [
          {
            label: "Go with it",
            action: { kind: "take_default", target: question.value.question },
          },
          { label: "Later" },
        ],
        default: "Go with it",
      });
      assert.isTrue(relay.ok, JSON.stringify(relay.value));
      const counts = sql`SELECT (SELECT COUNT(*) FROM kin_widgets WHERE org_id = ${orgId}) AS widgets,
        (SELECT COUNT(*) FROM kin_card_plans WHERE org_id = ${orgId}) AS plans,
        (SELECT COUNT(*) FROM kin_questions WHERE org_id = ${orgId}) AS questions`;
      const before = yield* counts;
      const chained = yield* takeDefault(relay.value.question);
      assert.isFalse(chained.ok);
      assert.match(String(chained.value.message), /Offer what it runs directly: done/);
      assert.deepStrictEqual(yield* counts, before);

      yield* kin.turn("finance", chatId, "Remind me what you asked.");
      const nudge = yield* takeDefault(question.value.question);
      assert.isTrue(nudge.ok, JSON.stringify(nudge.value));
      assert.deepInclude(card(yield* kin.widget(nudge.value.widgetId)).options[0], {
        label: `Take the default: Mark ${row.key} done`,
        action: {
          line: `Go with “Mark ${row.key} done” on “${row.key} looks finished. Close it?”: Mark ${row.key} “File the GST return” done`,
        },
      });
      const went = yield* kin.tap(owner, nudge.value.widgetId, "option-1", "go");
      assert.deepInclude(JSON.parse(went.body), { handled: true });
      assert.strictEqual((yield* kin.stateOf(row.key)).state, "done");
      assert.strictEqual(
        (yield* Questions.readQuestion(orgId, question.value.question as string))?.state,
        "answered",
      );
      assert.isNotNull((yield* kin.widget(question.value.widgetId)).closedAt);

      // Clearing the chat withdraws its open question and its plans: nothing can take it later.
      const invoices = yield* kin.task("Archive the 2025 invoices");
      yield* kin.turn("finance", chatId, "Old invoices?");
      const cleared = yield* ask(invoices.key);
      yield* kin.chats.clear(owner, { chatId });
      assert.strictEqual(
        (yield* Questions.readQuestion(orgId, cleared.value.question as string))?.state,
        "withdrawn",
      );
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_card_plans WHERE org_id = ${orgId} AND chat_id = ${chatId}`,
        0,
      );
      yield* kin.turn("finance", chatId, "Anything still open?");
      assert.isFalse((yield* takeDefault(cleared.value.question)).ok);
      assert.strictEqual((yield* kin.stateOf(invoices.key)).state, "open");

      const turn = yield* kin.turn("finance", chatId, "Track vendors for me.");
      const proposal = (id: string, name: string, prefix = id.slice(0, 3).toUpperCase()) =>
        propose({
          orgId,
          agentId: "finance",
          wakeupId: turn,
          chatId,
          proposal: {
            _tag: "new",
            id,
            name,
            prefix,
            definition: presetDefinition("expenses", "INR"),
          },
          now: MON,
        });
      const offer = (proposalId: string) =>
        callAs("finance", "kin_ask", {
          question: "Make the list?",
          options: [
            { label: "Create it", action: { kind: "create_list", target: proposalId } },
            { label: "Not now" },
          ],
          default: "none",
        });
      const vendors = yield* offer(yield* proposal("vendors", "Vendors"));
      assert.isTrue(vendors.ok, JSON.stringify(vendors.value));
      assert.strictEqual(
        card(yield* kin.widget(vendors.value.widgetId)).options[0]?.label,
        "Create the list",
      );
      yield* kin.tap(owner, vendors.value.widgetId, "option-1", "vendors");
      const listOf = (id: string) => sql<{ name: string; rev: number; definition: string }>`
        SELECT name, rev, definition_json AS definition FROM kin_registers
        WHERE org_id = ${orgId} AND register_id = ${id}`;
      const made = yield* listOf("vendors");
      assert.deepStrictEqual(
        made.map((one) => one.name),
        ["Vendors"],
      );
      // The settled card says where the list lives, and opens it there.
      const settled = (widgetId: unknown) =>
        kin.widget(widgetId).pipe(Effect.map((widget) => card(widget).outcome));
      assert.deepStrictEqual(yield* settled(vendors.value.widgetId), {
        title: "List created",
        text: "Created. It's in Docs → Vendors.",
        open: { place: "docs", list: "vendors" },
      });
      const subscriptions = yield* offer(
        yield* proposal("office_subs", "Office subscriptions", "OSB"),
      );
      yield* kin.tap(owner, subscriptions.value.widgetId, "option-1", "office-subs");
      assert.deepStrictEqual(yield* settled(subscriptions.value.widgetId), {
        title: "List created",
        text: "Created. It's in Money → Subscriptions.",
        open: { place: "money", list: "office_subs", subscriptions: true },
      });
      // Kin's own lists, which no card creates, are placed as the clients show them.
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0,
          ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
      for (const [list, words] of [
        ["invoices", "Money → Invoices"],
        ["clients", "Clients"],
        ["deals", "Clients → Deals"],
      ] as const)
        assert.strictEqual((yield* listPlace(orgId, list)).words, words);

      // Only ever creates: an extension of a list isn't offered, nor a name already in use.
      const extension = yield* propose({
        orgId,
        agentId: "finance",
        wakeupId: turn,
        chatId,
        proposal: {
          _tag: "extend",
          id: "vendors",
          fields: [],
          categories: [],
          choices: {},
          stateLabels: { open: "Reviewing" },
        },
        now: MON,
      });
      assert.isFalse((yield* offer(extension)).ok);
      assert.isFalse((yield* offer(yield* proposal("vendor_book", " vendors ", "VBK"))).ok);

      const suppliers = yield* offer(yield* proposal("suppliers", "Suppliers"));
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'suppliers', 'Suppliers (mine)', 'SUX', 0, 0, '{}')`;
      yield* kin.tap(owner, suppliers.value.widgetId, "option-1", "suppliers");
      const kept = yield* sql<{ name: string; definition: string }>`SELECT name,
          definition_json AS definition FROM kin_registers
        WHERE org_id = ${orgId} AND register_id = 'suppliers'`;
      assert.deepStrictEqual(kept, [{ name: "Suppliers (mine)", definition: "{}" }]);
      assert.strictEqual(
        card(yield* kin.widget(suppliers.value.widgetId)).outcome?.title,
        "Nothing was done",
      );

      // A list named the same since the draw, under another id: nothing is created.
      const clinics = yield* offer(yield* proposal("clinics", "Clinics"));
      assert.isTrue(clinics.ok, JSON.stringify(clinics.value));
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'clinic_sites', 'CLINICS', 'CSX', 0, 0, '{}')`;
      yield* kin.tap(owner, clinics.value.widgetId, "option-1", "clinics");
      assert.lengthOf(yield* listOf("clinics"), 0);
      assert.strictEqual(
        card(yield* kin.widget(clinics.value.widgetId)).outcome?.title,
        "Nothing was done",
      );

      // Kin's own list names are taken before their lists are first used.
      assert.lengthOf(yield* listOf("clients"), 0);
      const clientBook = yield* proposal("client_book", "Clients", "CBK");
      assert.isFalse((yield* offer(clientBook)).ok);
      const patients = yield* offer(yield* proposal("patients", "Patients"));
      assert.isTrue(patients.ok, JSON.stringify(patients.value));
      const [asClients] = yield* sql<{ json: string }>`SELECT definition_json AS json
        FROM kin_list_proposals WHERE org_id = ${orgId} AND proposal_id = ${clientBook}`;
      yield* sql`UPDATE kin_card_plans SET plan_json = json_set(plan_json,
          '$.proposalId', ${clientBook}, '$.definition', ${asClients!.json})
        WHERE widget_id = ${patients.value.widgetId as string}`;
      yield* kin.tap(owner, patients.value.widgetId, "option-1", "patients");
      assert.lengthOf(yield* listOf("client_book"), 0);
      assert.include(
        card(yield* kin.widget(patients.value.widgetId)).outcome?.text,
        "There is already a list “Clients”",
      );

      // Even a sealed plan pointed at an extension changes no list at the tap.
      const contracts = yield* offer(yield* proposal("contracts", "Contracts"));
      assert.isTrue(contracts.ok, JSON.stringify(contracts.value));
      const [stored] = yield* sql<{ json: string }>`SELECT definition_json AS json
        FROM kin_list_proposals WHERE org_id = ${orgId} AND proposal_id = ${extension}`;
      yield* sql`UPDATE kin_card_plans SET plan_json = json_set(plan_json,
          '$.proposalId', ${extension}, '$.definition', ${stored!.json})
        WHERE widget_id = ${contracts.value.widgetId as string}`;
      yield* kin.tap(owner, contracts.value.widgetId, "option-1", "contracts");
      assert.deepStrictEqual(yield* listOf("vendors"), made);
      assert.lengthOf(yield* listOf("contracts"), 0);
      assert.strictEqual(
        card(yield* kin.widget(contracts.value.widgetId)).outcome?.title,
        "Nothing was done",
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// list_define's own card: an owner's or a co-owner's "Create it" makes the list in the tap, with no
// turn to wake; one ask proposing the list again keeps one proposal and one card.
it.effect("a tap on a list proposal's own card makes the list once, for an owner or co-owner", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const meera = kin.person("meera");
      const meeraChat = (yield* kin.chats.createDirect(meera, {
        orgId,
        agentId: KinAgentId.make("finance"),
      })).chatId;
      const lists = (id: string) =>
        sql<{ name: string }>`SELECT name FROM kin_registers
          WHERE org_id = ${orgId} AND register_id = ${id}`;
      const proposals = (chatId: KinChatId) =>
        sql<{ id: string; widgetId: string | null; definedAt: number | null }>`SELECT
            proposal_id AS id, widget_id AS "widgetId", defined_at AS "definedAt"
          FROM kin_list_proposals WHERE org_id = ${orgId} AND chat_id = ${chatId}
          ORDER BY proposed_at, proposal_id`;
      const define = (wakeupId: string, name: string, extra: string) =>
        callAs("finance", "list_define", {
          sourceEventId: `event:${wakeupId}`,
          name,
          noun: "item",
          prefix: name.slice(0, 3).toUpperCase(),
          fields: [
            { label: "Vendor", type: "text" },
            { label: extra, type: "text" },
          ],
          amount: true,
        });
      for (const [who, chatId, name] of [
        [meera, meeraChat, "Stationery"],
        [owner, kin.chatOf("finance"), "Office snacks"],
      ] as const) {
        const turn = yield* kin.turn("finance", chatId, `Track ${name} for me`, who);
        const first = yield* define(turn, name, "Note");
        assert.strictEqual(first.value.status, "proposed", JSON.stringify(first.value));
        // The same list proposed again in that turn, worded differently, is the first proposal.
        const again = yield* define(turn, name, "Comment");
        assert.strictEqual(again.value.proposal, first.value.proposal);
        const stored = yield* proposals(chatId);
        assert.lengthOf(stored, 1);
        const cards = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
          WHERE org_id = ${orgId} AND chat_id = ${chatId} AND type = 'choice'`;
        assert.strictEqual(cards[0]!.n, 1);
        const widgetId = stored[0]!.widgetId;
        assert.strictEqual(card(yield* kin.widget(widgetId)).options[0]?.label, "Create it");

        const id = String(first.value.list);
        if (who === owner) {
          // A teammate let into the chat after the card was drawn: their tap is refused.
          yield* kin.repo.addMember({
            orgId,
            chatId,
            memberId: KinMemberId.make("dev-in-finance"),
            principal: { _tag: "person", personId: KinPersonId.make("dev") },
            role: "member",
            joinedAt: at,
            leftAt: null,
            mutedUntil: null,
          });
          const refused = yield* kin
            .tap(kin.person("dev"), widgetId, "option-1", "dev-tap")
            .pipe(Effect.flip);
          assert.include(refused, { reason: "not_found" });
          assert.lengthOf(yield* lists(id), 0);
        }
        yield* kin.tap(who, widgetId, "option-1", `${name}-tap`);
        assert.deepStrictEqual(yield* lists(id), [{ name }]);
        assert.strictEqual(card(yield* kin.widget(widgetId)).outcome?.title, "List created");
        assert.isNotNull((yield* proposals(chatId))[0]!.definedAt);
        // A second tap, from another session, changes nothing.
        yield* kin.tap(who, widgetId, "option-1", `${name}-tap-again`);
        assert.deepStrictEqual(yield* lists(id), [{ name }]);
      }
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a tap on a team list proposal opens it at Confirm, for an owner or co-owner", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const meera = kin.person("meera");
      const meeraChat = (yield* kin.chats.createDirect(meera, {
        orgId,
        agentId: KinAgentId.make("finance"),
      })).chatId;
      const lists = (id: string) =>
        sql<{ name: string; team: number | null; teamSince: number | null }>`SELECT name,
          json_extract(definition_json, '$.team') AS team,
          json_extract(definition_json, '$.teamSince') AS "teamSince" FROM kin_registers
          WHERE org_id = ${orgId} AND register_id = ${id}`;
      const proposals = (chatId: KinChatId) =>
        sql<{ id: string; widgetId: string | null; definedAt: number | null }>`SELECT
            proposal_id AS id, widget_id AS "widgetId", defined_at AS "definedAt"
          FROM kin_list_proposals WHERE org_id = ${orgId} AND chat_id = ${chatId}
          ORDER BY proposed_at, proposal_id`;
      const define = (wakeupId: string, name: string, extra: string) =>
        callAs("finance", "list_define", {
          sourceEventId: `event:${wakeupId}`,
          name,
          noun: "item",
          prefix: name.slice(0, 3).toUpperCase(),
          fields: [
            { label: "Vendor", type: "text" },
            { label: extra, type: "text" },
          ],
          team: true,
        });
      for (const [who, chatId, name] of [
        [meera, meeraChat, "Stationery"],
        [owner, kin.chatOf("finance"), "Office snacks"],
      ] as const) {
        const turn = yield* kin.turn("finance", chatId, `Track ${name} for me`, who);
        const first = yield* define(turn, name, "Note");
        assert.strictEqual(first.value.status, "proposed", JSON.stringify(first.value));
        // The same list proposed again in that turn, worded differently, is the first proposal.
        const again = yield* define(turn, name, "Comment");
        assert.strictEqual(again.value.proposal, first.value.proposal);
        const stored = yield* proposals(chatId);
        assert.lengthOf(stored, 1);
        const cards = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
          WHERE org_id = ${orgId} AND chat_id = ${chatId} AND type = 'choice'`;
        assert.strictEqual(cards[0]!.n, 1);
        const widgetId = stored[0]!.widgetId;
        const shown = card(yield* kin.widget(widgetId));
        assert.strictEqual(shown.options[0]?.label, "Create it");
        assert.include(shown.detail?.split("\n") ?? [], "The whole team will see and add entries.");

        const id = String(first.value.list);
        if (who === owner) {
          // A teammate let into the chat after the card was drawn: their tap is refused.
          yield* kin.repo.addMember({
            orgId,
            chatId,
            memberId: KinMemberId.make("dev-in-finance"),
            principal: { _tag: "person", personId: KinPersonId.make("dev") },
            role: "member",
            joinedAt: at,
            leftAt: null,
            mutedUntil: null,
          });
          const refused = yield* kin
            .tap(kin.person("dev"), widgetId, "option-1", "dev-tap")
            .pipe(Effect.flip);
          assert.include(refused, { reason: "not_found" });
          assert.lengthOf(yield* lists(id), 0);
        }
        yield* TestClock.adjust("1 millis");
        const confirmedAt = yield* Clock.currentTimeMillis;
        yield* kin.tap(who, widgetId, "option-1", `${name}-tap`);
        assert.deepStrictEqual(yield* lists(id), [{ name, team: 1, teamSince: confirmedAt }]);
        assert.strictEqual(card(yield* kin.widget(widgetId)).outcome?.title, "List created");
        assert.isNotNull((yield* proposals(chatId))[0]!.definedAt);
        // A second tap, from another session, changes nothing.
        yield* kin.tap(who, widgetId, "option-1", `${name}-tap-again`);
        assert.deepStrictEqual(yield* lists(id), [{ name, team: 1, teamSince: confirmedAt }]);
      }
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("a list change card says when it closes a team list", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const closedLine = "The team will no longer see this list.";
      for (const name of ["Bookings", "Supplies", "Stock"]) {
        const team = name === "Bookings";
        yield* defineList(orgId, yield* proposalFor(orgId, { name, team }), MON);
      }
      for (const [list, team, detail, staysOpen] of [
        ["bookings", undefined, ["Note (text)"], true],
        ["supplies", false, ["Note (text)"], false],
        ["bookings", false, ["Extra (text)", closedLine], false],
        ["stock", false, ["Note (text)"], true],
      ] as const) {
        const label = list === "bookings" && team === false ? "Extra" : "Note";
        const asked = yield* kin.turn("finance", chatId, `Add ${label} to ${list}`);
        const proposed = yield* callAs("finance", "list_define", {
          sourceEventId: `event:${asked}`,
          list,
          fields: [{ label, type: "text" }],
          ...(team === undefined ? {} : { team }),
        });
        assert.strictEqual(proposed.value.status, "proposed", JSON.stringify(proposed.value));
        const [row] = yield* sql<{
          widgetId: string;
        }>`SELECT widget_id AS "widgetId" FROM kin_list_proposals
          WHERE org_id = ${orgId} AND proposal_id = ${String(proposed.value.proposal)}`;
        assert.deepStrictEqual(card(yield* kin.widget(row!.widgetId)).detail?.split("\n"), [
          ...detail,
        ]);
        if (list === "stock")
          yield* defineList(orgId, yield* proposalFor(orgId, { list, team: true }), MON);
        const yes = yield* kin.turn("finance", chatId, `Yes to ${label} on ${list}`);
        const applied = yield* callAs("finance", "list_define", {
          sourceEventId: `event:${yes}`,
          proposal: proposed.value.proposal,
        });
        assert.strictEqual(applied.value.status, "defined", JSON.stringify(applied.value));
        const def = yield* listDef(orgId, list);
        assert.strictEqual(def?.team === true, staysOpen);
        assert.include(def?.fields.map((field) => field.label) ?? [], label);
      }
    }).pipe(Effect.provide(layer)),
  ),
);

// A start that fails after its run was marked rolls the whole tap back: no started run, no event,
// no receipt, the card and its question still open, and the tapper is told plainly. While Kin's
// deferred work is stopped, no card can offer a start at all.
it.effect("a tap that fails after its write leaves nothing behind", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("chief");
      const itemId = "deferral-lumen";
      const due = MON - 60_000;
      yield* kin.turn("chief", chatId, "Start the Lumen follow-up?");
      const stopped = yield* callAs("chief", "kin_ask", {
        question: "Start the Lumen follow-up now?",
        options: [{ label: "Start", action: { kind: "start", target: itemId } }, { label: "Wait" }],
        default: "none",
      });
      assert.isFalse(stopped.ok);
      assert.match(String(stopped.value.message ?? JSON.stringify(stopped.value)), /stopped/);

      yield* sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due,
          snapshot_json, updated_at)
        VALUES (${orgId}, ${itemId}, 'heads_up', ${due}, 'start', '{}', ${MON})`;
      const cards = yield* makeDeferralCards.pipe(
        Effect.provideService(KinChatRepository, kin.repo),
      );
      yield* cards.write({
        orgId,
        itemId: KinMemoryItemId.make(itemId),
        state: {
          itemId: KinMemoryItemId.make(itemId),
          title: "Follow up on the Lumen invoice",
          dueAt: DateTime.formatIso(DateTime.makeUnsafe(due)),
          onDue: "start",
          text: "Due now.",
          phase: "heads_up",
        },
        chatId,
        now: MON,
      });
      // The card is drawn with a task action, then its sealed plan is made a start: drawing a
      // start needs memory, which this harness doesn't have.
      const row = yield* kin.task("Placeholder for the start card");
      const asked = yield* callAs("chief", "kin_ask", closeIt(row.key));
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      const widgetId = asked.value.widgetId as string;
      const [sealed] = yield* sql<{ json: string }>`SELECT plan_json AS json FROM kin_card_plans
        WHERE org_id = ${orgId} AND widget_id = ${widgetId} AND option_id = 'option-1'`;
      const start = {
        kind: "start",
        itemId,
        dueAt: due,
        title: "Follow up on the Lumen invoice",
        chat: null,
        sourceEvent: null,
        draw: JSON.parse(sealed!.json).draw,
      };
      yield* sql`UPDATE kin_card_plans SET plan_json = ${JSON.stringify(start)}
        WHERE org_id = ${orgId} AND widget_id = ${widgetId} AND option_id = 'option-1'`;

      // Another lead already holds this start's event: the queue refuses after the run moved.
      const dedupeKey = `${deferralTriggerId(itemId, "due")}:${due}`;
      const queue = Context.get(kin.services, KinEventQueue.KinEventQueue);
      yield* queue.enqueue(
        yield* decodeEvent({
          _tag: "deferral.due",
          eventId: "deferral_elsewhere",
          orgId,
          agentId: "finance",
          receivedAt: DateTime.formatIso(DateTime.makeUnsafe(MON)),
          provenance: { _tag: "system" },
          dedupeKey,
          subject: { type: "deferral", itemId, phase: "due" },
          lateByMs: 0,
        }),
      );
      const durable = Effect.gen(function* () {
        const run = yield* sql`SELECT state FROM kin_deferral_runs
          WHERE org_id = ${orgId} AND item_id = ${itemId}`;
        const events = yield* sql`SELECT event_id, agent_id FROM kin_events
          WHERE org_id = ${orgId} AND dedupe_key = ${dedupeKey} ORDER BY event_id`;
        const plans = yield* sql`SELECT option_id, ran_message_id FROM kin_card_plans
          WHERE org_id = ${orgId} AND widget_id = ${widgetId} ORDER BY option_id`;
        const widgets = yield* sql`SELECT widget_id, revision, state_json, closed_at
          FROM kin_widgets WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY widget_id`;
        const questions = yield* sql`SELECT question_id, state, closed_at FROM kin_questions
          WHERE org_id = ${orgId} ORDER BY question_id`;
        const messages = yield* sql`SELECT message_id FROM kin_messages
          WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY seq`;
        return { run, events, plans, widgets, questions, messages };
      });
      const before = yield* durable;
      const startsOn = Effect.provideService(KinDeferralStopSwitch, {
        isStopped: () => Effect.succeed(false),
      });
      const failed = yield* kin
        .tap(owner, widgetId, "option-1", "start")
        .pipe(startsOn, Effect.flip);
      assert.include(failed, { _tag: "KinChatError" });
      assert.notInclude(failed.message, "Nothing was done");
      assert.deepStrictEqual(yield* durable, before);

      // With the other event gone the same card starts it, once.
      yield* sql`DELETE FROM kin_events WHERE org_id = ${orgId} AND event_id = 'deferral_elsewhere'`;
      const tapped = yield* kin.tap(owner, widgetId, "option-1", "start-again").pipe(startsOn);
      assert.deepInclude(JSON.parse(tapped.body), { handled: true });
      assert.deepStrictEqual(
        yield* sql`SELECT state FROM kin_deferral_runs WHERE org_id = ${orgId} AND item_id = ${itemId}`,
        [{ state: "started" }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id FROM kin_events WHERE org_id = ${orgId}
          AND dedupe_key = ${dedupeKey}`,
        [{ agent_id: "chief" }],
      );
      assert.strictEqual(card(yield* kin.widget(widgetId)).outcome?.title, "Started");
    }).pipe(Effect.provide(layer)),
  ),
);

// A task closed by a tap or by an agent closes the questions and cards about it, in the move's
// own transaction; a card with a live action elsewhere keeps it; reopening brings nothing back.
it.effect("closing a task closes what hangs off it, and reopening brings none back", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const form = yield* kin.task("Send the W-8 form");
      const other = yield* kin.task("File the October return");
      yield* kin.turn("finance", chatId, "Where is the form?");
      const asked = yield* callAs("finance", "kin_ask", {
        question: "Did the bank get the form?",
        options: [{ label: "Yes" }, { label: "Not yet" }],
        default: "none",
        about: [form.key],
      });
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      const closer = yield* callAs("finance", "kin_ask", closeIt(form.key));
      const mixed = yield* callAs("finance", "kin_ask", {
        question: "Which first?",
        options: [
          { label: "Close the form", action: { kind: "done", target: form.key } },
          { label: "Close the return", action: { kind: "done", target: other.key } },
        ],
        default: "none",
      });
      assert.isTrue(mixed.ok, JSON.stringify(mixed.value));
      const waitingOn = Effect.fn("test.waitingOn")(function* (widgetId: unknown) {
        const read = yield* KinOpen.compute({
          orgId,
          viewer: { personId: owner.personId, ownerLevel: true },
          at: MON,
        });
        return read.rows.some(
          (row) => row.item._tag === "waiting" && row.item.waiting.widgetId === widgetId,
        );
      });
      assert.isTrue(yield* waitingOn(asked.value.widgetId));

      // The owner's tap on one card closes the task: that card says what it did, the rest close.
      yield* kin.tap(owner, closer.value.widgetId, "option-1", "close-form");
      assert.strictEqual((yield* kin.stateOf(form.key)).state, "done");
      assert.deepStrictEqual(card(yield* kin.widget(closer.value.widgetId)).outcome, {
        title: "Done",
        text: `Marked ${form.key} “Send the W-8 form” done.`,
      });
      const about = yield* kin.widget(asked.value.widgetId);
      assert.isNotNull(about.closedAt);
      assert.deepStrictEqual(card(about).outcome, {
        title: "Closed with its task",
        text: `Closed with its task: ${form.key} is done now.`,
      });
      const states = (id: unknown) =>
        Questions.readQuestion(orgId, id as string).pipe(Effect.map((row) => row?.state));
      assert.strictEqual(yield* states(asked.value.question), "withdrawn");
      assert.strictEqual(yield* states(closer.value.question), "answered");
      assert.isFalse(yield* waitingOn(asked.value.widgetId));
      // The card with another live action keeps it; its dead one says what changed.
      assert.isNull((yield* kin.widget(mixed.value.widgetId)).closedAt);
      assert.strictEqual(yield* states(mixed.value.question), "open");

      // An agent can't close a task its open card is about: it waits on that card's person.
      // Closed by hand, the card closes with it, and a tap on it afterwards runs nothing.
      const signage = yield* kin.task("Order the signage");
      yield* kin.turn("finance", chatId, "And the signage?");
      const later = yield* callAs("finance", "kin_ask", {
        ...closeIt(signage.key),
        about: [signage.key],
      });
      const done = yield* callAs("finance", "record_update", { key: signage.key, state: "done" });
      assert.isTrue(done.ok, JSON.stringify(done.value));
      assert.include(done.value, { state: "waiting" });
      assert.property(done.value, "waitsOnCard");
      assert.deepInclude(yield* kin.records.get(orgId, signage.key), {
        waitingOnKind: "person",
        waitingOnId: owner.personId,
      });
      assert.strictEqual(yield* states(later.value.question), "open");
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        signage.key,
        { state: "done" },
      );
      const shut = yield* kin.widget(later.value.widgetId);
      assert.deepStrictEqual(card(shut).outcome, {
        title: "Closed with its task",
        text: `Closed with its task: ${signage.key} is done now.`,
      });
      assert.strictEqual(yield* states(later.value.question), "withdrawn");
      assert.isFalse(yield* waitingOn(later.value.widgetId));
      const closedRev = (yield* kin.stateOf(signage.key)).rev;
      const refused = yield* kin.chats
        .act(owner, {
          widgetId: shut.widgetId,
          revision: shut.revision,
          actionId: "choose",
          value: "option-1",
          clientActionId: "late-tap",
        })
        .pipe(Effect.flip);
      assert.include(refused, { _tag: "KinChatError" });
      assert.deepStrictEqual(yield* kin.stateOf(signage.key), { state: "done", rev: closedRev });

      // Closed first and asked about after, in the same turn: it was not done, so it waits again.
      const tally = yield* kin.task("Tally the reimbursements");
      yield* kin.turn("finance", chatId, "And the reimbursements?");
      yield* callAs("finance", "record_update", { key: tally.key, state: "done" });
      const which = yield* callAs("finance", "kin_ask", {
        question: "Which way for the reimbursements?",
        options: [{ label: "Tag them in the app" }, { label: "Leave it" }],
        default: "none",
        about: [tally.key],
      });
      assert.isTrue(which.ok, JSON.stringify(which.value));
      assert.deepInclude(yield* kin.records.get(orgId, tally.key), {
        state: "waiting",
        waitingOnId: owner.personId,
      });

      // Reopened: nothing comes back, and nothing fails.
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        signage.key,
        { state: "open" },
      );
      assert.strictEqual((yield* kin.stateOf(signage.key)).state, "open");
      assert.deepStrictEqual(card(yield* kin.widget(later.value.widgetId)).outcome, {
        title: "Closed with its task",
        text: `Closed with its task: ${signage.key} is done now.`,
      });
      assert.strictEqual(yield* states(later.value.question), "withdrawn");

      // A move whose transaction fails takes its cascade back with it.
      yield* kin.turn("finance", chatId, "And the return?");
      const kept = yield* callAs("finance", "kin_ask", {
        question: "Is the return filed?",
        options: [{ label: "Yes" }, { label: "No" }],
        default: "none",
        about: [other.key],
      });
      const rolled = yield* sql
        .withTransaction(
          Effect.andThen(
            kin.records.update(
              orgId,
              { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
              other.key,
              { state: "dropped" },
            ),
            Effect.fail("after the move" as const),
          ),
        )
        .pipe(Effect.flip);
      assert.strictEqual(rolled, "after the move");
      assert.strictEqual((yield* kin.stateOf(other.key)).state, "open");
      assert.isNull((yield* kin.widget(kept.value.widgetId)).closedAt);
      assert.isNull((yield* kin.widget(mixed.value.widgetId)).closedAt);
      assert.strictEqual(yield* states(kept.value.question), "open");
      assert.isTrue(yield* waitingOn(kept.value.widgetId));
    }).pipe(Effect.provide(layer)),
  ),
);

// Nobody answers a question whose default closes a task: at its day Kin closes it as Finance,
// History names the default, and Rhea is told once (held while she is away) on a card whose Undo
// puts the task back once. Undo over a later change puts nothing back; Dev, neither asked nor
// able to change the task, can't undo it.
it.effect("a default that closes a task is taken at its day, told once, and undone once", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const settle = Effect.fn("test.settle")(function* (at: number) {
        yield* TestClock.setTime(at);
        return yield* Questions.settleDue(orgId, at, kin.settleDeps);
      });
      const notices = (questionId: unknown) =>
        sql<{ messageId: string; widgetId: string | null; body: string }>`SELECT
            m.message_id AS "messageId", m.widget_id AS "widgetId", m.body
          FROM kin_pulse_told t JOIN kin_messages m ON m.org_id = t.org_id
            AND m.message_id = t.event_id
          WHERE t.org_id = ${orgId} AND t.fact_key = ${`default_taken:${questionId as string}`}`;
      const row = yield* kin.task("Review the Apex deck");
      yield* kin.turn("finance", chatId, "Is the Apex deck reviewed?");
      const asked = yield* callAs("finance", "kin_ask", {
        ...closeIt(row.key),
        default: "Close it",
      });
      assert.isTrue(asked.ok, JSON.stringify(asked.value));
      const due = Date.parse(asked.value.by as string);

      // Away until the day after: the default is taken at its day, the news waits for her.
      const back = DateTime.formatIsoDate(DateTime.makeUnsafe(due + 86_400_000));
      yield* sql`UPDATE kin_people SET away_until = ${back} WHERE person_id = ${owner.personId}`;
      assert.strictEqual(yield* settle(due), 1);
      assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "done", rev: row.rev + 1 });
      const [change] = yield* sql<{ actor: string; via: string; fields: string }>`SELECT
          actor_kind || ':' || actor_id AS actor, via, fields_json AS fields
        FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${row.recordId}
        ORDER BY seq DESC LIMIT 1`;
      assert.deepStrictEqual(
        { ...change!, fields: JSON.parse(change!.fields) },
        {
          actor: "agent:finance",
          via: "lead",
          fields: [
            { field: "state", from: "open", to: "done" },
            { field: KIN_TAKEN_DEFAULT_FIELD, from: null, to: asked.value.question },
          ],
        },
      );
      // The server did it: no turn is started to take it.
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND dedupe_key LIKE 'question:%'`,
        0,
      );
      assert.deepStrictEqual(
        card(yield* kin.widget(asked.value.widgetId)).outcome?.title,
        `Went with “Mark ${row.key} done”`,
      );
      assert.lengthOf(yield* notices(asked.value.question), 0);

      // Back: one card, from Finance, and a second pass posts nothing more, in her chat itself.
      const posted = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatId}`.pipe(Effect.map((rows) => rows[0]!.n));
      const away = yield* posted;
      const home = Date.parse(`${back}T12:00:00.000Z`);
      yield* settle(home);
      yield* settle(home + 60_000);
      assert.strictEqual(yield* posted, away + 1);
      const told = yield* notices(asked.value.question);
      assert.lengthOf(told, 1);
      const note = yield* kin.widget(told[0]!.widgetId);
      assert.strictEqual(note.chatId, chatId);
      assert.deepStrictEqual(card(note).options, [
        {
          optionId: "option-1",
          label: "Undo",
          action: { line: `Put ${row.key} “Review the Apex deck” back as it was` },
        },
        { optionId: "option-2", label: "Keep it" },
      ]);
      assert.strictEqual(
        (note.state as { question: string }).question,
        `Nobody answered, so I went with “Mark ${row.key} done” for ${row.key} Review the Apex deck.`,
      );

      // Undo, once: the task is open again as Rhea's change, and no turn is woken by the tap.
      const undo = yield* kin.tap(owner, note.widgetId, "option-1", "undo-1");
      assert.deepInclude(JSON.parse(undo.body), { handled: true });
      assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "open", rev: row.rev + 2 });
      assert.deepStrictEqual(card(yield* kin.widget(note.widgetId)).outcome, {
        title: "Undone",
        text: `Put ${row.key} “Review the Apex deck” back as it was.`,
        undone: {
          personId: owner.personId,
          name: "Rhea Rao",
          at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        },
      });
      const [undone] = yield* sql<{ actor: string; fields: string }>`SELECT
          actor_kind || ':' || actor_id AS actor, fields_json AS fields
        FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${row.recordId}
        ORDER BY seq DESC LIMIT 1`;
      assert.deepStrictEqual(
        { ...undone!, fields: JSON.parse(undone!.fields) },
        {
          actor: `person:${owner.personId}`,
          fields: [{ field: "state", from: "done", to: "open" }],
        },
      );
      const again = yield* kin.tap(owner, note.widgetId, "option-1", "undo-2");
      assert.strictEqual(again.messageId, undo.messageId);
      assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "open", rev: row.rev + 2 });
      // Finance hears once that its default was undone.
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id AS agent, json_extract(json, '$.subject.undone') AS undone
          FROM kin_events WHERE org_id = ${orgId}
            AND dedupe_key = ${`question-undone:${asked.value.question as string}`}`,
        [{ agent: "finance", undone: 1 }],
      );

      // Changed since the default closed it: Undo puts nothing back over the rename.
      yield* sql`UPDATE kin_people SET away_until = NULL WHERE person_id = ${owner.personId}`;
      const renamed = yield* kin.task("Print the Apex handouts");
      yield* kin.turn("finance", chatId, "And the handouts?");
      const second = yield* callAs("finance", "kin_ask", {
        ...closeIt(renamed.key),
        default: "Close it",
      });
      assert.isTrue(second.ok, JSON.stringify(second.value));
      yield* settle(Date.parse(second.value.by as string));
      const [secondNote] = yield* notices(second.value.question);
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        renamed.key,
        { title: "Print the Apex handouts, both sizes" },
      );
      yield* kin.tap(owner, secondNote!.widgetId, "option-1", "undo-late");
      assert.deepStrictEqual(card(yield* kin.widget(secondNote!.widgetId)).outcome, {
        title: "Nothing was undone",
        text: `${renamed.key} changed since, so nothing was undone.`,
      });
      assert.strictEqual((yield* kin.stateOf(renamed.key)).state, "done");

      // Dev wasn't asked and can't change Rhea's task: the server refuses his Undo.
      const third = yield* kin.task("Book the Apex venue");
      yield* kin.turn("finance", chatId, "And the venue?");
      const venue = yield* callAs("finance", "kin_ask", {
        ...closeIt(third.key),
        default: "Close it",
      });
      yield* settle(Date.parse(venue.value.by as string));
      const [venueNote] = yield* notices(venue.value.question);
      const plan = (yield* plansOf(orgId, venueNote!.widgetId!)).get("option-1")!;
      const refused = yield* CardActions.run(
        {
          orgId,
          widget: yield* kin.widget(venueNote!.widgetId),
          personId: KinPersonId.make("dev"),
          memberId: KinMemberId.make("dev-member"),
          now: Date.parse(venue.value.by as string),
        },
        plan,
        { records: kin.records, chat: kin.chats },
      ).pipe(Effect.flip);
      assert.include(refused, { reason: "not_allowed" });
      assert.strictEqual((yield* kin.stateOf(third.key)).state, "done");
    }).pipe(Effect.provide(layer)),
  ),
);

/** Finance asks `who` (Rhea by default) in `chatId` to close `row`, closing it being the default. */
const askToClose = Effect.fn("test.askToClose")(function* (
  kin: Effect.Success<typeof ambermill>,
  row: { readonly key: string },
  chatId: KinChatId,
  who?: { readonly _tag: "person"; readonly personId: KinPersonId },
) {
  yield* kin.turn("finance", chatId, `Is ${row.key} finished?`, who);
  const asked = yield* callAs("finance", "kin_ask", { ...closeIt(row.key), default: "Close it" });
  assert.isTrue(asked.ok, JSON.stringify(asked.value));
  return {
    question: asked.value.question as string,
    widgetId: asked.value.widgetId as string,
    due: Date.parse(asked.value.by as string),
    untaken: asked.value.untaken,
    note: asked.value.note,
  };
});
const settleAt = Effect.fn("test.settleAt")(function* (
  kin: Effect.Success<typeof ambermill>,
  at: number,
) {
  yield* TestClock.setTime(at);
  return yield* Questions.settleDue(kin.orgId, at, kin.settleDeps);
});
/** The note Kin posted that a question's default was taken, through the told ledger. */
const noticesOf = (kin: Effect.Success<typeof ambermill>, questionId: string) =>
  kin.sql<{ messageId: string; widgetId: string; body: string }>`SELECT
      m.message_id AS "messageId", m.widget_id AS "widgetId", m.body
    FROM kin_pulse_told t JOIN kin_messages m ON m.org_id = t.org_id
      AND m.message_id = t.event_id
    WHERE t.org_id = ${kin.orgId} AND t.fact_key = ${`default_taken:${questionId}`}`;

// Paused, Kin takes no default. Finance's "close it" comes due while the company is paused, and
// another while only Finance is: each task, question and card stays as it was and nobody is
// told. The first pass after each resume takes it.
it.effect("a default due while Kin or its asker is paused is taken on resume", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const messages = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatId}`.pipe(Effect.map((rows) => rows[0]!.n));
      const stillAsked = Effect.fn("test.stillAsked")(function* (
        row: { readonly key: string; readonly rev: number },
        asked: { readonly question: string; readonly widgetId: string },
        posted: number,
      ) {
        assert.deepStrictEqual(yield* kin.stateOf(row.key), { state: "open", rev: row.rev });
        assert.deepInclude((yield* Questions.readQuestion(orgId, asked.question))!, {
          state: "open",
          safe: true,
        });
        const shown = yield* kin.widget(asked.widgetId);
        assert.isNull(shown.closedAt);
        assert.isUndefined(card(shown).outcome);
        assert.strictEqual(yield* messages, posted);
        assert.lengthOf(yield* noticesOf(kin, asked.question), 0);
      });

      const deck = yield* kin.task("Review the Apex deck");
      const first = yield* askToClose(kin, deck, chatId);
      yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by, reason)
        VALUES (${orgId}, 1, ${first.due}, ${owner.personId}, 'Invented pause')
        ON CONFLICT (org_id) DO UPDATE SET paused = 1, paused_at = ${first.due},
          paused_by = ${owner.personId}, reason = 'Invented pause'`;
      const posted = yield* messages;
      assert.strictEqual(yield* settleAt(kin, first.due), 0);
      yield* stillAsked(deck, first, posted);
      yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL,
          reason = NULL
        WHERE org_id = ${orgId}`;
      assert.strictEqual(yield* settleAt(kin, first.due + 60_000), 1);
      assert.strictEqual((yield* kin.stateOf(deck.key)).state, "done");

      const handouts = yield* kin.task("Print the Apex handouts");
      const second = yield* askToClose(kin, handouts, chatId);
      yield* sql`UPDATE kin_agents SET paused_at = ${at}
        WHERE org_id = ${orgId} AND agent_id = 'finance'`;
      const later = yield* messages;
      assert.strictEqual(yield* settleAt(kin, second.due), 0);
      yield* stillAsked(handouts, second, later);
      yield* sql`UPDATE kin_agents SET paused_at = NULL
        WHERE org_id = ${orgId} AND agent_id = 'finance'`;
      assert.strictEqual(yield* settleAt(kin, second.due + 60_000), 1);
      assert.strictEqual((yield* kin.stateOf(handouts.key)).state, "done");
    }).pipe(Effect.provide(layer)),
  ),
);

// A default is judged by what its sealed plan does: marking a task done moves no money, so an
// amount in the question doesn't hold it. The same words with no plan still wait for Rhea.
it.effect("a default whose plan closes a task is taken at its day, whatever its words say", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const chatId = kin.chatOf("finance");
      const ask = Effect.fn("test.askAboutFee")(function* (
        title: string,
        action: (key: string) => { readonly kind: "done"; readonly target: string } | undefined,
      ) {
        const row = yield* kin.task(title);
        yield* kin.turn("finance", chatId, `Is ${row.key} finished?`);
        const act = action(row.key);
        const asked = yield* callAs("finance", "kin_ask", {
          question: `${row.key} ${title} at €40 a month: is it done, or keep it open?`,
          options: [
            act === undefined ? { label: "It's done" } : { label: "It's done", action: act },
            { label: "Keep it open" },
          ],
          default: "It's done",
        });
        assert.isTrue(asked.ok, JSON.stringify(asked.value));
        return { row, untaken: asked.value.untaken, due: Date.parse(asked.value.by as string) };
      });
      const done = yield* ask("Renew the hosting plan", (target) => ({ kind: "done", target }));
      const words = yield* ask("Renew the domain", () => undefined);
      assert.deepStrictEqual([done.untaken, words.untaken], [undefined, "money"]);
      yield* settleAt(kin, done.due + 60_000);
      assert.strictEqual((yield* kin.stateOf(done.row.key)).state, "done");
      assert.strictEqual((yield* kin.stateOf(words.row.key)).state, "open");
    }).pipe(Effect.provide(layer)),
  ),
);

// Finance only helps on Rhea's task, so its own default can't close it: at its day nothing
// closes and nothing is retried; Rhea is asked once, at the raise time, as for any default.
it.effect("a default that would close a task its asker only helps on asks the person instead", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { orgId, sql } = kin;
      const deck = yield* kin.task("Review the Apex deck");
      yield* sql`UPDATE kin_records SET fields_json = json_object('alsoOn', json('["agent:finance"]'))
        WHERE org_id = ${orgId} AND record_id = ${deck.recordId}`;
      const asked = yield* askToClose(kin, deck, kin.chatOf("finance"));
      assert.strictEqual(yield* settleAt(kin, asked.due), 1);
      assert.deepStrictEqual(yield* kin.stateOf(deck.key), { state: "open", rev: deck.rev });
      const back = (yield* Questions.readQuestion(orgId, asked.question))!;
      assert.deepInclude(back, { state: "open", safe: false, raiseWidgetId: null });
      assert.strictEqual(yield* settleAt(kin, back.actAt), 1);
      assert.strictEqual(yield* settleAt(kin, back.actAt + 3 * 86_400_000), 0);
      const raised = (yield* Questions.readQuestion(orgId, asked.question))!;
      assert.strictEqual(raised.state, "open");
      assert.isNotNull(raised.raiseWidgetId);
      assert.strictEqual((yield* kin.stateOf(deck.key)).state, "open");
      assert.lengthOf(yield* noticesOf(kin, asked.question), 0);
    }).pipe(Effect.provide(layer)),
  ),
);

// Dev's defaults close two of his tasks while he's away. Before he's back Rhea takes one as her
// own, private, and renames it: his note on it names neither, only his question and its choice.
// The one he still sees is named as ever. Both keep Undo.
it.effect("a taken default's note names a task only to someone who sees it now", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const dev = kin.person("dev");
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, 'finance', ${owner.personId}, 0)`;
      const devChat = (yield* kin.chats.createDirect(dev, {
        orgId,
        agentId: KinAgentId.make("finance"),
      })).chatId;
      const retouch = yield* kin.task("Retouch the clinic photos", dev.personId);
      const shortlist = yield* kin.task("Shortlist clinic photos", dev.personId);
      const hidden = yield* askToClose(kin, retouch, devChat, dev);
      const shown = yield* askToClose(kin, shortlist, devChat, dev);
      const due = Math.max(hidden.due, shown.due);
      const back = DateTime.formatIsoDate(DateTime.makeUnsafe(due + 86_400_000));
      yield* sql`UPDATE kin_people SET away_until = ${back} WHERE person_id = 'dev'`;
      assert.strictEqual(yield* settleAt(kin, due), 2);
      assert.strictEqual((yield* kin.stateOf(retouch.key)).state, "done");
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        retouch.key,
        { title: "Settle the clinic dispute", sensitive: true },
      );
      yield* sql`UPDATE kin_records SET owner_id = ${owner.personId}
        WHERE org_id = ${orgId} AND record_id = ${retouch.recordId}`;

      yield* settleAt(kin, Date.parse(`${back}T12:00:00.000Z`));
      const [hiddenNote] = yield* noticesOf(kin, hidden.question);
      const hiddenCard = yield* kin.widget(hiddenNote!.widgetId);
      assert.strictEqual(
        (hiddenCard.state as { question: string }).question,
        `Nobody answered, so I went with “Mark ${retouch.key} done” on “${retouch.key} looks finished. Close it?”.`,
      );
      assert.deepStrictEqual(card(hiddenCard).options, [
        {
          optionId: "option-1",
          label: "Undo",
          action: { line: `Put back what “Mark ${retouch.key} done” changed` },
        },
        { optionId: "option-2", label: "Keep it" },
      ]);
      const said = JSON.stringify([hiddenNote!.body, hiddenCard.state]);
      assert.notInclude(said, "Settle the clinic dispute");
      assert.notInclude(said, "Retouch");

      const [shownNote] = yield* noticesOf(kin, shown.question);
      const shownCard = yield* kin.widget(shownNote!.widgetId);
      assert.strictEqual(
        (shownCard.state as { question: string }).question,
        `Nobody answered, so I went with “Mark ${shortlist.key} done” for ${shortlist.key} Shortlist clinic photos.`,
      );
      assert.deepStrictEqual(card(shownCard).options[0], {
        optionId: "option-1",
        label: "Undo",
        action: { line: `Put ${shortlist.key} “Shortlist clinic photos” back as it was` },
      });
    }).pipe(Effect.provide(layer)),
  ),
);

// Kin takes a default only when Undo could put back all of it, and only on the task as offered:
// a repeating task (closing makes its next), a handed-back one (closing clears that), and one
// renamed since it was asked about are left as they are, and each waits for Rhea, raised on her
// next morning.
it.effect("a default Kin couldn't undo, or on a task changed since, waits for its person", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const finance = { _tag: "agent" as const, agentId: KinAgentId.make("finance") };
      const byRhea = {
        actor: { _tag: "person" as const, personId: owner.personId },
        via: "owner" as const,
        askedBy: owner.personId,
      };
      const rent = yield* kin.task("Pay the studio rent");
      yield* kin.records.update(orgId, byRhea, rent.key, {
        dueAt: MON + 7 * 86_400_000,
        repeat: { every: "month" },
      });
      const tiles = (yield* kin.records.create(orgId, byRhea, {
        title: "Return the sample tiles",
        owner: finance,
        originKey: "Return the sample tiles",
        team: true,
      })).row;
      yield* kin.records.handBack(
        orgId,
        { actor: finance, via: "lead" },
        tiles.key,
        finance,
        "Needs Rhea's sign-off",
      );
      const cover = yield* kin.task("Draft the Lumen cover note");
      const proofs = yield* kin.task("Approve the Lumen proofs");
      yield* kin.records.update(orgId, byRhea, proofs.key, {
        state: "waiting",
        waitingOn: { _tag: "agent", agentId: KinAgentId.make("chief") },
      });
      const asked = [
        yield* askToClose(kin, rent, chatId),
        yield* askToClose(kin, tiles, chatId),
        yield* askToClose(kin, cover, chatId),
        yield* askToClose(kin, proofs, chatId),
      ];
      // Known when asked: closing the repeating or handed-back one does more than Undo puts back.
      const whenAsked = yield* Effect.forEach(asked, (one) =>
        Questions.readQuestion(orgId, one.question),
      );
      assert.deepStrictEqual(
        whenAsked.map((one) => one!.safe),
        [false, false, true, true],
      );
      // And Finance is told so when it asks, in the words the card will say.
      assert.deepStrictEqual(
        asked.map((one) => one.untaken),
        ["repeats", "handed_back", undefined, undefined],
      );
      assert.deepStrictEqual(
        asked.map((one) => one.note),
        [
          "Kin won't take “Mark W-1 done” on its own: its task repeats. It stays as it is until they answer; say so, and set nothing to take it later.",
          "Kin won't take “Mark W-2 done” on its own: its task was handed back.",
          undefined,
          undefined,
        ],
      );
      // One rule, read when asked and at the day: only a task's done or drop is taken.
      assert.deepStrictEqual(
        (
          [
            "done",
            "drop",
            "start",
            "create_list",
            "take_default",
            "let_talk",
            "undo_default",
            "keep_default",
          ] as const
        ).filter((kind) => takesAsDefault({ kind })),
        ["done", "drop"],
      );
      // An open question with no answers to tap gets no card, and is told what to do instead.
      const open = yield* callAs("finance", "kin_ask", {
        question: "What should we tell the pilot clinics?",
        options: [{ label: "Tell me" }],
        default: "none",
      });
      assert.deepStrictEqual(open, {
        ok: false,
        value: { _tag: "KinChatError", reason: "invalid_state", message: FEWER_THAN_TWO },
      });
      yield* kin.records.update(orgId, byRhea, cover.key, { title: "Send the Lumen cover note" });
      // Retired, the Chief of staff can't be waited on again, so Undo couldn't put proofs back.
      yield* sql`UPDATE kin_agents SET retired_at = ${at} WHERE org_id = ${orgId} AND agent_id = 'chief'`;
      const keys = [rent.key, tiles.key, cover.key, proofs.key];
      const before = yield* Effect.forEach(keys, kin.stateOf);
      assert.deepStrictEqual(
        before.map((one) => one.state),
        ["open", "open", "open", "waiting"],
      );

      assert.strictEqual(yield* settleAt(kin, Math.max(...asked.map((one) => one.due))), 2);
      assert.deepStrictEqual(yield* Effect.forEach(keys, kin.stateOf), before);
      const marked = yield* sql`SELECT 1 FROM kin_record_changes c WHERE c.org_id = ${orgId}
        AND EXISTS (SELECT 1 FROM json_each(c.fields_json) f
          WHERE json_extract(f.value, '$.field') = ${KIN_TAKEN_DEFAULT_FIELD})`;
      assert.lengthOf(marked, 0);
      const next = yield* sql`SELECT 1 FROM kin_records
        WHERE org_id = ${orgId} AND origin_key = ${`repeat:${rent.recordId}`}`;
      assert.lengthOf(next, 0);
      const [handed] = yield* sql<{ at: number | null }>`SELECT handed_back_at AS at
        FROM kin_records WHERE org_id = ${orgId} AND record_id = ${tiles.recordId}`;
      assert.isNotNull(handed!.at);
      const questions = Effect.forEach(asked, (one) => Questions.readQuestion(orgId, one.question));
      for (const question of yield* questions)
        assert.deepInclude(question!, { state: "open", safe: false, raiseWidgetId: null });

      // Raised: the two on a fresh card, the renamed one's left with too few options for one,
      // so its first card stays open for her, and Finance tells her once that it didn't go with it.
      const raiseAt = Math.max(...(yield* questions).map((one) => one!.actAt));
      yield* settleAt(kin, raiseAt);
      const [rentAsk, tilesAsk, coverAsk] = yield* questions;
      for (const question of yield* questions) {
        assert.strictEqual(question!.state, "open");
        assert.isNotNull(question!.raisedAt);
      }
      assert.isNotNull(rentAsk!.raiseWidgetId);
      assert.isNotNull(tilesAsk!.raiseWidgetId);
      assert.isNull((yield* kin.widget(coverAsk!.widgetId)).closedAt);
      const declined = sql<{ author: string | null; widgetId: string | null }>`SELECT
          author_agent_id AS author, widget_id AS "widgetId" FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatId}
          AND body = ${"I didn't go with “Mark Send the Lumen cover note done”: Send the Lumen cover note changed since I asked. Tell me what you'd like."}`;
      assert.deepStrictEqual(yield* declined, [{ author: "finance", widgetId: null }]);
      yield* settleAt(kin, raiseAt + 60_000);
      assert.lengthOf(yield* declined, 1);
      assert.deepStrictEqual(yield* Effect.forEach(keys, kin.stateOf), before);
    }).pipe(Effect.provide(layer)),
  ),
);

// Finance is retired and restored with its questions held, as `Retirement` does it. One was
// raised with a renamed task's choice left off, so its stored choices are the raise card's; the
// other was never raised and its task was renamed while retired, leaving one choice and no card.
it.effect(
  "a restored question is raised with the choices that still hold, or closes saying why",
  () =>
    Effect.andThen(
      TestClock.setTime(MON),
      Effect.gen(function* () {
        const kin = yield* ambermill;
        const { owner, orgId, sql, chats } = kin;
        const chatId = kin.chatOf("finance");
        const financeId = KinAgentId.make("finance");
        const byRhea = {
          actor: { _tag: "person" as const, personId: owner.personId },
          via: "owner" as const,
          askedBy: owner.personId,
        };
        const rename = (key: string, title: string) =>
          kin.records.update(orgId, byRhea, key, { title });
        const ask = Effect.fn("test.ask")(function* (
          body: string,
          options: ReadonlyArray<{ readonly label: string; readonly action?: unknown }>,
        ) {
          yield* kin.turn("finance", chatId, body);
          const asked = yield* callAs("finance", "kin_ask", {
            question: body,
            options,
            default: "none",
          });
          assert.isTrue(asked.ok, JSON.stringify(asked.value));
          return asked.value.question as string;
        });
        const question = (id: string) =>
          Questions.readQuestion(orgId, id).pipe(Effect.map((row) => row!));
        const a = yield* kin.task("Count the studio stock");
        const b = yield* kin.task("File the studio invoices");
        const c = yield* kin.task("Book the kiln service");
        const both = yield* ask("Which studio task should I finish first?", [
          { label: "Finish A", action: { kind: "done", target: a.key } },
          { label: "Finish B", action: { kind: "done", target: b.key } },
          { label: "Neither yet" },
        ]);
        yield* rename(a.key, "Count the studio stock twice");
        yield* settleAt(kin, (yield* question(both)).actAt);
        const firstRaise = (yield* question(both)).raiseWidgetId!;
        assert.deepStrictEqual(
          card(yield* kin.widget(firstRaise)).options.map((one) => one.label),
          [`Mark ${b.key} done`, "Neither yet"],
        );
        const never = yield* ask("Is the kiln service finished?", [
          { label: "Close it", action: { kind: "done", target: c.key } },
          { label: "Not yet" },
        ]);

        const retiredAt = (yield* Clock.currentTimeMillis) + 60_000;
        yield* Questions.closeHeldQuestions(
          { orgId, holder: { agentId: financeId }, reason: () => "Retired.", closedAt: retiredAt },
          chats,
        );
        yield* rename(c.key, "Book the kiln service again");
        yield* Questions.reopenRetiredQuestions({
          orgId,
          agentId: financeId,
          retiredAt,
          now: retiredAt + 86_400_000,
        });
        yield* settleAt(
          kin,
          Math.max((yield* question(both)).actAt, (yield* question(never)).actAt),
        );

        // Raised again with both choices that hold, B's still marking B done.
        const again = yield* question(both);
        assert.notStrictEqual(again.raiseWidgetId, firstRaise);
        const redrawn = yield* kin.widget(again.raiseWidgetId);
        assert.isNull(redrawn.closedAt);
        assert.deepStrictEqual(
          card(redrawn).options.map((one) => one.label),
          [`Mark ${b.key} done`, "Neither yet"],
        );
        yield* kin.tap(owner, again.raiseWidgetId, "option-1", "restored-b");
        assert.strictEqual((yield* kin.stateOf(b.key)).state, "done");

        // One choice left and its card closed at retirement: it closes, and Finance says why.
        assert.strictEqual((yield* question(never)).state, "withdrawn");
        assert.deepStrictEqual(
          yield* sql<{ author: string | null }>`SELECT author_agent_id AS author FROM kin_messages
          WHERE org_id = ${orgId} AND chat_id = ${chatId}
            AND body = ${"I've closed my question “Is the kiln service finished?”: its choices changed since I asked. Tell me what you'd like."}`,
          [{ author: "finance" }],
        );
        const waiting = yield* kin.repo.listOpenWaiting({ orgId, personId: owner.personId });
        assert.notInclude(
          waiting.map((item) => item.widgetId),
          (yield* question(never)).widgetId,
        );
      }).pipe(Effect.provide(layer)),
    ),
);

// Finance holds two tasks and its own defaults close both. Rhea's Undo on one note puts it back
// exactly: still Finance's, given by nobody anew, and Finance hears once, by the undone event.
// Undo of the other from Finance's page does the same, and closes that one's note as Undone, so
// a later tap on it changes nothing.
it.effect("Undo puts back only what a default changed, from its note or the agent's page", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const chatId = kin.chatOf("finance");
      const finance = KinAgentId.make("finance");
      const held = Effect.fn("test.held")(function* (title: string) {
        return (yield* kin.records.create(
          orgId,
          {
            actor: { _tag: "person", personId: owner.personId },
            via: "owner",
            askedBy: owner.personId,
          },
          { title, owner: { _tag: "agent", agentId: finance }, originKey: title, team: true },
        )).row;
      });
      const assignment = (recordId: string) =>
        sql`SELECT owner_kind AS kind, owner_id AS holder, assigned_by_person_id AS "givenBy",
            assigned_at AS "givenAt", assigned_by_agent_id AS "givenByAgent"
          FROM kin_records WHERE org_id = ${orgId} AND record_id = ${recordId}`;
      const events = sql<{ key: string; tag: string }>`SELECT dedupe_key AS key, tag
        FROM kin_events WHERE org_id = ${orgId} AND agent_id = ${finance} ORDER BY rowid`;
      const lastChange = (recordId: string) =>
        sql<{ seq: number; actor: string; fields: string }>`SELECT seq,
            actor_kind || ':' || actor_id AS actor, fields_json AS fields
          FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${recordId}
          ORDER BY seq DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]!));
      const invoices = yield* held("Reconcile the Apex invoices");
      const receipts = yield* held("File the Apex receipts");
      const onNote = yield* askToClose(kin, invoices, chatId);
      const onPage = yield* askToClose(kin, receipts, chatId);
      const given = [yield* assignment(invoices.recordId), yield* assignment(receipts.recordId)];
      assert.strictEqual(yield* settleAt(kin, Math.max(onNote.due, onPage.due)), 2);
      assert.strictEqual((yield* kin.stateOf(invoices.key)).state, "done");
      assert.strictEqual((yield* kin.stateOf(receipts.key)).state, "done");

      const [note] = yield* noticesOf(kin, onNote.question);
      const queued = (yield* events).length;
      yield* kin.tap(owner, note!.widgetId, "option-1", "undo-invoices");
      assert.strictEqual((yield* kin.stateOf(invoices.key)).state, "open");
      assert.deepStrictEqual(yield* assignment(invoices.recordId), given[0]);
      assert.deepStrictEqual(JSON.parse((yield* lastChange(invoices.recordId)).fields), [
        { field: "state", from: "done", to: "open" },
      ]);
      assert.deepStrictEqual((yield* events).slice(queued), [
        { key: `question-undone:${onNote.question}`, tag: "deferral.due" },
      ]);

      const [pageNote] = yield* noticesOf(kin, onPage.question);
      const taken = yield* lastChange(receipts.recordId);
      assert.strictEqual(taken.actor, "agent:finance");
      const before = (yield* events).length;
      yield* ownerLevelUndoAgentChange({
        orgId,
        agentId: finance,
        seq: taken.seq,
        by: owner.personId,
      });
      const reopened = yield* kin.stateOf(receipts.key);
      assert.strictEqual(reopened.state, "open");
      assert.deepStrictEqual(yield* assignment(receipts.recordId), given[1]);
      assert.deepStrictEqual((yield* events).slice(before), [
        { key: `question-undone:${onPage.question}`, tag: "deferral.due" },
      ]);
      const closed = yield* kin.widget(pageNote!.widgetId);
      assert.isNotNull(closed.closedAt);
      assert.deepStrictEqual(card(closed).outcome, {
        title: "Undone",
        text: `Put ${receipts.key} “File the Apex receipts” back as it was.`,
        undone: {
          personId: owner.personId,
          name: "Rhea Rao",
          at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
        },
      });
      yield* kin.tap(owner, pageNote!.widgetId, "option-1", "undo-receipts").pipe(Effect.flip);
      assert.deepStrictEqual(yield* kin.stateOf(receipts.key), reopened);
      assert.lengthOf(yield* events, before + 1);

      // A list's own field called "default" is an ordinary field: Finance's edit of it lists as
      // one, and the page's Undo refuses it as it does any list field, waking nobody.
      const dates = presetDefinition("dates", "INR");
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'filings', 'Filings', 'FIL', 0, 0, ${JSON.stringify({
          ...dates,
          fields: [
            ...dates.fields,
            { key: "default", label: "Default", type: "text", sensitive: false },
          ],
        })})`;
      const filing = (yield* kin.records.create(
        orgId,
        { actor: { _tag: "person", personId: owner.personId }, via: "owner" },
        {
          list: "filings",
          title: "Invented annual return",
          owner: { _tag: "person", personId: owner.personId },
          originKey: "annual return",
        },
      )).row;
      yield* kin.records.update(
        orgId,
        { actor: { _tag: "agent", agentId: finance }, via: "lead" },
        filing.key,
        {
          title: "Invented annual return, filed",
          fields: { default: "Ship by Friday" },
        },
      );
      const edited = yield* lastChange(filing.recordId);
      const [listed] = (yield* agentChanges(KIN_OWNER_LEVEL, orgId, finance)).filter(
        (one) => one.seq === edited.seq,
      );
      assert.deepInclude(listed!.fields, { field: "default", from: null, to: "Ship by Friday" });
      assert.isFalse(listed!.undo);
      const queuedBefore = (yield* events).length;
      const refused = yield* ownerLevelUndoAgentChange({
        orgId,
        agentId: finance,
        seq: edited.seq,
        by: owner.personId,
      }).pipe(Effect.flip);
      assert.include(refused, { reason: "invalid_state" });
      assert.lengthOf(yield* events, queuedBefore);
      assert.strictEqual(
        (yield* kin.records.get(orgId, filing.key))!.title,
        "Invented annual return, filed",
      );
    }).pipe(Effect.provide(layer)),
  ),
);

// Finance's defaults close tasks others hold. Dev presses Undo on his own: nobody tells him. Rhea
// presses it on the Chief's: the Chief is woken once. Then on Dev's, while he is away: his notice
// that it is open again is held for him, once, and Finance hears only its undone event.
it.effect("whoever holds a task a default closed hears once that an Undo reopened it", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const dev = kin.person("dev");
      const finance = KinAgentId.make("finance");
      yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
        VALUES (${orgId}, 'finance', ${owner.personId}, 0)`;
      const devChat = (yield* kin.chats.createDirect(dev, { orgId, agentId: finance })).chatId;
      const chatId = kin.chatOf("finance");
      const events = (agent: string) =>
        sql<{ key: string; tag: string }>`SELECT dedupe_key AS key, tag FROM kin_events
          WHERE org_id = ${orgId} AND agent_id = ${agent} ORDER BY rowid`;
      const assignment = (recordId: string) =>
        sql`SELECT owner_kind AS kind, owner_id AS holder, assigned_by_person_id AS "givenBy",
            assigned_at AS "givenAt" FROM kin_records
          WHERE org_id = ${orgId} AND record_id = ${recordId}`;
      const reopenedFor = (personId: string) =>
        sql<{ body: string }>`SELECT body FROM kin_messages WHERE org_id = ${orgId}
            AND body LIKE '%is open again%'
            AND chat_id IN (SELECT chat_id FROM kin_chat_members WHERE org_id = ${orgId}
              AND person_id = ${personId})
          UNION ALL SELECT body FROM kin_held_posts WHERE org_id = ${orgId}
            AND person_id = ${personId} AND body LIKE '%is open again%'
          ORDER BY body`;
      const undoNote = Effect.fn("test.undoNote")(function* (
        who: { readonly _tag: "person"; readonly personId: KinPersonId },
        questionId: string,
      ) {
        const [note] = yield* noticesOf(kin, questionId);
        yield* kin.tap(who, note!.widgetId, "option-1", `undo-${questionId}`);
      });

      const own = yield* kin.task("Retouch the Lumen photos", dev.personId);
      const ownAsk = yield* askToClose(kin, own, devChat, dev);
      yield* settleAt(kin, ownAsk.due);
      yield* undoNote(dev, ownAsk.question);
      assert.strictEqual((yield* kin.stateOf(own.key)).state, "open");
      assert.lengthOf(yield* reopenedFor("dev"), 0);

      const chiefs = (yield* kin.records.create(
        orgId,
        {
          actor: { _tag: "person", personId: owner.personId },
          via: "owner",
          askedBy: owner.personId,
        },
        {
          title: "Book the Apex venue",
          owner: { _tag: "agent", agentId: KinAgentId.make("chief") },
          originKey: "Book the Apex venue",
          team: true,
        },
      )).row;
      const chiefAsk = yield* askToClose(kin, chiefs, chatId);
      yield* settleAt(kin, chiefAsk.due);
      const chiefGiven = yield* assignment(chiefs.recordId);
      const chiefBefore = (yield* events("chief")).length;
      const financeBefore = (yield* events("finance")).length;
      yield* undoNote(owner, chiefAsk.question);
      assert.strictEqual((yield* kin.stateOf(chiefs.key)).state, "open");
      assert.deepStrictEqual(yield* assignment(chiefs.recordId), chiefGiven);
      const woken = (yield* events("chief")).slice(chiefBefore);
      assert.lengthOf(woken, 1);
      assert.deepInclude(woken[0]!, { tag: "record.changed" });
      assert.match(woken[0]!.key, new RegExp(`^record-assigned:${chiefs.recordId}:`));
      assert.deepStrictEqual((yield* events("finance")).slice(financeBefore), [
        { key: `question-undone:${chiefAsk.question}`, tag: "deferral.due" },
      ]);

      const devs = yield* kin.task("Print the Apex badges", dev.personId);
      const devAsk = yield* askToClose(kin, devs, chatId);
      yield* settleAt(kin, devAsk.due);
      const devGiven = yield* assignment(devs.recordId);
      const back = DateTime.formatIsoDate(DateTime.makeUnsafe(devAsk.due + 2 * 86_400_000));
      yield* sql`UPDATE kin_people SET away_until = ${back} WHERE person_id = 'dev'`;
      const financeLater = (yield* events("finance")).length;
      yield* undoNote(owner, devAsk.question);
      yield* settleAt(kin, devAsk.due + 60_000);
      assert.deepStrictEqual(yield* assignment(devs.recordId), devGiven);
      assert.deepStrictEqual((yield* events("finance")).slice(financeLater), [
        { key: `question-undone:${devAsk.question}`, tag: "deferral.due" },
      ]);
      const told = `${devs.key} Print the Apex badges is open again: Rhea Rao undid a default Kin had taken.`;
      assert.deepStrictEqual(yield* reopenedFor("dev"), [{ body: told }]);
      const [held] = yield* sql<{ delivered: number | null }>`SELECT delivered_at AS delivered
        FROM kin_held_posts WHERE org_id = ${orgId} AND person_id = 'dev'
          AND body = ${told}`;
      assert.isNull(held!.delivered);
    }).pipe(Effect.provide(layer)),
  ),
);

// Meera is away when Finance's defaults close two of her tasks, and Rhea puts both back from
// Finance's page before she is told. One was already picked by a pass that tells her only after
// the Undo; the other waits for her return. Each reaches her once, as put back, with no Undo.
it.effect("a default undone before its person is told reaches them once, as put back", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const meera = kin.person("meera");
      const finance = KinAgentId.make("finance");
      const meeraChat = (yield* kin.chats.createDirect(meera, { orgId, agentId: finance })).chatId;
      const said = sql<{ body: string; widgetId: string | null }>`SELECT body,
          widget_id AS "widgetId" FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${meeraChat} AND author_kind = 'agent'
        ORDER BY seq`;
      const reviewed = yield* kin.task("Review the Apex brief", meera.personId);
      const printed = yield* kin.task("Print the Apex brief", meera.personId);
      const waits = yield* askToClose(kin, reviewed, meeraChat, meera);
      const picked = yield* askToClose(kin, printed, meeraChat, meera);
      const due = Math.max(waits.due, picked.due);
      const back = DateTime.formatIsoDate(DateTime.makeUnsafe(due + 86_400_000));
      yield* sql`UPDATE kin_people SET away_until = ${back} WHERE person_id = 'meera'`;
      assert.strictEqual(yield* settleAt(kin, due), 2);
      const before = (yield* said).length;
      const undoFromPage = Effect.fn("test.undoFromPage")(function* (recordId: string) {
        const [taken] = yield* sql<{ seq: number }>`SELECT seq FROM kin_record_changes
          WHERE org_id = ${orgId} AND record_id = ${recordId} ORDER BY seq DESC LIMIT 1`;
        yield* ownerLevelUndoAgentChange({
          orgId,
          agentId: finance,
          seq: taken!.seq,
          by: owner.personId,
        });
      });

      // A pass picked the second before the Undo landed: it tells her only after.
      const stale = (yield* Questions.readQuestion(orgId, picked.question))!;
      yield* undoFromPage(printed.recordId);
      yield* sql.withTransaction(
        tellTaken(
          {
            orgId,
            questionId: stale.questionId,
            agentId: stale.agentId,
            personId: stale.personId,
            chatId: stale.chatId,
            label: stale.defaultLabel!,
            question: stale.question,
            about: stale.about,
            now: due + 60_000,
          },
          kin.chats,
        ),
      );
      yield* undoFromPage(reviewed.recordId);
      assert.strictEqual((yield* kin.stateOf(reviewed.key)).state, "open");
      yield* settleAt(kin, due + 120_000);

      // Nothing else waits for her: the line says it, so no notice that her task is open again.
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_held_posts WHERE org_id = ${orgId} AND person_id = 'meera'`,
        0,
      );
      const home = Date.parse(`${back}T12:00:00.000Z`);
      yield* settleAt(kin, home);
      yield* settleAt(kin, home + 60_000);
      assert.deepStrictEqual((yield* said).slice(before), [
        {
          body: "Nobody answered, so I went with “Mark Print the Apex brief done” for Print the Apex brief. Rhea Rao has since put it back.",
          widgetId: null,
        },
        {
          body: "Nobody answered, so I went with “Mark Review the Apex brief done” for Review the Apex brief. Rhea Rao has since put it back.",
          widgetId: null,
        },
      ]);
    }).pipe(Effect.provide(layer)),
  ),
);

// The owner's Confirm records the money as them; the agent the tap wakes sets that advance
// against an invoice with no further word. A co-owner's change in the tap's moment still stands.
it.effect("a receipt Confirm's own writes are the tap's, not newer than it", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql, records } = kin;
      const chatId = kin.chatOf("finance");
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
      const ownerWrites = {
        actor: { _tag: "person" as const, personId: owner.personId },
        via: "owner" as const,
        askedBy: owner.personId,
      };
      const client = yield* records.create(orgId, ownerWrites, {
        list: "clients",
        title: "Invented Acme",
        owner: { _tag: "person", personId: owner.personId },
        originKey: "acme",
      });
      const invoice = yield* records.create(orgId, ownerWrites, {
        list: "invoices",
        title: "Invented website redesign",
        owner: { _tag: "person", personId: owner.personId },
        partyId: client.row.recordId,
        amount: { minor: 2_000_00, currency: "INR" },
        originKey: "redesign",
      });
      const meera = KinPersonId.make("meera");
      /** Rhea's advance, confirmed on its card; with `meeraToo`, Meera changes it in that moment. */
      const confirmed = Effect.fn("test.confirmed")(function* (n: number, meeraToo = false) {
        yield* kin.turn("finance", chatId, `Acme sent an advance of 500 (${n})`);
        const proposed = yield* callAs("finance", "kin_receipt", {
          advance: { client: client.row.key, amount: "500", receivedOn: "2026-11-15" },
        });
        assert.strictEqual(proposed.value.status, "proposed", JSON.stringify(proposed.value));
        const [card] = yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
          FROM kin_receipt_proposals WHERE org_id = ${orgId}
            AND proposal_id = ${String(proposed.value.proposal)}`;
        const tapped = yield* kin.tap(owner, card!.widgetId, "option-1", `confirm-${n}`);
        const [made] = yield* sql<{ key: string }>`SELECT receipt_key AS key
          FROM kin_receipt_proposals WHERE org_id = ${orgId}
            AND proposal_id = ${String(proposed.value.proposal)}`;
        if (meeraToo)
          yield* records.update(
            orgId,
            { actor: { _tag: "person", personId: meera }, via: "owner", askedBy: meera },
            made!.key,
            {},
            undefined,
            [{ field: "payment", from: null, to: "Invented: cheque 0042" }],
          );
        const woke = wakeEvent(tapped, KinAgentId.make("finance"), "choose");
        yield* startAgentWakeup({
          orgId,
          agentId: KinAgentId.make("finance"),
          threadId: ThreadId.make("finance-thread"),
          event: () => woke,
        });
        return yield* callAs("finance", "kin_receipt", {
          sourceEventId: woke.eventId,
          entry: made!.key,
          against: invoice.row.key,
        });
      });
      const set = yield* confirmed(1);
      assert.isTrue(set.ok, JSON.stringify(set.value));
      assert.strictEqual((yield* records.get(orgId, invoice.row.key))!.paid, 500_00);

      const refused = yield* confirmed(2, true);
      assert.isFalse(refused.ok);
      assert.match(
        String(refused.value.message ?? JSON.stringify(refused.value)),
        /^Nothing changed on [A-Z]+-\d+: Meera Shah changed its payment/,
      );
      assert.strictEqual((yield* records.get(orgId, invoice.row.key))!.paid, 500_00);
    }).pipe(Effect.provide(layer)),
  ),
);

// Kin's bank matching took a credit for an invoice's payment: the agent's card records it on the
// owner's tap, in server code, from Kin's records only, and every way back and around holds.
it.effect("a tap records a bank credit as the invoice's payment the matcher ranks first", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql, records } = kin;
      const chatId = kin.chatOf("finance");
      const withKin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(Effect.provide(kin.services));
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
      const ownerWrites = {
        actor: { _tag: "person" as const, personId: owner.personId },
        via: "owner" as const,
        askedBy: owner.personId,
      };
      const agentWrites = {
        actor: { _tag: "agent" as const, agentId: KinAgentId.make("finance") },
        via: "lead" as const,
      };
      const kinWrites = { actor: { _tag: "system" as const }, via: "import" as const };
      const client = yield* records.create(orgId, ownerWrites, {
        list: "clients",
        title: "Harbourline Logistics",
        owner: { _tag: "person", personId: owner.personId },
        originKey: "harbourline",
      });
      const invoiceOf = Effect.fn("test.invoiceOf")(function* (title: string, number: string) {
        const { row } = yield* records.create(orgId, ownerWrites, {
          list: "invoices",
          title,
          owner: { _tag: "person", personId: owner.personId },
          partyId: client.row.recordId,
          amount: { minor: 95_000_00, currency: "INR" },
          originKey: title,
        });
        yield* sql`UPDATE kin_records SET state = 'waiting', date_at = ${MON - 10 * DAY_MS},
            fields_json = json_set(fields_json, '$.number', ${number})
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
        return row;
      });
      const invoice = yield* invoiceOf("October retainer", "AM/26-27/001");
      const second = yield* invoiceOf("November retainer", "AM/26-27/002");
      const bankList = yield* ensureBankList(orgId, MON);
      const credit = (
        title: string,
        rupees: number,
        reference: string,
        writer: Parameters<typeof records.create>[1] = kinWrites,
      ) =>
        records
          .create(orgId, writer, {
            list: bankList.id,
            title,
            owner: { _tag: "person", personId: owner.personId },
            amount: { minor: rupees * 100, currency: "INR" },
            dateAt: MON - DAY_MS,
            fields: { direction: "credit", reference, account: "Invented Bank ••4821" },
            originKey: reference,
          })
          .pipe(Effect.map(({ row }) => row));
      const cites = "NEFT CR-HARBOURLINE LOGISTICS-AM/26-27/001";
      const bank = yield* credit(cites, 95_000, "INVTN0000000042");
      // Written by an agent, or changed by one since: never the bank's word for money in.
      const typed = yield* credit(cites, 95_000, "INVTN0000000043", agentWrites);
      const touched = yield* credit(cites, 95_000, "INVTN0000000044");
      yield* records.update(orgId, agentWrites, touched.key, { notes: "Matched by Finance." });
      // A person's edit leaves it the bank's.
      yield* records.update(orgId, ownerWrites, bank.key, { notes: "Checked with the bank." });
      const seen = KinPulse.read({ orgId, at: MON, viewer: { _tag: "owner" } }).pipe(
        Effect.map((pulse) =>
          pulse.facts.filter((fact) => fact.sense === "payment_seen").map((fact) => fact.key),
        ),
      );
      assert.deepStrictEqual(yield* seen, [`payment_seen:${bank.key}`]);

      yield* kin.turn("finance", chatId, "Anything in the bank?");
      const ask = (target: string, question: string) =>
        callAs("finance", "kin_ask", {
          question,
          options: [
            { label: "Record it", kind: "yes", action: { kind: "record_payment", target } },
            { label: "Not this invoice", kind: "no" },
          ],
          default: "none",
        });
      const refusal = (target: string) =>
        ask(target, `Record ${target}?`).pipe(
          Effect.map((asked) => {
            assert.isFalse(asked.ok, target);
            return String(asked.value.message);
          }),
        );
      for (const target of [typed.key, touched.key])
        assert.match(
          yield* refusal(target),
          /was written or changed by an agent, so Kin can't take it/,
        );
      assert.match(
        yield* refusal(`${bank.key} ${invoice.key} more`),
        /^record_payment's target is/,
      );
      // Ranked below the invoice the credit cites: refused, naming the one ranked first.
      assert.strictEqual(
        yield* refusal(`${bank.key} ${second.key}`),
        `Kin ranks AM/26-27/001 (${invoice.key}) first for ${bank.key}, not ${second.key}. Offer "${bank.key} ${invoice.key}" instead.`,
      );
      // Two invoices level for one credit: the credit alone is refused, each pair is drawable.
      const level = yield* credit("NEFT CR-HARBOURLINE LOGISTICS", 95_000, "INVTN0000000045");
      assert.strictEqual(
        yield* refusal(level.key),
        `${level.key} fits AM/26-27/001 (${invoice.key}) and AM/26-27/002 (${second.key}) equally, so Kin can't pick one. Offer one option per invoice, with targets "${level.key} ${invoice.key}" and "${level.key} ${second.key}".`,
      );
      const levelCard = yield* ask(`${level.key} ${second.key}`, "Which invoice is it?");
      assert.isTrue(levelCard.ok, JSON.stringify(levelCard.value));

      // The credit alone, or with the invoice by key or printed number, draws the same card.
      const line = `Record ₹95,000.00 received 15 Nov (${bank.key}) as the payment of AM/26-27/001 from Harbourline Logistics; it settles the invoice in full`;
      const drawn: Array<string> = [];
      for (const target of [bank.key, `${bank.key} ${invoice.key}`, `${bank.key} AM/26-27/001`]) {
        const asked = yield* ask(target, `Is ${target} October's payment?`);
        assert.isTrue(asked.ok, JSON.stringify(asked.value));
        assert.deepStrictEqual(card(yield* kin.widget(asked.value.widgetId)).options[0], {
          optionId: "option-1",
          label: "Record ₹95,000.00 for AM/26-27/001",
          action: { line },
        });
        drawn.push(String(asked.value.widgetId));
      }
      const [stale, asked, again] = drawn;
      // Nothing is recorded until the owner taps it.
      assert.strictEqual((yield* records.get(orgId, invoice.key))!.paid, 0);

      // Finance was told; a card whose credit changed since records nothing, and the fact is told
      // again on the next pass while it still holds.
      const factKey = `payment_seen:${bank.key}`;
      assert.include((yield* withKin(KinPulse.tick(orgId, MON))).woken, factKey);
      // Finance's turn on it ran.
      yield* sql`UPDATE kin_events SET state = 'done'
        WHERE org_id = ${orgId} AND dedupe_key LIKE 'payment_seen:%'`;
      yield* records.update(orgId, ownerWrites, bank.key, { notes: "Checked twice." });
      yield* kin.tap(owner, stale, "option-1", "record-stale");
      assert.deepStrictEqual(card(yield* kin.widget(stale)).outcome, {
        title: "Nothing was done",
        text: `${bank.key} or ${invoice.key} changed since this was offered, so nothing was done.`,
      });
      assert.strictEqual((yield* records.get(orgId, invoice.key))!.paid, 0);
      assert.include((yield* withKin(KinPulse.tick(orgId, MON + 60_000))).woken, factKey);
      // One that no longer fits is not told again.
      yield* records.update(orgId, ownerWrites, level.key, { state: "dropped" });
      yield* kin.tap(owner, levelCard.value.widgetId, "option-1", "record-level");
      assert.strictEqual(
        card(yield* kin.widget(levelCard.value.widgetId)).outcome?.title,
        "Nothing was done",
      );
      assert.notInclude(
        (yield* withKin(KinPulse.tick(orgId, MON + 120_000))).woken,
        `payment_seen:${level.key}`,
      );

      // Cards drawn before the note above are stale too; a fresh one records it.
      for (const widgetId of [asked, again])
        yield* kin.tap(owner, widgetId!, "option-1", `r-${widgetId}`);
      const fresh = yield* ask(bank.key, "Is this October's payment, then?");
      const later = yield* ask(bank.key, "Is this the October payment?");
      const tapped = yield* kin.tap(owner, fresh.value.widgetId, "option-1", "record-1");
      assert.deepInclude(JSON.parse(tapped.body), { handled: true });
      const paid = (yield* records.get(orgId, invoice.key))!;
      assert.deepStrictEqual([paid.paid, paid.state], [95_000_00, "done"]);
      const explained = (yield* records.get(orgId, bank.key))!;
      assert.deepStrictEqual([explained.state, explained.category], ["done", "payment received"]);
      const links = yield* sql<{ from: string; to: string }>`SELECT record_id AS "from",
          target AS "to" FROM kin_record_links
        WHERE org_id = ${orgId} AND kind = 'record' ORDER BY record_id, target`;
      assert.sameDeepMembers(
        links.filter((one) => [one.from, one.to].includes(bank.recordId)),
        [
          { from: invoice.recordId, to: bank.recordId },
          { from: bank.recordId, to: invoice.recordId },
        ],
      );
      assert.deepStrictEqual(card(yield* kin.widget(fresh.value.widgetId)).outcome, {
        title: "Payment recorded",
        text: `Recorded ₹95,000.00 received 15 Nov (${bank.key}) as the payment of AM/26-27/001 from Harbourline Logistics; the invoice is paid in full. ${bank.key} is explained in Bank transactions.`,
      });
      assert.notInclude(yield* seen, factKey);
      // Another open card for it closes with the invoice paid, and its tap is refused.
      assert.isNotNull((yield* kin.widget(later.value.widgetId)).closedAt);
      const late = yield* kin
        .tap(owner, later.value.widgetId, "option-1", "record-2")
        .pipe(Effect.flip);
      assert.include(late, { reason: "widget_changed" });
      assert.strictEqual((yield* records.get(orgId, invoice.key))!.paid, 95_000_00);

      // A statement with the same credit finds it explained, and offers the card's payment for
      // no other row of that amount.
      const row = (index: number, reference: string) => ({
        index,
        date: "2026-11-15",
        description: index === 0 ? cites : "NEFT CR-INVENTED STRANGER",
        reference,
        amountMinor: 95_000_00,
        direction: "credit" as const,
        balanceMinor: null,
        foreign: null,
      });
      const review = yield* withKin(
        buildReview(
          orgId,
          {
            kind: "account",
            bank: "Invented Bank",
            account: "4821",
            currency: "INR",
            from: "2026-11-15",
            to: "2026-11-15",
            openingMinor: null,
            closingMinor: null,
            rows: [row(0, "INVTN0000000042"), row(1, "INVTN0000000099")],
            check: { status: "adds_up", line: "" },
          },
          null,
          "file",
          "st-invented",
        ),
      );
      assert.strictEqual(review.known.get(0)?.recordId, bank.recordId);
      assert.isFalse(review.matches.has(0));
      assert.isFalse(
        (review.matches.get(1)?.candidates ?? []).some((one) => one.fit === "recorded"),
      );

      // Taken back on the invoice, the credit is Unexplained again, written as Kin's, and is never
      // offered for that invoice again: only for the other one it fits.
      const [payment] = yield* sql<{ paymentId: string }>`SELECT payment_id AS "paymentId"
        FROM kin_record_payments WHERE org_id = ${orgId} AND record_id = ${invoice.recordId}
          AND voided_at IS NULL`;
      yield* records.voidPayment(orgId, ownerWrites, invoice.key, payment!.paymentId);
      assert.strictEqual((yield* records.get(orgId, bank.key))!.state, "open");
      const reopened = (yield* KinPulse.read({
        orgId,
        at: MON,
        viewer: { _tag: "owner" },
      })).facts.find((fact) => fact.key === factKey);
      assert.strictEqual(reopened?.subject.key, second.key);
      assert.match(
        String((yield* ask(`${bank.key} ${invoice.key}`, "October after all?")).value.message),
        /^Kin ranks AM\/26-27\/002/,
      );

      // A part payment says what stays owed.
      const part = yield* credit(
        "NEFT CR-HARBOURLINE LOGISTICS-AM/26-27/002",
        45_000,
        "INVTN0000000046",
      );
      const partCard = yield* ask(`${part.key} AM/26-27/002`, "Is this part of November's?");
      assert.isTrue(partCard.ok, JSON.stringify(partCard.value));
      assert.deepStrictEqual(card(yield* kin.widget(partCard.value.widgetId)).options[0], {
        optionId: "option-1",
        label: "Record ₹45,000.00 for AM/26-27/002",
        action: {
          line: `Record ₹45,000.00 received 15 Nov (${part.key}) as the payment of AM/26-27/002 from Harbourline Logistics; ₹50,000.00 stays owed on it`,
        },
      });
      yield* kin.tap(owner, partCard.value.widgetId, "option-1", "record-part");
      assert.deepStrictEqual(card(yield* kin.widget(partCard.value.widgetId)).outcome, {
        title: "Payment recorded",
        text: `Recorded ₹45,000.00 received 15 Nov (${part.key}) as the payment of AM/26-27/002 from Harbourline Logistics; ₹50,000.00 is still owed on it. ${part.key} is explained in Bank transactions.`,
      });
      assert.deepStrictEqual(
        [
          (yield* records.get(orgId, second.key))!.paid,
          (yield* records.get(orgId, second.key))!.state,
        ],
        [45_000_00, "waiting"],
      );
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect(
  "a tap marks a partner's oldest owed expenses repaid by a debit that adds up exactly",
  () =>
    Effect.andThen(
      TestClock.setTime(MON),
      Effect.gen(function* () {
        const kin = yield* ambermill;
        const { owner, orgId, sql, records } = kin;
        const chatId = kin.chatOf("finance");
        const withKin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(Effect.provide(kin.services));
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'expenses', 'Expenses', 'EXP', 0, 0, ${JSON.stringify(presetDefinition("expenses", "INR"))})`;
        // Zoya paid three supplier bills from her own card.
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES ('zoya', ${orgId}, 'zoya', 'Zoya Rao', ${at}, 'member')`;
        const ownerWrites = {
          actor: { _tag: "person" as const, personId: owner.personId },
          via: "owner" as const,
          askedBy: owner.personId,
        };
        const agentWrites = {
          actor: { _tag: "agent" as const, agentId: KinAgentId.make("finance") },
          via: "lead" as const,
        };
        const kinWrites = { actor: { _tag: "system" as const }, via: "import" as const };
        const paid = Effect.fn("test.paid")(function* (title: string, rupees: number, ago: number) {
          const { row } = yield* records.create(orgId, ownerWrites, {
            list: "expenses",
            title,
            owner: { _tag: "person", personId: owner.personId },
            amount: { minor: rupees * 100, currency: "INR" },
            dateAt: MON - ago * DAY_MS,
            fields: { fundedBy: "person:zoya" },
            originKey: title,
          });
          yield* sql`UPDATE kin_records SET state = 'done'
          WHERE org_id = ${orgId} AND record_id = ${row.recordId}`;
          return (yield* records.get(orgId, row.key))!;
        });
        const first = yield* paid("Packing tape", 5_000, 14);
        const second = yield* paid("Pallet hire", 4_200, 7);
        const third = yield* paid("Courier to Tidewater Freight", 3_200, 3);
        const bankList = yield* ensureBankList(orgId, MON);
        const debit = (
          title: string,
          rupees: number,
          reference: string,
          writer: Parameters<typeof records.create>[1] = kinWrites,
        ) =>
          records
            .create(orgId, writer, {
              list: bankList.id,
              title,
              owner: { _tag: "person", personId: owner.personId },
              amount: { minor: rupees * 100, currency: "INR" },
              dateAt: MON - DAY_MS,
              fields: { direction: "debit", reference, account: "Invented Bank ••4821" },
              originKey: reference,
            })
            .pipe(Effect.map(({ row }) => row));
        const bank = yield* debit("UPI/Zoya Rao/reimb", 12_400, "633011110009");
        const short = yield* debit("UPI/Zoya Rao/reimb", 9_000, "633011110010");
        const typed = yield* debit("UPI/Zoya Rao/reimb", 12_400, "633011110011", agentWrites);
        const factKey = `repaid_seen:${bank.key}`;
        const told = KinPulse.read({ orgId, at: MON, viewer: { _tag: "owner" } }).pipe(
          Effect.map((pulse) =>
            pulse.facts.filter((fact) => fact.sense === "repaid_seen").map((fact) => fact.key),
          ),
        );
        assert.sameMembers(yield* told, [factKey, `repaid_seen:${short.key}:short`]);

        yield* kin.turn("finance", chatId, "Anything in the bank?");
        const ask = (target: string, question: string) =>
          callAs("finance", "kin_ask", {
            question,
            options: [
              { label: "Mark them repaid", kind: "yes", action: { kind: "mark_repaid", target } },
              { label: "Not yet", kind: "no" },
            ],
            default: "none",
          });
        const refusal = (target: string) =>
          ask(target, `Mark ${target}?`).pipe(
            Effect.map((asked) => {
              assert.isFalse(asked.ok, target);
              return String(asked.value.message);
            }),
          );
        assert.strictEqual(
          yield* refusal(`${bank.key} ${first.key}`),
          "mark_repaid's target is one Bank transactions debit's key, such as BNK-4.",
        );
        assert.match(yield* refusal(typed.key), /was written or changed by an agent/);
        assert.strictEqual(
          yield* refusal(short.key),
          `${short.key} names Zoya Rao but doesn't add up exactly to their oldest owed expenses, so Kin marks nothing and offers no card for it. Nothing was asked; tell the owner what you see instead.`,
        );

        const label = "Mark Zoya Rao's 3 expenses repaid";
        const line = `Mark ${first.key}, ${second.key} and ${third.key} (₹12,400.00 in all) repaid on 15 Nov by ${bank.key}; nothing more is owed to Zoya Rao`;
        const drawn: Array<string> = [];
        for (const question of [
          "Is this Zoya's repayment?",
          "Zoya's repayment, then?",
          "Mark it?",
        ]) {
          const asked = yield* ask(bank.key, question);
          assert.isTrue(asked.ok, JSON.stringify(asked.value));
          assert.deepStrictEqual(card(yield* kin.widget(asked.value.widgetId)).options[0], {
            optionId: "option-1",
            label,
            action: { line },
          });
          drawn.push(String(asked.value.widgetId));
        }
        const [stale, fresh, later] = drawn;
        const owed = () =>
          Effect.forEach([first, second, third], (one) =>
            records
              .get(orgId, one.key)
              .pipe(Effect.map((row) => parseFields(row!.fieldsJson).reimbursement)),
          );
        // Nothing is marked until an owner taps it.
        assert.deepStrictEqual(yield* owed(), ["owed", "owed", "owed"]);

        // A teammate's tap is refused: only an owner or co-owner marks a partner repaid.
        const plan = (yield* plansOf(orgId, fresh!)).get("option-1")!;
        const refused = yield* CardActions.run(
          {
            orgId,
            widget: yield* kin.widget(fresh),
            personId: KinPersonId.make("dev"),
            memberId: KinMemberId.make("dev-member"),
            now: MON,
          },
          plan,
          { records, chat: kin.chats },
        ).pipe(Effect.flip);
        assert.include(refused, { reason: "not_allowed" });
        assert.deepStrictEqual(yield* owed(), ["owed", "owed", "owed"]);

        // Finance was told; a card drawn before an expense was edited marks nothing, and the fact is
        // told again on the next pass.
        assert.include((yield* withKin(KinPulse.tick(orgId, MON))).woken, factKey);
        yield* sql`UPDATE kin_events SET state = 'done'
        WHERE org_id = ${orgId} AND dedupe_key LIKE 'repaid_seen:%'`;
        const edited = yield* records.update(orgId, ownerWrites, second.key, {
          notes: "Receipt in the shared drive.",
        });
        yield* kin.tap(owner, stale, "option-1", "repaid-stale");
        assert.deepStrictEqual(card(yield* kin.widget(stale)).outcome, {
          title: "Nothing was done",
          text: `${bank.key} or an expense it repays changed since this was offered, so nothing was done.`,
        });
        assert.deepStrictEqual(yield* owed(), ["owed", "owed", "owed"]);
        assert.strictEqual((yield* records.get(orgId, bank.key))!.state, "open");
        assert.include((yield* withKin(KinPulse.tick(orgId, MON + 60_000))).woken, factKey);
        assert.isAbove(edited.rev, second.rev);

        // Cards drawn before the edit are stale too; a fresh one marks all three, as Rhea.
        yield* kin.tap(owner, fresh, "option-1", "repaid-old");
        assert.strictEqual(card(yield* kin.widget(fresh)).outcome?.title, "Nothing was done");
        const now = yield* ask(bank.key, "Is this Zoya's repayment after all?");
        const tapped = yield* kin.tap(owner, now.value.widgetId, "option-1", "repaid-1");
        assert.deepInclude(JSON.parse(tapped.body), { handled: true });
        assert.deepStrictEqual(card(yield* kin.widget(now.value.widgetId)).outcome, {
          title: "Marked repaid",
          text: `${first.key}, ${second.key} and ${third.key} are repaid on 15 Nov by ${bank.key}, which is explained in Bank transactions. Nothing more is owed to Zoya Rao.`,
        });
        for (const one of [first, second, third]) {
          const row = (yield* records.get(orgId, one.key))!;
          assert.deepInclude(parseFields(row.fieldsJson), {
            fundedBy: "person:zoya",
            reimbursement: "repaid",
            repaidOn: "2026-11-15",
          });
          assert.deepStrictEqual([row.amountMinor, row.state], [one.amountMinor, "done"]);
        }
        const explained = (yield* records.get(orgId, bank.key))!;
        assert.deepStrictEqual([explained.state, explained.category], ["done", "expense"]);
        const links = yield* sql<{ from: string; to: string }>`SELECT record_id AS "from",
          target AS "to" FROM kin_record_links
        WHERE org_id = ${orgId} AND kind = 'record' ORDER BY record_id, target`;
        assert.sameDeepMembers(
          links.filter((one) => [one.from, one.to].includes(bank.recordId)),
          [first, second, third].flatMap((one) => [
            { from: one.recordId, to: bank.recordId },
            { from: bank.recordId, to: one.recordId },
          ]),
        );
        // The writes are Rhea's, from her tap.
        const [change] = yield* sql<{ kind: string; id: string }>`SELECT actor_kind AS kind,
          actor_id AS id FROM kin_record_changes
        WHERE org_id = ${orgId} AND record_id = ${third.recordId} ORDER BY seq DESC LIMIT 1`;
        assert.deepStrictEqual(change, { kind: "person", id: owner.personId });
        assert.notInclude(yield* told, factKey);
        // Another open card for the debit closes with it explained, and its tap is refused.
        assert.isNotNull((yield* kin.widget(later)).closedAt);
        const late = yield* kin.tap(owner, later, "option-1", "repaid-2").pipe(Effect.flip);
        assert.include(late, { reason: "widget_changed" });
      }).pipe(Effect.provide(layer)),
    ),
);

// The production layer attaches both of a choice card's callbacks to `act`: a Confirm refused for
// its sent-mail tick redraws that card once with the warning, and only that refusal does.
it.effect("a Confirm refused for its sent-mail tick redraws that card once, with the tick", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql, chats } = kin;
      const connections = Context.get(kin.services, KinConnections);
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fake = makeFakeMail(fileStore(`${stateDir}/kin-fake-mail.json`));
      yield* Effect.gen(function* () {
        yield* kin.turn("chief", kin.chatOf("chief"), "Send Ravi the invoice, and Zoya the plan");
        const draft = (to: string, subject: string) =>
          Effect.gen(function* () {
            yield* connections.call(scopeOf("chief"), {
              connection: HELLO,
              tool: "mail_send",
              arguments: { to: [to], subject, body: `${subject}, attached.` },
            });
            const [row] = yield* sql<{ askId: string; widgetId: string }>`SELECT ask_id AS "askId",
                widget_id AS "widgetId" FROM kin_connection_asks ORDER BY rowid DESC LIMIT 1`;
            return row!;
          });
        const first = yield* draft("ravi@lumen.example", "Invoice");
        const retry = yield* draft("ravi@lumen.example", "Invoice again");
        const other = yield* draft("zoya@lumen.example", "Plan");
        // The first try ended with no clear answer after the retry's card was drawn: it shows no
        // warning, as a card drawn while that try was sending does.
        yield* sql`UPDATE kin_connection_asks SET state = 'failed', done_at = ${MON},
            result_json = '{"mayHaveGone":true}' WHERE ask_id = ${first.askId}`;
        yield* sql`UPDATE kin_connection_asks SET result_json = ${JSON.stringify({ after: first.askId })}
            WHERE ask_id = ${retry.askId}`;
        const gone = { tryId: first.askId, at: DateTime.formatIso(DateTime.makeUnsafe(MON)) };
        const confirmOf = (widget: { readonly state: unknown }) =>
          card(widget).options.find((option) => option.kind === "yes")!.optionId;
        const press = (
          who: { readonly _tag: "person"; readonly personId: KinPersonId },
          widgetId: string,
          clientActionId: string,
          checkedSent?: typeof gone,
          revision?: number,
        ) =>
          kin.widget(widgetId).pipe(
            Effect.flatMap((shown) =>
              chats.act(
                { ...who, orgId },
                {
                  widgetId: shown.widgetId,
                  revision: revision ?? shown.revision,
                  actionId: "choose",
                  value: confirmOf(shown),
                  clientActionId,
                  ...(checkedSent === undefined ? {} : { checkedSent }),
                },
              ),
            ),
          );
        const shown = (widgetId: string) =>
          kin.widget(widgetId).pipe(
            Effect.map((one) => ({
              revision: one.revision,
              mayHaveGone: (one.state as { send?: { mayHaveGone?: unknown } }).send?.mayHaveGone,
            })),
          );
        const askState = (askId: string) =>
          sql<{
            state: string;
          }>`SELECT state FROM kin_connection_asks WHERE ask_id = ${askId}`.pipe(
            Effect.map(([one]) => one!.state),
          );
        const before = yield* shown(retry.widgetId);
        const untouched = yield* shown(other.widgetId);
        assert.isUndefined(before.mayHaveGone);

        // A non-member's press and a press on an outdated revision redraw nothing.
        yield* press(kin.person("dev"), retry.widgetId, "dev-press").pipe(Effect.flip);
        yield* press(owner, retry.widgetId, "stale-press", undefined, before.revision + 5).pipe(
          Effect.flip,
        );
        assert.deepStrictEqual(yield* shown(retry.widgetId), before);

        // Unticked: refused, sends nothing, and the card is redrawn once with the warning.
        assert.deepInclude(yield* press(owner, retry.widgetId, "press-1").pipe(Effect.flip), {
          reason: "conflict",
          message: NOT_CHECKED,
        });
        const warned = yield* shown(retry.widgetId);
        assert.deepStrictEqual(warned, { revision: before.revision + 1, mayHaveGone: gone });
        assert.strictEqual(yield* askState(retry.askId), "open");
        assert.lengthOf(fake.sent(), 0);
        assert.deepStrictEqual(yield* shown(other.widgetId), untouched);
        // Unticked again at the new revision: refused, and no second redraw.
        assert.deepInclude(yield* press(owner, retry.widgetId, "press-2").pipe(Effect.flip), {
          message: NOT_CHECKED,
        });
        assert.deepStrictEqual(yield* shown(retry.widgetId), warned);
        // Ticked for that try: the Confirm counts, and its one send is on its way.
        yield* press(owner, retry.widgetId, "press-3", gone);
        assert.strictEqual(yield* askState(retry.askId), "sending");
        assert.lengthOf(fake.sent(), 0);
        assert.deepStrictEqual(yield* shown(other.widgetId), untouched);
      });
    }).pipe(Effect.provide(layerOver(true))),
  ),
);
