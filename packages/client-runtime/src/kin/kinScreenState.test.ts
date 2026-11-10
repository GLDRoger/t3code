// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import { EnvironmentAuthorizationError, EnvironmentId, KinChatError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import type { KinSynced } from "./kinStreams.ts";
import type { KinHost, KinProbe } from "./kinHost.ts";
import { emptyKinInbox, selectKinInboxView, type KinInboxState } from "./kinInboxModel.ts";
import {
  formatKinTime,
  kinChatRowLabel,
  kinChatRowView,
  kinChatTitle,
  kinDirectory,
  kinHomeLabel,
  kinHomeSubtitle,
  kinInboxListRows,
  kinInboxNotice,
  kinInboxScreenState,
  kinLeadChatId,
  kinLevelsAgentId,
  kinPreviewText,
  kinReconnectStep,
  kinSnippet,
  kinWaitingBannerView,
  kinWaitingRowView,
} from "./kinScreenState.ts";

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
    ["live and connected", true, true, savedAt, "idle", null],
    ["live with nothing saved", false, false, null, "idle", null],
    ["cached while connecting", true, false, savedAt, "idle", "Updating. Last updated 9:41."],
    ["cached and offline", false, false, savedAt, "idle", "Offline. Last updated 9:41."],
    ["disconnected mid-session", false, true, savedAt, "idle", "Offline. Last updated 9:41."],
    ["reconnecting", false, false, savedAt, "pending", "Reconnecting… Last updated 9:41."],
    [
      "a reconnect failed",
      false,
      false,
      savedAt,
      "failed",
      "Couldn't reconnect. Last updated 9:41.",
    ],
    ["reconnected but not live", true, false, savedAt, "pending", "Updating. Last updated 9:41."],
  ] as const)("when %s", (_name, connected, live, saved, reconnect, message) => {
    const notice = kinInboxNotice(
      { _tag: "ready", environmentId, connected, inbox: { ...synced, live, savedAt: saved } },
      reconnect,
      format,
    );
    expect(notice?.message ?? null).toBe(message);
    if (notice !== null) expect(notice.offline).toBe(!connected);
  });
});

