import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import {
  ArchivistKeeper,
  KeeperSource,
  KeeperSummarizer,
  layer,
  runDaemon,
  type SummarizeInput,
} from "./archivist.ts";
import {
  archivistScope,
  memoryKeeperScope,
  readChronicle,
  type KeeperEntry,
  type KeeperModelConfig,
  type KeeperScope,
} from "./chronicle.ts";

const T0 = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T12:00:00.000Z"));
const HOUR = 60 * 60 * 1000;
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const entry = (
  id: string,
  kind: KeeperEntry["kind"],
  at: number,
  body = `body ${id}`,
): KeeperEntry => ({ id, kind, at: iso(at), body });

const wills = (count: number, at: number, prefix: string) =>
  Array.from({ length: count }, (_, index) =>
    entry(`${prefix}${index}`, "will", at - index, `raw ${prefix}${index}`),
  );

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const keeperFor = (ref: Ref.Ref<readonly KeeperEntry[]>, calls: SummarizeInput[]) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        KeeperSource,
        KeeperSource.of({
          entries: () => Ref.get(ref),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        KeeperSummarizer,
        KeeperSummarizer.of({
          summarize: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return input.entries.map((item) => item.id).join(",");
            }),
        }),
      ),
    ),
    Layer.provide(platform),
  );

const withKeeper = <A, E, R>(
  initial: readonly KeeperEntry[],
  use: (input: {
    readonly root: string;
    readonly ref: Ref.Ref<readonly KeeperEntry[]>;
    readonly calls: SummarizeInput[];
    readonly keeper: ArchivistKeeper["Service"];
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-keeper-" });
    const ref = yield* Ref.make(initial);
    const calls: SummarizeInput[] = [];
    const keeper = yield* ArchivistKeeper.pipe(Effect.provide(keeperFor(ref, calls)));
    return yield* use({ root, ref, calls, keeper, fs, path });
  }).pipe(Effect.provide(platform));

const chronicleText = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  relative = ".kin/chronicle.md",
) => fs.readFileString(path.join(root, relative));

