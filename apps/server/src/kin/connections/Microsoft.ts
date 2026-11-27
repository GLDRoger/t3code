import type { KinMailAddress } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import { billingHint, isBillFile } from "./MailSignals.ts";
import {
  ACTIVITY_MAIL,
  AGENDA_LIMIT,
  isPlainAddress,
  type MailAgendaEvent,
  type MailArrival,
  type MailCalendarEvent,
  type MailContext,
  type MailEvent,
  type MailMessage,
  type MailVendor,
} from "./MailProvider.ts";
import { htmlToText } from "./MailText.ts";
import {
  agendaPages,
  agendaTime,
  agendaZone,
  answeredWith,
  attachmentBytes,
  attachmentJsonLimit,
  checkMailFile,
  failure,
  httpsLink,
  mailDate,
  mailFileMimeType,
  mailFileType,
  mailProvider,
  unreached,
  safeMailFileName,
  vendorAnswer,
} from "./MailTools.ts";
import type { AuthServer } from "./OAuth.ts";
import { DAY_MS } from "../durations.ts";

/**
 * Microsoft's sign-in for work or school accounts in any organization and personal accounts.
 * A public-client app redeems the code with PKCE alone; a Web app sends its secret with it too.
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
const scopesOf = (granted: string | undefined) =>
  new Set((granted ?? "").split(/\s+/).map(scopeName));
export const microsoftReadsCalendar = (granted: string | undefined) => {
  const scopes = scopesOf(granted);
  return scopes.has("calendars.read") || scopes.has("calendars.readwrite");
};
const canSend = (granted: string | undefined) => {
  const scopes = scopesOf(granted);
  return MICROSOFT_SEND_SCOPES.every((scope) => scopes.has(scope.toLowerCase()));
};

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0/";
const GRAPH = `${GRAPH_ROOT}me`;

const MICROSOFT = {
  name: "Microsoft",
  refused: "The account may not allow this, or its organization blocked it.",
};

const field = (value: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (at, name) => (Predicate.hasProperty(at, name) ? at[name] : undefined),
    value,
  );
const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
/** An OData string literal: single quotes doubled. */
const odata = (value: string) => `'${value.replaceAll("'", "''")}'`;

type Request = {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly revision?: string;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly json?: unknown;
  /** A MIME message as Graph takes it: base64 in a text/plain body. */
  readonly mime?: string;
  readonly prefer?: string;
  readonly limit?: ReturnType<typeof attachmentJsonLimit>;
};

/** One Graph call. */
const api = Effect.fn("KinMicrosoft.api")(function* (
  { http, token }: Pick<MailContext, "http" | "token">,
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
  if (request.revision !== undefined)
    built = HttpClientRequest.setHeader(built, "if-match", request.revision);
  if (request.json !== undefined) built = HttpClientRequest.bodyJsonUnsafe(built, request.json);
  if (request.mime !== undefined)
    built = HttpClientRequest.bodyText(
      built,
      Buffer.from(request.mime).toString("base64"),
      "text/plain",
    );
  const response = yield* http.execute(built).pipe(Effect.mapError(() => unreached(MICROSOFT)));
  return yield* vendorAnswer(MICROSOFT, response, request.limit);
});

const nextPage = (page: unknown) => text(field(page, "@odata.nextLink")) ?? null;

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

const bodyText = (message: unknown) => {
  const content = text(field(message, "body", "content")) ?? "";
  return text(field(message, "body", "contentType"))?.toLowerCase() === "text"
    ? content.trim()
    : htmlToText(content);
};

const SUMMARY =
  "id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,webLink";
const FULL = `${SUMMARY},replyTo,internetMessageId,hasAttachments,body,internetMessageHeaders`;
const automationOf = (message: unknown) => ({
  listUnsubscribe: internetHeader(message, "List-Unsubscribe").length > 0,
  precedence: internetHeader(message, "Precedence")[0] ?? null,
  autoSubmitted: internetHeader(message, "Auto-Submitted")[0] ?? null,
  bulk: false,
});

