import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { KIN_ATTACHMENT_ID_PREFIX } from "../attachmentStore.ts";
import type * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";

/** What a Kin session's built-in tools may touch. `root` is a real path; without one, nothing. */
export interface FileScope {
  readonly root: string | undefined;
  readonly tools: ReadonlyArray<string>;
  /** Real attachments directory: `Read` may open a Kin chat attachment directly inside it. */
  readonly attachments?: string;
  /** `false` refuses every MCP tool too, for a session that must have none. */
  readonly mcp?: boolean;
}

const pathLimit = 4096;
/** Entries a Grep or Glob tree may hold; a bigger one is refused, not searched unchecked. */
const treeLimit = 1_000_000;
const walkConcurrency = 64;
const unsafeCharacters = /[\u0000-\u001f\u007f\\]/;
// Attachment ids end in a random UUID or a content hash, so only a turn that was handed one names it.
const attachmentName = new RegExp(
  `^${KIN_ATTACHMENT_ID_PREFIX}[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9]{1,10}){0,2}$`,
);

const textField = (input: unknown, key: string): string | undefined | null => {
  if (typeof input !== "object" || input === null || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
};

/** Only a missing, `undefined` or `false` field is unset; any other value counts as asking. */
const isSet = (input: unknown, key: string) => {
  if (typeof input !== "object" || input === null || !(key in input)) return false;
  const value = (input as Record<string, unknown>)[key];
  return value !== undefined && value !== false;
};

/** The paths and globs a call names, or `undefined` for a tool whose input this doesn't know. */
const callTargets = (tool: string, input: unknown) => {
  if (tool === "Read" || tool === "Edit" || tool === "Write") {
    const file = textField(input, "file_path");
    return typeof file === "string" ? { paths: [file], globs: [] } : undefined;
  }
  if (tool === "Glob" || tool === "Grep") {
    const searched = textField(input, "path");
    const glob = textField(input, tool === "Glob" ? "pattern" : "glob");
    if (searched === null || glob === null || (tool === "Glob" && glob === undefined))
      return undefined;
    return { paths: [searched ?? "."], globs: glob === undefined ? [] : [glob] };
  }
  return undefined;
};

/**
 * Client-side git hooks, from githooks(5). A relative `core.hooksPath` resolves inside a checkout,
 * so an edited tracked hook there runs the next time this server's git touches it.
 */
const gitHooks = new Set([
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "reference-transaction",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
]);

const safeText = (text: string) =>
  text.length <= pathLimit && !unsafeCharacters.test(text) && !text.includes("://");

/** A glob stays relative to the searched directory: no root, home, parent or `.git` part. */
const safeGlob = (glob: string) =>
  safeText(glob) &&
  !glob.includes("~") &&
  !glob.includes("..") &&
  !/(?:^|[{,])\s*\//.test(glob) &&
  !/(?:^|[/{,])\.git(?:$|[/},])/i.test(glob);

/**
 * Decides one tool call. MCP tools pass unless the scope refuses them; built-in tools reach only
 * the scope's real paths.
 */
export const permits = Effect.fn("KinClaudeConfinement.permits")(function* (
  scope: FileScope,
  tool: string,
  input: unknown,
) {
  if (tool.startsWith("mcp__")) return scope.mcp !== false;
  const root = scope.root;
  if (root === undefined || !scope.tools.includes(tool)) return false;
  // The OS sandbox judges what a command reaches; this keeps every command inside it, in front.
  if (tool === "Bash")
    return (
      typeof textField(input, "command") === "string" &&
      isSet(input, "run_in_background") === false &&
      isSet(input, "dangerouslyDisableSandbox") === false
    );
  const targets = callTargets(tool, input);
  if (targets === undefined || !targets.globs.every(safeGlob)) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return (
      !path.isAbsolute(relative) &&
      relative.split(path.sep)[0] !== ".." &&
      !relative.split(path.sep).some((part) => part.toLowerCase() === ".git")
    );
  };
  // A missing tail is fine (Write makes it); a link that exists but resolves nowhere is not.
  const realTarget = Effect.fnUntraced(function* (target: string) {
    const tail: Array<string> = [];
    let current = target;
    while (true) {
      const real = yield* fs.realPath(current).pipe(Effect.orElseSucceed(() => undefined));
      if (real !== undefined) return path.join(real, ...tail.toReversed());
      const present = yield* fs.lstat(current).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      const parent = path.dirname(current);
      if (present || parent === current) return undefined;
      tail.push(path.basename(current));
      current = parent;
    }
  });
  // Grep and Glob walk the whole tree they are given, so every link in it must stay in the root;
  // read on each call, since a setup script can add links after the session starts.
  const treeInside = Effect.fnUntraced(function* (top: string) {
    let frontier = [top];
    let seen = 0;
    while (frontier.length > 0) {
      const listed = yield* Effect.forEach(
        frontier,
        (directory) =>
          fs.readDirectoryEntries(directory).pipe(
            Effect.map((entries) => entries.map((entry) => ({ entry, directory }))),
            Effect.orElseSucceed(() => undefined),
          ),
        { concurrency: walkConcurrency },
      );
      if (listed.some((entries) => entries === undefined)) return false;
      const entries = listed.flatMap((each) => each ?? []);
      seen += entries.length;
      if (seen > treeLimit) return false;
      const links = entries.flatMap(({ entry, directory }) =>
        entry.type === "SymbolicLink" ? [path.join(directory, entry.name)] : [],
      );
      const resolved = yield* Effect.forEach(
        links,
        (link) => fs.realPath(link).pipe(Effect.orElseSucceed(() => undefined)),
        { concurrency: walkConcurrency },
      );
      if (resolved.some((real) => real === undefined || !inside(root, real))) return false;
      frontier = entries.flatMap(({ entry, directory }) =>
        entry.type === "Directory" ? [path.join(directory, entry.name)] : [],
      );
    }
    return true;
  });
  for (const raw of targets.paths) {
    if (!safeText(raw) || raw.startsWith("~") || /^file:/i.test(raw)) return false;
    if (raw.split("/").includes("..")) return false;
    if (tool !== "Read" && gitHooks.has(path.basename(raw).toLowerCase())) return false;
    const lexical = path.resolve(root, raw);
    const real = yield* realTarget(lexical);
    if (real === undefined) return false;
    if (inside(root, lexical) && inside(root, real)) {
      if (tool !== "Grep" && tool !== "Glob") continue;
      const info = yield* fs.stat(real).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "Directory" || (yield* treeInside(real))) continue;
      return false;
    }
    const attachment =
      tool === "Read" &&
      scope.attachments !== undefined &&
      path.dirname(real) === scope.attachments &&
      attachmentName.test(path.basename(real));
    if (!attachment) return false;
  }
  return true;
});

