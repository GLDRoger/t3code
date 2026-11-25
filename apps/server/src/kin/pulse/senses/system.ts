import { KinAgentId, KinPersonId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { cappedRows } from "./capped.ts";

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
  const gaps = yield* cappedRows<{
    arrivalId: string;
    personId: string | null;
    mailbox: string;
    from: number;
    to: number;
  }>(
    ctx,
    facts,
    { sense: "mail_gap", plural: "mail gaps", access: "system" },
    sql`SELECT a.arrival_id AS "arrivalId", c.person_id AS "personId",
      COALESCE(c.account_label, c.label) AS mailbox, a.received_at AS "from", a.noticed_at AS "to"
    FROM kin_arrivals a
    JOIN kin_connections c ON c.org_id = a.org_id AND c.connection_id = a.connection_id
      AND c.removed_at IS NULL
    WHERE a.org_id = ${orgId} AND a.class = 'gap' AND a.settled_at IS NOT NULL
      AND a.received_at IS NOT NULL AND a.noticed_at > ${at - 7 * DAY_MS} AND a.noticed_at <= ${at}
    ORDER BY a.noticed_at, a.arrival_id`,
  );
  for (const row of gaps) {
    const mailbox = row.mailbox.replace(/\s+/g, " ").trim().slice(0, 280);
    facts.push({
      sense: "mail_gap",
      family: "system",
      key: `mail_gap:${row.arrivalId}`,
      subject: { kind: "mailbox", key: mailbox, title: mailbox },
      scope: {},
      since: iso(row.to),
      consequence: `Kin couldn't read mail for ${mailbox} between ${whenOf(ctx, row.from)} and ${whenOf(ctx, row.to)}; anything that arrived then hasn't been looked at.`,
      actor:
        row.personId === null
          ? { _tag: "owner" }
          : { _tag: "person", personId: KinPersonId.make(row.personId) },
      sensitive: true,
      wake: "brief",
    });
  }
  return facts;
});
