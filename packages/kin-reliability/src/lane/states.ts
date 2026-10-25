/**
 * Lane states from DESIGN.md §13 that the reliability model codes against.
 * If the lane state machine's enum changes, retarget this module but keep the
 * numeric trace codes stable. `author` may be crowned; `reviewer` never is.
 */

export const LANE_STATES = [
  "proposed",
  "running",
  "awaiting_will",
  "will_missing",
  "gated",
  "crowned",
  "failed",
] as const;

export type LaneState = (typeof LANE_STATES)[number];

export const LANE_STATE_CODE: Record<LaneState, number> = {
  proposed: 0,
  running: 1,
  awaiting_will: 2,
  will_missing: 3,
  gated: 4,
  crowned: 5,
  failed: 6,
};

export const LANE_ROLES = ["author", "reviewer"] as const;
export type LaneRole = (typeof LANE_ROLES)[number];

export const LANE_ROLE_CODE: Record<LaneRole, number> = {
  author: 0,
  reviewer: 1,
};

export const WILL_FLAGS = ["absent", "present"] as const;
export type WillFlag = (typeof WILL_FLAGS)[number];

export const WILL_FLAG_CODE: Record<WillFlag, number> = {
  absent: 0,
  present: 1,
};

/**
 * Moves the Bend model can take. `fail` is spelled `MarkFailed` in Bend
 * because Bend's Base already declares a `Fail` constructor.
 */
export const LANE_MOVES = [
  "start",
  "finish_work",
  "record_will",
  "miss_will",
  "enter_gate",
  "crown",
  "fail",
  "duplicate",
] as const;

export type LaneMove = (typeof LANE_MOVES)[number];

export const LANE_MOVE_CODE: Record<LaneMove, number> = {
  start: 0,
  finish_work: 1,
  record_will: 2,
  miss_will: 3,
  enter_gate: 4,
  crown: 5,
  fail: 6,
  duplicate: 7,
};

export const BEND_PHASE: Record<LaneState, string> = {
  proposed: "Proposed",
  running: "Running",
  awaiting_will: "AwaitingWill",
  will_missing: "WillMissing",
  gated: "Gated",
  crowned: "Crowned",
  failed: "Failed",
};

export const BEND_ROLE: Record<LaneRole, string> = {
  author: "Author",
  reviewer: "Reviewer",
};

export const BEND_WILL: Record<WillFlag, string> = {
  absent: "Absent",
  present: "Present",
};

export const BEND_MOVE: Record<LaneMove, string> = {
  start: "Start",
  finish_work: "FinishWork",
  record_will: "RecordWill",
  miss_will: "MissWill",
  enter_gate: "EnterGate",
  crown: "Crown",
  fail: "MarkFailed",
  duplicate: "Duplicate",
};

function invert<T extends string>(codes: Record<T, number>): Map<number, T> {
  return new Map(Object.entries(codes).map(([name, code]) => [code as number, name as T]));
}

const STATE_BY_CODE = invert(LANE_STATE_CODE);
const ROLE_BY_CODE = invert(LANE_ROLE_CODE);
const WILL_BY_CODE = invert(WILL_FLAG_CODE);
const MOVE_BY_CODE = invert(LANE_MOVE_CODE);

export function laneStateByCode(code: number): LaneState | undefined {
  return STATE_BY_CODE.get(code);
}

export function laneRoleByCode(code: number): LaneRole | undefined {
  return ROLE_BY_CODE.get(code);
}

export function willFlagByCode(code: number): WillFlag | undefined {
  return WILL_BY_CODE.get(code);
}

export function laneMoveByCode(code: number): LaneMove | undefined {
  return MOVE_BY_CODE.get(code);
}
