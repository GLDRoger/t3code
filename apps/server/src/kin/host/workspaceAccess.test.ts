import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as TaskFolderStore from "../../workspace/TaskFolderStore.ts";
import { WorkspaceHostAccess } from "../../workspace/WorkspaceHostAccess.ts";
import { KinEnabled } from "../KinEnabled.ts";
import * as WorkspaceAccess from "./workspaceAccess.ts";

const policy = (enabled: boolean) =>
  WorkspaceAccess.layer.pipe(
    Layer.provide(Layer.succeed(KinEnabled, { enabled, reportFailure: () => Effect.void })),
  );

it.effect("a fenced worktree also fences its shared project after restarting", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const root = path.join(dir, "task");
    const project = path.join(dir, "main");
    const tracked = path.join(project, "tracked");
    const other = path.join(dir, "other");
    for (const folder of [root, tracked, other])
      yield* fs.makeDirectory(folder, { recursive: true });
    yield* (yield* TaskFolderStore.TaskFolderStore).put({
      root,
      projectId: ProjectId.make("fixture"),
      projectRoot: project,
      anchor: project,
      projectPath: root,
      projectIsWorktree: true,
      repositories: [
        { repositoryPath: tracked, worktreePath: path.join(root, "tracked"), name: "tracked" },
      ],
    });

    yield* Effect.gen(function* () {
      const access = yield* WorkspaceHostAccess;
      assert.isTrue(yield* access.register(root, ThreadId.make("private-task")));
      assert.isTrue(yield* access.fenced(project));
      assert.isTrue(yield* access.fenced(root));
      assert.isFalse(yield* access.fenced(other));
    }).pipe(Effect.provide(policy(true)));

    yield* Effect.gen(function* () {
      const access = yield* WorkspaceHostAccess;
      assert.strictEqual(
        yield* access.guard([other, project], Effect.succeed("ran"), Effect.succeed("refused")),
        "refused",
      );
      assert.strictEqual(
        yield* access.guard([other], Effect.succeed("ran"), Effect.succeed("refused")),
        "ran",
      );
    }).pipe(Effect.provide(policy(false)));
  }).pipe(
    Effect.provide(
      TaskFolderStore.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "kin-fenced-folders-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
