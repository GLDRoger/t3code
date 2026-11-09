import * as SecretScan from "./secretScan.ts";
import {
  readTree,
  readObjects,
  ancestors,
  readCommit,
  readFiles,
  objectHash,
  verifyTree,
} from "./objects.ts";
import {
  type KinAgentId,
  type KinMemoryItemId,
  type KinOrgId,
  MemoryItemHead,
  type MemoryItemKind,
  type MemoryItemFrontMatter,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as SqlClient from "effect/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { isCheckoutPath, itemFolders } from "./checkoutPaths.ts";
import { memoryGit as runMemoryGit } from "./git.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import * as MemoryCache from "./MemoryCache.ts";
import { mergeMemoryFiles, uniqueMergeBase } from "./merge.ts";
import { buildIndex, indexIsStale } from "./buildIndex.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import {
  MemoryItemError,
  memoryDateMillis as dateMillis,
  parseFrontMatter,
} from "./frontMatter.ts";

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  orgId: Schema.String,
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  reason: Schema.optional(Schema.String),
}) {}

const failureFields = {
  orgId: Schema.String,
  operation: Schema.String,
  reason: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
};

export class MemoryCheckoutInvalid extends Schema.TaggedError<MemoryCheckoutInvalid>()(
  "MemoryCheckoutInvalid",
  failureFields,
) {}
export class MemoryConfigError extends Schema.TaggedError<MemoryConfigError>()(
  "MemoryConfigError",
  failureFields,
) {}
export class MemorySyncConflict extends Schema.TaggedError<MemorySyncConflict>()(
  "MemorySyncConflict",
  failureFields,
) {}
export class MemoryQueryDecodeError extends Schema.TaggedError<MemoryQueryDecodeError>()(
  "MemoryQueryDecodeError",
  failureFields,
) {}

type MemoryFailure =
  | MemoryError
  | MemoryCheckoutInvalid
  | MemoryConfigError
  | MemorySyncConflict
  | MemoryQueryDecodeError;

export class MemoryNotFound extends Schema.TaggedError<MemoryNotFound>()("MemoryNotFound", {
  orgId: Schema.String,
  id: Schema.String,
}) {}

export class MemoryDuplicateId extends Schema.TaggedError<MemoryDuplicateId>()(
  "MemoryDuplicateId",
  {
    orgId: Schema.String,
    id: Schema.String,
  },
) {}

export class MemoryBlobTooLarge extends Schema.TaggedError<MemoryBlobTooLarge>()(
  "MemoryBlobTooLarge",
  {
    orgId: Schema.String,
    path: Schema.String,
    size: Schema.Number,
  },
) {}

export interface MemoryPaths {
  readonly writer: string;
  readonly read: string;
}

/**
 * Whose memory a read sees. A lead at L0 reads its shadow branch, chosen from its `kin_leads`
 * level and never from tool input; any other lead, and an omitted view, read the default branch.
 * `triggers` is what deferral triggers arm from: the default branch with each lead's own shadow
 * changes laid over it, until the owner keeps or discards them after a raise.
 */
export type LeadView = { readonly lead: KinAgentId };
export type MemoryView = LeadView | "triggers";
export const shadowBranch = (agentId: string) => `kin/shadow/${agentId}`;

export interface MemoryQuery {
  readonly kind?: MemoryItemKind;
  readonly status?: MemoryItemHead["status"];
  readonly dueBefore?: string;
  readonly dueAfter?: string;
  readonly reviewOverdue?: boolean;
  readonly saidBy?: string;
  readonly linksTo?: string;
  readonly excludeInvalid?: boolean;
  readonly limit?: number;
}

