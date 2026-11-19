import {
  KinChatError,
  KinPersonId,
  type KinAgentId,
  type KinChatId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { NUDGE_PREFIX } from "../reply/promises.ts";
import { personMiss, personNamed } from "../people/personNamed.ts";
import {
  isQuiet,
  KIN_DEFAULT_QUIET_HOURS,
  storedWorkHours,
  workingAt,
} from "../triggers/quietHours.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import { DAY_MS } from "./thresholds.ts";

/** An unanswered nudge holds off the next for this long; after it, Kin may try once more. */
const NUDGE_BACK_OFF_MS = 7 * DAY_MS;
const refuse = (message: string) => new KinChatError({ reason: "not_allowed", message });
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Whether a person is inside their working hours at `at`, in their own time zone (else the
 * owner's): their set hours when they have them, else outside the company's quiet hours. Nudges,
 * people_read and the pulse all ask this, so an agent never works it out itself.
 */
export const inHoursAt = (
  person: { readonly timeZone: string | null; readonly workHours: string | null },
  ownerZoneId: string,
  at: number,
) => {
  const zone = person.timeZone ?? ownerZoneId;
  const hours = storedWorkHours(person.workHours);
  return hours !== undefined
    ? workingAt(hours, zone, at)
    : !isQuiet(at, zone, KIN_DEFAULT_QUIET_HOURS);
};

const STEP_MS = 5 * 60 * 1000;
/** The first moment after `at` inside this person's hours, within the next 8 days. */
const nextInHours = (
  person: { readonly timeZone: string | null; readonly workHours: string | null },
  ownerZoneId: string,
  at: number,
) => {
  for (let t = Math.ceil(at / STEP_MS) * STEP_MS; t < at + 8 * DAY_MS; t += STEP_MS)
    if (inHoursAt(person, ownerZoneId, t)) return t;
  return undefined;
};

/** Each teammate (not the owner), and whether they are inside their hours now. */
export const teamHoursNow = Effect.fn("KinPulse.teamHoursNow")(function* (
  orgId: KinOrgId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const people = yield* sql<{ name: string; timeZone: string | null; workHours: string | null }>`
    SELECT p.display_name AS name, p.time_zone AS "timeZone", p.work_hours_json AS "workHours"
    FROM kin_people p
    WHERE p.org_id = ${orgId}
      AND NOT EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id
        AND a.owner_person_id = p.person_id)
      AND EXISTS (SELECT 1 FROM kin_session_bindings b WHERE b.org_id = p.org_id
        AND b.person_id = p.person_id AND b.revoked_at IS NULL)
    ORDER BY p.display_name, p.person_id LIMIT 50`;
  return people.map((person) => ({
    name: person.name,
    insideTheirHoursNow: inHoursAt(person, zone, at),
  }));
});

/**
 * One line to a teammate about a fact they can see, in their own chat with the agent: at most
 * one per person per working day, inside their hours, and none while the last went unanswered.
 * `chatFor` finds or opens that chat; `post` writes the line as the agent.
 */
export const nudge = Effect.fn("KinPulse.nudge")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly at: number;
  readonly person: string;
  readonly factKey: string;
  readonly text: string;
  readonly chatFor: (personId: KinPersonId) => Effect.Effect<KinChatId, KinChatError>;
  /** Writes it now, or holds it until `notBefore` or their quiet hours end: then when it posts. */
  readonly post: (
    chatId: KinChatId,
    clientMessageId: string,
    personId: KinPersonId,
    notBefore: number | undefined,
  ) => Effect.Effect<{ readonly at: number; readonly zone: string } | undefined, KinChatError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  const named = yield* personNamed(orgId, input.person);
  if (named._tag !== "found")
    return yield* new KinChatError({
      reason: "not_found",
      message: personMiss(input.person, named),
    });
  const [person] = yield* sql<{
    personId: string;
    name: string;
    timeZone: string | null;
    workHours: string | null;
    isOwner: number;
  }>`SELECT p.person_id AS "personId", p.display_name AS name, p.time_zone AS "timeZone",
      p.work_hours_json AS "workHours",
      EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = p.org_id
        AND a.agent_id = ${input.agentId} AND a.owner_person_id = p.person_id) AS "isOwner"
    FROM kin_people p
    WHERE p.org_id = ${orgId} AND p.person_id = ${named.item.id}
    ORDER BY p.person_id`;
  if (person === undefined) return yield* refuse("That person just left the company.");
  if (person.isOwner === 1)
    return yield* refuse("That's the owner: tell him in your own chat instead of nudging.");
  const personId = KinPersonId.make(person.personId);
  const theirs = yield* KinPulse.read({
    orgId,
    at,
    viewer: { _tag: "people", people: [personId] },
    limit: 200,
  });
  if (!theirs.facts.some((fact) => fact.key === input.factKey))
    return yield* refuse(
      `${person.name} can't see that fact, or it no longer needs attention. Nudge only about their own open Work; tell the owner about anything else.`,
    );
  const zone = person.timeZone ?? (yield* ownerZone(orgId));
  // Outside their hours it is held until they start, and counts for that day.
  const starts = inHoursAt(person, zone, at) ? undefined : nextInHours(person, zone, at);
  if (!inHoursAt(person, zone, at) && starts === undefined)
    return yield* refuse(
      `${person.name} is outside their working hours. Leave it for the next check-in in their hours.`,
    );
  const day = dayIn(starts ?? at, zone);
  const [last] = yield* sql<{ day: string; chatId: string; factKey: string; sentAt: number }>`
    SELECT day, chat_id AS "chatId", fact_key AS "factKey", sent_at AS "sentAt"
    FROM kin_pulse_nudges WHERE org_id = ${orgId} AND person_id = ${personId}
    ORDER BY sent_at DESC LIMIT 1`;
  if (last?.day === day)
    return yield* refuse(
      `${person.name} was already nudged today. One nudge a day: leave it, or tell the owner.`,
    );
  if (last !== undefined && at - last.sentAt < NUDGE_BACK_OFF_MS) {
    const [answered] = yield* sql`SELECT 1 FROM kin_messages
      WHERE org_id = ${orgId} AND chat_id = ${last.chatId} AND author_person_id = ${personId}
        AND origin_json IS NULL AND created_at > ${iso(last.sentAt)} LIMIT 1`;
    if (answered === undefined)
      return yield* refuse(
        `${person.name} hasn't answered your last nudge (${last.factKey}, ${last.day}). Don't nag: replan, take it over, or tell the owner.`,
      );
  }
  const chatId = yield* input.chatFor(personId);
  const claimed = yield* sql`INSERT INTO kin_pulse_nudges (org_id, person_id, day, agent_id,
      chat_id, fact_key, sent_at)
    VALUES (${orgId}, ${personId}, ${day}, ${input.agentId}, ${chatId}, ${input.factKey}, ${at})
    ON CONFLICT (org_id, person_id, day) DO NOTHING RETURNING day`;
  if (claimed.length === 0)
    return yield* refuse(`${person.name} was already nudged today. One nudge a day: leave it.`);
  const held = yield* input
    .post(chatId, `${NUDGE_PREFIX}${personId}:${day}`, personId, starts)
    .pipe(
      Effect.tapError(() =>
        sql`DELETE FROM kin_pulse_nudges
          WHERE org_id = ${orgId} AND person_id = ${personId} AND day = ${day}`.pipe(Effect.ignore),
      ),
    );
  return { person: person.name, chatId, day, held };
});
