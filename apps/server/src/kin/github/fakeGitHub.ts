// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain code outside Effect: node runs it from a copy for `gh`.
/**
 * An invented, deterministic GitHub for tests. `fakeGh.sh` runs this file for `gh api` and the
 * posting commands, keeping the world in `$KIN_FAKE_GH/github.json`. No dependencies, so node
 * runs it from a copy beside the fake `gh`.
 */

import * as NodeCrypto from "node:crypto";

export interface FakeRepo {
  full_name: string;
  private: boolean;
  fork: boolean;
  push: boolean;
  /** Admin on the repo, which GitHub wants before it adds or removes it on an installation. */
  admin?: boolean;
  /** Default: main. */
  default_branch?: string;
  /** A private repo on GitHub Free: no rulesets or branch protection, read or written. */
  planLimited?: boolean;
  rulesets?: FakeRuleset[];
  /** No commits yet, so no branches: GitHub reads its default branch's protection as "Branch not found". */
  empty?: boolean;
  /** Classic branch protection on the default branch, as GitHub returns it. */
  classic?: Record<string, unknown>;
}
export interface FakeRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  include: string[];
  exclude: string[];
  rules: { type: string; parameters?: Record<string, unknown> }[];
  bypass: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  /** GitHub shows `bypass_actors` only to a login that may edit the ruleset, as an org's owners. */
  bypassHidden?: boolean;
}

const PLAN_LIMIT = "Upgrade to GitHub Pro or make this repository public to enable this feature.";
const RULE_TYPES = new Set([
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "required_signatures",
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
]);
const ACTOR_TYPES = new Set([
  "Integration",
  "OrganizationAdmin",
  "RepositoryRole",
  "Team",
  "DeployKey",
  "User",
]);
// GitHub's built-in repository roles as rulesets name them: maintain 2, write 4, admin 5.
const REPOSITORY_ROLES = new Set([2, 4, 5]);
export interface FakeItem {
  repo: string;
  number: number;
  pull: boolean;
  title: string;
  body: string;
  user: string;
  association: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  created_at: number;
  labels: string[];
  head_ref: string;
  head_sha: string;
  fork: boolean;
  additions: number;
  deletions: number;
  changed_files: number;
  diff: string;
}
export interface FakeComment {
  id: number;
  repo: string;
  number: number;
  kind: "issue" | "review";
  body: string;
  user: string;
  association: string;
  created_at: number;
  path?: string;
  line?: number;
}
/** Kin's GitHub App as GitHub holds it: where it is installed, and the tokens it minted. */
export interface FakeApp {
  id: number;
  slug: string;
  name: string;
  botId: number;
  /** The account that owns the App; a private App installs only there. Default: the user, public. */
  owner?: string;
  public?: boolean;
  installations: {
    id: number;
    account: string;
    /** `selected` (the default) covers `repos`; `all` covers every repo of the account. */
    selection?: "all" | "selected";
    suspended?: boolean;
    repos: string[];
    permissions: Record<string, string>;
  }[];
  minted: {
    token: string;
    installation: number;
    expiresAt: number;
    permissions: Record<string, string>;
  }[];
}
/** A GitHub account; the user's own is a User, any other an Organization unless listed. */
export interface FakeAccount {
  login: string;
  id: number;
  type: "User" | "Organization";
  /** The user's role in an organisation: only `admin` (owner) may install Apps on it. */
  role?: "admin" | "member";
}
export interface FakeWorld {
  user: string;
  accounts?: FakeAccount[];
  /** One-time codes GitHub's manifest flow hands the browser, and the App each makes. */
  manifestCodes?: Record<string, { name: string; slug: string; public?: boolean }>;
  /** GitHub refuses the user's login on an installation's repos, as for a token it won't take there. */
  installationEditsRefused?: boolean;
  /** Kin's GitHub App, when the test sets one up. */
  app?: FakeApp | null;
  now: number;
  seq: number;
  /** A failure every call answers with, such as 401, to show a signed-out login. */
  down: number | null;
  /** Paths GitHub refuses this login with 403, as for a token without that permission. */
  refused?: string[];
  /** The seconds GitHub asks between looks; real GitHub says 60. */
  pollInterval?: number;
  repos: FakeRepo[];
  items: FakeItem[];
  comments: FakeComment[];
  reviews: {
    id: number;
    repo: string;
    number: number;
    user: string;
    event: string;
    body: string;
  }[];
  reactions: { on: string; content: string; by?: string }[];
  checks: Record<string, string[]>;
  /** Finished GitHub Actions runs, newest last. */
  runs?: {
    id: number;
    repo: string;
    workflow_id: number;
    name: string;
    branch: string;
    conclusion: string;
    created_at: number;
  }[];
  notifications: { id: string; repo: string; number: number; reason: string; updated_at: number }[];
  events: { id: string; type: string; repo: string; number: number; created_at: number }[];
  modified: number;
  eventsVersion: number;
  calls: string[];
}

export interface FakeAnswer {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export const emptyWorld = (user = "invented-owner", now = 0): FakeWorld => ({
  user,
  now,
  seq: 100,
  down: null,
  repos: [],
  items: [],
  comments: [],
  reviews: [],
  reactions: [],
  checks: {},
  notifications: [],
  events: [],
  modified: now,
  eventsVersion: 0,
  calls: [],
});

const iso = (ms: number) => new Date(ms).toISOString();
const httpDate = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toUTCString();

export class FakeGitHub {
  readonly world: FakeWorld;
  constructor(world: FakeWorld) {
    this.world = world;
  }

