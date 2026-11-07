// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Crypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  KinOrgId,
  MessageId,
  KinTriggerFired,
  KinWebhookSource,
  OrchestrationV2ThreadProjectionJson,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KinChatRepository from "../chat/KinChatRepository.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";

const timestamp = "2026-11-07T00:00:00.000Z";
const orgA = KinOrgId.make("org-a");
const orgB = KinOrgId.make("org-b");
const decodeSource = Schema.decodeUnknownSync(KinWebhookSource);
const decodeProjection = Schema.decodeSync(OrchestrationV2ThreadProjectionJson);
const decodeUpsert = Schema.decodeEffect(ScheduledTaskUpsertInput);
const decodeFire = Schema.decodeEffect(KinTriggerFired);
const projection = (orgId: KinOrgId) =>
  decodeProjection({
    thread: {
      id: `inbox-${orgId}`,
      projectId: `project-${orgId}`,
      title: "Inbox",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: `inbox-${orgId}` },
      forkedFrom: null,
      createdBy: "system",
      creationSource: "server",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: timestamp,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: timestamp,
  });

const database = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(1794009600000);
  const sql = yield* SqlClient.SqlClient;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_people VALUES (${`person-${org}`}, ${org}, 'owner', 'Owner', NULL, ${timestamp})`;
    yield* sql`INSERT INTO kin_agents VALUES (${`agent-${org}`}, ${org}, 'Lead', 'lead', ${`person-${org}`}, ${timestamp}, NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${`inbox-${org}`}, ${`project-${org}`}, 'Inbox', 'codex', 'approval-required', 'plan', ${timestamp}, ${timestamp}, '{}')`;
  }
});

function source(orgId: KinOrgId) {
  return decodeSource({
    id: "source",
    orgId,
    repo: "owner/repo",
    scheduledTaskId: `task-${orgId}`,
    inboxThreadId: `inbox-${orgId}`,
    githubHookId: null,
    botLogin: "kin[bot]",
    status: "active",
  });
}

const upsert = (id: string, orgId = orgA) =>
  decodeUpsert({
    id,
    title: "Kin webhook",
    prompt: "Do nothing",
    enabled: true,
    projectId: `project-${orgId}`,
    threadId: null,
    threadMode: "new_thread",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    schedule: {
      type: "webhook",
      signature: {
        header: "x-hub-signature-256",
        encoding: "hex",
        prefix: "sha256=",
        secret: "test-secret",
      },
      dedupe: { replayKey: "{{headers.x-github-delivery}}" },
      filters: [{ path: "body.sender.login", op: "notEquals", value: "kin[bot]" }],
    },
  });

// The runWebhookDelivery span ends after both delivery and run completion are persisted.
const waitForDispatch = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === "ScheduledTaskService.runWebhookDelivery")
            Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    const result = yield* work.pipe(Effect.withTracer(tracer));
    yield* Deferred.await(done);
    return result;
  });

const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadProjection: (id) => Effect.succeed(projection(id === `inbox-${orgB}` ? orgB : orgA)),
});

const withService = <A, E, R>(
  body: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
    launches: ThreadLaunchService.ThreadLaunchInput[],
    sends: ThreadManagementService.ThreadManagementSendInput[],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
    const sends: ThreadManagementService.ThreadManagementSendInput[] = [];
    const boundThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadProjection: (id) => Effect.succeed(projection(id === `inbox-${orgB}` ? orgB : orgA)),
      sendToThread: (input) =>
        Effect.gen(function* () {
          sends.push(input);
          return yield* new OrchestratorCommandRejectedError({
            commandId: input.commandId,
            commandType: "test.inner_send",
          });
        }),
    });
    const inner = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return {
            threadId: projection(orgA).thread.id,
            projection: projection(orgA),
            resumed: false,
          };
        }),
    });
    const serviceLayer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          KinTriggerSink.wrapTaskDispatch(inner, boundThreads),
          Crypto.layer,
          Scheduler.layer,
          ManagedPolicy.layerTest(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.succeed(
            ScheduledTaskService.ScheduledTaskWebhookOrigin,
            Effect.succeed({ relayHookBaseUrl: null }),
          ),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* ScheduledTaskService.ScheduledTaskService, launches, sends);
    }).pipe(Effect.provide(serviceLayer));
  });

const request = (
  task: { id: string; webhook?: { path: string } | undefined },
  githubDelivery: string,
  sender = "owner",
) => {
  const bodyText = JSON.stringify({ sender: { login: sender }, orgId: orgB, sourceId: "foreign" });
  return {
    hookId: task.id,
    token: task.webhook?.path.split("/").at(-1) ?? "",
    method: "POST",
    path: "/api/hooks",
    query: "",
    bodyText,
    body: new TextEncoder().encode(bodyText),
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": githubDelivery,
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "test-secret").update(bodyText).digest("hex")}`,
    },
  };
};

