import {
  type KinMemoryItemId,
  type KinOrgId,
  MemoryItemHead,
  VcsProcessExitError,
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

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as MemoryCache from "./MemoryCache.ts";
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

export class Memory extends Context.Service<
  Memory,
  {
    readonly ensureCheckouts: (orgId: KinOrgId) => Effect.Effect<MemoryPaths, MemoryError>;
    readonly prepareWakeup: (
      orgId: KinOrgId,
    ) => Effect.Effect<{ head: string; indexAsOf: DateTime.Utc }, MemoryError>;
    readonly readIndex: (orgId: KinOrgId) => Effect.Effect<string, MemoryError>;
    readonly readRules: (orgId: KinOrgId) => Effect.Effect<string, MemoryError>;
    readonly readItem: (
      orgId: KinOrgId,
      id: KinMemoryItemId,
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryError | MemoryNotFound | MemoryDuplicateId>;
    readonly query: (
      orgId: KinOrgId,
      query: MemoryQuery,
    ) => Effect.Effect<ReadonlyArray<MemoryItemHead>, MemoryError | MemoryDuplicateId>;
    readonly rebuildIndex: (orgId: KinOrgId) => Effect.Effect<void, MemoryError>;
    readonly rebuildCache: (orgId: KinOrgId) => Effect.Effect<void, MemoryError>;
  }
>()("t3/kin/memory/Memory") {}

const decodeHead = Schema.decodeEffect(MemoryItemHead);
const isVcsProcessExitError = Schema.is(VcsProcessExitError);

const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];
const week = 7 * 24 * 60 * 60 * 1000;
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, " ");

const maxBlobBytes = 256 * 1024;

interface Snapshot {
  readonly head: string;
  readonly items: ReadonlyArray<MemoryCache.MemoryItem>;
  readonly files: ReadonlyMap<string, string>;
  index?: string;
}

