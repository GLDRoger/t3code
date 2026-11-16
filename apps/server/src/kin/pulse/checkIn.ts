import {
  KinEvent,
  KinEventId,
  type KinAgentId,
  type KinMemoryItemId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as KinEventQueue from "../lead/KinEventQueue.ts";
import {
  LOOSE_AFTER_MINUTES,
  LOOSE_BEFORE_MINUTES,
  looseSpanMinutes,
  looseWindowStartAt,
} from "../triggers/kinSchedules.ts";
import { dayIn } from "../work/money.ts";
import * as KinPulse from "./KinPulse.ts";
import { matchLines, type OutsideRead } from "./outside.ts";

const MINUTE = 60_000;
const sha = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * How far into its window a loose slot fires: fixed per schedule and day, so a restart that
 * works it out again lands on the same minute, and the next day lands elsewhere.
 */
export const looseOffsetMs = (
  scheduleId: string,
  slot: string,
  spanMinutes = LOOSE_BEFORE_MINUTES + LOOSE_AFTER_MINUTES,
) => (Number.parseInt(sha(`${scheduleId}\0${slot}`).slice(0, 8), 16) % (spanMinutes + 1)) * MINUTE;

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const OUTSIDE_CAP = 60;

/**
 * Whether any of `facts` is news since this agent's last check-in: first seen after it, never
 * stored yet, or out of someone's hands since. With none, a check-in would only say "nothing new".
 */
const anyNews = Effect.fn("KinPulse.checkInNews")(function* (
  input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    /** This slot's own event: fired again after a restart, it is not the last one. */
    readonly dedupeKey: string;
    readonly at: number;
  },
  keys: ReadonlyArray<string>,
) {
  const { orgId, agentId, at } = input;
  if (keys.length === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const [last] = yield* sql<{ at: number | null }>`SELECT MAX(received_at) AS at FROM kin_events
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND tag = 'pulse'
      AND dedupe_key LIKE 'checkin:%' AND dedupe_key != ${input.dedupeKey}
      AND state != 'failed'`;
  const since = last?.at ?? null;
  if (since === null) return true;
  const stored = new Map<string, { readonly firstSeenAt: number; readonly until: number | null }>();
  for (let start = 0; start < keys.length; start += 500)
    for (const row of yield* sql<{ key: string; firstSeenAt: number; until: number | null }>`
      SELECT fact_key AS key, first_seen_at AS "firstSeenAt", handled_until AS until
      FROM kin_pulse_facts
      WHERE org_id = ${orgId} AND fact_key IN ${sql.in(keys.slice(start, start + 500))}
      ORDER BY fact_key`)
      stored.set(row.key, row);
  return keys.some((key) => {
    const row = stored.get(key);
    return (
      row === undefined ||
      row.firstSeenAt > since ||
      (row.until !== null && row.until > since && row.until <= at)
    );
  });
});

/**
 * One check-in: the open facts, held ones too, and what is new outside, handed to the agent as
 * one pulse event at the slot's minute. With nothing new since the agent's last check-in, nothing
 * is queued and no model runs; a Run now tap still runs. `slot` keys the event, so one slot
 * queues once however often it is fired.
 */
export const queueCheckIn = Effect.fn("KinPulse.checkIn")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly scheduleId: KinMemoryItemId;
  readonly title: string;
  readonly what: string;
  /** When the native task's run started: the window's start when on time, or a catch-up. */
  readonly dueAt: number;
  /** The time a loose check-in is around ("09:00"); null when it is exact. */
  readonly looseAt: string | null;
  /** A Run now tap: its own slot, at once. */
  readonly manualId?: string | undefined;
  readonly zone: string;
  readonly at: number;
  readonly outside: OutsideRead;
}) {
  const queue = yield* KinEventQueue.KinEventQueue;
  const { orgId, at } = input;
  // A fact someone has in hand is still open: the check-in names it with who holds it and until
  // when (`buildPulseSection`). One marked not a problem has no end and starts none.
  const read = yield* KinPulse.read({
    orgId,
    at,
    viewer: { _tag: "owner" },
    includeHandled: true,
    limit: 200,
  });
  const facts = read.facts.filter((fact) => fact.handled === null || fact.handled.until !== null);
  const matched = yield* matchLines(orgId, input.outside.lines);
  const byId = new Map(matched.map(({ line }) => [`${line.source}\0${line.id}`, line]));
  const lines = input.outside.lines
    .map((line) => byId.get(`${line.source}\0${line.id}`) ?? line)
    .toSorted((a, b) => Number(b.matched !== undefined) - Number(a.matched !== undefined))
    .slice(0, OUTSIDE_CAP);
  if (facts.length === 0 && lines.length === 0) return { _tag: "nothing_new" } as const;
  const slot = input.manualId ?? dayIn(input.dueAt, input.zone);
  const dedupeKey = `checkin:${input.scheduleId}:${slot}`;
  const news =
    input.manualId !== undefined ||
    (yield* anyNews(
      { orgId, agentId: input.agentId, dedupeKey, at },
      facts.map((fact) => fact.key),
    ));
  if (!news && lines.length === 0) return { _tag: "nothing_new" } as const;
  // The minute is picked in the window as it stands that day, never from a late start: a run
  // that starts after its minute fires at once.
  const notBefore =
    input.looseAt !== null && input.manualId === undefined
      ? Math.max(
          at,
          looseWindowStartAt(input.dueAt, input.zone, input.looseAt) +
            looseOffsetMs(input.scheduleId, slot, looseSpanMinutes(input.looseAt)),
        )
      : undefined;
  const queued = yield* queue
    .enqueue(
      yield* decodeEvent({
        _tag: "pulse",
        orgId,
        eventId: KinEventId.make(`pulse-${sha(`${orgId}\0${dedupeKey}`).slice(0, 32)}`),
        agentId: input.agentId,
        receivedAt: DateTime.formatIso(DateTime.makeUnsafe(at)),
        dedupeKey,
        provenance: { _tag: "system" },
        factKeys: [],
        checkIn: {
          scheduleId: input.scheduleId,
          title: input.title.slice(0, 200),
          what: input.what.slice(0, 2000),
          slot: slot.slice(0, 200),
        },
        ...(lines.length === 0 ? {} : { outside: lines }),
        // A check-in or brief is judgement whatever an earlier one already told: the main model.
        strong: true,
      }),
      notBefore === undefined ? undefined : { notBefore },
    )
    .pipe(
      Effect.map((result) => (result.duplicate ? "duplicate" : "queued")),
      Effect.catchTags({
        KinEventQueueUnknownAgent: () => Effect.succeed("no_agent" as const),
        KinEventQueueRetiredAgent: () => Effect.succeed("no_agent" as const),
      }),
    );
  return {
    _tag: queued,
    facts: facts.length,
    outside: lines.length,
    notBefore: notBefore ?? at,
  } as const;
});
