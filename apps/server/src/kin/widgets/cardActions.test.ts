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
  KinMemoryItemId,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Questions from "../questions/openQuestions.ts";
import * as Team from "../team/KinTeam.ts";
import {
  KinDeferralStopSwitch,
  deferralTriggerId,
  makeDeferralCards,
} from "../triggers/deferrals.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { presetDefinition, propose } from "../work/registers.ts";

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
  readonly outcome?: { readonly title: string; readonly text: string };
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
      // The agent learns the card, never its plan.
      assert.deepStrictEqual(Object.keys(asked.value).toSorted(), [
        "by",
        "messageId",
        "question",
        "widgetId",
      ]);
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
    }).pipe(Effect.provide(layer)),
  ),
);

// The plan binds the entry's revision: a change in the same clock tick, a retired drawer or a
// reaction runs nothing; the timer never takes an action as a default; another org's key is unknown.
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

      // Its default is the action: at its day it is raised again, never taken.
      yield* kin.turn("finance", kin.chatOf("finance"), "And the proposal?");
      const daily = yield* callAs("finance", "kin_ask", {
        ...closeIt(timed.key),
        default: "Close it",
      });
      assert.isTrue(daily.ok, JSON.stringify(daily.value));
      const due = Date.parse(daily.value.by as string);
      yield* TestClock.setTime(due + 60_000);
      yield* Questions.settleDue(orgId, due + 60_000, {
        chat: kin.chats,
        queue: Context.get(kin.services, KinEventQueue.KinEventQueue),
      });
      assert.notStrictEqual(
        (yield* Questions.readQuestion(orgId, daily.value.question as string))?.state,
        "default_taken",
      );
      assert.strictEqual((yield* kin.stateOf(timed.key)).state, "open");
      const taken = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
        AND dedupe_key LIKE 'question:%'`;
      assert.lengthOf(taken, 0);

      // Raised on its next morning, the card's action is drawn again: a tap on the raised card
      // runs it once. One whose task closed before the raise is left off, and so is the default.
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
      const question = (id: unknown) => Questions.readQuestion(orgId, id as string);
      const raiseAt = Math.max(
        (yield* question(daily.value.question))!.actAt,
        (yield* question(gone.value.question))!.actAt,
      );
      yield* TestClock.setTime(raiseAt);
      yield* Questions.settleDue(orgId, raiseAt, {
        chat: kin.chats,
        queue: Context.get(kin.services, KinEventQueue.KinEventQueue),
      });
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
      assert.deepStrictEqual(yield* kin.stateOf(timed.key), { state: "done", rev: timed.rev + 1 });
      const again = yield* kin.tap(owner, raised.raiseWidgetId, "option-1", "raised-again");
      assert.strictEqual(again.messageId, ran.messageId);
      assert.strictEqual((yield* kin.stateOf(timed.key)).rev, timed.rev + 1);
      const without = (yield* question(gone.value.question))!;
      assert.isNull(without.defaultLabel);
      assert.deepStrictEqual(card(yield* kin.widget(without.raiseWidgetId)).options, [
        { optionId: "option-1", label: "Not yet" },
        { optionId: "option-2", label: "Ask me Friday" },
      ]);
      const plain = JSON.stringify((yield* kin.widget(without.raiseWidgetId)).state);
      assert.notInclude(plain, `Mark ${shut.key}`);
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
