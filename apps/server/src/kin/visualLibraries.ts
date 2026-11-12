// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";

import { KIN_VISUAL_LIBRARIES, type KinVisualLibrary } from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const requireFromHere = NodeModule.createRequire(import.meta.url);
// Literal names only: what this file can resolve is readable here, whatever the table says.
const entries: Record<string, (() => string) | undefined> = {
  d3: () => requireFromHere.resolve("d3"),
  echarts: () => requireFromHere.resolve("echarts"),
  mermaid: () => requireFromHere.resolve("mermaid"),
};

/** Beside the built server, as `client` is: packaged builds carry no `node_modules` for these. */
const KIN_VISUAL_LIBRARY_DIRECTORY = "visual-lib";

const installedLibraryPath = Effect.fn("Kin.installedVisualLibraryPath")(function* (
  library: KinVisualLibrary,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entry = yield* Effect.sync(() => {
    try {
      return entries[library.name]?.() ?? null;
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

/**
 * The library's browser file: the copy the build put beside the server, else the prebuilt file
 * in this install's `node_modules` (a run from source). Null when neither exists.
 */
export const kinVisualLibraryPath = Effect.fn("Kin.visualLibraryPath")(function* (
  library: KinVisualLibrary,
  builtDirectory: string = import.meta.dirname,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const built = path.join(builtDirectory, KIN_VISUAL_LIBRARY_DIRECTORY, `${library.name}.js`);
  if (yield* fileSystem.exists(built).pipe(Effect.orElseSucceed(() => false))) return built;
  return yield* installedLibraryPath(library);
});

export class KinVisualLibraryMissingError extends Schema.TaggedError<KinVisualLibraryMissingError>()(
  "KinVisualLibraryMissingError",
  { library: Schema.String },
) {
  override get message(): string {
    return `The ${this.library} build for Kin visuals is not installed, so a built server would draw visuals without it.`;
  }
}

/** For the build: copies every library into `<outDir>/visual-lib`, and fails if one is missing. */
export const stageKinVisualLibraries = Effect.fn("Kin.stageVisualLibraries")(function* (
  outDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(outDir, KIN_VISUAL_LIBRARY_DIRECTORY);
  yield* fileSystem.makeDirectory(target, { recursive: true });
  for (const library of KIN_VISUAL_LIBRARIES) {
    const source = yield* installedLibraryPath(library);
    if (source === null) return yield* new KinVisualLibraryMissingError({ library: library.name });
    yield* fileSystem.copyFile(source, path.join(target, `${library.name}.js`));
  }
  return target;
});
