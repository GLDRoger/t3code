import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KinMailRuleCreateInput, KinMailRuleMatch, KinMailRuleRunNow } from "./kinMailRules.ts";

const valid = Schema.is(KinMailRuleCreateInput);
const isMatch = Schema.is(KinMailRuleMatch);

const filters = { from: [], subjectHas: ["invoice"], withFile: true, classes: ["known_biller"] };

describe("mail rule tap", () => {
  it("rejects out-of-range limits and instructions, ambiguous senders and long phrase lists", () => {
    const input = {
      orgId: "org",
      connectionId: "mail",
      agentId: "finance",
      chatId: "rhea-finance",
      tapId: "tap",
      what: "File the bill.",
      match: filters,
    };
    expect(valid(input)).toBe(true);
    expect(valid({ ...input, monthlyCap: 0 })).toBe(false);
    expect(valid({ ...input, monthlyCap: 1001 })).toBe(false);
    expect(valid({ ...input, what: "x".repeat(2001) })).toBe(false);
    expect(
      isMatch({
        ...filters,
        from: [{ address: "bill@juniper.example", domain: "juniper.example" }],
      }),
    ).toBe(false);
    expect(isMatch({ ...filters, subjectHas: Array(6).fill("invoice") })).toBe(false);
  });
});

it("accepts queued mail rule runs with an event and keeps the earlier results readable", () => {
  const accepts = Schema.is(KinMailRuleRunNow);
  expect(accepts({ status: "queued", arrivalId: "arr_acf1102", eventId: "pulse-cb9831" })).toBe(
    true,
  );
  expect(accepts({ status: "queued", arrivalId: "arr_acf1102" })).toBe(false);
  expect(
    accepts({ status: "no_match", message: "No mail in the last 30 days matches this rule." }),
  ).toBe(true);
  expect(
    accepts({
      status: "not_yet",
      arrivalId: "arr_acf1102",
      message: "Kin can't run mail rules yet. Nothing ran.",
    }),
  ).toBe(true);
});
