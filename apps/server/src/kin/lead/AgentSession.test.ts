// @effect-diagnostics nodeBuiltinImport:off -- one test reads the upstream toolkits folder by name.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CommandId, KinAgentId, KinOrgId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { authorityLayer, startWakeupRun } from "../chat/WakeupAuthority.testkit.ts";
import { delegatedTurn, fullSessionRefusal, isT3Tool } from "./AgentSession.ts";
import { SESSION_REFUSAL } from "./Audience.ts";
import { approvedWakeup, ownerOnlyWakeup } from "./Audience.testkit.ts";

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

// A turn whose content a teammate's turn wrote keeps no shell: the owner's Approve authorises
// the one thing the card showed, not built-ins, and a task it delegates follows it.
it.effect(
  "an approved draft's turn, or one naming an approval it isn't, has no built-in tools; nor have its tasks",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const wakeupId = "wake-approved";
      yield* ownerOnlyWakeup({ orgId, agentId, wakeupId });
      const run = yield* startWakeupRun(lead, wakeupId);
      yield* sql`UPDATE kin_wakeups SET thread_id = ${lead}, run_id = ${run.id}, status = 'running',
        audience = 'owner_only' WHERE wakeup_id = ${wakeupId}`;
      yield* delegation(lead, run.id, "task-of-approval");
      const task = ThreadId.make("task-of-approval");
      // The same agent's ordinary owner-only turn, and its task, keep them as before.
      assert.isUndefined(yield* fullSessionRefusal(lead));
      assert.isUndefined(yield* fullSessionRefusal(task));
      for (const canonical of [true, false]) {
        yield* approvedWakeup({ orgId, agentId, wakeupId, canonical });
        assert.strictEqual(
          yield* fullSessionRefusal(lead),
          SESSION_REFUSAL.approved,
          `${canonical}`,
        );
        assert.strictEqual(
          yield* fullSessionRefusal(task),
          SESSION_REFUSAL.approved,
          `${canonical}`,
        );
      }
      yield* sql`DELETE FROM kin_events WHERE wakeup_id = ${wakeupId}`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('wake-approved:brief', ${orgId}, ${agentId}, 'routine', 'P2', '{"_tag":"routine"}',
          0, 0, 'claimed', ${wakeupId})`;
      assert.isUndefined(yield* fullSessionRefusal(lead));
    }).pipe(Effect.provide(authorityLayer)),
);

it("counts every upstream toolkit's tools as T3's, so a new one is hidden until Kin lists it", async () => {
  const folder = NodePath.resolve(import.meta.dirname, "../../mcp/toolkits");
  const names: Array<string> = [];
  for (const entry of NodeFS.readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const exported: Record<string, unknown> = await import(
      NodePath.join(folder, entry.name, "tools.ts")
    );
    for (const value of Object.values(exported))
      if (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        "tools" in value
      )
        names.push(...Object.keys(value.tools as object));
  }
  assert.isAbove(names.length, 50);
  assert.deepStrictEqual(
    names.filter((name) => !isT3Tool(name)),
    [],
  );
});
