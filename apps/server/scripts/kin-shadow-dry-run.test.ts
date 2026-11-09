import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Vcs from "../src/vcs/VcsProcess.ts";
import { runDryRun, seedFixtureRemote } from "./kin-shadow-dry-run.ts";

const day = new URL("./kin-shadow-dry-run.day.json", import.meta.url).pathname;
const services = Vcs.layer.pipe(Layer.provideMerge(NodeServices.layer));
const shadow = "refs/heads/kin/shadow/fixture-lead";
const decodeMemory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ memory: Schema.Record(Schema.String, Schema.String) })),
);

const gitIn = Effect.fn("KinDryRunTest.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const result = yield* (yield* Vcs.VcsProcess).run({
    operation: "kin.dryRun.test",
    command: "git",
    cwd,
    args: [`--git-dir=${cwd}`, ...args],
  });
  return result.stdout;
});
const refsOf = Effect.fn("KinDryRunTest.refsOf")(function* (remote: string) {
  const out = yield* gitIn(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => line.split(" ")),
  );
});

/** A stand-in for the real memory remote, outside the state directory the script works in. */
const realRemote = Effect.fn("KinDryRunTest.realRemote")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  yield* fs.makeDirectory(`${root}/remote`);
  const { memory } = yield* decodeMemory(yield* fs.readFileString(day));
  const remote = yield* seedFixtureRemote(`${root}/remote`, memory);
  return { root, remote, before: yield* refsOf(remote) };
});

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
        [{ ref: shadow, before: null }],
      );
      assert.strictEqual(report.pushed, undefined);
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

it.live("with --push the real remote gains exactly the shadow branch, after the checks", () =>
  Effect.gen(function* () {
    const { root, remote, before } = yield* realRemote();
    const report = yield* runDryRun({
      dayFile: day,
      stateDir: `${root}/state`,
      agentId: "fixture-lead",
      memoryUrl: remote,
      home: `${root}/home`,
      push: true,
    });
    assert.deepStrictEqual(report.violations, []);
    const sha = report.refChanges.find((change) => change.ref === shadow)?.after;
    assert.deepStrictEqual(report.pushed, { ref: shadow, sha });
    assert.deepStrictEqual(yield* refsOf(remote), { ...before, [shadow]: sha });
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.live("a writer that moves main fails the checks and never reaches the real remote", () =>
  Effect.gen(function* () {
    const { root, remote, before } = yield* realRemote();
    // Above L0 the writer commits to main, standing in for a writer bug at L0.
    const report = yield* runDryRun({
      dayFile: day,
      stateDir: `${root}/state`,
      agentId: "fixture-lead",
      memoryUrl: remote,
      home: `${root}/home`,
      push: true,
      level: "L1",
    });
    assert.include(
      report.violations,
      `The mirror ref refs/heads/main changed; only ${shadow} may.`,
    );
    assert.strictEqual(report.pushed, undefined);
    assert.deepStrictEqual(yield* refsOf(remote), before);
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.live("refuses when the shadow branch already exists on the remote, before mirroring", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, remote } = yield* realRemote();
    yield* gitIn(remote, ["update-ref", shadow, "refs/heads/main"]);
    const before = yield* refsOf(remote);
    const error = yield* runDryRun({
      dayFile: day,
      stateDir: `${root}/state`,
      agentId: "fixture-lead",
      memoryUrl: remote,
      home: `${root}/home`,
      push: true,
    }).pipe(Effect.flip);
    assert.include(error.message, `${shadow} already exists`);
    assert.isFalse(yield* fs.exists(`${root}/state/memory-mirror.git`));
    assert.deepStrictEqual(yield* refsOf(remote), before);
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.live(
  "refuses an inline secret or a refspec-bending id in a flag, before creating anything",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      for (const unsafe of [
        { credentialHelper: "!f() { echo password=ghp_inline; }; f" },
        { sshCommand: "ssh -i key; echo $TOKEN" },
        { agentId: "x:refs/heads/main" },
      ]) {
        const error = yield* runDryRun({
          dayFile: day,
          stateDir: `${root}/state`,
          agentId: "fixture-lead",
          home: `${root}/home`,
          ...unsafe,
        }).pipe(Effect.flip);
        assert.match(error.message, /^--(credential-helper|ssh-command|agent-id) takes/);
      }
      assert.isFalse(yield* fs.exists(`${root}/state`));
    }).pipe(Effect.provide(services), Effect.scoped),
);

it.live("refuses a state directory that is the live ~/.t3 or inside it, before creating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    yield* fs.makeDirectory(`${root}/home/.t3`, { recursive: true });
    yield* fs.symlink(`${root}/home/.t3`, `${root}/alias`);
    const home = `${root}/home`;
    for (const refused of [
      { stateDir: `${home}/.t3`, home },
      { stateDir: `${home}/.t3/dry-run`, home },
      { stateDir: `${root}/alias/dry-run`, home },
      { stateDir: `${home}/.T3/dry-run`, home },
      { stateDir: `${root}/state`, home: undefined },
      { stateDir: `${root}/state`, home: "" },
    ]) {
      // macOS folds case, so ~/.T3 is the live ~/.t3 there.
      const error = yield* runDryRun({ dayFile: day, agentId: "fixture-lead", ...refused }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "KinDryRunError");
    }
    assert.deepStrictEqual(yield* fs.readDirectory(`${root}/home/.t3`), []);
    assert.isFalse(yield* fs.exists(`${root}/state`));
  }).pipe(Effect.provide(services), Effect.scoped),
);
