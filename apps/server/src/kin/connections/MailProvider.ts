import type { KinMailAddress } from "@t3tools/contracts";
import type { McpSchema } from "effect/ai";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

import type { KinGatewayError } from "./McpGateway.ts";
import type { AuthServer } from "./OAuth.ts";
import type { ListedTool } from "./Pinning.ts";

/**
 * Kin's mail and calendar tools, named the same for every mail provider. Each connection is one
 * account; accounts, notes, From addresses, the card and the contact log are keyed by connection,
 * and only the calls below differ by provider.
 */
export const MAIL_TOOL = {
  list: "mail_list_threads",
  search: "mail_search",
  read: "mail_read_thread",
  send: "mail_send",
  reply: "mail_reply",
  events: "calendar_list_events",
  event: "calendar_get_event",
  saveEvent: "calendar_save_event",
} as const;
export const MAIL_SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  MAIL_TOOL.send,
  MAIL_TOOL.reply,
  MAIL_TOOL.saveEvent,
]);
/** Reads that answer for every account of a provider at once when the agent names the provider. */
export const ACROSS_ACCOUNTS: ReadonlySet<string> = new Set([
  MAIL_TOOL.list,
  MAIL_TOOL.search,
  MAIL_TOOL.events,
]);

/** The account a mail tool reads: its address and every address it sends as. */
export type Mailbox = {
  readonly account: string | null;
  readonly addresses: ReadonlyArray<string>;
};

/** What a reply answers, read from the thread with the account's own token. */
export type ReplyTarget = {
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
  /** Which of the account's addresses received the last message, so the reply goes from there. */
  readonly receivedAt: string | null;
  readonly thread: {
    readonly subject: string;
    readonly replyingTo: string;
    readonly date: string | null;
    readonly lines: string;
  };
  readonly quoted: string | null;
};

/** What arrived and changed since a time, as metadata only. */
export type MailActivity = {
  readonly mail: ReadonlyArray<{
    readonly threadId: string;
    readonly receivedBy: string | null;
    readonly subject: string;
    readonly from: string | null;
    readonly date: string | null;
    readonly unread: boolean;
  }>;
  readonly calendar: ReadonlyArray<{
    readonly eventId: string;
    readonly summary: string | null;
    readonly start: string | null;
    readonly status: string | null;
    readonly updated: string | null;
  }>;
};

export type MailEvent = {
  readonly calendarId: string;
  readonly eventId: string | null;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly notes: string | null;
  readonly invitees: ReadonlyArray<string>;
};

export type Sent = {
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly eventId: string | null;
};

type Call<A> = Effect.Effect<A, KinGatewayError>;

/**
 * One mail provider (Google first). Everything else about accounts is the same for each: the
 * provider only signs in, lists its tools, reads, and sends what the owner confirmed.
 */
export interface MailProvider {
  /** The connection preset this provider serves; also the name that reads every account. */
  readonly preset: string;
  readonly name: string;
  /** Shown on the send card: "Send this email from Gmail?". */
  readonly mailService: string;
  readonly calendarService: string;
  readonly signIn: {
    readonly server: AuthServer;
    readonly scope: string;
    readonly extra: Readonly<Record<string, string>>;
    /** Whether a client id the owner pasted is this provider's; the message when it isn't. */
    readonly clientId: RegExp;
    readonly notClient: string;
  };
  /** Whether the granted scopes allow sending; an older sign-in may lack them. */
  readonly canSend: (granted: string | undefined) => boolean;
  /** Reads, and the tools that send (always Ask me), named as in MAIL_TOOL. */
  readonly tools: ReadonlyArray<ListedTool>;
  readonly sendTools: ReadonlyArray<ListedTool>;
  /** The address the sign-in belongs to. */
  readonly account: (http: HttpClient.HttpClient, token: string) => Call<string | null>;
  /** The account's From addresses, the default first. */
  readonly sendAs: (
    http: HttpClient.HttpClient,
    token: string,
  ) => Call<ReadonlyArray<KinMailAddress>>;
  /** Runs one read tool; every item says its account and which address received it. */
  readonly call: (
    http: HttpClient.HttpClient,
    token: string,
    mailbox: Mailbox,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    now: number,
  ) => Call<McpSchema.CallToolResult>;
  readonly activity: (
    http: HttpClient.HttpClient,
    token: string,
    mailbox: Mailbox,
    since: number,
  ) => Call<MailActivity>;
  /** A thread of another account is not found: a reply stays in its own account. */
  readonly replyTarget: (
    http: HttpClient.HttpClient,
    token: string,
    mailbox: Mailbox,
    threadId: string,
  ) => Call<ReplyTarget>;
  /** Sends a whole RFC 822 message, in its thread when `threadId` is set. */
  readonly sendMessage: (
    http: HttpClient.HttpClient,
    token: string,
    message: { readonly raw: string; readonly threadId: string | null },
  ) => Call<Sent>;
  /** Adds or changes an event on the account's calendar and invites its guests. */
  readonly saveEvent: (http: HttpClient.HttpClient, token: string, event: MailEvent) => Call<Sent>;
}

const PLAIN = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;
/** Every address in a header such as `Ana <ana@example.com>, bo@example.com`. */
export const addressesIn = (value: string | null): ReadonlyArray<string> =>
  (value ?? "").split(",").flatMap((one) => {
    const inside = (/<([^<>]+)>/.exec(one)?.[1] ?? one).trim();
    return PLAIN.test(inside) ? [inside] : [];
  });
export const isPlainAddress = (value: string) => PLAIN.test(value);
export const ownAddress = (mailbox: Mailbox, address: string) =>
  mailbox.addresses.some((own) => own.toLowerCase() === address.toLowerCase()) ||
  mailbox.account?.toLowerCase() === address.toLowerCase();
/** The account's own spelling of one of its addresses, or the account when none matched. */
export const receivedAmong = (mailbox: Mailbox, recipients: ReadonlyArray<string>) => {
  const found = recipients.find((address) => ownAddress(mailbox, address));
  return found === undefined
    ? mailbox.account
    : (mailbox.addresses.find((own) => own.toLowerCase() === found.toLowerCase()) ?? found);
};

const QUOTE_CHARS = 4_000;
/** The first few lines of a message, for the card's thread box. */
export const firstLines = (body: string) =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(">"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 300);
/** The last message quoted under a reply: "On <date>, <who> wrote:" and `> ` lines. */
export const quoteOf = (date: string | null, who: string, body: string) => {
  const cut = body.length > QUOTE_CHARS ? `${body.slice(0, QUOTE_CHARS)}\n[…]` : body;
  const lines = cut
    .trimEnd()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`));
  return [`On ${date ?? "an earlier date"}, ${who} wrote:`, ...lines].join("\n");
};
