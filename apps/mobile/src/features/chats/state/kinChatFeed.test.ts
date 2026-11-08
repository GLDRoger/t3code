import type { EnvironmentId, KinMessage, KinWidget } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_FIXTURE_AGENT,
  KIN_FIXTURE_CHAT_ID,
  KIN_FIXTURE_OWNER,
  makeKinFixtureMessages,
  readKinFixtureHistory,
} from "./kinChatFixtures";
import {
  buildKinFeedRows,
  KIN_HISTORY_PAGE_SIZE,
  kinChatScreenState,
  kinChatStatusLine,
  kinEarlierPage,
  kinUnseenCount,
  mergeKinFeed,
  type KinFeedViewer,
} from "./kinChatFeed";
import type { KinHost } from "./kinHost";
import {
  applyKinChatEvent,
  applyKinChatHistory,
  emptyKinChat,
  type KinChatState,
} from "./kinInboxModel";

const all = makeKinFixtureMessages(500);
const viewer: KinFeedViewer = {
  personId: KIN_FIXTURE_OWNER,
  agentNames: new Map([[KIN_FIXTURE_AGENT, "Tech lead"]]),
};
const feed = (messages: ReadonlyArray<KinMessage>): KinChatState => ({
  ...emptyKinChat,
  messages,
});
const ownMessage = (seq: number) => all.find((m) => m.seq === seq && m.author._tag === "human")!;
const agentMessage = (seq: number, overrides: Partial<KinMessage> = {}) =>
  ({ ...all[1]!, messageId: `m${seq}`, seq, ...overrides }) as KinMessage;

describe("paging", () => {
  it("loads earlier pages of 50 until the first message, keeping every seq once", () => {
    const live = feed(all.slice(-KIN_HISTORY_PAGE_SIZE));
    let earlier = emptyKinChat;
    let exhausted = false;
    const pageSizes: number[] = [];
    for (;;) {
      const merged = mergeKinFeed(live, earlier);
      const request = kinEarlierPage(KIN_FIXTURE_CHAT_ID, merged.messages, exhausted);
      if (request === null) break;
      expect(request.beforeSeq).toBe(merged.messages[0]!.seq);
      const page = readKinFixtureHistory(all, request);
      pageSizes.push(page.messages.length);
      earlier = applyKinChatHistory(earlier, page);
      exhausted = !page.hasMore;
    }
    expect(pageSizes).toEqual(Array.from({ length: 9 }, () => 50));
    expect(mergeKinFeed(live, earlier).messages.map((m) => m.seq)).toEqual(all.map((m) => m.seq));
  });

  it("stops when the server says there is nothing older, even above seq 1", () => {
    expect(kinEarlierPage(KIN_FIXTURE_CHAT_ID, all.slice(10), true)).toBeNull();
    expect(kinEarlierPage(KIN_FIXTURE_CHAT_ID, [], false)).toBeNull();
  });

  it("prefers the stream's copy of a message an earlier page also holds", () => {
    const edited = { ...all[449]!, body: "edited live" };
    const merged = mergeKinFeed(feed([edited, ...all.slice(450)]), feed(all.slice(400, 450)));
    expect(merged.messages.find((m) => m.seq === 450)?.body).toBe("edited live");
    expect(merged.messages).toHaveLength(100);
  });
});

// The stream merge keeps the highest revision too: `kinInboxModel.test.ts`.
describe("in-place widget updates", () => {
  const atRevision = (revision: number, status: string) =>
    ({
      widgetId: "w1",
      messageId: "m1",
      type: "task",
      revision,
      state: { status },
    }) as unknown as KinWidget;
  const withWidget = (state: KinChatState, widget: KinWidget): KinChatState => ({
    ...state,
    widgets: [widget],
  });
  const status = (state: KinChatState) => {
    expect(state.widgets).toHaveLength(1);
    return (state.widgets[0]!.state as { status: string }).status;
  };

  it("an earlier page's older copy never overwrites the stream's, and a newer one wins", () => {
    const live = withWidget(emptyKinChat, atRevision(3, "done"));
    expect(status(mergeKinFeed(live, withWidget(emptyKinChat, atRevision(2, "working"))))).toBe(
      "done",
    );
    expect(status(mergeKinFeed(live, withWidget(emptyKinChat, atRevision(4, "failed"))))).toBe(
      "failed",
    );
  });

  it("after a reset, a page read before it can't bring back a stale revision", () => {
    const earlier = withWidget(emptyKinChat, atRevision(2, "working"));
    let live = withWidget(emptyKinChat, atRevision(3, "done"));
    live = applyKinChatEvent(live, { _tag: "reset", lastSeq: 400 });
    live = applyKinChatHistory(live, {
      messages: [],
      widgets: [atRevision(3, "done")],
      hasMore: true,
    });
    expect(status(mergeKinFeed(live, earlier))).toBe("done");
  });
});

