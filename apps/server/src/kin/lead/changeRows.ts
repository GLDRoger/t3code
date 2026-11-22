import {
  type KinAgentChange,
  type KinAgentId,
  type KinOrgId,
  KinPersonId,
  KinAgentId as AgentId,
  KinRecordKey,
  KinRecordSide,
  KinRecordState,
  type KinWorkPrincipal,
  KIN_TAKEN_DEFAULT_FIELD,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import type { Patch } from "../work/KinRecords.ts";
import { isClosed, parseChanges } from "../work/recordRows.ts";
import { type KinViewer, seenBy } from "../work/teamView.ts";

/** How many of an agent's changes its page lists. */
const AGENT_CHANGES_SHOWN = 20;

type FieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};
export const isState = Schema.is(KinRecordState);
const isSide = Schema.is(KinRecordSide);

/** "person:<id>" or "agent:<id>", as a change records who held or waited. */
const principalOf = (shown: string): KinWorkPrincipal | undefined => {
  const [tag, ...rest] = shown.split(":");
  const id = rest.join(":");
  if (id === "") return undefined;
  return tag === "person"
    ? { _tag: "person", personId: KinPersonId.make(id) }
    : tag === "agent"
      ? { _tag: "agent", agentId: AgentId.make(id) }
      : undefined;
};
export const millisOf = (shown: string | null) => {
  if (shown === null) return null;
  const at = Date.parse(shown);
  return Number.isFinite(at) ? at : undefined;
};

/**
 * Words that ride along with a move and go when it is put back; nothing to restore of their own.
 * `KIN_TAKEN_DEFAULT_FIELD` names the question whose default made the change (`defaultTaken.ts`).
 */
export const ALONG = new Set(["reason", "handedBack", "untold", KIN_TAKEN_DEFAULT_FIELD]);

/**
 * What putting back one change's old values writes, or undefined when Kin can't do it on its own:
 * amounts, list details, a client or project moved (kept by key) and a doc's text. Links: `linkOf`.
 */
export const reversal = (change: {
  readonly kind: string;
  readonly registerId: string;
  readonly state: string;
  readonly fields: ReadonlyArray<FieldChange>;
}): Patch | undefined => {
  if (change.kind === "created")
    return change.registerId === "work" && isState(change.state) && !isClosed(change.state)
      ? { state: "dropped" }
      : undefined;
  if (change.kind !== "updated") return undefined;
  const patch: Record<string, unknown> = {};
  for (const { field, from } of change.fields) {
    if (ALONG.has(field)) continue;
    switch (field) {
      case "title":
        if (from === null || from.trim() === "") return undefined;
        patch.title = from;
        break;
      case "notes":
        patch.notes = from ?? "";
        break;
      case "state":
        if (from === null || !isState(from)) return undefined;
        patch.state = from;
        break;
      case "owner": {
        const owner = from === null ? undefined : principalOf(from);
        if (owner === undefined) return undefined;
        patch.owner = owner;
        break;
      }
      case "waitingOn": {
        const waitingOn = from === null ? null : principalOf(from);
        if (waitingOn === undefined) return undefined;
        patch.waitingOn = waitingOn;
        break;
      }
      case "due":
      case "date": {
        const at = millisOf(from);
        if (at === undefined) return undefined;
        patch[field === "due" ? "dueAt" : "dateAt"] = at;
        break;
      }
      case "dueAllDay":
        if (from !== "true" && from !== "false") return undefined;
        patch.dueAllDay = from === "true";
        break;
      case "category":
        patch.category = from;
        break;
      case "side":
        if (from === null || !isSide(from)) return undefined;
        patch.side = from;
        break;
      case "repo":
        patch.repo = from;
        break;
      case "alsoOn":
        patch.fields = { alsoOn: from === null ? null : from.split(", ") };
        break;
      default:
        return undefined;
    }
  }
  return Object.keys(patch).length === 0 ? undefined : (patch as Patch);
};

/** What a "linked" change put on, for Undo to take off. */
export const linkOf = (change: {
  readonly kind: string;
  readonly at: number;
  readonly fields: ReadonlyArray<FieldChange>;
}) => {
  const [made] = change.fields;
  return change.kind === "linked" && made !== undefined && made.to !== null
    ? { kind: made.field, shown: made.to, at: change.at }
    : undefined;
};

export type Row = {
  readonly seq: number;
  readonly recordId: string;
  readonly at: number;
  readonly key: string;
  readonly title: string;
  readonly registerId: string;
  readonly state: string;
  readonly kind: "created" | "updated" | "linked";
  readonly fieldsJson: string;
  readonly wakeupId: string | null;
  readonly since: number;
  readonly sinceOther: number;
  readonly nextJson: string | null;
  readonly linkLive: number;
  readonly otherKey: string | null;
  readonly otherTitle: string | null;
  readonly otherSeen: number;
};

/** Whether `next` put back exactly what `change` replaced, as an Undo of it writes. */
export const putBack = (
  change: { readonly kind: string; readonly fields: ReadonlyArray<FieldChange> },
  next: ReadonlyArray<FieldChange>,
) => {
  if (change.kind === "created")
    return next.some((one) => one.field === "state" && one.to === "dropped");
  const own = change.fields.filter((one) => !ALONG.has(one.field));
  return (
    own.length > 0 &&
    own.every((one) =>
      next.some((back) => back.field === one.field && back.from === one.to && back.to === one.from),
    )
  );
};

