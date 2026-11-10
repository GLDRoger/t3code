import { assert, describe, it } from "@effect/vitest";
import {
  KIN_GITHUB_APP_SOURCE,
  KinEvent,
  KinAgentId,
  KinWakeupId,
  KinOrgId,
  KinWebhookSource,
  MemoryItemHead,
  KinTriggerFireId,
  ScheduledTaskError,
  ScheduledTaskWebhookDeliveryId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Memory from "../memory/Memory.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as GithubEvents from "./githubEvents.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import {
  projection,
  signedRequest,
  timestamp,
  waitForDispatch,
  webhookTask,
  withScheduledTasks,
} from "./webhooks.testkit.ts";

const orgId = KinOrgId.make("org-a");
const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(KinEvent));
const source = Schema.decodeSync(KinWebhookSource)({
  id: KIN_GITHUB_APP_SOURCE,
  orgId,
  repo: KIN_GITHUB_APP_SOURCE,
  scheduledTaskId: `task-${orgId}`,
  inboxThreadId: `inbox-${orgId}`,
  githubHookId: null,
  botLogin: "kin[bot]",
  status: "active",
});

const item = (id: string, on: unknown, overrides: Record<string, unknown> = {}) =>
  decodeHead({
    orgId,
    id,
    path: `deferrals/${id}.md`,
    kind: "deferral",
    title: id,
    status: "open",
    due: null,
    on,
    recorded_at: "2026-09-01",
    valid_from: "2026-09-01",
    invalid_at: null,
    superseded_by: null,
    review_by: "2026-12-01",
    source: "owner-chat",
    said_by: "owner",
    trust: "owner",
    links: [],
    ...overrides,
  });
const whenMerged = item("when-212-merges", {
  event: "pull_request",
  action: "closed",
  merged: true,
  number: 212,
});

const pullRequest = (overrides: { repo?: string; merged?: boolean; padding?: string } = {}) => ({
  ...(overrides.padding === undefined ? {} : { padding: overrides.padding }),
  action: "closed",
  number: 212,
  pull_request: {
    title: "@kin[bot]",
    number: 212,
    merged: overrides.merged ?? true,
    head: { sha: "abc123" },
  },
  repository: { full_name: overrides.repo ?? "owner/repo" },
  sender: { login: "alice" },
});

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(1794009600000);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Kin', ${timestamp})`;
  yield* sql`INSERT INTO kin_people VALUES ('owner', ${orgId}, 'owner', 'Owner', NULL, ${timestamp})`;
  yield* sql`INSERT INTO kin_agents VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${timestamp}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at) VALUES ('chat', ${orgId}, 'direct', 'direct', 0, ${timestamp})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', 'chat')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${`inbox-${orgId}`}, ${`project-${orgId}`}, 'Inbox', 'codex', 'approval-required', 'plan', ${timestamp}, ${timestamp}, '{}')`;
});

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

function services(memoryDown: Ref.Ref<boolean>, ticks: Map<string, Effect.Effect<void>>) {
  return Layer.mergeAll(
    KinTriggerStore.layer,
    KinTriggerInbox.layer,
    KinTriggerSink.layer,
    KinEventQueue.layer,
    Layer.succeed(Scheduler.Scheduler, {
      register: Effect.fn("KinGithubEventsTest.register")(function* <E, R>(
        name: string,
        work: Effect.Effect<void, E, R>,
      ) {
        const context = yield* Effect.context<R>();
        ticks.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
      }),
    }),
    Layer.succeed(GithubEvents.KinGithubRepoScope, { repos: ["Owner/Repo"] }),
    Layer.mock(Memory.Memory)({
      query: (org) =>
        Effect.gen(function* () {
          if (yield* Ref.get(memoryDown))
            return yield* new Memory.MemoryError({ orgId: org, operation: "query" });
          return [
            whenMerged,
            item("watch-link", undefined, { links: ["https://github.com/owner/repo/issues/777"] }),
          ].map((head) => ({ ...head, duplicate: false }));
        }),
    }),
  ).pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadProjection: () => Effect.succeed(projection(orgId)),
      }),
    ),
    Layer.provideMerge(database),
  );
}

