import {
  type KinPeopleUpdateProfileInput,
  KinPersonQuietHours,
  KinRoleTags,
  KinWorkHours,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { wholeDay } from "../triggers/quietHours.ts";

const encodeRoleTags = Schema.encodeEffect(Schema.fromJsonString(KinRoleTags));
const encodeWorkHours = Schema.encodeEffect(Schema.fromJsonString(KinWorkHours));
const encodeQuietHours = Schema.encodeEffect(Schema.fromJsonString(KinPersonQuietHours));

export type ProfileFields = Pick<
  KinPeopleUpdateProfileInput,
  | "displayName"
  | "roleTags"
  | "skills"
  | "timeZone"
  | "workHours"
  | "talkStyle"
  | "quietHours"
  | "holdOutsideHours"
  | "answersRing"
  | "awayUntil"
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
    fields.workHours === undefined
      ? undefined
      : fields.workHours === null || wholeDay(fields.workHours)
        ? null
        : yield* encodeWorkHours(fields.workHours).pipe(Effect.orDie);
  const quietHours =
    fields.quietHours == null
      ? fields.quietHours
      : yield* encodeQuietHours(fields.quietHours).pipe(Effect.orDie);
  return [
    fields.displayName === undefined ? null : sql`display_name = ${fields.displayName}`,
    roleTags === undefined ? null : sql`role_tags_json = ${roleTags}`,
    fields.skills === undefined ? null : sql`skills = ${fields.skills.trim()}`,
    fields.timeZone === undefined ? null : sql`time_zone = ${fields.timeZone}`,
    workHours === undefined ? null : sql`work_hours_json = ${workHours}`,
    fields.talkStyle === undefined ? null : sql`talk_style = ${fields.talkStyle.trim()}`,
    quietHours === undefined ? null : sql`quiet_hours_json = ${quietHours}`,
    fields.holdOutsideHours === undefined
      ? null
      : sql`hold_outside_hours = ${fields.holdOutsideHours ? 1 : 0}`,
    fields.answersRing === undefined ? null : sql`answers_ring = ${fields.answersRing ? 1 : 0}`,
    fields.awayUntil === undefined ? null : sql`away_until = ${fields.awayUntil}`,
    sql`profile_updated_at = ${now}`,
  ].filter((part) => part !== null);
});
