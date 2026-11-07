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
  let validations = 0;
  let treeReads = 0;
  let blobReads = 0;
  let revision = 0;
  let corruptNextBatch = false;
  const layer = Layer.succeed(
    VcsProcess.VcsProcess,
    VcsProcess.VcsProcess.of({
      run: Effect.fn("Test.git")(({ args, stdin, cwd, onStdoutChunk }) => {
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
            validations++;
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
            if (args[1] === "blob") {
              stdout =
                [...files.values()].find(
                  (value) => hash(value) === args[2] && value !== "unreadable fixture",
                ) ?? "";
              break;
            }
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
            if (corruptNextBatch) {
              stdout = "invalid header\n" + stdout;
              corruptNextBatch = false;
            }
            break;
          }
        }
        onStdoutChunk?.(Buffer.from(stdout));
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
    counts: () => ({ treeReads, blobReads, validations }),
    corruptBatch: () => {
      corruptNextBatch = true;
    },
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

it.live.each([
  { name: "committed lead edits", binary: false, indexDirectory: false },
  { name: "binary preceding valid blobs", binary: true, indexDirectory: false },
  { name: "blocked index path", binary: false, indexDirectory: true },
])(
  "clones isolated checkouts and preserves committed source reads with $name",
  ({ binary, indexDirectory }) =>
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
      if (binary)
        yield* fs.writeFile(`${source}/commitments/aaa.md`, new Uint8Array([255, 254, 128, 0]));
      if (indexDirectory) {
        yield* fs.remove(`${source}/INDEX.md`);
        yield* fs.makeDirectory(`${source}/INDEX.md`);
        yield* fs.writeFileString(`${source}/INDEX.md/blocked`, "fixture");
      }
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
      yield* fs.makeDirectory(`${base}/a/memory.clone-crashed`, { recursive: true });
      yield* fs.writeFileString(`${base}/a/memory.clone-crashed/incomplete`, "interrupted clone");
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
        for (const query of [
          { dueBefore: "2026-11-14T00:00:00" },
          { dueAfter: "bad" },
          { limit: -1 },
          { limit: NaN },
          { limit: Infinity },
        ]) {
          const result = yield* memory.query(orgA, query).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryQueryDecodeError");
        }
        expect(yield* fs.exists(`${base}/a/memory.clone-crashed`)).toBe(false);
        const cases: ReadonlyArray<{ query: Memory.MemoryQuery; ids: ReadonlyArray<string> }> = [
          { query: { kind: "deferral" }, ids: ["def-001"] },

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
        if (!indexDirectory) yield* fs.writeFileString(`${a.read}/INDEX.md`, "Uncommitted index");

        yield* vcs.run({
          operation: "test.memory",
          command: "git",
          cwd: a.read,
          args: ["add", "rules.md", "deferrals/def-001.md"],
        });
        yield* vcs.run({
          operation: "test.memory",
          command: "git",
          cwd: a.read,
          args: [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "Untrusted lead edits",
          ],
        });
        yield* memory.rebuildCache(orgA);
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect(yield* memory.readIndex(orgA)).not.toContain("Uncommitted index");
        yield* fs.utimes(`${a.read}/deferrals/def-001.md`, 1_800_000_000, 1_800_000_000);
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
        yield* git(["fetch", a.read, "HEAD"]);
        yield* git(["merge", "--ff-only", "FETCH_HEAD"]);
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect((yield* memory.query(orgA, { kind: "deferral" }))[0]?.title).toBe(
          "Invented service maintenance",
        );
        const next = yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readRules(orgA)).toBe("Uncommitted rules");
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
          due: "2026-11-21T19:00:00.000Z",
          recorded_at: "2026-11-14T00:00:00.000Z",
        }),
      );
      repository.files.set("deferrals/unreadable.md", "unreadable fixture");
      repository.files.set("deferrals/broken.md", "---\nid: [\n---\n");
      const program = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
          VALUES (${orgA}, 'Asia/Kolkata', '08:30', '18:30', '02:00', 0, 5, '12:00', '{"from":"22:00","to":"07:00"}')
        `;
        const memory = yield* Memory.Memory;
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).not.toContain("## Due in 7 days");
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
        yield* memory.prepareWakeup(orgA);
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
        yield* memory.prepareWakeup(orgA);
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
        yield* memory.prepareWakeup(orgA);
        const duplicates = yield* memory.query(orgA, {});
        expect(
          duplicates.filter((item) => item.id === itemId).every((item) => item.duplicate),
        ).toBe(true);
        expect(yield* memory.query(orgA, { kind: "commitment" })).toEqual([]);
        const duplicateRead = yield* memory.readItem(orgA, itemId).pipe(Effect.result);
        expect(duplicateRead._tag).toBe("Failure");
        if (duplicateRead._tag === "Failure")
          expect(duplicateRead.failure._tag).toBe("MemoryDuplicateId");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("[duplicate id]");
        const beforeFallback = yield* memory.query(orgA, {});
        for (const id of ["fallback-1", "fallback-2"]) {
          repository.files.set(`deferrals/${id}.md`, fixtureItem({ id }));
        }
        repository.commit();
        repository.corruptBatch();
        yield* memory.prepareWakeup(orgA);
        const afterFallback = yield* memory.query(orgA, {});
        expect(afterFallback.filter((item) => !item.id.startsWith("fallback-"))).toEqual(
          beforeFallback,
        );
        expect(afterFallback.filter((item) => item.id.startsWith("fallback-"))).toHaveLength(2);
        yield* memory.rebuildCache(orgA);
        expect(messages.filter((message) => message.includes("Duplicate memory id"))).toHaveLength(
          1,
        );
        expect(messages.some((message) => message.includes("batch framing failed"))).toBe(true);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_trigger_settings SET time_zone = 'UTC' WHERE org_id = ${orgA}`;
        repository.commit();
        yield* memory.prepareWakeup(orgA);
        const utcIndex = yield* memory.readIndex(orgA);
        yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Invented/Invalid' WHERE org_id = ${orgA}`;
        repository.commit();
        yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("As of ");
        expect(yield* memory.readIndex(orgA)).toBe(utcIndex);
        expect(messages.some((message) => message.includes("Invalid memory owner time zone"))).toBe(
          true,
        );
        yield* sql`DROP TABLE kin_trigger_settings`;
        yield* sql`DROP TABLE kin_memory_reads`;
        repository.commit();
        yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("As of ");
        expect(
          messages.some((message) => message.includes("Could not load memory owner time zone")),
        ).toBe(true);
        expect(
          messages.some((message) => message.includes("Could not load memory read history")),
        ).toBe(true);
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

const fixtureRepository = Effect.fn("Test.fixtureRepository")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const vcs = yield* VcsProcess.VcsProcess;
  const temporary = yield* fs.makeTempDirectoryScoped();
  const root = yield* fs.realPath(temporary);
  const source = `${root}/source`;
  yield* fs.copy(`${import.meta.dirname}/__fixtures__/memory`, source);
  const git = Effect.fn("Test.realGit")((cwd: string, args: ReadonlyArray<string>) =>
    vcs
      .run({ operation: "test.memory", command: "git", cwd, args })
      .pipe(Effect.map((r) => r.stdout.trim())),
  );
  const commit = Effect.fn("Test.commit")(function* (cwd: string) {
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Invented fixture",
    ]);
    return yield* git(cwd, ["rev-parse", "HEAD"]);
  });
  yield* git(source, ["init", "--initial-branch=main"]);
  yield* commit(source);
  return { root, source, git, commit };
});

