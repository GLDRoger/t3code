import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KinMemoryItemId, KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as Memory from "./Memory.ts";
import { MemoryConfig } from "./MemoryConfig.ts";
import { fixtureItem } from "./__fixtures__/items.ts";

const orgA = KinOrgId.make("demo-a");
const orgB = KinOrgId.make("demo-b");
const itemId = KinMemoryItemId.make("def-001");
const gitLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const fakeGit = Layer.succeed(
  VcsProcess.VcsProcess,
  VcsProcess.VcsProcess.of({
    run: Effect.fn("Test.git")(() =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "fixture-head",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ),
  }),
);
const configLayer = (baseDirectory: string, repoUrl: string) =>
  Layer.succeed(MemoryConfig, {
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
  "clones isolated checkouts, skips bad items, queries dates and refreshes on HEAD or mtime",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const vcs = yield* VcsProcess.VcsProcess;
      const root = yield* fs.makeTempDirectoryScoped();
      const source = `${root}/source`;
      yield* fs.copy(`${import.meta.dirname}/__fixtures__/memory`, source);
      const git = Effect.fn("Test.fixtureGit")((args: ReadonlyArray<string>) =>
        vcs.run({ operation: "test.memory", command: "git", cwd: source, args }),
      );
      yield* git(["init", "--initial-branch=main"]);
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
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        const a = yield* memory.ensureCheckouts(orgA);
        const b = yield* memory.ensureCheckouts(orgB);
        expect(a.read).not.toBe(b.read);
        const prepared = yield* memory.prepareWakeup(orgA);
        expect(prepared.head).toMatch(/^[0-9a-f]{40}$/);
        expect(yield* memory.readRules(orgA)).toBe("Invented standing rules.\n");
        expect(yield* memory.readIndex(orgA)).toMatch(/^As of /);
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
        expect((yield* memory.readItem(orgA, itemId)).body).toContain("Invented fixture body");
        expect((yield* memory.query(orgA, {}))[0]?.invalid_at).toBe("2026-11-02");
        yield* fs.writeFileString(
          `${a.read}/deferrals/def-001.md`,
          fixtureItem({ title: "Modified service maintenance" }),
        );
        yield* fs.utimes(`${a.read}/deferrals/def-001.md`, 1_800_000_000, 1_800_000_000);
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe(
          "Modified service maintenance",
        );
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
        yield* fs.writeFileString(
          `${source}/deferrals/def-001.md`,
          fixtureItem({ title: "New committed fixture" }),
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
        expect((yield* memory.readItem(orgA, itemId)).head.title).toBe("New committed fixture");
        expect((yield* memory.readItem(orgB, itemId)).head.title).toBe(
          "Invented service maintenance",
        );
      }).pipe(Effect.provide(memoryLayer(base, source)));
    }).pipe(Effect.provide(Layer.merge(gitLayer, NodeServices.layer)), Effect.scoped),
);

it.effect(
  "caps the index, stamps As of, flags overdue and fades at eight weeks without hiding search results",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-14T00:00:00.000Z"));
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const checkout = `${root}/a/memory-read`;
      yield* fs.makeDirectory(`${checkout}/deferrals`, { recursive: true });
      yield* fs.writeFileString(
        `${checkout}/deferrals/def-001.md`,
        fixtureItem({ recorded_at: "2026-11-14T00:00:00.000Z" }),
      );
      yield* fs.writeFileString(
        `${checkout}/deferrals/unread.md`,
        fixtureItem({
          id: "unread",
          title: "Never opened fixture",
          recorded_at: "2026-11-14T00:00:00.000Z",
        }),
      );
      const program = Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("As of 2026-11-14T00:00:00.000Z");
        expect(yield* memory.readIndex(orgA)).toContain("⚠ review");
        yield* TestClock.adjust("7 weeks");
        yield* memory.readItem(orgA, itemId);
        yield* TestClock.adjust("1 week");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        expect(yield* memory.readIndex(orgA)).not.toContain("Never opened fixture");
      });
      const layer = Memory.layer.pipe(
        Layer.provide(configLayer(root, "unused")),
        Layer.provide(fakeGit),
        Layer.provide(NodeServices.layer),
      );
      yield* program.pipe(Effect.provide(layer));
      // A fresh service instance must retain the read timestamp outside the git checkout.
      yield* Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        yield* TestClock.adjust("7 weeks");
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).not.toContain("Invented service maintenance");
        expect(yield* memory.query(orgA, {})).toHaveLength(2);
        yield* memory.readItem(orgA, itemId);
        yield* memory.rebuildIndex(orgA);
        expect(yield* memory.readIndex(orgA)).toContain("Invented service maintenance");
        for (let n = 0; n < 205; n++) {
          yield* fs.writeFileString(
            `${checkout}/deferrals/extra-${n}.md`,
            fixtureItem({
              id: `extra-${n}`,
              recorded_at: "2027-02-27T00:00:00.000Z",
              title: "Multiline\nfixture",
            }),
          );
        }
        yield* memory.rebuildIndex(orgA);
        expect((yield* memory.readIndex(orgA)).trimEnd().split("\n")).toHaveLength(200);
        const before = yield* memory.readIndex(orgA);
        yield* TestClock.adjust("35 hours");
        yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).toBe(before);
        yield* TestClock.adjust("1 hour");
        const refreshed = yield* memory.prepareWakeup(orgA);
        expect(yield* memory.readIndex(orgA)).not.toBe(before);
        expect(refreshed.indexAsOf).toBeDefined();
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
