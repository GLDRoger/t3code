type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "Kin watching GitHub with your login";

export const guide =
  "Each box is where Kin's watch stands: waiting for its next look at GitHub, or partway through one. Each arrow is something that happens: a teammate opens a PR or writes /kin, a stranger writes /kin, Kin weighs one thing it read, an agent answers on GitHub, the server stops and starts again. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  OnceEach:
    "Each thing on GitHub wakes an agent at most once, whether Kin read it on several looks or stopped halfway through one.",
  NoneLost:
    "Once Kin has caught up, every teammate's PR and /kin either woke an agent or was stopped for the hour with a note: none is lost to a stop, a busy look, or the cap.",
  OutsideStartsNothing:
    "Only a teammate's PR or /kin wakes an agent: a stranger's /kin and the agent's own signed replies never do.",
  OneReaction: "Kin puts at most one 👀 on each thing it takes up.",
  OneNotePerHour:
    "When a thread hits its hourly limit, Kin says so there once that hour, not per comment.",
};

export const variants = [
  {
    name: "cursor-first",
    breaks: "NoneLost",
    what: "the look moves its cursor before weighing what it read, so a stop halfway loses the rest",
  },
  {
    name: "skip-over-cap",
    breaks: "NoneLost",
    what: "past the per-look cap a trigger is stored as handled without waking anyone (the code before this change)",
  },
  {
    name: "wake-each-look",
    breaks: "OnceEach",
    what: "a look doesn't skip a trigger an earlier look stored, so a re-read wakes an agent again",
  },
  {
    name: "no-marker",
    breaks: "OutsideStartsNothing",
    what: "the agent's own signed reply counts as a call, so it answers itself",
  },
  {
    name: "stranger-calls",
    breaks: "OutsideStartsNothing",
    what: "a stranger's /kin starts work",
  },
  {
    name: "react-each-look",
    breaks: "OneReaction",
    what: "every look that reads a thing again puts another 👀 on it",
  },
  {
    name: "note-each",
    breaks: "OneNotePerHour",
    what: "every comment past the hourly limit gets its own note",
  },
];

const things: Record<string, string> = {
  pr: "a teammate's PR",
  call: "a teammate's /kin",
  stranger: "a stranger's /kin",
  own: "the agent's reply",
};

const list = (value: Value | undefined): Array<Value> =>
  Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? Object.values(value)
      : [];

export const state = (vars: Vars) => {
  const thread = list(vars["thread"]).map(String);
  const cursor = Number(vars["cursor"]);
  const where =
    vars["phase"] === "looking"
      ? `Kin is looking (read up to ${Number(vars["upTo"])}, at ${Number(vars["at"])})`
      : "Kin waits for its next look";
  const unread = thread.length - cursor;
  return `${where}; ${thread.length} on the thread, ${unread > 0 ? `${unread} after the last finished look` : "none after the last finished look"}`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Happen": {
      const added = list(to["thread"]).map(String).at(-1) ?? "";
      return `On GitHub: ${things[added] ?? added}`;
    }
    case "StartLook":
      return "Kin looks at GitHub";
    case "Weigh": {
      const at = Number(from["at"]);
      const what = things[list(from["thread"]).map(String)[at - 1] ?? ""] ?? "a thing";
      const woke =
        list(to["wakes"]).map(Number)[at - 1]! > list(from["wakes"]).map(Number)[at - 1]!;
      const capped = list(to["capped"]).length > list(from["capped"]).length;
      if (woke) return `Kin wakes an agent for ${what}`;
      if (capped) return `Kin stops ${what} for the hour`;
      if (to["later"] === true && from["later"] !== true)
        return `Kin leaves ${what} for its next look`;
      return `Kin passes over ${what}`;
    }
    case "React":
      return "Kin puts 👀 on it";
    case "EndLook":
      return to["cursor"] === from["cursor"] ? "The look ends, its cursor held" : "The look ends";
    case "Turn":
      return "The agent answers on GitHub, signed";
    case "Stop":
      return "The server stops and starts again";
    default:
      return null;
  }
};

export const chartConstants = { MaxThings: "2", MaxStops: "0" };

export const charts = [
  {
    title: "One look",
    guide:
      "Each box is where Kin's watch stands. A look reads what changed, weighs each thing once, wakes an agent for a teammate's PR or /kin, and only then moves on. A stop anywhere starts the look again from what was stored.",
    state: (vars: Vars) =>
      vars["phase"] === "looking"
        ? Number(vars["react"]) !== 0
          ? "Woke an agent, 👀 owed"
          : "Looking"
        : "Waiting for the next look",
    step: (action: string, from: Vars, to: Vars) =>
      action === "Happen" || action === "Turn" ? null : step(action, from, to),
  },
  {
    title: "The first thing on the thread",
    guide:
      "Each box is where the first thing on the thread stands. A teammate's PR or /kin wakes an agent once, and its signed answer starts nothing. A stranger's /kin is read and passed over.",
    state: (vars: Vars) => {
      const first = list(vars["thread"]).map(String)[0];
      if (first === undefined) return "Nothing on the thread yet";
      const what = things[first] ?? first;
      if (list(vars["capped"]).map(Number).includes(1)) return `${what}: stopped for the hour`;
      if (list(vars["wakes"]).map(Number)[0]! > 0)
        return list(vars["pending"]).map(Number).includes(1)
          ? `${what}: an agent is on it`
          : `${what}: answered on GitHub`;
      return `${what}: on GitHub`;
    },
    step: (action: string, from: Vars, to: Vars) =>
      action === "Happen" && list(from["thread"]).length > 0 ? null : step(action, from, to),
  },
];
