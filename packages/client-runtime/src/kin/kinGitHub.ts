// @effect-diagnostics globalDate:off - Pure view helpers format the App's set-up day for React render.
import {
  KinConnectionKey,
  type KinGitHubAgents,
  type KinGitHubAppAccount,
  type KinGitHubAppCreateStart,
  type KinGitHubAppDisconnected,
  type KinGitHubAppReposResult,
  type KinGitHubAppReposSetInput,
  type KinGitHubConnectInput,
  type KinGitHubInput,
  type KinGitHubRepo,
  type KinGitHubRepos,
  type KinGitHubRepoSetInput,
  type KinGitHubStatus,
  type KinGitHubWatch,
  type KinOrgId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";

import { squashAtomCommandFailure, type AtomCommandResult } from "../state/runtime.ts";
import { kinFailureText } from "./kinAnswers.ts";
import type { KinConnectionTone } from "./kinConnections.ts";

/**
 * Settings → Connections → GitHub: the owner's own GitHub login on his Kin's computer. Web and
 * mobile draw what this returns.
 */
export const KIN_GITHUB_COPY = {
  title: "GitHub",
  intro:
    "Your own GitHub login on your Kin's computer. Kin watches your repositories with it, and agents can clone, push and open pull requests on any repository your account can reach.",
  connect: "Connect",
  reconnect: "Reconnect",
  disconnect: "Disconnect",
  sheetTitle: "Connect GitHub",
  getCode: "Get a code",
  gettingCode: "Getting a code…",
  enterCode: "Enter this code on GitHub",
  copy: "Copy code",
  copied: "Copied",
  openGitHub: "Open GitHub",
  codeHint:
    "Sign in as yourself, enter the code and tap Authorize. If GitHub asks about an organization, grant it there. This updates by itself when you're done.",
  waiting: "Waiting for you on GitHub…",
  cancel: "Cancel",
  done: "Done",
  tokenInstead: "Use a token instead",
  codeInstead: "Sign in with a code instead",
  tokenLabel: "Personal access token (classic)",
  tokenPlaceholder: "ghp_…",
  tokenHint:
    "Make one in GitHub under Settings → Developer settings → Tokens (classic), with repo, read:org and workflow. It goes to your Kin's computer and is never shown again.",
  tokenConnect: "Connect with token",
  connecting: "Connecting…",
  disconnectTitle: "Disconnect GitHub?",
  disconnectDetail: (login: string) =>
    `Agents and git on your Kin's computer stop acting as ${login}. To end it on GitHub too, revoke GitHub CLI under Settings → Applications.`,
  revokeUrl: "https://github.com/settings/applications",
  revokeLabel: "Authorized apps on GitHub",
  loadFailed: "Couldn't load your GitHub connection",
} as const;

const makeKey = Schema.decodeSync(KinConnectionKey);

export interface KinGitHubRow {
  /** The connected login, or what the row is before there is one. */
  readonly title: string;
  readonly tone: KinConnectionTone;
  readonly label: string;
  readonly detail: string;
  /** What the row's button does: open the Connect sheet, or disconnect. */
  readonly action: "connect" | "reconnect" | "disconnect" | "waiting";
}

/** "invented-co and side-project", "a, b and 3 more". */
const orgList = (orgs: ReadonlyArray<string>) => {
  if (orgs.length <= 1) return orgs.join("");
  if (orgs.length <= 3) return `${orgs.slice(0, -1).join(", ")} and ${orgs.at(-1)}`;
  return `${orgs.slice(0, 2).join(", ")} and ${orgs.length - 2} more`;
};

/** The GitHub row on the Connections list. */
export function kinGitHubRow(status: KinGitHubStatus): KinGitHubRow {
  return { title: status.account?.login ?? "Your GitHub account", ...rowState(status) };
}

function rowState(status: KinGitHubStatus): Omit<KinGitHubRow, "title"> {
  const account = status.account;
  if (status.signIn !== null)
    return {
      tone: "attention",
      label: "Signing in",
      detail: KIN_GITHUB_COPY.waiting,
      action: "waiting",
    };
  if (account === null)
    return {
      tone: "muted",
      label: "Not connected",
      detail: status.failed ?? KIN_GITHUB_COPY.intro,
      action: "connect",
    };
  if (account.problem !== null)
    return {
      tone: "error",
      label: "Needs reconnecting",
      detail: account.problem,
      action: "reconnect",
    };
  return {
    tone: "ok",
    label: "Connected",
    detail:
      account.orgs.length === 0
        ? `Connected as ${account.login}.`
        : `Connected as ${account.login}. Reaches ${orgList(account.orgs)}.`,
    action: "disconnect",
  };
}

/** What the Connect sheet shows now: the first step, the code to enter, or that it's done. */
export type KinGitHubSheet =
  | { readonly step: "start"; readonly failed: string | null }
  | { readonly step: "code"; readonly code: string; readonly url: string }
  | { readonly step: "done"; readonly detail: string };

export function kinGitHubSheet(status: KinGitHubStatus | null): KinGitHubSheet {
  if (status?.signIn != null)
    return { step: "code", code: status.signIn.code, url: status.signIn.url };
  if (status?.account != null && status.account.problem === null)
    return { step: "done", detail: kinGitHubRow(status).detail };
  return { step: "start", failed: status?.failed ?? null };
}

type Sent<A> = Promise<AtomCommandResult<A, unknown>>;
type Outcome =
  | { readonly ok: true; readonly value: KinGitHubStatus }
  | { readonly ok: false; readonly problem: string };

const settle = async (sent: Sent<KinGitHubStatus>, doing: string): Promise<Outcome> => {
  const result = await sent;
  return AsyncResult.isSuccess(result)
    ? { ok: true, value: result.value }
    : {
        ok: false,
        problem: kinFailureText(squashAtomCommandFailure(result), `Couldn't ${doing}.`, {
          device: `This device isn't allowed to ${doing}.`,
        }),
      };
};

/** Starting and ending Kin's own GitHub App, each answered in plain words. */
export function createKinGitHubAppSetupActions(options: {
  readonly orgId: KinOrgId;
  readonly create: (input: KinGitHubInput) => Sent<KinGitHubAppCreateStart>;
  readonly disconnect: (input: KinGitHubInput) => Sent<KinGitHubAppDisconnected>;
  readonly refresh: () => void;
}) {
  const answer = async <A>(sent: Sent<A>, doing: string) => {
    const result = await sent;
    return AsyncResult.isSuccess(result)
      ? ({ ok: true, value: result.value } as const)
      : ({
          ok: false,
          problem: kinFailureText(squashAtomCommandFailure(result), `Couldn't ${doing}.`, {
            device: `This device isn't allowed to ${doing}.`,
          }),
        } as const);
  };
  return {
    start: () => answer(options.create({ orgId: options.orgId }), "start making the App"),
    disconnect: async () => {
      const outcome = await answer(
        options.disconnect({ orgId: options.orgId }),
        "disconnect the App",
      );
      options.refresh();
      return outcome;
    },
  };
}

/** Where the owner's browser goes to make the App: Kin's page, with the name he chose. */
export const kinGitHubAppCreatePath = (start: KinGitHubAppCreateStart, name: string) =>
  `${start.path}&name=${encodeURIComponent(name.trim() === "" ? start.name : name.trim())}`;

/** The owner's GitHub changes, each answered in plain words. */
export function createKinGitHubActions(options: {
  readonly orgId: KinOrgId;
  readonly start: (input: KinGitHubConnectInput) => Sent<KinGitHubStatus>;
  readonly cancel: (input: KinGitHubInput) => Sent<KinGitHubStatus>;
  readonly disconnect: (input: KinGitHubInput) => Sent<KinGitHubStatus>;
  readonly refresh: () => void;
}) {
  const { orgId } = options;
  const after = async (sent: Sent<KinGitHubStatus>, doing: string) => {
    const outcome = await settle(sent, doing);
    options.refresh();
    return outcome;
  };
  return {
    getCode: () => after(options.start({ orgId }), "start signing in to GitHub"),
    connectWithToken: async (typed: string): Promise<Outcome> => {
      const token = typed.trim();
      if (token === "") return { ok: false, problem: "Paste the token to connect." };
      return after(options.start({ orgId, token: makeKey(token) }), "connect GitHub");
    },
    cancel: () => after(options.cancel({ orgId }), "cancel signing in"),
    disconnect: () => after(options.disconnect({ orgId }), "disconnect GitHub"),
  };
}

/** What Kin watches on GitHub with that login, under the GitHub row. */
export const KIN_GITHUB_WATCH_COPY = {
  reposTitle: "Repos Kin watches",
  reposHint:
    "An agent starts on its own when a teammate opens a pull request here, writes /kin or an agent's name at the start of a comment, or adds the kin label to an issue. Turn a repo off to leave it alone.",
  watchEverything: "Watch every repo",
  noRepos: "No repos yet. Kin lists yours and your organisations' after its first look.",
  mentions: "Your @-mention calls an agent",
  fork: "Fork",
  showRepos: (count: number) => `Show repos (${count})`,
  hideRepos: "Hide repos",
  loadFailed: "Couldn't load the repo list",
  asApp: "As the App",
  asYou: "As you",
} as const;

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

const ago = (at: number, now: number) => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
};

