import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "./layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinChatId,
  type KinEvent,
  KinMemoryItemId,
  type KinOrgId,
  type KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import type { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import { deferralOrigin } from "../triggers/deferralOrigin.ts";
import { SHARED_REFUSAL, recordAudience, turnAudience } from "./Audience.ts";
import * as Handoff from "./Handoff.ts";
import * as KinLevels from "./KinLevels.ts";

const at = "1970-01-01T00:00:00.000Z";
const chief = KinAgentId.make("chief");
const tech = KinAgentId.make("tech");
const models = JSON.stringify({
  strong: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex" },
  cheap: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1-codex-mini" },
});
const scopeFor = (agentId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agentId}-thread`),
    providerSessionId: `${agentId}-session`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
});

/** The owner's Chief of staff and Tech lead, each with its direct chat; the owner has just asked the Chief of staff something. */
const setup = Effect.gen(function* () {
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
  const { orgId } = owner;
  /** A lead of `ownerPersonId` with a running wake-up, so its tools answer. */
  const addLead = Effect.fn("HandoffTest.addLead")(function* (
    agentId: KinAgentId,
    name: string,
    domain: string,
    createdAt = at,
  ) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, ${name}, 'lead', ${owner.personId}, ${createdAt})`;
    const chat = yield* chats.createDirect(owner, { orgId, agentId });
    const threadId = ThreadId.make(`${agentId}-thread`);
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id, domain, charter)
      VALUES (${agentId}, ${orgId}, ${name}, 'L0', 0, ${threadId}, ${models}, '[]', ${chat.chatId}, ${domain}, ${`Owns ${domain}.`})`;
    yield* identity.registerAgentThread({ orgId, agentId, threadId });
    const run = yield* startWakeupRun(threadId, `${agentId}-wake`);
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids)
      VALUES (${`${agentId}-wake`}, ${orgId}, ${agentId}, ${threadId}, ${run.id}, 'test', 0, 'running', '[]')`;
    return chat.chatId;
  });
  const chiefChat = yield* addLead(chief, "Chief of staff", "chief-of-staff");
  const techChat = yield* addLead(tech, "Tech lead", "engineering", "1970-01-01T00:00:01.000Z");
  const message = yield* chats.send(owner, {
    chatId: chiefChat,
    body: "Why is CI red on the app repo?",
    clientMessageId: "ask",
  });
  /** The event a message in `chatId` becomes for `agentId`, claimed by its running wake-up. */
  const claim = Effect.fn("HandoffTest.claim")(function* (
    eventId: string,
    agentId: KinAgentId,
    event: Record<string, unknown>,
  ) {
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES (${eventId}, ${orgId}, ${agentId}, 'chat.message', 'P0', ${JSON.stringify({
        _tag: "chat.message",
        orgId,
        agentId,
        eventId,
        receivedAt: at,
        dedupeKey: null,
        provenance: message.author,
        chatId: chiefChat,
        messageId: message.messageId,
        ...event,
      })}, 0, 0, 'claimed', ${`${agentId}-wake`})`;
    // As building the prompt for what it claimed records it.
    const turn = { orgId, agentId, wakeupId: `${agentId}-wake` };
    yield* recordAudience(turn, yield* turnAudience(turn));
  });
  yield* claim("ask-event", chief, {});
  return { services, sql, orgId, owner, chats, chiefChat, techChat, message, claim, addLead };
});

const run = <A, E>(
  test: (input: {
    readonly ctx: Effect.Success<typeof setup>;
    readonly handoff: Handoff.KinHandoff["Service"];
  }) => Effect.Effect<A, E, SqlClient.SqlClient | OrchestratorV2>,
) =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    return yield* Effect.gen(function* () {
      return yield* test({ ctx, handoff: yield* Handoff.KinHandoff });
    }).pipe(Effect.provide(Handoff.layer.pipe(Layer.provide(Layer.succeedContext(ctx.services)))));
  }).pipe(
    Effect.provide(
      Kin.layer.pipe(
        Layer.provide(kinSecretsTest),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
        Layer.provideMerge(environment),
        Layer.provideMerge(authorityLayer),
      ),
    ),
  );

const passedOn = (sql: SqlClient.SqlClient, orgId: KinOrgId, agentId: KinAgentId) =>
  sql<{ json: string; priority: string }>`SELECT json, priority FROM kin_events
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND dedupe_key LIKE 'handoff:%'
    ORDER BY event_id`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        priority: row.priority,
        event: JSON.parse(row.json) as Extract<KinEvent, { _tag: "chat.message" }>,
      })),
    ),
  );
const systemRows = (sql: SqlClient.SqlClient, orgId: KinOrgId, chatId: KinChatId) =>
  sql<{ body: string }>`SELECT body FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = ${chatId} AND author_kind = 'system' ORDER BY seq`;
const teammateLead = Effect.fn("HandoffTest.teammateLead")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
) {
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('theirs', ${orgId}, 'Finance', 'lead', 'teammate', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('theirs-chat', ${orgId}, 'direct', 'teammate:theirs', 0, ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id, domain)
    VALUES ('theirs', ${orgId}, 'Finance', 0, ${models}, '[]', 'theirs-chat', 'finance')`;
});

