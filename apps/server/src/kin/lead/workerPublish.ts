import { type KinWorkerId, RepoSlug, T3_PROJECT_FILE_NAME } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { gitHubAnswer, repoPath } from "../github/githubRest.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";
import type { Found, PublishOutcome, PublishStep } from "../work/workerAttempts.ts";

/** The only branch a worker's work is published to, there and on GitHub. */
export const publishBranch = (workerId: KinWorkerId) => `kin/worker/${workerId}`;

/** How Kin reaches the two repositories; tests swap both for local ones. */
export interface KinWorkerPublishTransport {
  /** A git URL whose upload-pack serves the worker's repository at `worktreePath`, read-only. */
  readonly worker: (worktreePath: string) => string;
  readonly github: (repo: RepoSlug) => string;
}

/**
 * kin-worker.sh's `upload-pack`, which root runs as `kin-worker` in the worker sandbox with a
 * byte cap: Kin reads the branch without holding any credential there or giving one to it.
 */
const hostTransport: KinWorkerPublishTransport = {
  worker: (worktreePath) =>
    `ext::/usr/bin/sudo -n /usr/local/sbin/kin-worker upload-pack ${worktreePath}`,
  github: (repo) => `https://github.com/${repo}.git`,
};

export class KinWorkerPublishRefused extends Schema.TaggedError<KinWorkerPublishRefused>()(
  "KinWorkerPublishRefused",
  // Fixed text only: never a token, and never words from the worker environment.
  {
    reason: Schema.String,
    /** GitHub's branch has commits the worker's doesn't; Kin never force-pushes over them. */
    diverged: Schema.optional(Schema.Boolean),
  },
) {}

/** Each write a publish makes, in order; the two after `commit` reach GitHub. */
export type { PublishStep, PublishOutcome, Found } from "../work/workerAttempts.ts";
/** A write about to start, with the commit it writes when it reaches GitHub. */
export type PublishIntent = { readonly step: PublishStep; readonly sha: string | null };

export interface PublishedPullRequest {
  readonly url: string;
  readonly number: number;
  readonly sha: string;
}

/**
 * Publishes a worker's branch as a draft PR. Workers hold no GitHub write credential: Kin fetches
 * `kin/worker/<id>` from the worker environment, checks it, and pushes it with a `server` App
 * token that never leaves this process. Server-only: no lead or worker tool reaches it.
 */
export class KinWorkerPublish extends Context.Service<
  KinWorkerPublish,
  {
    readonly publish: (input: {
      readonly workerId: KinWorkerId;
      /** `github.com/<owner>/<repo>`, from this host's worker project. */
      readonly repositoryKey: string;
      /** The worker's worktree there, as its server reports it. */
      readonly worktreePath: string;
      /**
       * A worker on this server, which has no shell: Kin commits its edits, from a worktree that
       * must be one of `projectRoot`'s own.
       */
      readonly local?: { readonly projectRoot: string };
      readonly title: string;
      readonly progress: {
        /**
         * Just before each write, recorded durably: a refusal ends the publish there, so no write
         * starts after the owner's pause or a stop of the worker.
         */
        readonly begin: (intent: PublishIntent) => Effect.Effect<void, KinWorkerPublishRefused>;
        /** What a write left, or what Kin found already there, as soon as it is known. */
        readonly done: (outcome: PublishOutcome) => Effect.Effect<void, KinWorkerPublishRefused>;
      };
    }) => Effect.Effect<PublishedPullRequest, KinWorkerPublishRefused>;
    /** The worker's branch on GitHub and the open PR from it, for a write whose answer was lost. */
    readonly inspect: (input: {
      readonly workerId: KinWorkerId;
      readonly repositoryKey: string;
    }) => Effect.Effect<Found, KinWorkerPublishRefused>;
  }
>()("t3/kin/lead/workerPublish/KinWorkerPublish") {}

