import type { KinPersonId, KinPulseFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

import { sectionOfSense, type SectionId } from "../../shell/sections.ts";
import { labelledNow } from "../../work/recordRows.ts";
import { crmSeesAs, viewSees } from "../../work/teamView.ts";
import { iso, type SenseContext, type SensedFact } from "./shared.ts";

/** Keep 500 rows per read and count the remainder only when a sentinel row proves there is more. */
export const SENSE_CAP = 500;

type MemberAccess = "work" | "meeting" | "deal" | "prospect";
type Cap = {
  readonly id?: string;
  readonly sense: KinPulseFact["sense"];
  readonly plural: string;
  readonly also?: SectionId;
  readonly access: MemberAccess | "owner" | "money" | "system";
  readonly cap?: number;
};

export type Overflow = {
  readonly plural: string;
  readonly omitted: Fragment;
  readonly access: MemberAccess;
};

const title = (count: number, plural: string) => `${count} more ${plural} not listed`;

export const cappedRows = Effect.fn("KinPulse.cappedRows")(function* <Row extends object>(
  ctx: SenseContext,
  facts: Array<SensedFact>,
  kind: Cap,
  query: Fragment,
) {
  const sql = yield* SqlClient.SqlClient;
  const cap = kind.cap ?? SENSE_CAP;
  const rows = yield* sql<Row>`${query} LIMIT ${cap + 1}`;
  if (rows.length <= cap) return rows;

  const omitted = sql`${query} LIMIT -1 OFFSET ${cap}`;
  const [total] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM (${omitted})`;
  const count = total!.count;
  if (count === 0) return rows.slice(0, cap);
  const key = `sense_overflow:${kind.id ?? kind.sense}`;
  const section = sectionOfSense(kind.sense);
  const members =
    kind.access === "owner" || kind.access === "money" || kind.access === "system"
      ? undefined
      : { plural: kind.plural, access: kind.access, omitted };
  facts.push({
    sense: "sense_overflow",
    family: kind.access === "money" || kind.access === "system" ? kind.access : "work",
    key,
    subject: { kind: "overflow", key, title: title(count, kind.plural) },
    scope: {},
    since: iso(ctx.at),
    consequence: "Open the full list to see them.",
    measure: { value: count, unit: "count", threshold: 10, from: { _tag: "default" } },
    actor: { _tag: "owner" },
    sensitive: members === undefined,
    wake: "brief",
    ...(section === null ? {} : { section }),
    ...(kind.also === undefined ? {} : { extraSection: kind.also }),
    ...(members === undefined ? {} : { overflow: members }),
  });
  return rows.slice(0, cap);
});

export const visibleOverflow = Effect.fn("KinPulse.visibleOverflow")(function* (
  orgId: string,
  people: ReadonlyArray<KinPersonId>,
  fact: SensedFact,
) {
  const overflow = fact.overflow;
  if (overflow === undefined || people.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const [person] = people;
  const crm = overflow.access === "deal" || overflow.access === "prospect";
  if (crm && people.length !== 1) return [];
  const ownDeal = sql`CASE WHEN r.owner_kind = 'person' THEN r.owner_id
    WHEN r.owner_kind = 'agent' THEN (SELECT c.owner_id FROM kin_records c
      WHERE c.org_id = r.org_id AND c.record_id = r.party_id AND c.owner_kind = 'person') END`;
  const membersSee = crm
    ? sql`${overflow.access === "deal" ? ownDeal : sql`CASE WHEN r.owner_kind = 'person' THEN r.owner_id END`} = ${person!}
        AND ${crmSeesAs(sql, person!, "r")}
        AND EXISTS (SELECT 1 FROM kin_people p WHERE p.org_id = r.org_id
          AND p.person_id = ${person!} AND p.removed_at IS NULL)`
    : sql`r.register_id IN ('work', 'milestones') AND NOT (${labelledNow(sql)})
        AND ${viewSees(sql, people)}`;
  const attended =
    overflow.access !== "meeting"
      ? sql`1`
      : sql.and(
          people.map(
            (id) => sql`EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.attendees') a
      WHERE a.value = 'person:' || ${id})`,
          ),
        );
  const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
    FROM (${overflow.omitted}) o JOIN kin_records r ON r.org_id = ${orgId} AND r.record_id = o.recordId
    WHERE ${membersSee} AND ${attended}`;
  if (row === undefined || row.count === 0 || fact.measure === undefined) return [];
  return [
    {
      ...fact,
      subject: { ...fact.subject, title: title(row.count, overflow.plural) },
      measure: { ...fact.measure, value: row.count },
    },
  ];
});
