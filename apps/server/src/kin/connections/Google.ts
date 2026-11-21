import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  ACTIVITY_EVENTS,
  ACTIVITY_MAIL,
  addressesIn,
  isPlainAddress,
  type MailCalendarEvent,
  type MailContext,
  type MailEvent,
  type MailMessage,
  type MailVendor,
} from "./MailProvider.ts";
import { htmlToText, messageBody } from "./MailText.ts";
import { mailProvider, unreached, vendorAnswer } from "./MailTools.ts";
import type { AuthServer } from "./OAuth.ts";

/** Google's sign-in, fixed: Kin uses the owner's own Web client, never discovery. */
const GOOGLE_SERVER: AuthServer = {
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
const canSend = (granted: string | undefined) => {
  const scopes = new Set((granted ?? "").split(/\s+/));
  return GOOGLE_SEND_SCOPES.every((scope) => scopes.has(scope));
};
/**
 * Ask for a refresh token every time: Google gives one only with consent shown. The account
 * chooser comes first, so the owner picks which of his Google accounts this one is.
 */
const GOOGLE_AUTH_EXTRA = {
  access_type: "offline",
  prompt: "select_account consent",
} as const;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars";

const GOOGLE = {
  name: "Google",
  refused: "The Gmail or Calendar API may be off in the Google Cloud project.",
};

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

/** One Google API call. */
const api = Effect.fn("KinGoogle.api")(function* (
  { http, token }: Pick<MailContext, "http" | "token">,
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
  const response = yield* http.execute(request).pipe(Effect.mapError(() => unreached(GOOGLE)));
  return yield* vendorAnswer(GOOGLE, response);
});

const headerValues = (message: unknown, name: string) =>
  list(field(message, "payload", "headers"))
    .filter((header) => text(field(header, "name"))?.toLowerCase() === name.toLowerCase())
    .flatMap((header) => text(field(header, "value")) ?? []);
const header = (message: unknown, name: string) => headerValues(message, name)[0] ?? null;
const RECIPIENT_HEADERS = ["To", "Cc", "X-Original-To", "Delivered-To"];

/** A Gmail message; its body only in `full` format. */
const messageOf =
  (full: boolean) =>
  (message: unknown): MailMessage => ({
    threadId: text(field(message, "threadId")) ?? "",
    from: header(message, "From"),
    fromAddress: addressesIn(header(message, "From"))[0] ?? null,
    to: addressesIn(header(message, "To")),
    replyTo: addressesIn(header(message, "Reply-To")),
    toLine: header(message, "To"),
    ccLine: header(message, "Cc"),
    deliveredTo: RECIPIENT_HEADERS.flatMap((name) =>
      headerValues(message, name).flatMap(addressesIn),
    ),
    date: header(message, "Date"),
    subject: header(message, "Subject") ?? "",
    preview: htmlToText(text(field(message, "snippet")) ?? ""),
    unread: list(field(message, "labelIds")).includes("UNREAD"),
    messageId: header(message, "Message-ID"),
    references: header(message, "References"),
    authResults: headerValues(message, "Authentication-Results"),
    body: full ? messageBody(field(message, "payload")) : null,
  });

const threadsOf = Effect.fn("KinGoogle.threads")(function* (
  context: MailContext,
  params: {
    readonly q?: string;
    readonly labelIds?: string;
    readonly max: number;
    readonly pageToken?: string;
  },
) {
  const page = yield* api(context, `${GMAIL}/threads`, {
    q: params.q,
    labelIds: params.labelIds,
    maxResults: String(params.max),
    pageToken: params.pageToken,
  });
  const threads = yield* threadsById(
    context,
    list(field(page, "threads")).flatMap((thread) => text(field(thread, "id")) ?? []),
  );
  return { threads, nextPage: text(field(page, "nextPageToken")) ?? null };
});

const threadsById = (context: MailContext, ids: ReadonlyArray<string>) =>
  Effect.forEach(
    ids,
    (id) =>
      api(context, `${GMAIL}/threads/${encodeURIComponent(id)}`, {
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date", ...RECIPIENT_HEADERS],
      }).pipe(Effect.map((thread) => list(field(thread, "messages")).map(messageOf(false)))),
    { concurrency: 5 },
  );

const eventOf = (event: unknown): MailCalendarEvent => ({
  eventId: text(field(event, "id")) ?? "",
  summary: text(field(event, "summary")) ?? null,
  start: text(field(event, "start", "dateTime")) ?? text(field(event, "start", "date")) ?? null,
  end: text(field(event, "end", "dateTime")) ?? text(field(event, "end", "date")) ?? null,
  allDay: field(event, "start", "date") !== undefined,
  location: text(field(event, "location")) ?? null,
  organizer: text(field(event, "organizer", "email")) ?? null,
  guests: list(field(event, "attendees")).map((guest) => ({
    email: text(field(guest, "email")) ?? null,
    name: text(field(guest, "displayName")) ?? null,
    response: text(field(guest, "responseStatus")) ?? null,
  })),
  status: text(field(event, "status")) ?? null,
  notes: htmlToText(text(field(event, "description")) ?? ""),
  meeting: text(field(event, "hangoutLink")) ?? null,
  updated: text(field(event, "updated")) ?? null,
});
const calendarOf = (calendarId: string | undefined) =>
  `${CALENDAR}/${encodeURIComponent(calendarId ?? "primary")}/events`;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Inbox threads since `since`, at most `ACTIVITY_MAIL`. Gmail doesn't say which end of a long
 * list it cuts, so a window holding more is halved until it fits; `until` is where it ended.
 */
const inboxSince = Effect.fn("KinGoogle.inboxSince")(function* (
  context: MailContext,
  since: number,
  now: number,
) {
  const after = Math.floor(since / 1000);
  let before = Math.ceil(now / 1000);
  while (true) {
    const page = yield* api(context, `${GMAIL}/threads`, {
      q: `in:inbox after:${after}${before * 1000 < now ? ` before:${before}` : ""}`,
      maxResults: String(ACTIVITY_MAIL),
    });
    const ids = list(field(page, "threads")).flatMap((thread) => text(field(thread, "id")) ?? []);
    const full = text(field(page, "nextPageToken")) !== undefined;
    if (full && before - after > 1) {
      before = after + Math.ceil((before - after) / 2);
      continue;
    }
    if (full) yield* Effect.logInfo("Kin read a full second of Gmail; the rest comes next read");
    return {
      threads: yield* threadsById(context, ids),
      until: before * 1000 < now ? before * 1000 : undefined,
    };
  }
});

/** Events changed since `since`, oldest change first, at most `ACTIVITY_EVENTS`. */
const eventsSince = Effect.fn("KinGoogle.eventsSince")(function* (
  context: MailContext,
  since: number,
) {
  const events: Array<MailCalendarEvent> = [];
  let pageToken: string | undefined;
  do {
    const page = yield* api(context, calendarOf(undefined), {
      updatedMin: iso(since),
      showDeleted: "true",
      singleEvents: "true",
      orderBy: "updated",
      maxResults: "50",
      pageToken,
    });
    events.push(...list(field(page, "items")).map(eventOf));
    pageToken = text(field(page, "nextPageToken"));
  } while (pageToken !== undefined && events.length < ACTIVITY_EVENTS);
  const last = Date.parse(events.at(-1)?.updated ?? "");
  return { events, until: pageToken === undefined || Number.isNaN(last) ? undefined : last };
});

/**
 * The account's From addresses: its own and each "Send mail as" alias Gmail accepted, the
 * default first. Read with the mail read scope.
 */
const googleSendAs = Effect.fn("KinGoogle.sendAs")(function* (
  http: HttpClient.HttpClient,
  token: string,
) {
  const listed = yield* api({ http, token }, `${GMAIL}/settings/sendAs`);
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

const sendMessage = Effect.fn("KinGoogle.sendMessage")(function* (
  http: HttpClient.HttpClient,
  token: string,
  message: { readonly raw: string; readonly threadId: string | null },
) {
  const raw = Buffer.from(message.raw).toString("base64url");
  const sent = yield* api(
    { http, token },
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
  const events = calendarOf(event.calendarId);
  const saved = yield* api(
    { http, token },
    event.eventId === null ? events : `${events}/${encodeURIComponent(event.eventId)}`,
    { sendUpdates: "all" },
    { method: event.eventId === null ? "POST" : "PATCH", json: body },
  );
  return { messageId: null, threadId: null, eventId: text(field(saved, "id")) ?? event.eventId };
});

const google: MailVendor = {
  preset: "google",
  name: GOOGLE.name,
  mailService: "Gmail",
  calendarService: "Google Calendar",
  refused: GOOGLE.refused,
  words: {
    account: "this account",
    threads: "mail threads",
    thread: "mail thread",
    aThread: "a mail thread",
    sameThread: "thread",
    search: "Gmail search words, for example from:ana@example.com newer_than:7d is:unread",
    calendarEvents: "calendar events",
    calendar: "calendar",
    mainCalendar: "the owner's main calendar",
    inviter: "Google",
  },
  signIn: { server: GOOGLE_SERVER, scope: GOOGLE_SCOPES, extra: GOOGLE_AUTH_EXTRA },
  canSend,
  threads: (context, page) =>
    threadsOf(context, {
      ...(page.query === null ? { labelIds: "INBOX" } : { q: page.query }),
      max: page.max,
      ...(page.pageToken === undefined ? {} : { pageToken: page.pageToken }),
    }),
  thread: (context, threadId) =>
    api(context, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, { format: "full" }).pipe(
      Effect.map((thread) => list(field(thread, "messages")).map(messageOf(true))),
    ),
  events: (context, query) =>
    api(context, calendarOf(query.calendarId), {
      timeMin: query.timeMin,
      timeMax: query.timeMax,
      q: query.query,
      maxResults: String(query.max),
      pageToken: query.pageToken,
      singleEvents: "true",
      orderBy: "startTime",
    }).pipe(
      Effect.map((page) => ({
        events: list(field(page, "items")).map(eventOf),
        nextPage: text(field(page, "nextPageToken")) ?? null,
      })),
    ),
  event: (context, calendarId, eventId) =>
    api(context, `${calendarOf(calendarId)}/${encodeURIComponent(eventId)}`).pipe(
      Effect.map(eventOf),
    ),
  // Deleted and cancelled events come back as `cancelled`; a series, one occurrence at a time.
  activity: (context, since, _cursor, now) =>
    Effect.all({
      mail: inboxSince(context, since, now),
      events: eventsSince(context, since),
    }).pipe(
      Effect.map(({ mail, events }) => {
        const until = Math.min(mail.until ?? Infinity, events.until ?? Infinity);
        return {
          threads: mail.threads,
          events: events.events,
          cursor: null,
          ...(until === Infinity ? {} : { until }),
        };
      }),
    ),
  account: (http, token) =>
    api({ http, token }, `${GMAIL}/profile`).pipe(
      Effect.map((profile) => text(field(profile, "emailAddress")) ?? null),
    ),
  sendAs: googleSendAs,
  sendMessage,
  saveEvent,
};

/** Gmail and Google Calendar behind Kin's mail tools. */
export const googleMail = mailProvider(google);
