import { KIN_SIGN_IN_CLIENTS } from "@t3tools/contracts";
import { McpSchema } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import { KinGatewayError } from "./McpGateway.ts";
import {
  firstLines,
  MAIL_TOOL,
  type MailCalendarEvent,
  type MailContext,
  type Mailbox,
  type MailMessage,
  type MailProvider,
  type MailVendor,
  ownAddress,
  quoteOf,
  receivedAmong,
} from "./MailProvider.ts";
import { looksLikeSignInMail, senderCheck, WITHHELD } from "./MailText.ts";
import type { ListedTool } from "./Pinning.ts";
import { DAY_MS } from "../durations.ts";

/** Kin's mail tools, arguments, errors, cutting and limits: the same for every mail vendor. */

export const failure = (reason: KinGatewayError["reason"], message: string) =>
  new KinGatewayError({ reason, message });

/** A vendor's answer, by status: its own error text is the vendor's, so only the status is said. */
export const vendorAnswer = Effect.fn("KinMail.answer")(function* (
  vendor: Pick<MailVendor, "name" | "refused">,
  response: HttpClientResponse.HttpClientResponse,
) {
  const { name } = vendor;
  if (response.status === 401)
    return yield* failure("key_refused", `${name} refused the sign-in (401).`);
  if (response.status === 403)
    return yield* failure("unreachable", `${name} refused (403). ${vendor.refused}`);
  if (response.status === 404)
    return yield* failure("protocol", `${name} has nothing with that id (404).`);
  if (response.status === 429)
    return yield* failure("unreachable", `${name} says Kin is asking too often (429).`);
  if (response.status === 202 || response.status === 204) return undefined;
  if (response.status !== 200 && response.status !== 201)
    return yield* failure(
      "unreachable",
      `${name} answered with an error (HTTP ${response.status}).`,
    );
  return (yield* response.json.pipe(
    Effect.mapError(() => failure("protocol", `${name} sent an answer Kin couldn't read.`)),
  )) as unknown;
});
export const unreached = (vendor: Pick<MailVendor, "name">) =>
  failure("unreachable", `Kin couldn't reach ${vendor.name}.`);
/** Whether a call failed because the vendor answered this status. */
export const answeredWith = (error: KinGatewayError, status: number) =>
  error.message.includes(`(${status})`) || error.message.includes(`(HTTP ${status})`);

const MAX_RECIPIENTS = 10;
const MESSAGE_CHARS = 12_000;
const PREVIEW_CHARS = 300;
const LINE_BREAK = /[\r\n]/;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const max = (limit: number) => ({
  type: "integer",
  minimum: 1,
  maximum: limit,
  description: `At most ${limit}.`,
});
const pageToken = { type: "string", description: "The nextPage value of the previous answer." };
const addresses = (limit: number, description: string) => ({
  type: "array",
  items: { type: "string", description: "A plain address, such as ana@example.com." },
  maxItems: limit,
  description,
});
const attachments = {
  type: "array",
  items: { type: "string" },
  maxItems: 5,
  description:
    "Kin's own files to attach, by key: an invoice, quote or receipt entry (its latest PDF) or a doc key.",
};
const listed = (
  annotations: typeof read,
  tools: ReadonlyArray<{ readonly name: string } & Readonly<Record<string, unknown>>>,
): ReadonlyArray<ListedTool> =>
  tools.map(({ name, ...rest }) => ({
    name,
    definition: { name, ...rest, annotations },
    openWorld: false,
  }));

/** Reads, each pinned like any server's tools. */
const readTools = (vendor: MailVendor) => {
  const words = vendor.words;
  const calendarId = {
    type: "string",
    description: `A calendar id; ${words.mainCalendar} when left out.`,
  };
  return listed(read, [
    {
      name: MAIL_TOOL.list,
      title: "List mail",
      description: `List recent ${words.threads} in ${words.account}'s inbox, newest first. Each says which account it is in and which of its addresses received it.`,
      inputSchema: { type: "object", properties: { max: max(25), pageToken } },
    },
    {
      name: MAIL_TOOL.search,
      title: "Search mail",
      description: `Search ${words.account}'s mail with ${words.search}. With several ${vendor.name} accounts, connection ${vendor.preset} searches them all.`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, max: max(25), pageToken },
        required: ["query"],
      },
    },
    {
      name: MAIL_TOOL.read,
      title: "Read a mail thread",
      description: `Read one ${words.thread} in this account: each message's sender, recipients, date, subject and text, and which of the account's addresses received it.`,
      inputSchema: {
        type: "object",
        properties: { threadId: { type: "string" } },
        required: ["threadId"],
      },
    },
    {
      name: MAIL_TOOL.events,
      title: "List calendar events",
      description: `List ${words.calendarEvents} between two times, soonest first. Without times, the next 7 days.`,
      inputSchema: {
        type: "object",
        properties: {
          timeMin: { type: "string", format: "date-time" },
          timeMax: { type: "string", format: "date-time" },
          query: { type: "string", description: "Words to match in the events." },
          calendarId,
          max: max(50),
          pageToken,
        },
      },
    },
    {
      name: MAIL_TOOL.event,
      title: "Read a calendar event",
      description: `Read one ${words.calendar} event in full: time, place, guests and notes.`,
      inputSchema: {
        type: "object",
        properties: { eventId: { type: "string" }, calendarId },
        required: ["eventId"],
      },
    },
  ]);
};

