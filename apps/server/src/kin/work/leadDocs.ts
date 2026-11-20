import {
  KIN_DOC_CARD,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinDocKind,
  KinDocSectionId,
  type KinDocCardState,
  KinMessageId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  KinSearchKind,
  KinWakeupId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { KinToolText } from "./leadSchemas.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { effectiveAudience, turnPeople } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { laneFor } from "../reply/replyLane.ts";
import { DOC_BODY_MAX, outlineOf, sectionsOf, WHOLE_DOC } from "./docBody.ts";
import * as Docs from "./docs.ts";
import { startOfferings } from "./offerings.ts";
import {
  admitted,
  Client,
  type Lead,
  leadTool,
  namer,
  Project,
  refOrNull,
  resolveWho,
  retryKey,
  unseenOf,
  viewOf,
  viewWriter,
  Who,
  writerFor,
} from "./leadWork.ts";
import { iso, type RecordRow } from "./recordRows.ts";
import { search } from "./search.ts";
import { KIN_OWNER_LEVEL, viewSees, viewerOfPeople } from "./teamView.ts";
import { TurnEvent } from "../lead/eventIds.ts";

/** The doc tools' inputs, results and the one call each makes. Model-facing text is in `mcp/docTools.ts`. */

const Key = KinRecordKey.annotate({ description: "The doc's key, such as D-4." });
const Summary = KinToolText(
  200,
  'One line saying what changed, for the reader: "Moved launch to 14 Dec".',
).check(Schema.isPattern(/^[^\n]*$/));
const Body = Schema.String.check(Schema.isMaxLength(DOC_BODY_MAX));
const Text = Schema.String.check(Schema.isMaxLength(50_000));
const Title = KinToolText(200);
const Section = KinDocSectionId.annotate({ description: "A section id from the outline." });
const SourceEvent = TurnEvent;
const Card = Schema.optional(Schema.Boolean).annotate({
  description: "Also show the doc in this chat as a card the owner can open.",
});

const OutlineEntry = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  level: Schema.Number,
  chars: Schema.Number,
  hash: Schema.String,
});
const Marks = { sensitive: Schema.optional(Schema.Literal(true)) };
const Kind = KinDocKind.annotate({
  description: "What it is: prd, proposal, quote, spec, notes, report, playbook, policy, or other.",
});
const Company = Schema.Boolean.annotate({
  description:
    "true files it as the company's own (playbooks, policies, company plans) rather than a client's.",
});
/** Where the doc is filed, for the result: a client and project, the company, or nowhere yet. */
const Filed = {
  kind: Schema.String,
  company: Schema.optional(Schema.Literal(true)),
  unfiled: Schema.optional(Schema.String),
};

export const CreateInput = Schema.Struct({
  sourceEventId: SourceEvent,
  title: Title,
  body: Body,
  summary: Schema.optional(Summary),
  owner: Schema.optional(Who),
  kind: Schema.optional(Kind),
  client: Schema.optional(Client),
  project: Schema.optional(Project),
  company: Schema.optional(Company),
  sensitive: Schema.optional(Schema.Literal(true)),
  links: Schema.optional(Schema.Array(KinRecordKey).check(Schema.isMaxLength(20))).annotate({
    description: "Keys of entries or docs to link it to.",
  }),
  card: Schema.optional(Schema.Boolean).annotate({
    description:
      "The doc shows in this chat as a card the owner can open. Pass false only for a doc nobody asked for in this chat.",
  }),
  whatWeSell: Schema.optional(Schema.Literal(true)),
});
export const WriteResult = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  version: Schema.Number,
  /** False when the call changed nothing: a retry, or text already as asked. */
  changed: Schema.Boolean,
  outline: Schema.Array(OutlineEntry),
  ...Filed,
  ...Marks,
  note: Schema.optional(Schema.String),
});

