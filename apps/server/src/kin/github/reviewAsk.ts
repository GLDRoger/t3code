import { KinAgentId, KinChatError, type KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { peopleBehind, SHARED_REFUSAL, turnChat } from "../lead/Audience.ts";
import { teammatesLimited } from "../lead/KinBudget.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import * as Reach from "../lead/Reach.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import { isOwnerHimself, mayActAsOwner } from "../people/KinAccess.ts";
import { boundReview, headKey, POSTING, receiptOf } from "./boundReview.ts";
import {
  agentPostsOf,
  botLoginOf,
  claimTrigger,
  FIRST_REVIEW_HEAD,
  KinGitHubApi,
  ownerGitHubReview,
  PER_THREAD_HOURLY,
  postedResult,
  sendReview,
  readDiff,
  readThread,
  reclaimable,
  writesTo,
} from "./GitHubWatch.ts";
import { decideTriggers } from "./githubTriggers.ts";
import { isMemoryRepo, repoList } from "./githubWatchStore.ts";
import { gitHubApp } from "./KinGitHubApp.ts";

/**
 * A person's request, in their own chat with an agent, for a review of pull requests on the
 * company's watched repos they can read. It enters the watch's own path (`claimTrigger`) as a
 * re-requested review would: same lane, key and caps, a turn with no shell bound to that pull
 * request and head, and the outcome told to them from the post's receipt (`askedFor.ts`).
 */

export const AskInput = Schema.Struct({
  repo: Schema.optional(Schema.String.annotate({ description: "owner/name." })),
  number: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export const AskResult = Schema.Struct({
  pulls: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      number: Schema.Int,
      head: Schema.String,
      outcome: Schema.String,
    }),
  ),
  left: Schema.optional(Schema.String),
  next: Schema.String,
});

const ASKS_PER_CALL = 5;
const LIST_PAGE = 100;
const QUEUED = "queued";
const NOTHING = "Nothing was started.";
const short = (sha: string) => sha.slice(0, 7);

export const ASK_REFUSAL = {
  chat: `A review is asked for only in a person's own direct chat with you. ${NOTHING}`,
  restricted: (name: string, agent: string) =>
    `${name} and ${agent} can't message each other. The owner can lift that. ${NOTHING}`,
  limit: (name: string) =>
    `${name} has reached today's limit. They can ask again later. ${NOTHING}`,
  disconnected: `GitHub isn't connected. The owner connects it in Settings, Connections. ${NOTHING}`,
  unreachable: `Kin couldn't reach GitHub just now. ${NOTHING}`,
  memory: (repo: string) => `${repo} is Kin's memory repo, which Kin never reviews. ${NOTHING}`,
  unwatched: (repo: string) =>
    `${repo} isn't a repo Kin watches. The owner adds it in Settings, Connections. ${NOTHING}`,
  noLogin: (name: string) =>
    `Kin has no GitHub username on file for ${name}, so it reviews only public repos for them, named by repo. ${NOTHING}`,
} as const;
export const PULL_REFUSAL = {
  missing: `Kin can't find this pull request. ${NOTHING}`,
  closed: `It isn't open. ${NOTHING}`,
  draft: `It is a draft: mark it ready and ask again. ${NOTHING}`,
  kins: `Kin wrote it, so Kin doesn't review it. ${NOTHING}`,
  capped: `Kin has worked on it ${PER_THREAD_HOURLY} times this past hour. Ask again later. ${NOTHING}`,
  diff: `Kin couldn't read that pull request's changes just now. ${NOTHING}`,
  underWay: "a review of this head is already under way",
  already: (sha: string) => `already reviewed at ${short(sha)}; nothing new since`,
} as const;
export const POST_REFUSAL = {
  other: (ref: string) =>
    `This turn reviews only ${ref}, the pull request someone asked for. Nothing was posted.`,
  only: (ref: string) => `This turn reviews only ${ref}. Nothing was posted.`,
  comment: "This review posts as a comment only: event COMMENT. Nothing was posted.",
  again: (ref: string) => `The review of ${ref} is already posted. Nothing more was posted.`,
  unsure: (ref: string) =>
    `A review of ${ref} was sent and GitHub never said whether it took it, so Kin sends no other. Nothing was posted.`,
  unknown: (ref: string) =>
    `GitHub didn't say whether it took the review of ${ref}, so Kin won't send it again. It may be on the pull request.`,
} as const;

