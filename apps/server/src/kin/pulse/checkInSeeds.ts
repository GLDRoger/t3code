import { KinAgentId, KinChatId, KinMemoryItemId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { ownerZone } from "../work/recordRows.ts";

const WEEKDAYS = [1, 2, 3, 4, 5];
/** The check-ins every company starts with, in the owner's time; he moves or removes them in chat. */
export const CHECK_IN_SEEDS = [
  {
    slug: "morning",
    title: "Morning check-in",
    at: "09:30",
    days: WEEKDAYS,
    what: "Morning check-in: look over what needs attention and what came in since the last check-in, and move what you can.",
  },
  {
    slug: "afternoon",
    title: "Afternoon check-in",
    at: "15:30",
    days: WEEKDAYS,
    what: "Afternoon check-in: look over what needs attention and what came in since the last check-in, and move what you can.",
  },
  {
    slug: "weekly",
    title: "Weekly brief",
    at: "09:00",
    days: [1],
    what: "Weekly brief: in one short message, tell the owner what slipped last week, what is due this week and what needs his decision.",
  },
] as const;

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

/**
 * Writes the default check-ins once per company, for the Chief of staff, once it has one. A
 * company that removed them doesn't get them back: the seed row stays.
 */
export const seedCheckIns = Effect.fn("KinPulse.seedCheckIns")(function* (
  orgId: KinOrgId,
  schedules: KinSchedules.KinSchedules["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const [done] = yield* sql`SELECT 1 FROM kin_pulse_seeds
    WHERE org_id = ${orgId} AND seed = 'check-ins'`;
  if (done !== undefined) return false;
  const chief = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  if (chief === undefined) return false;
  const [owner] = yield* sql<{ personId: string }>`SELECT owner_person_id AS "personId"
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${chief.agentId}`;
  if (owner === undefined) return false;
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(orgId);
  for (const seed of CHECK_IN_SEEDS)
    yield* schedules.save({
      orgId,
      agentId: KinAgentId.make(chief.agentId),
      scheduleId: KinMemoryItemId.make(`checkin-${seed.slug}`),
      existing: false,
      chatId: KinChatId.make(chief.ownerChatId),
      sourceEvent: `kin-seed:check-ins:${orgId}`,
      saidBy: owner.personId,
      title: seed.title,
      prompt: seed.what,
      every: onHostClock(seed.at, seed.days, zone, KinSchedules.hostTimeZone(), now),
      around: true,
      checkIn: true,
      now,
    });
  yield* sql`INSERT INTO kin_pulse_seeds (org_id, seed, seeded_at)
    VALUES (${orgId}, 'check-ins', ${now}) ON CONFLICT (org_id, seed) DO NOTHING`;
  return true;
});