export const ReadInput = Schema.Struct({
  key: Key,
  sections: Schema.optional(Schema.Array(Section).check(Schema.isMaxLength(20))).annotate({
    description:
      "Section ids to read in full; leave out to get the outline (and a short doc whole).",
  }),
  version: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export const ReadResult = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  version: Schema.Number,
  latestVersion: Schema.Number,
  chars: Schema.Number,
  updated: Schema.Struct({ at: Schema.String, by: Schema.String, summary: Schema.String }),
  outline: Schema.Array(OutlineEntry),
  body: Schema.optional(Schema.String),
  sections: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        hash: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  note: Schema.optional(Schema.String),
  owner: Schema.String,
  client: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Literal(true)),
  ...Marks,
});

const Operation = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("replace_section"),
    section: Section,
    hash: Schema.String.annotate({ description: "The section's hash from the outline you read." }),
    text: Text.annotate({
      description:
        "Its new text. Without a heading line the heading stays; empty removes the section.",
    }),
  }),
  Schema.Struct({ op: Schema.Literal("insert_after"), section: Section, text: Text }),
  Schema.Struct({ op: Schema.Literal("append"), text: Text }),
  Schema.Struct({
    op: Schema.Literal("replace_phrase"),
    find: KinToolText(2_000, "Exact text that appears once in the doc."),
    replace: Schema.String.check(Schema.isMaxLength(2_000)),
  }),
  Schema.Struct({ op: Schema.Literal("retitle"), title: Title }),
]);
export const EditInput = Schema.Struct({
  key: Key,
  sourceEventId: SourceEvent,
  summary: Summary,
  operations: Schema.Array(Operation).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  card: Card,
});
export const RewriteInput = Schema.Struct({
  key: Key,
  sourceEventId: SourceEvent,
  baseVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The version you read.",
  }),
  body: Body,
  summary: Summary,
  card: Card,
});
export const MoveInput = Schema.Struct({
  key: Key,
  sourceEventId: SourceEvent,
  kind: Schema.optional(Kind),
  client: Schema.optional(Schema.NullOr(Client)),
  project: Schema.optional(Schema.NullOr(Project)),
  company: Schema.optional(Company),
  owner: Schema.optional(Who),
  sensitive: Schema.optional(Schema.Literal(true)),
  archived: Schema.optional(Schema.Boolean),
});
export const MoveResult = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  owner: Schema.String,
  client: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  archived: Schema.Boolean,
  ...Filed,
  ...Marks,
});
export const LinkInput = Schema.Struct({
  key: Key,
  sourceEventId: SourceEvent,
  to: Schema.Array(KinRecordKey).check(Schema.isMinLength(1), Schema.isMaxLength(20)).annotate({
    description: "Keys of entries (W-12) or other docs (D-3).",
  }),
});
export const LinkResult = Schema.Struct({
  key: Schema.String,
  linked: Schema.Array(Schema.Struct({ key: Schema.String, title: Schema.String, ...Marks })),
});
export const SearchInput = Schema.Struct({
  text: KinToolText(200),
  kinds: Schema.optional(Schema.Array(KinSearchKind).check(Schema.isMaxLength(5))).annotate({
    description: "work, clients, contacts, projects, docs. Leave out for all.",
  }),
  closed: Schema.optional(Schema.Boolean).annotate({
    description: "Include done, dropped and archived ones.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  ),
});
const WIDENED = "Nothing has every word, so these have some of them.";
export const SearchResult = Schema.Struct({
  /** Said when no entry has every word and the hits share only some. */
  widened: Schema.optional(Schema.String),
  hits: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      kind: Schema.String,
      title: Schema.String,
      snippet: Schema.String,
      section: Schema.optional(Schema.Struct({ id: Schema.String, title: Schema.String })),
      closed: Schema.optional(Schema.Literal(true)),
      ...Marks,
    }),
  ),
});
export const HistoryInput = Schema.Struct({
  key: Key,
  before: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))).annotate({
    description: "Only versions below this one.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
  ),
});
export const HistoryResult = Schema.Struct({
  key: Schema.String,
  latestVersion: Schema.Number,
  versions: Schema.Array(
    Schema.Struct({
      version: Schema.Number,
      at: Schema.String,
      by: Schema.String,
      kind: Schema.String,
      summary: Schema.String,
      restoredFrom: Schema.optional(Schema.Number),
      sections: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  ...Marks,
});
export const RestoreInput = Schema.Struct({
  key: Key,
  sourceEventId: SourceEvent,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The version to bring back.",
  }),
  latest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The latest version, from doc_history.",
  }),
  card: Card,
});

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** The event the lead says it acts on, which must be its own turn's, and who wrote its message. */
const answering = Effect.fn("KinDocTools.answering")(function* (lead: Lead, eventId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    tag: string;
    chatId: string | null;
    messageId: string | null;
    authorKind: string | null;
    personId: string | null;
    agentId: string | null;
  }>`SELECT e.tag, m.chat_id AS "chatId", m.message_id AS "messageId",
      m.author_kind AS "authorKind", m.author_person_id AS "personId",
      m.author_agent_id AS "agentId"
    FROM kin_events e
    LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
      AND m.message_id = json_extract(e.json, '$.messageId')
      AND m.chat_id = json_extract(e.json, '$.chatId')
      AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
    WHERE e.org_id = ${lead.orgId} AND e.agent_id = ${lead.agentId}
      AND e.wakeup_id = ${lead.wakeupId} AND e.event_id = ${eventId}
    ORDER BY e.event_id`;
  if (row === undefined)
    return yield* invalid("sourceEventId must be one of this turn's events. Nothing was written.");
  const author: KinWorkPrincipal | undefined =
    row.authorKind === "human" && row.personId !== null
      ? { _tag: "person", personId: KinPersonId.make(row.personId) }
      : row.authorKind === "agent" && row.agentId !== null
        ? { _tag: "agent", agentId: KinAgentId.make(row.agentId) }
        : undefined;
  return row.messageId === null || row.chatId === null || author === undefined
    ? undefined
    : { messageId: row.messageId, chatId: row.chatId, author, tag: row.tag };
});

