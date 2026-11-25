import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Cache from "../memory/MemoryCache.ts";
import * as Queue from "./KinEventQueue.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import * as Budget from "./KinBudget.ts";
import { seed, orgId, agentId } from "./WakeupRunner.testkit.ts";

const database = Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = Budget.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Queue.layer, Cache.layer, Hub.layer).pipe(Layer.provideMerge(Chat.layer)),
  ),
  Layer.provideMerge(database),
);
const owner = [{ _tag: "person" as const, orgId, personId: KinPersonId.make("owner") }];
const usage = [
  {
    providerTurnId: "turn",
    usedTokens: 30,
    turnTokenUsage: {
      usageScope: "main_agent" as const,
      usageStatus: "complete" as const,
      hasSubagents: false,
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 10,
    },
  },
];

describe("KinBudget", () => {
  it.effect(
    "enforces every threshold boundary, worker headroom, and once-daily exhaustion notice",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const budget = yield* Budget.KinBudget;
        const sql = yield* SqlClient.SqlClient;
        // A retired lead that sorts first must not receive the notice.
        const at = "1970-01-01T00:00:00.000Z";
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at)
          VALUES ('a-retired', ${orgId}, 'Old', 'lead', 'owner', ${at}, ${at})`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('retired-chat', ${orgId}, 'team_group', 0, ${at})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          SELECT 'a-retired', org_id, 'Old', level_since, models_json, worker_projects_json, 'retired-chat' FROM kin_leads WHERE org_id = ${orgId}`;
        yield* budget.set(owner, { orgId, limits: { leadUnits: 100, workerUnits: 10 } });
        for (const [remaining, allowed] of [
          [100, [true, true, true, true, true]],
          [41, [true, true, true, true, true]],
          [40, [true, true, true, false, true]],
          [31, [true, true, true, false, true]],
          [30, [true, true, true, false, false]],
          [20, [true, true, true, false, false]],
          [19, [true, true, false, false, false]],
          [0, [true, false, false, false, false]],
        ] as const) {
          yield* sql`UPDATE kin_budget SET lead_units = ${100 - remaining} WHERE org_id = ${orgId}`;
          const admissions = yield* Effect.forEach(["P0", "P1", "P2", "P3", "P4"] as const, (p) =>
            budget.admit(orgId, p),
          );
          assert.deepStrictEqual(
            admissions.map((a) => a.allowed),
            [...allowed],
            `${remaining}%`,
          );
          assert.isTrue(admissions.every((a) => a.atLimit === (remaining === 0)));
        }
        assert.isTrue(yield* budget.admitTask(orgId));
        yield* sql`UPDATE kin_budget SET worker_units = 10 WHERE org_id = ${orgId}`;
        assert.isFalse(yield* budget.admitTask(orgId));
        yield* budget.notifyOwner(orgId, "org");
        yield* budget.notifyOwner(orgId, "org");
        assert.deepStrictEqual(
          yield* sql`SELECT chat_id FROM kin_messages WHERE org_id = ${orgId} ORDER BY message_id`,
          [{ chat_id: "owner-chat" }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT exhausted_notified_at FROM kin_budget WHERE org_id = ${orgId} ORDER BY day`,
          [{ exhausted_notified_at: 0 }],
        );
        yield* budget.set(owner, { orgId, limits: { leadUnits: 200, workerUnits: 20 } });
        assert.isTrue((yield* budget.admit(orgId, "P3")).allowed);
        yield* budget.set(owner, { orgId, limits: { leadUnits: 0, workerUnits: 0 } });
        assert.isFalse(yield* budget.admitTask(orgId));
        assert.strictEqual(
          (yield* sql`SELECT message_id FROM kin_messages WHERE org_id = ${orgId} ORDER BY message_id`)
            .length,
          1,
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("resets at owner-local midnight across both DST transitions", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'America/New_York', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
      for (const [start, reset, hours] of [
        ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
        ["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
      ] as const) {
        yield* TestClock.setTime(Date.parse(start));
        const before = yield* budget.get(orgId);
        yield* sql`UPDATE kin_budget SET lead_units = 2000000 WHERE org_id = ${orgId} AND day = ${before.day}`;
        assert.strictEqual((yield* budget.admit(orgId, "P3")).nextReset, Date.parse(reset));
        yield* TestClock.adjust(`${hours} hours`);
        const after = yield* budget.get(orgId);
        assert.notEqual(after.day, before.day);
        assert.strictEqual(after.leadUnits, 0);
        assert.isTrue((yield* budget.admit(orgId, "P3")).allowed);
      }
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "charges fractional cached usage atomically once, preserving identical retries across days",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const budget = yield* Budget.KinBudget;
        const wakeupId = KinWakeupId.make("wakeup");
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'running', '[]')`;
        const first = yield* budget.charge({ orgId, wakeupId, usage });
        assert.strictEqual(first.units, 55.5);
        // The owner sees how much of the day's input the provider's cache served.
        assert.include(yield* budget.get(orgId), { inputTokens: 20, cachedInputTokens: 5 });
        assert.deepStrictEqual(yield* budget.charge({ orgId, wakeupId, usage }), first);
        yield* TestClock.adjust("1 day");
        assert.deepStrictEqual(yield* budget.charge({ orgId, wakeupId, usage }), first);
        assert.strictEqual((yield* budget.get(orgId)).leadUnits, 0);
        assert.deepStrictEqual(
          yield* sql`SELECT lead_units FROM kin_budget WHERE org_id = ${orgId} ORDER BY day`,
          [{ lead_units: 55.5 }, { lead_units: 0 }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT tokens_json FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY wakeup_id`,
          [{ tokens_json: first.tokensJson }],
        );
        const full = [
          { ...usage[0]!, turnTokenUsage: { ...usage[0]!.turnTokenUsage, outputTokens: 11 } },
        ];
        const updated = yield* budget.charge({ orgId, wakeupId, usage: full });
        assert.strictEqual(updated.units, 59.5);
        assert.deepStrictEqual(yield* budget.charge({ orgId, wakeupId, usage: full }), updated);
        assert.strictEqual((yield* budget.get(orgId)).leadUnits, 4);
        // A delegated task's thread bills task units only, and only what it grew by.
        const task = ThreadId.make("invented-task-thread");
        const billed = yield* budget.chargeTask({ orgId, threadId: task, usage });
        assert.deepStrictEqual(yield* budget.chargeTask({ orgId, threadId: task, usage }), billed);
        yield* budget.chargeTask({ orgId, threadId: task, usage: full });
        assert.include(yield* budget.get(orgId), { leadUnits: 4, workerUnits: 59.5 });
        // A nightly dream's turn bills the agents' units, once, and only what it grew by.
        const dream = ThreadId.make("kin-dream:invented:extract");
        const dreamed = yield* budget.chargeDream({ orgId, threadId: dream, usage });
        assert.deepStrictEqual(
          yield* budget.chargeDream({ orgId, threadId: dream, usage }),
          dreamed,
        );
        yield* budget.chargeDream({ orgId, threadId: dream, usage: full });
        assert.include(yield* budget.get(orgId), { leadUnits: 63.5, workerUnits: 59.5 });
        assert.include(
          yield* budget
            .charge({ orgId: KinOrgId.make("foreign"), wakeupId, usage })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("keeps one daily figure per org and shows each lead's use, in the notice too", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const budget = yield* Budget.KinBudget;
      const wakeupId = KinWakeupId.make("wakeup");
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'running', '[]')`;
      yield* budget.charge({ orgId, wakeupId, usage });
      // One daily figure for the org, with each lead's share; the notice names them.
      const at = "1970-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('growth', ${orgId}, 'Growth', 'lead', 'owner', ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id, domain)
        SELECT 'growth', org_id, 'Growth', level_since, models_json, worker_projects_json, owner_chat_id, 'growth'
        FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      const growthWakeup = KinWakeupId.make("growth-wakeup");
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${growthWakeup}, 'growth', 'cheap', 0, 'completed', '[]')`;
      yield* budget.charge({
        orgId,
        wakeupId: growthWakeup,
        usage: [...usage, { ...usage[0]!, providerTurnId: "turn-2" }],
      });
      const shared = yield* budget.get(orgId);
      assert.strictEqual(shared.leadUnits, 166.5);
      assert.deepStrictEqual(shared.leads, [
        { agentId: KinAgentId.make("growth"), name: "Growth", leadUnits: 111 },
        { agentId, name: "Lead", leadUnits: 55.5 },
      ]);
      yield* budget.set(owner, { orgId, limits: { leadUnits: 100, workerUnits: 10 } });
      yield* budget.notifyOwner(orgId, "org");
      const [notice] = yield* sql<{
        body: string;
      }>`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY message_id`;
      assert.include(notice?.body, "Used today: Growth 67%, Lead 33%.");
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "charges partial retries only by their positive delta and tolerates unusable usage",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const budget = yield* Budget.KinBudget;
        const cases = [
          {
            id: "partial",
            usedTokens: 30,
            turnTokenUsage: { ...usage[0]!.turnTokenUsage, usageStatus: "partial" as const },
            units: 30,
          },
          { id: "missing-fields", usedTokens: 30, turnTokenUsage: undefined, units: 30 },
          {
            id: "unavailable",
            usedTokens: 30,
            turnTokenUsage: { ...usage[0]!.turnTokenUsage, usageStatus: "unavailable" as const },
            units: 30,
          },
          { id: "no-usage", usedTokens: undefined, turnTokenUsage: undefined, units: 0 },
          {
            id: "pi-normalized",
            usedTokens: 150,
            turnTokenUsage: {
              ...usage[0]!.turnTokenUsage,
              inputTokens: 140,
              cachedInputTokens: 100,
            },
            units: 90,
          },
          {
            id: "clamp",
            usedTokens: undefined,
            turnTokenUsage: { ...usage[0]!.turnTokenUsage, cachedInputTokens: 100 },
            units: 42,
          },
          {
            id: "other-usage",
            usedTokens: undefined,
            turnTokenUsage: {
              ...usage[0]!.turnTokenUsage,
              otherUsage: { inputTokens: 10, outputTokens: 2 },
            },
            units: 73.5,
          },
          ...[-1, NaN, Infinity].map((bad, i) => ({
            id: `garbage-${i}`,
            usedTokens: 30,
            turnTokenUsage: { ...usage[0]!.turnTokenUsage, inputTokens: bad },
            units: 30,
          })),
        ];
        for (const row of cases) {
          const wakeupId = KinWakeupId.make(row.id);
          yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'running', '[]')`;
          const turn = [
            {
              providerTurnId: row.id,
              usedTokens: row.usedTokens,
              ...(row.turnTokenUsage === undefined ? {} : { turnTokenUsage: row.turnTokenUsage }),
            },
          ];
          const charge = yield* budget.charge({ orgId, wakeupId, usage: turn });
          assert.strictEqual(charge.units, row.units, row.id);
          // The running-spend notice reads a turn with the formula its charge uses.
          assert.strictEqual(Budget.unitsOf(turn), row.units, row.id);
          yield* (yield* Queue.KinEventQueue).finish({ orgId, wakeupId, status: "completed" });
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM kin_wakeups WHERE wakeup_id = ${wakeupId}`,
            [{ status: "completed" }],
          );
          assert.isNotNull(
            (yield* sql`SELECT tokens_json FROM kin_wakeups WHERE wakeup_id = ${wakeupId}`)[0]!
              .tokens_json,
          );
          if (row.id === "partial") {
            const full = yield* budget.charge({ orgId, wakeupId, usage });
            assert.strictEqual(full.units, 55.5);
            assert.deepStrictEqual(yield* budget.charge({ orgId, wakeupId, usage }), full);
            assert.deepStrictEqual(yield* budget.charge({ orgId, wakeupId, usage: [] }), full);
          }
        }
        const spent = yield* budget.get(orgId);
        assert.strictEqual(spent.leadUnits, 411);
        // Lead turns' otherUsage (Claude subagents) is lead spend, never worker units.
        assert.strictEqual(spent.workerUnits, 0);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("requires the same-org owner and validates limits before writing", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('member', ${orgId}, 'member', 'Member', '1970-01-01T00:00:00.000Z')`;
      const input = { orgId, limits: { leadUnits: 100, workerUnits: 200 } };
      // No limit is the owner's to choose, as any limit is.
      const none = { orgId, limits: { leadUnits: null, workerUnits: null, teammateUnits: null } };
      for (const asked of [input, none])
        assert.include(
          yield* budget
            .set([{ _tag: "person", orgId, personId: KinPersonId.make("member") }], asked)
            .pipe(Effect.flip),
          { reason: "not_allowed" },
        );
      assert.include(yield* budget.set([], input).pipe(Effect.flip), { reason: "not_found" });
      // A teammate's read is refused at the service too, not trimmed.
      assert.include(
        yield* budget
          .view([{ _tag: "person", orgId, personId: KinPersonId.make("member") }], orgId)
          .pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.strictEqual((yield* budget.view(owner, orgId)).orgId, orgId);
      for (const bad of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.include(
          yield* budget
            .set(owner, { orgId, limits: { leadUnits: bad, workerUnits: 0 } })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
      }
      const stored = { ...input.limits, teammateUnits: null };
      assert.deepStrictEqual((yield* budget.set(owner, input)).limits, stored);
      const defaultOrg = KinOrgId.make("kin-default");
      const bootstrap = [
        {
          _tag: "person" as const,
          orgId: defaultOrg,
          personId: KinPersonId.make("kin-default-owner"),
        },
      ];
      yield* sql`INSERT INTO kin_orgs VALUES (${defaultOrg}, 'Default', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access) VALUES ('kin-default-owner', ${defaultOrg}, 'owner', 'Owner', '1970-01-01T00:00:00.000Z', 'owner')`;
      const defaults = { orgId: defaultOrg, limits: input.limits };
      assert.deepStrictEqual((yield* budget.set(bootstrap, defaults)).limits, stored);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("has no limit until the owner sets one, and the owner can take one away", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const sql = yield* SqlClient.SqlClient;
      // F52: the code default was 2,000,000 units, about 47 Opus turns for the whole company.
      yield* budget.get(orgId);
      yield* sql`UPDATE kin_budget SET lead_units = 50000000, worker_units = 50000000
        WHERE org_id = ${orgId}`;
      const fresh = yield* budget.get(orgId);
      assert.deepStrictEqual(fresh.limits, {
        leadUnits: null,
        workerUnits: null,
        teammateUnits: null,
      });
      const limited = Budget.teammatesLimited(orgId);
      // Nothing stops or warns: every priority runs, tasks start, the cap is lifted.
      const unlimited = Effect.gen(function* () {
        for (const asker of ["owner", "teammate"] as const)
          for (const priority of ["P0", "P1", "P2", "P3", "P4"] as const)
            assert.include(yield* budget.admit(orgId, priority, asker), {
              allowed: true,
              atLimit: false,
              heldBy: null,
            });
        assert.isTrue(yield* budget.admitTask(orgId));
        assert.strictEqual(yield* budget.promptContext(orgId), "no daily limit");
        assert.isFalse(yield* limited);
      });
      yield* unlimited;
      assert.deepStrictEqual(fresh.usual, Budget.USUAL_LIMITS);
      // Use is still counted and shown, and no limit is ever said to be near.
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, 'unlimited', ${agentId}, 'cheap', 0, 'completed', '[]')`;
      yield* budget.charge({ orgId, wakeupId: KinWakeupId.make("unlimited"), usage });
      assert.strictEqual((yield* budget.get(orgId)).leadUnits, 50000055.5);
      assert.deepStrictEqual(yield* sql`SELECT body FROM kin_messages WHERE org_id = ${orgId}`, []);
      const touched: Array<string> = [];
      const watched = Effect.provideService(KinRefreshObserver, {
        touch: (_org, topic) => Effect.sync(() => void touched.push(topic)),
      });
      // A limit again restores every stop.
      yield* watched(budget.set(owner, { orgId, limits: { leadUnits: 100, workerUnits: 100 } }));
      assert.isFalse((yield* budget.admit(orgId, "P2")).allowed);
      assert.isFalse((yield* budget.admit(orgId, "P2", "teammate")).allowed);
      assert.isFalse(yield* budget.admitTask(orgId));
      assert.strictEqual(yield* budget.promptContext(orgId), "0% of today left");
      assert.isTrue(yield* limited);
      yield* watched(budget.set(owner, { orgId, limits: { leadUnits: null, workerUnits: null } }));
      yield* unlimited;
      assert.deepStrictEqual(touched, ["budget", "budget"]);
      // Teammates' own limit keeps the cap even with none for the agents.
      yield* budget.set(owner, {
        orgId,
        limits: { leadUnits: null, workerUnits: null, teammateUnits: 5 },
      });
      assert.isTrue(yield* limited);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "holds teammates' requests to their own limit, says so where they asked, and tells the owner once",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const budget = yield* Budget.KinBudget;
        const queue = yield* Queue.KinEventQueue;
        const sql = yield* SqlClient.SqlClient;
        const at = "1970-01-01T00:00:00.000Z";
        // Kabir is five and a half hours ahead of the owner, who reads UTC.
        yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, time_zone) VALUES ('mate', ${orgId}, 'mate', 'Kabir', ${at}, 'Asia/Kolkata')`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('group', ${orgId}, 'team_group', 0, ${at})`;
        yield* budget.set(owner, {
          orgId,
          limits: { leadUnits: 1000, workerUnits: 1000, teammateUnits: 50 },
        });
        // A turn Kabir asked for spends from the teammates' limit, and the owner's stays open.
        const claim = (wakeupId: string, eventId: string) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
              VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'running', json_array(${eventId}))`;
            yield* sql`UPDATE kin_events SET wakeup_id = ${wakeupId}, state = 'claimed' WHERE event_id = ${eventId}`;
          });
        const ask = (id: string) =>
          ({
            _tag: "chat.message",
            orgId,
            agentId,
            eventId: KinEventId.make(id),
            receivedAt: DateTime.makeUnsafe(0),
            dedupeKey: null,
            provenance: {
              _tag: "human",
              personId: KinPersonId.make("mate"),
              memberId: KinMemberId.make("group-mate"),
            },
            chatId: KinChatId.make("group"),
            messageId: KinMessageId.make(`message-${id}`),
          }) as const;
        yield* queue.enqueue(ask("asked"));
        const wakeupId = KinWakeupId.make("mate-wakeup");
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'completed', '[]')`;
        yield* sql`UPDATE kin_events SET wakeup_id = ${wakeupId}, state = 'done' WHERE event_id = 'asked'`;
        yield* budget.charge({ orgId, wakeupId, usage });
        assert.strictEqual((yield* budget.get(orgId)).teammateUnits, 55.5);
        assert.include(yield* budget.admit(orgId, "P2", "teammate"), {
          allowed: false,
          heldBy: "teammates",
        });
        assert.isTrue((yield* budget.admit(orgId, "P2", "owner")).allowed);
        // F52: Kabir's next request waits, and nobody is left guessing.
        const next = ask("next");
        yield* queue.enqueue(next);
        const { nextReset } = yield* budget.admit(orgId, "P2", "teammate");
        yield* claim("held-wakeup", "next");
        for (const _ of [1, 2])
          yield* budget.defer({
            orgId,
            agentId,
            wakeupId: KinWakeupId.make("held-wakeup"),
            events: [next],
            heldBy: "teammates",
            nextReset,
          });
        assert.deepStrictEqual(
          yield* sql`SELECT state, budget_deferred, not_before FROM kin_events WHERE event_id = 'next'`,
          [{ state: "queued", budget_deferred: 1, not_before: nextReset }],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT chat_id AS "chatId", body FROM kin_messages
            WHERE org_id = ${orgId} ORDER BY chat_id, message_id`,
          [
            {
              chatId: "group",
              // On Kabir's clock where he asked; the owner's notice stays on the owner's.
              body: "Lead will pick this up at 05:30: today's limit for teammates' requests is used up.",
            },
            {
              chatId: "owner-chat",
              body: "Today's limit for teammates' requests is used up, so they wait until 00:00: Lead (1 request). Raise or remove it in Settings to run them now.",
            },
          ],
        );
        assert.deepStrictEqual((yield* budget.get(orgId)).waiting, {
          until: DateTime.formatIso(DateTime.makeUnsafe(nextReset)),
          agents: [{ agentId, name: "Lead", requests: 1, tasks: 0, other: 0 }],
        });
        // Removing the limit lets what waited run now: nothing is held, so nothing says so.
        yield* budget.set(owner, {
          orgId,
          limits: { leadUnits: null, workerUnits: null, teammateUnits: null },
        });
        assert.deepStrictEqual((yield* budget.get(orgId)).waiting?.agents, []);
        assert.deepStrictEqual(
          yield* sql`SELECT budget_deferred, not_before FROM kin_events WHERE event_id = 'next'`,
          [{ budget_deferred: 0, not_before: null }],
        );
      }).pipe(Effect.provide(layer)),
  );
  it.effect("warns the owner once a day at 80% of a limit they set", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const sql = yield* SqlClient.SqlClient;
      yield* budget.set(owner, { orgId, limits: { leadUnits: 100, workerUnits: 100 } });
      for (const id of ["one", "two", "three"]) {
        const wakeupId = KinWakeupId.make(id);
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'completed', '[]')`;
        yield* budget.charge({
          orgId,
          wakeupId,
          usage: [{ providerTurnId: id, usedTokens: 30 }],
        });
      }
      assert.deepStrictEqual(
        yield* sql`SELECT body FROM kin_messages WHERE org_id = ${orgId} ORDER BY message_id`,
        [
          {
            body: "Your agents have used 80% of today's limit. At the limit only your own messages run until 00:00. You can raise or remove the limit in Settings.",
          },
        ],
      );
    }).pipe(Effect.provide(layer)),
  );
  it.effect("a teammate's spending never holds or downgrades the owner's own work", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const queue = yield* Queue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('mate', ${orgId}, 'mate', 'Kabir', '1970-01-01T00:00:00.000Z')`;
      yield* budget.set(owner, { orgId, limits: { leadUnits: 100, workerUnits: 100 } });
      // Kabir's two turns spend more than the whole limit.
      for (const id of ["one", "two"]) {
        yield* queue.enqueue({
          _tag: "chat.message",
          orgId,
          agentId,
          eventId: KinEventId.make(id),
          receivedAt: DateTime.makeUnsafe(0),
          dedupeKey: null,
          provenance: {
            _tag: "human",
            personId: KinPersonId.make("mate"),
            memberId: KinMemberId.make("group-mate"),
          },
          chatId: KinChatId.make("owner-chat"),
          messageId: KinMessageId.make(`message-${id}`),
        });
        const wakeupId = KinWakeupId.make(`mate-${id}`);
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${wakeupId}, ${agentId}, 'cheap', 0, 'completed', '[]')`;
        yield* sql`UPDATE kin_events SET wakeup_id = ${wakeupId}, state = 'done' WHERE event_id = ${id}`;
        yield* budget.charge({ orgId, wakeupId, usage });
      }
      for (const priority of ["P0", "P1", "P2", "P3"] as const)
        assert.include(yield* budget.admit(orgId, priority, "owner"), {
          allowed: true,
          atLimit: false,
          remaining: 1,
        });
      assert.strictEqual(yield* budget.promptContext(orgId), "100% of today left");
      assert.include(yield* budget.admit(orgId, "P1", "teammate"), {
        allowed: false,
        heldBy: "teammates",
      });
      assert.include(yield* budget.get(orgId), {
        leadUnits: 111,
        ownerUnits: 0,
        teammateUnits: 111,
      });
      // With their own limit set, teammates spend against it instead.
      yield* budget.set(owner, {
        orgId,
        limits: { leadUnits: 100, workerUnits: 100, teammateUnits: 200 },
      });
      assert.isTrue((yield* budget.admit(orgId, "P2", "teammate")).allowed);
      // The owner's own turn is charged as the owner's: their room shrinks, Kabir's doesn't.
      const own = KinWakeupId.make("own");
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${own}, ${agentId}, 'cheap', 0, 'completed', '[]')`;
      yield* budget.charge({ orgId, wakeupId: own, usage });
      assert.include(yield* budget.get(orgId), { ownerUnits: 55.5, teammateUnits: 111 });
      assert.strictEqual((yield* budget.admit(orgId, "P3", "owner")).remaining, 44.5 / 100);
      // A co-owner's request spends as the owner's, not the teammates'.
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access) VALUES ('asha', ${orgId}, 'asha', 'Asha', '1970-01-01T00:00:00.000Z', 'co_owner')`;
      const asked = {
        _tag: "chat.message" as const,
        orgId,
        agentId,
        eventId: KinEventId.make("asha"),
        receivedAt: DateTime.makeUnsafe(0),
        dedupeKey: null,
        provenance: {
          _tag: "human" as const,
          personId: KinPersonId.make("asha"),
          memberId: KinMemberId.make("asha-direct"),
        },
        chatId: KinChatId.make("asha-chat"),
        messageId: KinMessageId.make("message-asha"),
      };
      assert.isFalse(Budget.askedByTeammate(asked, new Set(["owner", "asha"])));
      assert.isTrue(Budget.askedByTeammate(asked, new Set(["owner"])));
      yield* queue.enqueue(asked);
      const hers = KinWakeupId.make("asha-turn");
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, ${hers}, ${agentId}, 'cheap', 0, 'completed', '[]')`;
      yield* sql`UPDATE kin_events SET wakeup_id = ${hers}, state = 'done' WHERE event_id = 'asha'`;
      yield* budget.charge({ orgId, wakeupId: hers, usage });
      assert.include(yield* budget.get(orgId), { ownerUnits: 111, teammateUnits: 111 });
    }).pipe(Effect.provide(layer)),
  );
  it.effect("bills held by the limit add no line to the chat: their batch's card says it", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const queue = yield* Queue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
      yield* budget.set(owner, { orgId, limits: { leadUnits: 0, workerUnits: 0 } });
      const event = {
        _tag: "bills.read",
        orgId,
        agentId,
        eventId: KinEventId.make("bills"),
        receivedAt: DateTime.makeUnsafe(0),
        dedupeKey: null,
        provenance: { _tag: "system" },
        chatId: KinChatId.make("owner-chat"),
        batchId: "b-1",
        bills: ["a".repeat(64)],
      } as const;
      yield* queue.enqueue(event);
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
        VALUES (${orgId}, 'held', ${agentId}, 'cheap', 0, 'running', json_array('bills'))`;
      yield* sql`UPDATE kin_events SET wakeup_id = 'held', state = 'claimed' WHERE event_id = 'bills'`;
      const { nextReset } = yield* budget.admit(orgId, "P3", "owner");
      yield* budget.defer({
        orgId,
        agentId,
        wakeupId: KinWakeupId.make("held"),
        events: [event],
        heldBy: "org",
        nextReset,
      });
      assert.deepStrictEqual(
        yield* sql`SELECT state, budget_deferred FROM kin_events WHERE event_id = 'bills'`,
        [{ state: "queued", budget_deferred: 1 }],
      );
      // The owner's one notice of the day's limit stands; no "will pick this up" line.
      assert.deepStrictEqual(yield* sql`SELECT message_id FROM kin_messages ORDER BY message_id`, [
        { message_id: `kin-budget:${orgId}:1970-01-01` },
      ]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect("a crash between holding work and saying so leaves neither, then says both once", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const queue = yield* Queue.KinEventQueue;
      const sql = yield* SqlClient.SqlClient;
      // The notice is keyed by the company's day, here UTC's, on any host.
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '09:00', '18:00', '02:00', 0, 1, '10:00', '{}')`;
      yield* budget.set(owner, { orgId, limits: { leadUnits: 0, workerUnits: 0 } });
      const event = {
        _tag: "chat.message",
        orgId,
        agentId,
        eventId: KinEventId.make("asked"),
        receivedAt: DateTime.makeUnsafe(0),
        dedupeKey: null,
        provenance: {
          _tag: "human",
          personId: KinPersonId.make("owner"),
          memberId: KinMemberId.make("owner-member"),
        },
        chatId: KinChatId.make("owner-chat"),
        messageId: KinMessageId.make("message-asked"),
      } as const;
      yield* queue.enqueue(event);
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
        VALUES (${orgId}, 'held', ${agentId}, 'cheap', 0, 'running', json_array('asked'))`;
      yield* sql`UPDATE kin_events SET wakeup_id = 'held', state = 'claimed' WHERE event_id = 'asked'`;
      const { nextReset } = yield* budget.admit(orgId, "P3", "owner");
      const defer = budget.defer({
        orgId,
        agentId,
        wakeupId: KinWakeupId.make("held"),
        events: [event],
        heldBy: "org",
        nextReset,
      });
      // The process dies as the owner's notice is written, after the hold and the asker's line.
      yield* sql`CREATE TRIGGER crash BEFORE INSERT ON kin_messages
        WHEN NEW.message_id LIKE 'kin-budget%' BEGIN SELECT RAISE(ABORT, 'crash'); END`;
      yield* defer.pipe(Effect.flip);
      assert.deepStrictEqual(
        yield* sql`SELECT state, budget_deferred FROM kin_events WHERE event_id = 'asked'`,
        [{ state: "claimed", budget_deferred: 0 }],
      );
      assert.deepStrictEqual(yield* sql`SELECT message_id FROM kin_messages`, []);
      assert.deepStrictEqual(yield* sql`SELECT exhausted_notified_at FROM kin_budget`, [
        { exhausted_notified_at: null },
      ]);
      // The claim is still the running wake-up's, so its next pass holds it again, and says so.
      yield* sql`DROP TRIGGER crash`;
      yield* defer;
      yield* defer;
      assert.deepStrictEqual(
        yield* sql`SELECT state, budget_deferred FROM kin_events WHERE event_id = 'asked'`,
        [{ state: "queued", budget_deferred: 1 }],
      );
      assert.deepStrictEqual(yield* sql`SELECT message_id FROM kin_messages ORDER BY message_id`, [
        { message_id: `kin-budget:${orgId}:1970-01-01` },
        { message_id: "kin-waiting:held:owner-chat" },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT exhausted_notified_at FROM kin_budget`, [
        { exhausted_notified_at: 0 },
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
