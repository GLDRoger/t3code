// Pure: the approvals spec section 10 rulesets and CODEOWNERS rule. Apply, `--check` and the
// tests all read `kinRulesets`, so there is one definition of what GitHub should hold.

/**
 * Required status check contexts per Kin repository; other repos pass `--status-check`. Its keys
 * count as Kin repositories even when `KIN_GITHUB_REPOS` leaves them out.
 */
export const KIN_REPO_REQUIRED_CHECKS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // ci.yml's `Check` job fails unless every other CI job passed or was skipped as not needed.
  "GLDRoger/t3code": ["Check"],
};

/**
 * The GitHub Actions App (`GET /apps/github-actions`). Pinning required checks to it stops a
 * status anyone with commit-status access posts from satisfying them.
 */
export const GITHUB_ACTIONS_INTEGRATION_ID = 15368;

export const KIN_CODEOWNERS_PATH = ".github/CODEOWNERS";

export interface KinRulesetRule {
  readonly type: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface KinRuleset {
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: "active";
  /** Always empty: a bypass for admins lets the owner's merge token skip review, one for the App lets the bot merge alone. */
  readonly bypass_actors: readonly [];
  readonly conditions: {
    readonly ref_name: { readonly include: ReadonlyArray<string>; readonly exclude: readonly [] };
  };
  readonly rules: ReadonlyArray<KinRulesetRule>;
}

/** @public The rulesets for one repository, given its required status check contexts. */
export const kinRulesets = (requiredChecks: ReadonlyArray<string>): ReadonlyArray<KinRuleset> => [
  {
    name: "kin-main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          require_code_owner_review: true,
          dismiss_stale_reviews_on_push: true,
          // Off: it adds nothing against the bot, whose pushes the owner must approve anyway, and
          // it deadlocks an upstream sync branch the owner pushed (spec section 10).
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          // `merge` is for the owner's upstream syncs; the executor squashes bot PRs.
          allowed_merge_methods: ["squash", "merge"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: requiredChecks.map((context) => ({
            context,
            integration_id: GITHUB_ACTIONS_INTEGRATION_ID,
          })),
        },
      },
    ],
  },
  {
    name: "kin-release",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    // `*` stops at `/`, so `v*/**` covers tags like `v1/rc`.
    conditions: { ref_name: { include: ["refs/tags/v*", "refs/tags/v*/**"], exclude: [] } },
    rules: [
      { type: "creation" },
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      { type: "deletion" },
    ],
  },
];

/** The fields of a GitHub ruleset that `diffRuleset` reads. */
export interface LiveRuleset {
  readonly target: string;
  readonly enforcement: string;
  /** GitHub omits this for a credential that can't administer the repository. */
  readonly bypass_actors?:
    | ReadonlyArray<{
        readonly actor_id?: number | null | undefined;
        readonly actor_type: string;
        readonly bypass_mode?: string | undefined;
      }>
    | undefined;
  /** How the credential reading the ruleset could bypass it: `never` for every Kin credential. */
  readonly current_user_can_bypass?: string | undefined;
  readonly conditions?: unknown;
  readonly rules?:
    | ReadonlyArray<{
        readonly type: string;
        readonly parameters?: Readonly<Record<string, unknown>> | undefined;
      }>
    | undefined;
}

export interface KinRulesetDrift {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

/** Key-sorted, and array order ignored: GitHub doesn't promise to keep either. */
const canonical = (value: unknown): string => {
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return `[${value.map(canonical).toSorted().join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${key}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Every field where `live` differs from `desired`: missing rules, rules someone added, changed
 * parameters and any bypass actor. Parameters GitHub added that the spec doesn't set are not read.
 */
export function diffRuleset(
  desired: KinRuleset,
  live: LiveRuleset | undefined,
): ReadonlyArray<KinRulesetDrift> {
  if (live === undefined) return [{ field: "ruleset", expected: "present", actual: "missing" }];
  const drift: Array<KinRulesetDrift> = [];
  const compare = (field: string, expected: unknown, actual: unknown) => {
    if (canonical(expected) !== canonical(actual)) {
      drift.push({ field, expected: canonical(expected), actual: canonical(actual) });
    }
  };
  compare("target", desired.target, live.target);
  compare("enforcement", desired.enforcement, live.enforcement);
  // GitHub omits `bypass_actors` for a token without Administration even when its user is an admin.
  if (live.bypass_actors === undefined) {
    drift.push({
      field: "bypass_actors",
      expected: "none",
      actual: "not visible to this credential",
    });
  } else {
    compare("current_user_can_bypass", "never", live.current_user_can_bypass);
  }
  for (const actor of live.bypass_actors ?? []) {
    drift.push({
      field: "bypass_actors",
      expected: "none",
      actual: `${actor.actor_type}${actor.actor_id == null ? "" : ` ${actor.actor_id}`} (${actor.bypass_mode ?? "always"})`,
    });
  }
  compare("conditions", desired.conditions, live.conditions ?? undefined);
  const liveRules = new Map((live.rules ?? []).map((rule) => [rule.type, rule]));
  for (const rule of desired.rules) {
    const got = liveRules.get(rule.type);
    if (got === undefined) {
      drift.push({ field: `rules.${rule.type}`, expected: "present", actual: "missing" });
      continue;
    }
    for (const [key, want] of Object.entries(rule.parameters ?? {})) {
      // GitHub may leave out a boolean parameter that is false.
      const value = got.parameters?.[key] ?? (want === false ? false : undefined);
      compare(`rules.${rule.type}.${key}`, want, value);
    }
  }
  const desiredTypes = new Set(desired.rules.map((rule) => rule.type));
  for (const type of liveRules.keys()) {
    if (!desiredTypes.has(type)) {
      drift.push({ field: `rules.${type}`, expected: "absent", actual: "present" });
    }
  }
  return drift;
}

/**
 * Why `content` (the default branch's `.github/CODEOWNERS`) fails to make `owner` the sole code
 * owner of every path; empty when it passes. A `*` rule must exist, and every rule must name
 * exactly the owner, so no later rule can hand a path to someone else or to no one.
 */
export function codeownersProblems(content: string, owner: string): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const expected = `@${owner}`.toLowerCase();
  let coversAll = false;
  content.split(/\r?\n/).forEach((raw, index) => {
    // A BOM, non-breaking space or other non-ASCII character can make GitHub read a line
    // differently from this check, so only printable ASCII and tabs are accepted.
    if (/[^\t\x20-\x7e]/.test(raw)) {
      problems.push(`line ${index + 1}: has a non-ASCII or control character (or a BOM)`);
      return;
    }
    const tokens = raw.split(/[ \t]+/).filter(Boolean);
    const commentAt = tokens.findIndex((token) => token.startsWith("#"));
    const [pattern, ...owners] = commentAt === -1 ? tokens : tokens.slice(0, commentAt);
    if (pattern === undefined) return;
    if (pattern === "*") coversAll = true;
    if (owners.length !== 1 || owners[0]!.toLowerCase() !== expected) {
      problems.push(
        `line ${index + 1}: "${pattern}" is owned by ${owners.length === 0 ? "no one" : owners.join(" ")}, not only @${owner}`,
      );
    }
  });
  if (!coversAll) problems.unshift(`no "* @${owner}" rule, so some paths have no code owner`);
  return problems;
}