/** The tools that send: every call is a card the owner confirms. */
const sendTools = (vendor: MailVendor) => {
  const words = vendor.words;
  const calendarId = {
    type: "string",
    description: `A calendar id; ${words.mainCalendar} when left out.`,
  };
  return listed(write, [
    {
      name: MAIL_TOOL.send,
      title: "Send an email",
      description: `Send a new plain-text email from this ${vendor.mailService} account. Pick the account, and from among its addresses, by what each is for. Nothing is sent until the owner taps Confirm on a card showing it in full.`,
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description:
              "One of this account's addresses (kin_connection_tools lists them); its main address when left out.",
          },
          to: addresses(MAX_RECIPIENTS, "Who it goes to; at least one."),
          cc: addresses(MAX_RECIPIENTS, "Who gets a copy."),
          subject: { type: "string", maxLength: 300 },
          body: { type: "string", maxLength: 20_000, description: "Plain text, in full." },
          attachments,
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: MAIL_TOOL.reply,
      title: "Reply in a mail thread",
      description: `Reply in ${words.aThread} of this account, to whoever wrote last. It goes from the address the mail was sent to, in the same ${words.sameThread}, quoting the last message. Nothing is sent until the owner taps Confirm on a card showing it in full.`,
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          body: { type: "string", maxLength: 20_000, description: "Plain text, in full." },
          cc: addresses(MAX_RECIPIENTS, "Who else gets a copy."),
          attachments,
        },
        required: ["threadId", "body"],
      },
    },
    {
      name: MAIL_TOOL.saveEvent,
      title: "Add or change a calendar event",
      description: `Add an event to this account's ${words.calendar}, or change one with eventId, and send the invitations from it. Nothing is saved until the owner taps Confirm on a card showing it.`,
      inputSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "The event to change; leave out to add one." },
          calendarId,
          title: { type: "string", maxLength: 300 },
          start: { type: "string", format: "date-time" },
          end: { type: "string", format: "date-time" },
          timeZone: { type: "string", description: "An IANA zone such as Asia/Kolkata." },
          location: { type: "string", maxLength: 500 },
          notes: { type: "string", maxLength: 8_000 },
          invitees: addresses(50, `Who is invited; ${words.inviter} emails each one.`),
        },
        required: ["title", "start", "end"],
      },
    },
  ]);
};

/** An argument as text; empty is the same as left out. */
const arg = (args: Readonly<Record<string, unknown>>, name: string) => {
  const value = typeof args[name] === "string" ? args[name].trim() : undefined;
  return value === "" ? undefined : value;
};
const limit = (args: Readonly<Record<string, unknown>>, top: number, fallback: number) => {
  const value = Number(args.max);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, top) : fallback;
};

const sentBy = (mailbox: Mailbox, message: MailMessage) =>
  message.fromAddress !== null && ownAddress(mailbox, message.fromAddress);
const receivedBy = (mailbox: Mailbox, message: MailMessage) =>
  receivedAmong(mailbox, message.deliveredTo);
/** What a message's text shows an agent: sign-in mail withheld, a long one cut with a marker. */
const shownText = (subject: string, text: string) =>
  looksLikeSignInMail(subject, text)
    ? WITHHELD
    : text.length > MESSAGE_CHARS
      ? `${text.slice(0, MESSAGE_CHARS)}\n[cut: ${text.length - MESSAGE_CHARS} more characters]`
      : text;

