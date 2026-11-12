import {
  KIN_RECORD_CHANGES_CAP,
  KinChatError,
  type KinCompanyProfileInput,
  type KinCompanyProfileSetInput,
  type KinDatesInput,
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
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
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
  toDefinition,
  unknownList,
} from "./registers.ts";

/** What the owner's clients read and do with lists, money and the company profile. Owner only. */

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const millis = (value: string, field: string) => {
  const ms = Date.parse(value);
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
      const fields: ReadonlyArray<FieldDef> = def.fields.map((one) => {
        const { retired: _retired, ...kept } = one;
        return retire.has(one.key)
          ? { ...kept, retired: true as const }
          : restore.has(one.key)
            ? kept
            : one;
      });
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
      const categoryLabels = Object.fromEntries(
        Object.entries({ ...def.categoryLabels, ...input.categoryLabels }).filter(
          (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
            entry[1] !== null && entry[1] !== entry[0],
        ),
      );
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
        fields.some((one, index) => one.retired !== def.fields[index]?.retired);
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
            definition_json = ${yield* encodeDefinition(next)},
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
      m.attachments_json AS json, m.created_at AS "sentAt"
    FROM kin_message_attachments a
    JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
    JOIN kin_chat_members c ON c.org_id = a.org_id AND c.chat_id = a.chat_id
      AND c.principal_kind = 'person' AND c.person_id = ${person.personId} AND c.left_at IS NULL
    WHERE a.org_id = ${input.orgId} AND m.status <> 'deleted'
      AND (${text} = '' OR EXISTS (SELECT 1 FROM json_each(COALESCE(m.attachments_json, '[]')) j
        WHERE json_extract(j.value, '$.id') = a.attachment_id
          AND instr(lower(json_extract(j.value, '$.name')), ${text}) > 0))
    ORDER BY m.created_at DESC, a.attachment_id LIMIT ${limit + 1} OFFSET ${offset}`;
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
}, workFailure);

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
