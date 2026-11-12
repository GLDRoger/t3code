import {
  KinChatError,
  type KinMoney,
  type KinOrgId,
  type KinReceipt,
  KinRecordId,
  KinRecordKey,
  type KinRecordState,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { dayIn, formatMoney } from "../work/money.ts";
import {
  endOfDay,
  fromImport,
  notedReceiptNumbers,
  ownerZone,
  type RecordRow,
} from "../work/recordRows.ts";
import { parseFields } from "../work/lists.ts";
import { defineList, listDef, PRESETS } from "../work/registers.ts";
import { makeDocument, type Requester } from "./make.ts";
import * as Numbers from "./numbering.ts";

/**
 * Receipts: money received, numbered in their own series per financial year, made at most once.
 * One for a payment keeps a number the old system gave it in an imported payment's note; an
 * advance is set against an invoice later as a payment on it. Only this module ties a receipt
 * to its payment and invoice.
 */

const RECEIPTS = "receipts";
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isChatError = Schema.is(KinChatError);
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
/** `QST-RN/2026-27/001`: a number another system issued, by its shape. */
const ISSUED_SHAPE = /^([A-Za-z][A-Za-z0-9-]{0,7})\/(?:\d{2})?\d{2}-\d{2}\/(\d{1,9})$/;

const principalOf = (writer: Writer): KinWorkPrincipal | undefined =>
  writer.actor._tag === "person"
    ? { _tag: "person", personId: writer.actor.personId }
    : writer.actor._tag === "agent"
      ? { _tag: "agent", agentId: writer.actor.agentId }
      : undefined;

/**
 * The receipts list, made from Kin's preset the first time the owner asks for a receipt. Its
 * series takes the prefix the old system's receipt numbers carry, so Kin continues that series.
 */
const receiptsList = Effect.fn("KinReceipts.list")(function* (orgId: KinOrgId) {
  const existing = yield* listDef(orgId, RECEIPTS);
  if (existing !== undefined) return existing;
  const sql = yield* SqlClient.SqlClient;
  const notes = yield* sql<{ note: string }>`SELECT note FROM kin_record_payments
    WHERE org_id = ${orgId} AND origin_key LIKE 'import:%' AND note LIKE '%/%-%/%'
    ORDER BY payment_id LIMIT 10000`;
  const numbers = yield* notedReceiptNumbers(
    orgId,
    notes.map((row) => row.note),
  );
  const seen = new Map<string, { count: number; width: number }>();
  for (const number of new Set(numbers.values())) {
    const found = ISSUED_SHAPE.exec(number);
    // One Kin couldn't write in its own form, `QST-RN/26-27/001`, says nothing of the series.
    if (found === null || `${found[1]}/26-27/${found[2]}`.length > Numbers.MAX_NUMBER_LENGTH)
      continue;
    const one = seen.get(found[1]!) ?? { count: 0, width: 1 };
    seen.set(found[1]!, {
      count: one.count + 1,
      width: Math.max(one.width, Math.min(6, found[2]!.length)),
    });
  }
  const [prefix, usual] = [...seen.entries()].toSorted((a, b) => b[1].count - a[1].count)[0] ?? [];
  const preset = PRESETS.receipts;
  const numbering =
    prefix === undefined || usual === undefined
      ? preset.numbering!
      : { prefix, series: "financial_year" as const, width: usual.width };
  yield* defineList(
    orgId,
    {
      _tag: "new",
      id: RECEIPTS,
      name: preset.name,
      prefix: preset.prefix,
      definition: {
        noun: preset.noun,
        states: preset.states,
        stateLabels: preset.stateLabels,
        defaultState: preset.defaultState,
        categories: preset.categories,
        fields: preset.fields,
        sensitive: preset.sensitive,
        amount: preset.amount,
        currency: preset.currency,
        ...(preset.dueLabel === undefined ? {} : { dueLabel: preset.dueLabel }),
        ...(preset.dateLabel === undefined ? {} : { dateLabel: preset.dateLabel }),
        numbering,
      },
    },
    yield* Clock.currentTimeMillis,
  ).pipe(
    // Two first receipts at once: the other made it, which is the same list.
    Effect.catchIf(
      (error) => isChatError(error) && error.reason === "conflict",
      () => Effect.void,
    ),
  );
  const made = yield* listDef(orgId, RECEIPTS);
  if (made === undefined) return yield* invalid("Kin couldn't make the receipts list.");
  return made;
});

/** The number a receipt is given: the one its payment's note already holds, else the next. */
const numberReceipt = Effect.fn("KinReceipts.number")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
  noted: string | undefined,
) {
  if (noted !== undefined) {
    const adopted = yield* Numbers.adopt(orgId, writer, key, noted).pipe(
      Effect.map((issued) => ({ issued, problem: undefined })),
      Effect.catchIf(isChatError, (error) =>
        Effect.succeed({ issued: undefined, problem: error.message }),
      ),
    );
    if (adopted.issued !== undefined) return { ...adopted.issued, problem: undefined };
    const fresh = yield* Numbers.issue(orgId, writer, key);
    return {
      ...fresh,
      problem: `Kin couldn't keep ${noted} from the payment's note (${adopted.problem}), so it gave ${fresh.number}.`,
    };
  }
  return { ...(yield* Numbers.issue(orgId, writer, key)), problem: undefined };
});

