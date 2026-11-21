import type { KinMailAddress, KinOwnerClientService } from "@t3tools/contracts";
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
/** The most one activity read takes from a mailbox; the next read goes on from where it stopped. */
export const ACTIVITY_MAIL = 100;
export const ACTIVITY_EVENTS = 200;

export type MailActivity = {
  /** Where the vendor's change feed stopped, for the next read; null for a vendor that keeps none. */
  readonly cursor: string | null;
  /** Set when a read stopped at its bound: what came before this time was read whole. */
  readonly until?: number;
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

/** A message the vendor's own change record named in the Inbox: its ids, nothing else. */
export type MailChange = { readonly messageId: string; readonly threadId: string | null };
/** One page of the Inbox's change record; `expired` when the vendor no longer knows `position`. */
export type MailChanges =
  | { readonly _tag: "expired" }
  | {
      readonly _tag: "read";
      readonly changes: ReadonlyArray<MailChange>;
      /** Where the next read starts. */
      readonly position: string;
      /** More pages wait at `position`. */
      readonly more: boolean;
    };
/** A new message's headers, read once by id; never its body. */
export type MailArrival = {
  readonly messageId: string;
  readonly threadId: string;
  /** When the vendor received it, its own clock. */
  readonly receivedAt: number;
  readonly from: string | null;
  readonly fromAddress: string | null;
  readonly to: ReadonlyArray<string>;
  readonly cc: ReadonlyArray<string>;
  readonly deliveredTo: ReadonlyArray<string>;
  readonly subject: string;
  readonly date: string | null;
  /** The RFC 5322 Message-ID, the same in every mailbox that got the message. */
  readonly internetId: string | null;
  readonly authResults: ReadonlyArray<string>;
  readonly listUnsubscribe: boolean;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
  /** The vendor filed it as bulk (Gmail's Promotions, Social or Forums). */
  readonly bulk: boolean;
  readonly hasFile: boolean;
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

export type MailFile = {
  readonly name: string;
  readonly type: string;
  readonly bytes: number | null;
};

/** One message as a vendor's mapping reads it. The shared tools see mail only through this. */
export type MailMessage = {
  readonly threadId: string;
  /** The sender as the mail shows it, such as `Ana <ana@example.com>`. */
  readonly from: string | null;
  readonly fromAddress: string | null;
  readonly to: ReadonlyArray<string>;
  readonly replyTo: ReadonlyArray<string>;
  readonly toLine: string | null;
  readonly ccLine: string | null;
  /** Every address it was delivered to, so the tools can say which of the account's got it. */
  readonly deliveredTo: ReadonlyArray<string>;
  readonly date: string | null;
  readonly subject: string;
  /** Plain text. */
  readonly preview: string;
  readonly unread: boolean;
  readonly messageId: string | null;
  readonly references: string | null;
  readonly authResults: ReadonlyArray<string>;
  /** Only on a whole read of the thread. */
  readonly body: { readonly text: string; readonly attachments: ReadonlyArray<MailFile> } | null;
};

export type MailCalendarEvent = {
  readonly eventId: string;
  readonly summary: string | null;
  readonly start: string | null;
  readonly end: string | null;
  readonly allDay: boolean;
  readonly location: string | null;
  readonly organizer: string | null;
  readonly guests: ReadonlyArray<{
    readonly email: string | null;
    readonly name: string | null;
    readonly response: string | null;
  }>;
  /** `cancelled` for a cancelled or deleted event. */
  readonly status: string | null;
  readonly notes: string;
  readonly meeting: string | null;
  readonly updated: string | null;
};

/** Threads, newest first, each with its messages oldest first. */
export type MailThreads = ReadonlyArray<ReadonlyArray<MailMessage>>;

export type MailContext = {
  readonly http: HttpClient.HttpClient;
  readonly token: string;
  readonly mailbox: Mailbox;
};

/**
 * The few words in Kin's mail tool descriptions that name a vendor's own things. Everything else
 * an agent reads about mail is the same for every vendor.
 */
export type MailToolWords = {
  /** "this account", or with the service named, "this Outlook account". */
  readonly account: string;
  readonly threads: string;
  readonly thread: string;
  readonly aThread: string;
  /** The thread word alone, in "in the same thread". */
  readonly sameThread: string;
  /** The search words and an example: "Gmail search words, for example …". */
  readonly search: string;
  readonly calendarEvents: string;
  readonly calendar: string;
  readonly mainCalendar: string;
  /** Who emails the invitations. */
  readonly inviter: string;
};

/**
 * What a mail vendor brings: a small descriptor and its API mapping. Tools, arguments, errors,
 * cutting and limits are Kin's own, the same for every vendor (`MailTools.ts`), and each vendor
 * passes the one case table in `MailVendors.test.ts`.
 */
export interface MailVendor {
  readonly preset: KinOwnerClientService;
  /** Also the label of an account the owner didn't name. */
  readonly name: string;
  readonly mailService: string;
  readonly calendarService: string;
  /** What a 403 most likely means, said after "<name> refused (403).". */
  readonly refused: string;
  readonly words: MailToolWords;
  readonly signIn: {
    readonly server: AuthServer;
    readonly scope: string;
    readonly extra: Readonly<Record<string, string>>;
  };
  readonly canSend: (granted: string | undefined) => boolean;
  /** A page of threads: the inbox when `query` is null, else what the vendor's search found. */
  readonly threads: (
    context: MailContext,
    page: { readonly query: string | null; readonly max: number; readonly pageToken?: string },
  ) => Call<{ readonly threads: MailThreads; readonly nextPage: string | null }>;
  /** A thread's messages, oldest first, bodies included; none when the account hasn't it. */
  readonly thread: (
    context: MailContext,
    threadId: string,
    files: boolean,
  ) => Call<ReadonlyArray<MailMessage>>;
  readonly events: (
    context: MailContext,
    query: {
      readonly timeMin: string;
      readonly timeMax: string;
      readonly query?: string;
      readonly calendarId?: string;
      readonly max: number;
      readonly pageToken?: string;
    },
  ) => Call<{
    readonly events: ReadonlyArray<MailCalendarEvent>;
    readonly nextPage: string | null;
  }>;
  readonly event: (
    context: MailContext,
    calendarId: string | undefined,
    eventId: string,
  ) => Call<MailCalendarEvent>;
  /**
   * Inbox mail that arrived and events that changed, were cancelled or deleted since `since`,
   * each occurrence of a series on its own. `cursor` is what the last read returned. A read holds
   * at most `ACTIVITY_MAIL` threads and `ACTIVITY_EVENTS` events; one that stops there sets `until`.
   */
  readonly activity: (
    context: MailContext,
    since: number,
    cursor: string | null,
    now: number,
  ) => Call<{
    readonly threads: MailThreads;
    readonly events: ReadonlyArray<MailCalendarEvent>;
    readonly cursor: string | null;
    readonly until?: number;
  }>;
  /** Where the Inbox's change record stands now, so a feed starts from here. */
  readonly mailStart: (context: MailContext, now: number) => Call<string>;
  /** The Inbox's change record after `position`: ids only, one page. */
  readonly changes: (context: MailContext, position: string) => Call<MailChanges>;
  /** One message's headers; null when the account no longer has it. */
  readonly arrival: (context: MailContext, messageId: string) => Call<MailArrival | null>;
  readonly account: MailProvider["account"];
  readonly sendAs: MailProvider["sendAs"];
  readonly sendMessage: MailProvider["sendMessage"];
  readonly saveEvent: MailProvider["saveEvent"];
}

/**
 * One mail provider as the rest of Kin uses it, built from a vendor by `mailProvider`. Everything
 * else about accounts is the same for each: the provider only signs in, lists its tools, reads,
 * and sends what the owner confirmed.
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
    /** Whether one account may sign in with a client of its own. */
    readonly accountClient: boolean;
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
    cursor: string | null,
    now: number,
  ) => Call<MailActivity>;
  /** The arrival feed's reads (`arrivals/ArrivalFeed.ts`): server use only, metadata only. */
  readonly mailStart: (http: HttpClient.HttpClient, token: string, now: number) => Call<string>;
  readonly changes: (
    http: HttpClient.HttpClient,
    token: string,
    position: string,
  ) => Call<MailChanges>;
  readonly arrival: (
    http: HttpClient.HttpClient,
    token: string,
    messageId: string,
  ) => Call<MailArrival | null>;
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
