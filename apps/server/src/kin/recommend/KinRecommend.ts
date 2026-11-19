import {
  KIN_CHOICE_CARD_TTL_MS,
  KinAgentId,
  KinChatError,
  KinConnectionId,
  KinOrgId,
  KinPersonId,
  type KinRecommendationRow,
  type KinRecommendationsResult,
  ThreadId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import * as KinOpen from "../open/KinOpen.ts";
import { personQuietUntil } from "../triggers/quietHold.ts";
import { type RecommendPlan, sealPlans } from "../widgets/cardPlans.ts";
import { dayIn } from "../work/money.ts";
import {
  DAILY_LIMIT_LABEL,
  RAN_OUT,
  agentPageLabel,
  connectionLabel,
  recommendShown,
} from "./card.ts";
import {
  type StoredRow,
  dayOf,
  encodeChange,
  isOwner,
  onlyOwner,
  quietAfter,
  ranOutAt,
  ruleContext,
  storedRows,
} from "./ledger.ts";
import {
  type Candidate,
  DAY_MS,
  RULES,
  type RecommendChange,
  type RuleContext,
  agentNow,
  connectionNow,
  grantNow,
  limitNow,
} from "./rules.ts";

/*
 * Kin's suggestions to the owner: the rules (`rules.ts`) over its own rows, at most one card a
 * day in the owner's chat with Chief of staff, and the Settings list of what came of each. Nothing
 * changes without the owner's tap, which runs `card.ts`. No agent reads or writes any of it.
 */

/** A company's first two weeks say nothing about its habits. */
const NEW_COMPANY_MS = 14 * DAY_MS;
/** More than this in Needs you and a suggestion would be one thing too many. */
const NEEDS_YOU_BUSY = 5;
const TICK_EVERY_MS = 60 * 60_000;
const LIST_CAP = 100;

const notFound = () =>
  new KinChatError({ reason: "not_found", message: "No such suggestion here." });

/** The org's owner and the lead whose chat with the owner the card goes in, if both are there. */
const seat = Effect.fn("KinRecommend.seat")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
  if (lead === undefined || !(yield* isOwner(orgId, lead.ownerPersonId))) return undefined;
  return { lead, ctx: yield* ruleContext(orgId, lead.ownerPersonId, at) };
});

/** A running wake-up's posts in its owner chat are counted against that turn's own allowance. */
const turnRunning = Effect.fn("KinRecommend.turnRunning")(function* (
  orgId: KinOrgId,
  agentId: string,
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [running] = yield* sql`SELECT 1 FROM kin_wakeups WHERE org_id = ${orgId}
    AND agent_id = ${agentId} AND thread_id = ${threadId} AND status = 'running' LIMIT 1`;
  return running !== undefined;
});

/** Every rule that fires now, less what is quiet or already asked, best first. Read-only. */
const sense = Effect.fn("KinRecommend.sense")(function* (ctx: RuleContext) {
  const fired: Array<{ readonly rank: number; readonly candidate: Candidate }> = [];
  for (const [rank, rule] of RULES.entries())
    for (const verdict of yield* rule(ctx)) {
      if (verdict._tag !== "fires") continue;
      const { candidate } = verdict;
      const [latest] = yield* storedRows(
        ctx.orgId,
        { rule: candidate.rule, subject: candidate.subject },
        1,
      );
      if (quietAfter(latest, ctx.at) === undefined) fired.push({ rank, candidate });
    }
  return fired
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        b.candidate.weight - a.candidate.weight ||
        (a.candidate.subject < b.candidate.subject ? -1 : 1),
    )
    .map((one) => one.candidate);
});

export type TickResult =
  | { readonly _tag: "posted"; readonly recId: string; readonly widgetId: KinWidgetId }
  | {
      readonly _tag: "skipped";
      readonly why:
        | "no_owner"
        | "new_company"
        | "paused"
        | "quiet_hours"
        | "card_open"
        | "posted_today"
        | "nothing"
        | "busy"
        | "turn_running";
    };

const skipped = (why: Extract<TickResult, { _tag: "skipped" }>["why"]): TickResult => ({
  _tag: "skipped",
  why,
});

/**
 * One pass for an org: the gates, cheapest first, then at most one card. The card is a silent
 * choice card Kin draws in the owner's chat with Chief of staff, so it waits in Needs you.
 */