/** A thread in one line: its first subject, its latest sender and preview. */
const threadSummary = (mailbox: Mailbox) => (messages: ReadonlyArray<MailMessage>) => {
  const first = messages[0]!;
  const last = messages.at(-1)!;
  const incoming = messages.findLast((message) => !sentBy(mailbox, message)) ?? last;
  return {
    threadId: first.threadId,
    account: mailbox.account,
    receivedBy: receivedBy(mailbox, incoming),
    subject: first.subject,
    from: last.from,
    date: last.date,
    messages: messages.length,
    unread: messages.some((message) => message.unread),
    preview: looksLikeSignInMail(first.subject, last.preview)
      ? WITHHELD
      : last.preview.slice(0, PREVIEW_CHARS),
  };
};

const eventSummary = (event: MailCalendarEvent) => ({
  eventId: event.eventId,
  summary: event.summary,
  start: event.start,
  end: event.end,
  allDay: event.allDay,
  location: event.location,
  organizer: event.organizer,
  guests: event.guests.length,
  status: event.status,
});
const eventDetail = (event: MailCalendarEvent) => ({
  ...eventSummary(event),
  notes: event.notes,
  guests: event.guests,
  meeting: event.meeting,
  updated: event.updated,
});

/** A thread of this account, or the one answer for a thread it hasn't. */
const threadOf = (vendor: MailVendor, context: MailContext, threadId: string, files: boolean) =>
  vendor.thread(context, threadId, files).pipe(
    Effect.catchIf(
      (error) => answeredWith(error, 404),
      () => Effect.succeed([]),
    ),
    Effect.filterOrFail(
      (messages) => messages.length > 0,
      () =>
        failure(
          "protocol",
          `${context.mailbox.account ?? "This account"} has no thread ${threadId.slice(0, 40)}. Reply from the account the mail is in.`,
        ),
    ),
  );

