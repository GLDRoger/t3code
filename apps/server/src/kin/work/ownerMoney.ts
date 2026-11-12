import {
  type KinMakeReceiptInput,
  type KinReceiptsInput,
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinCompanyProfileInput,
  type KinCompanyProfileSetInput,
  type KinDatesInput,
  type KinIssueInput,
  type KinListsInput,
  type KinListUpdateInput,
  type KinMoneySummaryInput,
  type KinPaymentInput,
  type KinPaymentVoidInput,
  KinAttachment,
  KinChatId,
  KinMessageId,
  type KinWorkFile,
  type KinWorkFilesInput,
  type KinVoidInput,
  KinRecordKey,
  calendarTimeMillis,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { readableFrom } from "../chat/sharing.ts";
import { remakeForEntry } from "../gendocs/make.ts";
import * as Numbers from "../gendocs/numbering.ts";
import { listReceipts, makeReceipt as makeReceiptFor } from "../gendocs/receipts.ts";
import { readProfile, setProfile } from "./companyProfile.ts";
import { KinRecords } from "./KinRecords.ts";
import { dates as datesView, moneySummary } from "./moneyViews.ts";
import { found, ownerWriter, theOwner } from "./ownerWork.ts";
import { iso, workFailure } from "./recordRows.ts";
import {
  allLists,
  encodeDefinition,
  type FieldDef,
  listDef,
  openCounts,
  storedCategoryLabels,
  toDefinition,
  unknownList,
} from "./registers.ts";

/** What the owner's clients read and do with lists, money and the company profile. Owner only. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const millis = (value: string, field: string) => {
  const ms = calendarTimeMillis(value);
  return Number.isFinite(ms) ? Effect.succeed(ms) : Effect.fail(invalid(`${field} is not a time.`));
};

export const lists = Effect.fn("KinMoney.lists")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinListsInput,
) {
  yield* theOwner(people, input.orgId);
  const all = yield* allLists(input.orgId);
  const open = yield* openCounts(input.orgId);
  return {
    lists: [...all.values()]
      // Docs are a list underneath, with their own screens and RPCs.
      .filter((def) => def.id !== "docs" && (input.archived === true || def.archivedAt === null))
      .map((def) => toDefinition(def, open.get(def.id) ?? 0)),
  };
}, workFailure);

/** Rename, archive or restore a defined list, and retire or restore its fields. Never deletes. */
export const updateList = Effect.fn("KinMoney.updateList")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinListUpdateInput,
) {
  yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const def = yield* listDef(input.orgId, input.list);
      if (def === undefined) return yield* unknownList(input.list);
      if (def.builtIn !== null) return yield* invalid(`${def.name} is built in and can't change.`);
      const retire = new Set(input.retireFields ?? []);
      const restore = new Set(input.restoreFields ?? []);
      const unknown = [...retire, ...restore].filter(
        (key) => !def.fields.some((one) => one.key === key),
      );
      if (unknown.length > 0) return yield* invalid(`${def.name} has no ${unknown.join(", ")}.`);
      const problem =
        input.numbering === undefined ? undefined : Numbers.ruleProblem(input.numbering);
      if (problem !== undefined) return yield* invalid(problem);
      const kept: ReadonlyArray<FieldDef> = def.fields.map((one) => {
        const { retired: _retired, ...kept } = one;
        return retire.has(one.key)
          ? { ...kept, retired: true as const }
          : restore.has(one.key)
            ? kept
            : one;
      });
      // A numbered list shows its number in a field of its own.
      const fields: ReadonlyArray<FieldDef> =
        input.numbering === undefined || kept.some((one) => one.key === "number")
          ? kept
          : [...kept, { key: "number", label: "Number", type: "text", sensitive: false }];
      const numbering = input.numbering ?? def.numbering;
      const now = yield* Clock.currentTimeMillis;
      const archivedAt =
        input.archived === undefined
          ? def.archivedAt
          : input.archived
            ? (def.archivedAt ?? now)
            : null;
      const name = input.name ?? def.name;
      const unused = Object.keys(input.stateLabels ?? {}).filter(
        (state) => !def.states.some((one) => one === state),
      );
      if (unused.length > 0) return yield* invalid(`${def.name} doesn't use ${unused.join(", ")}.`);
      const stateLabels = { ...def.stateLabels, ...input.stateLabels };
      const unlisted = Object.keys(input.categoryLabels ?? {}).filter(
        (category) => !def.categories.includes(category),
      );
      if (unlisted.length > 0)
        return yield* invalid(`${def.name} has no category ${unlisted.join(", ").slice(0, 80)}.`);
      const categoryLabels = storedCategoryLabels(def.id, {
        ...def.categoryLabels,
        ...input.categoryLabels,
      });
      const payments = input.payments ?? def.payments === true;
      if (payments !== (def.payments === true)) {
        if (!payments && def.id === "invoices")
          return yield* invalid(`${def.name} are always paid over time.`);
        if (payments && !def.amount)
          return yield* invalid(`${def.name} has no amounts, so nothing to pay over time.`);
        const paid = payments
          ? []
          : yield* sql`SELECT 1 FROM kin_record_payments p
              JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
              WHERE p.org_id = ${input.orgId} AND r.register_id = ${def.id}
                AND p.voided_at IS NULL LIMIT 1`;
        if (paid.length > 0)
          return yield* invalid(
            `Some ${def.name} entries have payments. Take those back first, then turn this off.`,
          );
      }
      const sameLabels = (a: Readonly<Record<string, string>>, b: typeof a) =>
        Object.keys(a).length === Object.keys(b).length &&
        Object.entries(a).every(([key, label]) => b[key] === label);
      const changed =
        name !== def.name ||
        payments !== (def.payments === true) ||
        !sameLabels(categoryLabels, def.categoryLabels ?? {}) ||
        def.states.some((state) => stateLabels[state] !== def.stateLabels[state]) ||
        archivedAt !== def.archivedAt ||
        fields.length !== def.fields.length ||
        fields.some((one, index) => one.retired !== def.fields[index]?.retired) ||
        numbering?.prefix !== def.numbering?.prefix ||
        numbering?.series !== def.numbering?.series ||
        numbering?.width !== def.numbering?.width;
      if (changed) {
        if (input.rev !== def.rev)
          return yield* new KinChatError({
            reason: "conflict",
            message: `${def.name} changed since you read it; it is at revision ${def.rev} now.`,
          });
        const {
          id: _id,
          builtIn: _builtIn,
          name: _name,
          prefix: _prefix,
          archivedAt: _archivedAt,
          rev: _rev,
          categoryLabels: _labels,
          payments: _payments,
          ...definition
        } = def;
        const next = {
          ...definition,
          fields,
          stateLabels,
          ...(Object.keys(categoryLabels).length === 0 ? {} : { categoryLabels }),
          ...(payments ? { payments: true as const } : {}),
        };
        yield* sql`UPDATE kin_registers SET name = ${name}, archived_at = ${archivedAt},
            definition_json = ${yield* encodeDefinition({
              ...next,
              ...(numbering === undefined ? {} : { numbering }),
            })},
            rev = rev + 1
          WHERE org_id = ${input.orgId} AND register_id = ${def.id}`;
      }
      const next = yield* listDef(input.orgId, def.id);
      if (next === undefined) return yield* unknownList(def.id);
      return toDefinition(next, (yield* openCounts(input.orgId)).get(def.id) ?? 0);
    }),
  );
}, workFailure);

