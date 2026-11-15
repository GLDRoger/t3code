import type { KinAgentId, KinOrgId, KinPulseActor, KinPulseFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as KinPulse from "./KinPulse.ts";

export const PULSE_RULE =
  "What needs attention, as Kin computed it from its own records just now. Act on a fact when that moves something forward; otherwise leave it. Call pulse_handle once one is in hand or is not a problem.";
const SECTION_CAP = 30;

/**
 * The owner's open pulse facts for a prompt, grouped by project, the ones that woke this turn first.
 * `undefined` when nothing needs attention and nothing woke it.
 */
export const buildPulseSection = Effect.fn("KinLeadPrompt.pulse")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly now: number;
  readonly wokeFor: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const all = yield* KinPulse.read({
    orgId: input.orgId,
    at: input.now,
    viewer: { _tag: "owner" },
    limit: 200,
  });
  const woke = new Set(input.wokeFor);
  const open = new Set(all.facts.map((fact) => fact.key));
  const gone = input.wokeFor.filter((key) => !open.has(key));
  if (all.total === 0 && gone.length === 0) return undefined;
  const shown = all.facts
    .toSorted((a, b) => Number(woke.has(b.key)) - Number(woke.has(a.key)))
    .slice(0, SECTION_CAP);
  const names = new Map(
    (yield* sql<{ id: string; name: string }>`SELECT agent_id AS id, display_name AS name
      FROM kin_agents WHERE org_id = ${input.orgId}
      UNION ALL SELECT person_id AS id, display_name AS name
      FROM kin_people WHERE org_id = ${input.orgId}
      ORDER BY id`).map((row) => [row.id, row.name]),
  );
  const who = (actor: KinPulseActor) =>
    actor._tag === "owner"
      ? "the owner"
      : actor._tag === "agent"
        ? actor.agentId === input.agentId
          ? "you"
          : (names.get(actor.agentId) ?? "another agent")
        : (names.get(actor.personId) ?? "a teammate");
  const row = (fact: KinPulseFact) => ({
    key: fact.key,
    about: `${fact.subject.key === fact.subject.title ? fact.subject.title : `${fact.subject.key} ${fact.subject.title}`}`,
    consequence: fact.consequence,
    acts: who(fact.actor),
    ...(fact.sensitive ? { sensitive: true } : {}),
    ...(woke.has(fact.key) ? { wokeYou: true } : {}),
  });
  const groups = new Map<string, Array<ReturnType<typeof row>>>();
  for (const fact of shown) {
    const project =
      fact.scope.projectKey === undefined
        ? "No project"
        : `${fact.scope.projectTitle ?? ""} (${fact.scope.projectKey})`.trim();
    groups.set(project, [...(groups.get(project) ?? []), row(fact)]);
  }
  return {
    asOf: all.asOf,
    total: all.total,
    ...(all.total > shown.length ? { shown: shown.length, more: "pulse_read has the rest" } : {}),
    byProject: [...groups].map(([project, facts]) => ({ project, facts })),
    ...(gone.length === 0 ? {} : { wokeForButHandledOrNoLongerTrue: gone }),
  };
});
