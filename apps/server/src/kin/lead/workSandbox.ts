// @effect-diagnostics nodeBuiltinImport:off -- the temp root and RAM size come from the host.
import * as NodeOS from "node:os";

import type { SandboxSettings, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type KinWorkerLimits,
  type KinWorkerSandboxInstall,
  KinWorkerLimits as Limits,
  KinWorkerSandboxInstall as Install,
  workerHostProblem,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { AgentScope, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeConfiner, sessionEnvironment } from "../claudeConfinement.ts";
import { grantedHosts, noteBlocked, refusedHosts } from "./workNetwork.ts";
import { type CheckResult, probe, type ShellPaths } from "./workSandboxProbe.ts";
import { shellTools, type WorkSession } from "./workSession.ts";
import { workThreadPrefix } from "./workThread.ts";

export type { CheckLine, CheckResult, ShellPaths } from "./workSandboxProbe.ts";

/** Per command and per task; Claude Code enforces the first two, `WorkerTracker` the last. */
const commandLimits = {
  BASH_DEFAULT_TIMEOUT_MS: "120000",
  BASH_MAX_TIMEOUT_MS: "600000",
  BASH_MAX_OUTPUT_LENGTH: "30000",
  // No `run_in_background`: a command ends before its tool call returns.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

/** A shell child's environment; the check runs with exactly this, plus its fake model's address. */
const childEnvironment = (env: NodeJS.ProcessEnv, tmp: string, runtimeBin: string | undefined) => {
  const session = sessionEnvironment(env);
  return {
    ...session,
    ...commandLimits,
    CLAUDE_CODE_TMPDIR: tmp,
    // The server's own Node first: version-manager shims live in the home the shell can't read.
    ...(runtimeBin === undefined
      ? {}
      : { PATH: [runtimeBin, session.PATH].filter(Boolean).join(":") }),
  };
};

const GiB = 1024 ** 3;

/**
 * Each worker's own systemd scope, beside the limits every agent's scope already shares: half the
 * RAM (at least 4 GiB), 4096 tasks, and half an agent's CPU weight. A real build or a PDF render
 * stays under them; a fork bomb or a runaway allocation stops there instead of at the server.
 */
const workerLimits = (totalMemory: number): KinWorkerLimits => ({
  memoryMaxBytes: Math.max(4 * GiB, Math.floor(totalMemory / 2)),
  tasksMax: 4096,
  cpuWeight: 50,
});
export const workerScopeProperties = (limits: KinWorkerLimits) => [
  `MemoryMax=${limits.memoryMaxBytes}`,
  `TasksMax=${limits.tasksMax}`,
  `CPUWeight=${limits.cpuWeight}`,
];
export const hostWorkerLimits = workerLimits(NodeOS.totalmem());

/**
 * What the owner set on the host. Nothing the agent, the brief or the repository says reaches it.
 * `domains` are extras beside the org's list in Kin's settings, which the server grants per worker.
 */
export type HostShell =
  | {
      readonly _tag: "on";
      readonly domains: ReadonlyArray<string>;
      readonly readPaths: ReadonlyArray<string>;
    }
  | { readonly _tag: "off"; readonly reason: string };

const listed = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const hostShell = (env: NodeJS.ProcessEnv): HostShell => {
  if (env.KIN_WORKER_SHELL === "off")
    return { _tag: "off", reason: "the owner turned worker shells off (KIN_WORKER_SHELL=off)" };
  const domains = listed(env.KIN_WORKER_ALLOWED_DOMAINS).map((entry) => entry.toLowerCase());
  for (const entry of domains) {
    const problem = workerHostProblem(entry);
    if (problem !== undefined)
      return {
        _tag: "off",
        reason: `KIN_WORKER_ALLOWED_DOMAINS has ${JSON.stringify(entry.slice(0, 80))}, which ${problem}`,
      };
  }
  const readPaths = listed(env.KIN_WORKER_READ_PATHS);
  const relative = readPaths.find((entry) => !entry.startsWith("/"));
  if (relative !== undefined)
    return {
      _tag: "off",
      reason: `KIN_WORKER_READ_PATHS has ${JSON.stringify(relative.slice(0, 80))}, which isn't an absolute path`,
    };
  return { _tag: "on", domains, readPaths };
};

// The shell keeps these; Claude Code sets its own proxy variables and TMPDIR for each command.
const shellVariables = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

/** The child's sandbox. Every list is closed; nothing here comes from the worktree. */
export const sandboxSettings = (
  paths: ShellPaths,
  domains: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): SandboxSettings => ({
  enabled: true,
  failIfUnavailable: true,
  allowUnsandboxedCommands: false,
  autoAllowBashIfSandboxed: true,
  enableWeakerNestedSandbox: false,
  allowNestedUserNamespaces: false,
  enableWeakerNetworkIsolation: false,
  allowAppleEvents: false,
  excludedCommands: [],
  filesystem: {
    denyRead: [...paths.denied, paths.gitCommonDir],
    allowRead: [paths.worktree, paths.tmp, ...paths.readable],
    allowWrite: [paths.tmp],
    denyWrite: [paths.gitCommonDir, `${paths.worktree}/.git`],
  },
  network: {
    allowedDomains: [...domains],
    strictAllowlist: true,
    allowAllUnixSockets: false,
    allowUnixSockets: [],
    allowLocalBinding: false,
    allowMachLookup: [],
  },
  credentials: {
    envVars: Object.keys(env)
      .filter((name) => !shellVariables.has(name) && !name.startsWith("LC_"))
      .toSorted()
      .map((name) => ({ name, mode: "deny" as const })),
  },
});

/** Standard login and credential locations under a home, beside the provider homes. */
const credentialLocations = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".config",
  ".netrc",
  ".docker",
  ".kube",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".local/share/keyrings",
  ".claude",
  ".claude.json",
  ".codex",
];

const isInside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/** The Claude and Codex homes the server's own provider settings point at, as written there. */
const configuredProviderHomes = Effect.fn("KinWorkSandbox.configuredProviderHomes")(function* (
  service: Option.Option<ServerSettingsService["Service"]>,
) {
  if (Option.isNone(service)) return [];
  const settings = yield* service.value.getSettings.pipe(Effect.option);
  if (Option.isNone(settings)) return [];
  const homes: Array<string> = [];
  for (const instance of Object.values(settings.value.providerInstances)) {
    if (instance.driver !== "claudeAgent" && instance.driver !== "codex") continue;
    const config =
      typeof instance.config === "object" && instance.config !== null ? instance.config : {};
    for (const field of ["homePath", "shadowHomePath"])
      if (field in config) {
        const value = (config as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim().length > 0) homes.push(value.trim());
      }
    for (const variable of instance.environment ?? [])
      if (
        (variable.name === "CLAUDE_CONFIG_DIR" || variable.name === "CODEX_HOME") &&
        typeof variable.value === "string"
      )
        homes.push(variable.value);
  }
  return homes;
});

/**
 * Every root a shell must not read, as real paths: the home and state directories, each provider
 * home, the target of every link directly under the home, the standard credential locations, and
 * the shared temp and runtime directories. A readable path inside one, or holding one, fails.
 */
export const shellRoots = Effect.fn("KinWorkSandbox.shellRoots")(function* (input: {
  readonly home: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Provider homes from the server's settings, as written there (`~` allowed). */
  readonly providerHomes: ReadonlyArray<string>;
  readonly readPaths: ReadonlyArray<string>;
  readonly runtime: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => undefined));
  const home = yield* real(input.home);
  const state = yield* real(input.stateDir);
  if (home === undefined || state === undefined)
    return yield* Effect.fail("the home or state directory doesn't resolve");
  const absolute = (entry: string) => path.resolve(home, expandHomePath(entry.trim(), home));
  const providerHomes = [
    ...[input.env.CLAUDE_CONFIG_DIR, input.env.CODEX_HOME].filter(
      (entry): entry is string => entry !== undefined && entry.trim().length > 0,
    ),
    ...input.providerHomes,
  ].map(absolute);
  const links = (yield* fs.readDirectoryEntries(home).pipe(Effect.orElseSucceed(() => [])))
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => path.join(home, entry.name));
  const tmpRoot = (yield* real("/tmp")) ?? (yield* real(NodeOS.tmpdir()));
  if (tmpRoot === undefined) return yield* Effect.fail("no temp directory resolves");
  const resolved = yield* Effect.forEach(
    [
      ...providerHomes,
      ...links,
      ...credentialLocations.map((entry) => path.join(home, entry)),
      "/var/tmp",
      "/run",
      "/var/run",
      "/dev/shm",
    ],
    real,
  );
  const denied = [
    ...new Set(
      [home, state, tmpRoot, ...resolved].filter((entry): entry is string => entry !== undefined),
    ),
  ];
  const readable: Array<string> = [];
  for (const entry of [
    ...(input.runtime === undefined ? [] : [input.runtime]),
    ...input.readPaths,
  ]) {
    const target = yield* real(entry);
    if (target === undefined) continue;
    const reopens = denied.some(
      (root) => isInside(target, root) || (root !== home && isInside(root, target)),
    );
    if (reopens)
      return yield* Effect.fail(`the readable path "${entry}" would reopen private data`);
    readable.push(target);
  }
  return { denied, readable, tmpRoot };
});

