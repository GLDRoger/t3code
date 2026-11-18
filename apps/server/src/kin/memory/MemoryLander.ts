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
  LANDED_REF,
  Memory,
  type MemoryConfigError,
  MemoryError,
  MemoryRecoveryHooks,
  MemorySyncConflict,
} from "./Memory.ts";
import { gitHubApp } from "../github/KinGitHubApp.ts";
import { MemoryConfig, WRITE_BRANCH_PREFIX } from "./MemoryConfig.ts";
import { memoryIdentity } from "./memoryIdentity.ts";
import { isCheckoutPath, isItemPath } from "./checkoutPaths.ts";
import {
  CODEOWNERS_PATH,
  guardRailsUpdate,
  MEMORY_CHECK_PATH,
  sameGuardRails,
  type GuardRails,
} from "./guardRails.ts";
import { kinShapeFailure } from "./lint.ts";
import { MemoryPullRequests, type MemoryPullRequestRefused } from "./MemoryPullRequests.ts";
import { readTree, verifyTree } from "./objects.ts";

/** The commit of the open guard-rails PR, kept so its head never changes under the owner. */
const GUARD_RAILS_REF = "refs/kin/guard-rails";
const GUARD_RAILS_BRANCH = `${WRITE_BRANCH_PREFIX}guard-rails/`;
// Left by servers from before Kin wrote every memory folder alone; folded in once at start.
const LEGACY_REVIEW_REFS = "refs/kin/review/";
const LEGACY_REVIEW_BRANCH = /-review$/;

export type LandingOutcome =
  /** GitHub holds everything this server does. */
  | { readonly _tag: "idle" }
  | { readonly _tag: "merged"; readonly url: string; readonly commit: string }
  /** Refused or unreachable; the local commits stay, and landing waits for a new one. */
  | { readonly _tag: "stuck"; readonly reason: string }
  /** GitHub merged Kin's guard-rails PR; the next batch starts from its new head. */
  | { readonly _tag: "upgraded" }
  /** Still stuck on the same local head, so nothing was tried. */
  | { readonly _tag: "waiting" };

