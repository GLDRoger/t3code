import { KinPersonId, type KinEventId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const CardTapAnswer = Schema.Struct({
  personId: KinPersonId,
  optionId: Schema.String,
  revision: Schema.Number,
  label: Schema.String,
  agentName: Schema.String,
});
export const decodeCardTapAnswer = Schema.decodeUnknownEffect(CardTapAnswer);

export const trackedCardTapIds = Effect.fn("KinLeadDelivery.trackedCardTapIds")(function* (
  orgId: KinOrgId,
  eventIds: ReadonlyArray<KinEventId>,
) {
  if (eventIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    eventId: KinEventId;
  }>`SELECT event_id AS "eventId" FROM kin_lead_deliveries
    WHERE org_id = ${orgId} AND kind = 'card_tap' AND event_id IN ${sql.in(eventIds)}`;
  return rows.map((row) => row.eventId);
});
