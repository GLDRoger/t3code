import { assert, it } from "@effect/vitest";
import { KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinShell from "../../shell/KinShell.ts";
import { fixture, orgId, seed } from "../../triggers/routines.testkit.ts";
import * as KinPulse from "../KinPulse.ts";
import { screenFacts } from "../people.ts";
import { markTold, untold } from "../told.ts";
import { moneySenses } from "./money.ts";

const day = 86_400_000;
const at = Date.UTC(2026, 10, 19, 10);
const owner = KinPersonId.make("owner-a");
const teammate = KinPersonId.make("teammate");

it.effect("capped counts reach the pulse, gated by section and record visibility", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'UTC', '08:30', '18:30',
      '03:00', 0, 1, '09:00', '[]')`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${teammate}, ${orgId}, 'meera', 'Meera', '2026-11-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'work', 'Work', 'W', 1, 0), (${orgId}, 'invoices', 'Invoices', 'INV', 1, 0)`;
    const invoices = (from: number, to: number) => sql`WITH RECURSIVE series(i) AS (
      VALUES (CAST(${from} AS INTEGER)) UNION ALL SELECT i+1 FROM series WHERE i < ${to})
      INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, due_at, amount_minor, currency, confirmed, created_by_kind, origin_key, created_at, updated_at)
      SELECT ${orgId}, 'invoice-' || i, 'invoices', 'INV-' || i, 'Invented invoice', 'waiting',
        'person', ${owner}, ${at - 14 * day} + i, 1000, 'USD', 1, 'person', 'invoice-' || i, 0, 0
      FROM series ORDER BY i`;
    yield* invoices(1, 530);
    yield* sql`WITH RECURSIVE series(i) AS (VALUES (1) UNION ALL SELECT i+1 FROM series WHERE i < 510)
      INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, due_at, confirmed, sensitive, created_by_kind, origin_key, created_at, updated_at)
      SELECT ${orgId}, 'task-' || i, 'work', 'W-' || i, 'Invented task', 'open',
        'person', CASE WHEN i % 2 = 0 THEN ${teammate} ELSE ${owner} END,
        ${at + day / 8} + i, 1, i % 2, 'person', 'task-' || i, ${at}, ${at}
      FROM series ORDER BY i`;
    const overflow = (viewer: KinPulse.Viewer) =>
      KinPulse.read({ orgId, at, viewer }).pipe(
        Effect.map((read) => read.facts.filter((fact) => fact.key.startsWith("sense_overflow:"))),
      );
    const ownerView = { _tag: "owner" } as const;
    const memberView = { _tag: "people", people: [teammate] } as const;
    const ownerFacts = yield* overflow(ownerView);
    const ordinary = (yield* moneySenses(yield* KinPulse.context(orgId, at))).filter(
      (fact) => fact.sense === "invoice_overdue",
    );
    assert.lengthOf(ordinary, 500);
    assert.equal(ordinary.at(-1)?.subject.key, "INV-500");
    assert.sameMembers(
      ownerFacts.map((fact) => fact.subject.title),
      ["30 more overdue invoices not listed", "10 more tasks due soon not listed"],
    );
    assert.isTrue(
      ownerFacts.every((fact) => fact.consequence === "Open the full list to see them."),
    );
    assert.isEmpty(screenFacts(ownerFacts, undefined));
    assert.lengthOf(screenFacts(ownerFacts, ["sense_overflow"]), 2);
    assert.deepEqual(
      (yield* overflow(memberView)).map((fact) => fact.subject.title),
      ["5 more tasks due soon not listed"],
    );

    const onlyMoney = Effect.map(overflow(ownerView), (facts) =>
      facts.filter((fact) => fact.family === "money"),
    );
    const stamp = { orgId, personId: owner, at, zone: "UTC" };
    yield* markTold({ ...stamp, eventId: "invented-notice", facts: yield* onlyMoney });
    yield* invoices(531, 539);
    assert.isEmpty(yield* untold({ ...stamp, anyState: true, facts: yield* onlyMoney }));
    yield* invoices(540, 540);
    const [changed] = yield* untold({ ...stamp, anyState: true, facts: yield* onlyMoney });
    assert.equal(changed?.subject.title, "40 more overdue invoices not listed");
    assert.equal(changed?.key, ownerFacts.find((fact) => fact.family === "money")?.key);

    yield* KinShell.set(orgId, owner, 0, [{ id: "invoices", on: false }]);
    assert.isEmpty(yield* onlyMoney);
  }).pipe(Effect.provide(fixture())),
);
