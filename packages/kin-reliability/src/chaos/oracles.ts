import { assignRegnal, replay, type ReplayStep } from "../lane/machine.ts";
import type { LaneState } from "../lane/states.ts";

/**
 * Nine invariant oracles over threads, lanes, wills, the event log, worktrees,
 * and provider streams. `coverage` labels each one as DESIGN.md §10.3 asks:
 * the TypeScript check always runs; the label says what Bend adds.
 */
export const ORACLE_IDS = [
  "I-LOSS",
  "I-CORRUPT",
  "I-WRONG",
  "I-DOUBLE",
  "I-STUCK",
  "I-RAW",
  "I-HONEST",
  "I-LEAK",
  "I-RECORD",
] as const;

export type OracleId = (typeof ORACLE_IDS)[number];

export type OracleCoverage = "proved-in-model" | "trace-checked" | "swept" | "runtime-only";

export const ORACLE_COVERAGE: Record<
  OracleId,
  { readonly coverage: OracleCoverage; readonly meaning: string }
> = {
  "I-LOSS": {
    coverage: "runtime-only",
    meaning:
      "Person-typed or confirmed text is still in the saved thread. Worktree bytes are a runtime check, not a Bend proof.",
  },
  "I-CORRUPT": {
    coverage: "runtime-only",
    meaning:
      "A recovered world has no partial write, and bytes outside the intended change match. Needs the worktree.",
  },
  "I-WRONG": {
    coverage: "proved-in-model",
    meaning:
      "Lane phase, crown, reviewer, will, and regnal number follow the lane model. V2 proves the crown guards and the regnal successor. Shown UI numbers beyond that stay runtime-only.",
  },
  "I-DOUBLE": {
    coverage: "proved-in-model",
    meaning:
      "A delivery or crown is applied once. V2 proves duplicate moves and a second crown are identities.",
  },
  "I-STUCK": {
    coverage: "runtime-only",
    meaning: "After the fault clears, nothing stays pending longer than 60 seconds.",
  },
  "I-RAW": {
    coverage: "runtime-only",
    meaning:
      "A raw error, stack, parser message, or status code is not shown outside a details expander.",
  },
  "I-HONEST": {
    coverage: "runtime-only",
    meaning:
      "A recoverable fault ends with no failure card. An unrecoverable one ends in exactly one plain sentence.",
  },
  "I-LEAK": {
    coverage: "runtime-only",
    meaning: "No cross-project read, and the fixture secret is absent from logs.",
  },
  "I-RECORD": {
    coverage: "trace-checked",
    meaning:
      "Every action id is in the event log, and lane traces conform to the model. V3 checks exported traces.",
  },
};

export const STUCK_LIMIT_MS = 60_000;

export interface World {
  readonly personText: readonly string[];
  readonly savedText: readonly string[];
  readonly eventLog: readonly { readonly id: string; readonly kind: string }[];
  readonly actions: readonly string[];
  readonly deliveries: readonly string[];
  readonly appliedWrites: readonly string[];
  readonly partialWrite: boolean;
  readonly untouchedOk: boolean;
  readonly laneTrace: readonly ReplayStep[];
  readonly regnals: readonly number[];
  readonly pendingMsAfterClear: number;
  readonly rawErrorVisible: boolean;
  readonly failureCards: number;
  readonly plainSentences: readonly string[];
  readonly recovered: boolean;
  readonly logs: string;
  readonly secret: string;
  readonly crossProject: boolean;
}

export interface OracleResult {
  readonly id: OracleId;
  readonly ok: boolean;
  readonly detail: string;
}

function loss(world: World): OracleResult {
  const saved = new Map<string, number>();
  for (const text of world.savedText) saved.set(text, (saved.get(text) ?? 0) + 1);
  for (const text of world.personText) {
    const count = saved.get(text) ?? 0;
    if (count === 0) {
      return { id: "I-LOSS", ok: false, detail: `saved thread is missing ${JSON.stringify(text)}` };
    }
    saved.set(text, count - 1);
  }
  return { id: "I-LOSS", ok: true, detail: "person text is in the saved thread" };
}

function corrupt(world: World): OracleResult {
  if (world.partialWrite) {
    return { id: "I-CORRUPT", ok: false, detail: "a write was left partial" };
  }
  if (!world.untouchedOk) {
    return {
      id: "I-CORRUPT",
      ok: false,
      detail: "bytes outside the intended change differ",
    };
  }
  return { id: "I-CORRUPT", ok: true, detail: "worktree bytes outside the change match" };
}

