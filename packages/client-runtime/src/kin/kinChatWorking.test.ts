// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import type {
  KinAgentId,
  KinChatId,
  KinChatWorkingResult,
  KinMessage,
  KinPresence,
  KinWakeupId,
  KinWidget,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinChatWorkingItems,
  kinWorkingPillLabel,
  kinWorkingPillStop,
  kinWorkingRereadKey,
} from "./kinChatWorking.ts";

const START = Date.parse("2026-11-08T09:00:00.000Z");
const iso = (ms: number) => new Date(START + ms).toISOString();
const lead = "agent-lead" as KinAgentId;
const finance = "agent-finance" as KinAgentId;
const agentNames = new Map([
  [lead, "Chief of staff"],
  [finance, "Finance"],
]);

const presence = (overrides: Partial<KinPresence> = {}): KinPresence => ({
  agentId: lead,
  wakeupId: "w1" as KinWakeupId,
  state: "working",
  label: "Reading memory",
  startedAt: iso(0),
  since: iso(0),
  ...overrides,
});
const task = (id: string, status: string, closedAt: string | null = null) =>
  ({
    widgetId: id,
    messageId: `m-${id}`,
    type: "task",
    closedAt,
    state: {
      taskId: id,
      environmentId: "env",
      threadId: null,
      remoteEnvironmentId: null,
      title: "Draft the Ambermill invoice",
      model: "a-model",
      status,
      pullRequests: [],
      lastError: null,
      updatedAt: iso(0),
    },
  }) as unknown as KinWidget;
const handoff = (
  overrides: Partial<KinChatWorkingResult["handoffs"][number]> = {},
): KinChatWorkingResult["handoffs"][number] => ({
  agentId: finance,
  chatId: "chat-finance" as KinChatId,
  wakeupId: "w2" as KinWakeupId,
  state: "running",
  asked: "Chase the unpaid invoice",
  since: iso(5_000),
  ...overrides,
});

const items = (input: {
  presence?: ReadonlyArray<KinPresence>;
  widgets?: ReadonlyArray<KinWidget>;
  handoffs?: KinChatWorkingResult["handoffs"];
  messages?: ReadonlyArray<KinMessage>;
}) =>
  kinChatWorkingItems({
    presence: input.presence ?? [],
    widgets: input.widgets ?? [],
    messages: input.messages ?? [],
    handoffs: input.handoffs ?? [],
    agentNames,
    now: START + 180_000,
  });

describe("kinChatWorkingItems", () => {
  it("counts live turns, hand-offs and open working workers, nothing else", () => {
    expect(items({})).toEqual([]);
    expect(
      items({
        presence: [presence({ state: "seen" })],
        widgets: [task("a", "done"), task("b", "working", iso(1)), task("c", "waiting")],
      }),
    ).toEqual([]);
    const all = items({
      presence: [presence()],
      handoffs: [handoff()],
      widgets: [task("a", "working")],
      messages: [{ messageId: "m-a", createdAt: iso(2_000) } as KinMessage],
    });
    expect(all.map((item) => [item.kind, item.name, item.doing, item.since])).toEqual([
      ["agent", "Chief of staff", "Reading memory", iso(0)],
      ["handoff", "Finance", "Chase the unpaid invoice", iso(5_000)],
      ["worker", "Worker", "Draft the Ambermill invoice", iso(2_000)],
    ]);
    expect(all.map((item) => item.open)).toEqual([
      { kind: "end" },
      { kind: "chat", chatId: "chat-finance" },
      { kind: "message", messageId: "m-a" },
    ]);
  });

  it("marks held turns: paused, waiting for budget, silent, or a hand-off not started", () => {
    const held = items({
      presence: [presence({ state: "stalled", since: iso(0) })],
      handoffs: [handoff({ state: "queued", wakeupId: null, chatId: null })],
    });
    expect(held.map((item) => [item.state, item.held, item.open])).toEqual([
      ["No output for 3 min", true, { kind: "end" }],
      ["Waiting to start", true, null],
    ]);
    expect(items({ presence: [presence({ state: "deferred" })] })[0]?.state).toBe(
      "Waiting for budget",
    );
  });
});

describe("kinWorkingPillLabel", () => {
  it.each([
    [[], null],
    [[presence()], "Chief of staff is working"],
    [[presence({ state: "starting" })], "Chief of staff is starting"],
    [[presence({ state: "paused" })], "Chief of staff is paused"],
    [[presence({ state: "stalled" })], "Chief of staff: no output for 3 min"],
    [[presence({ agentId: "agent-gone" as KinAgentId })], "An agent is working"],
  ] as const)("one agent", (turns, label) => {
    expect(kinWorkingPillLabel(items({ presence: turns }))).toBe(label);
  });

  it("names one hand-off, counts workers, and names the first agent of many", () => {
    expect(kinWorkingPillLabel(items({ handoffs: [handoff()] }))).toBe("Finance is working");
    expect(
      kinWorkingPillLabel(items({ handoffs: [handoff({ state: "queued", wakeupId: null })] })),
    ).toBe("Waiting on Finance");
    expect(kinWorkingPillLabel(items({ widgets: [task("a", "working")] }))).toBe(
      "Waiting on a worker",
    );
    expect(
      kinWorkingPillLabel(items({ widgets: [task("a", "working"), task("b", "working")] })),
    ).toBe("Waiting on 2 workers");
    expect(
      kinWorkingPillLabel(items({ widgets: [task("a", "working")], handoffs: [handoff()] })),
    ).toBe("Finance and 1 more are working");
    expect(
      kinWorkingPillLabel(
        items({ presence: [presence()], handoffs: [handoff()], widgets: [task("a", "working")] }),
      ),
    ).toBe("Chief of staff and 2 more are working");
  });
});

describe("kinWorkingPillStop", () => {
  it("offers Stop only for one stoppable item, and only to someone the host lets interrupt", () => {
    const one = items({ presence: [presence()] });
    expect(kinWorkingPillStop(one, true)?.wakeupId).toBe("w1");
    expect(kinWorkingPillStop(one, false)).toBeNull();
    expect(kinWorkingPillStop(items({ widgets: [task("a", "working")] }), true)).toBeNull();
    expect(
      kinWorkingPillStop(items({ handoffs: [handoff({ state: "queued", wakeupId: null })] }), true),
    ).toBeNull();
    expect(kinWorkingPillStop(items({ presence: [presence()], handoffs: [handoff()] }), true)).toBe(
      null,
    );
  });
});

describe("kinWorkingRereadKey", () => {
  it("moves when a turn here starts or ends, or another chat starts or stops working", () => {
    const base = kinWorkingRereadKey({ presence: [presence()], workingChats: ["b", "a"] });
    expect(kinWorkingRereadKey({ presence: [presence()], workingChats: ["a", "b"] })).toBe(base);
    expect(kinWorkingRereadKey({ presence: [], workingChats: ["a", "b"] })).not.toBe(base);
    expect(kinWorkingRereadKey({ presence: [presence()], workingChats: ["a"] })).not.toBe(base);
  });
});