export class MemoryRecoveryHooks extends Context.Service<
  MemoryRecoveryHooks,
  {
    readonly notify: (notice: {
      orgId: KinOrgId;
      branch: string;
      reason: string;
      conflictBranch?: string;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/memory/Memory/MemoryRecoveryHooks") {}

export interface MemorySyncSnapshot {
  readonly head: string;
  readonly items: ReadonlyArray<MemoryCache.MemoryItem>;
  readonly duplicateIds: ReadonlySet<string>;
}

/** Sees the `triggers` view on every load and owns its own once-per-head, retry and failure handling. */
export class MemorySyncHooks extends Context.Reference<{
  readonly syncItems: (orgId: KinOrgId, snapshot: MemorySyncSnapshot) => Effect.Effect<void>;
}>("t3/kin/memory/Memory/MemorySyncHooks", {
  defaultValue: () => ({ syncItems: () => Effect.void }),
}) {}

export interface MemoryHistoryRewrite {
  /** Writes the durable marker, then deletes the writer and read checkouts that hold the old history. */
  readonly quarantine: (marker: string) => Effect.Effect<void, MemoryFailure>;
  /** Clones fresh, records the remote heads without preserving old anchors, rebuilds, then clears the marker. */
  readonly reclone: () => Effect.Effect<void, MemoryFailure>;
}

export class Memory extends Context.Service<
  Memory,
  {
    readonly withWriterLock: <A, E>(
      orgId: KinOrgId,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
    readonly anchor: (
      orgId: KinOrgId,
      branch: string,
      initial?: string,
    ) => Effect.Effect<string, MemoryFailure>;
    /** Server-only; never register as an agent tool. */
    readonly record: (
      orgId: KinOrgId,
      branch: string,
      previous: string,
      head: string,
    ) => Effect.Effect<void, MemoryFailure>;
    readonly recover: (orgId: KinOrgId) => Effect.Effect<void, MemoryFailure>;
    /** Server-only, for `KinPurge`: runs `body` under the writer lock with the checkout operations a history rewrite needs. */
    readonly withHistoryRewrite: <A, E>(
      orgId: KinOrgId,
      body: (rewrite: MemoryHistoryRewrite) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E>;
    /** The durable marker of an unfinished history rewrite; while present, nothing pushes old anchors. */
    readonly purgeInFlight: (orgId: KinOrgId) => Effect.Effect<string | undefined, MemoryFailure>;
    /** Bumped whenever a history rewrite drops the checkouts; work staged under an older value is stale. */
    readonly historyGeneration: (orgId: KinOrgId) => Effect.Effect<number>;
    readonly ensureCheckouts: (orgId: KinOrgId) => Effect.Effect<MemoryPaths, MemoryFailure>;
    /** Syncs the default branch and fills the read checkout with the waking lead's view. */
    readonly prepareWakeup: (
      orgId: KinOrgId,
      wakeupId?: string,
      view?: LeadView,
    ) => Effect.Effect<{ head: string; indexAsOf: DateTime.Utc }, MemoryFailure>;
    readonly readPromptSnapshot: (
      orgId: KinOrgId,
      expectedHead: string,
      view?: LeadView,
    ) => Effect.Effect<{ readonly rules: string; readonly index: string }, MemoryFailure>;
    readonly readIndex: (orgId: KinOrgId) => Effect.Effect<string, MemoryFailure>;
    readonly readRules: (orgId: KinOrgId) => Effect.Effect<string, MemoryFailure>;
    readonly readItem: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
      view?: MemoryView,
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryFailure | MemoryNotFound | MemoryDuplicateId>;
    readonly readItemQuietly: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
      view?: MemoryView,
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryFailure | MemoryNotFound | MemoryDuplicateId>;
    readonly query: (
      orgId: KinOrgId,
      query: MemoryQuery,
      view?: MemoryView,
    ) => Effect.Effect<
      ReadonlyArray<MemoryItemHead & { readonly duplicate: boolean }>,
      MemoryFailure
    >;
    readonly rebuildIndex: (orgId: KinOrgId) => Effect.Effect<void, MemoryFailure>;
    readonly rebuildCache: (orgId: KinOrgId) => Effect.Effect<void, MemoryFailure>;
  }
>()("t3/kin/memory/Memory") {}

const decodeHead = Schema.decodeEffect(MemoryItemHead);

export const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];

export const maxBlobBytes = 256 * 1024;
// Well under memoryGit's 64 MiB output cap, so a large journal reads in a few `cat-file` runs.
const checkoutBatchBytes = 16 * 1024 * 1024;

interface Snapshot extends MemorySyncSnapshot {
  readonly branch: string;
  readonly files: ReadonlyMap<string, string>;
  /** Blob id of each memory file, to tell a shadow branch's own changes from inherited ones. */
  readonly blobIds: ReadonlyMap<string, string>;
  index?: string;
}

interface ParsedBlob {
  readonly frontMatter: MemoryItemFrontMatter;
  readonly body: string;
}

interface BlobCache {
  readonly blobs: Map<string, string | undefined>;
  readonly parsedBlobs: Map<string, ParsedBlob | undefined>;
  readonly mismatchWarnings: Set<string>;
}

const make = Effect.gen(function* () {
  const scanner = yield* SecretScan.KinSecretScan;
  const config = yield* MemoryConfig;
  const fs = yield* FileSystem.FileSystem;
  const { notify } = yield* MemoryRecoveryHooks;
  const vcs = yield* VcsProcess;
  const memoryGit = (...args: Parameters<typeof runMemoryGit>) =>
    runMemoryGit(...args).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
      Effect.provideService(MemoryConfig, config),
    );
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const writerLocks = new Map<KinOrgId, Semaphore.Semaphore>();
  const pinnedHeads = new Map<KinOrgId, string>();
  const skipWarnedHeads = new Map<KinOrgId, string>();
  const hooks = yield* MemorySyncHooks;
  const withWriterLock = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) => {
    let lock = writerLocks.get(orgId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      writerLocks.set(orgId, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const persistence = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlError("Memory.anchor")),
      Effect.mapError((cause) => new MemoryError({ orgId, operation: "anchor", cause })),
    );
  const anchor = Effect.fn("Memory.anchor")(function* (
    orgId: KinOrgId,
    branch: string,
    initial?: string,
  ) {
    return yield* persistence(
      orgId,
      sql.withTransaction(
        Effect.gen(function* () {
          if (initial !== undefined)
            yield* sql`INSERT INTO kin_memory_heads (org_id, branch, head)
        VALUES (${orgId}, ${branch}, ${initial}) ON CONFLICT DO NOTHING RETURNING head`;
          const rows = yield* sql<{
            head: string;
          }>`SELECT head FROM kin_memory_heads WHERE org_id = ${orgId} AND branch = ${branch} ORDER BY branch`;
          return rows[0]?.head;
        }),
      ),
    ).pipe(
      Effect.filterOrFail(
        (head): head is string => head !== undefined,
        () =>
          new MemoryCheckoutInvalid({
            orgId,
            operation: "anchor",
            reason: "Missing SQLite anchor",
          }),
      ),
    );
  });
  const record = Effect.fn("Memory.record")(function* (
    orgId: KinOrgId,
    branch: string,
    previous: string,
    head: string,
  ) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* persistence(
            orgId,
            sql`UPDATE kin_memory_heads SET head = ${head}
        WHERE org_id = ${orgId} AND branch = ${branch} AND head = ${previous} RETURNING head`,
          );
          if (rows.length !== 1)
            return yield* new MemoryCheckoutInvalid({
              orgId,
              operation: "record",
              reason: "Anchor changed",
            });
          // The front-matter cache follows commits to the default branch.
          if (branch === (config.defaultBranch ?? "main") && pinnedHeads.get(orgId) === previous)
            pinnedHeads.set(orgId, head);
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "MemoryCheckoutInvalid" || cause._tag === "MemoryError"
            ? cause
            : new MemoryError({
                orgId,
                operation: "record",
                cause: toPersistenceSqlError("Memory.record")(cause),
              }),
        ),
      );
  });
  const cache = yield* MemoryCache.MemoryCache;
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const initializedCheckouts = new Set<KinOrgId>();
  const historyGenerations = new Map<KinOrgId, number>();
  const mainBranch = config.defaultBranch ?? "main";
  // Keyed by `snapshotKey`: each branch a lead reads has its own snapshot and blob cache.
  const duplicateWarnings = new Map<string, ReadonlySet<string>>();
  const snapshots = new Map<string, Snapshot>();
  const blobCaches = new Map<string, BlobCache>();
  const snapshotKey = (orgId: KinOrgId, branch: string) => `${orgId}\u0000${branch}`;
  const triggerViews = new Map<KinOrgId, { readonly key: string; readonly snapshot: Snapshot }>();
  // The branch the read checkout holds; its INDEX.md is only ever that branch's index.
  const checkoutBranches = new Map<KinOrgId, string>();
  const forgetSnapshots = (orgId: KinOrgId) => {
    for (const cache of [snapshots, blobCaches, duplicateWarnings])
      for (const key of cache.keys()) if (key.startsWith(`${orgId}\u0000`)) cache.delete(key);
    triggerViews.delete(orgId);
  };

  const locked = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) => {
    if (!config.repositories.some((entry) => entry.orgId === orgId))
      return Effect.fail(
        new MemoryConfigError({ orgId, operation: "config", reason: "Unknown organization" }),
      );
    let lock = locks.get(orgId);
    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(orgId, lock);
    }
    return lock.withPermits(1)(effect);
  };
  const git = Effect.fn("Memory.git")(function* (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
    stdin?: string,
    onStdoutChunk?: (chunk: Uint8Array) => void,
  ) {
    return yield* memoryGit(cwd, args, stdin, {}, onStdoutChunk).pipe(
      Effect.mapError((cause) =>
        cause._tag === "MemoryGitMissingRepository"
          ? new MemoryCheckoutInvalid({
              orgId,
              operation: "git",
              reason: "Writer .git is missing or not a directory",
              path: cwd,
              cause,
            })
          : new MemoryError({ orgId, operation: "git", cause }),
      ),
    );
  });
  const advertisedHead = Effect.fn("Memory.advertisedHead")(function* (
    orgId: KinOrgId,
    writer: string,
    url: string,
    branch: string,
  ) {
    const line = (yield* git(orgId, writer, [
      "ls-remote",
      "--",
      url,
      `refs/heads/${branch}`,
    ])).trim();
    const [head, name] = line.split(/\s+/);
    if (!head || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || name !== `refs/heads/${branch}`)
      return yield* new MemoryCheckoutInvalid({
        orgId,
        operation: "remote",
        reason: "Missing advertised head",
      });
    yield* git(orgId, writer, ["fetch", "--", url, head]);
    yield* readFiles(orgId, writer, head).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
    return head;
  });
  const io = <A, E, R>(orgId: KinOrgId, operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation, cause })));

  const pathsFor = Effect.fn("Memory.pathsFor")(function* (orgId: KinOrgId) {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    const base = path.resolve(config.baseDirectory);
    if (!repo)
      return yield* new MemoryConfigError({
        orgId,
        operation: "config",
        reason: "Unknown organization",
      });
    const root = path.resolve(base, repo.path);
    const comparable = (value: string) => value.normalize("NFC").toLowerCase();
    const roots = config.repositories.map((entry) => ({
      orgId: entry.orgId,
      root: path.resolve(base, entry.path),
    }));
    if (
      roots.some((entry, index) => {
        const key = comparable(entry.root);
        return (
          !entry.root.startsWith(base + path.sep) ||
          roots.slice(index + 1).some((other) => {
            const otherKey = comparable(other.root);
            return (
              entry.orgId === other.orgId ||
              otherKey === key ||
              otherKey.startsWith(key + path.sep) ||
              key.startsWith(otherKey + path.sep)
            );
          })
        );
      })
    )
      return yield* new MemoryConfigError({
        orgId,
        operation: "config",
        reason: "Overlapping or escaping memory paths",
      });
    const writer = path.join(root, "memory");
    const read = path.join(root, "memory-read");
    for (const directory of [writer, read]) {
      let ancestor = directory;
      while (true) {
        if (yield* io(orgId, "exists", fs.exists(ancestor))) {
          const stat = yield* io(orgId, "stat", fs.lstat(ancestor));
          if (stat.type !== "Directory")
            return yield* new MemoryConfigError({
              orgId,
              operation: "config",
              reason: "Memory ancestors must be real directories",
            });
        }
        if (ancestor === base) break;
        ancestor = path.dirname(ancestor);
      }
    }
    return { repo, root, writer, read };
  });

  const markerPath = (root: string) => path.join(root, "purge-in-flight");
  /** Half-finished clones from a crash; after a purge they can hold the old history. */
  const removeStaleClones = Effect.fn("Memory.removeStaleClones")(function* (
    orgId: KinOrgId,
    root: string,
  ) {
    for (const entry of yield* io(orgId, "clones", fs.readDirectory(root)))
      if (/^memory(?:\.clone|-read\.next)-[A-Za-z0-9]+$/.test(entry))
        yield* io(
          orgId,
          "recoverClone",
          fs.remove(path.join(root, entry), { recursive: true, force: true }),
        );
  });
  const purgeInFlight = Effect.fn("Memory.purgeInFlight")(function* (orgId: KinOrgId) {
    const { root } = yield* pathsFor(orgId);
    if (!(yield* io(orgId, "purgeMarker", fs.exists(markerPath(root))))) return undefined;
    return yield* io(orgId, "purgeMarker", fs.readFileString(markerPath(root)));
  });
  const refuseDuringPurge = Effect.fn("Memory.refuseDuringPurge")(function* (
    orgId: KinOrgId,
    operation: string,
  ) {
    if ((yield* purgeInFlight(orgId)) !== undefined)
      return yield* new MemorySyncConflict({
        orgId,
        operation,
        reason: "A memory purge is in flight; old history must not be pushed",
      });
  });

  const walkAncestors = (...args: Parameters<typeof ancestors>) =>
    ancestors(...args).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );

  const validateWriter = Effect.fn("Memory.validateWriter")(function* (
    orgId: KinOrgId,
    paths: { writer: string; repo: { repoUrl: string } },
    checkTip = true,
  ) {
    yield* Effect.gen(function* () {
      const entry = yield* fs.lstat(path.join(paths.writer, ".git"));
      if (entry.type !== "Directory")
        return yield* new MemoryError({
          orgId,
          operation: "source",
          reason: "Writer .git must be a directory",
        });
      const branch = config.defaultBranch ?? "main";
      const expected = yield* anchor(orgId, branch);
      for (const name of ["objects", "refs"]) {
        if ((yield* fs.lstat(`${paths.writer}/.git/${name}`)).type !== "Directory")
          return yield* new MemoryCheckoutInvalid({
            orgId,
            operation: "validate",
            reason: "Invalid git directory",
          });
      }
      const head = (yield* git(orgId, paths.writer, ["rev-parse", `refs/heads/${branch}`])).trim();
      if (!checkTip) return;
      if (head !== expected) {
        yield* git(orgId, paths.writer, ["update-ref", `refs/heads/${branch}`, expected, head]);
        yield* notify({
          orgId,
          branch,
          reason: "Reset tampered branch to anchor; unpushed work at the replaced tip is lost",
        });
      }
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryCheckoutInvalid({
            orgId,
            operation: "validate",
            path: paths.writer,
            reason: "Writer validation failed; manual recovery required",
            cause,
          }),
      ),
    );
  });

  const ensureCheckouts = Effect.fn("Memory.ensureCheckouts")(function* (
    orgId: KinOrgId,
    reusePin = false,
  ) {
    const paths = yield* pathsFor(orgId);
    if (reusePin && initializedCheckouts.has(orgId) && pinnedHeads.has(orgId)) {
      yield* validateWriter(orgId, paths, false);
      return { writer: paths.writer, read: paths.read };
    }
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    yield* removeStaleClones(orgId, paths.root);
    if (yield* io(orgId, "exists", fs.exists(paths.writer))) {
      yield* validateWriter(orgId, paths, false);
    } else {
      // The remote can still hold the old history until the purge's push lands.
      yield* refuseDuringPurge(orgId, "clone");
      yield* io(
        orgId,
        "clone",
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({
            directory: paths.root,
            prefix: "memory.clone-",
          });
          yield* git(orgId, paths.root, [
            "clone",
            "--branch",
            config.defaultBranch ?? "main",
            "--",
            paths.repo.repoUrl,
            temporary,
          ]);
          const branch = config.defaultBranch ?? "main";
          const head = yield* advertisedHead(orgId, temporary, paths.repo.repoUrl, branch);
          const expected = yield* anchor(orgId, branch, head);
          if (expected !== head)
            return yield* new MemoryCheckoutInvalid({
              orgId,
              operation: "bootstrap",
              reason: "Existing anchor differs",
            });
          yield* fs.rename(temporary, paths.writer);
        }).pipe(Effect.scoped),
      );
    }
    initializedCheckouts.add(orgId);
    return { writer: paths.writer, read: paths.read };
  });

  const loadSnapshot = Effect.fn("Memory.loadSnapshot")(function* (
    orgId: KinOrgId,
    force: boolean,
    branch: string = mainBranch,
  ) {
    const paths = yield* pathsFor(orgId);
    const key = snapshotKey(orgId, branch);
    let head: string;
    if (branch === mainBranch) {
      const pinned = pinnedHeads.get(orgId);
      if (pinned === undefined) yield* validateWriter(orgId, paths, false);
      head = pinned ?? (yield* anchor(orgId, mainBranch));
      pinnedHeads.set(orgId, head);
    } else head = yield* anchor(orgId, branch);
    const previous = snapshots.get(key);
    if (!force && previous?.head === head) return previous;
    const blobCache = blobCaches.get(key) ?? {
      blobs: new Map<string, string | undefined>(),
      parsedBlobs: new Map<string, ParsedBlob | undefined>(),
      mismatchWarnings: new Set<string>(),
    };
    blobCaches.set(key, blobCache);
    const { blobs, parsedBlobs, mismatchWarnings } = blobCache;
    const verifiedEntries = yield* readTree(orgId, paths.writer, head).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
    const sizes = new Map<string, number>();
    const blobsToSize = verifiedEntries.filter((entry) =>
      ["100644", "100755"].includes(entry.mode),
    );
    if (blobsToSize.length) {
      const headers = yield* git(
        orgId,
        paths.writer,
        ["cat-file", "--batch-check"],
        blobsToSize.map((entry) => entry.sha).join("\n") + "\n",
      );
      for (const line of headers.trim().split("\n")) {
        const [sha, type, size] = line.split(" ");
        if (sha && type === "blob" && size) sizes.set(sha, Number(size));
      }
    }
    const entries = verifiedEntries
      .filter(
        ({ relative, mode }) =>
          ["100644", "100755"].includes(mode) &&
          relative.endsWith(".md") &&
          (itemFolders.some((folder) => relative.startsWith(`${folder}/`)) ||
            ["rules.md", "INDEX.md"].includes(relative)),
      )
      .map((entry) => ({ ...entry, size: sizes.get(entry.sha) ?? Infinity }));
    const pending = [
      ...new Map(
        entries
          .filter((entry) => !blobs.has(entry.sha) && entry.size <= maxBlobBytes)
          .map((entry) => [entry.sha, entry]),
      ).values(),
    ];
    const decodeBlob = Effect.fn("Memory.decodeBlob")(function* (
      entry: (typeof entries)[number],
      bytes: Uint8Array,
    ) {
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) =>
          new MemoryItemError({
            orgId,
            path: entry.relative,
            reason: "Blob is not valid UTF-8",
            cause,
          }),
      }).pipe(
        Effect.catchTags({
          MemoryItemError: (error) =>
            Effect.logWarning("Skipping malformed memory item", {
              orgId,
              path: entry.relative,
              errorTag: error._tag,
              reason: error.reason,
            }).pipe(Effect.as(undefined)),
        }),
      );
      blobs.set(entry.sha, text);
    });
    for (let index = 0; index < pending.length; index += 32) {
      const batch = pending.slice(index, index + 32);
      const objects = yield* readObjects(
        orgId,
        paths.writer,
        batch.map(({ sha }) => ({ sha, type: "blob" })),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(VcsProcess, vcs),
      );
      for (const [index, entry] of batch.entries()) {
        const bytes = objects[index];
        if (bytes && bytes.length <= maxBlobBytes) yield* decodeBlob(entry, bytes);
        else blobs.set(entry.sha, undefined);
      }
    }
    const items: Array<MemoryCache.MemoryItem> = [];
    const files = new Map<string, string>();
    // Entry work shares the load span; a span per blob would overwhelm traces.
    const visit = Effect.fnUntraced(function* ({ sha, relative, size }: (typeof entries)[number]) {
      if (size > maxBlobBytes && !blobs.has(sha)) {
        blobs.set(sha, undefined);
        return yield* new MemoryBlobTooLarge({ orgId, path: relative, size });
      }
      if (!blobs.has(sha))
        return yield* new MemoryError({ orgId, operation: "blob", reason: "Unreadable git blob" });
      const text = blobs.get(sha);
      if (text === undefined) return;
      files.set(relative, text);
      if (!itemFolders.some((folder) => relative.startsWith(`${folder}/`))) return;
      if (!parsedBlobs.has(sha)) {
        const parsed = yield* parseFrontMatter(orgId, relative, text).pipe(
          Effect.catchTags({
            MemoryItemError: (error) =>
              Effect.logWarning("Skipping malformed memory item", {
                orgId,
                path: relative,
                errorTag: error._tag,
                reason: error.reason,
              }).pipe(Effect.as(undefined)),
          }),
        );
        parsedBlobs.set(sha, parsed);
      }
      const parsed = parsedBlobs.get(sha);
      if (!parsed) return;
      const expectedFolder =
        parsed.frontMatter.kind === "person" ? "people" : `${parsed.frontMatter.kind}s`;
      if (!relative.startsWith(`${expectedFolder}/`)) {
        if (!mismatchWarnings.has(sha)) {
          mismatchWarnings.add(sha);
          return yield* new MemoryItemError({
            orgId,
            path: relative,
            reason: "Memory kind does not match folder",
          });
        }
        return;
      }
      const itemHead = yield* decodeHead({ ...parsed.frontMatter, orgId, path: relative });
      items.push({ head: itemHead, body: parsed.body });
    });
    for (const entry of entries) {
      yield* visit(entry).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Skipping invalid memory entry", {
            orgId,
            path: entry.relative,
            size: entry.size,
            errorTag: error._tag,
          }),
        ),
      );
    }
    const counts = new Map<string, number>();
    for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
    const duplicateIds = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
    for (const id of duplicateIds) {
      if (!duplicateWarnings.get(key)?.has(id))
        yield* Effect.logWarning("Duplicate memory id", { orgId, branch, id });
    }
    duplicateWarnings.set(key, duplicateIds);
    const snapshot: Snapshot = {
      head,
      branch,
      items,
      files,
      blobIds: new Map(entries.map((entry) => [entry.relative, entry.sha])),
      duplicateIds,
      ...(previous?.head === head && previous.index !== undefined ? { index: previous.index } : {}),
    };
    snapshots.set(key, snapshot);
    const reachable = new Set(entries.map((entry) => entry.sha));
    for (const cache of [blobs, parsedBlobs, mismatchWarnings]) {
      for (const sha of cache.keys()) if (!reachable.has(sha)) cache.delete(sha);
    }
    return snapshot;
  });

  const sqlRead = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError(toPersistenceSqlError("Memory.view")),
      Effect.mapError((cause) => new MemoryError({ orgId, operation: "view", cause })),
    );
  /** The branch `agentId` reads: its shadow branch at L0 once it has one, else the default branch. */
  const leadBranch = Effect.fn("Memory.leadBranch")(function* (
    orgId: KinOrgId,
    agentId: KinAgentId,
  ) {
    const shadow = shadowBranch(agentId);
    const [row] = yield* sqlRead(
      orgId,
      sql<{ level: string; head: string | null }>`SELECT l.level, h.head FROM kin_leads l
        LEFT JOIN kin_memory_heads h ON h.org_id = l.org_id AND h.branch = ${shadow}
        WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId} ORDER BY l.agent_id`,
    );
    return row?.level === "L0" && row.head !== null ? shadow : mainBranch;
  });
  /**
   * The default branch with every active lead's own shadow changes on top, so a deferral made at
   * L0 arms and stays armed after a raise until Keep or Start clean resets the shadow branch. A
   * path is the shadow's own when its blob differs from the merge base; the first lead by id wins
   * when two shadows changed the same path.
   */
  const triggerSnapshot = Effect.fn("Memory.triggerSnapshot")(function* (
    orgId: KinOrgId,
    main: Snapshot,
  ) {
    const shadows = yield* sqlRead(
      orgId,
      sql<{ branch: string; head: string }>`SELECT h.branch, h.head FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
        JOIN kin_memory_heads h ON h.org_id = l.org_id AND h.branch = 'kin/shadow/' || l.agent_id
        WHERE l.org_id = ${orgId} AND h.head <> ${main.head}
        ORDER BY l.agent_id`,
    );
    if (shadows.length === 0) return main;
    const key = [main.head, ...shadows.map(({ branch, head }) => `${branch}=${head}`)].join(" ");
    const cached = triggerViews.get(orgId);
    if (cached?.key === key) return cached.snapshot;
    const { writer } = yield* pathsFor(orgId);
    const byPath = new Map(main.items.map((item) => [item.head.path, item]));
    const claimed = new Set<string>();
    for (const { branch, head } of shadows) {
      const base = (yield* git(orgId, writer, ["merge-base", main.head, head]).pipe(
        Effect.orElseSucceed(() => ""),
      )).trim();
      // A settled shadow branch that the default branch has since moved past adds nothing.
      if (base === head) continue;
      const shadow = yield* loadSnapshot(orgId, false, branch);
      const inherited = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)
        ? new Map(
            (yield* readTree(orgId, writer, base).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(VcsProcess, vcs),
            )).map((entry) => [entry.relative, entry.sha]),
          )
        : new Map<string, string>();
      for (const item of shadow.items) {
        const path = item.head.path;
        if (claimed.has(path) || shadow.blobIds.get(path) === inherited.get(path)) continue;
        claimed.add(path);
        byPath.set(path, item);
      }
    }
    const items = [...byPath.values()];
    const counts = new Map<string, number>();
    for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
    const snapshot: Snapshot = {
      head: key,
      branch: "triggers",
      items,
      files: main.files,
      blobIds: new Map(),
      duplicateIds: new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id)),
    };
    triggerViews.set(orgId, { key, snapshot });
    return snapshot;
  });
  const load = Effect.fn("Memory.load")(function* (
    orgId: KinOrgId,
    force = false,
    view?: MemoryView,
  ) {
    const main = yield* loadSnapshot(orgId, force);
    // A shadow branch that can't be read must not take default-branch reads down with it.
    const triggers = yield* triggerSnapshot(orgId, main).pipe(Effect.result);
    if (triggers._tag === "Success") yield* hooks.syncItems(orgId, triggers.success);
    else
      yield* Effect.logWarning("Could not read shadow memory for deferral triggers", {
        orgId,
        errorTag: triggers.failure._tag,
      });
    if (view === undefined) return main;
    if (view === "triggers") return yield* Effect.fromResult(triggers);
    const branch = yield* leadBranch(orgId, view.lead);
    return branch === mainBranch ? main : yield* loadSnapshot(orgId, false, branch);
  });

  const query = Effect.fn("Memory.query")(function* (
    orgId: KinOrgId,
    q: MemoryQuery,
    view?: MemoryView,
  ) {
    for (const value of [q.dueBefore, q.dueAfter]) {
      if (value !== undefined && !Number.isFinite(dateMillis(value)))
        return yield* new MemoryQueryDecodeError({
          orgId,
          operation: "query",
          reason: "Invalid date bound",
        });
    }
    if (q.limit !== undefined && (!Number.isFinite(q.limit) || q.limit < 0))
      return yield* new MemoryQueryDecodeError({
        orgId,
        operation: "query",
        reason: "Limit must be finite and non-negative",
      });
    const now = yield* Clock.currentTimeMillis;
    const { items } = yield* load(orgId, false, view);
    const counts = new Map<string, number>();
    for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
    return items
      .map((item) => ({ ...item.head, duplicate: (counts.get(item.head.id) ?? 0) > 1 }))
      .filter(
        (item) =>
          (q.kind === undefined || item.kind === q.kind) &&
          (q.status === undefined || item.status === q.status) &&
          (!q.excludeInvalid || item.invalid_at === null) &&
          (q.dueBefore === undefined || dateMillis(item.due) <= dateMillis(q.dueBefore)) &&
          (q.dueAfter === undefined || dateMillis(item.due) >= dateMillis(q.dueAfter)) &&
          (q.reviewOverdue === undefined || dateMillis(item.review_by) < now === q.reviewOverdue) &&
          (q.saidBy === undefined || item.said_by === q.saidBy) &&
          (q.linksTo === undefined || item.links.includes(q.linksTo)),
      )
      .slice(0, q.limit === undefined ? undefined : Math.max(0, Math.floor(q.limit)));
  });

  const readItem = Effect.fn("Memory.readItem")(function* (
    orgId: KinOrgId,
    id: KinMemoryItemId,
    recordRead: boolean,
    view?: MemoryView,
  ) {
    const { items } = yield* load(orgId, false, view);
    const matches = items.filter((item) => item.head.id === id);
    const item = matches[0];
    if (!item) return yield* new MemoryNotFound({ orgId, id });
    if (matches.length > 1) return yield* new MemoryDuplicateId({ orgId, id });
    if (recordRead)
      yield* cache.read(orgId, id).pipe(
        Effect.catchTags({
          MemoryHistoryError: () =>
            Effect.logWarning("Could not record memory read", { orgId, id }),
        }),
      );
    return item;
  });

  const rebuildIndex = Effect.fn("Memory.rebuildIndex")(function* (
    orgId: KinOrgId,
    view?: LeadView,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* load(orgId, false, view);
    const reads = yield* cache.lastReads(orgId).pipe(
      Effect.catchTags({
        MemoryHistoryError: () =>
          Effect.logWarning("Could not load memory read history", { orgId }).pipe(
            Effect.as(Object.fromEntries<number>([])),
          ),
      }),
    );
    const ownerTimeZone = yield* cache.ownerTimeZone(orgId);
    snapshot.index = buildIndex(
      snapshot.items.map(({ head }) => head),
      reads,
      now,
      ownerTimeZone,
    );
    if ((checkoutBranches.get(orgId) ?? mainBranch) !== snapshot.branch) return;
    const paths = yield* pathsFor(orgId);
    yield* io(
      orgId,
      "writeIndex",
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempFileScoped({
          directory: paths.read,
          prefix: ".kin-index-",
        });
        yield* fs.writeFileString(temporary, snapshot.index ?? "");
        yield* fs.rename(temporary, path.join(paths.read, "INDEX.md"));
      }).pipe(Effect.scoped),
    ).pipe(
      Effect.catchTags({
        MemoryError: (error) =>
          Effect.logWarning("Could not write memory index", {
            orgId,
            operation: error.operation,
            errorTag: error._tag,
          }),
      }),
    );
  });

  const readFile = Effect.fn("Memory.readFile")(function* (
    orgId: KinOrgId,
    name: string,
    view?: LeadView,
  ) {
    const snapshot = yield* load(orgId, false, view);
    const text =
      name === "INDEX.md" ? (snapshot.index ?? snapshot.files.get(name)) : snapshot.files.get(name);
    if (text === undefined)
      return yield* new MemoryError({
        orgId,
        operation: "read",
        reason: "Missing committed memory file",
      });
    return text;
  });

  let conflictSequence = 0;
  const preserve = Effect.fn("Memory.preserve")(function* (
    orgId: KinOrgId,
    writer: string,
    url: string,
    head: string,
    wakeupId?: string,
  ) {
    yield* refuseDuringPurge(orgId, "preserve");
    const now = yield* Clock.currentTimeMillis;
    const id = wakeupId ?? `recovery-${now}-${head.slice(0, 12)}`;
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !/^[a-zA-Z0-9_-]+$/.test(orgId))
      return yield* new MemoryCheckoutInvalid({
        orgId,
        operation: "preserve",
        reason: "Invalid wake-up id",
      });
    const existing = (yield* git(orgId, writer, [
      "ls-remote",
      "--",
      url,
      `refs/heads/kin/conflict/${orgId}/*`,
    ]))
      .split("\n")
      .flatMap((line) => {
        const [sha, ref] = line.split("\t");
        return sha === head && ref?.startsWith("refs/heads/")
          ? [ref.slice("refs/heads/".length)]
          : [];
      })
      .toSorted()[0];
    if (existing) return existing;
    const branch = `kin/conflict/${orgId}/${id}-${now.toString(36)}-${++conflictSequence}`;
    if ((yield* git(orgId, writer, ["ls-remote", "--", url, `refs/heads/${branch}`])).trim())
      return yield* new MemorySyncConflict({
        orgId,
        operation: "preserve",
        reason: "Conflict branch already exists",
      });
    yield* readFiles(orgId, writer, head).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
    yield* git(orgId, writer, ["push", "--", url, `${head}:refs/heads/${branch}`]);
    return branch;
  });

  const recover = Effect.fn("Memory.recover")(function* (orgId: KinOrgId, reclone = false) {
    const paths = yield* pathsFor(orgId);
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    const exists = yield* io(orgId, "exists", fs.exists(paths.writer));
    if (!exists && !reclone) yield* refuseDuringPurge(orgId, "clone");
    if (!exists)
      yield* git(orgId, paths.root, [
        "clone",
        "--no-checkout",
        "--",
        paths.repo.repoUrl,
        paths.writer,
      ]);
    for (const name of [".git", ".git/objects", ".git/refs"]) {
      const stat = yield* io(orgId, "recoverStructure", fs.lstat(`${paths.writer}/${name}`));
      if (stat.type !== "Directory")
        return yield* new MemoryCheckoutInvalid({
          orgId,
          operation: "recover",
          reason: "Invalid writer directory",
        });
    }
    const refs = (yield* git(orgId, paths.writer, [
      "ls-remote",
      "--",
      paths.repo.repoUrl,
      "refs/heads/*",
    ]))
      .trim()
      .split("\n")
      .filter(Boolean);
    const targets = new Map<string, string>();
    for (const ref of refs) {
      const [head, name] = ref.split(/\s+/);
      const branch = name?.replace(/^refs\/heads\//, "");
      if (
        branch &&
        head &&
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) &&
        (branch === (config.defaultBranch ?? "main") || branch.startsWith("kin/shadow/"))
      ) {
        yield* git(orgId, paths.writer, ["fetch", "--", paths.repo.repoUrl, head]);
        targets.set(branch, head);
      }
    }
    const main = targets.get(config.defaultBranch ?? "main");
    if (!main)
      return yield* new MemoryCheckoutInvalid({
        orgId,
        operation: "recover",
        reason: "Missing remote main branch",
      });
    const rows = yield* persistence(
      orgId,
      sql<{
        branch: string;
        head: string;
      }>`SELECT branch, head FROM kin_memory_heads WHERE org_id = ${orgId} ORDER BY branch`,
    );
    // An anchored shadow head the remote lacks may be the lead's only copy: keep it and push it.
    const unpushed = new Set<string>();
    for (const row of rows) {
      if (!row.branch.startsWith("kin/shadow/")) continue;
      const remote = targets.get(row.branch);
      if (remote === row.head) continue;
      const present =
        exists &&
        (yield* readFiles(orgId, paths.writer, row.head).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(VcsProcess, vcs),
          Effect.result,
        ))._tag === "Success";
      if (
        present &&
        (remote === undefined || (yield* walkAncestors(orgId, paths.writer, row.head)).has(remote))
      ) {
        targets.set(row.branch, row.head);
        unpushed.add(row.branch);
      } else if (remote === undefined) {
        targets.set(row.branch, main);
        if (!present)
          yield* notify({
            orgId,
            branch: row.branch,
            reason: `Shadow memory at ${row.head} never reached the remote and is gone from this server; the lead's shadow memory restarts from the default branch`,
          });
      }
    }
    // Local enumeration is deletion-only; it can never introduce a recovery target.
    const localShadows = (yield* git(orgId, paths.writer, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/kin/shadow/",
    ]))
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const ref of localShadows) {
      const [name, sha] = ref.split(" ");
      if (name && sha && !targets.has(name.slice("refs/heads/".length))) {
        yield* git(orgId, paths.writer, ["update-ref", "-d", name, sha]);
        yield* notify({
          orgId,
          branch: name,
          reason: `Deleted untrusted local shadow branch at ${sha}: no anchor or remote branch vouches for it`,
        });
      }
    }
    const preserved = new Set<string>();
    for (const [branch, head] of targets) {
      yield* readFiles(orgId, paths.writer, head).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(VcsProcess, vcs),
      );
      const old = yield* anchor(orgId, branch, head);
      if (old !== head && exists) {
        const local = yield* readCommit(orgId, paths.writer, old).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(VcsProcess, vcs),
          Effect.result,
        );
        const present = yield* walkAncestors(orgId, paths.writer, head);
        if (local._tag === "Success" && !present.has(old) && !preserved.has(old)) {
          const conflictBranch = yield* preserve(orgId, paths.writer, paths.repo.repoUrl, old);
          preserved.add(old);
          yield* notify({
            orgId,
            branch,
            reason: "Preserved old anchor before recovery",
            conflictBranch,
          });
        }
      }
      const local = yield* git(orgId, paths.writer, [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}`,
      ]).pipe(Effect.result);
      yield* git(orgId, paths.writer, [
        "update-ref",
        `refs/heads/${branch}`,
        head,
        local._tag === "Success" ? local.success.trim() : "0".repeat(head.length),
      ]);
      if (old !== head) yield* record(orgId, branch, old, head);
      if (!unpushed.has(branch)) {
        yield* notify({ orgId, branch, reason: "Recovered from remote head" });
        continue;
      }
      // The remote can still hold old history until a purge's push lands; the marker blocks pushes.
      const pushed =
        (yield* purgeInFlight(orgId)) === undefined &&
        (yield* git(orgId, paths.writer, [
          "push",
          "--",
          paths.repo.repoUrl,
          `${head}:refs/heads/${branch}`,
        ]).pipe(Effect.result))._tag === "Success";
      yield* notify({
        orgId,
        branch,
        reason: pushed
          ? "Kept the anchored shadow branch and pushed it to the remote"
          : "Kept the anchored shadow branch, but it is only on this server: the push was refused",
      });
    }
    pinnedHeads.delete(orgId);
    forgetSnapshots(orgId);
  });

  const prepare = Effect.fn("Memory.prepare")(function* (
    orgId: KinOrgId,
    wakeupId?: string,
    view?: LeadView,
  ) {
    const paths = yield* ensureCheckouts(orgId);
    yield* validateWriter(orgId, yield* pathsFor(orgId));
    yield* git(orgId, paths.writer, [
      "fsck",
      "--full",
      "--strict",
      "--no-reflogs",
      yield* anchor(orgId, config.defaultBranch ?? "main"),
    ]);
    for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      if (yield* io(orgId, "sync", fs.exists(`${paths.writer}/.git/${marker}`)))
        return yield* new MemoryCheckoutInvalid({
          orgId,
          operation: "sync",
          reason: "Unfinished Git operation",
        });
    }
    const { repo } = yield* pathsFor(orgId);
    const branch = config.defaultBranch ?? "main";
    let head = yield* anchor(orgId, branch);
    const fetched = yield* advertisedHead(orgId, paths.writer, repo.repoUrl, branch).pipe(
      Effect.result,
    );
    if (fetched._tag === "Failure" && fetched.failure._tag === "MemoryCheckoutInvalid")
      return yield* fetched.failure;
    if (fetched._tag === "Success") {
      const remote = fetched.success.trim();
      if (remote !== head) {
        const remoteAncestors = yield* walkAncestors(orgId, paths.writer, remote, head);
        let next = remote;
        if (!remoteAncestors.has(head)) {
          const localAncestors = yield* walkAncestors(orgId, paths.writer, head);
          if (localAncestors.has(remote)) next = head;
          else {
            const mergeBase = uniqueMergeBase(localAncestors, remoteAncestors);
            if (!mergeBase) {
              const conflictBranch = yield* preserve(
                orgId,
                paths.writer,
                repo.repoUrl,
                head,
                wakeupId,
              );
              yield* notify({
                orgId,
                branch,
                reason: "No unique verified merge base",
                conflictBranch,
              });
              return yield* new MemorySyncConflict({
                orgId,
                operation: "merge",
                reason: "No unique verified merge base",
              });
            }
            const commit = head;
            const parent = mergeBase;
            let tree: string | undefined;
            {
              const read = (sha: string) =>
                readFiles(orgId, paths.writer, sha).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(VcsProcess, vcs),
                );
              const base = yield* read(parent);
              const local = yield* read(commit);
              const remoteFiles = yield* read(next);
              const metadata = new Map<string, Map<string, { mode: string; sha: string }>>();
              for (const sha of [parent, commit, next]) {
                const entries = yield* readTree(orgId, paths.writer, sha).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(VcsProcess, vcs),
                );
                metadata.set(sha, new Map(entries.map((entry) => [entry.relative, entry])));
              }
              const merged = mergeMemoryFiles(
                base,
                local,
                remoteFiles,
                metadata.get(parent)!,
                metadata.get(commit)!,
                metadata.get(next)!,
              );
              if (!merged) {
                const conflictBranch = yield* preserve(
                  orgId,
                  paths.writer,
                  repo.repoUrl,
                  head,
                  wakeupId,
                );
                next = remote;
                yield* notify({
                  orgId,
                  branch,
                  reason: "Content conflict preserved",
                  conflictBranch,
                });
              } else {
                const { files: mergedFiles, modes } = merged;
                const remoteOriginal = new Map(remoteFiles);
                remoteFiles.clear();
                for (const [file, bytes] of mergedFiles) remoteFiles.set(file, bytes);
                const heads = [];
                for (const [file, bytes] of remoteFiles) {
                  if (!["100644", "100755"].includes(modes.get(file) ?? "")) continue;
                  if (!itemFolders.some((folder) => file.startsWith(`${folder}/`))) continue;
                  const parsed = yield* parseFrontMatter(orgId, file, bytes.toString("utf8")).pipe(
                    Effect.result,
                  );
                  if (parsed._tag === "Success")
                    heads.push({ ...parsed.success.frontMatter, orgId, path: file });
                }
                const reads = yield* io(orgId, "mergeIndex", cache.lastReads(orgId));
                const zone = yield* io(orgId, "mergeIndex", cache.ownerTimeZone(orgId));
                modes.set("INDEX.md", "100644");
                remoteFiles.set(
                  "INDEX.md",
                  Buffer.from(buildIndex(heads, reads, yield* Clock.currentTimeMillis, zone)),
                );
                const findings = yield* scanner
                  .scan({
                    orgId,
                    files: [...remoteFiles]
                      .filter(
                        ([path, bytes]) =>
                          path === "INDEX.md" || !remoteOriginal.get(path)?.equals(bytes),
                      )
                      .map(([path, content]) => ({ path, content })),
                  })
                  .pipe(
                    Effect.tapError((cause) =>
                      notify({ orgId, branch, reason: `Secret scan failed: ${cause.reason}` }),
                    ),
                    Effect.mapError(
                      (cause) => new MemoryError({ orgId, operation: "secretScan", cause }),
                    ),
                  );
                if (findings.length) {
                  yield* notify({
                    orgId,
                    branch,
                    reason: `Secret scan blocked merge: ${findings[0]!.ruleId} in ${findings[0]!.pathHit ? "[redacted]" : (findings[0]!.itemPath ?? findings[0]!.path)}`,
                  });
                  return yield* new MemoryError({
                    orgId,
                    operation: "secretScan",
                    reason: `Secret scan blocked merge: ${findings[0]!.ruleId} in ${findings[0]!.pathHit ? "[redacted]" : (findings[0]!.itemPath ?? findings[0]!.path)}`,
                  });
                }
                tree = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const temp = yield* io(orgId, "journalMerge", fs.makeTempDirectoryScoped());
                    const env = { GIT_INDEX_FILE: `${temp}/index` };
                    yield* memoryGit(paths.writer, ["read-tree", "--empty"], undefined, env).pipe(
                      Effect.mapError(
                        (cause) => new MemoryError({ orgId, operation: "merge", cause }),
                      ),
                    );
                    const expected = new Map<string, { mode: string; sha: string }>();
                    for (const [file, bytes] of remoteFiles) {
                      yield* io(orgId, "mergeBlob", fs.writeFile(`${temp}/blob`, bytes));
                      const mode = modes.get(file) ?? "100644";
                      const blob =
                        mode === "160000"
                          ? bytes.toString("ascii")
                          : (yield* git(orgId, paths.writer, [
                              "hash-object",
                              "-w",
                              "--no-filters",
                              `${temp}/blob`,
                            ])).trim();
                      expected.set(file, {
                        mode,
                        sha:
                          mode === "160000"
                            ? bytes.toString("ascii")
                            : objectHash(bytes, head.length),
                      });
                      yield* memoryGit(
                        paths.writer,
                        ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`],
                        undefined,
                        env,
                      ).pipe(
                        Effect.mapError(
                          (cause) => new MemoryError({ orgId, operation: "merge", cause }),
                        ),
                      );
                    }
                    const written = (yield* memoryGit(
                      paths.writer,
                      ["write-tree"],
                      undefined,
                      env,
                    ).pipe(
                      Effect.mapError(
                        (cause) => new MemoryError({ orgId, operation: "merge", cause }),
                      ),
                    )).trim();
                    yield* verifyTree(orgId, paths.writer, written, expected).pipe(
                      Effect.provideService(FileSystem.FileSystem, fs),
                      Effect.provideService(VcsProcess, vcs),
                    );
                    return written;
                  }),
                );
              }
            }
            if (next !== remote || tree) {
              if (!tree || !/^[0-9a-f]{40,64}$/.test(tree))
                return yield* new MemorySyncConflict({
                  orgId,
                  operation: "sync",
                  reason: "Invalid merge tree",
                });
              const { message } = yield* readCommit(orgId, paths.writer, commit).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(VcsProcess, vcs),
              );
              next = (yield* memoryGit(
                paths.writer,
                ["commit-tree", tree, "-p", remote, "-p", head],
                message,
                {
                  GIT_AUTHOR_NAME: config.botName ?? "Kin Memory Bot",
                  GIT_AUTHOR_EMAIL: config.botEmail ?? "kin-memory@localhost",
                  GIT_COMMITTER_NAME: config.botName ?? "Kin Memory Bot",
                  GIT_COMMITTER_EMAIL: config.botEmail ?? "kin-memory@localhost",
                },
              ).pipe(
                Effect.mapError((cause) => new MemoryError({ orgId, operation: "rebase", cause })),
              )).trim();
            }
          }
        }
        if (next !== head) {
          if (next !== remote) {
            yield* refuseDuringPurge(orgId, "merge");
            yield* git(orgId, paths.writer, [
              "push",
              "--",
              repo.repoUrl,
              `${next}:refs/heads/${branch}`,
            ]);
          }
          yield* git(orgId, paths.writer, ["update-ref", `refs/heads/${branch}`, next, head]);
          yield* record(orgId, branch, head, next);
          head = next;
        }
      }
    }
    // The read checkout holds the waking lead's view: its shadow branch at L0.
    const checkoutBranch = view === undefined ? branch : yield* leadBranch(orgId, view.lead);
    const checkoutHead = checkoutBranch === branch ? head : yield* anchor(orgId, checkoutBranch);
    // The lead runs full-access here, so the checkout holds only memory files, never provider config.
    const entries = yield* readTree(orgId, paths.writer, checkoutHead).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(VcsProcess, vcs),
    );
    const kept = entries.filter(
      ({ relative, mode }) => ["100644", "100755"].includes(mode) && isCheckoutPath(relative),
    );
    if (kept.length < entries.length && skipWarnedHeads.get(orgId) !== checkoutHead) {
      const keptSet = new Set(kept);
      yield* Effect.logWarning("Kin memory checkout skipped paths", {
        orgId,
        paths: entries.filter((entry) => !keptSet.has(entry)).map(({ relative }) => relative),
      });
    }
    skipWarnedHeads.set(orgId, checkoutHead);
    const sizes = new Map<string, number>();
    if (kept.length)
      for (const line of (yield* git(
        orgId,
        paths.writer,
        ["cat-file", "--batch-check"],
        kept.map(({ sha }) => sha).join("\n") + "\n",
      ))
        .trim()
        .split("\n")) {
        const [sha, , size] = line.split(" ");
        if (sha && size) sizes.set(sha, Number(size));
      }
    const batches: Array<typeof kept> = [];
    let batchBytes = Infinity;
    for (const entry of kept) {
      const bytes = sizes.get(entry.sha) ?? 0;
      if (batchBytes + bytes > checkoutBatchBytes || batches.at(-1)!.length >= 4096) {
        batches.push([]);
        batchBytes = 0;
      }
      batches.at(-1)!.push(entry);
      batchBytes += bytes;
    }
    const blobs: Array<Buffer> = [];
    for (const batch of batches)
      blobs.push(
        ...(yield* readObjects(
          orgId,
          paths.writer,
          batch.map(({ sha }) => ({ sha, type: "blob" as const })),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(VcsProcess, vcs),
        )),
      );
    yield* io(
      orgId,
      "readSnapshot",
      Effect.scoped(
        Effect.gen(function* () {
          // Staged beside the target: the system temp dir can be another filesystem (EXDEV).
          const read = path.join(
            yield* fs.makeTempDirectoryScoped({
              directory: path.dirname(paths.read),
              prefix: "memory-read.next-",
            }),
            "read",
          );
          yield* fs.makeDirectory(read);
          for (const [index, { relative }] of kept.entries()) {
            const target = path.join(read, relative);
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* fs.writeFile(target, blobs[index]!);
          }
          // An empty repo keeps stray `git` and turn checkpoints out of any enclosing repo.
          yield* vcs.run({
            operation: "Memory.readCheckoutRepo",
            command: "git",
            cwd: read,
            args: ["init", "--quiet", "--", read],
            env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TEMPLATE_DIR: "" },
          });
          yield* fs.remove(paths.read, { recursive: true, force: true });
          yield* fs.rename(read, paths.read);
        }),
      ),
    );
    pinnedHeads.set(orgId, head);
    checkoutBranches.set(orgId, checkoutBranch);
    const index = yield* readFile(orgId, "INDEX.md", view).pipe(
      Effect.catchTags({ MemoryError: () => Effect.succeed("") }),
    );
    if (indexIsStale(index, yield* Clock.currentTimeMillis)) yield* rebuildIndex(orgId, view);
    const rebuilt = yield* readFile(orgId, "INDEX.md", view);
    const indexAsOf = yield* Effect.fromOption(
      DateTime.make(/^As of ([^\r\n]+)(?:\r?\n|$)/.exec(rebuilt)?.[1] ?? ""),
    ).pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "indexDate", cause })));
    return { head: checkoutHead, indexAsOf: DateTime.toUtc(indexAsOf) };
  });

  const dropCheckouts = Effect.fn("Memory.dropCheckouts")(function* (orgId: KinOrgId) {
    const paths = yield* pathsFor(orgId);
    historyGenerations.set(orgId, (historyGenerations.get(orgId) ?? 0) + 1);
    // `dreams/` holds plain copies of memory files for a running dream.
    for (const directory of [paths.writer, paths.read, path.join(paths.root, "dreams")])
      yield* io(orgId, "quarantine", fs.remove(directory, { recursive: true, force: true }));
    if (yield* io(orgId, "exists", fs.exists(paths.root)))
      yield* removeStaleClones(orgId, paths.root);
    initializedCheckouts.delete(orgId);
    pinnedHeads.delete(orgId);
    skipWarnedHeads.delete(orgId);
    checkoutBranches.delete(orgId);
    forgetSnapshots(orgId);
    return paths;
  });
  const historyRewrite = (orgId: KinOrgId): MemoryHistoryRewrite => ({
    quarantine: Effect.fn("Memory.quarantine")((marker: string) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { root } = yield* pathsFor(orgId);
          yield* io(orgId, "mkdir", fs.makeDirectory(root, { recursive: true }));
          yield* io(orgId, "purgeMarker", fs.writeFileString(`${markerPath(root)}.tmp`, marker));
          yield* io(orgId, "purgeMarker", fs.rename(`${markerPath(root)}.tmp`, markerPath(root)));
          yield* dropCheckouts(orgId);
        }),
      ),
    ),
    reclone: Effect.fn("Memory.reclone")(() =>
      locked(
        orgId,
        Effect.gen(function* () {
          const { root } = yield* dropCheckouts(orgId);
          // With no writer checkout, recover clones fresh and records the rewritten heads.
          yield* recover(orgId, true);
          yield* prepare(orgId);
          yield* rebuildIndex(orgId);
          yield* io(orgId, "purgeMarker", fs.remove(markerPath(root), { force: true }));
        }),
      ),
    ),
  });

  const withHistoryRewrite = <A, E>(
    orgId: KinOrgId,
    body: (rewrite: MemoryHistoryRewrite) => Effect.Effect<A, E>,
  ) => withWriterLock(orgId, body(historyRewrite(orgId)));

  return Memory.of({
    withWriterLock,
    withHistoryRewrite,
    purgeInFlight: Effect.fn("Memory.purgeInFlightLocked")((orgId) =>
      locked(orgId, purgeInFlight(orgId)),
    ),
    historyGeneration: Effect.fn("Memory.historyGeneration")((orgId) =>
      Effect.sync(() => historyGenerations.get(orgId) ?? 0),
    ),
    recover: Effect.fn("Memory.recoverLocked")((orgId) =>
      withWriterLock(orgId, locked(orgId, recover(orgId))),
    ),
    anchor,
    record,
    ensureCheckouts: Effect.fn("Memory.ensureCheckoutsLocked")((orgId) =>
      locked(orgId, ensureCheckouts(orgId, true)),
    ),
    prepareWakeup: Effect.fn("Memory.prepareWakeup")((orgId, wakeupId, view) =>
      withWriterLock(orgId, locked(orgId, prepare(orgId, wakeupId, view))),
    ),
    readPromptSnapshot: Effect.fn("Memory.readPromptSnapshot")((orgId, expectedHead, view) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const snapshot = yield* load(orgId, false, view);
          if (snapshot.head !== expectedHead)
            return yield* new MemoryError({
              orgId,
              operation: "promptSnapshot",
              reason: "Memory head does not match wake-up",
            });
          const rules = snapshot.files.get("rules.md");
          const index = snapshot.index ?? snapshot.files.get("INDEX.md") ?? "";
          if (rules === undefined)
            return yield* new MemoryError({
              orgId,
              operation: "promptSnapshot",
              reason: "Missing committed prompt rules",
            });
          return { rules, index };
        }),
      ),
    ),
    readIndex: Effect.fn("Memory.readIndex")((orgId) => locked(orgId, readFile(orgId, "INDEX.md"))),
    readRules: Effect.fn("Memory.readRules")((orgId) => locked(orgId, readFile(orgId, "rules.md"))),
    query: Effect.fn("Memory.queryLocked")((orgId, q, view) =>
      locked(orgId, query(orgId, q, view)),
    ),
    readItem: Effect.fn("Memory.readItemLocked")((orgId, id, view) =>
      locked(orgId, readItem(orgId, id, true, view)),
    ),
    readItemQuietly: Effect.fn("Memory.readItemQuietly")((orgId, id, view) =>
      locked(orgId, readItem(orgId, id, false, view)),
    ),
    rebuildIndex: Effect.fn("Memory.rebuildIndexLocked")((orgId) =>
      locked(orgId, rebuildIndex(orgId)),
    ),
    rebuildCache: Effect.fn("Memory.rebuildCache")((orgId) =>
      locked(orgId, load(orgId, true).pipe(Effect.asVoid)),
    ),
  });
});

export const layer = Layer.effect(Memory, make).pipe(
  Layer.provide(MemoryCache.layer),
  Layer.provide(SecretScan.layer),
);
