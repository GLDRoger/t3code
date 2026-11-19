import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  type KinPersonId,
  type KinWidgetId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import type { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import type { Services } from "../KinServer.ts";
import { recordAudience, turnAudience } from "../lead/Audience.ts";
import * as Handoff from "../lead/Handoff.ts";
import * as LeadProvision from "../lead/KinLeadProvision.ts";
import * as KinOpen from "../open/KinOpen.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { runRecommend } from "./card.ts";
import * as KinRecommend from "./KinRecommend.ts";
import { ruleContext } from "./ledger.ts";
import { routeAccess } from "./rules.ts";

const at = "1970-01-01T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;
// 10:00 UTC on the test clock's first day: the owner is awake. The clock only moves by hours;
// longer spans move the stored times back instead (`timePasses`).
const START = 10 * 60 * 60 * 1000;
const chief = KinAgentId.make("chief");
const tech = KinAgentId.make("tech");
const models = JSON.stringify({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
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

/**
 * Rhea's Ambermill: the Chief of staff and Tech lead, and Meera, who may message the Chief of
 * staff but not the Tech lead, and a co-owner, Dev. Meera's asks go through the real hand-off.
 */
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
  const addLead = Effect.fn("RecommendTest.addLead")(function* (
    agentId: KinAgentId,
    name: string,
    domain: string,
    createdAt: string,
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
  const chiefChat = yield* addLead(chief, "Chief of staff", "chief-of-staff", at);
  yield* addLead(tech, "Tech lead", "engineering", "1970-01-01T00:00:01.000Z");
  yield* sql`UPDATE kin_people SET display_name = 'Rhea' WHERE person_id = ${owner.personId}`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES ('meera', ${orgId}, 'meera', 'Meera', ${at}, 'member'),
      ('dev', ${orgId}, 'dev', 'Dev', ${at}, 'co_owner')`;
  yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at, revoked_at)
    VALUES (${orgId}, ${chief}, 'meera', ${owner.personId}, 0, NULL)`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00',
      '{"from":"22:00","to":"07:00"}')
    ON CONFLICT (org_id) DO UPDATE SET time_zone = 'UTC',
      quiet_hours_json = excluded.quiet_hours_json`;
  yield* sql`UPDATE kin_orgs SET created_at = '1969-12-01T00:00:00.000Z' WHERE org_id = ${orgId}`;
  const meera = { _tag: "person" as const, orgId, personId: "meera" as KinPersonId };
  const devId = "dev" as KinPersonId;
  const direct = yield* chats.createDirect(meera, { orgId, agentId: chief });
  yield* TestClock.setTime(START);
  return { services, sql, orgId, owner, chats, chiefChat, meera, devId, direct: direct.chatId };
});
type Ctx = Effect.Success<typeof setup>;

const run = <A, E>(
  test: (input: {
    readonly ctx: Ctx;
    readonly handoff: Handoff.KinHandoff["Service"];
  }) => Effect.Effect<A, E, SqlClient.SqlClient | OrchestratorV2 | Services>,
) =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    return yield* Effect.gen(function* () {
      return yield* test({ ctx, handoff: yield* Handoff.KinHandoff });
    }).pipe(
      Effect.provide(Handoff.layer.pipe(Layer.provide(Layer.succeedContext(ctx.services)))),
      Effect.provideContext(ctx.services),
    );
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

/** Meera asks the Chief of staff for the Tech lead's work, and it passes the request on. */
const meeraAsks = Effect.fn("RecommendTest.meeraAsks")(function* (
  ctx: Ctx,
  handoff: Handoff.KinHandoff["Service"],
  eventId: string,
) {
  yield* ctx.sql`UPDATE kin_wakeups SET status = 'running'
    WHERE org_id = ${ctx.orgId} AND wakeup_id = 'chief-wake'`;
  const sent = yield* ctx.chats.send(ctx.meera, {
    chatId: ctx.direct,
    body: `Can I get the staging logs? (${eventId})`,
    clientMessageId: eventId,
  });
  yield* ctx.sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
    VALUES (${eventId}, ${ctx.orgId}, ${chief}, 'chat.message', 'P0', ${JSON.stringify({
      _tag: "chat.message",
      orgId: ctx.orgId,
      agentId: chief,
      eventId,
      receivedAt: at,
      dedupeKey: null,
      provenance: sent.author,
      chatId: ctx.direct,
      messageId: sent.messageId,
    })}, 0, 0, 'claimed', 'chief-wake')`;
  const turn = { orgId: ctx.orgId, agentId: chief, wakeupId: "chief-wake" };
  yield* recordAudience(turn, yield* turnAudience(turn));
  yield* handoff.handOff(scopeFor(chief), {
    wantsAnswer: true,
    to: "Tech lead",
    request: "Meera wants the staging logs.",
    sourceEventId: eventId,
  });
  yield* ctx.sql`UPDATE kin_events SET state = 'done', wakeup_id = NULL
    WHERE org_id = ${ctx.orgId} AND event_id = ${eventId}`;
  // Its turn ends: a wake-up still running would hold Kin's own card back.
  yield* ctx.sql`UPDATE kin_wakeups SET status = 'completed'
    WHERE org_id = ${ctx.orgId} AND wakeup_id = 'chief-wake'`;
});

/**
 * Three asks over two days: the first card ran out, a second ask waited on it, and the third's
 * card waits now. The rule's threshold, exactly.
 */
const threeAsks = Effect.fn("RecommendTest.threeAsks")(function* (
  ctx: Ctx,
  handoff: Handoff.KinHandoff["Service"],
) {
  yield* meeraAsks(ctx, handoff, "ask-1");
  yield* meeraAsks(ctx, handoff, "ask-2");
  yield* TestClock.adjust("25 hours");
  yield* meeraAsks(ctx, handoff, "ask-3");
  yield* TestClock.adjust("23 hours");
});

const verdicts = (ctx: Ctx) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* routeAccess(yield* ruleContext(ctx.orgId, ctx.owner.personId, now));
  });