const receivedOf = (message: unknown) => {
  const at = Date.parse(text(field(message, "receivedDateTime")) ?? "");
  return Number.isFinite(at) ? at : null;
};
const linkOf = (message: unknown) => {
  const id = text(field(message, "id"));
  const webLink = id ? httpsLink(text(field(message, "webLink"))) : null;
  return webLink === null ? {} : { webLink };
};
const graphFile = (file: unknown) => {
  const id = text(field(file, "id"));
  const size = field(file, "size");
  return {
    name: text(field(file, "name")) ?? "",
    type: mailFileMimeType(text(field(file, "contentType"))),
    bytes: typeof size === "number" ? size : null,
    ...(id === undefined || field(file, "@odata.type") !== "#microsoft.graph.fileAttachment"
      ? {}
      : { attachmentId: id }),
  };
};
const attachmentOf: MailVendor["attachment"] = Effect.fn("KinMicrosoft.attachment")(
  function* (context, messageId, attachmentId) {
    const messageUrl = `${GRAPH}/messages/${encodeURIComponent(messageId)}`;
    const fileUrl = `${messageUrl}/attachments/${encodeURIComponent(attachmentId)}`;
    const listed = graphFile(
      yield* api(context, fileUrl, {
        params: { $select: "id,name,contentType,size" },
        limit: { bytes: 64 * 1024, message: "Kin couldn't read that mail attachment." },
      }),
    );
    const file = { ...listed, type: mailFileType(listed.name) };
    if (file.attachmentId !== attachmentId)
      return yield* failure(
        "protocol",
        "Kin couldn't find that mail attachment. Read the thread again with mail_read_thread and use its messageId and attachmentId.",
      );
    const problem = checkMailFile(file);
    if (problem !== undefined) return yield* problem;
    const name = safeMailFileName(file.name);
    const message = yield* api(context, messageUrl, {
      params: { $select: "from,receivedDateTime" },
    });
    // Graph documents contentBytes on the plain GET; selecting a fileAttachment property isn't.
    const content = yield* api(context, fileUrl, { limit: attachmentJsonLimit(name) });
    const from = addressOf(field(message, "from"));
    return {
      name,
      mimeType: file.type,
      bytes: yield* attachmentBytes(text(field(content, "contentBytes")), file, "base64"),
      from: from !== null && isPlainAddress(from) ? from : null,
      date: mailDate(text(field(message, "receivedDateTime")) ?? null),
    };
  },
);

const messageOf = (message: unknown, files?: unknown): MailMessage => ({
  providerMessageId: text(field(message, "id")) ?? "",
  threadId: text(field(message, "conversationId")) ?? "",
  ...linkOf(message),
  from: nameOf(field(message, "from")),
  fromAddress: addressOf(field(message, "from")),
  to: recipients(message, "toRecipients"),
  replyTo: recipients(message, "replyTo"),
  toLine: recipientLine(message, "toRecipients"),
  ccLine: recipientLine(message, "ccRecipients"),
  deliveredTo: [...recipients(message, "toRecipients"), ...recipients(message, "ccRecipients")],
  date: text(field(message, "receivedDateTime")) ?? null,
  receivedAt: receivedOf(message),
  subject: text(field(message, "subject")) ?? "",
  preview: text(field(message, "bodyPreview")) ?? "",
  unread: field(message, "isRead") === false,
  messageId: text(field(message, "internetMessageId")) ?? null,
  references: internetHeader(message, "References")[0] ?? null,
  authResults: internetHeader(message, "Authentication-Results"),
  body:
    field(message, "body") === undefined
      ? null
      : {
          text: bodyText(message),
          attachments: list(field(files, "value")).map(graphFile),
        },
});

/** Graph lists messages, newest first; Kin shows conversations, each oldest message first. */
const conversations = (messages: ReadonlyArray<unknown>, max: number, watch = false) => {
  const byConversation = new Map<string, Array<MailMessage>>();
  for (const message of messages) {
    const id = text(field(message, "conversationId"));
    if (id === undefined) continue;
    const mapped = messageOf(message);
    byConversation.set(id, [
      watch ? { ...mapped, automation: automationOf(message) } : mapped,
      ...(byConversation.get(id) ?? []),
    ]);
  }
  return [...byConversation.values()].slice(0, max);
};

