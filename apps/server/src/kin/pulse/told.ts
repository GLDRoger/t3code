import type {
  KinAgentId,
  KinChatId,
  KinOrgId,
  KinPulseFact,
  KinWakeupId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { dayIn } from "../work/money.ts";
import { UNREADABLE_BANK_ALERTS_KEY } from "./senses/bank.ts";
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
      ORDER BY t.fact_key, t.told_at DESC, t.rowid DESC`) {
      // The unreadable count can go down and back up while the same fact stays open.
      if (row.key === UNREADABLE_BANK_ALERTS_KEY && told.has(row.key)) continue;
      told.set(row.key, (told.get(row.key) ?? new Set()).add(row.sig));
    }
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

/** Retain a check-in's reservation while recording which wake-up handled the fact. */
export const checkInHandling = Effect.fn("KinPulse.checkInHandling")(function* (input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: KinWakeupId;
  readonly agentId: KinAgentId;
  readonly factKey: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ event_id: string }>`UPDATE kin_events AS e
    SET json = json_set(json, '$._handledPulse', json_patch(
      COALESCE(json_extract(json, '$._handledPulse'), '{}'),
      json_object(${input.factKey}, ${input.wakeupId})))
    WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
      AND e.wakeup_id = ${input.wakeupId} AND e.state = 'claimed' AND e.tag = 'pulse'
      AND json_extract(e.json, '$.checkIn') IS NOT NULL
      AND EXISTS (SELECT 1 FROM kin_pulse_told t WHERE t.org_id = e.org_id
        AND t.event_id = e.event_id AND t.fact_key = ${input.factKey})
    RETURNING event_id`;
});

export const settleCheckInTold = Effect.fn("KinPulse.settleCheckInTold")(function* <E>(input: {
  readonly orgId: KinOrgId;
  readonly wakeupId: KinWakeupId;
  readonly chatId: KinChatId;
  readonly completed: boolean;
  readonly readFacts: (
    keys: ReadonlySet<string>,
  ) => Effect.Effect<ReadonlyArray<KinPulseFact>, E, SqlClient.SqlClient>;
}) {
  const { orgId, wakeupId, chatId } = input;
  const sql = yield* SqlClient.SqlClient;
  const offered = yield* sql<{ key: string; handled: number }>`SELECT DISTINCT t.fact_key AS key,
      EXISTS (SELECT 1 FROM json_each(e.json, '$._handledPulse')
        WHERE key = t.fact_key AND value = ${wakeupId}) AS handled
    FROM kin_events e JOIN kin_pulse_told t ON t.org_id = e.org_id AND t.event_id = e.event_id
    WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId} AND e.tag = 'pulse'
      AND json_extract(e.json, '$.checkIn') IS NOT NULL
    ORDER BY t.fact_key`;
  if (offered.length === 0) return;
  const texts = yield* sql<{ text: string; automated: number }>`WITH posts AS (
      SELECT m.message_id, m.widget_id, m.body,
        (COALESCE(m.client_message_id, '') GLOB '*kin-page:' || w.wakeup_id
          OR COALESCE(m.client_message_id, '') GLOB '*kin-money:' || w.wakeup_id) AS automated
      FROM kin_wakeups w JOIN kin_messages m ON m.org_id = w.org_id AND m.author_agent_id = w.agent_id
      WHERE w.org_id = ${orgId} AND w.wakeup_id = ${wakeupId}
        AND m.chat_id = ${chatId} AND m.author_kind = 'agent' AND m.status = 'posted'
        AND (m.source_wakeup_id = w.wakeup_id OR
          (m.source_wakeup_id IS NULL AND m.author_thread_id = w.thread_id
            AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch')
            AND (w.ended_at IS NULL OR
              m.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', w.ended_at / 1000.0, 'unixepoch'))))
        AND COALESCE(m.client_message_id, '') NOT GLOB '*kin-week:' || w.wakeup_id || ':*'
      ) SELECT body AS text, automated FROM posts WHERE trim(body) <> ''
      UNION ALL
      SELECT part.value AS text, p.automated FROM posts p JOIN kin_widgets g
        ON g.org_id = ${orgId} AND g.chat_id = ${chatId}
        AND (g.message_id = p.message_id OR g.widget_id = p.widget_id)
      CROSS JOIN json_tree(g.state_json) part WHERE part.type = 'text' AND trim(part.value) <> ''
      UNION ALL
      SELECT json_extract(name.value, '$.key') AS text, p.automated FROM posts p JOIN kin_message_names n
        ON n.org_id = ${orgId} AND n.message_id = p.message_id
      CROSS JOIN json_each(n.names_json) name
      ORDER BY text`;
  const said = texts.filter((post) => !post.automated);
  if (said.length === 0 && !input.completed) return;
  const keys = new Set(offered.map((row) => row.key));
  const named = new Set<string>();
  if (texts.length > 0) {
    const spoken = said.map(({ text }) => text.toLowerCase()).join("\n");
    for (const fact of yield* input.readFacts(keys)) {
      const key = RegExp.escape(fact.subject.key.toLowerCase());
      const mentioned = new RegExp(`(?<![\\p{L}\\p{N}_])${key}(?![\\p{L}\\p{N}_])`, "u");
      const title = fact.subject.title.trim().toLowerCase();
      const client = fact.scope.clientTitle?.trim().toLowerCase();
      if (
        mentioned.test(spoken) ||
        (title.length >= 4 && spoken.includes(title)) ||
        (client && spoken.includes(client)) ||
        (fact.key === UNREADABLE_BANK_ALERTS_KEY &&
          texts.some(
            ({ automated, text }) =>
              automated && text.includes(`${fact.subject.title}. ${fact.consequence}`),
          ))
      )
        named.add(fact.key);
    }
  }
  const handled =
    said.length > 0
      ? offered.filter((row) => row.handled === 1 && !named.has(row.key)).map((row) => row.key)
      : [];
  const kept = new Set([...named, ...handled]);
  const omitted = [...keys].filter((key) => !kept.has(key));
  const rows = sql`org_id = ${orgId} AND event_id IN (
    SELECT e.event_id FROM kin_events e WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId}
      AND e.tag = 'pulse' AND json_extract(e.json, '$.checkIn') IS NOT NULL)`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (omitted.length > 0)
        yield* sql`DELETE FROM kin_pulse_told WHERE ${rows} AND fact_key IN ${sql.in(omitted)}`;
      // A fact taken in hand is news again when its hold expires, unless it was also named.
      if (handled.length > 0)
        yield* sql`UPDATE kin_pulse_told SET sig = 'handled:' || sig WHERE ${rows}
        AND fact_key IN ${sql.in(handled)} AND sig NOT GLOB 'handled:*'`;
    }),
  );
});
