import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { KinToolchain, layer, tarProblem, toolDirectories } from "./toolchain.ts";

const LINUX_X64 = "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c";
const MiB = 1024 * 1024;

it.effect("re-checks the installed Typst, and stops a download as it passes the cap", () => {
  let requests = 0;
  let sent = 0;
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
    yield* fs.writeFileString(`${directory!}/typst`, "#!/bin/sh\necho tampered\n");
    yield* fs.writeFileString(`${directory!}/.sha256`, `${LINUX_X64}\n`);
    const failed = yield* (yield* KinToolchain).ensure().pipe(Effect.flip);
    assert.strictEqual(requests, 1);
    assert.strictEqual(failed.message, "Typst's download was larger than expected.");
    assert.isAtMost(sent, 66 * MiB);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
        Layer.provideMerge(ProcessRunner.layer),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-tools-" })),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
