import {
  KinChatError,
  KinAgentId,
  KinAgentRole,
  KinMemberId,
  KinMessageId,
  type KinAgentIntent,
  type KinChat,
  type KinMessage,
  type KinOrgId,
  type KinChatId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { SqlError } from "effect/sql/SqlError";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError, type PersistenceSqlError } from "../../persistence/Errors.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import {
  decideFloor,
  type FloorDecision,
  FLOOR_GRANT_TTL_MS,
  FLOOR_MAX_AGENT_TURNS,
  noticeIntentAllowed,
  replyIntentAllowed,
} from "./FloorManager.ts";

const encodeAgents = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(KinAgentId)));
const decodeMembers = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      agent_id: KinAgentId,
      member_id: KinMemberId,
      role: KinAgentRole,
    }),
  ),
);
const decodeRun = Schema.decodeUnknownEffect(
  Schema.Struct({
    run_id: Schema.String,
    agent_turns: Schema.Int,
    last_speaker: Schema.NullOr(KinAgentId),
    state: Schema.Literals(["open", "closed"]),
    opened_by: KinMessageId,
    mention_queue: Schema.fromJsonString(Schema.Array(KinAgentId)),
    spoken: Schema.fromJsonString(Schema.Array(KinAgentId)),
  }),
);
const invalidIntent = new KinChatError({
  reason: "invalid_state",
  message: "The intent or grant is invalid for this wake-up.",
});
const isKinChatError = Schema.is(KinChatError);
const NOTICE_LIMIT = 10;
export const NOTICE_WINDOW_MS = 3_600_000;
const notGranted = new KinChatError({
  reason: "floor_not_granted",
  message: "The floor is not granted.",
});
type Scope = { readonly orgId: KinOrgId; readonly chatId: KinChatId };
type Authorization = { readonly runId: string | null };
export class KinFloor extends Context.Service<
  KinFloor,
  {
    readonly open: (
      message: KinMessage,
      chat: KinChat,
    ) => Effect.Effect<FloorDecision | null, PersistenceSqlError>;
    /**
     * Re-arms the agent's unused direct-chat grant on each open run one of `messageIds` opened,
     * so a wake-up that starts after the TTL can still reply once. It never issues a grant.
     */
    readonly renew: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly messageIds: ReadonlyArray<KinMessageId>;
    }) => Effect.Effect<void, PersistenceSqlError>;
    readonly authorize: (
      identity: AgentIdentity,
      chat: KinChat,
      intent: KinAgentIntent,
      token?: string,
    ) => Effect.Effect<Authorization, PersistenceSqlError | KinChatError>;
    /** Whether the running wake-up holds only server notices: posts then need no floor grant. */
    readonly noticeOnly: (identity: AgentIdentity) => Effect.Effect<boolean, PersistenceSqlError>;
    /**
     * The read-only checks on a notice post: intent, no grant, and the hourly limit. `earlier`
     * counts notices the server holds outside `kin_floor_notices`.
     */
    readonly admitNotice: (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly intent: KinAgentIntent;
        readonly token?: string | undefined;
        readonly earlier?: number;
      },
    ) => Effect.Effect<void, PersistenceSqlError | KinChatError>;
    readonly recordNotice: (
      identity: AgentIdentity,
      message: KinMessage,
    ) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/kin/floor/KinFloor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issue = Effect.fn("KinFloor.issue")(function* (
    scope: Scope & { readonly runId: string; readonly agentId: KinAgentId },
    now: number,
  ) {
    yield* sql`INSERT INTO kin_floor_grants (org_id, token, run_id, chat_id, agent_id, expires_at)
      SELECT r.org_id, ${SecureRandom.uuidV4Unsafe()}, r.run_id, r.chat_id, a.agent_id, ${now + FLOOR_GRANT_TTL_MS}
      FROM kin_floor_runs r JOIN kin_chat_members m ON m.org_id = r.org_id AND m.chat_id = r.chat_id
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
      WHERE r.org_id = ${scope.orgId} AND r.chat_id = ${scope.chatId} AND r.run_id = ${scope.runId}
        AND r.state = 'open' AND a.agent_id = ${scope.agentId} AND a.retired_at IS NULL AND m.left_at IS NULL
      ORDER BY m.member_id LIMIT 1
      ON CONFLICT DO NOTHING RETURNING token`;
  });
  const close = Effect.fn("KinFloor.close")(function* (scope: Scope) {
    yield* sql`UPDATE kin_floor_runs SET state = 'closed' WHERE org_id = ${scope.orgId} AND chat_id = ${scope.chatId} AND state = 'open'`;
    yield* sql`UPDATE kin_floor_grants SET expires_at = MIN(expires_at, ${yield* Clock.currentTimeMillis})
      WHERE org_id = ${scope.orgId} AND chat_id = ${scope.chatId} AND consumed_at IS NULL`;
  });
  const open = Effect.fn("KinFloor.open")(
    function* (message: KinMessage, chat: KinChat) {
      if (message.author._tag !== "human" || message.status !== "posted") return null;
      const now = yield* Clock.currentTimeMillis;
      yield* close(message);
      const agents = yield* sql`
      SELECT a.agent_id, m.member_id, a.role FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
      WHERE m.org_id = ${message.orgId} AND m.chat_id = ${message.chatId}
        AND m.left_at IS NULL AND a.retired_at IS NULL
      ORDER BY CASE a.role WHEN 'lead' THEN 0 ELSE 1 END, m.joined_at, a.agent_id`.pipe(
        Effect.flatMap(decodeMembers),
      );
      const lead = agents[0];
      const mentions = message.mentions.flatMap((id) =>
        agents.filter((agent) => agent.member_id === id).map((agent) => agent.agent_id),
      );
      const mentionQueue =
        chat.kind === "direct" && lead !== undefined ? [lead.agent_id] : mentions;
      const runId = SecureRandom.uuidV4Unsafe();
      yield* sql`INSERT INTO kin_floor_runs (org_id, run_id, chat_id, opened_by, mention_queue, state, opened_at)
      VALUES (${message.orgId}, ${runId}, ${message.chatId}, ${message.messageId}, ${yield* encodeAgents(mentionQueue)}, 'open', ${now})
      ON CONFLICT DO NOTHING RETURNING run_id`;
      if (lead === undefined) return null;
      const decision = decideFloor({
        run: {
          runId,
          chatId: chat.chatId,
          openedBy: message.messageId,
          mentionQueue,
          agentTurns: 0,
          lastSpeaker: null,
          spoken: [],
          grant: null,
          state: "open",
        },
        bids: [],
        text: message.body,
        leadAgentId: lead.agent_id,
        bidWindowOpenedAt: now,
        now,
      });
      // Group tokens remain internal until phase-2 wake-up delivery.
      if (decision._tag !== "grant") return decision;
      yield* issue({ ...message, runId, agentId: decision.agentId }, now);
      return decision;
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.open")),
  );

  const renew = Effect.fn("KinFloor.renew")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly messageIds: ReadonlyArray<KinMessageId>;
    }) {
      if (input.messageIds.length === 0) return;
      const expiresAt = (yield* Clock.currentTimeMillis) + FLOOR_GRANT_TTL_MS;
      // A new human message closes the run, and a reply consumes the grant, so neither re-arms.
      yield* sql`UPDATE kin_floor_grants SET expires_at = MAX(expires_at, ${expiresAt})
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND consumed_at IS NULL
        AND run_id IN (SELECT r.run_id FROM kin_floor_runs r
          JOIN kin_chats c ON c.org_id = r.org_id AND c.chat_id = r.chat_id AND c.kind = 'direct'
          WHERE r.org_id = ${input.orgId} AND r.state = 'open'
            AND r.opened_by IN ${sql.in(input.messageIds)})`;
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.renew")),
  );

  const noticeOnly = Effect.fn("KinFloor.noticeOnly")(
    function* (identity: AgentIdentity) {
      // Notice authority comes from the running wake-up's stored events, never tool input.
      const wakeups = yield* sql<{
        notices: number;
        replies: number;
        total: number;
        expected: number;
      }>`
      SELECT COUNT(e.event_id) AS total, json_array_length(w.event_ids) AS expected,
        COALESCE(SUM(CASE WHEN e.tag IN ('routine', 'github', 'deferral.due', 'worker.report', 'watchdog', 'action.resolved', 'resume') THEN 1 ELSE 0 END), 0) AS notices,
        COALESCE(SUM(CASE WHEN e.tag IN ('chat.message', 'widget.action') THEN 1 ELSE 0 END), 0) AS replies
      FROM kin_wakeups w JOIN kin_events e ON e.org_id = w.org_id AND e.agent_id = w.agent_id
        AND e.wakeup_id = w.wakeup_id AND e.event_id IN (SELECT value FROM json_each(w.event_ids))
      WHERE w.org_id = ${identity.orgId} AND w.agent_id = ${identity.agentId}
        AND w.thread_id = ${identity.threadId} AND w.status = 'running'
      GROUP BY w.wakeup_id, w.event_ids
      ORDER BY w.started_at, w.wakeup_id`;
      const wakeup = wakeups[0];
      return (
        wakeup !== undefined &&
        wakeup.total > 0 &&
        wakeup.expected === wakeup.total &&
        wakeup.notices === wakeup.total &&
        wakeup.replies === 0
      );
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.noticeOnly")),
  );

  const admitNotice = Effect.fn("KinFloor.admitNotice")(
    function* (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly intent: KinAgentIntent;
        readonly token?: string | undefined;
        readonly earlier?: number;
      },
    ): Effect.fn.Return<void, SqlError | KinChatError> {
      if (!noticeIntentAllowed(input.intent) || input.token !== undefined)
        return yield* invalidIntent;
      const now = yield* Clock.currentTimeMillis;
      const recent = yield* sql<{ message_id: string }>`SELECT message_id FROM kin_floor_notices
        WHERE org_id = ${identity.orgId} AND chat_id = ${input.chatId} AND agent_id = ${identity.agentId}
          AND posted_at > ${now - NOTICE_WINDOW_MS} ORDER BY posted_at, message_id LIMIT ${NOTICE_LIMIT}`;
      if (recent.length + (input.earlier ?? 0) >= NOTICE_LIMIT)
        return yield* new KinChatError({ reason: "limit", message: "Agent notice limit reached." });
    },
    Effect.mapError((error) =>
      isKinChatError(error) ? error : toPersistenceSqlError("KinFloor.admitNotice")(error),
    ),
  );

  const authorize = Effect.fn("KinFloor.authorize")(
    function* (
      identity: AgentIdentity,
      chat: KinChat,
      intent: KinAgentIntent,
      token?: string,
    ): Effect.fn.Return<
      Authorization,
      SqlError | PersistenceSqlError | KinChatError | Schema.SchemaError
    > {
      if (yield* noticeOnly(identity)) {
        yield* admitNotice(identity, { chatId: chat.chatId, intent, token });
        return { runId: null };
      }
      const now = yield* Clock.currentTimeMillis;
      const runs = yield* sql`
      SELECT run_id, agent_turns, last_speaker, state, opened_by, mention_queue, spoken FROM kin_floor_runs
      WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId}
      ORDER BY opened_at DESC, rowid DESC LIMIT 1`;
      const run = runs[0] === undefined ? undefined : yield* decodeRun(runs[0]);
      if (run?.agent_turns === FLOOR_MAX_AGENT_TURNS || run?.state === "closed")
        return yield* new KinChatError({ reason: "floor_closed", message: "The floor is closed." });
      if (run === undefined) return yield* notGranted;
      if (!replyIntentAllowed(run.agent_turns, intent)) return yield* invalidIntent;
      if (run.last_speaker === identity.agentId) return yield* notGranted;
      if (chat.kind !== "direct" && token === undefined) return yield* notGranted;
      const grants = yield* sql<{ token: string }>`SELECT token FROM kin_floor_grants
      WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${identity.agentId}
        AND run_id = ${run.run_id} AND consumed_at IS NULL AND expires_at > ${now}
        AND (${token ?? null} IS NULL OR token = ${token ?? null})
      ORDER BY expires_at, token LIMIT 1`;
      const grant = grants[0];
      if (grant === undefined) return yield* notGranted;
      const consumed = yield* sql`UPDATE kin_floor_grants SET consumed_at = ${now}
      WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${identity.agentId}
        AND run_id = ${run.run_id} AND token = ${grant.token} AND consumed_at IS NULL AND expires_at > ${now}
      RETURNING token`;
      if (consumed.length !== 1) return yield* notGranted;
      yield* sql`UPDATE kin_floor_runs SET agent_turns = agent_turns + 1, last_speaker = ${identity.agentId},
      spoken = json_insert(spoken, '$[#]', ${identity.agentId}),
      mention_queue = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(mention_queue) WHERE value != ${identity.agentId} ORDER BY key),
      state = CASE WHEN agent_turns + 1 >= ${FLOOR_MAX_AGENT_TURNS} THEN 'closed' ELSE 'open' END
      WHERE org_id = ${identity.orgId} AND run_id = ${run.run_id}`;
      const remaining = run.mention_queue.filter((agent) => agent !== identity.agentId);
      // With no bids, only the remaining mentions can win; leadAgentId is unused.
      const next = decideFloor({
        run: {
          runId: run.run_id,
          chatId: chat.chatId,
          openedBy: run.opened_by,
          mentionQueue: remaining,
          agentTurns: run.agent_turns + 1,
          lastSpeaker: identity.agentId,
          spoken: [...run.spoken, identity.agentId],
          grant: null,
          state: run.agent_turns + 1 >= FLOOR_MAX_AGENT_TURNS ? "closed" : "open",
        },
        bids: [],
        text: "",
        leadAgentId: identity.agentId,
        bidWindowOpenedAt: now,
        now,
      });
      if (next._tag === "grant") {
        yield* issue(
          { orgId: identity.orgId, chatId: chat.chatId, runId: run.run_id, agentId: next.agentId },
          now,
        );
      }
      return { runId: run.run_id };
    },
    Effect.mapError((error) =>
      isKinChatError(error) || error._tag === "PersistenceSqlError"
        ? error
        : toPersistenceSqlError("KinFloor.authorize")(error),
    ),
  );

  const recordNotice = Effect.fn("KinFloor.recordNotice")(
    function* (identity: AgentIdentity, message: KinMessage) {
      yield* sql`INSERT INTO kin_floor_notices (org_id, message_id, chat_id, agent_id, posted_at)
      VALUES (${identity.orgId}, ${message.messageId}, ${message.chatId}, ${identity.agentId}, ${yield* Clock.currentTimeMillis})
      ON CONFLICT DO NOTHING RETURNING message_id`;
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.recordNotice")),
  );
  return KinFloor.of({ open, renew, authorize, noticeOnly, admitNotice, recordNotice });
});
export const layer = Layer.effect(KinFloor, make);