/** Writer and provenance for a doc write, both from stored rows; nothing in `input` reaches them. */
const writeContext = Effect.fn("KinDocTools.context")(function* (
  lead: Lead,
  tool: string,
  input: { readonly sourceEventId: string; readonly card?: boolean | undefined },
) {
  yield* admitted(lead, tool, input);
  const answered = yield* answering(lead, input.sourceEventId);
  // In a turn others read, the write's own check decides for every person behind it (`teamGuard`).
  const team = yield* viewOf(lead);
  const owned = yield* writerFor(lead);
  const writer = team === undefined ? owned : viewWriter(owned, team);
  const audience = yield* effectiveAudience(lead);
  const provenance: Docs.Provenance = {
    audience,
    ...(answered === undefined
      ? {}
      : { answered: { messageId: answered.messageId, author: answered.author } }),
  };
  const { card: _card, ...identity } = input;
  return {
    writer,
    provenance,
    answered,
    originKey: `doc:${tool}:${lead.agentId}:${lead.wakeupId}:${retryKey(stableStringify(identity))}`,
  };
});

const writeResult = (
  written: {
    readonly row: RecordRow;
    readonly version: { readonly version: number; readonly body: string };
  },
  changed: boolean,
) => ({
  key: written.row.key,
  title: written.row.title,
  version: written.version.version,
  changed,
  outline: [...outlineOf(written.version.body)],
  ...filedOf(written.row),
  ...(sensitiveOf(written.row) ? { sensitive: true as const } : {}),
});
const UNFILED =
  "Not filed: give it a client and project, or company true, with doc_move so people find it.";
const filedOf = (row: RecordRow) => ({
  kind: Docs.kindOf(row),
  ...(Docs.isCompanyDoc(row) ? { company: true as const } : {}),
  ...(row.partyId === null && row.projectId === null && !Docs.isCompanyDoc(row)
    ? { unfiled: UNFILED }
    : {}),
});
const sensitiveOf = (row: RecordRow) => row.sensitive === 1 || row.inheritedSensitive === 1;
const ownerOf = (row: RecordRow): KinWorkPrincipal =>
  row.ownerKind === "agent"
    ? { _tag: "agent", agentId: KinAgentId.make(row.ownerId) }
    : { _tag: "person", personId: KinPersonId.make(row.ownerId) };