/** Adds the confinement hook after any the session already runs; a deny from any hook wins. */
export const withConfinementHook = (
  hooks: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["hooks"],
  matcher: HookCallbackMatcher,
) => ({ ...hooks, PreToolUse: [...(hooks?.PreToolUse ?? []), matcher] });

/** What Claude Code needs to start and reach its model; Kin's own settings and tokens stay out. */
const keptVariables = new Set([
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
  "DBUS_SESSION_BUS_ADDRESS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ENABLE_TOOL_SEARCH",
  "MAX_THINKING_TOKENS",
  "MAX_MCP_OUTPUT_TOKENS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "API_TIMEOUT_MS",
]);
const keptPrefixes = /^(?:ANTHROPIC_|CLAUDE_|LC_|XDG_|AWS_|VERTEX_REGION_|DISABLE_)/;

export const sessionEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined && (keptVariables.has(name) || keptPrefixes.test(name)),
    ),
  );

// How Claude reaches its model (a gateway, Bedrock, Vertex). Read from the owner's user settings
// only, never a Kin checkout's project settings.
const authEnv = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLOUD_ML_REGION$|AWS_|VERTEX_REGION)/;
// Settings keys whose command Claude Code runs to get cloud or proxy credentials.
const credentialCommands = [
  "awsAuthRefresh",
  "awsCredentialExport",
  "gcpAuthRefresh",
  "proxyAuthHelper",
] as const;
const AuthFields = Schema.Struct({
  apiKeyHelper: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  awsAuthRefresh: Schema.optional(Schema.Unknown),
  awsCredentialExport: Schema.optional(Schema.Unknown),
  gcpAuthRefresh: Schema.optional(Schema.Unknown),
  proxyAuthHelper: Schema.optional(Schema.Unknown),
});
const UserAuthSettings = Schema.fromJsonString(AuthFields);
export type AuthSettings = {
  apiKeyHelper?: string;
  env?: Record<string, string>;
  /** The credential commands the owner's settings name; a worker refuses to start with any. */
  commands?: ReadonlyArray<string>;
};

