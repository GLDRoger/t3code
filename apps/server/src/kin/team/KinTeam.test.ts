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
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
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
import { agentServices } from "../mcp/KinChatToolkit.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import { wakeEvent } from "../lead/ChatWake.ts";
import * as Handoff from "../lead/Handoff.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import type { KinDecision } from "../memory/MemoryWriter.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import { laneFor } from "../reply/replyLane.ts";
import * as Team from "./KinTeam.ts";
import { teamTurnFacts } from "./prompt.ts";

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
 * Ambermill Studio (invented): Rhea owns it, Meera co-owns it, Dev is a member. Four agents:
 * the Chief of staff (the team agent), Finance, Social and Growth, each with a chat with Rhea.
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
  const person = (id: string) => ({
    _tag: "person" as const,
    orgId,
    personId: KinPersonId.make(id),
  });
  const chatOf = new Map<string, KinChatId>();
  for (const [id, name, domain] of [
    ["chief", "Chief of staff", "chief-of-staff"],
    ["finance", "Finance", "finance"],
    ["social", "Social", "social"],
    ["growth", "Growth", "growth"],
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
  return { sql, chats, owner, orgId, person, chatOf: (id: string) => chatOf.get(id)!, wake };
});

const roomRows = (sql: SqlClient.SqlClient, orgId: string) =>
  sql<{ author: string | null; intent: string | null; body: string }>`SELECT l.name AS author,
      m.intent, m.body FROM kin_messages m
    JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id AND c.team_id = 'team-room'
    LEFT JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.author_agent_id
    WHERE m.org_id = ${orgId} AND m.status = 'posted' ORDER BY m.seq`;
const teamWakes = (sql: SqlClient.SqlClient, orgId: string) =>
  sql<{ agent: string; key: string; priority: string }>`SELECT agent_id AS agent,
      dedupe_key AS key, priority FROM kin_events
    WHERE org_id = ${orgId} AND dedupe_key LIKE 'team:%' ORDER BY rowid`;
const discussion = (sql: SqlClient.SqlClient, orgId: string) =>
  sql<{ state: string; final: number; told: number | null; turn: string | null }>`SELECT state,
      final, told_at AS told, turn_json AS turn FROM kin_discussions
    WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1`.pipe(Effect.map((rows) => rows[0]!));
const relayed = (sql: SqlClient.SqlClient, orgId: string, chatId: KinChatId) =>
  sql<{
    body: string;
    relay: string | null;
    discussion: string | null;
    silent: number;
  }>`SELECT body,
      relay_json AS relay, discussion_id AS discussion, silent FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = ${chatId} AND relay_json IS NOT NULL ORDER BY seq`;