export const tick = Effect.fn("KinRecommend.tick")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const found = yield* seat(orgId, at);
  if (found === undefined) return skipped("no_owner");
  const { lead, ctx } = found;
  const [org] = yield* sql<{ createdAt: string }>`SELECT created_at AS "createdAt"
    FROM kin_orgs WHERE org_id = ${orgId}`;
  if (org === undefined || at - Date.parse(org.createdAt) < NEW_COMPANY_MS)
    return skipped("new_company");
  if (yield* isOrgPaused(orgId)) return skipped("paused");
  if ((yield* personQuietUntil(orgId, ctx.ownerId, at)) !== undefined)
    return skipped("quiet_hours");
  const day = dayIn(at, ctx.zone);
  const latest = yield* storedRows(orgId, {}, LIST_CAP);
  if (latest.some((row) => row.state === "open" && ranOutAt(row, at) === undefined))
    return skipped("card_open");
  if (latest.some((row) => dayIn(row.postedAt, ctx.zone) === day)) return skipped("posted_today");
  const [thread] = yield* sql<{ threadId: string }>`SELECT thread_id AS "threadId"
    FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${lead.agentId}
      AND thread_id IS NOT NULL`;
  if (thread === undefined) return skipped("no_owner");
  const [best] = yield* sense(ctx);
  if (best === undefined) return skipped("nothing");
  // Retried every sweep while busy: checked before Needs you is read, and again as it posts.
  if (yield* turnRunning(orgId, lead.agentId, thread.threadId)) return skipped("turn_running");
  const open = yield* KinOpen.compute({
    orgId,
    viewer: { personId: ctx.ownerId, ownerLevel: true },
    at,
  });
  if (open.counts.needsYou > NEEDS_YOU_BUSY) return skipped("busy");
  const recId = `rec-${NodeCrypto.createHash("sha256").update(`${best.rule}\0${best.subject}\0${day}`).digest("hex").slice(0, 32)}`;
  const plans = (["do", "not_now"] as const).map(
    (answer) =>
      ({
        kind: "recommend",
        answer,
        recId,
        rule: best.rule,
        subject: best.subject,
        change: best.change,
      }) satisfies RecommendPlan,
  );
  const shown = plans.map(recommendShown);
  const chat = yield* KinChatService;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (yield* turnRunning(orgId, lead.agentId, thread.threadId)) return skipped("turn_running");
      const card = yield* chat.ask(
        {
          _tag: "agent",
          hostPosted: true,
          orgId,
          agentId: lead.agentId,
          ownerPersonId: lead.ownerPersonId,
          threadId: ThreadId.make(thread.threadId),
        },
        {
          chatId: lead.ownerChatId,
          clientMessageId: `kin-recommend:${recId}`,
          question: best.ask.slice(0, 240),
          detail: `${best.noticed} ${best.gives}`.slice(0, 1500),
          options: shown.map((one) => ({ label: one.label })),
          actions: shown,
          silent: true,
        },
      );
      yield* sealPlans({
        orgId,
        chatId: lead.ownerChatId,
        widgetId: card.widgetId,
        plans: plans.map((plan, index) => ({ optionId: `option-${index + 1}`, plan })),
        now: at,
      });
      const stored = yield* sql`INSERT INTO kin_recommendations (org_id, rec_id, rule, subject,
          widget_id, change_json, noticed, state, posted_at)
        VALUES (${orgId}, ${recId}, ${best.rule}, ${best.subject}, ${card.widgetId},
          ${yield* encodeChange(best.change)}, ${best.noticed}, 'open', ${at})
        ON CONFLICT (org_id, rec_id) DO NOTHING RETURNING rec_id`;
      // A retried pass the same day found its card and row already there: nothing new.
      if (stored.length === 0) return skipped("posted_today");
      yield* (yield* KinRefreshObserver).touch(orgId, "recommendations");
      return { _tag: "posted", recId, widgetId: card.widgetId } satisfies TickResult;
    }),
  );
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** One Settings row: what Kin noticed, what came of it, and its one button. */
const rowOf = Effect.fn("KinRecommend.rowOf")(function* (ctx: RuleContext, row: StoredRow) {
  const { at } = ctx;
  const decided = row.decidedAt === null ? "" : dayOf(ctx, row.decidedAt);
  const askAgain = { kind: "ask_again" as const, label: "Ask again" };
  const shown = (outcome: string, action: KinRecommendationRow["action"] = null) =>
    ({
      recId: row.recId,
      rule: row.rule,
      noticed: `Noticed ${dayOf(ctx, row.postedAt)}: ${row.noticed}`,
      outcome,
      postedAt: iso(row.postedAt),
      decidedAt: row.decidedAt === null ? null : iso(row.decidedAt),
      action,
    }) satisfies KinRecommendationRow;
  const quiet = quietAfter(row, at);
  switch (row.state) {
    case "open": {
      if (ranOutAt(row, at) === undefined) return shown("Waiting in Needs you.");
      return typeof quiet === "number"
        ? shown(`Not answered. Kin may suggest it again after ${dayOf(ctx, quiet)}.`, askAgain)
        : shown("Not answered. Kin may suggest it again.");
    }
    case "declined":
      return quiet === null
        ? shown(`Not now on ${decided}. Kin won't suggest this again.`, askAgain)
        : quiet === undefined
          ? shown(`Not now on ${decided}. Kin may suggest it again.`)
          : shown(
              `Not now on ${decided}. Kin won't suggest this before ${dayOf(ctx, quiet)}.`,
              askAgain,
            );
    case "stale":
      return shown(`Nothing changed on ${decided}: it no longer applied when you tapped.`);
    case "done":
      return row.change === undefined
        ? shown(`Done ${decided}.`)
        : yield* doneNow(ctx.orgId, decided, row.change, shown);
  }
});

