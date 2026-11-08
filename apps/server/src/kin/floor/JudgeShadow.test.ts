import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
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
import type * as Statement from "effect/sql/Statement";
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
const testLayer = (
  judge: Layer.Layer<Judge>,
  sqlLayer:
    | Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient>
    | Layer.Layer<never> = Layer.empty,
  off = false,
) =>
  Chat.layer.pipe(
    Layer.provideMerge(
      (off ? Shadow.layerOff : Shadow.layer).pipe(Layer.provide(judge), Layer.provide(sqlLayer)),
    ),
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
const send = (key: string, grant = true) =>
  Effect.flatMap(Chat.KinChatService, (service) =>
    service.send(person, {
      chatId,
      clientMessageId: key,
      body: `Untrusted human text ${key}`,
      mentions: grant ? [agentMemberId] : [],
    }),
  );
const otherChatId = KinChatId.make("other-group");
const sendInOtherChat = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  yield* repo.createChat({
    orgId,
    chatId: otherChatId,
    kind: "team_group",
    title: "Other",
    teamId: null,
    directKey: null,
    lastMessageAt: null,
    createdAt: timestamp,
    archivedAt: null,
  });
  yield* repo.addMember({
    orgId,
    chatId: otherChatId,
    memberId: KinMemberId.make("owner-other"),
    principal: { _tag: "person", personId },
    role: "owner",
    joinedAt: timestamp,
    leftAt: null,
    mutedUntil: null,
  });
  return yield* Effect.flatMap(Chat.KinChatService, (service) =>
    service.send(person, { chatId: otherChatId, clientMessageId: "other", body: "Other chat" }),
  );
});
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
  return {
    runs: yield* sql`SELECT * FROM kin_floor_runs WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY run_id`,
    grants:
      yield* sql`SELECT * FROM kin_floor_grants WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY token`,
  };
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

  it.effect("the record deadline includes the log write", () =>
    Effect.gen(function* () {
      const modelEntered = yield* Deferred.make<void>();
      const modelResult = yield* Deferred.make<JudgeVerdict>();
      const writeEntered = yield* Deferred.make<void>();
      const writeResult = yield* Deferred.make<void>();
      const judge = Layer.succeed(Judge, {
        name: "blocked-write",
        judge: () =>
          Deferred.succeed(modelEntered, undefined).pipe(
            Effect.andThen(Deferred.await(modelResult)),
          ),
      });
      const sqlLayer = Layer.effect(
        SqlClient.SqlClient,
        Effect.map(
          SqlClient.SqlClient,
          (sql) =>
            new Proxy(sql, {
              apply(target, thisArg, args) {
                const query = Reflect.apply(target, thisArg, args) as Statement.Statement<never>;
                if (String(args[0]).includes("INSERT INTO kin_judge_log"))
                  return Deferred.succeed(writeEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(writeResult)),
                    Effect.andThen(query),
                  );
                return query;
              },
            }),
        ),
      );
      yield* Effect.gen(function* () {
        yield* seed;
        yield* send("deadline");
        yield* Deferred.await(modelEntered);
        yield* TestClock.adjust(2000);
        yield* Deferred.succeed(modelResult, {
          needsResponse: { value: false, confidence: 0 },
          role: { value: null, confidence: 0 },
          urgency: { value: "normal", confidence: 0 },
          needsHumanDecision: { value: false, confidence: 0 },
          commitment: { value: { kind: "none", text: null }, confidence: 0 },
        });
        yield* Deferred.await(writeEntered);
        const drained = yield* (yield* Shadow.JudgeShadow).drain.pipe(Effect.forkScoped);
        yield* TestClock.adjust(1000);
        assert.isTrue(drained.pollUnsafe() !== undefined);
        yield* Deferred.succeed(writeResult, undefined);
        yield* Fiber.join(drained);
        assert.deepStrictEqual(yield* logs, []);
      }).pipe(Effect.provide(testLayer(judge, sqlLayer)));
    }),
  );

  it.effect.each([
    "extra",
    "text",
    "name",
    "agent",
    "chat",
    "org",
    "message",
    "crossChat",
    "null",
  ] as const)("drops records outside the allowlist: %s", (invalid) =>
    Effect.gen(function* () {
      const verdict: JudgeVerdict = {
        needsResponse: { value: true, confidence: 1 },
        role: { value: "lead", confidence: 1 },
        urgency: { value: "normal", confidence: 1 },
        needsHumanDecision: { value: false, confidence: 1 },
        commitment: {
          value: { kind: "promise", text: invalid === "text" ? "x".repeat(1001) : null },
          confidence: 1,
        },
      };
      const judge = Layer.succeed(Judge, {
        name: invalid === "name" ? "x".repeat(101) : "boundary",
        judge: () =>
          Effect.succeed(
            invalid === "null"
              ? (null as unknown as JudgeVerdict)
              : invalid === "extra"
                ? { ...verdict, token: "not-authority" }
                : verdict,
          ),
      });
      yield* Effect.gen(function* () {
        yield* seed;
        const message = invalid === "crossChat" ? yield* sendInOtherChat : yield* send("boundary");
        const shadow = yield* Shadow.JudgeShadow;
        yield* shadow.drain;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM kin_judge_log`;
        const before = yield* floor;
        yield* shadow.observe(
          {
            ...message,
            chatId: invalid === "chat" ? KinChatId.make("other") : chatId,
            orgId: invalid === "org" ? KinOrgId.make("other") : orgId,
            messageId: invalid === "message" ? KinMessageId.make("missing") : message.messageId,
          },
          { _tag: "grant", agentId: invalid === "agent" ? KinAgentId.make("outsider") : agentId },
        );
        yield* shadow.drain;
        assert.deepStrictEqual(yield* logs, []);
        assert.deepStrictEqual(yield* floor, before);
      }).pipe(Effect.provide(testLayer(judge)));
    }),
  );

  it.effect.prop(
    "arbitrary verdicts cannot change a group floor decision",
    {
      grant: Schema.Boolean,
      off: Schema.Boolean,
      response: Schema.Boolean,
      human: Schema.Boolean,
      role: Schema.NullOr(Schema.Literals(["lead", "qa", "release"])),
      urgency: Schema.Literals(["low", "normal", "high"]),
      confidence: Schema.Union([
        Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        Schema.Literals([-1, 2]),
      ]),
      commitment: Schema.Literals(["none", "defer", "promise"]),
    },
    (values) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        // Normalise -0 so the JSON round-trip compares equal.
        const confidence = values.confidence + 0;
        const verdict: JudgeVerdict = {
          needsResponse: {
            value: values.response,
            confidence,
          },
          needsHumanDecision: {
            value: values.human,
            confidence,
          },
          role: { value: values.role, confidence },
          urgency: {
            value: values.urgency,
            confidence,
          },
          commitment: {
            value: { kind: values.commitment, text: null },
            confidence,
          },
        };
        const judge = Layer.succeed(Judge, {
          name: "generated",
          judge: () => Deferred.await(ready).pipe(Effect.as(verdict)),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          yield* send("generated", values.grant);
          const before = yield* floor;
          yield* Deferred.succeed(ready, undefined);
          yield* (yield* Shadow.JudgeShadow).drain;
          assert.deepStrictEqual(yield* floor, before);
          const [row] = yield* logs;
          if (values.off || values.confidence < 0 || values.confidence > 1) {
            assert.isUndefined(row);
            return;
          }
          assert.isNull(row!.error);
          assert.deepStrictEqual(
            JSON.parse(row!.floor_decision_json),
            values.grant ? { _tag: "grant", agentId } : { _tag: "wait" },
          );
          const stored: JudgeVerdict = JSON.parse(row!.verdict_json!);
          assert.deepStrictEqual(stored, verdict);
          for (const score of Object.values(stored)) {
            assert.isAtLeast(score.confidence, 0);
            assert.isAtMost(score.confidence, 1);
          }
        }).pipe(Effect.provide(testLayer(judge, Layer.empty, values.off)));
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
          if (mode === "slow") {
            assert.isUndefined(row);
            return;
          }
          assert.strictEqual(row!.error, "judge_error");
          assert.strictEqual(row!.latency_ms, 0);
          assert.isNull(row!.verdict_json);
        }).pipe(Effect.provide(testLayer(judge)));
      }),
  );
});
