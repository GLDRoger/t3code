// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - kin-bench's prompt capture, no model.
/**
 * Every turn kind an agent gets, triggered for real on the bench seed with the scripted agent,
 * which keeps each prompt it is sent (`capture-prompts`). Nothing calls a model.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { agentOf, directChat, rpcAs, runTurn } from "../kin-verify/actors.ts";
import { type Instance, ORG, ROOT, readSeed, sleep } from "../kin-verify/instance.ts";
import { mailDeliver } from "../kin-verify/ops.ts";
import { BENCH, quiet } from "../kin-verify/benchSeed.ts";
import { type PromptSection, type PromptTurn, tokensOf } from "./stats.ts";

interface Captured {
  readonly file: string;
  readonly prompt: string;
  readonly tools?: { result?: { tools?: ReadonlyArray<Record<string, unknown>> } };
}

const promptsDir = (instance: Instance) => NodePath.join(instance.meta, "prompts");

function capturedSince(instance: Instance, seen: ReadonlySet<string>): Array<Captured> {
  const dir = promptsDir(instance);
  if (!NodeFS.existsSync(dir)) return [];
  return NodeFS.readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !seen.has(file))
    .sort()
    .map((file) => ({
      file,
      ...(JSON.parse(NodeFS.readFileSync(NodePath.join(dir, file), "utf8")) as Omit<
        Captured,
        "file"
      >),
    }));
}

/** The Kin part of what the provider gets; the ACP wrapper around it is T3's, not Kin's. */
const kinPart = (prompt: string) => {
  const match = /<user_request>\n?([\s\S]*?)\n?<\/user_request>/.exec(prompt);
  return match?.[1] ?? prompt;
};

const agentName = (prompt: string) => /^Agent name: "([^"]+)"/m.exec(prompt)?.[1] ?? "?";

