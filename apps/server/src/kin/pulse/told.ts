import type { KinAgentId, KinOrgId, KinPulseFact } from "@t3tools/contracts";
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

/** Work its holder must hear of: late, owed to us and late, or due today and not started. */
export const forHolder = (fact: KinPulseFact, at: number, zone: string) =>
  fact.sense === "task_late" ||
  fact.sense === "theirs_late" ||
  (fact.sense === "task_due_soon" && dueToday(fact, at, zone));

export const SHELL_QUIET_EVENT_PREFIX = "shell:quiet:";

/** A told row's party: a person by id, an agent as `agent:<id>`. */
export const agentParty = (agentId: KinAgentId) => `agent:${agentId}`;

/**
 * What a told fact is compared on, from its own fields: how many times its threshold has been
 * passed (an invoice crossing another chase interval), a renewal's stage, and its due day. Only
 * open facts are told, so who has one in hand is never part of it.
 */
export const factSig = (fact: KinPulseFact, at: number, zone: string) => {
  const m = fact.measure;
  const band =
    fact.stage !== undefined
      ? fact.stage
      : m === undefined || DUE_SENSES.has(fact.sense) || m.threshold <= 0
        ? ""
        : String(Math.floor(m.value / m.threshold));
  // "open" stays so rows told before holds left the signature still match.
  return `${band}|open|${dueToday(fact, at, zone) ? `due:${dayIn(at, zone)}` : ""}`;
};

/**
 * The facts `personId` (or `agentParty`) has not been told as they stand now: never told, changed
 * since, or due today. A row counts while its event is still to run or ran, a failed one told
 * nothing; with `anyState`, any row counts, so a failing turn is not tried again every pass, and
 * a row Kin's own notice wrote (its id is the message's, with no event) counts too.
 */
export const untold = Effect.fn("KinPulse.untold")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: string;
  readonly facts: ReadonlyArray<KinPulseFact>;
  readonly at: number;
  readonly zone: string;
  readonly anyState?: boolean | undefined;
  /** A pending or failed event does not stand in for a quiet delivery marker. */
  readonly deliveredOnly?: true;
}) {
  if (input.facts.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const told = new Map<string, Set<string>>();
  const counted = input.deliveredOnly
    ? sql`(e.event_id IS NULL OR e.state = 'done')`
    : input.anyState
      ? sql`1 = 1`
      : sql`(t.event_id LIKE ${`${SHELL_QUIET_EVENT_PREFIX}%`}
          OR e.state IN ('queued', 'claimed', 'done'))`;
  const keys = input.facts.map((fact) => fact.key);
  for (let start = 0; start < keys.length; start += 500)
    for (const row of yield* sql<{ key: string; sig: string }>`SELECT t.fact_key AS key, t.sig
      FROM kin_pulse_told t LEFT JOIN kin_events e ON e.org_id = t.org_id AND e.event_id = t.event_id
      WHERE t.org_id = ${input.orgId} AND t.person_id = ${input.personId}
        AND t.fact_key IN ${sql.in(keys.slice(start, start + 500))}
        AND ${counted}
      ORDER BY t.fact_key, t.told_at`)
      told.set(row.key, (told.get(row.key) ?? new Set()).add(row.sig));
  return input.facts.filter(
    (fact) => told.get(fact.key)?.has(factSig(fact, input.at, input.zone)) !== true,
  );
});

/** Marks `facts` told to `personId` (or `agentParty`) by the event `eventId`. */
export const markTold = Effect.fn("KinPulse.markTold")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: string;
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
