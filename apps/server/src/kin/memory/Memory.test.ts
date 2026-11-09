import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { KinAgentId, KinWakeupId, KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Memory from "./Memory.ts";
import * as Chat from "../chat/KinChatRepository.ts";
import { KinLeadPrompt } from "../lead/LeadPrompt.ts";
import * as MemoryCache from "./MemoryCache.ts";
import * as MemoryConfig from "./MemoryConfig.ts";
import * as ServerConfig from "../../config.ts";
import { fixtureItem } from "./__fixtures__/items.ts";
import { fakeRepository } from "./__fixtures__/repository.ts";

const memoryTestLayer = Memory.layer.pipe(
  Layer.provide(
    Layer.succeed(Memory.MemoryRecoveryHooks, {
      notify: (notice) => Effect.logWarning("Memory recovery", notice),
    }),
  ),
);
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

const configLayer = (baseDirectory: string, repoUrl: string) =>
  Layer.succeed(MemoryConfig.MemoryConfig, {
    baseDirectory,
    repositories: [
      { orgId: orgA, repoUrl, path: "a" },
      { orgId: orgB, repoUrl, path: "b" },
    ],
  });
const memoryLayer = (base: string, repo: string) =>
  memoryTestLayer.pipe(
    Layer.provide(configLayer(base, repo)),
    Layer.provide(gitLayer),
    Layer.provide(NodeServices.layer),
  );

it.live.each([
  { name: "committed lead edits", binary: false, indexDirectory: false, missingIndex: false },
  {
    name: "binary preceding valid blobs",
    binary: true,
    indexDirectory: false,
    missingIndex: false,
  },
  { name: "blocked index path", binary: false, indexDirectory: true, missingIndex: false },
  { name: "no committed index", binary: false, indexDirectory: false, missingIndex: true },
])(
  "clones isolated checkouts and preserves committed source reads with $name",
  ({ binary, indexDirectory, missingIndex }) =>
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
      if (missingIndex) yield* fs.remove(`${source}/INDEX.md`);
      yield* fs.symlink("def-001.md", `${source}/deferrals/link.md`);
      const planted = {
        "CLAUDE.md": "Planted instructions\n",
        ".claude/settings.json": '{"hooks":{}}\n',
        ".mcp.json": '{"mcpServers":{}}\n',
        "deferrals/CLAUDE.md": "Planted instructions\n",
        "journal/.claude/skills/x/SKILL.md": "Planted skill\n",
        "journal/.claude/commands/x.md": "Planted command\n",
        "journal/2026/11-01.md": "Invented journal entry\n",
        "journal/x\\..\\..\\CLAUDE.md": "Planted instructions\n",
        "deferrals/AGENTſ.md": "Planted instructions\n",
      };
      for (const [file, text] of Object.entries(planted)) {
        if (file.includes("/"))
          yield* fs.makeDirectory(`${source}/${file.slice(0, file.lastIndexOf("/"))}`, {
            recursive: true,
          });
        yield* fs.writeFileString(`${source}/${file}`, text);
      }
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
        ...(missingIndex ? [] : ["INDEX.md"]),
        "deferrals",
        "commitments",
        "objectives",
        "decisions",
        "people",
        "claims",
        "journal",
        "CLAUDE.md",
        ".claude",
        ".mcp.json",
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
      const messages: string[] = [];
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const [a] = yield* Effect.all(
          [memory.ensureCheckouts(orgA), memory.ensureCheckouts(orgA)],
          { concurrency: "unbounded" },
        );
        const b = yield* memory.ensureCheckouts(orgB);
        expect(a.read).not.toBe(b.read);
        expect(yield* fs.exists(`${a.writer}/incomplete`)).toBe(false);
        const assertPrompt = (head: string, unavailable: boolean) =>
          Effect.gen(function* () {
            const prompt = yield* KinLeadPrompt;
            const input = {
              orgId: orgA,
              agentId: KinAgentId.make("fixture-lead"),
              wakeupId: KinWakeupId.make("fixture-wake"),
              memoryHead: head,
              events: [],
            };
            const first = yield* prompt.build(input);
            const second = yield* prompt.build(input);
            expect(first.split("--- KIN WAKE-UP ---")[0]).toBe(
              second.split("--- KIN WAKE-UP ---")[0],
            );
            expect(first.includes("index unavailable")).toBe(unavailable);
            if (unavailable)
              expect(first).toContain('> BEGIN QUOTE: memory index\n> ""\n> END QUOTE');
          }).pipe(
            Effect.provide(KinLeadPrompt.layer.pipe(Layer.provide(Chat.layer))),
            Effect.provideService(Memory.Memory, memory),
          );
        if (!missingIndex && !indexDirectory) {
          const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
          expect((yield* memory.readPromptSnapshot(orgA, head)).index).toBe(
            yield* fs.readFileString(`${source}/INDEX.md`),
          );
        }
        if (missingIndex) {
          const head = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
          expect((yield* memory.readPromptSnapshot(orgA, head)).index).toBe("");
          yield* assertPrompt(head, true);
        }
        const prepared = yield* memory.prepareWakeup(orgA);
        expect(prepared.head).toMatch(/^[0-9a-f]{40}$/);
        for (const file of ["deferrals/def-001.md", "journal/2026/11-01.md", "rules.md"])
          expect(yield* fs.exists(`${a.read}/${file}`)).toBe(true);
        for (const file of [
          "CLAUDE.md",
          ".claude",
          ".mcp.json",
          "deferrals/CLAUDE.md",
          "journal/.claude",
          "deferrals/link.md",
          "journal/x\\..\\..\\CLAUDE.md",
          "deferrals/AGENTſ.md",
        ])
          expect(yield* fs.exists(`${a.read}/${file}`)).toBe(false);
        const promptSnapshot = yield* memory.readPromptSnapshot(orgA, prepared.head);
        expect(promptSnapshot).toEqual({
          rules: yield* fs.readFileString(`${source}/rules.md`),
          index: yield* memory.readIndex(orgA),
        });
        yield* assertPrompt(prepared.head, false);
        yield* memory.rebuildIndex(orgA);
        expect((yield* memory.readPromptSnapshot(orgA, prepared.head)).index).toBe(
          yield* memory.readIndex(orgA),
        );
        expect(
          yield* memory.readPromptSnapshot(orgA, "wrong-head").pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "MemoryError" } });
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
        for (const file of ["rules.md", "deferrals/def-001.md"])
          yield* fs.copyFile(`${a.read}/${file}`, `${source}/${file}`);
        yield* git(["add", "rules.md", "deferrals/def-001.md"]);
        yield* git([
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "-m",
          "Owner lands the edits",
        ]);
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect((yield* memory.query(orgA, { kind: "deferral" }))[0]?.title).toBe(
          "Invented service maintenance",
        );
        const next = yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readRules(orgA)).toBe("Uncommitted rules");
        expect(next.head).not.toBe(prepared.head);
        expect((yield* memory.prepareWakeup(orgA)).head).toBe(next.head);
        expect(
          messages.filter((message) => message.includes("Kin memory checkout skipped paths")),
        ).toHaveLength(2);
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe(
          "Modified service maintenance",
        );
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            memoryLayer(base, source),
            Logger.layer([Logger.make(({ message }) => messages.push(String(message)))], {
              mergeWithExisting: false,
            }),
          ),
        ),
      );
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
      const repository = fakeRepository(fs);
      const messages: string[] = [];
      const loggerLayer = Logger.layer(
        [Logger.make(({ message }) => messages.push(String(message)))],
        { mergeWithExisting: false },
      );
      const checkout = `${root}/a/memory-read`;
      yield* fs.makeDirectory(`${checkout}/deferrals`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/memory/.git/objects`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/memory/.git/refs`, { recursive: true });
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
        yield* memory.anchor(orgA, "main", repository.head());
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).not.toContain("## Due in 7 days");
        expect(yield* memory.readIndex(orgA)).toContain("As of 2026-11-14T00:00:00.000Z");
        expect(yield* memory.readIndex(orgA)).toContain("⚠ review");
        const counts = repository.counts();
        yield* memory.query(orgA, {});
        const reads =
          yield* sql`SELECT * FROM kin_memory_reads WHERE org_id = ${orgA} ORDER BY item_id`;
        yield* memory.readItemQuietly(orgA, itemId);
        expect(
          yield* sql`SELECT * FROM kin_memory_reads WHERE org_id = ${orgA} ORDER BY item_id`,
        ).toEqual(reads);
        yield* memory.readItem(orgA, itemId);
        expect(
          yield* sql`SELECT * FROM kin_memory_reads WHERE org_id = ${orgA} ORDER BY item_id`,
        ).toHaveLength(1);
        expect(repository.counts()).toEqual(counts);
        yield* TestClock.adjust("7 weeks");
        yield* memory.readItem(orgA, itemId);
        const moved = repository.files.get("deferrals/def-001.md");
        expect(moved).toBeDefined();
        repository.files.delete("deferrals/def-001.md");
        repository.files.set("deferrals/moved.md", moved ?? "");
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
        yield* memory.prepareWakeup(orgA);
        yield* TestClock.adjust("1 week");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        expect(yield* memory.readIndex(orgA)).not.toContain("Never opened fixture");
      });
      const layer = memoryTestLayer.pipe(
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
        expect(repository.counts().treeReads).toBe(beforeRebuild.treeReads + 2);
        expect(repository.counts().blobReads).toBe(beforeRebuild.blobReads);
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
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
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
          yield* memory.record(
            orgA,
            "main",
            yield* memory.anchor(orgA, "main"),
            repository.commit(),
          );
          const result = yield* memory.prepareWakeup(orgA);
          expect(DateTime.toEpochMillis(result.indexAsOf)).toBe(yield* Clock.currentTimeMillis);
        }
        repository.files.set(
          "deferrals/duplicate.md",
          fixtureItem({ recorded_at: "2027-02-27T00:00:00Z" }),
        );
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
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
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
        repository.corruptBatch();
        expect((yield* memory.prepareWakeup(orgA).pipe(Effect.result))._tag).toBe("Failure");
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

        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_trigger_settings SET time_zone = 'UTC' WHERE org_id = ${orgA}`;
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
        yield* memory.prepareWakeup(orgA);
        const utcIndex = yield* memory.readIndex(orgA);
        yield* Effect.gen(function* () {
          const cache = yield* MemoryCache.MemoryCache;
          for (const row of [
            { zone: "+05:30", expected: { _tag: "invalid" } },
            { zone: " Asia/Kolkata", expected: { _tag: "zone", zone: "Asia/Kolkata" } },
            { zone: "Asia/Kolkata", expected: { _tag: "zone", zone: "Asia/Kolkata" } },
            { zone: "Invented/Invalid", expected: { _tag: "invalid" } },
            { zone: null, expected: { _tag: "missing" } },
          ]) {
            if (row.zone === null)
              yield* sql`DELETE FROM kin_trigger_settings WHERE org_id = ${orgA}`;
            else
              yield* sql`UPDATE kin_trigger_settings SET time_zone = ${row.zone} WHERE org_id = ${orgA}`;
            expect(yield* cache.readOwnerTimeZone(orgA)).toEqual(row.expected);
            expect(yield* cache.readOwnerTimeZone(orgB)).toEqual({ _tag: "missing" });
            yield* memory.record(
              orgA,
              "main",
              yield* memory.anchor(orgA, "main"),
              repository.commit(),
            );
            yield* memory.prepareWakeup(orgA);
            if (row.expected._tag !== "zone") expect(yield* memory.readIndex(orgA)).toBe(utcIndex);
          }
          expect(
            messages.some((message) => message.includes("Invalid memory owner time zone")),
          ).toBe(true);
          yield* sql`DROP TABLE kin_trigger_settings`;
          expect(yield* cache.readOwnerTimeZone(orgA)).toEqual({ _tag: "unavailable" });
        }).pipe(Effect.provide(MemoryCache.layer));
        yield* sql`DROP TABLE kin_memory_reads`;
        yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), repository.commit());
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
        ).toHaveLength(4);
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
        memoryTestLayer.pipe(
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
          Layer.provide(fakeRepository(fs).layer),
        ),
      ),
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, databaseLayer)), Effect.scoped),
);

const helperScript = "!f() { echo password=fixture; }; f";
const sshInjection = "ssh -i /fixture/key; cat /etc/passwd";
it.effect.each([
  { env: {}, expected: {} },
  {
    env: {
      KIN_MEMORY_CREDENTIAL_HELPER: "/fixture/bin/git-credential-kin",
      KIN_MEMORY_SSH_COMMAND: "ssh -i /fixture/kin-memory-key -o IdentitiesOnly=yes",
    },
    expected: {
      credentialHelper: "/fixture/bin/git-credential-kin",
      sshCommand: "ssh -i /fixture/kin-memory-key -o IdentitiesOnly=yes",
    },
  },
  { env: { KIN_MEMORY_CREDENTIAL_HELPER: helperScript }, refused: helperScript },
  ...[
    sshInjection,
    "ssh -o ProxyCommand=/fixture/pwn.sh",
    "ssh -oLocalCommand=/x -o PermitLocalCommand=yes",
    "ssh -F /fixture/hostile-config",
    "ssh -o StrictHostKeyChecking=no",
    "sshpass -p fixture ssh",
    "/fixture/any-program",
  ].map((value) => ({ env: { KIN_MEMORY_SSH_COMMAND: value }, refused: value })),
])("derives production memory config from the server state directory and env %#", (row) =>
  Effect.gen(function* () {
    const server = yield* ServerConfig.ServerConfig;
    const result = yield* Effect.result(
      Layer.build(MemoryConfig.layer([{ orgId: orgA, repoUrl: "unused" }])).pipe(
        Effect.map((context) => Context.get(context, MemoryConfig.MemoryConfig)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(row.env))),
      ),
    );
    if (row.refused !== undefined) {
      assert(result._tag === "Failure");
      expect(result.failure._tag).toBe("MemoryCredentialConfigError");
      expect(result.failure.message).toContain(Object.keys(row.env)[0]);
      expect(result.failure.message).not.toContain(row.refused);
      return;
    }
    assert(result._tag === "Success");
    const config = result.success;
    expect(config.baseDirectory).toBe(`${server.stateDir}/kin`);
    expect(config.repositories[0]?.path).toBe(orgA);
    expect({
      credentialHelper: config.credentialHelper,
      sshCommand: config.sshCommand,
    }).toStrictEqual({ credentialHelper: undefined, sshCommand: undefined, ...row.expected });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "kin-memory-config-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
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

it.live(
  "materializes a large journal checkout in one blob read, staged on the state filesystem",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const { root, source, commit } = yield* fixtureRepository();
      const crossDevice = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        rename: (from: string, to: string) =>
          from.startsWith(`${root}/state/`) === to.startsWith(`${root}/state/`)
            ? fs.rename(from, to)
            : Effect.die(new Error(`EXDEV: rename ${from} -> ${to}`)),
      });
      yield* fs.makeDirectory(`${source}/journal/2026`, { recursive: true });
      for (let day = 0; day < 100; day++)
        yield* fs.writeFileString(`${source}/journal/2026/${day}.md`, `Invented entry ${day}\n`);
      yield* commit(source);
      let largestBatch = 0;
      const counted = Layer.succeed(
        VcsProcess.VcsProcess,
        VcsProcess.VcsProcess.of({
          run: (input) => {
            if (input.args.includes("--batch"))
              largestBatch = Math.max(largestBatch, input.stdin?.trim().split("\n").length ?? 0);
            return vcs.run(input);
          },
        }),
      );
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.prepareWakeup(orgA);
        const { read } = yield* memory.ensureCheckouts(orgA);
        expect(yield* fs.exists(`${read}/journal/2026/99.md`)).toBe(true);
      }).pipe(
        Effect.provide(
          memoryTestLayer.pipe(
            Layer.provide(configLayer(`${root}/state`, source)),
            Layer.provide(counted),
            Layer.provide(crossDevice),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
      expect(largestBatch).toBeGreaterThanOrEqual(100);
    }).pipe(
      Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
      Effect.scoped,
    ),
);

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
          memoryTestLayer.pipe(
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

it.live("ignores lead-controlled origin after service restart", () =>
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
      expect(result._tag).toBe("Success");
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
    yield* Effect.gen(function* () {
      const memory = yield* Memory.Memory;
      yield* memory.record(orgA, "main", yield* memory.anchor(orgA, "main"), head);
    }).pipe(Effect.provide(memoryLayer(base, source)));
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

it.live.each([
  "diverged",
  "secret merge",
  "scan failure merge",
  "remote secret merge",
  "large remote merge",
  "conflict",
  "network down",
  "dirty writer",
  "rebase in progress",
  "journal conflict",
  "H2-merge-swap",
  "unrelated",
  "criss-cross",
  "push retry",
])("syncs the writer with $0", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { root, source, git, commit } = yield* fixtureRepository();
    const base = `${root}/state`;
    const remote = `${root}/sync-remote.git`;
    const h2Base =
      "said_by: fixture-lead\ntrust: agent\n" +
      "unchanged fixture context\n".repeat(12) +
      "base tail\n";
    const h2Local = h2Base.replace("fixture-lead", "local-lead");
    if (scenario === "H2-merge-swap") {
      yield* fs.writeFileString(`${source}/rules.md`, h2Base);
      yield* commit(source);
    }
    yield* git(root, ["clone", "--bare", "--", source, remote]);
    const vcs = yield* VcsProcess.VcsProcess;
    let attack: { sha: string; path: string } | undefined;
    let swapped = false;
    const intercepted = Layer.succeed(
      VcsProcess.VcsProcess,
      VcsProcess.VcsProcess.of({
        run: Effect.fn("MemoryTest.mergeSwap")(function* (input) {
          if (
            attack &&
            (input.args.includes("merge-tree") ||
              (input.args.includes("--batch") && input.stdin?.includes(attack.sha)))
          ) {
            const forged = Buffer.from(
              h2Local.replace("local-lead", "real-owner").replace("trust: agent", "trust: owner"),
            );
            yield* fs.remove(attack.path).pipe(Effect.orDie);
            yield* fs
              .writeFile(
                attack.path,
                NodeZlib.deflateSync(
                  Buffer.concat([Buffer.from(`blob ${forged.length}\0`), forged]),
                ),
              )
              .pipe(Effect.orDie);
            attack = undefined;
            swapped = true;
          }
          return yield* vcs.run(input);
        }),
      }),
    );
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
      if (scenario === "journal conflict" || scenario === "push retry") {
        yield* fs.makeDirectory(`${writer}/journal`, { recursive: true });
        yield* fs.makeDirectory(`${source}/journal`, { recursive: true });
        yield* fs.writeFileString(`${writer}/journal/day.md`, "local entry\n");
        yield* fs.writeFileString(`${writer}/INDEX.md`, "local generated index\n");
      } else
        yield* fs.writeFileString(
          `${writer}/rules.md`,
          scenario === "H2-merge-swap"
            ? h2Local
            : scenario === "secret merge"
              ? ["gh", "p_", "a".repeat(36)].join("")
              : "Local invented rules\n",
        );
      let local = yield* commit(writer);
      if (scenario === "push retry") {
        yield* git(writer, [
          "commit",
          "--allow-empty",
          "-m",
          "Earlier journal outcome\n\nEvents: fixture-earlier",
        ]);
        yield* git(writer, [
          "commit",
          "--allow-empty",
          "-m",
          "Later journal outcome\n\nEvents: fixture-later",
        ]);
        local = yield* git(writer, ["rev-parse", "HEAD"]);
      }
      yield* memory.record(orgA, "main", initial.head, local);
      yield* fs.writeFileString(
        `${source}/${scenario === "push retry" || scenario === "diverged" || scenario === "scan failure merge" || scenario === "secret merge" || scenario === "remote secret merge" || scenario === "large remote merge" || scenario === "network down" || scenario === "dirty writer" || scenario === "H2-merge-swap" ? "remote-only" : "rules.md"}`,
        "Remote invented edit\n",
      );
      if (scenario === "journal conflict" || scenario === "push retry") {
        yield* fs.writeFileString(`${source}/journal/day.md`, "remote entry\n");
        yield* fs.writeFileString(`${source}/INDEX.md`, "remote generated index\n");
      }
      if (scenario === "remote secret merge")
        yield* fs.writeFileString(`${source}/remote-only`, ["gh", "p_", "a".repeat(36)].join(""));
      if (scenario === "large remote merge") {
        yield* fs.makeDirectory(`${source}/archive`);
        for (let i = 0; i < 1030; i++)
          yield* fs.writeFileString(`${source}/archive/${i}.txt`, "clean");
      }
      if (scenario === "H2-merge-swap")
        yield* fs.writeFileString(`${source}/rules.md`, h2Base.replace("base tail", "remote tail"));
      yield* commit(source);
      yield* git(source, ["push", "--", remote, "main"]);
      if (scenario === "network down") yield* fs.rename(remote, `${root}/offline`);
      if (scenario === "dirty writer")
        yield* fs.writeFileString(`${writer}/rules.md`, "Uncommitted fixture edit\n");
      if (scenario === "rebase in progress") {
        yield* git(writer, ["fetch", "origin"]);
        yield* git(writer, ["rebase", "@{u}"]).pipe(Effect.ignore);
        yield* fs.writeFileString(`${writer}/rules.md`, "Half-resolved fixture edit\n");
      }
      if (scenario === "H2-merge-swap") {
        const sha = yield* git(writer, ["rev-parse", `${local}:rules.md`]);
        attack = { sha, path: `${writer}/.git/objects/${sha.slice(0, 2)}/${sha.slice(2)}` };
      }
      if (scenario === "unrelated" || scenario === "criss-cross") {
        yield* git(writer, ["fetch", "--", remote, "main"]);
        const remoteHead = yield* git(source, ["rev-parse", "HEAD"]);
        const tree = yield* git(writer, ["rev-parse", `${local}^{tree}`]);
        const parents = scenario === "criss-cross" ? ["-p", local, "-p", remoteHead] : [];
        const replacement = yield* git(writer, [
          "commit-tree",
          tree,
          ...parents,
          "-m",
          "invented local merge",
        ]);
        if (scenario === "criss-cross") {
          const other = yield* git(writer, [
            "commit-tree",
            tree,
            "-p",
            remoteHead,
            "-p",
            local,
            "-m",
            "invented remote merge",
          ]);
          yield* git(writer, ["push", "--", remote, `${other}:refs/heads/main`]);
        }
        yield* git(writer, ["update-ref", "refs/heads/main", replacement, local]);
        yield* memory.record(orgA, "main", local, replacement);
        local = replacement;
      }
      if (scenario === "scan failure merge") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE kin_secret_allow`;
      }
      const result = yield* memory.prepareWakeup(orgA, "fixture-wakeup").pipe(Effect.result);
      if (scenario === "unrelated" || scenario === "criss-cross") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemorySyncConflict");
        expect(yield* git(writer, ["rev-parse", "refs/heads/main"])).toBe(local);
        expect(
          yield* git(root, [
            `--git-dir=${remote}`,
            "for-each-ref",
            "--format=%(objectname)",
            `refs/heads/kin/conflict/${orgA}/fixture-wakeup-*`,
          ]),
        ).toBe(local);
        expect(
          messages.some(
            (message) =>
              message.includes("No unique verified merge base") &&
              message.includes("fixture-wakeup"),
          ),
        ).toBe(true);
        const again = yield* memory.prepareWakeup(orgA, "fixture-wakeup-2").pipe(Effect.result);
        expect(again._tag).toBe("Failure");
        expect(
          yield* git(root, [
            `--git-dir=${remote}`,
            "for-each-ref",
            "--format=%(objectname)",
            `refs/heads/kin/conflict/${orgA}/`,
          ]),
        ).toBe(local);
        yield* memory.recover(orgA);
        expect(
          (yield* memory.prepareWakeup(orgA, "fixture-wakeup-3").pipe(Effect.result))._tag,
        ).toBe("Success");
      } else if (scenario === "scan failure merge") {
        expect(result._tag).toBe("Failure");
        expect(
          messages.some((message) => message.includes("Secret scan failed: Allowlist unavailable")),
        ).toBe(true);
        expect(yield* memory.anchor(orgA, "main")).toBe(local);
      } else if (scenario === "secret merge") {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure._tag).toBe("MemoryError");
          expect(result.failure.operation).toBe("secretScan");
        }
        expect(yield* memory.anchor(orgA, "main")).toBe(local);
        expect(yield* git(root, [`--git-dir=${remote}`, "rev-parse", "main"])).toBe(
          yield* git(source, ["rev-parse", "HEAD"]),
        );
      } else if (scenario === "push retry") {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success") {
          const merged = result.success.head;
          expect((yield* git(writer, ["show", "-s", "--format=%P", merged])).split(" ")).toContain(
            local,
          );
          const messages = yield* git(writer, ["log", "--format=%B", merged]);
          expect(messages).toContain("Events: fixture-earlier");
          expect(messages).toContain("Events: fixture-later");
          const journalBefore = yield* git(writer, ["show", `${merged}:journal/day.md`]);
          yield* git(writer, ["update-ref", "refs/heads/main", local, merged]);
          yield* memory.record(orgA, "main", merged, local);
          expect((yield* memory.prepareWakeup(orgA)).head).toBe(merged);
          expect(yield* git(writer, ["show", `${merged}:journal/day.md`])).toBe(journalBefore);
        }
      } else if (scenario === "H2-merge-swap") {
        expect(swapped).toBe(true);
        expect(result._tag).toBe("Failure");
        expect(yield* git(root, [`--git-dir=${remote}`, "show", "main:rules.md"])).not.toContain(
          "FORGED",
        );
      } else if (
        scenario === "network down" ||
        scenario === "diverged" ||
        scenario === "remote secret merge" ||
        scenario === "large remote merge" ||
        scenario === "dirty writer"
      ) {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success") {
          if (scenario === "network down") expect(result.success.head).toBe(local);
          else {
            expect(result.success.head).not.toBe(local);
            expect(yield* memory.readRules(orgA)).toBe("Local invented rules\n");
            expect(yield* git(writer, ["show", `${result.success.head}:remote-only`])).toBe(
              scenario === "remote secret merge"
                ? ["gh", "p_", "a".repeat(36)].join("")
                : "Remote invented edit",
            );
          }
        }
      } else if (scenario === "journal conflict" || scenario === "push retry") {
        expect(result._tag).toBe("Success");
        if (result._tag === "Success")
          expect(yield* git(writer, ["show", `${result.success.head}:journal/day.md`])).toBe(
            "remote entry\nlocal entry",
          );
      } else if (scenario === "conflict") {
        expect(result._tag).toBe("Success");
        const backup = (yield* git(root, [
          `--git-dir=${remote}`,
          "for-each-ref",
          "--format=%(objectname)",
          `refs/heads/kin/conflict/${orgA}/`,
        ])).trim();
        expect(backup).toBe(local);
        expect((yield* memory.prepareWakeup(orgA)).head).toBe(
          yield* git(source, ["rev-parse", "HEAD"]),
        );
      } else {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure._tag).toBe("MemoryCheckoutInvalid");
      }
      if (scenario === "rebase in progress" || scenario === "network down")
        expect(yield* git(writer, ["rev-parse", "refs/heads/main"])).toBe(local);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Memory.layer.pipe(
            Layer.provide(configLayer(base, remote)),
            Layer.provide(intercepted),
            Layer.provide(
              Layer.succeed(Memory.MemoryRecoveryHooks, {
                notify: (notice) =>
                  Effect.sync(() => {
                    messages.push(JSON.stringify(notice));
                  }),
              }),
            ),
          ),
          logger,
        ),
      ),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(gitLayer, NodeServices.layer, databaseLayer)),
    Effect.scoped,
  ),
);