  private next() {
    this.world.seq += 1;
    return this.world.seq;
  }
  private item(repo: string, number: number) {
    const found = this.world.items.find(
      (item) => item.repo.toLowerCase() === repo.toLowerCase() && item.number === number,
    );
    if (found === undefined) throw new Error(`no ${repo}#${number}`);
    return found;
  }
  /** What the owner's account does shows in his events; anyone else's in his notifications. */
  private happened(
    repo: string,
    number: number,
    actor: string,
    type: string,
    reason = "subscribed",
  ) {
    const at = this.world.now;
    if (actor.toLowerCase() === this.world.user.toLowerCase()) {
      this.world.events.unshift({ id: String(this.next()), type, repo, number, created_at: at });
      this.world.eventsVersion += 1;
      return;
    }
    const id = `${repo.toLowerCase()}#${number}`;
    const existing = this.world.notifications.find((thread) => thread.id === id);
    if (existing === undefined)
      this.world.notifications.push({ id, repo, number, reason, updated_at: at });
    else {
      existing.updated_at = at;
      if (reason === "review_requested") existing.reason = reason;
    }
    this.world.modified = Math.max(this.world.modified + 1000, at);
  }

  private interval() {
    return String(this.world.pollInterval ?? 60);
  }

  tick(ms: number) {
    this.world.now += ms;
  }
  addRepo(repo: Partial<FakeRepo> & { full_name: string }) {
    this.world.repos.push({ private: true, fork: false, push: true, ...repo });
  }
  openItem(input: {
    repo: string;
    pull: boolean;
    author: string;
    association: string;
    title: string;
    body?: string;
    draft?: boolean;
    labels?: string[];
    fork?: boolean;
    headRef?: string;
    diff?: string;
  }) {
    const number = this.world.items.filter((item) => item.repo === input.repo).length + 1;
    const item: FakeItem = {
      repo: input.repo,
      number,
      pull: input.pull,
      title: input.title,
      body: input.body ?? "",
      user: input.author,
      association: input.association,
      state: "open",
      draft: input.draft ?? false,
      merged: false,
      created_at: this.world.now,
      labels: input.labels ?? [],
      head_ref: input.headRef ?? `change-${number}`,
      head_sha: `sha${this.next()}`,
      fork: input.fork ?? false,
      additions: 12,
      deletions: 3,
      changed_files: 2,
      diff: input.diff ?? "diff --git a/README.md b/README.md\n+an invented line\n",
    };
    this.world.items.push(item);
    this.happened(
      input.repo,
      number,
      input.author,
      input.pull ? "PullRequestEvent" : "IssuesEvent",
    );
    return number;
  }
  comment(input: {
    repo: string;
    number: number;
    author: string;
    association: string;
    body: string;
    path?: string;
    line?: number;
  }) {
    this.item(input.repo, input.number);
    const id = this.next();
    this.world.comments.push({
      id,
      repo: input.repo,
      number: input.number,
      kind: input.path === undefined ? "issue" : "review",
      body: input.body,
      user: input.author,
      association: input.association,
      created_at: this.world.now,
      ...(input.path === undefined ? {} : { path: input.path, line: input.line ?? 1 }),
    });
    this.happened(
      input.repo,
      input.number,
      input.author,
      input.path === undefined ? "IssueCommentEvent" : "PullRequestReviewCommentEvent",
    );
    return id;
  }
  label(input: { repo: string; number: number; label: string; actor: string }) {
    this.item(input.repo, input.number).labels.push(input.label);
    this.happened(input.repo, input.number, input.actor, "IssuesEvent");
  }
  ready(input: { repo: string; number: number; actor: string }) {
    this.item(input.repo, input.number).draft = false;
    this.happened(input.repo, input.number, input.actor, "PullRequestEvent");
  }
  requestReview(input: { repo: string; number: number; actor: string }) {
    this.happened(input.repo, input.number, input.actor, "PullRequestEvent", "review_requested");
  }
  setChecks(input: { repo: string; number: number; failing: string[] }) {
    const item = this.item(input.repo, input.number);
    this.world.checks[`${item.repo.toLowerCase()}@${item.head_sha}`] = input.failing;
  }
  merge(input: { repo: string; number: number; actor: string }) {
    const item = this.item(input.repo, input.number);
    item.state = "closed";
    item.merged = true;
    this.happened(input.repo, input.number, input.actor, "PullRequestEvent");
  }
  close(input: { repo: string; number: number; actor: string }) {
    this.item(input.repo, input.number).state = "closed";
    this.happened(input.repo, input.number, input.actor, "IssuesEvent");
  }
  /** One finished run of a workflow, on `branch` (default main). */
  run(input: {
    repo: string;
    workflow: number;
    name: string;
    conclusion: string;
    branch?: string;
  }) {
    const id = this.next();
    (this.world.runs ??= []).push({
      id,
      repo: input.repo,
      workflow_id: input.workflow,
      name: input.name,
      branch: input.branch ?? "main",
      conclusion: input.conclusion,
      created_at: this.world.now,
    });
    return id;
  }
  push(input: { repo: string; number: number }) {
    this.item(input.repo, input.number).head_sha = `sha${this.next()}`;
  }

