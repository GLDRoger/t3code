import { KinAgentId, KinPersonId, kinWhenFormat } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_REACH_COPY,
  kinAgentReach,
  kinPersonReach,
  kinReachPairKey,
  kinReachProblem,
  kinReachRows,
  type KinReachInput,
} from "./kinReach.ts";

const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const dev = KinPersonId.make("dev");
const zoya = KinPersonId.make("zoya");
const arjun = KinPersonId.make("arjun");
const finance = KinAgentId.make("finance");
const chief = KinAgentId.make("chief");
const person = (personId: KinPersonId) => ({ kind: "person", personId }) as const;
const agent = (agentId: KinAgentId) => ({ kind: "agent", agentId }) as const;

const ambermill = (limits: KinReachInput["reach"]["limits"]): KinReachInput => ({
  // Rhea owns the company and Meera is a co-owner: neither can be restricted.
  reach: { limits, restrictable: [dev, zoya, arjun] },
  people: [
    { personId: rhea, displayName: "Rhea Kapoor" },
    { personId: meera, displayName: "Meera Iyer" },
    { personId: dev, displayName: "Dev Malhotra" },
    { personId: zoya, displayName: "Zoya Sheikh" },
    { personId: arjun, displayName: "Arjun Rao" },
  ],
  agents: [
    { agentId: chief, name: "Chief of staff" },
    { agentId: finance, name: "Finance" },
  ],
});
const setAt = "2026-11-20T08:00:00.000Z";
// "20 Nov" in the reader's own locale and zone.
const day = kinWhenFormat("date").format(Date.parse(setAt));

describe("who can message whom", () => {
  it("lists an agent's people, offers only those who can be restricted, and moves one to Restricted", () => {
    const open = kinAgentReach(ambermill([]), finance);
    expect(open.canMessage.map((one) => one.name)).toEqual([
      "Arjun Rao",
      "Dev Malhotra",
      "Zoya Sheikh",
    ]);
    expect(open.restricted).toEqual([]);

    const input = ambermill([{ one: agent(finance), other: person(dev), setBy: rhea, setAt }]);
    const shut = kinAgentReach(input, finance);
    expect(shut.canMessage.map((one) => one.name)).toEqual(["Arjun Rao", "Zoya Sheikh"]);
    expect(shut.restricted).toEqual([{ personId: dev, name: "Dev Malhotra", party: person(dev) }]);
    // Another agent's restriction is not this one's.
    expect(kinAgentReach(input, chief).restricted).toEqual([]);
  });

  it("reads a person's agents and the people they can't message, and offers the rest", () => {
    const input = ambermill([
      { one: agent(chief), other: person(dev), setBy: rhea, setAt },
      { one: person(dev), other: person(zoya), setBy: meera, setAt },
    ]);
    const devs = kinPersonReach(input, dev)!;
    expect(devs.agents.map(({ name, restricted }) => [name, restricted])).toEqual([
      ["Chief of staff", true],
      ["Finance", false],
    ]);
    expect(devs.cantMessage.map((one) => one.name)).toEqual(["Zoya Sheikh"]);
    expect(devs.offered.map((one) => one.name)).toEqual(["Arjun Rao"]);
    // The pair holds both ways.
    expect(kinPersonReach(input, zoya)!.cantMessage.map((one) => one.name)).toEqual([
      "Dev Malhotra",
    ]);
    // An owner or a co-owner can't be restricted: their page offers nothing.
    expect(kinPersonReach(input, meera)).toBeNull();
    expect(kinPersonReach(input, rhea)).toBeNull();
  });

  it("lists every restriction in the company with who set it and when, a person first", () => {
    const rows = kinReachRows(
      ambermill([
        { one: agent(finance), other: person(dev), setBy: rhea, setAt },
        { one: person(arjun), other: person(zoya), setBy: meera, setAt },
      ]),
    );
    expect(rows.map(({ names, detail }) => [names, detail])).toEqual([
      [["Dev Malhotra", "Finance"], `Restricted by Rhea Kapoor on ${day}`],
      [["Arjun Rao", "Zoya Sheikh"], `Restricted by Meera Iyer on ${day}`],
    ]);
    expect(rows[0]!.a).toEqual(person(dev));
    expect(rows[0]!.key).toBe(kinReachPairKey(agent(finance), person(dev)));
  });

  it("says in the confirm that it holds both ways and leaves the chat to read", () => {
    expect(KIN_REACH_COPY.confirmTitle("Dev Malhotra", "Finance")).toBe(
      "Restrict Dev Malhotra and Finance?",
    );
    expect(KIN_REACH_COPY.confirmAgent("Dev Malhotra", "Finance")).toBe(
      "Neither can message the other until you lift this. Dev Malhotra keeps their chat with Finance to read.",
    );
    expect(KIN_REACH_COPY.confirmPeople("Dev Malhotra", "Zoya Sheikh")).toBe(
      "Neither can message the other until you lift this. Dev Malhotra and Zoya Sheikh keep their chat to read.",
    );
  });

  it.each([
    ["not_owner", "Only the owner or a co-owner can restrict who messages whom."],
    ["conflict", "Owners and co-owners can always message everyone."],
    ["not_found", "That person or agent is no longer here."],
  ])("explains a %s refusal", (reason, text) => {
    expect(kinReachProblem({ reason })).toBe(text);
  });
});
