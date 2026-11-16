#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off globalFetch:off - a dev benchmark CLI.
/**
 * kin-bench: one command that seeds the large invented company, serves the production web build,
 * and measures the web client, the wire, the server and the agent prompts, several times each.
 * Writes JSON, Markdown and an HTML page; `--compare <old.json>` flags what got worse. No model
 * is called. See `.agents/skills/verify-kin/SKILL.md`, "Benchmark".
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { database, deviceInvite, directChat, agentOf, rpcAs } from "./kin-verify/actors.ts";
import { BENCH } from "./kin-verify/benchSeed.ts";
import {
  gitHead,
  type Instance,
  instanceOf,
  isAlive,
  mintPairing,
  ORG,
  readJson,
  readSeed,
  readState,
  ROOT,
  sleep,
  stopTree,
  writeState,
} from "./kin-verify/instance.ts";
import * as Web from "./kin-verify/web.ts";
import { capturePrompts } from "./kin-bench/prompts.ts";
import { compareLines, type Finding, renderHtml, renderMarkdown } from "./kin-bench/report.ts";
import {
  type BenchResult,
  type Chatter,
  type Metric,
  metric,
  type WireRow,
} from "./kin-bench/stats.ts";
import {
  deflatedSize,
  idle,
  Probe,
  scrollJank,
  timed,
  typingLatency,
  untilVisible,
} from "./kin-bench/web.ts";

const HELP = `kin-bench [--out <dir>] [--compare <old.json>] [--threshold <percent>] [--runs <n>] [--instance <name>] [--reuse] [--findings <json>] [--heap <dir>]
kin-bench --render <run.json> [--findings <json>] [--compare <old.json>]   re-render an earlier run's .md and report.html
  Seeds the "bench" company on its own kin-verify instance (default "bench"), measures, writes
  <out>/baseline-<commit>.json, .md and report.html, then stops everything it started.
  --runs        samples per web action (default 5; server reads take 4x as many)
  --compare     an earlier JSON: each metric's old, new and change; worse past --threshold (default 15) is flagged
  --reuse       keep an already seeded bench instance instead of seeding from cold
  --only prompts  capture the agent prompts and tool lists only: no web build, server timing or walk
  --heap        a directory for a server heap snapshot taken after the walk`;

const CHATS = `[aria-label="Kin chats"]`;
const log = (line: string) => console.log(`kin-bench: ${line}`);

function argsOf(argv: ReadonlyArray<string>) {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected "${arg}"; run kin-bench --help`);
    const name = arg.slice(2);
    if (name === "reuse" || name === "help") flags.set(name, true);
    else flags.set(name, argv[++index] ?? "");
  }
  const get = (name: string) => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  return { flags, get };
}

const kv = (instance: Instance, args: ReadonlyArray<string>) => {
  const out = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(ROOT, "scripts", "kin-verify.ts"), "--instance", instance.name, ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
  if (out.status !== 0)
    throw new Error(
      `kin-verify ${args.join(" ")}: ${(out.stderr || out.stdout).trim().split("\n").at(-1)}`,
    );
  return out.stdout.trim();
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as NodeNet.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });

const rssMb = (pid: number) => {
  const out = NodeChildProcess.spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return Number(out.stdout.trim()) / 1024;
};

/**
 * The server as an installed host runs it: `t3 serve` with the production web build it serves
 * itself (apps/web/dist). Ready is the first owner RPC answered. kin-verify's `down` stops it.
 */
