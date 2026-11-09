import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinAgentId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
  "keep",
  "keep-moved-head",
  "no-app",
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
            if (scenario === "moved-head" || scenario === "keep-moved-head")
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
            for (const [number, pull] of pulls)
              if ((yield* branchHead(pull.branch)) === sha) return { number, branch: pull.branch };
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
          const pending = scenario === "check-pending";
          const failed = scenario === "check-failed" || scenario === "owner-path-refused";
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
          return {
            status: 200,
            body: { total_count: listed.length, jobs: yield* Effect.forEach(listed, job) },
          };
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
      PullRequests.make({ pollInterval: 0, polls: 2 }),
    ).pipe(Layer.provide(Layer.mergeAll(app, github.layer)));

    const notices: Array<{ branch: string; reason: string }> = [];
    const recovery = Layer.succeed(Memory.MemoryRecoveryHooks, {
      notify: (notice) => Effect.sync(() => void notices.push(notice)),
    });
    const config = Layer.succeed(MemoryConfig, {
      baseDirectory: root,
      repositories: [{ orgId, repoUrl: remote, path: "state", githubRepo: repo }],
    });
    const keeping = scenario === "keep" || scenario === "keep-moved-head";
    const auth = Layer.succeed(Writer.MemoryWriterAuthority, {
      resolve: (_org, wakeupId) =>
        Effect.succeed({
          orgId,
          wakeupId,
          agentId,
          level: keeping ? "L0" : "L1",
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
    const memoryLayer = Memory.layer.pipe(Layer.provide(config), Layer.provide(recovery));
    const writerLayer = Writer.layer.pipe(
      Layer.provideMerge(memoryLayer),
      Layer.provide(scenario === "no-app" ? Layer.empty : pullRequests),
      Layer.provide(recovery),
      Layer.provide(config),
      Layer.provide(Layer.succeed(Writer.MemoryWriterHooks, { notify: () => Effect.void })),
      Layer.provide(auth),
      Layer.provide(Scan.layer),
    );

    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const writer = yield* Writer.MemoryWriter;
      const paths = yield* memory.ensureCheckouts(orgId);
      yield* memory.prepareWakeup(orgId);
      const localMain = () => git(paths.writer, ["rev-parse", "refs/heads/main"]);
      const remoteFiles = (ref: string) => bare("ls-tree", "-r", "--name-only", ref);
      const refused = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => {
            expect(error).toMatchObject({ _tag: "MemorySyncConflict" });
            return error;
          }),
        );
      // A refused write leaves the default branch where it was, locally and on GitHub.
      const unchanged = Effect.gen(function* () {
        expect(yield* bare("rev-parse", "refs/heads/main")).toBe(original);
        expect(yield* localMain()).toBe(original);
        expect(yield* memory.anchor(orgId, "main")).toBe(original);
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(original);
      });
      const claim = { path: "claims/new.md", content: fixtureItem({ id: "new", kind: "claim" }) };

      if (keeping) {
        yield* writer.stage(orgId, "wake1", {
          path: "deferrals/def-001.md",
          content: fixtureItem(),
          sourceEventId: "owner",
        });
        const shadowed = yield* writer.commitWakeup(orgId, "wake1", "completed");
        const { paths: shown } = yield* writer.settleShadow(orgId, agentId, { _tag: "preview" });
        const keep = writer.settleShadow(orgId, agentId, { _tag: "keep", paths: shown });
        if (scenario === "keep-moved-head") {
          yield* refused(keep);
          yield* unchanged;
          expect(merges).toEqual([]);
          expect(yield* branchHead(`kin/shadow/${agentId}`)).toBe(shadowed.commit);
          expect(pulls.get(1)?.state).toBe("closed");
          return;
        }
        expect(yield* keep).toEqual({ kept: 2, paths: shown });
        expect(pulls.get(1)?.branch).toMatch(
          new RegExp(`^kin/write/${agentId}/keep-${shadowed.commit.slice(0, 12)}-[0-9a-f]{12}$`),
        );
        const main = yield* bare("rev-parse", "refs/heads/main");
        expect(merges).toEqual([
          { number: 1, body: expect.objectContaining({ sha: expect.any(String) }) },
        ]);
        expect(yield* localMain()).toBe(main);
        expect(yield* remoteFiles(main)).toContain("deferrals/def-001.md");
        expect(yield* branchHead(`kin/shadow/${agentId}`)).toBe(main);
        return;
      }

      yield* writer.stage(orgId, "wake1", { ...claim, sourceEventId: "owner" });
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
      const committing = writer.commitWakeup(orgId, "wake1", "completed");

      if (scenario === "no-app") {
        yield* refused(committing);
        yield* unchanged;
        expect(yield* bare("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          expect.stringContaining("Kin GitHub App"),
        );
        return;
      }
      if (scenario === "hang" || scenario === "stall-body") {
        const running = yield* Effect.forkChild(committing);
        yield* Deferred.await(silenced);
        yield* TestClock.adjust("30 seconds");
        const error = yield* refused(Fiber.join(running));
        expect(error).toMatchObject({
          reason: expect.stringContaining(
            `could not reach GitHub for ${scenario === "hang" ? "pulls.create" : "checks.list"}`,
          ),
        });
        yield* unchanged;
        // The writer lock is free again: the sweep takes it and closes the PR left open.
        yield* writer.sweepPullRequests(orgId);
        expect(merges).toEqual([]);
        expect([...pulls.values()].map((pull) => pull.state)).toEqual(
          scenario === "hang" ? [] : ["closed"],
        );
        // A retry gets a fresh commit and branch, so the closed PR doesn't block it.
        if (scenario === "stall-body") {
          yield* writer.commitWakeup(orgId, "wake1", "completed");
          expect(merges.length).toBe(1);
        }
        return;
      }
      if (
        !reviewed &&
        scenario !== "merged" &&
        scenario !== "rerun" &&
        scenario !== "records-broken"
      ) {
        const foreign = "did not come from .github/workflows/memory-check.yml";
        const error = yield* refused(committing);
        yield* unchanged;
        expect(merges.length).toBe(scenario === "merge-rejected" ? 1 : 0);
        expect(pulls.get(1)?.state).toBe("closed");
        // A refused write opens no review PR, so none is left waiting alone.
        expect([...pulls.values()].filter((pull) => pull.branch.endsWith("-review"))).toEqual([]);
        // A PR from Kin's branch that isn't this one fails before Kin reads any run.
        if (scenario === "second-pr")
          expect(github.requests.map((request) => request.path)).not.toContainEqual(
            expect.stringContaining("/actions/runs"),
          );
        expect(github.requests).toContainEqual(
          expect.objectContaining({ method: "POST", path: `/repos/${repo}/issues/1/comments` }),
        );
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          expect.stringContaining(`https://github.com/${repo}/pull/1`),
        );
        expect(error).toMatchObject({
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
        return;
      }

      const result = yield* committing;
      const main = yield* bare("rev-parse", "refs/heads/main");
      expect(result.commit).toBe(main);
      expect(yield* localMain()).toBe(main);
      expect(yield* memory.anchor(orgId, "main")).toBe(main);
      expect(yield* bare("rev-parse", `${main}^`)).toBe(original);
      expect(yield* bare("log", "-1", "--format=%s", main)).toBe(`kin(${agentId}): wake-up wake1`);
      expect(yield* remoteFiles(main)).toContain("claims/new.md");
      // The merged branch is deleted; the merge was pinned to the commit Kin pushed.
      const wakeBranch = new RegExp(`^kin/write/${agentId}/wake1-[0-9a-f]{12}$`);
      const auto = [...pulls].find(([, pull]) => wakeBranch.test(pull.branch))!;
      expect(yield* bare("for-each-ref", "--format=%(refname)", "refs/heads/kin/write/")).toBe(
        ownerPath ? `refs/heads/${auto[1].branch}-review` : "",
      );
      const autoHead = yield* git(paths.writer, ["rev-parse", `${main}^{tree}`]);
      expect(merges).toEqual([
        {
          number: auto[0],
          body: expect.objectContaining({ merge_method: "squash", sha: expect.any(String) }),
        },
      ]);
      const pinned = (merges[0]!.body as { sha: string }).sha;
      expect(yield* git(paths.writer, ["rev-parse", `${pinned}^{tree}`])).toBe(autoHead);
      expect(tokens).toEqual([
        {
          repo,
          holder: "server",
          permissions: {
            contents: "write",
            pull_requests: "write",
            checks: "read",
            actions: "read",
          },
        },
        ...(ownerPath ? [expect.objectContaining({ holder: "server" })] : []),
      ]);

      if (scenario === "records-broken") {
        const reviewNumber = [...pulls].find(([, pull]) => pull.branch.endsWith("-review"))![0];
        expect(pulls.get(reviewNumber)?.state).toBe("closed");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          "Memory changes on paths you review were not opened as a PR: Kin could not record the commit it pushed (MemoryPullRequests.recordReview)",
        );
        const sweepRefusal = refused(writer.sweepPullRequests(orgId));
        yield* sql`DROP TRIGGER no_insert`;
        yield* sql`INSERT INTO kin_memory_review_pulls (org_id, branch, head)
          VALUES (${orgId}, 'kin/write/gone-review', ${original})
          ON CONFLICT (org_id, branch) DO NOTHING`;
        yield* sql`CREATE TRIGGER no_delete BEFORE DELETE ON kin_memory_review_pulls
          BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
        expect(yield* sweepRefusal).toMatchObject({
          reason: "Kin could not update its record of review PRs (MemoryPullRequests.forgetReview)",
        });
        yield* sql`ALTER TABLE kin_memory_review_pulls RENAME TO kin_memory_review_pulls_gone`;
        expect(yield* sweepRefusal).toMatchObject({
          reason: "Kin could not read its record of review PRs (MemoryPullRequests.records)",
        });
        return;
      }

      if (reviewed) {
        const review = [...pulls].find(([, pull]) =>
          new RegExp(`^kin/write/${agentId}/wake1-[0-9a-f]{12}-review$`).test(pull.branch),
        )!;
        const reviewBranch = review[1].branch;
        // Kin never merges the owner's paths; the PR stays open for their review.
        expect(review[1].state).toBe("open");
        expect(merges.map((merge) => merge.number)).not.toContain(review[0]);
        expect(yield* remoteFiles(main)).not.toContain("decisions/dec-001.md");
        expect(yield* bare("show", `${main}:INDEX.md`)).not.toContain("dec-001");
        expect(yield* remoteFiles(reviewBranch)).toContain("decisions/dec-001.md");
        expect(yield* remoteFiles(reviewBranch)).not.toContain("claims/new.md");
        const reviewHead = yield* branchHead(reviewBranch);
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          `Memory changes on paths you review wait in https://github.com/${repo}/pull/${review[0]}. Kin pushed \`${reviewHead}\`; if the PR's head differs, close it`,
        );
        expect(github.requests).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: `/repos/${repo}/pulls`,
            body: expect.objectContaining({
              head: reviewBranch,
              body: expect.stringContaining(`Kin pushed \`${reviewHead}\``),
            }),
          }),
        );
        // Reads follow the default branch while the review PR is open.
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(main);
        expect(
          (yield* memory.readItem(orgId, KinMemoryItemId.make("dec-001")).pipe(Effect.flip))._tag,
        ).toBe("MemoryNotFound");

        // A crashed write or an agent's own push leaves a `kin/write/*` PR nobody waits on.
        const orphanBranch = "kin/write/other/orphan";
        yield* bare("update-ref", `refs/heads/${orphanBranch}`, original);
        const orphan = pulls.size + 1;
        pulls.set(orphan, { branch: orphanBranch, state: "open", base: "main" });
        yield* writer.sweepPullRequests(orgId);
        expect(pulls.get(orphan)?.state).toBe("closed");
        expect(github.requests).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: `/repos/${repo}/issues/${orphan}/comments`,
            body: { body: "Kin closed this memory PR: no Kin memory write is waiting on it." },
          }),
        );
        expect(review[1].state).toBe("open");
        expect(yield* records).toEqual([{ branch: reviewBranch, head: reviewHead }]);

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
        yield* bare("update-ref", `refs/heads/${reviewBranch}`, original);
        if (scenario === "owner-path-close-fails") unclosable = review[0];
        const before = notices.length;
        yield* writer.sweepPullRequests(orgId);
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
          expect(yield* records).toEqual([{ branch: reviewBranch, head: reviewHead }]);
          // The next sweep still can't close it, and doesn't tell the owner again.
          const again = notices.length;
          yield* writer.sweepPullRequests(orgId);
          expect(notices.length).toBe(again);
          return;
        }
        expect(review[1].state).toBe("closed");
        expect(notices.slice(before).map((notice) => notice.reason)).toEqual([
          `Kin closed ${moved}, the memory PR for paths you review: ${reason}`,
        ]);
        expect(yield* records).toEqual([]);
      }
    }).pipe(Effect.provide(writerLayer));
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
