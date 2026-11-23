import type { KinPulseFact } from "@t3tools/contracts";

/** Facts whose wake is a head start for their agent to make, not a line to tell. */
export const PREPARE_SENSES: ReadonlyArray<KinPulseFact["sense"]> = [
  "quote_unanswered",
  "renewal_due",
  "client_waiting_on_us",
];

/** Facts that can't wait for the morning: they wake their agent whatever the hour. */
export const URGENT_SENSES: ReadonlySet<string> = new Set<KinPulseFact["sense"]>([
  "client_waiting_on_us",
]);

/** Head starts one turn takes at most; the rest wait for the next. */
export const PREPARES_PER_TURN = 10;

/**
 * SQL over a trusted alias `e` of `kin_events`: a pulse Kin queued for such facts alone, no
 * check-in's and no person's follow-up. The queue gives these a lane of their own.
 */
export const PREPARE_EVENT_SQL = `(e.tag = 'pulse' AND json_extract(e.json, '$.checkIn') IS NULL
  AND json_extract(e.json, '$.origin') IS NULL
  AND json_array_length(e.json, '$.factKeys') > 0
  AND NOT EXISTS (SELECT 1 FROM json_each(e.json, '$.factKeys') k
    WHERE substr(k.value, 1, instr(k.value || ':', ':') - 1)
      NOT IN (${PREPARE_SENSES.map((sense) => `'${sense}'`).join(", ")})))`;
