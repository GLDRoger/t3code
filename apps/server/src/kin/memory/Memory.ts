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
import { memoryGit as runMemoryGit } from "./git.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import * as MemoryCache from "./MemoryCache.ts";
import { mergeMemoryFiles, uniqueMergeBase } from "./merge.ts";
import { buildIndex } from "./buildIndex.ts";
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
    readonly ensureCheckouts: (orgId: KinOrgId) => Effect.Effect<MemoryPaths, MemoryFailure>;
    readonly prepareWakeup: (
      orgId: KinOrgId,
      wakeupId?: string,
    ) => Effect.Effect<{ head: string; indexAsOf: DateTime.Utc }, MemoryFailure>;
    readonly readPromptSnapshot: (
      orgId: KinOrgId,
      expectedHead: string,
    ) => Effect.Effect<{ readonly rules: string; readonly index: string }, MemoryFailure>;
    readonly readIndex: (orgId: KinOrgId) => Effect.Effect<string, MemoryFailure>;
    readonly readRules: (orgId: KinOrgId) => Effect.Effect<string, MemoryFailure>;
    readonly readItem: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryFailure | MemoryNotFound | MemoryDuplicateId>;
    readonly readItemQuietly: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryFailure | MemoryNotFound | MemoryDuplicateId>;
    readonly query: (
      orgId: KinOrgId,
      query: MemoryQuery,
    ) => Effect.Effect<
      ReadonlyArray<MemoryItemHead & { readonly duplicate: boolean }>,
      MemoryFailure
    >;
    readonly rebuildIndex: (orgId: KinOrgId) => Effect.Effect<void, MemoryFailure>;
    readonly rebuildCache: (orgId: KinOrgId) => Effect.Effect<void, MemoryFailure>;
  }
>()("t3/kin/memory/Memory") {}

const decodeHead = Schema.decodeEffect(MemoryItemHead);
const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];

const maxBlobBytes = 256 * 1024;

