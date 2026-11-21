#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - a plain CLI that runs Kin's existing checks in order.
// One release check: runs Kin's checks cheapest first, writes every failure as a stable fingerprint
// and compares them with a previous run or release, so only NEW findings matter.
//
//   node scripts/kin-release-check.ts [--quick|--full] [--against <commit|findings.json>] [--out <dir>]
//        [--base <ref>] [--only <stage,...>] [--keep-going] [--fuzz-time 2m] [--keep-traces]
//        [--lifecycle-workers N] [--here]
//   With KIN_RELEASE_REMOTE set to an ssh host, the check runs there through
//   KIN_RELEASE_REMOTE_COMMAND (scripts/kin-release-remote.sh) and falls back to this machine when
//   that one is unreachable, busy or can't fetch the commit. --here always runs it here.
//   node scripts/kin-release-check.ts --mark-released <commit> [--from <findings.json>]
//
// Outputs (findings.json, summary.md, report.html, logs) go to --out, by default
// $KIN_RELEASE_CHECK_DIR/<commit>/<mode> (KIN_RELEASE_CHECK_DIR defaults to ~/.cache/kin-release-check).
// A full run also keeps <dir>/<commit>/fixture: the lifecycle company's state, so the next release's
// migration check starts the new build on this release's database. The release record is
// ops/kin/releases.json. See docs/operations/kin-release.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { html, markdown } from "./kin-release-check/report.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const RECORD = NodePath.join(ROOT, "ops", "kin", "releases.json");
const LIFECYCLE = NodePath.join(ROOT, ".agents", "skills", "verify-kin", "scripts");
const MODELS = ["send", "reply", "checkin"] as const;
const PROPERTY_TESTS = [
  "src/kin/pulse/checkIn.property.test.ts",
  "src/kin/work/nameMatch.property.test.ts",
  "src/kin/work/recordRows.property.test.ts",
  "src/kin/work/teamView.property.test.ts",
];
const FUZZ_ROLES = ["owner", "coowner", "lead", "member"];
const MIGRATE_SCRIPTS = ["relay-owner-to-member", "send-card-once"];
const STAGES = [
  "static",
  "models",
  "properties",
  "lifecycle",
  "migrate",
  "ui-fuzz",
  "lookbook",
] as const;
type Stage = (typeof STAGES)[number];
const FULL_ONLY: ReadonlyArray<Stage> = ["migrate", "ui-fuzz", "lookbook"];
const LOOKBOOK = NodePath.join(ROOT, "scripts", "kin-lookbook.ts");
// The fuzz is random: its findings gate the exit only when they are NEW.
const NONDETERMINISTIC: ReadonlyArray<Stage> = ["ui-fuzz"];

export interface Finding {
  readonly fingerprint: string;
  readonly stage: Stage;
  readonly check: string;
  readonly step: string;
  readonly role: string;
  readonly message: string;
}
/** A finding as the release record keeps it: the message is left out. */
export type Recorded = Omit<Finding, "message"> & { readonly message?: string };
interface StageResult {
  readonly stage: Stage;
  status: "pass" | "fail" | "skipped" | "not run";
  seconds: number;
  note: string;
}
export interface Findings {
  readonly commit: string;
  readonly mode: "quick" | "full";
  readonly base: string;
  readonly startedAt: string;
  finishedAt: string;
  readonly stages: Array<StageResult>;
  readonly findings: Array<Finding>;
  blockedProviderCalls: number;
  modelTurns: number;
}
interface Release {
  readonly commit: string;
  readonly date: string;
  readonly mode: "quick" | "full";
  readonly findings: ReadonlyArray<Omit<Finding, "message">>;
}

/** Strips what changes between runs of the same failure: run tokens, ids, numbers, quoted values. */
export const normalise = (message: string) =>
  message
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/(expected|found) "[^"]*"/g, '$1 "…"')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

export const finding = (
  stage: Stage,
  check: string,
  step: string,
  role: string,
  message: string,
): Finding => {
  const normal = normalise(message);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update([stage, check, normalise(step), role, normal].join("\u0000"))
    .digest("hex")
    .slice(0, 12);
  return { fingerprint, stage, check, step, role, message: normal };
};

/** NEW, FIXED and STILL PRESENT, over the stages this run actually ran. */
export const compare = (
  current: ReadonlyArray<Finding>,
  previous: ReadonlyArray<Recorded>,
  ranStages: ReadonlyArray<Stage>,
) => {
  const before = new Set(previous.map((one) => one.fingerprint));
  const now = new Set(current.map((one) => one.fingerprint));
  return {
    new: current.filter((one) => !before.has(one.fingerprint)),
    fixed: previous.filter((one) => ranStages.includes(one.stage) && !now.has(one.fingerprint)),
    still: current.filter((one) => before.has(one.fingerprint)),
  };
};

/** A deterministic finding always fails the run; a fuzz finding only when it is NEW. */
export const gates = (findingItem: Finding, isNew: boolean) =>
  isNew || !NONDETERMINISTIC.includes(findingItem.stage);