/** A done row, read from what is true now; its one action opens where that setting lives. */
const doneNow = Effect.fn("KinRecommend.doneNow")(function* (
  orgId: KinOrgId,
  decided: string,
  change: RecommendChange,
  shown: (outcome: string, action?: KinRecommendationRow["action"]) => KinRecommendationRow,
) {
  switch (change.kind) {
    case "lead_access": {
      const { personName: person, agentName: agent } = change;
      // Who can message an agent is changed in one place, its page; the row only points there.
      switch (yield* grantNow(orgId, change)) {
        case "gone":
          return shown(`Done ${decided}. ${agent} is no longer there.`);
        case "ended":
          return shown(`Done ${decided}. ${person}'s own access to ${agent} was removed since.`);
        case "live":
          return shown(`Done ${decided}: ${person} can message ${agent}.`, {
            kind: "open_agent",
            label: agentPageLabel(agent),
            agentId: KinAgentId.make(change.agentId),
          });
      }
    }
    case "daily_limit": {
      const limit = yield* limitNow(orgId);
      const open = { kind: "open_daily_limit" as const, label: DAILY_LIMIT_LABEL };
      if (limit.leadUnits === change.toLeadUnits && limit.workerUnits === change.toWorkerUnits)
        return shown(`Done ${decided}: the daily limit is ${change.toName}.`, open);
      return shown(
        limit.name === null
          ? `Done ${decided}: the daily limit went to ${change.toName}. It has its own amount now.`
          : `Done ${decided}: the daily limit went to ${change.toName}. It is ${limit.name} now.`,
        open,
      );
    }
    case "connection_resume": {
      const now = yield* connectionNow(orgId, change.connectionId);
      const name = now?.name ?? change.connectionName;
      if (now === undefined || now.removedAt !== null)
        return shown(`Done ${decided}. ${name} is no longer connected.`);
      const open = {
        kind: "open_connection" as const,
        label: connectionLabel(name),
        connectionId: KinConnectionId.make(change.connectionId),
      };
      if (now.pausedAt !== null)
        return shown(`Done ${decided}. ${name} was paused again since.`, open);
      return shown(
        now.state === "needs_sign_in"
          ? `Done ${decided}: ${name} was resumed. It needs signing in again now.`
          : `Done ${decided}: ${name} is no longer paused.`,
        open,
      );
    }
    case "agent_resume": {
      const now = yield* agentNow(orgId, change.agentId);
      const name = now?.name ?? change.agentName;
      if (now === undefined || now.retired)
        return shown(`Done ${decided}. ${name} is no longer there.`);
      const open = {
        kind: "open_agent" as const,
        label: agentPageLabel(name),
        agentId: KinAgentId.make(change.agentId),
      };
      return shown(
        now.pausedAt === null
          ? `Done ${decided}: ${name} is no longer paused.`
          : `Done ${decided}. ${name} was paused again since.`,
        open,
      );
    }
  }
});