/** `o:<offset>`: a page of the dates view. */
const offsetOf = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(0);
  const found = /^o:(\d{1,9})$/.exec(cursor);
  return found === null
    ? Effect.fail(invalid("That page cursor is stale."))
    : Effect.succeed(Number.parseInt(found[1]!, 10));
};

export const dates = Effect.fn("KinMoney.dates")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinDatesInput,
) {
  yield* theOwner(people, input.orgId);
  const from = yield* millis(input.from, "from");
  const to = yield* millis(input.to, "to");
  if (to <= from) return yield* invalid("to comes after from.");
  const offset = yield* offsetOf(input.cursor);
  const now = yield* Clock.currentTimeMillis;
  const page = yield* datesView(
    input.orgId,
    { from, to, lists: input.lists, open: input.open, offset, limit: input.limit },
    now,
  );
  const next = offset + page.rows.length;
  return {
    rows: page.rows,
    total: page.total,
    nextCursor: next < page.total ? `o:${next}` : null,
    asOf: iso(now),
  };
}, workFailure);

export const money = Effect.fn("KinMoney.summary")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMoneySummaryInput,
) {
  yield* theOwner(people, input.orgId);
  return yield* moneySummary(input.orgId, yield* Clock.currentTimeMillis);
}, workFailure);

