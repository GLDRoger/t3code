import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinOrgId, ThreadId, type TurnTokenUsage } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as RunningSpend from "./runningSpend.ts";

const MINUTE = 60_000;
const NOW = 1794009600000;
const orgId = KinOrgId.make("org-ambermill");
const services = Chat.layer.pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(Hub.layer),
  Layer.provideMerge(Repository.layer),
  Layer.provideMerge(
    KinPersistence.layer.pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-running-spend-" })),
  Layer.provideMerge(NodeServices.layer),
);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = DateTime.formatIso(DateTime.makeUnsafe(NOW));
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
    VALUES ('rhea', ${orgId}, 'rhea', 'Rhea', 'owner', ${at}),
      ('zoya', ${orgId}, 'zoya', 'Zoya', 'member', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00',
    '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('finance', ${orgId}, 'Finance', 'lead', 'rhea', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('rhea-finance', ${orgId}, 'direct', 'rhea-finance', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('m-rhea', ${orgId}, 'rhea-finance', 'person', 'rhea', 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('m-finance', ${orgId}, 'rhea-finance', 'agent', 'finance', 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('finance', ${orgId}, 'Finance', 0, '{}', '[]', 'rhea-finance')`;
  yield* sql`INSERT INTO kin_budget_limits (org_id, limits_json)
    VALUES (${orgId}, '{"leadUnits":1000000,"workerUnits":4000000}')`;
});

const notices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ body: string; open: number }>`SELECT m.body,
      w.resolved_at IS NULL AS open
    FROM kin_messages m
    JOIN kin_waiting w ON w.org_id = m.org_id AND w.message_id = m.message_id
    WHERE m.org_id = ${orgId} AND m.message_id LIKE 'kin-running-spend:%'
    ORDER BY m.seq`;
});

it.effect(
  "tells the owner once a running turn passes a quarter of the day's limit and once at all of it, stops nothing, and closes when it ends",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const used = new Map<string, number>();
      const ledgers = new Map<string, TurnTokenUsage>();
      // A provider turn's own ledger, where it has one, beside its last request's size.
      const read: RunningSpend.ReadUsage = ({ threadId }) =>
        Effect.succeed(
          used.has(threadId)
            ? [
                {
                  providerTurnId: `turn-${threadId}`,
                  usedTokens: used.get(threadId)!,
                  ...(ledgers.has(threadId) ? { turnTokenUsage: ledgers.get(threadId)! } : {}),
                },
              ]
            : [],
        );
      yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, thread_id, run_id, model,
          started_at, status, event_ids)
        VALUES (${orgId}, 'w-1', 'finance', 'kin:lead-1', 'run-1', 'cheap', ${NOW}, 'running', '[]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('e-1', ${orgId}, 'finance', 'chat.message', 'P1',
          '{"_tag":"chat.message","provenance":{"_tag":"human","personId":"zoya"}}',
          ${NOW}, ${NOW}, 'claimed', 'w-1')`;
      yield* TestClock.adjust("40 minutes");
      // A turn with no usage yet, and one at a tenth of the limit, are told nothing.
      yield* RunningSpend.check(read);
      used.set("kin:lead-1", 100_000);
      yield* RunningSpend.check(read);
      assert.deepStrictEqual(yield* notices, []);
      used.set("kin:lead-1", 300_000);
      yield* RunningSpend.check(read);
      used.set("kin:lead-1", 350_000);
      yield* RunningSpend.check(read);
      const quarter =
        "Finance has used a quarter of today's limit in one go\n\nFinance's turn for Zoya has been running 40 minutes and has used at least 300k units so far, past a quarter of today's limit for your agents. It is still running; Kin hasn't stopped or slowed it. To watch it or stop it, open Finance's chat.";
      assert.deepStrictEqual(yield* notices, [{ body: quarter, open: 1 }]);
      yield* TestClock.adjust("50 minutes");
      used.set("kin:lead-1", 1_100_000);
      yield* RunningSpend.check(read);
      yield* RunningSpend.check(read);
      const all =
        "Finance has used all of today's limit in one go\n\nFinance's turn for Zoya has been running 1 hour 30 minutes and has used at least 1.1M units so far, past the whole of today's limit for your agents. It is still running; Kin hasn't stopped or slowed it. To watch it or stop it, open Finance's chat.";
      assert.deepStrictEqual(yield* notices, [
        { body: quarter, open: 1 },
        { body: all, open: 1 },
      ]);
      // Both notices told, the turn runs on: nothing ended, held or stopped it.
      assert.deepStrictEqual(
        yield* sql`SELECT status, ended_at FROM kin_wakeups WHERE wakeup_id = 'w-1'`,
        [{ status: "running", ended_at: null }],
      );
      assert.deepStrictEqual(yield* sql`SELECT state FROM kin_events WHERE event_id = 'e-1'`, [
        { state: "claimed" },
      ]);
      used.set("kin:lead-1", 1_400_000);
      yield* RunningSpend.check(read);
      assert.lengthOf(yield* notices, 2);
      // It ends: both notices close, and its next turn starts fresh.
      yield* sql`UPDATE kin_wakeups SET status = 'completed', ended_at = ${NOW} WHERE wakeup_id = 'w-1'`;
      yield* RunningSpend.check(read);
      assert.deepStrictEqual(
        (yield* notices).map((one) => one.open),
        [0, 0],
      );
      // A task an agent delegated counts against the tasks' limit, with no limit set the usual one.
      yield* sql`DELETE FROM kin_budget_limits`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role,
          kind, body, mentions_json, status, created_at)
        VALUES ('task-msg', ${orgId}, 'rhea-finance', 50, 'agent', 'finance', 'rhea', 'kin:lead-1',
          'm-finance', 'member', 'text', '', '[]', 'posted',
          ${DateTime.formatIso(DateTime.makeUnsafe(NOW + 60 * MINUTE))})`;
      yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
          revision, state_json, awaiting_json, updated_at)
        VALUES ('task-card', ${orgId}, 'rhea-finance', 'task-msg', 'native', 'task', 1,
          '{"threadId":"task-thread","status":"working"}', '[]', '2026-11-25T00:00:00.000Z')`;
      // Its running ledger, not its last 60k request, is what it has used, so "at least" goes.
      used.set(ThreadId.make("task-thread"), 60_000);
      ledgers.set(ThreadId.make("task-thread"), {
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: 1_000_000,
        cachedInputTokens: 0,
        outputTokens: 150_000,
      });
      yield* RunningSpend.check(read);
      assert.deepStrictEqual((yield* notices).at(-1), {
        body: "A task Finance started has used a quarter of a usual day's limit in one go\n\nA task Finance started has been running 30 minutes and has used 1.6M units so far, past a quarter of a usual day's limit for tasks your agents start (you have set no daily limit). It is still running; Kin hasn't stopped or slowed it. To watch it or stop it, open its card in Finance's chat.",
        open: 1,
      });
    }).pipe(Effect.provide(services)),
);
