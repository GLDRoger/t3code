// @effect-diagnostics-next-line nodeBuiltinImport:off -- Supersession fingerprints compare in-process strings synchronously.
import * as NodeCrypto from "node:crypto";
import type { PersistenceSqlError } from "../../persistence/Errors.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { readFiles, readCommit, readTree, objectHash, verifyTree } from "./objects.ts";
import { buildIndex } from "./buildIndex.ts";
import { isCheckoutPath } from "./checkoutPaths.ts";
import * as MemoryCache from "./MemoryCache.ts";
import {
  KIN_HIDDEN_CHARACTER,
  KIN_MEMORY_CHANGE_TITLE_MAX,
  RepoSlug,
  type KinAgentId,
  type KinMemoryChangeKind,
  type KinMemoryItemId,
  type KinOrgId,
  type MemoryTrust,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { stringify } from "yaml";
import { memoryGit as runMemoryGit } from "./git.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import {
  Memory,
  MemoryCheckoutInvalid,
  MemoryRecoveryHooks,
  MemoryError,
  MemorySyncConflict,
  MemoryConfigError,
  MemoryQueryDecodeError,
  MemoryNotFound,
  MemoryDuplicateId,
  shadowBranch,
} from "./Memory.ts";
import { parseFrontMatter, MemoryItemError } from "./frontMatter.ts";
import { journalEntry, MemoryJournalError, type JournalContext } from "./journal.ts";
import { mergeMemoryFiles } from "./merge.ts";
import { isOwnerReviewedPath, kinShapeFailure } from "./lint.ts";
import { KinSecretScan, KinSecretScanError } from "./secretScan.ts";
import {
  MemoryPullRequests,
  REVIEW_BRANCH_SUFFIX,
  WRITE_BRANCH_PREFIX,
} from "./MemoryPullRequests.ts";

export const LEAD_ENDED_WITHOUT_KIN_END = "Lead ended without calling kin_end.";

export interface WakeupContext extends JournalContext {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly level: "L0" | "L1" | "L2" | "L3";
  readonly stagedReceipts?: boolean;
  readonly sources: ReadonlyMap<
    string,
    { readonly saidBy: string; readonly trust: MemoryTrust; readonly source: string } & (
      | { readonly kind?: undefined }
      | {
          readonly kind: "owner_check";
          readonly itemId: string;
          readonly action: "keep" | "update" | "drop";
        }
      | { readonly kind: "deferral_card"; readonly itemId: string; readonly action: "remind" }
      | {
          readonly kind: "deferral_card";
          readonly itemId: string;
          readonly action: "monday";
          readonly due: string;
        }
    )
  >;
}
// The runner resolves this context from same-org records, never tool input.
export class MemoryWriterAuthority extends Context.Service<
  MemoryWriterAuthority,
  {
    readonly resolve: (
      orgId: KinOrgId,
      wakeupId: string,
    ) => Effect.Effect<WakeupContext, MemoryWriteRejected | PersistenceSqlError>;
  }
>()("t3/kin/memory/MemoryWriter/MemoryWriterAuthority") {}
export type ShadowChoice =
  | { readonly _tag: "preview" }
  | { readonly _tag: "discard" }
  /** `paths` is the list the owner was shown; Keep refuses when the changes differ from it. */
  | { readonly _tag: "keep"; readonly paths: ReadonlyArray<string> };

export class MemoryWriteRejected extends Schema.TaggedError<MemoryWriteRejected>()(
  "MemoryWriteRejected",
  {
    reason: Schema.String,
  },
) {}
export class MemoryConflict extends Schema.TaggedError<MemoryConflict>()("MemoryConflict", {
  existingId: Schema.String,
}) {}
export class MemorySecretBlocked extends Schema.TaggedError<MemorySecretBlocked>()(
  "MemorySecretBlocked",
  {
    orgId: Schema.String,
    findings: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        ruleId: Schema.String,
        line: Schema.Number,
        pathHit: Schema.optional(Schema.Boolean),
        itemPath: Schema.optional(Schema.String),
      }),
    ),
  },
) {}
export type WriterNotice = {
  readonly orgId: KinOrgId;
  readonly wakeupId: string;
  readonly error:
    | MemoryCheckoutInvalid
    | MemorySyncConflict
    | MemorySecretBlocked
    | KinSecretScanError;
};
export class MemoryWriterHooks extends Context.Service<
  MemoryWriterHooks,
  {
    readonly notify: (notice: WriterNotice) => Effect.Effect<void>;
  }
>()("t3/kin/memory/MemoryWriter/MemoryWriterHooks") {}
/** The items one wake-up's commit changed, for the owner's change card. */
export interface WakeupMemoryChanges {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
  readonly branch: string;
  /** The branch head the commit was made on, which Undo restores from. */
  readonly base: string;
  readonly commit: string;
  readonly items: ReadonlyArray<{
    readonly itemId: KinMemoryItemId;
    readonly path: string;
    readonly title: string;
    readonly change: KinMemoryChangeKind;
  }>;
}
/** Optional: told once per committed wake-up that changed items, never for journal-only ones. */
export class MemoryChangeHooks extends Context.Service<
  MemoryChangeHooks,
  { readonly committed: (changes: WakeupMemoryChanges) => Effect.Effect<void> }
>()("t3/kin/memory/MemoryWriter/MemoryChangeHooks") {}
export interface MemoryUndo {
  readonly agentId: KinAgentId;
  readonly itemId: KinMemoryItemId;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly commit: string;
}
export type MemoryUndoResult =
  | { readonly _tag: "undone"; readonly commit: string }
  /** The item changed after `commit`, or that history is gone. */
  | { readonly _tag: "stale" };
const hiddenCharacters = new RegExp(KIN_HIDDEN_CHARACTER.source, "gu");
/** One plain line from lead-written front matter: no hidden characters, capped. */
const changeTitle = (title: string, what: string | undefined) => {
  const line = (text: string) => text.replace(hiddenCharacters, " ").replace(/\s+/g, " ").trim();
  const text = line(title) || line(what ?? "") || "Untitled item";
  return text.length > KIN_MEMORY_CHANGE_TITLE_MAX
    ? `${text.slice(0, KIN_MEMORY_CHANGE_TITLE_MAX - 1).trimEnd()}…`
    : text;
};
export interface MemoryChange {
  readonly path: string;
  readonly content: string;
  readonly sourceEventId?: string;
  readonly supersedes?: string;
}
type Failure =
  | PersistenceSqlError
  | MemoryJournalError
  | MemoryConfigError
  | MemoryQueryDecodeError
  | MemoryNotFound
  | MemoryDuplicateId
  | MemoryError
  | MemoryCheckoutInvalid
  | MemorySyncConflict
  | MemoryWriteRejected
  | MemoryConflict
  | MemoryItemError
  | KinSecretScanError
  | MemorySecretBlocked;
