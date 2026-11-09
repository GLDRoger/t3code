import type { KinDeferralCardAction, KinPushCategory } from "@t3tools/contracts";

export interface KinNotificationAction {
  /** For deferrals, the card's own `actionId`, so the button posts what the card would. */
  readonly identifier: "review" | KinDeferralCardAction;
  readonly buttonTitle: string;
  readonly options: {
    readonly opensAppToForeground: true;
    readonly isAuthenticationRequired?: true;
    readonly isDestructive?: true;
  };
}

// Every action opens the app: a background action is not delivered reliably to a killed app.
const open = { opensAppToForeground: true } as const;
const openAfterUnlock = { opensAppToForeground: true, isAuthenticationRequired: true } as const;

/** The buttons each `aps.category` shows. `kin.message` has none: a tap opens the chat. */
export const KIN_NOTIFICATION_CATEGORIES = {
  // Approving needs the in-app biometric prompt and signature, so the lock screen only reviews.
  "kin.approval": [{ identifier: "review", buttonTitle: "Review", options: openAfterUnlock }],
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
