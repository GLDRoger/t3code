import { describe, expect, it } from "vite-plus/test";

import { kinChatListRowLabel, kinChatListRows } from "./kinChatListRows.ts";
import type { KinInboxRow, KinInboxView } from "./kinInboxModel.ts";
import type { KinDirectory } from "./kinScreenState.ts";

const directory: KinDirectory = {
  agentNames: new Map([
    ["lead", "Tech lead"],
    ["old", "Finance"],
  ]),
  me: new Set(["owner"]),
  retiredAgents: new Set(["old"]),
};

const member = (principal: object) => ({ principal, role: "member", leftAt: null });

function row(
  chatId: string,
  lastMessage: object | null,
  extra: {
    readonly fold?: KinInboxRow["fold"];
    readonly kind?: string;
    readonly agentId?: string;
  } = {},
): KinInboxRow {
  return {
    chat: {
      chatId,
      orgId: "org",
      kind: extra.kind ?? "direct",
      title: null,
      createdAt: "2026-11-08T09:00:00.000Z",
      lastMessageAt: lastMessage === null ? null : "2026-11-08T09:30:00.000Z",
      members: [
        member({ _tag: "person", personId: "owner" }),
        member({ _tag: "agent", agentId: extra.agentId ?? "lead" }),
      ],
      lastMessage:
        lastMessage === null
          ? null
          : {
              author: { _tag: "agent", agentId: "lead" },
              status: "posted",
              kind: "text",
              widgetId: null,
              ...lastMessage,
            },
      unread: 0,
    },
    waitingCount: extra.fold === "needsYou" ? 1 : 0,
    fold: extra.fold ?? "rest",
  } as never;
}

const list = (rows: ReadonlyArray<KinInboxRow>) =>
  kinChatListRows({ rows } as unknown as KinInboxView, directory);

describe("kinChatListRows", () => {
  it("keeps the inbox order but ends with chats nobody has written in", () => {
    const rows = list([
      row("waiting", null, { fold: "needsYou" }),
      row("empty-new", null),
      row("talked", { body: "Done." }),
      row("empty-old", null),
    ]);
    expect(rows.map((item) => item.chat.chatId)).toEqual([
      "waiting",
      "talked",
      "empty-new",
      "empty-old",
    ]);
    expect(rows[2]).toMatchObject({ fresh: true, preview: "Say hello to get started" });
  });

  it("lists a retired agent's chats last, and a group it is in where it was", () => {
    const rows = list([
      row("retired-talked", { body: "Invoices sent." }, { agentId: "old" }),
      row("retired-empty", null, { agentId: "old" }),
      row("group", { body: "Done." }, { agentId: "old", kind: "team_group" }),
      row("empty", null),
    ]);
    expect(rows.map((item) => [item.chat.chatId, item.retired])).toEqual([
      ["group", false],
      ["empty", false],
      ["retired-talked", true],
      ["retired-empty", true],
    ]);
    // Nobody is there to greet, and its last words stay readable.
    expect(rows.map((item) => item.preview).slice(2)).toEqual(["Invoices sent.", "Retired"]);
    // Heard once either way.
    expect(
      rows.slice(2).map((item) => kinChatListRowLabel(item, () => "9:30").match(/Retired/g)),
    ).toEqual([["Retired"], ["Retired"]]);
  });

  it.each([
    ["a lead's reply in its own chat", { body: "PR 212 is **ready**." }, null, "PR 212 is ready."],
    [
      "the viewer's own message",
      { author: { _tag: "human", personId: "owner" }, body: "ship it" },
      "You",
      "ship it",
    ],
    [
      "a card tap, stored as JSON",
      {
        author: { _tag: "human", personId: "owner" },
        kind: "widget_action",
        widgetId: "choice:1",
        body: JSON.stringify({
          widgetId: "choice:1",
          actionId: "choose",
          text: 'Chose "Yes" on "Ship?"',
        }),
      },
      "You",
      "Yes",
    ],
    [
      "a card tap without words, as its action",
      {
        author: { _tag: "human", personId: "owner" },
        kind: "widget_action",
        widgetId: "task:1",
        body: JSON.stringify({ widgetId: "task:1", actionId: "open" }),
      },
      "You",
      "Open",
    ],
    [
      "a question card posted without a body",
      { body: "", widgetId: "choice:1" },
      null,
      "Asked you a question",
    ],
    ["a chart posted without a body", { body: "", widgetId: "chart:1" }, null, "Sent a chart"],
    ["a visual posted without a body", { body: "", widgetId: "visual:1" }, null, "Sent a visual"],
    ["an unknown card without a body", { body: "", widgetId: "later:1" }, null, "Sent a card"],
  ])("previews %s", (_name, lastMessage, author, preview) => {
    expect(list([row("chat", lastMessage)])[0]).toMatchObject({ author, preview });
  });

  it("names the author in a group, where more than one lead can write", () => {
    expect(list([row("group", { body: "On it." }, { kind: "team_group" })])[0]).toMatchObject({
      author: "Tech lead",
    });
  });
});
