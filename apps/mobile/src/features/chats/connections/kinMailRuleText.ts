import {
  kinMailRuleBreaks,
  type KinMailRuleRowView,
} from "@t3tools/client-runtime/kin/kinMailRules";

const WRAP = String.fromCharCode(0x200b);

/** An address or domain wraps only after `@` and `.`: a zero-width space marks each place. */
export const kinPhoneBreakable = (text: string) => kinMailRuleBreaks(text).join(WRAP);

/** A rule row's description: its lead and words, why it isn't running, then this month's runs. */
export const kinMailRulePhoneLines = (
  row: Pick<KinMailRuleRowView, "does" | "counts"> & {
    readonly state: Pick<KinMailRuleRowView["state"], "detail">;
  },
) => [row.does, row.state.detail, row.counts].filter((line) => line !== null).join("\n");
