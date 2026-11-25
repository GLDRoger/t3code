import { KinChatId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_CHATS_UP_AT_LEAST,
  kinChatListAgents,
  kinChatListFold,
  kinChatListRowLabel,
  kinChatListRows,
  kinChatsKeptUp,
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

const member = (principal: object, extra: object = {}) => ({
  principal,
  role: "member",
  leftAt: null,
  ...extra,
});

function row(
  chatId: string,
  lastMessage: object | null,
  extra: {
    readonly fold?: KinInboxRow["fold"];
    readonly kind?: string;
    readonly agentId?: string;
    readonly teamId?: string;
    readonly unread?: number;
    readonly working?: boolean;
    /** The Team room's quiet "new" dot. */
    readonly fresh?: boolean;
    /** The viewer's own member row: a pin or a mute. */
    readonly mine?: object;
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
        member({ _tag: "person", personId: "owner" }, extra.mine),
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
      unread: extra.unread ?? 0,
      ...(extra.working === undefined ? {} : { working: extra.working }),
      ...(extra.fresh === undefined ? {} : { fresh: extra.fresh }),
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
    [
      "a message its agent withdrew",
      {
        body: "",
        status: "deleted",
        withdrawn: { why: "Lumen Grove paid", at: "2026-11-23T08:40:00.000Z" },
      },
      null,
      "Withdrew a message",
    ],
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

describe("kinChatListFold", () => {
  const said = { body: "Done." };
  const pinned = (at: string) => ({ mine: { pinnedAt: at } });
  const muted = { mutedUntil: "9999-01-01T00:00:00.000Z" };
  const company = row("company", said, { kind: "team_group", teamId: "company" });
  const chief = row("chief", said, { agentId: "chief" });
  const old = (chatId: string) => row(chatId, said, { agentId: chatId });
  const fold = (
    rows: ReadonlyArray<KinInboxRow>,
    options: Partial<Parameters<typeof kinChatListFold>[1]> = {},
  ) => {
    const result = kinChatListFold(list(rows), { mainAgentId: "chief" as never, ...options });
    return {
      up: result.up.map((item) => item.chat.chatId),
      settled: result.settled.map((item) => item.chat.chatId),
    };
  };
  it.each([
    {
      name: "the company chat and the main agent's chat stay up; the rest settle",
      rows: [old("sales"), company, chief, old("books")],
      up: ["company", "chief"],
      settled: ["sales", "books"],
    },
    {
      name: "without a company chat, the main agent's chat alone is up",
      rows: [old("sales"), chief],
      up: ["chief"],
      settled: ["sales"],
    },
    {
      name: "with no main agent, the company chat alone is up",
      rows: [company, chief, old("sales")],
      mainAgentId: null,
      up: ["company"],
      settled: ["chief", "sales"],
    },
    {
      name: "pinned chats come next, in the order they were pinned",
      rows: [
        row("later", said, { agentId: "a", ...pinned("2026-11-20T10:00:00.000Z") }),
        old("sales"),
        row("first", said, { agentId: "b", ...pinned("2026-11-19T10:00:00.000Z") }),
        chief,
      ],
      up: ["chief", "first", "later"],
      settled: ["sales"],
    },
    {
      name: "a pin on the main agent's chat changes nothing",
      rows: [row("chief", said, { agentId: "chief", ...pinned("2026-11-19T10:00:00.000Z") })],
      up: ["chief"],
      settled: [],
    },
    {
      name: "an unread chat comes up after the pins",
      rows: [chief, old("sales"), row("books", said, { agentId: "books", unread: 2 })],
      up: ["chief", "books"],
      settled: ["sales"],
    },
    {
      name: "a chat waiting on the viewer comes up",
      rows: [chief, row("books", said, { agentId: "books", fold: "needsYou" }), old("sales")],
      up: ["chief", "books"],
      settled: ["sales"],
    },
    {
      name: "a chat an agent is working in comes up",
      rows: [chief, old("sales"), row("books", said, { agentId: "books", working: true })],
      up: ["chief", "books"],
      settled: ["sales"],
    },
    {
      name: "a muted chat with unread words still comes up",
      rows: [chief, row("books", said, { agentId: "books", unread: 1, mine: muted })],
      up: ["chief", "books"],
      settled: [],
    },
    {
      name: "the muted Team room with new words comes up, though it has no count",
      rows: [
        chief,
        row("team", said, { kind: "team_group", teamId: "team-room", fresh: true, mine: muted }),
      ],
      up: ["chief", "team"],
      settled: [],
    },
    {
      name: "read again with nothing waiting, it settles",
      rows: [chief, row("books", said, { agentId: "books", mine: muted })],
      up: ["chief"],
      settled: ["books"],
    },
    {
      name: "read again while the list is on screen, it stays up",
      rows: [chief, old("books"), old("sales")],
      keptUp: new Set(["books"]),
      up: ["chief", "books"],
      settled: ["sales"],
    },
    {
      name: "with nobody settled, there is no fold",
      rows: [company, chief],
      up: ["company", "chief"],
      settled: [],
    },
    {
      name: "a new teammate's one chat is up, not alone under the fold",
      rows: [old("welcome")],
      mainAgentId: null,
      up: ["welcome"],
      settled: [],
    },
    {
      name: `with nothing up, the newest ${KIN_CHATS_UP_AT_LEAST} come up and the rest settle`,
      rows: [old("a"), old("b"), old("c"), old("d")],
      up: ["a", "b", "c"],
      settled: ["d"],
    },
  ] as const)("$name", ({ rows, up, settled, ...options }) => {
    expect(fold(rows, options as never)).toEqual({ up, settled });
  });

  it("names the two rows that are always up, so neither offers a pin", () => {
    const result = kinChatListFold(list([company, chief, old("sales")]), {
      mainAgentId: "chief" as never,
    });
    expect([...result.fixed]).toEqual(["company", "chief"]);
  });

  it("only adds to who stays up while the list is on screen", () => {
    const rows = list([chief, old("books")]);
    const kept: ReadonlySet<KinChatId> = new Set([KinChatId.make("chief")]);
    expect(kinChatsKeptUp(kept, rows.slice(0, 1))).toBe(kept);
    expect([...kinChatsKeptUp(kept, rows)]).toEqual(["chief", "books"]);
  });

  it("says a pinned chat is pinned", () => {
    const [pinnedRow] = list([row("sales", said, pinned("2026-11-19T10:00:00.000Z"))]);
    expect(kinChatListRowLabel(pinnedRow!, () => "9:30")).toMatch(/Pinned\.$/);
  });
});
