import { assert, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { dayRecord, QUIET_DAY, shownDay } from "./dayRecord.ts";

// Invented company: Ambermill, owner Rhea, teammate Zoya, agent Finance.
const orgId = KinOrgId.make("org");
const stamp = "2026-11-01T00:00:00.000Z";
const HOUR = 3_600_000;
// Fri 20 Nov in a company at UTC+9: its day runs from 19 Nov 15:00 UTC to 20 Nov 15:00 UTC.
const from = Date.parse("2026-11-19T15:00:00.000Z");
const until = from + 24 * HOUR;

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${stamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', ${stamp}), ('zoya', ${orgId}, 'zoya', 'Zoya', ${stamp})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('fin', ${orgId}, 'Finance', 'specialist', 'rhea', ${stamp})`;
  for (const [list, prefix] of [
    ["work", "W"],
    ["invoices", "INV"],
    ["clients", "C"],
  ])
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, ${list}, ${list}, ${prefix}, 1, 0)`;
  const record = (
    key: string,
    list: string,
    title: string,
    extra: {
      state?: string;
      owner?: string;
      sensitive?: number;
      confirmed?: number;
      createdAt?: number;
    } = {},
  ) =>
    sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, sensitive, confirmed, created_by_kind, created_by_id, origin_key, created_at,
        updated_at, team_shared)
      VALUES (${orgId}, ${`r-${key}`}, ${list}, ${key}, ${title}, ${extra.state ?? "open"},
        'person', ${extra.owner ?? "rhea"}, ${extra.sensitive ?? 0}, ${extra.confirmed ?? 1},
        'person', 'rhea', ${`o-${key}`}, ${extra.createdAt ?? from - 30 * 24 * HOUR},
        ${extra.createdAt ?? from - 30 * 24 * HOUR}, 1)`;
  const change = (
    key: string,
    at: number,
    actor: readonly [string, string],
    kind: string,
    fields: string,
  ) =>
    sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id, via, kind,
        fields_json)
      VALUES (${orgId}, ${`r-${key}`}, 2, ${at}, ${actor[0]}, ${actor[1]}, 'owner', ${kind}, ${fields})`;
  yield* record("W-6", "work", "Beta release to two pilot clinics", { state: "done" });
  yield* record("W-1", "work", "Design the booking flow screens", {
    state: "doing",
    owner: "zoya",
  });
  yield* record("W-4", "work", "Pilot handoff checklist");
  yield* record("W-9", "work", "Rhea's own private errand", { sensitive: 1 });
  yield* record("W-2", "work", "Changed yesterday, company time", { state: "doing" });
  yield* record("INV-2", "invoices", "Renewal invoice, Orbit Dental", {
    confirmed: 0,
    createdAt: from + 12 * HOUR,
  });
  yield* record("INV-1", "invoices", "Retainer, Orbit Dental", { state: "waiting" });
  yield* record("C-2", "clients", "Orbit Dental Care");
  yield* change(
    "W-6",
    from + 30 * 60_000,
    ["person", "rhea"],
    "updated",
    '[{"field":"state","from":"open","to":"done"}]',
  );
  yield* change(
    "W-1",
    from + 2 * HOUR,
    ["person", "zoya"],
    "updated",
    '[{"field":"state","from":"open","to":"doing"}]',
  );
  yield* change(
    "W-9",
    from + 3 * HOUR,
    ["person", "rhea"],
    "updated",
    '[{"field":"state","from":"open","to":"doing"}]',
  );
  // 23:59 the day before in the company's zone, though the same UTC day as the rest.
  yield* change(
    "W-2",
    from - 60_000,
    ["person", "rhea"],
    "updated",
    '[{"field":"state","from":"open","to":"doing"}]',
  );
  yield* change(
    "INV-2",
    from + 12 * HOUR,
    ["agent", "fin"],
    "created",
    '[{"field":"state","from":null,"to":"open"}]',
  );
  yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
      author_id, body, request_hash, created_at)
    VALUES (${orgId}, 'n1', 'r-W-4', 1, 'person', 'rhea', 'The clinic confirmed the checklist.',
      'h1', ${from + 9 * HOUR + 30 * 60_000})`;
  yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor, currency,
      paid_on, origin_key, created_at, created_by_kind, created_by_id)
    VALUES (${orgId}, 'p1', 'r-INV-1', 2000000, 'INR', '2026-11-20', 'pay-1', ${from + 5 * HOUR},
      'person', 'rhea')`;
  // A payment on a suggestion is in no money line until someone keeps it.
  yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor, currency,
      paid_on, origin_key, created_at, created_by_kind, created_by_id)
    VALUES (${orgId}, 'p2', 'r-INV-2', 975000, 'INR', '2026-11-20', 'pay-2', ${from + 13 * HOUR},
      'agent', 'fin')`;
  yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, note,
      logged_by_kind, logged_by_id, origin_key, created_at)
    VALUES (${orgId}, 't1', 'r-C-2', ${from + 6 * HOUR}, 'email', 'Billing contact for INV-1',
      'agent', 'fin', 'mail-in:x', ${from + 6 * HOUR})`;
});

it.effect(
  "lists what was finished, moved, noted, made, paid and mailed on the company's day, as its reader may see",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const owner = yield* dayRecord({
        orgId,
        from,
        until,
        viewer: KIN_OWNER_LEVEL,
        agentId: "fin",
      });
      assert.deepStrictEqual(owner, {
        finished: ["W-6 Beta release to two pilot clinics, done by Rhea (owner)"],
        changed: [
          "W-1 Design the booking flow screens: now in progress (Zoya)",
          "W-9 Rhea's own private errand: now in progress (Rhea (owner))",
        ],
        notes: [
          'W-4 Pilot handoff checklist: note by Rhea (owner): "The clinic confirmed the checklist."',
        ],
        made: [
          "INV-2 Renewal invoice, Orbit Dental (invoice, suggested, not kept yet), by Finance (you)",
        ],
        money: ["₹20,000.00 in on INV-1 Retainer, Orbit Dental, recorded by Rhea (owner)"],
        mail: ['received from C-2 Orbit Dental Care: "Billing contact for INV-1"'],
      });
      const zoya = yield* dayRecord({
        orgId,
        from,
        until,
        viewer: viewerOfPeople([KinPersonId.make("zoya")]),
        agentId: "fin",
      });
      assert.deepStrictEqual(zoya.changed, [
        "W-1 Design the booking flow screens: now in progress (Zoya)",
      ]);
      assert.deepStrictEqual(zoya.mail, []);
      const before = yield* dayRecord({
        orgId,
        from: from - 24 * HOUR,
        until: from,
        viewer: KIN_OWNER_LEVEL,
        agentId: "fin",
      });
      assert.deepStrictEqual(before.changed, [
        "W-2 Changed yesterday, company time: now in progress (Rhea (owner))",
      ]);
      // A day with nothing in the records says so in one line; one with something, never.
      assert.strictEqual(
        shownDay(
          yield* dayRecord({
            orgId,
            from: until,
            until: until + 24 * HOUR,
            viewer: KIN_OWNER_LEVEL,
            agentId: "fin",
          }),
        ),
        QUIET_DAY,
      );
      assert.deepStrictEqual(shownDay({ ...owner, changed: [], mail: [] }), {
        finished: owner.finished,
        notes: owner.notes,
        made: owner.made,
        money: owner.money,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("caps each list with a count of the rest", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    for (let n = 0; n < 12; n++)
      yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
            author_id, body, request_hash, created_at)
          VALUES (${orgId}, ${`m${n}`}, 'r-W-1', ${n + 1}, 'person', 'zoya', ${`Step ${n}`},
            ${`hm${n}`}, ${from + HOUR + n})`;
    const { notes } = yield* dayRecord({
      orgId,
      from,
      until,
      viewer: KIN_OWNER_LEVEL,
      agentId: "fin",
    });
    assert.lengthOf(notes, 10);
    assert.equal(notes[9], "and 4 more");
  }).pipe(Effect.provide(layer)),
);
