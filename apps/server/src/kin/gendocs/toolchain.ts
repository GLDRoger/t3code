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
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProcessRunner } from "../../processRunner.ts";

/**
 * Typst, the one renderer recipes use for PDF: a single static binary with its own fonts,
 * Apache-2.0. Fetched by the server on first use from the release named here, checked against
 * the checksum pinned here, kept under the T3 home, and run by the server (`render.ts`).
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
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_MEMBERS = 200;

/**
 * Why a Typst archive's listing isn't one Kin trusts: every member a plain file or folder inside
 * `root`, no absolute or climbing name, no link. `verbose` is `tar -tv` for the same members.
 */
export const tarProblem = (
  names: ReadonlyArray<string>,
  verbose: ReadonlyArray<string>,
  root: string,
): string | undefined => {
  if (names.length === 0 || names.length > MAX_MEMBERS || names.length !== verbose.length)
    return "a listing that doesn't add up";
  for (const [index, name] of names.entries()) {
    const line = verbose[index]!;
    if (
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      (name !== root && name !== `${root}/` && !name.startsWith(`${root}/`))
    )
      return `a member named ${name}`;
    if (!/^[-d]/.test(line) || line.includes(" -> ") || line.includes(" link to "))
      return `a link at ${name}`;
  }
  return undefined;
};

const toolsRoot = (baseDir: string) => `${baseDir}/kin-tools`;
/** The directories a worker's shell reads and finds on its PATH; one per pinned tool. */
export const toolDirectories = (baseDir: string) => [
  `${toolsRoot(baseDir)}/typst-${TYPST_VERSION}`,
];

export class KinToolchain extends Context.Service<
  KinToolchain,
  {
    /** The pinned Typst's path on this host, fetched first if need be, or why there is none. */
    readonly ensure: () => Effect.Effect<string, KinChatError>;
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

    const sha256 = (bytes: Uint8Array) =>
      digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));
    /** The stamp names the pinned archive and the program it held; the program must still be it. */
    const installed = Effect.fn("KinToolchain.installed")(
      function* (archive: string) {
        const [stamped = "", program = ""] = (yield* fs.readFileString(`${directory!}/.sha256`))
          .trim()
          .split("\n");
        if (stamped !== archive || program === "") return false;
        return (yield* sha256(yield* fs.readFile(binary))) === program;
      },
      Effect.orElseSucceed(() => false),
    );

    const typst = Effect.fn("KinToolchain.typst")(function* () {
      const platform = yield* HostProcess.Platform;
      const release = TYPST_RELEASES[`${platform}-${yield* HostProcess.Architecture}`];
      if (release === undefined)
        return yield* unavailable(
          `Kin has no Typst build for ${platform} on this processor, so it can't make PDFs here.`,
        );
      if (yield* installed(release.sha256)) return binary;
      yield* Effect.logInfo("Kin is fetching Typst for documents", { version: TYPST_VERSION });
      const url = `https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${release.target}.tar.xz`;
      const response = yield* http.get(url);
      // Counted as it arrives: a length header is the sender's word, not a limit.
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      const tooLarge = unavailable("Typst's download was larger than expected.");
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES) return Effect.fail(tooLarge);
          chunks.push(chunk);
          return Effect.void;
        }),
      );
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const sum = yield* sha256(bytes);
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
        const root = `typst-${release.target}`;
        const list = (flags: string) =>
          runner
            .run({ command: "tar", args: [flags, archive], timeout: "2 minutes" })
            .pipe(
              Effect.map((out) => (out.code === 0 ? out.stdout.split("\n").filter(Boolean) : [])),
            );
        const problem = tarProblem(yield* list("-tJf"), yield* list("-tvJf"), root);
        if (problem !== undefined)
          return yield* unavailable(`Typst's archive holds ${problem}, so Kin didn't use it.`);
        const unpacked = yield* runner.run({
          command: "tar",
          args: ["-xJf", archive, "-C", scratch, "--no-same-owner", "--no-same-permissions"],
          timeout: "2 minutes",
        });
        if (unpacked.code !== 0)
          return yield* unavailable(
            `Kin couldn't unpack Typst: ${unpacked.stderr.trim().slice(0, 200) || "tar failed"}. The host needs tar with xz.`,
          );
        // What tar made, looked at before anything in it runs: no links, and within the cap.
        let size = 0;
        for (const entry of yield* fs.readDirectory(path.join(scratch, root), {
          recursive: true,
        })) {
          const at = path.join(scratch, root, entry);
          if (
            yield* fs.readLink(at).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          )
            return yield* unavailable("Typst's archive unpacked a link, so Kin didn't use it.");
          size += Number((yield* fs.stat(at)).size);
          if (size > MAX_UNPACKED_BYTES)
            return yield* unavailable("Typst unpacked larger than expected, so Kin didn't use it.");
        }
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
        yield* fs.writeFileString(
          `${directory!}/.sha256`,
          `${release.sha256}\n${yield* sha256(yield* fs.readFile(binary))}\n`,
        );
      }).pipe(
        Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
      return binary;
    });

    const ensure: KinToolchain["Service"]["ensure"] = Effect.fn("KinToolchain.ensure")(
      function* () {
        return yield* typst();
      },
      lock.withPermits(1),
      Effect.catchIf(
        (cause) => !isChatError(cause),
        (cause) =>
          Effect.logWarning("Kin couldn't fetch a document tool", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                unavailable(
                  "Kin couldn't fetch Typst, which it renders documents with. Try again in a minute.",
                ),
              ),
            ),
          ),
      ),
    );
    return KinToolchain.of({ ensure });
  }),
);
