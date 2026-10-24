import { assert, it } from "@effect/vitest";

import { roman } from "./roman.ts";
import {
  houseForLaneLabel,
  importLineagesTsv,
  parseHousesTsv,
  parseLineagesTsv,
} from "./housesTsv.ts";

it("maps the first matching lane pattern and keeps file order", () => {
  const catalog = parseHousesTsv(`
# comment
pattern	house	agent_map
^web-	web-ui	.kin/web.md
apps/web/	web-ui
^server-	server	.kin/server.md
`);
  assert.deepEqual(
    catalog.rules.map((rule) => rule.houseName),
    ["web-ui", "web-ui", "server"],
  );
  assert.equal(houseForLaneLabel(catalog.rules, "web-codex")?.houseName, "web-ui");
  assert.equal(houseForLaneLabel(catalog.rules, "server-lane")?.houseName, "server");
  assert.equal(
    catalog.houses.find((house) => house.name === "web-ui")?.agentMapPath,
    ".kin/web.md",
  );
  assert.deepEqual(
    catalog.houses.map((house) => house.name),
    ["server", "web-ui"],
  );
});

it("imports the old lineages.tsv shape", () => {
  const imported = importLineagesTsv("lane\tlineage\n^api-\tapi\n");
  const catalog = parseLineagesTsv("regex\tline\n^api-\tapi\n");
  assert.equal(catalog.houses[0]?.name, "api");
  assert.equal(parseHousesTsv(imported).houses[0]?.name, "api");
  assert.throws(() => parseHousesTsv("only-one-column"));
});

it("prints regnal numbers in roman", () => {
  assert.equal(roman(4), "IV");
  assert.equal(roman(9), "IX");
});
