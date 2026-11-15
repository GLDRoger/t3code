import { McpSchema } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { KinGatewayError } from "./McpGateway.ts";
import {
  addressesIn,
  firstLines,
  isPlainAddress,
  MAIL_TOOL,
  type MailEvent,
  type Mailbox,
  type MailProvider,
  ownAddress,
  quoteOf,
  receivedAmong,
} from "./MailProvider.ts";
import { looksLikeSignInMail, messageBody, senderCheck, htmlToText, WITHHELD } from "./MailText.ts";
import type { AuthServer } from "./OAuth.ts";
import type { ListedTool } from "./Pinning.ts";

/** Google's sign-in, fixed: Kin uses the owner's own Web client, never discovery. */
export const GOOGLE_SERVER: AuthServer = {
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  registrationEndpoint: undefined,
  issParameter: false,
  basicOnly: false,
};
/** What sending needs; a sign-in from before Kin sent anything lacks these. */
const GOOGLE_SEND_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
];
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  ...GOOGLE_SEND_SCOPES,
].join(" ");
export const canSend = (granted: string | undefined) => {
  const scopes = new Set((granted ?? "").split(/\s+/));
  return GOOGLE_SEND_SCOPES.every((scope) => scopes.has(scope));
};
/**
 * Ask for a refresh token every time: Google gives one only with consent shown. The account
 * chooser comes first, so the owner picks which of his Google accounts this one is.
 */
export const GOOGLE_AUTH_EXTRA = {
  access_type: "offline",
  prompt: "select_account consent",
} as const;

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
export const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars";

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const max = (limit: number) => ({
  type: "integer",
  minimum: 1,
  maximum: limit,
  description: `At most ${limit}.`,
});
const pageToken = { type: "string", description: "The nextPage value of the previous answer." };
const calendarId = {
  type: "string",
  description: "A calendar id; the owner's main calendar when left out.",
};

/** Kin's own Google tools: reads only, each pinned like any server's tools. */
export const GOOGLE_TOOLS: ReadonlyArray<ListedTool> = [
  {
    name: MAIL_TOOL.list,
    title: "List mail",
    description:
      "List recent mail threads in this account's inbox, newest first. Each says which account it is in and which of its addresses received it.",
    inputSchema: { type: "object", properties: { max: max(25), pageToken } },
  },
  {
    name: MAIL_TOOL.search,
    title: "Search mail",
    description:
      "Search this account's mail with Gmail search words, for example from:ana@example.com newer_than:7d is:unread. With several Google accounts, connection google searches them all.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, max: max(25), pageToken },
      required: ["query"],
    },
  },
  {
    name: MAIL_TOOL.read,
    title: "Read a mail thread",
    description:
      "Read one mail thread in this account: each message's sender, recipients, date, subject and text, and which of the account's addresses received it.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  },
  {
    name: MAIL_TOOL.events,
    title: "List calendar events",
    description:
      "List calendar events between two times, soonest first. Without times, the next 7 days.",
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
    description: "Read one calendar event in full: time, place, guests and notes.",
    inputSchema: {
      type: "object",
      properties: { eventId: { type: "string" }, calendarId },
      required: ["eventId"],
    },
  },
].map(({ name, ...rest }) => ({
  name,
  definition: { name, ...rest, annotations: read },
  openWorld: false,
}));

const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
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

/** Kin's own Google tools that send: every call is a card the owner confirms. */
export const GOOGLE_SEND_TOOLS: ReadonlyArray<ListedTool> = [
  {
    name: MAIL_TOOL.send,
    title: "Send an email",
    description:
      "Send a new plain-text email from this Gmail account. Pick the account, and from among its addresses, by what each is for. Nothing is sent until the owner taps Confirm on a card showing it in full.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "One of this account's addresses (kin_connection_tools lists them); its main address when left out.",
        },
        to: addresses(10, "Who it goes to; at least one."),
        cc: addresses(10, "Who gets a copy."),
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
    description:
      "Reply in a mail thread of this account, to whoever wrote last. It goes from the address the mail was sent to, in the same thread, quoting the last message. Nothing is sent until the owner taps Confirm on a card showing it in full.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        body: { type: "string", maxLength: 20_000, description: "Plain text, in full." },
        cc: addresses(10, "Who else gets a copy."),
        attachments,
      },
      required: ["threadId", "body"],
    },
  },
  {
    name: MAIL_TOOL.saveEvent,
    title: "Add or change a calendar event",
    description:
      "Add an event to this account's calendar, or change one with eventId, and send the invitations from it. Nothing is saved until the owner taps Confirm on a card showing it.",
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
        invitees: addresses(50, "Who is invited; Google emails each one."),
      },
      required: ["title", "start", "end"],
    },
  },
].map(({ name, ...rest }) => ({
  name,
  definition: { name, ...rest, annotations: write },
  openWorld: false,
}));