  private issueJson(item: FakeItem) {
    return {
      number: item.number,
      title: item.title,
      body: item.body,
      user: { login: item.user },
      author_association: item.association,
      state: item.state,
      labels: item.labels.map((name) => ({ name })),
      created_at: iso(item.created_at),
      html_url: `https://github.com/${item.repo}/${item.pull ? "pull" : "issues"}/${item.number}`,
      ...(item.pull ? { pull_request: { url: "" } } : {}),
    };
  }
  private commentJson(comment: FakeComment) {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.user },
      author_association: comment.association,
      created_at: iso(comment.created_at),
      ...(comment.path === undefined ? {} : { path: comment.path, line: comment.line }),
    };
  }

  private ownerJson(app: FakeApp) {
    const owner = this.account(app.owner ?? this.world.user);
    return { login: owner.login, id: owner.id, type: owner.type };
  }
  /** The account by login, as GitHub would describe it; unknown ones get a stable invented id. */
  account(login: string): FakeAccount {
    const listed = this.world.accounts?.find(
      (entry) => entry.login.toLowerCase() === login.toLowerCase(),
    );
    if (listed !== undefined) return listed;
    const user = login.toLowerCase() === this.world.user.toLowerCase();
    let id = 5000;
    for (const char of login.toLowerCase()) id = (id * 31 + char.charCodeAt(0)) % 900_000;
    return { login, id: 100_000 + id, type: user ? "User" : "Organization", role: "admin" };
  }
  private repoId(fullName: string) {
    const index = this.world.repos.findIndex(
      (repo) => repo.full_name.toLowerCase() === fullName.toLowerCase(),
    );
    return index < 0 ? undefined : 2000 + index;
  }
  /** The repos an installation reaches: all of the account's under `all`, else those picked. */
  installedRepos(installation: FakeApp["installations"][number]) {
    if (installation.selection !== "all") return installation.repos;
    const prefix = `${installation.account.toLowerCase()}/`;
    return this.world.repos
      .map((repo) => repo.full_name)
      .filter((name) => name.toLowerCase().startsWith(prefix));
  }
  /** The rules in force on a branch: active rulesets whose names match it. */
  private rulesOn(repo: FakeRepo, branch: string) {
    const matches = (pattern: string) =>
      pattern === "~ALL" ||
      (pattern === "~DEFAULT_BRANCH" && branch === (repo.default_branch ?? "main")) ||
      pattern === `refs/heads/${branch}`;
    return (repo.rulesets ?? []).filter(
      (set) =>
        set.enforcement === "active" && set.include.some(matches) && !set.exclude.some(matches),
    );
  }
  /** Rulesets, classic protection and merges, as GitHub answers them; undefined for anything else. */
  private rulesAnswer(
    method: string,
    name: string,
    rest: string,
    body: Record<string, unknown>,
    actor: string,
    asInstallation: boolean,
  ): FakeAnswer | undefined {
    const repo = this.world.repos.find(
      (entry) => entry.full_name.toLowerCase() === name.toLowerCase(),
    );
    const answer = (status: number, value: unknown): FakeAnswer => ({
      status,
      headers: {},
      body: value,
    });
    const refused = (message: string) => answer(403, { message });
    const invalid = (error: string) =>
      answer(422, { message: "Validation Failed", errors: [error] });
    const rulesRead = /^rules\/branches\/(.+)$/.exec(rest);
    const rulesets = rest === "rulesets" || /^rulesets\/\d+$/.test(rest);
    const classic = /^branches\/(.+)\/protection$/.exec(rest);
    const merge = /^pulls\/(\d+)\/merge$/.exec(rest);
    if (rulesRead === null && !rulesets && classic === null && merge === null) return undefined;
    if (repo === undefined) return answer(404, { message: "Not Found" });
    if (merge !== null && method === "PUT") {
      const item = this.world.items.find(
        (entry) =>
          entry.repo.toLowerCase() === name.toLowerCase() && entry.number === Number(merge[1]),
      );
      if (item === undefined || !item.pull) return answer(404, { message: "Not Found" });
      const owner = this.account(name.split("/")[0]!);
      const appId = this.world.app?.id;
      const bypasses = (set: FakeRuleset) =>
        set.bypass.some((entry) =>
          asInstallation
            ? entry.actor_type === "Integration" && entry.actor_id === appId
            : (entry.actor_type === "RepositoryRole" &&
                entry.actor_id === 5 &&
                repo.admin !== false) ||
              (entry.actor_type === "OrganizationAdmin" &&
                owner.type === "Organization" &&
                owner.role !== "member"),
        );
      const inForce = this.rulesOn(repo, repo.default_branch ?? "main").filter(
        (set) => !bypasses(set),
      );
      if (inForce.some((set) => set.rules.some((rule) => rule.type === "update")))
        return answer(405, {
          message: "Repository rule violations found\n\nCannot update this protected ref.\n\n",
        });
      const approvals = new Set(
        this.world.reviews
          .filter(
            (review) =>
              review.repo.toLowerCase() === name.toLowerCase() &&
              review.number === item.number &&
              review.event === "APPROVE" &&
              review.user !== item.user,
          )
          .map((review) => review.user),
      ).size;
      const required = Math.max(
        0,
        ...inForce.flatMap((set) =>
          set.rules.map((rule) =>
            rule.type === "pull_request"
              ? Number(rule.parameters?.required_approving_review_count ?? 0)
              : 0,
          ),
        ),
      );
      if (approvals < required)
        return answer(405, {
          message: `Repository rule violations found\n\nAt least ${required} approving review is required by reviewers with write access.\n\n`,
        });
      this.merge({ repo: item.repo, number: item.number, actor });
      return answer(200, { merged: true, message: "Pull Request successfully merged" });
    }
    if (repo.planLimited === true) return refused(PLAN_LIMIT);
    if (rulesRead !== null && method === "GET") {
      const branch = decodeURIComponent(rulesRead[1]!);
      return answer(
        200,
        this.rulesOn(repo, branch).flatMap((set) =>
          set.rules.map((rule) => ({
            type: rule.type,
            ruleset_source_type: "Repository",
            ruleset_source: repo.full_name,
            ruleset_id: set.id,
            ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
          })),
        ),
      );
    }
    const shown = /^rulesets\/(\d+)$/.exec(rest);
    const set =
      shown === null ? undefined : repo.rulesets?.find((entry) => entry.id === Number(shown[1]));
    if (shown !== null && method === "GET") {
      if (set === undefined) return answer(404, { message: "Not Found" });
      const editor = !asInstallation && repo.admin !== false && set.bypassHidden !== true;
      return answer(200, {
        id: set.id,
        name: set.name,
        target: set.target,
        source_type: "Repository",
        source: repo.full_name,
        enforcement: set.enforcement,
        conditions: { ref_name: { exclude: set.exclude, include: set.include } },
        rules: set.rules,
        ...(editor ? { bypass_actors: set.bypass } : {}),
      });
    }
    // Writing rules, and reading classic protection, take admin; the App holds no such permission.
    if (asInstallation) return refused("Resource not accessible by integration");
    if (repo.admin === false) return refused("Must have admin rights to Repository.");
    if (classic !== null && method === "GET") {
      if (repo.empty === true) return answer(404, { message: "Branch not found" });
      if (decodeURIComponent(classic[1]!) !== (repo.default_branch ?? "main") || !repo.classic)
        return answer(404, { message: "Branch not protected" });
      return answer(200, repo.classic);
    }
    const one = /^rulesets\/(\d+)$/.exec(rest);
    if (one !== null && method === "DELETE") {
      const before = repo.rulesets ?? [];
      repo.rulesets = before.filter((set) => set.id !== Number(one[1]));
      return repo.rulesets.length === before.length
        ? answer(404, { message: "Not Found" })
        : answer(204, null);
    }
    if (rest !== "rulesets" || method !== "POST") return answer(404, { message: "Not Found" });
    const text = (value: unknown) => (typeof value === "string" ? value : undefined);
    const rulesetName = text(body.name);
    if (rulesetName === undefined || rulesetName === "") return invalid("Name can't be blank");
    if ((repo.rulesets ?? []).some((set) => set.name === rulesetName))
      return invalid("Name must be unique");
    const target = text(body.target) ?? "branch";
    if (!["branch", "tag", "push"].includes(target)) return invalid("Invalid target");
    const enforcement = text(body.enforcement);
    if (enforcement === "evaluate")
      return invalid("Evaluate mode is only available with GitHub Enterprise");
    if (enforcement !== "active" && enforcement !== "disabled")
      return invalid("Invalid enforcement");
    const conditions = (body.conditions ?? {}) as {
      ref_name?: { include?: unknown; exclude?: unknown };
    };
    const include = conditions.ref_name?.include;
    const exclude = conditions.ref_name?.exclude ?? [];
    if (!Array.isArray(include) || !Array.isArray(exclude) || include.length === 0)
      return invalid("Invalid conditions: ref_name.include is required");
    const rules = Array.isArray(body.rules) ? (body.rules as FakeRuleset["rules"]) : [];
    for (const rule of rules) {
      if (!RULE_TYPES.has(rule.type)) return invalid(`Invalid rule type: ${String(rule.type)}`);
      if (
        rule.type === "update" &&
        typeof rule.parameters?.update_allows_fetch_and_merge !== "boolean"
      )
        return invalid("Invalid rule 'update': update_allows_fetch_and_merge is required");
    }
    const bypass = Array.isArray(body.bypass_actors)
      ? (body.bypass_actors as FakeRuleset["bypass"])
      : [];
    const owner = this.account(name.split("/")[0]!);
    for (const entry of bypass) {
      if (!ACTOR_TYPES.has(entry.actor_type)) return invalid("Invalid actor type");
      if (!["always", "pull_request", "exempt", undefined].includes(entry.bypass_mode))
        return invalid("Invalid bypass mode");
      if (entry.actor_type === "OrganizationAdmin" && owner.type !== "Organization")
        return invalid("OrganizationAdmin is not applicable for personal repositories");
      if (entry.actor_type === "RepositoryRole" && !REPOSITORY_ROLES.has(Number(entry.actor_id)))
        return invalid("Invalid actor: the repository role doesn't exist");
    }
    const made: FakeRuleset = {
      id: this.next(),
      name: rulesetName,
      target,
      enforcement,
      include: include.map(String),
      exclude: exclude.map(String),
      rules,
      bypass: bypass.map((entry) => ({ ...entry, bypass_mode: entry.bypass_mode ?? "always" })),
    };
    repo.rulesets = [...(repo.rulesets ?? []), made];
    return answer(201, {
      id: made.id,
      name: made.name,
      target: made.target,
      source_type: "Repository",
      source: repo.full_name,
      enforcement: made.enforcement,
      bypass_actors: made.bypass,
      conditions: { ref_name: { include: made.include, exclude: made.exclude } },
      rules: made.rules,
    });
  }

  /** One REST call, as `gh api` makes it. */
  handle(
    method: string,
    rawPath: string,
    headers: Record<string, string> = {},
    body: Record<string, unknown> = {},
  ): FakeAnswer {
    const url = new URL(rawPath.replace(/^\/?/, "/"), "https://api.github.com");
    const path = url.pathname.replace(/^\//, "");
    this.world.calls.push(`${method} ${path}`);
    const ok = (value: unknown, extra: Record<string, string> = {}): FakeAnswer => ({
      status: method === "POST" ? 201 : 200,
      headers: extra,
      body: value,
    });
    const missing: FakeAnswer = { status: 404, headers: {}, body: { message: "Not Found" } };
    if (this.world.down !== null)
      return { status: this.world.down, headers: {}, body: { message: "Bad credentials" } };
    if (this.world.refused?.some((prefix) => path.startsWith(prefix)) === true)
      return {
        status: 403,
        headers: {},
        body: { message: "Resource not accessible by personal access token" },
      };
    const app = this.world.app ?? null;
    const bearer = /^bearer (.+)$/i.exec(headers.authorization ?? "")?.[1];
    const asApp = app !== null && bearer !== undefined && bearer.split(".").length === 3;
    const minted = app?.minted.find((entry) => entry.token === bearer);
    if (bearer !== undefined && !asApp && minted === undefined)
      return { status: 401, headers: {}, body: { message: "Bad credentials" } };
    if (minted !== undefined && minted.expiresAt <= this.world.now)
      return { status: 401, headers: {}, body: { message: "Bad credentials" } };
    const installation = app?.installations.find((entry) => entry.id === minted?.installation);
    const actor = installation === undefined ? this.world.user : `${app!.slug}[bot]`;
    const association = actor === this.world.user ? "OWNER" : "NONE";
    // As real GitHub: the App's JWT works only on `/app…`, which take nothing else, and
    // `/installation…` takes only an installation token.
    const appPath = path === "app" || path.startsWith("app/");
    if (asApp !== appPath || (path.startsWith("installation/") && installation === undefined))
      return {
        status: 401,
        headers: {},
        body: { message: "A JSON web token could not be decoded" },
      };
    if (app !== null && method === "GET" && decodeURIComponent(path) === `users/${app.slug}[bot]`)
      return ok({ id: app.botId, login: `${app.slug}[bot]` });
    // A private App is hidden from anyone not signed in as its owner.
    if (app !== null && method === "GET" && path === `apps/${app.slug}` && bearer === undefined)
      return app.public === false
        ? missing
        : ok({ slug: app.slug, name: app.name, owner: this.ownerJson(app) });
    if (asApp) {
      if (method === "GET" && path === "app")
        return ok({ slug: app.slug, name: app.name, owner: this.ownerJson(app) });
      if (method === "GET" && path === "app/installations")
        return ok(
          app.installations.map((entry) => {
            const account = this.account(entry.account);
            return {
              id: entry.id,
              account: { login: entry.account, id: account.id, type: account.type },
              repository_selection: entry.selection ?? "selected",
              suspended_at: entry.suspended === true ? iso(this.world.now) : null,
              suspended_by: entry.suspended === true ? { login: this.world.user } : null,
              html_url:
                account.type === "Organization"
                  ? `https://github.com/organizations/${entry.account}/settings/installations/${entry.id}`
                  : `https://github.com/settings/installations/${entry.id}`,
              target_id: account.id,
              target_type: account.type,
              permissions: entry.permissions,
            };
          }),
        );
      const mint = /^app\/installations\/(\d+)\/access_tokens$/.exec(path);
      const target = app.installations.find((entry) => entry.id === Number(mint?.[1]));
      if (method === "POST" && target?.suspended === true)
        return {
          status: 403,
          headers: {},
          body: { message: "This installation has been suspended" },
        };
      if (method === "POST" && target !== undefined) {
        const asked = (body.permissions ?? target.permissions) as Record<string, string>;
        const level = (value: string | undefined) =>
          ["read", "write", "admin"].indexOf(value ?? "");
        if (
          Object.entries(asked).some(
            ([name, value]) => level(value) > level(target.permissions[name]),
          )
        )
          return {
            status: 422,
            headers: {},
            body: { message: "The permissions requested are not granted to this installation." },
          };
        const token = `ghs_fake_${target.id}_${app.minted.length + 1}`;
        const expiresAt = this.world.now + 60 * 60_000;
        app.minted.push({ token, installation: target.id, expiresAt, permissions: asked });
        return ok({ token, expires_at: iso(expiresAt), permissions: asked });
      }
      return missing;
    }
    if (installation !== undefined) {
      const reached = this.installedRepos(installation);
      if (method === "GET" && path === "installation/repositories")
        return ok({
          total_count: reached.length,
          repository_selection: installation.selection ?? "selected",
          repositories: reached.map((full_name) => ({ full_name })),
        });
      const scoped = /^repos\/([^/]+\/[^/]+)\//.exec(path)?.[1]?.toLowerCase();
      if (scoped === undefined || !reached.some((repo) => repo.toLowerCase() === scoped))
        return { status: 404, headers: {}, body: { message: "Not Found" } };
    }
    const since = url.searchParams.get("since");
    const sinceMs = since === null ? 0 : Date.parse(since);
    if (method === "GET" && path === "user") return ok({ login: this.world.user });
    if (method === "GET" && path === "notifications") {
      const lastModified = httpDate(this.world.modified);
      const asked = headers["if-modified-since"];
      if (asked !== undefined && Date.parse(asked) >= Date.parse(lastModified))
        return {
          status: 304,
          headers: { "last-modified": lastModified, "x-poll-interval": this.interval() },
          body: null,
        };
      return ok(
        this.world.notifications
          .filter((thread) => thread.updated_at >= sinceMs)
          .map((thread) => {
            const item = this.item(thread.repo, thread.number);
            return {
              id: thread.id,
              reason: thread.reason,
              updated_at: iso(thread.updated_at),
              repository: { full_name: thread.repo },
              subject: {
                title: item.title,
                type: item.pull ? "PullRequest" : "Issue",
                url: `https://api.github.com/repos/${thread.repo}/${item.pull ? "pulls" : "issues"}/${thread.number}`,
              },
            };
          }),
        { "last-modified": lastModified, "x-poll-interval": this.interval() },
      );
    }
    if (method === "GET" && path === `users/${this.world.user}/events`) {
      const etag = `"v${this.world.eventsVersion}"`;
      if (headers["if-none-match"] === etag)
        return { status: 304, headers: { etag, "x-poll-interval": this.interval() }, body: null };
      return ok(
        this.world.events.slice(0, 100).map((event) => ({
          id: event.id,
          type: event.type,
          actor: { login: this.world.user },
          repo: { name: event.repo },
          created_at: iso(event.created_at),
          payload: {
            issue: { number: event.number },
            pull_request: { number: event.number },
            number: event.number,
          },
        })),
        { etag, "x-poll-interval": this.interval() },
      );
    }
    if (method === "GET" && path === "user/repos")
      return ok(
        this.world.repos.map((repo) => ({
          full_name: repo.full_name,
          private: repo.private,
          fork: repo.fork,
          id: this.repoId(repo.full_name),
          owner: (({ login, id, type }) => ({ login, id, type }))(
            this.account(repo.full_name.split("/")[0]!),
          ),
          default_branch: repo.default_branch ?? "main",
          permissions: { push: repo.push, admin: repo.admin !== false },
        })),
      );
    const conversion = /^app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (conversion !== null && method === "POST") {
      const made = this.world.manifestCodes?.[conversion[1]!];
      // A code works once, as GitHub's does.
      if (made === undefined) return missing;
      delete this.world.manifestCodes![conversion[1]!];
      const owner = this.account(this.world.user);
      this.world.app = {
        id: 9100,
        slug: made.slug,
        name: made.name,
        botId: 4100,
        owner: this.world.user,
        public: made.public ?? false,
        installations: [],
        minted: [],
      };
      return {
        status: 201,
        headers: {},
        body: {
          id: 9100,
          slug: made.slug,
          name: made.name,
          owner: { login: owner.login, id: owner.id, type: owner.type },
          client_id: "Iv1.invented",
          client_secret: "invented-client-secret",
          webhook_secret: null,
          // A real key, as GitHub's is, so Kin can sign with the App it just made.
          pem: NodeCrypto.generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs1", format: "pem" },
          }).privateKey,
          permissions: { contents: "write", metadata: "read" },
        },
      };
    }
    const edit = /^user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(path);
    if (edit !== null && bearer === undefined && (method === "PUT" || method === "DELETE")) {
      const target = app?.installations.find((entry) => entry.id === Number(edit[1]));
      const repo = this.world.repos.find(
        (entry) => this.repoId(entry.full_name) === Number(edit[2]),
      );
      if (this.world.installationEditsRefused === true)
        return {
          status: 403,
          headers: {},
          body: { message: "Resource not accessible by personal access token" },
        };
      if (target === undefined || repo === undefined) return missing;
      if (repo.admin === false)
        return {
          status: 403,
          headers: {},
          body: { message: "Must have admin rights to Repository." },
        };
      const name = repo.full_name;
      const picked = target.repos.some((entry) => entry.toLowerCase() === name.toLowerCase());
      const done: FakeAnswer = { status: 204, headers: {}, body: null };
      if (method === "PUT") {
        if (target.selection === "all" || picked) return { status: 304, headers: {}, body: null };
        target.repos.push(name);
        return done;
      }
      if (target.selection === "all")
        return {
          status: 422,
          headers: {},
          body: { message: "The application is installed on all repositories in this account." },
        };
      if (!picked) return { status: 304, headers: {}, body: null };
      if (target.repos.length === 1)
        return {
          status: 422,
          headers: {},
          body: { message: "Cannot remove the last repository from this installation." },
        };
      target.repos = target.repos.filter((entry) => entry.toLowerCase() !== name.toLowerCase());
      return done;
    }
    if (method === "GET" && path === "user/memberships/orgs") {
      const orgs = new Map<string, FakeAccount>();
      for (const repo of this.world.repos) {
        const account = this.account(repo.full_name.split("/")[0]!);
        if (account.type === "Organization") orgs.set(account.login.toLowerCase(), account);
      }
      for (const account of this.world.accounts ?? [])
        if (account.type === "Organization") orgs.set(account.login.toLowerCase(), account);
      return ok(
        [...orgs.values()].map((account) => ({
          state: "active",
          role: account.role ?? "admin",
          organization: { login: account.login, id: account.id },
        })),
      );
    }
    const match = /^repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
    if (match === null) return missing;
    const repo = match[1]!;
    const rest = match[2]!;
    let found: RegExpExecArray | null;
    const guarded = this.rulesAnswer(method, repo, rest, body, actor, installation !== undefined);
    if (guarded !== undefined) return guarded;
    try {
      if (method === "GET" && rest === "issues") {
        const state = url.searchParams.get("state") ?? "open";
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        return ok(
          this.world.items
            .filter(
              (item) =>
                item.repo.toLowerCase() === repo.toLowerCase() &&
                (state === "all" || item.state === state),
            )
            .toSorted((a, b) => b.number - a.number)
            .slice((page - 1) * perPage, page * perPage)
            .map((item) => this.issueJson(item)),
        );
      }
      if (method === "GET" && rest === "actions/runs") {
        const branch = url.searchParams.get("branch");
        const runs = (this.world.runs ?? [])
          .filter(
            (run) =>
              run.repo.toLowerCase() === repo.toLowerCase() &&
              (branch === null || run.branch === branch),
          )
          .toReversed()
          .slice(0, Number(url.searchParams.get("per_page") ?? "30"));
        return ok({
          total_count: runs.length,
          workflow_runs: runs.map((run) => ({
            id: run.id,
            name: run.name,
            workflow_id: run.workflow_id,
            head_branch: run.branch,
            status: "completed",
            conclusion: run.conclusion,
            created_at: iso(run.created_at),
            html_url: `https://github.com/${run.repo}/actions/runs/${run.id}`,
          })),
        });
      }
      if (method === "GET" && (found = /^issues\/(\d+)$/.exec(rest)))
        return ok(this.issueJson(this.item(repo, Number(found[1]))));
      if (method === "GET" && (found = /^pulls\/(\d+)$/.exec(rest))) {
        const item = this.item(repo, Number(found[1]));
        if (!item.pull) return missing;
        if ((headers.accept ?? "").includes("diff")) return ok(item.diff);
        return ok({
          ...this.issueJson(item),
          draft: item.draft,
          merged: item.merged,
          head: {
            ref: item.head_ref,
            sha: item.head_sha,
            repo: { full_name: item.fork ? `someone/${repo.split("/")[1]}` : repo },
          },
          base: { ref: "main" },
          additions: item.additions,
          deletions: item.deletions,
          changed_files: item.changed_files,
        });
      }
      if (method === "GET" && (found = /^(issues|pulls)\/(\d+)\/comments$/.exec(rest))) {
        const kind = found[1] === "issues" ? "issue" : "review";
        return ok(
          this.world.comments
            .filter(
              (comment) =>
                comment.repo.toLowerCase() === repo.toLowerCase() &&
                comment.number === Number(found![2]) &&
                comment.kind === kind &&
                comment.created_at >= sinceMs,
            )
            .map((comment) => this.commentJson(comment)),
        );
      }
      if (method === "GET" && (found = /^commits\/([^/]+)\/check-runs$/.exec(rest))) {
        const failing = this.world.checks[`${repo.toLowerCase()}@${found[1]}`] ?? [];
        const etag = `"c${failing.length}-${found[1]}"`;
        if (headers["if-none-match"] === etag)
          return { status: 304, headers: { etag }, body: null };
        return ok(
          {
            check_runs: failing.map((name) => ({
              name,
              status: "completed",
              conclusion: "failure",
            })),
          },
          { etag },
        );
      }
      if (method === "POST" && /reactions$/.test(rest)) {
        this.world.reactions.push({
          on: `${repo}/${rest}`,
          content: String(body.content),
          by: actor,
        });
        return ok({ content: body.content });
      }
      if (method === "POST" && (found = /^issues\/(\d+)\/comments$/.exec(rest))) {
        const id = this.comment({
          repo,
          number: Number(found[1]),
          author: actor,
          association,
          body: String(body.body ?? ""),
        });
        return ok({
          id,
          html_url: `https://github.com/${repo}/issues/${found[1]}#issuecomment-${id}`,
        });
      }
      if (method === "POST" && (found = /^pulls\/(\d+)\/reviews$/.exec(rest))) {
        const id = this.next();
        this.world.reviews.push({
          id,
          repo,
          number: Number(found[1]),
          user: actor,
          event: String(body.event ?? "COMMENT"),
          body: String(body.body ?? ""),
        });
        const inlines: ReadonlyArray<Record<string, unknown>> = Array.isArray(body.comments)
          ? body.comments
          : [];
        for (const inline of inlines)
          this.comment({
            repo,
            number: Number(found[1]),
            author: actor,
            association,
            body: String(inline.body ?? ""),
            path: String(inline.path ?? ""),
            line: Number(inline.line ?? 1),
          });
        return ok({
          id,
          html_url: `https://github.com/${repo}/pull/${found[1]}#pullrequestreview-${id}`,
        });
      }
      if (method === "POST" && rest === "issues") {
        const number = this.openItem({
          repo,
          pull: false,
          author: actor,
          association,
          title: String(body.title ?? ""),
          body: String(body.body ?? ""),
        });
        return ok({ number, html_url: `https://github.com/${repo}/issues/${number}` });
      }
    } catch {
      return missing;
    }
    return missing;
  }
}

