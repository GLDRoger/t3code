import type { KinMailAddress } from "@t3tools/contracts";
import { McpSchema } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { KinGatewayError } from "./McpGateway.ts";
import {
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
import { htmlToText, looksLikeSignInMail, senderCheck, WITHHELD } from "./MailText.ts";
import type { AuthServer } from "./OAuth.ts";
import type { ListedTool } from "./Pinning.ts";

/**
 * Microsoft's sign-in for work or school accounts in any organization and personal accounts.
 * The owner's app registration is a public client, so the code is redeemed with PKCE alone.
 */
const MICROSOFT_SERVER: AuthServer = {
  issuer: "https://login.microsoftonline.com/common/v2.0",
  authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  registrationEndpoint: undefined,
  issParameter: false,
  basicOnly: false,
};
const MICROSOFT_SEND_SCOPES = ["Mail.Send", "Calendars.ReadWrite"];
const MICROSOFT_SCOPES = [
  "offline_access",
  "openid",
  "email",
  "User.Read",
  "Mail.Read",
  ...MICROSOFT_SEND_SCOPES,
].join(" ");
// Microsoft names Graph scopes either bare or as full URIs, in any case.
const scopeName = (scope: string) =>
  scope.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase();
const canSend = (granted: string | undefined) => {
  const scopes = new Set((granted ?? "").split(/\s+/).map(scopeName));
  return MICROSOFT_SEND_SCOPES.every((scope) => scopes.has(scope.toLowerCase()));
};

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/";
const GRAPH = `${GRAPH_ROOT}me`;

const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const max = (limit: number) => ({
  type: "integer",
  minimum: 1,
  maximum: limit,
  description: `At most ${limit}.`,
});
const pageToken = { type: "string", description: "The nextPage value of the previous answer." };
const calendarId = {
  type: "string",
  description: "A calendar id; the account's main calendar when left out.",
};
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

const tools = (
  annotations: typeof read,
  list: ReadonlyArray<{ readonly name: string } & Readonly<Record<string, unknown>>>,
): ReadonlyArray<ListedTool> =>
  list.map(({ name, ...rest }) => ({
    name,
    definition: { name, ...rest, annotations },
    openWorld: false,
  }));

/** Kin's own Outlook tools: reads only, each pinned like any server's tools. */
const MICROSOFT_TOOLS = tools(read, [
  {
    name: MAIL_TOOL.list,
    title: "List mail",
    description:
      "List recent conversations in this Outlook account's inbox, newest first. Each says which account it is in and which of its addresses received it.",
    inputSchema: { type: "object", properties: { max: max(25), pageToken } },
  },
  {
    name: MAIL_TOOL.search,
    title: "Search mail",
    description:
      "Search this Outlook account's mail with Outlook search words, for example from:ana@example.com subject:invoice received>=2026-11-01. With several Microsoft accounts, connection microsoft searches them all.",
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
      "Read one Outlook conversation in this account: each message's sender, recipients, date, subject and text, and which of the account's addresses received it.",
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
      "List this account's Outlook calendar events between two times, soonest first. Without times, the next 7 days.",
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
    description: "Read one Outlook calendar event in full: time, place, guests and notes.",
    inputSchema: {
      type: "object",
      properties: { eventId: { type: "string" }, calendarId },
      required: ["eventId"],
    },
  },
]);

/** Kin's own Outlook tools that send: every call is a card the owner confirms. */
const MICROSOFT_SEND_TOOLS = tools(write, [
  {
    name: MAIL_TOOL.send,
    title: "Send an email",
    description:
      "Send a new plain-text email from this Outlook account. Pick the account, and from among its addresses, by what each is for. Nothing is sent until the owner taps Confirm on a card showing it in full.",
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
      "Reply in an Outlook conversation of this account, to whoever wrote last. It goes from the address the mail was sent to, in the same conversation, quoting the last message. Nothing is sent until the owner taps Confirm on a card showing it in full.",
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
      "Add an event to this account's Outlook calendar, or change one with eventId, and send the invitations from it. Nothing is saved until the owner taps Confirm on a card showing it.",
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
        invitees: addresses(50, "Who is invited; Outlook emails each one."),
      },
      required: ["title", "start", "end"],
    },
  },
]);

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const arg = (args: Readonly<Record<string, unknown>>, name: string) => {
  const value = text(args[name])?.trim();
  return value === "" ? undefined : value;
};
const limit = (args: Readonly<Record<string, unknown>>, top: number, fallback: number) => {
  const value = Number(args.max);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, top) : fallback;
};
const failure = (reason: KinGatewayError["reason"], message: string) =>
  new KinGatewayError({ reason, message });
