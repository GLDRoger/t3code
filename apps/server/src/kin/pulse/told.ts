import type { KinOrgId, KinPersonId, KinPulseFact } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn } from "../work/money.ts";
import { HOUR_MS, DAY_MS } from "./thresholds.ts";

/** Facts about something coming due: their measure counts down to it. */
const DUE_SENSES = new Set<KinPulseFact["sense"]>([
  "task_due_soon",
  "meeting_soon",
  "retainer_due",
  "renewal_due",
]);

const unitMs = (unit: string) => (unit === "hours" ? HOUR_MS : unit === "days" ? DAY_MS : 0);

/** Whether a coming-due fact falls due on `at`'s day in `zone`. */
const dueToday = (fact: KinPulseFact, at: number, zone: string) => {
  if (!DUE_SENSES.has(fact.sense) || fact.measure === undefined) return false;
  const ms = unitMs(fact.measure.unit);
  return ms > 0 && dayIn(at + Math.max(0, fact.measure.value) * ms, zone) === dayIn(at, zone);
};

/**
 * What a told fact is compared on, from its own fields: how many times its threshold has been
 * passed (an invoice crossing another chase interval), who has it in hand, and its due day.
 */
export const factSig = (fact: KinPulseFact, at: number, zone: string) => {
  const m = fact.measure;
  const band =
    m === undefined || DUE_SENSES.has(fact.sense) || m.threshold <= 0
      ? ""
      : String(Math.floor(m.value / m.threshold));
  const until = fact.handled?.until === undefined ? null : fact.handled.until;
  const held =
    fact.handled === null
      ? "open"
      : until === null
        ? "settled"
        : DateTime.toEpochMillis(until) > at
          ? `held:${fact.handled.by._tag === "agent" ? fact.handled.by.agentId : fact.handled.by.personId}`
          : "open";
  return `${band}|${held}|${dueToday(fact, at, zone) ? `due:${dayIn(at, zone)}` : ""}`;
};

/**
 * The facts `personId` has not been told as they stand now: never told, changed since, or due
 * today. A row counts while its check-in is still to run or ran; a failed one told nothing.
 */
export const untold = Effect.fn("KinPulse.untold")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly facts: ReadonlyArray<KinPulseFact>;
  readonly at: number;
  readonly zone: string;
}) {
  if (input.facts.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const told = new Map<string, Set<string>>();
  const keys = input.facts.map((fact) => fact.key);
  for (let start = 0; start < keys.length; start += 500)
    for (const row of yield* sql<{ key: string; sig: string }>`SELECT t.fact_key AS key, t.sig
      FROM kin_pulse_told t JOIN kin_events e ON e.org_id = t.org_id AND e.event_id = t.event_id
      WHERE t.org_id = ${input.orgId} AND t.person_id = ${input.personId}
        AND t.fact_key IN ${sql.in(keys.slice(start, start + 500))}
        AND e.state IN ('queued', 'claimed', 'done')
      ORDER BY t.fact_key, t.told_at`)
      told.set(row.key, (told.get(row.key) ?? new Set()).add(row.sig));
  return input.facts.filter(
    (fact) => told.get(fact.key)?.has(factSig(fact, input.at, input.zone)) !== true,
  );
});

/** Marks `facts` told to `personId` by the check-in `eventId`. */
export const markTold = Effect.fn("KinPulse.markTold")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly eventId: string;
  readonly facts: ReadonlyArray<KinPulseFact>;
  readonly at: number;
  readonly zone: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  for (const fact of input.facts)
    yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
      VALUES (${input.orgId}, ${input.personId}, ${fact.key}, ${input.eventId},
        ${factSig(fact, input.at, input.zone)}, ${input.at})
      ON CONFLICT DO NOTHING`;
});

/** The facts a check-in event was given to tell. */
export const toldBy = Effect.fn("KinPulse.toldBy")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
) {
  if (eventIds.length === 0) return new Set<string>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string }>`SELECT DISTINCT fact_key AS key FROM kin_pulse_told
    WHERE org_id = ${orgId} AND event_id IN ${sql.in(eventIds)} ORDER BY fact_key`;
  return new Set(rows.map((row) => row.key));
});
