import {
  KinChatError,
  KinEvent,
  KinEventId,
  KinOrgId,
  type KinGithubTrigger,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinGitHubLogin } from "../connections/GitHubLogin.ts";
import { KinServer } from "../KinServer.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { ENGINEERING_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { githubClosed } from "../work/githubEntries.ts";
import { agentPostLines, signed } from "./agentMark.ts";
import { AGENT_POSTS_FILE, GH_APP_FOLDER } from "./ghSign.ts";
import {
  decideTriggers,
  isAgentsOwn,
  type ThreadComment,
  type ThreadSnapshot,
  type Trigger,
} from "./githubTriggers.ts";
import { checkGuards } from "./branchGuard.ts";
import { companyRepo, knownRepos, type KnownRepo, repoList, watchRow } from "./githubWatchStore.ts";
import { gitHubApp } from "./KinGitHubApp.ts";

/**
 * Watches GitHub with the owner's own login: notifications and his own events, both conditional, so
 * an unchanged look costs no rate limit. Each trigger is stored once, in the same transaction as the
 * event that wakes an agent, so a restart or a re-read never handles it twice. What Kin posts itself
 * goes out as its GitHub App where the App is installed (`KinGitHubApp.ts`).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEFAULT_INTERVAL_MS = MINUTE;
const RETRY_MS = 5 * MINUTE;
const REPOS_EVERY_MS = 6 * HOUR;
/** Re-read a little before the last look, so a comment GitHub lists late is still seen. */
const OVERLAP_MS = 5 * MINUTE;
/** After downtime: older triggers are stored as stale, and one look wakes at most this many. */
const STALE_MS = 24 * HOUR;
/** How long an agent's sent text is known as its own; triggers older than a day are stale anyway. */
const POSTS_KEPT_MS = 7 * 24 * HOUR;
/**
 * Handled rows that only stop a re-weigh are kept 30 days: anything they held back is past
 * `STALE_MS` by then, so a look that meets it again stores it stale and wakes no one.
 */
const HANDLED_KEPT_MS = 30 * 24 * HOUR;
const PRUNE_EVERY_MS = 24 * HOUR;
export const WAKES_PER_LOOK = 10;
const THREADS_PER_LOOK = 30;
/** Replies an agent makes in one issue or PR in an hour before it stops and says so. */
export const PER_THREAD_HOURLY = 5;
const DIFF_CAP = 30_000;

export const capNote = (count: number) =>
  `I've replied ${count} times here in an hour, so I'm stopping for now; say /kin again to continue.`;

export interface ApiAnswer {
  /** 0 when gh couldn't reach GitHub or holds no login. */
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly text: string;
}

