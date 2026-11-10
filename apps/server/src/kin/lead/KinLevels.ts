import {
  KinActionTarget,
  KinLevel,
  type KinActionId,
  type KinAgentId,
  KinChatId,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";

// Approvals import this module, so it must not reach the chat service.

const ORDER: ReadonlyArray<KinLevel> = ["L0", "L1", "L2", "L3"];
export const atLeast = (level: KinLevel, required: KinLevel) =>
  ORDER.indexOf(level) >= ORDER.indexOf(required);

export class KinLevelRefused extends Schema.TaggedError<KinLevelRefused>()("KinLevelRefused", {
  reason: Schema.Literals([
    "not_a_lead",
    "conflict",
    "not_found",
    // Lowering must go down, raising must go up (a chat at most to its base).
    "invalid_level",
    // No claimed, owner-granted `set_level` action backs the raise.
    "not_granted",
  ]),
}) {}

const decodeLevel = Schema.decodeUnknownEffect(KinLevel);

/**
 * What a lead may do in a chat its owner placed it in: post, ping, start workers and open draft
 * PRs. Merges and other privileged actions still need the owner's signed approval.
 */
const OWNER_PLACED_LEVEL: KinLevel = "L2";

/**
 * Whether the lead's owner placed it in `chatId`, from stored rows only: its owner chat (a direct
 * chat whose key binds exactly that person and that lead), or a group the lead is in whose owner
 * is the lead's owner. Only a chat's owner adds members, so the owner put the lead there. A chat
 * someone else owns keeps the lead's own level, the conservative default.
 */
const ownerPlacedSql = (sql: SqlClient.SqlClient, chatId: KinChatId | null) => sql`(EXISTS (
    SELECT 1 FROM kin_chats d WHERE d.org_id = l.org_id AND d.chat_id = l.owner_chat_id
      AND d.chat_id = ${chatId} AND d.kind = 'direct'
      AND d.direct_key = a.owner_person_id || ':' || l.agent_id)
  OR EXISTS (
    SELECT 1 FROM kin_chats g
    JOIN kin_chat_members o ON o.org_id = g.org_id AND o.chat_id = g.chat_id
      AND o.principal_kind = 'person' AND o.role = 'owner' AND o.left_at IS NULL
      AND o.person_id = a.owner_person_id
    JOIN kin_chat_members lm ON lm.org_id = g.org_id AND lm.chat_id = g.chat_id
      AND lm.principal_kind = 'agent' AND lm.agent_id = l.agent_id AND lm.left_at IS NULL
    WHERE g.org_id = l.org_id AND g.chat_id = ${chatId} AND g.kind <> 'direct'))`;

/** A chat's level before its cap: the lead's, raised to `OWNER_PLACED_LEVEL` where its owner put it. */
const chatBase = (lead: KinLevel, ownerPlaced: boolean) =>
  ownerPlaced && !atLeast(lead, OWNER_PLACED_LEVEL) ? OWNER_PLACED_LEVEL : lead;

/**
 * For a chat target, `min(base, chat cap)`, where the base is the lead's level, or at least L2 in
 * a chat its owner placed it in. The lead's level otherwise (lead spec, Permissions). Read from
 * `kin_leads`, `kin_chats`, `kin_chat_members` and `kin_chat_levels` only; no tool input or model text.
 */
export const effectiveLevel = Effect.fn("KinLevels.effectiveLevel")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId?: KinChatId | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const chatId = input.chatId ?? null;
  const [row] = yield* sql<{ level: string; chatLevel: string | null; ownerPlaced: number }>`
    SELECT l.level, c.level AS "chatLevel", ${ownerPlacedSql(sql, chatId)} AS "ownerPlaced"
    FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    LEFT JOIN kin_chat_levels c ON c.org_id = l.org_id AND c.agent_id = l.agent_id
      AND c.chat_id = ${chatId}
    WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinLevels.effectiveLevel")));
  if (row === undefined) return yield* new KinLevelRefused({ reason: "not_a_lead" });
  const decode = (value: unknown) =>
    decodeLevel(value).pipe(Effect.mapError(toPersistenceDecodeError("KinLevels.effectiveLevel")));
  const base = chatBase(yield* decode(row.level), row.ownerPlaced === 1);
  if (row.chatLevel === null) return base;
  const chat = yield* decode(row.chatLevel);
  return atLeast(chat, base) ? base : chat;
});

export const lowest = (a: KinLevel, b: KinLevel) => (atLeast(a, b) ? b : a);

/** The chat a due deferral or a passed-on request was first asked in, and the lead asked there. */
export interface KinOrigin {
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
}

/** `origin`'s level for the lead asked there; a lead retired since reads as L0. */
export const originLevel = (orgId: KinOrgId, origin: KinOrigin) =>
  effectiveLevel({ orgId, agentId: origin.agentId, chatId: origin.chatId }).pipe(
    Effect.catchTags({ KinLevelRefused: () => Effect.succeed<KinLevel>("L0") }),
  );

/**
 * The lowest level of the chats the wake-up's due deferrals and passed-on requests were first
 * asked in, or undefined when none was asked outside its owner chat. Read from the stored events
 * only.
 */
export const originCap = Effect.fn("KinLevels.originCap")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const origins = yield* sql<{ agentId: KinAgentId; chatId: KinChatId }>`
    SELECT DISTINCT json_extract(json, '$.origin.agentId') AS "agentId",
      json_extract(json, '$.origin.chatId') AS "chatId" FROM kin_events
    WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND wakeup_id = ${input.wakeupId}
      AND tag IN ('deferral.due', 'chat.message')
      AND json_extract(json, '$.origin.chatId') IS NOT NULL
    ORDER BY 1, 2`.pipe(Effect.mapError(toPersistenceSqlError("KinLevels.originCap")));
  let cap: KinLevel | undefined;
  for (const origin of origins) {
    const level = yield* originLevel(input.orgId, origin);
    cap = cap === undefined ? level : lowest(cap, level);
  }
  return cap;
});

/**
 * The level a running wake-up works at: its lead's level in the chat it answers, which is the
 * reply bridge's lane (its first chat event's chat, else the lead's owner chat), capped by
 * `originCap`. Memory follows it: a wake-up in a chat its owner placed it in writes the default
 * branch, an L0 one the shadow branch.
 */
export const wakeupLevel = Effect.fn("KinLevels.wakeupLevel")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [lane] = yield* sql<{ chatId: string | null }>`
    SELECT COALESCE((SELECT json_extract(e.json, '$.chatId') FROM kin_events e
        WHERE e.org_id = l.org_id AND e.agent_id = l.agent_id AND e.wakeup_id = ${input.wakeupId}
          AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
        ORDER BY e.priority, e.received_at, e.event_id LIMIT 1), l.owner_chat_id) AS "chatId"
    FROM kin_leads l WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
    ORDER BY l.agent_id`.pipe(Effect.mapError(toPersistenceSqlError("KinLevels.wakeupLevel")));
  const level = yield* effectiveLevel({
    orgId: input.orgId,
    agentId: input.agentId,
    chatId: lane?.chatId == null ? undefined : KinChatId.make(lane.chatId),
  });
  const cap = yield* originCap(input);
  return cap === undefined ? level : lowest(level, cap);
});

/**
 * Records a new lead at L0, its level in chats its owner didn't place it in; where the owner did,
 * it works at `OWNER_PLACED_LEVEL`. The owner chat must be a direct chat in the same org. False
 * when the agent already has a lead row.
 */
export const insertLeadAtL0 = Effect.fn("KinLevels.insertLeadAtL0")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly since: number;
  readonly modelsJson: string;
  readonly workerProjectsJson: string;
  readonly ownerChatId: KinChatId;
  readonly domain: string;
  readonly charter: string;
  readonly createdByPersonId: KinPersonId;
}) {
  const sql = yield* SqlClient.SqlClient;
  // The creator must be a person of the same org.
  const inserted = yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since,
      models_json, worker_projects_json, owner_chat_id, domain, charter, created_by_person_id)
    SELECT ${input.agentId}, ${input.orgId}, ${input.name}, 'L0', ${input.since}, ${input.modelsJson},
      ${input.workerProjectsJson}, c.chat_id, ${input.domain}, ${input.charter}, p.person_id
    FROM kin_chats c JOIN kin_people p ON p.org_id = c.org_id AND p.person_id = ${input.createdByPersonId}
    WHERE c.org_id = ${input.orgId} AND c.chat_id = ${input.ownerChatId} AND c.kind = 'direct'
    ON CONFLICT (agent_id) DO NOTHING RETURNING agent_id`.pipe(
    Effect.mapError(toPersistenceSqlError("KinLevels.insertLeadAtL0")),
  );
  return inserted.length > 0;
});

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
    owner: string;
  }>`SELECT l.level, a.owner_person_id AS owner FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${input.orgId} AND l.agent_id = ${input.agentId}
      AND a.role = 'lead' AND a.retired_at IS NULL
    ORDER BY l.agent_id`);
  if (row === undefined) return yield* new KinLevelRefused({ reason: "not_a_lead" });
  return {
    level: yield* decode("KinLevels.activeLead")(row.level),
    owner: row.owner,
  };
});

