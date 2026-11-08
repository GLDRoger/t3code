import { RepoSlug } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { codeownersProblems, kinRulesets } from "./KinRulesets.ts";
import * as Rulesets from "./rulesetsSetup.ts";
import { fakeGitHub, type FakeAnswer, type RecordedRequest } from "./testFakes.ts";

const OWNER_TOKEN = "gho_owner-test";
const BOT_TOKEN = "ghs_bot-test";
const MERGE_TOKEN = "github_pat_merge-test";
const repo = Schema.decodeSync(RepoSlug)("GLDRoger/t3code");
const scratch = Schema.decodeSync(RepoSlug)("GLDRoger/kin-scratch");
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

/** Repository settings GitHub would hold, answered the way its REST API does. */
const githubRepo = (
  options: {
    readonly slug?: string;
    readonly codeowners?: string | null;
    readonly codeownersErrors?: ReadonlyArray<{ line: number; kind: string }>;
    readonly user?: { login: string; type: string } | null;
    readonly admin?: boolean;
    readonly onPull?: (request: RecordedRequest) => FakeAnswer | undefined;
  } = {},
) => {
  const base = `/repos/${options.slug ?? "GLDRoger/t3code"}`;
  const rulesets: Array<StoredRuleset> = [];
  let nextId = 1;
  // GitHub adds parameters the spec doesn't set and omits false booleans on the way back.
  const asReturned = (ruleset: StoredRuleset) => ({
    ...ruleset,
    source_type: "Repository",
    source: options.slug ?? "GLDRoger/t3code",
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
  });
  const github = fakeGitHub((request): FakeAnswer => {
    const token = request.authorization?.replace(/^Bearer /, "");
    if (request.path === "/user") {
      const user =
        token !== OWNER_TOKEN
          ? null
          : "user" in options
            ? options.user
            : { login: "GLDRoger", type: "User" };
      return user === null ? { status: 403 } : { status: 200, body: user };
    }
    if (request.method === "GET" && request.path === base) {
      return {
        status: 200,
        body: { default_branch: "kin", permissions: { admin: options.admin ?? true } },
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
    if (request.method === "POST" && request.path === `${base}/rulesets`) {
      const created = { ...(request.body as StoredRuleset), id: nextId++ };
      rulesets.push(created);
      return { status: 201, body: { id: created.id } };
    }
    const one = request.path.match(new RegExp(`^${base}/rulesets/(\\d+)$`));
    if (one) {
      const index = rulesets.findIndex((ruleset) => ruleset.id === Number(one[1]));
      if (index === -1) return { status: 404 };
      if (request.method === "PUT") {
        rulesets[index] = { ...(request.body as StoredRuleset), id: rulesets[index]!.id };
        return { status: 200, body: { id: rulesets[index]!.id } };
      }
      return { status: 200, body: asReturned(rulesets[index]!) };
    }
    return options.onPull?.(request) ?? { status: 404 };
  });
  return { rulesets, ...github };
};

const writes = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.filter((request) => request.method !== "GET");

const checks = ["Check"];
const apply = (t = target()) => Rulesets.applyRepo(t, { requiredChecks: checks });
const check = (t = target()) => Rulesets.checkRepo(t, { requiredChecks: checks, rulesets: true });

describe("kin-rulesets apply", () => {
  it.effect("creates both rulesets, then a second apply writes nothing and --check passes", () => {
    const github = githubRepo();
    return Effect.gen(function* () {
      const first = yield* apply();
      assert.isTrue(first.ok);
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
const pullRequestParameters = (rulesets: Array<StoredRuleset>) =>
  branchRule(rulesets).rules.find((rule) => rule.type === "pull_request")!.parameters!;

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
      "the code-owner review switched off",
      (rulesets: Array<StoredRuleset>) => {
        pullRequestParameters(rulesets).require_code_owner_review = false;
      },
      "  FAIL rules.pull_request.require_code_owner_review: expected true, got false",
    ],
    [
      "merge commits allowed",
      (rulesets: Array<StoredRuleset>) => {
        pullRequestParameters(rulesets).allowed_merge_methods = ["squash", "merge"];
      },
      '  FAIL rules.pull_request.allowed_merge_methods: expected ["squash"], got ["merge","squash"]',
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
});

describe("kin-rulesets CODEOWNERS", () => {
  it.each([
    ["# Kin\n* @gldroger # owner\n", []],
    ["", ['no "* @GLDRoger" rule, so some paths have no code owner']],
    ["* @priya\n", ['line 1: "*" is owned by @priya, not only @GLDRoger']],
    ["* @GLDRoger @priya\n", ['line 1: "*" is owned by @GLDRoger @priya, not only @GLDRoger']],
    [
      "* @GLDRoger\n/docs/ @priya\n/apps/\n",
      [
        'line 2: "/docs/" is owned by @priya, not only @GLDRoger',
        'line 3: "/apps/" is owned by no one, not only @GLDRoger',
      ],
    ],
  ] as const)("judges %j", (content, problems) => {
    assert.deepStrictEqual(codeownersProblems(content, "GLDRoger"), problems);
  });

  it.effect("fails when GitHub reports CODEOWNERS syntax errors", () => {
    const github = githubRepo({ codeownersErrors: [{ line: 1, kind: "Unknown owner" }] });
    return Effect.gen(function* () {
      const result = yield* Rulesets.checkRepo(target(), {
        requiredChecks: checks,
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

/** Answers the test 23 calls as a repository with the rulesets applied would. */
const scratchRepo = (broken: { mergeTokenCanReview?: boolean; botCanMerge?: boolean } = {}) => {
  const base = "/repos/GLDRoger/kin-scratch";
  let ownerReviewed = false;
  const state = { branchDeleted: false, closed: false };
  const github = githubRepo({
    slug: "GLDRoger/kin-scratch",
    onPull: (request) => {
      const token = request.authorization?.replace(/^Bearer /, "");
      const route = `${request.method} ${request.path}`;
      switch (route) {
        case `GET ${base}/git/ref/heads/kin`:
          return { status: 200, body: { object: { sha: "a".repeat(40) } } };
        case `POST ${base}/git/refs`:
          return { status: 201, body: { ref: "refs/heads/kin-test-23-0" } };
        case `PUT ${base}/contents/kin-test-23/0.md`:
          return { status: 201, body: { commit: { sha: "b".repeat(40) } } };
        case `POST ${base}/pulls`:
          return { status: 201, body: { number: 7, head: { sha: "b".repeat(40) } } };
        case `POST ${base}/statuses/${"b".repeat(40)}`:
          return { status: 201, body: { id: 1 } };
        case `POST ${base}/pulls/7/reviews`:
          if (token === OWNER_TOKEN) ownerReviewed = true;
          return token === OWNER_TOKEN || broken.mergeTokenCanReview
            ? { status: 200, body: {} }
            : { status: 403 };
        case `PUT ${base}/pulls/7/merge`:
          return (token === BOT_TOKEN && broken.botCanMerge) ||
            (token === MERGE_TOKEN && ownerReviewed)
            ? { status: 200, body: { merged: true } }
            : { status: 405 };
        case `PATCH ${base}/git/refs/heads/kin`:
          return { status: 422 };
        case `PATCH ${base}/pulls/7`:
          state.closed = true;
          return { status: 200, body: {} };
        case `DELETE ${base}/git/refs/heads/kin-test-23-0`:
          state.branchDeleted = true;
          return { status: 204 };
      }
      return undefined;
    },
  });
  return { ...github, state };
};

const test23 = () =>
  Effect.gen(function* () {
    yield* Rulesets.applyRepo(target(OWNER_TOKEN, scratch), { requiredChecks: ["ci"] });
    return yield* Rulesets.runTest23({
      target: target(OWNER_TOKEN, scratch),
      requiredChecks: ["ci"],
      botToken: Redacted.make(BOT_TOKEN),
      mergeToken: Redacted.make(MERGE_TOKEN),
    });
  });

describe("security test 23 (kin-rulesets --test-23)", () => {
  it.effect("passes against a repository that enforces the rulesets", () => {
    const github = scratchRepo();
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isTrue(result.ok, result.lines.join("\n"));
      assert.include(result.lines, "  PASS the owner merge token can't submit a review (HTTP 403)");
      assert.include(result.lines, "  PASS the bot can't merge to the default branch (HTTP 405)");
      assert.include(result.lines, "  PASS the bot can't push to the default branch (HTTP 422)");
      assert.include(
        result.lines,
        "  PASS a merge without a code-owner review is blocked (HTTP 405)",
      );
      assert.isTrue(github.state.branchDeleted);
      assert.isFalse(github.state.closed);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect.each([
    ["a merge token that can review", { mergeTokenCanReview: true }],
    ["a bot that can merge alone", { botCanMerge: true }],
  ] as const)("fails with %s and cleans up its PR", ([, broken]) => {
    const github = scratchRepo(broken);
    return Effect.gen(function* () {
      const result = yield* test23();
      assert.isFalse(result.ok);
      assert.isTrue(result.lines.some((line) => line.startsWith("  FAIL")));
      assert.isTrue(github.state.closed);
      assert.isTrue(github.state.branchDeleted);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("doesn't run until the scratch repo has no drift", () => {
    const github = scratchRepo();
    return Effect.gen(function* () {
      const result = yield* Rulesets.runTest23({
        target: target(OWNER_TOKEN, scratch),
        requiredChecks: ["ci"],
        botToken: Redacted.make(BOT_TOKEN),
        mergeToken: Redacted.make(MERGE_TOKEN),
      });
      assert.isFalse(result.ok);
      assert.lengthOf(writes(github.requests), 0);
    }).pipe(Effect.provide(github.layer));
  });
});
