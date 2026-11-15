import { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

const SEED_RULES = "# Rules\n";

/**
 * `vp run dev` with no `KIN_MEMORY_REPOSITORIES`: a local bare memory repo under the dev state
 * directory, seeded with `rules.md` on `main` so the first checkout has a branch to read.
 * Undefined on an installed host, which must name its own.
 */
export const devMemoryRepository = Effect.fn("MemoryConfig.devRepository")(function* () {
  const config = yield* ServerConfig;
  if (config.devUrl === undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess;
  const repoPath = path.join(config.stateDir, "kin-dev-memory.git");
  const git = (args: ReadonlyArray<string>, stdin?: string) =>
    vcs
      .run({
        operation: "MemoryConfig.devRepository",
        command: "git",
        cwd: config.stateDir,
        args: [`--git-dir=${repoPath}`, ...args],
        ...(stdin === undefined ? {} : { stdin }),
        env: {
          GIT_AUTHOR_NAME: "Kin",
          GIT_AUTHOR_EMAIL: "kin@localhost",
          GIT_COMMITTER_NAME: "Kin",
          GIT_COMMITTER_EMAIL: "kin@localhost",
        },
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* fs.makeDirectory(config.stateDir, { recursive: true });
  if (!(yield* fs.exists(path.join(repoPath, "HEAD"))))
    yield* vcs.run({
      operation: "MemoryConfig.devRepository",
      command: "git",
      cwd: config.stateDir,
      args: ["init", "-q", "--bare", "-b", "main", repoPath],
    });
  const head = yield* vcs.run({
    operation: "MemoryConfig.devRepository",
    command: "git",
    cwd: config.stateDir,
    args: [`--git-dir=${repoPath}`, "rev-parse", "--verify", "-q", "refs/heads/main"],
    allowNonZeroExit: true,
  });
  if (head.stdout.trim() === "") {
    const blob = yield* git(["hash-object", "-w", "--stdin"], SEED_RULES);
    const tree = yield* git(["mktree"], `100644 blob ${blob}\trules.md\n`);
    const commit = yield* git(["commit-tree", tree, "-m", "Kin dev memory"]);
    yield* git(["update-ref", "refs/heads/main", commit]);
  }
  yield* Effect.logWarning(`Kin dev memory lives in the local repository ${repoPath}`);
  return [{ orgId: KinOrgId.make("kin-default"), repoUrl: repoPath }] as const;
});
