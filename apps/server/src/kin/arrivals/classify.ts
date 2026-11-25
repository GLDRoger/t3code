import type { MailArrival, MailAutomation } from "../connections/MailProvider.ts";
import { looksLikeSignInMail, senderCheck } from "../connections/MailText.ts";
import { recordName } from "../work/recordRows.ts";

/**
 * What a new mail is, from its headers and Kin's own rows, in a fixed order: the first rule that
 * matches decides and its words are the reason. No word of the body is read, and nothing here
 * calls a model or the network, so a mail can't argue its way into a class.
 */
const ARRIVAL_CLASSES = [
  "own",
  "sign_in",
  "reply_to_us",
  "failed_checks",
  "names_money",
  "client",
  "known_biller",
  "automated_notice",
  "automated_file",
  "automated",
  "copied",
  "unknown_person",
  "other",
] as const;
export type ArrivalClass = (typeof ARRIVAL_CLASSES)[number];

export type ArrivalHeaders = Pick<
  MailArrival,
  | "threadId"
  | "from"
  | "fromAddress"
  | "to"
  | "cc"
  | "subject"
  | "authResults"
  | "listUnsubscribe"
  | "precedence"
  | "autoSubmitted"
  | "bulk"
  | "hasFile"
>;

export type ArrivalContact = {
  readonly key: string;
  readonly title: string;
  readonly clientId: string | null;
  readonly clientKey: string | null;
  readonly clientTitle: string | null;
};

/** Kin's rows that decide a class, read in the feed's transaction. Addresses are lower case. */
export type ArrivalRows = {
  /** Every watched account's address and each address it sends as. */
  readonly own: ReadonlySet<string>;
  /** This mailbox's threads Kin sent mail in, and the agent whose mail it was. */
  readonly sentThreads: ReadonlyMap<string, string>;
  readonly contacts: ReadonlyMap<string, ArrivalContact>;
  /** Open invoices and quotes; `unique` when no other entry shows the same issued number. */
  readonly money: ReadonlyArray<{
    readonly key: string;
    readonly list: string;
    readonly number: string | null;
    readonly unique: boolean;
  }>;
  /** Senders a bill came from that Kin filed before. */
  readonly billers: ReadonlySet<string>;
};

/** Who looks: Finance, the Chief of staff, or the agent whose mail it answers. */
type ArrivalLook = {
  readonly by: "finance" | "chief" | { readonly agentId: string };
  /** Suggested match text; the outside watch keeps its own routing. */
  readonly matched: string;
  readonly clientId?: string;
};

type Classified = {
  readonly class: ArrivalClass;
  readonly reason: string;
  readonly look?: ArrivalLook;
};

const ADDRESS = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/;
const addressOf = (who: string | null) => {
  const found = who === null ? null : ADDRESS.exec(who);
  return found === null ? undefined : (found[1] ?? found[2])!.toLowerCase();
};
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const AUTOMATED_SENDER =
  /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|news(?:letter)?|marketing|digest|alerts?|updates?)(?:[+._-]|@)/i;
const BULK_DOMAIN = /@(?:em|email|mail|mailer|bounce|news|newsletter|marketing|send|e)\d*\./i;
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

// A hint from the subject alone that reads no words from the body.
const NOTICE_SUBJECT =
  /(?<![\p{L}\p{M}\p{N}_])(?:(?<finance>declined|bounced|overdue|past due|unpaid|mandate|penalty|chargeback|payment due|tax notice|demand notice)|failed|failure|unsuccessful|disconnection|disconnected|suspended|suspension|terminated|termination|summons|action required|final notice|final reminder|legal notice|show cause)(?![\p{L}\p{M}\p{N}_])/iu;

