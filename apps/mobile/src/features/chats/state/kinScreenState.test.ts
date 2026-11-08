import { EnvironmentAuthorizationError, EnvironmentId, KinChatError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { KinSynced } from "./kinStreams";
import type { KinHost, KinProbe } from "./kinHost";
import { emptyKinInbox, selectKinInboxView, type KinInboxState } from "./kinInboxModel";
import { kinHomeSubtitle, kinInboxNotice, kinInboxScreenState } from "./kinScreenState";

const environmentId = EnvironmentId.make("env-kin");
const ready: KinProbe = { _tag: "ready", orgs: { orgs: [], me: [] } as never };
const host = (probe: KinProbe, connected = true): KinHost => ({
  _tag: "host",
  environmentId,
  connected,
  probe,
});
const synced: KinSynced<KinInboxState> = { value: emptyKinInbox, live: true, savedAt: null };
type Inbox = AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null;
const fail = (error: unknown): Inbox => AsyncResult.failure(Cause.fail(error));

describe("kinInboxScreenState", () => {
  it.each([
    ["while the host is unknown", { _tag: "searching" }, null, "loading"],
    ["with no Kin host", { _tag: "none" }, null, "noHost"],
    [
      "when the probe lacks a scope",
      host({ _tag: "unauthorized", message: "no" }),
      null,
      "unauthorized",
    ],
    [
      "when the probe fails",
      host({ _tag: "error", message: "boom", transient: false }),
      null,
      "error",
    ],
    [
      "for a host that doesn't know this session",
      host({ _tag: "noIdentity", orgs: {} as never }),
      null,
      "noIdentity",
    ],
    [
      "when the probe can't reach the host",
      host({ _tag: "error", message: "timeout", transient: true }),
      AsyncResult.initial(true),
      "error",
    ],
    [
      "with an inbox while the probe can't reach the host",
      host({ _tag: "error", message: "timeout", transient: true }),
      AsyncResult.success(synced),
      "ready",
    ],
    ["while the inbox connects", host(ready), AsyncResult.initial(true), "loading"],
    ["for an offline host with no cache", host({ _tag: "pending" }, false), null, "offline"],
    [
      "for an offline host whose stream failed",
      host(ready, false),
      fail(new Error("x")),
      "offline",
    ],
    ["with an inbox", host(ready), AsyncResult.success(synced), "ready"],
    [
      "with an offline cache",
      host({ _tag: "pending" }, false),
      AsyncResult.success(synced),
      "ready",
    ],
    [
      "when the stream lacks a scope",
      host(ready),
      fail(
        new EnvironmentAuthorizationError({ message: "no", requiredScope: "orchestration:read" }),
      ),
      "unauthorized",
    ],
    [
      "when the stream fails",
      host(ready),
      fail(new KinChatError({ reason: "not_allowed", message: "nope" })),
      "error",
    ],
  ] as const)("shows %s", (_name, kinHost, inbox, tag) => {
    expect(kinInboxScreenState(kinHost as KinHost, inbox as Inbox)._tag).toBe(tag);
  });

  it("retries the read that failed, with its message", () => {
    expect(
      kinInboxScreenState(host({ _tag: "error", message: "boom", transient: false }), null),
    ).toEqual({
      _tag: "error",
      message: "boom",
      retry: "orgs",
    });
    expect(
      kinInboxScreenState(
        host(ready),
        fail(new KinChatError({ reason: "not_allowed", message: "nope" })),
      ),
    ).toEqual({ _tag: "error", message: "nope", retry: "inbox" });
  });

  it("names a transient probe failure plainly", () => {
    expect(
      kinInboxScreenState(host({ _tag: "error", message: "timeout", transient: true }), null),
    ).toEqual({ _tag: "error", message: "Couldn't reach Kin.", retry: "orgs" });
  });
});

describe("kinInboxNotice", () => {
  const savedAt = "2026-11-08T09:41:00.000Z";
  const format = () => "9:41";
  it.each([
    ["live and connected", true, true, savedAt, null],
    ["live with nothing saved", false, false, null, null],
    ["cached while connecting", true, false, savedAt, "Updating. Last updated 9:41."],
    ["cached and offline", false, false, savedAt, "Offline. Last updated 9:41."],
    ["disconnected mid-session", false, true, savedAt, "Offline. Last updated 9:41."],
  ] as const)("when %s", (_name, connected, live, saved, message) => {
    const notice = kinInboxNotice(
      { _tag: "ready", environmentId, connected, inbox: { ...synced, live, savedAt: saved } },
      format,
    );
    expect(notice?.message ?? null).toBe(message);
    if (notice !== null) expect(notice.offline).toBe(!connected);
  });
});

describe("kinHomeSubtitle", () => {
  const chat = (chatId: string, createdAt: string, last: string | null) =>
    ({
      chatId,
      archivedAt: null,
      createdAt,
      lastMessageAt: last === null ? null : "2026-11-08T09:00:00.000Z",
      lastMessage: last === null ? null : { body: last },
      unread: 0,
    }) as never;
  // The list sorts by `lastMessageAt ?? createdAt`, so the brand-new empty chat comes first.
  const inbox: KinInboxState = {
    ...emptyKinInbox,
    chats: [
      chat("a", "2026-11-01T00:00:00.000Z", "Payments test fixed"),
      chat("b", "2026-11-08T10:00:00.000Z", null),
    ],
  };
  const readyState = (connected: boolean) =>
    ({ _tag: "ready", environmentId, connected, inbox: { ...synced, value: inbox } }) as const;

  it("previews the chat the list puts first", () => {
    const view = selectKinInboxView(inbox);
    expect(view.rows[0]?.chat.chatId).toBe("b");
    expect(kinHomeSubtitle(readyState(true), view)).toBe("No messages yet");
  });

  it("says Offline once the host disconnects", () => {
    expect(kinHomeSubtitle(readyState(false), selectKinInboxView(inbox))).toBe("Offline");
  });

  it("says when Kin doesn't know this session", () => {
    expect(kinHomeSubtitle({ _tag: "noIdentity" }, null)).toBe(
      "Kin doesn't know you on this server yet",
    );
  });
});