type PaymentRow = {
  readonly paymentId: string;
  readonly minor: number;
  readonly currency: string;
  readonly paidOn: string;
  readonly note: string;
  readonly originKey: string;
  readonly voidedAt: number | null;
  readonly invoiceId: string;
  readonly invoiceKey: string;
  readonly invoiceNumber: string | null;
  readonly partyId: string | null;
};

/** The receipts entry Kin already made for a payment: only Kin's own carry a `receipt:` origin. */
const receiptOfPayment = Effect.fn("KinReceipts.ofPayment")(function* (
  orgId: KinOrgId,
  paymentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ key: string; state: string }>`SELECT key, state FROM kin_records
    WHERE org_id = ${orgId} AND register_id = ${RECEIPTS} AND origin_key LIKE 'receipt:%'
      AND json_extract(fields_json, '$.payment') = ${paymentId}
    ORDER BY created_at, record_id LIMIT 100`;
  // A voided receipt stays void; the payment may get a new one, made once per voided one.
  return {
    key: rows.find((row) => row.state !== "dropped")?.key,
    voided: rows.filter((row) => row.state === "dropped").length,
  };
});

export type Extras = {
  readonly towards?: string | undefined;
  readonly mode?: string | undefined;
  readonly reference?: string | undefined;
};

/**
 * Ties a receipt to its payment and the payment's invoice, logged as a change. Written here only:
 * `KinRecords` refuses these fields from every other writer, so no one can point a receipt.
 */
const tie = Effect.fn("KinReceipts.tie")(function* (
  orgId: KinOrgId,
  writer: Writer,
  receipt: RecordRow,
  to: { readonly invoice: string; readonly payment: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const fields = parseFields(receipt.fieldsJson);
  const changes = (["invoice", "payment"] as const)
    .filter((field) => fields[field] !== to[field])
    .map((field) => ({ field, from: text(fields[field]), to: to[field] }));
  if (changes.length === 0) return;
  yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json,
      '$.invoice', ${to.invoice}, '$.payment', ${to.payment})
    WHERE org_id = ${orgId} AND record_id = ${receipt.recordId}`;
  yield* records.update(orgId, writer, receipt.key, {}, undefined, changes);
});

/** The receipt for a payment recorded on an invoice: made once, numbered, kept. */
const forPayment = Effect.fn("KinReceipts.forPayment")(function* (
  orgId: KinOrgId,
  writer: Writer,
  paymentId: string,
  extras: Extras,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const [payment] = yield* sql<PaymentRow>`SELECT p.payment_id AS "paymentId",
      p.amount_minor AS minor, p.currency, p.paid_on AS "paidOn", p.note,
      p.origin_key AS "originKey", p.voided_at AS "voidedAt", r.record_id AS "invoiceId", r.key AS "invoiceKey",
      n.number AS "invoiceNumber", r.party_id AS "partyId"
    FROM kin_record_payments p
    JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
    WHERE p.org_id = ${orgId} AND p.payment_id = ${paymentId}`;
  if (payment === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No payment ${paymentId.slice(0, 40)}. Read the invoice with record_get for its payments.`,
    });
  if (payment.voidedAt !== null)
    return yield* invalid("That payment was taken back, so it gets no receipt.");
  yield* receiptsList(orgId);
  const made = yield* receiptOfPayment(orgId, paymentId);
  if (made.key !== undefined) return yield* settle(orgId, writer, made.key, undefined);
  const owner = principalOf(writer);
  if (owner === undefined) return yield* invalid("Only the owner or an agent makes a receipt.");
  const zone = yield* ownerZone(orgId);
  const against = payment.invoiceNumber ?? payment.invoiceKey;
  const row = yield* sql.withTransaction(
    Effect.gen(function* () {
      const { row } = yield* records.create(orgId, writer, {
        list: RECEIPTS,
        originKey: `receipt:payment:${paymentId}${made.voided === 0 ? "" : `:${made.voided}`}`,
        title: `Received towards ${against}`,
        owner,
        state: "open",
        amount: { minor: payment.minor, currency: payment.currency },
        dateAt: endOfDay(payment.paidOn, zone),
        dateAllDay: true,
        partyId: payment.partyId,
        fields: {
          towards: extras.towards ?? `Invoice ${against}`,
          ...(extras.mode === undefined ? {} : { mode: extras.mode }),
          ...(extras.reference === undefined ? {} : { reference: extras.reference }),
        },
        links: [
          {
            kind: "record",
            target: payment.invoiceId,
            relation: "relates",
            label: payment.invoiceKey,
          },
        ],
      });
      yield* tie(orgId, writer, row, { invoice: payment.invoiceKey, payment: paymentId });
      return row;
    }),
  );
  // A number the old system gave goes to the payment's first receipt only.
  const noted =
    made.voided === 0 && fromImport(payment)
      ? (yield* notedReceiptNumbers(orgId, [payment.note])).get(payment.note)
      : undefined;
  return yield* settle(orgId, writer, row.key, noted);
});

