// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous retry-key hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinDay,
  KinListId,
  KinPartyKind,
  KinRecordKey,
  KinRepeatRule,
  KinRecordSide,
  KinRecordState,
  KinRepoName,
  type KinMoney,
  type KinOrgId,
  type KinWorkPrincipal,
  TrimmedNonEmptyString,
  calendarTimeMillis,
  isCalendarDay,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { SHARED_REFUSAL, turnChat } from "../lead/Audience.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { partyPage, projectDetail } from "./crm.ts";
import { KinRecords, type Patch, type TotalsBy, type Writer } from "./KinRecords.ts";
import { FieldInputs, turnFiles, typedFields } from "./leadFields.ts";
import { fieldList, fieldText, isMoney, LISTS, listOf, parseFields } from "./lists.ts";
import { formatMoney, parseAmount } from "./money.ts";
import {
  endOfDay,
  iso,
  notFound,
  ownerZone,
  type RecordRow,
  sensitiveNow,
  toRecord,
} from "./recordRows.ts";
import {
  allLists,
  isBuiltIn,
  type ListDef,
  listDef,
  sensitiveKeys,
  stateLabel,
  unknownList,
} from "./registers.ts";
import {
  isSensitiveRefusal,
  sensitiveShown,
  showsSensitive,
  turnSensitive,
} from "./workerAttempts.ts";

/** The lead tools' inputs, results and the one call each makes. Model-facing text lives in `mcp/tools.ts`. */

export const Who = TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
  description:
    '"me" for you, "owner" for the owner, or an agent\'s agentId from kin_leads. Never a name.',
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
const List = KinListId.annotate({
  description:
    "work (default), clients, contacts, projects, or a list defined with list_define, such as expenses, invoices or dates.",
});
const Category = TrimmedNonEmptyString.check(Schema.isMaxLength(60)).annotate({
  description: "Work: task, issue or obligation. A defined list: one of its categories.",
});
const Amount = TrimmedNonEmptyString.check(Schema.isMaxLength(60)).annotate({
  description:
    'The amount as said or written: "4200", "4.2 lakh", "₹1,23,456.78", "$30". Kin turns it into exact minor units.',
});
const Currency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/)).annotate({
  description: "ISO code, when the amount doesn't name one; default the list's, usually INR.",
});
const Day = Schema.NullOr(KinDay).annotate({
  description: "When it happened, was issued or starts: a day in the owner's time zone.",
});
const Repeat = Schema.NullOr(KinRepeatRule).annotate({
  description:
    'Kin makes the next one when this one closes: {"every":"month"}, "quarter", "year", or {"every":"days","days":14}. null stops it.',
});
const TaxId = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
const Address = TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
  description: "A client's billing address, as its invoices show it.",
});
export const Client = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
  description: "A client or vendor: its key (C-3) or exact name.",
});
export const Project = TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
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
    Schema.Literals([
      "client",
      "project",
      "side",
      "owner",
      "state",
      "category",
      "month",
      "financialYear",
    ]),
  ).annotate({
    description:
      "Also count the matches per group, with exact totals per currency where they have amounts. month and financialYear (April to March) go by each entry's date.",
  }),
  dateFrom: Schema.optional(KinDay).annotate({ description: "Its own date on or after this day." }),
  dateTo: Schema.optional(KinDay).annotate({ description: "Its own date on or before this day." }),
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
/** The entry is sensitive, its own label or inherited; these fields are, whatever the label. */
const Marks = Schema.Struct({
  sensitive: Schema.optional(Schema.Literal(true)),
  sensitiveFields: Schema.optional(Schema.Array(Schema.String)),
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
  list: Schema.optional(Schema.String),
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
  address: Schema.optional(Schema.String),
  gstin: Schema.optional(Schema.String),
  placeOfSupply: Schema.optional(Schema.String),
  /** A defined list's: its list, what it calls the state, amount, date and own fields. */
  listName: Schema.optional(Schema.String),
  stateLabel: Schema.optional(Schema.String),
  category: Schema.optional(Schema.String),
  amount: Schema.optional(Schema.String),
  balance: Schema.optional(Schema.String),
  date: Schema.optional(Schema.String),
  repeat: Schema.optional(Schema.String),
  fields: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  ...Marks.fields,
  rev: Schema.Number,
});
export const QueryResult = Schema.Struct({
  asOf: Schema.String,
  total: Schema.Number,
  records: Schema.Array(Row),
  /** Every match's amounts added up, one figure per currency. */
  totals: Schema.optional(Schema.Array(Schema.String)),
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        group: Schema.String,
        count: Schema.Number,
        late: Schema.optional(Schema.Number),
        totals: Schema.optional(Schema.Array(Schema.String)),
        sensitive: Schema.optional(Schema.Literal(true)),
      }),
    ),
  ),
  sensitive: Schema.optional(Schema.Literal(true)),
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
    Schema.Struct({
      at: Schema.String,
      by: Schema.String,
      change: Schema.String,
      sensitive: Schema.optional(Schema.Literal(true)),
    }),
  ),
  /** An invoice's payments, newest first. */
  payments: Schema.optional(
    Schema.Array(
      Schema.Struct({
        paymentId: Schema.String,
        amount: Schema.String,
        paidOn: Schema.String,
        note: Schema.optional(Schema.String),
        voided: Schema.optional(Schema.Literal(true)),
      }),
    ),
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
        sensitive: Schema.optional(Schema.Literal(true)),
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
  category: Schema.optional(Category),
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
  address: Schema.optional(Address),
  gstin: Schema.optional(TaxId),
  placeOfSupply: Schema.optional(TaxId),
  amount: Schema.optional(Amount),
  currency: Schema.optional(Currency),
  date: Schema.optional(Day),
  repeat: Schema.optional(Repeat),
  fields: Schema.optional(FieldInputs),
  sensitive: Schema.optional(Schema.Literal(true)),
  suggested: Schema.optional(Schema.Boolean),
});
export const CreateInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString,
  records: Schema.Array(CreateRow).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});
