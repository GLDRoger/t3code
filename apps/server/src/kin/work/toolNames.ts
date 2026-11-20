import type { KinOrgId, KinWorkPrincipal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { principalOfText } from "./projectSpine.ts";

/**
 * Who reads a tool's words: a lead, which takes agent ids back as input, or one person's own
 * coding agent, which takes only task keys.
 */
export type ToolReader =
  | { readonly _tag: "lead"; readonly agentId: string }
  | { readonly _tag: "person"; readonly personId: string };

export interface ToolNames {
  readonly people: ReadonlyMap<string, string>;
  readonly agents: ReadonlyMap<string, string>;
  /** The person "owner" means to this reader. */
  readonly owner: string | null;
}

/**
 * The one way tool output names who holds or changed something. People by display name, the
 * owner marked "(owner)"; agents by name with their id where the reader can pass ids back, else
 * "(agent)". The reader itself is "Name (you)" to a lead and "you (the user)" to a person's agent.
 */
export const toolName = (who: KinWorkPrincipal, names: ToolNames, reader: ToolReader): string => {
  if (who._tag === "agent") {
    const name = names.agents.get(who.agentId);
    if (reader._tag === "person") return name === undefined ? "an agent" : `${name} (agent)`;
    return `${name ?? "an agent"} (${who.agentId === reader.agentId ? "you" : who.agentId})`;
  }
  if (reader._tag === "person" && who.personId === reader.personId) return "you (the user)";
  const name = names.people.get(who.personId) ?? "a teammate";
  return who.personId === names.owner ? `${name} (owner)` : name;
};

/** `toolName` for one reader; nobody named stays undefined, so a field can be left out. */
export type ToolNamer = <W extends KinWorkPrincipal | null>(
  who: W,
) => W extends null ? undefined : string;
export const toolNamer =
  (names: ToolNames, reader: ToolReader): ToolNamer =>
  <W extends KinWorkPrincipal | null>(who: W) =>
    (who === null ? undefined : toolName(who, names, reader)) as W extends null
      ? undefined
      : string;

/** A stored `person:<id>` or `agent:<id>` by `toolName`; any other text as it is. */
export const toolNameOfText = (text: string, name: ToolNamer) => {
  const who = principalOfText(text);
  return who === null ? text : name(who);
};

/** The org's owner, whom "(owner)" marks to anyone but a lead. */
export const orgOwner = Effect.fn("KinToolNames.orgOwner")(function* (orgId: KinOrgId | string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ id: string }>`SELECT person_id AS id FROM kin_people
    WHERE org_id = ${orgId} AND access = 'owner'`;
  return row?.id ?? null;
});

/** Every person's and agent's name in an org, with whoever "owner" means to this reader. */
export const toolNamesOf = Effect.fn("KinToolNames.load")(function* (
  orgId: KinOrgId | string,
  owner: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* sql<{ id: string; name: string }>`SELECT agent_id AS id,
      display_name AS name FROM kin_agents WHERE org_id = ${orgId} ORDER BY agent_id`;
  const people = yield* sql<{ id: string; name: string }>`SELECT person_id AS id,
      display_name AS name FROM kin_people WHERE org_id = ${orgId} ORDER BY person_id`;
  return {
    agents: new Map(agents.map((row) => [row.id, row.name])),
    people: new Map(people.map((row) => [row.id, row.name])),
    owner,
  } satisfies ToolNames;
});

/** How a lead reads names: "owner" is the lead's own owner, as `resolveWho` reads it. */
export const leadNamer = Effect.fn("KinToolNames.leadNamer")(function* (
  orgId: KinOrgId | string,
  agentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  const names = yield* toolNamesOf(orgId, row?.owner ?? null);
  return toolNamer(names, { _tag: "lead", agentId });
});
