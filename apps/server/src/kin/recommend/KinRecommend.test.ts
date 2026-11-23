import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinConnectionId,
  type KinPersonId,
  type KinWidgetId,
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
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { subscribeRefreshes } from "../chat/refreshes.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import type { Services } from "../KinServer.ts";
import * as Handoff from "../lead/Handoff.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import * as LeadProvision from "../lead/KinLeadProvision.ts";
import * as KinOpen from "../open/KinOpen.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { runRecommend } from "./card.ts";
import * as KinRecommend from "./KinRecommend.ts";
import { ruleContext } from "./ledger.ts";
import {
  type RuleContext,
  type Verdict,
  agentPaused,
  connectionPaused,
  dailyLimit,
} from "./rules.ts";

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
/**
 * Rhea's Ambermill: the Chief of staff and Tech lead, Meera, a teammate, and a co-owner, Dev.
 * Meera's asks go through the real hand-off.
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

/**
 * Two days in, the Tech lead has been paused four days with three things waiting for it: rule 5
 * fires, and stands for any suggestion in what the ledger does with it.
 */
const techWaits = (ctx: Ctx) =>
  Effect.all([TestClock.adjust("48 hours"), pausedTech(ctx, 4, 3), idle(ctx)]);

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
/** `days` pass for the suggestions alone: what waits stays as it was. */
const timePasses = (ctx: Ctx, days: number) =>
  ctx.sql`UPDATE kin_recommendations SET posted_at = posted_at - ${days * DAY},
      decided_at = decided_at - ${days * DAY}, quiet_until = quiet_until - ${days * DAY}
    WHERE org_id = ${ctx.orgId}`;

/** `KinRecommend.layer`'s scheduler pass, to run by hand as the scheduler's sweeps would. */
const sweeps = Effect.gen(function* () {
  const registered = new Map<string, Effect.Effect<void>>();
  yield* Layer.build(
    KinRecommend.layer.pipe(
      Layer.provide(
        Layer.succeed(Scheduler.Scheduler, {
          register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
            Effect.gen(function* () {
              const context = yield* Effect.context<R>();
              registered.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
            }),
        }),
      ),
    ),
  );
  return registered.get("kin-recommend")!;
});
const declines = (ctx: Ctx) =>
  ctx.sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_recommendations
    WHERE org_id = ${ctx.orgId} AND state = 'declined'`.pipe(Effect.map((rows) => rows[0]!.n));

const NOTICED =
  "Tech lead has been paused since 30 Dec, and 3 things wait for it, 1 of them a message from you.";

it.effect(
  "the pass posts one silent card in Needs you, once, and stays silent in a company's first 14 days",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* techWaits(ctx);
        yield* sql`UPDATE kin_orgs SET created_at = '1969-12-25T00:00:00.000Z' WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "new_company" });
        yield* sql`UPDATE kin_orgs SET created_at = '1969-12-01T00:00:00.000Z' WHERE org_id = ${orgId}`;
        // Not while the Chief of staff is mid-turn: its wake-up's posts here are counted. The
        // scheduler's next sweep, not the next hour, tries again once the turn is done.
        yield* sql`UPDATE kin_wakeups SET status = 'running'
          WHERE org_id = ${orgId} AND wakeup_id = 'chief-wake'`;
        const sweep = yield* sweeps;
        yield* sweep;
        assert.lengthOf(yield* cards(ctx), 0);
        yield* sql`UPDATE kin_wakeups SET status = 'completed'
          WHERE org_id = ${orgId} AND wakeup_id = 'chief-wake'`;
        yield* sweep;
        const [card, ...more] = yield* cards(ctx);
        assert.lengthOf(more, 0);
        assert.strictEqual(card!.silent, 1);
        assert.strictEqual(card!.state.question, "Resume Tech lead?");
        assert.include(card!.state.detail, NOTICED);
        assert.deepStrictEqual(
          card!.state.options.map((option) => option.label),
          ["Resume Tech lead", "Not now"],
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
      }).pipe(Effect.scoped),
    ),
);

