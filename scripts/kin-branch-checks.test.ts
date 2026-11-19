// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  addedLines,
  APPROVED_GUARDS,
  ApprovedGuards,
  branchCommits,
  checkInstructions,
  checkPeopleChange,
  checkProductName,
  checkSharedCopy,
  checkMigrations,
  checkSurvival,
  declarationOf,
  type ApprovedGuard,
  type BranchCommit,
  kinSentences,
  migrationIds,
  supersededIn,
} from "./kin-branch-checks.ts";

const decodeGuards = Schema.decodeSync(ApprovedGuards);
const loader = (...ids: ReadonlyArray<string>) =>
  ids.map((id) => `  "${id}": ${id.split("_")[1]},`).join("\n");
const instructions = (version: number, body: string) =>
  `export const instructions = \`instructions-version: ${version}\n${body}\`;\n`;
const line = (n: number) => `const invented${n} = makeSomethingLongEnough(${n}, "value");`;

describe("kin branch checks", () => {
  it("numbers new migrations after the base's highest, with no gap and no repeat", () => {
    const base = migrationIds(loader("87_TeamWork", "88_MoneyRecords"));
    assert.deepStrictEqual(
      checkMigrations(base, migrationIds(loader("87_TeamWork", "88_MoneyRecords", "89_Next"))),
      [],
    );
    // 106 taken while the base was at 88: hosts that run 106 first would skip 89 to 105.
    assert.include(
      checkMigrations(
        base,
        migrationIds(loader("87_TeamWork", "88_MoneyRecords", "106_ChatThreads")),
      )[0],
      "must be 89",
    );
    assert.include(
      checkMigrations(base, migrationIds(loader("87_TeamWork", "88_MoneyRecords", "88_Other")))[0],
      "used twice",
    );
  });

  it("moves the instructions version exactly when their text changes", () => {
    const was = instructions(43, "Old.");
    assert.deepStrictEqual(
      checkInstructions({ mergeBase: was, tip: was, head: instructions(44, "New.") }),
      [],
    );
    assert.deepStrictEqual(checkInstructions({ mergeBase: was, tip: was, head: was }), []);
    // The text changed on 43 after another branch had already taken 43.
    assert.include(
      checkInstructions({
        mergeBase: instructions(42, "Old."),
        tip: was,
        head: instructions(43, "New."),
      })[0],
      "44",
    );
    assert.include(
      checkInstructions({ mergeBase: was, tip: was, head: instructions(44, "Old.") })[0],
      "unchanged",
    );
    // A release range holds merged PRs, each of which went up by one: up to one more per PR.
    const release = { mergeBase: was, tip: was, mergedPrs: 3 };
    assert.deepStrictEqual(checkInstructions({ ...release, head: instructions(46, "New.") }), []);
    assert.include(
      checkInstructions({ ...release, head: instructions(48, "New.") })[0],
      "44 to 47",
    );
    assert.include(
      checkInstructions({ ...release, head: instructions(43, "New.") })[0],
      "44 to 47",
    );
  });

  it("refuses a branch that drops most of a merged PR's lines unless it says it supersedes it", () => {
    const added = Array.from({ length: 12 }, (_, n) => line(n));
    const diff = ["+++ b/app/one.ts", ...added.map((text) => `+${text}`), "+short"].join("\n");
    const files = addedLines(diff);
    assert.strictEqual(files.get("app/one.ts")?.size, 12);
    const merged = [{ pr: 330, files }];
    const tip = () => added.join("\n");
    // A merge that dropped the files a PR had just added.
    const reverted = checkSurvival({ merged, tip, head: () => undefined, superseded: new Set() });
    assert.include(reverted[0], "removes 12 of the 12 lines #330 added");
    const said = checkSurvival({
      merged,
      tip,
      head: () => undefined,
      superseded: supersededIn("Supersedes: #330"),
    });
    assert.deepStrictEqual(said, []);
    // A rename edits lines in place; that keeps the work.
    const renamed = added.map((text) => text.replace("value", "values"));
    assert.deepStrictEqual(
      checkSurvival({ merged, tip, head: () => renamed.join("\n"), superseded: new Set() }),
      [],
    );
  });

  it("refuses a sentence of four or more words typed into both Kin clients", () => {
    const web = `
      // Comments are not copy: Couldn't load the rates.
      export const Rates = (props: { host: string }) => (
        <p className="text-xs text-muted-foreground flex-1 min-w-0">
          Couldn't load the rates. This visual asks to load from <b>{props.host}</b>.
        </p>
      );
      const done = "Saved.";
      const label = \`Open the chat with \${props.host}\`;
    `;
    const phone = `
      const title = "Couldn't load the rates";
      const fragment = \`\${host}\${unicode === null ? "" : \`(shown as \${unicode})\`}\\n\\nThis visual asks to load from it.\`;
      const done = "Saved.";
      const label = \`Open the chat with \${title}\`;
    `;
    assert.deepStrictEqual(kinSentences(web).toSorted(), [
      "Couldn't load the rates.",
      "Open the chat with",
      "This visual asks to load from",
    ]);
    const said = checkSharedCopy(new Map([["web.tsx", web]]), new Map([["phone.tsx", phone]]));
    // The same words with different punctuation, and short words, are left alone.
    assert.deepStrictEqual(
      said.map((problem) => problem.split('"')[1]),
      ["Open the chat with"],
    );
  });

  it("asks a branch people will notice to say what changes for them, and prints what it says", () => {
    const check = (...commits: ReadonlyArray<BranchCommit>) =>
      checkPeopleChange({
        commits,
        guards: [],
        added: new Map(),
        before: () => undefined,
        after: () => undefined,
      });
    const screen = {
      sha: "a1",
      message: "fix(kin): the brief",
      files: ["apps/web/src/kin/Brief.tsx"],
    };
    const silent = check(screen);
    assert.include(silent.problems[0], "apps/web/src/kin/Brief.tsx");
    assert.include(silent.problems[0], "`People-change: none`");
    assert.deepStrictEqual(silent.notes, []);
    // Tests, docs, migrations and non-Kin eval cases are read by nobody.
    for (const file of [
      "apps/web/src/kin/Brief.browser.test.tsx",
      "apps/server/src/kin/work/money.test.ts",
      "docs/kin/RULES.md",
      "apps/server/src/kin/persistence/migrations/150_Next.ts",
      "evals/mcp-tool-use/cases/themes.ndjson",
    ])
      assert.deepStrictEqual(
        check({ sha: "b2", message: "test: more", files: [file] }).problems,
        [],
      );
    assert.lengthOf(
      check({ sha: "c3", message: "x", files: ["evals/mcp-tool-use/cases/kin-owed.ndjson"] })
        .problems,
      1,
    );
    // Any one commit may carry the line; every line is printed for whoever merges.
    const said = check(
      { sha: "d4", message: "fix(kin): one\n\nPeople-change: none", files: [] },
      screen,
      {
        sha: "e5",
        message: "fix(kin): two\n\nPeople-change: the brief's Money title reads Cash",
        files: [],
      },
    );
    assert.deepStrictEqual(said.problems, []);
    assert.deepStrictEqual(said.notes, [
      "People-change:",
      "  d4 none",
      "  e5 the brief's Money title reads Cash",
    ]);
    // The word alone is not a line.
    assert.lengthOf(check({ ...screen, message: "fix: x\n\nPeople-change:" }).problems, 1);
  });

  it("refuses a change to what the owner approved unless the line names it as approved", () => {
    const guards: ReadonlyArray<ApprovedGuard> = [
      { name: "pictures", approved: "Pebbles.", files: ["apps/web/src/kin/KinAvatar.tsx"] },
      { name: "name", approved: "Kin.", added: "T3 Kin", under: ["apps/web/src/kin/"] },
      {
        name: "brief-form",
        approved: "The brief.",
        declarations: { "packages/contracts/src/kinPage.ts": ["kinIsBrief"] },
      },
    ];
    const page = (rule: string) =>
      `export const kinIsBrief = (body: string) =>\n  ${rule};\n\nexport const kinOther = 1;\n`;
    const check = (input: {
      readonly files: ReadonlyArray<string>;
      readonly message?: string;
      readonly added?: ReadonlyArray<readonly [string, string]>;
      readonly after?: string;
    }) =>
      checkPeopleChange({
        commits: [
          {
            sha: "a1",
            message: input.message ?? "fix(kin): x\n\nPeople-change: none",
            files: input.files,
          },
        ],
        guards,
        added: new Map((input.added ?? []).map(([file, line]) => [file, new Set([line])])),
        before: () => page("body !== ''"),
        after: () => input.after ?? page("body !== ''"),
      }).problems;
    assert.include(
      check({ files: ["apps/web/src/kin/KinAvatar.tsx"] })[0],
      "approved-item pictures",
    );
    assert.deepStrictEqual(
      check({
        files: ["apps/web/src/kin/KinAvatar.tsx"],
        message:
          "fix(kin): x\n\nPeople-change: approved-item pictures: pebbles are larger in lists",
      }),
      [],
    );
    // Another item's approval does not cover this one.
    assert.lengthOf(
      check({
        files: ["apps/web/src/kin/KinAvatar.tsx"],
        message: "People-change: approved-item name: x",
      }),
      1,
    );
    const titled = ["apps/web/src/kin/Title.tsx", 'document.title = "T3 Kin";'] as const;
    assert.include(check({ files: [titled[0]], added: [titled] })[0], "approved-item name");
    // Outside the guarded folders, or in a test, the literal is someone's fixture.
    assert.deepStrictEqual(
      check({ files: ["scripts/x.ts"], added: [["scripts/x.ts", titled[1]]] }),
      [],
    );
    const test = "apps/web/src/kin/Title.test.tsx";
    assert.deepStrictEqual(check({ files: [test], added: [[test, titled[1]]] }), []);
    // Only the guarded declaration counts; the rest of its file is free to change.
    const kinPage = "packages/contracts/src/kinPage.ts";
    assert.include(
      check({ files: [kinPage], after: page("body.length > 0") })[0],
      "kinIsBrief in packages/contracts/src/kinPage.ts",
    );
    assert.deepStrictEqual(
      check({
        files: [kinPage],
        after: page("body !== ''").replace("kinOther = 1", "kinOther = 2"),
      }),
      [],
    );
  });

  it("guards files and declarations that are in the tree", () => {
    const root = NodePath.join(import.meta.dirname, "..");
    const guards = decodeGuards(NodeFS.readFileSync(NodePath.join(root, APPROVED_GUARDS), "utf8"));
    assert.deepStrictEqual(
      guards.map(({ name }) => name),
      ["pictures", "name", "brief-form"],
    );
    for (const guard of guards) {
      for (const file of guard.files ?? [])
        assert.isTrue(NodeFS.existsSync(NodePath.join(root, file)), file);
      for (const [file, names] of Object.entries(guard.declarations ?? {}))
        for (const name of names)
          assert.isDefined(
            declarationOf(NodeFS.readFileSync(NodePath.join(root, file), "utf8"), name),
            `${name} in ${file}`,
          );
    }
  });

  it.effect("reads the branch's own commits and leaves merges out", () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-kin-branch-")),
    );
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
      ),
      GIT_CONFIG_GLOBAL: NodeOS.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: Array<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=Rhea", "-c", "user.email=rhea@ambermill.invalid", ...args],
        { cwd: root, encoding: "utf8", env },
      ).trim();
    const commit = (file: string, message: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, file), message);
      git("add", ".");
      git("commit", "-q", "-m", message);
    };
    return Effect.gen(function* () {
      git("init", "-q", "-b", "kin");
      commit("README.md", "base");
      const base = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "side");
      commit("apps/web/src/kin/Side.tsx", "side work");
      git("checkout", "-q", "kin");
      git("checkout", "-q", "-b", "mine");
      commit("apps/web/src/kin/Brief.tsx", "fix(kin): brief\n\nPeople-change: none");
      git("merge", "-q", "--no-ff", "-m", "Merge side\n\nPeople-change: from a merge", "side");
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const commits = yield* branchCommits(root, base).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setEnv(command, env))),
        ),
      );
      assert.deepStrictEqual(
        commits.map(({ message, files }) => [message.trim(), files]),
        [
          ["fix(kin): brief\n\nPeople-change: none", ["apps/web/src/kin/Brief.tsx"]],
          ["side work", ["apps/web/src/kin/Side.tsx"]],
        ],
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    );
  });

  it("refuses a Kin file that calls the product T3 Kin, but not in a comment or fixture", () => {
    const problems = checkProductName(
      new Map([
        [
          "kin/Welcome.tsx",
          'const title = "Welcome to Kin";\nconst body = "Open T3 Kin to start.";',
        ],
        ["kin/Host.ts", 'const note = "Runs on a T3 server, as T3 Kinds do.";'],
        [
          "kin/Label.tsx",
          '// Do not call this T3 Kin.\n/* Nor T3 Kin\n   here. */ const url = "https://kin.invalid"; // T3 Kin\nconst label = <b>T3 Kin</b>;',
        ],
        ["kin/fixtures/names.ts", 'export const old = "T3 Kin";'],
        ["kin/Names.spec.ts", 'const old = "T3 Kin";'],
      ]),
    );
    assert.deepStrictEqual(problems, [
      'kin name: kin/Welcome.tsx:2 says "T3 Kin"; the product is called Kin.',
      'kin name: kin/Label.tsx:4 says "T3 Kin"; the product is called Kin.',
    ]);
  });
});
