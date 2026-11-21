import {
  KinChatId,
  KinMessageId,
  KinRecordId,
  type KinRecordLink,
  type KinRecordRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinLinked } from "./kinLinked.ts";

const at = "2026-11-12T06:00:00.000Z";
const ref = (key: string, title = `${key} title`): KinRecordRef => ({
  recordId: KinRecordId.make(`rec_${key}`),
  key,
  title,
});
const recordLink = (key: string): KinRecordLink => ({
  kind: "record",
  relation: "relates",
  target: `rec_${key}`,
  chatId: null,
  label: null,
  createdAt: at,
  record: ref(key),
});
const chatId = KinChatId.make("chat_team");
const opens = (key: string, kind: string) => ({ _tag: "record", chatId: null, key, kind });

describe("kinLinked", () => {
  it.each([
    // The K082 cause: a doc a task links to opened as a task.
    [
      "a doc W-1 links to opens the doc",
      { links: [recordLink("D-11")] },
      "docs",
      opens("D-11", "doc"),
    ],
    [
      "a doc linking to W-1 opens the doc",
      { linkedFrom: [recordLink("D-11")] },
      "docs",
      opens("D-11", "doc"),
    ],
    [
      "a task linking here opens the task",
      { linkedFrom: [recordLink("W-2")] },
      "tasks",
      opens("W-2", "task"),
    ],
    ["a milestone is a task", { milestone: ref("M-3") }, "tasks", opens("M-3", "task")],
    ["a project opens the project", { project: ref("P-4") }, "projects", opens("P-4", "project")],
    ["a client opens the client", { party: ref("C-5") }, "client", opens("C-5", "client")],
    ["an invoice is money", { links: [recordLink("INV-6")] }, "money", opens("INV-6", "entry")],
    ["a quote is money", { linkedFrom: [recordLink("QT-7")] }, "money", opens("QT-7", "entry")],
    [
      "a defined list's entry is money",
      { links: [recordLink("EXP-8")] },
      "money",
      opens("EXP-8", "entry"),
    ],
    [
      "a contact is people, opened as chat's links do",
      { links: [recordLink("CT-9")] },
      "people",
      opens("CT-9", "entry"),
    ],
    [
      "a message opens its chat at that message",
      {
        links: [
          {
            kind: "message",
            relation: "source",
            target: "msg_1",
            chatId,
            label: "Asked here",
            createdAt: at,
          },
        ],
      },
      "chats",
      { _tag: "chat", chatId, messageId: KinMessageId.make("msg_1") },
    ],
    [
      "a message in a chat this reader isn't in is told, and opens nothing",
      {
        links: [
          {
            kind: "message",
            relation: "source",
            target: "msg_1",
            chatId: null,
            label: null,
            createdAt: at,
            closedChat: { agent: "Chief of staff" },
          },
        ],
      },
      "chats",
      null,
    ],
  ] as const)("%s", (_name, detail, group, open) => {
    const { groups } = kinLinked({ key: "W-1", links: [], ...detail });
    expect(groups.map((one) => one.group)).toEqual([group]);
    expect(groups[0]!.items[0]!.open).toEqual(open);
  });

  it("words a chat this reader isn't in with its agent, or as a chat when it had none", () => {
    const closed = (agent: string | null): KinRecordLink => ({
      kind: "message",
      relation: "source",
      target: `msg_${agent ?? "none"}`,
      chatId: null,
      label: null,
      createdAt: at,
      closedChat: { agent },
    });
    const { groups } = kinLinked({ key: "D-1", links: [closed("Chief of staff"), closed(null)] });
    expect(groups[0]!.items.map((item) => item.title)).toEqual([
      "Where this came from: a chat with Chief of staff",
      "Where this came from: a chat",
    ]);
    // A link with no chat and no word of one stays out, as before.
    const { closedChat: _told, ...bare } = closed(null);
    expect(kinLinked({ key: "D-1", links: [bare] }).groups).toEqual([]);
  });

  it("names an issued entry by its number and one without a number by its key", () => {
    const { groups } = kinLinked({
      key: "W-1",
      links: [{ ...recordLink("INV-6"), number: "AM/26-27/004" }, recordLink("INV-9")],
    });
    expect(groups[0]!.items.map((item) => [item.key, item.name])).toEqual([
      ["INV-6", "AM/26-27/004"],
      ["INV-9", "INV-9"],
    ]);
  });

  it("orders groups, drops itself, repeats and what opens nowhere, and caps each group", () => {
    const tasks = ["W-2", "W-3", "W-4", "W-5", "W-6", "W-7", "W-8"];
    const detail = {
      key: "D-11",
      party: ref("C-5"),
      links: [
        recordLink("W-2"),
        recordLink("D-11"),
        {
          kind: "url",
          relation: "relates",
          target: "https://example.com",
          chatId: null,
          label: null,
          createdAt: at,
        },
        { ...recordLink("W-99"), record: undefined },
      ],
      linkedFrom: tasks.map(recordLink),
      linkedFromMore: 10,
    } as const;
    const { groups, unlisted } = kinLinked(detail);
    expect(groups.map((one) => [one.group, one.items.map((item) => item.key), one.more])).toEqual([
      ["tasks", ["W-2", "W-3", "W-4", "W-5", "W-6"], 2],
      ["client", ["C-5"], 0],
    ]);
    expect(unlisted).toBe(10);
    expect(kinLinked(detail, 5, { expanded: new Set(["tasks"]) }).groups[0]).toMatchObject({
      items: tasks.map((key) => ({ key })),
      more: 0,
    });
  });

  it("leaves out the parents a screen shows already, unless one is also really linked", () => {
    const detail = {
      key: "W-1",
      party: ref("C-5"),
      project: ref("P-4"),
      milestone: ref("M-3"),
      links: [recordLink("W-2")],
      linkedFrom: [recordLink("P-4")],
    } as const;
    const keys = (shown: boolean) =>
      kinLinked(detail, 5, { parentsShown: shown }).groups.flatMap((group) =>
        group.items.map((item) => item.key),
      );
    expect(keys(false)).toEqual(["M-3", "W-2", "P-4", "C-5"]);
    expect(keys(true)).toEqual(["W-2", "P-4"]);
  });
});