async function startProd(
  instance: Instance,
  heapDir?: string,
): Promise<{ readyMs: number; pid: number; origin: string }> {
  const previous = readState(instance);
  if (previous !== undefined) await stopTree(previous.pid);
  const port = await freePort();
  const log = NodeFS.openSync(NodePath.join(instance.meta, "bench-server.log"), "a");
  const started = performance.now();
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      ...(heapDir === undefined
        ? []
        : ["--heapsnapshot-signal=SIGUSR2", `--diagnostic-dir=${heapDir}`]),
      "src/bin.ts",
      "serve",
      "--base-dir",
      instance.home,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: NodePath.join(ROOT, "apps", "server"),
      env: {
        ...process.env,
        KIN_ENABLED: "true",
        KIN_VERIFY_DIR: instance.meta,
        T3CODE_TELEMETRY_ENABLED: "false",
        T3CODE_HOME: undefined,
        VITE_HTTP_URL: undefined,
        VITE_WS_URL: undefined,
      },
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  child.unref();
  const origin = `http://127.0.0.1:${port}`;
  writeState(instance, {
    pid: child.pid!,
    commit: gitHead(),
    startedAt: Date.now(),
    serverPort: port,
    webPort: port,
    origin,
    web: origin,
    ...(previous?.chrome === undefined ? {} : { chrome: previous.chrome }),
  });
  for (let waited = 0; waited < 120_000; waited += 50) {
    if (!isAlive(child.pid))
      throw new Error(
        `the server exited during start; see ${NodePath.join(instance.meta, "bench-server.log")}`,
      );
    const ok = await fetch(origin).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) {
      const rpc = await rpcAs(instance, "owner").catch(() => undefined);
      if (rpc !== undefined) {
        try {
          await rpc.call("kin.access.me", { orgId: ORG }, { timeoutMs: 10_000 });
          return { readyMs: performance.now() - started, pid: child.pid!, origin };
        } catch {
        } finally {
          rpc.close();
        }
      }
    }
    await sleep(50);
  }
  throw new Error("the server was not ready in 120 s");
}

async function timeRead(
  instance: Instance,
  runs: number,
  method: string,
  payload: unknown,
  until?: (values: ReadonlyArray<unknown>) => boolean,
) {
  const rpc = await rpcAs(instance, "owner");
  const samples: Array<number> = [];
  let bytes = 0;
  let deflated = 0;
  try {
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      const result = await rpc.call(method, payload, until === undefined ? {} : { until });
      samples.push(performance.now() - started);
      const text = JSON.stringify(result);
      bytes = Buffer.byteLength(text);
      deflated = deflatedSize(text, Buffer.alloc(0));
    }
  } finally {
    rpc.close();
  }
  return { samples, bytes, deflated };
}

async function sessionOf(instance: Instance, person: string) {
  return Web.openWeb(instance, person, {
    pairingUrl: () =>
      `${readState(instance)!.web}/pair#token=${mintPairing(instance, "kin-bench web").token}`,
    inviteSecret: () => deviceInvite(instance, person),
  });
}