/** Kin's suggestion cards in Rhea's chat with the Chief of staff, oldest first. */
const cards = (ctx: Ctx) =>
  ctx.sql<{
    widgetId: string;
    messageId: string;
    closedAt: string | null;
    state: string;
    silent: number;
  }>`SELECT w.widget_id AS "widgetId", w.message_id AS "messageId", w.closed_at AS "closedAt",
      w.state_json AS state, m.silent FROM kin_recommendations r
    JOIN kin_widgets w ON w.org_id = r.org_id AND w.widget_id = r.widget_id
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    WHERE r.org_id = ${ctx.orgId} ORDER BY r.posted_at`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        widgetId: row.widgetId as KinWidgetId,
        messageId: row.messageId,
        closedAt: row.closedAt,
        silent: row.silent,
        state: JSON.parse(row.state) as {
          question: string;
          detail: string;
          options: ReadonlyArray<{ optionId: string; label: string }>;
          outcome?: { title: string; text: string };
        },
      })),
    ),
  );
const tap = (ctx: Ctx, widgetId: KinWidgetId, option: "option-1" | "option-2", key = "") =>
  ctx.chats.act(ctx.owner, {
    widgetId,
    revision: 1,
    actionId: "choose",
    value: option,
    clientActionId: `${widgetId}:${option}${key}`,
  });
const tick = (ctx: Ctx) =>
  Effect.gen(function* () {
    return yield* KinRecommend.tick(ctx.orgId, yield* Clock.currentTimeMillis);
  });
const list = (ctx: Ctx, personId = ctx.owner.personId) =>
  KinRecommend.list(ctx.orgId, personId).pipe(
    Effect.map((result) => result.rows.map(({ outcome, action }) => ({ outcome, action }))),
  );
const meeraMayMessageTech = (ctx: Ctx) =>
  ctx.sql`SELECT 1 FROM kin_lead_access WHERE org_id = ${ctx.orgId} AND agent_id = ${tech}
    AND person_id = 'meera' AND revoked_at IS NULL`.pipe(Effect.map((rows) => rows.length > 0));
/** Her asks moved back by `ms`, as if that much time had passed since. */
const asksAge = (ctx: Ctx, ms: number) =>
  Effect.andThen(
    ctx.sql`UPDATE kin_handoffs SET created_at = created_at - ${ms} WHERE org_id = ${ctx.orgId}`,
    ctx.sql`UPDATE kin_messages SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at,
        ${`-${ms / 1000} seconds`})
      WHERE org_id = ${ctx.orgId} AND author_person_id = 'meera'`,
  );
/** Rhea's open waiting rows for this card: on the card, or on its message alone. */
const waitingOn = (ctx: Ctx, card: { widgetId: string; messageId: string }) =>
  ctx.sql`SELECT 1 FROM kin_waiting WHERE org_id = ${ctx.orgId}
    AND person_id = ${ctx.owner.personId} AND resolved_at IS NULL
    AND (widget_id = ${card.widgetId} OR message_id = ${card.messageId})`.pipe(
    Effect.map((rows) => rows.length),
  );
