import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KIN_WAITED_DONE_FIELD,
  KinAgentId,
  KinChatError,
  KinPersonId,
  KinWidgetId,
  ProviderInstanceId,
  ThreadId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import type { Services } from "../KinServer.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as KinPulse from "./KinPulse.ts";

// Invented: Rhea's Ambermill. Zoya's W-1 waits on Arjun, W-2 on Rhea; Meera is a co-owner.
const stamp = "1970-01-01T00:00:00.000Z";
const chief = KinAgentId.make("chief");
const models = JSON.stringify({ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.1" });
const ownerSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const isChatError = Schema.is(KinChatError);
const zoyaId = KinPersonId.make("zoya");
const arjunId = KinPersonId.make("arjun");
const meeraId = KinPersonId.make("meera");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Thu 19 Nov 2026, 10:00 UTC: W-1 starts waiting on Arjun. */
const THURSDAY = Date.UTC(2026, 10, 19, 10);
/** Wed 25 Nov 2026, 10:00 UTC: six days on, inside everyone's hours. */
const NOW = THURSDAY + 6 * DAY;

/** Every change on `key` as made at `at`, so it has waited since then (`waitingSince`). */
const startedWaiting = (sql: SqlClient.SqlClient, orgId: string, key: string, at: number) =>
  sql`UPDATE kin_record_changes SET at = ${at} WHERE org_id = ${orgId}
    AND record_id = (SELECT record_id FROM kin_records WHERE org_id = ${orgId} AND key = ${key})`;

const seed = Effect.fn("FactCardsTest.seed")(function* (services: Context.Context<Services>) {
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const records = Context.get(services, KinRecords);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(ownerSession.sessionId);
  const owner = (yield* identity.resolve(ownerSession))[0]!;
  const { orgId } = owner;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${stamp})`;
  const ownerChat = yield* chats.createDirect(owner, { orgId, agentId: chief });
  const threadId = ThreadId.make("chief-thread");
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id, domain, charter)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'L0', 0, ${threadId}, ${models}, '[]',
      ${ownerChat.chatId}, 'chief-of-staff', 'Runs the company.')`;
  yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
  yield* sql`UPDATE kin_people SET display_name = 'Rhea' WHERE person_id = ${owner.personId}`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
      sees_clients) VALUES (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${stamp}, 'member', 1),
      (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${stamp}, 'member', 1),
      (${meeraId}, ${orgId}, 'meera', 'Meera', ${stamp}, 'co_owner', 1)`;
  for (const person of [zoyaId, arjunId]) {
    yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
      VALUES (${orgId}, ${chief}, ${person}, ${owner.personId}, 0)`;
    // Signed in on their phones: still let in to Work (`teamGuard`).
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES (${`phone-${person}`}, ${orgId}, ${person}, ${stamp})`;
  }
  // The company's clock and everyone's own: UTC, whatever zone the tests run in.
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')
    ON CONFLICT (org_id) DO UPDATE SET time_zone = 'UTC'`;
  yield* sql`UPDATE kin_people SET time_zone = 'UTC' WHERE org_id = ${orgId}`;
  const byOwner = {
    actor: { _tag: "person" as const, personId: owner.personId },
    via: "owner" as const,
  };
  const person = (personId: KinPersonId): PersonIdentity => ({ _tag: "person", orgId, personId });
  const zoya: KinWorkPrincipal = { _tag: "person", personId: zoyaId };
  const task = (title: string, waitingOn: KinPersonId) =>
    Effect.gen(function* () {
      const made = yield* records.create(orgId, byOwner, {
        title,
        owner: zoya,
        originKey: title,
        team: true,
      });
      yield* records.update(orgId, byOwner, made.row.key, {
        state: "waiting",
        waitingOn: { _tag: "person", personId: waitingOn },
      });
      return made.row.key;
    });
  const quote = yield* task("Revised pilot quote", arjunId);
  const brief = yield* task("Pilot brief sign-off", owner.personId);
  for (const key of [quote, brief]) yield* startedWaiting(sql, orgId, key, THURSDAY);
  return { services, sql, orgId, owner, chats, records, person, byOwner, quote, brief };
});
const setup = Effect.gen(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  return yield* seed(services).pipe(Effect.provideContext(services));
});
type Ctx = Effect.Success<typeof setup>;

