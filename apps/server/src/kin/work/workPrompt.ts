import type { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { codingAgentSource, codingAgentTextShown } from "../lead/OutsideContent.ts";
import { SILENT_REPLY } from "../reply/classify.ts";
import { dayIn, dayWords, timeIn } from "./money.ts";
import { ownerZone } from "./recordRows.ts";
import { crmSeenBy, KIN_OWNER_LEVEL, seenBy, type KinViewer } from "./teamView.ts";
import { WEEK_MS } from "../durations.ts";

/**
 * The Work section of a lead's prompt, built by SQL at turn time. Status has one home: counts of
 * what the lead owns, and only what changed since it last spoke in this chat, by anyone but
 * itself. Its cursor moves once a reply of its posts there, so an unchanged item it already
 * reported is not in view to repeat, and a finished one shows once.
 */

const decodeFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ field: Schema.String, to: Schema.NullOr(Schema.String) })),
  ),
);
const CHANGED_CAP = 15;

const OPEN = ["open", "doing", "waiting"] as const;
const CONTACTS_SHOWN = 3;

/** Who a task is about, as a turn reads it: its client by name and key, and so on. */
export type TaskFacts = {
  readonly client?: string;
  /** That client's recorded contacts, newest first; "none recorded" when it has none. */
  readonly contacts?: ReadonlyArray<string> | "none recorded";
  readonly project?: string;
  /** It is the client's next step: its soonest open task of ours, as Clients shows it. */
  readonly clientNextStep?: true;
};

/**
 * Each task's client, that client's contacts, its project and whether it is the client's next
 * step, from the records: only what `viewer` sees in Clients (a project, in Work).
 */
export const taskFacts = Effect.fn("KinWorkPrompt.taskFacts")(function* (
  orgId: KinOrgId,
  recordIds: ReadonlyArray<string>,
  viewer: KinViewer,
) {
  const sql = yield* SqlClient.SqlClient;
  const facts = new Map<string, TaskFacts>();
  if (recordIds.length === 0) return facts;
  const tasks = yield* sql<{
    recordId: string;
    key: string;
    partyId: string | null;
    projectId: string | null;
  }>`SELECT r.record_id AS "recordId", r.key, r.party_id AS "partyId",
      r.project_id AS "projectId"
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
      AND r.record_id IN ${sql.in([...new Set(recordIds)])} AND ${seenBy(sql, viewer)}
    ORDER BY r.record_id`;
  const ids = (pick: (task: (typeof tasks)[number]) => string | null) => [
    ...new Set(tasks.flatMap((task) => (pick(task) === null ? [] : [pick(task)!]))),
  ];
  const named = (rows: ReadonlyArray<{ id: string; key: string; title: string }>) =>
    new Map(rows.map((row) => [row.id, `${row.title} (${row.key})`]));
  const parties = ids((task) => task.partyId);
  const projects = ids((task) => task.projectId);
  const clients = named(
    parties.length === 0
      ? []
      : yield* sql<{ id: string; key: string; title: string }>`SELECT r.record_id AS id, r.key,
          r.title FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'clients'
            AND r.record_id IN ${sql.in(parties)} AND ${crmSeenBy(sql, viewer)}
          ORDER BY r.record_id`,
  );
  const seenProjects = named(
    projects.length === 0
      ? []
      : yield* sql<{ id: string; key: string; title: string }>`SELECT r.record_id AS id, r.key,
          r.title FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'projects'
            AND r.record_id IN ${sql.in(projects)} AND ${seenBy(sql, viewer)}
          ORDER BY r.record_id`,
  );
  const seenClients = [...clients.keys()];
  const people =
    seenClients.length === 0
      ? []
      : yield* sql<{ partyId: string; key: string; title: string }>`SELECT r.party_id AS "partyId",
          r.key, r.title FROM kin_records r WHERE r.org_id = ${orgId}
            AND r.register_id = 'contacts' AND r.state = 'open'
            AND r.party_id IN ${sql.in(seenClients)} AND ${crmSeenBy(sql, viewer)}
          ORDER BY r.party_id, r.created_at DESC, r.key DESC`;
  const next =
    seenClients.length === 0
      ? []
      : yield* sql<{ partyId: string; key: string }>`SELECT party_id AS "partyId", key
          FROM (SELECT r.party_id, r.key, ROW_NUMBER() OVER (PARTITION BY r.party_id
              ORDER BY r.due_at IS NULL, r.due_at, r.key) AS n
            FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
              AND r.side = 'ours' AND r.state IN ${sql.in(OPEN)}
              AND r.party_id IN ${sql.in(seenClients)} AND ${crmSeenBy(sql, viewer)})
          WHERE n = 1 ORDER BY party_id`;
  const nextBy = new Map(next.map((row) => [row.partyId, row.key]));
  for (const task of tasks) {
    const client = task.partyId === null ? undefined : clients.get(task.partyId);
    const project = task.projectId === null ? undefined : seenProjects.get(task.projectId);
    const theirs = people
      .filter((person) => person.partyId === task.partyId)
      .slice(0, CONTACTS_SHOWN)
      .map((person) => `${person.title} (${person.key})`);
    facts.set(task.recordId, {
      ...(client === undefined
        ? {}
        : {
            client,
            contacts: theirs.length === 0 ? ("none recorded" as const) : theirs,
            ...(nextBy.get(task.partyId!) === task.key ? { clientNextStep: true as const } : {}),
          }),
      ...(project === undefined ? {} : { project }),
    });
  }
  return facts;
});

