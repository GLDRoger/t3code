import { KinAgentId, KinChatId, KinMemoryItemId, type KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { onHostClock } from "../pulse/checkInSeeds.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { ownerLevelNumbers } from "./KinNumbers.ts";
import {
  decodeNumbersChange,
  FEED_EVENT,
  FEED_SCHEDULE,
  feedSchedules,
  liveFeeds,
  NUMBERS_CHANGE,
} from "./numberRows.ts";
import { feedTurnText } from "./words.ts";

const daysOf = (every: "day" | "week" | "month") =>
  every === "week" ? [1] : [0, 1, 2, 3, 4, 5, 6];

/** The day a feed's run records: yesterday, or for a monthly one the last day of last month. */
const periodOf = (today: string, every: "day" | "week" | "month") => {
  const day = DateTime.makeUnsafe(today);
  return DateTime.formatIsoDateUtc(
    every === "month"
      ? DateTime.subtract(DateTime.startOf(day, "month"), { days: 1 })
      : DateTime.subtract(day, { days: 1 }),
  );
};

/**
 * What a feed's run asks of its keeper now: the numbers it keeps from that source still without a
 * value for the period. Undefined when there is nothing to fetch, or the feed is gone.
 */
export const feedTurn = Effect.fn("KinNumbers.feedTurn")(function* (
  orgId: KinOrgId,
  scheduleId: string,
  now: number,
) {
  const feed = (yield* liveFeeds(orgId)).find((one) => one.scheduleId === scheduleId);
  if (feed === undefined) return undefined;
  const period = periodOf(dayIn(now, yield* ownerZone(orgId)), feed.feed.every);
  const due = (yield* ownerLevelNumbers(orgId, now, { recordedOnly: true })).filter(
    (number) =>
      number.keeper === feed.agentId &&
      number.definedSource === feed.feed.source &&
      (number.asOf === null || number.asOf < period),
  );
  if (due.length === 0) return undefined;
  return {
    text: feedTurnText(due, feed.feed.source, period),
    ...(feed.feed.how === undefined ? {} : { how: feed.feed.how }),
  };
});

/**
 * Makes the schedule of each confirmed card's feed, once: one per source, in the owner's direct
 * chat with the keeper. Run by the scheduled-tasks pass, which holds the schedules service.
 */
export const makeFeeds = Effect.fn("KinNumbers.makeFeeds")(function* (
  orgId: KinOrgId,
  schedules: KinSchedules.KinSchedules["Service"],
) {
  const sql = yield* SqlClient.SqlClient;
  const pending = yield* sql<{ changeId: string; agentId: string; patch: string }>`
    SELECT change_id AS "changeId", agent_id AS "agentId", patch_json AS patch
    FROM kin_profile_changes
    WHERE org_id = ${orgId} AND substr(change_id, 1, 3) = ${NUMBERS_CHANGE}
      AND applied_at IS NOT NULL AND json_extract(patch_json, '$.feed') IS NOT NULL
      AND json_extract(patch_json, '$.feedMadeAt') IS NULL
    ORDER BY applied_at, change_id`;
  for (const row of pending) {
    const change = yield* decodeNumbersChange(row.patch).pipe(Effect.orDie);
    const now = yield* Clock.currentTimeMillis;
    const done = sql`UPDATE kin_profile_changes
      SET patch_json = json_set(patch_json, '$.feedMadeAt', ${now})
      WHERE org_id = ${orgId} AND change_id = ${row.changeId}`;
    const [lead] = yield* sql<{ chatId: string }>`SELECT l.owner_chat_id AS "chatId"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND l.agent_id = ${row.agentId} AND a.retired_at IS NULL
      ORDER BY l.agent_id`;
    const feed = change.feed;
    if (feed === undefined || lead === undefined || change.by === undefined) {
      yield* Effect.logWarning("Kin numbers feed has no agent to run it", { orgId });
      yield* done;
      continue;
    }
    // Every schedule of the source, paused ones too: the first is saved in place, for this
    // keeper and running again; any other goes after, so there is never none and never two.
    const [kept, ...others] = (yield* feedSchedules(orgId)).filter(
      (one) => one.feed.source === feed.source,
    );
    const ownerTime = { at: feed.at, days: daysOf(feed.every) };
    yield* schedules.save({
      orgId,
      agentId: KinAgentId.make(row.agentId),
      scheduleId: KinMemoryItemId.make(
        kept?.scheduleId ?? `${FEED_SCHEDULE}${row.changeId.slice(NUMBERS_CHANGE.length)}`,
      ),
      existing: kept !== undefined,
      chatId: KinChatId.make(lead.chatId),
      sourceEvent: `${FEED_EVENT}${row.changeId}`,
      saidBy: change.by,
      title: `Numbers from ${feed.source}`.slice(0, 120),
      prompt: feed.how ?? feed.source,
      every: onHostClock(
        ownerTime.at,
        ownerTime.days,
        yield* ownerZone(orgId),
        KinSchedules.hostTimeZone(),
        now,
      ),
      ownerTime,
      resume: true,
      now,
    });
    for (const other of others) yield* schedules.cancel(orgId, other.scheduleId);
    yield* done;
  }
});
