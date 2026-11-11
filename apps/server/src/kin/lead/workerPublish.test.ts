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
    /** The write Kin refuses, as a pause or a stop of the worker does; each admitted one is listed. */
    readonly refuseAt?: Publish.PublishStep;
    /** A worker on this server: a worktree of the clone, its edits left uncommitted. */
    readonly local?: boolean;
    /** What GitHub says of the repository besides its default branch. */
    readonly about?: Record<string, unknown>;
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
  const tree = options.local === true ? `${root}/worktrees/app` : worker;
  if (options.local === true)
    yield* git(worker, "worktree", "add", "--quiet", "-b", Publish.publishBranch(workerId), tree);
  else yield* git(worker, "switch", "--quiet", "-c", Publish.publishBranch(workerId));
  for (const [path, text] of Object.entries(files)) {
    yield* fs.makeDirectory(`${tree}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true });
    yield* fs.writeFileString(`${tree}/${path}`, text);
    if (options.local === true) continue;
    yield* git(worker, "add", path);
    yield* git(worker, "commit", "--quiet", "-m", `add ${path}`);
  }
  for (const change of options.changes ?? []) {
    if (options.local === true) {
      // A local worker only edits files; a link here is one a setup script left behind.
      if (change.kind === "symlink") {
        yield* fs.symlink(change.target, `${tree}/${change.path}`);
        continue;
      }
      if (change.kind !== "file") return yield* Effect.die("a local worker only edits files");
      yield* fs.makeDirectory(`${tree}/${change.path}`.replace(/\/[^/]+$/, ""), {
        recursive: true,
      });
      yield* fs.writeFileString(`${tree}/${change.path}`, change.text);
    } else if (change.kind === "symlink") {
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
  const head = yield* git(tree, "rev-parse", "HEAD");
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
      return {
        status: 200,
        body: { default_branch: "main", ...(options.about ?? { private: true }) },
      };
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
  const admitted: Array<Publish.PublishStep> = [];
  const outcomes: Array<Publish.PublishOutcome> = [];
  const reviews: Array<Publish.PublishReview & { readonly before: number }> = [];
  const publish = (worktreePath = tree) =>
    service.publish({
      workerId,
      repositoryKey: "github.com/acme/app",
      worktreePath,
      ...(options.local === true ? { local: { projectRoot: worker } } : {}),
      title: "Fix",
      progress: {
        review: (review) =>
          Effect.sync(() => void reviews.push({ ...review, before: admitted.length })),
        begin: (intent) =>
          intent.step === options.refuseAt
            ? Effect.fail(new Publish.KinWorkerPublishRefused({ reason: "refused" }))
            : Effect.sync(() => void admitted.push(intent.step)),
        done: (outcome) => Effect.sync(() => void outcomes.push(outcome)),
      },
    });
  const inspect = service.inspect({ workerId, repositoryKey: "github.com/acme/app" });
  const scratch = fs.readDirectory(`${root}/state/kin-worker-publish`);
  const log = (format: string) => git(tree, "log", `--format=${format}`, "main..HEAD");
  return {
    publish,
    inspect,
    outcomes,
    reviews,
    origin,
    admitted,
    head,
    remoteBranch,
    requests,
    tokens,
    scratch,
    root,
    worker,
    tree,
    git,
    log,
  };
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

const linkChanges: ReadonlyArray<readonly [string, Change]> = [
  ["a link to an outside directory", { kind: "symlink", path: "docs", target: "/etc" }],
  ["a link to an outside file", { kind: "symlink", path: "passwd", target: "/etc/passwd" }],
  ["a ../.. link", { kind: "symlink", path: "up", target: "../.." }],
  ["a link inside the repository", { kind: "symlink", path: "lib", target: "src" }],
];

it.live.each(linkChanges)("refuses a branch that adds %s", ([, change]) =>
  Effect.gen(function* () {
    for (const local of [false, true]) {
      const { publish, remoteBranch, requests } = yield* fixture(
        { "src/fix.ts": "export {};\n" },
        { changes: [change], local },
      );
      assert.include(yield* Effect.flip(publish()), {
        reason: "kin/worker/wk-1 adds or changes a symbolic link, which Kin never publishes",
      });
      assert.strictEqual(yield* remoteBranch, "");
      assert.isFalse(requests.some((request) => request.method === "POST"));
    }
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

const projectFileChanges: ReadonlyArray<readonly [string, Change]> = [
  ["t3.json", { kind: "file", path: "t3.json", text: '{"scripts":[]}\n' }],
  ["a case variant", { kind: "file", path: "T3.JSON", text: '{"scripts":[]}\n' }],
  ["a nested project's", { kind: "file", path: "apps/web/t3.json", text: '{"scripts":[]}\n' }],
];

it.live.each(projectFileChanges)("refuses a branch that changes %s", ([, change]) =>
  Effect.gen(function* () {
    for (const local of [false, true]) {
      const { publish, remoteBranch, requests } = yield* fixture(
        { "src/fix.ts": "export {};\n" },
        { changes: [change], local },
      );
      assert.include(yield* Effect.flip(publish()), {
        reason:
          "kin/worker/wk-1 changes t3.json, whose scripts T3 Code runs, which Kin never publishes",
      });
      assert.strictEqual(yield* remoteBranch, "");
      assert.isFalse(requests.some((request) => request.method === "POST"));
    }
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

it.live("asks before each write and stops at a refusal before the push, or before the PR", () =>
  Effect.gen(function* () {
    const beforePush = yield* fixture({ "src/fix.ts": "export {};\n" }, { refuseAt: "push" });
    assert.include(yield* Effect.flip(beforePush.publish()), { reason: "refused" });
    assert.strictEqual(yield* beforePush.remoteBranch, "");
    const beforePr = yield* fixture({ "src/fix.ts": "export {};\n" }, { refuseAt: "pull_request" });
    assert.include(yield* Effect.flip(beforePr.publish()), { reason: "refused" });
    assert.deepStrictEqual(beforePr.admitted, ["push"]);
    assert.strictEqual(yield* beforePr.remoteBranch, beforePr.head);
    assert.isFalse(beforePr.requests.some((request) => request.method === "POST"));
    const all = yield* fixture({ "src/fix.ts": "export {};\n" });
    yield* all.publish();
    assert.deepStrictEqual(all.admitted, ["push", "pull_request"]);
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live.each([
  ["private", { private: true, visibility: "private" }],
  ["public", { private: false, visibility: "public" }],
  ["unknown", {}],
  ["unknown", { private: true, visibility: "internal" }],
] as const)(
  "reviews a %s repository and the files Kin's own git counts, before any write",
  ([visibility, about]) =>
    Effect.gen(function* () {
      const { publish, reviews, head } = yield* fixture(
        { "src/fix.ts": "export {};\nexport const a = 1;\n", "docs/notes.md": "one\n" },
        { about },
      );
      yield* publish();
      assert.deepStrictEqual(reviews, [
        {
          sha: head,
          visibility,
          files: [
            { path: "docs/notes.md", added: 1, removed: 0 },
            { path: "src/fix.ts", added: 2, removed: 0 },
          ],
          moreFiles: 0,
          // Before Kin admitted any write to GitHub.
          before: 0,
        },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live(
  "a local worker's edits refused before the commit stay uncommitted, with nothing pushed",
  () =>
    Effect.gen(function* () {
      const { publish, remoteBranch, log, tree, git, admitted } = yield* fixture(
        { "README.md": "# Acme app\n", "src/new.ts": "export {};\n" },
        { local: true, refuseAt: "commit" },
      );
      assert.include(yield* Effect.flip(publish()), { reason: "refused" });
      assert.deepStrictEqual(admitted, []);
      assert.strictEqual(yield* log("%H"), "");
      assert.notStrictEqual(yield* git(tree, "status", "--porcelain"), "");
      assert.strictEqual(yield* git(tree, "diff", "--cached", "--name-only"), "");
      assert.strictEqual(yield* remoteBranch, "");
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

it.live("commits a local worker's edits as Kin, once, and publishes them as one draft PR", () =>
  Effect.gen(function* () {
    const { publish, remoteBranch, requests, log, tree, git } = yield* fixture(
      { "README.md": "# Acme app\n", "src/new.ts": "export {};\n" },
      { local: true },
    );
    const first = yield* publish();
    assert.strictEqual(yield* remoteBranch, first.sha);
    assert.strictEqual(
      yield* log("%an <%ae> %s"),
      "Kin <kin@users.noreply.github.com> Kin worker changes",
    );
    assert.strictEqual(yield* git(tree, "status", "--porcelain"), "");
    // Nothing new to commit the second time: the same commit and the same PR.
    assert.deepStrictEqual(yield* publish(), first);
    assert.strictEqual((yield* log("%H")).split("\n").length, 1);
    assert.lengthOf(
      requests.filter((request) => request.method === "POST"),
      1,
    );
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("refuses a local worker's .github edit after committing it, and pushes nothing", () =>
  Effect.gen(function* () {
    const { publish, remoteBranch, requests } = yield* fixture(
      { "src/fix.ts": "export {};\n" },
      {
        local: true,
        changes: [{ kind: "file", path: ".github/workflows/leak.yml", text: "on: push\n" }],
      },
    );
    assert.include(yield* Effect.flip(publish()), {
      reason: "kin/worker/wk-1 changes .github/, which Kin never publishes",
    });
    assert.strictEqual(yield* remoteBranch, "");
    assert.isFalse(requests.some((request) => request.method === "POST"));
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live("refuses a local publish from anywhere but one of the project's own worktrees", () =>
  Effect.gen(function* () {
    const { publish, requests, root, worker, tree, git } = yield* fixture(
      { "src/fix.ts": "export {};\n" },
      { local: true },
    );
    // Another checkout on the same branch name, which the project never made.
    yield* git(root, "clone", "--quiet", worker, `${root}/elsewhere`);
    yield* git(`${root}/elsewhere`, "switch", "--quiet", "-c", Publish.publishBranch(workerId));
    for (const path of [`${root}/elsewhere`, worker, `${tree}/src`, `${root}/missing`])
      assert.include(yield* Effect.flip(publish(path)), {
        reason: "the worktree isn't one of the project's own",
      });
    assert.lengthOf(requests, 0);
  }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live(
  "records each write as it lands, skips a push GitHub already holds, and reads back what is there",
  () =>
    Effect.gen(function* () {
      const { publish, inspect, outcomes, admitted, head } = yield* fixture({
        "src/fix.ts": "export {};\n",
      });
      assert.deepStrictEqual(yield* inspect, { branchSha: null, pullRequest: null });
      yield* publish();
      const pull = { url: "https://github.com/acme/app/pull/7", number: 7 };
      assert.deepStrictEqual(admitted, ["push", "pull_request"]);
      assert.deepStrictEqual(outcomes, [
        { step: "push", sha: head },
        { step: "pull_request", ...pull },
      ]);
      assert.deepStrictEqual(yield* inspect, { branchSha: head, pullRequest: pull });
      // Already on GitHub: nothing is written again, and what is there is recorded.
      yield* publish();
      assert.deepStrictEqual(admitted, ["push", "pull_request"]);
      assert.deepStrictEqual(outcomes.slice(2), [
        { step: "push", sha: head },
        { step: "pull_request", ...pull },
      ]);
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.live(
  "pushes new commits on top of Kin's branch, and never over commits GitHub has that the worker lacks",
  () =>
    Effect.gen(function* () {
      const { publish, remoteBranch, root, worker, origin, git, admitted } = yield* fixture({
        "src/fix.ts": "export {};\n",
      });
      const fs = yield* FileSystem.FileSystem;
      yield* publish();
      // The worker carries on: a fast-forward is pushed.
      yield* fs.writeFileString(`${worker}/src/more.ts`, "export {};\n");
      yield* git(worker, "add", "src/more.ts");
      yield* git(worker, "commit", "--quiet", "-m", "more");
      const ahead = yield* git(worker, "rev-parse", "HEAD");
      yield* publish();
      assert.strictEqual(yield* remoteBranch, ahead);
      // Someone else adds a commit to Kin's branch on GitHub.
      const branch = Publish.publishBranch(workerId);
      yield* git(root, "clone", "--quiet", "--branch", branch, origin, `${root}/other`);
      yield* fs.writeFileString(`${root}/other/theirs.ts`, "export {};\n");
      yield* git(`${root}/other`, "add", "theirs.ts");
      yield* git(`${root}/other`, "commit", "--quiet", "-m", "theirs");
      yield* git(`${root}/other`, "push", "--quiet", "origin", branch);
      const theirs = yield* git(`${root}/other`, "rev-parse", "HEAD");
      const pushes = admitted.filter((step) => step === "push").length;
      assert.include(yield* Effect.flip(publish()), {
        reason: `${branch} on GitHub has commits the worker's branch doesn't, and Kin never force-pushes`,
        diverged: true,
      });
      assert.strictEqual(yield* remoteBranch, theirs);
      assert.strictEqual(admitted.filter((step) => step === "push").length, pushes);
    }).pipe(Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer)), Effect.scoped),
);
