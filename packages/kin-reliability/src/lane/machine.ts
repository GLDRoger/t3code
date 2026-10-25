import { type LaneMove, type LaneRole, type LaneState, type WillFlag } from "./states.ts";

/**
 * Executable TypeScript mirror of `bend/lane.bend` that chaos oracles replay.
 * Not a proof: `kin verify` checks traces stay inside the Bend model, and a
 * disagreement fails that level. See the Bend laws for the transition rules.
 */
export function crown(phase: LaneState, role: LaneRole, will: WillFlag): LaneState {
  if (phase === "crowned") return "crowned";
  if (role === "reviewer") return phase;
  if (will === "absent") return phase;
  if (phase === "gated") return "crowned";
  return phase;
}

export function step(phase: LaneState, move: LaneMove, role: LaneRole, will: WillFlag): LaneState {
  if (move === "duplicate") return phase;
  if (phase === "failed" || phase === "crowned") return phase;
  if (move === "fail") return "failed";
  if (move === "crown") return crown(phase, role, will);
  if (move === "start") return phase === "proposed" ? "running" : phase;
  if (move === "finish_work") return phase === "running" ? "awaiting_will" : phase;
  if (move === "record_will") return phase === "will_missing" ? "gated" : phase;
  if (move === "miss_will") {
    return phase === "awaiting_will" && will === "absent" ? "will_missing" : phase;
  }
  if (move === "enter_gate") {
    if (will === "present" && (phase === "awaiting_will" || phase === "will_missing")) {
      return "gated";
    }
    return phase;
  }
  return phase;
}

/** Successor used for regnal numbers. Bend law `regnal_is_successor` is this. */
export function nextRegnal(previous: number): number {
  return previous + 1;
}

export interface ReplayStep {
  readonly move: LaneMove;
  readonly role: LaneRole;
  readonly will: WillFlag;
  readonly phaseAfter: LaneState;
}

export interface ReplayMismatch {
  readonly index: number;
  readonly expected: LaneState;
  readonly observed: LaneState;
}

/**
 * Replay a trace from `proposed`. Returns the first step whose observed
 * phase disagrees with the model, if any.
 */
export function replay(steps: readonly ReplayStep[]): ReplayMismatch | null {
  let phase: LaneState = "proposed";
  for (let index = 0; index < steps.length; index += 1) {
    const current = steps[index];
    if (current === undefined) break;
    const expected = step(phase, current.move, current.role, current.will);
    if (expected !== current.phaseAfter) {
      return { index, expected, observed: current.phaseAfter };
    }
    phase = current.phaseAfter;
  }
  return null;
}

export interface RegnalAssignment {
  readonly regnal: number;
  readonly nextHouseMax: number;
}

/**
 * A crown assigns the next regnal number once. A duplicate crown, a
 * reviewer, and any transition that does not enter `crowned` assign nothing.
 */
export function assignRegnal(
  houseMax: number,
  before: LaneState,
  after: LaneState,
): RegnalAssignment | null {
  if (after !== "crowned" || before === "crowned") return null;
  const regnal = nextRegnal(houseMax);
  return { regnal, nextHouseMax: regnal };
}
