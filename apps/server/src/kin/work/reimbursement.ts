import type { KinListField } from "@t3tools/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

import { fieldText, type FieldValues } from "./lists.ts";

/**
 * The company funds an expense unless `fundedBy` names a partner who paid it themselves, or an
 * import's unmatched one marks it owed or repaid. A partner's is owed back until `repaid` (on
 * `repaidOn`), unless `not reimbursable`.
 */

export const FUNDED_BY = "fundedBy";
const REIMBURSEMENT = "reimbursement";
const REPAID_ON = "repaidOn";
/** The address an import gave for who paid; read only to show who an unmatched row is owed to. */
export const IMPORTED_PARTNER = "paidPersonallyBy";

const REIMBURSEMENT_STATES = ["owed", "repaid", "not reimbursable"] as const;
export type ReimbursementState = (typeof REIMBURSEMENT_STATES)[number];

/** The Expenses template's fields for it, in the order a form shows them. */
export const REIMBURSEMENT_FIELDS: ReadonlyArray<KinListField> = [
  { key: FUNDED_BY, label: "Funded by", type: "person", sensitive: false },
  {
    key: REIMBURSEMENT,
    label: "Reimbursement",
    type: "choice",
    choices: [...REIMBURSEMENT_STATES],
    sensitive: false,
  },
  { key: REPAID_ON, label: "Repaid on", type: "date", sensitive: false },
];

export type Funding =
  | { readonly by: "company" }
  | {
      readonly by: "partner";
      /** The partner as a Kin person id, or null when an import named someone Kin can't match. */
      readonly personId: string | null;
      /** What the import said instead, when there is no person. */
      readonly unmatched: string | null;
      readonly state: ReimbursementState;
      /** The day it was paid back, `YYYY-MM-DD`, once repaid. */
      readonly repaidOn: string | null;
    };

const isState = (value: string | null): value is ReimbursementState =>
  (REIMBURSEMENT_STATES as ReadonlyArray<string | null>).includes(value);

/** An import's partner address as Kin compares it: JS `trim` (tabs, CR, NBSP) and Unicode case. */
export const partnerAddress = (raw: string | null) => raw?.trim().toLowerCase() ?? "";

/** Who funded an expense, from its fields. */
export const fundingOf = (fields: FieldValues): Funding => {
  const funder = fieldText(fields, FUNDED_BY);
  const personId = funder?.startsWith("person:") === true ? funder.slice(7) : null;
  const marked = fieldText(fields, REIMBURSEMENT);
  const state = isState(marked) ? marked : null;
  if (personId === null && state !== "owed" && state !== "repaid") return { by: "company" };
  const imported = partnerAddress(fieldText(fields, IMPORTED_PARTNER));
  return {
    by: "partner",
    personId,
    unmatched: personId === null && imported !== "" ? imported : null,
    state: state ?? "owed",
    repaidOn: state === "repaid" ? (fieldText(fields, REPAID_ON)?.slice(0, 10) ?? null) : null,
  };
};

const valueOf = (sql: SqlClient.SqlClient, key: string) =>
  sql`json_extract(r.fields_json, ${`$.${key}`})`;

/** An expense `r` a partner funded: `fundingOf` in SQL, case-sensitive like it (GLOB, not LIKE). */
export const partnerFunded = (sql: SqlClient.SqlClient) =>
  sql`(COALESCE(${valueOf(sql, FUNDED_BY)}, '') GLOB 'person:*'
    OR COALESCE(${valueOf(sql, REIMBURSEMENT)}, '') IN ('owed', 'repaid'))`;

/** An expense `r` the company still owes the partner who funded it. */
export const owedToPartner = (sql: SqlClient.SqlClient) =>
  sql`(${partnerFunded(sql)} AND COALESCE(${valueOf(sql, REIMBURSEMENT)}, 'owed') = 'owed')`;

/** A repaid expense `r`'s repaid day, `YYYY-MM-DD`, or null. */
export const repaidDay = (sql: SqlClient.SqlClient) =>
  sql`substr(${valueOf(sql, REPAID_ON)}, 1, 10)`;

/** Why a `fundedBy` value is refused: only a person pays from their own money. */
export const fundedByRefusal = (value: unknown) =>
  typeof value === "string" && !value.startsWith("person:")
    ? "Funded by takes the person who paid from their own money, not an agent."
    : undefined;

/**
 * Whether an expense `r` was company cash out: the company paid it, or paid its partner back.
 * One a partner gave, or is still owed for, never left the company's accounts.
 */
export const companyCashOut = (sql: SqlClient.SqlClient) =>
  sql`(NOT ${partnerFunded(sql)} OR COALESCE(${valueOf(sql, REIMBURSEMENT)}, '') = 'repaid')`;

/**
 * The day a company-cash-out expense `r` left the accounts when that isn't its own date: a
 * partner's repaid day, `YYYY-MM-DD`. NULL for the company's own, or a repaid one with no day.
 */
export const partnerRepaidDay = (sql: SqlClient.SqlClient) =>
  sql`CASE WHEN ${partnerFunded(sql)} THEN ${repaidDay(sql)} END`;
