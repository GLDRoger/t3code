// @effect-diagnostics nodeBuiltinImport:off - runs the real shell scripts in a scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { signed } from "./agentMark.ts";
import {
  agentShellScripts,
  APP_IDENTITY_FILE,
  APP_TOKENS_FOLDER,
  OWNER_USES_FILE,
} from "./ghSign.ts";

const BOT = "invented-kin[bot]";
const BOT_EMAIL = "41+invented-kin[bot]@users.noreply.github.com";
const APP_TOKEN = "ghs_invented_app_token";

/**
 * A scratch agent shell: Kin's scripts first on PATH, a stand-in gh that prints the token it got and
 * each argument on its own line (and the owner's login for git), and the real git.
 */
const makeShell = (options: { app?: boolean } = {}) => {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-shell-")));
  const shims = NodePath.join(dir, "shims");
  const app = NodePath.join(dir, "app");
  const realGh = NodePath.join(dir, "real-gh");
  NodeFS.mkdirSync(shims);
  NodeFS.writeFileSync(
    realGh,
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "auth git-credential" ]; then cat >/dev/null; printf "username=owner\\npassword=owner-login\\n"; exit 0; fi',
      'printf "GH_TOKEN=%s\\n" "$GH_TOKEN"',
      'for a do printf "<%s>\\n" "$a"; done',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const script of agentShellScripts({ shims, app, realGh }))
    NodeFS.writeFileSync(NodePath.join(shims, script.name), script.text, { mode: 0o755 });
  if (options.app === true) {
    NodeFS.mkdirSync(NodePath.join(app, APP_TOKENS_FOLDER), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(app, APP_IDENTITY_FILE), `${BOT}\n${BOT_EMAIL}\n`);
    NodeFS.writeFileSync(NodePath.join(app, APP_TOKENS_FOLDER, "invented-co"), APP_TOKEN, {
      mode: 0o600,
    });
  }
  const globalConfig = NodePath.join(dir, "gitconfig");
  // The owner's own git setup: his name, and gh as the credential helper, as `gh auth setup-git` writes.
  NodeFS.writeFileSync(
    globalConfig,
    [
      "[user]",
      "  name = Invented Owner",
      "  email = owner@invented.example",
      '[credential "https://github.com"]',
      "  helper =",
      `  helper = !printf 'username=global\\npassword=global-helper\\n'`,
      "",
    ].join("\n"),
  );
  const env = (name?: string): NodeJS.ProcessEnv => ({
    PATH: `${shims}:${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    ...(name === undefined ? {} : { KIN_AGENT_NAME: name }),
  });
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    options: { name?: string; stdin?: string; cwd?: string } = {},
  ) =>
    NodeChildProcess.spawnSync(command, [...args], {
      cwd: options.cwd ?? dir,
      input: options.stdin ?? "",
      env: env(options.name),
      encoding: "utf8",
    });
  const gh = (args: ReadonlyArray<string>, options: { name?: string; stdin?: string } = {}) =>
    run("gh", args, options);
  const argsOf = (stdout: string) =>
    [...stdout.matchAll(/<([\s\S]*?)>\n/g)].map((match) => match[1]);
  const tokenOf = (stdout: string) => /^GH_TOKEN=(.*)$/m.exec(stdout)?.[1];
  const checkout = () => {
    const repo = NodePath.join(dir, "checkout");
    NodeFS.mkdirSync(repo);
    run("git", ["init", "-q", "-b", "main"], { cwd: repo });
    run("git", ["remote", "add", "origin", "https://github.com/invented-co/app.git"], {
      cwd: repo,
    });
    NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "Invented.\n");
    run("git", ["add", "README.md"], { cwd: repo });
    return repo;
  };
  const ownerUses = () => {
    const file = NodePath.join(app, OWNER_USES_FILE);
    return NodeFS.existsSync(file)
      ? NodeFS.readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split("\t"))
      : [];
  };
  return {
    dir,
    app,
    run,
    gh,
    argsOf,
    tokenOf,
    checkout,
    ownerUses,
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

describe("the gh a Kin agent's shell runs", () => {
  it("ends every body an agent posts with its signature and marker, exactly as Kin writes them", () => {
    using shell = makeShell();
    NodeFS.writeFileSync(NodePath.join(shell.dir, "body.md"), "From a file.\n");
    const name = "Tech lead";
    const run = (args: ReadonlyArray<string>, stdin?: string) =>
      shell.argsOf(shell.gh(args, { name, ...(stdin === undefined ? {} : { stdin }) }).stdout);
    expect(run(["pr", "create", "--title", "Add hello", "--body", "Closes #1"])).toEqual([
      "pr",
      "create",
      "--title",
      "Add hello",
      "--body",
      signed("Closes #1", name),
    ]);
    expect(run(["issue", "comment", "3", "-b", "On it."]).at(-1)).toBe(signed("On it.", name));
    expect(run(["pr", "review", "2", "--comment", "--body=Looks right."]).at(-1)).toBe(
      `--body=${signed("Looks right.", name)}`,
    );
    expect(run(["pr", "comment", "2", "--body-file", "body.md"]).slice(-2)).toEqual([
      "--body",
      signed("From a file.", name),
    ]);
    expect(run(["pr", "comment", "2", "-F", "-"], "From stdin.").at(-1)).toBe(
      signed("From stdin.", name),
    );
    expect(run(["api", "repos/a/b/issues/3/comments", "-f", "body=Via the API."]).at(-1)).toBe(
      `body=${signed("Via the API.", name)}`,
    );
    // No body given: an issue still ends with the signature.
    expect(run(["issue", "create", "--title", "Flaky test"]).slice(-2)).toEqual([
      "--body",
      signed("", name),
    ]);
  });

  it("signs once, and leaves everything else, and every other shell, alone", () => {
    using shell = makeShell();
    const name = "Tech lead";
    const already = signed("Done.", name);
    const run = (args: ReadonlyArray<string>, who?: string) =>
      shell.argsOf(shell.gh(args, who === undefined ? {} : { name: who }).stdout);
    expect(run(["pr", "comment", "2", "--body", already], name).at(-1)).toBe(already);
    expect(run(["pr", "view", "2", "--json", "body"], name)).toEqual([
      "pr",
      "view",
      "2",
      "--json",
      "body",
    ]);
    expect(run(["api", "repos/a/b/pulls/2", "-f", "title=Rename"], name).at(-1)).toBe(
      "title=Rename",
    );
    expect(run(["pr", "create", "--body", "Plain"])).toEqual(["pr", "create", "--body", "Plain"]);
  });

  it("acts as Kin's GitHub App on an account it is installed on, and as the owner elsewhere", () => {
    using shell = makeShell({ app: true });
    const tokenFor = (args: ReadonlyArray<string>, cwd?: string) =>
      shell.tokenOf(
        shell.run("gh", args, { name: "Tech lead", ...(cwd === undefined ? {} : { cwd }) }).stdout,
      );
    expect(tokenFor(["pr", "create", "-R", "invented-co/app", "--body", "x"])).toBe(APP_TOKEN);
    expect(tokenFor(["api", "repos/Invented-Co/app/issues/3/comments", "-f", "body=x"])).toBe(
      APP_TOKEN,
    );
    expect(tokenFor(["repo", "clone", "invented-co/app"])).toBe(APP_TOKEN);
    expect(tokenFor(["pr", "view", "https://github.com/invented-co/app/pull/4"])).toBe(APP_TOKEN);
    // In a checkout, the repo is its remote's.
    expect(tokenFor(["pr", "list"], shell.checkout())).toBe(APP_TOKEN);
    // A body naming another repo doesn't move it; an account without the App stays the owner's.
    expect(
      tokenFor([
        "pr",
        "create",
        "-R",
        "invented-co/app",
        "--body",
        "https://github.com/elsewhere/x",
      ]),
    ).toBe(APP_TOKEN);
    expect(tokenFor(["pr", "create", "-R", "elsewhere/x", "--body", "y"])).toBe("");
  });

  it("acts as the owner, as before, while the App isn't set up", () => {
    using shell = makeShell();
    expect(
      shell.tokenOf(shell.gh(["pr", "create", "-R", "invented-co/app", "--body", "x"]).stdout),
    ).toBe("");
  });

  it("never merges, approves or changes a repo's settings, as the App or as the owner", () => {
    using shell = makeShell({ app: true });
    const refused = [
      ["pr", "merge", "3", "--squash"],
      ["pr", "review", "3", "--approve"],
      ["pr", "review", "3", "-a", "-b", "ok"],
      ["repo", "edit", "invented-co/app", "--visibility", "public"],
      ["secret", "set", "TOKEN"],
      ["api", "-X", "PUT", "repos/invented-co/app/pulls/3/merge"],
      ["api", "--method=put", "/repos/invented-co/app/pulls/3/merge"],
      ["api", "repos/invented-co/app/pulls/3/reviews", "-f", "event=APPROVE"],
      ["api", "-X", "PATCH", "repos/invented-co/app", "-f", "private=false"],
      ["api", "-X", "PUT", "repos/invented-co/app/collaborators/someone"],
      ["api", "-X", "DELETE", "repos/invented-co/app/branches/main/protection"],
      [
        "api",
        "graphql",
        "-f",
        "query=mutation { mergePullRequest(input: {}) { clientMutationId } }",
      ],
      [
        "api",
        "graphql",
        "-f",
        "query=mutation { addPullRequestReview(input: {event: APPROVE}) { clientMutationId } }",
      ],
    ];
    for (const args of refused)
      for (const command of [["gh"], ["kin-as-owner", "gh"]]) {
        const result = shell.run(command[0]!, [...command.slice(1), ...args], {
          name: "Tech lead",
        });
        expect(result.status, args.join(" ")).toBe(1);
        expect(result.stdout, args.join(" ")).toBe("");
        expect(result.stderr).toMatch(/^kin: Kin agents don't/);
      }
    // Reviews, comments, reads and creating a repo still run.
    const allowed = [
      ["pr", "review", "3", "--request-changes", "-b", "Needs a test."],
      ["api", "repos/invented-co/app/pulls/3/reviews", "-f", "event=COMMENT", "-f", "body=x"],
      ["api", "repos/invented-co/app/pulls/3/merge"],
      [
        "api",
        "graphql",
        "-f",
        'query=query { repository(owner: "a", name: "b") { pullRequest(number: 3) { reviews(states: APPROVED) { totalCount } } } }',
      ],
      ["api", "orgs/invented-co/repos", "-f", "name=new-tool"],
      ["repo", "view", "invented-co/app"],
    ];
    for (const args of allowed)
      expect(shell.gh(args, { name: "Tech lead" }).status, args.join(" ")).toBe(0);
  });
});

describe("the git a Kin agent's shell runs", () => {
  const lastCommit = (shell: ReturnType<typeof makeShell>, repo: string) =>
    shell.run("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%B"], { cwd: repo }).stdout.trim();

  it("authors as the App and names the agent in a trailer", () => {
    using shell = makeShell({ app: true });
    const repo = shell.checkout();
    expect(
      shell.run("git", ["commit", "-q", "-m", "Add a readme"], { cwd: repo, name: "Tech lead" })
        .status,
    ).toBe(0);
    expect(lastCommit(shell, repo)).toBe(
      `${BOT} <${BOT_EMAIL}>|${BOT} <${BOT_EMAIL}>|Add a readme\n\nKin-Agent: Tech lead`,
    );
    // Amending keeps one trailer.
    shell.run("git", ["commit", "-q", "--amend", "--no-edit"], { cwd: repo, name: "Tech lead" });
    expect(lastCommit(shell, repo).match(/Kin-Agent:/g)).toHaveLength(1);
  });

  it("authors as the owner under kin-as-owner, or without the App, and still names the agent", () => {
    for (const app of [true, false]) {
      using shell = makeShell({ app });
      const repo = shell.checkout();
      const command = app ? ["kin-as-owner", "git"] : ["git"];
      shell.run(command[0]!, [...command.slice(1), "commit", "-q", "-m", "Add a readme"], {
        cwd: repo,
        name: "Tech lead",
      });
      expect(lastCommit(shell, repo)).toBe(
        "Invented Owner <owner@invented.example>|Invented Owner <owner@invented.example>|Add a readme\n\nKin-Agent: Tech lead",
      );
    }
  });

  it("hands git the App's token for its accounts and the owner's login for the rest", () => {
    using shell = makeShell({ app: true });
    const fill = (url: string, asOwner = false) =>
      shell.run(
        asOwner ? "kin-as-owner" : "git",
        [...(asOwner ? ["git"] : []), "credential", "fill"],
        {
          stdin: `url=${url}\n\n`,
          name: "Tech lead",
        },
      ).stdout;
    expect(fill("https://github.com/invented-co/app.git")).toContain(
      `username=x-access-token\npassword=${APP_TOKEN}`,
    );
    expect(fill("https://github.com/elsewhere/x.git")).toContain(
      "username=owner\npassword=owner-login",
    );
    // As the owner, git asks the owner's own helper.
    expect(fill("https://github.com/invented-co/app.git", true)).toContain(
      "username=global\npassword=global-helper",
    );
  });
});

describe("kin-as-owner", () => {
  it("runs one command as the owner and records who ran what, where and when", () => {
    using shell = makeShell({ app: true });
    const result = shell.run(
      "kin-as-owner",
      ["gh", "pr", "create", "-R", "invented-co/app", "--body", "Done."],
      { name: "Tech lead" },
    );
    expect(shell.tokenOf(result.stdout)).toBe("");
    expect(shell.argsOf(result.stdout).at(-1)).toBe(signed("Done.", "Tech lead"));
    const [use] = shell.ownerUses();
    expect(use).toHaveLength(5);
    expect(Number(use![0])).toBeGreaterThan(0);
    expect(use!.slice(2)).toEqual([
      "Tech lead",
      "invented-co/app",
      "gh pr create -R invented-co/app --body Done.",
    ]);
    // A git command's repo is its checkout's remote.
    const repo = shell.checkout();
    shell.run("kin-as-owner", ["git", "status", "--short"], { cwd: repo, name: "Tech lead" });
    expect(shell.ownerUses()[1]!.slice(2)).toEqual([
      "Tech lead",
      "invented-co/app",
      "git status --short",
    ]);
  });

  it("refuses to run what Kin can't record", () => {
    using shell = makeShell({ app: true });
    NodeFS.chmodSync(shell.app, 0o500);
    const result = shell.run("kin-as-owner", ["gh", "pr", "list"], { name: "Tech lead" });
    NodeFS.chmodSync(shell.app, 0o700);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("couldn't record");
  });
});
