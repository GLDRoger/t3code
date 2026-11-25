import {
  KIN_DAILY_LIMIT_STEPS,
  KinAgentId,
  KinBudgetLimits,
  type KinOrgId,
  KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { callable, pausedRefusal, toolsOf } from "../connections/ConnectionRows.ts";
import { teamAgent } from "../lead/LeadAccess.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { USUAL_LIMITS } from "../lead/KinBudget.ts";
import * as Reach from "../lead/Reach.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { dayIn } from "../work/money.ts";
import { DAY_MS } from "../durations.ts";
export { DAY_MS };

/*
 * Kin's recommendation rules: each one query over rows Kin already keeps, counted over a window
 * and held to a threshold. No model writes or picks anything. A rule answers for every subject it
 * counted, firing or silent and why; the tap asks again for its one subject.
 */

export type RuleContext = {
  readonly orgId: KinOrgId;
  readonly at: number;
  /** The owner the suggestion is for, whose agents and Settings it changes. */
  readonly ownerId: KinPersonId;
  readonly zone: string;
  readonly locale: string;
};

export type RecommendChange = RecommendPlan["change"];

export type Candidate = {
  readonly rule: string;
  readonly subject: string;
  /** Within a rule, the largest count speaks first. */
  readonly weight: number;
  readonly urgent?: true;
  readonly noticed: string;
  /** The card's question: the one change, as a question. */
  readonly ask: string;
  /** What the tap gives, said plainly because it widens who may act. */
  readonly gives: string;
  readonly change: RecommendChange;
};

export type Verdict =
  | { readonly _tag: "fires"; readonly candidate: Candidate }
  | { readonly _tag: "silent"; readonly subject: string; readonly reason: string };

/**
 * Rule 1 asked to let a teammate message an agent they kept waiting on the owner for. Everyone
 * may message every agent now unless the owner restricted the pair, so it never fires; a card of
 * it still open is asked again here and changes nothing.
 */
const ROUTE_ACCESS = "route_access";

const routeRetired = Effect.fn("KinRecommendRules.routeRetired")(function* (
  ctx: RuleContext,
  change: Change<"lead_access">,
) {
  const reach = yield* Reach.mayReach(
    ctx.orgId,
    Reach.person(KinPersonId.make(change.personId)),
    Reach.agent(KinAgentId.make(change.agentId)),
  );
  const verdict: Verdict = {
    _tag: "silent",
    subject: `person:${change.personId}|agent:${change.agentId}`,
    reason:
      reach === "restricted"
        ? `you restricted ${change.personName} and ${change.agentName}`
        : `${change.personName} can already message ${change.agentName}`,
  };
  return [verdict];
});

type Change<K extends RecommendChange["kind"]> = Extract<RecommendChange, { readonly kind: K }>;

/** Whether the person's own access to the agent stands now, or it ended, or the agent is gone. */
export const grantNow = Effect.fn("KinRecommendRules.grantNow")(function* (
  orgId: KinOrgId,
  change: Change<"lead_access">,
) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ live: number }>`SELECT
      (role = 'lead' AND retired_at IS NULL) AS live
    FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${change.agentId}`;
  if (agent?.live !== 1) return "gone" as const;
  const open = yield* Reach.reaches(
    orgId,
    Reach.person(KinPersonId.make(change.personId)),
    Reach.agent(KinAgentId.make(change.agentId)),
  );
  return open ? ("live" as const) : ("ended" as const);
});

const formatDay = (ctx: RuleContext, at: number) =>
  formatKinWhen(at, "date", { zone: ctx.zone, locale: ctx.locale });

/** Paused this long before a resume is suggested: a pause of a day or two is still meant. */
const PAUSED_MS = 3 * DAY_MS;
/** This many tries or waiting things, at least, before a pause counts as a hold-up. */
const PAUSED_HELD = 3;

const DAILY_LIMIT = "daily_limit";
/** Used up on this many of the last seven days: the limit, not a busy day, sets the pace. */
const LIMIT_DAYS = 3;
const LIMIT_WINDOW_DAYS = 7;

const decodeLimits = Schema.decodeUnknownOption(Schema.fromJsonString(KinBudgetLimits));

const stepUnits = (times: number) => ({
  leadUnits: Math.round(USUAL_LIMITS.leadUnits * times),
  workerUnits: Math.round(USUAL_LIMITS.workerUnits * times),
});

/**
 * The agents' daily limits now, lead and worker, and their name as Settings shows them: a choice
 * there is the whole pair, so any other pair has no name (null).
 */
