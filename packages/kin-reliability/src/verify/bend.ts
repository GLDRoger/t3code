// @effect-diagnostics nodeBuiltinImport:off - Bend is an external binary; detection and install shell out.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { bendVersionFile } from "../paths.ts";

export interface BendInvocation {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly elapsedMs: number;
  readonly error: string | null;
}

export function runBend(bin: string, args: readonly string[], cwd: string): BendInvocation {
  const started = process.hrtime.bigint();
  const result = NodeChildProcess.spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, BEND_NO_TELEMETRY: "1" },
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    error: result.error === undefined ? null : String(result.error),
  };
}

export function runBendAsync(
  bin: string,
  args: readonly string[],
  cwd: string,
): Promise<BendInvocation> {
  const started = process.hrtime.bigint();
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(bin, args, {
      cwd,
      env: { ...process.env, BEND_NO_TELEMETRY: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({
        exitCode: null,
        stdout,
        stderr,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        error: String(error),
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout,
        stderr,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        error: null,
      });
    });
  });
}

export function findBend(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.BEND_BIN !== undefined && env.BEND_BIN.length > 0) candidates.push(env.BEND_BIN);
  candidates.push(NodePath.join(NodeOS.homedir(), ".bend", "bin", "bend"));
  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(NodePath.delimiter)) {
    if (dir.length > 0) candidates.push(NodePath.join(dir, "bend"));
  }
  for (const candidate of candidates) {
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

export function readBendVersion(bin: string): string | null {
  const result = runBend(bin, ["version"], process.cwd());
  const match = /(\d+\.\d+\.\d+)/u.exec(`${result.stdout}\n${result.stderr}`);
  return match?.[1] ?? null;
}

export function readPinnedBendVersion(file = bendVersionFile): string {
  return NodeFS.readFileSync(file, "utf8").trim();
}

export function compareSemver(left: string, right: string): number {
  const a = left.split(".").map((part) => Number(part));
  const b = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export const BEND_AGENTS_BLOCK = `When using Bend:
- run \`bend guide\` to learn it
- use \`LAWS.bend\` to keep important rules
- run \`bend PROOF.bend\` before committing
- parallelize the code whenever possible
- never edit \`LAWS.bend\` without asking
`;

export const INSTALL_INSTRUCTIONS = `Bend installs on Linux and macOS (Windows through WSL) and needs clang 14+ for native builds.
curl -fsSL https://bend-lang.com/install.sh -o install-bend.sh
BEND_NO_TELEMETRY=1 sh install-bend.sh
export PATH="$HOME/.bend/bin:$PATH"
bend version
`;

export function installBend(): BendInvocation {
  const started = process.hrtime.bigint();
  const result = NodeChildProcess.spawnSync(
    "sh",
    [
      "-c",
      "curl -fsSL https://bend-lang.com/install.sh -o /tmp/install-bend.sh && BEND_NO_TELEMETRY=1 sh /tmp/install-bend.sh",
    ],
    { encoding: "utf8", env: { ...process.env, BEND_NO_TELEMETRY: "1" } },
  );
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    error: result.error === undefined ? null : String(result.error),
  };
}

export const SKIPPED_BEND = "skipped: bend not installed";
