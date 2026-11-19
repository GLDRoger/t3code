// Against the ref a branch merges into: merged PRs' lines kept unless superseded, Kin migrations
// numbered on with no gap, the instructions version moved exactly when their text did, no sentence
// typed into both Kin clients, no identity Kin's branding rejects, and a `People-change:` line.
//   node scripts/kin-branch-checks.ts <ref> [--days 14] [--root <checkout>]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
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

/**
 * `mergeBase` is where the branch left the ref, `tip` the ref now, `head` the branch.
 * `mergedPrs` counts PRs already merged between the ref and head, as in a release range.
 */
export const checkInstructions = (input: {
  readonly mergeBase: string;
  readonly tip: string;
  readonly head: string;
  readonly mergedPrs?: number;
}) => {
  const [was, tip, now] = [input.mergeBase, input.tip, input.head].map(instructionsVersion);
  if (was === undefined || tip === undefined || now === undefined)
    return [`${INSTRUCTIONS} must start with \`instructions-version: N\`.`];
  const changed = instructionsBody(input.head) !== instructionsBody(input.mergeBase);
  const most = tip + 1 + (input.mergedPrs ?? 0);
  if (changed && most > tip + 1 && (now <= tip || now > most))
    return [
      `The agent instructions changed over ${input.mergedPrs} merged PRs, so their version is ${tip + 1} to ${most}, not ${now}.`,
    ];
  if (changed && most === tip + 1 && now !== tip + 1)
    return [
      `The agent instructions changed, so their version is ${tip + 1} (one above the base's ${tip}), not ${now}.${tip !== was ? " Merge the base first: it moved." : ""}`,
    ];
  if (!changed && now !== was)
    return [`The agent instructions text is unchanged, so keep version ${was}, not ${now}.`];
  return [];
};

/** Distinct added lines long enough to be someone's work, per file, from a `-U0` diff. */
export const addedLines = (diff: string, min = MIN_LINE) => {
  const files = new Map<string, Set<string>>();
  let current: Set<string> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current = path === "/dev/null" ? undefined : new Set();
      if (current !== undefined) files.set(path, current);
    } else if (current !== undefined && line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1).trim();
      if (text.length >= min) current.add(text);
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

export const KIN_COPY_DIRS = {
  web: "apps/web/src/kin",
  phone: "apps/mobile/src/features",
} as const;
const MIN_WORDS = 4;
const HOLE = /\$\{(?:[^{}`]|`[^`]*`|\{[^{}]*\})*\}/;
const TEMPLATE = /`((?:[^`\\$]|\\.|\$(?!\{)|\$\{(?:[^{}`]|`[^`]*`|\{[^{}]*\})*\})*)`/g;

/**
 * The sentences a source file shows people: string literals and JSX text, split at sentence ends,
 * kept when they start with a capital and have four or more words.
 */
export const kinSentences = (source: string) => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const texts = [
    ...[...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)].map(
      (match) => match[1] ?? match[2] ?? "",
    ),
    // Template literals (one level of nesting) and JSX text, cut at each `${…}` or `{…}` hole.
    ...[...code.matchAll(TEMPLATE)].flatMap((match) => match[1]!.split(HOLE)),
    ...[...code.matchAll(/>([^<>{}]+)(?=[<{])|\}([^<>{}]+)(?=<)/g)]
      .map((match) => match[1] ?? match[2] ?? "")
      // Code between a `>` or `}` and a `<` (a comparison, a generic) is not JSX text.
      .filter((text) => !text.includes("=")),
  ];
  return texts
    .flatMap((text) =>
      text
        .replace(/\\n/g, " ")
        .replace(/\\(["'])/g, "$1")
        .split(/(?<=[.!?…])\s+/),
    )
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(
      (text) =>
        /^[A-Z]/.test(text) &&
        text.split(" ").filter((word) => /[A-Za-z]/.test(word)).length >= MIN_WORDS,
    );
};

/** A sentence typed into both Kin clients belongs in client-runtime, which both render. */
export const checkSharedCopy = (
  web: ReadonlyMap<string, string>,
  phone: ReadonlyMap<string, string>,
) => {
  const where = (files: ReadonlyMap<string, string>) => {
    const found = new Map<string, string>();
    for (const [file, source] of files)
      for (const sentence of kinSentences(source))
        if (!found.has(sentence)) found.set(sentence, file);
    return found;
  };
  const onPhone = where(phone);
  return [...where(web)]
    .filter(([sentence]) => onPhone.has(sentence))
    .map(
      ([sentence, file]) =>
        `kin copy: "${sentence}" is typed into ${file} and ${onPhone.get(sentence)}; move it into a client-runtime/src/kin presentation module and render it from both.`,
    );
};

const PEOPLE_READ = [
  "apps/web/src/kin/",
  "apps/web/src/components/sidebar/",
  "apps/mobile/src/",
  "packages/client-runtime/src/kin/",
  "apps/server/src/kin/",
  "branding/",
];
const TEST_FILE = /(?:\.test\.|\/test\/|\/__tests__\/)/;

/** A file whose result a person or an agent reads: its change says what they will notice. */
export const readByPeople = (file: string) =>
  !TEST_FILE.test(file) &&
  !file.startsWith("apps/server/src/kin/persistence/migrations/") &&
  (PEOPLE_READ.some((dir) => file.startsWith(dir)) ||
    /^evals\/mcp-tool-use\/cases\/kin[^/]*\.ndjson$/.test(file));

export const APPROVED_GUARDS = "scripts/kin-approved-guards.json";
/** Something the owner approved; see `checkPeopleChange`. */
const ApprovedGuard = Schema.Struct({
  name: Schema.String,
  approved: Schema.String,
  /** Any change to these files. */
  files: Schema.optional(Schema.Array(Schema.String)),
  /** An added line containing this text, in a file under `under` (or anywhere). */
  added: Schema.optional(Schema.String),
  under: Schema.optional(Schema.Array(Schema.String)),
  /** Any change to these top-level declarations, by file. */
  declarations: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});
export type ApprovedGuard = typeof ApprovedGuard.Type;
export const ApprovedGuards = Schema.fromJsonString(Schema.Array(ApprovedGuard));
const decodeGuards = Schema.decodeEffect(ApprovedGuards);

/** `export const|function <name>` up to the next line that starts a new top-level statement. */
export const declarationOf = (source: string | undefined, name: string) => {
  const lines = (source ?? "").split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^export (?:const|function) ${name}\\b`).test(line),
  );
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^[^\s})\]]/.test(line));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trimEnd();
};