// The host's chats, 10 Nov 2026: asked "Check my repos", the Chief of staff could only tell the
// owner what it wasn't set up for. The front door passes the request to the lead who owns it.
it.effect(
  "a lead passes the owner's request to another of the owner's leads, once, with where it was asked",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        yield* teammateLead(sql, orgId);
        // Only the owner's own leads: a teammate's lead is neither listed nor reachable.
        assert.deepStrictEqual(yield* handoff.leads(scopeFor(chief)), {
          leads: [
            {
              name: "Chief of staff",
              domain: "chief-of-staff",
              charter: "Owns chief-of-staff.",
              you: true,
            },
            { name: "Tech lead", domain: "engineering", charter: "Owns engineering.", you: false },
          ],
        });
        const input = {
          to: "tech lead",
          request: "CI is red on acme/app.\nThe owner wants to know why.",
          sourceEventId: "ask-event",
        };
        assert.deepStrictEqual(yield* handoff.handOff(scopeFor(chief), input), {
          to: "Tech lead",
          passed: true,
        });
        // By domain, in other words, from a retry: the same message reaches that lead once.
        yield* handoff.handOff(scopeFor(chief), { ...input, to: "engineering", request: "Again" });
        // One owner message goes to one lead: after Tech lead, not also to another.
        yield* ctx.addLead(KinAgentId.make("ops"), "Ops", "operations", "1970-01-01T00:00:02.000Z");
        const second = yield* Effect.flip(
          handoff.handOff(scopeFor(chief), { ...input, to: "Ops" }),
        );
        assert.strictEqual(second.reason, "not_allowed");
        assert.include(second.message, "already passed on to Tech lead");
        assert.lengthOf(yield* passedOn(sql, orgId, KinAgentId.make("ops")), 0);
        assert.deepStrictEqual(yield* systemRows(sql, orgId, ctx.techChat), [
          {
            body: 'Passed on by Chief of staff\n"Why is CI red on the app repo?"\nChief of staff adds: CI is red on acme/app. The owner wants to know why.',
          },
        ]);
        const [passed, ...more] = yield* passedOn(sql, orgId, tech);
        assert.lengthOf(more, 0);
        // It ranks with a due reminder: ahead of routine work, but it can't jump the budget as
        // the owner's own message there would.
        assert.strictEqual(passed!.priority, "P1");
        assert.deepInclude(passed!.event, {
          _tag: "chat.message",
          agentId: tech,
          chatId: ctx.techChat,
          origin: { agentId: chief, chatId: ctx.chiefChat },
        });
        assert.deepInclude(passed!.event.provenance, { _tag: "agent", agentId: chief });
        assert.lengthOf(yield* passedOn(sql, orgId, KinAgentId.make("theirs")), 0);
        assert.lengthOf(yield* systemRows(sql, orgId, ctx.chiefChat), 0);
      }),
    ),
);

it.effect("a turn a teammate's join aborted passes nothing on", () =>
  run(({ ctx, handoff }) =>
    Effect.gen(function* () {
      const { sql, orgId } = ctx;
      yield* sql`UPDATE kin_wakeups SET aborted_at = 1, shared_since = 1 WHERE wakeup_id = 'chief-wake'`;
      const refused = yield* Effect.flip(
        handoff.handOff(scopeFor(chief), {
          to: "Tech lead",
          request: "Invented",
          sourceEventId: "ask-event",
        }),
      );
      assert.include(refused, {
        reason: "not_allowed",
        message: `${SHARED_REFUSAL} Nothing was passed on.`,
      });
      assert.lengthOf(yield* passedOn(sql, orgId, tech), 0);
      assert.lengthOf(yield* systemRows(sql, orgId, ctx.techChat), 0);
    }),
  ),
);

