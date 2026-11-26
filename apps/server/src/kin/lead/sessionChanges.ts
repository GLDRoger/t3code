import type { KinAgentId, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { Memory } from "../memory/Memory.ts";
import { accessSql } from "../people/KinAccess.ts";
import { commentIdFor } from "../work/recordComments.ts";
import { turnChat } from "./Audience.ts";
import { parseChanges, sensitiveNow } from "../work/recordRows.ts";
import { PRESETS } from "../work/registers.ts";
import { chatClock, SESSION_CHANGES_CAP } from "./LeadPrompt.ts";
import { cappedText, encoded } from "./quote.ts";

// A write stamped before the cursor can commit after it.
const CHANGE_TIME_MARGIN_MS = 5_000;
const CHANGE_ROWS_LIMIT = SESSION_CHANGES_CAP * 4 + 1;
const OVERFLOW_GROUPS_LIMIT = 256;

class SessionChangesNotOwnerChat extends Schema.TaggedError<SessionChangesNotOwnerChat>()(
  "SessionChangesNotOwnerChat",
  {},
) {}

class SessionChangesSourceFailed extends Schema.TaggedError<SessionChangesSourceFailed>()(
  "SessionChangesSourceFailed",
  {
    source: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeListIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const isSessionChangesSourceFailed = Schema.is(SessionChangesSourceFailed);

const source = <A, E, R>(name: string, read: Effect.Effect<A, E, R>) =>
  read.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const known = Cause.findErrorOption(cause);
      return Effect.fail(
        Option.isSome(known) && isSessionChangesSourceFailed(known.value)
          ? known.value
          : new SessionChangesSourceFailed({ source: name, cause }),
      );
    }),
  );

export interface Cursor {
  readonly changeSeq: number;
  readonly at: number;
  readonly memoryHead: string | null;
  readonly chatSeq: number;
  readonly chatId: string | null;
  readonly chatChangeSeq: number;
  readonly chatVersions: ReadonlyArray<{
    readonly id: string;
    readonly seq: number;
    readonly changeSeq: number;
  }>;
}

export interface OverflowGroup {
  readonly list: string;
  readonly who: string;
  readonly count: number;
  readonly via?: "import";
  readonly source?: "memory" | "chat" | "pulse";
}

const CHAT_CURSOR_LIMIT = 1_000;

export const readCursor = Effect.fn("KinSessionChanges.cursor")(function* (
  orgId: KinOrgId,
  chatId: string | null,
  memoryHead: string | null,
  agentId: KinAgentId,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ changeSeq: number }>`SELECT
    COALESCE(MAX(seq), 0) AS "changeSeq" FROM kin_record_changes WHERE org_id = ${orgId}`;
  const chatVersions = yield* sql<Cursor["chatVersions"][number]>`
    SELECT c.chat_id AS id, c.last_seq AS seq, c.change_seq AS "changeSeq" FROM kin_chats c
    WHERE c.org_id = ${orgId} AND (c.chat_id = ${chatId} OR EXISTS (
      SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.agent_id = ${agentId} AND m.left_at IS NULL))
    ORDER BY c.chat_id LIMIT ${CHAT_CURSOR_LIMIT + 1}`;
  if (chatVersions.length > CHAT_CURSOR_LIMIT)
    return yield* new SessionChangesSourceFailed({
      source: "chat cursor",
      cause: "Too many chats",
    });
  const chat = chatVersions.find(({ id }) => id === chatId);
  return {
    changeSeq: row?.changeSeq ?? 0,
    at,
    memoryHead,
    chatId,
    chatSeq: chat?.seq ?? 0,
    chatChangeSeq: chat?.changeSeq ?? 0,
    chatVersions,
  } satisfies Cursor;
});