export class MemoryWriter extends Context.Service<
  MemoryWriter,
  {
    readonly stage: (
      orgId: KinOrgId,
      wakeupId: string,
      change: MemoryChange,
    ) => Effect.Effect<void, Failure>;
    readonly appendJournal: (
      orgId: KinOrgId,
      wakeupId: string,
      lines: ReadonlyArray<string>,
    ) => Effect.Effect<void, Failure>;
    readonly discard: (orgId: KinOrgId, wakeupId: string) => Effect.Effect<void, Failure>;
    readonly commitWakeup: (
      orgId: KinOrgId,
      wakeupId: string,
      outcome: "completed" | "failed",
    ) => Effect.Effect<{ commit: string }, Failure>;
    readonly dreamBase: (
      orgId: KinOrgId,
    ) => Effect.Effect<{ head: string; files: ReadonlyMap<string, Buffer> }, Failure>;
    /** Commits on `base` and force-pushes `dream/<date>`; never touches the default branch. */
    readonly commitDream: (
      orgId: KinOrgId,
      input: {
        readonly branch: string;
        readonly base: string;
        readonly files: ReadonlyMap<string, string>;
        readonly message: string;
      },
    ) => Effect.Effect<{ commit: string }, Failure>;
    readonly deleteDreamBranch: (orgId: KinOrgId, branch: string) => Effect.Effect<void, Failure>;
    /**
     * The owner's choice once a lead leaves L0: `keep` commits the shadow branch's changes onto
     * the default branch; either way `kin/shadow/<agentId>` then restarts from the default branch.
     * `preview` only lists the changed paths.
     */
    readonly settleShadow: (
      orgId: KinOrgId,
      agentId: KinAgentId,
      choice: ShadowChoice,
    ) => Effect.Effect<{ readonly kept: number; readonly paths: ReadonlyArray<string> }, Failure>;
    /**
     * The owner's Undo of one item a wake-up changed: a new commit on the same branch that
     * restores the item from `base`, or invalidates it if the wake-up created it. Compare-and-set:
     * `stale` when the item differs from what `commit` wrote.
     */
    readonly undoChange: (
      orgId: KinOrgId,
      input: MemoryUndo,
    ) => Effect.Effect<MemoryUndoResult, Failure>;
    /** Closes `kin/write/*` PRs no write waits on (TRIG-15) and tells the owner about review PRs. */
    readonly sweepPullRequests: (orgId: KinOrgId) => Effect.Effect<void, Failure>;
  }