/** An OData string literal: single quotes doubled. */
const odata = (value: string) => `'${value.replaceAll("'", "''")}'`;

type Request = {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly json?: unknown;
  /** A MIME message as Graph takes it: base64 in a text/plain body. */
  readonly mime?: string;
  readonly prefer?: string;
};

/** One Graph call; its error text is Microsoft's, so only the status reaches anyone. */
const api = Effect.fn("KinMicrosoft.api")(function* (
  http: HttpClient.HttpClient,
  token: string,
  url: string,
  request: Request = {},
) {
  // A page link comes back through an agent: the token only ever goes to Graph itself.
  if (!url.startsWith(GRAPH_ROOT))
    return yield* failure("protocol", "That page link isn't one Kin gave.");
  const method = request.method ?? "GET";
  let built = HttpClientRequest.make(method)(url).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(token),
  );
  const params = Object.entries(request.params ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (params.length > 0) built = HttpClientRequest.setUrlParams(built, Object.fromEntries(params));
  if (request.prefer !== undefined)
    built = HttpClientRequest.setHeader(built, "prefer", request.prefer);
  if (request.json !== undefined) built = HttpClientRequest.bodyJsonUnsafe(built, request.json);
  if (request.mime !== undefined)
    built = HttpClientRequest.bodyText(
      built,
      Buffer.from(request.mime).toString("base64"),
      "text/plain",
    );
  const response = yield* http
    .execute(built)
    .pipe(Effect.mapError(() => failure("unreachable", "Kin couldn't reach Microsoft.")));
  if (response.status === 401)
    return yield* failure("key_refused", "Microsoft refused the sign-in (401).");
  if (response.status === 403)
    return yield* failure(
      "unreachable",
      "Microsoft refused (403). The account may not allow this, or its organization blocked it.",
    );
  if (response.status === 404)
    return yield* failure("protocol", "Microsoft has nothing with that id (404).");
  if (response.status === 429)
    return yield* failure("unreachable", "Microsoft says Kin is asking too often (429).");
  if (response.status === 202 || response.status === 204) return undefined;
  if (response.status !== 200 && response.status !== 201)
    return yield* failure(
      "unreachable",
      `Microsoft answered with an error (HTTP ${response.status}).`,
    );
  return yield* response.json.pipe(
    Effect.mapError(() => failure("protocol", "Microsoft sent an answer Kin couldn't read.")),
  );
});

const nextPage = (page: unknown) => text(field(page, "@odata.nextLink")) ?? null;
/** The agent's page token is the link Graph gave; anything else starts at the first page. */
const pageOr = (args: Readonly<Record<string, unknown>>, first: string) => {
  const token = arg(args, "pageToken");
  return token === undefined ? { url: first, first: true } : { url: token, first: false };
};