/** Its rows in Rhea's Needs you now. */
const needsYouOn = (ctx: Ctx, card: { widgetId: string; messageId: string }) =>
  Effect.gen(function* () {
    const open = yield* KinOpen.compute({
      orgId: ctx.orgId,
      viewer: { personId: ctx.owner.personId, ownerLevel: true },
      at: yield* Clock.currentTimeMillis,
    });
    return open.rows.filter(
      (row) =>
        row.item._tag === "waiting" &&
        (row.item.waiting.widgetId === card.widgetId ||
          row.item.waiting.messageId === card.messageId),
    ).length;
  });
const chiefMessages = (ctx: Ctx) =>
  ctx.sql`SELECT message_id FROM kin_messages WHERE org_id = ${ctx.orgId}
    AND chat_id = ${ctx.chiefChat} ORDER BY seq`;
/** Meera's own message for an ask, and the hand-off recorded for it. */
const askOf = (ctx: Ctx, eventId: string) =>
  ctx.sql<{ messageId: string; widgetId: string | null }>`SELECT m.message_id AS "messageId",
      h.route_widget_id AS "widgetId" FROM kin_messages m
    JOIN kin_handoffs h ON h.org_id = m.org_id AND h.message_id = m.message_id
    WHERE m.org_id = ${ctx.orgId} AND m.body LIKE ${`%(${eventId})%`}`.pipe(
    Effect.map((rows) => rows[0]!),
  );
/** `days` pass for the suggestions alone: Meera's asks stay as recent as they were. */
const timePasses = (ctx: Ctx, days: number) =>
  ctx.sql`UPDATE kin_recommendations SET posted_at = posted_at - ${days * DAY},
      decided_at = decided_at - ${days * DAY}, quiet_until = quiet_until - ${days * DAY}
    WHERE org_id = ${ctx.orgId}`;

const NOTICED =
  "Meera asked Chief of staff for Tech lead's work 3 times since 1 Jan. One of your cards on it ran out before you answered, one request waited on a card you hadn't answered yet, and one card on it is waiting now.";

