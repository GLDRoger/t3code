import { expect, it } from "@effect/vitest";
import { mergeMemoryFiles, uniqueMergeBase } from "./merge.ts";

it.each(["append", "rewrite", "disjoint", "remote rewrite", "rewrite disjoint"])(
  "merges verified snapshots: %s",
  (scenario) => {
    const base = new Map([["journal/day.md", Buffer.from("original\n")]]);
    const local = new Map(base);
    const remote = new Map(base);
    local.set(
      "journal/day.md",
      Buffer.from(scenario.startsWith("rewrite") ? "rewritten\n" : "original\nlocal\n"),
    );
    if (!scenario.includes("disjoint"))
      remote.set(
        "journal/day.md",
        Buffer.from(scenario === "remote rewrite" ? "rewritten remotely\n" : "original\nremote\n"),
      );
    const metadata = (files: Map<string, Buffer>) =>
      new Map([...files].map(([file, bytes]) => [file, { mode: "100644", sha: bytes.toString() }]));
    const result = mergeMemoryFiles(
      base,
      local,
      remote,
      metadata(base),
      metadata(local),
      metadata(remote),
    );
    if (scenario.startsWith("rewrite") || scenario === "remote rewrite")
      expect(result).toBeUndefined();
    else
      expect(result?.files.get("journal/day.md")?.toString()).toBe(
        scenario === "disjoint" ? "original\nlocal\n" : "original\nremote\nlocal\n",
      );
  },
);

// A squash-merged batch comes back with this server's own changes on the remote side.
it.each([
  ["same item", "claims/a.md", "edited\n", "edited\n", "edited\n"],
  [
    "landed journal",
    "journal/day.md",
    "original\nlanded\n",
    "original\nlanded\n",
    "original\nlanded\n",
  ],
  [
    "journal grew since",
    "journal/day.md",
    "original\nlanded\nlater\n",
    "original\nlanded\n",
    "original\nlanded\nlater\n",
  ],
  [
    "remote grew since",
    "journal/day.md",
    "original\nlanded\n",
    "original\nlanded\nowner\n",
    "original\nlanded\nowner\n",
  ],
  // The landed entry is in both copies, and each side then added one of its own.
  [
    "both grew since",
    "journal/day.md",
    "original\n\n## 10:00 landed\n\n## 10:05 later\n",
    "original\n\n## 10:00 landed\n\n## 10:07 owner\n",
    "original\n\n## 10:00 landed\n\n## 10:07 owner\n\n## 10:05 later\n",
  ],
  ["same journal rewrite", "journal/day.md", "rewritten\n", "rewritten\n", "rewritten\n"],
])("merges back a landed batch: %s", (_name, path, ours, theirs, expected) => {
  const base = new Map([
    [path, Buffer.from(path.startsWith("journal/") ? "original\n" : "before\n")],
  ]);
  const local = new Map([[path, Buffer.from(ours)]]);
  const remote = new Map([[path, Buffer.from(theirs)]]);
  const metadata = (files: Map<string, Buffer>) =>
    new Map([...files].map(([file, bytes]) => [file, { mode: "100644", sha: bytes.toString() }]));
  const result = mergeMemoryFiles(
    base,
    local,
    remote,
    metadata(base),
    metadata(local),
    metadata(remote),
  );
  expect(result?.files.get(path)?.toString()).toBe(expected);
});

it("fails closed for unrelated histories and criss-cross merge bases", () => {
  expect(uniqueMergeBase(new Map([["a", []]]), new Map([["b", []]]))).toBeUndefined();
  const common = [
    ["a", ["root"]],
    ["b", ["root"]],
    ["root", []],
  ] as const;
  expect(
    uniqueMergeBase(
      new Map<string, ReadonlyArray<string>>([...common, ["local", ["a", "b"]]]),
      new Map<string, ReadonlyArray<string>>([...common, ["remote", ["b", "a"]]]),
    ),
  ).toBeUndefined();
  expect(
    uniqueMergeBase(
      new Map([
        ["a", []],
        ["b", ["a"]],
      ]),
      new Map([["a", []]]),
    ),
  ).toBe("a");
});
