type Value = string | number | boolean | Value[] | { [key: string]: Value };
type Vars = Record<string, Value>;

const list = (value: Value | undefined): Value[] => (Array.isArray(value) ? value : []);
const field = (value: Value | undefined, name: string): Value | undefined =>
  value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value[name]
    : undefined;
const live = (vars: Vars) => list(vars["pays"]).filter((x) => field(x, "live") === true);
const paid = (vars: Vars) => live(vars).reduce((sum, x) => sum + Number(field(x, "minor")), 0);
const at = (vars: Vars, name: string, index: number) => list(vars[name])[index];

export const title = "Money recorded on a Confirm";

export const guide =
  "One client paid ₹1 lakh towards an invoice of ₹2 lakh. An agent puts up a receipt card saying so, and the bank statement shows the same money as a row; the same statement file may be sent again. You, a co-owner or a member tap Confirm, on one phone or two; the invoice can be edited, a payment taken back, a confirmed statement undone, and Kin can restart. A tap that changes nothing draws no arrow: a member's tap, a second tap on a card already answered, a tap on a card whose figures changed, or a co-owner's tap on a statement (statements are the owner's own). Red boxes are where a rule below breaks.";

export const rules: Record<string, string> = {
  MemberNeverRecords:
    "Only the owner's or a co-owner's Confirm records money; a member's tap never does.",
  OncePerConfirm:
    "One receipt card records its money at most once, however many times or devices tap it.",
  RecordedAsShown: "The amount recorded is the amount the card showed.",
  StaleNeverRecords:
    "A card whose invoice changed since it was drawn (a payment, a void, an edit) never records.",
  MoneyInBounded:
    "An invoice's received total never goes above its amount or above the money that really came in.",
  RowOnce:
    "A statement row is recorded once, however many times its file is read, sent again or confirmed.",
  ConfirmedIsRecorded:
    "Once you confirm a receipt, it is recorded, even if Kin restarts right after your tap.",
};

export const variants = [
  {
    name: "member-records",
    breaks: "MemberNeverRecords",
    what: "the owner-level check on a receipt tap is removed",
  },
  {
    name: "taps-race",
    breaks: "OncePerConfirm",
    what: "two phones' taps on one card are not run one after the other",
  },
  {
    name: "pay-balance",
    breaks: "RecordedAsShown",
    what: "the receipt records what the invoice still owes instead of the card's amount",
  },
  {
    name: "no-snapshot-check",
    breaks: "StaleNeverRecords",
    what: "Confirm no longer compares the card's figures with the invoice now",
  },
  {
    name: "no-seen-check",
    breaks: "MoneyInBounded",
    what: "a statement's Confirm pays an invoice that changed since the read (the code before this change)",
  },
  {
    name: "edit-below-received",
    breaks: "MoneyInBounded",
    what: "an invoice's amount may be cut below what it already received",
  },
  {
    name: "no-elsewhere",
    breaks: "RowOnce",
    what: "a row another statement already recorded is recorded again",
  },
  {
    name: "undo-forgets-held",
    breaks: "RowOnce",
    what: "a row kept by its receipt through an undo is recorded again on the next Confirm",
  },
  {
    name: "record-after-tap",
    breaks: "ConfirmedIsRecorded",
    what: "the receipt is written after the tap commits, not inside it",
  },
];

const receiptCard = (vars: Vars) => {
  const cards = list(vars["rc"]).map(String);
  if (cards.includes("made")) return "receipt recorded";
  if (cards.includes("open")) return "a receipt card waits";
  if (cards.includes("declined")) return "receipt cancelled";
  return "no receipt card";
};

const statement = (vars: Vars) => {
  const states = [0, 1].map((s) => String(at(vars, "st", s)));
  if (states.includes("applied")) return "statement confirmed";
  if (states.includes("read")) return "a statement card waits";
  if (states.includes("choose")) return "currency to pick";
  return "no statement";
};

const received = (vars: Vars) => {
  const total = paid(vars);
  return total === 0 ? "nothing received" : `₹${total} lakh received`;
};

/** Chart 1: the receipt card and what the invoice received. */
const receiptState = (vars: Vars) => `${receiptCard(vars)} · ${received(vars)}`;
/** Chart 2: the statement card and what the invoice received. */
const statementState = (vars: Vars) => `${statement(vars)} · ${received(vars)}`;

export const state = (vars: Vars) =>
  `${receiptCard(vars)} · ${statement(vars)} · ${received(vars)}`;

const who: Record<string, string> = { owner: "You", coowner: "A co-owner", member: "A member" };

export const step = (action: string, from: Vars, to: Vars) => {
  switch (action) {
    case "AgentAsks":
      return Number(to["asks"]) === 1
        ? "The agent puts up a receipt card"
        : "The agent puts up a fresh receipt card";
    case "TapReceipt": {
      const before = list(from["pays"]).length;
      const person = Object.keys(who).find(
        (p) =>
          list(to["pays"]).some((x) => field(x, "by") === p) &&
          !list(from["pays"]).some((x) => field(x, "by") === p && field(x, "src") === "r"),
      );
      return list(to["pays"]).length > before
        ? `${who[person ?? "owner"] ?? "You"} ${person === "owner" || person === undefined ? "tap" : "taps"} Confirm on the receipt`
        : "You tap Confirm on the receipt";
    }
    case "TapReceiptCancel":
      return "You tap Cancel on the receipt";
    case "RecordLater":
      return "The receipt is written";
    case "Read":
      return Number(from["reads"]) === 0
        ? "Kin reads the bank statement"
        : "Kin reads the statement again, or it is sent again";
    case "Pick":
      return "You or a co-owner pick its currency";
    case "ConfirmStatement":
      return "You confirm the statement";
    case "Undo":
      return "You undo the statement";
    case "IssueReceipt":
      return "Kin makes a receipt for the statement's payment";
    case "Void":
      return "You take a payment back";
    case "EditInvoice":
      return "The invoice is re-issued or its amount changed";
    case "Restart":
      return "Kin restarts";
    default:
      return action;
  }
};

const stepOf =
  (keep: ReadonlyArray<string>) =>
  (action: string, from: Vars, to: Vars): string | null =>
    keep.includes(action) ? step(action, from, to) : null;

export const charts = [
  {
    name: "receipt",
    title: "A receipt card: money an agent says came in",
    guide:
      "Each box is what the receipt card says and what the invoice has received. Steps of the bank statement are not drawn here; they show in the second chart. A tap that changes nothing draws no arrow: a member's tap, a second tap from another phone, or a tap on a card whose invoice changed since (Kin refuses it, and the agent puts up a fresh card).",
    state: receiptState,
    step: stepOf([
      "AgentAsks",
      "TapReceipt",
      "TapReceiptCancel",
      "RecordLater",
      "Void",
      "EditInvoice",
      "Restart",
    ]),
  },
  {
    name: "statement",
    title: "A bank statement: rows recorded on your Confirm",
    guide:
      "Each box is where the statement's card stands and what the invoice has received. The statement names no currency, so a currency card comes first. Kin may read it again, or you may send the same file again: a row already recorded is never recorded twice. A tap that changes nothing draws no arrow: a co-owner's or a member's Confirm, a Confirm from a phone still showing an earlier card, or a Confirm after the invoice changed since the read (Kin asks to read it again).",
    state: statementState,
    step: stepOf(["Read", "Pick", "ConfirmStatement", "Undo", "IssueReceipt", "Void"]),
  },
];