const OpenPull = Schema.Struct({
  number: Schema.Int,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({ sha: Schema.String }),
});
const decodeOpenPulls = Schema.decodeUnknownOption(Schema.Array(OpenPull));
const decodeVisibility = Schema.decodeUnknownOption(Schema.Struct({ private: Schema.Boolean }));

const refuse = (message: string) =>
  Effect.fail(new KinChatError({ reason: "not_allowed", message }));

/** The one person whose own direct chat with this agent the turn answers, or undefined. */
const askerOf = Effect.fn("KinGitHubReviewAsk.asker")(function* (turn: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* turnChat(turn);
  if (chat === undefined || !chat.asked) return undefined;
  const suffix = `:${turn.agentId}`;
  const [direct] = yield* sql<{ key: string | null }>`SELECT direct_key AS key FROM kin_chats
    WHERE org_id = ${turn.orgId} AND chat_id = ${chat.chatId} AND kind = 'direct'
      AND archived_at IS NULL`;
  if (direct?.key == null || !direct.key.endsWith(suffix)) return undefined;
  const personId = KinPersonId.make(direct.key.slice(0, -suffix.length));
  const behind = yield* peopleBehind(turn);
  if (
    behind === undefined ||
    !behind.askers.has(personId) ||
    [...behind.readers, ...behind.askers].some((person) => person !== personId)
  )
    return undefined;
  const [person] = yield* sql<{ name: string; login: string | null }>`SELECT
      display_name AS name, github_login AS login FROM kin_people
    WHERE org_id = ${turn.orgId} AND person_id = ${personId} AND removed_at IS NULL`;
  return person === undefined ? undefined : { personId, ...person };
});

/**
 * Which pull requests a person's ask names, checked, and each one that passes queued as the watch
 * queues a re-requested review. The server decides which and whether; the model only asks.
 */
