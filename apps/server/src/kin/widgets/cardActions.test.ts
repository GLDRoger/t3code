import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  KinMemberId,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
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
      assert.deepStrictEqual(card(drawn).options[0], {
        optionId: "option-1",
        label: "Mark it done",
        action: { line },
      });
      // An older client that only reads the card's text still sees what the tap does.
      assert.include(card(drawn).detail, `Mark it done: ${line}`);
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

// "Take the default" binds the question's default option by id and runs its sealed action; a
// list proposal is created from the definition as drawn, and a name taken since creates nothing.
it.effect("take the default runs the default's own action; a list is made as proposed", () =>
  Effect.andThen(
    TestClock.setTime(MON),
    Effect.gen(function* () {
      const kin = yield* ambermill;
      const { owner, orgId, sql } = kin;
      const row = yield* kin.task("File the GST return");
      yield* kin.turn("finance", kin.chatOf("finance"), "Is the return filed?");
      const question = yield* callAs("finance", "kin_ask", {
        ...closeIt(row.key),
        default: "Close it",
      });
      assert.isTrue(question.ok, JSON.stringify(question.value));
      yield* kin.turn("finance", kin.chatOf("finance"), "Remind me what you asked.");
      const nudge = yield* callAs("finance", "kin_ask", {
        question: "Still open from earlier.",
        options: [
          {
            label: "Go with it",
            action: { kind: "take_default", target: question.value.question },
          },
          { label: "Later" },
        ],
        default: "none",
      });
      assert.isTrue(nudge.ok, JSON.stringify(nudge.value));
      assert.strictEqual(
        card(yield* kin.widget(nudge.value.widgetId)).options[0]?.action?.line,
        `Go with “Close it” on “${row.key} looks finished. Close it?”: Mark ${row.key} “File the GST return” done`,
      );
      const went = yield* kin.tap(owner, nudge.value.widgetId, "option-1", "go");
      assert.deepInclude(JSON.parse(went.body), { handled: true });
      assert.strictEqual((yield* kin.stateOf(row.key)).state, "done");
      assert.strictEqual(
        (yield* Questions.readQuestion(orgId, question.value.question as string))?.state,
        "answered",
      );
      assert.isNotNull((yield* kin.widget(question.value.widgetId)).closedAt);

      const turn = yield* kin.turn("finance", kin.chatOf("finance"), "Track vendors for me.");
      const proposal = (id: string, name: string) =>
        propose({
          orgId,
          agentId: "finance",
          wakeupId: turn,
          chatId: kin.chatOf("finance"),
          proposal: {
            _tag: "new",
            id,
            name,
            prefix: id.slice(0, 3).toUpperCase(),
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
      yield* kin.tap(owner, vendors.value.widgetId, "option-1", "vendors");
      const made = yield* sql<{ name: string }>`SELECT name FROM kin_registers
        WHERE org_id = ${orgId} AND register_id = 'vendors'`;
      assert.deepStrictEqual(made, [{ name: "Vendors" }]);

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
    }).pipe(Effect.provide(layer)),
  ),
);
