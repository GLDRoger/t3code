import {
  type KinMemoryItemId,
  type KinOrgId,
  MemoryItemHead,
  type MemoryItemKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as MemoryCache from "./MemoryCache.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import { parseFrontMatter } from "./frontMatter.ts";

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  orgId: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export class MemoryNotFound extends Schema.TaggedError<MemoryNotFound>()("MemoryNotFound", {
  orgId: Schema.String,
  id: Schema.String,
}) {}

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
    ) => Effect.Effect<MemoryCache.MemoryItem, MemoryError | MemoryNotFound>;
    readonly query: (
      orgId: KinOrgId,
      query: MemoryQuery,
    ) => Effect.Effect<ReadonlyArray<MemoryItemHead>, MemoryError>;
    readonly rebuildIndex: (orgId: KinOrgId) => Effect.Effect<void, MemoryError>;
    readonly rebuildCache: (orgId: KinOrgId) => Effect.Effect<void, MemoryError>;
  }
>()("t3/kin/memory/Memory") {}

const decodeHead = Schema.decodeEffect(MemoryItemHead);

const folders = ["objectives", "commitments", "deferrals", "decisions", "people", "claims"];
const week = 7 * 24 * 60 * 60 * 1000;
const dateMillis = (value: string | null) => (value === null ? NaN : Date.parse(value));
const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]/g, " ");

