import {
  KIN_CHOICE_CARD_TTL_MS,
  KinAgentId,
  type KinOrgId,
  KinPersonId,
  formatKinWhen,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as LeadAccess from "../lead/LeadAccess.ts";
import { accessSql } from "../people/KinAccess.ts";
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

/** Whether the person's own access to the agent stands now, or it ended, or the agent is gone. */
export const grantNow = Effect.fn("KinRecommendRules.grantNow")(function* (
  orgId: KinOrgId,
  change: RecommendChange,
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

/** Rules in rank order: the first that fires speaks. */
export const RULES = [routeAccess] as const;
