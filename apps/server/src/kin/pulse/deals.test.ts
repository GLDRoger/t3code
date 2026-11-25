import { buildPulseSection } from "./prompt.ts";
import * as KinShell from "../shell/KinShell.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  kinIsBrief,
  kinPageSections,
  type KinPulseFact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Chat from "../chat/layer.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { withQuietDays } from "../work/deals.ts";
import { PLAYBOOK_SEEDS } from "../work/playbookSeeds.ts";
import * as CheckIns from "./checkIns.ts";
import * as KinPulse from "./KinPulse.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { morningMoneyLines } from "./morningMoney.ts";
import { markTold, untold } from "./told.ts";
import { morningBody, morningDue, morningOf } from "./personMorning.ts";

// Invented company, people, clients and deals only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const rhea = KinPersonId.make("rhea");
const zoya = KinPersonId.make("zoya");
const arjun = KinPersonId.make("arjun");
const dev = KinPersonId.make("dev");
const chief = KinAgentId.make("cos");
const growth = KinAgentId.make("growth");
/** Sunday 1 November 2026, 00:00 UTC. */
const B = Date.UTC(2026, 10, 1);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday 2 November, 08:00 UTC: Zoya's day starts. */
const MONDAY = B + DAY + 8 * HOUR;
const stamp = "2026-10-01T00:00:00.000Z";

const chatLayer = Chat.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

interface Entry {
  readonly id: string;
  readonly list: string;
  readonly title: string;
  readonly ownerKind?: string;
  readonly ownerId?: string;
  readonly partyId?: string;
  readonly category?: string;
  readonly state?: string;
  readonly dueAt?: number;
  readonly createdAt?: number;
  readonly closedAt?: number;
  readonly origin?: string;
}

const insert = Effect.fn("test.insert")(function* (entry: Entry) {
  const sql = yield* SqlClient.SqlClient;
  const created = entry.createdAt ?? B;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, category, party_id, due_at, due_all_day, created_by_kind, created_by_id,
      origin_key, created_at, updated_at, fields_json, closed_at)
    VALUES (${orgId}, ${`r-${entry.id}`}, ${entry.list}, ${entry.id}, ${entry.title},
      ${entry.state ?? "open"}, ${entry.ownerKind ?? "person"}, ${entry.ownerId ?? zoya}, 'ours',
      ${entry.category ?? null}, ${entry.partyId === undefined ? null : `r-${entry.partyId}`},
      ${entry.dueAt ?? null}, ${entry.dueAt === undefined ? 0 : 1}, 'person', ${rhea},
      ${entry.origin ?? `origin-${entry.id}`}, ${created}, ${created},
      ${entry.list === "deals" ? '{"stage":"new"}' : "{}"}, ${entry.closedAt ?? null})`;
});

/** A follow-up of ours on the deal's client, linked to the deal. */
const step = Effect.fn("test.step")(function* (id: string, deal: string, dueAt?: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* insert({
    id,
    list: "work",
    title: `Call about ${deal}`,
    category: "task",
    partyId: "C-1",
    ...(dueAt === undefined ? {} : { dueAt }),
  });
  yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation, created_at)
    VALUES (${orgId}, ${`r-${id}`}, 'record', ${`r-${deal}`}, 'relates', ${B})`;
});

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, sees_clients,
      created_at)
    VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', 'owner', 0, ${stamp}),
      (${zoya}, ${orgId}, 'zoya', 'Zoya', 'member', 1, ${stamp}),
      (${arjun}, ${orgId}, 'arjun', 'Arjun', 'member', 1, ${stamp}),
      (${dev}, ${orgId}, 'dev', 'Dev', 'member', 0, ${stamp})`;
  for (const [agent, domain] of [
    [chief, "chief-of-staff"],
    [growth, "growth"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent}, 'lead', ${rhea}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  for (const person of [zoya, arjun, dev])
    yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
      VALUES (${orgId}, ${chief}, ${person}, ${rhea}, 0)`;
  for (const [id, prefix] of [
    ["clients", "C"],
    ["deals", "DL"],
    ["work", "W"],
    ["docs", "D"],
  ] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;
  yield* insert({ id: "C-1", list: "clients", title: "Corran Tiles", category: "client" });
  // Expected by Sunday 8 November, the end of that day in the company's zone.
  yield* insert({
    id: "DL-1",
    list: "deals",
    title: "Stock and orders system",
    partyId: "C-1",
    dueAt: Date.UTC(2026, 10, 9) - 1,
  });
});

const read = (at: number, viewer: KinPulse.Viewer = { _tag: "owner" }) =>
  KinPulse.read({ orgId, at, viewer, includeHandled: true, limit: 200 });
const asZoya = (at: number) => read(at, { _tag: "people", people: [zoya] });
const senses = (facts: ReadonlyArray<KinPulseFact>, subject = "DL-1") =>
  facts
    .filter((fact) => fact.subject.key === subject && fact.handled === null)
    .map((fact) => fact.sense)
    .toSorted();

/** The pages Kin posted in someone's direct chat with the Chief of staff, oldest first. */
const pagesTo = Effect.fn("test.pagesTo")(function* (personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ body: string; form: string | null }>`SELECT m.body, m.form
    FROM kin_messages m JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
    WHERE m.org_id = ${orgId} AND c.direct_key = ${`${personId}:${chief}`}
      AND m.author_kind = 'system' AND m.status = 'posted' AND m.form = 'brief'
    ORDER BY m.seq`;
});
const as = (personId: KinPersonId) => [{ _tag: "person", orgId, personId } as const];
const pageOf = (personId: KinPersonId) => CheckIns.briefs(as(personId), orgId);
const setPage = (
  personId: KinPersonId,
  at: number,
  input: Omit<Parameters<typeof CheckIns.saveBrief>[1], "orgId" | "kind">,
) =>
  TestClock.setTime(at).pipe(
    Effect.andThen(CheckIns.saveBrief(as(personId), { orgId, kind: "morning", ...input })),
    // A page's save never moves a schedule.
    Effect.provide(Layer.mock(KinSchedules.KinSchedules)({})),
  );
const tickAt = (at: number) => TestClock.setTime(at).pipe(Effect.andThen(KinPulse.tick(orgId, at)));
/**
 * The scheduler's pass once a minute from `from` to `to`, as a server that stays up runs it; the
 * minute Zoya's page count first grew, or undefined.
 */
