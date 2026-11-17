// One command: fresh Kin with an invented company, then Bombadil walks the web UI as each role.
// node verification/kin/ui/run.ts --out <dir> [--time 3m] [--roles owner,coowner,lead,member,member2]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

const here = import.meta.dirname;
const root = NodePath.resolve(here, "../../..");
const { values: args } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    time: { type: "string", default: "3m" },
    roles: { type: "string", default: "owner,coowner,lead,member,member2" },
    bombadil: { type: "string", default: process.env.BOMBADIL ?? "bombadil" },
    headed: { type: "boolean", default: false },
  },
});
if (!args.out) throw new Error("--out <dir> is required (outside ~/.t3)");
const out = NodePath.resolve(args.out);
if (out.startsWith(NodePath.join(NodeOS.homedir(), ".t3")))
  throw new Error(`Refusing to write under ~/.t3: ${out}`);
NodeFS.mkdirSync(out, { recursive: true });

const state = NodePath.join(root, ".t3", "kin-ui-fuzz");
const home = NodePath.join(state, "home");
const snapshot = NodePath.join(state, "seeded");
const stubs = NodePath.join(state, "no-models");
NodeFS.rmSync(state, { recursive: true, force: true });
NodeFS.mkdirSync(home, { recursive: true });
// Provider CLIs resolve through PATH: these stubs make every agent turn fail before it reaches a model.
NodeFS.mkdirSync(stubs);
for (const cli of ["claude", "codex", "cursor-agent", "opencode", "grok", "kiro-cli", "gemini"])
  NodeFS.writeFileSync(
    NodePath.join(stubs, cli),
    "#!/bin/sh\necho 'kin-ui fuzz: model calls are off' >&2\nexit 1\n",
    { mode: 0o755 },
  );

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: [
    stubs,
    NodePath.join(NodeOS.homedir(), ".local/share/vite-plus/fallback-bin"),
    process.env.PATH,
  ].join(":"),
  KIN_ENABLED: "true",
  T3CODE_DEV_SEED: "0",
  T3CODE_DEV_AUTH_TOKEN: NodeCrypto.randomBytes(24).toString("hex"),
  KIN_DEV_FAKE_MAIL: "google:accounts@ambermill.example",
};
for (const name of ["VITE_HTTP_URL", "VITE_WS_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
  delete env[name];

let server: NodeChildProcess.ChildProcess | undefined;
const stopServer = async () => {
  // The dev server runs in its own process group, started here; only that group is signalled.
  const s = server;
  server = undefined;
  if (s?.pid === undefined || s.exitCode !== null) return;
  const exited = new Promise((r) => s.once("exit", r));
  try {
    process.kill(-s.pid, "SIGTERM");
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  try {
    process.kill(-s.pid, "SIGKILL");
  } catch {}
};
process.on("exit", () => server?.pid !== undefined && process.kill(-server.pid, "SIGKILL"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));

const startServer = async (log: string) => {
  NodeFS.writeFileSync(log, "");
  server = NodeChildProcess.spawn("vp", ["run", "dev", "--home-dir", home, "--no-seed"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", NodeFS.openSync(log, "a"), NodeFS.openSync(log, "a")],
  });
  const waitFor = async (pattern: RegExp, seconds: number) => {
    for (let i = 0; i < seconds * 2; i++) {
      const match = NodeFS.readFileSync(log, "utf8").match(pattern);
      if (match) return match;
      if (server?.exitCode !== null) throw new Error(`dev server exited; see ${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`timed out waiting for ${pattern}; see ${log}`);
  };
  const ports = await waitFor(/serverPort=(\d+) webPort=(\d+)/, 60);
  await waitFor(/Listening on http/, 120);
  const origin = `http://localhost:${ports[2]}`;
  // Warm Vite so a walk doesn't spend its minutes on cold module transforms.
  await fetch(`${origin}/kin`).catch(() => undefined);
  return { serverOrigin: `http://127.0.0.1:${ports[1]}`, origin };
};

const node = (script: string, scriptArgs: string[]) =>
  NodeChildProcess.execFileSync("node", [script, ...scriptArgs], {
    cwd: NodePath.join(root, "apps/server"),
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

// Every agent turn must fail at the stub; a wake-up that reached a model is a broken guard.
const modelTurns = () => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM kin_wakeups WHERE first_token_at IS NOT NULL")
      .get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
};

try {
  let { serverOrigin, origin } = await startServer(NodePath.join(out, "seed.log"));
  console.log(`[kin-ui] web ${origin}, state ${home}`);
  node("src/bin.ts", [
    "kin",
    "import",
    "--base-dir",
    home,
    "--file",
    NodePath.join(here, "seed.jsonl"),
    "--apply",
  ]);
  const seeded = JSON.parse(
    node(NodePath.join(here, "seed.ts"), [home, serverOrigin]).trim().split("\n").at(-1)!,
  ) as {
    people: Record<string, string>;
    cookies: Record<string, string>;
  };
  const session = await fetch(`${origin}/api/auth/session`, {
    headers: { authorization: `Bearer ${env.T3CODE_DEV_AUTH_TOKEN}` },
  }).then((r) => r.json());
  const cookieName: string = session.auth.sessionCookieName;
  const cookies: Record<string, string> = { owner: env.T3CODE_DEV_AUTH_TOKEN!, ...seeded.cookies };
  await stopServer();
  NodeFS.cpSync(home, snapshot, { recursive: true });
  console.log(`[kin-ui] seeded: owner, ${Object.keys(seeded.people).join(", ")}`);

  const summary: Record<string, { exit: number; seconds: number; modelTurns: number }> = {};
  for (const role of args.roles.split(",")) {
    if (!cookies[role]) throw new Error(`no session for role ${role}`);
    const dir = NodePath.join(out, role);
    NodeFS.rmSync(dir, { recursive: true, force: true });
    NodeFS.mkdirSync(dir, { recursive: true });
    // Each walk starts from the same seeded company, so one role's taps can't change another's.
    NodeFS.rmSync(home, { recursive: true, force: true });
    NodeFS.cpSync(snapshot, home, { recursive: true });
    ({ origin } = await startServer(NodePath.join(dir, "dev.log")));
    // Bombadil bundles the spec from this folder; the role travels as an imported JSON file.
    NodeFS.writeFileSync(NodePath.join(dir, "role.json"), JSON.stringify({ role }));
    NodeFS.writeFileSync(
      NodePath.join(dir, "spec.ts"),
      `export * from ${JSON.stringify(NodePath.join(here, "spec.ts"))};\nimport role from "./role.json";\nimport { setRole } from ${JSON.stringify(NodePath.join(here, "roles.ts"))};\nsetRole(role.role);\n`,
    );
    const started = Date.now();
    const log = NodeFS.openSync(NodePath.join(dir, "bombadil.log"), "w");
    const code = await new Promise<number>((resolve) => {
      NodeChildProcess.spawn(
        args.bombadil,
        [
          "browser",
          "test",
          `${origin}/kin`,
          NodePath.join(dir, "spec.ts"),
          "--time-limit",
          args.time,
          "--output-path",
          NodePath.join(dir, "trace"),
          "--output-path-overwrite",
          "--cookie",
          `${cookieName}=${cookies[role]}; Path=/; HttpOnly`,
          "--allow-url",
          `${origin}/kin*`,
          "--width",
          "1280",
          "--height",
          "820",
          // Its coverage hook fails on Vite dev modules and stalls them; Kin needs none.
          "--instrument-javascript",
          "",
          ...(args.headed ? [] : ["--headless"]),
          // Chromium refuses to start as root with its sandbox on (a container or WSL runner).
          ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        ],
        { stdio: ["ignore", log, log] },
      ).on("exit", (c) => resolve(c ?? 1));
    });
    await stopServer();
    summary[role] = {
      exit: code,
      seconds: Math.round((Date.now() - started) / 1000),
      modelTurns: modelTurns(),
    };
    console.log(
      `[kin-ui] ${role}: bombadil exit ${code} (0 clean, 2 violations, 1 error) in ${summary[role].seconds}s`,
    );
    if (summary[role].modelTurns > 0)
      throw new Error(`${role}: ${summary[role].modelTurns} agent turns reached a model`);
  }
  NodeFS.writeFileSync(
    NodePath.join(out, "run.json"),
    JSON.stringify({ people: seeded.people, summary }, null, 2),
  );
  NodeChildProcess.execFileSync("node", [NodePath.join(here, "summarize.ts"), out], {
    stdio: "inherit",
  });
} finally {
  await stopServer();
}
