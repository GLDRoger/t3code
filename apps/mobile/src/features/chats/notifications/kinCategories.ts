import type { KinDeferralCardAction, KinPushCategory, KinPushChannel } from "@t3tools/contracts";

export interface KinNotificationAction {
  /**
   * For deferrals, the card's own `actionId`, so the button posts what the card would. For a
   * question, which of the push's `choices` it picks.
   */
  readonly identifier: "review" | KinDeferralCardAction | KinChoiceAnswer;
  readonly buttonTitle: string;
  readonly options: {
    readonly opensAppToForeground: true;
    readonly isAuthenticationRequired?: true;
    readonly isDestructive?: true;
  };
}

/** A question's buttons in order: the banner lists its answers as "1 · …" and "2 · …". */
export const KIN_CHOICE_ANSWERS = ["answer_1", "answer_2"] as const;
export type KinChoiceAnswer = (typeof KIN_CHOICE_ANSWERS)[number];

// Every action opens the app: a background action is not delivered reliably to a killed app.
const open = { opensAppToForeground: true } as const;
const openAfterUnlock = { opensAppToForeground: true, isAuthenticationRequired: true } as const;

/** The buttons each `aps.category` shows. `kin.message` has none: a tap opens the chat. */
export const KIN_NOTIFICATION_CATEGORIES = {
  // Approving needs the in-app biometric prompt and signature, so the lock screen only reviews.
  "kin.approval": [{ identifier: "review", buttonTitle: "Review", options: openAfterUnlock }],
  // Unlocked first, so the answer goes on this phone's own session, as a tap on the card would.
  "kin.choice": [
    { identifier: "answer_1", buttonTitle: "Answer 1", options: openAfterUnlock },
    { identifier: "answer_2", buttonTitle: "Answer 2", options: openAfterUnlock },
  ],
  "kin.deferral.confirmed": [
    { identifier: "change", buttonTitle: "Change", options: open },
    { identifier: "remind", buttonTitle: "Just remind me", options: open },
  ],
  "kin.deferral.heads_up": [
    { identifier: "start_now", buttonTitle: "Start now", options: openAfterUnlock },
    { identifier: "monday", buttonTitle: "Monday", options: openAfterUnlock },
    {
      identifier: "cancel",
      buttonTitle: "Cancel",
      options: { ...openAfterUnlock, isDestructive: true },
    },
  ],
  "kin.message": [],
} as const satisfies Record<KinPushCategory, ReadonlyArray<KinNotificationAction>>;

/**
 * Android's channels, named as the phone's settings list them, so each kind can be silenced. A
 * `quiet` one is low importance: listed, with no sound, banner or lit screen.
 */
export const KIN_ANDROID_CHANNELS = {
  "kin.messages": { name: "Messages", description: "Messages and updates in your chats" },
  "kin.questions": {
    name: "Questions and approvals",
    description: "Questions, approvals and decisions waiting on you",
  },
  "kin.briefs": { name: "Briefs", description: "Morning briefs, check-ins and summaries" },
  "kin.account": { name: "Devices and security", description: "A new device or approval key" },
  "kin.quiet": {
    name: "Quiet hours",
    description: "What arrives in your quiet hours, waiting without a sound",
    quiet: true,
  },
} as const satisfies Record<KinPushChannel, { name: string; description: string; quiet?: true }>;
