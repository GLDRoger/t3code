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
  everyOf,
  LOOSE_AFTER_MINUTES,
  LOOSE_BEFORE_MINUTES,
  looseSpanMinutes,
  looseWindowStartAt,
  readNativeTask,
  readSchedule,
  timeOnDayOf,
} from "../triggers/kinSchedules.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import { matchLines, type OutsideRead } from "./outside.ts";
import { markTold, toldBy, untold } from "./told.ts";
import { agentQuietUntil } from "../triggers/quietHold.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
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

const MORNING = "checkin-morning";
const WEEKLY = "checkin-weekly";
const EVENING = "checkin-evening";
/** The briefs: not skipped for a quiet pulse. The evening one has its own facts (`scheduledTasks`). */
const BRIEFS: ReadonlySet<string> = new Set([MORNING, WEEKLY, EVENING]);

/**
 * Whether the weekly brief is set to come on the company's day `day`, near `at`. Its days are the
 * host's, so its slot on the host day before or after may be the one that lands on `day`.
 */
const weeklyDue = Effect.fn("KinPulse.weeklyDue")(function* (
  orgId: KinOrgId,
  day: string,
  at: number,
  zones: { readonly host: string; readonly company: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* readSchedule(sql, orgId, WEEKLY);
  if (row === undefined || row.deletedAt !== null || row.checkIn !== 1) return false;
  const task = yield* readNativeTask(sql, row.taskId);
  if (task === undefined || (row.pendingEnabled ?? task.enabled) !== 1) return false;
  const every = everyOf(task, row.looseAt);
  if (every === undefined) return false;
  return [-1, 0, 1].some((by) => {
    const slot = timeOnDayOf(at + by * DAY, zones.host, every.at);
    const weekDay = DateTime.toParts(
      DateTime.makeZonedUnsafe(slot, { timeZone: zones.host }),
    ).weekDay;
    return every.days.includes(weekDay) && dayIn(slot, zones.company) === day;
  });
});

/** A pulse event of this check-in on the company's day `day`, as the fold reads one. */
const briefOn = (sql: SqlClient.SqlClient, orgId: KinOrgId, scheduleId: string, day: string) =>
  sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
    AND json_extract(json, '$.checkIn.scheduleId') = ${scheduleId} AND state != 'failed'
    AND json_extract(json, '$.checkIn.day') = ${day}
    AND (${scheduleId} = ${WEEKLY} OR json_extract(json, '$.checkIn.figures') = 1)
    ORDER BY event_id LIMIT 1`;

/**
 * Which brief covers this morning or weekly brief today in the company's zone: set for today, its
 * slot passed, it sent nothing of its own and the other one came (the fold in `queueCheckIn`).
 */
export const coveredToday = Effect.fn("KinPulse.coveredToday")(function* (input: {
  readonly orgId: KinOrgId;
  readonly scheduleId: string;
  /** Its days on the company's clock. */
  readonly days: ReadonlyArray<number>;
  readonly on: boolean;
  readonly nextRunAt: string | null;
  readonly zone: string;
  readonly now: number;
}) {
  const { orgId, zone, now } = input;
  if (!input.on || (input.scheduleId !== MORNING && input.scheduleId !== WEEKLY)) return undefined;
  const day = dayIn(now, zone);
  const weekDay = DateTime.toParts(DateTime.makeZonedUnsafe(now, { timeZone: zone })).weekDay;
  const next = input.nextRunAt === null ? Number.NaN : Date.parse(input.nextRunAt);
  if (!input.days.includes(weekDay) || !(next > now) || dayIn(next, zone) <= day) return undefined;
  const sql = yield* SqlClient.SqlClient;
  // Its own event: with or without figures, a brief it sent today.
  const [own] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
    AND json_extract(json, '$.checkIn.scheduleId') = ${input.scheduleId} AND state != 'failed'
    AND json_extract(json, '$.checkIn.day') = ${day} ORDER BY event_id LIMIT 1`;
  if (own !== undefined) return undefined;
  const other = input.scheduleId === MORNING ? WEEKLY : MORNING;
  const [first] = yield* briefOn(sql, orgId, other, day);
  return first === undefined
    ? undefined
    : other === WEEKLY
      ? ("weekly" as const)
      : ("morning" as const);
});

/**
 * One check-in at the slot's minute: what the owner hasn't been told and what is new outside.
 * With nothing untold no model runs, except for a brief; Run now tells every open fact. `slot`,
 * the host day, keys the event; `day`, the company's, is what the fold and the evening go by.
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
  /** The host's zone, which native slots are in. */
  readonly zone: string;
  readonly at: number;
  readonly outside: OutsideRead;
}) {
  const queue = yield* KinEventQueue.KinEventQueue;
  const { orgId, at } = input;
  // Only open facts: one in hand or set aside is not news, and comes back as news when it ends.
  const read = yield* KinPulse.read({ orgId, at, viewer: { _tag: "owner" }, limit: 200 });
  const facts = read.facts;
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
  const company = yield* ownerZone(orgId);
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
  const day = input.manualId === undefined ? dayIn(minute ?? at, company) : undefined;
  const page = day !== undefined && (input.scheduleId === MORNING || input.scheduleId === WEEKLY);
  if (page) {
    const other = input.scheduleId === MORNING ? WEEKLY : MORNING;
    const [first] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId} AND tag = 'pulse'
      AND json_extract(json, '$.checkIn.scheduleId') = ${other} AND state != 'failed'
      AND (json_extract(json, '$.checkIn.day') = ${day}
        OR (json_extract(json, '$.checkIn.day') IS NULL AND dedupe_key = ${`checkin:${other}:${slot}`}))
      AND (${other} = ${WEEKLY} OR json_extract(json, '$.checkIn.figures') = 1)
      ORDER BY event_id LIMIT 1`;
    if (first !== undefined) return { _tag: "folded", into: other } as const;
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
  const told = { orgId, personId: agent.owner, at, zone: company };
  const tell = input.manualId !== undefined ? facts : yield* untold({ ...told, facts });
  if (!brief && tell.length === 0 && lines.length === 0) return { _tag: "nothing_new" } as const;
  // Nobody asked for it: one that lands in the owner's quiet hours waits for them to end.
  const quietUntil =
    input.manualId === undefined
      ? yield* agentQuietUntil(orgId, input.agentId, minute ?? at)
      : undefined;
  const notBefore = quietUntil ?? minute;
  // The evening summary sums up its own day; held past it, it isn't sent.
  if (
    input.scheduleId === EVENING &&
    day !== undefined &&
    notBefore !== undefined &&
    dayIn(notBefore, company) !== day
  )
    return { _tag: "past_its_day" } as const;
  const figures =
    input.scheduleId === WEEKLY ||
    (input.scheduleId === MORNING &&
      day !== undefined &&
      (yield* weeklyDue(orgId, day, minute ?? at, { host: input.zone, company })));
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
            ...(figures ? { figures: true } : {}),
            ...(day === undefined ? {} : { day }),
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
