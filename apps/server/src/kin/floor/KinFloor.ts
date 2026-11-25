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
/** Events nobody's message opened a floor for: what the woken lead posts needs no grant. */
const NOTICE_TAGS = [
  "routine",
  "github",
  "deferral.due",
  "watchdog",
  "pulse",
  "action.resolved",
  "resume",
  "record.changed",
  "task.finished",
];
/** For event `e`: a request another lead passed on, which landed as Kin's own row. */
const passedOn = (sql: SqlClient.SqlClient) =>
  sql.literal(`(json_extract(e.json, '$.origin') IS NOT NULL
    AND json_extract(e.json, '$.provenance._tag') = 'agent'
    AND EXISTS (SELECT 1 FROM kin_messages pm WHERE pm.org_id = e.org_id
      AND pm.message_id = json_extract(e.json, '$.messageId')
      AND pm.chat_id = json_extract(e.json, '$.chatId') AND pm.author_kind = 'system'))`);
const NOTICE_WINDOW_MS = 3_600_000;
/**
 * For an event row aliased `alias`: work someone gave the lead, whose report or assignment waits
 * on its words. The hourly notice limit never refuses those.
 */
export const owedNotice = (alias: string) => `(${alias}.tag = 'task.finished'
  OR (${alias}.tag = 'record.changed' AND json_extract(${alias}.json, '$.reason') = 'assigned'))`;
const notGranted = new KinChatError({
  reason: "floor_not_granted",
  message: "The floor is not granted.",
});
type Scope = { readonly orgId: KinOrgId; readonly chatId: KinChatId };

/**
 * Who answers first in a chat: the lead the owner chose for it, else the lead who joined first.
 * For a query that names the chat `c`, its member row `m` and the agent `a`.
 */
export const speakerOrder = (sql: SqlClient.SqlClient) =>
  sql`CASE WHEN a.agent_id = c.lead_agent_id THEN 0 ELSE 1 END,
    CASE a.role WHEN 'lead' THEN 0 ELSE 1 END, m.joined_at, m.rowid`;
