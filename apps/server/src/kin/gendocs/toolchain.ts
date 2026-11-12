import { KinChatError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";

/**
 * Typst, the one renderer recipes use for PDF and PNG: a single static binary with its own fonts,
 * Apache-2.0. Fetched by the server on first use from the release named here, checked against
 * the checksum pinned here, and kept under the T3 home where every worker's shell may read it.
 */

const TYPST_VERSION = "0.15.1";
const TYPST_RELEASES: Readonly<
  Record<string, { readonly target: string; readonly sha256: string }>
> = {
  "linux-x64": {
    target: "x86_64-unknown-linux-musl",
    sha256: "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c",
  },
  "linux-arm64": {
    target: "aarch64-unknown-linux-musl",
    sha256: "5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee",
  },
  "darwin-arm64": {
    target: "aarch64-apple-darwin",
    sha256: "48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a",
  },
  "darwin-x64": {
    target: "x86_64-apple-darwin",
    sha256: "7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa",
  },
};
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const toolsRoot = (baseDir: string) => `${baseDir}/kin-tools`;
/** The directories a worker's shell reads and finds on its PATH; one per pinned tool. */
export const toolDirectories = (baseDir: string) => [
  `${toolsRoot(baseDir)}/typst-${TYPST_VERSION}`,
];

export class KinToolchain extends Context.Service<
  KinToolchain,
  {
    /** Each tool a recipe names is on this host after this, or it fails saying why. */
    readonly ensure: (tools: ReadonlyArray<"typst">) => Effect.Effect<void, KinChatError>;
  }
>()("t3/kin/gendocs/toolchain/KinToolchain") {}

const isChatError = Schema.is(KinChatError);
const unavailable = (message: string) => new KinChatError({ reason: "unavailable", message });

export const layer = Layer.effect(
  KinToolchain,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig;
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const runner = yield* ProcessRunner;
    const digest = yield* Digest.Digest;
    const lock = yield* Semaphore.make(1);
    const [directory] = toolDirectories(baseDir);
    const binary = `${directory!}/typst`;

    const installed = fs.readFileString(`${directory!}/.sha256`).pipe(
      Effect.map((stamp) => stamp.trim()),
      Effect.orElseSucceed(() => ""),
    );

    const typst = Effect.fn("KinToolchain.typst")(function* () {
      const platform = yield* HostProcess.Platform;
      const release = TYPST_RELEASES[`${platform}-${yield* HostProcess.Architecture}`];
      if (release === undefined)
        return yield* unavailable(
          `Kin has no Typst build for ${platform} on this processor, so it can't make PDFs here.`,
        );
      if ((yield* installed) === release.sha256 && (yield* fs.exists(binary))) return;
      yield* Effect.logInfo("Kin is fetching Typst for documents", { version: TYPST_VERSION });
      const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${release.target}.tar.xz`;
      const response = yield* http.get(url);
      const length = Number(response.headers["content-length"] ?? "0");
      if (length > MAX_DOWNLOAD_BYTES)
        return yield* unavailable("Typst's download was larger than expected.");
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      const sum = Hex.encode(yield* digest.digest(Digest.sha256, bytes));
      if (sum !== release.sha256)
        return yield* unavailable(
          "Typst's download didn't match its pinned checksum, so Kin didn't use it.",
        );
      yield* fs.makeDirectory(toolsRoot(baseDir), { recursive: true });
      const scratch = yield* fs.makeTempDirectory({
        directory: toolsRoot(baseDir),
        prefix: ".typst-",
      });
      yield* Effect.gen(function* () {
        const archive = path.join(scratch, "typst.tar.xz");
        yield* fs.writeFile(archive, bytes);
        const unpacked = yield* runner.run({
          command: "tar",
          args: ["-xJf", archive, "-C", scratch],
          timeout: "2 minutes",
        });
        if (unpacked.code !== 0)
          return yield* unavailable(
            `Kin couldn't unpack Typst: ${unpacked.stderr.trim().slice(0, 200) || "tar failed"}. The host needs tar with xz.`,
          );
        const unpackedBinary = path.join(scratch, `typst-${release.target}`, "typst");
        const info = yield* fs.stat(unpackedBinary);
        if (info.type !== "File") return yield* unavailable("Typst's archive held no program.");
        yield* fs.chmod(unpackedBinary, 0o755);
        const version = yield* runner.run({
          command: unpackedBinary,
          args: ["--version"],
          timeout: "30 seconds",
        });
        if (!version.stdout.includes(TYPST_VERSION))
          return yield* unavailable("The Typst Kin fetched doesn't run on this host.");
        yield* fs.remove(directory!, { recursive: true, force: true });
        yield* fs.rename(path.dirname(unpackedBinary), directory!);
        yield* fs.writeFileString(`${directory!}/.sha256`, `${release.sha256}\n`);
      }).pipe(
        Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
    });

    const ensure: KinToolchain["Service"]["ensure"] = Effect.fn("KinToolchain.ensure")(
      function* (tools) {
        if (tools.includes("typst")) yield* typst();
      },
      lock.withPermits(1),
      Effect.catchIf(
        (cause) => !isChatError(cause),
        (cause) =>
          Effect.logWarning("Kin couldn't fetch a document tool", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                unavailable(
                  "Kin couldn't fetch Typst, which this recipe needs. Try again in a minute.",
                ),
              ),
            ),
          ),
      ),
    );
    return KinToolchain.of({ ensure });
  }),
);
