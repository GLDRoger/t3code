// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

import type { KinVisualLibrary } from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const requireFromHere = NodeModule.createRequire(import.meta.url);

/**
 * The library's prebuilt browser file in this install's `node_modules`, or null when the package
 * is absent. Found through the package's entry, since `exports` may hide the file itself.
 */
export const kinVisualLibraryPath = Effect.fn("Kin.visualLibraryPath")(function* (
  library: KinVisualLibrary,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* Effect.sync(() => {
    try {
      return requireFromHere.resolve(library.name);
    } catch {
      return null;
    }
  });
  if (entry === null) return null;
  const marker = `${path.sep}node_modules${path.sep}${library.name}${path.sep}`;
  const at = entry.lastIndexOf(marker);
  if (at === -1) return null;
  const filePath = path.join(entry.slice(0, at + marker.length), library.file);
  return (yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))
    ? filePath
    : null;
});
