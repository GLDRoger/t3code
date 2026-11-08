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
