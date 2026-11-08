// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Crypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  KIN_GITHUB_APP_SOURCE,
  KinGithubWebhookRpcs,
  KinOrgId,
  KinMessage,
  KinPersonId,
  KinWebhookSourceId,
  type OrchestrationV2ServerCommand,
  Project,
  ProjectId,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as GithubWebhooks from "./githubWebhooks.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import { makeKinWebhookHandlers } from "./webhookRpcHandlers.ts";
import { projection, timestamp, waitForDispatch } from "./webhooks.testkit.ts";

const orgId = KinOrgId.make("org-a");
const owner = [{ _tag: "person", orgId, personId: KinPersonId.make("owner") }] as const;
const member = [{ _tag: "person", orgId, personId: KinPersonId.make("member") }] as const;
const relay = "https://relay.test/v1/hooks/env";
const project = Schema.decodeSync(Project)({
  id: `project-${orgId}`,
  title: "Kin",
  workspaceRoot: "/projects/kin",
  defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
});

const decodeMessage = Schema.decodeSync(KinMessage);
const noticeMessage = (input: Parameters<KinChatService["Service"]["notice"]>[0]) =>
  decodeMessage({
    orgId: input.orgId,
    chatId: input.chatId,
    messageId: input.messageId,
    seq: 1,
    author: { _tag: "system" },
    authorRole: "owner",
    kind: "system",
    body: input.body,
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    createdAt: timestamp,
    editedAt: null,
  });

const database = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ KIN_ENABLED: true, KIN_GITHUB_BOT_LOGIN: "kin-app[bot]" }),
    ),
  ),
);
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(1794009600000);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Kin', ${timestamp})`;
  for (const person of ["owner", "member"])
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${timestamp})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${timestamp})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('owner-chat', ${orgId}, 'direct', 'direct', 0, ${timestamp})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', 'owner-chat')`;
});

const signed = (
  task: { readonly id: string; readonly webhook?: { readonly path: string } | undefined },
  input: { readonly delivery: string; readonly secret: string; readonly sender?: string },
) => {
  const bodyText = JSON.stringify({ action: "opened", sender: { login: input.sender ?? "dev" } });
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
      "x-github-delivery": input.delivery,
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", input.secret).update(bodyText).digest("hex")}`,
    },
  };
};

const harness = <A, E, R>(
  options: { readonly relayHookBaseUrl?: string | null; readonly gate?: boolean },
  body: (input: {
    readonly webhooks: GithubWebhooks.KinGithubWebhooks["Service"];
    readonly tasks: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly dispatched: ThreadLaunchService.ThreadLaunchInput[];
    readonly inboxLaunches: ThreadLaunchService.ThreadLaunchInput[];
    readonly commands: OrchestrationV2ServerCommand[];
    readonly notices: Parameters<KinChatService["Service"]["notice"]>[0][];
    readonly hookConfigs: Parameters<
      GithubWebhooks.GithubAppHookClient["Service"]["patchHookConfig"]
    >[0][];
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dispatched: ThreadLaunchService.ThreadLaunchInput[] = [];
    const inboxLaunches: ThreadLaunchService.ThreadLaunchInput[] = [];
    const commands: OrchestrationV2ServerCommand[] = [];
    const notices: Parameters<KinChatService["Service"]["notice"]>[0][] = [];
    const hookConfigs: Parameters<
      GithubWebhooks.GithubAppHookClient["Service"]["patchHookConfig"]
    >[0][] = [];
    const archived = () => commands.some((command) => command.type === "thread.archive");
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadProjection: () => Effect.succeed(projection(orgId, archived() ? timestamp : null)),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length, storedEvents: [] };
        }),
      sendToThread: (input) =>
        Effect.fail(
          new OrchestratorCommandRejectedError({
            commandId: input.commandId,
            commandType: "test.inner_send",
          }),
        ),
    });
    const tasksLayer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          KinTriggerSink.wrapTaskDispatch(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) =>
                Effect.sync(() => {
                  dispatched.push(input);
                  return {
                    threadId: projection(orgId).thread.id,
                    projection: projection(orgId),
                    resumed: false,
                  };
                }),
            }),
            threads,
          ),
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
            Effect.succeed({
              relayHookBaseUrl:
                options.relayHookBaseUrl === undefined ? relay : options.relayHookBaseUrl,
            }),
          ),
        ),
      ),
    );
    const webhooksLayer = GithubWebhooks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          threads,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Effect.sync(() => {
                inboxLaunches.push(input);
                const view = projection(orgId, archived() ? timestamp : null);
                return { threadId: view.thread.id, projection: view, resumed: false };
              }),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(id === project.id ? Option.some(project) : Option.none()),
          }),
          Layer.mock(KinChatService)({
            notice: (input) =>
              Effect.sync(() => {
                notices.push(input);
                return { message: noticeMessage(input), waiting: null };
              }),
          }),
          Crypto.layer,
          GithubWebhooks.lockLayer,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      return yield* body({
        webhooks: yield* GithubWebhooks.KinGithubWebhooks,
        tasks: yield* ScheduledTaskService.ScheduledTaskService,
        dispatched,
        inboxLaunches,
        commands,
        notices,
        hookConfigs,
      });
    }).pipe(
      Effect.provide(webhooksLayer.pipe(Layer.provideMerge(tasksLayer))),
      Effect.provideService(GithubWebhooks.AppHookConfigureGate, options.gate ?? false),
      Effect.provideService(GithubWebhooks.GithubAppHookClient, {
        patchHookConfig: (config) => Effect.sync(() => void hookConfigs.push(config)),
      }),
    );
  });

