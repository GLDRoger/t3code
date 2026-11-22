import * as DateTime from "effect/DateTime";

import type { AlertMail, AlertReading, AlertRejection, BankAlertFormat } from "./bankAlerts.ts";

/**
 * HDFC Bank's transaction alert mails, read by code alone. A mail's text is untrusted: it counts
 * only from HDFC's alert address, with the receiving server's DMARC pass for that domain on its
 * topmost `Authentication-Results`, and only when every part reads one way. Anything else is
 * rejected with a reason and never guessed at. Nothing here logs.
 */

/** The addresses HDFC sends InstaAlerts from. */
const HDFC_ALERT_SENDERS: ReadonlySet<string> = new Set([
  "alerts@hdfcbank.net",
  "alerts@hdfcbank.bank.in",
]);

const isHdfcAlertSender = (address: string | null | undefined) =>
  address !== null && address !== undefined && HDFC_ALERT_SENDERS.has(address.toLowerCase());

const rejected = (reason: AlertRejection): AlertReading => ({ _tag: "rejected", reason });

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/**
 * Only the topmost `Authentication-Results`, the one the receiving server added: a sender can
 * write its own lower down. It must say DMARC passed for the sender's own domain.
 */
const vouched = (results: ReadonlyArray<string>, domain: string) => {
  const top = (results[0] ?? "").toLowerCase();
  const dmarc = /\bdmarc=(\w+)[^;]*?\bheader\.from=([a-z0-9.-]+)/.exec(top);
  return dmarc !== null && dmarc[1] === "pass" && dmarc[2] === domain;
};

const MAX_TEXT = 20_000;
// oxlint-disable-next-line t3code/kin-one-format -- an HDFC alert's "Rs." and "INR" name the rupee, whatever the home.
const RUPEES = "INR";
const CURRENCY = String.raw`(?:rs\.?\s?(?:inr\s?)?|inr\s?)`;
const AMOUNT = String.raw`(\d{1,3}(?:,\d{2,3})+\.\d{2}|\d+\.\d{2})`;
const ACCOUNT = String.raw`(?:account|a\/c)(?:\s+no\.?)?\s+(?:\*{2,}|x{2,})?(\d{4})\b`;
const MOVED = new RegExp(
  String.raw`${CURRENCY}${AMOUNT}\s+(?:has\s+been|is|was)\s+(?:successfully\s+)?(debited|credited)\s+(from|to)\s+(?:your\s+)?${ACCOUNT}`,
  "gi",
);
const BALANCE = new RegExp(
  String.raw`\b(?:avl\.?\s+bal(?:ance)?|available\s+balance)(?:\s+in\s+your\s+(?:account|a\/c))?(?:\s+is)?\s*[:-]?\s*${CURRENCY}${AMOUNT}`,
  "gi",
);
const REFERENCE =
  /\b(?:reference\s+(?:number|no\.?)|ref\.?\s*no\.?|utr(?:\s+no\.?)?)\s*(?:is|:|-)?\s*((?=[a-z0-9]*\d)[a-z0-9]{6,30})\b/gi;
const DAY = /\bon\s+(\d{2})-(\d{2})-(\d{4}|\d{2})\b/gi;
const UPI_PARTY =
  /\b(?:to|by)\s+vpa\s+([^\s@]+@[a-z0-9.-]+)(?:\s+(.{1,80}?))?\s+on\s+\d{2}-\d{2}-/i;
const FOR_PARTY = /\bfor\s+([^\n]{3,120}?)(?:\.\s|\.$|\n|$)/i;

/** Every distinct value a pattern captures, so one printed twice still reads one way. */
const distinct = (pattern: RegExp, text: string, group = 1) => [
  ...new Set([...text.matchAll(pattern)].map((match) => match[group]!.toLowerCase())),
];

/** `4,10,000.00` as paise; null for a figure that isn't one. */
const minorOf = (amount: string) => {
  const minor = Number(amount.replaceAll(",", "").replace(".", ""));
  return Number.isSafeInteger(minor) ? minor : null;
};

const DAY_MS = 86_400_000;

/** The day an alert names, when it is a real day within a week before its mail, or the day after. */
const dayOf = (day: string, month: string, year: string, sentAt: number) => {
  const full = year.length === 2 ? `20${year}` : year;
  const iso = `${full}-${month}-${day}`;
  const at = Date.parse(`${iso}T00:00:00Z`);
  // `Date.parse` rolls 31 Feb over to March: only a day that reads back the same is one.
  if (!Number.isFinite(at) || DateTime.formatIsoDate(DateTime.makeUnsafe(at)) !== iso) return null;
  return at >= sentAt - 8 * DAY_MS && at <= sentAt + DAY_MS ? iso : null;
};

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

/** One mail, read as one HDFC transaction alert or rejected with why. */
export const readHdfcAlert = (mail: AlertMail): AlertReading => {
  const from = mail.fromAddress?.toLowerCase() ?? null;
  if (!isHdfcAlertSender(from) || /^\s*(?:re|fwd?)\s*:/i.test(mail.subject))
    return rejected("sender");
  if (!vouched(mail.authResults, domainOf(from!))) return rejected("unverified");
  const sentAt = mail.date === null ? Number.NaN : Date.parse(mail.date);
  if (!Number.isFinite(sentAt) || mail.text.length > MAX_TEXT) return rejected("unparsed");
  const text = tidy(mail.text);

  const moved = [...text.matchAll(MOVED)];
  const kinds = new Set(moved.map((match) => match.slice(1).join("|").toLowerCase()));
  if (kinds.size !== 1) return rejected("unparsed");
  const [, amount, verb, preposition, account] = moved[0]!;
  const direction = verb!.toLowerCase() === "debited" ? "debit" : "credit";
  if ((direction === "debit") !== (preposition!.toLowerCase() === "from"))
    return rejected("unparsed");
  const amountMinor = minorOf(amount!);
  if (amountMinor === null || amountMinor <= 0) return rejected("unparsed");

  const references = distinct(REFERENCE, text);
  if (references.length !== 1) return rejected("unparsed");
  const days = [...new Set([...text.matchAll(DAY)].map((match) => match.slice(1, 4).join("-")))];
  if (days.length !== 1) return rejected("unparsed");
  const [day, month, year] = days[0]!.split("-");
  const date = dayOf(day!, month!, year!, sentAt);
  if (date === null) return rejected("unparsed");

  const balances = distinct(BALANCE, text);
  if (balances.length > 1) return rejected("unparsed");
  const balanceMinor = balances.length === 0 ? null : minorOf(balances[0]!);
  if (balances.length === 1 && balanceMinor === null) return rejected("unparsed");

  const upi = UPI_PARTY.exec(text);
  const named = upi === null ? FOR_PARTY.exec(text)?.[1] : tidy(`${upi[2] ?? ""} ${upi[1]}`);
  const counterparty = named === undefined || named === "" ? null : named.slice(0, 120);

  return {
    _tag: "alert",
    alert: {
      direction,
      amountMinor,
      currency: RUPEES,
      account: account!,
      date,
      // Printed in capitals by the bank; kept as the bank prints it, without its case.
      reference: references[0]!.toUpperCase(),
      counterparty,
      balanceMinor,
      sentAt,
    },
  };
};

export const hdfcAlerts: BankAlertFormat = {
  key: "hdfc",
  bank: "HDFC Bank",
  sends: isHdfcAlertSender,
  names: (bank) => /\bhdfc\b/i.test(bank),
  read: readHdfcAlert,
};