// Kin asks Graph for UTC, which it writes without an offset.
const instant = (value: unknown) => {
  const dateTime = text(field(value, "dateTime"));
  if (dateTime === undefined) return null;
  const zone = text(field(value, "timeZone"));
  return zone === undefined || zone.toUpperCase() === "UTC"
    ? `${dateTime.replace(/\.\d+$/, "")}Z`
    : dateTime;
};
const recurrenceOf = (event: unknown) => {
  switch (field(event, "type")) {
    case "singleInstance":
      return "single";
    case "occurrence":
    case "exception":
      return "occurrence";
    case "seriesMaster":
      return "series";
    default:
      return null;
  }
};
const eventOf = (event: unknown): MailCalendarEvent => ({
  eventId: text(field(event, "id")) ?? "",
  summary: text(field(event, "subject")) ?? null,
  start: instant(field(event, "start")),
  end: instant(field(event, "end")),
  allDay: field(event, "isAllDay") === true,
  location: text(field(event, "location", "displayName")) || null,
  organizer: addressOf(field(event, "organizer")),
  guests: list(field(event, "attendees")).map((guest) => ({
    email: addressOf(guest),
    name: text(field(guest, "emailAddress", "name")) ?? null,
    response: text(field(guest, "status", "response")) ?? null,
  })),
  // A delta round names a deleted event by its id alone.
  status:
    field(event, "@removed") !== undefined || field(event, "isCancelled") === true
      ? "cancelled"
      : "confirmed",
  notes: bodyText(event),
  meeting: text(field(event, "onlineMeeting", "joinUrl")) ?? null,
  updated: text(field(event, "lastModifiedDateTime")) ?? null,
  recurrence: recurrenceOf(event),
  revision: text(field(event, "@odata.etag")) ?? null,
  notifiesGuests: field(event, "isOrganizer") === true,
});
const agendaBoundary = (value: unknown, allDay: boolean) =>
  agendaTime(
    allDay ? text(field(value, "dateTime"))?.split("T")[0] : (instant(value) ?? undefined),
    allDay,
  );

const agendaEvent = (event: unknown): ReadonlyArray<MailAgendaEvent> => {
  const id = text(field(event, "id"));
  const allDay = field(event, "isAllDay") === true;
  const start = agendaBoundary(field(event, "start"), allDay);
  if (!id || start === null || field(event, "isCancelled") === true) return [];
  const recurrence = recurrenceOf(event);
  return [
    {
      id,
      title: text(field(event, "subject")) ?? null,
      start,
      end: agendaBoundary(field(event, "end"), allDay),
      allDay,
      zone: agendaZone(text(field(event, "originalStartTimeZone"))),
      link: httpsLink(text(field(event, "webLink"))),
      repeats: recurrence === "occurrence" || recurrence === "series",
    },
  ];
};

const EVENT_FIELDS =
  "id,subject,start,end,isAllDay,location,organizer,attendees,isCancelled,bodyPreview";
const UTC = 'outlook.timezone="UTC"';

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const calendarBase = (calendarId: string | undefined) =>
  calendarId === undefined || calendarId === "primary"
    ? GRAPH
    : `${GRAPH}/calendars/${encodeURIComponent(calendarId)}`;
/** The agent's page token is the link Graph gave; anything else starts at the first page. */
const pageOr = (pageToken: string | undefined, first: string) =>
  pageToken === undefined ? { url: first, first: true } : { url: pageToken, first: false };

const conversation = (context: MailContext, threadId: string, files: boolean) =>
  api(context, `${GRAPH}/messages`, {
    params: {
      $filter: `conversationId eq ${odata(threadId)}`,
      $select: FULL,
      $top: "50",
    },
    prefer: 'outlook.body-content-type="html"',
  }).pipe(
    Effect.flatMap((answer) =>
      Effect.forEach(
        list(field(answer, "value")).toSorted((a, b) =>
          (text(field(a, "receivedDateTime")) ?? "").localeCompare(
            text(field(b, "receivedDateTime")) ?? "",
          ),
        ),
        (message) =>
          files && field(message, "hasAttachments") === true
            ? api(
                context,
                `${GRAPH}/messages/${encodeURIComponent(text(field(message, "id")) ?? "")}/attachments`,
                { params: { $select: "id,name,contentType,size" } },
              ).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.map((found) => messageOf(message, found)),
              )
            : Effect.succeed(messageOf(message)),
        { concurrency: 4 },
      ),
    ),
  );

