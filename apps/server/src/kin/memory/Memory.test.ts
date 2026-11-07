import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Memory from "./Memory.ts";
import * as MemoryConfig from "./MemoryConfig.ts";
import * as ServerConfig from "../../config.ts";
import { fixtureItem } from "./__fixtures__/items.ts";

const orgA = KinOrgId.make("demo-a");
const orgB = KinOrgId.make("demo-b");
const itemId = KinMemoryItemId.make("def-001");
const gitLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const databaseLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const org of [orgA, orgB]) {
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, 'Fixture', '2026-11-01')`;
    }
  }),
).pipe(Layer.provideMerge(KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))));

const fakeRepository = () => {
  const files = new Map<string, string>();
  const hashes = new Map<string, string>();
  const hash = (text: string) => {
    let sha = hashes.get(text);
    if (!sha) {
      sha = (hashes.size + 1).toString(16).padStart(40, "0");
      hashes.set(text, sha);
    }
    return sha;
  };
  let treeReads = 0;
  let blobReads = 0;
  let revision = 0;
  const layer = Layer.succeed(
    VcsProcess.VcsProcess,
    VcsProcess.VcsProcess.of({
      run: Effect.fn("Test.git")(({ args, stdin, cwd }) => {
        let stdout = "";
        switch (args[0]) {
          case "rev-parse":
            stdout = args.includes("--show-toplevel")
              ? cwd
              : args.includes("--git-common-dir")
                ? cwd.replace(/memory-read$/, "memory/.git")
                : `fixture-head-${revision}`;
            break;
          case "remote":
            stdout = "unused";
            break;
          case "ls-tree": {
            treeReads++;
            stdout = [...files]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(
                ([file, text]) => `100644 blob ${hash(text)} ${Buffer.byteLength(text)}\t${file}\0`,
              )
              .join("");
            break;
          }
          case "cat-file": {
            blobReads++;
            stdout = (stdin?.trim().split("\n") ?? [])
              .map((sha) => {
                const text = [...files.values()].find(
                  (value) => hash(value) === sha && value !== "unreadable fixture",
                );
                return text === undefined
                  ? `${sha} missing\n`
                  : `${sha} blob ${Buffer.byteLength(text)}\n${text}\n`;
              })
              .join("");
            break;
          }
        }
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout,
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }),
    }),
  );
  return {
    files,
    layer,
    commit: () => {
      revision++;
    },
    counts: () => ({ treeReads, blobReads }),
  };
};
const configLayer = (baseDirectory: string, repoUrl: string) =>
  Layer.succeed(MemoryConfig.MemoryConfig, {
    baseDirectory,
    repositories: [
      { orgId: orgA, repoUrl, path: "a" },
      { orgId: orgB, repoUrl, path: "b" },
    ],
  });
const memoryLayer = (base: string, repo: string) =>
  Memory.layer.pipe(
    Layer.provide(configLayer(base, repo)),
    Layer.provide(gitLayer),
    Layer.provide(NodeServices.layer),
  );

it.live(
  "clones isolated checkouts, skips bad items, queries dates and refreshes only on committed HEAD",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const temporary = yield* fs.makeTempDirectoryScoped();
      const root = yield* fs.realPath(temporary);
      const source = `${root}/source`;
      yield* fs.copy(`${import.meta.dirname}/__fixtures__/memory`, source);
      const git = Effect.fn("Test.fixtureGit")((args: ReadonlyArray<string>) =>
        vcs.run({ operation: "test.memory", command: "git", cwd: source, args }),
      );
      yield* git(["init", "--initial-branch=main"]);
      yield* fs.symlink("def-001.md", `${source}/deferrals/link.md`);
      yield* fs.writeFileString(
        `${source}/deferrals/huge.md`,
        fixtureItem({ id: "huge" }) + "x".repeat(256 * 1024 + 1),
      );
      yield* fs.writeFileString(
        `${source}/objectives/mismatch.md`,
        fixtureItem({ id: "wrong-folder" }),
      );
      yield* git([
        "add",
        "rules.md",
        "INDEX.md",
        "deferrals",
        "commitments",
        "objectives",
        "decisions",
        "people",
        "claims",
        "journal",
      ]);
      yield* git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "Invented fixtures",
      ]);
      const base = `${root}/state`;
      yield* fs.makeDirectory(`${base}/a/memory`, { recursive: true });
      yield* fs.writeFileString(`${base}/a/memory/incomplete`, "interrupted clone");
      yield* fs.makeDirectory(`${base}/a/memory-read`, { recursive: true });
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const [a] = yield* Effect.all(
          [memory.ensureCheckouts(orgA), memory.ensureCheckouts(orgA)],
          { concurrency: "unbounded" },
        );
        const b = yield* memory.ensureCheckouts(orgB);
        expect(a.read).not.toBe(b.read);
        expect(yield* fs.exists(`${a.writer}/incomplete`)).toBe(false);
        const prepared = yield* memory.prepareWakeup(orgA);
        expect(prepared.head).toMatch(/^[0-9a-f]{40}$/);
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect(yield* memory.readIndex(orgA)).toMatch(/^As of /);
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("[invalid]");
        const cases: ReadonlyArray<{ query: Memory.MemoryQuery; ids: ReadonlyArray<string> }> = [
          { query: { kind: "deferral" }, ids: ["def-001"] },
          { query: { dueBefore: "2026-11-14T00:00:00" }, ids: [] },
          { query: { dueBefore: "2026-11-14", dueAfter: "2026-11-12" }, ids: ["def-001"] },
          { query: { reviewOverdue: true, kind: "commitment" }, ids: ["com-001"] },
          { query: { excludeInvalid: true }, ids: ["def-001"] },
          { query: {}, ids: ["com-001", "def-001"] },
        ];
        for (const { query, ids } of cases) {
          const result = yield* memory.query(orgA, query);
          expect(result.map((item) => item.id)).toEqual(ids);
          expect(result.every((item) => item.orgId === orgA)).toBe(true);
        }
        expect(
          (yield* memory.query(orgA, {})).some((item) => item.path.endsWith("broken.md")),
        ).toBe(false);
        expect((yield* memory.readItem(orgA, itemId)).body).toContain("Invented fixture body");
        expect((yield* memory.query(orgA, {}))[0]?.invalid_at).toBe("2026-11-02");
        yield* fs.writeFileString(
          `${a.read}/deferrals/def-001.md`,
          fixtureItem({ title: "Modified service maintenance" }),
        );
        yield* fs.writeFileString(`${a.read}/rules.md`, "Uncommitted rules");
        yield* fs.writeFileString(`${a.read}/INDEX.md`, "Uncommitted index");
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect(yield* memory.readIndex(orgA)).not.toContain("Uncommitted index");
        yield* fs.utimes(`${a.read}/deferrals/def-001.md`, 1_800_000_000, 1_800_000_000);
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
        yield* fs.writeFileString(
          `${source}/deferrals/def-001.md`,
          fixtureItem({ title: "Modified service maintenance" }),
        );
        yield* git(["add", "deferrals/def-001.md"]);
        yield* git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Update fixture",
        ]);
        const next = yield* memory.prepareWakeup(orgA);
        expect(next.head).not.toBe(prepared.head);
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe(
          "Modified service maintenance",
        );
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
      }).pipe(Effect.provide(memoryLayer(base, source)));
    }).pipe(
      Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
      Effect.scoped,
    ),
);

it.effect(
  "caps the index, stamps As of, flags overdue and fades at eight weeks without hiding search results",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T00:00:00.000Z"));
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped();
      const root = yield* fs.realPath(temporary);
      const repository = fakeRepository();
      const messages: string[] = [];
      const loggerLayer = Logger.layer(
        [Logger.make(({ message }) => messages.push(String(message)))],
        { mergeWithExisting: false },
      );
      const checkout = `${root}/a/memory-read`;
      yield* fs.makeDirectory(`${checkout}/deferrals`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/memory/.git`, { recursive: true });
      repository.files.set(
        "deferrals/def-001.md",
        fixtureItem({ recorded_at: "2026-11-14T00:00:00.000Z" }),
      );
      repository.files.set(
        "deferrals/unread.md",
        fixtureItem({
          id: "unread",
          title: "Never opened fixture",
          recorded_at: "2026-11-14T00:00:00.000Z",
        }),
      );
      repository.files.set("deferrals/unreadable.md", "unreadable fixture");
      repository.files.set("deferrals/broken.md", "---\nid: [\n---\n");
      const program = Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("As of 2026-11-14T00:00:00.000Z");
        expect(yield* memory.readIndex(orgA)).toContain("⚠ review");
        const counts = repository.counts();
        yield* memory.query(orgA, {});
        yield* memory.readItem(orgA, itemId);
        expect(repository.counts()).toEqual(counts);
        yield* TestClock.adjust("7 weeks");
        yield* memory.readItem(orgA, itemId);
        const moved = repository.files.get("deferrals/def-001.md");
        expect(moved).toBeDefined();
        repository.files.delete("deferrals/def-001.md");
        repository.files.set("deferrals/moved.md", moved ?? "");
        repository.commit();
        yield* TestClock.adjust("1 week");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        expect(yield* memory.readIndex(orgA)).not.toContain("Never opened fixture");
      });
      const layer = Memory.layer.pipe(
        Layer.provide(configLayer(root, "unused")),
        Layer.provide(repository.layer),
        Layer.provide(NodeServices.layer),
      );
      yield* program.pipe(Effect.provide(Layer.merge(layer, loggerLayer)));
      // The database outlives service instances and checkout paths.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        yield* TestClock.adjust("7 weeks");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).not.toContain("Invented service maintenance");
        expect(yield* memory.query(orgA, {})).toHaveLength(2);
        const beforeRebuild = repository.counts();
        yield* memory.rebuildCache(orgA);
        expect(repository.counts().treeReads).toBe(beforeRebuild.treeReads + 1);
        expect(repository.counts().blobReads).toBe(beforeRebuild.blobReads + 1);
        yield* memory.readItem(orgA, itemId);
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        for (let n = 0; n < 205; n++) {
          repository.files.set(
            `deferrals/extra-${n}.md`,
            fixtureItem({
              id: `extra-${n}`,
              recorded_at: "2027-02-27T00:00:00.000Z",
              title: "Multiline\nfixture",
            }),
          );
        }
        repository.commit();
        yield* memory.rebuildIndex(orgA);
        expect((yield* memory.readIndex(orgA)).trimEnd().split("\n")).toHaveLength(200);
        expect(yield* memory.readIndex(orgA)).toContain("more");
        const before = yield* memory.readIndex(orgA);
        yield* TestClock.adjust("35 hours");
        yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).toBe(before);
        yield* TestClock.adjust("1 hour");
        const refreshed = yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).not.toBe(before);
        expect(DateTime.toEpochMillis(refreshed.indexAsOf)).toBe(yield* Clock.currentTimeMillis);
        for (const index of [
          "As of 2099-01-01T00:00:00Z\n",
          "# index\nAs of 2027-02-28T00:00:00Z\n",
        ]) {
          repository.files.set("INDEX.md", index);
          repository.commit();
          const result = yield* memory.prepareWakeup(orgA);
          expect(DateTime.toEpochMillis(result.indexAsOf)).toBe(yield* Clock.currentTimeMillis);
        }
        repository.files.set(
          "deferrals/duplicate.md",
          fixtureItem({ recorded_at: "2027-02-27T00:00:00Z" }),
        );
        repository.commit();
        const duplicates = yield* memory.query(orgA, {}).pipe(Effect.result);
        expect(duplicates._tag).toBe("Failure");
        if (duplicates._tag === "Failure")
          expect(duplicates.failure._tag).toBe("MemoryDuplicateId");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("[duplicate id]");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE kin_memory_reads`;
        expect((yield* memory.readItem(orgA, KinMemoryItemId.make("extra-0"))).head.id).toBe(
          "extra-0",
        );
        expect(
          messages.filter((message) => message.includes("Skipping malformed memory item")),
        ).toHaveLength(2);
      }).pipe(Effect.provide(Layer.merge(layer, loggerLayer)));
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, databaseLayer)), Effect.scoped),
);

it.effect.each([
  { name: "escape", paths: ["../escape", "b"], symlink: false },
  { name: "overlap", paths: ["a", "a/nested"], symlink: false },
  { name: "symlink ancestor", paths: ["a", "b"], symlink: true },
])("refuses $name before touching a checkout", ({ paths, symlink }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${outside}/keep`, "untouched");
    if (symlink) yield* fs.symlink(outside, `${root}/a`);
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const result = yield* memory.ensureCheckouts(orgA).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.operation).toBe("config");
      expect(yield* fs.readFileString(`${outside}/keep`)).toBe("untouched");
    }).pipe(
      Effect.provide(
        Memory.layer.pipe(
          Layer.provide(
            Layer.succeed(MemoryConfig.MemoryConfig, {
              baseDirectory: root,
              repositories: [orgA, orgB].map((orgId, i) => ({
                orgId,
                repoUrl: "unused",
                path: paths[i] ?? "",
              })),
            }),
          ),
          Layer.provide(fakeRepository().layer),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, databaseLayer)), Effect.scoped),
);

it.effect("derives production memory paths from the isolated server state directory", () =>
  Effect.gen(function* () {
    const server = yield* ServerConfig.ServerConfig;
    const config = yield* MemoryConfig.MemoryConfig;
    expect(config.baseDirectory).toBe(`${server.stateDir}/kin`);
    expect(config.repositories[0]?.path).toBe(orgA);
  }).pipe(
    Effect.provide(
      MemoryConfig.layer([{ orgId: orgA, repoUrl: "unused" }]).pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "kin-memory-config-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
