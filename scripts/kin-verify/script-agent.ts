#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off globalTimers:off - an ACP agent process, spoken over stdio.
/**
 * A Kin lead with no model: `[kv:<id>]` runs the calls in `<verify dir>/turns/<id>.json` (plus
 * local `shell` and `sleep`) on the session's Kin MCP endpoint and replies with its `reply`.
 * T3's finished-task notice runs `turns/notice.json`, with "$task" for the task it names. A
 * question whose day came unanswered runs `turns/due.json`.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface McpServer {
  readonly url?: string;
  readonly headers?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly env?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** T3 gives ACP agents its MCP endpoint over HTTP, or as a stdio bridge whose env names it. */
function endpointOf(
  server: McpServer,
): { url: string; authorization?: string | undefined } | undefined {
  if (server.url !== undefined)
    return {
      url: server.url,
      authorization: server.headers?.find((h) => h.name.toLowerCase() === "authorization")?.value,
    };
  const env = new Map((server.env ?? []).map((entry) => [entry.name, entry.value]));
  const url = env.get("T3_ACP_MCP_ENDPOINT");
  return url === undefined
    ? undefined
    : { url, authorization: env.get("T3_ACP_MCP_AUTHORIZATION") };
}

interface TurnScript {
  readonly calls?: ReadonlyArray<{ readonly name: string; readonly arguments?: unknown }>;
  readonly reply?: string;
  /** Stays working this long before replying, so a person can watch the turn run. */
  readonly holdMs?: number;
  /** Fails the prompt after its calls, as a provider error would: Kin's failure lines follow. */
  readonly fail?: boolean;
}

const MARKER = /\[kv:([A-Za-z0-9_-]{4,64})\]/g;
const verifyDir =
  process.env.KIN_VERIFY_DIR ??
  NodePath.join(process.env.T3CODE_HOME ?? process.cwd(), "kin-verify");

/** Streamable HTTP MCP, the protocol T3's endpoint speaks; answers may come as JSON or SSE. */
async function mcpClient(server: McpServer) {
  const endpoint = endpointOf(server);
  if (endpoint === undefined) throw new Error("the session has no T3 MCP endpoint");
  const url = endpoint.url;
  const base: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (endpoint.authorization !== undefined) base.authorization = endpoint.authorization;
  let sessionId: string | undefined;
  let next = 1;
  const post = async (method: string, params: unknown, notification = false) => {
    const headers = { ...base };
    if (sessionId !== undefined) {
      headers["mcp-session-id"] = sessionId;
      headers["mcp-protocol-version"] = "2025-06-18";
    }
    const body = notification
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: next++, method, params };
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (notification) return undefined;
    const text = await response.text();
    if (!response.ok) return { error: { code: response.status, message: text || "HTTP error" } };
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .findLast((line) => line.length > 0)
      : text;
    return json === undefined ? undefined : (JSON.parse(json) as Record<string, unknown>);
  };
  const opened = await post("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kin-verify", version: "1" },
  });
  if (sessionId === undefined) throw new Error(`initialize: ${JSON.stringify(opened)}`);
  await post("notifications/initialized", {}, true);
  return {
    list: () => post("tools/list", {}),
    call: (name: string, args: unknown) => post("tools/call", { name, arguments: args ?? {} }),
  };
}

