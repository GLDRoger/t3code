import { DEFAULT_KIN_ROUTING_SETTINGS, type KinAgentProfile } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { decideKinRoute, type KinRouteRequest } from "./RoutingPolicy.ts";

const profile = (role: KinAgentProfile["role"]): KinRouteRequest["profile"] => ({
  role,
  provider: "inherit",
  model: "inherit",
  reasoningEffort: "inherit",
});

const request = (patch: Partial<KinRouteRequest>): KinRouteRequest => ({
  settings: DEFAULT_KIN_ROUTING_SETTINGS,
  profile: profile("implementer"),
  parentDriver: "claudeAgent",
  parentModel: "claude-opus",
  activeTotal: 0,
  activeByProvider: {},
  limits: [],
  explicitTarget: false,
  stuck: false,
  ...patch,
});

describe("decideKinRoute", () => {
  it("pauses at the main-thread cap and near a plan limit", () => {
    expect(decideKinRoute(request({ activeTotal: 20 })).action).toBe("pause");
    const paused = decideKinRoute(
      request({
        explicitTarget: true,
        limits: [{ provider: "claudeAgent", usedPercent: 90 }],
      }),
    );
    expect(paused.action).toBe("pause");
  });

  it("keeps a pinned provider that still has headroom", () => {
    expect(
      decideKinRoute(
        request({
          explicitTarget: true,
          limits: [{ provider: "claudeAgent", usedPercent: 10 }],
        }),
      ).action,
    ).toBe("inherit");
  });

  it("leaves section 9 unused until the toggle is on, then switches the reviewer", () => {
    const off = decideKinRoute(request({ profile: profile("reviewer") }));
    expect(off.action).toBe("launch");
    if (off.action === "launch") expect(off.provider).toBe("claudeAgent");

    const on = decideKinRoute(
      request({
        profile: profile("reviewer"),
        settings: {
          ...DEFAULT_KIN_ROUTING_SETTINGS,
          routingPolicyEnabled: true,
          crossModelReview: true,
        },
      }),
    );
    expect(on.action).toBe("launch");
    if (on.action === "launch") {
      expect(on.provider).toBe("codex");
      expect(on.promptAddendum).toBeUndefined();
    }
  });

  it("sends cheap roles to the cheap model and prefers the plan with headroom", () => {
    const cheap = decideKinRoute(request({ profile: profile("archivist") }));
    expect(cheap.action).toBe("launch");
    if (cheap.action === "launch") {
      expect(cheap.provider).toBe("openrouter");
      expect(cheap.model).toBe(DEFAULT_KIN_ROUTING_SETTINGS.cheapModel);
    }

    const picked = decideKinRoute(
      request({
        limits: [
          { provider: "claudeAgent", instanceId: "claude-a", usedPercent: 80 },
          { provider: "claudeAgent", instanceId: "claude-b", usedPercent: 10 },
        ],
      }),
    );
    expect(picked.action).toBe("launch");
    if (picked.action === "launch") expect(picked.provider).toBe("claudeAgent");
  });

  it("adds the fresh-author line only when escalation is enabled", () => {
    const off = decideKinRoute(request({ stuck: true }));
    expect(off.action).toBe("launch");
    if (off.action === "launch") expect(off.promptAddendum).toBeUndefined();

    const on = decideKinRoute(
      request({
        stuck: true,
        settings: {
          ...DEFAULT_KIN_ROUTING_SETTINGS,
          routingPolicyEnabled: true,
          freshAuthorEscalation: true,
        },
      }),
    );
    expect(on.action).toBe("launch");
    if (on.action === "launch") {
      expect(on.provider).toBe("codex");
      expect(on.promptAddendum).toContain("whole class of failure");
    }
  });
});
