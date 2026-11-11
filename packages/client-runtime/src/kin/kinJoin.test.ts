import { describe, expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";

import { KIN_JOIN_LINK_SPENT } from "../connection/errors.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "../connection/model.ts";
import {
  KIN_JOIN_FAILED,
  KIN_JOIN_UNREACHABLE,
  KIN_JOIN_UPDATE_APP,
  kinAccessEnded,
  kinAppShell,
  kinChatOnlyEnvironments,
  kinHomeTabs,
  kinJoinFailureMessage,
  kinJoinOffersApp,
  kinJoinStanding,
  kinJoinTarget,
} from "./kinJoin.ts";

const team = EnvironmentId.make("team");
const laptop = EnvironmentId.make("laptop");
const link = "https://kin.example.test/kin/invite#org.invite.secret";

describe("kinJoinTarget", () => {
  it("reads the link and the address it joins from pasted text", () => {
    expect(kinJoinTarget(`Join us: ${link}`)).toEqual({ link, address: "kin.example.test" });
    expect(kinJoinTarget("https://kin.example.test/pair#token=abc")).toBeNull();
  });
});

describe("kinJoinStanding", () => {
  const target = { link, address: "kin.example.test" };
  const saved = (chatOnly: boolean, connected: boolean, url = "https://kin.example.test/") => [
    { environmentId: team, httpBaseUrls: [url], chatOnly, connected },
  ];

  it.each([
    { label: "a Kin this phone has never joined", saved: [], expected: { _tag: "new" } },
    {
      label: "another address",
      saved: saved(true, true, "https://other.example.test/"),
      expected: { _tag: "new" },
    },
    {
      label: "a signed-in teammate, so a second tap never spends a link",
      saved: saved(true, true),
      expected: { _tag: "member", environmentId: team },
    },
    {
      label: "a teammate whose access ended, so the new link signs them back in",
      saved: saved(true, false),
      expected: { _tag: "new" },
    },
    {
      label: "a full session, connected or not, which a join must never replace",
      saved: saved(false, false),
      expected: { _tag: "fullAccess", environmentId: team },
    },
  ])("is $expected._tag for $label", ({ saved, expected }) => {
    expect(kinJoinStanding(target, saved)).toEqual(expected);
  });
});

describe("kinJoinFailureMessage", () => {
  it("keeps the spent-link sentence and retells the rest for a teammate", () => {
    expect(
      kinJoinFailureMessage(
        new ConnectionBlockedError({ reason: "authentication", detail: KIN_JOIN_LINK_SPENT }),
      ),
    ).toBe(KIN_JOIN_LINK_SPENT);
    expect(
      kinJoinFailureMessage(
        new ConnectionTransientError({ reason: "network", detail: "Failed to fetch environment." }),
      ),
    ).toBe(KIN_JOIN_UNREACHABLE);
    expect(
      kinJoinFailureMessage(
        new ConnectionBlockedError({ reason: "unsupported", detail: "Client not supported." }),
      ),
    ).toBe(KIN_JOIN_UPDATE_APP);
    // Written for an owner pairing a computer; a teammate never reads it.
    expect(
      kinJoinFailureMessage(
        new ConnectionBlockedError({
          reason: "configuration",
          detail: "That address claims to be Studio, which is already saved.",
        }),
      ),
    ).toBe(KIN_JOIN_FAILED);
    expect(kinJoinFailureMessage(new Error("boom"))).toBe(KIN_JOIN_FAILED);
  });
});

describe("the app's shell", () => {
  const teammate = { authenticated: true, permissions: ["kin:chat" as const] };
  const owner = { authenticated: true, permissions: [...AuthStandardClientScopes] };

  it("takes each environment's answer from its own session, and remembers it while unknown", () => {
    const chatOnly = (
      sessions: Partial<Record<string, typeof teammate | typeof owner>>,
      remembered: ReadonlyArray<EnvironmentId>,
    ) =>
      kinChatOnlyEnvironments({
        saved: [team, laptop],
        session: (environmentId) => sessions[environmentId] ?? null,
        remembered: new Set(remembered),
      });
    expect(chatOnly({ team: teammate, laptop: owner }, [])).toEqual([team]);
    // Offline at launch: what the device last learned stands.
    expect(chatOnly({}, [team])).toEqual([team]);
    // The session outranks memory both ways: a teammate later paired with full access, and back.
    expect(chatOnly({ team: owner }, [team])).toEqual([]);
    expect(chatOnly({ team: teammate, laptop: teammate }, [])).toEqual([team, laptop]);
  });

  it("offers the Kin tabs a session has been allowed, and no others", () => {
    expect(kinHomeTabs(teammate)).toEqual(["chats", "settings"]);
    expect(kinHomeTabs(owner)).toEqual(["chats", "work", "team", "memory", "settings"]);
    expect(
      kinHomeTabs({ authenticated: true, permissions: ["kin:chat", "orchestration:read"] }),
    ).toEqual(["chats", "work", "settings"]);
    expect(kinHomeTabs(null)).toEqual(["chats", "settings"]);
  });

  it("is only Kin when every saved environment is a teammate's", () => {
    expect(kinAppShell({ ready: false, saved: 1, chatOnly: 1 })).toBe("loading");
    expect(kinAppShell({ ready: true, saved: 0, chatOnly: 0 })).toBe("coding");
    expect(kinAppShell({ ready: true, saved: 1, chatOnly: 1 })).toBe("chatOnly");
    expect(kinAppShell({ ready: true, saved: 2, chatOnly: 1 })).toBe("coding");
  });
});

describe("kinAccessEnded", () => {
  it("is a refused session, not an outage or a client that needs updating", () => {
    const blocked = (reason: ConnectionBlockedError["reason"]) => ({
      phase: "blocked",
      lastFailure: new ConnectionBlockedError({ reason, detail: "refused" }),
    });
    expect(kinAccessEnded(blocked("authentication"))).toBe(true);
    expect(kinAccessEnded(blocked("unsupported"))).toBe(false);
    expect(
      kinAccessEnded({
        phase: "backoff",
        lastFailure: new ConnectionTransientError({ reason: "network", detail: "offline" }),
      }),
    ).toBe(false);
    expect(kinAccessEnded({ phase: "connected", lastFailure: null })).toBe(false);
    expect(kinAccessEnded(null)).toBe(false);
  });
});

describe("kinJoinOffersApp", () => {
  it("offers the app on a phone's browser and joins straight away on a computer", () => {
    expect(
      kinJoinOffersApp("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1"),
    ).toBe(true);
    expect(kinJoinOffersApp("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130.0")).toBe(true);
    expect(kinJoinOffersApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605")).toBe(
      false,
    );
  });
});