const git = (...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const short = (sha: string) => sha.slice(0, 12);
const fixtureOf = (sha: string) => NodePath.join(checkDir(), short(sha), "fixture");
/** Each worker runs a server, a web build and a Chrome per person: about three cores each. */
export const lifecycleWorkersOf = (flag: string | undefined) => {
  const asked = flag === undefined ? Number.NaN : Number(flag);
  if (Number.isInteger(asked) && asked >= 1) return asked;
  return Math.min(4, Math.max(1, Math.floor(NodeOS.availableParallelism() / 3)));
};
const checkDir = () =>
  NodePath.resolve(
    process.env.KIN_RELEASE_CHECK_DIR ??
      NodePath.join(NodeOS.homedir(), ".cache", "kin-release-check"),
  );
const refuseLive = (dir: string) => {
  if (NodePath.resolve(dir).startsWith(NodePath.join(NodeOS.homedir(), ".t3")))
    throw new Error(`refusing to write under ~/.t3: ${dir}`);
};
const readRecord = (): Array<Release> =>
  NodeFS.existsSync(RECORD) ? JSON.parse(NodeFS.readFileSync(RECORD, "utf8")) : [];
const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const findingsFor = (sha: string) =>
  ["full", "quick"]
    .map((mode) => NodePath.join(checkDir(), short(sha), mode, "findings.json"))
    .find((path) => readJson<Findings>(path)?.commit === sha);

interface Ran {
  readonly code: number;
  readonly output: string;
}
/** Runs a command to completion, teeing its output to a log and returning it. */
export const run = (
  log: string,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  new Promise<Ran>((resolve) => {
    const out = NodeFS.createWriteStream(log, { flags: "a" });
    out.write(`\n$ ${command} ${args.join(" ")}\n`);
    let output = "";
    // Its own process group, so a hung or interrupted stage is stopped as a whole, by the pid we spawned.
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) children.add(child.pid);
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (!out.writableEnded) out.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) children.delete(child.pid);
      // The log opens asynchronously: answer once it is closed, so a caller may remove its folder.
      out.end(() => resolve({ code, output }));
    };
    // A program that can't start (not on PATH, not executable) is a failed stage, not a crashed check.
    child.on("error", (error) => {
      take(Buffer.from(`${command}: ${error.message}\n`));
      settle(127);
    });
    child.on("close", (code) => settle(code ?? 1));
  });
const children = new Set<number>();
export const stopChildren = () => {
  for (const pid of children) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
  }
};