it.effect(
  "clearing the chat ends an open suggestion then: its quiet week runs from the clear, and its old tap does nothing",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* techWaits(ctx);
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
        assert.isNotNull(yield* techPausedAt(ctx));
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
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* techWaits(ctx);
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
          text: "You left it as it is. Settings, under Recommendations, can ask again.",
        });
        assert.isNotNull(yield* techPausedAt(ctx));
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
          text: "You left it as it is. Settings, under Recommendations, can ask again.",
        });
        yield* days(89);
        assert.deepStrictEqual(yield* tick(ctx), { _tag: "skipped", why: "nothing" });
        yield* days(1);
        assert.deepStrictEqual(yield* notNow, {
          title: "Not now",
          text: "You left it as it is. Settings, under Recommendations, can ask again.",
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
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        yield* techWaits(ctx);
        yield* tick(ctx);
        const [card] = yield* cards(ctx);
        // Resumed on the agent's page meanwhile: Do it changes nothing.
        yield* LeadProvision.setPaused({ by: owner, orgId, agentId: tech, paused: false });
        yield* tap(ctx, card!.widgetId, "option-1");
        assert.deepStrictEqual((yield* cards(ctx))[0]!.state.outcome, {
          title: "Nothing changed",
          text: "Nothing changed: Tech lead isn't paused any more.",
        });
        assert.isNull(yield* techPausedAt(ctx));
        yield* pausedTech(ctx, 4, 0);

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
  "a name changed after the card was drawn: either answer changes nothing, says why and counts no Not now",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        yield* techWaits(ctx);
        const drawn = Effect.gen(function* () {
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          return (yield* cards(ctx)).at(-1)!;
        });
        const answered = (option: "option-1" | "option-2") =>
          Effect.gen(function* () {
            yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
            return (yield* cards(ctx)).at(-1)!.state.outcome;
          });
        const renamed = {
          title: "Nothing changed",
          text: "Nothing changed: the names on this card have changed since Kin drew it.",
        };
        const rename = (name: string) =>
          sql`UPDATE kin_leads SET name = ${name} WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        // Renamed before the tap, its words no longer name what it is about.
        for (const option of ["option-2", "option-1"] as const) {
          yield* drawn;
          yield* rename("Tech");
          assert.deepStrictEqual(yield* answered(option), renamed);
          assert.strictEqual(yield* declines(ctx), 0);
          assert.isNotNull(yield* techPausedAt(ctx));
          yield* rename("Tech lead");
          yield* TestClock.adjust("24 hours");
        }
      }),
    ),
);

it.effect(
  "an open Recommendations list hears every change to a suggestion: drawn, answered, asked again, ran out, cleared; a co-owner hears none",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        const heard = (who: typeof owner) =>
          Stream.runHead(subscribeRefreshes([who], { orgId })).pipe(Effect.map(Option.getOrThrow));
        const revision = Effect.map(heard(owner), (now) => now.recommendations);
        const latest = Effect.map(KinRecommend.list(orgId, owner.personId), (all) => all.rows[0]!);
        const moves = Effect.fn("RecommendTest.moves")(function* <A, E, R>(
          change: Effect.Effect<A, E, R>,
        ) {
          const before = yield* revision;
          yield* change;
          assert.strictEqual(yield* revision, (before ?? 0) + 1);
        });
        const askAgain = Effect.flatMap(latest, (row) =>
          KinRecommend.askAgain(orgId, owner.personId, row.recId),
        );
        yield* techWaits(ctx);
        yield* moves(tick(ctx));
        yield* moves(tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, "option-2"));
        yield* moves(askAgain);
        yield* TestClock.adjust("24 hours");
        yield* moves(tick(ctx));
        yield* TestClock.adjust("24 hours");
        yield* moves(KinRecommend.closeRanOut(yield* Clock.currentTimeMillis));
        yield* moves(askAgain);
        yield* moves(tick(ctx));
        yield* moves(ctx.chats.clear(owner, { chatId: ctx.chiefChat }));
        assert.notProperty(yield* heard({ ...owner, personId: ctx.devId }), "recommendations");
      }),
    ),
);

it.effect(
  "only the owner sees or answers a suggestion: a co-owner and a teammate can neither read, tap nor ask again",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { orgId, owner } = ctx;
        yield* techWaits(ctx);
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
        assert.isNotNull(yield* techPausedAt(ctx));
        assert.deepStrictEqual(yield* list(ctx, owner.personId), [
          { outcome: "Waiting in Needs you.", action: null },
        ]);
      }),
    ),
);

/** The rule's verdicts now, for Rhea. */
const asked = <E, R>(
  ctx: Ctx,
  rule: (context: RuleContext) => Effect.Effect<ReadonlyArray<Verdict>, E, R>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return yield* rule(yield* ruleContext(ctx.orgId, ctx.owner.personId, now));
  });
/** The first verdict's reason, or "fires". */
const reasonOf = (all: ReadonlyArray<Verdict>) =>
  all[0] === undefined ? "none" : all[0]._tag === "fires" ? "fires" : all[0].reason;
const people = (ctx: Ctx, personId: KinPersonId = ctx.owner.personId) => [
  { _tag: "person" as const, orgId: ctx.orgId, personId },
];
const coOwnerTaps = (ctx: Ctx, widgetId: KinWidgetId, option: "option-1" | "option-2") =>
  Effect.gen(function* () {
    const [plan] = yield* ctx.sql<{ json: string }>`SELECT plan_json AS json
      FROM kin_card_plans WHERE org_id = ${ctx.orgId} AND widget_id = ${widgetId}
        AND option_id = ${option}`;
    return yield* Effect.flip(
      runRecommend(
        {
          orgId: ctx.orgId,
          widget: { widgetId },
          personId: ctx.devId,
          now: yield* Clock.currentTimeMillis,
        },
        JSON.parse(plan!.json) as RecommendPlan,
      ),
    );
  });
/** No agent mid-turn: a running wake-up holds Kin's own card back. */
const idle = (ctx: Ctx) =>
  ctx.sql`UPDATE kin_wakeups SET status = 'completed' WHERE org_id = ${ctx.orgId}`;
const outcomeOf = (ctx: Ctx) => Effect.map(cards(ctx), (all) => all.at(-1)!.state.outcome);

const USUAL = 2_000_000;
const limits = (ctx: Ctx) =>
  ctx.sql<{ json: string }>`SELECT limits_json AS json FROM kin_budget_limits
    WHERE org_id = ${ctx.orgId}`.pipe(Effect.map((rows) => JSON.parse(rows[0]!.json) as unknown));
/** Settings' pair for `leadUnits` (workers three times it), unless `workerUnits` says otherwise. */
const setLimit = (
  ctx: Ctx,
  leadUnits: number | null,
  workerUnits = leadUnits === null ? null : leadUnits * 3,
) =>
  ctx.sql`INSERT INTO kin_budget_limits (org_id, limits_json)
    VALUES (${ctx.orgId}, ${JSON.stringify({ leadUnits, workerUnits, teammateUnits: 500_000 })})
    ON CONFLICT (org_id) DO UPDATE SET limits_json = excluded.limits_json`;
/** A day the agents spent `units` and Kin told Rhea work would wait, or didn't (`told: false`). */
const limitDay = (ctx: Ctx, day: string, units: number, told = true) =>
  ctx.sql`INSERT INTO kin_budget (org_id, day, lead_units, exhausted_notified_at)
    VALUES (${ctx.orgId}, ${day}, ${units}, ${told ? 0 : null})
    ON CONFLICT (org_id, day) DO UPDATE SET lead_units = excluded.lead_units,
      exhausted_notified_at = excluded.exhausted_notified_at`;
const LIMIT_NOTICED =
  "Kin told you on 3 of the last 7 days that the daily limit was reached. It is The usual now.";
/** At The usual, used up on three of the last seven days: the threshold, exactly. */
const limitReached = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* setLimit(ctx, USUAL);
    yield* limitDay(ctx, "1969-12-26", USUAL);
    yield* limitDay(ctx, "1969-12-30", USUAL + 1);
    yield* limitDay(ctx, "1970-01-01", USUAL);
  });

it.effect(
  "rule 2 counts the days the agents used up the limit as it is now and Kin said work would wait, offers the next choice up, and is silent below it, at No limit, the top or an amount of its own",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const reason = Effect.map(asked(ctx, dailyLimit), reasonOf);
        assert.strictEqual(yield* reason, "there is no daily limit");
        yield* limitReached(ctx);
        assert.deepStrictEqual(yield* asked(ctx, dailyLimit), [
          {
            _tag: "fires",
            candidate: {
              rule: "daily_limit",
              subject: "org",
              weight: 3,
              noticed: LIMIT_NOTICED,
              ask: "Raise the daily limit from The usual to Twice the usual?",
              gives:
                "Your agents could then do up to twice as much each day, which can cost you more. Nothing is raised unless you tap.",
              change: {
                kind: "daily_limit",
                fromLeadUnits: USUAL,
                fromWorkerUnits: 6_000_000,
                fromName: "The usual",
                toLeadUnits: 2 * USUAL,
                toWorkerUnits: 12_000_000,
                toName: "Twice the usual",
              },
            },
          },
        ]);
        const fewer = "your agents haven't used up the daily limit that often lately";
        // A day Kin told no one about, a day short of the limit, a day out of the window, or a
        // day mostly teammates' spending: none of them counts.
        yield* limitDay(ctx, "1969-12-26", USUAL, false);
        assert.strictEqual(yield* reason, fewer);
        yield* limitDay(ctx, "1969-12-26", USUAL - 1);
        assert.strictEqual(yield* reason, fewer);
        yield* limitDay(ctx, "1969-12-26", USUAL);
        yield* ctx.sql`UPDATE kin_budget SET day = '1969-12-25' WHERE org_id = ${ctx.orgId} AND day = '1969-12-26'`;
        assert.strictEqual(yield* reason, fewer);
        yield* ctx.sql`UPDATE kin_budget SET day = '1969-12-26' WHERE org_id = ${ctx.orgId} AND day = '1969-12-25'`;
        yield* ctx.sql`INSERT INTO kin_budget_charges (org_id, wakeup_id, day, units, tokens_json, teammate)
          VALUES (${ctx.orgId}, 'chief-wake', '1969-12-26', 1, '{}', 1)`;
        assert.strictEqual(yield* reason, fewer);
        yield* ctx.sql`DELETE FROM kin_budget_charges WHERE org_id = ${ctx.orgId}`;
        assert.strictEqual(yield* reason, "fires");
        // Raised since those days: they were used up under a smaller limit than today's.
        yield* setLimit(ctx, 2 * USUAL);
        assert.strictEqual(yield* reason, fewer);
        // Half the usual offers The usual: twice as much.
        yield* setLimit(ctx, USUAL / 2);
        const [half] = yield* asked(ctx, dailyLimit);
        assert.include(half?._tag === "fires" ? half.candidate.gives : "", "up to twice as much");
        // Twice offers Five times: two and a half times as much.
        yield* setLimit(ctx, 2 * USUAL);
        for (const day of ["1969-12-26", "1969-12-30", "1970-01-01"])
          yield* limitDay(ctx, day, 2 * USUAL);
        const [twice] = yield* asked(ctx, dailyLimit);
        assert.include(
          twice?._tag === "fires" ? twice.candidate.gives : "",
          "up to two and a half times as much",
        );
        yield* setLimit(ctx, 5 * USUAL);
        assert.strictEqual(yield* reason, "the daily limit is already Five times the usual");
        yield* setLimit(ctx, 1_234_567);
        assert.strictEqual(yield* reason, "the daily limit was set to its own amount");
        // A choice in Settings is the whole pair: The usual's lead amount with another worker
        // amount, or none, is a pair of its own.
        for (const workers of [30_000_000, null]) {
          yield* setLimit(ctx, USUAL, workers);
          assert.strictEqual(yield* reason, "the daily limit was set to its own amount");
        }
        yield* setLimit(ctx, null);
        assert.strictEqual(yield* reason, "there is no daily limit");
        // Seven calendar days on the owner's clock, a short day among them: just after midnight
        // on 9 Mar 2026 in New York, 2 Mar is eight days back, not in the window.
        yield* setLimit(ctx, USUAL);
        const newYork = {
          orgId: ctx.orgId,
          ownerId: ctx.owner.personId,
          at: Date.parse("2026-03-09T04:30:00.000Z"),
          zone: "America/New_York",
          locale: "en-GB",
        };
        for (const day of ["2026-03-02", "2026-03-05", "2026-03-09"])
          yield* limitDay(ctx, day, USUAL);
        assert.strictEqual(reasonOf(yield* dailyLimit(newYork)), fewer);
        yield* limitDay(ctx, "2026-03-03", USUAL);
        assert.strictEqual(reasonOf(yield* dailyLimit(newYork)), "fires");
      }),
    ),
);

it.effect(
  "the daily limit card: Do it raises it through Daily limit's own method as the owner, its row follows the limit as it is, and a card whose limit moved changes nothing for either answer",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const budget = Context.get(ctx.services, KinBudget);
        yield* limitReached(ctx);
        yield* idle(ctx);
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
        const [card] = yield* cards(ctx);
        assert.strictEqual(
          card!.state.question,
          "Raise the daily limit from The usual to Twice the usual?",
        );
        assert.include(card!.state.detail, LIMIT_NOTICED);
        assert.include(
          card!.state.detail,
          "which can cost you more. Nothing is raised unless you tap.",
        );
        assert.deepStrictEqual(
          card!.state.options.map((option) => option.label),
          ["Raise to Twice the usual", "Not now"],
        );
        // Only Rhea answers it: a co-owner's tap is refused and nothing changes.
        assert.deepInclude(yield* coOwnerTaps(ctx, card!.widgetId, "option-1"), {
          reason: "not_allowed",
        });
        assert.deepInclude(yield* limits(ctx), { leadUnits: USUAL });
        yield* tap(ctx, card!.widgetId, "option-1");
        // The next choice up for both of Settings' amounts, the teammates' share kept.
        assert.deepStrictEqual(yield* limits(ctx), {
          leadUnits: 2 * USUAL,
          workerUnits: 12_000_000,
          teammateUnits: 500_000,
        });
        assert.deepStrictEqual(yield* outcomeOf(ctx), {
          title: "Done",
          text: "The daily limit is now Twice the usual. Daily limit, in Settings, is where you change it.",
        });
        const open = { kind: "open_daily_limit" as const, label: "Open Daily limit" };
        assert.deepStrictEqual(yield* list(ctx), [
          { outcome: "Done 1 Jan: the daily limit is Twice the usual.", action: open },
        ]);
        // Changed on Daily limit since: the row says what it is now.
        yield* budget.set(people(ctx), {
          orgId: ctx.orgId,
          limits: { leadUnits: 5 * USUAL, workerUnits: 30_000_000 },
        });
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome:
              "Done 1 Jan: the daily limit went to Twice the usual. It is Five times the usual now.",
            action: open,
          },
        ]);
        // Twice the usual's lead amount with another worker amount is no longer Twice the usual.
        yield* setLimit(ctx, 2 * USUAL, 30_000_000);
        assert.deepStrictEqual(yield* list(ctx), [
          {
            outcome:
              "Done 1 Jan: the daily limit went to Twice the usual. It has its own amount now.",
            action: open,
          },
        ]);

        // Drawn again at The usual, then moved on Daily limit before either tap.
        for (const option of ["option-1", "option-2"] as const) {
          yield* TestClock.adjust("24 hours");
          yield* setLimit(ctx, USUAL);
          for (const day of ["1969-12-30", "1970-01-01", "1970-01-02", "1970-01-03"])
            yield* limitDay(ctx, day, USUAL);
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          yield* budget.set(people(ctx), {
            orgId: ctx.orgId,
            limits: { leadUnits: USUAL / 2, workerUnits: 3_000_000 },
          });
          yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
          assert.deepStrictEqual(yield* outcomeOf(ctx), {
            title: "Nothing changed",
            text: "Nothing changed: the daily limit is now Half the usual.",
          });
          assert.deepInclude(yield* limits(ctx), { leadUnits: USUAL / 2 });
        }
        // Only the workers' amount moved: the card no longer names the pair as it is.
        for (const option of ["option-1", "option-2"] as const) {
          yield* TestClock.adjust("24 hours");
          yield* setLimit(ctx, USUAL);
          for (const day of ["1970-01-03", "1970-01-04", "1970-01-05"])
            yield* limitDay(ctx, day, USUAL);
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          yield* setLimit(ctx, USUAL, 30_000_000);
          yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
          assert.deepStrictEqual(yield* outcomeOf(ctx), {
            title: "Nothing changed",
            text: "Nothing changed: the daily limit was set to its own amount since Kin drew this card.",
          });
          assert.deepInclude(yield* limits(ctx), { leadUnits: USUAL, workerUnits: 30_000_000 });
        }
        assert.strictEqual(yield* declines(ctx), 0);
      }),
    ),
);

const zoho = KinConnectionId.make("conn-zoho");
/** Zoho Books, paused `days` ago, with one tool on as the owner accepted it. */
const pausedZoho = (ctx: Ctx, days: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* ctx.sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url,
        url_host, auth, reach, state, created_at, updated_at, paused_at)
      VALUES (${ctx.orgId}, ${zoho}, 'zoho_books', 'Zoho Books', 'remote',
        'https://books.zoho.example/mcp', 'books.zoho.example', 'none', 'closed', 'active',
        0, 0, ${now - days * DAY})`;
    yield* ctx.sql`INSERT INTO kin_connection_tools (org_id, connection_id, tool_name,
        definition_json, pin_digest, accepted_digest, mode, suggested_mode, open_world, first_seen_at)
      VALUES (${ctx.orgId}, ${zoho}, 'list_invoices', '{"name":"list_invoices"}', 'pin', 'pin',
        'read', 'read', 0, 0)`;
  });
