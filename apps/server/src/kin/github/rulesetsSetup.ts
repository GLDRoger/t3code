// The CLI behind scripts/kin-rulesets.ts: apply the approvals spec section 10 rulesets, `--check`
// them for drift, check CODEOWNERS, and run security test 23 on a scratch repository. It runs on
// the owner's own GitHub sign-in and refuses the bot's.
import { KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { gitHubJson, gitHubRequest, KinGitHubRequestError } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import {
  KIN_CODEOWNERS_PATH,
  KIN_OWNER_LOGIN,
  KIN_REPO_REQUIRED_CHECKS,
  codeownersProblems,
  diffRuleset,
  kinRulesets,
  type KinRuleset,
} from "./KinRulesets.ts";
import * as OwnerMergeClient from "./OwnerMergeClient.ts";

export interface RulesetsResult {
  readonly ok: boolean;
  readonly lines: ReadonlyArray<string>;
}

export class KinRulesetsRefusedError extends Schema.TaggedError<KinRulesetsRefusedError>()(
  "KinRulesetsRefusedError",
  // Built from logins and repository names only, never from a credential.
  { reason: Schema.String },
) {
  override get message(): string {
    return `Refused: ${this.reason}`;
  }
}

export interface RepoTarget {
  readonly repo: RepoSlug;
  readonly owner: string;
  readonly token: Redacted.Redacted<string>;
}

const UserResponse = Schema.Struct({ login: Schema.String, type: Schema.String });
const RepoResponse = Schema.Struct({
  default_branch: Schema.String,
  permissions: Schema.optional(Schema.Struct({ admin: Schema.Boolean })),
});
const RulesetSummary = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  target: Schema.optional(Schema.String),
  source_type: Schema.optional(Schema.String),
});
const RulesetDetail = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  target: Schema.String,
  enforcement: Schema.String,
  bypass_actors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        actor_id: Schema.optional(Schema.NullOr(Schema.Int)),
        actor_type: Schema.String,
        bypass_mode: Schema.optional(Schema.String),
      }),
    ),
  ),
  conditions: Schema.optional(Schema.NullOr(Schema.Unknown)),
  rules: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        parameters: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  ),
});
type RulesetDetail = typeof RulesetDetail.Type;
const ContentResponse = Schema.Struct({ content: Schema.String, encoding: Schema.String });
const CodeownersErrors = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ line: Schema.Int, kind: Schema.String })),
});
const RefResponse = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const PullResponse = Schema.Struct({
  number: Schema.Int,
  head: Schema.Struct({ sha: Schema.String }),
});

const refuse = (reason: string) => Effect.fail(new KinRulesetsRefusedError({ reason }));