export type WorkSection = {
  readonly asOf: string;
  readonly open: number;
  readonly doing: number;
  readonly waiting: number;
  readonly late: number;
  readonly dueThisWeek: number;
  readonly changed: ReadonlyArray<
    {
      readonly key: string;
      readonly title: string;
      readonly state: string;
      readonly due: string | null;
      readonly dueDay?: string;
      readonly changes: ReadonlyArray<string>;
    } & TaskFacts
  >;
  readonly moreChanged: number;
};

/** Promotes the pending cursor once the lead's reply posted after it was set. */
const settledCursor = Effect.fn("KinWorkPrompt.cursor")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    seq: number;
    pendingSeq: number | null;
    pendingMsgSeq: number | null;
  }>`
    SELECT seq, pending_seq AS "pendingSeq", pending_msg_seq AS "pendingMsgSeq"
    FROM kin_record_cursors WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}
      AND chat_id = ${input.chatId}`;
  if (row === undefined) return 0;
  if (row.pendingSeq === null || row.pendingMsgSeq === null) return row.seq;
  // A silent or failed turn told nobody anything, so it moves nothing.
  const replied = yield* sql`SELECT 1 FROM kin_messages WHERE org_id = ${input.orgId}
    AND chat_id = ${input.chatId} AND seq > ${row.pendingMsgSeq} AND author_kind = 'agent'
    AND author_agent_id = ${input.agentId} AND status = 'posted' AND silent = 0 LIMIT 1`;
  if (replied.length === 0) return row.seq;
  const seq = Math.max(row.seq, row.pendingSeq);
  yield* sql`UPDATE kin_record_cursors SET seq = ${seq}, pending_seq = NULL, pending_msg_seq = NULL
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND chat_id = ${input.chatId}`;
  return seq;
});

