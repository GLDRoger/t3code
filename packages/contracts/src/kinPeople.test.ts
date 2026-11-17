import { describe, expect, it } from "vite-plus/test";

import { kinIsLocalOnlyHost } from "./kinPeople.ts";

// The CLI took 127.0.0.2 as reachable and the apps didn't, so the invite warning differed.
describe("an invite link's host", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST.", true],
    ["kin.localhost", true],
    ["127.0.0.1", true],
    ["127.0.0.2", true],
    ["127.255.255.254", true],
    ["0.0.0.0", true],
    ["[::1]", true],
    ["[::]", true],
    ["[::ffff:127.0.0.1]", true],
    ["[::ffff:7f00:1]", true],
    ["169.254.10.20", false],
    ["[fe80::1]", false],
    ["10.0.0.5", false],
    ["172.16.4.2", false],
    ["192.168.1.20", false],
    ["studio.local", false],
    ["100.101.102.103", false],
    ["kin-host.tail1234.ts.net", false],
    ["kin.example.test", false],
    ["128.0.0.1", false],
  ])("%s reaches only this machine: %s", (host, local) => {
    expect(kinIsLocalOnlyHost(host)).toBe(local);
    expect(kinIsLocalOnlyHost(new URL(`http://${host}:3773/`).hostname)).toBe(local);
  });
});