/**
 * One call an agent made on Zoho Books `hoursAgo`, refused for its pause unless said otherwise:
 * `refused` with another reason, or a call that ran.
 */
const zohoCall = (
  ctx: Ctx,
  agentId: string,
  hoursAgo: number,
  status = "refused",
  reason = "The owner paused Zoho Books. Only the owner can resume it.",
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* ctx.sql`INSERT INTO kin_connection_calls (org_id, call_id, connection_id, tool_name,
        agent_id, wakeup_id, status, refused_reason, created_at)
      VALUES (${ctx.orgId}, ${`call-${agentId}-${now - hoursAgo * 60 * 60 * 1000}-${status}-${reason.length}`}, ${zoho}, 'list_invoices',
        ${agentId}, ${`${agentId}-wake`}, ${status}, ${status === "refused" ? reason : null},
        ${now - hoursAgo * 60 * 60 * 1000})`;
  });
const ZOHO_NOTICED =
  "Zoho Books has been paused since 28 Dec. In the last 7 days Tech lead tried to use it 3 times and couldn't.";
const zohoTried = (ctx: Ctx) =>
  Effect.gen(function* () {
    yield* pausedZoho(ctx, 4);
    for (const hours of [2, 30, 60]) yield* zohoCall(ctx, "tech", hours);
  });