/**
 * What gh prints on stderr after the body, as `pkg/cmd/api/api.go` does: GitHub's `message` for a
 * JSON error (or for any GraphQL answer carrying errors), else `HTTP <status>` for anything past 299
 * but a 204. The real gh writes it straight after the body, with no newline between them.
 */
export const ghApiStderr = (path: string, answer: FakeAnswer) => {
  if (answer.status === 204) return "";
  let said = "";
  const body = answer.body;
  if (
    body !== null &&
    typeof body === "object" &&
    (path.replace(/^\//, "") === "graphql" || answer.status >= 400)
  ) {
    const { message, errors } = body as { message?: unknown; errors?: unknown };
    const text = typeof message === "string" ? message : "";
    if (typeof errors === "string" && errors !== "") said = text ? `${errors} (${text})` : errors;
    else if (text !== "") said = `${text} (HTTP ${answer.status})`;
    else if (Array.isArray(errors))
      said = errors
        .map((error) =>
          typeof error === "string"
            ? error
            : String((error as { message?: unknown } | null)?.message ?? ""),
        )
        .join("\n");
  }
  if (said === "" && answer.status > 299) said = `HTTP ${answer.status}`;
  return said === "" ? "" : `gh: ${said}\n`;
};

/** `gh api` output with `-i`: the status line, headers, a blank line, then the body. */
export const ghApiOutput = (answer: FakeAnswer) =>
  [
    `HTTP/2.0 ${answer.status} ${answer.status < 300 ? "OK" : answer.status === 304 ? "Not Modified" : "Error"}`,
    ...Object.entries(answer.headers).map(([name, value]) => `${name}: ${value}`),
    "",
    answer.body === null
      ? ""
      : typeof answer.body === "string"
        ? answer.body
        : JSON.stringify(answer.body),
  ].join("\r\n");

/** The value after `flag` in gh's arguments. */
const flagValue = (args: ReadonlyArray<string>, ...flags: string[]) => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const flag of flags) {
      if (arg === flag) return args[i + 1];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    }
  }
  return undefined;
};

