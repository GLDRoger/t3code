// The CLI behind scripts/kin-rulesets.ts: apply the approvals spec section 10 rulesets, `--check`
// them for drift, check CODEOWNERS, and run security test 23 on a scratch repository. It runs on
// the owner's own GitHub sign-in and refuses the bot's.
import { KinOrgId, RepoSlug } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient } from "effect/http";

import { gitHubAnswer, gitHubJson, repoPath } from "./githubRest.ts";
import * as Keychain from "./Keychain.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import {
  KIN_CODEOWNERS_PATH,
  KIN_REPO_REQUIRED_CHECKS,
  codeownersProblems,
  diffRuleset,
  kinRulesets,
  type KinRuleset,
} from "./KinRulesets.ts";
import { KinGitHubScope } from "./KinGitHubScope.ts";
import * as OwnerMergeClient from "./OwnerMergeClient.ts";
import { runTest23Probes } from "./rulesetsTest23.ts";

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
  full_name: Schema.String,
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
  current_user_can_bypass: Schema.optional(Schema.String),
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
const refuse = (reason: string) => Effect.fail(new KinRulesetsRefusedError({ reason }));

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
  return { login, defaultBranch: repo.body.default_branch, fullName: repo.body.full_name };
});
type VerifiedOwner = Effect.Success<ReturnType<typeof verifyOwnerCredential>>;

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

const checkVerified = Effect.fn("kinRulesets.checkVerified")(function* (
  target: RepoTarget,
  { login, defaultBranch }: VerifiedOwner,
  input: { readonly requiredChecks: ReadonlyArray<string>; readonly rulesets: boolean },
) {
  const problems = yield* checkCodeowners(target, defaultBranch);
  const lines = [
    `${target.repo} (default branch ${defaultBranch}), checked as ${login}`,
    ...codeownersLines(problems, target.owner),
  ];
  let ok = problems.length === 0;
  const live = input.rulesets
    ? yield* readRulesets(target, kinRulesets(input.requiredChecks))
    : new Map<string, RulesetDetail>();
  if (input.rulesets) {
    for (const result of driftLines(kinRulesets(input.requiredChecks), live)) {
      ok &&= result.ok;
      lines.push(...result.lines);
    }
  }
  lines.push(ok ? "PASS: no drift." : "FAIL: see above.");
  return { ok, lines, live };
});

