import { KinRecordId, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { billingClientFromProject } from "../work/billTo.ts";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevelPeople } from "../people/KinAccess.ts";
import { dayIn } from "../work/money.ts";
import { issuedNumber, owedInvoices, ownerZone } from "../work/recordRows.ts";
import { seenBy, type KinViewer } from "../work/teamView.ts";
import { asideOf, liveHolds } from "./holds.ts";
import { thresholds, toMs } from "./thresholds.ts";

/** Why an overdue invoice is not raised now: until when (null until lifted), and by whom. */
export interface InvoiceAside {
  readonly until: number | null;
  readonly by: string;
}

/**
 * The overdue invoices set aside for `viewer` at `at`, by record id: held (`kin_holds`, on the
 * invoice or its client or project), or its `invoice_overdue` fact in someone's hand (`pulse_handle`),
 * as `KinPulse.read` counts each. When its day passes it is no longer here.
 */
export const invoiceAsides = Effect.fn("KinInvoiceAsides.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly viewer: KinViewer;
  readonly invoices: ReadonlyArray<{
    readonly recordId: string;
    readonly key: string;
    readonly dueAt: number | null;
    readonly partyId: string | null;
  }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  const found = new Map<string, InvoiceAside>();
  if (input.invoices.length === 0) return found;
  const ids = input.invoices.map((one) => one.recordId);
  const names = new Map(
    (yield* sql<{ kind: string; id: string; name: string }>`SELECT 'agent' AS kind,
        agent_id AS id, display_name AS name FROM kin_agents WHERE org_id = ${orgId}
      UNION ALL SELECT 'person', person_id, display_name FROM kin_people WHERE org_id = ${orgId}
      ORDER BY kind, id`).map((row) => [`${row.kind}:${row.id}`, row.name]),
  );
  const nameOf = (kind: string, id: string) => names.get(`${kind}:${id}`) ?? "someone";
  const reader =
    input.viewer._tag === "ownerLevel"
      ? ({ _tag: "owner" } as const)
      : ({ _tag: "people", people: input.viewer.people } as const);
  const holds = yield* liveHolds(orgId, at);
  const scopes = yield* sql<{
    recordId: string;
    projectKey: string | null;
    clientKey: string | null;
  }>`
    SELECT r.record_id AS "recordId", p.key AS "projectKey", c.key AS "clientKey"
    FROM kin_records r
    LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
    LEFT JOIN kin_records c ON c.org_id = r.org_id AND c.record_id = ${billingClientFromProject(sql, sql`p.party_id`)}
    WHERE r.org_id = ${orgId} AND r.record_id IN ${sql.in(ids)}
    ORDER BY r.record_id`;
  for (const row of scopes) {
    const hold = asideOf(
      {
        subject: { kind: "record", key: "", title: "", recordId: KinRecordId.make(row.recordId) },
        scope: {
          ...(row.clientKey === null ? {} : { clientKey: row.clientKey }),
          ...(row.projectKey === null ? {} : { projectKey: row.projectKey }),
        },
      },
      holds,
      reader,
    );
    if (hold === undefined) continue;
    const by = nameOf(hold.byKind, hold.byId);
    found.set(row.recordId, {
      until: hold.until,
      by: hold.onWordOf === null ? by : `${by} on ${nameOf("person", hold.onWordOf)}'s word`,
    });
  }
  // The fact's key carries the day it fell due, as `senses/money.ts` writes it.
  const keyed = new Map<string, (typeof input.invoices)[number]>(
    input.invoices.flatMap((one) =>
      one.dueAt === null ? [] : [[`invoice_overdue:${one.key}:base=${one.dueAt}`, one] as const],
    ),
  );
  if (keyed.size === 0) return found;
  const level = input.viewer._tag === "ownerLevel" ? yield* ownerLevelPeople(orgId) : undefined;
  const limits = yield* thresholds(orgId);
  const handled = yield* sql<{
    key: string;
    byKind: string;
    byId: string;
    handledAt: number;
    until: number | null;
  }>`SELECT fact_key AS key, handled_by_kind AS "byKind", handled_by_id AS "byId",
      handled_at AS "handledAt", handled_until AS until
    FROM kin_pulse_facts
    WHERE org_id = ${orgId} AND fact_key IN ${sql.in([...keyed.keys()])}
      AND handled_by_kind IS NOT NULL AND handled_by_id IS NOT NULL AND handled_at IS NOT NULL
    ORDER BY fact_key`;
  for (const row of handled) {
    const invoice = keyed.get(row.key)!;
    if (found.has(invoice.recordId)) continue;
    // As `KinPulse` reads a handle: "not a problem" lasts until the next chase is due.
    const ends =
      row.until ??
      row.handledAt + toMs(limits("chase_invoice_after_days", invoice.partyId ?? undefined));
    if (ends <= at) continue;
    const theirs =
      level === undefined
        ? row.byKind === "person" &&
          input.viewer._tag === "people" &&
          input.viewer.people.some((person) => person === row.byId)
        : row.byKind === "agent" || level.has(row.byId);
    if (!theirs) continue;
    found.set(invoice.recordId, { until: ends, by: nameOf(row.byKind, row.byId) });
  }
  return found;
});

/** An overdue invoice set aside, as an agent's money data reads it. */
export interface SetAsideInvoice {
  readonly invoice: string;
  readonly number?: string;
  readonly client: string;
  readonly owed: { readonly minor: number; readonly currency: string };
  readonly daysOverdue: number;
  readonly until: string;
  readonly by: string;
}

/**
 * The overdue invoices set aside for `viewer`, as the money data in an agent's prompt marks them:
 * so it leaves them out of what it raises, and can still answer when asked.
 */
export const setAsideOverdue = Effect.fn("KinInvoiceAsides.overdue")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
  readonly viewer: KinViewer;
  readonly clientsOn?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const owed = (yield* owedInvoices({
    orgId: input.orgId,
    now: input.now,
    seen: seenBy(sql, input.viewer),
  })).filter((one) => one.overdue);
  const asides = yield* invoiceAsides({
    orgId: input.orgId,
    at: input.now,
    viewer: input.viewer,
    invoices: owed,
  });
  const zone = yield* ownerZone(input.orgId);
  return owed.flatMap((one): ReadonlyArray<SetAsideInvoice> => {
    const aside = asides.get(one.recordId);
    return aside === undefined
      ? []
      : [
          {
            invoice: one.key,
            ...issuedNumber(one.number),
            client:
              one.partyTitle === null
                ? (one.billTo ?? "no client")
                : input.clientsOn === false
                  ? one.partyTitle
                  : `${one.partyTitle} (${one.partyKey})`,
            owed: one.balance,
            daysOverdue: one.daysOverdue,
            until: aside.until === null ? "until lifted" : dayIn(aside.until, zone),
            by: aside.by,
          },
        ];
  });
});
