// Taps need the owner-tap dispatcher that also gates the owner check; see the
// deferral card release gate in docs/kin/specs/triggers.md.
export const deferralCardActionsReady = false;
export const deferralCardActions = ["change", "remind", "start_now", "monday", "cancel"] as const;