// Provider CLIs resolve through PATH: these stubs fail every one and count the calls, so no stage can
// reach a model even if a check goes wrong. The scripted kin-verify agent runs on node, not a CLI.
let env: NodeJS.ProcessEnv = process.env;
const blockModels = (out: string) => {
  const stubs = NodePath.join(out, "no-models");
  NodeFS.mkdirSync(stubs, { recursive: true });
  const calls = NodePath.join(stubs, "calls.log");
  NodeFS.writeFileSync(calls, "");
  for (const cli of [
    "claude",
    "codex",
    "cursor-agent",
    "opencode",
    "grok",
    "kiro-cli",
    "gemini",
    "agy",
  ])
    NodeFS.writeFileSync(
      NodePath.join(stubs, cli),
      `#!/bin/sh\necho "${cli} $*" >> ${JSON.stringify(calls)}\necho 'kin-release-check: model calls are off' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  env = {
    ...process.env,
    // kin-verify puts these first on its server's PATH instead of its own, so they are counted.
    KIN_VERIFY_NO_MODELS: stubs,
    PATH: [
      stubs,
      NodePath.join(NodeOS.homedir(), ".local/share/vite-plus/fallback-bin"),
      process.env.PATH,
    ].join(":"),
  };
  for (const name of [
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "T3CODE_HOME",
  ])
    delete env[name];
  return () => NodeFS.readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
};

interface Context {
  readonly out: string;
  readonly log: (stage: Stage) => string;
  readonly sha: string;
  readonly base: string;
  readonly previousRelease: string | undefined;
  readonly fuzzTime: string;
  readonly keepTraces: boolean;
  readonly lifecycleWorkers: number;
  readonly report: Findings;
  /** Models `check:changed` already ran in this run's static stage, so `models` skips them. */
  readonly modelsChecked: Set<string>;
}

const kv = (ctx: Context, stage: Stage, instance: string, ...args: string[]) =>
  run(ctx.log(stage), process.execPath, [
    NodePath.join(ROOT, "scripts", "kin-verify.ts"),
    "--instance",
    instance,
    ...args,
  ]);

/** Models check:changed checked; one it passed with `--if-java` and no Java wasn't. */
export const modelsRan = (output: string) =>
  new Set(
    [...output.matchAll(/^\s+(?:pass|FAIL)\s+kin model (\w+)\s/gm)]
      .map(([, name]) => name!)
      .filter((name) => !output.includes(`${name}: skipped: Java not found`)),
  );

const staticChecks = async (ctx: Context): Promise<Finding[]> => {
  // A release spans many PRs, so its changed-file tests take far longer than one PR's.
  const { code, output } = await run(ctx.log("static"), "vp", [
    "run",
    "check:changed",
    ctx.base,
    "--timeout",
    "3600",
  ]);
  const failed = [
    ...output.matchAll(/^\s+(FAIL|TIMEOUT)\s+(.+?)\s+(?:[\d.]+s|killed after \d+s)$/gm),
  ].map(([, outcome, step]) => finding("static", "check:changed", step!, "-", outcome!));
  for (const name of modelsRan(output)) ctx.modelsChecked.add(name);
  if (code !== 0 && failed.length === 0)
    failed.push(
      finding(
        "static",
        "check:changed",
        "run",
        "-",
        output.trim().split("\n").at(-1) ?? `exit ${code}`,
      ),
    );
  return failed;
};

const models = async (ctx: Context): Promise<Finding[] | string> => {
  const found: Finding[] = [];
  const left = MODELS.filter((name) => !ctx.modelsChecked.has(name));
  if (left.length === 0) return `checked by static's check:changed: ${MODELS.join(", ")}`;
  for (const name of left) {
    const { code, output } = await run(ctx.log("models"), process.execPath, [
      NodePath.join(ROOT, "scripts", "kin-model.ts"),
      name,
    ]);
    const broken = [...output.matchAll(/^FAIL\s+(\w+):\s*(.*)$/gm)].map(([, rule]) =>
      finding("models", name, rule!, "-", "rule broken"),
    );
    if (code !== 0 && broken.length === 0)
      broken.push(
        finding("models", name, "run", "-", output.trim().split("\n").at(-1) ?? `exit ${code}`),
      );
    found.push(...broken);
  }
  return found;
};

const properties = async (ctx: Context): Promise<Finding[]> => {
  const report = NodePath.join(ctx.out, "properties.json");
  NodeFS.rmSync(report, { force: true });
  const { code, output } = await run(
    ctx.log("properties"),
    "vp",
    ["test", "run", ...PROPERTY_TESTS, "--reporter=json", `--outputFile=${report}`],
    { cwd: NodePath.join(ROOT, "apps", "server") },
  );
  const json = readJson<{
    testResults: Array<{
      name: string;
      message?: string;
      assertionResults: Array<{ title: string; ancestorTitles: string[]; status: string }>;
    }>;
  }>(report);
  const found = (json?.testResults ?? []).flatMap((file) => {
    const fileName = NodePath.relative(ROOT, file.name);
    const failedTests = file.assertionResults
      .filter((test) => test.status === "failed")
      .map((test) =>
        finding(
          "properties",
          fileName,
          [...test.ancestorTitles, test.title].join(" > "),
          "-",
          "falsified",
        ),
      );
    if (failedTests.length === 0 && file.message)
      failedTests.push(finding("properties", fileName, "load", "-", file.message.split("\n")[0]!));
    return failedTests;
  });
  if (code !== 0 && found.length === 0)
    found.push(
      finding(
        "properties",
        "vp test",
        "run",
        "-",
        output.trim().split("\n").at(-1) ?? `exit ${code}`,
      ),
    );
  return found;
};

/** FAIL and known lines from lifecycle scripts, plus a script that failed without saying why. */
const lifecycleFindings = (stage: Stage, output: string, check: string) => {
  const found: Finding[] = [];
  const failedScripts = new Set<string>();
  for (const [, script, message] of output.matchAll(/^FAIL ([\w-]+): (.*)$/gm)) {
    failedScripts.add(script!);
    found.push(finding(stage, check, script!, "-", message!));
  }
  for (const [, script, message] of output.matchAll(/^known ([\w-]+): (.*)$/gm))
    found.push(finding(stage, check, script!, "-", `known: ${message}`));
  for (const [, script] of output.matchAll(/^\s+([\w-]+) failed in \d+s$/gm))
    if (!failedScripts.has(script!))
      found.push(finding(stage, check, script!, "-", "exited non-zero"));
  return found;
};

/** One instance per worker; the first keeps the company the next release's migration starts from. */
export const lifecycleInstances = (workers: number) =>
  Array.from({ length: workers }, (_, index) =>
    index === 0 ? "release-check" : `release-check-${index + 1}`,
  );

/** Every lifecycle script, shared out to the workers through a queue: each takes the next one left. */
const lifecycle = async (ctx: Context): Promise<Finding[]> => {
  const instances = lifecycleInstances(ctx.lifecycleWorkers);
  const queue = NodePath.join(ctx.out, "lifecycle-queue");
  NodeFS.rmSync(queue, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(queue, "todo"), { recursive: true });
  const listed = await run(ctx.log("lifecycle"), "bash", [
    NodePath.join(LIFECYCLE, "run-all.sh"),
    "--list",
  ]);
  listed.output
    .split("\n")
    .filter(Boolean)
    .forEach((name, index) =>
      NodeFS.writeFileSync(
        NodePath.join(queue, "todo", `${String(index).padStart(3, "0")}-${name}`),
        "",
      ),
    );
  try {
    const ran = await Promise.all(
      instances.map((instance) =>
        run(NodePath.join(ctx.out, `lifecycle-${instance}.log`), "bash", [
          NodePath.join(LIFECYCLE, "run-all.sh"),
          "--instance",
          instance,
          "--queue",
          queue,
        ]),
      ),
    );
    const output = ran.map((one) => one.output).join("\n");
    NodeFS.appendFileSync(ctx.log("lifecycle"), output);
    const found = lifecycleFindings("lifecycle", output, "run-all");
    ran.forEach(({ code, output: own }, index) => {
      if (code !== 0 && lifecycleFindings("lifecycle", own, "run-all").length === 0)
        found.push(
          finding(
            "lifecycle",
            "run-all",
            "up",
            "-",
            `${instances[index]}: ${own.trim().split("\n").at(-1) ?? `exit ${code}`}`,
          ),
        );
    });
    const left = NodeFS.readdirSync(NodePath.join(queue, "todo"));
    for (const file of left)
      found.push(finding("lifecycle", "run-all", file.replace(/^\d+-/, ""), "-", "never ran"));
    if (ctx.report.mode === "full") keepFixture(ctx, instances[0]!);
    return found;
  } finally {
    for (const instance of instances) await kv(ctx, "lifecycle", instance, "down", "--wipe");
  }
};

const instanceHome = (name: string) => NodePath.join(ROOT, ".t3", "kin-verify", name);

/** The first lifecycle instance's company after its scripts, kept outside git for the next release's migration check. */
const keepFixture = (ctx: Context, instance: string) => {
  const fixture = fixtureOf(ctx.sha);
  NodeFS.rmSync(fixture, { recursive: true, force: true });
  NodeFS.cpSync(instanceHome(instance), fixture, {
    recursive: true,
    // Chrome profiles keep the sign-ins; their caches and the logs are not needed.
    filter: (source) =>
      !/\/(Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|Service Worker|logs)(\/|$)|\.log$/.test(
        source,
      ),
  });
  NodeFS.writeFileSync(NodePath.join(fixture, "commit"), `${ctx.sha}\n`);
  NodeFS.writeFileSync(NodePath.join(fixture, "home"), `${instanceHome(instance)}\n`);
};

/**
 * The server stores absolute paths into its home (thread workspaces, memory repos). A fixture
 * restored elsewhere gets them rewritten to its new home, in the database and in small text files.
 */
const relocate = (home: string, from: string) => {
  if (from === "" || from === home) return;
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "statev2.sqlite"));
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'",
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables)
      for (const { name: column } of db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
        name: string;
      }>)
        try {
          db.prepare(
            `UPDATE "${name}" SET "${column}" = replace("${column}", ?, ?) WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`,
          ).run(from, home, from);
        } catch {
          // FTS shadow tables and generated columns refuse updates; they hold no paths a turn reads.
        }
  } finally {
    db.close();
  }
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== NodePath.join(home, "verify", "chrome")) walk(path);
      } else if (
        entry.isFile() &&
        !/\.sqlite(-wal|-shm)?$/.test(entry.name) &&
        NodeFS.statSync(path).size < 1_000_000
      ) {
        const text = NodeFS.readFileSync(path, "utf8");
        if (!text.includes("\u0000") && text.includes(from))
          NodeFS.writeFileSync(path, text.replaceAll(from, home));
      }
    }
  };
  walk(home);
};

