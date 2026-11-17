import { KinOrgId, type KinGitHubStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { kinGitHubAgentsView, kinGitHubRow, kinGitHubSheet } from "./kinGitHub.ts";

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

describe("kinGitHubAgentsView", () => {
  const app = {
    as: "app" as const,
    appName: "Invented Kin",
    botLogin: "invented-kin[bot]",
    installUrl: "https://github.com/apps/invented-kin/installations/new",
    problem: null,
    watched: 5,
    installed: 3,
    without: ["acme/site", "acme/tools"],
    ownerUses: [],
  };
  const now = Date.UTC(2026, 10, 17, 12);

  it("says truthfully who agents work as, and where the App is missing", () => {
    const partly = kinGitHubAgentsView(app, "invented-owner", now);
    expect(partly.headline).toBe("Agents work on GitHub as Invented Kin on 3 of 5 watched repos.");
    expect(partly.detail).toMatch(
      /^On acme\/site and acme\/tools, their work goes out as you \(invented-owner\)\./,
    );
    expect(partly.installUrl).toBe(app.installUrl);
    expect(kinGitHubAgentsView({ ...app, installed: 5, without: [] }, null, now).headline).toBe(
      "Agents work on GitHub as Invented Kin on all 5 watched repos.",
    );
    expect(
      kinGitHubAgentsView({ ...app, installed: 0, without: ["a/b"] }, "invented-owner", now)
        .headline,
    ).toBe(
      "Invented Kin isn't installed on any watched repo yet, so agents work there as you (invented-owner).",
    );
    const none = kinGitHubAgentsView(
      { as: "owner", problem: null, watched: 5, installed: 0, without: [], ownerUses: [] },
      "invented-owner",
      now,
    );
    expect([none.headline, none.installUrl]).toEqual([
      "Agents work on GitHub as you (invented-owner).",
      null,
    ]);
  });

  it("lists what agents did as the owner, newest first", () => {
    const view = kinGitHubAgentsView(
      {
        ...app,
        ownerUses: [
          { at: now - 2 * 3_600_000, agent: "Tech lead", repo: "acme/site", command: "git push" },
          { at: now - 86_400_000, agent: null, repo: null, command: "gh repo list" },
        ],
      },
      null,
      now,
    );
    expect(view.uses.map((use) => [use.line, use.command])).toEqual([
      ["Tech lead on acme/site, 2 h ago", "git push"],
      ["An agent, 1 d ago", "gh repo list"],
    ]);
  });
});
