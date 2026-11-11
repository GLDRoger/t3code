// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinRecordCategory,
  KinRecordKey,
  KinRecordSide,
  KinRecordState,
  type KinOrgId,
  type KinWorkPrincipal,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { SHARED_REFUSAL, turnChat } from "../lead/Audience.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { KinRecords, type Patch, type Writer } from "./KinRecords.ts";
import { endOfDay, iso, notFound, ownerZone, type RecordRow, toRecord } from "./recordRows.ts";

/** The lead tools' inputs, results and the one call each makes. Model-facing text lives in `mcp/tools.ts`. */

const Who = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
  description:
    '"me" for you, "owner" for the owner, or a lead\'s agentId from kin_leads. Never a name.',
});
const Due = Schema.NullOr(
  Schema.String.check(
    Schema.isPattern(
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/,
    ),
  ),
).annotate({
  description:
    "A calendar day in the owner's time zone (2026-11-20), or a time with its offset (2026-11-20T18:00+05:30). null clears it.",
});
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(280));
const Notes = Schema.String.check(Schema.isMaxLength(4_000));

export const QueryInput = Schema.Struct({
  owner: Schema.optional(Who),
  states: Schema.optional(Schema.Array(KinRecordState)),
  open: Schema.optional(Schema.Boolean).annotate({ description: "Neither done nor dropped." }),
  late: Schema.optional(Schema.Boolean),
  dueBefore: Schema.optional(Schema.String).annotate({ description: "An ISO time with offset." }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  keys: Schema.optional(Schema.Array(KinRecordKey).check(Schema.isMaxLength(50))),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50)),
  ),
});
const Row = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: KinRecordState,
  owner: Schema.String,
  waitingOn: Schema.optional(Schema.String),
  due: Schema.optional(Schema.String),
  late: Schema.optional(Schema.Literal(true)),
  suggested: Schema.optional(Schema.Literal(true)),
  working: Schema.optional(Schema.Literal(true)),
  pullRequest: Schema.optional(Schema.String),
  rev: Schema.Number,
});
export const QueryResult = Schema.Struct({
  asOf: Schema.String,
  total: Schema.Number,
  records: Schema.Array(Row),
});
export const GetInput = Schema.Struct({ key: KinRecordKey });
export const GetResult = Schema.Struct({
  ...Row.fields,
  notes: Schema.String,
  assignedBy: Schema.optional(Schema.String),
  links: Schema.Array(
    Schema.Struct({ kind: Schema.String, relation: Schema.String, target: Schema.String }),
  ),
  history: Schema.Array(
    Schema.Struct({ at: Schema.String, by: Schema.String, change: Schema.String }),
  ),
});
const CreateRow = Schema.Struct({
  title: Title,
  owner: Schema.optional(Who),
  state: Schema.optional(KinRecordState),
  waitingOn: Schema.optional(Who),
  due: Schema.optional(Due),
  notes: Schema.optional(Notes),
  category: Schema.optional(KinRecordCategory),
  side: Schema.optional(KinRecordSide),
  suggested: Schema.optional(Schema.Boolean),
});
export const CreateInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString,
  records: Schema.Array(CreateRow).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export const CreateResult = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({ key: Schema.String, title: Schema.String, created: Schema.Boolean }),
  ),
});
export const UpdateInput = Schema.Struct({
  key: KinRecordKey,
  sourceEventId: TrimmedNonEmptyString,
  title: Schema.optional(Title),
  state: Schema.optional(KinRecordState),
  waitingOn: Schema.optional(Who),
  owner: Schema.optional(Who),
  due: Schema.optional(Due),
  notes: Schema.optional(Notes),
  category: Schema.optional(KinRecordCategory),
  side: Schema.optional(KinRecordSide),
  confirmed: Schema.optional(Schema.Boolean),
  expectedRev: Schema.optional(Schema.Int),
});
export const UpdateResult = Schema.Struct({
  key: Schema.String,
  rev: Schema.Number,
  state: KinRecordState,
  changed: Schema.Array(Schema.String),
});

type Lead = Effect.Success<ReturnType<typeof resolveLead>>;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** Who the turn's events came from, by stored author: the owner only when every one is the owner's. */
const askedBy = Effect.fn("KinWorkTools.askedBy")(function* (lead: Lead) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ person: string | null; owner: string }>`
    SELECT CASE
        WHEN json_extract(e.json, '$.origin.personId') IS NOT NULL THEN NULL
        WHEN e.tag IN ('chat.message', 'widget.action') AND m.author_kind = 'human'
          AND m.chat_id = json_extract(e.json, '$.chatId') THEN m.author_person_id
        WHEN e.tag IN ('chat.reaction', 'record.changed')
          AND json_extract(e.json, '$.provenance._tag') = 'human'
          THEN json_extract(e.json, '$.provenance.personId')
        ELSE NULL END AS person, a.owner_person_id AS owner
    FROM kin_events e JOIN kin_agents a ON a.org_id = e.org_id AND a.agent_id = e.agent_id
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId} AND e.wakeup_id = ${lead.wakeupId}
    ORDER BY e.event_id`;
  const owner = rows[0]?.owner;
  return owner !== undefined && rows.every((row) => row.person === owner)
    ? KinPersonId.make(owner)
    : null;
});