it.live.each([
  "missing HEAD",
  "missing objects",
  "empty git",
  "permission denied",
  "parent repository",
  "non-repository directory",
])("preserves the existing writer on $0", (damage) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, source, git, commit } = yield* fixtureRepository();
    const base = `${root}/state`;
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const { writer } = yield* memory.ensureCheckouts(orgA);
      yield* fs.writeFileString(`${writer}/keep`, "unpushed work");
      const head = yield* commit(writer);
      const savedHead = yield* fs.readFileString(`${writer}/.git/HEAD`);
      if (damage === "missing HEAD") yield* fs.remove(`${writer}/.git/HEAD`);
      if (damage === "missing objects")
        yield* fs.remove(`${writer}/.git/objects`, { recursive: true });
      if (
        damage === "empty git" ||
        damage === "parent repository" ||
        damage === "non-repository directory"
      ) {
        yield* fs.remove(`${writer}/.git`, { recursive: true });
        if (damage === "empty git") yield* fs.makeDirectory(`${writer}/.git`);
        if (damage === "parent repository") yield* git(base, ["init"]);
      }
      if (damage === "permission denied") {
        yield* Effect.addFinalizer(() => fs.chmod(`${writer}/.git`, 0o755).pipe(Effect.orDie));
        yield* fs.chmod(`${writer}/.git`, 0);
      }
      const result = yield* memory.ensureCheckouts(orgA).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
      expect(yield* fs.readFileString(`${writer}/keep`)).toBe("unpushed work");
      if (damage === "missing HEAD") {
        yield* fs.writeFileString(`${writer}/.git/HEAD`, savedHead);
        expect(yield* git(writer, ["rev-parse", "HEAD"])).toBe(head);
      }
    }).pipe(Effect.provide(memoryLayer(base, source)), Effect.scoped);
  }).pipe(
    Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
    Effect.scoped,
  ),
);

