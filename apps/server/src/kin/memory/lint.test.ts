// @effect-diagnostics-next-line nodeBuiltinImport:off -- Builds a synthetic git index for the reader.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { fixtureItem } from "./__fixtures__/items.ts";
import { formatLintFailure, lintMemoryFiles } from "./lint.ts";
import { readMemoryDirectory } from "./lintCli.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const symlink = { mode: "120000" };
const gitlink = { mode: "160000" };
const tree = (files: Record<string, string | Uint8Array | { mode: string }>) =>
  Object.entries(files).map(([path, content]) =>
    typeof content === "string"
      ? { path, mode: "100644", content: encode(content) }
      : content instanceof Uint8Array
        ? { path, mode: "100644", content }
        : { path, ...content },
  );
const owners = [
  "* @invented-owner",
  "/commitments/",
  "/deferrals/",
  "/claims/",
  "/journal/",
  "/INDEX.md",
];
const codeowners = (...lines: ReadonlyArray<string>) => ({
  ".github/CODEOWNERS": `${lines.join("\n")}\n`,
});
const rules = { "rules.md": "Invented rules\n", ...codeowners(...owners) };
const planted = "Invented-private-detail";

it.effect.each([
  { name: "a good item", files: { ...rules, "deferrals/def-001.md": fixtureItem() }, failures: [] },
  {
    name: "files the server does not load",
    files: {
      ...rules,
      "journal/2026/11-01.md": "no front matter",
      "decisions/notes.txt": "x",
      ".claude/settings.json": "{}",
      "decisions/.hidden/notes.txt": "owner reviewed",
    },
    failures: [],
  },
  {
    name: "a good tree",
    files: {
      ...rules,
      "INDEX.md": "Index\n",
      "commitments/com-1.md": fixtureItem({ id: "com-1", kind: "commitment" }),
      "deferrals/def-001.md": fixtureItem(),
      "claims/Claim_2.md": fixtureItem({ id: "claim-2", kind: "claim" }),
      "journal/2026/12-31.md": "journal\n",
      ".github/workflows/memory-check.yml": "name: x\n",
      "people/demo.md": fixtureItem({ id: "demo", kind: "person" }),
    },
    failures: [],
  },
  {
    name: "agent config in Kin's unowned folders",
    files: {
      ...rules,
      "deferrals/CLAUDE.md": fixtureItem({ id: "x1" }),
      "deferrals/AGENTS.md": fixtureItem({ id: "x2" }),
      "deferrals/.claude/skills/y/SKILL.md": "x",
      "journal/CLAUDE.md": "x",
      "journal/.claude/skills/x/SKILL.md": "x",
      "claims/.claude/settings.json": "{}",
      "commitments/.cursor/rules/x.mdc": "x",
      "INDEX.md/CLAUDE.md": "x",
      "commitments/link.md": symlink,
    },
    failures: [
      "claims/.claude/settings.json:1 Hidden paths are not allowed in Kin's unowned folders",
      "commitments/.cursor/rules/x.mdc:1 Hidden paths are not allowed in Kin's unowned folders",
      "commitments/link.md:1 Symlinks are not allowed",
      "deferrals/.claude/skills/y/SKILL.md:1 Hidden paths are not allowed in Kin's unowned folders",
      "deferrals/AGENTS.md:1 Kin's unowned folders only hold item and journal files",
      "deferrals/CLAUDE.md:1 Kin's unowned folders only hold item and journal files",
      "INDEX.md/CLAUDE.md:1 INDEX.md must be a file",
      "journal/.claude/skills/x/SKILL.md:1 Hidden paths are not allowed in Kin's unowned folders",
      "journal/CLAUDE.md:1 Kin's unowned folders only hold item and journal files",
    ],
  },
  {
    name: "other shapes in Kin's unowned folders",
    files: {
      ...rules,
      "deferrals/nested/def-001.md": fixtureItem(),
      "claims/notes.txt": "x",
      "journal/2026-11-01.md": "x",
      "journal/2026/13-01.md": "x",
      "commitments/gemini.md": "x",
      "claims/GROK.md": "x",
      "commitments/skill.md": "x",
      commitments: "x",
    },
    failures: [
      "claims/GROK.md:1 Kin's unowned folders only hold item and journal files",
      "claims/notes.txt:1 Kin's unowned folders only hold item and journal files",
      "commitments:1 Kin's unowned folders only hold item and journal files",
      "commitments/gemini.md:1 Kin's unowned folders only hold item and journal files",
      "commitments/skill.md:1 Kin's unowned folders only hold item and journal files",
      "deferrals/nested/def-001.md:1 Kin's unowned folders only hold item and journal files",
      "journal/2026-11-01.md:1 Kin's unowned folders only hold item and journal files",
      "journal/2026/13-01.md:1 Kin's unowned folders only hold item and journal files",
    ],
  },
  {
    name: "links and submodules anywhere",
    files: {
      ...rules,
      "decisions/link.md": symlink,
      "vendor/sub": gitlink,
      "people/fifo": { mode: "unknown" },
    },
    failures: [
      "decisions/link.md:1 Symlinks are not allowed",
      "people/fifo:1 Not a regular file",
      "vendor/sub:1 Submodules are not allowed",
    ],
  },
  {
    name: "a missing rules.md",
    files: { ...codeowners(...owners), "deferrals/def-001.md": fixtureItem() },
    failures: ["rules.md:1 Missing rules.md"],
  },
  {
    name: "a missing CODEOWNERS",
    files: { "rules.md": "Invented rules\n" },
    failures: [".github/CODEOWNERS:1 Missing .github/CODEOWNERS"],
  },
  {
    name: "CODEOWNERS with comments, co-owners and CRLF",
    files: {
      ...rules,
      ".github/CODEOWNERS": `# owner\r\n* @invented-owner @co-owner # all\r\n${owners.slice(1).join("\r\n")}\r\n`,
    },
    failures: [],
  },
  {
    name: "a CODEOWNERS placeholder",
    files: { ...rules, ...codeowners("* @OWNER", ...owners.slice(1)) },
    failures: [".github/CODEOWNERS:1 CODEOWNERS still names the @OWNER placeholder"],
  },
  {
    name: "a CODEOWNERS without the * line first",
    files: { ...rules, ...codeowners(...owners.slice(1), owners[0]!) },
    failures: [
      ".github/CODEOWNERS:1 CODEOWNERS must start with * and the owner",
      ".github/CODEOWNERS:6 CODEOWNERS may only leave Kin's own paths unowned after the * line",
      ".github/CODEOWNERS:1 CODEOWNERS lacks the /commitments/ line",
    ],
  },
  {
    name: "a CODEOWNERS * line without an owner",
    files: { ...rules, ...codeowners("*", ...owners.slice(1)) },
    failures: [".github/CODEOWNERS:1 CODEOWNERS must start with * and the owner"],
  },
  {
    name: "CODEOWNERS freeing a path the lead would load",
    files: { ...rules, ...codeowners(...owners, "/CLAUDE.md", `/${planted}/ @kin-bot`) },
    failures: [
      ".github/CODEOWNERS:7 CODEOWNERS may only leave Kin's own paths unowned after the * line",
      ".github/CODEOWNERS:8 CODEOWNERS may only leave Kin's own paths unowned after the * line",
    ],
  },
  {
    name: "a CODEOWNERS missing a Kin path",
    files: { ...rules, ...codeowners(...owners.filter((line) => line !== "/journal/")) },
    failures: [".github/CODEOWNERS:1 CODEOWNERS lacks the /journal/ line"],
  },
  {
    name: "an unresolved alias",
    files: { ...rules, "decisions/dec-001.md": "---\nid: *PLANTED_alias\n---\n" },
    failures: ["decisions/dec-001.md:1 Malformed memory item"],
  },
  {
    name: "a control character in a path",
    files: { ...rules, "claims/a\n::error::\u202e.md": "x".repeat(256 * 1024 + 1) },
    failures: [
      "claims/a\\u{a}::error::\\u{202e}.md:1 Kin's unowned folders only hold item and journal files",
    ],
  },
  {
    name: "a missing required key",
    files: { ...rules, "deferrals/def-001.md": fixtureItem().replace(/^said_by: .*\n/m, "") },
    failures: ["deferrals/def-001.md:1 Missing required key said_by"],
  },
  {
    name: "an invalid value",
    files: { ...rules, "deferrals/def-001.md": fixtureItem({ trust: planted }) },
    failures: ["deferrals/def-001.md:16 Invalid value for key trust"],
  },
  {
    name: "an offsetless date-time",
    files: { ...rules, "deferrals/def-001.md": fixtureItem({ due: "2026-11-13T09:00" }) },
    failures: ["deferrals/def-001.md:6 Invalid due; date-times require an explicit offset"],
  },
  {
    name: "malformed YAML",
    files: { ...rules, "decisions/dec-001.md": `---\nid: dec-001\ntitle: [${planted}\n---\n` },
    failures: ["decisions/dec-001.md:3 Malformed YAML"],
  },
  {
    name: "a kind in the wrong folder",
    files: { ...rules, "decisions/def-001.md": fixtureItem() },
    failures: ["decisions/def-001.md:3 Memory kind does not match folder"],
  },
  {
    name: "a duplicate id",
    files: {
      ...rules,
      "deferrals/a.md": fixtureItem(),
      "deferrals/b.md": fixtureItem(),
    },
    failures: ["deferrals/b.md:2 Duplicate id, also in deferrals/a.md"],
  },
  {
    name: "invalid UTF-8 rules",
    files: { ...rules, "rules.md": new Uint8Array([0xff, 0xfe]) },
    failures: ["rules.md:1 Not valid UTF-8"],
  },
  {
    name: "an oversized item",
    files: { ...rules, "claims/c.md": "x".repeat(256 * 1024 + 1) },
    failures: ["claims/c.md:1 Larger than 262144 bytes"],
  },
])("lint reports $name", ({ files, failures }) =>
  Effect.gen(function* () {
    const result = yield* lintMemoryFiles(tree(files));
    const lines = result.map(formatLintFailure);
    expect(lines).toEqual(failures);
    expect(lines.join("\n")).not.toMatch(new RegExp(`${planted}|PLANTED`));
  }),
);

