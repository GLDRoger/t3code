import { describe, expect, it } from "@effect/vitest";
import {
  kinIsBrief,
  kinPageGist,
  type KinChartCardState,
  type KinMessage,
  type KinMessageLink,
} from "@t3tools/contracts";

import {
  kinDraftMarkdown,
  kinLinkedMarkdown,
  kinLinkOf,
  kinMessageCopyText,
  kinMessageGistMarkdown,
  kinMessageLayout,
  kinPageCollapses,
  kinPageCut,
  kinPageHead,
  kinPageView,
} from "./kinMessagePage.ts";

const agent = {
  _tag: "agent",
  agentId: "chief",
  memberId: "m",
  ownerPersonId: "rhea",
  threadId: "t",
} as unknown as KinMessage["author"];
const human = { _tag: "human", personId: "rhea", memberId: "m" } as unknown as KinMessage["author"];
const said = (body: string, extra: Partial<KinMessage> = {}) => ({
  author: agent,
  body,
  status: "posted" as const,
  createdAt: "2026-11-16T03:30:00.000Z",
  ...extra,
});

const BRIEF = [
  "Good morning Rhea.",
  "",
  "## Needs you",
  "- INV-1 is 12 days overdue: confirm the reminder.",
  "",
  "## Money",
  "- ₹1.2L came in this week.",
  "",
  "## Coming up",
  "",
  "## Clients",
  "- Orbit Dental renews in 9 days.",
].join("\n");

describe("kinMessageLayout", () => {
  it.each([
    ["a short reply", "Sent the quote to Anita. She usually answers by noon.", "bubble"],
    ["a heading", "## Plan\nShip on Friday.", "page"],
    ["a bold line as a heading", "**Money**\nAll paid.", "page"],
    ["two section labels", "Needs you:\n- Sign the contract\nMoney:\n- All paid", "page"],
    ["a table", "| Client | Owed |\n| --- | --- |\n| Orbit | ₹47,200 |", "page"],
    ["four items", "- a\n- b\n- c\n- d", "page"],
    ["three items", "Today:\n- a\n- b\n- c", "bubble"],
    ["a heading in code", "```md\n## not a heading\n```", "bubble"],
    ["a label that isn't a section", "Note to self:\nbuy milk", "bubble"],
  ])("%s", (_name, body, layout) => {
    expect(kinMessageLayout(said(body))).toBe(layout);
  });

  it("keeps people's messages and deleted ones as bubbles, and a brief with a section as a page under a head", () => {
    expect(kinMessageLayout(said("## Plan\nShip.", { author: human }))).toBe("bubble");
    expect(kinMessageLayout(said("## Plan\nShip.", { status: "deleted" }))).toBe("bubble");
    expect(kinMessageLayout(said(BRIEF, { form: "brief" }))).toBe("page");
    expect(kinPageHead(said(BRIEF, { form: "brief" }), "Rhea")?.greeting).toMatch(
      /^Good (morning|afternoon|evening), Rhea$/,
    );
    expect(kinPageHead(said("## Plan\nShip."), "Rhea")).toBeNull();
    // A one-line check-in reply has nothing for the big greeting to head.
    const quiet = said("Quiet day. Nothing needs you.", { form: "brief" });
    expect(kinMessageLayout(quiet)).toBe("bubble");
    expect(kinPageHead(quiet, "Rhea")).toBeNull();
  });

  it("a message with a figure is a page", () => {
    expect(
      kinMessageLayout(said("Two tasks are late.", { embeds: [{ _tag: "broken", message: "x" }] })),
    ).toBe("page");
    expect(kinMessageLayout(said(FIGURED, { embeds: FIGURES }))).toBe("page");
    expect(kinMessageLayout(said("Two tasks are late.", { embeds: [] }))).toBe("bubble");
    expect(kinMessageLayout(said(FIGURED, { embeds: FIGURES, status: "deleted" }))).toBe("bubble");
  });
});

const FIGURES: NonNullable<KinMessage["embeds"]> = [
  { _tag: "visual", title: "This week", attachmentId: "att_1", height: 90 },
  {
    _tag: "chart",
    chart: { title: "Cash by month" } as unknown as KinChartCardState,
  },
];
const FIGURED = [
  "Two tasks are late and INV-1 is 12 days overdue.",
  "",
  "```kin_visual This week",
  "f_aaaaaaaaaa",
  "```",
  "",
  "## Money",
  "- ₹1.2L came in.",
  "",
  "```kin_chart",
  "f_bbbbbbbbbb",
  "```",
].join("\n");