function promptText(params: Record<string, unknown>): string {
  const blocks = (params.prompt ?? []) as ReadonlyArray<{ type?: string; text?: string }>;
  return blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

interface Turn {
  readonly reply: string;
}

/** kin-bench measures every prompt: with `<verify dir>/capture-prompts` present, each is kept with its tool list. */
async function capture(server: McpServer | undefined, prompt: string) {
  const dir = NodePath.join(verifyDir, "prompts");
  if (!NodeFS.existsSync(NodePath.join(verifyDir, "capture-prompts"))) return;
  NodeFS.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const tools = server === undefined ? undefined : await (await mcpClient(server)).list();
  NodeFS.writeFileSync(NodePath.join(dir, `${name}.json`), JSON.stringify({ prompt, tools }));
}

/** T3's notice that a delegated task finished, as T3 words it or as Kin's prompt names it. */
const NOTICE =
  /Delegated tasks? ([^\s,]+)|task\.finished[\s\S]*?taskIds\\*"\s*:\s*\[\s*\\*"([^"\\]+)/;

/** Kin waking the asker because its question's day came (questions/openQuestions.ts dueTurnText). */
const DUE = /Your question to .+?, asked .+?, got no answer by its day/;

/** What a tool answered, as the agent reads it: the structured result, else its JSON text. */
const answerOf = (response: unknown): unknown => {
  const result = (
    response as {
      result?: { structuredContent?: unknown; content?: ReadonlyArray<{ text?: string }> };
    }
  )?.result;
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.map((part) => part.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** "$event" and "$chat" become the event the turn answers and the chat it replies to. */
function filler(before: string, prompt: string) {
  const eventId = [...before.matchAll(/"event"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
  const chatId = /(?:Your reply goes to chat|in the Team room, chat) "([^"]+)"/.exec(prompt)?.[1];
  const fill = (value: unknown): unknown =>
    value === "$event"
      ? eventId
      : value === "$chat"
        ? chatId
        : Array.isArray(value)
          ? value.map(fill)
          : typeof value === "object" && value !== null
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]))
            : value;
  return fill;
}

type Call = { readonly name: string; readonly arguments?: unknown };

type McpClient = Awaited<ReturnType<typeof mcpClient>>;
type CallResult = { readonly name: string; readonly response?: unknown; readonly error?: string };

/**
 * Runs `calls` in order into `results`. `shell` runs in `cwd` and `sleep` waits, as a model's own
 * tools and thinking would; the endpoint is connected at the first other call.
 */
async function callAll(
  connect: () => Promise<McpClient>,
  calls: ReadonlyArray<Call>,
  fill: (value: unknown) => unknown,
  results: Array<CallResult> = [],
  cwd = process.cwd(),
) {
  let client: McpClient | undefined;
  let listed: unknown;
  // Most Kin tools take the event the turn answers, which a real agent copies from its prompt.
  let takesEvent = new Set<string>();
  // "$key" in a later call's text is the first record key an earlier call answered with.
  let key: string | undefined;
  const withKey = (value: unknown): unknown =>
    typeof value === "string"
      ? value.replaceAll("$key", key ?? "$key")
      : Array.isArray(value)
        ? value.map(withKey)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, withKey(entry)]))
          : value;
  for (const call of calls) {
    const args = (call.arguments ?? {}) as Record<string, unknown>;
    if (call.name === "sleep") {
      await new Promise((done) => setTimeout(done, Number(args.ms ?? 0)));
      results.push({ name: "sleep" });
      continue;
    }
    if (call.name === "shell") {
      const run = NodeChildProcess.spawnSync("sh", ["-c", String(fill(args.command))], {
        cwd,
        encoding: "utf8",
      });
      results.push({
        name: "shell",
        response: { exitCode: run.status, output: `${run.stdout}${run.stderr}`.slice(-4000) },
      });
      continue;
    }
    if (client === undefined) {
      client = await connect();
      listed = await client.list();
      const tools = (listed ?? {}) as {
        result?: { tools?: ReadonlyArray<{ name: string; inputSchema?: { properties?: object } }> };
      };
      takesEvent = new Set(
        (tools.result?.tools ?? [])
          .filter((tool) => Object.hasOwn(tool.inputSchema?.properties ?? {}, "sourceEventId"))
          .map((tool) => tool.name),
      );
    }
    const withEvent =
      takesEvent.has(call.name) && args.sourceEventId === undefined
        ? { ...args, sourceEventId: "$event" }
        : args;
    const response =
      call.name === "tools/list" ? listed : await client.call(call.name, withKey(fill(withEvent)));
    key ??= /"key"\s*:\s*"([A-Z]+-\d+)"/.exec(JSON.stringify(response))?.[1];
    results.push({ name: call.name, response });
  }
  return results;
}