it.effect(
  "rule 1 counts Meera's unanswered asks for the Tech lead over 30 days, and is silent below the threshold, after Meera's access, Rhea's Not this time, a revoke and the window",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* meeraAsks(ctx, handoff, "ask-1");
        yield* meeraAsks(ctx, handoff, "ask-2");
        // Two asks, both unanswered: one short of "frequently".
        assert.deepStrictEqual(yield* verdicts(ctx), [
          {
            _tag: "silent",
            subject: "person:meera|agent:tech",
            reason: "Meera hasn't been waiting on you for Tech lead that often lately",
          },
        ]);
        yield* TestClock.adjust("25 hours");
        yield* meeraAsks(ctx, handoff, "ask-3");
        const [fires] = yield* verdicts(ctx);
        assert.deepStrictEqual(fires, {
          _tag: "fires",
          candidate: {
            rule: "route_access",
            subject: "person:meera|agent:tech",
            weight: 3,
            noticed: NOTICED,
            ask: "Let Meera message Tech lead directly?",
            gives:
              "Meera could then ask Tech lead without waiting for you. Tech lead talks and drafts for Meera, and starting work stays yours to ask for.",
            change: {
              kind: "lead_access",
              personId: "meera",
              personName: "Meera",
              agentId: "tech",
              agentName: "Tech lead",
            },
          },
        });

        const reasonNow = Effect.map(verdicts(ctx), (all) =>
          all[0]!._tag === "fires" ? "fires" : all[0]!.reason,
        );
        const quiet = "Meera hasn't been waiting on you for Tech lead that often lately";
        const ask1 = yield* askOf(ctx, "ask-1");
        const ask3 = yield* askOf(ctx, "ask-3");
        // A request counts by when Meera sent it, not when its hand-off was recorded.
        yield* sql`UPDATE kin_messages SET created_at = '1969-12-31T10:00:00.000Z'
          WHERE org_id = ${orgId} AND message_id = ${ask1.messageId}`;
        const [moved] = yield* verdicts(ctx);
        assert.include(
          moved?._tag === "fires" ? moved.candidate.noticed : "",
          "3 times since 31 Dec.",
        );
        yield* sql`UPDATE kin_messages SET created_at = '1969-12-02T10:00:00.000Z'
          WHERE org_id = ${orgId} AND message_id = ${ask1.messageId}`;
        assert.strictEqual(yield* reasonNow, quiet);
        yield* sql`UPDATE kin_messages SET created_at = '1970-01-01T10:00:00.000Z'
          WHERE org_id = ${orgId} AND message_id = ${ask1.messageId}`;
        // Its card closed early, or was cleared: it didn't run out.
        yield* sql`UPDATE kin_widgets SET closed_at = '1970-01-01T11:00:00.000Z'
          WHERE org_id = ${orgId} AND widget_id = ${ask1.widgetId}`;
        assert.strictEqual(yield* reasonNow, quiet);
        yield* sql`UPDATE kin_widgets SET closed_at = NULL
          WHERE org_id = ${orgId} AND widget_id = ${ask1.widgetId}`;
        // A wait recorded after its card ran out didn't wait on an open card.
        yield* sql`UPDATE kin_handoffs SET created_at = created_at + ${25 * 60 * 60 * 1000}
          WHERE org_id = ${orgId} AND route_state = 'waited'`;
        assert.strictEqual(yield* reasonNow, quiet);
        yield* sql`UPDATE kin_handoffs SET created_at = created_at - ${25 * 60 * 60 * 1000}
          WHERE org_id = ${orgId} AND route_state = 'waited'`;
        // The card waiting now closed early, or went: it didn't run out, and doesn't wait now.
        const twoFacts =
          "Meera asked Chief of staff for Tech lead's work 3 times since 1 Jan. One of your cards on it ran out before you answered, and one request waited on a card you hadn't answered yet.";
        const noticedNow = Effect.map(verdicts(ctx), (all) =>
          all[0]!._tag === "fires" ? all[0]!.candidate.noticed : all[0]!.reason,
        );
        yield* sql`UPDATE kin_widgets SET closed_at = '1970-01-02T12:00:00.000Z'
          WHERE org_id = ${orgId} AND widget_id = ${ask3.widgetId}`;
        assert.strictEqual(yield* noticedNow, twoFacts);
        yield* sql`UPDATE kin_widgets SET closed_at = NULL
          WHERE org_id = ${orgId} AND widget_id = ${ask3.widgetId}`;
        yield* sql`UPDATE kin_handoffs SET route_widget_id = 'choice:cleared'
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        assert.strictEqual(yield* noticedNow, twoFacts);
        yield* sql`UPDATE kin_handoffs SET route_widget_id = ${ask3.widgetId}
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        // Passed on and later cancelled: not a request that waited on Rhea.
        yield* sql`UPDATE kin_handoffs SET route_state = 'stale'
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        assert.strictEqual(yield* reasonNow, quiet);
        yield* sql`UPDATE kin_handoffs SET route_state = 'pending'
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        assert.strictEqual(yield* reasonNow, "fires");

        // She can already message it: nothing to suggest.
        yield* LeadProvision.allow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        assert.deepInclude((yield* verdicts(ctx))[0], {
          reason: "Meera can already message Tech lead",
        });
        // He took it away again: not suggested back for 90 days.
        yield* LeadProvision.disallow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        assert.deepInclude((yield* verdicts(ctx))[0], {
          reason: "you stopped Meera messaging Tech lead",
        });
        yield* sql`UPDATE kin_lead_access SET revoked_at = revoked_at - ${91 * DAY}
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.strictEqual((yield* verdicts(ctx))[0]!._tag, "fires");

        // Rhea's last answer for the pair was Not this time: judgement, not time.
        yield* sql`UPDATE kin_handoffs SET route_state = 'declined'
          WHERE org_id = ${orgId} AND message_id = (SELECT message_id FROM kin_handoffs
            WHERE org_id = ${orgId} ORDER BY created_at DESC LIMIT 1)`;
        assert.deepInclude((yield* verdicts(ctx))[0], {
          reason: "you said Not this time to Meera's last request for Tech lead",
        });
        yield* sql`UPDATE kin_handoffs SET route_state = 'pending'
          WHERE org_id = ${orgId} AND route_state = 'declined'`;
        assert.strictEqual((yield* verdicts(ctx))[0]!._tag, "fires");
        // The last answer is the one Rhea gave last, not the one on the latest request: her
        // Not this time on ask-3's card came after a Let on ask-1's, which a later ask carries.
        yield* TestClock.adjust("1 hour");
        yield* meeraAsks(ctx, handoff, "ask-4");
        const ask4 = yield* askOf(ctx, "ask-4");
        yield* sql`UPDATE kin_handoffs SET route_state = 'declined'
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        yield* sql`UPDATE kin_card_plans SET ran_message_id = ${ask3.messageId}
          WHERE org_id = ${orgId} AND widget_id = ${ask3.widgetId} AND option_id = 'option-2'`;
        yield* sql`UPDATE kin_handoffs SET route_state = 'passed', route_widget_id = ${ask1.widgetId}
          WHERE org_id = ${orgId} AND message_id = ${ask4.messageId}`;
        yield* sql`UPDATE kin_card_plans SET ran_message_id = ${ask1.messageId}
          WHERE org_id = ${orgId} AND widget_id = ${ask1.widgetId} AND option_id = 'option-1'`;
        assert.strictEqual(
          yield* reasonNow,
          "you said Not this time to Meera's last request for Tech lead",
        );
        yield* sql`UPDATE kin_handoffs SET route_state = 'pending'
          WHERE org_id = ${orgId} AND message_id = ${ask3.messageId}`;
        yield* sql`UPDATE kin_handoffs SET route_state = 'waited', route_widget_id = ${ask3.widgetId}
          WHERE org_id = ${orgId} AND message_id = ${ask4.messageId}`;

        // A month on, the first asks fall out of the window, then the last.
        yield* asksAge(ctx, 29 * DAY + 12 * 60 * 60 * 1000);
        assert.deepInclude((yield* verdicts(ctx))[0], {
          reason: "Meera hasn't been waiting on you for Tech lead that often lately",
        });
        yield* asksAge(ctx, DAY);
        assert.deepStrictEqual(yield* verdicts(ctx), []);
      }),
    ),
);