/** The doc as a card in the turn's chat, built from the stored version; a retry finds the same one. */
export const shown = Effect.fn("KinDocTools.shown")(function* (
  lead: Lead,
  written: Docs.Written,
  card: boolean | "answer" | undefined,
) {
  if (card !== true && card !== "answer") return;
  const turn = {
    orgId: lead.orgId,
    agentId: lead.agentId,
    wakeupId: KinWakeupId.make(lead.wakeupId),
  };
  const lane = yield* laneFor(turn);
  if (Option.isNone(lane)) return;
  if (card === "answer") {
    if (lane.value.team === true) return;
    if (lane.value.mode !== "reply") {
      const sql = yield* SqlClient.SqlClient;
      const checkIn = yield* sql`SELECT 1 FROM kin_events
        WHERE org_id = ${turn.orgId} AND agent_id = ${turn.agentId} AND wakeup_id = ${turn.wakeupId}
          AND tag = 'pulse' AND json_type(json, '$.checkIn') = 'object' LIMIT 1`;
      if (checkIn.length === 0) return;
    }
  }
  const version = Docs.toVersion(written.version);
  yield* (yield* KinLevelGate).showCard(
    { ...lead, wakeupId: turn.wakeupId },
    {
      chatId: lane.value.chatId,
      clientMessageId: `kin-doc:${turn.wakeupId}:${written.row.recordId}:${written.version.version}`,
      type: KIN_DOC_CARD,
      state: {
        recordId: KinRecordId.make(written.row.recordId),
        key: written.row.key,
        title: written.row.title,
        version: version.version,
        change: {
          at: version.at,
          by: version.provenance.by,
          kind: version.kind,
          summary: version.summary,
        },
        previousVersion: version.baseVersion,
      } satisfies KinDocCardState,
    },
  );
});

/**
 * The one open project a doc the agent left unfiled is plainly for, among those everyone behind
 * the turn sees: the project its linked entries are all in, the one its title names by key or
 * full name, else its client's only open project. Anything less certain stays unfiled.
 */
const projectFor = Effect.fn("KinDocTools.projectFor")(function* (
  lead: Lead,
  input: typeof CreateInput.Type,
  partyId: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const team = yield* viewOf(lead);
  const projects = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    partyId: string | null;
  }>`
    SELECT r.record_id AS "recordId", r.key, r.title, r.party_id AS "partyId" FROM kin_records r
    WHERE r.org_id = ${lead.orgId} AND r.register_id = 'projects'
      AND r.state NOT IN ('done', 'dropped')
      AND ${team === undefined ? sql`1 = 1` : viewSees(sql, team.people)}
    ORDER BY r.key LIMIT 500`;
  const only = (rows: ReadonlyArray<{ readonly recordId: string }>) =>
    rows.length === 1 ? rows[0]!.recordId : undefined;
  if (input.links !== undefined && input.links.length > 0) {
    const linked = yield* sql<{ projectId: string | null }>`SELECT DISTINCT
        CASE WHEN r.register_id = 'projects' THEN r.record_id ELSE r.project_id END AS "projectId"
      FROM kin_records r WHERE r.org_id = ${lead.orgId} AND r.key IN ${sql.in(input.links)}
        AND ${team === undefined ? sql`1 = 1` : viewSees(sql, team.people)}
      ORDER BY 1`;
    const ids = new Set(linked.map((row) => row.projectId));
    const found = only(projects.filter((row) => ids.has(row.recordId)));
    if (found !== undefined && ids.size === 1) return found;
  }
  const title = input.title.toLowerCase();
  const named = only(
    projects.filter(
      (row) =>
        new RegExp(`\\b${row.key}\\b`, "i").test(input.title) ||
        (row.title.length >= 4 && title.includes(row.title.toLowerCase())),
    ),
  );
  if (named !== undefined) return named;
  return partyId === undefined
    ? undefined
    : only(projects.filter((row) => row.partyId === partyId));
});