export const CreateResult = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      created: Schema.Boolean,
      ...Marks.fields,
    }),
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
  category: Schema.optional(Category),
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
  address: Schema.optional(Schema.NullOr(Address)),
  gstin: Schema.optional(Schema.NullOr(TaxId)),
  placeOfSupply: Schema.optional(Schema.NullOr(TaxId)),
  amount: Schema.optional(Schema.NullOr(Amount)),
  currency: Schema.optional(Currency),
  date: Schema.optional(Day),
  repeat: Schema.optional(Repeat),
  fields: Schema.optional(FieldInputs),
  sensitive: Schema.optional(Schema.Literal(true)),
  confirmed: Schema.optional(Schema.Boolean),
  expectedRev: Schema.optional(Schema.Int),
});
export const UpdateResult = Schema.Struct({
  key: Schema.String,
  rev: Schema.Number,
  state: KinRecordState,
  changed: Schema.Array(Schema.String),
  ...Marks.fields,
});

export type Lead = Effect.Success<ReturnType<typeof resolveLead>>;
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isDoc = (key: string) =>
  invalid(`${key.slice(0, 40)} is a doc: read it with doc_read and change it with doc_edit.`);

/** Who the turn's events came from, by stored author: the owner only when every one is the owner's. */
export const askedBy = Effect.fn("KinWorkTools.askedBy")(function* (lead: Lead) {
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
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId} AND e.wakeup_id = ${lead.wakeupId}
    ORDER BY e.event_id`;
  const owner = rows[0]?.owner;
  return owner !== undefined && rows.every((row) => row.person === owner)
    ? KinPersonId.make(owner)
    : null;
});

export const sourceOf = Effect.fn("KinWorkTools.sourceOf")(function* (lead: Lead, eventId: string) {
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

export const resolveWho = Effect.fn("KinWorkTools.resolveWho")(function* (lead: Lead, who: string) {
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
  if (isCalendarDay(due)) return { dueAt: endOfDay(due, yield* ownerZone(orgId)), dueAllDay: true };
  const ms = calendarTimeMillis(due);
  if (!Number.isFinite(ms))
    return yield* invalid(`due ${due.slice(0, 40)} is not a day or a time.`);
  return { dueAt: ms, dueAllDay: false };
});

/** How a lead reads names: itself as "you", the owner as "owner", other leads by name. */
export const namer = Effect.fn("KinWorkTools.namer")(function* (lead: Lead) {
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
          : `${agentNames.get(who.agentId) ?? "an agent"} (${who.agentId})`
        : (personNames.get(who.personId) ?? "a person");
});

type Lists = ReadonlyMap<string, ListDef>;
const defOf = (lists: Lists, row: RecordRow) => lists.get(row.registerId);
const marksOf = (lists: Lists, row: RecordRow): typeof Marks.Type => {
  const def = defOf(lists, row);
  const fields = [
    ...(def === undefined ? [] : sensitiveKeys(def)),
    ...(row.amountMinor !== null && def?.amount !== true ? ["amount"] : []),
  ];
  return {
    ...(row.sensitive === 1 || row.inheritedSensitive === 1 ? { sensitive: true as const } : {}),
    ...(fields.length === 0 ? {} : { sensitiveFields: [...fields] }),
  };
};

/** A defined list's own fields as a lead reads them: names for people, keys for links. */
const shownFields = (
  def: ListDef | undefined,
  row: RecordRow,
  name: (who: KinWorkPrincipal | null) => string | undefined,
  keys: ReadonlyMap<string, string>,
) => {
  if (def === undefined || def.builtIn !== null) return {};
  const fields = parseFields(row.fieldsJson);
  const shown: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const spec = def.fields.find((one) => one.key === key);
    if (isMoney(value)) shown[key] = formatMoney(value);
    else if (Array.isArray(value))
      shown[key] = `${value.length} file${value.length === 1 ? "" : "s"}`;
    else if (spec?.type === "person") {
      const [kind, ...rest] = (value as string).split(":");
      const id = rest.join(":");
      shown[key] =
        name(
          kind === "agent"
            ? { _tag: "agent", agentId: KinAgentId.make(id) }
            : { _tag: "person", personId: KinPersonId.make(id) },
        ) ?? "someone";
    } else if (spec?.type === "link") shown[key] = keys.get(value as string) ?? "a removed entry";
    else shown[key] = value as string;
  }
  return Object.keys(shown).length === 0 ? {} : { fields: shown };
};
const dayOrTime = (at: string, allDay: boolean, zone: string) =>
  allDay
    ? DateTime.formatIsoDate(DateTime.makeZonedUnsafe(Date.parse(at), { timeZone: zone }))
    : at;
const shownRepeatRule = (rule: KinRepeatRule) =>
  rule.every === "days" ? `every ${rule.days} days` : `every ${rule.every}`;

/** Keys of the clients and projects a page's link fields point at, in one read. */
const linkKeys = Effect.fn("KinWorkTools.linkKeys")(function* (
  lead: Lead,
  rows: ReadonlyArray<RecordRow>,
  lists: Lists,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = rows.flatMap((row) => {
    const def = defOf(lists, row);
    if (def === undefined || def.builtIn !== null) return [];
    const fields = parseFields(row.fieldsJson);
    return def.fields.flatMap((spec) => {
      const value = fields[spec.key];
      return spec.type === "link" && typeof value === "string" ? [value] : [];
    });
  });
  if (ids.length === 0) return new Map<string, string>();
  const found = yield* sql<{ id: string; label: string }>`SELECT record_id AS id,
      title || ' (' || key || ')' AS label FROM kin_records
    WHERE org_id = ${lead.orgId} AND record_id IN ${sql.in([...new Set(ids)])} ORDER BY record_id`;
  return new Map(found.map((row) => [row.id, row.label]));
});

type View = {
  readonly name: (who: KinWorkPrincipal | null) => string | undefined;
  readonly lists: Lists;
  readonly keys: ReadonlyMap<string, string>;
  readonly zone: string;
};
const viewFor = Effect.fn("KinWorkTools.view")(function* (
  lead: Lead,
  rows: ReadonlyArray<RecordRow>,
) {
  const lists = yield* allLists(lead.orgId);
  return {
    name: yield* namer(lead),
    lists,
    keys: yield* linkKeys(lead, rows, lists),
    zone: yield* ownerZone(lead.orgId),
  } satisfies View;
});

const rowFor = (view: View, row: RecordRow, now: number) => {
  const { name } = view;
  const record = toRecord(row, now);
  const waitingOn = name(record.waitingOn);
  const list = row.registerId;
  const def = defOf(view.lists, row);
  const defined = def !== undefined && def.builtIn === null;
  const fields = parseFields(row.fieldsJson);
  const text = (key: string) => {
    const value = fieldText(fields, key);
    return value === null ? {} : { [key]: value };
  };
  const repos = fieldList(fields, "repos");
  return {
    ...(list === "work" ? {} : { list }),
    ...(defined ? { listName: def.name, stateLabel: stateLabel(def, row.state) } : {}),
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
    ...(defined ? {} : { ...text("address"), ...text("gstin"), ...text("placeOfSupply") }),
    ...(defined && row.category !== null ? { category: row.category } : {}),
    ...(record.amount === undefined ? {} : { amount: formatMoney(record.amount) }),
    ...(record.balance === undefined ? {} : { balance: formatMoney(record.balance) }),
    ...(record.dateAt === undefined
      ? {}
      : { date: dayOrTime(record.dateAt, record.dateAllDay === true, view.zone) }),
    ...(record.repeat === undefined ? {} : { repeat: shownRepeatRule(record.repeat) }),
    ...shownFields(def, row, name, view.keys),
    ...marksOf(view.lists, row),
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
export const refOrNull = Effect.fn("KinWorkTools.refOrNull")(function* (
  lead: Lead,
  text: string | null | undefined,
  list: "clients" | "projects",
) {
  if (text === undefined || text === null) return text;
  return yield* resolveRef(lead, text, list);
});

/** The built-in list's own fields a row or an update names; `null` clears one. */
const fieldsFrom = (row: {
  readonly role?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly terms?: string | null | undefined;
  readonly repos?: ReadonlyArray<string> | undefined;
  readonly address?: string | null | undefined;
  readonly gstin?: string | null | undefined;
  readonly placeOfSupply?: string | null | undefined;
}) =>
  Object.fromEntries(
    (
      ["role", "email", "phone", "terms", "repos", "address", "gstin", "placeOfSupply"] as const
    ).flatMap((key) => (row[key] === undefined ? [] : [[key, row[key]]])),
  ) as Record<string, string | ReadonlyArray<string> | null>;

/** A list a lead named, as this org has it. */
const listFor = Effect.fn("KinWorkTools.list")(function* (lead: Lead, id: string) {
  const def = yield* listDef(lead.orgId, id);
  if (def === undefined) return yield* unknownList(id);
  return def;
});

/** An amount a lead wrote, in the list's currency unless it names one. */
const amountFrom = (def: ListDef, amount: string, currency: string | undefined) => {
  const parsed = parseAmount(amount, currency ?? def.currency);
  if ("error" in parsed) return Effect.fail(parsed.error);
  if (currency !== undefined && parsed.money.currency !== currency)
    return Effect.fail(
      invalid(`${amount.slice(0, 40)} is in ${parsed.money.currency}, not ${currency}.`),
    );
  return Effect.succeed(parsed.money);
};

/** What a row or an update adds for a defined list, or Work's amount and repeat. */
const moneyPatch = Effect.fn("KinWorkTools.moneyPatch")(function* (
  lead: Lead,
  def: ListDef,
  row: {
    readonly amount?: string | null | undefined;
    readonly currency?: string | undefined;
    readonly date?: string | null | undefined;
    readonly repeat?: KinRepeatRule | null | undefined;
    readonly fields?: FieldInputs | undefined;
  },
) {
  const amount: KinMoney | null | undefined =
    row.amount === undefined || row.amount === null
      ? row.amount
      : yield* amountFrom(def, row.amount, row.currency);
  const date =
    row.date === undefined
      ? undefined
      : row.date === null
        ? { dateAt: null, dateAllDay: false }
        : { dateAt: endOfDay(row.date, yield* ownerZone(lead.orgId)), dateAllDay: true };
  const fields =
    row.fields === undefined
      ? undefined
      : def.builtIn !== null
        ? yield* invalid(`A ${def.noun}'s details are named fields of their own, not fields.`)
        : yield* typedFields(def, row.fields, {
            who: (text) => resolveWho(lead, text),
            ref: (text, list) => resolveRef(lead, text, list),
            files: () => turnFiles(lead),
          });
  return {
    ...(amount === undefined ? {} : { amount }),
    ...date,
    ...(row.repeat === undefined ? {} : { repeat: row.repeat }),
    ...(fields === undefined ? {} : { fields }),
  };
});

