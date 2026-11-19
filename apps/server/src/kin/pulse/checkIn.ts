import {
  KinEvent,
  KinEventId,
  type KinAgentId,
  type KinPersonId,
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
import { ownerZone } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import { matchLines, type OutsideRead } from "./outside.ts";
import { markTold, toldBy, untold } from "./told.ts";
import { agentQuietUntil } from "../triggers/quietHold.ts";

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

/** The seeded check-in the weekly brief stands in for on its day. */
const MORNING = "checkin-morning";
const WEEKLY = "checkin-weekly";
/** The briefs: sent at their time on a quiet day too, unlike a check-in with nothing to tell. */
const BRIEFS: ReadonlySet<string> = new Set([MORNING, WEEKLY, "checkin-evening"]);

/**
 * One check-in at the slot's minute: what the owner hasn't been told and what is new outside.
 * With nothing untold no model runs, except for a brief; Run now tells every open fact. On a
 * weekly brief's day the morning check-in is the brief. `slot` keys the event, so a slot queues once.
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
  const brief = BRIEFS.has(input.scheduleId);
  if (!brief && facts.length === 0 && lines.length === 0) return { _tag: "nothing_new" } as const;
  const slot = input.manualId ?? dayIn(input.dueAt, input.zone);
  const dedupeKey = `checkin:${input.scheduleId}:${slot}`;
  const eventId = KinEventId.make(`pulse-${sha(`${orgId}\0${dedupeKey}`).slice(0, 32)}`);
  const sql = yield* SqlClient.SqlClient;
  if (input.manualId === undefined && input.scheduleId === MORNING) {
    const [weekly] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
      AND dedupe_key = ${`checkin:${WEEKLY}:${slot}`} AND state != 'failed' LIMIT 1`;
    if (weekly !== undefined) return { _tag: "folded" } as const;
  }
  // The same slot fired again, as after a restart: its stored event and minute stand.
  const [stored] = yield* sql<{ notBefore: number | null; queuedAt: number }>`
    SELECT not_before AS "notBefore", queued_at AS "queuedAt" FROM kin_events
    WHERE org_id = ${orgId} AND event_id = ${eventId}`;
  if (stored !== undefined)
    return {
      _tag: "duplicate",
      facts: (yield* toldBy(orgId, [eventId])).size,
      outside: lines.length,
      notBefore: stored.notBefore ?? stored.queuedAt,
    } as const;
  const [agent] = yield* sql<{ owner: KinPersonId }>`SELECT owner_person_id AS owner
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${input.agentId}`;
  if (agent === undefined) return { _tag: "nothing_new" } as const;
  const told = { orgId, personId: agent.owner, at, zone: yield* ownerZone(orgId) };
  const tell = input.manualId !== undefined ? facts : yield* untold({ ...told, facts });
  if (!brief && tell.length === 0 && lines.length === 0) return { _tag: "nothing_new" } as const;
  // The minute is picked in the window as it stands that day, never from a late start: a run
  // that starts after its minute fires at once.
  const minute =
    input.looseAt !== null && input.manualId === undefined
      ? Math.max(
          at,
          looseWindowStartAt(input.dueAt, input.zone, input.looseAt) +
            looseOffsetMs(input.scheduleId, slot, looseSpanMinutes(input.looseAt)),
        )
      : undefined;
  // Nobody asked for it: one that lands in the owner's quiet hours waits for them to end.
  const quietUntil =
    input.manualId === undefined
      ? yield* agentQuietUntil(orgId, input.agentId, minute ?? at)
      : undefined;
  const notBefore = quietUntil ?? minute;
  const queued = yield* sql.withTransaction(
    queue
      .enqueue(
        yield* decodeEvent({
          _tag: "pulse",
          orgId,
          eventId,
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
        }),
        notBefore === undefined ? undefined : { notBefore },
      )
      .pipe(
        Effect.tap((result) =>
          result.duplicate ? Effect.void : markTold({ ...told, eventId, facts: tell }),
        ),
        Effect.map((result) => (result.duplicate ? "duplicate" : "queued")),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed("no_agent" as const),
          KinEventQueueRetiredAgent: () => Effect.succeed("no_agent" as const),
        }),
      ),
  );
  return {
    _tag: queued,
    facts: tell.length,
    outside: lines.length,
    notBefore: notBefore ?? at,
  } as const;
});