export const captureChatCursor = Effect.fn("KinSessionChanges.captureChatCursor")(function* (
  turn: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
    readonly threadId?: string | null;
    readonly startedAt?: number;
  },
  cursor: Pick<Cursor, "chatId" | "chatSeq" | "chatChangeSeq">,
) {
  const sql = yield* SqlClient.SqlClient;
  const started =
    turn.startedAt === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(turn.startedAt));
  const held = yield* sql<{ seq: number; changeSeq: number; edited: number }>`
    SELECT m.seq, m.change_seq AS "changeSeq",
      (m.edited_at IS NOT NULL OR m.withdrawn_json IS NOT NULL) AS edited
    FROM kin_messages m
    WHERE m.org_id = ${turn.orgId} AND m.chat_id = ${cursor.chatId}
      AND ((m.author_agent_id = ${turn.agentId} AND (m.source_wakeup_id = ${turn.wakeupId}
        OR (m.source_wakeup_id IS NULL AND m.author_thread_id = ${turn.threadId ?? null}
          AND m.created_at >= ${started} AND m.seq > ${cursor.chatSeq})))
        OR m.message_id IN (SELECT json_extract(e.json, '$.messageId') FROM kin_events e
          WHERE e.org_id = m.org_id AND e.agent_id = ${turn.agentId} AND e.wakeup_id = ${turn.wakeupId}
            AND e.tag IN ('chat.message', 'widget.action') AND json_extract(e.json, '$.chatId') = m.chat_id))
    ORDER BY m.change_seq LIMIT ${CHANGE_ROWS_LIMIT}`;
  if (held.length === CHANGE_ROWS_LIMIT)
    return yield* new SessionChangesSourceFailed({
      source: "chat capture",
      cause: "Too many held messages",
    });
  return {
    chatSeq: held.reduce((seq, message) => Math.max(seq, message.seq), 0),
    chatChangeSeq: cursor.chatChangeSeq,
    heldChatChanges: held
      .filter(({ edited, changeSeq }) => edited === 0 && changeSeq > cursor.chatChangeSeq)
      .map(({ changeSeq }) => changeSeq),
  };
});

interface Input {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: string;
  readonly sessionWakeupIds: ReadonlyArray<KinWakeupId>;
  readonly from: Cursor;
  readonly to: Cursor;
  readonly now: number;
  readonly zone: string;
  readonly workChanges?: ReadonlyMap<string, ReadonlySet<number>>;
}

interface Line {
  readonly at: number;
  readonly list: string;
  readonly who: string;
  readonly via?: "import";
  readonly source?: OverflowGroup["source"];
  readonly text?: string | undefined;
  readonly count?: number;
}

interface Speaker {
  readonly actorKind: string | null;
  readonly actorId: string | null;
  readonly person: string | null;
  readonly access: string | null;
  readonly agent: string | null;
}

interface Entry extends Speaker {
  readonly key: string;
  readonly title: string;
  readonly list: string;
  readonly at: number;
  readonly sensitive: number;
  readonly outside: number;
  readonly coding: number;
}

interface RecordChange extends Entry {
  readonly rank: number;
  readonly seq: number;
  readonly kind: string;
  readonly fields: string;
  readonly via: string;
  readonly chat: string | null;
}

const speakerColumns = (sql: SqlClient.SqlClient) => sql`
  p.display_name AS person, ${sql.literal(accessSql("p"))} AS access, a.display_name AS agent`;

// Words under eval: change them only with the carry cases.
const whoOf = (row: Speaker, agentId: KinAgentId, via?: string, chat?: string | null) => {
  if (via === "worker") return "your task";
  if (row.actorKind === "agent")
    return row.actorId === agentId
      ? chat === undefined
        ? "you"
        : `you, in ${cappedText(chat ?? "another chat", 120)}`
      : `${cappedText(row.agent ?? "unknown", 120)} (agent)`;
  if (row.actorKind !== "person") return "Kin";
  const name = cappedText(row.person ?? "someone", 120);
  return row.access === "owner"
    ? `${name} (owner)`
    : row.access === "co_owner"
      ? `${name} (co-owner)`
      : name;
};

const outsideWords = (subject: string, when: string, coding: boolean) =>
  `${subject}: changed from outside content${coding ? " (a coding agent)" : ""}, ${when}; its words aren't shown here`;
const importUndoneWords = (list: string, who: string, when: string) =>
  `${list}: import undone by ${who}, ${when}`;
const editedChatWords = (title: string, count: number) =>
  `${title}: ${count} message${count === 1 ? "" : "s"} edited or withdrawn`;
const contactWords = (activity: string) =>
  activity === "logged" ? "contact logged" : "contact removed";
const sensitiveWords = (subject: string, when: string, who: string) =>
  `${subject}: changed by ${who}, ${when}; a sensitive entry, not shown here`;

const entryLine = (
  row: Entry,
  input: Input,
  words: () => string,
  via?: string,
  chat?: string | null,
): Line => {
  const who = whoOf(row, input.agentId, via, chat);
  const imported = via === "import";
  const by = imported ? `${who} (import)` : who;
  const when = chatClock(row.at, input.now, input.zone);
  const list = cappedText(row.list, 120);
  const subject = `${row.key} (${list})`;
  return {
    at: row.at,
    list,
    who: row.outside === 1 ? "outside content" : who,
    ...(imported && row.outside !== 1 ? { via: "import" as const } : {}),
    text:
      row.outside === 1
        ? outsideWords(subject, when, row.coding === 1)
        : row.sensitive === 1
          ? sensitiveWords(subject, when, by)
          : `${row.key} ${encoded(cappedText(row.title, 160))} (${list}): ${words()} by ${by}, ${when}`,
  };
};

