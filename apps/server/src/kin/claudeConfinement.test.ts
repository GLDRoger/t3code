import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Confinement from "./claudeConfinement.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  AGENT_POSTS_FILE,
  agentShellScripts,
  APP_IDENTITY_FILE,
  APP_REPOS_FOLDER,
  APP_TOKENS_FOLDER,
  GH_APP_FOLDER,
  OWNER_USES_FILE,
} from "./github/ghSign.ts";
import { dreamTools } from "./dreaming/DreamIsolation.ts";
const readTools = ["Read", "Grep", "Glob"];

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

    const lead = { root, tools: readTools, attachments };
    const dream = { root, tools: dreamTools };
    const shared = { root: undefined, tools: [] };
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
        [rootless, "Bash", { command: "true" }, false],
      ];
    const mismatches: Array<string> = [];
    for (const [scope, tool, input, expected, note] of rows) {
      const actual = yield* Confinement.permits(scope, tool, input);
      if (actual !== expected)
        mismatches.push(
          `${scope === lead ? "lead" : scope === dream ? "dream" : "shared"} ${tool} ${JSON.stringify(input).slice(0, 160)}${note === undefined ? "" : ` (${note})`}: ${actual}`,
        );
    }
    assert.deepStrictEqual(mismatches, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The host probe (ops/kin/host/shell-wall-probe) runs this exact policy on the Linux host, where
// it matters; `vp test run src/kin/claudeConfinement.test.ts -u` rewrites it after a change.
it.effect("the host probe runs the owner seat's own shell sandbox policy", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fixture = "__ROOT__";
    const home = path.join(fixture, "home");
    const baseDir = path.join(home, ".t3");
    const stateDir = path.join(baseDir, "userdata");
    const kin = path.join(stateDir, "kin");
    const app = path.join(kin, GH_APP_FOLDER);
    const tools = path.join(fixture, "tools");
    const guards = agentShellScripts({
      shims: path.join(kin, "gh-sign"),
      app,
      realGh: path.join(tools, "gh"),
      node: "node",
    }).map((script) => path.join(kin, "gh-sign", script.name));
    const settings = Confinement.shellSandbox(
      {
        root: path.join(kin, "acme", "read"),
        home,
        temp: path.join(stateDir, "kin-session-tmp", "session-own"),
        baseDir,
        stateDir,
        attachments: [path.join(stateDir, "attachments", "kin-chat-given.txt")],
        readPaths: [
          ...guards,
          path.join(tools, "gh"),
          path.join(tools, "typst"),
          path.join(home, ".local", "share", "mise", "installs", "node", "fixture", "bin", "node"),
          ...[APP_IDENTITY_FILE, APP_REPOS_FOLDER, APP_TOKENS_FOLDER].map((name) =>
            path.join(app, name),
          ),
        ],
        logPaths: [AGENT_POSTS_FILE, OWNER_USES_FILE].map((name) => path.join(app, name)),
        environment: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          KIN_CHECKOUT: path.join(home, "kin-current"),
          KIN_BACKUP_DEST: path.join(fixture, "backup"),
          TMPDIR: path.join(home, ".cache", "kin-tmp"),
          ANTHROPIC_API_KEY: "placeholder",
          GITHUB_TOKEN: "placeholder",
        },
      },
      path,
    );
    expect(settings.filesystem.denyRead).toContain(home);
    expect(settings.filesystem.denyRead).toContain("/var/log/journal");
    expect(settings.filesystem.denyRead).toContain("/run/log/journal");
    expect(settings.filesystem.denyRead).toContain("/tmp");
    yield* Effect.promise(() =>
      expect(`${JSON.stringify(settings, null, 2)}\n`).toMatchFileSnapshot(
        "../../../../ops/kin/host/shell-wall-probe/policy.json",
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a Linux sandbox opens only the session folders from its home fixture", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if ((yield* HostProcess.Platform) !== "linux" || !(yield* fs.exists("/usr/bin/bwrap"))) return;
    const path = yield* Path.Path;
    const work = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const home = path.join(work, "home");
    const stateDir = path.join(home, "state");
    const root = path.join(stateDir, "checkout");
    const temp = path.join(stateDir, "own-temp");
    const other = path.join(stateDir, "other-temp");
    const tool = path.join(home, "bin", "node");
    for (const folder of [root, temp, other, path.dirname(tool)])
      yield* fs.makeDirectory(folder, { recursive: true });
    const node = yield* HostProcess.ExecutablePath;
    yield* fs.copyFile(node, tool);
    yield* fs.chmod(tool, 0o755);
    for (const file of [
      path.join(home, "private"),
      path.join(root, "note"),
      path.join(temp, "note"),
      path.join(other, "note"),
    ])
      yield* fs.writeFileString(file, "fixture");
    const policy = Confinement.shellSandbox(
      {
        root,
        home,
        temp,
        baseDir: stateDir,
        stateDir,
        attachments: [],
        readPaths: [tool],
        logPaths: [],
        environment: { HOME: home },
      },
      path,
    );
    const hostReadDenials = policy.filesystem.denyRead.filter((dir) => dir === home);
    const allowed = policy.filesystem.allowRead.filter(
      (dir) => dir === root || dir === temp || dir === tool,
    );
    const result = yield* (yield* ProcessRunner.ProcessRunner).run({
      command: "/usr/bin/bwrap",
      cwd: work,
      args: [
        "--unshare-user",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        ...hostReadDenials.flatMap((dir) => ["--tmpfs", dir]),
        ...allowed.flatMap((dir) => ["--ro-bind", dir, dir]),
        "/bin/sh",
        "-c",
        'test ! -r "$1" && test ! -r "$2" && test -r "$3" && test -r "$4" && "$5" --version',
        "fixture",
        path.join(home, "private"),
        path.join(other, "note"),
        path.join(root, "note"),
        path.join(temp, "note"),
        tool,
      ],
      timeout: 5000,
      maxOutputBytes: 1024,
    });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\./);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