const singleMessage: MailVendor["message"] = Effect.fn("KinMicrosoft.message")(
  function* (context, messageId) {
    const url = `${GRAPH}/messages/${encodeURIComponent(messageId)}`;
    const message = yield* api(context, url, {
      params: { $select: FULL },
      prefer: 'outlook.body-content-type="html"',
    });
    const files =
      field(message, "hasAttachments") === true
        ? yield* api(context, `${url}/attachments`, {
            params: { $select: "id,name,contentType,size" },
          })
        : undefined;
    return messageOf(message, files);
  },
  Effect.catchIf(
    (error) => answeredWith(error, 404),
    () => Effect.succeed(null),
  ),
);

/**
 * Changed, cancelled and deleted events, each occurrence of a series on its own: Graph's delta of
 * the calendar view. Only a later round names deletions, so the cursor keeps the round's link and
 * the end of its window; a round starts again near that end or when Graph forgot it (410).
 */
const DELTA_BACK = 30 * DAY_MS;
const DELTA_AHEAD = 400 * DAY_MS;
const DELTA_PAGES = 10;
const DeltaCursor = Schema.fromJsonString(
  Schema.Struct({ link: Schema.String, until: Schema.Number }),
);
const readDeltaCursor = Schema.decodeOption(DeltaCursor);
const deltaCursor = (cursor: string | null) =>
  cursor === null ? undefined : Option.getOrUndefined(readDeltaCursor(cursor));
const deltaCursorText = Schema.encodeSync(DeltaCursor);
const calendarChanges = Effect.fn("KinMicrosoft.calendarChanges")(function* (
  context: MailContext,
  since: number,
  cursor: string | null,
) {
  const round = Effect.fn("KinMicrosoft.deltaRound")(function* (
    held: { readonly link: string; readonly until: number } | undefined,
  ) {
    const until = held?.until ?? since + DELTA_AHEAD;
    let url = held?.link ?? `${GRAPH}/calendarView/delta`;
    let params: Request["params"] =
      held === undefined ? { startDateTime: iso(since - DELTA_BACK), endDateTime: iso(until) } : {};
    const events: Array<unknown> = [];
    let link = held?.link;
    for (let page = 0; page < DELTA_PAGES; page++) {
      const answer = yield* api(context, url, {
        params,
        prefer: `${UTC}, odata.maxpagesize=50`,
      });
      events.push(...list(field(answer, "value")));
      const delta = text(field(answer, "@odata.deltaLink"));
      const next = text(field(answer, "@odata.nextLink"));
      link = delta ?? next ?? link;
      if (delta !== undefined || next === undefined) break;
      if (page === DELTA_PAGES - 1)
        yield* Effect.logInfo("Kin read its most calendar pages; the next read goes on from there");
      url = next;
      params = {};
    }
    return {
      events,
      cursor: link === undefined ? null : deltaCursorText({ link, until }),
    };
  });
  const held = deltaCursor(cursor);
  const found = yield* held === undefined || held.until - DELTA_BACK < since
    ? round(undefined)
    : round(held).pipe(
        Effect.catchIf(
          (error) => answeredWith(error, 410),
          () => round(undefined),
        ),
      );
  return {
    events: found.events
      .filter(
        (event) =>
          field(event, "@removed") !== undefined ||
          Date.parse(text(field(event, "lastModifiedDateTime")) ?? "") >= since,
      )
      .map(eventOf),
    cursor: found.cursor,
  };
});

/**
 * Inbox mail since `since`, oldest first, at most `ACTIVITY_MAIL` messages; a read that stops
 * there says until when it read everything.
 */
