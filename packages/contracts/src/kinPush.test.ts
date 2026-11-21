import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";
import { KinActionId } from "./kinApprovals.ts";
import { KinChatId, KinOrgId, KinWidgetId } from "./kinChat.ts";
import { KinPushCategory, KinPushData } from "./kinPush.ts";

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
  deepLink: Schema.String,
});

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
    expect(Schema.is(KinPushCategory)("kin.choice")).toBe(true);
    expect(Schema.is(OldKinPushCategory)("kin.choice")).toBe(false);
    expect(Schema.decodeUnknownSync(OldKinPushData)(data)).toEqual({
      kin: 1,
      orgId: "org_01",
      chatId: "chat_dm",
      widgetId: "w_ask",
      revision: 1,
      deepLink: "/kin/env/org_01/chats/chat_dm",
    });
    expect(Schema.decodeUnknownSync(KinPushData)(data).choices).toEqual(["option-1", "option-2"]);
  });
});
