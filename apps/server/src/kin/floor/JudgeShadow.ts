import { KinAgentRole, type KinMessage } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FiberSet from "effect/FiberSet";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { FloorDecision } from "./FloorManager.ts";
import { Judge, type JudgeInput, JUDGE_MODE } from "./Judge.ts";

const confidence = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const scored = <S extends Schema.Top>(value: S) => Schema.Struct({ value, confidence });
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeVerdict = Schema.decodeUnknownEffect(
  Schema.Struct({
    needsResponse: scored(Schema.Boolean),
    role: scored(Schema.NullOr(KinAgentRole)),
    urgency: scored(Schema.Literals(["low", "normal", "high"])),
    needsHumanDecision: scored(Schema.Boolean),
    commitment: scored(
      Schema.Struct({
        kind: Schema.Literals(["none", "defer", "promise"]),
        text: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000))),
      }),
    ),
  }),
);
const decodeAgents = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      role: KinAgentRole,
    }),
  ),
);

export class JudgeShadow extends Context.Service<
  JudgeShadow,
  {
    readonly drain: Effect.Effect<void>;
    readonly observe: (message: KinMessage, decision: FloorDecision | null) => Effect.Effect<void>;
  }
>()("t3/kin/floor/JudgeShadow") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const judge = yield* Judge;
  const workers = yield* FiberSet.make<void>();
  const record = Effect.fn("KinJudge.record")(
    function* (message: KinMessage, floorDecision: FloorDecision | null) {
      const agents = yield* sql`SELECT a.agent_id, a.role FROM kin_chat_members m
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
      WHERE m.org_id = ${message.orgId} AND m.chat_id = ${message.chatId}
        AND m.left_at IS NULL AND a.retired_at IS NULL
      ORDER BY CASE a.role WHEN 'lead' THEN 0 ELSE 1 END, m.joined_at, a.agent_id`.pipe(
        Effect.flatMap(decodeAgents),
      );
      const recent = yield* sql<{
        author_kind: "human" | "agent";
        author_role: string;
        body: string;
      }>`
      SELECT author_kind, author_role, body FROM kin_messages
      WHERE org_id = ${message.orgId} AND chat_id = ${message.chatId} AND seq < ${message.seq}
        AND author_kind IN ('human', 'agent') AND status = 'posted'
      ORDER BY seq DESC LIMIT 10`;
      const input: JudgeInput = {
        orgId: message.orgId,
        chatId: message.chatId,
        messageId: message.messageId,
        text: message.body,
        authorRole: message.authorRole,
        recent: recent
          .toReversed()
          .map((row) => ({ authorKind: row.author_kind, role: row.author_role, text: row.body })),
        agentRoles: agents.map((agent) => agent.role),
      };
      const started = yield* Clock.currentTimeMillis;
      const result = yield* Effect.suspend(() => judge.judge(input)).pipe(
        Effect.flatMap(decodeVerdict),
        Effect.map((verdict) => ({ verdict, error: null })),
        Effect.catchCause(() => Effect.succeed({ verdict: null, error: "judge_error" as const })),
        Effect.timeoutOrElse({
          duration: 3000,
          orElse: () => Effect.succeed({ verdict: null, error: "timeout" as const }),
        }),
      );
      const now = yield* Clock.currentTimeMillis;
      if (result.error !== null)
        yield* Effect.logWarning("Kin shadow judge failed.", { category: result.error });
      yield* sql`INSERT INTO kin_judge_log
      (org_id, id, chat_id, message_id, judge, verdict_json, floor_decision_json, latency_ms, error, created_at)
      VALUES (${message.orgId}, ${SecureRandom.uuidV4Unsafe()}, ${message.chatId}, ${message.messageId},
        ${judge.name.slice(0, 100)}, ${result.verdict === null ? null : yield* encodeJson(result.verdict)},
        ${yield* encodeJson(floorDecision)}, ${Math.max(0, now - started)}, ${result.error}, ${now})
      ON CONFLICT DO NOTHING RETURNING id`;
    },
    Effect.mapError(toPersistenceSqlError("KinJudge.record")),
  );
  return JudgeShadow.of({
    drain: FiberSet.awaitEmpty(workers),
    observe: Effect.fn("KinJudge.observe")(function* (message, decision) {
      if (JUDGE_MODE !== "shadow" || message.author._tag !== "human" || message.status !== "posted")
        return;
      // Fork only after commit, without inheriting the post's transaction connection.
      yield* sql.afterCommit(
        record(message, decision).pipe(
          Effect.catchCause(() => Effect.logWarning("Kin shadow judge log failed.")),
          FiberSet.run(workers, { startImmediately: false }),
          Effect.asVoid,
        ),
      );
    }),
  });
});
export const layer = Layer.effect(JudgeShadow, make);