const OFFERINGS_OWNERS =
  "Only the owner or a co-owner starts What we sell, in a chat only they are in. Nothing was written.";

/** What we sell, as the Docs card starts it: only in a turn no teammate is behind. */
const runStartOfferings = Effect.fnUntraced(function* (lead: Lead, input: typeof CreateInput.Type) {
  yield* admitted(lead, "doc_create", input);
  const behind = yield* turnPeople(lead);
  if (behind === undefined || behind.people.length > 0)
    return yield* new KinChatError({ reason: "not_allowed", message: OFFERINGS_OWNERS });
  const answered = yield* answering(lead, input.sourceEventId);
  const started = yield* startOfferings(lead.orgId, yield* writerFor(lead), behind.owner, {
    body: input.body,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    provenance: {
      audience: yield* effectiveAudience(lead),
      ...(answered === undefined
        ? {}
        : { answered: { messageId: answered.messageId, author: answered.author } }),
    },
  });
  const version = yield* Docs.versionOf(lead.orgId, started.row.recordId);
  if (version === undefined) return yield* Docs.docNotFound(started.row.key);
  const written = { row: started.row, version };
  if (started.made) yield* shown(lead, { ...written, created: true }, input.card ?? "answer");
  const key = started.row.key;
  return {
    ...writeResult(written, started.made),
    ...(started.made
      ? {}
      : {
          note: started.restored
            ? `What we sell is ${key}. It was archived; this call brought it back as it was and wrote nothing else. Change it with doc_edit.`
            : `What we sell is already ${key}; this call wrote nothing. Change it with doc_edit.`,
        }),
  };
});

const runCreate = Effect.fnUntraced(function* (lead: Lead, input: typeof CreateInput.Type) {
  if (input.whatWeSell === true) return yield* runStartOfferings(lead, input);
  const context = yield* writeContext(lead, "doc_create", input);
  const owner = yield* resolveWho(lead, input.owner ?? "you");
  const partyId = yield* refOrNull(lead, input.client, "clients");
  const projectId =
    (yield* refOrNull(lead, input.project, "projects")) ??
    (input.project === undefined && input.company !== true
      ? yield* projectFor(lead, input, partyId ?? undefined)
      : undefined);
  const written = yield* Docs.create(lead.orgId, context.writer, context.provenance, {
    title: input.title,
    body: input.body,
    owner,
    summary: input.summary ?? "Created",
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.company === true ? { company: true } : {}),
    ...(input.sensitive === true ? { sensitive: true } : {}),
    originKey: context.originKey,
    ...(context.answered?.tag === "chat.message"
      ? {
          source: {
            chatId: KinChatId.make(context.answered.chatId),
            messageId: KinMessageId.make(context.answered.messageId),
          },
        }
      : {}),
  });
  if (input.links !== undefined && input.links.length > 0)
    yield* Docs.link(lead.orgId, context.writer, { key: written.row.key }, input.links, "relates");
  yield* shown(lead, written, input.card ?? "answer");
  return writeResult(written, written.created);
});
export const create = leadTool("KinDocTools.create", runCreate);

/**
 * A doc this turn may read, and which of its versions: in one others read, only one they all see,
 * else none at all.
 */
const readable = Effect.fn("KinDocTools.readable")(function* (lead: Lead, key: string) {
  const team = yield* viewOf(lead);
  const viewer = team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people);
  const row = yield* Docs.docRow(lead.orgId, { key }, viewer);
  return { row, seen: yield* Docs.versionsSeen(lead.orgId, viewer, row) };
});

