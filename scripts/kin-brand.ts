#!/usr/bin/env node
// Brands a copy of this checkout as Kin from branding/rules.yaml; source keeps upstream's names.
// See KIN.md "Branding at build time" and `node scripts/kin-brand.ts --help`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { vitePlusCommand } from "./check-changed-command.ts";
import {
  KinBrandError,
  brandSource,
  excerpt,
  isAllowedLeak,
  isIgnoredFile,
  isTestPath,
  matchesAny,
  mightNeedScan,
  parseBrandRules,
  rawLeaks,
  ruleLabel,
  sourceKind,
  type BrandRules,
  type FileResult,
} from "./lib/kinBrandEngine.ts";
import { GUARDS, applyGuards, type Guard } from "./lib/kinBrandGuards.ts";
import {
  MOBILE_CONFIG_FILE,
  MOBILE_OPS_ENV,
  brandMobileConfig,
} from "./lib/kinBrandMobileConfig.ts";

const MARKER_FILE = ".kin-brand";
const DRIFT_BASELINE_FILE = "drift-baseline.txt";
// Untracked files the copy needs while BRAND-1 work is uncommitted; everything else is tracked.
const UNTRACKED_KIN_PATHS = ["branding", "scripts/kin-*", "scripts/lib/kinBrand*"];
const BINARY_EXTENSION =
  /\.(png|jpe?g|gif|webp|ico|icns|svgz|ttf|otf|woff2?|mp3|mp4|mov|wav|zip|gz|tgz|br|jar|keystore|pdf|wasm|node|sqlite|lockb)$/i;

const fail = (message: string) => Effect.fail(new KinBrandError({ message }));

const decodePackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.optional(Schema.String) })),
);

const run = Effect.fn("kinBrand.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  capture = false,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          cwd,
          extendEnv: true,
          stdout: capture ? "pipe" : "inherit",
          stderr: "inherit",
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          capture ? Stream.mkString(Stream.decodeText(handle.stdout)) : Effect.succeed(""),
          handle.exitCode,
        ],
        { concurrency: 2 },
      );
      if (exitCode !== 0) {
        return yield* fail(`${command} ${args.join(" ")} exited with ${exitCode}`);
      }
      return stdout;
    }),
  );
});

const isInside = (path: Path.Path, child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Refuses to write `file` under `target` when it, or any folder on the way, is a symlink. */
const assertNoSymlink = Effect.fn("kinBrand.assertNoSymlink")(function* (
  target: string,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = target;
  for (const part of file.split("/").filter((segment) => segment && segment !== ".")) {
    current = path.join(current, part);
    const info = yield* fs.lstat(current).pipe(Effect.option);
    if (Option.isNone(info)) return;
    if (info.value.type === "SymbolicLink") {
      return yield* fail(`refusing to write ${file} through the symlink ${current}`);
    }
  }
});

/** The checkout's files: tracked ones, plus the untracked Kin branding files. */
const listCheckoutFiles = Effect.fn("kinBrand.listCheckoutFiles")(function* (repoRoot: string) {
  const tracked = yield* run("git", ["ls-files", "-z", "--cached"], repoRoot, true);
  const kin = yield* run(
    "git",
    ["ls-files", "-z", "--others", "--exclude-standard", "--", ...UNTRACKED_KIN_PATHS],
    repoRoot,
    true,
  );
  // Index modes: 120000 is a symlink, 160000 a submodule, which a build copy skips.
  const modes = new Map(
    (yield* run("git", ["ls-files", "-s", "-z"], repoRoot, true))
      .split("\0")
      .filter(Boolean)
      .map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, 6)] as const),
  );
  const files = [...new Set(`${tracked}${kin}`.split("\0").filter(Boolean))].filter(
    (file) => modes.get(file) !== "160000",
  );
  return { files, modes };
});