/** "Watching: 4 repos · last checked 20 s ago · 3 things handled today". */
export function kinGitHubWatchLine(watch: KinGitHubWatch, now: number): string {
  return [
    `Watching: ${plural(watch.repos, "repo")}`,
    watch.checkedAt === null ? "not checked yet" : `last checked ${ago(watch.checkedAt, now)}`,
    `${plural(watch.handledToday, "thing")} handled today`,
  ].join(" · ");
}

/** A repo switch, answered in plain words; `repo` null watches every repo again. */
export function createKinGitHubRepoActions(options: {
  readonly orgId: KinOrgId;
  readonly set: (input: KinGitHubRepoSetInput) => Sent<KinGitHubRepos>;
  readonly refresh: () => void;
}) {
  const run = async (input: Omit<KinGitHubRepoSetInput, "orgId">) => {
    const result = await options.set({ orgId: options.orgId, ...input });
    options.refresh();
    return AsyncResult.isSuccess(result)
      ? ({ ok: true } as const)
      : ({
          ok: false,
          problem: kinFailureText(squashAtomCommandFailure(result), "Couldn't change that repo.", {
            device: "This device isn't allowed to change which repos Kin watches.",
          }),
        } as const);
  };
  return {
    watch: (repo: KinGitHubRepo, watched: boolean) => run({ repo: repo.repo, watched }),
    mentions: (repo: KinGitHubRepo, mentions: boolean) => run({ repo: repo.repo, mentions }),
    everything: () => run({ repo: null }),
  };
}

