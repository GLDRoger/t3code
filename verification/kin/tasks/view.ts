type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "A task's life between people and agents";

export const guide =
  "Each box is who holds one task and where it stands. Each arrow is a hand-off or a step on it: you, Ana, Ben or the lead agent give it, its holder starts it or hands it back with a note, someone takes it back, it is marked done or reopened. Making it private, moving it into Ben's project, a change to its notes, and its late alert being held draw no arrow; the rules below say what each may change. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  HolderSees:
    "A task always has exactly one holder, who can always see it, whatever its alert, privacy or project.",
  NoPingPong:
    "The agent never gives a task back to someone who handed it back, unless something on it changed since or you said so.",
  HelperSees: "A teammate also on a task can see it and is distinct from its holder.",
  PrivateStaysPrivate:
    "A task you mark private can be seen by you, your co-owners, whoever holds it and anyone also on it.",
  DoneReversible: "A task marked done can always be reopened.",
  OneNoticePerHandOff:
    "Every kept hand-off tells whoever receives it exactly once, unless they moved it themselves. Keeping a suggestion tells its current holder.",
  NoSuggestedNotice: "A suggested task does not wake or notify its holder before you keep it.",
  AskerIsGiver:
    "When someone asks the agent to give a task, they gave it, so handing it back returns it to them; the agent is the giver only on its own.",
  HandedBackShown:
    '"Handed back by" shows only on an open task, naming someone other than its holder: giving it again or closing it clears the mark.',
};

export const variants = [
  {
    name: "suggested-wakes",
    breaks: "NoSuggestedNotice",
    what: "moving a task before Keep wakes or notifies the new holder",
  },
  {
    name: "helper-cannot-see",
    breaks: "HelperSees",
    what: "someone also on the task cannot see it",
  },
  {
    name: "hold-hides",
    breaks: "HolderSees",
    what: "a held late alert hides the task from its holder",
  },
  {
    name: "last-change-only",
    breaks: "NoPingPong",
    what: "the agent's check reads only the latest change, so a hand-off in between hides a hand-back (the code before this change)",
  },
  {
    name: "giver-sees-private",
    breaks: "PrivateStaysPrivate",
    what: "whoever gave a task keeps seeing it once it is private",
  },
  {
    name: "done-final",
    breaks: "DoneReversible",
    what: "nothing reopens a task marked done",
  },
  {
    name: "screen-hand-back-silent",
    breaks: "OneNoticePerHandOff",
    what: "a teammate handing a task back on their screen tells no one (the code before this change)",
  },
  {
    name: "agent-gives",
    breaks: "AskerIsGiver",
    what: "the agent is the giver whoever asked it (the code before this change)",
  },
  {
    name: "mark-stays",
    breaks: "HandedBackShown",
    what: 'giving a task again leaves its "Handed back by" mark',
  },
];

const names: Record<string, string> = {
  owner: "You",
  ana: "Ana",
  ben: "Ben",
  agent: "The agent",
};
const holds: Record<string, string> = {
  owner: "You hold it",
  ana: "Ana holds it",
  ben: "Ben holds it",
  agent: "The agent holds it",
};

export const state = (vars: Vars) => {
  const holder = String(vars["holder"]);
  const where =
    vars["state"] === "done" ? "done" : vars["state"] === "doing" ? "started" : "not started";
  return `${holds[holder] ?? holder}, ${vars["kept"] === false ? "suggested" : where}`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Give": {
      const receiver =
        to["holder"] === "agent"
          ? "the agent"
          : (names[String(to["holder"])] ?? String(to["holder"]));
      if (to["holder"] === "owner") return "You take it back";
      if (to["byAgent"] === true) return `The agent gives it to ${receiver}`;
      if (to["asked"] !== "none" && to["asked"] !== undefined)
        return `${names[String(to["asked"])] ?? "Someone"} asks the agent to give it to ${receiver}`;
      if (to["holder"] === "agent" && to["byPerson"] === "owner")
        return from["holder"] === "agent" ? null : "It goes to the agent";
      const giver = names[String(to["byPerson"])] ?? "Someone";
      return `${giver} ${giver === "You" ? "give" : "gives"} it to ${receiver}`;
    }
    case "Keep":
      return "You keep it";
    case "HandBack":
      return `${names[String(from["holder"])] ?? "Its holder"} hands it back with a note`;
    case "ChangeHelper":
      return to["helper"] === "none"
        ? "The teammate comes off the task"
        : `${names[String(to["helper"])] ?? "A teammate"} is put on the task`;
    case "MakePrivate":
      return "You mark it private";
    case "Start":
      return "Its holder starts it";
    case "MarkDone":
      return "It is marked done";
    case "Reopen":
      return "It is reopened";
    default:
      return null;
  }
};

const only =
  (keep: ReadonlyArray<string>) =>
  (action: string, from: Vars, to: Vars): string | null =>
    keep.includes(action) ? step(action, from, to) : null;

export const charts = [
  {
    title: "Who holds it",
    guide:
      "Each box is who holds the task. Each arrow is a hand-off; each kept hand-off tells whoever receives it once. The agent never gives it straight back to someone who handed it back, unless something on it changed or you said so.",
    state: (vars: Vars) => holds[String(vars["holder"])] ?? String(vars["holder"]),
    step: only(["Give", "HandBack"]),
  },
  {
    title: "Where it stands",
    guide:
      "Each box is where the task stands, whoever holds it. Given to someone new, it is not started again until they start it. Done can always be undone.",
    state: (vars: Vars) =>
      vars["state"] === "done" ? "Done" : vars["state"] === "doing" ? "Started" : "Not started",
    step: (action: string, from: Vars, to: Vars) =>
      action === "Give" || action === "HandBack"
        ? "It changes hands"
        : only(["Start", "MarkDone", "Reopen"])(action, from, to),
  },
];
