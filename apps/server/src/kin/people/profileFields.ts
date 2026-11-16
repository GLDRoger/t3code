import { type KinPeopleUpdateProfileInput, KinRoleTags, KinWorkHours } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodeRoleTags = Schema.encodeEffect(Schema.fromJsonString(KinRoleTags));
const encodeWorkHours = Schema.encodeEffect(Schema.fromJsonString(KinWorkHours));

export type ProfileFields = Pick<
  KinPeopleUpdateProfileInput,
  "displayName" | "roleTags" | "skills" | "timeZone" | "workHours"
>;

/** The `kin_people` assignments for the given profile fields, stamped `profile_updated_at`. */
export const profileSets = Effect.fn("KinPeople.profileSets")(function* (
  fields: ProfileFields,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const roleTags =
    fields.roleTags === undefined
      ? undefined
      : yield* encodeRoleTags([...new Set(fields.roleTags)]).pipe(Effect.orDie);
  const workHours =
    fields.workHours == null
      ? fields.workHours
      : yield* encodeWorkHours(fields.workHours).pipe(Effect.orDie);
  return [
    fields.displayName === undefined ? null : sql`display_name = ${fields.displayName}`,
    roleTags === undefined ? null : sql`role_tags_json = ${roleTags}`,
    fields.skills === undefined ? null : sql`skills = ${fields.skills.trim()}`,
    fields.timeZone === undefined ? null : sql`time_zone = ${fields.timeZone}`,
    workHours === undefined ? null : sql`work_hours_json = ${workHours}`,
    sql`profile_updated_at = ${now}`,
  ].filter((part) => part !== null);
});
