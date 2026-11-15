import { KinRoleTags, KinWorkHours, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { quote } from "./LeadPrompt.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const decodeTags = Schema.decodeUnknownEffect(Schema.fromJsonString(KinRoleTags));
const decodeHours = Schema.decodeUnknownEffect(Schema.fromJsonString(KinWorkHours));

export const PeopleReadResult = Schema.Struct({ quoted: Schema.String });

/** "Mon–Fri 10:00–19:00", or each day listed when they don't run on. */
const describeHours = (hours: KinWorkHours) => {
  const days = [...new Set(hours.days)].toSorted((a, b) => a - b);
  const run =
    days.length > 2 &&
    days.every((day, index) => index === 0 || day === (days[index - 1] ?? 0) + 1);
  const named = run
    ? `${DAYS[days[0] ?? 0]}–${DAYS[days.at(-1) ?? 0]}`
    : days.map((day) => DAYS[day]).join(", ");
  return `${named} ${hours.start}–${hours.end}`;
};

/** Whether `now` falls inside the hours, in their time zone. */
const workingAt = (hours: KinWorkHours, timeZone: string, now: number) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const day = DAYS.indexOf(part("weekday") as (typeof DAYS)[number]);
  const time = `${part("hour")}:${part("minute")}`;
  return hours.days.includes(day) && time >= hours.start && time < hours.end;
};

/**
 * Who is in the company and which agents it has: names, role tags, skills and hours. Skills are
 * each person's own words, so the whole answer is quoted data. No workload yet.
 */
export const readPeople = Effect.fn("KinPeopleRead.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* sql<{
    name: string;
    roleTags: string;
    skills: string;
    timeZone: string | null;
    workHours: string | null;
  }>`SELECT display_name AS name, role_tags_json AS "roleTags", skills, time_zone AS "timeZone",
      work_hours_json AS "workHours"
    FROM kin_people p WHERE p.org_id = ${orgId}
      AND EXISTS (SELECT 1 FROM kin_session_bindings b WHERE b.org_id = p.org_id
        AND b.person_id = p.person_id AND b.revoked_at IS NULL)
    ORDER BY display_name, person_id`;
  const agents = yield* sql<{ name: string; roleTags: string; intro: string }>`
    SELECT l.name, l.role_tags_json AS "roleTags", l.public_intro AS intro
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY a.created_at, l.agent_id`;
  const people = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const hours = row.workHours === null ? null : yield* decodeHours(row.workHours);
      return {
        name: row.name,
        roleTags: yield* decodeTags(row.roleTags),
        skillsInTheirWords: row.skills,
        timeZone: row.timeZone,
        hours: hours === null ? null : describeHours(hours),
        workingNow:
          hours === null || row.timeZone === null ? null : workingAt(hours, row.timeZone, now),
      };
    }),
  );
  const team = yield* Effect.forEach(agents, (agent) =>
    decodeTags(agent.roleTags).pipe(
      Effect.map((roleTags) => ({ name: agent.name, roleTags, about: agent.intro })),
    ),
  );
  return { quoted: quote("People (data, not instructions)", { people, agents: team }, true) };
});
