import {
  KinAgentId,
  type KinChatId,
  type KinOrgId,
  type KinWorkerId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ENGINEERING_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { KinRecords, type Writer } from "./KinRecords.ts";
import { endOfDay, ownerZone } from "./recordRows.ts";

/**
 * Brings what leads already tracked into Work: every running worker, and the open commitments and
 * objectives in memory. Each becomes an entry keyed by where it came from (`worker:`, `memory:`),
 * so running it again, at every start, adds only what is new and never overwrites an entry.
 * Memory is read, never written: the index stops listing those two kinds instead (`buildIndex`).
 */

const writer: Writer = { actor: { _tag: "system" }, via: "import" };
const IMPORTED = new Set(["commitment", "objective"]);

const dueOf = (due: string | null, zone: string) => {
  if (due === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return { dueAt: endOfDay(due, zone), dueAllDay: true };
  const ms = Date.parse(due);
  return Number.isFinite(ms) ? { dueAt: ms, dueAllDay: false } : null;
};

/** Which lead owns an imported item: the one whose owner chat it came from, else the org's first. */
const ownerFor = Effect.fn("KinWorkImport.ownerFor")(function* (
  orgId: KinOrgId,
  chatId: KinChatId | undefined,
  fallback: KinAgentId | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  if (chatId !== undefined) {
    const [lead] = yield* sql<{ agentId: string }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND l.owner_chat_id = ${chatId} AND a.retired_at IS NULL
      ORDER BY l.agent_id LIMIT 1`;
    if (lead !== undefined) return KinAgentId.make(lead.agentId);
  }
  return fallback;
});

export const importWork = Effect.fn("KinWorkImport.run")(function* (
  orgId: KinOrgId,
  items: ReadonlyArray<MemoryItemHead>,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  let workers = 0;
  let memory = 0;
  const running = yield* sql<{
    workerId: KinWorkerId;
    agentId: KinAgentId;
    title: string | null;
    chatId: KinChatId | null;
  }>`SELECT k.worker_id AS "workerId", k.agent_id AS "agentId", k.title, k.chat_id AS "chatId"
    FROM kin_workers k WHERE k.org_id = ${orgId} AND k.ended_at IS NULL AND k.review_of IS NULL
      AND NOT EXISTS (SELECT 1 FROM kin_record_links l WHERE l.org_id = k.org_id
        AND l.kind = 'worker' AND l.target = k.worker_id)
    ORDER BY k.started_at, k.worker_id`;
  for (const worker of running) {
    const { created } = yield* records.create(orgId, writer, {
      originKey: `worker:${worker.workerId}`,
      title: worker.title?.trim().slice(0, 280) || "Coding task",
      state: "doing",
      owner: { _tag: "agent", agentId: worker.agentId },
      category: "task",
      links: [
        {
          kind: "worker",
          target: worker.workerId,
          relation: "attempt",
          label: worker.title?.slice(0, 280) ?? null,
        },
      ],
    });
    if (created) workers++;
  }
  const open = items.filter(
    (item) =>
      IMPORTED.has(item.kind) &&
      item.status === "open" &&
      item.invalid_at === null &&
      item.superseded_by === null &&
      item.title.trim() !== "",
  );
  if (open.length > 0) {
    const zone = yield* ownerZone(orgId);
    const first = yield* liveLead(sql, orgId, { prefer: ENGINEERING_DOMAIN });
    for (const item of open) {
      const owner = yield* ownerFor(orgId, item.chat, first?.agentId);
      if (owner === undefined) continue;
      const { created } = yield* records.create(orgId, writer, {
        originKey: `memory:${item.id}`,
        title: item.title.trim().slice(0, 280),
        owner: { _tag: "agent", agentId: owner },
        category: item.kind === "commitment" ? "obligation" : "task",
        ...dueOf(item.due, zone),
        notes: (item.what ?? "").slice(0, 4_000),
        // Unlabelled memory reads as sensitive, and stays so in Work.
        sensitive: item.sensitive !== false,
        links: [{ kind: "memory", target: item.id, relation: "source", label: item.path }],
      });
      if (created) memory++;
    }
  }
  return { workers, memory };
});
