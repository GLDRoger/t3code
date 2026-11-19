import { CommandId, KinAgentId, KinOrgId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import { delegatedTurn } from "./AgentSession.ts";
import { ownerOnlyWakeup } from "./Audience.testkit.ts";

const orgId = KinOrgId.make("org-ambermill");
const agentId = KinAgentId.make("chief-of-staff");
const lead = ThreadId.make("kin:chief-of-staff");

const delegation = Effect.fn("test.delegation")(function* (
  parent: string,
  run: string,
  child: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_subagents (subagent_id, thread_id, run_id,
      parent_node_id, provider, child_thread_id, origin, status, updated_at, payload_json)
    VALUES (${`task:${child}`}, ${parent}, ${run}, 'node', 'codex', ${child}, 'app_owned',
      'running', '', '{}')`;
});
const chain = Effect.fn("test.chain")(function* (root: string, run: string, prefix: string) {
  let parent = root;
  for (let depth = 1; depth <= 9; depth++) {
    yield* delegation(parent, depth === 1 ? run : `${prefix}-run-${depth}`, `${prefix}-${depth}`);
    parent = `${prefix}-${depth}`;
  }
  return ThreadId.make(parent);
});
const turnOf = (threadId: string) =>
  delegatedTurn(ThreadId.make(threadId)).pipe(Effect.map(({ turn }) => turn?.wakeupId));

it.effect("a task follows the wake-up its asking run belongs to, by that run's provenance", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-brief" });
    const own = yield* startWakeupRun(lead, "wake-brief");
    yield* sql`UPDATE kin_wakeups SET thread_id = ${lead}, run_id = ${own.id}, status = 'running'
      WHERE wakeup_id = 'wake-brief'`;
    // The owner's steer landed after the provider turn ended, so Kin adopted a new run for it.
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("end-own"),
      threadId: lead,
      runId: own.id,
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("late-steer"),
      threadId: lead,
      messageId: MessageId.make("kin-steer-msg:wake-brief:1"),
      text: "Also draft the reply to Meera.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "system",
      creationSource: "server",
    });
    const steer = (yield* orchestrator.getThreadProjection(lead)).runs.at(-1)!;
    assert.notStrictEqual(steer.id, own.id);
    yield* delegation(lead, steer.id, "from-steer");
    yield* delegation(lead, own.id, "from-own");
    yield* delegation(lead, "run-of-no-wakeup", "from-stray");
    assert.strictEqual(yield* turnOf("from-steer"), "wake-brief");
    assert.strictEqual(yield* turnOf("from-own"), "wake-brief");
    assert.deepStrictEqual(yield* delegatedTurn(ThreadId.make("from-stray")), {
      lineage: "kin",
      delegated: true,
      turn: undefined,
    });
    // A finished wake-up still backs the tasks it asked for.
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wake-brief'`;
    assert.strictEqual(yield* turnOf("from-steer"), "wake-brief");
    assert.strictEqual(yield* turnOf("from-own"), "wake-brief");
  }).pipe(Effect.provide(authorityLayer)),
);

it.effect(
  "a plain thread tree is never Kin's at any depth; one under a lead is, at any depth",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId: "wake-deep" });
      const own = yield* startWakeupRun(lead, "wake-deep");
      yield* sql`UPDATE kin_wakeups SET thread_id = ${lead}, run_id = ${own.id}, status = 'running'
      WHERE wakeup_id = 'wake-deep'`;
      const plain = yield* chain("plain-root", "plain-run", "plain");
      assert.deepStrictEqual(yield* delegatedTurn(plain), {
        lineage: "ordinary",
        delegated: false,
        turn: undefined,
      });
      const underKin = yield* chain(lead, own.id, "kin-task");
      assert.deepStrictEqual(yield* delegatedTurn(underKin), {
        lineage: "kin",
        delegated: true,
        turn: { orgId, agentId, wakeupId: "wake-deep" },
      });
      // Links that loop never reach a root, so the walk ends unresolved.
      yield* delegation("loop-b", "loop-run", "loop-a");
      yield* delegation("loop-a", "loop-run", "loop-b");
      assert.deepStrictEqual(yield* delegatedTurn(ThreadId.make("loop-a")), {
        lineage: "unresolved",
        delegated: true,
        turn: undefined,
      });
    }).pipe(Effect.provide(authorityLayer)),
);