it.layer(NodeServices.layer)((it) => {
  it.effect("the CODEOWNERS template passes only once the owner is filled in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL(".", import.meta.url));
      const template = yield* fs.readFileString(
        path.join(here, "../../../../../ops/kin/memory-repo/CODEOWNERS.template"),
      );
      const lint = (text: string) =>
        lintMemoryFiles(tree({ ...rules, ".github/CODEOWNERS": text })).pipe(
          Effect.map((failures) => failures.map(formatLintFailure)),
        );
      expect(yield* lint(template)).toEqual([
        ".github/CODEOWNERS:5 CODEOWNERS still names the @OWNER placeholder",
      ]);
      expect(yield* lint(template.replace("* @OWNER", "* @invented-owner"))).toEqual([]);
    }),
  );
  it.effect("reads the whole tree with modes and never follows symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${outside}/secret.md`, fixtureItem());
      yield* fs.makeDirectory(`${root}/deferrals/.claude`, { recursive: true });
      yield* fs.makeDirectory(`${root}/INDEX.md`);
      yield* fs.makeDirectory(`${root}/.github/workflows`, { recursive: true });
      yield* fs.writeFileString(`${root}/.github/CODEOWNERS`, "* @invented-owner\n");
      yield* fs.writeFileString(`${root}/.github/workflows/memory-check.yml`, "name: x\n");
      yield* fs.writeFileString(`${root}/rules.md`, "Invented rules\n");
      yield* fs.writeFileString(`${root}/deferrals/.claude/settings.json`, "{}");
      yield* fs.writeFileString(`${root}/INDEX.md/CLAUDE.md`, "x");
      yield* fs.symlink(`${outside}/secret.md`, `${root}/deferrals/link.md`);
      yield* fs.symlink(outside, `${root}/people`);
      const files = yield* readMemoryDirectory(root);
      expect(
        files
          .map(({ path, mode, content }) => [path, mode, content !== undefined])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        [".github/CODEOWNERS", "100644", true],
        [".github/workflows/memory-check.yml", "100644", false],
        ["deferrals/.claude/settings.json", "100644", false],
        ["deferrals/link.md", "120000", false],
        ["INDEX.md/CLAUDE.md", "100644", false],
        ["people", "120000", false],
        ["rules.md", "100644", true],
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("reads git's index in a checkout, so a gitlink or symlink cannot hide", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const git = (...args: ReadonlyArray<string>) =>
        expect(NodeChildProcess.spawnSync("git", ["-C", root, ...args]).status).toBe(0);
      git("init", "-q");
      yield* fs.makeDirectory(`${root}/commitments`);
      yield* fs.writeFileString(`${root}/rules.md`, "Invented rules\n");
      yield* fs.writeFileString(`${root}/commitments/x.md`, "x");
      yield* fs.symlink("../rules.md", `${root}/commitments/link.md`);
      git("add", "rules.md", "commitments");
      git("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},claims/sub`);
      yield* fs.writeFileString(`${root}/untracked.md`, "x");
      const failures = yield* lintMemoryFiles(yield* readMemoryDirectory(root));
      expect(failures.map(formatLintFailure)).toEqual([
        ".github/CODEOWNERS:1 Missing .github/CODEOWNERS",
        "claims/sub:1 Submodules are not allowed",
        "commitments/link.md:1 Symlinks are not allowed",
        "commitments/x.md:1 Missing front matter delimiters",
      ]);
    }).pipe(Effect.scoped),
  );
});