/** The owner's Issue tap: the entry's number from its list's series, the same one if asked twice. */
export const issue = Effect.fn("KinMoney.issue")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinIssueInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const writer = ownerWriter(person);
  const issued = yield* Numbers.issue(input.orgId, writer, input.key);
  const remade =
    issued.number !== null && issued.state !== "dropped"
      ? yield* remakeForEntry({
          orgId: input.orgId,
          entryKey: issued.key,
          requester: { _tag: "owner", personId: person.personId, writer },
          admit: Effect.void,
        })
      : { documents: [], problems: [] };
  return {
    ...issued,
    documents: remade.documents.map((doc) => ({
      key: KinRecordKey.make(doc.key),
      title: doc.title,
      version: doc.version,
    })),
    problems: remade.problems,
  };
}, workFailure);

/** The owner's Void tap: kept with its number, so the series stays complete. */
export const voidEntry = Effect.fn("KinMoney.void")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinVoidInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return {
    ...(yield* Numbers.voidEntry(input.orgId, ownerWriter(person), input.key)),
    documents: [],
    problems: [],
  };
}, workFailure);

/** The owner's Undo void: back to owed, or paid, with the number it had. */
export const unvoidEntry = Effect.fn("KinMoney.unvoid")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinVoidInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return {
    ...(yield* Numbers.unvoidEntry(input.orgId, ownerWriter(person), input.key)),
    documents: [],
    problems: [],
  };
}, workFailure);

/** What Issue's confirmation shows: the number it would give now, which a concurrent issue may take. */
export const nextNumber = Effect.fn("KinMoney.nextNumber")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinIssueInput,
) {
  yield* theOwner(people, input.orgId);
  return { number: yield* Numbers.nextNumber(input.orgId, input.key) };
}, workFailure);

export const recordPayment = Effect.fn("KinMoney.recordPayment")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPaymentInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  const { row } = yield* records.pay(input.orgId, ownerWriter(person), input.key, {
    amount: input.amount,
    paidOn: input.paidOn,
    ...(input.note === undefined ? {} : { note: input.note }),
    originKey: `owner:${person.personId}:${input.clientRequestId}`,
  });
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
}, workFailure);

export const voidPayment = Effect.fn("KinMoney.voidPayment")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinPaymentVoidInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const records = yield* KinRecords;
  yield* found(input.orgId, input);
  const row = yield* records.voidPayment(
    input.orgId,
    ownerWriter(person),
    input.key,
    input.paymentId,
  );
  return yield* records.detail(row, KIN_RECORD_CHANGES_CAP);
}, workFailure);

const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KinAttachment)),
);

/** Files on messages in chats the owner is in, newest first: what an entry of theirs may keep. */
export const files = Effect.fn("KinMoney.files")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinWorkFilesInput,
) {
  const person = yield* theOwner(people, input.orgId);
  return yield* readableFiles(input.orgId, person.personId, input);
}, workFailure);

