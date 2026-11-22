import { formatKinLate, KIN_TEXT_LOCALE, KinAgentId, KinTaskCardState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { WatchKind } from "./kind.ts";

/** A delegated task with no change for this long is a problem. */
const TASK_QUIET_MS = 2 * 3_600_000;
const FIND_CAP = 200;

/** Task cards (`kin_widgets` of type task) that are still out: running, or stuck. */
export const openTaskCards = Effect.fn("KinWatch.openTaskCards")(function* (orgId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    widgetId: string;
    agentId: string | null;
    threadId: string | null;
    title: string;
    status: string;
    pullRequests: string | null;
  }>`SELECT w.widget_id AS "widgetId", m.author_agent_id AS "agentId",
      json_extract(w.state_json, '$.threadId') AS "threadId",
      json_extract(w.state_json, '$.title') AS title,
      json_extract(w.state_json, '$.status') AS status,
      json_extract(w.state_json, '$.pullRequests') AS "pullRequests"
    FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    WHERE w.org_id = ${orgId} AND w.type = 'task' AND w.closed_at IS NULL
      AND json_extract(w.state_json, '$.status') IN
        ('working', 'waiting', 'needs_decision', 'blocked', 'failed')
    ORDER BY w.updated_at, w.widget_id LIMIT ${FIND_CAP}`;
});

const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(KinTaskCardState));

/**
 * Work an agent delegated: a problem when it failed, is blocked, waits on a decision, or has shown
 * no change for 2 hours; closed when it is done, stopped, or its card is gone.
 */
export const taskOut: WatchKind = {
  kind: "task_out",
  source: "task",
  reach: "work",
  checksWork: true,
  find: Effect.fn("KinWatch.taskOut.find")(function* (ctx) {
    return (yield* openTaskCards(ctx.orgId)).map((row) => {
      const agent =
        row.agentId !== null && ctx.liveAgents.has(row.agentId) ? row.agentId : ctx.chief;
      return {
        sourceKey: row.widgetId,
        recordId: null,
        subjectRef: row.threadId,
        about: row.title.slice(0, 200),
        closesWhen: "the work is done or stopped",
        agentId: agent === undefined ? null : KinAgentId.make(agent),
        why: "an agent handed this work out",
      };
    });
  }),
  moved: Effect.fn("KinWatch.taskOut.moved")(function* (ctx, watches) {
    const sql = yield* SqlClient.SqlClient;
    if (watches.length === 0) return new Set<string>();
    const rows = yield* sql<{ widgetId: string; updatedAt: string }>`SELECT widget_id AS "widgetId",
        updated_at AS "updatedAt" FROM kin_widgets
      WHERE org_id = ${ctx.orgId} AND widget_id IN ${sql.in(watches.map((watch) => watch.sourceKey))}
      ORDER BY widget_id`;
    const changed = new Map(rows.map((row) => [row.widgetId, Date.parse(row.updatedAt)]));
    return new Set(
      watches.flatMap((watch) =>
        (changed.get(watch.sourceKey) ?? 0) > (watch.lookedAt ?? watch.createdAt)
          ? [watch.watchId]
          : [],
      ),
    );
  }),
  check: Effect.fn("KinWatch.taskOut.check")(function* (ctx, watch) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      stateJson: string;
      closedAt: string | null;
    }>`SELECT state_json AS "stateJson", closed_at AS "closedAt"
      FROM kin_widgets WHERE org_id = ${ctx.orgId} AND widget_id = ${watch.sourceKey}`;
    if (row === undefined || row.closedAt !== null)
      return { _tag: "closed", how: "no longer applies: its task card was closed", evidence: [] };
    const evidence = watch.subjectRef === null ? [] : [{ kind: "thread", id: watch.subjectRef }];
    const card = Option.getOrUndefined(decodeCard(row.stateJson));
    if (card === undefined) return { _tag: "nothing_new", evidence };
    switch (card.status) {
      case "done":
        return { _tag: "closed", how: "the work is done", evidence };
      case "cancelled":
        return { _tag: "closed", how: "the work was stopped", evidence };
      case "failed":
        return { _tag: "problem", line: "the work failed", evidence };
      case "blocked":
        return { _tag: "problem", line: "the work is blocked", evidence };
      case "needs_decision":
        return { _tag: "problem", line: "the work waits on a decision", evidence };
    }
    const since = Date.parse(card.updatedAt);
    if (ctx.at - since < TASK_QUIET_MS) return { _tag: "nothing_new", evidence };
    const late = formatKinLate(since, ctx.at, { zone: ctx.zone, locale: KIN_TEXT_LOCALE });
    return { _tag: "problem", line: `no change ${late}`, evidence };
  }),
};
