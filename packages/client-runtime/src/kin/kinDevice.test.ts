import { describe, expect, it } from "@effect/vitest";

import { kinJoinSignedInAs, kinReplacedComputers, type KinHeldComputer } from "./kinDevice.ts";

const rhea = { orgId: "org-ambermill", personId: "person-rhea" };
const held = (
  environmentId: string,
  overrides: Partial<KinHeldComputer> = {},
): KinHeldComputer => ({
  environmentId,
  label: "Rhea's laptop",
  identity: rhea,
  answering: false,
  ...overrides,
});

describe("kinReplacedComputers", () => {
  it("forgets an old pairing only while a newer one of the same Kin answers", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly held: ReadonlyArray<KinHeldComputer>;
      readonly replaced: ReadonlyArray<string>;
    }> = [
      {
        name: "two old copies beside the one answering",
        held: [held("old-1"), held("live", { answering: true }), held("old-2")],
        replaced: ["old-1", "old-2"],
      },
      { name: "the only computer, off for now", held: [held("only")], replaced: [] },
      {
        name: "two copies, neither answering",
        held: [held("a"), held("b")],
        replaced: [],
      },
      {
        name: "both answering",
        held: [held("a", { answering: true }), held("b", { answering: true })],
        replaced: [],
      },
      {
        name: "another computer of the same company",
        held: [held("old", { label: "Office desktop" }), held("live", { answering: true })],
        replaced: [],
      },
      {
        name: "another company on a computer of the same name",
        held: [
          held("old", { identity: { orgId: "org-other", personId: "person-rhea" } }),
          held("live", { answering: true }),
        ],
        replaced: [],
      },
      {
        name: "someone else signed in on the same Kin",
        held: [
          held("old", { identity: { orgId: "org-ambermill", personId: "person-arjun" } }),
          held("live", { answering: true }),
        ],
        replaced: [],
      },
      {
        name: "an old one that never said who it is",
        held: [held("old", { identity: null }), held("live", { answering: true })],
        replaced: [],
      },
    ];
    for (const one of cases) {
      expect(kinReplacedComputers(one.held), one.name).toEqual(one.replaced);
    }
  });
});

describe("kinJoinSignedInAs", () => {
  it("names who the phone is in as there, and no one when the host never said", () => {
    expect(kinJoinSignedInAs([{ displayName: " Arjun Rao " }])).toBe("Arjun Rao");
    expect(kinJoinSignedInAs([{}])).toBeNull();
    expect(kinJoinSignedInAs([{ displayName: "  " }])).toBeNull();
    expect(kinJoinSignedInAs([])).toBeNull();
    expect(kinJoinSignedInAs(null)).toBeNull();
  });
});
