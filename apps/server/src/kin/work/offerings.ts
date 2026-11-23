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
import { iso, type RecordRow } from "./recordRows.ts";
import { KIN_OWNER_LEVEL, viewVisible, type KinViewer } from "./teamView.ts";

/**
 * What we sell: one company doc per company, found by its origin key. Kin reads only its level-2
 * section titles, for agents' prompts, never the prose.
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

/**
 * The outline with a new company's own answer to what it sells, and to whom, as its opening line;
 * one line, so it never becomes a heading or a section of its own.
 */
export const offeringsWithAnswer = (sells: string) => {
  const line = sells.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
  return line === ""
    ? OFFERINGS_OUTLINE
    : OFFERINGS_OUTLINE.replace("# What we sell\n", `# What we sell\n\n${line}\n`);
};

/** Section titles an agent's prompt lists, at most. */
const INDEX_MAX = 30;

/** The level-2 section titles, in order. */
export const offeringsIndex = (body: string): ReadonlyArray<string> =>
  sectionsOf(body).flatMap((section) => (section.level === 2 ? [section.title] : []));

/** A Docs row, marked when it is What we sell. */
export const withOfferings = (doc: KinDocRow, row: Pick<RecordRow, "originKey">): KinDocRow =>
  row.originKey === OFFERINGS_ORIGIN ? { ...doc, whatWeSell: true } : doc;

/** The company's What we sell, archived or not; undefined before anyone started it. */
export const findOfferings = Effect.fn("KinOfferings.find")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<{
    recordId: string;
    key: string;
    state: string;
    updatedAt: number;
    sensitive: number;
  }>`SELECT record_id AS "recordId", key, state, updated_at AS "updatedAt", sensitive
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
 * Starts What we sell: the body given (else Kin's outline), once per company, kept by the sales
 * agent; one there already is is returned unwritten, an archived one brought back as it was left.
 * Owner level only: the caller checks.
 */
export const startOfferings = Effect.fn("KinOfferings.start")(function* (
  orgId: KinOrgId,
  writer: Writer,
  owner: KinPersonId,
  start: {
    readonly body?: string;
    readonly summary?: string;
    readonly provenance?: Docs.Provenance;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const held = yield* findOfferings(orgId);
      const body = start.body?.trim() === "" ? undefined : start.body;
      const written =
        held === undefined
          ? yield* Docs.create(orgId, writer, start.provenance ?? {}, {
              title: OFFERINGS_TITLE,
              body: body ?? OFFERINGS_OUTLINE,
              owner: yield* keeper(orgId, owner),
              summary: body === undefined ? "Kin's outline" : (start.summary ?? "Created"),
              kind: "other",
              company: true,
              originKey: OFFERINGS_ORIGIN,
            })
          : { row: yield* Docs.docRow(orgId, { recordId: held.recordId }, KIN_OWNER_LEVEL) };
      const row = written.row;
      const made = "created" in written && written.created;
      if (row.state !== "dropped") return { row, made, restored: false };
      return {
        row: (yield* Docs.move(orgId, writer, { key: row.key }, { archived: false })).row,
        made,
        restored: true,
      };
    }),
  );
});

/** The line every agent's prompt carries when the company has no What we sell at all. */
export const OFFERINGS_NONE = "Nobody has written What we sell yet.";

/** The line in place of the index while What we sell is archived. */
export const offeringsArchived = (key: string) =>
  `What we sell (${key}) is archived, so nothing in it is current. Its text is kept: when the owner asks, doc_create with whatWeSell brings it back as it was.`;

/**
 * What we sell as a turn's prompt lists it: its key, when it last changed and its section titles.
 * `none` when there is none, `archived` with its key while archived, `hidden` when the turn's
 * readers may not see it.
 */
export const offeringsPromptIndex = Effect.fn("KinOfferings.promptIndex")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const row = yield* findOfferings(orgId);
  if (row === undefined) return { _tag: "none" } as const;
  if (viewer._tag === "people" && !(yield* viewVisible(orgId, viewer.people, row.recordId)))
    return { _tag: "hidden" } as const;
  if (row.state === "dropped") return { _tag: "archived", key: row.key } as const;
  const titles = offeringsIndex((yield* Docs.versionOf(orgId, row.recordId))?.body ?? "");
  return {
    _tag: "index",
    sensitive: row.sensitive === 1,
    index: {
      key: row.key,
      updated: iso(row.updatedAt),
      sections: titles.slice(0, INDEX_MAX),
      ...(titles.length > INDEX_MAX ? { moreSections: titles.length - INDEX_MAX } : {}),
    },
  } as const;
});
