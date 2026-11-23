import { KinChatError, type KinRecordState } from "@t3tools/contracts";

import { LISTS, TEAM_LIST_RESERVED } from "./lists.ts";
import { PRESET_IDS } from "./registers.ts";

/**
 * The lists that hold money: the reserved registers that are not Kin's built-in lists (expenses,
 * invoices, receipts, quotes, payments, bank transactions) and subscriptions, which Money reads.
 * A list paid over time (`payments`) or whose entries carry an amount (`amount`) holds money too.
 */
export const MONEY_LISTS: ReadonlyArray<string> = [
  ...TEAM_LIST_RESERVED.filter((id) => !Object.hasOwn(LISTS, id)),
  "subscriptions",
];
export type ListMoney = { readonly paidOverTime: boolean; readonly carriesAmount: boolean };
export const holdsMoney = (list: string, money: ListMoney) =>
  MONEY_LISTS.includes(list) || money.paidOverTime || money.carriesAmount;

/** The one refusal a write through a coding agent's key meets at the repository. */
export const KEY_REFUSED = new KinChatError({
  reason: "not_allowed",
  message:
    "A coding agent's key never deletes or archives anything, nor records or changes money: the person does that in Kin.",
});

/** An invoice in its open, unnumbered draft state: what `draft_invoice` makes. */
const invoiceDraft = (list: string, state: KinRecordState, numbered: boolean) =>
  list === "invoices" && state === "open" && !numbered;

/**
 * Whether a write marked with a coding agent's key may stand, on what the repository resolved:
 * never `dropped`; in a money list, only an invoice draft made, or priced from its own lines
 * (`amounts.priceDraft`: its amount and tax, nothing else) while it stays one.
 */
export const keyRefusal = (write: {
  readonly list: string;
  readonly money: ListMoney;
  readonly state: KinRecordState;
  readonly numbered: boolean;
  /** For a change: the entry as it stood, and the fields the change touches. */
  readonly before?: { readonly state: KinRecordState; readonly numbered: boolean };
  readonly touches?: ReadonlyArray<string>;
}) => {
  if (write.state === "dropped") return KEY_REFUSED;
  if (!holdsMoney(write.list, write.money)) return undefined;
  if (!invoiceDraft(write.list, write.state, write.numbered)) return KEY_REFUSED;
  if (write.before === undefined) return undefined;
  const pricing = (write.touches ?? []).every((field) => field === "amount" || field === "tax");
  return invoiceDraft(write.list, write.before.state, write.before.numbered) && pricing
    ? undefined
    : KEY_REFUSED;
};

/**
 * A list the company made itself: none of Kin's own (Work, Clients, Deals, Docs and the rest), no
 * money list and no preset; what a key's entry tools work on.
 */
const NOT_OWN: ReadonlyArray<string> = [...TEAM_LIST_RESERVED, ...PRESET_IDS, ...MONEY_LISTS];
export const companyList = (list: string, money: ListMoney) =>
  !NOT_OWN.includes(list) && !holdsMoney(list, money);
/** SQL over trusted names, for `sql.literal`: entry `r` is in a list the company made itself. */
export const companyListSql = (r: string) =>
  `(${r}.register_id NOT IN (${NOT_OWN.map((id) => `'${id}'`).join(", ")})
    AND EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = ${r}.org_id
      AND g.register_id = ${r}.register_id
      AND COALESCE(json_extract(g.definition_json, '$.payments'), 0) <> 1
      AND COALESCE(json_extract(g.definition_json, '$.amount'), 0) <> 1))`;
export const moneyOf = (def: {
  readonly payments?: boolean | undefined;
  readonly amount: boolean;
}) => ({
  paidOverTime: def.payments === true,
  carriesAmount: def.amount,
});
