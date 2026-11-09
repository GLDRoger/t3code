// @effect-diagnostics nodeBuiltinImport:off -- a synchronous SHA-256 for shadow entry ids.
import * as NodeCrypto from "node:crypto";

import {
  KinLevel,
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

import { toPersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";

// Approvals import this module, so it must not reach the chat service or the judge.

const ORDER: ReadonlyArray<KinLevel> = ["L0", "L1", "L2", "L3"];
export const atLeast = (level: KinLevel, required: KinLevel) =>
  ORDER.indexOf(level) >= ORDER.indexOf(required);

export class KinLevelRefused extends Schema.TaggedError<KinLevelRefused>()("KinLevelRefused", {
  reason: Schema.Literals(["not_a_lead", "not_running", "conflict"]),
}) {}

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
 */
export const recordShadow = Effect.fn("KinLevels.recordShadow")(
  function* (entry: ShadowEntry) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [wakeup] = yield* sql<{ wakeupId: string }>`
          SELECT w.wakeup_id AS "wakeupId" FROM kin_wakeups w
          JOIN kin_leads l ON l.org_id = w.org_id AND l.agent_id = w.agent_id
          JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          WHERE w.org_id = ${entry.orgId} AND w.agent_id = ${entry.agentId}
            AND w.thread_id = ${entry.threadId} AND w.status = 'running'
            AND a.role = 'lead' AND a.retired_at IS NULL
          ORDER BY w.wakeup_id`;
        if (wakeup === undefined) return yield* new KinLevelRefused({ reason: "not_running" });
        const json = stableStringify(entry.input);
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
        const inserted = yield* sql`INSERT INTO kin_shadow_entries
          (entry_id, org_id, agent_id, wakeup_id, level, unlocks_level, tool, input_json, would_target, created_at)
          VALUES (${entryId}, ${entry.orgId}, ${entry.agentId}, ${wakeup.wakeupId}, ${entry.level},
            ${entry.unlocksLevel}, ${entry.tool}, ${json}, ${entry.wouldTarget},
            ${yield* Clock.currentTimeMillis})
          ON CONFLICT DO NOTHING RETURNING entry_id`;
        if (inserted.length === 0) {
          const [stored] = yield* sql<{ json: string; tool: string }>`
            SELECT input_json AS json, tool FROM kin_shadow_entries
            WHERE org_id = ${entry.orgId} AND entry_id = ${entryId} ORDER BY entry_id`;
          if (stored?.json !== json || stored.tool !== entry.tool)
            return yield* new KinLevelRefused({ reason: "conflict" });
        }
        return { shadowed: true as const, entryId, created: inserted.length > 0 };
      }),
    );
  },
  Effect.mapError((error) =>
    error._tag === "KinLevelRefused"
      ? error
      : toPersistenceSqlError("KinLevels.recordShadow")(error),
  ),
);

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
