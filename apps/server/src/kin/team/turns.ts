/**
 * The Team room's rules, as plain code over a discussion's stored state: who speaks next, the
 * caps, widening once, one objection, and how every discussion ends. No model decides any of it.
 * `verification/kin/discussion` model-checks the same rules.
 */

export const TEAM_MAX_MESSAGES = 16;
/** About 33,000 units per warm owner-seat turn, so the cap lets the designed messages run. */
export const TEAM_UNITS_CAP = TEAM_MAX_MESSAGES * 33_000;
export const TEAM_IDLE_MS = 24 * 60 * 60 * 1000;
/** The Chief of staff's chair check comes once, at this many messages. */
const TEAM_CHAIR_AT = 10;
const TEAM_MAX_NAMED = 2;
/** How often one agent may be offered a pitch-in in one discussion, unless it is named. */
const TEAM_PITCH_OFFERS = 2;
/** Messages after an objection before the Chief of staff closes it. */
const TEAM_AFTER_OBJECTION = 2;
export const TEAM_AGENT_STARTED_PER_DAY = 6;
export const TEAM_OPEN_AT_ONCE = 2;
/** The share of the agents' daily budget Team-room turns may spend. */
export const TEAM_DAILY_SHARE = 0.3;

export type TurnKind = "named" | "decider" | "pitch_in" | "chair" | "object" | "closing";
export interface Turn {
  readonly agentId: string;
  readonly kind: TurnKind;
}
export type DiscussionState = "open" | "closing" | "decided" | "parked" | "escalated";

export interface Discussion {
  readonly state: DiscussionState;
  /** Ended for good: nobody is woken again and the owner is told. */
  readonly final: boolean;
  readonly decider: string;
  /** The Chief of staff, who chairs; the decider stands in when there is none. */
  readonly chair: string;
  readonly openedBy: string;
  readonly messages: number;
  readonly units: number;
  readonly widened: boolean;
  readonly objectionUsed: boolean;
  readonly afterObjection: number | null;
  readonly pending: ReadonlyArray<Turn>;
  readonly turn: Turn | null;
  readonly offers: Readonly<Record<string, number>>;
  /** Who wrote each message, oldest first. */
  readonly speakers: ReadonlyArray<string>;
  readonly chaired: boolean;
}

export type Ending = "decide" | "park" | "bring";
export interface Said {
  readonly agentId: string;
  readonly intent: "answer" | "evidence" | "objection" | "decision" | "question";
  /** Agents the message names, resolved to ids. */
  readonly to: ReadonlyArray<string>;
  readonly widen: boolean;
  readonly end: Ending | null;
  /** Agents whose stakes the message touches, strongest first. */
  readonly stakes: ReadonlyArray<string>;
}

/** A new discussion: its opener holds the first turn and says the opening message. */
export const opened = (input: {
  readonly openedBy: string;
  readonly decider: string;
  readonly chair: string;
}): Discussion => ({
  state: "open",
  final: false,
  decider: input.decider,
  chair: input.chair,
  openedBy: input.openedBy,
  messages: 0,
  units: 0,
  widened: false,
  objectionUsed: false,
  afterObjection: null,
  pending: [],
  turn: { agentId: input.openedBy, kind: "named" },
  offers: {},
  speakers: [],
  chaired: false,
});

/** Whether another discussion may open: agents start at most 6 a day and 2 at once. */
export const openRefusal = (input: {
  readonly byOwner: boolean;
  readonly agentStartedToday: number;
  readonly openNow: number;
  readonly overShare: boolean;
}) => {
  if (input.byOwner) return null;
  if (input.overShare)
    return "Team-room talk has used its share of today's budget; only discussions the owner asks for open until tomorrow.";
  if (input.agentStartedToday >= TEAM_AGENT_STARTED_PER_DAY)
    return `Agents have started ${TEAM_AGENT_STARTED_PER_DAY} discussions today, the most in a day.`;
  if (input.openNow >= TEAM_OPEN_AT_ONCE)
    return `${TEAM_OPEN_AT_ONCE} discussions are open already; add to one of them or wait for one to end.`;
  return null;
};

/** Why this message can't be said now, in words for the agent, or null when it can. */
export const sayRefusal = (d: Discussion, said: Said): string | null => {
  if (d.final) return "This discussion has ended.";
  if (d.turn?.agentId !== said.agentId)
    return "It isn't your turn in this discussion. Kin wakes you when it is.";
  const kind = d.turn.kind;
  if (kind === "closing" && said.end === null)
    return "This is the closing turn: decide, park it or bring it to the owner.";
  if (kind === "object" && (said.intent !== "objection" || said.end !== null))
    return "The decision stands unless you object: object once with intent objection and no end, or pass by ending without team_say.";
  if (said.widen && (d.widened || (said.agentId !== d.decider && said.agentId !== d.chair)))
    return d.widened
      ? "The question was widened once already. A new question needs its own discussion."
      : "Only the agent whose call it is, or the Chief of staff, restates the question. Argue for it instead.";
  if (said.end === "decide" && said.agentId !== d.decider && said.agentId !== d.chair)
    return "Only the agent whose call it is, or the Chief of staff, decides. Say what you'd decide instead.";
  if (said.end === "park" && said.agentId !== d.chair && kind !== "closing")
    return "Only the Chief of staff parks a discussion.";
  if (said.end === "bring" && said.agentId !== d.chair)
    return "Only the Chief of staff brings a disagreement to the owner.";
  return null;
};

