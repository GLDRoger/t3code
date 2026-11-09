import {
  KinChatError,
  KinChatId,
  KinMessageId,
  KinShadowSummaryCard,
  KinWidgetId,
  type KinAgentId,
  type KinAgentIntent,
  type KinMessage,
  type KinMessagesSendInput,
  type KinOrgId,
  type KinShadowResult,
  type KinWidget,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinChatService, mayWrite } from "../chat/KinChatService.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import * as Floor from "../floor/KinFloor.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as KinLevels from "./KinLevels.ts";

type PostInput = KinMessagesSendInput & { readonly intent: KinAgentIntent };

/**
 * `kin_chat_post` behind the lead's level: below L1 it records a shadow entry and posts nothing,
 * except in the lead's direct chat with its owner, which posts as at L1.
 */
export class KinLevelGate extends Context.Service<
  KinLevelGate,
  {
    readonly post: (
      agent: AgentIdentity,
      input: PostInput,
    ) => Effect.Effect<KinMessage | KinShadowResult, KinChatError>;
  }
>()("t3/kin/lead/LevelGate/KinLevelGate") {}

const SUMMARY_ENTRIES = 50;
const PREVIEW_MAX = 280;
const summaryWidgetId = (agentId: KinAgentId, day: string) =>
  KinWidgetId.make(`shadow-summary:${agentId}:${day}`);
const decodeCard = Schema.decodeUnknownEffect(KinShadowSummaryCard);
const encodeCard = Schema.encodeEffect(KinShadowSummaryCard);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (value: string) =>
  value.length <= PREVIEW_MAX ? value : `${value.slice(0, PREVIEW_MAX - 1)}…`;