export const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
export const text = (value: unknown) => (typeof value === "string" ? value : undefined);
export const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const arg = (args: Readonly<Record<string, unknown>>, name: string) => text(args[name])?.trim();
const limit = (args: Readonly<Record<string, unknown>>, top: number, fallback: number) => {
  const value = Number(args.max);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, top) : fallback;
};

const failure = (reason: KinGatewayError["reason"], message: string) =>
  new KinGatewayError({ reason, message });

/** One Google API call; its error text is Google's, so only the status reaches anyone. */
export const api = Effect.fn("KinGoogle.api")(function* (
  http: HttpClient.HttpClient,
  token: string,
  url: string,
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>> = {},
  write?: { readonly method: "POST" | "PATCH"; readonly json: unknown },
) {
  const base =
    write === undefined
      ? HttpClientRequest.get(url)
      : HttpClientRequest.make(write.method)(url).pipe(
          HttpClientRequest.bodyJsonUnsafe(write.json),
        );
  const request = base.pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.setUrlParams(
      Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
      ) as Record<string, string | ReadonlyArray<string>>,
    ),
  );
  const response = yield* http
    .execute(request)
    .pipe(Effect.mapError(() => failure("unreachable", "Kin couldn't reach Google.")));
  if (response.status === 401)
    return yield* failure("key_refused", "Google refused the sign-in (401).");
  if (response.status === 403)
    return yield* failure(
      "unreachable",
      "Google refused (403). The Gmail or Calendar API may be off in the Google Cloud project.",
    );
  if (response.status === 404)
    return yield* failure("protocol", "Google has nothing with that id (404).");
  if (response.status === 429)
    return yield* failure("unreachable", "Google says Kin is asking too often (429).");
  if (response.status !== 200)
    return yield* failure(
      "unreachable",
      `Google answered with an error (HTTP ${response.status}).`,
    );
  return yield* response.json.pipe(
    Effect.mapError(() => failure("protocol", "Google sent an answer Kin couldn't read.")),
  );
});

const headerValues = (message: unknown, name: string) =>
  list(field(message, "payload", "headers"))
    .filter((header) => text(field(header, "name"))?.toLowerCase() === name.toLowerCase())
    .flatMap((header) => text(field(header, "value")) ?? []);
export const header = (message: unknown, name: string) => headerValues(message, name)[0] ?? null;

/** Whether the account itself sent this message, from any of its addresses. */
const sentByMailbox = (mailbox: Mailbox, message: unknown) =>
  addressesIn(header(message, "From")).some((address) => ownAddress(mailbox, address));
/** Which of the account's addresses this message was sent to, as the account knows it. */
const receivedBy = (mailbox: Mailbox, message: unknown) =>
  receivedAmong(
    mailbox,
    ["To", "Cc", "X-Original-To", "Delivered-To"].flatMap((name) =>
      headerValues(message, name).flatMap(addressesIn),
    ),
  );
const RECIPIENT_HEADERS = ["To", "Cc", "Delivered-To", "X-Original-To"];

const threadSummary = (mailbox: Mailbox) => (thread: unknown) => {
  const messages = list(field(thread, "messages"));
  const first = messages[0];
  const last = messages.at(-1);
  const incoming = messages.findLast((message) => !sentByMailbox(mailbox, message)) ?? last;
  const subject = header(first, "Subject") ?? "";
  const snippet = text(field(last, "snippet")) ?? "";
  return {
    threadId: text(field(thread, "id")) ?? "",
    account: mailbox.account,
    receivedBy: receivedBy(mailbox, incoming),
    subject,
    from: header(last, "From"),
    date: header(last, "Date"),
    messages: messages.length,
    unread: messages.some((message) => list(field(message, "labelIds")).includes("UNREAD")),
    preview: looksLikeSignInMail(subject, snippet) ? WITHHELD : decodeHtmlSnippet(snippet),
  };
};
const decodeHtmlSnippet = (snippet: string) => htmlToText(snippet);