export type Prepared =
  | {
      readonly _tag: "shell";
      readonly sandbox: SandboxSettings;
      readonly env: NodeJS.ProcessEnv;
      /** Removes the task's private temp directory once its session closes. */
      readonly release: Effect.Effect<void>;
      /** Keeps the hosts a message says the network rule refused, for the worker's report. */
      readonly noteMessage: (message: SDKMessage) => Effect.Effect<void>;
    }
  | { readonly _tag: "file-only"; readonly reason: string };

export const WorkShellStatus = Schema.Struct({
  checkedAt: Schema.Number,
  shell: Schema.Boolean,
  reason: Schema.String,
  claudeCodeVersion: Schema.NullOr(Schema.String),
  install: Schema.optional(Schema.Array(Install)),
  namesBlockedHosts: Schema.optional(Schema.Boolean),
  limits: Schema.optional(Schema.NullOr(Limits)),
});
const statusJson = Schema.fromJsonString(WorkShellStatus);
const statusFile = (stateDir: string) => `${stateDir}/kin/worker-shell.json`;
export const readStatus = Effect.fn("KinWorkSandbox.readStatus")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(statusFile(stateDir))
    .pipe(Effect.flatMap(Schema.decodeEffect(statusJson)), Effect.option);
});

/** The session a worker would open, without a shell; the check runs these same options. */
export type CheckedSession = Omit<WorkSession, "shell" | "confinement">;