describe("ArchivistKeeper", () => {
  it.effect("writes a fresh chronicle once 8 wills have piled up", () =>
    withKeeper(wills(8, T0 - HOUR, "w"), ({ root, calls, keeper, fs, path }) =>
      Effect.gen(function* () {
        const result = yield* keeper.tick({
          scope: archivistScope("proj"),
          projectRoot: root,
          nowMillis: T0,
        });
        const text = yield* chronicleText(fs, path, root);
        expect(result.ran).toBe(true);
        if (result.ran) {
          expect(result.asOf).toBe(iso(T0));
          expect(result.rebuilt).toBe(false);
          expect(result.sessionReused).toBe(false);
        }
        expect(text.startsWith(`As of ${iso(T0)}\n`)).toBe(true);
        expect(readChronicle(text, DateTime.makeUnsafe(T0)).status).toBe("fresh");
        expect(calls[0]?.model).toEqual(archivistScope("proj").model);
        expect(calls[0]?.entries.map((item) => item.id)).toEqual([
          "w7",
          "w6",
          "w5",
          "w4",
          "w3",
          "w2",
          "w1",
          "w0",
        ]);
        expect(text).not.toContain("## Wills since");
      }),
    ),
  );

  it.effect("stays quiet under the gate and leaves an existing chronicle byte-stable", () =>
    withKeeper(wills(7, T0 - HOUR, "w"), ({ root, ref, calls, keeper, fs, path }) =>
      Effect.gen(function* () {
        const skipped = yield* keeper.tick({
          scope: archivistScope("proj"),
          projectRoot: root,
          nowMillis: T0,
        });
        expect(skipped).toMatchObject({ ran: false, reason: "below-threshold", newWills: 7 });
        expect(yield* fs.exists(path.join(root, ".kin", "chronicle.md"))).toBe(false);
        expect(calls).toHaveLength(0);

        yield* Ref.set(
          ref,
          wills(30, T0 - HOUR, "n").map((item, index) => ({
            ...item,
            kind: "note" as const,
            id: `n${index}`,
          })),
        );
        const wrote = yield* keeper.tick({
          scope: archivistScope("proj"),
          projectRoot: root,
          nowMillis: T0,
        });
        expect(wrote.ran).toBe(true);
        const text = yield* chronicleText(fs, path, root);
        const again = yield* keeper.tick({
          scope: archivistScope("proj"),
          projectRoot: root,
          nowMillis: T0,
        });
        expect(again).toMatchObject({ ran: false, newNotes: 0, newWills: 0 });
        expect(yield* chronicleText(fs, path, root)).toBe(text);
        expect(calls).toHaveLength(1);
      }),
    ),
  );

  it.effect("summarizes the raw corpus, reuses the session, and rebuilds on the 4th pass", () =>
    withKeeper([], ({ root, ref, calls, keeper }) =>
      Effect.gen(function* () {
        const model: KeeperModelConfig = {
          provider: "codex",
          model: "small-cheap",
          reuseSession: true,
        };
        const scope = archivistScope("proj", model);
        let firstSession = "";
        for (let pass = 1; pass <= 4; pass++) {
          const at = T0 + (pass - 1) * HOUR;
          yield* Ref.update(ref, (current) => [...current, ...wills(8, at - 60_000, `p${pass}-`)]);
          const result = yield* keeper.tick({ scope, projectRoot: root, nowMillis: at });
          expect(result.ran).toBe(true);
          if (!result.ran) continue;
          expect(result.pass).toBe(pass);
          expect(result.rebuilt).toBe(pass === 4);
          if (pass === 1) firstSession = result.sessionId;
          if (pass === 2 || pass === 3) {
            expect(result.sessionReused).toBe(true);
            expect(result.sessionId).toBe(firstSession);
          }
          if (pass === 4) {
            expect(result.sessionReused).toBe(false);
            expect(result.sessionId).not.toBe(firstSession);
          }
        }
        const planted = "SENTINEL-CHRONICLE-BODY";
        expect(JSON.stringify(calls)).not.toContain(planted);
        expect(calls[3]?.rebuilt).toBe(true);
        expect(calls[3]?.entries.some((item) => item.id === "p1-0")).toBe(true);
        expect(calls[3]?.model).toEqual(model);
        for (const call of calls) {
          expect(call.entries.every((item) => item.kind === "will")).toBe(true);
        }
      }),
    ),
  );

  it.effect("does not feed the previous chronicle back into the summarizer", () =>
    withKeeper(wills(8, T0 - HOUR, "w"), ({ root, ref, calls, keeper, fs, path }) =>
      Effect.gen(function* () {
        const scope = archivistScope("proj");
        yield* keeper.tick({ scope, projectRoot: root, nowMillis: T0 });
        const chroniclePath = path.join(root, ".kin", "chronicle.md");
        const planted = "SENTINEL-CHRONICLE-BODY";
        yield* fs.writeFileString(
          chroniclePath,
          `${yield* fs.readFileString(chroniclePath)}${planted}\n`,
        );
        yield* Ref.update(ref, (current) => [...current, ...wills(8, T0 + 60_000, "n")]);
        yield* keeper.tick({ scope, projectRoot: root, nowMillis: T0 + HOUR });
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls[1])).not.toContain(planted);
        expect(calls[1]?.entries.some((item) => item.id === "w0")).toBe(true);
        expect(calls[1]?.sessionReused).toBe(true);
      }),
    ),
  );

  it.effect("mints a new session when the provider cannot keep one", () =>
    withKeeper([], ({ root, ref, keeper }) =>
      Effect.gen(function* () {
        const scope: KeeperScope = archivistScope("proj", {
          provider: "http",
          model: "cheap",
          reuseSession: true,
        });
        const sessions: string[] = [];
        for (let pass = 1; pass <= 2; pass++) {
          const at = T0 + (pass - 1) * HOUR;
          yield* Ref.update(ref, (current) => [...current, ...wills(8, at - 60_000, `h${pass}-`)]);
          const result = yield* keeper.tick({ scope, projectRoot: root, nowMillis: at });
          if (result.ran) sessions.push(result.sessionId);
          expect(result.ran && result.sessionReused).toBe(false);
        }
        expect(sessions[0]).not.toBe(sessions[1]);
      }),
    ),
  );

  it.effect("runs the same pass for a life-scoped memory keeper", () =>
    withKeeper(
      Array.from({ length: 30 }, (_, index) => entry(`d${index}`, "day", T0 - HOUR, "a day")),
      ({ root, keeper, fs, path }) =>
        Effect.gen(function* () {
          const result = yield* keeper.tick({
            scope: memoryKeeperScope("nishchay"),
            projectRoot: root,
            nowMillis: T0,
          });
          expect(result.ran).toBe(true);
          const text = yield* chronicleText(fs, path, root, ".kin/life-chronicle.md");
          expect(text.startsWith(`As of ${iso(T0)}\n`)).toBe(true);
          expect(readChronicle(text, DateTime.makeUnsafe(T0)).status).toBe("fresh");
        }),
    ),
  );

  it.effect("rejects a chronicle path that escapes the project root", () =>
    withKeeper(wills(8, T0 - HOUR, "w"), ({ root, keeper }) =>
      Effect.gen(function* () {
        const scope = archivistScope("proj");
        const escaped: KeeperScope = {
          ...scope,
          output: { ...scope.output, path: "../escape.md" },
        };
        const error = yield* keeper
          .tick({ scope: escaped, projectRoot: root, nowMillis: T0 })
          .pipe(Effect.flip);
        expect(error._tag).toBe("KeeperPathError");
      }),
    ),
  );

  it.effect("fails closed when the state file cannot be read", () =>
    withKeeper(wills(8, T0 - HOUR, "w"), ({ root, keeper, fs, path }) =>
      Effect.gen(function* () {
        const statePath = path.join(root, ".kin", "keeper", "repo_proj.state.json");
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        yield* fs.writeFileString(statePath, "{");
        const error = yield* keeper
          .tick({ scope: archivistScope("proj"), projectRoot: root, nowMillis: T0 })
          .pipe(Effect.flip);
        expect(error._tag).toBe("KeeperStateError");
      }),
    ),
  );

  it.effect("runDaemon fires the gate and leaves a fresh chronicle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "kin-keeper-" });
      const ref = yield* Ref.make<readonly KeeperEntry[]>(wills(8, T0 - HOUR, "d"));
      const calls: SummarizeInput[] = [];
      const fiber = yield* runDaemon({
        scope: archivistScope("proj"),
        projectRoot: root,
        repeats: 0,
      }).pipe(
        Effect.provide(keeperFor(ref, calls)),
        Effect.provideService(Clock.Clock, fixedClock(T0)),
      );
      yield* Fiber.join(fiber);
      const text = yield* fs.readFileString(path.join(root, ".kin", "chronicle.md"));
      expect(calls).toHaveLength(1);
      expect(text.startsWith(`As of ${iso(T0)}\n`)).toBe(true);
      expect(readChronicle(text, DateTime.makeUnsafe(T0)).status).toBe("fresh");
    }).pipe(Effect.provide(platform)),
  );
});

const fixedClock = (millis: number): Clock.Clock => ({
  currentTimeMillis: Effect.succeed(millis),
  currentTimeMillisUnsafe: () => millis,
  currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(0n),
  monotonicTimeNanosUnsafe: () => 0n,
  sleep: () => Effect.void,
});
