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

  it("says a host's sentence that names a product as written, and hides words meant for a machine", () => {
    const shown = [
      "Only the owner can connect GitHub here.",
      "Only the owner can connect PostHog here.",
      "Ask the owner to connect LinkedIn first.",
      "QuickBooks isn't connected for this company.",
      "Only the owner can post to YouTube.",
      "WhatsApp is not set up here yet.",
      "TestFlight builds are the owner's to send.",
      "Only Meera can change MedTech's tasks.",
      "This iPhone isn't allowed to change Work.",
      "Only the owner filters by that client.",
    ];
    const hidden = [
      "There is no list x. A new list is proposed with list_define first.",
      "Give dueAt as a date.",
      "workUpdate failed",
      "KinChatError: not allowed",
      "SqlError",
      "TimeoutException while reading",
      "ParseFailure at revision 4",
      "WorkItemNotFound",
      "NotFound",
      "Kin::Work refused it.",
      "Failed in run() here.",
      "at Object.run (src/kin/work.ts:12:3)",
      'Refused with {"_tag":"NotAllowed"}',
      "Only the owner can connect GitHub; orgId was missing.",
    ];
    const text = (said: string) => kinFailure(refusal("not_allowed", said), "Couldn't save.").text;
    for (const said of shown) expect(text(said), said).toBe(said);
    for (const said of hidden) expect(text(said), said).toBe("You can't do that here.");
  });
});
