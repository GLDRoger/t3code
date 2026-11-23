import { KinAgentId, type KinOrgId, KinPersonId, type KinPulseActor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { cappedRows, SENSE_CAP } from "./capped.ts";

import * as KinShell from "../../shell/KinShell.ts";
import { validZone } from "../../triggers/quietHold.ts";
import { stillAway } from "../../triggers/quietHours.ts";
import { waitingSince } from "../../work/crm.ts";
import { fieldDateAt, ownerZone } from "../../work/recordRows.ts";
import { isFieldDate, isFieldNumber, listDef, OWN_DATE } from "../../work/registers.ts";
import { DAY_MS, type Threshold, thresholds, toMs } from "../thresholds.ts";
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

const OPEN = ["open", "doing", "waiting"];

const workFact = (
  ctx: SenseContext,
  row: EntryRow,
  fact: Pick<SensedFact, "sense" | "key" | "since" | "consequence" | "wake"> &
    Partial<Pick<SensedFact, "measure" | "actor" | "yours" | "section">>,
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
  const late = yield* cappedRows<EntryRow & { side: string }>(
    ctx,
    facts,
    {
      sense: "task_late",
      plural: "late tasks and obligations",
      access: "work",
      cap: SENSE_CAP * 2,
    },
    sql`SELECT ${entryColumns(sql)}, r.side
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
      AND r.due_at IS NOT NULL AND r.due_at <= ${at - toMs(grace)}
    ORDER BY r.due_at, r.key`,
  );
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
  const due = yield* cappedRows<EntryRow>(
    ctx,
    facts,
    {
      sense: "task_due_soon",
      plural: "tasks due soon",
      access: "work",
    },
    sql`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.side = 'ours' AND r.state = 'open'
      AND r.due_at IS NOT NULL AND r.due_at > ${at} AND r.due_at <= ${at + toMs(soon)}
    ORDER BY r.due_at, r.key`,
  );
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
  const orphaned = yield* cappedRows<EntryRow & { holder: string; removedAt: number }>(
    ctx,
    facts,
    {
      sense: "holder_removed",
      plural: "tasks held by people whose access was removed",
      access: "owner",
    },
    sql`
    SELECT ${entryColumns(sql)}, h.display_name AS holder, h.removed_at AS "removedAt"
    FROM ${entryJoins(sql)}
    JOIN kin_people h ON h.org_id = r.org_id AND r.owner_kind = 'person'
      AND h.person_id = r.owner_id AND h.removed_at IS NOT NULL
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state IN ${sql.in(OPEN)}
    ORDER BY h.removed_at, r.key`,
  );
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
  const doing = yield* cappedRows<EntryRow & { lastAt: number }>(
    ctx,
    facts,
    {
      sense: "task_stalled",
      plural: "stalled tasks",
      access: "work",
    },
    sql`SELECT * FROM (SELECT ${entryColumns(sql)},
      COALESCE((SELECT MAX(ch.at) FROM kin_record_changes ch
        WHERE ch.org_id = r.org_id AND ch.record_id = r.record_id), r.updated_at) AS "lastAt"
    FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state = 'doing')
    WHERE "lastAt" <= ${at - toMs(stalled)}
    ORDER BY "lastAt", key`,
  );
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
  const waits = yield* cappedRows<
    EntryRow & { since: number; onKind: string | null; onId: string | null; onName: string | null }
  >(
    ctx,
    facts,
    {
      sense: "waiting_long",
      plural: "tasks waiting on someone",
      access: "work",
    },
    sql`SELECT * FROM (SELECT ${entryColumns(sql)}, ${waitingSince(sql, "r")} AS since,
      r.waiting_on_kind AS "onKind", r.waiting_on_id AS "onId",
      COALESCE(wp.display_name, wa.display_name) AS "onName"
    FROM ${entryJoins(sql)}
    LEFT JOIN kin_people wp ON r.waiting_on_kind = 'person' AND wp.org_id = r.org_id
      AND wp.person_id = r.waiting_on_id
    LEFT JOIN kin_agents wa ON r.waiting_on_kind = 'agent' AND wa.org_id = r.org_id
      AND wa.agent_id = r.waiting_on_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.state = 'waiting')
    WHERE since <= ${at - toMs(waiting)}
    ORDER BY since, key`,
  );
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
  const suggested = yield* cappedRows<EntryRow>(
    ctx,
    facts,
    {
      sense: "to_confirm",
      plural: "unconfirmed tasks",
      access: "work",
    },
    sql`SELECT ${entryColumns(sql)} FROM ${entryJoins(sql)}
    WHERE r.org_id = ${orgId} AND r.register_id = 'work' AND r.confirmed = 0
      AND r.state IN ${sql.in(OPEN)} AND r.created_at <= ${at - DAY_MS}
    ORDER BY r.created_at, r.key`,
  );
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
  facts.push(...(yield* entrySenses(ctx, { grace, soon })));
  return facts;
});

/** The live lists the shell shows as sections, on or off: their switch silences their facts. */
const sectionLists = Effect.fn("KinPulse.sectionLists")(function* (orgId: KinOrgId) {
  const shell = yield* KinShell.getForDisplay(orgId);
  const defs = yield* Effect.forEach(
    shell.sections.flatMap((section) => KinShell.listOfSection(section.id) ?? []),
    (id) => listDef(orgId, id),
  );
  return defs.flatMap((def) =>
    def === undefined || def.builtIn !== null || def.archivedAt !== null ? [] : [def],
  );
});

const numberOf = (value: unknown) =>
  typeof value === "string" && isFieldNumber(value) ? Number(value) : undefined;