const passes = Effect.fn("test.passes")(function* (
  last: KinPulse.Passes,
  from: number,
  to: number,
) {
  const before = (yield* pagesTo(zoya)).length;
  for (let at = from; at <= to; at += MINUTE) {
    yield* TestClock.setTime(at);
    yield* KinPulse.pass(last);
    if ((yield* pagesTo(zoya)).length > before) return at;
  }
  return undefined;
});
const toldDays = Effect.fn("test.toldDays")(function* (personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_told
    WHERE org_id = ${orgId} AND person_id = ${personId} AND fact_key LIKE 'person-morning:%'
    ORDER BY fact_key`;
  return rows.map((row) => row.key.slice("person-morning:".length));
});

describe("deal senses", () => {
  it.effect(
    "each starts on its day, clears when its cause goes, and a closed deal raises none",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        // Made with no next step: flagged at once.
        assert.deepStrictEqual(senses((yield* read(B + MINUTE)).facts), ["deal_no_next_step"]);
        const [fact] = (yield* read(B + MINUTE)).facts;
        assert.strictEqual(
          fact?.consequence,
          "Stock and orders system for Corran Tiles has no next step.",
        );
        // A step clears it; done, it is back as a new fact.
        yield* step("W-1", "DL-1", B + 3 * DAY);
        assert.deepStrictEqual(senses((yield* read(B + 2 * HOUR)).facts), []);
        yield* sql`UPDATE kin_records SET state = 'done', closed_at = ${B + 2 * DAY},
        updated_at = ${B + 2 * DAY} WHERE record_id = 'r-W-1'`;
        const back = (yield* read(B + 2 * DAY + MINUTE)).facts.filter(
          (one) => one.sense === "deal_no_next_step",
        );
        assert.deepStrictEqual(
          back.map((one) => one.key),
          [`deal_no_next_step:DL-1:${B + 2 * DAY}`],
        );

        // Quiet: 14 days by default after the step's last change, the latest thing that moved.
        const quiet = B + 2 * DAY + 14 * DAY;
        assert.notInclude(senses((yield* read(quiet - MINUTE)).facts), "deal_quiet");
        assert.include(senses((yield* read(quiet)).facts), "deal_quiet");
        // A logged call clears it.
        yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, logged_by_kind,
          logged_by_id, origin_key, created_at)
        VALUES (${orgId}, 't-1', 'r-C-1', ${quiet + HOUR}, 'call', 'person', ${zoya}, 't-1', ${quiet})`;
        assert.notInclude(senses((yield* read(quiet + 2 * HOUR)).facts), "deal_quiet");

        // Expected by the end of 8 November: passed from the next instant.
        const due = Date.UTC(2026, 10, 9) - 1;
        assert.notInclude(senses((yield* read(due)).facts), "deal_date_passed");
        const passed = (yield* read(due + 1)).facts.find((one) => one.sense === "deal_date_passed");
        assert.strictEqual(
          passed?.consequence,
          "Stock and orders system for Corran Tiles was expected by Sun 8 Nov, yesterday, and is still open.",
        );

        // Won or lost: nothing about it at all.
        for (const state of ["done", "dropped"]) {
          yield* sql`UPDATE kin_records SET state = ${state} WHERE record_id = 'r-DL-1'`;
          assert.deepStrictEqual(senses((yield* read(quiet + 30 * DAY)).facts), [], state);
        }
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("deal_quiet_days comes from the playbook that sets it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* insert({ id: "D-1", list: "docs", title: "Winning customers", category: "playbook" });
      // The seeded playbook's own text, as Settings, Deals rewrites it.
      const seeded = PLAYBOOK_SEEDS.find((one) => one.slug === "winning-customers")!.body;
      assert.include(seeded, "deal_quiet_days: 14");
      const body = withQuietDays(seeded, 5);
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
          operations_json, actor_kind, actor_id, via, origin_key, created_at)
        VALUES (${orgId}, 'r-D-1', 1, ${body}, 'Winning customers', 'created', 'Seeded', '[]',
          'person', ${rhea}, 'owner', 'seed-D-1', 0)`;
      assert.notInclude(senses((yield* read(B + 5 * DAY - MINUTE)).facts), "deal_quiet");
      const quiet = (yield* read(B + 5 * DAY)).facts.find((one) => one.sense === "deal_quiet");
      assert.deepStrictEqual(quiet?.measure, {
        value: 5,
        unit: "days",
        threshold: 5,
        from: { _tag: "playbook", key: "D-1", title: "Winning customers" },
      });
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "the looker-after hears it; an agent's goes to the client's person; else the owner",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const at = B + MINUTE;
        const actorOf = (facts: ReadonlyArray<KinPulseFact>, key: string) =>
          facts.find((fact) => fact.subject.key === key)?.actor;
        // Growth looks after DL-2 for Zoya's client: Zoya hears it.
        yield* insert({
          id: "DL-2",
          list: "deals",
          title: "Showroom fit-out",
          partyId: "C-1",
          ownerKind: "agent",
          ownerId: growth,
        });
        // Growth's own prospect, and a deal of Growth's on it: nobody of ours, so the owner.
        yield* insert({
          id: "C-2",
          list: "clients",
          title: "Harbour Glass",
          category: "prospect",
          ownerKind: "agent",
          ownerId: growth,
        });
        yield* insert({
          id: "DL-3",
          list: "deals",
          title: "Glass samples",
          partyId: "C-2",
          ownerKind: "agent",
          ownerId: growth,
        });
        const owner = (yield* read(at)).facts;
        assert.deepStrictEqual(actorOf(owner, "DL-1"), { _tag: "person", personId: zoya });
        assert.deepStrictEqual(actorOf(owner, "DL-2"), { _tag: "person", personId: zoya });
        assert.deepStrictEqual(actorOf(owner, "DL-3"), { _tag: "owner" });
        // Zoya reads hers; Arjun (Clients on) and Dev (Clients off) read none of them.
        assert.deepStrictEqual(
          (yield* asZoya(at)).facts.map((fact) => fact.subject.key).toSorted(),
          ["DL-1", "DL-2"],
        );
        for (const person of [arjun, dev])
          assert.lengthOf((yield* read(at, { _tag: "people", people: [person] })).facts, 0);
        // Her Clients switch off: she no longer hears it.
        yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${zoya}`;
        assert.lengthOf((yield* asZoya(at)).facts, 0);
        // Gone from the company: the owner hears it.
        yield* sql`UPDATE kin_people SET removed_at = ${at} WHERE person_id = ${zoya}`;
        assert.deepStrictEqual(actorOf((yield* read(at)).facts, "DL-1"), { _tag: "owner" });
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a prospect with no deal and no next step is one fact; one with either, none", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* insert({ id: "C-3", list: "clients", title: "Quillon Studios", category: "prospect" });
      const facts = (yield* read(B + MINUTE)).facts;
      assert.deepStrictEqual(senses(facts, "C-3"), ["deal_no_next_step"]);
      assert.strictEqual(
        facts.find((fact) => fact.subject.key === "C-3")?.consequence,
        "Quillon Studios is a prospect with no deal and no next step.",
      );
      yield* insert({
        id: "W-9",
        list: "work",
        title: "Intro call",
        category: "task",
        partyId: "C-3",
        dueAt: B + 2 * DAY,
      });
      assert.deepStrictEqual(senses((yield* read(B + MINUTE)).facts, "C-3"), []);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("set aside, on the deal or its client, keeps it quiet until the hold ends", () =>
    Effect.gen(function* () {
      yield* seed;
      const at = B + MINUTE;
      const aside = (
        record: string,
        by: KinPersonId,
        action: "set" | "lift",
        until: number | null,
      ) =>
        KinPulse.aside({
          orgId,
          at,
          viewer: by === rhea ? { _tag: "owner" } : { _tag: "people", people: [by] },
          by: { _tag: "person", personId: by },
          recordKey: record,
          action,
          until,
          note: null,
          holding: { _tag: "may", forPersonId: by === rhea ? null : by, onWordOf: null },
        });
      // "Not now": Zoya's own hold on the deal for 14 days.
      yield* aside("DL-1", zoya, "set", at + 14 * DAY);
      const held = (yield* asZoya(at)).facts.find((fact) => fact.sense === "deal_no_next_step");
      assert.strictEqual(held?.aside?.mine, true);
      assert.isTrue(held?.aside?.liftable);
      assert.deepStrictEqual(senses((yield* asZoya(at)).facts), []);
      // Its day comes: back.
      assert.include(senses((yield* asZoya(at + 14 * DAY)).facts), "deal_no_next_step");
      // Lifted early: back at once.
      yield* aside("DL-1", zoya, "lift", null);
      assert.deepStrictEqual(senses((yield* asZoya(at)).facts), ["deal_no_next_step"]);
      // The company sets its client aside: quiet for Zoya too, and in her morning page.
      yield* aside("C-1", rhea, "set", null);
      assert.deepStrictEqual(senses((yield* asZoya(at)).facts), []);
      yield* tickAt(MONDAY);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      // Lifted after her minute: that morning's page was written from what was true then.
      yield* aside("C-1", rhea, "lift", null);
      yield* tickAt(MONDAY + HOUR);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(MONDAY + DAY);
      assert.lengthOf(yield* pagesTo(zoya), 1);
    }).pipe(Effect.provide(chatLayer)),
  );
});

