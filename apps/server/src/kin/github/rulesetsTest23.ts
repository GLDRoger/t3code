// Security test 23's probes (approvals spec section 10), run by `kin-rulesets --test-23` on a
// scratch repository that already passes `--check`. rulesetsSetup.ts verifies the owner and the
// repository before calling this, and checks for drift again after it.
import type { RepoSlug } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import {
  gitHubAnswer,
  gitHubJson,
  isGitHubRateLimit,
  repoPath,
  type GitHubAnswer,
  type KinGitHubRequestError,
} from "./githubRest.ts";
import { GITHUB_ACTIONS_INTEGRATION_ID, type KinRuleset } from "./KinRulesets.ts";

/** What a refused call must look like; anything else, success included, fails the probe. */
export type KinBlock =
  /** 403: the token lacks the permission. */
  | "forbidden"
  /** 403 or 404. GitHub answers 404 to hide an endpoint the token can't use; nothing is written. */
  | "refused"
  /** 422 "Repository rule violations found": a ruleset stopped a ref write. */
  | "rule_violation"
  /** 405 naming a missing review: the merge was stopped by the pull request rule. */
  | "review_required";

/**
 * Whether `answer` is the refusal `block` expects. Status alone can't tell a rule from a typo, and
 * a rate limit is never a block: it says nothing about the token or the rules.
 */
export function isKinBlock(
  answer: Pick<GitHubAnswer, "status" | "headers" | "message">,
  block: KinBlock,
) {
  if (isGitHubRateLimit(answer)) return false;
  switch (block) {
    case "forbidden":
      return answer.status === 403;
    case "refused":
      return answer.status === 403 || answer.status === 404;
    case "rule_violation":
      return answer.status === 422 && /^Repository rule violations found/.test(answer.message);
    case "review_required":
      return (
        answer.status === 405 &&
        /approving review|code owner review|review is required/i.test(answer.message)
      );
  }
}

const describe = (answer: GitHubAnswer) => {
  const message = answer.message.replace(/\s+/g, " ").trim().slice(0, 160);
  return `HTTP ${answer.status}${message === "" ? "" : `: ${message}`}`;
};

const RefResponse = Schema.Struct({
  ref: Schema.String,
  object: Schema.Struct({ sha: Schema.String }),
});
const PullResponse = Schema.Struct({
  number: Schema.Int,
  head: Schema.Struct({ sha: Schema.String }),
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mergeable_state: Schema.optional(Schema.String),
});
type PullState = typeof PullResponse.Type;
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      app: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.Int }))),
    }),
  ),
});
const Reviews = Schema.Array(
  Schema.Struct({
    state: Schema.String,
    commit_id: Schema.optional(Schema.NullOr(Schema.String)),
    user: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String }))),
  }),
);
const RulesetRead = Schema.Struct({
  bypass_actors: Schema.optional(Schema.Array(Schema.Unknown)),
  current_user_can_bypass: Schema.optional(Schema.String),
});
const CommitResponse = Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) });
const decodeRef = Schema.decodeUnknownOption(RefResponse);
const decodePull = Schema.decodeUnknownOption(PullResponse);
const decodeRulesetRead = Schema.decodeUnknownOption(RulesetRead);
const decodeCommit = Schema.decodeUnknownOption(CommitResponse);

interface Poll {
  readonly every: Duration.Input;
  readonly times: number;
}
// GitHub computes mergeability in the background; Actions runs take minutes.
const MERGEABLE_POLL: Poll = { every: "2 seconds", times: 30 };
const CHECKS_POLL: Poll = { every: "10 seconds", times: 60 };

const poll = Effect.fn("kinRulesets.test23.poll")(function* <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  schedule: Poll,
) {
  let last = yield* read;
  for (let attempt = 1; !done(last) && attempt < schedule.times; attempt++) {
    yield* Effect.sleep(schedule.every);
    last = yield* read;
  }
  return last;
});

interface Step {
  readonly pass: boolean;
  readonly line: string;
  /** GitHub rate-limited the call, so the step proves nothing either way. */
  readonly rateLimited?: boolean;
}

