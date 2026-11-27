import {
  formatKinWhen,
  kinWhenParts,
  type EnvironmentId,
  type KinBankSendersResult,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinQueryAtomFamily, createKinRpcCommand, type KinPermission } from "./kinAccess.ts";
import type { kinGuardedRead } from "./kinClient.ts";
import { createKinRefreshTriggers } from "./kinRefresh.ts";

type KinBankSenderRow = KinBankSendersResult["rows"][number];
type KinBankSenderState = KinBankSenderRow["state"];
export type KinBankSenderFieldId = "address" | "bankName" | "accounts";

export interface KinBankSenderDraft {
  readonly address: string;
  readonly bankName: string;
  readonly accounts: string;
}

interface KinBankSenderAddPayload {
  readonly orgId: KinOrgId;
  readonly address: string;
  readonly bankName: string;
  readonly accounts: readonly [string, ...Array<string>];
}

interface KinBankSenderWords {
  readonly zone?: string | undefined;
  readonly locale?: string | undefined;
}

export const KIN_BANK_SENDER_METHODS = {
  list: "kin.bankSenders.list",
  add: "kin.bankSenders.add",
  remove: "kin.bankSenders.remove",
} as const;

const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const ENDING_RE = /^\d{4}$/;
const MAX_ADDRESS_LEN = 254;
const MAX_BANK_NAME_LEN = 160;

export const KIN_BANK_SENDERS = {
  title: "Bank alert addresses",
  description: "Addresses whose bank alert emails Kin counts as Bank transactions.",
  loading: "Loading bank alert addresses",
  loadFailed: "Couldn't load bank alert addresses.",
  empty:
    "No bank alert addresses yet. Kin asks in chat when it notices a bank's alerts, or you can add one here.",
  add: "Add address",
  addTitle: "Add bank alert address",
  addDescription:
    "Alerts from this address about the account endings below become Bank transactions. Nothing is marked paid without a tap.",
  addSubmit: "Add address",
  addFailed: "Couldn't add this bank alert address.",
  countAgain: "Count alerts",
  remove: "Remove",
  removeTitle: (address: string) => `Remove ${address}?`,
  removeDetail: "What it already recorded stays; new alerts from it will not be counted.",
  removeConfirm: "Remove address",
  removeFailed: "Couldn't remove this bank alert address.",
  states: {
    approved: "Counting",
    waiting: "Waiting for the owner",
    declined: "Not counted",
  } satisfies Readonly<Record<KinBankSenderState, string>>,
  waitingForOwner: (ownerName: string | null) => {
    const name = ownerName?.trim() ?? "";
    return name === ""
      ? "Waiting for the owner to answer in chat"
      : `Waiting for ${name} to answer in chat`;
  },
  accounts: (endings: ReadonlyArray<string>) =>
    endings.length === 1 ? `Account ending ${endings[0]}` : `Accounts ending ${endings.join(", ")}`,
  recorded: (count: number) =>
    count === 1 ? "1 transaction recorded" : `${count} transactions recorded`,
  held: (count: number) => (count === 1 ? "1 mail held" : `${count} mails held`),
  approvedByOn: (by: string, date: string) => `Approved by ${by} on ${date}`,
  approvedBy: (by: string) => `Approved by ${by}`,
  approvedOn: (date: string) => `Approved on ${date}`,
  declinedByOn: (by: string, date: string) => `Declined by ${by} on ${date}`,
  declinedBy: (by: string) => `Declined by ${by}`,
  declinedOn: (date: string) => `Declined on ${date}`,
  firstSeen: (date: string) => `First seen ${date}`,
  carriedOver: "Carried over from earlier alerts",
  addressLabel: "Alert email address",
  addressPlaceholder: "alerts@bank.example",
  addressHelp: "Match the exact From address on the bank's alert emails.",
  bankNameLabel: "Bank name",
  bankNamePlaceholder: "Bank name",
  bankNameHelp: "Use the bank name from Company details or your statements so alerts match them.",
  bankNameKnown: "Already entered",
  accountsLabel: "Account endings",
  accountsPlaceholder: "4821, 7310",
  accountsHelp: "One or more four-digit endings, separated by commas or spaces.",
  addressRequired: "Enter the bank's alert email address.",
  addressInvalid: "Enter a full email address with one @, like alerts@bank.example.",
  bankNameRequired: "Enter the bank's name.",
  bankNameTooLong: "Use 160 characters or fewer for the bank name.",
  accountsRequired: "Enter at least one four-digit account ending.",
  accountsInvalid: "Enter four-digit account endings only, like 4821 or 4821, 7310.",
} as const;