/** Runs one `gh` command against the world; returns its exit code and output. */
const runGh = (world: FakeGitHub, args: ReadonlyArray<string>, stdin: string) => {
  const repo = flagValue(args, "--repo", "-R") ?? world.world.repos[0]?.full_name ?? "";
  const body = flagValue(args, "--body", "-b") ?? "";
  if (args[0] === "api") {
    const headers: Record<string, string> = {};
    const fields: Record<string, unknown> = {};
    let method = "GET";
    let path = "";
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-i" || arg === "--include") continue;
      if (arg === "-X" || arg === "--method") method = args[++i]!;
      else if (arg === "-H" || arg === "--header") {
        const [name, ...value] = args[++i]!.split(":");
        headers[name!.trim().toLowerCase()] = value.join(":").trim();
      } else if (arg === "-f" || arg === "-F" || arg === "--field" || arg === "--raw-field") {
        const [name, ...value] = args[++i]!.split("=");
        fields[name!] = value.join("=");
        if (method === "GET") method = "POST";
      } else if (arg === "--input") {
        i++;
        Object.assign(fields, JSON.parse(stdin || "{}"));
        if (method === "GET") method = "POST";
      } else if (!arg.startsWith("-")) path = arg;
    }
    const answer = world.handle(method, path, headers, fields);
    const output =
      args.includes("-i") || args.includes("--include")
        ? ghApiOutput(answer)
        : answer.body === null
          ? ""
          : JSON.stringify(answer.body);
    const err = ghApiStderr(path, answer);
    return { code: answer.status >= 300 || err !== "" ? 1 : 0, out: output, err };
  }
  const sub = `${args[0]} ${args[1]}`;
  const number = Number(args[2]);
  if (sub === "pr review") {
    const event = args.includes("--request-changes")
      ? "REQUEST_CHANGES"
      : args.includes("--approve")
        ? "APPROVE"
        : "COMMENT";
    const answer = world.handle(
      "POST",
      `repos/${repo}/pulls/${number}/reviews`,
      {},
      { body, event },
    );
    return { code: answer.status < 300 ? 0 : 1, out: "" };
  }
  if (sub === "pr comment" || sub === "issue comment") {
    const answer = world.handle("POST", `repos/${repo}/issues/${number}/comments`, {}, { body });
    return {
      code: answer.status < 300 ? 0 : 1,
      out: `https://github.com/${repo}/issues/${number}\n`,
    };
  }
  if (sub === "issue create") {
    const answer = world.handle(
      "POST",
      `repos/${repo}/issues`,
      {},
      {
        title: flagValue(args, "--title", "-t") ?? "",
        body,
      },
    );
    const created = answer.body as { html_url: string };
    return { code: 0, out: `${created.html_url}\n` };
  }
  return { code: 2, out: `fake gh: unexpected ${args.join(" ")}` };
};

