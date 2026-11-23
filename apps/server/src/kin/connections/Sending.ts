// @effect-diagnostics nodeBuiltinImport:off -- a stored file's hash, and a MIME boundary.
import * as NodeCrypto from "node:crypto";

import {
  type KinChatError,
  KinDocFile,
  type KinMailAddress,
  type KinOrgId,
  KinPersonId,
  type KinSendCard,
  formatKinWhen,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { chatReaders, keysIn } from "../chat/messageLinks.ts";
import { readStoredFile } from "../gendocs/brand.ts";
import { ownerLevel } from "../people/KinAccess.ts";
import * as KinShell from "../shell/KinShell.ts";
import { registerSectionColumns, sectionOfRegister } from "../shell/sections.ts";
import { readProfile, type TextClock } from "../work/companyProfile.ts";
import type { KinRecords } from "../work/KinRecords.ts";
import { formatMoney } from "../work/money.ts";
import { listDef, stateLabel } from "../work/registers.ts";
import { seenBy } from "../work/teamView.ts";
import { logTouch } from "../work/touches.ts";
import { KinGatewayError } from "./McpGateway.ts";
import { MAIL_TOOL, type Mailbox, type MailProvider } from "./MailProvider.ts";

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
  /** The entry's revision when the card was drawn: a Confirm approves that, not a later edit. */
  entryRev: Schema.optionalKey(Schema.Number),
  /** An invoice's, while the company has no bank account or UPI id to be paid to. */
  bankMissing: Schema.optionalKey(Schema.Literal(true)),
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
    /** Missing on asks from before accounts: the account's default From. */
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
    /** The calendar's name, read when the card was drawn; missing on asks from before. */
    calendarName: Schema.optionalKey(Schema.NullOr(Schema.String)),
    eventId: Schema.NullOr(Schema.String),
    /** A changed event as it stood when the card was drawn; missing on asks from before. */
    current: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          title: Schema.NullOr(Schema.String),
          start: Schema.NullOr(Schema.String),
          end: Schema.NullOr(Schema.String),
        }),
      ),
    ),
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
const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      summary: Schema.NullOr(Schema.String),
      start: Schema.NullOr(Schema.String),
      end: Schema.NullOr(Schema.String),
    }),
  ),
);
const refused = (message: string) => new KinGatewayError({ reason: "protocol", message });