export const KIN_BANK_SENDER_EMPTY_DRAFT: KinBankSenderDraft = {
  address: "",
  bankName: "",
  accounts: "",
};

/** Splits an email at `@` so clients can show the domain distinctly without ever truncating it. */
export function kinBankSenderAddressParts(address: string): {
  readonly local: string;
  readonly domain: string;
} {
  const at = address.lastIndexOf("@");
  if (at === -1) return { local: address, domain: "" };
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/** Unique bank names already entered by the company, Company details first, deduplicated by case. */
export function kinBankSenderKnownBanks(input: {
  readonly companyBankName?: string | null | undefined;
  readonly rows?: ReadonlyArray<Pick<KinBankSenderRow, "bankName">> | undefined;
}): ReadonlyArray<string> {
  const seen = new Set<string>();
  const names: Array<string> = [];
  const take = (raw: string | null | undefined) => {
    const trimmed = raw?.trim() ?? "";
    if (trimmed === "") return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(trimmed);
  };
  take(input.companyBankName);
  for (const row of input.rows ?? []) take(row.bankName);
  return names;
}

/** Validates and normalizes the Add bank alert address form into the exact RPC payload. */
export function kinBankSenderAddInput(
  orgId: KinOrgId,
  draft: KinBankSenderDraft,
):
  | { readonly ok: true; readonly input: KinBankSenderAddPayload }
  | {
      readonly ok: false;
      readonly problems: Readonly<Partial<Record<KinBankSenderFieldId, string>>>;
    } {
  const problems: Partial<Record<KinBankSenderFieldId, string>> = {};

  const address = draft.address.trim().toLowerCase();
  if (address === "") problems.address = KIN_BANK_SENDERS.addressRequired;
  else if (address.length > MAX_ADDRESS_LEN || !ADDRESS_RE.test(address))
    problems.address = KIN_BANK_SENDERS.addressInvalid;

  const bankName = draft.bankName.trim();
  if (bankName === "") problems.bankName = KIN_BANK_SENDERS.bankNameRequired;
  else if (bankName.length > MAX_BANK_NAME_LEN)
    problems.bankName = KIN_BANK_SENDERS.bankNameTooLong;

  const tokens = draft.accounts
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  let accounts: readonly [string, ...Array<string>] | null = null;
  if (tokens.length === 0) problems.accounts = KIN_BANK_SENDERS.accountsRequired;
  else if (!tokens.every((token) => ENDING_RE.test(token)))
    problems.accounts = KIN_BANK_SENDERS.accountsInvalid;
  else {
    const sorted = [...new Set(tokens)].sort();
    accounts = [sorted[0]!, ...sorted.slice(1)];
  }

  if (Object.keys(problems).length > 0 || accounts === null) return { ok: false, problems };
  return { ok: true, input: { orgId, address, bankName, accounts } };
}

const zoneOf = (words: KinBankSenderWords) =>
  words.zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatSenderDate(at: number, now: number, words: KinBankSenderWords): string {
  const zone = zoneOf(words);
  const style = kinWhenParts(at, zone).year === kinWhenParts(now, zone).year ? "date" : "dateYear";
  return formatKinWhen(at, style, { zone, locale: words.locale });
}

export interface KinBankSenderRowView {
  readonly address: string;
  readonly addressLocal: string;
  readonly addressDomain: string;
  readonly bankName: string;
  readonly state: KinBankSenderState;
  readonly stateLabel: string;
  readonly accountsLine: string | null;
  readonly countsLine: string | null;
  readonly decidedLine: string | null;
  readonly waitingLine: string | null;
  readonly canRemove: boolean;
  readonly canAddAgain: boolean;
}

/** Formats one bank alert address row for both web and phone Settings. */
export function kinBankSenderRowView(
  row: KinBankSenderRow,
  options: {
    readonly ownerName: string | null;
    readonly now: number;
    readonly words?: KinBankSenderWords | undefined;
  },
): KinBankSenderRowView {
  const words = options.words ?? {};
  const parts = kinBankSenderAddressParts(row.address);
  const accountsLine = row.accounts.length > 0 ? KIN_BANK_SENDERS.accounts(row.accounts) : null;
  const counts = [
    ...(row.recordedCount > 0 ? [KIN_BANK_SENDERS.recorded(row.recordedCount)] : []),
    ...(row.heldCount > 0 ? [KIN_BANK_SENDERS.held(row.heldCount)] : []),
  ];
  const countsLine = counts.length > 0 ? counts.join(" · ") : null;

  const by = row.decidedBy?.trim() || null;
  const decidedDate =
    row.decidedAt === null ? null : formatSenderDate(row.decidedAt, options.now, words);
  const firstSeenDate =
    row.firstSeenAt === null ? null : formatSenderDate(row.firstSeenAt, options.now, words);

  let decidedLine: string | null = null;
  if (row.state === "approved") {
    if (by !== null && decidedDate !== null)
      decidedLine = KIN_BANK_SENDERS.approvedByOn(by, decidedDate);
    else if (by !== null) decidedLine = KIN_BANK_SENDERS.approvedBy(by);
    else if (decidedDate !== null) decidedLine = KIN_BANK_SENDERS.approvedOn(decidedDate);
    else decidedLine = KIN_BANK_SENDERS.carriedOver;
  } else if (row.state === "declined") {
    if (by !== null && decidedDate !== null)
      decidedLine = KIN_BANK_SENDERS.declinedByOn(by, decidedDate);
    else if (by !== null) decidedLine = KIN_BANK_SENDERS.declinedBy(by);
    else if (decidedDate !== null) decidedLine = KIN_BANK_SENDERS.declinedOn(decidedDate);
  } else if (firstSeenDate !== null) {
    decidedLine = KIN_BANK_SENDERS.firstSeen(firstSeenDate);
  }

  return {
    address: row.address,
    addressLocal: parts.local,
    addressDomain: parts.domain,
    bankName: row.bankName,
    state: row.state,
    stateLabel: KIN_BANK_SENDERS.states[row.state],
    accountsLine,
    countsLine,
    decidedLine,
    waitingLine:
      row.state === "waiting" ? KIN_BANK_SENDERS.waitingForOwner(options.ownerName) : null,
    canRemove: row.state === "approved",
    canAddAgain: row.state === "declined",
  };
}

const STATE_ORDER: Readonly<Record<KinBankSenderState, number>> = {
  approved: 0,
  waiting: 1,
  declined: 2,
};

/** Orders Counting first, then Waiting for the owner, then Not counted, alphabetical within each. */
export function kinBankSenderRows(
  rows: ReadonlyArray<KinBankSenderRow>,
  options: {
    readonly ownerName: string | null;
    readonly now: number;
    readonly words?: KinBankSenderWords | undefined;
  },
): ReadonlyArray<KinBankSenderRowView> {
  return [...rows]
    .sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.address.localeCompare(b.address),
    )
    .map((row) => kinBankSenderRowView(row, options));
}