export type BranchCommit = {
  readonly sha: string;
  readonly message: string;
  readonly files: ReadonlyArray<string>;
};

/**
 * A branch that changes what a person or an agent reads says so in a `People-change:` line; one
 * that changes something the owner approved says `People-change: approved-item <name>: …`.
 * `added` is the branch's added lines per changed file; `before`/`after` read a file at its ends.
 */
export const checkPeopleChange = (input: {
  readonly commits: ReadonlyArray<BranchCommit>;
  readonly guards: ReadonlyArray<ApprovedGuard>;
  readonly added: ReadonlyMap<string, ReadonlySet<string>>;
  readonly before: (file: string) => string | undefined;
  readonly after: (file: string) => string | undefined;
}) => {
  const said = input.commits.flatMap((commit) =>
    [...commit.message.matchAll(/^People-change:[ \t]*(\S.*)$/gm)].map((match) => ({
      sha: commit.sha,
      text: match[1]!.trim(),
    })),
  );
  const changed = [...new Set(input.commits.flatMap((commit) => commit.files))].filter(
    (file) => !TEST_FILE.test(file),
  );
  const problems: Array<string> = [];
  const read = changed.filter(readByPeople);
  if (read.length > 0 && said.length === 0)
    problems.push(
      `People-change: this branch changes what a person or an agent reads (${read[0]}${read.length > 1 ? ` and ${read.length - 1} more` : ""}), and no commit says what they will notice.\n` +
        "Add a line to the last commit message: `People-change: <what a person already had that now looks, reads or works differently, or is gone>`, or `People-change: none`.",
    );
  const approvedItems = new Set(
    said.flatMap(({ text }) => /^approved-item\s+(\S+?):\s*\S/.exec(text)?.[1] ?? []),
  );
  for (const guard of input.guards) {
    if (approvedItems.has(guard.name)) continue;
    const touched = [
      ...changed.filter((file) => guard.files?.includes(file)),
      ...changed.filter((file) => {
        const text = guard.added;
        if (text === undefined) return false;
        if (guard.under !== undefined && !guard.under.some((dir) => file.startsWith(dir)))
          return false;
        return [...(input.added.get(file) ?? [])].some((line) => line.includes(text));
      }),
      ...Object.entries(guard.declarations ?? {}).flatMap(([file, names]) =>
        changed.includes(file)
          ? names
              .filter(
                (name) =>
                  declarationOf(input.before(file), name) !==
                  declarationOf(input.after(file), name),
              )
              .map((name) => `${name} in ${file}`)
          : [],
      ),
    ];
    if (touched.length > 0)
      problems.push(
        `People-change: this branch changes ${[...new Set(touched)].join(", ")}, which the owner approved as it is: ${guard.approved}\n` +
          `Change it only with his yes on the before and after, then add to the last commit message: \`People-change: approved-item ${guard.name}: <what changes>\`.`,
      );
  }
  const notes =
    said.length === 0 ? [] : ["People-change:", ...said.map(({ sha, text }) => `  ${sha} ${text}`)];
  return { problems, notes };
};