/** Kin starts at 03:00 on the day, inside everyone's quiet hours: its clock only moves hours. */
const run = <A, E>(test: (ctx: Ctx) => Effect.Effect<A, E, SqlClient.SqlClient | Services>) =>
  Effect.andThen(
    TestClock.setTime(NOW - 7 * HOUR),
    Effect.gen(function* () {
      const ctx = yield* setup;
      return yield* test(ctx).pipe(Effect.provideContext(ctx.services));
    }).pipe(
      Effect.provide(
        Kin.layer.pipe(
          Layer.provide(kinSecretsTest),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
          Layer.provideMerge(environment),
          Layer.provideMerge(authorityLayer),
        ),
      ),
    ),
  );

type Card = {
  readonly widgetId: KinWidgetId;
  readonly who: string;
  readonly closed: boolean;
  readonly question: string;
  readonly labels: ReadonlyArray<string>;
  readonly lines: ReadonlyArray<string | undefined>;
  readonly outcome: { readonly title: string; readonly text: string } | undefined;
};
/** Kin's cards about facts, oldest first, with whose direct chat each is in. */
const cards = (ctx: Ctx) =>
  ctx.sql<{ widgetId: string; who: string; closedAt: string | null; state: string }>`SELECT
      DISTINCT w.widget_id AS "widgetId", m.person_id AS who, w.closed_at AS "closedAt",
      w.state_json AS state, msg.seq
    FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
    JOIN kin_messages msg ON msg.org_id = w.org_id AND msg.message_id = w.message_id
    JOIN kin_chat_members m ON m.org_id = w.org_id AND m.chat_id = w.chat_id
      AND m.principal_kind = 'person'
    WHERE p.org_id = ${ctx.orgId} AND json_extract(p.plan_json, '$.factKey') IS NOT NULL
    ORDER BY msg.seq, w.widget_id`.pipe(
    Effect.map((rows) =>
      rows.map((row): Card => {
        const state = JSON.parse(row.state) as {
          question: string;
          options: ReadonlyArray<{ label: string; action?: { line: string } }>;
          outcome?: { title: string; text: string };
        };
        return {
          widgetId: KinWidgetId.make(row.widgetId),
          who: row.who,
          closed: row.closedAt !== null,
          question: state.question,
          labels: state.options.map((option) => option.label),
          lines: state.options.map((option) => option.action?.line),
          outcome: state.outcome,
        };
      }),
    ),
  );
const tap = (ctx: Ctx, personId: KinPersonId, card: Card, label: string) =>
  ctx.chats.act(ctx.person(personId), {
    widgetId: card.widgetId,
    revision: 1,
    actionId: "choose",
    value: `option-${card.labels.indexOf(label) + 1}`,
    clientActionId: `${card.widgetId}:${personId}:${label}`,
  });
/** A pass of the pulse as of `at`; who is in their hours is read from Kin's own clock. */
const tickAt = (ctx: Ctx, at: number) => KinPulse.tick(ctx.orgId, at);
/** Kin's own notices in someone's direct chat with the Chief of staff, oldest first. */
const noticesTo = (ctx: Ctx, personId: KinPersonId) =>
  ctx.sql<{ body: string }>`SELECT m.body FROM kin_messages m
    JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${ctx.orgId} AND c.direct_key = ${`${personId}:${chief}`}
      AND m.author_kind = 'system' AND m.status = 'posted'
    ORDER BY m.seq`.pipe(Effect.map((rows) => rows.map((row) => row.body)));
/** Whether the owner's Needs attention holds an open fact about `key` of this sense. */
const ownerSees = (ctx: Ctx, sense: string, key: string, at: number) =>
  KinPulse.read({ orgId: ctx.orgId, at, viewer: { _tag: "owner" }, limit: 200 }).pipe(
    Effect.map((read) =>
      read.facts.some((fact) => fact.sense === sense && fact.subject.key === key),
    ),
  );
