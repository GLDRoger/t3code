#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - a dev CLI for agents.
/**
 * kin-verify: start an isolated Kin with an invented company, act as any seeded person, drive
 * the real web client, call agent tools through a real turn with no model. Read
 * `.agents/skills/verify-kin/SKILL.md` first. `node scripts/kin-verify.ts help` lists commands.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  agentOf,
  database,
  deviceInvite,
  describeResult,
  directChat,
  personIdOf,
  rpcAs,
  runTurn,
} from "./kin-verify/actors.ts";
import {
  gitHead,
  type Instance,
  instanceOf,
  isAlive,
  ORG,
  processTree,
  readJson,
  readSeed,
  readState,
  ROOT,
  sleep,
  startServer,
  stopTree,
  tailLog,
  writeJson,
  writeSeed,
  writeState,
} from "./kin-verify/instance.ts";
import {
  mailDeliver,
  mailApprove,
  mailExpire,
  fakeSocial,
  mailSentLines,
  pushSentLines,
  parseDuration,
  query,
  shiftKinTimes,
} from "./kin-verify/ops.ts";
import { RpcFailure, VerifyError } from "./kin-verify/rpc.ts";
import { SEEDS, type SeedName, seed, seedTurns } from "./kin-verify/seed.ts";
import * as Web from "./kin-verify/web.ts";
import { Probe } from "./kin-bench/web.ts";

const HELP = `kin-verify [--instance <name>] <command>
  up [--seed lifecycle|empty|bench|lookbook] [--fresh] start (or reuse) an isolated Kin, seeded; prints when ready
  doctor                                  is this instance ours, on this commit, healthy?
  down [--wipe]                           stop exactly what up started (--wipe deletes its state)
  people                                  seeded people and agents
  as <person> web open <route>            tasks | money | clients?client=C-1 | chat:<agent> | /path
  as <person> web snapshot [--full]       accessibility tree of the open sheet/dialog, else main
  as <person> web back                    the browser's Back
  as <person> web click --name "<name>" [--role r] [--nth n] [--within "<card or section name>"]
  as <person> web type [--name "<field>"] "<text>" [--enter]
  as <person> web attach <file> [<file>…]  files in the open chat's composer; then type --enter
                                          --via "<button name>" picks them through that button's
                                          file chooser instead, e.g. --via "choose one" on Import
  as <person> web wait "<text>" [--gone] [--timeout <s>]
  as <person> web screenshot <path> [--full] [--width <px>] [--height <px>] [--light|--dark]
  as <person> rpc <method> ['<json>']     a client RPC as that person (orgId is filled in)
  as <person> wire <method> ['<json>'] --watch a,b,c [--settle <s>] [--find "<text>"]
                                          the RPC as that person; prints what each watcher's open
                                          page received over its socket meanwhile, one JSON line each
                                          (found: frames in that carried the text)
  tool <agent> <tool> ['<json>'] [--as-turn-of <person>] [--say "<text>"] [--reply "<text>"] [--hold <s>] [--fail] [--raw]
                                          one real turn, no model: the agent calls the tool
  tool <agent> --script <file.json>       the same with several calls (and "shell"/"sleep" steps)
  mail sent | mail deliver --to a --from "N <b>" --subject s --body t [--thread id]
  mail expire <address> [--back]          the account's sign-in stops working (or works again)
  mail signin <address>                   the owner signs that fake account in again, as Settings'
                                          Sign in again does once the vendor approves (fake mailbox only)
  push sent                               what Kin would have pushed, per person's device (no APNs)
  social profile <name> <platform:handle>... [all-profiles] | social past <profileId> '<json>' | social fail-next <accountId> <reason> | social posts
  clock show                              this instance's now, in the company's zone and UTC
  clock set "<mon 09:01|tomorrow 09:30|2026-11-23 09:30>"   move now forward to then (company zone)
  clock advance <90m|12h|3d|2w>           move now forward; nothing restarts
  clock age <3d>                          move every stored Kin time back instead (restarts)
  db "<select …>"                         read-only SQL on this instance's database
  phone pair [--android] [--as <person>]  deep link that pairs the dev client to this instance
  phone metro [--full-app]                Metro for this checkout, as the Kin app (stopped by down)`;

interface Args {
  readonly positional: Array<string>;
  readonly flags: Map<string, string | true>;
}

function parse(argv: ReadonlyArray<string>): Args {
  const positional: Array<string> = [];
  const flags = new Map<string, string | true>();
  const booleans = new Set([
    "fresh",
    "wipe",
    "full",
    "enter",
    "gone",
    "raw",
    "android",
    "json",
    "dark",
    "light",
    "back",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.has(name)) flags.set(name, true);
    else {
      const value = argv[++index];
      if (value === undefined) throw new VerifyError(`--${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positional, flags };
}

const flag = (args: Args, name: string) => {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
};
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;

async function healthy(instance: Instance): Promise<string | undefined> {
  try {
    const rpc = await rpcAs(instance, "owner");
    try {
      const me = (await rpc.call("kin.access.me", { orgId: ORG }, { timeoutMs: 10_000 })) as {
        access: string;
      };
      if (me.access !== "owner") return `owner session resolves to ${me.access}`;
    } finally {
      rpc.close();
    }
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function up(instance: Instance, args: Args) {
  const started = Date.now();
  const name = (flag(args, "seed") ?? "lifecycle") as SeedName;
  if (!SEEDS.includes(name)) throw new VerifyError(`--seed ${name}: one of ${SEEDS.join(", ")}`);
  if (args.flags.has("fresh")) await down(instance, true, true);
  const existing = readSeed(instance);
  if (existing !== undefined && existing.name !== name)
    throw new VerifyError(
      `this instance holds the "${existing.name}" seed; run \`up --fresh --seed ${name}\` or use --instance <other>`,
    );
  let state = readState(instance);
  const running = state !== undefined && isAlive(state.pid) && state.origin !== undefined;
  if (running && existing !== undefined && (await healthy(instance)) === undefined) {
    console.log(`up: already running · ${summary(instance)} · checked in ${seconds(started)}`);
    return;
  }
  if (!running) state = await startServer(instance);
  let seeded = existing;
  if (seeded === undefined) {
    const environmentId = NodeFS.readFileSync(
      NodePath.join(instance.userdata, "environment-id"),
      "utf8",
    ).trim();
    seeded = await seed(instance, name, environmentId);
    writeSeed(instance, seeded);
    if (Object.keys(seeded.agents).length > 0) {
      // The lead runner finds a company's first agents on its next minute's scan; a restart is sooner.
      await stopTree(state!.pid);
      state = await startServer(instance);
      await seedTurns(instance, name);
    }
  }
  const problem = await healthy(instance);
  if (problem !== undefined)
    throw new VerifyError(`started but not usable: ${problem}\n${tailLog(instance)}`);
  console.log(`up: ready in ${seconds(started)} · ${summary(instance)}`);
}

function summary(instance: Instance) {
  const state = readState(instance);
  const seeded = readSeed(instance);
  return [
    `web ${state?.web}`,
    `server ${state?.origin}`,
    `seed ${seeded?.name ?? "none"}`,
    `people ${Object.keys(seeded?.people ?? {}).join(",")}`,
    `agents ${Object.keys(seeded?.agents ?? {}).join(",") || "none"}`,
  ].join(" · ");
}

async function down(instance: Instance, wipe: boolean, quiet = false) {
  const state = readState(instance);
  let stopped = 0;
  if (state !== undefined) {
    for (const pid of [...Object.values(state.chrome ?? {}), state.metro, state.pid])
      stopped += await stopTree(pid);
    writeState(instance, { ...state, chrome: {}, metro: undefined });
  }
  if (wipe) NodeFS.rmSync(instance.home, { recursive: true, force: true });
  if (!quiet) console.log(`down: stopped ${stopped} processes${wipe ? ", wiped state" : ""}`);
}

function listening(port: number | undefined): Array<number> {
  if (port === undefined) return [];
  return NodeChildProcess.spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean)
    .map(Number);
}

async function doctor(instance: Instance) {
  const state = readState(instance);
  const problems: Array<string> = [];
  if (state === undefined || !isAlive(state.pid)) {
    console.log("doctor: not running · next: kin-verify up");
    process.exitCode = 1;
    return;
  }
  const tree = new Set(processTree(state.pid));
  for (const [what, port] of [
    ["server", state.serverPort],
    ["web", state.webPort],
  ] as const) {
    const owners = listening(port);
    if (owners.length === 0) problems.push(`${what} port ${port} is not listening`);
    else if (!owners.some((pid) => tree.has(pid)))
      problems.push(`${what} port ${port} belongs to pid ${owners.join(",")}, not this instance`);
  }
  const head = gitHead();
  if (head !== state.commit)
    problems.push(
      `started on ${state.commit.slice(0, 10)}, checkout is now ${head.slice(0, 10)}: kin-verify down && up`,
    );
  if (readSeed(instance) === undefined) problems.push("not seeded: kin-verify up");
  const health = await healthy(instance);
  if (health !== undefined) problems.push(`owner RPC: ${health}`);
  const db = database(instance);
  const stuck = db
    .prepare("SELECT COUNT(*) AS n FROM kin_wakeups WHERE status = 'running' AND started_at < ?")
    .get(Date.now() - 5 * 60_000) as { n: number };
  db.close();
  if (stuck.n > 0) problems.push(`${stuck.n} wake-ups running over 5 minutes`);
  console.log(
    problems.length === 0
      ? `doctor: ok · ours (pid ${state.pid}) · commit ${state.commit.slice(0, 10)} · ${summary(instance)}`
      : `doctor: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`,
  );
  if (problems.length > 0) process.exitCode = 1;
}

async function chatRoute(instance: Instance, person: string, route: string) {
  if (!route.startsWith("chat:")) return route;
  const agent = agentOf(instance, route.slice(5));
  const rpc = await rpcAs(instance, person);
  try {
    return await directChat(rpc, agent.agentId);
  } finally {
    rpc.close();
  }
}

async function web(instance: Instance, person: string, args: Args) {
  const [action, ...rest] = args.positional;
  const session = await Web.openWeb(instance, person, {
    pairingUrl: () => pairingUrlFor(instance, readState(instance)!.web!),
    inviteSecret: () => deviceInvite(instance, person),
  });
  switch (action) {
    case "open": {
      const route = rest[0];
      if (route === undefined)
        throw new VerifyError("open needs a route, such as tasks or chat:chief");
      await Web.open(session, await chatRoute(instance, person, route));
      console.log(await Web.snapshot(session, false).then((text) => text.split("\n")[0]));
      return;
    }
    case "snapshot":
      console.log(await Web.snapshot(session, args.flags.has("full")));
      return;
    case "back":
      await Web.back(session);
      console.log(await Web.snapshot(session, false).then((text) => text.split("\n")[0]));
      return;
    case "click": {
      const name = flag(args, "name") ?? rest[0];
      if (name === undefined) throw new VerifyError('click needs --name "<accessible name>"');
      const nth = flag(args, "nth");
      const role = await Web.click(session, name, {
        ...(flag(args, "role") === undefined ? {} : { role: flag(args, "role")! }),
        ...(nth === undefined ? {} : { nth: Number(nth) }),
        ...(flag(args, "within") === undefined ? {} : { within: flag(args, "within")! }),
      });
      console.log(`clicked ${role} "${name}"`);
      return;
    }
    case "type": {
      const text = rest[0];
      if (text === undefined) throw new VerifyError('type needs the text: type "hello" [--enter]');
      await Web.type(session, text, {
        ...(flag(args, "name") === undefined ? {} : { name: flag(args, "name")! }),
        enter: args.flags.has("enter"),
      });
      console.log(`typed ${text.length} chars${args.flags.has("enter") ? " + Enter" : ""}`);
      return;
    }
    case "attach": {
      if (rest.length === 0) throw new VerifyError("attach needs one or more file paths");
      await Web.attach(session, rest, flag(args, "via"));
      console.log(`attached ${rest.length} file(s)`);
      return;
    }
    case "wait": {
      const text = rest[0];
      if (text === undefined) throw new VerifyError('wait needs the text: wait "Sent"');
      await Web.waitFor(session, text, {
        gone: args.flags.has("gone"),
        timeoutMs: Number(flag(args, "timeout") ?? "20") * 1000,
      });
      console.log(`${args.flags.has("gone") ? "gone" : "shown"}: "${text}"`);
      return;
    }
    case "screenshot": {
      const path = rest[0];
      if (path === undefined) throw new VerifyError("screenshot needs an explicit path");
      const width = flag(args, "width");
      const height = flag(args, "height");
      const colorScheme = args.flags.has("dark")
        ? "dark"
        : args.flags.has("light")
          ? "light"
          : null;
      if (width !== undefined || height !== undefined || colorScheme !== null)
        await Web.view(session, {
          width: width === undefined ? undefined : Number(width),
          height: height === undefined ? undefined : Number(height),
          colorScheme,
        });
      console.log(`saved ${await Web.screenshot(session, path, args.flags.has("full"))}`);
      return;
    }
    case "view": {
      const width = flag(args, "width");
      const height = flag(args, "height");
      const scheme = args.flags.has("dark") ? "dark" : args.flags.has("light") ? "light" : null;
      const zone = flag(args, "zone");
      const size = await Web.view(session, {
        width: width === undefined ? undefined : Number(width),
        height: height === undefined ? undefined : Number(height),
        colorScheme: scheme,
        ...(zone === undefined ? {} : { zone }),
      });
      console.log(
        `view ${size.width}×${size.height}${scheme === null ? "" : ` ${scheme}`}${zone === undefined ? "" : ` ${zone}`}`,
      );
      return;
    }
    default:
      throw new VerifyError(
        `web ${action ?? ""}: one of open, snapshot, click, type, wait, screenshot, view`,
      );
  }
}

function pairingUrlFor(instance: Instance, web: string) {
  const out = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "src/bin.ts",
      "pair",
      "--base-dir",
      instance.home,
      "--label",
      "kin-verify web",
      "--ttl",
      "10m",
    ],
    { cwd: NodePath.join(ROOT, "apps", "server"), encoding: "utf8" },
  );
  const token = /^Token: (\S+)/m.exec(out.stdout)?.[1];
  if (token === undefined) throw new VerifyError("t3 pair failed; run `kin-verify doctor`");
  return `${web}/pair#token=${token}`;
}

/** Sign in again through the owner's own sign-in, with the fake vendor approving in the browser's place. */
async function mailSignIn(instance: Instance, address: string | undefined) {
  if (address === undefined) throw new VerifyError("mail signin needs the account's address");
  const connection = await rpcAs(instance, "owner");
  try {
    type View = {
      connections: Array<{ connectionId: string; accountLabel: string | null; state: string }>;
    };
    const find = async () =>
      ((await connection.call("kin.connections.list", { orgId: ORG })) as View).connections.find(
        (one) => one.accountLabel?.toLowerCase() === address.toLowerCase(),
      );
    const account = await find();
    if (account === undefined) throw new VerifyError(`no connection for ${address}`);
    const started = (await connection.call("kin.connections.signInStart", {
      orgId: ORG,
      connectionId: account.connectionId,
      returnTo: "web",
    })) as { authorizationUrl: string };
    const response = mailApprove(instance, started.authorizationUrl, address);
    await connection.call("kin.connections.signInFinish", { orgId: ORG, response });
    return `${address}: signed in again (was ${account.state}, now ${(await find())?.state})`;
  } finally {
    connection.close();
  }
}

