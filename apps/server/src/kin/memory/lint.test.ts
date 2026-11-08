import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { fixtureItem } from "./__fixtures__/items.ts";
import { lintMemoryFiles } from "./lint.ts";
import { readMemoryDirectory } from "./lintCli.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const tree = (files: Record<string, string | Uint8Array>) =>
  Object.entries(files).map(([path, content]) => ({
    path,
    content: typeof content === "string" ? encode(content) : content,
  }));
const rules = { "rules.md": "Invented rules\n" };
const planted = "Invented-private-detail";

it.effect.each([
  { name: "a good item", files: { ...rules, "deferrals/def-001.md": fixtureItem() }, failures: [] },
  {
    name: "files the server does not load",
    files: { ...rules, "journal/2026-11-01.md": "no front matter", "decisions/notes.txt": "x" },
    failures: [],
  },
  {
    name: "a missing rules.md",
    files: { "deferrals/def-001.md": fixtureItem() },
    failures: ["rules.md:1 Missing rules.md"],
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
    files: { "rules.md": new Uint8Array([0xff, 0xfe]) },
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
    const lines = result.map((f) => `${f.path}:${f.line} ${f.reason}`);
    expect(lines).toEqual(failures);
    expect(lines.join("\n")).not.toContain(planted);
  }),
);

it.layer(NodeServices.layer)((it) =>
  it.effect("reads item folders and root files without following symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${outside}/secret.md`, fixtureItem());
      yield* fs.makeDirectory(`${root}/deferrals/nested`, { recursive: true });
      yield* fs.makeDirectory(`${root}/journal`);
      yield* fs.writeFileString(`${root}/rules.md`, "Invented rules\n");
      yield* fs.writeFileString(`${root}/deferrals/nested/def-001.md`, fixtureItem());
      yield* fs.writeFileString(`${root}/journal/2026-11-01.md`, "journal\n");
      yield* fs.symlink(`${outside}/secret.md`, `${root}/deferrals/link.md`);
      yield* fs.symlink(outside, `${root}/people`);
      const files = yield* readMemoryDirectory(root);
      expect(files.map((file) => file.path).sort()).toEqual([
        "deferrals/nested/def-001.md",
        "rules.md",
      ]);
    }).pipe(Effect.scoped),
  ),
);
