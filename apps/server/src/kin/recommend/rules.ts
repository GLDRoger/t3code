import {
  KIN_CHOICE_CARD_TTL_MS,
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

import { USUAL_LIMITS } from "../lead/KinBudget.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { accessSql } from "../people/KinAccess.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { dayIn } from "../work/money.ts";

/*
 * Kin's recommendation rules: each one query over rows Kin already keeps, counted over a window
 * and held to a threshold. No model writes or picks anything. A rule answers for every subject it
 * counted, firing or silent and why; the tap asks again for its one subject.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

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

const ROUTE_ACCESS = "route_access";
/** Three asks in a month is "frequently" for a small team. */
const ROUTE_ASKS = 3;
/** Of them, this many ran out or waited on an open card: the owner's time was the hold-up, not their judgement. */
const ROUTE_UNANSWERED = 2;
const ROUTE_WINDOW_MS = 30 * DAY_MS;
/** He stopped them messaging that agent this recently: not suggested back. */
const ROUTE_REVOKED_MS = 90 * DAY_MS;

const routeSubject = (personId: string, agentId: string) => `person:${personId}|agent:${agentId}`;

type AskRow = {
  readonly personId: string;
  readonly agentId: string;
  /** When the person's own message was sent. */
  readonly sentAt: string;
  /** When the hand-off was recorded: for a waited row, when it found its card open. */
  readonly at: number;
  readonly state: string;
  readonly cardAt: string | null;
  readonly closedAt: string | null;
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** How a request's card stands, from the stored card: only what its rows show. */
const cardOf = (one: AskRow, at: number) => {
  if (one.cardAt === null) return "gone" as const;
  const expires = Date.parse(one.cardAt) + KIN_CHOICE_CARD_TTL_MS;
  const closed = one.closedAt === null ? undefined : Date.parse(one.closedAt);
  if (closed !== undefined && closed < expires) return { closed } as const;
  return expires <= at ? ("ran_out" as const) : ("open" as const);
};

/**
 * Rule 1: a teammate keeps asking an agent for another agent's work (`KinHandoff.passOn`) and
 * the owner's card on it ran out, waited, or was declined. One standing yes ends the wait: the
 * same `KinLeadProvision.allow` the agent's page calls. `only` asks for one pair, as the tap does.
 * A request counts by when the person sent it; one passed on and later cancelled doesn't count.
 */
export const routeAccess = Effect.fn("KinRecommendRules.routeAccess")(function* (
  ctx: RuleContext,
  only?: { readonly personId: string; readonly agentId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  // A hand-off is recorded after its message, so the first bound only narrows the scan.
  const rows = yield* sql<AskRow>`SELECT m.author_person_id AS "personId",
      h.to_agent_id AS "agentId", m.created_at AS "sentAt",
      h.created_at AS at, h.route_state AS state, w.updated_at AS "cardAt",
      w.closed_at AS "closedAt"
    FROM kin_handoffs h
    JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
      AND m.author_kind = 'human'
    LEFT JOIN kin_widgets w ON w.org_id = h.org_id AND w.widget_id = h.route_widget_id
    WHERE h.org_id = ${orgId} AND h.created_at > ${at - ROUTE_WINDOW_MS}
      AND m.created_at > ${iso(at - ROUTE_WINDOW_MS)} AND m.created_at <= ${iso(at)}
      AND h.route_state IN ('pending', 'waited', 'declined')
      ${only === undefined ? sql`` : sql`AND m.author_person_id = ${only.personId} AND h.to_agent_id = ${only.agentId}`}
    ORDER BY m.author_person_id, h.to_agent_id, m.created_at, h.message_id`;
  const groups = new Map<
    string,
    { readonly personId: string; readonly agentId: string; readonly asks: Array<AskRow> }
  >();
  if (only !== undefined)
    groups.set(routeSubject(only.personId, only.agentId), { ...only, asks: [] });
  for (const row of rows) {
    const subject = routeSubject(row.personId, row.agentId);
    const group = groups.get(subject) ?? { personId: row.personId, agentId: row.agentId, asks: [] };
    group.asks.push(row);
    groups.set(subject, group);
  }
  const verdicts: Array<Verdict> = [];
  for (const [subject, group] of groups)
    verdicts.push(yield* routeVerdict(ctx, { subject, ...group }));
  return verdicts;
});

const routeVerdict = Effect.fn("KinRecommendRules.routeVerdict")(function* (
  ctx: RuleContext,
  pair: {
    readonly subject: string;
    readonly personId: string;
    readonly agentId: string;
    readonly asks: ReadonlyArray<AskRow>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const { subject, asks } = pair;
  const silent = (reason: string): Verdict => ({ _tag: "silent", subject, reason });
  const [person] = yield* sql<{ name: string; removedAt: number | null; ownerLevel: number }>`SELECT
      p.display_name AS name, p.removed_at AS "removedAt",
      ${sql.literal(accessSql("p"))} IN ('owner', 'co_owner') AS "ownerLevel"
    FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${pair.personId}`;
  const [agent] = yield* sql<{ name: string; live: number }>`SELECT l.name,
      (a.role = 'lead' AND a.retired_at IS NULL AND a.owner_person_id = ${ctx.ownerId}) AS live
    FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND l.agent_id = ${pair.agentId}`;
  const personName = person?.name ?? "This teammate";
  const agentName = agent?.name ?? "that agent";
  if (person === undefined || person.removedAt !== null)
    return silent(`${personName} is no longer on the team`);
  if (agent === undefined || agent.live !== 1)
    return silent(`${agentName} is no longer one of your agents`);
  if (pair.personId === ctx.ownerId) return silent(`you already message ${agentName}`);
  const personId = KinPersonId.make(pair.personId);
  const agentId = KinAgentId.make(pair.agentId);
  // Owner-level people message every lead already (`KinChatService.createDirect`).
  if (person.ownerLevel === 1 || (yield* LeadAccess.allowed({ orgId, agentId, personId })))
    return silent(`${personName} can already message ${agentName}`);
  // The owner's last answer for this pair, at any time, by when the tap that settled it came:
  // Not this time is judgement, not time. A tap that changed nothing settled no answer, and one
  // whose card was cleared since has no time to place it by.
  const [answer] = yield* sql<{ declined: number }>`SELECT
      (h.route_state = 'declined') AS declined
    FROM kin_handoffs h
    JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
      AND m.author_kind = 'human' AND m.author_person_id = ${pair.personId}
    JOIN kin_card_plans c ON c.org_id = h.org_id AND c.widget_id = h.route_widget_id
      AND c.ran_message_id IS NOT NULL
    JOIN kin_messages t ON t.org_id = c.org_id AND t.message_id = c.ran_message_id
    WHERE h.org_id = ${orgId} AND h.to_agent_id = ${pair.agentId}
      AND h.route_state IN ('declined', 'passed')
    ORDER BY t.created_at DESC, h.message_id DESC LIMIT 1`;
  if (answer?.declined === 1)
    return silent(`you said Not this time to ${personName}'s last request for ${agentName}`);
  const [revoked] = yield* sql`SELECT 1 FROM kin_lead_access
    WHERE org_id = ${orgId} AND agent_id = ${pair.agentId} AND person_id = ${pair.personId}
      AND revoked_at IS NOT NULL AND revoked_at > ${at - ROUTE_REVOKED_MS}`;
  if (revoked !== undefined) return silent(`you stopped ${personName} messaging ${agentName}`);
  const ranOut = asks.filter(
    (one) => one.state === "pending" && cardOf(one, at) === "ran_out",
  ).length;
  // It waited on a card that was still taking taps when it was recorded.
  const waited = asks.filter((one) => {
    if (one.state !== "waited") return false;
    const card = cardOf(one, one.at);
    return card === "open" || (typeof card === "object" && card.closed > one.at);
  }).length;
  if (asks.length < ROUTE_ASKS || ranOut + waited < ROUTE_UNANSWERED)
    return silent(`${personName} hasn't been waiting on you for ${agentName} that often lately`);
  const since = formatKinWhen(Date.parse(asks[0]!.sentAt), "date", {
    zone: ctx.zone,
    locale: ctx.locale,
  });
  // Only the requests that needed the owner's yes are counted, so it never says "all of them".
  const noticed = `Since ${since}, ${asks.length} of ${personName}'s requests for ${agentName} had to wait for your yes, and ${ranOut + waited} ran out or waited behind another.`;
  return {
    _tag: "fires",
    candidate: {
      rule: ROUTE_ACCESS,
      subject,
      weight: asks.length,
      noticed,
      ask: `Let ${personName} message ${agentName} directly?`,
      gives: `${personName} could then ask ${agentName} without waiting for you. ${agentName} talks and drafts for ${personName} within what ${personName} is allowed to see, and starting work stays yours to ask for.`,
      change: {
        kind: "lead_access",
        personId: pair.personId,
        personName,
        agentId: pair.agentId,
        agentName,
      },
    },
  } satisfies Verdict;
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
  const own = yield* LeadAccess.granted({
    orgId,
    agentId: KinAgentId.make(change.agentId),
    personId: KinPersonId.make(change.personId),
  });
  return own ? ("live" as const) : ("ended" as const);
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

/** The agents' daily limit now, and its name as Settings shows it: null when it is no choice there. */
export const limitNow = Effect.fn("KinRecommendRules.limitNow")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [stored] = yield* sql<{ limits: string }>`SELECT limits_json AS limits
    FROM kin_budget_limits WHERE org_id = ${orgId}`;
  const limits = Option.getOrUndefined(decodeLimits(stored?.limits ?? null));
  const leadUnits = limits?.leadUnits ?? null;
  if (leadUnits === null) return { leadUnits, step: -1, name: "No limit" } as const;
  const step = KIN_DAILY_LIMIT_STEPS.findIndex(
    (one) => Math.round(USUAL_LIMITS.leadUnits * one.times) === leadUnits,
  );
  return { leadUnits, step, name: step === -1 ? null : KIN_DAILY_LIMIT_STEPS[step]!.label };
});

const timesWord = (times: number) =>
  times === 2 ? "twice" : times === 2.5 ? "two and a half times" : `${times} times`;

/**
 * Rule 2: the agents used up the daily limit, as it is now, on several of the last seven days,
 * each a day Kin told the owner their other work would wait (`kin_budget.exhausted_notified_at`).
 * The next choice up in Settings, never past the top, and never a limit set some other way.
 */
export const dailyLimit = Effect.fn("KinRecommendRules.dailyLimit")(function* (ctx: RuleContext) {
  const sql = yield* SqlClient.SqlClient;
  const subject = "org";
  const silent = (reason: string): Verdict => ({ _tag: "silent", subject, reason });
  const limit = yield* limitNow(ctx.orgId);
  if (limit.leadUnits === null) return [silent("there is no daily limit")];
  if (limit.name === null) return [silent("the daily limit was set to its own amount")];
  const next = KIN_DAILY_LIMIT_STEPS[limit.step + 1];
  if (next === undefined) return [silent(`the daily limit is already ${limit.name}`)];
  // Today and the six days before it, on the owner's clock, as `kin_budget.day` is kept.
  const first = dayIn(ctx.at - (LIMIT_WINDOW_DAYS - 1) * DAY_MS, ctx.zone);
  const today = dayIn(ctx.at, ctx.zone);
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
        noticed: `Your agents used up the daily limit, ${from.label}, on ${count} of the last ${LIMIT_WINDOW_DAYS} days, and each of those days Kin told you their other work would wait.`,
        ask: `Raise the daily limit from ${from.label} to ${next.label}?`,
        gives: `Your agents could then use up to ${timesWord(next.times / from.times)} as much of your model plan each day, which can cost you more. Nothing is raised unless you tap.`,
        change: {
          kind: "daily_limit",
          fromLeadUnits: limit.leadUnits,
          fromName: from.label,
          toLeadUnits: Math.round(USUAL_LIMITS.leadUnits * next.times),
          toWorkerUnits: Math.round(USUAL_LIMITS.workerUnits * next.times),
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

/** "Finance", "Finance and Tech lead", or "3 of your agents". */
const whoTried = (names: ReadonlyArray<string>) =>
  names.length === 1
    ? names[0]!
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.length} of your agents`;

/**
 * Rule 3: a paused connection agents keep being refused on. While a connection is paused every
 * call on it is refused before anything else is checked (`KinConnections` `callOn`), so a refused
 * call on it since its pause began is a try the pause stopped.
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
    removedAt: number | null;
  }>`SELECT connection_id AS "connectionId", label AS name, paused_at AS "pausedAt", state,
      removed_at AS "removedAt"
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
    if (at - row.pausedAt < PAUSED_MS) {
      silent(`${row.name} was paused only recently`);
      continue;
    }
    const tries = yield* sql<{ name: string; count: number }>`SELECT
        COALESCE(l.name, k.agent_id) AS name, COUNT(*) AS count
      FROM kin_connection_calls k
      LEFT JOIN kin_leads l ON l.org_id = k.org_id AND l.agent_id = k.agent_id
      WHERE k.org_id = ${orgId} AND k.connection_id = ${row.connectionId}
        AND k.status = 'refused' AND k.created_at >= ${row.pausedAt}
        AND k.created_at > ${at - CONNECTION_WINDOW_MS} AND k.created_at <= ${at}
      GROUP BY k.agent_id ORDER BY name, k.agent_id`;
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
 * Rule 5: a paused agent with work waiting for it. A paused agent's queued events are never
 * claimed (`KinEventQueue` `readyLeads`), so each is a thing that waits for its resume.
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
    waiting: number;
    yours: number;
  }>`SELECT a.agent_id AS "agentId", l.name, a.paused_at AS "pausedAt",
      a.retired_at AS "retiredAt",
      (SELECT COUNT(*) FROM kin_events e WHERE e.org_id = a.org_id AND e.agent_id = a.agent_id
        AND e.state = 'queued') AS waiting,
      (SELECT COUNT(*) FROM kin_events e WHERE e.org_id = a.org_id AND e.agent_id = a.agent_id
        AND e.state = 'queued' AND e.tag = 'chat.message'
        AND json_extract(e.json, '$.provenance._tag') = 'human'
        AND json_extract(e.json, '$.provenance.personId') = ${ctx.ownerId}) AS yours
    FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.role = 'lead' AND a.owner_person_id = ${ctx.ownerId}
      AND a.paused_at IS NOT NULL
      ${only === undefined ? sql`AND a.retired_at IS NULL` : sql`AND a.agent_id = ${only.agentId}`}
    ORDER BY a.agent_id`;
  const verdicts: Array<Verdict> = [];
  for (const row of rows) {
    const subject = `agent:${row.agentId}`;
    const silent = (reason: string) => verdicts.push({ _tag: "silent", subject, reason });
    const pausedAt = Date.parse(row.pausedAt);
    if (row.retiredAt !== null) silent(`${row.name} is no longer there`);
    else if (at - pausedAt < PAUSED_MS) silent(`${row.name} was paused only recently`);
    else if (row.waiting < PAUSED_HELD) silent(`not much waits for ${row.name}`);
    else
      verdicts.push({
        _tag: "fires",
        candidate: {
          rule: AGENT_PAUSED,
          subject,
          weight: row.waiting,
          noticed: `${row.name} has been paused since ${formatDay(ctx, pausedAt)}, and ${row.waiting} things wait for it${row.yours === 0 ? "" : `, ${row.yours} of them ${row.yours === 1 ? "a message" : "messages"} from you`}.`,
          ask: `Resume ${row.name}?`,
          gives: `${row.name} would then pick up what waits for it.`,
          change: { kind: "agent_resume", agentId: row.agentId, agentName: row.name, pausedAt },
        },
      });
  }
  return verdicts;
});

/**
 * Rules in rank order: the first that fires speaks. A teammate waiting on the owner comes first,
 * then the limit that holds every agent back, then a connection, then one paused agent.
 */
export const RULES = [routeAccess, dailyLimit, connectionPaused, agentPaused] as const;

/** The rule a change came from, asked again for that change's one subject, as the tap does. */
export const ruleFor = (ctx: RuleContext, change: RecommendChange) => {
  switch (change.kind) {
    case "lead_access":
      return { rule: ROUTE_ACCESS, verdicts: routeAccess(ctx, change) };
    case "daily_limit":
      return { rule: DAILY_LIMIT, verdicts: dailyLimit(ctx) };
    case "connection_resume":
      return { rule: CONNECTION_PAUSED, verdicts: connectionPaused(ctx, change) };
    case "agent_resume":
      return { rule: AGENT_PAUSED, verdicts: agentPaused(ctx, change) };
  }
};