async function rpc(instance: Instance, person: string, args: Args) {
  const [method, json] = args.positional;
  if (method === undefined) throw new VerifyError("rpc needs a method, such as kin.work.list");
  const payload = { orgId: ORG, ...(json === undefined ? {} : (JSON.parse(json) as object)) };
  const connection = await rpcAs(instance, person);
  try {
    const result = await connection.call(method, payload);
    console.log(JSON.stringify(Array.isArray(result) && result.length === 1 ? result[0] : result));
  } finally {
    connection.close();
  }
}

/**
 * One change as `person`, and what reached each watcher's open page while it settled: frames,
 * bytes (as sent, and about what deflate made of them), and every request their page sent.
 */
async function wire(instance: Instance, person: string, args: Args) {
  const [method, json] = args.positional;
  const watch = flag(args, "watch")
    ?.split(",")
    .filter((one) => one !== "");
  if (method === undefined || watch === undefined || watch.length === 0)
    throw new VerifyError("wire needs <method> ['<json>'] --watch <person>,<person>");
  const settle = Number(flag(args, "settle") ?? "5") * 1000;
  const find = flag(args, "find");
  const probes = [];
  for (const one of watch) {
    if (one !== "owner") personIdOf(instance, one);
    const session = await Web.openWeb(instance, one, {
      pairingUrl: () => pairingUrlFor(instance, readState(instance)!.web!),
      inviteSecret: () => deviceInvite(instance, one),
    });
    const probe = await Probe.attach(session.page);
    const watched = { person: one, probe, from: probe.mark(), found: 0 };
    if (find !== undefined)
      probe.cdp.on("Network.webSocketFrameReceived", (event) => {
        if (event.response.payloadData.includes(find)) watched.found += 1;
      });
    probes.push(watched);
  }
  const payload = { orgId: ORG, ...(json === undefined ? {} : (JSON.parse(json) as object)) };
  const connection = await rpcAs(instance, person);
  try {
    const result = await connection.call(method, payload);
    console.log(
      JSON.stringify({ result: Array.isArray(result) && result.length === 1 ? result[0] : result }),
    );
  } finally {
    connection.close();
  }
  await sleep(settle);
  for (const { person: one, probe, from, found } of probes) {
    const row = probe.wire(method, from);
    const frames = probe.frames.slice(from);
    console.log(
      JSON.stringify({
        person: one,
        framesIn: row.framesIn,
        bytesIn: row.bytesIn,
        deflatedIn: row.deflatedIn,
        requests: frames.filter((frame) => frame.request).length,
        methods: row.methods,
        ...(find === undefined ? {} : { found }),
      }),
    );
  }
}

