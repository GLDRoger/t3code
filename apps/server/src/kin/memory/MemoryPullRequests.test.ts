import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinAgentId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

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

type Scenario =
  | "merged"
  | "foreign-check"
  | "moved-head"
  | "check-failed"
  | "check-pending"
  | "merge-rejected"
  | "owner-path"
  | "keep"
  | "keep-moved-head"
  | "no-app";

it.live.each([
  "merged",
  "foreign-check",
  "moved-head",
  "check-failed",
  "check-pending",
  "merge-rejected",
  "owner-path",
  "keep",
  "keep-moved-head",
  "no-app",
] satisfies ReadonlyArray<Scenario>)("memory writes through PRs: %s", (scenario) =>
  Effect.gen(function* () {
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
    const pulls = new Map<number, { branch: string; state: string }>();
    const merges: Array<{ number: number; body: unknown }> = [];
    const tokens: Array<unknown> = [];
    const branchHead = (branch: string) => bare("rev-parse", `refs/heads/${branch}`);
    const pullBody = (number: number) =>
      Effect.gen(function* () {
        const pull = pulls.get(number)!;
        return {
          number,
          html_url: `https://github.com/${repo}/pull/${number}`,
          state: pull.state,
          head: {
            sha: yield* branchHead(pull.branch),
            ref: pull.branch,
            repo: { full_name: repo },
          },
          base: { ref: "main" },
        };
      });
    const route = (request: RecordedRequest): Effect.Effect<FakeAnswer> =>
      Effect.gen(function* () {
        const path = request.path.slice(`/repos/${repo}`.length);
        const body = request.body as Record<string, string> | undefined;
        if (request.method === "POST" && path === "/pulls") {
          const number = pulls.size + 1;
          pulls.set(number, { branch: body!.head!, state: "open" });
          return { status: 201, body: yield* pullBody(number) };
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
        const runs = /^\/actions\/runs\?head_sha=([a-f0-9]+)&event=pull_request/.exec(path);
        if (runs)
          return {
            status: 200,
            body: {
              workflow_runs: [
                {
                  path: ".github/workflows/memory-check.yml",
                  event: "pull_request",
                  head_sha: runs[1],
                  check_suite_id: 1,
                },
                // Any workflow in the repo can name a job `memory-check`.
                {
                  path: ".github/workflows/other.yml",
                  event: "pull_request",
                  head_sha: runs[1],
                  check_suite_id: 2,
                },
              ],
            },
          };
        const checks = /^\/commits\/([a-f0-9]+)\/check-runs/.exec(path);
        if (checks) {
          const check = (suite: number, status: string, conclusion: string | null) => ({
            name: "memory-check",
            head_sha: checks[1],
            status,
            conclusion,
            app: { id: 15368 },
            check_suite: { id: suite },
          });
          return {
            status: 200,
            body: {
              check_runs:
                scenario === "foreign-check"
                  ? [check(2, "completed", "success")]
                  : scenario === "check-pending"
                    ? [check(1, "in_progress", null)]
                    : [check(1, "completed", scenario === "check-failed" ? "failure" : "success")],
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
        const branch = `kin/write/${agentId}/keep-${shadowed.commit.slice(0, 12)}`;
        expect(pulls.get(1)?.branch).toBe(branch);
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
      if (scenario === "owner-path")
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
      if (scenario !== "merged" && scenario !== "owner-path") {
        const error = yield* refused(committing);
        yield* unchanged;
        expect(merges.length).toBe(scenario === "merge-rejected" ? 1 : 0);
        expect(pulls.get(1)?.state).toBe("closed");
        expect(github.requests).toContainEqual(
          expect.objectContaining({ method: "POST", path: `/repos/${repo}/issues/1/comments` }),
        );
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          expect.stringContaining(`https://github.com/${repo}/pull/1`),
        );
        expect(error).toMatchObject({
          reason: expect.stringContaining(
            {
              "foreign-check": "did not come from .github/workflows/memory-check.yml",
              "moved-head": "head is not the commit Kin pushed",
              "check-failed": "memory-check failed",
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
      expect(yield* bare("for-each-ref", "--format=%(refname)", "refs/heads/kin/write/")).toBe(
        scenario === "owner-path" ? `refs/heads/kin/write/${agentId}/wake1-review` : "",
      );
      const auto = [...pulls].find(([, pull]) => pull.branch === `kin/write/${agentId}/wake1`)!;
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
        ...(scenario === "owner-path" ? [expect.objectContaining({ holder: "server" })] : []),
      ]);

      if (scenario === "owner-path") {
        const reviewBranch = `kin/write/${agentId}/wake1-review`;
        const review = [...pulls].find(([, pull]) => pull.branch === reviewBranch)!;
        // Kin never merges the owner's paths; the PR stays open for their review.
        expect(review[1].state).toBe("open");
        expect(merges.map((merge) => merge.number)).not.toContain(review[0]);
        expect(yield* remoteFiles(main)).not.toContain("decisions/dec-001.md");
        expect(yield* bare("show", `${main}:INDEX.md`)).not.toContain("dec-001");
        expect(yield* remoteFiles(reviewBranch)).toContain("decisions/dec-001.md");
        expect(yield* remoteFiles(reviewBranch)).not.toContain("claims/new.md");
        expect(notices.map((notice) => notice.reason)).toContainEqual(
          `Memory changes on paths you review wait in https://github.com/${repo}/pull/${review[0]}`,
        );
        // Reads follow the default branch while the review PR is open.
        expect((yield* memory.prepareWakeup(orgId)).head).toBe(main);
        expect(
          (yield* memory.readItem(orgId, KinMemoryItemId.make("dec-001")).pipe(Effect.flip))._tag,
        ).toBe("MemoryNotFound");
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
