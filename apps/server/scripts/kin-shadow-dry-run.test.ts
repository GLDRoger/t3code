import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Vcs from "../src/vcs/VcsProcess.ts";
import { runDryRun } from "./kin-shadow-dry-run.ts";

const day = new URL("./kin-shadow-dry-run.day.json", import.meta.url).pathname;
const services = Vcs.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.live(
  "replays the recorded day at L0: only the shadow branch moves, nothing leaves the owner's chat, nothing runs",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const report = yield* runDryRun({
        dayFile: day,
        stateDir: `${root}/state`,
        agentId: "fixture-lead",
        home: `${root}/home`,
      });
      assert.deepStrictEqual(report.violations, []);
      assert.deepStrictEqual(
        report.refChanges.map(({ ref, before }) => ({ ref, before })),
        [{ ref: "refs/heads/kin/shadow/fixture-lead", before: null }],
      );
      // The group reply, the merge request and the worker were drafted and held back.
      assert.deepStrictEqual(
        report.toolCalls.filter((call) => call.outcome !== "ok"),
        [
          { tool: "kin_chat_post", outcome: "shadowed" },
          { tool: "request_action", outcome: "shadowed" },
          { tool: "kin_delegate", outcome: "shadowed" },
        ],
      );
      const text = report.lines.join("\n");
      assert.include(text, "[shadow_summary card] What Fixture Lead would have done today");
      assert.include(text, "[shadow_review card] Review what Fixture Lead would have done today");
      assert.include(text, "[evening_summary card, 2026-11-09]");
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.live("refuses a state directory that is the live ~/.t3 or inside it, before creating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    yield* fs.makeDirectory(`${root}/home/.t3`, { recursive: true });
    yield* fs.symlink(`${root}/home/.t3`, `${root}/alias`);
    for (const stateDir of [
      `${root}/home/.t3`,
      `${root}/home/.t3/dry-run`,
      `${root}/alias/dry-run`,
    ]) {
      const error = yield* runDryRun({
        dayFile: day,
        stateDir,
        agentId: "fixture-lead",
        home: `${root}/home`,
      }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "KinDryRunError");
    }
    assert.deepStrictEqual(yield* fs.readDirectory(`${root}/home/.t3`), []);
  }).pipe(Effect.provide(services), Effect.scoped),
);
