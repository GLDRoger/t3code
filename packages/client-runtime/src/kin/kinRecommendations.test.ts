import { KinChatError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinRecommendationProblem } from "./kinRecommendations.ts";

describe("kinRecommendationProblem", () => {
  it.each([
    [
      "the host's reason when Kin may already suggest it",
      new KinChatError({ reason: "invalid_state", message: "Kin may already suggest this again." }),
      "Kin may already suggest this again.",
    ],
    [
      "gone when the row isn't there",
      new KinChatError({ reason: "not_found", message: "No such suggestion here." }),
      "That suggestion isn't there any more.",
    ],
    [
      "the connection when no answer came",
      new Error("socket closed"),
      "Couldn't ask again. Check your connection to the server and try again.",
    ],
  ] as const)("says %s", (_, cause, text) => {
    expect(kinRecommendationProblem(cause)).toBe(text);
  });
});
