import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { peopleBehind, SHARED_REFUSAL, turnChat } from "../lead/Audience.ts";
import { teammatesLimited } from "../lead/KinBudget.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import * as Reach from "../lead/Reach.ts";
import { toolAdmitted } from "../lead/SharedTools.ts";
import {
  agentPostsOf,
  botLoginOf,
  claimTrigger,
  KinGitHubApi,
  PER_THREAD_HOURLY,
  readDiff,
  readThread,
  UNFINISHED,
} from "./GitHubWatch.ts";
import { askedForLine } from "./askedFor.ts";
import { decideTriggers } from "./githubTriggers.ts";
import { isMemoryRepo, repoList } from "./githubWatchStore.ts";
import { gitHubApp } from "./KinGitHubApp.ts";

/**
 * A person's request, in their own chat with an agent, for a review of pull requests on the
 * company's watched repos. It enters the watch's own path (`claimTrigger`) as a re-requested
 * review would: same lane, key and caps, a turn with no shell, and the outcome told to them.
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
      title: Schema.String,
      head: Schema.String,
      outcome: Schema.String,
    }),
  ),
  left: Schema.optional(Schema.String),
  next: Schema.String,
});

const ASKS_PER_CALL = 5;
const STARTED = "started";
const NOTHING = "Nothing was started.";
const short = (sha: string) => sha.slice(0, 7);

export const ASK_REFUSAL = {
  chat: `A review is asked for only in a person's own direct chat with you. ${NOTHING}`,
  restricted: (name: string, agent: string) =>
    `${name} and ${agent} can't message each other. The owner can lift that. ${NOTHING}`,
  limit: (name: string) =>
    `${name} has reached today's limit. They can ask again later. ${NOTHING}`,
  disconnected: `GitHub isn't connected. The owner connects it in Settings, Connections. ${NOTHING}`,
  memory: (repo: string) => `${repo} is Kin's memory repo, which Kin never reviews. ${NOTHING}`,
  unwatched: (repo: string) =>
    `${repo} isn't a repo Kin watches. The owner adds it in Settings, Connections. ${NOTHING}`,
  noLogin: (name: string) =>
    `Kin has no GitHub login for ${name}, so it can't find their pull requests. Ask which repo. ${NOTHING}`,
} as const;
const PULL_REFUSAL = {
  missing: `Kin can't find this pull request. ${NOTHING}`,
  closed: `It isn't open. ${NOTHING}`,
  draft: `It is a draft: mark it ready and ask again. ${NOTHING}`,
  kins: `Kin wrote it, so Kin doesn't review it. ${NOTHING}`,
  capped: `Kin has worked on it ${PER_THREAD_HOURLY} times this past hour. Ask again later. ${NOTHING}`,
  already: (sha: string) => `already reviewed at ${short(sha)}; nothing new since`,
} as const;

export const unfinishedLine = (agent: string, ref: string) =>
  `${agent}'s review of ${ref} didn't finish, so nothing was posted. Ask again to retry.`;

const OpenPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({ sha: Schema.String }),
});
const decodeOpenPulls = Schema.decodeUnknownOption(Schema.Array(OpenPull));

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
  const [named] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
    WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
  const agentName = named?.name ?? "this agent";
  if (
    (yield* Reach.mayReach(orgId, Reach.person(asker.personId), Reach.agent(agentId))) !== "allowed"
  )
    return yield* refuse(ASK_REFUSAL.restricted(asker.name, agentName));
  const now = yield* Clock.currentTimeMillis;
  // Each review is a turn of theirs, counted as ChatWake counts their messages.
  const used = yield* LeadAccess.recentTurns({ orgId, personId: asker.personId, now });
  const dailyTurns = yield* LeadAccess.dailyTurns;
  const limited = yield* teammatesLimited(orgId);
  if (limited && used.turns >= dailyTurns) return yield* refuse(ASK_REFUSAL.limit(asker.name));

  const api = yield* KinGitHubApi;
  const account = yield* api.connected();
  if (account === null) return yield* refuse(ASK_REFUSAL.disconnected);
  const get = (path: string, headers?: Record<string, string>) =>
    api.call({ path, ...(headers === undefined ? {} : { headers }) });
  const watched = (yield* repoList(orgId)).filter((repo) => repo.watched);
  let repos = watched.map((repo) => repo.repo);
  if (input.repo !== undefined) {
    const repo = input.repo.trim();
    if (yield* isMemoryRepo(repo)) return yield* refuse(ASK_REFUSAL.memory(repo));
    const entry = watched.find((one) => one.repo.toLowerCase() === repo.toLowerCase());
    if (entry === undefined) return yield* refuse(ASK_REFUSAL.unwatched(repo));
    repos = [entry.repo];
  } else if (asker.login === null) return yield* refuse(ASK_REFUSAL.noLogin(asker.name));

  // One PR by repo and number; otherwise the open ones there, theirs unless Kin has no login.
  const candidates: Array<{ repo: string; number: number; title: string; head: string }> = [];
  if (input.repo !== undefined && input.number !== undefined)
    candidates.push({ repo: repos[0]!, number: input.number, title: "", head: "" });
  else
    for (const repo of repos) {
      const answer = yield* get(`repos/${repo}/pulls?state=open&per_page=100`);
      const open = answer.status === 200 ? decodeOpenPulls(answer.body) : Option.none();
      for (const pull of Option.getOrElse(open, () => []))
        if (
          (asker.login === null || pull.user?.login.toLowerCase() === asker.login.toLowerCase()) &&
          (input.number === undefined || pull.number === input.number)
        )
          candidates.push({ repo, number: pull.number, title: pull.title, head: pull.head.sha });
    }
  candidates.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  const app = yield* gitHubApp;
  const bot = yield* botLoginOf(app);
  const posts = yield* agentPostsOf(
    yield* Effect.serviceOption(ServerConfig),
    yield* Effect.serviceOption(FileSystem.FileSystem),
  );
  const handled = (key: string) =>
    sql<{ outcome: string }>`SELECT outcome FROM kin_github_handled
      WHERE org_id = ${orgId} AND trigger_key = ${key}`.pipe(Effect.map((rows) => rows[0]));
  const keyOf = (repo: string, number: number, head: string) =>
    `review:${repo.toLowerCase()}#${number}:${head}`;
  const pulls: Array<(typeof AskResult.Type)["pulls"][number]> = [];
  const left: Array<string> = [];
  let started = 0;
  for (const candidate of candidates) {
    const line = (outcome: string, title = candidate.title, head = candidate.head) =>
      pulls.push({
        repo: candidate.repo,
        number: candidate.number,
        title,
        head: short(head),
        outcome,
      });
    // A head already reviewed reads as that with no call to GitHub.
    const known =
      candidate.head === ""
        ? undefined
        : yield* handled(keyOf(candidate.repo, candidate.number, candidate.head));
    if (known !== undefined && known.outcome !== UNFINISHED) {
      line(PULL_REFUSAL.already(candidate.head));
      continue;
    }
    if (started >= ASKS_PER_CALL) {
      left.push(`${candidate.repo}#${candidate.number}`);
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
    const facts = (outcome: string) => line(outcome, thread.title, thread.pull?.headSha ?? "");
    if (!thread.open) {
      facts(PULL_REFUSAL.closed);
      continue;
    }
    if (thread.draft) {
      facts(PULL_REFUSAL.draft);
      continue;
    }
    // The watch's own decision for a review asked of the owner: none for Kin's own PRs.
    const trigger = decideTriggers(thread, {
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
    const outcome = yield* claimTrigger({
      orgId,
      thread,
      trigger,
      ownerLogin: account.login,
      agentId,
      now,
      woken: 0,
      happenedAt: now,
      // This turn has no shell: the server reads the diff for it.
      diff: yield* readDiff(get, thread.repo, thread.number),
      askedBy: asker.personId,
    });
    if (outcome === "woke") started += 1;
    facts(
      outcome === "woke"
        ? STARTED
        : outcome === "seen"
          ? PULL_REFUSAL.already(thread.pull.headSha)
          : PULL_REFUSAL.capped,
    );
  }
  return {
    pulls,
    ...(left.length === 0
      ? {}
      : {
          left: `${ASKS_PER_CALL} start per ask, so these wait: ${left.join(", ")}. Ask again for them.`,
        }),
    next:
      pulls.length === 0
        ? `${asker.name} has no open pull requests there. ${NOTHING}`
        : started > 0
          ? "Tell them each line as it reads. You haven't read a started one yet: its review goes on the PR, and Kin tells them here when it is done."
          : "Tell them each line as it reads.",
  };
});

/**
 * After a turn that reviewed for someone who asked: the agent's one line goes to their own chat
 * with it, as the owner got it; a turn that ended without one leaves Kin's line there instead, and
 * frees the key so asking again retries.
 */
