import {
  CommandId,
  KinOrgId,
  MessageId,
  ModelSelection,
  type OrchestrationV2RuntimeRequestJson,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { parseCliArgs } from "@t3tools/shared/cliArgs";

import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { permissionFlag, threadPrefix } from "./DreamIsolation.ts";

export { threadPrefix } from "./DreamIsolation.ts";

export class DreamSessionError extends Schema.TaggedError<DreamSessionError>()(
  "DreamSessionError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

/** The dream's provider instance cannot be confined to the checkout, so the dream never starts. */
export class DreamRefused extends Schema.TaggedError<DreamRefused>()("DreamRefused", {
  orgId: KinOrgId,
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface DreamTurn {
  readonly orgId: KinOrgId;
  readonly dreamId: string;
  readonly turn: "extract" | "resolve";
  readonly workspaceRoot: string;
  readonly model: ModelSelection;
  readonly text: string;
}

/**
 * One provider turn in the dream checkout. The Kin MCP registry refuses its thread on every endpoint.
 * The material is untrusted, so the turn may only edit its checkout; it declines every other request.
 * Only Claude runs dreams: DreamIsolation strips its config, tools and MCP. Codex's shell sandbox
 * still reads outside the checkout, and no per-thread option removes it.
 */
export class DreamSession extends Context.Service<
  DreamSession,
  {
    readonly run: (
      turn: DreamTurn,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly status: "completed" | "failed" | "timed_out" },
      DreamSessionError | DreamRefused
    >;
  }
>()("t3/kin/dreaming/DreamSession") {}

const timeoutMs = 900_000;
const isRefused = Schema.is(DreamRefused);

export const layer = Layer.effect(
  DreamSession,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const launch = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const refusal = Effect.fn("DreamSession.refusal")(function* (turn: DreamTurn) {
      const { instanceId } = turn.model;
      const entry = deriveProviderInstanceConfigMap(yield* settings.getSettings)[instanceId];
      if (entry?.driver !== "claudeAgent")
        return `Dreams run only on Claude, and ${instanceId} is ${entry === undefined ? "not a configured provider" : `a ${entry.driver} instance`}.`;
      const config: { readonly launchArgs?: unknown } = entry.config ?? {};
      const flags = Object.keys(
        parseCliArgs(typeof config.launchArgs === "string" ? config.launchArgs : "").flags,
      ).filter((flag) => permissionFlag.test(flag));
      return flags.length === 0
        ? undefined
        : `Dreams refuse ${instanceId}: its launch arguments set ${flags.map((flag) => `--${flag}`).join(", ")}, which would let a dream approve its own tools.`;
    });
    const run = Effect.fn("DreamSession.run")(
      function* (turn: DreamTurn) {
        const refused = yield* refusal(turn);
        if (refused !== undefined)
          return yield* new DreamRefused({ orgId: turn.orgId, reason: refused });
        const { project } = yield* projects.bootstrap({
          commandId: CommandId.make(`kin-dream-project:${turn.orgId}`),
          projectId: ProjectId.make(`kin-dream:${turn.orgId}`),
          workspaceRoot: turn.workspaceRoot,
          title: `Kin dreams · ${turn.orgId}`,
        });
        const key = `${turn.dreamId}:${turn.turn}`;
        const threadId = ThreadId.make(`${threadPrefix}${key}`);
        const messageId = MessageId.make(`kin-dream-msg:${key}`);
        const sent = yield* launch.launch({
          commandId: CommandId.make(`kin-dream:${key}`),
          threadId,
          projectId: project.id,
          title: `Dream ${turn.turn}`,
          modelSelection: turn.model,
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text: turn.text, attachments: [] },
          createdBy: "system",
          creationSource: "server",
        });
        const started = sent.projection.runs.findLast((entry) => entry.userMessageId === messageId);
        if (started === undefined) return yield* Effect.die("Dream turn started no run");
        const runId = started.id;
        const interrupt = (reason: string) =>
          threads
            .interruptThread({
              projectId: project.id,
              threadId,
              runId,
              commandId: CommandId.make(`kin-dream-${reason}:${key}`),
            })
            .pipe(Effect.ignore);
        // An unanswered request would hold the turn until its timeout, so the run ends instead.
        // Interrupt before logging: the warning means the run has already ended.
        const decline = Effect.fn("DreamSession.decline")(function* (
          request: OrchestrationV2RuntimeRequestJson,
        ) {
          yield* threads
            .dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make(`kin-dream-decline:${request.id}`),
              threadId,
              requestId: request.id,
              decision: "decline",
            })
            .pipe(
              Effect.catchCause((cause) =>
                interrupt("undeclined").pipe(
                  Effect.andThen(
                    Effect.logWarning("Kin dream could not decline a request", {
                      threadId,
                      cause,
                    }),
                  ),
                ),
              ),
            );
        });
        const declineRequests = threads
          .streamStoredEventsFrom({ threadId, eventType: "runtime-request.updated" })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "runtime-request.updated" &&
              stored.event.payload.status === "pending"
                ? decline(stored.event.payload)
                : Effect.void,
            ),
            Effect.catchCause((cause) =>
              interrupt("unwatched").pipe(
                Effect.andThen(
                  Effect.logError("Kin dream request watch failed", { threadId, cause }),
                ),
              ),
            ),
            Effect.andThen(Effect.never),
          );
        const result = yield* Effect.raceFirst(
          threads.waitForThread({ projectId: project.id, threadId, runId, timeoutMs }),
          declineRequests,
        ).pipe(Effect.onInterrupt(() => interrupt("cancel")));
        if (result.timedOut) {
          yield* interrupt("timeout");
          return { threadId, status: "timed_out" as const };
        }
        const status = result.run?.status === "completed" ? "completed" : "failed";
        if (status === "completed")
          yield* threads
            .settleThread({
              threadId,
              commandId: CommandId.make(`kin-dream-settle:${key}`),
              byOwnAgent: true,
            })
            .pipe(Effect.ignore);
        return { threadId, status } as const;
      },
      (effect, turn) =>
        effect.pipe(
          Effect.mapError((cause) =>
            isRefused(cause) ? cause : new DreamSessionError({ orgId: turn.orgId, cause }),
          ),
        ),
    );
    return DreamSession.of({ run });
  }),
);
