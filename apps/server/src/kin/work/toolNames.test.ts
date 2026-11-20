import { assert, it as effectIt } from "@effect/vitest";
import { KinAgentId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { orgOwner, toolName, toolNamer, toolNameOfText } from "./toolNames.ts";

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

effectIt.effect("orgOwner is the owner KinAccess reads, unset access included", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE kin_people (org_id TEXT, person_id TEXT, access TEXT)`;
    yield* sql`CREATE TABLE kin_agents (org_id TEXT, agent_id TEXT, owner_person_id TEXT)`;
    yield* sql`CREATE TABLE kin_leads (org_id TEXT, agent_id TEXT)`;
    yield* sql`INSERT INTO kin_people VALUES ('o', 'p-zoya', NULL), ('o', 'p-rhea', NULL)`;
    yield* sql`INSERT INTO kin_agents VALUES ('o', 'a-lead', 'p-rhea')`;
    yield* sql`INSERT INTO kin_leads VALUES ('o', 'a-lead')`;
    assert.strictEqual(yield* orgOwner("o"), "p-rhea");
    // A stored owner comes before one read from an unset row.
    yield* sql`INSERT INTO kin_people VALUES ('o', 'p-arjun', 'owner')`;
    assert.strictEqual(yield* orgOwner("o"), "p-arjun");
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);