const MAX_RECIPIENTS = 10;
const MAX_INVITEES = 50;
const MAX_BODY = 20_000;
const MAX_ATTACHMENTS = 5;
// Providers take the message inline as base64; a few invoices fit well inside their limits.
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
          rev: number;
        }>`SELECT register_id AS "registerId", amount_minor AS "amountMinor", currency, rev
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
  const bank = entry?.registerId === "invoices" ? (yield* readProfile(orgId)).bank : undefined;
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
    ...(entry === undefined ? {} : { entryRev: entry.rev }),
    ...(bank !== undefined && bank.accountNumber === null && bank.upi === null
      ? { bankMissing: true as const }
      : {}),
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

/**
 * The task a mail with no document of its own is about: the one open task that the person's
 * messages waking this turn, with the mail's own words, name by key, among tasks everyone in
 * the chat may see. `null` when they name none or more than one.
 */
export const namedTask = Effect.fn("KinSending.namedTask")(function* (
  turn: { readonly orgId: KinOrgId; readonly wakeupId: string; readonly chatId: string },
  words: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const asked = yield* sql<{ body: string }>`SELECT m.body FROM kin_events e
    JOIN kin_messages m ON m.org_id = e.org_id
      AND m.message_id = json_extract(e.json, '$.messageId')
    WHERE e.org_id = ${turn.orgId} AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message'
      AND m.chat_id = ${turn.chatId} AND m.author_kind = 'human' AND m.status = 'posted'
    ORDER BY m.seq`;
  const keys = [...new Set([...asked.map((one) => one.body), ...words].flatMap(keysIn))];
  // A follow-up woken for one person in this chat (`draftWake.ts`) is its own task's.
  const woken =
    keys.length > 0
      ? []
      : (yield* sql<{ recordId: string }>`SELECT DISTINCT f.subject_record_id AS "recordId"
          FROM kin_events e, json_each(e.json, '$.factKeys') k
          JOIN kin_pulse_facts f ON f.org_id = e.org_id AND f.fact_key = k.value
          WHERE e.org_id = ${turn.orgId} AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'pulse'
            AND json_extract(e.json, '$.chatId') = ${turn.chatId}
            AND f.subject_record_id IS NOT NULL
          ORDER BY f.subject_record_id`).map((row) => row.recordId);
  if (keys.length === 0 && woken.length === 0) return null;
  const viewer = yield* chatReaders(turn.orgId, turn.chatId);
  const tasks = yield* sql<{ recordId: string }>`SELECT r.record_id AS "recordId"
    FROM kin_records r
    WHERE r.org_id = ${turn.orgId} AND r.register_id = 'work'
      AND ${keys.length > 0 ? sql`r.key IN ${sql.in(keys)}` : sql`r.record_id IN ${sql.in(woken)}`}
      AND r.state NOT IN ('done', 'dropped') AND ${seenBy(sql, viewer)}
    ORDER BY r.record_id LIMIT 2`;
  return tasks.length === 1 ? tasks[0]!.recordId : null;
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

export const subjectOff = Effect.fn("KinSending.subjectOff")(function* (
  orgId: KinOrgId,
  prepared: Prepared | undefined,
) {
  if (prepared?._tag !== "email") return null;
  const ids = [
    ...new Set(
      prepared.attachments.flatMap((file) =>
        file.entryRecordId === null ? [file.recordId] : [file.recordId, file.entryRecordId],
      ),
    ),
  ];
  if (ids.length === 0) return null;
  const sql = yield* SqlClient.SqlClient;
  const entries = yield* sql<Parameters<typeof sectionOfRegister>[0]>`SELECT DISTINCT
    ${registerSectionColumns(sql)} FROM kin_records r
    LEFT JOIN kin_registers g ON g.org_id = r.org_id AND g.register_id = r.register_id
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(ids)} ORDER BY id`;
  const shell = yield* KinShell.get(orgId);
  for (const entry of entries) {
    const section = sectionOfRegister(entry);
    if (section !== null && !KinShell.sectionOn(shell, section))
      return `${KinShell.sectionName(shell, section)} is turned off for this company, so this wasn't sent. Turn it on in Settings › Sections and confirm again.`;
  }
  return null;
});

/**
 * Why the mail may not go any more because a file it carries, or that file's entry, was closed
 * since its card: a void invoice, quote or receipt, an archived doc, a dropped entry of any list.
 * `null` when none is. Done (paid, accepted, filed) still goes: a copy of a paid invoice is fair.
 */