it.effect(
  "the pass posts one silent card in Needs you, once, and stays silent in a company's first 14 days",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* sql`UPDATE kin_orgs SET created_at = '1969-12-25T00:00:00.000Z' WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "new_company" });
        yield* sql`UPDATE kin_orgs SET created_at = '1969-12-01T00:00:00.000Z' WHERE org_id = ${orgId}`;
        // Not while the Chief of staff is mid-turn: its wake-up's posts here are counted.
        yield* sql`UPDATE kin_wakeups SET status = 'running'
          WHERE org_id = ${orgId} AND wakeup_id = 'chief-wake'`;
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "turn_running" });
        assert.lengthOf(yield* cards(ctx), 0);
        yield* sql`UPDATE kin_wakeups SET status = 'completed'
          WHERE org_id = ${orgId} AND wakeup_id = 'chief-wake'`;

        const posted = yield* tick(ctx);
        assert.strictEqual(posted._tag, "posted");
        const [card, ...more] = yield* cards(ctx);
        assert.lengthOf(more, 0);
        assert.strictEqual(card!.silent, 1);
        assert.strictEqual(card!.state.question, "Let Meera message Tech lead directly?");
        assert.include(card!.state.detail, NOTICED);
        assert.include(card!.state.detail, "starting work stays yours to ask for.");
        assert.deepStrictEqual(
          card!.state.options.map((option) => option.label),
          ["Let Meera message Tech lead", "Not now"],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT option_id AS "optionId", json_extract(plan_json, '$.kind') AS kind,
              json_extract(plan_json, '$.answer') AS answer
            FROM kin_card_plans WHERE org_id = ${orgId} AND widget_id = ${card!.widgetId}
            ORDER BY option_id`,
          [
            { optionId: "option-1", kind: "recommend", answer: "do" },
            { optionId: "option-2", kind: "recommend", answer: "not_now" },
          ],
        );
        // It waits on Rhea in Needs you once, as the card.
        assert.strictEqual(yield* waitingOn(ctx, card!), 1);
        assert.strictEqual(yield* needsYouOn(ctx, card!), 1);
        assert.deepStrictEqual(yield* list(ctx), [
          { outcome: "Waiting in Needs you.", action: null },
        ]);
        // Settings dates what it noticed: "waiting now" was then.
        assert.strictEqual(
          (yield* KinRecommend.list(orgId, owner.personId)).rows[0]!.noticed,
          `Noticed 3 Jan: ${NOTICED}`,
        );
        // One at a time: nothing more while it waits, later that day or the next.
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "card_open" });
        yield* TestClock.adjust("11 hours");
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "card_open" });
        assert.lengthOf(yield* cards(ctx), 1);
        // At its time limit it leaves Needs you, and the sweep closes it saying it ran out,
        // without another message in the chat.
        yield* TestClock.adjust("13 hours");
        const said = yield* chiefMessages(ctx);
        assert.strictEqual(yield* needsYouOn(ctx, card!), 0);
        yield* KinRecommend.closeRanOut(yield* Clock.currentTimeMillis);
        assert.strictEqual(yield* waitingOn(ctx, card!), 0);
        const [ranOut] = yield* cards(ctx);
        assert.isNotNull(ranOut!.closedAt);
        assert.deepStrictEqual(ranOut!.state.outcome, {
          title: "Ran out",
          text: "This suggestion ran out before you answered, so nothing changed. Settings, under Recommendations, can ask again.",
        });
        assert.deepStrictEqual(yield* chiefMessages(ctx), said);
        // Ran out unanswered: neither yes nor no, and quiet a week.
        yield* TestClock.adjust("1 hour");
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome: "Not answered. Kin may suggest it again after 11 Jan.",
            action: { kind: "ask_again", label: "Ask again" },
          },
        ]);
      }),
    ),
);

