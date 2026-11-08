import type { KinOrgId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

// A value import back into CredentialHygiene, which imports this file; both only use the other
// inside effects, after both modules have loaded.
import { CredentialHygienePass } from "../approvals/CredentialHygiene.ts";
import {
  gitHubJson,
  gitHubStatus,
  type GitHubStatusResponse,
  type KinGitHubRequestError,
} from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import { isScopedRepo, KinGitHubScope } from "./KinGitHubScope.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spec section 6: the token is made with a 90-day expiry; one day of slack for time zones. */
const MAX_LIFETIME_MS = 91 * DAY_MS;
const OWNER_MERGE_TOKEN_WARN_MS = 7 * DAY_MS;
/** A hygiene pass is proof of a check this recent; the executor checks right before it merges. */
const PASS_MAX_AGE_MS = 60 * 1000;
/**
 * Any PR number works if GitHub checks the token's permissions before it looks the PR up (to be
 * confirmed on a scratch repo, spec section 10); otherwise a missing PR answers 404, which is
 * refused as inconclusive. The invalid `event` and `commit_id` make GitHub refuse with 422 even
 * when the token could review, so the probe can never create a review.
 */
const DEFAULT_REVIEW_PROBE_PR = 1;
/** What GitHub says when a fine-grained token lacks the permission an endpoint needs. */
const NOT_ACCESSIBLE_MESSAGE = "Resource not accessible by personal access token";
const REVIEW_PROBE_BODY = {
  event: "KIN_PERMISSION_PROBE",
  commit_id: "0000000000000000000000000000000000000000",
};

/** Keychain item `kin-owner-merge` / `<orgId>`. `login` lets the hygiene check spot T3 using it. */
const StoredMergeToken = Schema.Struct({
  token: Schema.String,
  login: Schema.String,
  expiresAt: Schema.Int,
  savedAt: Schema.Int,
});
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(StoredMergeToken));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(StoredMergeToken));

const RepoInfo = Schema.Struct({
  owner: Schema.Struct({ login: Schema.String, type: Schema.String }),
  permissions: Schema.optional(Schema.Struct({ push: Schema.optional(Schema.Boolean) })),
});

/**
 * A permission probe must be GitHub refusing the token for lacking the permission. A rate limit
 * looks like a 403 too, and 404 can mean the token can't see the repo or the probe's PR is missing.
 */
function classifyProbe(
  answer: GitHubStatusResponse,
): "denied" | "rate_limited" | "inconclusive" | "allowed" {
  if (answer.status === 429) return "rate_limited";
  if (answer.status === 404) return "inconclusive";
  if (answer.status !== 403) return "allowed";
  if (
    answer.headers["x-ratelimit-remaining"] === "0" ||
    answer.headers["retry-after"] !== undefined
  ) {
    return "rate_limited";
  }
  return answer.message?.trim() === NOT_ACCESSIBLE_MESSAGE ? "denied" : "allowed";
}

export class OwnerMergeTokenRefusedError extends Schema.TaggedError<OwnerMergeTokenRefusedError>()(
  "OwnerMergeTokenRefusedError",
  {
    reason: Schema.Literals([
      "not_fine_grained",
      "no_expiry",
      "expired",
      "lifetime_too_long",
      "wrong_owner",
      "no_repos",
      "repo_unreachable",
      "cannot_push",
      "too_broad",
      "probe_inconclusive",
      "rate_limited",
      "other_repos",
    ]),
    // A login, repository or permission name with the probe's HTTP status; never the token.
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail ?? "unknown";
    switch (this.reason) {
      case "not_fine_grained":
        return "Use a fine-grained personal access token (github_pat_…) with Contents: Read and write and Metadata: Read only.";
      case "no_expiry":
        return "The token has no expiry. Make one that expires in 90 days.";
      case "expired":
        return "The token has already expired.";
      case "lifetime_too_long":
        return "The token expires more than 90 days from now. Make one that expires in 90 days.";
      case "wrong_owner":
        return `The token belongs to ${detail}, not the Kin owner set in KIN_GITHUB_OWNER_LOGIN.`;
      case "no_repos":
        return "KIN_GITHUB_REPOS names no repository, so the token can't be checked.";
      case "repo_unreachable":
        return `The token can't read ${detail}. Give it access to every repository in KIN_GITHUB_REPOS.`;
      case "cannot_push":
        return `The token can't push to ${detail}. Give it Contents: Read and write.`;
      case "too_broad":
        return `GitHub didn't refuse the token where it should (${detail}). Kin only stores a token that can't administer the repository or organization, see webhooks or secrets, or review. Make one with Contents: Read and write and Metadata: Read only.`;
      case "probe_inconclusive":
        return `Kin can't tell what the token can do (${detail}). A 404 means the token may lack access to the repository, or the PR the review check uses doesn't exist; rerun with --probe-pr <number of an existing PR>.`;
      case "rate_limited":
        return `GitHub rate-limited a check (${detail}). Nothing was stored; try again later.`;
      case "other_repos":
        return `The token reaches repositories outside KIN_GITHUB_REPOS (${detail}). Choose Only select repositories.`;
    }
  }
}

