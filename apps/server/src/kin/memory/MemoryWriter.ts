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
  MemoryItemFrontMatter,
  RepoSlug,
  type KinAgentId,
  type KinMemoryItemId,
  type KinPersonId,
  type MemoryItemHead,
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
import { parseFrontMatter, MemoryItemError, schemaKeyFailure } from "./frontMatter.ts";
import { journalEntry, MemoryJournalError, type JournalContext } from "./journal.ts";
import { isOwnerReviewedPath, kinShapeFailure } from "./lint.ts";
import { KinSecretScan, KinSecretScanError } from "./secretScan.ts";
import * as MemoryLander from "./MemoryLander.ts";
import { MemoryPullRequests } from "./MemoryPullRequests.ts";

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
export interface MemoryChange {
  readonly path: string;
  readonly content: string;
  readonly sourceEventId?: string;
  readonly supersedes?: string;
  /**
   * Only who may know the item changes (`LeadMemory.label`), so who asked doesn't have to outrank
   * who first said it. `share` is the owner letting the team know it; nothing else unmarks one.
   */
  readonly label?: "keep" | "share";
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
    /** Whether the wake-up has staged an item or a journal line that a commit would save. */
    readonly staged: (orgId: KinOrgId, wakeupId: string) => Effect.Effect<boolean, Failure>;
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
     * The owner's Undo of one item a wake-up changed: a new commit on the same branch that
     * restores the item from `base`, or invalidates it if the wake-up created it. Compare-and-set:
     * `stale` when the item differs from what `commit` wrote.
     */
    readonly undoChange: (
      orgId: KinOrgId,
      input: MemoryUndo,
    ) => Effect.Effect<MemoryUndoResult, Failure>;
    /**
     * The owner's own choice of who may know an item, outside any wake-up: one commit on the
     * default branch that sets its label and, when the team may now know it, who decided and when.
     */
    readonly relabel: (
      orgId: KinOrgId,
      input: {
        readonly itemId: KinMemoryItemId;
        readonly sensitive: boolean;
        readonly person: KinPersonId;
      },
    ) => Effect.Effect<{ readonly head: MemoryItemHead }, Failure>;
  }
