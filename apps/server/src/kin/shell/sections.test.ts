import { assert, it } from "@effect/vitest";
import { KIN_PROMISE_SENSES, KinPulseSense } from "@t3tools/contracts";

import { SHARED_TOOLS } from "../lead/SharedTools.ts";
import { DEAL_SENSES } from "../pulse/senses/deals.ts";
import { PRESETS } from "../work/registers.ts";
import { LISTS } from "../work/lists.ts";
import {
  sectionOfKey,
  sectionOfList,
  sectionOfSense,
  sectionOfTool,
  SECTIONS,
} from "./sections.ts";

it("classifies every shared tool, built-in list and pulse sense, including explicit nulls", () => {
  assert.sameMembers(Object.keys(SECTIONS.tools), Object.keys(SHARED_TOOLS));
  assert.sameMembers(Object.keys(SECTIONS.lists), [
    ...Object.keys(LISTS),
    ...Object.keys(PRESETS),
    "bank_transactions",
    "subscriptions",
  ]);
  assert.sameMembers(Object.keys(SECTIONS.senses), [...KinPulseSense.literals]);
  assert.sameMembers(
    Object.keys(SECTIONS.keys),
    [...Object.values(LISTS), ...Object.values(PRESETS)]
      .map(({ prefix }) => prefix)
      .concat(["BNK", "BTX", "BANK", "BKTX", "BK9"]),
  );
  assert.deepStrictEqual(
    Object.keys(SHARED_TOOLS)
      .filter((tool) => sectionOfTool(tool) === "deals")
      .sort(),
    ["deal_stages", "pipeline_read"],
  );
  assert.equal(sectionOfList("deals"), "deals");
  assert.equal(sectionOfKey(" dl-3 "), "deals");
  assert.sameMembers(
    KinPulseSense.literals.filter((sense) => sectionOfSense(sense) === "deals"),
    [...DEAL_SENSES],
  );
  // A contract's notice day is about a project, which needs no deal; a promise's deal is a DL key.
  for (const sense of KIN_PROMISE_SENSES) assert.isNull(sectionOfSense(sense));
});

it("classifies client and project, money, and invoice and quote surfaces", () => {
  for (const [name, expected] of [
    ["project_note", "clients"],
    ["client_read", "clients"],
    ["touch_log", "clients"],
    ["money_summary", "money"],
    ["money_query", "money"],
    ["kin_receipt", "money"],
    ["payment_record", "invoices"],
    ["record_get", null],
    ["dates_query", null],
  ] as const)
    assert.equal(sectionOfTool(name), expected, name);
  for (const [list, key, expected] of [
    ["clients", "C-3", "clients"],
    ["contacts", "CT-3", "clients"],
    ["projects", "P-3", "clients"],
    ["milestones", "M-3", "clients"],
    ["invoices", "INV-3", "invoices"],
    ["quotes", "QT-3", "invoices"],
    ["expenses", "EXP-3", "money"],
    ["receipts", "RCT-3", "money"],
    ["dates", "DT-3", "money"],
    ["bank_transactions", "BNK-3", "money"],
  ] as const) {
    assert.equal(sectionOfList(list), expected, list);
    assert.equal(sectionOfKey(key), expected, key);
  }
  for (const [sense, expected] of [
    ["client_cold", "clients"],
    ["project_quiet", "clients"],
    ["invoice_overdue", "invoices"],
    ["quote_unanswered", "invoices"],
    ["statement_missing", "money"],
    ["bank_alerts_unreadable", "money"],
    ["budget_near", "money"],
    ["task_late", null],
  ] as const)
    assert.equal(sectionOfSense(sense), expected, sense);
});