/** `owed`: a notice post someone waits on, outside the hourly notice limit. */
type Authorization = { readonly runId: string | null; readonly owed?: boolean };
export class KinFloor extends Context.Service<
  KinFloor,
  {
    /**
     * A person's message opens the chat's floor and grants one reply to each agent that answers
     * it: the leads it mentions, else the chat's lead, plus any agent the message before still
     * owed a reply. Returns those agents.
     */
    readonly open: (
      message: KinMessage,
      chat: KinChat,
    ) => Effect.Effect<ReadonlyArray<KinAgentId>, PersistenceSqlError>;
    /**
     * Re-arms the agent's unused grant on the open run of each chat `messageIds` are in, so a
     * wake-up that starts after the TTL can still reply once. It never issues a grant.
     * `until` (when the wake-up ends if its run stays silent) replaces the default TTL from now.
     */
    readonly renew: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly messageIds: ReadonlyArray<KinMessageId>;
      readonly until?: number;
    }) => Effect.Effect<void, PersistenceSqlError>;
    readonly authorize: (
      identity: AgentIdentity,
      chat: KinChat,
      intent: KinAgentIntent,
      token?: string,
    ) => Effect.Effect<Authorization, PersistenceSqlError | KinChatError>;
    /**
     * Whether the running wake-up holds only server notices, and requests other leads passed on
     * (`passed_on`, which it may answer): posts then need no floor grant. `owed`: one of them
     * waits on words, a passed-on request, a finished task or an assigned entry.
     */
    readonly noticeOnly: (
      identity: AgentIdentity,
    ) => Effect.Effect<
      false | { readonly kind: "notice" | "passed_on"; readonly owed: boolean },
      PersistenceSqlError
    >;
    /**
     * The read-only checks on a notice post: intent, no grant, and the hourly limit, which an
     * `owed` post skips. `earlier` counts notices the server holds outside `kin_floor_notices`.
     */
    readonly admitNotice: (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly intent: KinAgentIntent;
        readonly token?: string | undefined;
        readonly earlier?: number;
        readonly answers?: boolean;
        readonly owed?: boolean;
      },
    ) => Effect.Effect<void, PersistenceSqlError | KinChatError>;
    /**
     * A message for one person in their own direct chat with the lead (`KinLevelGate.postTo`):
     * a relay, a nudge, a notice. It is never the floor's, so it posts whether the chat is empty,
     * the lead spoke last or a reply is owed there, and it leaves that reply's grant alone. Only
     * the hourly notice limit applies.
     */
    readonly admitToPerson: (
      identity: AgentIdentity,
      chatId: KinChatId,
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
        AND NOT EXISTS (SELECT 1 FROM kin_floor_grants g WHERE g.org_id = r.org_id
          AND g.run_id = r.run_id AND g.agent_id = a.agent_id)
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
      if (message.author._tag !== "human" || message.status !== "posted") return [];
      const now = yield* Clock.currentTimeMillis;
      // Read before the run closes: a lead asked a moment ago still answers once.
      const owed = yield* sql<{ agentId: string }>`
        SELECT DISTINCT g.agent_id AS "agentId" FROM kin_floor_grants g
        JOIN kin_floor_runs r ON r.org_id = g.org_id AND r.run_id = g.run_id
        WHERE g.org_id = ${message.orgId} AND g.chat_id = ${message.chatId}
          AND r.state = 'open' AND g.consumed_at IS NULL ORDER BY g.agent_id`;
      yield* close(message);
      const agents = yield* sql`
      SELECT a.agent_id, m.member_id, a.role FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
      JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
      WHERE m.org_id = ${message.orgId} AND m.chat_id = ${message.chatId}
        AND m.left_at IS NULL AND a.retired_at IS NULL
      ORDER BY ${speakerOrder(sql)}`.pipe(Effect.flatMap(decodeMembers));
      const lead = agents[0];
      const mentions = message.mentions.flatMap((id) =>
        agents.filter((agent) => agent.member_id === id).map((agent) => agent.agent_id),
      );
      const asked =
        lead === undefined
          ? []
          : chat.kind === "direct" || mentions.length === 0
            ? [lead.agent_id]
            : mentions;
      const speakers = [
        ...new Set([
          ...asked,
          ...agents
            .map((agent) => agent.agent_id)
            .filter((agentId) => owed.some((row) => row.agentId === agentId)),
        ]),
      ];
      const runId = SecureRandom.uuidV4Unsafe();
      yield* sql`INSERT INTO kin_floor_runs (org_id, run_id, chat_id, opened_by, mention_queue, state, opened_at)
      VALUES (${message.orgId}, ${runId}, ${message.chatId}, ${message.messageId}, ${yield* encodeAgents(speakers)}, 'open', ${now})
      ON CONFLICT DO NOTHING RETURNING run_id`;
      for (const agentId of speakers) yield* issue({ ...message, runId, agentId }, now);
      return speakers;
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.open")),
  );

  const renew = Effect.fn("KinFloor.renew")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly messageIds: ReadonlyArray<KinMessageId>;
      readonly until?: number;
    }) {
      if (input.messageIds.length === 0) return;
      const expiresAt = input.until ?? (yield* Clock.currentTimeMillis) + FLOOR_GRANT_TTL_MS;
      // A reply consumes the grant, so it never re-arms; a run a newer message closed is not open.
      yield* sql`UPDATE kin_floor_grants SET expires_at = MAX(expires_at, ${expiresAt})
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND consumed_at IS NULL
        AND run_id IN (SELECT r.run_id FROM kin_floor_runs r
          WHERE r.org_id = ${input.orgId} AND r.state = 'open'
            AND r.chat_id IN (SELECT m.chat_id FROM kin_messages m
              WHERE m.org_id = ${input.orgId} AND m.message_id IN ${sql.in(input.messageIds)}))`;
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.renew")),
  );

  const noticeOnly = Effect.fn("KinFloor.noticeOnly")(
    function* (identity: AgentIdentity) {
      // Notice authority comes from the running wake-up's stored events, never tool input.
      // A request another lead passed on is Kin's row, which opens no floor: it counts as a
      // notice the woken lead answers.
      const wakeups = yield* sql<{
        notices: number;
        replies: number;
        total: number;
        expected: number;
        passedOn: number;
        owed: number;
        askedReviews: number;
      }>`
      SELECT COUNT(e.event_id) AS total, json_array_length(w.event_ids) AS expected,
        COALESCE(SUM(CASE WHEN e.tag IN ${sql.in(NOTICE_TAGS)} THEN 1 ELSE 0 END), 0) AS notices,
        COALESCE(SUM(CASE WHEN e.tag = 'chat.message' AND ${passedOn(sql)} THEN 1 ELSE 0 END), 0)
          AS "passedOn",
        COALESCE(SUM(CASE WHEN ${sql.literal(owedNotice("e"))} THEN 1 ELSE 0 END), 0) AS owed,
        COALESCE(SUM(CASE WHEN e.tag = 'github' AND json_extract(e.json, '$.askedBy') IS NOT NULL
          THEN 1 ELSE 0 END), 0) AS "askedReviews",
        COALESCE(SUM(CASE WHEN e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
          AND NOT (e.tag = 'chat.message' AND ${passedOn(sql)}) THEN 1 ELSE 0 END), 0) AS replies
      FROM kin_wakeups w JOIN kin_events e ON e.org_id = w.org_id AND e.agent_id = w.agent_id
        AND e.wakeup_id = w.wakeup_id AND e.event_id IN (SELECT value FROM json_each(w.event_ids))
      WHERE w.org_id = ${identity.orgId} AND w.agent_id = ${identity.agentId}
        AND w.thread_id = ${identity.threadId} AND w.status = 'running'
      GROUP BY w.wakeup_id, w.event_ids
      ORDER BY w.started_at, w.wakeup_id`;
      const wakeup = wakeups[0];
      if (
        wakeup === undefined ||
        wakeup.total === 0 ||
        wakeup.expected !== wakeup.total ||
        wakeup.notices + wakeup.passedOn !== wakeup.total ||
        wakeup.replies !== 0
      )
        return false;
      return {
        kind: wakeup.passedOn > 0 ? ("passed_on" as const) : ("notice" as const),
        // A review someone asked for is owed them, so the hourly limit never holds its line back.
        owed: wakeup.passedOn > 0 || wakeup.owed > 0 || wakeup.askedReviews > 0,
      };
    },
    Effect.mapError(toPersistenceSqlError("KinFloor.noticeOnly")),
  );

  const withinLimit = Effect.fnUntraced(function* (
    identity: AgentIdentity,
    chatId: KinChatId,
    earlier: number,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const recent = yield* sql<{ message_id: string }>`SELECT message_id FROM kin_floor_notices
      WHERE org_id = ${identity.orgId} AND chat_id = ${chatId} AND agent_id = ${identity.agentId}
        AND posted_at > ${now - NOTICE_WINDOW_MS} ORDER BY posted_at, message_id LIMIT ${NOTICE_LIMIT}`;
    if (recent.length + earlier >= NOTICE_LIMIT)
      return yield* new KinChatError({ reason: "limit", message: "Agent notice limit reached." });
  });

  const admitNotice = Effect.fn("KinFloor.admitNotice")(
    function* (
      identity: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly intent: KinAgentIntent;
        readonly token?: string | undefined;
        readonly earlier?: number;
        readonly answers?: boolean;
        readonly owed?: boolean;
      },
    ): Effect.fn.Return<void, SqlError | KinChatError> {
      if (
        !(
          noticeIntentAllowed(input.intent) ||
          (input.answers === true && input.intent === "answer")
        ) ||
        input.token !== undefined
      )
        return yield* invalidIntent;
      if (input.owed === true) return;
      yield* withinLimit(identity, input.chatId, input.earlier ?? 0);
    },
    Effect.mapError((error) =>
      isKinChatError(error) ? error : toPersistenceSqlError("KinFloor.admitNotice")(error),
    ),
  );

  const admitToPerson = Effect.fn("KinFloor.admitToPerson")(
    (identity: AgentIdentity, chatId: KinChatId) => withinLimit(identity, chatId, 0),
    Effect.mapError((error) =>
      isKinChatError(error) ? error : toPersistenceSqlError("KinFloor.admitToPerson")(error),
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
      const notice = yield* noticeOnly(identity);
      if (notice !== false) {
        yield* admitNotice(identity, {
          chatId: chat.chatId,
          intent,
          token,
          answers: notice.kind === "passed_on",
          owed: notice.owed,
        });
        return { runId: null, owed: notice.owed };
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
      // A grant lasts the wake-up run: its later posts in this floor run are the same agent turn.
      const wakeupId =
        identity.wakeupId ??
        (yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId" FROM kin_wakeups
          WHERE org_id = ${identity.orgId} AND agent_id = ${identity.agentId}
            AND thread_id = ${identity.threadId} AND status = 'running'
          ORDER BY started_at, wakeup_id LIMIT 1`)[0]?.wakeupId ??
        null;
      // Only while nobody else has spoken since: another agent's turn ends this one.
      if (wakeupId !== null && run.last_speaker === identity.agentId) {
        const held = yield* sql`SELECT 1 FROM kin_floor_grants
          WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${identity.agentId}
            AND run_id = ${run.run_id} AND consumed_wakeup_id = ${wakeupId}
          ORDER BY token LIMIT 1`;
        if (held.length > 0) return { runId: run.run_id };
      }
      // Each agent the message asked answers it, whoever of them speaks first.
      if (
        !replyIntentAllowed(run.agent_turns, intent) &&
        !run.mention_queue.includes(identity.agentId)
      )
        return yield* invalidIntent;
      if (run.last_speaker === identity.agentId) return yield* notGranted;
      const grants = yield* sql<{ token: string }>`SELECT token FROM kin_floor_grants
      WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${identity.agentId}
        AND run_id = ${run.run_id} AND consumed_at IS NULL AND expires_at > ${now}
        AND (${token ?? null} IS NULL OR token = ${token ?? null})
      ORDER BY expires_at, token LIMIT 1`;
      const grant = grants[0];
      if (grant === undefined) return yield* notGranted;
      const consumed =
        yield* sql`UPDATE kin_floor_grants SET consumed_at = ${now}, consumed_wakeup_id = ${wakeupId}
      WHERE org_id = ${identity.orgId} AND chat_id = ${chat.chatId} AND agent_id = ${identity.agentId}
        AND run_id = ${run.run_id} AND token = ${grant.token} AND consumed_at IS NULL AND expires_at > ${now}
      RETURNING token`;
      if (consumed.length !== 1) return yield* notGranted;
      yield* sql`UPDATE kin_floor_runs SET agent_turns = agent_turns + 1, last_speaker = ${identity.agentId},
      spoken = json_insert(spoken, '$[#]', ${identity.agentId}),
      mention_queue = (SELECT COALESCE(json_group_array(value), '[]') FROM json_each(mention_queue) WHERE value != ${identity.agentId} ORDER BY key),
      state = CASE WHEN agent_turns + 1 >= ${FLOOR_MAX_AGENT_TURNS} THEN 'closed' ELSE 'open' END
      WHERE org_id = ${identity.orgId} AND run_id = ${run.run_id}`;
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
  return KinFloor.of({
    open,
    renew,
    authorize,
    noticeOnly,
    admitNotice,
    admitToPerson,
    recordNotice,
  });
});
export const layer = Layer.effect(KinFloor, make);