// One argument for the ext transport, under the worker's home; kin-worker.sh checks it again.
const safePath = /^\/[A-Za-z0-9._/-]+$/;
const safeRef = /^[A-Za-z0-9._/-]+$/;
// The whole directory: workflows, and the composite actions they feed secrets to.
const GITHUB_DIR = ".github";
const touchesGitHubDir = (path: string) => {
  const lower = path.toLowerCase();
  return lower === GITHUB_DIR || lower.startsWith(`${GITHUB_DIR}/`);
};
// Its scripts run with a shell on every machine that opens a worktree of the project.
const touchesProjectFile = (path: string) =>
  path.split("/").at(-1)?.toLowerCase() === T3_PROJECT_FILE_NAME;
const SYMLINK_MODE = "120000";
const rawMeta = /^:\d{6} (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/;
/** `git log --raw -z --no-renames`: a meta field, then its path; `undefined` if it isn't that. */
const parseRawChanges = (out: string) => {
  const fields = out.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return undefined;
  const changes: Array<{ readonly mode: string; readonly path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const mode = rawMeta.exec(fields[index]!.trim())?.[1];
    if (mode === undefined) return undefined;
    changes.push({ mode, path: fields[index + 1]! });
  }
  return changes;
};
/** Who the commit Kin makes for a worker on this server is by. */
const COMMITTER = ["-c", "user.name=Kin", "-c", "user.email=kin@users.noreply.github.com"];
/** The most a worker's fetch may add to Kin's disk; the transfer cap only bounds the wire. */
const MAX_INCOMING_BYTES = 1024 * 1024 * 1024;

const isRepoSlug = Schema.is(RepoSlug);
const decodePull = Schema.decodeUnknownOption(
  Schema.Struct({ number: Schema.Int, html_url: Schema.String }),
);
const refuse = (reason: string) => new KinWorkerPublishRefused({ reason });

// Kin's git sees only the git and ssh settings it sets, none from the server's environment.
const scrubbedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^(GIT_|SSH_)/i.test(name))
      .map((name) => [name, undefined]),
  );