it.live.each([
  { first: "Acme", second: "acme" },
  { first: "Café", second: "Cafe\u0301" },
])(
  "rejects colliding organization paths $first and $second before touching checkouts",
  ({ first, second }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, source } = yield* fixtureRepository();
      const base = `${root}/state`;
      const orgs = [KinOrgId.make("unrelated"), KinOrgId.make(first), KinOrgId.make(second)];
      yield* fs.makeDirectory(`${base}/${first}/memory`, { recursive: true });
      yield* fs.writeFileString(`${base}/${first}/memory/keep`, "untouched");
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        for (const org of orgs) {
          const result = yield* memory.ensureCheckouts(org).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryConfigError");
        }
        expect(yield* fs.readFileString(`${base}/${first}/memory/keep`)).toBe("untouched");
        expect(yield* fs.readDirectory(base)).toEqual([first]);
      }).pipe(
        Effect.provide(
          Memory.layer.pipe(
            Layer.provide(
              Layer.succeed(MemoryConfig.MemoryConfig, {
                baseDirectory: base,
                repositories: orgs.map((orgId) => ({ orgId, repoUrl: source, path: orgId })),
              }),
            ),
            Layer.provide(gitLayer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
      Effect.scoped,
    ),
);

it.live("refuses reads from a writer with the wrong origin after service restart", () =>
  Effect.gen(function* () {
    const { root, source, git } = yield* fixtureRepository();
    const base = `${root}/state`;
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const { writer } = yield* memory.ensureCheckouts(orgA);
      yield* git(writer, ["remote", "set-url", "origin", `${root}/other-fixture`]);
    }).pipe(Effect.provide(memoryLayer(base, source)));
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const result = yield* memory.query(orgA, {}).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
    }).pipe(Effect.provide(memoryLayer(base, source)));
  }).pipe(
    Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
    Effect.scoped,
  ),
);

it.live("uses filesystem identity for a case-mismatched base without recloning", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, source, commit, git } = yield* fixtureRepository();
    const base = `${root}/State`;
    yield* fs.makeDirectory(base);
    // Case-sensitive filesystems cannot exercise an alternate spelling of the same directory.
    if (!(yield* fs.exists(`${root}/state`))) return;
    const writer = yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      return (yield* memory.ensureCheckouts(orgA)).writer;
    }).pipe(Effect.provide(memoryLayer(base, source)));
    yield* fs.writeFileString(`${writer}/keep`, "unpushed work");
    const head = yield* commit(writer);
    const before = yield* fs.stat(writer);
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      const paths = yield* memory.ensureCheckouts(orgA);
      const after = yield* fs.stat(paths.writer);
      expect(after.ino).toEqual(before.ino);
      expect(yield* git(paths.writer, ["rev-parse", "HEAD"])).toBe(head);
      expect(yield* memory.query(orgA, {})).toHaveLength(2);
      yield* memory.ensureCheckouts(orgA);
      expect(yield* fs.readFileString(`${writer}/keep`)).toBe("unpushed work");
    }).pipe(Effect.provide(memoryLayer(`${root}/state`, source)));
  }).pipe(
    Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
    Effect.scoped,
  ),
);