export const subjectClosed = Effect.fn("KinSending.subjectClosed")(function* (
  orgId: KinOrgId,
  prepared: Prepared,
) {
  const ids = new Set(
    (prepared._tag === "email"
      ? prepared.attachments.flatMap((one) => [one.recordId, one.entryRecordId])
      : []
    ).filter((id) => id !== null),
  );
  if (ids.size === 0) return null;
  const sql = yield* SqlClient.SqlClient;
  const [closed] = yield* sql<{ key: string; registerId: string; state: string }>`SELECT key,
      register_id AS "registerId", state FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in([...ids])} AND state = 'dropped'
    ORDER BY register_id = 'docs', record_id LIMIT 1`;
  if (closed === undefined) return null;
  const def = yield* listDef(orgId, closed.registerId);
  const noun = def?.noun ?? "entry";
  const state = def === undefined ? "closed" : stateLabel(def, closed.state).toLowerCase();
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${closed.key} is ${state} now, so nothing was sent.`;
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

/** What a mail send tool would send, checked and filled in from the thread it answers. */
export const prepareMail = Effect.fn("KinSending.prepareMail")(function* (input: {
  readonly provider: MailProvider;
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
  if (input.tool === MAIL_TOOL.saveEvent) {
    const title = optional(args, "title");
    const start = optional(args, "start");
    const end = optional(args, "end");
    if (title === null || start === null || end === null)
      return yield* refused(`${MAIL_TOOL.saveEvent} needs title, start and end.`);
    if ([start, end].some((when) => Number.isNaN(Date.parse(when))))
      return yield* refused("start and end are date-times such as 2026-11-20T15:00:00+05:30.");
    if (Date.parse(end) <= Date.parse(start)) return yield* refused("end is after start.");
    const invitees = strings(args.invitees);
    const bad = checkAddresses(invitees, "invitees", MAX_INVITEES);
    if (bad !== undefined) return yield* bad;
    const calendarId = optional(args, "calendarId") ?? "primary";
    const eventId = optional(args, "eventId");
    // A change names the event it changes, read now from that calendar with the account's token.
    const current =
      eventId === null
        ? null
        : yield* input.provider
            .call(
              input.http,
              yield* input.token,
              mailbox,
              MAIL_TOOL.event,
              { calendarId, eventId },
              yield* Clock.currentTimeMillis,
            )
            .pipe(
              Effect.flatMap((result) => {
                const [first] = result.content;
                const read =
                  first?.type === "text"
                    ? Option.getOrUndefined(decodeEvent(first.text))
                    : undefined;
                return read === undefined
                  ? Effect.fail(refused(`${input.provider.name} sent an answer Kin couldn't read.`))
                  : Effect.succeed({ title: read.summary, start: read.start, end: read.end });
              }),
            );
    const calendarName = yield* input.token.pipe(
      Effect.flatMap((token) =>
        input.provider.calendarName(input.http, token, mailbox, calendarId),
      ),
      Effect.orElseSucceed(() => null),
    );
    return {
      _tag: "event",
      calendarId,
      calendarName,
      eventId,
      current,
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
  if (input.tool === MAIL_TOOL.reply) {
    const threadId = optional(args, "threadId");
    if (threadId === null) return yield* refused(`${MAIL_TOOL.reply} needs threadId.`);
    if (optional(args, "from") !== null)
      return yield* refused("A reply goes from the address the mail was sent to; leave from out.");
    const target = yield* input.provider.replyTarget(
      input.http,
      yield* input.token,
      mailbox,
      threadId,
    );
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
  if (input.tool !== MAIL_TOOL.send)
    return yield* refused(`${input.provider.name} has no tool named ${input.tool}.`);
  const to = strings(args.to);
  if (to.length === 0) return yield* refused(`${MAIL_TOOL.send} needs to.`);
  const badTo = checkAddresses(to, "to", MAX_RECIPIENTS);
  if (badTo !== undefined) return yield* badTo;
  const subject = optional(args, "subject");
  if (subject === null) return yield* refused(`${MAIL_TOOL.send} needs subject.`);
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

export type Email = Extract<Prepared, { readonly _tag: "email" }>;
/** Addresses a person typed, as stored: trimmed, without empty entries. */
const typed = (values: ReadonlyArray<string>) =>
  values.map((one) => one.trim()).filter((one) => one !== "");
/** A typed address list passes what the agent's had to, sparing what the mail already held. */
const checkTyped = (values: ReadonlyArray<string>, held: ReadonlyArray<string>, what: string) => {
  const max = Math.max(MAX_RECIPIENTS, held.length);
  if (values.length > max) return `At most ${max} addresses in ${what}.`;
  return checkAddresses(
    values.filter((one) => !held.includes(one)),
    what,
    max,
  )?.message;
};

/**
 * A person's own To, Cc, Subject and Body on a drawn mail, checked as the agent's draft was;
 * the rest (From, thread, files) stays as the card showed it. A string is why it can't go.
 */
export const editedMail = (
  mail: Email,
  edit: {
    readonly to: ReadonlyArray<string>;
    readonly cc: ReadonlyArray<string>;
    readonly subject: string;
    readonly body: string;
  },
): Email | string => {
  const to = typed(edit.to);
  const cc = typed(edit.cc);
  const subject = edit.subject.trim();
  if (to.length === 0) return "Add at least one address in To.";
  const bad = checkTyped(to, mail.to, "To") ?? checkTyped(cc, mail.cc, "Cc");
  if (bad !== undefined) return bad;
  if (subject === "") return "Add a subject.";
  if (subject !== mail.subject && (LINE_BREAK.test(subject) || subject.length > 300))
    return "The subject is one line of at most 300 characters.";
  if (edit.body.trim() === "") return "Write the message before sending it.";
  if (edit.body.length > MAX_BODY)
    return `The message is at most ${MAX_BODY.toLocaleString("en-US")} characters.`;
  return { ...mail, to, cc, subject, body: edit.body };
};
/** The mail a card shows: a person's saved words over the agent's draft, where they saved some. */
export const shownMail = (mail: Email, send: KinSendCard | undefined): Email =>
  send?.edited === undefined
    ? mail
    : { ...mail, to: send.to, cc: send.cc, subject: send.subject, body: send.body };
const Words = Schema.Struct({
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  body: Schema.String,
});
const decodeConfirmed = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ confirmed: Schema.optionalKey(Words) })),
);
/** The person's words a Confirm took, kept in the ask's payload beside the agent's draft. */
export const confirmedWords = (mail: Email): typeof Words.Type => ({
  to: mail.to,
  cc: mail.cc,
  subject: mail.subject,
  body: mail.body,
});
/** What a confirmed ask sends: the words its Confirm took, else the agent's draft. */
export const confirmedOf = (prepared: Prepared, payload: string): Prepared => {
  const words = Option.getOrUndefined(decodeConfirmed(payload))?.confirmed;
  return prepared._tag !== "email" || words === undefined ? prepared : { ...prepared, ...words };
};
/** Whether an edit left the words exactly as drawn. */
export const sameWords = (one: Email, other: Email) =>
  one.subject === other.subject &&
  one.body === other.body &&
  one.to.length === other.to.length &&
  one.to.every((address, index) => other.to[index] === address) &&
  one.cc.length === other.cc.length &&
  one.cc.every((address, index) => other.cc[index] === address);

const OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;
/**
 * An event's times as a person reads them: in `zone` when the agent gave an offset; a wall-clock
 * time without one stands as written in the event's own zone, which then is named.
 */
const whenOf = (
  prepared: Pick<Extract<Prepared, { _tag: "event" }>, "start" | "end" | "timeZone">,
  clock: TextClock,
) => {
  const read = (at: string) => {
    const offset = OFFSET.test(at);
    const parsed = DateTime.make(offset ? at : `${at}Z`);
    return Option.isNone(parsed)
      ? null
      : {
          ms: DateTime.toEpochMillis(parsed.value),
          timeZone: offset ? clock.zone : "UTC",
          offset,
        };
  };
  const start = read(prepared.start);
  const end = read(prepared.end);
  if (start === null || end === null)
    return `${prepared.start} to ${prepared.end}${prepared.timeZone === null ? "" : ` (${prepared.timeZone})`}`;
  const day = (at: { ms: number; timeZone: string }) =>
    formatKinWhen(at.ms, "day", { zone: at.timeZone, locale: clock.locale });
  const time = (at: { ms: number; timeZone: string }) =>
    formatKinWhen(at.ms, "time", { zone: at.timeZone, locale: clock.locale });
  const shownZone = start.offset ? null : prepared.timeZone;
  const ending = day(end) === day(start) ? time(end) : `${day(end)}, ${time(end)}`;
  return `${day(start)}, ${time(start)} to ${ending}${shownZone === null ? "" : ` (${shownZone})`}`;
};
const plainWhen = (...args: Parameters<typeof whenOf>) => `When: ${whenOf(...args)}`;
const eventTarget = (prepared: Extract<Prepared, { _tag: "event" }>, clock: TextClock) => {
  const current = prepared.current ?? null;
  return [
    prepared.calendarName?.trim()
      ? `In calendar: ${prepared.calendarName.trim()}`
      : prepared.calendarId === "primary"
        ? "In your calendar"
        : `In calendar: ${prepared.calendarId}`,
    ...(prepared.eventId === null || current === null
      ? []
      : [
          `Currently: ${current.title ?? "untitled"}${
            current.start === null || current.end === null
              ? ""
              : `, ${whenOf({ start: current.start, end: current.end, timeZone: null }, clock)}`
          }`,
        ]),
  ].map((line) => line.slice(0, 400));
};

/** One From the owner may switch a send card to; `id` names it in the switch. */
export type FromChoice = NonNullable<KinSendCard["fromChoices"]>[number];
export const choiceId = (connectionId: string, address: string) => `${connectionId} ${address}`;
const fromLine = (from: From) =>
  from.name === null ? from.address : `${from.name} <${from.address}>`;