const addressOf = (recipient: unknown) => text(field(recipient, "emailAddress", "address")) ?? null;
const nameOf = (recipient: unknown) => {
  const address = addressOf(recipient);
  const name = text(field(recipient, "emailAddress", "name"))
    ?.replace(/[\r\n"]+/g, " ")
    .trim();
  if (address === null) return name ?? null;
  return name === undefined || name === "" || name === address ? address : `${name} <${address}>`;
};
const recipients = (message: unknown, name: string) =>
  list(field(message, name)).flatMap((one) => addressOf(one) ?? []);
const recipientLine = (message: unknown, name: string) => {
  const all = list(field(message, name)).flatMap((one) => nameOf(one) ?? []);
  return all.length === 0 ? null : all.join(", ");
};
const internetHeader = (message: unknown, name: string) =>
  list(field(message, "internetMessageHeaders"))
    .filter((one) => text(field(one, "name"))?.toLowerCase() === name.toLowerCase())
    .flatMap((one) => text(field(one, "value")) ?? []);

const sentByMailbox = (mailbox: Mailbox, message: unknown) => {
  const from = addressOf(field(message, "from"));
  return from !== null && ownAddress(mailbox, from);
};
const receivedBy = (mailbox: Mailbox, message: unknown) =>
  receivedAmong(mailbox, [
    ...recipients(message, "toRecipients"),
    ...recipients(message, "ccRecipients"),
  ]);

const bodyText = (message: unknown) => {
  const content = text(field(message, "body", "content")) ?? "";
  return text(field(message, "body", "contentType"))?.toLowerCase() === "text"
    ? content.trim()
    : htmlToText(content);
};

const SUMMARY =
  "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview";
const FULL = `${SUMMARY},replyTo,internetMessageId,hasAttachments,body,internetMessageHeaders`;

/** Graph lists messages; Kin shows conversations, newest first, one line each. */
const threadsOf = (mailbox: Mailbox, messages: ReadonlyArray<unknown>, max: number) => {
  const byConversation = new Map<string, Array<unknown>>();
  for (const message of messages) {
    const id = text(field(message, "conversationId"));
    if (id === undefined) continue;
    byConversation.set(id, [...(byConversation.get(id) ?? []), message]);
  }
  return [...byConversation.entries()].slice(0, max).map(([threadId, group]) => {
    const last = group[0];
    const incoming = group.find((message) => !sentByMailbox(mailbox, message)) ?? last;
    const subject = text(field(last, "subject")) ?? "";
    const preview = text(field(last, "bodyPreview")) ?? "";
    return {
      threadId,
      account: mailbox.account,
      receivedBy: receivedBy(mailbox, incoming),
      subject,
      from: nameOf(field(last, "from")),
      date: text(field(last, "receivedDateTime")) ?? null,
      messages: group.length,
      unread: group.some((message) => field(message, "isRead") === false),
      preview: looksLikeSignInMail(subject, preview) ? WITHHELD : preview.slice(0, 300),
    };
  });
};

const listThreads = Effect.fn("KinMicrosoft.listThreads")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  args: Readonly<Record<string, unknown>>,
  search: string | undefined,
) {
  const max = limit(args, 25, 10);
  const page = pageOr(
    args,
    search === undefined ? `${GRAPH}/mailFolders/inbox/messages` : `${GRAPH}/messages`,
  );
  const answer = yield* api(http, token, page.url, {
    params: page.first
      ? {
          $select: SUMMARY,
          // Several messages can share a conversation, so a page reads more than it shows.
          $top: String(Math.min(max * 3, 75)),
          ...(search === undefined
            ? { $orderby: "receivedDateTime desc" }
            : { $search: `"${search.replace(/[\\"]/g, (char) => `\\${char}`)}"` }),
        }
      : {},
  });
  return {
    account: mailbox.account,
    threads: threadsOf(mailbox, list(field(answer, "value")), max),
    nextPage: nextPage(answer),
  };
});

const MESSAGE_CHARS = 12_000;

