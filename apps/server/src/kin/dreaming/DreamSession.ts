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

/** One provider turn in the dream checkout. The Kin MCP registry refuses its thread on every endpoint. */
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
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text: turn.text, attachments: [] },
          createdBy: "system",
          creationSource: "server",
        });
        const started = sent.projection.runs.findLast((entry) => entry.userMessageId === messageId);
        if (started === undefined) return yield* Effect.die("Dream turn started no run");
        const runId = started.id;
        const result = yield* threads
          .waitForThread({ projectId: project.id, threadId, runId, timeoutMs })
          .pipe(
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
