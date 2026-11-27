import type { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";

import * as BankAlertReader from "./BankAlertReader.ts";
import { add } from "./bankSenders.ts";

export const fixtureBankAlertReader = BankAlertReader.BankAlertReader.of({
  read: ({ text }) =>
    Effect.sync(() => {
      // Only the generated fixtures in the storage and mailbox tests, not an alert format.
      const fixture =
        /^(?:Dear Customer, )?(Rs\.|INR)\s*([\d,.]+) (?:has been|was) (debited|credited).*?(?:\*\*|XX)(\d{4}).*? on (\d{2})-(\d{2})-(\d{4}|\d{2})[^]*?(?:number is |UTR No: )([A-Z0-9]+)\./i.exec(
          text,
        );
      if (fixture === null) return "not_one_transaction";
      const [, currency, amount, direction, account, day, month, year, reference] = fixture;
      return {
        kind: "transaction",
        direction: direction === "debited" ? "debit" : "credit",
        amount: amount!,
        currency: currency!,
        account: account!,
        date_printed: `${day}-${month}-${year}`,
        date: `${year!.length === 2 ? `20${year}` : year}-${month}-${day}`,
        reference: reference!,
        counterparty:
          /\bfor ([^.]+)\./.exec(text)?.[1] ??
          /\bto VPA [^\s]+ (.+?) on \d/.exec(text)?.[1] ??
          null,
        balance: /(?:Avl bal|Available balance): INR ([\d,]+(?:\.\d+)?)/.exec(text)?.[1] ?? null,
      };
    }),
});

export const fixtureAlertAddress = "alerts@harborbank.example";
export const approveFixtureAlertSender = (
  orgId: KinOrgId,
  personId: KinPersonId,
  accounts = ["4821"],
) => add(orgId, personId, { address: fixtureAlertAddress, bankName: "Harbor Bank", accounts });

export const seedFixtureAlertMailbox = Effect.fn("Test.seedAlertMailbox")(function* (
  orgId: KinOrgId,
  connectionId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
    auth, reach, state, created_at, updated_at)
    VALUES (${orgId}, ${connectionId}, 'google', 'Accounts', 'builtin', 'example.test',
      'oauth', 'closed', 'active', 0, 0)`;
});
