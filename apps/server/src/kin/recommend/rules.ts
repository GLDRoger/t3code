import {
  KIN_CHOICE_CARD_TTL_MS,
  KinAgentId,
  type KinOrgId,
  KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as LeadAccess from "../lead/LeadAccess.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";

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

export const ROUTE_ACCESS = "route_access";
/** Three asks in a month is "frequently" for a small team. */
const ROUTE_ASKS = 3;
/** Of them, this many ran out or waited on an open card: the owner's time was the hold-up, not their judgement. */
const ROUTE_UNANSWERED = 2;
const ROUTE_WINDOW_MS = 30 * DAY_MS;
/** He stopped them messaging that agent this recently: not suggested back. */
const ROUTE_REVOKED_MS = 90 * DAY_MS;

const routeSubject = (personId: string, agentId: string) => `person:${personId}|agent:${agentId}`;

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const word = (count: number) => WORDS[count] ?? `${count}`;
const times = (count: number, one: string, many: string) =>
  `${word(count)} ${count === 1 ? one : many}`;
const sentence = (parts: ReadonlyArray<string>) =>
  parts.length === 0
    ? ""
    : `${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`}.`;

type AskRow = {
  readonly personId: string;
  readonly agentId: string;
  readonly fromId: string;
  readonly at: number;
  readonly state: string;
  readonly cardAt: string | null;
  readonly closedAt: string | null;
};

/**
 * Rule 1: a teammate keeps asking an agent for another agent's work (`KinHandoff.passOn`) and
 * the owner's card on it ran out, waited, or was declined. One standing yes ends the wait: the
 * same `KinLeadProvision.allow` the agent's page calls. `only` asks for one pair, as the tap does.
 */
export const routeAccess = Effect.fn("KinRecommendRules.routeAccess")(function* (
  ctx: RuleContext,
  only?: { readonly personId: string; readonly agentId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = ctx;
  const rows = yield* sql<AskRow>`SELECT m.author_person_id AS "personId",
      h.to_agent_id AS "agentId", h.from_agent_id AS "fromId", h.created_at AS at,
      h.route_state AS state, w.updated_at AS "cardAt", w.closed_at AS "closedAt"
    FROM kin_handoffs h
    JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
      AND m.author_kind = 'human'
    LEFT JOIN kin_widgets w ON w.org_id = h.org_id AND w.widget_id = h.route_widget_id
    WHERE h.org_id = ${orgId} AND h.created_at > ${at - ROUTE_WINDOW_MS}
      AND h.created_at <= ${at}
      AND h.route_state IN ('pending', 'waited', 'declined', 'stale')
      ${only === undefined ? sql`` : sql`AND m.author_person_id = ${only.personId} AND h.to_agent_id = ${only.agentId}`}
    ORDER BY m.author_person_id, h.to_agent_id, h.created_at, h.message_id`;
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
  const [person] = yield* sql<{ name: string; removedAt: number | null }>`SELECT
      display_name AS name, removed_at AS "removedAt" FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${pair.personId}`;
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
  if (yield* LeadAccess.allowed({ orgId, agentId, personId }))
    return silent(`${personName} can already message ${agentName}`);
  // The owner's last answer for this pair, at any time: Not this time is judgement, not time.
  const [answer] = yield* sql<{ state: string }>`SELECT h.route_state AS state FROM kin_handoffs h
    JOIN kin_messages m ON m.org_id = h.org_id AND m.message_id = h.message_id
      AND m.author_kind = 'human' AND m.author_person_id = ${pair.personId}
    WHERE h.org_id = ${orgId} AND h.to_agent_id = ${pair.agentId}
      AND (h.route_state = 'declined' OR (h.route_state = 'passed' AND h.route_widget_id IS NOT NULL))
    ORDER BY h.created_at DESC, h.message_id DESC LIMIT 1`;
  if (answer?.state === "declined")
    return silent(`you said Not this time to ${personName}'s last request for ${agentName}`);
  const [revoked] = yield* sql`SELECT 1 FROM kin_lead_access
    WHERE org_id = ${orgId} AND agent_id = ${pair.agentId} AND person_id = ${pair.personId}
      AND revoked_at IS NOT NULL AND revoked_at > ${at - ROUTE_REVOKED_MS}`;
  if (revoked !== undefined) return silent(`you stopped ${personName} messaging ${agentName}`);
  const ranOut = asks.filter(
    (one) =>
      one.state === "pending" &&
      (one.closedAt !== null ||
        one.cardAt === null ||
        at - Date.parse(one.cardAt) >= KIN_CHOICE_CARD_TTL_MS),
  ).length;
  const waited = asks.filter((one) => one.state === "waited").length;
  const open = asks.filter((one) => one.state === "pending").length - ranOut;
  if (asks.length < ROUTE_ASKS || ranOut + waited < ROUTE_UNANSWERED)
    return silent(`${personName} hasn't been waiting on you for ${agentName} that often lately`);
  const fromIds = [...new Set(asks.map((one) => one.fromId))];
  const [from] =
    fromIds.length === 1
      ? yield* sql<{ name: string }>`SELECT name FROM kin_leads
          WHERE org_id = ${orgId} AND agent_id = ${fromIds[0]!}`
      : [];
  const since = formatKinWhen(asks[0]!.at, "date", { zone: ctx.zone, locale: ctx.locale });
  const facts = sentence([
    ...(ranOut > 0 ? [`${word(ranOut)} of your cards on it ran out before you answered`] : []),
    ...(waited > 0
      ? [`${times(waited, "request", "requests")} waited on a card you hadn't answered yet`]
      : []),
    ...(open > 0
      ? [`${times(open, "card", "cards")} on it ${open === 1 ? "is" : "are"} waiting now`]
      : []),
  ]);
  const noticed = `${personName} asked ${from?.name ?? "your agents"} for ${agentName}'s work ${asks.length} times since ${since}. ${facts.charAt(0).toUpperCase()}${facts.slice(1)}`;
  return {
    _tag: "fires",
    candidate: {
      rule: ROUTE_ACCESS,
      subject,
      weight: asks.length,
      noticed,
      ask: `Let ${personName} message ${agentName} directly?`,
      gives: `${personName} could then ask ${agentName} without waiting for you. ${agentName} talks and drafts for ${personName}, and starting work stays yours to ask for.`,
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

/** Whether a done change still stands as Do it left it: the person's own grant is live. */
export const inEffect = Effect.fn("KinRecommendRules.inEffect")(function* (
  orgId: KinOrgId,
  change: RecommendChange,
) {
  return yield* LeadAccess.granted({
    orgId,
    agentId: KinAgentId.make(change.agentId),
    personId: KinPersonId.make(change.personId),
  });
});

/** Rules in rank order: the first that fires speaks. */
export const RULES = [routeAccess] as const;