/** A receipts entry numbered: kept as it is when it has one. */
const settle = Effect.fn("KinReceipts.settle")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
  noted: string | undefined,
) {
  const records = yield* KinRecords;
  const row = yield* records.get(orgId, key);
  if (row === undefined || row.registerId !== RECEIPTS)
    return yield* invalid(`${key} isn't a receipt. Nothing changed.`);
  if (row.state === "dropped") return yield* invalid(`${row.key} is void; make a new receipt.`);
  const had = yield* Numbers.issuedNumber(orgId, row.recordId);
  if (had !== undefined) return { key: row.key, number: had, problem: undefined };
  const numbered = yield* numberReceipt(orgId, writer, row.key, noted);
  return { key: numbered.key, number: numbered.number, problem: numbered.problem };
});

/**
 * An advance: money received from a client before any invoice, as a new receipt. Made once per
 * `originKey`; set against an invoice later with `setAgainst`.
 */
const forAdvance = Effect.fn("KinReceipts.forAdvance")(function* (
  orgId: KinOrgId,
  writer: Writer,
  advance: {
    readonly client: string | undefined;
    readonly amount: KinMoney;
    readonly receivedOn: string;
    readonly originKey: string;
  },
  extras: Extras,
) {
  const records = yield* KinRecords;
  yield* receiptsList(orgId);
  const owner = principalOf(writer);
  if (owner === undefined) return yield* invalid("Only the owner or an agent makes a receipt.");
  const client =
    advance.client === undefined ? undefined : yield* records.get(orgId, advance.client);
  if (advance.client !== undefined && (client === undefined || client.registerId !== "clients"))
    return yield* invalid(`${advance.client} isn't a client here. Nothing was made.`);
  const zone = yield* ownerZone(orgId);
  const { row } = yield* records.create(orgId, writer, {
    list: RECEIPTS,
    originKey: advance.originKey,
    title: `Advance${client === undefined ? "" : ` from ${client.title}`}`,
    owner,
    state: "open",
    amount: advance.amount,
    dateAt: endOfDay(advance.receivedOn, zone),
    dateAllDay: true,
    partyId: client?.recordId ?? null,
    fields: {
      towards: extras.towards ?? "Advance",
      ...(extras.mode === undefined ? {} : { mode: extras.mode }),
      ...(extras.reference === undefined ? {} : { reference: extras.reference }),
    },
  });
  return yield* settle(orgId, writer, row.key, undefined);
});

/** A receipts entry, such as an advance the owner recorded, numbered. */
const forEntry = Effect.fn("KinReceipts.forEntry")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  yield* receiptsList(orgId);
  return yield* settle(orgId, writer, key, undefined);
});

/**
 * Sets an advance receipt against an invoice of the same client: a payment on the invoice of the
 * receipt's whole amount on the day it was received, its note the receipt's number. Once only,
 * to one invoice, and never more than the invoice still owes.
 */
