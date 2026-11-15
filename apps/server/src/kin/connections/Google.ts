import { McpSchema } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { KinGatewayError } from "./McpGateway.ts";
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
// Read only; write scopes are asked for when the owner first allows a write (a later update).
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
].join(" ");
/** Ask for a refresh token every time: Google gives one only with consent shown. */
export const GOOGLE_AUTH_EXTRA = { access_type: "offline", prompt: "consent" } as const;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars";

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
    name: "gmail_list_threads",
    title: "List mail",
    description: "List recent mail threads in the inbox, newest first.",
    inputSchema: { type: "object", properties: { max: max(25), pageToken } },
  },
  {
    name: "gmail_search",
    title: "Search mail",
    description:
      "Search mail with Gmail search words, for example from:ana@example.com newer_than:7d is:unread.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, max: max(25), pageToken },
      required: ["query"],
    },
  },
  {
    name: "gmail_read_thread",
    title: "Read a mail thread",
    description: "Read one mail thread: each message's sender, date, subject and text.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
    },
  },
  {
    name: "calendar_list_events",
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
    name: "calendar_get_event",
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

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const arg = (args: Readonly<Record<string, unknown>>, name: string) => text(args[name])?.trim();
const limit = (args: Readonly<Record<string, unknown>>, top: number, fallback: number) => {
  const value = Number(args.max);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, top) : fallback;
};

const failure = (reason: KinGatewayError["reason"], message: string) =>
  new KinGatewayError({ reason, message });

/** One Google API call; its error text is Google's, so only the status reaches anyone. */
const api = Effect.fn("KinGoogle.api")(function* (
  http: HttpClient.HttpClient,
  token: string,
  url: string,
  params: Readonly<Record<string, string | ReadonlyArray<string> | undefined>> = {},
) {
  const request = HttpClientRequest.get(url).pipe(
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
const header = (message: unknown, name: string) => headerValues(message, name)[0] ?? null;

const threadSummary = (thread: unknown) => {
  const messages = list(field(thread, "messages"));
  const first = messages[0];
  const last = messages.at(-1);
  const subject = header(first, "Subject") ?? "";
  const snippet = text(field(last, "snippet")) ?? "";
  return {
    threadId: text(field(thread, "id")) ?? "",
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
    metadataHeaders: ["From", "Subject", "Date"],
  });

const listThreads = Effect.fn("KinGoogle.listThreads")(function* (
  http: HttpClient.HttpClient,
  token: string,
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
    (id) => threadMetadata(http, token, id).pipe(Effect.map(threadSummary)),
    { concurrency: 5 },
  );
  return { threads, nextPage: text(field(page, "nextPageToken")) ?? null };
});

const MESSAGE_CHARS = 12_000;

const readThread = Effect.fn("KinGoogle.readThread")(function* (
  http: HttpClient.HttpClient,
  token: string,
  threadId: string,
) {
  const thread = yield* api(http, token, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
    format: "full",
  });
  const messages = list(field(thread, "messages")).map((message) => {
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
  return { threadId, messages };
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
    case "gmail_list_threads":
      return json(
        yield* listThreads(http, token, {
          labelIds: "INBOX",
          max: limit(args, 25, 10),
          ...(arg(args, "pageToken") === undefined ? {} : { pageToken: arg(args, "pageToken")! }),
        }),
      );
    case "gmail_search":
      return json(
        yield* listThreads(http, token, {
          q: yield* need("query"),
          max: limit(args, 25, 10),
          ...(arg(args, "pageToken") === undefined ? {} : { pageToken: arg(args, "pageToken")! }),
        }),
      );
    case "gmail_read_thread":
      return json(yield* readThread(http, token, yield* need("threadId")));
    case "calendar_list_events": {
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
        events: list(field(page, "items")).map(eventSummary),
        nextPage: text(field(page, "nextPageToken")) ?? null,
      });
    }
    case "calendar_get_event": {
      const calendar = arg(args, "calendarId") || "primary";
      const eventId = yield* need("eventId");
      return json(
        eventDetail(
          yield* api(
            http,
            token,
            `${CALENDAR}/${encodeURIComponent(calendar)}/events/${encodeURIComponent(eventId)}`,
          ),
        ),
      );
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
 * What changed in Google since `since` (epoch ms): mail threads that arrived in the inbox and
 * calendar events changed or cancelled. Metadata only, and still outside text.
 */
export const googleActivity = Effect.fn("KinGoogle.activity")(function* (
  http: HttpClient.HttpClient,
  token: string,
  since: number,
) {
  const mail = yield* listThreads(http, token, {
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
    mail: mail.threads.map(({ threadId, subject, from, date, unread }) => ({
      threadId,
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
