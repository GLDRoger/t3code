import { assert, it } from "@effect/vitest";
import { KinOrgId, KinRecordId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import {
  countryFirstMessage,
  newCompanyProfileJson,
  readProfile,
  setProfile,
} from "./companyProfile.ts";
import { goalFields, goalLine, goalsNow } from "./goals.ts";

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const orgId = KinOrgId.make("org");
const revenue = { measure: "revenue_received", target: "40000" };

// An owner whose home currency is USD set a revenue goal of "40000" and got ₹40,000.
it.effect("reads a goal's amount in the company's home currency, INR when none is set", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual((yield* goalFields(orgId, revenue)).target, {
      minor: 4_000_000,
      currency: "INR",
    });
    const sql = yield* SqlClient.SqlClient;
    const { rev: _rev, updatedAt: _at, ...data } = yield* readProfile(orgId);
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-11')`;
    yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
        updated_by_kind, updated_by_id)
      VALUES (${orgId}, ${JSON.stringify({ ...data, homeCurrency: "USD" })}, 1, 0, 'person', 'owner')`;
    assert.deepStrictEqual((yield* goalFields(orgId, revenue)).target, {
      minor: 4_000_000,
      currency: "USD",
    });
    // A company created now reads no amount until its country is chosen; a count goal is fine.
    yield* sql`UPDATE kin_company_profile SET profile_json = ${yield* newCompanyProfileJson}`;
    assert.strictEqual(
      (yield* Effect.flip(goalFields(orgId, revenue))).message,
      countryFirstMessage("the owner"),
    );
    assert.deepStrictEqual(yield* goalFields(orgId, { measure: "tasks_done", target: "12" }), {
      measure: "tasks_done",
      target: "12",
    });
    yield* setProfile(orgId, { _tag: "person", personId: "owner" }, { country: "GB" }, undefined);
    assert.deepStrictEqual((yield* goalFields(orgId, revenue)).target, {
      minor: 4_000_000,
      currency: "GBP",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps other currencies out of a revenue goal's progress", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = Date.parse("2026-11-20T12:00:00Z");
    const { rev: _rev, updatedAt: _at, ...data } = yield* readProfile(orgId);
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', '2026-11-11')`;
    // The owner typed a EUR rate: the "about" figure never reads it.
    const profile = {
      ...data,
      homeCurrency: "USD",
      rates: [{ currency: "EUR", rate: "1.5", asOf: "2026-11-15" }],
    };
    yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
        updated_by_kind, updated_by_id)
      VALUES (${orgId}, ${JSON.stringify(profile)}, 1, 0, 'person', 'owner')`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'goals', 'Goals', 'G', 1, 0),
             (${orgId}, 'invoices', 'Invoices', 'INV', 1, 0)`;
    const fields = {
      ...(yield* goalFields(orgId, { ...revenue, target: "USD 40000" })),
      startsOn: "2026-11-01",
    };
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, origin_key, created_by_kind, created_at, updated_at, fields_json)
      VALUES (${orgId}, 'goal', 'goals', 'G-1', 'Tidewater Freight revenue', 'person', 'owner',
              'goal', 'person', 0, 0, ${JSON.stringify(fields)}),
             (${orgId}, 'invoice', 'invoices', 'INV-1', 'Tidewater Freight', 'person', 'owner',
              'invoice', 'person', 0, 0, '{}'),
             (${orgId}, 'invoice-eur', 'invoices', 'INV-2', 'Tidewater Freight EU', 'person',
              'owner', 'invoice-eur', 'person', 0, 0, '{}')`;
    yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
        currency, paid_on, origin_key, created_at, created_by_kind)
      VALUES (${orgId}, 'payment-usd', 'invoice', 10_000, 'USD', '2026-11-12', 'usd', 0, 'person'),
             (${orgId}, 'payment-eur', 'invoice', 76_800, 'EUR', '2026-11-12', 'eur', 0, 'person')`;
    const goalNow = Effect.map(goalsNow(orgId, at, { money: true }), ({ goals }) => goals[0]);
    const goal = yield* goalNow;
    assert.isDefined(goal);
    assert.strictEqual(goal?.current, 10_000);
    assert.deepStrictEqual(goal?.notCounted, [
      { currency: "EUR", received: { minor: 76_800, currency: "EUR" } },
    ]);
    assert.notProperty(goal, "about");
    // EUR invoices settled in USD, before the goal starts: one over 90 days ago, one taken back.
    const settled = (id: string, day: string, rate: string, voidedAt: number | null) =>
      sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor, currency,
          paid_on, origin_key, created_at, created_by_kind, received_minor, received_currency,
          rate, voided_at)
        VALUES (${orgId}, ${id}, 'invoice-eur', 50_000, 'EUR', ${day}, ${id}, 0, 'person',
          ${Math.round(50_000 * Number(rate))}, 'USD', ${rate}, ${voidedAt})`;
    yield* settled("settled-old", "2026-08-01", "1.200000", null);
    yield* settled("settled-void", "2026-10-28", "1.300000", 1);
    assert.notProperty(yield* goalNow, "about");
    yield* settled("settled-earlier", "2026-10-20", "1.080000", null);
    yield* settled("settled", "2026-10-25", "1.100000", null);
    const about = yield* goalNow;
    // $100 + €768 at 1.10 = $944.80, about $945, at the newest settled rate's day.
    assert.deepStrictEqual(about?.about, {
      total: { minor: 94_500, currency: "USD" },
      rateDays: ["2026-10-25"],
    });
    assert.deepStrictEqual(about?.notCounted, goal?.notCounted);
    assert.include(
      about === undefined ? "" : goalLine(about),
      ", about $945 in all (approximate, at rates the company was paid at on 2026-10-25)",
    );
  }).pipe(Effect.provide(layer)),
);

it("says which receipts a goal leaves out and marks a recorded-rate total approximate", () => {
  const goal = {
    recordId: KinRecordId.make("goal"),
    key: "G-1",
    title: "Tidewater Freight revenue",
    rev: 1,
    state: "open",
    measure: "revenue_received",
    currency: "USD",
    current: 10_000,
    target: 40_000,
    expected: 10_000,
    startsOn: "2026-11-01",
    dueOn: null,
    behind: false,
  } as const;
  const original = "G-1 Tidewater Freight revenue: $100 of $400";
  assert.strictEqual(goalLine(goal), original);
  const crossCurrency = {
    ...goal,
    notCounted: [
      { currency: "EUR", received: { minor: 76_800, currency: "EUR" } },
      { currency: "GBP", received: { minor: 12_000, currency: "GBP" } },
    ],
    about: { total: { minor: 110_000, currency: "USD" }, rateDays: ["2026-11-03", "2026-11-12"] },
  };
  assert.strictEqual(
    goalLine(crossCurrency),
    original +
      ", plus €768.00 and £120.00 received in other currencies that this goal doesn't count" +
      ", about $1,100 in all (approximate, at rates the company was paid at on 2026-11-03 and 2026-11-12)",
  );
});
