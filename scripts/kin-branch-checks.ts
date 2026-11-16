// Against the ref a branch merges into: no recently merged PR's lines dropped without
// `Supersedes: #N`, Kin migrations numbered on from the ref's with no gap, and the agent
// instructions' version one above the ref's exactly when their text changed.
//   node scripts/kin-branch-checks.ts <ref> [--days 14] [--root <checkout>]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { Argument, Command, Flag } from "effect/cli";

import { git, gitLines } from "./check-changed.ts";

export const MIGRATIONS = "apps/server/src/kin/persistence/KinMigrations.ts";
export const INSTRUCTIONS = "apps/server/src/kin/lead/instructions.ts";
const SURVIVAL_SKIP = /(?:\.test\.|\.ndjson$|pnpm-lock|instructions\.ts$|KinMigrations\.ts$)/;
const MIN_LINE = 25;
const MIN_ALIVE = 10;
const LOST_SHARE = 0.6;
const SAME_LINE = 0.7;

/** `"146_SendDecidedBy": SendDecidedBy` entries of the migration loader. */
export const migrationIds = (source: string) =>
  [...source.matchAll(/^\s*"(\d+)_(\w+)":/gm)].map((match) => ({
    id: Number(match[1]),
    name: match[2]!,
  }));

export const checkMigrations = (
  base: ReadonlyArray<{ readonly id: number; readonly name: string }>,
  head: ReadonlyArray<{ readonly id: number; readonly name: string }>,
) => {
  const problems: Array<string> = [];
  const highest = Math.max(0, ...base.map((one) => one.id));
  const seen = new Map<number, string>();
  for (const one of head) {
    const other = seen.get(one.id);
    if (other !== undefined)
      problems.push(`Kin migration ${one.id} is used twice (${other}, ${one.name}).`);
    seen.set(one.id, one.name);
  }
  const known = new Set(base.map((one) => `${one.id}_${one.name}`));
  const added = head
    .filter((one) => !known.has(`${one.id}_${one.name}`))
    .toSorted((a, b) => a.id - b.id);
  // Effect's Migrator skips an id below one a host already ran, so a gap left for another
  // branch, or a number below the base's, never runs where the higher one landed first.
  added.forEach((one, index) => {
    if (one.id !== highest + 1 + index)
      problems.push(
        `Kin migration ${one.id}_${one.name} must be ${highest + 1 + index}: the next free number above the base's highest (${highest}), with no gap.`,
      );
  });
  return problems;
};

const VERSION = /^export const instructions = `instructions-version: (\d+)\n/;
export const instructionsVersion = (source: string) => {
  const found = VERSION.exec(source);
  return found === null ? undefined : Number(found[1]);
};
const instructionsBody = (source: string) => source.replace(VERSION, "");

/** `mergeBase` is where the branch left the ref, `tip` the ref now, `head` the branch. */
export const checkInstructions = (input: {
  readonly mergeBase: string;
  readonly tip: string;
  readonly head: string;
}) => {
  const [was, tip, now] = [input.mergeBase, input.tip, input.head].map(instructionsVersion);
  if (was === undefined || tip === undefined || now === undefined)
    return [`${INSTRUCTIONS} must start with \`instructions-version: N\`.`];
  const changed = instructionsBody(input.head) !== instructionsBody(input.mergeBase);
  if (changed && now !== tip + 1)
    return [
      `The agent instructions changed, so their version is ${tip + 1} (one above the base's ${tip}), not ${now}.${tip !== was ? " Merge the base first: it moved." : ""}`,
    ];
  if (!changed && now !== was)
    return [`The agent instructions text is unchanged, so keep version ${was}, not ${now}.`];
  return [];
};

/** Distinct added lines long enough to be someone's work, per file, from a `-U0` diff. */
export const addedLines = (diff: string) => {
  const files = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current = path === "/dev/null" ? undefined : new Set();
      if (current !== undefined) files.set(path, current);
    } else if (current !== undefined && line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1).trim();
      if (text.length >= MIN_LINE) current.add(text);
    }
  }
  return files;
};

export type Merged = {
  readonly pr: number;
  readonly files: ReadonlyMap<string, ReadonlySet<string>>;
};

const tokens = (line: string) => new Set(line.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? []);
/** A line edited in place (a rename, a new argument) shares most of its tokens with the old. */
const keptAsVariant = (line: string, candidates: ReadonlyArray<ReadonlySet<string>>) => {
  const mine = tokens(line);
  return candidates.some((other) => {
    let shared = 0;
    for (const token of mine) if (other.has(token)) shared++;
    return shared / Math.max(mine.size, other.size) >= SAME_LINE;
  });
};

