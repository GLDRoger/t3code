import { KIN_DEFERRAL_CARD_ACTIONS } from "@t3tools/contracts";

// Taps need the owner-tap dispatcher that also gates the owner check; see the
// deferral card release gate in docs/kin/specs/triggers.md.
export const deferralCardActionsReady = false;
export const deferralCardActions = KIN_DEFERRAL_CARD_ACTIONS;
