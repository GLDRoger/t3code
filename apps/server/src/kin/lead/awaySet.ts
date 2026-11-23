import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KinChatError,
  KinDay,
  KinPersonId,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { storedClientId } from "../chat/KinChatRepository.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { profileSets } from "../people/profileFields.ts";
import { reholdAfter, validZone } from "../triggers/quietHold.ts";
import { ownerZone, startOfDay } from "../work/recordRows.ts";
import { personSees } from "../work/teamView.ts";
import { turnAsker } from "./Audience.ts";
import { directKey } from "./LeadAccess.ts";
import type { resolveLead } from "./LeadMemory.ts";

export const AwaySetInput = Schema.Struct({
  until: Schema.optional(Schema.NullOr(KinDay)).annotate({
    description:
      "The last day they are away, YYYY-MM-DD on their own calendar; today is allowed. Left out, they are back.",
  }),
});
export type AwaySetInput = typeof AwaySetInput.Type;
export const AwaySetResult = Schema.Struct({
  person: Schema.String,
  /** The last day they are away, on their calendar; null when they aren't. */
  until: Schema.NullOr(KinDay),
  saved: Schema.String,
  dueWhileAway: NonNegativeInt,
  keys: Schema.Array(Schema.String),
});

const refused = (message: string) => new KinChatError({ reason: "not_allowed", message });
const NOT_THEIRS =
  "Only the person who is away sets it, by saying so in their own chat with you, so nothing was saved. Ask them to say it there.";
const OPEN_STATES = ["open", "doing", "waiting"];
const KEYS_SHOWN = 5;

const noon = (day: string) => DateTime.makeUnsafe(`${day}T12:00:00.000Z`);
const dayAfter = (day: string, by: { readonly days?: number; readonly years?: number }) =>
  DateTime.formatIsoDate(DateTime.add(noon(day), by));
/** "Mon 23 Nov", with its year when that isn't today's. */
const written = (day: string, today: string) =>
  formatKinWhen(
    DateTime.toEpochMillis(noon(day)),
    day.slice(0, 4) === today.slice(0, 4) ? "day" : "dayYear",
    { zone: "UTC", locale: KIN_TEXT_LOCALE },
  ).replace(/,/g, "");

/**
 * The person whose own typed message, in their own direct chat with this agent, is everything
 * that woke the turn; else null. A copy (a hand-off, a relay, a message taken private), a
 * reaction, a tap, a routine, or a second person's word anywhere in the turn makes it null.
 */
const ownSpeaker = Effect.fn("KinAwaySet.speaker")(function* (
  lead: Effect.Success<ReturnType<typeof resolveLead>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const asker = yield* turnAsker(lead);
  if (asker === null) return null;
  const events = yield* sql<{ chatId: string | null; speaker: string | null }>`
    SELECT CASE WHEN e.tag = 'chat.message' AND json_extract(e.json, '$.origin') IS NULL
        THEN json_extract(e.json, '$.chatId') END AS "chatId",
      (SELECT m.author_person_id FROM kin_messages m WHERE m.org_id = e.org_id
        AND e.tag = 'chat.message' AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.chat_id = json_extract(e.json, '$.chatId') AND m.author_kind = 'human'
        AND m.kind = 'text' AND m.status = 'posted' AND m.relay_json IS NULL
        AND m.origin_json IS NULL
        -- A copy kin_take_private posts is sent with its claim's key as its client id.
        AND NOT EXISTS (SELECT 1 FROM kin_handoffs h WHERE h.org_id = m.org_id
          AND m.client_message_id = ${storedClientId("send", "")} || h.message_id)) AS speaker
    FROM kin_events e JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId}
      AND e.wakeup_id = ${lead.wakeupId} AND w.status = 'running' AND w.aborted_at IS NULL
    ORDER BY e.event_id`;
  const chats = new Set(events.map((event) => event.chatId));
  const [chatId] = chats;
  if (
    events.length === 0 ||
    chats.size !== 1 ||
    chatId == null ||
    !events.every((event) => event.speaker === asker)
  )
    return null;
  const people = yield* sql<{ personId: string }>`SELECT m.person_id AS "personId"
    FROM kin_chats c JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      AND m.principal_kind = 'person' AND m.left_at IS NULL
    WHERE c.org_id = ${lead.orgId} AND c.chat_id = ${chatId} AND c.kind = 'direct'
      AND c.archived_at IS NULL AND c.direct_key = ${directKey(asker, lead.agentId)}
    ORDER BY m.person_id`;
  return people.length === 1 && people[0]?.personId === asker ? asker : null;
});

/**
 * Sets or clears the away date of the one person who said it, in their own chat with the agent,
 * through the profile's own writer. `until` is their last day away; the profile keeps the day
 * they are back. An unchanged date writes nothing.
 */
export const setAway = Effect.fn("KinAwaySet.set")(function* (
  lead: Effect.Success<ReturnType<typeof resolveLead>>,
  input: AwaySetInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const refresh = yield* KinRefreshObserver;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const speaker = yield* ownSpeaker(lead);
      if (speaker === null) return yield* refused(NOT_THEIRS);
      const personId = KinPersonId.make(speaker);
      const [person] = yield* sql<{ name: string; zone: string | null; away: string | null }>`
        SELECT display_name AS name, time_zone AS zone, away_until AS away FROM kin_people
        WHERE org_id = ${lead.orgId} AND person_id = ${personId} AND removed_at IS NULL`;
      if (person === undefined) return yield* refused(NOT_THEIRS);
      const zone = validZone(person.zone) ?? (yield* ownerZone(lead.orgId));
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const today = DateTime.formatIsoDate(DateTime.makeZonedUnsafe(now, { timeZone: zone }));
      const until = input.until ?? null;
      if (until !== null && until < today)
        return yield* refused(
          `${written(until, today)} has passed on their calendar (today is ${written(today, today)}), so nothing was saved.`,
        );
      if (until !== null && until > dayAfter(today, { years: 1 }))
        return yield* refused(
          `${written(until, today)} is more than a year away, so nothing was saved. Ask for the last day they are away.`,
        );
      const back = until === null ? null : dayAfter(until, { days: 1 });
      if (person.away !== back) {
        const set = yield* profileSets({ awayUntil: back }, now);
        yield* reholdAfter(
          lead.orgId,
          personId,
          sql`UPDATE kin_people SET ${sql.csv(set)}
            WHERE org_id = ${lead.orgId} AND person_id = ${personId}`,
        );
        yield* refresh.touch(lead.orgId, "people");
      }
      const due =
        back === null
          ? []
          : yield* sql<{ key: string }>`SELECT r.key FROM kin_records r
              WHERE r.org_id = ${lead.orgId} AND r.register_id = 'work'
                AND r.owner_kind = 'person' AND r.owner_id = ${personId}
                AND r.state IN ${sql.in(OPEN_STATES)} AND r.due_at >= ${now}
                AND r.due_at < ${startOfDay(back, zone)} AND ${personSees(sql, personId)}
              ORDER BY r.due_at, r.key`;
      return {
        person: person.name,
        until,
        saved:
          until === null || back === null
            ? `${person.name} is not away.`
            : `${person.name} is away through ${written(until, today)} and back on ${written(back, today)}, on ${zone} time.`,
        dueWhileAway: due.length,
        keys: due.slice(0, KEYS_SHOWN).map((row) => row.key),
      };
    }),
  );
});
