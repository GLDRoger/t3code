// @effect-diagnostics nodeBuiltinImport:off - runs the real shell scripts in a scratch folder.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";

import { agentPostKeys, signed } from "./agentMark.ts";
import {
  AGENT_POSTS_FILE,
  agentShellScripts,
  APP_IDENTITY_FILE,
  APP_REPOS_FOLDER,
  APP_TOKENS_FOLDER,
  OWNER_USES_FILE,
} from "./ghSign.ts";
import { type DecideContext, decideTriggers, type ThreadSnapshot } from "./githubTriggers.ts";

const BOT = "invented-kin[bot]";
const BOT_EMAIL = "41+invented-kin[bot]@users.noreply.github.com";
const APP_TOKEN = "ghs_invented_app_token";

/**
 * A scratch agent shell: Kin's scripts first on PATH, a stand-in gh that prints the token it got and
 * each argument on its own line (and the owner's login for git), and the real git.
 */
const makeShell = (options: { app?: boolean; picked?: ReadonlyArray<string> } = {}) => {
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
      'case " $* " in *" --input=- "*|*" --input - "*) printf "STDIN=%s\\n" "$(cat)" ;; esac',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  for (const script of agentShellScripts({ shims, app, realGh, node: process.execPath }))
    NodeFS.writeFileSync(NodePath.join(shims, script.name), script.text, { mode: 0o755 });
  if (options.app === true) {
    NodeFS.mkdirSync(NodePath.join(app, APP_TOKENS_FOLDER), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(app, APP_IDENTITY_FILE), `${BOT}\n${BOT_EMAIL}\n`);
    NodeFS.writeFileSync(NodePath.join(app, APP_TOKENS_FOLDER, "invented-co"), APP_TOKEN, {
      mode: 0o600,
    });
    if (options.picked !== undefined) {
      NodeFS.mkdirSync(NodePath.join(app, APP_REPOS_FOLDER));
      NodeFS.writeFileSync(
        NodePath.join(app, APP_REPOS_FOLDER, "invented-co"),
        options.picked.map((repo) => `${repo}\n`).join(""),
      );
    }
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
  const env = (name?: string, path = `${shims}:${process.env.PATH}`): NodeJS.ProcessEnv => ({
    PATH: path,
    HOME: dir,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    ...(name === undefined ? {} : { KIN_AGENT_NAME: name }),
  });
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    options: { name?: string; stdin?: string; cwd?: string; path?: string } = {},
  ) =>
    NodeChildProcess.spawnSync(command, [...args], {
      cwd: options.cwd ?? dir,
      input: options.stdin ?? "",
      env: env(options.name, options.path),
      encoding: "utf8",
    });
  /** The same, without blocking, so a table of commands runs side by side. */
  const runAsync = (
    command: string,
    args: ReadonlyArray<string>,
    options: { name?: string; stdin?: string } = {},
  ) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = NodeChildProcess.spawn(command, [...args], {
        cwd: dir,
        env: env(options.name),
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin ?? "");
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const gh = (args: ReadonlyArray<string>, options: { name?: string; stdin?: string } = {}) =>
    run("gh", args, options);
  const argsOf = (stdout: string) =>
    [
      ...stdout
        .split("\nSTDIN=")[0]!
        .concat("\n")
        .matchAll(/<([\s\S]*?)>\n/g),
    ].map((match) => match[1] ?? "");
  /** The JSON body the real gh was handed on stdin. */
  const sentOf = (stdout: string) => JSON.parse(stdout.split("\nSTDIN=")[1] ?? "null");
  const posts = () => {
    const file = NodePath.join(app, AGENT_POSTS_FILE);
    return agentPostKeys(NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "", 0);
  };
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
    shims,
    realGh,
    run,
    runAsync,
    gh,
    argsOf,
    sentOf,
    posts,
    tokenOf,
    checkout,
    ownerUses,
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

const AGENT = "Tech lead";
const WORDS = "/kin rename this";

/** Each identity an agent's gh can act as: the command that runs it, and who GitHub shows. */
const IDENTITIES = [
  { as: "the App", app: true, command: ["gh"], author: BOT, association: "NONE" },
  {
    as: "the owner, through kin-as-owner",
    app: true,
    command: ["kin-as-owner", "gh"],
    author: "invented-owner",
    association: "OWNER",
  },
  {
    as: "the owner, with no App",
    app: false,
    command: ["gh"],
    author: "invented-owner",
    association: "OWNER",
  },
] as const;

const ghAs = (
  shell: ReturnType<typeof makeShell>,
  identity: (typeof IDENTITIES)[number],
  args: ReadonlyArray<string>,
  stdin?: string,
) =>
  shell.runAsync(identity.command[0], [...identity.command.slice(1), ...args], {
    name: AGENT,
    ...(stdin === undefined ? {} : { stdin }),
  });

const REVIEW_QUERY =
  "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { clientMutationId } }";

/**
 * Every way Ein and the brief named to post the agent's words: what to run (with what on stdin, and
 * which file), and where the words land in what the real gh is handed.
 */
const POST_FORMS: ReadonlyArray<{
  readonly form: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly file?: string;
  readonly landed: (sent: { args: ReadonlyArray<string>; json: any }) => string;
}> = [
  {
    form: "REST field",
    args: ["api", "repos/invented-co/app/issues/3/comments", "-f", `body=${WORDS}`],
    landed: ({ json }) => json.body,
  },
  {
    form: "nested REST fields",
    args: [
      "api",
      "repos/invented-co/app/pulls/3/reviews",
      "-f",
      "event=COMMENT",
      "-f",
      "body=Two nits.",
      "-f",
      "comments[][path]=a.ts",
      "-F",
      "comments[][line]=3",
      "-f",
      `comments[][body]=${WORDS}`,
    ],
    landed: ({ json }) => json.comments[0].body,
  },
  {
    form: "an indexed nested field, as Ein wrote it",
    args: [
      "api",
      "repos/invented-co/app/pulls/3/reviews",
      "-f",
      "event=COMMENT",
      "-f",
      `comments[0][body]=${WORDS}`,
    ],
    landed: ({ json }) => json.comments["0"].body,
  },
  {
    form: "a JSON file",
    args: ["api", "repos/invented-co/app/pulls/3/reviews", "--input", "review.json"],
    file: JSON.stringify({
      event: "COMMENT",
      body: "Two nits.",
      comments: [{ path: "a.ts", line: 3, body: WORDS }],
    }),
    landed: ({ json }) => json.comments[0].body,
  },
  {
    form: "JSON on stdin",
    args: ["api", "repos/invented-co/app/pulls/3/reviews", "--input", "-"],
    stdin: JSON.stringify({
      event: "REQUEST_CHANGES",
      body: "One bug.",
      comments: [{ path: "a.ts", line: 3, body: WORDS }],
    }),
    landed: ({ json }) => json.comments[0].body,
  },
  {
    form: "a GraphQL variable in fields",
    args: [
      "api",
      "graphql",
      "-f",
      'query=mutation($body: String!) { addComment(input: {subjectId: "I_1", body: $body}) { clientMutationId } }',
      "-f",
      `body=${WORDS}`,
    ],
    landed: ({ json }) => json.variables.body,
  },
  {
    form: "a GraphQL string in the query",
    args: [
      "api",
      "graphql",
      "-f",
      `query=mutation { addComment(input: {subjectId: "I_1", body: ${JSON.stringify(WORDS)}}) { clientMutationId } }`,
    ],
    landed: ({ json }) => JSON.parse(/body: ("(?:[^"\\]|\\.)*")/.exec(json.query)![1]!),
  },
  {
    form: "GraphQL JSON on stdin",
    args: ["api", "graphql", "--input", "-"],
    stdin: JSON.stringify({
      query: REVIEW_QUERY,
      variables: {
        input: {
          pullRequestId: "PR_1",
          event: "COMMENT",
          threads: [{ path: "a.ts", line: 3, body: WORDS }],
        },
      },
    }),
    landed: ({ json }) => json.variables.input.threads[0].body,
  },
  {
    form: "gh pr comment --body-file -",
    args: ["pr", "comment", "3", "--body-file", "-"],
    stdin: WORDS,
    landed: ({ args }) => args.at(-1)!,
  },
  {
    form: "gh pr review --comment -b",
    args: ["pr", "review", "3", "--comment", "-b", WORDS],
    landed: ({ args }) => args.at(-1)!,
  },
];

/** A PR with one line comment, as the watch reads it, and the watch's context. */
const withComment = (body: string, author: string, association: string): ThreadSnapshot => ({
  repo: "invented-co/app",
  number: 3,
  item: "pull",
  url: "https://github.com/invented-co/app/pull/3",
  title: "Add hello",
  body: "Adds hello.",
  author: "teammate",
  association: "MEMBER",
  open: true,
  draft: false,
  createdAt: 0,
  labels: [],
  pull: {
    files: 1,
    additions: 1,
    deletions: 0,
    headRef: "add-hello",
    baseRef: "main",
    headSha: "abc",
    fork: false,
  },
  comments: [
    { id: 7, kind: "review", body, author, association, createdAt: 10, path: "a.ts", line: 3 },
  ],
  reviewRequested: false,
});
const watchContext = (agentPosts?: ReadonlySet<string>): DecideContext => ({
  ownerLogin: "invented-owner",
  agents: [{ agentId: "tech", name: AGENT }],
  defaultAgentId: "tech",
  mentions: false,
  since: 5,
  draftSeen: false,
  botLogin: BOT,
  agentPosts,
  writes: (login) => login === "invented-owner",
});

describe("the gh a Kin agent's shell runs", () => {
  it("ends every body an agent posts with its signature and marker, exactly as Kin writes them", () => {
    using shell = makeShell();
    NodeFS.writeFileSync(NodePath.join(shell.dir, "body.md"), "From a file.\n");
    const name = AGENT;
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
      signed("Looks right.", name),
    );
    // pflag reads the last of a repeated flag, and so does Kin: this isn't --help.
    expect(run(["pr", "comment", "2", "--help", "--help=false", "-b", "Hi."]).at(-1)).toBe(
      signed("Hi.", name),
    );
    expect(run(["pr", "comment", "2", "--body-file", "body.md"]).at(-1)).toBe(
      signed("From a file.", name),
    );
    expect(run(["pr", "comment", "2", "-F", "-"], "From stdin.").at(-1)).toBe(
      signed("From stdin.", name),
    );
    expect(run(["issue", "close", "3", "-c", "Fixed in #4."]).at(-1)).toBe(
      signed("Fixed in #4.", name),
    );
    // No body given: an issue still ends with the signature.
    expect(run(["issue", "create", "--title", "Flaky test"]).at(-1)).toBe(signed("", name));
    const api = shell.gh(["api", "repos/a/b/issues/3/comments", "-f", "body=Via the API."], {
      name,
    }).stdout;
    expect(shell.argsOf(api)).toEqual([
      "api",
      "repos/a/b/issues/3/comments",
      "--method",
      "POST",
      "--input",
      "-",
    ]);
    expect(shell.sentOf(api)).toEqual({ body: signed("Via the API.", name) });
  });

  it("signs exactly as Kin's own signed(), the one definition, never leaving a body unsigned", async () => {
    using shell = makeShell();
    const cases: ReadonlyArray<readonly [body: string, name: string | undefined]> = [
      ["On it.", "Tech lead"],
      ["On it.", ""],
      ["On it.", "   "],
      ["On it.", undefined],
      ["", "Tech lead"],
      ["  \n", ""],
      ["Line one\r\nline two\n\n", "Growth & PR"],
      ["Done.", "Ünïcode Lead"],
      [signed("Already signed.", "Finance"), "Tech lead"],
      ["Has a <!-- KIN-AGENT: x --> marker", ""],
    ];
    const results = await Promise.all(
      cases.map(([body, name]) =>
        shell.runAsync("gh", ["pr", "comment", "3", "--body-file", "-"], {
          stdin: body,
          ...(name === undefined ? {} : { name }),
        }),
      ),
    );
    cases.forEach(([body, name], index) => {
      const label = JSON.stringify([body, name]);
      expect(results[index]!.status, `${label}: ${results[index]!.stderr}`).toBe(0);
      const sent = shell.argsOf(results[index]!.stdout).at(-1)!;
      expect(sent, label).toBe(signed(body, name ?? ""));
      expect(sent, label).toMatch(/<!-- kin-agent: [a-z0-9-]+ -->$|<!-- KIN-AGENT/);
    });
  });

  it("signs once, passes reads untouched, and signs as Agent with no name", () => {
    using shell = makeShell();
    const already = signed("Done.", AGENT);
    const run = (args: ReadonlyArray<string>, who?: string) =>
      shell.gh(args, who === undefined ? {} : { name: who }).stdout;
    expect(shell.argsOf(run(["pr", "comment", "2", "--body", already], AGENT)).at(-1)).toBe(
      already,
    );
    expect(shell.argsOf(run(["pr", "view", "2", "--json", "body"], AGENT))).toEqual([
      "pr",
      "view",
      "2",
      "--json",
      "body",
    ]);
    expect(
      shell.sentOf(run(["api", "-X", "PATCH", "repos/a/b/pulls/2", "-f", "title=Rename"])),
    ).toEqual({ title: "Rename" });
    expect(shell.argsOf(run(["pr", "create", "--body", "Plain"])).at(-1)).toBe(signed("Plain", ""));
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

  it("acts as the owner on a repo taken off the App's selection while others of its account stay", () => {
    using shell = makeShell({ app: true, picked: ["invented-co/kept"] });
    const tokenFor = (args: ReadonlyArray<string>) =>
      shell.tokenOf(shell.run("gh", args, { name: "Tech lead" }).stdout);
    expect(tokenFor(["pr", "view", "1", "-R", "Invented-Co/Kept"])).toBe(APP_TOKEN);
    expect(tokenFor(["pr", "view", "1", "-R", "invented-co/removed"])).toBe("");
    expect(tokenFor(["api", "repos/invented-co/removed/pulls"])).toBe("");
    const fill = (url: string) =>
      shell.run("git", ["credential", "fill"], { stdin: `url=${url}\n\n`, name: "Tech lead" })
        .stdout;
    expect(fill("https://github.com/invented-co/kept.git")).toContain(`password=${APP_TOKEN}`);
    expect(fill("https://github.com/invented-co/removed.git")).toContain(
      "username=owner\npassword=owner-login",
    );
  });

  it("acts as the owner, as before, while the App isn't set up", () => {
    using shell = makeShell();
    expect(
      shell.tokenOf(shell.gh(["pr", "create", "-R", "invented-co/app", "--body", "x"]).stdout),
    ).toBe("");
  });

  it("refuses every merge, approval and settings change however it is spelled, as the App or the owner", async () => {
    const merge = /^kin: Kin agents don't merge/;
    const approve = /^kin: Kin agents don't approve/;
    const settings = /^kin: Kin agents don't change a repository's settings/;
    const removal = /^kin: Kin agents don't delete/;
    const unknown = /^kin: Kin agents' gh makes only the GitHub writes Kin knows/;
    const unreadable = /^kin: Kin can't read this GitHub write in full/;
    const graphql = (query: string) => JSON.stringify({ query });
    const refused: ReadonlyArray<readonly [ReadonlyArray<string>, RegExp, string?]> = [
      [["pr", "merge", "3", "--squash"], merge],
      [["pr", "-R", "invented-co/app", "merge", "3"], unreadable],
      [["pr", "review", "3", "--approve"], approve],
      [["pr", "review", "3", "-cab", "ok"], approve],
      [["pr", "review", "3", "-b", "ok"], unknown],
      [["repo", "edit", "invented-co/app", "--visibility", "public"], settings],
      [["repo", "delete", "invented-co/app", "--yes"], removal],
      [["release", "delete", "v1", "--yes"], removal],
      [["release", "create", "v1"], unknown],
      [["secret", "set", "TOKEN"], settings],
      [["workflow", "run", "deploy.yml"], unknown],
      [["auth", "token"], /^kin: Kin agents don't change the owner's gh login/],
      [["copilot"], unknown],
      [["api", "-X", "PUT", "repos/invented-co/app/pulls/3/merge"], merge],
      [["api", "--method=put", "/repos/invented-co/app/pulls/3/merge"], merge],
      [["api", "-iXPUT", "repos/{owner}/{repo}/pulls/3/merge"], merge],
      [["api", "repos/invented-co/app/merges", "-f", "base=main", "-f", "head=feature"], merge],
      [["api", "repos/invented-co/app/pulls/3/reviews", "-f", "event=APPROVE"], approve],
      // Ein's P1: the same as JSON on standard input.
      [
        ["api", "repos/invented-co/app/pulls/3/reviews", "--input", "-"],
        approve,
        JSON.stringify({ event: "APPROVE", body: "ok" }),
      ],
      [
        ["api", "graphql", "--input", "-"],
        merge,
        graphql(
          'mutation { mergePullRequest(input: {pullRequestId: "PR_1"}) { clientMutationId } }',
        ),
      ],
      [
        ["api", "graphql", "--input", "-"],
        approve,
        JSON.stringify({
          query: REVIEW_QUERY,
          variables: { input: { pullRequestId: "PR_1", event: "APPROVE" } },
        }),
      ],
      [
        [
          "api",
          "graphql",
          "-f",
          "query=mutation($id: ID!) { done: mergePullRequest(input: {pullRequestId: $id}) { clientMutationId } }",
          "-f",
          "id=PR_1",
        ],
        merge,
      ],
      [
        [
          "api",
          "graphql",
          "-f",
          'query=mutation { submitPullRequestReview(input: {pullRequestReviewId: "R_1", event: APPROVE}) { clientMutationId } }',
        ],
        approve,
      ],
      [
        ["api", "graphql", "--input", "-"],
        merge,
        graphql("mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"),
      ],
      [
        ["api", "graphql", "--input", "-"],
        merge,
        graphql("mutation { enqueuePullRequest(input: {}) { clientMutationId } }"),
      ],
      [
        ["api", "graphql", "--input", "-"],
        /^kin: Kin agents don't dismiss reviews/,
        graphql("mutation { dismissPullRequestReview(input: {}) { clientMutationId } }"),
      ],
      [
        [
          "api",
          "-X",
          "PUT",
          "repos/invented-co/app/pulls/3/reviews/9/dismissals",
          "-f",
          "message=x",
        ],
        /^kin: Kin agents don't dismiss reviews/,
      ],
      [["api", "-X", "PATCH", "repos/invented-co/app", "-f", "private=false"], settings],
      [["api", "-X", "PUT", "repos/invented-co/app/collaborators/someone"], settings],
      [["api", "-X", "DELETE", "repos/invented-co/app/branches/main/protection"], settings],
      [["api", "repos/invented-co/app/rulesets", "-f", "name=x"], settings],
      [["api", "repos/invented-co/app/hooks", "-f", "name=web"], settings],
      [["api", "repos/invented-co/app/keys", "-f", "key=ssh-ed25519 x"], settings],
      [
        [
          "api",
          "-X",
          "PUT",
          "repos/invented-co/app/actions/secrets/TOKEN",
          "-f",
          "encrypted_value=x",
        ],
        settings,
      ],
      [["api", "-X", "DELETE", "user/installations/1/repositories/2"], settings],
      [["api", "-X", "DELETE", "repos/invented-co/app"], removal],
      [["api", "orgs/invented-co/repos", "-f", "name=new-tool"], unknown],
      [
        [
          "api",
          "-X",
          "PUT",
          "repos/invented-co/app/contents/README.md",
          "-f",
          "message=x",
          "-f",
          "content=eA==",
        ],
        unknown,
      ],
      [
        ["api", "repos/invented-co/app/git/refs", "-f", "ref=refs/heads/main", "-f", "sha=abc"],
        unknown,
      ],
      [
        ["api", "graphql", "--input", "-"],
        unknown,
        graphql("mutation { createCommitOnBranch(input: {}) { clientMutationId } }"),
      ],
      [["api", "graphql", "--input", "-"], unknown, graphql("subscription { x }")],
      // What Kin can't read in full never runs.
      [["api", "graphql", "--input", "-"], unreadable, "not json"],
      [
        ["api", "graphql", "--input", "-"],
        unreadable,
        graphql(
          "mutation { ...F } fragment F on Mutation { mergePullRequest(input: {}) { clientMutationId } }",
        ),
      ],
      [
        [
          "api",
          "graphql",
          "-f",
          'query=mutation($b: String = "/kin go") { addComment(input: {subjectId: "I_1", body: $b}) { clientMutationId } }',
        ],
        unreadable,
      ],
      [
        [
          "api",
          "repos/invented-co/app/issues/3/comments",
          "-f",
          "body=x",
          "-H",
          "X-HTTP-Method-Override: PUT",
        ],
        unreadable,
      ],
      [["api", "repos/invented-co/app/issues/3/comments", "-F", "body={owner}"], unreadable],
      [
        ["api", "repos/invented-co/app/issues/3/comments", "-f", "body=x", "--input", "-"],
        unreadable,
        "{}",
      ],
      [["pr", "comment", "3", "--editor"], unreadable],
      [["pr", "close", "3", "--delete-branch"], unreadable],
      [
        [
          "api",
          "-X",
          "GET",
          "repos/invented-co/app/pulls/3/merge",
          "-H",
          "X-HTTP-Method-Override: PUT",
        ],
        unreadable,
      ],
      [["pr", "comment", "3"], unreadable],
      [["issue", "create", "--title", "x", "--template", "bug"], unreadable],
    ];
    for (const identity of IDENTITIES) {
      using shell = makeShell({ app: identity.app });
      const results = await Promise.all(
        refused.map(([args, , stdin]) => ghAs(shell, identity, args, stdin)),
      );
      refused.forEach(([args, message], index) => {
        const label = `${identity.as}: gh ${args.join(" ")}`;
        expect(results[index]!.status, label).toBe(1);
        expect(results[index]!.stdout, label).toBe("");
        expect(results[index]!.stderr, label).toMatch(message);
      });
      expect(shell.posts().size, identity.as).toBe(0);
    }
  });

  it("lets through the writes agents make, and every read, as the App or the owner", async () => {
    const allowed: ReadonlyArray<readonly [ReadonlyArray<string>, string?]> = [
      [["pr", "review", "3", "--request-changes", "-b", "Needs a test."]],
      [["pr", "create", "--fill", "--draft"]],
      [["pr", "edit", "3", "--add-label", "bug", "--title", "Fix it"]],
      [["pr", "ready", "3"]],
      [["pr", "close", "3", "-c", "Superseded by #4."]],
      [["issue", "edit", "3", "--add-label", "kin"]],
      [["issue", "close", "3", "--reason", "completed"]],
      [["label", "create", "flaky", "-c", "ff0000"]],
      [["run", "rerun", "5", "--failed"]],
      [["api", "repos/invented-co/app/pulls/3/reviews", "-f", "event=COMMENT", "-f", "body=x"]],
      [["api", "repos/invented-co/app/issues/3/reactions", "-f", "content=eyes"]],
      [["api", "-X", "POST", "repos/invented-co/app/actions/runs/5/rerun-failed-jobs"]],
      [["api", "-X", "PUT", "repos/invented-co/app/issues/3/labels", "-f", "labels[]=bug"]],
      [
        ["api", "graphql", "--input", "-"],
        JSON.stringify({ query: REVIEW_QUERY, variables: { input: { pullRequestId: "PR_1" } } }),
      ],
      // Reads, however they ask.
      [["api", "repos/invented-co/app/pulls/3/merge"]],
      [["api", "-X", "GET", "search/issues", "-f", "q=is:open"]],
      [
        [
          "api",
          "graphql",
          "-F",
          "owner={owner}",
          "-f",
          'query=query($owner: String!) { repository(owner: $owner, name: "app") { pullRequest(number: 3) { reviews(states: APPROVED) { totalCount } } } }',
        ],
      ],
      [["api", "graphql", "--input", "-"], JSON.stringify({ query: "{ viewer { login } }" })],
      [["repo", "view", "invented-co/app"]],
      [["pr", "checks", "3"]],
      [["pr", "diff", "3"]],
      [["run", "view", "--log-failed"]],
      [["search", "prs", "--author", "@me"]],
      [["status"]],
      [["--version"]],
    ];
    for (const identity of IDENTITIES) {
      using shell = makeShell({ app: identity.app });
      const results = await Promise.all(
        allowed.map(([args, stdin]) => ghAs(shell, identity, args, stdin)),
      );
      allowed.forEach(([args], index) =>
        expect(
          results[index]!.status,
          `${identity.as}: gh ${args.join(" ")}: ${results[index]!.stderr}`,
        ).toBe(0),
      );
    }
  });

  it("signs the agent's words in every form it can post them, so its /kin never wakes an agent", async () => {
    const runs = IDENTITIES.flatMap((identity) =>
      POST_FORMS.map(async (post) => {
        const shell = makeShell({ app: identity.app });
        try {
          if (post.file !== undefined)
            NodeFS.writeFileSync(NodePath.join(shell.dir, "review.json"), post.file);
          const result = await ghAs(shell, identity, post.args, post.stdin);
          const label = `${identity.as}: ${post.form}`;
          expect(result.status, `${label}: ${result.stderr}`).toBe(0);
          const landed = post.landed({
            args: shell.argsOf(result.stdout),
            json: shell.sentOf(result.stdout),
          });
          expect(landed, label).toBe(signed(WORDS, AGENT));
          const posts = shell.posts();
          // As GitHub shows it: signed, under whoever posted it.
          expect(
            decideTriggers(
              withComment(landed, identity.author, identity.association),
              watchContext(posts),
            ),
            label,
          ).toEqual([]);
          // Had the signature been lost, Kin's record of what the shell sent still knows it.
          const unsigned = withComment(WORDS, "invented-owner", "OWNER");
          expect(decideTriggers(unsigned, watchContext(posts)), label).toEqual([]);
          expect(
            decideTriggers(unsigned, watchContext()).map((trigger) => trigger.kind),
            label,
          ).toEqual(["call"]);
        } finally {
          shell[Symbol.dispose]();
        }
      }),
    );
    await Promise.all(runs);
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

  it("pushes branches, never the remote's default branch or a tag, and runs the repo's own hook", () => {
    for (const [app, command] of [
      [true, ["git"]],
      [true, ["kin-as-owner", "git"]],
      [false, ["git"]],
    ] as const) {
      using shell = makeShell({ app });
      // The remote as GitHub would hold it, set up outside the agent's shell.
      const plain = (args: ReadonlyArray<string>, cwd = shell.dir) =>
        NodeChildProcess.spawnSync("git", [...args], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      const origin = NodePath.join(shell.dir, "origin.git");
      const seed = NodePath.join(shell.dir, "seed");
      plain(["init", "-q", "--bare", "-b", "main", origin]);
      plain(["init", "-q", "-b", "main", seed]);
      plain(
        [
          "-c",
          "user.name=Seed",
          "-c",
          "user.email=seed@invented.example",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        ],
        seed,
      );
      plain(["push", "-q", origin, "main"], seed);
      const repo = NodePath.join(shell.dir, "work");
      plain(["clone", "-q", origin, repo]);
      plain(["config", "alias.ship", "push"], repo);
      const marker = NodePath.join(shell.dir, "repo-hook-ran");
      NodeFS.writeFileSync(
        NodePath.join(repo, ".git", "hooks", "pre-push"),
        `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`,
        { mode: 0o755 },
      );
      const git = (...args: ReadonlyArray<string>) =>
        shell.run(command[0], [...command.slice(1), ...args], { cwd: repo, name: AGENT });
      const mainBefore = plain(["rev-parse", "main"], origin).stdout;
      git("commit", "-q", "--allow-empty", "-m", "Rename hello");
      git("tag", "v1");

      expect(git("push", "-q", "origin", "HEAD:refs/heads/rename").status).toBe(0);
      expect(NodeFS.existsSync(marker)).toBe(true);
      NodeFS.rmSync(marker);
      expect(git("push", "-q", "--no-verify", "origin", "HEAD:refs/heads/rename-2").status).toBe(0);
      expect(NodeFS.existsSync(marker)).toBe(false);
      for (const push of [
        ["push", "origin", "HEAD:main"],
        ["push", "--force", "origin", "HEAD:refs/heads/main"],
        ["push", "--no-verify", "origin", "+HEAD:main"],
        ["push", "origin", ":main"],
        ["ship", "origin", "HEAD:main"],
      ]) {
        const result = git(...push);
        expect(result.status, push.join(" ")).not.toBe(0);
        expect(result.stderr, push.join(" ")).toContain(
          "kin: Kin agents don't push to a repository's default branch (main)",
        );
      }
      expect(git("push", "origin", "v1").stderr).toContain("kin: Kin agents push branches only");
      expect(plain(["rev-parse", "main"], origin).stdout).toBe(mainBefore);
      expect(plain(["tag", "--list"], origin).stdout).toBe("");
      // As the owner, only what ran is listed: the commit, the tag and the two branch pushes.
      if (command[0] === "kin-as-owner")
        expect(shell.ownerUses().map((use) => use[4]?.split(" ")[1])).toEqual([
          "commit",
          "tag",
          "push",
          "push",
        ]);
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

  it("runs Kin's guarded gh and git by their own paths, wherever they are on PATH", () => {
    using shell = makeShell({ app: true });
    // An unguarded gh and git found ahead of Kin's folder.
    const ahead = NodePath.join(shell.dir, "ahead");
    NodeFS.mkdirSync(ahead);
    NodeFS.symlinkSync(shell.realGh, NodePath.join(ahead, "gh"));
    const realGit = NodeChildProcess.execFileSync("sh", ["-c", "command -v git"], {
      encoding: "utf8",
    }).trim();
    NodeFS.symlinkSync(realGit, NodePath.join(ahead, "git"));
    const path = `${ahead}:${shell.shims}:${process.env.PATH}`;
    const merged = shell.run("kin-as-owner", ["gh", "pr", "merge", "3", "--squash"], {
      name: "Tech lead",
      path,
    });
    expect(merged.status).toBe(1);
    expect(merged.stderr).toMatch(/^kin: Kin agents don't merge/);
    const repo = shell.checkout();
    shell.run("kin-as-owner", ["git", "commit", "-q", "-m", "Add a readme"], {
      cwd: repo,
      name: "Tech lead",
      path,
    });
    expect(shell.run("git", ["log", "-1", "--format=%B"], { cwd: repo }).stdout.trim()).toBe(
      "Add a readme\n\nKin-Agent: Tech lead",
    );
  });

  it("records only what ran: a command Kin's guard refuses isn't listed as done", () => {
    using shell = makeShell({ app: true });
    const refused = shell.run("kin-as-owner", ["gh", "pr", "merge", "3"], { name: "Tech lead" });
    expect(refused.status).toBe(1);
    expect(shell.ownerUses()).toEqual([]);
    shell.run("kin-as-owner", ["gh", "pr", "list", "-R", "invented-co/app"], {
      name: "Tech lead",
    });
    expect(shell.ownerUses().map((use) => use[4])).toEqual(["gh pr list -R invented-co/app"]);
  });

  // Root writes through any mode, so the chmod below cannot make the record unwritable.
  it.skipIf(process.getuid?.() === 0)("refuses to run what Kin can't record", () => {
    using shell = makeShell({ app: true });
    NodeFS.chmodSync(shell.app, 0o500);
    const result = shell.run("kin-as-owner", ["gh", "pr", "list"], { name: "Tech lead" });
    NodeFS.chmodSync(shell.app, 0o700);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("couldn't record");
  });
});