const parseJson = (text: string): { readonly ok: boolean; readonly value: unknown } => {
  try {
    return { ok: true, value: text.trim() === "" ? null : JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
};

/**
 * `gh api -i` output: status line, headers, a blank line, then the body. Its stdout and stderr
 * arrive together, and on an error gh writes `gh: <message> (HTTP <status>)` to stderr straight
 * after the body with no newline, so the body is the JSON before the first such line.
 */
export const parseGhApi = (out: string): ApiAnswer => {
  const start = out.search(/^HTTP\/\S+\s+\d{3}/m);
  const response = start > 0 ? out.slice(start) : out;
  const split = /\r?\n\r?\n/.exec(response);
  const head = split === null ? response : response.slice(0, split.index);
  const text = split === null ? "" : response.slice(split.index + split[0].length);
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(head);
  if (status === null) return { status: 0, headers: {}, body: null, text: out };
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  let body = parseJson(text);
  for (let at = text.indexOf("gh: "); !body.ok && at >= 0; at = text.indexOf("gh: ", at + 1))
    body = parseJson(text.slice(0, at));
  return { status: Number(status[1]), headers, body: body.value, text };
};

export interface ApiRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** GitHub's REST API as the connected owner. Tests give it `fakeGitHub.ts`. */
export class KinGitHubApi extends Context.Service<
  KinGitHubApi,
  {
    readonly connected: () => Effect.Effect<{
      readonly login: string;
      readonly orgs: ReadonlyArray<string>;
    } | null>;
    readonly call: (request: ApiRequest) => Effect.Effect<ApiAnswer>;
  }
>()("t3/kin/github/GitHubWatch/KinGitHubApi") {}

/** Through the owner's `gh` login, reached through Kin's services as the MCP tools reach it. */
export const ghApiLayer = Layer.effect(
  KinGitHubApi,
  Effect.gen(function* () {
    const direct = yield* Effect.serviceOption(KinGitHubLogin);
    const kin = yield* Effect.serviceOption(KinServer);
    const login = Option.orElse(direct, () =>
      Option.flatMap(kin, (server) =>
        Option.flatMap(server.services, (services) => Context.getOption(services, KinGitHubLogin)),
      ),
    );
    return KinGitHubApi.of({
      connected: Effect.fn("KinGitHubApi.connected")(function* () {
        if (Option.isNone(login) || !(yield* login.value.connected())) return null;
        const account = yield* login.value.account();
        return account === null ? null : { login: account.login, orgs: account.orgs };
      }),
      call: Effect.fn("KinGitHubApi.call")(function* (request) {
        if (Option.isNone(login)) return { status: 0, headers: {}, body: null, text: "" };
        const args = ["api", "-i", "--method", request.method ?? "GET"];
        for (const [name, value] of Object.entries(request.headers ?? {}))
          args.push("-H", `${name}: ${value}`);
        args.push(request.path);
        if (request.body !== undefined) args.push("--input", "-");
        const run = yield* login.value.gh(
          args,
          request.body === undefined ? undefined : toJson(request.body),
        );
        return parseGhApi(run.out);
      }),
    });
  }),
);

/** The plain words for a failed look, and how to fix it. */
const problemOf = (answer: ApiAnswer) => {
  if (answer.status === 401 || /bad credentials|HTTP 401/i.test(answer.text))
    return "GitHub signed Kin out. Reconnect GitHub in Settings → Connections.";
  if (answer.status === 403 || answer.status === 404)
    return "This GitHub login can't read notifications. Reconnect GitHub, or use a token with the repo and notifications scopes.";
  if (answer.status === 0)
    return "Kin couldn't reach GitHub just now. It tries again in a few minutes.";
  return `GitHub answered ${answer.status}. Kin tries again in a few minutes.`;
};

const Login = Schema.Struct({ login: Schema.String });
const Notification = Schema.Struct({
  reason: Schema.String,
  repository: Schema.Struct({ full_name: Schema.String }),
  subject: Schema.Struct({ type: Schema.String, url: Schema.NullOr(Schema.String) }),
});
const OwnEvent = Schema.Struct({
  type: Schema.String,
  repo: Schema.Struct({ name: Schema.String }),
  created_at: Schema.String,
  payload: Schema.Struct({
    issue: Schema.optional(Schema.Struct({ number: Schema.Int })),
    pull_request: Schema.optional(Schema.Struct({ number: Schema.Int })),
    number: Schema.optional(Schema.Int),
  }),
});
const RepoEntry = Schema.Struct({
  id: Schema.optional(Schema.Int),
  full_name: Schema.String,
  fork: Schema.Boolean,
  owner: Schema.Struct({
    login: Schema.String,
    id: Schema.optional(Schema.Int),
    type: Schema.optional(Schema.String),
  }),
  default_branch: Schema.optional(Schema.String),
  permissions: Schema.optional(
    Schema.Struct({ push: Schema.Boolean, admin: Schema.optional(Schema.Boolean) }),
  ),
});
const Issue = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(Login),
  author_association: Schema.String,
  state: Schema.String,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  created_at: Schema.String,
  html_url: Schema.String,
  pull_request: Schema.optional(Schema.Unknown),
});
const Pull = Schema.Struct({
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
  }),
  base: Schema.Struct({ ref: Schema.String }),
  additions: Schema.optional(Schema.Int),
  deletions: Schema.optional(Schema.Int),
  changed_files: Schema.optional(Schema.Int),
});
const Comment = Schema.Struct({
  id: Schema.Int,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(Login),
  author_association: Schema.String,
  created_at: Schema.String,
  path: Schema.optional(Schema.String),
  line: Schema.optional(Schema.NullOr(Schema.Int)),
});
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({ name: Schema.String, conclusion: Schema.NullOr(Schema.String) }),
  ),
});
const decodeNotifications = Schema.decodeUnknownOption(Schema.Array(Notification));
const decodeEvents = Schema.decodeUnknownOption(Schema.Array(OwnEvent));
const decodeRepos = Schema.decodeUnknownOption(Schema.Array(RepoEntry));
const decodeMemberships = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({ role: Schema.String, organization: Schema.Struct({ login: Schema.String }) }),
  ),
);
const decodeIssue = Schema.decodeUnknownOption(Issue);
const decodePull = Schema.decodeUnknownOption(Pull);
const decodeComments = Schema.decodeUnknownOption(Schema.Array(Comment));
const decodeChecks = Schema.decodeUnknownOption(CheckRuns);
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const parsed = (text: string) => {
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : 0;
};