describe("a page's figures", () => {
  it("copy text names figures by title", () => {
    expect(kinMessageCopyText(said(FIGURED, { embeds: FIGURES }))).toBe(
      [
        "Two tasks are late and INV-1 is 12 days overdue.",
        "",
        "[This week]",
        "",
        "## Money",
        "- ₹1.2L came in.",
        "",
        "[Cash by month]",
      ].join("\n"),
    );
    // A figure the host couldn't draw still says what it was.
    expect(kinMessageCopyText(said("```kin_chart\nf_cccccccccc\n```"))).toBe("[Chart]");
    expect(kinMessageCopyText(said("Done."))).toBe("Done.");
  });

  it("gives a list a page's takeaway, not its figures", () => {
    expect(kinMessageGistMarkdown(said(FIGURED, { embeds: FIGURES }))).toBe(
      "Two tasks are late and INV-1 is 12 days overdue.",
    );
  });

  it("counts each figure as eight lines toward Read more", () => {
    const lines = Array.from({ length: 6 }, (_, at) => `Line ${at}.`).join("\n");
    expect(kinPageCollapses(lines)).toBe(false);
    expect(kinPageCollapses(`${lines}\n\n${FIGURED}`)).toBe(true);
  });

  it("shows a figure still being written as its title", () => {
    expect(
      kinDraftMarkdown(
        "Late.\n\n![This week](kin-figure:f_aaaaaaaaaa)\n![x](https://a.example/x.png)",
      ),
    ).toBe("Late.\n\n*Figure: This week*\n![x](https://a.example/x.png)");
  });
});

const items = (name: string, count: number) =>
  Array.from({ length: count }, (_, at) => `- ${name} ${at + 1} for Ambermill.`).join("\n");
const page = (lead: string, ...sections: ReadonlyArray<readonly [string, number]>) =>
  [lead, ...sections.map(([title, count]) => `## ${title}\n${items(title, count)}`)].join("\n\n");

describe("kinPageCut", () => {
  it.each([
    ["a short page shows whole", page("Ambermill is on track.", ["Today", 3]), null],
    [
      "cuts after the whole sections that fit, naming the one left",
      page("Two things moved.", ["Today", 6], ["Money", 6], ["Open tasks", 6]),
      { shown: 2, clip: false, label: "Read more: Open tasks" },
    ],
    [
      "names two hidden sections and counts the rest",
      page(
        "A busy week.",
        ["Today", 6],
        ["Money", 6],
        ["Tasks", 4],
        ["Clients", 4],
        ["Hiring", 2],
        ["Notes", 2],
      ),
      { shown: 2, clip: false, label: "Read more: Tasks, Clients +2" },
    ],
    [
      "always shows the first section, even past the budget",
      page("Lots to do.", ["Open tasks", 26], ["Clients", 2]),
      { shown: 1, clip: false, label: "Read more: Clients" },
    ],
    [
      "cuts a very long first section at a height, still naming the rest",
      page("Lots to do.", ["Open tasks", 40], ["Clients", 2]),
      { shown: 1, clip: true, label: "Read more: Clients" },
    ],
    [
      "shows a page whole when its one section only runs a little long",
      page("Lots to do.", ["Open tasks", 25]),
      null,
    ],
    [
      "cuts a long page with no sections at a height",
      items("Line", 30),
      { shown: 0, clip: true, label: "Read more" },
    ],
    [
      "counts a figure in a section as eight lines",
      `${page("Cash is fine.", ["Today", 6], ["Money", 3])}\n\n\`\`\`kin_chart\nf_bbbbbbbbbb\n\`\`\`\n\n${page("", ["Clients", 6])}`,
      { shown: 1, clip: false, label: "Read more: Money, Clients" },
    ],
  ])("%s", (_name, body, cut) => {
    expect(kinPageCut(body)).toEqual(cut);
  });

  it("hides a closing line under the last section with that section, and cuts a brief the same way", () => {
    const body = `${page("Good morning Rhea.", ["Needs you", 9], ["Money", 9], ["Open tasks", 4])}\n\nThat's all for today.`;
    expect(kinPageCut(body, true)).toEqual({
      shown: 2,
      clip: false,
      label: "Read more: Open tasks",
    });
  });
});

