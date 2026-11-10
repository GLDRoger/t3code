import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinAgentId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";
import { fakeGitHub, type FakeAnswer, type RecordedRequest } from "../github/testFakes.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import { fixtureItem } from "./__fixtures__/items.ts";
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
  "owner-path-close-fails",
  "owner-path-refused",
  "records-broken",
  "hang",
  "stall-body",
  "run-from-fork",
  "no-app",
  "batched",
  "restart",
] as const;

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
    yield* git(source, ["add", "--", "."]);
    yield* git(source, [...identity, "commit", "-m", "fixture"]);
    yield* git(root, ["clone", "--bare", "--", source, remote]);
    const original = yield* bare("rev-parse", "refs/heads/main");

    // A GitHub over the bare remote: it squash-merges there, as the real one would.
    const pulls = new Map<number, { branch: string; state: string; base: string; sha?: string }>();
    const merges: Array<{ number: number; body: unknown }> = [];
    const tokens: Array<unknown> = [];
    // The request GitHub never answers in `hang` and `stall-body`.
    const silenced = yield* Deferred.make<void>();
    let stalls = 0;
    let jobsListed = false;
    let unclosable: number | undefined;
    // `batched`: memory-check stays pending on the first PR until the test releases it.
    const firstPoll = yield* Deferred.make<void>();
    let ciDone = false;
    // `restart`: GitHub refuses new PRs until the server restarts.
    let createFails = scenario === "restart";
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
            if (number === unclosable) return { status: 500, body: { message: "Server Error" } };
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
          const pending = scenario === "check-pending" || (scenario === "batched" && !ciDone);
          // `check-failed` fails only the first PR, so a later commit's attempt can land.
          const failed =
            (scenario === "check-failed" && pulls.size === 1) || scenario === "owner-path-refused";
          const job = (id: number) =>
            Effect.gen(function* () {
              return {
                id,
                name: "memory-check",
                // The newest PR is the attempt being checked (a retry opens PR 2).
                head_sha: yield* branchHead(pulls.get(Math.max(...pulls.keys()))!.branch),
                status: pending ? "in_progress" : "completed",
                conclusion: pending ? null : failed ? "failure" : "success",
              };
            });
          // An Actions job's id is its check run's id.
          const ids = jobs[1] !== "10" ? [200] : scenario === "rerun" ? [100, 101] : [100];
          // A re-run's earlier attempts are listed only with `filter=all`.
          const listed = query.get("filter") === "all" ? ids : ids.slice(-1);
          const answered = yield* Effect.forEach(listed, job);
          // The poll's git reads are done, so moving the test clock times out no subprocess.
          if (pending) yield* Deferred.succeed(silenced, undefined);
          if (pending && scenario === "batched") yield* Deferred.succeed(firstPoll, undefined);
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
    const github = fakeGitHub(route);
    const app = Layer.succeed(
      KinGitHubApp,
      KinGitHubApp.of({
        app: Effect.die("unused"),
        installations: Effect.die("unused"),
        patchHookConfig: () => Effect.die("unused"),
        installationToken: (input) =>
          Effect.sync(() => {
            tokens.push(input);
            return {
              token: Redacted.make("fixture-installation-token"),
              repo: input.repo,
              expiresAt: "2026-11-09T01:00:00Z",
              permissions: {},
            };
          }),
      }),
    );
    const pullRequests = Layer.effect(
      PullRequests.MemoryPullRequests,
      PullRequests.make({
        pollInterval:
          scenario === "check-pending" ? "20 minutes" : scenario === "batched" ? "1 minute" : 0,
      }),
    ).pipe(Layer.provide(Layer.mergeAll(app, github.layer)));

    const notices: Array<{ branch: string; reason: string }> = [];
    const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
      notify: (notice) => Effect.sync(() => void notices.push(notice)),
    });
    const config = Layer.succeed(MemoryConfig, {
      baseDirectory: root,
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
              { saidBy: "fixture-owner", trust: "owner" as const, source: "fixture-owner-message" },
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
      Layer.provide(scenario === "no-app" ? Layer.empty : pullRequests),
      Layer.provide(recovery),
      Layer.provide(config),
      Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
      Layer.provide(auth),
      Layer.provide(Scan.layer),
      Layer.provide(landerHooks),
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
      content: fixtureItem({ id, kind: "claim", title: `Claim ${id}`, links: [] }),
      sourceEventId: "owner",
    });

    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const writer = yield* Writer.MemoryWriter;
      const lander = yield* Lander.MemoryLander;
      // The start-up run finds nothing to land yet; later outcomes then come in order.
      if (scenario !== "no-app") yield* settled;
      const paths = yield* memory.ensureCheckouts(orgId);
      yield* memory.prepareWakeup(orgId);
      const localMain = () => git(paths.writer, ["rev-parse", "refs/heads/main"]);
      const remoteFiles = (ref: string) => bare("ls-tree", "-r", "--name-only", ref);
      const notMerged = () =>
        notices.filter((notice) => notice.reason.startsWith("Memory write not merged"));

      yield* writer.stage(orgId, "wake1", claim("new"));
      const reviewed = scenario === "owner-path" || scenario === "owner-path-close-fails";
      const ownerPath =
        reviewed || scenario === "owner-path-refused" || scenario === "records-broken";
      const sql = yield* SqlClient.SqlClient;
      const records = sql`SELECT branch, head FROM kin_memory_review_pulls ORDER BY branch`;
      if (scenario === "records-broken")
        yield* sql`CREATE TRIGGER no_insert BEFORE INSERT ON kin_memory_review_pulls
          BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
      if (ownerPath)
        yield* writer.stage(orgId, "wake1", {
          path: "decisions/dec-001.md",
          content: fixtureItem({ id: "dec-001", kind: "decision", review_by: null }),
          sourceEventId: "owner",
        });

      if (scenario === "no-app") {
        const error = yield* writer.commitWakeup(orgId, "wake1", "completed").pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MemorySyncConflict" });
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        expect(yield* localMain()).toBe(original);
        expect(yield* bare("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          expect.stringContaining("Kin GitHub App"),
        );
        return;
      }

      // The wake-up's memory is done once it is committed here, whatever GitHub does later.
      const committed = yield* writer.commitWakeup(orgId, "wake1", "completed");
      expect(yield* localMain()).toBe(committed.commit);
      expect(yield* memory.anchor(orgId, "main")).toBe(committed.commit);
      expect(yield* git(paths.writer, ["rev-parse", `${committed.commit}^`])).toBe(original);

      // A refused landing undoes nothing: this server keeps the commit and leads read it.
      const kept = Effect.gen(function* () {
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        expect(yield* localMain()).toBe(committed.commit);
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(committed.commit);
        expect((yield* memory.readItem(orgId, KinMemoryItemId.make("new"))).head.id).toBe("new");
      });

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
        !reviewed &&
        scenario !== "merged" &&
        scenario !== "rerun" &&
        scenario !== "records-broken"
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
        // A refused batch opens no review PR, so none is left waiting alone.
        expect([...pulls.values()].filter((pull) => pull.branch.endsWith("-review"))).toEqual([]);
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
              "owner-path-refused": "memory-check failed",
              "check-pending": "did not finish in time",
              "merge-rejected": "GitHub refused the merge (HTTP 405",
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
      const reviewBranch = new RegExp(`^kin/write/${agentId}/wake1-[0-9a-f]{12}-review$`);
      const leftOver = yield* bare("for-each-ref", "--format=%(refname)", "refs/heads/kin/write/");
      if (ownerPath) expect(leftOver.replace("refs/heads/", "")).toMatch(reviewBranch);
      else expect(leftOver).toBe("");
      const autoHead = yield* git(paths.writer, ["rev-parse", `${main}^{tree}`]);
      expect(merges).toEqual([
        {
          number: auto[0],
          body: expect.objectContaining({ merge_method: "squash", sha: expect.any(String) }),
        },
      ]);
      const pinned = (merges[0]!.body as { sha: string }).sha;
      expect(yield* git(paths.writer, ["rev-parse", `${pinned}^{tree}`])).toBe(autoHead);
      for (const token of tokens)
        expect(token).toEqual({
          repo,
          holder: "server",
          permissions: {
            contents: "write",
            pull_requests: "write",
            checks: "read",
            actions: "read",
          },
        });
      if (!ownerPath) {
        // Memory writes post nothing in the owner's chat.
        expect(notices).toEqual([]);
        return;
      }

      if (scenario === "records-broken") {
        const reviewNumber = [...pulls].find(([, pull]) => pull.branch.endsWith("-review"))![0];
        expect(pulls.get(reviewNumber)?.state).toBe("closed");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          "Memory changes on paths you review were not opened as a PR: Kin could not record the commit it pushed (MemoryPullRequests.recordReview)",
        );
        const sweepRefusal = lander.sweep(orgId).pipe(Effect.flip);
        yield* sql`DROP TRIGGER no_insert`;
        yield* sql`INSERT INTO kin_memory_review_pulls (org_id, branch, head)
          VALUES (${orgId}, 'kin/write/gone-review', ${original})
          ON CONFLICT (org_id, branch) DO NOTHING`;
        yield* sql`CREATE TRIGGER no_delete BEFORE DELETE ON kin_memory_review_pulls
          BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
        expect(yield* sweepRefusal).toMatchObject({
          _tag: "MemorySyncConflict",
          reason: "Kin could not update its record of review PRs (MemoryPullRequests.forgetReview)",
        });
        yield* sql`ALTER TABLE kin_memory_review_pulls RENAME TO kin_memory_review_pulls_gone`;
        expect(yield* sweepRefusal).toMatchObject({
          _tag: "MemorySyncConflict",
          reason: "Kin could not read its record of review PRs (MemoryPullRequests.records)",
        });
        return;
      }

      const review = [...pulls].find(([, pull]) => reviewBranch.test(pull.branch))!;
      const reviewName = review[1].branch;
      // Kin never merges the owner's paths; the PR stays open for their review.
      expect(review[1].state).toBe("open");
      expect(merges.map((merge) => merge.number)).not.toContain(review[0]);
      expect(yield* remoteFiles(main)).not.toContain("decisions/dec-001.md");
      expect(yield* bare("show", `${main}:INDEX.md`)).not.toContain("dec-001");
      // Opened on GitHub's head once the rest landed, so it shows only the owner's paths.
      expect(yield* bare("diff", "--name-only", main, reviewName)).toBe("decisions/dec-001.md");
      const reviewHead = yield* branchHead(reviewName);
      expect(notices.map((notice) => notice.reason)).toContainEqual(
        `Memory changes on paths you review wait in https://github.com/${repo}/pull/${review[0]}. Kin pushed \`${reviewHead}\`; if the PR's head differs, close it`,
      );
      expect(github.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: `/repos/${repo}/pulls`,
          body: expect.objectContaining({
            head: reviewName,
            body: expect.stringContaining(`Kin pushed \`${reviewHead}\``),
          }),
        }),
      );
      // Reads follow this server's default branch while the review PR is open.
      expect((yield* memory.prepareWakeup(orgId)).head).toBe(head);
      expect(
        (yield* memory.readItem(orgId, KinMemoryItemId.make("dec-001")).pipe(Effect.flip))._tag,
      ).toBe("MemoryNotFound");

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
      expect(review[1].state).toBe("open");
      expect(yield* records).toEqual([{ branch: reviewName, head: reviewHead }]);

      // Agents flood the repo with newer PRs, which must not hide the review PR from the sweep.
      for (let flood = 0; flood < 120; flood++)
        pulls.set(pulls.size + 1, {
          branch: `feature/${flood}`,
          state: "open",
          base: "main",
          sha: original,
        });
      // A review PR Kin never recorded is closed with a comment, without telling the owner.
      const fakeBranch = "kin/write/other/fake-review";
      const fake = pulls.size + 1;
      pulls.set(fake, { branch: fakeBranch, state: "open", base: "main", sha: original });

      // An agent with the deploy key swaps what the owner would merge.
      yield* bare("update-ref", `refs/heads/${reviewName}`, original);
      if (scenario === "owner-path-close-fails") unclosable = review[0];
      const before = notices.length;
      yield* lander.sweep(orgId);
      const moved = `https://github.com/${repo}/pull/${review[0]}`;
      const reason = `its head is no longer \`${reviewHead}\`, the commit Kin pushed`;
      expect(pulls.get(fake)?.state).toBe("closed");
      expect(github.requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: `/repos/${repo}/issues/${fake}/comments`,
          body: { body: "Kin closed this memory PR: Kin did not open it." },
        }),
      );
      expect(merges.map((merge) => merge.number)).toEqual([auto[0]]);
      if (scenario === "owner-path-close-fails") {
        expect(review[1].state).toBe("open");
        expect(notices.slice(before).map((notice) => notice.reason)).toEqual([
          `Kin could not close ${moved}, the memory PR for paths you review, and it is still open. Close it without merging: ${reason}`,
        ]);
        expect(yield* records).toEqual([{ branch: reviewName, head: reviewHead }]);
        // The next sweep still can't close it, and doesn't tell the owner again.
        const again = notices.length;
        yield* lander.sweep(orgId);
        expect(notices.length).toBe(again);
        return;
      }
      expect(review[1].state).toBe("closed");
      expect(notices.slice(before).map((notice) => notice.reason)).toEqual([
        `Kin closed ${moved}, the memory PR for paths you review: ${reason}`,
      ]);
      expect(yield* records).toEqual([]);
    }).pipe(Effect.provide(writerLayer));

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