/** The branch's own commits since `from`, merges left out: a merge says nothing of its own. */
export const branchCommits = Effect.fn("kinBranchChecks.commits")(function* (
  root: string,
  from: string,
) {
  const log = (yield* git(root, [
    "log",
    "--no-merges",
    "--no-renames",
    "--name-only",
    "--format=%x1e%h%x1f%B%x1f",
    `${from}..HEAD`,
  ])).toString();
  return log
    .split("\x1e")
    .slice(1)
    .map((record) => {
      const [sha = "", message = "", files = ""] = record.split("\x1f");
      return { sha, message, files: files.split("\n").filter((file) => file !== "") };
    });
});

/** All checks for the branch at `root` against `ref`: problems, or none, and notes to print. */
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
  // PRs already merged between the ref and head, newest first: a release range, not one branch.
  const prMerges = (yield* gitLines(root, [
    "log",
    "--first-parent",
    "--merges",
    "--format=%H %s",
    `${mergeBase}..HEAD`,
  ]))
    .filter((line) => /^\S+ Merge pull request #\d+/.test(line))
    .map((line) => line.split(" ")[0]!);
  const mergedPrs = prMerges.length;
  // Each merged PR passed survival against its own base; only work on top of the last one is new.
  const survivalRef = prMerges[0] ?? ref;
  const survivalBase = prMerges[0] ?? mergeBase;
  const changed = (yield* gitLines(root, [
    "diff",
    "--name-only",
    "--no-renames",
    survivalBase,
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
    problems.push(
      ...checkInstructions({ mergeBase: was.value, tip: tip.value, head: now.value, mergedPrs }),
    );

  const copyFiles = Effect.fn("kinBranchChecks.copyFiles")(function* (dir: string) {
    const files = new Map<string, string>();
    for (const file of yield* gitLines(root, ["ls-files", "--", dir])) {
      if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
      const text = yield* onDisk(file);
      if (Option.isSome(text)) files.set(file, text.value);
    }
    return files;
  });
  problems.push(
    ...checkSharedCopy(yield* copyFiles(KIN_COPY_DIRS.web), yield* copyFiles(KIN_COPY_DIRS.phone)),
  );

  // The iOS build brands a copy and fails on any upstream identity left; catch that here.
  if (yield* fs.exists(path.join(root, "branding/rules.yaml"))) {
    // Loaded here: checkouts without Kin's branding don't carry kin-brand.ts and its engine.
    const { kinBrand } = yield* Effect.promise(() => import("./kin-brand.ts"));
    const branding = yield* kinBrand({
      repoRoot: root,
      scan: true,
      target: Option.none(),
      rules: Option.none(),
      check: false,
      updateDriftBaseline: false,
    }).pipe(
      Effect.as(undefined),
      Effect.catchTags({ KinBrandError: (error) => Effect.succeed(error.message) }),
    );
    if (branding !== undefined)
      problems.push(`Kin branding (node scripts/kin-brand.ts --scan): ${branding}`);
  }

  const guardsText = yield* onDisk(APPROVED_GUARDS);
  const guards = Option.isNone(guardsText)
    ? []
    : yield* decodeGuards(guardsText.value).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            problems.push(`${APPROVED_GUARDS}: ${error.message}`);
            return [];
          }),
        ),
      );
  const commits = yield* branchCommits(root, mergeBase);
  const declared = new Set(guards.flatMap((guard) => Object.keys(guard.declarations ?? {})));
  const before = new Map<string, string | undefined>();
  const after = new Map<string, string | undefined>();
  for (const file of declared) {
    before.set(file, Option.getOrUndefined(yield* show(mergeBase, file)));
    after.set(file, Option.getOrUndefined(yield* show("HEAD", file)));
  }
  const people = checkPeopleChange({
    commits,
    guards,
    added: addedLines(
      (yield* git(root, ["diff", "-U0", "--no-renames", mergeBase, "HEAD"])).toString(),
      1,
    ),
    before: (file) => before.get(file),
    after: (file) => after.get(file),
  });
  problems.push(...people.problems);

  if (changed.length > 0) {
    const merges = yield* gitLines(root, [
      "log",
      "--first-parent",
      "--merges",
      `--since=${days}.days.ago`,
      "--format=%H %s",
      survivalRef,
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
      tipText.set(file, Option.getOrUndefined(yield* show(survivalRef, file)));
      headText.set(file, Option.getOrUndefined(yield* onDisk(file)));
    }
    const messages = (yield* git(root, ["log", "--format=%B", `${survivalBase}..HEAD`])).toString();
    problems.push(
      ...checkSurvival({
        merged,
        tip: (file) => tipText.get(file),
        head: (file) => headText.get(file),
        superseded: supersededIn(messages),
      }),
    );
  }
  return { problems, notes: people.notes };
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
      const { problems, notes } = yield* kinBranchChecks(root, input.ref, input.days);
      for (const note of notes) yield* Console.log(note);
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
).pipe(
  Command.withDescription(
    "Kin's merge-survival, migration, instructions, shared-copy, branding and People-change checks.",
  ),
);

if (import.meta.main) {
  Command.run(kinBranchChecksCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
