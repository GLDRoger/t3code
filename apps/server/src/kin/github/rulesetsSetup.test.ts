// @effect-diagnostics nodeBuiltinImport:off - the CODEOWNERS table reads the real template synchronously.
import * as NodeFS from "node:fs";
import { RepoSlug } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { codeownersProblems, kinRulesets, type KinRepoKind } from "./KinRulesets.ts";
import * as Rulesets from "./rulesetsSetup.ts";
import { isKinBlock, type KinBlock } from "./rulesetsTest23.ts";
import { fakeGitHub, type FakeAnswer, type RecordedRequest } from "./testFakes.ts";

const OWNER_TOKEN = "gho_owner-test";
const BOT_TOKEN = "ghs_bot-test";
const MERGE_TOKEN = "github_pat_merge-test";
const decodeRepo = Schema.decodeSync(RepoSlug);
const repo = decodeRepo("GLDRoger/t3code");
const scratch = decodeRepo("GLDRoger/kin-scratch");
const target = (token = OWNER_TOKEN, slug = repo): Rulesets.RepoTarget => ({
  repo: slug,
  owner: "GLDRoger",
  token: Redacted.make(token),
});

type StoredRuleset = Record<string, unknown> & {
  id: number;
  name: string;
  target: string;
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
};

// GitHub's REST reference (repos/rules) marks these parameters required; it answers 422 without them.
const REQUIRED_PARAMETERS: Record<string, Record<string, "boolean" | "number" | "array">> = {
  creation: {},
  deletion: {},
  non_fast_forward: {},
  update: { update_allows_fetch_and_merge: "boolean" },
  pull_request: {
    dismiss_stale_reviews_on_push: "boolean",
    require_code_owner_review: "boolean",
    require_last_push_approval: "boolean",
    required_approving_review_count: "number",
    required_review_thread_resolution: "boolean",
  },
  required_status_checks: {
    required_status_checks: "array",
    strict_required_status_checks_policy: "boolean",
  },
};
const invalidRule = (rule: { type: string; parameters?: Record<string, unknown> }) => {
  const required = REQUIRED_PARAMETERS[rule.type];
  if (required === undefined) return `unknown rule ${rule.type}`;
  if (Object.keys(required).length === 0) {
    return rule.parameters === undefined ? null : `${rule.type} takes no parameters`;
  }
  for (const [key, type] of Object.entries(required)) {
    const value = rule.parameters?.[key];
    const ok = type === "array" ? Array.isArray(value) : typeof value === type;
    if (!ok) return `${rule.type}.${key} is required`;
  }
  const methods = rule.parameters?.allowed_merge_methods;
  if (
    Array.isArray(methods) &&
    (methods.length === 0 || methods.some((m) => !["merge", "squash", "rebase"].includes(m)))
  ) {
    return "allowed_merge_methods";
  }
  const checks = rule.parameters?.required_status_checks;
  if (
    Array.isArray(checks) &&
    checks.some(
      (check: { context?: unknown; integration_id?: unknown }) =>
        typeof check.context !== "string" ||
        (check.integration_id !== undefined && typeof check.integration_id !== "number"),
    )
  ) {
    return "required_status_checks items";
  }
  return null;
};

