import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { KIN_VISUAL_FONTS } from "@t3tools/shared/kinVisual";

import {
  KinToolchain,
  layer,
  PINNED_FONT_FILES,
  tarProblem,
  toolDirectories,
} from "./toolchain.ts";

const LINUX_X64 = "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c";
const MiB = 1024 * 1024;

const archiveRoot = "typst-x86_64-unknown-linux-musl";
const version = "0.15.1";
const downloadHashes = [
  LINUX_X64,
  "7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba",
  "983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c",
  "2958e4af564507df2a856164df6f9978dacb03f999a4f34a0c269dc8a4de9688",
  "7d22891cd57507b04af95a67ffaf59b7073b3595a27d1cfbbcefb418de820a12",
];

const fakeDownloads = (http: HttpClient.HttpClient, activation: Effect.Effect<void>) => {
  const digest = Layer.effect(
    Digest.Digest,
    Effect.map(Digest.Digest, (real) =>
      Digest.Digest.of({
        ...real,
        digest: (algorithm, bytes) => {
          const pin = bytes.length === 1 ? downloadHashes[bytes[0]!] : undefined;
          return pin === undefined
            ? real.digest(algorithm, bytes)
            : Effect.succeed(Buffer.from(pin, "hex"));
        },
      }),
    ),
  ).pipe(Layer.provide(NodeCrypto.layer));
  const runner = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ProcessRunner.ProcessRunner.of({
        run: ({ args }) =>
          Effect.gen(function* () {
            let stdout = "";
            switch (args[0]) {
              case "-tJf":
                stdout = `${archiveRoot}/typst`;
                break;
              case "-tvJf":
                stdout = `-rwxr-xr-x 0/0 1 2026-01-01 00:00 ${archiveRoot}/typst`;
                break;
              case "-xJf": {
                const unpacked = `${args[3]}/${archiveRoot}`;
                yield* fs.makeDirectory(unpacked);
                yield* fs.writeFileString(`${unpacked}/typst`, "fixture Typst program");
                break;
              }
              default:
                assert.deepStrictEqual(args, ["--version"]);
                stdout = `typst ${version}`;
            }
            return {
              stdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });
    }),
  );
  return layer.pipe(
    Layer.provide(Layer.succeed(ServerActivation, activation)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(runner),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-tools-warm-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, digest)),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provide(Layer.succeed(HostProcess.Architecture, "x64")),
  );
};

it.effect("parks warm-up until activation and shares downloads with concurrent saves", () => {
  const activate = Deferred.makeUnsafe<void>();
  const parked = Deferred.makeUnsafe<void>();
  const typstStarted = Deferred.makeUnsafe<void>();
  const releaseTypst = Deferred.makeUnsafe<void>();
  const fontsStarted = Deferred.makeUnsafe<void>();
  const releaseFonts = Deferred.makeUnsafe<void>();
  const requests: Array<string> = [];
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const file = new URL(request.url).pathname.split("/").at(-1)!;
      requests.push(file);
      const font = PINNED_FONT_FILES.indexOf(file);
      if (font === -1) {
        yield* Deferred.succeed(typstStarted, undefined);
        yield* Deferred.await(releaseTypst);
      } else if (font === PINNED_FONT_FILES.length - 1) {
        yield* Deferred.succeed(fontsStarted, undefined);
        yield* Deferred.await(releaseFonts);
      }
      return HttpClientResponse.fromWeb(request, new Response(new Uint8Array([font + 1])));
    }),
  );
  return Effect.gen(function* () {
    const toolchain = yield* KinToolchain;
    const fs = yield* FileSystem.FileSystem;
    const [directory] = toolDirectories((yield* ServerConfig).baseDir);
    yield* Deferred.await(parked);
    assert.isEmpty(requests);
    yield* Deferred.succeed(activate, undefined);
    yield* Deferred.await(typstStarted);
    const first = yield* Effect.forkChild(toolchain.ensure(), { startImmediately: true });
    const second = yield* Effect.forkChild(toolchain.ensure(), { startImmediately: true });
    assert.isUndefined(first.pollUnsafe());
    assert.isUndefined(second.pollUnsafe());
    yield* Deferred.succeed(releaseTypst, undefined);
    yield* Deferred.await(fontsStarted);
    const fonts = yield* Effect.forkChild(toolchain.fonts(), { startImmediately: true });
    assert.isUndefined(fonts.pollUnsafe());
    yield* Deferred.succeed(releaseFonts, undefined);
    const binary = `${directory}/typst`;
    assert.deepStrictEqual(yield* Fiber.joinAll([first, second]), [binary, binary]);
    const fontsDir = yield* Fiber.join(fonts);
    assert.isDefined(fontsDir);
    assert.sameMembers(yield* fs.readDirectory(fontsDir!), [...PINNED_FONT_FILES]);
    assert.strictEqual(yield* toolchain.ensure(), binary);
    assert.deepStrictEqual(requests, [`${archiveRoot}.tar.xz`, ...PINNED_FONT_FILES]);
  }).pipe(
    Effect.provide(
      fakeDownloads(
        http,
        Deferred.succeed(parked, undefined).pipe(Effect.andThen(Deferred.await(activate))),
      ),
    ),
  );
});