/** Ref paths keep their slashes: `tags/v1/rc`, not `tags%2Fv1%2Frc`. */
const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

export const runTest23Probes = Effect.fn("kinRulesets.test23")(function* (input: {
  readonly repo: RepoSlug;
  readonly owner: string;
  readonly defaultBranch: string;
  readonly requiredChecks: ReadonlyArray<string>;
  /** The live ids of the desired rulesets, for the read and change probes. */
  readonly rulesets: ReadonlyArray<{ readonly id: number; readonly desired: KinRuleset }>;
  readonly ownerToken: Redacted.Redacted<string>;
  readonly botToken: Redacted.Redacted<string>;
  readonly mergeToken: Redacted.Redacted<string>;
}) {
  const client = yield* HttpClient.HttpClient;
  const path = repoPath(input.repo);
  const tokens = [
    ["the bot", input.botToken],
    ["the merge token", input.mergeToken],
  ] as const;
  const call = (
    operation: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    route: string,
    token: Redacted.Redacted<string>,
    body?: unknown,
  ) => gitHubAnswer({ client, operation, method, path: `${path}${route}`, token, body });
  const read = <S extends Schema.Top>(operation: string, route: string, schema: S) =>
    gitHubJson({
      client,
      operation,
      method: "GET",
      path: `${path}${route}`,
      token: input.ownerToken,
      schema,
    }).pipe(Effect.map((response) => response.body));
  const refSha = (ref: string) =>
    call("git.getRef", "GET", `/git/ref/${refPath(ref)}`, input.ownerToken).pipe(
      Effect.map((answer) => (answer.status === 200 ? decodeRef(answer.body) : undefined)),
      Effect.map((ref) => (ref === undefined || ref._tag === "None" ? null : ref.value.object.sha)),
    );

  // Moving a tag needs one to exist, and the tag ruleset stops even the owner from making one.
  const tags = yield* read(
    "git.matchingTags",
    "/git/matching-refs/tags/v",
    Schema.Array(RefResponse),
  );
  const releaseTag = tags.find((tag) => tag.ref.startsWith("refs/tags/v"));
  if (releaseTag === undefined) {
    return {
      ok: false,
      rateLimited: false,
      lines: [
        `Test 23 not run: ${input.repo} has no v* tag to try moving. Set kin-release to disabled, push a tag such as v0.0.0, then apply again.`,
      ],
    };
  }
  const releaseRef = releaseTag.ref.slice("refs/".length);

  const stamp = yield* Clock.currentTimeMillis;
  const branch = `kin-test-23-${stamp}`;
  const newTag = `tags/v0.0.0-kin-test-23-${stamp}`;
  const defaultRef = `heads/${input.defaultBranch}`;
  const baseSha = (yield* read("git.getRef", `/git/ref/${refPath(defaultRef)}`, RefResponse)).object
    .sha;
  const created = yield* call("git.createRef", "POST", "/git/refs", input.botToken, {
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });
  if (created.status !== 201) {
    return {
      ok: false,
      rateLimited: false,
      lines: [`Test 23 not run: the bot couldn't create ${branch} (${describe(created)}).`],
    };
  }

  const state = {
    pull: undefined as number | undefined,
    merged: false,
    tagCreated: false,
    tagMoved: false,
  };
  const botCommit = Effect.fn("kinRulesets.test23.botCommit")(function* (file: string) {
    const answer = yield* call(
      "repos.createFile",
      "PUT",
      `/contents/kin-test-23/${file}`,
      input.botToken,
      {
        message: "test: kin security test 23",
        content: Buffer.from("Kin security test 23. Safe to delete.\n").toString("base64"),
        branch,
      },
    );
    const commit = decodeCommit(answer.body);
    return answer.status === 201 && commit._tag === "Some" ? commit.value.commit.sha : null;
  });

  const run = Effect.gen(function* () {
    const h1 = yield* botCommit(`${stamp}.md`);
    if (h1 === null)
      return {
        ok: false,
        rateLimited: false,
        lines: ["FAIL the bot couldn't commit to its branch."],
      };
    const opened = yield* call("pulls.create", "POST", "/pulls", input.botToken, {
      title: "Kin security test 23",
      head: branch,
      base: input.defaultBranch,
    });
    const pull = decodePull(opened.body);
    if (opened.status !== 201 || pull._tag === "None") {
      return {
        ok: false,
        rateLimited: false,
        lines: [`FAIL the bot couldn't open a PR (${describe(opened)}).`],
      };
    }
    const number = pull.value.number;
    state.pull = number;
    const pullRoute = `/pulls/${number}`;
    const lines = [`Test 23 on ${input.repo}, PR #${number} by the bot at ${h1.slice(0, 7)}:`];

    const checksPass = Effect.fn("kinRulesets.test23.checks")(function* (sha: string) {
      const verdict = (runs: typeof CheckRuns.Type) =>
        input.requiredChecks.map((context) => {
          const own = runs.check_runs.filter(
            (run) => run.name === context && run.app?.id === GITHUB_ACTIONS_INTEGRATION_ID,
          );
          if (own.some((run) => run.status === "completed" && run.conclusion === "success")) {
            return "success" as const;
          }
          return own.length > 0 && own.every((run) => run.status === "completed")
            ? ("failed" as const)
            : ("pending" as const);
        });
      const runs = yield* poll(
        read("checks.list", `/commits/${sha}/check-runs?per_page=100`, CheckRuns),
        (value) => !verdict(value).includes("pending"),
        CHECKS_POLL,
      );
      const result = verdict(runs);
      return {
        pass: result.every((value) => value === "success"),
        line: `the required checks (${input.requiredChecks.join(", ")}) pass on ${sha.slice(0, 7)} from GitHub Actions (${result.join(", ")})`,
      } satisfies Step;
    });
    const reportedAs = Effect.fn("kinRulesets.test23.mergeableState")(function* (
      sha: string,
      expected: "blocked" | "clean",
    ) {
      const computed = (pr: PullState) =>
        pr.head.sha === sha && pr.mergeable !== null && pr.mergeable !== undefined;
      // Only `clean` is waited for: GitHub may lag a review, but a PR is never briefly clean early.
      const pr = yield* poll(
        read("pulls.get", pullRoute, PullResponse),
        (value) => computed(value) && (expected === "blocked" || value.mergeable_state === "clean"),
        MERGEABLE_POLL,
      );
      return {
        pass: computed(pr) && pr.mergeable_state === expected,
        line: `GitHub reports the PR ${expected} at ${sha.slice(0, 7)} (mergeable_state ${pr.mergeable_state ?? "absent"})`,
      } satisfies Step;
    });
    const probe = Effect.fn("kinRulesets.test23.probe")(function* (
      name: string,
      block: KinBlock,
      request: Effect.Effect<GitHubAnswer, KinGitHubRequestError>,
      after?: Effect.Effect<string | null, KinGitHubRequestError>,
    ) {
      const answer = yield* request;
      const blocked = isKinBlock(answer, block);
      const problem = after === undefined ? null : yield* after;
      return {
        pass: blocked && problem === null,
        line: `${name} (${describe(answer)})${problem === null ? "" : `; ${problem}`}`,
        rateLimited: isGitHubRateLimit(answer),
      } satisfies Step;
    });
    const approve = (sha: string): Effect.Effect<Step, KinGitHubRequestError> =>
      call("pulls.createReview", "POST", `${pullRoute}/reviews`, input.ownerToken, {
        event: "APPROVE",
        commit_id: sha,
      }).pipe(
        Effect.map((answer) => ({
          pass: answer.status === 200,
          line: `${input.owner} approves at ${sha.slice(0, 7)} (${describe(answer)})`,
          rateLimited: isGitHubRateLimit(answer),
        })),
      );
    const mergeAs = (token: Redacted.Redacted<string>, sha: string) =>
      call("pulls.merge", "PUT", `${pullRoute}/merge`, token, { sha, merge_method: "squash" });
    const unmoved = (ref: string, sha: string | null) =>
      refSha(ref).pipe(
        Effect.map((now) => {
          if (now === sha) return null;
          if (ref === newTag) state.tagCreated = true;
          if (ref === releaseRef) state.tagMoved = true;
          return `but ${ref} is now ${now ?? "missing"}`;
        }),
      );

    const steps: Array<Effect.Effect<Step, KinGitHubRequestError>> = [
      checksPass(h1),
      reportedAs(h1, "blocked"),
      probe(
        "the merge token can't submit a review",
        "forbidden",
        call("pulls.createReview", "POST", `${pullRoute}/reviews`, input.mergeToken, {
          event: "APPROVE",
          commit_id: h1,
        }),
      ),
      ...tokens.flatMap(([who, token]) => [
        probe(
          `${who} can't merge without a code-owner review`,
          "review_required",
          mergeAs(token, h1),
        ),
        probe(
          `${who} can't push to ${input.defaultBranch}`,
          "rule_violation",
          call("git.updateRef", "PATCH", `/git/refs/${refPath(defaultRef)}`, token, {
            sha: h1,
            force: false,
          }),
          unmoved(defaultRef, baseSha),
        ),
        probe(
          `${who} can't create a v* tag`,
          "rule_violation",
          call("git.createRef", "POST", "/git/refs", token, { ref: `refs/${newTag}`, sha: h1 }),
          unmoved(newTag, null),
        ),
        probe(
          `${who} can't move ${releaseRef.slice("tags/".length)}`,
          "rule_violation",
          call("git.updateRef", "PATCH", `/git/refs/${refPath(releaseRef)}`, token, {
            sha: h1,
            force: true,
          }),
          unmoved(releaseRef, releaseTag.object.sha),
        ),
        ...input.rulesets.flatMap(({ id, desired }) => [
          // Reading a ruleset needs only Metadata, which every token has, so the read is allowed;
          // what matters is that GitHub says this token can never bypass it.
          call("repos.ruleset", "GET", `/rulesets/${id}`, token).pipe(
            Effect.map((answer) => {
              const body = decodeRulesetRead(answer.body);
              const canBypass =
                body._tag === "Some"
                  ? (body.value.current_user_can_bypass ?? "absent")
                  : "unreadable";
              const pass =
                isKinBlock(answer, "refused") ||
                (answer.status === 200 &&
                  canBypass === "never" &&
                  body._tag === "Some" &&
                  (body.value.bypass_actors ?? []).length === 0);
              return {
                pass,
                line: `${who} can't bypass ${desired.name} (HTTP ${answer.status}, current_user_can_bypass ${canBypass})`,
                rateLimited: isGitHubRateLimit(answer),
              };
            }),
          ),
          probe(
            `${who} can't read ${desired.name}'s history`,
            "refused",
            call("repos.rulesetHistory", "GET", `/rulesets/${id}/history`, token),
          ),
          // The desired body, so even a wrongly accepted write changes nothing.
          probe(
            `${who} can't change ${desired.name}`,
            "refused",
            call("repos.updateRuleset", "PUT", `/rulesets/${id}`, token, desired),
          ),
        ]),
      ]),
      approve(h1),
      reportedAs(h1, "clean"),
    ];

    let limited = false;
    const runSteps = Effect.fn("kinRulesets.test23.steps")(function* (
      list: ReadonlyArray<Effect.Effect<Step, KinGitHubRequestError>>,
    ) {
      for (const step of list) {
        const { pass, line, rateLimited } = yield* step;
        if (rateLimited) {
          lines.push(`  WAIT ${line}: GitHub rate-limited this call, so it proves nothing`);
          limited = true;
          return false;
        }
        lines.push(`  ${pass ? "PASS" : "FAIL"} ${line}`);
        if (!pass) return false;
      }
      return true;
    });
    const stopped = () => ({
      ok: false,
      rateLimited: limited,
      lines: [
        ...lines,
        limited ? "Stopped at the rate limit." : "FAIL: stopped at the first failure.",
      ],
    });
    if (!(yield* runSteps(steps))) return stopped();

    // Bait and switch: a push after the owner's approval must dismiss it.
    const h2 = yield* botCommit(`${stamp}-after-review.md`);
    lines.push(
      `  ${h2 === null ? "FAIL" : "PASS"} the bot pushes ${h2?.slice(0, 7) ?? "nothing"} after the review`,
    );
    if (h2 === null) return stopped();
    const dismissed: Effect.Effect<Step, KinGitHubRequestError> = read(
      "pulls.reviews",
      `${pullRoute}/reviews?per_page=100`,
      Reviews,
    ).pipe(
      Effect.map((reviews) => {
        const review = reviews.find(
          (one) =>
            one.commit_id === h1 && one.user?.login.toLowerCase() === input.owner.toLowerCase(),
        );
        return {
          pass: review?.state === "DISMISSED",
          line: `the push dismissed ${input.owner}'s review (${review?.state ?? "no review found"})`,
        };
      }),
    );
    const merged = mergeAs(input.mergeToken, h2).pipe(
      Effect.map((answer) => {
        state.merged = answer.status === 200;
        return {
          pass: state.merged,
          line: `after ${input.owner} approves the new head the merge token merges (${describe(answer)}), so the blocks came from the rules`,
          rateLimited: isGitHubRateLimit(answer),
        };
      }),
    );
    if (
      !(yield* runSteps([
        checksPass(h2),
        reportedAs(h2, "blocked"),
        dismissed,
        probe(
          "the merge token can't merge the switched head",
          "review_required",
          mergeAs(input.mergeToken, h2),
        ),
        approve(h2),
        reportedAs(h2, "clean"),
        merged,
      ]))
    ) {
      return stopped();
    }
    return { ok: true, rateLimited: false, lines };
  });

  const cleanupLines: Array<string> = [];
  const attempt = (
    name: string,
    request: Effect.Effect<GitHubAnswer, KinGitHubRequestError>,
    ok: ReadonlyArray<number>,
  ) =>
    request.pipe(
      Effect.map((answer) => (ok.includes(answer.status) ? null : describe(answer))),
      Effect.orElseSucceed(() => "GitHub unreachable"),
      Effect.map((problem) => {
        if (problem !== null) cleanupLines.push(`  WARN cleanup: couldn't ${name} (${problem})`);
      }),
    );
  const cleanup = Effect.gen(function* () {
    if (!state.merged && state.pull !== undefined) {
      yield* attempt(
        `close PR #${state.pull}`,
        call("pulls.update", "PATCH", `/pulls/${state.pull}`, input.botToken, { state: "closed" }),
        [200],
      );
    }
    // 422 when GitHub already deleted the merged branch.
    yield* attempt(
      `delete ${branch}`,
      call("git.deleteRef", "DELETE", `/git/refs/${refPath(`heads/${branch}`)}`, input.botToken),
      [204, 422],
    );
    if (state.tagCreated) {
      yield* attempt(
        `delete ${newTag}`,
        call("git.deleteRef", "DELETE", `/git/refs/${refPath(newTag)}`, input.ownerToken),
        [204],
      );
    }
    if (state.tagMoved) {
      yield* attempt(
        `move ${releaseRef} back to ${releaseTag.object.sha.slice(0, 7)}`,
        call("git.updateRef", "PATCH", `/git/refs/${refPath(releaseRef)}`, input.ownerToken, {
          sha: releaseTag.object.sha,
          force: true,
        }),
        [200],
      );
    }
  });
  const result = yield* run.pipe(
    Effect.ensuring(cleanup),
    Effect.tapError(() => Effect.logWarning("Test 23 cleanup", { lines: cleanupLines })),
  );
  return {
    ok: result.ok,
    rateLimited: result.rateLimited,
    lines: [...result.lines, ...cleanupLines],
  };
});