/** The first "SomethingError: why" line of a failed start; a stack frame changes with every path. */
export const firstError = (output: string) =>
  /\b([A-Z]\w*Error\b:?.*)$/m.exec(
    output
      .split("\n")
      .filter((line) => !/^\s*at /.test(line))
      .join("\n"),
  )?.[1] ??
  output.trim().split("\n").at(-1) ??
  "failed";

const buildKinMigrationHead = () =>
  Math.max(
    ...NodeFS.readdirSync(NodePath.join(ROOT, "apps/server/src/kin/persistence/migrations"))
      .map((file) => /^K(\d+)_/.exec(file)?.[1])
      .filter((id) => id !== undefined)
      .map(Number),
  );

const migrate = async (ctx: Context): Promise<Finding[] | string> => {
  if (ctx.previousRelease === undefined)
    return "skipped: no previous release in ops/kin/releases.json";
  const fixture = fixtureOf(ctx.previousRelease);
  if (!NodeFS.existsSync(NodePath.join(fixture, "userdata", "statev2.sqlite")))
    return `skipped: no fixture for ${short(ctx.previousRelease)} at ${fixture} (a --full run on that commit keeps one)`;
  const instance = "release-migrate";
  const home = instanceHome(instance);
  try {
    await kv(ctx, "migrate", instance, "down", "--wipe");
    NodeFS.cpSync(fixture, home, { recursive: true });
    relocate(home, NodeFS.readFileSync(NodePath.join(fixture, "home"), "utf8").trim());
    NodeFS.rmSync(NodePath.join(home, "verify", "instance.json"), { force: true });
    // People sign in again through the new build rather than trusting cookies an older one set.
    const chrome = NodePath.join(home, "verify", "chrome");
    for (const person of NodeFS.existsSync(chrome) ? NodeFS.readdirSync(chrome) : [])
      NodeFS.rmSync(NodePath.join(chrome, person, "kin-verify-signed-in"), { force: true });
    const started = await kv(ctx, "migrate", instance, "up");
    if (started.code !== 0)
      return [
        finding(
          "migrate",
          "up",
          "start on previous release's database",
          "-",
          firstError(started.output),
        ),
      ];
    const found: Finding[] = [];
    const doctor = await kv(ctx, "migrate", instance, "doctor");
    // The fixture was started on another commit; doctor says so, and that is the point.
    for (const [, problem] of doctor.output.matchAll(/^- (.*)$/gm))
      if (!/^started on /.test(problem!))
        found.push(finding("migrate", "doctor", "doctor", "-", problem!));
    const head = await kv(
      ctx,
      "migrate",
      instance,
      "db",
      "select max(migration_id) from kin_sql_migrations",
    );
    const recorded = Number(head.output.trim().split("\n").at(-1));
    if (recorded !== buildKinMigrationHead())
      found.push(
        finding(
          "migrate",
          "migrations",
          "kin head",
          "-",
          `database at K${recorded}, build expects K${buildKinMigrationHead()}`,
        ),
      );
    for (const script of MIGRATE_SCRIPTS) {
      const { code, output } = await run(
        ctx.log("migrate"),
        "bash",
        [NodePath.join(LIFECYCLE, `${script}.sh`)],
        {
          env: { ...env, KIN_VERIFY_INSTANCE: instance },
        },
      );
      const scriptFindings = lifecycleFindings("migrate", output, "lifecycle");
      if (code !== 0 && scriptFindings.length === 0)
        scriptFindings.push(finding("migrate", "lifecycle", script, "-", "exited non-zero"));
      found.push(...scriptFindings);
    }
    return found;
  } finally {
    await kv(ctx, "migrate", instance, "down", "--wipe");
  }
};