async function tool(instance: Instance, args: Args) {
  const [agent, name, json] = args.positional;
  const script = flag(args, "script");
  if (agent === undefined || (name === undefined && script === undefined))
    throw new VerifyError(
      "tool needs <agent> <tool-name> ['<json>'] or <agent> --script <file>, such as tool chief people_read",
    );
  // A script file holds several calls, as `{"calls": [{"name", "arguments"}], "reply"}`.
  const scripted =
    script === undefined
      ? undefined
      : (JSON.parse(NodeFS.readFileSync(script, "utf8")) as {
          calls: Array<{ name: string; arguments?: unknown }>;
          reply?: string;
        });
  const reply = flag(args, "reply") ?? scripted?.reply;
  const results = await runTurn(instance, {
    agent,
    person: flag(args, "as-turn-of") ?? "owner",
    calls: scripted?.calls.map((call) => ({
      name: call.name,
      arguments: call.arguments ?? {},
    })) ?? [{ name: name!, arguments: json === undefined ? {} : JSON.parse(json) }],
    ...(reply === undefined ? {} : { reply }),
    ...(flag(args, "say") === undefined ? {} : { say: flag(args, "say")! }),
    ...(flag(args, "hold") === undefined ? {} : { holdSeconds: Number(flag(args, "hold")) }),
    ...(args.flags.has("fail") ? { fail: true } : {}),
  });
  for (const result of results)
    console.log(args.flags.has("raw") ? JSON.stringify(result) : describeResult(result));
}

