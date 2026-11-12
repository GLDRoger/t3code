import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KIN_VISUAL_LIBRARIES } from "@t3tools/shared/kinVisual";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { kinVisualLibraryPath, stageKinVisualLibraries } from "./visualLibraries.ts";

it.effect("a built server carries every visual library and serves its own copy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dist = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kin-visual-lib-" });
    const staged = yield* stageKinVisualLibraries(dist);
    for (const library of KIN_VISUAL_LIBRARIES) {
      const built = path.join(staged, `${library.name}.js`);
      assert.isAbove(Number((yield* fileSystem.stat(built)).size), 100_000, library.name);
      assert.strictEqual(yield* kinVisualLibraryPath(library, dist), built);
      // Run from source, the installed file answers instead.
      assert.include(
        (yield* kinVisualLibraryPath(library, path.join(dist, "nowhere"))) ?? "",
        `${path.sep}node_modules${path.sep}${library.name}${path.sep}`,
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
