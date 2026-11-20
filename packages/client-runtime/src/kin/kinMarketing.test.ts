import { describe, expect, it } from "vite-plus/test";

import {
  kinCameFromLabel,
  kinCampaignResultRows,
  kinTagChoices,
  kinTagsWith,
  kinTagsWithout,
} from "./kinMarketing.ts";

describe("tags on a contact", () => {
  it("adds one once in any case, takes one off in any case, and offers the company's others", () => {
    expect(kinTagsWith(["Harbour"], " harbour ")).toEqual(["Harbour"]);
    expect(kinTagsWith(["Harbour"], " clinics ")).toEqual(["Harbour", "clinics"]);
    expect(kinTagsWith(["Harbour"], "  ")).toEqual(["Harbour"]);
    expect(
      kinTagsWith(
        Array.from({ length: 20 }, (_, at) => `t${at}`),
        "one more",
      ),
    ).toHaveLength(20);
    expect(kinTagsWithout(["Harbour", "clinics"], "HARBOUR")).toEqual(["clinics"]);
    expect(kinTagChoices(["harbour"], ["Harbour", "clinics", "Newsletter"], "")).toEqual([
      "clinics",
      "Newsletter",
    ]);
    expect(kinTagChoices([], ["Harbour", "clinics", "Newsletter"], "NEWS")).toEqual(["Newsletter"]);
  });
});

describe("a campaign's results", () => {
  it("count each currency on its own, never summed, and list its people only with an audience", () => {
    const results = {
      prospects: 14,
      clients: 2,
      open: {
        count: 5,
        values: [
          { minor: 6_100_000, currency: "EUR" as const },
          { minor: 500_000, currency: "USD" as const },
        ],
      },
      won: { count: 1, values: [{ minor: 900_000, currency: "EUR" as const }] },
      audience: 212,
    };
    const rows = kinCampaignResultRows(results, "harbour");
    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ["prospects", "14"],
      ["clients", "2"],
      ["deals", expect.stringMatching(/^5 · €61,000(\.00)? · \$5,000(\.00)?$/)],
      ["won", expect.stringMatching(/^1 · €9,000(\.00)?$/)],
      ["audience", "212 contacts"],
    ]);
    expect(kinCampaignResultRows(results, null).map((row) => row.id)).not.toContain("audience");
  });

  it("reads a campaign by its name, and one the reader can't see by the word alone", () => {
    const choices = [{ source: "campaign:P-3", label: "Harbour fair", campaign: true }];
    expect(kinCameFromLabel("campaign:P-3", choices)).toBe("Harbour fair");
    expect(kinCameFromLabel("campaign:P-9", choices)).toBe("Campaign");
    expect(kinCameFromLabel("Referral", choices)).toBe("Referral");
  });
});
