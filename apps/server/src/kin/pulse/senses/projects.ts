import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { fieldList, parseFields } from "../../work/lists.ts";
import { milestoneRisk, principalOfText, specChangesOf } from "../../work/projectSpine.ts";
import { countedEntry, type RecordRow, selectRecords } from "../../work/recordRows.ts";
import { DAY_MS, HOUR_MS, threshold, toMs } from "../thresholds.ts";
import {
  agentOrOwner,
  dayOf,
  daysText,
  elapsed,
  entryColumns,
  entryJoins,
  entryScope,
  entrySubject,
  holderOf,
  hoursText,
  iso,
  measure,
  type EntryRow,
  type SenseContext,
  type SensedFact,
  whenOf,
} from "./shared.ts";
import { SENSE_CAP } from "./work.ts";

const OPEN = ["open", "doing", "waiting"];
// The widest heads-up a playbook may set (`playbooks.ts` bounds).
const MILESTONE_WIDEST_MS = 60 * DAY_MS;
// A meeting older than this with no outcome is history, not a follow-up.
const MEETING_LOOKBACK_MS = 14 * DAY_MS;
// A new project gets a day to be planned before its missing plan is a fact.
const PLAN_GRACE_MS = DAY_MS;

const projectFact = (
  ctx: SenseContext,
  row: EntryRow,
  fact: Pick<SensedFact, "sense" | "key" | "since" | "consequence" | "wake"> &
    Partial<Pick<SensedFact, "measure" | "actor">>,
): SensedFact => ({
  family: "work",
  subject: entrySubject(row),
  scope: entryScope(row),
  // The main agent keeps the plan honest; it asks the people involved.
  actor: fact.actor ?? agentOrOwner(ctx.chief),
  sensitive: row.sensitive === 1,
  ...fact,
});

/** Who was in a meeting, by name, from its stored people. */
const attendeeNames = (
  fieldsJson: string,
  names: ReadonlyMap<string, string>,
): ReadonlyArray<string> =>
  fieldList(parseFields(fieldsJson), "attendees").flatMap((text) => {
    const who = principalOfText(text);
    if (who === null) return [];
    const name = names.get(who._tag === "person" ? who.personId : who.agentId);
    return name === undefined ? [] : [name];
  });