/** Who agents act as on GitHub, under the GitHub row. */
export const KIN_GITHUB_AGENTS_COPY = {
  title: "Agents on GitHub",
  install: "Install on more repos",
  usesTitle: "Done as you lately",
  accountsTitle: "Where the App is",
  /** Under the rows while one of them sends the owner to GitHub. */
  accountsHint: "On GitHub, choose All repositories, then confirm. New repos are covered too.",
} as const;

/** One account's row: where the App stands there, and the one GitHub page that changes it. */
export interface KinGitHubAccountRow {
  readonly key: string;
  readonly account: string;
  readonly tone: KinConnectionTone;
  readonly label: string;
  readonly detail: string;
  readonly action: {
    readonly label: string;
    readonly url: string;
    /** The page asks which repos: the hint under the rows says what to pick. */
    readonly picksRepos: boolean;
  } | null;
  /** The App's repos here are picked one by one, and this login may pick them from Kin. */
  readonly pickable: boolean;
  readonly watched: number;
  /** The installation's page on GitHub, offered when GitHub refuses a change made from Kin. */
  readonly settingsUrl: string | null;
}

/** Making Kin's GitHub App from Settings, and letting it go. */
export const KIN_GITHUB_APP_SETUP_COPY = {
  create: "Create Kin's GitHub App",
  createDetail:
    "Agents' commits, pull requests and reviews then show the App as the author instead of you. GitHub opens with the App filled in: choose Create GitHub App there, and GitHub sends you back. Kin keeps its key on this computer.",
  nameLabel: "App name",
  nameHint: "GitHub App names are unique across GitHub. You can change it on GitHub's page too.",
  continue: "Continue on GitHub",
  preparing: "Getting GitHub ready…",
  disconnect: "Disconnect the App",
  disconnectTitle: "Disconnect Kin's GitHub App?",
  disconnectDetail: (name: string) =>
    `Kin forgets ${name} and its key, and agents work on GitHub as you again. The App itself stays on GitHub until you delete it there.`,
  disconnected: (name: string) =>
    `Kin forgot ${name}; agents work on GitHub as you. To remove the App for good, delete it on GitHub.`,
  appOnGitHub: "The App on GitHub",
  setUpInKin: (name: string, by: string, at: string) => `${name}, set up in Kin by ${by} on ${at}.`,
  setUpOnHost: "Set up on Kin's computer; it is changed there.",
} as const;

/** Choosing the App's repos one by one on an account, from Kin. */
export const KIN_GITHUB_APP_REPOS_COPY = {
  choose: (count: number) => `Choose repos (${count})`,
  hide: "Hide repos",
  hint: "Only the repos you pick. Kin changes them on GitHub with your login, and new repos aren't added.",
  search: "Find a repo",
  addAll: "Add all watched repos",
  removeAll: "Remove all",
  appOn: (repo: string) => `${repo}: the App works here`,
  none: "No watched repo matches.",
  openOnGitHub: "Open on GitHub",
} as const;

