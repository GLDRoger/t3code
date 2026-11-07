import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { MemoryConfig } from "./MemoryConfig.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

class MemoryGitRefRace extends Schema.TaggedError<MemoryGitRefRace>()("MemoryGitRefRace", {}) {}

const formats = new Map<string, "sha1" | "sha256">();

// A private bare git directory excludes lead-controlled config, grafts and hooks.
export const memoryGit = Effect.fn("Memory.gitHardened")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  stdin?: string,
  env: NodeJS.ProcessEnv = {},
  onStdoutChunk?: (chunk: Uint8Array) => void,
) {
  const fs = yield* FileSystem.FileSystem;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(MemoryConfig));
  const vcs = yield* VcsProcess;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped();
      const repo = yield* fs.exists(`${cwd}/.git`);
      let packedBefore: string | undefined;
      let format = formats.get(cwd);
      if (!format && repo) {
        const text = yield* fs
          .readFileString(`${cwd}/.git/config`)
          .pipe(Effect.orElseSucceed(() => ""));
        format = /objectformat\s*=\s*sha256/i.test(text) ? "sha256" : "sha1";
        if (formats.size >= 128) formats.clear();
        formats.set(cwd, format);
      }
      if (repo) {
        yield* fs.writeFileString(
          `${directory}/config`,
          format === "sha256"
            ? "[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n"
            : "[core]\nrepositoryformatversion = 0\nbare = true\n",
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
      if (repo && args[0] === "update-ref")
        packedBefore = yield* fs
          .readFileString(`${directory}/packed-refs`)
          .pipe(Effect.orElseSucceed(() => ""));
      const result = yield* vcs.run({
        operation: "Memory.gitHardened",
        command: "git",
        cwd,
        args: [
          "--no-replace-objects",
          ...(repo
            ? [`--git-dir=${directory}`, ...(args[0] === "checkout" ? [`--work-tree=${cwd}`] : [])]
            : []),
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "protocol.file.allow=user",
          ...(config?.credentialHelper
            ? ["-c", "credential.helper=", "-c", `credential.helper=${config.credentialHelper}`]
            : []),
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
          ...(config?.sshCommand ? { GIT_SSH_COMMAND: config.sshCommand } : {}),
        },
        ...(stdin === undefined ? {} : { stdin }),
        ...(onStdoutChunk === undefined ? {} : { onStdoutChunk }),
        maxOutputBytes: 64 * 1024 * 1024,
        timeoutMs: 120_000,
      });
      if (packedBefore !== undefined) {
        const packedAfter = yield* fs
          .readFileString(`${directory}/packed-refs`)
          .pipe(Effect.orElseSucceed(() => ""));
        if (packedBefore !== packedAfter) {
          const current = yield* fs
            .readFileString(`${cwd}/.git/packed-refs`)
            .pipe(Effect.orElseSucceed(() => ""));
          if (current !== packedBefore) return yield* new MemoryGitRefRace({});
          yield* fs.writeFileString(`${cwd}/.git/packed-refs`, packedAfter);
        }
      }
      if (args[0] === "fetch" && !result.stdout)
        return (yield* fs.readFileString(`${directory}/FETCH_HEAD`)).split("\t")[0] ?? "";
      return result.stdout;
    }),
  );
});