export const make = Effect.fn("KinWorkerPublish.make")(function* (
  transport: KinWorkerPublishTransport,
  options: { readonly maxIncomingBytes?: number } = {},
) {
  const maxIncomingBytes = options.maxIncomingBytes ?? MAX_INCOMING_BYTES;
  const app = yield* KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const vcs = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const { stateDir } = yield* ServerConfig;
  // One scratch repository per publish lives here; a crash can leave one, so start empty.
  const scratchRoot = `${stateDir}/kin-worker-publish`;
  yield* fs.remove(scratchRoot, { recursive: true, force: true }).pipe(Effect.ignore);

  // Kin's own bare repository, named explicitly: its config, hooks and refs are Kin's alone. With
  // `worktree`, a local worker's checkout instead, whose git metadata the worker can't write.
  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly env?: NodeJS.ProcessEnv;
      readonly ext?: boolean;
      readonly raw?: boolean;
      readonly worktree?: boolean;
    } = {},
  ) =>
    vcs
      .run({
        operation: "KinWorkerPublish.git",
        command: "git",
        cwd,
        args: [
          "--no-replace-objects",
          options.worktree === true ? `--work-tree=${cwd}` : `--git-dir=${cwd}`,
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "transfer.fsckObjects=true",
          "-c",
          `protocol.ext.allow=${options.ext === true ? "always" : "never"}`,
          ...args,
        ],
        env: {
          ...scrubbedEnv(),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_COUNT: "0",
          ...options.env,
        },
        timeoutMs: 120_000,
      })
      .pipe(Effect.map((result) => (options.raw === true ? result.stdout : result.stdout.trim())));

  // Loose objects, packs and garbage, as this repository's own git counts them.
  const diskBytes = (repo: string) =>
    git(repo, ["count-objects", "-v"]).pipe(
      Effect.map((out) =>
        out
          .split("\n")
          .map((line) => /^(size|size-pack|size-garbage): (\d+)$/.exec(line)?.[2])
          .reduce((total, kib) => total + (kib === undefined ? 0 : Number(kib) * 1024), 0),
      ),
    );

  /**
   * Commits a local worker's edits on its branch, once: a second publish finds nothing new. The
   * worktree must be registered to the project's own checkout, which Kin's server cloned.
   */
  const commitLocal = Effect.fn("KinWorkerPublish.commitLocal")(function* (
    worktreePath: string,
    local: { readonly projectRoot: string },
    branch: string,
    progress: Parameters<KinWorkerPublish["Service"]["publish"]>[0]["progress"],
  ) {
    const failed = (step: string) => () => refuse(`git couldn't ${step}`);
    const outside = refuse("the worktree isn't one of the project's own");
    const real = (path: string) => fs.realPath(path).pipe(Effect.mapError(() => outside));
    const worktree = yield* real(worktreePath);
    const root = yield* real(local.projectRoot);
    if (worktree === root) return yield* outside;
    const listed = yield* git(root, ["worktree", "list", "--porcelain", "-z"], {
      raw: true,
      worktree: true,
    }).pipe(Effect.mapError(failed("list the project's worktrees")));
    const registered = yield* Effect.forEach(
      listed
        .split("\0")
        .flatMap((line) => (line.startsWith("worktree ") ? [line.slice("worktree ".length)] : [])),
      (path) => fs.realPath(path).pipe(Effect.orElseSucceed(() => undefined)),
    );
    if (!registered.includes(worktree)) return yield* outside;
    const head = yield* git(worktree, ["symbolic-ref", "--quiet", "HEAD"], {
      worktree: true,
    }).pipe(Effect.mapError(failed("read the worktree's branch")));
    if (head !== `refs/heads/${branch}`) return yield* refuse(`the worktree isn't on ${branch}`);
    const changes = yield* git(worktree, ["status", "--porcelain", "-z"], {
      raw: true,
      worktree: true,
    }).pipe(Effect.mapError(failed("read the worktree's changes")));
    if (changes.length === 0) return;
    // Admitted whole: once staging starts, the commit finishes, so a stop never leaves half of one.
    yield* progress.begin({ step: "commit", sha: null });
    yield* git(worktree, ["add", "--all"], { worktree: true }).pipe(
      Effect.mapError(failed("stage the worker's changes")),
    );
    yield* git(
      worktree,
      [...COMMITTER, "commit", "--quiet", "--no-verify", "-m", "Kin worker changes"],
      {
        worktree: true,
      },
    ).pipe(Effect.mapError(failed("commit the worker's changes")));
    const sha = yield* git(worktree, ["rev-parse", "--verify", "HEAD"], { worktree: true }).pipe(
      Effect.mapError(failed("read the worker's commit")),
    );
    yield* progress.done({ step: "commit", sha });
  });

  /** A server token for the repository and a REST call with it; nothing else holds the token. */
  const connect = Effect.fn("KinWorkerPublish.connect")(function* (repositoryKey: string) {
    const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(repositoryKey);
    const repo = match?.[1];
    if (repo === undefined || !isRepoSlug(repo))
      return yield* refuse("the worker project isn't a GitHub repository");
    // Contents write stays here: `holder: "server"` is fixed, never taken from any input.
    const minted = yield* app
      .installationToken({
        repo,
        permissions: { contents: "write", pull_requests: "write" },
        holder: "server",
      })
      .pipe(Effect.mapError((error) => refuse(`the Kin GitHub App gave no token (${error._tag})`)));
    const token = minted.token;
    const auth = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${Redacted.value(token)}`).toString("base64")}`,
    };
    const call = (operation: string, method: "GET" | "POST", path: string, body?: unknown) =>
      gitHubAnswer({
        client,
        operation,
        method,
        path: `${repoPath(repo)}${path}`,
        token,
        timeout: "30 seconds",
        ...(body === undefined ? {} : { body }),
      }).pipe(Effect.mapError(() => refuse(`could not reach GitHub for ${operation}`)));
    const openPull = Effect.fn("KinWorkerPublish.openPull")(function* (branch: string) {
      const owner = repo.split("/")[0]!;
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
      );
      if (listed.status !== 200 || !Array.isArray(listed.body))
        return yield* refuse(`GitHub didn't list the open PRs (HTTP ${listed.status})`);
      const found = decodePull(listed.body[0]);
      return found._tag === "Some"
        ? { url: found.value.html_url, number: found.value.number }
        : null;
    });
    return { repo, auth, call, openPull };
  });

  /** A fresh bare repository for one publish or check only, removed when it ends however it ends. */
  const scratch = Effect.gen(function* () {
    const failed = () => refuse("git couldn't make Kin's scratch repository");
    yield* fs.makeDirectory(scratchRoot, { recursive: true }).pipe(Effect.mapError(failed));
    const cache = yield* fs
      .makeTempDirectoryScoped({ directory: scratchRoot, prefix: "publish-" })
      .pipe(Effect.mapError(failed));
    yield* git(cache, ["init", "--bare", "--quiet", cache]).pipe(Effect.mapError(failed));
    return cache;
  });

  /** The commit Kin's branch is at on GitHub, or undefined when there is no such branch. */
  const remoteHead = (cache: string, url: string, auth: NodeJS.ProcessEnv, branch: string) =>
    git(cache, ["ls-remote", "--heads", "--", url, `refs/heads/${branch}`], { env: auth }).pipe(
      Effect.mapError(() => refuse(`could not reach GitHub to read ${branch}`)),
      Effect.map((out) => {
        const sha = out.split("\n").find((line) => line.endsWith(`\trefs/heads/${branch}`));
        return sha === undefined ? undefined : sha.slice(0, sha.indexOf("\t"));
      }),
    );

  const publish: KinWorkerPublish["Service"]["publish"] = Effect.fn("KinWorkerPublish.publish")(
    function* (input) {
      if (!/^github\.com\/([^/]+\/[^/]+)$/i.test(input.repositoryKey))
        return yield* refuse("the worker project isn't a GitHub repository");
      if (!safePath.test(input.worktreePath) || input.worktreePath.split("/").includes(".."))
        return yield* refuse("the worker environment reported an unusable worktree path");
      const branch = publishBranch(input.workerId);
      const incoming = `refs/kin/incoming/${input.workerId}`;
      const failed = (step: string) => () => refuse(`git couldn't ${step}`);
      if (input.local !== undefined)
        yield* commitLocal(input.worktreePath, input.local, branch, input.progress);
      const { repo, auth, call, openPull } = yield* connect(input.repositoryKey);

      const about = yield* call("repos.get", "GET", "");
      const base =
        about.status === 200 && typeof about.body === "object" && about.body !== null
          ? (about.body as { default_branch?: unknown }).default_branch
          : undefined;
      if (typeof base !== "string" || !safeRef.test(base))
        return yield* refuse("GitHub didn't name the repository's default branch");

      const cache = yield* scratch;
      yield* git(
        cache,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          transport.github(repo),
          `+refs/heads/${base}:refs/kin/base`,
        ],
        { env: auth },
      ).pipe(Effect.mapError(failed(`fetch ${base} from GitHub`)));
      const baseline = yield* diskBytes(cache).pipe(Effect.mapError(failed("measure Kin's copy")));
      yield* git(
        cache,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          input.local === undefined ? transport.worker(input.worktreePath) : input.worktreePath,
          `+refs/heads/${branch}:${incoming}`,
        ],
        { ext: input.local === undefined },
      ).pipe(Effect.mapError(failed(`fetch ${branch} from the worker environment`)));
      const incomingBytes =
        (yield* diskBytes(cache).pipe(Effect.mapError(failed("measure Kin's copy")))) - baseline;
      if (incomingBytes > maxIncomingBytes)
        return yield* refuse(
          `${branch} takes more than ${Math.floor(maxIncomingBytes / 1024 / 1024)} MiB on disk`,
        );
      const head = yield* git(cache, ["rev-parse", "--verify", `${incoming}^{commit}`]).pipe(
        Effect.mapError(failed("read the worker's branch")),
      );
      const range = `refs/kin/base..${head}`;
      const ahead = yield* git(cache, ["rev-list", "--count", range]).pipe(
        Effect.mapError(failed("compare the branch")),
      );
      if (ahead === "0") return yield* refuse(`${branch} has no commits past ${base}`);
      // Every commit, merges against each parent, raw NUL-separated paths. The App also lacks
      // the `workflows` permission, so GitHub refuses a push that changes workflows anyway.
      const history = yield* git(
        cache,
        [
          "log",
          "--format=",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "--diff-merges=separate",
          "-z",
          range,
        ],
        { raw: true },
      ).pipe(Effect.mapError(failed("list the branch's changes")));
      const changes = parseRawChanges(history);
      if (changes === undefined) return yield* refuse("git listed the branch's changes unreadably");
      if (changes.some((change) => touchesGitHubDir(change.path)))
        return yield* refuse(`${branch} changes ${GITHUB_DIR}/, which Kin never publishes`);
      if (changes.some((change) => touchesProjectFile(change.path)))
        return yield* refuse(
          `${branch} changes ${T3_PROJECT_FILE_NAME}, whose scripts T3 Code runs, which Kin never publishes`,
        );
      // A link's target is only a string to git; where it leads depends on the checkout.
      if (changes.some((change) => change.mode === SYMLINK_MODE))
        return yield* refuse(
          `${branch} adds or changes a symbolic link, which Kin never publishes`,
        );

      // Kin never force-pushes: a branch there with commits this one lacks stays as it is.
      const url = transport.github(repo);
      const there = yield* remoteHead(cache, url, auth, branch);
      if (there !== head) {
        if (there !== undefined) {
          yield* git(
            cache,
            [
              "fetch",
              "--quiet",
              "--no-tags",
              "--",
              url,
              `+refs/heads/${branch}:refs/kin/published`,
            ],
            { env: auth },
          ).pipe(Effect.mapError(failed(`fetch ${branch} from GitHub`)));
          const missing = yield* git(cache, [
            "rev-list",
            "--count",
            `${head}..refs/kin/published`,
          ]).pipe(Effect.mapError(failed("compare the branch with GitHub's")));
          if (missing !== "0")
            return yield* new KinWorkerPublishRefused({
              reason: `${branch} on GitHub has commits the worker's branch doesn't, and Kin never force-pushes`,
              diverged: true,
            });
        }
        yield* input.progress.begin({ step: "push", sha: head });
        yield* git(
          cache,
          ["push", "--quiet", "--no-verify", "--", url, `${head}:refs/heads/${branch}`],
          { env: auth },
        ).pipe(Effect.mapError(failed(`push ${branch} to GitHub`)));
      }
      yield* input.progress.done({ step: "push", sha: head });

      const existing = yield* openPull(branch);
      if (existing !== null) {
        yield* input.progress.done({ step: "pull_request", ...existing });
        return { ...existing, sha: head };
      }
      yield* input.progress.begin({ step: "pull_request", sha: head });
      const opened = yield* call("pulls.create", "POST", "/pulls", {
        title: input.title,
        head: branch,
        base,
        draft: true,
        body: `Opened by Kin from worker \`${input.workerId}\` at \`${head}\`. Kin pushes this branch; the worker has no write access.`,
      });
      const pull = opened.status === 201 ? decodePull(opened.body) : undefined;
      if (pull === undefined || pull._tag === "None")
        return yield* refuse(`GitHub didn't open the draft PR (HTTP ${opened.status})`);
      const created = { url: pull.value.html_url, number: pull.value.number };
      yield* input.progress.done({ step: "pull_request", ...created });
      return { ...created, sha: head };
    },
    Effect.scoped,
  );

  const inspect: KinWorkerPublish["Service"]["inspect"] = Effect.fn("KinWorkerPublish.inspect")(
    function* (input) {
      const branch = publishBranch(input.workerId);
      const { repo, auth, openPull } = yield* connect(input.repositoryKey);
      const cache = yield* scratch;
      const branchSha = (yield* remoteHead(cache, transport.github(repo), auth, branch)) ?? null;
      return { branchSha, pullRequest: yield* openPull(branch) };
    },
    Effect.scoped,
  );

  return KinWorkerPublish.of({ publish, inspect });
});

export const layer = Layer.effect(KinWorkerPublish, make(hostTransport));