/** Each PR's added lines still on the ref's tip, and how many of those the branch removed. */
export const checkSurvival = (input: {
  readonly merged: ReadonlyArray<Merged>;
  readonly tip: (path: string) => string | undefined;
  readonly head: (path: string) => string | undefined;
  readonly superseded: ReadonlySet<number>;
}) => {
  const problems: Array<string> = [];
  const lines = (text: string | undefined) =>
    new Set((text ?? "").split("\n").map((l) => l.trim()));
  for (const { pr, files } of input.merged) {
    if (input.superseded.has(pr)) continue;
    for (const [path, added] of files) {
      const onTip = lines(input.tip(path));
      const alive = [...added].filter((line) => onTip.has(line));
      if (alive.length < MIN_ALIVE) continue;
      const onHead = lines(input.head(path));
      const missing = alive.filter((line) => !onHead.has(line));
      const variants = [...onHead].filter((line) => line.length >= MIN_LINE).map(tokens);
      const lost = missing.filter((line) => !keptAsVariant(line, variants)).length;
      if (lost / alive.length > LOST_SHARE)
        problems.push(
          `${path}: this branch removes ${lost} of the ${alive.length} lines #${pr} added. Merge the base and keep its work, or say why in a commit: \`Supersedes: #${pr}\`.`,
        );
    }
  }
  return problems;
};

export const supersededIn = (messages: string) =>
  new Set(
    [...messages.matchAll(/^Supersedes:\s*((?:#\d+[\s,]*)+)$/gim)].flatMap((match) =>
      [...match[1]!.matchAll(/#(\d+)/g)].map((one) => Number(one[1])),
    ),
  );

/** All three checks for the branch at `root` against `ref`; problems, or none. */
export const kinBranchChecks = Effect.fn("kinBranchChecks")(function* (
  root: string,
  ref: string,
  days: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const show = (rev: string, file: string) =>
    git(root, ["show", `${rev}:${file}`]).pipe(
      Effect.map((out) => out.toString()),
      Effect.option,
    );
  const onDisk = (file: string) => fs.readFileString(path.join(root, file)).pipe(Effect.option);
  const mergeBase = (yield* git(root, ["merge-base", "HEAD", ref])).toString().trim();
  const changed = (yield* gitLines(root, [
    "diff",
    "--name-only",
    "--no-renames",
    mergeBase,
  ])).filter((file) => !SURVIVAL_SKIP.test(file));
  const problems: Array<string> = [];

  const [baseMigrations, headMigrations] = [
    yield* show(ref, MIGRATIONS),
    yield* onDisk(MIGRATIONS),
  ];
  if (Option.isSome(baseMigrations) && Option.isSome(headMigrations))
    problems.push(
      ...checkMigrations(migrationIds(baseMigrations.value), migrationIds(headMigrations.value)),
    );

  const [was, tip, now] = [
    yield* show(mergeBase, INSTRUCTIONS),
    yield* show(ref, INSTRUCTIONS),
    yield* onDisk(INSTRUCTIONS),
  ];
  if (Option.isSome(was) && Option.isSome(tip) && Option.isSome(now))
    problems.push(...checkInstructions({ mergeBase: was.value, tip: tip.value, head: now.value }));

  if (changed.length > 0) {
    const merges = yield* gitLines(root, [
      "log",
      "--first-parent",
      "--merges",
      `--since=${days}.days.ago`,
      "--format=%H %s",
      ref,
    ]);
    const merged: Array<Merged> = [];
    for (const line of merges) {
      const [sha, ...subject] = line.split(" ");
      const pr = /#(\d+)/.exec(subject.join(" "))?.[1];
      if (sha === undefined || pr === undefined) continue;
      const diff = (yield* git(root, [
        "diff",
        "-U0",
        `${sha}^1`,
        sha,
        "--",
        ...changed,
      ])).toString();
      merged.push({ pr: Number(pr), files: addedLines(diff) });
    }
    const files = new Set(merged.flatMap((one) => [...one.files.keys()]));
    const tipText = new Map<string, string | undefined>();
    const headText = new Map<string, string | undefined>();
    for (const file of files) {
      tipText.set(file, Option.getOrUndefined(yield* show(ref, file)));
      headText.set(file, Option.getOrUndefined(yield* onDisk(file)));
    }
    const messages = (yield* git(root, ["log", "--format=%B", `${mergeBase}..HEAD`])).toString();
    problems.push(
      ...checkSurvival({
        merged,
        tip: (file) => tipText.get(file),
        head: (file) => headText.get(file),
        superseded: supersededIn(messages),
      }),
    );
  }
  return problems;
});

export const kinBranchChecksCommand = Command.make(
  "kin-branch-checks",
  {
    ref: Argument.String("ref").pipe(Argument.withDescription("The branch this one merges into.")),
    days: Flag.Int("days").pipe(
      Flag.withDescription("How far back merged PRs count for survival."),
      Flag.withDefault(14),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription("The checkout to check; defaults to this one."),
      Flag.optional,
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = Option.isSome(input.root)
        ? input.root.value
        : yield* path.fromFileUrl(new URL("..", import.meta.url));
      const problems = yield* kinBranchChecks(root, input.ref, input.days);
      if (problems.length === 0) return yield* Console.log("kin branch checks: clean");
      for (const problem of problems) yield* Console.error(problem);
      yield* Effect.sync(() => {
        process.exitCode = 1;
      });
    }).pipe(
      Effect.catch((message) =>
        Console.error(String(message)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
).pipe(Command.withDescription("Kin's merge-survival, migration and instructions checks."));

if (import.meta.main) {
  Command.run(kinBranchChecksCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
