import { KinChatError, type KinMoney, type KinOrgId } from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { CREDIT_NOTE_TAP, KinRecords, type Writer } from "../work/KinRecords.ts";
import { fieldText, parseFields } from "../work/lists.ts";
import { dayIn } from "../work/money.ts";
import { byNumber, isSuggestion, notFound, ownerZone, workFailure } from "../work/recordRows.ts";
import { defineList, listCurrency, listDef } from "../work/registers.ts";
import * as Numbers from "./numbering.ts";

const LIST = "credit_notes";
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const tapOnly = new KinChatError({ reason: "not_allowed", message: CREDIT_NOTE_TAP });

const list = Effect.fn("KinCreditNotes.list")(function* (orgId: KinOrgId) {
  if ((yield* listDef(orgId, LIST)) !== undefined) return;
  yield* defineList(
    orgId,
    {
      _tag: "new",
      id: LIST,
      name: "Credit notes",
      prefix: "CN",
      definition: {
        noun: "credit note",
        states: ["open", "waiting", "dropped"],
        stateLabels: { open: "Draft", waiting: "Issued", dropped: "Void" },
        defaultState: "open",
        categories: [],
        fields: [
          { key: "number", label: "Credit note number", type: "text", sensitive: false },
          { key: "invoice", label: "Invoice", type: "text", sensitive: false },
          { key: "reason", label: "Reason", type: "text", sensitive: false },
          { key: "file", label: "Credit note file", type: "file", sensitive: true },
        ],
        sensitive: true,
        amount: true,
        dateLabel: "Dated",
        ...(yield* listCurrency(orgId)),
        numbering: { prefix: "CN", series: "financial_year", width: 3 },
      },
    },
    yield* Clock.currentTimeMillis,
  );
});

const invoiceFor = Effect.fn("KinCreditNotes.invoiceFor")(function* (
  orgId: KinOrgId,
  key: string,
  amount: KinMoney,
) {
  const records = yield* KinRecords;
  const invoice = (yield* records.get(orgId, key)) ?? (yield* byNumber(orgId, key));
  if (invoice?.registerId !== "invoices") return yield* notFound(key);
  if (
    invoice.state !== "waiting" ||
    invoice.dateAt === null ||
    isSuggestion(invoice) ||
    fieldText(parseFields(invoice.fieldsJson), "number") === null
  )
    return yield* invalid("A credit note needs an invoice that is issued and still owed.");
  if (amount.currency !== invoice.currency)
    return yield* invalid("Enter the amount in the invoice's currency.");
  if (
    amount.minor <= 0 ||
    invoice.amountMinor === null ||
    amount.minor > invoice.amountMinor - invoice.paid
  )
    return yield* invalid("Enter an amount above zero and no more than the invoice still owes.");
  return invoice;
});

const draft = Effect.fn("KinCreditNotes.draft")(function* (
  orgId: KinOrgId,
  writer: Writer,
  input: {
    readonly invoice: string;
    readonly amount: KinMoney;
    readonly reason: string;
    readonly originKey: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        writer.view !== undefined ||
        writer.codingAgentKey !== undefined ||
        writer.actor._tag === "system" ||
        (writer.actor._tag === "person" && !(yield* ownerLevel(orgId, writer.actor.personId)))
      )
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner or a co-owner can make a credit note.",
        });
      const reason = input.reason.trim();
      if (reason === "") return yield* invalid("Add the reason for this credit note.");
      const originKey = `credit-note-draft:${writer.actor._tag}:${writer.actor._tag === "person" ? writer.actor.personId : writer.actor.agentId}:${input.originKey}`;
      const [existing] = yield* sql<{ key: string }>`SELECT key FROM kin_records
      WHERE org_id = ${orgId} AND register_id = ${LIST} AND origin_key = ${originKey}`;
      const requestHash = stableStringify([
        input.invoice,
        input.amount.minor,
        input.amount.currency,
        reason,
      ]);
      const note = existing === undefined ? undefined : yield* records.get(orgId, existing.key);
      if (note !== undefined) {
        const [same] = yield* sql`SELECT 1 FROM kin_records WHERE org_id = ${orgId}
        AND record_id = ${note.recordId} AND request_hash = ${requestHash}`;
        if (same === undefined)
          return yield* new KinChatError({
            reason: "not_allowed",
            message: "That retry key already created a different entry.",
          });
        return { row: note, created: false };
      }
      const invoice = yield* invoiceFor(orgId, input.invoice, input.amount);
      yield* list(orgId);
      return yield* records.create(
        orgId,
        { ...writer, creditNote: true },
        {
          list: LIST,
          originKey,
          requestHash,
          title: `Credit note for ${fieldText(parseFields(invoice.fieldsJson), "number") ?? invoice.key}`,
          owner: writer.actor,
          amount: input.amount,
          state: "open",
          partyId: invoice.partyId,
          fields: { invoice: invoice.key, reason },
          links: [
            { kind: "record", target: invoice.recordId, relation: "relates", label: invoice.key },
          ],
        },
      );
    }),
  );
}, workFailure);