const sourceOf = Effect.fn("KinWorkTools.sourceOf")(function* (lead: Lead, eventId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ tag: string; chatId: string | null; messageId: string | null }>`
    SELECT tag, json_extract(json, '$.chatId') AS "chatId",
      json_extract(json, '$.messageId') AS "messageId"
    FROM kin_events WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}
      AND wakeup_id = ${lead.wakeupId} AND event_id = ${eventId} ORDER BY event_id`;
  if (row === undefined)
    return yield* invalid("sourceEventId must be one of this turn's events. Nothing was written.");
  return row.tag === "chat.message" && row.chatId !== null && row.messageId !== null
    ? { chatId: KinChatId.make(row.chatId), messageId: KinMessageId.make(row.messageId) }
    : undefined;
});

const resolveWho = Effect.fn("KinWorkTools.resolveWho")(function* (lead: Lead, who: string) {
  const sql = yield* SqlClient.SqlClient;
  if (who === "me") return { _tag: "agent", agentId: lead.agentId } satisfies KinWorkPrincipal;
  if (who === "owner") {
    const [row] = yield* sql<{ owner: string }>`SELECT owner_person_id AS owner FROM kin_agents
      WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`;
    if (row === undefined) return yield* invalid("No owner found.");
    return { _tag: "person", personId: KinPersonId.make(row.owner) } satisfies KinWorkPrincipal;
  }
  return { _tag: "agent", agentId: KinAgentId.make(who) } satisfies KinWorkPrincipal;
});

const dueOf = Effect.fn("KinWorkTools.dueOf")(function* (orgId: KinOrgId, due: string | null) {
  if (due === null) return { dueAt: null, dueAllDay: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(due))
    return { dueAt: endOfDay(due, yield* ownerZone(orgId)), dueAllDay: true };
  const ms = Date.parse(due);
  if (!Number.isFinite(ms))
    return yield* invalid(`due ${due.slice(0, 40)} is not a day or a time.`);
  return { dueAt: ms, dueAllDay: false };
});

/** How a lead reads names: itself as "you", the owner as "owner", other leads by name. */
const namer = Effect.fn("KinWorkTools.namer")(function* (lead: Lead) {
  const sql = yield* SqlClient.SqlClient;
  const agents = yield* sql<{ id: string; name: string }>`SELECT agent_id AS id,
      display_name AS name FROM kin_agents WHERE org_id = ${lead.orgId} ORDER BY agent_id`;
  const people = yield* sql<{ id: string; name: string; owner: number }>`SELECT p.person_id AS id,
      p.display_name AS name, p.person_id = a.owner_person_id AS owner
    FROM kin_people p JOIN kin_agents a ON a.org_id = p.org_id AND a.agent_id = ${lead.agentId}
    WHERE p.org_id = ${lead.orgId} ORDER BY p.person_id`;
  const agentNames = new Map(agents.map((row) => [row.id, row.name]));
  const personNames = new Map(people.map((row) => [row.id, row.owner === 1 ? "owner" : row.name]));
  return (who: KinWorkPrincipal | null) =>
    who === null
      ? undefined
      : who._tag === "agent"
        ? who.agentId === lead.agentId
          ? "you"
          : `${agentNames.get(who.agentId) ?? "a lead"} (${who.agentId})`
        : (personNames.get(who.personId) ?? "a person");
});

const rowFor = (
  name: (who: KinWorkPrincipal | null) => string | undefined,
  row: RecordRow,
  now: number,
) => {
  const record = toRecord(row, now);
  const waitingOn = name(record.waitingOn);
  return {
    key: record.key,
    title: record.title,
    state: record.state,
    owner: name(record.owner) ?? "someone",
    ...(waitingOn === undefined ? {} : { waitingOn }),
    ...(record.dueAt === null
      ? {}
      : { due: record.dueAllDay ? record.dueAt.slice(0, 10) : record.dueAt }),
    ...(record.late ? { late: true as const } : {}),
    ...(record.confirmed ? {} : { suggested: true as const }),
    ...(record.working ? { working: true as const } : {}),
    ...(record.pullRequest === null ? {} : { pullRequest: record.pullRequest.url }),
    rev: record.rev,
  };
};

/** Refused, as the gate does, if the turn became one others read since the call was admitted. */
const admitted = Effect.fn("KinWorkTools.admitted")(function* (
  lead: Lead,
  tool: string,
  args: unknown,
) {
  if (!(yield* toolAdmitted(lead, tool, args)))
    return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
});

const writerFor = Effect.fn("KinWorkTools.writer")(function* (lead: Lead) {
  const chat = yield* turnChat(lead);
  return {
    actor: { _tag: "agent", agentId: lead.agentId },
    via: "lead",
    wakeupId: lead.wakeupId,
    ...(chat === undefined ? {} : { chatId: KinChatId.make(chat.chatId) }),
    askedBy: yield* askedBy(lead),
  } satisfies Writer;
});