/** The account's watched repos that match `query`, by name. */
export function kinGitHubAccountRepos(
  repos: ReadonlyArray<KinGitHubRepo>,
  account: string,
  query: string,
): ReadonlyArray<KinGitHubRepo> {
  const prefix = `${account.toLowerCase()}/`;
  const wanted = query.trim().toLowerCase();
  return repos.filter(
    (repo) =>
      repo.watched &&
      repo.repo.toLowerCase().startsWith(prefix) &&
      (wanted === "" || repo.repo.toLowerCase().includes(wanted)),
  );
}

/** Puts the App on repos of one account or takes it off, answered in plain words. */
export function createKinGitHubAppRepoActions(options: {
  readonly orgId: KinOrgId;
  readonly set: (input: KinGitHubAppReposSetInput) => Sent<KinGitHubAppReposResult>;
  readonly refresh: () => void;
}) {
  return async (
    account: string,
    repos: ReadonlyArray<string>,
    on: boolean,
  ): Promise<{ readonly changed: number; readonly problem: string | null }> => {
    const result = await options.set({ orgId: options.orgId, account, repos: [...repos], on });
    options.refresh();
    return AsyncResult.isSuccess(result)
      ? result.value
      : {
          changed: 0,
          problem: kinFailureText(
            squashAtomCommandFailure(result),
            "Couldn't change where the App works.",
            { device: "This device isn't allowed to change where Kin's GitHub App works." },
          ),
        };
  };
}

const reposWord = (count: number) => plural(count, "watched repo");

/** One row per account with watched repos; empty when Kin can't tell the accounts. */
export function kinGitHubAccountRows(agents: KinGitHubAgents): ReadonlyArray<KinGitHubAccountRow> {
  if (agents.as !== "app" || agents.accounts === undefined) return [];
  const app = agents.appName ?? "Kin's GitHub App";
  return agents.accounts.map((row) => ({
    key: row.account.toLowerCase(),
    account: row.account,
    ...accountState(row, app, agents),
    pickable: row.installation === "selected" && row.canManage !== false,
    watched: row.watched,
    settingsUrl: row.settingsUrl,
  }));
}

