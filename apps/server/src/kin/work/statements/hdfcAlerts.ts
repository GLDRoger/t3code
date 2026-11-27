import * as Effect from "effect/Effect";

import type { AlertMail, AlertReading, AlertRejection, BankAlertFormat } from "./bankAlerts.ts";
import type * as BankAlertReader from "./BankAlertReader.ts";
import { verifyBankAlert } from "./bankAlertGuard.ts";

/**
 * Only vouched-for HDFC alerts reach the shared model reader. Its proposal is checked against
 * the mail before any money can be recorded.
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

export const readHdfcAlert = Effect.fn("KinBankAlerts.readHdfc")(function* (
  mail: AlertMail,
  fallbackCurrency: string,
  reader: BankAlertReader.BankAlertReader["Service"],
) {
  const from = mail.fromAddress?.toLowerCase() ?? null;
  if (!isHdfcAlertSender(from) || /^\s*(?:re|fwd?)\s*:/i.test(mail.subject))
    return rejected("sender");
  if (!vouched(mail.authResults, domainOf(from!))) return rejected("unverified");
  const sentAt = mail.date === null ? Number.NaN : Date.parse(mail.date);
  if (!Number.isFinite(sentAt) || mail.text.length + mail.subject.length > MAX_TEXT)
    return rejected("unparsed");

  const proposal = yield* reader.read({ subject: mail.subject, text: mail.text });
  if (proposal === "not_one_transaction") return rejected("unparsed");
  const alert = verifyBankAlert(mail.text, proposal, fallbackCurrency, sentAt);
  return alert === null ? rejected("unparsed") : ({ _tag: "alert", alert } as const);
});

export const hdfcAlerts: BankAlertFormat = {
  key: "hdfc",
  bank: "HDFC Bank",
  sends: isHdfcAlertSender,
  names: (bank) => /\bhdfc\b/i.test(bank),
  read: readHdfcAlert,
};
