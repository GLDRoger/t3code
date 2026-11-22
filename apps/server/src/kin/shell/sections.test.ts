import { assert, it } from "@effect/vitest";
import { KIN_PROMISE_SENSES, KinPulseSense } from "@t3tools/contracts";

import { SHARED_TOOLS } from "../lead/SharedTools.ts";
import { DEAL_SENSES } from "../pulse/senses/deals.ts";
import { LISTS } from "../work/lists.ts";
import {
  sectionOfKey,
  sectionOfList,
  sectionOfSense,
  sectionOfTool,
  SECTIONS,
} from "./sections.ts";

it("classifies every shared tool, built-in list and pulse sense, including explicit nulls", () => {
  assert.sameMembers(Object.keys(SECTIONS.tools), Object.keys(SHARED_TOOLS));
  assert.sameMembers(Object.keys(SECTIONS.lists), Object.keys(LISTS));
  assert.sameMembers(Object.keys(SECTIONS.senses), [...KinPulseSense.literals]);
  assert.sameMembers(
    Object.keys(SECTIONS.keys),
    Object.values(LISTS).map(({ prefix }) => prefix),
  );
  assert.deepStrictEqual(
    Object.keys(SHARED_TOOLS)
      .filter((tool) => sectionOfTool(tool) === "deals")
      .sort(),
    ["deal_stages", "pipeline_read"],
  );
  assert.equal(sectionOfList("deals"), "deals");
  assert.equal(sectionOfKey(" dl-3 "), "deals");
  assert.sameMembers(
    KinPulseSense.literals.filter((sense) => sectionOfSense(sense) === "deals"),
    [...DEAL_SENSES],
  );
  // A contract's notice day is about a project, which needs no deal; a promise's deal is a DL key.
  for (const sense of KIN_PROMISE_SENSES) assert.isNull(sectionOfSense(sense));
});
