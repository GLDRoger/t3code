import type { MailArrival, MailAutomation } from "./MailProvider.ts";
import { senderVerdictForAddress, looksLikeSignInMail } from "./MailText.ts";

const AUTOMATED_SENDER =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|news(?:letter)?|marketing|digest|alerts?|updates?)(?:[+._-]|@)/i;
const NO_REPLY_SENDER = /^(?:no-?reply|do-?not-?reply|donotreply)(?:[+._-]|@)/i;
const BULK_DOMAIN = /@(?:em|email|mail|mailer|bounce|news|newsletter|marketing|send|e)\d*\./i;

export const automationOf = (mail: MailAutomation, from: string) => {
  const autoSubmitted = mail.autoSubmitted?.split(";", 1)[0]?.trim().toLowerCase();
  if (autoSubmitted === "no") return undefined;
  if (
    autoSubmitted ||
    /^\s*(?:bulk|junk)\s*$/i.test(mail.precedence ?? "") ||
    (mail.listUnsubscribe && NO_REPLY_SENDER.test(from))
  )
    return "notice";
  if (mail.bulk || AUTOMATED_SENDER.test(from) || BULK_DOMAIN.test(from)) return "automated";
  return undefined;
};

const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
export const normalizeAddress = (value: string | null | undefined) => {
  const address = value?.trim().toLowerCase();
  return address !== undefined && address.length <= 254 && address.match(ADDRESS)?.[0] === address
    ? address
    : undefined;
};

/** A reply or forward cannot be authorized as a fresh message from a sender. */
export const isReplyOrForward = (subject: string) => /^\s*(?:re|fwd?)\s*:/i.test(subject);

const verifiedBillingAddress = (
  mail: Pick<MailArrival, "from" | "fromAddress" | "subject" | "authResults">,
) => {
  const address = normalizeAddress(mail.fromAddress);
  if (
    address === undefined ||
    isReplyOrForward(mail.subject) ||
    (mail.from?.match(ADDRESS) ?? []).some((written) => written.toLowerCase() !== address) ||
    senderVerdictForAddress(mail.authResults, address) !== "passed"
  )
    return undefined;
  return address;
};

const BILL_WORD =
  /(?<![\p{L}\p{M}\p{N}_])(?:invoice|receipt|bill|statement|payment|order|renewal)(?![\p{L}\p{M}\p{N}_])/iu;

/** The address and subject hint after checking only what arrived in the message headers. */
export const billingHint = (mail: Omit<MailArrival, "hasBillFile">) => {
  const address = verifiedBillingAddress(mail);
  if (
    address === undefined ||
    looksLikeSignInMail(mail.subject, "") ||
    automationOf(mail, address) === undefined
  )
    return undefined;
  return { address, billSubject: BILL_WORD.test(mail.subject) };
};

export const isBillFile = (name: string | undefined, mimeType: string | undefined) => {
  if (!name?.trim() || mimeType === undefined) return false;
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return mime === "application/pdf" || mime?.startsWith("image/") === true;
};
