import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

// A private git directory excludes lead-controlled config, attributes, grafts and hooks.
export const memoryGit = Effect.fn("Memory.gitHardened")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  stdin?: string,
  env: NodeJS.ProcessEnv = {},
  onStdoutChunk?: (chunk: Uint8Array) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped();
      const repo = yield* fs.exists(`${cwd}/.git`);
      if (repo) {
        yield* fs.writeFileString(
          `${directory}/config`,
          "[core]\nrepositoryformatversion = 0\nbare = false\n",
        );
        yield* fs.symlink(`${cwd}/.git/objects`, `${directory}/objects`);
        if (args[0] === "fsck") {
          yield* fs.makeDirectory(`${directory}/refs`);
          yield* fs.writeFileString(`${directory}/HEAD`, `${args.at(-1)}\n`);
        } else {
          yield* fs.symlink(`${cwd}/.git/refs`, `${directory}/refs`);
          for (const name of ["HEAD", "packed-refs"]) {
            if (yield* fs.exists(`${cwd}/.git/${name}`))
              yield* fs.copyFile(`${cwd}/.git/${name}`, `${directory}/${name}`);
          }
        }
      }
      const result = yield* vcs.run({
        operation: "Memory.gitHardened",
        command: "git",
        cwd,
        args: [
          "--no-replace-objects",
          ...(repo ? [`--git-dir=${directory}`, `--work-tree=${cwd}`] : []),
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "protocol.file.allow=user",
          ...args,
        ],
        env: {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_ASKPASS: "",
          GCM_INTERACTIVE: "never",
          ...env,
        },
        ...(stdin === undefined ? {} : { stdin }),
        ...(onStdoutChunk === undefined ? {} : { onStdoutChunk }),
        maxOutputBytes: 64 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      if (args[0] === "fetch" && !result.stdout)
        return (yield* fs.readFileString(`${directory}/FETCH_HEAD`)).split("\t")[0] ?? "";
      return result.stdout;
    }),
  );
});