const MINUTE = 60_000;
// The server's `DevClock.DEV_CLOCK_FILE`, in its state directory.
const devClockFile = (instance: Instance) => NodePath.join(instance.userdata, "kin-dev-clock.json");
const readOffset = (instance: Instance) =>
  readJson<{ offsetMs: number }>(devClockFile(instance))?.offsetMs ?? 0;

function companyZone(instance: Instance) {
  const db = database(instance);
  try {
    const row = db
      .prepare("SELECT time_zone AS zone FROM kin_trigger_settings WHERE org_id = ?")
      .get(ORG) as { zone: string | null } | undefined;
    return row?.zone ?? "UTC";
  } finally {
    db.close();
  }
}

/** Wall-clock parts of `ms` in `zone`. */
function partsIn(ms: number, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(ms);
  const part = (type: string) => parts.find((one) => one.type === type)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
    weekday: part("weekday").toLowerCase().slice(0, 3),
  };
}

/** The instant `date` `time` reads on a wall clock in `zone`. */
function instantIn(date: string, time: string, zone: string) {
  const wall = Date.parse(`${date}T${time}:00Z`);
  let at = wall;
  for (let pass = 0; pass < 2; pass++) {
    const seen = partsIn(at, zone);
    at += wall - Date.parse(`${seen.date}T${seen.time}:00Z`);
  }
  return at;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "2026-11-23 09:30", "tomorrow 09:30", "mon 09:01" or "09:31" (the next one), in `zone`. */
function parseWhen(text: string, now: number, zone: string) {
  const match = /^(?:(\S+)\s+)?(\d{1,2}):(\d{2})$/.exec(text.trim().toLowerCase());
  const day = match?.[1];
  const weekday =
    day === undefined || day === "today" || day === "tomorrow" || /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? undefined
      : WEEKDAYS.indexOf(day.slice(0, 3));
  if (match === null || weekday === -1)
    throw new VerifyError(
      `clock set "${text}": use "2026-11-23 09:30", "tomorrow 09:30", "mon 09:01" or "09:31"`,
    );
  const time = `${match[2]!.padStart(2, "0")}:${match[3]}`;
  if (day !== undefined && /^\d/.test(day)) return instantIn(day, time, zone);
  const today = Date.parse(`${partsIn(now, zone).date}T12:00:00Z`);
  for (let ahead = day === "tomorrow" ? 1 : 0; ahead < 15; ahead++) {
    const noon = new Date(today + ahead * 86_400_000);
    if (weekday !== undefined && noon.getUTCDay() !== weekday) continue;
    const at = instantIn(noon.toISOString().slice(0, 10), time, zone);
    // The moved clock runs on: the minute it is in now still counts as next.
    if (day === "today" || day === "tomorrow" || at >= Math.floor(now / MINUTE) * MINUTE) return at;
  }
  throw new VerifyError(`clock set "${text}": no such time in the next two weeks`);
}

function showClock(instance: Instance) {
  const zone = companyZone(instance);
  const offsetMs = readOffset(instance);
  const now = Date.now() + offsetMs;
  const { date, time, weekday } = partsIn(now, zone);
  return `clock: ${weekday} ${date} ${time} ${zone} · ${new Date(now).toISOString().slice(0, 16)}Z UTC · moved +${Math.round(offsetMs / MINUTE)}m`;
}

/**
 * `set`, `advance` and `show` move the dev server's now forward (Kin's clock, and the Kin
 * screens of browsers kv drives); `age` moves stored times back and restarts, as before.
 */
async function clock(instance: Instance, args: Args) {
  const [action, value] = args.positional;
  if (action === "show") return console.log(showClock(instance));
  if (action === "set" || action === "set-date" || action === "advance") {
    if (value === undefined) throw new VerifyError(`clock ${action} needs a value`);
    const offsetMs = readOffset(instance);
    const now = Date.now() + offsetMs;
    const realMinute = Math.floor(Date.now() / MINUTE) * MINUTE;
    const next =
      action === "advance"
        ? offsetMs + parseDuration(value)
        : parseWhen(action === "set-date" ? `${value} 00:00` : value, now, companyZone(instance)) -
          realMinute;
    // Whole minutes, so the moved clock turns its minutes when the real one does.
    const rounded = Math.floor(next / MINUTE) * MINUTE;
    if (Math.floor((rounded + Date.now()) / MINUTE) < Math.floor(now / MINUTE))
      throw new VerifyError("the clock only moves forward; `kv down --wipe` starts over");
    // Already in that minute: nothing to move.
    if (rounded <= offsetMs) return console.log(showClock(instance));
    writeJson(devClockFile(instance), { offsetMs: rounded });
    // The server reads the file each second; a moved slot runs on its next tick.
    await sleep(1_500);
    console.log(`${showClock(instance)} · browsers follow on their next web command`);
    return;
  }
  let ms: number;
  if (action === "age" && value !== undefined) ms = parseDuration(value);
  else
    throw new VerifyError(
      'clock show | clock set "<mon 09:01|tomorrow 09:30|2026-11-23 09:30>" | clock advance <90m|12h|3d|2w> | clock age <3d>',
    );
  const state = readState(instance);
  const wasRunning = state !== undefined && isAlive(state.pid);
  if (wasRunning) await stopTree(state.pid);
  let shifted: ReturnType<typeof shiftKinTimes>;
  try {
    shifted = shiftKinTimes(instance, ms);
    fakeSocial(instance, ["shift", String(ms)]);
  } finally {
    // A refused shift rolls back; the server comes back either way.
    if (wasRunning) await startServer(instance);
  }
  const { columns, rows } = shifted;
  console.log(
    `clock: Kin's stored times moved ${Math.round(ms / 3_600_000)}h into the past (${rows} values in ${columns} columns)${wasRunning ? "; server restarted" : ""}`,
  );
}

async function phone(instance: Instance, args: Args) {
  const [action] = args.positional;
  const state = readState(instance);
  if (state?.serverPort === undefined)
    throw new VerifyError("no running instance; run `kin-verify up`");
  if (action === "pair") {
    const person = flag(args, "as") ?? "owner";
    const origin = `http://${args.flags.has("android") ? "10.0.2.2" : "127.0.0.1"}:${state.serverPort}`;
    let link: string;
    if (person === "owner") {
      const out = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "src/bin.ts",
          "auth",
          "pairing",
          "create",
          "--base-dir",
          instance.home,
          "--base-url",
          origin,
          "--ttl",
          "15m",
          "--label",
          "kin-verify phone",
        ],
        { cwd: NodePath.join(ROOT, "apps", "server"), encoding: "utf8" },
      );
      const url = /^Pair URL: (\S+)/m.exec(out.stdout)?.[1];
      if (url === undefined) throw new VerifyError("could not mint a phone pairing credential");
      link = `t3code-dev://connections/new?${new URLSearchParams({ pairingUrl: url, autoConnect: "1" })}`;
    } else {
      const secret = await deviceInvite(instance, person);
      link = `t3code-dev://kin/join?${new URLSearchParams({ link: `${origin}/kin/invite#${secret}` })}`;
    }
    console.log(link);
    console.log(
      "next: with the device tools (device_open), run its command: open com.t3tools.t3code.dev '<link above>'. One use, 15 minutes.",
    );
    return;
  }
  if (action === "metro") {
    if (isAlive(state.metro)) {
      console.log(
        `metro: already running (pid ${state.metro}); log ${NodePath.join(instance.meta, "metro.log")}`,
      );
      return;
    }
    const logFile = NodePath.join(instance.meta, "metro.log");
    const log = NodeFS.openSync(logFile, "a");
    const child = NodeChildProcess.spawn("vp", ["run", "dev:client"], {
      cwd: NodePath.join(ROOT, "apps", "mobile"),
      // The owner's phone runs the Kin-only build; --full-app shows Kin inside the T3 Code shell.
      env: args.flags.has("full-app") ? process.env : { ...process.env, EXPO_PUBLIC_KIN_ONLY: "1" },
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    writeState(instance, { ...state, metro: child.pid! });
    for (let waited = 0; waited < 90_000; waited += 500) {
      const text = NodeFS.readFileSync(logFile, "utf8");
      const url =
        /(exp\+[\w-]+:\/\/expo-development-client\/\?url=\S+|t3code-dev:\/\/expo-development-client\/\?url=\S+)/.exec(
          text,
        )?.[1];
      if (url !== undefined || /Waiting on http:\/\/\S+/.test(text)) {
        console.log(
          `metro: running (pid ${child.pid}) · ${url ?? /Waiting on (http:\/\/\S+)/.exec(text)?.[1]}`,
        );
        console.log(
          "next: vp run mobile:install ios (once per native change), then open the URL above with the device tools, then `phone pair`",
        );
        return;
      }
      if (!isAlive(child.pid)) break;
      await sleep(500);
    }
    throw new VerifyError(`Metro did not start; see ${logFile}`);
  }
  throw new VerifyError("phone pair [--android] [--as <person>] | phone metro [--full-app]");
}

async function main() {
  // node:sqlite is still flagged experimental; its one-line warning is noise in terse output.
  process.removeAllListeners("warning");
  const argv = process.argv.slice(2);
  let instanceName = process.env.KIN_VERIFY_INSTANCE ?? "default";
  if (argv[0] === "--instance") {
    instanceName = argv[1] ?? "";
    argv.splice(0, 2);
  }
  const instance = instanceOf(instanceName);
  let person = "owner";
  if (argv[0] === "as") {
    person = argv[1] ?? "";
    argv.splice(0, 2);
    if (person !== "owner") personIdOf(instance, person);
  }
  const [command, ...rest] = argv;
  const args = parse(rest);
  switch (command) {
    case "up":
      return up(instance, args);
    case "down":
      return down(instance, args.flags.has("wipe"));
    case "doctor":
      return doctor(instance);
    case "people": {
      const seeded = readSeed(instance);
      if (seeded === undefined) throw new VerifyError("not seeded; run `kin-verify up`");
      for (const [key, one] of Object.entries(seeded.people))
        console.log(`${key}\t${one.displayName}\t${one.personId}`);
      for (const [key, one] of Object.entries(seeded.agents))
        console.log(`${key}\t${one.name}\t${one.agentId}\tagent`);
      return;
    }
    case "web":
      return web(instance, person, args);
    case "rpc":
      return rpc(instance, person, args);
    case "wire":
      return wire(instance, person, args);
    case "tool":
      return tool(instance, args);
    case "mail": {
      const [action] = args.positional;
      if (action === "sent") return console.log(mailSentLines(instance));
      if (action === "deliver")
        return console.log(
          mailDeliver(
            instance,
            rest.slice(1).filter((arg) => arg !== "deliver"),
          ),
        );
      if (action === "expire") return console.log(mailExpire(instance, rest.slice(1)));
      if (action === "signin") return console.log(await mailSignIn(instance, args.positional[1]));
      throw new VerifyError(
        "mail sent | mail deliver --to --from --subject --body [--thread] | mail expire <address> [--back] | mail signin <address>",
      );
    }
    case "social":
      // The fake Zernio: profile, past, fail-next, posts, accounts (see kin-fake-social.ts).
      return console.log(fakeSocial(instance, rest));
    case "push": {
      if (args.positional[0] === "sent") return console.log(pushSentLines(instance));
      throw new VerifyError("push sent");
    }
    case "clock":
      return clock(instance, args);
    case "db": {
      const sql = args.positional[0];
      if (sql === undefined)
        throw new VerifyError('db needs SQL: db "select key, title from kin_records limit 5"');
      return console.log(query(instance, sql));
    }
    case "phone":
      return phone(instance, args);
    case undefined:
    case "help":
      return console.log(HELP);
    default:
      throw new VerifyError(`unknown command "${command}"; run \`kin-verify help\``);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    const message =
      error instanceof VerifyError || error instanceof RpcFailure
        ? error.message
        : // Playwright's call logs run to dozens of lines; the first says what failed.
          ((error as Error).message.split("\n")[0] ?? String(error));
    console.error(`kin-verify: ${message}`);
    process.exit(1);
  },
);
