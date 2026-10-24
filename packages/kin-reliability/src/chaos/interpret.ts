import { step } from "../lane/machine.ts";
import type { LaneMove, LaneRole, LaneState, WillFlag } from "../lane/states.ts";
import type { ReplayStep } from "../lane/machine.ts";
import type { World } from "./oracles.ts";
import { faultById } from "./catalogue.ts";

export const CHAOS_SECRET = "sk-kin-secret";

interface MutableWorld {
  personText: string[];
  savedText: string[];
  eventLog: { id: string; kind: string }[];
  actions: string[];
  deliveries: string[];
  appliedWrites: string[];
  partialWrite: boolean;
  untouchedOk: boolean;
  laneTrace: ReplayStep[];
  regnals: number[];
  pendingMsAfterClear: number;
  rawErrorVisible: boolean;
  failureCards: number;
  plainSentences: string[];
  recovered: boolean;
  logs: string;
  secret: string;
  crossProject: boolean;
  phase: LaneState;
  houseMax: number;
}

function blank(): MutableWorld {
  return {
    personText: ["kept-note"],
    savedText: ["kept-note"],
    eventLog: [],
    actions: [],
    deliveries: [],
    appliedWrites: [],
    partialWrite: false,
    untouchedOk: true,
    laneTrace: [],
    regnals: [],
    pendingMsAfterClear: 0,
    rawErrorVisible: false,
    failureCards: 0,
    plainSentences: [],
    recovered: true,
    logs: "recovered",
    secret: CHAOS_SECRET,
    crossProject: false,
    phase: "proposed",
    houseMax: 0,
  };
}

function record(world: MutableWorld, id: string, kind: string): void {
  world.actions.push(id);
  world.eventLog.push({ id, kind });
}

function deliver(world: MutableWorld, id: string): void {
  world.deliveries.push(id);
  record(world, `recv:${id}`, "delivery");
  if (!world.appliedWrites.includes(id)) {
    world.appliedWrites.push(id);
    record(world, `apply:${id}`, "apply");
  }
}

function pushLane(world: MutableWorld, move: LaneMove, role: LaneRole, will: WillFlag): void {
  const before = world.phase;
  const phase = step(before, move, role, will);
  world.laneTrace.push({ move, role, will, phaseAfter: phase });
  if (phase === "crowned" && before !== "crowned") {
    world.houseMax += 1;
    world.regnals.push(world.houseMax);
  }
  world.phase = phase;
}

function unrecoverable(world: MutableWorld, sentence: string): void {
  world.recovered = false;
  world.failureCards = 1;
  world.plainSentences = [sentence];
  world.rawErrorVisible = false;
  world.logs = "details-hidden";
}

function freeze(world: MutableWorld): World {
  return {
    personText: world.personText,
    savedText: world.savedText,
    eventLog: world.eventLog,
    actions: world.actions,
    deliveries: world.deliveries,
    appliedWrites: world.appliedWrites,
    partialWrite: world.partialWrite,
    untouchedOk: world.untouchedOk,
    laneTrace: world.laneTrace,
    regnals: world.regnals,
    pendingMsAfterClear: world.pendingMsAfterClear,
    rawErrorVisible: world.rawErrorVisible,
    failureCards: world.failureCards,
    plainSentences: world.plainSentences,
    recovered: world.recovered,
    logs: world.logs,
    secret: world.secret,
    crossProject: world.crossProject,
  };
}

function rejectWrite(world: MutableWorld, id: string, kind: string): void {
  record(world, id, kind);
}

/**
 * Recovery model for one fault. The world is what remains after the fault
 * clears. Oracles judge that world. A hand-built world in tests is how an
 * oracle shows it can fail.
 */
