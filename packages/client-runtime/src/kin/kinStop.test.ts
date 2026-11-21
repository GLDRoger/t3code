import { KinOrgId, KinPersonId, type KinOrgState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { KIN_STOP, kinStopChatLine, kinStopNotice, kinStopReason, kinStopRow } from "./kinStop.ts";

const orgId = KinOrgId.make("ambermill");
const running: KinOrgState = {
  orgId,
  paused: false,
  pausedAt: null,
  pausedBy: null,
  reason: null,
};
const stopped = (reason: string | null): Extract<KinOrgState, { paused: true }> => ({
  orgId,
  paused: true,
  pausedAt: DateTime.makeUnsafe("2026-11-20T08:30:00.000Z"),
  pausedBy: KinPersonId.make("rhea"),
  reason,
});
const names: Readonly<Record<string, string>> = { rhea: "Rhea" };
const row = (
  state: KinOrgState,
  options: Partial<Pick<Parameters<typeof kinStopRow>[0], "canAct" | "busy" | "problem">> = {},
) => {
  const view = kinStopRow({
    read: { _tag: "ready", value: state, stale: false },
    canAct: true,
    busy: null,
    problem: null,
    nameOf: (personId) => names[personId] ?? null,
    // Fixed, so the words are the same in every device zone.
    timeZone: "Asia/Kolkata",
    ...options,
  });
  if (view._tag !== "running" && view._tag !== "stopped") throw new Error(view._tag);
  return view;
};

describe("the company stop switch", () => {
  it("says agents are working and offers Stop all agents to an owner", () => {
    expect(row(running)).toEqual({
      _tag: "running",
      lines: ["Agents are working."],
      reason: null,
      action: { kind: "stop", label: "Stop all agents", busy: false },
      problem: null,
    });
    expect(row(running, { busy: "stop" })).toMatchObject({
      action: { kind: "stop", label: "Stopping…", busy: true },
    });
    expect(row(running, { problem: "This device isn't allowed to change this." }).problem).toBe(
      "This device isn't allowed to change this.",
    );
  });

  it("says who stopped it, when, and why, and offers Resume", () => {
    expect(row(stopped("Checking a wrong invoice "))).toEqual({
      _tag: "stopped",
      lines: ["All agents are stopped.", "Stopped by Rhea, Fri, Nov 20, 2:00 PM."],
      reason: "Reason: Checking a wrong invoice",
      action: { kind: "resume", label: "Resume", busy: false },
      problem: null,
    });
    expect(row(stopped(null), { busy: "resume" })).toMatchObject({
      reason: null,
      action: { kind: "resume", label: "Resuming…", busy: true },
    });
    // Someone no longer in the company's list: the time still shows, without a name.
    const unnamed: KinOrgState = { ...stopped(""), pausedBy: KinPersonId.make("gone") };
    expect(row(unnamed).lines[1]).toBe("Stopped Fri, Nov 20, 2:00 PM.");
  });

  it("shows a teammate the state with no action", () => {
    expect(row(running, { canAct: false }).action).toBeNull();
    expect(row(stopped("Audit"), { canAct: false }).action).toBeNull();
  });

  it("says when it is loading or could not be read, with Try again", () => {
    const base = { canAct: true, busy: null, problem: null, nameOf: () => null };
    expect(kinStopRow({ ...base, read: { _tag: "loading" } })).toEqual({
      _tag: "loading",
      detail: "Checking whether agents are working…",
    });
    expect(kinStopRow({ ...base, read: { _tag: "failed", cause: null } })).toEqual({
      _tag: "failed",
      detail:
        "Couldn't check whether agents are working. Check your connection to the server and try again.",
      retry: "Try again",
    });
  });

  it("sends a reason only when one was typed", () => {
    expect(kinStopReason("  ")).toEqual({});
    expect(kinStopReason(" Audit ")).toEqual({ reason: "Audit" });
    expect(kinStopReason("x".repeat(300)).reason).toHaveLength(200);
  });

  it("tells everyone in a chat that agents are stopped, and owners where to resume", () => {
    expect(kinStopChatLine(running, true)).toBeNull();
    expect(kinStopChatLine(null, false)).toBeNull();
    expect(kinStopChatLine(stopped(null), true)).toBe(KIN_STOP.chat.owner);
    expect(kinStopChatLine(stopped(null), false)).toBe(
      "All agents are stopped. Messages wait until an owner resumes them.",
    );
    // A group's line about a retired agent stays, after the stop line.
    expect(kinStopNotice(KIN_STOP.chat.member, "Finance was retired.")).toBe(
      "All agents are stopped. Messages wait until an owner resumes them. Finance was retired.",
    );
    expect(kinStopNotice(null, "Finance was retired.")).toBe("Finance was retired.");
  });
});
