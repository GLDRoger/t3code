import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMemoryItemId,
  type KinCheckInActInput,
  type KinCheckInSaveInput,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import * as KinSchedules from "../triggers/kinSchedules.ts";
import { theOwner } from "../work/ownerWork.ts";
import { ownerZone } from "../work/recordRows.ts";
import { onHostClock } from "./checkInSeeds.ts";

/**
 * Check-ins as Kin Settings shows them, in the owner's time. Run now, off, on and remove are taps
 * the schedules' next pass applies, as a card's are; a new time or a new check-in saves the task now.
 */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const unread = <A, R>(self: Effect.Effect<A, KinChatError | SqlError.SqlError, R>) =>
  Effect.mapError(self, (error) =>
    error._tag === "SqlError"
      ? new KinChatError({ reason: "unavailable", message: "Check-ins are unavailable." })
      : error,
  );

const leadsOf = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql<{ agentId: string; name: string; chatId: string }>`SELECT l.agent_id AS "agentId",
      l.name, l.owner_chat_id AS "chatId"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY a.created_at, l.agent_id`;

const read = Effect.fn("KinCheckIns.read")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  const host = KinSchedules.hostTimeZone();
  const leads = yield* leadsOf(sql, orgId);
  const rows = yield* KinSchedules.listSchedules(sql, orgId);
  const checkIns = [];
  for (const row of rows) {
    if (row.checkIn !== 1 || row.deletedAt !== null) continue;
    const task = yield* KinSchedules.readNativeTask(sql, row.taskId);
    const every = task === undefined ? undefined : KinSchedules.everyOf(task, row.looseAt);
    if (task === undefined || every === undefined) continue;
    const own = onHostClock(every.at, every.days, host, zone, now);
    checkIns.push({
      scheduleId: row.scheduleId,
      title: task.title,
      what: task.prompt,
      agentId: row.agentId,
      agentName: leads.find((lead) => lead.agentId === row.agentId)?.name ?? "A retired agent",
      at: own.at,
      days: own.days,
      on: (row.pendingEnabled ?? task.enabled) === 1,
      runNowPending: row.runNowAt !== null,
    });
  }
  return {
    zone,
    checkIns: checkIns.toSorted((a, b) => a.at.localeCompare(b.at)),
    agents: leads.map((lead) => ({ agentId: KinAgentId.make(lead.agentId), name: lead.name })),
  };
});

export const list = Effect.fn("KinCheckIns.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  orgId: KinOrgId,
) {
  yield* theOwner(people, orgId);
  return yield* read(orgId);
}, unread);

export const save = Effect.fn("KinCheckIns.save")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinCheckInSaveInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const schedules = yield* KinSchedules.KinSchedules;
  const now = yield* Clock.currentTimeMillis;
  const zone = yield* ownerZone(input.orgId);
  const every = onHostClock(input.at, input.days, zone, KinSchedules.hostTimeZone(), now);
  const existing =
    input.scheduleId === undefined
      ? undefined
      : yield* KinSchedules.readSchedule(sql, input.orgId, input.scheduleId);
  if (input.scheduleId !== undefined) {
    if (existing === undefined || existing.deletedAt !== null || existing.checkIn !== 1)
      return yield* invalid("That check-in is gone. Reopen Settings to see the current list.");
    if (existing.agentId !== input.agentId)
      return yield* invalid("A check-in keeps its agent. Add a new one for a different agent.");
  }
  const lead = (yield* leadsOf(sql, input.orgId)).find((row) => row.agentId === input.agentId);
  if (lead === undefined) return yield* invalid("That agent isn't working here any more.");
  yield* schedules.save({
    orgId: input.orgId,
    agentId: KinAgentId.make(lead.agentId),
    scheduleId:
      existing?.scheduleId ??
      KinMemoryItemId.make(`checkin-${now.toString(36)}-${person.personId}`),
    existing: existing !== undefined,
    chatId: existing?.chatId ?? KinChatId.make(lead.chatId),
    // Not the seed's: a default moved here stays where it was put (`followOwnerZone`).
    sourceEvent: `kin-settings:check-ins:${input.orgId}`,
    saidBy: person.personId,
    title: input.title,
    prompt: input.what,
    every,
    // Seeded ones run somewhere around their time; a new one too, so they don't all land at once.
    around: existing === undefined || existing.looseAt !== null,
    checkIn: true,
    now,
  });
  return yield* read(input.orgId);
}, unread);

export const act = Effect.fn("KinCheckIns.act")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinCheckInActInput,
) {
  yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const row = yield* KinSchedules.readSchedule(sql, input.orgId, input.scheduleId);
  if (row === undefined || row.deletedAt !== null || row.checkIn !== 1)
    return yield* invalid("That check-in is gone. Reopen Settings to see the current list.");
  const where = sql`task_id = ${row.taskId} AND deleted_at IS NULL`;
  switch (input.action) {
    case "run_now":
      yield* sql`UPDATE kin_schedules SET run_now_at = ${now}, updated_at = ${now}
        WHERE ${where} AND run_now_at IS NULL`;
      break;
    case "turn_off":
    case "turn_on":
      yield* sql`UPDATE kin_schedules SET pending_enabled = ${input.action === "turn_on" ? 1 : 0},
        updated_at = ${now} WHERE ${where}`;
      break;
    case "remove":
      yield* sql`UPDATE kin_schedules SET deleted_at = ${now}, updated_at = ${now} WHERE ${where}`;
      break;
  }
  return yield* read(input.orgId);
}, unread);