/** Decides, at each work session's start, whether its child may have a shell. */
export class KinWorkSandbox extends Context.Service<
  KinWorkSandbox,
  {
    readonly prepare: (input: {
      /** Kin's thread for the worker; its id names the hosts the server granted it. */
      readonly threadId: string;
      readonly worktree: string;
      readonly session: CheckedSession;
    }) => Effect.Effect<Prepared>;
  }
>()("t3/kin/lead/workSandbox/KinWorkSandbox") {}

/** For tests and hosts that must never run a shell. */
export const fileOnly = (reason: string) =>
  Layer.succeed(
    KinWorkSandbox,
    KinWorkSandbox.of({
      prepare: Effect.fn("KinWorkSandbox.fileOnly")(() =>
        Effect.succeed({ _tag: "file-only", reason } as const),
      ),
    }),
  );

/** The git directory a worktree's `.git` names, then its `commondir`; a plain checkout's own. */
const gitCommonDir = Effect.fn("KinWorkSandbox.gitCommonDir")(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dotGit = `${worktree}/.git`;
  const info = yield* fs.stat(dotGit);
  if (info.type === "Directory") return yield* fs.realPath(dotGit);
  const pointer = /^gitdir: (.+)\n?$/.exec(yield* fs.readFileString(dotGit))?.[1];
  if (pointer === undefined)
    return yield* Effect.fail("the worktree's .git names no git directory");
  const gitDir = path.resolve(worktree, pointer);
  const common = (yield* fs.readFileString(`${gitDir}/commondir`)).trim();
  return yield* fs.realPath(path.resolve(gitDir, common));
});

const installHints: Record<KinWorkerSandboxInstall, string> = {
  bubblewrap: "bubblewrap isn't installed",
  socat: "socat isn't installed",
  apparmor_bwrap_profile:
    "Ubuntu's AppArmor may be stopping bubblewrap: no /etc/apparmor.d/bwrap profile",
};

