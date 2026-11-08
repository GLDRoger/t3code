import { assert, describe, it } from "@effect/vitest";
import {
  KIN_GITHUB_APP_SOURCE,
  KinEvent,
  KinOrgId,
  KinWebhookSource,
  ManagedPolicyDocument,
  MemoryItemHead,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import type * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as JudgeShadow from "../floor/JudgeShadow.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Memory from "../memory/Memory.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as GithubEvents from "./githubEvents.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import * as Watchdogs from "./watchdogs.ts";
import {
  projection,
  signedRequest,
  timestamp,
  waitForDispatch,
  webhookTask,
  withScheduledTasks,
} from "./webhooks.testkit.ts";

const NOW = 1794009600000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const orgId = KinOrgId.make("org-a");
const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);
const decodeEvent = Schema.decodeSync(Schema.fromJsonString(KinEvent));
const decodePolicy = Schema.decodeEffect(ManagedPolicyDocument);
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

const item = (id: string, overrides: Record<string, unknown> = {}) =>
  decodeHead({
    orgId,
    id,
    path: `commitments/${id}.md`,
    kind: "commitment",
    title: id,
    status: "open",
    due: null,
    chat: "team",
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

type State = Watchdogs.GithubItemState;
const issue = (number: number, state: State["state"]): State => ({
  number,
  kind: "issue",
  state,
  reviewRequests: [],
});
const pull = (
  number: number,
  state: State["state"],
  reviewRequests: State["reviewRequests"] = [],
): State => ({ number, kind: "pull", state, reviewRequests });

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Kin', ${timestamp})`;
  yield* sql`INSERT INTO kin_people VALUES ('owner', ${orgId}, 'owner', 'Owner', 'owner-gh', ${timestamp})`;
  yield* sql`INSERT INTO kin_people VALUES ('alice', ${orgId}, 'alice', 'Alice', 'Alice-GH', ${timestamp})`;
  yield* sql`INSERT INTO kin_agents VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${timestamp}, NULL)`;
  for (const chat of ["chat", "team"])
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${chat}, ${orgId}, ${chat === "chat" ? "direct" : "team_group"}, ${chat === "chat" ? "direct" : null}, 0, ${timestamp})`;
  for (const [member, chat, person] of [
    ["m-owner", "chat", "owner"],
    ["m-owner-team", "team", "owner"],
    ["m-alice", "team", "alice"],
  ] as const)
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${member}, ${orgId}, ${chat}, 'person', ${person}, ${person === "owner" ? "owner" : "member"}, ${timestamp})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', 'chat')`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${`inbox-${orgId}`}, ${`project-${orgId}`}, 'Inbox', 'codex', 'approval-required', 'plan', ${timestamp}, ${timestamp}, '{}')`;
});

/** A `github_recheck` request as TRIG-6 leaves it; the sweep only reads and consumes it. */
const putRecheck = (delivery: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fireId = `gh:${orgId}:recheck:delivery:${delivery}`;
    yield* sql`INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at)
      VALUES (${fireId}, ${orgId}, ${JSON.stringify({
        fireId,
        orgId,
        dueAt: iso(NOW),
        firedAt: iso(NOW),
        lateByMs: 0,
        payload: {
          kind: "github_recheck",
          repo: null,
          reason: "delivery_missing",
          sourceFireId: `gh:${orgId}:delivery:${delivery}`,
        },
      })}, ${NOW})`;
    return fireId;
  });

const pendingRechecks = Effect.gen(function* () {
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  return (yield* inbox.listPending(orgId, 100, undefined, ["github_recheck"])).length;
});

const watchdogEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ json: string }>`SELECT json FROM kin_events
    WHERE org_id = ${orgId} AND tag = 'watchdog' ORDER BY dedupe_key`;
  return rows.flatMap((row) => {
    const event = decodeEvent(row.json);
    return event._tag === "watchdog"
      ? [{ finding: event.finding, itemIds: event.itemIds.map((id): string => id) }]
      : [];
  });
});

const pingsFor = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ person: string; itemId: string }>`SELECT person, item_id AS "itemId"
    FROM kin_ping_items WHERE org_id = ${orgId} ORDER BY person, item_id`;
});

const notices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ body: string }>`SELECT body FROM kin_messages
    WHERE org_id = ${orgId} AND chat_id = 'chat' AND author_kind = 'system' ORDER BY seq`;
  return rows.map((row) => row.body);
});

interface Harness {
  readonly items: Ref.Ref<ReadonlyArray<MemoryItemHead>>;
  readonly index: Ref.Ref<string>;
  readonly rebuilds: Ref.Ref<number>;
  readonly ticks: Map<string, Effect.Effect<void>>;
}

function services(harness: Harness) {
  const memory = Layer.unwrap(
    Effect.map(SqlClient.SqlClient, (sql) => {
      // Memory takes an org lock that a memory load holds while it waits for the SQLite writer.
      const outside = <A, E>(name: string, effect: Effect.Effect<A, E>) =>
        Effect.serviceOption(sql.transactionService).pipe(
          Effect.flatMap((open) =>
            Option.isSome(open) ? Effect.die(`Memory.${name} ran inside a transaction`) : effect,
          ),
        );
      return Layer.mock(Memory.Memory)({
        query: (org, query) =>
          outside(
            "query",
            Ref.get(harness.items).pipe(
              Effect.map((items) =>
                items
                  .filter((head) => head.orgId === org)
                  .filter((head) => query.status === undefined || head.status === query.status)
                  .map((head) => ({ ...head, duplicate: false })),
              ),
            ),
          ),
        readIndex: () => outside("readIndex", Ref.get(harness.index)),
        rebuildIndex: () =>
          outside(
            "rebuildIndex",
            Ref.update(harness.rebuilds, (n) => n + 1),
          ),
      });
    }),
  );
  return Layer.mergeAll(
    memory,
    Chat.layer.pipe(Layer.provide(JudgeShadow.layerOff), Layer.provideMerge(Hub.layer)),
    Layer.succeed(GithubEvents.KinGithubRepoScope, { repos: ["Owner/Repo"] }),
    Layer.succeed(Scheduler.Scheduler, {
      register: Effect.fn("KinWatchdogsTest.register")(function* <E, R>(
        name: string,
        work: Effect.Effect<void, E, R>,
      ) {
        const context = yield* Effect.context<R>();
        harness.ticks.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
      }),
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Repository.layer,
        KinTriggerStore.layer,
        KinTriggerInbox.layer,
        KinEventQueue.layer,
      ),
    ),
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadProjection: () => Effect.succeed(projection(orgId)),
      }),
    ),
    Layer.provideMerge(
      KinPersistence.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
      ),
    ),
  );
}

/** Builds the service in the caller's context, so a fake reader or T3 tasks there reach its tick. */
const build = Effect.provide(Effect.service(Watchdogs.KinWatchdogs), Watchdogs.layer);

/** Seeded state with these memory items; GitHub is always a fake passed per call. */
const run = <A, E, R>(
  items: ReadonlyArray<MemoryItemHead>,
  body: (harness: Harness) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const harness: Harness = {
      items: yield* Ref.make(items),
      index: yield* Ref.make(`As of ${iso(NOW)}\n`),
      rebuilds: yield* Ref.make(0),
      ticks: new Map(),
    };
    return yield* Effect.gen(function* () {
      yield* seed;
      return yield* body(harness);
    }).pipe(Effect.provide(services(harness)));
  });

/** A fake GitHub that records each batched read: `repo:numbers`. */
const fakeGithub = (states: ReadonlyArray<State>, reads: Array<string>, fail = false) => ({
  readRepo: (org: KinOrgId, repo: string, numbers: ReadonlyArray<number>) => {
    reads.push(`${repo}:${numbers.join(",")}`);
    return fail
      ? Effect.fail(
          new Watchdogs.KinWatchdogGithubError({ orgId: org, repo, reason: "unavailable" }),
        )
      : Effect.succeed(states.filter((state) => numbers.includes(state.number)));
  },
});
const withGithub = (reader: Watchdogs.KinWatchdogGithubReaderShape | null) =>
  Effect.provideService(Watchdogs.KinWatchdogGithubReader, reader);

describe("github_recheck", () => {
  const closesIssue = item("ship-login", { links: ["https://github.com/owner/repo/issues/7"] });
  const mergesPr = item("rate-limit", {
    kind: "deferral",
    path: "deferrals/rate-limit.md",
    links: ["owner/repo#9"],
  });
  const halfDone = item("two-links", {
    links: ["https://github.com/owner/repo/issues/7", "https://github.com/owner/repo/issues/8"],
  });
  const outOfScope = item("elsewhere", { links: ["https://github.com/other/repo/issues/7"] });
  const condition = item("when-212-merges", {
    kind: "deferral",
    path: "deferrals/when-212-merges.md",
    on: { event: "pull_request", action: "closed", merged: true, number: 212 },
  });
  const states = [issue(7, "closed"), issue(8, "open"), pull(9, "merged"), pull(212, "merged")];

  it.effect(
    "queues a code-only watchdog event naming the commitment and the closed issue as evidence",
    () =>
      run([closesIssue, mergesPr, halfDone, outOfScope, condition], () =>
        Effect.gen(function* () {
          const service = yield* build;
          yield* putRecheck("1");
          const reads: Array<string> = [];
          yield* service.run("github_recheck", orgId).pipe(withGithub(fakeGithub(states, reads)));

          // One batched read for the scoped repo; the out-of-scope link is never read.
          assert.deepEqual(reads, ["owner/repo:7,8,9,212"]);
          assert.deepEqual(yield* watchdogEvents, [
            {
              finding:
                "GitHub state shows condition met (read from GitHub by code): https://github.com/Owner/Repo/pull/212 is merged.",
              itemIds: ["when-212-merges"],
            },
            {
              finding:
                "Verified on GitHub by code: https://github.com/owner/repo/pull/9 is merged. Mark deferral rate-limit done and record that link as its evidence.",
              itemIds: ["rate-limit"],
            },
            {
              finding:
                "Verified on GitHub by code: https://github.com/owner/repo/issues/7 is closed. Mark commitment ship-login done and record that link as its evidence.",
              itemIds: ["ship-login"],
            },
          ]);
          assert.equal(yield* pendingRechecks, 0);

          // A later sweep reads again but queues nothing new for the same findings.
          yield* putRecheck("2");
          yield* service.run("github_recheck", orgId).pipe(withGithub(fakeGithub(states, reads)));
          assert.equal(reads.length, 2);
          assert.equal((yield* watchdogEvents).length, 3);
          assert.equal(yield* pendingRechecks, 0);
        }),
      ),
  );

  it.effect("leaves recheck requests pending until a reader reads every repo", () =>
    run([closesIssue], () =>
      Effect.gen(function* () {
        const service = yield* build;
        yield* putRecheck("1");
        // The default reader is unavailable: nothing is read, queued or consumed.
        yield* service.run("github_recheck", orgId);
        assert.equal(yield* pendingRechecks, 1);

        const reads: Array<string> = [];
        yield* service
          .run("github_recheck", orgId)
          .pipe(withGithub(fakeGithub([issue(7, "closed")], reads, true)));
        assert.equal(yield* pendingRechecks, 1);
        assert.deepEqual(yield* watchdogEvents, []);

        // A read that never answers times out instead of holding the tick.
        const hung = yield* service
          .run("github_recheck", orgId)
          .pipe(withGithub({ readRepo: () => Effect.never }), Effect.forkChild);
        yield* TestClock.adjust("30 seconds");
        yield* Fiber.join(hung);
        assert.equal(yield* pendingRechecks, 1);

        yield* service
          .run("github_recheck", orgId)
          .pipe(withGithub(fakeGithub([issue(7, "closed")], reads)));
        assert.equal(yield* pendingRechecks, 0);
        assert.equal((yield* watchdogEvents).length, 1);
      }),
    ),
  );
});

describe("chases", () => {
  it.effect("promise_overdue chases whoever promised an overdue commitment, once", () =>
    run(
      [
        item("overdue", { owner: "alice", due: iso(NOW - HOUR) }),
        item("later", { owner: "alice", due: iso(NOW + DAY) }),
        item("done", { owner: "alice", due: iso(NOW - DAY), status: "done" }),
      ],
      () =>
        Effect.gen(function* () {
          const service = yield* build;
          yield* service.run("promise_overdue", orgId);
          yield* service.run("promise_overdue", orgId);
          assert.deepEqual(yield* pingsFor, [{ person: "alice", itemId: "overdue" }]);
        }),
    ),
  );

  it.effect("stale_review chases a reviewer requested over 24 hours ago", () =>
    run([item("review-me", { links: ["https://github.com/owner/repo/pull/5"] })], () =>
      Effect.gen(function* () {
        const service = yield* build;
        const states = [
          pull(5, "open", [
            { login: "alice-gh", requestedAt: NOW - 25 * HOUR },
            { login: "owner-gh", requestedAt: NOW - 2 * HOUR },
          ]),
        ];
        yield* service.run("stale_review", orgId);
        assert.deepEqual(yield* pingsFor, []);
        yield* service.run("stale_review", orgId).pipe(withGithub(fakeGithub(states, [])));
        assert.deepEqual(yield* pingsFor, [{ person: "alice", itemId: "review-me" }]);
      }),
    ),
  );

  it.effect("an answered chase stays answered until its due date moves", () =>
    run(
      [
        item("both", {
          owner: "alice",
          due: iso(NOW - HOUR),
          links: ["owner/repo#5", "owner/repo#6"],
        }),
      ],
      ({ items }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const service = yield* build;
          const stale = { login: "alice-gh", requestedAt: NOW - 25 * HOUR };
          const github = withGithub(
            fakeGithub([pull(5, "open", [stale]), pull(6, "open", [stale])], []),
          );
          const sweep = Effect.gen(function* () {
            yield* service.run("promise_overdue", orgId);
            yield* service.run("stale_review", orgId).pipe(github);
          });
          const ping = Effect.gen(function* () {
            const [row] = yield* sql<{ request: string; stoppedAt: number | null }>`SELECT
              request_json AS request, stopped_at AS "stoppedAt" FROM kin_ping_items
              WHERE org_id = ${orgId} AND person = 'alice' AND item_id = 'both' ORDER BY item_id`;
            return row;
          });
          yield* sweep;
          const armed = yield* ping;
          assert.isNull(armed?.stoppedAt);

          // Answered: neither the overdue chase nor either stale review re-arms it.
          yield* sql`UPDATE kin_ping_items SET stopped_at = ${NOW} WHERE org_id = ${orgId}`;
          yield* sweep;
          yield* sweep;
          assert.deepEqual(yield* ping, { request: armed?.request ?? "", stoppedAt: NOW });

          yield* Ref.set(items, [item("both", { owner: "alice", due: iso(NOW + HOUR) })]);
          yield* TestClock.adjust(2 * HOUR);
          yield* service.run("promise_overdue", orgId);
          assert.isNull((yield* ping)?.stoppedAt);
        }),
    ),
  );

  it.effect("objective_at_risk flags an objective due within 3 days with open issues", () =>
    run(
      [
        item("launch", {
          kind: "objective",
          path: "objectives/launch.md",
          due: iso(NOW + 2 * DAY),
          links: ["owner/repo#3", "owner/repo#4"],
        }),
        item("someday", {
          kind: "objective",
          path: "objectives/someday.md",
          due: iso(NOW + 5 * DAY),
          links: ["owner/repo#3"],
        }),
      ],
      () =>
        Effect.gen(function* () {
          const service = yield* build;
          const github = withGithub(fakeGithub([issue(3, "open"), issue(4, "closed")], []));
          yield* service.run("objective_at_risk", orgId).pipe(github);
          yield* service.run("objective_at_risk", orgId).pipe(github);
          assert.deepEqual(yield* notices, [
            `An objective due ${iso(NOW + 2 * DAY)} still has open GitHub work: https://github.com/owner/repo/issues/3.\n> \` launch \``,
          ]);
        }),
    ),
  );
});

