// @effect-diagnostics nodeBuiltinImport:off -- a stored file's hash, and a MIME boundary.
import * as NodeCrypto from "node:crypto";

import {
  type KinChatError,
  KinDocFile,
  type KinMailAddress,
  type KinOrgId,
  type KinSendCard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import { readStoredFile } from "../gendocs/brand.ts";
import { formatMoney } from "../work/money.ts";
import { logTouch } from "../work/touches.ts";
import { KinGatewayError } from "./McpGateway.ts";
import {
  addressesIn,
  api,
  CALENDAR,
  field,
  GMAIL,
  header,
  list,
  type Mailbox,
  receivedBy,
  sentByMailbox,
  text,
} from "./Google.ts";
import { looksLikeSignInMail, messageBody } from "./MailText.ts";

/**
 * What an "Ask me" call sends, fixed when the agent asks and shown whole on the owner's card.
 * The owner's Confirm sends exactly this; nothing is filled in or looked up again after it.
 */
const Attachment = Schema.Struct({
  key: Schema.String,
  recordId: Schema.String,
  version: Schema.Number,
  attachmentId: Schema.String,
  sha256: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  bytes: Schema.Number,
  label: Schema.NullOr(Schema.String),
  entryRecordId: Schema.NullOr(Schema.String),
});
export type Attachment = typeof Attachment.Type;
const From = Schema.Struct({ address: Schema.String, name: Schema.NullOr(Schema.String) });
export type From = typeof From.Type;
const Thread = Schema.Struct({
  subject: Schema.String,
  replyingTo: Schema.String,
  date: Schema.NullOr(Schema.String),
  lines: Schema.String,
});
export const Prepared = Schema.Union([
  Schema.TaggedStruct("email", {
    /** Missing on asks from before accounts: Gmail's default From. */
    from: Schema.optionalKey(Schema.NullOr(From)),
    to: Schema.Array(Schema.String),
    cc: Schema.Array(Schema.String),
    subject: Schema.String,
    body: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    inReplyTo: Schema.NullOr(Schema.String),
    references: Schema.NullOr(Schema.String),
    /** A reply's thread as the card shows it, and the last message quoted under the body. */
    thread: Schema.optionalKey(Schema.NullOr(Thread)),
    quoted: Schema.optionalKey(Schema.NullOr(Schema.String)),
    attachments: Schema.Array(Attachment),
  }),
  Schema.TaggedStruct("event", {
    calendarId: Schema.String,
    eventId: Schema.NullOr(Schema.String),
    title: Schema.String,
    start: Schema.String,
    end: Schema.String,
    timeZone: Schema.NullOr(Schema.String),
    location: Schema.NullOr(Schema.String),
    notes: Schema.NullOr(Schema.String),
    invitees: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("call", { args: Schema.Record(Schema.String, Schema.Unknown) }),
]);
export type Prepared = typeof Prepared.Type;
export const PreparedJson = Schema.fromJsonString(Prepared);

const decodeFile = Schema.decodeUnknownOption(Schema.fromJsonString(KinDocFile));
const refused = (message: string) => new KinGatewayError({ reason: "protocol", message });

const MAX_RECIPIENTS = 10;
const MAX_INVITEES = 50;
const MAX_BODY = 20_000;
const MAX_ATTACHMENTS = 5;
// Gmail takes the message inline as base64; a few invoices fit well inside its limit.
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
// Plain ASCII addresses only: no names, no comments, nothing a header could hide.
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const LINE_BREAK = /[\r\n]/;

const strings = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((one) => typeof one === "string").map((one) => one.trim())
    : [];
const optional = (args: Readonly<Record<string, unknown>>, name: string) => {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const checkAddresses = (values: ReadonlyArray<string>, what: string, max: number) => {
  if (values.length > max) return refused(`At most ${max} addresses in ${what}.`);
  const bad = values.find((value) => !ADDRESS.test(value));
  return bad === undefined
    ? undefined
    : refused(`${bad.slice(0, 80)} in ${what} isn't a plain address such as ana@example.com.`);
};

const docLabels: Readonly<Record<string, string>> = {
  invoices: "Invoice",
  quotes: "Quote",
  receipts: "Receipt",
};

/**
 * One of Kin's files by key: a doc, or an entry's latest made document. Read from the stored
 * version, with what the card says of it: "Invoice INV/26-27/004 · ₹1,18,000.00".
 */
export const attachmentOf = Effect.fn("KinSending.attachment")(function* (
  orgId: KinOrgId,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [found] = yield* sql<{ recordId: string; registerId: string }>`SELECT record_id AS
      "recordId", register_id AS "registerId" FROM kin_records
    WHERE org_id = ${orgId} AND key = ${key} ORDER BY record_id LIMIT 1`;
  if (found === undefined) return yield* refused(`Kin has no file or entry ${key.slice(0, 40)}.`);
  const docId =
    found.registerId === "docs"
      ? found.recordId
      : (yield* sql<{ docId: string }>`SELECT v.record_id AS "docId" FROM kin_doc_jobs j
            JOIN kin_doc_versions v ON v.org_id = j.org_id AND v.worker_id = j.worker_id
            WHERE j.org_id = ${orgId} AND j.entry_record_id = ${found.recordId}
              AND v.body_kind = 'file'
            ORDER BY v.created_at DESC, v.version DESC LIMIT 1`)[0]?.docId;
  if (docId === undefined)
    return yield* refused(`${key.slice(0, 40)} has no made document yet; make it first.`);
  const [version] = yield* sql<{
    key: string;
    version: number;
    fileJson: string | null;
    entryId: string | null;
  }>`SELECT d.key, v.version, v.file_json AS "fileJson",
      (SELECT j.entry_record_id FROM kin_doc_jobs j
        WHERE j.org_id = v.org_id AND j.worker_id = v.worker_id) AS "entryId"
    FROM kin_doc_versions v JOIN kin_records d ON d.org_id = v.org_id AND d.record_id = v.record_id
    WHERE v.org_id = ${orgId} AND v.record_id = ${docId}
    ORDER BY v.version DESC LIMIT 1`;
  const file =
    version?.fileJson == null ? undefined : Option.getOrUndefined(decodeFile(version.fileJson));
  if (version === undefined || file === undefined)
    return yield* refused(`${key.slice(0, 40)} is not a file Kin made, so it can't be attached.`);
  const [entry] =
    version.entryId === null
      ? []
      : yield* sql<{
          registerId: string;
          amountMinor: number | null;
          currency: string | null;
        }>`SELECT register_id AS "registerId", amount_minor AS "amountMinor", currency
          FROM kin_records WHERE org_id = ${orgId} AND record_id = ${version.entryId}`;
  const noun = entry === undefined ? undefined : docLabels[entry.registerId];
  const label =
    noun === undefined
      ? null
      : [
          `${noun}${file.number === null ? "" : ` ${file.number}`}${file.draft ? " (draft)" : ""}`,
          entry?.amountMinor == null || entry.currency === null
            ? undefined
            : formatMoney({ minor: entry.amountMinor, currency: entry.currency }),
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  return {
    key: version.key,
    recordId: docId,
    version: version.version,
    attachmentId: file.attachmentId,
    sha256: file.sha256,
    name: file.name,
    mimeType: file.mimeType,
    bytes: file.bytes,
    label,
    entryRecordId: version.entryId,
  } satisfies Attachment;
});

const attachmentsOf = Effect.fn("KinSending.attachments")(function* (
  orgId: KinOrgId,
  keys: ReadonlyArray<string>,
) {
  if (keys.length > MAX_ATTACHMENTS) return yield* refused(`At most ${MAX_ATTACHMENTS} files.`);
  const found = yield* Effect.forEach([...new Set(keys)], (key) => attachmentOf(orgId, key));
  if (found.reduce((sum, one) => sum + one.bytes, 0) > MAX_ATTACHMENT_BYTES)
    return yield* refused("Those files are too large to send together by mail.");
  return found;
});

/** Whether every attached file is still the version the card showed. */
export const attachmentsCurrent = Effect.fn("KinSending.current")(function* (
  orgId: KinOrgId,
  prepared: Prepared,
) {
  if (prepared._tag !== "email") return true;
  for (const shown of prepared.attachments) {
    const now = yield* attachmentOf(orgId, shown.key).pipe(Effect.option);
    if (
      Option.isNone(now) ||
      now.value.version !== shown.version ||
      now.value.sha256 !== shown.sha256
    )
      return false;
  }
  return true;
});

/** One of the account's addresses, with its From name; the default when `wanted` is null. */
export const fromOf = (
  account: string | null,
  sendAs: ReadonlyArray<KinMailAddress>,
  wanted: string | null,
): From | undefined => {
  const own =
    sendAs.length > 0
      ? sendAs
      : account === null
        ? []
        : [{ address: account, name: null, isDefault: true }];
  const found =
    wanted === null
      ? (own.find((one) => one.isDefault) ?? own[0])
      : own.find((one) => one.address.toLowerCase() === wanted.toLowerCase());
  return found === undefined ? undefined : { address: found.address, name: found.name };
};

const QUOTE_CHARS = 4_000;
const firstLines = (body: string) =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith(">"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 300);
/** The last message as Gmail quotes it under a reply: "On <date>, <who> wrote:" and `> ` lines. */
const quoteOf = (date: string | null, who: string, body: string) => {
  const cut = body.length > QUOTE_CHARS ? `${body.slice(0, QUOTE_CHARS)}\n[…]` : body;
  const lines = cut
    .trimEnd()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`));
  return [`On ${date ?? "an earlier date"}, ${who} wrote:`, ...lines].join("\n");
};

/**
 * The thread's last message from someone else: who a reply goes to, what it answers, and which of
 * the account's addresses received it, so the reply goes from there. Read with the account's own
 * token: a thread of another account isn't found.
 */
const replyTarget = Effect.fn("KinSending.replyTarget")(function* (
  http: HttpClient.HttpClient,
  token: string,
  threadId: string,
  mailbox: Mailbox,
) {
  const thread = yield* api(http, token, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
    format: "full",
  }).pipe(
    Effect.catchIf(
      (error) => error.reason === "protocol" && error.message.includes("404"),
      () =>
        Effect.fail(
          refused(
            `${mailbox.account ?? "This account"} has no thread ${threadId.slice(0, 40)}. Reply from the account the mail is in.`,
          ),
        ),
    ),
  );
  const messages = list(field(thread, "messages"));
  if (messages.length === 0) return yield* refused("That mail thread has no messages.");
  const mine = (message: unknown) => sentByMailbox(mailbox, message);
  const last = messages.findLast((message) => !mine(message)) ?? messages.at(-1)!;
  const to = mine(last)
    ? addressesIn(header(last, "To"))
    : [addressesIn(header(last, "Reply-To"))[0] ?? addressesIn(header(last, "From"))[0]].flatMap(
        (one) => one ?? [],
      );
  if (to.length === 0) return yield* refused("Kin couldn't tell who to reply to in that thread.");
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

/** What a Google send tool would send, checked and filled in from the thread it answers. */
export const prepareGoogle = Effect.fn("KinSending.prepareGoogle")(function* (input: {
  readonly http: HttpClient.HttpClient;
  readonly token: Effect.Effect<string, KinGatewayError | KinChatError>;
  readonly orgId: KinOrgId;
  readonly account: string | null;
  readonly sendAs: ReadonlyArray<KinMailAddress>;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}) {
  const { args } = input;
  const mailbox: Mailbox = {
    account: input.account,
    addresses: input.sendAs.map((one) => one.address),
  };
  if (input.tool === "calendar_save_event") {
    const title = optional(args, "title");
    const start = optional(args, "start");
    const end = optional(args, "end");
    if (title === null || start === null || end === null)
      return yield* refused("calendar_save_event needs title, start and end.");
    if ([start, end].some((when) => Number.isNaN(Date.parse(when))))
      return yield* refused("start and end are date-times such as 2026-11-20T15:00:00+05:30.");
    if (Date.parse(end) <= Date.parse(start)) return yield* refused("end is after start.");
    const invitees = strings(args.invitees);
    const bad = checkAddresses(invitees, "invitees", MAX_INVITEES);
    if (bad !== undefined) return yield* bad;
    return {
      _tag: "event",
      calendarId: optional(args, "calendarId") ?? "primary",
      eventId: optional(args, "eventId"),
      title: title.slice(0, 300),
      start,
      end,
      timeZone: optional(args, "timeZone"),
      location: optional(args, "location"),
      notes: optional(args, "notes"),
      invitees,
    } satisfies Prepared;
  }
  const body = typeof args.body === "string" ? args.body : "";
  if (body.trim() === "") return yield* refused(`${input.tool} needs body.`);
  if (body.length > MAX_BODY) return yield* refused(`The body is at most ${MAX_BODY} characters.`);
  const cc = strings(args.cc);
  const badCc = checkAddresses(cc, "cc", MAX_RECIPIENTS);
  if (badCc !== undefined) return yield* badCc;
  const attachments = yield* attachmentsOf(input.orgId, strings(args.attachments));
  if (input.tool === "gmail_reply") {
    const threadId = optional(args, "threadId");
    if (threadId === null) return yield* refused("gmail_reply needs threadId.");
    if (optional(args, "from") !== null)
      return yield* refused("A reply goes from the address the mail was sent to; leave from out.");
    const target = yield* replyTarget(input.http, yield* input.token, threadId, mailbox);
    const from =
      fromOf(input.account, input.sendAs, target.receivedAt) ??
      fromOf(input.account, input.sendAs, null) ??
      null;
    return {
      _tag: "email",
      from,
      to: target.to,
      cc,
      subject: target.subject,
      body,
      threadId,
      inReplyTo: target.inReplyTo,
      references: target.references,
      thread: target.thread,
      quoted: target.quoted,
      attachments,
    } satisfies Prepared;
  }
  if (input.tool !== "gmail_send") return yield* refused(`Google has no tool named ${input.tool}.`);
  const to = strings(args.to);
  if (to.length === 0) return yield* refused("gmail_send needs to.");
  const badTo = checkAddresses(to, "to", MAX_RECIPIENTS);
  if (badTo !== undefined) return yield* badTo;
  const subject = optional(args, "subject");
  if (subject === null) return yield* refused("gmail_send needs subject.");
  if (LINE_BREAK.test(subject) || subject.length > 300)
    return yield* refused("The subject is one line of at most 300 characters.");
  const wanted = optional(args, "from");
  const from = fromOf(input.account, input.sendAs, wanted);
  if (from === undefined && wanted !== null)
    return yield* refused(
      `${wanted.slice(0, 80)} isn't one of ${input.account ?? "this account"}'s addresses: ${
        input.sendAs.map((one) => one.address).join(", ") || input.account || "none known"
      }.`,
    );
  return {
    _tag: "email",
    from: from ?? null,
    to,
    cc,
    subject,
    body,
    threadId: null,
    inReplyTo: null,
    references: null,
    thread: null,
    quoted: null,
    attachments,
  } satisfies Prepared;
});

const when = (prepared: Extract<Prepared, { _tag: "event" }>) =>
  `When: ${prepared.start} to ${prepared.end}${prepared.timeZone === null ? "" : ` (${prepared.timeZone})`}`;

/** One From the owner may switch a send card to; `id` names it in the switch. */
export type FromChoice = NonNullable<KinSendCard["fromChoices"]>[number];
export const choiceId = (connectionId: string, address: string) => `${connectionId} ${address}`;
const fromLine = (from: From) =>
  from.name === null ? from.address : `${from.name} <${from.address}>`;

/** The card: everything that goes, as it goes. */
export const sendCard = (input: {
  readonly service: string;
  readonly account: string | null;
  readonly tool: string;
  readonly prepared: Prepared;
  readonly choices?: ReadonlyArray<FromChoice>;
}): { readonly question: string; readonly detail: string; readonly send: KinSendCard } => {
  const { prepared } = input;
  if (prepared._tag === "email") {
    const reply = prepared.threadId !== null;
    const from = prepared.from ?? null;
    const thread = prepared.thread ?? null;
    const quoted = prepared.quoted ?? null;
    return {
      question: reply ? "Send this reply from Gmail?" : "Send this email from Gmail?",
      detail: [
        ...(from === null ? [] : [`From: ${fromLine(from)}`]),
        ...(input.account === null ? [] : [`Account: ${input.account}`]),
        `To: ${prepared.to.join(", ")}`,
        ...(prepared.cc.length === 0 ? [] : [`Cc: ${prepared.cc.join(", ")}`]),
        `Subject: ${prepared.subject}`,
        ...prepared.attachments.map((one) => `Attached: ${one.name}`),
      ]
        .join("\n")
        .slice(0, 2000),
      send: {
        service: "Gmail",
        action: reply ? "reply" : "email",
        from: from?.address ?? input.account,
        fromName: from?.name ?? null,
        account: input.account,
        ...(input.choices === undefined || input.choices.length < 2
          ? {}
          : { fromChoices: input.choices.slice(0, 30) }),
        ...(thread === null ? {} : { thread }),
        quoted,
        to: prepared.to,
        cc: prepared.cc,
        subject: prepared.subject,
        body: prepared.body,
        attachments: prepared.attachments.map((one) => ({
          name: one.name,
          label: one.label,
          bytes: one.bytes,
        })),
        outcome: null,
      },
    };
  }
  if (prepared._tag === "event") {
    const body = [
      when(prepared),
      ...(prepared.location === null ? [] : [`Where: ${prepared.location}`]),
      ...(prepared.notes === null ? [] : ["", prepared.notes]),
    ].join("\n");
    return {
      question:
        prepared.eventId === null
          ? "Add this event and send the invitations?"
          : "Change this event and tell the guests?",
      detail: [`Event: ${prepared.title}`, when(prepared)].join("\n").slice(0, 2000),
      send: {
        service: "Google Calendar",
        action: "event",
        from: input.account,
        account: input.account,
        to: prepared.invitees,
        cc: [],
        subject: prepared.title,
        body,
        attachments: [],
        outcome: null,
      },
    };
  }
  const args = JSON.stringify(prepared.args, null, 2);
  return {
    question: `Run ${input.tool} on ${input.service}?`.slice(0, 240),
    detail: args.slice(0, 2000),
    send: {
      service: input.service.slice(0, 80),
      action: "call",
      from: input.account,
      to: [],
      cc: [],
      subject: input.tool,
      body: args,
      attachments: [],
      outcome: null,
    },
  };
};
/** The most a call's arguments may hold and still show whole on its card. */
export const MAX_CARD_ARGS = MAX_BODY;

const base64Lines = (bytes: Uint8Array) =>
  (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
const encodedWord = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
const fileName = (name: string) => name.replace(/["\\\r\n]/g, "_");
const fromHeader = (from: From) => {
  const name = (from.name ?? "").replace(/["\\\r\n]/g, "").trim();
  if (name === "") return from.address;
  return /^[\x20-\x7e]*$/.test(name)
    ? `"${name}" <${from.address}>`
    : `${encodedWord(name)} <${from.address}>`;
};
/** What goes as the text: the body, then the quoted message under it. */
const sentText = (prepared: Extract<Prepared, { _tag: "email" }>) =>
  prepared.quoted == null ? prepared.body : `${prepared.body}\n\n${prepared.quoted}`;

/** The message as Gmail takes it: plain text, then each file, in one multipart. */
const mime = (
  prepared: Extract<Prepared, { _tag: "email" }>,
  files: ReadonlyArray<{ readonly attachment: Attachment; readonly bytes: Uint8Array }>,
) => {
  const boundary = `kin_${NodeCrypto.randomBytes(12).toString("hex")}`;
  const headers = [
    ...(prepared.from == null ? [] : [`From: ${fromHeader(prepared.from)}`]),
    `To: ${prepared.to.join(", ")}`,
    ...(prepared.cc.length === 0 ? [] : [`Cc: ${prepared.cc.join(", ")}`]),
    `Subject: ${encodedWord(prepared.subject)}`,
    ...(prepared.inReplyTo === null ? [] : [`In-Reply-To: ${prepared.inReplyTo}`]),
    ...(prepared.references === null ? [] : [`References: ${prepared.references}`]),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(new TextEncoder().encode(sentText(prepared))),
    ],
    ...files.map(({ attachment, bytes }) => [
      `Content-Type: ${attachment.mimeType}; name="${fileName(attachment.name)}"`,
      `Content-Disposition: attachment; filename="${fileName(attachment.name)}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(bytes),
    ]),
  ];
  return [
    ...headers,
    "",
    ...parts.flatMap((part) => [`--${boundary}`, ...part]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
};

/** Each file's bytes, refused unless they are exactly the version the card named. */
const filesOf = Effect.fn("KinSending.files")(function* (attachments: ReadonlyArray<Attachment>) {
  return yield* Effect.forEach(attachments, (attachment) =>
    Effect.gen(function* () {
      const stored = yield* readStoredFile(attachment.attachmentId, MAX_ATTACHMENT_BYTES).pipe(
        Effect.orElseSucceed(() => ({ error: "the file can't be read" }) as const),
      );
      if ("error" in stored) return yield* refused(`${attachment.name}: ${stored.error}.`);
      const sha256 = NodeCrypto.createHash("sha256").update(stored.bytes).digest("hex");
      if (sha256 !== attachment.sha256)
        return yield* refused(`${attachment.name} is not the file the card showed.`);
      return { attachment, bytes: stored.bytes };
    }),
  );
});

/** Sends exactly what was prepared, once. Returns the ids Google gave it. */
export const sendGoogle = Effect.fn("KinSending.sendGoogle")(function* (
  http: HttpClient.HttpClient,
  token: string,
  prepared: Exclude<Prepared, { _tag: "call" }>,
) {
  if (prepared._tag === "email") {
    const raw = Buffer.from(mime(prepared, yield* filesOf(prepared.attachments))).toString(
      "base64url",
    );
    const sent = yield* api(
      http,
      token,
      `${GMAIL}/messages/send`,
      {},
      {
        method: "POST",
        json: prepared.threadId === null ? { raw } : { raw, threadId: prepared.threadId },
      },
    );
    return {
      messageId: text(field(sent, "id")) ?? null,
      threadId: text(field(sent, "threadId")) ?? prepared.threadId,
      eventId: null,
    };
  }
  const event = {
    summary: prepared.title,
    start: {
      dateTime: prepared.start,
      ...(prepared.timeZone === null ? {} : { timeZone: prepared.timeZone }),
    },
    end: {
      dateTime: prepared.end,
      ...(prepared.timeZone === null ? {} : { timeZone: prepared.timeZone }),
    },
    ...(prepared.location === null ? {} : { location: prepared.location }),
    ...(prepared.notes === null ? {} : { description: prepared.notes }),
    attendees: prepared.invitees.map((email) => ({ email })),
  };
  const events = `${CALENDAR}/${encodeURIComponent(prepared.calendarId)}/events`;
  const saved = yield* api(
    http,
    token,
    prepared.eventId === null ? events : `${events}/${encodeURIComponent(prepared.eventId)}`,
    { sendUpdates: "all" },
    { method: prepared.eventId === null ? "POST" : "PATCH", json: event },
  );
  return { messageId: null, threadId: null, eventId: text(field(saved, "id")) ?? prepared.eventId };
});

/**
 * A sent mail is a contact with each client whose contact it went to: one email touch per client,
 * by the owner who confirmed it, with the subject as its note. A retry finds the same touch.
 */
export const sentToClient = Effect.fn("KinSending.sentToClient")(function* (sent: {
  readonly orgId: KinOrgId;
  readonly askId: string;
  readonly agentId: string;
  readonly personId: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const addresses = [...new Set(sent.to.map((one) => one.toLowerCase()))];
  if (addresses.length === 0) return;
  const clients = yield* sql<{ partyId: string }>`SELECT DISTINCT c.record_id AS "partyId"
    FROM kin_records r JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      AND c.register_id = 'clients'
    WHERE r.org_id = ${sent.orgId} AND r.register_id = 'contacts'
      AND lower(json_extract(r.fields_json, '$.email')) IN ${sql.in(addresses)}
    ORDER BY c.record_id`;
  for (const { partyId } of clients)
    yield* logTouch(sent.orgId, {
      partyId,
      kind: "email",
      at: sent.now,
      note: sent.subject.slice(0, 300),
      personId: sent.personId,
      by: { kind: "agent", id: sent.agentId },
      originKey: `mail:${sent.askId}:${partyId}`,
      now: sent.now,
    });
});