const make = Effect.gen(function* () {
  const config = yield* MemoryConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const cache = yield* MemoryCache.MemoryCache;
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();
  const snapshots = new Map<KinOrgId, Snapshot>();
  const blobs = new Map<string, string | undefined>();
  const parsedBlobs = new Map<
    string,
    | {
        readonly frontMatter: MemoryItemFrontMatter;
        readonly body: string;
      }
    | undefined
  >();

  const locked = <A, E>(orgId: KinOrgId, effect: Effect.Effect<A, E>) => {
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
  ) {
    const result = yield* vcs
      .run({
        operation: "Memory.git",
        command: "git",
        cwd,
        args,
        ...(stdin === undefined ? {} : { stdin }),
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          SSH_ASKPASS_REQUIRE: "never",
          GCM_INTERACTIVE: "never",
        },
        timeoutMs: 120_000,
        maxOutputBytes: 16 * 1024 * 1024,
        outputMode: "error",
      })
      .pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "git", cause })));
    return result.stdout;
  });
  const io = <A, E>(orgId: KinOrgId, operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation, cause })));

  const pathsFor = Effect.fn("Memory.pathsFor")(function* (orgId: KinOrgId) {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    const base = path.resolve(config.baseDirectory);
    if (!repo)
      return yield* new MemoryError({ orgId, operation: "config", reason: "Unknown organization" });
    const root = path.resolve(base, repo.path);
    if (
      !root.startsWith(base + path.sep) ||
      config.repositories.some((other) => {
        const otherRoot = path.resolve(base, other.path);
        return (
          other !== repo &&
          (other.orgId === orgId ||
            otherRoot === root ||
            otherRoot.startsWith(root + path.sep) ||
            root.startsWith(otherRoot + path.sep))
        );
      })
    )
      return yield* new MemoryError({
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
            return yield* new MemoryError({
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

  const ensureCheckouts = Effect.fn("Memory.ensureCheckouts")(function* (orgId: KinOrgId) {
    const paths = yield* pathsFor(orgId);
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    const gitDirectory = path.join(paths.writer, ".git");
    if (yield* io(orgId, "exists", fs.exists(gitDirectory))) {
      const stat = yield* io(orgId, "stat", fs.lstat(gitDirectory));
      if (stat.type !== "Directory")
        return yield* new MemoryError({
          orgId,
          operation: "config",
          reason: "Writer git directory must be server-owned",
        });
    }
    const writerExists = yield* io(orgId, "exists", fs.exists(paths.writer));
    const writerRoot = writerExists
      ? yield* io(orgId, "realPath", fs.realPath(paths.writer))
      : paths.writer;
    const validWriter =
      writerExists &&
      (yield* git(orgId, paths.writer, ["rev-parse", "--show-toplevel"]).pipe(
        Effect.map((value) => path.resolve(value.trim()) === writerRoot),
        Effect.catchTags({
          MemoryError: (error) =>
            isVcsProcessExitError(error.cause) ? Effect.succeed(false) : Effect.fail(error),
        }),
      ));
    if (!validWriter) {
      yield* io(orgId, "recoverClone", fs.remove(paths.writer, { recursive: true, force: true }));
      yield* git(orgId, paths.root, ["clone", "--", paths.repo.repoUrl, paths.writer]);
    } else {
      const origin = (yield* git(orgId, paths.writer, ["remote", "get-url", "origin"])).trim();
      if (origin !== paths.repo.repoUrl)
        return yield* new MemoryError({
          orgId,
          operation: "origin",
          reason: "Repository configuration changed",
        });
      yield* git(orgId, paths.writer, ["fetch", "origin"]);
    }
    const readExists = yield* io(orgId, "exists", fs.exists(paths.read));
    const commonDirectory = yield* io(orgId, "realPath", fs.realPath(gitDirectory));
    const readRoot = readExists
      ? yield* io(orgId, "realPath", fs.realPath(paths.read))
      : paths.read;
    const validRead =
      readExists &&
      (yield* git(orgId, paths.read, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]).pipe(
        Effect.flatMap((value) =>
          path.resolve(value.trim()) === commonDirectory
            ? git(orgId, paths.read, ["rev-parse", "--show-toplevel"]).pipe(
                Effect.map((top) => path.resolve(top.trim()) === readRoot),
              )
            : Effect.succeed(false),
        ),
        Effect.catchTags({
          MemoryError: (error) =>
            isVcsProcessExitError(error.cause) ? Effect.succeed(false) : Effect.fail(error),
        }),
      ));
    if (!validRead) {
      yield* io(orgId, "recoverWorktree", fs.remove(paths.read, { recursive: true, force: true }));
      yield* git(orgId, paths.writer, ["worktree", "prune"]);
      yield* git(orgId, paths.writer, ["worktree", "add", "--detach", paths.read, "HEAD"]);
    }
    return { writer: paths.writer, read: paths.read };
  });

  const load = Effect.fn("Memory.load")(function* (orgId: KinOrgId, force = false) {
    const paths = yield* pathsFor(orgId);
    const head = (yield* git(orgId, paths.read, ["rev-parse", "HEAD"])).trim();
    const previous = snapshots.get(orgId);
    if (!force && previous?.head === head) return previous;
    const tree = yield* git(orgId, paths.read, [
      "ls-tree",
      "-r",
      "-l",
      "-z",
      head,
      "--",
      ...folders,
      "rules.md",
      "INDEX.md",
    ]);
    const entries = tree.split("\0").flatMap((entry) => {
      const match = /^(\d+) (\S+) ([0-9a-f]+) +([0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) return [];
      const [, mode, type, sha, sizeText, relative] = match;
      if (!sha || !relative || mode === "120000" || type !== "blob" || !relative.endsWith(".md"))
        return [];
      return [{ sha, relative, size: Number(sizeText) }];
    });
    const pending = [
      ...new Map(
        entries
          .filter((entry) => !blobs.has(entry.sha) && entry.size <= maxBlobBytes)
          .map((entry) => [entry.sha, entry]),
      ).values(),
    ];
    for (let index = 0; index < pending.length; index += 32) {
      const batch = pending.slice(index, index + 32);
      const output = yield* git(
        orgId,
        paths.read,
        ["cat-file", "--batch"],
        batch.map((entry) => entry.sha).join("\n") + "\n",
      ).pipe(Effect.catchTags({ MemoryError: () => Effect.succeed("") }));
      const buffer = Buffer.from(output);
      let offset = 0;
      for (const entry of batch) {
        const end = buffer.indexOf(10, offset);
        if (end < 0) break;
        const header = buffer.subarray(offset, end).toString("utf8");
        offset = end + 1;
        if (header === `${entry.sha} missing`) continue;
        if (header !== `${entry.sha} blob ${entry.size}` || buffer.length < offset + entry.size + 1)
          break;
        blobs.set(entry.sha, buffer.subarray(offset, offset + entry.size).toString("utf8"));
        offset += entry.size + 1;
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
      if (!relative.startsWith(`${expectedFolder}/`))
        return yield* new MemoryItemError({
          orgId,
          path: relative,
          reason: "Memory kind does not match folder",
        });
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
    const snapshot: Snapshot = { head, items, files };
    snapshots.set(orgId, snapshot);
    return snapshot;
  });

  const query = Effect.fn("Memory.query")(function* (orgId: KinOrgId, q: MemoryQuery) {
    const now = yield* Clock.currentTimeMillis;
    const { items } = yield* load(orgId);
    const ids = new Set<string>();
    for (const { head } of items) {
      if (ids.has(head.id)) return yield* new MemoryDuplicateId({ orgId, id: head.id });
      ids.add(head.id);
    }
    return items
      .map((item) => item.head)
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

  const readItem = Effect.fn("Memory.readItem")(function* (orgId: KinOrgId, id: KinMemoryItemId) {
    const { items } = yield* load(orgId);
    const matches = items.filter((item) => item.head.id === id);
    const item = matches[0];
    if (!item) return yield* new MemoryNotFound({ orgId, id });
    if (matches.length > 1) return yield* new MemoryDuplicateId({ orgId, id });
    yield* cache.read(orgId, id).pipe(
      Effect.catchTags({
        MemoryHistoryError: () => Effect.logWarning("Could not record memory read", { orgId, id }),
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
    const counts = new Map<string, number>();
    for (const { head } of snapshot.items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
    const entries = snapshot.items
      .filter(({ head }) => now - (reads[head.id] ?? dateMillis(head.recorded_at)) < 8 * week)
      .map(
        ({ head }) =>
          `- [${head.kind}] ${oneLine(head.title)} (${oneLine(head.path)})${head.invalid_at !== null ? " [invalid]" : ""}${(counts.get(head.id) ?? 0) > 1 ? " [duplicate id]" : ""}${dateMillis(head.review_by) < now ? " ⚠ review" : ""}`,
      );
    const lines = [`As of ${DateTime.formatIso(DateTime.makeUnsafe(now))}`, "", "# Memory"];
    const capacity = 200 - lines.length;
    lines.push(...entries.slice(0, entries.length > capacity ? capacity - 1 : capacity));
    if (entries.length > capacity) lines.push(`${entries.length - capacity + 1} more`);
    snapshot.index = lines.join("\n") + "\n";
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

  const prepare = Effect.fn("Memory.prepare")(function* (orgId: KinOrgId) {
    const paths = yield* ensureCheckouts(orgId);
    yield* git(orgId, paths.writer, ["pull", "--ff-only"]);
    const head = (yield* git(orgId, paths.writer, ["rev-parse", "HEAD"])).trim();
    yield* git(orgId, paths.read, ["checkout", "--force", "--detach", head]);
    yield* git(orgId, paths.read, ["reset", "--hard", head]);
    yield* git(orgId, paths.read, ["clean", "-fdx"]);
    const index = yield* readFile(orgId, "INDEX.md").pipe(Effect.orElseSucceed(() => ""));
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
    ensureCheckouts: Effect.fn("Memory.ensureCheckoutsLocked")((orgId) =>
      locked(orgId, ensureCheckouts(orgId)),
    ),
    prepareWakeup: Effect.fn("Memory.prepareWakeup")((orgId) => locked(orgId, prepare(orgId))),
    readIndex: Effect.fn("Memory.readIndex")((orgId) => locked(orgId, readFile(orgId, "INDEX.md"))),
    readRules: Effect.fn("Memory.readRules")((orgId) => locked(orgId, readFile(orgId, "rules.md"))),
    query: Effect.fn("Memory.queryLocked")((orgId, q) => locked(orgId, query(orgId, q))),
    readItem: Effect.fn("Memory.readItemLocked")((orgId, id) => locked(orgId, readItem(orgId, id))),
    rebuildIndex: Effect.fn("Memory.rebuildIndexLocked")((orgId) =>
      locked(orgId, rebuildIndex(orgId)),
    ),
    rebuildCache: Effect.fn("Memory.rebuildCache")((orgId) =>
      locked(orgId, load(orgId, true).pipe(Effect.asVoid)),
    ),
  });
});

export const layer = Layer.effect(Memory, make).pipe(Layer.provide(MemoryCache.layer));
