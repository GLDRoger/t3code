// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - a dev CLI managing its own processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { VerifyError } from "./rpc.ts";

export const ROOT = NodePath.resolve(import.meta.dirname, "..", "..");
export const ORG = "kin-default";
export const OWNER_PERSON = "kin-default-owner";
export const FAKE_MAIL = "google:accounts@ambermill.example,microsoft:hello@ambermill.example";

export interface Instance {
  readonly name: string;
  /** The T3 base dir the server runs on: `<checkout>/.t3/kin-verify/<name>`. */
  readonly home: string;
  readonly userdata: string;
  /** kin-verify's own files: state, log, sessions, browser profiles, scripted turns. */
  readonly meta: string;
}

export interface InstanceState {
  readonly pid: number;
  readonly commit: string;
  readonly startedAt: number;
  readonly serverPort?: number;
  readonly webPort?: number;
  readonly origin?: string;
  readonly web?: string;
  readonly chrome?: Record<string, number>;
  readonly metro?: number | undefined;
}

export interface SeedState {
  readonly name: string;
  readonly seededAt: string;
  readonly people: Record<string, { personId: string; displayName: string }>;
  readonly agents: Record<string, { agentId: string; name: string; ownerChatId: string }>;
  readonly environmentId: string;
}

const realOrSelf = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** True when `path` is `dir` or inside it, after resolving links. */
export const isInside = (path: string, dir: string) => {
  const relative = NodePath.relative(realOrSelf(dir), realOrSelf(path));
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

/** The live install the developer uses; nothing here may read or write its userdata. */
export const LIVE_T3 = NodePath.join(NodeOS.homedir(), ".t3");
const LIVE_USERDATA = NodePath.join(LIVE_T3, "userdata");

export function instanceOf(name: string): Instance {
  if (!/^[a-z0-9-]{1,32}$/.test(name))
    throw new VerifyError(`instance name "${name}": use lowercase letters, digits and dashes`);
  const home = NodePath.join(ROOT, ".t3", "kin-verify", name);
  const userdata = NodePath.join(home, "userdata");
  if (isInside(userdata, LIVE_USERDATA) || realOrSelf(home) === realOrSelf(LIVE_T3))
    throw new VerifyError(`refusing: ${home} resolves into the live ${LIVE_USERDATA}`);
  return { name, home, userdata, meta: NodePath.join(home, "verify") };
}

export const readJson = <A>(path: string): A | undefined => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as A;
  } catch {
    return undefined;
  }
};
export const writeJson = (path: string, value: unknown) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

export const readState = (instance: Instance) =>
  readJson<InstanceState>(NodePath.join(instance.meta, "instance.json"));
export const writeState = (instance: Instance, state: InstanceState) =>
  writeJson(NodePath.join(instance.meta, "instance.json"), state);
export const readSeed = (instance: Instance) =>
  readJson<SeedState>(NodePath.join(instance.meta, "seed.json"));
export const writeSeed = (instance: Instance, seed: SeedState) =>
  writeJson(NodePath.join(instance.meta, "seed.json"), seed);
export const readSession = (instance: Instance, person: string) =>
  readJson<{ accessToken: string }>(NodePath.join(instance.meta, "sessions", `${person}.json`))
    ?.accessToken;
export const writeSession = (instance: Instance, person: string, accessToken: string) =>
  writeJson(NodePath.join(instance.meta, "sessions", `${person}.json`), { accessToken });