const make = Effect.gen(function* () {
  const config = yield* MemoryConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const cache = yield* MemoryCache.MemoryCache;
  const locks = new Map<KinOrgId, Semaphore.Semaphore>();

  const git = Effect.fn("Memory.git")(function* (
    orgId: KinOrgId,
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    return yield* vcs
      .run({ operation: "Memory.git", command: "git", cwd, args, outputMode: "error" })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError((cause) => new MemoryError({ orgId, operation: "git", cause })),
      );
  });
  const io = <A, E>(orgId: KinOrgId, operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation, cause })));

  const pathsFor = Effect.fn("Memory.pathsFor")(function* (orgId: KinOrgId) {
    const repo = config.repositories.find((entry) => entry.orgId === orgId);
    const base = path.resolve(config.baseDirectory);
    if (!repo)
      return yield* new MemoryError({ orgId, operation: "config", cause: "Unknown organization" });
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
        cause: "Overlapping or escaping memory paths",
      });
    return { repo, root, writer: path.join(root, "memory"), read: path.join(root, "memory-read") };
  });

  const ensureCheckouts = Effect.fn("Memory.ensureCheckouts")(function* (orgId: KinOrgId) {
    const paths = yield* pathsFor(orgId);
    yield* io(orgId, "mkdir", fs.makeDirectory(paths.root, { recursive: true }));
    if (!(yield* io(orgId, "exists", fs.exists(paths.writer)))) {
      yield* git(orgId, paths.root, ["clone", "--", paths.repo.repoUrl, paths.writer]);
    } else {
      const origin = yield* git(orgId, paths.writer, ["remote", "get-url", "origin"]);
      if (origin !== paths.repo.repoUrl)
        return yield* new MemoryError({
          orgId,
          operation: "origin",
          cause: "Repository configuration changed",
        });
      yield* git(orgId, paths.writer, ["fetch", "origin"]);
    }
    if (!(yield* io(orgId, "exists", fs.exists(paths.read)))) {
      yield* git(orgId, paths.writer, ["worktree", "add", "--detach", paths.read, "HEAD"]);
    }
    return { writer: paths.writer, read: paths.read };
  });

  const load = Effect.fn("Memory.load")(function* (orgId: KinOrgId) {
    const paths = yield* pathsFor(orgId);
    const head = yield* git(orgId, paths.read, ["rev-parse", "HEAD"]);
    const items: Array<MemoryCache.CachedMemoryItem> = [];
    const visit = Effect.fn("Memory.visit")(function* (
      relative: string,
    ): Effect.fn.Return<void, MemoryError> {
      const absolute = path.join(paths.read, relative);
      const stat = yield* io(orgId, "stat", fs.lstat(absolute));
      if (stat.type === "SymbolicLink") return;
      if (stat.type === "Directory") {
        for (const name of (yield* io(orgId, "list", fs.readDirectory(absolute))).sort()) {
          yield* visit(path.join(relative, name));
        }
      } else if (stat.type === "File" && relative.endsWith(".md")) {
        const fingerprint = `${head}:${Option.getOrUndefined(stat.mtime)?.getTime()}:${stat.size}`;
        const previous = yield* cache.get(orgId, relative);
        if (previous?.fingerprint === fingerprint) {
          items.push(previous);
          return;
        }
        const text = yield* io(orgId, "read", fs.readFileString(absolute));
        const parsed = yield* parseFrontMatter(orgId, relative, text).pipe(
          Effect.catchTags({
            MemoryItemError: (error) =>
              Effect.logWarning("Skipping malformed memory item", {
                orgId: error.orgId,
                path: error.path,
                errorTag: error._tag,
              }).pipe(Effect.as(undefined)),
          }),
        );
        if (parsed) {
          const itemHead = yield* decodeHead({
            ...parsed.frontMatter,
            orgId,
            path: relative,
          }).pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "head", cause })));
          items.push({ head: itemHead, body: parsed.body, fingerprint });
        }
      }
    });
    for (const folder of folders) {
      if (yield* io(orgId, "exists", fs.exists(path.join(paths.read, folder))))
        yield* visit(folder);
    }
    yield* cache.replace(orgId, items);
    return items;
  });

  const query = Effect.fn("Memory.query")(function* (orgId: KinOrgId, q: MemoryQuery) {
    const now = yield* Clock.currentTimeMillis;
    const items = yield* load(orgId);
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
    const items = yield* load(orgId);
    const matches = items.filter((item) => item.head.id === id);
    const item = matches[0];
    if (!item) return yield* new MemoryNotFound({ orgId, id });
    if (matches.length > 1)
      return yield* new MemoryError({ orgId, operation: "readItem", cause: "Duplicate item id" });
    yield* io(orgId, "recordRead", cache.read(orgId, item.head.path));
    return { head: item.head, body: item.body };
  });

  const rebuildIndex = Effect.fn("Memory.rebuildIndex")(function* (orgId: KinOrgId) {
    const now = yield* Clock.currentTimeMillis;
    const items = yield* load(orgId);
    const reads = yield* io(orgId, "lastReads", cache.lastReads(orgId));
    const lines = [`As of ${DateTime.formatIso(DateTime.makeUnsafe(now))}`, "", "# Memory"];
    for (const { head } of items) {
      const lastRead = reads[head.path];
      if (now - (lastRead ?? dateMillis(head.recorded_at)) >= 8 * week) continue;
      if (lines.length === 200) break;
      lines.push(
        `- [${head.kind}] ${oneLine(head.title)} (${oneLine(head.path)})${head.invalid_at !== null ? " [invalid]" : ""}${dateMillis(head.review_by) < now ? " ⚠ review" : ""}`,
      );
    }
    const paths = yield* pathsFor(orgId);
    yield* io(
      orgId,
      "writeIndex",
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempFileScoped({
          directory: paths.read,
          prefix: ".kin-index-",
        });
        yield* fs.writeFileString(temporary, lines.join("\n") + "\n");
        yield* fs.rename(temporary, path.join(paths.read, "INDEX.md"));
      }).pipe(Effect.scoped),
    );
  });

  const readFile = Effect.fn("Memory.readFile")(function* (orgId: KinOrgId, name: string) {
    const paths = yield* pathsFor(orgId);
    const file = path.join(paths.read, name);
    const stat = yield* io(orgId, "stat", fs.lstat(file));
    if (stat.type !== "File")
      return yield* new MemoryError({
        orgId,
        operation: "read",
        cause: "Expected a regular memory file",
      });
    return yield* io(orgId, "read", fs.readFileString(file));
  });

  const prepare = Effect.fn("Memory.prepare")(function* (orgId: KinOrgId) {
    const paths = yield* ensureCheckouts(orgId);
    yield* git(orgId, paths.writer, ["pull", "--ff-only"]);
    const head = yield* git(orgId, paths.writer, ["rev-parse", "HEAD"]);
    yield* git(orgId, paths.read, ["checkout", "--force", "--detach", head]);
    yield* git(orgId, paths.read, ["reset", "--hard", head]);
    yield* git(orgId, paths.read, ["clean", "-fdx"]);
    const index = yield* readFile(orgId, "INDEX.md").pipe(Effect.orElseSucceed(() => ""));
    const asOf = /^As of (.+)$/m.exec(index)?.[1];
    const now = yield* Clock.currentTimeMillis;
    if (
      !asOf ||
      !Number.isFinite(dateMillis(asOf)) ||
      now - dateMillis(asOf) >= 36 * 60 * 60 * 1000 ||
      dateMillis(asOf) > now
    )
      yield* rebuildIndex(orgId);
    const rebuilt = yield* readFile(orgId, "INDEX.md");
    const indexAsOf = yield* Effect.fromOption(
      DateTime.make(/^As of (.+)$/m.exec(rebuilt)?.[1] ?? ""),
    ).pipe(Effect.mapError((cause) => new MemoryError({ orgId, operation: "indexDate", cause })));
    return { head, indexAsOf: DateTime.toUtc(indexAsOf) };
  });

  return Memory.of({
    ensureCheckouts,
    prepareWakeup: Effect.fn("Memory.prepareWakeup")(function* (orgId) {
      let lock = locks.get(orgId);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(orgId, lock);
      }
      return yield* lock.withPermits(1)(prepare(orgId));
    }),
    readIndex: Effect.fn("Memory.readIndex")((orgId) => readFile(orgId, "INDEX.md")),
    readRules: Effect.fn("Memory.readRules")((orgId) => readFile(orgId, "rules.md")),
    query,
    readItem,
    rebuildIndex,
    rebuildCache: Effect.fn("Memory.rebuildCache")(function* (orgId) {
      yield* load(orgId);
    }),
  });
});

export const layer = Layer.effect(Memory, make).pipe(Layer.provide(MemoryCache.layer));
