import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { Argument, Command } from "effect/cli";

import { isLintedPath, lintMemoryFiles } from "./lint.ts";
import { folders } from "./Memory.ts";

// Symlinks are skipped, as `Memory.load` reads only regular blobs; following one could read outside the checkout.
export const readMemoryDirectory = Effect.fn("MemoryLint.readDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<{ path: string; content: Uint8Array }> = [];
  const visit: (relative: string) => Effect.Effect<void, PlatformError> = Effect.fnUntraced(
    function* (relative) {
      for (const entry of yield* fs.readDirectoryEntries(path.join(root, relative))) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.type === "Directory" && (relative || folders.includes(entry.name)))
          yield* visit(child);
        else if (entry.type === "File" && isLintedPath(child))
          files.push({ path: child, content: yield* fs.readFile(path.join(root, child)) });
      }
    },
  );
  yield* visit("");
  return files;
});

const lintCommand = Command.make(
  "memory-lint",
  { directory: Argument.String("directory") },
  Effect.fn("MemoryLint.cli")(function* ({ directory }) {
    const failures = yield* lintMemoryFiles(yield* readMemoryDirectory(directory));
    for (const failure of failures)
      yield* Console.log(`${failure.path}:${failure.line} ${failure.reason}`);
    if (failures.length > 0) process.exitCode = 1;
  }),
).pipe(Command.withDescription("Check a Kin memory checkout against the server's item schema."));

if (import.meta.main) {
  Command.run(lintCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
