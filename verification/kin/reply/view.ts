type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const first = (vars: Vars, name: string) => list(vars[name])[0];

export const title = "Your message to an agent, and what comes back";

export const guide =
  "Each box is where your message to an agent stands, as you would see it in your chat. Each arrow is something that happens: you send, the agent starts on it, writes, thinks, sends you a message for someone else (a nudge or relay), its turn ends or fails, or Kin restarts. Red boxes are where a rule below breaks. The model covers two messages from you, three tries at starting, one restart, and a floor that can close; it follows your first message. “Working…” shows while the agent works on it and clears when the turn ends.";

export const rules: Record<string, string> = {
  NeverTwo: "Each message you send gets at most one reply or one plain failure line, never two.",
  NoteOnlyForBrokenPromise:
    "After a reply, a failure adds at most one short line, and only to name something the reply promised that did not happen.",
  NeverReasoning: "The agent's private reasoning never shows up as its reply.",
  RelayLands: "A nudge or relay the agent sends you always lands in your chat, whatever the floor.",
  EveryMessageAnswered:
    "Every message you send ends in a reply or a plain failure line, never silence, even when the agent sent you a nudge or relay meanwhile.",
  LineClears: '"Working…" (the agent\'s line) always clears.',
  EndNotSilent:
    "An agent can't end its turn while your message still waits for words; it is told to write its reply.",
};

export const variants = [
  {
    name: "reasoning-posted",
    breaks: "NeverReasoning",
    what: "the thinking filter (isAnswer) is removed",
  },
  {
    name: "relay-through-floor",
    breaks: "RelayLands",
    what: "a relay goes through the floor's grant instead of admitToPerson",
  },
  {
    name: "relay-counts",
    breaks: "EveryMessageAnswered",
    what: "a nudge or relay to the asker counts as their reply (the code before this change)",
  },
  {
    name: "partway-after-reply",
    breaks: "NeverTwo",
    what: "a turn that fails after its reply still says it stopped partway (the code before this change)",
  },
  {
    name: "requeue-replied",
    breaks: "NeverTwo",
    what: "a restart puts a message that already has its reply back in the queue (the code before this change)",
  },
  {
    name: "end-silent",
    breaks: "EndNotSilent",
    what: "kin_end ends a turn that posted nothing to a message waiting for words (the code before this change)",
  },
  {
    name: "line-stays",
    breaks: "LineClears",
    what: "the end of a turn no longer clears the agent's line",
  },
];

export const state = (vars: Vars) => {
  const ev = first(vars, "ev");
  const told = Number(first(vars, "replies")) + Number(first(vars, "fails"));
  if (told > 1) return "Answered twice";
  if (ev === "none") return "Nothing sent yet";
  if (told === 1 && ev === "queued") return "Answered, yet back in the queue";
  if (told === 1 && ev === "claimed" && first(vars, "covered") === false)
    return "Answered, and the agent starts on it again";
  if (told === 1) return Number(first(vars, "replies")) === 1 ? "Replied" : "Failure line shown";
  if (ev === "queued")
    return Number(first(vars, "tries")) > 0 ? "Waiting to try again" : "Sent, waiting";
  if (ev === "claimed") return "Agent working on it (Working…)";
  return "No answer";
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "PersonSends":
      return first(from, "ev") === "none" ? "You send a message" : "You send another message";
    case "Claim":
      return "The agent starts on it";
    case "Steer":
      return "Your next message joins the running turn";
    case "LeadReplies":
      return "The agent replies";
    case "LeadThinks":
      return "The agent thinks";
    case "LeadNudgesAsker":
      return "The agent sends you a nudge or a relay";
    case "LeadWorks":
      return "The agent uses a tool";
    case "LeadKeepsPromise":
      return "The agent posts the card or hand-over its reply promised";
    case "LeadEnds":
      return to.blind === true
        ? "The agent ends its turn before Kin has seen the call"
        : "The agent ends its turn";
    case "FloorCloses":
      return "The floor closes";
    case "RunCompletes":
      return Number(first(to, "fails")) > Number(first(from, "fails"))
        ? "The turn ends with no reply: “didn't reply”"
        : Number(first(to, "replies")) > Number(first(from, "replies"))
          ? "The turn ends; asked once more, the agent replies"
          : "The turn ends";
    case "RunFails":
      if (Number(first(to, "notes")) > Number(first(from, "notes")))
        return "The turn fails before what the reply promised: one line names it";
      if (first(to, "ev") === "done")
        return "The turn fails after the reply: logged, nothing posted";
      return Number(first(to, "fails")) > Number(first(from, "fails"))
        ? Number(first(to, "tries")) >= 3
          ? "It fails a third time: “won't try again”"
          : "The turn fails after doing something: “stopped partway”"
        : "The turn fails to start: “trying again”";
    case "Restart":
      return "Kin restarts mid-turn";
    default:
      return action;
  }
};