const uiFuzz = async (ctx: Context): Promise<Finding[] | string> => {
  const bombadil = process.env.BOMBADIL ?? "bombadil";
  const which = NodeChildProcess.spawnSync("sh", ["-c", `command -v "$0"`, bombadil], { env });
  if (which.status !== 0)
    return [
      finding("ui-fuzz", "runner", "bombadil", "-", `bombadil not found: set BOMBADIL to its path`),
    ];
  const out = NodePath.join(ctx.out, "ui-fuzz");
  NodeFS.rmSync(out, { recursive: true, force: true });
  const { code, output } = await run(ctx.log("ui-fuzz"), process.execPath, [
    NodePath.join(ROOT, "verification", "kin", "ui", "run.ts"),
    "--out",
    out,
    "--roles",
    FUZZ_ROLES.join(","),
    "--time",
    ctx.fuzzTime,
  ]);
  const found: Finding[] = [];
  // run.ts throws when any agent turn produced a token: the guard that keeps the fuzz free.
  const tokens = /(\w+): (\d+) agent turns reached a model/.exec(output);
  if (tokens) {
    ctx.report.modelTurns += Number(tokens[2]);
    found.push(
      finding("ui-fuzz", "guard", "model tokens", tokens[1]!, "agent turns reached a model"),
    );
  }
  const runJson = readJson<{ summary: Record<string, { exit: number; modelTurns: number }> }>(
    NodePath.join(out, "run.json"),
  );
  const summary = readJson<Record<string, { violations: Record<string, { count: number }> }>>(
    NodePath.join(out, "summary.json"),
  );
  for (const [role, one] of Object.entries(runJson?.summary ?? {})) {
    ctx.report.modelTurns += one.modelTurns;
    if (one.exit === 1) found.push(finding("ui-fuzz", "bombadil", "run", role, "bombadil error"));
  }
  for (const [role, one] of Object.entries(summary ?? {}))
    for (const property of Object.keys(one.violations))
      found.push(finding("ui-fuzz", "property", property, role, "violated"));
  if (code !== 0 && found.length === 0)
    found.push(
      finding("ui-fuzz", "runner", "run", "-", output.trim().split("\n").at(-1) ?? `exit ${code}`),
    );
  // The taps before each violation survive the trace, which is deleted to save disk.
  for (const role of FUZZ_ROLES) {
    const dir = NodePath.join(out, role);
    if (!NodeFS.existsSync(NodePath.join(dir, "trace", "trace.jsonl"))) continue;
    const explained = await run(NodePath.join(dir, "explain.txt"), process.execPath, [
      NodePath.join(ROOT, "verification", "kin", "ui", "explain.ts"),
      dir,
    ]);
    if (explained.code !== 0)
      NodeFS.appendFileSync(
        NodePath.join(dir, "explain.txt"),
        `explain exited ${explained.code}\n`,
      );
    if (!ctx.keepTraces)
      NodeFS.rmSync(NodePath.join(dir, "trace"), { recursive: true, force: true });
  }
  return found;
};

/** Each screen the look book could not capture, or that differs from the accepted set. */
export const lookbookFindings = (captured: string, compared: string) => [
  ...[...captured.matchAll(/^could not capture (\S+) \((\w+)\): (.*)$/gm)].map(
    ([, screen, size, error]) => finding("lookbook", "capture", `${screen} (${size})`, "-", error!),
  ),
  ...[...compared.matchAll(/^(changed|new|missing)\t(.+)$/gm)].map(([, verdict, screen]) =>
    finding("lookbook", verdict!, screen!, "-", "differs from the set the owner accepted"),
  ),
];

