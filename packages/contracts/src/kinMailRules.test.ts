import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KinMailRuleCreateInput, KinMailRuleMatch } from "./kinMailRules.ts";

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