/** Refused, as the gate does, if the turn became one others read since the call was admitted. */
export const admitted = Effect.fn("KinWorkTools.admitted")(function* (
  lead: Lead,
  tool: string,
  args: unknown,
) {
  if (!(yield* toolAdmitted(lead, tool, args)))
    return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
});

export const writerFor = Effect.fn("KinWorkTools.writer")(function* (lead: Lead) {
  const chat = yield* turnChat(lead);
  return {
    actor: { _tag: "agent", agentId: lead.agentId },
    via: "lead",
    wakeupId: lead.wakeupId,
    ...(chat === undefined ? {} : { chatId: KinChatId.make(chat.chatId) }),
    askedBy: yield* askedBy(lead),
  } satisfies Writer;
});

/**
 * Every lead-facing Work tool is one of these: a result that shows the lead a sensitive entry,
 * whatever the tool, marks its wake-up, so work it then starts unlinked is gated. Its span names
 * the call, so the bodies are untraced.
 */
export const leadTool = <I, A, E, R>(
  name: string,
  body: (lead: Lead, input: I) => Effect.Effect<A, E, R>,
) =>
  Effect.fn(name)(function* (scope: McpInvocationScope, input: I) {
    const lead = yield* resolveLead(scope);
    const marked = sensitiveShown({ orgId: lead.orgId, wakeupId: lead.wakeupId });
    // A refusal's own write rolled back, so its mark is made here, after it.
    const result = yield* body(lead, input).pipe(
      Effect.tapError((error) => (isSensitiveRefusal(error) ? marked : Effect.void)),
    );
    if (showsSensitive(result)) yield* marked;
    return result;
  });

