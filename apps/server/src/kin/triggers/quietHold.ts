import {
  type KinAgentId,
  type KinChatId,
  KinMessageRelay,
  type KinOrgId,
  type KinPersonId,
  KinPersonQuietHours,
  formatKinWhen,
  KIN_TEXT_LOCALE,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WriteAudience } from "../chat/KinChatRepository.ts";
import { turnChat } from "../lead/Audience.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import {
  freeAt,
  heldAt,
  holdRule,
  KIN_DEFAULT_QUIET_HOURS,
  type KinHoldRule,
  storedWorkHours,
} from "./quietHours.ts";
import { MINUTE_MS } from "../durations.ts";

/** A message they sent this recently is one a line to them answers, whatever the hour. */
export const ANSWERS_WITHIN_MS = 10 * MINUTE_MS;
const decodeJsonQuiet = Schema.decodeUnknownOption(Schema.fromJsonString(KinPersonQuietHours));
const encodeRelay = Schema.encodeEffect(Schema.fromJsonString(KinMessageRelay));

export const validZone = (zone: string | null | undefined) => {
  if (zone === null || zone === undefined) return undefined;
  try {
    DateTime.makeZonedUnsafe(0, { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};

/**
 * When Kin holds unprompted lines to `personId`, on their own clock: their quiet hours (their
 * own, else the company's, else 22:00 to 07:00), and, while their switch is on (by default for
 * everyone but the owner), any time outside the working hours on their profile.
 */
const personRule = Effect.fn("KinQuiet.rule")(function* (orgId: KinOrgId, personId: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{
    zone: string | null;
    owner: number;
    quiet: string | null;
    hours: string | null;
    hold: number | null;
    away: string | null;
  }>`
    SELECT time_zone AS zone, quiet_hours_json AS quiet, work_hours_json AS hours,
      hold_outside_hours AS hold, away_until AS away, EXISTS (SELECT 1 FROM kin_agents a
        WHERE a.org_id = p.org_id AND a.owner_person_id = p.person_id) AS owner
    FROM kin_people p WHERE org_id = ${orgId} AND person_id = ${personId} ORDER BY person_id`;
  const [settings] = yield* sql<{ hours: string }>`SELECT quiet_hours_json AS hours
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
  const owner = person?.owner === 1;
  const company = yield* ownerZone(orgId);
  const own = validZone(person?.zone) ?? company;
  // The owner's quiet hours keep the company's clock (`ownerZone`); all else is on their own.
  const zone = owner ? company : own;
  const quiet = Option.getOrElse(
    Option.orElse(decodeJsonQuiet(person?.quiet ?? undefined), () =>
      decodeJsonQuiet(settings?.hours),
    ),
    () => KIN_DEFAULT_QUIET_HOURS,
  );
  const holds = person?.hold === null || person?.hold === undefined ? !owner : person.hold === 1;
  const rule = holdRule(zone, quiet, holds ? storedWorkHours(person?.hours) : undefined, {
    zone: own,
    at: yield* Clock.currentTimeMillis,
  });
  // Away ends when their profile stops showing it: on their own clock, the owner's too.
  return person?.away == null ? rule : { ...rule, awayUntil: startOfDay(person.away, own) };
});

/**
 * Runs `change` to someone's clock (zone, quiet hours, working hours, the hold switch, away), then
 * moves each line held for them to the first minute their new rule lets it go, and each unasked
 * wake of their own agents held by that rule. A line held past the old rule's free minute waited
 * for a time of its own, which it keeps when that is later.
 */
export const reholdAfter = <A, E, R>(
  orgId: KinOrgId,
  personId: KinPersonId,
  change: Effect.Effect<A, E, R>,
) => reholdFor(orgId, [personId], change);

/**
 * `reholdAfter` for everyone with a line held, for a change to the company's clock (its zone or
 * quiet hours), which moves the rule of each person who keeps the company's.
 */
export const reholdEveryoneAfter = Effect.fn("KinQuiet.reholdEveryone")(function* <A, E, R>(
  orgId: KinOrgId,
  change: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const people = yield* sql<{ personId: KinPersonId }>`SELECT DISTINCT person_id AS "personId"
    FROM kin_held_posts WHERE org_id = ${orgId} AND delivered_at IS NULL ORDER BY person_id`;
  return yield* reholdFor(
    orgId,
    people.map((row) => row.personId),
    change,
  );
});

const reholdFor = Effect.fn("KinQuiet.rehold")(function* <A, E, R>(
  orgId: KinOrgId,
  people: ReadonlyArray<KinPersonId>,
  change: Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const before = new Map<KinPersonId, KinHoldRule>();
  for (const personId of people) before.set(personId, yield* personRule(orgId, personId));
  const result = yield* change;
  const now = yield* Clock.currentTimeMillis;
  for (const personId of people) {
    const was = freeAt(before.get(personId)!, now);
    const free = freeAt(yield* personRule(orgId, personId), now);
    const held = yield* sql<{ holdId: string; at: number }>`SELECT hold_id AS "holdId",
        deliver_at AS at FROM kin_held_posts
      WHERE org_id = ${orgId} AND person_id = ${personId} AND delivered_at IS NULL`;
    for (const row of held) {
      const at = Math.max(free, row.at > was ? row.at : now);
      if (at !== row.at)
        yield* sql`UPDATE kin_held_posts SET deliver_at = ${at}
          WHERE org_id = ${orgId} AND hold_id = ${row.holdId}`;
    }
    // A wake of their own agent nobody asked for waited to the old rule's free minute exactly
    // (`agentQuietUntil`); a retry, a budget wait or a check-in's own minute is held otherwise.
    if (was > now && free !== was)
      yield* sql`UPDATE kin_events SET not_before = ${free}
        WHERE org_id = ${orgId} AND state = 'queued' AND tag = 'pulse' AND attempts = 0
          AND budget_deferred = 0 AND not_before = ${was}
          AND agent_id IN (SELECT agent_id FROM kin_agents
            WHERE org_id = ${orgId} AND owner_person_id = ${personId})`;
  }
  return result;
});

/** Whether a line to `personId` waits at `now`, why, and the first minute it may go. */
const personQuiet = Effect.fn("KinQuiet.person")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  now: number,
) {
  const rule = yield* personRule(orgId, personId);
  const why = heldAt(rule, now);
  return { quiet: why !== undefined, why, endsAt: freeAt(rule, now), zone: rule.zone };
});

/** The day `personId` is back on, on their calendar, while they are away now; else undefined. */
export const awayBackOn = Effect.fn("KinQuiet.awayBackOn")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ away: string | null }>`SELECT away_until AS away FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  if (person?.away == null) return undefined;
  const away = heldAt(yield* personRule(orgId, personId), yield* Clock.currentTimeMillis);
  return away === "away" ? person.away : undefined;
});

/** For a push: whether they are in their quiet hours, or outside the hours they hold to. */
export const personHoldNow = Effect.fn("KinQuiet.holdNow")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  return heldAt(yield* personRule(orgId, personId), yield* Clock.currentTimeMillis);
});

/**
 * How long after someone asks the answer still rings in their quiet hours. Long work they started
 * before bed is often what they stay up for; past this, it waits in their notifications.
 */
const ANSWER_RINGS_WITHIN_MS = 3 * 60 * MINUTE_MS;

/**
 * Whether an answer to what `personId` asked at `askedAt` rings in their quiet hours now: their
 * switch is on (`answers_ring`, on unless set off), and they asked within these same quiet hours
 * or less than `ANSWER_RINGS_WITHIN_MS` ago.
 */
export const answerRings = Effect.fn("KinQuiet.answerRings")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  askedAt: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const [person] = yield* sql<{ ring: number | null }>`SELECT answers_ring AS ring FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${personId}`;
  if (person === undefined || person.ring === 0) return false;
  const now = yield* Clock.currentTimeMillis;
  if (now - askedAt < ANSWER_RINGS_WITHIN_MS) return true;
  const { zone, quiet } = yield* personRule(orgId, personId);
  const night = { zone, quiet };
  return heldAt(night, askedAt) === "quiet" && freeAt(night, askedAt) === freeAt(night, now);
});

