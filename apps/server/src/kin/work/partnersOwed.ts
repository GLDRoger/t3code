import { KinChatError, type KinMoney, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";
import { fieldText, parseFields } from "./lists.ts";
import { addUp, dayIn } from "./money.ts";
import { countedEntry, moneyDay } from "./recordRows.ts";
import {
  FUNDED_BY,
  fundingOf,
  IMPORTED_PARTNER,
  owedToPartner,
  partnerAddress,
  partnerFunded,
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
    const address = funding.personId === null ? (funding.unmatched ?? "") : null;
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

/** The partners owed as an agent quotes them: who, how much, and the oldest entries. */
export const partnersAnswer = (partners: PartnersOwed, zone: string, shown = 20) => ({
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
  basis:
    "Paid expenses a partner funded from their own money that the company hasn't paid back yet, oldest first. An unmatched partner is an address an import gave that no Kin person has yet: the owner matches it in Money.",
});

/**
 * The owner or a co-owner names who an import's address is: every partner-funded expense that
 * names no person and carries that address (or, with `address` null, carries none) takes
 * `personId` as its funder, each as its own logged change. Addresses compare as `fundingOf` groups them (`partnerAddress`), in TS, not SQLite's
 * ASCII-only `lower`/space-only `trim`. Fails when nothing is left to match.
 */
export const matchPartner = Effect.fn("KinPartnersOwed.match")(function* (
  orgId: KinOrgId,
  writer: Writer,
  address: string | null,
  personId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  const given = address === null ? null : partnerAddress(address);
  const rows = yield* sql<{ key: string; rev: number; fieldsJson: string }>`SELECT r.key, r.rev,
      r.fields_json AS "fieldsJson"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses'
      AND (json_extract(r.fields_json, ${`$.${IMPORTED_PARTNER}`}) IS NOT NULL
        OR ${partnerFunded(sql)})
    ORDER BY r.key`;
  const named = rows.flatMap((row) => {
    const fields = parseFields(row.fieldsJson);
    const funding = fundingOf(fields);
    const same =
      given === null
        ? funding.by === "partner" && funding.personId === null && funding.unmatched === null
        : partnerAddress(fieldText(fields, IMPORTED_PARTNER)) === given;
    return same ? [{ ...row, funding }] : [];
  });
  const matching = named.filter(
    (row) => row.funding.by === "partner" && row.funding.personId === null,
  );
  if (matching.length === 0)
    return yield* new KinChatError({
      reason: "invalid_state",
      message:
        named.length === 0
          ? given === null
            ? "Every expense owed to a partner already says who."
            : "No expense owed to a partner carries that address."
          : "Those expenses already say who funded them.",
    });
  for (const row of matching)
    yield* records.update(
      orgId,
      writer,
      row.key,
      { fields: { [FUNDED_BY]: `person:${personId}` } },
      row.rev,
    );
  return matching.map((row) => row.key);
});