/** Settings → Company → Recommendations: the owner's own list, newest first. */
export const list = Effect.fn("KinRecommend.list")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const at = yield* Clock.currentTimeMillis;
  yield* onlyOwner(orgId, personId);
  const ctx = yield* ruleContext(orgId, personId, at);
  const rows: Array<KinRecommendationRow> = [];
  for (const row of yield* storedRows(orgId, {}, LIST_CAP)) rows.push(yield* rowOf(ctx, row));
  return { rows } satisfies KinRecommendationsResult;
});

/** Ask again on a quieted suggestion: its rule may speak for that subject from now. */
export const askAgain = Effect.fn("KinRecommend.askAgain")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  recId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwner(orgId, personId);
      const [row] = yield* storedRows(orgId, { recId }, 1);
      if (row === undefined) return yield* notFound();
      const quieted =
        (row.state === "declined" || (row.state === "open" && ranOutAt(row, at) !== undefined)) &&
        quietAfter(row, at) !== undefined;
      if (!quieted)
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Kin may already suggest this again.",
        });
      yield* sql`UPDATE kin_recommendations SET quiet_until = ${at}
        WHERE org_id = ${orgId} AND rec_id = ${row.recId}`;
      yield* (yield* KinRefreshObserver).touch(orgId, "recommendations");
    }),
  );
  return yield* list(orgId, personId);
});

/**
 * Every sweep: an unanswered card past its time limit closes saying so, which settles its row in
 * Needs you then, not at the next hourly pass.
 */
export const closeRanOut = Effect.fn("KinRecommend.closeRanOut")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  // Every org's open cards at once: at most one per org is open, by the tick's own gate.
  const due = yield* sql<{ orgId: string; widgetId: string }>`SELECT r.org_id AS "orgId",
      r.widget_id AS "widgetId" FROM kin_recommendations r
    WHERE r.state = 'open' AND r.ended_at IS NULL
      AND r.posted_at <= ${now - KIN_CHOICE_CARD_TTL_MS}
      AND EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = r.org_id
        AND w.widget_id = r.widget_id AND w.closed_at IS NULL)
    ORDER BY r.posted_at, r.org_id, r.rec_id`.pipe(NodeSqliteClient.readOnly);
  const refresh = yield* KinRefreshObserver;
  for (const one of due) {
    const orgId = KinOrgId.make(one.orgId);
    yield* chat.closeReplaced({
      orgId,
      widgetId: KinWidgetId.make(one.widgetId),
      outcome: RAN_OUT,
    });
    yield* refresh.touch(orgId, "recommendations");
  }
});

/**
 * Hourly per org, on the shared scheduler beside the pulse. A pass held back by the Chief of
 * staff's running turn tries again at the next sweep, so a busy day delays the card by minutes.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ticks = yield* Scheduler.Scheduler;
    const refresh = yield* KinRefreshObserver;
    const chats = yield* Effect.serviceOption(KinChatService);
    if (Option.isNone(chats)) return;
    const last = new Map<string, number>();
    yield* ticks.register(
      "kin-recommend",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* closeRanOut(now).pipe(
          Effect.provideService(KinChatService, chats.value),
          Effect.provideService(KinRefreshObserver, refresh),
          Effect.catch((cause) =>
            Effect.logWarning("Kin recommendation time-out failed", { cause }),
          ),
        );
        // Scheduler maintenance scans organizations; each pass below is org-scoped.
        const orgs = yield* sql<{ orgId: string }>`SELECT org_id AS "orgId" FROM kin_orgs
          ORDER BY org_id`.pipe(NodeSqliteClient.readOnly);
        for (const { orgId } of orgs) {
          if (now - (last.get(orgId) ?? -Infinity) < TICK_EVERY_MS) continue;
          last.set(orgId, now);
          const result = yield* tick(KinOrgId.make(orgId), now).pipe(
            Effect.provideService(KinChatService, chats.value),
            Effect.provideService(KinRefreshObserver, refresh),
            Effect.catch((cause) =>
              Effect.logWarning("Kin recommendation failed", { orgId, cause }),
            ),
          );
          if (result?._tag === "skipped" && result.why === "turn_running") last.delete(orgId);
        }
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin recommendation scan failed", { cause })),
      ),
    );
  }),
);
