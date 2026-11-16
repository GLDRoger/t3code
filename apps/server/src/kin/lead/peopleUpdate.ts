import { KinChatError, KinPeopleUpdateProfileInput, KinPersonId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import { personMiss, personNamed } from "../people/personNamed.ts";
import { profileSets } from "../people/profileFields.ts";
import { turnAsker } from "./Audience.ts";
import type { resolveLead } from "./LeadMemory.ts";

const { displayName, roleTags, skills, timeZone, workHours, talkStyle } =
  KinPeopleUpdateProfileInput.fields;
export const PeopleUpdateInput = Schema.Struct({
  person: Schema.optional(Schema.String).annotate({
    description:
      'Whose profile: "me" (the default) for the person who asked, "owner", or a name exactly as people_read lists it.',
  }),
  displayName,
  roleTags,
  skills,
  timeZone,
  workHours,
  talkStyle,
});
export type PeopleUpdateInput = typeof PeopleUpdateInput.Type;
export const PeopleUpdateResult = Schema.Struct({ saved: Schema.String });

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });

/**
 * Saves a profile for the one person who asked, with their own rights: anyone their own, the
 * owner anyone's, a co-owner a member's. A change no single person asked for is never saved.
 */
export const updatePeople = Effect.fn("KinPeopleUpdate.update")(function* (
  lead: Effect.Success<ReturnType<typeof resolveLead>>,
  input: PeopleUpdateInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const asker = yield* turnAsker(lead);
  if (asker === null)
    return yield* refused(
      "Kin can't tell which one person asked for this, so nothing was saved. Ask them to say it in a message.",
    );
  const [owner] = yield* sql<{ personId: string }>`SELECT owner_person_id AS "personId"
    FROM kin_agents WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`;
  const ownerId = owner === undefined ? null : KinPersonId.make(owner.personId);
  const named = (input.person ?? "me").trim();
  const lower = named.toLowerCase();
  const target =
    lower === "me" || lower === ""
      ? { personId: asker }
      : lower === "owner" && ownerId !== null
        ? { personId: ownerId }
        : yield* personNamed(lead.orgId, named).pipe(
            Effect.flatMap((found) =>
              found._tag === "found"
                ? Effect.succeed({ personId: found.item.id })
                : Effect.fail(
                    new KinChatError({
                      reason: found._tag === "none" ? "not_found" : "invalid_state",
                      message: `${personMiss(named, found)} Nothing was saved.`,
                    }),
                  ),
            ),
          );
  if (target.personId !== asker && input.talkStyle !== undefined)
    return yield* refused("Only they can say how they like to be spoken to.");
  if (target.personId !== asker) {
    const level = (person: KinPersonId) => ownerLevel(lead.orgId, person);
    if (!(yield* level(asker))) return yield* refused("A teammate changes only their own profile.");
    if (target.personId === ownerId && asker !== ownerId)
      return yield* refused("Only the owner changes the owner's profile.");
    if (asker !== ownerId && (yield* level(target.personId)))
      return yield* refused("Only the owner changes a co-owner's profile.");
  }
  const now = (yield* DateTime.now).epochMilliseconds;
  const set = yield* profileSets(input, now);
  if (set.length === 1) return yield* refused("Say what to change: nothing was given to save.");
  yield* sql`UPDATE kin_people SET ${sql.csv(set)}
    WHERE org_id = ${lead.orgId} AND person_id = ${target.personId}`;
  yield* (yield* KinRefreshObserver).touch(lead.orgId, "people");
  const [saved] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${lead.orgId} AND person_id = ${target.personId}`;
  const changed = [
    input.displayName === undefined ? null : "name",
    input.roleTags === undefined ? null : "roles",
    input.skills === undefined ? null : "skills",
    input.timeZone === undefined ? null : "time zone",
    input.workHours === undefined ? null : "working hours",
    input.talkStyle === undefined ? null : "how they like to be spoken to",
  ].filter((part) => part !== null);
  return { saved: `Saved ${saved?.name ?? "their"}'s ${changed.join(", ")}.` };
});
