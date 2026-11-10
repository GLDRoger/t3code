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

type Change =
  | { readonly kind: "file"; readonly path: string; readonly text: string }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string }
  /** A merge of a side branch whose only change is the merge commit's own. */
  | { readonly kind: "evilMerge"; readonly path: string; readonly text: string };

/** GitHub as a local bare repo plus a fake REST API, and a worker clone with Kin's branch. */
const fixture = Effect.fn("WorkerPublishTest.fixture")(function* (
  files: Record<string, string>,
  options: {
    readonly changes?: ReadonlyArray<Change>;
    readonly maxIncomingBytes?: number;
    /** Answers for the publisher's pause checks, in order; then not paused. */
    readonly paused?: ReadonlyArray<boolean>;
  } = {},
) {
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
  for (const change of options.changes ?? []) {
    if (change.kind === "symlink") {
      yield* fs.symlink(change.target, `${worker}/${change.path}`);
      yield* git(worker, "add", change.path);
      yield* git(worker, "commit", "--quiet", "-m", "link");
    } else if (change.kind === "file") {
      yield* fs.makeDirectory(`${worker}/${change.path}`.replace(/\/[^/]+$/, ""), {
        recursive: true,
      });
      yield* fs.writeFileString(`${worker}/${change.path}`, change.text);
      yield* git(worker, "add", "--", change.path);
      yield* git(worker, "commit", "--quiet", "-m", "change");
    } else {
      yield* git(worker, "switch", "--quiet", "-c", "side");
      yield* fs.writeFileString(`${worker}/side.txt`, "side\n");
      yield* git(worker, "add", "side.txt");
      yield* git(worker, "commit", "--quiet", "-m", "side");
      yield* git(worker, "switch", "--quiet", Publish.publishBranch(workerId));
      yield* git(worker, "merge", "--quiet", "--no-ff", "--no-commit", "side");
      yield* fs.makeDirectory(`${worker}/${change.path}`.replace(/\/[^/]+$/, ""), {
        recursive: true,
      });
      yield* fs.writeFileString(`${worker}/${change.path}`, change.text);
      yield* git(worker, "add", "--", change.path);
      yield* git(worker, "commit", "--quiet", "-m", "merge side");
    }
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
  const service = yield* Publish.make(
    {
      // The host runs kin-worker's upload-pack in the sandbox; here it is git's own.
      worker: (path) => `ext::git %s ${path}`,
      github: () => origin,
    },
    options.maxIncomingBytes === undefined ? {} : { maxIncomingBytes: options.maxIncomingBytes },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        app,
        github.layer,
        Layer.succeed(ServerConfig, { stateDir: `${root}/state` } as never),
      ),
    ),
  );
  const pauses = [...(options.paused ?? [])];
  const publish = (worktreePath = worker) =>
    service.publish({
      workerId,
      repositoryKey: "github.com/acme/app",
      worktreePath,
      title: "Fix",
      paused: Effect.sync(() => pauses.shift() ?? false),
    });
  const scratch = fs.readDirectory(`${root}/state/kin-worker-publish`);
  return { publish, head, remoteBranch, requests, tokens, scratch };
});

it.live(
  "publishes the worker's branch with a server token as one draft PR, and finds it again",
  () =>
    Effect.gen(function* () {
      const { publish, head, remoteBranch, requests, tokens, scratch } = yield* fixture({
        "src/fix.ts": "export {};\n",
      });
      assert.deepStrictEqual(yield* publish(), {
        url: "https://github.com/acme/app/pull/7",
        number: 7,
        sha: head,
      });
      assert.strictEqual(yield* remoteBranch, head);
      assert.deepStrictEqual(yield* scratch, []);
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

const githubDirChanges: ReadonlyArray<readonly [string, Change]> = [
  ["a workflow", { kind: "file", path: ".github/workflows/leak.yml", text: "on: push\n" }],
  ["a non-ASCII name", { kind: "file", path: ".github/workflows/\u00e9.yml", text: "on: push\n" }],
  [
    "a composite action",
    { kind: "file", path: ".github/actions/x/action.yml", text: "runs: {}\n" },
  ],
  ["a case variant", { kind: "file", path: ".GitHub/workflows/x.yml", text: "on: push\n" }],
  ["a .github symlink", { kind: "symlink", path: ".github", target: "src" }],
  ["a merge commit", { kind: "evilMerge", path: ".github/workflows/m.yml", text: "on: push\n" }],
];

it.live.each(githubDirChanges)("refuses a branch that changes .github through %s", ([, change]) =>
  Effect.gen(function* () {
    const { publish, remoteBranch, requests, scratch } = yield* fixture(
      { "src/fix.ts": "export {};\n" },
      { changes: [change] },
    );
    assert.include(yield* Effect.flip(publish()), {
      reason: "kin/worker/wk-1 changes .github/, which Kin never publishes",
    });
    assert.strictEqual(yield* remoteBranch, "");
    assert.deepStrictEqual(yield* scratch, []);
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("refuses a fetch above the disk ceiling and leaves no scratch repository behind", () =>
  Effect.gen(function* () {
    const { publish, remoteBranch, scratch } = yield* fixture(
      { "src/fix.ts": "export {};\n".repeat(4096) },
      { maxIncomingBytes: 1 },
    );
    assert.include(yield* Effect.flip(publish()), {
      reason: "kin/worker/wk-1 takes more than 0 MiB on disk",
    });
    assert.strictEqual(yield* remoteBranch, "");
    assert.deepStrictEqual(yield* scratch, []);
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("stops at a pause that lands before the push, or before the PR", () =>
  Effect.gen(function* () {
    const paused = {
      reason: "Kin is paused; ask the worker for a follow-up after the owner resumes",
    };
    const beforePush = yield* fixture({ "src/fix.ts": "export {};\n" }, { paused: [true] });
    assert.include(yield* Effect.flip(beforePush.publish()), paused);
    assert.strictEqual(yield* beforePush.remoteBranch, "");
    const beforePr = yield* fixture({ "src/fix.ts": "export {};\n" }, { paused: [false, true] });
    assert.include(yield* Effect.flip(beforePr.publish()), paused);
    assert.strictEqual(yield* beforePr.remoteBranch, beforePr.head);
    assert.isFalse(beforePr.requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("refuses a worktree path it can't pass on", () =>
  Effect.gen(function* () {
    const { publish, requests } = yield* fixture({ "src/fix.ts": "export {};\n" });
    for (const path of ["relative/path", "/home/kin-worker/a b", "/home/kin-worker/../kin"])
      assert.include(yield* Effect.flip(publish(path)), {
        reason: "the worker environment reported an unusable worktree path",
      });
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);
