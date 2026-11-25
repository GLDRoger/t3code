import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
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
import { goalFields } from "./goals.ts";

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
