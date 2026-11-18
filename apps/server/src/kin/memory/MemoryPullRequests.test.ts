import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { ghApiOutput, ghApiStderr } from "../github/fakeGitHub.ts";
import { KinGitHubApi, parseGhApi } from "../github/GitHubWatch.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import { FIXTURE_QUOTE, FIXTURE_SAID, fixtureItem } from "./__fixtures__/items.ts";
import * as Memory from "./Memory.ts";
import { githubRepoOf, MemoryConfig } from "./MemoryConfig.ts";
import * as Lander from "./MemoryLander.ts";
import * as PullRequests from "./MemoryPullRequests.ts";
import * as Writer from "./MemoryWriter.ts";
import * as Scan from "./secretScan.ts";

const orgId = KinOrgId.make("fixture-org");
const agentId = KinAgentId.make("fixture-lead");
const repo = "GLDRoger/kin-memory-fixture";
const gitLayer = Vcs.layer.pipe(Layer.provide(NodeServices.layer));

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  /** Who Kin called GitHub as: its GitHub App or the owner's login. */
  readonly as?: "app" | "owner";
}
interface FakeAnswer {
  /** Never answers, like a `gh` call GitHub leaves hanging. */
  readonly hang?: true;
  /** Sends the status and headers, then never the body; `gh` never returns either. */
  readonly stallBody?: true;
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

it.each([
  ["git@github.com:GLDRoger/kin-memory.git", "GLDRoger/kin-memory"],
  ["https://github.com/GLDRoger/kin-memory", "GLDRoger/kin-memory"],
  ["ssh://git@github.com/GLDRoger/kin.memory.git", "GLDRoger/kin.memory"],
  ["git@gitlab.com:GLDRoger/kin-memory.git", undefined],
  ["https://github.com/GLDRoger/kin-memory/extra", undefined],
  ["/srv/memory.git", undefined],
  ["https://user:token@github.com/GLDRoger/kin-memory.git", "GLDRoger/kin-memory"],
  ["https://www.github.com/GLDRoger/kin-memory/", "GLDRoger/kin-memory"],
  ["https://github.com.evil.test/GLDRoger/kin-memory", undefined],
])("finds the GitHub repo of %s", (url, slug) => {
  expect(githubRepoOf(url)).toBe(slug);
});

const scenarios = [
  "merged",
  "rerun",
  "foreign-check",
  "forged-in-suite",
  "run-wrong-sha",
  "run-wrong-event",
  "run-wrong-branch",
  "run-wrong-pr",
  "run-wrong-base",
  "truncated",
  "second-pr",
  "pulls-truncated",
  "base-changed",
  "events-truncated",
  "moved-head",
  "check-failed",
  "check-pending",
  "merge-rejected",
  "owner-path",
  "hang",
  "stall-body",
  "run-from-fork",
  "no-pull-requests",
  "batched",
  "restart",
  "repeat-edit",
  "owner-edit",
  "owner-conflict",
  "first-run",
  "land-fails",
  "sync-fetch",
  "crash-owner-correction",
  "crash-beyond-search",
  "decision-then-journal",
  "code-owner-refusal",
  "guard-rails-upgrade",
  "review-leftovers",
] as const;

// GitHub's own answer, byte for byte, to a merge that waits on a code owner (invented login).
const codeOwnerRefusal = {
  status: 405,
  body: {
    message:
      "Repository rule violations found\n\nWaiting on code owner review from octo-owner.\n\n",
    documentation_url: "https://docs.github.com/rest/pulls/pulls#merge-a-pull-request",
    status: "405",
  },
};
// What a memory repo set up before Kin wrote every memory folder alone holds.
const oldCodeowners = "* @octo-owner\n/commitments/\n/deferrals/\n/claims/\n/journal/\n/INDEX.md\n";
const oldPin = "1".repeat(40);
const buildCommit = "2".repeat(40);
// GitHub applies a CODEOWNERS' last matching line: `*`, `/folder/` or `/file`.
const codeOwnersOf = (codeowners: string, path: string) => {
  let owners: ReadonlyArray<string> = [];
  for (const line of codeowners.split("\n")) {
    const [pattern, ...named] = line.split("#")[0]!.trim().split(/\s+/);
    if (!pattern) continue;
    const matches =
      pattern === "*" ||
      (pattern.endsWith("/") ? path.startsWith(pattern.slice(1)) : path === pattern.slice(1));
    if (matches) owners = named;
  }
  return owners;
};

// `it.effect`: real git, but GitHub's silences only end when the test clock moves.
it.effect.each(scenarios)("memory writes through PRs: %s", (scenario) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.UTC(2026, 10, 9));
    const fs = yield* FileSystem.FileSystem;
    const vcs = yield* Vcs.VcsProcess;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const source = `${root}/seed`;
    const remote = `${root}/remote.git`;
    const git = (cwd: string, args: ReadonlyArray<string>) =>
      vcs
        .run({ operation: "test.memoryPullRequests", command: "git", cwd, args })
        .pipe(Effect.map((result) => result.stdout.trim()));
    const bare = (...args: ReadonlyArray<string>) => git(root, [`--git-dir=${remote}`, ...args]);
    const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
    yield* fs.makeDirectory(source);
    yield* git(source, ["init", "-b", "main"]);
    yield* fs.writeFileString(`${source}/rules.md`, "Invented rules\n");
    yield* fs.writeFileString(`${source}/INDEX.md`, "As of 2026-11-08T00:00:00.000Z\n");
    // The templates as this commit ships them, installed for an invented owner.
    const path = yield* Path.Path;
    const ops = path.join(
      yield* path.fromFileUrl(new URL(".", import.meta.url)),
      "../../../../../ops/kin/memory-repo",
    );
    const template = yield* fs.readFileString(`${ops}/CODEOWNERS.template`);
    const installed = template.replace("* @OWNER", "* @octo-owner");
    const workflow = (pin: string) =>
      fs
        .readFileString(`${ops}/memory-check.yml`)
        .pipe(Effect.map((text) => text.replace('"<t3code commit SHA>"', `"${pin}"`)));
    const guarded = ["decision-then-journal", "code-owner-refusal", "guard-rails-upgrade"].includes(
      scenario,
    );
    if (guarded) {
      yield* fs.makeDirectory(`${source}/.github/workflows`, { recursive: true });
      yield* fs.writeFileString(
        `${source}/.github/CODEOWNERS`,
        scenario === "decision-then-journal" ? installed : oldCodeowners,
      );
      yield* fs.writeFileString(
        `${source}/.github/workflows/memory-check.yml`,
        yield* workflow(scenario === "decision-then-journal" ? buildCommit : oldPin),
      );
    }
    yield* git(source, ["add", "--", "."]);
    yield* git(source, [...identity, "commit", "-m", "fixture"]);
    yield* git(root, ["clone", "--bare", "--", source, remote]);
    const original = yield* bare("rev-parse", "refs/heads/main");

