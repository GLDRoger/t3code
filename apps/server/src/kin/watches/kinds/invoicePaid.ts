import { formatKinWhen, KIN_TEXT_LOCALE, KinAgentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { invoiceAsides } from "../../pulse/invoiceAsides.ts";
import { countedEntry, invoiceDue, issuedNumber } from "../../work/recordRows.ts";
import { KIN_OWNER_LEVEL } from "../../work/teamView.ts";
import type { WatchKind } from "./kind.ts";
import { possessive, recordMoved } from "./shared.ts";

/** An invoice by its number when issued, else its key. */
const nameOf = (row: { readonly key: string; readonly number: unknown }) =>
  issuedNumber(row.number).number ?? row.key;

/**
 * An overdue invoice, found from the pulse's `invoice_overdue` fact. It closes when the invoice is
 * paid in full (or marked done), sleeps while it is set aside, and is gone with the invoice.
 */
export const invoicePaid: WatchKind = {
  kind: "invoice_paid",
  source: "sense",
  reach: "money",
  checksWork: false,
  find: Effect.fn("KinWatch.invoicePaid.find")(function* (ctx) {
    const sql = yield* SqlClient.SqlClient;
    // Still owed now: a fact the pulse hasn't cleared yet finds nothing once it is paid.
    const rows = yield* sql<{
      recordId: string;
      key: string;
      number: unknown;
      clientTitle: string | null;
    }>`SELECT r.record_id AS "recordId", r.key, json_extract(r.fields_json, '$.number') AS number,
        c.title AS "clientTitle"
      FROM kin_pulse_facts f
      JOIN kin_records r ON r.org_id = f.org_id AND r.record_id = f.subject_record_id
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = COALESCE(r.party_id, p.party_id)
      WHERE f.org_id = ${ctx.orgId} AND f.sense = 'invoice_overdue' AND f.cleared_at IS NULL
        AND r.register_id = 'invoices' AND r.state = 'waiting' AND ${countedEntry(sql)}
        AND r.amount_minor > (SELECT COALESCE(SUM(pay.amount_minor), 0) FROM kin_record_payments pay
          WHERE pay.org_id = r.org_id AND pay.record_id = r.record_id AND pay.voided_at IS NULL)
      ORDER BY r.record_id`;
    return rows.map((row) => {
      const name = nameOf(row);
      return {
        sourceKey: row.recordId,
        recordId: row.recordId,
        subjectRef: null,
        about: (row.clientTitle === null ? name : `${possessive(row.clientTitle)} ${name}`).slice(
          0,
          200,
        ),
        closesWhen: `${name} is marked paid`.slice(0, 200),
        agentId: ctx.finance === undefined ? null : KinAgentId.make(ctx.finance),
        why: `${name} is overdue`.slice(0, 200),
      };
    });
  }),
  moved: recordMoved,
  asleep: Effect.fn("KinWatch.invoicePaid.asleep")(function* (ctx, watches) {
    const sql = yield* SqlClient.SqlClient;
    const ids = watches.flatMap((watch) => (watch.recordId === null ? [] : [watch.recordId]));
    if (ids.length === 0) return new Map<string, number | null>();
    const invoices = yield* sql<{
      recordId: string;
      key: string;
      dueAt: number | null;
      partyId: string | null;
    }>`SELECT r.record_id AS "recordId", r.key, ${invoiceDue(sql)} AS "dueAt",
        r.party_id AS "partyId"
      FROM kin_records r WHERE r.org_id = ${ctx.orgId} AND r.record_id IN ${sql.in(ids)}
      ORDER BY r.record_id`;
    // The company's own asides: a watch is the owner level's, whoever reads it later.
    const asides = yield* invoiceAsides({
      orgId: ctx.orgId,
      at: ctx.at,
      viewer: KIN_OWNER_LEVEL,
      invoices,
    });
    return new Map(
      watches.flatMap((watch) => {
        const aside = watch.recordId === null ? undefined : asides.get(watch.recordId);
        return aside === undefined ? [] : [[watch.watchId, aside.until] as const];
      }),
    );
  }),
  check: Effect.fn("KinWatch.invoicePaid.check")(function* (ctx, watch) {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{
      key: string;
      number: unknown;
      state: string;
      confirmed: number;
      amountMinor: number | null;
      paid: number;
      paidOn: string | null;
      updatedAt: number;
    }>`SELECT r.key, json_extract(r.fields_json, '$.number') AS number, r.state, r.confirmed,
        r.amount_minor AS "amountMinor", r.updated_at AS "updatedAt",
        (SELECT COALESCE(SUM(pay.amount_minor), 0) FROM kin_record_payments pay
          WHERE pay.org_id = r.org_id AND pay.record_id = r.record_id AND pay.voided_at IS NULL) AS paid,
        (SELECT MAX(pay.paid_on) FROM kin_record_payments pay
          WHERE pay.org_id = r.org_id AND pay.record_id = r.record_id AND pay.voided_at IS NULL) AS "paidOn"
      FROM kin_records r WHERE r.org_id = ${ctx.orgId} AND r.record_id = ${watch.recordId ?? ""}`;
    if (row === undefined || row.state === "dropped" || row.confirmed !== 1)
      return { _tag: "closed", how: `no longer applies: ${watch.about} was removed`, evidence: [] };
    const name = nameOf(row);
    const evidence = [{ kind: "record", id: row.key }];
    const paidInFull = row.amountMinor !== null && row.paid >= row.amountMinor;
    if (!paidInFull && row.state !== "done") return { _tag: "nothing_new", evidence };
    // `paid_on` is the owner's calendar day; read at noon UTC it names that day in any zone.
    const day =
      row.paidOn === null
        ? formatKinWhen(row.updatedAt, "date", { zone: ctx.zone, locale: KIN_TEXT_LOCALE })
        : formatKinWhen(Date.parse(`${row.paidOn}T12:00:00Z`), "date", {
            zone: "UTC",
            locale: KIN_TEXT_LOCALE,
          });
    return { _tag: "closed", how: `${name} was paid on ${day}`, evidence };
  }),
};
