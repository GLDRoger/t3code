import type { KinStartList } from "@t3tools/contracts/settings";

import { selectKinInboxView, type KinInboxState } from "./kinInboxModel.ts";

/** The two lists the brand mark switches between. */
export type KinList = "threads" | "kin";

export function kinOtherList(list: KinList): KinList {
  return list === "threads" ? "kin" : "threads";
}

/**
 * The list a fresh launch opens to. Kin only when this device has seen a Kin host, so a client
 * that never used Kin always opens to threads.
 */
export function kinStartListFor(input: {
  readonly setting: KinStartList;
  readonly lastUsed: KinList | null;
  readonly kinSeen: boolean;
}): KinList {
  if (!input.kinSeen) return "threads";
  if (input.setting === "lastUsed") return input.lastUsed ?? "threads";
  return input.setting;
}

/** What a list holds for the viewer. */
export interface KinListAttention {
  readonly waiting: boolean;
  readonly unread: boolean;
}

export const NO_KIN_LIST_ATTENTION: KinListAttention = { waiting: false, unread: false };

export function kinInboxAttention(inbox: KinInboxState | null): KinListAttention {
  if (inbox === null) return NO_KIN_LIST_ATTENTION;
  const view = selectKinInboxView(inbox);
  return { waiting: view.waitingCount > 0, unread: view.unreadCount > 0 };
}

export type KinSwitcherDot = "waiting" | "unread" | null;

/** The mark's dot speaks for the list you are not in; waiting on you outranks unread. */
export function kinSwitcherDot(input: {
  readonly current: KinList;
  readonly kin: KinListAttention;
  readonly threads: KinListAttention;
}): KinSwitcherDot {
  const other = input.current === "threads" ? input.kin : input.threads;
  if (other.waiting) return "waiting";
  return other.unread ? "unread" : null;
}

const DOT_SUFFIX = { waiting: ", something is waiting on you", unread: ", unread" } as const;

export function kinSwitcherLabel(input: {
  readonly current: KinList;
  readonly dot: KinSwitcherDot;
}): { readonly title: string; readonly accessibilityLabel: string } {
  const title = `Switch to ${input.current === "threads" ? "Kin chats" : "coding threads"}`;
  return { title, accessibilityLabel: input.dot === null ? title : title + DOT_SUFFIX[input.dot] };
}
