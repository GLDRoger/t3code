import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const kin = NodeURL.fileURLToPath(new URL("../", import.meta.url));

it.effect(
  "approvals and floor enforcement cannot depend on the judge, even through a re-export",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = (yield* fs.readDirectory(kin, { recursive: true })).filter(
        (file) =>
          file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".testkit.ts"),
      );
      const graph = new Map<string, ReadonlyArray<string>>();
      for (const file of files) {
        const filename = path.resolve(kin, file);
        const source = yield* fs.readFileString(filename);
        // Kin uses relative, literal ES imports; follow re-exports and dynamic imports too.
        const imports = [
          ...source.matchAll(
            /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\s+from\s*)?|\bimport\s*\(\s*)["'](\.[^"']+)["']/g,
          ),
        ];
        graph.set(
          filename,
          imports.map((match) => path.resolve(path.dirname(filename), match[1]!)),
        );
      }
      const reachable = (entry: string) => {
        const seen = new Set<string>();
        const visit = (filename: string) => {
          if (seen.has(filename)) return;
          seen.add(filename);
          for (const dependency of graph.get(filename) ?? []) visit(dependency);
        };
        visit(path.resolve(kin, entry));
        return [...seen].map((filename) => path.relative(kin, filename));
      };
      const roots = [
        "floor/FloorManager.ts",
        "floor/KinFloor.ts",
        ...files.filter((file) => file.startsWith("approvals/")),
      ];
      for (const root of roots) {
        assert.isFalse(reachable(root).includes("floor/Judge.ts"), root);
        assert.isFalse(reachable(root).includes("floor/JudgeShadow.ts"), root);
      }
      assert.include(reachable("floor/KinFloor.ts"), "floor/FloorManager.ts");
      assert.isFalse(
        reachable("floor/Judge.ts").some(
          (file) =>
            file.startsWith("approvals/") ||
            file === "chat/KinChatService.ts" ||
            file === "floor/KinFloor.ts",
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
