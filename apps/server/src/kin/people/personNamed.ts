import { KinPersonId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { matchName, type NameMatch } from "../work/nameMatch.ts";
import { shownName } from "../work/toolNames.ts";

export type NamedPerson = {
  readonly id: KinPersonId;
  readonly name: string;
  readonly tags: string;
};

/**
 * The person an agent means by what it typed, as clients are found: their id, handle, exact
 * name, a unique start of their name ("Zoya" for Zoya Sheikh) or a unique close spelling, also
 * as a tool shows it ("Zoya Sheikh (owner)").
 * Otherwise the several it could be, or the nearest names to offer back.
 */
export const personNamed = Effect.fn("KinPeople.personNamed")(function* (
  orgId: KinOrgId,
  typed: string,
) {
  const sql = yield* SqlClient.SqlClient;
  // Someone removed from the company is no one here until a link lets them back in.
  const rows = yield* sql<{ id: string; name: string; handle: string | null; tags: string }>`
    SELECT person_id AS id, display_name AS name, handle, role_tags_json AS tags
    FROM kin_people WHERE org_id = ${orgId} AND removed_at IS NULL ORDER BY person_id`;
  const people = rows.map((row) => ({ ...row, id: KinPersonId.make(row.id) }));
  // A name copied from a tool, "Rhea (owner)", is Rhea, unless someone is called that exactly.
  const shown = shownName(typed);
  const exactName = people.some((one) => one.name.trim() === typed.trim());
  // "Finance (a-1)" or "Finance (agent)" is an agent as a tool shows it, never a person.
  if (shown !== null && !exactName) {
    const agents = yield* sql<{ id: string }>`SELECT agent_id AS id FROM kin_agents
      WHERE org_id = ${orgId} AND retired_at IS NULL AND agent_id = ${shown.mark} LIMIT 1`;
    if (shown.mark === "agent" || agents.length > 0)
      return { _tag: "none", nearest: [] as ReadonlyArray<NamedPerson> } as const;
  }
  const wanted = shown === null || exactName ? typed.trim() : shown.name;
  const handle = wanted.replace(/^@/, "").toLowerCase();
  const exact = people.filter(
    (one) => one.id === wanted || (one.handle !== null && one.handle.toLowerCase() === handle),
  );
  const match: NameMatch<NamedPerson> =
    exact.length === 1 ? { _tag: "found", item: exact[0]! } : matchName(wanted, people);
  return match._tag === "found"
    ? ({ _tag: "found", item: pick(match.item) } as const)
    : match._tag === "ambiguous"
      ? ({ _tag: "ambiguous", items: match.items.map(pick) } as const)
      : ({ _tag: "none", nearest: match.nearest.map(pick) } as const);
});

const pick = (one: NamedPerson): NamedPerson => ({ id: one.id, name: one.name, tags: one.tags });

/** A miss in words for an agent: who it could be, or the nearest names to ask about. */
export const personMiss = (
  typed: string,
  match: Exclude<Effect.Success<ReturnType<typeof personNamed>>, { readonly _tag: "found" }>,
) => {
  const shown = typed.trim().slice(0, 60);
  if (match._tag === "ambiguous")
    return `${match.items.length} people answer to ${shown}: ${match.items
      .slice(0, 6)
      .map((one) => {
        const tags = tagsOf(one.tags);
        return `${one.name} (${tags.length === 0 ? "no roles" : tags.join(", ")}) is ${one.id}`;
      })
      .join("; ")}. Ask which one is meant, then pass their personId.`;
  return `No one called ${shown} is in the company.${
    match.nearest.length === 0
      ? ""
      : ` Nearest: ${match.nearest
          .map((one) => `${one.name} (${one.id})`)
          .join(", ")}; ask "did you mean …?" if one may be them.`
  } people_read lists who is.`;
};

const tagsOf = (json: string): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((tag) => typeof tag === "string") : [];
  } catch {
    return [];
  }
};