export class OwnerMergeTokenMissingError extends Schema.TaggedError<OwnerMergeTokenMissingError>()(
  "OwnerMergeTokenMissingError",
  { orgId: Schema.String, expired: Schema.Boolean },
) {
  override get message(): string {
    return this.expired
      ? "The owner's merge token has expired. Make a new one and run scripts/kin-github-app.ts --merge-token."
      : "No owner merge token is set. Run scripts/kin-github-app.ts --merge-token on the Kin host.";
  }
}

export type OwnerMergeTokenStatus =
  | { readonly _tag: "missing" }
  | {
      readonly _tag: "active";
      readonly login: string;
      readonly expiresAt: number;
      /** Inside the last 7 days: the owner gets a card asking for a new token. */
      readonly expiringSoon: boolean;
    }
  | { readonly _tag: "expired"; readonly login: string; readonly expiresAt: number };

/** GitHub sends `2026-12-01 00:00:00 UTC` or `… +0000` on fine-grained token responses. */
function parseTokenExpiration(header: string | undefined): number | null {
  if (header === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{2}:?\d{2})$/.exec(
    header.trim(),
  );
  if (match === null) return null;
  const [, date, time, zone] = match as unknown as [string, string, string, string];
  const offset = zone === "UTC" ? "Z" : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const at = Date.parse(`${date}T${time}${offset}`);
  return Number.isFinite(at) ? at : null;
}

/**
 * The owner's merge credential (spec section 6): read per execution and never logged, put in an
 * environment variable or handed to a child process. APPR-9 adds the merge call here.
 */
export class OwnerMergeClient extends Context.Service<
  OwnerMergeClient,
  {
    /**
     * Checks the token's login and expiry, that it can push to every scoped repository, that GitHub
     * refuses it administration, webhooks, secrets and reviews there, and that it reaches no other
     * repositories (spec sections 6 and 10), then stores it. `probePr` is the PR the review probe
     * targets on every repository, 1 by default.
     */
    readonly save: (input: {
      readonly orgId: KinOrgId;
      readonly token: Redacted.Redacted<string>;
      readonly probePr?: number | undefined;
    }) => Effect.Effect<
      { readonly login: string; readonly expiresAt: number },
      OwnerMergeTokenRefusedError | KinGitHubRequestError | Keychain.KinKeychainError
    >;
    readonly status: (
      orgId: KinOrgId,
    ) => Effect.Effect<OwnerMergeTokenStatus, Keychain.KinKeychainError>;
    /**
     * Only `CredentialHygiene.requirePassing` makes a pass, so the token needs a passing check, made
     * in the last 60 seconds. A forged or stale pass is a defect.
     */
    readonly token: (
      pass: CredentialHygienePass,
    ) => Effect.Effect<
      Redacted.Redacted<string>,
      OwnerMergeTokenMissingError | Keychain.KinKeychainError
    >;
  }
>()("t3/kin/github/OwnerMergeClient") {}

