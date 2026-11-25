type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "A discussion in the Team room";

export const guide =
  "Each box is where one discussion stands and whose turn it is. Social opened it (or you named Social first), it is Finance's call, the Chief of staff chairs, and Growth has a stake and may pitch in uninvited. Each arrow is one message or a pass. Before it, agents open others against their caps, people are made co-owners and back, and a hand-off reports back; those draw no arrow, and the rules below say what each may do. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  EndsWithinCaps:
    "A discussion ends within its caps: after the last allowed message only the closing one is left.",
  OpenCaps:
    "Agents never have more than 2 discussions open at once, or start more than 6 in a day.",
  OneMessagePerTurn: "Each agent says one message per turn.",
  OnePitchPerMessage: "At most one agent nobody asked speaks after any one message.",
  OneObjection: "A decision can be objected to once, by one agent.",
  TeammateNeverReads:
    "A teammate can never read the Team room, even after being a co-owner or being added to it.",
  ToldOnce: "You are told a discussion's outcome once, never twice.",
  ReportOnce: "A hand-off's answer comes back to the agent who asked once.",
  UnaskedStaysThere:
    "An answer the agent who handed something off didn't ask for is not copied back to it.",
  AskAnsweredOnce:
    "Your Team-room message naming two agents gets one answer: their discussion, or while another is open an ordinary reply; never both, never twice, and never a second discussion beside the one Kin opened.",
  AlwaysEnds: "Every discussion ends: decided, parked, or brought to you.",
  OwnerTold:
    "You are always told how a discussion ended: at once if you asked for it, else with your next check-in.",
  AskerGetsReply:
    "The agent who handed something off and asked for the answer always gets it back.",
};

export const variants = [
  {
    name: "no-message-cap",
    breaks: "EndsWithinCaps",
    what: "nothing stops the agents at the message limit",
  },
  {
    name: "objection-past-cap",
    breaks: "EndsWithinCaps",
    what: "a decision at the message limit still invites an objection (the code before this change)",
  },
  {
    name: "object-decides",
    breaks: "OneObjection",
    what: "an objection that also decides invites a second objection (the code before this change)",
  },
  {
    name: "no-open-cap",
    breaks: "OpenCaps",
    what: "agents open discussions without the daily and at-once limits",
  },
  {
    name: "turn-kept",
    breaks: "OneMessagePerTurn",
    what: "a turn isn't used up by its message, so the agent can speak again in it",
  },
  {
    name: "all-pitch",
    breaks: "OnePitchPerMessage",
    what: "every agent a message touches is offered a turn, not just one",
  },
  {
    name: "membership-only",
    breaks: "TeammateNeverReads",
    what: "anyone the room lists reads it, so a co-owner made a teammate still does",
  },
  {
    name: "told-unclaimed",
    breaks: "ToldOnce",
    what: "telling the outcome isn't claimed, so a second check-in tells it again",
  },
  {
    name: "held-forever",
    breaks: "OwnerTold",
    what: "an outcome agents reached on their own is held and never delivered",
  },
  {
    name: "no-report-back",
    breaks: "AskerGetsReply",
    what: "the answer stays in the other agent's chat and never comes back",
  },
  {
    name: "answerer-woken",
    breaks: "AskAnsweredOnce",
    what: "the room's agent also answers your message plainly, beside the discussion it opened",
  },
  {
    name: "ask-unkeyed",
    breaks: "AskAnsweredOnce",
    what: "your message handled again after a restart finds a discussion open (its own) and is answered plainly too",
  },
  {
    name: "plain-forgotten",
    breaks: "AskAnsweredOnce",
    what: "your message answered plainly while another discussion was open opens one too when handled again after that one ends (the code before this change)",
  },
  {
    name: "open-beside",
    breaks: "AskAnsweredOnce",
    what: "the agent whose turn it is in the discussion your message opened opens a second one for the same ask (the code before this change)",
  },
  {
    name: "copy-unasked",
    breaks: "UnaskedStaysThere",
    what: "an answer the asker didn't ask for is copied back to it anyway (the code before this change)",
  },
  {
    name: "report-unclaimed",
    breaks: "ReportOnce",
    what: "a retried wake-up end carries the same answer back twice",
  },
];

