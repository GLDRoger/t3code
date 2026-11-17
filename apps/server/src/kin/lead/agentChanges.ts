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

import { KinRecords, type Patch } from "../work/KinRecords.ts";
import { tellMoved } from "../work/ownerWork.ts";
import { isClosed, parseChanges } from "../work/recordRows.ts";

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
 * amounts, list details, links, a client or project moved (kept by key) and a doc's text.
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

type Row = {
  readonly seq: number;
  readonly at: number;
  readonly key: string;
  readonly title: string;
  readonly registerId: string;
  readonly state: string;
  readonly kind: "created" | "updated" | "linked";
  readonly fieldsJson: string;
  readonly since: number;
};

const rowsOf = Effect.fn("KinAgentChanges.rows")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
  seq?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // Owner-level only (its page's check): every record, private ones included.
  return yield* sql<Row>`SELECT c.seq, c.at, r.key, r.title, r.register_id AS "registerId",
        r.state, c.kind, c.fields_json AS "fieldsJson",
        EXISTS (SELECT 1 FROM kin_record_changes l WHERE l.org_id = c.org_id
          AND l.record_id = c.record_id AND l.seq > c.seq AND l.actor_kind <> 'system') AS since
      FROM kin_record_changes c
      JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      WHERE c.org_id = ${orgId} AND c.actor_kind = 'agent' AND c.actor_id = ${agentId}
        ${seq === undefined ? sql`` : sql`AND c.seq = ${seq}`}
      ORDER BY c.seq DESC LIMIT ${AGENT_CHANGES_SHOWN}`;
});

const changeOf = (row: Row): KinAgentChange => {
  const fields = parseChanges(row.fieldsJson).filter((change) => change.field.trim() !== "");
  const since = row.since === 1;
  return {
    seq: row.seq,
    at: DateTime.formatIso(DateTime.makeUnsafe(row.at)),
    key: KinRecordKey.make(row.key),
    title: row.title,
    registerId: row.registerId,
    kind: row.kind,
    fields: fields.map((change) => ({ field: change.field, from: change.from, to: change.to })),
    undo: !since && reversal({ ...row, fields }) !== undefined,
    since,
  };
};

/** The agent's last record changes, newest first: the ones "undo it" reads, kept on each record. */
export const ownerLevelAgentChanges = Effect.fn("KinAgentChanges.list")(function* (
  orgId: KinOrgId,
  agentId: KinAgentId,
) {
  return (yield* rowsOf(orgId, agentId)).map(changeOf);
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
  const [row] = yield* rowsOf(input.orgId, input.agentId, input.seq);
  if (row === undefined)
    return yield* new KinChatError({ reason: "not_found", message: "That change isn't there." });
  if (row.since === 1)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `${row.key} changed since, so Kin won't put this back over it. Open it to change it yourself.`,
    });
  const patch = reversal({ ...row, fields: parseChanges(row.fieldsJson) });
  if (patch === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: `Kin can't put this change to ${row.key} back on its own. Open it to change it yourself.`,
    });
  const records = yield* KinRecords;
  const before = yield* records.get(input.orgId, row.key);
  yield* records.update(
    input.orgId,
    { actor: { _tag: "person", personId: input.by }, via: "owner", askedBy: input.by },
    row.key,
    patch,
  );
  yield* tellMoved(
    { _tag: "person", orgId: input.orgId, personId: input.by },
    before,
    yield* records.get(input.orgId, row.key),
  );
});