const freshDay = (ctx: Ctx) => ctx.sql`DELETE FROM kin_pulse_nudges WHERE org_id = ${ctx.orgId}`;
const waitOnArjun = (ctx: Ctx) =>
  ctx.records.update(ctx.orgId, ctx.byOwner, "W-1", {
    state: "waiting",
    waitingOn: { _tag: "person", personId: arjunId },
  });

it.effect(
  "a teammate waited on too long gets one card, never the owner level; By a day hides it from the owner's check-in until that day ends and tells the holder once; only they may answer",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        assert.deepStrictEqual([ctx.quote, ctx.brief], ["W-1", "W-2"]);
        // 03:00 is inside their quiet hours: nothing yet; the next pass in their hours posts it.
        yield* tickAt(ctx, NOW - 7 * HOUR);
        assert.deepStrictEqual(yield* cards(ctx), []);
        yield* TestClock.setTime(NOW);
        yield* tickAt(ctx, NOW);
        yield* tickAt(ctx, NOW + HOUR);
        const [card, ...more] = yield* cards(ctx);
        assert.deepStrictEqual(more, []);
        assert.strictEqual(card!.who, arjunId);
        assert.strictEqual(
          card!.question,
          "Zoya's W-1 Revised pilot quote has waited on you for 6 days. Where is it?",
        );
        assert.deepStrictEqual(card!.labels, ["Done", "By Thu 26 Nov", "By Wed 2 Dec", "Not mine"]);
        assert.deepStrictEqual(card!.lines, [
          "W-1 goes back to Zoya, who is told you said it's done",
          "Zoya is told; it comes back after Thu 26 Nov if it still waits on you",
          "Zoya is told; it comes back after Wed 2 Dec if it still waits on you",
          "Zoya is told it doesn't wait on you, to change who it does",
        ]);
        // It is Arjun's nudge of the day, so an agent's text nudge waits for tomorrow.
        const [nudged] = yield* ctx.sql<{ factKey: string }>`SELECT fact_key AS "factKey"
          FROM kin_pulse_nudges WHERE org_id = ${ctx.orgId} AND person_id = ${arjunId}`;
        assert.match(nudged!.factKey, /^waiting_long:W-1:/);

        // Only Arjun answers it: Zoya's tap is refused and the card stays open.
        const refused = yield* tap(ctx, zoyaId, card!, "Done").pipe(
          Effect.flip,
          Effect.map((error) => (isChatError(error) ? error.reason : "not a refusal")),
        );
        assert.notStrictEqual(refused, "not a refusal");
        assert.isFalse((yield* cards(ctx))[0]!.closed);

        assert.isTrue(yield* ownerSees(ctx, "waiting_long", "W-1", NOW + HOUR));
        yield* tap(ctx, arjunId, card!, "By Thu 26 Nov");
        assert.deepStrictEqual((yield* cards(ctx))[0]!.outcome, {
          title: "Told Zoya",
          text: "W-1 comes back after Thu 26 Nov if it still waits on you.",
        });
        assert.isFalse(yield* ownerSees(ctx, "waiting_long", "W-1", NOW + 2 * HOUR));
        assert.isFalse(yield* ownerSees(ctx, "waiting_long", "W-1", Date.UTC(2026, 10, 26, 23)));
        assert.isTrue(yield* ownerSees(ctx, "waiting_long", "W-1", Date.UTC(2026, 10, 27, 1)));
        assert.deepStrictEqual(yield* noticesTo(ctx, zoyaId), [
          "Arjun says W-1 Revised pilot quote will have what it waits on by Thu 26 Nov.",
        ]);
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, "W-1"))?.state, "waiting");
        // Once per wait: back on Friday, it is told as today and asked no more.
        yield* freshDay(ctx);
        yield* tickAt(ctx, Date.UTC(2026, 10, 27, 10));
        assert.strictEqual((yield* cards(ctx)).length, 1);
      }),
    ),
);

