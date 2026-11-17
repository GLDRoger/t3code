import { kinIsOwnerClientService, type KinOwnerClientService } from "@t3tools/contracts";

import { googleMail } from "./Google.ts";
import type { MailProvider } from "./MailProvider.ts";
import { microsoftMail } from "./Microsoft.ts";

/**
 * Every mail provider, by connection preset. A new one is a vendor's mapping and descriptor
 * (`MailVendor`) added here; `MailVendors.test.ts` runs its case table on every one.
 */
export const MAIL_PROVIDERS: Readonly<Record<KinOwnerClientService, MailProvider>> = {
  google: googleMail,
  microsoft: microsoftMail,
};
export const MAIL_PRESETS = Object.keys(MAIL_PROVIDERS) as ReadonlyArray<KinOwnerClientService>;

/** The mail provider behind a connection; only Kin's own (builtin) connections have one. */
export const mailProviderOf = (row: {
  readonly kind: string;
  readonly preset: string | null;
}): MailProvider | undefined =>
  row.kind === "builtin" && row.preset !== null && kinIsOwnerClientService(row.preset)
    ? MAIL_PROVIDERS[row.preset]
    : undefined;