export const retryKey = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
const titleKey = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

const runQuery = Effect.fnUntraced(function* (lead: Lead, input: typeof QueryInput.Type) {
  const records = yield* KinRecords;
  const list = input.list === undefined ? undefined : yield* listFor(lead, input.list);
  const owner = input.owner === undefined ? undefined : yield* resolveWho(lead, input.owner);
  const dueBy = input.dueBefore === undefined ? undefined : calendarTimeMillis(input.dueBefore);
  if (dueBy !== undefined && !Number.isFinite(dueBy))
    return yield* invalid("dueBefore is not a time.");
  const partyId =
    input.client === undefined ? undefined : yield* resolveRef(lead, input.client, "clients");
  const projectId =
    input.project === undefined ? undefined : yield* resolveRef(lead, input.project, "projects");
  const zone = yield* ownerZone(lead.orgId);
  const filter = {
    ...(list === undefined ? {} : { list: list.id }),
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(input.side === undefined ? {} : { side: input.side }),
    ...(input.repo === undefined ? {} : { repo: input.repo }),
    ...(owner === undefined ? {} : { owner }),
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.open === undefined ? {} : { open: input.open }),
    ...(input.late === undefined ? {} : { late: input.late }),
    ...(dueBy === undefined ? {} : { dueBy }),
    ...(input.dateFrom === undefined
      ? {}
      : { dateFrom: endOfDay(input.dateFrom, zone) - DAY_MS + 1 }),
    ...(input.dateTo === undefined ? {} : { dateTo: endOfDay(input.dateTo, zone) + 1 }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.keys === undefined ? {} : { keys: input.keys }),
  };
  const page = yield* records.query(lead.orgId, { ...filter, limit: input.limit ?? 20 });
  const now = yield* Clock.currentTimeMillis;
  const view = yield* viewFor(lead, page.rows);
  const withAmounts = list !== undefined && (list.amount || list.builtIn === "work");
  const totals =
    withAmounts || input.groupBy === "month" || input.groupBy === "financialYear"
      ? yield* records.totals(
          lead.orgId,
          filter,
          input.groupBy === undefined ? undefined : TOTALS_BY[input.groupBy],
        )
      : undefined;
  const groups =
    input.groupBy === undefined
      ? undefined
      : totals?.groups !== undefined
        ? yield* labelGroups(lead, view, input.groupBy, totals.groups)
        : yield* groupsFor(lead, view, filter, input.groupBy);
  return {
    asOf: iso(now),
    total: page.total,
    records: page.rows.map((row) => rowFor(view, row, now)),
    ...(totals === undefined || totals.total.length === 0
      ? {}
      : { totals: totals.total.map(formatMoney), sensitive: true as const }),
    ...(groups === undefined ? {} : { groups }),
  };
});
export const query = leadTool("KinWorkTools.query", runQuery);