const services = Layer.mergeAll(
  KinChatRepository.layer,
  KinTriggerStore.layer,
  KinTriggerInbox.layer,
  KinTriggerSink.layer,
).pipe(Layer.provide(threads));

describe("KinTriggerSink", () => {
  it.effect(
    "routes signed deliveries once per org without launching agents and preserves non-Kin dispatch",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sink = yield* KinTriggerSink.KinTriggerSink;
        const sql = yield* SqlClient.SqlClient;
        yield* withService((service, launches) =>
          Effect.gen(function* () {
            for (const org of [orgA, orgB]) {
              const { task } = yield* service.upsert(yield* upsert(`task-${org}`, org));
              assert.deepStrictEqual(yield* store.registerSource(source(org)), source(org));
              assert.deepStrictEqual(yield* store.registerSource(source(org)), source(org));
              const first = yield* waitForDispatch(
                service.triggerWebhook(request(task, "github-delivery")),
              );
              assert.strictEqual(first._tag, "accepted");
              if (first._tag !== "accepted") return;
              const repository = yield* KinChatRepository.KinChatRepository;
              assert.isTrue(
                Option.isNone(
                  yield* repository.getAgentThread({
                    orgId: org,
                    threadId: source(org).inboxThreadId,
                  }),
                ),
              );
              const pending = yield* inbox.listPending(org);
              assert.strictEqual(pending.length, 1);
              assert.strictEqual(pending[0]?.fireId, `gh:${org}:${first.deliveryId}`);
              assert.strictEqual(pending[0]?.orgId, org);
              assert.deepStrictEqual(pending[0]?.payload, {
                kind: "github",
                sourceId: source(org).id,
                scheduledTaskId: task.id,
                deliveryId: first.deliveryId,
              });
              const view = projection(org);
              const launch = {
                commandId: CommandId.make(`scheduled-task:${task.id}:webhook:${first.deliveryId}`),
                projectId: view.thread.projectId,
                title: "Kin",
                modelSelection: view.thread.modelSelection,
                runtimeMode: view.thread.runtimeMode,
                interactionMode: view.thread.interactionMode,
                workspaceStrategy: { type: "root" },
                initialMessage: { scheduledTaskId: task.id, text: "not parsed", attachments: [] },
                createdBy: "system",
                creationSource: "server",
              } satisfies ThreadLaunchService.ThreadLaunchInput;
              assert.strictEqual(
                (yield* sink.receive(launch))?.threadId,
                source(org).inboxThreadId,
              );
              assert.deepStrictEqual(yield* inbox.listPending(org), pending);
              const foreign = yield* Effect.flip(
                sink.receive({
                  ...launch,
                  projectId: projection(org === orgA ? orgB : orgA).thread.projectId,
                }),
              );
              assert.strictEqual(foreign._tag, "ThreadLaunchError");
              const [event] = pending;
              assert.isDefined(event);
              if (event === undefined) return;
              assert.isFalse(yield* inbox.put(event, 0));
              const repeated = yield* service.triggerWebhook(request(task, "github-delivery"));
              assert.strictEqual(repeated._tag === "accepted" && repeated.outcome, "duplicate");
              const second = yield* waitForDispatch(
                service.triggerWebhook(request(task, "another-delivery")),
              );
              assert.strictEqual(second._tag === "accepted" && second.outcome, "accepted");
              assert.strictEqual((yield* inbox.listPending(org)).length, 2);
              const filtered = yield* service.triggerWebhook(request(task, "bot", "kin[bot]"));
              assert.strictEqual(filtered._tag === "accepted" && filtered.outcome, "filtered");
              const { delivery } = yield* service.getWebhookDelivery({
                id: task.id,
                deliveryId: first.deliveryId,
              });
              assert.strictEqual(delivery.headers["x-github-delivery"], "github-delivery");
            }
            yield* sql`CREATE TRIGGER reject_inbox BEFORE INSERT ON kin_trigger_inbox BEGIN SELECT RAISE(ABORT, 'unavailable'); END`;
            const owned = (yield* service.list()).tasks.find(
              (task) => task.id === source(orgA).scheduledTaskId,
            );
            assert.isDefined(owned);
            if (owned === undefined) return;
            const failed = yield* waitForDispatch(
              service.triggerWebhook(request(owned, "persistence-failure")),
            );
            assert.strictEqual(failed._tag, "accepted");
            if (failed._tag === "accepted") {
              const { delivery } = yield* service.getWebhookDelivery({
                id: owned.id,
                deliveryId: failed.deliveryId,
                acceptAnyOutcome: true,
              });
              assert.strictEqual(delivery.outcome, "dispatch_failed");
            }
            yield* sql`DROP TRIGGER reject_inbox`;
            assert.strictEqual((yield* inbox.listPending(orgA)).length, 2);
            assert.strictEqual(launches.length, 0);
            const { task } = yield* service.upsert(yield* upsert("ordinary"));
            yield* waitForDispatch(service.triggerWebhook(request(task, "ordinary")));
            assert.strictEqual(launches.length, 1);
            assert.strictEqual(launches[0]?.initialMessage?.scheduledTaskId, task.id);
          }),
        );
      }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
  );

  it.effect("fails bound Kin deliveries closed until unbound and preserves other bound sends", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      const inbox = yield* KinTriggerInbox.KinTriggerInbox;
      yield* withService((service, launches, sends) =>
        Effect.gen(function* () {
          const input = yield* upsert("task-org-a");
          yield* service.upsert(input);
          yield* store.registerSource(source(orgA));
          const { task } = yield* service.upsert({
            ...input,
            threadId: projection(orgA).thread.id,
            threadMode: "continue",
          });
          const result = yield* waitForDispatch(service.triggerWebhook(request(task, "bound")));
          assert.strictEqual(result._tag, "accepted");
          if (result._tag !== "accepted") return;
          const { delivery } = yield* service.getWebhookDelivery({
            id: task.id,
            deliveryId: result.deliveryId,
            acceptAnyOutcome: true,
          });
          assert.strictEqual(delivery.outcome, "dispatch_failed");
          const recorded = (yield* service.list()).tasks.find((item) => item.id === task.id);
          assert.strictEqual(recorded?.lastRunStatus, "failed");
          assert.include(recorded?.lastRunError ?? "", "kin.trigger.bound_source");
          assert.deepStrictEqual(yield* inbox.listPending(orgA), []);
          assert.lengthOf(sends, 0);
          assert.lengthOf(launches, 0);
          const { task: unbound } = yield* service.upsert(input);
          yield* waitForDispatch(service.triggerWebhook(request(unbound, "unbound")));
          assert.lengthOf(yield* inbox.listPending(orgA), 1);
          assert.lengthOf(sends, 0);
          assert.lengthOf(launches, 0);
          const ordinary = yield* upsert("ordinary-bound");
          const { task: other } = yield* service.upsert({
            ...ordinary,
            threadId: projection(orgA).thread.id,
            threadMode: "continue",
          });
          yield* waitForDispatch(service.triggerWebhook(request(other, "ordinary-bound")));
          assert.lengthOf(sends, 1);
          assert.strictEqual(sends[0]?.scheduledTaskId, other.id);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TABLE kin_webhook_sources`;
          const lookupFailure = yield* waitForDispatch(
            service.triggerWebhook(request(other, "lookup-failure")),
          );
          assert.strictEqual(lookupFailure._tag, "accepted");
          if (lookupFailure._tag !== "accepted") return;
          const failed = yield* service.getWebhookDelivery({
            id: other.id,
            deliveryId: lookupFailure.deliveryId,
            acceptAnyOutcome: true,
          });
          assert.strictEqual(failed.delivery.outcome, "dispatch_failed");
          assert.lengthOf(yield* inbox.listPending(orgA), 1);
          assert.lengthOf(sends, 1);
          assert.lengthOf(launches, 0);
        }),
      );
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
  );

  it.effect("passes unscheduled sends and other thread methods through unchanged", () =>
    Effect.gen(function* () {
      yield* seed;
      const sent: ThreadManagementService.ThreadManagementSendInput[] = [];
      const rejection = new OrchestratorCommandRejectedError({
        commandId: CommandId.make("ordinary-send"),
        commandType: "test.passthrough",
      });
      const getThreadProjection = () => Effect.succeed(projection(orgA));
      const innerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadProjection,
        sendToThread: (input) =>
          Effect.gen(function* () {
            sent.push(input);
            return yield* rejection;
          }),
      });
      yield* Effect.gen(function* () {
        const wrapped = yield* ThreadManagementService.ThreadManagementService;
        assert.strictEqual(wrapped.getThreadProjection, getThreadProjection);
        const input = {
          commandId: rejection.commandId,
          projectId: projection(orgA).thread.projectId,
          threadId: projection(orgA).thread.id,
          messageId: MessageId.make("ordinary-message"),
          text: "unchanged",
          attachments: [],
          mode: "queue",
          createdBy: "system",
          creationSource: "server",
        } satisfies ThreadManagementService.ThreadManagementSendInput;
        assert.strictEqual(yield* Effect.flip(wrapped.sendToThread(input)), rejection);
        assert.strictEqual(sent[0], input);
      }).pipe(
        Effect.provide(
          KinTriggerSink.wrapTaskDispatch(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            innerThreads,
          ),
        ),
      );
    }).pipe(Effect.provide(database)),
  );

  it.effect(
    "rejects foreign registrations and malformed owned dispatches without writing an inbox row",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sink = yield* KinTriggerSink.KinTriggerSink;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        yield* withService((service) =>
          Effect.gen(function* () {
            yield* service.upsert(yield* upsert("task-org-a"));
            const a = source(orgA);
            yield* store.registerSource(a);
            for (const candidate of [
              { ...a, orgId: orgB },
              { ...a, inboxThreadId: source(orgB).inboxThreadId },
              { ...a, scheduledTaskId: source(orgB).scheduledTaskId },
            ]) {
              const error = yield* Effect.flip(store.registerSource(candidate));
              assert.strictEqual(error._tag, "KinWebhookSourceConflict");
              if ("reason" in error) assert.strictEqual(error.reason, "unknown_source");
            }
            yield* store.registerSource(a);
            const conflict = yield* Effect.flip(
              store.registerSource({ ...a, repo: "changed/repo" }),
            );
            assert.strictEqual(conflict._tag, "KinWebhookSourceConflict");
            const base = {
              commandId: CommandId.make("manual"),
              projectId: projection(orgA).thread.projectId,
              title: "Kin",
              modelSelection: projection(orgA).thread.modelSelection,
              runtimeMode: projection(orgA).thread.runtimeMode,
              interactionMode: projection(orgA).thread.interactionMode,
              workspaceStrategy: { type: "root" },
              initialMessage: {
                scheduledTaskId: a.scheduledTaskId,
                text: "untrusted",
                attachments: [],
              },
              createdBy: "system",
              creationSource: "server",
            } satisfies ThreadLaunchService.ThreadLaunchInput;
            for (const commandId of [
              "manual",
              `scheduled-task:${a.scheduledTaskId}:webhook:`,
              `scheduled-task:${a.scheduledTaskId}:webhook:unknown`,
            ]) {
              const error = yield* Effect.flip(
                sink.receive({ ...base, commandId: CommandId.make(commandId) }),
              );
              assert.strictEqual(error._tag, "ThreadLaunchError");
            }
            for (const payload of [
              { sourceId: "unknown", scheduledTaskId: a.scheduledTaskId },
              { sourceId: a.id, scheduledTaskId: source(orgB).scheduledTaskId },
            ]) {
              const event = yield* decodeFire({
                fireId: `gh:${orgA}:unknown`,
                orgId: orgA,
                dueAt: timestamp,
                firedAt: timestamp,
                lateByMs: 0,
                payload: { kind: "github", deliveryId: "unknown", ...payload },
              });
              const error = yield* Effect.flip(inbox.put(event, 0));
              assert.strictEqual(error._tag, "KinTriggerInboxConflict");
            }
            assert.deepStrictEqual(yield* inbox.listPending(orgA), []);
            yield* store.unregisterSource(orgB, a.id);
            assert.deepStrictEqual(yield* store.sourceByTaskId(a.scheduledTaskId), a);
            yield* store.unregisterSource(orgA, a.id);
            assert.isUndefined(yield* store.sourceByTaskId(a.scheduledTaskId));
          }),
        );
      }).pipe(Effect.provide(services.pipe(Layer.provideMerge(database)))),
  );
});