it.live.each(["diverged", "conflict", "network down", "dirty writer", "rebase in progress"])(
  "syncs the writer with $0",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, source, git, commit } = yield* fixtureRepository();
      const base = `${root}/state`;
      const messages: string[] = [];
      const logger = Logger.layer([Logger.make(({ message }) => messages.push(String(message)))], {
        mergeWithExisting: false,
      });
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const initial = yield* memory.prepareWakeup(orgA);
        const { writer } = yield* memory.ensureCheckouts(orgA);
        yield* git(writer, ["config", "user.name", "Fixture"]);
        yield* git(writer, ["config", "user.email", "fixture@example.invalid"]);
        yield* fs.writeFileString(`${writer}/rules.md`, "Local invented rules\n");
        const local = yield* commit(writer);
        yield* fs.writeFileString(
          `${source}/${scenario === "diverged" || scenario === "network down" || scenario === "dirty writer" ? "remote-only" : "rules.md"}`,
          "Remote invented edit\n",
        );
        const remote = yield* commit(source);
        if (scenario === "network down") yield* fs.rename(source, `${root}/offline`);
        if (scenario === "dirty writer")
          yield* fs.writeFileString(`${writer}/rules.md`, "Uncommitted fixture edit\n");
        if (scenario === "rebase in progress") {
          yield* git(writer, ["fetch", "origin"]);
          yield* git(writer, ["rebase", "@{u}"]).pipe(Effect.ignore);
          yield* fs.writeFileString(`${writer}/rules.md`, "Half-resolved fixture edit\n");
        }
        const result = yield* memory.prepareWakeup(orgA).pipe(Effect.result);
        if (scenario === "rebase in progress") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
          expect(yield* fs.exists(`${writer}/.git/rebase-merge`)).toBe(true);
          expect(yield* fs.readFileString(`${writer}/rules.md`)).toBe(
            "Half-resolved fixture edit\n",
          );
        } else if (scenario === "dirty writer") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryError");
          expect(yield* git(writer, ["rev-parse", "HEAD"])).toBe(local);
          expect(yield* fs.readFileString(`${writer}/rules.md`)).toBe("Uncommitted fixture edit\n");
        } else if (scenario === "conflict") {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure._tag).toBe("MemorySyncConflict");
          expect(yield* git(writer, ["rev-parse", "HEAD"])).toBe(local);
          expect(yield* fs.readFileString(`${writer}/rules.md`)).toBe("Local invented rules\n");
          expect(yield* git(writer, ["status", "--porcelain"])).toBe("");
          expect(yield* fs.exists(`${writer}/.git/rebase-merge`)).toBe(false);
          expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        } else {
          expect(result._tag).toBe("Success");
          if (result._tag !== "Success") return;
          expect(result.success.head).not.toBe(initial.head);
          expect(yield* memory.readRules(orgA)).toBe("Local invented rules\n");
          if (scenario === "diverged") {
            expect(result.success.head).not.toBe(local);
            expect(yield* git(writer, ["merge-base", "HEAD", remote])).toBe(remote);
            expect(yield* fs.readFileString(`${writer}/remote-only`)).toBe(
              "Remote invented edit\n",
            );
          } else {
            expect(result.success.head).toBe(local);
            expect(messages.some((message) => message.includes("using local writer HEAD"))).toBe(
              true,
            );
          }
        }
      }).pipe(Effect.provide(Layer.merge(memoryLayer(base, source), logger)));
    }).pipe(
      Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
      Effect.scoped,
    ),
);
