import {
  KinBudgetLimits,
  KinOrgId,
  RunAttemptId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { episodeNotice } from "../hostBackup.ts";
import { fromLedgers, unitsOf, USUAL_LIMITS, type Usage } from "../lead/KinBudget.ts";
import { runsFrom } from "../lead/wakeupRuns.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";

const EVERY_MS = 5 * 60_000;
const STEPS = [
  { id: "quarter", share: 0.25, words: "past a quarter of" },
  { id: "all", share: 1, words: "past the whole of" },
] as const;
const prefixOf = (orgId: KinOrgId) => `kin-running-spend:${orgId}:`;
const decodeLimits = Schema.decodeUnknownOption(Schema.fromJsonString(KinBudgetLimits));

/** The provider turns a running turn has so far: a wake-up's from its root run, or a task's thread. */
export type ReadUsage = (input: {
  readonly threadId: ThreadId;
  readonly rootRunId: RunId | null;
}) => Effect.Effect<ReadonlyArray<Usage>, never, SqlClient.SqlClient>;

/** As the Budgets screen writes units: "520k", "1.2M". */
const unitsText = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : n >= 1_000
      ? `${Math.round(n / 1_000)}k`
      : `${Math.round(n)}`;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const lasted = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0
    ? plural(hours, "hour")
    : `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}`;
};

/** The owner's notice for one running turn past `step`; nothing in it stops the turn. */
const runningSpendNotice = (input: {
  readonly agent: string;
  readonly forPerson: string | null;
  readonly task: boolean;
  readonly ranMs: number;
  readonly units: number;
  // A provider turn without a ledger only gave its last request's size.
  readonly atLeast: boolean;
  readonly step: (typeof STEPS)[number];
  readonly limitSet: boolean;
}) => {
  const share = input.step.id === "quarter" ? "a quarter of" : "all of";
  const day = input.limitSet ? "today's limit" : "a usual day's limit";
  const whose = input.task ? "tasks your agents start" : "your agents";
  const what = input.task
    ? `A task ${input.agent} started`
    : `${input.agent}'s turn${input.forPerson === null ? "" : ` for ${input.forPerson}`}`;
  return `${input.task ? `A task ${input.agent} started` : input.agent} has used ${share} ${day} in one go\n\n${what} has been running ${lasted(input.ranMs)} and has used ${input.atLeast ? "at least " : ""}${unitsText(input.units)} units so far, ${input.step.words} ${day} for ${whose}${input.limitSet ? "" : " (you have set no daily limit)"}. It is still running; Kin hasn't stopped or slowed it. To watch it or stop it, open ${input.task ? `its card in ${input.agent}'s chat` : `${input.agent}'s chat`}.`;
};

/**
 * For each turn running now (a wake-up, or a task an agent delegated), one notice in the owner's
 * private chat once it has spent a quarter of the day's limit, and one at the whole; each closes
 * when the turn ends. A notice only: nothing here holds, slows or stops any work.
 */