const eventIdOf = (orgId: string, key: string) =>
  KinEventId.make(
    `github_${Array.from(new TextEncoder().encode(`${orgId.length}:${orgId}${key}`), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );

interface Thread {
  readonly repo: string;
  readonly number: number;
  reviewRequested: boolean;
}

export class KinGitHubWatch extends Context.Service<
  KinGitHubWatch,
  {
    /** One look at GitHub for the org, when it is due. */
    readonly poll: (orgId: KinOrgId, options?: { readonly force?: boolean }) => Effect.Effect<void>;
  }
>()("t3/kin/github/GitHubWatch/KinGitHubWatch") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* KinGitHubApi;
  const queue = yield* KinEventQueue.KinEventQueue;
  const records = yield* Effect.serviceOption(KinRecords);
  const refresh = yield* KinRefreshObserver;
  const app = yield* gitHubApp;
  const config = yield* Effect.serviceOption(ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  /** Orgs whose repos this server has read; the first look after a start reads them again. */
  const reposReadSinceStart = new Set<KinOrgId>();
  /**
   * What agents' shells sent this past week (`ghSign.ts`): their words, signed or not. The log
   * is read on from where the last look stopped; once its first line is past the week it moves
   * to `.1`, and the one before that, older than the week throughout, goes.
   */
  const postLog = {
    keys: new Map<string, number>(),
    offset: 0,
    firstAt: undefined as number | undefined,
    started: false,
  };
  const postsLock = yield* Semaphore.make(1);
  const agentPosts = Effect.gen(function* () {
    if (Option.isNone(config) || Option.isNone(fileSystem)) return undefined;
    const fs = fileSystem.value;
    const path = `${config.value.stateDir}/kin/${GH_APP_FOLDER}/${AGENT_POSTS_FILE}`;
    const keep = (text: string) => {
      for (const [at, key] of agentPostLines(text)) {
        postLog.firstAt ??= at * 1000;
        postLog.keys.set(key, Math.max(at * 1000, postLog.keys.get(key) ?? 0));
      }
    };
    // Whole lines from `offset` on; a line a shell is still writing waits for the next look.
    const readOn = (file: string, offset: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file, { flag: "r" });
          const size = Number((yield* handle.stat).size);
          const from = size < offset ? 0 : offset;
          if (size === from) return from;
          const bytes = Option.getOrElse(
            yield* handle.readAlloc(size - from, { position: BigInt(from) }),
            () => new Uint8Array(),
          );
          const end = bytes.lastIndexOf(10) + 1;
          keep(new TextDecoder().decode(bytes.subarray(0, end)));
          return from + end;
        }),
      ).pipe(Effect.orElseSucceed(() => offset));
    const now = yield* Clock.currentTimeMillis;
    if (!postLog.started) {
      postLog.started = true;
      yield* readOn(`${path}.1`, 0);
      postLog.firstAt = undefined;
    }
    postLog.offset = yield* readOn(path, postLog.offset);
    if (postLog.firstAt !== undefined && postLog.firstAt < now - POSTS_KEPT_MS) {
      const moved = yield* fs.rename(path, `${path}.1`).pipe(Effect.result);
      if (moved._tag === "Success") {
        // A line a shell added since the read above is in `.1` now.
        yield* readOn(`${path}.1`, postLog.offset);
        postLog.offset = 0;
        postLog.firstAt = undefined;
      }
    }
    for (const [key, at] of postLog.keys) if (at < now - POSTS_KEPT_MS) postLog.keys.delete(key);
    return new Set(postLog.keys.keys());
  }).pipe(postsLock.withPermits(1));
  const pruned = new Map<KinOrgId, number>();
  /** Drops handled rows that only stop a re-weigh, once a day; what stops a second wake stays. */
  const prune = Effect.fn("KinGitHubWatch.prune")(function* (orgId: KinOrgId, now: number) {
    if (now - (pruned.get(orgId) ?? -Infinity) < PRUNE_EVERY_MS) return;
    pruned.set(orgId, now);
    yield* sql`DELETE FROM kin_github_handled WHERE org_id = ${orgId} AND at < ${now - HANDLED_KEPT_MS}
      AND (trigger_key LIKE 'seen:%' OR outcome IN ('stale', 'note'))`;
  });
  const botLogin = Effect.gen(function* () {
    if (Option.isNone(app)) return undefined;
    const state = yield* app.value.state();
    return state._tag === "ok" ? state.app.botLogin : undefined;
  });
  /** Kin's own writes on a repo: as the App where it is installed, else as the owner. */
  const writer = Effect.fn("KinGitHubWatch.writer")(function* (repo: string) {
    const asApp = Option.isSome(app) ? yield* app.value.on(repo) : undefined;
    return asApp?.call ?? api.call;
  });

  const get = (path: string, headers?: Record<string, string>) =>
    api.call({ path, ...(headers === undefined ? {} : { headers }) });

  /** The repos his login can push to, owned by him or his organisations. */
  const refreshRepos = Effect.fn("KinGitHubWatch.refreshRepos")(function* (
    orgId: KinOrgId,
    account: { readonly login: string; readonly orgs: ReadonlyArray<string> },
    now: number,
  ) {
    const owners = new Set([account.login, ...account.orgs].map((name) => name.toLowerCase()));
    // Only an organisation's owners can put an App on it; unknown when GitHub won't say.
    const memberships = yield* get("user/memberships/orgs?state=active&per_page=100");
    const roles = memberships.status === 200 ? decodeMemberships(memberships.body) : Option.none();
    const ownsOrg = (login: string) =>
      Option.map(roles, (list) =>
        list.some(
          (entry) =>
            entry.role === "admin" &&
            entry.organization.login.toLowerCase() === login.toLowerCase(),
        ),
      ).pipe(Option.getOrUndefined);
    const found: Array<KnownRepo> = [];
    for (let page = 1; page <= 5; page++) {
      const answer = yield* get(
        `user/repos?per_page=100&page=${page}&affiliation=owner,organization_member&sort=pushed`,
      );
      const repos = answer.status === 200 ? decodeRepos(answer.body) : Option.none();
      if (Option.isNone(repos)) return answer;
      for (const repo of repos.value)
        if (repo.permissions?.push !== false && owners.has(repo.owner.login.toLowerCase()))
          found.push({
            repo: repo.full_name,
            fork: repo.fork,
            ...(repo.id === undefined ? {} : { id: repo.id }),
            ...(repo.owner.id === undefined ? {} : { ownerId: repo.owner.id }),
            ...(repo.default_branch === undefined ? {} : { branch: repo.default_branch }),
            ...(repo.permissions?.admin === undefined ? {} : { admin: repo.permissions.admin }),
            ...(repo.owner.type === "Organization"
              ? { ownerOrg: true, ownerAdmin: ownsOrg(repo.owner.login) }
              : repo.owner.type === "User"
                ? { ownerOrg: false }
                : {}),
          });
      if (repos.value.length < 100) break;
    }
    yield* sql`UPDATE kin_github_watch SET repos_json = ${toJson(found)},
      repos_at = ${now} WHERE org_id = ${orgId}`;
    return undefined;
  });

  /** Reads one issue or PR and what is new on it since `since`. */
  const snapshot = Effect.fn("KinGitHubWatch.snapshot")(function* (thread: Thread, since: number) {
    const base = `repos/${thread.repo}`;
    const issueAnswer = yield* get(`${base}/issues/${thread.number}`);
    const issue = issueAnswer.status === 200 ? decodeIssue(issueAnswer.body) : Option.none();
    if (Option.isNone(issue)) return undefined;
    const pull = issue.value.pull_request !== undefined;
    let pullFacts: Option.Option<typeof Pull.Type> = Option.none();
    if (pull) {
      const answer = yield* get(`${base}/pulls/${thread.number}`);
      pullFacts = answer.status === 200 ? decodePull(answer.body) : Option.none();
    }
    const comments: ThreadComment[] = [];
    for (const kind of pull ? (["issue", "review"] as const) : (["issue"] as const)) {
      const answer = yield* get(
        `${base}/${kind === "issue" ? "issues" : "pulls"}/${thread.number}/comments?per_page=100&since=${iso(since)}`,
      );
      const list = answer.status === 200 ? decodeComments(answer.body) : Option.none();
      for (const comment of Option.getOrElse(list, () => []))
        comments.push({
          id: comment.id,
          kind,
          body: comment.body ?? "",
          author: comment.user?.login ?? "ghost",
          association: comment.author_association,
          createdAt: parsed(comment.created_at),
          ...(comment.path === undefined ? {} : { path: comment.path }),
          ...(comment.line === undefined || comment.line === null ? {} : { line: comment.line }),
        });
    }
    const facts = Option.getOrUndefined(pullFacts);
    return {
      merged: facts?.merged === true,
      thread: {
        repo: thread.repo,
        number: thread.number,
        item: pull ? "pull" : "issue",
        url: issue.value.html_url,
        title: issue.value.title,
        body: issue.value.body ?? "",
        author: issue.value.user?.login ?? "ghost",
        association: issue.value.author_association,
        open: issue.value.state === "open",
        draft: facts?.draft === true,
        createdAt: parsed(issue.value.created_at),
        labels: issue.value.labels.map((label) => label.name),
        ...(facts === undefined
          ? {}
          : {
              pull: {
                files: facts.changed_files ?? 0,
                additions: facts.additions ?? 0,
                deletions: facts.deletions ?? 0,
                headRef: facts.head.ref,
                baseRef: facts.base.ref,
                headSha: facts.head.sha,
                fork:
                  (facts.head.repo?.full_name ?? "").toLowerCase() !== thread.repo.toLowerCase(),
              },
            }),
        comments,
        reviewRequested: thread.reviewRequested,
      } satisfies ThreadSnapshot,
    };
  });

  /** Failing check names on an agent's open PR, read only when GitHub says they changed. */
  const failingChecks = Effect.fn("KinGitHubWatch.failingChecks")(function* (
    orgId: KinOrgId,
    thread: ThreadSnapshot,
  ) {
    if (thread.pull === undefined) return undefined;
    const [row] = yield* sql<{ headSha: string; etag: string | null }>`SELECT head_sha AS "headSha",
      checks_etag AS etag FROM kin_github_agent_pulls
      WHERE org_id = ${orgId} AND repo = ${thread.repo.toLowerCase()} AND number = ${thread.number}`;
    const etag = row?.headSha === thread.pull.headSha ? row.etag : null;
    const answer = yield* get(
      `repos/${thread.repo}/commits/${thread.pull.headSha}/check-runs?per_page=100`,
      etag === null ? undefined : { "If-None-Match": etag },
    );
    yield* sql`INSERT INTO kin_github_agent_pulls (org_id, repo, number, head_sha, checks_etag, open)
      VALUES (${orgId}, ${thread.repo.toLowerCase()}, ${thread.number}, ${thread.pull.headSha},
        ${answer.headers.etag ?? etag}, ${thread.open ? 1 : 0})
      ON CONFLICT (org_id, repo, number) DO UPDATE SET head_sha = excluded.head_sha,
        checks_etag = excluded.checks_etag, open = excluded.open`;
    const runs = answer.status === 200 ? decodeChecks(answer.body) : Option.none();
    return Option.map(runs, (found) =>
      found.check_runs.filter((run) => FAILED.has(run.conclusion ?? "")).map((run) => run.name),
    ).pipe(Option.getOrUndefined);
  });

  const agentsOf = (orgId: KinOrgId) =>
    sql<{ agentId: string; name: string }>`SELECT l.agent_id AS "agentId", l.name FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId} ORDER BY l.agent_id`;

  const triggerFacts = (
    thread: ThreadSnapshot,
    trigger: Trigger,
    ownerLogin: string,
    diff: string | undefined,
  ): KinGithubTrigger => ({
    key: trigger.key,
    kind: trigger.kind,
    item: thread.item,
    number: thread.number,
    url: thread.url,
    title: thread.title,
    author: trigger.author,
    association: trigger.association,
    inside: trigger.inside,
    text: trigger.text,
    ...(trigger.path === undefined ? {} : { path: trigger.path }),
    ...(trigger.line === undefined ? {} : { line: trigger.line }),
    ...(thread.pull === undefined
      ? {}
      : {
          pull: {
            files: thread.pull.files,
            additions: thread.pull.additions,
            deletions: thread.pull.deletions,
            headRef: thread.pull.headRef,
            baseRef: thread.pull.baseRef,
            fork: thread.pull.fork,
            ownersOwn: thread.author.toLowerCase() === ownerLogin.toLowerCase(),
            ...(diff === undefined ? {} : { diff }),
          },
        }),
    ...(trigger.kind === "checks" ? { failing: trigger.text.split(", ") } : {}),
  });

  /** Stores the trigger once and, when it may, wakes its agent in the same transaction. */
  const handle = Effect.fn("KinGitHubWatch.handle")(function* (input: {
    readonly orgId: KinOrgId;
    readonly thread: ThreadSnapshot;
    readonly trigger: Trigger;
    readonly ownerLogin: string;
    readonly agentId: string;
    readonly now: number;
    readonly woken: number;
    readonly happenedAt: number;
    readonly diff: string | undefined;
  }) {
    const { orgId, thread, trigger, now } = input;
    const repo = thread.repo.toLowerCase();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [already] = yield* sql`SELECT 1 AS present FROM kin_github_handled
          WHERE org_id = ${orgId} AND trigger_key = ${trigger.key}`;
        if (already !== undefined) return "seen" as const;
        const [recent] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
          FROM kin_github_handled WHERE org_id = ${orgId} AND repo = ${repo}
            AND number = ${thread.number} AND outcome = 'woke' AND at > ${now - HOUR}`;
        // Past the look's cap, it waits for the next look, which reads from the same point.
        if (now - input.happenedAt <= STALE_MS && input.woken >= WAKES_PER_LOOK)
          return "later" as const;
        const outcome =
          now - input.happenedAt > STALE_MS
            ? "stale"
            : (recent?.count ?? 0) >= PER_THREAD_HOURLY
              ? "capped"
              : "woke";
        yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id,
            outcome, at)
          VALUES (${orgId}, ${trigger.key}, ${repo}, ${thread.number}, ${input.agentId},
            ${outcome}, ${now})`;
        if (outcome !== "woke") return outcome;
        const facts = triggerFacts(thread, trigger, input.ownerLogin, input.diff);
        yield* queue.enqueue(
          yield* decodeEvent({
            _tag: "github",
            orgId,
            agentId: input.agentId,
            eventId: eventIdOf(orgId, trigger.key),
            receivedAt: iso(now),
            dedupeKey: `poll:${trigger.key}`,
            deliveryId: `poll:${trigger.key}`,
            eventName: trigger.kind,
            repo: thread.repo,
            summary: `${trigger.kind} on ${thread.repo}#${thread.number} by ${trigger.author}`,
            // GitHub text is outside input unless its author can write to the repo.
            provenance: { _tag: "system" },
            trigger: facts,
          }),
        );
        return outcome;
      }),
    );
  });

  const react = (repo: string, number: number, trigger: Trigger) =>
    writer(repo).pipe(
      Effect.flatMap((call) =>
        call({
          method: "POST",
          path:
            trigger.reactTo.type === "issue"
              ? `repos/${repo}/issues/${number}/reactions`
              : `repos/${repo}/${trigger.reactTo.kind === "issue" ? "issues" : "pulls"}/comments/${trigger.reactTo.id}/reactions`,
          body: { content: "eyes" },
        }),
      ),
      Effect.asVoid,
    );

  /** One plain comment when a thread's hourly cap stops an agent; at most one an hour. */
  const capComment = Effect.fn("KinGitHubWatch.capComment")(function* (
    orgId: KinOrgId,
    thread: ThreadSnapshot,
    agentName: string,
    now: number,
  ) {
    const key = `capnote:${thread.repo.toLowerCase()}#${thread.number}:${Math.floor(now / HOUR)}`;
    const inserted = yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number,
        agent_id, outcome, at)
      VALUES (${orgId}, ${key}, ${thread.repo.toLowerCase()}, ${thread.number}, NULL, 'note', ${now})
      ON CONFLICT DO NOTHING RETURNING trigger_key`;
    if (inserted.length === 0) return;
    const call = yield* writer(thread.repo);
    yield* call({
      method: "POST",
      path: `repos/${thread.repo}/issues/${thread.number}/comments`,
      body: { body: signed(capNote(PER_THREAD_HOURLY), agentName) },
    });
  });

  const poll = Effect.fn("KinGitHubWatch.poll")(function* (
    orgId: KinOrgId,
    options?: { readonly force?: boolean },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const account = yield* api.connected();
    // Signed out: nothing is watched until the owner connects GitHub again.
    if (account === null)
      return yield* sql`UPDATE kin_github_watch SET checked_at = NULL
        WHERE org_id = ${orgId} AND checked_at IS NOT NULL`;
    let row = yield* watchRow(orgId);
    if (row === undefined || row.login?.toLowerCase() !== account.login.toLowerCase()) {
      // A new login starts watching from now: nothing from before is new work.
      yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at)
        VALUES (${orgId}, ${account.login}, ${now}, ${now}, 0)
        ON CONFLICT (org_id) DO UPDATE SET login = excluded.login, started_at = excluded.started_at,
          since_at = excluded.since_at, notifications_modified = NULL, events_etag = NULL,
          repos_at = NULL, next_at = 0`;
      row = yield* watchRow(orgId);
    }
    if (row === undefined || (options?.force !== true && now < row.nextAt)) return;
    // The Connections screen's watch line: told when it changes, not on every look.
    const fail = (answer: ApiAnswer) =>
      sql`UPDATE kin_github_watch SET problem = ${problemOf(answer)}, next_at = ${now + RETRY_MS}
        WHERE org_id = ${orgId}`.pipe(
        Effect.andThen(row?.problem === null ? refresh.touch(orgId, "connections") : Effect.void),
      );
    let reposChanged = false;
    // Repos stored before Kin kept each one's id and account are read again now.
    const known = yield* knownRepos(orgId);
    const factsMissing = known.some(
      (entry) => entry.id === undefined || entry.branch === undefined,
    );
    // An empty list is no answer yet, and a login signed in again (no look since) reads afresh.
    if (
      row.reposAt === null ||
      row.checkedAt === null ||
      known.length === 0 ||
      now - row.reposAt > REPOS_EVERY_MS ||
      factsMissing ||
      !reposReadSinceStart.has(orgId)
    ) {
      const before = row.reposJson;
      const failed = yield* refreshRepos(orgId, account, now);
      if (failed !== undefined) return yield* fail(failed);
      const guardsChanged = yield* checkGuards(api.call, orgId, now);
      reposReadSinceStart.add(orgId);
      reposChanged = guardsChanged || (yield* watchRow(orgId))?.reposJson !== before;
    }
    const repos = yield* repoList(orgId);
    const watched = new Map(
      repos.filter((repo) => repo.watched).map((repo) => [repo.repo.toLowerCase(), repo]),
    );
    const threads = new Map<string, Thread>();
    const note = (repo: string, number: number, reviewRequested = false) => {
      const entry = watched.get(repo.toLowerCase());
      if (entry === undefined) return;
      const key = `${entry.repo.toLowerCase()}#${number}`;
      const existing = threads.get(key);
      if (existing === undefined) threads.set(key, { repo: entry.repo, number, reviewRequested });
      else existing.reviewRequested ||= reviewRequested;
    };
    const since = row.sinceAt - OVERLAP_MS;

    const notifications = yield* get(
      `notifications?all=true&per_page=50&since=${iso(since)}`,
      row.notificationsModified === null
        ? undefined
        : { "If-Modified-Since": row.notificationsModified },
    );
    if (notifications.status !== 200 && notifications.status !== 304)
      return yield* fail(notifications);
    for (const thread of Option.getOrElse(
      notifications.status === 200 ? decodeNotifications(notifications.body) : Option.none(),
      () => [],
    )) {
      const number = /\/(?:issues|pulls)\/(\d+)$/.exec(thread.subject.url ?? "")?.[1];
      if (number !== undefined)
        note(thread.repository.full_name, Number(number), thread.reason === "review_requested");
    }

    // His own comments and labels never notify him, so his events carry what he does himself.
    const events = yield* get(
      `users/${account.login}/events?per_page=100`,
      row.eventsEtag === null ? undefined : { "If-None-Match": row.eventsEtag },
    );
    for (const event of Option.getOrElse(
      events.status === 200 ? decodeEvents(events.body) : Option.none(),
      () => [],
    )) {
      if (parsed(event.created_at) < since) continue;
      const number =
        event.payload.issue?.number ?? event.payload.pull_request?.number ?? event.payload.number;
      if (number !== undefined) note(event.repo.name, number);
    }

    // An agent's open PRs, for checks that fail with nothing else changing on the PR.
    for (const pull of yield* sql<{ repo: string; number: number }>`SELECT repo, number
      FROM kin_github_agent_pulls WHERE org_id = ${orgId} AND open = 1 ORDER BY repo, number LIMIT 20`)
      note(pull.repo, pull.number);

    const agents = yield* agentsOf(orgId);
    const bot = yield* botLogin;
    yield* prune(orgId, now);
    const posts = yield* agentPosts;
    const lead = yield* liveLead(sql, orgId, { prefer: ENGINEERING_DOMAIN });
    let woken = 0;
    let later = false;
    const held = new Set<number>();
    for (const thread of [...threads.values()].slice(0, THREADS_PER_LOOK)) {
      const read = yield* snapshot(thread, since);
      if (read === undefined) continue;
      let current: ThreadSnapshot = read.thread;
      const at = `${current.repo.toLowerCase()}#${current.number}`;
      if (current.item === "pull" && read.merged && Option.isSome(records))
        yield* githubClosed({
          orgId,
          repo: current.repo,
          number: current.number,
          item: "pull_request",
        }).pipe(
          Effect.provideService(KinRecords, records.value),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin couldn't close Work entries for a merge", { cause }),
          ),
        );
      if (current.item === "pull" && isAgentsOwn(current.body, current.author, bot, posts)) {
        const failing = current.open ? yield* failingChecks(orgId, current) : undefined;
        if (!current.open)
          yield* sql`UPDATE kin_github_agent_pulls SET open = 0
            WHERE org_id = ${orgId} AND repo = ${current.repo.toLowerCase()} AND number = ${current.number}`;
        current = { ...current, failing };
      }
      if (lead === undefined) continue;
      const [draft] = yield* sql`SELECT 1 AS present FROM kin_github_handled
        WHERE org_id = ${orgId} AND trigger_key = ${`draft:${at}`}`;
      if (current.item === "pull" && current.draft && draft === undefined)
        yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id, outcome, at)
          VALUES (${orgId}, ${`draft:${at}`}, ${current.repo.toLowerCase()}, ${current.number}, NULL, 'seen', ${now})
          ON CONFLICT DO NOTHING`;
      // A comment is weighed once: a later look, or a switch turned on since, never re-reads it.
      const seenKey = (comment: ThreadComment) =>
        `seen:${at}:${comment.kind === "review" ? "r" : "c"}${comment.id}`;
      const seen =
        current.comments.length === 0
          ? new Set<string>()
          : new Set(
              (yield* sql<{ key: string }>`SELECT trigger_key AS key FROM kin_github_handled
                WHERE org_id = ${orgId} AND trigger_key IN ${sql.in(current.comments.map(seenKey))}`).map(
                (found) => found.key,
              ),
            );
      const fresh = current.comments.filter((comment) => !seen.has(seenKey(comment)));
      current = { ...current, comments: fresh };
      const triggers = decideTriggers(current, {
        ownerLogin: account.login,
        agents,
        defaultAgentId: lead.agentId,
        mentions: watched.get(current.repo.toLowerCase())?.mentions ?? false,
        since: row.startedAt,
        draftSeen: draft !== undefined,
        botLogin: bot,
        agentPosts: posts,
      });
      for (const trigger of triggers) {
        const agentId = agents.some((agent) => agent.agentId === trigger.agentId)
          ? trigger.agentId
          : lead.agentId;
        const happenedAt =
          trigger.reactTo.type === "comment"
            ? (current.comments.find(
                (comment) => comment.id === (trigger.reactTo as { id: number }).id,
              )?.createdAt ?? now)
            : trigger.kind === "review"
              ? current.createdAt
              : now;
        // A stranger's PR is read for them: their turn gets no shell to fetch it.
        const diff =
          !trigger.inside && current.item === "pull"
            ? yield* get(`repos/${current.repo}/pulls/${current.number}`, {
                Accept: "application/vnd.github.diff",
              }).pipe(
                Effect.map((answer) =>
                  answer.status === 200
                    ? answer.text.length <= DIFF_CAP
                      ? answer.text
                      : `${answer.text.slice(0, DIFF_CAP)}\n…[diff cut at ${DIFF_CAP} characters]`
                    : undefined,
                ),
              )
            : undefined;
        const outcome = yield* handle({
          orgId,
          thread: current,
          trigger,
          ownerLogin: account.login,
          agentId,
          now,
          woken,
          happenedAt,
          diff,
        });
        if (outcome === "later") {
          later = true;
          if (trigger.reactTo.type === "comment") held.add(trigger.reactTo.id);
        }
        if (outcome === "woke") {
          woken += 1;
          yield* react(current.repo, current.number, trigger);
        }
        if (outcome === "capped")
          yield* capComment(
            orgId,
            current,
            agents.find((agent) => agent.agentId === agentId)?.name ?? lead.name,
            now,
          );
      }
      for (const comment of fresh.filter((comment) => !held.has(comment.id)))
        yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id, outcome, at)
          VALUES (${orgId}, ${seenKey(comment)}, ${current.repo.toLowerCase()}, ${current.number}, NULL, 'seen', ${now})
          ON CONFLICT DO NOTHING`;
    }
    const asked = Number(notifications.headers["x-poll-interval"]);
    const interval = asked > 0 ? asked * 1000 : DEFAULT_INTERVAL_MS;
    // With work left over, the cursors stay put: the next look reads the same and handles the rest.
    yield* later
      ? sql`UPDATE kin_github_watch SET problem = NULL, checked_at = ${now}, next_at = ${now + interval}
          WHERE org_id = ${orgId}`
      : sql`UPDATE kin_github_watch SET problem = NULL, checked_at = ${now}, since_at = ${now},
          next_at = ${now + interval},
          notifications_modified = ${notifications.headers["last-modified"] ?? row.notificationsModified},
          events_etag = ${events.status === 200 || events.status === 304 ? (events.headers.etag ?? row.eventsEtag) : row.eventsEtag}
        WHERE org_id = ${orgId}`;
    if (row.checkedAt === null || row.problem !== null || reposChanged)
      yield* refresh.touch(orgId, "connections");
  });

  return KinGitHubWatch.of({
    poll: Effect.fn("KinGitHubWatch.look")(
      (orgId: KinOrgId, options?: { readonly force?: boolean }) => poll(orgId, options),
      Effect.asVoid,
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) => Effect.logWarning("Kin's GitHub look failed", { cause })),
    ),
  });
});

