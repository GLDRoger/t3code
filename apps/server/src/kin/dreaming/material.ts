import { KinEvent, type KinOrgId, type MemoryTrust } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { itemFolders } from "../memory/checkoutPaths.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";
import { SHARED_THREAD_PREFIX } from "../lead/Audience.ts";

/** One original the dream may cite. `saidBy` and `trust` come from server records, never the model. */
export interface MaterialEntry {
  readonly ref: string;
  readonly kind: "journal" | "chat" | "github" | "worker_report" | "item";
  readonly saidBy: string;
  readonly trust: MemoryTrust;
  readonly at: string;
  readonly text: string;
}

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));

/** No person but the owner was ever in the chat: anyone who was can have read or steered it. */
const ownerOnlyChat = (sql: SqlClient.SqlClient, chatId: Statement.Fragment) =>
  sql`NOT EXISTS (SELECT 1 FROM kin_chat_members cm WHERE cm.chat_id = ${chatId}
    AND cm.principal_kind = 'person' AND cm.role <> 'owner')`;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ownerDate = (ms: number, timeZone: string) =>
  DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone }));

const journalDate = (path: string) => {
  const match = /^journal\/(\d{4})\/(\d{2})-(\d{2})\.md$/.exec(path);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
};

// `## HH:MM · wake-up <id> · <agentId> · <level>`, as memory/journal.ts writes each entry.
const ENTRY_HEADING = /^## \d{2}:\d{2} · wake-up (.+) · (.+) · L[0-3]$/;

/** A journal file's entries, each with the wake-up and lead its heading names. */
const journalEntries = (text: string) => {
  const entries: Array<{
    wakeupId?: string | undefined;
    agentId?: string | undefined;
    text: string;
  }> = [];
  for (const line of text.split("\n")) {
    const heading = ENTRY_HEADING.exec(line);
    if (heading !== null) entries.push({ wakeupId: heading[1], agentId: heading[2], text: "" });
    else if (entries.length === 0) entries.push({ text: "" });
    const entry = entries[entries.length - 1]!;
    entry.text += `${line}\n`;
  }
  return entries.filter((entry) => entry.text.trim() !== "");
};

/**
 * Originals in `(from, until]`: journal files, chat messages, worker reports and GitHub events.
 * Briefs, summaries and earlier dream output are never material. `full` adds every item.
 */
