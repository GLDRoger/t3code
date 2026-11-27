type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const at = (vars: Vars, name: string, card: number) => list(vars[name])[card];
const cards = (vars: Vars) => list(vars["card"]).map((_, index) => index);

export const title = "A mail card that leaves the company";

export const guide =
  "Each box is what the newest card for one mail says, such as an invoice an agent wants to send a client for you. Each arrow is something that happens: you tap, the agent corrects itself, the mail account's sign-in expires, it is signed in again as someone else, the mail service fails, or Kin restarts. A tap that changes nothing draws no arrow: a member's tap, a second tap, a tap on a closed card, or a tap while the sign-in has expired (the card stays open for after you sign in again). Red boxes are where a rule below breaks. The model allows two cards from the agent (a draft and its correction) and at most two of these, once each: the invoice is re-made, the sign-in expires, the mail service fails, Kin restarts.";

export const rules: Record<string, string> = {
  RetryNeedsSentCheck:
    "When an earlier try may have gone, Confirm requires a sent-mail check for that try.",
  SentAtMostOnce: "A mail you confirmed goes out at most once.",
  MemberNeverSends: "Only the owner's or a co-owner's Confirm sends; a member's tap never does.",
  SentAsShown: "What goes out is exactly the file the card showed when you tapped.",
  OutdatedNeverSends:
    "An invoice re-made after its card was drawn never goes out in its old version.",
  ReplacedNeverSends: "Once the agent has put up a corrected card, the older card can never send.",
  SentFromShownAccount:
    "What goes out goes from the account the card showed, even after the mail account is signed in again as someone else.",
  ModelHasRoom: "The model has room for every card it makes (a check on the model, not on Kin).",
  ConfirmedSettles:
    "After you tap Confirm, the card always ends as Sent or as Failed, never stuck on Sending.",
  FailureComesBack:
    "When a send fails or the file changed, the mail comes back on a new card, or stands on the agent's newer card.",
};

export const variants = [
  {
    name: "no-sent-check",
    breaks: "RetryNeedsSentCheck",
    what: "Confirm skips the sent-mail check after an uncertain send",
  },
  {
    name: "member-confirms",
    breaks: "MemberNeverSends",
    what: "the owner-level check on a tap is removed",
  },
  {
    name: "no-answered-check",
    breaks: "SentAtMostOnce",
    what: "a second tap on a card already sending is let through",
  },
  {
    name: "send-latest-file",
    breaks: "SentAsShown",
    what: "the send re-reads the invoice's newest file instead of the card's",
  },
  {
    name: "no-file-check",
    breaks: "OutdatedNeverSends",
    what: "Confirm no longer checks the file is still the current one",
  },
  {
    name: "no-replace",
    breaks: "ReplacedNeverSends",
    what: "a newer card no longer closes the older one",
  },
  {
    name: "replace-after-post",
    breaks: "ReplacedNeverSends",
    what: "the older card closes only after the newer shows (the code before this change)",
  },
  {
    name: "error-loses-mail",
    breaks: "FailureComesBack",
    what: "a mail-service error ends the card without the mail coming back (the code before this change)",
  },
  {
    name: "copy-beside-correction",
    breaks: "ReplacedNeverSends",
    what: "a failed or out-of-date draft comes back beside the agent's correction (the code before this change)",
  },
  {
    name: "no-owed-card",
    breaks: "FailureComesBack",
    what: "start-up no longer posts the card a failed mail still owes (the code before this change)",
  },
  {
    name: "old-reconnect",
    breaks: "SentFromShownAccount",
    what: "a sign-in again whose account Kin can't read keeps the new tokens under the old name (the code before this change)",
  },
  {
    name: "no-account-bind",
    breaks: "SentFromShownAccount",
    what: "a sign-in Kin can't name moves the connection's generation, but Confirm and the send no longer check it",
  },
  {
    name: "no-resume",
    breaks: "ConfirmedSettles",
    what: "nothing settles a send a restart cut off (the code before this change)",
  },
];

const who: Record<string, string> = { owner: "You", coowner: "A co-owner", member: "A member" };

/** What the newest card for this mail shows: the one the owner looks at. */
export const state = (vars: Vars) => {
  const all = cards(vars);
  if (all.some((c) => Number(at(vars, "went", c)) > 1)) return "Sent twice";
  const shown = all.filter((c) => at(vars, "card", c) !== "none");
  const c = shown.at(-1);
  if (c === undefined) return "Nothing asked yet";
  const job = at(vars, "job", c);
  switch (at(vars, "card", c)) {
    case "open":
      return "A card waits for your Confirm";
    case "sending":
      if (job === "recover") return "Kin restarted mid-send";
      if (job === "idle") return "Stuck on Sending…";
      return "Sending…";
    case "sent":
      return "Sent";
    case "declined":
      return "Cancelled; nothing sent";
    default:
      return job === "fresh" || at(vars, "owes", c) === true
        ? "Failed or out of date; the mail is coming back"
        : "Failed; the mail is on no card";
  }
};

const changed = (from: Vars, to: Vars, name: string) =>
  cards(from).filter((c) => JSON.stringify(at(from, name, c)) !== JSON.stringify(at(to, name, c)));

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "AgentAsks":
      return Number(to["asks"]) === 1
        ? "The agent shows a card for the mail"
        : "The agent corrects itself with a newer card";
    case "AgentReplacesOlder":
      return "The older card closes as replaced";
    case "TapConfirm": {
      const [c] = changed(from, to, "card");
      if (c === undefined) return null;
      const person = who[String(at(to, "by", c))] ?? "You";
      return at(to, "card", c) === "stale"
        ? at(to, "why", c) === "account"
          ? "You tap Confirm, but the account was signed in again as someone else: that card closes"
          : "You tap Confirm, but the invoice was re-made: that card closes"
        : at(to, "why", c) === "unchecked"
          ? "You tap Confirm without checking the earlier try"
          : `${person} ${person === "You" ? "tap" : "taps"} Confirm`;
    }
    case "TapCancel":
      return "You tap Cancel";
    case "ProviderSends": {
      const [c] = changed(from, to, "job");
      const now = c === undefined ? undefined : at(to, "job", c);
      return now === "went"
        ? "The mail goes out"
        : now === "moved"
          ? "The send finds the account signed in as someone else, and sends nothing"
          : now === "signin"
            ? "The send finds the mail account's sign-in has expired"
            : now === "unknown"
              ? "The mail service gives no clear answer"
              : "The mail service fails";
    }
    case "SendRecorded": {
      const [c] = changed(from, to, "card");
      return c !== undefined && at(to, "card", c) === "sent"
        ? "The card says Sent"
        : "The card says it failed";
    }
    case "Recovered": {
      const [c] = changed(from, to, "card");
      return c !== undefined && at(to, "why", c) === "unknown"
        ? "Kin restarts and marks it failed because delivery is uncertain"
        : "Kin restarts and marks it failed before dispatch";
    }
    case "FreshCard":
      return "The same mail comes back on a new card";
    case "Restart":
      return "Kin restarts";
    case "SignInExpires":
      return "The mail account's sign-in expires";
    case "SignInAgain":
      return "You sign in again";
    case "SignInAsOther":
      return "The mail account is signed in again as someone else, and Kin can't read who";
    case "InvoiceRemade":
      return "The invoice is re-made";
    default:
      return action;
  }
};