it.effect(
  "Do it grants through the Settings method as the owner and records it, a replay does it once, clearing the chat leaves it done, and a grant made later by hand isn't its to undo",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* tick(ctx);
        const [card] = yield* cards(ctx);
        const tapped = yield* tap(ctx, card!.widgetId, "option-1");
        assert.isTrue(JSON.parse(tapped.body).handled);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_lead_access WHERE org_id = ${orgId} AND agent_id = ${tech}
            AND person_id = 'meera' AND revoked_at IS NULL AND granted_by = ${owner.personId}`,
          1,
        );
        // Her own direct chat with the Tech lead, as the agent's page makes it.
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_chats WHERE org_id = ${orgId} AND direct_key = 'meera:tech'`,
          1,
        );
        assert.deepStrictEqual((yield* cards(ctx))[0]!.state.outcome, {
          title: "Done",
          text: "Meera may message Tech lead from now on. Settings, under Recommendations, can undo it.",
        });
        assert.deepStrictEqual(
          yield* sql`SELECT state, decided_by AS "decidedBy" FROM kin_recommendations
            WHERE org_id = ${orgId}`,
          [{ state: "done", decidedBy: owner.personId }],
        );
        // Let settles its one row in Needs you.
        assert.strictEqual(yield* waitingOn(ctx, card!), 0);
        // The same tap again returns the first; nothing runs twice.
        const again = yield* tap(ctx, card!.widgetId, "option-1");
        assert.strictEqual(again.messageId, tapped.messageId);
        const done = [
          {
            outcome: "Done 3 Jan. Meera may message Tech lead.",
            action: { kind: "undo" as const, label: "Stop Meera messaging Tech lead" },
          },
        ];
        assert.deepStrictEqual(yield* list(ctx), done);
        // Clearing the chat takes the card, not the grant: Settings reads its own row.
        yield* ctx.chats.clear(owner, { chatId: ctx.chiefChat });
        assert.deepStrictEqual(yield* list(ctx), done);

        // Taken away and given again by hand on the agent's page: that later grant isn't
        // this row's to undo.
        yield* LeadProvision.disallow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        yield* TestClock.adjust("1 hour");
        yield* LeadProvision.allow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        assert.deepStrictEqual(yield* list(ctx), [
          { outcome: "Done 3 Jan. Undone since.", action: null },
        ]);
        const [row] = (yield* KinRecommend.list(orgId, owner.personId)).rows;
        const refused = yield* Effect.flip(KinRecommend.undo(orgId, owner.personId, row!.recId));
        assert.deepInclude(refused, { reason: "invalid_state" });
        assert.isTrue(yield* meeraMayMessageTech(ctx));
      }),
    ),
);

