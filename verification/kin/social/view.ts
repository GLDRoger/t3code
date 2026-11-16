type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const of = (vars: Vars, name: string, p: number) => list(vars[name])[p - 1];
const entries = (vars: Vars, p: number) => list(of(vars, "svc", p)).map(String);

export const title = "A week of posts, from the card to the account";

export const guide =
  "Each box is what the card says about the company's first post of the week, and whether the posting service holds it. Each arrow is something that happens: Social drafts or edits, you remove, note a client's OK, tap Confirm, Undo or Retry, Kin hands the post over, the service posts or fails, an account moves to another profile at the service, a key is widened, or Kin restarts. Red boxes are where a rule below breaks. The model has three posts (two of the company's, one client's) and at most two of these, once each: an answer lost, a restart, a service failure, an account moved, a key widened.";

export const rules: Record<string, string> = {
  ConfirmCovers:
    "Nothing reaches the service without your Confirm on that exact post; a post edited after the card was drawn needs a new card and a new Confirm.",
  NeverOtherGroup: "A post goes only to an account in its own group: ours, or that one client's.",
  RemovedNeverScheduled: "A post you removed from the card is never scheduled.",
  ClientNeedsOk: "A client's post is scheduled only after you noted the client's OK on its card.",
  AtMostOneEntry: "Restarts and lost answers never put one post at the service twice.",
  CancelledIsTrue: "When the card says Cancelled, nothing at the service can still go out.",
  LateIsTrue:
    "When the card says a late post wasn't sent, the service really holds nothing for it.",
  AccountFailIsTrue:
    "When the card says a post wasn't sent because its account left the group, the service really holds nothing for it.",
  PostedIsTrue: "The card says Posted only for a post the service posted.",
  RetryNeverLate: "Retry on a post whose time passed sends it now; it never fails as late again.",
  ConfirmedSettles:
    "After Confirm, every post leaves Scheduling: it ends scheduled, failed with a reason, or cancelled, whatever restarts.",
  UndoCancels:
    "An Undo Kin took cancels the post, unless the service couldn't be reached before its time.",
};

export const variants = [
  {
    name: "no-replace-no-digest",
    breaks: "ConfirmCovers",
    what: "an edit changes a post in place on its card, and Confirm no longer checks the card still shows the rows",
  },
  {
    name: "edit-after-confirm",
    breaks: "ConfirmCovers",
    what: "Social may edit a post after Confirm",
  },
  {
    name: "no-send-check",
    breaks: "NeverOtherGroup",
    what: "the hand-over no longer checks the key reaches only the group's profile and the account is in it now",
  },
  {
    name: "confirm-all-on-card",
    breaks: "RemovedNeverScheduled",
    what: "Confirm takes every post on the card, removed ones too",
  },
  {
    name: "no-client-ok",
    breaks: "ClientNeedsOk",
    what: "Confirm on a client's card no longer needs the client's OK",
  },
  {
    name: "new-key-per-attempt",
    breaks: "AtMostOneEntry",
    what: "each attempt carries a new idempotency key",
  },
  {
    name: "no-rederive",
    breaks: "CancelledIsTrue",
    what: "Undo of a post whose service id was never saved cancels only in Kin",
  },
  {
    name: "local-undo",
    breaks: "CancelledIsTrue",
    what: "Undo marks the post cancelled without asking the service",
  },
  {
    name: "old-late-message",
    breaks: "LateIsTrue",
    what: "a post whose time passed says it wasn't sent even when an attempt may have reached the service (the code before this change)",
  },
  {
    name: "old-account-message",
    breaks: "AccountFailIsTrue",
    what: "a post refused for its account says nothing was sent even when an earlier attempt may have reached the service (the code before this change)",
  },
  {
    name: "late-retry-stuck",
    breaks: "RetryNeverLate",
    what: "Retry keeps the first Confirm's time, so a late post fails as late again (the code before this change)",
  },
  {
    name: "no-resume",
    breaks: "ConfirmedSettles",
    what: "after a restart the pass skips a post an earlier attempt touched",
  },
];

const card: Record<string, string> = {
  none: "Not drafted",
  draft: "A draft, not on a card",
  proposed: "On the card, waiting for your Confirm",
  removed: "Removed from the card",
  scheduling: "Confirmed; Kin is handing it over",
  scheduled: "Scheduled",
  undoing: "Undo tapped; Kin is cancelling",
  cancelled: "Cancelled",
  posted: "Posted, with its link",
};

/** What the card says about the company's first post, and what the service holds. */
export const state = (vars: Vars) => {
  const st = String(of(vars, "st", 1));
  const held = entries(vars, 1).filter((one) => one !== "none");
  if (held.length > 1) return "At the service twice";
  const service = held[0];
  const why = String(of(vars, "reason", 1));
  const says =
    st === "failed"
      ? why === "late-unsent"
        ? "Failed: Kin was off at its time, nothing sent"
        : why === "late-unknown"
          ? "Failed: Kin was off at its time, may have gone"
          : why === "account"
            ? "Failed: the account isn't in this group now, nothing sent"
            : why === "account-unknown"
              ? "Failed: the account isn't in this group now, may have gone"
              : "Failed, with Retry"
      : st === "scheduled" && why === "undo-late"
        ? "Undo too late: it went out"
        : (card[st] ?? st);
  return service === undefined || ["none", "draft", "proposed", "removed"].includes(st)
    ? says
    : `${says} · service: ${service}`;
};

export const step = (action: string, from: Vars, to: Vars) => {
  const moved = (name: string) =>
    JSON.stringify(of(from, name, 1)) !== JSON.stringify(of(to, name, 1));
  switch (action) {
    case "AgentDrafts":
      return "Social drafts the post";
    case "AgentEdits":
      return "Social edits the post";
    case "ShowWeek":
      return "Social puts the week on a card";
    case "OwnerRemoves":
      return "You remove the post";
    case "ClientSaysOk":
      return "You note the client's OK";
    case "OwnerConfirms":
      return "You tap Confirm";
    case "KinHandsOver":
      return moved("st") && of(to, "st", 1) === "failed"
        ? "Kin checks before handing over, and refuses"
        : "Kin hands the post to the service";
    case "KinSaves":
      return "Kin saves the service's answer";
    case "AnswerLost":
      return "The service's answer is lost";
    case "Restart":
      return "Kin restarts";
    case "OwnerUndoes":
      return "You tap Undo";
    case "KinCancels":
      return "Kin cancels it at the service";
    case "CancelLost":
      return "The service can't be reached to cancel";
    case "KinReads":
      return "Kin reads how it went";
    case "OwnerRetries":
      return "You tap Retry";
    case "ServicePosts":
      return "The service posts it";
    case "ServiceFails":
      return "The platform refuses it";
    case "AccountMoves":
      return "The account is moved to the client's profile at the service";
    case "KeyWidens":
      return "A key is changed to reach every profile";
    case "Tick":
      return "Time passes";
    default:
      return action;
  }
};

export const chartConstants = { Posts: "{1}" };
