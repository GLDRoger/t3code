import { KinChatError, type KinWorkPrincipal } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { messageable } from "../lead/messageable.ts";
import { accessSql } from "../people/KinAccess.ts";
import { personNamed } from "../people/personNamed.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { connectionOf } from "../work/codingAgent.ts";
import { connectionViewer } from "../work/ownerWork.ts";
import { workFailure } from "../work/recordRows.ts";
import { shownName } from "../work/toolNames.ts";
import type { TasksKeyHolder } from "./TasksKeys.ts";

/** `list_people`, `create_task` and the like name people and agents by the names this gives. */
const YOU = /^(me|myself|you|you \(the user\))$/i;

const personOf = (holder: TasksKeyHolder): PersonIdentity => ({
  _tag: "person",
  orgId: holder.orgId,
  personId: holder.personId,
});

/**
 * Everyone in the company and the agents the person may message, as their own screens name them:
 * a member reads who the owner is and everyone else as a teammate, as their Team list does.
 */
export const listPeople = Effect.fn("KinTasksKey.people")(function* (holder: TasksKeyHolder) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const viewer = yield* connectionViewer([personOf(holder)], connectionOf(holder), holder.orgId);
    const rows = yield* sql<{ id: string; name: string; access: string }>`SELECT
        p.person_id AS id, p.display_name AS name, ${sql.literal(accessSql("p"))} AS access
      FROM kin_people p WHERE p.org_id = ${holder.orgId} AND p.removed_at IS NULL
      ORDER BY p.display_name, p.person_id`;
    const agents = yield* messageable(viewer.person);
    const role = (row: (typeof rows)[number]) =>
      row.id === holder.personId
        ? "you"
        : row.access === "owner"
          ? "owner"
          : row.access === "co_owner" && !viewer.teammate
            ? "co-owner"
            : "teammate";
    return {
      people: [
        ...rows.map((row) => ({ name: row.name, kind: "person" as const, role: role(row) })),
        ...agents.map((agent) => ({
          name: agent.name,
          kind: "agent" as const,
          role: agent.intro.trim() === "" ? "agent" : agent.intro.trim(),
        })),
      ],
    };
  }).pipe(sql.withTransaction, workFailure);
});

/**
 * The person or agent a name from `list_people` means, for this key's person: "me" is them, an
 * agent only one they may message, a person anyone in the company. A miss says what to do.
 */
export const whoNamed = Effect.fn("KinTasksKey.whoNamed")(function* (
  holder: TasksKeyHolder,
  typed: string,
) {
  if (YOU.test(typed.trim()))
    return { _tag: "person", personId: holder.personId } satisfies KinWorkPrincipal;
  const shown = shownName(typed);
  const agentName = (shown?.mark === "agent" ? shown.name : typed).trim().toLowerCase();
  const agents = yield* messageable(personOf(holder)).pipe(workFailure);
  const agent = agents.find((one) => one.name.trim().toLowerCase() === agentName);
  if (agent !== undefined)
    return { _tag: "agent", agentId: agent.agentId } satisfies KinWorkPrincipal;
  const short = typed.trim().slice(0, 60);
  if (shown?.mark === "agent")
    return yield* new KinChatError({
      reason: "not_found",
      message: `No agent called ${short} that you may message. list_people names who is.`,
    });
  const person = yield* personNamed(holder.orgId, typed).pipe(workFailure);
  if (person._tag === "found")
    return { _tag: "person", personId: person.item.id } satisfies KinWorkPrincipal;
  return yield* new KinChatError({
    reason: person._tag === "ambiguous" ? "invalid_state" : "not_found",
    message:
      person._tag === "ambiguous"
        ? `${person.items.length} people answer to ${short}: ${person.items
            .slice(0, 6)
            .map((one) => one.name)
            .join(", ")}. Ask which one is meant and pass that name.`
        : `No one called ${short} is in the company.${
            person.nearest.length === 0
              ? ""
              : ` Nearest: ${person.nearest.map((one) => one.name).join(", ")}.`
          } list_people names who is.`,
  });
});