const run = <A, E, R>(
  body: (tools: {
    deliver: (
      githubDelivery: string,
      payload: unknown,
      event?: string,
    ) => Effect.Effect<ScheduledTaskWebhookDeliveryId, ScheduledTaskError>;
    redeliver: (
      githubDelivery: string,
      payload: unknown,
    ) => Effect.Effect<string, ScheduledTaskError>;
    drain: Effect.Effect<void, GithubEvents.KinGithubEventsError>;
    tick: Effect.Effect<void>;
    memoryDown: Ref.Ref<boolean>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const memoryDown = yield* Ref.make(false);
    const ticks = new Map<string, Effect.Effect<void>>();
    return yield* Effect.gen(function* () {
      yield* seed;
      return yield* withScheduledTasks((tasks) =>
        Effect.gen(function* () {
          const { task } = yield* tasks.upsert(
            yield* webhookTask(source.scheduledTaskId, `project-${orgId}`),
          );
          const store = yield* KinTriggerStore.KinTriggerStore;
          yield* store.registerSource(source);
          yield* store.bindSecret(orgId, source.id, Redacted.make("test-secret"));
          // Deliveries must arrive after the secret they were signed with was bound.
          yield* TestClock.adjust("1 second");
          const consumer = yield* Effect.provide(
            Effect.service(GithubEvents.KinGithubEvents),
            GithubEvents.layer,
          );
          return yield* body({
            deliver: (githubDelivery, payload, event) =>
              waitForDispatch(
                tasks.triggerWebhook(signedRequest(task, githubDelivery, payload, event)),
              ).pipe(
                Effect.map((result) =>
                  result._tag === "accepted"
                    ? result.deliveryId
                    : ScheduledTaskWebhookDeliveryId.make("rejected"),
                ),
              ),
            redeliver: (githubDelivery, payload) =>
              tasks
                .triggerWebhook(signedRequest(task, githubDelivery, payload))
                .pipe(Effect.map((result) => (result._tag === "accepted" ? result.outcome : ""))),
            drain: consumer.drain(orgId),
            tick: ticks.get("kin-github-events") ?? Effect.die("tick not registered"),
            memoryDown,
          });
        }),
      );
    }).pipe(Effect.provide(services(memoryDown, ticks)));
  });

const events = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    json: string;
  }>`SELECT json FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
  return rows.map((row) => decodeEvent(row.json));
});
const queueDown = (down: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* down
      ? sql`CREATE TRIGGER queue_down BEFORE INSERT ON kin_events BEGIN SELECT RAISE(ABORT, 'down'); END`
      : sql`DROP TRIGGER queue_down`;
  });
const pending = (kind: "github" | "github_recheck") =>
  Effect.gen(function* () {
    const inbox = yield* KinTriggerInbox.KinTriggerInbox;
    return yield* inbox.listPending(orgId, 100, undefined, [kind]);
  });

describe("KinGithubEvents", () => {
  it.effect("turns a signed delivery into one external github event plus its condition", () =>
    run(({ deliver, redeliver, drain }) =>
      Effect.gen(function* () {
        const deliveryId = yield* deliver("gh-1", pullRequest());
        assert.strictEqual((yield* pending("github")).length, 1);
        yield* drain;
        const [github, condition] = yield* events;
        assert.deepInclude(github, {
          _tag: "github",
          deliveryId: "gh-1",
          dedupeKey: "gh-1",
          eventName: "pull_request",
          repo: "owner/repo",
          summary: "pull_request.closed in owner/repo #212 by alice (hint; verify on GitHub)",
          scheduledTaskId: source.scheduledTaskId,
          webhookDeliveryId: deliveryId,
          provenance: { _tag: "system" },
        });
        assert.deepInclude(condition, {
          _tag: "watchdog",
          dedupeKey: "github-condition:gh-1",
          finding:
            "GitHub event suggests condition met (hint; verify on GitHub before acting): pull_request.closed owner/repo#212 (merged)",
          itemIds: [whenMerged.id],
          provenance: { _tag: "system" },
        });
        assert.strictEqual((yield* pending("github")).length, 0);

        assert.strictEqual(yield* redeliver("gh-1", pullRequest()), "duplicate");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_trigger_inbox SET consumed_at = NULL WHERE org_id = ${orgId}`;
        yield* drain;
        assert.strictEqual((yield* events).length, 2);
        assert.strictEqual((yield* pending("github")).length, 0);
      }),
    ),
  );

  it.effect("drops untracked traffic, keeps tracked items and mentions, and batches notices", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const untracked = {
          ...pullRequest(),
          pull_request: { number: 999, title: "unrelated", head: { sha: "abc" } },
        };
        yield* deliver("untracked", untracked);
        yield* deliver(
          "push",
          { repository: { full_name: "owner/repo" }, sender: { login: "human" }, after: "abc" },
          "push",
        );
        yield* drain;
        assert.lengthOf(yield* events, 0);
        yield* deliver("tracked", {
          ...pullRequest(),
          pull_request: { number: 212, merged: true, head: { sha: "abc" } },
        });
        yield* drain;
        const first = yield* sql<{
          not_before: number;
        }>`SELECT not_before FROM kin_events WHERE org_id = ${orgId} AND tag = 'github' ORDER BY event_id`;
        yield* TestClock.adjust("1 minute");
        yield* deliver("mention", { ...untracked, comment: { body: "Please check @kin[bot]" } });
        yield* drain;
        const deadlines = yield* sql<{
          not_before: number;
        }>`SELECT not_before FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`;
        assert.lengthOf(deadlines, 3);
        assert.isTrue(deadlines.every((row) => row.not_before === first[0]?.not_before));
        const queue = yield* KinEventQueue.KinEventQueue;
        yield* TestClock.adjust("80 seconds");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const claimed = yield* queue.claim({
              orgId,
              agentId: KinAgentId.make("lead"),
              wakeupId: KinWakeupId.make("batch"),
              model: "test",
            });
            assert.lengthOf(claimed, 3);
          }),
        );
      }),
    ),
  );

  it.effect("keeps memory-linked issues and worker PR CI, scoped to the repository", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
        VALUES (${orgId}, 'worker-wake', 'lead', 'test', 0, 'completed', '[]')`;
        yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at, pull_request_url)
        VALUES ('worker', ${orgId}, 'lead', 'worker-wake', 'build', 'worker-thread', '{}', '{}', 'done', 0, 'https://github.com/OWNER/REPO/pull/888')`;
        yield* sql`INSERT INTO kin_agents VALUES ('other-lead', ${orgId}, 'Other', 'lead', 'owner', ${timestamp}, NULL)`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES ('other-lead', ${orgId}, 'Other', 0, '{}', '[]', 'chat')`;
        yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids)
          VALUES (${orgId}, 'other-wake', 'other-lead', 'test', 0, 'completed', '[]')`;
        yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at, pull_request_url)
          VALUES ('other-worker', ${orgId}, 'other-lead', 'other-wake', 'build', 'other-thread', '{}', '{}', 'done', 0, 'https://github.com/owner/repo/pull/889')`;
        yield* deliver("other-lead", { ...pullRequest(), pull_request: { number: 889 } });
        yield* deliver(
          "linked-issue",
          {
            repository: { full_name: "owner/repo" },
            issue: { number: 777 },
            sender: { login: "human" },
          },
          "issue_comment",
        );
        yield* deliver(
          "worker-ci",
          {
            repository: { full_name: "owner/repo" },
            check_suite: { head_sha: "abc", pull_requests: [{ number: 888 }] },
            sender: { login: "human" },
          },
          "check_suite",
        );
        yield* deliver("foreign", {
          ...pullRequest(),
          repository: { full_name: "owner/elsewhere" },
          pull_request: { number: 888 },
        });
        yield* drain;
        assert.deepStrictEqual((yield* events).map((event) => event.dedupeKey).sort(), [
          "linked-issue",
          "worker-ci",
        ]);
        yield* sql`UPDATE kin_workers SET pull_request_url = NULL, repository_key = 'github.com/owner/repo'
          WHERE org_id = ${orgId} AND worker_id = 'worker'`;
        yield* deliver("worker-opened", {
          ...pullRequest(),
          pull_request: {
            number: 890,
            head: { sha: "abc", ref: "kin/worker/worker", repo: { full_name: "owner/repo" } },
          },
        });
        yield* drain;
        assert.lengthOf(yield* events, 3);
      }),
    ),
  );

  it.effect.each([
    { name: "truncated", payload: pullRequest({ padding: "x".repeat(70_000) }), remove: false },
    { name: "missing", payload: pullRequest(), remove: true },
  ])("falls back to one github_recheck for a $name delivery", ({ payload, remove }) =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        const deliveryId = yield* deliver("gh-2", payload);
        const sql = yield* SqlClient.SqlClient;
        if (remove)
          yield* sql`DELETE FROM scheduled_task_webhook_deliveries WHERE delivery_id = ${deliveryId}`;
        yield* drain;
        yield* drain;
        const [fire] = yield* pending("github");
        assert.isUndefined(fire);
        const rechecks = yield* pending("github_recheck");
        assert.strictEqual(rechecks.length, 1);
        assert.deepStrictEqual(rechecks[0]?.payload, {
          kind: "github_recheck",
          repo: null,
          reason: remove ? "delivery_missing" : "body_unparseable",
          sourceFireId: KinTriggerFireId.make(`gh:${orgId}:${deliveryId}`),
        });
        assert.strictEqual((yield* events).length, 0);
      }),
    ),
  );

  it.effect("consumes out-of-scope repos without an event", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        yield* deliver("gh-3", pullRequest({ repo: "owner/elsewhere" }));
        yield* drain;
        assert.strictEqual((yield* pending("github")).length, 0);
        assert.strictEqual((yield* pending("github_recheck")).length, 0);
        assert.strictEqual((yield* events).length, 0);
      }),
    ),
  );

  it.effect("drops a pull_request header whose body is an issue", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        const { pull_request: _, ...issue } = pullRequest();
        yield* deliver("gh-5", { ...issue, issue: { number: 212 } });
        yield* drain;
        assert.strictEqual((yield* events).length, 0);
        const [recheck] = yield* pending("github_recheck");
        assert.include(recheck?.payload, { reason: "body_unparseable" });
      }),
    ),
  );

  it.effect("still enqueues the event while memory is down, without matching conditions", () =>
    run(({ deliver, drain, memoryDown }) =>
      Effect.gen(function* () {
        yield* Ref.set(memoryDown, true);
        yield* deliver("gh-4", pullRequest());
        yield* drain;
        assert.deepStrictEqual(
          (yield* events).map((event) => event._tag),
          ["github"],
        );
        assert.strictEqual((yield* pending("github")).length, 0);
      }),
    ),
  );

  it.effect("backs a failing fire off before retrying it", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        yield* queueDown(true);
        yield* deliver("gh-6", pullRequest());
        yield* drain;
        yield* queueDown(false);
        yield* drain;
        assert.strictEqual((yield* events).length, 0);
        assert.strictEqual((yield* pending("github")).length, 1);
        yield* TestClock.adjust("1 minute");
        yield* drain;
        assert.strictEqual((yield* events).length, 2);
        assert.strictEqual((yield* pending("github")).length, 0);
      }),
    ),
  );

  it.effect("consumes a fire at once when its delivery id is queued as another event", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        const queue = yield* KinEventQueue.KinEventQueue;
        yield* queue.enqueue(
          decodeEvent(
            JSON.stringify({
              _tag: "watchdog",
              orgId,
              eventId: "event-taken",
              agentId: "lead",
              receivedAt: "2026-11-09T00:00:00.000Z",
              dedupeKey: "gh-9",
              provenance: { _tag: "system" },
              finding: "Taken",
              itemIds: [],
            }),
          ),
        );
        yield* deliver("gh-9", pullRequest());
        yield* drain;
        assert.strictEqual((yield* pending("github")).length, 0);
        assert.deepStrictEqual(
          (yield* events).map((event) => event.eventId),
          ["event-taken"],
        );
      }),
    ),
  );

  it.effect("turns a fire still failing after 24 hours into a stale recheck", () =>
    run(({ deliver, drain }) =>
      Effect.gen(function* () {
        yield* queueDown(true);
        const deliveryId = yield* deliver("gh-7", pullRequest());
        yield* drain;
        assert.strictEqual((yield* pending("github")).length, 1);
        yield* TestClock.adjust("25 hours");
        yield* drain;
        assert.strictEqual((yield* pending("github")).length, 0);
        assert.strictEqual((yield* events).length, 0);
        const [recheck] = yield* pending("github_recheck");
        assert.deepStrictEqual(recheck?.payload, {
          kind: "github_recheck",
          repo: null,
          reason: "stale",
          sourceFireId: KinTriggerFireId.make(`gh:${orgId}:${deliveryId}`),
        });
      }),
    ),
  );

  it.effect("the tick consumes fires whose source was removed", () =>
    run(({ deliver, tick }) =>
      Effect.gen(function* () {
        yield* deliver("gh-8", pullRequest());
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM kin_webhook_sources WHERE org_id = ${orgId}`;
        yield* tick;
        assert.strictEqual((yield* pending("github")).length, 0);
        assert.strictEqual((yield* pending("github_recheck")).length, 0);
        assert.strictEqual((yield* events).length, 0);
      }),
    ),
  );
});

