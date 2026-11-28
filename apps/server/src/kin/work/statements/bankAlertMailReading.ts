import * as Effect from "effect/Effect";

import { isReplyOrForward } from "../../connections/MailSignals.ts";
import { dmarcPassedFor } from "../../connections/MailText.ts";
import type { AlertMail, AlertReading, AlertRejection } from "./bankAlerts.ts";
import type * as BankAlertReader from "./BankAlertReader.ts";
import { printedAccountEndings, verifyBankAlert } from "./bankAlertGuard.ts";

const rejected = (reason: AlertRejection): AlertReading => ({ _tag: "rejected", reason });

/** The receiving server's DMARC pass for the sender's own domain, read by the one shared parser. */
export const senderDmarcPassed = (results: ReadonlyArray<string>, address: string) =>
  dmarcPassedFor(results, address.slice(address.lastIndexOf("@") + 1));

export const authenticationRejection = (
  mail: AlertMail,
  address: string,
): "sender" | "unverified" | undefined =>
  isReplyOrForward(mail.subject)
    ? "sender"
    : senderDmarcPassed(mail.authResults, address)
      ? undefined
      : "unverified";

const MAX_TEXT = 20_000;

export const readApprovedAlert = Effect.fn("KinBankAlerts.readApproved")(function* (
  mail: AlertMail,
  address: string,
  accounts: ReadonlyArray<string>,
  fallbackCurrency: string,
  reader: BankAlertReader.BankAlertReader["Service"],
) {
  const notVouched = authenticationRejection(mail, address);
  if (notVouched !== undefined) return rejected(notVouched);
  const sentAt = mail.date === null ? Number.NaN : Date.parse(mail.date);
  if (!Number.isFinite(sentAt) || mail.text.length + mail.subject.length > MAX_TEXT)
    return rejected("unparsed");

  const printed = printedAccountEndings(mail.text);
  if (!accounts.some((account) => printed.has(account)))
    return rejected(printed.size === 0 ? "unparsed" : "other_account");

  const proposal = yield* reader.read({ subject: mail.subject, text: mail.text });
  if (proposal === "not_one_transaction") return rejected("unparsed");
  const alert = verifyBankAlert(mail.text, proposal, fallbackCurrency, sentAt);
  if (alert === null) return rejected("unparsed");
  if (!accounts.includes(alert.account)) return rejected("other_account");
  return { _tag: "alert", alert } as const;
});