const runRead = Effect.fnUntraced(function* (lead: Lead, input: typeof ReadInput.Type) {
  const { row, seen } = yield* readable(lead, input.key);
  const latest = yield* Docs.versionOf(lead.orgId, row.recordId);
  const found = yield* Docs.versionOf(lead.orgId, row.recordId, input.version);
  const version = found !== undefined && seen(found.version) ? found : undefined;
  if (latest === undefined) return yield* Docs.docNotFound(input.key);
  if (version === undefined)
    return yield* invalid(
      `${row.key} has no version ${input.version}; it is at ${latest.version}.`,
    );
  const name = yield* namer(lead);
  const unseen = yield* unseenOf(lead, [row.partyId, row.projectId]);
  const parts = sectionsOf(version.body);
  const asked =
    input.sections === undefined
      ? undefined
      : input.sections.map((id) => {
          const found = parts.find((part) => part.id === id);
          return found === undefined
            ? { id, title: "", hash: "", text: "(no such section)" }
            : { id: found.id, title: found.title, hash: found.hash, text: found.text };
        });
  const whole = asked === undefined && version.body.length <= WHOLE_DOC;
  const by = Docs.toVersion(version).provenance.by;
  return {
    key: row.key,
    title: row.title,
    version: version.version,
    latestVersion: latest.version,
    chars: version.body.length,
    updated: {
      at: iso(version.createdAt),
      by: by._tag === "system" ? "Kin" : (name(by) ?? "someone"),
      summary: version.summary,
    },
    outline: [...outlineOf(version.body)],
    ...(whole ? { body: version.body } : {}),
    ...(asked === undefined ? {} : { sections: asked }),
    ...(whole || asked !== undefined
      ? {}
      : { note: "A long doc: read the sections you need by id." }),
    owner: name(ownerOf(row)) ?? "someone",
    ...(row.partyKey === null || unseen.has(row.partyId ?? "")
      ? {}
      : { client: `${row.partyTitle} (${row.partyKey})` }),
    ...(row.projectKey === null || unseen.has(row.projectId ?? "")
      ? {}
      : { project: `${row.projectTitle} (${row.projectKey})` }),
    ...(row.state === "dropped" ? { archived: true as const } : {}),
    ...(sensitiveOf(row) ? { sensitive: true as const } : {}),
  };
});
export const read = leadTool("KinDocTools.read", runRead);

const runEdit = Effect.fnUntraced(function* (lead: Lead, input: typeof EditInput.Type) {
  const context = yield* writeContext(lead, "doc_edit", input);
  const written = yield* Docs.edit(lead.orgId, context.writer, context.provenance, input, {
    operations: input.operations,
    summary: input.summary,
    originKey: context.originKey,
  });
  yield* shown(lead, written, input.card);
  return writeResult(written, written.created);
});
export const edit = leadTool("KinDocTools.edit", runEdit);

const runRewrite = Effect.fnUntraced(function* (lead: Lead, input: typeof RewriteInput.Type) {
  const context = yield* writeContext(lead, "doc_rewrite", input);
  const written = yield* Docs.rewrite(lead.orgId, context.writer, context.provenance, input, {
    body: input.body,
    baseVersion: input.baseVersion,
    summary: input.summary,
    originKey: context.originKey,
  });
  yield* shown(lead, written, input.card);
  return writeResult(written, written.created);
});
export const rewrite = leadTool("KinDocTools.rewrite", runRewrite);

