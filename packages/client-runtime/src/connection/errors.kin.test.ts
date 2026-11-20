import { describe, expect, it } from "@effect/vitest";

import { KIN_JOIN_DEVICE_LIMIT, KIN_JOIN_LINK_SPENT, mapKinInviteError } from "./errors.ts";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";

describe("mapKinInviteError", () => {
  const requestUrl = "https://kin.example.test/kin/invites/accept";

  it("says a refused invite is used or expired, and leaves outages as retryable", () => {
    expect(
      mapKinInviteError(
        new RemoteEnvironmentAuthUndeclaredStatusError({ status: 400, requestUrl }),
      ),
    ).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: KIN_JOIN_LINK_SPENT,
    });
    // A full set of devices is said as such, not as a used link.
    expect(
      mapKinInviteError(
        new RemoteEnvironmentAuthUndeclaredStatusError({ status: 409, requestUrl }),
      ),
    ).toMatchObject({ _tag: "ConnectionBlockedError", detail: KIN_JOIN_DEVICE_LIMIT });
    // Kin switched off answers 503: the link is not spent, so it must not read as used.
    expect(
      mapKinInviteError(
        new RemoteEnvironmentAuthUndeclaredStatusError({ status: 503, requestUrl }),
      ),
    ).toMatchObject({ _tag: "ConnectionTransientError", reason: "remote-unavailable" });
  });
});
