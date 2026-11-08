import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";

/** Agent CLIs inherit the server's environment, so any of these hands them a GitHub token. */
const ENV_TOKEN_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

export class T3GitHubIdentityError extends Schema.TaggedError<T3GitHubIdentityError>()(
  "T3GitHubIdentityError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not tell which GitHub identity T3 uses on this machine.";
  }
}

/**
 * Every github.com login reachable from the server's OS user, and so from every agent CLI it
 * spawns. Each field is required so the live layer (APPR-9) can't skip a source; a source it
 * can't read fails the whole probe.
 */
export interface T3GitHubIdentities {
  /**
   * T3's own credential: `GitHubRequestPolicy.credential("github.com")`, then `GET /user`. None
   * when T3 has no GitHub credential. `source` is where it came from; `"env"` fails the check.
   */
  readonly t3: Option.Option<{ readonly login: string; readonly source: string }>;
  /** Every account `gh auth status --hostname github.com` lists, active or not. */
  readonly ghAccounts: ReadonlyArray<string>;
  /**
   * The login behind `git credential fill` for `https://github.com` (`GET /user` with the
   * helper's password, never logged). None when no helper answers.
   */
  readonly gitCredential: Option.Option<string>;
}

export class T3GitHubIdentity extends Context.Service<
  T3GitHubIdentity,
  { readonly identities: Effect.Effect<T3GitHubIdentities, T3GitHubIdentityError> }
>()("t3/kin/approvals/CredentialHygiene/T3GitHubIdentity") {}

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
  readonly warnings: ReadonlyArray<"merge_token_expiring">;
  /** Names only, never values. */
  readonly envTokenNames: ReadonlyArray<string>;
  readonly t3Login: string | null;
  /** Every login found, with where it came from. Logins only; no credential leaves the probe. */
  readonly identities: ReadonlyArray<{
    readonly source: "t3" | "gh" | "git_credential";
    readonly login: string;
  }>;
  readonly checkedAt: number;
}

let issuePass: (orgId: KinOrgId, report: CredentialHygieneReport) => CredentialHygienePass;

/**
 * Proof that `requirePassing` passed. Only this module can make one (private constructor, and
 * private fields that throw on a forged object), and `OwnerMergeClient.token` requires it.
 */
export class CredentialHygienePass {
  readonly #orgId: KinOrgId;
  readonly #report: CredentialHygieneReport;
  private constructor(orgId: KinOrgId, report: CredentialHygieneReport) {
    this.#orgId = orgId;
    this.#report = report;
  }
  get orgId(): KinOrgId {
    return this.#orgId;
  }
  get report(): CredentialHygieneReport {
    return this.#report;
  }
  /** The pass's org, or null for anything this module didn't make. */
  static orgIdOf(value: unknown): KinOrgId | null {
    return typeof value === "object" && value !== null && #orgId in value
      ? (value as CredentialHygienePass).#orgId
      : null;
  }
  static {
    issuePass = (orgId, report) => new CredentialHygienePass(orgId, report);
  }
}

export class CredentialHygieneFailedError extends Schema.TaggedError<CredentialHygieneFailedError>()(
  "CredentialHygieneFailedError",
  { failures: Schema.Array(CredentialHygieneFailure) },
) {
  override get message(): string {
    return `Privileged actions are refused until the credential check passes (${this.failures.join(", ")}).`;
  }
}

/**
 * Spec section 12. The executor runs `check` at startup and hourly (audit `credential_check_failed`
 * and the owner's card on failure) and calls `requirePassing` before every privileged run.
 */
export class CredentialHygiene extends Context.Service<
  CredentialHygiene,
  {
    readonly check: (orgId: KinOrgId) => Effect.Effect<CredentialHygieneReport>;
    readonly requirePassing: (
      orgId: KinOrgId,
    ) => Effect.Effect<CredentialHygienePass, CredentialHygieneFailedError>;
  }
>()("t3/kin/approvals/CredentialHygiene") {}

const make = Effect.gen(function* () {
  const identity = yield* T3GitHubIdentity;
  const scope = yield* KinGitHubScope;
  const mergeTokens = yield* OwnerMergeClient.OwnerMergeClient;
  // Read at each check: agent CLIs inherit whatever the environment holds when they spawn.
  const configProvider = yield* ConfigProvider.ConfigProvider;

  const envTokenNames = Effect.forEach(ENV_TOKEN_NAMES, (name) =>
    Config.option(Config.String(name)).pipe(
      Effect.map((value) => (Option.isSome(value) && value.value.trim() !== "" ? [name] : [])),
      // An unreadable variable is treated as set: fail closed.
      Effect.orElseSucceed(() => [name]),
    ),
  ).pipe(
    Effect.map((names) => names.flat()),
    Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
  );

  const check = Effect.fn("CredentialHygiene.check")(function* (orgId: KinOrgId) {
    const failures = new Set<CredentialHygieneFailure>();
    const warnings: Array<"merge_token_expiring"> = [];

    const envNames = yield* envTokenNames;
    if (envNames.length > 0) failures.add("env_token");

    const status = yield* mergeTokens
      .status(orgId)
      .pipe(
        Effect.orElseSucceed((): OwnerMergeClient.OwnerMergeTokenStatus => ({ _tag: "missing" })),
      );
    const ownerLogins = new Set([scope.ownerLogin.toLowerCase()]);
    if (status._tag !== "missing") ownerLogins.add(status.login.toLowerCase());
    if (status._tag === "missing") failures.add("merge_token_missing");
    if (status._tag === "expired") failures.add("merge_token_expired");
    if (status._tag === "active" && status.expiringSoon) warnings.push("merge_token_expiring");

    const probed = yield* identity.identities.pipe(Effect.option);
    let t3Login: string | null = null;
    const found: Array<CredentialHygieneReport["identities"][number]> = [];
    if (Option.isNone(probed)) {
      failures.add("identity_unknown");
    } else {
      const { t3, ghAccounts, gitCredential } = probed.value;
      if (Option.isSome(t3)) {
        t3Login = t3.value.login;
        if (t3.value.source === "env") failures.add("env_token");
        found.push({ source: "t3", login: t3.value.login });
      }
      for (const login of ghAccounts) found.push({ source: "gh", login });
      if (Option.isSome(gitCredential)) {
        found.push({ source: "git_credential", login: gitCredential.value });
      }
    }
    const bot = scope.botLogin.toLowerCase();
    for (const { login } of found) {
      const normalized = login.toLowerCase();
      if (ownerLogins.has(normalized)) failures.add("owner_identity");
      else if (normalized !== bot) failures.add("non_bot_identity");
    }

    const report: CredentialHygieneReport = {
      passed: failures.size === 0,
      failures: [...failures],
      warnings,
      envTokenNames: envNames,
      t3Login,
      identities: found,
      checkedAt: yield* Clock.currentTimeMillis,
    };
    yield* Effect.annotateCurrentSpan({
      "kin.hygiene.passed": report.passed,
      "kin.hygiene.failures": report.failures.join(","),
    });
    return report;
  });

  const requirePassing = Effect.fn("CredentialHygiene.requirePassing")(function* (orgId: KinOrgId) {
    const report = yield* check(orgId);
    if (!report.passed) {
      return yield* new CredentialHygieneFailedError({ failures: report.failures });
    }
    return issuePass(orgId, report);
  });

  return CredentialHygiene.of({ check, requirePassing });
});

export const layer = Layer.effect(CredentialHygiene, make);
