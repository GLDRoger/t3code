// @effect-diagnostics nodeBuiltinImport:off - Drives the scripted agent's real process over stdio.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { assert, it } from "@effect/vitest";

const AGENT = NodePath.join(import.meta.dirname, "script-agent.ts");

/** One JSON-RPC session with a fresh agent process; each request resolves with its response. */
const session = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-script-agent-"));
  const agent = NodeChildProcess.spawn(process.execPath, [AGENT], {
    env: { ...process.env, KIN_VERIFY_DIR: dir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  NodeReadline.createInterface({ input: agent.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  let next = 0;
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    dir,
    request,
    [Symbol.dispose]: () => {
      agent.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
};

// Kin sends every provider pictures (`lead/turn/content.ts`: a scanned PDF's pages, a photo), and
// T3's ACP adapter refuses a turn carrying one unless the agent negotiated image prompts.
it("the scripted agent takes the pictures Kin sends every provider, and answers a turn with one", async () => {
  using agent = session();
  const init = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const capabilities = (
    init.result as { agentCapabilities?: { promptCapabilities?: { image?: boolean } } }
  ).agentCapabilities;
  assert.isTrue(capabilities?.promptCapabilities?.image);
  const opened = await agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const { sessionId } = opened.result as { sessionId: string };
  const turn = await agent.request("session/prompt", {
    sessionId,
    prompt: [
      { type: "text", text: '[Page 1 of "brief.pdf" is attached as an image.]' },
      { type: "image", mimeType: "image/jpeg", data: "/9j/2w==" },
    ],
  });
  assert.deepStrictEqual(turn.result, { stopReason: "end_turn" });
});

it("uses the brief fixture once for a pulse check-in, not an ordinary pulse, and runs no chat script in either", async () => {
  using agent = session();
  const { result } = await agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  const { sessionId } = result as { sessionId: string };
  const brief = NodePath.join(agent.dir, "checkin-reply.md");
  NodeFS.writeFileSync(brief, "Review the Orbit Dental invoice.\n\n## Money\nIt's overdue.");
  // The owner's scripted message, which a pulse quotes as chat history.
  NodeFS.mkdirSync(NodePath.join(agent.dir, "turns"));
  NodeFS.writeFileSync(NodePath.join(agent.dir, "turns", "seed1234.json"), '{"reply":"Wrote it."}');
  const base = { event: "pulse-a", type: "pulse", factKeys: [] };
  const turn = (event: object) =>
    agent.request("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: `# Chat\n\n[kv:seed1234] doc_create\n\n# Events\n\n> BEGIN QUOTE: event data\n> ${JSON.stringify(event)}\n> END QUOTE`,
        },
      ],
    });
  await turn(base);
  assert.isTrue(NodeFS.existsSync(brief));
  await turn({
    ...base,
    checkIn: { scheduleId: "checkin-morning", title: "Morning", what: "Review.", slot: "now" },
  });
  assert.isFalse(NodeFS.existsSync(brief));
  await turn(base);
  assert.isFalse(NodeFS.existsSync(NodePath.join(agent.dir, "turns", "seed1234.prompt.txt")));
});
