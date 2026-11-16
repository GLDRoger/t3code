// @effect-diagnostics nodeBuiltinImport:off - runs the real shell script in a scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { signed } from "./agentMark.ts";
import { ghSignScript } from "./ghSign.ts";

/** Runs the shim in front of a stand-in gh that prints each argument it got on its own line. */
const run = (args: ReadonlyArray<string>, options: { name?: string; stdin?: string } = {}) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-gh-sign-"));
  try {
    const real = NodePath.join(dir, "real-gh");
    NodeFS.writeFileSync(real, '#!/bin/sh\nfor a do printf "<%s>\\n" "$a"; done\n', {
      mode: 0o755,
    });
    const shim = NodePath.join(dir, "gh");
    NodeFS.writeFileSync(shim, ghSignScript(real), { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(dir, "body.md"), "From a file.\n");
    const result = NodeChildProcess.spawnSync(shim, [...args], {
      cwd: dir,
      input: options.stdin ?? "",
      env: {
        PATH: process.env.PATH,
        ...(options.name === undefined ? {} : { KIN_AGENT_NAME: options.name }),
      },
      encoding: "utf8",
    });
    return [...result.stdout.matchAll(/<([\s\S]*?)>\n/g)].map((match) => match[1]);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("the gh a Kin agent's shell runs", () => {
  it("ends every body an agent posts with its signature and marker, exactly as Kin writes them", () => {
    const name = "Tech lead";
    expect(run(["pr", "create", "--title", "Add hello", "--body", "Closes #1"], { name })).toEqual([
      "pr",
      "create",
      "--title",
      "Add hello",
      "--body",
      signed("Closes #1", name),
    ]);
    expect(run(["issue", "comment", "3", "-b", "On it."], { name }).at(-1)).toBe(
      signed("On it.", name),
    );
    expect(run(["pr", "review", "2", "--comment", "--body=Looks right."], { name }).at(-1)).toBe(
      `--body=${signed("Looks right.", name)}`,
    );
    expect(run(["pr", "comment", "2", "--body-file", "body.md"], { name }).slice(-2)).toEqual([
      "--body",
      signed("From a file.", name),
    ]);
    expect(run(["pr", "comment", "2", "-F", "-"], { name, stdin: "From stdin." }).at(-1)).toBe(
      signed("From stdin.", name),
    );
    expect(
      run(["api", "repos/a/b/issues/3/comments", "-f", "body=Via the API."], { name }).at(-1),
    ).toBe(`body=${signed("Via the API.", name)}`);
    // No body given: an issue still ends with the signature, and an approval carries one.
    expect(run(["issue", "create", "--title", "Flaky test"], { name }).slice(-2)).toEqual([
      "--body",
      signed("", name),
    ]);
    expect(run(["pr", "review", "2", "--approve"], { name }).slice(-2)).toEqual([
      "--body",
      signed("", name),
    ]);
  });

  it("signs once, and leaves everything else, and every other shell, alone", () => {
    const name = "Tech lead";
    const already = signed("Done.", name);
    expect(run(["pr", "comment", "2", "--body", already], { name }).at(-1)).toBe(already);
    expect(run(["pr", "view", "2", "--json", "body"], { name })).toEqual([
      "pr",
      "view",
      "2",
      "--json",
      "body",
    ]);
    expect(run(["api", "repos/a/b/pulls/2", "-f", "title=Rename"], { name }).at(-1)).toBe(
      "title=Rename",
    );
    expect(run(["pr", "create", "--body", "Plain"])).toEqual(["pr", "create", "--body", "Plain"]);
  });
});