/**
 * Stores a server line for `personId` when it lands in their quiet hours or outside the hours
 * they hold to, to post when those end; `false` when it should post now. Held lines survive a
 * restart.
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
 * When a held line reaches them, in their own zone: "07:00 their time (Tue 17 Nov)", in `locale`
 * (the company's `textLocale` for people, `KIN_TEXT_LOCALE` for an agent).
 */
export const theirTime = (at: number, zone: string, locale: string) => {
  const part = (style: "time" | "day") =>
    formatKinWhen(at, style, { zone, locale }).replace(/,/g, "");
  return `${part("time")} their time (${part("day")})`;
};

/** What the sending agent is told of a held line: "Zoya Sheikh is off until 10:00 their time (Tue 17 Nov)". */
export const heldUntil = (
  name: string,
  held: { readonly at: number; readonly zone: string; readonly why: "quiet" | "off" | "away" },
) =>
  `${name} is ${held.why === "off" ? "off" : held.why === "away" ? "away" : "in quiet hours"} until ${theirTime(held.at, held.zone, KIN_TEXT_LOCALE)}`;

/**
 * Until when a relay, nudge, notice or hand-over line for `personId` in `chatId` waits: the end
 * of their quiet hours or, while they hold to them, the start of their working hours; or
 * `notBefore` when later. Undefined, it posts now, as it does when they wrote in that chat in the
 * last 10 minutes: then it answers them.
 */