const checkOrg = Effect.fn("KinRunningSpend.checkOrg")(function* (
  orgId: KinOrgId,
  read: ReadUsage,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
    FROM kin_budget_limits WHERE org_id = ${orgId} ORDER BY org_id`;
  const limits = Option.getOrUndefined(decodeLimits(stored?.limits ?? ""));
  const wakeups = yield* sql<{
    key: string;
    threadId: ThreadId;
    runId: RunId | null;
    startedAt: number;
    agent: string;
    forPerson: string | null;
  }>`SELECT w.wakeup_id AS key, w.thread_id AS "threadId", w.run_id AS "runId",
      w.started_at AS "startedAt", COALESCE(l.name, w.agent_id) AS agent,
      (SELECT p.display_name FROM kin_events e
        JOIN kin_people p ON p.org_id = e.org_id AND p.person_id = COALESCE(
          json_extract(e.json, '$.origin.personId'),
          CASE WHEN json_extract(e.json, '$.provenance._tag') = 'human'
            THEN json_extract(e.json, '$.provenance.personId') END,
          json_extract(e.json, '$.askedBy'))
        WHERE e.org_id = w.org_id AND e.wakeup_id = w.wakeup_id
          AND NOT ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
        ORDER BY e.rowid LIMIT 1) AS "forPerson"
    FROM kin_wakeups w
    LEFT JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
    WHERE w.org_id = ${orgId} AND w.status = 'running' AND w.thread_id IS NOT NULL
    ORDER BY w.started_at, w.wakeup_id`;
  const tasks = yield* sql<{ threadId: ThreadId; createdAt: string; agent: string }>`
    SELECT json_extract(w.state_json, '$.threadId') AS "threadId", m.created_at AS "createdAt",
      COALESCE(l.name, m.author_agent_id) AS agent
    FROM kin_widgets w
    JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
    LEFT JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.author_agent_id
    WHERE w.org_id = ${orgId} AND w.type = 'task' AND w.closed_at IS NULL
      AND json_extract(w.state_json, '$.status') = 'working'
      AND json_extract(w.state_json, '$.threadId') IS NOT NULL
    ORDER BY m.created_at, w.widget_id`;
  const running = [
    ...wakeups.map((row) => ({
      key: row.key,
      threadId: row.threadId,
      rootRunId: row.runId,
      startedAt: row.startedAt,
      agent: row.agent,
      forPerson: row.forPerson,
      task: false,
    })),
    ...tasks.map((row) => ({
      key: `task-${row.threadId}`,
      threadId: row.threadId,
      rootRunId: null,
      startedAt: Date.parse(row.createdAt),
      agent: row.agent,
      forPerson: null,
      task: true,
    })),
  ];
  const prefix = prefixOf(orgId);
  const live = new Set<string>();
  for (const turn of running) {
    const limit = turn.task ? (limits?.workerUnits ?? null) : (limits?.leadUnits ?? null);
    const yardstick = limit ?? (turn.task ? USUAL_LIMITS.workerUnits : USUAL_LIMITS.leadUnits);
    const usage = yield* read({ threadId: turn.threadId, rootRunId: turn.rootRunId });
    const units = unitsOf(usage);
    for (const step of STEPS) {
      const id = `${prefix}${turn.key}:${step.id}`;
      live.add(id);
      if (units < yardstick * step.share) continue;
      yield* episodeNotice(orgId, id, {
        id: "",
        body: runningSpendNotice({
          agent: turn.agent,
          forPerson: turn.forPerson,
          task: turn.task,
          ranMs: now - turn.startedAt,
          units,
          atLeast: !fromLedgers(usage),
          step,
          limitSet: limit !== null,
        }),
      });
    }
  }
  const open = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId" FROM kin_waiting
    WHERE org_id = ${orgId} AND resolved_at IS NULL
      AND substr(message_id, 1, ${prefix.length}) = ${prefix}
    ORDER BY message_id`;
  for (const { messageId } of open)
    if (!live.has(messageId)) yield* episodeNotice(orgId, messageId, undefined);
});

export const check = Effect.fn("KinRunningSpend.check")(function* (read: ReadUsage) {
  const sql = yield* SqlClient.SqlClient;
  const orgs = yield* sql<{
    orgId: string;
  }>`SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`;
  for (const row of orgs) {
    const orgId = KinOrgId.make(row.orgId);
    yield* checkOrg(orgId, read).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Kin running spend failed", { orgId, cause })),
    );
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const usage = Effect.fnUntraced(function* (threadId: ThreadId, rootRunId: RunId | null) {
      const sql = yield* SqlClient.SqlClient;
      // A wake-up's own runs from its root, as its charge reads them; a task's thread is all its own.
      const attempts =
        rootRunId === null
          ? undefined
          : (yield* sql<{ attemptId: string }>`SELECT attempt_id AS "attemptId"
              FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId}
                AND run_id IN ${sql.in((yield* runsFrom(threads, threadId, rootRunId)).map((run) => run.id))}
              ORDER BY attempt_id`).map((row) => RunAttemptId.make(row.attemptId));
      if (attempts?.length === 0) return [];
      const { providerTurns } = yield* threads.getThreadRecords(
        threadId,
        ["providerTurns"],
        attempts === undefined ? undefined : { providerTurnAttemptIds: attempts },
      );
      return providerTurns.map((turn) => ({
        providerTurnId: turn.id,
        ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
        ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
        usedTokens: turn.tokenUsage?.usedTokens,
      }));
    });
    const read: ReadUsage = ({ threadId, rootRunId }) =>
      usage(threadId, rootRunId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin running spend unreadable", { threadId, cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
    let nextAt = 0;
    yield* (yield* Scheduler.Scheduler).register(
      "kin-running-spend",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < nextAt) return;
        nextAt = now + EVERY_MS;
        yield* check(read);
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin running spend check failed", { cause })),
      ),
    );
  }),
);