/** Repository settings GitHub would hold, answered the way its REST API does. */
const githubRepo = (
  options: {
    readonly slug?: string;
    /** What `GET /repos/{slug}` names, which differs after a rename or transfer. */
    readonly fullName?: string;
    readonly codeowners?: string | null;
    readonly codeownersErrors?: ReadonlyArray<{ line: number; kind: string }>;
    readonly user?: { login: string; type: string } | null;
    readonly admin?: boolean;
    /** A token whose user is an admin but which lacks the Administration permission. */
    readonly hideBypass?: boolean;
    /** Lets tokens other than the owner's write rulesets. */
    readonly anyoneCanAdminister?: boolean;
    readonly onPull?: (request: RecordedRequest) => FakeAnswer | undefined;
  } = {},
) => {
  const slug = options.slug ?? "GLDRoger/t3code";
  const base = `/repos/${slug}`;
  const rulesets: Array<StoredRuleset> = [];
  let nextId = 1;
  // GitHub adds parameters the spec doesn't set and omits false booleans on the way back. Only an
  // admin with the Administration permission sees bypass actors.
  const asReturned = (ruleset: StoredRuleset, admin: boolean) => {
    const { bypass_actors, ...rest } = ruleset;
    return {
      ...rest,
      ...(admin ? { bypass_actors } : {}),
      current_user_can_bypass: ruleset.current_user_can_bypass ?? "never",
      source_type: "Repository",
      source: slug,
      rules: ruleset.rules.map((rule) =>
        rule.type === "pull_request"
          ? {
              ...rule,
              parameters: { ...rule.parameters, automatic_copilot_code_review_enabled: false },
            }
          : rule.type === "required_status_checks"
            ? {
                ...rule,
                parameters: Object.fromEntries(
                  Object.entries(rule.parameters ?? {}).filter(([, value]) => value !== false),
                ),
              }
            : rule,
      ),
    };
  };
  const validate = (body: StoredRuleset): FakeAnswer | null => {
    const problem = body.rules.map(invalidRule).find((value) => value !== null);
    return problem === undefined
      ? null
      : { status: 422, body: { message: `Invalid request.\n\n${problem}` } };
  };
  const github = fakeGitHub((request): FakeAnswer => {
    const token = request.authorization?.replace(/^Bearer /, "");
    const owner = token === OWNER_TOKEN;
    if (request.path === "/user") {
      const user = !owner
        ? null
        : "user" in options
          ? options.user
          : { login: "GLDRoger", type: "User" };
      return user === null ? { status: 403 } : { status: 200, body: user };
    }
    if (request.method === "GET" && request.path === base) {
      return {
        status: 200,
        body: {
          full_name: options.fullName ?? slug,
          default_branch: "kin",
          permissions: { admin: options.admin ?? true },
        },
      };
    }
    if (request.path === `${base}/contents/.github/CODEOWNERS?ref=kin`) {
      const content = options.codeowners === undefined ? "* @GLDRoger\n" : options.codeowners;
      return content === null
        ? { status: 404, body: { message: "Not Found" } }
        : {
            status: 200,
            body: { content: Buffer.from(content).toString("base64"), encoding: "base64" },
          };
    }
    if (request.path === `${base}/codeowners/errors?ref=kin`) {
      return { status: 200, body: { errors: options.codeownersErrors ?? [] } };
    }
    if (request.path === `${base}/rulesets?includes_parents=false&per_page=100`) {
      return {
        status: 200,
        body: rulesets.map(({ id, name, target }) => ({
          id,
          name,
          target,
          source_type: "Repository",
        })),
      };
    }
    const canAdminister = owner || options.anyoneCanAdminister === true;
    if (request.method === "POST" && request.path === `${base}/rulesets`) {
      if (!canAdminister) return { status: 403 };
      const invalid = validate(request.body as StoredRuleset);
      if (invalid !== null) return invalid;
      const created = { ...(request.body as StoredRuleset), id: nextId++ };
      rulesets.push(created);
      return { status: 201, body: { id: created.id } };
    }
    if (/\/rulesets\/\d+\/history$/.test(request.path)) {
      return canAdminister ? { status: 200, body: [] } : { status: 403 };
    }
    const one = request.path.match(new RegExp(`^${base}/rulesets/(\\d+)$`));
    if (one) {
      const index = rulesets.findIndex((ruleset) => ruleset.id === Number(one[1]));
      if (index === -1) return { status: 404 };
      if (request.method === "PUT") {
        if (!canAdminister) return { status: 403 };
        const invalid = validate(request.body as StoredRuleset);
        if (invalid !== null) return invalid;
        rulesets[index] = { ...(request.body as StoredRuleset), id: rulesets[index]!.id };
        return { status: 200, body: { id: rulesets[index]!.id } };
      }
      return { status: 200, body: asReturned(rulesets[index]!, owner && !options.hideBypass) };
    }
    return options.onPull?.(request) ?? { status: 404 };
  });
  return { rulesets, ...github };
};

const writes = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.filter((request) => request.method !== "GET");

const checks = ["Check"];
const memoryChecks = ["memory-check"];
const memoryCodeowners = NodeFS.readFileSync(
  new URL("../../../../../ops/kin/memory-repo/CODEOWNERS.template", import.meta.url),
  "utf8",
).replace("* @OWNER", "* @GLDRoger");
const apply = (t = target(), kind: KinRepoKind = "code") =>
  Rulesets.applyRepo(t, { requiredChecks: kind === "memory" ? memoryChecks : checks, kind });
const check = (t = target(), kind: KinRepoKind = "code") =>
  Rulesets.checkRepo(t, {
    requiredChecks: kind === "memory" ? memoryChecks : checks,
    kind,
    rulesets: true,
  });

