// @effect-diagnostics nodeBuiltinImport:off -- a stored file's hash, and a MIME boundary.
import * as NodeCrypto from "node:crypto";

import { type KinChatError, KinDocFile, type KinOrgId, type KinSendCard } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";

import { readStoredFile } from "../gendocs/brand.ts";
import { formatMoney } from "../work/money.ts";
import { KinGatewayError } from "./McpGateway.ts";
import { api, CALENDAR, field, GMAIL, header, list, text } from "./Google.ts";

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
export const Prepared = Schema.Union([
  Schema.TaggedStruct("email", {
    to: Schema.Array(Schema.String),
    cc: Schema.Array(Schema.String),
    subject: Schema.String,
    body: Schema.String,
    threadId: Schema.NullOr(Schema.String),
    inReplyTo: Schema.NullOr(Schema.String),
    references: Schema.NullOr(Schema.String),
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

/** The address inside `Ana <ana@example.com>`, or the value when it is a bare address. */
const addressOf = (value: string | null) => {
  if (value === null) return undefined;
  const inside = /<([^<>]+)>/.exec(value)?.[1] ?? value;
  const address = inside.trim();
  return ADDRESS.test(address) ? address : undefined;
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

/** The thread's last message from someone else: who a reply goes to, and what it answers. */
const replyTarget = Effect.fn("KinSending.replyTarget")(function* (
  http: HttpClient.HttpClient,
  token: string,
  threadId: string,
  account: string | null,
) {
  const thread = yield* api(http, token, `${GMAIL}/threads/${encodeURIComponent(threadId)}`, {
    format: "metadata",
    metadataHeaders: ["From", "Reply-To", "To", "Subject", "Message-ID", "References"],
  });
  const messages = list(field(thread, "messages"));
  if (messages.length === 0) return yield* refused("That mail thread has no messages.");
  const mine = (message: unknown) =>
    account !== null && addressOf(header(message, "From"))?.toLowerCase() === account.toLowerCase();
  const last = messages.findLast((message) => !mine(message)) ?? messages.at(-1)!;
  const to = mine(last)
    ? (header(last, "To") ?? "").split(",").flatMap((one) => addressOf(one) ?? [])
    : [addressOf(header(last, "Reply-To")) ?? addressOf(header(last, "From"))].flatMap(
        (one) => one ?? [],
      );
  if (to.length === 0) return yield* refused("Kin couldn't tell who to reply to in that thread.");
  const subject = (header(messages[0], "Subject") ?? "").replace(LINE_BREAK, " ").trim();
  const messageId = header(last, "Message-ID");
  const references = [header(last, "References"), messageId].filter((one) => one !== null);
  return {
    to: to.slice(0, MAX_RECIPIENTS),
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    inReplyTo: messageId,
    references: references.length === 0 ? null : references.join(" "),
  };
});

/** What a Google send tool would send, checked and filled in from the thread it answers. */
export const prepareGoogle = Effect.fn("KinSending.prepareGoogle")(function* (input: {
  readonly http: HttpClient.HttpClient;
  readonly token: Effect.Effect<string, KinGatewayError | KinChatError>;
  readonly orgId: KinOrgId;
  readonly account: string | null;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}) {
  const { args } = input;
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
    const target = yield* replyTarget(input.http, yield* input.token, threadId, input.account);
    return {
      _tag: "email",
      to: target.to,
      cc,
      subject: target.subject,
      body,
      threadId,
      inReplyTo: target.inReplyTo,
      references: target.references,
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
  return {
    _tag: "email",
    to,
    cc,
    subject,
    body,
    threadId: null,
    inReplyTo: null,
    references: null,
    attachments,
  } satisfies Prepared;
});

const when = (prepared: Extract<Prepared, { _tag: "event" }>) =>
  `When: ${prepared.start} to ${prepared.end}${prepared.timeZone === null ? "" : ` (${prepared.timeZone})`}`;

/** The card: everything that goes, as it goes. */
export const sendCard = (input: {
  readonly service: string;
  readonly account: string | null;
  readonly tool: string;
  readonly prepared: Prepared;
}): { readonly question: string; readonly detail: string; readonly send: KinSendCard } => {
  const { prepared } = input;
  if (prepared._tag === "email") {
    const reply = prepared.threadId !== null;
    return {
      question: reply ? "Send this reply from Gmail?" : "Send this email from Gmail?",
      detail: [
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
        from: input.account,
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

/** The message as Gmail takes it: plain text, then each file, in one multipart. */
const mime = (
  prepared: Extract<Prepared, { _tag: "email" }>,
  files: ReadonlyArray<{ readonly attachment: Attachment; readonly bytes: Uint8Array }>,
) => {
  const boundary = `kin_${NodeCrypto.randomBytes(12).toString("hex")}`;
  const headers = [
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
      base64Lines(new TextEncoder().encode(prepared.body)),
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
 * Hook: a mail that carried an invoice, quote or receipt is a contact with that client. Kin has
 * no client contact log yet; when it does, this records the touch.
 */
export const sentToClient = (_sent: {
  readonly orgId: KinOrgId;
  readonly entryRecordId: string;
  readonly to: ReadonlyArray<string>;
}) => Effect.void;
