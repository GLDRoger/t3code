import { describe, expect, it } from "vite-plus/test";

import { kinStartListFor, kinSwitcherDot } from "./kinListSwitch.ts";

describe("kinStartListFor", () => {
  it.each([
    { setting: "lastUsed", lastUsed: null, kinSeen: true, expected: "threads" },
    { setting: "lastUsed", lastUsed: "kin", kinSeen: true, expected: "kin" },
    { setting: "lastUsed", lastUsed: "threads", kinSeen: true, expected: "threads" },
    { setting: "kin", lastUsed: "threads", kinSeen: true, expected: "kin" },
    { setting: "threads", lastUsed: "kin", kinSeen: true, expected: "threads" },
    // A client that never reached a Kin host stays on threads whatever was saved.
    { setting: "kin", lastUsed: "kin", kinSeen: false, expected: "threads" },
    { setting: "lastUsed", lastUsed: "kin", kinSeen: false, expected: "threads" },
  ] as const)("$setting, last $lastUsed, seen $kinSeen opens $expected", (row) => {
    expect(kinStartListFor(row)).toBe(row.expected);
  });
});

describe("kinSwitcherDot", () => {
  const none = { waiting: false, unread: false };
  it.each([
    {
      current: "threads",
      kin: { waiting: false, unread: true },
      threads: none,
      expected: "unread",
    },
    {
      current: "threads",
      kin: { waiting: true, unread: true },
      threads: none,
      expected: "waiting",
    },
    // Your own list never lights the dot.
    { current: "kin", kin: { waiting: true, unread: true }, threads: none, expected: null },
    { current: "kin", kin: none, threads: { waiting: true, unread: false }, expected: "waiting" },
  ] as const)("in $current shows $expected", (row) => {
    expect(kinSwitcherDot(row)).toBe(row.expected);
  });
});