/**
 * A Team-room discussion played from `<verify dir>/team-play.json`: `{steps: [{agent, calls} |
 * {agent, pass: true}]}` in the order Kin should wake them. Each Team-room turn takes the next
 * step: run its calls if the step is this agent's, else pass and log a mismatch, so a wrong turn
 * order fails the script instead of drifting. `team-play.log.jsonl` gets one line per turn.
 */
async function teamTurn(server: McpServer | undefined, prompt: string): Promise<Turn | undefined> {
  const playPath = NodePath.join(verifyDir, "team-play.json");
  if (!/Team room turn/.test(prompt) || !NodeFS.existsSync(playPath)) return undefined;
  const play = JSON.parse(NodeFS.readFileSync(playPath, "utf8")) as {
    steps: ReadonlyArray<{
      agent: string;
      pass?: boolean;
      calls?: ReadonlyArray<Call>;
    }>;
  };
  const logPath = NodePath.join(verifyDir, "team-play.log.jsonl");
  const done = NodeFS.existsSync(logPath)
    ? NodeFS.readFileSync(logPath, "utf8").split("\n").filter(Boolean).length
    : 0;
  if (server === undefined) return { reply: "No MCP server." };
  const client = await mcpClient(server);
  const leads = (await client.call("kin_leads", {})) as {
    result?: { structuredContent?: { leads?: ReadonlyArray<{ name: string; you: boolean }> } };
  };
  const me = leads.result?.structuredContent?.leads?.find((lead) => lead.you)?.name ?? "unknown";
  const step = play.steps[done];
  const log = (entry: object) =>
    NodeFS.appendFileSync(logPath, `${JSON.stringify({ step: done, agent: me, ...entry })}\n`);
  if (step === undefined || step.agent !== me) {
    log({ did: "mismatch", expected: step?.agent ?? "no more steps" });
    return { reply: "Pass." };
  }
  if (step.pass === true) {
    log({ did: "passed" });
    return { reply: "Pass." };
  }
  log({
    did: "ran",
    results: await callAll(async () => client, step.calls ?? [], filler(prompt, prompt)),
  });
  return { reply: "Said." };
}

/** The pulse this turn answers, if it is one: a check-in, or an ordinary pulse. */
function pulseOf(prompt: string): "checkIn" | "pulse" | undefined {
  let pulse: "checkIn" | "pulse" | undefined;
  for (const match of prompt.matchAll(
    /^> BEGIN QUOTE: event data\n> (\{[^\n]*\})\n> END QUOTE$/gm,
  )) {
    try {
      const event: unknown = JSON.parse(match[1]!);
      if (typeof event !== "object" || event === null || !("type" in event)) continue;
      if (event.type !== "pulse") continue;
      if ("checkIn" in event && event.checkIn !== null && typeof event.checkIn === "object")
        return "checkIn";
      pulse = "pulse";
    } catch {
      continue;
    }
  }
  return pulse;
}