/** The look book against the owner's accepted set; his yes (`kin-lookbook accept`) clears it. */
const lookbook = async (ctx: Context): Promise<Finding[] | string> => {
  const accepted =
    process.env.KIN_LOOKBOOK_ACCEPTED ??
    NodePath.join(NodeOS.homedir(), ".kin-lookbook", "accepted");
  if (!NodeFS.existsSync(NodePath.join(accepted, "manifest.json")))
    return `no accepted look book at ${accepted}`;
  const shots = NodePath.join(ctx.out, "lookbook");
  NodeFS.rmSync(shots, { recursive: true, force: true });
  const captured = await run(ctx.log("lookbook"), process.execPath, [
    LOOKBOOK,
    "capture",
    "--out",
    NodePath.join(shots, "new"),
  ]);
  // Exit 2: some screens failed and are named; anything else non-zero captured nothing.
  if (captured.code !== 0 && captured.code !== 2)
    return [finding("lookbook", "capture", "run", "-", firstError(captured.output))];
  const compared = await run(ctx.log("lookbook"), process.execPath, [
    LOOKBOOK,
    "compare",
    "--accepted",
    accepted,
    "--new",
    NodePath.join(shots, "new"),
    "--out",
    NodePath.join(shots, "compare"),
  ]);
  const found = lookbookFindings(captured.output, compared.output);
  if (compared.code > 1 && found.length === 0)
    found.push(finding("lookbook", "compare", "run", "-", firstError(compared.output)));
  return found;
};

const RUNNERS: Record<Stage, (ctx: Context) => Promise<Finding[] | string>> = {
  static: staticChecks,
  models,
  properties,
  lifecycle,
  migrate,
  "ui-fuzz": uiFuzz,
  lookbook,
};

const resolveAgainst = (
  against: string | undefined,
  sha: string,
  previousRelease: string | undefined,
) => {
  if (against !== undefined && NodeFS.existsSync(against)) {
    const file = readJson<Findings>(against);
    if (!file) throw new Error(`--against ${against}: not a findings file`);
    return { label: `${against} (${short(file.commit)})`, findings: file.findings };
  }
  const target =
    against === undefined ? previousRelease : git("rev-parse", "--verify", `${against}^{commit}`);
  if (target === undefined || target === sha)
    return { label: "nothing (no previous release): every finding is NEW", findings: [] };
  const file = findingsFor(target);
  if (file)
    return { label: `${short(target)} (${file})`, findings: readJson<Findings>(file)!.findings };
  const release = readRecord().find((one) => one.commit === target);
  if (release) return { label: `${short(target)} (release record)`, findings: release.findings };
  throw new Error(
    `--against ${against}: no findings for ${short(target)} in ${checkDir()} or ops/kin/releases.json`,
  );
};