export const limitNow = Effect.fn("KinRecommendRules.limitNow")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
    FROM kin_budget_limits WHERE org_id = ${orgId}`;
  const limits = Option.getOrUndefined(decodeLimits(stored?.limits ?? null));
  const leadUnits = limits?.leadUnits ?? null;
  const workerUnits = limits?.workerUnits ?? null;
  if (leadUnits === null && workerUnits === null)
    return { leadUnits, workerUnits, step: -1, name: "No limit" } as const;
  const step = KIN_DAILY_LIMIT_STEPS.findIndex((one) => {
    const pair = stepUnits(one.times);
    return pair.leadUnits === leadUnits && pair.workerUnits === workerUnits;
  });
  return {
    leadUnits,
    workerUnits,
    step,
    name: step === -1 ? null : KIN_DAILY_LIMIT_STEPS[step]!.label,
  };
});

const timesWord = (times: number) =>
  times === 2 ? "twice" : times === 2.5 ? "two and a half times" : `${times} times`;

/**
 * Rule 2: on several of the last seven days Kin told the owner the daily limit was used up
 * (`kin_budget.exhausted_notified_at`) and the agents spent at least today's limit. The limit row
 * keeps no time it was set, so the card claims nothing about which limit those days had. The next
 * choice up in Settings, only from one of its choices, never past the top.
 */
export const dailyLimit = Effect.fn("KinRecommendRules.dailyLimit")(function* (ctx: RuleContext) {
  const sql = yield* SqlClient.SqlClient;
  const subject = "org";
  const silent = (reason: string): Verdict => ({ _tag: "silent", subject, reason });
  const limit = yield* limitNow(ctx.orgId);
  if (limit.leadUnits === null && limit.workerUnits === null)
    return [silent("there is no daily limit")];
  if (limit.name === null || limit.leadUnits === null || limit.workerUnits === null)
    return [silent("the daily limit was set to its own amount")];
  const next = KIN_DAILY_LIMIT_STEPS[limit.step + 1];
  if (next === undefined) return [silent(`the daily limit is already ${limit.name}`)];
  // Today and the six calendar days before it, on the owner's clock, as `kin_budget.day` is kept.
  const today = dayIn(ctx.at, ctx.zone);
  const first = DateTime.formatIsoDate(
    DateTime.subtract(DateTime.makeUnsafe(`${today}T00:00:00.000Z`), {
      days: LIMIT_WINDOW_DAYS - 1,
    }),
  );
  // The owner's share is what teammates' turns didn't spend, as `KinBudget.admit` reads it.
  const [days] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_budget b
    WHERE b.org_id = ${ctx.orgId} AND b.day >= ${first} AND b.day <= ${today}
      AND b.exhausted_notified_at IS NOT NULL
      AND b.lead_units - (SELECT COALESCE(SUM(c.units), 0) FROM kin_budget_charges c
        WHERE c.org_id = b.org_id AND c.day = b.day AND c.teammate = 1) >= ${limit.leadUnits}`;
  const count = days?.count ?? 0;
  if (count < LIMIT_DAYS)
    return [silent(`your agents haven't used up the daily limit that often lately`)];
  const from = KIN_DAILY_LIMIT_STEPS[limit.step]!;
  return [
    {
      _tag: "fires",
      candidate: {
        rule: DAILY_LIMIT,
        subject,
        weight: count,
        noticed: `Kin told you on ${count} of the last ${LIMIT_WINDOW_DAYS} days that the daily limit was reached. It is ${from.label} now.`,
        ask: `Raise the daily limit from ${from.label} to ${next.label}?`,
        gives: `Your agents could then do up to ${timesWord(next.times / from.times)} as much each day, which can cost you more. Nothing is raised unless you tap.`,
        change: {
          kind: "daily_limit",
          fromLeadUnits: limit.leadUnits,
          fromWorkerUnits: limit.workerUnits,
          fromName: from.label,
          toLeadUnits: stepUnits(next.times).leadUnits,
          toWorkerUnits: stepUnits(next.times).workerUnits,
          toName: next.label,
        },
      },
    } satisfies Verdict,
  ];
});

const CONNECTION_PAUSED = "connection_paused";
const CONNECTION_WINDOW_MS = 7 * DAY_MS;

/** A connection as it stands now; undefined when there never was one by that id here. */
export const connectionNow = Effect.fn("KinRecommendRules.connectionNow")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    name: string;
    pausedAt: number | null;
    state: string;
    removedAt: number | null;
  }>`SELECT label AS name, paused_at AS "pausedAt", state, removed_at AS "removedAt"
    FROM kin_connections WHERE org_id = ${orgId} AND connection_id = ${connectionId}`;
  return row;
});