it.effect("index_freshness rebuilds INDEX.md once it is 36 hours old", () =>
  run([], ({ index, rebuilds }) =>
    Effect.gen(function* () {
      const service = yield* build;
      yield* Ref.set(index, `As of ${iso(NOW - 35 * HOUR)}\n`);
      yield* service.run("index_freshness", orgId);
      assert.equal(yield* Ref.get(rebuilds), 0);
      yield* Ref.set(index, `As of ${iso(NOW - 36 * HOUR)}\n`);
      yield* service.run("index_freshness", orgId);
      assert.equal(yield* Ref.get(rebuilds), 1);
    }),
  ),
);

describe("trigger_reconcile", () => {
  const sourceStatus = Effect.gen(function* () {
    const store = yield* KinTriggerStore.KinTriggerStore;
    return (yield* store.getSource(orgId, source.id))?.status;
  });
  const registered = <E, R>(
    body: (
      tasks: ScheduledTaskService.ScheduledTaskService["Service"],
      reconcile: Effect.Effect<void>,
      taskId: string,
    ) => Effect.Effect<void, E, R>,
  ) =>
    run([], () =>
      withScheduledTasks((tasks) =>
        Effect.gen(function* () {
          const { task } = yield* tasks.upsert(
            yield* webhookTask(source.scheduledTaskId, `project-${orgId}`),
          );
          const store = yield* KinTriggerStore.KinTriggerStore;
          yield* store.registerSource(source);
          yield* store.bindSecret(orgId, source.id, Redacted.make("test-secret"));
          yield* TestClock.adjust("1 second");
          const service = yield* build;
          yield* body(tasks, service.run("trigger_reconcile", orgId).pipe(Effect.orDie), task.id);
        }),
      ),
    );

  it.effect("reports a paused task without re-enabling it, then sees it resume", () =>
    registered((tasks, reconcile, taskId) =>
      Effect.gen(function* () {
        yield* reconcile;
        assert.equal(yield* sourceStatus, "active");
        assert.deepEqual(yield* notices, []);

        yield* tasks.setEnabled({ id: source.scheduledTaskId, enabled: false });
        yield* reconcile;
        yield* reconcile;
        assert.equal(yield* sourceStatus, "paused_in_t3");
        const listed = (yield* tasks.list()).tasks.find((task) => task.id === taskId);
        assert.equal(listed?.enabled, false);
        assert.lengthOf(yield* notices, 1);
        assert.include((yield* notices)[0], "Kin won't turn it back on");

        // The owner turns it on in T3; the sink takes deliveries before the next reconcile.
        const { task } = yield* tasks.setEnabled({ id: source.scheduledTaskId, enabled: true });
        yield* waitForDispatch(
          tasks.triggerWebhook(
            signedRequest(task, "gh-1", {
              action: "opened",
              repository: { full_name: "owner/repo" },
              sender: { login: "alice" },
              pull_request: { number: 1 },
            }),
          ),
        );
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        assert.lengthOf(yield* inbox.listPending(orgId, 10, undefined, ["github"]), 1);
        yield* reconcile;
        assert.equal(yield* sourceStatus, "active");
        assert.deepEqual((yield* notices).at(-1), "GitHub events reach Kin again.");
      }),
    ),
  );

  it.effect("reports a swapped secret once per binding and a deleted task as missing", () =>
    registered((tasks, reconcile) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET webhook_secret = 'agent-chosen-secret'
          WHERE task_id = ${source.scheduledTaskId}`;
        yield* reconcile;
        yield* reconcile;
        assert.equal(yield* sourceStatus, "active");
        assert.lengthOf(yield* notices, 1);
        assert.include((yield* notices)[0], "a secret Kin didn't bind");
        const bound = yield* sql<{ hash: string }>`SELECT secret_sha256 AS hash
          FROM kin_webhook_sources WHERE org_id = ${orgId} AND source_id = ${source.id}`;
        assert.isString(bound[0]?.hash);

        yield* tasks.delete({ id: source.scheduledTaskId });
        yield* reconcile;
        assert.equal(yield* sourceStatus, "missing");
        assert.include((yield* notices).at(-1), "was deleted");
      }),
    ),
  );

  it.effect("reports a task blocked by managed policy", () =>
    run([], () =>
      Effect.gen(function* () {
        yield* withScheduledTasks((tasks) =>
          Effect.gen(function* () {
            yield* tasks.upsert(yield* webhookTask(source.scheduledTaskId, `project-${orgId}`));
            const store = yield* KinTriggerStore.KinTriggerStore;
            yield* store.registerSource(source);
            yield* store.bindSecret(orgId, source.id, Redacted.make("test-secret"));
          }),
        );
        const policy = yield* decodePolicy({
          schemaVersion: 1,
          organization: "Kin",
          limits: { webhookTasks: false },
        });
        yield* withScheduledTasks(
          () =>
            Effect.gen(function* () {
              const service = yield* build;
              yield* service.run("trigger_reconcile", orgId);
            }),
          undefined,
          policy,
        );
        assert.equal(yield* sourceStatus, "blocked_by_policy");
        assert.include((yield* notices)[0], "managed policy");
      }),
    ),
  );

  it.effect("re-arms open deferrals from memory", () =>
    run(
      [
        item("ping-ops", {
          kind: "deferral",
          path: "deferrals/ping-ops.md",
          due: iso(NOW + DAY),
          on_due: "remind",
        }),
      ],
      () =>
        Effect.gen(function* () {
          const service = yield* build;
          yield* service.run("trigger_reconcile", orgId);
          const store = yield* KinTriggerStore.KinTriggerStore;
          const armed = (yield* store.list(orgId)).filter((trigger) => trigger.enabled);
          assert.deepEqual(
            armed.map((trigger) => [trigger.id, trigger.nextRunAt]),
            [["deferral:ping-ops:due", iso(NOW + DAY)]],
          );
        }),
    ),
  );
});

it.effect("the tick runs every watchdog at startup, then each on its own interval", () =>
  run([item("ship-login", { links: ["owner/repo#7"] })], ({ ticks }) =>
    Effect.gen(function* () {
      const reads: Array<string> = [];
      yield* build.pipe(withGithub(fakeGithub([issue(7, "open")], reads)));
      const sql = yield* SqlClient.SqlClient;
      // Retention runs with trigger_reconcile: consumed rows go after 7 days, pending ones stay.
      for (const [fireId, consumedAt] of [
        ["old", NOW - 8 * DAY],
        ["recent", NOW - DAY],
      ] as const)
        yield* sql`INSERT INTO kin_trigger_inbox (fire_id, org_id, payload_json, received_at, consumed_at)
          VALUES (${fireId}, ${orgId}, '{}', ${consumedAt}, ${consumedAt})`;
      const tick = ticks.get("kin-watchdogs") ?? Effect.die("tick not registered");
      yield* tick;
      // github_recheck and stale_review each read once.
      assert.lengthOf(reads, 2);
      const left = yield* sql<{ fireId: string }>`SELECT fire_id AS "fireId" FROM kin_trigger_inbox
        WHERE org_id = ${orgId} ORDER BY fire_id`;
      assert.deepEqual(
        left.map((row) => row.fireId),
        ["recent"],
      );

      yield* TestClock.adjust("5 minutes");
      yield* tick;
      assert.lengthOf(reads, 2);
      yield* TestClock.adjust("5 minutes");
      yield* tick;
      assert.lengthOf(reads, 3);
      yield* TestClock.adjust("20 minutes");
      yield* tick;
      assert.lengthOf(reads, 5);
    }),
  ),
);
