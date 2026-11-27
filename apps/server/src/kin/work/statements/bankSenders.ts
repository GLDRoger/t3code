import {
  KinChatError,
  type KinBankSendersResult,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { mayActAsOwner } from "../../people/KinAccess.ts";
import { orgOwner } from "../toolNames.ts";

import { startHeldAlertReplay } from "./alertMail.ts";
import {
  accountsOf,
  bankKeyOf,
  encodeAccounts,
  endingsOf,
  list as senderRows,
  liveHeldMail,
  normalizeAddress,
} from "./bankSenderRows.ts";

export { noteCandidate, sendersOf } from "./bankSenderRows.ts";

const onlyOwnerLevel = Effect.fn("KinBankSenders.onlyOwnerLevel")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [active] = yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId}
    AND person_id = ${personId} AND removed_at IS NULL`;
  const owner = yield* orgOwner(orgId);
  if (
    active !== undefined &&
    owner !== null &&
    (yield* mayActAsOwner(orgId, personId, { personId: owner }))
  )
    return;
  return yield* new KinChatError({
    reason: "not_allowed",
    message: "Only an owner or co-owner can change bank alert addresses.",
  });
});

const settingsList = Effect.fn("KinBankSenders.list")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        yield* onlyOwnerLevel(orgId, personId);
        const held = yield* liveHeldMail(orgId, yield* Clock.currentTimeMillis);
        const heldByAddress = new Map<string, number>();
        for (const { address, count } of held)
          heldByAddress.set(address, (heldByAddress.get(address) ?? 0) + count);
        const rows = (yield* senderRows(orgId, true)).flatMap((row) =>
          row.state === "removed"
            ? []
            : [
                {
                  address: row.address,
                  bankName: row.bankName,
                  accounts: row.accounts,
                  state: row.state === "candidate" ? ("waiting" as const) : row.state,
                  firstSeenAt: row.firstSeenAt,
                  decidedAt: row.decidedAt,
                  decidedBy: row.decidedBy,
                  recordedCount: row.recordedCount,
                  heldCount: heldByAddress.get(row.address) ?? 0,
                },
              ],
        );
        return { rows } satisfies KinBankSendersResult;
      }),
    )
    .pipe(NodeSqliteClient.readOnly);
});

export function list(orgId: KinOrgId): ReturnType<typeof senderRows>;
export function list(orgId: KinOrgId, personId: KinPersonId): ReturnType<typeof settingsList>;
export function list(orgId: KinOrgId, personId?: KinPersonId) {
  return personId === undefined ? senderRows(orgId) : settingsList(orgId, personId);
}

export const approve = Effect.fn("KinBankSenders.approve")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  value: string,
  endings: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwnerLevel(orgId, personId);
      const address = normalizeAddress(value);
      const accounts = endingsOf(endings);
      const [candidate] = yield* sql<{
        seenAccounts: string;
      }>`SELECT seen_accounts_json AS "seenAccounts"
        FROM kin_bank_senders WHERE org_id = ${orgId} AND address = ${address ?? ""}
          AND state = 'candidate'`;
      if (address === undefined || candidate === undefined)
        return yield* new KinChatError({
          reason: "conflict",
          message: "This address is no longer waiting for approval.",
        });
      if (
        accounts === undefined ||
        !accounts.every((account) => accountsOf(candidate.seenAccounts).includes(account))
      )
        return yield* new KinChatError({
          reason: "invalid_state",
          message: "Choose an account ending Kin saw in those alerts.",
        });
      yield* sql`UPDATE kin_bank_senders SET state = 'approved', accounts_json = ${yield* encodeAccounts(accounts)},
        decided_by_person_id = ${personId}, decided_at = ${now}
        WHERE org_id = ${orgId} AND address = ${address}`;
      yield* startHeldAlertReplay(orgId, address);
    }),
  );
});

const stop = Effect.fn("KinBankSenders.stop")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  value: string,
  state: "declined" | "removed",
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwnerLevel(orgId, personId);
      const address = normalizeAddress(value);
      const from = state === "declined" ? "candidate" : "approved";
      const changed = yield* sql`UPDATE kin_bank_senders SET state = ${state},
        decided_by_person_id = ${personId}, decided_at = ${now}
        WHERE org_id = ${orgId} AND address = ${address ?? ""} AND state = ${from}
        RETURNING address`;
      if (changed.length === 0)
        return yield* new KinChatError({
          reason: "conflict",
          message: "This bank alert address has already changed.",
        });
    }),
  );
});

export const decline = Effect.fn("KinBankSenders.decline")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  address: string,
) {
  yield* stop(orgId, personId, address, "declined");
});

export const remove = Effect.fn("KinBankSenders.remove")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  address: string,
) {
  yield* stop(orgId, personId, address, "removed");
});

export const add = Effect.fn("KinBankSenders.add")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  input: {
    readonly address: string;
    readonly bankName: string;
    readonly accounts: ReadonlyArray<string>;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* onlyOwnerLevel(orgId, personId);
      const address = normalizeAddress(input.address);
      const bankName = input.bankName.trim();
      const accounts = endingsOf(input.accounts);
      if (
        address === undefined ||
        bankName === "" ||
        bankName.length > 160 ||
        accounts === undefined
      )
        return yield* new KinChatError({
          reason: "invalid_state",
          message:
            "Enter an email address, a bank name and at least one four-digit account ending.",
        });
      const bankKey = yield* bankKeyOf(orgId, bankName);
      yield* sql`INSERT INTO kin_bank_senders
        (org_id, address, bank_key, bank_name, accounts_json, state, matched_from,
          decided_by_person_id, decided_at, created_at)
        VALUES (${orgId}, ${address}, ${bankKey}, ${bankName}, ${yield* encodeAccounts(accounts)},
          'approved', 'settings', ${personId}, ${now}, ${now})
        ON CONFLICT (org_id, address) DO UPDATE SET bank_key = excluded.bank_key,
          bank_name = excluded.bank_name, accounts_json = excluded.accounts_json, state = 'approved',
          matched_from = 'settings', decided_by_person_id = excluded.decided_by_person_id,
          decided_at = excluded.decided_at`;
      yield* startHeldAlertReplay(orgId, address);
    }),
  );
});
