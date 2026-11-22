import { calendarTimeMillis, isCalendarDay, KinRecordKey, KinTouchKind } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { KinToolText } from "./leadSchemas.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { turnPeople } from "../lead/Audience.ts";
import { KinRecords } from "./KinRecords.ts";
import {
  askedBy,
  Client,
  ClientOnRecord,
  clientOnRecord,
  type Lead,
  leadTool,
  ownerTurn,
  refRecord,
  retryKey,
  sourceOf,
} from "./leadWork.ts";
import { endOfDay, iso, ownerZone, recordName } from "./recordRows.ts";
import * as Touches from "./touches.ts";
import { TurnEvent } from "../lead/eventIds.ts";

/** Contact with clients as leads log and read it; the relationship file is memory's. */

const TOUCHES_READ = 10;

export const TouchInput = Schema.Struct({
  client: Client,
  kind: KinTouchKind,
  note: KinToolText(1_000, "What happened and what was agreed, in a line, as the person told it."),
  at: Schema.optional(
    KinToolText(
      40,
      "When: a day (2026-11-14) in the owner's time zone or a time with offset. Default now.",
    ),
  ),
  who: Schema.optional(
    KinToolText(120, "Who on our side, by handle or name; default the person who told you."),
  ),
  sourceEventId: TurnEvent,
});
export const Touch = Schema.Struct({
  at: Schema.String,
  kind: Schema.String,
  note: Schema.String,
  who: Schema.optional(Schema.String),
  from: Schema.optional(Schema.String),
});
export const TouchResult = Schema.Struct({
  client: Schema.String,
  touch: Touch,
  onRecord: ClientOnRecord.annotate({
    description:
      "What the client's record holds now: its open deals (none is no deal yet) and its contacts (none is no one).",
  }),
});
export const ContactInput = Schema.Struct({ key: KinRecordKey });
export const ContactResult = Schema.Struct({
  lastContact: Schema.NullOr(Schema.Struct({ at: Schema.String, days: Schema.Number })),
  /** "No logged contact for N days" once it has been a week. */
  quiet: Schema.optional(Schema.String),
  touches: Schema.Array(Touch),
});

const toShown = (touch: Effect.Success<ReturnType<typeof Touches.touchesOf>>[number]) => ({
  at: touch.at,
  kind: touch.kind,
  note: touch.note,
  ...(touch.who === null ? {} : { who: touch.who }),
  ...(touch.record === null ? {} : { from: recordName(touch.record.key, touch.number) }),
});

/** The person on our side: named, else the one teammate or the owner whose message this answers. */
const ourSide = Effect.fn("KinClientTools.ourSide")(function* (
  lead: Lead,
  who: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  if (who !== undefined) {
    const handle = who.replace(/^@/, "");
    const [row] = yield* sql<{ personId: string }>`SELECT person_id AS "personId" FROM kin_people
      WHERE org_id = ${lead.orgId}
        AND (lower(handle) = lower(${handle}) OR lower(display_name) = lower(${who}))
      ORDER BY lower(handle) = lower(${handle}) DESC, person_id LIMIT 1`;
    return row?.personId ?? null;
  }
  const behind = yield* turnPeople(lead);
  if (behind !== undefined && behind.askers.length === 1) return behind.askers[0]!;
  return yield* askedBy(lead);
});

const atOf = Effect.fn("KinClientTools.at")(function* (
  lead: Lead,
  at: string | undefined,
  now: number,
) {
  if (at === undefined) return now;
  if (isCalendarDay(at)) return Math.min(now, endOfDay(at, yield* ownerZone(lead.orgId)));
  return calendarTimeMillis(at);
});

const runLog = Effect.fnUntraced(function* (lead: Lead, input: typeof TouchInput.Type) {
  yield* sourceOf(lead, input.sourceEventId);
  const client = yield* refRecord(lead, input.client, "clients");
  const partyId = client.recordId;
  const now = yield* Clock.currentTimeMillis;
  const touch = yield* Touches.logTouch(lead.orgId, {
    partyId,
    kind: input.kind,
    at: yield* atOf(lead, input.at, now),
    note: input.note,
    personId: yield* ourSide(lead, input.who),
    by: { kind: "agent", id: lead.agentId },
    originKey: `lead:${lead.agentId}:${input.sourceEventId}:${retryKey(
      [partyId, input.kind, input.at ?? "", input.note].join("|"),
    )}`,
    now,
  });
  yield* (yield* KinRecords).announce(lead.orgId, [partyId]);
  return {
    client: `${client.name} (${client.key})`,
    touch: toShown(touch),
    onRecord: yield* clientOnRecord(lead, partyId),
  };
});
export const logTouch = leadTool("KinClientTools.logTouch", runLog);

/** Last contact and the recent touches, for `client_read`. */
const runContact = Effect.fnUntraced(function* (lead: Lead, input: typeof ContactInput.Type) {
  yield* ownerTurn(lead);
  const client = yield* refRecord(lead, input.key, "clients");
  const now = yield* Clock.currentTimeMillis;
  const touches = yield* Touches.touchesOf(lead.orgId, client.recordId, now, TOUCHES_READ);
  const last = touches[0] === undefined ? null : Date.parse(touches[0].at);
  const quiet = Touches.quietLine(last, client.createdAt, now);
  return {
    lastContact: last === null ? null : { at: iso(last), days: Touches.daysSince(last, now) },
    ...(quiet === null ? {} : { quiet }),
    touches: touches.map(toShown),
  } satisfies typeof ContactResult.Type;
});
export const contact = leadTool("KinClientTools.contact", runContact);