export const buildWorkSection = Effect.fn("KinWorkPrompt.build")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
  readonly now: number;
  /** The turn it is shown to: a change a coding agent made marks it before the section is read. */
  readonly wakeupId?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, chatId, now } = input;
  const since = yield* settledCursor(input);
  const [counts] = yield* sql<{
    open: number;
    doing: number | null;
    waiting: number | null;
    late: number | null;
    dueThisWeek: number | null;
  }>`SELECT COUNT(*) AS open, SUM(state = 'doing') AS doing, SUM(state = 'waiting') AS waiting,
      SUM(due_at IS NOT NULL AND due_at < ${now}) AS late,
      SUM(due_at IS NOT NULL AND due_at >= ${now} AND due_at < ${now + WEEK_MS}) AS "dueThisWeek"
    FROM kin_records WHERE org_id = ${orgId} AND register_id = 'work' AND owner_kind = 'agent'
      AND owner_id = ${agentId} AND state NOT IN ('done', 'dropped')`;
  const changes = yield* sql<{
    seq: number;
    recordId: string;
    key: string;
    title: string;
    state: string;
    dueAt: number | null;
    dueAllDay: number;
    kind: string;
    actorKind: string;
    fieldsJson: string;
    codingAgent: string | null;
  }>`SELECT c.seq, r.record_id AS "recordId", r.key, r.title, r.state, r.due_at AS "dueAt", r.due_all_day AS "dueAllDay",
      c.kind, c.actor_kind AS "actorKind", c.fields_json AS "fieldsJson",
      CASE WHEN c.coding_agent_key IS NULL THEN NULL ELSE COALESCE((SELECT k.label
        FROM kin_tasks_keys k WHERE k.org_id = c.org_id AND k.session_id = c.coding_agent_key),
        'Coding agent') END AS "codingAgent"
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.seq > ${since} AND r.register_id = 'work'
      AND r.owner_kind = 'agent' AND r.owner_id = ${agentId}
      AND NOT (c.actor_kind = 'agent' AND c.actor_id IS ${agentId})
    ORDER BY c.seq`;
  const [latest] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId}`;
  const [chat] = yield* sql<{ lastSeq: number }>`SELECT last_seq AS "lastSeq" FROM kin_chats
    WHERE org_id = ${orgId} AND chat_id = ${chatId}`;
  if (chat !== undefined)
    yield* sql`INSERT INTO kin_record_cursors (org_id, agent_id, chat_id, seq, pending_seq,
        pending_msg_seq)
      VALUES (${orgId}, ${agentId}, ${chatId}, ${since}, ${latest?.seq ?? 0}, ${chat.lastSeq})
      ON CONFLICT (org_id, agent_id, chat_id) DO UPDATE SET pending_seq = excluded.pending_seq,
        pending_msg_seq = excluded.pending_msg_seq`;
  const keyed = changes.find((change) => change.codingAgent !== null)?.codingAgent;
  if (keyed != null && input.wakeupId !== undefined)
    yield* codingAgentTextShown({ orgId, wakeupId: input.wakeupId }, codingAgentSource(keyed));
  const byKey = new Map<string, { row: (typeof changes)[number]; lines: Array<string> }>();
  for (const change of changes) {
    const entry = byKey.get(change.key) ?? { row: change, lines: [] };
    entry.row = change;
    const who =
      change.actorKind === "system"
        ? "Kin"
        : change.actorKind === "person"
          ? change.codingAgent === null
            ? "a person"
            : "a person, via their coding agent"
          : "another agent";
    const fields = Option.getOrElse(decodeFields(change.fieldsJson), () => []);
    entry.lines.push(
      change.kind === "created"
        ? `created by ${who}`
        : `${fields
            .map((field) =>
              field.field === "owner" && field.to === `agent:${agentId}`
                ? "given to you"
                : `${field.field} → ${field.to ?? "cleared"}`,
            )
            .join(", ")} (${who})`,
    );
    byKey.set(change.key, entry);
  }
  const all = [...byKey.values()];
  const shown = all.slice(-CHANGED_CAP);
  // The section is the owner's own (`LeadPrompt`): his level reads every client.
  const about = yield* taskFacts(
    orgId,
    shown.map(({ row }) => row.recordId),
    KIN_OWNER_LEVEL,
  );
  const zone = yield* ownerZone(orgId);
  return {
    asOf: timeIn(now, zone),
    open: counts?.open ?? 0,
    doing: counts?.doing ?? 0,
    waiting: counts?.waiting ?? 0,
    late: counts?.late ?? 0,
    dueThisWeek: counts?.dueThisWeek ?? 0,
    changed: shown.map(({ row, lines }) => ({
      key: row.key,
      title: row.title,
      state: row.state,
      due:
        row.dueAt === null
          ? null
          : row.dueAllDay === 1
            ? dayIn(row.dueAt, zone)
            : timeIn(row.dueAt, zone),
      ...(row.dueAt === null ? {} : { dueDay: dayWords(row.dueAt, zone) }),
      changes: lines.slice(-4),
      ...about.get(row.recordId),
    })),
    moreChanged: Math.max(0, all.length - CHANGED_CAP),
  } satisfies WorkSection;
});

export const WORK_RULE =
  "Where work stands comes only from this section and the records tools, never from memory or earlier messages. `changed` lists only what others changed since you last spoke in this chat. Anything not in it you have already reported or nothing happened to it: don't bring it up again unless asked.";

export const MONEY_RULE =
  "Kin calculated these figures from the records, exactly and per currency. Quote what needs the owner, such as what is overdue and dates coming up.";

/** The event line for an open entry the owner closed or took back while this lead held it. */
export const WITHDRAWN_WORK = `The owner closed this Work entry or took it back from you. If a task you started for it is still working, stop it with task_cancel; start nothing new and leave the entry as it is. Reply only if the owner needs to know something about it, in one line; otherwise write exactly ${SILENT_REPLY}.`;