it.effect(
  "Undo takes back its own grant once, and says what still stands: a retired agent, the team agent",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* tick(ctx);
        const [card] = yield* cards(ctx);
        yield* tap(ctx, card!.widgetId, "option-1");
        const [row] = (yield* KinRecommend.list(orgId, owner.personId)).rows;
        const undo = KinRecommend.undo(orgId, owner.personId, row!.recId);
        // Retired, its grant kept: nothing to undo, and the row says it's gone.
        yield* sql`UPDATE kin_agents SET retired_at = '1970-01-03T11:00:00.000Z'
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.deepStrictEqual(yield* list(ctx), [
          { outcome: "Done 3 Jan. Tech lead is no longer there.", action: null },
        ]);
        assert.deepInclude(yield* Effect.flip(undo), { reason: "invalid_state" });
        yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE org_id = ${orgId} AND agent_id = ${tech}`;

        // The team agent: Undo removes her own access, and she can still message it.
        yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
          VALUES (${orgId}, ${tech}, ${owner.personId}, 0)`;
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome: "Done 3 Jan. Meera may message Tech lead.",
            action: { kind: "undo", label: "Remove Meera's own access to Tech lead" },
          },
        ]);
        yield* undo;
        assert.isFalse(yield* meeraMayMessageTech(ctx));
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome:
              "Done 3 Jan. Meera's own access was removed since. Tech lead is the team agent, so Meera can still message it.",
            action: null,
          },
        ]);
        // Once: given again by hand, a second Undo still takes nothing.
        yield* TestClock.adjust("1 hour");
        yield* LeadProvision.allow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        assert.deepInclude(yield* Effect.flip(undo), { reason: "invalid_state" });
        assert.isTrue(yield* meeraMayMessageTech(ctx));
        // Undone: not suggested back the next day.
        yield* sql`DELETE FROM kin_team_agents WHERE org_id = ${orgId}`;
        yield* LeadProvision.disallow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        yield* TestClock.adjust("1 day");
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
      }),
    ),
);

it.effect(
  "clearing the chat ends an open suggestion then: its quiet week runs from the clear, and its old tap does nothing",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* tick(ctx);
        const [card] = yield* cards(ctx);
        yield* TestClock.adjust("23 hours");
        yield* ctx.chats.clear(owner, { chatId: ctx.chiefChat });
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome: "Not answered. Kin may suggest it again after 11 Jan.",
            action: { kind: "ask_again", label: "Ask again" },
          },
        ]);
        assert.strictEqual(yield* waitingOn(ctx, card!), 0);
        yield* Effect.flip(tap(ctx, card!.widgetId, "option-1"));
        assert.isFalse(yield* meeraMayMessageTech(ctx));
        assert.strictEqual(
          (yield* KinRecommend.list(orgId, owner.personId)).rows[0]!.outcome,
          "Not answered. Kin may suggest it again after 11 Jan.",
        );
      }),
    ),
);

it.effect(
  "Not now quiets the suggestion 30 days, then 90, then for good, and Ask again lets it speak",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        const notNow = Effect.gen(function* () {
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          const card = (yield* cards(ctx)).at(-1)!;
          yield* tap(ctx, card.widgetId, "option-2");
          // Not now settles its one row in Needs you.
          assert.strictEqual(yield* waitingOn(ctx, card), 0);
          return (yield* cards(ctx)).at(-1)!.state.outcome;
        });
        assert.deepStrictEqual(yield* notNow, {
          title: "Not now",
          text: "Kin won't suggest this before 2 Feb.",
        });
        assert.isFalse(yield* meeraMayMessageTech(ctx));
        assert.deepStrictEqual((yield* list(ctx))[0], {
          outcome: "Not now on 3 Jan. Kin won't suggest this before 2 Feb.",
          action: { kind: "ask_again", label: "Ask again" },
        });
        // Each step is a day on the clock, and the rest of the span for the stored rows.
        const days = (count: number) =>
          Effect.andThen(TestClock.adjust("24 hours"), timePasses(ctx, count - 1));
        yield* days(29);
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
        yield* days(1);
        assert.deepStrictEqual(yield* notNow, {
          title: "Not now",
          text: "Kin won't suggest this before 5 Apr.",
        });
        yield* days(89);
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
        yield* days(1);
        assert.deepStrictEqual(yield* notNow, {
          title: "Not now",
          text: "Kin won't suggest this again. Settings, under Recommendations, can ask again.",
        });
        yield* days(365);
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
        const [latest] = (yield* KinRecommend.list(orgId, owner.personId)).rows;
        assert.deepStrictEqual(latest!.action, { kind: "ask_again", label: "Ask again" });
        assert.include(latest!.outcome, "Kin won't suggest this again.");
        const after = yield* KinRecommend.askAgain(orgId, owner.personId, latest!.recId);
        assert.include(after.rows[0]!.outcome, "Kin may suggest it again.");
        assert.isNull(after.rows[0]!.action);
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
      }),
    ),
);

it.effect(
  "a tap after the situation changed does nothing and says so; one a day, never past five in Needs you, never in quiet hours",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* tick(ctx);
        const [card] = yield* cards(ctx);
        // Given on the agent's page meanwhile: Do it changes nothing.
        yield* LeadProvision.allow({
          editor: owner,
          orgId,
          agentId: tech,
          personId: ctx.meera.personId,
        });
        const before = yield* sql`SELECT granted_at FROM kin_lead_access
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        yield* tap(ctx, card!.widgetId, "option-1");
        assert.deepStrictEqual((yield* cards(ctx))[0]!.state.outcome, {
          title: "Nothing changed",
          text: "Nothing changed: Meera can already message Tech lead.",
        });
        assert.deepStrictEqual(
          yield* sql`SELECT granted_at FROM kin_lead_access
            WHERE org_id = ${orgId} AND agent_id = ${tech}`,
          before,
        );
        assert.strictEqual((yield* list(ctx))[0]!.action, null);
        yield* sql`DELETE FROM kin_lead_access WHERE org_id = ${orgId} AND agent_id = ${tech}`;

        // One a day: the same day, nothing more even with the rule firing again.
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "posted_today" });
        // Never in Rhea's quiet hours.
        yield* TestClock.adjust("13 hours");
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "quiet_hours" });
        // Never with more than five things waiting on Rhea.
        yield* TestClock.adjust("11 hours");
        yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${orgId}`;
        const [thread] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
          FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${chief}`;
        for (const n of [1, 2, 3, 4, 5, 6])
          yield* ctx.chats.ask(
            {
              _tag: "agent",
              hostPosted: true,
              orgId,
              agentId: chief,
              ownerPersonId: owner.personId,
              threadId: ThreadId.make(thread!.threadId),
            },
            {
              chatId: ctx.chiefChat,
              clientMessageId: `busy-${n}`,
              question: `Pick a venue for the offsite (${n})`,
              options: [{ label: "North" }, { label: "South" }],
            },
          );
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "busy" });
      }),
    ),
);