const DAY_MS = 24 * 60 * 60 * 1000;
const TOTALS_BY: Record<NonNullable<typeof QueryInput.Type.groupBy>, TotalsBy> = {
  client: "party",
  project: "project",
  side: "side",
  owner: "owner",
  state: "state",
  category: "category",
  month: "month",
  financialYear: "financialYear",
};
type By = NonNullable<typeof QueryInput.Type.groupBy>;

/** Groups' raw keys as a lead reads them: names, `Acme (C-1)`, or the period itself. */
const labelGroups = Effect.fn("KinWorkTools.labelGroups")(function* (
  lead: Lead,
  view: View,
  by: By,
  rows: ReadonlyArray<{
    readonly group: string | null;
    readonly count: number;
    readonly late?: number;
    readonly total?: ReadonlyArray<KinMoney>;
  }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const ids = rows.flatMap((row) => (row.group === null ? [] : [row.group]));
  const titles =
    (by === "client" || by === "project") && ids.length > 0
      ? new Map(
          (yield* sql<{ id: string; label: string; sensitive: number }>`SELECT r.record_id AS id,
              r.title || ' (' || r.key || ')' AS label, ${sensitiveNow(sql)} AS sensitive
            FROM kin_records r WHERE r.org_id = ${lead.orgId} AND r.record_id IN ${sql.in(ids)}
            ORDER BY r.record_id`).map((row) => [row.id, row]),
        )
      : new Map<string, { readonly label: string; readonly sensitive: number }>();
  const label = (group: string | null) => {
    if (group === null) return "none";
    if (by === "client" || by === "project") return titles.get(group)?.label ?? "none";
    if (by !== "owner") return group;
    const [kind, ...id] = group.split(":");
    const who: KinWorkPrincipal | null =
      kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id.join(":")) }
        : kind === "person"
          ? { _tag: "person", personId: KinPersonId.make(id.join(":")) }
          : null;
    return view.name(who) ?? "someone";
  };
  return rows.map((row) => ({
    group: label(row.group),
    count: row.count,
    ...(row.late === undefined ? {} : { late: row.late }),
    ...(row.total === undefined || row.total.length === 0
      ? {}
      : { totals: row.total.map(formatMoney) }),
    ...((row.group !== null && titles.get(row.group)?.sensitive === 1) || row.total !== undefined
      ? { sensitive: true as const }
      : {}),
  }));
});

