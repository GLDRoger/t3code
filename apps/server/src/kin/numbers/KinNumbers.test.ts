import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Option from "effect/Option";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Refresh from "../chat/KinRefreshHub.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import { followsOutsideRead, inheritOutside, stampEvent } from "../lead/OutsideContent.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Shell from "../shell/KinShell.ts";
import * as Goals from "../work/goals.ts";
import { personSees } from "../work/teamView.ts";
import * as Numbers from "./KinNumbers.ts";

const layer = Layer.mergeAll(
  KinPersistence.layer,
  Refresh.layer,
  Layer.succeed(KinIdentity, {
    owner: { _tag: "person", orgId: KinOrgId.make("invented"), personId: KinPersonId.make("rhea") },
    resolve: () => Effect.succeed([]),
    resolveAgent: () => Effect.die("Not an identity test"),
    agentForWakeup: () => Effect.succeedNone,
    registerAgentThread: () => Effect.void,
    endAgentThread: () => Effect.succeed(false),
    isAgentThread: () => false,
    isLeadThread: () => false,
  }),
).pipe(Layer.provideMerge(Sqlite.layerMemory));
const orgId = KinOrgId.make("invented");
const owner = { _tag: "person" as const, orgId, personId: KinPersonId.make("rhea") };
const member = { ...owner, personId: KinPersonId.make("meera") };
const agent = {
  _tag: "agent" as const,
  orgId,
  agentId: KinAgentId.make("finance"),
  wakeupId: "turn",
};
const now = Date.UTC(2026, 10, 20, 12);
const day = "2026-11-20";
const value = (number: string, value: string) => ({ number, value, asOf: day });
const goal = (number: string, fields: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_records (org_id, record_id, key, title, register_id, owner_kind,
        owner_id, created_by_kind, origin_key, fields_json, created_at, updated_at, confirmed)
      VALUES (${orgId}, ${number}, ${number}, ${number}, 'goals', 'agent', ${agent.agentId},
        'system', ${number}, ${stableStringify({ measure: "manual", ...fields })}, ${now}, ${now}, 1)`;
  });
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(now);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-01')`;
  yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
    VALUES (${orgId}, ${owner.personId}, 'rhea', 'Rhea', 'owner', '2026-11-01'),
      (${orgId}, ${member.personId}, 'meera', 'Meera', 'member', '2026-11-01')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'goals', 'Goals', 'G', 1, ${now}), (${orgId}, 'work', 'Work', 'W', 1, ${now}),
      (${orgId}, 'invoices', 'Invoices', 'INV', 0, ${now})`;
  return sql;
});

it.effect("keeps watched numbers off Goals and reads both corrections, moving numbers once", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* goal("G-1", { unit: "users", every: "day", below: "10.00000000000000000002" });
    yield* goal("G-2", { target: "100" });
    yield* goal("G-3", {});
    assert.deepStrictEqual(
      (yield* Goals.list([owner], orgId)).goals.map((row) => row.key),
      ["G-2"],
    );
    const hub = yield* Refresh.KinRefreshHub;
    yield* Numbers.record(owner, [
      value("G-1", "90"),
      value("G-1", "10.00000000000000000001"),
      value("G-3", "3"),
    ]);
    assert.strictEqual(Option.getOrThrow(yield* Stream.runHead(hub.changes(orgId))).numbers, 1);
    assert.deepStrictEqual(
      (yield* Numbers.list(owner)).numbers.map(({ key, value, off }) => ({
        key,
        value,
        off,
      })),
      [
        { key: "G-1", value: "10.00000000000000000001", off: true },
        { key: "G-3", value: "3", off: false },
      ],
    );
    const rows = (yield* Numbers.values(owner, "G-1", day, day)).values;
    assert.deepStrictEqual(
      rows.map((row) => row.value),
      ["90", "10.00000000000000000001"],
    );
    assert.deepStrictEqual(
      rows.map((row) => row.by.name),
      ["Rhea", "Rhea"],
    );
    yield* Numbers.record(
      owner,
      ["007", "000.50", "-0", "-0.0", "-000.100"].map((text) => value("G-1", text)),
    );
    assert.deepStrictEqual(
      (yield* Numbers.values(owner, "G-1", day, day)).values.slice(2).map((row) => row.value),
      ["7", "0.50", "0", "0.0", "-0.100"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses number records on targeted goals and every role sees their own current", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* goal("G-1", { target: "100", current: "30" });
    yield* sql`UPDATE kin_records SET team_shared = 1 WHERE org_id = ${orgId} AND key = 'G-1'`;
    yield* sql`UPDATE kin_people SET sees_money = 1 WHERE org_id = ${orgId} AND person_id = ${member.personId}`;
    for (const who of [owner, member]) {
      assert.include(yield* Effect.flip(Numbers.record(who, [value("G-1", "40")])), {
        reason: "invalid_state",
        message: "That is a goal with a target. Change its current figure on the goal.",
      });
    }
    assert.deepStrictEqual(
      yield* sql`SELECT value FROM kin_number_values
      WHERE org_id = ${orgId} AND record_id = 'G-1' ORDER BY seq`,
      [],
    );
    assert.strictEqual(
      (yield* Effect.flip(Numbers.values(owner, "G-1", day, day))).reason,
      "not_found",
    );
    // A legacy observation must not compete with the goal's own current.
    yield* sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value,
      person_id, recorder_name, created_at)
      VALUES (${orgId}, 'G-1', ${day}, 1, '30', ${owner.personId}, 'Rhea', ${now})`;
    yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.current', '50')
      WHERE org_id = ${orgId} AND key = 'G-1'`;
    for (const who of [owner, member])
      assert.strictEqual((yield* Goals.list([who], orgId)).goals[0]?.current, 50);
  }).pipe(Effect.provide(layer)),
);

it.effect("allows tomorrow in the company's zone and rejects a future value atomically", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* goal("G-1", {});
    yield* TestClock.setTime(Date.UTC(2026, 10, 20, 23, 30));
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
    const tomorrow = { ...value("G-1", "30"), asOf: "2026-11-22" };
    assert.include(
      yield* Effect.flip(
        Numbers.record(owner, [tomorrow, { ...value("G-1", "999"), asOf: "2099-01-01" }]),
      ),
      {
        reason: "invalid_state",
        message: "A value can't be dated in the future.",
      },
    );
    assert.deepStrictEqual((yield* Numbers.values(owner, "G-1", day, "2099-01-01")).values, []);
    yield* Numbers.record(owner, [tomorrow]);
    assert.strictEqual(
      (yield* Numbers.values(owner, "G-1", day, tomorrow.asOf)).values[0]?.value,
      "30",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps private numbers absent and only lets members type a shared number they see", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* goal("G-1", { unit: "USD" });
    yield* goal("G-2", { source: "Invented PostHog report" });
    yield* Numbers.record(owner, [value("G-1", "40"), value("G-2", "12")]);
    assert.deepStrictEqual((yield* Numbers.list(member)).numbers, []);
    assert.strictEqual(yield* Numbers.visibleValueRevision(member), "");
    assert.strictEqual(
      (yield* Effect.flip(Numbers.values(member, "G-1", day, day))).reason,
      "not_found",
    );
    assert.strictEqual(
      (yield* Effect.flip(Numbers.record(member, [value("G-1", "50")]))).reason,
      "not_found",
    );
    yield* sql`UPDATE kin_records SET team_shared = 1 WHERE org_id = ${orgId}`;
    assert.deepStrictEqual((yield* Numbers.list(member)).numbers, []);
    yield* sql`UPDATE kin_people SET sees_money = 1 WHERE org_id = ${orgId} AND person_id = ${member.personId}`;
    assert.deepStrictEqual(
      (yield* Numbers.list(member)).numbers.map((row) => row.key),
      ["G-1", "G-2"],
    );
    assert.strictEqual(
      (yield* Effect.flip(Numbers.record(member, [value("G-1", "50"), value("G-2", "50")]))).reason,
      "not_allowed",
    );
    assert.strictEqual((yield* Numbers.list(member)).numbers[0]?.value, "40");
    yield* Numbers.record(member, [value("G-1", "55")], "typed");
    yield* Numbers.record(owner, [value("G-1", "60")]);
    yield* Numbers.record(member, [value("G-1", "55")], "typed");
    assert.strictEqual((yield* Numbers.list(member)).numbers[0]?.value, "60");
    assert.strictEqual(
      (yield* Effect.flip(Numbers.record(member, [value("G-1", "56")], "typed"))).reason,
      "not_allowed",
    );
    assert.strictEqual(
      (yield* Numbers.values(member, "G-1", day, day)).values[1]?.by.name,
      "Meera",
    );
    yield* sql`DELETE FROM kin_people WHERE org_id = ${orgId} AND person_id = ${member.personId}`;
    assert.deepStrictEqual((yield* Numbers.values(owner, "G-1", day, day)).values[1]?.by, {
      kind: "person",
      id: member.personId,
      name: "Meera",
    });
    assert.strictEqual((yield* Effect.flip(Numbers.list(member))).reason, "not_found");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "computes all six built-ins and a two-state count, keeping overdue balances in their currencies",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* goal("G-1", { spec: '{"builtin":"overdue_over_30"}' });
      yield* goal("G-2", { spec: '{"count":"work","states":["open","done"]}' });
      const row = (
        id: string,
        list: string,
        state: string,
        amount: number | null,
        currency: string | null,
        dueAt: number | null,
      ) =>
        sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind, owner_id,
          created_by_kind, origin_key, state, amount_minor, currency, due_at, created_at, updated_at, confirmed)
        VALUES (${orgId}, ${id}, ${list}, ${id}, ${id}, 'person', ${owner.personId}, 'system', ${id},
          ${state}, ${amount}, ${currency}, ${dueAt}, ${now}, ${now}, 1)`;
      for (const [key, builtin] of [
        ["G-3", "revenue_received"],
        ["G-4", "clients_won"],
        ["G-5", "tasks_done"],
        ["G-6", "pipeline_open"],
        ["G-7", "invoiced_this_month"],
      ] as const)
        yield* goal(key, { spec: stableStringify({ builtin }) });
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'clients', 'Clients', 'C', 1, ${now}), (${orgId}, 'deals', 'Deals', 'DL', 1, ${now})`;
      yield* row("C-1", "clients", "open", null, null, null);
      yield* row("DL-1", "deals", "open", null, null, null);
      yield* row("DL-2", "deals", "done", null, null, null);
      yield* sql`UPDATE kin_records SET party_id = 'C-1',
        fields_json = '{"value":{"minor":22500,"currency":"USD"}}'
        WHERE org_id = ${orgId} AND register_id = 'deals'`;
      const old = now - 31 * 86_400_000;
      yield* row("INV-1", "invoices", "waiting", 1299, "USD", old);
      yield* row("INV-2", "invoices", "waiting", 1234, "JPY", old);
      yield* row("INV-3", "invoices", "waiting", 9999, "USD", old + 86_400_000);
      yield* row("INV-4", "invoices", "done", 9999, "USD", old);
      yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
        currency, paid_on, origin_key, created_at, created_by_kind)
      VALUES (${orgId}, 'p1', 'INV-1', 100, 'USD', ${day}, 'p1', ${now}, 'system')`;
      for (const state of ["open", "done", "dropped"])
        yield* row(`W-${state}`, "work", state, null, null, null);
      yield* sql`UPDATE kin_records SET closed_at = ${now}
        WHERE org_id = ${orgId} AND register_id = 'work' AND state = 'done'`;
      const [overdue, count, revenue, clients, tasks, pipeline, invoiced] = (yield* Numbers.list(
        owner,
      )).numbers;
      assert.deepStrictEqual(overdue?.value, [
        { currency: "JPY", minor: 1234 },
        { currency: "USD", minor: 1199 },
      ]);
      assert.strictEqual(count?.value, "2");
      assert.deepStrictEqual(revenue?.value, [{ currency: "USD", minor: 100 }]);
      assert.strictEqual(clients?.value, "1");
      assert.strictEqual(tasks?.value, "1");
      assert.deepStrictEqual(pipeline?.value, [{ currency: "USD", minor: 22500 }]);
      assert.deepStrictEqual(invoiced?.value, [
        { currency: "JPY", minor: 1234 },
        { currency: "USD", minor: 21297 },
      ]);
      assert.deepStrictEqual((yield* Numbers.values(owner, "G-1", day, day)).values, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps shared computed invoice totals and counts owner-level", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* goal("G-1", { spec: '{"builtin":"overdue_over_30"}' });
    yield* goal("G-2", { spec: '{"count":"invoices","states":["waiting"]}' });
    yield* sql`UPDATE kin_records SET team_shared = 1 WHERE org_id = ${orgId}`;
    yield* sql`UPDATE kin_people SET sees_money = 1 WHERE org_id = ${orgId} AND person_id = ${member.personId}`;
    const old = now - 31 * 86_400_000;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind, owner_id,
      created_by_kind, origin_key, state, amount_minor, currency, due_at, created_at, updated_at, sensitive)
      VALUES (${orgId}, 'inv-one', 'invoices', 'INV-1', 'Ordinary', 'person', ${owner.personId},
        'system', 'invoice-one', 'waiting', 1000, 'USD', ${old}, ${now}, ${now}, 0),
      (${orgId}, 'inv-two', 'invoices', 'INV-2', 'Private', 'person', ${owner.personId},
        'system', 'invoice-two', 'waiting', 70000, 'USD', ${old}, ${now}, ${now}, 1)`;
    const revision = yield* Numbers.visibleValueRevision(member);
    // A definition can change after it acquires a value.
    yield* sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value,
        person_id, recorder_name, created_at)
      VALUES (${orgId}, 'G-1', ${day}, 1, '999', ${owner.personId}, 'Rhea', ${now})`;
    assert.deepStrictEqual((yield* Numbers.list(member)).numbers, []);
    for (const key of ["G-1", "G-2"])
      assert.strictEqual(
        (yield* Effect.flip(Numbers.values(member, key, day, day))).reason,
        "not_found",
      );
    assert.strictEqual(yield* Numbers.visibleValueRevision(member), revision);
    assert.deepStrictEqual(
      yield* sql`SELECT r.key FROM kin_records r WHERE r.org_id = ${orgId}
      AND r.register_id = 'goals' AND ${personSees(sql, member.personId)} ORDER BY r.key`,
      [],
    );
    assert.deepStrictEqual(
      (yield* Numbers.list(owner)).numbers.map((row) => row.value),
      [[{ currency: "USD", minor: 71000 }], "2"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses shared agent reads and writes, but admits a keeper's sourced value after an outside read",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      yield* goal("G-1", { source: "Invented PostHog report" });
      yield* goal("G-2", { source: "Invented report" });
      yield* sql`UPDATE kin_records SET owner_id = 'other' WHERE org_id = ${orgId} AND key = 'G-2'`;
      const given = { ...value("G-1", "4210"), source: "PostHog DAU" };
      assert.strictEqual(
        (yield* Effect.flip(Numbers.record(agent, [given]))).message,
        SHARED_REFUSAL,
      );
      assert.strictEqual((yield* Effect.flip(Numbers.list(agent))).message, SHARED_REFUSAL);
      yield* sql`INSERT INTO kin_agents (org_id, agent_id, owner_person_id, display_name, role, created_at)
      VALUES (${orgId}, ${agent.agentId}, ${owner.personId}, 'Finance', 'lead', '2026-11-01')`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('direct', ${orgId}, 'direct', 'rhea:finance', 0, '2026-11-01')`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES (${agent.agentId}, ${orgId}, 'Finance', 'L1', 0, '{}', '[]', 'direct')`;
      yield* sql`INSERT INTO kin_wakeups (org_id, agent_id, wakeup_id, audience, status, started_at, model, event_ids)
      VALUES (${orgId}, ${agent.agentId}, ${agent.wakeupId}, 'owner_only', 'running', ${now}, 'invented', '[]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, wakeup_id)
      VALUES ('due', ${orgId}, ${agent.agentId}, 'schedule.due', 'P2', '{}', ${now}, ${now}, ${agent.wakeupId})`;
      yield* goal("G-3", { spec: '{"builtin":"pipeline_open"}' });
      yield* goal("G-4", { spec: '{"count":"deals","states":["open"]}' });
      const keysOf = (who: typeof owner | typeof agent) =>
        Numbers.list(who).pipe(Effect.map(({ numbers }) => numbers.map((row) => row.key)));
      const dealsOn = (rev: number, on: boolean) =>
        Shell.KinShell.use((shell) =>
          shell.set(orgId, owner.personId, rev, [{ id: "deals", on }]),
        ).pipe(Effect.provide(Shell.layer));
      yield* dealsOn(0, false);
      for (const who of [owner, agent]) assert.deepStrictEqual(yield* keysOf(who), ["G-1", "G-2"]);
      yield* dealsOn(1, true);
      for (const who of [owner, agent]) {
        assert.deepStrictEqual(yield* keysOf(who), ["G-1", "G-2", "G-3", "G-4"]);
        assert.deepStrictEqual((yield* Numbers.values(who, "G-3", day, day)).values, []);
      }
      yield* stampEvent(orgId, "outside", "Invented connection");
      yield* inheritOutside({ ...agent, eventIds: ["outside"] });
      assert.isTrue(yield* followsOutsideRead(orgId, agent.wakeupId));
      assert.strictEqual(
        (yield* Effect.flip(Numbers.record(agent, [{ ...given, number: "G-2" }]))).reason,
        "not_allowed",
      );
      yield* Numbers.record(agent, [given]);
      yield* Numbers.record(agent, [given]);
      const entries = (yield* Numbers.values(owner, "G-1", day, day)).values;
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]?.source, "PostHog DAU");
      assert.strictEqual(entries[0]?.by.name, "Finance");
      yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, person_id, principal_kind, role, joined_at)
      VALUES (${orgId}, 'direct', 'member-meera', ${member.personId}, 'person', 'member', '2026-11-20')`;
      assert.strictEqual(
        (yield* Effect.flip(Numbers.record(agent, [given]))).message,
        SHARED_REFUSAL,
      );
      assert.strictEqual((yield* Effect.flip(Numbers.list(agent))).message, SHARED_REFUSAL);
    }).pipe(Effect.provide(layer)),
);
