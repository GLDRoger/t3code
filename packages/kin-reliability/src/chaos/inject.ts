export interface ChaosEnv {
  readonly KIN_CHAOS?: string | undefined;
  readonly KIN_CHAOS_LIVE?: string | undefined;
  readonly KIN_RUNTIME?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}

export interface ChaosArm {
  readonly env: ChaosEnv;
  /** Server-side production signal. Wins even when NODE_ENV is unset. */
  readonly production?: boolean;
}

/**
 * Injection seams stay inert unless KIN_CHAOS=1 and the process is not
 * production. Production is NODE_ENV=production, KIN_RUNTIME=production,
 * or an explicit `production: true` from the server (T3 does not use
 * NODE_ENV as its only mode signal).
 */
export function chaosActive(arm: ChaosArm): boolean {
  if (arm.env.KIN_CHAOS !== "1") return false;
  if (arm.production === true) return false;
  if (arm.env.NODE_ENV === "production") return false;
  if (arm.env.KIN_RUNTIME === "production") return false;
  return true;
}

export function liveChaosArmed(arm: ChaosArm): boolean {
  return chaosActive(arm) && arm.env.KIN_CHAOS_LIVE === "1";
}

export type ChaosSeam =
  | "provider.stream"
  | "tool.json"
  | "db"
  | "worktree"
  | "ws"
  | "crash"
  | "clock";

export function injectText(
  arm: ChaosArm,
  seam: ChaosSeam,
  activeSeam: ChaosSeam | null,
  nominal: string,
  faulted: string,
): string {
  if (!chaosActive(arm)) return nominal;
  if (activeSeam !== seam) return nominal;
  return faulted;
}

export function readProviderChunk(
  arm: ChaosArm,
  activeSeam: ChaosSeam | null,
  chunk: string,
): string {
  return injectText(
    arm,
    "provider.stream",
    activeSeam,
    chunk,
    chunk.slice(0, Math.min(chunk.length, 4)),
  );
}

export function readToolJson(arm: ChaosArm, activeSeam: ChaosSeam | null, json: string): string {
  return injectText(
    arm,
    "tool.json",
    activeSeam,
    json,
    `${json.slice(0, Math.max(0, json.length - 1))}`,
  );
}
