import { KinAgentId, KinChatError, type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as LeadProvision from "../lead/KinLeadProvision.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { DECLINE_QUIET_MS, dayOf, onlyOwner, ruleContext, storedRows } from "./ledger.ts";
import { ROUTE_ACCESS, type RecommendChange, routeAccess } from "./rules.ts";

const LABEL_MAX = 80;
const NOT_NOW = "Not now";

/** The verb on Do it, from the stored names. */
const doLabel = (change: RecommendChange) => {
  const label = `Let ${change.personName} message ${change.agentName}`;
  return label.length <= LABEL_MAX
    ? label
    : `Let them message ${change.agentName}`.slice(0, LABEL_MAX);
};
/**
 * Settings' Undo, from the stored names. With another way in (the team agent, a shared group)
 * it removes only their own access, so it never says they stop messaging the agent.
 */
export const undoLabel = (change: RecommendChange, otherWay: boolean) => {
  const label = otherWay
    ? `Remove ${change.personName}'s own access to ${change.agentName}`
    : `Stop ${change.personName} messaging ${change.agentName}`;
  if (label.length <= LABEL_MAX) return label;
  return (
    otherWay
      ? `Remove their own access to ${change.agentName}`
      : `Stop them messaging ${change.agentName}`
  ).slice(0, LABEL_MAX);
};

/** A card that reached its time limit unanswered: what it says once it closes. */
export const RAN_OUT = {
  title: "Ran out",
  text: "This suggestion ran out before you answered, so nothing changed. Settings, under Recommendations, can ask again.",
};

/** The card's button and the line under it, for each answer: written by Kin. */
export const recommendShown = (plan: Pick<RecommendPlan, "answer" | "change">) =>
  plan.answer === "not_now"
    ? { label: NOT_NOW, line: "Leave it as it is" }
    : {
        label: doLabel(plan.change),
        line: `Let ${plan.change.personName} message ${plan.change.agentName} from now on`,
      };

const isChatError = Schema.is(KinChatError);
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

/** Whether the suggestion still holds for its subject now, or what is already true instead. */
const stillHolds = Effect.fn("KinRecommendCard.stillHolds")(function* (
  orgId: KinOrgId,
  ownerId: KinPersonId,
  at: number,
  plan: Pick<RecommendPlan, "rule" | "subject" | "change">,
) {
  const ctx = yield* ruleContext(orgId, ownerId, at);
  if (plan.rule !== ROUTE_ACCESS) return "Kin no longer makes this suggestion";
  const verdicts = yield* routeAccess(ctx, plan.change);
  const verdict = verdicts.find((one) =>
    one._tag === "fires" ? one.candidate.subject === plan.subject : one.subject === plan.subject,
  );
  if (verdict === undefined) return "it changed";
  if (verdict._tag === "silent") return verdict.reason;
  // The words the owner agreed to must still name who and what the write changes.
  const now = verdict.candidate.change;
  return now.personName === plan.change.personName && now.agentName === plan.change.agentName
    ? null
    : "the names on this card have changed since Kin drew it";
});

/**
 * The owner's tap on a suggestion, in the tap's transaction (`cardActions.ts` `run`). Only the
 * owner alone answers it. Do it asks the rule again for its subject and, if it still holds,
 * makes the same change the Settings control makes, as the owner; otherwise nothing changes.
 */
export const runRecommend = Effect.fn("KinRecommendCard.run")(function* (
  tap: {
    readonly orgId: KinOrgId;
    readonly widget: { readonly widgetId: string };
    readonly personId: KinPersonId;
    readonly now: number;
  },
  plan: RecommendPlan,
) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, now } = tap;
  yield* onlyOwner(orgId, tap.personId);
  const [row] = yield* storedRows(orgId, { recId: plan.recId }, 1);
  if (
    row === undefined ||
    row.widgetId !== tap.widget.widgetId ||
    row.rule !== plan.rule ||
    row.subject !== plan.subject
  )
    return { title: "Nothing changed", text: "This suggestion is no longer here." };
  if (row.state !== "open") return { title: "Nothing changed", text: "This was already answered." };
  const settle = (
    state: "done" | "declined" | "stale",
    quietUntil: number | null,
    grantedAt: number | null = null,
  ) =>
    sql`UPDATE kin_recommendations SET state = ${state}, decided_at = ${now},
        decided_by = ${tap.personId}, quiet_until = ${quietUntil}, granted_at = ${grantedAt}
      WHERE org_id = ${orgId} AND rec_id = ${row.recId} AND state = 'open'
      RETURNING rec_id`;
  const ctx = yield* ruleContext(orgId, tap.personId, now);
  if (plan.answer === "not_now") {
    const [declined] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM kin_recommendations WHERE org_id = ${orgId} AND rule = ${row.rule}
        AND subject = ${row.subject} AND state = 'declined'`;
    const times = declined?.count ?? 0;
    const until = times < DECLINE_QUIET_MS.length ? now + DECLINE_QUIET_MS[times]! : null;
    if ((yield* settle("declined", until)).length === 0) return yield* unavailable();
    return {
      title: NOT_NOW,
      text:
        until === null
          ? "Kin won't suggest this again. Settings, under Recommendations, can ask again."
          : `Kin won't suggest this before ${dayOf(ctx, until)}.`,
    };
  }
  const reason = yield* stillHolds(orgId, tap.personId, now, plan);
  if (reason !== null) {
    if ((yield* settle("stale", null)).length === 0) return yield* unavailable();
    return { title: "Nothing changed", text: `Nothing changed: ${reason}.` };
  }
  const { change } = plan;
  yield* LeadProvision.allow({
    editor: { _tag: "person", personId: tap.personId },
    orgId,
    agentId: KinAgentId.make(change.agentId),
    personId: KinPersonId.make(change.personId),
  }).pipe(
    Effect.mapError((error) =>
      isChatError(error)
        ? error
        : new KinChatError({ reason: "not_allowed", message: error.message }),
    ),
  );
  // The grant this Let made, as stored: Undo takes back this one and no later one.
  const [grant] = yield* sql<{ grantedAt: number }>`SELECT granted_at AS "grantedAt"
    FROM kin_lead_access WHERE org_id = ${orgId} AND agent_id = ${change.agentId}
      AND person_id = ${change.personId} AND revoked_at IS NULL`;
  if (grant === undefined) return yield* unavailable();
  if ((yield* settle("done", null, grant.grantedAt)).length === 0) return yield* unavailable();
  return {
    title: "Done",
    text: `${change.personName} may message ${change.agentName} from now on. Settings, under Recommendations, can undo it.`,
  };
});
