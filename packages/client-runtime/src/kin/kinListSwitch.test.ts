import { describe, expect, it } from "vite-plus/test";

import { installForPhoneHome, kinPhoneHome, kinSwitcherDot } from "./kinListSwitch.ts";

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

describe("installForPhoneHome", () => {
  it.each([
    // Launcher shortcuts and shares start coding threads: off where Kin is Home.
    { homes: ["loading", "kin"], log: ["kin on"] },
    { homes: ["loading", "coding", "coding"], log: ["coding on"] },
    // A host turning Kin on or off swaps them, each once.
    {
      homes: ["coding", "kin", "loading", "kin", "coding"],
      log: ["coding on", "coding off", "kin on", "kin off", "coding on"],
    },
    { homes: ["loading"], log: [] },
  ] as const)("Home $homes runs $log", (row) => {
    const log: Array<string> = [];
    let push: (home: (typeof row.homes)[number]) => void = () => {};
    const install = (name: string) => () => {
      log.push(`${name} on`);
      return () => log.push(`${name} off`);
    };
    const stop = installForPhoneHome(
      (onHome) => {
        push = onHome;
        return () => log.push("unsubscribed");
      },
      { kin: install("kin"), coding: install("coding") },
    );
    for (const home of row.homes) push(home);
    expect(log).toEqual(row.log);
    stop();
    expect(log.slice(row.log.length)).toEqual(
      row.log.length === 0 ? ["unsubscribed"] : ["unsubscribed", `${row.homes.at(-1)} off`],
    );
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
