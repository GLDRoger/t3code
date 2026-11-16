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
 * The GitHub CLI Kin signs the owner in with. T3 needs 2.81 or newer and distributions ship
 * older ones, so the server fetches this release on first use, checks it against the checksum
 * pinned here (from the release's `checksums.txt`), and keeps it under the T3 home. No root.
 */
const GH_VERSION = "2.103.3";
const GH_RELEASES: Readonly<Record<string, { readonly asset: string; readonly sha256: string }>> = {
  "linux-x64": {
    asset: `gh_${GH_VERSION}_linux_amd64.tar.gz`,
    sha256: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
  },
  "linux-arm64": {
    asset: `gh_${GH_VERSION}_linux_arm64.tar.gz`,
    sha256: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
  },
  "darwin-arm64": {
    asset: `gh_${GH_VERSION}_macOS_arm64.zip`,
    sha256: "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062",
  },
  "darwin-x64": {
    asset: `gh_${GH_VERSION}_macOS_amd64.zip`,
    sha256: "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682",
  },
};
const MIN_SYSTEM_GH = [2, 81] as const;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** The folder holding the pinned `gh`, which agent shells find first on their PATH. */
export const ghDirectory = (baseDir: string) => `${baseDir}/kin-tools/gh-${GH_VERSION}`;

/** Whether `gh --version` output names 2.81 or newer. */
export const ghVersionUsable = (output: string) => {
  const match = /gh version (\d+)\.(\d+)/.exec(output);
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_SYSTEM_GH[0] || (major === MIN_SYSTEM_GH[0] && minor >= MIN_SYSTEM_GH[1]);
};

export class KinGhTool extends Context.Service<
  KinGhTool,
  {
    /** The `gh` Kin runs: the pinned one, fetched first if need be, or a new enough system one. */
    readonly ensure: () => Effect.Effect<string, KinChatError>;
    /** Where the pinned `gh` lives: first on an agent session's PATH. */
    readonly directory: string;
    /** The `gh` already on this host, pinned or new enough, without fetching one. */
    readonly find: () => Effect.Effect<string | undefined>;
  }
>()("t3/kin/connections/ghTool/KinGhTool") {}

const isChatError = Schema.is(KinChatError);
const unavailable = (message: string) => new KinChatError({ reason: "unavailable", message });

export const layer = Layer.effect(
  KinGhTool,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig;
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const runner = yield* ProcessRunner;
    const digest = yield* Digest.Digest;
    const lock = yield* Semaphore.make(1);
    const directory = ghDirectory(baseDir);
    const binary = `${directory}/gh`;

    const sha256 = (bytes: Uint8Array) =>
      digest.digest(Digest.sha256, bytes).pipe(Effect.map(Hex.encode));
    const versionOf = (command: string) =>
      runner.run({ command, args: ["--version"], timeout: "30 seconds" }).pipe(
        Effect.map((out) => (out.code === 0 ? out.stdout : "")),
        Effect.orElseSucceed(() => ""),
      );
    /** The stamp names the pinned archive and the program it held; the program must still be it. */
    const installed = Effect.fn("KinGhTool.installed")(
      function* (archive: string) {
        const [stamped = "", program = ""] = (yield* fs.readFileString(`${directory}/.sha256`))
          .trim()
          .split("\n");
        if (stamped !== archive || program === "") return false;
        return (yield* sha256(yield* fs.readFile(binary))) === program;
      },
      Effect.orElseSucceed(() => false),
    );

    const pinned = Effect.fn("KinGhTool.pinned")(function* () {
      const release =
        GH_RELEASES[`${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`];
      if (release === undefined)
        return yield* unavailable("Kin has no GitHub CLI build for this host.");
      if (yield* installed(release.sha256)) return binary;
      yield* Effect.logInfo("Kin is fetching the GitHub CLI", { version: GH_VERSION });
      const response = yield* http.get(
        `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${release.asset}`,
      );
      // Counted as it arrives: a length header is the sender's word, not a limit.
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) => {
          received += chunk.length;
          if (received > MAX_DOWNLOAD_BYTES)
            return Effect.fail(unavailable("The GitHub CLI download was larger than expected."));
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
      if ((yield* sha256(bytes)) !== release.sha256)
        return yield* unavailable(
          "The GitHub CLI download didn't match its pinned checksum, so Kin didn't use it.",
        );
      yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
      const scratch = yield* fs.makeTempDirectory({
        directory: path.dirname(directory),
        prefix: ".gh-",
      });
      yield* Effect.gen(function* () {
        const archive = path.join(scratch, release.asset);
        yield* fs.writeFile(archive, bytes);
        // Only the one program is taken out, by name, so no other member can land anywhere.
        const member = `${release.asset.replace(/\.(tar\.gz|zip)$/, "")}/bin/gh`;
        const listed = yield* runner.run({
          command: "tar",
          args: ["-tvf", archive, member],
          timeout: "2 minutes",
        });
        const line = listed.stdout.trim();
        if (listed.code !== 0 || line.split("\n").length !== 1 || !line.startsWith("-"))
          return yield* unavailable(
            "The GitHub CLI archive isn't as expected, so Kin didn't use it.",
          );
        const unpacked = yield* runner.run({
          command: "tar",
          args: ["-xf", archive, "-C", scratch, "--no-same-owner", member],
          timeout: "2 minutes",
        });
        if (unpacked.code !== 0)
          return yield* unavailable(
            `Kin couldn't unpack the GitHub CLI: ${unpacked.stderr.trim().slice(0, 200) || "tar failed"}.`,
          );
        const program = path.join(scratch, member);
        if ((yield* fs.stat(program)).type !== "File")
          return yield* unavailable("The GitHub CLI archive held no program.");
        yield* fs.chmod(program, 0o755);
        if (!(yield* versionOf(program)).includes(`gh version ${GH_VERSION}`))
          return yield* unavailable("The GitHub CLI Kin fetched doesn't run on this host.");
        yield* fs.remove(directory, { recursive: true, force: true });
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.rename(program, binary);
        yield* fs.writeFileString(
          `${directory}/.sha256`,
          `${release.sha256}\n${yield* sha256(yield* fs.readFile(binary))}\n`,
        );
      }).pipe(
        Effect.ensuring(fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
      return binary;
    });

    const ensure: KinGhTool["Service"]["ensure"] = Effect.fn("KinGhTool.ensure")(function* () {
      return yield* pinned().pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Kin couldn't fetch the GitHub CLI", { cause });
            if (ghVersionUsable(yield* versionOf("gh"))) return "gh";
            return yield* isChatError(cause)
              ? Effect.fail(cause)
              : Effect.fail(
                  unavailable(
                    "Kin couldn't fetch the GitHub CLI (2.81 or newer), which it signs in with.",
                  ),
                );
          }),
        ),
      );
    }, lock.withPermits(1));
    const find: KinGhTool["Service"]["find"] = Effect.fn("KinGhTool.find")(function* () {
      if (yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false))) return binary;
      return ghVersionUsable(yield* versionOf("gh")) ? "gh" : undefined;
    });
    return KinGhTool.of({ ensure, find, directory });
  }),
);