function accountState(
  row: KinGitHubAppAccount,
  app: string,
  agents: KinGitHubAgents,
): Omit<KinGitHubAccountRow, "key" | "account" | "pickable" | "watched" | "settingsUrl"> {
  const ownersOnly = `Only an owner of ${row.account} can change this on GitHub.`;
  const link = (label: string, url: string | null, picksRepos = true) =>
    url === null ? null : { label, url, picksRepos };
  switch (row.installation) {
    case "all":
      return {
        tone: "ok",
        label: "All repositories",
        detail:
          row.covered >= row.watched
            ? `Covers its ${reposWord(row.watched)}, and new ones.`
            : `Covers ${row.covered} of its ${reposWord(row.watched)}; GitHub doesn't give it the rest yet.`,
        action: null,
      };
    case "selected": {
      const rest = row.watched - row.covered;
      return {
        tone: rest === 0 ? "ok" : "attention",
        label: `Only selected repositories (${row.covered} of ${row.watched} watched)`,
        detail: [
          rest === 0
            ? "Covers every watched repo here, but not repos made later."
            : `Agents work as you on the other ${reposWord(rest)}.`,
          row.canManage === false ? ownersOnly : "",
        ]
          .filter(Boolean)
          .join(" "),
        action:
          row.canManage === false ? null : link("Switch to all repositories", row.settingsUrl),
      };
    }
    case "suspended":
      return {
        tone: "error",
        label: "Suspended",
        detail: `${app} is suspended here, so agents work as you on its ${reposWord(row.watched)} until it is unsuspended on GitHub.${row.canManage === false ? ` ${ownersOnly}` : ""}`,
        action: row.canManage === false ? null : link("Open on GitHub", row.settingsUrl, false),
      };
    case "none": {
      if (!row.installable)
        return {
          tone: "muted",
          label: "Not installed",
          detail: `${app} can only be installed on ${agents.appOwner ?? "the account that owns it"}, so agents work as you here. Making it public in its settings on GitHub lets you install it on ${row.account}.`,
          action:
            agents.appSettingsUrl === undefined
              ? null
              : { label: "Open the App's settings", url: agents.appSettingsUrl, picksRepos: false },
        };
      if (row.canManage === false)
        return {
          tone: "muted",
          label: "Not installed",
          detail: `Only an owner of ${row.account} can install ${app}. GitHub sends them your request; this row changes once one of them installs it.`,
          action: link(`Ask an owner of ${row.account}`, row.installUrl),
        };
      return {
        tone: "attention",
        label: "Not installed",
        detail: `Agents work as you on its ${reposWord(row.watched)}.${
          row.organisation && row.canManage === null
            ? ` If you don't own ${row.account}, GitHub sends your request to its owners instead.`
            : ""
        }`,
        action: link("Install on all repositories", row.installUrl),
      };
    }
  }
}

/** Whether to show the hint under the rows: some row sends the owner to pick on GitHub. */
export const kinGitHubAccountsHint = (rows: ReadonlyArray<KinGitHubAccountRow>) =>
  rows.some((row) => row.action?.picksRepos === true) ? KIN_GITHUB_AGENTS_COPY.accountsHint : null;

export interface KinGitHubAgentsView {
  readonly headline: string;
  readonly detail: string;
  /** GitHub's own install page, only while Kin can't tell the accounts to give each a row. */
  readonly installUrl: string | null;
  /** Which App this is and where it was set up; null without one. */
  readonly setUpLine: string | null;
  /** No App anywhere: Settings can make one. */
  readonly canCreate: boolean;
  /** The App was made in Kin, so Kin can forget it; its GitHub page when it can. */
  readonly disconnect: { readonly name: string; readonly settingsUrl: string | null } | null;
  /** The latest commands agents ran as the owner, newest first. */
  readonly uses: ReadonlyArray<{
    readonly key: string;
    readonly line: string;
    readonly command: string;
  }>;
}

const repoList = (repos: ReadonlyArray<string>, total: number) => {
  const named = repos.slice(0, 3);
  const more = total - named.length;
  if (more > 0) return `${named.join(", ")} and ${plural(more, "more repo")}`;
  return named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
};

/** "Agents work on GitHub as Kin by Ambermill on 3 of 5 watched repos.", and what that means for the rest. */
export function kinGitHubAgentsView(
  agents: KinGitHubAgents,
  ownerLogin: string | null,
  now: number,
): KinGitHubAgentsView {
  const you = ownerLogin === null ? "you" : `you (${ownerLogin})`;
  const uses = agents.ownerUses.map((use, index) => ({
    key: `${use.at}-${index}`,
    line: `${use.agent ?? "An agent"}${use.repo === null ? "" : ` on ${use.repo}`}, ${ago(use.at, now)}`,
    command: use.command,
  }));
  const app = agents.appName ?? "Kin's GitHub App";
  const setUp = agents.setUp;
  const setUpLine =
    setUp === undefined
      ? null
      : setUp.source === "host"
        ? KIN_GITHUB_APP_SETUP_COPY.setUpOnHost
        : KIN_GITHUB_APP_SETUP_COPY.setUpInKin(
            setUp.name ?? app,
            setUp.by ?? "the owner",
            setUp.at === null
              ? "an earlier day"
              : new Date(setUp.at).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                }),
          );
  const extras = {
    setUpLine,
    canCreate: agents.canCreate === true,
    disconnect:
      setUp?.source === "kin" ? { name: setUp.name ?? app, settingsUrl: setUp.settingsUrl } : null,
  };
  if (agents.as === "owner")
    return {
      headline: `Agents work on GitHub as ${you}.`,
      detail:
        agents.problem ??
        "Kin has no GitHub App on this computer, so their commits, pull requests and reviews carry your name, signed with the agent's.",
      installUrl: null,
      ...extras,
      uses,
    };
  const missing = agents.watched - agents.installed;
  const headline =
    agents.watched === 0
      ? `Agents work on GitHub as ${app} wherever it is installed.`
      : agents.installed === 0
        ? `${app} isn't installed on any watched repo yet, so agents work there as ${you}.`
        : missing === 0
          ? `Agents work on GitHub as ${app} on ${agents.watched === 1 ? "your watched repo" : `all ${agents.watched} watched repos`}.`
          : `Agents work on GitHub as ${app} on ${agents.installed} of ${agents.watched} watched repos.`;
  const detail =
    agents.watched > 0 && agents.installed === 0
      ? `Their commits, pull requests and reviews there carry your name, signed with the agent's. Once ${app} is on a repo, its work there shows the App as the author.`
      : missing > 0
        ? `On ${repoList(agents.without, missing)}, their work goes out as ${you}. An agent also works as you, one command at a time, when the App can't do something or you ask it to.`
        : "Their commits, pull requests and reviews show the App as the author. An agent works as you, one command at a time, only when the App can't do something or you ask it to.";
  return {
    headline,
    detail,
    installUrl: agents.accounts === undefined ? (agents.installUrl ?? null) : null,
    ...extras,
    uses,
  };
}