const groupsFor = Effect.fn("KinWorkTools.groups")(function* (
  lead: Lead,
  view: View,
  filter: Parameters<KinRecords["Service"]["groups"]>[1],
  by: By,
) {
  const records = yield* KinRecords;
  const grouped = TOTALS_BY[by];
  if (grouped === "month" || grouped === "financialYear") return [];
  return yield* labelGroups(lead, view, by, yield* records.groups(lead.orgId, filter, grouped));
});

const runGet = Effect.fnUntraced(function* (lead: Lead, input: typeof GetInput.Type) {
  const records = yield* KinRecords;
  const row = yield* records.get(lead.orgId, input.key);
  if (row === undefined) return yield* notFound(input.key);
  if (listOf(row.registerId) === "docs") return yield* isDoc(input.key);
  const detail = yield* records.detail(row, 10);
  const now = yield* Clock.currentTimeMillis;
  const view = yield* viewFor(lead, [row]);
  const { name } = view;
  const actor = (by: (typeof detail.changes)[number]["by"]) =>
    by._tag === "system" ? "Kin" : (name(by) ?? "someone");
  const assignedBy = name(detail.assignedBy);
  const list = row.registerId;
  const sensitive = new Set(marksOf(view.lists, row).sensitiveFields ?? []);
  const page = list === "clients" ? yield* partyPage(row, now, 0) : undefined;
  const project = list === "projects" ? yield* projectDetail(row, now) : undefined;
  return {
    ...rowFor(view, row, now),
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
          })).rows.map((contact) => rowFor(view, contact, now)),
          projects: page.projects.map((one) => ({
            key: one.key,
            title: one.name,
            health: one.health,
            ...(one.sensitive || one.sensitiveInherited ? { sensitive: true as const } : {}),
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
    ...(detail.payments === undefined
      ? {}
      : {
          payments: detail.payments.map((payment) => ({
            paymentId: payment.paymentId,
            amount: formatMoney(payment.amount),
            paidOn: payment.paidOn,
            ...(payment.note === "" ? {} : { note: payment.note }),
            ...(payment.voidedAt === null ? {} : { voided: true as const }),
          })),
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
      ...(change.kind !== "created" &&
      change.fields.some((field) => sensitive.has(field.field) || field.field === "payment")
        ? { sensitive: true as const }
        : {}),
    })),
  };
});
export const get = leadTool("KinWorkTools.get", runGet);