/** One plain-text line per entry; the input is the lead's own, so it is shown, never trusted. */
const preview = (tool: string, input: unknown) => {
  switch (tool) {
    case "kin_chat_post":
      return clip(text(field(input, "body")));
    case "kin_delegate":
      return clip(`${text(field(input, "kind"))}: ${text(field(input, "title"))}`);
    case "kin_follow_up":
      return clip(text(field(input, "brief")));
    case "request_action": {
      const target = field(input, "target");
      const repo = text(field(target, "repo"));
      const number = field(target, "number");
      const named = repo === "" ? "" : ` ${repo}${typeof number === "number" ? `#${number}` : ""}`;
      return clip(`${text(field(input, "kind"))}${named}: ${text(field(input, "reason"))}`);
    }
    default:
      return clip(tool);
  }
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Hub.KinChatHub;
  const cache = yield* MemoryCache.MemoryCache;
  const floor = yield* Floor.KinFloor;

  // The runner's summary of the owner-local day; best effort, so a failed refresh never undoes
  // the shadow entry it reports (the next entry or wake-up rebuilds it).
  const refresh = Effect.fn("KinShadowSummary.refresh")(
    function* (input: { readonly orgId: KinOrgId; readonly agentId: KinAgentId }) {
      const { orgId, agentId } = input;
      const zone = yield* cache.ownerTimeZone(orgId);
      const now = yield* Clock.currentTimeMillis;
      const local = DateTime.makeZonedUnsafe(now, { timeZone: zone });
      const start = DateTime.startOf(local, "day");
      const from = DateTime.toEpochMillis(start);
      const until = DateTime.toEpochMillis(DateTime.add(start, { days: 1 }));
      const day = DateTime.formatIsoDate(local);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const [lead] = yield* sql<{ name: string; ownerChatId: string }>`
            SELECT l.name, l.owner_chat_id AS "ownerChatId" FROM kin_leads l
            JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
            WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}
              AND a.role = 'lead' AND a.retired_at IS NULL
            ORDER BY l.agent_id`;
          if (lead === undefined) return;
          const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_shadow_entries
            WHERE org_id = ${orgId} AND agent_id = ${agentId}
              AND created_at >= ${from} AND created_at < ${until}
            ORDER BY n`;
          if ((count?.n ?? 0) === 0) return;
          const rows = yield* sql<{
            entryId: string;
            tool: string;
            level: string;
            unlocksLevel: string;
            wouldTarget: string;
            json: string;
            createdAt: number;
          }>`SELECT entry_id AS "entryId", tool, level, unlocks_level AS "unlocksLevel",
              would_target AS "wouldTarget", input_json AS json, created_at AS "createdAt"
            FROM kin_shadow_entries
            WHERE org_id = ${orgId} AND agent_id = ${agentId}
              AND created_at >= ${from} AND created_at < ${until}
            ORDER BY created_at DESC, entry_id DESC LIMIT ${SUMMARY_ENTRIES}`;
          const title = `What ${lead.name} would have done today`;
          const card = yield* decodeCard({
            agentId,
            title,
            day,
            total: count?.n ?? 0,
            entries: yield* Effect.forEach(rows.toReversed(), (row) =>
              Effect.map(decodeJson(row.json), (parsed) => {
                // Only request_action stores the server's provenance; other inputs are the lead's.
                const ceiling =
                  row.tool === "request_action"
                    ? field(field(parsed, "provenance"), "ceilingBelowOwner")
                    : undefined;
                return {
                  entryId: row.entryId,
                  tool: row.tool,
                  level: row.level,
                  unlocksLevel: row.unlocksLevel,
                  wouldTarget: row.wouldTarget,
                  preview: preview(row.tool, parsed),
                  ...(typeof ceiling === "boolean" ? { ceilingBelowOwner: ceiling } : {}),
                  createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.createdAt)),
                };
              }),
            ),
          });
          const state = yield* encodeCard(card);
          const widgetId = summaryWidgetId(agentId, day);
          const updatedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
          const existing = yield* repo.getWidget({ orgId, widgetId });
          if (Option.isNone(existing)) {
            const { message } = yield* chat.notice({
              orgId,
              chatId: KinChatId.make(lead.ownerChatId),
              messageId: KinMessageId.make(widgetId),
              body: title,
            });
            const widget: KinWidget = {
              orgId,
              chatId: message.chatId,
              widgetId,
              messageId: message.messageId,
              widgetClass: "native",
              type: "shadow_summary",
              revision: 1,
              state,
              source: null,
              feed: null,
              awaiting: [],
              pinnedAt: null,
              closedAt: null,
              updatedAt,
            };
            yield* repo.insertWidget(widget);
            yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
            return;
          }
          if (existing.value.type !== "shadow_summary") return;
          if (stableStringify(existing.value.state) === stableStringify(state)) return;
          const widget = yield* repo.updateWidget({
            ...existing.value,
            state,
            expectedRevision: existing.value.revision,
            updatedAt,
          });
          yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
        }),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin shadow summary refresh failed", { cause })),
  );

  // The lead's own direct chat with its owner, read from stored rows only.
  const isOwnerChat = Effect.fn("KinLevelGate.isOwnerChat")(
    function* (agent: AgentIdentity, chatId: KinChatId) {
      const rows = yield* sql<{ chatId: string }>`
        SELECT c.chat_id AS "chatId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        WHERE l.org_id = ${agent.orgId} AND l.agent_id = ${agent.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL
          AND c.kind = 'direct' AND c.chat_id = ${chatId}
        ORDER BY l.agent_id`;
      return rows.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.isOwnerChat")),
  );

  const refused = (message: string, reason: KinChatError["reason"] = "not_allowed") =>
    new KinChatError({ reason, message });
  const post = Effect.fn("KinLevelGate.post")(
    function* (agent: AgentIdentity, input: PostInput) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const level = yield* KinLevels.effectiveLevel({
            orgId: agent.orgId,
            agentId: agent.agentId,
            chatId: input.chatId,
          });
          // At L0 the owner still talks to the lead in their direct chat, through the real floor.
          if (KinLevels.atLeast(level, "L1") || (yield* isOwnerChat(agent, input.chatId)))
            return yield* chat.send(agent, input);
          // A shadow entry only names a chat the lead is an active member of, in its own org.
          const member = yield* repo.activeMember({
            orgId: agent.orgId,
            chatId: input.chatId,
            principal: { _tag: "agent", agentId: agent.agentId },
          });
          if (Option.isNone(member))
            return yield* new KinChatError({
              reason: "not_found",
              message: "Kin record not found.",
            });
          // The real post's cheap refusals come first, so the review holds only posts L1 would make.
          if (!mayWrite(member.value, true, yield* Clock.currentTimeMillis))
            return yield* refused("Chat operation not allowed.");
          const notice = yield* floor.noticeOnly(agent);
          // Shadowed notices count toward the hourly limit as the posts they stand for. The reply
          // path's floor check is not repeated: it consumes the grant it checks.
          const admit = Effect.gen(function* () {
            if (!notice) return;
            const since = (yield* Clock.currentTimeMillis) - Floor.NOTICE_WINDOW_MS;
            const [shadowed] = yield* sql<{ n: number }>`
              SELECT COUNT(*) AS n FROM kin_shadow_entries
              WHERE org_id = ${agent.orgId} AND agent_id = ${agent.agentId} AND created_at > ${since}
                AND tool = 'kin_chat_post' AND would_target = ${input.chatId}
                AND json_extract(input_json, '$.notice') = 1
              ORDER BY n`.pipe(
              Effect.mapError(toPersistenceSqlError("KinLevelGate.shadowedNotices")),
            );
            yield* floor.admitNotice(agent, {
              chatId: input.chatId,
              intent: input.intent,
              earlier: shadowed?.n ?? 0,
            });
          });
          return yield* KinLevels.recordShadow(
            {
              orgId: agent.orgId,
              agentId: agent.agentId,
              threadId: agent.threadId,
              level,
              unlocksLevel: "L1",
              tool: "kin_chat_post",
              // Keyed like a real post: the same clientMessageId with other content is refused.
              key: { chatId: input.chatId, clientMessageId: input.clientMessageId },
              input: {
                chatId: input.chatId,
                clientMessageId: input.clientMessageId,
                body: input.body,
                intent: input.intent,
                mentions: input.mentions ?? [],
                replyTo: input.replyTo ?? null,
                ...(notice ? { notice: true } : {}),
              },
              wouldTarget: input.chatId,
            },
            admit,
          );
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
      if (!("shadowed" in result)) return result;
      if (result.created) yield* refresh({ orgId: agent.orgId, agentId: agent.agentId });
      return { shadowed: true as const, entryId: result.entryId };
    },
    Effect.catch((error) =>
      error._tag === "KinChatError"
        ? Effect.fail(error)
        : error._tag === "KinLevelRefused"
          ? Effect.fail(
              refused(
                error.reason === "not_running"
                  ? "Kin wake-up is not running."
                  : error.reason === "conflict"
                    ? "This clientMessageId was already used for a different post."
                    : error.reason === "limit"
                      ? KinLevels.SHADOW_LIMIT_MESSAGE
                      : "Chat operation not allowed.",
                error.reason === "limit" ? "limit" : "not_allowed",
              ),
            )
          : Effect.logError("Kin level-gated post failed", error).pipe(
              Effect.andThen(
                Effect.fail(
                  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
                ),
              ),
            ),
    ),
  );

  return { gate: KinLevelGate.of({ post }), summary: KinLevels.KinShadowSummary.of({ refresh }) };
});

export const layer = Layer.effectContext(
  make.pipe(
    Effect.map(({ gate, summary }) =>
      Context.make(KinLevelGate, gate).pipe(Context.add(KinLevels.KinShadowSummary, summary)),
    ),
  ),
).pipe(Layer.provide(Layer.merge(MemoryCache.layer, Floor.layer)));
