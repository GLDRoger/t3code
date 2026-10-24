import type { ChaosSeam } from "./inject.ts";

export const TIER_IDS = ["smoke", "nightly", "canary", "weekly"] as const;
export type TierId = (typeof TIER_IDS)[number];

export interface FaultClass {
  readonly id:
    | "provider_stream"
    | "tool_json"
    | "db"
    | "worktree_git"
    | "ws"
    | "crash"
    | "clock"
    | "canary"
    | "weekly";
  readonly seam: ChaosSeam | "live";
}

export interface Rng {
  next(): number;
}

export interface FaultSpec {
  readonly id: string;
  readonly faultClass: FaultClass["id"];
  readonly seam: ChaosSeam | "live";
  readonly summary: string;
  readonly tiers: readonly TierId[];
  readonly vary: (rng: Rng) => Readonly<Record<string, string | number>>;
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  const index = Math.floor(rng.next() * values.length);
  const value = values[index];
  if (value === undefined) throw new Error("empty pick");
  return value;
}

const none = (): Readonly<Record<string, string | number>> => ({});

export const FAULTS: readonly FaultSpec[] = [
  {
    id: "provider.stream_cut",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "Provider stream cut mid-text or mid-tool-call.",
    tiers: ["smoke", "nightly"],
    vary: (rng) => ({ at: pick(rng, ["mid_text", "mid_tool_call"] as const) }),
  },
  {
    id: "provider.http_status",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "Provider returns 429, 500, 502, 503, or a capacity error.",
    tiers: ["nightly"],
    vary: (rng) => ({
      status: pick(rng, ["429", "500", "502", "503", "capacity"] as const),
      exhausted: pick(rng, [0, 1] as const),
    }),
  },
  {
    id: "provider.slow_first_token",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "Slow first token. Pending time is measured after the fault clears.",
    tiers: ["nightly"],
    vary: (rng) => ({ delayMs: 200 + Math.floor(rng.next() * 800) }),
  },
  {
    id: "provider.slow_tokens",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "Slow tokens after the first.",
    tiers: ["nightly"],
    vary: (rng) => ({ delayMs: 200 + Math.floor(rng.next() * 800) }),
  },
  {
    id: "provider.duplicate_events",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "The provider emits the same event twice.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "provider.empty_response",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "The provider returns an empty response.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "provider.wrong_tool",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "The provider names a tool this lane cannot run.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "provider.huge_output",
    faultClass: "provider_stream",
    seam: "provider.stream",
    summary: "Huge provider output is truncated in the log and not applied as a write.",
    tiers: ["nightly"],
    vary: (rng) => ({ bytes: 50_000 + Math.floor(rng.next() * 50_000) }),
  },
  {
    id: "tool.malformed_json",
    faultClass: "tool_json",
    seam: "tool.json",
    summary: "Tool arguments are not JSON.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "tool.truncated_json",
    faultClass: "tool_json",
    seam: "tool.json",
    summary: "Tool JSON is cut off before it closes.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "db.connection_drop",
    faultClass: "db",
    seam: "db",
    summary: "Database connection drops before commit.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "db.too_many_connections",
    faultClass: "db",
    seam: "db",
    summary: "Too many connections (the old catalogue's 53300, and SQLite busy).",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "db.serialization_failure",
    faultClass: "db",
    seam: "db",
    summary: "Serialization failure; the transaction is not committed.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "db.deadlock",
    faultClass: "db",
    seam: "db",
    summary: "Deadlock; the transaction is not committed.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "db.slow_query",
    faultClass: "db",
    seam: "db",
    summary: "Slow query. The lane does not stay pending after it returns.",
    tiers: ["nightly"],
    vary: (rng) => ({ delayMs: 100 + Math.floor(rng.next() * 400) }),
  },
  {
    id: "db.read_only",
    faultClass: "db",
    seam: "db",
    summary: "Read-only transaction rejects the write.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "db.pool_exhausted",
    faultClass: "db",
    seam: "db",
    summary: "Connection pool exhausted.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.missing",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "The lane worktree directory is gone.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.dirty",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "The worktree is dirty when a checkpoint is captured.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.checkout_failure",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "Git checkout fails. Person text stays in the thread.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "worktree.checkpoint_missing",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "The checkpoint ref is missing.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.partial_commit",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "A commit is partial; recovery rolls it back.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.index_lock",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "The git index lock is held.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.corrupt_git",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "The git object store is corrupt.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "worktree.detached_head",
    faultClass: "worktree_git",
    seam: "worktree",
    summary: "HEAD is detached when the lane expected a branch.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "ws.disconnect",
    faultClass: "ws",
    seam: "ws",
    summary: "The client WebSocket drops mid-turn.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "ws.reconnect",
    faultClass: "ws",
    seam: "ws",
    summary: "The client reconnects and resumes from the event log.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "ws.duplicate_delivery",
    faultClass: "ws",
    seam: "ws",
    summary: "The same event is delivered twice on the socket.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "ws.out_of_order",
    faultClass: "ws",
    seam: "ws",
    summary: "Socket deliveries arrive out of order and are applied by id.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "ws.reset",
    faultClass: "ws",
    seam: "ws",
    summary: "The socket is reset.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "crash.provider_turn",
    faultClass: "crash",
    seam: "crash",
    summary: "The process dies during the provider turn.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "crash.checkpoint",
    faultClass: "crash",
    seam: "crash",
    summary: "The process dies during checkpoint capture.",
    tiers: ["nightly"],
    vary: none,
  },
  {
    id: "crash.commit",
    faultClass: "crash",
    seam: "crash",
    summary: "The process dies during the event commit. The in-flight event is absent.",
    tiers: ["smoke", "nightly"],
    vary: none,
  },
  {
    id: "clock.backward",
    faultClass: "clock",
    seam: "clock",
    summary: "The wall clock jumps backward. Pending time stays monotonic.",
    tiers: ["nightly"],
    vary: (rng) => ({ skewMs: -(1_000 + Math.floor(rng.next() * 120_000)) }),
  },
  {
    id: "clock.forward",
    faultClass: "clock",
    seam: "clock",
    summary: "The wall clock jumps forward. Pending time stays monotonic.",
    tiers: ["smoke", "nightly"],
    vary: (rng) => ({ skewMs: 1_000 + Math.floor(rng.next() * 120_000) }),
  },
  {
    id: "clock.scheduler_skew",
    faultClass: "clock",
    seam: "clock",
    summary: "The scheduler clock and the event clock disagree.",
    tiers: ["nightly"],
    vary: (rng) => ({ skewMs: Math.floor(rng.next() * 30_000) - 15_000 }),
  },
  {
    id: "canary.synthetic_turn",
    faultClass: "canary",
    seam: "provider.stream",
    summary: "Hourly synthetic turn in the canary workspace. Dry-run unless live chaos is armed.",
    tiers: ["canary"],
    vary: none,
  },
  {
    id: "weekly.live_stream",
    faultClass: "weekly",
    seam: "live",
    summary: "Weekly live-model stream fault. Dry-run unless live chaos is armed.",
    tiers: ["weekly"],
    vary: none,
  },
];

const BY_ID = new Map(FAULTS.map((fault) => [fault.id, fault]));

export function faultById(id: string): FaultSpec | undefined {
  return BY_ID.get(id);
}

export function faultsForTier(tier: TierId): readonly FaultSpec[] {
  return FAULTS.filter((fault) => fault.tiers.includes(tier));
}
