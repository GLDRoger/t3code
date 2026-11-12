// @effect-diagnostics nodeBuiltinImport:off -- the temp root and RAM size come from the host.
import * as NodeOS from "node:os";

import type { SandboxSettings, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  CodexSettings,
  type KinWorkerLimits,
  type KinWorkerSandboxInstall,
  KinWorkerLimits as Limits,
  KinWorkerSandboxInstall as Install,
  type ServerSettings,
  workerHostProblem,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
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
import { resolveClaudeHomePath } from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import { makeConfiner, type WorkerCredentials } from "../claudeConfinement.ts";
import { toolDirectories } from "../gendocs/toolchain.ts";
import { grantedHosts, noteBlocked, refusedHosts } from "./workNetwork.ts";
import { type CheckLine, type CheckResult, probe, type ShellPaths } from "./workSandboxProbe.ts";
import { shellTools, type WorkerPlace, type WorkSession } from "./workSession.ts";
import { workThreadPrefix } from "./workThread.ts";

export type { CheckLine, CheckResult, ShellPaths } from "./workSandboxProbe.ts";

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

/** Readable by every shell: the system's programs, libraries and configuration. */
const systemRoots: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
  linux: ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt"],
  // For `kin worker-shell --check` on a Mac; workers get no shell there.
  darwin: [
    "/usr",
    "/bin",
    "/sbin",
    "/System",
    "/Library",
    "/private/etc",
    "/private/var/db",
    "/opt",
    "/dev",
  ],
};

/**
 * The child's sandbox. Reads are closed: everything is denied and only the worktree, the task's
 * temp directory and `paths.readable` come back, minus `paths.denied` inside those. Every list
 * is closed; nothing here comes from the worktree.
 */
export const sandboxSettings = (
  paths: ShellPaths,
  domains: ReadonlyArray<string>,
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
    // A narrower deny holds inside a wider allow, so `denied` stays shut in a readable root.
    denyRead: ["/", ...paths.denied, paths.gitCommonDir],
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
});

/** Standard login and credential locations under a home, beside the provider homes. */
const credentialLocations = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
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

const decodeClaude = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodex = Schema.decodeUnknownOption(CodexSettings);
const noClaudeHome = { homePath: "" };

/**
 * Every Claude and Codex home the server's providers use, through each provider's own resolver
 * and environment merge: the defaults, then each configured instance's. A home that doesn't
 * exist yet is still named.
 */
export const providerHomes = Effect.fn("KinWorkSandbox.providerHomes")(function* (
  settings: Pick<ServerSettings, "providerInstances"> | undefined,
  hostEnv: NodeJS.ProcessEnv,
) {
  const codexHomes = Effect.fnUntraced(function* (config: CodexSettings, env: NodeJS.ProcessEnv) {
    const fromEnv = env.CODEX_HOME?.trim();
    const layout = yield* resolveCodexHomeLayout(
      !config.homePath.trim() && !config.shadowHomePath.trim() && fromEnv
        ? { ...config, homePath: fromEnv }
        : config,
    );
    return [layout.sharedHomePath, layout.effectiveHomePath];
  });
  const defaultCodex = decodeCodex({});
  const homes = [
    yield* resolveClaudeHomePath(noClaudeHome, hostEnv),
    ...(Option.isSome(defaultCodex) ? yield* codexHomes(defaultCodex.value, hostEnv) : []),
  ];
  for (const instance of Object.values(settings?.providerInstances ?? {})) {
    if (instance.driver !== "claudeAgent" && instance.driver !== "codex") continue;
    const env = yield* mergeProviderInstanceEnvironment(instance.environment, hostEnv);
    if (instance.driver === "claudeAgent") {
      const config = decodeClaude(instance.config ?? {});
      homes.push(
        yield* resolveClaudeHomePath(Option.isSome(config) ? config.value : noClaudeHome, env),
      );
    } else {
      const config = decodeCodex(instance.config ?? {});
      if (Option.isSome(config)) homes.push(...(yield* codexHomes(config.value, env)));
    }
  }
  return [...new Set(homes.filter((home): home is string => home !== undefined))];
});