const make = Effect.gen(function* () {
  const keychain = yield* Keychain.KinKeychain;
  const client = yield* HttpClient.HttpClient;
  const scope = yield* KinGitHubScope;

  const stored = (orgId: KinOrgId) =>
    keychain
      .get("kin-owner-merge", orgId)
      .pipe(Effect.map(Option.flatMap((value) => decodeStored(Redacted.value(value)))));

  const save = Effect.fn("OwnerMergeClient.save")(function* (input: {
    readonly orgId: KinOrgId;
    readonly token: Redacted.Redacted<string>;
    readonly probePr?: number | undefined;
  }) {
    // Classic tokens carry scopes, not per-repository permissions, so the probes below can't bound them.
    if (!Redacted.value(input.token).startsWith("github_pat_")) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "not_fine_grained" });
    }
    const user = yield* gitHubJson({
      client,
      operation: "user.get",
      method: "GET",
      path: "/user",
      token: input.token,
      schema: Schema.Struct({ login: Schema.String }),
    });
    const expiresAt = parseTokenExpiration(user.headers["github-authentication-token-expiration"]);
    const now = yield* Clock.currentTimeMillis;
    if (expiresAt === null) return yield* new OwnerMergeTokenRefusedError({ reason: "no_expiry" });
    if (expiresAt <= now) return yield* new OwnerMergeTokenRefusedError({ reason: "expired" });
    if (expiresAt - now > MAX_LIFETIME_MS) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "lifetime_too_long" });
    }
    const login = user.body.login;
    if (login.toLowerCase() !== scope.ownerLogin.toLowerCase()) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "wrong_owner", detail: login });
    }
    if (scope.repos.length === 0) {
      return yield* new OwnerMergeTokenRefusedError({ reason: "no_repos" });
    }
    const reviewPr = input.probePr ?? DEFAULT_REVIEW_PROBE_PR;
    // Each probe must be GitHub refusing the permission; see `classifyProbe`.
    const probe = Effect.fnUntraced(function* (
      permission: string,
      operation: string,
      method: "GET" | "POST",
      path: string,
    ) {
      const answer = yield* gitHubStatus({
        client,
        operation,
        method,
        path,
        token: input.token,
        body: method === "POST" ? REVIEW_PROBE_BODY : undefined,
      });
      const verdict = classifyProbe(answer);
      if (verdict === "denied") return;
      return yield* new OwnerMergeTokenRefusedError({
        reason:
          verdict === "rate_limited"
            ? "rate_limited"
            : verdict === "inconclusive"
              ? "probe_inconclusive"
              : "too_broad",
        detail: `${permission}: HTTP ${answer.status}`,
      });
    });
    const probedOrgs = new Set<string>();
    for (const repo of scope.repos) {
      const [owner, name] = repo.split("/") as [string, string];
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const info = yield* gitHubJson({
        client,
        operation: "repos.get",
        method: "GET",
        path: base,
        token: input.token,
        schema: RepoInfo,
      }).pipe(
        Effect.catchIf(
          (error) => error.stage === "status",
          (error) =>
            Effect.fail(
              new OwnerMergeTokenRefusedError({
                reason: "repo_unreachable",
                detail: `${repo}: HTTP ${error.status ?? "?"}`,
              }),
            ),
        ),
      );
      if (info.body.permissions?.push !== true) {
        return yield* new OwnerMergeTokenRefusedError({ reason: "cannot_push", detail: repo });
      }
      yield* probe(
        `Administration on ${repo}`,
        "repos.actionsPermissions",
        "GET",
        `${base}/actions/permissions`,
      );
      yield* probe(`Webhooks on ${repo}`, "repos.hooks", "GET", `${base}/hooks`);
      yield* probe(`Secrets on ${repo}`, "repos.actionsSecrets", "GET", `${base}/actions/secrets`);
      yield* probe(
        `Pull requests on ${repo} (PR #${reviewPr})`,
        "pulls.createReview",
        "POST",
        `${base}/pulls/${reviewPr}/reviews`,
      );
      const org = info.body.owner.login;
      if (info.body.owner.type === "Organization" && !probedOrgs.has(org.toLowerCase())) {
        probedOrgs.add(org.toLowerCase());
        yield* probe(
          `Organization administration on ${org}`,
          "orgs.rulesets",
          "GET",
          `/orgs/${encodeURIComponent(org)}/rulesets`,
        );
      }
    }
    // Fine-grained tokens list only the repositories they were granted. Public repositories stay
    // readable to every token; this catches "All repositories" and extra selected ones.
    const reachable = yield* gitHubJson({
      client,
      operation: "user.repos",
      method: "GET",
      path: "/user/repos?per_page=100",
      token: input.token,
      schema: Schema.Array(Schema.Struct({ full_name: Schema.String })),
    });
    const outside = reachable.body.filter((repo) => !isScopedRepo(scope.repos, repo.full_name));
    if (outside.length > 0) {
      return yield* new OwnerMergeTokenRefusedError({
        reason: "other_repos",
        detail: `${outside.length}${reachable.body.length === 100 ? " or more" : ""}`,
      });
    }
    yield* keychain.set(
      "kin-owner-merge",
      input.orgId,
      Redacted.make(
        encodeStored({ token: Redacted.value(input.token), login, expiresAt, savedAt: now }),
      ),
    );
    return { login, expiresAt };
  });

  const status = Effect.fn("OwnerMergeClient.status")(function* (orgId: KinOrgId) {
    const item = yield* stored(orgId);
    if (Option.isNone(item)) return { _tag: "missing" } satisfies OwnerMergeTokenStatus;
    const now = yield* Clock.currentTimeMillis;
    const { login, expiresAt } = item.value;
    return (
      expiresAt <= now
        ? { _tag: "expired", login, expiresAt }
        : {
            _tag: "active",
            login,
            expiresAt,
            expiringSoon: expiresAt - now <= OWNER_MERGE_TOKEN_WARN_MS,
          }
    ) satisfies OwnerMergeTokenStatus;
  });

  const token = Effect.fn("OwnerMergeClient.token")(function* (pass: CredentialHygienePass) {
    const orgId = CredentialHygienePass.orgIdOf(pass);
    if (orgId === null) {
      return yield* Effect.die("OwnerMergeClient.token needs a real hygiene pass");
    }
    if ((yield* Clock.currentTimeMillis) - pass.report.checkedAt > PASS_MAX_AGE_MS) {
      return yield* Effect.die("OwnerMergeClient.token needs a hygiene pass from the last minute");
    }
    const item = yield* stored(orgId);
    if (Option.isNone(item)) {
      return yield* new OwnerMergeTokenMissingError({ orgId, expired: false });
    }
    if (item.value.expiresAt <= (yield* Clock.currentTimeMillis)) {
      return yield* new OwnerMergeTokenMissingError({ orgId, expired: true });
    }
    return Redacted.make(item.value.token);
  });

  return OwnerMergeClient.of({ save, status, token });
});

export const layer = Layer.effect(OwnerMergeClient, make);