export const holdFor = Effect.fn("KinQuiet.holdFor")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  /** None for a banner told outside any chat: nothing they wrote answers it. */
  readonly chatId: KinChatId | undefined;
  readonly notBefore?: number | undefined;
  /** Nothing they said asks for it (a task handed to them): while they are away it waits anyway. */
  readonly unasked?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const quiet = yield* personQuiet(input.orgId, input.personId, now);
  const at = Math.max(quiet.endsAt, input.notBefore ?? now);
  if (at <= now) return undefined;
  if ((input.unasked === true && quiet.why === "away") || input.chatId === undefined)
    return { at, zone: quiet.zone, why: quiet.why ?? ("off" as const) };
  const [answers] = yield* sql`SELECT 1 FROM kin_messages
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
      AND author_person_id = ${input.personId} AND origin_json IS NULL
      AND created_at > ${DateTime.formatIso(DateTime.makeUnsafe(now - ANSWERS_WITHIN_MS))}
    LIMIT 1`;
  return answers === undefined
    ? { at, zone: quiet.zone, why: quiet.why ?? ("off" as const) }
    : undefined;
});

/**
 * Stores one line for `personId` to post at `at` (`deliverHeld`), as `agentId` when given, else
 * as Kin's own row; `waits` makes it wait on their answer. `key` names it, so a retried call
 * holds nothing more. Returns when it posts.
 */
export const holdLine = Effect.fn("KinQuiet.holdLine")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly personId: KinPersonId;
  readonly key: string;
  readonly body: string;
  readonly audience: WriteAudience;
  readonly at: number;
  readonly agentId?: KinAgentId | undefined;
  readonly waits?: boolean;
  /** Another person's words the agent passes on, drawn as sent by them when it posts. */
  readonly relay?: KinMessageRelay | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [held] = yield* sql<{ at: number }>`SELECT deliver_at AS at FROM kin_held_posts
    WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId} AND kind = ${input.key}
    ORDER BY rowid LIMIT 1`;
  if (held !== undefined) return held.at;
  yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
      audience, held_at, deliver_at, agent_id, waits, relay_json)
    VALUES (${SecureRandom.uuidV4Unsafe()}, ${input.orgId}, ${input.chatId}, ${input.personId},
      ${input.key}, ${input.body}, ${input.audience}, ${yield* Clock.currentTimeMillis},
      ${input.at}, ${input.agentId ?? null}, ${input.waits === true ? 1 : 0},
      ${input.relay === undefined ? null : yield* encodeRelay(input.relay).pipe(Effect.orDie)})`;
  return input.at;
});

/** The turn a relay's key names (`relayPrefix`), or undefined for any other key. */
export const relayWakeup = (key: string) => /^kin-relay:([^:]+):/.exec(key)?.[1];

/** Whether the relays of turns `a` and `b` were raised from the same chat (`turnChat`). */
export const sameAsk = Effect.fn("KinQuiet.sameAsk")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  a: string,
  b: string,
) {
  if (a === b) return true;
  const [one, two] = [
    yield* turnChat({ orgId, agentId, wakeupId: a }),
    yield* turnChat({ orgId, agentId, wakeupId: b }),
  ];
  return one !== undefined && one.chatId === two?.chatId;
});

/**
 * The escape from someone's quiet hours: the agent's stated reason, logged, and it rings them.
 * It replaces the relays `agentId` holds for them in `chatId` raised from the chat this turn
 * answers: those are withdrawn, and their count returned.
 */
export const urgentNow = Effect.fn("KinQuiet.urgent")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly personId: KinPersonId;
  readonly chatId: KinChatId;
  readonly wakeupId: string | undefined;
  readonly reason: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.logInfo("Kin urgent message", input);
  yield* sql`DELETE FROM kin_push_rings WHERE org_id = ${input.orgId} AND person_id = ${input.personId}`;
  if (input.wakeupId === undefined) return 0;
  const held = yield* sql<{ holdId: string; kind: string }>`SELECT hold_id AS "holdId", kind
    FROM kin_held_posts WHERE org_id = ${input.orgId} AND chat_id = ${input.chatId}
      AND person_id = ${input.personId} AND agent_id = ${input.agentId}
      AND delivered_at IS NULL AND substr(kind, 1, 10) = 'kin-relay:'
    ORDER BY held_at, rowid`;
  const replaced: Array<string> = [];
  for (const row of held) {
    const wakeupId = relayWakeup(row.kind);
    if (
      wakeupId !== undefined &&
      (yield* sameAsk(input.orgId, input.agentId, wakeupId, input.wakeupId))
    )
      replaced.push(row.holdId);
  }
  if (replaced.length > 0)
    yield* sql`DELETE FROM kin_held_posts
      WHERE org_id = ${input.orgId} AND hold_id IN ${sql.in(replaced)}`;
  return replaced.length;
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