describe("kinPageView", () => {
  it("cuts a brief into the sections that have something in them, without its greeting", () => {
    const view = kinPageView(BRIEF, true);
    expect(view.lead).toBeNull();
    expect(view.sections.map((section) => section.title)).toEqual([
      "Needs you",
      "Money",
      "Clients",
    ]);
  });

  it("drops only the greeting from a brief's opening line", () => {
    expect(
      kinPageView("Good morning Rhea. A quiet day.\n\n## Needs you\n- Nothing.", true).lead,
    ).toBe("A quiet day.");
  });

  it("keeps today's unsectioned brief whole, as its lead", () => {
    const view = kinPageView("Morning!\nINV-1 is still overdue.\nstill: the logo files.", true);
    expect(view).toEqual({ lead: "INV-1 is still overdue.\nstill: the logo files.", sections: [] });
  });

  it("gives a list the first thing that needs the reader, after the greeting for a brief", () => {
    expect(kinMessageGistMarkdown(said(BRIEF, { form: "brief" }))).toMatch(
      /^Good (morning|afternoon|evening) · INV-1 is 12 days overdue/,
    );
    expect(kinMessageGistMarkdown(said("## Plan\nShip on Friday.\n\n## Risks\nNone."))).toBe(
      "Ship on Friday.",
    );
    // No "Needs you": the brief leads with its first real line; a one-word reply is itself.
    expect(
      kinMessageGistMarkdown(
        said("Good afternoon Rhea.\n\n## Work\nW-2 is due today.", { form: "brief" }),
      ),
    ).toMatch(/^Good (morning|afternoon|evening) · W-2 is due today\.$/);
    expect(kinMessageGistMarkdown(said("Done.", { form: "brief" }))).toBe("Done.");
  });

  it("reads the same line from the server's preview of a page as from its whole body", () => {
    for (const message of [
      said(BRIEF, { form: "brief" }),
      said("## Plan\nShip on Friday.\n\n## Risks\nNone."),
      said("Good afternoon Rhea.\n\n## Work\nW-2 is due today.", { form: "brief" }),
    ]) {
      const preview = {
        gist: kinPageGist(message.body),
        brief: kinIsBrief(message.body, message.form),
      };
      expect(kinMessageGistMarkdown({ ...message, body: "## Plan" }, preview)).toBe(
        kinMessageGistMarkdown(message),
      );
    }
  });
});

describe("kinLinkedMarkdown", () => {
  const links: ReadonlyArray<KinMessageLink> = [
    { text: "Finance", to: { _tag: "chat", chatId: "c" }, note: null },
    {
      text: "Orbit Dental",
      to: { _tag: "record", key: "C-1", kind: "client" },
      note: "Orbit Dental",
    },
    {
      text: "Orbit Dental retainer",
      to: { _tag: "record", key: "P-2", kind: "project" },
      note: "Orbit Dental retainer",
    },
    { text: "INV-1", to: { _tag: "record", key: "INV-1", kind: "entry" }, note: "INV-1" },
  ];

  it("links each text once where it is first written, outside code and existing links", () => {
    const body =
      "`INV-1` and [Finance](https://x.example): the Orbit Dental retainer, then Orbit Dental, INV-1 and Finance.";
    const linked = kinLinkedMarkdown(body, links);
    expect(linked).toBe(
      "`INV-1` and [Finance](https://x.example): the [Orbit Dental retainer](t3-context://v1/kin-link/2), then [Orbit Dental](t3-context://v1/kin-link/1), [INV-1](t3-context://v1/kin-link/3) and [Finance](t3-context://v1/kin-link/0).",
    );
    expect(kinLinkOf("t3-context://v1/kin-link/1", links)?.to).toEqual(links[1]!.to);
    expect(kinLinkOf("t3-context://v1/kin-link/9", links)).toBeNull();
    expect(kinLinkOf("https://x.example", links)).toBeNull();
    expect(kinLinkedMarkdown("Ask Finance.", links, "plain")).toBe("Ask [Finance](kin-link:0).");
    expect(kinLinkOf("kin-link:0", links)?.text).toBe("Finance");
  });

  it("leaves a body with no links as written", () => {
    expect(kinLinkedMarkdown("INV-1", undefined)).toBe("INV-1");
  });
});
