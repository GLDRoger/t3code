// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - a dev CLI acting as seeded people.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { KIN_INVITE_ACCEPT_ROUTE } from "@t3tools/contracts";

import {
  type Instance,
  mintPairing,
  ORG,
  readSeed,
  readSession,
  readState,
  sleep,
  writeSession,
} from "./instance.ts";
import { RpcConnection, VerifyError, exchangePairing } from "./rpc.ts";

/** Loaded on first use, after the CLI has muted node:sqlite's experimental warning. */
export const sqlite = () =>
  NodeModule.createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function originOf(instance: Instance): string {
  const origin = readState(instance)?.origin;
  if (origin === undefined) throw new VerifyError("no running instance; run `kin-verify up`");
  return origin;
}

/** The owner's session: a pairing credential from T3's own `pair`, exchanged once and kept. */
export async function ownerToken(instance: Instance): Promise<string> {
  const kept = readSession(instance, "owner");
  if (kept !== undefined) return kept;
  const { token } = mintPairing(instance, "kin-verify owner");
  const accessToken = await exchangePairing(originOf(instance), token);
  writeSession(instance, "owner", accessToken);
  return accessToken;
}

/** A teammate's session, the way their phone gets one: an invite link accepted. */
export async function acceptInvite(instance: Instance, secret: string, label: string) {
  const response = await fetch(new URL(KIN_INVITE_ACCEPT_ROUTE, originOf(instance)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, label }),
  });
  if (!response.ok) throw new VerifyError(`invite accept refused (${response.status})`);
  return (await response.json()) as { accessToken: string; person: { personId: string } };
}

export function personIdOf(instance: Instance, person: string): string {
  const seed = readSeed(instance);
  const found = seed?.people[person];
  if (found === undefined)
    throw new VerifyError(
      `no person "${person}" in this seed; people: ${Object.keys(seed?.people ?? {}).join(", ") || "none (run up)"}`,
    );
  return found.personId;
}

export function agentOf(instance: Instance, agent: string) {
  const seed = readSeed(instance);
  const found =
    seed?.agents[agent] ??
    Object.values(seed?.agents ?? {}).find((one) => one.agentId === agent || one.name === agent);
  if (found !== undefined) return found;
  // An agent a script made after the seed, by its name or id.
  const db = database(instance);
  try {
    const row = db
      .prepare(
        "SELECT agent_id AS agentId, name FROM kin_leads WHERE agent_id = ? OR lower(name) = lower(?) LIMIT 1",
      )
      .get(agent, agent) as { agentId: string; name: string } | undefined;
    if (row !== undefined) return row;
  } finally {
    db.close();
  }
  throw new VerifyError(
    `no agent "${agent}"; agents: ${Object.keys(seed?.agents ?? {}).join(", ") || "none"}`,
  );
}

/** A new link for an existing person, the "another device" invite the Team page makes. */
export async function deviceInvite(instance: Instance, person: string): Promise<string> {
  const owner = await rpcAs(instance, "owner");
  try {
    const invite = (await owner.call("kin.people.createInvite", {
      orgId: ORG,
      displayName: readSeed(instance)!.people[person]!.displayName,
      personId: personIdOf(instance, person),
    })) as { secret: string };
    return invite.secret;
  } finally {
    owner.close();
  }
}

export async function rpcAs(instance: Instance, person: string): Promise<RpcConnection> {
  if (person === "owner") return RpcConnection.open(originOf(instance), await ownerToken(instance));
  const token = readSession(instance, person);
  if (token === undefined) {
    personIdOf(instance, person);
    const accepted = await acceptInvite(
      instance,
      await deviceInvite(instance, person),
      `kin-verify ${person}`,
    );
    writeSession(instance, person, accepted.accessToken);
    return RpcConnection.open(originOf(instance), accepted.accessToken);
  }
  return RpcConnection.open(originOf(instance), token);
}

interface ChatSummary {
  readonly chatId: string;
  readonly kind: string;
  readonly members: ReadonlyArray<{ principal?: { _tag: string; agentId?: string } }>;
}

/** The person's direct chat with an agent, made the way the app makes it if missing. */
export async function directChat(rpc: RpcConnection, agentId: string): Promise<string> {
  const [first] = (await rpc.call("kin.chats.subscribe", { orgId: ORG })) as Array<{
    chats: ReadonlyArray<ChatSummary>;
  }>;
  const found = first?.chats.find(
    (chat) =>
      chat.kind === "direct" &&
      chat.members.some((member) => member.principal?.agentId === agentId),
  );
  if (found !== undefined) return found.chatId;
  const made = (await rpc.call("kin.chats.createDirect", { orgId: ORG, agentId })) as {
    chatId: string;
  };
  return made.chatId;
}