const repoPath = (repo: RepoSlug) => {
  const [owner, name] = repo.split("/") as [string, string];
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

/** One call where only the status matters; the body is never read. */
const statusOf = Effect.fn("kinRulesets.statusOf")(function* (input: {
  readonly operation: string;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly token: Redacted.Redacted<string>;
  readonly body?: unknown;
}) {
  const client = yield* HttpClient.HttpClient;
  const transport = () =>
    new KinGitHubRequestError({ operation: input.operation, stage: "transport" });
  let request = gitHubRequest(input.method, input.path, input.token);
  if (input.body !== undefined) {
    request = yield* HttpClientRequest.bodyJson(request, input.body).pipe(
      Effect.mapError(transport),
    );
  }
  const response = yield* client.execute(request).pipe(Effect.mapError(transport));
  return response.status;
});

/**
 * The owner's own admin sign-in, or a refusal. The bot App's installation tokens (`ghs_`) never
 * leave the process; any credential GitHub reports as a bot or as someone else is refused.
 */
export const verifyOwnerCredential = Effect.fn("kinRulesets.verifyOwnerCredential")(function* (
  target: RepoTarget,
) {
  const client = yield* HttpClient.HttpClient;
  if (Redacted.value(target.token).startsWith("ghs_")) {
    return yield* refuse(
      "this is a GitHub App installation token, the bot's credential. Use the owner's own sign-in.",
    );
  }
  const user = yield* gitHubJson({
    client,
    operation: "user.get",
    method: "GET",
    path: "/user",
    token: target.token,
    schema: UserResponse,
  }).pipe(
    Effect.mapError((error) =>
      error.stage === "status" && (error.status === 401 || error.status === 403)
        ? new KinRulesetsRefusedError({
            reason:
              "GitHub maps this credential to no user, as it does for App installation tokens. Use the owner's own sign-in.",
          })
        : error,
    ),
  );
  const { login, type } = user.body;
  if (type === "Bot" || login.endsWith("[bot]")) {
    return yield* refuse(`${login} is a bot account. Use the owner's own sign-in.`);
  }
  if (login.toLowerCase() !== target.owner.toLowerCase()) {
    return yield* refuse(`signed in as ${login}, not the owner ${target.owner}.`);
  }
  const repo = yield* gitHubJson({
    client,
    operation: "repos.get",
    method: "GET",
    path: repoPath(target.repo),
    token: target.token,
    schema: RepoResponse,
  });
  if (repo.body.permissions?.admin !== true) {
    return yield* refuse(
      `${login} can't administer ${target.repo} with this credential, so it can't see or set bypass actors.`,
    );
  }
  return { login, defaultBranch: repo.body.default_branch };
});

/** CODEOWNERS on the default branch, which is the copy GitHub reads for reviews into it. */
export const checkCodeowners = Effect.fn("kinRulesets.checkCodeowners")(function* (
  target: RepoTarget,
  defaultBranch: string,
) {
  const client = yield* HttpClient.HttpClient;
  const ref = `ref=${encodeURIComponent(defaultBranch)}`;
  const file = yield* gitHubJson({
    client,
    operation: "repos.codeowners",
    method: "GET",
    path: `${repoPath(target.repo)}/contents/${KIN_CODEOWNERS_PATH}?${ref}`,
    token: target.token,
    schema: Schema.Union([ContentResponse, Schema.Struct({ message: Schema.String })]),
    okStatuses: [200, 404],
  }).pipe(Effect.map((response) => ("content" in response.body ? response.body : undefined)));
  if (file === undefined) {
    return [`${KIN_CODEOWNERS_PATH} is missing on ${defaultBranch}; add "* @${target.owner}".`];
  }
  const content = Buffer.from(file.content, "base64").toString("utf8");
  const syntax = yield* gitHubJson({
    client,
    operation: "repos.codeownersErrors",
    method: "GET",
    path: `${repoPath(target.repo)}/codeowners/errors?${ref}`,
    token: target.token,
    schema: CodeownersErrors,
  });
  return [
    ...syntax.body.errors.map((error) => `line ${error.line}: GitHub reports ${error.kind}`),
    ...codeownersProblems(content, target.owner),
  ];
});

const readRulesets = Effect.fn("kinRulesets.read")(function* (
  target: RepoTarget,
  desired: ReadonlyArray<KinRuleset>,
) {
  const client = yield* HttpClient.HttpClient;
  const summaries = yield* gitHubJson({
    client,
    operation: "repos.rulesets",
    method: "GET",
    path: `${repoPath(target.repo)}/rulesets?includes_parents=false&per_page=100`,
    token: target.token,
    schema: Schema.Array(RulesetSummary),
  });
  const live = new Map<string, RulesetDetail>();
  for (const ruleset of desired) {
    const matches = summaries.body.filter(
      (summary) =>
        summary.name === ruleset.name &&
        (summary.target ?? ruleset.target) === ruleset.target &&
        (summary.source_type ?? "Repository") === "Repository",
    );
    if (matches.length > 1) {
      return yield* refuse(
        `${target.repo} has ${matches.length} ${ruleset.target} rulesets named ${ruleset.name}; delete the extras.`,
      );
    }
    if (matches[0] === undefined) continue;
    const detail = yield* gitHubJson({
      client,
      operation: "repos.ruleset",
      method: "GET",
      path: `${repoPath(target.repo)}/rulesets/${matches[0].id}`,
      token: target.token,
      schema: RulesetDetail,
    });
    live.set(ruleset.name, detail.body);
  }
  return live;
});

const driftLines = (desired: ReadonlyArray<KinRuleset>, live: ReadonlyMap<string, RulesetDetail>) =>
  desired.map((ruleset) => {
    const drift = diffRuleset(ruleset, live.get(ruleset.name));
    return {
      ok: drift.length === 0,
      lines: [
        `Ruleset ${ruleset.name} (${ruleset.target}): ${drift.length === 0 ? "ok" : "DRIFT"}`,
        ...drift.map(
          (line) => `  FAIL ${line.field}: expected ${line.expected}, got ${line.actual}`,
        ),
      ],
    };
  });

const codeownersLines = (problems: ReadonlyArray<string>, owner: string) =>
  problems.length === 0
    ? [`CODEOWNERS: ok (@${owner} owns every path)`]
    : ["CODEOWNERS: FAIL", ...problems.map((problem) => `  FAIL ${problem}`)];

/** `--check` and `--codeowners`: nothing is written. */
export const checkRepo = Effect.fn("kinRulesets.check")(function* (
  target: RepoTarget,
  input: { readonly requiredChecks: ReadonlyArray<string>; readonly rulesets: boolean },
) {
  const { login, defaultBranch } = yield* verifyOwnerCredential(target);
  const problems = yield* checkCodeowners(target, defaultBranch);
  const lines = [
    `${target.repo} (default branch ${defaultBranch}), checked as ${login}`,
    ...codeownersLines(problems, target.owner),
  ];
  let ok = problems.length === 0;
  if (input.rulesets) {
    const desired = kinRulesets(input.requiredChecks);
    for (const result of driftLines(desired, yield* readRulesets(target, desired))) {
      ok &&= result.ok;
      lines.push(...result.lines);
    }
  }
  lines.push(ok ? "PASS: no drift." : "FAIL: see above.");
  return { ok, lines } satisfies RulesetsResult;
});

/** Apply: creates or replaces each ruleset by name, writes nothing when it already matches. */
export const applyRepo = Effect.fn("kinRulesets.apply")(function* (
  target: RepoTarget,
  input: { readonly requiredChecks: ReadonlyArray<string> },
) {
  const client = yield* HttpClient.HttpClient;
  const { login, defaultBranch } = yield* verifyOwnerCredential(target);
  const problems = yield* checkCodeowners(target, defaultBranch);
  const lines = [
    `${target.repo} (default branch ${defaultBranch}), applying as ${login}`,
    ...codeownersLines(problems, target.owner),
  ];
  // Without CODEOWNERS, require_code_owner_review is met by anyone's approval.
  if (problems.length > 0) {
    lines.push("FAIL: fix CODEOWNERS on the default branch first; no ruleset was changed.");
    return { ok: false, lines } satisfies RulesetsResult;
  }
  const desired = kinRulesets(input.requiredChecks);
  const before = yield* readRulesets(target, desired);
  for (const ruleset of desired) {
    const live = before.get(ruleset.name);
    const drift = diffRuleset(ruleset, live);
    if (drift.length === 0) {
      lines.push(`Ruleset ${ruleset.name} (${ruleset.target}): unchanged`);
      continue;
    }
    yield* gitHubJson({
      client,
      operation: live === undefined ? "repos.createRuleset" : "repos.updateRuleset",
      method: live === undefined ? "POST" : "PUT",
      path: `${repoPath(target.repo)}/rulesets${live === undefined ? "" : `/${live.id}`}`,
      token: target.token,
      body: ruleset,
      schema: Schema.Struct({ id: Schema.Int }),
      okStatuses: live === undefined ? [201] : [200],
    });
    lines.push(
      live === undefined
        ? `Ruleset ${ruleset.name} (${ruleset.target}): created`
        : `Ruleset ${ruleset.name} (${ruleset.target}): updated ${drift.map((line) => line.field).join(", ")}`,
    );
  }
  let ok = true;
  for (const result of driftLines(desired, yield* readRulesets(target, desired))) {
    if (result.ok) continue;
    ok = false;
    lines.push("GitHub stored something other than what was sent:", ...result.lines);
  }
  lines.push(ok ? "PASS: rulesets applied with no drift." : "FAIL: see above.");
  return { ok, lines } satisfies RulesetsResult;
});

// Success codes would mean the action went through; 401 and 404 mean the probe never reached
// the rule, so they don't count as blocked either.
const isBlocked = (status: number) => status >= 400 && status !== 401 && status !== 404;

/**
 * Security test 23 on a scratch repository: the bot opens a PR, then the owner merge token tries
 * to review, the bot tries to merge and to push, and the merge token tries to merge without a
 * code-owner review. A final review by the owner followed by a successful merge shows the
 * earlier blocks came from the review rule. Required checks get success statuses from the owner.
 */
export const runTest23 = Effect.fn("kinRulesets.test23")(function* (input: {
  readonly target: RepoTarget;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly botToken: Redacted.Redacted<string>;
  readonly mergeToken: Redacted.Redacted<string>;
}) {
  const client = yield* HttpClient.HttpClient;
  const { target } = input;
  const path = repoPath(target.repo);
  const check = yield* checkRepo(target, { requiredChecks: input.requiredChecks, rulesets: true });
  if (!check.ok) {
    return {
      ok: false,
      lines: [...check.lines, "Test 23 not run: apply the rulesets to the scratch repo first."],
    } satisfies RulesetsResult;
  }
  const { defaultBranch } = yield* verifyOwnerCredential(target);
  const stamp = yield* Clock.currentTimeMillis;
  const branch = `kin-test-23-${stamp}`;
  const base = yield* gitHubJson({
    client,
    operation: "git.getRef",
    method: "GET",
    path: `${path}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
    token: input.botToken,
    schema: RefResponse,
  });
  yield* gitHubJson({
    client,
    operation: "git.createRef",
    method: "POST",
    path: `${path}/git/refs`,
    token: input.botToken,
    body: { ref: `refs/heads/${branch}`, sha: base.body.object.sha },
    schema: Schema.Struct({ ref: Schema.String }),
    okStatuses: [201],
  });
  let merged = false;
  let pullNumber: number | undefined;
  const run = Effect.gen(function* () {
    yield* gitHubJson({
      client,
      operation: "repos.createFile",
      method: "PUT",
      path: `${path}/contents/kin-test-23/${stamp}.md`,
      token: input.botToken,
      body: {
        message: "test: kin security test 23",
        content: Buffer.from("Kin security test 23. Safe to delete.\n").toString("base64"),
        branch,
      },
      schema: Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) }),
      okStatuses: [201],
    });
    const pull = yield* gitHubJson({
      client,
      operation: "pulls.create",
      method: "POST",
      path: `${path}/pulls`,
      token: input.botToken,
      body: { title: "Kin security test 23", head: branch, base: defaultBranch },
      schema: PullResponse,
      okStatuses: [201],
    });
    pullNumber = pull.body.number;
    const headSha = pull.body.head.sha;
    const pullPath = `${path}/pulls/${pull.body.number}`;
    for (const context of input.requiredChecks) {
      yield* gitHubJson({
        client,
        operation: "repos.createStatus",
        method: "POST",
        path: `${path}/statuses/${headSha}`,
        token: target.token,
        body: { state: "success", context, description: "Kin security test 23" },
        schema: Schema.Struct({ id: Schema.Int }),
        okStatuses: [201],
      });
    }
    const mergeBody = { sha: headSha, merge_method: "squash" };
    const probes: ReadonlyArray<{
      readonly name: string;
      readonly pass: (status: number) => boolean;
      readonly request: Parameters<typeof statusOf>[0];
    }> = [
      {
        name: "the owner merge token can't submit a review",
        pass: (status) => status === 403,
        request: {
          operation: "pulls.createReview",
          method: "POST",
          path: `${pullPath}/reviews`,
          token: input.mergeToken,
          body: { event: "APPROVE", commit_id: headSha },
        },
      },
      {
        name: "the bot can't merge to the default branch",
        pass: isBlocked,
        request: {
          operation: "pulls.merge",
          method: "PUT",
          path: `${pullPath}/merge`,
          token: input.botToken,
          body: mergeBody,
        },
      },
      {
        name: "the bot can't push to the default branch",
        pass: isBlocked,
        request: {
          operation: "git.updateRef",
          method: "PATCH",
          path: `${path}/git/refs/heads/${encodeURIComponent(defaultBranch)}`,
          token: input.botToken,
          body: { sha: headSha, force: false },
        },
      },
      {
        name: "a merge without a code-owner review is blocked",
        pass: isBlocked,
        request: {
          operation: "pulls.merge",
          method: "PUT",
          path: `${pullPath}/merge`,
          token: input.mergeToken,
          body: mergeBody,
        },
      },
    ];
    const lines = [
      `Test 23 on ${target.repo}, PR #${pull.body.number} by the bot at ${headSha.slice(0, 7)}:`,
    ];
    let ok = true;
    for (const probe of probes) {
      const status = yield* statusOf(probe.request);
      const pass = probe.pass(status);
      ok &&= pass;
      lines.push(`  ${pass ? "PASS" : "FAIL"} ${probe.name} (HTTP ${status})`);
      if (!pass) return { ok: false, lines: [...lines, "FAIL: stopped at the first failure."] };
    }
    const review = yield* statusOf({
      operation: "pulls.createReview",
      method: "POST",
      path: `${pullPath}/reviews`,
      token: target.token,
      body: { event: "APPROVE", commit_id: headSha },
    });
    let merge: number | undefined;
    // GitHub recomputes mergeability after a review, so the first merge can still see it blocked.
    for (let attempt = 0; review === 200 && attempt < 5; attempt++) {
      merge = yield* statusOf(probes[3]!.request);
      if (merge !== 405) break;
      yield* Effect.sleep("2 seconds");
    }
    merged = merge === 200;
    ok &&= merged;
    lines.push(
      `  ${merged ? "PASS" : "FAIL"} after ${target.owner}'s review the merge token merges (review HTTP ${review}, merge HTTP ${merge ?? "not tried"}), so the blocks came from the rules`,
      ok ? "PASS: security test 23." : "FAIL: see above.",
    );
    return { ok, lines } satisfies RulesetsResult;
  });
  const cleanup = Effect.gen(function* () {
    if (!merged && pullNumber !== undefined) {
      yield* statusOf({
        operation: "pulls.close",
        method: "PATCH",
        path: `${path}/pulls/${pullNumber}`,
        token: input.botToken,
        body: { state: "closed" },
      });
    }
    yield* statusOf({
      operation: "git.deleteRef",
      method: "DELETE",
      path: `${path}/git/refs/heads/${encodeURIComponent(branch)}`,
      token: input.botToken,
    });
  }).pipe(Effect.ignore);
  return yield* run.pipe(Effect.ensuring(cleanup));
});

