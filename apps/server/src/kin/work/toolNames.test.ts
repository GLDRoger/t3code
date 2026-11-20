import { KinAgentId, KinPersonId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toolName, toolNamer, toolNameOfText } from "./toolNames.ts";

const names = {
  people: new Map([
    ["p-rhea", "Rhea"],
    ["p-zoya", "Zoya"],
  ]),
  agents: new Map([
    ["a-lead", "Ops lead"],
    ["a-fin", "Finance"],
  ]),
  owner: "p-rhea",
};
const person = (id: string) => ({ _tag: "person" as const, personId: KinPersonId.make(id) });
const agent = (id: string) => ({ _tag: "agent" as const, agentId: KinAgentId.make(id) });
const lead = { _tag: "lead" as const, agentId: "a-lead" };
const zoyasAgent = { _tag: "person" as const, personId: "p-zoya" };

describe("toolName", () => {
  it.each([
    ["the lead itself", agent("a-lead"), lead, "Ops lead (you)"],
    ["another agent, to a lead", agent("a-fin"), lead, "Finance (a-fin)"],
    ["the owner, to a lead", person("p-rhea"), lead, "Rhea (owner)"],
    ["a teammate, to a lead", person("p-zoya"), lead, "Zoya"],
    ["the user, to their own agent", person("p-zoya"), zoyasAgent, "you (the user)"],
    ["the owner, to a person's agent", person("p-rhea"), zoyasAgent, "Rhea (owner)"],
    ["an agent, to a person's agent", agent("a-fin"), zoyasAgent, "Finance (agent)"],
    ["an unlisted person", person("p-gone"), lead, "a teammate"],
    ["an unlisted agent, to a person's agent", agent("a-gone"), zoyasAgent, "an agent"],
  ])("names %s", (_, who, reader, expected) => {
    expect(toolName(who, names, reader)).toBe(expected);
  });

  it("names stored principals and leaves other text alone", () => {
    expect(toolNameOfText("agent:a-fin", toolNamer(names, zoyasAgent))).toBe("Finance (agent)");
    expect(toolNameOfText("person:p-rhea", toolNamer(names, lead))).toBe("Rhea (owner)");
    expect(toolNameOfText("next week", toolNamer(names, lead))).toBe("next week");
  });
});
