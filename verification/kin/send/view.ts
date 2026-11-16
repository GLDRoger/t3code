type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const at = (vars: Vars, name: string, card: number) => list(vars[name])[card];
const cards = (vars: Vars) => list(vars["card"]).map((_, index) => index);

export const title = "A mail card that leaves the company";

export const guide =
  "Each box is what you would see about one mail an agent wants to send for you, such as an invoice to a client. Each arrow is something that happens: you or a teammate tap, the agent corrects itself, the mail account's sign-in expires, the mail service fails, or Kin restarts. Red boxes are where a rule below breaks. The model allows two cards from the agent (a draft and its correction), one re-made invoice, one expired sign-in, one mail-service error and one restart, in any order.";

export const rules: Record<string, string> = {
  SentAtMostOnce: "A mail you confirmed goes out at most once.",
  MemberNeverSends: "Only the owner's or a co-owner's Confirm sends; a member's tap never does.",
  SentAsShown: "What goes out is exactly the file the card showed when you tapped.",
  ReplacedNeverSends: "Once the agent has put up a corrected card, the older card can never send.",
  ModelHasRoom: "The model has room for every card it makes (a check on the model, not on Kin).",
  ConfirmedSettles:
    "After you tap Confirm, the card always ends as Sent or as Failed, never stuck on Sending.",
  FailureComesBack:
    "When a send fails or the file changed, the same mail comes back on a new card.",
};

export const variants = [
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
    breaks: "SentAsShown",
    what: "Confirm no longer checks the file is still the one shown",
  },
  {
    name: "no-replace",
    breaks: "ReplacedNeverSends",
    what: "a newer card no longer closes the older one",
  },
];

const who: Record<string, string> = { owner: "You", coowner: "A co-owner", member: "A member" };

export const state = (vars: Vars) => {
  const all = cards(vars);
  const card = (c: number) => at(vars, "card", c);
  const job = (c: number) => at(vars, "job", c);
  if (all.some((c) => Number(at(vars, "went", c)) > 1)) return "Sent twice";
  const sentOnce = all.some((c) => Number(at(vars, "went", c)) === 1);
  const open = all.filter((c) => card(c) === "open");
  if (all.some((c) => card(c) === "sending" && job(c) === "idle"))
    return sentOnce ? "Stuck on Sending… though it went" : "Stuck on Sending… and not sent";
  if (all.some((c) => card(c) === "sending"))
    return sentOnce ? "Sending… (one already went)" : "Sending…";
  const lost = all.some(
    (c) =>
      (card(c) === "failed" || (card(c) === "stale" && at(vars, "why", c) === "doc")) &&
      Number(at(vars, "next", c)) === 0 &&
      job(c) === "idle",
  );
  if (lost && open.length === 0)
    return sentOnce ? "Sent once" : "Failed, and the mail is on no card";
  if (all.some((c) => job(c) === "fresh")) return "Failed or out of date; a new card is coming";
  if (open.length > 0) {
    if (sentOnce) return "Sent once, and a newer card still waits";
    if (open.length > 1) return "Two cards show: the draft and its correction";
    return "A card waits for your Confirm";
  }
  if (sentOnce) return "Sent once";
  if (all.some((c) => card(c) === "declined")) return "Cancelled; nothing sent";
  if (all.every((c) => card(c) === "none")) return "Nothing asked yet";
  return "Nothing open";
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
        ? "You tap Confirm, but the invoice was re-made: that card closes"
        : `${person} ${person === "You" ? "tap" : "taps"} Confirm`;
    }
    case "TapCancel":
      return "You tap Cancel";
    case "ProviderSends": {
      const [c] = changed(from, to, "job");
      const now = c === undefined ? undefined : at(to, "job", c);
      return now === "went"
        ? "The mail goes out"
        : now === "signin"
          ? "The send finds the mail account's sign-in has expired"
          : "The mail service fails";
    }
    case "SendRecorded": {
      const [c] = changed(from, to, "card");
      return c !== undefined && at(to, "card", c) === "sent"
        ? "The card says Sent"
        : "The card says it failed";
    }
    case "FreshCard":
      return "The same mail comes back on a new card";
    case "Restart":
      return "Kin restarts";
    case "SignInExpires":
      return "The mail account's sign-in expires";
    case "SignInAgain":
      return "You sign in again";
    case "InvoiceRemade":
      return "The invoice is re-made";
    default:
      return action;
  }
};