/** The homes a worker started now would protect, from the server's provider settings. */
const configuredProviderHomes = Effect.fn("KinWorkSandbox.configuredProviderHomes")(function* (
  service: Option.Option<ServerSettingsService["Service"]>,
  hostEnv: NodeJS.ProcessEnv,
) {
  const settings = Option.isNone(service)
    ? Option.none()
    : yield* service.value.getSettings.pipe(Effect.option);
  return yield* providerHomes(Option.getOrUndefined(settings), hostEnv);
});

const WALK_ENTRIES = 1_000_000;
const WALK_DEPTH = 32;
const WALK_CONCURRENCY = 64;

/**
 * Where links under `roots` lead outside the root they sit in, each such target walked in turn.
 * Fails when a directory can't be listed or the walk passes its bounds: an unseen link could
 * lead anywhere.
 */
const outwardTargets = Effect.fn("KinWorkSandbox.outwardTargets")(function* (
  roots: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targets = new Set<string>();
  let entries = 0;
  const queue = [...roots];
  while (queue.length > 0) {
    const root = queue.shift()!;
    const info = yield* fs.stat(root).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") continue;
    let frontier = [root];
    for (let depth = 0; frontier.length > 0; depth++) {
      if (depth > WALK_DEPTH)
        return yield* Effect.fail(`${root} is nested too deep to check for links out`);
      const listed = yield* Effect.forEach(
        frontier,
        (directory) =>
          fs.readDirectoryEntries(directory).pipe(
            Effect.map((found) => found.map((entry) => ({ entry, directory }))),
            Effect.mapError(() => `${directory} can't be listed to check for links out`),
          ),
        { concurrency: WALK_CONCURRENCY },
      );
      const found = listed.flat();
      entries += found.length;
      if (entries > WALK_ENTRIES)
        return yield* Effect.fail(`${root} holds too many files to check for links out`);
      const leads = yield* Effect.forEach(
        found.filter(({ entry }) => entry.type === "SymbolicLink"),
        ({ entry, directory }) => {
          const link = path.join(directory, entry.name);
          // A dangling link still names where a later file would be read from.
          return fs.realPath(link).pipe(
            Effect.catch(() =>
              fs.readLink(link).pipe(Effect.map((to) => path.resolve(directory, to))),
            ),
            Effect.mapError(() => `${link} can't be read to check where it leads`),
          );
        },
        { concurrency: WALK_CONCURRENCY },
      );
      for (const target of leads)
        if (!isInside(root, target) && !targets.has(target)) {
          targets.add(target);
          queue.push(target);
        }
      frontier = found.flatMap(({ entry, directory }) =>
        entry.type === "Directory" ? [path.join(directory, entry.name)] : [],
      );
    }
  }
  return [...targets];
});

/**
 * What a shell may read beside its worktree and temp directory, and the private places denied
 * inside that: state, shared temp, provider homes, credential locations and wherever their links
 * lead. A read path or the server's Node that holds or sits in one fails.
 */
