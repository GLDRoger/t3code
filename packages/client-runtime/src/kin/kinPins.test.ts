import { describe, expect, it } from "@effect/vitest";
import { KinChatPinId, type KinChatPin } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { kinNextDayStart, kinPinView } from "./kinPins.ts";

const names = { zone: "Asia/Kolkata", readerZone: "America/Los_Angeles" };
const at = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
const now = at("2026-11-27T02:00:00.000Z");
const meta = {
  pinId: KinChatPinId.make("kin-chat-pin-89fc7a33"),
  pinnedBy: "Rhea",
  pinnedAt: "2026-11-20T00:00:00.000Z",
};
const task = {
  ...meta,
  _tag: "task",
  key: "W-142",
  title: "Check the cold room",
  state: "open",
  dueAt: "2026-11-27T15:00:00.000Z",
  dueAllDay: true,
  late: false,
} satisfies KinChatPin;
const project = {
  ...meta,
  _tag: "project",
  key: "P-73",
  name: "Tidewater Freight",
  state: "doing",
  targetAt: "2026-12-27T15:00:00.000Z",
  targetAllDay: true,
  done: 7,
  total: 12,
  late: 2,
} satisfies KinChatPin;
const goal = {
  ...meta,
  _tag: "goal",
  key: "G-22",
  title: "Juniper Cold Chain hires",
  state: "open",
  measure: "manual",
  unit: "hires",
  current: 62,
  target: 100,
  dueOn: null,
  behind: true,
} satisfies KinChatPin;

describe("pinned cards", () => {
  it.each([
    ["all-day", true, "Due today"],
    ["timed", false, "Due tomorrow"],
  ] as const)("counts a %s date in the same zone as Work", (_name, dueAllDay, line) => {
    expect(kinPinView({ ...task, dueAllDay }, now, names).line).toBe(line);
  });

  const { unit: _unit, ...unitlessGoal } = goal;
  it.each([
    ["task date", task, "Check the cold room", "Due today", "normal", "task"],
    [
      "later task",
      { ...task, dueAt: "2026-12-09T15:00:00.000Z" },
      "Check the cold room",
      "Due in 12 days",
      "normal",
      "task",
    ],
    [
      "late task",
      { ...task, dueAt: "2026-11-24T15:00:00.000Z", late: true },
      "Check the cold room",
      "3 days late",
      "late",
      "task",
    ],
    [
      "task without date",
      { ...task, dueAt: null },
      "Check the cold room",
      "Open",
      "normal",
      "task",
    ],
    [
      "waiting",
      { ...task, state: "waiting", dueAt: null },
      "Check the cold room",
      "Waiting",
      "normal",
      "task",
    ],
    [
      "doing",
      { ...task, state: "doing", dueAt: null },
      "Check the cold room",
      "In progress",
      "normal",
      "task",
    ],
    [
      "steps",
      { ...task, steps: { done: 2, total: 5 }, dueAt: "2026-12-04T15:00:00.000Z" },
      "Check the cold room",
      "2 of 5 steps · due Fri",
      "normal",
      "task",
    ],
    ["done", { ...task, state: "done" }, "Check the cold room", "Done", "muted", "task"],
    ["dropped", { ...task, state: "dropped" }, "Check the cold room", "Dropped", "muted", "task"],
    [
      "project",
      project,
      "Tidewater Freight",
      "7 of 12 done · 2 late · ends in 30 days",
      "late",
      "project",
    ],
    [
      "project without date",
      { ...project, targetAt: null, late: 0 },
      "Tidewater Freight",
      "7 of 12 done",
      "normal",
      "project",
    ],
    ["goal", goal, "Juniper Cold Chain hires", "62 of 100 hires · behind", "late", "goal"],
    [
      "goal without unit",
      { ...unitlessGoal, behind: false },
      "Juniper Cold Chain hires",
      "62 of 100",
      "normal",
      "goal",
    ],
    ["gone", { ...meta, _tag: "gone" }, "No longer in Kin", null, "muted", null],
    ["hidden", { _tag: "hidden", pinId: meta.pinId }, "A pin you can't open", null, "muted", null],
  ] as const)("presents %s", (_name, pin, title, line, tone, kind) => {
    expect(kinPinView(pin, now, names)).toEqual({
      title,
      line,
      tone,
      opens: kind === null || !("key" in pin) ? null : { kind, key: pin.key },
    });
  });

  it.each([
    ["2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"],
    ["2026-11-01T07:00:00.000Z", "2026-11-02T08:00:00.000Z"],
  ])("finds the next Los Angeles day start across DST from %s", (start, next) => {
    expect(kinNextDayStart(at(start), ["America/Los_Angeles"])).toEqual(at(next));
  });

  it("uses the earliest of the company's and reader's next day starts", () => {
    expect(kinNextDayStart(now, [names.readerZone, names.zone])).toEqual(
      at("2026-11-27T08:00:00.000Z"),
    );
    expect(kinNextDayStart(now, [])).toBeNull();
  });
});
