// @effect-diagnostics globalDate:off - The clock Kin's view helpers read in render, outside an Effect runtime.

let devOffsetMs = 0;

/** Dev web only: how far a play-test (`kv clock`) moved its server's clock. Never set in a build. */
export function setKinDevClockOffset(offsetMs: number): void {
  devOffsetMs = Number.isFinite(offsetMs) ? offsetMs : 0;
}

export const kinClockOffsetMs = (): number => devOffsetMs;

/** Now as Kin's screens read it: the device's clock, plus a play-test's offset in dev. */
export const kinNowMs = (): number => Date.now() + devOffsetMs;
export const kinNow = (): Date => new Date(kinNowMs());
