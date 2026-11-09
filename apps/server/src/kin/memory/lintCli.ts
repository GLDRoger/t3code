import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { formatLintFailure, isLintedPath, lintMemoryFiles, type MemoryTreeEntry } from "./lint.ts";

const walkModes: Partial<Record<FileSystem.File.Type, string>> = {
  File: "100644",
  SymbolicLink: "120000",
};

// Git's index carries modes, so a gitlink or symlink cannot pass for a directory or file.
const gitEntries = Effect.fn("MemoryLint.gitEntries")(function* (root: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { listing, exitCode } = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("git", ["ls-files", "--stage", "-z"], {
          cwd: root,
          stdin: "ignore",
          stderr: "ignore",
        }),
      );
      return yield* Effect.all(
        { listing: Stream.mkString(Stream.decodeText(handle.stdout)), exitCode: handle.exitCode },
        { concurrency: 2 },
      );
    }),
  );
  if (exitCode !== 0) return yield* Effect.fail("git ls-files failed" as const);
  return listing.split("\0").flatMap((record) => {
    const match = /^(\d+) [0-9a-f]+ \d\t(.+)$/s.exec(record);
    return match?.[1] && match[2] ? [{ path: match[2], mode: match[1] }] : [];
  });
});

const walkEntries = Effect.fn("MemoryLint.walkEntries")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<{ path: string; mode: string }> = [];
  const visit: (relative: string) => Effect.Effect<void, PlatformError> = Effect.fnUntraced(
    function* (relative) {
      for (const entry of yield* fs.readDirectoryEntries(path.join(root, relative))) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.type === "Directory") yield* visit(child);
        else entries.push({ path: child, mode: walkModes[entry.type] ?? "unknown" });
      }
    },
  );
  yield* visit("");
  return entries;
});

/** Lists every entry in the tree; only regular memory files are read, so a symlink is never followed. */
export const readMemoryDirectory = Effect.fn("MemoryLint.readDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = (yield* fs.exists(path.join(root, ".git")))
    ? yield* gitEntries(root)
    : yield* walkEntries(root);
  const files: Array<MemoryTreeEntry> = [];
  for (const entry of listed)
    files.push(
      ["100644", "100755"].includes(entry.mode) && isLintedPath(entry.path)
        ? { ...entry, content: yield* fs.readFile(path.join(root, entry.path)) }
        : entry,
    );
  return files;
});

const lintCommand = Command.make(
  "memory-lint",
  { directory: Argument.String("directory") },
  Effect.fn("MemoryLint.cli")(function* ({ directory }) {
    const failures = yield* lintMemoryFiles(yield* readMemoryDirectory(directory));
    for (const failure of failures) yield* Console.log(formatLintFailure(failure));
    if (failures.length > 0) process.exitCode = 1;
  }),
).pipe(Command.withDescription("Check a Kin memory checkout against the server's item schema."));

if (import.meta.main) {
  Command.run(lintCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
