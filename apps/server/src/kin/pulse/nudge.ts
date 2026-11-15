import {
  KinChatError,
  KinPersonId,
  KinWorkHours,
  type KinAgentId,
  type KinChatId,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { workingAt } from "../lead/peopleRead.ts";
import { isQuiet, KIN_DEFAULT_QUIET_HOURS } from "../triggers/quietHours.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import * as KinPulse from "./KinPulse.ts";
import { DAY_MS } from "./thresholds.ts";

/** An unanswered nudge holds off the next for this long; after it, Kin may try once more. */
const NUDGE_BACK_OFF_MS = 7 * DAY_MS;
const decodeHours = Schema.decodeUnknownOption(Schema.fromJsonString(KinWorkHours));
const refuse = (message: string) => new KinChatError({ reason: "not_allowed", message });
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

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
  readonly post: (chatId: KinChatId, clientMessageId: string) => Effect.Effect<void, KinChatError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  const wanted = input.person.trim().toLowerCase();
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
    WHERE p.org_id = ${orgId} AND (p.person_id = ${input.person}
      OR lower(p.display_name) = ${wanted} OR lower(p.handle) = ${wanted})
    ORDER BY p.person_id LIMIT 1`;
  if (person === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No one called ${input.person} is in the company. people_read lists who is.`,
    });
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
  const hours = person.workHours === null ? undefined : decodeHours(person.workHours);
  const zone = person.timeZone ?? (yield* ownerZone(orgId));
  const inHours =
    hours !== undefined && hours._tag === "Some" && person.timeZone !== null
      ? workingAt(hours.value, person.timeZone, at)
      : !isQuiet(at, zone, KIN_DEFAULT_QUIET_HOURS);
  if (!inHours)
    return yield* refuse(
      `${person.name} is outside their working hours. Leave it for the next check-in in their hours.`,
    );
  const day = dayIn(at, zone);
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
        AND created_at > ${iso(last.sentAt)} LIMIT 1`;
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
  yield* input.post(chatId, `pulse-nudge:${personId}:${day}`).pipe(
    Effect.tapError(() =>
      sql`DELETE FROM kin_pulse_nudges
          WHERE org_id = ${orgId} AND person_id = ${personId} AND day = ${day}`.pipe(Effect.ignore),
    ),
  );
  return { person: person.name, chatId, day };
});