const recordWords = (row: RecordChange) => {
  if (row.kind === "created") return "created";
  const fields = parseChanges(row.fields);
  if (fields.some(({ field, to }) => field === "state" && to === "dropped")) return "deleted";
  const words = fields.map(({ field, from, to }) => {
    if (field === "notes" || field === "body" || field === "description" || field === "summary")
      return `${field} edited`;
    if (field === "version") return `edited, version ${from ?? "none"} → ${to ?? "cleared"}`;
    if (field === "payment") return `payment ${to ?? "cleared"}`;
    return `${cappedText(field, 80)} → ${to == null ? "cleared" : encoded(cappedText(to, 160))}`;
  });
  return words.length > 0 ? words.join(", ") : row.kind;
};

const titleSource = (sql: SqlClient.SqlClient, condition: Statement.Statement<unknown>) => sql`
  COALESCE((SELECT ${condition} FROM kin_record_changes tc
    LEFT JOIN kin_event_outside os ON os.org_id = tc.org_id
      AND os.event_id = 'record-change:' || tc.record_id || ':' || tc.seq
    WHERE tc.org_id = r.org_id AND tc.record_id = r.record_id
      AND (tc.kind = 'created' OR EXISTS (SELECT 1 FROM json_each(tc.fields_json)
        WHERE json_extract(value, '$.field') = 'title'))
    ORDER BY tc.seq DESC LIMIT 1), 0)`;

const recordChanges = Effect.fn("KinSessionChanges.records")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, from, to, sessionWakeupIds } = input;
  const own =
    sessionWakeupIds.length === 0
      ? sql`0`
      : sql`
    (c.actor_kind = 'agent' AND c.actor_id IS ${agentId} AND c.wakeup_id IS NOT NULL
      AND c.wakeup_id IN ${sql.in(sessionWakeupIds)})`;
  const shownByWork = Array.from(input.workChanges ?? [], ([key, seqs]) =>
    Array.from(seqs, (seq) => ({ key, seq })),
  ).flat();
  const shownJson = yield* encodeJson(shownByWork);
  const changes = sql`
    SELECT c.org_id, c.record_id, c.seq, c.at, c.kind, c.fields_json, c.via, c.chat_id,
      c.actor_kind, c.actor_id, c.coding_agent_key,
      ROW_NUMBER() OVER (PARTITION BY c.record_id ORDER BY c.seq DESC) AS rank
    FROM kin_record_changes c JOIN kin_records r USING (org_id, record_id)
    WHERE c.org_id = ${orgId} AND c.seq > ${from.changeSeq} AND c.seq <= ${to.changeSeq}
      AND NOT ${own}
      AND NOT EXISTS (SELECT 1 FROM json_each(${shownJson}) w
        WHERE json_extract(w.value, '$.seq') = c.seq AND json_extract(w.value, '$.key') = r.key)
  `;
  const joins = sql`
    JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = c.org_id AND c.actor_kind = 'person' AND p.person_id = c.actor_id
    LEFT JOIN kin_agents a ON a.org_id = c.org_id AND c.actor_kind = 'agent' AND a.agent_id = c.actor_id
    LEFT JOIN kin_chats h ON h.org_id = c.org_id AND h.chat_id = c.chat_id
    LEFT JOIN kin_event_outside o ON o.org_id = c.org_id
      AND o.event_id = 'record-change:' || c.record_id || ':' || c.seq
  `;
  const eventOutside = sql`(c.coding_agent_key IS NOT NULL OR c.via = 'github' OR o.event_id IS NOT NULL)`;
  const outside = sql`(${eventOutside} OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)})`;
  const rows = yield* sql<RecordChange>`WITH changes AS (${changes}),
    recent AS (SELECT * FROM changes ORDER BY at DESC, seq DESC LIMIT ${CHANGE_ROWS_LIMIT})
    SELECT r.key, r.title, l.name AS list, c.at, c.seq, c.rank, c.kind, c.fields_json AS fields, c.via,
      h.title AS chat, c.actor_kind AS "actorKind", c.actor_id AS "actorId", ${speakerColumns(sql)},
      ${sensitiveNow(sql)} AS sensitive,
      (c.coding_agent_key IS NOT NULL OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)}) AS coding,
      ${outside} AS outside
    FROM recent c ${joins} ORDER BY c.at, c.seq`;
  const lines = rows.map((row) => {
    const line = entryLine(row, input, () => recordWords(row), row.via, row.chat);
    return row.rank <= 4 ? line : { ...line, text: undefined };
  });
  const oldest = rows[0];
  if (rows.length < CHANGE_ROWS_LIMIT || oldest === undefined) return lines;
  const rest = yield* sql<
    Speaker & {
      list: string;
      via: string;
      chat: string | null;
      at: number;
      outside: number;
      count: number;
      total: number;
    }
  >`WITH changes AS (${changes})
    SELECT l.name AS list, CASE WHEN c.via IN ('worker', 'import') THEN c.via ELSE '' END AS via,
      h.title AS chat, c.actor_kind AS "actorKind", c.actor_id AS "actorId", ${speakerColumns(sql)},
      ${eventOutside} AS outside, MAX(c.at) AS at, COUNT(*) AS count, SUM(COUNT(*)) OVER () AS total
    FROM changes c ${joins}
    WHERE (c.at, c.seq) < (${oldest.at}, ${oldest.seq})
    GROUP BY list, via, chat, "actorKind", "actorId", outside
    ORDER BY at DESC, list, "actorId" LIMIT ${OVERFLOW_GROUPS_LIMIT}`;
  const total = rest[0]?.total ?? 0;
  const grouped = rest.map((row): Line => ({
    at: row.at,
    list: cappedText(row.list, 120),
    who: row.outside === 1 ? "outside content" : whoOf(row, agentId, row.via, row.chat),
    ...(row.via === "import" && row.outside !== 1 ? { via: "import" as const } : {}),
    count: row.count,
  }));
  const more = total - rest.reduce((sum, row) => sum + row.count, 0);
  return [
    ...grouped,
    ...(more === 0
      ? []
      : [{ at: oldest.at, list: "Work lists", who: "various authors", count: more }]),
    ...lines,
  ];
});

