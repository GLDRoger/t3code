import { type KinWorkerId, RepoSlug } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { gitHubAnswer, repoPath } from "../github/githubRest.ts";
import { KinGitHubApp } from "../github/KinGitHubApp.ts";

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
  { reason: Schema.String },
) {}

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
      readonly title: string;
    }) => Effect.Effect<PublishedPullRequest, KinWorkerPublishRefused>;
  }
>()("t3/kin/lead/workerPublish/KinWorkerPublish") {}

// One argument for the ext transport, under the worker's home; kin-worker.sh checks it again.
const safePath = /^\/[A-Za-z0-9._/-]+$/;
const safeRef = /^[A-Za-z0-9._/-]+$/;
const WORKFLOWS = ".github/workflows/";

const isRepoSlug = Schema.is(RepoSlug);
const decodePull = Schema.decodeUnknownOption(
  Schema.Struct({ number: Schema.Int, html_url: Schema.String }),
);
const refuse = (reason: string) => new KinWorkerPublishRefused({ reason });

export const make = Effect.fn("KinWorkerPublish.make")(function* (
  transport: KinWorkerPublishTransport,
) {
  const app = yield* KinGitHubApp;
  const client = yield* HttpClient.HttpClient;
  const vcs = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const { stateDir } = yield* ServerConfig;

  // Kin's own bare repository, named explicitly: its config, hooks and refs are Kin's alone.
  const git = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv; readonly ext?: boolean } = {},
  ) =>
    vcs
      .run({
        operation: "KinWorkerPublish.git",
        command: "git",
        cwd,
        args: [
          "--no-replace-objects",
          `--git-dir=${cwd}`,
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
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GIT_NO_REPLACE_OBJECTS: "1",
          // Drops any config the server's own environment carries; `auth` sets its own.
          GIT_CONFIG_COUNT: "0",
          ...options.env,
        },
        timeoutMs: 120_000,
      })
      .pipe(Effect.map((result) => result.stdout.trim()));

  const publish: KinWorkerPublish["Service"]["publish"] = Effect.fn("KinWorkerPublish.publish")(
    function* (input) {
      const match = /^github\.com\/([^/]+\/[^/]+)$/i.exec(input.repositoryKey);
      const repo = match?.[1];
      if (repo === undefined || !isRepoSlug(repo))
        return yield* refuse("the worker project isn't a GitHub repository");
      if (!safePath.test(input.worktreePath) || input.worktreePath.split("/").includes(".."))
        return yield* refuse("the worker environment reported an unusable worktree path");
      const branch = publishBranch(input.workerId);
      const incoming = `refs/kin/incoming/${input.workerId}`;

      // Contents write stays here: `holder: "server"` is fixed, never taken from any input.
      const minted = yield* app
        .installationToken({
          repo,
          permissions: { contents: "write", pull_requests: "write" },
          holder: "server",
        })
        .pipe(
          Effect.mapError((error) => refuse(`the Kin GitHub App gave no token (${error._tag})`)),
        );
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

      const about = yield* call("repos.get", "GET", "");
      const base =
        about.status === 200 && typeof about.body === "object" && about.body !== null
          ? (about.body as { default_branch?: unknown }).default_branch
          : undefined;
      if (typeof base !== "string" || !safeRef.test(base))
        return yield* refuse("GitHub didn't name the repository's default branch");

      const name = Hex.encode(
        yield* digest.digest(Digest.sha256, new TextEncoder().encode(repo.toLowerCase())),
      ).slice(0, 32);
      const cache = `${stateDir}/kin-worker-publish/${name}.git`;
      const failed = (step: string) => () => refuse(`git couldn't ${step}`);
      if (!(yield* fs.exists(`${cache}/HEAD`).pipe(Effect.orElseSucceed(() => false)))) {
        yield* fs
          .makeDirectory(cache, { recursive: true })
          .pipe(Effect.mapError(failed("make Kin's cache")));
        yield* git(cache, ["init", "--bare", "--quiet", cache]).pipe(
          Effect.mapError(failed("make Kin's cache")),
        );
      }
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
      yield* git(
        cache,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          "--",
          transport.worker(input.worktreePath),
          `+refs/heads/${branch}:${incoming}`,
        ],
        { ext: true },
      ).pipe(Effect.mapError(failed(`fetch ${branch} from the worker environment`)));
      const head = yield* git(cache, ["rev-parse", "--verify", `${incoming}^{commit}`]).pipe(
        Effect.mapError(failed("read the worker's branch")),
      );
      const range = `refs/kin/base..${head}`;
      const ahead = yield* git(cache, ["rev-list", "--count", range]).pipe(
        Effect.mapError(failed("compare the branch")),
      );
      if (ahead === "0") return yield* refuse(`${branch} has no commits past ${base}`);
      // Every commit, merges against each parent: GitHub refuses the App these paths anyway.
      const paths = yield* git(cache, [
        "log",
        "--format=",
        "--name-only",
        "--no-renames",
        "-m",
        range,
      ]).pipe(Effect.mapError(failed("list the branch's changes")));
      if (paths.split("\n").some((path) => path.startsWith(WORKFLOWS)))
        return yield* refuse(`${branch} changes ${WORKFLOWS}, which Kin never publishes`);

      // Kin's branch for this worker only, so a follow-up's rewrite replaces it.
      yield* git(
        cache,
        [
          "push",
          "--quiet",
          "--no-verify",
          "--",
          transport.github(repo),
          `+${head}:refs/heads/${branch}`,
        ],
        { env: auth },
      ).pipe(Effect.mapError(failed(`push ${branch} to GitHub`)));

      const owner = repo.split("/")[0]!;
      const listed = yield* call(
        "pulls.list",
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=1`,
      );
      const existing =
        listed.status === 200 && Array.isArray(listed.body)
          ? decodePull(listed.body[0])
          : undefined;
      if (existing !== undefined && existing._tag === "Some")
        return { url: existing.value.html_url, number: existing.value.number, sha: head };
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
      return { url: pull.value.html_url, number: pull.value.number, sha: head };
    },
  );

  return KinWorkerPublish.of({ publish });
});

export const layer = Layer.effect(KinWorkerPublish, make(hostTransport));