/** "Finance", "Finance and Tech lead", or "3 of your agents"; one it can't name is "an agent". */
const whoTried = (names: ReadonlyArray<string | null>) => {
  const [one, two] = names;
  if (names.length === 1) return one ?? "an agent";
  return names.length === 2 && one != null && two != null
    ? `${one} and ${two}`
    : `${names.length} of your agents`;
};

/**
 * Rule 3: a paused connection agents keep being refused on for its pause (`KinConnections`
 * `callOn` logs that refusal by `pausedRefusal`), and that would work once resumed as its stored
 * state stands: no error from its last refresh, no review or sign-in it waits on, a tool on.
 */
export const connectionPaused = Effect.fn("KinRecommendRules.connectionPaused")(function* (
  ctx: RuleContext,
  only?: { readonly connectionId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const rows = yield* sql<{
    connectionId: string;
    name: string;
    pausedAt: number;
    state: string;
    lastError: string | null;
    removedAt: number | null;
  }>`SELECT connection_id AS "connectionId", label AS name, paused_at AS "pausedAt", state,
      last_error AS "lastError", removed_at AS "removedAt"
    FROM kin_connections WHERE org_id = ${orgId} AND paused_at IS NOT NULL
      ${only === undefined ? sql`AND removed_at IS NULL` : sql`AND connection_id = ${only.connectionId}`}
    ORDER BY connection_id`;
  const verdicts: Array<Verdict> = [];
  for (const row of rows) {
    const subject = `connection:${row.connectionId}`;
    const silent = (reason: string) => verdicts.push({ _tag: "silent", subject, reason });
    if (row.removedAt !== null) {
      silent(`${row.name} is no longer connected`);
      continue;
    }
    if (row.state === "needs_sign_in") {
      silent(`${row.name} needs signing in again, which resuming wouldn't fix`);
      continue;
    }
    if (row.state === "error" || row.lastError !== null) {
      silent(`${row.name} can't connect right now, which resuming wouldn't fix`);
      continue;
    }
    if (row.state === "needs_review") {
      silent(
        `${row.name} waits for you to look at what changed in it, which resuming wouldn't fix`,
      );
      continue;
    }
    if (!(yield* toolsOf(orgId, row.connectionId)).some(callable)) {
      silent(`none of the tools on ${row.name} is switched on, which resuming wouldn't fix`);
      continue;
    }
    if (at - row.pausedAt < PAUSED_MS) {
      silent(`${row.name} was paused only recently`);
      continue;
    }
    // The refusal names the connection as it was called then: any name matches.
    const tries = yield* sql<{ name: string | null; count: number }>`SELECT
        l.name AS name, COUNT(*) AS count
      FROM kin_connection_calls k
      LEFT JOIN kin_leads l ON l.org_id = k.org_id AND l.agent_id = k.agent_id
      WHERE k.org_id = ${orgId} AND k.connection_id = ${row.connectionId}
        AND k.status = 'refused' AND k.refused_reason LIKE ${pausedRefusal("%")}
        AND k.created_at >= ${row.pausedAt}
        AND k.created_at > ${at - CONNECTION_WINDOW_MS} AND k.created_at <= ${at}
      GROUP BY k.agent_id ORDER BY l.name IS NULL, l.name, k.agent_id`;
    const count = tries.reduce((sum, one) => sum + one.count, 0);
    if (count < PAUSED_HELD) {
      silent(`your agents haven't tried ${row.name} often since it was paused`);
      continue;
    }
    verdicts.push({
      _tag: "fires",
      candidate: {
        rule: CONNECTION_PAUSED,
        subject,
        weight: count,
        noticed: `${row.name} has been paused since ${formatDay(ctx, row.pausedAt)}. In the last 7 days ${whoTried(tries.map((one) => one.name))} tried to use it ${count} times and couldn't.`,
        ask: `Resume ${row.name}?`,
        gives: `Your agents could then use its tools again, each as you set it in Connections.`,
        change: {
          kind: "connection_resume",
          connectionId: row.connectionId,
          connectionName: row.name,
          pausedAt: row.pausedAt,
        },
      },
    });
  }
  return verdicts;
});

const AGENT_PAUSED = "agent_paused";

/** An agent as it stands now; undefined when there never was one by that id here. */
export const agentNow = Effect.fn("KinRecommendRules.agentNow")(function* (
  orgId: KinOrgId,
  agentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ name: string; pausedAt: string | null; retiredAt: string | null }>`
    SELECT l.name, a.paused_at AS "pausedAt", a.retired_at AS "retiredAt"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${agentId}`;
  return row === undefined
    ? undefined
    : {
        name: row.name,
        pausedAt: row.pausedAt === null ? null : Date.parse(row.pausedAt),
        retired: row.retiredAt !== null,
      };
});

