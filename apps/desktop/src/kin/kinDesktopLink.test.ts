import { assert, describe, it } from "@effect/vitest";

import { buildKinJoinAppLink, buildPairingAppLink } from "@t3tools/shared/remote";

import {
  kinShellAllowsPermission,
  kinShellNavigation,
  readKinDesktopLink,
} from "./kinDesktopLink.ts";

const HOST = "https://kin.ambermill.example";
const INVITE = `${HOST}/kin/invite#org-1.invite-1.s3cret`;
const PAIR = `${HOST}/pair#token=PAIRCODE`;
const APP_SCHEME = new URL(buildPairingAppLink(PAIR)).protocol.slice(0, -1);

describe("readKinDesktopLink", () => {
  it("accepts the links a Kin host makes and refuses the rest", () => {
    const cases: ReadonlyArray<readonly [string, string, string | null]> = [
      ["teammate's join link", INVITE, INVITE],
      ["join link inside a message", `Hi Arjun, here's Kin: ${INVITE} see you there`, INVITE],
      ["join link wrapped for the app", buildKinJoinAppLink(APP_SCHEME, INVITE), INVITE],
      ["link for another device", PAIR, PAIR],
      ["device link wrapped for the app", buildPairingAppLink(PAIR), PAIR],
      [
        "a local host over http",
        "http://127.0.0.1:3773/kin/invite#org.inv.s",
        "http://127.0.0.1:3773/kin/invite#org.inv.s",
      ],
      [
        "localhost over http",
        "http://localhost:3773/pair#token=abc",
        "http://localhost:3773/pair#token=abc",
      ],
      [
        "another machine over http",
        "http://kin.ambermill.example/kin/invite#org.inv.s",
        "Insecure",
      ],
      ["a pair link with no token", `${HOST}/pair`, "NotALink"],
      ["an invite with no secret", `${HOST}/kin/invite`, "NotALink"],
      [
        "a hosted pairing link for another server",
        `https://app.example/pair?host=${HOST}#token=abc`,
        "NotALink",
      ],
      ["the host's home page", `${HOST}/kin`, "NotALink"],
      ["an ordinary website", "https://example.com/", "NotALink"],
      ["a file", "file:///etc/hosts", "NotALink"],
      ["words", "join link please", "NotALink"],
      ["nothing", "   ", "NotALink"],
    ];
    for (const [name, text, expected] of cases) {
      const result = readKinDesktopLink(text);
      assert.strictEqual(result._tag === "Link" ? result.url : result._tag, expected, name);
      if (result._tag === "Link")
        assert.strictEqual(result.origin, new URL(result.url).origin, name);
    }
  });
});

describe("kinShellNavigation", () => {
  it("keeps the window on the team's host and the app's own pages", () => {
    const isAppPage = (url: string) => url.startsWith("kin://app/");
    const cases: ReadonlyArray<readonly [string, string | null, string]> = [
      [`${HOST}/kin/chats`, HOST, "stay"],
      ["kin://app/", HOST, "stay"],
      ["kin://app/", null, "stay"],
      [`${HOST}/kin`, null, "outside"],
      ["https://kin.ambermill.example:8443/kin", HOST, "outside"],
      ["http://kin.ambermill.example/kin", HOST, "outside"],
      ["https://evil.example/login", HOST, "outside"],
      ["file:///Users/rhea/notes.txt", HOST, "refuse"],
      ["vscode://file/Users/rhea/notes.txt", HOST, "refuse"],
      ["javascript:alert(1)", HOST, "refuse"],
      ["not a url", HOST, "refuse"],
    ];
    for (const [url, hostOrigin, expected] of cases) {
      assert.strictEqual(kinShellNavigation({ url, hostOrigin, isAppPage }), expected, url);
    }
  });

  it("lets only the team's host send alerts and copy links", () => {
    const cases: ReadonlyArray<readonly [string, string, string | null, boolean]> = [
      ["notifications", `${HOST}/kin`, HOST, true],
      ["clipboard-sanitized-write", HOST, HOST, true],
      ["notifications", "https://evil.example/", HOST, false],
      ["notifications", `${HOST}/kin`, null, false],
      ["media", `${HOST}/kin`, HOST, false],
      ["geolocation", `${HOST}/kin`, HOST, false],
      ["clipboard-read", `${HOST}/kin`, HOST, false],
    ];
    for (const [permission, requestingUrl, hostOrigin, expected] of cases) {
      assert.strictEqual(
        kinShellAllowsPermission({ permission, requestingUrl, hostOrigin }),
        expected,
        `${permission} from ${requestingUrl}`,
      );
    }
  });
});
