import { KinAgentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { cappedRows } from "./capped.ts";

import {
  liveConnections,
  MAIL_QUIET_MS,
  mailStopOf,
  type MailStop,
  quietFrom,
  toolsOf,
} from "../../connections/ConnectionRows.ts";
import { heldWork } from "../../lead/KinBudget.ts";
import { DAY_MS } from "../thresholds.ts";
import { agentOrOwner, iso, whenOf, type SenseContext, type SensedFact } from "./shared.ts";

export const systemSenses = Effect.fn("KinPulse.systemSenses")(function* (ctx: SenseContext) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const facts: Array<SensedFact> = [];

  // task_stuck: a task an agent started waits on a decision or is blocked, or failed today.
  const tasks = yield* cappedRows<{
    widgetId: string;
    agentId: string | null;
    threadId: string;
    title: string;
    status: "needs_decision" | "blocked" | "failed";
    updatedAt: string;
  }>(
    ctx,
    facts,
    {
      sense: "task_stuck",
      plural: "tasks waiting on a decision, blocked or recently failed",
      access: "system",
    },
    sql`SELECT w.widget_id AS "widgetId", m.author_agent_id AS "agentId",
      json_extract(w.state_json, '$.threadId') AS "threadId",
      json_extract(w.state_json, '$.title') AS title,
      json_extract(w.state_json, '$.status') AS status, w.updated_at AS "updatedAt"
    FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    WHERE w.org_id = ${orgId} AND w.type = 'task' AND w.closed_at IS NULL
      AND w.updated_at <= ${DateTime.formatIso(iso(at))}
      AND (json_extract(w.state_json, '$.status') IN ('needs_decision', 'blocked')
        OR (json_extract(w.state_json, '$.status') = 'failed' AND w.updated_at > ${DateTime.formatIso(iso(at - DAY_MS))}))
    ORDER BY w.updated_at, w.widget_id`,
  );
  for (const row of tasks)
    facts.push({
      sense: "task_stuck",
      family: "system",
      key: `task_stuck:${row.threadId}:${row.status}`,
      subject: { kind: "task", key: row.threadId, title: row.title.slice(0, 280) },
      scope: {},
      since: DateTime.makeUnsafe(row.updatedAt),
      consequence: `The task "${row.title}" ${
        row.status === "needs_decision"
          ? "waits on a decision"
          : row.status === "blocked"
            ? "is blocked"
            : "failed"
      }, and nothing moves it on until someone looks.`,
      actor:
        row.agentId !== null && ctx.liveAgents.has(row.agentId)
          ? { _tag: "agent", agentId: KinAgentId.make(row.agentId) }
          : agentOrOwner(ctx.chief),
      // Task titles come from the owner's own requests.
      sensitive: true,
      wake: "now",
    });

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
      measure: { value: total, unit: "count", threshold: 1, from: { _tag: "default" } },
      consequence: `${total} ${total === 1 ? "piece" : "pieces"} of ${agent.name}'s work wait on the daily limit${held.until === null ? "" : ` until ${held.until}`}.`,
      actor: { _tag: "owner" },
      sensitive: true,
      wake: "brief",
    });
  }
  facts.push(...(yield* mailSenses(ctx)));
  return facts;
});

/**
 * mail_not_syncing: a mail account Kin reads has stopped giving it new mail. One fact per
 * account, gone once a read works again; a pause or a removal is the owner's choice and says
 * nothing.
 */
const mailSenses = Effect.fn("KinPulse.mailSenses")(function* (ctx: SenseContext) {
  const facts: Array<SensedFact> = [];
  for (const row of yield* liveConnections(ctx.orgId)) {
    const stop = mailStopOf(row, yield* toolsOf(ctx.orgId, row.connectionId), ctx.at);
    if (stop === null || stop === undefined) continue;
    const from = quietFrom(row);
    facts.push({
      sense: "mail_not_syncing",
      family: "system",
      key: `mail_not_syncing:${row.connectionId}`,
      subject: {
        kind: "connection",
        key: row.connectionId,
        title: (row.accountLabel ?? row.label).slice(0, 280),
      },
      scope: {},
      since: iso(stop === "quiet" ? from + MAIL_QUIET_MS : (row.readFailedAt ?? from)),
      consequence: mailConsequence(stop, row.readOkAt === null ? null : whenOf(ctx, row.readOkAt)),
      actor: { _tag: "owner" },
      sensitive: true,
      wake: "sweep",
    });
  }
  return facts;
});

/** One line a row shows whole: the fix first. Connections says why, and since when. */
const mailConsequence = (stop: MailStop, readAt: string | null) => {
  switch (stop) {
    case "signed_out":
      return "Mail isn't syncing: sign in again.";
    case "unreachable":
      return "Mail isn't syncing: Kin can't reach it.";
    case "review":
      return "Mail isn't syncing: a tool on it changed.";
    case "failing":
      return "Mail isn't syncing: try signing in again.";
    case "quiet":
      return readAt === null
        ? "No mail read yet: try signing in again."
        : `No mail read since ${readAt}: try signing in again.`;
  }
};