describe("KinGithubRepoScope", () => {
  const scope = (env: Record<string, string>) =>
    Effect.service(GithubEvents.KinGithubRepoScope).pipe(
      Effect.map(({ repos }) => repos),
      Effect.provide(
        GithubEvents.repoScopeLayer.pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        ),
      ),
    );
  it.effect.each([
    { name: "unset", env: {}, repos: [] },
    { name: "empty", env: { KIN_GITHUB_REPOS: " , " }, repos: [] },
    {
      name: "spaced",
      env: { KIN_GITHUB_REPOS: " owner/repo , Owner/Other " },
      repos: ["owner/repo", "Owner/Other"],
    },
    { name: "invalid", env: { KIN_GITHUB_REPOS: "owner/repo,not a repo" }, repos: [] },
  ])("$name", ({ env, repos }) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* scope(env), repos);
    }),
  );
});

describe("githubEventFromDelivery", () => {
  const delivery = (event: string, payload: unknown) => ({
    id: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
    receivedAt: timestamp,
    headers: { "x-github-event": event, "x-github-delivery": "gh" },
    body: JSON.stringify(payload),
    bodyTruncated: false,
  });
  it.each([
    { event: "ping", payload: { zen: "hi" }, tag: "drop" },
    { event: "installation", payload: pullRequest(), tag: "drop" },
    { event: "Pull-Request", payload: pullRequest(), tag: "recheck" },
    { event: "push", payload: pullRequest(), tag: "recheck" },
  ])("$event becomes a $tag", ({ event, payload, tag }) => {
    assert.strictEqual(
      GithubEvents.githubEventFromDelivery(orgId, delivery(event, payload))._tag,
      tag,
    );
  });
});

describe("matchConditions", () => {
  const facts = {
    event: "pull_request",
    action: "closed",
    repo: "owner/repo",
    number: 212,
    merged: true,
  };
  it.each([
    { name: "a merge of #212", change: {}, item: whenMerged, matches: true },
    { name: "a close without merge", change: { merged: false }, item: whenMerged, matches: false },
    { name: "another PR", change: { number: 213 }, item: whenMerged, matches: false },
    {
      name: "a repo-scoped condition elsewhere",
      change: { repo: "owner/other" },
      item: item("scoped", { ...whenMerged.on, repo: "owner/repo" }),
      matches: false,
    },
    {
      name: "a done item",
      change: {},
      item: item("done", whenMerged.on, { status: "done" }),
      matches: false,
    },
  ])("$name", ({ change, item, matches }) => {
    assert.strictEqual(
      GithubEvents.matchConditions({ ...facts, ...change }, [item]).length === 1,
      matches,
    );
  });
});
