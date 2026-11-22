import type { KinMoney, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";
import { parseFields } from "./lists.ts";
import { addUp, dayIn } from "./money.ts";
import { countedEntry, moneyDay } from "./recordRows.ts";
import {
  FUNDED_BY,
  fundingOf,
  IMPORTED_PARTNER,
  owedToPartner,
  REIMBURSEMENT,
  unsaidImport,
} from "./reimbursement.ts";

/** One Paid expense a partner funded and the company hasn't paid back yet. */
export type OwedEntry = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly at: number;
  readonly money: KinMoney;
};

/** What the company owes one partner: a Kin person, or an import's address no person matches. */
export type PartnerOwed = {
  readonly personId: string | null;
  readonly name: string;
  readonly address: string | null;
  readonly owed: ReadonlyArray<KinMoney>;
  /** Oldest first: the order a lump-sum repayment settles them in. */
  readonly entries: ReadonlyArray<OwedEntry>;
};

/** Every partner the company owes, most owed first by entry count, with each owed expense. */
export const partnersOwed = Effect.fn("KinPartnersOwed.read")(function* (
  orgId: KinOrgId,
  home: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    minor: number;
    currency: string;
    at: number;
    fieldsJson: string;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.amount_minor AS minor, r.currency,
      ${moneyDay(sql)} AS at, r.fields_json AS "fieldsJson"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL AND ${owedToPartner(sql)}
    ORDER BY at, r.key`;
  const names = new Map(
    (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
      FROM kin_people WHERE org_id = ${orgId} ORDER BY person_id`).map((one) => [one.id, one.name]),
  );
  const groups = new Map<
    string,
    { personId: string | null; address: string | null; entries: Array<OwedEntry> }
  >();
  for (const row of rows) {
    const funding = fundingOf(parseFields(row.fieldsJson));
    if (funding.by !== "partner") continue;
    const address = funding.personId === null ? (funding.unmatched?.toLowerCase() ?? "") : null;
    const id = funding.personId === null ? `address:${address}` : `person:${funding.personId}`;
    const group = groups.get(id) ?? { personId: funding.personId, address, entries: [] };
    group.entries.push({
      recordId: row.recordId,
      key: row.key,
      title: row.title,
      at: row.at,
      money: { minor: row.minor, currency: row.currency },
    });
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group): PartnerOwed => ({
      personId: group.personId,
      name:
        group.personId !== null
          ? (names.get(group.personId) ?? "a former teammate")
          : group.address === ""
            ? "a partner Kin can't name"
            : group.address!,
      address: group.address === "" ? null : group.address,
      owed: addUp(
        group.entries.map((one) => one.money),
        home,
      ),
      entries: group.entries,
    }))
    .toSorted((a, b) => b.entries.length - a.entries.length || (a.name < b.name ? -1 : 1));
});
export type PartnersOwed = Effect.Success<ReturnType<typeof partnersOwed>>;

/** Paid expenses an import says a partner paid, by address, until the owner says who and whether owed. */
export const partnersUnsaid = Effect.fn("KinPartnersOwed.unsaid")(function* (
  orgId: KinOrgId,
  home: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ address: string; minor: number; currency: string; at: number }>`
    SELECT lower(trim(json_extract(r.fields_json, ${`$.${IMPORTED_PARTNER}`}))) AS address,
      r.amount_minor AS minor, r.currency, ${moneyDay(sql)} AS at
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL AND ${unsaidImport(sql)}
    ORDER BY address, at, r.key`;
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) groups.set(row.address, [...(groups.get(row.address) ?? []), row]);
  return [...groups].map(([address, entries]) => ({
    address,
    expenses: entries.length,
    total: addUp(
      entries.map((one) => ({ minor: one.minor, currency: one.currency })),
      home,
    ),
    at: entries[0]!.at,
  }));
});

/** The partners owed as an agent quotes them: who, how much, and the oldest entries. */
export const partnersAnswer = (
  partners: PartnersOwed,
  unsaid: Effect.Success<ReturnType<typeof partnersUnsaid>>,
  zone: string,
  shown = 20,
) => ({
  partners: partners.map((one) => ({
    partner:
      one.personId === null
        ? { unmatched: one.address ?? "unknown", name: one.name }
        : { name: one.name },
    owed: one.owed,
    entries: one.entries.length,
    oldest: one.entries.slice(0, shown).map((entry) => ({
      key: entry.key,
      title: entry.title,
      paidOn: dayIn(entry.at, zone),
      money: entry.money,
    })),
  })),
  ...(unsaid.length === 0
    ? {}
    : {
        paidPersonallyNotYetSaid: unsaid.map((one) => ({
          address: one.address,
          expenses: one.expenses,
          total: one.total,
          since: dayIn(one.at, zone),
        })),
      }),
  basis:
    "Paid expenses a partner funded from their own money that the company hasn't paid back yet, oldest first, per currency. Paid personally, not yet said: imported expenses an address paid that nobody has said are owed or paid back; they count as the company's own spending until an owner says who it was in Money.",
});

/**
 * An owner-level person says who an import's address is, and whether what it paid is still owed:
 * each of its expenses with no funder takes `personId`, and one with no reimbursement yet takes
 * `settled`, each as its own logged change. Already paid back keeps it counted as it was.
 */
export const matchPartner = Effect.fn("KinPartnersOwed.match")(function* (
  orgId: KinOrgId,
  writer: Writer,
  address: string,
  personId: string,
  settled: "owed" | "repaid",
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const given = address.trim().toLowerCase();
  const rows = yield* sql<{ key: string; rev: number; fieldsJson: string }>`SELECT r.key, r.rev,
      r.fields_json AS "fieldsJson"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses'
      AND json_extract(r.fields_json, ${`$.${FUNDED_BY}`}) IS NULL
      AND lower(trim(json_extract(r.fields_json, ${`$.${IMPORTED_PARTNER}`}))) = ${given}
      AND COALESCE(json_extract(r.fields_json, ${`$.${REIMBURSEMENT}`}), 'owed')
        IN ('owed', 'repaid')
    ORDER BY r.key`;
  for (const row of rows) {
    const said = fundingOf(parseFields(row.fieldsJson)).by === "partner";
    yield* records.update(
      orgId,
      writer,
      row.key,
      {
        fields: {
          [FUNDED_BY]: `person:${personId}`,
          ...(said ? {} : { [REIMBURSEMENT]: settled }),
        },
      },
      row.rev,
    );
  }
  return rows.map((row) => row.key);
});