// conversations.md, the brochure: Rhea asks Social to settle the print run with the team. Social
// opens it naming Finance, whose call it is; Growth pitches in uninvited; Finance widens the
// question once and decides; Growth objects once; Finance decides again; Rhea hears it in one
// line in Social's chat, once, with what was changed.
it.effect("a discussion the owner asked for runs its turns, ends, and is told once", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, person, chatOf, wake } = yield* ambermill;
      // What memory is asked to save; the writer itself is MemoryWriter's to test.
      const decisions: Array<KinDecision> = [];
      const saved = yield* Deferred.make<void>();
      yield* Context.get(
        Option.getOrThrow((yield* Kin.KinServer).services),
        KinMemoryChanges,
      ).attachWriter({
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
      const ask = yield* chats.send(owner, {
        chatId: chatOf("social"),
        body: "Settle the brochure print run with the team.",
        clientMessageId: "ask",
      });
      yield* wake("social", ask);
      // No discussion is open yet: the refusal names the tool that starts one.
      const none = yield* callAs("social", "team_say", { text: "Hi", intent: "answer" });
      assert.isFalse(none.ok);
      assert.include(JSON.stringify(none.value), "No Team-room discussion is open. team_open");
      const opened = yield* callAs("social", "team_open", {
        topic: "Brochure print run",
        question: "How many brochures do we print for the Kochi expo?",
        decider: "Finance",
        text: "The printer quotes ₹38 a copy for 400. I'd print 400 for the expo stand.",
      });
      assert.isTrue(opened.ok, JSON.stringify(opened.value));
      assert.deepStrictEqual(opened.value, {
        discussion: "TD-1",
        next: "Finance",
        state: "open",
      });
      // Finance is woken first; nobody else is, and nothing rings.
      assert.deepStrictEqual(
        (yield* teamWakes(sql, orgId)).map(({ agent, priority }) => [agent, priority]),
        [["finance", "P1"]],
      );
      // Finance's chat shows the request on Rhea's side, sent by Social.
      const sent = yield* relayed(sql, orgId, chatOf("finance"));
      assert.lengthOf(sent, 1);
      assert.include(sent[0]!.body, "How many brochures do we print for the Kochi expo?");
      assert.deepStrictEqual(JSON.parse(sent[0]!.relay!), { kind: "sent_by", agentId: "social" });
      assert.strictEqual(sent[0]!.silent, 1);
      // Where Rhea asked, one quiet line says the discussion started and names it.
      const started = yield* sql<{ body: string; discussion: string; silent: number }>`SELECT body,
          discussion_id AS discussion, silent FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${chatOf("social")} AND discussion_id IS NOT NULL
          AND relay_json IS NULL ORDER BY seq`;
      assert.deepStrictEqual(started, [
        {
          body: "Started a Team room discussion: Brochure print run",
          discussion: "TD-1",
          silent: 1,
        },
      ]);

      // Not Finance's turn yet for Growth: refused, and nothing posts.
      yield* wake("growth");
      const early = yield* callAs("growth", "team_say", { text: "Hi", intent: "answer" });
      assert.isFalse(early.ok);
      assert.include(
        JSON.stringify(early.value),
        "It isn't your turn in any Team-room discussion.",
      );

      yield* wake("finance");
      const answer = yield* callAs("finance", "team_say", {
        text: "₹15,200 for 400 is over the ₹12,000 print budget. 300 copies fit at ₹11,400.",
        intent: "answer",
      });
      assert.isTrue(answer.ok, JSON.stringify(answer.value));
      // Social answers (it spoke last); Growth, whose lane "expo" leads touch, may pitch in once.
      const keys = (yield* teamWakes(sql, orgId)).map(({ key }) => key);
      assert.match(keys.at(-1)!, /^team:TD-1:\d+:social:named$/);

      yield* wake("social");
      const back = yield* callAs("social", "team_say", {
        text: "300 runs out by day two; the expo has 900 visitors and our leads come from it.",
        intent: "objection",
      });
      assert.isTrue(back.ok, JSON.stringify(back.value));
      const pitched = (yield* teamWakes(sql, orgId)).filter(({ key }) => /:pitch_in$/.test(key));
      assert.lengthOf(pitched, 1);
      assert.strictEqual(pitched[0]!.agent, "growth");
      assert.strictEqual(pitched[0]!.priority, "P2");

      // Growth, uninvited, pitches in first; then the decider answers and widens the question.
      assert.match(JSON.parse((yield* discussion(sql, orgId)).turn!).kind, /^pitch_in$/);
      yield* wake("growth");
      const pitch = yield* callAs("growth", "team_say", {
        text: "Last expo, 40 of 60 leads took a brochure. 400 is right.",
        intent: "answer",
      });
      assert.isTrue(pitch.ok, JSON.stringify(pitch.value));
      let holder = JSON.parse((yield* discussion(sql, orgId)).turn!) as { agentId: string };
      assert.strictEqual(holder.agentId, "finance");
      yield* wake("finance");
      const widened = yield* callAs("finance", "team_say", {
        text: "Then the question is the budget, not the count.",
        intent: "answer",
        widen: "Do we raise the expo print budget, and to how much?",
      });
      assert.isTrue(widened.ok, JSON.stringify(widened.value));
      // Widened once: a second widening is refused whoever holds the turn.
      holder = JSON.parse((yield* discussion(sql, orgId)).turn!) as { agentId: string };
      yield* wake(holder.agentId);
      const again = yield* callAs(holder.agentId, "team_say", {
        text: "Widening twice.",
        intent: "answer",
        widen: "Something else",
      });
      assert.isFalse(again.ok);

      // Growth answers the wider question, to Finance by name; Finance decides.
      assert.strictEqual(holder.agentId, "growth");
      const raise = yield* callAs("growth", "team_say", {
        text: "Raise it to ₹15,200: one extra client from the expo pays for it ten times over.",
        intent: "answer",
        to: ["Finance"],
      });
      assert.isTrue(raise.ok, JSON.stringify(raise.value));
      // Finance's deciding turn raises the budget: Kin's record of changes, not its own list.
      const deciding = yield* passedTurn(sql, orgId, "finance", yield* wake("finance"));
      yield* sql`INSERT OR IGNORE INTO kin_registers (org_id, register_id, name, key_prefix,
          built_in, created_at) VALUES (${orgId}, 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'w-budget', 'work', 'W-90', 'Raise the expo print budget to ₹15,200',
          'agent', 'finance', 0, 'agent', 'w-budget', 0, 0)`;
      yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id,
          via, kind, fields_json, wakeup_id)
        VALUES (${orgId}, 'w-budget', 1, 0, 'agent', 'finance', 'lead', 'created', '{}', ${deciding})`;
      const decided = yield* callAs("finance", "team_say", {
        text: "Raise the print budget to ₹15,200 and print 400.",
        intent: "decision",
        end: "decide",
        outcome: "Print 400 brochures for the Kochi expo; print budget raised to ₹15,200.",
      });
      assert.isTrue(decided.ok, JSON.stringify(decided.value));
      const objector = JSON.parse((yield* discussion(sql, orgId)).turn!) as {
        agentId: string;
        kind: string;
      };
      assert.strictEqual(objector.kind, "object");
      // Decided but open to its one objection: the room's messages still say it is going.
      const [roomNow] = yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId"
        FROM kin_chats WHERE org_id = ${orgId} AND team_id = 'team-room'`;
      const going = (yield* chats.history(owner, {
        chatId: roomNow!.chatId,
        beforeSeq: 1_000,
        limit: 100,
      })).messages.filter((message) => message.discussionId === "TD-1");
      assert.isNotEmpty(going);
      assert.isTrue(going.every((message) => message.discussionOpen === true));
      yield* wake(objector.agentId);
      const objected = yield* callAs(objector.agentId, "team_say", {
        text: "Fine on count, but book the printer by Friday or the price goes up.",
        intent: "objection",
      });
      assert.isTrue(objected.ok, JSON.stringify(objected.value));
      // Nobody objects twice: the objection is spent.
      for (let i = 0; i < 4 && (yield* discussion(sql, orgId)).final === 0; i++) {
        const holder = JSON.parse((yield* discussion(sql, orgId)).turn!) as { agentId: string };
        yield* wake(holder.agentId);
        const said = yield* callAs(holder.agentId, "team_say", {
          text: "Booking the printer for Thursday. Decided.",
          intent: "decision",
          end: "decide",
          outcome:
            "Print 400 brochures for the Kochi expo, printer booked for Thursday; budget ₹15,200.",
        });
        if (!said.ok) {
          yield* (yield* Team.KinTeam).wakeupEnded({
            orgId,
            agentId: KinAgentId.make(holder.agentId),
            wakeupId: yield* passedTurn(sql, orgId, holder.agentId, yield* wake(holder.agentId)),
          });
        }
      }
      const ended = yield* discussion(sql, orgId);
      assert.strictEqual(ended.state, "decided");
      assert.isNotNull(ended.told);
      // Saved to memory once, in the discussion's own words: no model wrote it.
      yield* Deferred.await(saved);
      assert.lengthOf(decisions, 1);
      assert.deepInclude(decisions[0], {
        title: "Brochure print run",
        trust: "agent",
        link: "discussion:TD-1",
      });
      assert.match(
        decisions[0]!.body,
        /^Print 400 brochures for the Kochi expo, printer booked for Thursday; budget ₹15,200\./,
      );

      // Rhea hears it once, in Social's chat, as from the agent who answered, with what changed.
      const told = (yield* relayed(sql, orgId, chatOf("social"))).filter(
        (row) => row.discussion === "TD-1",
      );
      assert.lengthOf(told, 1);
      assert.match(told[0]!.body, /^Print 400 brochures for the Kochi expo/);
      assert.include(told[0]!.body, "Done: Raise the expo print budget to ₹15,200 (new)");
      assert.notMatch(told[0]!.body, /\bW-90\b/);
      assert.strictEqual(told[0]!.silent, 0);
      assert.strictEqual(JSON.parse(told[0]!.relay!).kind, "reply_from");

      // One message per turn, every one in the room; caps leave room.
      const rows = yield* roomRows(sql, orgId);
      assert.isAtMost(rows.length, 16);
      assert.isTrue(rows.every((row) => row.author !== null));

      // The room: Rhea and Meera read it, muted and off the badge; Dev can't, nor be added.
      const repo = Context.get(
        Option.getOrThrow((yield* Kin.KinServer).services),
        KinChatRepository,
      );
      const [room] = yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId" FROM kin_chats
        WHERE org_id = ${orgId} AND team_id = 'team-room'`;
      const page = { chatId: room!.chatId, beforeSeq: 1_000, limit: 100 };
      assert.isAbove((yield* chats.history(owner, page)).messages.length, 0);
      // The room's messages say the discussion has closed, read at the time they are read.
      assert.isTrue(
        (yield* chats.history(owner, page)).messages.every(
          (message) => message.discussionId !== "TD-1" || message.discussionOpen === false,
        ),
      );
      assert.isAbove((yield* chats.history(person("meera"), page)).messages.length, 0);
      assert.strictEqual(yield* repo.unreadTotal({ orgId, personId: owner.personId }), 1);
      const ownerList = yield* chats
        .subscribeChats([owner], { orgId })
        .pipe(Stream.take(1), Stream.runCollect);
      const listed = ownerList[0]!._tag === "snapshot" ? ownerList[0]!.chats : [];
      const roomRow = listed.find((chat) => chat.chatId === room!.chatId)!;
      assert.strictEqual(roomRow.unread, 0);
      assert.isTrue(roomRow.fresh);
      const refused = yield* Effect.flip(chats.history(person("dev"), page));
      assert.deepInclude(refused, { _tag: "KinChatError", reason: "not_found" });
      const devList = yield* chats
        .subscribeChats([person("dev")], { orgId })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.isFalse(
        (devList[0]!._tag === "snapshot" ? devList[0]!.chats : []).some(
          (chat) => chat.chatId === room!.chatId,
        ),
      );
      const groups = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinGroups);
      const added = yield* Effect.flip(
        groups.addMember([owner], {
          chatId: room!.chatId,
          principal: { _tag: "person", personId: KinPersonId.make("dev") },
        }),
      );
      assert.deepInclude(added, { _tag: "KinChatError", reason: "not_allowed" });
      // A member made a co-owner's peer by a stray membership row still can't read it.
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES ('stray-dev', ${orgId}, ${room!.chatId}, 'person', 'dev', 'member', ${at})`;
      const stray = yield* Effect.flip(chats.history(person("dev"), page));
      assert.deepInclude(stray, { _tag: "KinChatError", reason: "not_found" });
    }).pipe(Effect.provide(layer)),
  ),
);