const names: Record<string, string> = {
  O: "Social",
  D: "Finance",
  C: "the Chief of staff",
  X: "Growth",
};
const kinds: Record<string, string> = {
  named: "asked",
  decider: "its call",
  pitch_in: "may pitch in",
  chair: "chair check",
  object: "may object",
  closing: "must close it",
};

const turnOf = (vars: Vars) => {
  const turn = vars["turn"] as Record<string, Value> | undefined;
  return turn === undefined || turn["who"] === "none"
    ? null
    : `${names[String(turn["who"])] ?? String(turn["who"])} (${kinds[String(turn["kind"])] ?? ""})`;
};

export const state = (vars: Vars) => {
  if (vars["stage"] === "setup") return "Before the discussion";
  const phase = String(vars["phase"]);
  if (vars["final"] === true)
    return phase === "escalated"
      ? `Brought to you${vars["told"] === 1 ? ", told" : ""}`
      : `${phase === "parked" ? "Parked" : "Decided"}${vars["told"] === 1 ? ", you're told" : ", you're not told yet"}`;
  const turn = turnOf(vars);
  return `${phase === "closing" ? "Closing" : phase === "decided" ? "Decided, open to one objection" : "Talking"}: ${turn ?? "no one"}, ${String(vars["msgs"])} said`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  const who = (vars: Vars) => {
    const turn = vars["turn"] as Record<string, Value>;
    return names[String(turn["who"])] ?? "An agent";
  };
  switch (action) {
    case "StartTalk":
      return "A discussion opens";
    case "Say":
      if (to["final"] === true)
        return to["phase"] === "parked"
          ? `${who(from)} parks it`
          : to["phase"] === "escalated"
            ? `${who(from)} brings it to you`
            : `${who(from)} decides`;
      if ((to["objections"] as number) > (from["objections"] as number))
        return `${who(from)} objects`;
      if (to["phase"] === "decided") return `${who(from)} decides; one may object`;
      return `${who(from)} says something`;
    case "Pass":
      return `${who(from)} passes`;
    case "Cut":
      return "Its budget or a quiet day leaves only the closing turn";
    case "IdleClose":
      return "Nobody closes it in a day: parked";
    case "CheckInRuns":
      return "Your next check-in tells you";
    case "AgentOpens":
      return "An agent opens a discussion";
    case "AgentDiscussionEnds":
      return "One of them ends";
    case "NewDay":
      return "A new day starts";
    case "SetAccess":
      return "You make someone a co-owner, or take it away";
    case "RoomSweep":
      return "Co-owners join the Team room";
    case "OwnerAdds":
      return "You add someone to the Team room";
    case "Reads":
      return "Someone opens the Team room";
    case "HandOff":
      return to["wants"] === false
        ? "An agent hands something to another, wanting no answer back"
        : "An agent hands something to another";
    case "ReceiverWakes":
      return "The other agent takes it up";
    case "ReceiverAnswers":
      return "It answers in its chat with you";
    case "ReceiverFails":
      return "Its turn fails and is tried again";
    case "ReceiverEnds":
      return to["reports"] === from["reports"]
        ? "Its turn ends: the answer stays where it was given"
        : "Its turn ends: the answer goes back to the asker";
    case "AskHandled":
      return "Kin reads your message naming two agents";
    case "OpensBeside":
      return `${who(from)} opens a second discussion for your ask`;
    default:
      return null;
  }
};

const talkOnly = (vars: Vars) => vars["stage"] === "talk";

export const charts = [
  {
    title: "How a discussion ends",
    guide:
      "Each box is where the discussion stands. Each arrow is a message, a pass, or a limit reached. Every path ends decided, parked or brought to you, and you hear the outcome once.",
    state: (vars: Vars) => {
      if (!talkOnly(vars)) return "Before it opens";
      if (vars["final"] === true)
        return `${vars["phase"] === "parked" ? "Parked" : vars["phase"] === "escalated" ? "Brought to you" : "Decided"}${vars["told"] === 1 ? ", you're told" : ", waiting for your check-in"}`;
      return vars["phase"] === "closing"
        ? "At the limit: only the closing turn"
        : vars["phase"] === "decided"
          ? "Decided, open to one objection"
          : "Agents talking";
    },
    step: (action: string, from: Vars, to: Vars) => {
      const label = step(action, from, to);
      if (label === null) return null;
      return label.replace(/^(Social|Finance|Growth|the Chief of staff) /, "An agent ");
    },
  },
];
