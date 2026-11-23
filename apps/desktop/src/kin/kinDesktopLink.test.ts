import { assert, describe, it } from "@effect/vitest";

import { buildKinJoinAppLink, buildPairingAppLink } from "@t3tools/shared/remote";

import {
  isKinOsLink,
  KIN_PERSON_ACTION_MS,
  kinShellAllowsPermission,
  kinShellCrashReload,
  kinShellNavigation,
  kinShellOutsideOpen,
  kinShellRedeemResult,
  kinShellRootRedirect,
  kinShellSessionProbe,
  readKinDesktopLink,
  readKinOsLink,
} from "./kinDesktopLink.ts";

const HOST = "https://kin.ambermill.example";
const INVITE = `${HOST}/kin/invite#org-1.invite-1.s3cret`;
const PAIR = `${HOST}/pair#token=PAIRCODE`;
const APP_SCHEME = new URL(buildPairingAppLink(PAIR)).protocol.slice(0, -1);
const OTHER = "https://kin.other.example/kin/invite#org-2.invite-2.s3cret";
const joinWrapper = (inner: string) => `${APP_SCHEME}://kin/join?link=${encodeURIComponent(inner)}`;

const tagOrUrl = (result: ReturnType<typeof readKinDesktopLink>) =>
  result._tag === "Link" ? result.url : result._tag;

describe("readKinDesktopLink", () => {
  it("accepts the links a Kin host makes and refuses the rest", () => {
    const cases: ReadonlyArray<readonly [string, string, string | null]> = [
      ["teammate's join link", INVITE, INVITE],
      ["the same link twice", `${INVITE} (again: ${INVITE})`, INVITE],
      ["two different links", `${INVITE} or ${OTHER}`, "Ambiguous"],
      ["a join link and a device link", `${INVITE} ${PAIR}`, "Ambiguous"],
      ["a wrapper inside a wrapper", joinWrapper(joinWrapper(INVITE)), "NotALink"],
      [
        "a wrapper with two links",
        `${joinWrapper(INVITE)}&link=${encodeURIComponent(OTHER)}`,
        "NotALink",
      ],
      [
        "a name and password before the host",
        `https://rhea:pw@kin.ambermill.example/kin/invite#s`,
        "NotALink",
      ],
      ["an invite with a query", `${HOST}/kin/invite?next=/kin#org-1.invite-1.s3cret`, "NotALink"],
      ["a device token in the query moves to the fragment", `${HOST}/pair?token=PAIRCODE`, PAIR],
      ["a device link with two tokens", `${HOST}/pair?token=A#token=B`, "NotALink"],
      ["a device link with more in it", `${HOST}/pair?token=PAIRCODE&next=x`, "NotALink"],
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
      assert.strictEqual(tagOrUrl(result), expected, name);
      if (result._tag === "Link")
        assert.strictEqual(result.origin, new URL(result.url).origin, name);
    }
  });

  it("takes from the operating system exactly one wrapped link naming one host", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["join link", joinWrapper(INVITE), INVITE],
      ["device link", buildPairingAppLink(PAIR), PAIR],
      ["device token in the query", buildPairingAppLink(`${HOST}/pair?token=PAIRCODE`), PAIR],
      [
        "local host over http",
        joinWrapper("http://localhost:7521/kin/invite#o.i.s"),
        "http://localhost:7521/kin/invite#o.i.s",
      ],
      [
        "another machine over http",
        joinWrapper("http://kin.ambermill.example/kin/invite#o.i.s"),
        "Insecure",
      ],
      ["a bare link", INVITE, "NotALink"],
      ["a wrapper inside a wrapper", joinWrapper(joinWrapper(INVITE)), "NotALink"],
      ["two link fields", `${joinWrapper(INVITE)}&link=${encodeURIComponent(OTHER)}`, "NotALink"],
      ["another field", `${joinWrapper(INVITE)}&next=1`, "NotALink"],
      ["two links in one field", joinWrapper(`${INVITE} ${OTHER}`), "NotALink"],
      ["a line break in the link", joinWrapper(`${INVITE}\n`), "NotALink"],
      ["a control character", joinWrapper(`${HOST}/kin/invite#org\u0007.s`), "NotALink"],
      ["a space in the wrapper", `${joinWrapper(INVITE)} `, "NotALink"],
      [
        "a name and password",
        joinWrapper("https://rhea@kin.ambermill.example/kin/invite#s"),
        "NotALink",
      ],
      ["a relative link", joinWrapper("/kin/invite#org-1.invite-1.s3cret"), "NotALink"],
      [
        "a hosted pairing link",
        buildPairingAppLink(`https://app.example/pair?host=${HOST}#token=a`),
        "NotALink",
      ],
    ];
    for (const [name, value, expected] of cases) {
      assert.strictEqual(tagOrUrl(readKinOsLink(value)), expected, name);
    }
  });

  it("hands Kin only its own join and device links from the operating system", () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ["join link", joinWrapper(INVITE), true],
      ["device link", buildPairingAppLink(PAIR), true],
      ["provider sign-in hand-off", `${APP_SCHEME}://auth/codex?authorizationUrl=x`, false],
      ["provider sign-in return", `${APP_SCHEME}://app/settings/providers`, false],
      ["a new thread", `${APP_SCHEME}://new?prompt=hello`, false],
      ["a thread", `${APP_SCHEME}://threads/thread-1`, false],
      ["the app's own page", `${APP_SCHEME}://app/`, false],
      ["a web page", INVITE, false],
      ["another app's link", "vscode://kin/join?link=x", false],
    ];
    for (const [name, value, expected] of cases) {
      assert.strictEqual(isKinOsLink(value), expected, name);
    }
  });
});

