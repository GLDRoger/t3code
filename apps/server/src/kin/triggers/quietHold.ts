import {
  type KinAgentId,
  type KinChatId,
  type KinOrgId,
  type KinPersonId,
  KinTriggerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WriteAudience } from "../chat/KinChatRepository.ts";
import { ownerZone } from "../work/recordRows.ts";
import { isQuiet, KIN_DEFAULT_QUIET_HOURS, type KinQuietHours } from "./quietHours.ts";

const MINUTE = 60_000;
const decodeJsonQuiet = Schema.decodeUnknownOption(
  Schema.fromJsonString(KinTriggerSettings.fields.quietHours),
);

const validZone = (zone: string | null | undefined) => {
  if (zone === null || zone === undefined) return undefined;
  try {
    DateTime.makeZonedUnsafe(0, { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};

/** The first whole minute at or after `now` outside `hours`; `now` itself when not quiet. */
const quietEndsAt = (now: number, zone: string, hours: KinQuietHours) => {
  if (!isQuiet(now, zone, hours)) return now;
  let at = Math.ceil(now / MINUTE) * MINUTE;
  for (let step = 0; step < 1440 && isQuiet(at, zone, hours); step++) at += MINUTE;
  return at;
};

/**
 * A person's quiet hours at `now`, on their own clock: the company's setting, else 22:00 to
 * 07:00. Profile hours are left out: reading Memory here would run inside callers' transactions.
 */
const personQuiet = Effect.fn("KinQuiet.person")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // The owner's clock is the company's (`ownerZone`); anyone else's is their own.
  const [person] = yield* sql<{ zone: string | null; owner: number }>`
    SELECT time_zone AS zone, EXISTS (SELECT 1 FROM kin_agents a
        WHERE a.org_id = p.org_id AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`;
  const [settings] = yield* sql<{ hours: string }>`SELECT quiet_hours_json AS hours
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
  const hours = Option.getOrElse(decodeJsonQuiet(settings?.hours), () => KIN_DEFAULT_QUIET_HOURS);
  const zone =
    person?.owner === 1
      ? yield* ownerZone(orgId)
      : (validZone(person?.zone) ?? (yield* ownerZone(orgId)));
  return { quiet: isQuiet(now, zone, hours), endsAt: quietEndsAt(now, zone, hours) };
});

/**
 * Stores a server line for `personId` when it lands in their quiet hours, to post when those
 * end; `false` when it should post now. Held lines survive a restart.
 */
export const holdIfQuiet = Effect.fn("KinQuiet.hold")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly personId: KinPersonId;
  /** Lines of one kind held for one chat post as one. */
  readonly kind: string;
  readonly body: string;
  readonly audience: WriteAudience;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const quiet = yield* personQuiet(input.orgId, input.personId, now);
  if (!quiet.quiet) return false;
  yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
      audience, held_at, deliver_at)
    VALUES (${SecureRandom.uuidV4Unsafe()}, ${input.orgId}, ${input.chatId}, ${input.personId},
      ${input.kind}, ${input.body}, ${input.audience}, ${now}, ${quiet.endsAt})`;
  return true;
});

/**
 * When an unprompted turn of `agentId` may start: the end of its owner's quiet hours when `at`
 * falls in them, else undefined. Its post then lands after them, in queue order.
 */
export const agentQuietUntil = Effect.fn("KinQuiet.agent")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ owner: KinPersonId }>`SELECT owner_person_id AS owner
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  if (agent === undefined) return undefined;
  const quiet = yield* personQuiet(orgId, agent.owner, at);
  return quiet.quiet ? quiet.endsAt : undefined;
});

/** The end of `personId`'s quiet hours when `at` falls in them, else undefined. */
export const personQuietUntil = Effect.fn("KinQuiet.personUntil")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  at: number,
) {
  const quiet = yield* personQuiet(orgId, personId, at);
  return quiet.quiet ? quiet.endsAt : undefined;
});
