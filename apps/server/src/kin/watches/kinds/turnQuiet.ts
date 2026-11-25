import { formatKinWhen, KIN_TEXT_LOCALE, KinAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { QUIET_ASKS_MS } from "../../lead/runSilence.ts";
import type { WatchContext, WatchKind } from "./kind.ts";
import { possessive } from "./shared.ts";

const closesWhen = "it shows progress again or ends";
const dayTime = (at: number, ctx: WatchContext) =>
  formatKinWhen(at, "dayTime", { zone: ctx.zone, locale: KIN_TEXT_LOCALE });

export const turnQuiet: WatchKind = {
  kind: "turn_quiet",
  source: "turn",
  reach: "work",
  checksWork: true,
  find: Effect.fn("KinWatch.turnQuiet.find")(function* (ctx) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      wakeupId: string;
      agentId: string;
      name: string | null;
      startedAt: number;
    }>`SELECT w.wakeup_id AS "wakeupId", w.agent_id AS "agentId", a.display_name AS name,
        w.started_at AS "startedAt"
      FROM kin_wakeups w
      LEFT JOIN kin_agents a ON a.org_id = w.org_id AND a.agent_id = w.agent_id
      WHERE w.org_id = ${ctx.orgId} AND w.status = 'running'
        AND w.quiet_since <= ${ctx.at - QUIET_ASKS_MS[0]} AND NOT EXISTS (
          SELECT 1 FROM kin_events e
          WHERE e.org_id = w.org_id AND e.agent_id = w.agent_id AND e.wakeup_id = w.wakeup_id
            AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
        )
      ORDER BY w.quiet_since, w.wakeup_id LIMIT 50`;
    return rows.map((row) => ({
      sourceKey: row.wakeupId,
      recordId: null,
      subjectRef: row.wakeupId,
      about: `${possessive(row.name ?? "An agent")} turn from ${dayTime(row.startedAt, ctx)}`.slice(
        0,
        200,
      ),
      closesWhen,
      agentId: KinAgentId.make(row.agentId),
      why: "a turn has shown no progress for 15 minutes",
    }));
  }),
  check: Effect.fn("KinWatch.turnQuiet.check")(function* (ctx, watch) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ quietSince: number | null }>`SELECT quiet_since AS "quietSince"
      FROM kin_wakeups WHERE org_id = ${ctx.orgId} AND wakeup_id = ${watch.sourceKey}
        AND status = 'running' ORDER BY wakeup_id`;
    const evidence = [{ kind: "turn", id: watch.sourceKey }];
    if (row?.quietSince == null) return { _tag: "closed", how: closesWhen, evidence };
    return {
      _tag: "problem",
      line: `No sign of progress since ${dayTime(row.quietSince, ctx)}. It keeps running until someone with the owner's access stops it with Stop on its chat's working line.`,
      evidence,
    };
  }),
};
