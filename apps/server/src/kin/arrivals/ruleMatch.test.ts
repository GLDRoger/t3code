import { describe, expect, it } from "@effect/vitest";

import { mailRuleFilter, mailRuleHeaderFacts, matchMailRule } from "./ruleMatch.ts";

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
  authResults: ["mx.example; dmarc=pass header.from=juniper.example"],
};
const passed = (domain: string) => [`mx.example; dmarc=pass header.from=${domain}`];
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
    [
      "subdomain",
      {},
      {
        from: "billing@mail.juniper.example",
        fromAddress: null,
        authResults: passed("mail.juniper.example"),
      },
      {},
      "match",
    ],
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
      {
        from: "bill@xn--bcher-kva.example",
        fromAddress: null,
        authResults: passed("xn--bcher-kva.example"),
      },
      {},
      "match",
    ],
    ["exact address", { from: [{ address: " billing@JUNIPER.example" }] }, {}, {}, "match"],
    ["address must be exact", { from: [{ address: "sales@juniper.example" }] }, {}, {}, "no_match"],
    [
      "plus tag on a named address",
      { from: [{ address: "billing@juniper.example" }] },
      { from: "billing+x@juniper.example", fromAddress: null },
      {},
      "no_match",
    ],
    [
      "quoted local part",
      { from: [{ address: "billing@juniper.example" }] },
      { from: 'Juniper <"billing"@juniper.example>', fromAddress: null },
      {},
      "no_match",
    ],
    [
      "subdomain of a named address",
      { from: [{ address: "billing@juniper.example" }] },
      {
        from: "billing@mail.juniper.example",
        fromAddress: null,
        authResults: passed("mail.juniper.example"),
      },
      {},
      "no_match",
    ],
    [
      "trailing dots and mixed case",
      { from: [{ domain: "JUNIPER.Example." }] },
      { from: "Billing@Juniper.EXAMPLE.", fromAddress: null },
      {},
      "match",
    ],
    [
      "two From addresses",
      {},
      {
        from: "billing@juniper.example, fraud@else.example",
        fromAddress: "billing@juniper.example",
      },
      {},
      "no_match",
    ],
    [
      "From as a group",
      {},
      { from: "Juniper: billing@juniper.example;", fromAddress: "billing@juniper.example" },
      {},
      "no_match",
    ],
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
      {
        authResults: [
          "mx.example; dkim=PASS header.d=juniper.example; spf=pass smtp.mailfrom=bounce@mail.juniper.example",
        ],
      },
      {},
      "match",
    ],
    [
      "DKIM and SPF pass for the sender's own domain, named",
      {},
      {
        authResults: [
          "mx.example; dkim=pass header.d=else.example; spf=pass smtp.mailfrom=bounce@else.example",
        ],
      },
      {},
      "held_unverified",
    ],
    [
      "DMARC pass for another domain, named",
      {},
      { authResults: passed("else.example") },
      {},
      "held_unverified",
    ],
    [
      "a pass spelt in the bounce address, named",
      {},
      {
        authResults: [
          "mx.example; spf=pass (mx.example: domain of dmarc=pass+header.from=juniper.example@else.example designates 192.0.2.9 as permitted sender) smtp.mailfrom=dmarc=pass+header.from=juniper.example@else.example; dmarc=fail (p=NONE) header.from=juniper.example",
        ],
      },
      {},
      "held_unverified",
    ],
    [
      "a pass inside a quoted value, named",
      {},
      {
        authResults: [
          'mx.example; spf=pass smtp.mailfrom="x;dmarc=pass header.from=juniper.example"@else.example; dmarc=fail header.from=juniper.example',
        ],
      },
      {},
      "held_unverified",
    ],
    [
      "a pass only in a lower header the sender wrote, named",
      {},
      {
        authResults: [
          "mx.example; spf=pass smtp.mailfrom=else.example",
          ...passed("juniper.example"),
        ],
      },
      {},
      "held_unverified",
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
    [
      "bidi marks and a soft hyphen in a subject",
      {},
      { subject: "\u200fInv\u00adoice\u200e 42" },
      {},
      "match",
    ],
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

// The rows `tldts` must keep green when it replaces the vendored suffix list.
describe("a sender domain filter that is a public suffix", () => {
  it.each([
    ["co.uk", "public_suffix"],
    ["CO.UK.", "public_suffix"],
    ["uk", "public_suffix"],
    ["example", "public_suffix"],
    ["junipercold.example", "junipercold.example"],
    ["junipercold.co.uk", "junipercold.co.uk"],
    ["github.io", "public_suffix"],
    ["tidewater.github.io", "tidewater.github.io"],
    ["a.ck", "public_suffix"],
    ["www.ck", "www.ck"],
    ["x.kobe.jp", "public_suffix"],
    ["city.kobe.jp", "city.kobe.jp"],
    ["x.c.ts.net", "public_suffix"],
    ["c.ts.net", "c.ts.net"],
    ["公司.cn", "public_suffix"],
    ["xn--55qx5d.cn", "public_suffix"],
  ] as const)("%s", (domain, result) => {
    const filter = mailRuleFilter({ domain });
    expect(filter.problem ?? filter.spelling).toBe(result);
  });

  it("never refuses an address for its domain", () => {
    expect(mailRuleFilter({ address: "orders@co.uk" })).toEqual({ spelling: "orders@co.uk" });
  });
});