const commentChanges = Effect.fn("KinSessionChanges.comments")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, from, to } = input;
  const lower = from.at - CHANGE_TIME_MARGIN_MS;
  const rows = yield* sql<
    Entry & {
      activity: string;
      commentId: string;
      recordId: string;
      requestHash: string;
      wakeupId: KinWakeupId | null;
      total: number;
    }
  >`WITH activity AS (
      SELECT org_id, comment_id, record_id, request_hash, created_at AS at, author_kind, author_id,
        coding_agent_key, 'comment added' AS activity FROM kin_record_comments WHERE org_id = ${orgId}
        AND created_at > ${lower} AND created_at <= ${to.at}
      UNION ALL
      SELECT org_id, comment_id, record_id, request_hash, removed_at, removed_by_kind, removed_by_id,
        coding_agent_key, 'comment removed' FROM kin_record_comments WHERE org_id = ${orgId}
        AND removed_at > ${lower} AND removed_at <= ${to.at}
    )
    SELECT r.key, r.title, l.name AS list, c.at, c.activity, c.author_kind AS "actorKind",
      c.author_id AS "actorId", c.comment_id AS "commentId", r.record_id AS "recordId",
      c.request_hash AS "requestHash", ${speakerColumns(sql)}, ${sensitiveNow(sql)} AS sensitive,
      (SELECT w.wakeup_id FROM kin_wakeups w
        WHERE c.author_kind = 'agent' AND c.author_id = ${agentId}
          AND w.org_id = c.org_id AND w.agent_id = c.author_id AND w.started_at <= c.at
          AND (w.ended_at IS NULL OR w.ended_at >= c.at)
        ORDER BY w.started_at DESC, w.wakeup_id DESC LIMIT 1) AS "wakeupId",
      (c.coding_agent_key IS NOT NULL OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)}) AS coding,
      (c.coding_agent_key IS NOT NULL
        OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)}) AS outside,
      COUNT(*) OVER () AS total
    FROM activity c JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = c.org_id AND c.author_kind = 'person' AND p.person_id = c.author_id
    LEFT JOIN kin_agents a ON a.org_id = c.org_id AND c.author_kind = 'agent' AND a.agent_id = c.author_id
    ORDER BY c.at DESC, c.comment_id DESC, c.activity DESC LIMIT ${CHANGE_ROWS_LIMIT}`;
  const lines: Line[] = [];
  const titles = new Map<KinWakeupId, string | null>();
  for (const row of rows.toReversed()) {
    let chat: string | null | undefined;
    if (row.actorKind === "agent" && row.actorId === agentId) {
      chat = null;
      // The comment id includes its wake-up and request hash but the row has no chat id.
      if (
        row.wakeupId !== null &&
        row.commentId ===
          commentIdFor(
            orgId,
            row.recordId,
            { _tag: "agent", agentId, askedBy: null },
            `${row.wakeupId}:${row.requestHash}`,
          )
      ) {
        if (!titles.has(row.wakeupId)) {
          const origin = yield* turnChat({ orgId, agentId, wakeupId: row.wakeupId });
          const [room] = yield* sql<{ title: string | null }>`SELECT title FROM kin_chats
            WHERE org_id = ${orgId} AND chat_id = ${origin?.chatId ?? null} LIMIT 1`;
          titles.set(row.wakeupId, room?.title ?? null);
        }
        chat = titles.get(row.wakeupId) ?? null;
      }
    }
    lines.push(entryLine(row, input, () => row.activity, undefined, chat));
  }
  return withRemainder(lines, rows, "Comments");
});

