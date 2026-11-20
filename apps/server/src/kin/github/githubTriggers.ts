import { WRITE_BRANCH_PREFIX } from "../memory/MemoryConfig.ts";
import { isAgentText, postKey } from "./agentMark.ts";

/**
 * Which GitHub activity starts an agent's work, decided by code from GitHub's own data. The poll
 * (`GitHubWatch.ts`) reads one issue or PR and what is new on it; this says what to wake for.
 */

/** GitHub's author associations for people who can write to the repo: inside the company. */
const INSIDE_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const isInside = (association: string) => INSIDE_ASSOCIATIONS.has(association.toUpperCase());

const KIN_LABEL = "kin";
const TEXT_CAP = 4_000;

export interface ThreadComment {
  readonly id: number;
  readonly kind: "issue" | "review";
  readonly body: string;
  readonly author: string;
  readonly association: string;
  readonly createdAt: number;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
}

export interface ThreadSnapshot {
  readonly repo: string;
  readonly number: number;
  readonly item: "issue" | "pull";
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly association: string;
  readonly open: boolean;
  readonly draft: boolean;
  readonly createdAt: number;
  readonly labels: ReadonlyArray<string>;
  readonly pull?:
    | {
        readonly files: number;
        readonly additions: number;
        readonly deletions: number;
        readonly headRef: string;
        readonly baseRef: string;
        readonly headSha: string;
        readonly fork: boolean;
        /** When GitHub last changed the PR; a push moves it, so the head is at least this still. */
        readonly updatedAt?: number | undefined;
      }
    | undefined;
  readonly comments: ReadonlyArray<ThreadComment>;
  /** GitHub's notification says a review was asked of the owner's account. */
  readonly reviewRequested: boolean;
  /** Names of failing checks on the head, read only for a PR an agent opened. */
  readonly failing?: ReadonlyArray<string> | undefined;
}

export interface Agent {
  readonly agentId: string;
  readonly name: string;
}

export interface DecideContext {
  readonly ownerLogin: string;
  readonly agents: ReadonlyArray<Agent>;
  /** The Tech lead, or whoever leads engineering: a call that names no one goes there. */
  readonly defaultAgentId: string;
  /** The owner turned on "an @-mention of me calls an agent" for this repo. */
  readonly mentions: boolean;
  /** Anything created before this is history Kin was not watching for. */
  readonly since: number;
  /** Kin saw this PR as a draft earlier, so its being ready now is new. */
  readonly draftSeen: boolean;
  /** The login of Kin's GitHub App, while agents work as it: what it writes is Kin's own. */
  readonly botLogin?: string | undefined;
  /** `postKey`s of texts agents' shells sent: their own words, even unsigned and as the owner. */
  readonly agentPosts?: ReadonlySet<string> | undefined;
}

/**
 * Kin's own work: written by its GitHub App, carrying an agent's marker, or a text an agent's shell
 * recorded sending (as the owner, a marker can be lost).
 */
export const isAgentsOwn = (
  text: string | null | undefined,
  author: string,
  botLogin: string | undefined,
  agentPosts?: ReadonlySet<string>,
) =>
  isAgentText(text) ||
  (botLogin !== undefined && botLogin !== "" && author.toLowerCase() === botLogin.toLowerCase()) ||
  (agentPosts !== undefined &&
    agentPosts.size > 0 &&
    text !== null &&
    text !== undefined &&
    text.trim() !== "" &&
    agentPosts.has(postKey(text)));

export interface Trigger {
  readonly key: string;
  readonly kind: "review" | "call" | "label" | "review_request" | "checks";
  readonly agentId: string;
  readonly inside: boolean;
  readonly author: string;
  readonly association: string;
  readonly text: string;
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  /** What the one reaction goes on. */
  readonly reactTo:
    | { readonly type: "issue" }
    | { readonly type: "comment"; readonly kind: "issue" | "review"; readonly id: number };
}

const clip = (text: string) => (text.length <= TEXT_CAP ? text : `${text.slice(0, TEXT_CAP - 1)}…`);

/** Lines a person wrote here: no quoted replies and no code, so a quoted call never re-calls. */
const ownLines = (text: string) => {
  const lines: string[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && !/^\s*>/.test(line)) lines.push(line);
  }
  return lines;
};

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The agent a text calls, or undefined: a line starting with `/kin`, or with a Kin agent's name
 * followed by a comma or colon ("Tech lead, …"); with `mentions` on, the owner's @login too.
 */