const inboxSince = Effect.fn("KinMicrosoft.inboxSince")(function* (
  context: MailContext,
  since: number,
) {
  const messages: Array<unknown> = [];
  let url = `${GRAPH}/mailFolders/inbox/messages`;
  let params: Request["params"] = {
    $filter: `receivedDateTime ge ${iso(since)}`,
    $orderby: "receivedDateTime asc",
    $select: `${SUMMARY},internetMessageHeaders`,
    $top: "50",
  };
  let next: string | undefined;
  do {
    const answer = yield* api(context, url, { params });
    messages.push(...list(field(answer, "value")));
    next = text(field(answer, "@odata.nextLink"));
    url = next ?? url;
    params = {};
  } while (next !== undefined && messages.length < ACTIVITY_MAIL);
  const last = Date.parse(text(field(messages.at(-1), "receivedDateTime")) ?? "");
  return {
    threads: conversations(messages.toReversed(), Infinity, true),
    until: next === undefined || Number.isNaN(last) ? undefined : last,
  };
});

const INBOX_DELTA = `${GRAPH}/mailFolders/inbox/messages/delta`;
const DELTA_PAGE = "odata.maxpagesize=50";
const ARRIVAL_FIELDS =
  "id,conversationId,receivedDateTime,from,toRecipients,ccRecipients,subject,hasAttachments,internetMessageId,internetMessageHeaders";

/**
 * A new round of the Inbox's delta that starts now: Graph documents `$deltatoken=latest` only for
 * directory resources, so the first round asks for mail received after now, which is none.
 */
const inboxStart = Effect.fn("KinMicrosoft.inboxStart")(function* (
  context: MailContext,
  now: number,
) {
  let url = INBOX_DELTA;
  let params: Request["params"] = {
    changeType: "created",
    $select: "id",
    $filter: `receivedDateTime gt ${iso(now)}`,
  };
  for (let page = 0; page < DELTA_PAGES; page++) {
    const answer = yield* api(context, url, { params, prefer: DELTA_PAGE });
    const delta = text(field(answer, "@odata.deltaLink"));
    if (delta !== undefined) return delta;
    const next = text(field(answer, "@odata.nextLink"));
    if (next === undefined) break;
    url = next;
    params = {};
  }
  return yield* failure("protocol", "Microsoft didn't say where its mail changes start.");
});

/** One page of the Inbox's delta at a link Graph gave; 410 is Graph's own reset. */
const inboxChanges = Effect.fn("KinMicrosoft.inboxChanges")(function* (
  context: MailContext,
  position: string,
) {
  const page = yield* api(context, position, { prefer: DELTA_PAGE }).pipe(
    Effect.map((answer) => ({ answer, expired: false })),
    Effect.catchIf(
      (error) => answeredWith(error, 410),
      () => Effect.succeed({ answer: undefined, expired: true }),
    ),
  );
  if (page.expired) return { _tag: "expired" } as const;
  const next = text(field(page.answer, "@odata.nextLink"));
  const delta = text(field(page.answer, "@odata.deltaLink"));
  const at = next ?? delta;
  if (at === undefined)
    return yield* failure("protocol", "Microsoft sent an answer Kin couldn't read.");
  return {
    _tag: "read",
    // A removed entry left the Inbox; a moved-in one comes back as created and is judged by date.
    changes: list(field(page.answer, "value")).flatMap((entry) => {
      const messageId = text(field(entry, "id"));
      return messageId === undefined || field(entry, "@removed") !== undefined
        ? []
        : [{ messageId, threadId: text(field(entry, "conversationId")) ?? null }];
    }),
    position: at,
    more: next !== undefined,
  } as const;
});