const numberChanges = Effect.fn("KinSessionChanges.numbers")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, to } = input;
  const rows = yield* sql<Entry & { value: string; total: number }>`
    SELECT r.key, r.title, l.name AS list, n.created_at AS at, n.value,
      CASE WHEN n.person_id IS NULL THEN 'agent' ELSE 'person' END AS "actorKind",
      COALESCE(n.person_id, n.agent_id) AS "actorId",
      COALESCE(p.display_name, n.recorder_name) AS person, ${sql.literal(accessSql("p"))} AS access,
      COALESCE(a.display_name, n.recorder_name) AS agent, ${sensitiveNow(sql)} AS sensitive,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)} AS coding,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)} AS outside,
      COUNT(*) OVER () AS total
    FROM kin_number_values n JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = n.org_id AND p.person_id = n.person_id
    LEFT JOIN kin_agents a ON a.org_id = n.org_id AND a.agent_id = n.agent_id
    WHERE n.org_id = ${orgId} AND n.created_at > ${from.at - CHANGE_TIME_MARGIN_MS} AND n.created_at <= ${to.at}
    ORDER BY n.created_at DESC, n.record_id DESC, n.as_of DESC, n.seq DESC LIMIT ${CHANGE_ROWS_LIMIT}`;
  return withRemainder(
    rows
      .toReversed()
      .map((row) => entryLine(row, input, () => `${cappedText(row.value, 160)} recorded`)),
    rows,
    "Numbers",
  );
});

const withRemainder = (
  lines: Line[],
  rows: ReadonlyArray<{ at: number; total: number }>,
  list: string,
) => {
  const row = rows[0];
  if (row !== undefined && row.total > rows.length)
    lines.unshift({ at: row.at, list, who: "various authors", count: row.total - rows.length });
  return lines;
};

const contactChanges = Effect.fn("KinSessionChanges.contacts")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, to } = input;
  const lower = from.at - CHANGE_TIME_MARGIN_MS;
  const rows = yield* sql<Entry & { activity: string; total: number }>`WITH activity AS (
      SELECT org_id, touch_id, party_id, created_at AS at, logged_by_kind AS actor_kind,
        logged_by_id AS actor_id, 'logged' AS activity FROM kin_client_touches
      WHERE org_id = ${orgId} AND created_at > ${lower} AND created_at <= ${to.at}
      UNION ALL
      SELECT org_id, touch_id, party_id, removed_at, NULL, NULL, 'removed'
      FROM kin_client_touches WHERE org_id = ${orgId}
        AND removed_at > ${lower} AND removed_at <= ${to.at}
    )
    SELECT r.key, r.title, l.name AS list, t.at, t.activity, t.actor_kind AS "actorKind",
      t.actor_id AS "actorId", ${speakerColumns(sql)}, ${sensitiveNow(sql)} AS sensitive,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)} AS coding,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)} AS outside,
      COUNT(*) OVER () AS total
    FROM activity t JOIN kin_records r ON r.org_id = t.org_id AND r.record_id = t.party_id
    JOIN kin_registers l ON l.org_id = r.org_id AND l.register_id = r.register_id
    LEFT JOIN kin_people p ON p.org_id = t.org_id AND t.actor_kind = 'person' AND p.person_id = t.actor_id
    LEFT JOIN kin_agents a ON a.org_id = t.org_id AND t.actor_kind = 'agent' AND a.agent_id = t.actor_id
    ORDER BY t.at DESC, t.touch_id DESC, t.activity DESC LIMIT ${CHANGE_ROWS_LIMIT}`;
  return withRemainder(
    rows.toReversed().map((row) => entryLine(row, input, () => contactWords(row.activity))),
    rows,
    "Clients",
  );
});

