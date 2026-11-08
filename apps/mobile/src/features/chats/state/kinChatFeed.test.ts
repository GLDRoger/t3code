import type { EnvironmentId, KinMessage, KinWidget } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
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
  initialKinPaging,
  KIN_HISTORY_PAGE_SIZE,
  kinActivePaging,
  kinChatScreenState,
  kinChatStatusLine,
  kinEarlierPage,
  kinMessageLabel,
  kinMessageLinks,
  kinUnseenCount,
  mergeKinFeed,
  type KinFeedRow,
  type KinFeedViewer,
} from "./kinChatFeed";
import type { KinHost } from "./kinHost";
import { applyKinChatHistory, emptyKinChat, type KinChatState } from "./kinInboxModel";

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

  it("drops earlier pages once a reset replaces the stream's feed, so no hole opens", () => {
    const live = feed(all.slice(-KIN_HISTORY_PAGE_SIZE));
    const page = readKinFixtureHistory(
      all,
      kinEarlierPage(KIN_FIXTURE_CHAT_ID, live.messages, false)!,
    );
    const paging = {
      ...initialKinPaging,
      earlier: applyKinChatHistory(emptyKinChat, page),
      anchorSeq: live.messages[0]!.seq,
    };
    expect(kinActivePaging(paging, live)).toBe(paging);
    // The stream reaching further back keeps them.
    expect(kinActivePaging(paging, feed(all.slice(-60)))).toBe(paging);
    // Reset: the stream emptied its feed and waits for the latest page.
    expect(kinActivePaging(paging, { ...emptyKinChat, needsHistoryReload: true })).toBe(
      initialKinPaging,
    );
    // The reloaded latest page starts past where the earlier pages were read.
    const reloaded = feed(all.slice(-10));
    expect(kinActivePaging(paging, reloaded)).toBe(initialKinPaging);
    expect(kinEarlierPage(KIN_FIXTURE_CHAT_ID, reloaded.messages, false)?.beforeSeq).toBe(491);
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
    expect(fold.key).toBe("fold:run-0");
  });

  it("keeps a deleted agent message inside its run's fold", () => {
    const messages = all
      .slice(19, 26)
      .map((m) => (m.seq === 23 ? { ...m, status: "deleted" as const } : m));
    const rows = buildKinFeedRows(messages, viewer, new Set());
    expect(rows.map((row) => row.type)).toEqual([
      "message",
      "message",
      "fold",
      "message",
      "message",
    ]);
    expect(rows[2]).toMatchObject({ count: 3 });
  });

  it("reuses unchanged rows when a message arrives", () => {
    const messages = all.slice(0, 20);
    const before = buildKinFeedRows(messages, viewer, new Set());
    const after = buildKinFeedRows([...messages, all[20]!], viewer, new Set());
    expect(after).toHaveLength(before.length + 1);
    before.forEach((row, index) => expect(after[index]).toBe(row));
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

describe("message labels", () => {
  const row = (overrides: Partial<KinMessage>) =>
    buildKinFeedRows([agentMessage(1, overrides)], viewer, new Set())[0] as Extract<
      KinFeedRow,
      { type: "message" }
    >;
  const ownRow = (body: string) =>
    buildKinFeedRows([{ ...ownMessage(1), body }], viewer, new Set())[0] as Extract<
      KinFeedRow,
      { type: "message" }
    >;

  it.each([
    [
      "markdown reads as plain text",
      row({
        body: "Fixed and pushed. PR #212 is ready:\n\n- freezes the clock per test\n- drops the 2 s sleep",
      }),
      "Tech lead, agent. Fixed and pushed. PR #212 is ready: freezes the clock per test. drops the 2 s sleep. 9:30.",
    ],
    [
      "code fences keep their code",
      row({
        body: "Here's the plan:\n\n```ts\nconst timeout = Duration.seconds(10);\n```\n\nI'll start after lunch.",
      }),
      "Tech lead, agent. Here's the plan: const timeout = Duration.seconds(10); I'll start after lunch. 9:30.",
    ],
    [
      "own messages and emphasis",
      ownRow("Thanks. Let's keep the **fixed timeout** for now"),
      "You. Thanks. Let's keep the fixed timeout for now. 9:30.",
    ],
    [
      "link text, not its address",
      row({ body: "See [PR 212](https://github.com/o/r/pull/212) and `payments.test.ts`." }),
      "Tech lead, agent. See PR 212 and payments.test.ts. 9:30.",
    ],
    [
      "a suggestion says it isn't sent",
      row({ body: "Merge it?", status: "suggested" }),
      "Tech lead, agent. Merge it? 9:30. Suggestion, not sent yet.",
    ],
    [
      "an edit",
      row({ body: "Done", editedAt: "2026-11-08T09:31:00.000Z" }),
      "Tech lead, agent. Done. 9:30. Edited.",
    ],
    [
      "a deleted message",
      row({ body: "secret", status: "deleted" }),
      "Tech lead, agent. Message deleted. 9:30.",
    ],
    [
      "a card this build can't draw",
      row({ body: "", widgetId: "w1" as KinMessage["widgetId"] }),
      "Tech lead, agent. This card needs a newer version of Kin. 9:30.",
    ],
  ])("%s", (_name, messageRow, label) => {
    expect(kinMessageLabel(messageRow, "9:30")).toBe(label);
  });

  it("lists each link once, markdown and bare, for the bubble's actions", () => {
    expect(
      kinMessageLinks(
        "See [PR 212](https://github.com/o/r/pull/212), then https://t3.codes/docs. Also <https://a.b/c>",
      ),
    ).toEqual([
      { label: "PR 212", href: "https://github.com/o/r/pull/212" },
      { label: "https://t3.codes/docs", href: "https://t3.codes/docs" },
      { label: "https://a.b/c", href: "https://a.b/c" },
    ]);
    expect(kinMessageLinks("No links here.")).toEqual([]);
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

  it("keeps the loaded feed when its stream fails, with the error above it", () => {
    const loaded = synced(feed(all.slice(0, 3)));
    const failed = AsyncResult.failure(Cause.fail(new Error("Kin went away")), {
      previousSuccess: Option.some(loaded),
    });
    expect(kinChatScreenState(host(true), failed)).toMatchObject({
      _tag: "ready",
      error: "Kin went away",
    });
    expect(kinChatScreenState(host(false), failed)).toMatchObject({ _tag: "ready", error: null });
    expect(kinChatScreenState(host(true), synced(feed([])))).toMatchObject({ error: null });
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