/** What every listed change reads, `c` with its entry `r`, as this viewer may see it. */
export const changeSql = (sql: SqlClient.SqlClient, viewer: KinViewer) => {
  // What stands in the way of undoing `c`: for an add, any later change; for an update, a later
  // one to the same field. A link is its own thing: it goes back while it is there.
  const later = (only: Statement.Fragment) => sql`FROM kin_record_changes l
    WHERE l.org_id = c.org_id AND l.record_id = c.record_id AND l.seq > c.seq
      AND l.actor_kind <> 'system' AND ${only}`;
  const inTheWay = sql`(c.kind = 'created' OR (c.kind = 'updated' AND l.kind <> 'linked'
    AND EXISTS (SELECT 1 FROM json_each(l.fields_json) lf, json_each(c.fields_json) cf
      WHERE json_extract(lf.value, '$.field') = json_extract(cf.value, '$.field')
        AND json_extract(cf.value, '$.field') NOT IN ${sql.in([...ALONG])})))`;
  const linked = sql`json_extract(c.fields_json, '$[0].to')`;
  return {
    columns: sql`c.seq, c.record_id AS "recordId", c.at, r.key, r.title, r.register_id AS "registerId",
        r.state, c.kind, c.fields_json AS "fieldsJson", c.wakeup_id AS "wakeupId",
        c.kind <> 'linked' AND EXISTS (SELECT 1 ${later(inTheWay)}) AS since,
        EXISTS (SELECT 1 ${later(sql`l.kind <> 'linked'`)}) AS "sinceOther",
        (SELECT l.fields_json ${later(inTheWay)} ORDER BY l.seq LIMIT 1) AS "nextJson",
        c.kind = 'linked' AND EXISTS (SELECT 1 FROM kin_record_links k WHERE k.org_id = c.org_id
          AND k.record_id = c.record_id AND k.kind = json_extract(c.fields_json, '$[0].field')
          AND k.created_at = c.at AND COALESCE(k.label, k.target) = ${linked}) AS "linkLive",
        o.key AS "otherKey", o.title AS "otherTitle",
        EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = o.org_id
          AND r.record_id = o.record_id AND ${seenBy(sql, viewer)}) AS "otherSeen"`,
    // A link both ways is one change: the half back to the entry linked first isn't listed.
    listed: sql`NOT (c.kind = 'linked' AND EXISTS (SELECT 1 FROM kin_record_changes p
          WHERE p.org_id = c.org_id AND p.kind = 'linked' AND p.actor_kind = c.actor_kind
            AND p.actor_id = c.actor_id AND p.seq < c.seq AND p.at BETWEEN c.at - 5000 AND c.at
            AND p.record_id = ${linked}
            AND json_extract(p.fields_json, '$[0].to') = c.record_id))`,
  };
};

/** A record link names the other end by id, or by key when it was given a label. */
export const otherEnd = (sql: SqlClient.SqlClient) => {
  const linked = sql`json_extract(c.fields_json, '$[0].to')`;
  return sql`LEFT JOIN kin_records o ON c.kind = 'linked'
    AND json_extract(c.fields_json, '$[0].field') = 'record' AND o.org_id = c.org_id
    AND (o.record_id = ${linked} OR o.key = ${linked})`;
};

export const rowsOf = Effect.fn("KinAgentChanges.rows")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  agentId: KinAgentId,
  seq?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const change = changeSql(sql, viewer);
  return yield* sql<Row>`SELECT ${change.columns}
      FROM kin_record_changes c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      ${otherEnd(sql)}
      WHERE c.org_id = ${orgId} AND c.actor_kind = 'agent' AND c.actor_id = ${agentId}
        AND ${seenBy(sql, viewer)}
        ${seq === undefined ? sql`` : sql`AND c.seq = ${seq}`}
        AND ${change.listed}
      ORDER BY c.seq DESC LIMIT ${AGENT_CHANGES_SHOWN}`;
});

export const changeOf = (row: Row): KinAgentChange => {
  const fields = parseChanges(row.fieldsJson).filter((change) => change.field.trim() !== "");
  const change = { ...row, fields };
  const base = {
    seq: row.seq,
    at: DateTime.formatIso(DateTime.makeUnsafe(row.at)),
    key: KinRecordKey.make(row.key),
    title: row.title,
    registerId: row.registerId,
    kind: row.kind,
    fields: fields.map((one) => ({ field: one.field, from: one.from, to: one.to })),
  };
  if (row.kind === "linked") {
    const live = row.linkLive === 1 && linkOf(change) !== undefined;
    return {
      ...base,
      undo: live,
      since: false,
      ...(live ? {} : { undone: true }),
      ...(fields[0]?.field !== "record"
        ? {}
        : {
            linkedTo:
              row.otherKey === null || row.otherTitle === null || row.otherSeen !== 1
                ? null
                : { key: KinRecordKey.make(row.otherKey), title: row.otherTitle },
          }),
    };
  }
  // Nothing is in the way of a change Kin can't put back anyway.
  const since = row.since === 1 && reversal(change) !== undefined;
  return {
    ...base,
    undo: !since && reversal(change) !== undefined,
    since,
    ...(row.nextJson !== null && putBack(change, parseChanges(row.nextJson))
      ? { undone: true }
      : {}),
    ...(since && row.kind === "created" && row.sinceOther !== 1 ? { linkedSince: true } : {}),
  };
};