it.effect(
  "Done puts the teammate's task back to open and nothing else, its history saying who and from which card, and tells its holder; a tap after the task changed does nothing; a card whose fact cleared closes",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        yield* tickAt(ctx, NOW);
        const [card] = yield* cards(ctx);
        const before = yield* ctx.records.get(ctx.orgId, "W-1");
        yield* tap(ctx, arjunId, card!, "Done");
        const after = yield* ctx.records.get(ctx.orgId, "W-1");
        assert.strictEqual(after?.state, "open");
        assert.deepStrictEqual(
          [after?.ownerId, after?.dueAt, after?.title],
          [before?.ownerId, before?.dueAt, before?.title],
        );
        const [change] = yield* ctx.sql<{ actor: string; fields: string }>`SELECT
            c.actor_id AS actor, c.fields_json AS fields FROM kin_record_changes c
          WHERE c.org_id = ${ctx.orgId} AND c.record_id = ${after!.recordId}
          ORDER BY c.seq DESC LIMIT 1`;
        assert.strictEqual(change!.actor, arjunId);
        const fields = JSON.parse(change!.fields) as ReadonlyArray<{ field: string; to: string }>;
        assert.strictEqual(
          fields.find((one) => one.field === KIN_WAITED_DONE_FIELD)?.to,
          card!.widgetId,
        );
        assert.deepStrictEqual((yield* cards(ctx))[0]!.outcome, {
          title: "Told Zoya",
          text: "W-1 is back with Zoya.",
        });
        assert.deepStrictEqual(yield* noticesTo(ctx, zoyaId), [
          "Arjun says what W-1 Revised pilot quote waited on is done, so it is back with you.",
        ]);

        // It waits on him again, and changes after its card was posted: the tap does nothing.
        yield* waitOnArjun(ctx);
        yield* startedWaiting(ctx.sql, ctx.orgId, "W-1", NOW - 7 * DAY);
        yield* freshDay(ctx);
        yield* tickAt(ctx, NOW + HOUR);
        const second = (yield* cards(ctx)).find((one) => !one.closed)!;
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, "W-1", { notes: "Cost sheet v2" });
        yield* tap(ctx, arjunId, second, "Not mine");
        assert.deepStrictEqual(
          (yield* cards(ctx)).find((one) => one.widgetId === second.widgetId)?.outcome,
          {
            title: "Nothing was done",
            text: "W-1 changed since this was offered, so nothing was done.",
          },
        );

        // And again: Zoya stops it waiting before anyone answers, and its card closes saying why.
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, "W-1", { state: "open" });
        yield* waitOnArjun(ctx);
        yield* startedWaiting(ctx.sql, ctx.orgId, "W-1", NOW - 8 * DAY);
        yield* freshDay(ctx);
        yield* tickAt(ctx, NOW + 2 * HOUR);
        const third = (yield* cards(ctx)).find((one) => !one.closed)!;
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, "W-1", { state: "doing" });
        yield* tickAt(ctx, NOW + 3 * HOUR);
        assert.deepStrictEqual(
          (yield* cards(ctx)).find((one) => one.widgetId === third.widgetId)?.outcome,
          { title: "No longer needed", text: "W-1 no longer waits on you." },
        );
      }),
    ),
);

it.effect("no card while an agent already nudged them today, nor on a task they can't see", () =>
  run((ctx) =>
    Effect.gen(function* () {
      const chat = yield* ctx.chats.createDirect(ctx.person(arjunId), {
        orgId: ctx.orgId,
        agentId: chief,
      });
      yield* ctx.sql`INSERT INTO kin_pulse_nudges (org_id, person_id, day, agent_id, chat_id,
          fact_key, sent_at)
        VALUES (${ctx.orgId}, ${arjunId}, '2026-11-25', ${chief}, ${chat.chatId}, 'other',
          ${NOW - HOUR})`;
      yield* TestClock.setTime(NOW);
      yield* tickAt(ctx, NOW);
      assert.deepStrictEqual(yield* cards(ctx), []);
      yield* ctx.records.update(ctx.orgId, ctx.byOwner, "W-1", { sensitive: true });
      yield* freshDay(ctx);
      yield* tickAt(ctx, NOW + HOUR);
      assert.deepStrictEqual(yield* cards(ctx), []);
    }),
  ),
);

