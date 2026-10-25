import type { KinTrace } from "../lane/trace.ts";
import {
  BEND_MOVE,
  BEND_PHASE,
  BEND_ROLE,
  BEND_WILL,
  LANE_MOVES,
  LANE_ROLES,
  WILL_FLAGS,
  type LaneMove,
  type LaneRole,
  type LaneState,
  type WillFlag,
} from "../lane/states.ts";

function stepExpr(phaseExpr: string, move: LaneMove, role: LaneRole, will: WillFlag): string {
  return `Lane.step(${phaseExpr}, Lane.${BEND_MOVE[move]}{}, Lane.${BEND_ROLE[role]}{}, Lane.${BEND_WILL[will]}{})`;
}

function phaseExpr(phase: LaneState): string {
  return `Lane.${BEND_PHASE[phase]}{}`;
}

export interface BendLaw {
  readonly name: string;
  readonly proposition: string;
}

function renderLaws(laws: readonly BendLaw[]): string {
  const chunks = ["import Base", "import ./lane.bend as Lane", ""];
  for (const law of laws) {
    chunks.push(`law ${law.name}:`);
    chunks.push(`  ${law.proposition}`);
    chunks.push("");
    chunks.push(`def ${law.name}():`);
    chunks.push("  {==}");
    chunks.push("");
  }
  return chunks.join("\n");
}

/** One law per trace step. The right-hand side is the observed phase. */
export function traceLaws(traces: readonly KinTrace[]): readonly BendLaw[] {
  const laws: BendLaw[] = [];
  traces.forEach((trace, traceIndex) => {
    let expr = phaseExpr("proposed");
    trace.steps.forEach((step, stepIndex) => {
      expr = stepExpr(expr, step.move, step.role, step.will);
      laws.push({
        name: `trace_${traceIndex}_step_${stepIndex}`,
        proposition: `{${expr} == ${phaseExpr(step.phaseAfter)} : Lane.Phase}`,
      });
    });
  });
  return laws;
}

export function renderTraceCheck(traces: readonly KinTrace[]): string {
  return renderLaws(traceLaws(traces));
}

export interface OneStep {
  readonly start: LaneState;
  readonly move: LaneMove;
  readonly role: LaneRole;
  readonly will: WillFlag;
  readonly observed: LaneState;
}

export function renderOneSteps(steps: readonly OneStep[]): string {
  return renderLaws(
    steps.map((step, index) => ({
      name: `grid_${index}`,
      proposition: `{${stepExpr(phaseExpr(step.start), step.move, step.role, step.will)} == ${phaseExpr(step.observed)} : Lane.Phase}`,
    })),
  );
}

/**
 * Bounded sequences the V2 laws do not quantify over. Each law is one
 * concrete sequence. Together they are exhaustive up to `bound` and still
 * not a proof for longer sequences.
 */
export function sweepLaws(bound: number): readonly BendLaw[] {
  const sequences: LaneMove[][] = [[]];
  let frontier: LaneMove[][] = [[]];
  for (let length = 0; length < bound; length += 1) {
    const next: LaneMove[][] = [];
    for (const prefix of frontier) {
      for (const move of LANE_MOVES) next.push([...prefix, move]);
    }
    frontier = next;
    sequences.push(...next);
  }
  const laws: BendLaw[] = [];
  let index = 0;
  for (const sequence of sequences) {
    if (sequence.length === 0) continue;
    for (const will of WILL_FLAGS) {
      for (const role of LANE_ROLES) {
        const reviewer = role === "reviewer";
        const absent = will === "absent";
        if (!reviewer && !absent) continue;
        let expr = phaseExpr("proposed");
        for (const move of sequence) expr = stepExpr(expr, move, role, will);
        laws.push({
          name: `sweep_${index}`,
          proposition: `{Lane.not_crowned(${expr}) == True{} : Bool}`,
        });
        index += 1;
      }
    }
  }
  for (const role of LANE_ROLES) {
    for (const will of WILL_FLAGS) {
      laws.push({
        name: `sweep_${index}`,
        proposition: `{${stepExpr(phaseExpr("will_missing"), "crown", role, will)} == ${phaseExpr("will_missing")} : Lane.Phase}`,
      });
      index += 1;
    }
  }
  return laws;
}

export function renderSweep(bound: number): string {
  return renderLaws(sweepLaws(bound));
}

export function splitTraces<T>(traces: readonly T[]): {
  readonly left: readonly T[];
  readonly right: readonly T[];
} {
  const mid = Math.ceil(traces.length / 2);
  return { left: traces.slice(0, mid), right: traces.slice(mid) };
}
