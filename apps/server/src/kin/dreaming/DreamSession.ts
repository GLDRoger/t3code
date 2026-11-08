import {
  CommandId,
  KinOrgId,
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";

export class DreamSessionError extends Schema.TaggedError<DreamSessionError>()(
  "DreamSessionError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

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
 */
export class DreamSession extends Context.Service<
  DreamSession,
  {
    readonly run: (
      turn: DreamTurn,
    ) => Effect.Effect<
      { readonly threadId: ThreadId; readonly status: "completed" | "failed" | "timed_out" },
      DreamSessionError
    >;
  }
>()("t3/kin/dreaming/DreamSession") {}

const timeoutMs = 900_000;
export const threadPrefix = "kin-dream:";

export const layer = Layer.effect(
  DreamSession,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const launch = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const run = Effect.fn("DreamSession.run")(
      function* (turn: DreamTurn) {
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
        const declineRequests = threads
          .streamStoredEventsFrom({ threadId, eventType: "runtime-request.updated" })
          .pipe(
            Stream.runForEach((stored) =>
              stored.event.type === "runtime-request.updated" &&
              stored.event.payload.status === "pending"
                ? threads
                    .dispatch({
                      type: "runtime-request.respond",
                      commandId: CommandId.make(`kin-dream-decline:${stored.event.payload.id}`),
                      threadId,
                      requestId: stored.event.payload.id,
                      decision: "decline",
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Kin dream could not decline a request", {
                          threadId,
                          cause,
                        }),
                      ),
                    )
                : Effect.void,
            ),
            // Without the watch a request would hold the turn until its timeout.
            Effect.catchCause((cause) =>
              Effect.logError("Kin dream request watch failed", { threadId, cause }).pipe(
                Effect.andThen(
                  threads.interruptThread({
                    projectId: project.id,
                    threadId,
                    runId,
                    commandId: CommandId.make(`kin-dream-unwatched:${key}`),
                  }),
                ),
                Effect.ignore,
              ),
            ),
            Effect.andThen(Effect.never),
          );
        const result = yield* Effect.raceFirst(
          threads.waitForThread({ projectId: project.id, threadId, runId, timeoutMs }),
          declineRequests,
        ).pipe(
          Effect.onInterrupt(() =>
            threads
              .interruptThread({
                projectId: project.id,
                threadId,
                runId,
                commandId: CommandId.make(`kin-dream-cancel:${key}`),
              })
              .pipe(Effect.ignore),
          ),
        );
        if (result.timedOut) {
          yield* threads
            .interruptThread({
              projectId: project.id,
              threadId,
              runId,
              commandId: CommandId.make(`kin-dream-timeout:${key}`),
            })
            .pipe(Effect.ignore);
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
          Effect.mapError((cause) => new DreamSessionError({ orgId: turn.orgId, cause })),
        ),
    );
    return DreamSession.of({ run });
  }),
);