const check = async (args: Record<string, string | boolean | undefined>) => {
  const mode = args.full ? "full" : "quick";
  const sha = git("rev-parse", "HEAD");
  if (git("status", "--porcelain", "--untracked-files=no") !== "")
    console.warn(
      "kin-release-check: the checkout has uncommitted changes; findings are recorded against HEAD.",
    );
  const releases = readRecord().filter((one) => one.commit !== sha);
  const previousRelease = releases.at(-1)?.commit;
  const base = (args.base as string | undefined) ?? previousRelease ?? "HEAD~1";
  const out = NodePath.resolve(
    (args.out as string | undefined) ?? NodePath.join(checkDir(), short(sha), mode),
  );
  refuseLive(out);
  refuseLive(checkDir());
  NodeFS.mkdirSync(out, { recursive: true });
  for (const file of NodeFS.readdirSync(out))
    if (file.endsWith(".log")) NodeFS.rmSync(NodePath.join(out, file));
  const blocked = blockModels(out);
  const against = resolveAgainst(args.against as string | undefined, sha, previousRelease);
  const only = typeof args.only === "string" ? (args.only.split(",") as Stage[]) : undefined;
  const report: Findings = {
    commit: sha,
    mode,
    base,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    stages: [],
    findings: [],
    blockedProviderCalls: 0,
    modelTurns: 0,
  };
  const ctx: Context = {
    out,
    log: (stage) => NodePath.join(out, `${stage}.log`),
    sha,
    base,
    previousRelease,
    fuzzTime: (args["fuzz-time"] as string | undefined) ?? "2m",
    keepTraces: Boolean(args["keep-traces"]),
    lifecycleWorkers: lifecycleWorkersOf(args["lifecycle-workers"] as string | undefined),
    report,
    modelsChecked: new Set(),
  };
  const previousFingerprints = new Set(against.findings.map((one) => one.fingerprint));
  let stopped: string | undefined;
  for (const stage of STAGES) {
    const result: StageResult = { stage, status: "not run", seconds: 0, note: "" };
    report.stages.push(result);
    if (mode === "quick" && FULL_ONLY.includes(stage)) {
      result.note = "full only";
      continue;
    }
    if (only !== undefined && !only.includes(stage)) {
      result.note = "not in --only";
      continue;
    }
    if (stopped !== undefined) {
      result.note = `stopped after ${stopped} failed (--keep-going runs everything)`;
      continue;
    }
    const started = Date.now();
    console.log(`[release-check] ${stage}…`);
    let outcome: Finding[] | string;
    try {
      outcome = await RUNNERS[stage](ctx);
    } catch (error) {
      outcome = [finding(stage, "runner", "crash", "-", (error as Error).message)];
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    if (typeof outcome === "string") {
      result.status = "skipped";
      result.note = outcome;
    } else {
      report.findings.push(...outcome);
      result.status = outcome.length === 0 ? "pass" : "fail";
      result.note = outcome.length === 0 ? "" : `${outcome.length} finding(s)`;
      const blocking = outcome.some((one) =>
        gates(one, !previousFingerprints.has(one.fingerprint)),
      );
      if (blocking && !NONDETERMINISTIC.includes(stage) && !args["keep-going"]) stopped = stage;
    }
    console.log(
      `[release-check] ${stage}: ${result.status} in ${result.seconds}s${result.note ? ` · ${result.note}` : ""}`,
    );
  }
  report.finishedAt = new Date().toISOString();
  report.blockedProviderCalls = blocked();
  const ran = report.stages
    .filter((one) => one.status === "pass" || one.status === "fail")
    .map((one) => one.stage);
  const diff = { ...compare(report.findings, against.findings, ran), against: against.label };
  const exit =
    report.findings.some((one) => gates(one, !previousFingerprints.has(one.fingerprint))) ||
    report.modelTurns > 0
      ? 1
      : 0;
  NodeFS.writeFileSync(NodePath.join(out, "findings.json"), `${JSON.stringify(report, null, 2)}\n`);
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), markdown(report, diff, exit));
  NodeFS.writeFileSync(NodePath.join(out, "report.html"), html(report, diff, exit));
  console.log(
    `\n[release-check] ${short(sha)} ${mode}: ${diff.new.length} NEW, ${diff.fixed.length} FIXED, ${diff.still.length} STILL PRESENT · exit ${exit}\n  ${out}/summary.md\n  ${out}/report.html`,
  );
  return exit;
};

const markReleased = (commit: string, from: string | undefined) => {
  const sha = git("rev-parse", "--verify", `${commit}^{commit}`);
  const file = from ?? findingsFor(sha);
  const findings = file === undefined ? undefined : readJson<Findings>(file);
  if (findings === undefined)
    throw new Error(
      `no findings for ${short(sha)}: run the release check on it first, or pass --from <findings.json>`,
    );
  if (findings.commit !== sha)
    throw new Error(`${file} is for ${short(findings.commit)}, not ${short(sha)}`);
  const record = readRecord().filter((one) => one.commit !== sha);
  record.push({
    commit: sha,
    date: new Date().toISOString().slice(0, 10),
    mode: findings.mode,
    findings: findings.findings.map(({ message: _message, ...rest }) => rest),
  });
  NodeFS.writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  const fixture = NodeFS.existsSync(NodePath.join(checkDir(), short(sha), "fixture"));
  console.log(
    `marked ${short(sha)} released (${findings.mode}, ${findings.findings.length} findings) in ops/kin/releases.json; commit it.` +
      (fixture
        ? ""
        : `\nNo fixture at ${checkDir()}/${short(sha)}/fixture: the next --full run can't check migrations from this release.`),
  );
};

/** Exits of kin-release-remote.sh (busy, can't fetch, install failed) and of ssh (no connection). */
const RUN_HERE_ON = new Set([75, 76, 77, 255]);
const BETWEEN =
  /@@kin-release-findings\n([\s\S]*?)\n@@kin-release-summary\n([\s\S]*?)\n@@kin-release-end/;

/** The remote run's output, teed to `log`, shown here up to its findings. */
export const streamRemote = (command: string, args: string[], logPath: string) =>
  new Promise<Ran>((resolve) => {
    const log = NodeFS.createWriteStream(logPath);
    let text = "";
    // Its own process group, as in `run`, so stopChildren's kill of -pid reaches it.
    const child = NodeChildProcess.spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid !== undefined) children.add(child.pid);
    const take = (chunk: Buffer) => {
      text += chunk.toString();
      log.write(chunk);
      if (!BETWEEN.test(text) && !text.includes("@@kin-release-findings"))
        process.stdout.write(chunk);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (exit) => {
      if (child.pid !== undefined) children.delete(child.pid);
      log.end(() => resolve({ code: exit ?? 255, output: text }));
    });
  });

/** A fixture tarball from the remote, in place of `fixture`. */
export const unpackFixture = (fixture: string, tarball: Buffer) => {
  NodeFS.rmSync(fixture, { recursive: true, force: true });
  // tar's -C changes into the folder; it doesn't make it.
  NodeFS.mkdirSync(NodePath.dirname(fixture), { recursive: true });
  return (
    NodeChildProcess.spawnSync("tar", ["-C", NodePath.dirname(fixture), "-xzf", "-"], {
      input: tarball,
    }).status === 0
  );
};