interface Snapshot {
  readonly head: string;
  readonly items: ReadonlyArray<MemoryCache.MemoryItem>;
  readonly files: ReadonlyMap<string, string>;
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
  const pinnedHeads = new Map<KinOrgId, string>();
  const initializedCheckouts = new Set<KinOrgId>();
  const duplicateWarnings = new Map<KinOrgId, ReadonlySet<string>>();
  const snapshots = new Map<KinOrgId, Snapshot>();
  const blobCaches = new Map<KinOrgId, BlobCache>();

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
      Effect.mapError((cause) => new MemoryError({ orgId, operation: "git", cause })),
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
    if (reusePin && initializedCheckouts.has(orgId) && pinnedHeads.has(orgId))
      return { writer: paths.writer, read: paths.read };
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    if (yield* io(orgId, "exists", fs.exists(paths.writer))) {
      yield* validateWriter(orgId, paths, false);
    } else {
      for (const entry of yield* io(orgId, "clones", fs.readDirectory(paths.root))) {
        if (/^memory\.clone-[A-Za-z0-9]+$/.test(entry))
          yield* io(
            orgId,
            "recoverClone",
            fs.remove(path.join(paths.root, entry), { recursive: true, force: true }),
          );
      }
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

  const load = Effect.fn("Memory.load")(function* (orgId: KinOrgId, force = false) {
    const paths = yield* pathsFor(orgId);
    yield* validateWriter(orgId, paths, false);
    const head = pinnedHeads.get(orgId) ?? (yield* anchor(orgId, config.defaultBranch ?? "main"));
    pinnedHeads.set(orgId, head);
    const previous = snapshots.get(orgId);
    if (!force && previous?.head === head) return previous;
    const blobCache = blobCaches.get(orgId) ?? {
      blobs: new Map<string, string | undefined>(),
      parsedBlobs: new Map<string, ParsedBlob | undefined>(),
      mismatchWarnings: new Set<string>(),
    };
    blobCaches.set(orgId, blobCache);
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
          (folders.some((folder) => relative.startsWith(`${folder}/`)) ||
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
      if (!folders.some((folder) => relative.startsWith(`${folder}/`))) return;
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
      if (!duplicateWarnings.get(orgId)?.has(id))
        yield* Effect.logWarning("Duplicate memory id", { orgId, id });
    }
    duplicateWarnings.set(orgId, duplicateIds);
    const snapshot: Snapshot = {
      head,
      items,
      files,
      ...(previous?.head === head && previous.index !== undefined ? { index: previous.index } : {}),
    };
    snapshots.set(orgId, snapshot);
    const reachable = new Set(entries.map((entry) => entry.sha));
    for (const cache of [blobs, parsedBlobs, mismatchWarnings]) {
      for (const sha of cache.keys()) if (!reachable.has(sha)) cache.delete(sha);
    }
    return snapshot;
  });

  const query = Effect.fn("Memory.query")(function* (orgId: KinOrgId, q: MemoryQuery) {
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
    const { items } = yield* load(orgId);
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
  ) {
    const { items } = yield* load(orgId);
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

  const rebuildIndex = Effect.fn("Memory.rebuildIndex")(function* (orgId: KinOrgId) {
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* load(orgId);
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

  const readFile = Effect.fn("Memory.readFile")(function* (orgId: KinOrgId, name: string) {
    const snapshot = yield* load(orgId);
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

  const recover = Effect.fn("Memory.recover")(function* (orgId: KinOrgId) {
    const paths = yield* pathsFor(orgId);
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    const exists = yield* io(orgId, "exists", fs.exists(paths.writer));
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
        yield* notify({ orgId, branch: name, reason: "Deleted untrusted local shadow branch" });
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
    for (const row of rows)
      if (row.branch.startsWith("kin/shadow/") && !targets.has(row.branch))
        targets.set(row.branch, main);
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
      yield* notify({ orgId, branch, reason: "Recovered from remote head" });
    }
    pinnedHeads.delete(orgId);
    snapshots.delete(orgId);
    blobCaches.delete(orgId);
  });

  const prepare = Effect.fn("Memory.prepare")(function* (orgId: KinOrgId, wakeupId?: string) {
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
                remoteFiles.clear();
                for (const [file, bytes] of mergedFiles) remoteFiles.set(file, bytes);
                const heads = [];
                for (const [file, bytes] of remoteFiles) {
                  if (!["100644", "100755"].includes(modes.get(file) ?? "")) continue;
                  if (!folders.some((folder) => file.startsWith(`${folder}/`))) continue;
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
                    files: [...remoteFiles].map(([path, content]) => ({ path, content })),
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) => new MemoryError({ orgId, operation: "secretScan", cause }),
                    ),
                  );
                if (findings.length) {
                  yield* notify({
                    orgId,
                    branch,
                    reason: `Secret scan blocked merge: ${findings[0]!.ruleId} in ${findings[0]!.path}`,
                  });
                  return yield* new MemoryError({
                    orgId,
                    operation: "secretScan",
                    reason: `Secret scan blocked merge: ${findings[0]!.ruleId} in ${findings[0]!.path}`,
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
          if (next !== remote)
            yield* git(orgId, paths.writer, [
              "push",
              "--",
              repo.repoUrl,
              `${next}:refs/heads/${branch}`,
            ]);
          yield* git(orgId, paths.writer, ["update-ref", `refs/heads/${branch}`, next, head]);
          yield* record(orgId, branch, head, next);
          head = next;
        }
      }
    }
    yield* io(
      orgId,
      "readSnapshot",
      Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped();
          yield* git(orgId, paths.writer, ["clone-snapshot", `${temporary}/read`]);
          yield* git(orgId, `${temporary}/read`, ["checkout", "--detach", head]);
          yield* fs.remove(paths.read, { recursive: true, force: true });
          yield* fs.rename(`${temporary}/read`, paths.read);
        }),
      ),
    );
    pinnedHeads.set(orgId, head);
    const index = yield* readFile(orgId, "INDEX.md").pipe(
      Effect.catchTags({ MemoryError: () => Effect.succeed("") }),
    );
    const asOf = /^As of ([^\r\n]+)(?:\r?\n|$)/.exec(index)?.[1];
    const now = yield* Clock.currentTimeMillis;
    if (
      !asOf ||
      !Number.isFinite(dateMillis(asOf)) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(asOf) ||
      now - dateMillis(asOf) >= 36 * 60 * 60 * 1000 ||
      dateMillis(asOf) > now
    )
      yield* rebuildIndex(orgId);
    const rebuilt = yield* readFile(orgId, "INDEX.md");
    const indexAsOf = yield* Effect.fromOption(
      DateTime.make(/^As of ([^\r\n]+)(?:\r?\n|$)/.exec(rebuilt)?.[1] ?? ""),
    ).pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "indexDate", cause })));
    return { head, indexAsOf: DateTime.toUtc(indexAsOf) };
  });

  return Memory.of({
    withWriterLock,
    recover: Effect.fn("Memory.recoverLocked")((orgId) =>
      withWriterLock(orgId, locked(orgId, recover(orgId))),
    ),
    anchor,
    record,
    ensureCheckouts: Effect.fn("Memory.ensureCheckoutsLocked")((orgId) =>
      locked(orgId, ensureCheckouts(orgId, true)),
    ),
    prepareWakeup: Effect.fn("Memory.prepareWakeup")((orgId, wakeupId) =>
      withWriterLock(orgId, locked(orgId, prepare(orgId, wakeupId))),
    ),
    readPromptSnapshot: Effect.fn("Memory.readPromptSnapshot")((orgId, expectedHead) =>
      locked(
        orgId,
        Effect.gen(function* () {
          const snapshot = yield* load(orgId);
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
    query: Effect.fn("Memory.queryLocked")((orgId, q) => locked(orgId, query(orgId, q))),
    readItem: Effect.fn("Memory.readItemLocked")((orgId, id) =>
      locked(orgId, readItem(orgId, id, true)),
    ),
    readItemQuietly: Effect.fn("Memory.readItemQuietly")((orgId, id) =>
      locked(orgId, readItem(orgId, id, false)),
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