async function main() {
  process.removeAllListeners("warning");
  const { flags, get } = argsOf(process.argv.slice(2));
  if (flags.has("help")) return console.log(HELP);
  const began = performance.now();
  const runs = Number(get("runs") ?? "5");
  const out = NodePath.resolve(get("out") ?? NodePath.join(ROOT, ".t3", "kin-bench"));
  const instance = instanceOf(get("instance") ?? "bench");
  const commit = gitHead();
  const metrics: Array<Metric> = [];
  const wire: Array<WireRow> = [];
  const notes: Array<string> = [];

  const findings =
    get("findings") === undefined ? undefined : readJson<Array<Finding>>(get("findings")!);
  const rendered = get("render");
  if (rendered !== undefined) {
    // Re-renders an earlier run's JSON, with findings written after reading it.
    const result = readJson<BenchResult>(rendered);
    if (result === undefined) throw new Error(`--render ${rendered}: not a kin-bench JSON`);
    const previous =
      get("compare") === undefined ? undefined : readJson<BenchResult>(get("compare")!);
    const comparison =
      previous === undefined
        ? undefined
        : compareLines(previous, result, Number(get("threshold") ?? "15"));
    const base = rendered.replace(/\.json$/, "");
    NodeFS.writeFileSync(`${base}.md`, renderMarkdown(result, comparison, findings));
    NodeFS.writeFileSync(
      NodePath.join(NodePath.dirname(rendered), "report.html"),
      renderHtml(result, comparison, findings),
    );
    return log(
      `rendered ${base}.md and ${NodePath.join(NodePath.dirname(rendered), "report.html")}`,
    );
  }

  const promptsOnly = get("only") === "prompts";
  const heapArg = get("heap");
  const heapDir = heapArg === undefined ? undefined : NodePath.resolve(heapArg);
  if (heapDir !== undefined) NodeFS.mkdirSync(heapDir, { recursive: true });
  if (get("build") !== "skip" && !promptsOnly) {
    log("building the web client (production bundle)");
    const built = NodeChildProcess.spawnSync("vp", ["run", "build"], {
      cwd: NodePath.join(ROOT, "apps", "web"),
      encoding: "utf8",
    });
    if (built.status !== 0)
      throw new Error(
        `web build failed: ${(built.stderr || built.stdout).trim().split("\n").slice(-3).join(" ")}`,
      );
  }

  try {
    const seeded = readSeed(instance);
    if (!(flags.has("reuse") && seeded?.name === "bench")) {
      log("seeding the bench company from cold (dev server, fake mail, scripted agents)");
      const started = performance.now();
      kv(instance, ["down", "--wipe"]);
      kv(instance, ["up", "--seed", "bench"]);
      notes.push(`Seeding took ${((performance.now() - started) / 1000).toFixed(0)} s.`);
    } else kv(instance, ["up", "--seed", "bench"]);

    const db = database(instance);
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const seedCounts = {
      messagesInLongChat: count(
        `SELECT COUNT(*) AS n FROM kin_messages m JOIN kin_chats c ON c.chat_id = m.chat_id WHERE c.title = '${BENCH.group}'`,
      ),
      cardsInLongChat: count(
        `SELECT COUNT(*) AS n FROM kin_widgets w JOIN kin_chats c ON c.chat_id = w.chat_id WHERE c.title = '${BENCH.group}'`,
      ),
      tasks: count(`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = 'work'`),
      clients: count(`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = 'clients'`),
      docs: count(`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = 'docs'`),
      invoices: count(`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = 'invoices'`),
      expenses: count(`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = 'expenses'`),
    };
    db.close();
    log(`seed: ${JSON.stringify(seedCounts)}`);

    // Prompts need the dev server: its fake mailbox is how outside mail arrives.
    const prompts =
      get("skip") === "prompts"
        ? {
            turns: [],
            tools: [],
            toolListBytes: { modelFacing: 0, withOutputSchemas: 0 },
            systemTokens: 0,
          }
        : await capturePrompts(instance, log);

    const save = (
      captured: typeof prompts,
      seed: typeof seedCounts,
      durationS: number,
      wireRows: Array<WireRow>,
      chatterRows: Array<Chatter>,
    ) => {
      for (const turn of captured.turns.filter((one) => one.reached))
        metrics.push(
          metric("prompt", `tokens.${turn.kind}`, `${turn.kind}: total tokens`, "tokens", [
            turn.totalTokens,
          ]),
        );
      const result: BenchResult = {
        commit,
        at: new Date().toISOString(),
        seed,
        runs,
        durationS,
        metrics,
        wire: wireRows,
        chatter: chatterRows,
        prompts: {
          method:
            "tokens ≈ UTF-8 bytes / 4. The repo has no tokenizer; its context budgets (agentContextBudget.json) count bytes. Turn prompts are the Kin part of what the scripted agent received; the system prompt is Kin's instructions (what a Claude lead gets); tools are name, description and input schema as listed on the turn's MCP endpoint.",
          systemTokens: captured.systemTokens,
          tools: captured.tools,
          toolListBytes: captured.toolListBytes,
          turns: captured.turns,
        },
        notes,
      };
      NodeFS.mkdirSync(out, { recursive: true });
      const base = NodePath.join(out, `baseline-${commit.slice(0, 10)}`);
      NodeFS.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
      const compareFile = get("compare");
      const previous = compareFile === undefined ? undefined : readJson<BenchResult>(compareFile);
      const comparison =
        previous === undefined
          ? undefined
          : compareLines(previous, result, Number(get("threshold") ?? "15"));
      NodeFS.writeFileSync(`${base}.md`, renderMarkdown(result, comparison, findings));
      NodeFS.writeFileSync(
        NodePath.join(out, "report.html"),
        renderHtml(result, comparison, findings),
      );
      log(
        `wrote ${base}.json, ${base}.md and ${NodePath.join(out, "report.html")} in ${result.durationS} s`,
      );
      if (comparison !== undefined)
        for (const line of comparison.filter((one) => one.worse))
          log(
            `WORSE ${line.label}: ${line.old} → ${line.now} (${line.change > 0 ? "+" : ""}${line.change.toFixed(0)}%)`,
          );
    };
    if (promptsOnly)
      return save(prompts, seedCounts, Math.round((performance.now() - began) / 1000), [], []);

    log("server start-up (production build), 3 starts");
    const starts: Array<number> = [];
    let server = { pid: 0, origin: "", readyMs: 0 };
    for (let run = 0; run < 3; run++) {
      server = await startProd(instance, heapDir);
      starts.push(server.readyMs);
    }
    metrics.push(metric("server", "startReady", "Start to first owner RPC answered", "ms", starts));
    await sleep(2000);
    const rssStart = rssMb(server.pid);

    const seed = readSeed(instance)!;
    const owner = await rpcAs(instance, "owner");
    const [chatList] = (await owner.call("kin.chats.subscribe", { orgId: ORG })) as Array<{
      chats: ReadonlyArray<{ chatId: string; title?: string | null }>;
    }>;
    const group = chatList!.chats.find((chat) => chat.title === BENCH.group)!;
    const chiefChat = await directChat(owner, agentOf(instance, "chief").agentId);
    const clientKey = (
      database(instance)
        .prepare(
          `SELECT key FROM kin_records WHERE register_id = 'clients' ORDER BY key LIMIT 1 OFFSET 5`,
        )
        .get() as { key: string }
    ).key;
    owner.close();

    log("server hot reads");
    const readRuns = runs * 4;
    const reads: Array<[string, string, unknown, ((values: ReadonlyArray<unknown>) => boolean)?]> =
      [
        ["chatList", "kin.chats.subscribe", { orgId: ORG }],
        ["chatPage", "kin.chat.history", { chatId: group.chatId, beforeSeq: 1500, limit: 100 }],
        // What today's clients ask; the `legacy` rows are what an older phone app still gets.
        ["workList", "kin.work.list", { orgId: ORG, open: true, acceptCompactRows: true }],
        ["workListLegacy", "kin.work.list", { orgId: ORG, open: true }],
        ["workSummary", "kin.work.summary", { orgId: ORG }],
        ["money", "kin.work.money", { orgId: ORG, upcomingRows: false }],
        ["moneyLegacy", "kin.work.money", { orgId: ORG }],
        ["clientPage", "kin.work.party", { orgId: ORG, key: clientKey }],
        ["pulse", "kin.pulse.read", { orgId: ORG, includeHandled: true, limit: 8 }],
        ["pulseLegacy", "kin.pulse.read", { orgId: ORG, includeHandled: true }],
        ["search", "kin.search", { orgId: ORG, text: "booking", limit: 20 }],
        ["docsList", "kin.docs.list", { orgId: ORG, acceptSlimLatest: true }],
        ["docsListLegacy", "kin.docs.list", { orgId: ORG }],
      ];
    for (const [key, method, payload] of reads) {
      try {
        const { samples, bytes, deflated } = await timeRead(instance, readRuns, method, payload);
        metrics.push(
          metric(
            "server",
            `read.${key}`,
            `${method}`,
            "ms",
            samples,
            `answer ${Math.round(bytes / 1024)} KB`,
          ),
        );
        const shape = key.endsWith("Legacy") ? ", older client" : "";
        metrics.push(
          metric("wire", `readBytes.${key}`, `${method}${shape} answer size`, "bytes", [bytes]),
          metric(
            "wire",
            `readDeflated.${key}`,
            `${method}${shape} answer, deflated alone`,
            "bytes",
            [deflated],
          ),
        );
      } catch (error) {
        notes.push(`Read ${method} failed: ${(error as Error).message.split("\n")[0]}`);
      }
    }

    log("web: signing in the five people");
    const people = ["owner", "meera", "dev", "zoya", "arjun"];
    const sessions = new Map<string, Awaited<ReturnType<typeof sessionOf>>>();
    for (const person of people) sessions.set(person, await sessionOf(instance, person));
    const session = sessions.get("owner")!;
    const page = session.page;
    const probe = await Probe.attach(page);
    const lastOf = (chatId: string) =>
      (
        database(instance)
          .prepare(
            `SELECT body FROM kin_messages WHERE chat_id = ? AND kind = 'text' AND status = 'posted' ORDER BY seq DESC LIMIT 1`,
          )
          .get(chatId) as { body: string }
      ).body;
    const chiefLast = lastOf(chiefChat);

    const samples = new Map<string, Array<number>>();
    const add = (key: string, value: number) =>
      samples.set(key, [...(samples.get(key) ?? []), value]);
    const wireOnce = new Set<string>();
    const record = async (
      key: string,
      act: () => Promise<unknown>,
      until: string,
      scope = "main",
    ) => {
      const from = probe.mark();
      try {
        add(key, await timed(page, act, until, scope));
      } catch (error) {
        await page
          .screenshot({ path: NodePath.join(instance.meta, `bench-fail-${key}.png`) })
          .catch(() => undefined);
        throw new Error(
          `${key}: "${until}" never showed in ${scope} (screenshot in ${instance.meta}): ${(error as Error).message.split("\n")[0]}`,
          { cause: error },
        );
      }
      await sleep(400);
      if (!wireOnce.has(key)) {
        wireOnce.add(key);
        wire.push(probe.wire(key, from));
      }
    };
    const link = (name: RegExp) => page.getByRole("link", { name }).first().click();

    log(`web: ${runs} walks`);
    let startupJs = 0;
    let startupCss = 0;
    for (let run = 0; run < runs; run++) {
      await probe.cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      probe.assets.clear();
      await page.goto("about:blank");
      await record("coldLoad", () => page.goto(session.base), "Studio floor", CHATS);
      await probe.cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
      if (run === 0) {
        const assets = [...probe.assets.values()];
        startupJs = assets
          .filter((one) => one.type === "Script")
          .reduce((sum, one) => sum + one.bytes, 0);
        startupCss = assets
          .filter((one) => one.type === "Stylesheet")
          .reduce((sum, one) => sum + one.bytes, 0);
        const largest = assets.toSorted((a, b) => b.bytes - a.bytes).slice(0, 5);
        notes.push(
          `Startup loads ${assets.filter((one) => one.type === "Script").length} scripts; largest: ${largest.map((one) => `${one.url.split("/").pop()} ${Math.round(one.bytes / 1024)} KB`).join(", ")}.`,
        );
      }
      await record("openLongChatCold", () => link(/^Studio floor, group/), BENCH.lastLine);
      await record("switchChat", () => link(/^Chief of staff, agent/), chiefLast);
      await record("openLongChatWarm", () => link(/^Studio floor, group/), BENCH.lastLine);
      await record("dockTasks", () => link(/^Tasks/), "· W-");
      await record("dockMoney", () => link(/^Money/), "owed");
      await record("dockClients", () => link(/^Clients/), "No logged contact");
      await record("dockDocs", () => link(/^Docs/), "Report 300");
      await link(/^Tasks/);
      await untilVisible(page, "· W-");
      const from = probe.mark();
      const started = performance.now();
      await page
        .locator("main")
        .getByRole("button", { name: /\. Due / })
        .first()
        .click();
      await page.getByRole("dialog").first().waitFor({ state: "visible" });
      add("taskSheet", performance.now() - started);
      await sleep(400);
      if (run === 0) wire.push(probe.wire("taskSheet", from));
      await page.keyboard.press("Escape");
      await sleep(300);
    }
    for (const [key, values] of samples) metrics.push(metric("web", key, key, "ms", values));
    metrics.push(metric("web", "startupJs", "JS at startup (transferred)", "bytes", [startupJs]));
    metrics.push(
      metric("web", "startupCss", "CSS at startup (transferred)", "bytes", [startupCss]),
    );

    log("web: typing and scrolling");
    await link(/^Studio floor, group/);
    await untilVisible(page, BENCH.lastLine);
    const composer = page.locator("main").getByRole("textbox").first();
    await composer.click();
    const fromType = probe.mark();
    const keys = await typingLatency(
      page,
      "Checking the staging build now, back in ten minutes".slice(0, 40),
    );
    wire.push(probe.wire("typing40Keys", fromType));
    await composer.fill("");
    metrics.push(
      metric("web", "keystroke", "Keystroke to next frame, long chat composer", "ms", keys),
    );
    const fromScroll = probe.mark();
    const chatScroll = [];
    for (let run = 0; run < 3; run++) chatScroll.push(await scrollJank(page, "up"));
    wire.push(probe.wire("scrollLongChat", fromScroll));
    metrics.push(
      metric(
        "web",
        "scrollChatSlowFrames",
        "Long chat scroll: frames over 34 ms (of 60)",
        "count",
        chatScroll.map((one) => one.slow),
        chatScroll[0]?.found === true
          ? `worst frame ${Math.round(Math.max(...chatScroll.map((one) => one.worst)))} ms`
          : "no scroll area found",
      ),
    );
    metrics.push(
      metric(
        "web",
        "scrollChatLongTaskMs",
        "Long chat scroll: long-task time",
        "ms",
        chatScroll.map((one) => one.longTaskMs),
      ),
    );
    await link(/^Tasks/);
    await untilVisible(page, "· W-");
    const taskScroll = [];
    for (let run = 0; run < 3; run++) {
      taskScroll.push(await scrollJank(page, "down", 30));
      await page.evaluate(() =>
        (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 0),
      );
    }
    if (!taskScroll.some((one) => one.found))
      notes.push("Tasks: no scrolling list found; the page itself scrolls.");
    metrics.push(
      metric(
        "web",
        "scrollTasksSlowFrames",
        "Tasks scroll: frames over 34 ms (of 30)",
        "count",
        taskScroll.map((one) => one.slow),
        taskScroll[0]?.found === true
          ? `worst frame ${Math.round(Math.max(...taskScroll.map((one) => one.worst)))} ms`
          : "no scroll area found",
      ),
    );
    metrics.push(
      metric(
        "web",
        "scrollTasksLongTaskMs",
        "Tasks scroll: long-task time",
        "ms",
        taskScroll.map((one) => one.longTaskMs),
      ),
    );

    await probe.cdp.send("HeapProfiler.enable");
    await probe.cdp.send("HeapProfiler.collectGarbage");
    const pageMetrics = await probe.metrics();
    metrics.push(
      metric("web", "heapAfterWalk", "JS heap after the walk", "MB", [
        pageMetrics.JSHeapUsedSize! / 1024 / 1024,
      ]),
    );
    metrics.push(
      metric("web", "domNodes", "DOM nodes after the walk", "count", [pageMetrics.Nodes ?? 0]),
    );

    log("web: idle 30 s on the Chats list, then 30 s inside the long chat");
    await page.goto(session.base);
    await untilVisible(page, "Studio floor", CHATS);
    await sleep(2000);
    const idleList = await idle(probe, 30);
    await link(/^Studio floor, group/);
    await untilVisible(page, BENCH.lastLine);
    await sleep(2000);
    const idleChat = await idle(probe, 30);
    metrics.push(
      metric(
        "web",
        "idleCpuList",
        "Idle main-thread CPU, Chats list",
        "percent",
        [idleList.cpuPercent],
        `${idleList.styleRecalcs} style recalcs, ${idleList.layouts} layouts, ${idleList.wire.framesIn} frames in`,
      ),
    );
    metrics.push(
      metric(
        "web",
        "idleCpuChat",
        "Idle main-thread CPU, inside the long chat",
        "percent",
        [idleChat.cpuPercent],
        `${idleChat.styleRecalcs} style recalcs, ${idleChat.layouts} layouts, ${idleChat.wire.framesIn} frames in`,
      ),
    );
    wire.push(
      { ...idleList.wire, action: "idle30sList" },
      { ...idleChat.wire, action: "idle30sChat" },
    );

    log("wire: refresh chatter, five people connected");
    const probes = new Map<string, Probe>([["owner", probe]]);
    for (const person of people.slice(1)) {
      const one = sessions.get(person)!;
      await one.page.goto(one.base);
      probes.set(person, await Probe.attach(one.page));
    }
    await page.goto(session.base);
    await sleep(4000);
    const chatter: Array<Chatter> = [];
    const watch = async (change: string, act: () => Promise<unknown>) => {
      const marks = new Map([...probes].map(([person, one]) => [person, one.mark()]));
      await act();
      await sleep(5000);
      chatter.push({
        change,
        clients: [...probes].map(([person, one]) => {
          const frames = one.frames.slice(marks.get(person));
          return {
            person,
            framesIn: frames.filter((frame) => frame.dir === "in").length,
            bytesIn: frames
              .filter((frame) => frame.dir === "in")
              .reduce((sum, frame) => sum + frame.bytes, 0),
            deflatedIn: frames.reduce((sum, frame) => sum + frame.deflated, 0),
            framesOut: frames.filter((frame) => frame.dir === "out" && frame.bytes > 20).length,
            requestsOut: frames.filter((frame) => frame.request).length,
            methods: Object.fromEntries(
              [
                ...new Set(
                  frames.flatMap((frame) => (frame.method === undefined ? [] : [frame.method])),
                ),
              ].map((method) => [method, frames.filter((frame) => frame.method === method).length]),
            ),
          };
        }),
      });
    };
    const as = async (person: string, method: string, payload: unknown) => {
      const rpc = await rpcAs(instance, person);
      try {
        return await rpc.call(method, payload);
      } finally {
        rpc.close();
      }
    };
    await watch("Dev posts in the group", () =>
      as("dev", "kin.messages.send", {
        chatId: group.chatId,
        clientMessageId: `kin-bench-chatter-${Date.now()}`,
        body: "bench chatter: one message",
      }),
    );
    await watch("Meera adds a task", () =>
      as("meera", "kin.work.create", {
        orgId: ORG,
        clientRequestId: `kin-bench-${Date.now()}`,
        title: "bench chatter: one task",
      }),
    );
    const taskKey = (
      database(instance)
        .prepare(
          `SELECT key FROM kin_records WHERE register_id = 'work' AND title = 'bench chatter: one task' ORDER BY key DESC LIMIT 1`,
        )
        .get() as { key: string } | undefined
    )?.key;
    if (taskKey !== undefined)
      await watch("Owner gives that task to Zoya", () =>
        as("owner", "kin.work.assign", {
          orgId: ORG,
          key: taskKey,
          to: { _tag: "person", personId: seed.people.zoya!.personId },
        }),
      );
    await watch("Nothing changes (5 s baseline)", async () => undefined);
    for (const [index, one] of chatter.entries()) {
      const sum = (key: "framesIn" | "bytesIn" | "requestsOut" | "deflatedIn") =>
        one.clients.reduce((total, client) => total + (client[key] ?? 0), 0);
      metrics.push(
        metric("wire", `chatter.${index}.bytes`, `${one.change}: KB in, all`, "bytes", [
          sum("bytesIn"),
        ]),
        metric("wire", `chatter.${index}.deflated`, `${one.change}: deflated, all`, "bytes", [
          sum("deflatedIn"),
        ]),
        metric("wire", `chatter.${index}.requests`, `${one.change}: requests, all`, "count", [
          sum("requestsOut"),
        ]),
      );
    }
    log("wire: the owner's socket drops and comes back, nothing changed");
    {
      const offline = (on: boolean) =>
        probe.cdp.send("Network.emulateNetworkConditions", {
          offline: on,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
      const mark = probe.mark();
      await offline(true);
      await sleep(3000);
      await offline(false);
      await sleep(8000);
      const row = probe.wire("reconnectIdle", mark);
      wire.push(row);
      // A reconnect that never happened would read as free: it has to subscribe again.
      const resubscribed = (row.methods?.["kin.work.subscribe"] ?? 0) > 0;
      metrics.push(
        metric(
          "wire",
          "reconnect.bytes",
          "Reconnect with nothing changed: KB in, owner",
          "bytes",
          [row.bytesIn],
          resubscribed ? undefined : "no resubscribe seen",
        ),
        metric("wire", "reconnect.deflated", "Reconnect with nothing changed: deflated", "bytes", [
          row.deflatedIn ?? 0,
        ]),
        metric("wire", "reconnect.requests", "Reconnect with nothing changed: requests", "count", [
          Object.values(row.methods ?? {}).reduce((total, count) => total + count, 0),
        ]),
      );
    }
    const cold = wire.find((row) => row.action === "coldLoad");
    if (cold !== undefined)
      metrics.push(
        metric("wire", "coldLoad.bytes", "Cold load, KB in", "bytes", [cold.bytesIn]),
        metric("wire", "coldLoad.deflated", "Cold load, deflated", "bytes", [cold.deflatedIn ?? 0]),
        metric("wire", "coldLoad.frames", "Cold load, frames in", "count", [cold.framesIn]),
        metric("wire", "coldLoad.requests", "Cold load, requests", "count", [
          Object.values(cold.methods ?? {}).reduce((total, count) => total + count, 0),
        ]),
      );

    const rssWalk = rssMb(server.pid);
    if (heapDir !== undefined) {
      // A snapshot collects garbage first, so it shows what the walk left held, not what it churned.
      const before = new Set(NodeFS.readdirSync(heapDir));
      process.kill(server.pid, "SIGUSR2");
      let written: string | undefined;
      for (let waited = 0; written === undefined && waited < 120_000; waited += 500) {
        await sleep(500);
        written = NodeFS.readdirSync(heapDir).find(
          (name) => name.endsWith(".heapsnapshot") && !before.has(name),
        );
      }
      if (written !== undefined) {
        // Written in pieces; done once its size holds still.
        let size = -1;
        while (size !== NodeFS.statSync(NodePath.join(heapDir, written)).size) {
          size = NodeFS.statSync(NodePath.join(heapDir, written)).size;
          await sleep(1000);
        }
        notes.push(`Server heap snapshot after the walk: ${NodePath.join(heapDir, written)}.`);
      } else notes.push("No server heap snapshot was written within 2 minutes.");
    }
    metrics.push(metric("server", "rssStart", "Server memory after start", "MB", [rssStart]));
    metrics.push(metric("server", "rssWalk", "Server memory after the walk", "MB", [rssWalk]));

    save(prompts, seedCounts, Math.round((performance.now() - began) / 1000), wire, chatter);
  } finally {
    log("stopping what it started");
    try {
      kv(instance, ["down"]);
    } catch (error) {
      console.error(`kin-bench: down failed: ${(error as Error).message}`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`kin-bench: ${(error as Error).message.split("\n")[0]}`);
    process.exit(1);
  },
);