/** Read-only, on this instance's own database. */
export function database(instance: Instance): import("node:sqlite").DatabaseSync {
  const path = NodePath.join(instance.userdata, "statev2.sqlite");
  if (!NodeFS.existsSync(path)) throw new VerifyError("no database yet; run `kin-verify up`");
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export interface ToolCall {
  readonly name: string;
  readonly arguments?: unknown;
}

/**
 * Runs one real turn of `agent` in `person`'s chat with it on the scripted no-model agent: the
 * person's message wakes it through the real queue and floor, and the agent calls `calls` on
 * the real Kin MCP endpoint (gate, level, posting rules) before replying `reply`.
 */
export async function runTurn(
  instance: Instance,
  input: {
    readonly agent: string;
    readonly person: string;
    readonly calls: ReadonlyArray<ToolCall>;
    readonly reply?: string;
    /** Seconds the agent stays working before it replies, to watch the turn run. */
    readonly holdSeconds?: number;
    /** The turn fails after its calls instead of replying, as a model error would. */
    readonly fail?: boolean;
    readonly timeoutMs?: number;
  },
): Promise<ReadonlyArray<{ name: string; response?: unknown; error?: string }>> {
  const agent = agentOf(instance, input.agent);
  const id = NodeCrypto.randomBytes(6).toString("hex");
  const turns = NodePath.join(instance.meta, "turns");
  NodeFS.mkdirSync(turns, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(turns, `${id}.json`),
    JSON.stringify({
      calls: input.calls,
      reply: input.reply ?? "Done.",
      ...(input.holdSeconds === undefined ? {} : { holdMs: input.holdSeconds * 1000 }),
      ...(input.fail === true ? { fail: true } : {}),
    }),
  );
  const rpc = await rpcAs(instance, input.person);
  let chatId: string;
  let seq: number;
  try {
    chatId = await directChat(rpc, agent.agentId);
    const sent = (await rpc.call("kin.messages.send", {
      chatId,
      clientMessageId: `kin-verify-${id}`,
      body: `[kv:${id}] ${input.calls.map((call) => call.name).join(", ") || "reply"}`,
    })) as { seq: number };
    seq = sent.seq;
  } finally {
    rpc.close();
  }
  const resultPath = NodePath.join(turns, `${id}.result.json`);
  const deadline = Date.now() + (input.timeoutMs ?? 120_000);
  const db = database(instance);
  try {
    while (Date.now() < deadline) {
      if (NodeFS.existsSync(resultPath)) {
        const replied = db
          .prepare(
            `SELECT 1 FROM kin_messages WHERE chat_id = ? AND seq > ? AND (author_kind = 'agent' OR (? AND author_kind = 'system')) LIMIT 1`,
          )
          .get(chatId, seq, input.fail === true ? 1 : 0);
        if (replied !== undefined)
          return (JSON.parse(NodeFS.readFileSync(resultPath, "utf8")) as { results: [] }).results;
      }
      await sleep(250);
    }
  } finally {
    db.close();
  }
  throw new VerifyError(
    `${agent.name} did not finish the turn in ${(input.timeoutMs ?? 120_000) / 1000}s; check \`kin-verify db "select status from kin_wakeups order by started_at desc limit 3"\` and the log`,
  );
}

/** One line for a tool's answer: ok or refused, with its text. */
export function describeResult(result: { name: string; response?: unknown; error?: string }) {
  if (result.error !== undefined) return `${result.name}: failed: ${result.error}`;
  const response = result.response as {
    result?: {
      isError?: boolean;
      content?: ReadonlyArray<{ text?: string }>;
      structuredContent?: unknown;
    };
    error?: { code?: number; message?: string };
  };
  if (response?.error !== undefined)
    return `${result.name}: refused: ${response.error.message ?? JSON.stringify(response.error)}`;
  const text =
    response?.result?.content?.map((part) => part.text ?? "").join(" ") ??
    JSON.stringify(response?.result?.structuredContent ?? response);
  return `${result.name}: ${response?.result?.isError === true ? "error" : "ok"}: ${text.replace(/\s+/g, " ").slice(0, 600)}`;
}