/** A task `holder` started on at `since`, with no change after it. */
const inProgress = (ctx: Ctx, title: string, holder: KinPersonId, since: number) =>
  Effect.gen(function* () {
    const made = yield* ctx.records.create(ctx.orgId, ctx.byOwner, {
      title,
      owner: { _tag: "person", personId: holder },
      originKey: title,
      team: true,
    });
    yield* ctx.records.update(ctx.orgId, ctx.byOwner, made.row.key, { state: "doing" });
    yield* startedWaiting(ctx.sql, ctx.orgId, made.row.key, since);
    return made.row.key;
  });
/** Whether a tap's message wakes the card's agent: one Kin finished itself says `handled`. */
const wakesAgent = (message: { readonly body: string }) =>
  (JSON.parse(message.body) as { handled?: boolean }).handled !== true;

it.effect(
  "a task a teammate holds in progress with no change gets one card: Still on it holds it and Kin asks again on its day, Done marks it done, Stuck wakes the agent; a change closes it; none for the owner's own",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        // Started on Friday and untouched: 4 days, past the playbook's 3. Rhea's own is hers.
        const guide = yield* inProgress(ctx, "Draft onboarding guide", zoyaId, NOW - 4 * DAY);
        yield* inProgress(ctx, "Board pack", ctx.owner.personId, NOW - 4 * DAY);
        for (const key of ["W-1", "W-2"])
          yield* ctx.records.update(ctx.orgId, ctx.byOwner, key, { state: "done" });
        yield* tickAt(ctx, NOW);
        const [card, ...more] = yield* cards(ctx);
        assert.deepStrictEqual(more, []);
        assert.strictEqual(card!.who, zoyaId);
        assert.strictEqual(
          card!.question,
          `${guide} Draft onboarding guide has been in progress with no change for 4 days. Where is it?`,
        );
        assert.deepStrictEqual(card!.labels, ["Still on it", "Done", "Stuck"]);
        assert.deepStrictEqual(card!.lines, [
          "Kin asks again on Sat 28 Nov if it hasn't moved",
          `Mark ${guide} done`,
          undefined,
        ]);
        assert.isFalse(wakesAgent(yield* tap(ctx, zoyaId, card!, "Still on it")));
        assert.deepStrictEqual((yield* cards(ctx))[0]!.outcome, {
          title: "Noted",
          text: `Kin asks again on Sat 28 Nov if ${guide} hasn't moved.`,
        });
        assert.isFalse(yield* ownerSees(ctx, "task_stalled", guide, NOW + HOUR));
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, guide))?.state, "doing");

        // On Saturday it still hasn't moved: Kin asks once more, and Done closes the task.
        yield* freshDay(ctx);
        yield* tickAt(ctx, NOW + 3 * DAY + HOUR);
        const again = (yield* cards(ctx)).find((one) => !one.closed)!;
        assert.notStrictEqual(again.widgetId, card!.widgetId);
        yield* tap(ctx, zoyaId, again, "Done");
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, guide))?.state, "done");
        assert.deepStrictEqual(
          (yield* cards(ctx)).find((one) => one.widgetId === again.widgetId)?.outcome,
          { title: "Marked done", text: `${guide} is done.` },
        );

        // Stuck is the person's own answer: the Chief of staff is woken by the tap to ask.
        const site = yield* inProgress(ctx, "Plan the second site", zoyaId, NOW - 4 * DAY);
        yield* freshDay(ctx);
        yield* tickAt(ctx, NOW + 3 * DAY + 2 * HOUR);
        const stuck = (yield* cards(ctx)).find((one) => !one.closed)!;
        assert.isTrue(wakesAgent(yield* tap(ctx, zoyaId, stuck, "Stuck")));
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, site))?.state, "doing");

        // A change on the task before anyone answers closes its card.
        const deck = yield* inProgress(ctx, "Pilot deck", zoyaId, NOW - 4 * DAY);
        yield* freshDay(ctx);
        yield* tickAt(ctx, NOW + 3 * DAY + 3 * HOUR);
        const moved = (yield* cards(ctx)).find((one) => !one.closed)!;
        assert.match(moved.question, new RegExp(`^${deck} Pilot deck`));
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, deck, { notes: "Slides 1-6 drafted" });
        yield* tickAt(ctx, NOW + 3 * DAY + 4 * HOUR);
        assert.deepStrictEqual(
          (yield* cards(ctx)).find((one) => one.widgetId === moved.widgetId)?.outcome,
          { title: "No longer needed", text: `${deck} moved on.` },
        );
      }),
    ),
);

