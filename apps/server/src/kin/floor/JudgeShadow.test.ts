import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinMemberId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer } from "../chat/WakeupAuthority.testkit.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Chat from "../chat/KinChatService.ts";
import { Judge, JudgeError, JUDGE_THRESHOLDS, type JudgeVerdict } from "./Judge.ts";
import * as Shadow from "./JudgeShadow.ts";
import * as NoopJudge from "./NoopJudge.ts";

const orgId = KinOrgId.make("kin-default");
const chatId = KinChatId.make("group");
const personId = KinPersonId.make("owner");
const agentId = KinAgentId.make("lead");
const memberId = KinMemberId.make("owner-member");
const agentMemberId = KinMemberId.make("lead-member");
const timestamp = "1970-01-01T00:00:00.000Z";
const person = { _tag: "person" as const, orgId, personId };
const database = Repository.layer.pipe(Layer.provideMerge(authorityLayer));
const dependencies = Hub.layer.pipe(Layer.provideMerge(database));
const testLayer = (judge: Layer.Layer<Judge>) =>
  Chat.layer.pipe(
    Layer.provideMerge(Shadow.layer.pipe(Layer.provide(judge))),
    Layer.provideMerge(dependencies),
    Layer.provide(environment),
  );
const seed = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  yield* repo.insertOrg({ orgId, name: "Test", createdAt: timestamp });
  yield* repo.insertPerson({
    orgId,
    personId,
    handle: "owner",
    displayName: "Owner",
    githubLogin: null,
    createdAt: timestamp,
  });
  yield* repo.insertAgent({
    orgId,
    agentId,
    ownerPersonId: personId,
    displayName: "Lead",
    role: "lead",
    createdAt: timestamp,
  });
  yield* repo.createChat({
    orgId,
    chatId,
    kind: "team_group",
    title: "Group",
    teamId: null,
    directKey: null,
    lastMessageAt: null,
    createdAt: timestamp,
    archivedAt: null,
  });
  for (const member of [
    { memberId, principal: { _tag: "person" as const, personId }, role: "owner" as const },
    {
      memberId: agentMemberId,
      principal: { _tag: "agent" as const, agentId },
      role: "member" as const,
    },
  ])
    yield* repo.addMember({
      orgId,
      chatId,
      ...member,
      joinedAt: timestamp,
      leftAt: null,
      mutedUntil: null,
    });
});
const send = (key: string) =>
  Effect.flatMap(Chat.KinChatService, (service) =>
    service.send(person, {
      chatId,
      clientMessageId: key,
      body: `Untrusted human text ${key}`,
      mentions: [agentMemberId],
    }),
  );