const closing = (d: Discussion): Discussion => ({
  ...d,
  state: "closing",
  pending: [],
  turn: { agentId: d.chair, kind: "closing" },
});

const finished = (d: Discussion, state: DiscussionState): Discussion => ({
  ...d,
  state,
  final: true,
  pending: [],
  turn: null,
});

/** Who answers a message that names nobody: the decider, else whoever the decider answered. */
const answerer = (d: Discussion, speaker: string) => {
  if (speaker !== d.decider) return d.decider;
  const other = d.speakers.findLast((agentId) => agentId !== speaker);
  return other ?? (d.chair !== speaker ? d.chair : null);
};

/** The next turns after a message, the first of them now. */
const nextTurns = (d: Discussion, said: Said): Discussion => {
  const named = [...new Set(said.to)]
    .filter((agentId) => agentId !== said.agentId)
    .slice(0, TEAM_MAX_NAMED);
  const asked = named.length > 0 ? named : [answerer(d, said.agentId)].filter((id) => id !== null);
  const base: Array<Turn> = asked.map((agentId) => ({
    agentId,
    kind: named.length === 0 && agentId === d.decider ? "decider" : "named",
  }));
  const recent = new Set(d.speakers.slice(-2));
  const offers = { ...d.offers };
  const pitch = said.stakes.find(
    (agentId) =>
      agentId !== said.agentId &&
      agentId !== d.chair &&
      !base.some((turn) => turn.agentId === agentId) &&
      !recent.has(agentId) &&
      (offers[agentId] ?? 0) < TEAM_PITCH_OFFERS,
  );
  if (pitch !== undefined) offers[pitch] = (offers[pitch] ?? 0) + 1;
  const chair: Array<Turn> =
    !d.chaired && d.messages >= TEAM_CHAIR_AT && said.agentId !== d.chair
      ? [{ agentId: d.chair, kind: "chair" }]
      : [];
  // The uninvited agent speaks right after the message it reacts to; turns still owed from
  // earlier messages follow. A stale pitch-in or chair check is not carried.
  const turns: Array<Turn> = [];
  for (const turn of [
    ...chair,
    ...(pitch === undefined ? [] : [{ agentId: pitch, kind: "pitch_in" as const }]),
    ...base,
    ...d.pending.filter((turn) => turn.kind === "named" || turn.kind === "decider"),
  ])
    if (turn.agentId !== said.agentId && !turns.some((held) => held.agentId === turn.agentId))
      turns.push(turn);
  const [turn, ...pending] = turns;
  const next = { ...d, offers, chaired: d.chaired || chair.length > 0, pending };
  return turn === undefined ? closing(next) : { ...next, turn };
};

/** The discussion after a message `sayRefusal` let through. */
export const afterSay = (d: Discussion, said: Said): Discussion => {
  const wasClosing = d.turn?.kind === "closing";
  const base: Discussion = {
    ...d,
    messages: d.messages + 1,
    speakers: [...d.speakers, said.agentId],
    widened: d.widened || said.widen,
  };
  if (said.end === "park") return finished(base, "parked");
  if (said.end === "bring") return finished(base, "escalated");
  if (said.end === "decide") {
    // The one objection: offered to someone the matter touches who isn't the decider.
    const objector =
      // At the message limit a decision stands: an objection would run past it.
      wasClosing || d.objectionUsed || base.messages >= TEAM_MAX_MESSAGES
        ? undefined
        : [...said.stakes, ...base.speakers.toReversed()].find(
            (agentId) => agentId !== said.agentId && agentId !== d.chair,
          );
    if (objector === undefined) return finished(base, "decided");
    return { ...base, state: "decided", pending: [], turn: { agentId: objector, kind: "object" } };
  }
  if (d.turn?.kind === "object") {
    const reopened: Discussion = {
      ...base,
      state: "open",
      objectionUsed: true,
      afterObjection: TEAM_AFTER_OBJECTION,
    };
    return reopened.messages >= TEAM_MAX_MESSAGES
      ? closing(reopened)
      : nextTurns(reopened, { ...said, to: said.to.length > 0 ? said.to : [d.decider] });
  }
  const afterObjection = base.afterObjection === null ? null : base.afterObjection - 1;
  const counted = { ...base, afterObjection };
  if (
    (afterObjection !== null && afterObjection <= 0) ||
    counted.messages >= TEAM_MAX_MESSAGES ||
    counted.units >= TEAM_UNITS_CAP
  )
    return closing(counted);
  return nextTurns(counted, said);
};

/**
 * A turn ended without a message: a pass. The next waiting turn runs; with none, the Chief of
 * staff closes it. A pass on the closing turn parks it, and a pass on the objection leaves the
 * decision standing.
 */
export const afterPass = (d: Discussion, agentId: string): Discussion => {
  if (d.final || d.turn?.agentId !== agentId) return d;
  if (d.turn.kind === "closing") return finished(d, "parked");
  if (d.turn.kind === "object") return finished(d, "decided");
  const [turn, ...pending] = d.pending;
  return turn === undefined ? closing(d) : { ...d, turn, pending };
};

/** Units a turn of this discussion spent: past the cap, only the closing turn is left. */
export const afterUnits = (d: Discussion, units: number): Discussion => {
  const next = { ...d, units: d.units + units };
  return !d.final && d.state === "open" && next.units >= TEAM_UNITS_CAP ? closing(next) : next;
};

/** A day with no message: the Chief of staff closes it, and an unanswered close parks it. */
export const afterIdle = (d: Discussion): Discussion =>
  d.final ? d : d.state === "closing" ? finished(d, "parked") : closing(d);
