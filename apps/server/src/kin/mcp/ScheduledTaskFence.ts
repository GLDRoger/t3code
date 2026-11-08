import { ScheduledTaskError, ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as KinEnabled from "../KinEnabled.ts";

// Upstream names a task created with a commandId `scheduled-task:${commandId}`.
const kinTaskPrefix = "scheduled-task:kin:";

const isKinTask = (id: string) => id.startsWith(kinTaskPrefix);

const refuse = (taskId: ScheduledTaskId) =>
  Effect.fail(
    new ScheduledTaskError({
      message: `Scheduled task ${taskId} is managed by Kin. Agents can list it but cannot change, run or delete it.`,
      taskId,
    }),
  );

const guard =
  <I extends { readonly id: ScheduledTaskId }, A>(
    write: (input: I) => Effect.Effect<A, ScheduledTaskError>,
  ) =>
  (input: I) =>
    isKinTask(input.id) ? refuse(input.id) : write(input);

/**
 * The scheduled-task service T3's MCP tools see. While Kin is on, it refuses every
 * write to a `kin:` task, so no agent can edit, pause, run, re-key or delete Kin's
 * triggers, or claim one of their ids. Kin's own services and the client RPC use the
 * unwrapped service.
 */
export const layer = Layer.effect(
  ScheduledTasks.ScheduledTaskService,
  Effect.gen(function* () {
    const inner = yield* ScheduledTasks.ScheduledTaskService;
    if (!(yield* KinEnabled.KinEnabled).enabled) return inner;
    return ScheduledTasks.ScheduledTaskService.of({
      ...inner,
      upsert: Effect.fn("KinScheduledTaskFence.upsert")(function* (input) {
        const id =
          input.id ??
          (input.commandId === undefined
            ? undefined
            : ScheduledTaskId.make(`scheduled-task:${input.commandId}`));
        if (id !== undefined && isKinTask(id)) return yield* refuse(id);
        return yield* inner.upsert(input);
      }),
      setEnabled: guard(inner.setEnabled),
      delete: guard(inner.delete),
      runNow: guard(inner.runNow),
      rotateWebhookToken: guard(inner.rotateWebhookToken),
    });
  }),
).pipe(Layer.provide(KinEnabled.layer));
