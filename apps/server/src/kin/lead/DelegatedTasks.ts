import { type OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as Chat from "../chat/KinChatService.ts";
import { KinBudget } from "./KinBudget.ts";
import { modelNotOffered } from "./leadModels.ts";
import { KinRefusedModels } from "./refusedModels.ts";
import { taskChat } from "./TaskWake.ts";

const ENDED: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const titleOf = (task: OrchestrationV2Subagent) =>
  (task.title ?? task.prompt.split("\n").find((line) => line.trim() !== "") ?? "Task")
    .trim()
    .slice(0, 120);

/**
 * A task an agent hands to T3 (`delegate_task`) gets a card in the chat its reply lands in
 * (`taskChat`), which `TaskCardUpdater` keeps live, and when it ends its usage counts against the
 * owner's daily limit for tasks.
 */
export const make = Effect.gen(function* () {
  const chat = yield* Chat.KinChatService;
  const budget = yield* KinBudget;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const refusals = yield* Effect.serviceOption(KinRefusedModels);
  const services = Effect.provideContext(
    yield* Effect.context<OrchestratorV2 | ServerEnvironment | SqlClient.SqlClient>(),
  );
  // Subagent records repeat on every progress line: a child is carded once, charged once per end.
  const carded = new Set<string>();
  const charged = new Set<string>();

  const charge = Effect.fn("KinDelegatedTasks.charge")(function* (
    orgId: Parameters<typeof budget.chargeTask>[0]["orgId"],
    threadId: ThreadId,
  ) {
    const records = yield* threads.getThreadRecords(threadId, ["providerTurns"]);
    yield* budget.chargeTask({
      orgId,
      threadId,
      usage: records.providerTurns.map((turn) => ({
        providerTurnId: turn.id,
        ...(turn.turnTokenUsage === undefined ? {} : { turnTokenUsage: turn.turnTokenUsage }),
        ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
        usedTokens: turn.tokenUsage?.usedTokens,
      })),
    });
  });

  const observe = Effect.fn("KinDelegatedTasks.observe")(function* (task: OrchestrationV2Subagent) {
    const child = task.childThreadId;
    const end = `${child}:${task.completedAt === null ? "" : DateTime.toEpochMillis(task.completedAt)}`;
    if (
      task.origin !== "app_owned" ||
      child === null ||
      task.remoteChild !== undefined ||
      // An agent's own threads are `kin:<ulid>`; shared turns delegate nothing.
      !task.threadId.startsWith("kin:") ||
      (carded.has(child) && (charged.has(end) || !ENDED.has(task.status)))
    )
      return;
    const lead = yield* taskChat(task.threadId).pipe(services);
    if (lead === undefined) return;
    if (!carded.has(child)) {
      yield* chat
        .createTaskCard({
          orgId: lead.orgId,
          chatId: lead.chatId,
          audience: "owner",
          authorAgentId: lead.agentId,
          threadId: child,
          taskId: task.id,
          title: titleOf(task),
          model: task.model,
        })
        .pipe(services);
      carded.add(child);
    }
    if (ENDED.has(task.status) && !charged.has(end)) {
      yield* charge(lead.orgId, child);
      charged.add(end);
      // The provider turned the helper away for its model: Kin stops offering that model.
      if (task.status === "failed" && Option.isSome(refusals)) {
        const shell = yield* OrchestratorV2.use((orchestrator) =>
          orchestrator.getThreadShell(child),
        ).pipe(services);
        if (
          shell !== null &&
          modelNotOffered(
            { code: shell.lastErrorCode, message: shell.lastError },
            shell.modelSelection.model,
          )
        )
          yield* refusals.value.refused({ orgId: lead.orgId, selection: shell.modelSelection });
      }
    }
  });

  return { observe };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tasks = yield* make;
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        event.type === "subagent.updated"
          ? tasks.observe(event.payload).pipe(Effect.ignoreCause({ log: true }))
          : Effect.void,
      ),
      forkParked,
    );
  }),
);
