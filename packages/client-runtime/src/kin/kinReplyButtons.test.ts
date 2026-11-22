import {
  KinAgentId,
  KinChatId,
  KinMemberId,
  KinPersonId,
  ThreadId,
  type KinMessage,
  type KinMessageLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinReplyButtons } from "./kinReplyButtons.ts";

// Invented Ambermill names only.
const here = KinChatId.make("chat-finance");
const agent: KinMessage["author"] = {
  _tag: "agent",
  agentId: KinAgentId.make("finance"),
  memberId: KinMemberId.make("member-finance"),
  ownerPersonId: KinPersonId.make("rhea"),
  threadId: ThreadId.make("thread-finance"),
};
const human: KinMessage["author"] = {
  _tag: "human",
  personId: KinPersonId.make("meera"),
  memberId: KinMemberId.make("member-meera"),
};
const task = (text: string, key = text): KinMessageLink => ({
  text,
  to: { _tag: "record", key, kind: "task" },
  note: `${text} · Open`,
});
const client = (text: string, key: string): KinMessageLink => ({
  text,
  to: { _tag: "record", key, kind: "client" },
  note: text,
});
const person = (text: string): KinMessageLink => ({
  text,
  to: { _tag: "person", personId: text.toLowerCase() },
  note: null,
});
const chat = (text: string, chatId: string): KinMessageLink => ({
  text,
  to: { _tag: "chat", chatId },
  note: null,
});
const settings: KinMessageLink = { text: "Settings", to: { _tag: "settings" }, note: null };

const reply = (
  links: ReadonlyArray<KinMessageLink> | undefined,
  extra: Partial<Pick<KinMessage, "author" | "kind" | "status" | "form">> = {},
) => ({
  author: agent,
  kind: "text" as const,
  status: "posted" as const,
  chatId: here,
  ...(links === undefined ? {} : { links }),
  ...extra,
});
const labels = (message: ReturnType<typeof reply>) => kinReplyButtons(message).map((b) => b.label);

describe("the buttons under an agent's reply", () => {
  it.each([
    ["no links", reply(undefined), []],
    ["an empty list", reply([]), []],
    ["a person's message", reply([task("W-7")], { author: human }), []],
    ["a system line", reply([task("W-7")], { author: { _tag: "system" }, kind: "system" }), []],
    ["a deleted reply", reply([task("W-7")], { status: "deleted" }), []],
    ["a suggested reply", reply([task("W-7")], { status: "suggested" }), []],
    ["a brief", reply([task("W-7")], { form: "brief" }), []],
    ["only Settings", reply([settings]), []],
    ["the chat it is in", reply([chat("Finance", here)]), []],
    ["one task", reply([task("W-7")]), ["Open W-7"]],
    [
      "records before chats before people, each in the reply's order",
      reply([
        person("Meera"),
        chat("Growth", "chat-growth"),
        task("Logo files", "W-3"),
        client("Harbourline", "C-2"),
      ]),
      ["Open Logo files", "Open Harbourline", "Open Growth"],
    ],
    [
      "at most three",
      reply([task("W-1"), task("W-2"), task("W-3"), task("W-4")]),
      ["Open W-1", "Open W-2", "Open W-3"],
    ],
    [
      "one target named twice, kept as first written",
      reply([
        chat("Growth", "chat-growth"),
        chat("growth chat", "chat-growth"),
        task("Logo files", "W-3"),
        task("W-3"),
      ]),
      ["Open Logo files", "Open Growth"],
    ],
    ["a person after records", reply([person("Dev"), task("W-7")]), ["Open W-7", "Open Dev"]],
  ])("%s", (_name, message, expected) => {
    expect(labels(message)).toEqual(expected);
  });

  it("carries the target the host gave, and its line", () => {
    expect(kinReplyButtons(reply([task("Logo files", "W-3")]))).toEqual([
      {
        id: "record:W-3",
        label: "Open Logo files",
        note: "Logo files · Open",
        to: { _tag: "record", key: "W-3", kind: "task" },
      },
    ]);
  });
});