/** The check on KIN_RELEASE_REMOTE over ssh; undefined when it should run on this machine instead. */
const onRemote = async (
  args: Record<string, string | boolean | undefined>,
  argv: ReadonlyArray<string>,
): Promise<number | undefined> => {
  const host = process.env.KIN_RELEASE_REMOTE;
  if (host === undefined || host === "" || args.here) return undefined;
  const here = (why: string) => {
    console.log(`[release-check] ${host}: ${why}; running on this machine`);
    return undefined;
  };
  if (typeof args.against === "string" && NodeFS.existsSync(args.against))
    return here("--against names a file on this machine");
  if (git("status", "--porcelain", "--untracked-files=no") !== "")
    return here("this checkout has uncommitted changes");
  const passed = argv.filter(
    (arg, index) => arg !== "--here" && arg !== "--out" && argv[index - 1] !== "--out",
  );
  if (passed.some((arg) => !/^[\w.,:=/@+-]+$/.test(arg)))
    return here("an argument needs quoting over ssh");
  const reach = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, "exit 0"],
    { stdio: "ignore", timeout: 30_000 },
  );
  if (reach.status !== 0) return here("not reachable");
  const sha = git("rev-parse", "HEAD");
  const out = NodePath.resolve(
    (args.out as string | undefined) ??
      NodePath.join(checkDir(), short(sha), args.full ? "full" : "quick"),
  );
  refuseLive(out);
  NodeFS.mkdirSync(out, { recursive: true });
  const command =
    process.env.KIN_RELEASE_REMOTE_COMMAND ?? "bash t3code/scripts/kin-release-remote.sh";
  const ssh = (remote: string, input?: Buffer) =>
    NodeChildProcess.spawnSync("ssh", ["-o", "BatchMode=yes", host, remote], {
      input,
      maxBuffer: 2 ** 31,
      timeout: 600_000,
    });
  const previous = readRecord()
    .filter((one) => one.commit !== sha)
    .at(-1)?.commit;
  if (args.full && previous !== undefined && NodeFS.existsSync(fixtureOf(previous))) {
    const tarball = NodeChildProcess.spawnSync(
      "tar",
      ["--no-xattrs", "-C", NodePath.dirname(fixtureOf(previous)), "-czf", "-", "fixture"],
      // macOS tar otherwise adds ._ AppleDouble files, which a fixture copy trips over.
      { maxBuffer: 2 ** 31, env: { ...process.env, COPYFILE_DISABLE: "1" } },
    ).stdout;
    if (ssh(`${command} --fixture-in ${previous}`, tarball).status !== 0)
      console.log(
        `[release-check] ${host}: couldn't take ${short(previous)}'s fixture; its migrate may skip`,
      );
  }
  console.log(`[release-check] running on ${host}; this machine takes over if it can't`);
  const { code, output } = await streamRemote(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=30",
      host,
      [command, sha, ...passed].join(" "),
    ],
    NodePath.join(out, "remote.log"),
  );
  const found = BETWEEN.exec(output);
  if (RUN_HERE_ON.has(code) || found === null)
    return here(
      `its run ended without results (exit ${code}; see ${NodePath.join(out, "remote.log")})`,
    );
  NodeFS.writeFileSync(NodePath.join(out, "findings.json"), `${found[1]!}\n`);
  NodeFS.writeFileSync(NodePath.join(out, "summary.md"), `${found[2]!}\n`);
  console.log(`  ${NodePath.join(out, "summary.md")} (from ${host})`);
  if (args.full) {
    const fixture = ssh(`${command} --fixture-out ${sha}`);
    const unpacked = fixture.status === 0 && unpackFixture(fixtureOf(sha), fixture.stdout);
    if (!unpacked) console.log(`[release-check] ${host}: no fixture came back for ${short(sha)}`);
  }
  return code;
};

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      quick: { type: "boolean" },
      full: { type: "boolean" },
      against: { type: "string" },
      out: { type: "string" },
      base: { type: "string" },
      only: { type: "string" },
      "keep-going": { type: "boolean" },
      "keep-traces": { type: "boolean" },
      "fuzz-time": { type: "string" },
      "lifecycle-workers": { type: "string" },
      here: { type: "boolean" },
      "mark-released": { type: "string" },
      from: { type: "string" },
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      stopChildren();
      for (const instance of [
        ...lifecycleInstances(lifecycleWorkersOf(values["lifecycle-workers"])),
        "release-migrate",
        "lookbook",
      ])
        NodeChildProcess.spawnSync(
          process.execPath,
          [NodePath.join(ROOT, "scripts", "kin-verify.ts"), "--instance", instance, "down"],
          { stdio: "ignore" },
        );
      process.exit(130);
    });
  try {
    if (values["mark-released"]) markReleased(values["mark-released"], values.from);
    else
      process.exitCode = (await onRemote(values, process.argv.slice(2))) ?? (await check(values));
  } catch (error) {
    console.error(`kin-release-check: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
