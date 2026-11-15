import { KinAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { heldWork } from "../../lead/KinBudget.ts";
import { sensitiveNow } from "../../work/recordRows.ts";
import { DAY_MS } from "../thresholds.ts";
import { agentOrOwner, iso, type SenseContext, type SensedFact } from "./shared.ts";
import { SENSE_CAP } from "./work.ts";

export const systemSenses = Effect.fn("KinPulse.systemSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];

  // worker_failed: a worker failed or came back blocked in the last day, and its entry is open.
  const workers = yield* sql<{
    workerId: string;
    agentId: string;
    title: string | null;
    kind: string;
    endedAt: number;
    blocked: number;
    entryKey: string;
    entryTitle: string;
    sensitive: number;
  }>`SELECT w.worker_id AS "workerId", w.agent_id AS "agentId", w.title, w.kind,
      w.ended_at AS "endedAt", w.status <> 'failed' AS blocked,
      r.key AS "entryKey", r.title AS "entryTitle", ${sensitiveNow(sql)} AS sensitive
    FROM kin_workers w
    JOIN kin_record_links l ON l.org_id = w.org_id AND l.kind = 'worker' AND l.target = w.worker_id
    JOIN kin_records r ON r.org_id = l.org_id AND r.record_id = l.record_id
    WHERE w.org_id = ${orgId} AND w.ended_at IS NOT NULL
      AND w.ended_at > ${at - DAY_MS} AND w.ended_at <= ${at}
      AND (w.status = 'failed' OR json_extract(w.report_json, '$.result') = 'blocked')
      AND r.state IN ('open', 'doing', 'waiting')
    ORDER BY w.ended_at, w.worker_id, r.key LIMIT ${SENSE_CAP}`;
  const seen = new Set<string>();
  for (const row of workers) {
    if (seen.has(row.workerId)) continue;
    seen.add(row.workerId);
    facts.push({
      sense: "worker_failed",
      family: "system",
      key: `worker_failed:${row.workerId}:ended=${row.endedAt}`,
      subject: { kind: "worker", key: row.workerId, title: row.title ?? row.kind },
      scope: {},
      since: iso(row.endedAt),
      consequence: `The worker on ${row.entryKey} (${row.entryTitle}) ${row.blocked === 1 ? "came back blocked" : "failed"}, and ${row.entryKey} is still open.`,
      actor: ctx.liveAgents.has(row.agentId)
        ? { _tag: "agent", agentId: KinAgentId.make(row.agentId) }
        : agentOrOwner(ctx.chief),
      sensitive: row.sensitive === 1,
      wake: "now",
    });
  }

  // work_held: events waiting on the owner's daily limit.
  const held = yield* heldWork(orgId);
  for (const agent of held.agents) {
    const total = agent.requests + agent.tasks + agent.other;
    facts.push({
      sense: "work_held",
      family: "system",
      key: `work_held:${agent.agentId}`,
      subject: { kind: "agent", key: agent.agentId, title: agent.name },
      scope: {},
      since: iso(at),
      measure: { value: total, unit: "count", threshold: 1, from: "default" },
      consequence: `${total} ${total === 1 ? "piece" : "pieces"} of ${agent.name}'s work wait on the daily limit${held.until === null ? "" : ` until ${held.until}`}.`,
      actor: { _tag: "owner" },
      sensitive: true,
      wake: "brief",
    });
  }
  return facts;
});
