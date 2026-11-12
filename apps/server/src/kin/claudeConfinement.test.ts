import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Confinement from "./claudeConfinement.ts";
import { dreamTools } from "./dreaming/DreamIsolation.ts";
import { leadTools } from "./lead/LeadIsolation.ts";

const home = NodeOS.homedir();

it.effect("a Kin session's file tools reach only its real checkout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const root = `${base}/kin/org/memory-read-a`;
    const other = `${base}/kin/org/memory-read-b`;
    const attachments = `${base}/attachments`;
    for (const directory of [`${root}/sub`, `${root}/.git`, other, `${base}/outside`])
      yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.makeDirectory(`${attachments}/sub`, { recursive: true });
    for (const file of [
      `${root}/notes.md`,
      `${root}/sub/deep.md`,
      `${root}/.git/config`,
      `${root}/.git/credentials`,
      `${other}/notes.md`,
      `${base}/outside/secret.txt`,
      `${attachments}/kin-chat-thread-0f6c3c1e-6c4a-4e57-9a0b-0d3b1f6f2a11.pdf`,
      `${attachments}/kin-chat-thread-0f6c3c1e-6c4a-4e57-9a0b-0d3b1f6f2a11.pdf.txt`,
      `${attachments}/thread-1-0f6c3c1e-6c4a-4e57-9a0b-0d3b1f6f2a11.txt`,
      `${attachments}/sub/kin-chat-nested.txt`,
    ])
      yield* fs.writeFileString(file, "x");
    yield* fs.symlink(`${base}/outside/secret.txt`, `${root}/link-out`);
    yield* fs.symlink(`${base}/outside`, `${root}/link-dir`);
    yield* fs.symlink(`${base}/outside/missing.txt`, `${root}/dangling`);
    yield* fs.symlink(`${root}/.git/config`, `${root}/link-git`);
    yield* fs.symlink(other, `${root}/link-other`);
    yield* fs.symlink(`${base}/outside/secret.txt`, `${attachments}/kin-chat-link.txt`);

    const lead = { root, tools: leadTools, attachments };
    const dream = { root, tools: dreamTools };
    const shared = { root: undefined, tools: [] };
    const shell = { root, tools: ["Bash"], mcp: false };
    const rootless = { root: undefined, tools: ["Bash"], mcp: false };
    const attachment = `${attachments}/kin-chat-thread-0f6c3c1e-6c4a-4e57-9a0b-0d3b1f6f2a11.pdf`;
    const refusedPaths = [
      `${home}/.local/share/keyrings/login.keyring`,
      "~/.local/share/keyrings/login.keyring",
      `${home}/.claude/settings.json`,
      "~/.claude/settings.json",
      "~/.codex/auth.json",
      "/proc/self/environ",
      "/proc/1/environ",
      "/etc/passwd",
      "file:///etc/passwd",
      `file://${root}/notes.md`,
      `${other}/notes.md`,
      "../memory-read-b/notes.md",
      "../../../../../../../../etc/passwd",
      "sub/../notes.md",
      "link-out",
      "link-dir/secret.txt",
      "link-other/notes.md",
      ".git/config",
      ".git/credentials",
      ".GIT/config",
      `${root}/.git/config`,
      "link-git",
      "notes.md\u0000",
      "notes.md\u0000/../../etc/passwd",
      "sub\\..\\..\\memory-read-b\\notes.md",
      `${"a/".repeat(3000)}notes.md`,
      "/",
      home,
      `${base}/kin`,
    ];
    const rows: ReadonlyArray<readonly [Confinement.FileScope, string, unknown, boolean, string?]> =
      [
        [lead, "Read", { file_path: "notes.md" }, true],
        [lead, "Read", { file_path: `${root}/sub/deep.md` }, true],
        [lead, "Read", { file_path: `${root}/notes.md`, offset: 1, limit: 5 }, true],
        [lead, "Read", { file_path: attachment }, true, "its own turn's attachment"],
        [lead, "Read", { file_path: `${attachment}.txt` }, true, "extracted attachment text"],
        ...refusedPaths.map((file) => [lead, "Read", { file_path: file }, false] as const),
        [
          lead,
          "Read",
          { file_path: `${attachments}/thread-1-0f6c3c1e-6c4a-4e57-9a0b-0d3b1f6f2a11.txt` },
          false,
          "a non-Kin attachment",
        ],
        [lead, "Read", { file_path: `${attachments}/sub/kin-chat-nested.txt` }, false],
        [lead, "Read", { file_path: `${attachments}/kin-chat-link.txt` }, false],
        [lead, "Read", { file_path: attachments }, false],
        [lead, "Read", { file_path: 5 }, false],
        [lead, "Read", {}, false],
        [lead, "Read", "notes.md", false],
        [lead, "Grep", { pattern: "token" }, false, "the root holds links out"],
        [lead, "Grep", { pattern: "token", path: "sub", glob: "**/*.md" }, true],
        [lead, "Grep", { pattern: "token", path: root, output_mode: "content" }, false],
        ...refusedPaths.map(
          (searched) => [lead, "Grep", { pattern: "token", path: searched }, false] as const,
        ),
        [lead, "Grep", { pattern: "token", path: ".git" }, false],
        [lead, "Grep", { pattern: "token", path: attachments }, false],
        [lead, "Grep", { pattern: "token", path: attachment }, false],
        [lead, "Grep", { pattern: "token", glob: "/**" }, false],
        [lead, "Grep", { pattern: "token", glob: "/etc/*" }, false],
        [lead, "Grep", { pattern: "token", glob: "../**" }, false],
        [lead, "Grep", { pattern: "token", glob: "~/**" }, false],
        [lead, "Grep", { pattern: "token", glob: "{/etc/*,*.md}" }, false],
        [lead, "Grep", { pattern: "token", glob: ".git/**" }, false],
        [lead, "Grep", { pattern: "token", glob: "**/.git/config" }, false],
        [lead, "Grep", { pattern: "token", path: 7 }, false],
        [lead, "Glob", { pattern: "**/*.md" }, false, "the root holds links out"],
        [lead, "Glob", { pattern: "*.md", path: "sub" }, true],
        ...refusedPaths.map(
          (searched) => [lead, "Glob", { pattern: "**/*", path: searched }, false] as const,
        ),
        [lead, "Glob", { pattern: "/**" }, false],
        [lead, "Glob", { pattern: "/**/*" }, false],
        [lead, "Glob", { pattern: `${home}/**` }, false],
        [lead, "Glob", { pattern: "/proc/*/environ" }, false],
        [lead, "Glob", { pattern: "../**" }, false],
        [lead, "Glob", { pattern: "~/.ssh/*" }, false],
        [lead, "Glob", { pattern: "{/etc,/home}/**" }, false],
        [lead, "Glob", { pattern: ".git/*" }, false],
        [lead, "Glob", { pattern: "*\u0000" }, false],
        [lead, "Glob", { path: "sub" }, false],
        [lead, "Glob", { pattern: "*", path: attachments }, false],
        [lead, "mcp__kin__kin_chat_post", { text: "/etc/passwd" }, true],
        [lead, "Edit", { file_path: "notes.md", old_string: "x", new_string: "y" }, false],
        [lead, "Write", { file_path: "new.md", content: "x" }, false],
        [lead, "Bash", { command: "cat /etc/passwd" }, false],
        [lead, "NotebookEdit", { notebook_path: "notes.ipynb" }, false],
        [lead, "LS", { path: "." }, false],
        [shared, "Read", { file_path: "notes.md" }, false],
        [shared, "Glob", { pattern: "*" }, false],
        [shared, "mcp__kin__kin_chat_post", { text: "hi" }, true],
        [dream, "Read", { file_path: "notes.md" }, true],
        [dream, "Edit", { file_path: "notes.md", old_string: "x", new_string: "y" }, true],
        [dream, "Write", { file_path: `${root}/new/item.md`, content: "x" }, true],
        [dream, "Read", { file_path: attachment }, false],
        ...refusedPaths.map((file) => [dream, "Read", { file_path: file }, false] as const),
        ...refusedPaths.map(
          (file) => [dream, "Write", { file_path: file, content: "x" }, false] as const,
        ),
        ...refusedPaths.map(
          (file) =>
            [dream, "Edit", { file_path: file, old_string: "x", new_string: "y" }, false] as const,
        ),
        [dream, "Write", { file_path: "dangling", content: "x" }, false],
        [dream, "Write", { file_path: "link-dir/new.md", content: "x" }, false],
        [dream, "Write", { file_path: "~/.bashrc", content: "x" }, false],
        [dream, "Write", { file_path: ".git/hooks/post-checkout", content: "x" }, false],
        [
          dream,
          "Edit",
          { file_path: ".githooks/post-index-change", old_string: "x", new_string: "y" },
          false,
          "a hook a relative hooksPath runs",
        ],
        [dream, "Write", { file_path: "hooks/Reference-Transaction", content: "x" }, false],
        [dream, "Read", { file_path: "hooks/post-checkout" }, true],
        [dream, "Grep", { pattern: "x", path: "/" }, false],
        [dream, "Glob", { pattern: "/**" }, false],
        [dream, "Bash", { command: "true" }, false],
        [shell, "Bash", { command: "npm test", timeout: 600_000, description: "x" }, true],
        [shell, "Bash", { command: "cat ~/.ssh/id_ed25519" }, true, "the OS sandbox refuses it"],
        [shell, "Bash", { command: "sleep 1", run_in_background: false }, true],
        [shell, "Bash", { command: "npm run dev", run_in_background: true }, false],
        [shell, "Bash", { command: "npm run dev", run_in_background: "yes" }, false],
        [shell, "Bash", { command: "curl x", dangerouslyDisableSandbox: true }, false],
        [shell, "Bash", { command: "curl x", dangerouslyDisableSandbox: 1 }, false],
        [shell, "Bash", { command: 7 }, false],
        [shell, "Bash", {}, false],
        [shell, "Bash", "npm test", false],
        [rootless, "Bash", { command: "true" }, false],
        [shell, "Read", { file_path: "notes.md" }, false, "a shell worker has no file tools"],
        [shell, "Write", { file_path: "new.md", content: "x" }, false],
        [shell, "BashOutput", { bash_id: "1" }, false],
        [shell, "Monitor", { command: "tail -f x" }, false],
        [shell, "mcp__t3__delegate_task", { task: "x" }, false],
      ];
    const mismatches: Array<string> = [];
    for (const [scope, tool, input, expected, note] of rows) {
      const actual = yield* Confinement.permits(scope, tool, input);
      if (actual !== expected)
        mismatches.push(
          `${scope === lead ? "lead" : scope === dream ? "dream" : scope === shell ? "shell" : "shared"} ${tool} ${JSON.stringify(input).slice(0, 160)}${note === undefined ? "" : ` (${note})`}: ${actual}`,
        );
    }
    assert.deepStrictEqual(mismatches, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "a worker's credential is resolved here: a key or token, the owner's helper, or the login",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const helper = `printf 'helper-key\\n'; touch '${base}/helper-ran'`;
      const resolve = (
        input: Partial<Parameters<typeof Confinement.resolveWorkerCredentials>[0]>,
      ) =>
        Confinement.resolveWorkerCredentials({ auth: {}, managed: [], providerEnv: {}, ...input });
      const resolved = (env: Record<string, string>) => ({
        _tag: "resolved" as const,
        credentials: Object.keys(env).length === 0 ? {} : { env },
      });
      // A key in the environment outranks the helper, which then never runs.
      assert.deepStrictEqual(
        yield* resolve({
          providerEnv: { ANTHROPIC_API_KEY: "env-key", AWS_PROFILE: "x", PATH: "/usr/bin" },
          auth: { apiKeyHelper: helper, env: { ANTHROPIC_BASE_URL: "https://gw.test" } },
        }),
        resolved({ ANTHROPIC_API_KEY: "env-key", ANTHROPIC_BASE_URL: "https://gw.test" }),
      );
      assert.isFalse(yield* fs.exists(`${base}/helper-ran`));
      assert.deepStrictEqual(
        yield* resolve({ auth: { apiKeyHelper: helper } }),
        resolved({ ANTHROPIC_API_KEY: "helper-key", ANTHROPIC_AUTH_TOKEN: "helper-key" }),
      );
      assert.deepStrictEqual(
        yield* resolve({ providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: "oat" } }),
        resolved({ CLAUDE_CODE_OAUTH_TOKEN: "oat" }),
      );
      // Nothing set: the owner's login, which Claude Code reads from the provider's home.
      assert.deepStrictEqual(yield* resolve({}), resolved({}));
      // An empty cloud switch is off, as Claude Code reads it.
      assert.deepStrictEqual(
        yield* resolve({ providerEnv: { CLAUDE_CODE_USE_BEDROCK: "" } }),
        resolved({}),
      );
      for (const [input, why] of [
        [{ auth: { apiKeyHelper: "sh -c 'exit 1'" } }, "gave no key"],
        [
          { managed: [{ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }] },
          "managed settings set CLAUDE_CODE_USE_BEDROCK",
        ],
        [{ managed: [{ apiKeyHelper: "./key.sh" }] }, "managed settings set apiKeyHelper"],
        [{ auth: { commands: ["awsCredentialExport"] } }, "awsCredentialExport"],
        [{ providerEnv: { CLAUDE_CODE_USE_MANTLE: "1" } }, "CLAUDE_CODE_USE_MANTLE"],
      ] as const) {
        const result = yield* resolve(input);
        assert.strictEqual(result._tag, "refused", why);
        assert.include(result._tag === "refused" ? result.reason : "", why);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
