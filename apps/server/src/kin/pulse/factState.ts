import {
  KinAgentId,
  KinPersonId,
  KinPulseFact,
  KinRecordId,
  type KinOrgId,
  type KinPulseHandled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { asideOf, liveHolds } from "./holds.ts";
import type { Viewer } from "./KinPulse.ts";
import { iso, type SensedFact } from "./senses/shared.ts";

/**
 * What the pulse stored of its facts (`kin_pulse_facts`) and who has them in hand: the reads the
 * pulse tells holders by, and that a notice about a fact is settled by (`factsStand`).
 */

export interface StoredRow {
  readonly key: string;
  readonly firstSeenAt: number;
  readonly wokeAt: number | null;
  readonly byKind: string | null;
  readonly byId: string | null;
  readonly handledAt: number | null;
  readonly until: number | null;
  readonly note: string | null;
}

export const storedRows = Effect.fn("KinPulse.stored")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = new Map<string, StoredRow>();
  for (let start = 0; start < keys.length; start += 500)
    for (const row of yield* sql<StoredRow>`SELECT fact_key AS key,
        first_seen_at AS "firstSeenAt", woke_at AS "wokeAt", handled_by_kind AS "byKind",
        handled_by_id AS "byId", handled_at AS "handledAt", handled_until AS until,
        handled_note AS note
      FROM kin_pulse_facts
      WHERE org_id = ${orgId} AND fact_key IN ${sql.in(keys.slice(start, start + 500))}
      ORDER BY fact_key`)
      rows.set(row.key, row);
  return rows;
});

/**
 * A stored hold that still applies at `at`; an expired "I've got it" brings the fact back, as does
 * "not a problem" past the fact's `quietForMs`. With a
 * reader, only theirs: an agent's or an owner-level person's hold the owner's view, a person's own
 * hold theirs. Handling a fact hides it from no one else, and never hides the task.
 */
export const handledOf = (
  row: StoredRow | undefined,
  at: number,
  fact: Pick<SensedFact, "quietForMs">,
  reader?: { readonly viewer: Viewer; readonly level: ReadonlySet<string> },
): KinPulseHandled | null => {
  if (row?.byKind == null || row.byId === null || row.handledAt === null) return null;
  if (row.until !== null && row.until <= at) return null;
  if (row.until === null && fact.quietForMs !== undefined && row.handledAt + fact.quietForMs <= at)
    return null;
  if (reader !== undefined) {
    const theirs =
      reader.viewer._tag === "owner"
        ? row.byKind === "agent" || reader.level.has(row.byId)
        : row.byKind === "person" && reader.viewer.people.some((person) => person === row.byId);
    if (!theirs) return null;
  }
  return {
    by:
      row.byKind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(row.byId) }
        : { _tag: "person", personId: KinPersonId.make(row.byId) },
    at: iso(row.handledAt),
    until: row.until === null ? null : iso(row.until),
    note: row.note,
  };
};

const decodeScope = Schema.decodeUnknownOption(Schema.fromJsonString(KinPulseFact.fields.scope));

/**
 * Whether any of `keys` still needs its holder `personId` at `at`, as the pulse tells holders: last
 * sensed and not cleared, in no one's hands, and set aside neither for the company nor by them.
 */
export const factsStand = Effect.fn("KinPulse.factsStand")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  keys: ReadonlyArray<string>,
  at: number,
) {
  if (keys.length === 0) return false;
  const sql = yield* SqlClient.SqlClient;
  const stored = yield* storedRows(orgId, keys);
  const open = yield* sql<{ key: string; recordId: string | null; scope: string }>`SELECT
      fact_key AS key, subject_record_id AS "recordId", scope_json AS scope
    FROM kin_pulse_facts
    WHERE org_id = ${orgId} AND fact_key IN ${sql.in(keys)} AND cleared_at IS NULL
    ORDER BY fact_key`;
  const holds = open.length === 0 ? [] : yield* liveHolds(orgId, at);
  return open.some(
    (fact) =>
      handledOf(stored.get(fact.key), at, {}) === null &&
      asideOf(
        {
          subject: fact.recordId === null ? {} : { recordId: KinRecordId.make(fact.recordId) },
          scope: Option.getOrElse(decodeScope(fact.scope), () => ({})),
        },
        holds,
        { _tag: "people", people: [personId] },
      ) === undefined,
  );
});
