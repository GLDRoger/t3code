import { KinOrgId, type KinGitHubStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { kinGitHubRow, kinGitHubSheet } from "./kinGitHub.ts";

const base: KinGitHubStatus = {
  orgId: KinOrgId.make("org"),
  account: null,
  signIn: null,
  failed: null,
};
const account = { login: "invented-owner", orgs: [], scopes: ["repo"], problem: null };

describe("kinGitHubRow", () => {
  it("says what the owner can do in each state", () => {
    expect(kinGitHubRow(base).action).toBe("connect");
    expect(kinGitHubRow({ ...base, failed: "The code expired." }).detail).toBe("The code expired.");
    expect(
      kinGitHubRow({
        ...base,
        signIn: { code: "AB12-CD34", url: "https://github.com/login/device", expiresAt: 1 },
      }).action,
    ).toBe("waiting");
    expect(kinGitHubRow({ ...base, account }).detail).toBe("Connected as invented-owner.");
    expect(
      kinGitHubRow({ ...base, account: { ...account, orgs: ["a", "b", "c", "d"] } }).detail,
    ).toBe("Connected as invented-owner. Reaches a, b and 2 more.");
    const lost = kinGitHubRow({
      ...base,
      account: { ...account, problem: "GitHub no longer accepts this login." },
    });
    expect([lost.action, lost.tone, lost.detail]).toEqual([
      "reconnect",
      "error",
      "GitHub no longer accepts this login.",
    ]);
  });

  it("keeps a login that needs reconnecting on the sheet's first step", () => {
    expect(kinGitHubSheet({ ...base, account: { ...account, problem: "lost" } }).step).toBe(
      "start",
    );
    expect(kinGitHubSheet({ ...base, account }).step).toBe("done");
  });
});
