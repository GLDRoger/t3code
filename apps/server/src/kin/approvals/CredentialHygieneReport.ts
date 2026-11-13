import * as Schema from "effect/Schema";

/**
 * The credential check's result, apart from the check itself, so the owner's chat can show one
 * without importing what the check reaches.
 */
export const CredentialHygieneFailure = Schema.Literals([
  "env_token",
  "owner_identity",
  "non_bot_identity",
  "identity_unknown",
  "merge_token_missing",
  "merge_token_expired",
]);
export type CredentialHygieneFailure = typeof CredentialHygieneFailure.Type;

export interface CredentialHygieneReport {
  readonly passed: boolean;
  readonly failures: ReadonlyArray<CredentialHygieneFailure>;
  /**
   * Why, in fixed words that name a source, file, directive, key, variable or provider instance,
   * never a value. Shown to the owner and written to the audit log.
   */
  readonly reasons: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<"merge_token_expiring">;
  /** Credential variables set in the server's environment. Names only, never values. */
  readonly envTokenNames: ReadonlyArray<string>;
  /** The first T3 credential's login, in the order T3 ranks them (saved, app, then personal). */
  readonly t3Login: string | null;
  /** Every login found, with where it came from. Logins only; no credential leaves the probe. */
  readonly identities: ReadonlyArray<{
    readonly source: "t3" | "gh" | "git_credential" | "ssh";
    readonly login: string;
  }>;
  readonly checkedAt: number;
}

/** The audit entry's `result` for a failing check: the failures, then their reasons. */
export const failureResult = (report: {
  readonly failures: ReadonlyArray<string>;
  readonly reasons: ReadonlyArray<string>;
}) =>
  report.reasons.length === 0
    ? report.failures.join(",")
    : `${report.failures.join(",")}: ${report.reasons.join("; ")}`;
