import { describe, expect, it } from "vite-plus/test";

import { kinPhoneHome, kinSwitcherDot } from "./kinListSwitch.ts";

describe("kinPhoneHome", () => {
  it.each([
    { kinOnly: false, shell: "loading", host: "host", savedHost: true, expected: "loading" },
    // A phone with a Kin host opens Kin, whatever list it showed last.
    { kinOnly: false, shell: "coding", host: "host", savedHost: true, expected: "kin" },
    { kinOnly: false, shell: "coding", host: "searching", savedHost: true, expected: "kin" },
    { kinOnly: false, shell: "coding", host: "searching", savedHost: null, expected: "loading" },
    // A phone that never reached a Kin host, or whose host turned Kin off, is T3 as it was.
    { kinOnly: false, shell: "coding", host: "searching", savedHost: false, expected: "coding" },
    { kinOnly: false, shell: "coding", host: "none", savedHost: true, expected: "coding" },
    { kinOnly: false, shell: "coding", host: "none", savedHost: false, expected: "coding" },
    { kinOnly: false, shell: "chatOnly", host: "none", savedHost: false, expected: "kin" },
    { kinOnly: true, shell: "coding", host: "none", savedHost: false, expected: "kin" },
  ] as const)("$shell, host $host, saved $savedHost, Kin-only $kinOnly: $expected", (row) => {
    expect(kinPhoneHome(row)).toBe(row.expected);
  });
});

describe("kinSwitcherDot", () => {
  it.each([
    { kin: { waiting: false, unread: false }, expected: null },
    { kin: { waiting: false, unread: true }, expected: "unread" },
    { kin: { waiting: true, unread: true }, expected: "waiting" },
  ] as const)("Kin $kin shows $expected", (row) => {
    expect(kinSwitcherDot(row.kin)).toBe(row.expected);
  });
});