it.effect.each(["Typst", "fonts"] as const)(
  "logs a failed %s warm-up once and retries it on the first save",
  (failedTool) => {
    const warmed = Deferred.makeUnsafe<void>();
    const warnings: Array<unknown> = [];
    const requests: Array<string> = [];
    const failedFile = failedTool === "Typst" ? `${archiveRoot}.tar.xz` : PINNED_FONT_FILES[0]!;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const file = new URL(request.url).pathname.split("/").at(-1)!;
        const fail = file === failedFile && !requests.includes(file);
        requests.push(file);
        const response = fail
          ? new Response(null, { status: 503 })
          : new Response(new Uint8Array([PINNED_FONT_FILES.indexOf(file) + 1]));
        return HttpClientResponse.fromWeb(request, response);
      }),
    );
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") {
        warnings.push(message);
        Deferred.doneUnsafe(warmed, Effect.void);
      }
    });
    return Effect.gen(function* () {
      const toolchain = yield* KinToolchain;
      const [directory] = toolDirectories((yield* ServerConfig).baseDir);
      yield* Deferred.await(warmed);
      assert.lengthOf(warnings, 1);
      assert.strictEqual(requests.at(-1), failedFile);
      assert.strictEqual(yield* toolchain.ensure(), `${directory}/typst`);
      assert.isDefined(yield* toolchain.fonts());
      const expected = [`${archiveRoot}.tar.xz`, ...PINNED_FONT_FILES];
      expected.splice(expected.indexOf(failedFile), 0, failedFile);
      assert.deepStrictEqual(requests, expected);
      assert.lengthOf(warnings, 1);
    }).pipe(
      Effect.provide(
        fakeDownloads(http, Effect.void).pipe(
          Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
        ),
      ),
    );
  },
);

