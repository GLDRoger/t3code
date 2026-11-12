// @effect-diagnostics nodeBuiltinImport:off -- a loopback model answers the real Claude Code.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { type HookCallback, query } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { workerCredentialProblem } from "../claudeConfinement.ts";
import { hookAllows, kinSecretVariables } from "../claudeConfinement.testkit.ts";
import * as WorkIsolation from "./WorkIsolation.ts";
import * as WorkSandbox from "./workSandbox.ts";
import * as WorkSession from "./workSession.ts";

// What T3 would hand any Claude thread, with every way to widen it the adapter knows.
const options = ClaudeAdapterV2.makeClaudeQueryOptions({
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-4-6",
  },
  nativeThreadId: "native",
  resume: false,
  cwd: "/worktree",
  attachmentsDir: "/attachments",
  settings: Schema.decodeSync(ClaudeSettings)({
    launchArgs:
      "--permission-mode bypassPermissions --mcp-config /mcp.json --add-dir /home --allowed-tools Bash",
  }),
  sdkSettings: {
    permissions: { allow: ["Bash(curl:*)", "WebFetch"] },
    alwaysThinkingEnabled: true,
    sandbox: { enabled: false, allowUnsandboxedCommands: true, excludedCommands: ["*"] },
    // Each of these runs or loads something outside the sandbox.
    apiKeyHelper: "sh ./key-helper.sh",
    awsAuthRefresh: "sh ./aws.sh",
    awsCredentialExport: "sh ./aws.sh",
    gcpAuthRefresh: "sh ./gcp.sh",
    otelHeadersHelper: "sh ./otel.sh",
    statusLine: { type: "command", command: "sh ./status.sh" },
    fileSuggestion: { type: "command", command: "sh ./files.sh" },
    outputStyle: "repo-style",
    enabledPlugins: { "repo@market": true },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "sh ./hook.sh" }] }] },
  },
  mcpServers: {
    t3: { type: "http", url: "http://127.0.0.1/mcp" },
    kin: { type: "http", url: "http://127.0.0.1/kin/mcp" },
  },
  allowedTools: ["mcp__t3__delegate_task", "mcp__kin__kin_chat_post"],
  permissionMode: "bypassPermissions",
});

const callerHook: HookCallback = () => Promise.resolve({});

/** Opens one session through the wrapper and returns the options the SDK would get. */
const opened = Effect.fn("WorkIsolationTest.opened")(function* (
  threadId: string,
  overrides: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly hooks?: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions["hooks"];
    readonly sandbox?: Layer.Layer<WorkSandbox.KinWorkSandbox>;
    readonly inputs?: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput>;
  },
) {
  const seen: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
  const base = Layer.succeed(
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
    ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: Effect.succeed("session"),
      open: (input) =>
        Effect.sync(() => {
          seen.push(input.options);
          overrides.inputs?.push(input);
        }).pipe(Effect.andThen(Effect.die("unused session"))),
      forkSession: () => Effect.die("unused fork"),
      subagentLaunchToolUseId: () => Effect.die("unused lookup"),
      assertComplete: Effect.void,
    }),
  );
  yield* Effect.gen(function* () {
    const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    yield* runner
      .open({
        threadId: ThreadId.make(threadId),
        providerSessionId: ProviderSessionId.make("session"),
        options: {
          ...options,
          cwd: overrides.cwd,
          // Never the developer's own Claude settings, whose helper the wrapper would run.
          env: overrides.env ?? { CLAUDE_CONFIG_DIR: "/nonexistent/kin-test-claude" },
          ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
          sandbox: { enabled: false, allowUnsandboxedCommands: true },
        },
      })
      .pipe(Effect.exit);
  }).pipe(
    Effect.provide(
      WorkIsolation.claudeQueryRunnerWith(
        base,
        overrides.sandbox ?? WorkSandbox.fileOnly("no sandbox in this test"),
      ),
    ),
  );
  return seen[0]!;
});