const retryKey = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

export const query = Effect.fn("KinWorkTools.query")(function* (
  scope: McpInvocationScope,
  input: typeof QueryInput.Type,
) {
  const lead = yield* resolveLead(scope);
  const records = yield* KinRecords;
  const owner = input.owner === undefined ? undefined : yield* resolveWho(lead, input.owner);
  const dueBy = input.dueBefore === undefined ? undefined : Date.parse(input.dueBefore);
  if (dueBy !== undefined && !Number.isFinite(dueBy))
    return yield* invalid("dueBefore is not a time.");
  const page = yield* records.query(lead.orgId, {
    ...(owner === undefined ? {} : { owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(dueBy === undefined ? {} : { dueBy }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.keys === undefined ? {} : { keys: input.keys }),
    limit: input.limit ?? 20,
  });
  const now = yield* Clock.currentTimeMillis;
  const name = yield* namer(lead);
  return {
    asOf: iso(now),
    total: page.total,
    records: page.rows.map((row) => rowFor(name, row, now)),
  };
});

export const get = Effect.fn("KinWorkTools.get")(function* (
  scope: McpInvocationScope,
  input: typeof GetInput.Type,
) {
  const lead = yield* resolveLead(scope);
  const records = yield* KinRecords;
  const row = yield* records.get(lead.orgId, input.key);
  if (row === undefined) return yield* notFound(input.key);
  const detail = yield* records.detail(row, 10);
  const now = yield* Clock.currentTimeMillis;
  const name = yield* namer(lead);
  const actor = (by: (typeof detail.changes)[number]["by"]) =>
    by._tag === "system" ? "Kin" : (name(by) ?? "someone");
  const assignedBy = name(detail.assignedBy);
  return {
    ...rowFor(name, row, now),
    notes: detail.notes,
    ...(assignedBy === undefined ? {} : { assignedBy }),
    links: detail.links.map((link) => ({
      kind: link.kind,
      relation: link.relation,
      target: link.label ?? link.target,
    })),
    history: detail.changes.map((change) => ({
      at: change.at,
      by: actor(change.by),
      change:
        change.kind === "created"
          ? "created"
          : change.fields.map((field) => `${field.field}: ${field.to ?? "cleared"}`).join("; "),
    })),
  };
});

export const create = Effect.fn("KinWorkTools.create")(function* (
  scope: McpInvocationScope,
  input: typeof CreateInput.Type,
) {
  const lead = yield* resolveLead(scope);
  yield* admitted(lead, "record_create", input);
  const records = yield* KinRecords;
  const source = yield* sourceOf(lead, input.sourceEventId);
  const writer = yield* writerFor(lead);
  const results = [];
  for (const row of input.records) {
    const owner = yield* resolveWho(lead, row.owner ?? "me");
    const waitingOn =
      row.waitingOn === undefined ? undefined : yield* resolveWho(lead, row.waitingOn);
    const due = row.due === undefined ? {} : yield* dueOf(lead.orgId, row.due);
    // The same row from the same event is the same entry: a retry, or a repeat in one call.
    const originKey = `lead:${lead.agentId}:${input.sourceEventId}:${retryKey(titleKey(row.title))}`;
    const { row: stored, created } = yield* records.create(lead.orgId, writer, {
      originKey,
      title: row.title,
      owner,
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(waitingOn === undefined ? {} : { waitingOn }),
      ...due,
      ...(row.notes === undefined ? {} : { notes: row.notes }),
      ...(row.category === undefined ? {} : { category: row.category }),
      ...(row.side === undefined ? {} : { side: row.side }),
      // What the owner asked for is confirmed; what a lead inferred waits for the owner.
      confirmed: row.suggested !== true && writer.askedBy !== null,
      ...(source === undefined ? {} : { source }),
    });
    results.push({ key: stored.key, title: stored.title, created });
  }
  return { records: results };
});

export const update = Effect.fn("KinWorkTools.update")(function* (
  scope: McpInvocationScope,
  input: typeof UpdateInput.Type,
) {
  const lead = yield* resolveLead(scope);
  yield* admitted(lead, "record_update", input);
  const records = yield* KinRecords;
  yield* sourceOf(lead, input.sourceEventId);
  const writer = yield* writerFor(lead);
  const patch: Patch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.waitingOn === undefined
      ? {}
      : { waitingOn: yield* resolveWho(lead, input.waitingOn) }),
    ...(input.owner === undefined ? {} : { owner: yield* resolveWho(lead, input.owner) }),
    ...(input.due === undefined ? {} : yield* dueOf(lead.orgId, input.due)),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(input.category === undefined ? {} : { category: input.category }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
  };
  const before = yield* records.get(lead.orgId, input.key);
  if (before === undefined) return yield* notFound(input.key);
  const after = yield* records.update(lead.orgId, writer, input.key, patch, input.expectedRev);
  const changed =
    after.rev === before.rev
      ? []
      : ((yield* records.detail(after, 1)).changes[0]?.fields.map((field) => field.field) ?? []);
  return { key: after.key, rev: after.rev, state: after.state, changed };
});
