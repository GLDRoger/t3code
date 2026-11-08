import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
 * The GitHub login T3 itself (and so every agent CLI it spawns) uses for github.com:
 * `GitHubRequestPolicy.credential("github.com")` followed by `GET /user`. None when T3 has no
 * GitHub credential at all.
 */
export class T3GitHubIdentity extends Context.Service<
  T3GitHubIdentity,
  {
    readonly current: Effect.Effect<
      Option.Option<{ readonly login: string; readonly source: string }>,
      T3GitHubIdentityError
    >;
  }
>()("t3/kin/approvals/CredentialHygiene/T3GitHubIdentity") {}

export const CredentialHygieneFailure = Schema.Literals([
  "env_token",
  "owner_identity",
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
  readonly checkedAt: number;
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
    ) => Effect.Effect<CredentialHygieneReport, CredentialHygieneFailedError>;
  }
>()("t3/kin/approvals/CredentialHygiene") {}

const make = Effect.gen(function* () {
  const identity = yield* T3GitHubIdentity;
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
    const ownerLogin = status._tag === "missing" ? null : status.login.toLowerCase();
    if (status._tag === "missing") failures.add("merge_token_missing");
    if (status._tag === "expired") failures.add("merge_token_expired");
    if (status._tag === "active" && status.expiringSoon) warnings.push("merge_token_expiring");

    const current = yield* identity.current.pipe(Effect.option);
    let t3Login: string | null = null;
    if (Option.isNone(current)) {
      failures.add("identity_unknown");
    } else if (Option.isSome(current.value)) {
      t3Login = current.value.value.login;
      if (current.value.value.source === "env") failures.add("env_token");
      if (ownerLogin !== null && t3Login.toLowerCase() === ownerLogin) {
        failures.add("owner_identity");
      }
    }

    const report: CredentialHygieneReport = {
      passed: failures.size === 0,
      failures: [...failures],
      warnings,
      envTokenNames: envNames,
      t3Login,
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
    return report;
  });

  return CredentialHygiene.of({ check, requirePassing });
});

export const layer = Layer.effect(CredentialHygiene, make);
