import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import {
  KIN_DEFAULT_ACTION_IDENTIFIER,
  kinActionDelivery,
  kinNotificationRoute,
  kinClearedChat,
  kinSettledNotificationIds,
} from "./kinPushPayload";

const chatLink = "/kin/env-1/kin-default/chats/chat-1";
const deferral = {
  kin: 1,
  orgId: "kin-default",
  chatId: "chat-1",
  widgetId: "deferral:kin-default:item-7",
  revision: 3,
  deepLink: chatLink,
};

function response(input: {
  readonly data: unknown;
  readonly action?: string;
  readonly category?: string | null;
  readonly identifier?: string;
}) {
  return {
    actionIdentifier: input.action ?? KIN_DEFAULT_ACTION_IDENTIFIER,
    notification: {
      request: {
        identifier: input.identifier ?? "note-1",
        content: { data: input.data, categoryIdentifier: input.category ?? null },
      },
    },
  };
}

describe("kinNotificationRoute", () => {
  it.each([
    ["a message", { kin: 1, orgId: "kin-default", chatId: "chat-1", deepLink: chatLink }, chatLink],
    [
      "an encoded host id",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env%201/kin-default/chats/c%2F1" },
      "/kin/env%201/kin-default/chats/c%2F1",
    ],
    // Until MOB-8's KinApproval route, Review opens the chat holding the card.
    [
      "an approval asked in a chat",
      {
        kin: 1,
        orgId: "kin-default",
        chatId: "chat-1",
        pendingActionId: "act-1",
        deepLink: "/kin/env-1/kin-default/actions/act-1",
      },
      chatLink,
    ],
    // The host's approval push names no chat: Waiting on you shows the card in full.
    [
      "an approval with no chat",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/actions/act-1" },
      "/kin/waiting",
    ],
    [
      "a phone that can now approve, or no longer can",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/approvals" },
      "/kin/env-1/kin-default/approvals",
    ],
    [
      "a device linked to the person",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/people/zoya/devices" },
      "/kin/env-1/kin-default/people/zoya/devices",
    ],
    ["JSON-encoded data", JSON.stringify(deferral), chatLink],
    // Each lead's DM and each group is its own chat, so each push opens its own chat.
    [
      "a lead's DM",
      {
        kin: 1,
        orgId: "kin-default",
        chatId: "7ae13b6f-1a49-4bb5-ac5c-6ac6b4300978",
        deepLink: "/kin/env-1/kin-default/chats/7ae13b6f-1a49-4bb5-ac5c-6ac6b4300978",
      },
      "/kin/env-1/kin-default/chats/7ae13b6f-1a49-4bb5-ac5c-6ac6b4300978",
    ],
    [
      "a group",
      {
        kin: 1,
        orgId: "kin-default",
        chatId: "c1f0e2d4-group",
        deepLink: "/kin/env-1/kin-default/chats/c1f0e2d4-group",
      },
      "/kin/env-1/kin-default/chats/c1f0e2d4-group",
    ],
    // What it is about opens over its chat, so Back from it, or a gone entry, lands in the chat.
    [
      "a card, to its message in the chat",
      { ...deferral, subject: { _tag: "message", messageId: "msg 7" } },
      `${chatLink}?message=msg%207`,
    ],
    [
      "a task, to its sheet over the chat",
      { ...deferral, subject: { _tag: "record", key: "W-4", kind: "task" } },
      [chatLink, "/kin/env-1/kin-default/work/W-4"],
    ],
    [
      "an invoice, to its entry over the chat",
      { ...deferral, subject: { _tag: "record", key: "INV-12", kind: "entry" } },
      [chatLink, "/kin/env-1/kin-default/work/INV-12"],
    ],
    [
      "a client, to its page over the chat",
      { ...deferral, subject: { _tag: "record", key: "C-1", kind: "client" } },
      [chatLink, "/kin/env-1/kin-default/clients/C-1"],
    ],
    [
      "a doc, to its page over the chat",
      { ...deferral, subject: { _tag: "record", key: "D-3", kind: "doc" } },
      [chatLink, "/kin/env-1/kin-default/docs/D-3"],
    ],
    [
      "several tasks, to Tasks over the chat",
      { ...deferral, subject: { _tag: "tasks" } },
      [chatLink, "/kin/env-1/kin-default/work"],
    ],
    // A subject a later build sends, or one that isn't well formed, still opens the chat.
    [
      "a subject this build doesn't know, to the chat",
      { ...deferral, subject: { _tag: "meeting", meetingId: "m-1" } },
      chatLink,
    ],
    [
      "a malformed key, to the chat",
      { ...deferral, subject: { _tag: "record", key: "../settings", kind: "task" } },
      chatLink,
    ],
    [
      "a subject on an approval, to where the approval opens",
      {
        kin: 1,
        orgId: "kin-default",
        deepLink: "/kin/env-1/kin-default/approvals",
        subject: { _tag: "record", key: "W-4", kind: "task" },
      },
      "/kin/env-1/kin-default/approvals",
    ],
    // Someone's moves on the reader's tasks come in no chat.
    [
      "someone's moves on several of your tasks, to Tasks",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/work" },
      "/kin/env-1/kin-default/work",
    ],
    [
      "someone's move on one task, to it over Tasks",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/work/W-31" },
      ["/kin/env-1/kin-default/work", "/kin/env-1/kin-default/work/W-31"],
    ],
    [
      "being put on a project, to the project",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/projects/P-2" },
      "/kin/env-1/kin-default/projects/P-2",
    ],
  ])("routes %s", (_name, data, path) => {
    const route = kinNotificationRoute(response({ data }));
    expect(route?.paths).toEqual(typeof path === "string" ? [path] : path);
    expect(route?.act).toBeNull();
  });

  it.each([
    ["a thread link", { ...deferral, deepLink: "/threads/env-1/thread-1" }],
    ["a protocol-relative link", { ...deferral, deepLink: "//evil.example/kin/x" }],
    ["an empty segment", { ...deferral, deepLink: "/kin//kin-default/chats/chat-1" }],
    ["a query string", { ...deferral, deepLink: `${chatLink}?next=/settings` }],
    ["an unknown kind", { ...deferral, deepLink: "/kin/env-1/kin-default/settings/x" }],
    ["another org's link", { ...deferral, deepLink: "/kin/env-1/other-org/chats/chat-1" }],
    ["a link to another chat", { ...deferral, deepLink: "/kin/env-1/kin-default/chats/chat-2" }],
    ["a dot segment", { ...deferral, deepLink: "/kin/../kin-default/chats/chat-1" }],
    ["an encoded dot segment", { ...deferral, deepLink: "/kin/%2E%2E/kin-default/chats/chat-1" }],
    ["a trailing segment", { ...deferral, deepLink: `${chatLink}/extra` }],
    ["another org's approvals", { ...deferral, deepLink: "/kin/env-1/other-org/approvals" }],
    ["another org's Tasks", { ...deferral, deepLink: "/kin/env-1/other-org/work" }],
    [
      "another org's devices",
      { ...deferral, deepLink: "/kin/env-1/other-org/people/zoya/devices" },
    ],
    [
      "a person's other page",
      { ...deferral, deepLink: "/kin/env-1/kin-default/people/zoya/notes" },
    ],
    [
      "a link to another approval",
      {
        kin: 1,
        orgId: "kin-default",
        pendingActionId: "act-1",
        deepLink: "/kin/env-1/kin-default/actions/act-2",
      },
    ],
    ["a missing version", { ...deferral, kin: undefined }],
    ["malformed JSON", '{"kin":1,'],
    ["an upstream agent push", { environmentId: "env-1", threadId: "thread-1" }],
    ["no data", undefined],
  ])("drops %s", (_name, data) => {
    expect(kinNotificationRoute(response({ data }))).toBeNull();
  });

  it("turns a deferral button into the card's own widget action", () => {
    const route = kinNotificationRoute(
      response({ data: deferral, action: "monday", category: "kin.deferral.heads_up" }),
    );
    expect(route).toEqual({
      responseKey: "note-1\u0000monday",
      environmentId: "env-1",
      paths: [chatLink],
      act: {
        widgetId: "deferral:kin-default:item-7",
        revision: 3,
        actionId: "monday",
        value: "item-7",
        clientActionId: "push:note-1:monday",
      },
    });
  });

  it("acts once per notification and button, whichever path delivers it", () => {
    const monday = (identifier: string) =>
      kinNotificationRoute(
        response({
          data: deferral,
          action: "monday",
          category: "kin.deferral.heads_up",
          identifier,
        }),
      );
    expect(monday("note-1")?.act?.clientActionId).toBe(monday("note-1")?.act?.clientActionId);
    expect(monday("note-1")?.act?.clientActionId).not.toBe(monday("note-2")?.act?.clientActionId);
    const banner = kinNotificationRoute(
      response({ data: deferral, category: "kin.deferral.heads_up" }),
    );
    expect(banner?.responseKey).not.toBe(monday("note-1")?.responseKey);
  });

  it.each([
    ["a button the category doesn't show", "monday", "kin.deferral.confirmed", deferral],
    ["Review, which only opens", "review", "kin.approval", deferral],
    [
      "a widget that isn't a deferral",
      "monday",
      "kin.deferral.heads_up",
      { ...deferral, widgetId: "task:1" },
    ],
    [
      "a deferral widget with no item",
      "monday",
      "kin.deferral.heads_up",
      { ...deferral, widgetId: "deferral:kin-default:" },
    ],
    [
      "a push without a revision",
      "monday",
      "kin.deferral.heads_up",
      { ...deferral, revision: undefined },
    ],
    [
      "a revision the host can't accept",
      "monday",
      "kin.deferral.heads_up",
      { ...deferral, revision: 0 },
    ],
  ])("opens the chat without acting for %s", (_name, action, category, data) => {
    const route = kinNotificationRoute(response({ data, action, category }));
    expect(route?.paths).toEqual([chatLink]);
    expect(route?.act).toBeNull();
  });
});