describe("the launch check", () => {
  it("counts only a direct answer from the team's own host", () => {
    const answer = (
      overrides: Partial<{ status: number; url: string; redirected: boolean; body: unknown }>,
    ) => ({
      status: 200,
      url: `${HOST}/api/auth/session`,
      redirected: false,
      body: { authenticated: true },
      ...overrides,
    });
    const cases: ReadonlyArray<
      readonly [string, Parameters<typeof kinShellSessionProbe>[0]["response"], string]
    > = [
      ["signed in", answer({}), "signed-in"],
      ["signed out", answer({ body: { authenticated: false } }), "signed-out"],
      ["a refused redirect or a timeout", null, "unreachable"],
      ["a followed redirect", answer({ redirected: true }), "unreachable"],
      [
        "an answer from another origin",
        answer({ url: "https://kin.ambermill.example:8443/api/auth/session" }),
        "unreachable",
      ],
      ["a server error", answer({ status: 502, body: null }), "unreachable"],
      ["not the session answer", answer({ body: "<html>" }), "unreachable"],
    ];
    for (const [name, response, expected] of cases) {
      assert.strictEqual(kinShellSessionProbe({ origin: HOST, response }), expected, name);
    }
  });

  it("tells a spent link from a host that couldn't answer", () => {
    const cases: ReadonlyArray<readonly [number | null, string]> = [
      [200, "joined"],
      [204, "joined"],
      [409, "limit"],
      [400, "spent"],
      [410, "spent"],
      [500, "try-again"],
      [503, "try-again"],
      [null, "try-again"],
    ];
    for (const [status, expected] of cases) {
      assert.strictEqual(kinShellRedeemResult(status), expected, String(status));
    }
  });

  it("reloads a crashed page a few times a minute, then stops", () => {
    let crashes: ReadonlyArray<number> = [];
    const reloads = [0, 1_000, 2_000, 3_000, 70_000].map((now) => {
      const next = kinShellCrashReload(crashes, now);
      crashes = next.crashes;
      return next.reload;
    });
    assert.deepStrictEqual(reloads, [true, true, true, false, true]);
  });
});

describe("kinShellNavigation", () => {
  it("keeps the window on the team's host and refuses pages asking for the app's own", () => {
    const isAppPage = (url: string) => url.startsWith("kin://app/");
    const cases: ReadonlyArray<readonly [string, string | null, string]> = [
      [`${HOST}/kin/chats`, HOST, "stay"],
      ["kin://app/", HOST, "refuse"],
      ["kin://app/", null, "refuse"],
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

  it("opens the browser only for a person's click or Enter", () => {
    const cases: ReadonlyArray<
      readonly [string, "navigate" | "new-window" | "redirect", number, string]
    > = [
      ["a clicked link", "navigate", 40, "open"],
      ["a clicked link opening a new window", "new-window", 40, "open"],
      ["a page navigating by itself", "navigate", Number.POSITIVE_INFINITY, "block"],
      ["a page opening a window by itself", "new-window", Number.POSITIVE_INFINITY, "block"],
      ["a page acting long after a click", "navigate", KIN_PERSON_ACTION_MS + 1, "block"],
      ["a server redirect right after a click", "redirect", 40, "ask"],
      ["a server redirect with no click", "redirect", Number.POSITIVE_INFINITY, "block"],
    ];
    for (const [name, cause, sincePersonAction, expected] of cases) {
      assert.strictEqual(kinShellOutsideOpen({ cause, sincePersonAction }), expected, name);
    }
  });

  it("opens Kin's home, not T3 Code's, at the team host's bare root", () => {
    const cases: ReadonlyArray<readonly [string, string | null, string | null]> = [
      [`${HOST}/`, HOST, `${HOST}/kin`],
      [`${HOST}/?from=pair`, HOST, `${HOST}/kin`],
      [`${HOST}/kin`, HOST, null],
      [`${HOST}/settings/access`, HOST, null],
      ["https://evil.example/", HOST, null],
      [`${HOST}/`, null, null],
    ];
    for (const [url, hostOrigin, expected] of cases) {
      assert.strictEqual(kinShellRootRedirect(url, hostOrigin), expected, url);
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
