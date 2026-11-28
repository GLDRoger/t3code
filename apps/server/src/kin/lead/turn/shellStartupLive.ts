import { ClaudeSettings, type KinOrgId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { parseCliVersionResult } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../../config.ts";
import { ProcessRunner } from "../../../processRunner.ts";
import { probeClaudeCliVersion } from "../../../provider/ClaudeProvider.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { KinChatService } from "../../chat/KinChatService.ts";
import { KinChatRepository } from "../../chat/KinChatRepository.ts";
import { episodeNotice } from "../../hostBackup.ts";
import { KinEnabled } from "../../KinEnabled.ts";
import type { Services } from "../../KinServer.ts";
import { KinShellStartup } from "./shellStartup.ts";

const MINIMUM_CLAUDE_VERSION = "2.1.321";

export const layer = Layer.effect(
  KinShellStartup,
  Effect.gen(function* () {
    if (!(yield* KinEnabled).enabled) return { available: false };
    const { stateDir } = yield* ServerConfig;
    const { run } = yield* ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const environment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    const executable = (name: string) =>
      resolveCommandPath(name, { env: environment }).pipe(
        Effect.flatMap((path) => (path === null ? Effect.succeed(null) : fs.realPath(path))),
        Effect.orElseSucceed(() => null),
      );
    const sandbox = platform === "linux" ? yield* executable("bwrap") : "/usr/bin/sandbox-exec";
    if (
      sandbox === null ||
      (platform === "linux" && (yield* executable("socat")) === null) ||
      (platform !== "linux" && platform !== "darwin")
    )
      return { available: false };
    const args =
      platform === "linux"
        ? ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "/usr/bin/true"]
        : ["-p", "(version 1) (allow default)", "/usr/bin/true"];
    const started = yield* run({
      command: sandbox,
      args,
      cwd: stateDir,
      timeout: 5000,
      maxOutputBytes: 1024,
    }).pipe(
      Effect.map(({ code }) => code === 0),
      Effect.orElseSucceed(() => false),
    );
    if (!started) return { available: false };

    const settings = yield* (yield* ServerSettingsService).getSettings;
    const enabled = Object.values(settings.providerInstances).filter(
      (row) => row.driver === "claudeAgent" && row.enabled !== false,
    );
    const inputs = enabled.length === 0 ? [{}] : enabled.map((row) => row.config ?? {});
    const decode = Schema.decodeUnknownOption(ClaudeSettings);
    const binaries = new Map<string, ClaudeSettings>();
    for (const input of inputs) {
      const option = decode(input);
      if (Option.isNone(option)) continue;
      const config = option.value;
      const binaryPath = expandHomePath(config.binaryPath, home);
      binaries.set(binaryPath, { ...config, binaryPath });
    }
    const found = yield* Effect.forEach(
      [...binaries],
      ([binary, settings]) =>
        Effect.gen(function* () {
          const target = yield* executable(binary);
          if (target === null) return null;
          const version = yield* probeClaudeCliVersion(settings, environment, stateDir);
          if (
            Result.isFailure(version) ||
            Option.isNone(version.success) ||
            version.success.value.code !== 0
          )
            return null;
          const value = parseCliVersionResult(version.success.value);
          return value !== null && compareSemverVersions(value, MINIMUM_CLAUDE_VERSION) >= 0
            ? target
            : null;
        }),
      { concurrency: 2 },
    );
    const executables = new Set(found.filter((path) => path !== null));
    return { available: executables.size > 0, executables };
  }).pipe(
    Effect.orElseSucceed(() => ({ available: false })),
    Effect.map((startup) => ({
      ...startup,
      report: (services: Context.Context<Services>) =>
        reportSandboxStartup(services, startup.available),
    })),
  ),
);

const SHELL_NOTICE =
  "The sandbox cannot start on this machine, so the agent can still chat and use Kin's tools with its command line off.";

export const reportSandboxStartup = Effect.fn("KinShellStartup.report")(
  function* (services: Context.Context<Services>, available: boolean) {
    const sql = Context.getOption(services, SqlClient.SqlClient);
    const repo = Context.getOption(services, KinChatRepository);
    const chat = Context.getOption(services, KinChatService);
    if (Option.isNone(sql) || Option.isNone(repo) || Option.isNone(chat)) return;
    const orgs = yield* sql.value<{ orgId: KinOrgId }>`SELECT org_id AS "orgId" FROM kin_orgs`;
    for (const { orgId } of orgs) {
      yield* episodeNotice(
        orgId,
        `kin-shell-sandbox:${orgId}:`,
        available ? undefined : { id: "unavailable", body: SHELL_NOTICE, scope: "cause" },
        { rememberUntilRecovery: true },
      ).pipe(
        Effect.provideService(SqlClient.SqlClient, sql.value),
        Effect.provideService(KinChatRepository, repo.value),
        Effect.provideService(KinChatService, chat.value),
      );
    }
  },
  Effect.catchCause((cause) => Effect.logWarning("Kin could not report shell availability", cause)),
);