/** Files sent in `personId`'s chats that they may read there, newest first. */
export const readableFiles = Effect.fn("KinMoney.readableFiles")(function* (
  orgId: string,
  personId: string,
  input: Omit<KinWorkFilesInput, "orgId">,
) {
  const sql = yield* SqlClient.SqlClient;
  const offset = yield* offsetOf(input.cursor);
  const limit = input.limit ?? 30;
  const text = input.text?.trim().toLowerCase() ?? "";
  const rows = yield* sql<{
    id: string;
    chatId: string;
    messageId: string;
    json: string | null;
    sentAt: string;
  }>`SELECT a.attachment_id AS id, a.chat_id AS "chatId", a.message_id AS "messageId",
      kin_messages.attachments_json AS json, kin_messages.created_at AS "sentAt"
    FROM kin_message_attachments a
    JOIN kin_messages ON kin_messages.org_id = a.org_id
      AND kin_messages.message_id = a.message_id
    JOIN kin_chat_members c ON c.org_id = a.org_id AND c.chat_id = a.chat_id
      AND c.principal_kind = 'person' AND c.person_id = ${personId} AND c.left_at IS NULL
    WHERE a.org_id = ${orgId} AND kin_messages.status <> 'deleted'
      AND ${readableFrom(sql, orgId, sql`COALESCE(c.joined_seq, 0)`)}
      AND (${text} = '' OR EXISTS (SELECT 1
        FROM json_each(COALESCE(kin_messages.attachments_json, '[]')) j
        WHERE json_extract(j.value, '$.id') = a.attachment_id
          AND instr(lower(json_extract(j.value, '$.name')), ${text}) > 0))
    ORDER BY kin_messages.created_at DESC, a.attachment_id LIMIT ${limit + 1} OFFSET ${offset}`;
  return {
    files: rows.slice(0, limit).flatMap((row): ReadonlyArray<KinWorkFile> => {
      const found = Option.getOrElse(decodeAttachments(row.json ?? "[]"), () => []).find(
        (attachment) => attachment.id === row.id,
      );
      return found === undefined
        ? []
        : [
            {
              attachmentId: row.id,
              name: found.name,
              mimeType: found.mimeType,
              chatId: KinChatId.make(row.chatId),
              messageId: KinMessageId.make(row.messageId),
              sentAt: row.sentAt,
            },
          ];
    }),
    nextCursor: rows.length > limit ? `o:${offset + limit}` : null,
  };
});

export const companyProfile = Effect.fn("KinMoney.companyProfile")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinCompanyProfileInput,
) {
  yield* theOwner(people, input.orgId);
  return yield* readProfile(input.orgId);
}, workFailure);

export const setCompanyProfile = Effect.fn("KinMoney.setCompanyProfile")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinCompanyProfileSetInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const { orgId, rev, ...patch } = input;
  return yield* setProfile(orgId, { _tag: "person", personId: person.personId }, patch, rev);
}, workFailure);

/** Receipts for Money: newest first, each with its number, who it was from and what for. */
export const receipts = Effect.fn("KinMoney.receipts")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinReceiptsInput,
) {
  yield* theOwner(people, input.orgId);
  return { receipts: yield* listReceipts(input.orgId, { limit: input.limit ?? 100 }) };
}, workFailure);

/** The owner's tap on a payment or an advance: its receipt, numbered, with its PDF. */
export const makeReceipt = Effect.fn("KinMoney.makeReceipt")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinMakeReceiptInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const writer = ownerWriter(person);
  const made = yield* makeReceiptFor({
    orgId: input.orgId,
    writer,
    requester: { _tag: "owner", personId: person.personId, writer },
    paymentId: input.paymentId,
    key: input.key,
    advance:
      input.advance === undefined
        ? undefined
        : {
            client: input.advance.client,
            amount: input.advance.amount,
            receivedOn: input.advance.receivedOn,
            originKey: `receipt:advance:owner:${input.clientRequestId}`,
          },
    against: input.against,
    extras: { towards: input.towards, mode: input.mode, reference: input.reference },
    admit: Effect.void,
  });
  if (made.receipt === undefined)
    return yield* new KinChatError({
      reason: "unavailable",
      message: "Kin couldn't read the receipt.",
    });
  return { receipt: made.receipt, problems: made.problems };
}, workFailure);