const threadMetadata = (http: HttpClient.HttpClient, token: string, id: string) =>
  api(http, token, `${GMAIL}/threads/${encodeURIComponent(id)}`, {
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date", ...RECIPIENT_HEADERS],
  });

const listThreads = Effect.fn("KinGoogle.listThreads")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  params: {
    readonly q?: string;
    readonly labelIds?: string;
    readonly max: number;
    readonly pageToken?: string;
  },
) {
  const page = yield* api(http, token, `${GMAIL}/threads`, {
    q: params.q,
    labelIds: params.labelIds,
    maxResults: String(params.max),
    pageToken: params.pageToken,
  });
  const ids = list(field(page, "threads")).flatMap((thread) => text(field(thread, "id")) ?? []);
  const threads = yield* Effect.forEach(
    ids,
    (id) => threadMetadata(http, token, id).pipe(Effect.map(threadSummary(mailbox))),
    { concurrency: 5 },
  );
  return {
    account: mailbox.account,
    threads,
    nextPage: text(field(page, "nextPageToken")) ?? null,
  };
});

const MESSAGE_CHARS = 12_000;

const readThread = Effect.fn("KinGoogle.readThread")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  threadId: string,
) {
  const thread = yield* api(http, token, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
    format: "full",
  });
  const all = list(field(thread, "messages"));
  const incoming = all.findLast((message) => !sentByMailbox(mailbox, message)) ?? all.at(-1);
  const messages = all.map((message) => {
    const subject = header(message, "Subject") ?? "";
    const body = messageBody(field(message, "payload"));
    const cut = body.text.length > MESSAGE_CHARS;
    return {
      from: header(message, "From"),
      to: header(message, "To"),
      cc: header(message, "Cc"),
      date: header(message, "Date"),
      subject,
      senderCheck: senderCheck(headerValues(message, "Authentication-Results")),
      text: looksLikeSignInMail(subject, body.text)
        ? WITHHELD
        : cut
          ? `${body.text.slice(0, MESSAGE_CHARS)}\n[cut: ${body.text.length - MESSAGE_CHARS} more characters]`
          : body.text,
      attachments: body.attachments,
    };
  });
  return {
    threadId,
    account: mailbox.account,
    receivedBy: incoming === undefined ? mailbox.account : receivedBy(mailbox, incoming),
    messages,
  };
});

const eventSummary = (event: unknown) => ({
  eventId: text(field(event, "id")) ?? "",
  summary: text(field(event, "summary")) ?? null,
  start: text(field(event, "start", "dateTime")) ?? text(field(event, "start", "date")) ?? null,
  end: text(field(event, "end", "dateTime")) ?? text(field(event, "end", "date")) ?? null,
  allDay: field(event, "start", "date") !== undefined,
  location: text(field(event, "location")) ?? null,
  organizer: text(field(event, "organizer", "email")) ?? null,
  guests: list(field(event, "attendees")).length,
  status: text(field(event, "status")) ?? null,
});