/** What the host most likely lacks for Claude Code's sandbox, for the owner's status. */
const missing = Effect.fn("KinWorkSandbox.missing")(
  function* (env: NodeJS.ProcessEnv) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directories = (env.PATH ?? "").split(":").filter((entry) => entry.length > 0);
    const found = Effect.fnUntraced(function* (name: string) {
      for (const directory of directories)
        if (yield* fs.exists(path.join(directory, name))) return true;
      return false;
    });
    const install: Array<KinWorkerSandboxInstall> = [];
    if (!(yield* found("bwrap"))) install.push("bubblewrap");
    if (!(yield* found("socat"))) install.push("socat");
    const restricted = yield* fs
      .readFileString("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
      .pipe(Effect.orElseSucceed(() => "0"));
    if (restricted.trim() === "1" && !(yield* fs.exists("/etc/apparmor.d/bwrap")))
      install.push("apparmor_bwrap_profile");
    return install;
  },
  Effect.orElseSucceed((): Array<KinWorkerSandboxInstall> => []),
);

/** The worker's limits, or `null` where this host gives agents no systemd scope to hold them. */
const scopedLimits = Effect.fn("KinWorkSandbox.scopedLimits")(function* (scope: AgentScopeShape) {
  // A wrap with no thread starts nothing; it says whether a launch here would get a scope.
  const launch = yield* scope.wrap({
    command: yield* HostProcess.ExecutablePath,
    args: [],
    name: "kin-limits",
  });
  return launch.unit === undefined ? null : hostWorkerLimits;
});

/**
 * Resolves the host's paths and runs the check once for `session`, with the options and sandbox
 * a shell child would get. `kin worker-shell --check` and every worker's start run this.
 */
export const checkShell = Effect.fn("KinWorkSandbox.checkShell")(function* (input: {
  readonly stateDir: string;
  readonly session: CheckedSession;
  readonly domains: ReadonlyArray<string>;
  readonly readPaths: ReadonlyArray<string>;
  /** From the server's provider settings; see `configuredProviderHomes`. */
  readonly providerHomes: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const env = input.session.options.env ?? hostEnv;
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runtime = yield* fs
    .realPath(path.dirname(path.dirname(yield* HostProcess.ExecutablePath)))
    .pipe(Effect.orElseSucceed(() => undefined));
  const roots = yield* shellRoots({
    home: yield* HostProcess.HomeDirectory,
    stateDir: input.stateDir,
    env,
    providerHomes: input.providerHomes,
    readPaths: input.readPaths,
    runtime,
  }).pipe(Effect.result);
  if (roots._tag === "Failure") return { _tag: "unresolved", reason: roots.failure } as const;
  const { denied, readable, tmpRoot } = roots.success;
  const runtimeBin = runtime === undefined ? undefined : path.join(runtime, "bin");
  const paths = (worktree: string, tmp: string) =>
    gitCommonDir(worktree).pipe(
      Effect.map((gitDir): ShellPaths => ({
        worktree,
        gitCommonDir: gitDir,
        tmp,
        denied,
        readable,
      })),
      Effect.mapError((cause) =>
        typeof cause === "string" ? cause : "the worktree's git directory doesn't resolve",
      ),
      Effect.provide(context),
    );
  const confiner = yield* makeConfiner();
  const result: CheckResult = yield* probe({
    stateDir: input.stateDir,
    tmpRoot,
    platform,
    paths,
    sandbox: (shellPaths, childEnv) => sandboxSettings(shellPaths, input.domains, childEnv),
    childEnv: (tmp) => childEnvironment(env, tmp, runtimeBin),
    session: input.session,
    confinement: (root) => confiner.hook({ root, tools: shellTools, mcp: false }),
    hostEnv,
  }).pipe(
    Effect.scoped,
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin worker sandbox check failed", { cause: Cause.pretty(cause) }).pipe(
        Effect.as({
          failed: "the sandbox check itself failed",
          version: null,
          namesBlockedHosts: false,
          lines: [{ passed: false, kind: "gate", label: "the sandbox check itself failed" }],
        } satisfies CheckResult),
      ),
    ),
  );
  return {
    _tag: "checked",
    result,
    paths,
    tmpRoot,
    childEnv: (tmp: string) => childEnvironment(env, tmp, runtimeBin),
    install: result.failed === undefined ? [] : yield* missing(env),
  } as const;
});