/** Thu 26, Fri 27 and Mon 30 Nov 2026, 17:00 UTC: the milestone is due inside its 3-day heads-up. */
const NOV_26 = Date.UTC(2026, 10, 26, 17);
const NOV_27 = Date.UTC(2026, 10, 27, 17);
const NOV_30 = Date.UTC(2026, 10, 30, 17);
/** A project `holder` leads, with one milestone due `dueAt` and its open tasks due as given. */
const plan = (
  ctx: Ctx,
  title: string,
  holder: KinWorkPrincipal,
  dueAt: number,
  tasks: ReadonlyArray<{ readonly title: string; readonly dueAt?: number }>,
) =>
  Effect.gen(function* () {
    const project = yield* ctx.records.create(ctx.orgId, ctx.byOwner, {
      list: "projects",
      title: `${title} project`,
      owner: holder,
      originKey: `${title} project`,
    });
    const milestone = yield* ctx.records.create(ctx.orgId, ctx.byOwner, {
      list: "milestones",
      title,
      owner: holder,
      projectId: project.row.recordId,
      dueAt,
      originKey: title,
    });
    const keys: Array<string> = [];
    for (const task of tasks) {
      const made = yield* ctx.records.create(ctx.orgId, ctx.byOwner, {
        title: task.title,
        owner: { _tag: "person", personId: zoyaId },
        originKey: task.title,
        team: true,
        projectId: project.row.recordId,
        ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
      });
      yield* ctx.sql`UPDATE kin_records
        SET fields_json = json_set(fields_json, '$.milestone', ${milestone.row.key})
        WHERE org_id = ${ctx.orgId} AND record_id = ${made.row.recordId}`;
      keys.push(made.row.key);
    }
    return { project: project.row.key, milestone: milestone.row.key, tasks: keys };
  });

