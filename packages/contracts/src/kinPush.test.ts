import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { KinActionId } from "./kinApprovals.ts";
import { KinChatId, KinOrgId, KinWidgetId } from "./kinChat.ts";
import {
  KinPushCategory,
  KinPushData,
  KinPushRegisterDeviceInput,
  KinPushSubject,
} from "./kinPush.ts";

// The schemas as phones already in use decode them, from before `kin.choice`.
const OldKinPushCategory = Schema.Literals([
  "kin.approval",
  "kin.deferral.confirmed",
  "kin.deferral.heads_up",
  "kin.message",
]);
const OldKinPushData = Schema.Struct({
  kin: Schema.Literal(1),
  orgId: KinOrgId,
  chatId: Schema.optional(KinChatId),
  widgetId: Schema.optional(KinWidgetId),
  revision: Schema.optional(NonNegativeInt),
  pendingActionId: Schema.optional(KinActionId),
  cleared: Schema.optional(Schema.Literal(true)),
  subject: Schema.optional(KinPushSubject),
  deepLink: Schema.String.check(
    Schema.makeFilter((value: string) => /^\/kin\/[A-Za-z0-9._~%/-]+$/.test(value), {
      expected: "a /kin/ app path",
    }),
  ),
});

const isCategory = Schema.is(KinPushCategory);
const wasCategory = Schema.is(OldKinPushCategory);
const decodeOld = Schema.decodeUnknownSync(OldKinPushData);
const decode = Schema.decodeUnknownSync(KinPushData);

describe("a two-answer question's push", () => {
  const data = {
    kin: 1,
    orgId: "org_01",
    chatId: "chat_dm",
    widgetId: "w_ask",
    revision: 1,
    choices: ["option-1", "option-2"],
    deepLink: "/kin/env/org_01/chats/chat_dm",
  };

  it("is a plain banner, opening its chat, on a build that doesn't know it", () => {
    expect(isCategory("kin.choice")).toBe(true);
    expect(wasCategory("kin.choice")).toBe(false);
    expect(decodeOld(data)).toEqual({
      kin: 1,
      orgId: "org_01",
      chatId: "chat_dm",
      widgetId: "w_ask",
      revision: 1,
      deepLink: "/kin/env/org_01/chats/chat_dm",
    });
    expect(decode(data).choices).toEqual(["option-1", "option-2"]);
  });
});

describe("registering a phone", () => {
  const decodeRegister = Schema.decodeUnknownExit(KinPushRegisterDeviceInput);
  const input = { orgId: "org_01", apsEnvironment: "production" };
  it.each([
    ["an iPhone's APNs token", "ios", "a".repeat(64), true],
    [
      "an Android phone's FCM token, in mixed case",
      "android",
      "dQw4w9WgXcQ:APA91bH-Mixed_Case-0123456789",
      true,
    ],
    ["a token with spaces", "android", "not a token at all, with spaces in it", false],
    ["a token too short to be either", "android", "abc:def", false],
    ["a platform Kin can't reach", "windows", "a".repeat(64), false],
  ] as const)("%s", (_name, platform, token, ok) => {
    expect(decodeRegister({ ...input, platform, token })._tag).toBe(ok ? "Success" : "Failure");
  });
});
