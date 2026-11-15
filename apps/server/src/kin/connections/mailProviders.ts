import { googleMail } from "./Google.ts";
import type { MailProvider } from "./MailProvider.ts";

/** Every mail provider, by connection preset. A new one is a MailProvider added here. */
const MAIL_PROVIDERS: Readonly<Record<string, MailProvider>> = {
  [googleMail.preset]: googleMail,
};
export const MAIL_PRESETS: ReadonlyArray<string> = Object.keys(MAIL_PROVIDERS);

/** The mail provider behind a connection; only Kin's own (builtin) connections have one. */
export const mailProviderOf = (row: {
  readonly kind: string;
  readonly preset: string | null;
}): MailProvider | undefined =>
  row.kind === "builtin" && row.preset !== null ? MAIL_PROVIDERS[row.preset] : undefined;