it.effect(
  "a teammate made a co-owner, or renamed, after the card was drawn: the tap changes nothing and says why",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        yield* threeAsks(ctx, handoff);
        yield* tick(ctx);
        const [first] = yield* cards(ctx);
        // A co-owner messages every agent already: never drawn for one, and a tap does nothing.
        yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE org_id = ${orgId} AND person_id = 'meera'`;
        assert.deepInclude((yield* verdicts(ctx))[0], {
          _tag: "silent",
          reason: "Meera can already message Tech lead",
        });
        yield* tap(ctx, first!.widgetId, "option-1");
        assert.deepStrictEqual((yield* cards(ctx))[0]!.state.outcome, {
          title: "Nothing changed",
          text: "Nothing changed: Meera can already message Tech lead.",
        });
        assert.isFalse(yield* meeraMayMessageTech(ctx));
        yield* sql`UPDATE kin_people SET access = 'member' WHERE org_id = ${orgId} AND person_id = 'meera'`;

        // A day on, a fresh card; renamed before the tap, its words no longer name who it changes.
        yield* TestClock.adjust("24 hours");
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
        const second = (yield* cards(ctx)).at(-1)!;
        yield* sql`UPDATE kin_people SET display_name = 'Meera Rao' WHERE org_id = ${orgId} AND person_id = 'meera'`;
        yield* tap(ctx, second.widgetId, "option-1");
        assert.deepStrictEqual((yield* cards(ctx)).at(-1)!.state.outcome, {
          title: "Nothing changed",
          text: "Nothing changed: the names on this card have changed since Kin drew it.",
        });
        assert.isFalse(yield* meeraMayMessageTech(ctx));
      }),
    ),
);

it.effect(
  "only the owner sees or answers a suggestion: a co-owner and a teammate can neither read, tap, undo nor ask again",
  () =>
    run(({ ctx, handoff }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* threeAsks(ctx, handoff);
        const posted = yield* tick(ctx);
        assert.strictEqual(posted._tag, "posted");
        if (posted._tag !== "posted") return;
        const [plan] = yield* ctx.sql<{ json: string }>`SELECT plan_json AS json
          FROM kin_card_plans WHERE org_id = ${orgId} AND widget_id = ${posted.widgetId}
            AND option_id = 'option-1'`;
        for (const personId of [ctx.devId, ctx.meera.personId]) {
          const tapped = yield* Effect.flip(
            runRecommend(
              {
                orgId,
                widget: { widgetId: posted.widgetId },
                personId,
                now: yield* Clock.currentTimeMillis,
              },
              JSON.parse(plan!.json) as RecommendPlan,
            ),
          );
          assert.deepInclude(tapped, {
            reason: "not_allowed",
            message: "Only Rhea can answer this.",
          });
          for (const call of [
            KinRecommend.list(orgId, personId),
            KinRecommend.undo(orgId, personId, posted.recId),
            KinRecommend.askAgain(orgId, personId, posted.recId),
          ])
            assert.deepInclude(yield* Effect.flip(call), { reason: "not_allowed" });
        }
        // Meera isn't in Rhea's chat at all: Meera's tap on the card is refused before any plan runs.
        const refused = yield* Effect.flip(
          ctx.chats.act(ctx.meera, {
            widgetId: posted.widgetId,
            revision: 1,
            actionId: "choose",
            value: "option-1",
            clientActionId: "meera-tap",
          }),
        );
        assert.strictEqual(refused._tag, "KinChatError");
        // Still open for Rhea, and nothing changed.
        assert.isFalse(yield* meeraMayMessageTech(ctx));
        assert.deepStrictEqual(yield* list(ctx, owner.personId), [
          { outcome: "Waiting in Needs you.", action: null },
        ]);
      }),
    ),
);
