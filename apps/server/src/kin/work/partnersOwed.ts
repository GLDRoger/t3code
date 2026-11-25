import { KinChatError, type KinMoney, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "./KinRecords.ts";
import { fieldText, parseFields } from "./lists.ts";
import { listDef } from "./registers.ts";
import { addUp, dayIn, formatMoney } from "./money.ts";
import { countedEntry, moneyDay, ownerZone } from "./recordRows.ts";
import {
  FUNDED_BY,
  fundingOf,
  IMPORTED_PARTNER,
  NO_ROOM_FOR_FUNDING,
  owedToPartner,
  partnerAddress,
  partnerFunded,
  REIMBURSEMENT,
  unsaidImport,
} from "./reimbursement.ts";
import { findBankList } from "./statements/bankList.ts";

/** One Paid expense a partner funded and the company hasn't paid back yet. */
export type OwedEntry = {
  readonly recordId: string;
  readonly key: string;
  readonly rev: number;
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
    rev: number;
    title: string;
    minor: number;
    currency: string;
    at: number;
    fieldsJson: string;
  }>`SELECT r.record_id AS "recordId", r.key, r.rev, r.title, r.amount_minor AS minor, r.currency,
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
      rev: row.rev,
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

/**
 * Everyone who has funded a Paid expense, owed or not, with repaid amounts lacking a statement
 * row as totals per currency and day, and the share tied to each Bank transactions entry. A
 * statement line naming one is never a new expense. A mark with no Repaid on day counts on the
 * day it was written, in the owner's zone.
 */
export const partnerPayees = Effect.fn("KinPartnersOwed.payees")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const bank = yield* findBankList(orgId);
  const rows = yield* sql<{
    minor: number;
    currency: string;
    fieldsJson: string;
    linked: number;
    markedAt: number;
    bankRecordId: string | null;
  }>`
    SELECT r.amount_minor AS minor, r.currency, r.fields_json AS "fieldsJson",
      EXISTS (SELECT 1 FROM kin_bank_statement_entries e WHERE e.org_id = r.org_id
        AND e.target_record_id = r.record_id) AS linked,
      COALESCE((SELECT c.at FROM kin_record_changes c, json_each(c.fields_json) f
        WHERE c.org_id = r.org_id AND c.record_id = r.record_id
          AND json_extract(f.value, '$.field') = ${REIMBURSEMENT}
        ORDER BY c.seq DESC LIMIT 1), r.created_at) AS "markedAt",
      (SELECT l.target FROM kin_record_links l
        JOIN kin_records b ON b.org_id = l.org_id AND b.record_id = l.target
        WHERE l.org_id = r.org_id AND l.record_id = r.record_id
          AND l.kind = 'record' AND l.relation = 'evidence' AND b.register_id = ${bank?.id ?? null}
        ORDER BY l.created_at DESC, l.target DESC LIMIT 1) AS "bankRecordId"
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL AND ${partnerFunded(sql)}
    ORDER BY r.key`;
  const names = new Map(
    (yield* sql<{ id: string; name: string }>`SELECT person_id AS id, display_name AS name
      FROM kin_people WHERE org_id = ${orgId} ORDER BY person_id`).map((one) => [one.id, one.name]),
  );
  const payees = new Map<
    string,
    {
      name: string;
      id: string;
      ids: Array<string>;
      repaid: Map<string, bigint>;
      tied: Map<string, Map<string, bigint>>;
    }
  >();
  for (const row of rows) {
    const funding = fundingOf(parseFields(row.fieldsJson));
    if (funding.by !== "partner") continue;
    if (funding.personId === null && funding.unmatched === null) continue;
    const id = funding.personId ?? `address:${funding.unmatched}`;
    const payee = payees.get(id) ?? {
      name:
        funding.personId === null
          ? funding.unmatched!
          : (names.get(funding.personId) ?? "a former teammate"),
      id,
      ids: funding.personId === null ? [funding.unmatched!] : [],
      repaid: new Map<string, bigint>(),
      tied: new Map<string, Map<string, bigint>>(),
    };
    if (funding.state === "repaid" && row.linked === 0) {
      const at = `${row.currency} ${funding.repaidOn ?? dayIn(row.markedAt, zone)}`;
      const minor = BigInt(row.minor);
      payee.repaid.set(at, (payee.repaid.get(at) ?? 0n) + minor);
      if (row.bankRecordId !== null) {
        const tied = payee.tied.get(row.bankRecordId) ?? new Map<string, bigint>();
        tied.set(at, (tied.get(at) ?? 0n) + minor);
        payee.tied.set(row.bankRecordId, tied);
      }
    }
    payees.set(id, payee);
  }
  const total = ([at, minor]: [string, bigint]) => ({
    currency: at.slice(0, at.indexOf(" ")),
    day: at.slice(at.indexOf(" ") + 1),
    amountMinor: Number(minor),
  });
  return [...payees.values()].map((payee) => ({
    name: payee.name,
    id: payee.id,
    ids: payee.ids,
    repaid: [...payee.repaid].map(total),
    tied: [...payee.tied].flatMap(([bankRecordId, totals]) =>
      [...totals].map((entry) => ({ bankRecordId, ...total(entry) })),
    ),
  }));
});

/** Whether Expenses has Funded by to record a partner in. */
export const fundable = Effect.fn("KinPartnersOwed.fundable")(function* (orgId: KinOrgId) {
  const def = yield* listDef(orgId, "expenses");
  return def?.fields.some((one) => one.key === FUNDED_BY && one.retired !== true) === true;
});

/** Paid expenses an import says a partner paid, by address, until the owner says who and whether owed. */
export const partnersUnsaid = Effect.fn("KinPartnersOwed.unsaid")(function* (
  orgId: KinOrgId,
  home: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    key: string;
    rev: number;
    raw: string;
    minor: number;
    currency: string;
    at: number;
  }>`
    SELECT r.key, r.rev, json_extract(r.fields_json, ${`$.${IMPORTED_PARTNER}`}) AS raw,
      r.amount_minor AS minor, r.currency, ${moneyDay(sql)} AS at
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL AND ${unsaidImport(sql)}
    ORDER BY at, r.key`;
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    const address = partnerAddress(row.raw);
    if (address !== "") groups.set(address, [...(groups.get(address) ?? []), row]);
  }
  return [...groups]
    .map(([address, entries]) => ({
      address,
      expenses: entries.length,
      total: addUp(
        entries.map((one) => ({ minor: one.minor, currency: one.currency })),
        home,
      ),
      at: entries[0]!.at,
      seen: entries.map((one) => ({ key: one.key, rev: one.rev })),
    }))
    .toSorted((a, b) => (a.address < b.address ? -1 : 1));
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
    owed: one.owed.map(formatMoney),
    entries: one.entries.length,
    oldest: one.entries.slice(0, shown).map((entry) => ({
      key: entry.key,
      title: entry.title,
      paidOn: dayIn(entry.at, zone),
      money: formatMoney(entry.money),
    })),
  })),
  ...(unsaid.length === 0
    ? {}
    : {
        paidPersonallyNotYetSaid: unsaid.map((one) => ({
          address: one.address,
          expenses: one.expenses,
          total: one.total.map(formatMoney),
          since: dayIn(one.at, zone),
        })),
      }),
  basis:
    "Paid expenses a partner funded from their own money that the company hasn't paid back yet, oldest first, per currency. Paid personally, not yet said: imported expenses an address paid that nobody has said are owed or paid back; they count as the company's own spending until an owner says who it was in Money.",
});

/** Said when what a person saw for a partner match moved before they answered. */
export const MATCH_MOVED =
  "New expenses arrived since you opened this. Nothing was changed; look again.";

/**
 * The owner or a co-owner names who an import's address (null: owed expenses naming no one) is.
 * With `settled`, the address's not-yet-said expenses take it too. Exactly the rows and totals
 * `seen` showed change, with the person still on the team, in the caller's transaction.
 */
export const matchPartner = Effect.fn("KinPartnersOwed.match")(function* (
  orgId: KinOrgId,
  writer: Writer,
  address: string | null,
  personId: string,
  settled: "owed" | "repaid" | undefined,
  seen:
    | {
        readonly entries: ReadonlyArray<{ readonly key: string; readonly rev: number }>;
        readonly totals: ReadonlyArray<KinMoney>;
      }
    | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const records = yield* KinRecords;
  if (!(yield* fundable(orgId)))
    return yield* new KinChatError({ reason: "invalid_state", message: NO_ROOM_FOR_FUNDING });
  const [member] = yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId}
    AND person_id = ${personId} AND removed_at IS NULL`;
  if (member === undefined)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "That person isn't on the team.",
    });
  const given = address === null ? null : partnerAddress(address);
  const rows = yield* sql<{
    key: string;
    rev: number;
    fieldsJson: string;
    minor: number;
    currency: string;
  }>`SELECT r.key, r.rev, r.fields_json AS "fieldsJson", r.amount_minor AS minor, r.currency
    FROM kin_records r
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state = 'done'
      AND ${countedEntry(sql)} AND r.amount_minor IS NOT NULL
      AND (json_extract(r.fields_json, ${`$.${IMPORTED_PARTNER}`}) IS NOT NULL
        OR ${partnerFunded(sql)})
    ORDER BY r.key`;
  const named = rows.flatMap((row) => {
    const fields = parseFields(row.fieldsJson);
    const funding = fundingOf(fields);
    const unsaid =
      fieldText(fields, FUNDED_BY) === null && fieldText(fields, REIMBURSEMENT) === null;
    const same =
      given === null
        ? funding.by === "partner" && funding.personId === null && funding.unmatched === null
        : partnerAddress(fieldText(fields, IMPORTED_PARTNER)) === given;
    return same ? [{ ...row, funding, unsaid }] : [];
  });
  const matching = named.filter((row) =>
    settled === undefined
      ? row.funding.by === "partner" &&
        row.funding.personId === null &&
        row.funding.state === "owed"
      : row.unsaid,
  );
  if (settled === undefined && matching.length === 0 && named.some((row) => row.unsaid))
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "Say whether the company still owes them for these, or already paid them back.",
    });
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
  const shown = new Map((seen?.entries ?? []).map((one) => [one.key, one.rev]));
  const sorted = (money: ReadonlyArray<KinMoney>) =>
    JSON.stringify(money.toSorted((a, b) => (a.currency < b.currency ? -1 : 1)));
  if (
    seen === undefined ||
    shown.size !== matching.length ||
    matching.some((row) => shown.get(row.key) !== row.rev) ||
    sorted(
      addUp(
        matching.map((row) => ({ minor: row.minor, currency: row.currency })),
        "",
      ),
    ) !== sorted(seen.totals)
  )
    return yield* new KinChatError({ reason: "conflict", message: MATCH_MOVED });
  for (const row of matching)
    yield* records.update(
      orgId,
      writer,
      row.key,
      {
        fields: {
          [FUNDED_BY]: `person:${personId}`,
          ...(row.unsaid && settled !== undefined ? { [REIMBURSEMENT]: settled } : {}),
        },
      },
      row.rev,
    );
  return matching.map((row) => row.key);
});