/** Splits on `# ` headings and the turn divider; the lines right under the divider are the header. */
export function sectionsOf(text: string): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  let name = "(preamble)";
  let lines: Array<string> = [];
  const flush = () => {
    if (lines.join("\n").trim() !== "") out.push({ name, text: lines.join("\n") });
  };
  for (const line of text.split("\n")) {
    if (line === "--- THIS TURN ---") {
      flush();
      name = "Turn header (who, when, connections)";
      lines = [line];
      continue;
    }
    const heading = /^# (.+?)(?: \(.*\))?$/.exec(line);
    if (heading !== null) {
      flush();
      name = heading[1]!;
      lines = [line];
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

const commonPrefix = (a: string, b: string) => {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
};

interface Trigger {
  readonly kind: string;
  readonly agent: string;
  /** Runs the trigger; the captured prompt is the first new one `match` accepts. */
  readonly run: () => Promise<void>;
  readonly match: (prompt: string) => boolean;
  readonly timeoutMs?: number;
  readonly skip?: string;
}

/** A whole turn, not a message steered into one already running. */
const full = (prompt: string) => kinPart(prompt).includes("--- THIS TURN ---");

async function say(
  instance: Instance,
  person: string,
  chatId: string,
  body: string,
  mention?: string,
) {
  const rpc = await rpcAs(instance, person);
  try {
    await rpc.call("kin.messages.send", {
      chatId,
      clientMessageId: `kin-bench-prompt-${Date.now()}-${person}`,
      body,
      ...(mention === undefined ? {} : { mentions: [mention] }),
    });
  } finally {
    rpc.close();
  }
}

async function chiefChat(instance: Instance, person: string) {
  const rpc = await rpcAs(instance, person);
  try {
    return await directChat(rpc, agentOf(instance, "chief").agentId);
  } finally {
    rpc.close();
  }
}

async function runCheckIn(instance: Instance, scheduleId: string) {
  const rpc = await rpcAs(instance, "owner");
  try {
    await rpc.call("kin.checkIns.act", { orgId: ORG, scheduleId, action: "run_now" });
  } finally {
    rpc.close();
  }
}

/** Finds the bench group and puts the Chief of staff in it for one mention, then takes it out. */
async function groupTurn(instance: Instance, text: string) {
  const owner = await rpcAs(instance, "owner");
  try {
    const [first] = (await owner.call("kin.chats.subscribe", { orgId: ORG })) as Array<{
      chats: ReadonlyArray<{ chatId: string; title?: string | null }>;
    }>;
    const group = first?.chats.find((chat) => chat.title === BENCH.group);
    if (group === undefined) throw new Error("no bench group");
    const member = (await owner.call("kin.groups.addMember", {
      chatId: group.chatId,
      principal: { _tag: "agent", agentId: agentOf(instance, "chief").agentId },
    })) as { memberId: string };
    await owner.call("kin.messages.send", {
      chatId: group.chatId,
      clientMessageId: `kin-bench-group-${Date.now()}`,
      body: text,
      mentions: [member.memberId],
    });
    return async () => {
      const again = await rpcAs(instance, "owner");
      try {
        await again.call("kin.groups.removeMember", {
          chatId: group.chatId,
          memberId: member.memberId,
        });
      } finally {
        again.close();
      }
    };
  } finally {
    owner.close();
  }
}

export async function capturePrompts(
  instance: Instance,
  log: (line: string) => void,
): Promise<{
  turns: Array<PromptTurn>;
  tools: Array<{ name: string; tokens: number }>;
  toolListBytes: { modelFacing: number; withOutputSchemas: number };
  systemTokens: number;
}> {
  const flag = NodePath.join(instance.meta, "capture-prompts");
  NodeFS.writeFileSync(flag, "");
  const seen = new Set(capturedSince(instance, new Set()).map((one) => one.file));
  const seed = readSeed(instance)!;
  let undoGroup: (() => Promise<void>) | undefined;
  const triggers: Array<Trigger> = [
    {
      kind: "Owner chat message",
      agent: "chief",
      run: async () =>
        say(
          instance,
          "owner",
          await chiefChat(instance, "owner"),
          "bench-owner-1: what's due this week for Lumen Grove?",
        ),
      match: (prompt) => prompt.includes("bench-owner-1") && full(prompt),
    },
    {
      kind: "Owner chat message (next turn)",
      agent: "chief",
      run: async () =>
        say(
          instance,
          "owner",
          await chiefChat(instance, "owner"),
          "bench-owner-2: and who is on the booking API?",
        ),
      match: (prompt) => prompt.includes("bench-owner-2") && full(prompt),
    },
    {
      kind: "Teammate's message",
      agent: "chief",
      run: async () =>
        say(
          instance,
          "zoya",
          await chiefChat(instance, "zoya"),
          "bench-teammate: can I move the booking flow screens to next week?",
        ),
      match: (prompt) => prompt.includes("bench-teammate") && full(prompt),
    },
    {
      kind: "Group chat",
      agent: "chief",
      run: async () => {
        undoGroup = await groupTurn(instance, "bench-group: what is slipping this week?");
      },
      match: (prompt) => prompt.includes("bench-group") && full(prompt),
    },
    {
      kind: "Check-in",
      agent: "chief",
      run: () => runCheckIn(instance, "checkin-morning"),
      match: (prompt) => prompt.includes('"scheduleId":"checkin-morning"'),
    },
    {
      kind: "Weekly brief",
      agent: "chief",
      run: () => runCheckIn(instance, "checkin-weekly"),
      match: (prompt) => prompt.includes('"scheduleId":"checkin-weekly"'),
    },
    {
      kind: "Hand-over",
      agent: "finance",
      run: async () => {
        await runTurn(instance, {
          agent: "chief",
          person: "owner",
          calls: [
            {
              name: "kin_hand_off",
              arguments: {
                to: "Finance",
                request: "bench-handover: chase the Orbit Dental retainer invoice.",
              },
            },
          ],
          reply: "Passed to Finance.",
        });
      },
      match: (prompt) =>
        agentName(kinPart(prompt)) === "Finance" && prompt.includes("bench-handover"),
    },
    {
      kind: "Worker report",
      agent: "chief",
      // Workers here take only build tasks and PR reviews on a real repository (Workers.ts).
      skip: "workers on this host only take build tasks and pull-request reviews on a real repository, which a no-model run can't give them",
      run: async () => undefined,
      match: () => false,
    },
    {
      kind: "Outside-mail wake",
      agent: "finance",
      run: async () => {
        mailDeliver(instance, [
          "--to",
          "accounts@ambermill.example",
          "--from",
          "Anita <anita@orbitdental.example>",
          "--subject",
          "bench-mail: Re: INV-1 retainer",
          "--body",
          "We paid the retainer today, please confirm.",
        ]);
      },
      // The outside poll runs every 3 minutes and wakes only on a line naming a client or open invoice.
      match: (prompt) =>
        prompt.includes("bench-mail") && !prompt.includes('"checkIn"') && full(prompt),
      timeoutMs: 240_000,
    },
  ];
  const results: Array<{ trigger: Trigger; captured?: Captured; why?: string }> = [];
  for (const trigger of triggers) {
    if (trigger.skip !== undefined) {
      results.push({ trigger, why: trigger.skip });
      continue;
    }
    log(`prompts: ${trigger.kind}`);
    await quiet(instance);
    try {
      await trigger.run();
    } catch (error) {
      results.push({ trigger, why: `trigger failed: ${(error as Error).message.split("\n")[0]}` });
      continue;
    }
    let found: Captured | undefined;
    for (
      let waited = 0;
      waited < (trigger.timeoutMs ?? 60_000) && found === undefined;
      waited += 500
    ) {
      for (const one of capturedSince(instance, seen)) {
        seen.add(one.file);
        if (found === undefined && trigger.match(one.prompt)) found = one;
      }
      if (found === undefined) await sleep(500);
    }
    if (undoGroup !== undefined) {
      await undoGroup().catch(() => undefined);
      undoGroup = undefined;
    }
    results.push(
      found === undefined
        ? { trigger, why: "no turn of this kind reached the agent in time" }
        : { trigger, captured: found },
    );
  }
  NodeFS.rmSync(flag, { force: true });

  // The Claude lead's system prompt is Kin's instructions alone (LeadIsolation.ts).
  const instructions = NodeFS.readFileSync(
    NodePath.join(ROOT, "apps/server/src/kin/lead/instructions.ts"),
    "utf8",
  );
  const systemText = /export const instructions = `([\s\S]*?)`;/.exec(instructions)?.[1] ?? "";
  const systemTokens = tokensOf(systemText);
  const anyTools =
    results.find((one) => one.captured?.tools?.result?.tools !== undefined)?.captured?.tools?.result
      ?.tools ?? [];
  const facing = (tool: Record<string, unknown>) =>
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  const tools = anyTools
    .map((tool) => ({ name: String(tool.name), tokens: tokensOf(facing(tool)) }))
    .sort((a, b) => b.tokens - a.tokens);
  const toolListBytes = {
    modelFacing: anyTools.reduce((sum, tool) => sum + Buffer.byteLength(facing(tool)), 0),
    withOutputSchemas: Buffer.byteLength(JSON.stringify(anyTools)),
  };

  // A section is stable when its text is the same in every captured turn of the same agent.
  const captured = results.flatMap((one) =>
    one.captured === undefined ? [] : [kinPart(one.captured.prompt)],
  );
  const sameAgent = (text: string) =>
    captured.filter((other) => other !== text && agentName(other) === agentName(text));
  const turns: Array<PromptTurn> = results.map(({ trigger, captured, why }) => {
    if (captured === undefined)
      return {
        kind: trigger.kind,
        agent: seed.agents[trigger.agent]?.name ?? trigger.agent,
        reached: false,
        why: why ?? "not reached",
        sections: [],
        turnTokens: 0,
        systemTokens,
        toolTokens: 0,
        toolCount: 0,
        totalTokens: 0,
        cacheableShare: 0,
      };
    const text = kinPart(captured.prompt);
    const siblings = sameAgent(text).map(sectionsOf);
    const sections: Array<PromptSection> = sectionsOf(text).map((section) => ({
      name: section.name,
      chars: section.text.length,
      tokens: tokensOf(section.text),
      stable:
        siblings.length > 0 &&
        siblings.every((other) =>
          other.some((one) => one.name === section.name && one.text === section.text),
        ),
    }));
    const listed = captured.tools?.result?.tools ?? [];
    const deferred = (tool: Record<string, unknown>) =>
      (tool._meta as Record<string, unknown> | undefined)?.["anthropic/alwaysLoad"] === false;
    const own = listed.filter((tool) => !deferred(tool));
    const toolTokens = own.reduce((sum, tool) => sum + tokensOf(facing(tool)), 0);
    const turnTokens = tokensOf(text);
    // Caching is by prefix: the longest start this prompt shares with another of the same agent.
    const prefix = tokensOf(
      text.slice(0, Math.max(0, ...sameAgent(text).map((other) => commonPrefix(text, other)))),
    );
    const total = systemTokens + toolTokens + turnTokens;
    return {
      kind: trigger.kind,
      agent: agentName(text),
      reached: true,
      sections,
      turnTokens,
      systemTokens,
      toolTokens,
      toolCount: own.length,
      deferredCount: listed.length - own.length,
      totalTokens: total,
      cacheableShare: total === 0 ? 0 : (systemTokens + toolTokens + prefix) / total,
    };
  });
  return { turns, tools, toolListBytes, systemTokens };
}
