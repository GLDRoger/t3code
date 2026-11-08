import { KinEvent, type KinOrgId, type MemoryTrust } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { parseFrontMatter } from "../memory/frontMatter.ts";

export const itemFolders = [
  "objectives",
  "commitments",
  "deferrals",
  "decisions",
  "people",
  "claims",
] as const;

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
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const ownerDate = (ms: number, timeZone: string) =>
  DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone }));

const journalDate = (path: string) => {
  const match = /^journal\/(\d{4})\/(\d{2})-(\d{2})\.md$/.exec(path);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
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
    const [lead] = yield* sql<{
      agentId: string;
    }>`SELECT agent_id AS "agentId" FROM kin_leads WHERE org_id = ${orgId} ORDER BY agent_id LIMIT 1`;
    const firstDay = from === 0 ? "" : ownerDate(from, input.timeZone);
    const lastDay = ownerDate(until, input.timeZone);
    for (const [path, text] of [...input.files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      const day = journalDate(path);
      if (day === undefined || day < firstDay || day > lastDay) continue;
      entries.push({
        ref: `memory:${path}`,
        kind: "journal",
        saidBy: lead?.agentId ?? "kin",
        trust: "agent",
        at: `${day}T00:00:00.000Z`,
        text,
      });
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
    }>`SELECT json FROM kin_events WHERE org_id = ${orgId} AND tag IN ('github', 'worker.report')
      AND received_at > ${from} AND received_at <= ${until} ORDER BY received_at, event_id`;
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