export const shellRoots = Effect.fn("KinWorkSandbox.shellRoots")(function* (input: {
  readonly home: string;
  readonly stateDir: string;
  /** Readable everywhere: `systemRoots` for the platform. */
  readonly system: ReadonlyArray<string>;
  /** Absolute, as each provider resolves them (`providerHomes`); missing ones included. */
  readonly providerHomes: ReadonlyArray<string>;
  readonly readPaths: ReadonlyArray<string>;
  readonly runtime: string | undefined;
  /** Kin's own tools; one that is missing or would reopen private data is left out. */
  readonly toolDirs?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = (target: string) => fs.realPath(target).pipe(Effect.orElseSucceed(() => undefined));
  const home = yield* real(input.home);
  const state = yield* real(input.stateDir);
  if (home === undefined || state === undefined)
    return yield* Effect.fail("the home or state directory doesn't resolve");
  const tmpRoot = (yield* real("/tmp")) ?? (yield* real(NodeOS.tmpdir()));
  if (tmpRoot === undefined) return yield* Effect.fail("no temp directory resolves");
  const links = (yield* fs.readDirectoryEntries(home).pipe(Effect.orElseSucceed(() => [])))
    .filter((entry) => entry.type === "SymbolicLink")
    .map((entry) => path.join(home, entry.name));
  const credentialDirs = [
    ...input.providerHomes,
    ...credentialLocations.map((entry) => path.join(home, entry)),
  ];
  // Each by its name and, where it exists, its real path.
  const spelled = Effect.fnUntraced(function* (entries: ReadonlyArray<string>) {
    const found = yield* Effect.forEach(entries, (entry) =>
      real(entry).pipe(Effect.map((target) => [path.resolve(entry), target])),
    );
    return [...new Set(found.flat().filter((entry): entry is string => entry !== undefined))];
  });
  const credentials = yield* spelled(credentialDirs);
  const walked = yield* outwardTargets(credentials);
  const privateRoots = [
    ...new Set([
      ...(yield* spelled([state, tmpRoot, ...links, "/var/tmp", "/run", "/var/run", "/dev/shm"])),
      ...credentials,
      ...walked,
    ]),
  ];
  const holds = (target: string) =>
    [home, ...privateRoots].find(
      (root) => isInside(target, root) || (root !== home && isInside(root, target)),
    );
  const tools: Array<string> = [];
  for (const entry of input.toolDirs ?? []) {
    const target = yield* real(entry);
    if (target !== undefined && holds(target) === undefined) tools.push(target);
  }
  const readable: Array<string> = [...tools];
  for (const entry of [
    ...(input.runtime === undefined ? [] : [input.runtime]),
    ...input.readPaths,
  ]) {
    const target = yield* real(entry);
    if (target === undefined) continue;
    if (holds(target) !== undefined)
      return yield* Effect.fail(`the readable path "${entry}" would reopen private data`);
    readable.push(target);
  }
  const system: Array<string> = [];
  for (const entry of input.system) {
    const target = yield* real(entry);
    if (target !== undefined && !system.includes(target)) system.push(target);
  }
  for (const root of system) {
    const covered = [home, ...privateRoots].find((entry) => isInside(entry, root));
    if (covered !== undefined)
      return yield* Effect.fail(`${covered} would hide the system directory ${root}`);
  }
  const denied = [home, ...privateRoots].filter((entry) =>
    system.some((root) => isInside(root, entry)),
  );
  return { denied, readable: [...system, ...readable], tmpRoot, tools };
});

export type Prepared =
  | {
      readonly _tag: "shell";
      readonly place: WorkerPlace;
      readonly sandbox: SandboxSettings;
      readonly tmp: string;
      readonly bins: ReadonlyArray<string>;
      /** Removes the task's private temp directory once its session closes. */
      readonly release: Effect.Effect<void>;
      /** Keeps the hosts a message says the network rule refused, for the worker's report. */
      readonly noteMessage: (message: SDKMessage) => Effect.Effect<void>;
    }
  | { readonly _tag: "file-only"; readonly place: WorkerPlace; readonly reason: string }
  /** The worker must not start at all; `reason` is the owner's. */
  | { readonly _tag: "refused"; readonly reason: string };

export const WorkShellStatus = Schema.Struct({
  checkedAt: Schema.Number,
  shell: Schema.Boolean,
  reason: Schema.String,
  claudeCodeVersion: Schema.NullOr(Schema.String),
  install: Schema.optional(Schema.Array(Install)),
  namesBlockedHosts: Schema.optional(Schema.Boolean),
  limits: Schema.optional(Schema.NullOr(Limits)),
  limitsNote: Schema.optional(Schema.String),
  /** Workers didn't start at all, not even with file tools. */
  refused: Schema.optional(Schema.Boolean),
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
export type CheckedSession = Omit<WorkSession, "shell" | "confinement" | "place">;

/** Decides, at each work session's start, whether its child may start, and with a shell. */
export class KinWorkSandbox extends Context.Service<
  KinWorkSandbox,
  {
    readonly prepare: (input: {
      /** Kin's thread for the worker; its id names the hosts the server granted it. */
      readonly threadId: string;
      /** The worktree's real path; `undefined` leaves the file tools nothing and no shell. */
      readonly worktree: string | undefined;
      readonly session: CheckedSession;
      readonly credentials: WorkerCredentials;
    }) => Effect.Effect<Prepared>;
  }
>()("t3/kin/lead/workSandbox/KinWorkSandbox") {}

const workerHome = (stateDir: string) => `${stateDir}/kin/worker-home`;

/**
 * Where a worker's Claude Code keeps its state: an empty home under the state directory, which
 * neither its commands nor its file tools reach, and the provider's Claude home for the login.
 */
export const workerPlace = Effect.fn("KinWorkSandbox.workerPlace")(function* (
  providerEnv: NodeJS.ProcessEnv,
  privateHome: string,
) {
  const path = yield* Path.Path;
  const configured = providerEnv.CLAUDE_CONFIG_DIR?.trim();
  // The login Keychain is found through the real home; a Mac worker has no shell to read it with.
  if ((yield* HostProcess.Platform) === "darwin") {
    const place: WorkerPlace = {
      home: yield* HostProcess.HomeDirectory,
      configDir: configured ? path.resolve(configured) : undefined,
    };
    return place;
  }
  const place: WorkerPlace = {
    home: privateHome,
    configDir: yield* resolveClaudeHomePath(noClaudeHome, providerEnv),
  };
  return place;
});

/** For tests and hosts that must never run a shell. */
export const fileOnly = (reason: string, privateHome = "/nonexistent/kin-worker-home") =>
  Layer.effect(
    KinWorkSandbox,
    Effect.gen(function* () {
      const context = yield* Effect.context<Path.Path>();
      return KinWorkSandbox.of({
        prepare: Effect.fn("KinWorkSandbox.fileOnly")(function* (input) {
          if (input.credentials._tag === "refused")
            return { _tag: "refused", reason: input.credentials.reason } as const;
          const place = yield* workerPlace(
            input.session.options.env ?? input.session.environment,
            privateHome,
          );
          return { _tag: "file-only", place, reason } as const;
        }, Effect.provide(context)),
      });
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

/**
 * The limits a worker's scope gets here, and why any are off: a launch is wrapped the way every
 * worker's is, without starting anything.
 */
const scopedLimits = Effect.fn("KinWorkSandbox.scopedLimits")(function* (scope: AgentScopeShape) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "linux")
    return { limits: null, limitsNote: `${platform} has no systemd scope for a worker` };
  const launch = yield* scope.wrap({
    command: "/usr/bin/env",
    args: [],
    name: "kin-limits",
    properties: workerScopeProperties(hostWorkerLimits),
  });
  if (launch.unit === undefined)
    return {
      limits: null,
      limitsNote: "no systemd user manager answers here, so workers run without their own limits",
    };
  const refused = launch.refusedProperties ?? [];
  return {
    limits: hostWorkerLimits,
    ...(refused.length === 0
      ? {}
      : { limitsNote: `systemd refused ${refused.join(", ")}, so workers start without it` }),
  };
});

/**
 * Resolves the host's paths and runs the check once for `session`, with the options and sandbox
 * a shell child would get. `kin worker-shell --check` and every worker's start run this.
 */
export const checkShell = Effect.fn("KinWorkSandbox.checkShell")(function* (input: {
  readonly stateDir: string;
  readonly session: CheckedSession;
  readonly place: WorkerPlace;
  readonly domains: ReadonlyArray<string>;
  readonly readPaths: ReadonlyArray<string>;
  /** Absolute, as each provider resolves them; see `providerHomes`. */
  readonly providerHomes: ReadonlyArray<string>;
  readonly toolDirs?: ReadonlyArray<string>;
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
    system: systemRoots[platform] ?? [],
    providerHomes: input.providerHomes,
    readPaths: input.readPaths,
    runtime,
    ...(input.toolDirs === undefined ? {} : { toolDirs: input.toolDirs }),
  }).pipe(Effect.result);
  if (roots._tag === "Failure") return { _tag: "unresolved", reason: roots.failure } as const;
  const { denied, readable, tmpRoot, tools } = roots.success;
  // The server's own Node and Kin's tools first: shims in the home the shell can't read fail.
  const bins = [...(runtime === undefined ? [] : [path.join(runtime, "bin")]), ...tools];
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
  const policy: CheckLine = {
    passed: true,
    kind: "info",
    label: `reads are closed: commands read their worktree, their temp directory and ${readable.join(", ")}${denied.length === 0 ? "" : `, except ${denied.join(", ")}`}`,
  };
  const result: CheckResult = yield* probe({
    stateDir: input.stateDir,
    tmpRoot,
    platform,
    paths,
    sandbox: (shellPaths) => sandboxSettings(shellPaths, input.domains),
    bins,
    session: { ...input.session, place: input.place },
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
    result: { ...result, lines: [...result.lines, policy] },
    paths,
    tmpRoot,
    bins,
    install: result.failed === undefined ? [] : yield* missing(env),
  } as const;
});

export const layer = Layer.effect(
  KinWorkSandbox,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir, baseDir } = yield* ServerConfig;
    const agentScope = yield* AgentScope;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const context = yield* Effect.context<
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | SecureRandom.SecureRandom
    >();
    // Made once: nothing a worker controls writes it, so sessions share it.
    const privateHome = yield* Effect.cached(
      Effect.gen(function* () {
        const home = workerHome(stateDir);
        yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
        yield* fs.chmod(home, 0o700);
        return yield* fs.realPath(home);
      }).pipe(Effect.option),
    );

    const record = Effect.fn("KinWorkSandbox.record")(
      function* (
        shell: boolean,
        reason: string,
        claudeCodeVersion: string | null,
        found: {
          readonly install?: ReadonlyArray<KinWorkerSandboxInstall>;
          readonly namesBlockedHosts?: boolean;
          readonly refused?: boolean;
        } = {},
      ) {
        const status = {
          checkedAt: yield* Clock.currentTimeMillis,
          shell,
          reason,
          claudeCodeVersion,
          ...found,
          ...(yield* scopedLimits(agentScope)),
        };
        yield* fs.makeDirectory(`${stateDir}/kin`, { recursive: true });
        yield* fs.writeFileString(
          statusFile(stateDir),
          yield* Schema.encodeEffect(statusJson)(status),
        );
      },
      Effect.ignoreCause({ log: true }),
    );

    const prepare: KinWorkSandbox["Service"]["prepare"] = Effect.fn("KinWorkSandbox.prepare")(
      function* (input) {
        if (input.credentials._tag === "refused") {
          yield* record(false, input.credentials.reason, null, { refused: true });
          yield* Effect.logWarning("Kin worker refused", { reason: input.credentials.reason });
          return { _tag: "refused", reason: input.credentials.reason } as const;
        }
        const providerEnv = input.session.options.env ?? input.session.environment;
        const home = yield* privateHome;
        if (Option.isNone(home)) {
          const reason = "Kin couldn't make the workers' private home directory";
          yield* record(false, reason, null, { refused: true });
          return { _tag: "refused", reason } as const;
        }
        const place = yield* workerPlace(providerEnv, home.value);
        const fileOnlyBecause = (
          reason: string,
          version: string | null = null,
          install: ReadonlyArray<KinWorkerSandboxInstall> = [],
        ) =>
          record(false, reason, version, { install }).pipe(
            Effect.andThen(Effect.logWarning("Kin worker runs without a shell", { reason })),
            Effect.as({ _tag: "file-only", place, reason } as const),
          );
        const host = hostShell(yield* HostProcess.Environment);
        if (host._tag === "off") return yield* fileOnlyBecause(host.reason);
        const platform = yield* HostProcess.Platform;
        // Seatbelt has no PID namespace, so a process a command leaves behind would outlive it.
        if (platform !== "linux")
          return yield* fileOnlyBecause(
            `worker shells run only on Linux, where every process a command starts ends with it; this host is ${platform}`,
          );
        if (input.worktree === undefined)
          return yield* fileOnlyBecause("the worker's worktree doesn't resolve");
        const workerId = input.threadId.startsWith(workThreadPrefix)
          ? input.threadId.slice(workThreadPrefix.length)
          : "";
        const domains = yield* grantedHosts(stateDir, workerId);
        const checked = yield* checkShell({
          stateDir,
          session: input.session,
          place,
          domains,
          readPaths: host.readPaths,
          toolDirs: toolDirectories(baseDir),
          providerHomes: yield* configuredProviderHomes(settings, yield* HostProcess.Environment),
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
        yield* record(true, "the sandbox check passed", result.version, {
          namesBlockedHosts: result.namesBlockedHosts,
        });
        return {
          _tag: "shell",
          place,
          sandbox: sandboxSettings(childPaths.success, domains),
          tmp: tmp.success,
          bins: checked.bins,
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