const decodeRepo = Schema.decodeUnknownEffect(RepoSlug);
const decodeOrgId = Schema.decodeUnknownEffect(KinOrgId);

const ownerToken = Effect.gen(function* () {
  const fromEnv = yield* Config.option(Config.Redacted("GH_TOKEN"));
  if (Option.isSome(fromEnv)) return fromEnv.value;
  const pasted = yield* Prompt.run(
    Prompt.Hidden({ message: "Paste the owner's GitHub token (hidden; `gh auth token`)" }),
  );
  return Redacted.make(String(Redacted.value(pasted)));
});

const failed = (error: { readonly message: string }) =>
  Effect.succeed({ ok: false, lines: [error.message] } satisfies RulesetsResult);

/** @public Run by scripts/kin-rulesets.ts, which loads this file by URL. */
export const kinRulesetsCommand = Command.make(
  "kin-rulesets",
  {
    repo: Flag.String("repo").pipe(Flag.withDescription("The repository, as owner/name.")),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Report drift from the approvals spec rulesets and CODEOWNERS; change nothing.",
      ),
      Flag.withDefault(false),
    ),
    codeowners: Flag.Boolean("codeowners").pipe(
      Flag.withDescription("Check only CODEOWNERS."),
      Flag.withDefault(false),
    ),
    test23: Flag.Boolean("test-23").pipe(
      Flag.withDescription("Run security test 23 on a scratch repository (opens and merges a PR)."),
      Flag.withDefault(false),
    ),
    owner: Flag.String("owner").pipe(
      Flag.withDescription("The owner's GitHub login: sole code owner and the required sign-in."),
      Flag.withDefault(KIN_OWNER_LOGIN),
    ),
    statusCheck: Flag.String("status-check").pipe(
      Flag.withDescription(
        "A required status check context (repeatable); Kin repos have defaults.",
      ),
      Flag.atLeast(0),
    ),
    kinOrg: Flag.String("kin-org").pipe(
      Flag.withDescription("For --test-23: the Kin org whose merge token is in the keychain."),
      Flag.optional,
    ),
    appId: Flag.String("app-id").pipe(
      Flag.withDescription("For --test-23: the bot App id; defaults to KIN_GITHUB_APP_ID."),
      Flag.optional,
    ),
  },
  (input) => {
    const program = Effect.gen(function* () {
      const repo = yield* decodeRepo(input.repo).pipe(
        Effect.mapError(
          () => new KinRulesetsRefusedError({ reason: "--repo must be owner/name." }),
        ),
      );
      const requiredChecks =
        input.statusCheck.length > 0 ? input.statusCheck : (KIN_REPO_REQUIRED_CHECKS[repo] ?? []);
      if (requiredChecks.length === 0 && !input.codeowners) {
        return yield* refuse(
          `${repo} has no default required checks; pass --status-check <context>.`,
        );
      }
      if (input.test23 && repo in KIN_REPO_REQUIRED_CHECKS) {
        return yield* refuse(`${repo} is a Kin repository; run --test-23 on a scratch repository.`);
      }
      const target = { repo, owner: input.owner, token: yield* ownerToken } satisfies RepoTarget;
      if (input.codeowners) return yield* checkRepo(target, { requiredChecks, rulesets: false });
      if (input.check) return yield* checkRepo(target, { requiredChecks, rulesets: true });
      if (!input.test23) return yield* applyRepo(target, { requiredChecks });
      if (Option.isNone(input.kinOrg)) return yield* refuse("--test-23 needs --kin-org <org-id>.");
      const orgId = yield* decodeOrgId(input.kinOrg.value);
      const appConfig = Option.match(input.appId, {
        onNone: () => KinGitHubApp.KinGitHubAppConfig.layer,
        onSome: (appId) => Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId }),
      });
      return yield* Effect.gen(function* () {
        const bot = yield* (yield* KinGitHubApp.KinGitHubApp).installationToken({
          repo,
          permissions: { contents: "write", pull_requests: "write" },
        });
        const mergeToken = yield* (yield* OwnerMergeClient.OwnerMergeClient).token(orgId);
        return yield* runTest23({ target, requiredChecks, botToken: bot.token, mergeToken });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(KinGitHubApp.layer.pipe(Layer.provide(appConfig)), OwnerMergeClient.layer),
        ),
      );
    });
    return program.pipe(
      Effect.catch(failed),
      Effect.provide(Layer.mergeAll(Keychain.layer, FetchHttpClient.layer)),
      Effect.flatMap(({ ok, lines }) =>
        Console.log(lines.join("\n")).pipe(
          // exitCode, not a failed exit, so piped output is not cut off.
          Effect.andThen(
            Effect.sync(() => {
              if (!ok) process.exitCode = 1;
            }),
          ),
        ),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Apply and check Kin's GitHub rulesets and CODEOWNERS, and run security test 23 on a scratch repo.",
  ),
);