it.effect(
  "a slipping milestone whose open tasks all have a day ahead gets one card proposing the last one's; Move changes only its day, Leave it holds the fact; told by the card, not the check-in; none when a task is late or has no day",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        for (const key of ["W-1", "W-2"])
          yield* ctx.records.update(ctx.orgId, ctx.byOwner, key, { state: "done" });
        const rhea: KinWorkPrincipal = { _tag: "person", personId: ctx.owner.personId };
        const live = yield* plan(ctx, "Pilot live", rhea, NOV_27, [
          { title: "Wire the feed", dueAt: NOV_26 },
          { title: "Load test", dueAt: NOV_30 },
        ]);
        yield* plan(ctx, "Pilot data", rhea, NOV_27, [
          { title: "Clean the import", dueAt: NOW - DAY },
          { title: "Check the totals", dueAt: NOV_30 },
        ]);
        yield* plan(ctx, "Pilot docs", rhea, NOV_27, [
          { title: "Write the guide" },
          { title: "Record the walkthrough", dueAt: NOV_30 },
        ]);
        const kept = yield* plan(ctx, "Pilot review", rhea, NOV_27, [
          { title: "Book the room", dueAt: NOV_30 },
        ]);
        yield* tickAt(ctx, NOW);
        const shown = yield* cards(ctx);
        assert.deepStrictEqual(
          shown.map((card) => [card.who, card.question]),
          [
            [
              ctx.owner.personId,
              `${live.milestone} Pilot live is due Fri 27 Nov, but its last open task, ${live.tasks[1]} Load test, is due Mon 30 Nov. Move ${live.milestone} to Mon 30 Nov?`,
            ],
            [
              ctx.owner.personId,
              `${kept.milestone} Pilot review is due Fri 27 Nov, but its last open task, ${kept.tasks[0]} Book the room, is due Mon 30 Nov. Move ${kept.milestone} to Mon 30 Nov?`,
            ],
          ],
        );
        assert.deepStrictEqual(shown[0]!.labels, ["Move to Mon 30 Nov", "Leave it"]);
        assert.deepStrictEqual(shown[0]!.lines, [
          `${live.milestone}'s due day becomes Mon 30 Nov; its tasks don't change`,
          `${live.milestone} stays due Fri 27 Nov; Kin doesn't ask again for this day`,
        ]);
        // Told to Rhea by the card: her check-in has nothing more to tell of it.
        const told = yield* ctx.sql<{ factKey: string }>`SELECT fact_key AS "factKey"
          FROM kin_pulse_told WHERE org_id = ${ctx.orgId} AND person_id = ${ctx.owner.personId}
            AND fact_key LIKE 'milestone_at_risk:%' ORDER BY fact_key`;
        assert.deepStrictEqual(
          told.map((row) => row.factKey.split(":due=")[0]),
          [`milestone_at_risk:${live.milestone}`, `milestone_at_risk:${kept.milestone}`],
        );

        yield* tap(ctx, ctx.owner.personId, shown[0]!, "Move to Mon 30 Nov");
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, live.milestone))?.dueAt, NOV_30);
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, live.tasks[1]!))?.dueAt, NOV_30);
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, live.tasks[0]!))?.dueAt, NOV_26);
        assert.deepStrictEqual((yield* cards(ctx))[0]!.outcome, {
          title: "Milestone moved",
          text: `${live.milestone} Pilot live is due Mon 30 Nov.`,
        });
        assert.isFalse(yield* ownerSees(ctx, "milestone_at_risk", live.milestone, NOW + HOUR));

        yield* tap(ctx, ctx.owner.personId, shown[1]!, "Leave it");
        assert.deepStrictEqual((yield* cards(ctx))[1]!.outcome, {
          title: "Left as it is",
          text: `${kept.milestone} stays due Fri 27 Nov.`,
        });
        assert.isFalse(yield* ownerSees(ctx, "milestone_at_risk", kept.milestone, NOW + HOUR));
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, kept.milestone))?.dueAt, NOV_27);
        yield* tickAt(ctx, NOW + HOUR);
        assert.strictEqual((yield* cards(ctx)).length, 2);
      }),
    ),
);