/** `--check` and `--codeowners`: nothing is written. */
export const checkRepo = Effect.fn("kinRulesets.check")(function* (
  target: RepoTarget,
  input: { readonly requiredChecks: ReadonlyArray<string>; readonly rulesets: boolean },
) {
  const { ok, lines } = yield* checkVerified(target, yield* verifyOwnerCredential(target), input);
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

const isKinRepo = (kinRepos: ReadonlyArray<string>, repo: string) =>
  kinRepos.some((kin) => kin.toLowerCase() === repo.toLowerCase());

/**
 * Why `repo` can't host test 23, or null. Test 23 opens and merges a PR and tries to move tags, so
 * it runs only on a repository named as a scratch one and never on a Kin repository.
 */
export function scratchRepoProblem(repo: string, kinRepos: ReadonlyArray<string>): string | null {
  if (isKinRepo(kinRepos, repo)) {
    return `${repo} is a Kin repository; run --test-23 on a scratch repository.`;
  }
  if (!/scratch/i.test(repo.split("/")[1] ?? "")) {
    return `${repo} has no "scratch" in its name; test 23 runs only on a scratch repository.`;
  }
  return null;
}

/** The repositories test 23 must never touch: `KIN_GITHUB_REPOS` and the known Kin ones. */
export const kinRepos = (scoped: ReadonlyArray<string>) => [
  ...scoped,
  ...Object.keys(KIN_REPO_REQUIRED_CHECKS),
];

/**
 * Security test 23 on a scratch repository. The owner is checked once, and the repository GitHub
 * answers for (`full_name`, which follows renames and transfers) must be the one asked for and a
 * scratch one. `tokens` runs only after that and after `--check` passes; the bot token it returns
 * is revoked at the end.
 */
export const runTest23 = Effect.fn("kinRulesets.test23Run")(function* <E, R>(input: {
  readonly target: RepoTarget;
  readonly requiredChecks: ReadonlyArray<string>;
  readonly kinRepos: ReadonlyArray<string>;
  readonly tokens: Effect.Effect<
    {
      readonly botToken: Redacted.Redacted<string>;
      readonly mergeToken: Redacted.Redacted<string>;
    },
    E,
    R
  >;
}) {
  const { target } = input;
  const before = scratchRepoProblem(target.repo, input.kinRepos);
  if (before !== null) return yield* refuse(before);
  const owner = yield* verifyOwnerCredential(target);
  const answered =
    owner.fullName.toLowerCase() === target.repo.toLowerCase()
      ? scratchRepoProblem(owner.fullName, input.kinRepos)
      : `GitHub answered for ${owner.fullName}, not ${target.repo}; it was renamed or moved.`;
  if (answered !== null) return yield* refuse(answered);
  const desired = kinRulesets(input.requiredChecks);
  const check = yield* checkVerified(target, owner, {
    requiredChecks: input.requiredChecks,
    rulesets: true,
  });
  if (!check.ok) {
    return {
      ok: false,
      lines: [...check.lines, "Test 23 not run: apply the rulesets to the scratch repo first."],
    } satisfies RulesetsResult;
  }
  const { botToken, mergeToken } = yield* input.tokens;
  const client = yield* HttpClient.HttpClient;
  const revokeLines: Array<string> = [];
  const revoke = gitHubAnswer({
    client,
    operation: "installation.revokeToken",
    method: "DELETE",
    path: "/installation/token",
    token: botToken,
  }).pipe(
    Effect.map((answer) => (answer.status === 204 ? null : `HTTP ${answer.status}`)),
    Effect.orElseSucceed(() => "GitHub unreachable"),
    Effect.map((problem) => {
      if (problem !== null) {
        revokeLines.push(
          `  WARN cleanup: couldn't revoke the bot token (${problem}); it expires within the hour`,
        );
      }
    }),
  );
  const probes = yield* runTest23Probes({
    repo: target.repo,
    owner: target.owner,
    defaultBranch: owner.defaultBranch,
    requiredChecks: input.requiredChecks,
    rulesets: desired.flatMap((ruleset) => {
      const id = check.live.get(ruleset.name)?.id;
      return id === undefined ? [] : [{ id, desired: ruleset }];
    }),
    ownerToken: target.token,
    botToken,
    mergeToken,
  }).pipe(Effect.ensuring(revoke));
  // The change probes sent the desired bodies, so drift here means something else wrote to them.
  const after = yield* checkVerified(target, owner, {
    requiredChecks: input.requiredChecks,
    rulesets: true,
  });
  const ok = probes.ok && after.ok;
  return {
    ok,
    lines: [
      ...probes.lines,
      ...revokeLines,
      after.ok ? "  PASS the rulesets show no drift afterwards" : "  FAIL the rulesets drifted:",
      ...(after.ok ? [] : after.lines),
      ok
        ? "PASS: security test 23."
        : probes.rateLimited
          ? "NOT DONE: GitHub rate-limited test 23, which proves nothing either way; try again later."
          : "FAIL: see above.",
    ],
  } satisfies RulesetsResult;
});

const decodeRepo = Schema.decodeUnknownEffect(RepoSlug);
const TEST_23_ORG = Schema.decodeSync(KinOrgId)("kin-test-23");

/** `OwnerMergeClient.save` writes to this, so test 23's probes run without storing the token. */
const discardKeychain = Layer.succeed(
  Keychain.KinKeychain,
  Keychain.KinKeychain.of({
    get: Effect.fn("discardKeychain.get")(function* () {
      return Option.none<Redacted.Redacted<string>>();
    }),
    set: Effect.fn("discardKeychain.set")(function* () {}),
    remove: Effect.fn("discardKeychain.remove")(function* () {}),
    ready: Effect.fn("discardKeychain.ready")(function* () {}),
  }),
);

const scratchMergeToken = Prompt.run(
  Prompt.Hidden({
    message:
      "Paste a fine-grained token of the owner's for the scratch repo only, with Contents: Read and write and Metadata: Read (hidden)",
  }),
).pipe(Effect.map((pasted) => Redacted.make(String(Redacted.value(pasted)))));

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
      Flag.withDescription(
        "The code owner and required sign-in, for a repository outside Kin; Kin repos and --test-23 use KIN_GITHUB_OWNER_LOGIN.",
      ),
      Flag.optional,
    ),
    statusCheck: Flag.String("status-check").pipe(
      Flag.withDescription(
        "A required status check context (repeatable); Kin repos have defaults.",
      ),
      Flag.atLeast(0),
    ),
    appId: Flag.String("app-id").pipe(
      Flag.withDescription("For --test-23: the bot App id; defaults to KIN_GITHUB_APP_ID."),
      Flag.optional,
    ),
    probePr: Flag.Int("probe-pr").pipe(
      Flag.withDescription(
        "For --test-23: an existing PR on the scratch repo for the merge token's review probe; defaults to #1.",
      ),
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
      const scope = yield* KinGitHubScope;
      const protectedRepos = kinRepos(scope.repos);
      if (input.test23) {
        const problem = scratchRepoProblem(repo, protectedRepos);
        if (problem !== null) return yield* refuse(problem);
      }
      // Kin repos and test 23's merge token belong to the configured owner, and no one else.
      const pinned = input.test23 || isKinRepo(protectedRepos, repo);
      const owner = Option.getOrElse(input.owner, () => scope.ownerLogin);
      if (pinned && owner.toLowerCase() !== scope.ownerLogin.toLowerCase()) {
        return yield* refuse(
          `--owner ${owner} differs from KIN_GITHUB_OWNER_LOGIN (${scope.ownerLogin}), which ${input.test23 ? "test 23" : repo} must use.`,
        );
      }
      const known = Object.entries(KIN_REPO_REQUIRED_CHECKS).find(
        ([slug]) => slug.toLowerCase() === repo.toLowerCase(),
      )?.[1];
      const requiredChecks = input.statusCheck.length > 0 ? input.statusCheck : (known ?? []);
      if (requiredChecks.length === 0 && !input.codeowners) {
        return yield* refuse(
          `${repo} has no default required checks; pass --status-check <context>.`,
        );
      }
      const target = { repo, owner, token: yield* ownerToken } satisfies RepoTarget;
      if (input.codeowners) return yield* checkRepo(target, { requiredChecks, rulesets: false });
      if (input.check) return yield* checkRepo(target, { requiredChecks, rulesets: true });
      if (!input.test23) return yield* applyRepo(target, { requiredChecks });
      const appConfig = Option.match(input.appId, {
        onNone: () => KinGitHubApp.KinGitHubAppConfig.layer,
        onSome: (appId) => Layer.succeed(KinGitHubApp.KinGitHubAppConfig, { appId }),
      });
      // The App and the merge token are checked against the scratch repo alone. The stored merge
      // token is scoped to the Kin repos, so test 23 takes a scratch token with the same shape and
      // runs `save`'s probes on it without keeping it.
      const scratchScope = Layer.succeed(KinGitHubScope, { ...scope, repos: [repo] });
      const tokens = Effect.gen(function* () {
        const mergeToken = yield* scratchMergeToken;
        yield* (yield* OwnerMergeClient.OwnerMergeClient).save({
          orgId: TEST_23_ORG,
          token: mergeToken,
          probePr: Option.getOrUndefined(input.probePr),
        });
        const bot = yield* (yield* KinGitHubApp.KinGitHubApp).installationToken({
          repo,
          permissions: { contents: "write", pull_requests: "write" },
          holder: "server",
        });
        return { botToken: bot.token, mergeToken };
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            KinGitHubApp.layer.pipe(Layer.provide(Layer.mergeAll(appConfig, scratchScope))),
            OwnerMergeClient.layer.pipe(
              Layer.provide(Layer.mergeAll(scratchScope, discardKeychain)),
            ),
          ),
        ),
      );
      return yield* runTest23({ target, requiredChecks, kinRepos: protectedRepos, tokens });
    }).pipe(Effect.provide(KinGitHubScope.layer));
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
