import { describe, expect, it } from "vite-plus/test";

import {
  buildKinJoinAppLink,
  buildPairingAppLink,
  readKinJoinLink,
  readPairingAppLink,
  RemoteBackendUrlMissingError,
  RemotePairingTokenMissingError,
  RemotePairingUrlInvalidError,
  resolveRemotePairingTarget,
} from "./remote.ts";

describe("remote", () => {
  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

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
    // What the invite page hands the phone app, on any app channel's scheme.
    expect(readKinJoinLink(buildKinJoinAppLink(link))).toBe(link);
    expect(readKinJoinLink(buildKinJoinAppLink(link).replace("t3code:", "t3code-dev:"))).toBe(link);
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

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("derives backend urls from hosted app pairing links", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "///example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//https://example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl: "ftp://remote.example.com/pair#token=pairing-token",
      });
    } catch (cause) {
      pairingUrlError = cause;
    }

    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect(pairingUrlError).toMatchObject({ protocol: "ftp:" });
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeUndefined();
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(RemoteBackendUrlMissingError);
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }),
    ).toThrowError(RemotePairingTokenMissingError);
    expect(() =>
      resolveRemotePairingTarget({
        host: "https://user:secret@remote.example.com/path?token=sensitive#fragment",
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "RemotePairingCodeMissingError",
        host: "remote.example.com",
      }),
    );
  });

  it("round-trips pairing urls through app links on every channel scheme", () => {
    const pairingUrl = "https://vps.example.com/pair#token=ABC123";
    const appLink = buildPairingAppLink(pairingUrl);
    expect(appLink.startsWith("t3code://pair?")).toBe(true);
    expect(readPairingAppLink(appLink)).toBe(pairingUrl);
    expect(readPairingAppLink(appLink.replace("t3code:", "t3code-dev:"))).toBe(pairingUrl);
    expect(readPairingAppLink("t3code://pair")).toBeNull();
    expect(readPairingAppLink(appLink.replace("//pair?", "//pair/other?"))).toBeNull();
    expect(
      readPairingAppLink(`t3code://threads?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
    expect(
      readPairingAppLink(`https://pair?pairingUrl=${encodeURIComponent(pairingUrl)}`),
    ).toBeNull();
  });
});
