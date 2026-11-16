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

const by = (who: string) => (who === "owner" ? "You" : "A co-owner");

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
    default:
      return null;
  }
};
void by;
