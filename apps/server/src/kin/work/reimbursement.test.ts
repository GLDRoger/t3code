import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { FieldValues } from "./lists.ts";
import { checkFields, type ListDef, presetDefinition } from "./registers.ts";
import {
  fundingKeyRefusal,
  fundingOf,
  owedToPartner,
  partnerFunded,
  repaidDay,
} from "./reimbursement.ts";

const partner = "person:meera";
const cases: ReadonlyArray<[string, FieldValues, ReturnType<typeof fundingOf>]> = [
  ["nothing said", {}, { by: "company" }],
  ["an agent named", { fundedBy: "agent:finance" }, { by: "company" }],
  ["a person id in capitals", { fundedBy: "PERSON:meera" }, { by: "company" }],
  ["not reimbursable alone", { reimbursement: "not reimbursable" }, { by: "company" }],
  [
    "a partner, nothing marked",
    { fundedBy: partner },
    { by: "partner", personId: "meera", unmatched: null, state: "owed", repaidOn: null },
  ],
  [
    "a partner, repaid",
    { fundedBy: partner, reimbursement: "repaid", repaidOn: "2026-10-02T10:00" },
    { by: "partner", personId: "meera", unmatched: null, state: "repaid", repaidOn: "2026-10-02" },
  ],
  [
    "a partner who gave it",
    { fundedBy: partner, reimbursement: "not reimbursable", repaidOn: "2026-10-02" },
    {
      by: "partner",
      personId: "meera",
      unmatched: null,
      state: "not reimbursable",
      repaidOn: null,
    },
  ],
  [
    "an import's unmatched partner",
    { reimbursement: "owed", paidPersonallyBy: " partner@ambermill.example " },
    {
      by: "partner",
      personId: null,
      unmatched: "partner@ambermill.example",
      state: "owed",
      repaidOn: null,
    },
  ],
  [
    "an address without a mark",
    { paidPersonallyBy: "partner@ambermill.example" },
    { by: "company" },
  ],
];

describe("partner reimbursements", () => {
  it("reads who funded an expense", () => {
    for (const [name, fields, funding] of cases)
      assert.deepStrictEqual(fundingOf(fields), funding, name);
  });

  it.effect("says the same in SQL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE r (n INTEGER, fields_json TEXT)`;
      for (const [n, [, fields]] of cases.entries())
        yield* sql`INSERT INTO r VALUES (${n}, ${JSON.stringify(fields)})`;
      const rows = yield* sql<{ n: number; partner: number; owed: number; day: string | null }>`
        SELECT n, ${partnerFunded(sql)} AS partner, ${owedToPartner(sql)} AS owed,
          CASE WHEN json_extract(r.fields_json, '$.reimbursement') = 'repaid'
            THEN ${repaidDay(sql)} END AS day
        FROM r ORDER BY n`;
      for (const row of rows) {
        const [name, , funding] = cases[row.n]!;
        // Never NULL: a company's expense is a plain no, so NOT of it is a yes.
        assert.strictEqual(row.partner, funding.by === "partner" ? 1 : 0, name);
        assert.strictEqual(
          row.owed === 1,
          funding.by === "partner" && funding.state === "owed",
          name,
        );
        assert.strictEqual(row.day, funding.by === "partner" ? funding.repaidOn : null, name);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it("takes only a person as who funded an expense", () => {
    const def: ListDef = {
      ...presetDefinition("expenses", "INR", "IN"),
      id: "expenses",
      builtIn: null,
      archivedAt: null,
      rev: 1,
    };
    assert.isUndefined(checkFields(def, { fundedBy: partner, reimbursement: "owed" }));
    assert.match(checkFields(def, { fundedBy: "agent:finance" })!.message, /not an agent/);
    assert.match(checkFields(def, { reimbursement: "maybe" })!.message, /one of owed, repaid/);
    // Kin's keys are Kin's: Expenses takes no field of another kind under them.
    assert.isUndefined(fundingKeyRefusal(def.fields));
    assert.strictEqual(
      fundingKeyRefusal([
        ...def.fields.filter((one) => one.key !== "reimbursement"),
        { key: "reimbursement", label: "Claim note", type: "text" },
      ]),
      "Expenses keeps reimbursement for who funded an expense; name Claim note differently.",
    );
  });
});