export function interpretFault(
  faultId: string,
  params: Readonly<Record<string, string | number>>,
): World {
  const fault = faultById(faultId);
  if (fault === undefined) throw new Error(`unknown fault ${faultId}`);
  const world = blank();
  record(world, `fault:${faultId}`, fault.faultClass);

  switch (faultId) {
    case "provider.stream_cut": {
      const at = String(params.at ?? "mid_text");
      record(world, `cut:${at}`, "stream.cut");
      if (at === "mid_tool_call") {
        rejectWrite(world, "tool:partial", "tool.rejected");
      } else {
        deliver(world, "stream:resume");
      }
      world.logs = `stream cut at ${at}`;
      break;
    }
    case "provider.http_status": {
      const status = String(params.status ?? "500");
      record(world, `http:${status}`, "provider.status");
      if (params.exhausted === 1) {
        unrecoverable(world, `The provider kept returning ${status}.`);
        pushLane(world, "fail", "author", "absent");
      } else {
        deliver(world, `retry:${status}`);
        world.logs = "retried after provider status";
      }
      break;
    }
    case "provider.slow_first_token":
    case "provider.slow_tokens":
    case "db.slow_query": {
      record(world, `slow:${faultId}`, "slow");
      deliver(world, "slow:done");
      world.pendingMsAfterClear = 1_500;
      world.logs = "slow call finished";
      break;
    }
    case "provider.duplicate_events":
    case "ws.duplicate_delivery": {
      deliver(world, "event:1");
      deliver(world, "event:1");
      pushLane(world, "duplicate", "author", "absent");
      break;
    }
    case "provider.empty_response": {
      record(world, "empty", "provider.empty");
      world.logs = "empty response ignored";
      break;
    }
    case "provider.wrong_tool": {
      rejectWrite(world, "tool:wrong", "tool.rejected");
      unrecoverable(world, "The tool name was not one this lane can run.");
      pushLane(world, "fail", "author", "absent");
      break;
    }
    case "provider.huge_output": {
      const bytes = Number(params.bytes ?? 50_000);
      record(world, "huge", "provider.truncated");
      world.logs = `truncated bytes=${bytes}`;
      break;
    }
    case "tool.malformed_json":
    case "tool.truncated_json": {
      rejectWrite(world, `json:${faultId}`, "tool.rejected");
      world.logs = "tool json rejected";
      break;
    }
    case "db.connection_drop":
    case "db.too_many_connections":
    case "db.serialization_failure":
    case "db.deadlock":
    case "db.read_only": {
      rejectWrite(world, `db:${faultId}`, "db.rollback");
      world.logs = "transaction rolled back";
      break;
    }
    case "db.pool_exhausted": {
      rejectWrite(world, "db:pool", "db.rollback");
      unrecoverable(world, "The database pool was exhausted.");
      pushLane(world, "fail", "author", "absent");
      break;
    }
    case "worktree.missing":
    case "worktree.dirty":
    case "worktree.checkout_failure":
    case "worktree.checkpoint_missing":
    case "worktree.index_lock":
    case "worktree.corrupt_git":
    case "worktree.detached_head": {
      record(world, `git:${faultId}`, "git.rejected");
      world.untouchedOk = true;
      world.partialWrite = false;
      unrecoverable(world, "The worktree could not be updated.");
      pushLane(world, "fail", "author", "absent");
      break;
    }
    case "worktree.partial_commit": {
      record(world, "git:rollback", "git.rollback");
      world.partialWrite = false;
      world.untouchedOk = true;
      world.logs = "partial commit rolled back";
      break;
    }
    case "ws.disconnect":
    case "ws.reset": {
      record(world, `ws:${faultId}`, "ws.drop");
      deliver(world, "ws:resume");
      world.logs = "socket resumed from the event log";
      break;
    }
    case "ws.reconnect": {
      record(world, "ws:reconnect", "ws.reconnect");
      deliver(world, "ws:replay");
      break;
    }
    case "ws.out_of_order": {
      const arrival = ["b", "a"];
      const ordered = [...arrival].sort();
      for (const id of ordered) deliver(world, `ord:${id}`);
      record(world, `arrival:${arrival.join(",")}`, "ws.arrival");
      break;
    }
    case "crash.provider_turn":
    case "crash.checkpoint": {
      record(world, `crash:${faultId}`, "crash");
      deliver(world, "crash:resume");
      world.pendingMsAfterClear = 0;
      world.logs = "resumed after crash";
      break;
    }
    case "crash.commit": {
      record(world, "crash:commit", "crash");
      world.logs = "in-flight event discarded";
      world.pendingMsAfterClear = 0;
      break;
    }
    case "clock.backward":
    case "clock.forward":
    case "clock.scheduler_skew": {
      const skewMs = Number(params.skewMs ?? 0);
      record(world, `clock:${skewMs}`, "clock");
      world.pendingMsAfterClear = 0;
      world.logs = `clock skewMs=${skewMs}`;
      break;
    }
    case "canary.synthetic_turn":
    case "weekly.live_stream": {
      deliver(world, "canary:turn");
      pushLane(world, "start", "author", "absent");
      world.logs = "dry-run turn";
      break;
    }
    default:
      throw new Error(`no recovery for ${faultId}`);
  }

  return freeze(world);
}