export const copyCheckout = Effect.fn("kinBrand.copyCheckout")(function* (
  repoRoot: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realRoot = yield* fs.realPath(repoRoot);
  let existing = target;
  while (!(yield* fs.exists(existing)) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  const realTarget = path.join(yield* fs.realPath(existing), path.relative(existing, target));
  if (isInside(path, realTarget, realRoot)) {
    return yield* fail(`--target ${target} is inside the checkout; pick a folder outside it`);
  }
  if (isInside(path, realRoot, realTarget)) {
    return yield* fail(`--target ${target} contains the checkout; pick a folder outside it`);
  }
  if (yield* fs.exists(target)) {
    const entries = yield* fs.readDirectory(target);
    if (entries.length > 0 && !entries.includes(MARKER_FILE)) {
      return yield* fail(
        `${target} exists and was not made by kin-brand; pick an empty or new --target`,
      );
    }
    yield* fs.remove(target, { recursive: true });
  }

  const { files, modes } = yield* listCheckoutFiles(repoRoot);
  yield* fs.makeDirectory(target, { recursive: true });
  yield* fs.writeFileString(
    path.join(target, MARKER_FILE),
    "Branded copy made by scripts/kin-brand.ts\n",
  );
  yield* Effect.forEach(
    files,
    // Runs once per file, thousands of times; a span each would swamp the run's trace.
    Effect.fnUntraced(function* (file) {
      const source = path.join(repoRoot, file);
      const destination = path.join(target, file);
      yield* assertNoSymlink(target, path.dirname(file));
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
      if (modes.get(file) === "120000") {
        yield* fs.symlink(yield* fs.readLink(source), destination);
      } else if (yield* fs.exists(source)) {
        yield* fs.copyFile(source, destination);
      }
    }),
    { concurrency: 64, discard: true },
  );
  return files;
});

const sha256 = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

/**
 * Copies branding assets over the copy's files. Problems: an asset with no upstream file, and a
 * source-file asset (a copied .tsx) whose upstream file no longer has the hash in `sourceAssets`.
 */
const copyAssets = Effect.fn("kinBrand.copyAssets")(function* (
  rules: BrandRules,
  assetsRoot: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = (yield* fs.readDirectory(assetsRoot, { recursive: true })).filter(
    (entry) => entry !== "README.md" && !entry.endsWith(".DS_Store"),
  );
  const hashes = rules.sourceAssets ?? {};
  const problems: Array<string> = [];
  const copied: Array<string> = [];
  for (const asset of entries.toSorted()) {
    const source = path.join(assetsRoot, asset);
    if ((yield* fs.stat(source)).type !== "File") continue;
    const file = asset.split(path.sep).join("/");
    const destination = path.join(target, file);
    yield* assertNoSymlink(target, file);
    if (!(yield* fs.exists(destination))) {
      problems.push(`asset replaces nothing: ${file} (the copy has no such file)`);
      continue;
    }
    if (sourceKind(file) === "script" || file in hashes) {
      const expected = hashes[file];
      const actual = yield* sha256(yield* fs.readFile(destination));
      if (expected === undefined) {
        problems.push(
          `source-file asset ${file} needs its upstream sha256 in sourceAssets in rules.yaml: ${actual}`,
        );
        continue;
      }
      if (actual !== expected) {
        problems.push(
          `upstream changed ${file} since branding/assets copied it (sha256 ${actual}, expected ${expected}); review upstream's change, update the asset, then set its sourceAssets hash`,
        );
        continue;
      }
    }
    yield* fs.copyFile(source, destination);
    copied.push(file);
  }
  const assetFiles = new Set(entries.map((entry) => entry.split(path.sep).join("/")));
  for (const file of Object.keys(hashes).filter((file) => !assetFiles.has(file))) {
    problems.push(`sourceAssets names ${file}, but branding/assets has no such file`);
  }
  return { copied, problems };
});

/** Deletes the `remove` entries' files from the copy; an entry that matches nothing is a problem. */
const removeFiles = Effect.fn("kinBrand.removeFiles")(function* (
  rules: BrandRules,
  files: ReadonlyArray<string>,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const removed = new Set<string>();
  const problems: Array<string> = [];
  for (const entry of rules.remove ?? []) {
    const hits = files.filter((file) => matchesAny(file, entry.files));
    if (hits.length === 0) problems.push(`remove matches nothing: ${entry.files.join(", ")}`);
    for (const file of hits) {
      yield* assertNoSymlink(target, file);
      yield* fs.remove(path.join(target, file), { force: true });
      removed.add(file);
    }
  }
  return { removed, problems };
});

const BASELINE_HEADER = [
  "# Upstream identity text the branded copy still has, kept on purpose or not branded yet.",
  "# One `<file><TAB><excerpt>` per line. `node scripts/kin-brand.ts --check` fails on any not here;",
  "# review them, then rewrite this file with `--update-drift-baseline`.",
];

/** Counts each line, so a second identical literal in one file is new drift. */
const countLines = (lines: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
};

const readBaseline = Effect.fn("kinBrand.readBaseline")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return new Map<string, number>();
  return countLines(
    (yield* fs.readFileString(file))
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
});

/** Entries `a` has more of than `b`, once per extra occurrence. */
const surplus = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  [...a].flatMap(([entry, count]) =>
    Array.from({ length: Math.max(0, count - (b.get(entry) ?? 0)) }, () => entry),
  );

const emptyResult = (source: string, leaks: FileResult["leaks"]): FileResult => ({
  output: source,
  changed: false,
  matches: new Map(),
  uncovered: [],
  leaks,
});

