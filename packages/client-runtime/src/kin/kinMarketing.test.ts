import type { KinOrgId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinCameFromLabel,
  kinCampaignResultRows,
  kinCampaignResultsSummary,
  kinTagAdd,
  kinTagChoices,
  kinTagsFull,
  kinTagsWithout,
  type KinCampaignResultId,
} from "./kinMarketing.ts";
import { kinCampaignResultOpens } from "./kinWorkClients.ts";

describe("tags on a contact", () => {
  it("adds one once in any case, takes one off in any case, and offers the company's others", () => {
    expect(kinTagAdd(["Harbour"], " harbour ")).toEqual({ tags: ["Harbour"], typed: "" });
    expect(kinTagAdd(["Harbour"], " clinics ")).toEqual({
      tags: ["Harbour", "clinics"],
      typed: "",
    });
    expect(kinTagAdd(["Harbour"], "  ")).toEqual({ tags: ["Harbour"], typed: "  " });
    expect(kinTagsWithout(["Harbour", "clinics"], "HARBOUR")).toEqual(["clinics"]);
    expect(kinTagChoices(["harbour"], ["Harbour", "clinics", "Newsletter"], "")).toEqual([
      "clinics",
      "Newsletter",
    ]);
    expect(kinTagChoices([], ["Harbour", "clinics", "Newsletter"], "NEWS")).toEqual(["Newsletter"]);
  });
});

describe("the twenty-first tag", () => {
  it("is kept in the field and the limit said under it, until it fits or is gone", () => {
    const twenty = Array.from({ length: 20 }, (_, at) => `t${at}`);
    expect(kinTagAdd(twenty, "one more")).toEqual({ tags: twenty, typed: "one more" });
    expect(kinTagsFull(twenty, "one more")).toBe("A contact takes at most 20 tags.");
    // One already on it, or nothing typed, is no twenty-first.
    expect(kinTagsFull(twenty, "T3")).toBeNull();
    expect(kinTagsFull(twenty, " ")).toBeNull();
    expect(kinTagsFull(twenty.slice(1), "one more")).toBeNull();
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
    const rows = kinCampaignResultRows(results, "harbour", true);
    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ["prospects", "14"],
      ["clients", "2"],
      ["deals", expect.stringMatching(/^5 · €61,000(\.00)? · \$5,000(\.00)?$/)],
      ["won", expect.stringMatching(/^1 · €9,000(\.00)?$/)],
      ["audience", "212 contacts"],
    ]);
    expect(kinCampaignResultRows(results, null, true).map((row) => row.id)).not.toContain(
      "audience",
    );
    // A company that doesn't run deals counts none.
    expect(kinCampaignResultRows(results, null, false).map((row) => row.id)).toEqual([
      "prospects",
      "clients",
    ]);
  });

  it("reads folded as its counts, zeros left out, or nothing yet", () => {
    const none = { minor: 0, currency: "EUR" as const };
    const results = (
      prospects: number,
      clients: number,
      open: number,
      won: number,
      people = 0,
    ) => ({
      prospects,
      clients,
      open: { count: open, values: open === 0 ? [] : [none] },
      won: { count: won, values: won === 0 ? [] : [none] },
      audience: people,
    });
    expect(kinCampaignResultsSummary(results(0, 1, 2, 1), "harbour", true)).toBe(
      "1 client · 2 deals · 1 won",
    );
    expect(kinCampaignResultsSummary(results(0, 1, 2, 1), "harbour", false)).toBe("1 client");
    expect(kinCampaignResultsSummary(results(3, 0, 1, 0, 1), "harbour", true)).toBe(
      "3 prospects · 1 deal · 1 contact",
    );
    expect(kinCampaignResultsSummary(results(0, 0, 0, 0), null, true)).toBe("nothing yet");
    // People on its list count only with an audience to list them by.
    expect(kinCampaignResultsSummary(results(0, 0, 0, 0, 4), null, true)).toBe("nothing yet");
  });

  it("opens what each count counts: its parties by kind, its open or won deals, its people", () => {
    const orgId = "org" as KinOrgId;
    const opens = (id: KinCampaignResultId) => kinCampaignResultOpens(orgId, "P-4", "Fair", id);
    expect(opens("deals")).toEqual({
      to: "deals",
      title: "Deals from them: Fair",
      input: { orgId, campaign: "P-4", state: "open" },
    });
    expect(opens("won")).toEqual({
      to: "deals",
      title: "Won: Fair",
      input: { orgId, campaign: "P-4", state: "won" },
    });
    expect(opens("prospects")).toMatchObject({
      to: "clients",
      title: "Came from: Fair",
      filter: { show: "prospects", cameFrom: "campaign:P-4" },
    });
    expect(opens("clients")).toMatchObject({ to: "clients", filter: { show: "clients" } });
    expect(opens("audience")).toEqual({
      to: "contacts",
      title: "Fair",
      input: { orgId, campaign: "P-4" },
    });
  });

  it("reads a campaign by its name, and one the reader can't see by the word alone", () => {
    const choices = [{ source: "campaign:P-3", label: "Harbour fair", campaign: true }];
    expect(kinCameFromLabel("campaign:P-3", choices)).toBe("Harbour fair");
    expect(kinCameFromLabel("campaign:P-9", choices)).toBe("Campaign");
    expect(kinCameFromLabel("Referral", choices)).toBe("Referral");
  });
});
