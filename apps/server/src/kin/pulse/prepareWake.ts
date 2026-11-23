import type { KinEvent, KinOrgId, KinPulseFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SILENT_REPLY } from "../reply/classify.ts";

/** Facts whose wake is a head start for their agent to make, not a line to tell. */
const PREPARES: ReadonlySet<string> = new Set<KinPulseFact["sense"]>([
  "quote_unanswered",
  "renewal_due",
  "client_waiting_on_us",
]);

/** A wake Kin queued for one of those facts: its own, not a check-in's or a person's follow-up. */
export const isPrepareWake = (
  event: KinEvent,
): event is Extract<KinEvent, { readonly _tag: "pulse" }> =>
  event._tag === "pulse" &&
  event.checkIn === undefined &&
  event.origin === undefined &&
  event.factKeys.length > 0 &&
  event.factKeys.every((key) => PREPARES.has(key.split(":")[0] ?? ""));

/** Of `factKeys`, those still standing at `now`: sensed at the last tick and not handled. */
export const standingFacts = Effect.fn("KinPulse.standingFacts")(function* (
  orgId: KinOrgId,
  factKeys: ReadonlyArray<string>,
  now: number,
) {
  if (factKeys.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const open = yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
    WHERE org_id = ${orgId} AND fact_key IN ${sql.in(factKeys)} AND cleared_at IS NULL
      AND (handled_at IS NULL OR (handled_until IS NOT NULL AND handled_until <= ${now}))
    ORDER BY fact_key`;
  return open.map((row) => row.key);
});

/** What the agent reads when Kin wakes it for one of those facts. */
export const HEAD_START_WAKE = `Kin woke you to make a head start on the fact marked wokeYou in the pulse. Do the first piece of it that can be done now. A message that would leave the company is a draft whose card waits on a Confirm: nothing is sent, so never say it was. A document, form or notes go through doc_create or kin_document, linked to what they are for. Then tell the person it is for in one short line, with the card or the link. Never ask a question where a draft would do. If nothing can be prepared, say in one line what is missing. If a first piece of it already exists, write exactly ${SILENT_REPLY}.`;
/** A wake whose fact was handled or stopped being true before its turn. */
export const HEAD_START_GONE = `Kin checked this again as this turn started: it is handled or no longer true, so there is nothing to start. Write exactly ${SILENT_REPLY}.`;

/** The wake's own line, checked again as its turn starts; undefined once nothing it was for stands. */
export const prepareWakeText = Effect.fn("KinPulse.prepareWakeText")(function* (
  orgId: KinOrgId,
  factKeys: ReadonlyArray<string>,
  now: number,
) {
  return (yield* standingFacts(orgId, factKeys, now)).length === 0 ? undefined : HEAD_START_WAKE;
});
