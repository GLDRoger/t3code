type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

/** A per-question function, printed by TLC as a tuple `<<a, b>>`. */
const ofQ = (value: Value | undefined, q: number): Value | undefined =>
  Array.isArray(value) ? value[q - 1] : typeof value === "object" ? value[String(q)] : undefined;

export const title = "A question an agent asks you, its default and its day";

export const guide =
  "Finance and the Chief of staff may each want to ask you the same thing (say, whether to draft VIOM's reminder), for themselves or for someone else's chat. Each box is where the questions stand; each arrow is something that happens: an agent asks, a question held for your quiet hours reaches you, you tap an answer, an agent marks it answered or withdraws it, a day passes, Kin's host stops or starts, the day comes and the default is taken, a question with no safe default is raised once more, or the agent does its default. Red boxes are where a rule below breaks.";

/** The chart is drawn without restarts; the rules are checked with one. */
export const chartConstants = { MaxOutages: "0" };

export const rules: Record<string, string> = {
  OnceWhileOpen:
    "While a question is open, no agent asks you the same thing again: Kin refuses the second ask.",
  DismissalStands:
    "For seven days after you dismiss a question, Kin refuses a repeat unless you bring it up again yourself.",
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
    "Every question ends: you answer it, the default is taken and done, or it is withdrawn or dismissed; one with no safe default is raised once and then waits in Waiting on you. One held for your quiet hours reaches you first. A restart loses none.",
  NoDefaultForOther:
    "A question asked for someone else's chat has no default: nobody answers it for you, and it waits for you.",
  OneWake:
    "Your answer to a question asked for someone else's chat wakes the agent once, in the chat that asked, and starts no turn in your own chat.",
  AnswerGoesBack:
    "Your answer to a question asked for someone else's chat always reaches the chat that asked, however Kin restarts.",
};

export const variants = [
  {
    name: "no-repeat-check",
    breaks: "OnceWhileOpen",
    what: "Kin lets a second agent ask the same thing while the first question is open",
  },
  {
    name: "forget-dismissal",
    breaks: "DismissalStands",
    what: "an agent asks the same question again right after you dismissed it",
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
  {
    name: "default-for-other",
    breaks: "NoDefaultForOther",
    what: "a question asked for someone else's chat keeps the default the agent named",
  },
  {
    name: "tap-wakes-there",
    breaks: "OneWake",
    what: "the tap on a question asked for someone else also starts a turn in the chat it was tapped in",
  },
  {
    name: "after-commit",
    breaks: "AnswerGoesBack",
    what: "the answer is sent back after the tap commits, from memory, which a restart loses",
  },
];

const WORDS: Record<string, string> = {
  none: "not asked",
  open: "open",
  answered: "answered",
  default_taken: "default taken",
  withdrawn: "withdrawn",
  dismissed: "dismissed",
};

const one = (vars: Vars, q: number) => {
  const st = String(ofQ(vars["st"], q) ?? "none");
  if (st === "none") return null;
  const who = ofQ(vars["asker"], q) === "chief" ? "Chief of staff" : "Finance";
  const safe = ofQ(vars["safe"], q) === true;
  const raised = ofQ(vars["raised"], q) === true;
  const done = Number(ofQ(vars["done"], q) ?? 0);
  const other = ofQ(vars["other"], q) === true;
  const held = other && ofQ(vars["posted"], q) !== true;
  const back = Number(ofQ(vars["back"], q) ?? 0);
  return `${who}'s ${safe ? "" : "no-default "}question${other ? " for another chat" : ""} ${
    WORDS[st] ?? st
  }${held ? ", held" : ""}${raised ? ", raised again" : ""}${done > 0 ? ", done" : ""}${
    back > 0 ? ", answer sent back" : ""
  }`;
};

export const state = (vars: Vars) => {
  const parts = [one(vars, 1), one(vars, 2)].filter((part) => part !== null);
  return `Day ${String(vars["clock"])}${vars["up"] === true ? "" : ", Kin stopped"}: ${
    parts.length === 0 ? "nothing asked" : parts.join("; ")
  }`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Ask":
      return "An agent asks you, with its default and day";
    case "Tap":
      return "You tap an answer";
    case "Close":
      return [1, 2].some(
        (q) => ofQ(from["st"], q) !== "dismissed" && ofQ(to["st"], q) === "dismissed",
      )
        ? "You dismiss the question"
        : "An agent marks it answered or withdraws it";
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
    case "Post":
      return "Your quiet hours end: the held question reaches you";
    case "Deliver":
      return "The answer, kept in memory, is sent back";
    default:
      return null;
  }
};
