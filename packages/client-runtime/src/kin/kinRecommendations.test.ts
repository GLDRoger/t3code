import { KinChatError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinRecommendationProblem } from "./kinRecommendations.ts";

describe("kinRecommendationProblem", () => {
  it.each([
    [
      "the host's reason when the change was already reversed",
      new KinChatError({
        reason: "invalid_state",
        message: "That change isn't in effect any more, so there's nothing to undo.",
      }),
      "undo",
      "That change isn't in effect any more, so there's nothing to undo.",
    ],
    [
      "gone when the row isn't there",
      new KinChatError({ reason: "not_found", message: "No such suggestion here." }),
      "ask_again",
      "That suggestion isn't there any more.",
    ],
    [
      "the connection when no answer came",
      new Error("socket closed"),
      "ask_again",
      "Couldn't ask again. Check your connection to the server and try again.",
    ],
  ] as const)("says %s", (_, cause, kind, text) => {
    expect(kinRecommendationProblem(cause, kind)).toBe(text);
  });
});