const setAgainst = Effect.fn("KinReceipts.setAgainst")(function* (
  orgId: KinOrgId,
  writer: Writer,
  receiptKey: string,
  invoiceKey: string,
) {
  const records = yield* KinRecords;
  const receipt = yield* records.get(orgId, receiptKey);
  if (receipt === undefined || receipt.registerId !== RECEIPTS)
    return yield* invalid(`${receiptKey} isn't a receipt. Nothing changed.`);
  const fields = parseFields(receipt.fieldsJson);
  const invoice = yield* records.get(orgId, invoiceKey);
  if (invoice === undefined) return yield* invalid(`No entry ${invoiceKey}. Nothing changed.`);
  if (receipt.partyId === null)
    return yield* invalid(
      `${receipt.key} names no client, so it can't be set against an invoice. Nothing changed.`,
    );
  const sql = yield* SqlClient.SqlClient;
  const held = typeof fields.payment === "string" ? fields.payment : undefined;
  if (held !== undefined) {
    const [payment] = yield* sql<{ voidedAt: number | null }>`SELECT voided_at AS "voidedAt"
      FROM kin_record_payments WHERE org_id = ${orgId} AND payment_id = ${held}`;
    // Once its payment is taken back, the advance may be set against an invoice again.
    if (payment !== undefined && payment.voidedAt === null) {
      if (fields.invoice === invoice.key) return receipt.key;
      return yield* invalid(
        `${receipt.key} is already set against ${String(fields.invoice)}. Nothing changed.`,
      );
    }
  }
  if (receipt.amountMinor === null || receipt.currency === null || receipt.dateAt === null)
    return yield* invalid(`${receipt.key} has no amount or date to set against an invoice.`);
  if (invoice.partyId !== receipt.partyId)
    return yield* invalid(
      `${receipt.key} was received from another client than ${invoice.key}'s. Nothing changed.`,
    );
  const advance = { minor: receipt.amountMinor, currency: receipt.currency };
  if (invoice.amountMinor !== null) {
    const owed = { minor: invoice.amountMinor - invoice.paid, currency: invoice.currency ?? "" };
    if (owed.currency !== advance.currency || owed.minor < advance.minor)
      return yield* invalid(
        `${invoice.key} has ${formatMoney(owed)} left to pay, less than the ${formatMoney(advance)} advance ${receipt.key}. Nothing changed.`,
      );
  }
  const number = (yield* Numbers.issuedNumber(orgId, receipt.recordId)) ?? receipt.key;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const { paymentId } = yield* records.pay(orgId, writer, invoice.key, {
        amount: advance,
        paidOn: dayIn(receipt.dateAt!, yield* ownerZone(orgId)),
        note: number,
        originKey: `receipt:${receipt.recordId}${held === undefined ? "" : `:after:${held}`}`,
      });
      yield* records.link(orgId, writer, receipt.recordId, {
        kind: "record",
        target: invoice.recordId,
        relation: "relates",
        label: invoice.key,
      });
      yield* tie(orgId, writer, receipt, { invoice: invoice.key, payment: paymentId });
      return receipt.key;
    }),
  );
});

/** The receipt and its PDF, made with the `receipt` recipe; a retry makes nothing more. */
export const makeReceipt = Effect.fn("KinReceipts.make")(function* (input: {
  readonly orgId: KinOrgId;
  readonly writer: Writer;
  readonly requester: Requester;
  readonly paymentId?: string | undefined;
  readonly key?: string | undefined;
  readonly advance?:
    | {
        readonly client: string | undefined;
        readonly amount: KinMoney;
        readonly receivedOn: string;
        readonly originKey: string;
      }
    | undefined;
  readonly against?: string | undefined;
  readonly extras: Extras;
  readonly admit: Effect.Effect<void, KinChatError, SqlClient.SqlClient>;
}) {
  const asked = [input.paymentId, input.key, input.advance].filter((one) => one !== undefined);
  if (asked.length !== 1)
    return yield* invalid(
      "Name one of: the payment (its paymentId), a receipts entry (its key), or an advance received. Nothing was made.",
    );
  const numbered =
    input.paymentId !== undefined
      ? yield* forPayment(input.orgId, input.writer, input.paymentId, input.extras)
      : input.advance !== undefined
        ? yield* forAdvance(input.orgId, input.writer, input.advance, input.extras)
        : yield* forEntry(input.orgId, input.writer, input.key!);
  if (input.against !== undefined)
    yield* setAgainst(input.orgId, input.writer, numbered.key, input.against);
  const problems = numbered.problem === undefined ? [] : [numbered.problem];
  const made = yield* makeDocument({
    orgId: input.orgId,
    recipe: "receipt",
    entry: numbered.key,
    given: {},
    title: `Receipt ${numbered.number ?? numbered.key}`,
    requester: input.requester,
    jobKey: `receipt:${numbered.key}:${numbered.number ?? ""}`,
    admit: input.admit,
  }).pipe(
    Effect.catchIf(isChatError, (error) =>
      Effect.sync(() => problems.push(error.message)).pipe(Effect.as(undefined)),
    ),
  );
  return {
    key: numbered.key,
    number: numbered.number,
    made,
    problems,
    receipt: (yield* listReceipts(input.orgId, { key: numbered.key }))[0],
  };
});