it.effect(
  "the project's teammate lead gets the card; an agent's project goes to the owner in that agent's chat; a task moved since makes the tap do nothing",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        for (const key of ["W-1", "W-2"])
          yield* ctx.records.update(ctx.orgId, ctx.byOwner, key, { state: "done" });
        const zoya: KinWorkPrincipal = { _tag: "person", personId: zoyaId };
        const hers = yield* plan(ctx, "Pilot live", zoya, NOV_27, [
          { title: "Load test", dueAt: NOV_30 },
        ]);
        const agents = yield* plan(ctx, "Pilot data", { _tag: "agent", agentId: chief }, NOV_27, [
          { title: "Check the totals", dueAt: NOV_30 },
        ]);
        yield* tickAt(ctx, NOW);
        const shown = (yield* cards(ctx)).toSorted((a, b) => a.question.localeCompare(b.question));
        assert.deepStrictEqual(
          shown.map((card) => [card.who, card.question.split(" ")[0]]),
          [
            [zoyaId, hers.milestone],
            [ctx.owner.personId, agents.milestone],
          ],
        );
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, hers.tasks[0]!, {
          dueAt: NOV_30 + DAY,
        });
        yield* tap(ctx, zoyaId, shown[0]!, "Move to Mon 30 Nov");
        const after = (yield* cards(ctx)).find((card) => card.widgetId === shown[0]!.widgetId);
        assert.deepStrictEqual(after!.outcome, {
          title: "Nothing was done",
          text: `${hers.milestone} or its tasks changed since this was offered, so nothing was done.`,
        });
        assert.strictEqual((yield* ctx.records.get(ctx.orgId, hers.milestone))?.dueAt, NOV_27);

        // Rhea moves the agent's milestone herself: its card closes, saying why.
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, agents.milestone, { dueAt: NOV_30 });
        yield* tickAt(ctx, NOW + HOUR);
        assert.deepStrictEqual(
          (yield* cards(ctx)).find((card) => card.widgetId === shown[1]!.widgetId)?.outcome,
          { title: "No longer needed", text: `${agents.milestone} no longer needs a new date.` },
        );
      }),
    ),
);

/** Whether `personId`'s own Needs attention holds an open fact about `key` of this sense. */
const personSees = (ctx: Ctx, personId: KinPersonId, sense: string, key: string, at: number) =>
  KinPulse.read({
    orgId: ctx.orgId,
    at,
    viewer: { _tag: "people", people: [personId] },
    limit: 200,
  }).pipe(
    Effect.map((read) =>
      read.facts.some((fact) => fact.sense === sense && fact.subject.key === key),
    ),
  );

it.effect(
  "a teammate's Leave it is their own handling: it leaves the owner's check-in telling the slip",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        for (const key of ["W-1", "W-2"])
          yield* ctx.records.update(ctx.orgId, ctx.byOwner, key, { state: "done" });
        const hers = yield* plan(ctx, "Pilot live", { _tag: "person", personId: zoyaId }, NOV_27, [
          { title: "Load test", dueAt: NOV_30 },
        ]);
        yield* tickAt(ctx, NOW);
        const [card] = yield* cards(ctx);
        assert.strictEqual(card!.who, zoyaId);
        yield* tap(ctx, zoyaId, card!, "Leave it");
        assert.isFalse(
          yield* personSees(ctx, zoyaId, "milestone_at_risk", hers.milestone, NOW + HOUR),
        );
        assert.isTrue(yield* ownerSees(ctx, "milestone_at_risk", hers.milestone, NOW + HOUR));
        const [held] = yield* ctx.sql<{ kind: string; id: string }>`SELECT
            handled_by_kind AS kind, handled_by_id AS id FROM kin_pulse_facts
          WHERE org_id = ${ctx.orgId} AND fact_key LIKE ${`milestone_at_risk:${hers.milestone}:%`}`;
        assert.deepStrictEqual(held, { kind: "person", id: zoyaId });
      }),
    ),
);

it.effect(
  "a milestone card never names a task its teammate reader can't see: it says only when its open tasks are due",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        for (const key of ["W-1", "W-2"])
          yield* ctx.records.update(ctx.orgId, ctx.byOwner, key, { state: "done" });
        const hers = yield* plan(ctx, "Pilot live", { _tag: "person", personId: zoyaId }, NOV_27, [
          { title: "Load test", dueAt: NOV_26 },
          { title: "Salary review prep", dueAt: NOV_30 },
        ]);
        yield* ctx.records.update(ctx.orgId, ctx.byOwner, hers.tasks[1]!, {
          owner: { _tag: "person", personId: ctx.owner.personId },
          sensitive: true,
        });
        yield* tickAt(ctx, NOW);
        const [card] = yield* cards(ctx);
        assert.strictEqual(card!.who, zoyaId);
        assert.strictEqual(
          card!.question,
          `${hers.milestone} Pilot live is due Fri 27 Nov, but its open tasks are due by Mon 30 Nov. Move ${hers.milestone} to Mon 30 Nov?`,
        );
      }),
    ),
);
