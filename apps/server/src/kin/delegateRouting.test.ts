import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyKinProfileTarget } from "./delegateRouting.ts";

describe("applyKinProfileTarget", () => {
  it("uses the profile's provider and model when the caller left the target open", () => {
    expect(
      applyKinProfileTarget({
        target: undefined,
        profile: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toEqual({ driverKind: "codex", model: "gpt-5.4-mini" });
  });

  it("keeps the caller's target over the profile's", () => {
    const target = { providerInstanceId: ProviderInstanceId.make("claude-work") };
    expect(
      applyKinProfileTarget({ target, profile: { provider: "codex", model: "gpt-5.4" } }),
    ).toBe(target);
  });

  it("leaves the target alone for an inheriting profile", () => {
    expect(
      applyKinProfileTarget({
        target: undefined,
        profile: { provider: "inherit", model: "inherit" },
      }),
    ).toBeUndefined();
  });
});
