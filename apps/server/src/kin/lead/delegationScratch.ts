import {
  OrchestratorMcpFailure,
  ThreadId,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import { isKinWorkspace } from "./kinWorkspace.ts";

/**
 * A Kin agent's checkout is its memory, never a task's workspace: a task it delegates without a
 * project works in Scratch. Optional services so test runtimes without them still build.
 */
export const makeDelegationScratch = Effect.gen(function* () {
  const managedFolders = yield* Effect.serviceOption(ManagedProjectFolders.ManagedProjectFolders);
  const serverConfig = yield* Effect.serviceOption(ServerConfig);

  /** Scratch's project for a Kin agent's parent checkout; `undefined` for any other. */
  const project = Effect.fn("KinDelegationScratch.project")(function* <E>(
    parent: OrchestrationV2ThreadProjection["thread"],
    parentProject: Effect.Effect<{ readonly workspaceRoot: string }, E>,
  ) {
    if (Option.isNone(serverConfig)) return undefined;
    const parentRoot = parent.worktreePath ?? (yield* parentProject).workspaceRoot;
    if (!isKinWorkspace(serverConfig.value.stateDir, parentRoot)) return undefined;
    const scratch = Option.isNone(managedFolders)
      ? Option.none()
      : yield* managedFolders.value.ensureScratchProject.pipe(Effect.option);
    if (Option.isNone(scratch))
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "This agent's workspace holds its memory, and Scratch is unavailable here. Clone the repository with t3_project_clone, then pass its project as target.projectId.",
      });
    return scratch.value.projectId;
  });

  /** The task's own Scratch folder, named after it. */
  const workspace = Effect.fn("KinDelegationScratch.workspace")(function* (input: {
    readonly projectId: ProjectId;
    readonly commandId: string;
    readonly text: string;
  }) {
    if (Option.isNone(managedFolders)) return undefined;
    const folder = yield* managedFolders.value
      .folderForThread({
        projectId: input.projectId,
        threadId: ThreadId.make(input.commandId),
        text: input.text,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `Unable to make a Scratch folder: ${error.message}`,
            }),
        ),
      );
    return Option.match(folder, {
      onNone: () => undefined,
      onSome: (worktreePath): OrchestrationV2ThreadLaunchWorkspaceStrategy => ({
        type: "existing_worktree",
        worktreePath,
      }),
    });
  });

  return { project, workspace };
});
