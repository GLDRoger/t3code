type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "Work's live stream to one person";

export const guide =
  "Each box is what Ana's open Tasks screen holds and whether her socket is up. Each arrow is a change to a task or its deal, a section or her level changing, the host sending what changed, her socket dropping, or her app coming back. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  StreamEqualsRead:
    "Once everything sent has arrived, what her screen holds is exactly what reading her own view fresh would show, whatever order the changes reached her in and however often her socket dropped.",
  NoHiddenNamed:
    "She is never told of a task she can't see: a task leaving her view is named to her only if she was told of it before.",
  LevelStartsOver:
    "When she is made a co-owner or a member again, the next thing her screen gets is a start-over, before any task.",
};

export const variants = [
  {
    name: "no-shell-refresh",
    breaks: "StreamEqualsRead",
    what: "a Deals section switch leaves the promise in a teammate’s open Tasks page",
  },
  {
    name: "deal-no-dependent-row",
    breaks: "StreamEqualsRead",
    what: "the deal tick skips the promise, which stays on her screen after the deal is made private",
  },
  {
    name: "close-at-top",
    breaks: "StreamEqualsRead",
    what: "each burst tells her the highest number in it, even while an earlier change's tick is still on its way; cut off then, she resumes past that change (the code before this change)",
  },
  {
    name: "tick-number",
    breaks: "StreamEqualsRead",
    what: "a task read now is sent at its tick's number, so a late tick's news is dropped as older than what she holds, and the session forgets she holds it (the code before this change)",
  },
  {
    name: "removed-unseen",
    breaks: "NoHiddenNamed",
    what: "a task leaving a member's view is named to her even if she was never told of it",
  },
  {
    name: "no-level-check",
    breaks: "LevelStartsOver",
    what: "the session keeps serving her at the level she had when it opened",
  },
];

const held = (vars: Vars) => {
  const shown = vars["shown"] as Record<string, number>;
  const tasks = Object.entries(shown)
    .filter(([, version]) => version > 0)
    .map(([task, version]) => `${task}${version > 1 ? "′" : ""}`);
  return tasks.length === 0 ? "no tasks" : tasks.join(", ");
};

export const state = (vars: Vars) =>
  `${vars["member"] === true ? "Member" : "Co-owner"}, ${vars["up"] === true ? "connected" : "offline"}: holds ${held(vars)}`;

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Edit":
      return "A task changes";
    case "Share":
      return "A task is shared with her, or taken from her view";
    case "ShellSwitch":
      return to["sectionsOn"] === true ? "The owner turns Deals on" : "The owner turns Deals off";
    case "DealLabel":
      return to["dealPrivate"] === true
        ? "The owner makes the promise’s deal private"
        : "The owner makes the promise’s deal public";
    case "Level":
      return to["member"] === true ? "She is made a member" : "She is made a co-owner";
    case "Next":
      return "A change's tick reaches her session, or no one while she is offline";
    case "Batch":
      return "The host sends what changed";
    case "Drop":
      return "Her socket drops";
    case "Resume":
      return "Her app comes back and resumes";
    default:
      return null;
  }
};