const conversation = Effect.fn("KinMicrosoft.conversation")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  threadId: string,
) {
  const answer = yield* api(http, token, `${GRAPH}/messages`, {
    params: {
      $filter: `conversationId eq ${odata(threadId)}`,
      $select: FULL,
      $top: "50",
    },
    prefer: 'outlook.body-content-type="html"',
  });
  const messages = list(field(answer, "value")).toSorted((a, b) =>
    (text(field(a, "receivedDateTime")) ?? "").localeCompare(
      text(field(b, "receivedDateTime")) ?? "",
    ),
  );
  if (messages.length === 0)
    return yield* failure(
      "protocol",
      `${mailbox.account ?? "This account"} has no thread ${threadId.slice(0, 40)}. Reply from the account the mail is in.`,
    );
  return messages;
});

const readThread = Effect.fn("KinMicrosoft.readThread")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  threadId: string,
) {
  const all = yield* conversation(http, token, mailbox, threadId);
  const incoming = all.findLast((message) => !sentByMailbox(mailbox, message)) ?? all.at(-1);
  const messages = yield* Effect.forEach(
    all,
    (message) =>
      Effect.gen(function* () {
        const subject = text(field(message, "subject")) ?? "";
        const body = bodyText(message);
        const cut = body.length > MESSAGE_CHARS;
        const files =
          field(message, "hasAttachments") === true
            ? yield* api(
                http,
                token,
                `${GRAPH}/messages/${encodeURIComponent(text(field(message, "id")) ?? "")}/attachments`,
                { params: { $select: "name,contentType,size" } },
              ).pipe(Effect.orElseSucceed(() => undefined))
            : undefined;
        return {
          from: nameOf(field(message, "from")),
          to: recipientLine(message, "toRecipients"),
          cc: recipientLine(message, "ccRecipients"),
          date: text(field(message, "receivedDateTime")) ?? null,
          subject,
          senderCheck: senderCheck(internetHeader(message, "Authentication-Results")),
          text: looksLikeSignInMail(subject, body)
            ? WITHHELD
            : cut
              ? `${body.slice(0, MESSAGE_CHARS)}\n[cut: ${body.length - MESSAGE_CHARS} more characters]`
              : body,
          attachments: list(field(files, "value")).map((file) => ({
            name: text(field(file, "name")) ?? "",
            type: text(field(file, "contentType")) ?? "unknown",
            bytes: typeof field(file, "size") === "number" ? (field(file, "size") as number) : null,
          })),
        };
      }),
    { concurrency: 4 },
  );
  return {
    threadId,
    account: mailbox.account,
    receivedBy: incoming === undefined ? mailbox.account : receivedBy(mailbox, incoming),
    messages,
  };
});

// Kin asks Graph for UTC, which it writes without an offset.
const instant = (value: unknown) => {
  const dateTime = text(field(value, "dateTime"));
  if (dateTime === undefined) return null;
  const zone = text(field(value, "timeZone"));
  return zone === undefined || zone.toUpperCase() === "UTC"
    ? `${dateTime.replace(/\.\d+$/, "")}Z`
    : dateTime;
};
const eventSummary = (event: unknown) => ({
  eventId: text(field(event, "id")) ?? "",
  summary: text(field(event, "subject")) ?? null,
  start: instant(field(event, "start")),
  end: instant(field(event, "end")),
  allDay: field(event, "isAllDay") === true,
  location: text(field(event, "location", "displayName")) || null,
  organizer: addressOf(field(event, "organizer")),
  guests: list(field(event, "attendees")).length,
  status: field(event, "isCancelled") === true ? "cancelled" : "confirmed",
});
const eventDetail = (event: unknown) => ({
  ...eventSummary(event),
  notes: bodyText(event),
  guests: list(field(event, "attendees")).map((guest) => ({
    email: addressOf(guest),
    name: text(field(guest, "emailAddress", "name")) ?? null,
    response: text(field(guest, "status", "response")) ?? null,
  })),
  meeting: text(field(event, "onlineMeeting", "joinUrl")) ?? null,
  updated: text(field(event, "lastModifiedDateTime")) ?? null,
});
const EVENT_FIELDS =
  "id,subject,start,end,isAllDay,location,organizer,attendees,isCancelled,bodyPreview";
