import type { KinAgentId, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { folders, Memory } from "../memory/Memory.ts";
import { memoryGit } from "../memory/git.ts";
import { accessSql } from "../people/KinAccess.ts";
import { parseChanges, sensitiveNow } from "../work/recordRows.ts";
import { chatClock, SESSION_CHANGES_CAP } from "./LeadPrompt.ts";
import { cappedText, encoded } from "./quote.ts";

export interface Cursor {
  readonly changeSeq: number;
  readonly at: number;
  readonly memoryHead: string | null;
  readonly chatSeq: number;
}

export interface OverflowGroup {
  readonly list: string;
  readonly who: string;
  readonly count: number;
  readonly via?: "import";
  readonly source?: "memory" | "chat" | "pulse";
}

export const readCursor = Effect.fn("KinSessionChanges.cursor")(function* (
  orgId: KinOrgId,
  chatId: string | null,
  memoryHead: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  const [row] = yield* sql<{ changeSeq: number; chatSeq: number }>`SELECT
    COALESCE((SELECT MAX(seq) FROM kin_record_changes WHERE org_id = ${orgId}), 0) AS "changeSeq",
    COALESCE((SELECT last_seq FROM kin_chats WHERE org_id = ${orgId} AND chat_id = ${chatId}), 0) AS "chatSeq"`;
  return {
    changeSeq: row?.changeSeq ?? 0,
    at,
    memoryHead,
    chatSeq: row?.chatSeq ?? 0,
  } satisfies Cursor;
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
  readonly workChangedKeys?: ReadonlySet<string>;
}

interface Line {
  readonly at: number;
  readonly list: string;
  readonly who: string;
  readonly via?: "import";
  readonly source?: OverflowGroup["source"];
  readonly text?: string | undefined;
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
  const rows = yield* sql<RecordChange>`WITH changes AS (
      SELECT c.org_id, c.record_id, c.seq, c.at, c.kind, c.fields_json, c.via, c.chat_id,
        c.actor_kind, c.actor_id, c.coding_agent_key,
        ROW_NUMBER() OVER (PARTITION BY c.record_id ORDER BY c.seq DESC) AS rank
      FROM kin_record_changes c
      WHERE c.org_id = ${orgId} AND c.seq > ${from.changeSeq} AND c.seq <= ${to.changeSeq}
        AND NOT ${own}
    )
    SELECT r.key, r.title, l.name AS list, c.at, c.rank, c.kind, c.fields_json AS fields, c.via,
      h.title AS chat, c.actor_kind AS "actorKind", c.actor_id AS "actorId", ${speakerColumns(sql)},
      ${sensitiveNow(sql)} AS sensitive,
      (c.coding_agent_key IS NOT NULL OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)}) AS coding,
      (c.coding_agent_key IS NOT NULL OR c.via = 'github' OR o.event_id IS NOT NULL
        OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)}) AS outside
    FROM changes c JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = c.org_id AND c.actor_kind = 'person' AND p.person_id = c.actor_id
    LEFT JOIN kin_agents a ON a.org_id = c.org_id AND c.actor_kind = 'agent' AND a.agent_id = c.actor_id
    LEFT JOIN kin_chats h ON h.org_id = c.org_id AND h.chat_id = c.chat_id
    LEFT JOIN kin_event_outside o ON o.org_id = c.org_id
      AND o.event_id = 'record-change:' || c.record_id || ':' || c.seq
    ORDER BY c.seq`;
  return rows
    .filter((row) => !input.workChangedKeys?.has(row.key))
    .map((row) => {
      const line = entryLine(row, input, () => recordWords(row), row.via, row.chat);
      return row.rank <= 4 ? line : { ...line, text: undefined };
    });
});

const commentChanges = Effect.fn("KinSessionChanges.comments")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, from, to } = input;
  const rows = yield* sql<Entry & { activity: string }>`WITH activity AS (
      SELECT org_id, comment_id, record_id, created_at AS at, author_kind, author_id, coding_agent_key,
        'comment added' AS activity FROM kin_record_comments WHERE org_id = ${orgId}
        AND created_at > ${from.at} AND created_at <= ${to.at}
      UNION ALL
      SELECT org_id, comment_id, record_id, removed_at, removed_by_kind, removed_by_id, coding_agent_key,
        'comment removed' FROM kin_record_comments WHERE org_id = ${orgId}
        AND removed_at > ${from.at} AND removed_at <= ${to.at}
    )
    SELECT r.key, r.title, l.name AS list, c.at, c.activity, c.author_kind AS "actorKind",
      c.author_id AS "actorId", ${speakerColumns(sql)}, ${sensitiveNow(sql)} AS sensitive,
      (c.coding_agent_key IS NOT NULL OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)}) AS coding,
      (c.coding_agent_key IS NOT NULL
        OR ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)}) AS outside
    FROM activity c JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = c.org_id AND c.author_kind = 'person' AND p.person_id = c.author_id
    LEFT JOIN kin_agents a ON a.org_id = c.org_id AND c.author_kind = 'agent' AND a.agent_id = c.author_id
    WHERE NOT (c.author_kind IS 'agent' AND c.author_id IS ${agentId})
    ORDER BY c.at, c.comment_id, c.activity`;
  return rows.map((row) => entryLine(row, input, () => row.activity));
});

