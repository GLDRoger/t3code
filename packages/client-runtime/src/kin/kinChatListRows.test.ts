import { describe, expect, it } from "vite-plus/test";

import {
  kinChatListAgents,
  kinChatListRowLabel,
  kinChatListRows,
  kinRoomLine,
} from "./kinChatListRows.ts";
import type { KinInboxRow, KinInboxView } from "./kinInboxModel.ts";
import type { KinDirectory } from "./kinScreenState.ts";

const directory: KinDirectory = {
  known: true,
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
    readonly teamId?: string;
  } = {},
): KinInboxRow {
  return {
    chat: {
      chatId,
      orgId: "org",
      kind: extra.kind ?? "direct",
      title: null,
      teamId: extra.teamId ?? null,
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
    expect(rows[2]).toMatchObject({ fresh: true, preview: "No messages yet" });
  });

  it("hides a chat with someone whose access ended until anything new arrives there", () => {
    const pair = (chatId: string, leftAt: string | null, lastAt: string | null) => {
      const base = row(chatId, lastAt === null ? null : { body: "Invented", createdAt: lastAt }, {
        kind: "team_group",
        teamId: `people:${chatId}`,
      });
      return {
        ...base,
        chat: {
          ...base.chat,
          members: [
            member({ _tag: "person", personId: "owner" }),
            { ...member({ _tag: "person", personId: "zoya" }), leftAt },
          ],
        },
      } as never;
    };
    const removed = "2026-11-08T10:00:00.000Z";
    const rows = list([
      pair("gone-quiet", removed, "2026-11-08T09:30:00.000Z"),
      pair("gone-empty", removed, null),
      pair("written-since", removed, "2026-11-08T11:00:00.000Z"),
      pair("still-here", null, "2026-11-08T09:30:00.000Z"),
    ]);
    expect(rows.map((item) => item.chat.chatId)).toEqual(["written-since", "still-here"]);
  });

  it("puts the company chat first, even before what waits on you", () => {
    const rows = list([
      row("waiting", null, { fold: "needsYou" }),
      row("company", null, { kind: "team_group", teamId: "company" }),
    ]);
    expect(rows.map((item) => [item.chat.chatId, item.company])).toEqual([
      ["company", true],
      ["waiting", false],
    ]);
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

describe("kinChatListAgents", () => {
  const agent = (agentId: string, name: string, intro: string) =>
    ({ orgId: "org", agentId, name, intro, ownerName: "Rhea" }) as never;
  const leads = {
    leads: [],
    messageable: [
      agent("lead", "Tech lead", "Runs engineering."),
      agent("growth", "Growth", "  Finds and follows up new clients. "),
      agent("social", "Social", ""),
    ],
  };

  it("lists an agent the viewer may message but has no chat with, with what it is for", () => {
    const chats = [
      row("lead-chat", { body: "Done." }),
      row("group", null, { agentId: "growth", kind: "team_group" }),
    ].map((held) => held.chat);
    expect(kinChatListAgents(chats, leads, directory.me)).toEqual([
      { agentId: "growth", name: "Growth", intro: "Finds and follows up new clients." },
      { agentId: "social", name: "Social", intro: null },
    ]);
  });

  it("drops an agent once the viewer has a chat with it, even an empty one", () => {
    const chats = [row("lead", null), row("growth", null, { agentId: "growth" })].map(
      (held) => held.chat,
    );
    expect(kinChatListAgents(chats, leads, directory.me).map((item) => item.agentId)).toEqual([
      "social",
    ]);
  });

  it("lists nothing before the host has said who may be messaged", () => {
    expect(kinChatListAgents([], null, directory.me)).toEqual([]);
  });
});

describe("kinRoomLine", () => {
  it("names the people, you first, then the agents", () => {
    const at = (principal: object, displayName: string, leftAt: string | null = null) =>
      ({ principal, displayName, leftAt }) as never;
    expect(
      kinRoomLine(
        [
          at({ _tag: "person", personId: "priya" }, "Priya"),
          at({ _tag: "person", personId: "owner" }, "Owner"),
          at({ _tag: "agent", agentId: "lead" }, "Tech lead"),
          at({ _tag: "person", personId: "gone" }, "Gone", "2026-11-08T09:00:00.000Z"),
        ],
        directory.me,
      ),
    ).toBe("You, Priya · Tech lead");
  });
});
