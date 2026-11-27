import { DEFAULT_SERVER_SETTINGS, KinEvent } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { isPersonTag, startedBy, TRIGGER_TAGS, voiceFor } from "./turnVoice.ts";

it.effect("decides every Kin event tag exactly once", () =>
  Effect.sync(() => {
    const tags = KinEvent.members.map((member) => member.fields._tag.ast.literal);
    for (const tag of tags) {
      if (typeof tag !== "string") throw new Error("Expected an event tag");
      expect(Number(isPersonTag(tag)) + Number(Object.hasOwn(TRIGGER_TAGS, tag))).toBe(1);
    }
  }),
);

it.effect.each([
  { tags: ["pulse", "chat.message"], started: "person" },
  { tags: ["github", "pulse"], started: "trigger" },
] as const)("classifies $tags and keeps text voice with the switch off", ({ tags, started }) =>
  Effect.sync(() => {
    expect(startedBy(tags)).toBe(started);
    expect(voiceFor({ tags, sendOnly: false })).toBe("text");
    expect(voiceFor({ tags, sendOnly: DEFAULT_SERVER_SETTINGS.kinTriggerSendOnly })).toBe(
      started === "person" ? "text" : "send",
    );
  }),
);
