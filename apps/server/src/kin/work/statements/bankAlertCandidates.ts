import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { getPublicSuffix } from "tldts";

import { readProfile } from "../companyProfile.ts";
import { last4 } from "./bankList.ts";

export interface CandidateHint {
  readonly bankName: string;
  readonly matchedFrom: "company_details" | "statement";
  readonly accounts: ReadonlySet<string>;
}

export const candidateGate = Effect.fn("KinBankAlerts.candidateGate")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const { bank } = yield* readProfile(orgId);
  const statements = yield* sql<{ bankName: string | null; account: string | null }>`
    SELECT DISTINCT json_extract(review_json, '$.statement.bank') AS "bankName",
      json_extract(review_json, '$.statement.account') AS account
    FROM kin_bank_statements
    WHERE org_id = ${orgId} AND status = 'read' AND json_valid(review_json)
      AND applied_at IS NOT NULL AND undone_at IS NULL
    ORDER BY "bankName", account`;
  const accounts = new Set(
    [bank.accountNumber, ...statements.map((one) => one.account)]
      .map(last4)
      .filter((one) => one !== null),
  );
  const banks = [
    { bankName: bank.bankName, matchedFrom: "company_details" as const },
    ...statements.map(({ bankName }) => ({ bankName, matchedFrom: "statement" as const })),
  ].flatMap(({ bankName, matchedFrom }) => {
    if (typeof bankName !== "string") return [];
    const words = bankName
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length >= 4 && word !== "bank");
    return words.length === 0 ? [] : [{ bankName, matchedFrom, words }];
  });
  return (address: string): CandidateHint | undefined => {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const suffix = getPublicSuffix(domain, { allowPrivateDomains: true });
    if (suffix === null || !domain.endsWith(`.${suffix}`)) return undefined;
    const name = domain.slice(0, -suffix.length - 1).replace(/[^a-z0-9]/g, "");
    const known = banks.find(({ words }) => words.some((word) => name.includes(word)));
    return known === undefined
      ? undefined
      : {
          bankName: known.bankName,
          matchedFrom: known.matchedFrom,
          accounts,
        };
  };
});

export const candidateEndings = (text: string, accounts: ReadonlySet<string>) =>
  accounts.size === 0
    ? [
        ...new Set([...text.matchAll(/[xX*•]{2,}(\d{4})(?!\d)/g)].map((match) => match[1]!)),
      ].toSorted()
    : [
        ...new Set(
          (text.match(/(?<!\d)\d{4}(?!\d)/g) ?? []).filter((digits) => accounts.has(digits)),
        ),
      ].toSorted();