describe("rows", () => {
  it("folds a run of agent messages into one line after the message before it", () => {
    // Seqs 22-24 of the fixture are one three-message floor run.
    const rows = buildKinFeedRows(all.slice(19, 26), viewer, new Set());
    expect(rows.map((row) => row.type)).toEqual([
      "message",
      "message",
      "fold",
      "message",
      "message",
    ]);
    const fold = rows[2]!;
    expect(fold).toMatchObject({
      count: 3,
      decision: "Settled on a fixed timeout.",
      expanded: false,
    });
    expect(fold.type === "fold" && fold.authors).toEqual(["Tech lead", "Agent"]);
  });

  it("lists an expanded run's messages right after its fold line", () => {
    const rows = buildKinFeedRows(all.slice(19, 26), viewer, new Set(["run-0"]));
    expect(rows.map((row) => (row.type === "message" ? row.message.seq : row.type))).toEqual([
      20,
      21,
      "fold",
      22,
      23,
      24,
      25,
      26,
    ]);
  });

  it("does not fold a single run message or a run broken by another author", () => {
    const run = { floorRunId: "r" };
    const rows = buildKinFeedRows(
      [agentMessage(1, run), ownMessage(3), agentMessage(4, run)],
      viewer,
      new Set(),
    );
    expect(rows.every((row) => row.type === "message")).toBe(true);
  });

  it("shows the author line once per stretch of one author, never on own messages", () => {
    const rows = buildKinFeedRows(
      [ownMessage(1), agentMessage(2), agentMessage(3), ownMessage(5), agentMessage(6)],
      viewer,
      new Set(),
    );
    expect(rows.map((row) => row.type === "message" && [row.own, row.showAuthor])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [true, false],
      [false, true],
    ]);
  });

  it("hides dismissed suggestions and draws system messages as their own rows", () => {
    const rows = buildKinFeedRows(
      [
        agentMessage(1),
        agentMessage(2, { status: "dismissed" }),
        agentMessage(3, { kind: "system", author: { _tag: "system" } }),
        agentMessage(4),
      ],
      viewer,
      new Set(),
    );
    expect(rows.map((row) => row.type === "message" && row.showAuthor)).toEqual([
      true,
      false,
      true,
    ]);
    expect(rows[1]!.type).toBe("system");
  });
});

describe("new messages pill", () => {
  it("counts only others' messages past the seq the reader left the end at", () => {
    const messages = all.slice(0, 10);
    expect(kinUnseenCount(messages, 10, KIN_FIXTURE_OWNER)).toBe(0);
    // Seqs 7-10 alternate owner and lead.
    expect(kinUnseenCount(messages, 6, KIN_FIXTURE_OWNER)).toBe(2);
    expect(kinUnseenCount(messages, 6, null)).toBe(4);
  });
});

describe("kinChatScreenState", () => {
  const host = (connected: boolean): KinHost => ({
    _tag: "host",
    environmentId: "env" as EnvironmentId,
    connected,
    probe: connected ? { _tag: "ready", orgs: { orgs: [], me: [] } } : { _tag: "pending" },
  });
  const synced = (value: KinChatState, live = true) =>
    AsyncResult.success({ value, live, savedAt: null });

  it("shows a cached feed offline, and ends on left or closed", () => {
    expect(kinChatScreenState(host(false), synced(feed(all.slice(0, 3)), false))._tag).toBe(
      "ready",
    );
    expect(kinChatScreenState(host(false), null)._tag).toBe("offline");
    expect(kinChatScreenState(host(true), null)._tag).toBe("loading");
    expect(kinChatScreenState(host(true), synced({ ...emptyKinChat, left: true }))).toEqual({
      _tag: "gone",
      reason: "left",
    });
    expect(
      kinChatScreenState(host(true), synced({ ...emptyKinChat, closed: "not_found" })),
    ).toEqual({ _tag: "gone", reason: "not_found" });
  });
});

describe("kinChatStatusLine", () => {
  const task = (id: string, status: string, closedAt: string | null = null) =>
    ({
      widgetId: id,
      type: "task",
      closedAt,
      state: {
        taskId: id,
        environmentId: "env",
        threadId: null,
        remoteEnvironmentId: null,
        title: "Fix payments test",
        model: null,
        status,
        pullRequests: [],
        lastError: null,
        updatedAt: "2026-11-08T09:00:00.000Z",
      },
    }) as unknown as KinWidget;

  it("counts open working tasks only", () => {
    expect(kinChatStatusLine([])).toBeNull();
    expect(kinChatStatusLine([task("a", "working"), task("b", "done")])).toBe("Working on 1 task");
    expect(
      kinChatStatusLine([
        task("a", "working"),
        task("b", "working"),
        task("c", "working", "2026-11-08T09:00:00.000Z"),
      ]),
    ).toBe("Working on 2 tasks");
  });
});
