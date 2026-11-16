#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalDate:off - an ACP agent process, spoken over stdio.
/**
 * A Kin lead with no model, run by a dev server as the `kinVerifyScript` ACP instance. A prompt
 * with `[kv:<id>]` makes it call the tools in `<verify dir>/turns/<id>.json` on the session's real
 * Kin MCP endpoint, write `<id>.result.json` and reply with the file's `reply`.
 */
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
  await post("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kin-verify", version: "1" },
  });
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

/** kin-bench measures every prompt: with `<verify dir>/capture-prompts` present, each is kept with its tool list. */
async function capture(server: McpServer | undefined, prompt: string) {
  const dir = NodePath.join(verifyDir, "prompts");
  if (!NodeFS.existsSync(NodePath.join(verifyDir, "capture-prompts"))) return;
  NodeFS.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const tools = server === undefined ? undefined : await (await mcpClient(server)).list();
  NodeFS.writeFileSync(NodePath.join(dir, `${name}.json`), JSON.stringify({ prompt, tools }));
}

async function runTurn(server: McpServer | undefined, prompt: string): Promise<string> {
  await capture(server, prompt).catch(() => undefined);
  // The prompt may quote earlier messages; the newest marker is this turn's.
  const id = [...prompt.matchAll(MARKER)].at(-1)?.[1];
  if (id === undefined) return "Noted.";
  const scriptPath = NodePath.join(verifyDir, "turns", `${id}.json`);
  const resultPath = NodePath.join(verifyDir, "turns", `${id}.result.json`);
  // A turn re-run after a restart must not repeat its tool calls.
  if (NodeFS.existsSync(resultPath)) return "Done.";
  let script: TurnScript;
  try {
    script = JSON.parse(NodeFS.readFileSync(scriptPath, "utf8")) as TurnScript;
  } catch {
    return `No script for ${id}.`;
  }
  NodeFS.writeFileSync(NodePath.join(verifyDir, "turns", `${id}.prompt.txt`), prompt);
  // A real agent copies the id of the event it answers from its prompt; "$event" asks for that.
  const before = prompt.slice(0, prompt.lastIndexOf(`[kv:${id}]`));
  const eventId = [...before.matchAll(/"event"\s*:\s*"([^"]+)"/g)].at(-1)?.[1];
  const fill = (value: unknown): unknown =>
    value === "$event"
      ? eventId
      : Array.isArray(value)
        ? value.map(fill)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)]))
          : value;
  const results: Array<unknown> = [];
  try {
    if (server === undefined) throw new Error("no MCP server in this session");
    const mcp = await mcpClient(server);
    const listed = (await mcp.list()) as {
      result?: { tools?: ReadonlyArray<{ name: string; inputSchema?: { properties?: object } }> };
    };
    // Most Kin tools take the event the turn answers, which a real agent copies from its prompt.
    const takesEvent = new Set(
      (listed.result?.tools ?? [])
        .filter((tool) => Object.hasOwn(tool.inputSchema?.properties ?? {}, "sourceEventId"))
        .map((tool) => tool.name),
    );
    for (const call of script.calls ?? []) {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      const withEvent =
        takesEvent.has(call.name) && args.sourceEventId === undefined
          ? { ...args, sourceEventId: "$event" }
          : args;
      results.push({
        name: call.name,
        response: call.name === "tools/list" ? listed : await mcp.call(call.name, fill(withEvent)),
      });
    }
  } catch (error) {
    results.push({ error: String(error) });
  }
  NodeFS.writeFileSync(resultPath, JSON.stringify({ results }, null, 2));
  return script.reply ?? "Done.";
}

function main(): void {
  const sessions = new Map<string, { server: McpServer | undefined }>();
  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const models = {
    currentModelId: "script",
    availableModels: [{ modelId: "script", name: "Script (kin-verify)" }],
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
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
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
        });
        return { ...(message.method === "session/new" ? { sessionId } : {}), models };
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const reply = await runTurn(sessions.get(sessionId)?.server, promptText(params));
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: reply },
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