    // A GitHub over the bare remote: it squash-merges there, as the real one would.
    const pulls = new Map<number, { branch: string; state: string; base: string; sha?: string }>();
    const merges: Array<{ number: number; body: unknown }> = [];
    // The request GitHub never answers in `hang` and `stall-body`.
    const silenced = yield* Deferred.make<void>();
    let stalls = 0;
    let jobsListed = false;
    // memory-check stays pending on the first PR until the test releases it.
    const heldInCi = ["batched", "repeat-edit", "owner-edit", "owner-conflict"].includes(scenario);
    const firstPoll = yield* Deferred.make<void>();
    let ciDone = false;
    // GitHub refuses new PRs until the server restarts.
    let createFails = scenario === "restart" || scenario === "first-run";
    // PRs the owner approved on GitHub; the sha each run of memory-check was listed for.
    const approved = new Set<number>();
    let checkedSha: string | undefined;
    const journalPath = "journal/2026/11-08.md";
    // The owner changes memory on GitHub itself, as a PR of their own would once merged.
    let ownerHead: string | undefined;
    const ownerCommits = (files: Record<string, (current: string) => string>) =>
      Effect.gen(function* () {
        yield* git(source, ["fetch", "--", remote, "main"]);
        yield* git(source, ["reset", "--hard", "FETCH_HEAD"]);
        for (const [path, edit] of Object.entries(files)) {
          const file = `${source}/${path}`;
          yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
          const current = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
          yield* fs.writeFileString(file, edit(current));
        }
        yield* git(source, ["add", "--", "."]);
        yield* git(source, [...identity, "commit", "-m", "owner edit"]);
        yield* git(source, ["push", "--", remote, "HEAD:main"]);
        ownerHead = yield* git(source, ["rev-parse", "HEAD"]);
      });
    // `sync-fetch` holds every read of GitHub's head; `land-fails` breaks the batch commit.
    const fetching = yield* Deferred.make<void>();
    const fetchReleased = yield* Deferred.make<void>();
    let holdFetch = false;
    const attempting = yield* Deferred.make<void>();
    const attemptReleased = yield* Deferred.make<void>();
    let failLanding = scenario === "land-fails";
    // The server stops after GitHub squash-merges, before it records what landed.
    const crashes = scenario === "crash-owner-correction" || scenario === "crash-beyond-search";
    let crashBeforeRecord = crashes;
    const crashed = yield* Deferred.make<void>();
    const gatedGit = Layer.succeed(
      Vcs.VcsProcess,
      Vcs.VcsProcess.of({
        run: Effect.fn("test.memoryPullRequests.gatedGit")(function* (input) {
          if (holdFetch && input.args.includes("ls-remote")) {
            yield* Deferred.succeed(fetching, undefined);
            yield* Deferred.await(fetchReleased);
          }
          if (
            crashBeforeRecord &&
            input.args.includes("update-ref") &&
            input.args.includes(Memory.LANDED_REF)
          ) {
            crashBeforeRecord = false;
            yield* Deferred.succeed(crashed, undefined);
            return yield* Effect.never;
          }
          if (failLanding && input.stdin?.startsWith("kin: memory from this server")) {
            yield* Deferred.succeed(attempting, undefined);
            yield* Deferred.await(attemptReleased);
            return yield* Effect.die("fixture: the disk is full");
          }
          return yield* vcs.run(input);
        }),
      }),
    );
    const branchHead = (branch: string) => bare("rev-parse", `refs/heads/${branch}`);
    const pullBody = (number: number) =>
      Effect.gen(function* () {
        const pull = pulls.get(number)!;
        return {
          number,
          html_url: `https://github.com/${repo}/pull/${number}`,
          state: pull.state,
          head: {
            sha: pull.sha ?? (yield* branchHead(pull.branch)),
            ref: pull.branch,
            repo: { full_name: repo },
          },
          base: { ref: pull.base },
        };
      });
    const route = (request: RecordedRequest): Effect.Effect<FakeAnswer> =>
      Effect.gen(function* () {
        const path = request.path.slice(`/repos/${repo}`.length);
        const query = new URL(path, "https://github.invalid").searchParams;
        const body = request.body as Record<string, string> | undefined;
        if (request.method === "POST" && path === "/pulls") {
          if (createFails) return { status: 500, body: { message: "Server Error" } };
          if (scenario === "hang") {
            yield* Deferred.succeed(silenced, undefined);
            return { status: 0, hang: true as const };
          }
          const number = pulls.size + 1;
          pulls.set(number, { branch: body!.head!, state: "open", base: body!.base! });
          // Another PR from Kin's branch, into a base with its own `memory-check.yml`.
          if (scenario === "second-pr")
            pulls.set(number + 1, { branch: body!.head!, state: "closed", base: "attacker" });
          return { status: 201, body: yield* pullBody(number) };
        }
        if (request.method === "GET" && path.startsWith("/pulls?") && query.has("head")) {
          const branch = query.get("head")!.slice(`${repo.split("/")[0]}:`.length);
          const listed = [...pulls].filter(
            ([, pull]) =>
              pull.branch === branch && (query.get("state") === "all" || pull.state === "open"),
          );
          return {
            status: 200,
            body: yield* Effect.forEach(listed, ([number]) => pullBody(number)),
            ...(scenario === "pulls-truncated" && query.get("state") === "all"
              ? { headers: { link: `<https://api.github.com${request.path}&page=2>; rel="next"` } }
              : {}),
          };
        }
        const events = /^\/issues\/(\d+)\/events\?/.exec(path);
        if (events) {
          const labeled = Array.from({ length: 100 }, () => ({ event: "labeled" }));
          return {
            status: 200,
            body:
              scenario === "events-truncated"
                ? labeled
                : // Moved to an attacker's base for a run, then back, while Kin polled.
                  scenario === "base-changed" && jobsListed
                  ? [{ event: "base_ref_changed" }, { event: "base_ref_changed" }]
                  : [],
          };
        }
        const pull = /^\/pulls\/(\d+)(\/merge)?$/.exec(path);
        if (pull) {
          const number = Number(pull[1]);
          const state = pulls.get(number)!;
          if (request.method === "PATCH") {
            state.state = body!.state!;
            return { status: 200, body: yield* pullBody(number) };
          }
          if (request.method === "GET") {
            if (scenario === "moved-head")
              yield* bare("update-ref", `refs/heads/${state.branch}`, original);
            return { status: 200, body: yield* pullBody(number) };
          }
          merges.push({ number, body });
          const head = yield* branchHead(state.branch);
          if (scenario === "merge-rejected")
            return { status: 405, body: { message: "Required status check is expected." } };
          if (body!.sha !== head)
            return { status: 409, body: { message: "Head branch was modified." } };
          const parent = yield* bare("rev-parse", "refs/heads/main");
          // The ruleset requires a code owner's review, read from the base branch's CODEOWNERS.
          const rules = yield* bare("show", `${parent}:.github/CODEOWNERS`).pipe(
            Effect.orElseSucceed(() => ""),
          );
          const changed = (yield* bare("diff", "--name-only", parent, head)).split("\n");
          if (
            !approved.has(number) &&
            changed.some((file) => file !== "" && codeOwnersOf(rules, file).length > 0)
          )
            return codeOwnerRefusal;
          const squash = yield* bare(
            ...identity,
            "commit-tree",
            `${head}^{tree}`,
            "-p",
            parent,
            "-m",
            body!.commit_title!,
            "-m",
            body!.commit_message!,
          );
          yield* bare("update-ref", "refs/heads/main", squash, parent);
          state.state = "closed";
          // Right after the first batch merges, before Kin reads GitHub again.
          if (merges.length === 1 && scenario === "owner-edit")
            yield* ownerCommits({
              "claims/owner.md": () =>
                fixtureItem({ id: "owner", kind: "claim", title: "Claim owner", links: [] }),
              [journalPath]: (current) => `${current}\n## Owner note\n`,
            });
          if (merges.length === 1 && scenario === "owner-conflict")
            yield* ownerCommits({
              "claims/new.md": (current) =>
                current.replace("Claim new", "Claim the owner reworded"),
            });
          return { status: 200, body: { merged: true, sha: squash } };
        }
        if (request.method === "GET" && /^\/pulls\?state=open&per_page=/.test(path)) {
          // Newest first, one page.
          const open = [...pulls]
            .filter(([, pull]) => pull.state === "open")
            .toSorted(([a], [b]) => b - a)
            .slice(0, Number(query.get("per_page")));
          return {
            status: 200,
            body: yield* Effect.forEach(open, ([number]) => pullBody(number)),
          };
        }
        const pullOf = (sha: string) =>
          Effect.gen(function* () {
            // A merged PR's branch is deleted, so it has no head left to match.
            for (const [number, pull] of pulls)
              if ((yield* branchHead(pull.branch).pipe(Effect.option)).pipe(Option.contains(sha)))
                return { number, branch: pull.branch };
            return yield* Effect.die(`no PR has ${sha}`);
          });
        const runs = /^\/actions\/runs\?head_sha=([a-f0-9]+)&event=pull_request/.exec(path);
        if (runs) {
          const sha = runs[1]!;
          checkedSha = sha;
          const pull = yield* pullOf(sha);
          const run = (id: number, workflow: string) => ({
            id,
            path: `.github/workflows/${workflow}`,
            event: "pull_request",
            head_sha: sha,
            head_branch: pull.branch,
            head_repository: { full_name: repo },
            pull_requests: [{ number: pull.number, base: { ref: "main" } }],
          });
          const ours = run(10, "memory-check.yml");
          return {
            status: 200,
            body: {
              total_count: 2,
              workflow_runs: [
                {
                  ...ours,
                  ...(scenario === "run-wrong-sha" ? { head_sha: original } : {}),
                  ...(scenario === "run-wrong-event" ? { event: "push" } : {}),
                  ...(scenario === "run-wrong-branch" ? { head_branch: "kin/write/other" } : {}),
                  ...(scenario === "run-from-fork"
                    ? { head_repository: { full_name: "attacker/memory" } }
                    : {}),
                  ...(scenario === "run-wrong-pr"
                    ? { pull_requests: [{ number: 99, base: { ref: "main" } }] }
                    : {}),
                  ...(scenario === "run-wrong-base"
                    ? { pull_requests: [{ number: pull.number, base: { ref: "dev" } }] }
                    : {}),
                },
                // Any workflow in the repo can name a job `memory-check`.
                run(20, "other.yml"),
              ],
            },
          };
        }
        const jobs = /^\/actions\/runs\/(\d+)\/jobs\?/.exec(path);
        if (jobs) {
          jobsListed = true;
          const pending = scenario === "check-pending" || (heldInCi && !ciDone);
          // `check-failed` fails only the first PR, so a later commit's attempt can land.
          const failed = scenario === "check-failed" && pulls.size === 1;
          const job = (id: number) =>
            Effect.succeed({
              id,
              name: "memory-check",
              // The commit whose runs Kin just listed.
              head_sha: checkedSha!,
              status: pending ? "in_progress" : "completed",
              conclusion: pending ? null : failed ? "failure" : "success",
            });
          // An Actions job's id is its check run's id.
          const ids = jobs[1] !== "10" ? [200] : scenario === "rerun" ? [100, 101] : [100];
          // A re-run's earlier attempts are listed only with `filter=all`.
          const listed = query.get("filter") === "all" ? ids : ids.slice(-1);
          const answered = yield* Effect.forEach(listed, job);
          // The poll's git reads are done, so moving the test clock times out no subprocess.
          if (pending) yield* Deferred.succeed(silenced, undefined);
          if (pending && heldInCi) yield* Deferred.succeed(firstPoll, undefined);
          return { status: 200, body: { total_count: listed.length, jobs: answered } };
        }
        const checks = /^\/commits\/([a-f0-9]+)\/check-runs\?(.*)$/.exec(path);
        if (checks) {
          // Only the first attempt stalls, so the retry after the sweep can land.
          if (scenario === "stall-body" && stalls++ === 0) {
            yield* Deferred.succeed(silenced, undefined);
            return { status: 200, stallBody: true as const };
          }
          const check = (id: number, suite: number) => ({
            id,
            name: "memory-check",
            head_sha: checks[1],
            app: { id: 15368 },
            check_suite: { id: suite },
          });
          const all = [
            // Posted by another branch's workflow through the checks API, into our run's suite.
            ...(scenario === "forged-in-suite" ? [check(300, 1)] : []),
            check(100, 1),
            ...(scenario === "rerun" ? [check(101, 1)] : []),
            ...(scenario === "foreign-check" ? [check(200, 2)] : []),
          ];
          // GitHub's default `filter=latest` keeps only the newest run per name in each suite.
          const listed = checks[2]!.split("&").includes("filter=all")
            ? all
            : all.filter(
                (run, index) =>
                  !all
                    .slice(index + 1)
                    .some((later) => later.check_suite.id === run.check_suite.id),
              );
          return {
            status: 200,
            body: {
              total_count: listed.length + (scenario === "truncated" ? 1 : 0),
              check_runs: listed,
            },
          };
        }
        if (request.method === "POST" && /^\/issues\/\d+\/comments$/.test(path))
          return { status: 201, body: {} };
        return { status: 404, body: { message: "Not Found" } };
      }).pipe(Effect.orDie);
    // GitHub as the owner's `gh` login, or as Kin's GitHub App in `merged`, over `route`.
    const asApp = scenario === "merged";
    const github = { requests: [] as Array<RecordedRequest> };
    const callAs =
      (as: "app" | "owner"): KinGitHubApi["Service"]["call"] =>
      (request) =>
        Effect.gen(function* () {
          const recorded = {
            method: request.method ?? "GET",
            path: `/${request.path}`,
            body: request.body,
            as,
          };
          github.requests.push(recorded);
          const answer = yield* route(recorded);
          if (answer.hang === true || answer.stallBody === true) return yield* Effect.never;
          const sent = {
            status: answer.status,
            headers: answer.headers ?? {},
            body: answer.body ?? null,
          };
          // The owner's `gh` prints its error line straight after the body; the App reads plain HTTP.
          if (as === "owner")
            return parseGhApi(ghApiOutput(sent) + ghApiStderr(request.path, sent));
          return { ...sent, text: "" };
        });
    // With the App installed on the memory repo, Kin lands memory without the owner's login.
    const api = Layer.succeed(
      KinGitHubApi,
      KinGitHubApi.of({
        connected: () => Effect.succeed(asApp ? null : { login: "owner", orgs: [] }),
        call: callAs("owner"),
      }),
    );
    const app = Layer.succeed(KinGitHubApp, {
      state: () => Effect.succeed({ _tag: "none" }),
      on: () => Effect.succeed({ login: "invented-kin[bot]", call: callAs("app") }),
      refresh: () => Effect.void,
      lookAgain: () => Effect.void,
    });
    const pullRequests = Layer.effect(
      PullRequests.MemoryPullRequests,
      PullRequests.make({
        pollInterval: scenario === "check-pending" ? "20 minutes" : heldInCi ? "1 minute" : 0,
      }),
    ).pipe(Layer.provide(api), Layer.provide(asApp ? app : Layer.empty));