describe("kin-rulesets apply", () => {
  it.effect("creates both rulesets, then a second apply writes nothing and --check passes", () => {
    const github = githubRepo();
    return Effect.gen(function* () {
      const first = yield* apply();
      assert.isTrue(first.ok, first.lines.join("\n"));
      assert.include(first.lines, "Ruleset kin-main (branch): created");
      assert.include(first.lines, "Ruleset kin-release (tag): created");
      assert.deepStrictEqual(
        writes(github.requests).map((request) => request.body),
        [...kinRulesets(checks)],
      );
      const before = github.requests.length;
      const second = yield* apply();
      assert.isTrue(second.ok);
      assert.include(second.lines, "Ruleset kin-main (branch): unchanged");
      assert.lengthOf(writes(github.requests.slice(before)), 0);
      const checked = yield* check();
      assert.isTrue(checked.ok);
      assert.strictEqual(checked.lines.at(-1), "PASS: no drift.");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("gives a memory repo one branch ruleset that frees Kin's paths, with no bypass", () => {
    const github = githubRepo({ codeowners: memoryCodeowners });
    return Effect.gen(function* () {
      const applied = yield* apply(target(), "memory");
      assert.isTrue(applied.ok, applied.lines.join("\n"));
      assert.include(applied.lines, "CODEOWNERS: ok (@GLDRoger owns every path but Kin's own)");
      assert.deepStrictEqual(
        github.rulesets.map(({ name, target, bypass_actors }) => ({ name, target, bypass_actors })),
        [{ name: "kin-main", target: "branch", bypass_actors: [] }],
      );
      assert.deepStrictEqual(ruleParameters(github.rulesets, "pull_request"), {
        required_approving_review_count: 0,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      });
      assert.deepStrictEqual(
        ruleParameters(github.rulesets, "required_status_checks").required_status_checks,
        [{ context: "memory-check", integration_id: 15368 }],
      );
      assert.strictEqual((yield* check(target(), "memory")).lines.at(-1), "PASS: no drift.");
      ruleParameters(github.rulesets, "pull_request").require_code_owner_review = false;
      const drifted = yield* check(target(), "memory");
      assert.isFalse(drifted.ok);
      assert.include(
        drifted.lines,
        "  FAIL rules.pull_request.require_code_owner_review: expected true, got false",
      );
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("checks a code repo's rulesets as drift on a memory repo", () => {
    const github = githubRepo({ codeowners: memoryCodeowners.replace(/\n\/.*/g, "") });
    return Effect.gen(function* () {
      assert.isTrue((yield* apply()).ok);
      const result = yield* check(target(), "memory");
      assert.isFalse(result.ok);
      assert.include(
        result.lines,
        "  FAIL rules.pull_request.required_approving_review_count: expected 0, got 1",
      );
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("refuses to apply, and writes nothing, while CODEOWNERS is missing", () => {
    const github = githubRepo({ codeowners: null });
    return Effect.gen(function* () {
      const result = yield* apply();
      assert.isFalse(result.ok);
      assert.include(
        result.lines,
        '  FAIL .github/CODEOWNERS is missing on kin; add "* @GLDRoger".',
      );
      assert.lengthOf(writes(github.requests), 0);
    }).pipe(Effect.provide(github.layer));
  });
});

const branchRule = (rulesets: Array<StoredRuleset>) =>
  rulesets.find((ruleset) => ruleset.name === "kin-main")!;
const ruleParameters = (rulesets: Array<StoredRuleset>, type: string) =>
  branchRule(rulesets).rules.find((rule) => rule.type === type)!.parameters!;

describe("kin-rulesets --check", () => {
  it.effect.each([
    [
      "a bypass actor someone added",
      (rulesets: Array<StoredRuleset>) => {
        branchRule(rulesets).bypass_actors = [
          { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
        ];
      },
      "  FAIL bypass_actors: expected none, got RepositoryRole 5 (always)",
    ],
    [
      "a reader that could bypass",
      (rulesets: Array<StoredRuleset>) => {
        branchRule(rulesets).current_user_can_bypass = "always";
      },
      '  FAIL current_user_can_bypass: expected "never", got "always"',
    ],
    [
      "the code-owner review switched off",
      (rulesets: Array<StoredRuleset>) => {
        ruleParameters(rulesets, "pull_request").require_code_owner_review = false;
      },
      "  FAIL rules.pull_request.require_code_owner_review: expected true, got false",
    ],
    [
      "last-push approval switched off",
      (rulesets: Array<StoredRuleset>) => {
        ruleParameters(rulesets, "pull_request").require_last_push_approval = false;
      },
      "  FAIL rules.pull_request.require_last_push_approval: expected true, got false",
    ],
    [
      "rebase merges allowed",
      (rulesets: Array<StoredRuleset>) => {
        ruleParameters(rulesets, "pull_request").allowed_merge_methods = [
          "squash",
          "merge",
          "rebase",
        ];
      },
      '  FAIL rules.pull_request.allowed_merge_methods: expected ["merge","squash"], got ["merge","rebase","squash"]',
    ],
    [
      "a required check any integration can satisfy",
      (rulesets: Array<StoredRuleset>) => {
        ruleParameters(rulesets, "required_status_checks").required_status_checks = [
          { context: "Check" },
        ];
      },
      '  FAIL rules.required_status_checks.required_status_checks: expected [{context:"Check",integration_id:15368}], got [{context:"Check"}]',
    ],
    [
      "the deletion rule removed",
      (rulesets: Array<StoredRuleset>) => {
        const branch = branchRule(rulesets);
        branch.rules = branch.rules.filter((rule) => rule.type !== "deletion");
      },
      "  FAIL rules.deletion: expected present, got missing",
    ],
    [
      "enforcement set to evaluate",
      (rulesets: Array<StoredRuleset>) => {
        branchRule(rulesets).enforcement = "evaluate";
      },
      '  FAIL enforcement: expected "active", got "evaluate"',
    ],
    [
      "the tag ruleset deleted",
      (rulesets: Array<StoredRuleset>) => {
        rulesets.splice(
          rulesets.findIndex((ruleset) => ruleset.name === "kin-release"),
          1,
        );
      },
      "  FAIL ruleset: expected present, got missing",
    ],
  ] as const)("reports %s, and apply repairs it", ([, mutate, line]) => {
    const github = githubRepo();
    return Effect.gen(function* () {
      yield* apply();
      mutate(github.rulesets);
      const drifted = yield* check();
      assert.isFalse(drifted.ok);
      assert.include(drifted.lines, line);
      assert.strictEqual(drifted.lines.at(-1), "FAIL: see above.");
      const before = github.requests.length;
      assert.isTrue((yield* apply()).ok);
      assert.lengthOf(writes(github.requests.slice(before)), 1);
      assert.isTrue((yield* check()).ok);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("counts bypass actors it can't see as drift", () => {
    const github = githubRepo({ hideBypass: true });
    return Effect.gen(function* () {
      yield* apply();
      const result = yield* check();
      assert.isFalse(result.ok);
      assert.include(
        result.lines,
        "  FAIL bypass_actors: expected none, got not visible to this credential",
      );
    }).pipe(Effect.provide(github.layer));
  });
});

describe("kin-rulesets CODEOWNERS", () => {
  it.each([
    ["code", "# Kin\n* @gldroger # owner\n", []],
    ["code", "*\t@GLDRoger\r\n", []],
    ["code", "", ['no "* @GLDRoger" rule, so some paths have no code owner']],
    ["code", "* @priya\n", ['line 1: "*" is owned by @priya, not only @GLDRoger']],
    [
      "code",
      "* @GLDRoger @priya\n",
      ['line 1: "*" is owned by @GLDRoger @priya, not only @GLDRoger'],
    ],
    [
      "code",
      "* @GLDRoger\n/docs/ @priya\n/apps/\n",
      [
        'line 2: "/docs/" is owned by @priya, not only @GLDRoger',
        'line 3: "/apps/" is owned by no one, not only @GLDRoger',
      ],
    ],
    [
      "code",
      "﻿* @GLDRoger\n* @GLDRoger @priya\n* @GLDRoger\u000B@priya\n",
      [
        'no "* @GLDRoger" rule, so some paths have no code owner',
        "line 1: has a non-ASCII or control character (or a BOM)",
        "line 2: has a non-ASCII or control character (or a BOM)",
        "line 3: has a non-ASCII or control character (or a BOM)",
      ],
    ],
    [
      "code",
      memoryCodeowners,
      ["/commitments/", "/deferrals/", "/claims/", "/journal/", "/INDEX.md"].map(
        (path, index) => `line ${index + 6}: "${path}" is owned by no one, not only @GLDRoger`,
      ),
    ],
    ["memory", memoryCodeowners, []],
    [
      "memory",
      `${memoryCodeowners}/rules.md\n`,
      ['line 11: "/rules.md" is owned by no one, not only @GLDRoger'],
    ],
    [
      "memory",
      memoryCodeowners.replace("* @GLDRoger", "*"),
      ['line 5: "*" is owned by no one, not only @GLDRoger'],
    ],
    [
      "memory",
      memoryCodeowners.replace("/journal/", "/journal/ @priya"),
      ['line 9: "/journal/" is owned by @priya, not only @GLDRoger'],
    ],
  ] as const)("judges %s %j", (kind, content, problems) => {
    assert.deepStrictEqual(codeownersProblems(content, "GLDRoger", kind), problems);
  });

  it.effect("fails when GitHub reports CODEOWNERS syntax errors", () => {
    const github = githubRepo({ codeownersErrors: [{ line: 1, kind: "Unknown owner" }] });
    return Effect.gen(function* () {
      const result = yield* Rulesets.checkRepo(target(), {
        requiredChecks: checks,
        kind: "code",
        rulesets: false,
      });
      assert.isFalse(result.ok);
      assert.include(result.lines, "  FAIL line 1: GitHub reports Unknown owner");
    }).pipe(Effect.provide(github.layer));
  });
});

describe("kin-rulesets credential", () => {
  it.effect("never sends the bot App's installation token anywhere", () => {
    const github = githubRepo();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(apply(target(BOT_TOKEN)));
      assert.strictEqual(error._tag, "KinRulesetsRefusedError");
      assert.lengthOf(github.requests, 0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect.each([
    ["a token GitHub maps to no user", { user: null }, "maps this credential to no user"],
    ["the bot account", { user: { login: "kin-gldroger[bot]", type: "Bot" } }, "is a bot account"],
    [
      "someone other than the owner",
      { user: { login: "priya", type: "User" } },
      "signed in as priya",
    ],
    ["a credential without admin", { admin: false }, "can't administer GLDRoger/t3code"],
  ] as const)("refuses %s and writes nothing", ([, options, reason]) => {
    const github = githubRepo(options);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(apply());
      assert.strictEqual(error._tag, "KinRulesetsRefusedError");
      assert.include(error.message, reason);
      assert.lengthOf(writes(github.requests), 0);
    }).pipe(Effect.provide(github.layer));
  });
});

const ruleViolation = (rule: string) => ({
  message: `Repository rule violations found\n\n${rule}\n\n`,
  documentation_url: "https://docs.github.com/rest",
  status: "422",
});

const NOT_ACCESSIBLE = { message: "Resource not accessible by personal access token" };
const RETRY = { "retry-after": "60" };

describe("test 23 refusal matching", () => {
  it.each([
    [422, ruleViolation("Changes must be made through a pull request."), "rule_violation", true],
    [
      422,
      ruleViolation("Cannot create ref due to creations being restricted."),
      "rule_violation",
      true,
    ],
    [422, { message: "Reference does not exist" }, "rule_violation", false],
    [403, ruleViolation("Changes must be made through a pull request."), "rule_violation", false],
    [
      405,
      ruleViolation("At least 1 approving review is required by reviewers with write access."),
      "review_required",
      true,
    ],
    [405, { message: "Waiting on code owner review from GLDRoger." }, "review_required", true],
    [405, ruleViolation('Required status check "ci" is expected.'), "review_required", false],
    [
      409,
      { message: "Head branch was modified. Review and try the merge again." },
      "review_required",
      false,
    ],
    [403, NOT_ACCESSIBLE, "forbidden", true],
    [403, { message: "Resource not accessible by integration" }, "forbidden", false],
    [
      403,
      {
        message:
          "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
      },
      "forbidden",
      false,
    ],
    [403, { message: "Must have admin rights to Repository." }, "forbidden", false],
    [404, { message: "Not Found" }, "forbidden", false],
    [404, { message: "Not Found" }, "refused", true],
    [200, { message: "" }, "refused", false],
  ] as const)("HTTP %i %j as %s is %s", (status, body, block, expected) => {
    assert.strictEqual(
      isKinBlock({ status, headers: {}, message: body.message }, block as KinBlock),
      expected,
    );
  });

  // A rate limit means "try again later", whatever the body says.
  it.each([
    [403, NOT_ACCESSIBLE, { "x-ratelimit-remaining": "0" }, "forbidden"],
    [403, { message: "You have exceeded a secondary rate limit." }, RETRY, "refused"],
    [429, { message: "" }, {}, "refused"],
  ] as const)("HTTP %i %j with %j is never %s", (status, body, headers, block) => {
    assert.isFalse(isKinBlock({ status, headers, message: body.message }, block as KinBlock));
  });
});

const sha = (char: string) => char.repeat(40);

/**
 * A scratch repository with the rulesets applied, simulated: refs, the PR's head, reviews with
 * stale dismissal, Actions check runs and merges. `broken` switches off one protection.
 */
const scratchRepo = (
  broken: {
    readonly mergeTokenCanReview?: boolean;
    /** GitHub rate-limits the merge token's review attempt with a 403 it would also use to refuse. */
    readonly rateLimitReview?: boolean;
    readonly botCanMerge?: boolean;
    readonly pushAllowed?: boolean;
    readonly tagMovable?: boolean;
    readonly tagCreatable?: boolean;
    /** Reading back the tag the probe tried to create is rate-limited. */
    readonly rateLimitTagRead?: boolean;
    readonly noStaleDismissal?: boolean;
    readonly anyoneCanAdminister?: boolean;
    readonly noReleaseTag?: boolean;
    readonly fullName?: string;
  } = {},
) => {
  const base = "/repos/GLDRoger/kin-scratch";
  const refs = new Map<string, string>([["heads/kin", sha("a")]]);
  if (!broken.noReleaseTag) refs.set("tags/v1.0.0", sha("7"));
  const reviews: Array<{ state: string; commit_id: string; user: { login: string } }> = [];
  const commits = new Map([
    ["0.md", sha("b")],
    ["0-after-review.md", sha("c")],
  ]);
  const state = { head: "", merged: false, closed: false, revoked: false };
  const approved = () =>
    reviews.some((review) => review.state === "APPROVED" && review.commit_id === state.head);
  const violation = (rule: string): FakeAnswer => ({ status: 422, body: ruleViolation(rule) });
  const github = githubRepo({
    slug: "GLDRoger/kin-scratch",
    ...(broken.fullName === undefined ? {} : { fullName: broken.fullName }),
    ...(broken.anyoneCanAdminister ? { anyoneCanAdminister: true } : {}),
    onPull: (request) => {
      const token = request.authorization?.replace(/^Bearer /, "");
      const body = request.body as Record<string, string> | undefined;
      const route = `${request.method} ${request.path}`;
      if (route === "DELETE /installation/token") {
        state.revoked = token === BOT_TOKEN;
        return { status: 204 };
      }
      const ref = request.path.match(new RegExp(`^${base}/git/refs?/(.+)$`))?.[1];
      if (request.method === "GET" && ref !== undefined && request.path.includes("/git/ref/")) {
        if (broken.rateLimitTagRead && ref.startsWith("tags/v0.0.0-kin-test-23")) {
          return { status: 429, body: { message: "API rate limit exceeded" } };
        }
        const at = refs.get(ref);
        return at === undefined
          ? { status: 404, body: { message: "Not Found" } }
          : { status: 200, body: { ref: `refs/${ref}`, object: { sha: at } } };
      }
      if (route === `GET ${base}/git/matching-refs/tags/v`) {
        return {
          status: 200,
          body: [...refs]
            .filter(([name]) => name.startsWith("tags/v"))
            .map(([name, at]) => ({ ref: `refs/${name}`, object: { sha: at } })),
        };
      }
      if (route === `POST ${base}/git/refs`) {
        const name = body!.ref!.slice("refs/".length);
        if (name.startsWith("tags/v") && !broken.tagCreatable) {
          return violation("Cannot create ref due to creations being restricted.");
        }
        refs.set(name, body!.sha!);
        return { status: 201, body: { ref: body!.ref } };
      }
      if (request.method === "PATCH" && ref !== undefined) {
        const allowed = ref === "heads/kin" ? broken.pushAllowed : broken.tagMovable;
        if (!allowed) {
          return violation(
            ref === "heads/kin"
              ? "Changes must be made through a pull request."
              : "Cannot update this protected ref.",
          );
        }
        refs.set(ref, body!.sha!);
        return { status: 200, body: { ref: `refs/${ref}`, object: { sha: body!.sha } } };
      }
      if (request.method === "DELETE" && ref !== undefined) {
        refs.delete(ref);
        return { status: 204 };
      }
      const file = request.path.match(new RegExp(`^${base}/contents/kin-test-23/(.+)$`))?.[1];
      if (request.method === "PUT" && file !== undefined) {
        const commit = commits.get(file)!;
        refs.set(`heads/${body!.branch}`, commit);
        if (state.head !== "" && !broken.noStaleDismissal) {
          for (const review of reviews) review.state = "DISMISSED";
        }
        state.head = commit;
        return { status: 201, body: { commit: { sha: commit } } };
      }
      switch (route) {
        case `POST ${base}/pulls`:
          return { status: 201, body: { number: 7, head: { sha: state.head } } };
        case `GET ${base}/pulls/7`:
          return {
            status: 200,
            body: {
              number: 7,
              head: { sha: state.head },
              mergeable: true,
              mergeable_state: approved() ? "clean" : "blocked",
            },
          };
        case `GET ${base}/commits/${state.head}/check-runs?per_page=100`:
          return {
            status: 200,
            body: {
              check_runs: [
                { name: "ci", status: "completed", conclusion: "success", app: { id: 15368 } },
              ],
            },
          };
        case `POST ${base}/pulls/7/reviews`:
          if (token === MERGE_TOKEN && broken.rateLimitReview) {
            return { status: 403, body: NOT_ACCESSIBLE, headers: { "x-ratelimit-remaining": "0" } };
          }
          if (token === OWNER_TOKEN || broken.mergeTokenCanReview) {
            reviews.push({
              state: "APPROVED",
              commit_id: body!.commit_id!,
              user: { login: "GLDRoger" },
            });
            return { status: 200, body: {} };
          }
          return { status: 403, body: NOT_ACCESSIBLE };
        case `GET ${base}/pulls/7/reviews?per_page=100`:
          return { status: 200, body: reviews };
        case `PUT ${base}/pulls/7/merge`:
          if (approved() || (token === BOT_TOKEN && broken.botCanMerge)) {
            state.merged = true;
            return { status: 200, body: { merged: true } };
          }
          return {
            status: 405,
            body: ruleViolation("Waiting on code owner review from GLDRoger."),
          };
        case `PATCH ${base}/pulls/7`:
          state.closed = true;
          return { status: 200, body: {} };
      }
      return undefined;
    },
  });
  return { ...github, refs, state };
};

const scratchBroken = { pushAllowed: { pushAllowed: true } } as const;

const tokens = Effect.succeed({
  botToken: Redacted.make(BOT_TOKEN),
  mergeToken: Redacted.make(MERGE_TOKEN),
});
const kinRepos = Rulesets.kinRepos([]);
const runTest23 = (slug = scratch) =>
  Rulesets.runTest23({
    target: target(OWNER_TOKEN, slug),
    requiredChecks: ["ci"],
    kinRepos,
    tokens,
  });
const test23 = () =>
  Effect.gen(function* () {
    yield* Rulesets.applyRepo(target(OWNER_TOKEN, scratch), {
      requiredChecks: ["ci"],
      kind: "code",
    });
    return yield* runTest23();
  });

describe("security test 23 (kin-rulesets --test-23)", () => {
  it.effect("passes against a repository that enforces the rulesets", () => {
    const github = scratchRepo();
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isTrue(result.ok, result.lines.join("\n"));
      for (const line of [
        "  PASS GitHub reports the PR blocked at bbbbbbb (mergeable_state blocked)",
        "  PASS the merge token can't submit a review (HTTP 403: Resource not accessible by personal access token)",
        "  PASS the bot can't merge without a code-owner review (HTTP 405: Repository rule violations found Waiting on code owner review from GLDRoger.)",
        "  PASS the merge token can't push to kin (HTTP 422: Repository rule violations found Changes must be made through a pull request.)",
        "  PASS the bot can't create a v* tag (HTTP 422: Repository rule violations found Cannot create ref due to creations being restricted.)",
        "  PASS the merge token can't move v1.0.0 (HTTP 422: Repository rule violations found Cannot update this protected ref.)",
        "  PASS the bot can't bypass kin-main (HTTP 200, current_user_can_bypass never)",
        "  PASS the merge token can't read kin-release's history (HTTP 403)",
        "  PASS the merge token can't change kin-main (HTTP 403)",
        "  PASS GitHub reports the PR clean at bbbbbbb (mergeable_state clean)",
        "  PASS the push dismissed GLDRoger's review (DISMISSED)",
        "  PASS the merge token can't merge the switched head (HTTP 405: Repository rule violations found Waiting on code owner review from GLDRoger.)",
        "  PASS the rulesets show no drift afterwards",
        "PASS: security test 23.",
      ]) {
        assert.include(result.lines, line);
      }
      assert.isTrue(github.state.merged);
      assert.isFalse(github.state.closed);
      assert.isTrue(github.state.revoked);
      assert.isFalse(github.refs.has("heads/kin-test-23-0"));
      assert.isFalse(result.lines.some((line) => line.includes("WARN")));
    }).pipe(Effect.provide(github.layer));
  });

  it.effect.each([
    ["a merge token that can review", { mergeTokenCanReview: true }, "can't submit a review"],
    ["a bot that can merge alone", { botCanMerge: true }, "the bot can't merge"],
    ["a push to the default branch", scratchBroken.pushAllowed, "but heads/kin is now"],
    ["a movable release tag", { tagMovable: true }, "but tags/v1.0.0 is now"],
    ["no stale-review dismissal", { noStaleDismissal: true }, "dismissed GLDRoger's review"],
    [
      "tokens that can administer rulesets",
      { anyoneCanAdminister: true },
      "the bot can't read kin-main's history",
    ],
  ] as const)("fails with %s and cleans up", ([, broken, failing]) => {
    const github = scratchRepo(broken);
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isFalse(result.ok);
      const failed = result.lines.find((line) => line.startsWith("  FAIL"));
      assert.include(failed, failing);
      assert.isTrue(github.state.revoked);
      assert.isFalse(github.refs.has("heads/kin-test-23-0"));
      assert.isFalse(github.refs.has("tags/v0.0.0-kin-test-23-0"));
      assert.strictEqual(github.refs.get("tags/v1.0.0"), sha("7"));
      if (!github.state.merged) assert.isTrue(github.state.closed);
      if (broken === scratchBroken.pushAllowed) {
        assert.include(
          result.lines,
          "  WARN cleanup: undo by hand: kin moved to bbbbbbb; disable kin-main, then `git push --force origin aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/kin`, then apply kin-rulesets to GLDRoger/kin-scratch again.",
        );
      }
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("deletes a tag it created even when reading it back fails", () => {
    const github = scratchRepo({ tagCreatable: true, rateLimitTagRead: true });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(test23());
      assert.strictEqual(error._tag, "KinGitHubRequestError");
      assert.isTrue(
        github.requests.some(
          (request) =>
            request.method === "DELETE" &&
            request.path === "/repos/GLDRoger/kin-scratch/git/refs/tags/v0.0.0-kin-test-23-0",
        ),
      );
      assert.isFalse(github.refs.has("tags/v0.0.0-kin-test-23-0"));
      assert.isTrue(github.state.closed);
      assert.isTrue(github.state.revoked);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("stops on a rate limit without counting it as a block, and cleans up", () => {
    const github = scratchRepo({ rateLimitReview: true });
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isFalse(result.ok);
      assert.include(
        result.lines,
        "  WAIT the merge token can't submit a review (HTTP 403: Resource not accessible by personal access token): GitHub rate-limited this call, so it proves nothing",
      );
      assert.include(result.lines.at(-1), "try again later");
      assert.isFalse(result.lines.some((line) => line.startsWith("  FAIL")));
      assert.isTrue(github.state.closed);
      assert.isTrue(github.state.revoked);
      assert.isFalse(github.refs.has("heads/kin-test-23-0"));
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("doesn't run, or take tokens, until the scratch repo has no drift", () => {
    const github = scratchRepo();
    return Effect.gen(function* () {
      const result = yield* Rulesets.runTest23({
        target: target(OWNER_TOKEN, scratch),
        requiredChecks: ["ci"],
        kinRepos,
        tokens: Effect.die("tokens taken"),
      });
      assert.isFalse(result.ok);
      assert.lengthOf(writes(github.requests), 0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("needs a v* tag to try moving, and opens nothing without one", () => {
    const github = scratchRepo({ noReleaseTag: true });
    return Effect.gen(function* () {
      const result = yield* test23();
      const before = github.requests.findIndex((request) => request.path.includes("matching-refs"));
      assert.isFalse(result.ok);
      assert.include(result.lines[0], "has no v* tag");
      assert.deepStrictEqual(
        writes(github.requests.slice(before)).map((request) => request.path),
        ["/installation/token"],
      );
    }).pipe(Effect.provide(github.layer));
  });

  it.effect.each([
    ["a Kin repository in another case", "gldroger/t3code", "is a Kin repository"],
    ["a repository not named scratch", "GLDRoger/sandbox", 'has no "scratch" in its name'],
  ] as const)("refuses %s before any request", ([, slug, reason]) => {
    const github = scratchRepo();
    const requested = decodeRepo(slug);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(runTest23(requested));
      assert.include(error.message, reason);
      assert.lengthOf(github.requests, 0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect.each([
    ["redirects to a Kin repository", "GLDRoger/t3code", "not GLDRoger/kin-scratch"],
    ["answers for another scratch repository", "GLDRoger/other-scratch", "renamed or moved"],
  ] as const)("refuses, writing nothing, when GitHub %s", ([, fullName, reason]) => {
    const github = scratchRepo({ fullName });
    return Effect.gen(function* () {
      yield* Rulesets.applyRepo(target(OWNER_TOKEN, scratch), {
        requiredChecks: ["ci"],
        kind: "code",
      });
      const before = github.requests.length;
      const error = yield* Effect.flip(runTest23());
      assert.include(error.message, reason);
      assert.lengthOf(writes(github.requests.slice(before)), 0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("accepts a name GitHub reports in another case", () => {
    const github = scratchRepo({ fullName: "gldroger/KIN-SCRATCH" });
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isTrue(result.ok, result.lines.join("\n"));
    }).pipe(Effect.provide(github.layer));
  });
});
