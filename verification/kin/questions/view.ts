type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

/** A per-question function, printed by TLC as a tuple `<<a, b>>`. */
const ofQ = (value: Value | undefined, q: number): Value | undefined =>
  Array.isArray(value) ? value[q - 1] : typeof value === "object" ? value[String(q)] : undefined;

export const title = "A question an agent asks you, its default and its day";

export const guide =
  "Finance and the Chief of staff may each want to ask you the same thing (say, whether to draft VIOM's reminder). Each box is where the questions stand; each arrow is something that happens: an agent asks, you tap an answer, an agent marks it answered or withdraws it, a day passes, Kin's host stops or starts, the day comes and the default is taken, a question with no safe default is raised once more, or the agent does its default. Red boxes are where a rule below breaks.";

/** The chart is drawn without restarts; the rules are checked with one. */
export const chartConstants = { MaxOutages: "0" };

export const rules: Record<string, string> = {
  OnceWhileOpen:
    "While a question is open, no agent asks you the same thing again: Kin refuses the second ask.",
  NeverBeforeItsDay: "An agent never takes its default before the day it named.",
  TakenOnce: "A default is taken at most once, and done at most once, however often Kin restarts.",
  AnsweredOrTaken:
    "Once you answered, the default is never taken; an answer after the default was taken doesn't take it again.",
  NothingLeaves:
    "Nothing that leaves the company or moves money is ever done by a default: such a question waits for you.",
  TapsWhileOpen:
    "While a question is open, its card takes your tap, however long ago it was asked.",
  RaisedOnce: "A question with no safe default is raised once more, never twice.",
  AlwaysEnds:
    "Every question ends: you answer it, the default is taken and done, or it is withdrawn; one with no safe default is raised once and then waits in Waiting on you. A restart loses none.",
};

export const variants = [
  {
    name: "no-repeat-check",
    breaks: "OnceWhileOpen",
    what: "Kin lets a second agent ask the same thing while the first question is open",
  },
  {
    name: "early",
    breaks: "NeverBeforeItsDay",
    what: "the sweep takes a default without checking that its day has come",
  },
  {
    name: "memory-settled",
    breaks: "TakenOnce",
    what: "the sweep remembers what it took in memory instead of the row, so a restart takes it again",
  },
  {
    name: "answer-after-take",
    breaks: "AnsweredOrTaken",
    what: "taking the default leaves its card open, and a tap answers the question whatever state it is in",
  },
  {
    name: "no-words-check",
    breaks: "NothingLeaves",
    what: "Kin trusts the agent's default without reading whether it sends something out",
  },
  {
    name: "day-expiry",
    breaks: "TapsWhileOpen",
    what: "the question's card stops taking taps after a day, like a plain card",
  },
  {
    name: "raise-repeats",
    breaks: "RaisedOnce",
    what: "a question with no safe default is raised every morning",
  },
  {
    name: "timer-in-memory",
    breaks: "AlwaysEnds",
    what: "the day is kept by a timer in memory, which a restart loses",
  },
];

const WORDS: Record<string, string> = {
  none: "not asked",
  open: "open",
  answered: "answered",
  default_taken: "default taken",
  withdrawn: "withdrawn",
};

const one = (vars: Vars, q: number) => {
  const st = String(ofQ(vars["st"], q) ?? "none");
  if (st === "none") return null;
  const who = ofQ(vars["asker"], q) === "chief" ? "Chief of staff" : "Finance";
  const safe = ofQ(vars["safe"], q) === true;
  const raised = ofQ(vars["raised"], q) === true;
  const done = Number(ofQ(vars["done"], q) ?? 0);
  return `${who}'s ${safe ? "" : "no-default "}question ${WORDS[st] ?? st}${
    raised ? ", raised again" : ""
  }${done > 0 ? ", done" : ""}`;
};

export const state = (vars: Vars) => {
  const parts = [one(vars, 1), one(vars, 2)].filter((part) => part !== null);
  return `Day ${String(vars["clock"])}${vars["up"] === true ? "" : ", Kin stopped"}: ${
    parts.length === 0 ? "nothing asked" : parts.join("; ")
  }`;
};

export const step = (action: string) => {
  switch (action) {
    case "Ask":
      return "An agent asks you, with its default and day";
    case "Tap":
      return "You tap an answer";
    case "Close":
      return "An agent marks it answered, or withdraws it";
    case "Expire":
      return "A day passes on the card";
    case "Tick":
      return "Time passes";
    case "Stop":
      return "Kin's host stops";
    case "Start":
      return "Kin's host starts again";
    case "TakeDefault":
      return "Its day comes: Kin takes the default and wakes the agent";
    case "Raise":
      return "The next morning: Kin raises it once more";
    case "RunTurn":
      return "The agent does its default and says so";
    default:
      return null;
  }
};
