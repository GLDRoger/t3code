// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import { kinWhenFormat } from "@t3tools/contracts";

import { kinWorkRow, type KinWorkNames, type KinWorkRowView } from "./kinWork.ts";
import type {
  KinChatId,
  KinDealPage,
  KinMessageId,
  KinPartyPage,
  KinPromiseFrom,
  KinRecord,
} from "@t3tools/contracts";

/**
 * Promises both ways (obligations): the "Promised" mark, where one was made, a deal's Promises,
 * and a client's Contract dates line. Web and phone draw these words; the host decides the facts.
 */

export const KIN_PROMISES = {
  mark: "Promised",
  title: "Promises",
  add: "Add",
  addTitle: "Add a promise",
  ours: "We promise",
  theirs: "They promise",
  oursShort: "We promised",
  theirsShort: "They owe",
  none: "No promises on this deal yet.",
  what: "What",
  by: "By",
  where: "Where it was promised",
  wherePlaceholder: "At the site visit",
  save: "Add promise",
  failed: "Couldn't add that promise.",
  contract: "Contract dates",
  noticeDays: "Notice days",
  noticeDaysHint: "Days before it renews to end or change it",
  noticeDaysProblem: "Say a whole number of days, 1 to 730.",
} as const;

const dateFormat = () => kinWhenFormat("date");

/** "From chat, 20 Nov", "From a meeting, 18 Nov", "From a mail, 19 Nov", or the typed words. */
export function kinPromiseFromText(from: KinPromiseFrom): string {
  if (from.kind === "note") return from.note ?? "";
  const where =
    from.kind === "chat" ? "From chat" : from.kind === "meeting" ? "From a meeting" : "From a mail";
  return from.at === undefined ? where : `${where}, ${dateFormat().format(new Date(from.at))}`;
}

export interface KinPromiseView {
  /** "From chat, 20 Nov"; null when it doesn't say where. */
  readonly from: string | null;
  /** The message to open, where the reader may; else the words only. */
  readonly open: { readonly chatId: KinChatId; readonly messageId: KinMessageId } | null;
}

/** A row's promise: null for anything that isn't one. */
export function kinPromiseOf(record: Pick<KinRecord, "category" | "from">): KinPromiseView | null {
  if (record.category !== "obligation") return null;
  const from = record.from;
  if (from === undefined) return { from: null, open: null };
  return {
    from: kinPromiseFromText(from) || null,
    open:
      from.chatId === undefined || from.messageId === undefined
        ? null
        : { chatId: from.chatId, messageId: from.messageId },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar day as written, with no zone in it: "1 Mar". */
const calendarDay = (day: string) => {
  const [, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[month! - 1]}`;
};

/** The Contract dates line: "Renews 1 Mar · notice by 31 Dec", amber within the heads-up. */
export function kinContractLine(
  contract: KinPartyPage["contract"],
): { readonly text: string; readonly soon: boolean } | null {
  if (contract === undefined) return null;
  return {
    text: [
      `Renews ${calendarDay(contract.renewsOn)}`,
      contract.noticeBy === undefined ? null : `notice by ${calendarDay(contract.noticeBy)}`,
    ]
      .filter((part) => part !== null)
      .join(" · "),
    soon: contract.soon === true,
  };
}

/** "30" as the project form holds it: a whole number of days, 1 to 730, or empty for none. */
export function kinNoticeDays(text: string): number | null | { readonly problem: string } {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const days = Number(trimmed);
  return /^\d+$/.test(trimmed) && days >= 1 && days <= 730
    ? days
    : { problem: KIN_PROMISES.noticeDaysProblem };
}

export interface KinDealPromisesView {
  readonly ours: ReadonlyArray<KinWorkRowView & { readonly promise: KinPromiseView | null }>;
  readonly theirs: ReadonlyArray<KinWorkRowView & { readonly promise: KinPromiseView | null }>;
}

/** A deal's Promises: ours, then theirs, each as the host ordered them. Null from older hosts. */
export function kinDealPromises(
  page: Pick<KinDealPage, "promises" | "deal">,
  names: KinWorkNames,
  now: Date,
): KinDealPromisesView | null {
  if (page.promises === undefined) return null;
  const party = { key: page.deal.party.key, title: page.deal.party.title };
  const row = (record: KinRecord) => ({
    ...kinWorkRow(record, names, now, { party, project: null, sided: true }),
    promise: kinPromiseOf(record),
  });
  return {
    ours: page.promises.filter((one) => one.side === "ours").map(row),
    theirs: page.promises.filter((one) => one.side === "theirs").map(row),
  };
}
