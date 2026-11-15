import { KinAgentId, KinPersonId, type KinPulseActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { waitingSince } from "../../work/crm.ts";
import { DAY_MS, threshold, toMs } from "../thresholds.ts";
import {
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
} from "./shared.ts";

/** Facts per sense are bounded; past this the read says how many it found, not each one. */
export const SENSE_CAP = 500;
const OPEN = ["open", "doing", "waiting"];

const workFact = (
  ctx: SenseContext,
  row: EntryRow,
  fact: Pick<SensedFact, "sense" | "key" | "since" | "consequence" | "wake"> &
    Partial<Pick<SensedFact, "measure" | "actor">>,
): SensedFact => ({
  family: "work",
  subject: entrySubject(row),
  scope: entryScope(row),
  actor: fact.actor ?? holderOf(ctx, row),
  sensitive: row.sensitive === 1,
  ...fact,
});

export const workSenses = Effect.fn("KinPulse.workSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];
  const grace = yield* threshold(orgId, "late_grace_hours");
  const soon = yield* threshold(orgId, "due_soon_hours");
  const stalled = yield* threshold(orgId, "stalled_after_days");
  const waiting = yield* threshold(orgId, "waiting_too_long_days");

  // task_late and theirs_late: an open entry whose due date and grace have passed.
  const late = yield* sql<EntryRow & { side: string }>`SELECT ${entryColumns(sql)}, r.side
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
      AND r.due_at IS NOT NULL AND r.due_at <= ${at - toMs(grace)}
    ORDER BY r.due_at, r.key LIMIT ${SENSE_CAP * 2}`;
  for (const row of late) {
    const due = row.dueAt!;
    const days = elapsed(due, at, "days");
    const ours = row.side === "ours";
    facts.push(
      workFact(ctx, row, {
        sense: ours ? "task_late" : "theirs_late",
        key: `${ours ? "task_late" : "theirs_late"}:${row.key}:due=${due}`,
        since: iso(due + toMs(grace)),
        measure: measure(elapsed(due, at, "hours"), grace),
        consequence: `${ours ? "Was due" : "They owed it by"} ${dayOf(ctx, due)}, ${days < 1 ? "today" : `${daysText(days)} ago`}.`,
        wake: "sweep",
      }),
    );
  }

  // task_due_soon: not started, and due within the window.
  const due = yield* sql<EntryRow>`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.side = 'ours' AND r.state = 'open'
      AND r.due_at IS NOT NULL AND r.due_at > ${at} AND r.due_at <= ${at + toMs(soon)}
    ORDER BY r.due_at, r.key LIMIT ${SENSE_CAP}`;
  for (const row of due) {
    const left = elapsed(at, row.dueAt!, "hours");
    facts.push(
      workFact(ctx, row, {
        sense: "task_due_soon",
        key: `task_due_soon:${row.key}:due=${row.dueAt}`,
        since: iso(row.dueAt! - toMs(soon)),
        measure: measure(left, soon),
        consequence: `Due ${dayOf(ctx, row.dueAt!)}, in ${left < 1 ? "under an hour" : hoursText(left)}, and not started.`,
        wake: "sweep",
      }),
    );
  }

  // task_stalled: in progress with no change logged for the threshold.
  const doing = yield* sql<
    EntryRow & { lastAt: number }
  >`SELECT * FROM (SELECT ${entryColumns(sql)},
      COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state = 'doing')
    WHERE "lastAt" <= ${at - toMs(stalled)}
    ORDER BY "lastAt", key LIMIT ${SENSE_CAP}`;
  for (const row of doing) {
    const days = elapsed(row.lastAt, at, "days");
    facts.push(
      workFact(ctx, row, {
        sense: "task_stalled",
        key: `task_stalled:${row.key}:last=${row.lastAt}`,
        since: iso(row.lastAt + toMs(stalled)),
        measure: measure(days, stalled),
        consequence: `In progress with no change for ${daysText(days)}.`,
        wake: "sweep",
      }),
    );
  }

  // waiting_long: waiting on someone for longer than the threshold. Whoever it waits on acts.
  const waits = yield* sql<
    EntryRow & { since: number; onKind: string | null; onId: string | null; onName: string | null }
  >`SELECT * FROM (SELECT ${entryColumns(sql)}, ${waitingSince(sql, "r")} AS since,
      r.waiting_on_kind AS "onKind", r.waiting_on_id AS "onId",
      COALESCE(wp.display_name, wa.display_name) AS "onName"
    FROM ${entryJoins(sql)}
    LEFT JOIN kin_people wp ON r.waiting_on_kind = 'person' AND wp.org_id = r.org_id
      AND wp.person_id = r.waiting_on_id
    LEFT JOIN kin_agents wa ON r.waiting_on_kind = 'agent' AND wa.org_id = r.org_id
      AND wa.agent_id = r.waiting_on_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state = 'waiting')
    WHERE since <= ${at - toMs(waiting)}
    ORDER BY since, key LIMIT ${SENSE_CAP}`;
  for (const row of waits) {
    const days = elapsed(row.since, at, "days");
    const on: KinPulseActor | undefined =
      row.onKind === "agent" && row.onId !== null && ctx.liveAgents.has(row.onId)
        ? { _tag: "agent", agentId: KinAgentId.make(row.onId) }
        : row.onKind === "person" && row.onId !== null
          ? { _tag: "person", personId: KinPersonId.make(row.onId) }
          : undefined;
    facts.push(
      workFact(ctx, row, {
        sense: "waiting_long",
        key: `waiting_long:${row.key}:since=${row.since}`,
        since: iso(row.since + toMs(waiting)),
        measure: measure(days, waiting),
        consequence: `Waiting${row.onName === null ? "" : ` on ${row.onName}`} for ${daysText(days)}.`,
        wake: "sweep",
        ...(on === undefined ? {} : { actor: on }),
      }),
    );
  }

  // to_confirm: suggested a day ago or more, and nobody has confirmed it.
  const suggested = yield* sql<EntryRow>`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.confirmed = 0
      AND r.state IN ${sql.in(OPEN)} AND r.created_at <= ${at - DAY_MS}
    ORDER BY r.created_at, r.key LIMIT ${SENSE_CAP}`;
  for (const row of suggested)
    facts.push(
      workFact(ctx, row, {
        sense: "to_confirm",
        key: `to_confirm:${row.key}`,
        since: iso(row.createdAt + DAY_MS),
        consequence: `Suggested ${daysText(elapsed(row.createdAt, at, "days"))} ago and not confirmed.`,
        wake: "brief",
      }),
    );
  return facts;
});