/**
 * The chat's stored cap, or undefined, and whether the lead's owner placed it there; the chat
 * must be one the lead is an active member of.
 */
const chatCap = Effect.fn("KinLevels.chatCap")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId: KinChatId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [chat] = yield* query("KinLevels.chatCap")(sql<{
    level: string | null;
    ownerPlaced: number;
  }>`SELECT c.level, ${ownerPlacedSql(sql, input.chatId)} AS "ownerPlaced" FROM kin_chat_members m
    JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.agent_id
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    LEFT JOIN kin_chat_levels c ON c.org_id = m.org_id AND c.agent_id = m.agent_id
      AND c.chat_id = m.chat_id
    WHERE m.org_id = ${input.orgId} AND m.chat_id = ${input.chatId}
      AND m.agent_id = ${input.agentId} AND m.left_at IS NULL
    ORDER BY m.chat_id`);
  if (chat === undefined) return yield* new KinLevelRefused({ reason: "not_found" });
  return {
    cap: chat.level === null ? undefined : yield* decode("KinLevels.chatCap")(chat.level),
    ownerPlaced: chat.ownerPlaced === 1,
  };
});

/**
 * Lowers the lead's level, or one chat's cap, at once and without a grant (lead spec,
 * Permissions). The owner's RPC is the only caller.
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
      const { cap, ownerPlaced } = yield* chatCap({ ...input, chatId });
      const base = chatBase(lead.level, ownerPlaced);
      const current = cap === undefined || atLeast(cap, base) ? base : cap;
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
 * Whether the owner may ask to raise: the lead to any higher level, or a chat's cap back up to at
 * most its base (the lead's level, or L2 where its owner placed it). Raising always needs the
 * owner's signed grant on top.
 */