/** Letters, digits and the joins numbers are written with: "INV/26-27/004" is not "004". */
const numberIn = (number: string, subject: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}/_.-])${escaped(number)}(?![\\p{L}\\p{N}/_-]|\\.[\\p{L}\\p{N}])`,
    "u",
  ).test(subject);
const keyIn = (key: string, subject: string) =>
  new RegExp(`(^|[^a-z0-9-])${escaped(key.toLowerCase())}($|[^a-z0-9])`).test(
    subject.toLowerCase(),
  );

/** DMARC failed, or with no DMARC pass, SPF or DKIM failed. */
const failsSenderChecks = (results: ReadonlyArray<string>) => {
  if (senderCheck(results) !== "not checked") return senderCheck(results) === "failed";
  return /\b(?:spf|dkim)=(?:fail|softfail)\b/i.test(results.join(";"));
};

const automated = (mail: MailAutomation, from: string) =>
  mail.listUnsubscribe ||
  /^\s*(?:bulk|list|junk)\b/i.test(mail.precedence ?? "") ||
  (mail.autoSubmitted !== null && !/^\s*no\b/i.test(mail.autoSubmitted)) ||
  mail.bulk ||
  AUTOMATED_SENDER.test(from) ||
  BULK_DOMAIN.test(from);

export const isAutomatedNotice = (subject: string, headers: MailAutomation, from: string | null) =>
  NOTICE_SUBJECT.test(subject) && automated(headers, from?.toLowerCase() ?? "");

const contactLine = (contact: ArrivalContact) =>
  `contact ${contact.key} ${contact.title}${contact.clientKey === null ? "" : ` of client ${contact.clientKey} ${contact.clientTitle ?? ""}`.trimEnd()}`;
const UNKNOWN_LINE = "a sender Kin doesn't know yet: maybe a new enquiry";

export const classify = (mail: ArrivalHeaders, rows: ArrivalRows): Classified => {
  const from = (mail.fromAddress ?? addressOf(mail.from) ?? "").toLowerCase();
  const to = mail.to.map((address) => address.toLowerCase());
  const cc = mail.cc.map((address) => address.toLowerCase());
  if (from !== "" && rows.own.has(from))
    return { class: "own", reason: "from one of our addresses" };
  if (looksLikeSignInMail(mail.subject, ""))
    return { class: "sign_in", reason: "sign-in or security mail; Kin doesn't read these" };
  const sender = rows.sentThreads.get(mail.threadId);
  if (sender !== undefined)
    return {
      class: "reply_to_us",
      reason: "a reply to mail we sent",
      look: { by: { agentId: sender }, matched: "a reply to mail Kin sent in this thread" },
    };
  const contact = rows.contacts.get(from);
  if (contact !== undefined && failsSenderChecks(mail.authResults)) {
    const reason = `This mail failed the sender checks for ${from}.`.slice(0, 200);
    return { class: "failed_checks", reason, look: { by: "chief", matched: reason } };
  }
  const client = contact?.clientId == null ? {} : { clientId: contact.clientId };
  const byKey = rows.money.find((row) => keyIn(row.key, mail.subject));
  const byNumber = rows.money.find(
    (row) =>
      row.number !== null && row.number.trim() !== "" && numberIn(row.number.trim(), mail.subject),
  );
  const named = byKey ?? (byNumber?.unique === true ? byNumber : undefined);
  if (named !== undefined) {
    const matched = `${named.list === "invoices" ? "invoice" : "quote"} ${recordName(named.key, named.number)}`;
    return {
      class: "names_money",
      reason: `names ${matched}`.slice(0, 200),
      look: { by: "finance", matched, ...client },
    };
  }
  if (contact !== undefined) {
    const matched = contactLine(contact);
    return {
      class: "client",
      reason: matched.slice(0, 200),
      look: { by: "chief", matched, ...client },
    };
  }
  if (from !== "" && rows.billers.has(from))
    return {
      class: "known_biller",
      reason: "a sender whose bill was filed before",
      look: { by: "finance", matched: "a sender whose bill Kin filed before" },
    };
  if (automated(mail, from)) {
    const notice = NOTICE_SUBJECT.exec(mail.subject);
    if (notice !== null) {
      const reason = `automated mail whose subject says “${notice[0]}”`.slice(0, 200);
      const by = notice.groups?.finance === undefined ? "chief" : "finance";
      return { class: "automated_notice", reason, look: { by, matched: reason } };
    }
    return mail.hasFile
      ? // Recorded, not woken for: an unknown sender's receipt costs a whole turn to say nothing.
        { class: "automated_file", reason: "automated mail with a file: maybe a bill or receipt" }
      : { class: "automated", reason: "newsletter or automated mail" };
  }
  const ours = to.find((address) => rows.own.has(address));
  if (ours === undefined && cc.some((address) => rows.own.has(address)))
    return { class: "copied", reason: "you were copied" };
  // The company's own people write from its domain; they aren't strangers.
  if (ours !== undefined && from !== "" && domainOf(from) !== domainOf(ours))
    return {
      class: "unknown_person",
      reason: "someone Kin doesn't know yet",
      look: { by: "chief", matched: UNKNOWN_LINE },
    };
  return { class: "other", reason: "no rule matched" };
};
