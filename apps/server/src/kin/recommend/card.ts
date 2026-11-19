import {
  KinAgentId,
  KinChatError,
  KinConnectionId,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { KinBudget } from "../lead/KinBudget.ts";
import * as LeadProvision from "../lead/KinLeadProvision.ts";
import { accessSql } from "../people/KinAccess.ts";
import type { RecommendPlan } from "../widgets/cardPlans.ts";
import { DECLINE_QUIET_MS, onlyOwner, ruleContext, storedRows } from "./ledger.ts";
import { type RecommendChange, agentNow, connectionNow, limitNow, ruleFor } from "./rules.ts";

const LABEL_MAX = 80;
const NOT_NOW = "Not now";
const LEFT_AS_IS = "You left it as it is. Settings, under Recommendations, can ask again.";

const labelled = (label: string, fallback: string) =>
  label.length <= LABEL_MAX ? label : fallback.slice(0, LABEL_MAX);

/** The verb on Do it, from the stored names. */
const doLabel = (change: RecommendChange) => {
  switch (change.kind) {
    case "lead_access":
      return labelled(
        `Give ${change.personName} direct access to ${change.agentName}`,
        `Give them direct access to ${change.agentName}`,
      );
    case "daily_limit":
      return labelled(`Raise to ${change.toName}`, "Raise the daily limit");
    case "connection_resume":
      return labelled(`Resume ${change.connectionName}`, "Resume the connection");
    case "agent_resume":
      return labelled(`Resume ${change.agentName}`, "Resume the agent");
  }
};
/** A done row's way to the agent's page, where who can message it is changed. */
export const agentPageLabel = (agentName: string) =>
  labelled(`Open ${agentName}'s page`, "Open the agent's page");
export const DAILY_LIMIT_LABEL = "Open Daily limit";
export const connectionLabel = (connectionName: string) =>
  labelled(`Open ${connectionName}`, "Open the connection");

/** A card that reached its time limit unanswered: what it says once it closes. */
export const RAN_OUT = {
  title: "Ran out",
  text: "This suggestion ran out before you answered, so nothing changed. Settings, under Recommendations, can ask again.",
};

const doLine = (change: RecommendChange) => {
  switch (change.kind) {
    case "lead_access":
      return `${change.personName} can message ${change.agentName} from now on; nothing is passed on now`;
    case "daily_limit":
      return `Raise the daily limit from ${change.fromName} to ${change.toName}`;
    case "connection_resume":
      return `Resume ${change.connectionName} now`;
    case "agent_resume":
      return `Resume ${change.agentName} now`;
  }
};

/** The card's button and the line under it, for each answer: written by Kin. */
export const recommendShown = (plan: Pick<RecommendPlan, "answer" | "change">) =>
  plan.answer === "not_now"
    ? { label: NOT_NOW, line: "Leave it as it is" }
    : { label: doLabel(plan.change), line: doLine(plan.change) };

const isChatError = Schema.is(KinChatError);
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

/**
 * What a tap may no longer mean, either answer: what the card is about is no longer as it said
 * (the person became owner-level, the limit or the pause moved), or its names no longer name it.
 */
const subjectMoved = Effect.fn("KinRecommendCard.subjectMoved")(function* (
  orgId: KinOrgId,
  change: RecommendChange,
) {
  const sql = yield* SqlClient.SqlClient;
  const renamed = "the names on this card have changed since Kin drew it";
  switch (change.kind) {
    case "lead_access": {
      const [person] = yield* sql<{ name: string; ownerLevel: number }>`SELECT
          p.display_name AS name, ${sql.literal(accessSql("p"))} IN ('owner', 'co_owner') AS "ownerLevel"
        FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${change.personId}`;
      const [agent] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
        WHERE org_id = ${orgId} AND agent_id = ${change.agentId}`;
      if (person?.ownerLevel === 1)
        return `${person.name} can already message ${agent?.name ?? change.agentName}`;
      return person?.name === change.personName && agent?.name === change.agentName
        ? null
        : renamed;
    }
    case "daily_limit": {
      const limit = yield* limitNow(orgId);
      if (limit.leadUnits === change.fromLeadUnits) return null;
      return limit.name === null
        ? "the daily limit was set to its own amount since Kin drew this card"
        : `the daily limit is now ${limit.name}`;
    }
    case "connection_resume": {
      const now = yield* connectionNow(orgId, change.connectionId);
      const name = now?.name ?? change.connectionName;
      if (now === undefined || now.removedAt !== null) return `${name} is no longer connected`;
      if (now.pausedAt === null) return `${name} isn't paused any more`;
      if (now.pausedAt !== change.pausedAt)
        return `${name} was resumed and paused again since Kin drew this card`;
      return now.name === change.connectionName ? null : renamed;
    }
    case "agent_resume": {
      const now = yield* agentNow(orgId, change.agentId);
      const name = now?.name ?? change.agentName;
      if (now === undefined || now.retired) return `${name} is no longer there`;
      if (now.pausedAt === null) return `${name} isn't paused any more`;
      if (now.pausedAt !== change.pausedAt)
        return `${name} was resumed and paused again since Kin drew this card`;
      return now.name === change.agentName ? null : renamed;
    }
  }
});

/** Whether the suggestion still holds for its subject now, or what is already true instead. */
const stillHolds = Effect.fn("KinRecommendCard.stillHolds")(function* (
  orgId: KinOrgId,
  ownerId: KinPersonId,
  at: number,
  plan: Pick<RecommendPlan, "rule" | "subject" | "change">,
) {
  const ctx = yield* ruleContext(orgId, ownerId, at);
  const asked = ruleFor(ctx, plan.change);
  if (asked.rule !== plan.rule) return "Kin no longer makes this suggestion";
  const verdict = (yield* asked.verdicts).find((one) =>
    one._tag === "fires" ? one.candidate.subject === plan.subject : one.subject === plan.subject,
  );
  if (verdict === undefined) return "it changed";
  return verdict._tag === "silent" ? verdict.reason : null;
});

/** The change itself, through the method the setting's own place calls, as the owner who tapped. */
const make = Effect.fn("KinRecommendCard.make")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  change: RecommendChange,
) {
  const people = [{ _tag: "person" as const, orgId, personId }];
  switch (change.kind) {
    case "lead_access":
      yield* LeadProvision.allow({
        editor: { _tag: "person", personId },
        orgId,
        agentId: KinAgentId.make(change.agentId),
        personId: KinPersonId.make(change.personId),
      });
      return `You gave ${change.personName} direct access to ${change.agentName}. ${change.agentName}'s page is where you change that.`;
    case "daily_limit":
      yield* (yield* KinBudget).set(people, {
        orgId,
        limits: { leadUnits: change.toLeadUnits, workerUnits: change.toWorkerUnits },
      });
      return `The daily limit is now ${change.toName}. Settings, under Company details, is where you change it.`;
    case "connection_resume":
      yield* (yield* KinConnections).update(people, {
        orgId,
        connectionId: KinConnectionId.make(change.connectionId),
        paused: false,
      });
      return `${change.connectionName} is running again. Settings, under Connections, is where you pause it.`;
    case "agent_resume":
      yield* LeadProvision.setPaused({
        by: { _tag: "person", personId },
        orgId,
        agentId: KinAgentId.make(change.agentId),
        paused: false,
      });
      return `${change.agentName} is running again. ${change.agentName}'s page is where you pause it.`;
  }
});

