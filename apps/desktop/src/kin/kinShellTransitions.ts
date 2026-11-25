/** A link the window is redeeming on a team's host. */
export interface KinJoinAttempt {
  readonly generation: number;
  readonly origin: string;
  /** The link's own page on the host (`/kin/invite`, `/pair`). */
  readonly page: string;
  /** The host route whose answer says whether this link signed the computer in. */
  readonly redeemRoute: string;
  /** The team this computer stays on until the link works. */
  readonly previous: string | null;
  /** The window has shown the link's own page, so a redeeming request is this attempt's. */
  readonly committed: boolean;
}

/**
 * The one owner of which team the window is on. Every move (launch, join, switch, back, retry)
 * starts a new generation, so a result that arrives after a later move is dropped. The remembered
 * team only changes once a new link has verifiably signed this computer in.
 */
export function makeKinShellTransitions(remembered: string | null) {
  let generation = 0;
  let team = remembered;
  let attempt: KinJoinAttempt | null = null;

  return {
    remembered: () => team,
    attempt: () => attempt,
    /** The origin the window may show now: the link being redeemed, else the remembered team. */
    hostOrigin: () => attempt?.origin ?? team,
    generation: () => generation,
    isCurrent: (seen: number) => seen === generation,
    /** A move that is not a join: anything still pending from before is dropped. */
    begin: () => {
      attempt = null;
      return ++generation;
    },
    startJoin: (origin: string, page: string, redeemRoute: string): KinJoinAttempt => {
      const next = { generation: ++generation, origin, page, redeemRoute, previous: team };
      attempt = { ...next, committed: false };
      return attempt;
    },
    committed: (seen: number) => {
      if (attempt?.generation === seen) attempt = { ...attempt, committed: true };
    },
    /** The link worked: it becomes the team, and the old team (if another) is to be cleared. */
    joined: (seen: number) => {
      if (attempt === null || attempt.generation !== seen) return null;
      const { origin, previous } = attempt;
      attempt = null;
      team = origin;
      return { origin, clear: previous !== null && previous !== origin ? previous : null };
    },
    /** The link didn't work: the window goes back to the team it was on, still signed in. */
    failed: (seen: number) => {
      if (attempt === null || attempt.generation !== seen) return null;
      const { origin, previous } = attempt;
      attempt = null;
      generation++;
      return { origin, previous };
    },
    /** The person signed out here: no team, and anything still pending is dropped. */
    forget: () => {
      const was = team;
      attempt = null;
      team = null;
      generation++;
      return was;
    },
    /** The host said this computer is signed out, at launch. */
    signedOut: (seen: number, origin: string) => {
      if (seen !== generation || team !== origin) return false;
      team = null;
      return true;
    },
  };
}

export type KinShellTransitions = ReturnType<typeof makeKinShellTransitions>;