// `node fakeGitHub.ts <gh args>` from fakeGh.sh, or `node fakeGitHub.ts world <op> '<json>'`
// from a driver script; the world lives in $KIN_FAKE_GH/github.json.
const main = async () => {
  const fs = await import("node:fs");
  const state = `${process.env.KIN_FAKE_GH ?? "."}/github.json`;
  const userFile = `${process.env.KIN_FAKE_GH ?? "."}/user`;
  // The server and a driver script both write the world: one at a time, or a write is lost.
  const lock = `${state}.lock`;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      if (tries > 1000) fs.rmSync(lock, { recursive: true, force: true });
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  const user = fs.existsSync(userFile)
    ? fs.readFileSync(userFile, "utf8").trim()
    : "invented-owner";
  const world = new FakeGitHub(
    fs.existsSync(state)
      ? (JSON.parse(fs.readFileSync(state, "utf8")) as FakeWorld)
      : emptyWorld(user, Date.now()),
  );
  world.world.now = Math.max(world.world.now, Date.now());
  const args = process.argv.slice(2);
  let code = 0;
  let out = "";
  let err = "";
  if (args[0] === "world") {
    const input = JSON.parse(args[2] ?? "{}");
    const op = args[1];
    const result =
      op === "repo"
        ? world.addRepo(input)
        : op === "open"
          ? world.openItem(input)
          : op === "comment"
            ? world.comment(input)
            : op === "label"
              ? world.label(input)
              : op === "ready"
                ? world.ready(input)
                : op === "request-review"
                  ? world.requestReview(input)
                  : op === "checks"
                    ? world.setChecks(input)
                    : op === "merge"
                      ? world.merge(input)
                      : op === "app"
                        ? (world.world.app = input === null ? null : { minted: [], ...input })
                        : op === "accounts"
                          ? (world.world.accounts = input)
                          : op === "manifest-code"
                            ? (world.world.manifestCodes = {
                                ...world.world.manifestCodes,
                                [input.code]: input,
                              })
                            : op === "down"
                              ? (world.world.down = input.status ?? null)
                              : op === "interval"
                                ? (world.world.pollInterval = input.seconds)
                                : op === "show"
                                  ? world.world
                                  : undefined;
    out = JSON.stringify(result ?? null);
  } else {
    const stdin = args.includes("--input") ? fs.readFileSync(0, "utf8") : "";
    ({ code, out, err = "" } = runGh(world, args, stdin));
  }
  fs.writeFileSync(state, JSON.stringify(world.world));
  fs.rmSync(lock, { recursive: true, force: true });
  // gh ends a body with no newline when stderr follows it, so the two run together as on GitHub.
  const body = err !== "" || out.endsWith("\n") || out === "" ? out : `${out}\n`;
  process.stdout.write(body, () =>
    err === "" ? process.exit(code) : process.stderr.write(err, () => process.exit(code)),
  );
};

if (process.argv[1]?.endsWith("fakeGitHub.ts")) void main();