/**
 * The owner's tap on a suggestion, in the tap's transaction (`cardActions.ts` `run`). Only the
 * owner alone answers it, and only while it still means what it said. Do it asks the rule again
 * for its subject and, if it still holds, makes the same change the agent's page makes, as the
 * owner; otherwise nothing changes and no Not now is counted.
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
  const settle = Effect.fn("KinRecommendCard.settle")(function* (
    state: "done" | "declined" | "stale",
    quietUntil: number | null,
  ) {
    const settled = yield* sql`UPDATE kin_recommendations SET state = ${state},
        decided_at = ${now}, decided_by = ${tap.personId}, quiet_until = ${quietUntil}
      WHERE org_id = ${orgId} AND rec_id = ${row.recId} AND state = 'open'
      RETURNING rec_id`;
    if (settled.length === 0) return yield* unavailable();
    yield* (yield* KinRefreshObserver).touch(orgId, "recommendations");
  });
  const reason =
    (yield* subjectMoved(orgId, plan.change)) ??
    (plan.answer === "do" ? yield* stillHolds(orgId, tap.personId, now, plan) : null);
  if (reason !== null) {
    yield* settle("stale", null);
    return { title: "Nothing changed", text: `Nothing changed: ${reason}.` };
  }
  if (plan.answer === "not_now") {
    const [declined] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM kin_recommendations WHERE org_id = ${orgId} AND rule = ${row.rule}
        AND subject = ${row.subject} AND state = 'declined'`;
    const times = declined?.count ?? 0;
    const until = times < DECLINE_QUIET_MS.length ? now + DECLINE_QUIET_MS[times]! : null;
    yield* settle("declined", until);
    // The card stays in the chat as history: it says what the tap did, not what holds now.
    return { title: NOT_NOW, text: LEFT_AS_IS };
  }
  const text = yield* make(orgId, tap.personId, plan.change).pipe(
    Effect.mapError((error) =>
      isChatError(error)
        ? error
        : new KinChatError({ reason: "not_allowed", message: error.message }),
    ),
  );
  yield* settle("done", null);
  return { title: "Done", text };
});
