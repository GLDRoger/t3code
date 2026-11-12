import { ServerSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { authLocationFlags, resolveCliAuthConfig } from "../../cli/config.ts";
import { managedAuth, ownerAuth, resolveWorkerCredentials } from "../claudeConfinement.ts";
import { DEFAULT_WORKER_HOSTS } from "../lead/workerNetwork.ts";
import {
  type CheckLine,
  checkShell,
  hostShell,
  providerHomes,
  readStatus,
  workerPlace,
} from "../lead/workSandbox.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class KinWorkerShellCheckError extends Schema.TaggedError<KinWorkerShellCheckError>()(
  "KinWorkerShellCheckError",
  { message: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
}

const decodeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ providerInstances: ServerSettings.fields.providerInstances }),
  ),
);

/** The provider homes a worker started now would protect, from the server's settings file. */
const settingsProviderHomes = Effect.fn("KinWorkerShellCli.providerHomes")(function* (
  settingsPath: string,
  env: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.option);
  const settings = Option.flatMap(raw, decodeSettings);
  return yield* providerHomes(Option.getOrUndefined(settings), env);
});

/**
 * Runs a worker's sandbox check now, on fixtures under the state directory that it removes, with
 * Kin's default network list, the host's extras and the provider homes a worker would protect.
 * It reads no Kin data and changes no status.
 */
const runCheck = Effect.fn("KinWorkerShellCli.check")(function* (input: {
  readonly stateDir: string;
  readonly settingsPath: string;
  readonly claude: string | undefined;
  readonly json: boolean;
}) {
  const env = yield* HostProcess.Environment;
  const host = hostShell(env);
  const claude = input.claude ?? (yield* resolveCommandPath("claude", { env })) ?? undefined;
  if (claude === undefined)
    return yield* new KinWorkerShellCheckError({ message: "No claude on PATH; pass --claude." });
  const auth = yield* resolveWorkerCredentials({
    auth: yield* ownerAuth(env),
    managed: yield* managedAuth(),
    providerEnv: env,
  });
  const fs = yield* FileSystem.FileSystem;
  const checkHome = `${input.stateDir}/kin/worker-home`;
  yield* fs.makeDirectory(checkHome, { recursive: true, mode: 0o700 });
  const checked =
    auth._tag === "refused"
      ? ({ _tag: "unresolved", reason: auth.reason } as const)
      : yield* checkShell({
          stateDir: input.stateDir,
          session: {
            options: {
              model: "claude-haiku-4-5",
              pathToClaudeCodeExecutable: claude,
              env,
              tools: [],
              permissionMode: "default",
              // The check drops a session's identity; this one only satisfies the type.
              sessionId: "kin-sandbox-check",
            },
            credentials: {},
            environment: env,
          },
          place: yield* workerPlace(env, yield* fs.realPath(checkHome)),
          domains: [...DEFAULT_WORKER_HOSTS, ...(host._tag === "on" ? host.domains : [])],
          readPaths: host._tag === "on" ? host.readPaths : [],
          providerHomes: yield* settingsProviderHomes(input.settingsPath, env),
        });
  const platform = yield* HostProcess.Platform;
  const last = Option.getOrUndefined(yield* readStatus(input.stateDir));
  const limits: CheckLine = {
    passed: last?.limits != null,
    kind: "info",
    label:
      platform !== "linux"
        ? `no per-worker limits: ${platform} has no systemd scope`
        : last === undefined
          ? "per-worker limits are unknown until a worker starts here"
          : last.limits == null
            ? `no per-worker limits: ${last.limitsNote ?? "no systemd scope at the last worker start"}`
            : `each worker's Claude Code, native or a script, runs in its own scope: ${Math.round(last.limits.memoryMaxBytes / 1024 ** 3)} GiB memory, ${last.limits.tasksMax} tasks, CPU weight ${last.limits.cpuWeight}${last.limitsNote === undefined ? "" : `; ${last.limitsNote}`}`,
  };
  const lines = [
    ...(checked._tag === "unresolved"
      ? [{ passed: false, kind: "gate" as const, label: checked.reason }]
      : checked.result.lines),
    limits,
  ];
  const failed = checked._tag === "unresolved" ? checked.reason : checked.result.failed;
  if (input.json)
    yield* Console.log(
      yield* encodeJson({
        passed: failed === undefined,
        claudeCodeVersion: checked._tag === "checked" ? checked.result.version : null,
        lines,
      }),
    );
  else
    for (const line of lines)
      yield* Console.log(`${line.passed ? "✓" : line.kind === "info" ? "·" : "✗"} ${line.label}`);
  if (failed !== undefined)
    return yield* new KinWorkerShellCheckError({ message: `Worker shell check failed: ${failed}` });
  if (input.json) return;
  if (host._tag === "off")
    yield* Console.log(`The check passed, but workers get no shell: ${host.reason}.`);
  else if (platform !== "linux")
    yield* Console.log(
      `The check passed, but workers get a shell only on Linux, and the process lines ran only there; this host is ${platform}.`,
    );
});

/** The last sandbox check a worker's start ran on this host, and what the host now asks for. */
export const workerShellCommand = Command.make("worker-shell", {
  ...authLocationFlags,
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Emit JSON instead of a status line."),
    Flag.withDefault(false),
  ),
  check: Flag.Boolean("check").pipe(
    Flag.withDescription(
      "Run the sandbox check now on fixtures, printing a pass or fail line per escape it tries.",
    ),
    Flag.withDefault(false),
  ),
  claude: Flag.String("claude").pipe(
    Flag.withDescription("The Claude Code executable --check runs; default: claude on PATH."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Say whether Kin's workers get a sandboxed shell here. Each worker's start runs the check; this shows the last result, or runs it with --check.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      if (flags.check)
        return yield* runCheck({
          stateDir: config.stateDir,
          settingsPath: `${config.stateDir}/settings.json`,
          claude: Option.getOrUndefined(flags.claude),
          json: flags.json,
        });
      const host = hostShell(yield* HostProcess.Environment);
      const last = yield* readStatus(config.stateDir);
      if (flags.json)
        return yield* Console.log(yield* encodeJson({ host, last: Option.getOrNull(last) }));
      const asked =
        host._tag === "off"
          ? `off: ${host.reason}`
          : `on if the check passes; hosts are set in Kin's settings${host.domains.length === 0 ? "" : `, plus ${host.domains.join(", ")} from this host`}`;
      const checked = Option.match(last, {
        onNone: () => "no worker has started since this host kept a check",
        onSome: (status) =>
          `${status.shell ? "shell" : "file tools only"} since ${DateTime.formatIso(DateTime.makeUnsafe(status.checkedAt))}: ${status.reason}${status.claudeCodeVersion === null ? "" : ` (Claude Code ${status.claudeCodeVersion})`}${(status.install ?? []).length === 0 ? "" : `; install ${(status.install ?? []).join(", ")}`}`,
      });
      const limits = Option.match(
        Option.flatMapNullishOr(last, (status) => status.limits),
        {
          onNone: () =>
            `no per-worker memory or task limit on this host${Option.match(last, { onNone: () => "", onSome: (status) => (status.limitsNote === undefined ? "" : ` (${status.limitsNote})`) })}`,
          onSome: (value) =>
            `each worker capped at ${Math.round(value.memoryMaxBytes / 1024 ** 3)} GiB memory, ${value.tasksMax} tasks, CPU weight ${value.cpuWeight}`,
        },
      );
      yield* Console.log(`Worker shell: ${asked}. Last check: ${checked}. Limits: ${limits}.`);
    }),
  ),
);
