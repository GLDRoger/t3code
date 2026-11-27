import { describe, expect, it } from "@effect/vitest";

import { kinClearChatBody } from "./kinClearChat.ts";

describe("clear chat confirm copy", () => {
  it("keeps the existing sentence byte for byte when the chat has no pins", () => {
    expect(kinClearChatBody("group")).toBe(
      "This deletes every message here for good. What the agents remember is kept.",
    );
    expect(kinClearChatBody("group", undefined, "none")).toBe(
      "This deletes every message here for good. What the agents remember is kept.",
    );
    expect(kinClearChatBody("Chief of staff", 1, "none")).toBe(
      "This deletes every message here for good. What Chief of staff remembers is kept. 1 file stays because a document uses it.",
    );
    expect(kinClearChatBody(null, undefined, "none")).toBe(
      "This deletes every message here for good.",
    );
  });

  it("says pins are unpinned when the chat has at least one pin", () => {
    expect(kinClearChatBody("group", undefined, "some")).toBe(
      "This deletes every message here for good and unpins what is pinned here. What the agents remember is kept.",
    );
    expect(kinClearChatBody("Chief of staff", 2, "some")).toBe(
      "This deletes every message here for good and unpins what is pinned here. What Chief of staff remembers is kept. 2 files stay because documents use them.",
    );
    expect(kinClearChatBody(null, undefined, "some")).toBe(
      "This deletes every message here for good and unpins what is pinned here.",
    );
  });

  it("uses the conditional sentence when the screen cannot know the pin count", () => {
    expect(kinClearChatBody("group", undefined, "unknown")).toBe(
      "This deletes every message here for good, and unpins anything pinned here. What the agents remember is kept.",
    );
    expect(kinClearChatBody("Chief of staff", undefined, "unknown")).toBe(
      "This deletes every message here for good, and unpins anything pinned here. What Chief of staff remembers is kept.",
    );
    expect(kinClearChatBody(null, 1, "unknown")).toBe(
      "This deletes every message here for good, and unpins anything pinned here. 1 file stays because a document uses it.",
    );
  });
});