const calledAgent = (
  text: string,
  context: Pick<DecideContext, "agents" | "defaultAgentId" | "mentions" | "ownerLogin">,
): string | undefined => {
  const names = context.agents.toSorted((a, b) => b.name.length - a.name.length);
  for (const line of ownLines(text)) {
    const kin = /^\s*\/kin\b[\s,:]*(.*)$/i.exec(line);
    if (kin !== null) {
      const named = names.find((agent) =>
        new RegExp(`^${escaped(agent.name)}\\b`, "i").test(kin[1] ?? ""),
      );
      return named?.agentId ?? context.defaultAgentId;
    }
    const named = names.find((agent) =>
      new RegExp(`^\\s*@?${escaped(agent.name)}\\s*[,:]`, "i").test(line),
    );
    if (named !== undefined) return named.agentId;
    if (
      context.mentions &&
      context.ownerLogin !== "" &&
      new RegExp(`(^|[^A-Za-z0-9-])@${escaped(context.ownerLogin)}(?![A-Za-z0-9-])`, "i").test(line)
    )
      return context.defaultAgentId;
  }
  return undefined;
};

/** What this snapshot starts, in order; keys say what was handled, so none starts twice. */
export const decideTriggers = (
  thread: ThreadSnapshot,
  context: DecideContext,
): ReadonlyArray<Trigger> => {
  // Kin's memory writes land through PRs, as the App or the owner, with no marker.
  if (thread.pull?.headRef.startsWith(WRITE_BRANCH_PREFIX) === true) return [];
  const at = `${thread.repo.toLowerCase()}#${thread.number}`;
  const agentsOwn = isAgentsOwn(thread.body, thread.author, context.botLogin, context.agentPosts);
  const itemInside = isInside(thread.association);
  const triggers: Trigger[] = [];
  const onItem = {
    agentId: context.defaultAgentId,
    author: thread.author,
    association: thread.association,
    reactTo: { type: "issue" } as const,
  };

  if (thread.item === "pull" && thread.open && !thread.draft && !agentsOwn) {
    if (thread.createdAt >= context.since || context.draftSeen)
      triggers.push({
        ...onItem,
        key: `review:${at}`,
        kind: "review",
        inside: itemInside,
        text: clip(thread.body),
      });
    else if (thread.reviewRequested && thread.pull !== undefined)
      triggers.push({
        ...onItem,
        key: `review:${at}:${thread.pull.headSha}`,
        kind: "review_request",
        inside: itemInside,
        text: clip(thread.body),
      });
  }

  if (
    thread.item === "pull" &&
    thread.open &&
    agentsOwn &&
    thread.pull !== undefined &&
    (thread.failing?.length ?? 0) > 0
  )
    triggers.push({
      ...onItem,
      key: `checks:${at}:${thread.pull.headSha}`,
      kind: "checks",
      inside: true,
      text: (thread.failing ?? []).join(", "),
    });

  if (thread.open && !agentsOwn && thread.labels.some((label) => label.toLowerCase() === KIN_LABEL))
    triggers.push({
      ...onItem,
      key: `label:${at}`,
      kind: "label",
      // Only people who can write may label; the words shown are still the item author's.
      inside: itemInside,
      text: clip(thread.body),
    });

  if (
    thread.createdAt >= context.since &&
    !agentsOwn &&
    itemInside &&
    !triggers.some((trigger) => trigger.kind === "label")
  ) {
    const agentId = calledAgent(`${thread.title}\n${thread.body}`, context);
    if (agentId !== undefined)
      triggers.push({
        ...onItem,
        agentId,
        key: `call:${at}:body`,
        kind: "call",
        inside: true,
        text: clip(thread.body),
      });
  }

  for (const comment of thread.comments.toSorted(
    (a, b) => a.createdAt - b.createdAt || a.id - b.id,
  )) {
    // A stranger's call starts nothing; an agent's own words never do.
    if (
      comment.createdAt < context.since ||
      isAgentsOwn(comment.body, comment.author, context.botLogin, context.agentPosts) ||
      !isInside(comment.association)
    )
      continue;
    const agentId = calledAgent(comment.body, context);
    if (agentId === undefined) continue;
    triggers.push({
      key: `call:${at}:${comment.kind === "review" ? "r" : "c"}${comment.id}`,
      kind: "call",
      agentId,
      inside: true,
      author: comment.author,
      association: comment.association,
      text: clip(comment.body),
      ...(comment.path === undefined ? {} : { path: comment.path }),
      ...(comment.line === undefined ? {} : { line: comment.line }),
      reactTo: { type: "comment", kind: comment.kind, id: comment.id },
    });
  }
  return triggers;
};