    const notices: Array<{ branch: string; reason: string; owner?: string }> = [];
    const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
      notify: (notice) => Effect.sync(() => void notices.push(notice)),
    });
    const config = Layer.succeed(MemoryConfig, {
      baseDirectory: root,
      ...(scenario === "code-owner-refusal" ? {} : { buildCommit }),
      repositories: [{ orgId, repoUrl: remote, path: "state", githubRepo: repo }],
    });
    const auth = Layer.succeed(Writer.MemoryWriterAuthority, {
      resolve: (_org, wakeupId) =>
        Effect.succeed({
          orgId,
          wakeupId,
          agentId: wakeupId.startsWith("lead2-") ? KinAgentId.make("fixture-lead-2") : agentId,
          level: "L1",
          timeZone: "UTC",
          startedAt: "2026-11-08T00:00:00.000Z",
          eventIds: [],
          sources: new Map([
            [
              "owner",
              {
                saidBy: "fixture-owner",
                trust: "owner" as const,
                source: "fixture-owner-message",
                text: FIXTURE_SAID,
              },
            ],
          ]),
        }),
    });
    const outcomes = yield* Queue.unbounded<Lander.LandingOutcome>();
    const landerHooks = Layer.succeed(Lander.MemoryLanderHooks, {
      settled: (_org, outcome) => Queue.offer(outcomes, outcome).pipe(Effect.asVoid),
    });
    const memoryLayer = Memory.layer.pipe(Layer.provide(config), Layer.provide(recovery));
    // Built again by each `Effect.provide`, so a second run is a server restart on the same state.
    const writerLayer = Writer.layer.pipe(
      Layer.provideMerge(memoryLayer),
      Layer.provide(scenario === "no-pull-requests" ? Layer.empty : pullRequests),
      Layer.provide(recovery),
      Layer.provide(config),
      Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
      Layer.provide(auth),
      Layer.provide(Scan.layer),
      Layer.provide(landerHooks),
      Layer.provide(gatedGit),
    );
    // The first landing run that did something; runs with nothing to land are skipped.
    const landing = Effect.gen(function* () {
      while (true) {
        const outcome = yield* Queue.take(outcomes);
        if (outcome._tag !== "idle") return outcome;
      }
    });
    // A run that found nothing left to land, once the last merge was folded back in.
    const settled = Effect.gen(function* () {
      while ((yield* Queue.take(outcomes))._tag !== "idle");
    });
    const claim = (id: string) => ({
      path: `claims/${id}.md`,
      content: fixtureItem({
        id,
        kind: "claim",
        title: `Claim ${id}`,
        links: [],
        quote: FIXTURE_QUOTE,
      }),
      sourceEventId: "owner",
    });

    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const writer = yield* Writer.MemoryWriter;
      const lander = yield* Lander.MemoryLander;
      // The start-up run finds nothing to land yet; later outcomes then come in order.
      if (scenario !== "no-pull-requests") yield* settled;
      const paths = yield* memory.ensureCheckouts(orgId);
      yield* memory.prepareWakeup(orgId);
      const localMain = () => git(paths.writer, ["rev-parse", "refs/heads/main"]);
      const remoteFiles = (ref: string) => bare("ls-tree", "-r", "--name-only", ref);
      const notMerged = () =>
        notices.filter((notice) => notice.reason.startsWith("Memory write not merged"));
      const decision = (id: string) => ({
        itemId: KinMemoryItemId.make(id),
        title: "Which courier for the invented samples?",
        body: "Chose the invented courier.",
        saidBy: "fixture-owner",
        trust: "owner" as const,
        source: "kin:chat:chat-1:message:message-1",
        chat: KinChatId.make("chat-1"),
        link: "card:widget-1",
      });
      // A wake-up that writes only its journal entry.
      const journal = (wakeupId: string) => writer.commitWakeup(orgId, wakeupId, "completed");
      const opened = () =>
        github.requests.filter(
          (request) => request.method === "POST" && request.path === `/repos/${repo}/pulls`,
        ).length;
      const toldOwner = () => notices.flatMap((notice) => notice.owner ?? []);

      if (scenario === "decision-then-journal") {
        // A decision saved by code, then a wake-up's journal: both land, no review asked.
        expect(yield* writer.recordDecision(orgId, decision("decision-0001"))).toEqual({
          recorded: true,
        });
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* journal("wake1");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        const landed = yield* remoteFiles("main");
        expect(landed).toContain("decisions/decision-0001.md");
        expect(landed).toContain(journalPath);
        expect(opened()).toBe(2);
        expect(notices).toEqual([]);
        return;
      }

      if (scenario === "code-owner-refusal") {
        yield* writer.recordDecision(orgId, decision("decision-0001"));
        expect(yield* landing).toMatchObject({
          _tag: "stuck",
          reason: expect.stringContaining("Waiting on code owner review from octo-owner."),
        });
        expect(opened()).toBe(1);
        expect(pulls.get(1)?.state).toBe("closed");
        // Later memory is saved here and waits behind the same cause: no PR per change.
        for (const wakeupId of ["wake1", "wake2", "wake3"]) {
          yield* journal(wakeupId);
          expect(yield* landing).toEqual({ _tag: "waiting" });
        }
        expect(opened()).toBe(1);
        expect(merges).toHaveLength(1);
        expect(toldOwner()).toEqual([
          expect.stringContaining("Memory is saved here, but GitHub's copy is behind"),
        ]);
        expect(toldOwner()[0]).toContain(`https://github.com/${repo}/pull/1`);
        expect((yield* memory.readItem(orgId, KinMemoryItemId.make("decision-0001"))).head.id).toBe(
          "decision-0001",
        );
        expect(yield* git(paths.writer, ["show", `main:${journalPath}`])).toContain(
          "wake-up wake3",
        );
        // The owner frees the folder on GitHub by hand; that change is what Kin waited for.
        yield* ownerCommits({ ".github/CODEOWNERS": () => installed });
        yield* lander.signal(orgId);
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        expect(yield* remoteFiles("main")).toContain("decisions/decision-0001.md");
        expect(yield* bare("show", `main:${journalPath}`)).toContain("wake-up wake3");
        expect(opened()).toBe(2);
        expect(toldOwner()).toHaveLength(1);
        return;
      }

      if (scenario === "guard-rails-upgrade") {
        // At start, Kin proposed this server's guard rails as one PR, and GitHub wants the owner.
        const [number, upgrade] = [...pulls].find(([, pull]) =>
          pull.branch.startsWith("kin/write/guard-rails/"),
        )!;
        expect(upgrade.state).toBe("open");
        expect(opened()).toBe(1);
        expect(yield* bare("diff", "--name-only", original, upgrade.branch)).toBe(
          ".github/CODEOWNERS\n.github/workflows/memory-check.yml",
        );
        expect(yield* bare("show", `${upgrade.branch}:.github/CODEOWNERS`)).toBe(installed.trim());
        expect(
          yield* bare("show", `${upgrade.branch}:.github/workflows/memory-check.yml`),
        ).toContain(`T3CODE_REF: "${buildCommit}"`);
        expect(toldOwner()).toEqual([
          `Approve one change to the memory repo's rules on GitHub: https://github.com/${repo}/pull/${number}. It lets Kin save every kind of memory there on its own; until then some of it stays on this server only. Kin merges it itself once you approve.`,
        ]);
        const head = yield* branchHead(upgrade.branch);
        // GitHub's old rules refuse a decision; Kin holds it and asks the owner nothing more.
        yield* writer.recordDecision(orgId, decision("decision-0001"));
        expect(yield* landing).toMatchObject({
          _tag: "stuck",
          reason: expect.stringContaining("Waiting on code owner review"),
        });
        yield* journal("wake1");
        expect(yield* landing).toEqual({ _tag: "waiting" });
        expect(opened()).toBe(2);
        expect(toldOwner()).toHaveLength(1);
        // Kin never pushes to the PR again, so the owner's approval would stay.
        expect(yield* branchHead(upgrade.branch)).toBe(head);
        expect(upgrade.state).toBe("open");
        // The owner approves on GitHub; the periodic sweep wakes the lander, which merges it,
        // then lands everything that waited.
        approved.add(number);
        yield* lander.sweep(orgId);
        expect(upgrade.state).toBe("open");
        expect(yield* landing).toEqual({ _tag: "upgraded" });
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        const landed = yield* remoteFiles("main");
        expect(landed).toContain("decisions/decision-0001.md");
        expect(landed).toContain(journalPath);
        expect(yield* bare("show", "main:.github/CODEOWNERS")).toBe(installed.trim());
        expect(opened()).toBe(3);
        yield* lander.signal(orgId);
        yield* settled;
        expect(opened()).toBe(3);
        expect(yield* git(paths.writer, ["for-each-ref", "refs/kin/guard-rails"])).toBe("");
        return;
      }

      if (scenario === "review-leftovers") {
        // As a server from before left them: a review commit under its ref, an open review PR
        // from a commit this server made, and one from a commit it never made.
        const commitWith = (cwd: string, parent: string, file: string, content: string) =>
          Effect.gen(function* () {
            const index = `${root}/leftover-index`;
            const plumb = (args: ReadonlyArray<string>, stdin?: string) =>
              vcs
                .run({
                  operation: "test.memoryPullRequests.leftover",
                  command: "git",
                  cwd,
                  args: [...identity, ...args],
                  env: { GIT_INDEX_FILE: index },
                  ...(stdin === undefined ? {} : { stdin }),
                })
                .pipe(Effect.map((result) => result.stdout.trim()));
            const blob = yield* plumb(["hash-object", "-w", "--stdin"], content);
            yield* plumb(["read-tree", parent]);
            yield* plumb(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
            const tree = yield* plumb(["write-tree"]);
            yield* fs.remove(index);
            return yield* plumb(["commit-tree", tree, "-p", parent, "-m", "kin: review wake-up"]);
          });
        const kept = yield* commitWith(
          paths.writer,
          yield* localMain(),
          "decisions/dec-left.md",
          fixtureItem({ id: "dec-left", kind: "decision", review_by: null }),
        );
        yield* git(paths.writer, [
          "update-ref",
          `refs/kin/review/${agentId}/wake9-0123456789ab`,
          kept,
        ]);
        const opened = yield* commitWith(
          paths.writer,
          original,
          "people/person-left.md",
          fixtureItem({ id: "person-left", kind: "person", review_by: null }),
        );
        const forged = yield* commitWith(
          source,
          original,
          "people/forged.md",
          fixtureItem({ id: "forged", kind: "person", review_by: null }),
        );
        for (const [branch, sha, cwd] of [
          [`kin/write/${agentId}/wake8-0123456789ab-review`, opened, paths.writer],
          ["kin/write/other/forged-review", forged, source],
          // An agent points a review branch at a commit already on the default branch.
          ["kin/write/other/main-review", original, source],
        ] as const) {
          yield* git(cwd, ["push", "--", remote, `${sha}:refs/heads/${branch}`]);
          pulls.set(pulls.size + 1, { branch, state: "open", base: "main" });
        }
        return;
      }

      // The periodic sync is still waiting on GitHub when the lead stages and commits.
      holdFetch = scenario === "sync-fetch";
      const sync =
        scenario === "sync-fetch"
          ? yield* memory.syncCheckout(orgId).pipe(Effect.forkChild)
          : undefined;
      if (sync !== undefined) yield* Deferred.await(fetching);

      yield* writer.stage(orgId, "wake1", claim("new"));
      // A lead's decision rides the same batch: every memory folder is Kin's to write alone.
      if (scenario === "owner-path")
        yield* writer.stage(orgId, "wake1", {
          path: "decisions/dec-001.md",
          content: fixtureItem({
            id: "dec-001",
            kind: "decision",
            review_by: null,
            quote: FIXTURE_QUOTE,
          }),
          sourceEventId: "owner",
        });

      if (scenario === "no-pull-requests") {
        const error = yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MemorySyncConflict" });
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        expect(yield* localMain()).toBe(original);
        expect(yield* bare("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          expect.stringContaining("through a pull request"),
        );
        return;
      }

      // The wake-up's memory is done once it is committed here, whatever GitHub does later.
      const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
      expect(yield* localMain()).toBe(committed.commit);
      expect(yield* memory.anchor(orgId, "main")).toBe(committed.commit);
      expect(yield* git(paths.writer, ["rev-parse", `${committed.commit}^`])).toBe(original);
      if (sync !== undefined) {
        holdFetch = false;
        yield* Deferred.succeed(fetchReleased, undefined);
        yield* Fiber.join(sync);
      }

      // A refused landing undoes nothing: this server keeps the commit and leads read it.
      const kept = Effect.gen(function* () {
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        expect(yield* localMain()).toBe(committed.commit);
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(committed.commit);
        expect((yield* memory.readItem(orgId, KinMemoryItemId.make("new"))).head.id).toBe("new");
      });

      if (crashes) {
        yield* Deferred.await(crashed);
        const landed = yield* bare("show", `main:${journalPath}`);
        expect(landed).toContain("wake-up wake1");
        // The owner corrects the landed entry on GitHub while this server is down.
        yield* ownerCommits({
          [journalPath]: (current) =>
            scenario === "crash-beyond-search"
              ? current
                  .replace("Outcome: completed", "Outcome: corrected by the owner")
                  .replace("wake-up wake1", "wake-up wake1, checked")
              : current.replace("Outcome: completed", "Outcome: corrected by the owner"),
        });
        // Then commits enough on top that the squash is past where Kin looks for it.
        if (scenario === "crash-beyond-search") {
          for (let commit = 0; commit < Memory.LANDED_SEARCH_DEPTH; commit++)
            yield* git(source, [...identity, "commit", "--allow-empty", "-m", `owner ${commit}`]);
          yield* git(source, ["push", "--", remote, "HEAD:main"]);
        }
        return;
      }

      if (scenario === "restart") {
        const outcome = yield* landing;
        expect(outcome).toMatchObject({ _tag: "stuck" });
        yield* kept;
        expect(notMerged()).toHaveLength(1);
        // A crash mid-landing leaves Kin's PR open on GitHub.
        const orphanBranch = "kin/write/land/0123456789ab";
        yield* bare("update-ref", `refs/heads/${orphanBranch}`, original);
        pulls.set(pulls.size + 1, { branch: orphanBranch, state: "open", base: "main" });
        createFails = false;
        return;
      }

      if (scenario === "hang" || scenario === "stall-body") {
        yield* Deferred.await(silenced);
        yield* TestClock.adjust("30 seconds");
        const outcome = yield* landing;
        expect(outcome).toMatchObject({
          _tag: "stuck",
          reason: `could not reach GitHub for ${scenario === "hang" ? "pulls.create" : "checks.list"}`,
        });
        yield* kept;
        // Nothing holds the landing lock now: the sweep closes the PR left open.
        yield* lander.sweep(orgId);
        expect(merges).toEqual([]);
        expect([...pulls.values()].map((pull) => pull.state)).toEqual(
          scenario === "hang" ? [] : ["closed"],
        );
        // A later commit changes the batch, so the lander tries again with a fresh branch.
        if (scenario === "stall-body") {
          yield* writer.stage(orgId, "wake2", claim("later"));
          yield* writer.commitWakeup(orgId, "wake2", "completed");
          expect(yield* landing).toMatchObject({ _tag: "merged" });
          expect(merges.length).toBe(1);
          expect(yield* remoteFiles("main")).toContain("claims/new.md");
          expect(yield* remoteFiles("main")).toContain("claims/later.md");
        }
        return;
      }

      if (scenario === "first-run") {
        expect(yield* landing).toMatchObject({ _tag: "stuck" });
        // As on a server from before the landed record: GitHub holds a squash of this server's
        // commits, with the same tree, and nothing here says so.
        const pushed = yield* bare(
          "for-each-ref",
          "--format=%(objectname)",
          "refs/heads/kin/write/land/",
        );
        const squash = yield* bare(
          ...identity,
          "commit-tree",
          `${pushed}^{tree}`,
          "-p",
          original,
          "-m",
          "squash",
        );
        yield* bare("update-ref", "refs/heads/main", squash, original);
        // And as there, the writer's own index is stale, so git reports staged changes in it.
        yield* fs.writeFileString(`${paths.writer}/INDEX.md`, "stale\n");
        yield* git(paths.writer, ["add", "--", "INDEX.md"]);
        expect(yield* git(paths.writer, ["status", "--porcelain"])).toContain("D  claims/new.md");
        createFails = false;
        return;
      }

      if (scenario === "land-fails") {
        // The first attempt is under way on wake1's commit when wake2 commits.
        yield* Deferred.await(attempting);
        yield* writer.stage(orgId, "wake2", claim("two"));
        yield* writer.commitWakeup(orgId, "wake2", "completed");
        yield* Deferred.succeed(attemptReleased, undefined);
        expect(yield* landing).toMatchObject({ _tag: "stuck" });
        // wake2's commit was never tried, so its signal tries it instead of waiting on wake1's.
        expect(yield* landing).toMatchObject({ _tag: "stuck" });
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        // The owner hears once: memory is only on this server, and the same failure stays quiet.
        expect(notMerged()).toEqual([
          expect.objectContaining({
            reason: expect.stringContaining("Memory is still saved on this server"),
          }),
        ]);
        yield* lander.signal(orgId);
        expect(yield* landing).toEqual({ _tag: "waiting" });
        failLanding = false;
        yield* writer.stage(orgId, "wake3", claim("three"));
        yield* writer.commitWakeup(orgId, "wake3", "completed");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        for (const id of ["new", "two", "three"])
          expect(yield* remoteFiles("main")).toContain(`claims/${id}.md`);
        expect(notMerged()).toHaveLength(1);
        return;
      }

      if (
        scenario === "repeat-edit" ||
        scenario === "owner-edit" ||
        scenario === "owner-conflict"
      ) {
        yield* Deferred.await(firstPoll);
        // memory-check is still running on wake1's batch when wake2 commits.
        yield* writer.stage(
          orgId,
          "wake2",
          scenario === "owner-edit"
            ? claim("two")
            : {
                ...claim("new"),
                content: fixtureItem({
                  id: "new",
                  kind: "claim",
                  title: "Claim new",
                  links: [],
                  status: "done",
                }),
              },
        );
        const second = yield* writer.commitWakeup(orgId, "wake2", "completed");
        ciDone = true;
        yield* TestClock.adjust("1 minute");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        const firstBatch = (merges[0]!.body as { sha: string }).sha;
        expect(yield* bare("show", `${firstBatch}:claims/new.md`)).toContain("status: open");

        if (scenario === "owner-conflict") {
          // The owner reworded the item on GitHub that wake2 closed here: a real conflict.
          expect(yield* landing).toMatchObject({
            _tag: "stuck",
            reason: expect.stringContaining("could not combine"),
          });
          expect(yield* localMain()).toBe(second.commit);
          expect(yield* bare("rev-parse", "refs/heads/main")).toBe(ownerHead);
          expect(pulls.size).toBe(1);
          const told = () =>
            notices.filter((notice) => notice.reason.includes("could not combine"));
          expect(told()).toHaveLength(1);
          yield* lander.signal(orgId);
          expect(yield* landing).toEqual({ _tag: "waiting" });
          expect(told()).toHaveLength(1);
          expect(notices).toHaveLength(1);
          return;
        }

        // wake2's commit is a later local change on top of what landed, not a second writer.
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        expect(merges.map((merge) => merge.number)).toEqual([1, 2]);
        expect(notices).toEqual([]);
        const head = yield* localMain();
        expect(yield* memory.anchor(orgId, "main")).toBe(head);
        // Both wake-ups' own commits are still in local history.
        expect(yield* writer.commitWakeup(orgId, "wake1", "completed")).toEqual(committed);
        expect(yield* writer.commitWakeup(orgId, "wake2", "completed")).toEqual(second);
        const remoteJournal = yield* bare("show", `main:${journalPath}`);
        expect(yield* git(paths.writer, ["show", `${head}:${journalPath}`])).toBe(remoteJournal);
        if (scenario === "repeat-edit") {
          expect(yield* bare("show", "main:claims/new.md")).toContain("status: done");
          expect(remoteJournal.match(/wake-up wake\d/g)).toEqual([
            "wake-up wake1",
            "wake-up wake2",
          ]);
          return;
        }
        // The owner's item and journal note are on both sides, and wake2's entry follows them once.
        expect(yield* remoteFiles("main")).toContain("claims/owner.md");
        expect(yield* remoteFiles("main")).toContain("claims/two.md");
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(head);
        expect((yield* memory.readItem(orgId, KinMemoryItemId.make("owner"))).head.id).toBe(
          "owner",
        );
        expect(remoteJournal.match(/wake-up wake\d|Owner note/g)).toEqual([
          "wake-up wake1",
          "Owner note",
          "wake-up wake2",
        ]);
        return;
      }

      if (scenario === "batched") {
        yield* Deferred.await(firstPoll);
        // memory-check is still running on wake1's batch: another lead prepares and commits,
        // and two more wake-ups commit, none of them waiting on GitHub.
        yield* memory.prepareWakeup(orgId, "lead2-wake2", {
          lead: KinAgentId.make("fixture-lead-2"),
        });
        for (const [wakeupId, id] of [
          ["lead2-wake2", "two"],
          ["wake3", "three"],
          ["wake4", "four"],
        ] as const) {
          yield* writer.stage(orgId, wakeupId, claim(id));
          yield* writer.commitWakeup(orgId, wakeupId, "completed");
        }
        expect(merges).toEqual([]);
        expect(pulls.size).toBe(1);
        ciDone = true;
        yield* TestClock.adjust("1 minute");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        // The three commits went out together, as one later batch.
        expect(pulls.size).toBe(2);
        expect(merges.map((merge) => merge.number)).toEqual([1, 2]);
        const second = yield* remoteFiles(`${(merges[1]!.body as { sha: string }).sha}`);
        for (const id of ["new", "two", "three", "four"])
          expect(second).toContain(`claims/${id}.md`);
        const main = yield* bare("rev-parse", "refs/heads/main");
        expect(yield* bare("rev-list", "--count", `${original}..${main}`)).toBe("2");
        expect(yield* memory.anchor(orgId, "main")).toBe(yield* localMain());
        expect(notices).toEqual([]);
        return;
      }

      if (
        scenario !== "owner-path" &&
        scenario !== "merged" &&
        scenario !== "rerun" &&
        scenario !== "sync-fetch"
      ) {
        const foreign = "did not come from .github/workflows/memory-check.yml";
        if (scenario === "check-pending") {
          yield* Deferred.await(silenced);
          // The 15-minute deadline ends the wait mid-poll; the second poll is 5 minutes later.
          yield* TestClock.adjust("15 minutes");
        }
        const outcome = yield* landing;
        if (scenario === "check-pending")
          expect(
            github.requests.filter((request) => request.path.includes("/check-runs?")),
          ).toHaveLength(1);
        yield* kept;
        expect(merges.length).toBe(scenario === "merge-rejected" ? 1 : 0);
        expect(pulls.get(1)?.state).toBe("closed");
        // A PR from Kin's branch that isn't this one fails before Kin reads any run.
        if (scenario === "second-pr")
          expect(github.requests.map((request) => request.path)).not.toContainEqual(
            expect.stringContaining("/actions/runs"),
          );
        expect(github.requests).toContainEqual(
          expect.objectContaining({ method: "POST", path: `/repos/${repo}/issues/1/comments` }),
        );
        // One notice in the owner's chat: still saved here, GitHub's copy stuck, and why.
        expect(notMerged()).toEqual([
          expect.objectContaining({
            reason: expect.stringContaining(`https://github.com/${repo}/pull/1`),
          }),
        ]);
        expect(notMerged()[0]?.reason).toContain("Memory is still saved on this server");
        expect(outcome).toMatchObject({
          _tag: "stuck",
          reason: expect.stringContaining(
            {
              "foreign-check": foreign,
              "forged-in-suite": foreign,
              "run-wrong-sha": foreign,
              "run-wrong-event": foreign,
              "run-wrong-branch": foreign,
              "run-from-fork": foreign,
              "run-wrong-pr": foreign,
              "run-wrong-base": foreign,
              truncated: "GitHub listed more check runs than one page holds",
              "second-pr": "another PR was opened from Kin's branch",
              "pulls-truncated": "GitHub listed more PRs from Kin's branch than one page holds",
              "base-changed": "the PR's base branch was changed",
              "events-truncated": "GitHub listed more PR events than one page holds",
              "moved-head": "head is not the commit Kin pushed",
              "check-failed": "memory-check failed",
              "check-pending": "did not finish in time",
              "merge-rejected":
                "GitHub refused the merge (HTTP 405: Required status check is expected.)",
            }[scenario],
          ),
        });
        if (scenario === "check-failed") {
          // Stuck on this head: a signal with nothing new tries nothing.
          yield* lander.signal(orgId);
          expect(yield* landing).toEqual({ _tag: "waiting" });
          // A later commit changes the batch, and it lands with the refused one's content.
          yield* writer.stage(orgId, "wake2", claim("later"));
          yield* writer.commitWakeup(orgId, "wake2", "completed");
          expect(yield* landing).toMatchObject({ _tag: "merged" });
          yield* settled;
          expect(merges.map((merge) => merge.number)).toEqual([2]);
          expect(yield* remoteFiles("main")).toContain("claims/new.md");
          expect(yield* remoteFiles("main")).toContain("claims/later.md");
          expect(notMerged()).toHaveLength(1);
        }
        return;
      }

      expect(yield* landing).toMatchObject({ _tag: "merged" });
      yield* settled;
      const main = yield* bare("rev-parse", "refs/heads/main");
      expect(yield* bare("rev-parse", `${main}^`)).toBe(original);
      expect(yield* bare("log", "-1", "--format=%s", main)).toBe(
        `kin: memory from this server up to ${committed.commit.slice(0, 12)}`,
      );
      expect(yield* remoteFiles(main)).toContain("claims/new.md");
      // GitHub's squash is folded back with a merge, so the wake-up's own commit stays in history.
      const head = yield* localMain();
      expect((yield* git(paths.writer, ["show", "-s", "--format=%P", head])).split(" ")).toEqual([
        main,
        committed.commit,
      ]);
      expect(yield* memory.anchor(orgId, "main")).toBe(head);
      // Recovering the wake-up finds its commit through the merge and commits nothing twice.
      expect(yield* writer.commitWakeup(orgId, "wake1", "completed")).toEqual(committed);
      expect(yield* localMain()).toBe(head);
      // The merged branch is deleted; the merge was pinned to the commit Kin pushed.
      const batchBranch = /^kin\/write\/land\/[0-9a-f]{12}$/;
      const auto = [...pulls].find(([, pull]) => batchBranch.test(pull.branch))!;
      const leftOver = yield* bare("for-each-ref", "--format=%(refname)", "refs/heads/kin/write/");
      expect(leftOver).toBe("");
      const autoHead = yield* git(paths.writer, ["rev-parse", `${main}^{tree}`]);
      expect(merges).toEqual([
        {
          number: auto[0],
          body: expect.objectContaining({ merge_method: "squash", sha: expect.any(String) }),
        },
      ]);
      const pinned = (merges[0]!.body as { sha: string }).sha;
      expect(yield* git(paths.writer, ["rev-parse", `${pinned}^{tree}`])).toBe(autoHead);
      if (asApp)
        expect(new Set(github.requests.map((request) => request.as))).toEqual(new Set(["app"]));
      if (scenario === "owner-path") {
        expect(yield* remoteFiles(main)).toContain("decisions/dec-001.md");
        expect(yield* bare("show", `${main}:INDEX.md`)).toContain("dec-001");
        expect(pulls.size).toBe(1);
      }
      // Memory writes post nothing in the owner's chat.
      expect(notices).toEqual([]);

      // A crashed write or an agent's own push leaves a `kin/write/*` PR nobody waits on.
      const orphanBranch = "kin/write/other/orphan";
      yield* bare("update-ref", `refs/heads/${orphanBranch}`, original);
      const orphan = pulls.size + 1;
      pulls.set(orphan, { branch: orphanBranch, state: "open", base: "main" });
      yield* lander.sweep(orgId);
      expect(pulls.get(orphan)?.state).toBe("closed");
      expect(github.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: `/repos/${repo}/issues/${orphan}/comments`,
          body: { body: "Kin closed this memory PR: no Kin memory write is waiting on it." },
        }),
      );
    }).pipe(Effect.provide(writerLayer));

    if (scenario === "first-run") {
      // With matching trees there is nothing to land: the squash is merged in and no PR opens.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* settled;
        expect(github.requests.filter((request) => request.path.endsWith("/pulls"))).toHaveLength(
          1,
        );
        expect(merges).toEqual([]);
        const squash = yield* bare("rev-parse", "refs/heads/main");
        const head = yield* memory.anchor(orgId, "main");
        expect(
          (yield* git(`${root}/state/memory`, ["show", "-s", "--format=%P", head])).split(" ")[0],
        ).toBe(squash);
        expect(yield* bare("ls-tree", "-r", "--name-only", "main")).toContain("claims/new.md");
        // The next wake-up lands on top, and nothing staged in the writer's index goes with it.
        const writer = yield* Writer.MemoryWriter;
        yield* memory.prepareWakeup(orgId);
        yield* writer.stage(orgId, "wake2", claim("later"));
        yield* writer.commitWakeup(orgId, "wake2", "completed");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        const landed = yield* bare("ls-tree", "-r", "--name-only", "main");
        expect(landed).toContain("claims/new.md");
        expect(landed).toContain("claims/later.md");
        expect(yield* bare("show", "main:INDEX.md")).not.toContain("stale");
      }).pipe(Effect.provide(writerLayer));
    }

    if (scenario === "crash-owner-correction") {
      // The restart finds the squash under the owner's commit and merges from what landed, so
      // the entry's old text never comes back under the correction.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* settled;
        const corrected = yield* bare("show", `main:${journalPath}`);
        expect(corrected).toContain("Outcome: corrected by the owner");
        expect(corrected).not.toContain("Outcome: completed");
        expect(corrected.match(/wake-up wake1/g)).toHaveLength(1);
        const head = yield* memory.anchor(orgId, "main");
        expect(yield* git(`${root}/state/memory`, ["show", `${head}:${journalPath}`])).toBe(
          corrected,
        );
        expect(notices).toEqual([]);
        // A later wake-up lands on top of the correction.
        const writer = yield* Writer.MemoryWriter;
        yield* memory.prepareWakeup(orgId);
        yield* writer.stage(orgId, "wake2", claim("later"));
        yield* writer.commitWakeup(orgId, "wake2", "completed");
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        const after = yield* bare("show", `main:${journalPath}`);
        expect(after.startsWith(corrected)).toBe(true);
        expect(after.match(/wake-up wake1/g)).toHaveLength(1);
        expect(after).toContain("wake-up wake2");
      }).pipe(Effect.provide(writerLayer));
    }

    if (scenario === "crash-beyond-search") {
      // Kin can't tell what landed, so it merges nothing and says so; the correction stays alone.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const corrected = yield* bare("show", `main:${journalPath}`);
        yield* memory.syncCheckout(orgId);
        expect(yield* bare("show", `main:${journalPath}`)).toBe(corrected);
        expect(corrected).not.toContain("Outcome: completed");
        expect(
          notices.filter((notice) => notice.reason.startsWith("Memory write not merged")),
        ).toHaveLength(1);
        const head = yield* memory.anchor(orgId, "main");
        expect(yield* git(`${root}/state/memory`, ["show", `${head}:${journalPath}`])).toContain(
          "Outcome: completed",
        );
      }).pipe(Effect.provide(writerLayer));
    }

    if (scenario === "review-leftovers") {
      // The next start keeps what this server made, closes both PRs, and lands it all.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        const writer = `${root}/state/memory`;
        expect(yield* git(writer, ["for-each-ref", "refs/kin/review/"])).toBe("");
        for (const id of ["dec-left", "person-left"])
          expect((yield* memory.readItem(orgId, KinMemoryItemId.make(id))).head.id).toBe(id);
        const landed = yield* bare("ls-tree", "-r", "--name-only", "main");
        expect(landed).toContain("decisions/dec-left.md");
        expect(landed).toContain("people/person-left.md");
        expect(landed).not.toContain("people/forged.md");
        expect([...pulls.values()].map((pull) => pull.state)).toEqual([
          "closed",
          "closed",
          "closed",
          "closed",
        ]);
        const comments = github.requests.flatMap((request) =>
          request.method === "POST" && request.path.endsWith("/comments")
            ? [{ path: request.path, body: request.body }]
            : [],
        );
        expect(comments.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
          {
            path: `/repos/${repo}/issues/1/comments`,
            body: {
              body: "Kin closed this memory PR: Kin saves memory without review now, so it kept these changes on its server; its next memory PR brings them to main.",
            },
          },
          ...[2, 3].map((number) => ({
            path: `/repos/${repo}/issues/${number}/comments`,
            body: {
              body: "Kin closed this memory PR: Kin saves memory without review now, and its server doesn't have this PR's commit, so nothing from it was kept.",
            },
          })),
        ]);
        expect(notices.flatMap((notice) => notice.owner ?? []).toSorted()).toEqual(
          [2, 3].map(
            (number) =>
              `Kin closed an old memory review, https://github.com/${repo}/pull/${number}, without keeping its changes: this server no longer has them.`,
          ),
        );
      }).pipe(Effect.provide(writerLayer));
    }

    if (scenario === "guard-rails-upgrade") {
      // A restart with nothing left to propose or land opens nothing.
      yield* Effect.gen(function* () {
        yield* settled;
        expect(
          github.requests.filter(
            (request) => request.method === "POST" && request.path === `/repos/${repo}/pulls`,
          ),
        ).toHaveLength(3);
      }).pipe(Effect.provide(writerLayer));
    }

    if (scenario === "restart") {
      // The restart closes the PR the crash left open before it lands anything, then lands the
      // commits the last run could not.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        expect(yield* landing).toMatchObject({ _tag: "merged" });
        yield* settled;
        expect([...pulls.values()].map((pull) => pull.state)).toEqual(["closed", "closed"]);
        expect(merges.map((merge) => merge.number)).toEqual([2]);
        expect(yield* bare("ls-tree", "-r", "--name-only", "main")).toContain("claims/new.md");
        const head = yield* memory.anchor(orgId, "main");
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(
          (yield* git(`${root}/state/memory`, ["show", "-s", "--format=%P", head])).split(" ")[0],
        );
      }).pipe(Effect.provide(writerLayer));
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        gitLayer,
        NodeServices.layer,
        Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
    Effect.scoped,
  ),
);