const runCreate = Effect.fnUntraced(function* (lead: Lead, input: typeof CreateInput.Type) {
  yield* admitted(lead, "record_create", input);
  const records = yield* KinRecords;
  const source = yield* sourceOf(lead, input.sourceEventId);
  const writer = yield* writerFor(lead);
  const lists = yield* allLists(lead.orgId);
  // A turn shown something sensitive may be writing it down, so what it writes is labelled too.
  const marked = yield* turnSensitive(lead.orgId, lead.wakeupId);
  const results = [];
  for (const row of input.records) {
    const def = yield* listFor(lead, row.list ?? "work");
    const list = def.id;
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
      list === "work" || !isBuiltIn(list)
        ? undefined
        : yield* sameNamed(lead, list, row.title, partyId ?? null);
    if (existing !== undefined) {
      const found = yield* records.get(lead.orgId, existing.key);
      results.push({
        key: existing.key,
        title: existing.title,
        created: false,
        ...(found === undefined ? {} : marksOf(lists, found)),
      });
      continue;
    }
    const money = yield* moneyPatch(lead, def, row);
    // The same row from the same event is the same entry: a retry, or a repeat in one call.
    const rowKey =
      list === "work"
        ? titleKey(row.title) + (partyId === undefined || partyId === null ? "" : `|${partyId}`)
        : isBuiltIn(list)
          ? `${list}|${partyId ?? ""}|${titleKey(row.title)}`
          : `${list}|${partyId ?? ""}|${titleKey(row.title)}|${row.amount ?? ""}|${row.date ?? ""}|${row.due ?? ""}`;
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
      ...(row.sensitive === undefined && !marked ? {} : { sensitive: true }),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(row.state === undefined ? {} : { state: row.state }),
      ...(waitingOn === undefined ? {} : { waitingOn }),
      ...due,
      ...money,
      ...(row.notes === undefined ? {} : { notes: row.notes }),
      ...categoryOf(list, row),
      ...(row.side === undefined ? {} : { side: row.side }),
      // What the owner asked for is confirmed; what a lead inferred waits for the owner.
      confirmed: row.suggested !== true && writer.askedBy !== null,
      ...(source === undefined ? {} : { source }),
    });
    results.push({ key: stored.key, title: stored.title, created, ...marksOf(lists, stored) });
  }
  return { records: results };
});
export const create = leadTool("KinWorkTools.create", runCreate);

/** A client's kind or an entry's category; a client with neither is a client. */
const categoryOf = (
  list: string,
  row: { readonly kind?: string | undefined; readonly category?: string | undefined },
) => {
  const category = row.kind ?? row.category ?? (list === "clients" ? "client" : undefined);
  return category === undefined ? {} : { category };
};

const sameNamed = Effect.fn("KinWorkTools.sameNamed")(function* (
  lead: Lead,
  list: string,
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

const UNCARRYING = new Set(["state", "owner", "waitingOn", "confirmed"]);
const runUpdate = Effect.fnUntraced(function* (lead: Lead, input: typeof UpdateInput.Type) {
  yield* admitted(lead, "record_update", input);
  const records = yield* KinRecords;
  yield* sourceOf(lead, input.sourceEventId);
  const writer = yield* writerFor(lead);
  const before = yield* records.get(lead.orgId, input.key);
  if (before === undefined) return yield* notFound(input.key);
  if (listOf(before.registerId) === "docs") return yield* isDoc(input.key);
  const def = yield* listFor(lead, before.registerId);
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
  const money = yield* moneyPatch(lead, def, input);
  const written: Patch = {
    ...patch,
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...money,
  };
  // As in create; a state, owner or confirmation alone carries nothing the turn read.
  const carries = Object.keys(written).some((field) => !UNCARRYING.has(field));
  const full: Patch =
    carries && (yield* turnSensitive(lead.orgId, lead.wakeupId))
      ? { ...written, sensitive: true }
      : written;
  const after = yield* records.update(lead.orgId, writer, input.key, full, input.expectedRev);
  // Kin's own change, a label kept on, follows the lead's in the same write.
  const changed =
    after.rev === before.rev
      ? []
      : [
          ...new Set(
            (yield* records.detail(after, Math.min(after.rev - before.rev, 2))).changes
              .toReversed()
              .flatMap((change) => change.fields.map((field) => field.field)),
          ),
        ];
  const lists = yield* allLists(lead.orgId);
  return { key: after.key, rev: after.rev, state: after.state, changed, ...marksOf(lists, after) };
});
export const update = leadTool("KinWorkTools.update", runUpdate);