/** Graph's delta doesn't carry `internetMessageHeaders`, so each new message is read once. */
const arrivalOf = Effect.fn("KinMicrosoft.arrival")(function* (
  context: MailContext,
  messageId: string,
  partHints: (arrival: MailArrival) => boolean = () => true,
) {
  const url = `${GRAPH}/messages/${encodeURIComponent(messageId)}`;
  const found = yield* api(context, url, {
    params: { $select: ARRIVAL_FIELDS },
  }).pipe(
    Effect.map((message) => ({ message, gone: false })),
    Effect.catchIf(
      (error) => answeredWith(error, 404),
      () => Effect.succeed({ message: null, gone: true }),
    ),
  );
  if (found.gone) return null;
  const { message } = found;
  const receivedAt = Date.parse(text(field(message, "receivedDateTime")) ?? "");
  const threadId = text(field(message, "conversationId"));
  if (
    text(field(message, "id")) !== messageId ||
    threadId === undefined ||
    Number.isNaN(receivedAt)
  )
    return yield* failure("protocol", "Microsoft sent an answer Kin couldn't read.");
  const from = field(message, "from");
  const fromAddress = addressOf(from);
  const arrival = {
    messageId,
    threadId,
    receivedAt,
    from: fromAddress === null ? null : nameOf(from),
    fromAddress,
    to: recipients(message, "toRecipients"),
    cc: recipients(message, "ccRecipients"),
    deliveredTo: [...recipients(message, "toRecipients"), ...recipients(message, "ccRecipients")],
    subject: text(field(message, "subject")) ?? "",
    date: text(field(message, "receivedDateTime")) ?? null,
    internetId: text(field(message, "internetMessageId")) ?? null,
    authResults: internetHeader(message, "Authentication-Results"),
    ...automationOf(message),
    hasFile: field(message, "hasAttachments") === true,
  } satisfies MailArrival;
  if (!partHints(arrival)) return arrival;
  const billing = billingHint(arrival);
  if (!arrival.hasFile || billing === undefined || billing.billSubject) return arrival;
  const attachments = yield* api(context, `${url}/attachments`, {
    params: { $select: "name,contentType" },
  });
  const hasBillFile = list(field(attachments, "value")).some(
    (part) =>
      field(part, "@odata.type") === "#microsoft.graph.fileAttachment" &&
      isBillFile(text(field(part, "name")), text(field(part, "contentType"))),
  );
  return hasBillFile ? { ...arrival, hasBillFile: true as const } : arrival;
});

