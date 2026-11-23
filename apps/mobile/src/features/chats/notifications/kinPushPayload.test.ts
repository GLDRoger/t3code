import { describe, expect, it } from "vite-plus/test";

import { kinChoiceActInput } from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { EnvironmentId, KinOrgId, KinWidgetId, type KinPushTopic } from "@t3tools/contracts";

import {
  KIN_DEFAULT_ACTION_IDENTIFIER,
  kinActionDelivery,
  kinNotificationRoute,
  kinClearedChat,
  kinDeliveredTopics,
  kinIsSilentPush,
  kinReconcileRemovals,
  kinSettledNotificationIds,
  kinWithdrawal,
  kinWithdrawnIds,
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
  readonly date?: number;
}) {
  return {
    actionIdentifier: input.action ?? KIN_DEFAULT_ACTION_IDENTIFIER,
    notification: {
      ...(input.date === undefined ? {} : { date: input.date }),
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

  it("answers a two-answer question as a tap on its card would", () => {
    const question = {
      kin: 1,
      orgId: "kin-default",
      chatId: "chat-1",
      widgetId: "w-ask",
      revision: 1,
      choices: ["option-1", "option-2"],
      subject: { _tag: "message", messageId: "msg-ask" },
      deepLink: chatLink,
    };
    const answer = (action: string, data: object = question) =>
      kinNotificationRoute(response({ data, action, category: "kin.choice" }));
    for (const [action, optionId] of [
      ["answer_1", "option-1"],
      ["answer_2", "option-2"],
    ] as const)
      expect(answer(action)).toEqual({
        responseKey: `note-1\u0000${action}`,
        environmentId: "env-1",
        // Opened at the card, which shows the answer once the host records it.
        paths: [`${chatLink}?message=msg-ask`],
        act: kinChoiceActInput(
          { widgetId: KinWidgetId.make("w-ask"), revision: 1 },
          optionId,
          `push:note-1:${action}`,
        ),
      });
    // On Android the app draws the banner from FCM's data: the same answer, under FCM's id.
    expect(
      kinNotificationRoute(
        response({
          data: question,
          action: "answer_2",
          category: "kin.choice",
          identifier: "0:1794096000%fcm",
        }),
      )?.act,
    ).toEqual(
      kinChoiceActInput(
        { widgetId: KinWidgetId.make("w-ask"), revision: 1 },
        "option-2",
        "push:0:1794096000%fcm:answer_2",
      ),
    );
    // The banner itself, or a push without its choices, opens the card and answers nothing.
    expect(answer(KIN_DEFAULT_ACTION_IDENTIFIER)?.act).toBeNull();
    expect(answer("answer_2", { ...question, choices: undefined })?.act).toBeNull();
    // A build that doesn't know the category opens the card from either button.
    expect(
      kinNotificationRoute(response({ data: question, action: "answer_1", category: "kin.later" })),
    ).toMatchObject({ paths: [`${chatLink}?message=msg-ask`], act: null });
  });

  it("acts once per delivery and button, whichever path delivers it", () => {
    const monday = (identifier: string, date?: number) =>
      kinNotificationRoute(
        response({
          data: deferral,
          action: "monday",
          category: "kin.deferral.heads_up",
          identifier,
          ...(date === undefined ? {} : { date }),
        }),
      );
    expect(monday("note-1")?.act?.clientActionId).toBe(monday("note-1")?.act?.clientActionId);
    expect(monday("note-1")?.act?.clientActionId).not.toBe(monday("note-2")?.act?.clientActionId);
    const banner = kinNotificationRoute(
      response({ data: deferral, category: "kin.deferral.heads_up" }),
    );
    expect(banner?.responseKey).not.toBe(monday("note-1")?.responseKey);
    // A chat's pushes share its collapse id as their identifier; only the date tells them apart.
    const tap = (date: number) =>
      kinNotificationRoute(response({ data: deferral, identifier: "kin:7d82459c4d43", date }));
    expect(tap(1795000000.25)?.responseKey).toBe(tap(1795000000.25)?.responseKey);
    expect(tap(1795000090.5)?.responseKey).not.toBe(tap(1795000000.25)?.responseKey);
    expect(monday("kin:7d82459c4d43", 1795000090.5)?.act?.clientActionId).not.toBe(
      monday("kin:7d82459c4d43", 1795000000.25)?.act?.clientActionId,
    );
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
    // Android's background task gets FCM's message, its data map holding the same body.
    const android = kinClearedChat({
      messageId: "0:1794096000%fcm",
      data: { body: JSON.stringify(body), dataString: JSON.stringify(body) },
      notification: null,
    });
    expect(android).toEqual(cleared);
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
      // One that names its topic is the host's to settle: a question in a read chat still waits.
      note("question-open", { ...message("chat-1"), topic: "q:q-7", version: 1 }),
      note("chat-topic", { ...message("chat-1"), topic: "c:chat-1", version: 2 }),
    ];
    expect(
      kinSettledNotificationIds(presented, EnvironmentId.make("env-1"), (id) => id === "chat-1"),
    ).toEqual(["read", "read-card", "read-json"]);
  });
});