const logs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    message_id: string;
    verdict_json: string | null;
    floor_decision_json: string;
    latency_ms: number;
    error: string | null;
  }>`
    SELECT message_id, verdict_json, floor_decision_json, latency_ms, error FROM kin_judge_log
    WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY created_at, message_id`;
});
const floor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT run_id, opened_by, state, agent_turns, last_speaker FROM kin_floor_runs
    WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY opened_at, run_id`;
});

describe("JudgeShadow", () => {
  it.effect(
    "logs one row per committed group human message, deduplicates retries, and rolls back cleanly",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const shadow = yield* Shadow.JudgeShadow;
        const sql = yield* SqlClient.SqlClient;
        const first = yield* send("first");
        const retry = yield* send("first");
        assert.strictEqual(first.messageId, retry.messageId);
        const second = yield* send("second");
        yield* shadow.drain;
        const before = yield* floor;
        yield* shadow.observe(first, { _tag: "grant", agentId });
        yield* shadow.drain;
        assert.deepStrictEqual(yield* floor, before);
        const rows = yield* logs;
        assert.deepStrictEqual(
          rows.map((row) => row.message_id).sort(),
          [first.messageId, second.messageId].sort(),
        );
        for (const row of rows) {
          assert.strictEqual(row.error, null);
          assert.deepStrictEqual(JSON.parse(row.floor_decision_json), { _tag: "grant", agentId });
          assert.isBelow(
            JSON.parse(row.verdict_json!).needsResponse.confidence,
            JUDGE_THRESHOLDS.ask,
          );
          assert.notInclude(row.verdict_json!, "Untrusted human text");
        }
        const rolledBack = yield* sql
          .withTransaction(send("rollback").pipe(Effect.andThen(Effect.fail("rollback"))))
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(rolledBack));
        yield* shadow.drain;
        assert.strictEqual((yield* logs).length, 2);
        assert.deepStrictEqual(yield* floor, before);
      }).pipe(Effect.provide(testLayer(NoopJudge.layer))),
  );

  it.effect.prop(
    "arbitrary verdicts cannot change a group floor decision",
    {
      response: Schema.Boolean,
      human: Schema.Boolean,
      role: Schema.NullOr(Schema.Literals(["lead", "qa", "release"])),
      urgency: Schema.Literals(["low", "normal", "high"]),
      confidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
      commitment: Schema.Literals(["none", "defer", "promise"]),
    },
    (values) =>
      Effect.gen(function* () {
        const verdict: JudgeVerdict = {
          needsResponse: { value: values.response, confidence: Math.abs(values.confidence) },
          needsHumanDecision: { value: values.human, confidence: Math.abs(values.confidence) },
          role: { value: values.role, confidence: Math.abs(values.confidence) },
          urgency: { value: values.urgency, confidence: Math.abs(values.confidence) },
          commitment: {
            value: { kind: values.commitment, text: null },
            confidence: Math.abs(values.confidence),
          },
        };
        const judge = Layer.succeed(Judge, {
          name: "generated",
          judge: (input) => Effect.succeed({ ...verdict, untrustedExtra: input.text }),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          yield* send("generated");
          const before = yield* floor;
          yield* (yield* Shadow.JudgeShadow).drain;
          assert.deepStrictEqual(yield* floor, before);
          const [row] = yield* logs;
          assert.isNull(row!.error);
          assert.deepStrictEqual(JSON.parse(row!.floor_decision_json), { _tag: "grant", agentId });
          assert.deepStrictEqual(JSON.parse(row!.verdict_json!), verdict);
        }).pipe(Effect.provide(testLayer(judge)));
      }),
    { arbitrary: { runs: 20 } },
  );

  it.effect("a failed log write cannot roll back a post or hold its transaction", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE kin_judge_log`;
      const first = yield* send("log-failed");
      yield* (yield* Shadow.JudgeShadow).drain;
      const repo = yield* Repository.KinChatRepository;
      assert.isTrue(Option.isSome(yield* repo.getMessage({ orgId, messageId: first.messageId })));
      const second = yield* send("still-writable");
      assert.strictEqual(second.seq, first.seq + 1);
      yield* (yield* Shadow.JudgeShadow).drain;
    }).pipe(Effect.provide(testLayer(NoopJudge.layer))),
  );

  it.effect.each(["failure", "defect", "slow"] as const)(
    "%s never holds the post transaction or alters floor or delivery",
    (mode) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const blocked = yield* Deferred.make<JudgeVerdict>();
        const judge = Layer.succeed(Judge, {
          name: mode,
          judge: Effect.fn("TestJudge.judge")(function* () {
            yield* Deferred.succeed(entered, undefined);
            if (mode === "failure") return yield* new JudgeError({});
            if (mode === "defect") return yield* Effect.die("Untrusted private body");
            return yield* Deferred.await(blocked);
          }),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          const hub = yield* Hub.KinChatHub;
          const events = yield* hub.subscribeForViewer(person);
          const event = yield* events.pipe(
            Stream.filter((e) => e.type === "message.posted"),
            Stream.runHead,
            Effect.forkScoped,
          );
          const started = yield* Clock.currentTimeMillis;
          const message = yield* send(mode);
          assert.strictEqual(yield* Clock.currentTimeMillis, started);
          yield* Deferred.await(entered);
          const before = yield* floor;
          const repo = yield* Repository.KinChatRepository;
          assert.isTrue(
            Option.isSome(yield* repo.getMessage({ orgId, messageId: message.messageId })),
          );
          assert.isTrue(Option.isSome(yield* Fiber.join(event)));
          if (mode === "slow") {
            assert.isFalse(yield* Deferred.isDone(blocked));
            yield* TestClock.adjust(3000);
          }
          yield* (yield* Shadow.JudgeShadow).drain;
          assert.deepStrictEqual(yield* floor, before);
          const [row] = yield* logs;
          assert.strictEqual(row!.error, mode === "slow" ? "timeout" : "judge_error");
          assert.strictEqual(row!.latency_ms, mode === "slow" ? 3000 : 0);
          assert.isNull(row!.verdict_json);
        }).pipe(Effect.provide(testLayer(judge)));
      }),
  );
});