async function runTurn(
  server: McpServer | undefined,
  prompt: string,
  cwd: string | undefined,
): Promise<Turn> {
  await capture(server, prompt).catch(() => undefined);
  const team = await teamTurn(server, prompt);
  if (team !== undefined) return team;
  // A due turn's chat history quotes the ask's marker, so it is checked first.
  const due = DUE.test(prompt);
  // The prompt may quote earlier messages; the newest marker is this turn's.
  const marked = due ? undefined : [...prompt.matchAll(MARKER)].at(-1)?.[1];
  const notice = marked === undefined && !due ? NOTICE.exec(prompt) : null;
  const id = due ? "due" : (marked ?? (notice === null ? undefined : "notice"));
  // A check-in (Run now) answers with `<verify dir>/checkin-reply.md` once, to show a brief.
  const brief = NodePath.join(verifyDir, "checkin-reply.md");
  const pulse = pulseOf(prompt);
  if (pulse === "checkIn" && NodeFS.existsSync(brief)) {
    const reply = NodeFS.readFileSync(brief, "utf8");
    NodeFS.rmSync(brief);
    return { reply };
  }
  // A pulse quotes the chat, so a marker in it is someone's message, not this turn's script.
  if (pulse !== undefined) return { reply: "Noted." };
  if (id === undefined) return { reply: "Noted." };
  const task = notice?.[1] ?? notice?.[2];
  const scriptPath = NodePath.join(verifyDir, "turns", `${id}.json`);
  const resultPath = NodePath.join(verifyDir, "turns", `${id}.result.json`);
  // A turn re-run after a restart must not repeat its tool calls; every notice and due turn is its own.
  if (notice === null && !due && NodeFS.existsSync(resultPath)) return { reply: "Done." };
  let script: TurnScript;
  try {
    script = JSON.parse(NodeFS.readFileSync(scriptPath, "utf8")) as TurnScript;
  } catch {
    return { reply: `No script for ${id}.` };
  }
  NodeFS.writeFileSync(NodePath.join(verifyDir, "turns", `${id}.prompt.txt`), prompt);
  // A real agent copies the event it answers and the chat it replies to from its prompt;
  // "$event" and "$chat" ask for those.
  const base = filler(prompt.slice(0, prompt.lastIndexOf(`[kv:${id}]`)), prompt);
  const results: Array<CallResult> = [];
  // "$from:<n>:<a.b>" is a field of the answer to this turn's call n, as an agent copies one.
  const from = (value: string) => {
    const [, index = "", path = ""] = value.split(":");
    return path
      .split(".")
      .filter(Boolean)
      .reduce<unknown>(
        (at, key) => (at as Record<string, unknown> | undefined)?.[key],
        answerOf(results[Number(index)]?.response),
      );
  };
  const fill = (value: unknown): unknown =>
    value === "$task"
      ? task
      : typeof value === "string" && value.startsWith("$from:")
        ? from(value)
        : Array.isArray(value)
          ? value.map(fill)
          : typeof value === "object" && value !== null
            ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]))
            : base(value);
  const connect = async () => {
    if (server === undefined) throw new Error("no MCP server in this session");
    return mcpClient(server);
  };
  try {
    await callAll(connect, script.calls ?? [], fill, results, cwd ?? process.cwd());
  } catch (error) {
    results.push({ name: "error", error: String(error) });
  }
  if (script.holdMs !== undefined) await new Promise((done) => setTimeout(done, script.holdMs));
  NodeFS.writeFileSync(resultPath, JSON.stringify({ results }, null, 2));
  if (script.fail === true) throw new Error("kin-verify: this turn fails on purpose");
  return { reply: script.reply ?? "Done." };
}

function main(): void {
  const sessions = new Map<string, { server: McpServer | undefined; cwd: string | undefined }>();
  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const models = {
    currentModelId: "script",
    availableModels: [
      { modelId: "script", name: "Script (kin-verify)" },
      // A second model, so a check can switch an agent's model and see the next turn use it.
      { modelId: "script-b", name: "Script B (kin-verify)" },
    ],
  };
  const handle = async (message: JsonRpcMessage): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true },
            // Kin sends every provider pictures (`lead/turn/content.ts`); T3 refuses them otherwise.
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "kin-verify-script", version: "1" },
        };
      case "session/new":
      case "session/load": {
        const sessionId =
          message.method === "session/load" ? String(params.sessionId) : NodeCrypto.randomUUID();
        const servers = (params.mcpServers ?? []) as ReadonlyArray<McpServer>;
        sessions.set(sessionId, {
          server: servers.find((server) => endpointOf(server) !== undefined),
          cwd: typeof params.cwd === "string" ? params.cwd : undefined,
        });
        return { ...(message.method === "session/new" ? { sessionId } : {}), models };
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const session = sessions.get(sessionId);
        const turn = await runTurn(session?.server, promptText(params), session?.cwd);
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: turn.reply },
            },
          },
        });
        return { stopReason: "end_turn" };
      }
      case "session/close":
        sessions.delete(String(params.sessionId));
        return {};
      case "authenticate":
      case "session/set_mode":
      case "session/set_model":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };
  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    const message = JSON.parse(line) as JsonRpcMessage;
    if (message.method === undefined || message.id === undefined || message.id === null) return;
    const id = message.id;
    handle(message).then(
      (result) => send({ id, result }),
      (error: Error & { code?: number }) =>
        send({ id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  });
}

if (import.meta.main) main();