const importUndos = Effect.fn("KinSessionChanges.imports")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, to } = input;
  const rows = yield* sql<
    Speaker & { at: number; lists: string; appliedLists: string | null; total: number }
  >`
    SELECT u.finished_at AS at, u.lists_json AS lists, 'person' AS "actorKind",
      u.person_id AS "actorId", p.display_name AS person, ${sql.literal(accessSql("p"))} AS access,
      NULL AS agent,
      (SELECT i.lists_json FROM kin_import_runs i WHERE i.org_id = u.org_id
        AND i.batch = u.batch AND i.action = 'apply' AND i.seq < u.seq
        ORDER BY i.seq DESC LIMIT 1) AS "appliedLists",
      COUNT(*) OVER () AS total
    FROM kin_import_runs u LEFT JOIN kin_people p ON p.org_id = u.org_id AND p.person_id = u.person_id
    WHERE u.org_id = ${orgId} AND u.action = 'undo'
      AND u.finished_at > ${from.at - CHANGE_TIME_MARGIN_MS} AND u.finished_at <= ${to.at}
    ORDER BY u.finished_at DESC, u.seq DESC LIMIT ${CHANGE_ROWS_LIMIT}`;
  const decoded = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const undone = yield* decodeListIds(row.lists);
      const applied = yield* decodeListIds(row.appliedLists ?? "[]");
      return { ...row, ids: [...new Set([...undone, ...applied])] };
    }),
  );
  const names = new Map(Object.entries(PRESETS).map(([id, preset]) => [id, preset.name]));
  const keys = [...new Set(decoded.flatMap((row) => row.ids))];
  if (keys.length > 0) {
    const encodedKeys = yield* encodeJson(keys);
    const registers = yield* sql<{ id: string; name: string }>`
      SELECT register_id AS id, name FROM kin_registers
      WHERE org_id = ${orgId} AND register_id IN (SELECT value FROM json_each(${encodedKeys}))
      ORDER BY register_id LIMIT ${keys.length}`;
    for (const row of registers) names.set(row.id, row.name);
  }
  return withRemainder(
    decoded.toReversed().map((row): Line => {
      const who = whoOf(row, input.agentId);
      const list = cappedText(
        row.ids.map((id) => names.get(id) ?? id).join(", ") || "Work lists",
        120,
      );
      return {
        at: row.at,
        list,
        who,
        text: importUndoneWords(list, who, chatClock(row.at, input.now, input.zone)),
      };
    }),
    rows,
    "Imports",
  );
});

