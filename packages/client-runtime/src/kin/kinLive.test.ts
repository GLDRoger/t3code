// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import type { KinAgentId, KinPresence, KinWakeupId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  KIN_LABEL_HOLD_MS,
  applyKinPresence,
  createKinLabelHold,
  kinMayStopAgent,
  kinWorkingLines,
} from "./kinLive.ts";

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

describe("kinWorkingLines label hold", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const group = kinMayStopAgent({
    canInterrupt: true,
    direct: false,
    ownedAgentId: null,
    retired: false,
    ownerLevel: true,
  });

  const heldTexts = (
    entries: ReadonlyArray<KinPresence>,
    hold: ReturnType<typeof createKinLabelHold>,
    mayStop = owner,
  ) =>
    kinWorkingLines(entries, START + 13_000, mayStop, hold.snapshot()).map((row) => [
      row.presence.agentId,
      row.line.text,
      row.stop,
    ]);

  it("holds a non-Thinking label for 1.5 s before a following Thinking replaces it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const hold = createKinLabelHold();
    const expired = vi.fn();
    hold.subscribe(expired);

    const reading = [presence({ state: "working", label: "Reading records", since: iso(0) })];
    hold.sync(reading);
    expect(heldTexts(reading, hold)).toEqual([[ada, "Reading records", "offer"]]);

    vi.advanceTimersByTime(200);
    const thinking = [presence({ state: "thinking", label: "Thinking", since: iso(200) })];
    hold.sync(thinking);
    expect(heldTexts(thinking, hold)).toEqual([[ada, "Reading records", "offer"]]);

    vi.advanceTimersByTime(KIN_LABEL_HOLD_MS - 201);
    expect(heldTexts(thinking, hold)).toEqual([[ada, "Reading records", "offer"]]);
    expect(expired).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(heldTexts(thinking, hold)).toEqual([[ada, "Thinking", "offer"]]);
    hold.dispose();
  });

  it("catches a fast tool-to-Thinking burst via applyKinPresence before sync runs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const hold = createKinLabelHold();
    const expired = vi.fn();
    hold.subscribe(expired);

    let live = applyKinPresence([], {
      _tag: "presence",
      agentId: ada,
      presence: presence({ state: "working", label: "Reading records", since: iso(0) }),
    });
    vi.advanceTimersByTime(10);
    live = applyKinPresence(live, {
      _tag: "presence",
      agentId: ada,
      presence: presence({ state: "thinking", label: "Thinking", since: iso(10) }),
    });

    // Even before hold.sync runs, the carried hold keeps the tool label visible.
    expect(heldTexts(live, hold)).toEqual([[ada, "Reading records", "offer"]]);
    hold.sync(live);
    vi.advanceTimersByTime(KIN_LABEL_HOLD_MS - 11);
    expect(heldTexts(live, hold)).toEqual([[ada, "Reading records", "offer"]]);
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(heldTexts(live, hold)).toEqual([[ada, "Thinking", "offer"]]);
    hold.dispose();
  });

  it("replaces a held label immediately on a new non-Thinking label and clears immediately on end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const hold = createKinLabelHold();
    const expired = vi.fn();
    hold.subscribe(expired);

    const reading = [presence({ state: "working", label: "Reading records", since: iso(0) })];
    hold.sync(reading);
    vi.advanceTimersByTime(200);
    const thinking = [presence({ state: "thinking", label: "Thinking", since: iso(200) })];
    hold.sync(thinking);
    expect(heldTexts(thinking, hold)).toEqual([[ada, "Reading records", "offer"]]);

    // A new non-Thinking label replaces at once and cancels the earlier timer.
    vi.advanceTimersByTime(300);
    const doc = [presence({ state: "working", label: "Making a doc", since: iso(500) })];
    expect(heldTexts(doc, hold)).toEqual([[ada, "Making a doc", "offer"]]);
    hold.sync(doc);
    vi.advanceTimersByTime(1_000);
    expect(expired).toHaveBeenCalledTimes(0);

    // Run ends or is stopped: clears at once, no pending timer fires later.
    expect(heldTexts([], hold)).toEqual([]);
    hold.sync([]);
    vi.advanceTimersByTime(KIN_LABEL_HOLD_MS * 2);
    expect(expired).toHaveBeenCalledTimes(0);
    hold.dispose();
  });

  it("does not notify when a tool stays active past 1.5 s, and keeps lines independent per agent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    const hold = createKinLabelHold();
    const expired = vi.fn();
    hold.subscribe(expired);

    const longTool = [presence({ state: "working", label: "Reading a web page", since: iso(0) })];
    hold.sync(longTool);
    vi.advanceTimersByTime(KIN_LABEL_HOLD_MS + 500);
    expect(expired).toHaveBeenCalledTimes(0);
    const afterLong = [presence({ state: "thinking", label: "Thinking", since: iso(2_000) })];
    hold.sync(afterLong);
    expect(heldTexts(afterLong, hold)).toEqual([[ada, "Thinking", "offer"]]);

    // Independent per-agent holds in a group; new wakeupId never inherits an older run's hold.
    const t0 = 3_000;
    vi.setSystemTime(START + t0);
    const both = [
      presence({
        agentId: ada,
        wakeupId: "w2" as KinWakeupId,
        state: "working",
        label: "Reading records",
        startedAt: iso(t0),
        since: iso(t0),
      }),
      presence({
        agentId: finance,
        wakeupId: "w3" as KinWakeupId,
        state: "working",
        label: "Checking the money",
        startedAt: iso(t0 + 100),
        since: iso(t0 + 100),
      }),
    ];
    hold.sync(both);
    vi.advanceTimersByTime(400);
    const bothThinking = [
      presence({
        agentId: ada,
        wakeupId: "w2" as KinWakeupId,
        state: "thinking",
        label: "Thinking",
        startedAt: iso(t0),
        since: iso(t0 + 400),
      }),
      presence({
        agentId: finance,
        wakeupId: "w4" as KinWakeupId,
        state: "thinking",
        label: "Thinking",
        startedAt: iso(t0 + 400),
        since: iso(t0 + 400),
      }),
    ];
    hold.sync(bothThinking);
    expect(heldTexts(bothThinking, hold, group)).toEqual([
      [ada, "Reading records", "offer"],
      [finance, "Thinking", "offer"],
    ]);
    vi.advanceTimersByTime(KIN_LABEL_HOLD_MS);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(heldTexts(bothThinking, hold, group)).toEqual([
      [ada, "Thinking", "offer"],
      [finance, "Thinking", "offer"],
    ]);
    hold.dispose();
  });
});