/**
 * The owner's model credentials from their user settings, for a session that loads no settings
 * file: user settings also carry hooks, plugins and env that a Kin session must not inherit.
 */
export const ownerAuth = Effect.fn("KinClaudeConfinement.ownerAuth")(function* (
  env: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["env"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveClaudeHomePath({ homePath: "" }, env ?? process.env);
  const parsed = yield* fs.readFileString(path.join(home, "settings.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UserAuthSettings)),
    Effect.orElseSucceed(() => ({}) as AuthSettings),
  );
  return authSettings(parsed);
});

const authSettings = (parsed: typeof AuthFields.Type): AuthSettings => {
  const authOnly = Object.entries(parsed.env ?? {}).filter(([key]) => authEnv.test(key));
  const commands = credentialCommands.filter((key) => parsed[key] !== undefined);
  return {
    ...(parsed.apiKeyHelper === undefined ? {} : { apiKeyHelper: parsed.apiKeyHelper }),
    ...(authOnly.length === 0 ? {} : { env: Object.fromEntries(authOnly) }),
    ...(commands.length === 0 ? {} : { commands }),
  };
};

/**
 * Managed settings load whatever `settingSources` says, so their env and commands count as the
 * owner's. Read from the platform's managed file and its drop-in directory.
 */
export const managedAuth = Effect.fn("KinClaudeConfinement.managedAuth")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const directory =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  const dropIns = yield* fs.readDirectory(path.join(directory, "managed-settings.d")).pipe(
    Effect.map((names) =>
      names
        .filter((name) => name.endsWith(".json"))
        .toSorted()
        .map((name) => path.join(directory, "managed-settings.d", name)),
    ),
    Effect.orElseSucceed((): Array<string> => []),
  );
  const auth: Array<AuthSettings> = [];
  for (const file of [path.join(directory, "managed-settings.json"), ...dropIns]) {
    const parsed = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(UserAuthSettings)), Effect.option);
    if (parsed._tag === "Some") auth.push(authSettings(parsed.value));
  }
  return auth;
});

/** What a work session gets for its model: environment only, never a command to run. */
export interface SessionCredentials {
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The only variables a worker's model credential may set: a key or token and where it goes.
 * Anything else that picks a model provider is refused instead (`cloudModes`).
 */
const credentialVariables = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
] as const;
// Providers whose credential chains (AWS, Google, Azure) can run a configured command.
const cloudModes =
  /^CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY|MANTLE|ANTHROPIC_AWS|ANTHROPIC_GOOGLE_CLOUD|GATEWAY)$/;
const isOn = (value: string | undefined) =>
  value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

export const workerCredentialProblem = "workers need a Claude login or an API key on this server";

export type WorkerCredentials =
  | { readonly _tag: "resolved"; readonly credentials: SessionCredentials }
  | { readonly _tag: "refused"; readonly reason: string };

const HELPER_LIMIT = Duration.seconds(30);
const HELPER_OUTPUT_LIMIT = 16_384;

/**
 * A worker's model credential, resolved here so the child resolves none: a key or token from
 * the provider's environment or the owner's settings, the owner's `apiKeyHelper` run from the
 * home, or nothing, for the owner's Claude login. Bedrock, Vertex, Foundry and credential
 * commands are refused: their chains run what a config names, relative to the worktree.
 */
