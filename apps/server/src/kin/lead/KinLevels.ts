// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 for shadow entry ids.
import * as NodeCrypto from "node:crypto";

import {
  KinActionTarget,
  KinLevel,
  type KinActionId,
  type KinAgentId,
  type KinChatId,
  type KinOrgId,
  type ThreadId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";

// Approvals import this module, so it must not reach the chat service or the judge.

const ORDER: ReadonlyArray<KinLevel> = ["L0", "L1", "L2", "L3"];
export const atLeast = (level: KinLevel, required: KinLevel) =>
  ORDER.indexOf(level) >= ORDER.indexOf(required);

const nextLevel = (level: KinLevel): KinLevel | undefined => ORDER[ORDER.indexOf(level) + 1];
export const previousLevel = (level: KinLevel): KinLevel | undefined =>
  ORDER[ORDER.indexOf(level) - 1];

export class KinLevelRefused extends Schema.TaggedError<KinLevelRefused>()("KinLevelRefused", {
  reason: Schema.Literals([
    "not_a_lead",
    "not_running",
    "conflict",
    "limit",
    "not_found",
    // Lowering must go down, raising must go up one step (or a chat up to the lead's level).
    "invalid_level",
    "not_eligible",
    // No claimed, owner-granted `set_level` action backs the raise.
    "not_granted",
  ]),
}) {}

/** Bounds what one wake-up can put in the owner's review, whatever keys the lead picks. */
export const MAX_SHADOW_ENTRIES_PER_WAKEUP = 50;
export const SHADOW_LIMIT_MESSAGE = `This wake-up already recorded ${MAX_SHADOW_ENTRIES_PER_WAKEUP} entries for the owner's review. Stop here; the owner sees them in the daily summary.`;

const decodeLevel = Schema.decodeUnknownEffect(KinLevel);

/**
 * `min(lead.level, chat.level)` for a chat target, the lead's level otherwise (lead spec, Levels).
 * Read from `kin_leads` and `kin_chat_levels` only; no tool input or model text is consulted.
 */
export const effectiveLevel = Effect.fn("KinLevels.effectiveLevel")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId?: KinChatId | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ level: string; chatLevel: string | null }>`
    SELECT l.level, c.level AS "chatLevel" FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    LEFT JOIN kin_chat_levels c ON c.org_id = l.org_id AND c.agent_id = l.agent_id
      AND c.chat_id = ${input.chatId ?? null}
    WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinLevels.effectiveLevel")));
  if (row === undefined) return yield* new KinLevelRefused({ reason: "not_a_lead" });
  const decode = (value: unknown) =>
    decodeLevel(value).pipe(Effect.mapError(toPersistenceDecodeError("KinLevels.effectiveLevel")));
  const lead = yield* decode(row.level);
  if (row.chatLevel === null) return lead;
  const chat = yield* decode(row.chatLevel);
  return atLeast(chat, lead) ? lead : chat;
});

/**
 * Records a new lead at L0, the only level a lead starts at. The owner chat must be a direct chat
 * in the same org. False when the agent already has a lead row.
 */
export const insertLeadAtL0 = Effect.fn("KinLevels.insertLeadAtL0")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly since: number;
  readonly modelsJson: string;
  readonly workerProjectsJson: string;
  readonly ownerChatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const inserted = yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since,
      models_json, worker_projects_json, owner_chat_id)
    SELECT ${input.agentId}, ${input.orgId}, ${input.name}, 'L0', ${input.since}, ${input.modelsJson},
      ${input.workerProjectsJson}, c.chat_id
    FROM kin_chats c WHERE c.org_id = ${input.orgId} AND c.chat_id = ${input.ownerChatId} AND c.kind = 'direct'
    ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLevels.insertLeadAtL0")),
  );
  return inserted.length > 0;
});

export interface ShadowEntry {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  /** The server-resolved caller thread; the entry joins the running wake-up on it. */
  readonly threadId: ThreadId;
  readonly level: KinLevel;
  readonly unlocksLevel: Exclude<KinLevel, "L0">;
  readonly tool: string;
  /** What makes two calls the same entry; the whole input when absent. */
  readonly key?: unknown;
  readonly input: unknown;
  readonly wouldTarget: string;
}

/**
 * Records what the lead would have done instead of doing it. One entry per wake-up, tool and
 * key: an identical retry returns the same entry, a different input under the same key fails.
 * `admit` runs only for a new entry, inside the write, so a retry is never refused by it.
 */
export const recordShadow = Effect.fn("KinLevels.recordShadow")(function* <E = never, R = never>(
  entry: ShadowEntry,
  admit: Effect.Effect<void, E, R> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const query = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError("KinLevels.recordShadow")));
  const json = stableStringify(entry.input);
  // True for an identical stored entry; a different one under the same key is a conflict.
  const stored = Effect.fn("KinLevels.storedShadow")(function* (entryId: string) {
    const [row] = yield* query(sql<{ json: string; tool: string }>`
      SELECT input_json AS json, tool FROM kin_shadow_entries
      WHERE org_id = ${entry.orgId} AND entry_id = ${entryId} ORDER BY entry_id`);
    if (row === undefined) return false;
    if (row.json !== json || row.tool !== entry.tool)
      return yield* new KinLevelRefused({ reason: "conflict" });
    return true;
  });
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const [wakeup] = yield* query(sql<{ wakeupId: string; startedAt: number }>`
        SELECT w.wakeup_id AS "wakeupId", w.started_at AS "startedAt" FROM kin_wakeups w
        JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE w.org_id = ${entry.orgId} AND w.agent_id = ${entry.agentId}
          AND w.thread_id = ${entry.threadId} AND w.status = 'running'
          AND a.role = 'lead' AND a.retired_at IS NULL
        ORDER BY w.wakeup_id`);
        if (wakeup === undefined) return yield* new KinLevelRefused({ reason: "not_running" });
        const digest = NodeCrypto.createHash("sha256")
          .update(
            stableStringify({
              wakeupId: wakeup.wakeupId,
              tool: entry.tool,
              input: entry.key ?? entry.input,
            }),
          )
          .digest("hex");
        const entryId = `shadow-${digest.slice(0, 32)}`;
        if (yield* stored(entryId)) return { shadowed: true as const, entryId, created: false };
        yield* admit;
        // created_at bounds the scan to this wake-up on the (org, agent, created_at) index.
        const [count] = yield* query(sql<{ n: number }>`
        SELECT COUNT(*) AS n FROM kin_shadow_entries
        WHERE org_id = ${entry.orgId} AND agent_id = ${entry.agentId}
          AND created_at >= ${wakeup.startedAt} AND wakeup_id = ${wakeup.wakeupId}
        ORDER BY n`);
        if ((count?.n ?? 0) >= MAX_SHADOW_ENTRIES_PER_WAKEUP)
          return yield* new KinLevelRefused({ reason: "limit" });
        const inserted = yield* query(sql`INSERT INTO kin_shadow_entries
        (entry_id, org_id, agent_id, wakeup_id, level, unlocks_level, tool, input_json, would_target, created_at)
        VALUES (${entryId}, ${entry.orgId}, ${entry.agentId}, ${wakeup.wakeupId}, ${entry.level},
          ${entry.unlocksLevel}, ${entry.tool}, ${json}, ${entry.wouldTarget},
          ${yield* Clock.currentTimeMillis})
        ON CONFLICT DO NOTHING RETURNING entry_id`);
        // Lost a race with an identical write: the stored row decides, as for a retry.
        if (inserted.length === 0 && !(yield* stored(entryId)))
          return yield* new KinLevelRefused({ reason: "conflict" });
        return { shadowed: true as const, entryId, created: inserted.length > 0 };
      }),
    )
    .pipe(
      // Statements map their own errors; this catches the transaction's begin and commit.
      Effect.mapError((error) =>
        SqlError.isSqlError(error) ? toPersistenceSqlError("KinLevels.recordShadow")(error) : error,
      ),
    );
});

/**
 * Refreshes the owner's "would have done today" card. Supplied per call by the Kin services, so
 * modules that must stay clear of the chat service (approvals) can still trigger it.
 */
export class KinShadowSummary extends Context.Service<
  KinShadowSummary,
  {
    readonly refresh: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/lead/KinLevels/KinShadowSummary") {}

/** Refreshes the summary when the caller runs with Kin services; a new entry is otherwise kept. */
export const refreshSummary = Effect.fn("KinLevels.refreshSummary")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const summary = yield* Effect.serviceOption(KinShadowSummary);
  if (summary._tag === "Some") yield* summary.value.refresh(input);
});

const DAY_MS = 86_400_000;
/** Lead spec, "Level promotion": thresholds for moving from level N to N+1. */
const promotionRule = { minDays: 7, minReviewed: 20, minFineShare: 0.8 } as const;

const query =
  (operation: string) =>
  <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));
const decode = (operation: string) => (value: unknown) =>
  decodeLevel(value).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
// Statements map their own errors; this catches a transaction's begin and commit.
const inTransaction =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error) =>
            SqlError.isSqlError(error) ? toPersistenceSqlError(operation)(error) : error,
          ),
        );
    });

const activeLead = Effect.fn("KinLevels.activeLead")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* query("KinLevels.activeLead")(sql<{
    level: string;
    since: number;
    owner: string;
  }>`SELECT l.level, l.level_since AS since, a.owner_person_id AS owner FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY l.agent_id`);
  if (row === undefined) return yield* new KinLevelRefused({ reason: "not_a_lead" });
  return {
    level: yield* decode("KinLevels.activeLead")(row.level),
    since: row.since,
    owner: row.owner,
  };
});

/** The chat's stored cap, or undefined; the chat must be one the lead is an active member of. */
const chatCap = Effect.fn("KinLevels.chatCap")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [chat] = yield* query("KinLevels.chatCap")(sql<{ level: string | null }>`
    SELECT c.level FROM kin_chat_members m
    LEFT JOIN kin_chat_levels c ON c.org_id = m.org_id AND c.agent_id = m.agent_id
      AND c.chat_id = m.chat_id
    WHERE m.org_id = ${input.orgId} AND m.chat_id = ${input.chatId}
      AND m.agent_id = ${input.agentId} AND m.left_at IS NULL
    ORDER BY m.chat_id`);
  if (chat === undefined) return yield* new KinLevelRefused({ reason: "not_found" });
  return chat.level === null ? undefined : yield* decode("KinLevels.chatCap")(chat.level);
});

/** Review counts for the lead's trial at its current level, counted since it reached it. */
export const promotionStats = Effect.fn("KinLevels.promotionStats")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const lead = yield* activeLead(input);
  const to = nextLevel(lead.level) ?? null;
  const rows =
    to === null
      ? []
      : yield* query("KinLevels.promotionStats")(sql<{ verdict: string | null; n: number }>`
        SELECT verdict, COUNT(*) AS n FROM kin_shadow_entries
        WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId}
          AND unlocks_level = ${to} AND created_at >= ${lead.since}
        GROUP BY verdict ORDER BY verdict`);
  const count = (verdict: string | null) => rows.find((row) => row.verdict === verdict)?.n ?? 0;
  const unreviewed = count(null);
  const reviewed = rows.reduce((sum, row) => sum + row.n, 0) - unreviewed;
  const fine = count("fine");
  const harmful = count("harmful");
  const daysAtLevel = Math.max(
    0,
    Math.floor(((yield* Clock.currentTimeMillis) - lead.since) / DAY_MS),
  );
  const rule = promotionRule;
  return {
    from: lead.level,
    to,
    daysAtLevel,
    reviewed,
    fine,
    harmful,
    unreviewed,
    // Integer percentages, so 16 of 20 meets 80% exactly. Every entry in the trial is reviewed.
    eligible:
      to !== null &&
      daysAtLevel >= rule.minDays &&
      reviewed >= rule.minReviewed &&
      fine * 100 >= reviewed * Math.round(rule.minFineShare * 100) &&
      harmful === 0 &&
      unreviewed === 0,
    rule,
    levelSince: lead.since,
  };
});

/**
 * Lowers the lead's level, or one chat's cap, at once and without a grant (lead spec, Levels).
 * Callers are the owner's RPC and the server's automatic demotion only.
 */
export const lower = Effect.fn("KinLevels.lower")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId?: KinChatId | undefined;
  readonly level: KinLevel;
}) {
  const sql = yield* SqlClient.SqlClient;
  const run = query("KinLevels.lower");
  return yield* inTransaction("KinLevels.lower")(
    Effect.gen(function* () {
      const lead = yield* activeLead(input);
      const now = yield* Clock.currentTimeMillis;
      if (input.chatId === undefined) {
        if (atLeast(input.level, lead.level))
          return yield* new KinLevelRefused({ reason: "invalid_level" });
        const updated = yield* run(sql`UPDATE kin_leads SET level = ${input.level},
            level_since = ${now}
          WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND level = ${lead.level}
          RETURNING agent_id`);
        if (updated.length === 0) return yield* new KinLevelRefused({ reason: "conflict" });
        return { from: lead.level, to: input.level };
      }
      const chatId = input.chatId;
      const cap = yield* chatCap({ ...input, chatId });
      const current = cap === undefined || atLeast(cap, lead.level) ? lead.level : cap;
      if (atLeast(input.level, current))
        return yield* new KinLevelRefused({ reason: "invalid_level" });
      const inserted = yield* run(sql`INSERT INTO kin_chat_levels
          (org_id, agent_id, chat_id, level, level_since)
        VALUES (${input.orgId}, ${input.agentId}, ${chatId}, ${input.level}, ${now})
        ON CONFLICT DO NOTHING RETURNING chat_id`);
      if (inserted.length === 0) {
        const updated = yield* run(sql`UPDATE kin_chat_levels SET level = ${input.level},
            level_since = ${now}
          WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND chat_id = ${chatId}
            AND level = ${cap ?? null}
          RETURNING chat_id`);
        if (updated.length === 0) return yield* new KinLevelRefused({ reason: "conflict" });
      }
      return { from: current, to: input.level };
    }),
  );
});

/**
 * Whether the owner may ask to raise: the lead one step up once eligible, or a chat's cap back up
 * to at most the lead's level. Raising always needs the owner's grant on top.
 */
export const checkRaise = Effect.fn("KinLevels.checkRaise")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId?: KinChatId | undefined;
  readonly level: KinLevel;
}) {
  const lead = yield* activeLead(input);
  if (input.chatId === undefined) {
    if (nextLevel(lead.level) !== input.level)
      return yield* new KinLevelRefused({ reason: "invalid_level" });
    if (!(yield* promotionStats(input)).eligible)
      return yield* new KinLevelRefused({ reason: "not_eligible" });
    return { from: lead.level };
  }
  const cap = yield* chatCap({ ...input, chatId: input.chatId });
  const current = cap === undefined || atLeast(cap, lead.level) ? lead.level : cap;
  if (atLeast(current, input.level) || !atLeast(lead.level, input.level))
    return yield* new KinLevelRefused({ reason: "invalid_level" });
  return { from: current };
});

const decodeTarget = Schema.decodeUnknownEffect(Schema.fromJsonString(KinActionTarget));

/**
 * Applies an owner-granted `set_level` raise. Only the executor's handler calls it, for an action
 * it claimed: every write below also requires that claim, so no other path can raise a level.
 */
export const raiseByGrant = Effect.fn("KinLevels.raiseByGrant")(function* (input: {
  readonly orgId: KinOrgId;
  readonly actionId: KinActionId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const run = query("KinLevels.raiseByGrant");
  return yield* inTransaction("KinLevels.raiseByGrant")(
    Effect.gen(function* () {
      // Only what was requested; whether it may apply is decided by the guarded write below.
      const [action] = yield* run(sql<{ targetJson: string }>`
        SELECT target_json AS "targetJson" FROM kin_pending_actions
        WHERE org_id = ${input.orgId} AND action_id = ${input.actionId} AND kind = 'set_level'
        ORDER BY action_id`);
      if (action === undefined) return yield* new KinLevelRefused({ reason: "not_granted" });
      const target = yield* decodeTarget(action.targetJson).pipe(
        Effect.mapError(toPersistenceDecodeError("KinLevels.raiseByGrant")),
      );
      if (target._tag !== "level") return yield* new KinLevelRefused({ reason: "not_granted" });
      const ref = { orgId: input.orgId, agentId: target.agentId };
      const lead = yield* activeLead(ref);
      // This target, claimed (executing, one open execution) under a consumed grant that the
      // lead's own owner signed; another person's grant never applies.
      const claimed = sql`EXISTS (
        SELECT 1 FROM kin_pending_actions p
        JOIN kin_executions x ON x.org_id = p.org_id AND x.action_id = p.action_id
          AND x.finished_at IS NULL
        JOIN kin_grants g ON g.org_id = x.org_id AND g.grant_id = x.grant_id
          AND g.action_id = p.action_id AND g.revision = p.revision AND g.consumed_at IS NOT NULL
        WHERE p.org_id = ${input.orgId} AND p.action_id = ${input.actionId}
          AND p.kind = 'set_level' AND p.state = 'executing'
          AND p.target_json = ${action.targetJson} AND g.approver_human_id = ${lead.owner})`;
      const now = yield* Clock.currentTimeMillis;
      const { from } = yield* checkRaise({ ...ref, chatId: target.chatId, level: target.level });
      if (target.chatId === undefined) {
        const updated = yield* run(sql`UPDATE kin_leads SET level = ${target.level},
            level_since = ${now}
          WHERE org_id = ${input.orgId} AND agent_id = ${target.agentId}
            AND level = ${from} AND ${claimed}
          RETURNING agent_id`);
        if (updated.length === 0) return yield* new KinLevelRefused({ reason: "not_granted" });
        return { agentId: target.agentId, from, to: target.level };
      }
      // Back at the lead's level, the chat follows the lead again.
      const written =
        target.level === lead.level
          ? yield* run(sql`DELETE FROM kin_chat_levels
              WHERE org_id = ${input.orgId} AND agent_id = ${target.agentId}
                AND chat_id = ${target.chatId} AND ${claimed}
              RETURNING chat_id`)
          : yield* run(sql`UPDATE kin_chat_levels SET level = ${target.level},
                level_since = ${now}
              WHERE org_id = ${input.orgId} AND agent_id = ${target.agentId}
                AND chat_id = ${target.chatId} AND level = ${from} AND ${claimed}
              RETURNING chat_id`);
      if (written.length === 0) return yield* new KinLevelRefused({ reason: "not_granted" });
      return { agentId: target.agentId, from, to: target.level };
    }),
  );
});

/** Redraws the owner's promotion card; supplied by the Kin services like `KinShadowSummary`. */
export class KinPromotionCards extends Context.Service<
  KinPromotionCards,
  {
    readonly refresh: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/lead/KinLevels/KinPromotionCards") {}

/** Without Kin services the card is redrawn on the next review, evening or level change. */
export const refreshPromotion = Effect.fn("KinLevels.refreshPromotion")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}) {
  const cards = yield* Effect.serviceOption(KinPromotionCards);
  if (cards._tag === "Some") yield* cards.value.refresh(input);
});