export const collectMaterial = Effect.fn("DreamMaterial.collect")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly from: number;
    readonly until: number;
    readonly full: boolean;
    readonly timeZone: string;
    readonly files: ReadonlyMap<string, string>;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const { orgId, from, until } = input;
    const entries: Array<MaterialEntry> = [];
    // A dream may edit journal files, so a heading names a lead only if it is one of this org's.
    const leads = new Set(
      (yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_leads
        WHERE org_id = ${orgId} ORDER BY agent_id`).map((row) => row.agentId),
    );
    // A turn someone besides the owner could read left no journal entry; older ones are skipped.
    const sharedWakeups = new Set(
      (yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
        WHERE org_id = ${orgId} AND (audience IS NOT 'owner_only' OR shared_since IS NOT NULL)
        ORDER BY wakeup_id`).map((row) => row.wakeupId),
    );
    const firstDay = from === 0 ? "" : ownerDate(from, input.timeZone);
    const lastDay = ownerDate(until, input.timeZone);
    for (const [path, text] of [...input.files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      const day = journalDate(path);
      if (day === undefined || day < firstDay || day > lastDay) continue;
      const parts = journalEntries(text);
      for (const [index, part] of parts.entries()) {
        if (part.wakeupId !== undefined && sharedWakeups.has(part.wakeupId)) continue;
        entries.push({
          ref:
            parts.length === 1
              ? `memory:${path}`
              : `memory:${path}#${part.wakeupId ?? `part-${index + 1}`}`,
          kind: "journal",
          saidBy: part.agentId !== undefined && leads.has(part.agentId) ? part.agentId : "kin",
          trust: "agent",
          at: `${day}T00:00:00.000Z`,
          text: parts.length === 1 ? text : part.text,
        });
      }
    }
    const messages = yield* sql<{
      chatId: string;
      messageId: string;
      authorKind: "human" | "agent";
      role: "owner" | "member" | "guest";
      handle: string | null;
      agentId: string | null;
      body: string;
      createdAt: string;
    }>`SELECT m.chat_id AS "chatId", m.message_id AS "messageId", m.author_kind AS "authorKind",
        m.author_role AS role, p.handle, m.author_agent_id AS "agentId", m.body, m.created_at AS "createdAt"
      FROM kin_messages m
      LEFT JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
      WHERE m.org_id = ${orgId} AND m.status = 'posted' AND m.kind = 'text'
        AND m.author_kind IN ('human', 'agent')
        AND CAST(unixepoch(m.created_at, 'subsec') * 1000 AS INTEGER) > ${from}
        AND CAST(unixepoch(m.created_at, 'subsec') * 1000 AS INTEGER) <= ${until}
        AND ${ownerOnlyChat(sql, sql`m.chat_id`)}
        AND (m.author_kind = 'human' OR (m.author_thread_id NOT LIKE ${`${SHARED_THREAD_PREFIX}%`}
          AND NOT EXISTS (SELECT 1 FROM kin_wakeups w
            WHERE w.org_id = m.org_id AND w.thread_id = m.author_thread_id
              AND (w.audience IS NOT 'owner_only' OR w.shared_since IS NOT NULL)
              AND CAST(unixepoch(m.created_at, 'subsec') * 1000 AS INTEGER)
                BETWEEN w.started_at AND COALESCE(w.ended_at, ${until}))))
      ORDER BY m.created_at, m.chat_id, m.seq`;
    for (const message of messages) {
      const human = message.authorKind === "human";
      entries.push({
        ref: `kin:chat:${message.chatId}:message:${message.messageId}`,
        kind: "chat",
        saidBy: human ? (message.handle ?? "external") : (message.agentId ?? "external"),
        trust: !human
          ? "agent"
          : message.role === "owner"
            ? "owner"
            : message.role === "member"
              ? "member"
              : "external",
        at: message.createdAt,
        text: message.body,
      });
    }
    const events = yield* sql<{
      json: string;
    }>`SELECT e.json FROM kin_events e WHERE e.org_id = ${orgId} AND e.tag IN ('github', 'worker.report')
      AND e.received_at > ${from} AND e.received_at <= ${until}
      AND (e.tag = 'github' OR NOT EXISTS (SELECT 1 FROM kin_workers k
        WHERE k.org_id = e.org_id AND k.worker_id = json_extract(e.json, '$.workerId')
          AND k.chat_id IS NOT NULL AND NOT ${ownerOnlyChat(sql, sql`k.chat_id`)}))
      ORDER BY e.received_at, e.event_id`;
    for (const row of events) {
      const event = yield* decodeEvent(row.json);
      if (event._tag !== "github" && event._tag !== "worker.report") continue;
      const who = event.provenance;
      entries.push({
        ref: `kin:event:${event.eventId}`,
        kind: event._tag === "github" ? "github" : "worker_report",
        saidBy: who._tag === "agent" ? who.agentId : "external",
        trust: who._tag === "agent" ? "agent" : "external",
        at: DateTime.formatIso(event.receivedAt),
        text:
          event._tag === "github"
            ? `${event.eventName} ${event.repo}: ${event.summary}`
            : yield* encodeJson(event.report),
      });
    }
    if (input.full)
      for (const [path, text] of [...input.files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
        if (!itemFolders.some((folder) => path.startsWith(`${folder}/`))) continue;
        const parsed = yield* parseFrontMatter(orgId, path, text).pipe(Effect.option);
        if (parsed._tag === "None") continue;
        entries.push({
          ref: `memory:${path}`,
          kind: "item",
          saidBy: parsed.value.frontMatter.said_by,
          trust: parsed.value.frontMatter.trust,
          at: parsed.value.frontMatter.recorded_at,
          text,
        });
      }
    return { from: from === 0 ? null : iso(from), until: iso(until), entries };
  },
  Effect.mapError((cause) =>
    isSqlError(cause) ? toPersistenceSqlError("DreamMaterial.collect")(cause) : cause,
  ),
);

export type DreamMaterial = Effect.Success<ReturnType<typeof collectMaterial>>;
