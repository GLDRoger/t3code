import { KinChatId, KinMessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinNotificationDestination } from "./kinNotificationDestination.ts";

const chatId = KinChatId.make("chat_team");
const messageId = KinMessageId.make("msg_7");

describe("kinNotificationDestination", () => {
  it.each([
    ["a chat with no subject", chatId, undefined, { _tag: "chat", chatId, messageId: null }],
    [
      "a card to its message in the chat",
      chatId,
      { _tag: "message", messageId },
      { _tag: "chat", chatId, messageId },
    ],
    [
      "an entry to its own screen, the chat under it",
      chatId,
      { _tag: "record", key: "W-4", kind: "task" },
      { _tag: "record", chatId, key: "W-4", kind: "task" },
    ],
    [
      "an entry with no chat",
      undefined,
      { _tag: "record", key: "INV-2", kind: "entry" },
      { _tag: "record", chatId: null, key: "INV-2", kind: "entry" },
    ],
    [
      "several of the reader's tasks to their Tasks, the chat under it",
      chatId,
      { _tag: "tasks" },
      { _tag: "tasks", chatId },
    ],
    [
      "the reader's tasks with no chat",
      undefined,
      { _tag: "tasks" },
      { _tag: "tasks", chatId: null },
    ],
    // A later build's subject, or a malformed one, still opens the chat.
    [
      "an unknown subject to the chat",
      chatId,
      { _tag: "meeting", meetingId: "m1" },
      { _tag: "chat", chatId, messageId: null },
    ],
    [
      "a bad key to the chat",
      chatId,
      { _tag: "record", key: "w-4); drop", kind: "task" },
      { _tag: "chat", chatId, messageId: null },
    ],
    ["nothing without a chat or subject", undefined, undefined, null],
  ] as const)("lands %s", (_name, chat, subject, expected) => {
    expect(kinNotificationDestination({ chatId: chat, subject })).toEqual(expected);
  });
});
