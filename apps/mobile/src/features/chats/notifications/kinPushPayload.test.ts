import { describe, expect, it } from "vite-plus/test";

import { KIN_DEFAULT_ACTION_IDENTIFIER, kinNotificationRoute } from "./kinPushPayload";

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
    [
      "an approval with no chat",
      { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/actions/act-1" },
      "/kin",
    ],
    ["JSON-encoded data", JSON.stringify(deferral), chatLink],
  ])("routes %s", (_name, data, path) => {
    const route = kinNotificationRoute(response({ data }));
    expect(route?.path).toBe(path);
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
      path: chatLink,
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
    expect(route?.path).toBe(chatLink);
    expect(route?.act).toBeNull();
  });
});