/**
 * Rule 5: a paused agent with work queued since its pause. A paused agent's queued events are
 * never claimed (`KinEventQueue` `readyLeads`), so each is a thing that waits for its resume.
 */
export const agentPaused = Effect.fn("KinRecommendRules.agentPaused")(function* (
  ctx: RuleContext,
  only?: { readonly agentId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const rows = yield* sql<{
    agentId: string;
    name: string;
    pausedAt: string;
    retiredAt: string | null;
  }>`SELECT a.agent_id AS "agentId", l.name, a.paused_at AS "pausedAt",
      a.retired_at AS "retiredAt"
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.role = 'lead' AND a.owner_person_id = ${ctx.ownerId}
      AND a.paused_at IS NOT NULL
      ${only === undefined ? sql`AND a.retired_at IS NULL` : sql`AND a.agent_id = ${only.agentId}`}
    ORDER BY a.agent_id`;
  if (rows.length === 0) return [];
  const routing = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  const chair = yield* teamAgent(orgId);
  const verdicts: Array<Verdict> = [];
  for (const row of rows) {
    const subject = `agent:${row.agentId}`;
    const silent = (reason: string) => verdicts.push({ _tag: "silent", subject, reason });
    const pausedAt = Date.parse(row.pausedAt);
    // Only what was queued since the pause waits on it; older work was there before it.
    const [queued] = yield* sql<{ waiting: number; yours: number }>`SELECT COUNT(*) AS waiting,
        COALESCE(SUM(e.tag = 'chat.message'
          AND json_extract(e.json, '$.provenance._tag') = 'human'
          AND json_extract(e.json, '$.provenance.personId') = ${ctx.ownerId}), 0) AS yours
      FROM kin_events e WHERE e.org_id = ${orgId} AND e.agent_id = ${row.agentId}
        AND e.state = 'queued' AND e.queued_at >= ${pausedAt}`;
    const waiting = queued?.waiting ?? 0;
    const yours = queued?.yours ?? 0;
    const urgent = row.agentId === routing?.agentId || row.agentId === chair;
    if (row.retiredAt !== null) silent(`${row.name} is no longer there`);
    else if (!urgent && at - pausedAt < PAUSED_MS) silent(`${row.name} was paused only recently`);
    else if (!urgent && waiting < PAUSED_HELD) silent(`not much waits for ${row.name}`);
    else
      verdicts.push({
        _tag: "fires",
        candidate: {
          rule: AGENT_PAUSED,
          subject,
          weight: waiting,
          ...(urgent ? { urgent: true as const } : {}),
          noticed: `${row.name} has been paused since ${formatDay(ctx, pausedAt)}${waiting === 0 ? "" : `, and ${waiting} ${waiting === 1 ? "thing waits" : "things wait"} for it${yours === 0 ? "" : `, ${yours} of them ${yours === 1 ? "a message" : "messages"} from you`}`}.`,
          ask: `Resume ${row.name}?`,
          gives: `${row.name} would then pick up what waits for it.`,
          change: { kind: "agent_resume", agentId: row.agentId, agentName: row.name, pausedAt },
        },
      });
  }
  return verdicts;
});

/**
 * Rules in rank order: the first that fires speaks. The limit that holds every agent back comes
 * first, then a connection, then one paused agent.
 */
export const RULES = [dailyLimit, connectionPaused, agentPaused] as const;

/** The rule a change came from, asked again for that change's one subject, as the tap does. */
export const ruleFor = (ctx: RuleContext, change: RecommendChange) => {
  switch (change.kind) {
    case "lead_access":
      return { rule: ROUTE_ACCESS, verdicts: routeRetired(ctx, change) };
    case "daily_limit":
      return { rule: DAILY_LIMIT, verdicts: dailyLimit(ctx) };
    case "connection_resume":
      return { rule: CONNECTION_PAUSED, verdicts: connectionPaused(ctx, change) };
    case "agent_resume":
      return { rule: AGENT_PAUSED, verdicts: agentPaused(ctx, change) };
  }
};