const authorized = Effect.fn("KinCreditNotes.authorized")(function* (
  orgId: KinOrgId,
  writer: Writer,
) {
  if (
    writer.actor._tag !== "person" ||
    writer.codingAgentKey !== undefined ||
    !(yield* ownerLevel(orgId, writer.actor.personId))
  )
    return yield* tapOnly;
  return { ...writer, creditNote: true } as const;
});

const issue = Effect.fn("KinCreditNotes.issue")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const by = yield* authorized(orgId, writer);
      const note = yield* records.get(orgId, key);
      if (note?.registerId !== LIST) return yield* notFound(key);
      if ((yield* Numbers.issuedNumber(orgId, note.recordId)) !== undefined)
        return yield* Numbers.issue(orgId, by, note.key);
      const { invoice: invoiceKey, reason } = parseFields(note.fieldsJson);
      if (typeof reason !== "string" || reason.trim() === "")
        return yield* invalid("Add the reason for this credit note.");
      if (note.amountMinor === null || note.currency === null || typeof invoiceKey !== "string")
        return yield* invalid(
          "This credit note has no invoice or amount. Void it and make a new one from the invoice.",
        );
      const amount = { minor: note.amountMinor, currency: note.currency };
      const invoice = yield* invoiceFor(orgId, invoiceKey, amount);
      if (invoice.partyId !== note.partyId)
        return yield* invalid(
          "The invoice now has a different client. Void this credit note and make a new one.",
        );
      const issued = yield* Numbers.issue(orgId, by, note.key);
      if (issued.number === null)
        return yield* invalid("Kin couldn't issue the credit note. Try again.");
      yield* records.pay(orgId, by, invoice.key, {
        amount,
        paidOn: dayIn(yield* Clock.currentTimeMillis, yield* ownerZone(orgId)),
        note: issued.number,
        withheld: true,
        originKey: `credit_note:${note.recordId}`,
      });
      return issued;
    }),
  );
}, workFailure);

const voidEntry = Effect.fn("KinCreditNotes.void")(function* (
  orgId: KinOrgId,
  writer: Writer,
  key: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const by = yield* authorized(orgId, writer);
      const note = yield* records.get(orgId, key);
      if (note?.registerId !== LIST) return yield* notFound(key);
      const voided = yield* Numbers.voidEntry(orgId, by, note.key);
      const [payment] = yield* sql<{ key: string; id: string }>`SELECT r.key, p.payment_id AS id
      FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
      WHERE p.org_id = ${orgId} AND p.voided_at IS NULL AND p.origin_key = ${`credit_note:${note.recordId}`}`;
      if (payment !== undefined) yield* records.voidPayment(orgId, by, payment.key, payment.id);
      return voided;
    }),
  );
}, workFailure);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const services = Context.make(SqlClient.SqlClient, sql).pipe(Context.add(KinRecords, records));
  return {
    draft: (...args: Parameters<typeof draft>) => draft(...args).pipe(Effect.provide(services)),
    issue: (...args: Parameters<typeof issue>) => issue(...args).pipe(Effect.provide(services)),
    voidEntry: (...args: Parameters<typeof voidEntry>) =>
      voidEntry(...args).pipe(Effect.provide(services)),
  };
});

export class CreditNotes extends Context.Service<CreditNotes, Effect.Success<typeof make>>()(
  "t3/kin/gendocs/creditNotes",
) {}

export const layer = Layer.effect(CreditNotes, make);
