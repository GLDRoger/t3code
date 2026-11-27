import { describe, expect, it } from "@effect/vitest";

import { mailRuleHeaderFacts, matchMailRule } from "./ruleMatch.ts";

const rule = {
  connectionId: "company",
  from: [{ domain: " JUNIPER.Example " }],
  subjectHas: [" Invoice   42 ", "credit note"],
  withFile: true,
  classes: ["known_biller"],
} as const;
const header = {
  from: "Juniper <Billing@juniper.example>",
  fromAddress: " Billing@juniper.example ",
  subject: "Re: Invoice 42!",
  hasFile: true,
  authResults: ["mx.example; dmarc=pass"],
};
const arrival = { connectionId: "company", class: "known_biller" };

describe("mail rule matching", () => {
  it.each([
    ["case and whitespace", {}, {}, {}, "match"],
    [
      "NFKC, format controls and whitespace",
      {},
      { subject: "ＩＮＶＯＩＣＥ\u200b\t42" },
      {},
      "match",
    ],
    ["second phrase", {}, { subject: "A credit note." }, {}, "match"],
    ["near miss at end", {}, { subject: "invoiced 42" }, {}, "no_match"],
    ["near miss at start", {}, { subject: "xinvoice 42" }, {}, "no_match"],
    ["Unicode word edge", {}, { subject: "éinvoice 42" }, {}, "no_match"],
    ["literal punctuation", { subjectHas: ["INV.42"] }, { subject: "INVa42" }, {}, "no_match"],
    ["subdomain", {}, { from: "billing@mail.juniper.example", fromAddress: null }, {}, "match"],
    [
      "suffix look-alike",
      {},
      { from: "billing@juniper.example.evil", fromAddress: null },
      {},
      "no_match",
    ],
    [
      "Cyrillic look-alike",
      {},
      { from: "billing@junіper.example", fromAddress: null },
      {},
      "no_match",
    ],
    [
      "explicit IDN",
      { from: [{ domain: "bücher.example" }] },
      { from: "bill@xn--bcher-kva.example", fromAddress: null },
      {},
      "match",
    ],
    ["exact address", { from: [{ address: " billing@JUNIPER.example" }] }, {}, {}, "match"],
    ["address must be exact", { from: [{ address: "sales@juniper.example" }] }, {}, {}, "no_match"],
    [
      "display name",
      {},
      { from: '"billing@juniper.example" <fraud@else.example>', fromAddress: null },
      {},
      "no_match",
    ],
    [
      "display name with quoted comma",
      {},
      { from: '"Name, billing@juniper.example" <fraud@else.example>', fromAddress: null },
      {},
      "no_match",
    ],
    [
      "display name alone",
      {},
      { from: '"billing@juniper.example"', fromAddress: null },
      {},
      "no_match",
    ],
    [
      "structured sender",
      {},
      { from: "Juniper", fromAddress: "billing@juniper.example" },
      {},
      "match",
    ],
    ["missing file", {}, { hasFile: false }, {}, "no_match"],
    ["different mailbox", {}, {}, { connectionId: "own" }, "no_match"],
    ["different class", {}, {}, { class: "client" }, "no_match"],
    ["DMARC pass, named", {}, {}, {}, "match"],
    [
      "DMARC fail overrides both passes, named",
      {},
      { authResults: ["mx.example; dmarc=fail; dkim=pass; spf=pass"] },
      {},
      "held_unverified",
    ],
    ["no results, named", {}, { authResults: [] }, {}, "held_unverified"],
    ["only DKIM, named", {}, { authResults: ["mx.example; dkim=pass"] }, {}, "held_unverified"],
    [
      "DKIM and SPF pass, named",
      {},
      { authResults: ["mx.example; dkim=PASS; spf=pass"] },
      {},
      "match",
    ],
    ["DMARC pass, no From", { from: [] }, {}, {}, "match"],
    [
      "DMARC fail, no From",
      { from: [] },
      { authResults: ["mx.example; dmarc=fail"] },
      {},
      "held_unverified",
    ],
    [
      "SPF softfail, no From",
      { from: [] },
      { authResults: ["mx.example; spf=softfail"] },
      {},
      "held_unverified",
    ],
    ["no results, no From", { from: [] }, { authResults: [] }, {}, "match"],
    ["own", { classes: null }, {}, { class: "own" }, "no_match"],
    ["sign_in", { classes: null }, {}, { class: "sign_in" }, "no_match"],
    ["failed_checks", { classes: null }, {}, { class: "failed_checks" }, "no_match"],
  ] as const)("%s", (_label, filters, headers, row, result) => {
    const mail = { ...header, ...headers };
    expect(
      matchMailRule(
        { ...rule, ...filters },
        { ...arrival, ...row, ...mailRuleHeaderFacts(mail), subject: mail.subject },
      ),
    ).toBe(result);
  });
});