export const askReview = Effect.fn("KinGitHubReviewAsk.ask")(function* (
  scope: McpInvocationScope,
  input: typeof AskInput.Type,
) {
  const lead = yield* resolveLead(scope);
  if (!(yield* toolAdmitted(lead, "kin_github_review_ask", input)))
    return yield* refuse(SHARED_REFUSAL);
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = lead;
  const agentId = KinAgentId.make(lead.agentId);
  const asker = yield* askerOf(lead);
  if (asker === undefined) return yield* refuse(ASK_REFUSAL.chat);
  const [agent] = yield* sql<{ name: string; ownerPersonId: string }>`SELECT l.name,
      a.owner_person_id AS "ownerPersonId" FROM kin_leads l
    JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
    WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}`;
  const agentName = agent?.name ?? "this agent";
  const owner = { personId: agent?.ownerPersonId ?? "" };
  if (
    (yield* Reach.mayReach(orgId, Reach.person(asker.personId), Reach.agent(agentId))) !== "allowed"
  )
    return yield* refuse(ASK_REFUSAL.restricted(asker.name, agentName));
  const now = yield* Clock.currentTimeMillis;
  // Each review is a turn of theirs, counted as ChatWake counts their messages, owner-level never.
  const exempt = yield* mayActAsOwner(orgId, asker.personId, owner);
  const dailyTurns = yield* LeadAccess.dailyTurns;
  const overLimit = exempt
    ? Effect.succeed(false)
    : Effect.gen(function* () {
        if (!(yield* teammatesLimited(orgId))) return false;
        const used = yield* LeadAccess.recentTurns({ orgId, personId: asker.personId, now });
        return used.turns >= dailyTurns;
      });
  if (yield* overLimit) return yield* refuse(ASK_REFUSAL.limit(asker.name));

  const api = yield* KinGitHubApi;
  const account = yield* api.connected();
  if (account === null) return yield* refuse(ASK_REFUSAL.disconnected);
  const get = (path: string, headers?: Record<string, string>) =>
    api.call({ path, ...(headers === undefined ? {} : { headers }) });
  // The connected login is the owner's: his own ask reads as him, anyone else's as themselves.
  const himself = isOwnerHimself(owner, asker.personId);
  const login = asker.login ?? (himself ? account.login : null);
  /** Whether they may ask about this watched repo: it is public, or GitHub says they can read it. */
  const mayAsk = Effect.fn("KinGitHubReviewAsk.mayAsk")(function* (repo: string) {
    if (himself) return "yes" as const;
    const answer = yield* get(`repos/${repo}`);
    const visibility = answer.status === 200 ? decodeVisibility(answer.body) : Option.none();
    if (Option.isNone(visibility)) return "error" as const;
    if (!visibility.value.private) return "yes" as const;
    if (login === null) return "no" as const;
    const member = yield* get(`repos/${repo}/collaborators/${encodeURIComponent(login)}`);
    return member.status === 204 ? "yes" : member.status === 404 ? "no" : "error";
  });
  // One answer for a repo they may not ask about and one Kin doesn't watch.
  const notAllowed = (repo: string) =>
    login === null ? ASK_REFUSAL.noLogin(asker.name) : ASK_REFUSAL.unwatched(repo);
  const watched = (yield* repoList(orgId)).filter((repo) => repo.watched);
  const repos: Array<string> = [];
  if (input.repo !== undefined) {
    const repo = input.repo.trim();
    if (yield* isMemoryRepo(repo)) return yield* refuse(ASK_REFUSAL.memory(repo));
    const entry = watched.find((one) => one.repo.toLowerCase() === repo.toLowerCase());
    if (entry === undefined) return yield* refuse(notAllowed(repo));
    const may = yield* mayAsk(entry.repo);
    if (may === "error") return yield* refuse(ASK_REFUSAL.unreachable);
    if (may === "no") return yield* refuse(notAllowed(repo));
    repos.push(entry.repo);
  } else {
    if (login === null) return yield* refuse(ASK_REFUSAL.noLogin(asker.name));
    for (const entry of watched) {
      const may = yield* mayAsk(entry.repo);
      if (may === "error") return yield* refuse(ASK_REFUSAL.unreachable);
      if (may === "yes") repos.push(entry.repo);
    }
  }

  // One PR by repo and number; otherwise the open ones there, theirs unless Kin has no login.
  const candidates: Array<{ repo: string; number: number; head: string }> = [];
  const cut: Array<string> = [];
  if (input.repo !== undefined && input.number !== undefined)
    candidates.push({ repo: repos[0]!, number: input.number, head: "" });
  else
    for (const repo of repos) {
      const answer = yield* get(`repos/${repo}/pulls?state=open&per_page=${LIST_PAGE}`);
      const open = answer.status === 200 ? decodeOpenPulls(answer.body) : Option.none();
      if (Option.isNone(open)) return yield* refuse(ASK_REFUSAL.unreachable);
      if (open.value.length >= LIST_PAGE) cut.push(repo);
      for (const pull of open.value)
        if (
          (login === null || pull.user?.login.toLowerCase() === login.toLowerCase()) &&
          (input.number === undefined || pull.number === input.number)
        )
          candidates.push({ repo, number: pull.number, head: pull.head.sha });
    }
  candidates.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  const app = yield* gitHubApp;
  const bot = yield* botLoginOf(app);
  const posts = yield* agentPostsOf(
    yield* Effect.serviceOption(ServerConfig),
    yield* Effect.serviceOption(FileSystem.FileSystem),
  );
  /** What is known of a head: undefined while it may be claimed, else what to tell them. */
  const told = Effect.fn("KinGitHubReviewAsk.told")(function* (
    repo: string,
    number: number,
    head: string,
  ) {
    const key = headKey(repo, number, head);
    const [row] = yield* sql<{ outcome: string; at: number }>`SELECT outcome, at
      FROM kin_github_handled WHERE org_id = ${orgId} AND trigger_key = ${key}`;
    if (row === undefined || reclaimable(row, now)) return undefined;
    if (row.outcome === "capped") return PULL_REFUSAL.capped;
    // The watch's first look at a PR holds its head under the PR's own first-review key.
    const ran = row.outcome === FIRST_REVIEW_HEAD ? `review:${repo.toLowerCase()}#${number}` : key;
    const [event] = yield* sql<{ state: string }>`SELECT state FROM kin_events
      WHERE org_id = ${orgId} AND tag = 'github' AND json_extract(json, '$.trigger.key') = ${ran}
      ORDER BY queued_at DESC, rowid DESC LIMIT 1`;
    return event?.state === "queued" || event?.state === "claimed"
      ? PULL_REFUSAL.underWay
      : PULL_REFUSAL.already(head);
  });
  const pulls: Array<(typeof AskResult.Type)["pulls"][number]> = [];
  const left: Array<string> = [];
  let queued = 0;
  for (const candidate of candidates) {
    const line = (outcome: string, head = candidate.head) =>
      pulls.push({ repo: candidate.repo, number: candidate.number, head: short(head), outcome });
    // A head already handled reads as that with no call to GitHub.
    const known =
      candidate.head === ""
        ? undefined
        : yield* told(candidate.repo, candidate.number, candidate.head);
    if (known !== undefined) {
      line(known);
      continue;
    }
    if (queued >= ASKS_PER_CALL) {
      left.push(`${candidate.repo}#${candidate.number}`);
      continue;
    }
    if (yield* overLimit) {
      line(ASK_REFUSAL.limit(asker.name));
      continue;
    }
    const read = yield* readThread(
      get,
      { repo: candidate.repo, number: candidate.number, reviewRequested: true },
      now,
    );
    const thread = read?.thread;
    if (thread === undefined || thread.item !== "pull" || thread.pull === undefined) {
      line(PULL_REFUSAL.missing);
      continue;
    }
    const pull = thread.pull;
    const facts = (outcome: string) => line(outcome, pull.headSha);
    if (!thread.open) {
      facts(PULL_REFUSAL.closed);
      continue;
    }
    if (thread.draft) {
      facts(PULL_REFUSAL.draft);
      continue;
    }
    // The watch's own decision for a review asked of the owner: none for Kin's own PRs.
    const inside =
      thread.author.toLowerCase() === account.login.toLowerCase() ||
      (yield* writesTo(get, thread.repo, thread.author)) === true;
    const trigger = decideTriggers(thread, {
      writes: (author) => inside && author.toLowerCase() === thread.author.toLowerCase(),
      ownerLogin: account.login,
      agents: [],
      defaultAgentId: agentId,
      mentions: false,
      since: Number.POSITIVE_INFINITY,
      draftSeen: false,
      botLogin: bot,
      agentPosts: posts,
    }).find((one) => one.kind === "review_request");
    if (trigger === undefined) {
      facts(PULL_REFUSAL.kins);
      continue;
    }
    const before = yield* told(thread.repo, thread.number, pull.headSha);
    if (before !== undefined) {
      facts(before);
      continue;
    }
    // This turn has no shell: the server reads the diff of the head it admits.
    const diff = yield* readDiff(get, thread.repo, thread.number, {
      baseRef: pull.baseRef,
      headSha: pull.headSha,
    });
    if (diff === undefined) {
      facts(PULL_REFUSAL.diff);
      continue;
    }
    const outcome = yield* claimTrigger({
      orgId,
      thread,
      trigger,
      ownerLogin: account.login,
      agentId,
      now,
      woken: 0,
      happenedAt: now,
      diff,
      askedBy: asker.personId,
    });
    if (outcome === "woke") queued += 1;
    facts(
      outcome === "woke"
        ? QUEUED
        : outcome === "seen"
          ? ((yield* told(thread.repo, thread.number, pull.headSha)) ??
            PULL_REFUSAL.already(pull.headSha))
          : PULL_REFUSAL.capped,
    );
  }
  const cutNote =
    cut.length === 0
      ? ""
      : ` ${cut.join(", ")} has more than ${LIST_PAGE} open pull requests and Kin read only the newest ${LIST_PAGE}: for another, ask by number.`;
  return {
    pulls,
    ...(left.length === 0
      ? {}
      : {
          left: `${ASKS_PER_CALL} are queued per ask, so these wait: ${left.join(", ")}. Ask again for them.`,
        }),
    next:
      (pulls.length === 0
        ? `${asker.name} has no open pull requests there. ${NOTHING}`
        : queued > 0
          ? "Tell them each line as it reads. You haven't read a queued one yet: Kin tells them in this chat when its review is posted, or that it didn't finish."
          : "Tell them each line as it reads.") + cutNote,
  };
});