/**
 * Posts a review on one of the company's repos, signed by the agent: as Kin's GitHub App where it
 * is installed and can, else as the owner. Other people's repos are asked first.
 */
const ownerReview = Effect.fn("KinGitHubWatch.review")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly agentName: string;
    readonly repo: string;
    readonly number: number;
    readonly body: string;
    readonly event: "COMMENT" | "REQUEST_CHANGES";
    readonly comments: ReadonlyArray<{
      readonly path: string;
      readonly line: number;
      readonly body: string;
    }>;
  }) {
    const api = yield* KinGitHubApi;
    const get = (path: string) => api.call({ path });
    const ours = yield* companyRepo(input.orgId, input.repo);
    if (ours === undefined)
      return yield* new KinChatError({
        reason: "not_allowed",
        message:
          "That repo isn't the company's. Ask the owner in chat before posting there, then post with gh in a turn he started.",
      });
    const pullAnswer = yield* get(`repos/${ours.repo}/issues/${input.number}`);
    const issue = pullAnswer.status === 200 ? decodeIssue(pullAnswer.body) : Option.none();
    const account = yield* api.connected();
    const app = yield* gitHubApp;
    const asApp = Option.isSome(app) ? yield* app.value.on(ours.repo) : undefined;
    // GitHub refuses changes requested on one's own PR: a PR by whoever posts gets a comment.
    const eventAs = (login: string | undefined) =>
      Option.isSome(issue) &&
      login !== undefined &&
      issue.value.user?.login.toLowerCase() === login.toLowerCase()
        ? "COMMENT"
        : input.event;
    const body = signed(input.body, input.agentName);
    const post = (
      call: KinGitHubApi["Service"]["call"],
      event: "COMMENT" | "REQUEST_CHANGES",
      comments: typeof input.comments,
    ) =>
      call({
        method: "POST",
        path: `repos/${ours.repo}/pulls/${input.number}/reviews`,
        body: {
          body,
          event,
          // Inline comments carry the marker too, so the watch knows them under either login.
          comments: comments.map((comment) => ({
            ...comment,
            body: signed(comment.body, input.agentName),
            side: "RIGHT",
          })),
        },
      });
    const postAll = Effect.fn("KinGitHubWatch.postReview")(function* (
      call: KinGitHubApi["Service"]["call"],
      login: string | undefined,
    ) {
      const event = eventAs(login);
      const answer = yield* post(call, event, input.comments);
      if (answer.status !== 422 || input.comments.length === 0) return answer;
      return yield* call({
        method: "POST",
        path: `repos/${ours.repo}/pulls/${input.number}/reviews`,
        body: {
          body: signed(
            [input.body, ...input.comments.map((c) => `**${c.path}:${c.line}**\n${c.body}`)].join(
              "\n\n",
            ),
            input.agentName,
          ),
          event,
        },
      });
    });
    let answer =
      asApp === undefined
        ? yield* postAll(api.call, account?.login)
        : yield* postAll(asApp.call, asApp.login);
    // Where the App can't write, the owner's login posts it, and the agent says so.
    const fellBack = asApp !== undefined && (answer.status === 403 || answer.status === 404);
    if (fellBack) answer = yield* postAll(api.call, account?.login);
    const url =
      typeof answer.body === "object" && answer.body !== null
        ? Reflect.get(answer.body, "html_url")
        : undefined;
    if (answer.status >= 300 || typeof url !== "string")
      return yield* new KinChatError({
        reason: "unavailable",
        message: `GitHub didn't post the review (${problemOf(answer)})`,
      });
    return { url, asOwner: fellBack };
  },
  Effect.catchTags({
    SqlError: () =>
      Effect.fail(
        new KinChatError({ reason: "unavailable", message: "Kin couldn't read its repo list." }),
      ),
  }),
);

