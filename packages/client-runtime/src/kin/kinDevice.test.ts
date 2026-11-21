import { describe, expect, it } from "@effect/vitest";

import {
  kinJoinSignedInAs,
  kinReplacedComputers,
  kinSignOutExits,
  type KinExitCandidate,
  type KinHeldComputer,
} from "./kinDevice.ts";

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

describe("kinSignOutExits", () => {
  it("gives each team one Sign out, and none to a row that is down and never named its team", () => {
    const row = (
      environmentId: string,
      overrides: Partial<KinExitCandidate> = {},
    ): KinExitCandidate => ({
      environmentId,
      label: "Studio desktop",
      team: "Ambermill",
      connected: true,
      ...overrides,
    });
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly rows: ReadonlyArray<KinExitCandidate>;
      readonly host: string | null;
      readonly exits: ReadonlyArray<string>;
    }> = [
      {
        name: "one team beside old pairings that never answered",
        rows: [
          row("old-1", { team: null, connected: false }),
          row("live"),
          row("old-2", { team: null, connected: false }),
        ],
        host: "live",
        exits: ["live"],
      },
      {
        name: "two teams",
        rows: [row("live"), row("other", { team: "Lumen Grove", label: "Lumen office" })],
        host: "live",
        exits: ["live", "other"],
      },
      {
        name: "another team off for now keeps its Sign out",
        rows: [row("live"), row("other", { team: "Lumen Grove", connected: false })],
        host: "live",
        exits: ["live", "other"],
      },
      {
        name: "the computer Kin opens on, before it names its team",
        rows: [row("live", { team: null })],
        host: "live",
        exits: ["live"],
      },
      {
        name: "no host yet: the connected copy of a team answers for it",
        rows: [row("down", { connected: false }), row("up")],
        host: null,
        exits: ["up"],
      },
    ];
    for (const one of cases) {
      expect(kinSignOutExits(one.rows, one.host), one.name).toEqual(one.exits);
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