/** The installed Claude Code on this machine's PATH, if any; without one only the PATH is checked. */
const searchPath = process.env.PATH ?? "";
const installedClaude = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const directory of searchPath.split(":").filter(Boolean))
    if (yield* fs.exists(`${directory}/claude`)) return yield* fs.realPath(`${directory}/claude`);
  return undefined;
});

/** A worktree as T3 makes one: `.git` a file naming the main checkout's git directory. */
const worktree = Effect.fn("WorkIsolationTest.worktree")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const main = `${root}/main`;
  const tree = `${root}/worktrees/app`;
  yield* fs.makeDirectory(`${main}/.git/hooks`, { recursive: true });
  yield* fs.makeDirectory(`${main}/.git/worktrees/app`, { recursive: true });
  yield* fs.writeFileString(`${main}/.git/config`, "[core]\n");
  yield* fs.makeDirectory(`${tree}/src`, { recursive: true });
  yield* fs.writeFileString(`${tree}/.git`, `gitdir: ${main}/.git/worktrees/app\n`);
  yield* fs.writeFileString(`${tree}/README.md`, "# App\n");
  yield* fs.writeFileString(`${tree}/src/index.ts`, "export {};\n");
  yield* fs.writeFileString(`${root}/outside.md`, "secret\n");
  // A repository can carry links out; the wall follows them to where they really go.
  yield* fs.symlink(root, `${tree}/up`);
  yield* fs.symlink(`${root}/outside.md`, `${tree}/notes.md`);
  yield* fs.symlink(`${main}/.git`, `${tree}/gitdir`);
  return { root, main, tree };
});

