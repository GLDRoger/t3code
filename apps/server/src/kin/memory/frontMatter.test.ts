import { expect, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { parseFrontMatter } from "./frontMatter.ts";

import { fixtureItem } from "./__fixtures__/items.ts";

it.effect.each([
  {
    name: "plain date",
    text: fixtureItem().replace('review_by: "2026-11-13"', "review_by: 2026-11-13"),
    valid: true,
  },
  { name: "missing delimiter", text: "no front matter", valid: false },
  { name: "malformed YAML", text: "---\nid: [\n---\nbody", valid: false },
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
      expect(result.success.body).toBe("Invented fixture body.\n");
    } else expect(result.failure._tag).toBe("MemoryItemError");
  }),
);