it.effect("Deals off keeps three already-told facts and their holds without renotifying", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    for (const id of ["DL-2", "DL-3"])
      yield* insert({ id, list: "deals", title: id, partyId: "C-1", ownerId: rhea });
    yield* sql`UPDATE kin_records SET owner_id = ${rhea}
      WHERE org_id = ${orgId} AND key = 'DL-1'`;
    const at = B + MINUTE;
    yield* tickAt(at);
    const snapshot = read(at);
    const facts = (yield* snapshot).facts;
    assert.lengthOf(facts, 3);
    for (const recordKey of ["DL-1", "DL-2", "DL-3"])
      yield* KinPulse.aside({
        orgId,
        at,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: rhea },
        recordKey,
        action: "set",
        until: null,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: null },
      });
    yield* markTold({ orgId, personId: rhea, facts, eventId: "already-told", at, zone: "UTC" });
    const before = yield* snapshot;
    assert.lengthOf(before.setAside ?? [], 3);
    const told = sql`SELECT * FROM kin_pulse_told WHERE org_id = ${orgId}
      AND fact_key LIKE 'deal_%' ORDER BY person_id, fact_key, event_id`;
    const prior = yield* told;
    assert.lengthOf(prior, 3);
    const toggle = (rev: number, on: boolean) =>
      KinShell.KinShell.use((shell) => shell.set(orgId, rhea, rev, [{ id: "deals", on }])).pipe(
        Effect.provide(KinShell.layer),
      );
    yield* toggle(0, false);
    const off = yield* tickAt(at + MINUTE);
    assert.deepStrictEqual((yield* read(at + MINUTE)).facts, []);
    assert.isUndefined(
      (yield* KinPulse.read({
        orgId,
        at: at + MINUTE,
        viewer: { _tag: "owner" },
        withAside: true,
      })).setAside,
    );
    assert.lengthOf(off.woken, 0);
    assert.lengthOf(off.told, 0);
    yield* toggle(1, true);
    const on = yield* tickAt(at + 2 * MINUTE);
    assert.lengthOf(on.woken, 0);
    assert.lengthOf(on.told, 0);
    assert.deepStrictEqual(yield* told, prior);
    const after = yield* read(at + 2 * MINUTE);
    assert.deepStrictEqual(
      after.facts.map((fact) => fact.key),
      before.facts.map((fact) => fact.key),
    );
    assert.deepStrictEqual(after.setAside, before.setAside);

    yield* insert({ id: "DL-4", list: "deals", title: "Invented new deal", partyId: "C-1" });
    const previous = (yield* read(at + 2 * MINUTE)).facts.filter(
      (fact) => fact.subject.key === "DL-4",
    );
    assert.lengthOf(previous, 1);
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state)
      VALUES ('failed-check-in', ${orgId}, ${chief}, 'pulse', 'P2', '{}', 0, 0, 'failed')`;
    yield* markTold({
      orgId,
      personId: rhea,
      facts: previous,
      eventId: "failed-check-in",
      at,
      zone: "UTC",
    });
    yield* toggle(2, false);
    const whileOff = at + 3 * MINUTE;
    assert.deepStrictEqual((yield* tickAt(whileOff)).woken, []);
    const persisted = yield* sql<{ wokeAt: number }>`SELECT woke_at AS "wokeAt"
      FROM kin_pulse_facts WHERE org_id = ${orgId} AND fact_key LIKE 'deal_no_next_step:DL-4:%'`;
    assert.deepStrictEqual(persisted, [{ wokeAt: whileOff }]);
    yield* toggle(3, true);
    assert.deepStrictEqual((yield* tickAt(at + 4 * MINUTE)).woken, []);
    const restored = (yield* read(at + 4 * MINUTE)).facts.filter(
      (fact) => fact.subject.key === "DL-4",
    );
    assert.lengthOf(restored, 1);
    for (const personId of [rhea, zoya])
      assert.deepStrictEqual(
        yield* untold({ orgId, personId, facts: restored, at: at + 4 * MINUTE, zone: "UTC" }),
        [],
      );
  }).pipe(Effect.provide(chatLayer)),
);

it.effect("Deals off keeps ordinary linked work and leaves the next new deal deliverable", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const toggle = (rev: number, on: boolean) =>
      KinShell.KinShell.use((shell) => shell.set(orgId, rhea, rev, [{ id: "deals", on }])).pipe(
        Effect.provide(KinShell.layer),
      );
    yield* step("W-1", "DL-1", MONDAY - HOUR);
    yield* insert({ id: "C-4", list: "clients", title: "Invented prospect", category: "prospect" });
    yield* insert({
      id: "W-2",
      list: "work",
      title: "Invented call next week",
      category: "task",
      partyId: "C-1",
      dueAt: MONDAY + 3 * DAY,
    });
    yield* step("W-3", "DL-1", MONDAY + HOUR);
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 1, 0)`;
    yield* insert({
      id: "INV-1",
      list: "invoices",
      title: "Invented overdue invoice",
      state: "waiting",
      partyId: "C-1",
      ownerKind: "person",
      ownerId: rhea,
      dueAt: MONDAY - 14 * DAY,
    });
    yield* sql`UPDATE kin_records SET amount_minor = 10000, currency = 'GBP'
      WHERE org_id = ${orgId} AND key = 'INV-1'`;

    yield* toggle(0, false);
    yield* tickAt(MONDAY);
    const live = (yield* read(MONDAY)).facts;
    assert.isTrue(live.some((fact) => fact.subject.key === "W-1" && fact.sense === "task_late"));
    assert.isTrue(
      live.some((fact) => fact.subject.key === "INV-1" && fact.sense === "invoice_overdue"),
    );
    const mutedPages = yield* pagesTo(zoya);
    assert.lengthOf(mutedPages, 1);
    assert.include(mutedPages[0]!.body, "W-1");
    for (const page of mutedPages) {
      assert.notInclude(page.body, "Stock and orders system");
      assert.notInclude(page.body, "Invented prospect");
    }
    yield* toggle(1, true);
    yield* insert({
      id: "DL-2",
      list: "deals",
      title: "Invented fresh showroom",
      partyId: "C-1",
      createdAt: MONDAY + DAY,
    });
    yield* tickAt(MONDAY + DAY);
    assert.isTrue(
      (yield* pagesTo(zoya)).some((page) => page.body.includes("Invented fresh showroom")),
    );
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_pulse_told WHERE org_id = ${orgId}
      AND person_id = ${zoya} AND fact_key LIKE 'deal_no_next_step:DL-2:%'
      AND event_id NOT LIKE 'shell:quiet:%'`,
      1,
    );
  }).pipe(Effect.provide(chatLayer)),
);

it.effect("a broken shell read keeps woke and current facts in the prompt", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* step("W-1", "DL-1", MONDAY - HOUR);
    const prompt = buildPulseSection({
      orgId,
      agentId: chief,
      now: MONDAY,
      wokeFor: ["task_late:W-2:gone"],
    });
    const baseline = yield* prompt;
    const dealKey = "deal_no_next_step:DL-2:old";
    const gone = buildPulseSection({ orgId, agentId: chief, now: MONDAY, wokeFor: [dealKey] });
    yield* KinShell.KinShell.use((shell) =>
      shell.set(orgId, rhea, 0, [{ id: "deals", on: false }]),
    ).pipe(Effect.provide(KinShell.layer));
    assert.notInclude(JSON.stringify(yield* gone), dealKey);
    assert.isDefined(baseline);
    assert.include(JSON.stringify(baseline), "task_late:W-2:gone");
    yield* sql`DROP TABLE kin_company_shell`;
    // Bypass the warm default cache, just as a read in its own snapshot does.
    assert.deepStrictEqual(yield* sql.withTransaction(prompt), baseline);
  }).pipe(Effect.provide(chatLayer)),
);

describe("a teammate's morning page", () => {
  it.effect(
    "comes once at the start of her day, as a page, and tells a fact again only when it changes",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* step("W-2", "DL-1", Date.UTC(2026, 10, 2, 15));
        yield* insert({
          id: "C-3",
          list: "clients",
          title: "Quillon Studios",
          category: "prospect",
        });
        yield* insert({
          id: "W-4",
          list: "work",
          title: "Intro call",
          category: "task",
          partyId: "C-3",
          dueAt: Date.UTC(2026, 10, 4, 10),
        });
        yield* insert({
          id: "C-4",
          list: "clients",
          title: "Fennick & Daughters",
          category: "prospect",
        });
        // W-2, due today, reaches her as the holder notice before her day starts; the page doesn't repeat it.
        yield* tickAt(MONDAY - MINUTE);
        assert.lengthOf(yield* pagesTo(zoya), 0);
        yield* tickAt(MONDAY);
        assert.deepStrictEqual(yield* pagesTo(zoya), [
          {
            form: "brief",
            body: [
              "Clients:",
              "- Follow-ups today: 1.",
              "- Fennick & Daughters is a prospect with no deal and no next step.",
              "",
              "Coming up:",
              "- Intro call (Quillon Studios), Wed 4 Nov.",
              "- Stock and orders system for Corran Tiles is expected by Sun 8 Nov.",
            ].join("\n"),
          },
        ]);
        // The same morning again, and the next morning with nothing new: nothing more.
        yield* tickAt(MONDAY + 15 * MINUTE);
        yield* tickAt(MONDAY + DAY);
        assert.lengthOf(yield* pagesTo(zoya), 1);
        // Nobody else got one: Arjun has nothing of his; Dev has no Clients; Rhea has her own brief.
        for (const person of [arjun, dev, rhea]) assert.lengthOf(yield* pagesTo(person), 0, person);
        // Its step done long ago, the deal goes quiet, then twice as quiet: told each time, once.
        yield* sql`UPDATE kin_records SET state = 'done', closed_at = ${B + HOUR},
        updated_at = ${B + HOUR} WHERE record_id = 'r-W-2'`;
        yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id IN ('r-W-4', 'r-C-4')`;
        const quiet = MONDAY + 14 * DAY;
        yield* tickAt(quiet);
        yield* tickAt(quiet + HOUR);
        yield* tickAt(quiet + 14 * DAY);
        const pages = (yield* pagesTo(zoya)).map((page) => page.body);
        assert.lengthOf(pages, 3);
        assert.include(pages[1], "has been quiet for");
        assert.include(pages[2], "has been quiet for");
        assert.notInclude(pages[2], "has no next step");
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("keeps her own time, days and zone, and waits out her quiet hours", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // Auckland, working Monday and Wednesday from 09:00: Monday 09:00 there is Sunday 20:00 UTC.
      yield* sql`UPDATE kin_people SET time_zone = 'Pacific/Auckland',
          work_hours_json = ${JSON.stringify({ days: [1, 3], start: "09:00", end: "17:00" })},
          quiet_hours_json = ${JSON.stringify({ from: "09:00", to: "09:30" })}
        WHERE person_id = ${zoya}`;
      const monday = Date.UTC(2026, 10, 1, 20);
      yield* tickAt(monday - MINUTE);
      // Her quiet hours hold it; it goes once they end.
      yield* tickAt(monday);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(monday + 30 * MINUTE);
      assert.lengthOf(yield* pagesTo(zoya), 1);
      // A day ahead of the company, she still reads its day: Sunday, not her Monday.
      assert.include((yield* pagesTo(zoya))[0]!.body, "is expected by Sun 8 Nov.");
      // Tuesday is not one of her days; a new fact waits for Wednesday.
      yield* insert({ id: "C-5", list: "clients", title: "Saltvik", category: "prospect" });
      yield* tickAt(monday + DAY + 30 * MINUTE);
      assert.lengthOf(yield* pagesTo(zoya), 1);
      yield* tickAt(monday + 2 * DAY + 30 * MINUTE);
      assert.lengthOf(yield* pagesTo(zoya), 2);
      assert.deepStrictEqual(morningOf(null), { at: "08:00", days: [1, 2, 3, 4, 5], on: true });
      // Six hours past her start it no longer comes that day.
      assert.isUndefined(morningDue({ at: "08:00", days: [1] }, "UTC", MONDAY + 6 * HOUR));
      assert.strictEqual(morningDue({ at: "08:00", days: [1] }, "UTC", MONDAY), "2026-11-02");
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("is hers to set in Settings: its time and days in her zone, and nobody else's", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET time_zone = 'Pacific/Auckland' WHERE person_id = ${zoya}`;
      yield* TestClock.setTime(B);
      const weekdays = [1, 2, 3, 4, 5];
      const page = { kind: "morning", around: false, page: true } as const;
      assert.deepStrictEqual(yield* pageOf(zoya), {
        zone: "Pacific/Auckland",
        briefs: [{ ...page, at: "08:00", days: weekdays, on: true }],
      });
      // Clients off, or an agent of her own, and there is no page to set.
      for (const person of [dev, rhea]) {
        assert.deepStrictEqual((yield* pageOf(person)).briefs, [], person);
        const refused = yield* setPage(person, B, { at: "07:00", days: [1], on: true }).pipe(
          Effect.flip,
        );
        assert.include(refused, { _tag: "KinChatError", reason: "not_allowed" });
      }
      const saved = yield* setPage(zoya, B, { at: "07:15", days: [2], on: true });
      assert.deepStrictEqual(saved.briefs, [{ ...page, at: "07:15", days: [2], on: true }]);
      assert.deepStrictEqual(yield* pageOf(arjun), {
        zone: "UTC",
        briefs: [{ ...page, at: "08:00", days: weekdays, on: true }],
      });
      // Monday 08:00 in Auckland is not one of her days; Tuesday 07:15 there is Monday 18:15 UTC.
      yield* tickAt(Date.UTC(2026, 10, 1, 19));
      yield* tickAt(Date.UTC(2026, 10, 2, 18, 14));
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(Date.UTC(2026, 10, 2, 18, 15));
      assert.lengthOf(yield* pagesTo(zoya), 1);
      // Arjun's own page is untouched: at his default, on his own clock.
      const [stored] = yield* sql<{ morning: string | null }>`SELECT morning_json AS morning
        FROM kin_people WHERE person_id = ${arjun}`;
      assert.isNull(stored?.morning ?? null);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("off sends nothing and keeps her facts; on again, it starts the next morning", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const off = yield* setPage(zoya, B, { at: "08:00", days: [1], on: false, changed: ["on"] });
      assert.include(off.briefs[0], { at: "08:00", on: false });
      assert.deepStrictEqual(off.briefs[0]?.days, [1, 2, 3, 4, 5]);
      yield* tickAt(MONDAY);
      yield* tickAt(MONDAY + HOUR);
      const posts = yield* sql`SELECT 1 FROM kin_messages m
        JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
        WHERE c.direct_key = ${`${zoya}:${chief}`}`;
      assert.lengthOf(posts, 0);
      assert.deepStrictEqual(senses((yield* asZoya(MONDAY + HOUR)).facts), ["deal_no_next_step"]);
      yield* setPage(zoya, MONDAY + 2 * HOUR, {
        at: "08:00",
        days: [1],
        on: true,
        changed: ["on"],
      });
      yield* tickAt(MONDAY + 2 * HOUR + MINUTE);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(MONDAY + DAY);
      assert.lengthOf(yield* pagesTo(zoya), 1);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "a time moved later the same morning goes at the new time, once; after it went, tomorrow",
    () =>
      Effect.gen(function* () {
        yield* seed;
        for (const [id, day] of [
          ["W-6", 2],
          ["W-7", 3],
          ["W-8", 4],
          ["W-9", 5],
        ] as const)
          yield* insert({
            id,
            list: "work",
            title: "Send the tile samples",
            category: "task",
            partyId: "C-1",
            dueAt: Date.UTC(2026, 10, day, 16),
          });
        const all = { days: [1, 2, 3, 4, 5], on: true };
        yield* setPage(zoya, MONDAY - 30 * MINUTE, { at: "09:00", ...all });
        yield* tickAt(MONDAY);
        assert.lengthOf(yield* pagesTo(zoya), 0);
        yield* tickAt(MONDAY + HOUR);
        yield* tickAt(MONDAY + HOUR + 15 * MINUTE);
        assert.lengthOf(yield* pagesTo(zoya), 1);
        // Moved after it went: nothing more today, the new time from tomorrow.
        yield* setPage(zoya, MONDAY + 2 * HOUR, { at: "11:00", ...all });
        yield* tickAt(MONDAY + 3 * HOUR);
        assert.lengthOf(yield* pagesTo(zoya), 1);
        // Each later page has something untold to carry.
        yield* insert({ id: "C-8", list: "clients", title: "Saltvik", category: "prospect" });
        yield* tickAt(MONDAY + DAY + 3 * HOUR - MINUTE);
        assert.lengthOf(yield* pagesTo(zoya), 1);
        yield* tickAt(MONDAY + DAY + 3 * HOUR);
        assert.lengthOf(yield* pagesTo(zoya), 2);
        // Moved to a time already past, before it went: it starts the next morning.
        yield* setPage(zoya, MONDAY + 2 * DAY + 2 * HOUR, { at: "09:30", ...all });
        yield* insert({ id: "C-9", list: "clients", title: "Halden", category: "prospect" });
        yield* tickAt(MONDAY + 2 * DAY + 2 * HOUR + MINUTE);
        yield* tickAt(MONDAY + 2 * DAY + 3 * HOUR);
        assert.lengthOf(yield* pagesTo(zoya), 2);
        yield* tickAt(MONDAY + 3 * DAY + 90 * MINUTE);
        assert.lengthOf(yield* pagesTo(zoya), 3);
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("an imported deal is told at the next morning, not when it lands", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* step("W-2", "DL-1", Date.UTC(2026, 10, 20));
      yield* tickAt(MONDAY);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* insert({
        id: "DL-4",
        list: "deals",
        title: "Warehouse scanners",
        partyId: "C-1",
        origin: "import:b1:entry:row-7",
        createdAt: MONDAY + 2 * HOUR,
      });
      yield* tickAt(MONDAY + 2 * HOUR);
      yield* tickAt(MONDAY + 5 * HOUR);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(MONDAY + DAY);
      const [page] = yield* pagesTo(zoya);
      assert.include(page?.body, "Warehouse scanners for Corran Tiles has no next step.");
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a company with no deals and no prospects hears nothing new", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM kin_records WHERE register_id = 'deals'`;
      yield* insert({
        id: "W-5",
        list: "work",
        title: "Send the tile samples",
        category: "task",
        partyId: "C-1",
        dueAt: MONDAY + 4 * HOUR,
      });
      const result = yield* tickAt(MONDAY);
      assert.deepStrictEqual(result.pages, []);
      assert.isFalse((yield* read(MONDAY)).facts.some((fact) => fact.sense.startsWith("deal_")));
      for (const person of [zoya, arjun, dev]) assert.lengthOf(yield* pagesTo(person), 0, person);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a morning with nothing untold sends no page, so no push and no unread", () =>
    Effect.gen(function* () {
      yield* seed;
      // The deal's step is due today and its own notice told it at 07:59: only the count is left.
      yield* step("W-2", "DL-1", MONDAY + 4 * HOUR);
      yield* tickAt(MONDAY - MINUTE);
      const result = yield* tickAt(MONDAY);
      assert.deepStrictEqual(result.pages, []);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      // Decided at its minute: a fact true later that morning waits for the next one.
      yield* insert({ id: "C-7", list: "clients", title: "Maple Kiln", category: "prospect" });
      yield* tickAt(MONDAY + HOUR);
      assert.lengthOf(yield* pagesTo(zoya), 0);
      yield* tickAt(MONDAY + DAY);
      const [page] = yield* pagesTo(zoya);
      assert.include(page?.body, "Maple Kiln is a prospect with no deal and no next step.");
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("goes at its minute, whatever else has run since its facts arose", () =>
    Effect.gen(function* () {
      yield* seed;
      // A deal with no next step is made at 07:50; nothing else moves before 08:00.
      yield* insert({
        id: "DL-5",
        list: "deals",
        title: "Showroom tiles",
        partyId: "C-1",
        createdAt: MONDAY - 10 * MINUTE,
      });
      const sent = yield* passes(new Map(), MONDAY - 10 * MINUTE, MONDAY + 20 * MINUTE);
      assert.strictEqual(sent, MONDAY);
      const [page] = yield* pagesTo(zoya);
      assert.include(page?.body, "Showroom tiles for Corran Tiles has no next step.");
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a set 09:30 on Tuesday and Thursday goes at 09:30 on Tuesday, never at 08:00", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* setPage(zoya, B, { at: "09:30", days: [2, 4], on: true });
      const last: KinPulse.Passes = new Map();
      assert.isUndefined(yield* passes(last, MONDAY - 10 * MINUTE, MONDAY + 2 * HOUR));
      const tuesday = MONDAY + DAY;
      assert.strictEqual(
        yield* passes(last, tuesday - 10 * MINUTE, tuesday + 2 * HOUR),
        tuesday + 90 * MINUTE,
      );
      assert.deepStrictEqual(yield* toldDays(zoya), ["2026-11-03"]);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a server down at the minute sends it once, late; back the next day, not at all", () =>
    Effect.gen(function* () {
      yield* seed;
      // Down from 07:59; back at 08:20 with nothing remembered: it goes then, once.
      assert.isUndefined(yield* passes(new Map(), MONDAY - 10 * MINUTE, MONDAY - MINUTE));
      const back: KinPulse.Passes = new Map();
      assert.strictEqual(
        yield* passes(back, MONDAY + 20 * MINUTE, MONDAY + HOUR),
        MONDAY + 20 * MINUTE,
      );
      assert.isUndefined(yield* passes(back, MONDAY + HOUR, MONDAY + 2 * HOUR));
      assert.lengthOf(yield* pagesTo(zoya), 1);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a server back the next morning never sends yesterday's page", () =>
    Effect.gen(function* () {
      yield* seed;
      assert.isUndefined(yield* passes(new Map(), MONDAY - 10 * MINUTE, MONDAY - MINUTE));
      // Down through Monday's minute and its window; back on Tuesday before her minute.
      const tuesday = MONDAY + DAY;
      const back: KinPulse.Passes = new Map();
      assert.isUndefined(yield* passes(back, tuesday - 30 * MINUTE, tuesday - MINUTE));
      assert.strictEqual(yield* passes(back, tuesday, tuesday + 10 * MINUTE), tuesday);
      assert.deepStrictEqual(yield* toldDays(zoya), ["2026-11-03"]);
      assert.lengthOf(yield* pagesTo(zoya), 1);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("off, then on again: what is untold or newly true goes at the next set morning", () =>
    Effect.gen(function* () {
      yield* seed;
      const last: KinPulse.Passes = new Map();
      yield* setPage(zoya, B, { at: "08:00", days: [1, 2, 3, 4, 5], on: false, changed: ["on"] });
      assert.isUndefined(yield* passes(last, MONDAY - 10 * MINUTE, MONDAY + 30 * MINUTE));
      // Newly true while it is off: a prospect with no deal and no next step.
      yield* insert({
        id: "C-6",
        list: "clients",
        title: "Cedar Forge",
        category: "prospect",
        createdAt: MONDAY + DAY + 2 * HOUR,
      });
      assert.isUndefined(yield* passes(last, MONDAY + DAY - MINUTE, MONDAY + DAY + MINUTE));
      yield* setPage(zoya, MONDAY + 2 * DAY + 4 * HOUR, {
        at: "08:00",
        days: [1, 2, 3, 4, 5],
        on: true,
        changed: ["on"],
      });
      const thursday = MONDAY + 3 * DAY;
      assert.strictEqual(
        yield* passes(last, thursday - 10 * MINUTE, thursday + 30 * MINUTE),
        thursday,
      );
      const [page] = yield* pagesTo(zoya);
      assert.include(page?.body, "Stock and orders system for Corran Tiles has no next step.");
      assert.include(page?.body, "Cedar Forge is a prospect with no deal and no next step.");
    }).pipe(Effect.provide(chatLayer)),
  );

  it("writes only the sections with something in them", () => {
    assert.strictEqual(morningBody({ needsYou: [], clients: [], comingUp: [] }), "");
    assert.strictEqual(
      morningBody({
        needsYou: ["W-1 Send the deck, due today"],
        clients: ["Follow-ups today: 2."],
        comingUp: [],
      }),
      "Needs you:\n- W-1 Send the deck, due today\n\nClients:\n- Follow-ups today: 2.",
    );
    // A page under her greeting, its titles real headings: no "##" or "- " reaches her as text.
    const body = morningBody({
      needsYou: ["W-1 Send the deck, due today"],
      clients: ["Follow-ups today: 2."],
      comingUp: ["Intro call (Quillon Studios), Wed 4 Nov."],
    });
    assert.isTrue(kinIsBrief(body, "brief"));
    assert.deepStrictEqual(
      kinPageSections(body).map((section) => section.title),
      ["Needs you", "Clients", "Coming up"],
    );
  });

  it("Settings writes the quiet days into the playbook's own block", () => {
    const block = "# Winning customers\n\n## Thresholds\n```kin\ndeal_quiet_days: 14\n```\n";
    assert.strictEqual(
      withQuietDays(block, 21),
      "# Winning customers\n\n## Thresholds\n```kin\ndeal_quiet_days: 21\n```\n",
    );
    assert.strictEqual(
      withQuietDays("# Ours\n\n```kin\nclient_checkin_days: 10\n```\n", 9),
      "# Ours\n\n```kin\ndeal_quiet_days: 9\nclient_checkin_days: 10\n```\n",
    );
    assert.strictEqual(
      withQuietDays("# Ours\n\nPlain words.\n", 9),
      "# Ours\n\nPlain words.\n\n## Thresholds\n```kin\ndeal_quiet_days: 9\n```\n",
    );
  });
});

describe("the morning page's Money lines", () => {
  /** Kin's money lists, and an issued invoice or a sent quote of Corran Tiles' in `currency`. */
  const money = Effect.fn("test.money")(function* (entry: {
    readonly id: string;
    readonly list: "invoices" | "quotes";
    readonly minor: number;
    readonly currency: string;
    readonly dueAt?: number;
    readonly sentAt: number;
    /** Its own number, as the client reads it on the invoice or quote. */
    readonly number?: string;
    readonly client?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
        owner_kind, owner_id, side, party_id, due_at, amount_minor, currency, created_by_kind,
        created_by_id, origin_key, created_at, updated_at, fields_json)
      VALUES (${orgId}, ${`r-${entry.id}`}, ${entry.list}, ${entry.id}, ${`Work for ${entry.id}`},
        'waiting', 'person', ${rhea}, 'ours', ${`r-${entry.client ?? "C-1"}`},
        ${entry.dueAt ?? null}, ${entry.minor}, ${entry.currency}, 'person', ${rhea},
        ${`origin-${entry.id}`}, ${entry.sentAt}, ${entry.sentAt},
        ${JSON.stringify(entry.number === undefined ? {} : { number: entry.number })})`;
  });
  const lists = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [id, prefix] of [
      ["invoices", "INV"],
      ["quotes", "QT"],
    ] as const)
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES (${orgId}, ${id}, ${id}, ${prefix}, 1, 0)`;
  });
  // Noon UTC is the next morning in Auckland: the calendar days between them stay the same.
  const NOW = B + 20 * DAY + 12 * HOUR;
  const lines = (
    viewer: Parameters<typeof morningMoneyLines>[0]["viewer"] = KIN_OWNER_LEVEL,
    said?: string,
    now = NOW,
  ) => morningMoneyLines({ orgId, now, viewer, said });

  it.effect("tells each overdue invoice and unanswered quote, until settled, in its currency", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lists;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Pacific/Auckland'`;
      yield* money({
        id: "INV-1",
        list: "invoices",
        minor: 120000,
        currency: "NZD",
        dueAt: B + 6 * DAY + 12 * HOUR,
        sentAt: B,
        number: "CT/101",
      });
      // Due tomorrow, and a quote sent four days ago: neither is late yet.
      yield* money({
        id: "INV-2",
        list: "invoices",
        minor: 5000,
        currency: "NZD",
        dueAt: NOW + DAY,
        sentAt: B,
      });
      yield* money({
        id: "QT-1",
        list: "quotes",
        minor: 354000,
        currency: "NZD",
        sentAt: NOW - 6 * DAY - HOUR,
        number: "CQ/7",
      });
      yield* money({
        id: "QT-2",
        list: "quotes",
        minor: 1000,
        currency: "NZD",
        sentAt: NOW - 4 * DAY,
      });
      assert.deepStrictEqual(yield* lines(), [
        // People read the numbers on the papers, never Kin's own keys.
        "Corran Tiles owes NZ$1,200 on CT/101, 14 days overdue; no reminder sent through Kin yet.",
        "Corran Tiles hasn't answered quote CQ/7 for NZ$3,540 in 6 days; no follow-up sent through Kin yet.",
      ]);
      const set = (rev: number, id: "money" | "invoices", on: boolean) =>
        KinShell.KinShell.use((shell) => shell.set(orgId, rhea, rev, [{ id, on }])).pipe(
          Effect.provide(KinShell.layer),
        );
      const on = yield* lines();
      yield* set(0, "invoices", false);
      assert.deepStrictEqual(yield* lines(), []);
      yield* set(1, "money", false);
      assert.deepStrictEqual(yield* lines(), []);
      yield* set(2, "money", true);
      assert.deepStrictEqual(yield* lines(), on);
      // A teammate who may not see Money hears none of it; one who may, the same lines.
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE register_id IN ('invoices', 'quotes')`;
      // The agent named the quote by its title, as an unnumbered one shows: Kin says it once.
      assert.deepStrictEqual(
        yield* lines(KIN_OWNER_LEVEL, "Still chasing the Work for QT-1 quote."),
        [
          "Corran Tiles owes NZ$1,200 on CT/101, 14 days overdue; no reminder sent through Kin yet.",
          "Corran Tiles hasn't answered quote CQ/7 for NZ$3,540 in 6 days; no follow-up sent through Kin yet.",
        ],
      );
      yield* sql`UPDATE kin_records SET fields_json = '{}' WHERE record_id = 'r-QT-1'`;
      assert.deepStrictEqual(
        yield* lines(KIN_OWNER_LEVEL, "Still chasing the Work for QT-1 quote."),
        [
          "Corran Tiles owes NZ$1,200 on CT/101, 14 days overdue; no reminder sent through Kin yet.",
        ],
      );
      yield* sql`UPDATE kin_records SET fields_json = '{"number":"CQ/7"}' WHERE record_id = 'r-QT-1'`;
      assert.deepStrictEqual(yield* lines(viewerOfPeople([zoya])), []);
      yield* sql`UPDATE kin_people SET sees_money = 1 WHERE person_id = ${zoya}`;
      assert.lengthOf(yield* lines(viewerOfPeople([zoya])), 2);
      // Paid in full, and the quote answered: nothing is left to say.
      yield* sql`INSERT INTO kin_record_payments (payment_id, org_id, record_id, amount_minor,
          currency, paid_on, origin_key, created_at, created_by_kind)
        VALUES ('pay-1', ${orgId}, 'r-INV-1', 120000, 'NZD', '2026-11-20', 'pay-1', ${NOW},
          'person')`;
      yield* sql`UPDATE kin_records SET state = 'done' WHERE record_id = 'r-QT-1'`;
      assert.deepStrictEqual(yield* lines(), []);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("each line says where its reminder stands: waiting on a Confirm, sent, or none", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lists;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Pacific/Auckland'`;
      yield* sql`UPDATE kin_agents SET display_name = 'Finance' WHERE agent_id = ${chief}`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES (${orgId}, 'contacts', 'contacts', 'P', 1, 0)`;
      yield* insert({ id: "P-1", list: "contacts", title: "Sam", partyId: "C-1" });
      yield* sql`UPDATE kin_records SET fields_json = '{"email":"sam@corran.example"}'
        WHERE record_id = 'r-P-1'`;
      const due = B + 6 * DAY + 12 * HOUR;
      yield* money({
        id: "INV-1",
        list: "invoices",
        minor: 120000,
        currency: "NZD",
        dueAt: due,
        sentAt: B,
        number: "CT/101",
      });
      const quoted = NOW - 6 * DAY - HOUR;
      yield* money({
        id: "QT-1",
        list: "quotes",
        minor: 354000,
        currency: "NZD",
        sentAt: quoted,
        number: "CQ/7",
      });
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host, auth,
          reach, state, created_at, updated_at, person_id)
        VALUES (${orgId}, 'company', 'Outlook', 'remote', 'graph.example', 'none', 'open', 'active',
            1, 1, NULL),
          (${orgId}, 'own', 'Gmail', 'remote', 'gmail.example', 'none', 'open', 'active', 1, 1,
            ${rhea})`;
      let n = 0;
      const ask = (input: {
        readonly entry: string;
        readonly connection: "company" | "own";
        readonly state: "open" | "sent";
        readonly at: number;
      }) =>
        sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name, pin_digest,
            payload_json, agent_id, wakeup_id, chat_id, entry_record_id, state, proposed_at,
            done_at)
          VALUES (${orgId}, ${`ask-${++n}`}, ${input.connection}, 'mail_send', 'pin',
            ${JSON.stringify({
              _tag: "email",
              to: ["sam@corran.example"],
              cc: [],
              subject: "A reminder",
              body: "Attached.",
              threadId: null,
              inReplyTo: null,
              references: null,
              attachments: [],
            })}, ${chief}, 'w', ${`chat-${chief}`}, ${input.entry}, ${input.state}, ${input.at},
            ${input.state === "sent" ? input.at : null})`;
      const invoice = "Corran Tiles owes NZ$1,200 on CT/101, 14 days overdue";
      const quote = "Corran Tiles hasn't answered quote CQ/7 for NZ$3,540 in 6 days";
      // Kin knows only mail sent through it; the invoice's own mail before its due day is no reminder.
      yield* ask({ entry: "r-INV-1", connection: "company", state: "sent", at: B });
      yield* ask({ entry: "r-QT-1", connection: "company", state: "sent", at: quoted - HOUR });
      assert.deepStrictEqual(yield* lines(), [
        `${invoice}; no reminder sent through Kin yet.`,
        `${quote}; no follow-up sent through Kin yet.`,
      ]);
      // Sunday evening in UTC is Monday morning in Auckland: the day is the company's.
      yield* ask({
        entry: "r-INV-1",
        connection: "company",
        state: "sent",
        at: Date.UTC(2026, 10, 15, 20),
      });
      yield* ask({ entry: "r-QT-1", connection: "company", state: "sent", at: NOW - DAY });
      const sent = [
        `${invoice}; reminder sent Mon 16 Nov.`,
        `${quote}; follow-up sent Sat 21 Nov.`,
      ];
      assert.deepStrictEqual(yield* lines(), sent);
      // A card from someone's own mailbox stays theirs.
      yield* ask({ entry: "r-INV-1", connection: "own", state: "open", at: NOW - HOUR });
      assert.deepStrictEqual(yield* lines(), sent);
      yield* ask({ entry: "r-INV-1", connection: "company", state: "open", at: NOW - 2 * HOUR });
      yield* ask({ entry: "r-QT-1", connection: "company", state: "open", at: NOW - 2 * HOUR });
      assert.deepStrictEqual(yield* lines(), [
        `${invoice}; a reminder to Sam waits on your Confirm in Finance's chat.`,
        `${quote}; a follow-up to Sam waits on your Confirm in Finance's chat.`,
      ]);
      // A teammate who sees Money can't open the owner's chat: they hear only what was sent.
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE register_id IN ('invoices', 'quotes')`;
      yield* sql`UPDATE kin_people SET sees_money = 1 WHERE person_id = ${zoya}`;
      assert.deepStrictEqual(yield* lines(viewerOfPeople([zoya])), sent);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect(
    "lists ten of each in full; past ten, eight, longest overdue first, then the rest",
    () =>
      Effect.gen(function* () {
        yield* seed;
        yield* lists;
        const sql = yield* SqlClient.SqlClient;
        for (const count of [9, 10, 11]) {
          yield* sql`DELETE FROM kin_records WHERE register_id IN ('invoices', 'quotes')`;
          for (let n = 1; n <= count; n++) {
            yield* money({
              id: `INV-${n}`,
              list: "invoices",
              minor: n * 100_000,
              currency: "COP",
              dueAt: NOW - n * DAY,
              sentAt: B,
              number: `CT/${n}`,
            });
            yield* money({
              id: `QT-${n}`,
              list: "quotes",
              minor: n * 1_000,
              currency: "COP",
              sentAt: NOW - (6 + n) * DAY,
              number: `CQ/${n}`,
            });
          }
          const told = yield* lines();
          const invoices = told.filter((line) => line.includes("overdue"));
          const quotes = told.filter((line) => line.includes("answered quote"));
          assert.lengthOf(invoices, count > 10 ? 9 : count);
          assert.lengthOf(quotes, count > 10 ? 9 : count);
          assert.match(
            invoices[0] ?? "",
            new RegExp(
              `on CT/${count}, ${count} days overdue; no reminder sent through Kin yet\\.$`,
            ),
          );
          if (count > 10) {
            // What is cut is the least overdue and the most recently sent, and the cut says what it holds.
            assert.match(invoices[8] ?? "", /^and 3 more overdue invoices, COP\s600,000 in all\.$/);
            assert.match(quotes[8] ?? "", /^and 3 more unanswered quotes, COP\s6,000 in all\.$/);
          } else assert.isFalse(told.some((line) => line.startsWith("and ")));
        }
      }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("leaves out what is set aside until its day, and what the agent already said", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lists;
      yield* insert({
        id: "C-2",
        list: "clients",
        title: "Harbor Foundry LLP",
        category: "client",
      });
      const due = NOW - 14 * DAY;
      for (const [id, number, client] of [
        ["INV-1", "CT/101", "C-1"],
        ["INV-2", "CT/102", "C-1"],
        ["INV-3", "HF/9", "C-2"],
      ] as const)
        yield* money({
          id,
          list: "invoices",
          minor: 120000,
          currency: "EUR",
          dueAt: due,
          sentAt: B,
          number,
          client,
        });
      // "Don't remind me till then": the Chief of staff takes CT/101 in hand for ten days on
      // Rhea's word, and Rhea sets CT/102 aside for three.
      yield* KinPulse.handle({
        orgId,
        at: NOW,
        viewer: { _tag: "owner" },
        by: { _tag: "agent", agentId: chief },
        factKey: `invoice_overdue:INV-1:base=${due}`,
        action: "got_it",
        until: NOW + 10 * DAY,
      });
      yield* KinPulse.aside({
        orgId,
        at: NOW,
        viewer: { _tag: "owner" },
        by: { _tag: "person", personId: rhea },
        recordKey: "INV-2",
        action: "set",
        until: NOW + 3 * DAY,
        note: null,
        holding: { _tag: "may", forPersonId: null, onWordOf: null },
      });
      const harbor =
        "Harbor Foundry LLP owes €1,200 on HF/9, 14 days overdue; no reminder sent through Kin yet.";
      assert.deepStrictEqual(yield* lines(), [harbor]);
      // The agent's own Money section names a debt, by its client or its number: Kin adds none.
      assert.deepStrictEqual(
        yield* lines(KIN_OWNER_LEVEL, "- Harbor Foundry: €1,200, 14 days."),
        [],
      );
      assert.deepStrictEqual(yield* lines(KIN_OWNER_LEVEL, "- HF/9 is still open."), []);
      assert.deepStrictEqual(yield* lines(KIN_OWNER_LEVEL, "- Harbor Foundryworks paid."), [
        harbor,
      ]);
      // Each comes back by itself when its day passes.
      assert.deepStrictEqual(yield* lines(KIN_OWNER_LEVEL, undefined, NOW + 3 * DAY), [
        "Corran Tiles owes €1,200 on CT/102, 17 days overdue; no reminder sent through Kin yet.",
        "Harbor Foundry LLP owes €1,200 on HF/9, 17 days overdue; no reminder sent through Kin yet.",
      ]);
      assert.lengthOf(yield* lines(KIN_OWNER_LEVEL, undefined, NOW + 10 * DAY), 3);
    }).pipe(Effect.provide(chatLayer)),
  );

  it.effect("a reader who may see Money gets their page for it alone, every morning", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* lists;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET sees_money = 1 WHERE person_id = ${zoya}`;
      yield* money({
        id: "INV-1",
        list: "invoices",
        minor: 120000,
        currency: "EUR",
        dueAt: B - 3 * DAY,
        sentAt: B - 9 * DAY,
      });
      yield* sql`UPDATE kin_records SET team_shared = 1 WHERE register_id = 'invoices'`;
      yield* tickAt(MONDAY - MINUTE);
      yield* tickAt(MONDAY);
      yield* tickAt(MONDAY + DAY);
      const pages = (yield* pagesTo(zoya)).map((page) => page.body);
      assert.lengthOf(pages, 2);
      for (const page of pages)
        assert.include(page, 'Money:\n- Corran Tiles owes €1,200 on "Work for INV-1",');
      // Arjun may not see Money: his page, if any, has none.
      for (const page of yield* pagesTo(arjun)) assert.notInclude(page.body, "Money:");
    }).pipe(Effect.provide(chatLayer)),
  );
});
