import * as Crypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorCommandRejectedError } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import * as KinSchedules from "./kinSchedules.ts";
import * as KinTriggerSink from "./KinTriggerSink.ts";
import { projection } from "./webhooks.testkit.ts";

/** Saves rows as the real service would, with no native task behind them. */
export const recordingSchedules = (saves: KinSchedules.SaveInput[], cancels: string[]) =>
  Layer.effect(
    KinSchedules.KinSchedules,
    Effect.map(SqlClient.SqlClient, (sql) =>
      KinSchedules.KinSchedules.of({
        save: (input) =>
          sql`INSERT OR REPLACE INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
              source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
            VALUES (${KinSchedules.scheduleTaskId(input.orgId, input.scheduleId)}, ${input.orgId},
              ${input.scheduleId}, ${input.agentId}, ${input.chatId}, ${input.sourceEvent},
              ${input.saidBy}, 'owner_only', 'hash', 'inbox', ${input.now}, ${input.now})`.pipe(
            Effect.tap(() => Effect.sync(() => saves.push(input))),
            Effect.asVoid,
            Effect.orDie,
          ),
        cancel: (orgId, scheduleId) =>
          sql`DELETE FROM kin_schedules WHERE org_id = ${orgId} AND schedule_id = ${scheduleId}`.pipe(
            Effect.tap(() => Effect.sync(() => cancels.push(scheduleId))),
            Effect.asVoid,
            Effect.orDie,
          ),
        applyTaps: () => Effect.void,
      }),
    ),
  );

/** The lead's own project, as WakeupRunner names it. */
const leadProjectId = (orgId: string, agentId: string) => ProjectId.make(`kin:${orgId}:${agentId}`);

/** An archived thread in the lead's project, standing in for its scheduled-runs inbox. */
const leadInbox = (orgId: string, agentId: string) => {
  const view = projection(orgId as never);
  return {
    ...view,
    thread: {
      ...view.thread,
      id: ThreadId.make(`schedule-inbox-${agentId}`),
      projectId: leadProjectId(orgId, agentId),
    },
  };
};

/**
 * The real native scheduler, dispatching through Kin's sink. Inner launches and sends (what
 * would start a bare agent thread) are recorded; `tick` runs one native scheduler pass.
 */
export const nativeScheduler = (
  orgId: string,
  agentId: string,
  recorded: { launches: ThreadLaunchService.ThreadLaunchInput[]; sends: string[] },
  workers: Map<string, Effect.Effect<void>>,
) => {
  const inbox = leadInbox(orgId, agentId);
  const inner = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: (input) =>
      Effect.sync(() => {
        recorded.launches.push(input);
        return { threadId: inbox.thread.id, projection: inbox, resumed: false };
      }),
  });
  const management = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadProjection: () => Effect.succeed(inbox),
    sendToThread: (input) =>
      Effect.gen(function* () {
        recorded.sends.push(input.scheduledTaskId ?? "unscheduled");
        return yield* new OrchestratorCommandRejectedError({
          commandId: input.commandId,
          commandType: "test.inner_send",
        });
      }),
  });
  const service = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        KinTriggerSink.wrapTaskDispatch(inner, management).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
        ),
        Crypto.layer,
        Layer.succeed(Scheduler.Scheduler, {
          register: Effect.fn("KinSchedulesTestkit.register")(function* <E, R>(
            name: string,
            work: Effect.Effect<void, E, R>,
          ) {
            const context = yield* Effect.context<R>();
            workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
          }),
        }),
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
  return Layer.mergeAll(service, inner, management);
};