/**
 * `kin_github_review`. A turn bound to one pull request at one head (`boundReview`) posts there
 * once, against that head, its receipt on the head's row. An asked or outside review posts only
 * there, an outside one as a comment only; a teammate's re-review may post elsewhere unbound, as it
 * has a shell. The head is claimed before anything is sent and kept unless GitHub refused it.
 */
export const postReview = Effect.fn("KinGitHubReviewAsk.post")(function* (
  lead: { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string },
  input: Parameters<typeof sendReview>[1],
) {
  const bound = yield* boundReview(lead);
  if (bound === undefined) return yield* ownerGitHubReview(lead, input);
  const sql = yield* SqlClient.SqlClient;
  const ref = `${bound.repo}#${bound.number}`;
  if (input.repo.trim().toLowerCase() !== bound.repo.toLowerCase() || input.number !== bound.number)
    return bound.asked
      ? yield* refuse(POST_REFUSAL.other(ref))
      : bound.outside
        ? yield* refuse(POST_REFUSAL.only(ref))
        : yield* ownerGitHubReview(lead, input);
  if (bound.outside && (input.event ?? "COMMENT") !== "COMMENT")
    return yield* refuse(POST_REFUSAL.comment);
  const receipt = receiptOf(bound.url);
  if (receipt._tag !== "none")
    return yield* refuse(
      receipt._tag === "posted" ? POST_REFUSAL.again(ref) : POST_REFUSAL.unsure(ref),
    );
  const claimed = yield* sql`UPDATE kin_github_handled SET review_url = ${POSTING}
    WHERE org_id = ${lead.orgId} AND trigger_key = ${bound.key} AND review_url IS NULL
    RETURNING trigger_key`;
  if (claimed.length === 0) return yield* refuse(POST_REFUSAL.again(ref));
  // The queue sees the turn acted, so a failure after this isn't run again.
  yield* sql`INSERT INTO kin_lead_tool_calls (org_id, wakeup_id, call_key, request_hash)
    VALUES (${lead.orgId}, ${lead.wakeupId}, ${`github-review:${bound.eventId}`}, 'posting')
    ON CONFLICT DO NOTHING`;
  const giveBack = sql`UPDATE kin_github_handled SET review_url = NULL
    WHERE org_id = ${lead.orgId} AND trigger_key = ${bound.key} AND review_url = ${POSTING}`.pipe(
    Effect.andThen(
      sql`DELETE FROM kin_lead_tool_calls WHERE org_id = ${lead.orgId}
        AND wakeup_id = ${lead.wakeupId} AND call_key = ${`github-review:${bound.eventId}`}`,
    ),
  );
  // Nothing left this server before a failure here: the head is given back.
  const sent = yield* sendReview(lead, input, bound.head).pipe(Effect.tapError(() => giveBack));
  if (sent === undefined) {
    yield* giveBack;
    return undefined;
  }
  switch (sent._tag) {
    case "posted":
      yield* sql`UPDATE kin_github_handled SET review_url = ${sent.url}
        WHERE org_id = ${lead.orgId} AND trigger_key = ${bound.key}`;
      return postedResult(sent);
    case "refused":
      yield* giveBack;
      return yield* new KinChatError({ reason: sent.reason, message: sent.message });
    case "unknown":
      return yield* new KinChatError({
        reason: "unavailable",
        message: POST_REFUSAL.unknown(ref),
      });
  }
});