export const resolveWorkerCredentials = Effect.fn("KinClaudeConfinement.resolveWorkerCredentials")(
  function* (input: {
    readonly auth: AuthSettings;
    readonly managed: ReadonlyArray<AuthSettings>;
    readonly providerEnv: NodeJS.ProcessEnv;
  }) {
    const refused = (why: string): WorkerCredentials => ({
      _tag: "refused",
      reason: `${workerCredentialProblem} (${why})`,
    });
    const sources = [
      { from: "kin-server's environment", env: input.providerEnv, commands: [] },
      { from: "the owner's Claude settings", ...input.auth },
      ...input.managed.map((auth) => ({ from: "Claude Code's managed settings", ...auth })),
    ];
    for (const source of sources) {
      const mode = Object.keys(source.env ?? {}).find(
        (name) => cloudModes.test(name) && isOn(source.env?.[name]),
      );
      if (mode !== undefined) return refused(`${source.from} set ${mode}`);
      const command = source.commands?.[0];
      if (command !== undefined) return refused(`${source.from} set ${command}`);
    }
    const managedHelper = input.managed.find((auth) => auth.apiKeyHelper !== undefined);
    if (managedHelper !== undefined)
      return refused("Claude Code's managed settings set apiKeyHelper");
    // Claude Code applies settings `env` over its own environment.
    const merged: Record<string, string | undefined> = {
      ...input.providerEnv,
      ...input.auth.env,
      ...Object.assign({}, ...input.managed.map((auth) => auth.env ?? {})),
    };
    const env: Record<string, string> = {};
    for (const name of credentialVariables) {
      const value = merged[name];
      if (value !== undefined && value.length > 0) env[name] = value;
    }
    const resolved = (credentials: Record<string, string>): WorkerCredentials => ({
      _tag: "resolved",
      credentials: Object.keys(credentials).length === 0 ? {} : { env: credentials },
    });
    const helper = input.auth.apiKeyHelper;
    if (helper === undefined || env.ANTHROPIC_API_KEY !== undefined || env.ANTHROPIC_AUTH_TOKEN)
      return resolved(env);
    const key = yield* runKeyHelper(helper);
    if (Option.isNone(key)) return refused("the owner's apiKeyHelper gave no key");
    return resolved({ ...env, ANTHROPIC_API_KEY: key.value, ANTHROPIC_AUTH_TOKEN: key.value });
  },
);

/** Runs the owner's `apiKeyHelper` from the home, with the server's environment. */
const runKeyHelper = Effect.fn("KinClaudeConfinement.runKeyHelper")(function* (
  apiKeyHelper: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* HostProcess.HomeDirectory;
  const environment = yield* HostProcess.Environment;
  const key = yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", apiKeyHelper], {
        cwd: home,
        env: environment,
        extendEnv: false,
        stdin: "ignore",
        stderr: "ignore",
        forceKillAfter: Duration.seconds(2),
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const trimmed = output.trim();
    return exitCode === 0 &&
      trimmed.length > 0 &&
      trimmed.length <= HELPER_OUTPUT_LIMIT &&
      !/[\r\n]/.test(trimmed)
      ? trimmed
      : undefined;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(HELPER_LIMIT),
    Effect.map(Option.flatMap(Option.fromUndefinedOr)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(key))
    yield* Effect.logWarning("The owner's apiKeyHelper gave a Kin work session no key");
  return key;
});

/** Built where the query runner is: a runner's `open` can't require the filesystem itself. */
export const makeConfiner = Effect.fn("KinClaudeConfinement.makeConfiner")(function* () {
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const fs = yield* FileSystem.FileSystem;
  const run = Effect.runPromiseWith(context);
  return {
    /** The session cwd's real path; a cwd that doesn't resolve leaves the file tools nothing. */
    root: (cwd: string | undefined) =>
      cwd === undefined
        ? Effect.undefined
        : fs.realPath(cwd).pipe(Effect.orElseSucceed(() => undefined)),
    ownerAuth: (env: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["env"]) =>
      ownerAuth(env).pipe(Effect.provide(context)),
    managedAuth: managedAuth().pipe(Effect.provide(context)),
    /**
     * A `PreToolUse` hook runs in this process before Claude Code's permission modes, so its deny
     * holds under bypassPermissions too. `block` refuses the call if the hook throws or times out.
     */
    hook: (scope: FileScope): HookCallbackMatcher => ({
      onFailure: "block",
      hooks: [
        async (input) =>
          input.hook_event_name !== "PreToolUse" ||
          (await run(permits(scope, input.tool_name, input.tool_input)))
            ? {}
            : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
      ],
    }),
  };
});
