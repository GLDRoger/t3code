import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestConsole from "effect/testing/TestConsole";

import { kinBrand } from "./kin-brand.ts";
import type { Guard } from "./lib/kinBrandGuards.ts";

// Real git and a real filesystem, so these run on the wall clock.
const TestLayer = Layer.mergeAll(NodeServices.layer, TestConsole.layer);

const RULES = `text:
  - files: [app/name.ts]
    from: T3 Code
    to: Kin
ignore: []
leaks:
  allow: []
`;

/** A git repo with one tracked file and the untracked branding folder, like a real checkout. */
const makeRepo = Effect.fn("makeRepo")(function* (options: {
  readonly rules?: string;
  readonly assets?: Record<string, string>;
  readonly app?: string;
  readonly files?: Record<string, string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-brand-test-" });
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(path.join(repo, "app"), { recursive: true });
  yield* fs.writeFileString(
    path.join(repo, "app/name.ts"),
    options.app ?? 'export const name = "T3 Code";\n',
  );
  for (const [file, content] of Object.entries(options.files ?? {})) {
    yield* fs.writeFileString(path.join(repo, file), content);
  }
  yield* fs.makeDirectory(path.join(repo, "branding/assets"), { recursive: true });
  yield* fs.writeFileString(path.join(repo, "branding/rules.yaml"), options.rules ?? RULES);
  for (const [file, content] of Object.entries(options.assets ?? {})) {
    const destination = path.join(repo, "branding/assets", file);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.writeFileString(destination, content);
  }
  for (const args of [
    ["init", "-q"],
    ["add", "app"],
  ]) {
    yield* spawner.string(ChildProcess.make("git", args, { cwd: repo }));
  }
  return { root, repo };
});

const brand = (
  repo: string,
  target: string,
  options: {
    readonly check?: boolean;
    readonly updateDriftBaseline?: boolean;
    readonly guards?: ReadonlyArray<Guard>;
  } = {},
) =>
  kinBrand({
    repoRoot: repo,
    target: Option.some(target),
    rules: Option.none(),
    check: options.check ?? false,
    updateDriftBaseline: options.updateDriftBaseline ?? false,
    skipTypecheck: true,
    guards: options.guards ?? [],
  });

const sha256 = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const failure = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("kin-brand", () => {
  it.live("brands the copy and leaves the checkout alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({});
      const target = path.join(root, "kin");
      yield* brand(repo, target);
      assert.strictEqual(
        yield* fs.readFileString(path.join(target, "app/name.ts")),
        'export const name = "Kin";\n',
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(repo, "app/name.ts")),
        'export const name = "T3 Code";\n',
      );
      assert.isTrue(yield* fs.exists(path.join(target, "branding/rules.yaml")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("fails on a rule that matches nothing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({
        rules: RULES.replace(
          "ignore:",
          "  - files: [app/name.ts]\n    from: Gone\n    to: Kin\nignore:",
        ),
      });
      const message = yield* failure(brand(repo, path.join(root, "kin")));
      assert.include(message, 'rule matches nothing: app/name.ts: "Gone" -> "Kin"');
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("fails on upstream identity no allow entry covers", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const app = 'export const name = "T3 Code";\nexport const link = "t3code://pair";\n';
      const { root, repo } = yield* makeRepo({ app });
      const message = yield* failure(brand(repo, path.join(root, "kin")));
      assert.include(message, 'app/name.ts:2 [scheme-link] "t3code://pair"');

      const allowed = yield* makeRepo({
        app,
        rules: RULES.replace("allow: []", "allow:\n    - reason: test\n      files: [app/**]"),
      });
      yield* brand(allowed.repo, path.join(allowed.root, "kin"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("fails on a guard whose file the copy doesn't have", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({});
      const guards = [{ file: "app/gone.ts", reason: "test", function: "f" }];
      const message = yield* failure(brand(repo, path.join(root, "kin"), { guards }));
      assert.include(message, "guard not applied: app/gone.ts is missing from the copy");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("fails on an asset with no file to replace", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({ assets: { "app/missing.png": "x" } });
      const message = yield* failure(brand(repo, path.join(root, "kin")));
      assert.include(message, "asset replaces nothing: app/missing.png");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("refuses a target it didn't make, inside the checkout, or around it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({});
      const occupied = path.join(root, "occupied");
      yield* fs.makeDirectory(occupied);
      yield* fs.writeFileString(path.join(occupied, "keep.txt"), "mine");

      assert.include(yield* failure(brand(repo, occupied)), "was not made by kin-brand");
      assert.strictEqual(yield* fs.readFileString(path.join(occupied, "keep.txt")), "mine");
      assert.include(yield* failure(brand(repo, path.join(repo, "out"))), "inside the checkout");
      assert.include(yield* failure(brand(repo, root)), "contains the checkout");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("refuses to write through a symlink in the copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { root, repo } = yield* makeRepo({ assets: { "app/link/name.ts": "x" } });
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "name.ts"), "outside");
      yield* fs.symlink(outside, path.join(repo, "app/link"));
      yield* spawner.string(ChildProcess.make("git", ["add", "app/link"], { cwd: repo }));

      const message = yield* failure(brand(repo, path.join(root, "kin")));
      assert.include(message, "through the symlink");
      assert.strictEqual(yield* fs.readFileString(path.join(outside, "name.ts")), "outside");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("fails on new drift, counts duplicates, and reports gone entries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, repo } = yield* makeRepo({ files: { "app/other.ts": 'f("Open t3code");\n' } });
      const target = path.join(root, "kin");
      const baseline = path.join(repo, "branding/drift-baseline.txt");
      const entry = 'app/other.ts: "Open t3code"';

      assert.include(yield* failure(brand(repo, target, { check: true })), `new upstream text`);
      assert.include(yield* failure(brand(repo, target, { check: true })), entry);

      yield* brand(repo, target, { check: true, updateDriftBaseline: true });
      assert.include(yield* fs.readFileString(baseline), 'app/other.ts\t"Open t3code"\n');
      yield* brand(repo, target, { check: true });

      // A second identical literal in the same file is new, not a repeat of the known one.
      yield* fs.writeFileString(
        path.join(repo, "app/other.ts"),
        'f("Open t3code");\nf("Open t3code");\n',
      );
      const duplicate = yield* failure(brand(repo, target, { check: true }));
      assert.include(duplicate, "1 problem(s)");
      assert.include(duplicate, entry);

      yield* fs.writeFileString(path.join(repo, "app/other.ts"), 'f("Open Kin");\n');
      yield* brand(repo, target, { check: true });
      const logs = (yield* TestConsole.logLines).map(String);
      assert.isTrue(
        logs.some((line) => line.includes("1 baseline entries are gone") && line.includes(entry)),
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("removes listed files and fails on a remove entry that matches nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const remove = (glob: string) =>
        RULES.replace("leaks:", `remove:\n  - reason: test\n    files: [${glob}]\nleaks:`);
      const { root, repo } = yield* makeRepo({
        rules: remove("app/claim.json"),
        files: { "app/claim.json": "{}" },
      });
      const target = path.join(root, "kin");
      yield* brand(repo, target);
      assert.isFalse(yield* fs.exists(path.join(target, "app/claim.json")));
      assert.isTrue(yield* fs.exists(path.join(repo, "app/claim.json")));

      const none = yield* makeRepo({ rules: remove("app/gone.json") });
      assert.include(
        yield* failure(brand(none.repo, path.join(none.root, "kin"))),
        "remove matches nothing: app/gone.json",
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("copies a source-file asset only while upstream's file has the recorded hash", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const upstream = "export const Mark = () => <b>T3</b>;\n";
      const withHash = (hash: string) =>
        RULES.replace("leaks:", `sourceAssets:\n  app/mark.tsx: ${hash}\nleaks:`);
      const options = (rules: string) => ({
        rules,
        files: { "app/mark.tsx": upstream },
        assets: { "app/mark.tsx": "export const Mark = () => <b>Kin</b>;\n" },
      });

      const good = yield* makeRepo(options(withHash(yield* sha256(upstream))));
      yield* brand(good.repo, path.join(good.root, "kin"));
      assert.include(
        yield* fs.readFileString(path.join(good.root, "kin/app/mark.tsx")),
        "<b>Kin</b>",
      );

      const stale = yield* makeRepo(options(withHash(yield* sha256("an older upstream"))));
      assert.include(
        yield* failure(brand(stale.repo, path.join(stale.root, "kin"))),
        "upstream changed app/mark.tsx since branding/assets copied it",
      );

      const missing = yield* makeRepo(options(RULES));
      assert.include(
        yield* failure(brand(missing.repo, path.join(missing.root, "kin"))),
        `source-file asset app/mark.tsx needs its upstream sha256 in sourceAssets in rules.yaml: ${yield* sha256(upstream)}`,
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
