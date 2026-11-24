import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  type KinAgentId,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { relayPrefix } from "../reply/promises.ts";
import { ownerZone } from "../work/recordRows.ts";
import { DAY_MS } from "./thresholds.ts";

/**
 * A relay left for its person's next check-in instead of sent (`kin_relay` with checkIn): a held
 * line (`kin_held_posts`) that the check-in reserves in its told ledger, is given to tell, and
 * closes once it posted. Untold a day after the check-in it waited for, it posts as the relay.
 */

/** The told key a check-in reserves a left line by. */
const LEFT = "left:";
export const isLeftKey = (key: string) => key.startsWith(LEFT);
const holdOf = (key: string) => key.slice(LEFT.length);

/** The held kind of a relay left for a check-in, so it still counts as this turn's relay. */
export const leftKind = (wakeupId: string, hash: string) =>
  `${relayPrefix(wakeupId)}checkin-${hash}`;
const LEFT_KIND = "kin-relay:*:checkin-*";

/** Whether a `kin_held_posts` row is reserved by a check-in that is queued, running or ran. */
export const reservedByCheckIn = (sql: SqlClient.SqlClient) =>
  sql`EXISTS (SELECT 1 FROM kin_pulse_told t JOIN kin_events e
    ON e.org_id = t.org_id AND e.event_id = t.event_id
    WHERE t.org_id = kin_held_posts.org_id AND t.fact_key = ${LEFT} || kin_held_posts.hold_id
      AND e.state IN ('queued', 'claimed', 'done'))`;

/** The next run of one of `agentId`'s check-ins that is on, on the owner's clock. */
export const nextCheckIn = Effect.fn("KinLeftForCheckIn.next")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ title: string; at: string }>`SELECT t.title, t.next_run_at AS at
    FROM kin_schedules s JOIN scheduled_tasks t ON t.task_id = s.task_id
    WHERE s.org_id = ${orgId} AND s.agent_id = ${agentId} AND s.check_in = 1
      AND s.deleted_at IS NULL AND COALESCE(s.pending_enabled, t.enabled) = 1
      AND t.next_run_at IS NOT NULL
    ORDER BY t.next_run_at, s.schedule_id LIMIT 1`;
  const at = row === undefined ? Number.NaN : Date.parse(row.at);
  if (row === undefined || !Number.isFinite(at)) return undefined;
  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  return {
    title: row.title,
    when: formatKinWhen(Math.max(at, now), "dayTime", { zone, locale: KIN_TEXT_LOCALE }),
    // The day after it, untold, it is posted as the relay it is.
    fallbackAt: Math.max(at, now) + DAY_MS,
  };
});

/** The lines left with `agentId` for `personId` that no check-in has taken yet. */
export const leftOpen = Effect.fn("KinLeftForCheckIn.open")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ holdId: string }>`SELECT hold_id AS "holdId" FROM kin_held_posts
    WHERE org_id = ${orgId} AND agent_id = ${agentId} AND person_id = ${personId}
      AND delivered_at IS NULL AND kind GLOB ${LEFT_KIND} AND NOT ${reservedByCheckIn(sql)}
    ORDER BY held_at, rowid`;
  return rows.map((row) => row.holdId);
});

/** The check-in `eventId` takes the lines `holdIds` to tell. */
export const reserveLeft = Effect.fn("KinLeftForCheckIn.reserve")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: string;
  readonly eventId: string;
  readonly holdIds: ReadonlyArray<string>;
  readonly at: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  for (const holdId of input.holdIds)
    yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
      VALUES (${input.orgId}, ${input.personId}, ${`${LEFT}${holdId}`}, ${input.eventId},
        'left', ${input.at})
      ON CONFLICT DO NOTHING`;
});

/** What check-in events were given to tell: who left it, what they said, and since when. */
export const leftGiven = Effect.fn("KinLeftForCheckIn.given")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<string>,
) {
  if (eventIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ from: string | null; said: string; heldAt: number }>`SELECT
      json_extract(h.relay_json, '$.personName') AS "from", h.body AS said, h.held_at AS "heldAt"
    FROM kin_pulse_told t JOIN kin_held_posts h
      ON h.org_id = t.org_id AND t.fact_key = ${LEFT} || h.hold_id
    WHERE t.org_id = ${orgId} AND t.event_id IN ${sql.in(eventIds)}
    GROUP BY h.hold_id ORDER BY h.held_at, h.hold_id`;
  if (rows.length === 0) return [];
  const zone = yield* ownerZone(orgId);
  return rows.map((row) => ({
    from: row.from ?? "you",
    said: row.said,
    since: formatKinWhen(row.heldAt, "dayTime", { zone, locale: KIN_TEXT_LOCALE }),
  }));
});

/** Closes the left lines a check-in told (`settleCheckInTold`); its ledger rows stay as the record. */
export const settleLeft = Effect.fn("KinLeftForCheckIn.settle")(function* (input: {
  readonly orgId: KinOrgId;
  readonly keys: ReadonlyArray<string>;
}) {
  const holds = input.keys.filter(isLeftKey).map(holdOf);
  if (holds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_held_posts SET delivered_at = ${yield* Clock.currentTimeMillis}
    WHERE org_id = ${input.orgId} AND hold_id IN ${sql.in(holds)} AND delivered_at IS NULL`;
});