const zohoPausedAt = (ctx: Ctx) =>
  ctx.sql<{ pausedAt: number | null }>`SELECT paused_at AS "pausedAt" FROM kin_connections
    WHERE org_id = ${ctx.orgId} AND connection_id = ${zoho}`.pipe(
    Effect.map((rows) => rows[0]!.pausedAt),
  );

it.effect(
  "rule 3 counts the calls refused on a connection since its pause began, over 7 days, and is silent when it is removed, needs signing in, was paused lately or barely tried",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        const reason = Effect.map(asked(ctx, connectionPaused), reasonOf);
        yield* zohoTried(ctx);
        const pausedAt = (yield* zohoPausedAt(ctx))!;
        assert.deepStrictEqual(yield* asked(ctx, connectionPaused), [
          {
            _tag: "fires",
            candidate: {
              rule: "connection_paused",
              subject: `connection:${zoho}`,
              weight: 3,
              noticed: ZOHO_NOTICED,
              ask: "Resume Zoho Books?",
              gives:
                "Your agents could then use its tools again, each as you set it in Connections.",
              change: {
                kind: "connection_resume",
                connectionId: zoho,
                connectionName: "Zoho Books",
                pausedAt,
              },
            },
          },
        ]);
        const fewer = "your agents haven't tried Zoho Books often since it was paused";
        const pauseAgo = (hours: number) =>
          Effect.flatMap(
            Clock.currentTimeMillis,
            (now) =>
              sql`UPDATE kin_connections SET paused_at = ${now - hours * 60 * 60 * 1000}
              WHERE org_id = ${orgId}`,
          );
        const tryOnly = Effect.fn("RecommendTest.tryOnly")(function* (
          calls: ReadonlyArray<readonly [string, number, string?, string?]>,
        ) {
          yield* sql`DELETE FROM kin_connection_calls WHERE org_id = ${orgId}`;
          for (const [agentId, hours, status, why] of calls)
            yield* zohoCall(ctx, agentId, hours, status, why);
        });
        // A call that ran isn't a try the pause stopped.
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["tech", 60, "ok"],
        ]);
        assert.strictEqual(yield* reason, fewer);
        // Nor is one refused for another reason, under any name the connection had then.
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30, "refused", "list_invoices is off. Only the owner can turn it on."],
          ["tech", 60, "refused", "The owner paused Zoho. Only the owner can resume it."],
        ]);
        assert.strictEqual(yield* reason, fewer);
        // A refusal from before this pause began isn't one either, until the pause is older.
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["tech", 120],
        ]);
        assert.strictEqual(yield* reason, fewer);
        yield* pauseAgo(150);
        assert.strictEqual(yield* reason, "fires");
        // Nor one older than the week, however long the pause.
        yield* pauseAgo(240);
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["tech", 7 * 24 + 1],
        ]);
        assert.strictEqual(yield* reason, fewer);
        // Paused under three days: still meant.
        yield* pauseAgo(48);
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["tech", 40],
        ]);
        assert.strictEqual(yield* reason, "Zoho Books was paused only recently");
        // Tries from two agents: both named.
        yield* pauseAgo(96);
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["chief", 5],
        ]);
        const [two] = yield* asked(ctx, connectionPaused);
        assert.include(
          two?._tag === "fires" ? two.candidate.noticed : "",
          "In the last 7 days Chief of staff and Tech lead tried to use it 3 times and couldn't.",
        );
        // An agent whose name can't be read is never named by its id.
        yield* tryOnly([
          ["tech", 2],
          ["tech", 30],
          ["gone-agent", 5],
        ]);
        const [unnamed] = yield* asked(ctx, connectionPaused);
        assert.include(
          unnamed?._tag === "fires" ? unnamed.candidate.noticed : "",
          "In the last 7 days 2 of your agents tried to use it 3 times and couldn't.",
        );
        yield* tryOnly([
          ["gone-agent", 2],
          ["gone-agent", 30],
          ["gone-agent", 5],
        ]);
        const [one] = yield* asked(ctx, connectionPaused);
        assert.include(
          one?._tag === "fires" ? one.candidate.noticed : "",
          "In the last 7 days an agent tried to use it 3 times and couldn't.",
        );
        // Resuming wouldn't make it work: an error from its last refresh, a review it waits on,
        // or no tool on as the owner accepted it.
        const cannot = "Zoho Books can't connect right now, which resuming wouldn't fix";
        for (const broken of [
          sql`UPDATE kin_connections SET state = 'error' WHERE org_id = ${orgId}`,
          sql`UPDATE kin_connections SET state = 'active', last_error = 'HTTP 503' WHERE org_id = ${orgId}`,
        ]) {
          yield* broken;
          assert.strictEqual(yield* reason, cannot);
        }
        yield* sql`UPDATE kin_connections SET state = 'needs_review', last_error = NULL WHERE org_id = ${orgId}`;
        assert.strictEqual(
          yield* reason,
          "Zoho Books waits for you to look at what changed in it, which resuming wouldn't fix",
        );
        yield* sql`UPDATE kin_connections SET state = 'active' WHERE org_id = ${orgId}`;
        const noTools =
          "none of the tools on Zoho Books is switched on, which resuming wouldn't fix";
        for (const off of [
          sql`UPDATE kin_connection_tools SET mode = 'off' WHERE org_id = ${orgId}`,
          sql`UPDATE kin_connection_tools SET mode = 'read', accepted_digest = NULL WHERE org_id = ${orgId}`,
        ]) {
          yield* off;
          assert.strictEqual(yield* reason, noTools);
        }
        yield* sql`UPDATE kin_connection_tools SET accepted_digest = 'pin' WHERE org_id = ${orgId}`;
        assert.strictEqual(yield* reason, "fires");
        // Resuming wouldn't help one that needs signing in, and a removed one isn't there.
        yield* sql`UPDATE kin_connections SET state = 'needs_sign_in' WHERE org_id = ${orgId}`;
        assert.strictEqual(
          yield* reason,
          "Zoho Books needs signing in again, which resuming wouldn't fix",
        );
        yield* sql`UPDATE kin_connections SET state = 'active', removed_at = 1 WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(yield* asked(ctx, connectionPaused), []);
        const now = yield* Clock.currentTimeMillis;
        assert.strictEqual(
          reasonOf(
            yield* connectionPaused(yield* ruleContext(orgId, ctx.owner.personId, now), {
              connectionId: zoho,
            }),
          ),
          "Zoho Books is no longer connected",
        );
      }),
    ),
);

it.effect(
  "the paused connection card: Do it resumes it through Connections' own method as the owner, its row follows the connection as it is, and a card whose pause moved changes nothing for either answer",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        const connections = Context.get(ctx.services, KinConnections);
        const ref = { orgId, connectionId: zoho };
        yield* zohoTried(ctx);
        yield* idle(ctx);
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
        const [card] = yield* cards(ctx);
        assert.strictEqual(card!.state.question, "Resume Zoho Books?");
        assert.include(card!.state.detail, ZOHO_NOTICED);
        assert.deepStrictEqual(
          card!.state.options.map((option) => option.label),
          ["Resume Zoho Books", "Not now"],
        );
        assert.deepInclude(yield* coOwnerTaps(ctx, card!.widgetId, "option-1"), {
          reason: "not_allowed",
        });
        assert.isNotNull(yield* zohoPausedAt(ctx));
        yield* tap(ctx, card!.widgetId, "option-1");
        assert.isNull(yield* zohoPausedAt(ctx));
        assert.deepStrictEqual(yield* outcomeOf(ctx), {
          title: "Done",
          text: "Zoho Books is no longer paused. Settings, under Connections, is where you pause it.",
        });
        const open = {
          kind: "open_connection" as const,
          label: "Open Zoho Books",
          connectionId: zoho,
        };
        const row = Effect.map(list(ctx), (rows) => rows[0]);
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan: Zoho Books is no longer paused.",
          action: open,
        });
        yield* connections.update(people(ctx), { ...ref, paused: true });
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan. Zoho Books was paused again since.",
          action: open,
        });
        yield* connections.update(people(ctx), { ...ref, paused: false });
        yield* sql`UPDATE kin_connections SET state = 'needs_sign_in' WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan: Zoho Books was resumed. It needs signing in again now.",
          action: open,
        });
        yield* sql`UPDATE kin_connections SET state = 'active', removed_at = 1 WHERE org_id = ${orgId}`;
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan. Zoho Books is no longer connected.",
          action: null,
        });
        yield* sql`UPDATE kin_connections SET removed_at = NULL WHERE org_id = ${orgId}`;

        // Drawn again, then resumed and paused again in Connections before either tap.
        for (const option of ["option-1", "option-2"] as const) {
          yield* TestClock.adjust("24 hours");
          yield* sql`UPDATE kin_connections SET paused_at = ${(yield* Clock.currentTimeMillis) - 4 * DAY}
            WHERE org_id = ${orgId}`;
          for (const hours of [1, 2, 3]) yield* zohoCall(ctx, "tech", hours);
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          yield* connections.update(people(ctx), { ...ref, paused: false });
          yield* TestClock.adjust("1 hour");
          yield* connections.update(people(ctx), { ...ref, paused: true });
          const repaused = yield* zohoPausedAt(ctx);
          yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
          assert.deepStrictEqual(yield* outcomeOf(ctx), {
            title: "Nothing changed",
            text: "Nothing changed: Zoho Books was resumed and paused again since Kin drew this card.",
          });
          assert.strictEqual(yield* zohoPausedAt(ctx), repaused);
        }
        // Drawn again, then its refresh failed before Do it: resuming wouldn't make it work.
        yield* TestClock.adjust("24 hours");
        yield* sql`UPDATE kin_connections SET paused_at = ${(yield* Clock.currentTimeMillis) - 4 * DAY}
          WHERE org_id = ${orgId}`;
        for (const hours of [1, 2, 3]) yield* zohoCall(ctx, "tech", hours);
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
        yield* sql`UPDATE kin_connections SET state = 'error', last_error = 'HTTP 503' WHERE org_id = ${orgId}`;
        yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, "option-1");
        assert.deepStrictEqual(yield* outcomeOf(ctx), {
          title: "Nothing changed",
          text: "Nothing changed: Zoho Books can't connect right now, which resuming wouldn't fix.",
        });
        assert.isNotNull(yield* zohoPausedAt(ctx));
        assert.strictEqual(yield* declines(ctx), 0);
      }),
    ),
);

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
/** The Tech lead paused `days` ago, with `count` things queued for it, the first from Rhea. */
const pausedTech = (ctx: Ctx, days: number, count: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* ctx.sql`UPDATE kin_agents SET paused_at = ${isoAt(now - days * DAY)}
      WHERE org_id = ${ctx.orgId} AND agent_id = ${tech}`;
    for (let n = 0; n < count; n++)
      yield* ctx.sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state)
        VALUES (${`tech-${n}`}, ${ctx.orgId}, ${tech}, ${n === 0 ? "chat.message" : "record.changed"},
          'P2', ${JSON.stringify({ provenance: { _tag: "human", personId: ctx.owner.personId } })},
          0, 0, 'queued')`;
  });
const techPausedAt = (ctx: Ctx) =>
  ctx.sql<{ pausedAt: string | null }>`SELECT paused_at AS "pausedAt" FROM kin_agents
    WHERE org_id = ${ctx.orgId} AND agent_id = ${tech}`.pipe(
    Effect.map((rows) => rows[0]!.pausedAt),
  );
const TECH_NOTICED =
  "Tech lead has been paused since 28 Dec, and 3 things wait for it, 1 of them a message from you.";

it.effect(
  "rule 5 counts what waits for a paused agent and Rhea's own messages among it, and is silent when it is retired, paused lately or little waits",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId } = ctx;
        const reason = Effect.map(asked(ctx, agentPaused), reasonOf);
        yield* pausedTech(ctx, 4, 3);
        const pausedAt = Date.parse((yield* techPausedAt(ctx))!);
        assert.deepStrictEqual(yield* asked(ctx, agentPaused), [
          {
            _tag: "fires",
            candidate: {
              rule: "agent_paused",
              subject: "agent:tech",
              weight: 3,
              noticed: TECH_NOTICED,
              ask: "Resume Tech lead?",
              gives: "Tech lead would then pick up what waits for it.",
              change: { kind: "agent_resume", agentId: "tech", agentName: "Tech lead", pausedAt },
            },
          },
        ]);
        // Work queued before the pause began was there before it: it isn't held by it.
        yield* sql`UPDATE kin_events SET queued_at = ${pausedAt - 1} WHERE org_id = ${orgId} AND event_id = 'tech-2'`;
        assert.strictEqual(yield* reason, "not much waits for Tech lead");
        yield* sql`UPDATE kin_events SET queued_at = ${pausedAt} WHERE org_id = ${orgId} AND event_id = 'tech-2'`;
        assert.strictEqual(yield* reason, "fires");
        // Done or expired work doesn't wait, and a teammate's message isn't Rhea's.
        yield* sql`UPDATE kin_events SET state = 'done' WHERE org_id = ${orgId} AND event_id = 'tech-2'`;
        assert.strictEqual(yield* reason, "not much waits for Tech lead");
        yield* sql`UPDATE kin_events SET state = 'queued', json = '{"provenance":{"_tag":"human","personId":"meera"}}'
          WHERE org_id = ${orgId}`;
        const [teammate] = yield* asked(ctx, agentPaused);
        assert.strictEqual(
          teammate?._tag === "fires" ? teammate.candidate.noticed : "",
          "Tech lead has been paused since 28 Dec, and 3 things wait for it.",
        );
        yield* sql`UPDATE kin_agents SET paused_at = ${isoAt((yield* Clock.currentTimeMillis) - 2 * DAY)}
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.strictEqual(yield* reason, "Tech lead was paused only recently");
        yield* sql`UPDATE kin_agents SET retired_at = '1970-01-01T00:00:00.000Z'
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.deepStrictEqual(yield* asked(ctx, agentPaused), []);
        const now = yield* Clock.currentTimeMillis;
        assert.strictEqual(
          reasonOf(
            yield* agentPaused(yield* ruleContext(orgId, ctx.owner.personId, now), {
              agentId: tech,
            }),
          ),
          "Tech lead is no longer there",
        );
        // Running, nothing to say whatever waits.
        yield* sql`UPDATE kin_agents SET retired_at = NULL, paused_at = NULL
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.deepStrictEqual(yield* asked(ctx, agentPaused), []);
      }),
    ),
);

