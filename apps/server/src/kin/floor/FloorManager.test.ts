import { assert, it } from "@effect/vitest";
import { noticeIntentAllowed, replyIntentAllowed } from "./FloorManager.ts";

it.each(["answer", "question", "evidence", "objection", "decision"] as const)(
  "reply and notice intents: %s",
  (intent) => {
    assert.isTrue(replyIntentAllowed(0, intent));
    assert.strictEqual(
      replyIntentAllowed(1, intent),
      ["evidence", "objection", "decision"].includes(intent),
    );
    assert.strictEqual(
      noticeIntentAllowed(intent),
      ["evidence", "decision", "question"].includes(intent),
    );
  },
);