const eventDetail = (event: unknown) => ({
  ...eventSummary(event),
  notes: htmlToText(text(field(event, "description")) ?? ""),
  guests: list(field(event, "attendees")).map((guest) => ({
    email: text(field(guest, "email")) ?? null,
    name: text(field(guest, "displayName")) ?? null,
    response: text(field(guest, "responseStatus")) ?? null,
  })),
  meeting: text(field(event, "hangoutLink")) ?? null,
  updated: text(field(event, "updated")) ?? null,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Runs one Google tool and answers as an MCP result, so it is cut and quoted like any other. */
export const callGoogle = Effect.fn("KinGoogle.call")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  tool: string,
  args: Readonly<Record<string, unknown>>,
  now: number,
) {
  const json = (value: unknown) =>
    new McpSchema.CallToolResult({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const need = (name: string) => {
    const value = arg(args, name);
    return value === undefined || value === ""
      ? Effect.fail(failure("protocol", `${tool} needs ${name}.`))
      : Effect.succeed(value);
  };
  switch (tool) {
    case MAIL_TOOL.list:
      return json(
        yield* listThreads(http, token, mailbox, {
          labelIds: "INBOX",
          max: limit(args, 25, 10),
          ...(arg(args, "pageToken") === undefined ? {} : { pageToken: arg(args, "pageToken")! }),
        }),
      );
    case MAIL_TOOL.search:
      return json(
        yield* listThreads(http, token, mailbox, {
          q: yield* need("query"),
          max: limit(args, 25, 10),
          ...(arg(args, "pageToken") === undefined ? {} : { pageToken: arg(args, "pageToken")! }),
        }),
      );
    case MAIL_TOOL.read:
      return json(yield* readThread(http, token, mailbox, yield* need("threadId")));
    case MAIL_TOOL.events: {
      const calendar = arg(args, "calendarId") || "primary";
      const page = yield* api(http, token, `${CALENDAR}/${encodeURIComponent(calendar)}/events`, {
        timeMin: arg(args, "timeMin") || iso(now),
        timeMax: arg(args, "timeMax") || iso(now + 7 * DAY_MS),
        q: arg(args, "query") || undefined,
        maxResults: String(limit(args, 50, 25)),
        pageToken: arg(args, "pageToken") || undefined,
        singleEvents: "true",
        orderBy: "startTime",
      });
      return json({
        account: mailbox.account,
        events: list(field(page, "items")).map(eventSummary),
        nextPage: text(field(page, "nextPageToken")) ?? null,
      });
    }
    case MAIL_TOOL.event: {
      const calendar = arg(args, "calendarId") || "primary";
      const eventId = yield* need("eventId");
      return json({
        account: mailbox.account,
        ...eventDetail(
          yield* api(
            http,
            token,
            `${CALENDAR}/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
          ),
        ),
      });
    }
    default:
      return yield* failure("protocol", `Google has no tool named ${tool}.`);
  }
});

/** The address the sign-in belongs to, shown to the owner beside the connection. */
export const googleAccount = (http: HttpClient.HttpClient, token: string) =>
  api(http, token, `${GMAIL}/profile`).pipe(
    Effect.map((profile) => text(field(profile, "emailAddress")) ?? null),
  );

/**
 * The account's From addresses: its own and each "Send mail as" alias Gmail accepted, the
 * default first. Read with the mail read scope.
 */
export const googleSendAs = Effect.fn("KinGoogle.sendAs")(function* (
  http: HttpClient.HttpClient,
  token: string,
) {
  const listed = yield* api(http, token, `${GMAIL}/settings/sendAs`);
  const addresses = list(field(listed, "sendAs")).flatMap((entry) => {
    const address = text(field(entry, "sendAsEmail"))?.trim();
    const primary = field(entry, "isPrimary") === true;
    if (address === undefined || !isPlainAddress(address)) return [];
    if (!primary && text(field(entry, "verificationStatus")) !== "accepted") return [];
    const name = text(field(entry, "displayName"))?.trim();
    return [
      {
        address,
        name: name === undefined || name === "" ? null : name.slice(0, 200),
        isDefault: field(entry, "isDefault") === true,
      },
    ];
  });
  return addresses.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault)).slice(0, 20);
});

/**
 * What changed in Google since `since` (epoch ms): mail threads that arrived in the inbox and
 * calendar events changed or cancelled. Metadata only, and still outside text.
 */
export const googleActivity = Effect.fn("KinGoogle.activity")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  since: number,
) {
  const mail = yield* listThreads(http, token, mailbox, {
    q: `in:inbox after:${Math.floor(since / 1000)}`,
    max: 25,
  });
  const events = yield* api(http, token, `${CALENDAR}/primary/events`, {
    updatedMin: iso(since),
    showDeleted: "true",
    singleEvents: "true",
    orderBy: "updated",
    maxResults: "50",
  });
  return {
    mail: mail.threads.map(({ threadId, receivedBy, subject, from, date, unread }) => ({
      threadId,
      receivedBy,
      subject,
      from,
      date,
      unread,
    })),
    calendar: list(field(events, "items")).map((event) => ({
      eventId: text(field(event, "id")) ?? "",
      summary: text(field(event, "summary")) ?? null,
      start: eventSummary(event).start,
      status: text(field(event, "status")) ?? null,
      updated: text(field(event, "updated")) ?? null,
    })),
  };
});

const LINE_BREAK = /[\r\n]/;
const MAX_RECIPIENTS = 10;

/**
 * The thread's last message from someone else: who a reply goes to, what it answers, and which of
 * the account's addresses received it. Read with the account's own token: a thread of another
 * account isn't found.
 */
const replyTarget = Effect.fn("KinGoogle.replyTarget")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  threadId: string,
) {
  const thread = yield* api(http, token, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
    format: "full",
  }).pipe(
    Effect.catchIf(
      (error) => error.reason === "protocol" && error.message.includes("404"),
      () =>
        Effect.fail(
          failure(
            "protocol",
            `${mailbox.account ?? "This account"} has no thread ${threadId.slice(0, 40)}. Reply from the account the mail is in.`,
          ),
        ),
    ),
  );
  const messages = list(field(thread, "messages"));
  if (messages.length === 0) return yield* failure("protocol", "That mail thread has no messages.");
  const mine = (message: unknown) => sentByMailbox(mailbox, message);
  const last = messages.findLast((message) => !mine(message)) ?? messages.at(-1)!;
  const to = mine(last)
    ? addressesIn(header(last, "To"))
    : [addressesIn(header(last, "Reply-To"))[0] ?? addressesIn(header(last, "From"))[0]].flatMap(
        (one) => one ?? [],
      );
  if (to.length === 0)
    return yield* failure("protocol", "Kin couldn't tell who to reply to in that thread.");
  const subject = (header(messages[0], "Subject") ?? "").replace(LINE_BREAK, " ").trim();
  const messageId = header(last, "Message-ID");
  const references = [header(last, "References"), messageId].filter((one) => one !== null);
  const who = (header(last, "From") ?? "").replace(/[\r\n]+/g, " ").trim();
  const date = header(last, "Date");
  const body = messageBody(field(last, "payload")).text;
  const withheld = looksLikeSignInMail(header(last, "Subject") ?? "", body);
  return {
    to: to.slice(0, MAX_RECIPIENTS),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: messageId,
    references: references.length === 0 ? null : references.join(" "),
    // A follow-up to the account's own message goes from the address that sent it.
    receivedAt: mine(last)
      ? (addressesIn(header(last, "From"))[0] ?? null)
      : receivedBy(mailbox, last),
    thread: {
      subject: subject.slice(0, 400),
      replyingTo: who.slice(0, 400),
      date: date === null ? null : date.slice(0, 100),
      lines: withheld ? "" : firstLines(body),
    },
    quoted: withheld || body.trim() === "" ? null : quoteOf(date, who, body),
  };
});

const sendMessage = Effect.fn("KinGoogle.sendMessage")(function* (
  http: HttpClient.HttpClient,
  token: string,
  message: { readonly raw: string; readonly threadId: string | null },
) {
  const raw = Buffer.from(message.raw).toString("base64url");
  const sent = yield* api(
    http,
    token,
    `${GMAIL}/messages/send`,
    {},
    {
      method: "POST",
      json: message.threadId === null ? { raw } : { raw, threadId: message.threadId },
    },
  );
  return {
    messageId: text(field(sent, "id")) ?? null,
    threadId: text(field(sent, "threadId")) ?? message.threadId,
    eventId: null,
  };
});

const saveEvent = Effect.fn("KinGoogle.saveEvent")(function* (
  http: HttpClient.HttpClient,
  token: string,
  event: MailEvent,
) {
  const zone = event.timeZone === null ? {} : { timeZone: event.timeZone };
  const body = {
    summary: event.title,
    start: { dateTime: event.start, ...zone },
    end: { dateTime: event.end, ...zone },
    ...(event.location === null ? {} : { location: event.location }),
    ...(event.notes === null ? {} : { description: event.notes }),
    attendees: event.invitees.map((email) => ({ email })),
  };
  const events = `${CALENDAR}/${encodeURIComponent(event.calendarId)}/events`;
  const saved = yield* api(
    http,
    token,
    event.eventId === null ? events : `${events}/${encodeURIComponent(event.eventId)}`,
    { sendUpdates: "all" },
    { method: event.eventId === null ? "POST" : "PATCH", json: body },
  );
  return { messageId: null, threadId: null, eventId: text(field(saved, "id")) ?? event.eventId };
});

/** Gmail and Google Calendar behind Kin's mail tools. */
export const googleMail: MailProvider = {
  preset: "google",
  name: "Google",
  mailService: "Gmail",
  calendarService: "Google Calendar",
  signIn: {
    server: GOOGLE_SERVER,
    scope: GOOGLE_SCOPES,
    extra: GOOGLE_AUTH_EXTRA,
    clientId: /^[\w.-]+\.apps\.googleusercontent\.com$/,
    notClient: "That isn't a Google client ID. It ends in .apps.googleusercontent.com.",
  },
  canSend,
  tools: GOOGLE_TOOLS,
  sendTools: GOOGLE_SEND_TOOLS,
  account: googleAccount,
  sendAs: googleSendAs,
  call: callGoogle,
  activity: googleActivity,
  replyTarget,
  sendMessage,
  saveEvent,
};
