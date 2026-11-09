// Pure: scripts/kin-github-app.ts imports this file too, so it must not import server modules.

export type KinGitHubAccess = "read" | "write";

/**
 * @public Approvals spec section 10; `--check`, the manifest and token narrowing all read it.
 * Anything absent here, Workflows and Administration included, is none.
 */
export const KIN_GITHUB_APP_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
} as const satisfies Record<string, KinGitHubAccess>;

export type KinGitHubPermission = keyof typeof KIN_GITHUB_APP_PERMISSIONS;
export type KinGitHubPermissionSet = Partial<Record<KinGitHubPermission, KinGitHubAccess>>;

/** Named so `--check` can say why an extra one is dangerous; every other extra fails too. */
const KIN_GITHUB_APP_FORBIDDEN = {
  workflows: "a worker could add a workflow that reads repository secrets",
  administration: "could change branch rulesets, collaborators and settings",
  secrets: "could read or replace repository secrets",
  environments: "could change deployment protection rules",
  deployments: "could create deployments",
  members: "could change organization membership",
  repository_hooks: "could add webhooks that leak repository events",
  organization_administration: "could change organization settings",
} as const;

// The triggers spec's App webhook source filters to exactly these (TRIG-5).
export const KIN_GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "issues",
  "check_suite",
  "workflow_run",
  "push",
] as const;

const rank = (access: string | undefined): number =>
  access === "read" ? 1 : access === "write" ? 2 : access === undefined ? 0 : 3;

/** Own keys only: `toString`, `constructor` and `__proto__` must not resolve through the prototype. */
const lookup = (table: Readonly<Record<string, string>>, name: string): string | undefined =>
  Object.hasOwn(table, name) ? table[name] : undefined;

export interface KinPermissionDiffLine {
  readonly permission: string;
  readonly expected: string;
  readonly actual: string;
  readonly status: "ok" | "missing" | "extra" | "too_high" | "too_low";
  readonly why?: string;
}

/** Every permission in either set, table rows first. GitHub omits permissions it doesn't grant. */
export function diffAppPermissions(
  actual: Readonly<Record<string, string>>,
): ReadonlyArray<KinPermissionDiffLine> {
  const expected: Readonly<Record<string, string>> = KIN_GITHUB_APP_PERMISSIONS;
  const names = [
    ...Object.keys(expected),
    ...Object.keys(actual)
      .filter((name) => !Object.hasOwn(expected, name))
      .toSorted(),
  ];
  return names.map((permission) => {
    const want = lookup(expected, permission);
    const got = lookup(actual, permission);
    const status =
      want === got
        ? "ok"
        : want === undefined
          ? "extra"
          : got === undefined
            ? "missing"
            : rank(got) > rank(want)
              ? "too_high"
              : "too_low";
    const why =
      status === "extra" || status === "too_high"
        ? lookup(KIN_GITHUB_APP_FORBIDDEN, permission)
        : undefined;
    return {
      permission,
      expected: want ?? "none",
      actual: got ?? "none",
      status,
      ...(why === undefined ? {} : { why }),
    };
  });
}

/**
 * The reason an installation token request asks for more than the table, or `null` when it is
 * a non-empty subset at or below the table's levels.
 */
export function narrowingViolation(requested: Readonly<Record<string, string>>): string | null {
  const names = Object.keys(requested);
  if (names.length === 0) return "a token must name the permissions it needs";
  const expected: Readonly<Record<string, string>> = KIN_GITHUB_APP_PERMISSIONS;
  for (const name of names) {
    const want = lookup(expected, name);
    const got = lookup(requested, name);
    if (want === undefined) return `${name} is not a Kin App permission`;
    if (got !== "read" && got !== "write") return `${name} must be read or write`;
    if (rank(got) > rank(want)) return `${name}: ${got} exceeds the App's ${want}`;
  }
  return null;
}

/**
 * The reason GitHub's granted permissions are wider than `requested`, or `null`. Levels compare by
 * rank, so `admin` or an unknown level counts as wider than `write`.
 */
export function grantWidening(
  requested: Readonly<Record<string, string>>,
  granted: Readonly<Record<string, string>>,
): string | null {
  for (const [name, level] of Object.entries(granted)) {
    // GitHub adds metadata: read to every narrowed token.
    if (name === "metadata" && level === "read") continue;
    const want = lookup(requested, name);
    if (want === undefined) return `${name}: ${level} was not asked for`;
    if (rank(level) > rank(want)) return `${name}: ${level} exceeds ${want}`;
  }
  return null;
}

export interface KinGitHubAppManifestInput {
  readonly name: string;
  readonly homepageUrl: string;
  readonly redirectUrl: string;
  readonly webhookUrl?: string | undefined;
}

/** GitHub's manifest flow body; private so it installs only on accounts the owner picks. */
export function buildAppManifest(input: KinGitHubAppManifestInput) {
  return {
    name: input.name,
    url: input.homepageUrl,
    redirect_url: input.redirectUrl,
    public: false,
    default_permissions: KIN_GITHUB_APP_PERMISSIONS,
    ...(input.webhookUrl === undefined
      ? {}
      : {
          hook_attributes: { url: input.webhookUrl, active: true },
          default_events: KIN_GITHUB_APP_EVENTS,
        }),
  };
}