>()("t3/kin/memory/MemoryWriter") {}
const isRepoSlug = Schema.is(RepoSlug);
const dreamBranch = /^dream\/\d{4}-\d{2}-\d{2}$/;
const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];
const render = (fields: object, body: string) => `---\n${stringify(fields)}---\n${body}`;
const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const recovery = yield* MemoryRecoveryHooks;
  const reportedOpen = new Set<string>();
  // Shadow branches whose last push was refused; the owner hears once until a push lands.
  const unpushedShadows = new Set<string>();
  const authority = yield* MemoryWriterAuthority;
  const hooks = yield* MemoryWriterHooks;
  const changeHooks = yield* Effect.serviceOption(MemoryChangeHooks);
  const scanner = yield* KinSecretScan;
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess;
  const memoryGit = (...args: Parameters<typeof runMemoryGit>) =>
    runMemoryGit(...args).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
      Effect.provideService(MemoryConfig, config),
    );
  const config = yield* MemoryConfig;
  const cache = yield* MemoryCache.MemoryCache;
  const pullRequests = yield* Effect.serviceOption(MemoryPullRequests);
  const mainWrites = Option.isSome(pullRequests)
    ? "pull_request"
    : config.directMainPush === true
      ? "direct"
      : "refused";
  const filesAt = (orgId: KinOrgId, writer: string, commit: string) =>
    readFiles(orgId, writer, commit).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const commitAt = (orgId: KinOrgId, writer: string, commit: string) =>
    readCommit(orgId, writer, commit).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
  const locked = memory.withWriterLock;
  const sessions = new Map<
    KinOrgId,
    {
      wakeupId: string;
      generation: number;
      files: Map<string, string>;
      lines: string[];
      supersessions: Map<string, string>;
    }
  >();
  const io = <A, E, R>(orgId: KinOrgId, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "writer", cause })));
  const git = Effect.fn("MemoryWriter.git")(function* (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    identity: NodeJS.ProcessEnv = {},
    stdin?: string,
  ) {
    return (yield* memoryGit(cwd, args, stdin, identity).pipe(
      Effect.mapError((cause) =>
        cause._tag === "MemoryGitMissingRepository"
          ? new MemoryCheckoutInvalid({
              orgId,
              operation: "git",
              reason: "Writer .git is missing or not a directory",
              path: cwd,
              cause,
            })
          : new MemoryError({ orgId, operation: "writer", cause }),
      ),
    )).trim();
  });
  const branchHead = Effect.fn("MemoryWriter.branchHead")(function* (
    orgId: KinOrgId,
    writer: string,
    branch: string,
  ) {
    const anchored = yield* memory.anchor(orgId, branch).pipe(Effect.result);
    const local = yield* git(orgId, writer, ["rev-parse", "--verify", `refs/heads/${branch}`]).pipe(
      Effect.result,
    );
    if (anchored._tag === "Success") {
      if (local._tag === "Failure")
        return yield* new MemoryCheckoutInvalid({
          orgId,
          operation: "branch",
          reason: "Missing recorded branch",
        });
      if (local.success !== anchored.success) {
        yield* git(orgId, writer, [
          "update-ref",
          `refs/heads/${branch}`,
          anchored.success,
          local.success,
        ]);
        const notice = {
          orgId,
          branch,
          reason: "Reset tampered branch to anchor; unpushed work at the replaced tip is lost",
        };
        yield* recovery.notify(notice);
      }
      return anchored.success;
    }
    if (local._tag === "Success") {
      yield* git(orgId, writer, ["update-ref", "-d", `refs/heads/${branch}`, local.success]);
      const notice = { orgId, branch, reason: "Deleted unanchored local branch" };
      yield* recovery.notify(notice);
    }
    const repo = config.repositories.find((repo) => repo.orgId === orgId);
    if (!repo)
      return yield* new MemoryConfigError({ orgId, operation: "branch", reason: "Unknown org" });
    const main = yield* memory.anchor(orgId, config.defaultBranch ?? "main");
    const advertised = yield* git(orgId, writer, [
      "ls-remote",
      "--",
      repo.repoUrl,
      `refs/heads/${branch}`,
    ]);
    let remote = main;
    if (advertised) {
      const [sha, name] = advertised.split(/\s+/);
      if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) || name !== `refs/heads/${branch}`)
        return yield* new MemoryCheckoutInvalid({
          orgId,
          operation: "branch",
          reason: "Invalid remote advertisement",
        });
      yield* git(orgId, writer, ["fetch", "--", repo.repoUrl, sha]);
      remote = sha;
    }
    yield* filesAt(orgId, writer, remote);
    const recorded = yield* memory.anchor(orgId, branch, remote);
    yield* git(orgId, writer, [
      "update-ref",
      `refs/heads/${branch}`,
      recorded,
      "0".repeat(recorded.length),
    ]);
    return recorded;
  });
  const session = Effect.fn("MemoryWriter.session")(function* (orgId: KinOrgId, wakeupId: string) {
    const ctx = yield* authority.resolve(orgId, wakeupId);
    if (
      ctx.orgId !== orgId ||
      ctx.wakeupId !== wakeupId ||
      !/^[a-zA-Z0-9_-]+$/.test(ctx.agentId) ||
      !/^[a-zA-Z0-9_-]+$/.test(wakeupId) ||
      ctx.eventIds.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))
    )
      return yield* new MemoryWriteRejected({ reason: "Invalid server context" });
    yield* journalEntry(ctx, "completed", []);
    const previous = sessions.get(orgId);
    if (previous && previous.wakeupId !== wakeupId)
      return yield* new MemoryWriteRejected({ reason: "Another wake-up owns the writer" });
    const generation = yield* memory.historyGeneration(orgId);
    // A purge rewrote history after this wake-up staged; committing it could restore purged content.
    if (previous && previous.generation !== generation) {
      sessions.delete(orgId);
      return yield* new MemorySyncConflict({
        orgId,
        operation: "push",
        reason: "Memory history was rewritten during this wake-up; its staged changes were dropped",
      });
    }
    const state = previous ?? {
      wakeupId,
      generation,
      files: new Map<string, string>(),
      lines: [],
      supersessions: new Map<string, string>(),
    };
    if (!previous && ctx.stagedReceipts) {
      const { writer } = yield* validate(orgId);
      const branch =
        ctx.level === "L0" ? shadowBranch(ctx.agentId) : (config.defaultBranch ?? "main");
      const head = yield* branchHead(orgId, writer, branch);
      const { message } = yield* commitAt(orgId, writer, head);
      if (message.split("\n")[0] !== `kin(${ctx.agentId}): wake-up ${wakeupId}`) {
        const reason =
          "Staged changes and kin_end summary were lost on restart; tool receipts do not prove those changes were committed.";
        state.lines.push(reason);
        yield* recovery.notify({ orgId, branch: `wakeup:${wakeupId}`, reason });
      }
    }
    sessions.set(orgId, state);
    return { ctx, state };
  });
  const safePath = Effect.fn("MemoryWriter.safePath")(function* (
    orgId: KinOrgId,
    writer: string,
    relative: string,
    generated = false,
  ) {
    const parts = relative.split("/");
    // Memory is pushed to the owner's repo, where a `CLAUDE.md` would configure the owner's own agent.
    if (
      !isCheckoutPath(relative) ||
      relative === "rules.md" ||
      (relative === "INDEX.md" && !generated)
    )
      return yield* new MemoryWriteRejected({
        reason:
          "Disallowed memory path: names are ASCII letters, digits, . _ -, and agent config or Windows device names are reserved",
      });
    const shape = kinShapeFailure(relative);
    if (shape !== undefined) return yield* new MemoryWriteRejected({ reason: shape });
    let current = writer;
    for (const part of parts) {
      current += `/${part}`;
      const result = yield* fs.lstat(current).pipe(Effect.result);
      if (result._tag === "Failure") {
        if (result.failure.reason._tag !== "NotFound")
          return yield* new MemoryError({
            orgId,
            operation: "path",
            cause: "Unable to inspect memory path",
          });
      } else if (
        result.success.type === "SymbolicLink" ||
        (result.success.type === "File" &&
          Option.isSome(result.success.nlink) &&
          result.success.nlink.value > 1) ||
        (current !== `${writer}/${relative}` && result.success.type !== "Directory")
      ) {
        return yield* new MemoryWriteRejected({ reason: "Symlink or invalid ancestor" });
      }
    }
  });
  const validate = Effect.fn("MemoryWriter.validate")(function* (orgId: KinOrgId) {
    const paths = yield* memory.ensureCheckouts(orgId);
    return paths;
  });
  // Every caller holds the writer lock, and the marker only changes under it.
  const refuseDuringPurge = Effect.fn("MemoryWriter.refuseDuringPurge")(function* (
    orgId: KinOrgId,
  ) {
    if ((yield* memory.purgeInFlight(orgId)) !== undefined)
      return yield* new MemorySyncConflict({
        orgId,
        operation: "push",
        reason: "A memory purge is in flight; old history must not be pushed",
      });
  });
  const report = <A>(orgId: KinOrgId, wakeupId: string, effect: Effect.Effect<A, Failure>) =>
    effect.pipe(
      Effect.catchTags({
        MemoryItemError: (error) =>
          scanner.scan({ orgId, files: [{ path: error.path, content: new Uint8Array() }] }).pipe(
            Effect.flatMap((findings) =>
              Effect.fail(
                new MemoryItemError({
                  orgId: error.orgId,
                  path: findings.length ? "[redacted]" : error.path,
                  reason: error.reason,
                }),
              ),
            ),
          ),
      }),
      Effect.tapError((error) =>
        error._tag === "MemoryCheckoutInvalid" ||
        error._tag === "MemorySyncConflict" ||
        error._tag === "MemorySecretBlocked" ||
        error._tag === "KinSecretScanError"
          ? hooks
              .notify({ orgId, wakeupId, error })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Memory writer notification failed", cause),
                ),
              )
          : Effect.void,
      ),
    );
  const regularPaths = Effect.fn("MemoryWriter.regularPaths")(function* (
    orgId: KinOrgId,
    writer: string,
    commit: string,
  ) {
    const entries = yield* readTree(orgId, writer, commit).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
    return new Set(
      entries
        .filter((entry) => ["100644", "100755"].includes(entry.mode))
        .map((entry) => entry.relative),
    );
  });
  const indexFor = Effect.fn("MemoryWriter.indexFor")(function* (
    orgId: KinOrgId,
    combined: ReadonlyMap<string, string>,
  ) {
    const heads = [];
    for (const [path, text] of combined) {
      if (!folders.some((folder) => path.startsWith(`${folder}/`))) continue;
      const parsed = yield* parseFrontMatter(orgId, path, text).pipe(Effect.result);
      if (parsed._tag === "Success") heads.push({ ...parsed.success.frontMatter, orgId, path });
    }
    const reads = yield* cache
      .lastReads(orgId)
      .pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "index", cause })));
    const zone = yield* cache
      .ownerTimeZone(orgId)
      .pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "index", cause })));
    return buildIndex(heads, reads, yield* Clock.currentTimeMillis, zone);
  });
  const writeCommit = Effect.fn("MemoryWriter.writeCommit")(function* (
    orgId: KinOrgId,
    writer: string,
    parent: string,
    parentFiles: ReadonlyMap<string, Buffer>,
    changes: ReadonlyMap<string, Buffer>,
    message: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* io(orgId, fs.makeTempDirectoryScoped());
        const env = {
          GIT_INDEX_FILE: `${temporary}/index`,
          GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
          GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
          GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
          GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
        };
        yield* git(orgId, writer, ["read-tree", "--empty"], env);
        const entries = yield* readTree(orgId, writer, parent).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(VcsProcess, vcs),
        );
        const metadata = new Map(entries.map((entry) => [entry.relative, entry]));
        const finalFiles = new Map(parentFiles);
        for (const [file, bytes] of changes) finalFiles.set(file, bytes);
        const expected = new Map<string, { mode: string; sha: string }>();
        for (const [file, bytes] of finalFiles) {
          if (changes.has(file)) yield* safePath(orgId, writer, file, true);
          const input = `${temporary}/blob`;
          yield* io(orgId, fs.writeFile(input, bytes));
          const mode = changes.has(file) ? "100644" : (metadata.get(file)?.mode ?? "100644");
          const blob =
            mode === "160000"
              ? bytes.toString("ascii")
              : yield* git(orgId, writer, ["hash-object", "-w", "--no-filters", input], env);
          expected.set(file, {
            mode,
            sha: mode === "160000" ? bytes.toString("ascii") : objectHash(bytes, parent.length),
          });
          yield* git(
            orgId,
            writer,
            ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`],
            env,
          );
        }
        const tree = yield* git(orgId, writer, ["write-tree"], env);
        yield* verifyTree(orgId, writer, tree, expected).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(VcsProcess, vcs),
        );
        return yield* git(orgId, writer, ["commit-tree", tree, "-p", parent], env, message);
      }),
    );
  });
  const repoFor = Effect.fn("MemoryWriter.repoFor")(function* (orgId: KinOrgId) {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    if (!repo)
      return yield* new MemoryConfigError({ orgId, operation: "writer", reason: "Unknown org" });
    return repo;
  });
  const refuseMainWrite = Effect.fn("MemoryWriter.refuseMainWrite")(function* (orgId: KinOrgId) {
    const reason =
      "Memory writes to the default branch need the Kin GitHub App (TRIG-15); this one was not committed";
    yield* recovery.notify({ orgId, branch: config.defaultBranch ?? "main", reason });
    return yield* new MemorySyncConflict({ orgId, operation: "push", reason });
  });
  /**
   * Lands Kin's commits through PRs (TRIG-15). The local default branch moves only after GitHub
   * merged, and then to the remote head, so a refused PR leaves it where it was.
   */
  const landOnMain = Effect.fn("MemoryWriter.landOnMain")(function* (
    orgId: KinOrgId,
    writer: string,
    input: {
      readonly agentId: string;
      readonly id: string;
      readonly base: string;
      readonly commit: string;
      readonly message: string;
      readonly review?: { readonly commit: string; readonly message: string };
    },
  ) {
    if (Option.isNone(pullRequests)) return yield* refuseMainWrite(orgId);
    const repo = yield* repoFor(orgId);
    const main = config.defaultBranch ?? "main";
    const conflict = (reason: string) =>
      new MemorySyncConflict({ orgId, operation: "push", reason });
    if (repo.githubRepo === undefined || !isRepoSlug(repo.githubRepo))
      return yield* conflict("The memory repo is not on GitHub, so Kin cannot open its PR");
    const github = repo.githubRepo;
    const open = Effect.fn("MemoryWriter.openPullRequest")(function* (
      branch: string,
      commit: string,
      message: string,
      ownerReview: boolean,
    ) {
      yield* git(orgId, writer, [
        "push",
        "--",
        repo.repoUrl,
        `+${commit}:refs/heads/${branch}`,
      ]).pipe(Effect.mapError(() => conflict("Memory PR branch push rejected")));
      return yield* pullRequests.value.land({
        orgId,
        repo: github,
        branch,
        base: main,
        sha: commit,
        title: message.split("\n")[0] ?? message,
        message,
        ownerReview,
      });
    });
    // Each attempt's commit is fresh, so a retry gets its own branch; `land` refuses reused ones.
    const branch = `${WRITE_BRANCH_PREFIX}${input.agentId}/${input.id}-${input.commit.slice(0, 12)}`;
    const landed = yield* open(branch, input.commit, input.message, false).pipe(
      Effect.tapError((error) =>
        recovery.notify({
          orgId,
          branch,
          reason: `Memory write not merged: ${error.reason}${error._tag === "MemoryPullRequestRefused" && error.url ? ` (${error.url})` : ""}`,
        }),
      ),
      Effect.mapError((error) =>
        error._tag === "MemoryPullRequestRefused" ? conflict(error.reason) : error,
      ),
    );
    if (landed._tag !== "merged") return yield* conflict("The memory PR was not merged");
    // Opened only once the rest merged, so a refused write never leaves a lone review PR.
    if (input.review !== undefined) {
      const review = input.review;
      const reviewBranch = `${branch}${REVIEW_BRANCH_SUFFIX}`;
      yield* open(reviewBranch, review.commit, review.message, true).pipe(
        Effect.flatMap((opened) =>
          recovery.notify({
            orgId,
            branch: reviewBranch,
            reason: `Memory changes on paths you review wait in ${opened.url}. Kin pushed \`${review.commit}\`; if the PR's head differs, close it`,
          }),
        ),
        Effect.catch((error) =>
          recovery.notify({
            orgId,
            branch: reviewBranch,
            reason: `Memory changes on paths you review were not opened as a PR: ${error.reason}`,
          }),
        ),
      );
    }
    const advertised = yield* git(orgId, writer, [
      "ls-remote",
      "--",
      repo.repoUrl,
      `refs/heads/${main}`,
    ]);
    const [head, name] = advertised.split(/\s+/);
    if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || name !== `refs/heads/${main}`)
      return yield* conflict("The default branch is missing after the merge");
    yield* git(orgId, writer, ["fetch", "--", repo.repoUrl, head]);
    const ancestor = (older: string, newer: string) =>
      git(orgId, writer, ["merge-base", "--is-ancestor", older, newer]).pipe(
        Effect.as(true),
        Effect.catchTags({ MemoryError: () => Effect.succeed(false) }),
      );
    if (!(yield* ancestor(landed.commit, head)) || !(yield* ancestor(input.base, landed.commit)))
      return yield* conflict("The merged memory commit is not on the default branch");
    const [parent, mergedTree, ownTree] = [
      yield* git(orgId, writer, ["rev-parse", `${landed.commit}^`]),
      yield* git(orgId, writer, ["rev-parse", `${landed.commit}^{tree}`]),
      yield* git(orgId, writer, ["rev-parse", `${input.commit}^{tree}`]),
    ];
    if (parent === input.base && mergedTree !== ownTree)
      return yield* conflict("GitHub merged a different tree than Kin pushed");
    yield* filesAt(orgId, writer, head);
    yield* git(orgId, writer, ["update-ref", `refs/heads/${main}`, head, input.base]);
    yield* memory.record(orgId, main, input.base, head);
    yield* git(orgId, writer, ["push", "--", repo.repoUrl, `:refs/heads/${branch}`]).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not delete a merged memory PR branch", { orgId }),
      ),
    );
    return head;
  });
  const itemChanges = Effect.fn("MemoryWriter.itemChanges")(function* (
    orgId: KinOrgId,
    before: ReadonlyMap<string, Buffer>,
    after: ReadonlyMap<string, Buffer>,
  ) {
    const items: Array<WakeupMemoryChanges["items"][number]> = [];
    for (const [path, bytes] of after) {
      if (!folders.some((folder) => path.startsWith(`${folder}/`))) continue;
      const prior = before.get(path);
      if (prior?.equals(bytes)) continue;
      const next = yield* parseFrontMatter(orgId, path, bytes.toString("utf8")).pipe(Effect.option);
      if (Option.isNone(next)) continue;
      const fm = next.value.frontMatter;
      const old =
        prior === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* parseFrontMatter(orgId, path, prior.toString("utf8")).pipe(Effect.option),
            )?.frontMatter;
      const change: KinMemoryChangeKind =
        old === undefined
          ? "created"
          : fm.status === "superseded" && old.status !== "superseded"
            ? "superseded"
            : (fm.invalid_at !== null && old.invalid_at === null) ||
                (fm.status === "cancelled" && old.status !== "cancelled")
              ? "invalidated"
              : "updated";
      items.push({ itemId: fm.id, path, title: changeTitle(fm.title, fm.what), change });
    }
    return items.toSorted((a, b) => a.path.localeCompare(b.path));
  });
  const announce = (changes: WakeupMemoryChanges) =>
    Option.isNone(changeHooks) || changes.items.length === 0
      ? Effect.void
      : changeHooks.value
          .committed(changes)
          .pipe(
            Effect.catchCause((cause) => Effect.logWarning("Memory change card failed", cause)),
          );
  return MemoryWriter.of({
    stage: Effect.fn("MemoryWriter.stage")((orgId, wakeupId, change) =>
      report(
        orgId,
        wakeupId,
        locked(
          orgId,
          Effect.gen(function* () {
            const { ctx, state } = yield* session(orgId, wakeupId);
            const { writer } = yield* validate(orgId);
            yield* safePath(orgId, writer, change.path);
            if (change.path.startsWith("journal/"))
              return yield* new MemoryWriteRejected({
                reason: "Use appendJournal for journal additions",
              });
            const parsed = yield* parseFrontMatter(orgId, change.path, change.content, true);
            const source =
              change.sourceEventId === undefined
                ? {
                    saidBy: ctx.agentId,
                    trust: "agent",
                    source: `wakeup:${wakeupId}`,
                    kind: undefined,
                  }
                : ctx.sources.get(change.sourceEventId);
            if (!source)
              return yield* new MemoryWriteRejected({
                reason: "Source is not in the current batch",
              });
            const fm = parsed.frontMatter;
            const folder = fm.kind === "person" ? "people" : `${fm.kind}s`;
            if (!change.path.startsWith(`${folder}/`))
              return yield* new MemoryWriteRejected({ reason: "Kind does not match path" });
            const branch =
              ctx.level === "L0" ? shadowBranch(ctx.agentId) : (config.defaultBranch ?? "main");
            const recorded = yield* branchHead(orgId, writer, branch);
            const recordedFiles = yield* filesAt(orgId, writer, recorded);
            const items = [];
            const bodies = new Map<string, string>();
            const regular = new Set(
              (yield* readTree(orgId, writer, recorded).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(VcsProcess, vcs),
              ))
                .filter((entry) => ["100644", "100755"].includes(entry.mode))
                .map((entry) => entry.relative),
            );
            for (const [file, bytes] of recordedFiles) {
              if (!regular.has(file)) continue;
              if (!folders.some((folder) => file.startsWith(`${folder}/`))) continue;
              const content = bytes.toString("utf8");
              const parsedItem = yield* parseFrontMatter(orgId, file, content).pipe(Effect.result);
              if (parsedItem._tag === "Failure") {
                if (file === change.path)
                  return yield* new MemoryWriteRejected({
                    reason: "Cannot overwrite malformed recorded item",
                  });
                continue;
              }
              if (file === change.path && parsedItem.success.frontMatter.kind !== fm.kind)
                return yield* new MemoryWriteRejected({
                  reason: "Cannot change recorded item kind",
                });
              items.push({
                ...parsedItem.success.frontMatter,
                orgId,
                path: file,
                duplicate: false,
              });
              bodies.set(file, parsedItem.success.body);
            }
            for (const [file, text] of state.files) {
              if (file.startsWith("journal/") || file === "INDEX.md") continue;
              const staged = yield* parseFrontMatter(orgId, file, text);
              const index = items.findIndex((item) => item.path === file);
              const head = { ...staged.frontMatter, orgId, path: file, duplicate: false };
              if (index < 0) items.push(head);
              else items[index] = head;
              bodies.set(file, staged.body);
            }
            const superseded =
              change.supersedes === undefined
                ? undefined
                : items.find((item) => item.id === change.supersedes);
            const supersessionHash =
              change.supersedes === undefined
                ? undefined
                : NodeCrypto.createHash("sha256").update(stringify(change)).digest("hex");
            if (
              superseded?.status === "superseded" &&
              superseded.superseded_by === fm.id &&
              state.supersessions.get(change.path) === supersessionHash
            )
              return;
            if (
              change.supersedes !== undefined &&
              (!superseded ||
                superseded.status !== "open" ||
                superseded.kind !== fm.kind ||
                superseded.source !== source.source ||
                Date.parse(fm.recorded_at) <= Date.parse(superseded.recorded_at) ||
                superseded.id === fm.id)
            )
              return yield* new MemoryWriteRejected({
                reason: "Supersession requires the same source and kind",
              });
            for (const item of items) {
              if (
                (item.id === fm.id || item.status === "open") &&
                item.kind === fm.kind &&
                (item.id === fm.id || item.links.some((link) => fm.links.includes(link))) &&
                item.id !== change.supersedes
              ) {
                const body =
                  bodies.get(item.path) ?? (yield* memory.readItemQuietly(orgId, item.id)).body;
                const rank = (trust: string) =>
                  ["external", "agent", "member", "owner"].indexOf(trust);
                if (
                  item.id === fm.id &&
                  (rank(source.trust) < rank(item.trust) ||
                    (fm.status !== item.status &&
                      !(item.status === "open" && ["done", "cancelled"].includes(fm.status))))
                )
                  return yield* new MemoryConflict({ existingId: item.id });
                if (body !== parsed.body || item.title !== fm.title)
                  return yield* new MemoryConflict({ existingId: item.id });
                if (item.id === fm.id) {
                  const proposed = new Map(Object.entries(fm));
                  const mutable = new Set([
                    "orgId",
                    "path",
                    "duplicate",
                    "status",
                    "invalid_at",
                    "trust",
                    "said_by",
                    "source",
                    "source_event",
                  ]);
                  if (
                    source.kind === "owner_check" &&
                    source.itemId === item.id &&
                    source.action === "keep"
                  )
                    mutable.add("review_by");
                  if (
                    source.kind === "deferral_card" &&
                    source.action === "remind" &&
                    source.itemId === item.id &&
                    item.kind === "deferral" &&
                    fm.on_due === "remind"
                  )
                    mutable.add("on_due");
                  if (
                    source.kind === "deferral_card" &&
                    source.action === "monday" &&
                    source.itemId === item.id &&
                    item.kind === "deferral" &&
                    fm.due === source.due
                  )
                    mutable.add("due");
                  const existing = new Map(Object.entries(item));
                  if (
                    [...new Set([...existing.keys(), ...proposed.keys()])].some(
                      (key) =>
                        !mutable.has(key) &&
                        JSON.stringify(existing.get(key)) !== JSON.stringify(proposed.get(key)),
                    )
                  )
                    return yield* new MemoryConflict({ existingId: item.id });
                }
              }
              if (
                (item.path === change.path && item.id !== fm.id) ||
                (item.id === fm.id && item.path !== change.path)
              )
                return yield* new MemoryWriteRejected({
                  reason: "Cannot replace a different item",
                });
            }
            const fields = {
              ...fm,
              said_by: source.saidBy,
              source: source.source,
              source_event: change.sourceEventId,
              trust:
                fm.trust === "external" ||
                (fm.trust === "agent" && source.trust !== "external") ||
                (fm.trust === "member" && source.trust === "owner")
                  ? fm.trust
                  : source.trust,
              review_by: fm.review_by,
            };
            const existing = items.find((item) => item.id === fm.id);
            const text = render(
              existing
                ? {
                    ...fields,
                    trust: existing.trust,
                    said_by: existing.said_by,
                    source: existing.source,
                    source_event: existing.source_event,
                  }
                : fields,
              parsed.body,
            );
            yield* parseFrontMatter(orgId, change.path, text);
            if (superseded) {
              const oldBody =
                bodies.get(superseded.path) ??
                (yield* memory.readItemQuietly(orgId, superseded.id)).body;
              const {
                orgId: _org,
                path: oldPath,
                duplicate: _duplicate,
                ...oldFields
              } = superseded;
              const oldText = render(
                { ...oldFields, status: "superseded", superseded_by: fm.id },
                oldBody,
              );
              state.files.set(oldPath, oldText);
            }
            state.files.set(change.path, text);
            if (supersessionHash !== undefined)
              state.supersessions.set(change.path, supersessionHash);
          }),
        ),
      ),
    ),
    appendJournal: Effect.fn("MemoryWriter.appendJournal")((orgId, wakeupId, lines) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { ctx, state } = yield* session(orgId, wakeupId);
          if (lines.length === 1 && lines[0] === LEAD_ENDED_WITHOUT_KIN_END) {
            const { writer } = yield* validate(orgId);
            const branch =
              ctx.level === "L0" ? shadowBranch(ctx.agentId) : (config.defaultBranch ?? "main");
            const head = yield* branchHead(orgId, writer, branch);
            const { message } = yield* commitAt(orgId, writer, head);
            if (message.split("\n")[0] === `kin(${ctx.agentId}): wake-up ${wakeupId}`) return;
          }
          state.lines.push(...lines);
        }),
      ),
    ),
    discard: Effect.fn("MemoryWriter.discard")((orgId, wakeupId) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const state = sessions.get(orgId);
          if (state && state.wakeupId !== wakeupId)
            return yield* new MemoryWriteRejected({ reason: "Another wake-up owns the writer" });
          sessions.delete(orgId);
        }),
      ),
    ),
    commitWakeup: Effect.fn("MemoryWriter.commitWakeup")((orgId, wakeupId, outcome) =>
      locked(
        orgId,
        report(
          orgId,
          wakeupId,
          Effect.gen(function* () {
            const { ctx, state } = yield* session(orgId, wakeupId);
            const { writer } = yield* validate(orgId);
            yield* refuseDuringPurge(orgId);
            const repo = config.repositories.find((entry) => entry.orgId === orgId);
            if (!repo)
              return yield* new MemoryConfigError({
                orgId,
                operation: "writer",
                reason: "Unknown org",
              });
            const branch =
              ctx.level === "L0" ? shadowBranch(ctx.agentId) : (config.defaultBranch ?? "main");
            const onMain = branch === (config.defaultBranch ?? "main");
            if (onMain && mainWrites === "refused") return yield* refuseMainWrite(orgId);
            const viaPullRequest = onMain && mainWrites === "pull_request";
            const recorded = yield* branchHead(orgId, writer, branch);
            const unpushedKey = `${orgId}\u0000${branch}`;
            const push = (sha: string) =>
              git(orgId, writer, ["push", "--", repo.repoUrl, `${sha}:refs/heads/${branch}`]).pipe(
                Effect.tap(() => Effect.sync(() => unpushedShadows.delete(unpushedKey))),
                // A shadow commit is already what the lead reads, so a refused push leaves it on this server only.
                Effect.tapError(() =>
                  onMain || unpushedShadows.has(unpushedKey)
                    ? Effect.void
                    : Effect.sync(() => unpushedShadows.add(unpushedKey)).pipe(
                        Effect.andThen(
                          recovery.notify({
                            orgId,
                            branch,
                            reason: `The memory repo refused ${branch}, so this lead's shadow memory is only on this server. Kin pushes it again with the next commit; check that the memory deploy key can push kin/shadow/*`,
                          }),
                        ),
                      ),
                ),
                Effect.mapError(
                  (cause) =>
                    new MemorySyncConflict({
                      orgId,
                      operation: "push",
                      reason: "Push rejected; retry or reconcile remote",
                      cause,
                    }),
                ),
              );
            return yield* Effect.gen(function* () {
              const subject = `kin(${ctx.agentId}): wake-up ${wakeupId}`;
              const fingerprint = yield* git(
                orgId,
                writer,
                ["hash-object", "--no-filters", "--stdin"],
                {},
                stringify({
                  outcome,
                  files: [...state.files].sort(([a], [b]) => a.localeCompare(b)),
                  lines: state.lines,
                }),
              );
              const { message: body } = yield* commitAt(orgId, writer, recorded);
              if (body.split("\n")[0] === subject) {
                if (
                  !body.includes(`Kin-Outcome: ${outcome}`) ||
                  (state.files.size + state.lines.length > 0 &&
                    !body.includes(`Kin-Request: ${fingerprint}`))
                )
                  return yield* new MemoryWriteRejected({ reason: "Different wake-up retry" });
                // Through PRs the default branch only ever holds what GitHub already merged.
                if (!viaPullRequest) yield* push(recorded);
                return { commit: recorded };
              }
              if (outcome === "failed") state.files.clear();
              const entry = yield* journalEntry(ctx, outcome, state.lines);
              yield* safePath(orgId, writer, entry.path);
              const recordedFiles = yield* filesAt(orgId, writer, recorded);
              const journal = Buffer.concat([
                recordedFiles.get(entry.path) ?? Buffer.alloc(0),
                Buffer.from(entry.text),
              ]);
              state.files.set(entry.path, journal.toString("utf8"));
              const regular = yield* regularPaths(orgId, writer, recorded);
              const combined = new Map(
                [...recordedFiles]
                  .filter(([path]) => regular.has(path))
                  .map(([path, bytes]) => [path, bytes.toString("utf8")]),
              );
              // Paths the owner reviews reach the default branch only through their own PR.
              const reviewed = (path: string) => viaPullRequest && isOwnerReviewedPath(path);
              for (const [path, text] of state.files) if (!reviewed(path)) combined.set(path, text);
              state.files.set("INDEX.md", yield* indexFor(orgId, combined));
              const findings = yield* scanner.scan({
                orgId,
                files: [...state.files].map(([path, content]) => ({
                  path,
                  content: path === entry.path ? journal : new TextEncoder().encode(content),
                })),
              });
              if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
              const changes = new Map(
                [...state.files].map(([file, text]) => [
                  file,
                  file === entry.path ? journal : Buffer.from(text),
                ]),
              );
              const message = `${subject}\n\nEvents: ${ctx.eventIds.join(", ")}\nKin-Outcome: ${outcome}\nKin-Request: ${fingerprint}\n`;
              if (viaPullRequest) {
                const review = new Map([...changes].filter(([file]) => reviewed(file)));
                const commit = yield* writeCommit(
                  orgId,
                  writer,
                  recorded,
                  recordedFiles,
                  new Map([...changes].filter(([file]) => !reviewed(file))),
                  message,
                );
                const reviewMessage = `kin(${ctx.agentId}): review wake-up ${wakeupId}\n\nEvents: ${ctx.eventIds.join(", ")}\n`;
                const head = yield* landOnMain(orgId, writer, {
                  agentId: ctx.agentId,
                  id: wakeupId,
                  base: recorded,
                  commit,
                  message,
                  ...(review.size === 0
                    ? {}
                    : {
                        review: {
                          commit: yield* writeCommit(
                            orgId,
                            writer,
                            recorded,
                            recordedFiles,
                            review,
                            reviewMessage,
                          ),
                          message: reviewMessage,
                        },
                      }),
                });
                yield* memory.rebuildCache(orgId).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Could not refresh memory cache after commit", {
                      orgId,
                      errorTag: error._tag,
                    }),
                  ),
                );
                yield* announce({
                  orgId,
                  agentId: ctx.agentId,
                  wakeupId,
                  branch,
                  base: recorded,
                  commit: head,
                  items: yield* itemChanges(
                    orgId,
                    recordedFiles,
                    new Map([...changes].filter(([file]) => !reviewed(file))),
                  ),
                });
                return { commit: head };
              }
              const commit = yield* writeCommit(
                orgId,
                writer,
                recorded,
                recordedFiles,
                changes,
                message,
              );
              yield* git(orgId, writer, ["update-ref", `refs/heads/${branch}`, commit, recorded]);
              yield* memory.record(orgId, branch, recorded, commit);
              // Arms deferrals from the commit now, not at the next wake-up; shadow commits too.
              yield* memory.rebuildCache(orgId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not refresh memory cache after commit", {
                    orgId,
                    errorTag: error._tag,
                  }),
                ),
              );
              yield* push(commit);
              yield* announce({
                orgId,
                agentId: ctx.agentId,
                wakeupId,
                branch,
                base: recorded,
                commit,
                items: yield* itemChanges(orgId, recordedFiles, changes),
              });
              return { commit };
            }).pipe(Effect.ensuring(Effect.sync(() => sessions.delete(orgId))));
          }),
        ),
      ),
    ),
    dreamBase: Effect.fn("MemoryWriter.dreamBase")((orgId) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { writer } = yield* validate(orgId);
          const head = yield* branchHead(orgId, writer, config.defaultBranch ?? "main");
          const regular = yield* regularPaths(orgId, writer, head);
          const files = new Map(
            [...(yield* filesAt(orgId, writer, head))].filter(([path]) => regular.has(path)),
          );
          return { head, files };
        }),
      ),
    ),
    commitDream: Effect.fn("MemoryWriter.commitDream")((orgId, input) =>
      report(
        orgId,
        input.branch,
        locked(
          orgId,
          Effect.gen(function* () {
            if (!dreamBranch.test(input.branch))
              return yield* new MemoryWriteRejected({ reason: "Invalid dream branch" });
            const { writer } = yield* validate(orgId);
            yield* refuseDuringPurge(orgId);
            const repo = yield* repoFor(orgId);
            // A purge's reclone drops the old history, so a dream started before it has no base here.
            if (
              !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(input.base) ||
              (yield* git(orgId, writer, ["cat-file", "-e", `${input.base}^{commit}`]).pipe(
                Effect.result,
              ))._tag === "Failure"
            )
              return yield* new MemorySyncConflict({
                orgId,
                operation: "push",
                reason: "The dream's base is no longer in memory history",
              });
            const baseFiles = yield* filesAt(orgId, writer, input.base);
            const regular = yield* regularPaths(orgId, writer, input.base);
            const combined = new Map(
              [...baseFiles]
                .filter(([path]) => regular.has(path))
                .map(([path, bytes]) => [path, bytes.toString("utf8")]),
            );
            for (const [path, text] of input.files) {
              if (path === "INDEX.md")
                return yield* new MemoryWriteRejected({ reason: "INDEX.md is built by code" });
              yield* safePath(orgId, writer, path);
              if (!path.startsWith("journal/")) {
                const { frontMatter } = yield* parseFrontMatter(orgId, path, text);
                const folder = frontMatter.kind === "person" ? "people" : `${frontMatter.kind}s`;
                if (!path.startsWith(`${folder}/`))
                  return yield* new MemoryWriteRejected({ reason: "Kind does not match path" });
              }
              combined.set(path, text);
            }
            const changes = new Map(
              [...input.files].map(([path, text]) => [path, Buffer.from(text)]),
            );
            changes.set("INDEX.md", Buffer.from(yield* indexFor(orgId, combined)));
            const findings = yield* scanner.scan({
              orgId,
              files: [...changes].map(([path, content]) => ({ path, content })),
            });
            if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
            const commit = yield* writeCommit(
              orgId,
              writer,
              input.base,
              baseFiles,
              changes,
              input.message,
            );
            yield* git(orgId, writer, [
              "push",
              "--",
              repo.repoUrl,
              `+${commit}:refs/heads/${input.branch}`,
            ]).pipe(
              Effect.mapError(
                (cause) =>
                  new MemorySyncConflict({
                    orgId,
                    operation: "push",
                    reason: "Dream branch push rejected",
                    cause,
                  }),
              ),
            );
            return { commit };
          }),
        ),
      ),
    ),
    deleteDreamBranch: Effect.fn("MemoryWriter.deleteDreamBranch")((orgId, branch) =>
      locked(
        orgId,
        Effect.gen(function* () {
          if (!dreamBranch.test(branch))
            return yield* new MemoryWriteRejected({ reason: "Invalid dream branch" });
          const { writer } = yield* validate(orgId);
          yield* refuseDuringPurge(orgId);
          const repo = yield* repoFor(orgId);
          const advertised = yield* git(orgId, writer, [
            "ls-remote",
            "--",
            repo.repoUrl,
            `refs/heads/${branch}`,
          ]);
          if (advertised)
            yield* git(orgId, writer, ["push", "--", repo.repoUrl, `:refs/heads/${branch}`]);
        }),
      ),
    ),
    settleShadow: Effect.fn("MemoryWriter.settleShadow")((orgId, agentId, choice) =>
      locked(
        orgId,
        Effect.gen(function* () {
          if (!/^[a-zA-Z0-9_-]+$/.test(agentId))
            return yield* new MemoryWriteRejected({ reason: "Invalid agent id" });
          const { writer } = yield* validate(orgId);
          yield* refuseDuringPurge(orgId);
          const repo = yield* repoFor(orgId);
          const main = config.defaultBranch ?? "main";
          const shadow = shadowBranch(agentId);
          const mainHead = yield* branchHead(orgId, writer, main);
          const shadowHead = yield* branchHead(orgId, writer, shadow);
          const conflict = (reason: string) =>
            new MemorySyncConflict({ orgId, operation: "push", reason });
          const shadowChanges = Effect.gen(function* () {
            const mainFiles = yield* filesAt(orgId, writer, mainHead);
            if (shadowHead === mainHead) return { mainFiles, changes: new Map<string, Buffer>() };
            const base = yield* git(orgId, writer, ["merge-base", mainHead, shadowHead]).pipe(
              Effect.mapError(() => conflict("The shadow branch shares no history with main")),
            );
            const entries = (commit: string) =>
              readTree(orgId, writer, commit).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(VcsProcess, vcs),
                Effect.map((all) => new Map(all.map((entry) => [entry.relative, entry]))),
              );
            const merged = mergeMemoryFiles(
              yield* filesAt(orgId, writer, base),
              yield* filesAt(orgId, writer, shadowHead),
              mainFiles,
              yield* entries(base),
              yield* entries(shadowHead),
              yield* entries(mainHead),
            );
            if (merged === undefined)
              return yield* conflict("Shadow memory conflicts with the default branch");
            // The writer never deletes, so a deletion means the shadow branch was edited by hand.
            if ([...mainFiles.keys()].some((file) => !merged.files.has(file)))
              return yield* conflict("Shadow memory deletes files on the default branch");
            const changes = new Map(
              [...merged.files].filter(
                ([file, bytes]) => file !== "INDEX.md" && !mainFiles.get(file)?.equals(bytes),
              ),
            );
            return { mainFiles, changes };
          });
          if (choice._tag === "preview")
            return { kept: 0, paths: [...(yield* shadowChanges).changes.keys()].toSorted() };
          let head = mainHead;
          let kept = 0;
          let paths: ReadonlyArray<string> = [];
          if (choice._tag === "keep") {
            const { mainFiles, changes } = yield* shadowChanges;
            paths = [...changes.keys()].toSorted();
            const shown = choice.paths.toSorted();
            if (shown.length !== paths.length || paths.some((path, i) => path !== shown[i]))
              return yield* conflict("Shadow memory changed since its paths were listed");
            // Outside Kin's own folders the owner reviews every change in a PR (TRIG-15).
            const reviewed = paths.filter(isOwnerReviewedPath);
            if (reviewed.length > 0)
              return yield* conflict(
                `It changes paths you review in a pull request (${reviewed.slice(0, 5).join(", ")}${reviewed.length > 5 ? ", …" : ""}); start clean instead`,
              );
            if (changes.size > 0) {
              if (mainWrites === "refused") return yield* refuseMainWrite(orgId);
              kept = changes.size;
              const regular = yield* regularPaths(orgId, writer, mainHead);
              const combined = new Map(
                [...mainFiles, ...changes]
                  .filter(([path]) => regular.has(path) || changes.has(path))
                  .map(([path, bytes]) => [path, bytes.toString("utf8")]),
              );
              changes.set("INDEX.md", Buffer.from(yield* indexFor(orgId, combined)));
              const findings = yield* scanner.scan({
                orgId,
                files: [...changes].map(([path, content]) => ({ path, content })),
              });
              if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
              const message = `kin(${agentId}): keep shadow memory\n\nKin-Shadow: ${shadowHead}\n`;
              const commit = yield* writeCommit(
                orgId,
                writer,
                mainHead,
                mainFiles,
                changes,
                message,
              );
              if (mainWrites === "pull_request") {
                head = yield* landOnMain(orgId, writer, {
                  agentId,
                  id: `keep-${shadowHead.slice(0, 12)}`,
                  base: mainHead,
                  commit,
                  message,
                });
              } else {
                // Push first, so a rejected push leaves the local default branch where it was.
                yield* git(orgId, writer, [
                  "push",
                  "--",
                  repo.repoUrl,
                  `${commit}:refs/heads/${main}`,
                ]).pipe(
                  Effect.mapError(() => conflict("Push rejected; retry or reconcile remote")),
                );
                yield* git(orgId, writer, ["update-ref", `refs/heads/${main}`, commit, mainHead]);
                yield* memory.record(orgId, main, mainHead, commit);
                head = commit;
              }
              yield* memory.rebuildCache(orgId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not refresh memory cache after commit", {
                    orgId,
                    errorTag: error._tag,
                  }),
                ),
              );
            }
          }
          // A later trial at L0 starts from what the lead reads at L1, not the old shadow week.
          if (shadowHead !== head) {
            yield* git(orgId, writer, ["update-ref", `refs/heads/${shadow}`, head, shadowHead]);
            yield* memory.record(orgId, shadow, shadowHead, head);
            yield* git(orgId, writer, [
              "push",
              "--",
              repo.repoUrl,
              `+${head}:refs/heads/${shadow}`,
            ]).pipe(Effect.mapError(() => conflict("Shadow branch push rejected")));
          }
          return { kept, paths };
        }),
      ),
    ),
    undoChange: Effect.fn("MemoryWriter.undoChange")((orgId, input) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const main = config.defaultBranch ?? "main";
          if (
            !/^[a-zA-Z0-9_-]+$/.test(input.agentId) ||
            (input.branch !== main && input.branch !== shadowBranch(input.agentId)) ||
            !folders.some((folder) => input.path.startsWith(`${folder}/`))
          )
            return yield* new MemoryWriteRejected({ reason: "Invalid undo target" });
          const { writer } = yield* validate(orgId);
          yield* refuseDuringPurge(orgId);
          const repo = yield* repoFor(orgId);
          const onMain = input.branch === main;
          if (onMain && mainWrites === "refused") return yield* refuseMainWrite(orgId);
          const stale = { _tag: "stale" } as const;
          // A purge rewrites history, so the wake-up's commits may be gone.
          for (const sha of [input.base, input.commit])
            if (
              !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(sha) ||
              (yield* git(orgId, writer, ["cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.result))
                ._tag === "Failure"
            )
              return stale;
          const head = yield* branchHead(orgId, writer, input.branch);
          const headFiles = yield* filesAt(orgId, writer, head);
          const current = headFiles.get(input.path);
          const written = (yield* filesAt(orgId, writer, input.commit)).get(input.path);
          if (current === undefined || written === undefined || !current.equals(written))
            return stale;
          const before = (yield* filesAt(orgId, writer, input.base)).get(input.path);
          let restored: string;
          if (before !== undefined) restored = before.toString("utf8");
          else {
            // The writer never deletes, so undoing a new item marks it no longer true.
            const { frontMatter, body } = yield* parseFrontMatter(
              orgId,
              input.path,
              current.toString("utf8"),
            );
            const invalidAt = DateTime.formatIso(
              DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
            );
            restored = render({ ...frontMatter, invalid_at: invalidAt }, body);
          }
          const { frontMatter } = yield* parseFrontMatter(orgId, input.path, restored);
          if (frontMatter.id !== input.itemId)
            return yield* new MemoryWriteRejected({ reason: "Invalid undo target" });
          const changes = new Map([[input.path, Buffer.from(restored)]]);
          const regular = yield* regularPaths(orgId, writer, head);
          const combined = new Map(
            [...headFiles, ...changes]
              .filter(([path]) => regular.has(path) || changes.has(path))
              .map(([path, bytes]) => [path, bytes.toString("utf8")]),
          );
          changes.set("INDEX.md", Buffer.from(yield* indexFor(orgId, combined)));
          const findings = yield* scanner.scan({
            orgId,
            files: [...changes].map(([path, content]) => ({ path, content })),
          });
          if (findings.length) return yield* new MemorySecretBlocked({ orgId, findings });
          const message = `kin(${input.agentId}): owner undo ${input.itemId}\n\nKin-Undo: ${input.commit}\n`;
          const commit = yield* writeCommit(orgId, writer, head, headFiles, changes, message);
          const conflict = (reason: string) =>
            new MemorySyncConflict({ orgId, operation: "push", reason });
          let landed = commit;
          if (onMain && mainWrites === "pull_request") {
            landed = yield* landOnMain(orgId, writer, {
              agentId: input.agentId,
              id: `undo-${input.commit.slice(0, 12)}`,
              base: head,
              commit,
              message,
            });
          } else {
            // Push first, so a rejected push leaves the local branch where it was.
            yield* git(orgId, writer, [
              "push",
              "--",
              repo.repoUrl,
              `${commit}:refs/heads/${input.branch}`,
            ]).pipe(Effect.mapError(() => conflict("Push rejected; retry or reconcile remote")));
            yield* git(orgId, writer, ["update-ref", `refs/heads/${input.branch}`, commit, head]);
            yield* memory.record(orgId, input.branch, head, commit);
          }
          yield* memory.rebuildCache(orgId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not refresh memory cache after undo", {
                orgId,
                errorTag: error._tag,
              }),
            ),
          );
          return { _tag: "undone", commit: landed } as const;
        }),
      ),
    ),
    sweepPullRequests: Effect.fn("MemoryWriter.sweepPullRequests")((orgId) =>
      locked(
        orgId,
        Effect.gen(function* () {
          if (Option.isNone(pullRequests)) return;
          const repo = yield* repoFor(orgId);
          if (repo.githubRepo === undefined || !isRepoSlug(repo.githubRepo)) return;
          const moved = yield* pullRequests.value
            .sweep({ orgId, repo: repo.githubRepo, base: config.defaultBranch ?? "main" })
            .pipe(
              Effect.mapError(
                (error) =>
                  new MemorySyncConflict({ orgId, operation: "sweep", reason: error.reason }),
              ),
            );
          for (const pull of moved) {
            // A PR GitHub keeps refusing to close is reported once per process, not every sweep.
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
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(MemoryWriter, make).pipe(Layer.provide(MemoryCache.layer));