const call = Effect.fn("KinMail.call")(function* (
  vendor: MailVendor,
  context: MailContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  now: number,
) {
  const { mailbox } = context;
  const json = (value: unknown) =>
    new McpSchema.CallToolResult({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const need = (name: string) => {
    const value = arg(args, name);
    return value === undefined
      ? Effect.fail(failure("protocol", `${tool} needs ${name}.`))
      : Effect.succeed(value);
  };
  const page = arg(args, "pageToken");
  const threads = (query: string | null) =>
    vendor
      .threads(context, {
        query,
        max: limit(args, 25, 10),
        ...(page === undefined ? {} : { pageToken: page }),
      })
      .pipe(
        Effect.map((found) => ({
          account: mailbox.account,
          threads: found.threads.filter((thread) => thread.length > 0).map(threadSummary(mailbox)),
          nextPage: found.nextPage,
        })),
      );
  switch (tool) {
    case MAIL_TOOL.list:
      return json(yield* threads(null));
    case MAIL_TOOL.search:
      return json(yield* threads(yield* need("query")));
    case MAIL_TOOL.read: {
      const threadId = yield* need("threadId");
      const all = yield* threadOf(vendor, context, threadId, true);
      const incoming = all.findLast((message) => !sentBy(mailbox, message)) ?? all.at(-1)!;
      return json({
        threadId,
        account: mailbox.account,
        receivedBy: receivedBy(mailbox, incoming),
        messages: all.map((message) => ({
          from: message.from,
          to: message.toLine,
          cc: message.ccLine,
          date: message.date,
          subject: message.subject,
          senderCheck: senderCheck(message.authResults),
          text: shownText(message.subject, message.body?.text ?? ""),
          attachments: message.body?.attachments ?? [],
        })),
      });
    }
    case MAIL_TOOL.events: {
      const query = arg(args, "query");
      const calendarId = arg(args, "calendarId");
      const found = yield* vendor.events(context, {
        timeMin: arg(args, "timeMin") ?? iso(now),
        timeMax: arg(args, "timeMax") ?? iso(now + 7 * DAY_MS),
        max: limit(args, 50, 25),
        ...(query === undefined ? {} : { query }),
        ...(calendarId === undefined ? {} : { calendarId }),
        ...(page === undefined ? {} : { pageToken: page }),
      });
      return json({
        account: mailbox.account,
        events: found.events.map(eventSummary),
        nextPage: found.nextPage,
      });
    }
    case MAIL_TOOL.event: {
      const eventId = yield* need("eventId");
      const event = yield* vendor.event(context, arg(args, "calendarId"), eventId);
      return json({ account: mailbox.account, ...eventDetail(event) });
    }
    default:
      return yield* failure("protocol", `${vendor.name} has no tool named ${tool}.`);
  }
});

/**
 * The thread's last message from someone else: who a reply goes to, what it answers, and which of
 * the account's addresses received it. Read with the account's own token: a thread of another
 * account isn't found.
 */
const replyTarget = Effect.fn("KinMail.replyTarget")(function* (
  vendor: MailVendor,
  context: MailContext,
  threadId: string,
) {
  const { mailbox } = context;
  const messages = yield* threadOf(vendor, context, threadId, false);
  const mine = (message: MailMessage) => sentBy(mailbox, message);
  const last = messages.findLast((message) => !mine(message)) ?? messages.at(-1)!;
  const to = mine(last)
    ? last.to
    : [last.replyTo[0] ?? last.fromAddress].flatMap((one) => one ?? []);
  if (to.length === 0)
    return yield* failure("protocol", "Kin couldn't tell who to reply to in that thread.");
  const subject = messages[0]!.subject.replace(LINE_BREAK, " ").trim();
  const references = [last.references, last.messageId].filter((one) => one !== null);
  const who = (last.from ?? "").replace(/[\r\n]+/g, " ").trim();
  const body = last.body?.text ?? "";
  const withheld = looksLikeSignInMail(last.subject, body);
  return {
    to: to.slice(0, MAX_RECIPIENTS),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: last.messageId,
    references: references.length === 0 ? null : references.join(" "),
    // A follow-up to the account's own message goes from the address that sent it.
    receivedAt: mine(last) ? last.fromAddress : receivedBy(mailbox, last),
    thread: {
      subject: subject.slice(0, 400),
      replyingTo: who.slice(0, 400),
      date: last.date === null ? null : last.date.slice(0, 100),
      lines: withheld ? "" : firstLines(body),
    },
    quoted: withheld || body.trim() === "" ? null : quoteOf(last.date, who, body),
  };
});

/** What changed since `since`: metadata only, and still outside text. */
const activity = Effect.fn("KinMail.activity")(function* (
  vendor: MailVendor,
  context: MailContext,
  since: number,
  cursor: string | null,
  now: number,
) {
  const found = yield* vendor.activity(context, since, cursor, now);
  return {
    mail: found.threads
      .filter((thread) => thread.length > 0)
      .map(threadSummary(context.mailbox))
      .map(({ threadId, receivedBy, subject, from, date, unread }) => ({
        threadId,
        receivedBy,
        subject,
        from,
        date,
        unread,
      })),
    calendar: found.events.map(({ eventId, summary, start, status, updated }) => ({
      eventId,
      summary,
      start,
      status,
      updated,
    })),
    cursor: found.cursor,
    ...(found.until === undefined ? {} : { until: found.until }),
  };
});

// The feed's reads name messages by id, never by which address got them.
const NO_MAILBOX: Mailbox = { account: null, addresses: [] };

/** A vendor as Kin uses it: its descriptor and mapping behind the one tool layer. */
export const mailProvider = (vendor: MailVendor): MailProvider => {
  const rule = KIN_SIGN_IN_CLIENTS[vendor.preset];
  return {
    preset: vendor.preset,
    name: vendor.name,
    mailService: vendor.mailService,
    calendarService: vendor.calendarService,
    signIn: {
      ...vendor.signIn,
      clientId: rule.clientId,
      notClient: rule.notClientId,
      accountClient: rule.accountClient,
    },
    canSend: vendor.canSend,
    tools: readTools(vendor),
    sendTools: sendTools(vendor),
    account: vendor.account,
    sendAs: vendor.sendAs,
    call: (http, token, mailbox, tool, args, now) =>
      call(vendor, { http, token, mailbox }, tool, args, now),
    activity: (http, token, mailbox, since, cursor, now) =>
      activity(vendor, { http, token, mailbox }, since, cursor, now),
    replyTarget: (http, token, mailbox, threadId) =>
      replyTarget(vendor, { http, token, mailbox }, threadId),
    mailStart: (http, token, now) => vendor.mailStart({ http, token, mailbox: NO_MAILBOX }, now),
    changes: (http, token, position) =>
      vendor.changes({ http, token, mailbox: NO_MAILBOX }, position),
    arrival: (http, token, messageId) =>
      vendor.arrival({ http, token, mailbox: NO_MAILBOX }, messageId),
    sendMessage: vendor.sendMessage,
    saveEvent: vendor.saveEvent,
  };
};