/** The card: everything that goes, as it goes. */
export const sendCard = (input: {
  /** What outside text the turn had read when it drew the card, such as "text from Sentry". */
  readonly outside?: string;
  readonly service: string;
  /** The mail provider of a mail or calendar card; a call card names `service`. */
  readonly mail?: Pick<MailProvider, "mailService" | "calendarService">;
  readonly account: string | null;
  readonly tool: string;
  readonly prepared: Prepared;
  readonly choices?: ReadonlyArray<FromChoice>;
  /** The owner's zone, which an event's times are shown in, and the company's locale. */
  readonly clock: TextClock;
}): { readonly question: string; readonly detail: string; readonly send: KinSendCard } => {
  const card = cardOf(input);
  if (input.outside === undefined) return card;
  // The question shows on every client, also beside the send details, so the mark goes there.
  const mark = ` Drafted after reading ${input.outside.slice(0, 80)}, so check it before you confirm.`;
  return { ...card, question: `${card.question.slice(0, 240 - mark.length)}${mark}` };
};
const cardOf = (
  input: Omit<Parameters<typeof sendCard>[0], "outside">,
): { readonly question: string; readonly detail: string; readonly send: KinSendCard } => {
  const { prepared } = input;
  if (prepared._tag === "email") {
    const reply = prepared.threadId !== null;
    const from = prepared.from ?? null;
    const thread = prepared.thread ?? null;
    const quoted = prepared.quoted ?? null;
    return {
      question: `Send this ${reply ? "reply" : "email"} from ${input.mail?.mailService ?? input.service}?`,
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
        service: input.mail?.mailService ?? input.service,
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
          ...(one.bankMissing === true ? { bankMissing: true as const } : {}),
        })),
        outcome: null,
      },
    };
  }
  if (prepared._tag === "event") {
    const target = eventTarget(prepared, input.clock);
    const changing = prepared.current?.title ?? null;
    const body = [
      ...target,
      plainWhen(prepared, input.clock),
      ...(prepared.location === null ? [] : [`Where: ${prepared.location}`]),
      ...(prepared.notes === null ? [] : ["", prepared.notes]),
    ].join("\n");
    return {
      question:
        prepared.eventId === null
          ? "Add this event and send the invitations?"
          : changing === null
            ? "Change this event and tell the guests?"
            : `Change “${changing.slice(0, 80)}” and tell the guests?`,
      detail: [...target, `Event: ${prepared.title}`, plainWhen(prepared, input.clock)]
        .join("\n")
        .slice(0, 2000),
      send: {
        service: input.mail?.calendarService ?? input.service,
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

/** The whole RFC 822 message: plain text, then each file, in one multipart. */
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

/**
 * Sends exactly what was prepared, once, through the account's provider. `handOff` wraps the
 * request as it leaves, after every file is read and checked: the caller's last check runs there.
 */
export const sendMail = Effect.fn("KinSending.sendMail")(function* (
  provider: MailProvider,
  http: HttpClient.HttpClient,
  token: string,
  prepared: Exclude<Prepared, { _tag: "call" }>,
  handOff: <A, E>(
    request: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | KinChatError | SqlError.SqlError>,
) {
  if (prepared._tag === "event") return yield* handOff(provider.saveEvent(http, token, prepared));
  const raw = mime(prepared, yield* filesOf(prepared.attachments));
  return yield* handOff(provider.sendMessage(http, token, { raw, threadId: prepared.threadId }));
});

/**
 * A sent mail is a contact with each client whose contact it went to: one email touch per client,
 * by the owner who confirmed it, with the subject as its note. A retry finds the same touch. From
 * a person's own mailbox (`own`) the touch is theirs and bare: that a mail went, and its task.
 */
/** The note a send from a person's own mailbox leaves on its client: no subject, no address. */
export const OWN_MAIL_TOUCH = "Mail sent";
export const sentToClient = Effect.fn("KinSending.sentToClient")(function* (sent: {
  readonly orgId: KinOrgId;
  readonly askId: string;
  readonly agentId: string;
  readonly personId: string;
  readonly to: ReadonlyArray<string>;
  readonly subject: string;
  readonly now: number;
  readonly own?: { readonly personId: string; readonly task: string | null };
}) {
  const sql = yield* SqlClient.SqlClient;
  const addresses = [...new Set(sent.to.map((one) => one.toLowerCase()))];
  if (addresses.length === 0) return;
  const clients = yield* sql<{ partyId: string }>`SELECT DISTINCT c.record_id AS "partyId"
    FROM kin_records r JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = r.party_id
      AND c.register_id = 'clients'
    WHERE r.org_id = ${sent.orgId} AND r.register_id = 'contacts'
      AND (lower(json_extract(r.fields_json, '$.email')) IN ${sql.in(addresses)}
        OR EXISTS (SELECT 1 FROM json_each(r.fields_json, '$.emails') e
          WHERE lower(e.value) IN ${sql.in(addresses)}))
    ORDER BY c.record_id`;
  for (const { partyId } of clients)
    yield* logTouch(sent.orgId, {
      partyId,
      kind: "email",
      at: sent.now,
      note:
        sent.own === undefined
          ? sent.subject.slice(0, 300)
          : sent.own.task === null
            ? OWN_MAIL_TOUCH
            : `${OWN_MAIL_TOUCH} (${sent.own.task})`,
      personId: sent.own?.personId ?? sent.personId,
      by:
        sent.own === undefined
          ? { kind: "agent", id: sent.agentId }
          : { kind: "person", id: sent.own.personId },
      originKey: `mail:${sent.askId}:${partyId}`,
      now: sent.now,
    });
});

/**
 * A mail carrying a quote or invoice went out on a person's Confirm. An agent's suggestion among
 * them is kept when the one who pressed is owner-level now and the entry is as the card showed it
 * (same revision, not dropped); then a draft quote reads sent. Numbers are left as they are.
 */
export const markQuotesSent = Effect.fn("KinSending.markQuotesSent")(function* (
  records: KinRecords["Service"],
  sent: {
    readonly orgId: KinOrgId;
    /** Who pressed Confirm (`decidedBy`): never the agent's owner by default. */
    readonly personId: string;
    readonly wakeupId: string;
    readonly attachments: ReadonlyArray<Attachment>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const pinned = new Map<string, number | undefined>();
  for (const one of sent.attachments)
    if (one.entryRecordId !== null) pinned.set(one.entryRecordId, one.entryRev);
  if (pinned.size === 0) return;
  const entries = yield* sql<{
    key: string;
    recordId: string;
    registerId: string;
    state: string;
    rev: number;
    confirmed: number;
  }>`
    SELECT key, record_id AS "recordId", register_id AS "registerId", state, rev, confirmed
    FROM kin_records WHERE org_id = ${sent.orgId} AND register_id IN ('quotes', 'invoices')
      AND record_id IN ${sql.in([...pinned.keys()])}
    ORDER BY key`;
  const writer = {
    actor: { _tag: "person", personId: KinPersonId.make(sent.personId) },
    via: "owner",
    wakeupId: sent.wakeupId,
  } as const;
  const ownerLevelNow = yield* ownerLevel(sent.orgId, KinPersonId.make(sent.personId));
  for (const entry of entries) {
    let kept = entry.confirmed === 1;
    if (
      !kept &&
      ownerLevelNow &&
      entry.state !== "dropped" &&
      pinned.get(entry.recordId) === entry.rev
    ) {
      yield* records.update(sent.orgId, writer, entry.key, { confirmed: true });
      kept = (yield* records.get(sent.orgId, entry.key))?.confirmed === 1;
    }
    if (kept && entry.registerId === "quotes" && entry.state === "open")
      yield* records.update(sent.orgId, writer, entry.key, { state: "waiting" });
  }
});

const decodeSentPayload = Schema.decodeUnknownOption(PreparedJson);
/** Recent sends a lookup reads through; older mail is the mailbox's to search. */
const SENT_SCAN = 200;
const decodeSentResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      messageId: Schema.optional(Schema.NullOr(Schema.String)),
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

/** One mail Kin sent on someone's Confirm, as an agent reads it afterwards. */
export const SentMailView = Schema.Struct({
  at: Schema.String,
  /** The connection it went through, and the signed-in account. */
  connection: Schema.String,
  account: Schema.String,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  cc: Schema.Array(Schema.String),
  subject: Schema.String,
  /** The provider's thread: mail_reply with it from the same connection answers in it. */
  threadId: Schema.NullOr(Schema.String),
  reply: Schema.Boolean,
  documents: Schema.Array(Schema.String),
  confirmedBy: Schema.NullOr(Schema.String),
  draftedBy: Schema.NullOr(Schema.String),
});
export type SentMail = typeof SentMailView.Type;

/**
 * Mail that went out on a Confirm, newest first: all of it, or only mail carrying one of
 * `recordIds` (an invoice, quote or receipt) or sent or copied to one of `addresses`. Never mail
 * from a person's own mailbox: the company keeps only its bare touch (`sentToClient`).
 */
export const sentMail = Effect.fn("KinSending.sentMail")(function* (input: {
  readonly orgId: KinOrgId;
  readonly recordIds?: ReadonlyArray<string> | undefined;
  readonly addresses?: ReadonlyArray<string> | undefined;
  readonly omitLists?: ReadonlyArray<string>;
  readonly limit?: number | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const ids = new Set(input.recordIds ?? []);
  const addresses = new Set((input.addresses ?? []).map((one) => one.trim().toLowerCase()));
  const filtered = input.recordIds !== undefined || input.addresses !== undefined;
  if (filtered && ids.size === 0 && addresses.size === 0) return [];
  const rows = yield* sql<{
    payload: string;
    result: string | null;
    doneAt: number;
    connectionId: string;
    label: string;
    accountLabel: string | null;
    confirmedBy: string | null;
    draftedBy: string | null;
  }>`SELECT k.payload_json AS payload, k.result_json AS result, k.done_at AS "doneAt",
      k.connection_id AS "connectionId", c.label, c.account_label AS "accountLabel",
      p.display_name AS "confirmedBy", a.display_name AS "draftedBy"
    FROM kin_connection_asks k
    JOIN kin_connections c ON c.org_id = k.org_id AND c.connection_id = k.connection_id
    LEFT JOIN kin_people p ON p.org_id = k.org_id AND p.person_id = k.decided_by
    LEFT JOIN kin_agents a ON a.org_id = k.org_id AND a.agent_id = k.agent_id
    WHERE k.org_id = ${input.orgId} AND k.state = 'sent' AND k.done_at IS NOT NULL
      AND c.person_id IS NULL
      AND k.tool_name IN ${sql.in([MAIL_TOOL.send, MAIL_TOOL.reply])}
      ${
        input.omitLists?.length
          ? sql`AND NOT EXISTS (
        SELECT 1 FROM kin_records r WHERE r.org_id = k.org_id
          AND r.register_id IN ${sql.in(input.omitLists)}
          AND (r.record_id = k.entry_record_id OR EXISTS (
            SELECT 1 FROM json_each(k.payload_json, '$.attachments') a
            WHERE r.record_id IN (json_extract(a.value, '$.recordId'), json_extract(a.value, '$.entryRecordId'))
          ))
      )`
          : sql``
      }
    ORDER BY k.done_at DESC, k.rowid DESC
    LIMIT ${SENT_SCAN}`;
  const sent: Array<SentMail> = [];
  for (const row of rows) {
    const prepared = Option.getOrUndefined(
      Option.map(decodeSentPayload(row.payload), (one) => confirmedOf(one, row.payload)),
    );
    if (prepared?._tag !== "email") continue;
    const matches =
      !filtered ||
      prepared.attachments.some(
        (one) =>
          ids.has(one.recordId) || (one.entryRecordId !== null && ids.has(one.entryRecordId)),
      ) ||
      [...prepared.to, ...prepared.cc].some((address) => addresses.has(address.toLowerCase()));
    if (!matches) continue;
    const result =
      row.result === null ? undefined : Option.getOrUndefined(decodeSentResult(row.result));
    const account = row.accountLabel ?? row.label;
    sent.push({
      at: DateTime.formatIso(DateTime.makeUnsafe(row.doneAt)),
      connection: row.connectionId,
      account,
      from: prepared.from?.address ?? account,
      to: prepared.to,
      cc: prepared.cc,
      subject: prepared.subject,
      threadId: result?.threadId ?? prepared.threadId,
      reply: prepared.threadId !== null,
      // The card's label without its amount: "Invoice INV/26-27/004 (INV-26-27-004.pdf)".
      documents: prepared.attachments.map((one) =>
        one.label === null ? one.name : `${one.label.split(" · ")[0]} (${one.name})`,
      ),
      confirmedBy: row.confirmedBy,
      draftedBy: row.draftedBy,
    });
    if (sent.length >= Math.max(1, Math.min(input.limit ?? 10, 50))) break;
  }
  return sent;
});