/** Section and action availability from the guarded commands' permission atoms. */
export function kinBankSenderPermissions(input: {
  readonly list: KinPermission;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
}): {
  readonly visible: boolean;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
} {
  if (input.list === "refused") return { visible: false, canAdd: false, canRemove: false };
  const ready = input.list === "granted";
  return {
    visible: true,
    canAdd: ready && input.canAdd,
    canRemove: ready && input.canRemove,
  };
}

/** The three guarded bank alert sender commands and cached list query for one app runtime. */
export function makeKinBankSenders<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  guardedRead: typeof kinGuardedRead,
) {
  const refreshOn = createKinRefreshTriggers(runtime);
  const bankSendersList = createKinRpcCommand(runtime, {
    label: "kin:bank-senders:list",
    tag: KIN_BANK_SENDER_METHODS.list,
  });
  const readList = guardedRead(bankSendersList);
  return {
    bankSendersList,
    bankSenders: createKinQueryAtomFamily(runtime, {
      label: "kin:bank-senders",
      execute: Effect.fn("KinClient.bankSenders")(function* (input: { readonly orgId: KinOrgId }) {
        return yield* readList(input);
      }),
      staleTimeMs: 30_000,
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: { readonly orgId: KinOrgId };
      }) => refreshOn("company")(target),
    }),
    bankSendersAdd: createKinRpcCommand(runtime, {
      label: "kin:bank-senders:add",
      tag: KIN_BANK_SENDER_METHODS.add,
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.orgId}:${input.address.trim().toLowerCase()}`,
      },
    }),
    bankSendersRemove: createKinRpcCommand(runtime, {
      label: "kin:bank-senders:remove",
      tag: KIN_BANK_SENDER_METHODS.remove,
      concurrency: {
        mode: "singleFlight",
        key: ({ input }) => `${input.orgId}:${input.address.trim().toLowerCase()}`,
      },
    }),
  };
}