const UTC = 'outlook.timezone="UTC"';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const calendarBase = (args: Readonly<Record<string, unknown>>) => {
  const calendar = arg(args, "calendarId");
  return calendar === undefined || calendar === "primary"
    ? GRAPH
    : `${GRAPH}/calendars/${encodeURIComponent(calendar)}`;
};

/** Runs one Outlook tool and answers as an MCP result, so it is cut and quoted like any other. */
const callMicrosoft = Effect.fn("KinMicrosoft.call")(function* (
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
    return value === undefined
      ? Effect.fail(failure("protocol", `${tool} needs ${name}.`))
      : Effect.succeed(value);
  };
  switch (tool) {
    case MAIL_TOOL.list:
      return json(yield* listThreads(http, token, mailbox, args, undefined));
    case MAIL_TOOL.search:
      return json(yield* listThreads(http, token, mailbox, args, yield* need("query")));
    case MAIL_TOOL.read:
      return json(yield* readThread(http, token, mailbox, yield* need("threadId")));
    case MAIL_TOOL.events: {
      const page = pageOr(args, `${calendarBase(args)}/calendarView`);
      const answer = yield* api(http, token, page.url, {
        params: page.first
          ? {
              startDateTime: arg(args, "timeMin") ?? iso(now),
              endDateTime: arg(args, "timeMax") ?? iso(now + 7 * DAY_MS),
              $select: EVENT_FIELDS,
              $orderby: "start/dateTime",
              $top: String(limit(args, 50, 25)),
            }
          : {},
        prefer: UTC,
      });
      // calendarView has no word search, so words match what each event shows.
      const words = (arg(args, "query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const events = list(field(answer, "value")).filter((event) => {
        const shown = [
          text(field(event, "subject")),
          text(field(event, "location", "displayName")),
          text(field(event, "bodyPreview")),
        ]
          .join(" ")
          .toLowerCase();
        return words.every((word) => shown.includes(word));
      });
      return json({
        account: mailbox.account,
        events: events.map(eventSummary),
        nextPage: nextPage(answer),
      });
    }
    case MAIL_TOOL.event: {
      const eventId = yield* need("eventId");
      return json({
        account: mailbox.account,
        ...eventDetail(
          yield* api(http, token, `${calendarBase(args)}/events/${encodeURIComponent(eventId)}`, {
            prefer: `${UTC}, outlook.body-content-type="html"`,
          }),
        ),
      });
    }
    default:
      return yield* failure("protocol", `Microsoft has no tool named ${tool}.`);
  }
});

const profile = (http: HttpClient.HttpClient, token: string) =>
  api(http, token, GRAPH, {
    params: { $select: "displayName,mail,userPrincipalName,proxyAddresses" },
  });
const accountOf = (me: unknown) => {
  const address = text(field(me, "mail")) ?? text(field(me, "userPrincipalName"));
  return address !== undefined && isPlainAddress(address) ? address : null;
};

/**
 * The account's From addresses: its primary one first, then the other addresses its
 * organization gave it. Personal accounts list only their own. Shared mailboxes aren't offered.
 */
const microsoftSendAs = Effect.fn("KinMicrosoft.sendAs")(function* (
  http: HttpClient.HttpClient,
  token: string,
) {
  const me = yield* profile(http, token);
  const name = text(field(me, "displayName"))?.trim().slice(0, 200) || null;
  const own = accountOf(me);
  const proxies = list(field(me, "proxyAddresses")).flatMap((entry) => {
    const match = /^smtp:(.+)$/i.exec(text(entry) ?? "");
    const address = match?.[1]?.trim();
    // Routing addresses on onmicrosoft.com exist in every tenant but nobody writes from them.
    return address === undefined || !isPlainAddress(address) || /\.onmicrosoft\.com$/i.test(address)
      ? []
      : [{ address, isDefault: (text(entry) ?? "").startsWith("SMTP:") }];
  });
  const addresses: Array<KinMailAddress> = [];
  for (const one of [
    ...(own === null ? [] : [{ address: own, isDefault: true }]),
    ...proxies.toSorted((a, b) => Number(b.isDefault) - Number(a.isDefault)),
  ])
    if (!addresses.some((seen) => seen.address.toLowerCase() === one.address.toLowerCase()))
      addresses.push({ address: one.address, name, isDefault: addresses.length === 0 });
  return addresses.slice(0, 20);
});

