import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { KinWorkerId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import { ServerConfig } from "../../config.ts";
import * as Vcs from "../../vcs/VcsProcess.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";
import { fakeGitHub, type RecordedRequest } from "../github/testFakes.ts";
import * as Publish from "./workerPublish.ts";

const workerId = KinWorkerId.make("wk-1");
const gitLayer = Vcs.layer.pipe(Layer.provide(NodeServices.layer));

/** GitHub as a local bare repo plus a fake REST API, and a worker clone with Kin's branch. */
const fixture = Effect.fn("WorkerPublishTest.fixture")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* Vcs.VcsProcess;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    vcs
      .run({
        operation: "WorkerPublishTest.git",
        command: "git",
        cwd,
        args: ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      })
      .pipe(Effect.map((result) => result.stdout.trim()));
  const origin = `${root}/origin.git`;
  const worker = `${root}/worker`;
  yield* git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  yield* git(root, "init", "--quiet", "-b", "main", `${root}/seed`);
  yield* fs.writeFileString(`${root}/seed/README.md`, "seed\n");
  yield* git(`${root}/seed`, "add", "README.md");
  yield* git(`${root}/seed`, "commit", "--quiet", "-m", "seed");
  yield* git(`${root}/seed`, "push", "--quiet", origin, "main");
  yield* git(root, "clone", "--quiet", origin, worker);
  yield* git(worker, "switch", "--quiet", "-c", Publish.publishBranch(workerId));
  for (const [path, text] of Object.entries(files)) {
    yield* fs.makeDirectory(`${worker}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true });
    yield* fs.writeFileString(`${worker}/${path}`, text);
    yield* git(worker, "add", path);
    yield* git(worker, "commit", "--quiet", "-m", `add ${path}`);
  }
  const head = yield* git(worker, "rev-parse", "HEAD");
  const remoteBranch = git(
    root,
    `--git-dir=${origin}`,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/heads/kin/",
  );

  const requests: Array<RecordedRequest> = [];
  const tokens: Array<unknown> = [];
  let opened = false;
  const github = fakeGitHub((request) => {
    requests.push(request);
    if (request.method === "GET" && request.path === "/repos/acme/app")
      return { status: 200, body: { default_branch: "main" } };
    if (request.method === "GET" && request.path.startsWith("/repos/acme/app/pulls?"))
      return {
        status: 200,
        body: opened ? [{ number: 7, html_url: "https://github.com/acme/app/pull/7" }] : [],
      };
    if (request.method === "POST" && request.path === "/repos/acme/app/pulls") {
      opened = true;
      return { status: 201, body: { number: 7, html_url: "https://github.com/acme/app/pull/7" } };
    }
    return { status: 404, body: { message: "Not Found" } };
  });
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
  const service = yield* Publish.make({
    // The host runs kin-worker's upload-pack in the sandbox; here it is git's own.
    worker: (path) => `ext::git %s ${path}`,
    github: () => origin,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        app,
        github.layer,
        Layer.succeed(ServerConfig, { stateDir: `${root}/state` } as never),
        NodeCrypto.layer,
      ),
    ),
  );
  const publish = (worktreePath = worker) =>
    service.publish({ workerId, repositoryKey: "github.com/acme/app", worktreePath, title: "Fix" });
  return { publish, head, remoteBranch, requests, tokens };
});

it.live(
  "publishes the worker's branch with a server token as one draft PR, and finds it again",
  () =>
    Effect.gen(function* () {
      const { publish, head, remoteBranch, requests, tokens } = yield* fixture({
        "src/fix.ts": "export {};\n",
      });
      assert.deepStrictEqual(yield* publish(), {
        url: "https://github.com/acme/app/pull/7",
        number: 7,
        sha: head,
      });
      assert.strictEqual(yield* remoteBranch, head);
      assert.deepStrictEqual(tokens[0], {
        repo: "acme/app",
        permissions: { contents: "write", pull_requests: "write" },
        holder: "server",
      });
      const created = requests.filter((request) => request.method === "POST");
      assert.lengthOf(created, 1);
      assert.deepInclude(created[0]!.body as object, {
        head: "kin/worker/wk-1",
        base: "main",
        draft: true,
      });
      // A second run of the same worker updates the branch and keeps its PR.
      assert.strictEqual((yield* publish()).number, 7);
      assert.lengthOf(
        requests.filter((request) => request.method === "POST"),
        1,
      );
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("refuses a branch that touches workflows, and a worktree path it can't pass on", () =>
  Effect.gen(function* () {
    const { publish, remoteBranch, requests } = yield* fixture({
      "src/fix.ts": "export {};\n",
      ".github/workflows/leak.yml": "on: push\n",
    });
    assert.include(yield* Effect.flip(publish()), {
      reason: "kin/worker/wk-1 changes .github/workflows/, which Kin never publishes",
    });
    assert.strictEqual(yield* remoteBranch, "");
    for (const path of ["relative/path", "/home/kin-worker/a b", "/home/kin-worker/../kin"])
      assert.include(yield* Effect.flip(publish(path)), {
        reason: "the worker environment reported an unusable worktree path",
      });
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);