// Rhea names Finance and the Chief of staff in the Team room: Kin opens their discussion once,
// however often the message is handled. Finance, named first, takes the first discussion turn on
// her words; the Chief of staff, whose call it is, is next. One name or none, a teammate's words,
// or a message while a discussion is open opens nothing.
it.effect("a person naming two agents in the Team room gets their discussion, opened by Kin", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, chatOf, wake } = yield* ambermill;
      const team = yield* Team.KinTeam;
      const room = (yield* team.ensureRoom(orgId)).chatId;
      const say = (body: string, clientMessageId: string) =>
        chats.send(owner, { chatId: room, body, clientMessageId });
      const discussions = sql<{ id: string; question: string; origin: string }>`SELECT
          discussion_id AS id, question, origin FROM kin_discussions WHERE org_id = ${orgId}
        ORDER BY created_at`;

      for (const [body, id] of [
        ["Finance, how much does Orbit Dental still owe us?", "one"],
        ["What should we chase this week?", "none"],
      ] as const)
        assert.isFalse(yield* team.personAsked(yield* say(body, id)));
      const ask = yield* say(
        "Finance and Chief of staff: agree in a few messages on what to chase this week.",
        "ask",
      );
      // A teammate's words never open one, whatever membership row the room lists.
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES ('stray-dev', ${orgId}, ${room}, 'person', 'dev', 'member', ${at})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at)
        VALUES ('dev-ask', ${orgId}, ${room}, 99, 'human', 'dev', 'stray-dev', 'member', 'text',
          ${ask.body}, '[]', 'posted', ${at})`;
      assert.isFalse(yield* team.personAsked({ ...ask, messageId: KinMessageId.make("dev-ask") }));
      yield* sql`DELETE FROM kin_messages WHERE message_id = 'dev-ask'`;
      yield* sql`DELETE FROM kin_chat_members WHERE member_id = 'stray-dev'`;
      assert.lengthOf(yield* discussions, 0);

      assert.isTrue(yield* team.personAsked(ask));
      assert.isTrue(yield* team.personAsked(ask));
      assert.deepStrictEqual(yield* discussions, [
        {
          id: "TD-1",
          question:
            "Finance and Chief of staff: agree in a few messages on what to chase this week.",
          origin: "owner",
        },
      ]);
      const [row] = yield* sql<{ opener: string; decider: string; pending: string }>`SELECT
          opened_by_agent_id AS opener, decider_agent_id AS decider, pending_json AS pending
        FROM kin_discussions WHERE org_id = ${orgId}`;
      assert.deepStrictEqual(
        { ...row!, pending: JSON.parse(row!.pending) },
        { opener: "finance", decider: "chief", pending: [{ agentId: "chief", kind: "named" }] },
      );
      // Finance's discussion turn, from her message, is the one wake-up; nobody relays it.
      assert.deepStrictEqual(
        (yield* teamWakes(sql, orgId)).map(({ agent, key }) => [agent, key]),
        [["finance", `team:TD-1:${ask.seq}:finance:named`]],
      );
      assert.lengthOf(yield* relayed(sql, orgId, chatOf("chief")), 0);
      const turn = yield* passedTurn(sql, orgId, "finance", yield* wake("finance"));
      assert.deepInclude(
        Option.getOrThrow(
          yield* laneFor({ orgId, agentId: KinAgentId.make("finance"), wakeupId: turn }),
        ),
        { chatId: room, team: true },
      );
      const facts = (agent: string) =>
        teamTurnFacts(orgId, agent, "TD-1").pipe(Effect.map((one) => one?.question));
      assert.strictEqual(
        yield* facts("finance"),
        "Rhea Rao asked you and Chief of staff: Finance and Chief of staff: agree in a few messages on what to chase this week.",
      );
      assert.match((yield* facts("chief"))!, /^Rhea Rao asked you and Finance: Finance and/);

      // Finance opening one of her own for the same ask is turned back to the open one.
      const second = yield* callAs("finance", "team_open", {
        topic: "What to chase this week",
        question: "What do we chase this week?",
        decider: "Chief of staff",
        text: "Orbit Dental first.",
      });
      assert.isFalse(second.ok);
      assert.match(String(second.value.message ?? JSON.stringify(second.value)), /TD-1.*team_say/);
      assert.lengthOf(yield* discussions, 1);

      const spoke = yield* callAs("finance", "team_say", {
        text: "Orbit Dental first: ₹47,200, 11 days late.",
        intent: "answer",
      });
      assert.isTrue(spoke.ok, JSON.stringify(spoke.value));
      assert.strictEqual(spoke.value.next, "Chief of staff");
      assert.match((yield* teamWakes(sql, orgId)).at(-1)!.key, /^team:TD-1:\d+:chief:decider$/);

      // While it is open, her next message naming two agents is an ordinary message, as before,
      // and stays one when handled again after the discussion ends (the model check found it).
      const note = yield* say("Finance and Social: what does the brochure cost?", "note");
      assert.isFalse(yield* team.personAsked(note));
      yield* (yield* KinEventQueue).enqueue(wakeEvent(note, KinAgentId.make("chief"), undefined));
      yield* sql`UPDATE kin_discussions SET final = 1, state = 'parked' WHERE org_id = ${orgId}`;
      assert.isFalse(yield* team.personAsked(note));
      assert.lengthOf(yield* discussions, 1);
    }).pipe(Effect.provide(layer)),
  ),
);

/** Marks the turn event `holder` holds as run by `wakeupId`, as claiming it would. */
const passedTurn = Effect.fn("test.passedTurn")(function* (
  sql: SqlClient.SqlClient,
  orgId: string,
  holder: string,
  wakeupId: string,
) {
  yield* sql`UPDATE kin_events SET wakeup_id = ${wakeupId}
    WHERE org_id = ${orgId} AND event_id = (SELECT json_extract(turn_json, '$.eventId')
      FROM kin_discussions WHERE org_id = ${orgId} AND final = 0
        AND json_extract(turn_json, '$.agentId') = ${holder} LIMIT 1)`;
  return KinWakeupId.make(wakeupId);
});

// Agents start at most two at once and six a day; one started by an agent waits for the owner's
// next check-in to be told, and then is told once, silently, beside it. Its disagreement card
// waits too, and with no check-in set the sweep brings it outside his quiet hours.
it.effect("an agent-started discussion is capped, held, and told at the owner's next note", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, chatOf, wake } = yield* ambermill;
      // 06:00 UTC is 11:30 for Ambermill, outside Rhea's quiet hours on any host clock.
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00',
          '02:00', 0, 1, '09:00', '{}')
        ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
      yield* wake("growth");
      for (const topic of ["Expo stand size", "Kochi hotel"]) {
        const opened = yield* callAs("growth", "team_open", {
          topic,
          question: `${topic}: which option?`,
          decider: "Chief of staff",
          text: "Two options; I lean to the cheaper.",
        });
        assert.isTrue(opened.ok, JSON.stringify(opened.value));
      }
      const third = yield* callAs("growth", "team_open", {
        topic: "Lanyards",
        question: "Do we print lanyards?",
        decider: "Social",
        text: "Thoughts?",
      });
      assert.isFalse(third.ok);
      assert.match(String(third.value.message ?? JSON.stringify(third.value)), /open|two/i);

      // The chair parks the first at its closing turn: the owner isn't told yet.
      const [first] = yield* sql<{ id: string }>`SELECT discussion_id AS id FROM kin_discussions
        WHERE org_id = ${orgId} ORDER BY created_at LIMIT 1`;
      yield* sql`UPDATE kin_discussions SET state = 'closing',
          turn_json = json_object('agentId', 'chief', 'kind', 'closing', 'eventId', NULL,
            'said', json('false'))
        WHERE org_id = ${orgId} AND discussion_id = ${first!.id}`;
      yield* wake("chief");
      const parked = yield* callAs("chief", "team_say", {
        discussion: first!.id,
        text: "Parking this until the floor plan is in.",
        intent: "decision",
        end: "park",
        outcome: "Stand size waits for the floor plan; default 3×3 m, decided by Thursday.",
      });
      assert.isTrue(parked.ok, JSON.stringify(parked.value));
      const held = yield* relayed(sql, orgId, chatOf("growth"));
      assert.lengthOf(held, 0);

      // The next check-in runs: the parked outcome is told beside it, silently, once.
      const checkIn = yield* startAgentWakeup({
        orgId,
        agentId: KinAgentId.make("chief"),
        threadId: ThreadId.make("chief-thread"),
        event: (base) => ({
          ...base,
          _tag: "pulse",
          provenance: { _tag: "system" },
          factKeys: [],
          checkIn: {
            scheduleId: KinMemoryItemId.make("morning-check-in"),
            title: "Morning check-in",
            what: "",
            slot: "d",
          },
        }),
      });
      const team = yield* Team.KinTeam;
      yield* team.wakeupEnded({ orgId, agentId: KinAgentId.make("chief"), wakeupId: checkIn });
      yield* team.wakeupEnded({ orgId, agentId: KinAgentId.make("chief"), wakeupId: checkIn });
      const told = yield* relayed(sql, orgId, chatOf("growth"));
      assert.lengthOf(told, 1);
      assert.match(told[0]!.body, /^Parked: Stand size waits for the floor plan/);
      assert.strictEqual(told[0]!.silent, 1);

      // The second comes to a disagreement: its card waits, then the sweep posts it, once.
      const [second] = yield* sql<{ id: string }>`SELECT discussion_id AS id FROM kin_discussions
        WHERE org_id = ${orgId} AND final = 0 ORDER BY created_at LIMIT 1`;
      yield* sql`UPDATE kin_discussions SET state = 'closing',
          turn_json = json_object('agentId', 'chief', 'kind', 'closing', 'eventId', NULL,
            'said', json('false'))
        WHERE org_id = ${orgId} AND discussion_id = ${second!.id}`;
      yield* wake("chief");
      const brought = yield* callAs("chief", "team_say", {
        discussion: second!.id,
        text: "This one is Rhea's: the budget.",
        intent: "decision",
        end: "bring",
        outcome: "Growth and Finance split on the Kochi hotel.",
        positions: [
          { agent: "Growth", position: "The expo hotel: walk to the stand." },
          { agent: "Finance", position: "The cheaper one across town." },
        ],
        lean: "The cheaper one; the stand opens at ten.",
        options: ["Expo hotel", "Across town"],
      });
      assert.isTrue(brought.ok, JSON.stringify(brought.value));
      const cards = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_widgets
        WHERE org_id = ${orgId} AND chat_id = ${chatOf("chief")} AND type = 'choice'`;
      assert.strictEqual((yield* cards)[0]!.n, 0);
      yield* team.sweep();
      yield* team.sweep();
      assert.strictEqual((yield* cards)[0]!.n, 1);

      // Past 80% of the Team room's share of today's budget, an agent opens nothing; a person's ask
      // naming two agents still opens.
      const spent = yield* wake("growth");
      yield* sql`UPDATE kin_events SET wakeup_id = ${spent} WHERE org_id = ${orgId}
        AND event_id = (SELECT event_id FROM kin_events WHERE org_id = ${orgId}
          AND dedupe_key LIKE 'team:%' ORDER BY rowid LIMIT 1)`;
      yield* sql`INSERT INTO kin_budget_limits VALUES (${orgId}, '{"leadUnits":100}')
        ON CONFLICT (org_id) DO UPDATE SET limits_json = excluded.limits_json`;
      yield* sql`INSERT INTO kin_budget (org_id, day) VALUES (${orgId}, '2026-11-16')
        ON CONFLICT DO NOTHING`;
      yield* sql`INSERT INTO kin_budget_charges (org_id, wakeup_id, day, units, tokens_json)
        VALUES (${orgId}, ${spent}, '2026-11-16', ${100 * 0.3 * 0.8}, '{}')`;
      const late = yield* callAs("growth", "team_open", {
        topic: "Lanyards",
        question: "Do we print lanyards?",
        decider: "Social",
        text: "Thoughts?",
      });
      assert.isFalse(late.ok);
      assert.include(JSON.stringify(late.value), "only discussions the owner asks for open");
      const ask = yield* chats.send(owner, {
        chatId: (yield* team.ensureRoom(orgId)).chatId,
        body: "Social and Finance: settle the lanyard order between you.",
        clientMessageId: "lanyards",
      });
      assert.isTrue(yield* team.personAsked(ask));
    }).pipe(Effect.provide(layer)),
  ),
);

// An agent's words outside the Team room still wake no other agent: the group-chat rule.
it.effect("an agent's message outside the Team room wakes no other agent", () =>
  Effect.andThen(
    TestClock.setTime(Date.UTC(2026, 10, 16, 6)),
    Effect.gen(function* () {
      const { sql, chats, owner, orgId, chatOf, wake } = yield* ambermill;
      yield* wake(
        "social",
        yield* chats.send(owner, {
          chatId: chatOf("social"),
          body: "Does Finance know the print budget?",
          clientMessageId: "budget",
        }),
      );
      const { agent, post } = yield* agentServices.pipe(
        Effect.provideService(McpInvocationContext, scopeOf("social")),
      );
      yield* post(agent, {
        chatId: chatOf("social"),
        body: "Finance, what's the print budget?",
        intent: "answer",
        clientMessageId: "to-finance",
      });
      const others = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
        AND agent_id <> 'social' AND tag = 'chat.message'`;
      assert.lengthOf(others, 0);
    }).pipe(Effect.provide(layer)),
  ),
);
