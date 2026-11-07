import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Kin from "./kinChat.ts";

const at = "2026-11-07T00:00:00.000Z";
const person = {
  personId: "person-1",
  orgId: "org-1",
  handle: "owner",
  displayName: "Owner",
  githubLogin: null,
};
const org = { orgId: "org-1", name: "Kin", createdAt: at };
const agent = {
  agentId: "agent-1",
  orgId: "org-1",
  displayName: "Lead",
  role: "lead",
  ownerPersonId: "person-1",
};
const principals = [
  { _tag: "person", personId: "person-1" },
  { _tag: "agent", agentId: "agent-1" },
];
const authors = [
  { _tag: "human", personId: "person-1", memberId: "member-1" },
  {
    _tag: "agent",
    agentId: "agent-1",
    memberId: "member-2",
    ownerPersonId: "person-1",
    threadId: "thread-1",
  },
  { _tag: "system" },
];
const chat = {
  orgId: "org-1",
  chatId: "chat-1",
  kind: "direct",
  title: null,
  teamId: null,
  lastSeq: 1,
  lastMessageAt: at,
  createdAt: at,
  archivedAt: null,
};
const member = {
  orgId: "org-1",
  chatId: "chat-1",
  memberId: "member-1",
  principal: principals[0],
  role: "owner",
  joinedAt: at,
  leftAt: null,
  mutedUntil: null,
};
const message = {
  orgId: "org-1",
  chatId: "chat-1",
  messageId: "message-1",
  seq: 1,
  author: authors[0],
  authorRole: "owner",
  kind: "text",
  body: "Hello",
  intent: null,
  mentions: [],
  replyTo: null,
  widgetId: null,
  floorRunId: null,
  status: "posted",
  sentBy: null,
  createdAt: at,
  editedAt: null,
};
const task = {
  taskId: "task-1",
  environmentId: "env-1",
  threadId: "thread-1",
  remoteEnvironmentId: null,
  title: "Build contracts",
  model: null,
  status: "working",
  pullRequests: [{ url: "https://github.com/GLDRoger/t3code/pull/1", number: 1 }],
  lastError: null,
  updatedAt: at,
};
const widget = {
  orgId: "org-1",
  chatId: "chat-1",
  widgetId: "widget-1",
  messageId: "message-1",
  widgetClass: "native",
  type: "task",
  revision: 1,
  state: task,
  source: null,
  feed: null,
  awaiting: ["person-1"],
  pinnedAt: null,
  closedAt: null,
  updatedAt: at,
};
const waiting = {
  waitingId: "waiting-1",
  orgId: "org-1",
  personId: "person-1",
  chatId: "chat-1",
  messageId: "message-1",
  widgetId: null,
  reason: "question",
  createdAt: at,
  resolvedAt: null,
  resolution: null,
};
const summary = { ...chat, members: [member], lastMessage: message, unread: 1 };
const send = { chatId: "chat-1", clientMessageId: "client-1", body: "Hello" };

type SchemaName = {
  [K in keyof typeof Kin]: (typeof Kin)[K] extends Schema.Top ? K : never;
}[keyof typeof Kin];