const runMove = Effect.fnUntraced(function* (lead: Lead, input: typeof MoveInput.Type) {
  const context = yield* writeContext(lead, "doc_move", input);
  const partyId = yield* refOrNull(lead, input.client, "clients");
  const projectId = yield* refOrNull(lead, input.project, "projects");
  const owner = input.owner === undefined ? undefined : yield* resolveWho(lead, input.owner);
  const { row } = yield* Docs.move(lead.orgId, context.writer, input, {
    ...(partyId === undefined ? {} : { partyId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(owner === undefined ? {} : { owner }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.company === undefined ? {} : { company: input.company }),
    ...(input.sensitive === true ? { sensitive: true } : {}),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  });
  const name = yield* namer(lead);
  const unseen = yield* unseenOf(lead, [row.partyId, row.projectId]);
  return {
    key: row.key,
    title: row.title,
    owner: name(ownerOf(row)) ?? "someone",
    ...(row.partyKey === null || unseen.has(row.partyId ?? "")
      ? {}
      : { client: `${row.partyTitle} (${row.partyKey})` }),
    ...(row.projectKey === null || unseen.has(row.projectId ?? "")
      ? {}
      : { project: `${row.projectTitle} (${row.projectKey})` }),
    archived: row.state === "dropped",
    ...filedOf(row),
    ...(sensitiveOf(row) ? { sensitive: true as const } : {}),
  };
});
export const move = leadTool("KinDocTools.move", runMove);

const runLink = Effect.fnUntraced(function* (lead: Lead, input: typeof LinkInput.Type) {
  const context = yield* writeContext(lead, "doc_link", input);
  const linked = yield* Docs.link(lead.orgId, context.writer, input, input.to, "relates");
  return {
    key: input.key,
    linked: linked.map(({ key, title, sensitive }) => ({
      key,
      title,
      ...(sensitive ? { sensitive: true as const } : {}),
    })),
  };
});
export const link = leadTool("KinDocTools.link", runLink);

const runSearch = Effect.fnUntraced(function* (lead: Lead, input: typeof SearchInput.Type) {
  const team = yield* viewOf(lead);
  const { hits, widened } = yield* search(lead.orgId, {
    text: input.text,
    kinds: input.kinds,
    closed: input.closed,
    limit: input.limit ?? 10,
    viewer: team === undefined ? "owner" : "team",
    scope: team === undefined ? KIN_OWNER_LEVEL : viewerOfPeople(team.people),
    widen: true,
  });
  return {
    ...(widened ? { widened: WIDENED } : {}),
    hits: hits.map((hit) => ({
      key: hit.key,
      kind: hit.kind,
      title: hit.title,
      snippet: hit.snippet,
      ...(hit.section === undefined ? {} : { section: hit.section }),
      ...(hit.closed ? { closed: true as const } : {}),
      ...(hit.sensitive ? { sensitive: true as const } : {}),
    })),
  };
});
export const searchTool = leadTool("KinDocTools.search", runSearch);

const runHistory = Effect.fnUntraced(function* (lead: Lead, input: typeof HistoryInput.Type) {
  const { row, seen } = yield* readable(lead, input.key);
  const latest = yield* Docs.versionOf(lead.orgId, row.recordId);
  if (latest === undefined) return yield* Docs.docNotFound(input.key);
  const rows = yield* Docs.history(lead.orgId, row.recordId, {
    ...(input.before === undefined ? {} : { before: input.before }),
    limit: input.limit ?? 10,
  });
  const name = yield* namer(lead);
  return {
    key: row.key,
    latestVersion: latest.version,
    versions: rows
      .filter((one) => seen(one.version))
      .map((one) => {
        const version = Docs.toVersion(one);
        const sections = version.operations.flatMap((op) =>
          op.section === undefined ? [] : [op.section],
        );
        return {
          version: version.version,
          at: version.at,
          by:
            version.provenance.by._tag === "system"
              ? "Kin"
              : (name(version.provenance.by) ?? "someone"),
          kind: version.kind,
          summary: version.summary,
          ...(version.restoredFrom === null ? {} : { restoredFrom: version.restoredFrom }),
          ...(sections.length === 0 ? {} : { sections: [...new Set(sections)] }),
        };
      }),
    ...(sensitiveOf(row) ? { sensitive: true as const } : {}),
  };
});
export const history = leadTool("KinDocTools.history", runHistory);

/** An undo: a new version, undoable again, so it needs no more than a rewrite does. */
const runRestore = Effect.fnUntraced(function* (lead: Lead, input: typeof RestoreInput.Type) {
  const context = yield* writeContext(lead, "doc_restore", input);
  const written = yield* Docs.restore(lead.orgId, context.writer, context.provenance, input, {
    version: input.version,
    latest: input.latest,
    originKey: context.originKey,
  });
  yield* shown(lead, written, input.card);
  return writeResult(written, written.created);
});
export const restore = leadTool("KinDocTools.restore", runRestore);
