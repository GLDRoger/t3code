import { RepoSlug, type KinOrgId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { memoryGit } from "./git.ts";
import {
  Memory,
  type MemoryConfigError,
  MemoryError,
  MemoryRecoveryHooks,
  MemorySyncConflict,
} from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import {
  MemoryPullRequests,
  REVIEW_BRANCH_SUFFIX,
  WRITE_BRANCH_PREFIX,
} from "./MemoryPullRequests.ts";
import { readCommit, readTree, verifyTree } from "./objects.ts";

/** Where a wake-up's changes on owner-reviewed paths wait for the lander; named `<agent>/<id>-<sha12>`. */
export const REVIEW_REF_PREFIX = "refs/kin/review/";

export type LandingOutcome =
  /** GitHub holds everything this server does. */
  | { readonly _tag: "idle" }
  | { readonly _tag: "merged"; readonly url: string; readonly commit: string }
  /** Refused or unreachable; the local commits stay, and landing waits for a new one. */
  | { readonly _tag: "stuck"; readonly reason: string }
  /** Still stuck on the same local head, so nothing was tried. */
  | { readonly _tag: "waiting" };

/** Told after every landing run, for tests and logs; never on the wake-up path. */
export class MemoryLanderHooks extends Context.Reference<{
  readonly settled: (orgId: KinOrgId, outcome: LandingOutcome) => Effect.Effect<void>;
}>("t3/kin/memory/MemoryLander/MemoryLanderHooks", {
  defaultValue: () => ({ settled: () => Effect.void }),
}) {}

/**
 * Takes what the local default branch holds and the remote lacks to GitHub, one PR at a time per
 * org, off the wake-up path (TRIG-15). Server-only: no lead, worker or MCP tool reaches it.
 */
export class MemoryLander extends Context.Service<
  MemoryLander,
  {
    /** Wakes the org's lander and returns at once; signals during a landing ride the next batch. */
    readonly signal: (orgId: KinOrgId) => Effect.Effect<void>;
    /** Closes `kin/write/*` PRs no landing waits on and tells the owner about moved review PRs. */
    readonly sweep: (
      orgId: KinOrgId,
    ) => Effect.Effect<void, MemorySyncConflict | MemoryConfigError | MemoryError>;
  }
>()("t3/kin/memory/MemoryLander") {}

const isRepoSlug = Schema.is(RepoSlug);
// Each batch is one PR and one CI run; past this, the next signal carries on.
const MAX_BATCHES_PER_RUN = 20;

const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const config = yield* MemoryConfig;
  const recovery = yield* MemoryRecoveryHooks;
  const hooks = yield* MemoryLanderHooks;
  const pullRequests = yield* Effect.serviceOption(MemoryPullRequests);
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess;
  const main = config.defaultBranch ?? "main";
  const identity = {
    GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
    GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
    GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
    GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
  };
  // The local head each org's landing stopped on; a new head, or a restart, tries again.
  const stuck = new Map<KinOrgId, { readonly local: string; readonly reason: string }>();
  // Review PRs GitHub keeps refusing to close are reported once per process, not every sweep.
  const reportedOpen = new Set<string>();
  const signals = new Map<KinOrgId, Queue.Queue<void>>();

  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | VcsProcess>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const git = (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) =>
    memoryGit(cwd, args, stdin, env).pipe(
      Effect.provideService(MemoryConfig, config),
      provide,
      Effect.map((out) => out.trim()),
      Effect.mapError((cause) => new MemoryError({ orgId, operation: "land", cause })),
    );
  const githubRepo = (orgId: KinOrgId) => {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    return repo?.githubRepo !== undefined && isRepoSlug(repo.githubRepo)
      ? { repoUrl: repo.repoUrl, github: repo.githubRepo }
      : undefined;
  };

  const refuse = Effect.fn("MemoryLander.refuse")(function* (
    orgId: KinOrgId,
    local: string,
    reason: string,
    options: { readonly url?: string; readonly told?: boolean } = {},
  ) {
    const held = stuck.get(orgId);
    stuck.set(orgId, { local, reason });
    // One notice per problem: a retry that fails the same way stays quiet.
    if (options.told !== true && held?.reason !== reason)
      yield* recovery.notify({
        orgId,
        branch: main,
        reason: `Memory write not merged: ${reason}${options.url ? ` (${options.url})` : ""}. Memory is still saved on this server; the GitHub copy is behind until Kin lands it, which it tries again with the next memory change or restart`,
      });
    return { _tag: "stuck", reason } as const;
  });

  /** Rebuilds each waiting review commit on the remote head and opens its PR for the owner. */
  const openReviews = Effect.fn("MemoryLander.openReviews")(function* (
    orgId: KinOrgId,
    writer: string,
    remote: string,
    target: { readonly repoUrl: string; readonly github: RepoSlug },
  ) {
    if (Option.isNone(pullRequests)) return;
    const listed = yield* git(orgId, writer, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      REVIEW_REF_PREFIX,
    ]);
    for (const line of listed.split("\n").filter(Boolean)) {
      const [ref, sha] = line.split(" ");
      if (!ref || !sha) continue;
      const name = ref.slice(REVIEW_REF_PREFIX.length);
      const branch = `${WRITE_BRANCH_PREFIX}${name}${REVIEW_BRANCH_SUFFIX}`;
      const opened = yield* Effect.gen(function* () {
        const own = yield* provide(readCommit(orgId, writer, sha));
        if (own.parent === undefined)
          return yield* new MemorySyncConflict({
            orgId,
            operation: "push",
            reason: "the review commit has no parent",
          });
        const before = new Map(
          (yield* provide(readTree(orgId, writer, own.parent))).map((entry) => [
            entry.relative,
            entry,
          ]),
        );
        const changed = (yield* provide(readTree(orgId, writer, sha))).filter((entry) => {
          const prior = before.get(entry.relative);
          return prior?.sha !== entry.sha || prior.mode !== entry.mode;
        });
        const expected = new Map(
          (yield* provide(readTree(orgId, writer, remote))).map((entry) => [
            entry.relative,
            { mode: entry.mode, sha: entry.sha },
          ]),
        );
        for (const entry of changed)
          expected.set(entry.relative, { mode: entry.mode, sha: entry.sha });
        const commit = yield* Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs
              .makeTempDirectoryScoped()
              .pipe(
                Effect.mapError((cause) => new MemoryError({ orgId, operation: "land", cause })),
              );
            const env = { ...identity, GIT_INDEX_FILE: `${temporary}/index` };
            yield* git(orgId, writer, ["read-tree", remote], env);
            yield* git(
              orgId,
              writer,
              ["update-index", "--index-info"],
              env,
              changed.map((entry) => `${entry.mode} ${entry.sha}\t${entry.relative}`).join("\n") +
                "\n",
            );
            const tree = yield* git(orgId, writer, ["write-tree"], env);
            yield* provide(verifyTree(orgId, writer, tree, expected));
            return yield* git(orgId, writer, ["commit-tree", tree, "-p", remote], env, own.message);
          }),
        );
        yield* git(orgId, writer, [
          "push",
          "--",
          target.repoUrl,
          `+${commit}:refs/heads/${branch}`,
        ]).pipe(
          Effect.mapError(
            () =>
              new MemorySyncConflict({
                orgId,
                operation: "push",
                reason: "Memory PR branch push rejected",
              }),
          ),
        );
        const title = own.message.split("\n")[0] ?? own.message;
        const landed = yield* pullRequests.value.land({
          orgId,
          repo: target.github,
          branch,
          base: main,
          sha: commit,
          title,
          message: own.message,
          ownerReview: true,
        });
        return { url: landed.url, commit };
      }).pipe(Effect.result);
      yield* recovery.notify({
        orgId,
        branch,
        reason:
          opened._tag === "Success"
            ? `Memory changes on paths you review wait in ${opened.success.url}. Kin pushed \`${opened.success.commit}\`; if the PR's head differs, close it`
            : `Memory changes on paths you review were not opened as a PR: ${"reason" in opened.failure && typeof opened.failure.reason === "string" ? opened.failure.reason : opened.failure._tag}`,
      });
      yield* git(orgId, writer, ["update-ref", "-d", ref, sha]);
    }
  });

  const landOnce = Effect.fn("MemoryLander.landOnce")(function* (orgId: KinOrgId) {
    const target = githubRepo(orgId);
    if (Option.isNone(pullRequests) || target === undefined) return { _tag: "idle" } as const;
    // Under the writer lock: sync merges what GitHub merged, so `local` descends from it.
    const state = yield* memory.landingState(orgId);
    if (state === undefined) return { _tag: "idle" } as const;
    const { writer, local, remote } = state;
    if (remote !== undefined && !remote.pending) {
      stuck.delete(orgId);
      yield* openReviews(orgId, writer, remote.head, target);
      return { _tag: "idle" } as const;
    }
    if (stuck.get(orgId)?.local === local) return { _tag: "waiting" } as const;
    if (remote === undefined) return yield* refuse(orgId, local, "Kin could not reach GitHub");
    // Sync told the owner when it could not combine the two.
    if (!remote.descends)
      return yield* refuse(orgId, local, "GitHub's copy changed in a way Kin could not combine", {
        told: true,
      });
    // One commit on GitHub's head with this server's tree, so the PR holds just what GitHub lacks.
    const tree = yield* git(orgId, writer, ["rev-parse", `${local}^{tree}`]);
    const message = `kin: memory from this server up to ${local.slice(0, 12)}\n\nKin-Local: ${local}\n`;
    const batch = yield* git(
      orgId,
      writer,
      ["commit-tree", tree, "-p", remote.head],
      identity,
      message,
    );
    const branch = `${WRITE_BRANCH_PREFIX}land/${batch.slice(0, 12)}`;
    const pushed = yield* git(orgId, writer, [
      "push",
      "--",
      target.repoUrl,
      `${batch}:refs/heads/${branch}`,
    ]).pipe(Effect.result);
    if (pushed._tag === "Failure")
      return yield* refuse(orgId, local, "GitHub refused Kin's push of the memory branch");
    const landed = yield* pullRequests.value
      .land({
        orgId,
        repo: target.github,
        branch,
        base: main,
        sha: batch,
        title: message.split("\n")[0] ?? message,
        message,
        ownerReview: false,
      })
      .pipe(Effect.result);
    if (landed._tag === "Failure")
      return yield* refuse(
        orgId,
        local,
        landed.failure.reason,
        landed.failure.url === undefined ? {} : { url: landed.failure.url },
      );
    if (landed.success._tag !== "merged")
      return yield* refuse(orgId, local, "GitHub opened the memory PR for review");
    const { url, commit } = landed.success;
    yield* git(orgId, writer, ["push", "--", target.repoUrl, `:refs/heads/${branch}`]).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not delete a merged memory PR branch", { orgId }),
      ),
    );
    // With GitHub's head unmoved, the squash must hold exactly the tree Kin pushed.
    yield* git(orgId, writer, ["fetch", "--", target.repoUrl, commit]);
    const [parent, merged] = [
      yield* git(orgId, writer, ["rev-parse", `${commit}^`]),
      yield* git(orgId, writer, ["rev-parse", `${commit}^{tree}`]),
    ];
    if (parent === remote.head && merged !== tree)
      return yield* refuse(orgId, local, "GitHub merged a different tree than Kin pushed", { url });
    stuck.delete(orgId);
    return { _tag: "merged", url, commit } as const;
  });

  const land = Effect.fn("MemoryLander.land")(function* (orgId: KinOrgId) {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const outcome = yield* landOnce(orgId).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Kin memory landing failed", {
              orgId,
              cause: Cause.pretty(cause),
            });
            const head = yield* memory.anchor(orgId, main).pipe(Effect.option);
            if (Option.isSome(head))
              stuck.set(orgId, { local: head.value, reason: "landing failed" });
            return { _tag: "stuck", reason: "landing failed" } as const;
          }),
        ),
      );
      yield* hooks.settled(orgId, outcome);
      if (outcome._tag !== "merged") return;
    }
    yield* Effect.logWarning("Kin memory landing paused after its batch limit", { orgId });
  });

  const sweep = Effect.fn("MemoryLander.sweep")(function* (orgId: KinOrgId) {
    if (Option.isNone(pullRequests)) return;
    const target = githubRepo(orgId);
    if (target === undefined) return;
    const moved = yield* pullRequests.value
      .sweep({ orgId, repo: target.github, base: main })
      .pipe(
        Effect.mapError(
          (error) => new MemorySyncConflict({ orgId, operation: "sweep", reason: error.reason }),
        ),
      );
    for (const pull of moved) {
      if (!pull.closed && reportedOpen.has(pull.url)) continue;
      if (!pull.closed) reportedOpen.add(pull.url);
      yield* recovery.notify({
        orgId,
        branch: pull.branch,
        reason: pull.closed
          ? `Kin closed ${pull.url}, the memory PR for paths you review: ${pull.reason}`
          : `Kin could not close ${pull.url}, the memory PR for paths you review, and it is still open. Close it without merging: ${pull.reason}`,
      });
    }
  });

  if (Option.isSome(pullRequests))
    for (const { orgId } of config.repositories) {
      const queue = yield* Queue.dropping<void>(1);
      signals.set(orgId, queue);
      // At start, PRs a crash left open are closed before anything lands, so none is duplicated;
      // then whatever the last run left unlanded goes out.
      const resume = sweep(orgId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin memory PR sweep failed at start", {
            orgId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(land(orgId)),
      );
      yield* memory
        .withLandingLock(orgId, resume)
        .pipe(
          Effect.andThen(
            Queue.take(queue).pipe(
              Effect.andThen(memory.withLandingLock(orgId, land(orgId))),
              Effect.forever,
            ),
          ),
          Effect.forkScoped,
        );
    }

  return MemoryLander.of({
    signal: Effect.fn("MemoryLander.signal")(function* (orgId) {
      const queue = signals.get(orgId);
      if (queue !== undefined) yield* Queue.offer(queue, undefined);
    }),
    sweep: Effect.fn("MemoryLander.sweepLocked")((orgId) =>
      memory.withLandingLock(orgId, sweep(orgId)),
    ),
  });
});

export const layer = Layer.effect(MemoryLander, make);
