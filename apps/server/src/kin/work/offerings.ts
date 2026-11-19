import {
  KinAgentId,
  kinSalesLead,
  type KinDocRow,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { sectionsOf } from "./docBody.ts";
import * as Docs from "./docs.ts";
import type { Writer } from "./KinRecords.ts";
import type { RecordRow } from "./recordRows.ts";
import { KIN_OWNER_LEVEL } from "./teamView.ts";

/**
 * What we sell: one company doc per company, found by its origin key. Each level-2 section is one
 * offering, except the first, which says who a good customer is. Kin reads only which sections
 * exist, never the prose.
 */

export const OFFERINGS_ORIGIN = "kin-offerings";
const OFFERINGS_TITLE = "What we sell";
const OFFERINGS_OUTLINE = `# What we sell

## Who is a good customer for us
The kind of business, size, signs they'll do well with us, signs they won't, who usually decides.

## Our first offering
### What it does

### Who it's for

### Price (or how we price it)

### What it doesn't do

### What people worry about and what we say

### Proof (customers it worked for, that we may name)
`;

/** The level-2 section titles, in order. */
export const offeringsIndex = (body: string): ReadonlyArray<string> =>
  sectionsOf(body).flatMap((section) => (section.level === 2 ? [section.title] : []));

/** Level-2 sections after the first, which says who a good customer is. */
const offeringCount = (body: string) => Math.max(0, offeringsIndex(body).length - 1);

/** A Docs row, marked when it is What we sell. */
export const withOfferings = (
  doc: KinDocRow,
  row: Pick<RecordRow, "originKey">,
  latest: { readonly body: string },
): KinDocRow =>
  row.originKey === OFFERINGS_ORIGIN
    ? { ...doc, whatWeSell: { offerings: offeringCount(latest.body) } }
    : doc;

/** The company's What we sell, archived or not; undefined before anyone started it. */
export const findOfferings = Effect.fn("KinOfferings.find")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<{ recordId: string }>`SELECT record_id AS "recordId"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'docs'
      AND origin_key = ${OFFERINGS_ORIGIN}
    ORDER BY record_id LIMIT 1`;
  return found;
});

/** Who keeps it: the live sales agent (`kinSalesLead`), else the owner when there is no agent. */
const keeper = Effect.fn("KinOfferings.keeper")(function* (orgId: KinOrgId, owner: KinPersonId) {
  const sql = yield* SqlClient.SqlClient;
  const leads = yield* sql<{ agentId: string; domain: string }>`SELECT l.agent_id AS "agentId",
      l.domain FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      AND a.role = 'lead' AND a.retired_at IS NULL
    WHERE l.org_id = ${orgId} ORDER BY l.agent_id`;
  const lead = kinSalesLead(leads);
  return lead === undefined
    ? ({ _tag: "person", personId: owner } as const)
    : ({ _tag: "agent", agentId: KinAgentId.make(lead.agentId) } as const);
});

/**
 * Starts What we sell: Kin's outline, once per company, kept by the sales agent; an archived one
 * comes back as it was left. Owner level only: the caller checks.
 */
export const startOfferings = Effect.fn("KinOfferings.start")(function* (
  orgId: KinOrgId,
  writer: Writer,
  owner: KinPersonId,
) {
  const held = yield* findOfferings(orgId);
  const row =
    held === undefined
      ? (yield* Docs.create(
          orgId,
          writer,
          {},
          {
            title: OFFERINGS_TITLE,
            body: OFFERINGS_OUTLINE,
            owner: yield* keeper(orgId, owner),
            summary: "Kin's outline",
            kind: "other",
            company: true,
            originKey: OFFERINGS_ORIGIN,
          },
        )).row
      : yield* Docs.docRow(orgId, { recordId: held.recordId }, KIN_OWNER_LEVEL);
  if (row.state !== "dropped") return row;
  return (yield* Docs.move(orgId, writer, { key: row.key }, { archived: false })).row;
});