it.effect(
  "the paused agent card: Do it resumes it through the agent page's method as the owner, its row follows the agent as it is, and a card whose pause moved changes nothing for either answer",
  () =>
    run(({ ctx }) =>
      Effect.gen(function* () {
        const { sql, orgId, owner } = ctx;
        const page = (paused: boolean) =>
          LeadProvision.setPaused({ by: owner, orgId, agentId: tech, paused });
        yield* pausedTech(ctx, 4, 3);
        yield* idle(ctx);
        assert.strictEqual((yield* tick(ctx))._tag, "posted");
        const [card] = yield* cards(ctx);
        assert.strictEqual(card!.state.question, "Resume Tech lead?");
        assert.include(card!.state.detail, TECH_NOTICED);
        assert.deepStrictEqual(
          card!.state.options.map((option) => option.label),
          ["Resume Tech lead", "Not now"],
        );
        assert.deepInclude(yield* coOwnerTaps(ctx, card!.widgetId, "option-1"), {
          reason: "not_allowed",
        });
        assert.isNotNull(yield* techPausedAt(ctx));
        yield* tap(ctx, card!.widgetId, "option-1");
        assert.isNull(yield* techPausedAt(ctx));
        assert.deepStrictEqual(yield* outcomeOf(ctx), {
          title: "Done",
          text: "Tech lead is no longer paused. Tech lead's page is where you pause it.",
        });
        const open = { kind: "open_agent" as const, label: "Open Tech lead's page", agentId: tech };
        const row = Effect.map(list(ctx), (rows) => rows[0]);
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan: Tech lead is no longer paused.",
          action: open,
        });
        yield* page(true);
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan. Tech lead was paused again since.",
          action: open,
        });
        yield* sql`UPDATE kin_agents SET retired_at = '1970-01-01T11:00:00.000Z'
          WHERE org_id = ${orgId} AND agent_id = ${tech}`;
        assert.deepStrictEqual(yield* row, {
          outcome: "Done 1 Jan. Tech lead is no longer there.",
          action: null,
        });
        yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE org_id = ${orgId} AND agent_id = ${tech}`;

        // Drawn again, then resumed and paused again on its page before either tap.
        for (const option of ["option-1", "option-2"] as const) {
          yield* TestClock.adjust("24 hours");
          yield* sql`UPDATE kin_agents SET paused_at = ${isoAt((yield* Clock.currentTimeMillis) - 4 * DAY)}
            WHERE org_id = ${orgId} AND agent_id = ${tech}`;
          yield* sql`UPDATE kin_events SET state = 'queued' WHERE org_id = ${orgId} AND agent_id = ${tech}`;
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          yield* page(false);
          yield* TestClock.adjust("1 hour");
          yield* page(true);
          const repaused = yield* techPausedAt(ctx);
          yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
          assert.deepStrictEqual(yield* outcomeOf(ctx), {
            title: "Nothing changed",
            text: "Nothing changed: Tech lead was resumed and paused again since Kin drew this card.",
          });
          assert.strictEqual(yield* techPausedAt(ctx), repaused);
        }
        // Drawn again, then Kin was stopped for the whole company before either tap.
        for (const option of ["option-1", "option-2"] as const) {
          yield* TestClock.adjust("24 hours");
          yield* sql`UPDATE kin_agents SET paused_at = ${isoAt((yield* Clock.currentTimeMillis) - 4 * DAY)}
            WHERE org_id = ${orgId} AND agent_id = ${tech}`;
          yield* sql`UPDATE kin_events SET state = 'queued',
              queued_at = ${(yield* Clock.currentTimeMillis) - 4 * DAY}
            WHERE org_id = ${orgId} AND agent_id = ${tech}`;
          assert.strictEqual((yield* tick(ctx))._tag, "posted");
          yield* sql`INSERT INTO kin_org_state (org_id, paused, paused_at, paused_by, reason)
            VALUES (${orgId}, 1, 0, ${owner.personId}, 'Invented stop')
            ON CONFLICT (org_id) DO UPDATE SET paused = 1, paused_at = 0,
              paused_by = ${owner.personId}, reason = 'Invented stop'`;
          const paused = yield* techPausedAt(ctx);
          yield* tap(ctx, (yield* cards(ctx)).at(-1)!.widgetId, option);
          assert.deepStrictEqual(yield* outcomeOf(ctx), {
            title: "Nothing changed",
            text: "Nothing changed: Kin is stopped for the whole company, so Tech lead wouldn't start.",
          });
          assert.strictEqual(yield* techPausedAt(ctx), paused);
          yield* sql`UPDATE kin_org_state SET paused = 0, paused_at = NULL, paused_by = NULL,
            reason = NULL WHERE org_id = ${orgId}`;
        }
        assert.strictEqual(yield* declines(ctx), 0);
      }),
    ),
);
