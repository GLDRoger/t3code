import { formatKinWhen, KIN_TEXT_LOCALE, KinAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DAY_MS } from "../../durations.ts";
import type { WatchKind } from "./kind.ts";
import { possessive } from "./shared.ts";

const FIND_CAP = 50;

/**
 * A wake-up that failed or ran out of time in the last day: closed once every event it held ran
 * later, a problem once the queue gave up on one.
 */
export const turnFailed: WatchKind = {
  kind: "turn_failed",
  source: "turn",
  reach: "work",
  checksWork: true,
  find: Effect.fn("KinWatch.turnFailed.find")(function* (ctx) {
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
      WHERE w.org_id = ${ctx.orgId} AND w.status IN ('failed', 'timed_out')
        AND w.ended_at >= ${ctx.at - DAY_MS} AND json_array_length(w.event_ids) > 0
      ORDER BY w.ended_at DESC, w.wakeup_id LIMIT ${FIND_CAP}`;
    return rows.map((row) => {
      const when = formatKinWhen(row.startedAt, "dayTime", {
        zone: ctx.zone,
        locale: KIN_TEXT_LOCALE,
      });
      return {
        sourceKey: row.wakeupId,
        recordId: null,
        subjectRef: row.wakeupId,
        about: `${possessive(row.name ?? "An agent")} turn from ${when}`.slice(0, 200),
        closesWhen: "the work it held runs",
        agentId: KinAgentId.make(row.agentId),
        why: "a turn failed",
      };
    });
  }),
  check: Effect.fn("KinWatch.turnFailed.check")(function* (ctx, watch) {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* sql<{ eventId: string; state: string }>`SELECT e.event_id AS "eventId",
        e.state FROM kin_wakeups w, json_each(w.event_ids) j
      JOIN kin_events e ON e.org_id = w.org_id AND e.event_id = j.value
      WHERE w.org_id = ${ctx.orgId} AND w.wakeup_id = ${watch.sourceKey}
      ORDER BY e.event_id`;
    const evidence = events.map((event) => ({ kind: "event", id: event.eventId }));
    if (events.every((event) => event.state === "expired"))
      return { _tag: "closed", how: "no longer applies: its work was dropped", evidence };
    if (events.some((event) => event.state === "failed"))
      return { _tag: "problem", line: "its work failed 3 times and stopped", evidence };
    if (events.every((event) => event.state === "done" || event.state === "expired"))
      return { _tag: "closed", how: "the work ran later", evidence };
    return { _tag: "nothing_new", evidence };
  }),
};