const memoryChanges = Effect.fn("KinSessionChanges.memory")(function* (input: Input) {
  const { orgId, agentId, from, to } = input;
  if (from.memoryHead === to.memoryHead || from.memoryHead === null || to.memoryHead === null)
    return [];
  const memory = yield* Memory;
  const own = new Set(input.sessionWakeupIds.map((id) => `kin(${agentId}): wake-up ${id}`));
  if (memory.changedItems === undefined)
    return yield* new SessionChangesSourceFailed({ source: "memory", cause: "No history reader" });
  const { items, overflow } = yield* memory.changedItems(orgId, from.memoryHead, to.memoryHead, {
    limit: SESSION_CHANGES_CAP + 1,
    excludeSubjects: own,
  });
  const sql = yield* SqlClient.SqlClient;
  const chats = new Map<string, string>();
  const lines: Line[] = [];
  let missing = 0;
  for (const { path, at, subject, coding, head } of items) {
    if (head === undefined) {
      missing++;
      continue;
    }
    const when = chatClock(at, input.now, input.zone);
    let who = /: owner /.test(subject) ? "the owner in Memory" : "Kin";
    const writer = /^kin\(([^)]+)\): wake-up (\S+)$/.exec(subject);
    if (writer?.[1] === agentId && writer[2] !== undefined) {
      const ownTurn = writer[2];
      if (!chats.has(ownTurn)) {
        const origin = yield* turnChat({ orgId, agentId, wakeupId: ownTurn });
        const [chat] = yield* sql<{ title: string | null }>`SELECT title FROM kin_chats
          WHERE org_id = ${orgId} AND chat_id = ${origin?.chatId ?? null} LIMIT 1`;
        chats.set(ownTurn, cappedText(chat?.title ?? "another chat", 120));
      }
      who = `you, in ${chats.get(ownTurn)}`;
    } else if (writer?.[1] !== undefined) {
      const [other] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_agents
        WHERE org_id = ${orgId} AND agent_id = ${writer[1]} LIMIT 1`;
      if (other !== undefined) who = `${cappedText(other.name, 120)} (agent)`;
    }
    const outside = coding || head.trust === "external";
    const text = outside
      ? outsideWords(`${head.id} (Memory)`, when, coding)
      : head.sensitive
        ? sensitiveWords(`${head.id} (Memory)`, when, who)
        : `memory ${encoded(head.title, true)} (${cappedText(path, 160)}): edited by ${who}, ${when}`;
    lines.push({
      at,
      text,
      who: outside ? "outside content" : who,
      list: "Memory",
      source: "memory",
    });
  }
  if (overflow + missing > 0)
    lines.push({ at: to.at, who: "", list: "Memory", source: "memory", count: overflow + missing });
  return lines;
});

const overflowKey = ({ source, list, who, via }: Line) => JSON.stringify([source, list, who, via]);

const chatChanges = Effect.fn("KinSessionChanges.chats")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, chatId, from, to } = input;
  const before = yield* encodeJson(from.chatVersions);
  const after = yield* encodeJson(to.chatVersions);
  const versions = sql`
    SELECT json_extract(next.value, '$.id') AS id,
      COALESCE(json_extract(prior.value, '$.seq'), 0) AS beforeSeq,
      COALESCE(json_extract(prior.value, '$.changeSeq'), 0) AS beforeChange,
      json_extract(next.value, '$.changeSeq') AS afterChange
    FROM json_each(${after}) next
    LEFT JOIN json_each(${before}) prior
      ON json_extract(prior.value, '$.id') = json_extract(next.value, '$.id')
  `;
  const messages = yield* sql<
    Speaker & { title: string | null; chatId: string; at: string; count: number }
  >`WITH versions AS (${versions})
    SELECT c.title, c.chat_id AS "chatId", m.author_kind AS "actorKind",
      COALESCE(m.author_person_id, m.author_agent_id) AS "actorId",
      ${speakerColumns(sql)}, MAX(m.created_at) AS at, COUNT(*) AS count
    FROM versions v JOIN kin_chats c ON c.org_id = ${orgId} AND c.chat_id = v.id
    JOIN kin_messages m USING (org_id, chat_id)
    LEFT JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
    LEFT JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.author_agent_id
    WHERE c.chat_id <> ${chatId} AND m.author_agent_id IS NOT ${agentId} AND m.status = 'posted'
      AND m.change_seq > v.beforeChange AND m.change_seq <= v.afterChange AND m.seq > v.beforeSeq
    GROUP BY c.chat_id, m.author_kind, "actorId" ORDER BY c.chat_id, MIN(m.seq)
    LIMIT ${CHANGE_ROWS_LIMIT}`;
  if (messages.length === CHANGE_ROWS_LIMIT)
    return yield* new SessionChangesSourceFailed({
      source: "chats",
      cause: "Too many chat authors",
    });
  const chats = new Map<string, { title: string; at: number; count: number; names: Set<string> }>();
  for (const row of messages) {
    const chat = chats.get(row.chatId) ?? {
      title: cappedText(row.title ?? "Direct chat", 120),
      at: 0,
      count: 0,
      names: new Set(),
    };
    chat.at = Math.max(chat.at, Date.parse(row.at));
    chat.count += row.count;
    chat.names.add(
      whoOf({ ...row, actorKind: row.actorKind === "human" ? "person" : row.actorKind }, agentId),
    );
    chats.set(row.chatId, chat);
  }
  const names = new Intl.ListFormat("en");
  const lines: Line[] = Array.from(chats.values(), ({ title, at, count, names: authors }) => ({
    at,
    list: "Chats",
    source: "chat",
    who: "",
    text: `${title}: ${count} new message${count === 1 ? "" : "s"} from ${names.format(authors)}`,
  }));
  const edited = yield* sql<{ title: string | null; at: string; count: number }>`
    WITH versions AS (${versions})
    SELECT c.title, MAX(COALESCE(json_extract(m.withdrawn_json, '$.at'), m.edited_at, m.created_at)) AS at,
      COUNT(*) AS count
    FROM versions v JOIN kin_chats c ON c.org_id = ${orgId} AND c.chat_id = v.id
    JOIN kin_messages m USING (org_id, chat_id)
    WHERE m.change_seq > v.beforeChange AND m.change_seq <= v.afterChange
      AND (m.edited_at IS NOT NULL OR m.withdrawn_json IS NOT NULL
        OR (m.seq <= v.beforeSeq AND m.message_id GLOB 'bills:*'))
    GROUP BY c.chat_id ORDER BY at DESC, c.chat_id LIMIT ${CHAT_CURSOR_LIMIT}`;
  for (const row of edited) {
    const title = cappedText(row.title ?? "Direct chat", 120);
    const at = Date.parse(row.at);
    lines.push({
      at: Number.isFinite(at) ? at : to.at,
      list: "Chats",
      source: "chat",
      who: "",
      text: editedChatWords(title, row.count),
    });
  }
  return lines;
});

const pulseChanges = Effect.fn("KinSessionChanges.pulse")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, from, to } = input;
  const lines: Line[] = [];
  const lower = from.at - CHANGE_TIME_MARGIN_MS;
  const pulse = yield* sql<
    Speaker & {
      at: number;
      seen: number;
      cleared: number;
      handled: number;
    }
  >`WITH facts AS (
    SELECT CASE WHEN f.first_seen_at > ${lower} AND f.first_seen_at <= ${to.at} THEN f.first_seen_at END AS seen,
      CASE WHEN f.cleared_at > ${lower} AND f.cleared_at <= ${to.at} THEN f.cleared_at END AS cleared,
      CASE WHEN f.handled_at > ${lower} AND f.handled_at <= ${to.at} THEN f.handled_at END AS handled,
      f.handled_by_kind, f.handled_by_id
    FROM kin_pulse_facts f WHERE f.org_id = ${orgId}
  ), grouped AS (
    SELECT MAX(MAX(COALESCE(seen, 0), COALESCE(cleared, 0), COALESCE(handled, 0))) AS at,
      COUNT(seen) AS seen, COUNT(cleared) AS cleared, COUNT(handled) AS handled,
      CASE WHEN handled IS NOT NULL THEN handled_by_kind END AS actor_kind,
      CASE WHEN handled IS NOT NULL THEN handled_by_id END AS actor_id
    FROM facts WHERE seen IS NOT NULL OR cleared IS NOT NULL OR handled IS NOT NULL
    GROUP BY actor_kind, actor_id
  )
  SELECT g.at, g.seen, g.cleared, g.handled, g.actor_kind AS "actorKind", g.actor_id AS "actorId",
    ${speakerColumns(sql)}
  FROM grouped g
  LEFT JOIN kin_people p ON p.org_id = ${orgId} AND g.actor_kind = 'person' AND p.person_id = g.actor_id
  LEFT JOIN kin_agents a ON a.org_id = ${orgId} AND g.actor_kind = 'agent' AND a.agent_id = g.actor_id
  ORDER BY g.actor_kind, g.actor_id LIMIT ${CHANGE_ROWS_LIMIT}`;
  if (pulse.length === CHANGE_ROWS_LIMIT)
    return yield* new SessionChangesSourceFailed({
      source: "pulse",
      cause: "Too many pulse handlers",
    });
  if (pulse.length === 0) return lines;
  const at = Math.max(...pulse.map((row) => row.at));
  const seen = pulse.reduce((count, row) => count + row.seen, 0);
  const cleared = pulse.reduce((count, row) => count + row.cleared, 0);
  const handlers = new Map<string, number>();
  for (const row of pulse) {
    if (row.handled === 0) continue;
    const who = whoOf(row, agentId);
    handlers.set(who, (handlers.get(who) ?? 0) + row.handled);
  }
  const parts = [
    ...(seen === 0 ? [] : [`${seen} new signal${seen === 1 ? "" : "s"}`]),
    ...(cleared === 0 ? [] : [`${cleared} cleared`]),
    ...Array.from(handlers, ([who, count]) => `${count} handled by ${who}`),
  ];
  return [
    { at, list: "Pulse", source: "pulse" as const, who: "", text: `Pulse: ${parts.join(", ")}` },
  ];
});

export const sessionChanges = Effect.fn("KinSessionChanges.since")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const [owner] = yield* source(
    "owner chat",
    sql`SELECT 1 FROM kin_leads
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND owner_chat_id = ${input.chatId}
    LIMIT 1`,
  );
  if (owner === undefined) return yield* new SessionChangesNotOwnerChat({});
  const lines = [
    ...(yield* source("records", recordChanges(input))),
    ...(yield* source("comments", commentChanges(input))),
    ...(yield* source("numbers", numberChanges(input))),
    ...(yield* source("imports", importUndos(input))),
    ...(yield* source("contacts", contactChanges(input))),
    ...(yield* source("memory", memoryChanges(input))),
    ...(yield* source("chats", chatChanges(input))),
    ...(yield* source("pulse", pulseChanges(input))),
  ].sort((a, b) => a.at - b.at);
  const shown = lines.filter((line) => line.text !== undefined).slice(-SESSION_CHANGES_CAP);
  const kept = new Set(shown);
  const overflow = new Map<string, OverflowGroup>();
  for (const line of lines) {
    if (kept.has(line)) continue;
    const { list, who, via, source } = line;
    const key = overflowKey(line);
    overflow.set(key, {
      list,
      who: via === "import" ? `${who} (import, ${chatClock(line.at, input.now, input.zone)})` : who,
      count: (overflow.get(key)?.count ?? 0) + (line.count ?? 1),
      ...(via === undefined ? {} : { via }),
      ...(source === undefined ? {} : { source }),
    });
  }
  return {
    lines: shown.flatMap((line) => line.text ?? []),
    overflow: [...overflow.values()],
    shown: shown.length,
    total: lines.reduce((count, line) => count + (line.count ?? 1), 0),
  };
});