const samples = {
  KinOrgId: ["org-1"],
  KinPersonId: ["person-1"],
  KinAgentId: ["agent-1"],
  KinChatId: ["chat-1"],
  KinMemberId: ["member-1"],
  KinMessageId: ["message-1"],
  KinWidgetId: ["widget-1"],
  KinWaitingId: ["waiting-1"],
  KinChatKind: Kin.KinChatKind.literals,
  KinRole: Kin.KinRole.literals,
  KinAgentRole: Kin.KinAgentRole.literals,
  KinAgentIntent: Kin.KinAgentIntent.literals,
  KinMessageKind: Kin.KinMessageKind.literals,
  KinMessageStatus: Kin.KinMessageStatus.literals,
  KinWidgetClass: Kin.KinWidgetClass.literals,
  KinNativeCardType: Kin.KinNativeCardType.literals,
  KinWaitingReason: Kin.KinWaitingReason.literals,
  KinOrg: [org],
  KinPerson: [person, { ...person, githubLogin: "owner" }],
  KinAgent: [agent],
  KinChat: [chat],
  KinPrincipal: principals,
  KinChatMember: [member],
  KinAuthor: authors,
  KinMessage: authors.map((author) => ({ ...message, author })),
  KinWidget: [
    widget,
    { ...widget, widgetClass: "generated", source: { threadId: "thread-1", itemId: "item-1" } },
    { ...widget, widgetClass: "live", feed: { kind: "build", key: "build-1" } },
  ],
  KinTaskCardState: [task],
  KinWaitingItem: [
    waiting,
    { ...waiting, messageId: null, widgetId: "widget-1", resolvedAt: at, resolution: "superseded" },
  ],
  KinChatSummary: [summary, { ...summary, lastMessage: null }],
  KinChatListEvent: [
    { _tag: "snapshot", chats: [summary], waiting: [waiting] },
    { _tag: "chat", chat: summary },
    { _tag: "waiting", item: waiting },
  ],
  KinChatStreamEvent: [
    { _tag: "backlog", messages: [message], widgets: [widget], lastSeq: 1 },
    { _tag: "reset", lastSeq: 1 },
    { _tag: "message", message },
    { _tag: "widget", widget },
    { _tag: "member", member },
    { _tag: "read", memberId: "member-1", seq: 1 },
  ],
  KinOrgsListInput: [{}],
  KinOrgsListResult: [
    {
      orgs: [
        {
          ...org,
          agents: [
            { agentId: "agent-1", displayName: "Lead", retired: false },
            { agentId: "agent-retired", displayName: "Retired", retired: true },
          ],
        },
      ],
      me: [{ orgId: "org-1", personId: "person-1" }],
    },
    { orgs: [{ ...org, agents: [] }], me: [] },
  ],
  KinChatsSubscribeInput: [{}, { orgId: "org-1" }],
  KinChatsCreateDirectInput: [{ orgId: "org-1", agentId: "agent-1" }],
  KinChatSubscribeInput: [{ chatId: "chat-1" }, { chatId: "chat-1", afterSeq: 0 }],
  KinChatHistoryInput: [{ chatId: "chat-1", beforeSeq: 2, limit: 100 }],
  KinChatHistoryResult: [{ messages: [message], widgets: [widget], hasMore: false }],
  KinMessagesSendInput: [send, { ...send, mentions: ["member-2"], replyTo: "message-1" }],
  KinMessagesMarkReadInput: [{ chatId: "chat-1", seq: 1 }],
  KinMessagesMarkReadResult: [{}],
  KinWidgetsActInput: [
    { widgetId: "widget-1", revision: 1, actionId: "open", clientActionId: "action-1" },
    {
      widgetId: "widget-1",
      revision: 1,
      actionId: "choose",
      value: { choice: 1 },
      clientActionId: "action-2",
    },
  ],
  KinChatError: [
    "not_found",
    "not_allowed",
    "unavailable",
    "widget_changed",
    "use_approvals",
    "invalid_state",
    "limit",
    "floor_not_granted",
    "floor_closed",
  ].map((reason) => ({ _tag: "KinChatError", reason, message: "Cannot do that" })),
} satisfies Record<SchemaName, ReadonlyArray<unknown>>;

const decodeSend = Schema.decodeUnknownSync(Kin.KinMessagesSendInput);
const decodeHistory = Schema.decodeSync(Kin.KinChatHistoryInput);

describe("Kin chat contracts", () => {
  it.each(Object.entries(samples))("round-trips %s", (name, values) => {
    const schema: Schema.Codec<unknown> = Kin[name as SchemaName];
    const decode = Schema.decodeUnknownSync(schema);
    const encode = Schema.encodeUnknownSync(schema);
    for (const wire of values) {
      const decoded = decode(wire);
      expect(encode(decoded)).toEqual(wire);
      expect(decode(encode(decoded))).toEqual(decoded);
    }
  });

  it("discards a client-supplied author", () => {
    const payload: unknown = { ...send, author: authors[1] };
    expect(decodeSend(payload)).toEqual(send);
  });

  it.each(["", "  \n ", "x".repeat(16_001)])("rejects send body %j", (body) => {
    expect(() => decodeSend({ ...send, body })).toThrow();
  });

  it.each([0, 101, 1.5])("rejects history limit %s", (limit) => {
    expect(() => decodeHistory({ chatId: "chat-1", beforeSeq: 2, limit })).toThrow();
  });

  it("formats a citable message link", () => {
    expect(
      Kin.kinMessageLink({
        orgId: Kin.KinOrgId.make("org-1"),
        chatId: Kin.KinChatId.make("chat-1"),
        messageId: Kin.KinMessageId.make("message-1"),
      }),
    ).toBe("kin-chat://org-1/chat-1/message-1");
  });
});
