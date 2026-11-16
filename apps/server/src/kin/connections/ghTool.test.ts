import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { ghDirectory, ghVersionUsable, KinGhTool, layer } from "./ghTool.ts";

/** A download that isn't the pinned release, and a host whose own gh says `systemVersion`. */
const withHost = (systemVersion: string, runs: Array<string>) => {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response("not the release", { status: 200 })),
    ),
  );
  const runner = Layer.mock(ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        runs.push([input.command, ...input.args].join(" "));
        return {
          stdout: input.command === "gh" ? systemVersion : "",
          stderr: "",
          code: 0 as never,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  return layer.pipe(
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(runner),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-gh-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provideMerge(Layer.succeed(HostProcess.Architecture, "x64")),
  );
};

it.effect("refuses a download off its pinned checksum and never unpacks or runs it", () => {
  const runs: Array<string> = [];
  return Effect.gen(function* () {
    const failed = yield* (yield* KinGhTool).ensure().pipe(Effect.flip);
    assert.strictEqual(
      failed.message,
      "The GitHub CLI download didn't match its pinned checksum, so Kin didn't use it.",
    );
    // Only the host's own gh was asked its version; no tar, nothing from the download ran.
    assert.deepEqual(runs, ["gh --version"]);
    const fs = yield* FileSystem.FileSystem;
    assert.isFalse(yield* fs.exists(ghDirectory((yield* ServerConfig).baseDir)));
  }).pipe(Effect.provide(withHost("gh version 2.46.0 (2024-04-02)", runs)));
});

it.effect("uses the host's own gh when it can't fetch one and the host's is new enough", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* (yield* KinGhTool).ensure(), "gh");
  }).pipe(Effect.provide(withHost("gh version 2.81.0 (2025-10-01)", []))),
);

it("reads gh's version", () => {
  assert.isTrue(ghVersionUsable("gh version 2.103.3 (2026-10-26)"));
  assert.isTrue(ghVersionUsable("gh version 3.0.0"));
  assert.isFalse(ghVersionUsable("gh version 2.80.9"));
  assert.isFalse(ghVersionUsable(""));
});
