import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId, KinWakeupId } from "@t3tools/contracts";
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
          assert.isTrue(admissions.every((a) => a.cheapOnly === (remaining === 0)));
        }
        assert.isTrue(yield* budget.admitWorker(orgId));
        yield* sql`UPDATE kin_budget SET worker_units = 10 WHERE org_id = ${orgId}`;
        assert.isFalse(yield* budget.admitWorker(orgId));
        yield* budget.admit(orgId, "P0");
        assert.strictEqual(
          (yield* sql`SELECT message_id FROM kin_messages WHERE org_id = ${orgId} ORDER BY message_id`)
            .length,
          1,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT exhausted_notified_at FROM kin_budget WHERE org_id = ${orgId} ORDER BY day`,
          [{ exhausted_notified_at: 0 }],
        );
        yield* budget.set(owner, { orgId, limits: { leadUnits: 200, workerUnits: 20 } });
        assert.isTrue((yield* budget.admit(orgId, "P3")).allowed);
        yield* budget.set(owner, { orgId, limits: { leadUnits: 0, workerUnits: 0 } });
        assert.isFalse(yield* budget.admitWorker(orgId));
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
        assert.include(
          yield* budget
            .charge({ orgId: KinOrgId.make("foreign"), wakeupId, usage })
            .pipe(Effect.flip),
          { reason: "not_found" },
        );
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
          const charge = yield* budget.charge({
            orgId,
            wakeupId,
            usage: [
              {
                providerTurnId: row.id,
                usedTokens: row.usedTokens,
                ...(row.turnTokenUsage === undefined ? {} : { turnTokenUsage: row.turnTokenUsage }),
              },
            ],
          });
          assert.strictEqual(charge.units, row.units, row.id);
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
            const lower = yield* budget.charge({ orgId, wakeupId, usage: [] });
            assert.strictEqual(lower.units, 55.5);
          }
        }
        assert.strictEqual((yield* budget.get(orgId)).leadUnits, 411);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("requires the same-org owner and validates limits before writing", () =>
    Effect.gen(function* () {
      yield* seed;
      const budget = yield* Budget.KinBudget;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('member', ${orgId}, 'member', 'Member', '1970-01-01T00:00:00.000Z')`;
      const input = { orgId, limits: { leadUnits: 100, workerUnits: 200 } };
      assert.include(
        yield* budget
          .set([{ _tag: "person", orgId, personId: KinPersonId.make("member") }], input)
          .pipe(Effect.flip),
        { reason: "not_allowed" },
      );
      assert.include(yield* budget.set([], input).pipe(Effect.flip), { reason: "not_found" });
      for (const bad of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        assert.include(
          yield* budget
            .set(owner, { orgId, limits: { leadUnits: bad, workerUnits: 0 } })
            .pipe(Effect.flip),
          { reason: "invalid_state" },
        );
      }
      assert.deepStrictEqual((yield* budget.set(owner, input)).limits, input.limits);
      const defaultOrg = KinOrgId.make("kin-default");
      const bootstrap = [
        {
          _tag: "person" as const,
          orgId: defaultOrg,
          personId: KinPersonId.make("kin-default-owner"),
        },
      ];
      yield* sql`INSERT INTO kin_orgs VALUES (${defaultOrg}, 'Default', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('kin-default-owner', ${defaultOrg}, 'owner', 'Owner', '1970-01-01T00:00:00.000Z'), ('other-owner', ${defaultOrg}, 'other', 'Other', '1970-01-01T00:00:00.000Z')`;
      const defaults = { orgId: defaultOrg, limits: input.limits };
      assert.deepStrictEqual((yield* budget.set(bootstrap, defaults)).limits, input.limits);
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('default-lead', ${defaultOrg}, 'Lead', 'lead', 'other-owner', '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('default-chat', ${defaultOrg}, 'team_group', 0, '1970-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) SELECT 'default-lead', ${defaultOrg}, name, level_since, models_json, worker_projects_json, 'default-chat' FROM kin_leads WHERE org_id = ${orgId}`;
      assert.include(yield* budget.set(bootstrap, defaults).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      yield* sql`UPDATE kin_agents SET owner_person_id = 'kin-default-owner' WHERE org_id = ${defaultOrg}`;
      assert.deepStrictEqual((yield* budget.set(bootstrap, defaults)).limits, input.limits);
    }).pipe(Effect.provide(layer)),
  );
});