export const reviewAskSettled = Effect.fn("KinGitHubReviewAsk.settled")(
  function* (row: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const chat = yield* KinChatService;
    const asked = yield* sql<{
      eventId: string;
      state: string;
      personId: string;
      key: string;
      number: number;
      repo: string;
    }>`SELECT e.event_id AS "eventId", e.state, json_extract(e.json, '$.askedBy') AS "personId",
        json_extract(e.json, '$.trigger.key') AS key,
        json_extract(e.json, '$.trigger.number') AS number, json_extract(e.json, '$.repo') AS repo
      FROM kin_events e
      WHERE e.org_id = ${row.orgId} AND e.agent_id = ${row.agentId} AND e.wakeup_id = ${row.wakeupId}
        AND e.tag = 'github' AND json_extract(e.json, '$.askedBy') IS NOT NULL
        AND e.state IN ('done', 'failed')
      ORDER BY e.event_id`;
    if (asked.length === 0) return;
    const [lead] = yield* sql<{ name: string; ownerChatId: string }>`SELECT name,
        owner_chat_id AS "ownerChatId" FROM kin_leads
      WHERE org_id = ${row.orgId} AND agent_id = ${row.agentId}`;
    if (lead === undefined) return;
    // Its last word in the owner's chat in this wake-up: the line the owner read.
    const [said] = yield* sql<{ body: string }>`SELECT m.body FROM kin_messages m
      JOIN kin_wakeups w ON w.org_id = m.org_id AND w.wakeup_id = ${row.wakeupId}
        AND w.thread_id = m.author_thread_id
      WHERE m.org_id = ${row.orgId} AND m.chat_id = ${lead.ownerChatId}
        AND m.author_kind = 'agent' AND m.author_agent_id = ${row.agentId}
        AND m.status = 'posted' AND m.kind = 'text' AND m.body <> ''
        AND m.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', w.started_at / 1000.0, 'unixepoch')
      ORDER BY m.seq DESC LIMIT 1`;
    for (const event of asked) {
      const personId = KinPersonId.make(event.personId);
      const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
        WHERE org_id = ${row.orgId} AND person_id = ${personId}`;
      const suffix = ` ${askedForLine(person?.name ?? "")}`;
      const line =
        event.state === "done" && said !== undefined
          ? said.body.endsWith(suffix)
            ? said.body.slice(0, -suffix.length)
            : said.body
          : undefined;
      if (line === undefined)
        yield* sql`UPDATE kin_github_handled SET outcome = ${UNFINISHED}
          WHERE org_id = ${row.orgId} AND trigger_key = ${event.key} AND outcome = 'woke'`;
      const [direct] = yield* sql<{ chatId: KinChatId }>`SELECT chat_id AS "chatId" FROM kin_chats
        WHERE org_id = ${row.orgId} AND kind = 'direct' AND archived_at IS NULL
          AND direct_key = ${LeadAccess.directKey(personId, row.agentId)}`;
      // The owner asking in his own chat already read the line there.
      if (
        direct === undefined ||
        direct.chatId === lead.ownerChatId ||
        !(yield* Reach.reaches(row.orgId, Reach.person(personId), Reach.agent(row.agentId)))
      )
        continue;
      const id = NodeCrypto.createHash("sha256").update(event.eventId).digest("hex").slice(0, 32);
      yield* chat.notice(
        line === undefined
          ? {
              orgId: row.orgId,
              chatId: direct.chatId,
              audience: "chat",
              messageId: KinMessageId.make(`kin-review-unfinished:${id}`),
              body: unfinishedLine(lead.name, `${event.repo}#${event.number}`),
            }
          : {
              orgId: row.orgId,
              chatId: direct.chatId,
              audience: "chat",
              messageId: KinMessageId.make(`kin-review-told:${id}`),
              from: row.agentId,
              body: line,
            },
      );
    }
  },
  Effect.catchCause((cause) =>
    Effect.logError("Kin couldn't tell an asked review's outcome", { cause }),
  ),
);