/** Every five seconds the scheduler asks; each org is looked at only when its next look is due. */
const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const watch = yield* KinGitHubWatch;
    const sql = yield* SqlClient.SqlClient;
    const ticks = yield* Scheduler.Scheduler;
    yield* ticks.register(
      "kin-github-watch",
      sql<{ orgId: string }>`SELECT DISTINCT org_id AS "orgId" FROM kin_leads ORDER BY org_id`.pipe(
        Effect.flatMap((orgs) =>
          Effect.forEach(orgs, (org) => watch.poll(KinOrgId.make(org.orgId)), { discard: true }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin's GitHub watch scan failed", { cause }),
        ),
      ),
    );
  }),
);

export const layer = Layer.effect(KinGitHubWatch, make);
export const liveLayer = runtimeLayer.pipe(Layer.provideMerge(layer), Layer.provide(ghApiLayer));

/**
 * `kin_github_review` with the owner's GitHub connected: posted at once on the company's repos and
 * then told, never a card. Undefined while GitHub isn't connected.
 */
export const ownerGitHubReview = Effect.fn("KinGitHubWatch.ownerGitHubReview")(function* (
  lead: { readonly orgId: KinOrgId; readonly agentId: string },
  input: {
    readonly repo: string;
    readonly number: number;
    readonly body?: string | undefined;
    readonly event?: "COMMENT" | "REQUEST_CHANGES" | undefined;
    readonly comments?:
      | ReadonlyArray<{ readonly path: string; readonly line: number; readonly body: string }>
      | undefined;
  },
) {
  const api = yield* KinGitHubApi;
  if ((yield* api.connected()) === null) return undefined;
  if (input.body === undefined)
    return yield* new KinChatError({ reason: "invalid_state", message: "A review needs a body." });
  const sql = yield* SqlClient.SqlClient;
  const [named] = yield* sql<{ name: string }>`SELECT name FROM kin_leads
    WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId}`.pipe(
    Effect.orElseSucceed(() => []),
  );
  const posted = yield* ownerReview({
    orgId: lead.orgId,
    agentName: named?.name ?? "Agent",
    repo: input.repo,
    number: input.number,
    body: input.body,
    event: input.event ?? "COMMENT",
    comments: input.comments ?? [],
  });
  return {
    status: "posted" as const,
    url: posted.url,
    next: posted.asOwner
      ? "Posted on the PR as the owner: Kin's GitHub App can't write there. Tell the owner in one line with the link, and that it went out as him."
      : "Posted on the PR. Tell the owner in one line with the link.",
  };
});
