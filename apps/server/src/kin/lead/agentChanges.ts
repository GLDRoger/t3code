import {
  type KinAgentChange,
  type KinAgentId,
  KinAgentId as AgentId,
  KinChatError,
  type KinOrgId,
  KinPersonId,
  KinRecordKey,
  KinRecordSide,
  KinRecordState,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { KinRecords, type Patch } from "../work/KinRecords.ts";
import { tellMoved } from "../work/ownerWork.ts";
import { isClosed, parseChanges } from "../work/recordRows.ts";
import { KIN_OWNER_LEVEL, type KinViewer, seenBy } from "../work/teamView.ts";

/** How many of an agent's changes its page lists. */
const AGENT_CHANGES_SHOWN = 20;

type FieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
};
const isState = Schema.is(KinRecordState);
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
const millisOf = (shown: string | null) => {
  if (shown === null) return null;
  const at = Date.parse(shown);
  return Number.isFinite(at) ? at : undefined;
};

/** Words that ride along with a move and go when it is put back; nothing to restore of their own. */
const ALONG = new Set(["reason", "handedBack"]);

/**
 * What putting back one change's old values writes, or undefined when Kin can't do it on its own:
 * amounts, list details, a client or project moved (kept by key) and a doc's text. Links: `linkOf`.
 */
const reversal = (change: {
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
      default:
        return undefined;
    }
  }
  return Object.keys(patch).length === 0 ? undefined : (patch as Patch);
};

/** What a "linked" change put on, for Undo to take off. */
const linkOf = (change: {
  readonly kind: string;
  readonly at: number;
  readonly fields: ReadonlyArray<FieldChange>;
}) => {
  const [made] = change.fields;
  return change.kind === "linked" && made !== undefined && made.to !== null
    ? { kind: made.field, shown: made.to, at: change.at }
    : undefined;
};

type Row = {
  readonly seq: number;
  readonly recordId: string;
  readonly at: number;
  readonly key: string;
  readonly title: string;
  readonly registerId: string;
  readonly state: string;
  readonly kind: "created" | "updated" | "linked";
  readonly fieldsJson: string;
  readonly since: number;
  readonly sinceOther: number;
  readonly nextJson: string | null;
  readonly linkLive: number;
  readonly otherKey: string | null;
  readonly otherTitle: string | null;
  readonly otherSeen: number;
};

/** Whether `next` put back exactly what `change` replaced, as an Undo of it writes. */
const putBack = (
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

const rowsOf = Effect.fn("KinAgentChanges.rows")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  agentId: KinAgentId,
  seq?: number,
) {
  const sql = yield* SqlClient.SqlClient;
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
  return yield* sql<Row>`SELECT c.seq, c.record_id AS "recordId", c.at, r.key, r.title, r.register_id AS "registerId",
        r.state, c.kind, c.fields_json AS "fieldsJson",
        c.kind <> 'linked' AND EXISTS (SELECT 1 ${later(inTheWay)}) AS since,
        EXISTS (SELECT 1 ${later(sql`l.kind <> 'linked'`)}) AS "sinceOther",
        (SELECT l.fields_json ${later(inTheWay)} ORDER BY l.seq LIMIT 1) AS "nextJson",
        c.kind = 'linked' AND EXISTS (SELECT 1 FROM kin_record_links k WHERE k.org_id = c.org_id
          AND k.record_id = c.record_id AND k.kind = json_extract(c.fields_json, '$[0].field')
          AND k.created_at = c.at AND COALESCE(k.label, k.target) = ${linked}) AS "linkLive",
        o.key AS "otherKey", o.title AS "otherTitle",
        EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = o.org_id
          AND r.record_id = o.record_id AND ${seenBy(sql, viewer)}) AS "otherSeen"
      FROM kin_record_changes c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      -- A record link names the other end by id, or by key when it was given a label.
      LEFT JOIN kin_records o ON c.kind = 'linked'
        AND json_extract(c.fields_json, '$[0].field') = 'record' AND o.org_id = c.org_id
        AND (o.record_id = ${linked} OR o.key = ${linked})
      WHERE c.org_id = ${orgId} AND c.actor_kind = 'agent' AND c.actor_id = ${agentId}
        AND ${seenBy(sql, viewer)}
        ${seq === undefined ? sql`` : sql`AND c.seq = ${seq}`}
        -- A link both ways is one change: the half back to the entry linked first isn't listed.
        AND NOT (c.kind = 'linked' AND EXISTS (SELECT 1 FROM kin_record_changes p
          WHERE p.org_id = c.org_id AND p.kind = 'linked' AND p.actor_kind = c.actor_kind
            AND p.actor_id = c.actor_id AND p.seq < c.seq AND p.at BETWEEN c.at - 5000 AND c.at
            AND p.record_id = ${linked}
            AND json_extract(p.fields_json, '$[0].to') = c.record_id))
      ORDER BY c.seq DESC LIMIT ${AGENT_CHANGES_SHOWN}`;
});

const changeOf = (row: Row): KinAgentChange => {
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

/** The agent's last record changes this viewer sees, newest first, kept on each record. */
export const agentChanges = Effect.fn("KinAgentChanges.list")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  return (yield* rowsOf(viewer, orgId, agentId)).map(changeOf);
});

/**
 * Puts back what one of the agent's changes replaced, as `by`'s own change, recorded on the entry
 * like any edit; whoever holds a task it moves is told. Refused once the entry changed since.
 */
export const ownerLevelUndoAgentChange = Effect.fn("KinAgentChanges.undo")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly seq: number;
  readonly by: KinPersonId;
}) {
  const [row] = yield* rowsOf(KIN_OWNER_LEVEL, input.orgId, input.agentId, input.seq);
  if (row === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "That change isn't there." });
  if (changeOf(row).since)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} changed since, so Kin won't put this back over it. Open it to change it yourself.`,
    });
  const writer = {
    actor: { _tag: "person", personId: input.by },
    via: "owner",
    askedBy: input.by,
  } as const;
  const records = yield* KinRecords;
  const made = linkOf({ ...row, fields: parseChanges(row.fieldsJson) });
  if (made !== undefined) {
    if (yield* records.unlink(input.orgId, writer, row.recordId, made)) return;
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `That link on ${row.key} is already gone.`,
    });
  }
  const patch = reversal({ ...row, fields: parseChanges(row.fieldsJson) });
  if (patch === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `Kin can't put this change to ${row.key} back on its own. Open it to change it yourself.`,
    });
  const before = yield* records.get(input.orgId, row.key);
  yield* records.update(input.orgId, writer, row.key, patch);
  yield* tellMoved(
    { _tag: "person", orgId: input.orgId, personId: input.by },
    before,
    yield* records.get(input.orgId, row.key),
  );
});