function wrong(world: World): OracleResult {
  const mismatch = replay(world.laneTrace);
  if (mismatch !== null) {
    return {
      id: "I-WRONG",
      ok: false,
      detail: `lane trace step ${mismatch.index} observed ${mismatch.observed}, model ${mismatch.expected}`,
    };
  }
  let phase: LaneState = "proposed";
  let houseMax = 0;
  const assigned: number[] = [];
  for (const current of world.laneTrace) {
    const before = phase;
    phase = current.phaseAfter;
    if (phase === "crowned" && current.role === "reviewer") {
      return { id: "I-WRONG", ok: false, detail: "a reviewer lane is crowned" };
    }
    if (phase === "crowned" && before !== "crowned" && current.will !== "present") {
      return { id: "I-WRONG", ok: false, detail: "a lane was crowned without a will" };
    }
    const regnal = assignRegnal(houseMax, before, phase);
    if (regnal !== null) {
      assigned.push(regnal.regnal);
      houseMax = regnal.nextHouseMax;
    }
  }
  for (let index = 1; index < assigned.length; index += 1) {
    const previous = assigned[index - 1];
    const current = assigned[index];
    if (previous === undefined || current === undefined || current <= previous) {
      return { id: "I-WRONG", ok: false, detail: "regnal numbers do not strictly increase" };
    }
  }
  if (world.regnals.length !== assigned.length) {
    return {
      id: "I-WRONG",
      ok: false,
      detail: `world records ${world.regnals.length} regnals, model assigned ${assigned.length}`,
    };
  }
  for (let index = 0; index < assigned.length; index += 1) {
    if (world.regnals[index] !== assigned[index]) {
      return { id: "I-WRONG", ok: false, detail: "recorded regnal does not match the successor" };
    }
  }
  return { id: "I-WRONG", ok: true, detail: "lane phase and regnal numbers match the model" };
}

function double(world: World): OracleResult {
  const seen = new Set<string>();
  for (const write of world.appliedWrites) {
    if (seen.has(write)) {
      return { id: "I-DOUBLE", ok: false, detail: `write ${write} was applied twice` };
    }
    seen.add(write);
  }
  const uniqueDeliveries = new Set(world.deliveries);
  if (seen.size !== uniqueDeliveries.size) {
    return {
      id: "I-DOUBLE",
      ok: false,
      detail: `applied ${seen.size} writes for ${uniqueDeliveries.size} deliveries`,
    };
  }
  return { id: "I-DOUBLE", ok: true, detail: "each delivery was applied once" };
}

function stuck(world: World): OracleResult {
  if (world.pendingMsAfterClear > STUCK_LIMIT_MS) {
    return {
      id: "I-STUCK",
      ok: false,
      detail: `still pending ${world.pendingMsAfterClear}ms after the fault cleared`,
    };
  }
  return { id: "I-STUCK", ok: true, detail: "pending cleared within 60s" };
}

function raw(world: World): OracleResult {
  if (world.rawErrorVisible) {
    return { id: "I-RAW", ok: false, detail: "a raw error is visible outside details" };
  }
  return { id: "I-RAW", ok: true, detail: "no raw error is showing" };
}

function honest(world: World): OracleResult {
  if (world.recovered) {
    if (world.failureCards !== 0) {
      return {
        id: "I-HONEST",
        ok: false,
        detail: "a recovered fault still shows a failure card",
      };
    }
    return { id: "I-HONEST", ok: true, detail: "recovered with no failure card" };
  }
  if (world.plainSentences.length !== 1) {
    return {
      id: "I-HONEST",
      ok: false,
      detail: `unrecoverable fault has ${world.plainSentences.length} sentences`,
    };
  }
  return { id: "I-HONEST", ok: true, detail: "unrecoverable fault is one plain sentence" };
}

function leak(world: World): OracleResult {
  if (world.crossProject) {
    return { id: "I-LEAK", ok: false, detail: "a cross-project read happened" };
  }
  if (world.secret.length > 0 && world.logs.includes(world.secret)) {
    return { id: "I-LEAK", ok: false, detail: "a secret is in the log" };
  }
  return { id: "I-LEAK", ok: true, detail: "no cross-project data and no secret in logs" };
}

function record(world: World): OracleResult {
  const logged = new Set(world.eventLog.map((event) => event.id));
  for (const action of world.actions) {
    if (!logged.has(action)) {
      return {
        id: "I-RECORD",
        ok: false,
        detail: `action ${action} is missing from the event log`,
      };
    }
  }
  const mismatch = replay(world.laneTrace);
  if (mismatch !== null) {
    return {
      id: "I-RECORD",
      ok: false,
      detail: `event-log lane trace diverges at ${mismatch.index}`,
    };
  }
  return { id: "I-RECORD", ok: true, detail: "actions and the lane trace are recorded" };
}

const CHECKS: Record<OracleId, (world: World) => OracleResult> = {
  "I-LOSS": loss,
  "I-CORRUPT": corrupt,
  "I-WRONG": wrong,
  "I-DOUBLE": double,
  "I-STUCK": stuck,
  "I-RAW": raw,
  "I-HONEST": honest,
  "I-LEAK": leak,
  "I-RECORD": record,
};

export function runOracles(world: World): readonly OracleResult[] {
  return ORACLE_IDS.map((id) => CHECKS[id](world));
}

export function failedOracles(world: World): readonly OracleResult[] {
  return runOracles(world).filter((result) => !result.ok);
}
