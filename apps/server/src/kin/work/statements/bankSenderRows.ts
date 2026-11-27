// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DAY_MS } from "../../durations.ts";

export const normalizeAddress = (value: string | null | undefined) => {
  const address = value?.trim().toLowerCase();
  return address !== undefined &&
    address.length <= 254 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(address)
    ? address
    : undefined;
};

const ending = /^\d{4}$/;
const AccountsJson = Schema.fromJsonString(
  Schema.Array(Schema.String.check(Schema.isPattern(ending))),
);
const decodeAccounts = Schema.decodeUnknownOption(AccountsJson);
export const encodeAccounts = Schema.encodeEffect(AccountsJson);
export const accountsOf = (value: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeAccounts(value), () => []);
export const endingsOf = (accounts: ReadonlyArray<string>) =>
  accounts.length > 0 && accounts.every((account) => ending.test(account))
    ? [...new Set(accounts)].toSorted()
    : undefined;

type SenderState = "candidate" | "approved" | "declined" | "removed";
type MatchedFrom = "company_details" | "statement" | "settings" | "carried";

interface SenderRow {
  readonly address: string;
  readonly bankKey: string;
  readonly bankName: string;
  readonly accountsJson: string;
  readonly state: SenderState;
  readonly seenCount: number;
  readonly firstSeenAt: number | null;
  readonly lastSeenAt: number | null;
  readonly seenAccountsJson: string;
  readonly matchedFrom: MatchedFrom | null;
  readonly decidedByPersonId: string | null;
  readonly decidedAt: number | null;
  readonly createdAt: number;
}

export interface ApprovedSender {
  readonly bankKey: string;
  readonly bankName: string;
  readonly accounts: ReadonlyArray<string>;
}

export const list = Effect.fn("KinBankSenders.list")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<SenderRow>`SELECT address, bank_key AS "bankKey", bank_name AS "bankName",
    accounts_json AS "accountsJson", state, seen_count AS "seenCount",
    first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
    seen_accounts_json AS "seenAccountsJson", matched_from AS "matchedFrom",
    decided_by_person_id AS "decidedByPersonId", decided_at AS "decidedAt",
    created_at AS "createdAt"
    FROM kin_bank_senders WHERE org_id = ${orgId} ORDER BY address`;
  return rows.map(({ accountsJson, seenAccountsJson, ...row }) => ({
    ...row,
    accounts: accountsOf(accountsJson),
    seenAccounts: accountsOf(seenAccountsJson),
  }));
});

export const sendersOf = Effect.fn("KinBankSenders.sendersOf")(function* (
  orgId: KinOrgId,
  address?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<Pick<SenderRow, "address" | "bankKey" | "bankName" | "accountsJson">>`
    SELECT address, bank_key AS "bankKey", bank_name AS "bankName", accounts_json AS "accountsJson"
    FROM kin_bank_senders WHERE org_id = ${orgId} AND state = 'approved'
    ${address === undefined ? sql`` : sql`AND address = ${address}`} ORDER BY address`;
  return new Map<string, ApprovedSender>(
    rows.map(({ address, accountsJson, ...row }) => [
      address,
      { ...row, accounts: accountsOf(accountsJson) },
    ]),
  );
});

export const bankKeyOf = Effect.fn("KinBankSenders.bankKey")(function* (
  orgId: KinOrgId,
  bankName: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [sameBank] = yield* sql<{ key: string }>`SELECT bank_key AS key FROM kin_bank_senders
    WHERE org_id = ${orgId} AND lower(bank_name) = lower(${bankName})
    ORDER BY matched_from = 'carried' DESC, created_at, address LIMIT 1`;
  return (
    sameBank?.key ??
    `b${NodeCrypto.createHash("sha256")
      .update(orgId + bankName.toLowerCase())
      .digest("hex")
      .slice(0, 8)}`
  );
});

export const noteCandidate = Effect.fn("KinBankSenders.noteCandidate")(function* (
  orgId: KinOrgId,
  input: {
    readonly address: string;
    readonly bankName: string;
    readonly accounts: ReadonlyArray<string>;
    readonly seenAt: number;
    readonly matchedFrom: "company_details" | "statement";
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const address = normalizeAddress(input.address);
  const accounts = endingsOf(input.accounts);
  const bankName = input.bankName.trim();
  if (address === undefined || accounts === undefined || bankName === "") return false;
  const bankKey = yield* bankKeyOf(orgId, bankName);
  const rows = yield* sql`INSERT INTO kin_bank_senders
    (org_id, address, bank_key, bank_name, state, seen_count, first_seen_at, last_seen_at,
      seen_accounts_json, matched_from, created_at)
    VALUES (${orgId}, ${address}, ${bankKey}, ${bankName}, 'candidate', 1, ${input.seenAt},
      ${input.seenAt}, ${yield* encodeAccounts(accounts)}, ${input.matchedFrom}, ${input.seenAt})
    ON CONFLICT (org_id, address) DO UPDATE SET
      seen_count = seen_count + 1,
      first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
      seen_accounts_json = (SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(kin_bank_senders.seen_accounts_json)
        UNION SELECT value FROM json_each(excluded.seen_accounts_json)
        ORDER BY value))
    WHERE kin_bank_senders.state = 'candidate' AND kin_bank_senders.bank_key = excluded.bank_key
    RETURNING address`;
  return rows.length === 1;
});

export const HELD_ALERT_WINDOW = 30 * DAY_MS;

export const pruneHeldAlerts = Effect.fn("KinBankSenders.pruneHeld")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM kin_bank_alerts WHERE outcome = 'held'
    AND sent_at < ${now - HELD_ALERT_WINDOW}`;
});
