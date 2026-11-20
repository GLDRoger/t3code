import { KinAgentId, KinPersonId, type KinPulseActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { validZone } from "../../triggers/quietHold.ts";
import { stillAway } from "../../triggers/quietHours.ts";
import { waitingSince } from "../../work/crm.ts";
import { ownerZone } from "../../work/recordRows.ts";
import { DAY_MS, thresholds, toMs } from "../thresholds.ts";
import {
  dayOf,
  daysAgoText,
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
    Partial<Pick<SensedFact, "measure" | "actor" | "yours">>,
): SensedFact => ({
  family: "work",
  subject: entrySubject(row),
  scope: entryScope(row),
  actor: fact.actor ?? holderOf(ctx, row),
  sensitive: row.sensitive === 1,
  ...fact,
});

const awayLine = (
  row: EntryRow,
  away: ReadonlyMap<string, { readonly name: string; readonly day: string }>,
) => {
  const holder = row.ownerKind === "person" ? away.get(row.ownerId) : undefined;
  return holder === undefined ? "" : ` ${holder.name} is away until ${holder.day}.`;
};

export const workSenses = Effect.fn("KinPulse.workSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];
  const limits = yield* thresholds(orgId);
  const grace = limits("late_grace_hours");
  const soon = limits("due_soon_hours");
  const stalled = limits("stalled_after_days");
  const waiting = limits("waiting_too_long_days");

  // task_late and theirs_late: an open entry whose due date and grace have passed.
  const late = yield* sql<EntryRow & { side: string }>`SELECT ${entryColumns(sql)}, r.side
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
      AND r.due_at IS NOT NULL AND r.due_at <= ${at - toMs(grace)}
    ORDER BY r.due_at, r.key LIMIT ${SENSE_CAP * 2}`;
  // A holder away right now: their late task says until when, so nobody chases them meanwhile.
  const awayRows = yield* sql<{ personId: string; name: string; day: string; zone: string | null }>`
    SELECT person_id AS "personId", display_name AS name, away_until AS day, time_zone AS zone
    FROM kin_people WHERE org_id = ${orgId} AND away_until IS NOT NULL ORDER BY person_id`;
  const company = awayRows.length === 0 ? "UTC" : yield* ownerZone(orgId);
  const away = new Map(
    awayRows
      .filter((one) => stillAway(one.day, validZone(one.zone) ?? company, at))
      .map((one) => [one.personId, one]),
  );
  for (const row of late) {
    const due = row.dueAt!;
    const ours = row.side === "ours";
    facts.push(
      workFact(ctx, row, {
        sense: ours ? "task_late" : "theirs_late",
        key: `${ours ? "task_late" : "theirs_late"}:${row.key}:due=${due}`,
        since: iso(due + toMs(grace)),
        measure: measure(elapsed(due, at, "hours"), grace),
        consequence: `${ours ? "Was due" : "They owed it by"} ${dayOf(ctx, due)}, ${daysAgoText(ctx, due)}.${awayLine(row, away)}`,
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

  // holder_removed: an open task held by someone whose access was removed. It stays in their
  // name (`KinPeople.removeAccess`); the owner gives it to someone else or lets them back in.
  const orphaned = yield* sql<EntryRow & { holder: string; removedAt: number }>`
    SELECT ${entryColumns(sql)}, h.display_name AS holder, h.removed_at AS "removedAt"
    FROM ${entryJoins(sql)}
    JOIN kin_people h ON h.org_id = r.org_id AND r.owner_kind = 'person'
      AND h.person_id = r.owner_id AND h.removed_at IS NOT NULL
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
    ORDER BY h.removed_at, r.key LIMIT ${SENSE_CAP}`;
  for (const row of orphaned)
    facts.push(
      workFact(ctx, row, {
        sense: "holder_removed",
        key: `holder_removed:${row.key}:${row.ownerId}:${row.removedAt}`,
        since: iso(row.removedAt),
        consequence: `Held by ${row.holder}, whose access was removed. Give it to someone else, or bring them back.`,
        wake: "sweep",
        actor: { _tag: "owner" },
      }),
    );

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
        yours: (reader) =>
          row.onKind === "person" && row.onId === reader
            ? `Waiting on you for ${daysText(days)}.`
            : undefined,
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