describe("kinReconnectStep", () => {
  const state = (phase: SupervisorConnectionState["phase"]) =>
    ({ ...AVAILABLE_CONNECTION_STATE, phase }) as SupervisorConnectionState;
  const backoff = state("backoff");
  it.each([
    ["connects", false, state("connected"), backoff, "connected"],
    ["waits on the state at the press", false, backoff, backoff, "pending"],
    ["waits through an attempt", false, state("connecting"), backoff, "pending"],
    ["fails when an attempt ends unconnected", true, state("backoff"), backoff, "failed"],
    ["fails when the device is offline", false, state("offline"), state("offline"), "failed"],
    ["fails when the host blocks the retry", false, state("blocked"), backoff, "failed"],
    ["waits through an unrelated backoff update", false, state("backoff"), backoff, "pending"],
  ] as const)("%s", (_name, attempted, next, before, outcome) => {
    expect(kinReconnectStep(attempted, next, before).outcome).toBe(outcome);
  });

  it("remembers an attempt began", () => {
    const before = backoff;
    const first = kinReconnectStep(false, state("connecting"), before);
    expect(first.attempted).toBe(true);
    expect(kinReconnectStep(first.attempted, state("backoff"), before).outcome).toBe("failed");
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

  it("says how many chats are working when nothing waits, and only while connected", () => {
    const working = { ...inbox, chats: [{ ...inbox.chats[0]!, working: true }] };
    const view = selectKinInboxView(working);
    expect(kinHomeSubtitle(readyState(true), view)).toBe("Working · 1");
    expect(kinHomeSubtitle(readyState(false), view)).toBe("Offline");
  });

  it("says Offline once the host disconnects", () => {
    expect(kinHomeSubtitle(readyState(false), selectKinInboxView(inbox))).toBe("Offline");
  });

  it("says when Kin doesn't know this session", () => {
    expect(kinHomeSubtitle({ _tag: "noIdentity" }, null)).toBe(
      "Kin doesn't know you on this server yet",
    );
  });

  it("previews the newest message as plain text", () => {
    const marked = { ...inbox, chats: [chat("a", "2026-11-01T00:00:00.000Z", "**Fixed** `pay`")] };
    expect(kinHomeSubtitle(readyState(true), selectKinInboxView(marked))).toBe("Fixed pay");
  });
});

describe("kinHomeLabel", () => {
  const directory = kinDirectory(
    host({
      _tag: "ready",
      orgs: {
        orgs: [{ agents: [{ agentId: "lead", displayName: "Tech lead", retired: false }] }],
        me: [{ orgId: "org", personId: "owner" }],
      } as never,
    }),
  );
  const long =
    "Payments test fixed and PR 212 is ready for review, with the flaky retry removed and the timeout raised to thirty seconds.";
  const inboxWith = (body: string | null, author: object, unread: number) =>
    ({
      ...emptyKinInbox,
      chats: [
        {
          chatId: "c1",
          kind: "direct",
          title: null,
          archivedAt: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          lastMessageAt: body === null ? null : "2026-11-08T09:30:00.000Z",
          lastMessage: body === null ? null : { body, status: "visible", author },
          members: [{ principal: { _tag: "agent", agentId: "lead" }, leftAt: null }],
          unread,
        },
      ],
    }) as never as KinInboxState;
  const label = (inbox: KinInboxState, connected = true) =>
    kinHomeLabel(
      { _tag: "ready", environmentId, connected, inbox: { ...synced, value: inbox } },
      selectKinInboxView(inbox),
      directory,
    );
  const lead = { _tag: "agent", agentId: "lead" };

  it.each([
    [
      "names the chat and cuts a long message",
      inboxWith(long, lead, 2),
      true,
      "Kin, 2 unread. Tech lead, last message: Payments test fixed and PR 212 is ready for review, with the flaky retry…",
    ],
    [
      "says the viewer sent it",
      inboxWith("On it.", { _tag: "human", personId: "owner" }, 0),
      true,
      "Kin. Tech lead, last message from you: On it.",
    ],
    ["has no messages", inboxWith(null, lead, 0), true, "Kin. No messages yet."],
    ["is offline", inboxWith(long, lead, 3), false, "Kin, 3 unread. Offline."],
  ] as const)("%s", (_name, inbox, connected, expected) => {
    expect(label(inbox, connected)).toBe(expected);
  });

  it("reads a status without its separator", () => {
    expect(kinHomeLabel({ _tag: "offline" }, null, directory)).toBe("Kin. Offline.");
  });
});

describe("kinSnippet", () => {
  it.each([
    ["keeps short text", "Payments test fixed", "Payments test fixed"],
    ["cuts at a word", `${"word ".repeat(20)}end`, `${"word ".repeat(16).trim()}…`],
    ["cuts one long word", "x".repeat(100), `${"x".repeat(80)}…`],
  ] as const)("%s", (_name, text, expected) => {
    expect(kinSnippet(text)).toBe(expected);
  });
});

describe("chat list rows", () => {
  const directory = kinDirectory(
    host({
      _tag: "ready",
      orgs: {
        orgs: [{ agents: [{ agentId: "lead", displayName: "Tech lead", retired: false }] }],
        me: [{ orgId: "org", personId: "owner" }],
      } as never,
    }),
  );
  const member = (
    principal: object,
    leftAt: string | null = null,
    joinedAt = "2026-11-01T00:00:00.000Z",
  ) => ({ principal, leftAt, joinedAt });
  const row = (chat: object, waitingCount = 0) =>
    ({
      chat: {
        chatId: "c1",
        kind: "direct",
        title: null,
        lastMessageAt: "2026-11-08T09:30:00.000Z",
        members: [
          member({ _tag: "person", personId: "owner" }),
          member({ _tag: "agent", agentId: "lead" }),
        ],
        lastMessage: {
          author: { _tag: "agent", agentId: "lead" },
          status: "posted",
          body: "Payments test fixed, PR 212 ready.",
        },
        unread: 3,
        ...chat,
      },
      waitingCount,
    }) as never;

  it("heads each fold with its count, and drops headers when nothing waits or works", () => {
    const folded = (chatId: string, fold: string) => ({ ...(row({ chatId }) as object), fold });
    const listed = (rows: ReadonlyArray<object>, folds: object) =>
      kinInboxListRows({ rows, folds } as never, directory).map((item) =>
        item.type === "fold" ? item.accessibilityLabel : item.key,
      );
    expect(
      listed([folded("a", "needsYou"), folded("b", "rest"), folded("c", "rest")], {
        needsYou: 1,
        working: 0,
        rest: 2,
      }),
    ).toEqual(["Needs you, 1 chat", "a", "Unread and done, 2 chats", "b", "c"]);
    expect(listed([folded("b", "rest")], { needsYou: 0, working: 0, rest: 1 })).toEqual(["b"]);
  });

  it("names a direct chat after its agent and reads as the spec's label", () => {
    const view = kinChatRowView(row({}), directory);
    expect(view).toMatchObject({
      title: "Tech lead",
      avatar: { kind: "agent", seed: "agent:lead" },
      author: "Tech lead",
    });
    expect(kinChatRowLabel(view, () => "9:30")).toBe(
      "Tech lead, agent. Payments test fixed, PR 212 ready. 9:30. 3 unread.",
    );
  });

  it("prefixes the viewer's own message and drops a missing time and zero unread", () => {
    const view = kinChatRowView(
      row({
        lastMessageAt: null,
        unread: 0,
        lastMessage: { author: { _tag: "human", personId: "owner" }, status: "posted", body: "Ok" },
      }),
      directory,
    );
    expect(view.author).toBe("You");
    expect(kinChatRowLabel(view, () => "never")).toBe("Tech lead, agent. You: Ok.");
  });

  it.each([
    ["no message", { lastMessage: null }, null, "No messages yet"],
    [
      "a deleted message",
      { lastMessage: { author: { _tag: "agent", agentId: "lead" }, status: "deleted", body: "" } },
      null,
      "Message deleted",
    ],
    [
      "someone it can't name",
      {
        lastMessage: { author: { _tag: "human", personId: "ravi" }, status: "posted", body: "Hi" },
      },
      null,
      "Hi",
    ],
  ])("previews %s", (_name, chat, author, preview) => {
    expect(kinChatRowView(row(chat), directory)).toMatchObject({ author, preview });
  });

  it("draws a person when the other side is a person, and survives unknown agents", () => {
    const person = kinChatRowView(
      row({
        title: "Ravi Patel",
        members: [
          member({ _tag: "person", personId: "owner" }),
          member({ _tag: "person", personId: "ravi" }),
        ],
      }),
      directory,
    );
    expect(person.avatar).toEqual({ kind: "person", seed: "person:ravi" });
    expect(kinChatRowView(row({ kind: "team_group" }), directory).avatar).toEqual({
      kind: "group",
      seed: "chat:c1",
    });
    const unknown = kinChatRowView(row({}), kinDirectory({ _tag: "none" }));
    expect(unknown).toMatchObject({ title: "Direct chat", author: null });
  });

  it("ignores an agent that left", () => {
    const view = kinChatRowView(
      row({
        members: [
          member({ _tag: "person", personId: "owner" }),
          member({ _tag: "agent", agentId: "lead" }, "2026-11-08T09:00:00.000Z"),
        ],
      }),
      directory,
    );
    expect(view.title).toBe("Direct chat");
  });

  it.each([
    ["## Done\n\n- **Merged** [#212](https://x.test) `main`", "Done Merged #212 main"],
    ["*Shipped* the _retry_ fix", "Shipped the retry fix"],
    ["Run:\n```ts\nawait retry()\n```", "Run: await retry()"],
    ["2 * 3 * 4 in snake_case_name", "2 * 3 * 4 in snake_case_name"],
  ])("flattens %j to one line", (body, preview) => {
    expect(kinPreviewText(body)).toBe(preview);
  });

  it("opens the lead's direct chat from the footer, not the most active one", () => {
    const direct = (chatId: string, agentId: string, joinedAt: string, waitingCount = 0) =>
      row(
        {
          chatId,
          members: [
            member({ _tag: "person", personId: "owner" }),
            member({ _tag: "agent", agentId }, null, joinedAt),
          ],
        },
        waitingCount,
      );
    expect(
      kinLeadChatId([
        // Waiting chats sort first, so the newer QA chat leads the list.
        direct("qa", "qa", "2026-11-07T00:00:00.000Z", 2),
        row({ chatId: "g", kind: "team_group" }),
        direct("lead", "lead", "2026-11-01T00:00:00.000Z"),
      ]),
    ).toBe("lead");
    expect(kinLeadChatId([row({ chatId: "g", kind: "team_group" })])).toBeNull();
    expect(kinLeadChatId([])).toBeNull();
  });
});

describe("kinWaitingBannerView", () => {
  const item = (reason: string) => ({ reason }) as never;

  it("is absent when nothing waits", () => {
    expect(kinWaitingBannerView([])).toBeNull();
  });

  it("names up to two kinds, oldest first, and counts the rest", () => {
    expect(
      kinWaitingBannerView([item("approval"), item("question"), item("question"), item("mention")]),
    ).toEqual({
      count: 4,
      summary: "1 approval · 2 questions · 1 more",
      accessibilityLabel: "Waiting on you, 4 items: 1 approval, 2 questions, and 1 more",
    });
    expect(kinWaitingBannerView([item("decision")])?.accessibilityLabel).toBe(
      "Waiting on you, 1 item: 1 decision",
    );
  });
});

describe("formatKinTime", () => {
  const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const lateLastNight = new Date(2026, 10, 7, 23, 50);

  it.each([
    ["the same day", new Date(2026, 10, 7, 23, 59), clock.format(lateLastNight)],
    ["just after midnight", new Date(2026, 10, 8, 0, 10), day.format(lateLastNight)],
  ])("reads a time against now on %s", (_name, now, label) => {
    expect(formatKinTime(lateLastNight, now)).toBe(label);
  });
});

const agentNames = new Map([["agent-atlas", "Atlas"]]);
const member = (principal: object, leftAt: string | null = null) => ({ principal, leftAt });
const owner = member({ _tag: "person", personId: "owner" });
const atlas = member({ _tag: "agent", agentId: "agent-atlas" });

describe("kinLevelsAgentId", () => {
  const person = (personId: string, role: string, leftAt: string | null = null) => ({
    principal: { _tag: "person", personId },
    role,
    leftAt,
  });
  const lead = {
    principal: { _tag: "agent", agentId: "agent-atlas" },
    role: "member",
    leftAt: null,
  };
  const chat = (kind: string, members: ReadonlyArray<object>) => ({ kind, members }) as never;

  it("opens Levels only for the owner of a direct chat with an agent", () => {
    expect(kinLevelsAgentId(chat("direct", [person("me", "owner"), lead]), "me")).toBe(
      "agent-atlas",
    );
    expect(kinLevelsAgentId(chat("direct", [person("me", "member"), lead]), "me")).toBeNull();
    expect(
      kinLevelsAgentId(chat("direct", [person("me", "owner", "2026-11-01"), lead]), "me"),
    ).toBeNull();
    expect(kinLevelsAgentId(chat("team_group", [person("me", "owner"), lead]), "me")).toBeNull();
    expect(kinLevelsAgentId(chat("direct", [person("me", "owner")]), "me")).toBeNull();
    expect(kinLevelsAgentId(chat("direct", [person("me", "owner"), lead]), null)).toBeNull();
  });
});

describe("kinChatTitle", () => {
  it.each([
    ["the host's title", { title: "Payments", kind: "team_group", members: [atlas] }, "Payments"],
    ["a direct chat's agent", { title: null, kind: "direct", members: [owner, atlas] }, "Atlas"],
    [
      "a direct chat whose agent left",
      { title: null, kind: "direct", members: [owner, member(atlas.principal, "2026-11-08")] },
      "Direct chat",
    ],
    [
      "an agent the directory doesn't name",
      { title: null, kind: "direct", members: [member({ _tag: "agent", agentId: "x" })] },
      "Direct chat",
    ],
    ["an untitled group", { title: null, kind: "team_group", members: [owner] }, "Chat"],
    [
      "an untitled group with an agent",
      { title: null, kind: "team_group", members: [atlas] },
      "Chat",
    ],
    ["an untitled project group", { title: null, kind: "project_group", members: [atlas] }, "Chat"],
    ["an untitled router chat", { title: null, kind: "router", members: [owner, atlas] }, "Chat"],
  ] as const)("names %s", (_name, chat, title) => {
    expect(kinChatTitle(chat as never, agentNames)).toBe(title);
  });
});

describe("kinWaitingRowView", () => {
  const chats = [
    {
      chatId: "chat-1",
      title: null,
      kind: "direct",
      members: [owner, atlas],
      lastMessage: { messageId: "m-2", status: "visible", body: "Merge #212 now?" },
    },
  ] as never;
  const item = (messageId: string | null, chatId = "chat-1") =>
    ({
      chatId,
      messageId,
      reason: "question",
      createdAt: "2026-11-08T09:30:00.000Z",
    }) as never;

  it("shows the asking message and the chat's derived title", () => {
    expect(kinWaitingRowView(item("m-2"), chats, agentNames)).toEqual({
      label: "Question",
      chatTitle: "Atlas",
      text: "Merge #212 now?",
      createdAt: "2026-11-08T09:30:00.000Z",
    });
  });

  it("has no text when the inbox doesn't carry the message", () => {
    expect(kinWaitingRowView(item("m-1"), chats, agentNames).text).toBeNull();
    expect(kinWaitingRowView(item(null, "chat-9"), chats, agentNames)).toMatchObject({
      chatTitle: "Direct chat",
      text: null,
    });
  });
});
