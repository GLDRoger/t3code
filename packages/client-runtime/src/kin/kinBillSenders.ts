import {
  formatKinWhen,
  kinWhenParts,
  type EnvironmentId,
  type KinBillSendersResult,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { createKinQueryAtomFamily, createKinRpcCommand, type KinPermission } from "./kinAccess.ts";
import { kinBankSenderAddressSegments } from "./kinBankSenders.ts";
import type { kinGuardedRead } from "./kinClient.ts";
import { createKinRefreshTriggers } from "./kinRefresh.ts";

type KinBillSenderRow = KinBillSendersResult["rows"][number];
export type KinBillSenderState = KinBillSenderRow["state"];
export type KinBillSenderAction = "approve" | "decline" | "remove" | "addBack";

interface KinBillSenderWords {
  readonly zone?: string | undefined;
  readonly locale?: string | undefined;
}

export const KIN_BILL_SENDER_METHODS = {
  list: "kin.billSenders.list",
  approve: "kin.billSenders.approve",
  decline: "kin.billSenders.decline",
  remove: "kin.billSenders.remove",
  add: "kin.billSenders.add",
  readSince: "kin.billSenders.readSince",
} as const;

// The host's own normalizeAddress check, so the form refuses only what the host would.
const ADDRESS_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const MAX_ADDRESS_LEN = 254;

// The second sentence is the approval card's own, so both ask the same thing.
const READS =
  "Kin will read bills this address sends to the company's mailboxes and suggest them as expenses for you to keep. Approving also reads the mail Kin held from it in the last 30 days.";

export const KIN_BILL_SENDERS = {
  title: "Billing senders",
  description:
    "Addresses whose mailed bills Kin reads into suggested expenses. Nothing counts in Money until it is kept.",
  /** Under the heading while Money is off; approving, declining and adding still save. */
  moneyOff:
    "Kin reads no bills from mail while Money is off. You can turn it on in Settings › Sections.",
  loading: "Loading billing senders",
  loadFailed: "Couldn't load billing senders.",
  empty:
    "No billing senders yet. When Kin sees mail that looks like a bill from a new address, a card in chat asks whether to read its bills.",
  groups: {
    waiting: "Waiting for an answer",
    approved: "Approved",
    declined: "Declined",
  } satisfies Readonly<Record<KinBillSenderState, string>>,
  action: {
    approve: "Approve",
    decline: "Decline",
    remove: "Remove",
    addBack: "Add back",
  } satisfies Readonly<Record<KinBillSenderAction, string>>,
  add: "Add address",
  addTitle: "Add a billing sender",
  addDescription: "Use the exact From address on the bill emails.",
  addSubmit: "Continue",
  addressLabel: "Email address",
  addressPlaceholder: "billing@vendor.example",
  /** The host's own refusal for an address it can't read. */
  addressInvalid: "Enter a full email address for the billing sender.",
  readTitle: (address: string) => `Read bills from ${address}?`,
  readDetail: READS,
  readConfirm: "Approve",
  declineTitle: (address: string) => `Decline ${address}?`,
  declineDetail:
    "Kin will not read its bills or ask about it again. It can be added back here at any time.",
  declineConfirm: "Decline",
  removeTitle: (address: string) => `Stop reading bills from ${address}?`,
  removeDetail:
    "Expenses already suggested from its mail stay. New mail from it is not read until the address is added again.",
  removeConfirm: "Remove",
  failed: {
    approve: "Couldn't approve this billing sender.",
    decline: "Couldn't decline this billing sender.",
    remove: "Couldn't remove this billing sender.",
    addBack: "Couldn't add this billing sender.",
  } satisfies Readonly<Record<KinBillSenderAction, string>>,
  addFailed: "Couldn't add this billing sender.",
  addedTitle: "Billing sender approved",
  seen: (count: number, date: string | null) =>
    count === 1
      ? date === null
        ? "1 mail seen"
        : `1 mail seen, on ${date}`
      : date === null
        ? `${count} mails seen`
        : `${count} mails seen, the newest on ${date}`,
  askedInChat: "Also asked on a card in chat",
  approvedByOn: (by: string, date: string) => `Approved by ${by} on ${date}`,
  approvedBy: (by: string) => `Approved by ${by}`,
  approvedOn: (date: string) => `Approved on ${date}`,
  declinedByOn: (by: string, date: string) => `Declined by ${by} on ${date}`,
  declinedBy: (by: string) => `Declined by ${by}`,
  declinedOn: (date: string) => `Declined on ${date}`,
  readSince: {
    open: "Read this sender's bills since…",
    title: (address: string) => `Read bills from ${address} since…`,
    detail:
      "Kin looks through the company's mailboxes for mail from this address since the day below and suggests its bills as expenses. It reads up to 200 mails at a time.",
    day: "Since",
    submit: "Read bills",
    working: "Looking through mail…",
    failed: "Couldn't read this sender's mail.",
    choices: {
      lastMonth: "First of last month",
      thisMonth: "First of this month",
      thisYear: "First of this year",
    },
  },
} as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** Today as `YYYY-MM-DD` in `zone`, the reader's own when absent. */
export function kinBillSenderToday(now: Date | number, zone?: string): string {
  const part = kinWhenParts(now, zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone);
  return `${part.year}-${pad(part.month)}-${pad(part.day)}`;
}

/** Days offered first: the first of last month (the default), of this month, and of this year. */
export function kinBillSenderSinceChoices(
  now: Date | number,
  zone?: string,
): ReadonlyArray<{ readonly label: string; readonly day: string }> {
  const [year, month] = kinBillSenderToday(now, zone).split("-").map(Number) as [number, number];
  const last = month === 1 ? `${year - 1}-12-01` : `${year}-${pad(month - 1)}-01`;
  const words = KIN_BILL_SENDERS.readSince.choices;
  return [
    { label: words.lastMonth, day: last },
    { label: words.thisMonth, day: `${year}-${pad(month)}-01` },
    ...(month > 2 ? [{ label: words.thisYear, day: `${year}-01-01` }] : []),
  ];
}

/** The day the control starts on: the first of last month in the reader's zone. */
export const kinBillSenderSinceDefault = (now: Date | number, zone?: string) =>
  kinBillSenderSinceChoices(now, zone)[0]!.day;

/**
 * A finished read, as the row shows it: the host's sentence whole, and whether pressing again does
 * more (older mail remains, or Kin stopped early). Nothing presses again by itself.
 */
export function kinBillSenderReadResult(result: {
  readonly queued: number;
  readonly older: boolean;
  readonly stopped?: true | undefined;
  readonly text: string;
}): { readonly line: string; readonly again: boolean } {
  return { line: result.text, again: result.older || result.stopped === true };
}

/** The address the host will store, or the host's own sentence for one it can't read. */
export function kinBillSenderAddInput(
  orgId: KinOrgId,
  typed: string,
):
  | { readonly ok: true; readonly input: { readonly orgId: KinOrgId; readonly address: string } }
  | { readonly ok: false; readonly problem: string } {
  const address = typed.trim().toLowerCase();
  if (address.length > MAX_ADDRESS_LEN || !ADDRESS_RE.test(address))
    return { ok: false, problem: KIN_BILL_SENDERS.addressInvalid };
  return { ok: true, input: { orgId, address } };
}

/** The question before a change; Approve, Add and Add back all say what reading bills means. */
export function kinBillSenderConfirm(
  action: KinBillSenderAction | "add",
  address: string,
): {
  readonly title: string;
  readonly detail: string;
  readonly action: string;
  readonly destructive: boolean;
} {
  switch (action) {
    case "approve":
    case "add":
    case "addBack":
      return {
        title: KIN_BILL_SENDERS.readTitle(address),
        detail: KIN_BILL_SENDERS.readDetail,
        action: KIN_BILL_SENDERS.readConfirm,
        destructive: false,
      };
    case "decline":
      return {
        title: KIN_BILL_SENDERS.declineTitle(address),
        detail: KIN_BILL_SENDERS.declineDetail,
        action: KIN_BILL_SENDERS.declineConfirm,
        destructive: true,
      };
    case "remove":
      return {
        title: KIN_BILL_SENDERS.removeTitle(address),
        detail: KIN_BILL_SENDERS.removeDetail,
        action: KIN_BILL_SENDERS.removeConfirm,
        destructive: true,
      };
  }
}

const zoneOf = (words: KinBillSenderWords) =>
  words.zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;

function formatSenderDate(at: number, now: number, words: KinBillSenderWords): string {
  const zone = zoneOf(words);
  const style = kinWhenParts(at, zone).year === kinWhenParts(now, zone).year ? "date" : "dateYear";
  return formatKinWhen(at, style, { zone, locale: words.locale });
}

export interface KinBillSenderRowView {
  readonly address: string;
  readonly addressSegments: ReturnType<typeof kinBankSenderAddressSegments>;
  readonly state: KinBillSenderState;
  readonly seenLine: string | null;
  readonly askedLine: string | null;
  readonly decidedLine: string | null;
  readonly actions: ReadonlyArray<KinBillSenderAction>;
}

const ACTIONS: Readonly<Record<KinBillSenderState, ReadonlyArray<KinBillSenderAction>>> = {
  waiting: ["approve", "decline"],
  approved: ["remove"],
  declined: ["addBack"],
};

/**
 * One billing sender's lines for both web and phone. `name` is what the sender wrote about itself,
 * so it is never shown: the address is what was approved.
 */
export function kinBillSenderRowView(
  row: KinBillSenderRow,
  options: { readonly now: number; readonly words?: KinBillSenderWords | undefined },
): KinBillSenderRowView {
  const words = options.words ?? {};
  const date = (at: number | null) =>
    at === null ? null : formatSenderDate(at, options.now, words);
  const by = row.decidedBy?.trim() || null;
  const decided = date(row.decidedAt);
  let decidedLine: string | null = null;
  if (row.state === "approved") {
    if (by !== null && decided !== null) decidedLine = KIN_BILL_SENDERS.approvedByOn(by, decided);
    else if (by !== null) decidedLine = KIN_BILL_SENDERS.approvedBy(by);
    else if (decided !== null) decidedLine = KIN_BILL_SENDERS.approvedOn(decided);
  } else if (row.state === "declined") {
    if (by !== null && decided !== null) decidedLine = KIN_BILL_SENDERS.declinedByOn(by, decided);
    else if (by !== null) decidedLine = KIN_BILL_SENDERS.declinedBy(by);
    else if (decided !== null) decidedLine = KIN_BILL_SENDERS.declinedOn(decided);
  }
  return {
    address: row.address,
    addressSegments: kinBankSenderAddressSegments(row.address),
    state: row.state,
    seenLine:
      row.seenCount > 0
        ? KIN_BILL_SENDERS.seen(row.seenCount, date(row.lastSeenAt ?? row.firstSeenAt))
        : null,
    askedLine: row.state === "waiting" && row.askedInChat ? KIN_BILL_SENDERS.askedInChat : null,
    decidedLine,
    actions: ACTIONS[row.state],
  };
}

const GROUP_ORDER: ReadonlyArray<KinBillSenderState> = ["waiting", "approved", "declined"];

/** Waiting for an answer, then Approved, then Declined; empty groups left out; by address within. */
export function kinBillSenderGroups(
  rows: ReadonlyArray<KinBillSenderRow>,
  options: { readonly now: number; readonly words?: KinBillSenderWords | undefined },
): ReadonlyArray<{
  readonly state: KinBillSenderState;
  readonly title: string;
  readonly rows: ReadonlyArray<KinBillSenderRowView>;
}> {
  return GROUP_ORDER.flatMap((state) => {
    const inGroup = rows
      .filter((row) => row.state === state)
      .sort((a, b) => a.address.localeCompare(b.address))
      .map((row) => kinBillSenderRowView(row, options));
    return inGroup.length === 0
      ? []
      : [{ state, title: KIN_BILL_SENDERS.groups[state], rows: inGroup }];
  });
}

/** Whether the section shows at all, and which taps it offers, from the commands' permissions. */
type KinBillSenderGrant = KinBillSenderAction | "add" | "readSince";

export function kinBillSenderPermissions(input: {
  readonly list: KinPermission;
  readonly grants: Readonly<Record<KinBillSenderGrant, boolean>>;
}): {
  readonly visible: boolean;
  readonly can: (action: KinBillSenderGrant) => boolean;
} {
  if (input.list === "refused") return { visible: false, can: () => false };
  const ready = input.list === "granted";
  return { visible: true, can: (action) => ready && input.grants[action] };
}

/** The guarded billing sender commands and the cached list for one app runtime. */
export function makeKinBillSenders<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  guardedRead: typeof kinGuardedRead,
) {
  const refreshOn = createKinRefreshTriggers(runtime);
  const billSendersList = createKinRpcCommand(runtime, {
    label: "kin:bill-senders:list",
    tag: KIN_BILL_SENDER_METHODS.list,
  });
  const readList = guardedRead(billSendersList);
  const oneAtATime = {
    mode: "singleFlight",
    key: ({ input }: { readonly input: { readonly orgId: KinOrgId; readonly address: string } }) =>
      `${input.orgId}:${input.address.trim().toLowerCase()}`,
  } as const;
  return {
    billSendersList,
    billSenders: createKinQueryAtomFamily(runtime, {
      label: "kin:bill-senders",
      execute: Effect.fn("KinClient.billSenders")(function* (input: { readonly orgId: KinOrgId }) {
        return yield* readList(input);
      }),
      staleTimeMs: 30_000,
      // Every change on the host, a card answered in chat included, moves this topic.
      refreshTrigger: (target: {
        readonly environmentId: EnvironmentId;
        readonly input: { readonly orgId: KinOrgId };
      }) => refreshOn("billSenders")(target),
    }),
    billSendersApprove: createKinRpcCommand(runtime, {
      label: "kin:bill-senders:approve",
      tag: KIN_BILL_SENDER_METHODS.approve,
      concurrency: oneAtATime,
    }),
    billSendersDecline: createKinRpcCommand(runtime, {
      label: "kin:bill-senders:decline",
      tag: KIN_BILL_SENDER_METHODS.decline,
      concurrency: oneAtATime,
    }),
    billSendersRemove: createKinRpcCommand(runtime, {
      label: "kin:bill-senders:remove",
      tag: KIN_BILL_SENDER_METHODS.remove,
      concurrency: oneAtATime,
    }),
    billSendersAdd: createKinRpcCommand(runtime, {
      label: "kin:bill-senders:add",
      tag: KIN_BILL_SENDER_METHODS.add,
      concurrency: oneAtATime,
    }),
    // Up to about 20 seconds on the host: one read per address at a time, never repeated by itself.
    billSendersReadSince: createKinRpcCommand(runtime, {
      label: "kin:bill-senders:read-since",
      tag: KIN_BILL_SENDER_METHODS.readSince,
      concurrency: oneAtATime,
    }),
  };
}