it.live(
  "a work session has file tools in its worktree and no shell, subagent, web, MCP, settings file or helper",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const { root, tree } = yield* worktree();
      // A relative helper means the home's script to the server, never the worktree's.
      yield* fs.writeFileString(`${home}/key-helper.sh`, "printf 'fixture-key\\n'\n");
      yield* fs.writeFileString(`${tree}/key-helper.sh`, `touch '${root}/helper-ran'\n`);
      yield* fs.writeFileString(
        `${configDir}/settings.json`,
        JSON.stringify({
          apiKeyHelper: "sh ./key-helper.sh",
          env: { ANTHROPIC_BASE_URL: "https://gateway.test", NODE_OPTIONS: "--require /evil.js" },
          hooks: { PreToolUse: [] },
          permissions: { allow: ["Bash"] },
        }),
      );
      // A hostile server environment: whatever it holds, only the allow-list's names arrive.
      const env = {
        CLAUDE_CONFIG_DIR: configDir,
        PATH: ".:bin::/usr/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        TERM: "xterm",
        SHELL: "bash",
        TMPDIR: "tmp",
        HTTPS_PROXY: "http://proxy.test:3128",
        // Claude Code runs, sources or loads what each of these names.
        CLAUDE_CODE_SHELL_PREFIX: "/repo/wrap.sh",
        CLAUDE_CODE_PROCESS_WRAPPER: "/repo/launch",
        CLAUDE_CODE_SHELL: "/repo/bash",
        CLAUDE_ENV_FILE: "/repo/env.sh",
        CLAUDE_CODE_PLUGIN_DIRS: "/repo/plugins",
        CLAUDE_CODE_PLUGIN_SEED_DIR: "/repo/seed",
        CLAUDE_CODE_PLUGIN_CACHE_DIR: "/repo/cache",
        CLAUDE_CODE_CLIENT_CERT: "./cert.pem",
        CLAUDE_CODE_USE_POWERSHELL_TOOL: "1",
        // Credential chains and loaders of every kind a toolchain reads.
        AWS_CONFIG_FILE: "./aws-config",
        AWS_SHARED_CREDENTIALS_FILE: "/home/kin/.aws/credentials",
        AWS_PROFILE: "work",
        AWS_REGION: "us-east-1",
        GOOGLE_APPLICATION_CREDENTIALS: "./gcp.json",
        GCLOUD_PROJECT: "p",
        CLOUDSDK_CONFIG: "./gcloud",
        AZURE_CONFIG_DIR: "./azure",
        KUBECONFIG: "./kube",
        DOCKER_CONFIG: "./docker",
        NPM_CONFIG_USERCONFIG: "./npmrc",
        NODE_OPTIONS: "--require ./evil.js",
        NODE_PATH: "./lib",
        LD_PRELOAD: "./evil.so",
        LD_LIBRARY_PATH: "./lib",
        DYLD_INSERT_LIBRARIES: "./evil.dylib",
        GIT_DIR: "./.git",
        GIT_CONFIG_GLOBAL: "./gitconfig",
        GIT_SSH_COMMAND: "sh ./ssh.sh",
        SSH_AUTH_SOCK: "/run/user/1000/ssh",
        GPG_AGENT_INFO: "/run/user/1000/gnupg",
        GNUPGHOME: "./gnupg",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        XDG_CONFIG_HOME: "./config",
        XDG_RUNTIME_DIR: "/run/user/1000",
        BASH_ENV: "./bashrc",
        ENV: "./shrc",
        PYTHONSTARTUP: "./startup.py",
        PERL5OPT: "-Mevil",
        RUBYOPT: "-revil",
        ...Object.fromEntries(kinSecretVariables.map((name) => [name, "secret"])),
      };
      const inputs: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
      const work = yield* opened("kin-work:wk-fixture", {
        cwd: tree,
        env,
        hooks: { PreToolUse: [{ hooks: [callerHook] }] },
        inputs,
      }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Platform, "linux"),
        // The server finds no `vp` of its own here, whatever this machine has.
        Effect.provideService(HostProcess.Environment, { ...process.env, PATH: "/usr/bin:/bin" }),
      );
      const other = yield* opened("thread-1", { cwd: tree, env });

      const setByWrapper = new Set([
        "permissionMode",
        "settingSources",
        "strictMcpConfig",
        "tools",
        "disallowedTools",
        "systemPrompt",
        "hooks",
        "env",
        "settings",
        "extraArgs",
      ]);
      assert.deepStrictEqual(
        Object.keys(work).filter(
          (key) => !WorkSession.workOptionFields.has(key) && !setByWrapper.has(key),
        ),
        [],
      );
      assert.deepStrictEqual(work.tools, ["Read", "Grep", "Glob", "Edit", "Write"]);
      for (const tool of ["Bash", "Task", "Agent", "Workflow", "WebFetch", "WebSearch"])
        assert.include(work.disallowedTools ?? [], tool);
      assert.isUndefined(work.mcpServers);
      assert.isUndefined(work.sandbox);
      assert.isUndefined(work.allowedTools);
      assert.isUndefined(work.additionalDirectories);
      assert.isUndefined(work.allowDangerouslySkipPermissions);
      assert.strictEqual(work.strictMcpConfig, true);
      assert.deepStrictEqual(work.settingSources, []);
      assert.strictEqual(work.permissionMode, "acceptEdits");
      assert.deepStrictEqual(work.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: WorkSession.workPreamble,
      });
      // The helper ran here, from the home, and only its key reaches the child, sent as a helper's
      // would be; no hook, helper, plugin, style or env from any settings file.
      assert.deepStrictEqual(work.settings, {
        alwaysThinkingEnabled: true,
        showThinkingSummaries: true,
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.test",
          ANTHROPIC_API_KEY: "fixture-key",
          ANTHROPIC_AUTH_TOKEN: "fixture-key",
        },
      });
      assert.notInclude(JSON.stringify(work), "key-helper");
      assert.isFalse(yield* fs.exists(`${root}/helper-ran`));
      // Built from nothing: the private home, the provider's Claude home for the login, a PATH
      // and shell Kin chose, and the locale, terminal and proxy basics.
      const { PATH: path, ...rest } = work.env ?? {};
      assert.deepStrictEqual(rest, {
        LANG: "C.UTF-8",
        LC_ALL: "C",
        TERM: "xterm",
        HTTPS_PROXY: "http://proxy.test:3128",
        SHELL: yield* fs.realPath("/bin/bash"),
        HOME: "/nonexistent/kin-worker-home",
        CLAUDE_CONFIG_DIR: configDir,
      });
      assert.isTrue((path ?? "").split(":").every((entry) => entry.startsWith("/")));
      assert.include((path ?? "").split(":"), yield* fs.realPath("/usr/bin"));
      // Its own systemd scope gets the worker's limits.
      assert.deepStrictEqual(
        inputs[0]?.scopeProperties,
        WorkSandbox.workerScopeProperties(WorkSandbox.hostWorkerLimits),
      );
      // The caller's hooks are dropped; the one left is the confinement hook, which blocks on error.
      assert.deepStrictEqual(Object.keys(work.hooks ?? {}), ["PreToolUse"]);
      assert.strictEqual(work.hooks?.PreToolUse?.length, 1);
      assert.notInclude(work.hooks?.PreToolUse?.[0]?.hooks ?? [], callerHook);
      assert.strictEqual(work.hooks?.PreToolUse?.[0]?.onFailure, "block");
      // Any other thread is untouched.
      assert.deepStrictEqual(other.mcpServers, options.mcpServers);
      assert.strictEqual(other.permissionMode, "bypassPermissions");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a work session's file tools reach its worktree's real files and nothing else", () =>
  Effect.gen(function* () {
    const { root, main, tree } = yield* worktree();
    const work = yield* opened("kin-work:wk-fixture", { cwd: tree });
    const allows = (tool: string, input: unknown) =>
      Effect.promise(() => hookAllows(work, tool, input));
    for (const [tool, input] of [
      ["Read", { file_path: "README.md" }],
      ["Read", { file_path: `${tree}/src/index.ts` }],
      ["Edit", { file_path: "README.md", old_string: "# App", new_string: "# Acme" }],
      ["Write", { file_path: "src/new.ts", content: "export {};\n" }],
      ["Write", { file_path: ".github/workflows/ci.yml", content: "on: push\n" }],
      ["Grep", { pattern: "App", path: "src", glob: "*.ts" }],
      ["Glob", { pattern: "**/*.ts", path: "src" }],
    ] as const)
      assert.isTrue(yield* allows(tool, input), `${tool} ${JSON.stringify(input)}`);

    const escapes = [
      "../outside.md",
      "src/../../outside.md",
      `${root}/outside.md`,
      "/etc/passwd",
      "~/.ssh/id_ed25519",
      "file:///etc/passwd",
      "notes.md",
      "up/outside.md",
      ".git",
      `${main}/.git/config`,
      `${main}/.git/hooks/pre-commit`,
      "gitdir/config",
      "gitdir/hooks/pre-commit",
    ];
    for (const path of escapes) {
      assert.isFalse(yield* allows("Read", { file_path: path }), `Read ${path}`);
      assert.isFalse(
        yield* allows("Edit", { file_path: path, old_string: "a", new_string: "b" }),
        `Edit ${path}`,
      );
      assert.isFalse(yield* allows("Write", { file_path: path, content: "x" }), `Write ${path}`);
      assert.isFalse(yield* allows("Grep", { pattern: "x", path }), `Grep ${path}`);
      assert.isFalse(yield* allows("Glob", { pattern: "*", path }), `Glob ${path}`);
    }
    for (const [tool, input] of [
      // The worktree's root holds links out, so a search over it is refused.
      ["Grep", { pattern: "App" }],
      ["Glob", { pattern: "**/*.md" }],
      ["Glob", { pattern: "../*" }],
      ["Glob", { pattern: "/etc/*" }],
      ["Glob", { pattern: ".git/**" }],
      ["Grep", { pattern: "x", glob: "../**" }],
      ["Grep", { pattern: "x", glob: "{src,/etc}/*" }],
      // No other tool, whatever it is called, and no MCP tool of any server.
      ["Bash", { command: "cat ~/.t3/userdata/secrets" }],
      ["NotebookEdit", { notebook_path: "a.ipynb", new_source: "x" }],
      ["Task", { prompt: "x" }],
      ["WebFetch", { url: "https://example.com" }],
      ["mcp__t3__delegate_task", { task: "x" }],
      ["mcp__kin__kin_chat_post", { chatId: "c", body: "x" }],
    ] as const)
      assert.isFalse(yield* allows(tool, input), `${tool} ${JSON.stringify(input)}`);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a work session's Grep and Glob refuse a tree holding a link out, even one made after start",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const tree = `${base}/worktrees/app`;
      yield* fs.makeDirectory(`${tree}/src`, { recursive: true });
      yield* fs.makeDirectory(`${tree}/docs/nested`, { recursive: true });
      yield* fs.makeDirectory(`${base}/outside`, { recursive: true });
      yield* fs.writeFileString(`${tree}/src/real.txt`, "marker\n");
      yield* fs.writeFileString(`${base}/outside/secret.txt`, "marker\n");
      yield* fs.symlink("src", `${tree}/inlink`);
      const work = yield* opened("kin-work:wk-fixture", { cwd: tree });
      const allows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(work, tool, input));
      const searches = (path?: string) =>
        [
          ["Grep", { pattern: "marker", ...(path === undefined ? {} : { path }) }],
          ["Glob", { pattern: "**/*", ...(path === undefined ? {} : { path }) }],
        ] as const;

      // A link that stays inside works like the directory it names.
      for (const [tool, input] of [...searches(), ...searches("inlink"), ...searches("src")])
        assert.isTrue(yield* allows(tool, input), `${tool} ${JSON.stringify(input)}`);
      assert.isTrue(yield* allows("Read", { file_path: "inlink/real.txt" }));
      assert.isTrue(yield* allows("Write", { file_path: "inlink/new.txt", content: "x" }));

      for (const [link, target, through] of [
        ["dirlink", `${base}/outside`, "dirlink/secret.txt"],
        ["filelink.txt", `${base}/outside/secret.txt`, "filelink.txt"],
        ["uplink", "../../..", "uplink"],
        ["dangling", `${base}/outside/missing`, "dangling"],
      ] as const) {
        // Made after the session started, as a setup script still running could.
        yield* fs.symlink(target, `${tree}/docs/nested/${link}`);
        for (const [tool, input] of [...searches(), ...searches("docs"), ...searches(".")])
          assert.isFalse(yield* allows(tool, input), `${link}: ${tool} ${JSON.stringify(input)}`);
        for (const [tool, input] of searches("src"))
          assert.isTrue(yield* allows(tool, input), `${link}: ${tool} ${JSON.stringify(input)}`);
        const named = `docs/nested/${through}`;
        assert.isFalse(yield* allows("Read", { file_path: named }), `${link}: Read`);
        assert.isFalse(
          yield* allows("Write", { file_path: named, content: "x" }),
          `${link}: Write`,
        );
        assert.isFalse(
          yield* allows("Edit", { file_path: named, old_string: "marker", new_string: "x" }),
          `${link}: Edit`,
        );
        yield* fs.remove(`${tree}/docs/nested/${link}`);
        assert.isTrue(yield* allows("Grep", { pattern: "marker" }), `${link} removed`);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a work session gets a shell only from a proven sandbox, and then Bash alone inside it",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        `${configDir}/settings.json`,
        JSON.stringify({
          env: { ANTHROPIC_AUTH_TOKEN: "gateway", ANTHROPIC_BASE_URL: "https://g" },
        }),
      );
      const { tree } = yield* worktree();
      const sandbox = {
        enabled: true,
        allowUnsandboxedCommands: false,
        credentials: { envVars: [{ name: "ANTHROPIC_BASE_URL", mode: "deny" as const }] },
      };
      const asked: Array<string | undefined> = [];
      const proven = Layer.succeed(
        WorkSandbox.KinWorkSandbox,
        WorkSandbox.KinWorkSandbox.of({
          prepare: Effect.fn("WorkIsolationTest.prepare")((input) => {
            asked.push(input.worktree);
            return Effect.succeed({
              _tag: "shell",
              place: { home: "/state/kin/worker-home", configDir: configDir },
              paths: { PATH: "/usr/bin" },
              sandbox,
              tmp: "/tmp/kin-task",
              release: Effect.void,
              noteMessage: () => Effect.void,
            } as const);
          }),
        }),
      );
      const work = yield* opened("kin-work:wk-fixture", {
        cwd: tree,
        env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "secret", CLAUDE_CONFIG_DIR: configDir },
        sandbox: proven,
      });
      assert.deepStrictEqual(asked, [tree]);
      assert.deepStrictEqual(work.tools, ["Bash"]);
      for (const tool of ["Read", "Edit", "Write", "Grep", "Glob", "Task", "WebFetch", "Monitor"])
        assert.include(work.disallowedTools ?? [], tool);
      // The prepared sandbox replaces anything the adapter, a settings block or a launch arg said,
      // and the owner's settings `env`, which Claude Code applies to its own environment, is unset.
      assert.deepStrictEqual(work.sandbox, {
        ...sandbox,
        credentials: {
          envVars: [
            "ANTHROPIC_BASE_URL",
            ...Object.keys(WorkSession.commandLimits).toSorted(),
            "CLAUDE_CODE_TMPDIR",
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
          ].map((name) => ({ name, mode: "deny" as const })),
        },
      });
      assert.notProperty(work.settings ?? {}, "sandbox");
      assert.deepStrictEqual(work.env, {
        PATH: "/usr/bin",
        HOME: "/state/kin/worker-home",
        CLAUDE_CONFIG_DIR: configDir,
        ...WorkSession.commandLimits,
        CLAUDE_CODE_TMPDIR: "/tmp/kin-task",
        // Claude Code's proxy sockets go in its own temp directory, the one its commands can reach.
        TMPDIR: "/tmp/kin-task",
      });
      assert.deepStrictEqual(work.settingSources, []);
      assert.strictEqual(work.strictMcpConfig, true);
      assert.isUndefined(work.mcpServers);
      assert.strictEqual(work.permissionMode, "bypassPermissions");
      assert.deepStrictEqual(work.systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: WorkSession.shellPreamble,
      });
      const allows = (tool: string, input: unknown) =>
        Effect.promise(() => hookAllows(work, tool, input));
      assert.isTrue(yield* allows("Bash", { command: "npm test" }));
      assert.isFalse(yield* allows("Bash", { command: "npm start", run_in_background: true }));
      assert.isFalse(yield* allows("Bash", { command: "x", dangerouslyDisableSandbox: true }));
      assert.isFalse(yield* allows("Read", { file_path: "README.md" }));
      assert.isFalse(yield* allows("mcp__t3__delegate_task", { task: "x" }));

      // Unproven, the same thread stays file-only, and the hook refuses every shell call.
      const unproven = yield* opened("kin-work:wk-fixture", { cwd: tree });
      assert.deepStrictEqual(unproven.tools, ["Read", "Grep", "Glob", "Edit", "Write"]);
      assert.include(unproven.disallowedTools ?? [], "Bash");
      assert.isUndefined(unproven.sandbox);
      assert.isFalse(
        yield* Effect.promise(() => hookAllows(unproven, "Bash", { command: "true" })),
      );
      // Any other thread never asks for a shell.
      asked.length = 0;
      yield* opened("thread-1", { cwd: tree, sandbox: proven });
      assert.deepStrictEqual(asked, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a server set up for Bedrock, Vertex or a credential command starts no worker, and says why",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, tree } = yield* worktree();
      const configDir = yield* fs.makeTempDirectoryScoped();
      // The reviewer's experiment: a relative credential_process that would run the worktree's
      // script, unsandboxed, from Claude Code's AWS credential chain.
      yield* fs.writeFileString(`${tree}/credential.sh`, `touch '${root}/credential-ran'\n`);
      yield* fs.writeFileString(
        `${root}/aws-config`,
        "[profile kin]\ncredential_process = sh ./credential.sh\n",
      );
      const bedrock = {
        CLAUDE_CONFIG_DIR: configDir,
        PATH: "/usr/bin",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_CONFIG_FILE: `${root}/aws-config`,
        AWS_PROFILE: "kin",
        AWS_REGION: "us-east-1",
      };
      const settings = (value: object) =>
        fs.writeFileString(`${configDir}/settings.json`, JSON.stringify(value));
      const start = Effect.fn("WorkIsolationTest.start")(function* (env: NodeJS.ProcessEnv) {
        const seen: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const base = Layer.succeed(
          ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
          ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
            allocateSessionId: Effect.succeed("session"),
            open: (input) =>
              Effect.sync(() => seen.push(input)).pipe(Effect.andThen(Effect.die("unused"))),
            forkSession: () => Effect.die("unused fork"),
            subagentLaunchToolUseId: () => Effect.die("unused lookup"),
            assertComplete: Effect.void,
          }),
        );
        const sandbox = WorkSandbox.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-refuse-" })),
          Layer.provide(SecureRandom.layerWebCrypto),
        );
        return yield* Effect.gen(function* () {
          const exit = yield* (yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner)
            .open({
              threadId: ThreadId.make("kin-work:wk-refused"),
              providerSessionId: ProviderSessionId.make("session"),
              options: { ...options, cwd: tree, env },
            })
            .pipe(Effect.exit);
          const { stateDir } = yield* ServerConfig;
          return { exit, seen, status: yield* WorkSandbox.readStatus(stateDir) };
        }).pipe(
          Effect.provide(
            Layer.mergeAll(WorkIsolation.claudeQueryRunnerWith(base, sandbox), sandbox),
          ),
        );
      });
      for (const [env, owner, why] of [
        [bedrock, {}, "CLAUDE_CODE_USE_BEDROCK"],
        [{ ...bedrock, CLAUDE_CODE_USE_BEDROCK: "true" }, {}, "CLAUDE_CODE_USE_BEDROCK"],
        [{ CLAUDE_CONFIG_DIR: configDir }, { env: { CLAUDE_CODE_USE_VERTEX: "1" } }, "VERTEX"],
        [{ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_USE_FOUNDRY: "1" }, {}, "FOUNDRY"],
        [{ CLAUDE_CONFIG_DIR: configDir }, { awsAuthRefresh: "sh ./aws.sh" }, "awsAuthRefresh"],
        [{ CLAUDE_CONFIG_DIR: configDir }, { gcpAuthRefresh: "sh ./gcp.sh" }, "gcpAuthRefresh"],
      ] as const) {
        yield* settings(owner);
        const { exit, seen, status } = yield* start(env);
        assert.isTrue(Exit.isFailure(exit), why);
        // Not even a file-only session opens.
        assert.deepStrictEqual(seen, [], why);
        assert.isFalse(yield* fs.exists(`${root}/credential-ran`), why);
        const recorded = Option.getOrUndefined(status);
        assert.isTrue(recorded?.refused, why);
        assert.isFalse(recorded?.shell, why);
        assert.include(recorded?.reason ?? "", workerCredentialProblem, why);
        assert.include(recorded?.reason ?? "", why, why);
      }
      // Switched off, the same server starts a worker; the AWS variables never reach it.
      yield* settings({});
      const { exit, seen } = yield* start({ ...bedrock, CLAUDE_CODE_USE_BEDROCK: "0" });
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(seen.length, 1);
      assert.notInclude(
        Object.keys(seen[0]?.options.env ?? {}).join(","),
        "AWS_",
        "no AWS variable reaches a worker",
      );
      assert.isFalse(yield* fs.exists(`${root}/credential-ran`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "a repository's tools on the provider's PATH never run in a worker's Claude Code, file-only included",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, tree } = yield* worktree();
      const configDir = `${root}/claude`;
      const home = `${root}/home`;
      yield* fs.makeDirectory(configDir);
      yield* fs.makeDirectory(home);
      yield* fs.makeDirectory(`${tree}/bin`);
      // The reviewer's shim: Claude Code's own process runs git at start, from PATH.
      yield* fs.writeFileString(
        `${tree}/bin/git`,
        `#!/bin/sh\necho git >> '${root}/executed'\nexec /usr/bin/git "$@"\n`,
      );
      yield* fs.chmod(`${tree}/bin/git`, 0o755);
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const created = NodeHttp.createServer((request, response) => {
            request.resume();
            request.on("end", () => {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  id: "msg_fixture",
                  type: "message",
                  role: "assistant",
                  model: "claude-haiku-4-5",
                  content: [{ type: "text", text: "done" }],
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                }),
              );
            });
          });
          created.listen(0, "127.0.0.1", () => resume(Effect.succeed(created)));
        }),
        (created) => Effect.sync(() => created.close()),
      );
      const port = (server.address() as NodeNet.AddressInfo).port;
      const claude = yield* installedClaude;
      const seen: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
      const base = Layer.succeed(
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
        ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
          allocateSessionId: Effect.succeed("session"),
          open: (input) =>
            Effect.sync(() => seen.push(input.options)).pipe(Effect.andThen(Effect.die("unused"))),
          forkSession: () => Effect.die("unused fork"),
          subagentLaunchToolUseId: () => Effect.die("unused lookup"),
          assertComplete: Effect.void,
        }),
      );
      const sandbox = WorkSandbox.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-path-" })),
        Layer.provide(SecureRandom.layerWebCrypto),
      );
      yield* Effect.flatMap(Effect.service(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner), (runner) =>
        runner.open({
          threadId: ThreadId.make("kin-work:wk-path"),
          providerSessionId: ProviderSessionId.make("session"),
          options: {
            ...options,
            model: "claude-haiku-4-5",
            cwd: tree,
            ...(claude === undefined ? {} : { pathToClaudeCodeExecutable: claude }),
            env: {
              PATH: `${tree}/bin:/usr/bin:/bin`,
              CLAUDE_CONFIG_DIR: configDir,
              ANTHROPIC_API_KEY: "fixture-only",
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
            },
          },
        }),
      ).pipe(
        Effect.exit,
        Effect.provide(WorkIsolation.claudeQueryRunnerWith(base, sandbox)),
        // A Mac's worker is file-only, so the check never runs; the fixture home stands in.
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      const work = seen[0]!;
      // With Claude Code installed here, run its real start against the loopback model.
      if (claude !== undefined)
        yield* Effect.promise(async () => {
          const session = query({
            prompt: "Say done.",
            // The CLI wants a UUID; the adapter's own is the fixture's "native".
            options: {
              ...work,
              sessionId: "00000000-0000-4000-8000-000000000289",
              persistSession: false,
              maxTurns: 1,
            },
          });
          try {
            for await (const _message of session);
          } finally {
            session.close();
          }
        });
      assert.isFalse(yield* fs.exists(`${root}/executed`), "the repository's git ran");
      assert.isFalse((work.env?.PATH ?? "").split(":").some((entry) => entry.startsWith(tree)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