describe("kinActionDelivery", () => {
  const host = EnvironmentId.make("env-1");
  const ready = {
    hostEnvironmentId: host,
    targetEnvironmentId: host,
    connected: true,
    inFlight: false,
  };
  it.each([
    ["posts a tap for the connected Kin host", ready, "post"],
    [
      "drops a tap from another host",
      { ...ready, targetEnvironmentId: EnvironmentId.make("env-2") },
      "drop",
    ],
    [
      "drops another host's tap even while disconnected",
      { ...ready, targetEnvironmentId: EnvironmentId.make("env-2"), connected: false },
      "drop",
    ],
    ["waits until this phone knows its Kin host", { ...ready, hostEnvironmentId: null }, "wait"],
    ["waits for the host to connect", { ...ready, connected: false }, "wait"],
    ["waits while the same tap is in flight", { ...ready, inFlight: true }, "wait"],
  ] as const)("%s", (_name, input, delivery) => {
    expect(kinActionDelivery(input)).toBe(delivery);
  });
});

describe("kinClearedChat", () => {
  const read = {
    kin: 1,
    orgId: "kin-default",
    chatId: "chat-1",
    deepLink: "/kin/env-1/kin-default/chats/chat-1",
  };
  it.each([
    ["a read that left the chat with nothing unread", { ...read, cleared: true }, "chat-1"],
    ["a read with something still unread", read, null],
    ["a link to another chat than it names", { ...read, cleared: true, chatId: "chat-2" }, null],
  ] as const)("%s", (_name, body, chatId) => {
    const cleared = kinClearedChat({ data: { dataString: JSON.stringify(body) }, aps: {} });
    expect(cleared?.chatId ?? null).toBe(chatId);
    if (chatId !== null) expect(cleared?.environmentId).toBe("env-1");
  });
});

describe("kinSettledNotificationIds", () => {
  it("picks this host's notifications for settled chats only", () => {
    const note = (identifier: string, data: unknown) => ({
      request: { identifier, content: { data } },
    });
    const message = (chatId: string, environmentId = "env-1") => ({
      kin: 1,
      orgId: "kin-default",
      chatId,
      deepLink: `/kin/${environmentId}/kin-default/chats/${chatId}`,
    });
    const presented = [
      note("read", message("chat-1")),
      note("unread", message("chat-2")),
      note("read-card", { ...deferral, chatId: "chat-1" }),
      note("other-host", message("chat-1", "env-2")),
      // Upstream's thread notifications, and an approval no chat asked for.
      note("t3", { deepLink: "/threads/1" }),
      note("approval", {
        kin: 1,
        orgId: "kin-default",
        deepLink: "/kin/env-1/kin-default/approvals",
      }),
      // A remote push's data arrives as a JSON string.
      note("read-json", JSON.stringify(message("chat-1"))),
    ];
    expect(
      kinSettledNotificationIds(presented, EnvironmentId.make("env-1"), (id) => id === "chat-1"),
    ).toEqual(["read", "read-card", "read-json"]);
  });
});