type ReceiptRow = {
  readonly key: string;
  readonly number: string | null;
  readonly state: KinRecordState;
  readonly dateAt: number | null;
  readonly minor: number | null;
  readonly currency: string | null;
  readonly fieldsJson: string;
  readonly partyId: string | null;
  readonly partyKey: string | null;
  readonly partyTitle: string | null;
  readonly docKey: string | null;
  readonly docTitle: string | null;
  readonly originKey: string;
  readonly invoiceKey: string | null;
};

/** Receipts as a screen shows them, newest first: number, who from, towards, its invoice and PDF. */
export const listReceipts = Effect.fn("KinReceipts.listReceipts")(function* (
  orgId: KinOrgId,
  options: { readonly limit?: number; readonly key?: string } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const rows = yield* sql<ReceiptRow>`SELECT r.key, n.number, r.state, r.date_at AS "dateAt",
      r.amount_minor AS minor, r.currency, r.fields_json AS "fieldsJson", r.party_id AS "partyId",
      p.key AS "partyKey", p.title AS "partyTitle", d.key AS "docKey", d.title AS "docTitle",
      r.origin_key AS "originKey", i.key AS "invoiceKey"
    FROM kin_records r
    LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
    LEFT JOIN kin_record_payments pay ON pay.org_id = r.org_id
      AND pay.payment_id = json_extract(r.fields_json, '$.payment')
    LEFT JOIN kin_records i ON i.org_id = pay.org_id AND i.record_id = pay.record_id
    LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.party_id
    LEFT JOIN kin_records d ON d.org_id = r.org_id AND d.record_id = (
      SELECT v.record_id FROM kin_doc_jobs j
      JOIN kin_doc_versions v ON v.org_id = j.org_id AND v.worker_id = j.worker_id
      WHERE j.org_id = r.org_id AND j.entry_record_id = r.record_id AND j.recipe = 'receipt'
      ORDER BY j.created_at DESC LIMIT 1)
    WHERE r.org_id = ${orgId} AND r.register_id = ${RECEIPTS}
      ${options.key === undefined ? sql`` : sql`AND r.key = ${options.key}`}
    ORDER BY r.date_at DESC, r.key DESC LIMIT ${options.limit ?? 100}`;
  return rows.map((row): KinReceipt => {
    const fields = parseFields(row.fieldsJson);
    // By its payment's invoice id, so a key used again later never points it elsewhere.
    const invoice = row.invoiceKey;
    const payment = text(fields.payment);
    return {
      key: KinRecordKey.make(row.key),
      number: row.number,
      state: row.state,
      receivedOn: row.dateAt === null ? null : dayIn(row.dateAt, zone),
      amount:
        row.minor === null || row.currency === null
          ? null
          : { minor: row.minor, currency: row.currency },
      receivedFrom:
        row.partyId === null || row.partyKey === null || row.partyTitle === null
          ? null
          : {
              recordId: KinRecordId.make(row.partyId),
              key: KinRecordKey.make(row.partyKey),
              title: row.partyTitle,
            },
      towards: text(fields.towards),
      mode: text(fields.mode),
      reference: text(fields.reference),
      invoice: invoice === null ? null : KinRecordKey.make(invoice),
      paymentId: payment,
      // Made on its own, not for a payment an invoice already had: an advance.
      advance: !row.originKey.startsWith("receipt:payment:"),
      document:
        row.docKey === null || row.docTitle === null
          ? null
          : { key: KinRecordKey.make(row.docKey), title: row.docTitle },
    };
  });
});