export const layer = Layer.effect(
  KinWorkSandbox,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir } = yield* ServerConfig;
    const agentScope = yield* AgentScope;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const context = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
    >();

    const record = Effect.fn("KinWorkSandbox.record")(
      function* (
        shell: boolean,
        reason: string,
        claudeCodeVersion: string | null,
        found: {
          readonly install?: ReadonlyArray<KinWorkerSandboxInstall>;
          readonly namesBlockedHosts?: boolean;
        } = {},
      ) {
        const status = {
          checkedAt: yield* Clock.currentTimeMillis,
          shell,
          reason,
          claudeCodeVersion,
          ...found,
          limits: yield* scopedLimits(agentScope),
        };
        yield* fs.makeDirectory(`${stateDir}/kin`, { recursive: true });
        yield* fs.writeFileString(
          statusFile(stateDir),
          yield* Schema.encodeEffect(statusJson)(status),
        );
      },
      Effect.ignoreCause({ log: true }),
    );

    const fileOnlyBecause = (
      reason: string,
      version: string | null = null,
      install: ReadonlyArray<KinWorkerSandboxInstall> = [],
    ) =>
      record(false, reason, version, { install }).pipe(
        Effect.andThen(Effect.logWarning("Kin worker runs without a shell", { reason })),
        Effect.as({ _tag: "file-only", reason } as const),
      );

    const prepare: KinWorkSandbox["Service"]["prepare"] = Effect.fn("KinWorkSandbox.prepare")(
      function* (input) {
        const host = hostShell(yield* HostProcess.Environment);
        if (host._tag === "off") return yield* fileOnlyBecause(host.reason);
        const platform = yield* HostProcess.Platform;
        // Seatbelt has no PID namespace, so a process a command leaves behind would outlive it.
        if (platform !== "linux")
          return yield* fileOnlyBecause(
            `worker shells run only on Linux, where every process a command starts ends with it; this host is ${platform}`,
          );
        const workerId = input.threadId.startsWith(workThreadPrefix)
          ? input.threadId.slice(workThreadPrefix.length)
          : "";
        const domains = yield* grantedHosts(stateDir, workerId);
        const checked = yield* checkShell({
          stateDir,
          session: input.session,
          domains,
          readPaths: host.readPaths,
          providerHomes: yield* configuredProviderHomes(settings),
        });
        if (checked._tag === "unresolved") return yield* fileOnlyBecause(checked.reason);
        const { result, install } = checked;
        if (result.failed !== undefined) {
          const hint = install.map((item) => installHints[item]).join("; ");
          return yield* fileOnlyBecause(
            hint === "" ? result.failed : `${result.failed}; ${hint}`,
            result.version,
            install,
          );
        }
        const tmp = yield* fs
          .makeTempDirectory({ directory: checked.tmpRoot, prefix: "kin-" })
          .pipe(Effect.flatMap(fs.realPath), Effect.result);
        if (tmp._tag === "Failure")
          return yield* fileOnlyBecause(
            "Kin couldn't make the task's temp directory",
            result.version,
          );
        const childPaths = yield* checked.paths(input.worktree, tmp.success).pipe(Effect.result);
        if (childPaths._tag === "Failure") {
          yield* fs.remove(tmp.success, { recursive: true }).pipe(Effect.ignore);
          return yield* fileOnlyBecause(childPaths.failure, result.version);
        }
        const childEnv = checked.childEnv(tmp.success);
        yield* record(true, "the sandbox check passed", result.version, {
          namesBlockedHosts: result.namesBlockedHosts,
        });
        return {
          _tag: "shell",
          sandbox: sandboxSettings(childPaths.success, domains, childEnv),
          env: childEnv,
          release: fs.remove(tmp.success, { recursive: true }).pipe(Effect.ignore),
          noteMessage: (message: SDKMessage) => {
            const refused = refusedHosts(message);
            return refused.length === 0
              ? Effect.void
              : noteBlocked(stateDir, workerId, refused).pipe(Effect.provide(context));
          },
        } as const;
      },
      Effect.provide(context),
    );
    return KinWorkSandbox.of({ prepare });
  }),
);
