import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  KinOrgId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { leadProjectId } from "../lead/leadProject.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinSchedules from "./kinSchedules.ts";
import { nativeScheduler } from "./kinSchedules.testkit.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import { projection, timestamp } from "./threadProjection.testkit.ts";

const orgA = KinOrgId.make("org-a");
const orgB = KinOrgId.make("org-b");
const configured = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    KIN_ENABLED: true,
    KIN_MEMORY_REPOSITORIES: JSON.stringify([
      { orgId: orgA, repoUrl: "https://github.com/owner/memory.git" },
    ]),
  }),
);
const database = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(configured),
);
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(1794009600000);
  const sql = yield* SqlClient.SqlClient;
  for (const org of [orgA, orgB]) {
    yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Kin', ${timestamp})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login, created_at) VALUES (${`person-${org}`}, ${org}, 'owner', 'Owner', NULL, ${timestamp})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${`agent-${org}`}, ${org}, 'Lead', 'lead', ${`person-${org}`}, ${timestamp}, NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads
      (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${`inbox-${org}`}, ${`project-${org}`}, 'Inbox', 'codex', 'approval-required', 'plan', ${timestamp}, ${timestamp}, '{}')`;
  }
});

const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
  getThreadProjection: (id) => Effect.succeed(projection(id === `inbox-${orgB}` ? orgB : orgA)),
});

describe("KinTriggerSink", () => {
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
});

it.effect(
  "builds the runtime after a Kin migration failure and runs the developer's own tasks",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE kin_orgs (broken TEXT)`;
      for (const [id, type] of [
        ["task", "webhook"],
        ["interval", "interval"],
      ]) {
        yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by,
          creation_source, created_at, updated_at, last_run_status, run_count)
          VALUES (${id}, 'Task', 'Prompt', 1, ${JSON.stringify({ type })}, 'project', '{}', '{}',
          'full-access', 'default', 'system', 'server', ${timestamp}, ${timestamp}, 'never', 0)`;
      }
      const sends: string[] = [];
      const managementLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.gen(function* () {
            sends.push(input.scheduledTaskId ?? "ordinary");
            return yield* new OrchestratorCommandRejectedError({
              commandId: input.commandId,
              commandType: "test.inner_send",
            });
          }),
      });
      const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
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
      yield* Effect.gen(function* () {
        const launch = yield* ThreadLaunchService.ThreadLaunchService;
        const input: ThreadLaunchService.ThreadLaunchInput = {
          commandId: CommandId.make("ordinary"),
          projectId: ProjectId.make("project"),
          title: "Ordinary",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "system",
          creationSource: "server",
        };
        yield* launch.launch(input);
        yield* launch.launch({
          ...input,
          commandId: CommandId.make("scheduled-task:interval:interval:1"),
          initialMessage: {
            text: "Interval",
            attachments: [],
            scheduledTaskId: ScheduledTaskId.make("interval"),
          },
        });
        yield* launch.launch({
          ...input,
          commandId: CommandId.make("scheduled-task:task:webhook:delivery"),
          initialMessage: {
            text: "Scheduled",
            attachments: [],
            scheduledTaskId: ScheduledTaskId.make("task"),
          },
        });
        const management = yield* ThreadManagementService.ThreadManagementService;
        const passed = yield* management
          .sendToThread({
            projectId: input.projectId,
            commandId: input.commandId,
            threadId: projection(orgA).thread.id,
            messageId: MessageId.make("interval-message"),
            text: "Interval",
            attachments: [],
            scheduledTaskId: ScheduledTaskId.make("interval"),
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.flip);
        assert.include(passed, { commandType: "test.inner_send" });
        assert.deepStrictEqual(sends, ["interval"]);
        const bound = yield* management
          .sendToThread({
            projectId: input.projectId,
            commandId: input.commandId,
            threadId: projection(orgA).thread.id,
            messageId: MessageId.make("message"),
            text: "Bound",
            attachments: [],
            scheduledTaskId: ScheduledTaskId.make("task"),
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.flip);
        assert.include(bound, { commandType: "test.inner_send" });
        assert.deepStrictEqual(sends, ["interval", "task"]);
        assert.strictEqual(launches.length, 3);
      }).pipe(
        Effect.provide(
          KinTriggerSink.wrapTaskDispatch(inner, managementLayer).pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
          ),
        ),
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("does not relabel a core dispatch layer failure as a Kin startup failure", () =>
  Effect.gen(function* () {
    const failure = new Error("core dispatch unavailable");
    const inner = Layer.effect(ThreadLaunchService.ThreadLaunchService, Effect.fail(failure));
    const result = yield* Layer.build(KinTriggerSink.wrapTaskDispatch(inner, threads)).pipe(
      Effect.flip,
    );
    assert.strictEqual(result, failure);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect(
  "never launches a Kin time task as a bare thread: Kin off, Kin failed, or no Kin row",
  () =>
    Effect.gen(function* () {
      const kinTask = ScheduledTaskId.make("scheduled-task:kin:schedule:org-a:sch-invented");
      const ordinary = ScheduledTaskId.make("ordinary-task");
      for (const mode of ["off", "failed", "no_row"] as const) {
        const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
        const sends: string[] = [];
        const logs: unknown[] = [];
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
        const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(projection(orgA)),
          // Reaching the inner send is what passing through means here.
          sendToThread: (input) =>
            Effect.gen(function* () {
              sends.push(input.scheduledTaskId ?? "unscheduled");
              return yield* new OrchestratorCommandRejectedError({
                commandId: input.commandId,
                commandType: "test.inner_send",
              });
            }),
        });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // A migration that cannot run fails Kin's layer, not the server.
          if (mode === "failed") yield* sql`CREATE TABLE kin_orgs (broken TEXT)`;
          yield* Effect.gen(function* () {
            const launcher = yield* ThreadLaunchService.ThreadLaunchService;
            const threads = yield* ThreadManagementService.ThreadManagementService;
            const fire = (taskId: ScheduledTaskId) => ({
              commandId: CommandId.make(`scheduled-task:${taskId}:1794009600000:scheduled`),
              projectId: ProjectId.make("kin:org-a:agent-org-a"),
              title: "Check the invented report",
              modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "test" },
              runtimeMode: "approval-required" as const,
              interactionMode: "plan" as const,
              workspaceStrategy: { type: "root" as const },
              initialMessage: { scheduledTaskId: taskId, text: "Owner words", attachments: [] },
              createdBy: "system" as const,
              creationSource: "server" as const,
            });
            const bound = (taskId: ScheduledTaskId) =>
              threads.sendToThread({
                projectId: ProjectId.make("project"),
                commandId: CommandId.make(`scheduled-task:${taskId}:1:scheduled`),
                threadId: projection(orgA).thread.id,
                messageId: MessageId.make(`message-${taskId}`),
                text: "Owner words",
                attachments: [],
                scheduledTaskId: taskId,
                mode: "queue",
                createdBy: "system",
                creationSource: "server",
              });
            const refused = yield* launcher.launch(fire(kinTask)).pipe(Effect.flip);
            assert.strictEqual(refused._tag, "ThreadLaunchError", mode);
            assert.lengthOf(launches, 0, mode);
            assert.notInclude(yield* bound(kinTask).pipe(Effect.flip), {
              commandType: "test.inner_send",
            });
            assert.deepStrictEqual(sends, [], mode);
            // The developer's own tasks keep launching and sending as before.
            yield* launcher.launch(fire(ordinary));
            assert.include(yield* bound(ordinary).pipe(Effect.flip), {
              commandType: "test.inner_send",
            });
            assert.deepStrictEqual(
              launches.map((input) => input.initialMessage?.scheduledTaskId),
              [ordinary],
              mode,
            );
            assert.deepStrictEqual(sends, [ordinary], mode);
          }).pipe(
            Effect.provide(
              KinTriggerSink.wrapTaskDispatch(inner, management).pipe(
                Layer.provide(
                  ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: mode !== "off" })),
                ),
              ),
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Sqlite.layerMemory,
              Logger.layer([Logger.make((entry) => void logs.push(entry.message))]),
            ),
          ),
        );
        assert.include(JSON.stringify(logs), "Kin scheduled task refused", mode);
      }
    }),
);

it.effect("a refused stray Kin task is disabled", () => {
  const logs: unknown[] = [];
  return Effect.gen(function* () {
    yield* seed;
    const recorded = { launches: [] as ThreadLaunchService.ThreadLaunchInput[], sends: [] };
    const workers = new Map<string, Effect.Effect<void>>();
    yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const hourly = (commandId: string) =>
        tasks
          .upsert({
            commandId: CommandId.make(commandId),
            title: "Ambermill invoices",
            prompt: "List Ambermill's overdue invoices.",
            enabled: true,
            schedule: { type: "interval", everyMs: 3_600_000 },
            projectId: leadProjectId(orgA, `agent-${orgA}`),
            threadId: null,
            threadMode: "new_thread",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "test" },
            runtimeMode: "approval-required",
            interactionMode: "plan",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.map(({ task }) => task.id));
      const stray = yield* hourly("kin:webhook:github-app");
      const own = yield* hourly("rhea-weekly-review");
      const live = yield* hourly(`kin:schedule:${orgA}:sch-invoices`);
      yield* sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
          source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
        VALUES (${live}, ${orgA}, 'sch-invoices', ${`agent-${orgA}`}, 'chat-a', 'event-a',
          'person-org-a', 'owner_only', 'hash', ${`inbox-${orgA}`}, 1794009600000, 1794009600000)`;
      const runHour = Effect.gen(function* () {
        yield* TestClock.adjust("1 hour");
        yield* workers.get("scheduled-tasks")!;
      });
      const enabled = tasks
        .list()
        .pipe(Effect.map((list) => list.tasks.map((task) => [task.id, task.enabled] as const)));
      const pass = tasks
        .list()
        .pipe(Effect.flatMap((list) => KinSchedules.disableStrayTasks(list.tasks)));

      yield* runHour;
      assert.deepStrictEqual(
        recorded.launches.map((input) => input.initialMessage?.scheduledTaskId),
        [own],
      );
      assert.deepStrictEqual(yield* pass, [stray]);
      assert.deepStrictEqual(yield* pass, []);
      assert.sameDeepMembers(yield* enabled, [
        [stray, false],
        [own, true],
        [live, true],
      ]);
      yield* runHour;
      assert.deepStrictEqual(
        recorded.launches.map((input) => input.initialMessage?.scheduledTaskId),
        [own, own],
      );
    }).pipe(Effect.provide(nativeScheduler(orgA, `agent-${orgA}`, recorded, workers)));
    const told = (text: string) => logs.filter((message) => JSON.stringify(message).includes(text));
    assert.lengthOf(told("Kin scheduled task refused: no Kin source for it"), 1);
    assert.lengthOf(told("Kin stray scheduled task disabled"), 1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        database,
        Logger.layer([Logger.make((entry) => void logs.push(entry.message))]),
      ),
    ),
  );
});
