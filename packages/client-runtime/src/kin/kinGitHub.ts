import {
  KinConnectionKey,
  type KinGitHubConnectInput,
  type KinGitHubInput,
  type KinGitHubStatus,
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
    "Your own GitHub login on your Kin's computer. Agents can then clone, push and open pull requests as you, on any repository your account can reach.",
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