export const checkRaise = Effect.fn("KinLevels.checkRaise")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly chatId?: KinChatId | undefined;
  readonly level: KinLevel;
}) {
  const lead = yield* activeLead(input);
  if (input.chatId === undefined) {
    if (atLeast(lead.level, input.level))
      return yield* new KinLevelRefused({ reason: "invalid_level" });
    return { from: lead.level };
  }
  const { cap, ownerPlaced } = yield* chatCap({ ...input, chatId: input.chatId });
  const base = chatBase(lead.level, ownerPlaced);
  const current = cap === undefined || atLeast(cap, base) ? base : cap;
  if (atLeast(current, input.level) || !atLeast(base, input.level))
    return yield* new KinLevelRefused({ reason: "invalid_level" });
  return { from: current, base };
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
      const raise = yield* checkRaise({ ...ref, chatId: target.chatId, level: target.level });
      const { from } = raise;
      if (target.chatId === undefined) {
        const updated = yield* run(sql`UPDATE kin_leads SET level = ${target.level},
            level_since = ${now}
          WHERE org_id = ${input.orgId} AND agent_id = ${target.agentId}
            AND level = ${from} AND ${claimed}
          RETURNING agent_id`);
        if (updated.length === 0) return yield* new KinLevelRefused({ reason: "not_granted" });
        return { agentId: target.agentId, from, to: target.level };
      }
      // Back at its base, the chat follows the lead again.
      const written =
        target.level === ("base" in raise ? raise.base : lead.level)
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