export const isAlive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The process and every descendant, walked down from a PID we captured at spawn. */
export function processTree(pid: number): Array<number> {
  const out = [pid];
  const children = NodeChildProcess.spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
  for (const child of children) out.push(...processTree(child));
  return out;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops a captured PID and its descendants: TERM, then KILL whatever is left after 8 s. */
export async function stopTree(pid: number | undefined): Promise<number> {
  if (pid === undefined || !isAlive(pid)) return 0;
  const pids = processTree(pid);
  for (const one of pids) {
    try {
      process.kill(one, "SIGTERM");
    } catch {}
  }
  for (let waited = 0; waited < 8000 && pids.some(isAlive); waited += 200) await sleep(200);
  for (const one of pids.filter(isAlive)) {
    try {
      process.kill(one, "SIGKILL");
    } catch {}
  }
  return pids.length;
}

export const gitHead = () =>
  NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();

/** The scripted no-model agent as a provider instance, beside the dev server's own settings. */
function writeScriptProvider(instance: Instance) {
  const path = NodePath.join(instance.userdata, "settings.json");
  const settings = readJson<Record<string, unknown>>(path) ?? {};
  const providers = (settings.providerInstances ?? {}) as Record<string, unknown>;
  providers.kinVerifyScript = {
    driver: "acpRegistry",
    displayName: "Script (kin-verify)",
    config: {
      source: "local",
      commandPath: process.execPath,
      commandArgs: [NodePath.join(ROOT, "scripts", "kin-verify", "script-agent.ts")],
    },
  };
  writeJson(path, { ...settings, providerInstances: providers });
}

export const logPath = (instance: Instance) => NodePath.join(instance.meta, "dev.log");

export function tailLog(instance: Instance, lines = 15): string {
  try {
    return NodeFS.readFileSync(logPath(instance), "utf8")
      .split("\n")
      .filter((line) => !/^\s+'/.test(line))
      .slice(-lines)
      .join("\n")
      .replace(/(token=|#)[A-Za-z0-9_.-]{12,}/g, "$1<redacted>");
  } catch {
    return "(no log)";
  }
}

/** Starts the dev runner on the instance's home: Kin on, fake mail, no copy of live data. */
export async function startServer(instance: Instance): Promise<InstanceState> {
  NodeFS.mkdirSync(instance.meta, { recursive: true });
  NodeFS.mkdirSync(instance.userdata, { recursive: true });
  writeScriptProvider(instance);
  // GitHub's login is a stand-in under the instance, never this machine's own gh or git config.
  const fakeGitHub = NodePath.join(instance.meta, "github");
  for (const dir of ["state", "home", "config"])
    NodeFS.mkdirSync(NodePath.join(fakeGitHub, dir), { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(ROOT, "apps/server/src/kin/connections/fakeGh.sh"),
    NodePath.join(fakeGitHub, "gh"),
  );
  NodeFS.chmodSync(NodePath.join(fakeGitHub, "gh"), 0o755);
  NodeFS.copyFileSync(
    NodePath.join(ROOT, "apps/server/src/kin/github/fakeGitHub.ts"),
    NodePath.join(fakeGitHub, "fakeGitHub.ts"),
  );
  const log = NodeFS.openSync(logPath(instance), "a");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIN_ENABLED: "true",
    T3CODE_DEV_SEED: "0",
    KIN_DEV_FAKE_MAIL: FAKE_MAIL,
    KIN_DEV_PUSH_CAPTURE: "1",
    KIN_VERIFY_DIR: instance.meta,
    KIN_DEV_FAKE_GITHUB: fakeGitHub,
    KIN_DEV_FAKE_SOCIAL: "1",
    // Kin's now follows `kv clock` (see apps/server/src/kin/DevClock.ts).
    KIN_DEV_CLOCK: "true",
    // Ports hash from this, not the checkout path, so instances of one checkout can run side by side.
    T3CODE_DEV_INSTANCE: `kin-verify-${instance.name}`,
  };
  // Dev is single-origin; baking an origin in breaks remote browsers (AGENTS.md).
  delete env.VITE_HTTP_URL;
  delete env.VITE_WS_URL;
  delete env.T3CODE_HOME;
  const startedAt = Date.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["scripts/dev-runner.ts", "dev", "--home-dir", instance.home, "--no-seed"],
    { cwd: ROOT, env, detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  const previous = readState(instance);
  const state: InstanceState = {
    pid: child.pid!,
    commit: gitHead(),
    startedAt,
    ...(previous?.chrome === undefined ? {} : { chrome: previous.chrome }),
  };
  writeState(instance, state);
  const deadline = startedAt + 120_000;
  while (Date.now() < deadline) {
    if (!isAlive(state.pid))
      throw new VerifyError(`dev server exited during start. Log tail:\n${tailLog(instance)}`);
    const text = NodeFS.readFileSync(logPath(instance), "utf8");
    const line = [...text.matchAll(/\[dev-runner\] mode=dev .*serverPort=(\d+) webPort=(\d+)/g)].at(
      -1,
    );
    const runtime = readJson<{ pid: number; origin: string; startedAt: string }>(
      NodePath.join(instance.userdata, "server-runtime.json"),
    );
    if (
      line !== undefined &&
      runtime !== undefined &&
      Date.parse(runtime.startedAt) >= startedAt - 1000 &&
      processTree(state.pid).includes(runtime.pid)
    ) {
      const web = `http://localhost:${line[2]}`;
      const ok = await fetch(web).then(
        (response) => response.ok,
        () => false,
      );
      if (ok) {
        const ready: InstanceState = {
          ...state,
          serverPort: Number(line[1]),
          webPort: Number(line[2]),
          origin: runtime.origin,
          web,
        };
        writeState(instance, ready);
        return ready;
      }
    }
    await sleep(250);
  }
  await stopTree(state.pid);
  throw new VerifyError(
    `dev server not ready in 120 s; stopped it. Log tail:\n${tailLog(instance)}`,
  );
}

/** Mints an owner pairing credential with T3's own `pair` command against this instance. */
export function mintPairing(instance: Instance, label: string): { token: string; url: string } {
  const out = NodeChildProcess.spawnSync(
    process.execPath,
    ["src/bin.ts", "pair", "--base-dir", instance.home, "--label", label, "--ttl", "10m"],
    {
      cwd: NodePath.join(ROOT, "apps", "server"),
      encoding: "utf8",
      env: { ...process.env, KIN_ENABLED: "true" },
    },
  );
  const token = /^Token: (\S+)/m.exec(out.stdout)?.[1];
  const url = /^Pairing URL: (\S+)/m.exec(out.stdout)?.[1];
  if (token === undefined || url === undefined)
    throw new VerifyError(
      `t3 pair failed: ${out.stderr.split("\n").filter(Boolean).at(-1) ?? "no output"}`,
    );
  return { token, url };
}

/** Runs a server CLI command (`kin import`, `kin pulse`) on this instance's home. */
export function serverCli(instance: Instance, args: ReadonlyArray<string>) {
  return NodeChildProcess.spawnSync(
    process.execPath,
    ["src/bin.ts", ...args, "--base-dir", instance.home],
    {
      cwd: NodePath.join(ROOT, "apps", "server"),
      encoding: "utf8",
      env: { ...process.env, KIN_ENABLED: "true" },
    },
  );
}