const services = Layer.mergeAll(KinTriggerStore.layer, KinTriggerInbox.layer).pipe(
  Layer.provide(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadProjection: () => Effect.succeed(projection(orgId)),
    }),
  ),
  Layer.provideMerge(database),
);
const ownerSecret = Redacted.make("owner-secret-from-github-app");

describe("KinGithubWebhooks", () => {
  it.effect(
    "creates the App source unbound and signed, then routes signed deliveries to the inbox only",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        const sql = yield* SqlClient.SqlClient;
        yield* harness(
          {},
          ({ webhooks, tasks, dispatched, inboxLaunches, commands, hookConfigs }) =>
            Effect.gen(function* () {
              assert.strictEqual(
                (yield* Effect.flip(webhooks.setup(member, { orgId, projectId: project.id })))
                  .reason,
                "not_allowed",
              );
              assert.strictEqual(
                (yield* Effect.flip(
                  webhooks.setup(owner, { orgId: KinOrgId.make("other"), projectId: project.id }),
                )).reason,
                "not_found",
              );
              const unbotted = yield* webhooks
                .setup(owner, { orgId, projectId: project.id })
                .pipe(
                  Effect.flip,
                  Effect.provide(
                    ConfigProvider.layer(
                      ConfigProvider.fromUnknown({ KIN_GITHUB_BOT_LOGIN: "kin-app" }),
                    ),
                  ),
                );
              assert.include(unbotted, { reason: "invalid_state" });
              assert.include(unbotted.message, "[bot]");
              assert.deepStrictEqual((yield* tasks.list()).tasks, []);
              const setup = yield* webhooks.setup(owner, { orgId, projectId: project.id });
              assert.strictEqual(setup.status, "needs_secret");
              const [task] = (yield* tasks.list()).tasks;
              assert.isDefined(task);
              if (task === undefined || setup.status === "needs_connect") return;
              assert.strictEqual(setup.url, task.webhook?.url);
              assert.isTrue(setup.url.startsWith(`${relay}/`));
              assert.deepInclude(task, {
                prompt: GithubWebhooks.KIN_SINK_PROMPT,
                enabled: true,
                projectId: project.id,
                threadId: null,
                threadMode: "new_thread",
                runtimeMode: "approval-required",
                interactionMode: "plan",
                createdBy: "system",
                creationSource: "server",
              });
              assert.deepStrictEqual(task.schedule, {
                type: "webhook",
                signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
                maxDeliveryAgeMinutes: null,
                dedupe: { replayKey: KinTriggerStore.GITHUB_REPLAY_KEY },
                filters: [
                  {
                    path: "headers.x-github-event",
                    op: "in",
                    value: KinTriggerStore.GITHUB_EVENTS,
                  },
                  { path: "body.sender.login", op: "notEquals", value: "kin-app[bot]" },
                ],
              });
              assert.isTrue(task.webhook?.hasSecret);
              assert.lengthOf(inboxLaunches, 1);
              assert.isUndefined(inboxLaunches[0]?.initialMessage);
              assert.deepStrictEqual(
                commands.map((command) => command.type),
                ["thread.archive"],
              );
              assert.lengthOf(yield* sql`SELECT 1 FROM kin_agent_threads`, 0);
              const store = yield* KinTriggerStore.KinTriggerStore;
              assert.deepInclude(yield* store.sourceByTaskId(task.id), {
                orgId,
                repo: KIN_GITHUB_APP_SOURCE,
                inboxThreadId: projection(orgId).thread.id,
                githubHookId: null,
                botLogin: "kin-app[bot]",
              });
              assert.lengthOf(hookConfigs, 0);
              assert.strictEqual(
                (yield* GithubWebhooks.configureAppHook({
                  kind: "github.app_hook.configure",
                  orgId,
                  sourceId: setup.sourceId,
                  url: setup.url,
                  secret: ownerSecret,
                }).pipe(Effect.flip)).reason,
                "gated",
              );

              const rejected = yield* tasks.triggerWebhook(
                signed(task, { delivery: "before-secret", secret: Redacted.value(ownerSecret) }),
              );
              assert.strictEqual(rejected._tag, "rejected_signature");
              assert.strictEqual(
                (yield* webhooks.setSecret(owner, { orgId, secret: ownerSecret })).status,
                "configured",
              );
              const delivery = { delivery: "gh-1", secret: Redacted.value(ownerSecret) };
              const accepted = yield* waitForDispatch(tasks.triggerWebhook(signed(task, delivery)));
              assert.strictEqual(accepted._tag === "accepted" && accepted.outcome, "accepted");
              const pending = yield* inbox.listPending(orgId);
              assert.lengthOf(pending, 1);
              assert.deepInclude(pending[0]?.payload, { kind: "github", scheduledTaskId: task.id });
              const replay = yield* tasks.triggerWebhook(signed(task, delivery));
              assert.strictEqual(replay._tag === "accepted" && replay.outcome, "duplicate");
              const bot = yield* tasks.triggerWebhook(
                signed(task, { ...delivery, delivery: "gh-2", sender: "kin-app[bot]" }),
              );
              assert.strictEqual(bot._tag === "accepted" && bot.outcome, "filtered");
              assert.lengthOf(yield* inbox.listPending(orgId), 1);
              assert.lengthOf(dispatched, 0);

              const rekey = Redacted.make("owner-rekeyed-secret-from-github-app");
              yield* webhooks.setSecret(owner, { orgId, secret: rekey });
              const stale = yield* tasks.triggerWebhook(
                signed(task, { delivery: "gh-stale", secret: Redacted.value(ownerSecret) }),
              );
              assert.strictEqual(stale._tag, "rejected_signature");
              const rekeyed = yield* waitForDispatch(
                tasks.triggerWebhook(
                  signed(task, { delivery: "gh-rekeyed", secret: Redacted.value(rekey) }),
                ),
              );
              assert.strictEqual(rekeyed._tag === "accepted" && rekeyed.outcome, "accepted");
              assert.lengthOf(yield* inbox.listPending(orgId), 2);

              const again = yield* webhooks.setup(owner, { orgId, projectId: project.id });
              assert.deepStrictEqual(again, setup);
              assert.lengthOf((yield* tasks.list()).tasks, 1);
              const still = yield* waitForDispatch(
                tasks.triggerWebhook(
                  signed(task, { delivery: "gh-3", secret: Redacted.value(rekey) }),
                ),
              );
              assert.strictEqual(still._tag === "accepted" && still.outcome, "accepted");
              assert.lengthOf(yield* inbox.listPending(orgId), 3);
              assert.strictEqual(
                (yield* Effect.flip(
                  webhooks.setup(owner, {
                    orgId,
                    projectId: ProjectId.make("elsewhere"),
                  }),
                )).reason,
                "invalid_state",
              );
            }),
        );
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "with the App hook gate open, gives GitHub the secret T3 checks and re-keys on setup",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        yield* harness({ gate: true }, ({ webhooks, tasks, dispatched, hookConfigs }) =>
          Effect.gen(function* () {
            const setup = yield* webhooks.setup(owner, { orgId, projectId: project.id });
            const [task] = (yield* tasks.list()).tasks;
            assert.isDefined(task);
            if (task === undefined || setup.status === "needs_connect") return assert.fail("setup");
            assert.strictEqual(setup.status, "configured");
            const [first] = hookConfigs;
            assert.deepInclude(first, { url: setup.url, content_type: "json", insecure_ssl: "0" });
            if (first?.secret === undefined) return assert.fail("no secret sent");
            assert.match(Redacted.value(first.secret), /^[0-9a-f]{64}$/);
            const send = (delivery: string, secret: Redacted.Redacted<string>) =>
              tasks.triggerWebhook(signed(task, { delivery, secret: Redacted.value(secret) }));
            const accepted = yield* waitForDispatch(send("gh-1", first.secret));
            assert.strictEqual(accepted._tag === "accepted" && accepted.outcome, "accepted");

            const rotated = yield* webhooks.rotate(owner, { orgId });
            if (rotated.status === "needs_connect") return assert.fail("rotate");
            assert.strictEqual(rotated.status, "configured");
            assert.notStrictEqual(rotated.url, setup.url);
            assert.deepStrictEqual(hookConfigs[1], {
              url: rotated.url,
              content_type: "json",
              insecure_ssl: "0",
            });
            assert.strictEqual((yield* send("gh-2", first.secret))._tag, "not_found");

            const rekeyed = yield* webhooks.setup(owner, { orgId, projectId: project.id });
            assert.deepStrictEqual(rekeyed, {
              status: "configured",
              sourceId: setup.sourceId,
              url: rotated.url,
            });
            const next = hookConfigs[2]?.secret;
            if (next === undefined) return assert.fail("no re-key");
            assert.notStrictEqual(Redacted.value(next), Redacted.value(first.secret));
            const [current] = (yield* tasks.list()).tasks;
            if (current === undefined) return assert.fail("task");
            const resend = (delivery: string, secret: Redacted.Redacted<string>) =>
              tasks.triggerWebhook(signed(current, { delivery, secret: Redacted.value(secret) }));
            assert.strictEqual((yield* resend("gh-3", first.secret))._tag, "rejected_signature");
            const fresh = yield* waitForDispatch(resend("gh-4", next));
            assert.strictEqual(fresh._tag === "accepted" && fresh.outcome, "accepted");
            assert.lengthOf(yield* inbox.listPending(orgId), 2);
            assert.lengthOf(dispatched, 0);
          }),
        );
      }).pipe(Effect.provide(services)),
  );

  it.effect("posts the T3 Connect notice and leaves nothing behind without a public URL", () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* KinTriggerStore.KinTriggerStore;
      yield* harness({ relayHookBaseUrl: null }, ({ webhooks, tasks, inboxLaunches, notices }) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* webhooks.setup(owner, { orgId, projectId: project.id }), {
            status: "needs_connect",
          });
          assert.deepStrictEqual(
            notices.map(({ chatId, body }) => ({ chatId, body })),
            [{ chatId: "owner-chat", body: GithubWebhooks.CONNECT_NOTICE }],
          );
          assert.deepStrictEqual((yield* tasks.list()).tasks, []);
          assert.lengthOf(inboxLaunches, 0);
          assert.isUndefined(
            yield* store.getSource(orgId, KinWebhookSourceId.make(KIN_GITHUB_APP_SOURCE)),
          );
        }),
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "registers before enabling, and removal disables before unregistering, so no delivery launches",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const inbox = yield* KinTriggerInbox.KinTriggerInbox;
        const store = yield* KinTriggerStore.KinTriggerStore;
        const sourceId = KinWebhookSourceId.make(KIN_GITHUB_APP_SOURCE);
        yield* harness({}, ({ webhooks, tasks, dispatched }) =>
          Effect.gen(function* () {
            const inboxId = projection(orgId).thread.id;
            yield* sql`INSERT INTO kin_agent_threads (org_id, agent_id, thread_id, started_at)
              VALUES (${orgId}, 'lead', ${inboxId}, ${timestamp})`;
            const refused = yield* Effect.flip(
              webhooks.setup(owner, { orgId, projectId: project.id }),
            );
            assert.strictEqual(refused.reason, "invalid_state");
            const [stranded] = (yield* tasks.list()).tasks;
            if (stranded === undefined) return assert.fail("task");
            assert.isFalse(stranded.enabled);
            const early = signed(stranded, {
              delivery: "early",
              secret: Redacted.value(ownerSecret),
            });
            assert.strictEqual((yield* tasks.triggerWebhook(early))._tag, "disabled");
            assert.strictEqual(stranded.id, KinTriggerStore.githubAppTaskId(orgId));
            yield* webhooks.remove(owner, { orgId });
            assert.deepStrictEqual((yield* tasks.list()).tasks, []);

            yield* sql`DELETE FROM kin_agent_threads WHERE thread_id = ${inboxId}`;
            const setup = yield* webhooks.setup(owner, { orgId, projectId: project.id });
            assert.strictEqual(setup.status, "needs_secret");
            yield* webhooks.setSecret(owner, { orgId, secret: ownerSecret });
            const [task] = (yield* tasks.list()).tasks;
            if (task === undefined) return assert.fail("task");
            assert.strictEqual(task.id, stranded.id);
            assert.isTrue(task.enabled);

            assert.strictEqual(
              (yield* Effect.flip(store.unregisterSource(orgId, sourceId)))._tag,
              "KinWebhookSourceConflict",
            );
            yield* sql`INSERT INTO scheduled_task_webhook_pending
              (delivery_id, task_id, coalesce_key, due_at, state, task_json, request_json, delivery_ids_json)
              VALUES ('in-flight', ${task.id}, '', 0, 'running', '{}', '{}', '[]')`;
            assert.strictEqual(
              (yield* Effect.flip(webhooks.remove(owner, { orgId }))).reason,
              "invalid_state",
            );
            assert.isDefined(yield* store.getSource(orgId, sourceId));
            yield* sql`DELETE FROM scheduled_task_webhook_pending WHERE delivery_id = 'in-flight'`;
            const late = signed(task, { delivery: "late", secret: Redacted.value(ownerSecret) });
            assert.strictEqual((yield* tasks.triggerWebhook(late))._tag, "disabled");

            yield* webhooks.remove(owner, { orgId });
            yield* webhooks.remove(owner, { orgId });
            assert.isUndefined(yield* store.getSource(orgId, sourceId));
            assert.deepStrictEqual((yield* tasks.list()).tasks, []);
            assert.strictEqual((yield* tasks.triggerWebhook(late))._tag, "not_found");
            assert.deepStrictEqual(yield* inbox.listPending(orgId), []);
            assert.lengthOf(dispatched, 0);

            assert.strictEqual(
              (yield* webhooks.setup(owner, { orgId, projectId: project.id })).status,
              "needs_secret",
            );
            const rotated = yield* webhooks.rotate(owner, { orgId });
            assert.strictEqual(rotated.status, "needs_url");
          }),
        );
      }).pipe(Effect.provide(services)),
  );

  it.effect("keeps the App source to one org per host until that org removes it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const orgB = KinOrgId.make("org-b");
      const ownerB = [
        { _tag: "person", orgId: orgB, personId: KinPersonId.make("owner-b") },
      ] as const;
      yield* sql`INSERT INTO kin_orgs VALUES (${orgB}, 'Kin B', ${timestamp})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('owner-b', ${orgB}, 'owner-b', 'owner-b', ${timestamp})`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('lead-b', ${orgB}, 'Lead', 'lead', 'owner-b', ${timestamp})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('owner-chat-b', ${orgB}, 'direct', 'direct-b', 0, ${timestamp})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES ('lead-b', ${orgB}, 'Lead', 0, '{}', '[]', 'owner-chat-b')`;
      const store = yield* KinTriggerStore.KinTriggerStore;
      yield* harness({}, ({ webhooks, tasks }) =>
        Effect.gen(function* () {
          yield* webhooks.setup(owner, { orgId, projectId: project.id });
          const taken = yield* Effect.flip(
            webhooks.setup(ownerB, { orgId: orgB, projectId: project.id }),
          );
          assert.include(taken, { reason: "conflict" });
          assert.lengthOf((yield* tasks.list()).tasks, 1);
          const [held] = (yield* tasks.list()).tasks;
          if (held === undefined) return assert.fail("task");
          const direct = yield* Effect.flip(
            store.registerSource({
              id: KinWebhookSourceId.make(KIN_GITHUB_APP_SOURCE),
              orgId: orgB,
              repo: KIN_GITHUB_APP_SOURCE,
              scheduledTaskId: held.id,
              inboxThreadId: projection(orgId).thread.id,
              githubHookId: null,
              botLogin: "kin-app[bot]",
              status: "active",
            }),
          );
          assert.include(direct, { _tag: "KinWebhookSourceConflict", reason: "app_source_taken" });
          yield* webhooks.remove(owner, { orgId });
          assert.strictEqual(
            (yield* webhooks.setup(ownerB, { orgId: orgB, projectId: project.id })).status,
            "needs_secret",
          );
          const [moved] = (yield* tasks.list()).tasks;
          assert.strictEqual(moved?.id, KinTriggerStore.githubAppTaskId(orgB));
        }),
      );
    }).pipe(Effect.provide(services)),
  );

  it.effect("never writes a webhook secret to logs or errors, even when a save fails", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const lines: string[] = [];
      const logger = Logger.map(Logger.formatJson, (line) => void lines.push(line));
      const failing = Redacted.make("forced-failure-secret-0123456789");
      const { generated, errors } = yield* harness({}, ({ webhooks }) =>
        Effect.gen(function* () {
          yield* webhooks.setup(owner, { orgId, projectId: project.id });
          const [stored] = yield* sql<{ readonly secret: string }>`
            SELECT webhook_secret AS secret FROM scheduled_tasks`;
          yield* webhooks.setSecret(owner, { orgId, secret: ownerSecret });
          yield* sql`CREATE TRIGGER reject_task_save BEFORE UPDATE ON scheduled_tasks
            BEGIN SELECT RAISE(ABORT, 'forced'); END`;
          const failed = yield* Effect.flip(webhooks.setSecret(owner, { orgId, secret: failing }));
          yield* sql`DROP TRIGGER reject_task_save`;
          return {
            generated: stored === undefined ? [] : [Redacted.make(stored.secret)],
            errors: [failed],
          };
        }),
      ).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
      assert.lengthOf(generated, 1);
      for (const error of errors) assert.include(error, { _tag: "KinChatError" });
      const output = [
        ...lines,
        ...errors.flatMap((error) => [String(error), JSON.stringify(error), error.message]),
      ].join("\n");
      assert.isNotEmpty(lines);
      for (const secret of [...generated, ownerSecret, failing])
        assert.notInclude(output, Redacted.value(secret));
    }).pipe(Effect.provide(services)),
  );

  it.effect("refuses every setup RPC without the settings grant before the handler runs", () =>
    Effect.gen(function* () {
      const probe = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"],
            typeof WS_METHODS.serverProbe
          > => tag !== WS_METHODS.serverProbe,
        ),
      );
      const group = RpcGroup.make(...KinGithubWebhookRpcs, ...probe.requests.values()).middleware(
        RpcScopeAuthorization,
      );
      const handlers = yield* makeKinWebhookHandlers({
        sessionId: AuthSessionId.make("session"),
        subject: "browser",
        method: "browser-session-cookie",
        scopes: [AuthSettingsWriteScope],
      });
      const client = (scope: typeof AuthSettingsWriteScope | typeof AuthOrchestrationReadScope) =>
        RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
              RpcAuthorization.layer([scope]),
            ),
          ),
        );
      const readOnly = yield* client(AuthOrchestrationReadScope);
      const settings = yield* client(AuthSettingsWriteScope);
      const calls = [
        (rpc: typeof readOnly) =>
          rpc["kin.webhooks.github.setup"]({ orgId, projectId: project.id }),
        (rpc: typeof readOnly) =>
          rpc["kin.webhooks.github.setSecret"]({ orgId, secret: ownerSecret }),
        (rpc: typeof readOnly) => rpc["kin.webhooks.github.rotate"]({ orgId }),
        (rpc: typeof readOnly) => rpc["kin.webhooks.github.remove"]({ orgId }),
      ];
      for (const call of calls) {
        assert.strictEqual(
          (yield* Effect.flip(call(readOnly)))._tag,
          "EnvironmentAuthorizationError",
        );
        assert.include(yield* Effect.flip(call(settings)), {
          _tag: "KinChatError",
          reason: "disabled",
        });
      }
    }),
  );
});