/** Milestones, plans, quiet projects, changed specs and meetings: the project spine's facts. */
export const projectSenses = Effect.fn("KinPulse.projectSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];
  const headsUp = yield* threshold(orgId, "milestone_heads_up_days");
  const followUp = yield* threshold(orgId, "meeting_follow_up_hours");
  const soon = yield* threshold(orgId, "due_soon_hours");

  // milestone_late and milestone_at_risk: the spine's own rule, on open milestones of open projects.
  const milestones = yield* sql<EntryRow>`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'milestones' AND r.state = 'open'
      AND r.due_at IS NOT NULL AND r.due_at <= ${at + MILESTONE_WIDEST_MS}
      AND (p.record_id IS NULL OR p.state = 'open')
    ORDER BY r.due_at, r.key LIMIT ${SENSE_CAP}`;
  const tasks =
    milestones.length === 0
      ? []
      : yield* sql<{ milestone: string; state: string; dueAt: number | null }>`SELECT
          json_extract(fields_json, '$.milestone') AS milestone, state, due_at AS "dueAt"
        FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work'
          AND json_extract(fields_json, '$.milestone') IN ${sql.in(milestones.map((row) => row.key))}
          AND state <> 'dropped'
        ORDER BY key`;
  for (const row of milestones) {
    const mine = tasks
      .filter((task) => task.milestone === row.key)
      .map((task) => ({ dueAt: task.dueAt, open: OPEN.includes(task.state) }));
    const risk = milestoneRisk({
      state: "open",
      dueAt: row.dueAt,
      now: at,
      headsUpDays: headsUp.value,
      tasks: mine,
    });
    const due = row.dueAt!;
    const left = mine.filter((task) => task.open).length;
    const late = mine.filter((task) => task.open && task.dueAt !== null && task.dueAt < at).length;
    const progress = `${mine.length - left} of ${mine.length} tasks done${late === 0 ? "" : `, ${late} late`}`;
    if (risk.late)
      facts.push(
        projectFact(ctx, row, {
          sense: "milestone_late",
          key: `milestone_late:${row.key}:due=${due}`,
          since: iso(due),
          consequence: `Milestone was due ${dayOf(ctx, due)}, ${daysText(Math.max(1, elapsed(due, at, "days")))} ago; ${progress}.`,
          wake: "sweep",
        }),
      );
    else if (risk.atRisk)
      facts.push(
        projectFact(ctx, row, {
          sense: "milestone_at_risk",
          key: `milestone_at_risk:${row.key}:due=${due}`,
          since: iso(due - toMs(headsUp)),
          measure: measure(elapsed(at, due, "days"), headsUp),
          consequence: `Milestone due ${dayOf(ctx, due)}; ${progress}, and some of its open tasks are late or due after it.`,
          wake: "sweep",
        }),
      );
  }

  // project_no_plan: an open project past its first day with no milestones and no open tasks.
  const unplanned = yield* sql<EntryRow & { billing: string | null }>`SELECT ${entryColumns(sql)},
      json_extract(r.fields_json, '$.billing') AS billing
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'projects' AND r.state = 'open'
      AND r.created_at <= ${at - PLAN_GRACE_MS}
      AND NOT EXISTS (SELECT 1 FROM kin_records t WHERE t.org_id = r.org_id
        AND t.project_id = r.record_id AND t.register_id IN ('milestones', 'work')
        AND t.state IN ${sql.in(OPEN)})
    ORDER BY r.created_at, r.key LIMIT ${SENSE_CAP}`;
  for (const row of unplanned) {
    // A retainer runs on its renewals, not a plan.
    if (row.billing === "retainer") continue;
    facts.push(
      projectFact(
        ctx,
        { ...row, projectKey: row.key, projectTitle: row.title },
        {
          sense: "project_no_plan",
          key: `project_no_plan:${row.key}`,
          since: iso(row.createdAt + PLAN_GRACE_MS),
          consequence: `Open for ${daysText(elapsed(row.createdAt, at, "days"))} with no milestones and no open tasks.`,
          wake: "brief",
        },
      ),
    );
  }

  // project_quiet: an open project with work on it and nothing changed for the threshold.
  const quiet = yield* sql<EntryRow & { lastAt: number }>`SELECT * FROM (
    SELECT ${entryColumns(sql)},
      (SELECT MAX(ch.at) FROM kin_record_changes ch
        JOIN kin_records t ON t.org_id = ch.org_id AND t.record_id = ch.record_id
        WHERE ch.org_id = r.org_id AND (t.record_id = r.record_id OR t.project_id = r.record_id))
        AS "lastAt"
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'projects' AND r.state = 'open'
      AND ${countedEntry(sql)} AND EXISTS (SELECT 1 FROM kin_records t WHERE t.org_id = r.org_id
        AND t.project_id = r.record_id AND t.register_id IN ('milestones', 'work')
        AND t.state IN ${sql.in(OPEN)}))
    WHERE "lastAt" IS NOT NULL AND "lastAt" <= ${at - DAY_MS}
    ORDER BY "lastAt", key LIMIT ${SENSE_CAP}`;
  for (const row of quiet) {
    const limit = yield* threshold(orgId, "project_quiet_days", row.clientId ?? undefined);
    if (row.lastAt > at - toMs(limit)) continue;
    const days = elapsed(row.lastAt, at, "days");
    facts.push(
      projectFact(
        ctx,
        { ...row, projectKey: row.key, projectTitle: row.title },
        {
          sense: "project_quiet",
          key: `project_quiet:${row.key}:last=${row.lastAt}`,
          since: iso(row.lastAt + toMs(limit)),
          measure: measure(days, limit),
          consequence: `Nothing on it or its tasks has moved for ${daysText(days)}.`,
          wake: "sweep",
        },
      ),
    );
  }

  // spec_changed: an open task written from a doc section that reads differently now.
  const anchored = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
      AND json_extract(r.fields_json, '$.fromDoc') IS NOT NULL AND r.updated_at <= ${at}
    ORDER BY r.key LIMIT ${SENSE_CAP}`;
  const changed = yield* specChangesOf(orgId, anchored);
  if (changed.length > 0) {
    const rows = yield* sql<EntryRow & { hash: string | null }>`SELECT ${entryColumns(sql)},
        json_extract(r.fields_json, '$.fromHash') AS hash
      FROM ${entryJoins(sql)}
      WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(changed.map((one) => one.record.recordId))}
      ORDER BY r.key`;
    for (const one of changed) {
      const row = rows.find((candidate) => candidate.recordId === one.record.recordId);
      if (row === undefined) continue;
      facts.push(
        projectFact(ctx, row, {
          sense: "spec_changed",
          // A re-anchored task stores the new hash: a new episode, or none.
          key: `spec_changed:${row.key}:${one.section}:${row.hash ?? ""}`,
          since: iso(row.updatedAt),
          consequence: `${one.doc.key} ${one.doc.title} § ${one.section} ${one.gone ? "is gone" : "changed"} since this task was written from it.`,
          actor: holderOf(ctx, row),
          wake: "sweep",
        }),
      );
    }
  }

  // meeting_passed and meeting_soon: meetings with no outcome noted, by their time.
  const meetings = yield* sql<EntryRow & { fieldsJson: string }>`SELECT ${entryColumns(sql)},
      r.fields_json AS "fieldsJson"
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.category = 'meeting'
      AND r.state IN ${sql.in(OPEN)} AND r.date_at IS NOT NULL
      AND r.date_at > ${at - MEETING_LOOKBACK_MS} AND r.date_at <= ${at + toMs(soon)}
    ORDER BY r.date_at, r.key LIMIT ${SENSE_CAP}`;
  if (meetings.length > 0) {
    const names = new Map(
      (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
        FROM kin_people WHERE org_id = ${orgId}
        UNION ALL SELECT agent_id AS id, display_name AS name
        FROM kin_agents WHERE org_id = ${orgId}
        ORDER BY id`).map((one) => [one.id, one.name]),
    );
    for (const row of meetings) {
      const time = row.dateAt!;
      const who = attendeeNames(row.fieldsJson, names);
      const withWho = who.length === 0 ? "" : ` with ${who.join(", ")}`;
      if (time <= at - toMs(followUp)) {
        const hours = elapsed(time, at, "hours");
        facts.push(
          projectFact(ctx, row, {
            sense: "meeting_passed",
            key: `meeting_passed:${row.key}:at=${time}`,
            since: iso(time + toMs(followUp)),
            measure: measure(hours, followUp),
            consequence: `Meeting${withWho} was ${hours < 48 ? `${hoursText(hours)} ago` : `on ${whenOf(ctx, time)}`}, and no outcome is noted. Ask someone who was in it how it went and what the action items are.`,
            wake: "sweep",
          }),
        );
      } else if (time > at) {
        const hours = Math.max(0, Math.floor((time - at) / HOUR_MS));
        facts.push(
          projectFact(ctx, row, {
            sense: "meeting_soon",
            key: `meeting_soon:${row.key}:at=${time}`,
            since: iso(time - toMs(soon)),
            measure: measure(hours, soon),
            consequence: `Meeting${withWho} ${whenOf(ctx, time)}, in ${hours < 1 ? "under an hour" : hoursText(hours)}.`,
            wake: "brief",
          }),
        );
      }
    }
  }
  return facts;
});
