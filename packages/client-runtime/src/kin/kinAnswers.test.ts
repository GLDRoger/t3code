import { EnvironmentAuthorizationError, KinChatError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { kinFailure } from "./kinAnswers.ts";

const refusal = (reason: KinChatError["reason"], message: string) =>
  new KinChatError({ reason, message });

describe("kinFailure", () => {
  it("offers Retry only when the request never got an answer, or Kin said it can't right now", () => {
    const what = "Couldn't load this list.";
    const cases = [
      [new Error("socket closed"), "offline", true],
      [refusal("unavailable", "Down."), "busy", true],
      [refusal("disabled", "Off."), "busy", true],
      // #2: a refusal is said plainly, never as the connection.
      [refusal("not_allowed", "Only the owner filters by that client."), "refused", false],
      [
        new EnvironmentAuthorizationError({
          message: "no scope",
          requiredScope: "orchestration:read",
        }),
        "refused",
        false,
      ],
      // #4: an attention item no longer current is gone, not a failure to save.
      [refusal("not_found", "No such fact."), "gone", false],
      // #3: the host's own reason, so it can be fixed.
      [refusal("invalid_state", "A milestone is open, done or dropped."), "invalid", false],
    ] as const;
    for (const [error, kind, retry] of cases) {
      const failure = kinFailure(Cause.fail(error), what);
      expect([failure.kind, failure.retry], String(error)).toEqual([kind, retry]);
      expect(/connection/i.test(failure.text), String(error)).toBe(kind === "offline");
    }
    expect(
      kinFailure(refusal("invalid_state", "A milestone is open, done or dropped."), what).text,
    ).toBe("A milestone is open, done or dropped.");
    expect(kinFailure(refusal("not_found", "x"), what, { gone: "Already handled." }).text).toBe(
      "Already handled.",
    );
  });
});
