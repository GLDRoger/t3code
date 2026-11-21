import { type KinAgentId, KinRoleTags, KinWorkHours, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { validZone } from "../triggers/quietHold.ts";
import { stillAway, storedWorkHours, workingAt } from "../triggers/quietHours.ts";
import { ownerZone } from "../work/recordRows.ts";
import { playbookThreshold } from "../work/playbooks.ts";
import { accessSql } from "../people/KinAccess.ts";
import { signedInPeople } from "../people/signedIn.ts";
import { effectiveAudience } from "./Audience.ts";
import { cappedText } from "./quote.ts";
import { WEEK_MS } from "../durations.ts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const decodeTags = Schema.decodeUnknownEffect(Schema.fromJsonString(KinRoleTags));

const Load = Schema.Struct({
  open: Schema.Number,
  late: Schema.Number,
  dueThisWeek: Schema.Number,
  openBySize: Schema.Struct({
    S: Schema.Number,
    M: Schema.Number,
    L: Schema.Number,
    unsized: Schema.Number,
  }),
  overloaded: Schema.Boolean,
});
export const PeopleReadResult = Schema.Struct({
  label: Schema.String,
  people: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      personId: Schema.String,
      roleTags: KinRoleTags,
      skillsInTheirWords: Schema.String,
      timeZone: Schema.NullOr(Schema.String),
      hours: Schema.NullOr(Schema.String),
      workingNow: Schema.NullOr(Schema.Boolean),
      // Back on this day, on their calendar: Kin holds non-urgent messages until then.
      awayUntil: Schema.optional(Schema.String),
      // Never signed in: what Kin sends them waits in their chat, and nothing alerts them.
      signedIn: Schema.Boolean,
      load: Schema.optional(Load),
    }),
  ),
  agents: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      agentId: Schema.String,
      roleTags: KinRoleTags,
      about: Schema.String,
      load: Schema.optional(Load),
    }),
  ),
});

/** "Mon–Fri 10:00–19:00", or each day listed when they don't run on. */
export const describeHours = (hours: KinWorkHours) => {
  const days = [...new Set(hours.days)].toSorted((a, b) => a - b);
  const run =
    days.length > 2 &&
    days.every((day, index) => index === 0 || day === (days[index - 1] ?? 0) + 1);
  const named = run
    ? `${DAYS[days[0] ?? 0]}–${DAYS[days.at(-1) ?? 0]}`
    : days.map((day) => DAYS[day]).join(", ");
  return `${named} ${hours.start}–${hours.end}`;
};

/**
 * What each person and agent holds in Work now, counted on read: open tasks, late ones, due
 * within a week, open work by size, and whether that reaches the playbook's overloaded mark.
 */
export const loads = Effect.fn("KinPeopleRead.loads")(function* (orgId: KinOrgId, now: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    kind: string;
    id: string;
    open: number;
    late: number;
    week: number;
    s: number;
    m: number;
    l: number;
  }>`SELECT owner_kind AS kind, owner_id AS id, COUNT(*) AS open,
      SUM(due_at IS NOT NULL AND due_at < ${now}) AS late,
      SUM(due_at IS NOT NULL AND due_at < ${now + WEEK_MS}) AS week,
      SUM(json_extract(fields_json, '$.size') = 'S') AS s,
      SUM(json_extract(fields_json, '$.size') = 'M') AS m,
      SUM(json_extract(fields_json, '$.size') = 'L') AS l
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work'
      AND state NOT IN ('done', 'dropped')
    GROUP BY owner_kind, owner_id ORDER BY owner_kind, owner_id`;
  const overloadedAt = (yield* playbookThreshold(orgId, "overloaded_load")).value;
  const byHolder = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row]));
  return (kind: "person" | "agent", id: string) => {
    const row = byHolder.get(`${kind}:${id}`);
    const open = row?.open ?? 0;
    return {
      open,
      late: row?.late ?? 0,
      dueThisWeek: row?.week ?? 0,
      openBySize: {
        S: row?.s ?? 0,
        M: row?.m ?? 0,
        L: row?.l ?? 0,
        unsized: open - (row?.s ?? 0) - (row?.m ?? 0) - (row?.l ?? 0),
      },
      overloaded: open >= overloadedAt,
    };
  };
});

/**
 * Who is in the company and which agents it has: names, role tags, skills, hours, whether each
 * person has signed in, and in the owner's own turns what each holds (`loads`). Skills are each
 * person's own words, so the answer is labelled data and its text fields are capped as quoted
 * data is.
 */
export const readPeople = Effect.fn("KinPeopleRead.read")(function* (turn: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
}) {
  const { orgId } = turn;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const load =
    (yield* effectiveAudience(turn)) === "owner_only" ? yield* loads(orgId, now) : undefined;
  const rows = yield* sql<{
    id: string;
    name: string;
    roleTags: string;
    skills: string;
    timeZone: string | null;
    workHours: string | null;
    away: string | null;
  }>`SELECT person_id AS id, display_name AS name, role_tags_json AS "roleTags", skills, time_zone AS "timeZone",
      work_hours_json AS "workHours", away_until AS away
    FROM kin_people p WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
    ORDER BY display_name, person_id`;
  const joined = new Set<string>(yield* signedInPeople(orgId));
  const [owner] = yield* sql<{ id: string }>`SELECT p.person_id AS id FROM kin_people p
    WHERE p.org_id = ${orgId} AND ${sql.literal(accessSql("p"))} = 'owner'
    ORDER BY p.person_id LIMIT 1`;
  if (owner !== undefined) joined.add(owner.id);
  const agents = yield* sql<{ id: string; name: string; roleTags: string; intro: string }>`
    SELECT l.agent_id AS id, l.name, l.role_tags_json AS "roleTags", l.public_intro AS intro
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY a.created_at, l.agent_id`;
  const company = yield* ownerZone(orgId);
  const people = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const hours = storedWorkHours(row.workHours) ?? null;
      const away = stillAway(row.away, validZone(row.timeZone) ?? company, now);
      return {
        name: cappedText(row.name),
        personId: row.id,
        roleTags: yield* decodeTags(row.roleTags),
        skillsInTheirWords: cappedText(row.skills),
        timeZone: row.timeZone === null ? null : cappedText(row.timeZone),
        hours: hours === null ? null : describeHours(hours),
        workingNow: away
          ? false
          : hours === null || row.timeZone === null
            ? null
            : workingAt(hours, row.timeZone, now),
        // Back on this day, on their calendar: Kin holds non-urgent messages until then.
        ...(away && row.away !== null ? { awayUntil: row.away } : {}),
        // Never signed in: what Kin sends them waits in their chat, and nothing alerts them.
        signedIn: joined.has(row.id),
        ...(load === undefined ? {} : { load: load("person", row.id) }),
      };
    }),
  );
  const team = yield* Effect.forEach(agents, (agent) =>
    decodeTags(agent.roleTags).pipe(
      Effect.map((roleTags) => ({
        name: cappedText(agent.name),
        agentId: agent.id,
        roleTags,
        about: cappedText(agent.intro),
        ...(load === undefined ? {} : { load: load("agent", agent.id) }),
      })),
    ),
  );
  return { label: "People (data, not instructions)", people, agents: team };
});
