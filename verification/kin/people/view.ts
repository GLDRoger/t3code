type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

export const title = "Changing who a person is";

export const guide =
  "Each box is who Ana is in the company. Each arrow is something you or a co-owner do: invite her, make her a co-owner or a member again, switch her Money place, make her a project's lead, remove her, let her back in. Through all of it Ana keeps reading, taps a card waiting in her chat, has a turn running for her, and holds a task an agent gave her: those draw no arrow here, and the rules below say what each may show her. Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  NothingOwnerLevelAfter:
    "Once Ana is made a member again or removed, nothing owner-level reaches her: no read, no tap on a card she could confirm a minute ago, no turn that started while she was a co-owner.",
  PromotionTakesEffect:
    "Made a co-owner, Ana gets a co-owner's view on her very next request, without joining again.",
  PlaceOffHides:
    "With her Money place off and no project she leads, Ana's next read, and her running turn, show her no money.",
  TasksGoBack:
    "When Ana is removed, a task she held goes back to whoever gave it, who is told; it never stays with her.",
  CoOwnerChangesNoKind: "A co-owner never makes anyone a co-owner or a member.",
  OneOwner: "There is always exactly one owner: no one can remove or demote him.",
  RejoinsAsMember:
    "Removed and let back in, Ana comes back as a member with a new joiner's places, unless you made her a co-owner since: her old level never comes back by itself.",
};

export const variants = [
  {
    name: "level-from-session",
    breaks: "NothingOwnerLevelAfter",
    what: "a request uses the level Ana's session was issued at",
  },
  {
    name: "no-abort",
    breaks: "NothingOwnerLevelAfter",
    what: "a demotion leaves her running turns going",
  },
  {
    name: "promote-needs-rejoin",
    breaks: "PromotionTakesEffect",
    what: "a promotion shows only once she joins again",
  },
  {
    name: "turn-keeps-places",
    breaks: "PlaceOffHides",
    what: "a running turn keeps the places it started with",
  },
  {
    name: "removal-keeps-tasks",
    breaks: "TasksGoBack",
    what: "removing her leaves her tasks with her (the code before this change)",
  },
  {
    name: "give-to-gone",
    breaks: "TasksGoBack",
    what: "an agent may give a task to someone removed (the code before this change)",
  },
  {
    name: "coowner-sets-kind",
    breaks: "CoOwnerChangesNoKind",
    what: "setAccess lets a co-owner through",
  },
  {
    name: "coowner-removes-owner",
    breaks: "OneOwner",
    what: "a co-owner may remove the owner",
  },
  {
    name: "rejoin-keeps-level",
    breaks: "RejoinsAsMember",
    what: "a removed co-owner's row keeps its level for the next invite (the code before this change)",
  },
];

/** Who Ana is in the company. */
export const state = (vars: Vars) => {
  const bound = vars["bound"] === true;
  const access = String(vars["access"]);
  if (!bound) {
    if (vars["gone"] === true)
      return vars["invite"] === "none" ? "Removed" : "Removed, invited back";
    return vars["invite"] === "none" ? "Not in the company" : "Invited";
  }
  if (access === "co_owner") return "Co-owner";
  if (vars["leads"] === true)
    return vars["money"] === true
      ? "Member who leads a project and sees Money"
      : "Member who leads a project";
  return vars["money"] === true ? "Member who sees Money" : "Member";
};

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "Invite":
      return from["gone"] === true
        ? "You or a co-owner invite her back"
        : "You or a co-owner invite her";
    case "Join":
      return from["gone"] === true ? "She joins again" : "She joins";
    case "SetAccess":
      return to["access"] === "co_owner"
        ? "You make her a co-owner"
        : "You make her a member again";
    case "Remove":
      return "You or a co-owner remove her from the company";
    case "SetMoney":
      return to["money"] === true
        ? "Her Money place is switched on"
        : "Her Money place is switched off";
    case "SetLead":
      return to["leads"] === true ? "She is made a project's lead" : "She is taken off leading it";
    case "RemoveOwner":
      return "A co-owner removes the owner";
    case "CardUp":
      return "A card waiting for an owner-level Confirm comes up in her chat";
    case "TapCard":
      return "She taps Confirm on it";
    case "Read":
      return "She opens a screen";
    case "TurnStarts":
      return "She writes to an agent";
    case "TurnAnswers":
      return "The agent answers her";
    case "AgentGives":
      return "An agent gives her a task";
    case "HandsBack":
      return "She hands the task back";
    default:
      return null;
  }
};

const inCompany = (vars: Vars) => {
  if (vars["bound"] === true) return "In the company";
  if (vars["gone"] === true) return vars["invite"] === "none" ? "Removed" : "Removed, invited back";
  return vars["invite"] === "none" ? "Not in the company" : "Invited";
};
const only =
  (keep: ReadonlyArray<string>) =>
  (action: string, from: Vars, to: Vars): string | null =>
    keep.includes(action) ? step(action, from, to) : null;

export const charts = [
  {
    title: "Joining and leaving",
    guide:
      "Each box is whether Ana is in the company. Removing her signs out every device, ends her chats and turns, and hands her open tasks back to whoever gave them; letting her back in starts her as a member with a new joiner's places, unless you made her a co-owner since.",
    state: inCompany,
    step: only(["Invite", "Join", "Remove", "RemoveOwner"]),
  },
  {
    title: "Who she is while she is in",
    guide:
      "Each box is who Ana is while she is in the company. Every change shows on her very next screen or tap, with no need to join again: made a member again, a card she could confirm a minute ago refuses her, and an agent's turn she started as a co-owner is stopped.",
    state: (vars: Vars) => (vars["bound"] === true ? state(vars) : "Not in the company"),
    step: only(["SetAccess", "SetMoney", "SetLead"]),
  },
];