const profile = (http: HttpClient.HttpClient, token: string) =>
  api({ http, token }, GRAPH, {
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
  const context = { http, token };
  // A new mail goes as a draft first, so its conversation is known for a later reply in it.
  if (message.threadId === null) {
    const draft = yield* api(context, `${GRAPH}/messages`, { method: "POST", mime: message.raw });
    const id = text(field(draft, "id"));
    if (id === undefined)
      return yield* failure("protocol", "Microsoft didn't keep the mail to send.");
    yield* api(context, `${GRAPH}/messages/${encodeURIComponent(id)}/send`, { method: "POST" });
    return {
      messageId: null,
      threadId: text(field(draft, "conversationId")) ?? null,
      eventId: null,
    };
  }
  const answered = inReplyToOf(message.raw);
  const found =
    answered === null
      ? undefined
      : yield* api(context, `${GRAPH}/messages`, {
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
  yield* api(context, `${GRAPH}/messages/${encodeURIComponent(id)}/reply`, {
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
  const base = calendarBase(event.calendarId);
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
    { http, token },
    event.eventId === null
      ? `${base}/events`
      : `${base}/events/${encodeURIComponent(event.eventId)}`,
    { method: event.eventId === null ? "POST" : "PATCH", json: body },
  );
  return { messageId: null, threadId: null, eventId: text(field(saved, "id")) ?? event.eventId };
});

const microsoft: MailVendor = {
  preset: "microsoft",
  name: MICROSOFT.name,
  mailService: "Outlook",
  calendarService: "Outlook Calendar",
  refused: MICROSOFT.refused,
  words: {
    account: "this Outlook account",
    threads: "conversations",
    thread: "Outlook conversation",
    aThread: "an Outlook conversation",
    sameThread: "conversation",
    search:
      "Outlook search words, for example from:ana@example.com subject:invoice received>=2026-11-01",
    calendarEvents: "this account's Outlook calendar events",
    calendar: "Outlook calendar",
    mainCalendar: "the account's main calendar",
    inviter: "Outlook",
  },
  signIn: {
    server: MICROSOFT_SERVER,
    scope: MICROSOFT_SCOPES,
    extra: { prompt: "select_account" },
  },
  canSend,
  readsCalendar: microsoftReadsCalendar,
  threads: (context, page) => {
    const at = pageOr(
      page.pageToken,
      page.query === null ? `${GRAPH}/mailFolders/inbox/messages` : `${GRAPH}/messages`,
    );
    return api(context, at.url, {
      params: at.first
        ? {
            $select: page.headersOnly ? "id,conversationId,from,receivedDateTime" : SUMMARY,
            // Several messages can share a conversation, so a page reads more than it shows.
            $top: String(Math.min(page.max * 3, 75)),
            ...(page.query === null
              ? { $orderby: "receivedDateTime desc" }
              : { $search: `"${page.query.replace(/[\\"]/g, (char) => `\\${char}`)}"` }),
          }
        : {},
    }).pipe(
      Effect.map((answer) => ({
        threads: conversations(list(field(answer, "value")), page.max),
        nextPage: nextPage(answer),
      })),
    );
  },
  attachment: attachmentOf,
  message: singleMessage,
  thread: conversation,
  agenda: (context, { from, to }) =>
    agendaPages((next) =>
      api(context, next ?? `${GRAPH}/calendarView`, {
        prefer: UTC,
        ...(next === null
          ? {
              params: {
                startDateTime: from,
                endDateTime: to,
                $top: String(AGENDA_LIMIT + 1),
                $select:
                  "id,subject,start,end,isAllDay,type,webLink,isCancelled,originalStartTimeZone",
              },
            }
          : {}),
      }).pipe(
        Effect.map((page) => ({
          events: list(field(page, "value")).flatMap(agendaEvent),
          next: nextPage(page),
        })),
      ),
    ),
  events: (context, query) => {
    const at = pageOr(query.pageToken, `${calendarBase(query.calendarId)}/calendarView`);
    return api(context, at.url, {
      params: at.first
        ? {
            startDateTime: query.timeMin,
            endDateTime: query.timeMax,
            $select: EVENT_FIELDS,
            $orderby: "start/dateTime",
            $top: String(query.max),
          }
        : {},
      prefer: UTC,
    }).pipe(
      Effect.map((answer) => {
        // calendarView has no word search, so words match what each event shows.
        const words = (query.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        return {
          events: list(field(answer, "value"))
            .filter((event) => {
              const shown = [
                text(field(event, "subject")),
                text(field(event, "location", "displayName")),
                text(field(event, "bodyPreview")),
              ]
                .join(" ")
                .toLowerCase();
              return words.every((word) => shown.includes(word));
            })
            .map(eventOf),
          nextPage: nextPage(answer),
        };
      }),
    );
  },
  event: (context, calendarId, eventId) =>
    api(context, `${calendarBase(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      prefer: `${UTC}, outlook.body-content-type="html"`,
    }).pipe(Effect.map(eventOf)),
  calendarName: (context, calendarId) =>
    api(context, calendarId === "primary" ? `${GRAPH}/calendar` : calendarBase(calendarId)).pipe(
      Effect.map((calendar) => text(field(calendar, "name")) ?? null),
    ),
  activity: (context, since, cursor) =>
    Effect.all({
      mail: inboxSince(context, since),
      calendar: calendarChanges(context, since, cursor),
    }).pipe(
      Effect.map(({ mail, calendar }) => ({
        threads: mail.threads,
        events: calendar.events,
        cursor: calendar.cursor,
        ...(mail.until === undefined ? {} : { until: mail.until }),
      })),
    ),
  mailStart: inboxStart,
  changes: inboxChanges,
  arrival: arrivalOf,
  account: (http, token) => profile(http, token).pipe(Effect.map(accountOf)),
  sendAs: microsoftSendAs,
  sendMessage,
  saveEvent,
  deleteEvent: (http, token, { calendarId, eventId, revision }) =>
    api({ http, token }, `${calendarBase(calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
      revision,
    }).pipe(Effect.as({ messageId: null, threadId: null, eventId })),
};

/** Outlook mail and calendar, for work or school and personal Microsoft accounts. */
export const microsoftMail = mailProvider(microsoft);
