// Eval-only: drives `codex app-server`, the harness T3's Codex adapter runs, on this machine's
// Codex sign-in. One process serves every sample; each sample is one ephemeral thread.
// @effect-diagnostics nodeBuiltinImport:off globalDate:off extendsNativeError:off - a promise-based stdio client, wrapped by the runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

type Json = unknown;
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void };

export type AppServerTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly deferLoading: boolean;
};

export type AppServerTurn = {
  readonly model: string;
  readonly effort: string;
  readonly baseInstructions: string;
  readonly config: Readonly<Record<string, Json>>;
  /** The namespace Codex lists the tools under, as it lists an MCP server's. */
  readonly namespace: string;
  readonly tools: ReadonlyArray<AppServerTool>;
  /** Earlier turns, as raw Responses items. */
  readonly history: ReadonlyArray<Json>;
  readonly prompt: string;
  /** Pictures the turn carries after its text, as data URLs, as T3's Codex adapter sends them. */
  readonly images?: ReadonlyArray<string> | undefined;
  /** Answers one tool call with the text Codex hands back to the model. */
  readonly onToolCall: (tool: string, args: Json) => Promise<{ text: string; failed: boolean }>;
  /** Interrupts the turn after this many tool calls; `Infinity` never does. */
  readonly maxToolCalls: number;
};

export type AppServerEvent =
  | { readonly type: "text"; readonly text: string; readonly phase: string | null }
  | { readonly type: "tool"; readonly id: string; readonly tool: string; readonly args: Json };

export type AppServerResult = {
  readonly events: ReadonlyArray<AppServerEvent>;
  readonly usage: { input: number; cached: number; output: number; reasoning: number };
  readonly ms: number;
  readonly stopReason: string;
  readonly items: ReadonlyArray<Json>;
};

export class AppServerError extends Error {}

export const openAppServer = () => {
  const child = NodeChildProcess.spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const threads = new Map<string, (message: Record<string, any>) => void>();
  let buffer = "";
  let stderr = "";
  const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: Json) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === "") continue;
      const message = JSON.parse(line) as Record<string, any>;
      if (message.method === undefined && message.id !== undefined) {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          waiting?.reject(new AppServerError(`${message.error.message ?? "app-server error"}`));
        else waiting?.resolve(message.result);
        continue;
      }
      const threadId = message.params?.threadId ?? message.params?.thread?.id;
      const route = typeof threadId === "string" ? threads.get(threadId) : undefined;
      if (route) route(message);
      // A server request no sample owns must still be answered, or the turn waits forever.
      else if (message.id !== undefined)
        send({ id: message.id, error: { code: -32601, message: "Not handled by the eval." } });
    }
  });
  const exited = new Promise<never>((_, reject) =>
    child.on("exit", (code) =>
      reject(new AppServerError(`codex app-server exited (${code}): ${stderr}`)),
    ),
  );
  const ready = request("initialize", {
    clientInfo: { name: "t3-evals", version: "0" },
    capabilities: { experimentalApi: true },
  }).then(() => send({ method: "initialized" }));

  let catalog: Promise<ReadonlySet<string>> | undefined;
  /** Whether Codex's catalog knows the model; one it lacks runs with no tool search. */
  const knowsModel = async (model: string) => {
    catalog ??= ready.then(async () => {
      const models = new Set<string>();
      let cursor: string | null | undefined;
      do {
        const page = await request("model/list", {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of page.data) models.add(entry.model);
        cursor = page.nextCursor;
      } while (cursor);
      return models;
    });
    return (await catalog).has(model);
  };

  const runTurn = async (turn: AppServerTurn): Promise<AppServerResult> => {
    await ready;
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-eval-"));
    const started = Date.now();
    const events: Array<AppServerEvent> = [];
    const items: Array<Json> = [];
    const usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
    let calls = 0;
    let interrupted = false;
    let finish: (reason: string) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const done = new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    const thread = await request("thread/start", {
      model: turn.model,
      cwd,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      baseInstructions: turn.baseInstructions,
      config: turn.config,
      dynamicTools: [
        {
          type: "namespace",
          name: turn.namespace,
          description: "Tools of the app this agent works in.",
          tools: turn.tools.map((tool) => ({ type: "function", ...tool })),
        },
      ],
    });
    const threadId: string = thread.thread.id;
    let turnId: string | undefined;
    threads.set(threadId, (message) => {
      if (message.method === "item/tool/call" && message.id !== undefined) {
        const { tool, arguments: args, callId } = message.params;
        events.push({ type: "tool", id: callId, tool, args });
        calls++;
        void turn.onToolCall(tool, args).then(
          (answer) => {
            send({
              id: message.id,
              result: {
                success: !answer.failed,
                contentItems: [{ type: "inputText", text: answer.text }],
              },
            });
            if (calls >= turn.maxToolCalls && !interrupted && turnId !== undefined) {
              interrupted = true;
              void request("turn/interrupt", { threadId, turnId }).catch(() => {});
            }
          },
          (error: Error) => fail(error),
        );
        return;
      }
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: "Not handled by the eval." } });
        return;
      }
      if (message.method === "item/completed") {
        const item = message.params.item;
        items.push(item);
        if (item.type === "agentMessage")
          events.push({ type: "text", text: item.text, phase: item.phase ?? null });
      }
      if (message.method === "thread/tokenUsage/updated") {
        const last = message.params.tokenUsage?.last;
        if (last) {
          usage.input += last.inputTokens;
          usage.cached += last.cachedInputTokens;
          usage.output += last.outputTokens;
          usage.reasoning += last.reasoningOutputTokens;
        }
      }
      if (message.method === "error" && message.params?.willRetry !== true)
        fail(new AppServerError(JSON.stringify(message.params?.error ?? message.params)));
      if (message.method === "turn/completed") {
        const status = message.params.turn?.status;
        if (status === "failed")
          fail(new AppServerError(JSON.stringify(message.params.turn?.error ?? "turn failed")));
        else finish(interrupted ? "max_steps" : "end_turn");
      }
    });
    try {
      if (turn.history.length > 0)
        await request("thread/inject_items", { threadId, items: turn.history });
      const startedTurn = await request("turn/start", {
        threadId,
        input: [
          { type: "text", text: turn.prompt, text_elements: [] },
          ...(turn.images ?? []).map((url) => ({ type: "image", url })),
        ],
        effort: turn.effort,
        environments: [],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      turnId = startedTurn.turn.id;
      const stopReason = await Promise.race([done, exited]);
      return { events, usage, ms: Date.now() - started, stopReason, items };
    } finally {
      threads.delete(threadId);
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  };
  return { runTurn, knowsModel, close: () => child.kill() };
};
export type AppServer = ReturnType<typeof openAppServer>;