/** What went wrong, from the error's own tag and reason: a cause can quote git output and URLs. */
const unexpected = (cause: Cause.Cause<unknown>) => {
  const error: unknown = Cause.squash(cause);
  const field = (name: string) => {
    const value =
      typeof error === "object" && error !== null ? Reflect.get(error, name) : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const detail = [field("_tag"), field("reason") ?? field("operation")].filter(Boolean).join(": ");
  return `Kin hit an error while landing memory${detail ? ` (${detail})` : ""}`;
};

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
    /** Closes `kin/write/*` PRs no landing waits on; wakes the lander while its guard-rails PR waits. */
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
  const app = yield* gitHubApp;
  const identity = () => memoryIdentity(config, app);
  // What each org's landing stopped on. A refusal only the owner can clear is held against GitHub's
  // guard-rail files (`owner`), so no new commit retries it; any other against the local head. A
  // restart tries again either way. With no head, the failure came before one was read.
  const stuck = new Map<
    KinOrgId,
    { readonly local: string | undefined; readonly reason: string; readonly owner?: string }
  >();
  // Owner notices already given this run, by org and cause, so a repeat stays quiet.
  const told = new Set<string>();
  // Guard-rails commits tried this run, and ones whose PR was then closed without merging.
  const tried = new Set<string>();
  // Published this run: the owner is asked to approve each once, not again after every restart.
  const published = new Set<string>();
  const declined = new Set<string>();
  // Orgs whose guard-rails PR waits on GitHub; the periodic sweep wakes their lander.
  const upgrading = new Set<KinOrgId>();
  // Orgs whose old review leftovers are folded in; until then each sweep tries again.
  const foldedIn = new Set<KinOrgId>();
  // One server owns a state directory (`serverOwnership.ts`), so no second process lands this repo.
  const signals = new Map<KinOrgId, Queue.Queue<void>>();

  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | VcsProcess>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const gitRaw = (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) =>
    memoryGit(cwd, args, stdin, env).pipe(
      Effect.provideService(MemoryConfig, config),
      provide,
      Effect.mapError((cause) => new MemoryError({ orgId, operation: "land", cause })),
    );
  const git = (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    env: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) => gitRaw(orgId, cwd, args, env, stdin).pipe(Effect.map((out) => out.trim()));
  const githubRepo = (orgId: KinOrgId) => {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    return repo?.githubRepo !== undefined && isRepoSlug(repo.githubRepo)
      ? { repoUrl: repo.repoUrl, github: repo.githubRepo }
      : undefined;
  };
  const tellOwner = Effect.fn("MemoryLander.tellOwner")(function* (
    orgId: KinOrgId,
    cause: string,
    notice: { readonly branch: string; readonly reason: string; readonly owner?: string },
  ) {
    const key = `${orgId}\u0000${cause}`;
    if (told.has(key)) return;
    told.add(key);
    yield* recovery.notify({ orgId, ...notice });
  });
  /** Blob ids of GitHub's guard-rail files: what must change before an owner-held refusal can lift. */
  const guardRailsKey = (orgId: KinOrgId, writer: string, head: string) =>
    git(orgId, writer, ["ls-tree", head, "--", CODEOWNERS_PATH, MEMORY_CHECK_PATH]);
  const fileAt = (orgId: KinOrgId, writer: string, commit: string, path: string) =>
    gitRaw(orgId, writer, ["cat-file", "blob", `${commit}:${path}`]).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

  const refuse = Effect.fn("MemoryLander.refuse")(function* (
    orgId: KinOrgId,
    local: string | undefined,
    reason: string,
    options: {
      readonly url?: string;
      readonly told?: boolean;
      /** GitHub's guard-rail files the refusal is held against, when only the owner can clear it. */
      readonly owner?: string;
      readonly ownerNotice?: string;
    } = {},
  ) {
    const held = stuck.get(orgId);
    stuck.set(orgId, {
      local,
      reason,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
    });
    // One notice per problem: a retry that fails the same way stays quiet.
    if (options.told !== true && held?.reason !== reason)
      yield* recovery.notify({
        orgId,
        branch: main,
        reason: `Memory write not merged: ${reason}${options.url ? ` (${options.url})` : ""}. Memory is still saved on this server; the GitHub copy is behind until Kin lands it, which it tries again with the next memory change or restart`,
        ...(options.ownerNotice === undefined ? {} : { owner: options.ownerNotice }),
      });
    return { _tag: "stuck", reason } as const;
  });

  /** One commit on GitHub's head that changes only the guard-rail files. */
  const guardRailsCommit = Effect.fn("MemoryLander.guardRailsCommit")(function* (
    orgId: KinOrgId,
    writer: string,
    remote: string,
    files: GuardRails,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs
          .makeTempDirectoryScoped()
          .pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "land", cause })));
        const env = { ...(yield* identity()), GIT_INDEX_FILE: `${temporary}/index` };
        const expected = new Map(
          (yield* provide(readTree(orgId, writer, remote))).map((entry) => [
            entry.relative,
            { mode: entry.mode, sha: entry.sha },
          ]),
        );
        yield* git(orgId, writer, ["read-tree", remote], env);
        for (const [path, text] of [
          [CODEOWNERS_PATH, files.codeowners],
          [MEMORY_CHECK_PATH, files.workflow],
        ] as const) {
          const blob = yield* git(
            orgId,
            writer,
            ["hash-object", "-w", "--no-filters", "--stdin"],
            env,
            text,
          );
          yield* git(
            orgId,
            writer,
            ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`],
            env,
          );
          expected.set(path, { mode: "100644", sha: blob });
        }
        const tree = yield* git(orgId, writer, ["write-tree"], env);
        yield* provide(verifyTree(orgId, writer, tree, expected));
        return yield* git(
          orgId,
          writer,
          ["commit-tree", tree, "-p", remote],
          env,
          "kin: bring the memory repo's guard rails up to date\n",
        );
      }),
    );
  });

  /**
   * Proposes this server's guard rails when GitHub's differ, as one PR only the owner can approve
   * (Kin never loosens its own rules), and merges it once GitHub allows. `waiting` while it can't.
   */
  const upgradeGuardRails = Effect.fn("MemoryLander.upgradeGuardRails")(function* (
    orgId: KinOrgId,
    writer: string,
    remote: string,
    target: NonNullable<ReturnType<typeof githubRepo>>,
  ) {
    if (Option.isNone(pullRequests)) return "current" as const;
    const update = guardRailsUpdate(
      {
        codeowners: yield* fileAt(orgId, writer, remote, CODEOWNERS_PATH),
        workflow: yield* fileAt(orgId, writer, remote, MEMORY_CHECK_PATH),
      },
      config.buildCommit ?? "",
    );
    const recorded = yield* git(orgId, writer, [
      "rev-parse",
      "--verify",
      "--quiet",
      GUARD_RAILS_REF,
    ]).pipe(Effect.option, Effect.map(Option.getOrUndefined));
    if (update._tag !== "update" || config.buildCommit === undefined) {
      const why =
        update._tag === "unowned"
          ? `the memory repo's ${CODEOWNERS_PATH} names no owner on its * line`
          : update._tag === "update"
            ? "KIN_BUILD_COMMIT is unset"
            : undefined;
      if (why !== undefined && !told.has(`${orgId}\u0000guard-rails:${why}`)) {
        told.add(`${orgId}\u0000guard-rails:${why}`);
        yield* Effect.logWarning(`Kin proposes no memory guard-rails update: ${why}`, { orgId });
      }
      if (recorded !== undefined && update._tag === "current")
        yield* git(orgId, writer, ["update-ref", "-d", GUARD_RAILS_REF, recorded]);
      upgrading.delete(orgId);
      return "current" as const;
    }
    // The recorded commit stays the PR's head while it proposes the same files, whatever it pins.
    let commit = recorded;
    if (commit !== undefined) {
      const proposed = {
        codeowners: (yield* fileAt(orgId, writer, commit, CODEOWNERS_PATH)) ?? "",
        workflow: (yield* fileAt(orgId, writer, commit, MEMORY_CHECK_PATH)) ?? "",
      };
      if (!sameGuardRails(proposed, update.files)) commit = undefined;
    }
    if (commit !== undefined && declined.has(commit)) return "waiting" as const;
    upgrading.add(orgId);
    const branchOf = (sha: string) => `${GUARD_RAILS_BRANCH}${sha.slice(0, 12)}`;
    const publish = Effect.gen(function* () {
      const built = yield* guardRailsCommit(orgId, writer, remote, update.files);
      const pushed = yield* git(orgId, writer, [
        "push",
        "--",
        target.repoUrl,
        `${built}:refs/heads/${branchOf(built)}`,
      ]).pipe(Effect.result);
      if (pushed._tag === "Failure") return undefined;
      yield* git(orgId, writer, ["update-ref", GUARD_RAILS_REF, built]);
      published.add(built);
      return built;
    });
    const attempt = (sha: string) =>
      pullRequests.value
        .land({
          orgId,
          repo: target.github,
          branch: branchOf(sha),
          base: main,
          sha,
          title: "kin: bring the memory repo's guard rails up to date",
          message: "kin: bring the memory repo's guard rails up to date\n",
          kind: "guard-rails",
        })
        .pipe(Effect.result);
    if (commit === undefined) commit = yield* publish;
    if (commit === undefined) {
      yield* tellOwner(orgId, "guard-rails:push", {
        branch: main,
        reason:
          "GitHub refused Kin's push of the guard-rails branch; Kin tries again with the next landing run",
      });
      return "waiting" as const;
    }
    let landed = yield* attempt(commit);
    // A PR closed before this run, such as by a restart's sweep, is offered again once, fresh.
    if (landed._tag === "Success" && landed.success._tag === "closed" && !tried.has(commit)) {
      const fresh = yield* publish;
      if (fresh !== undefined) {
        commit = fresh;
        landed = yield* attempt(commit);
      }
    }
    tried.add(commit);
    if (landed._tag === "Failure") {
      const failure: MemoryPullRequestRefused = landed.failure;
      // With a URL, Kin closed the PR (its head or branch was not Kin's alone): the next run rebuilds.
      if (failure.url !== undefined)
        yield* git(orgId, writer, ["update-ref", "-d", GUARD_RAILS_REF, commit]);
      yield* tellOwner(orgId, `guard-rails:${commit}:${failure.reason}`, {
        branch: branchOf(commit),
        reason: `Kin's guard-rails PR did not merge: ${failure.reason}${failure.url ? ` (${failure.url})` : ""}`,
      });
      return "waiting" as const;
    }
    const outcome = landed.success;
    if (outcome._tag === "merged") {
      yield* git(orgId, writer, ["update-ref", "-d", GUARD_RAILS_REF, commit]);
      yield* git(orgId, writer, [
        "push",
        "--",
        target.repoUrl,
        `:refs/heads/${branchOf(commit)}`,
      ]).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not delete a merged guard-rails branch", { orgId }),
        ),
      );
      upgrading.delete(orgId);
      yield* Effect.logInfo("Kin memory guard rails updated", {
        orgId,
        pullRequest: outcome.url.slice(outcome.url.lastIndexOf("/") + 1),
      });
      return "merged" as const;
    }
    if (outcome._tag === "closed") {
      declined.add(commit);
      upgrading.delete(orgId);
      yield* tellOwner(orgId, `guard-rails:${commit}:closed`, {
        branch: branchOf(commit),
        reason: `Kin's guard-rails PR was closed without merging (${outcome.url})`,
        owner: `The change to the memory repo's rules on GitHub was closed without merging, so some memory stays on this server only. Kin offers it again after its next restart: ${outcome.url}`,
      });
      return "waiting" as const;
    }
    const askedBefore = outcome.waitsOnOwner && !published.has(commit);
    yield* tellOwner(
      orgId,
      `guard-rails:${commit}:${outcome.waitsOnOwner ? "review" : outcome.reason}`,
      {
        branch: branchOf(commit),
        reason: `Kin's guard-rails PR waits: ${outcome.reason} (${outcome.url})`,
        // Asked when Kin opened it; a restart finding it still unapproved asks nothing new.
        ...(askedBefore
          ? {}
          : {
              owner: outcome.waitsOnOwner
                ? `Approve one change to the memory repo's rules on GitHub: ${outcome.url}. It lets Kin save every kind of memory there on its own; until then some of it stays on this server only. Kin merges it itself once you approve.`
                : outcome.reason.startsWith("GitHub refused the merge")
                  ? `GitHub won't let Kin merge its change to the memory repo's rules (${outcome.reason}). Merge it there yourself: ${outcome.url}`
                  : `Kin's change to the memory repo's rules on GitHub can't merge yet: ${outcome.reason}. ${outcome.url}`,
            }),
      },
    );
    return "waiting" as const;
  });

  /**
   * Once, at start: changes an older server kept for the owner's review (under `refs/kin/review/`,
   * or in an open `…-review` PR whose commit this server made) go onto the local default branch, so
   * the next batch lands them; each such PR is closed with a comment.
   */
  const foldInReviews = Effect.fn("MemoryLander.foldInReviews")(function* (orgId: KinOrgId) {
    const target = githubRepo(orgId);
    const state = yield* memory.landingState(orgId);
    if (state === undefined) return;
    const { writer } = state;
    const refs = (yield* git(orgId, writer, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      LEGACY_REVIEW_REFS,
    ]))
      .split("\n")
      .flatMap((line) => {
        const [ref, sha] = line.split(" ");
        return ref && sha ? [{ ref, sha }] : [];
      });
    const listed =
      Option.isSome(pullRequests) && target !== undefined
        ? yield* pullRequests.value.openPulls({ orgId, repo: target.github }).pipe(Effect.option)
        : Option.some({ pulls: [], complete: true });
    const pulls = Option.match(listed, { onNone: () => [], onSome: (open) => open.pulls }).filter(
      (pull) => LEGACY_REVIEW_BRANCH.test(pull.branch),
    );
    // Done once every open PR was read; until then the next sweep looks again.
    const done = Effect.sync(() => {
      if (Option.isSome(listed) && listed.value.complete) foldedIn.add(orgId);
    });
    if (refs.length === 0 && pulls.length === 0) return yield* done;
    const local = yield* memory.anchor(orgId, main);
    // Only a review commit this server made is kept: the deploy key can push anything to a PR
    // branch, including a commit already on the default branch.
    const ours = (sha: string) =>
      git(orgId, writer, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
        Effect.andThen(
          git(orgId, writer, ["merge-base", "--is-ancestor", sha, local]).pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          ),
        ),
        Effect.orElseSucceed(() => false),
      );
    const sources = refs.map(({ sha }) => sha);
    for (const pull of pulls) if (yield* ours(pull.head)) sources.push(pull.head);
    yield* memory.withWriterLock(
      orgId,
      Effect.gen(function* () {
        const local = yield* memory.anchor(orgId, main);
        const entries = new Map(
          (yield* provide(readTree(orgId, writer, local))).map((entry) => [entry.relative, entry]),
        );
        const kept: Array<{ mode: string; sha: string; relative: string }> = [];
        for (const sha of sources) {
          const parent = yield* git(orgId, writer, ["rev-parse", `${sha}^`]);
          const before = new Map(
            (yield* provide(readTree(orgId, writer, parent))).map((entry) => [
              entry.relative,
              entry,
            ]),
          );
          for (const entry of yield* provide(readTree(orgId, writer, sha))) {
            const prior = before.get(entry.relative);
            if (prior?.sha === entry.sha && prior.mode === entry.mode) continue;
            const path = entry.relative;
            if (!isItemPath(path) || !isCheckoutPath(path) || kinShapeFailure(path) !== undefined)
              continue;
            const current = entries.get(path);
            // A later local write to the same item wins over the change that waited.
            if (current !== undefined && current.sha !== prior?.sha) continue;
            const next = { mode: "100644", sha: entry.sha, relative: path };
            entries.set(path, next);
            kept.push(next);
          }
        }
        if (kept.length === 0) return;
        const commit = yield* Effect.scoped(
          Effect.gen(function* () {
            const temporary = yield* fs
              .makeTempDirectoryScoped()
              .pipe(
                Effect.mapError((cause) => new MemoryError({ orgId, operation: "land", cause })),
              );
            const env = { ...(yield* identity()), GIT_INDEX_FILE: `${temporary}/index` };
            yield* git(orgId, writer, ["read-tree", local], env);
            yield* git(
              orgId,
              writer,
              ["update-index", "--index-info"],
              env,
              kept.map((entry) => `${entry.mode} ${entry.sha}\t${entry.relative}`).join("\n") +
                "\n",
            );
            const tree = yield* git(orgId, writer, ["write-tree"], env);
            yield* provide(
              verifyTree(
                orgId,
                writer,
                tree,
                new Map(
                  [...entries].map(([path, entry]) => [path, { mode: entry.mode, sha: entry.sha }]),
                ),
              ),
            );
            return yield* git(
              orgId,
              writer,
              ["commit-tree", tree, "-p", local],
              env,
              "kin: keep memory changes that waited for review\n",
            );
          }),
        );
        yield* git(orgId, writer, ["update-ref", `refs/heads/${main}`, commit, local]);
        yield* memory.record(orgId, main, local, commit);
      }),
    );
    yield* memory.rebuildCache(orgId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not refresh memory cache after folding in reviews", {
          orgId,
          errorTag: error._tag,
        }),
      ),
    );
    for (const { ref, sha } of refs) yield* git(orgId, writer, ["update-ref", "-d", ref, sha]);
    if (Option.isNone(pullRequests) || target === undefined) return yield* done;
    for (const pull of pulls) {
      const kept = sources.includes(pull.head);
      yield* pullRequests.value
        .close({
          orgId,
          repo: target.github,
          number: pull.number,
          reason: kept
            ? "Kin saves memory without review now, so it kept these changes on its server; its next memory PR brings them to main"
            : "Kin saves memory without review now, and its server doesn't have this PR's commit, so nothing from it was kept",
        })
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not close an old memory review PR", {
              orgId,
              number: pull.number,
            }),
          ),
        );
      if (!kept)
        yield* recovery.notify({
          orgId,
          branch: pull.branch,
          reason: `Kin closed ${pull.url}, an old memory review PR whose commit this server doesn't have`,
          owner: `Kin closed an old memory review, ${pull.url}, without keeping its changes: this server no longer has them.`,
        });
    }
    yield* done;
  });

  const landOnce = Effect.fn("MemoryLander.landOnce")(function* (
    orgId: KinOrgId,
    target: NonNullable<ReturnType<typeof githubRepo>>,
    state: NonNullable<Effect.Success<ReturnType<typeof memory.landingState>>>,
  ) {
    if (Option.isNone(pullRequests)) return { _tag: "idle" } as const;
    const { writer, local, remote } = state;
    if (remote !== undefined && remote.descends) {
      const upgrade = yield* upgradeGuardRails(orgId, writer, remote.head, target);
      // GitHub's head moved: the next batch starts from a fresh sync.
      if (upgrade === "merged") return { _tag: "upgraded" } as const;
    }
    if (remote !== undefined && !remote.pending) {
      stuck.delete(orgId);
      return { _tag: "idle" } as const;
    }
    const held = stuck.get(orgId);
    if (held?.owner !== undefined && remote !== undefined) {
      if ((yield* guardRailsKey(orgId, writer, remote.head)) === held.owner)
        return { _tag: "waiting" } as const;
    } else if (held?.local === local) return { _tag: "waiting" } as const;
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
      yield* identity(),
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
        kind: "batch",
      })
      .pipe(Effect.result);
    if (landed._tag === "Failure") {
      const { reason, url, waitsOnOwner } = landed.failure;
      if (waitsOnOwner !== true)
        return yield* refuse(orgId, local, reason, url === undefined ? {} : { url });
      // Only the owner can clear this, so no later commit tries it again: a change to GitHub's
      // guard-rail files (such as the guard-rails PR merging) or a restart does.
      return yield* refuse(orgId, local, reason, {
        ...(url === undefined ? {} : { url }),
        owner: yield* guardRailsKey(orgId, writer, remote.head),
        // The guard-rails PR's own notice already asks the owner for what clears this.
        ...(upgrading.has(orgId)
          ? {}
          : {
              ownerNotice: `Memory is saved here, but GitHub's copy is behind: GitHub wants a review before Kin's memory PRs merge${url ? ` (${url})` : ""}, and Kin's own memory needs none. Check the memory repo's rules and ${CODEOWNERS_PATH} on GitHub; Kin tries again once those files change or the server restarts.`,
            }),
      });
    }
    if (landed.success._tag !== "merged")
      return yield* refuse(orgId, local, "GitHub kept the memory PR open");
    const { url, commit } = landed.success;
    // With GitHub's head unmoved, the squash must hold exactly the tree Kin pushed.
    yield* git(orgId, writer, ["fetch", "--", target.repoUrl, commit]);
    const [parent, merged] = [
      yield* git(orgId, writer, ["rev-parse", `${commit}^`]),
      yield* git(orgId, writer, ["rev-parse", `${commit}^{tree}`]),
    ];
    if (parent === remote.head && merged !== tree)
      return yield* refuse(orgId, local, "GitHub merged a different tree than Kin pushed", { url });
    // One ref to one commit, so both halves move together: GitHub's squash, then the local
    // commit whose tree it carries. The next sync merges the squash in from that tree.
    const landedAs = yield* git(
      orgId,
      writer,
      ["commit-tree", tree, "-p", commit, "-p", local],
      yield* identity(),
      `kin: landed ${local} as ${commit}\n`,
    );
    const before = yield* git(orgId, writer, ["rev-parse", "--verify", "--quiet", LANDED_REF]).pipe(
      Effect.option,
    );
    yield* git(orgId, writer, ["update-ref", LANDED_REF, landedAs]);
    stuck.delete(orgId);
    yield* git(orgId, writer, ["push", "--", target.repoUrl, `:refs/heads/${branch}`]).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not delete a merged memory PR branch", { orgId }),
      ),
    );
    // Local commits since the batch before; with no record yet, every one GitHub has only squashed.
    const commits = yield* git(orgId, writer, [
      "rev-list",
      "--count",
      "--no-merges",
      local,
      `^${remote.head}`,
      ...(Option.isSome(before) ? [`^${before.value}^2`] : []),
    ]).pipe(Effect.orElseSucceed(() => "unknown"));
    yield* Effect.logInfo("Kin memory batch landed", {
      orgId,
      commits,
      pullRequest: url.slice(url.lastIndexOf("/") + 1),
    });
    return { _tag: "merged", url, commit } as const;
  });

  const land = Effect.fn("MemoryLander.land")(function* (orgId: KinOrgId, atStart = false) {
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      // The head this attempt read: a failure is held against it, never against a later commit.
      let attempted: string | undefined;
      const outcome = yield* Effect.gen(function* () {
        const target = githubRepo(orgId);
        if (target === undefined) return { _tag: "idle" } as const;
        // Under the writer lock: sync merges what GitHub merged, so `local` descends from it.
        const state = yield* memory.landingState(orgId);
        if (state === undefined) return { _tag: "idle" } as const;
        attempted = state.local;
        return yield* landOnce(orgId, target, state);
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Kin memory landing failed", {
              orgId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(refuse(orgId, attempted, unexpected(cause)))),
        ),
      );
      if (atStart && batch === 0 && outcome._tag === "idle")
        yield* Effect.logInfo("Kin memory lander started with nothing to land", { orgId });
      yield* hooks.settled(orgId, outcome);
      if (outcome._tag !== "merged" && outcome._tag !== "upgraded") return;
    }
    yield* Effect.logWarning("Kin memory landing paused after its batch limit", { orgId });
  });

  const sweep = Effect.fn("MemoryLander.sweep")(function* (orgId: KinOrgId) {
    if (Option.isNone(pullRequests)) return;
    const target = githubRepo(orgId);
    if (target === undefined) return;
    const refused = (error: MemoryPullRequestRefused) =>
      new MemorySyncConflict({ orgId, operation: "sweep", reason: error.reason });
    if (!foldedIn.has(orgId))
      yield* foldInReviews(orgId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin could not fold in memory held for review", {
            orgId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    const { writer } = yield* memory
      .ensureCheckouts(orgId)
      .pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "sweep", cause })));
    const proposal = yield* git(orgId, writer, [
      "rev-parse",
      "--verify",
      "--quiet",
      GUARD_RAILS_REF,
    ]).pipe(Effect.option);
    const { pulls: open } = yield* pullRequests.value
      .openPulls({ orgId, repo: target.github })
      .pipe(Effect.mapError(refused));
    for (const pull of open) {
      const kept = Option.exists(
        proposal,
        (sha) => pull.head === sha && pull.branch === `${GUARD_RAILS_BRANCH}${sha.slice(0, 12)}`,
      );
      // Old review PRs are the fold-in's to close, once it has kept what they hold.
      if (kept || LEGACY_REVIEW_BRANCH.test(pull.branch)) continue;
      yield* pullRequests.value
        .close({
          orgId,
          repo: target.github,
          number: pull.number,
          reason: "no Kin memory write is waiting on it",
        })
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not close an orphaned memory PR", {
              repo: target.github,
              number: pull.number,
            }),
          ),
        );
    }
  });

  if (Option.isSome(pullRequests))
    for (const { orgId } of config.repositories) {
      const queue = yield* Queue.dropping<void>(1);
      signals.set(orgId, queue);
      // At start, changes an older server held for review are folded in and PRs a crash left open
      // are closed before anything lands, so none is duplicated; then whatever is unlanded goes out.
      const resume = sweep(orgId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin memory PR sweep failed at start", {
            orgId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(land(orgId, true)),
      );
      // A defect in one run must not end the loop: later signals would land nothing.
      const run = (atStart: boolean) =>
        memory.withLandingLock(orgId, atStart ? resume : land(orgId)).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("Kin memory lander run ended abnormally", {
                orgId,
                cause: Cause.pretty(cause),
              }),
          ),
        );
      yield* run(true).pipe(
        Effect.andThen(Queue.take(queue).pipe(Effect.andThen(run(false)), Effect.forever)),
        Effect.forkScoped,
      );
    }

  const signal = Effect.fn("MemoryLander.signal")(function* (orgId: KinOrgId) {
    const queue = signals.get(orgId);
    if (queue !== undefined) yield* Queue.offer(queue, undefined);
  });

  return MemoryLander.of({
    signal,
    // Every 5 minutes: the owner's approval on GitHub changes nothing Kin hears of otherwise.
    sweep: Effect.fn("MemoryLander.sweepLocked")(function* (orgId) {
      yield* memory.withLandingLock(orgId, sweep(orgId));
      if (upgrading.has(orgId)) yield* signal(orgId);
    }),
  });
});

export const layer = Layer.effect(MemoryLander, make);