const numberChanges = Effect.fn("KinSessionChanges.numbers")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, to } = input;
  const rows = yield* sql<Entry & { value: string }>`
    SELECT r.key, r.title, l.name AS list, n.created_at AS at, n.value,
      CASE WHEN n.person_id IS NULL THEN 'agent' ELSE 'person' END AS "actorKind",
      COALESCE(n.person_id, n.agent_id) AS "actorId",
      COALESCE(p.display_name, n.recorder_name) AS person, ${sql.literal(accessSql("p"))} AS access,
      COALESCE(a.display_name, n.recorder_name) AS agent, ${sensitiveNow(sql)} AS sensitive,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL`)} AS coding,
      ${titleSource(sql, sql`tc.coding_agent_key IS NOT NULL OR tc.via = 'github' OR os.event_id IS NOT NULL`)} AS outside
    FROM kin_number_values n JOIN kin_records r USING (org_id, record_id)
    JOIN kin_registers l USING (org_id, register_id)
    LEFT JOIN kin_people p ON p.org_id = n.org_id AND p.person_id = n.person_id
    LEFT JOIN kin_agents a ON a.org_id = n.org_id AND a.agent_id = n.agent_id
    WHERE n.org_id = ${orgId} AND n.created_at > ${from.at} AND n.created_at <= ${to.at}
    ORDER BY n.created_at, n.record_id, n.as_of, n.seq`;
  return rows.map((row) => entryLine(row, input, () => `${cappedText(row.value, 160)} recorded`));
});

const memoryChanges = Effect.fn("KinSessionChanges.memory")(function* (input: Input) {
  const { orgId, agentId, from, to } = input;
  if (from.memoryHead === to.memoryHead || from.memoryHead === null || to.memoryHead === null)
    return [];
  const memory = yield* Memory;
  const { writer } = yield* memory.ensureCheckouts(orgId);
  const diff = yield* memoryGit(writer, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--diff-filter=M",
    from.memoryHead,
    to.memoryHead,
    "--",
    ...folders,
  ]);
  const paths = diff.split("\0").filter((part, i) => i % 2 === 1 && part.endsWith(".md"));
  if (paths.length === 0) return [];
  const { items } = yield* memory.readPromptSnapshot(orgId, to.memoryHead, { lead: agentId });
  const heads = new Map(items.map((head) => [head.path, head]));
  const own = new Set(input.sessionWakeupIds.map((id) => `kin(${agentId}): wake-up ${id}`));
  const lines: Line[] = [];
  for (const path of paths) {
    const log = yield* memoryGit(writer, [
      "log",
      "-z",
      "--format=%ct%x00%s%x00%B",
      `${from.memoryHead}..${to.memoryHead}`,
      "--",
      path,
    ]);
    const parts = log.split("\0");
    const commits = [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const at = Number(parts[i]) * 1_000;
      const subject = parts[i + 1] ?? "";
      if (Number.isFinite(at) && !own.has(subject))
        commits.push({
          at,
          subject,
          coding:
            /^Kin-Coding-Agent-For:/m.test(parts[i + 2] ?? "") ||
            subject.includes("(coding agent)"),
        });
    }
    const latest = commits[0];
    if (latest === undefined && log !== "") continue;
    const at = latest?.at ?? to.at;
    const when = chatClock(at, input.now, input.zone);
    const head = heads.get(path);
    const id = head?.id ?? path.split("/").at(-1)?.replace(/\.md$/, "") ?? "memory item";
    const coding = commits.some((commit) => commit.coding);
    const who = latest?.subject.includes(": owner ") === true ? "the owner in Memory" : "Kin";
    const text =
      coding || head?.trust === "external"
        ? outsideWords(`${id} (Memory)`, when, coding)
        : head?.sensitive === true
          ? sensitiveWords(`${id} (Memory)`, when, who)
          : `memory ${encoded(head?.title ?? id, true)} (${cappedText(path, 160)}): edited by ${who}, ${when}`;
    lines.push({
      at,
      text,
      who: coding ? "outside content" : who,
      list: "Memory",
      source: "memory",
    });
  }
  return lines;
});

const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const overflowKey = ({ source, list, who, via }: Line) => JSON.stringify([source, list, who, via]);

const chatAndPulse = Effect.fn("KinSessionChanges.chatAndPulse")(function* (input: Input) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, agentId, chatId, from, to } = input;
  const messages = yield* sql<
    Speaker & { title: string | null; chatId: string; at: string; count: number }
  >`
    SELECT c.title, c.chat_id AS "chatId", m.author_kind AS "actorKind",
      COALESCE(m.author_person_id, m.author_agent_id) AS "actorId",
      ${speakerColumns(sql)}, MAX(m.created_at) AS at, COUNT(*) AS count
    FROM kin_chat_members member JOIN kin_chats c USING (org_id, chat_id)
    JOIN kin_messages m USING (org_id, chat_id)
    LEFT JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
    LEFT JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.author_agent_id
    WHERE member.org_id = ${orgId} AND member.agent_id = ${agentId} AND member.left_at IS NULL
      AND member.chat_id <> ${chatId} AND m.author_agent_id IS NOT ${agentId} AND m.status = 'posted'
      AND m.created_at > ${iso(from.at)} AND m.created_at <= ${iso(to.at)}
    GROUP BY c.chat_id, m.author_kind, "actorId" ORDER BY c.chat_id, MIN(m.seq)`;
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
  const pulse = yield* sql<
    Speaker & { seen: number | null; cleared: number | null; handled: number | null }
  >`
    SELECT CASE WHEN f.first_seen_at > ${from.at} AND f.first_seen_at <= ${to.at} THEN f.first_seen_at END AS seen,
      CASE WHEN f.cleared_at > ${from.at} AND f.cleared_at <= ${to.at} THEN f.cleared_at END AS cleared,
      CASE WHEN f.handled_at > ${from.at} AND f.handled_at <= ${to.at} THEN f.handled_at END AS handled,
      f.handled_by_kind AS "actorKind", f.handled_by_id AS "actorId", ${speakerColumns(sql)}
    FROM kin_pulse_facts f
    LEFT JOIN kin_people p ON p.org_id = f.org_id AND f.handled_by_kind = 'person' AND p.person_id = f.handled_by_id
    LEFT JOIN kin_agents a ON a.org_id = f.org_id AND f.handled_by_kind = 'agent' AND a.agent_id = f.handled_by_id
    WHERE f.org_id = ${orgId} AND (seen IS NOT NULL OR cleared IS NOT NULL OR handled IS NOT NULL)
    ORDER BY f.fact_key`;
  if (pulse.length > 0) {
    let at = 0,
      seen = 0,
      cleared = 0;
    const handlers = new Map<string, number>();
    for (const row of pulse) {
      at = Math.max(at, row.seen ?? 0, row.cleared ?? 0, row.handled ?? 0);
      seen += Number(row.seen !== null);
      cleared += Number(row.cleared !== null);
      if (row.handled !== null) {
        const who = whoOf(row, agentId);
        handlers.set(who, (handlers.get(who) ?? 0) + 1);
      }
    }
    const parts = [
      ...(seen === 0 ? [] : [`${seen} new signal${seen === 1 ? "" : "s"}`]),
      ...(cleared === 0 ? [] : [`${cleared} cleared`]),
      ...Array.from(handlers, ([who, count]) => `${count} handled by ${who}`),
    ];
    lines.push({ at, list: "Pulse", source: "pulse", who: "", text: `Pulse: ${parts.join(", ")}` });
  }
  return lines;
});

export const sessionChanges = Effect.fn("KinSessionChanges.since")(function* (input: Input) {
  const lines = [
    ...(yield* recordChanges(input)),
    ...(yield* commentChanges(input)),
    ...(yield* numberChanges(input)),
    ...(yield* memoryChanges(input)),
    ...(yield* chatAndPulse(input)),
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
      count: (overflow.get(key)?.count ?? 0) + 1,
      ...(via === undefined ? {} : { via }),
      ...(source === undefined ? {} : { source }),
    });
  }
  return {
    lines: shown.flatMap((line) => line.text ?? []),
    overflow: [...overflow.values()],
    shown: shown.length,
    total: lines.length,
  };
});
