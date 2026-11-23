import { KinAgentId, KinChatId, KinMemoryItemId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { ownerZone } from "../work/recordRows.ts";

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
/**
 * The check-ins every company starts with, in the owner's time; he moves or removes them in chat
 * or Settings. `seed` marks a batch written once per company: one added later gets its own.
 */
const CHECK_IN_SEEDS = [
  {
    seed: "check-ins",
    slug: "morning",
    title: "Morning check-in",
    at: "09:30",
    days: EVERY_DAY,
    what: "Morning check-in: look over what needs attention and what came in since the last check-in, and move what you can.",
  },
  {
    seed: "check-ins",
    slug: "afternoon",
    title: "Afternoon check-in",
    at: "15:30",
    days: WEEKDAYS,
    what: "Afternoon check-in: look over what needs attention and what came in since the last check-in, and move what you can.",
  },
  {
    seed: "check-ins",
    slug: "weekly",
    title: "Weekly brief",
    at: "09:00",
    days: [1],
    what: "Weekly brief: in one short message, tell the owner what slipped last week, what is due this week and what needs his decision.",
  },
  {
    seed: "check-in-evening",
    slug: "evening",
    title: "Evening summary",
    at: "18:30",
    days: WEEKDAYS,
    what: "Evening summary: tell the owner what got done today, what moved and what is still open and carries to tomorrow.",
  },
] as const;

/** The seeded check-ins a person sets in Settings as their briefs, by `checkin-<slug>`. */
export const BRIEF_SLUGS = ["morning", "afternoon", "evening"] as const;
export type BriefSlug = (typeof BRIEF_SLUGS)[number];

const offsetMinutes = (zone: string, at: number) =>
  DateTime.zonedOffset(DateTime.makeZonedUnsafe(at, { timeZone: zone })) / 60_000;

/** An owner-time slot on the host's clock, which native tasks run on; days move across midnight. */
export const onHostClock = (
  at: string,
  days: ReadonlyArray<number>,
  ownerZoneId: string,
  hostZone: string,
  now: number,
) => {
  const [hours, minutes] = at.split(":").map(Number);
  const shifted =
    hours! * 60 + minutes! + offsetMinutes(hostZone, now) - offsetMinutes(ownerZoneId, now);
  const dayShift = Math.floor(shifted / 1440);
  const inDay = ((shifted % 1440) + 1440) % 1440;
  return {
    at: `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`,
    days: days.map((day) => (((day + dayShift) % 7) + 7) % 7).toSorted((a, b) => a - b),
  };
};

const seedSource = (orgId: KinOrgId) => `kin-seed:check-ins:${orgId}`;
/** Days an earlier build seeded a default on: a row still on them was never given its own. */
const EARLIER_DAYS: Partial<Record<string, ReadonlyArray<number>>> = { morning: WEEKDAYS };
const minutesOf = (at: string) => Number(at.slice(0, 2)) * 60 + Number(at.slice(3));
/**
 * The host days a default could have been put on, as its stored host time says: each shift from
 * `seedAt` to `hostAt` a real zone could make on this host (UTC-12 to UTC+14, an hour's slack for
 * a clock change since) moves the days across midnight with it.
 */
const daysAt = (
  seedAt: string,
  days: ReadonlyArray<number>,
  hostAt: string,
  hostOffset: number,
) => {
  const moved = (((minutesOf(hostAt) - minutesOf(seedAt)) % 1440) + 1440) % 1440;
  return [moved - 1440, moved, moved + 1440]
    .filter((shift) => shift >= hostOffset - 15 * 60 && shift <= hostOffset + 13 * 60)
    .map((shift) => {
      const by = Math.floor((minutesOf(seedAt) + shift) / 1440);
      return days
        .map((day) => (((day + by) % 7) + 7) % 7)
        .toSorted((a, b) => a - b)
        .join();
    });
};

/**
 * Keeps each default check-in the owner hasn't moved at its time in his zone as it is now: set
 * after seeding, changed, or across a clock change, and one set in Settings at the time he set.
 * One moved in chat or on T3's screen stays put: a default's days must be exactly as Kin put
 * them, for this host and zone or by its own host time; a Settings one's, as Kin last wrote.
 */
export const followOwnerZone = Effect.fn("KinPulse.followOwnerZone")(function* (
  orgId: KinOrgId,
  schedules: KinSchedules.KinSchedules["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  const host = KinSchedules.hostTimeZone();
  for (const seed of CHECK_IN_SEEDS) {
    const row = yield* KinSchedules.readSchedule(sql, orgId, `checkin-${seed.slug}`);
    if (row === undefined || row.deletedAt !== null || row.sourceEvent !== seedSource(orgId))
      continue;
    const task = yield* KinSchedules.readNativeTask(sql, row.taskId);
    if (task === undefined || row.looseAt === null) continue;
    const current = KinSchedules.everyOf(task, row.looseAt);
    if (current === undefined || current.at !== row.looseAt) continue;
    const seeded = [seed.days, EARLIER_DAYS[seed.slug] ?? seed.days].flatMap((days) => [
      onHostClock(seed.at, days, zone, host, now).days.join(),
      ...daysAt(seed.at, days, current.at, offsetMinutes(host, now)),
    ]);
    if (!seeded.includes(current.days.join())) continue;
    const every = onHostClock(seed.at, seed.days, zone, host, now);
    if (every.at === current.at && every.days.join() === current.days.join()) continue;
    yield* schedules.save({
      orgId,
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      existing: true,
      chatId: row.chatId,
      sourceEvent: row.sourceEvent,
      saidBy: row.saidBy,
      title: task.title,
      prompt: task.prompt,
      every,
      around: true,
      checkIn: true,
      keepWording: true,
      now,
    });
  }
  for (const row of yield* KinSchedules.listSchedules(sql, orgId)) {
    const owner =
      row.ownerTime === null
        ? undefined
        : Option.getOrUndefined(KinSchedules.decodeOwnerTime(row.ownerTime));
    if (owner === undefined || row.deletedAt !== null) continue;
    const task = yield* KinSchedules.readNativeTask(sql, row.taskId);
    const current = task === undefined ? undefined : KinSchedules.everyOf(task, row.looseAt);
    if (task === undefined || current === undefined) continue;
    if (current.at !== owner.host.at || current.days.join() !== owner.host.days.join()) continue;
    const every = onHostClock(owner.at, owner.days, zone, host, now);
    if (every.at === current.at && every.days.join() === current.days.join()) continue;
    yield* schedules.save({
      orgId,
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      existing: true,
      chatId: row.chatId,
      sourceEvent: row.sourceEvent,
      saidBy: row.saidBy,
      title: task.title,
      prompt: task.prompt,
      every,
      ownerTime: { at: owner.at, days: owner.days },
      around: KinSchedules.isAround(task, row.looseAt),
      checkIn: row.checkIn === 1,
      keepWording: true,
      now,
    });
  }
});

/**
 * Writes the default check-ins once per company, for the Chief of staff, once it has one; true
 * once every batch is written, now or before. A company that removed them doesn't get them back.
 */
export const seedCheckIns = Effect.fn("KinPulse.seedCheckIns")(function* (
  orgId: KinOrgId,
  schedules: KinSchedules.KinSchedules["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const done = new Set(
    (yield* sql<{ seed: string }>`SELECT seed FROM kin_pulse_seeds
      WHERE org_id = ${orgId} ORDER BY seed`).map((row) => row.seed),
  );
  const due = CHECK_IN_SEEDS.filter((seed) => !done.has(seed.seed));
  if (due.length === 0) return true;
  const chief = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  if (chief === undefined) return false;
  const [owner] = yield* sql<{ personId: string }>`SELECT owner_person_id AS "personId"
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${chief.agentId}`;
  if (owner === undefined) return false;
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  for (const seed of due)
    yield* schedules.save({
      orgId,
      agentId: KinAgentId.make(chief.agentId),
      scheduleId: KinMemoryItemId.make(`checkin-${seed.slug}`),
      existing: false,
      chatId: KinChatId.make(chief.ownerChatId),
      sourceEvent: seedSource(orgId),
      saidBy: owner.personId,
      title: seed.title,
      prompt: seed.what,
      every: onHostClock(seed.at, seed.days, zone, KinSchedules.hostTimeZone(), now),
      around: true,
      checkIn: true,
      now,
    });
  for (const seed of new Set(due.map((one) => one.seed)))
    yield* sql`INSERT INTO kin_pulse_seeds (org_id, seed, seeded_at)
      VALUES (${orgId}, ${seed}, ${now}) ON CONFLICT (org_id, seed) DO NOTHING`;
  return true;
});
