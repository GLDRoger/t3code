// @effect-diagnostics nodeBuiltinImport:off - Corpus traces are read from disk in the test process.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { corpusDir } from "../paths.ts";
import { assignRegnal, crown, nextRegnal, replay, step } from "./machine.ts";
import { LANE_STATES } from "./states.ts";
import { parseTrace } from "./trace.ts";

describe("lane machine", () => {
  it("keeps the design's lane states", () => {
    expect([...LANE_STATES]).toEqual([
      "proposed",
      "running",
      "awaiting_will",
      "will_missing",
      "gated",
      "crowned",
      "failed",
    ]);
  });

  it("crowns only an author who is gated and has a will", () => {
    expect(crown("gated", "author", "present")).toBe("crowned");
    expect(crown("gated", "reviewer", "present")).toBe("gated");
    expect(crown("gated", "author", "absent")).toBe("gated");
    expect(crown("will_missing", "author", "present")).toBe("will_missing");
    expect(crown("crowned", "author", "present")).toBe("crowned");
  });

  it("assigns strictly increasing regnal numbers and ignores a duplicate crown", () => {
    expect(nextRegnal(0)).toBe(1);
    expect(nextRegnal(4)).toBe(5);
    const first = assignRegnal(0, "gated", "crowned");
    expect(first).toEqual({ regnal: 1, nextHouseMax: 1 });
    expect(assignRegnal(first?.nextHouseMax ?? 0, "crowned", "crowned")).toBeNull();
    const second = assignRegnal(first?.nextHouseMax ?? 0, "gated", "crowned");
    expect(second?.regnal).toBe(2);
  });

  it("replays the committed corpus", () => {
    for (const name of NodeFS.readdirSync(corpusDir)) {
      if (!name.endsWith(".trace")) continue;
      const trace = parseTrace(NodeFS.readFileSync(NodePath.join(corpusDir, name), "utf8"), name);
      expect(replay(trace.steps), name).toBeNull();
    }
  });

  it("rejects a reviewer crown that the trace claims happened", () => {
    const trace = parseTrace(
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "../verify/fixtures/bad-reviewer.trace"),
        "utf8",
      ),
    );
    expect(replay(trace.steps)?.observed).toBe("crowned");
    expect(step("proposed", "crown", "reviewer", "present")).toBe("proposed");
  });
});