it.effect("re-checks the installed Typst, and stops a download as it passes the cap", () => {
  let requests = 0;
  let sent = 0;
  let hashes = 0;
  const counted = Layer.effect(
    Digest.Digest,
    Effect.map(Digest.Digest, (real) =>
      Digest.Digest.of({
        ...real,
        digest: (algorithm, bytes) => {
          hashes += 1;
          return real.digest(algorithm, bytes);
        },
      }),
    ),
  ).pipe(Layer.provide(NodeCrypto.layer));
  // An endless body with no length: only counting bytes as they arrive stops it.
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests += 1;
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          sent += MiB;
          controller.enqueue(new Uint8Array(MiB));
        },
      });
      return HttpClientResponse.fromWeb(request, new Response(body, { status: 200 }));
    }),
  );
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const [directory] = toolDirectories((yield* ServerConfig).baseDir);
    // A stamp that names the pinned release, beside a program that isn't the one it was made from.
    yield* fs.makeDirectory(directory!, { recursive: true });
    const program = "#!/bin/sh\necho typst 0\n";
    yield* fs.writeFileString(`${directory!}/typst`, program);
    const programSum = "94664bcae2b687b4c3da4d0eeb4a4d944e1236127c10b8750485da6eb99483ef";
    yield* fs.writeFileString(`${directory!}/.sha256`, `${LINUX_X64}\n${programSum}\n`);
    const toolchain = yield* KinToolchain;
    // Hashed once, then trusted while the file is unchanged.
    yield* toolchain.ensure();
    yield* toolchain.ensure();
    assert.deepStrictEqual({ requests, hashes }, { requests: 0, hashes: 1 });
    yield* fs.writeFileString(`${directory!}/typst`, "#!/bin/sh\necho tampered\n");
    const failed = yield* toolchain.ensure().pipe(Effect.flip);
    assert.strictEqual(requests, 1);
    assert.strictEqual(failed.message, "Typst's download was larger than expected.");
    assert.isAtMost(sent, 66 * MiB);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-tools-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, counted)),
        Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provideMerge(Layer.succeed(HostProcess.Architecture, "x64")),
      ),
    ),
  );
});

it.effect("gives up on fonts that hang, and remembers a failed fetch for a while", () => {
  let requests = 0;
  const asked = Deferred.makeUnsafe<void>();
  // The first request never answers; the rest fail at once.
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      requests += 1;
      return requests === 1
        ? Deferred.succeed(asked, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })));
    }),
  );
  return Effect.gen(function* () {
    const toolchain = yield* KinToolchain;
    const hanging = yield* Effect.forkChild(toolchain.fonts());
    yield* Deferred.await(asked);
    yield* TestClock.adjust("2 minutes");
    assert.isUndefined(yield* Fiber.join(hanging));
    // Within the pause after a failure, a render doesn't ask again.
    assert.isUndefined(yield* toolchain.fonts());
    assert.strictEqual(requests, 1);
    yield* TestClock.adjust("15 minutes");
    assert.isUndefined(yield* toolchain.fonts());
    assert.isUndefined(yield* toolchain.fonts());
    assert.strictEqual(requests, 2);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-fonts-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );
});

it("trusts a Typst archive only when every member is a plain file or folder in its own folder", () => {
  const root = "typst-x86_64-unknown-linux-musl";
  const ok = [`${root}/`, `${root}/typst`, `${root}/LICENSE`];
  const verbose = (names: ReadonlyArray<string>, kind = "-") =>
    names.map(
      (name) => `${name.endsWith("/") ? "d" : kind}rwxr-xr-x 0/0 1 2026-01-01 00:00 ${name}`,
    );
  assert.isUndefined(tarProblem(ok, verbose(ok), root));
  for (const [names, lines, why] of [
    [[...ok, "/etc/cron.d/x"], verbose([...ok, "/etc/cron.d/x"]), "/etc/cron.d/x"],
    [[...ok, `${root}/../x`], verbose([...ok, `${root}/../x`]), `${root}/../x`],
    [[...ok, "elsewhere/x"], verbose([...ok, "elsewhere/x"]), "elsewhere/x"],
    [
      ok,
      [
        ...verbose(ok.slice(0, 2)),
        `lrwxrwxrwx 0/0 0 2026-01-01 00:00 ${root}/LICENSE -> /etc/passwd`,
      ],
      `${root}/LICENSE`,
    ],
    [
      ok,
      [
        ...verbose(ok.slice(0, 2)),
        `hrw-r--r-- 0/0 0 2026-01-01 00:00 ${root}/LICENSE link to ${root}/typst`,
      ],
      `${root}/LICENSE`,
    ],
    [ok, verbose(ok.slice(0, 2)), "a listing that doesn't add up"],
  ] as const)
    assert.include(tarProblem(names, lines, root) ?? "", why);
});

it("serves pages exactly the fonts it fetches", () => {
  assert.sameMembers(
    KIN_VISUAL_FONTS.map((font) => font.file),
    [...PINNED_FONT_FILES],
  );
});