>()("t3/kin/memory/MemoryWriter") {}
const isRepoSlug = Schema.is(RepoSlug);
const dreamBranch = /^dream\/\d{4}-\d{2}-\d{2}$/;
const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];
const render = (fields: object, body: string) => `---\n${stringify(fields)}---\n${body}`;
const make = Effect.gen(function* () {
  const memory = yield* Memory;
  const recovery = yield* MemoryRecoveryHooks;
  // Shadow branches whose last push was refused; the owner hears once until a push lands.
  const unpushedShadows = new Set<string>();
  const authority = yield* MemoryWriterAuthority;
  const hooks = yield* MemoryWriterHooks;
  const lander = yield* MemoryLander.MemoryLander;
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
  // Staged changes are per wake-up, so concurrent leads never share a session; the
  // git commit and push themselves stay serialized per repository under `locked`.
  // `changes` keeps each staged change so the commit replays them all against its own head
  // instead of laying files validated at an older one over another lead's commit.
  type SessionState = {
    wakeupId: string;
    generation: number;
    files: Map<string, string>;
    lines: string[];
    supersessions: Map<string, string>;
    changes: Map<string, MemoryChange>;
  };
  const sessions = new Map<string, SessionState>();
  const sessionKey = (orgId: KinOrgId, wakeupId: string) => `${orgId}\u0000${wakeupId}`;
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
  const wakeupSubject = (ctx: WakeupContext) => `kin(${ctx.agentId}): wake-up ${ctx.wakeupId}`;
  // The wake-up's commit, by the subject that names it: once another lead commits on the same
  // branch, the head is no longer this wake-up's commit even though it committed.
  const ownCommit = Effect.fn("MemoryWriter.ownCommit")(function* (
    orgId: KinOrgId,
    writer: string,
    head: string,
    ctx: WakeupContext,
  ) {
    const subject = wakeupSubject(ctx);
    // A day of slack for clock changes; the walk stops at older commits, so it stays short.
    const since = Date.parse(ctx.startedAt) - 86_400_000;
    const bound = since > 0 ? [`--since=${DateTime.formatIso(DateTime.makeUnsafe(since))}`] : [];
    const log = yield* git(orgId, writer, [
      "log",
      ...bound,
      "--fixed-strings",
      `--grep=${subject}`,
      "--format=%H%x09%s",
      head,
      "--",
    ]);
    for (const line of log.split("\n")) {
      const [sha, text] = line.split("\t");
      if (sha && text === subject) return sha;
    }
    return undefined;
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
    const key = sessionKey(orgId, wakeupId);
    const previous = sessions.get(key);
    const generation = yield* memory.historyGeneration(orgId);
    // A purge rewrote history after this wake-up staged; committing it could restore purged content.
    if (previous && previous.generation !== generation) {
      sessions.delete(key);
      return yield* new MemorySyncConflict({
        orgId,
        operation: "push",
        reason: "Memory history was rewritten during this wake-up; its staged changes were dropped",
      });
    }
    const state: SessionState = previous ?? {
      wakeupId,
      generation,
      files: new Map<string, string>(),
      lines: [],
      supersessions: new Map<string, string>(),
      changes: new Map<string, MemoryChange>(),
    };
    if (!previous && ctx.stagedReceipts) {
      const { writer } = yield* validate(orgId);
      const branch =
        ctx.level === "L0" ? shadowBranch(ctx.agentId) : (config.defaultBranch ?? "main");
      const head = yield* branchHead(orgId, writer, branch);
      if ((yield* ownCommit(orgId, writer, head, ctx)) === undefined) {
        const reason =
          "Staged changes and kin_end summary were lost on restart; tool receipts do not prove those changes were committed.";
        state.lines.push(reason);
        yield* recovery.notify({ orgId, branch: `wakeup:${wakeupId}`, reason });
      }
    }
    sessions.set(key, state);
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
  // The cause is dropped, so the reason keeps the key it names; only known keys, never values.
  const namedReason = (error: MemoryItemError) => {
    const failure = schemaKeyFailure(error);
    return failure !== undefined &&
      Object.hasOwn(MemoryItemFrontMatter.fields, failure.key.split(".")[0] ?? "")
      ? failure.reason
      : error.reason;
  };
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
                  reason: namedReason(error),
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
  // Checked before committing: a commit no PR could ever land would only sit on this server.
  const refuseOffGitHub = Effect.fn("MemoryWriter.refuseOffGitHub")(function* (orgId: KinOrgId) {
    const repo = yield* repoFor(orgId);
    if (repo.githubRepo === undefined || !isRepoSlug(repo.githubRepo))
      return yield* new MemorySyncConflict({
        orgId,
        operation: "push",
        reason: "The memory repo is not on GitHub, so Kin cannot open its PR",
      });
  });
  const refuseMainWrite = Effect.fn("MemoryWriter.refuseMainWrite")(function* (orgId: KinOrgId) {
    const reason =
      "Memory writes to the default branch need the Kin GitHub App (TRIG-15); this one was not committed";
    yield* recovery.notify({ orgId, branch: config.defaultBranch ?? "main", reason });
    return yield* new MemorySyncConflict({ orgId, operation: "push", reason });
  });
  /** One item changed by the owner outside a wake-up, committed and landed as a wake-up's is. */
  const ownerCommit = Effect.fn("MemoryWriter.ownerCommit")(function* (
    orgId: KinOrgId,
    input: {
      readonly writer: string;
      readonly repoUrl: string;
      readonly branch: string;
      readonly head: string;
      readonly headFiles: ReadonlyMap<string, Buffer>;
      readonly path: string;
      readonly content: string;
      readonly message: string;
    },
  ) {
    const { writer, branch, head, headFiles } = input;
    const onMain = branch === (config.defaultBranch ?? "main");
    const changes = new Map([[input.path, Buffer.from(input.content)]]);
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
    const commit = yield* writeCommit(orgId, writer, head, headFiles, changes, input.message);
    if (onMain && mainWrites === "pull_request") {
      yield* git(orgId, writer, ["update-ref", `refs/heads/${branch}`, commit, head]);
      yield* memory.record(orgId, branch, head, commit);
      yield* lander.signal(orgId);
    } else {
      // Push first, so a rejected push leaves the local branch where it was.
      yield* git(orgId, writer, [
        "push",
        "--",
        input.repoUrl,
        `${commit}:refs/heads/${branch}`,
      ]).pipe(
        Effect.mapError(
          () =>
            new MemorySyncConflict({
              orgId,
              operation: "push",
              reason: "Push rejected; retry or reconcile remote",
            }),
        ),
      );
      yield* git(orgId, writer, ["update-ref", `refs/heads/${branch}`, commit, head]);
      yield* memory.record(orgId, branch, head, commit);
    }
    yield* memory.rebuildCache(orgId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not refresh memory cache after an owner change", {
          orgId,
          errorTag: error._tag,
        }),
      ),
    );
    return commit;
  });
  const stageChange = Effect.fn("MemoryWriter.stageChange")(function* (
    orgId: KinOrgId,
    wakeupId: string,
    ctx: WakeupContext,
    state: SessionState,
    change: MemoryChange,
  ) {
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
    const labelled = items.find((item) => item.id === fm.id);
    if (
      labelled !== undefined &&
      labelled.sensitive !== false &&
      fm.sensitive === false &&
      change.label !== "share"
    )
      return yield* new MemoryWriteRejected({
        reason: "Only the owner lets the team know an item",
      });
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
        const body = bodies.get(item.path) ?? (yield* memory.readItemQuietly(orgId, item.id)).body;
        const rank = (trust: string) => ["external", "agent", "member", "owner"].indexOf(trust);
        if (
          item.id === fm.id &&
          ((change.label === undefined && rank(source.trust) < rank(item.trust)) ||
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
            "sensitive",
            "shared_by",
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
        bodies.get(superseded.path) ?? (yield* memory.readItemQuietly(orgId, superseded.id)).body;
      const { orgId: _org, path: oldPath, duplicate: _duplicate, ...oldFields } = superseded;
      const oldText = render({ ...oldFields, status: "superseded", superseded_by: fm.id }, oldBody);
      state.files.set(oldPath, oldText);
    }
    state.files.set(change.path, text);
    if (supersessionHash !== undefined) state.supersessions.set(change.path, supersessionHash);
    state.changes.set(change.path, change);
  });
  return MemoryWriter.of({
    stage: Effect.fn("MemoryWriter.stage")((orgId, wakeupId, change) =>
      report(
        orgId,
        wakeupId,
        locked(
          orgId,
          Effect.gen(function* () {
            const { ctx, state } = yield* session(orgId, wakeupId);
            yield* stageChange(orgId, wakeupId, ctx, state, change);
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
            if ((yield* ownCommit(orgId, writer, head, ctx)) !== undefined) return;
          }
          state.lines.push(...lines);
        }),
      ),
    ),
    staged: Effect.fn("MemoryWriter.staged")((orgId, wakeupId) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { state } = yield* session(orgId, wakeupId);
          return state.files.size + state.lines.length > 0;
        }),
      ),
    ),
    discard: Effect.fn("MemoryWriter.discard")((orgId, wakeupId) =>
      locked(
        orgId,
        Effect.sync(() => {
          sessions.delete(sessionKey(orgId, wakeupId));
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
            if (viaPullRequest) yield* refuseOffGitHub(orgId);
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
              const subject = wakeupSubject(ctx);
              const fingerprintOf = () =>
                git(
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
              let fingerprint = yield* fingerprintOf();
              const own = yield* ownCommit(orgId, writer, recorded, ctx);
              if (own !== undefined) {
                const { message: body } = yield* commitAt(orgId, writer, own);
                if (
                  !body.includes(`Kin-Outcome: ${outcome}`) ||
                  (state.files.size + state.lines.length > 0 &&
                    !body.includes(`Kin-Request: ${fingerprint}`))
                )
                  return yield* new MemoryWriteRejected({ reason: "Different wake-up retry" });
                if (viaPullRequest) yield* lander.signal(orgId);
                else yield* push(recorded);
                return { commit: own };
              }
              if (outcome === "failed") state.files.clear();
              // Staged files are whole files, validated against whatever head and overlay they
              // were staged on, so every change is replayed from a clean state at this head.
              if (outcome !== "failed" && state.changes.size > 0) {
                const original = [...state.changes.values()];
                state.files.clear();
                state.supersessions.clear();
                state.changes.clear();
                for (const change of original)
                  yield* stageChange(orgId, wakeupId, ctx, state, change).pipe(
                    Effect.mapError((error) =>
                      error._tag === "MemoryConflict" ||
                      error._tag === "MemoryWriteRejected" ||
                      error._tag === "MemoryDuplicateId"
                        ? new MemorySyncConflict({
                            orgId,
                            operation: "push",
                            reason: `Memory changed since this wake-up staged ${change.path}; its change no longer applies cleanly and was not committed`,
                            cause: error,
                          })
                        : error,
                    ),
                  );
                fingerprint = yield* fingerprintOf();
              }
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
              // Paths the owner reviews stay off the default branch; the lander opens their PR.
              const commit = yield* writeCommit(
                orgId,
                writer,
                recorded,
                recordedFiles,
                viaPullRequest
                  ? new Map([...changes].filter(([file]) => !reviewed(file)))
                  : changes,
                message,
              );
              const review = new Map([...changes].filter(([file]) => reviewed(file)));
              if (review.size > 0) {
                const reviewCommit = yield* writeCommit(
                  orgId,
                  writer,
                  recorded,
                  recordedFiles,
                  review,
                  `kin(${ctx.agentId}): review wake-up ${wakeupId}\n\nEvents: ${ctx.eventIds.join(", ")}\n`,
                );
                yield* git(orgId, writer, [
                  "update-ref",
                  `${MemoryLander.REVIEW_REF_PREFIX}${ctx.agentId}/${wakeupId}-${commit.slice(0, 12)}`,
                  reviewCommit,
                  "0".repeat(reviewCommit.length),
                ]);
              }
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
              // The wake-up is done once its commit is here; GitHub gets it in the background.
              if (viaPullRequest) yield* lander.signal(orgId);
              else yield* push(commit);
              return { commit };
            }).pipe(
              Effect.ensuring(Effect.sync(() => sessions.delete(sessionKey(orgId, wakeupId)))),
            );
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
    // The push runs outside the writer lock, under the landing lock so no purge starts meanwhile.
    commitDream: Effect.fn("MemoryWriter.commitDream")((orgId, input) =>
      report(
        orgId,
        input.branch,
        memory.withLandingLock(
          orgId,
          Effect.gen(function* () {
            const { writer, repo, commit } = yield* locked(
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
                    const folder =
                      frontMatter.kind === "person" ? "people" : `${frontMatter.kind}s`;
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
                return { writer, repo, commit };
              }),
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
      memory.withLandingLock(
        orgId,
        Effect.gen(function* () {
          if (!dreamBranch.test(branch))
            return yield* new MemoryWriteRejected({ reason: "Invalid dream branch" });
          const { writer, repo } = yield* locked(
            orgId,
            Effect.gen(function* () {
              const { writer } = yield* validate(orgId);
              yield* refuseDuringPurge(orgId);
              return { writer, repo: yield* repoFor(orgId) };
            }),
          );
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
          if (onMain && mainWrites === "pull_request") yield* refuseOffGitHub(orgId);
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
          const commit = yield* ownerCommit(orgId, {
            writer,
            repoUrl: repo.repoUrl,
            branch: input.branch,
            head,
            headFiles,
            path: input.path,
            content: restored,
            message: `kin(${input.agentId}): owner undo ${input.itemId}\n\nKin-Undo: ${input.commit}\n`,
          });
          return { _tag: "undone", commit } as const;
        }),
      ),
    ),
    relabel: Effect.fn("MemoryWriter.relabel")((orgId, input) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const main = config.defaultBranch ?? "main";
          const { writer } = yield* validate(orgId);
          yield* refuseDuringPurge(orgId);
          const repo = yield* repoFor(orgId);
          if (mainWrites === "refused") return yield* refuseMainWrite(orgId);
          if (mainWrites === "pull_request") yield* refuseOffGitHub(orgId);
          const item = yield* memory.readItemQuietly(orgId, input.itemId);
          const head = yield* branchHead(orgId, writer, main);
          const headFiles = yield* filesAt(orgId, writer, head);
          const current = headFiles.get(item.head.path);
          if (current === undefined) return yield* new MemoryNotFound({ orgId, id: input.itemId });
          const { frontMatter, body } = yield* parseFrontMatter(
            orgId,
            item.head.path,
            current.toString("utf8"),
          );
          if (frontMatter.id !== input.itemId)
            return yield* new MemoryNotFound({ orgId, id: input.itemId });
          const { shared_by: _before, ...kept } = frontMatter;
          const next = input.sensitive
            ? { ...kept, sensitive: true }
            : {
                ...kept,
                sensitive: false,
                shared_by: {
                  person: input.person,
                  at: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
                },
              };
          const labelled = { ...next, orgId, path: item.head.path };
          if (frontMatter.sensitive === input.sensitive) return { head: labelled };
          yield* ownerCommit(orgId, {
            writer,
            repoUrl: repo.repoUrl,
            branch: main,
            head,
            headFiles,
            path: item.head.path,
            content: render(next, body),
            message: `kin: owner ${input.sensitive ? "keeps" : "shares"} ${input.itemId}\n`,
          });
          return { head: labelled };
        }),
      ),
    ),
  });
});
export const layer = Layer.effect(MemoryWriter, make).pipe(
  Layer.provide(MemoryCache.layer),
  Layer.provideMerge(MemoryLander.layer),
);
