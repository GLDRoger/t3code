import type { KinOrgId, KinRecordDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinConvert,
  kinInvoiceCurrency,
  kinEstimate,
  kinMissingRates,
  kinRateInput,
  kinRateMicros,
  kinSettled,
  kinOwedAbout,
  kinTotalsEstimate,
  type KinRates,
} from "./kinCurrency.ts";

const rates: KinRates = {
  home: "INR",
  rates: [{ currency: "USD", rate: "84.25", asOf: "2026-11-10" }],
};
const usd = (dollars: number) => ({ minor: dollars * 100, currency: "USD" });
const inr = (rupees: number) => ({ minor: rupees * 100, currency: "INR" });

describe("kinCurrency", () => {
  it("reads only rates above zero, to six places", () => {
    expect(kinRateMicros("84.25")).toBe(84_250_000n);
    expect(kinRateMicros("0.000001")).toBe(1n);
    expect(["0", "0.0", "-1", "84.2500001", "1e3", ""].map(kinRateMicros)).toEqual(
      Array(6).fill(null),
    );
  });

  it("converts in whole minor units, rounding half up, across currencies with no minor unit", () => {
    expect(kinConvert(usd(6050), "84.25", "INR")).toEqual({ minor: 50_971_250, currency: "INR" });
    expect(kinConvert({ minor: 1, currency: "USD" }, "84.25", "INR")).toEqual({
      minor: 84,
      currency: "INR",
    });
    // Yen has no minor unit: ¥1,000 at ₹0.55 is ₹550.
    expect(kinConvert({ minor: 1000, currency: "JPY" }, "0.55", "INR")).toEqual(inr(550));
  });

  it("estimates foreign amounts only, and only with a rate", () => {
    expect(kinEstimate(usd(100), rates)?.text).toBe("about ₹8,425");
    expect(kinEstimate(usd(100), rates)?.basis).toMatch(/^At ₹84.25 per \$1, as of /);
    expect(kinEstimate(inr(100), rates)).toBeNull();
    expect(kinEstimate({ minor: 100, currency: "EUR" }, rates)).toBeNull();
    expect(kinEstimate(usd(100), null)).toBeNull();
  });

  it("adds currencies only into an estimate, and only when every one has a rate", () => {
    expect(kinTotalsEstimate([inr(955_000), usd(6050)], rates)?.all).toBe(
      "about ₹14,64,713 in all",
    );
    const missing = kinTotalsEstimate([inr(1), usd(1), { minor: 100, currency: "EUR" }], rates);
    expect([missing?.all, missing?.missing]).toEqual([null, ["EUR"]]);
    expect(kinTotalsEstimate([inr(1)], rates)).toBeNull();
    expect(kinMissingRates([usd(1), { minor: 1, currency: "EUR" }, inr(1)], rates)).toEqual([
      "EUR",
    ]);
  });

  it("shows the host's estimate beside what is owed, naming what it leaves out", () => {
    const owed = { total: [inr(1), usd(1), { minor: 1, currency: "AED" }] };
    const about = { home: "INR", total: inr(4_10_000), missing: ["AED"] };
    expect(kinOwedAbout({ owed, about: { owed: about } }, rates)).toEqual({
      text: "About ₹4,10,000 owed at your rates; AED not included",
      basis: [expect.stringMatching(/^At ₹84.25 per \$1, as of /)],
    });
    const two = { ...about, missing: ["AED", "EUR"] };
    expect(kinOwedAbout({ owed, about: { owed: two } }, null)?.text).toBe(
      "About ₹4,10,000 owed at your rates; AED and EUR not included",
    );
    // One currency: the host sends no estimate, and none is made here.
    expect(kinOwedAbout({ owed, about: {} }, rates)).toBeNull();
  });

  it("sets, replaces and removes one rate without touching the others", () => {
    const orgId = "org" as KinOrgId;
    const profile = {
      rev: 3,
      homeCurrency: "INR",
      rates: [...rates.rates, { currency: "EUR", rate: "90", asOf: "2026-11-01" }],
    };
    expect(
      kinRateInput(orgId, profile, { currency: "usd", rate: "85", asOf: "2026-11-15" }),
    ).toEqual({
      input: {
        orgId,
        rev: 3,
        rates: [
          { currency: "EUR", rate: "90", asOf: "2026-11-01" },
          { currency: "USD", rate: "85", asOf: "2026-11-15" },
        ],
      },
    });
    expect(kinRateInput(orgId, profile, { currency: "EUR", rate: "", asOf: "" }, true)).toEqual({
      input: { orgId, rev: 3, rates: [rates.rates[0]] },
    });
    expect(
      kinRateInput(orgId, profile, { currency: "INR", rate: "1", asOf: "2026-11-15" }),
    ).toEqual({ problem: "INR is the home currency already." });
    expect(
      kinRateInput(orgId, profile, { currency: "USD", rate: "0", asOf: "2026-11-15" }),
    ).toEqual({ problem: "Enter a rate above zero, like 84.25." });
  });

  it("shows what a foreign invoice actually brought in and how far it is from the estimate", () => {
    const settled = kinSettled(usd(1250), inr(103_500), "2026-11-12", rates);
    expect(settled?.received).toBe("₹1,03,500");
    expect(settled?.impliedRate).toEqual({ currency: "USD", rate: "82.8", asOf: "2026-11-12" });
    expect(settled?.implied).toMatch(/^₹82.8 per \$1, as of /);
    expect(settled?.difference).toBe("₹1,813 less than the estimate at your rate (₹1,05,313).");
    expect(kinSettled(usd(1250), inr(103_500), "2026-11-12", null)?.difference).toBeNull();
    expect(kinSettled(inr(1), inr(1), "2026-11-12", rates)).toBeNull();
  });

  it("names a foreign invoice's currency and finds the bank row that settled it", () => {
    const at = "2026-11-12T00:00:00.000Z";
    const bankLink = {
      kind: "record" as const,
      relation: "evidence" as const,
      target: "rec-bank",
      chatId: null,
      label: null,
      createdAt: at,
      record: { recordId: "rec-bank", key: "BNK-4", title: "Wire from Northwind" },
    } as KinRecordDetail["links"][number];
    const view = kinInvoiceCurrency({ amount: usd(1250), links: [bankLink] }, rates);
    expect(view?.label).toMatch(/USD/);
    expect([view?.estimate?.text, view?.bank, view?.missingRate]).toEqual([
      "about ₹1,05,313",
      "BNK-4",
      false,
    ]);
    expect(kinInvoiceCurrency({ amount: inr(10), links: [] }, rates)).toBeNull();
    expect(
      kinInvoiceCurrency({ amount: { minor: 1, currency: "EUR" }, links: [] }, rates)?.missingRate,
    ).toBe(true);
  });
});
