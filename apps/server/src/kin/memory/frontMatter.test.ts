import { expect, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parseFrontMatter } from "./frontMatter.ts";

import { fixtureItem, readmeItem } from "./__fixtures__/items.ts";

it.effect.each([
  {
    name: "plain date",
    text: fixtureItem().replace('review_by: "2026-11-13"', "review_by: 2026-11-13"),
    valid: true,
  },
  {
    name: "offsetless datetime",
    text: fixtureItem({ recorded_at: "2026-11-01T00:00:00" }),
    valid: false,
  },
  ...["2026-11-01T00:00:00.5Z", "2026-11-01T00:00:00.123456Z"].map((recorded_at) => ({
    name: recorded_at,
    text: fixtureItem({ recorded_at }),
    valid: true,
  })),
  ...[
    "2026-11-01T00:00:00.Z",
    "2026-11-01T00:00:00.5",
    "2026-02-30",
    "2026-13-01",
    "2026-02-30T00:00Z",
    "2026-11-01T24:00Z",
  ].map((recorded_at) => ({
    name: recorded_at,
    text: fixtureItem({ recorded_at }),
    valid: false,
  })),
  { name: "invalid recorded date", text: fixtureItem({ recorded_at: "not-a-date" }), valid: false },
  { name: "README links comment", text: readmeItem, valid: false },
  {
    name: "timestamp tag",
    text: fixtureItem().replace('"2026-11-13"', "!!timestamp 2026-11-13"),
    valid: false,
  },
  {
    name: "binary tag",
    text: fixtureItem().replace('"Invented service maintenance"', "!!binary SGVsbG8="),
    valid: false,
  },
  { name: "missing delimiter", text: "no front matter", valid: false },
  { name: "malformed YAML", text: "---\nid: [\n---\nbody", valid: false },
  {
    name: "quoted links and unrelated malformed YAML",
    text: fixtureItem().replace("---\nInvented", "broken: [\n---\nInvented"),
    valid: false,
  },
  {
    name: "person settings",
    text: fixtureItem({ tz: "America/New_York", quiet_hours: { from: "22:00", to: "07:00" } }),
    valid: true,
  },
  { name: "invalid schema", text: fixtureItem({ trust: "administrator" }), valid: false },
  {
    name: "duplicate key",
    text: fixtureItem().replace("---\nInvented", "id: other\n---\nInvented"),
    valid: false,
  },
])("parses $name", ({ text, valid }) =>
  Effect.gen(function* () {
    const result = yield* parseFrontMatter(
      KinOrgId.make("org-demo"),
      "deferrals/def-001.md",
      text,
    ).pipe(Effect.result);
    expect(result._tag === "Success").toBe(valid);
    if (result._tag === "Success") {
      expect(result.success.frontMatter.review_by).toBe("2026-11-13");
      if (text.includes("quiet_hours:")) {
        expect(result.success.frontMatter.tz).toBe("America/New_York");
        expect(result.success.frontMatter.quiet_hours).toEqual({ from: "22:00", to: "07:00" });
      }
      expect(result.success.body).toBe("Invented fixture body.\n");
    } else {
      expect(result.failure._tag).toBe("MemoryItemError");
      if (text === readmeItem)
        expect(result.failure.reason).toContain("links containing # must be quoted");
      else expect(result.failure.reason).not.toContain("links containing # must be quoted");
    }
  }),
);