/**
 * entry_late: an open entry of a list section whose due day (or its `remindOn` date) comes within
 * the due-soon window, or has passed by the late grace, as for a task. entry_check: an open entry
 * outside its list's check, one fact per entry and check until it is back inside.
 */
const entrySenses = Effect.fn("KinPulse.entrySenses")(function* (
  ctx: SenseContext,
  limits: { readonly grace: Threshold; readonly soon: Threshold },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const { grace, soon } = limits;
  const facts: Array<SensedFact> = [];
  for (const def of yield* sectionLists(orgId)) {
    const section = KinShell.listSectionId(def.id);
    // A field the list really has wins; else `date` is each entry's own date (`OWN_DATE`).
    const field = def.fields.some((one) => one.key === def.remindOn) ? def.remindOn : undefined;
    const remind = field;
    const column =
      def.remindOn === OWN_DATE && field === undefined ? sql`r.date_at` : sql`r.due_at`;
    const until = dayOf(ctx, at + toMs(soon) + DAY_MS);
    // Only the owner level hears how many more there are: a member's count reads Work alone.
    const cap = (id: string, sense: "entry_late" | "entry_check", plural: string) => ({
      id: `${id}:${def.id}`,
      sense,
      plural: `${plural} in ${def.name}`,
      section,
      access: "owner" as const,
    });
    const dated = yield* cappedRows<EntryRow & { state: string; remind: unknown }>(
      ctx,
      facts,
      { ...cap("entry_late", "entry_late", "entries late or due soon"), cap: SENSE_CAP * 2 },
      sql`SELECT ${entryColumns(sql)}, r.state,
        ${remind === undefined ? sql`NULL` : sql`json_extract(r.fields_json, ${`$.${remind}`})`} AS remind
      FROM ${entryJoins(sql)}
      WHERE r.org_id = ${orgId} AND r.register_id = ${def.id} AND r.state IN ${sql.in(OPEN)}
        AND ${
          remind === undefined
            ? sql`${column} IS NOT NULL AND (${column} <= ${at - toMs(grace)} OR (r.state = 'open'
                AND ${column} > ${at} AND ${column} <= ${at + toMs(soon)}))`
            : sql`substr(json_extract(r.fields_json, ${`$.${remind}`}), 1, 10) <= ${until}`
        }
      ORDER BY r.key`,
    );
    for (const row of dated) {
      const due =
        remind === undefined
          ? def.remindOn === OWN_DATE
            ? row.dateAt
            : row.dueAt
          : typeof row.remind === "string" && isFieldDate(row.remind)
            ? fieldDateAt(row.remind, ctx.zone).at
            : null;
      if (due === null) continue;
      const fact = { section, wake: "sweep" as const, sense: "entry_late" as const };
      if (due <= at - toMs(grace))
        facts.push(
          workFact(ctx, row, {
            ...fact,
            key: `entry_late:${row.key}:due=${due}`,
            since: iso(due + toMs(grace)),
            measure: measure(elapsed(due, at, "hours"), grace),
            consequence: `Was due ${dayOf(ctx, due)}, ${daysAgoText(ctx, due)}.`,
          }),
        );
      else if (row.state === "open" && due > at && due <= at + toMs(soon)) {
        const left = elapsed(at, due, "hours");
        facts.push(
          workFact(ctx, row, {
            ...fact,
            key: `entry_late:${row.key}:soon=${due}`,
            since: iso(due - toMs(soon)),
            measure: measure(left, soon),
            consequence: `Due ${dayOf(ctx, due)}, in ${left < 1 ? "under an hour" : hoursText(left)}.`,
          }),
        );
      }
    }
    const check = def.check;
    if (check === undefined) continue;
    const other = check.below ?? check.above;
    if (other === undefined) continue;
    const label = (key: string) => def.fields.find((one) => one.key === key)?.label ?? key;
    const value = sql`CAST(json_extract(r.fields_json, ${`$.${check.field}`}) AS REAL)`;
    const bound =
      typeof other === "number"
        ? sql`${other}`
        : sql`CAST(json_extract(r.fields_json, ${`$.${other}`}) AS REAL)`;
    const rows = yield* cappedRows<EntryRow & { value: unknown; other: unknown }>(
      ctx,
      facts,
      cap("entry_check", "entry_check", "entries off their check"),
      sql`SELECT ${entryColumns(sql)}, json_extract(r.fields_json, ${`$.${check.field}`}) AS value,
        ${typeof other === "number" ? sql`NULL` : sql`json_extract(r.fields_json, ${`$.${other}`})`} AS other
      FROM ${entryJoins(sql)}
      WHERE r.org_id = ${orgId} AND r.register_id = ${def.id} AND r.state IN ${sql.in(OPEN)}
        AND json_extract(r.fields_json, ${`$.${check.field}`}) IS NOT NULL
        AND ${check.below === undefined ? sql`${value} > ${bound}` : sql`${value} < ${bound}`}
      ORDER BY r.key`,
    );
    for (const row of rows) {
      const value = numberOf(row.value);
      const limit = typeof other === "number" ? other : numberOf(row.other);
      if (value === undefined || limit === undefined) continue;
      const below = check.below !== undefined;
      if (below ? value >= limit : value <= limit) continue;
      const side = below ? "below" : "above";
      facts.push(
        workFact(ctx, row, {
          section,
          sense: "entry_check",
          key: `entry_check:${row.key}:${check.field}:${side}=${other}`,
          since: iso(row.updatedAt),
          consequence: `${label(check.field)} is ${value}, ${side} ${typeof other === "number" ? other : `${label(other)} (${limit})`}.`,
          wake: "sweep",
        }),
      );
    }
  }
  return facts;
});