it.effect("what was passed on works at no more than the chat it was asked in allows", () =>
  run(({ ctx, handoff }) =>
    Effect.gen(function* () {
      const { sql, orgId } = ctx;
      // The owner lowered the Chief of staff's chat; the Tech lead's own chat still starts work.
      yield* sql`INSERT INTO kin_chat_levels (org_id, agent_id, chat_id, level, level_since)
        VALUES (${orgId}, ${chief}, ${ctx.chiefChat}, 'L1', 0)`;
      yield* handoff.handOff(scopeFor(chief), {
        to: "Tech lead",
        request: "Start a fix.",
        sourceEventId: "ask-event",
      });
      const [passed] = yield* passedOn(sql, orgId, tech);
      const techWake = { orgId, agentId: tech, wakeupId: "tech-wake" };
      assert.strictEqual(yield* KinLevels.wakeupLevel(techWake), "L2");
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'tech-wake'
        WHERE org_id = ${orgId} AND event_id = ${passed!.event.eventId}`;
      assert.strictEqual(yield* KinLevels.wakeupLevel(techWake), "L1");
      assert.strictEqual(yield* KinLevels.originCap(techWake), "L1");

      // A reminder the Tech lead sets while answering it keeps that origin when it comes due.
      const origin = yield* deferralOrigin(
        sql,
        orgId,
        {
          id: KinMemoryItemId.make("def-1"),
          chat: ctx.techChat,
          source_event: passed!.event.eventId,
        } as never,
        { agentId: tech, ownerChatId: ctx.techChat },
      );
      assert.deepStrictEqual(origin, { agentId: chief, chatId: ctx.chiefChat });

      // One hop: the Tech lead can't pass it back, so two leads can't trade a request.
      yield* recordAudience(techWake, yield* turnAudience(techWake));
      const back = yield* Effect.flip(
        handoff.handOff(scopeFor(tech), {
          to: "Chief of staff",
          request: "Back to you.",
          sourceEventId: passed!.event.eventId,
        }),
      );
      assert.strictEqual(back.reason, "not_allowed");
      assert.include(back.message, "stops with you");
      assert.lengthOf(yield* passedOn(sql, orgId, chief), 0);
    }),
  ),
);

it.effect(
  "only the owner's own message in the lead's own chat can be passed on, and only to a live lead of theirs",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* teammateLead(sql, orgId);
        const pass = (sourceEventId: string, to = "Tech lead") =>
          Effect.flip(handoff.handOff(scopeFor(chief), { to, request: "Please.", sourceEventId }));

        // A group the owner put the lead in: a teammate there can't reach a lead outside it.
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
          VALUES ('team', ${orgId}, 'team_group', 'Team', 0, ${at})`;
        const member = (id: string, principal: "person" | "agent", who: KinPersonId | KinAgentId) =>
          sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
            VALUES (${id}, ${orgId}, 'team', ${principal}, ${principal === "person" ? who : null},
              ${principal === "agent" ? who : null}, ${id === "team-owner" ? "owner" : "member"}, ${at})`;
        yield* member("team-owner", "person", owner.personId);
        yield* member("team-chief", "agent", chief);
        const inGroup = yield* ctx.chats.send(owner, {
          chatId: "team" as KinChatId,
          body: "Ask the Tech lead about CI.",
          clientMessageId: "group-ask",
        });
        yield* ctx.claim("group-event", chief, { chatId: "team", messageId: inGroup.messageId });
        assert.include((yield* pass("group-event")).message, "your own chat with them");

        // Not a person's message, another wake-up's event, an unknown event.
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
          VALUES ('routine-event', ${orgId}, ${chief}, 'routine', 'P2', ${JSON.stringify({
            _tag: "routine",
            orgId,
            agentId: chief,
            eventId: "routine-event",
            receivedAt: at,
            dedupeKey: null,
            provenance: { _tag: "system" },
            routine: "morning_brief",
          })}, 0, 0, 'claimed', 'chief-wake')`;
        assert.strictEqual((yield* pass("routine-event")).reason, "not_allowed");
        yield* ctx.claim("tech-event", tech, {});
        assert.strictEqual((yield* pass("tech-event")).reason, "not_found");
        assert.strictEqual((yield* pass("nowhere")).reason, "not_found");

        // A group's message woke the lead too, so what it adds could carry someone else's words.
        assert.include((yield* pass("ask-event")).message, "outside your own chat with the owner");
        yield* sql`UPDATE kin_events SET state = 'done', wakeup_id = NULL
          WHERE org_id = ${orgId} AND event_id = 'group-event'`;

        // Someone else's lead, itself, and a name nobody has all name who can be reached.
        for (const to of ["Finance", "finance", "Chief of staff", "Nobody"]) {
          const refused = yield* pass("ask-event", to);
          assert.strictEqual(refused.reason, "not_found");
          assert.include(refused.message, "The agents are: Tech lead (engineering).");
        }
        yield* sql`UPDATE kin_agents SET retired_at = ${at} WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.include((yield* pass("ask-event")).message, "no other agent");

        const events = yield* sql`SELECT event_id FROM kin_events
          WHERE org_id = ${orgId} AND dedupe_key LIKE 'handoff:%' ORDER BY event_id`;
        assert.lengthOf(events, 0);
        assert.lengthOf(yield* systemRows(sql, orgId, ctx.techChat), 0);
      }),
    ),
);

it.effect(
  "the owner's message goes whole, or not at all when the other lead couldn't see it whole",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        const ask = Effect.fn("HandoffTest.ask")(function* (eventId: string, body: string) {
          const sent = yield* ctx.chats.send(owner, {
            chatId: ctx.chiefChat,
            body,
            clientMessageId: eventId,
          });
          yield* ctx.claim(eventId, chief, { messageId: sent.messageId });
        });
        const pass = (sourceEventId: string, request = "Please look.") =>
          handoff.handOff(scopeFor(chief), { to: "Tech lead", request, sourceEventId });
        // Past the 1,500 characters the reviewed version cut it at.
        const long = `${"The deploy log says ".repeat(150)}end.`;
        yield* ask("long-event", long);
        yield* pass("long-event");
        const [row] = yield* systemRows(sql, orgId, ctx.techChat);
        assert.include(row!.body, `"${long}"`);
        // More than a lead is shown of one message: refused rather than cut.
        yield* ask("huge-event", "x".repeat(8_100));
        const huge = yield* Effect.flip(pass("huge-event"));
        assert.strictEqual(huge.reason, "not_allowed");
        assert.include(huge.message, "too long for another agent to be shown whole");
        assert.include(huge.message, "Nothing was passed on.");
        // Whole on its own, but not with the lead's words added.
        yield* ask("close-event", "y".repeat(7_000));
        const close = yield* Effect.flip(pass("close-event", "z ".repeat(999)));
        assert.include(close.message, "Add less and call again");
        assert.lengthOf(yield* systemRows(sql, orgId, ctx.techChat), 1);
      }),
    ),
);

it.effect("kin_leads tells charters only to a wake-up the owner alone set off", () =>
  run(({ ctx, handoff }) =>
    Effect.gen(function* () {
      const { sql, orgId, owner } = ctx;
      yield* ctx.addLead(KinAgentId.make("ops"), "Ops", "operations", "1970-01-01T00:00:02.000Z");
      assert.lengthOf((yield* handoff.leads(scopeFor(chief))).leads, 3);
      // A group with a teammate, the Chief of staff and the Tech lead in it; Ops isn't there.
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
        VALUES ('team', ${orgId}, 'team_group', 'Team', 0, ${at})`;
      for (const [id, kind, who, role] of [
        ["team-owner", "person", owner.personId, "owner"],
        ["team-mate", "person", "teammate", "member"],
        ["team-chief", "agent", chief, "member"],
        ["team-tech", "agent", tech, "member"],
      ] as const)
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
          VALUES (${id}, ${orgId}, 'team', ${kind}, ${kind === "person" ? who : null},
            ${kind === "agent" ? who : null}, ${role}, ${at})`;
      yield* ctx.claim("team-event", chief, {
        chatId: "team",
        provenance: { _tag: "human", personId: "teammate", memberId: "team-mate" },
      });
      assert.deepStrictEqual(yield* handoff.leads(scopeFor(chief)), {
        leads: [
          { name: "Chief of staff", you: true },
          { name: "Tech lead", you: false },
        ],
      });
    }),
  ),
);
