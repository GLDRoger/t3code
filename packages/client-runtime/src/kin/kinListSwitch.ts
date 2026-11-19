import type { KinHost } from "./kinHost.ts";
import { selectKinInboxView, type KinInboxState } from "./kinInboxModel.ts";
import type { KinAppShell } from "./kinJoin.ts";

/** The two lists a client shows: T3's coding threads, or Kin. */
export type KinList = "threads" | "kin";

/**
 * Whether the phone's Home is Kin. Kin stays non-coding, so a device with a Kin host is Kin's
 * whatever it showed last; a host still being looked for keeps the one this device saved.
 */
export function kinPhoneHome(input: {
  readonly kinOnly: boolean;
  readonly shell: KinAppShell;
  readonly host: KinHost["_tag"];
  /** Whether this device saved a Kin host; null while that is still being read. */
  readonly savedHost: boolean | null;
}): "loading" | "kin" | "coding" {
  if (input.shell === "loading") return "loading";
  if (input.kinOnly || input.shell === "chatOnly" || input.host === "host") return "kin";
  if (input.host === "none") return "coding";
  if (input.savedHost === null) return "loading";
  return input.savedHost ? "kin" : "coding";
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

/** The dot on the way into Kin from the coding threads; waiting on you outranks unread. */
export function kinSwitcherDot(kin: KinListAttention): KinSwitcherDot {
  if (kin.waiting) return "waiting";
  return kin.unread ? "unread" : null;
}

const DOT_SUFFIX = { waiting: ", something is waiting on you", unread: ", unread" } as const;

const KIN_SWITCH_TITLE = "Switch to Kin chats";

export function kinSwitcherLabel(dot: KinSwitcherDot): {
  readonly title: string;
  readonly accessibilityLabel: string;
} {
  return {
    title: KIN_SWITCH_TITLE,
    accessibilityLabel: dot === null ? KIN_SWITCH_TITLE : KIN_SWITCH_TITLE + DOT_SUFFIX[dot],
  };
}