/** Mail that arrived in the inbox and calendar events changed since `since` (epoch ms). */
const microsoftActivity = Effect.fn("KinMicrosoft.activity")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  since: number,
) {
  const mail = yield* api(http, token, `${GRAPH}/mailFolders/inbox/messages`, {
    params: {
      $filter: `receivedDateTime ge ${iso(since)}`,
      $orderby: "receivedDateTime desc",
      $select: SUMMARY,
      $top: "50",
    },
  });
  const events = yield* api(http, token, `${GRAPH}/events`, {
    params: {
      $filter: `lastModifiedDateTime ge ${iso(since)}`,
      $orderby: "lastModifiedDateTime desc",
      $top: "50",
    },
    prefer: UTC,
  });
  return {
    mail: threadsOf(mailbox, list(field(mail, "value")), 25).map(
      ({ threadId, receivedBy, subject, from, date, unread }) => ({
        threadId,
        receivedBy,
        subject,
        from,
        date,
        unread,
      }),
    ),
    calendar: list(field(events, "value")).map((event) => ({
      eventId: text(field(event, "id")) ?? "",
      summary: text(field(event, "subject")) ?? null,
      start: instant(field(event, "start")),
      status: field(event, "isCancelled") === true ? "cancelled" : "confirmed",
      updated: text(field(event, "lastModifiedDateTime")) ?? null,
    })),
  };
});

const LINE_BREAK = /[\r\n]/;
const MAX_RECIPIENTS = 10;

/** The conversation's last message from someone else, read with this account's own token. */
const replyTarget = Effect.fn("KinMicrosoft.replyTarget")(function* (
  http: HttpClient.HttpClient,
  token: string,
  mailbox: Mailbox,
  threadId: string,
) {
  const messages = yield* conversation(http, token, mailbox, threadId);
  const mine = (message: unknown) => sentByMailbox(mailbox, message);
  const last = messages.findLast((message) => !mine(message)) ?? messages.at(-1)!;
  const to = mine(last)
    ? recipients(last, "toRecipients")
    : [recipients(last, "replyTo")[0] ?? addressOf(field(last, "from"))].flatMap(
        (one) => one ?? [],
      );
  if (to.length === 0)
    return yield* failure("protocol", "Kin couldn't tell who to reply to in that thread.");
  const subject = (text(field(messages[0], "subject")) ?? "").replace(LINE_BREAK, " ").trim();
  const messageId = text(field(last, "internetMessageId")) ?? null;
  const references = [internetHeader(last, "References")[0] ?? null, messageId].filter(
    (one) => one !== null,
  );
  const who = (nameOf(field(last, "from")) ?? "").replace(/[\r\n]+/g, " ").trim();
  const date = text(field(last, "receivedDateTime")) ?? null;
  const body = bodyText(last);
  const withheld = looksLikeSignInMail(text(field(last, "subject")) ?? "", body);
  return {
    to: to.slice(0, MAX_RECIPIENTS),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: messageId,
    references: references.length === 0 ? null : references.join(" "),
    receivedAt: mine(last) ? addressOf(field(last, "from")) : receivedBy(mailbox, last),
    thread: {
      subject: subject.slice(0, 400),
      replyingTo: who.slice(0, 400),
      date: date === null ? null : date.slice(0, 100),
      lines: withheld ? "" : firstLines(body),
    },
    quoted: withheld || body === "" ? null : quoteOf(date, who, body),
  };
});