describe("kinWithdrawal", () => {
  const silent = {
    kin: 1,
    orgId: "kin-default",
    deepLink: "/kin/env-1/kin-default/work",
    withdraw: [
      { topic: "c:chat-1", version: 3 },
      { topic: "w:card-7", version: 1 },
    ],
  };
  it.each([
    ["a host's withdrawal", silent, silent.withdraw],
    ["a read's badge, from a host before topics", { ...silent, withdraw: undefined }, null],
    ["nothing to withdraw", { ...silent, withdraw: [] }, null],
    ["a topic that isn't one", { ...silent, withdraw: [{ topic: "chat 1", version: 1 }] }, null],
    ["a topic with no version", { ...silent, withdraw: ["c:chat-1"] }, null],
    ["a link that is no Kin path", { ...silent, deepLink: "/threads/1" }, null],
  ] as const)("%s", (_name, body, withdraw) => {
    const ios = kinWithdrawal({ data: { dataString: JSON.stringify(body) }, aps: {} });
    expect(ios?.withdraw ?? null).toEqual(withdraw);
    if (withdraw !== null) expect(ios?.environmentId).toBe("env-1");
    const android = kinWithdrawal({
      messageId: "0:1794096000%fcm",
      data: { body: JSON.stringify(body), dataString: JSON.stringify(body) },
      notification: null,
    });
    expect(android).toEqual(ios);
  });
});

describe("kinWithdrawnIds", () => {
  it("removes this host's notifications the host settled, and keeps the rest", () => {
    const note = (identifier: string, data: unknown) => ({
      request: { identifier, content: { data } },
    });
    const about = (
      topic: string | undefined,
      environmentId = "env-1",
      orgId = "kin-default",
      version = 1,
    ) => ({
      kin: 1,
      orgId,
      chatId: "chat-1",
      deepLink: `/kin/${environmentId}/${orgId}/chats/chat-1`,
      ...(topic === undefined ? {} : { topic, version }),
    });
    const presented = [
      note("chat", about("c:chat-1")),
      note("card", JSON.stringify(about("w:card-7", "env-1", "kin-default", 2))),
      note("question", about("q:q-1")),
      // Shown after the withdrawal below was sent: a newer push about the same thing.
      note("approval-v4", about("a:act-1", "env-1", "kin-default", 4)),
      // Sent before this build matched by topic, from another host, and upstream's own.
      note("older", about(undefined)),
      note("other-host", about("c:chat-1", "env-2")),
      note("other-org", about("c:chat-1", "env-1", "other-org")),
      note("t3", { deepLink: "/threads/1" }),
    ];
    const env = EnvironmentId.make("env-1");
    const here = { environmentId: env, orgId: KinOrgId.make("kin-default") };
    // What the phone asks about: only this host's topics.
    expect(kinDeliveredTopics(presented, env).map((one) => [one.topic, one.version])).toEqual([
      ["c:chat-1", 1],
      ["w:card-7", 2],
      ["q:q-1", 1],
      ["a:act-1", 4],
      ["c:chat-1", 1],
    ]);
    // The host's answer: the chat was read and the card answered, at or after what is shown; the
    // question still waits; the approval was withdrawn at version 3, before version 4 was sent.
    // The same chat id in another company on this host is not touched.
    const withdrawn = (topic: string, version: number) => ({
      topic: topic as KinPushTopic,
      version,
    });
    expect(
      kinWithdrawnIds(presented, here, [
        withdrawn("c:chat-1", 1),
        withdrawn("w:card-7", 5),
        withdrawn("a:act-1", 3),
        withdrawn("a:never-shown", 1),
      ]),
    ).toEqual(["chat", "card"]);
    // Withdrawn at an older version than the one shown: kept.
    expect(kinWithdrawnIds(presented, here, [withdrawn("w:card-7", 1)])).toEqual([]);
    expect(kinWithdrawnIds(presented, here, [])).toEqual([]);
  });
});

describe("kinIsSilentPush", () => {
  const delivered = (content: object) => ({ request: { identifier: "n", content } });
  const data = { kin: 1, orgId: "kin-default", deepLink: "/kin/env-1/kin-default/work" };
  it.each([
    [
      "a withdrawal, drawn by nothing",
      { title: null, body: null, data: { ...data, withdraw: [{ topic: "c:chat-1", version: 1 }] } },
      true,
    ],
    [
      "a read's badge as Android gets it",
      { title: "", body: "", data: JSON.stringify(data) },
      true,
    ],
    ["a message", { title: "Finance · 2 new", body: "Invoice 15 is late", data }, false],
    [
      "upstream's own silent push",
      { title: null, body: null, data: { deepLink: "/threads/1" } },
      false,
    ],
  ] as const)("%s", (_name, content, silent) => {
    expect(kinIsSilentPush(delivered(content))).toBe(silent);
  });
});

describe("kinReconcileRemovals", () => {
  it("removes what the host settled, and what it forgot once older than a week", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const note = (identifier: string, topic: string, daysOld: number) => ({
      date: now - daysOld * day,
      request: {
        identifier,
        content: {
          data: {
            kin: 1,
            orgId: "kin-default",
            deepLink: "/kin/env-1/kin-default/work",
            topic,
            version: 1,
          },
        },
      },
    });
    const presented = [
      note("settled", "w:card-1", 1),
      note("forgotten-old", "a:act-1", 8),
      // The host may simply not be the one that sent it: younger than a week, it stays.
      note("forgotten-young", "a:act-2", 3),
      note("standing", "q:q-1", 9),
    ];
    const here = {
      environmentId: EnvironmentId.make("env-1"),
      orgId: KinOrgId.make("kin-default"),
    };
    expect(
      kinReconcileRemovals(
        presented,
        here,
        {
          remove: [{ topic: "w:card-1" as KinPushTopic, version: 1 }],
          unknown: ["a:act-1", "a:act-2"] as Array<KinPushTopic>,
        },
        now,
      ),
    ).toEqual(["settled", "forgotten-old"]);
  });
});
