import {
  laneMoveByCode,
  laneRoleByCode,
  laneStateByCode,
  LANE_MOVE_CODE,
  LANE_ROLE_CODE,
  LANE_STATE_CODE,
  willFlagByCode,
  WILL_FLAG_CODE,
} from "./states.ts";
import { type ReplayStep } from "./machine.ts";

/**
 * Compact numeric traces. Bend has no JSON library and its strings are
 * slow, so chaos and V3 speak this line format:
 *
 *   kin-trace 1
 *   # seed=<n> scenario=<id> commit=<sha>
 *   <move> <role> <will> <phase_after>
 *
 * Codes live next to the lane enum in `states.ts`. The phase before the
 * first line is `proposed`. `will` and `role` are inputs to that move.
 */
export interface KinTrace {
  readonly seed: number;
  readonly scenario: string;
  readonly commit: string;
  readonly steps: readonly ReplayStep[];
}

const HEADER = "kin-trace 1";

export function formatTrace(trace: KinTrace): string {
  const lines = [HEADER, `# seed=${trace.seed} scenario=${trace.scenario} commit=${trace.commit}`];
  for (const step of trace.steps) {
    lines.push(
      `${LANE_MOVE_CODE[step.move]} ${LANE_ROLE_CODE[step.role]} ${WILL_FLAG_CODE[step.will]} ${LANE_STATE_CODE[step.phaseAfter]}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseTrace(text: string, fallbackName = "trace"): KinTrace {
  const steps: ReplayStep[] = [];
  let seed = 0;
  let scenario = fallbackName;
  let commit = "unknown";
  let sawHeader = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      const seedMatch = /seed=(\d+)/u.exec(line);
      const scenarioMatch = /scenario=([^\s]+)/u.exec(line);
      const commitMatch = /commit=([^\s]+)/u.exec(line);
      if (seedMatch?.[1] !== undefined) seed = Number(seedMatch[1]);
      if (scenarioMatch?.[1] !== undefined) scenario = scenarioMatch[1];
      if (commitMatch?.[1] !== undefined) commit = commitMatch[1];
      continue;
    }
    if (line === HEADER) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader) {
      throw new Error(`trace is missing "${HEADER}"`);
    }
    const parts = line.split(/\s+/u);
    if (parts.length !== 4) {
      throw new Error(`trace line must have 4 codes: ${line}`);
    }
    const move = laneMoveByCode(Number(parts[0]));
    const role = laneRoleByCode(Number(parts[1]));
    const will = willFlagByCode(Number(parts[2]));
    const phaseAfter = laneStateByCode(Number(parts[3]));
    if (
      move === undefined ||
      role === undefined ||
      will === undefined ||
      phaseAfter === undefined
    ) {
      throw new Error(`trace line has an unknown code: ${line}`);
    }
    steps.push({ move, role, will, phaseAfter });
  }
  if (!sawHeader) throw new Error(`trace is missing "${HEADER}"`);
  return { seed, scenario, commit, steps };
}
