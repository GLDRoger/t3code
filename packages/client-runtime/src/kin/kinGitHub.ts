import {
  KinConnectionKey,
  type KinGitHubAgents,
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
} as const;

export interface KinGitHubAgentsView {
  readonly headline: string;
  readonly detail: string;
  /** Where to install the App on more repos; null while there is no App. */
  readonly installUrl: string | null;
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
  if (agents.as === "owner")
    return {
      headline: `Agents work on GitHub as ${you}.`,
      detail:
        agents.problem ??
        "Kin has no GitHub App on this computer, so their commits, pull requests and reviews carry your name, signed with the agent's.",
      installUrl: null,
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
    agents.installed > 0 && missing > 0
      ? `On ${repoList(agents.without, missing)}, their work goes out as ${you}. An agent also works as you, one command at a time, when the App can't do something or you ask it to.`
      : "Their commits, pull requests and reviews show the App as the author. An agent works as you, one command at a time, only when the App can't do something or you ask it to.";
  return { headline, detail, installUrl: agents.installUrl ?? null, uses };
}