export const kinBrand = Effect.fn("kinBrand")(function* (options: {
  readonly target: Option.Option<string>;
  readonly rules: Option.Option<string>;
  readonly check: boolean;
  readonly updateDriftBaseline: boolean;
  /** Tests point this at a temp repo and skip the install and typecheck. */
  readonly repoRoot?: string;
  readonly skipTypecheck?: boolean;
  readonly guards?: ReadonlyArray<Guard>;
}) {
  const guards = options.guards ?? GUARDS;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = path.resolve(
    options.repoRoot ?? (yield* path.fromFileUrl(new URL("..", import.meta.url))),
  );
  const rulesPath = path.resolve(
    Option.getOrElse(options.rules, () => path.join(repoRoot, "branding/rules.yaml")),
  );
  const brandingDir = path.dirname(rulesPath);
  const rules = yield* parseBrandRules(yield* fs.readFileString(rulesPath));
  const target = path.resolve(
    Option.getOrElse(options.target, () =>
      path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-kin`),
    ),
  );

  yield* Console.log(`kin-brand: copying ${repoRoot} to ${target}`);
  const copiedFiles = yield* copyCheckout(repoRoot, target);
  const removal = yield* removeFiles(rules, copiedFiles, target);
  const files = copiedFiles.filter((file) => !removal.removed.has(file));
  const assets = yield* copyAssets(rules, path.join(brandingDir, "assets"), target);

  const matches = new Map<number, number>();
  const changedFiles = new Set<string>(assets.copied);
  const drift: Array<string> = [];
  const leaks: Array<string> = [];
  const unscanned: Array<string> = [];
  const problems: Array<string> = [...removal.problems, ...assets.problems];
  const guarded = new Set<string>();
  const record = (file: string, result: FileResult) => {
    for (const entry of result.uncovered) drift.push(`${file}\t${excerpt(entry.text)}`);
    for (const entry of result.leaks) {
      if (isAllowedLeak(rules, file, entry.leak, entry.text)) continue;
      const where = entry.line ? `${file}:${entry.line}` : file;
      leaks.push(`${where} [${entry.leak}] ${JSON.stringify(entry.text.slice(0, 160))}`);
    }
  };

  // Ignored files take no rules and add no drift, but still get guards and the leak scan.
  const unbranded: BrandRules = { ...rules, text: [] };
  const scanned = files.filter((file) => !isTestPath(file));
  yield* Effect.forEach(
    scanned,
    // Runs once per file, thousands of times; a span each would swamp the run's trace.
    Effect.fnUntraced(function* (file) {
      const destination = path.join(target, file);
      const info = yield* fs.lstat(destination).pipe(Effect.option);
      if (Option.isNone(info) || info.value.type !== "File") return;
      const ignored = isIgnoredFile(rules, file);
      const fileRules = ignored ? unbranded : rules;
      const named =
        fileRules.text.some((rule) => matchesAny(file, rule.files)) ||
        guards.some((guard) => guard.file === file);
      if (!sourceKind(file)) {
        if (file.endsWith(".md") || BINARY_EXTENSION.test(file)) return;
        const source = yield* fs.readFileString(destination);
        if (source.includes("\0")) return;
        if (!named) return record(file, emptyResult(source, rawLeaks(source)));
      }
      const source = yield* fs.readFileString(destination);
      if (!named && !mightNeedScan(source)) return;
      const parsed = yield* Effect.try({
        try: () => brandSource(fileRules, file, source),
        catch: (cause) => new KinBrandError({ message: String(cause) }),
      }).pipe(Effect.option);
      if (Option.isNone(parsed)) {
        // JSON with comments (tsconfig, devcontainer) doesn't parse; only a rule needs it to.
        if (named) return yield* fail(`could not parse ${file}`);
        unscanned.push(file);
        record(file, emptyResult(source, rawLeaks(source)));
        return;
      }
      for (const [index, count] of parsed.value.matches) {
        matches.set(index, (matches.get(index) ?? 0) + count);
      }
      let result = ignored ? { ...parsed.value, uncovered: [] } : parsed.value;
      const guard = applyGuards(file, result.output, guards);
      problems.push(...guard.problems);
      if (guard.applied > 0) {
        guarded.add(file);
        result = { ...result, output: guard.output, changed: true };
      }
      if (file === MOBILE_CONFIG_FILE) {
        const mobile = brandMobileConfig(result.output);
        problems.push(...mobile.problems);
        result = {
          ...brandSource({ ...rules, text: [] }, file, mobile.output),
          output: mobile.output,
          changed: mobile.output !== source,
        };
      }
      record(file, result);
      if (result.changed) {
        changedFiles.add(file);
        yield* assertNoSymlink(target, file);
        yield* fs.writeFileString(destination, result.output);
      }
    }),
    { concurrency: 16, discard: true },
  );

  yield* Console.log(
    `kin-brand: rewrote ${changedFiles.size - assets.copied.length} files, copied ${assets.copied.length} assets`,
  );

  problems.push(
    ...rules.text
      .filter((_, index) => !matches.has(index))
      .map((rule) => `rule matches nothing: ${ruleLabel(rule)}`),
    ...guards
      .filter((guard) => !guarded.has(guard.file))
      .map((guard) => `guard not applied: ${guard.file} is missing from the copy`),
    ...leaks
      .toSorted()
      .map((leak) => `upstream identity left (add a rule or a leaks.allow entry): ${leak}`),
  );

  const baselinePath = path.join(brandingDir, DRIFT_BASELINE_FILE);
  const current = drift.toSorted();
  if (options.updateDriftBaseline) {
    yield* fs.writeFileString(baselinePath, `${[...BASELINE_HEADER, ...current].join("\n")}\n`);
    yield* Console.log(`kin-brand: wrote ${current.length} entries to ${baselinePath}`);
  }

  if (options.check) {
    const baseline = yield* readBaseline(baselinePath);
    const counts = countLines(current);
    const newDrift = surplus(counts, baseline);
    const gone = surplus(baseline, counts);
    yield* Console.log(
      newDrift.length === 0
        ? `kin-brand: no new upstream text since ${DRIFT_BASELINE_FILE} (${current.length} known)`
        : `kin-brand: ${newDrift.length} new upstream literals since ${DRIFT_BASELINE_FILE}`,
    );
    if (gone.length > 0) {
      yield* Console.log(
        `kin-brand: ${gone.length} baseline entries are gone; refresh with --update-drift-baseline:\n  ${gone.map((entry) => entry.replace("\t", ": ")).join("\n  ")}`,
      );
    }
    if (unscanned.length > 0) {
      yield* Console.log(
        `kin-brand: could not parse, so scanned for leaks as plain text:\n  ${unscanned.toSorted().join("\n  ")}`,
      );
    }
    for (const [name, purpose] of Object.entries(MOBILE_OPS_ENV)) {
      if (Option.isNone(yield* Config.option(Config.String(name)))) {
        yield* Console.warn(
          `kin-brand: warning: ${name} is unset, so the mobile build has no ${purpose}`,
        );
      }
    }
    problems.push(
      ...newDrift.map(
        (entry) =>
          `new upstream text (add a rule or an ignore, or --update-drift-baseline): ${entry.replace("\t", ": ")}`,
      ),
    );
  }
  if (problems.length > 0) {
    return yield* fail(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  }
  if (!options.check || options.skipTypecheck) return;

  const packages = new Set<string>();
  for (const file of [...changedFiles, ...removal.removed].filter(
    (file) => sourceKind(file) === "script",
  )) {
    let dir = path.dirname(path.join(target, file));
    while (dir.startsWith(target) && dir !== target) {
      const manifest = path.join(dir, "package.json");
      if (yield* fs.exists(manifest)) {
        const { name } = yield* decodePackageManifest(yield* fs.readFileString(manifest)).pipe(
          Effect.mapError(
            (cause) => new KinBrandError({ message: `${manifest}: ${cause.message}` }),
          ),
        );
        if (name) packages.add(name);
        break;
      }
      dir = path.dirname(dir);
    }
  }
  const filters = [...packages].toSorted();
  yield* Console.log("kin-brand: installing dependencies in the copy");
  yield* run(...vitePlusCommand(["install", "--frozen-lockfile", "--prefer-offline"]), target);
  yield* Console.log(`kin-brand: typechecking ${filters.join(", ")}`);
  yield* run(
    ...vitePlusCommand(["run", ...filters.flatMap((name) => ["--filter", name]), "typecheck"]),
    target,
  );
  yield* Console.log("kin-brand: check passed");
});

export const kinBrandCommand = Command.make(
  "kin-brand",
  {
    target: Flag.String("target").pipe(
      Flag.withDescription("Directory for the branded copy (default: ../<checkout>-kin)."),
      Flag.optional,
    ),
    rules: Flag.String("rules").pipe(
      Flag.withDescription(
        "Rules file; its folder holds assets/ and the drift baseline (default: branding/rules.yaml).",
      ),
      Flag.optional,
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription("Fail on new upstream text, then install and typecheck the copy."),
      Flag.withDefault(false),
    ),
    updateDriftBaseline: Flag.Boolean("update-drift-baseline").pipe(
      Flag.withDescription("Rewrite the drift baseline with the copy's current upstream text."),
      Flag.withDefault(false),
    ),
  },
  kinBrand,
).pipe(Command.withDescription("Copy this checkout and apply Kin's branding to the copy."));

if (import.meta.main) {
  Command.run(kinBrandCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
