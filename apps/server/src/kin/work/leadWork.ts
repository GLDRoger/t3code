// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinPartyKind,
  KinRecordCategory,
  KinRecordKey,
  KinRecordSide,
  KinRecordState,
  KinRepoName,
  KinWorkListName,
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
import { partyPage, projectDetail } from "./crm.ts";
import { type GroupBy, KinRecords, type Patch, type Writer } from "./KinRecords.ts";
import { fieldList, fieldText, LISTS, type ListName, listOf, parseFields } from "./lists.ts";
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
const List = KinWorkListName.annotate({
  description: "work (default), clients, contacts or projects.",
});
const Client = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "A client or vendor: its key (C-3) or exact name.",
});
const Project = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "A project: its key (P-2) or exact name.",
});
const Detail = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Terms = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const Repos = Schema.Array(KinRepoName).check(Schema.isMaxLength(20));

export const QueryInput = Schema.Struct({
  list: Schema.optional(List),
  client: Schema.optional(Client),
  project: Schema.optional(Project),
  side: Schema.optional(KinRecordSide),
  repo: Schema.optional(KinRepoName),
  groupBy: Schema.optional(
    Schema.Literals(["client", "project", "side", "owner", "state"]),
  ).annotate({ description: "Also count the matches per group." }),
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
  list: Schema.optional(KinWorkListName),
  client: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  side: Schema.optional(Schema.Literal("theirs")),
  kind: Schema.optional(KinPartyKind),
  repo: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  phone: Schema.optional(Schema.String),
  terms: Schema.optional(Schema.String),
  repos: Schema.optional(Schema.Array(Schema.String)),
  sensitive: Schema.optional(Schema.Literal(true)),
  rev: Schema.Number,
});
export const QueryResult = Schema.Struct({
  asOf: Schema.String,
  total: Schema.Number,
  records: Schema.Array(Row),
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({ group: Schema.String, count: Schema.Number, late: Schema.Number }),
    ),
  ),
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
  /** A client's: what each side owes, open, its contacts and its projects. */
  owed: Schema.optional(
    Schema.Struct({
      weOwe: Schema.Number,
      theyOwe: Schema.Number,
      late: Schema.Number,
      overdue: Schema.Number,
    }),
  ),
  contacts: Schema.optional(Schema.Array(Schema.Struct({ ...Row.fields }))),
  projects: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        title: Schema.String,
        health: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  /** A project's, computed now. */
  status: Schema.optional(
    Schema.Struct({
      health: Schema.NullOr(Schema.String),
      open: Schema.Number,
      late: Schema.Number,
      waitingOverAWeek: Schema.Number,
      targetPassed: Schema.Boolean,
    }),
  ),
});
const CreateRow = Schema.Struct({
  list: Schema.optional(List),
  title: Title,
  owner: Schema.optional(Who),
  state: Schema.optional(KinRecordState),
  waitingOn: Schema.optional(Who),
  due: Schema.optional(Due),
  notes: Schema.optional(Notes),
  category: Schema.optional(KinRecordCategory),
  side: Schema.optional(KinRecordSide),
  client: Schema.optional(Client),
  project: Schema.optional(Project),
  repo: Schema.optional(KinRepoName),
  kind: Schema.optional(KinPartyKind),
  role: Schema.optional(Detail),
  email: Schema.optional(Detail),
  phone: Schema.optional(Detail),
  terms: Schema.optional(Terms),
  repos: Schema.optional(Repos),
  sensitive: Schema.optional(Schema.Literal(true)),
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
  client: Schema.optional(Schema.NullOr(Client)),
  project: Schema.optional(Schema.NullOr(Project)),
  repo: Schema.optional(Schema.NullOr(KinRepoName)),
  kind: Schema.optional(KinPartyKind),
  role: Schema.optional(Schema.NullOr(Detail)),
  email: Schema.optional(Schema.NullOr(Detail)),
  phone: Schema.optional(Schema.NullOr(Detail)),
  terms: Schema.optional(Schema.NullOr(Terms)),
  repos: Schema.optional(Repos),
  sensitive: Schema.optional(Schema.Literal(true)),
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
  const list = listOf(row.registerId);
  const fields = parseFields(row.fieldsJson);
  const text = (key: string) => {
    const value = fieldText(fields, key);
    return value === null ? {} : { [key]: value };
  };
  const repos = fieldList(fields, "repos");
  return {
    ...(list === "work" ? {} : { list }),
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
    ...(record.party === undefined
      ? {}
      : { client: `${record.party.title} (${record.party.key})` }),
    ...(record.project === undefined
      ? {}
      : { project: `${record.project.title} (${record.project.key})` }),
    ...(row.side === "theirs" && list === "work" ? { side: "theirs" as const } : {}),
    ...(list === "clients" ? { kind: row.category === "vendor" ? "vendor" : "client" } : {}),
    ...(row.repo === null ? {} : { repo: row.repo }),
    ...text("role"),
    ...text("email"),
    ...text("phone"),
    ...text("terms"),
    ...(repos.length === 0 ? {} : { repos: [...repos] }),
    ...(record.sensitive || record.sensitiveInherited === true ? { sensitive: true as const } : {}),
    rev: record.rev,
  } as typeof Row.Type;
};

/** A client or project the lead named by key or exact name, among the active ones. */
const resolveRef = Effect.fn("KinWorkTools.resolveRef")(function* (
  lead: Lead,
  text: string,
  list: "clients" | "projects",
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; key: string }>`SELECT record_id AS "recordId", key
    FROM kin_records WHERE org_id = ${lead.orgId} AND register_id = ${list}
      AND (key = ${text.toUpperCase()} OR (lower(title) = lower(${text})
        AND state NOT IN ('done', 'dropped')))
    ORDER BY key = ${text.toUpperCase()} DESC, key LIMIT 3`;
  const noun = LISTS[list].noun;
  if (rows.length === 0)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No ${noun} ${text.slice(0, 60)}. Find it with records_query list ${list}, or create it first.`,
    });
  if (rows.length > 1 && rows[0]!.key !== text.toUpperCase())
    return yield* invalid(
      `Several ${list} are named ${text.slice(0, 60)}: ${rows.map((row) => row.key).join(", ")}. Use the key.`,
    );
  return rows[0]!.recordId;
});
const refOrNull = Effect.fn("KinWorkTools.refOrNull")(function* (
  lead: Lead,
  text: string | null | undefined,
  list: "clients" | "projects",
) {
  if (text === undefined || text === null) return text;
  return yield* resolveRef(lead, text, list);
});

/** The list's own fields a row or an update names; `null` clears one. */
const fieldsFrom = (row: {
  readonly role?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly terms?: string | null | undefined;
  readonly repos?: ReadonlyArray<string> | undefined;
}) =>
  Object.fromEntries(
    (["role", "email", "phone", "terms", "repos"] as const).flatMap((key) =>
      row[key] === undefined ? [] : [[key, row[key]]],
    ),
  ) as Record<string, string | ReadonlyArray<string> | null>;

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
  const partyId =
    input.client === undefined ? undefined : yield* resolveRef(lead, input.client, "clients");
  const projectId =
    input.project === undefined ? undefined : yield* resolveRef(lead, input.project, "projects");
  const filter = {
    ...(input.list === undefined ? {} : { list: input.list }),
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(owner === undefined ? {} : { owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(dueBy === undefined ? {} : { dueBy }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.keys === undefined ? {} : { keys: input.keys }),
  };
  const page = yield* records.query(lead.orgId, { ...filter, limit: input.limit ?? 20 });
  const now = yield* Clock.currentTimeMillis;
  const name = yield* namer(lead);
  const groups =
    input.groupBy === undefined ? undefined : yield* groupsFor(lead, name, filter, input.groupBy);
  return {
    asOf: iso(now),
    total: page.total,
    records: page.rows.map((row) => rowFor(name, row, now)),
    ...(groups === undefined ? {} : { groups }),
  };
});

const GROUP_BY: Record<NonNullable<typeof QueryInput.Type.groupBy>, GroupBy> = {
  client: "party",
  project: "project",
  side: "side",
  owner: "owner",
  state: "state",
};
const groupsFor = Effect.fn("KinWorkTools.groups")(function* (
  lead: Lead,
  name: (who: KinWorkPrincipal | null) => string | undefined,
  filter: Parameters<KinRecords["Service"]["groups"]>[1],
  by: NonNullable<typeof QueryInput.Type.groupBy>,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const rows = yield* records.groups(lead.orgId, filter, GROUP_BY[by]);
  const ids = rows.flatMap((row) => (row.group === null ? [] : [row.group]));
  const titles =
    (by === "client" || by === "project") && ids.length > 0
      ? new Map(
          (yield* sql<{ id: string; label: string }>`SELECT record_id AS id,
              title || ' (' || key || ')' AS label
            FROM kin_records WHERE org_id = ${lead.orgId} AND record_id IN ${sql.in(ids)}
            ORDER BY record_id`).map((row) => [row.id, row.label]),
        )
      : new Map<string, string>();
  const label = (group: string | null) => {
    if (group === null) return "none";
    if (by === "client" || by === "project") return titles.get(group) ?? "none";
    if (by !== "owner") return group;
    const [kind, ...id] = group.split(":");
    const who: KinWorkPrincipal | null =
      kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id.join(":")) }
        : kind === "person"
          ? { _tag: "person", personId: KinPersonId.make(id.join(":")) }
          : null;
    return name(who) ?? "someone";
  };
  return rows.map((row) => ({ group: label(row.group), count: row.count, late: row.late }));
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
  const list = listOf(row.registerId);
  const page = list === "clients" ? yield* partyPage(row, now, 0) : undefined;
  const project = list === "projects" ? yield* projectDetail(row, now) : undefined;
  return {
    ...rowFor(name, row, now),
    ...(page === undefined
      ? {}
      : {
          owed: {
            weOwe: page.party.weOwe,
            theyOwe: page.party.theyOwe,
            late: page.party.late,
            overdue: page.party.overdue,
          },
          contacts: (yield* records.query(lead.orgId, {
            list: "contacts",
            partyId: row.recordId,
            limit: 50,
          })).rows.map((contact) => rowFor(name, contact, now)),
          projects: page.projects.map((one) => ({
            key: one.key,
            title: one.name,
            health: one.health,
          })),
        }),
    ...(project === undefined
      ? {}
      : {
          status: {
            health: project.health,
            open: project.open,
            late: project.late,
            waitingOverAWeek: project.healthBecause.waitingOverAWeek,
            targetPassed: project.healthBecause.targetPassed,
          },
        }),
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
    const list: ListName = row.list ?? "work";
    // A client or contact is the owner's to look after unless told otherwise.
    const owner = yield* resolveWho(
      lead,
      row.owner ?? (list === "clients" || list === "contacts" ? "owner" : "me"),
    );
    const waitingOn =
      row.waitingOn === undefined ? undefined : yield* resolveWho(lead, row.waitingOn);
    const due = row.due === undefined ? {} : yield* dueOf(lead.orgId, row.due);
    // Rows earlier in this call are already stored, so a contact can name the client just made.
    const partyId = yield* refOrNull(lead, row.client, "clients");
    const projectId = yield* refOrNull(lead, row.project, "projects");
    // Setting up a client twice finds the one that is there instead of making another.
    const existing =
      list === "work" ? undefined : yield* sameNamed(lead, list, row.title, partyId ?? null);
    if (existing !== undefined) {
      results.push({ key: existing.key, title: existing.title, created: false });
      continue;
    }
    // The same row from the same event is the same entry: a retry, or a repeat in one call.
    const rowKey =
      list === "work"
        ? titleKey(row.title) + (partyId === undefined || partyId === null ? "" : `|${partyId}`)
        : `${list}|${partyId ?? ""}|${titleKey(row.title)}`;
    const originKey = `lead:${lead.agentId}:${input.sourceEventId}:${retryKey(rowKey)}`;
    const fields = fieldsFrom(row);
    const { row: stored, created } = yield* records.create(lead.orgId, writer, {
      list,
      originKey,
      title: row.title,
      owner,
      ...(partyId === undefined ? {} : { partyId }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(row.repo === undefined ? {} : { repo: row.repo }),
      ...(row.sensitive === undefined ? {} : { sensitive: true }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(waitingOn === undefined ? {} : { waitingOn }),
      ...due,
      ...(row.notes === undefined ? {} : { notes: row.notes }),
      ...categoryOf(list, row),
      ...(row.side === undefined ? {} : { side: row.side }),
      // What the owner asked for is confirmed; what a lead inferred waits for the owner.
      confirmed: row.suggested !== true && writer.askedBy !== null,
      ...(source === undefined ? {} : { source }),
    });
    results.push({ key: stored.key, title: stored.title, created });
  }
  return { records: results };
});

/** A client's kind or a Work entry's category; a client with neither is a client. */
const categoryOf = (
  list: ListName,
  row: { readonly kind?: string | undefined; readonly category?: string | undefined },
) => {
  const category = row.kind ?? row.category ?? (list === "clients" ? "client" : undefined);
  return category === undefined ? {} : { category };
};

const sameNamed = Effect.fn("KinWorkTools.sameNamed")(function* (
  lead: Lead,
  list: ListName,
  title: string,
  partyId: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ key: string; title: string }>`SELECT key, title FROM kin_records
    WHERE org_id = ${lead.orgId} AND register_id = ${list} AND state NOT IN ('done', 'dropped')
      AND lower(title) = lower(${title}) AND (${list} != 'contacts' OR party_id IS ${partyId})
    ORDER BY key LIMIT 1`;
  return row;
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
    ...(input.kind === undefined ? {} : { category: input.kind }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(input.sensitive === undefined ? {} : { sensitive: true }),
  };
  const partyId = yield* refOrNull(lead, input.client, "clients");
  const projectId = yield* refOrNull(lead, input.project, "projects");
  const fields = fieldsFrom(input);
  const full: Patch = {
    ...patch,
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  };
  const before = yield* records.get(lead.orgId, input.key);
  if (before === undefined) return yield* notFound(input.key);
  const after = yield* records.update(lead.orgId, writer, input.key, full, input.expectedRev);
  const changed =
    after.rev === before.rev
      ? []
      : ((yield* records.detail(after, 1)).changes[0]?.fields.map((field) => field.field) ?? []);
  return { key: after.key, rev: after.rev, state: after.state, changed };
});
