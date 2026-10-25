import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { KinBriefProvider } from "./brief.ts";
import { KinService, layer } from "./KinService.ts";

const houseBrief = Layer.succeed(KinBriefProvider, {
  stableContext: (input) =>
    Effect.succeed(input.houseId === undefined ? "" : `house ${input.houseId}`),
  brief: (input) => Effect.succeed(input.task ?? ""),
});

describe("KinService prompt prefix", () => {
  it.effect("is byte-identical for two agents with the same profile and house", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const project = yield* fs.makeTempDirectoryScoped();
      const kin = yield* KinService.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(houseBrief),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          ),
        ),
      );

      const first = yield* kin.preview({
        profile: "implementer",
        provider: "codex",
        projectRoot: project,
        houseId: "north",
        brief: "Task A at 2026-10-24T13:51:00Z",
      });
      const second = yield* kin.preview({
        profile: "implementer",
        provider: "codex",
        projectRoot: project,
        houseId: "north",
        brief: "Task B at 2026-10-24T18:02:11Z",
      });

      assert.strictEqual(first.prefix, second.prefix);
      assert.isTrue(first.prefix.includes("house north"));
      assert.isFalse(first.prefix.includes("2026-10-24"));
      assert.isTrue(first.text.endsWith("Task A at 2026-10-24T13:51:00Z"));
      assert.isTrue(second.text.endsWith("Task B at 2026-10-24T18:02:11Z"));
      assert.isTrue(first.suffix.includes("house north"));
      assert.isTrue(first.suffix.endsWith("Task A at 2026-10-24T13:51:00Z"));
      assert.isFalse(first.suffix.includes("You are running in Kin."));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("carries the user's models.md into every agent's stable prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const kin = yield* KinService.pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(houseBrief),
            Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
          ),
        ),
      );

      const without = yield* kin.preview({ profile: "reviewer", provider: "claudeAgent" });
      assert.isFalse(without.prefix.includes("Model preferences"));

      yield* kin.writeMd({ scope: "user", name: "models.md", text: "Reviewers run on Codex." });
      for (const profile of ["main", "reviewer"]) {
        const preview = yield* kin.preview({ profile, provider: "claudeAgent" });
        assert.include(preview.prefix, "Reviewers run on Codex.");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
