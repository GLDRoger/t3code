// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import type { KinAgentId, KinPresence, KinWakeupId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinMayStopAgent, kinWorkingLines } from "./kinLive.ts";

const START = Date.parse("2026-11-26T09:00:00.000Z");
const iso = (ms: number) => new Date(START + ms).toISOString();
const ada = "agent-ada" as KinAgentId;
const finance = "agent-finance" as KinAgentId;

const presence = (overrides: Partial<KinPresence> = {}): KinPresence => ({
  agentId: ada,
  wakeupId: "w1" as KinWakeupId,
  state: "thinking",
  label: "Thinking",
  startedAt: iso(0),
  since: iso(0),
  ...overrides,
});

const owner = kinMayStopAgent({
  canInterrupt: true,
  direct: true,
  ownedAgentId: ada,
  retired: false,
  ownerLevel: true,
});
const lines = (entries: ReadonlyArray<KinPresence>, mayStop = owner) =>
  kinWorkingLines(entries, START + 13_000, mayStop).map((row) => [
    row.presence.agentId,
    row.line.text,
    row.stop,
  ]);

describe("kinWorkingLines", () => {
  it.each([
    ["thinking", presence(), [[ada, "Thinking", "offer"]]],
    [
      "a tool's kind",
      presence({ state: "working", label: "Reading records" }),
      [[ada, "Reading records", "offer"]],
    ],
    [
      "writing a held reply",
      presence({ state: "writing", label: "Writing a reply" }),
      [[ada, "Writing a reply", "offer"]],
    ],
    [
      "catching up once its wake-up is claimed",
      presence({ state: "starting", label: "Catching up" }),
      [[ada, "Catching up", "offer"]],
    ],
    [
      "a queued message, before any wake-up",
      presence({ state: "starting", label: "Catching up", wakeupId: null }),
      [[ada, "Catching up", "none"]],
    ],
    [
      "stalled keeps its urgent Stop",
      presence({ state: "stalled", label: null }),
      [[ada, "No output for 2 min", "urgent"]],
    ],
    [
      "paused, which a Stop cannot end",
      presence({ state: "paused", label: null }),
      [[ada, "Paused", "none"]],
    ],
    ["stopped or ended: the line is gone", null, []],
  ] as const)("%s", (_name, entry, expected) => {
    expect(lines(entry === null ? [] : [entry])).toEqual(expected);
  });

  it("offers Stop only for the viewer's own lead in a direct chat", () => {
    const zoya = kinMayStopAgent({
      canInterrupt: true,
      direct: true,
      ownedAgentId: null,
      retired: false,
      ownerLevel: false,
    });
    const retired = kinMayStopAgent({
      canInterrupt: true,
      direct: true,
      ownedAgentId: ada,
      retired: true,
      ownerLevel: true,
    });
    expect(lines([presence()], zoya)).toEqual([[ada, "Thinking", "none"]]);
    expect(lines([presence()], retired)).toEqual([[ada, "Thinking", "none"]]);
  });

  it("gives each working agent in a group its own line and Stop, in start order", () => {
    const group = kinMayStopAgent({
      canInterrupt: true,
      direct: false,
      ownedAgentId: null,
      retired: false,
      ownerLevel: true,
    });
    const entries = [
      presence({ agentId: finance, wakeupId: "w2" as KinWakeupId, startedAt: iso(4_000) }),
      presence({ state: "working", label: "Making a doc" }),
    ];
    expect(lines(entries, group)).toEqual([
      [ada, "Making a doc", "offer"],
      [finance, "Thinking", "offer"],
    ]);
    const member = kinMayStopAgent({
      canInterrupt: true,
      direct: false,
      ownedAgentId: null,
      retired: false,
      ownerLevel: false,
    });
    expect(lines(entries, member).map((row) => row[2])).toEqual(["none", "none"]);
  });
});
