import { expect, it } from "vite-plus/test";

import { buildKinJoinAppLink, readKinJoinLink, resolveRemotePairingTarget } from "./remote.ts";

it("reads a teammate's invite link as an invite, never as a pairing code", () => {
  expect(
    resolveRemotePairingTarget({
      pairingUrl: "https://remote.example.com/kin/invite#org.invite.secret",
    }),
  ).toEqual({
    credential: "org.invite.secret",
    httpBaseUrl: "https://remote.example.com/",
    wsBaseUrl: "wss://remote.example.com/",
    kinInvite: true,
  });
  expect(
    resolveRemotePairingTarget({
      pairingUrl: "https://remote.example.com/kin/invite#token=pairing-token",
    }),
  ).not.toHaveProperty("kinInvite");
});

it("finds a teammate's join link however it arrives, and nothing else", () => {
  const link = "https://kin.example.com/kin/invite#org.invite.secret";
  expect(readKinJoinLink(link)).toBe(link);
  expect(readKinJoinLink(`  Hi Maya, join here: ${link}. See you there!\n`)).toBe(link);
  expect(readKinJoinLink(`<${link}>`)).toBe(link);
  // What the invite page hands the phone app, on the scheme the host names.
  expect(buildKinJoinAppLink("kin", link)).toBe(`kin://kin/join?link=${encodeURIComponent(link)}`);
  expect(buildKinJoinAppLink("kin-dev", link)).toMatch(/^kin-dev:\/\/kin\/join\?link=/);
  // This build reads its own app channels' schemes; a branded build reads its own instead.
  expect(readKinJoinLink(buildKinJoinAppLink("t3code", link))).toBe(link);
  expect(readKinJoinLink(buildKinJoinAppLink("t3code-dev", link))).toBe(link);
  expect(readKinJoinLink(buildKinJoinAppLink("kin", link))).toBeNull();
  expect(readKinJoinLink("http://192.168.1.20:3773/kin/invite#org.invite.secret")).toBe(
    "http://192.168.1.20:3773/kin/invite#org.invite.secret",
  );

  expect(readKinJoinLink("")).toBeNull();
  expect(readKinJoinLink("kin.example.com")).toBeNull();
  expect(readKinJoinLink("https://kin.example.com/kin/invite")).toBeNull();
  expect(readKinJoinLink("https://kin.example.com/kin/invite#token=pairing-token")).toBeNull();
  expect(readKinJoinLink("https://kin.example.com/pair#token=pairing-token")).toBeNull();
  expect(readKinJoinLink("t3code://pair?pairingUrl=https%3A%2F%2Fkin.example.com")).toBeNull();
  expect(readKinJoinLink(`t3code://kin/other?link=${encodeURIComponent(link)}`)).toBeNull();
  expect(readKinJoinLink("javascript://kin.example.com/kin/invite#org.invite.secret")).toBeNull();
});
