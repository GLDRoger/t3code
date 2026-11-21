import {
  KinOrgId,
  type KinGitHubAgents,
  type KinGitHubAppAccount,
  type KinGitHubInstant,
  type KinGitHubStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { AsyncResult } from "effect/reactivity";

import {
  createKinGitHubGuardActions,
  KIN_GITHUB_GUARD_COPY,
  kinGitHubAccountRepos,
  kinGitHubGuardAction,
  kinGitHubGuardLine,
  kinGitHubAccountRows,
  kinGitHubAccountsHint,
  kinGitHubAgentsView,
  kinGitHubAppCreatePath,
  kinGitHubInstantRow,
  kinGitHubRow,
  kinGitHubSheet,
} from "./kinGitHub.ts";

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
    const nowhere = kinGitHubAgentsView(
      { ...app, installed: 0, without: ["a/b"] },
      "invented-owner",
      now,
    );
    expect(nowhere.headline).toBe(
      "Invented Kin isn't installed on any watched repo yet, so agents work there as you (invented-owner).",
    );
    expect(nowhere.detail).not.toMatch(/show the App as the author\./);
    // The live shape: the App reaches only the memory repo, which Kin doesn't watch.
    expect(
      kinGitHubAgentsView({ ...app, installed: 0, elsewhere: 1 }, "invented-owner", now).headline,
    ).toBe(
      "Invented Kin works only on 1 repo Kin doesn't watch, so on watched repos agents work as you (invented-owner).",
    );
    expect(nowhere.detail).toMatch(
      /^Their commits, pull requests and reviews there carry your name/,
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

  it("offers Disconnect for an App made in Kin or adopted from the host, and Create only when there is none", () => {
    const made = kinGitHubAgentsView(
      {
        ...app,
        setUp: {
          source: "kin",
          name: "Invented Kin",
          at: now,
          by: "Owner",
          settingsUrl: "https://github.com/settings/apps/invented-kin",
        },
      },
      null,
      now,
    );
    expect([made.canCreate, made.disconnect?.settingsUrl]).toEqual([
      false,
      "https://github.com/settings/apps/invented-kin",
    ]);
    expect(made.setUpLine).toMatch(/^Invented Kin, set up in Kin by Owner on /);
    const adopted = kinGitHubAgentsView(
      {
        ...app,
        setUp: {
          source: "kin",
          name: "Invented Kin",
          at: null,
          by: null,
          settingsUrl: "https://github.com/settings/apps/invented-kin",
        },
      },
      null,
      now,
    );
    expect([adopted.canCreate, adopted.disconnect, adopted.setUpLine]).toEqual([
      false,
      { name: "Invented Kin", settingsUrl: "https://github.com/settings/apps/invented-kin" },
      "Invented Kin, set up earlier on Kin's computer.",
    ]);
    const none = kinGitHubAgentsView(
      {
        as: "owner",
        problem: null,
        watched: 1,
        installed: 0,
        without: [],
        ownerUses: [],
        canCreate: true,
      },
      null,
      now,
    );
    expect([none.canCreate, none.disconnect]).toEqual([true, null]);
    expect(
      kinGitHubAppCreatePath(
        { path: "/api/kin/github-app/new?state=s", name: "Kin for X" },
        " A&B ",
      ),
    ).toBe("/api/kin/github-app/new?state=s&name=A%26B");
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

describe("kinGitHubAccountRows", () => {
  const row: KinGitHubAppAccount = {
    account: "invented-owner",
    organisation: false,
    watched: 48,
    covered: 0,
    installation: "selected",
    settingsUrl: "https://github.com/settings/installations/8",
    installUrl: null,
    canManage: true,
    installable: true,
  };
  const org: KinGitHubAppAccount = {
    ...row,
    account: "invented-co",
    organisation: true,
    watched: 12,
    installation: "none",
    settingsUrl: null,
    installUrl: "https://github.com/apps/invented-kin/installations/new/permissions?target_id=7001",
  };
  const agents = {
    as: "app" as const,
    appName: "Invented Kin",
    installUrl: "https://github.com/apps/invented-kin/installations/new",
    problem: null,
    watched: 60,
    installed: 0,
    without: [],
    ownerUses: [],
    appOwner: "Invented-Owner",
    appSettingsUrl: "https://github.com/settings/apps/invented-kin",
  };
  const shown = (accounts: ReadonlyArray<KinGitHubAppAccount>) =>
    kinGitHubAccountRows({ ...agents, accounts }).map((entry) => [
      entry.label,
      entry.detail,
      entry.action === null ? null : `${entry.action.label} -> ${entry.action.url}`,
    ]);

  it("gives the user's selected-but-empty account and the uninstalled organisation one link each", () => {
    const rows = kinGitHubAccountRows({ ...agents, accounts: [row, org] });
    expect(shown([row, org])).toEqual([
      [
        "Only selected repositories (0 of 48 watched)",
        "Agents work as you on its 48 watched repos.",
        "Switch to all repositories -> https://github.com/settings/installations/8",
      ],
      [
        "Not installed",
        "Agents work as you on its 12 watched repos.",
        `Install on all repositories -> ${org.installUrl}`,
      ],
    ]);
    expect(kinGitHubAccountsHint(rows)).toBe(
      "On GitHub, choose All repositories, then confirm. New repos are covered too.",
    );
    expect(rows.map((entry) => entry.pickable)).toEqual([true, false]);
    expect(
      kinGitHubAccountRows({ ...agents, accounts: [{ ...row, canManage: false }] })[0]?.pickable,
    ).toBe(false);
    // With rows, GitHub's generic install page is not offered as well.
    expect(kinGitHubAgentsView({ ...agents, accounts: [row, org] }, null, 0).installUrl).toBeNull();
  });

  it("says the truth for all, some, suspended, not an owner, a private App, and unknown accounts", () => {
    const all = kinGitHubAccountRows({
      ...agents,
      accounts: [{ ...row, installation: "all", covered: 48 }],
    });
    expect([all[0]?.label, all[0]?.detail, all[0]?.action]).toEqual([
      "All repositories",
      "Covers its 48 watched repos, and new ones.",
      null,
    ]);
    expect(kinGitHubAccountsHint(all)).toBeNull();
    expect(shown([{ ...row, elsewhere: 1 }])[0]?.slice(0, 2)).toEqual([
      "Only selected repositories (0 of 48 watched)",
      "Works on 1 repo Kin doesn't watch. Agents work as you on its 48 watched repos.",
    ]);
    expect(shown([{ ...row, covered: 40 }])[0]?.[0]).toBe(
      "Only selected repositories (40 of 48 watched)",
    );
    expect(shown([{ ...row, covered: 48 }])[0]?.[1]).toBe(
      "Covers every watched repo here, but not repos made later.",
    );
    expect(
      shown([{ ...org, installation: "suspended", settingsUrl: "https://github.com/x" }]),
    ).toEqual([
      [
        "Suspended",
        "Invented Kin is suspended here, so agents work as you on its 12 watched repos until it is unsuspended on GitHub.",
        "Open on GitHub -> https://github.com/x",
      ],
    ]);
    expect(shown([{ ...org, canManage: false }])).toEqual([
      [
        "Not installed",
        "Only an owner of invented-co can install Invented Kin. GitHub sends them your request; this row changes once one of them installs it.",
        `Ask an owner of invented-co -> ${org.installUrl}`,
      ],
    ]);
    expect(
      shown([{ ...row, organisation: true, account: "invented-co", canManage: false }]),
    ).toEqual([
      [
        "Only selected repositories (0 of 48 watched)",
        "Agents work as you on its 48 watched repos. Only an owner of invented-co can change this on GitHub.",
        null,
      ],
    ]);
    expect(shown([{ ...org, canManage: null }])[0]?.[1]).toBe(
      "Agents work as you on its 12 watched repos. If you don't own invented-co, GitHub sends your request to its owners instead.",
    );
    expect(shown([{ ...org, installable: false }])).toEqual([
      [
        "Not installed",
        "Invented Kin is private to Invented-Owner, so GitHub can't install it on invented-co and agents work as you here. On GitHub, open the App's settings → Advanced, then choose Make public.",
        "Open Advanced on GitHub -> https://github.com/settings/apps/invented-kin/advanced",
      ],
    ]);
    const { accounts: _accounts, ...unknown } = { ...agents, accounts: undefined };
    expect(kinGitHubAccountRows(unknown)).toEqual([]);
    expect(kinGitHubAgentsView(unknown, null, 0).installUrl).toBe(agents.installUrl);
  });
});

describe("kinGitHubInstantRow", () => {
  const agents: KinGitHubAgents = {
    as: "app",
    appName: "Invented Kin",
    problem: null,
    watched: 4,
    installed: 4,
    without: [],
    ownerUses: [],
  };
  const now = Date.parse("2026-03-02T10:00:00Z");
  const settingsUrl = "https://github.com/settings/apps/invented-kin/permissions";
  const instant = (state: KinGitHubInstant["state"], more: Partial<KinGitHubInstant> = {}) => ({
    ...agents,
    instant: { state, missing: [], settingsUrl, last: null, ...more },
  });

  it.each([
    ["absent", agents, null],
    [
      "on, never heard",
      instant("on"),
      ["ok", "At once", "GitHub tells Kin the moment something happens on your repos.", null],
    ],
    [
      "on, last heard",
      instant("on", { last: { at: "2026-03-02T09:57:00Z", ok: true } }),
      [
        "ok",
        "At once",
        "GitHub tells Kin the moment something happens on your repos. Last heard 3 min ago.",
        null,
      ],
    ],
    [
      "on, last failed",
      instant("on", { last: { at: "2026-03-02T09:57:00Z", ok: false } }),
      [
        "attention",
        "At once",
        "GitHub tells Kin the moment something happens on your repos. GitHub's last message, 3 min ago, didn't get through.",
        null,
      ],
    ],
    [
      "events",
      instant("events", { missing: ["Pull request", "Issue comment", "Check suite"] }),
      [
        "attention",
        "Events to tick",
        `On GitHub, tick "Pull request", "Issue comment" and "Check suite" under Subscribe to events on the App's Permissions & events page. Also make sure Active is ticked under Webhook on the App's General page: GitHub doesn't let Kin check that. Until then Kin checks GitHub every minute, so nothing is missed.`,
        `Open Permissions & events -> ${settingsUrl}`,
      ],
    ],
    [
      "events, no settings page",
      instant("events", { missing: ["Issues"], settingsUrl: null }),
      [
        "attention",
        "Events to tick",
        `On GitHub, tick "Issues" under Subscribe to events on the App's Permissions & events page. Also make sure Active is ticked under Webhook on the App's General page: GitHub doesn't let Kin check that. Until then Kin checks GitHub every minute, so nothing is missed.`,
        null,
      ],
    ],
    [
      "address",
      instant("address"),
      [
        "muted",
        "Every minute",
        "This Kin has no public address, so GitHub can't reach it. Kin checks GitHub every minute instead.",
        null,
      ],
    ],
    [
      "error",
      instant("error"),
      [
        "attention",
        "Every minute",
        "Kin couldn't set up GitHub to tell it at once. Kin keeps checking GitHub every minute instead.",
        null,
      ],
    ],
  ] as const)("%s", (_name, input, expected) => {
    const row = kinGitHubInstantRow(input, now);
    expect(
      row === null
        ? null
        : [
            row.tone,
            row.label,
            row.detail,
            row.action === null ? null : `${row.action.label} -> ${row.action.url}`,
          ],
    ).toEqual(expected);
    if (row !== null) expect(row.title).toBe("How fast Kin hears from GitHub");
  });
});

describe("kinGitHubAccountRepos", () => {
  it("lists one account's watched repos, found by name", () => {
    const repo = (name: string, watched = true) => ({
      repo: name,
      watched,
      fork: false,
      mentions: false,
    });
    const repos = [
      repo("invented-owner/blog"),
      repo("invented-owner/notes"),
      repo("invented-owner/old", false),
      repo("invented-co/site"),
      repo("invented-owner-two/x"),
    ];
    expect(kinGitHubAccountRepos(repos, "Invented-Owner", "").map((entry) => entry.repo)).toEqual([
      "invented-owner/blog",
      "invented-owner/notes",
    ]);
    expect(
      kinGitHubAccountRepos(repos, "invented-owner", " NOT").map((entry) => entry.repo),
    ).toEqual(["invented-owner/notes"]);
  });
});

describe("protecting a repo's main branch from Kin's App", () => {
  it("says each watched row's state, unknown with its reason, and offers only Kin's own protection to remove", () => {
    const rows = [
      [{ state: "open", branch: "main", byKin: false }, "app"],
      [{ state: "open", branch: "main", byKin: false }, "owner"],
      [{ state: "open", branch: "main", byKin: false }, undefined],
      // A required review alone: the App merges once someone approves, so Protect stays.
      [{ state: "open", branch: "main", byKin: false, needsReview: true }, "app"],
      [{ state: "open", branch: "trunk", byKin: false, needsReview: true }, "owner"],
      // Kin's ruleset, edited on GitHub to let the App through: Protect makes it again.
      [{ state: "open", branch: "main", byKin: true, needsReview: true }, "app"],
      [{ state: "protected", branch: "main", byKin: true }, "app"],
      [{ state: "protected", branch: "trunk", byKin: false }, "owner"],
      [{ state: "unknown", branch: "main", byKin: false, problem: "plan" }, "owner"],
      [{ state: "unknown", branch: "main", byKin: false, problem: "no_admin" }, "owner"],
      [{ state: "unknown", branch: "main", byKin: false, problem: "no_access" }, "owner"],
      [{ state: "unknown", branch: "main", byKin: false, problem: "unreachable" }, "app"],
      [{ state: "unknown", branch: "trunk", byKin: false, problem: "no_branch" }, "app"],
      [{ state: "unknown", branch: "main", byKin: false, problem: "refused" }, "owner"],
      [{ state: "unknown", branch: "main", byKin: false }, "owner"],
      [undefined, "owner"],
    ] as const;
    expect(
      rows.map(([guard, agentsAs]) => [
        kinGitHubGuardLine({ watched: true, agentsAs, guard }),
        kinGitHubGuardAction(guard),
      ]),
    ).toEqual([
      ["main unprotected: Kin's App can change it", "protect"],
      ["main unprotected; the App isn't on this repo", "protect"],
      ["main unprotected; the App isn't on this repo", "protect"],
      ["main needs a review, but Kin's App can merge once approved", "protect"],
      ["trunk needs a review; the App isn't on this repo", "protect"],
      ["main needs a review, but Kin's App can merge once approved", "protect"],
      ["Kin protects main", "remove"],
      ["Your rules protect trunk", null],
      ["GitHub's plan offers no protection for main here", null],
      ["main protection unknown: it takes admin on this repo", null],
      ["main protection unknown: GitHub hides its rules from your login", null],
      ["main protection unknown: Kin couldn't reach GitHub", null],
      ["No trunk branch yet: the repo is empty", null],
      ["main protection unknown: GitHub didn't say", null],
      ["main protection unknown: GitHub didn't say", null],
      ["Main branch not checked yet", null],
    ]);
    // Kin never reads a repo it doesn't watch, so its row says nothing of it.
    expect(
      kinGitHubGuardLine({
        watched: false,
        agentsAs: "owner",
        guard: { state: "open", branch: "main", byKin: false },
      }),
    ).toBeNull();
    // One count for open and review-only branches, true whether or not the App is on the repo.
    expect(KIN_GITHUB_GUARD_COPY.open(1)).toBe(
      "1 watched repo has a main branch that isn't closed to Kin's App.",
    );
    expect(KIN_GITHUB_GUARD_COPY.open(3)).toBe(
      "3 watched repos have main branches that aren't closed to Kin's App.",
    );
  });

  it("Protect all says how many worked and names each one that didn't, and why", async () => {
    const protect = createKinGitHubGuardActions({
      orgId: KinOrgId.make("org"),
      set: async () =>
        AsyncResult.success({
          changed: 2,
          failed: [
            { repo: "invented-owner/private", problem: "plan" as const, said: null },
            { repo: "invented-co/shared", problem: "no_admin" as const, said: null },
          ],
        }),
      refresh: () => {},
    });
    expect(
      await protect(["a/1", "a/2", "invented-owner/private", "invented-co/shared"], true, true),
    ).toEqual({
      summary: "Protected 2 of 4. Not protected:",
      problems: [
        "invented-owner/private: GitHub offers no protection on this repo with its plan. Make it public or upgrade on GitHub.",
        "invented-co/shared: GitHub takes this only from an admin of the repo, and your login isn't one.",
      ],
    });
  });
});
