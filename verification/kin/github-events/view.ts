type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "Kin watching GitHub with your login";

export const guide =
  "Each box is where Kin's watch stands: waiting for its next look at GitHub, or partway through one. Each arrow is something that happens: a teammate opens a PR or writes /kin, a stranger writes /kin, someone opens an issue or comments on it, Kin weighs what it read, an agent answers on GitHub, the owner turns off replies to new issues, an hour ends, the server stops and starts again. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  OnceEach:
    "Each thing on GitHub wakes an agent at most once, whether Kin read it on several looks or stopped halfway through one.",
  NoneLost:
    "Once Kin has caught up, every teammate's PR and /kin either woke an agent or was stopped for the hour with a note: none is lost to a stop, a busy look, or the cap.",
  OutsideStartsNothing:
    "On a PR, only a teammate's PR or /kin wakes an agent: a stranger's /kin and the agent's own signed replies never do.",
  OneReaction: "Kin puts at most one 👀 on each thing it takes up.",
  OneNotePerHour:
    "When a thread hits its hourly limit, Kin says so there once that hour, not per comment.",
  RepliesCapped:
    "On a new issue, Kin answers people at most three times after its first comment, and posts at most one comment each time.",
  NoReplyToSelf:
    "On a new issue, only a person's comment wakes a reply: the agent's own comments and a bot's never do.",
  OffNextLook:
    "Once the owner turns off replies to new issues, no look that starts after that answers an issue.",
  OffAtOnce:
    "Once the owner turns off replies to new issues, Kin wakes no agent for an issue, even in a look already under way.",
  RepoHourCapped:
    "In one repo, issues wake at most ten agents an hour, from teammates and strangers alike.",
  OutsideHourCapped: "Strangers wake at most ten agents an hour across the owner's repos.",
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
  {
    name: "no-reply-cap",
    breaks: "RepliesCapped",
    what: "Kin answers every new comment on an issue, with no limit on replies",
  },
  {
    name: "reply-cap-at-look",
    breaks: "RepliesCapped",
    what: "only the look counts the replies left, not the claim, so two looks racing both answer",
  },
  {
    name: "own-wakes-reply",
    breaks: "NoReplyToSelf",
    what: "the agent's own comment counts as a person's, so it answers itself",
  },
  {
    name: "bot-wakes-reply",
    breaks: "NoReplyToSelf",
    what: "a bot's comment wakes a reply",
  },
  {
    name: "ignore-off",
    breaks: "OffNextLook",
    what: "a look answers new issues with replies to them turned off",
  },
  {
    name: "no-repo-hour",
    breaks: "RepoHourCapped",
    what: "issue triage has no hourly limit per repo",
  },
  {
    name: "no-outside-hour",
    breaks: "OutsideHourCapped",
    what: "strangers' issues have no hourly limit",
  },
];

const things: Record<string, string> = {
  pr: "a teammate's PR",
  call: "a teammate's /kin",
  stranger: "a stranger's /kin",
  own: "the agent's reply",
  in: "a teammate's new issue",
  out: "a stranger's new issue",
  person: "a person's comment",
  bot: "a bot's comment",
};

const list = (value: Value | undefined): Array<Value> =>
  Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null
      ? Object.values(value)
      : [];

const issueState = (vars: Vars) => {
  const thread = list(vars["thread"]).map(String);
  if (thread.length === 0) return "No issue yet";
  const looking = Object.values(
    typeof vars["looks"] === "object" && vars["looks"] !== null ? vars["looks"] : {},
  ).some((look) => typeof look === "object" && !Array.isArray(look) && Number(look["cand"]) > 0);
  const replies = list(vars["wakes"])
    .map(Number)
    .slice(1, thread.length)
    .filter((count) => count > 0).length;
  const said = Number(vars["kinSaid"]) > 0 ? "Kin has commented" : "Kin hasn't commented";
  const off = vars["triageOn"] === false ? "; replies to new issues are off" : "";
  return `${things[thread[0] ?? ""] ?? "an issue"} with ${thread.length - 1} comments; ${said}, ${replies} replies${off}${looking ? "; Kin is looking" : ""}`;
};

export const state = (vars: Vars) => {
  if (vars["item"] === "issue") return issueState(vars);
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
    case "IssueHappen": {
      const added = list(to["thread"]).map(String).at(-1) ?? "";
      return `On GitHub: ${things[added] ?? added}`;
    }
    case "SwitchOff":
      return "The owner turns off replies to new issues";
    case "Read":
      return "Kin reads the issue";
    case "Claim": {
      const before = list(from["wakes"]).map(Number);
      const woke = list(to["wakes"])
        .map(Number)
        .findIndex((count, index) => count > (before[index] ?? 0));
      if (woke === 0) return "Kin wakes an agent to answer the new issue";
      if (woke > 0) return "Kin wakes an agent to reply on the issue";
      return "Kin wakes no one for what it read";
    }
    case "Quiet":
      return "The agent ends its turn without commenting";
    case "Post":
      return "The agent comments on the issue";
    case "Answer":
      return Number(to["kinSaid"]) !== Number(from["kinSaid"])
        ? "GitHub says the comment is posted, and Kin stores that"
        : "GitHub's answer is lost: the comment is there, and Kin stores nothing";
    case "HourEnds":
      return "An hour passes";
    default:
      return null;
  }
};

export const chartConstants = { MaxThings: "2", MaxStops: "0", Items: '{"pull"}' };

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