/** `In-Reply-To` of a message Kin built itself, which names the message the reply answers. */
const inReplyToOf = (raw: string) =>
  /^In-Reply-To: *(\S+)\r?$/im.exec(raw.split(/\r?\n\r?\n/)[0] ?? "")?.[1] ?? null;

/**
 * A new message goes through sendMail; a reply goes through the answered message's own reply,
 * so Outlook keeps it in the conversation. Both take the message whole, as MIME.
 */
const sendMessage = Effect.fn("KinMicrosoft.sendMessage")(function* (
  http: HttpClient.HttpClient,
  token: string,
  message: { readonly raw: string; readonly threadId: string | null },
) {
  if (message.threadId === null) {
    yield* api(http, token, `${GRAPH}/sendMail`, { method: "POST", mime: message.raw });
    return { messageId: null, threadId: null, eventId: null };
  }
  const answered = inReplyToOf(message.raw);
  const found =
    answered === null
      ? undefined
      : yield* api(http, token, `${GRAPH}/messages`, {
          params: {
            $filter: `internetMessageId eq ${odata(answered)}`,
            $select: "id,conversationId",
            $top: "1",
          },
        });
  const target = list(field(found, "value")).find(
    (one) => text(field(one, "conversationId")) === message.threadId,
  );
  const id = text(field(target, "id"));
  if (id === undefined)
    return yield* failure("protocol", "Kin couldn't find the message this reply answers.");
  yield* api(http, token, `${GRAPH}/messages/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    mime: message.raw,
  });
  return { messageId: null, threadId: message.threadId, eventId: null };
});

/** Times go as the exact instant in UTC, so no zone name needs translating for Outlook. */
const utc = (when: string) => ({
  dateTime: iso(Date.parse(when)).replace(/(\.\d+)?Z$/, ""),
  timeZone: "UTC",
});

/** Outlook sends the invitations itself when an event with attendees is saved. */
const saveEvent = Effect.fn("KinMicrosoft.saveEvent")(function* (
  http: HttpClient.HttpClient,
  token: string,
  event: MailEvent,
) {
  const base =
    event.calendarId === "primary"
      ? GRAPH
      : `${GRAPH}/calendars/${encodeURIComponent(event.calendarId)}`;
  const body = {
    subject: event.title,
    start: utc(event.start),
    end: utc(event.end),
    ...(event.location === null ? {} : { location: { displayName: event.location } }),
    ...(event.notes === null ? {} : { body: { contentType: "text", content: event.notes } }),
    attendees: event.invitees.map((address) => ({
      emailAddress: { address },
      type: "required",
    })),
  };
  const saved = yield* api(
    http,
    token,
    event.eventId === null
      ? `${base}/events`
      : `${base}/events/${encodeURIComponent(event.eventId)}`,
    { method: event.eventId === null ? "POST" : "PATCH", json: body },
  );
  return { messageId: null, threadId: null, eventId: text(field(saved, "id")) ?? event.eventId };
});

/** Outlook mail and calendar, for work or school and personal Microsoft accounts. */
export const microsoftMail: MailProvider = {
  preset: "microsoft",
  name: "Microsoft",
  mailService: "Outlook",
  calendarService: "Outlook Calendar",
  signIn: {
    server: MICROSOFT_SERVER,
    scope: MICROSOFT_SCOPES,
    extra: { prompt: "select_account" },
    clientId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    notClient:
      "That isn't a Microsoft application ID. It looks like 00000000-0000-0000-0000-000000000000.",
  },
  canSend,
  tools: MICROSOFT_TOOLS,
  sendTools: MICROSOFT_SEND_TOOLS,
  account: (http, token) => profile(http, token).pipe(Effect.map(accountOf)),
  sendAs: microsoftSendAs,
  call: callMicrosoft,
  activity: microsoftActivity,
  replyTarget,
  sendMessage,
  saveEvent,
};
