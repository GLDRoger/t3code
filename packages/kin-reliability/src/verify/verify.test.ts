// @effect-diagnostics nodeBuiltinImport:off - Verify tests commit a temp Bend repo and invoke bend.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { step } from "../lane/machine.ts";
import {
  LANE_MOVES,
  LANE_ROLES,
  LANE_STATES,
  WILL_FLAGS,
  type LaneMove,
  type LaneRole,
  type LaneState,
  type WillFlag,
} from "../lane/states.ts";
import { bendDir, corpusDir } from "../paths.ts";
import { findBend } from "./bend.ts";
import { renderOneSteps, type OneStep } from "./generate.ts";
import { runBend } from "./bend.ts";
import { SKIPPED_BEND } from "./bend.ts";
import { runVerify } from "./run.ts";

function commitBend(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-laws-"));
  NodeFS.cpSync(bendDir, dir, { recursive: true });
  NodeChildProcess.execFileSync("git", ["-c", "init.defaultBranch=kin", "init", "-q"], {
    cwd: dir,
  });
  NodeChildProcess.execFileSync("git", ["add", "."], { cwd: dir });
  NodeChildProcess.execFileSync(
    "git",
    ["-c", "user.email=kin@example.com", "-c", "user.name=Kin", "commit", "-m", "laws"],
    { cwd: dir },
  );
  return dir;
}

describe("kin verify", () => {
  it("degrades without Bend and passes V0 on a clean law commit", async () => {
    const dir = commitBend();
    const report = await runVerify({
      bendDir: dir,
      corpusDir,
      bound: 1,
      bendBin: null,
    });
    expect(report.levels.find((level) => level.level === "V0")?.status).toBe("passed");
    for (const level of ["V1", "V2", "V3", "V4"] as const) {
      const result = report.levels.find((item) => item.level === level);
      expect(result?.status, level).toBe("skipped");
      expect(result?.reason, level).toBe(SKIPPED_BEND);
    }
    expect(report.verdict).toBe("degraded");
    expect(report.exitCode).toBe(2);
    expect(report.healed).toBe(false);
    expect(report.loopholes.summary).toContain("not probed");
    expect(report.laneStates).toEqual([...LANE_STATES]);
    expect(report.timingsMs.total).toBeGreaterThanOrEqual(0);
  });

  it("rejects an uncommitted law edit", async () => {
    const dir = commitBend();
    NodeFS.appendFileSync(NodePath.join(dir, "LAWS.bend"), "\n# weakened\n");
    const report = await runVerify({
      bendDir: dir,
      corpusDir,
      bound: 1,
      bendBin: null,
    });
    expect(report.levels.find((level) => level.level === "V0")?.status).toBe("failed");
    expect(report.gate.lawsApproved).toBe(false);
    expect(report.verdict).toBe("failed");
  });

  it("checks the installed Bend, including issue 776, when the binary is present", async () => {
    const bin = findBend();
    if (bin === null) return;
    const dir = commitBend();
    const report = await runVerify({ bendDir: dir, corpusDir, bound: 1 });
    expect(report.bend.installed).toBe(true);
    expect(report.levels.map((level) => level.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(report.verdict).toBe("passed");
    expect(report.exitCode).toBe(0);
    expect(report.healed).toBe(true);
    expect(report.loopholes.missingImport.closed).toBe(true);
    expect(report.loopholes.unsafeProof.closed).toBe(true);
    expect(report.loopholes.unsafeImport.closed).toBe(true);
    expect(report.levels.find((level) => level.level === "V4")?.sampled).toBe(true);
    expect(report.levels.find((level) => level.level === "V2")?.proves.join(" ")).toContain(
      "Reviewer",
    );
    expect(report.timingsMs.V1).toBeGreaterThan(0);
    expect(report.timingsMs.V4).toBeGreaterThan(0);
    expect(report.timingsMs.v3Wall).toBeGreaterThan(0);

    const grid: OneStep[] = [];
    for (const start of LANE_STATES) {
      for (const move of LANE_MOVES) {
        for (const role of LANE_ROLES) {
          for (const will of WILL_FLAGS) {
            grid.push({
              start: start as LaneState,
              move: move as LaneMove,
              role: role as LaneRole,
              will: will as WillFlag,
              observed: step(start, move, role, will),
            });
          }
        }
      }
    }
    const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-grid-"));
    NodeFS.copyFileSync(NodePath.join(dir, "lane.bend"), NodePath.join(temp, "lane.bend"));
    NodeFS.writeFileSync(NodePath.join(temp, "grid.bend"), renderOneSteps(grid));
    const conformance = runBend(bin, ["grid.bend", "--check-only"], temp);
    expect(conformance.exitCode, conformance.stdout + conformance.stderr).toBe(0);
  });
});
