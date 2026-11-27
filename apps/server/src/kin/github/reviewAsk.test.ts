import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  CommandId,
  EnvironmentId,
  KinAgentId,
  type KinOrgId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinPersonId,
  type KinWakeupId,
  ProviderInstanceId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import { recordAudience, turnAudience } from "../lead/Audience.ts";
import {
  codingAgentSource,
  markOutside,
  OUTSIDE_REFUSAL,
  outsideStamp,
  REPO_READ_REFUSAL,
  stampKey,
} from "../lead/OutsideContent.ts";
import { SHARED_TOOLS } from "../lead/SharedTools.ts";
import { laneFor } from "../reply/replyLane.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import {
  authorityLayer,
  endAgentWakeups,
  startAgentWakeup,
} from "../chat/WakeupAuthority.testkit.ts";
import { cappedOutput, KinGitHubLogin } from "../connections/GitHubLogin.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import { onPersonRemoved } from "../lead/ChatSharing.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Reach from "../lead/Reach.ts";
import * as Team from "../team/KinTeam.ts";
import { signed } from "./agentMark.ts";
import {
  blocksLine,
  outsideBlocksLine,
  outsideLine,
  postedLine,
  unfinishedLine,
} from "./askedFor.ts";
import { emptyWorld, FakeGitHub, ghApiOutput, ghApiStderr, runGh } from "./fakeGitHub.ts";
import * as GitHubWatch from "./GitHubWatch.ts";
import { KinGitHubApp, make as makeApp } from "./KinGitHubApp.ts";
import { appHost, fakeHttp, installApp } from "./KinGitHubApp.testkit.ts";
import { setRepo } from "./githubWatchStore.ts";
import { triagedKey } from "./boundIssue.ts";
import { isOutsideTriage } from "../lead/outsideTriage.ts";
import { headKey, POSTING } from "./boundReview.ts";
import { READ_NEXT, READ_REFUSAL } from "./repoRead.ts";
import { ASK_REFUSAL, DIFF_NEXT, DIFF_REFUSAL, POST_REFUSAL, PULL_REFUSAL } from "./reviewAsk.ts";
const { DIFF_CAP } = GitHubWatch;
import { KIN_OWN_REFUSAL } from "../people/KinAccess.ts";

/**
 * Ambermill (invented): Rhea owns it and the GitHub login Kin watches with; Dev, Zoya and Meera
 * are members, Arjun a co-owner. Kin has every GitHub login but Zoya's. The watched repos are the
 * company's own; the ledger is private, and of them GitHub lets only Dev read it.
 */
const at = "2026-11-01T00:00:00.000Z";
const APP = "ambermill/app";
const SITE = "ambermill/site";
const BATCH = "ambermill/batch";
const FORK = "ambermill/old-fork";
const MEMORY = "ambermill/kin-memory";
const LEDGER = "ambermill/ledger";
const BUSY = "ambermill/busy";
const OWNER_LOGIN = "rhea-gh";
const NOTES = "ambermill/notes";
const MOVED = "ambermill/old-app";
const providerInstanceId = ProviderInstanceId.make("codex");
const tech = KinAgentId.make("tech");
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(KinEvent));
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scopeOf = (agent: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: agent,
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agent}-thread`),
    providerSessionId: agent,
    providerInstanceId,
  },
});

/** The fake as the owner's own `gh` answers it: the login Kin's GitHub tools go through. */
const fakeLogin = (github: FakeGitHub) =>
  Layer.mock(KinGitHubLogin)({
    connected: () => Effect.succeed(true),
    account: () =>
      Effect.succeed({
        login: OWNER_LOGIN,
        orgs: ["ambermill", "tidewater"],
        scopes: ["repo"],
        problem: null,
      }),
    ghDirectory: "/nonexistent",
    gh: (args, stdin) =>
      Effect.sync(() => {
        const run = runGh(github, args, stdin ?? "");
        return { code: run.code, ...cappedOutput(run.out + (run.err ?? "")) };
      }),
  });

/** The same fake as the watch reads it. */
const watchApi = (github: FakeGitHub) =>
  GitHubWatch.KinGitHubApi.of({
    connected: () => Effect.succeed({ login: OWNER_LOGIN, orgs: ["ambermill", "tidewater"] }),
    call: (request) =>
      Effect.sync(() => {
        const answer = github.handle(
          request.method ?? "GET",
          request.path,
          Object.fromEntries(
            Object.entries(request.headers ?? {}).map(([name, value]) => [
              name.toLowerCase(),
              value,
            ]),
          ),
          (request.body ?? {}) as Record<string, unknown>,
        );
        return GitHubWatch.parseGhApi(ghApiOutput(answer) + ghApiStderr(request.path, answer));
      }),
  });

const harness = (config: Record<string, unknown> = {}, options: { readonly app?: true } = {}) => {
  const github = new FakeGitHub(emptyWorld(OWNER_LOGIN, 0));
  for (const repo of [APP, SITE, BATCH, MEMORY, BUSY])
    github.addRepo({ full_name: repo, private: false });
  github.addRepo({ full_name: FORK, fork: true });
  github.addRepo({ full_name: LEDGER, collaborators: ["dev-gh"] });
  const kinServices = Layer.unwrap(
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      return Layer.mergeAll(Handoff.layer, Team.layer, Layer.mock(LeadMemory)({})).pipe(
        Layer.provideMerge(Layer.succeedContext(services)),
      );
    }),
  );
  // Kin's GitHub App over the same fake, set up but installed only where a test says.
  const app = Layer.effect(KinGitHubApp, makeApp).pipe(
    Layer.provide(Layer.mergeAll(fakeHttp(github), appHost({ appId: "9001" }))),
  );
  const layer = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
    KinToolGate.layer,
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(options.app === true ? app : Layer.empty),
    Layer.provideMerge(fakeLogin(github)),
    // Kin's memory repo, which the watch and an ask both leave alone; past Kin's own config.
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          KIN_ENABLED: true,
          KIN_MEMORY_REPOSITORIES: JSON.stringify([
            { orgId: "kin-memory-org", repoUrl: `https://github.com/${MEMORY}.git` },
          ]),
          ...config,
        }),
      ),
    ),
    Layer.provideMerge(kinServices),
    Layer.provideMerge(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed({ ...liveThreadShell(id), providerInstanceId }),
      }),
    ),
    Layer.provideMerge(
      Kin.layer.pipe(
        Layer.provide(kinSecretsTest),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
        Layer.provideMerge(environment),
      ),
    ),
    Layer.provideMerge(authorityLayer),
    Layer.provideMerge(kinSecretsTest),
  );
  return { github, layer };
};

/** A tool call exactly as an agent's provider sends it: its JSON answer, or its refusal. */
const callAs = Effect.fn("test.callAs")(function* (
  agent: string,
  name: string,
  args: Record<string, unknown>,
) {
  const server = yield* McpServer.McpServer;
  const identity = Context.get(Option.getOrThrow((yield* Kin.KinServer).services), KinIdentity);
  const result = yield* server.callTool({ name, arguments: args }).pipe(
    Effect.provideService(McpInvocationContext, scopeOf(agent)),
    Effect.provideService(KinIdentity, identity),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.map((answer) => ({
      isError: answer.isError === true,
      text: answer.content.find((item) => item.type === "text")?.text ?? "{}",
    })),
    // A gate's refusal (`ToolCallRefused`) reaches the agent as its answer.
    Effect.catch((error) =>
      Effect.succeed({
        isError: true,
        text: JSON.stringify({
          message: Predicate.hasProperty(error, "message") ? String(error.message) : String(error),
        }),
      }),
    ),
  );
  return { ok: !result.isError, value: JSON.parse(result.text) as Record<string, unknown> };
});

const ambermill = Effect.fn("test.ambermill")(function* (github: FakeGitHub) {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(AuthSessionId.make("owner"));
  const [resolved] = yield* identity.resolve({
    sessionId: AuthSessionId.make("owner"),
    subject: "browser",
    method: "browser-session-cookie",
    scopes: AuthStandardClientScopes,
  });
  const owner = resolved!;
  const { orgId } = owner;
  yield* sql`UPDATE kin_people SET display_name = 'Rhea Rao', github_login = ${OWNER_LOGIN}
    WHERE person_id = ${owner.personId}`;
  for (const [id, name, login, access] of [
    ["dev", "Dev Malhotra", "dev-gh", "member"],
    ["zoya", "Zoya Sheikh", null, "member"],
    ["meera", "Meera Iyer", "meera-gh", "member"],
    ["arjun", "Arjun Rao", "arjun-gh", "co_owner"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login,
        created_at, access)
      VALUES (${id}, ${orgId}, ${id}, ${name}, ${login}, ${at}, ${access})`;
  for (const [id, name, domain] of [
    ["tech", "Tech lead", "engineering"],
    ["chief", "Chief of staff", "chief-of-staff"],
  ] as const) {
    const agentId = KinAgentId.make(id);
    const threadId = ThreadId.make(`${id}-thread`);
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, ${name}, 'lead', ${owner.personId}, ${at})`;
    yield* identity.registerAgentThread({ orgId, agentId, threadId });
    const chatId = (yield* chats.createDirect(owner, { orgId, agentId })).chatId;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agentId}, ${orgId}, ${name}, 0, ${threadId}, '{}', '[]', ${chatId}, ${domain})`;
  }
  // The watch has looked once, a minute after the PRs opened, so Kin knows the company's repos
  // (the fork is switched off) and the PRs are older than the watch: GitHub's review request is new.
  yield* setRepo({ orgId, repo: FORK, watched: false }, 0);
  yield* TestClock.adjust(60_000);
  const watch = yield* GitHubWatch.make.pipe(
    Effect.provideService(GitHubWatch.KinGitHubApi, watchApi(github)),
    Effect.provide(Layer.succeedContext(services)),
  );
  yield* watch.poll(orgId, { force: true });
  const look = Effect.gen(function* () {
    github.tick(60_000);
    yield* TestClock.adjust(60_000);
    yield* watch.poll(orgId, { force: true });
  });
  const person = (id: string) => ({
    _tag: "person" as const,
    orgId,
    personId: KinPersonId.make(id),
  });
  const directOf = (id: string) =>
    chats
      .createDirect(person(id), { orgId, agentId: tech })
      .pipe(Effect.map((chat) => chat.chatId));
  const queue = Context.get(services, KinEventQueue);
  /** Ends the running turn as `status`, through the queue's own finish. */
  const end = (status: "completed" | "failed") =>
    endAgentWakeups({ orgId, threadId: ThreadId.make("tech-thread"), status }).pipe(
      Effect.provideService(KinEventQueue, queue),
    );
  /** A turn of the Tech lead's, woken by `who` saying `body` in `chatId`. */
  const ask = Effect.fn("test.ask")(function* (
    who: string,
    chatId: KinChatId,
    body: string,
    options: { readonly keepQueued?: true } = {},
  ) {
    // Reviews already queued have had their turns, so this wake-up takes the person's message.
    if (options.keepQueued !== true)
      yield* sql`UPDATE kin_events SET state = 'done'
        WHERE org_id = ${orgId} AND tag = 'github' AND state = 'queued'`;
    yield* startAgentWakeup({
      orgId,
      agentId: tech,
      threadId: ThreadId.make("tech-thread"),
      message: yield* chats.send(person(who), { chatId, body, clientMessageId: `${who}:${body}` }),
    });
  });
  /** The asked review queued for `eventId` runs as the Tech lead's next turn. */
  const runReview = Effect.fn("test.runReview")(function* (eventId: string) {
    yield* startAgentWakeup({
      orgId,
      agentId: tech,
      threadId: ThreadId.make("tech-thread"),
      queued: true,
    });
    const [claimed] = yield* sql<{ state: string }>`SELECT state FROM kin_events
      WHERE org_id = ${orgId} AND event_id = ${eventId}`;
    assert.strictEqual(claimed?.state, "claimed");
  });
  const told = (chatId: KinChatId) =>
    sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND author_kind = 'system' ORDER BY seq`.pipe(
      Effect.map((rows) => rows.map((row) => row.body)),
    );
  const review = (args: Record<string, unknown>) => callAs("tech", "kin_github_review_ask", args);
  const githubEvents = sql<{ json: string }>`SELECT json FROM kin_events
    WHERE org_id = ${orgId} AND tag = 'github' ORDER BY queued_at, rowid`.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const event = decodeEvent(row.json);
        assert(event._tag === "github" && event.trigger !== undefined);
        return { ...event, trigger: event.trigger };
      }),
    ),
  );
  const handled = (key: string) =>
    sql<{ outcome: string; url: string | null }>`SELECT outcome, review_url AS url
      FROM kin_github_handled WHERE org_id = ${orgId} AND trigger_key = ${key}`;
  return {
    sql,
    owner,
    orgId,
    queue,
    look,
    directOf,
    ask,
    end,
    runReview,
    told,
    handled,
    review,
    githubEvents,
  };
});

const outcomes = (value: Record<string, unknown>): ReadonlyArray<readonly [string, string]> =>
  (value.pulls as ReadonlyArray<{ repo: string; number: number; outcome: string }>).map((pull) => [
    `${pull.repo}#${pull.number}`,
    pull.outcome,
  ]);
const DRAFT = PULL_REFUSAL.draft;
const already = PULL_REFUSAL.already;
const headOf = (github: FakeGitHub, repo: string, number: number) =>
  github.world.items.find((item) => item.repo === repo && item.number === number)!.head_sha;

// A teammate wrote "Check the latest changes to the PRs" in his own chat with the Tech lead, and it
// could only pass that to the owner and wait. Now an ask is a review request, ruled by the server.
it.effect(
  "an ask queues where the rule allows it, only on repos the asker can read; each refusal is its sentence",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const pr = (
        repo: string,
        author: string,
        title: string,
        more: { draft?: boolean; body?: string } = {},
      ) => github.openItem({ repo, pull: true, author, association: "MEMBER", title, ...more });
      const devApp = pr(APP, "dev-gh", "Parse invoice dates");
      const devDraft = pr(APP, "dev-gh", "Try a new parser", { draft: true });
      const arjunApp = pr(APP, "arjun-gh", "Rename the config");
      const kinsOwn = pr(APP, OWNER_LOGIN, "Bump the lockfile", {
        body: signed("Bumps the lockfile.", "Tech lead"),
      });
      const devSite = pr(SITE, "dev-gh", "Fix the footer");
      const devLedger = pr(LEDGER, "dev-gh", "Round the totals");
      pr(LEDGER, "meera-gh", "Close the quarter");
      for (let index = 0; index < 100; index++) pr(BUSY, `someone-${index}`, `Busy ${index}`);
      const head = (repo: string, number: number) => headOf(github, repo, number);
      const firstHead = head(APP, devApp);
      const { review, ask, directOf, githubEvents, sql, orgId, owner } = yield* ambermill(github);
      const chatOf = {
        dev: yield* directOf("dev"),
        zoya: yield* directOf("zoya"),
        meera: yield* directOf("meera"),
        arjun: yield* directOf("arjun"),
      };
      const titles = github.world.items.map((item) => item.title);
      const cutNote = ` ${BUSY} has more than 100 open pull requests and Kin read only the newest 100: for another, ask by number.`;
      const fail = (path: string) => () => {
        github.world.failing = [path];
      };

      const table: ReadonlyArray<{
        readonly name: string;
        readonly who: keyof typeof chatOf;
        readonly args: Record<string, unknown>;
        readonly refused?: string;
        readonly expect?: ReadonlyArray<readonly [string, string]>;
        readonly next?: string;
        readonly before?: () => void;
        readonly keepQueued?: true;
      }> = [
        {
          name: "no GitHub username on file and no repo",
          who: "zoya",
          args: {},
          refused: ASK_REFUSAL.noLogin("Zoya Sheikh"),
        },
        {
          name: "no username: another person's PR on a public repo, by repo and number",
          who: "zoya",
          args: { repo: APP, number: arjunApp },
          expect: [[`${APP}#${arjunApp}`, "queued"]],
        },
        {
          name: "no username: a private repo answers as one Kin doesn't watch does",
          who: "zoya",
          args: { repo: LEDGER },
          refused: ASK_REFUSAL.noLogin("Zoya Sheikh"),
        },
        {
          name: "no username: a repo Kin doesn't watch",
          who: "zoya",
          args: { repo: FORK },
          refused: ASK_REFUSAL.noLogin("Zoya Sheikh"),
        },
        {
          name: "his own open PRs on every watched repo he can read, the private one too",
          who: "dev",
          args: {},
          expect: [
            [`${APP}#${devApp}`, "queued"],
            [`${APP}#${devDraft}`, DRAFT],
            [`${LEDGER}#${devLedger}`, "queued"],
            [`${SITE}#${devSite}`, "queued"],
          ],
        },
        {
          name: "the same heads while their reviews wait",
          who: "dev",
          args: {},
          keepQueued: true,
          expect: [
            [`${APP}#${devApp}`, PULL_REFUSAL.underWay],
            [`${APP}#${devDraft}`, DRAFT],
            [`${LEDGER}#${devLedger}`, PULL_REFUSAL.underWay],
            [`${SITE}#${devSite}`, PULL_REFUSAL.underWay],
          ],
        },
        {
          name: "a private repo GitHub says she can't read answers as one Kin doesn't watch",
          who: "meera",
          args: { repo: LEDGER },
          refused: ASK_REFUSAL.unwatched(LEDGER, false),
        },
        {
          name: "her own PRs: the private repo she can't read isn't looked in",
          who: "meera",
          args: {},
          expect: [],
          next: `Meera Iyer has no open pull requests there. Nothing was started.${cutNote}`,
        },
        {
          name: "a PR Kin wrote",
          who: "dev",
          args: { repo: APP, number: kinsOwn },
          expect: [[`${APP}#${kinsOwn}`, PULL_REFUSAL.kins]],
        },
        {
          name: "the same heads once reviewed",
          who: "dev",
          args: {},
          expect: [
            [`${APP}#${devApp}`, already(firstHead)],
            [`${APP}#${devDraft}`, DRAFT],
            [`${LEDGER}#${devLedger}`, already(head(LEDGER, devLedger))],
            [`${SITE}#${devSite}`, already(head(SITE, devSite))],
          ],
        },
        {
          name: "a new head after a review",
          who: "dev",
          args: { repo: APP },
          before: () => github.push({ repo: APP, number: devApp }),
          expect: [
            [`${APP}#${devApp}`, "queued"],
            [`${APP}#${devDraft}`, DRAFT],
          ],
        },
        {
          name: "a new head whose changes GitHub won't give",
          who: "dev",
          args: { repo: SITE, number: devSite },
          before: () => {
            github.push({ repo: SITE, number: devSite });
            fail(`repos/${SITE}/compare/base${devSite}...${head(SITE, devSite)}`)();
          },
          expect: [[`${SITE}#${devSite}`, PULL_REFUSAL.diff]],
        },
        {
          name: "more open PRs than one page",
          who: "dev",
          args: { repo: BUSY },
          expect: [],
          next: `Dev Malhotra has no open pull requests there. Nothing was started.${cutNote}`,
        },
        {
          name: "GitHub fails on the repo's visibility",
          who: "dev",
          args: { repo: LEDGER },
          before: fail(`repos/${LEDGER}`),
          refused: ASK_REFUSAL.unreachable,
        },
        {
          name: "GitHub fails on who can read it",
          who: "dev",
          args: { repo: LEDGER },
          before: fail(`repos/${LEDGER}/collaborators/dev-gh`),
          refused: ASK_REFUSAL.unreachable,
        },
        {
          name: "GitHub fails on the list of open PRs",
          who: "dev",
          args: { repo: SITE },
          before: fail(`repos/${SITE}/pulls`),
          refused: ASK_REFUSAL.unreachable,
        },
        {
          name: "a repo Kin doesn't watch",
          who: "dev",
          args: { repo: FORK },
          refused: ASK_REFUSAL.unwatched(FORK, false),
        },
        {
          name: "a repo Kin doesn't watch, asked by a co-owner, who adds it herself",
          who: "arjun",
          args: { repo: FORK },
          refused: ASK_REFUSAL.unwatched(FORK, true),
        },
        {
          name: "Kin's memory repo",
          who: "dev",
          args: { repo: MEMORY },
          refused: ASK_REFUSAL.memory(MEMORY),
        },
      ];
      for (const row of table) {
        github.world.failing = [];
        row.before?.();
        yield* ask(
          row.who,
          chatOf[row.who],
          `Check the PRs (${row.name})`,
          row.keepQueued === true ? { keepQueued: true } : {},
        );
        const called = yield* review(row.args);
        if (row.refused !== undefined) {
          assert.isFalse(called.ok, row.name);
          // The refusal alone: nothing tells a repo it may not ask about from one Kin doesn't watch.
          assert.deepStrictEqual(
            called.value,
            { _tag: "KinChatError", reason: "not_allowed", message: row.refused },
            row.name,
          );
          continue;
        }
        assert.isTrue(called.ok, `${row.name}: ${JSON.stringify(called.value)}`);
        assert.deepStrictEqual(outcomes(called.value), row.expect, row.name);
        if (row.next !== undefined) assert.strictEqual(called.value.next, row.next, row.name);
        // Repo, number, short head and outcome: no text from GitHub reaches the asking turn.
        const said = JSON.stringify(called.value);
        assert.deepStrictEqual(
          titles.filter((title) => said.includes(title)),
          [],
          row.name,
        );
      }
      github.world.failing = [];
      // One event per head queued, in the asker's name, its own head's diff read for a turn with no shell.
      const queued = yield* githubEvents;
      assert.deepStrictEqual(
        queued.map((event) => [event.trigger.key, event.askedBy, event.trigger.pull?.headSha]),
        [
          [`review:${APP}#${arjunApp}:${head(APP, arjunApp)}`, "zoya", head(APP, arjunApp)],
          [`review:${APP}#${devApp}:${firstHead}`, "dev", firstHead],
          [
            `review:${LEDGER}#${devLedger}:${head(LEDGER, devLedger)}`,
            "dev",
            head(LEDGER, devLedger),
          ],
          [
            `review:${SITE}#${devSite}:${queued[3]!.trigger.pull?.headSha}`,
            "dev",
            queued[3]!.trigger.pull?.headSha,
          ],
          [`review:${APP}#${devApp}:${head(APP, devApp)}`, "dev", head(APP, devApp)],
        ],
      );
      for (const event of queued) {
        assert.strictEqual(event.agentId, tech);
        assert.strictEqual(event.trigger.kind, "review_request");
        assert.isString(event.trigger.pull?.diff);
      }

      // A group others read is not his own chat.
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
      VALUES ('releases', ${orgId}, 'team_group', 'Releases', 0, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('g-rhea', ${orgId}, 'releases', 'person', ${owner.personId}, 'owner', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('g-dev', ${orgId}, 'releases', 'person', 'dev', 'member', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES ('g-tech', ${orgId}, 'releases', 'agent', ${tech}, 'member', ${at})`;
      yield* ask("dev", KinChatId.make("releases"), "Check my PRs");
      const inGroup = yield* review({});
      assert.isFalse(inGroup.ok);
      assert.strictEqual(inGroup.value.message, ASK_REFUSAL.chat);

      // A restricted pair: the owner restricted Dev and the Tech lead while his turn ran.
      yield* ask("dev", chatOf.dev, "Check my PRs again");
      yield* Reach.setLimit({
        orgId,
        by: owner.personId,
        a: Reach.person(KinPersonId.make("dev")),
        b: Reach.agent(tech),
        restricted: true,
      });
      const restricted = yield* review({});
      assert.isFalse(restricted.ok);
      assert.strictEqual(
        restricted.value.message,
        ASK_REFUSAL.restricted("Dev Malhotra", "Tech lead"),
      );
      assert.lengthOf(yield* githubEvents, 5);
    }).pipe(Effect.provide(layer));
  },
);

// Every PR an ask names is queued, each told in the asker's chat and grouped by the ask's turn.
it.effect("seven open PRs: every one queues, each told in the asker's chat", () => {
  const { github, layer } = harness();
  return Effect.gen(function* () {
    const numbers = Array.from({ length: 7 }, (_, index) =>
      github.openItem({
        repo: BATCH,
        pull: true,
        author: `author-${index}`,
        association: "COLLABORATOR",
        title: `Change ${index + 1}`,
      }),
    );
    const { review, ask, directOf, githubEvents, sql } = yield* ambermill(github);
    const zoyaChat = yield* directOf("zoya");
    yield* ask("zoya", zoyaChat, "Review everything open on batch");
    const first = yield* review({ repo: BATCH });
    assert.isTrue(first.ok, JSON.stringify(first.value));
    assert.deepStrictEqual(
      outcomes(first.value),
      numbers.map((number) => [`${BATCH}#${number}`, "queued"] as const),
    );
    assert.notInclude(JSON.stringify(first.value), "Ask again");
    const [turn] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId"
      FROM kin_events WHERE tag = 'chat.message' ORDER BY received_at DESC, event_id DESC LIMIT 1`;
    assert.deepStrictEqual(
      (yield* githubEvents).map((event) => [event.chatId, event.askedIn?.join()]),
      numbers.map(() => [zoyaChat, turn!.wakeupId]),
    );
  }).pipe(Effect.provide(layer));
});

// A diff past the prompt's cut is read on in pieces by the review turn, never by another turn.
it.effect.each([
  { name: "whole", lines: 2_000, end: DIFF_NEXT.end },
  // Past what Kin keeps of one gh answer: the read stops there and says the review is partial.
  { name: "cut by gh", lines: 20_000, end: DIFF_NEXT.partial },
])(
  "a long diff is read on with kin_github_diff, the head's and the review turn's only: $name",
  ({ lines, end }) => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const line = "+an invented line of the long change\n";
      const plain = `diff --git a/a.ts b/a.ts\n${line.repeat(lines)}`;
      // A character of two UTF-16 units where the first piece would end.
      const diff = `${plain.slice(0, DIFF_CAP - 1)}😀${plain.slice(DIFF_CAP - 1)}`;
      const number = github.openItem({
        repo: APP,
        pull: true,
        author: "dev-gh",
        association: "MEMBER",
        title: "Move the map",
        diff,
      });
      const { review, ask, runReview, directOf, githubEvents, owner } = yield* ambermill(github);
      const read = (from?: number) =>
        callAs("tech", "kin_github_diff", from === undefined ? {} : { from });
      yield* ask(owner.personId, yield* directOf(owner.personId), "What changed on the map?");
      assert.strictEqual((yield* read()).value.message, DIFF_REFUSAL.unbound);
      yield* ask("dev", yield* directOf("dev"), "Review my PR");
      assert.deepStrictEqual(outcomes((yield* review({ repo: APP, number })).value), [
        [`${APP}#${number}`, "queued"],
      ]);
      const [event] = yield* githubEvents;
      const kept = DIFF_CAP - 1;
      const shown = event!.trigger.pull!.diff!;
      assert.strictEqual(shown.slice(0, kept), diff.slice(0, kept));
      assert.match(
        shown.slice(kept),
        /^\n…\[the diff goes on for \d+ more characters: read them with kin_github_diff, from 29999\]$/,
      );
      yield* runReview(event!.eventId);
      // The base branch moves on mid-review: every piece still reads the same comparison.
      github.moveBase({ repo: APP, number, diff: "diff --git a/b.ts b/b.ts\n+merged since\n" });
      const pieces = [diff.slice(0, kept)];
      let last: Record<string, unknown> = {};
      for (let from = kept; ; from = Number(last.to)) {
        const piece = yield* read(from);
        assert.isTrue(piece.ok, JSON.stringify(piece.value));
        last = piece.value;
        const text = String(last.diff);
        assert.notMatch(text, /[\uD800-\uDBFF]$/);
        pieces.push(text);
        if (Number(last.to) >= Number(last.length)) break;
      }
      assert.strictEqual(last.next, end);
      const whole = pieces.join("");
      assert.isTrue(diff.startsWith(whole));
      if (end === DIFF_NEXT.end) assert.strictEqual(whole, diff);
      else assert.isBelow(whole.length, diff.length);
    }).pipe(Effect.provide(layer));
  },
);

// Each review queued is a turn of the asker's: the daily limit holds per pull request, as
// ChatWake holds it per message, and never for the owner or a co-owner.
it.effect("the daily limit holds per pull request, and never for a co-owner", () => {
  const { github, layer } = harness({ KIN_TEAMMATE_DAILY_TURNS: 3 });
  return Effect.gen(function* () {
    for (const author of ["dev-gh", "arjun-gh"])
      for (let index = 0; index < 3; index++)
        github.openItem({
          repo: APP,
          pull: true,
          author,
          association: "MEMBER",
          title: `${author} change ${index}`,
        });
    const { review, ask, directOf, sql, orgId } = yield* ambermill(github);
    yield* sql`INSERT INTO kin_budget_limits (org_id, limits_json)
      VALUES (${orgId}, ${JSON.stringify({ leadUnits: 1000, workerUnits: 1000 })})`;
    // His message is one turn; two reviews make three, and the third PR is past the limit.
    yield* ask("dev", yield* directOf("dev"), "Review my PRs");
    assert.deepStrictEqual(
      outcomes((yield* review({})).value).map(([, outcome]) => outcome),
      ["queued", "queued", ASK_REFUSAL.limit("Dev Malhotra")],
    );
    yield* ask("arjun", yield* directOf("arjun"), "Review my PRs");
    assert.deepStrictEqual(
      outcomes((yield* review({})).value).map(([, outcome]) => outcome),
      ["queued", "queued", "queued"],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "the watch and an ask hold one review per head, whichever comes first; a cap's hour ends",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const old = github.openItem({
        repo: APP,
        pull: true,
        author: "dev-gh",
        association: "MEMBER",
        title: "Parse invoice dates",
      });
      const { review, ask, directOf, githubEvents, sql, orgId, look, handled } =
        yield* ambermill(github);
      const devChat = yield* directOf("dev");
      // Opened after the watch began, on GitHub's clock as on Kin's.
      const opened = Effect.fn("test.opened")(function* () {
        github.world.now = yield* Clock.currentTimeMillis;
        return github.openItem({
          repo: SITE,
          pull: true,
          author: "dev-gh",
          association: "MEMBER",
          title: "New since the watch began",
        });
      });

      // Watch first: its first look at a new PR reviews this head, and an ask hears so.
      const watchFirst = yield* opened();
      yield* look;
      const watchKey = `review:${SITE}#${watchFirst}`;
      assert.deepStrictEqual(
        (yield* githubEvents).map((event) => event.trigger.key),
        [watchKey],
      );
      yield* ask("dev", devChat, "Review my site PR", { keepQueued: true });
      const sha = headOf(github, SITE, watchFirst);
      assert.deepStrictEqual(outcomes((yield* review({ repo: SITE, number: watchFirst })).value), [
        [`${SITE}#${watchFirst}`, PULL_REFUSAL.underWay],
      ]);
      yield* ask("dev", devChat, "And now?");
      assert.deepStrictEqual(outcomes((yield* review({ repo: SITE, number: watchFirst })).value), [
        [`${SITE}#${watchFirst}`, already(sha)],
      ]);

      // Ask first: the watch's first look then finds that head taken and starts nothing.
      const askFirst = yield* opened();
      yield* ask("dev", devChat, "Review the new one");
      assert.deepStrictEqual(outcomes((yield* review({ repo: SITE, number: askFirst })).value), [
        [`${SITE}#${askFirst}`, "queued"],
      ]);
      yield* look;
      assert.lengthOf(yield* githubEvents, 2);
      assert.deepStrictEqual(yield* handled(`review:${SITE}#${askFirst}`), [
        { outcome: "seen", url: null },
      ]);

      // The queued review is the watch's own: GitHub re-requesting the same head adds nothing.
      yield* ask("dev", devChat, "Check the latest changes to my PRs");
      assert.deepStrictEqual(outcomes((yield* review({ repo: APP })).value), [
        [`${APP}#${old}`, "queued"],
      ]);
      const asked = (yield* githubEvents).at(-1)!;
      const key = asked.trigger.key;
      assert.deepInclude(asked, {
        dedupeKey: `poll:${key}`,
        deliveryId: `poll:${key}`,
        eventName: "review_request",
        provenance: { _tag: "system" },
        askedBy: KinPersonId.make("dev"),
      });
      github.requestReview({ repo: APP, number: old, actor: "dev-gh" });
      yield* look;
      assert.lengthOf(yield* githubEvents, 3);

      // A head the watch's hourly cap stopped: capped for the hour, queued after it.
      github.push({ repo: APP, number: old });
      const capped = `review:${APP}#${old}:${headOf(github, APP, old)}`;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id, outcome, at)
        VALUES (${orgId}, ${capped}, ${APP}, ${old}, ${tech}, 'capped', ${now})`;
      yield* ask("dev", devChat, "Review it again");
      assert.deepStrictEqual(outcomes((yield* review({ repo: APP })).value), [
        [`${APP}#${old}`, PULL_REFUSAL.capped],
      ]);
      yield* TestClock.adjust(60 * 60_000);
      yield* ask("dev", devChat, "And now?");
      assert.deepStrictEqual(outcomes((yield* review({ repo: APP })).value), [
        [`${APP}#${old}`, "queued"],
      ]);
    }).pipe(Effect.provide(layer));
  },
);

// What the asker hears comes from Kin's records of the post, settled by the queue as each review
// ends; the review turn posts only on the pull request asked for, at its head, once.
it.effect(
  "an asked review posts once on its own PR and head, and its end is told from the receipt",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const open = (title: string) =>
        github.openItem({ repo: APP, pull: true, author: "dev-gh", association: "MEMBER", title });
      for (const title of ["Parse invoice dates", "Round the totals", "Close the quarter"])
        open(title);
      const { review, ask, end, runReview, told, handled, directOf, githubEvents, owner, sql } =
        yield* ambermill(github);
      const devChat = yield* directOf("dev");
      // Read as everyone in the chat it answers reads it: a teammate's ask is no owner turn.
      const audienceOf = Effect.fn("test.audienceOf")(function* (eventId: string) {
        const [row] = yield* sql<{ orgId: KinOrgId; wakeupId: string }>`SELECT org_id AS "orgId",
            wakeup_id AS "wakeupId" FROM kin_events WHERE event_id = ${eventId}`;
        return yield* turnAudience({ ...row!, agentId: KinAgentId.make("tech") });
      });
      const ownerChat = yield* directOf(owner.personId);
      const post = (repo: string, number: number) =>
        callAs("tech", "kin_github_review", { repo, number, body: "One nit.", event: "COMMENT" });
      yield* ask("dev", devChat, "Review my PRs");
      assert.deepStrictEqual(
        outcomes((yield* review({ repo: APP })).value).map(([, outcome]) => outcome),
        ["queued", "queued", "queued"],
      );
      // The queue takes equal reviews in event id order.
      const [first, second, third] = (yield* githubEvents).toSorted((a, b) =>
        a.eventId < b.eventId ? -1 : 1,
      );
      const refOf = (number: number) => `${APP}#${number}`;
      const posted = first!.trigger.number;
      const admitted = headOf(github, APP, posted);

      // Posted: only this PR, at the head admitted though Dev pushed since, and only once.
      yield* runReview(first!.eventId);
      assert.strictEqual(yield* audienceOf(first!.eventId), "shared");
      github.push({ repo: APP, number: posted });
      const other = second!.trigger.number;
      assert.strictEqual(
        (yield* post(SITE, posted)).value.message,
        POST_REFUSAL.other(refOf(posted)),
      );
      assert.strictEqual(
        (yield* post(APP, other)).value.message,
        POST_REFUSAL.other(refOf(posted)),
      );
      const done = yield* post(APP, posted);
      assert.isTrue(done.ok, JSON.stringify(done.value));
      assert.strictEqual(
        (yield* post(APP, posted)).value.message,
        POST_REFUSAL.again(refOf(posted)),
      );
      assert.deepStrictEqual(
        github.world.reviews.map((one) => [one.number, one.commit_id]),
        [[posted, admitted]],
      );
      yield* end("completed");
      assert.deepStrictEqual(yield* told(devChat), [
        postedLine(refOf(posted), admitted, String(done.value.url)),
      ]);
      // Nothing blocking: the owner's chat hears nothing of it.
      assert.deepStrictEqual(yield* told(ownerChat), []);

      // Ended with nothing posted: told so, and the head is free for the next ask.
      yield* runReview(second!.eventId);
      yield* end("completed");
      assert.strictEqual((yield* told(devChat)).at(-1), unfinishedLine(refOf(other)));
      assert.deepStrictEqual(yield* handled(second!.trigger.key), [
        { outcome: "unfinished", url: null },
      ]);

      // Posted as a block, then the turn failed: told as posted, not retried, the head reads as
      // reviewed, and the owner, who holds the merge, hears the block in Kin's own words.
      const failed = third!.trigger.number;
      yield* runReview(third!.eventId);
      const went = yield* callAs("tech", "kin_github_review", {
        repo: APP,
        number: failed,
        body: "The quarter closes a day early.",
        event: "REQUEST_CHANGES",
      });
      assert.isTrue(went.ok);
      yield* end("failed");
      assert.strictEqual(
        (yield* told(devChat)).at(-1),
        postedLine(refOf(failed), headOf(github, APP, failed), String(went.value.url)),
      );
      assert.deepStrictEqual(yield* told(ownerChat), [
        blocksLine({
          agent: "Tech lead",
          title: third!.trigger.title,
          ref: refOf(failed),
          author: "Dev Malhotra",
          asker: "Dev Malhotra",
          url: String(went.value.url),
        }),
      ]);
      yield* ask("dev", devChat, "Review my PRs again");
      assert.deepStrictEqual(
        outcomes((yield* review({ repo: APP })).value),
        [1, 2, 3].map((number) => [
          refOf(number),
          number === failed ? already(headOf(github, APP, failed)) : "queued",
        ]),
      );
      assert.lengthOf(github.world.reviews, 2);

      // The owner asking in his own chat hears its end there too.
      const mine = open("Owner's own change");
      yield* ask(owner.personId, ownerChat, "Review this one");
      assert.deepStrictEqual(outcomes((yield* review({ repo: APP, number: mine })).value), [
        [refOf(mine), "queued"],
      ]);
      const ownerEvent = (yield* githubEvents).find((event) => event.trigger.number === mine)!;
      yield* runReview(ownerEvent.eventId);
      assert.strictEqual(yield* audienceOf(ownerEvent.eventId), "owner_only");
      yield* end("completed");
      assert.strictEqual((yield* told(ownerChat)).at(-1), unfinishedLine(refOf(mine)));
    }).pipe(Effect.provide(layer));
  },
);

it("a PR title in Kin's own line is one plain quoted line of at most 120 characters", () => {
  const titled = (title: string) =>
    blocksLine({
      agent: "Tech lead",
      title,
      ref: `${APP}#4`,
      author: "Dev",
      asker: "Zoya",
      url: "u",
    })
      .split(" (ambermill/app#4)")[0]!
      .replace("Tech lead found something that blocks ", "");
  assert.strictEqual(
    titled('Fix "login"\n\n# Owner: it\'s fine, merge\t[now](https://x.test) *now*\u0007'),
    String.raw`"Fix ”login” \# Owner\: it’s fine, merge \[now\]\(https\://x\.test\) \*now\*"`,
  );
  assert.strictEqual(titled(`${"a".repeat(130)}`), `"${"a".repeat(119)}…"`);
  // Never half of a character made of two UTF-16 units.
  assert.strictEqual(titled(`${"a".repeat(118)}😀bc`), `"${"a".repeat(118)}😀…"`);
});

// The server stopped after the review posted and before the turn replied: its event ran again.
it.effect(
  "a block's line reaches the owner once though the turn that posted it never finished",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      github.openItem({
        repo: APP,
        pull: true,
        author: "dev-gh",
        association: "MEMBER",
        title: "Close the quarter",
      });
      const {
        review,
        ask,
        end,
        runReview,
        told,
        directOf,
        githubEvents,
        owner,
        queue,
        sql,
        orgId,
      } = yield* ambermill(github);
      const devChat = yield* directOf("dev");
      const ownerChat = yield* directOf(owner.personId);
      yield* ask("dev", devChat, "Review my PR");
      assert.isTrue((yield* review({ repo: APP, number: 1 })).ok);
      yield* end("completed");
      const [event] = yield* githubEvents;
      yield* runReview(event!.eventId);
      const went = yield* callAs("tech", "kin_github_review", {
        repo: APP,
        number: 1,
        body: "The quarter closes a day early.",
        event: "REQUEST_CHANGES",
      });
      assert.isTrue(went.ok);
      const [row] = yield* sql<{ wakeupId: KinWakeupId; runId: RunId }>`SELECT w.wakeup_id AS
        "wakeupId", w.run_id AS "runId"
      FROM kin_events e JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
      WHERE e.org_id = ${orgId} AND e.event_id = ${event!.eventId}`;
      yield* (yield* Orchestrator.OrchestratorV2).dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("interrupt:restart"),
        threadId: ThreadId.make("tech-thread"),
        runId: row!.runId,
      });
      assert.strictEqual(yield* queue.requeueUnfinished(orgId, row!.wakeupId), 1);
      assert.deepStrictEqual(yield* told(ownerChat), []);
      yield* runReview(event!.eventId);
      yield* end("completed");
      assert.deepStrictEqual(yield* told(ownerChat), [
        blocksLine({
          agent: "Tech lead",
          title: "Close the quarter",
          ref: `${APP}#1`,
          author: "Dev Malhotra",
          asker: "Dev Malhotra",
          url: String(went.value.url),
        }),
      ]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a turn Kin woke by itself posts no review; the owner's own ask in his chat does", () => {
  const { github, layer } = harness();
  return Effect.gen(function* () {
    github.openItem({
      repo: APP,
      pull: true,
      author: "dev-gh",
      association: "MEMBER",
      title: "Parse invoice dates",
    });
    const { ask, end, runReview, directOf, owner, queue, sql, orgId } = yield* ambermill(github);
    const post = callAs("tech", "kin_github_review", {
      repo: APP,
      number: 1,
      body: "One nit.",
      event: "COMMENT",
    });
    yield* sql`UPDATE kin_events SET state = 'done'
      WHERE org_id = ${orgId} AND tag = 'github' AND state = 'queued'`;
    const { event } = yield* queue.enqueue({
      _tag: "pulse",
      orgId,
      eventId: KinEventId.make("pulse-own"),
      agentId: tech,
      receivedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
      dedupeKey: "pulse-own",
      provenance: { _tag: "system" },
      factKeys: ["task_stuck:W-1"],
    });
    yield* runReview(event.eventId);
    const refused = yield* post;
    assert.isFalse(refused.ok);
    assert.strictEqual(refused.value.message, KIN_OWN_REFUSAL.review);
    assert.lengthOf(github.world.reviews, 0);
    yield* end("completed");

    yield* ask(owner.personId, yield* directOf(owner.personId), "Post your review of #1");
    const posted = yield* post;
    assert.isTrue(posted.ok, JSON.stringify(posted.value));
    assert.lengthOf(github.world.reviews, 1);
  }).pipe(Effect.provide(layer));
});

// Restricting the pair, closing the chat or removing the person ends a review still waiting, as
// it ends their waiting messages: nothing runs and nothing posts. One already running ends unheard.
it.effect(
  "an asked review still waiting expires when the chat closes or the person is removed",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      for (const title of ["One", "Two", "Three"])
        github.openItem({ repo: APP, pull: true, author: "dev-gh", association: "MEMBER", title });
      const { review, ask, end, runReview, told, directOf, githubEvents, sql, orgId, owner } =
        yield* ambermill(github);
      const devChat = yield* directOf("dev");
      yield* ask("dev", devChat, "Review my first PR");
      assert.isTrue((yield* review({ repo: APP, number: 1 })).ok);
      yield* end("completed");
      const state = (eventId: string) =>
        sql<{ state: string }>`SELECT state FROM kin_events
        WHERE org_id = ${orgId} AND event_id = ${eventId}`.pipe(
          Effect.map((rows) => rows[0]?.state),
        );
      const [closed] = yield* githubEvents;
      yield* LeadAccess.dropQueued({ orgId, agentId: tech }, devChat);
      assert.strictEqual(yield* state(closed!.eventId), "expired");

      // Restricted while its turn ran: the turn's end tells Dev's chat nothing.
      yield* ask("dev", devChat, "Review my third PR");
      assert.isTrue((yield* review({ repo: APP, number: 3 })).ok);
      yield* runReview((yield* githubEvents).at(-1)!.eventId);
      yield* Reach.setLimit({
        orgId,
        by: owner.personId,
        a: Reach.person(KinPersonId.make("dev")),
        b: Reach.agent(tech),
        restricted: true,
      });
      yield* end("completed");
      assert.deepStrictEqual(yield* told(devChat), []);
      yield* Reach.setLimit({
        orgId,
        by: owner.personId,
        a: Reach.person(KinPersonId.make("dev")),
        b: Reach.agent(tech),
        restricted: false,
      });

      yield* ask("dev", devChat, "Review my second PR");
      assert.isTrue((yield* review({ repo: APP, number: 2 })).ok);
      yield* end("completed");
      const removed = (yield* githubEvents).at(-1)!;
      yield* onPersonRemoved({ orgId, personId: "dev" });
      assert.strictEqual(yield* state(removed.eventId), "expired");
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "after an asked review posts, new commits get one re-review that posts against the new head",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      for (const title of ["Parse invoice dates", "Round the totals"])
        github.openItem({ repo: APP, pull: true, author: "dev-gh", association: "MEMBER", title });
      const { review, ask, end, runReview, look, directOf, githubEvents, handled } =
        yield* ambermill(github);
      const devChat = yield* directOf("dev");
      const post = (number: number) =>
        callAs("tech", "kin_github_review", {
          repo: APP,
          number,
          body: "One nit.",
          event: "COMMENT",
        });
      yield* ask("dev", devChat, "Review my first PR");
      assert.isTrue((yield* review({ repo: APP, number: 1 })).ok);
      const admitted = headOf(github, APP, 1);
      yield* runReview((yield* githubEvents).at(-1)!.eventId);
      assert.isTrue((yield* post(1)).ok);
      yield* end("completed");

      const head = github.push({ repo: APP, number: 1, diff: "+rounding fixed\n" });
      for (let minute = 0; minute < 5; minute++) yield* look;
      const again = (yield* githubEvents).at(-1)!;
      assert.strictEqual(again.trigger.key, headKey(APP, 1, head));
      assert.deepStrictEqual(again.trigger.pull?.reReview, { from: admitted, whole: false });
      assert.isUndefined(again.askedBy);

      yield* runReview(again.eventId);
      const done = yield* post(1);
      assert.isTrue(done.ok, JSON.stringify(done.value));
      assert.strictEqual((yield* post(1)).value.message, POST_REFUSAL.again(`${APP}#1`));
      // Another PR in the same turn posts as the watch's own reviews do, unbound.
      assert.isTrue((yield* post(2)).ok);
      assert.deepStrictEqual(
        github.world.reviews.map((one) => [one.number, one.commit_id]),
        [
          [1, admitted],
          [1, head],
          [2, undefined],
        ],
      );
      assert.deepStrictEqual(yield* handled(again.trigger.key), [
        { outcome: "woke", url: String(done.value.url) },
      ]);
      yield* end("completed");
      for (let minute = 0; minute < 6; minute++) yield* look;
      assert.strictEqual((yield* githubEvents).at(-1)!.eventId, again.eventId);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "an outsider's pull request is reviewed once per head, only there and as a comment; only GitHub's refusal frees the head",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const { end, runReview, look, githubEvents, handled, told, sql, orgId } =
        yield* ambermill(github);
      // Opened after the watch began, so each is new to it.
      github.tick(120_000);
      const pulls = ["Fix a typo", "Tidy the readme"].map((title) =>
        github.openItem({ repo: APP, pull: true, author: "passer-by", association: "NONE", title }),
      );
      yield* look;
      const [ownerChat] = yield* sql<{ chatId: KinChatId }>`SELECT owner_chat_id AS "chatId"
        FROM kin_leads WHERE org_id = ${orgId} AND agent_id = ${tech}`;
      const post = (number: number, event = "COMMENT") =>
        callAs("tech", "kin_github_review", { repo: APP, number, body: "Reads well.", event });
      const reviewsPath = (number: number) => `repos/${APP}/pulls/${number}/reviews`;
      const [first, second] = yield* githubEvents;
      assert.deepStrictEqual(
        [first, second].map((event) => [event!.trigger.number, event!.trigger.inside]),
        pulls.map((number) => [number, false]),
      );

      // The first: another PR posts nothing; no answer keeps the head.
      yield* runReview(first!.eventId);
      const ref = `${APP}#${pulls[0]}`;
      assert.strictEqual((yield* post(pulls[1]!)).value.message, POST_REFUSAL.only(ref));
      github.world.failing = [reviewsPath(pulls[0]!)];
      assert.strictEqual((yield* post(pulls[0]!)).value.message, POST_REFUSAL.unknown(ref));
      github.world.failing = [];
      assert.strictEqual((yield* post(pulls[0]!)).value.message, POST_REFUSAL.unsure(ref));
      const firstHead = headKey(APP, pulls[0]!, headOf(github, APP, pulls[0]!));
      assert.deepStrictEqual(yield* handled(firstHead), [{ outcome: "head", url: POSTING }]);
      yield* end("failed");

      // The second: GitHub's refusal gives the head back, and the post goes on that head, a block
      // posted as a comment.
      yield* runReview(second!.eventId);
      github.world.refusing = [reviewsPath(pulls[1]!)];
      assert.isFalse((yield* post(pulls[1]!, "REQUEST_CHANGES")).ok);
      github.world.refusing = [];
      const done = yield* post(pulls[1]!, "REQUEST_CHANGES");
      assert.isTrue(done.ok, JSON.stringify(done.value));
      yield* end("completed");
      assert.deepStrictEqual(
        github.world.reviews.map((one) => [one.number, one.event, one.commit_id]),
        [[pulls[1], "COMMENT", headOf(github, APP, pulls[1]!)]],
      );
      // The owner hears it from Kin's records, whatever the model wrote: the block, and the post
      // GitHub never confirmed.
      const ownerHeard = [
        outsideLine(ref, { _tag: "unknown" }, `https://github.com/${APP}/pull/${pulls[0]}`),
        outsideBlocksLine({
          agent: "Tech lead",
          title: "Tidy the readme",
          ref: `${APP}#${pulls[1]}`,
          author: "passer-by",
          url: String(done.value.url),
        }),
      ];
      assert.deepStrictEqual(yield* told(ownerChat!.chatId), ownerHeard);

      // New commits on the reviewed one: its re-review is the same seat, bound the same way.
      const moved = github.push({ repo: APP, number: pulls[1]!, diff: "+a second line\n" });
      for (let minute = 0; minute < 6; minute++) yield* look;
      const again = (yield* githubEvents).at(-1)!;
      assert.include(again.trigger, { key: headKey(APP, pulls[1]!, moved), inside: false });
      yield* runReview(again.eventId);
      assert.strictEqual(
        (yield* post(pulls[0]!)).value.message,
        POST_REFUSAL.only(`${APP}#${pulls[1]}`),
      );
      assert.isTrue((yield* post(pulls[1]!)).ok);
      assert.strictEqual(github.world.reviews.at(-1)?.commit_id, moved);
      assert.lengthOf(github.world.reviews, 2);
      // Nothing blocking: the owner hears nothing more.
      yield* end("completed");
      assert.deepStrictEqual(yield* told(ownerChat!.chatId), ownerHeard);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "an asked review of an outsider's pull request is told to the asker, and a block to the owner",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const { review, ask, end, runReview, told, directOf, githubEvents, owner, sql, orgId } =
        yield* ambermill(github);
      github.tick(120_000);
      const [clean, blocked] = ["Fix a typo", "Tidy the readme"].map((title) =>
        github.openItem({ repo: APP, pull: true, author: "passer-by", association: "NONE", title }),
      );
      const devChat = yield* directOf("dev");
      const ownerChat = yield* directOf(owner.personId);
      const post = (number: number, event: string) =>
        callAs("tech", "kin_github_review", { repo: APP, number, body: "Reads well.", event });
      const run = Effect.fn("test.runAsked")(function* (number: number, event: string) {
        yield* ask("dev", devChat, `Review #${number}`);
        assert.isTrue((yield* review({ repo: APP, number })).ok);
        yield* end("completed");
        const asked = (yield* githubEvents).find(
          (one) => one.trigger.number === number && one.askedBy !== undefined,
        )!;
        yield* runReview(asked.eventId);
        const [turn] = yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
          FROM kin_events WHERE org_id = ${orgId} AND event_id = ${asked.eventId}`;
        const lane = yield* laneFor({ orgId, agentId: tech, wakeupId: turn!.wakeupId });
        // The agent's own line answers in Dev's chat, not nowhere.
        assert.deepInclude(Option.getOrThrow(lane), { chatId: devChat, mode: "notice" });
        assert.isUndefined(Option.getOrThrow(lane).quiet);
        const done = yield* post(number, event);
        assert.isTrue(done.ok, JSON.stringify(done.value));
        yield* end("completed");
        return String(done.value.url);
      });

      const cleanUrl = yield* run(clean!, "COMMENT");
      assert.deepStrictEqual(yield* told(devChat), [
        postedLine(`${APP}#${clean}`, headOf(github, APP, clean!), cleanUrl),
      ]);
      assert.deepStrictEqual(yield* told(ownerChat), []);

      const blockedUrl = yield* run(blocked!, "REQUEST_CHANGES");
      assert.strictEqual(github.world.reviews.at(-1)?.event, "COMMENT");
      assert.strictEqual(
        (yield* told(devChat)).at(-1),
        postedLine(`${APP}#${blocked}`, headOf(github, APP, blocked!), blockedUrl),
      );
      assert.deepStrictEqual(yield* told(ownerChat), [
        blocksLine({
          agent: "Tech lead",
          title: "Tidy the readme",
          ref: `${APP}#${blocked}`,
          author: "passer-by",
          asker: "Dev Malhotra",
          url: blockedUrl,
        }),
      ]);
    }).pipe(Effect.provide(layer));
  },
);

// Queued before asked reviews carried the asker's chat: the claim finds it, or ends the review.
it.effect("an asked review queued without its chat answers the asker's, or ends unheard", () => {
  const { github, layer } = harness();
  return Effect.gen(function* () {
    for (const title of ["Parse invoice dates", "Round the totals"])
      github.openItem({ repo: APP, pull: true, author: "dev-gh", association: "MEMBER", title });
    const { review, ask, end, runReview, told, directOf, githubEvents, owner, sql, orgId } =
      yield* ambermill(github);
    const devChat = yield* directOf("dev");
    const ownerChat = yield* directOf(owner.personId);
    yield* ask("dev", devChat, "Review my PRs");
    assert.isTrue((yield* review({ repo: APP })).ok);
    yield* end("completed");
    const [found, gone] = (yield* githubEvents).toSorted((a, b) =>
      a.eventId < b.eventId ? -1 : 1,
    );
    yield* sql`UPDATE kin_events SET json = json_remove(json, '$.chatId', '$.askedIn')
      WHERE org_id = ${orgId} AND tag = 'github'`;
    // Asked by someone with no chat with the agent any more.
    yield* sql`UPDATE kin_events SET json = json_set(json, '$.askedBy', 'meera')
      WHERE org_id = ${orgId} AND event_id = ${gone!.eventId}`;
    yield* runReview(found!.eventId);
    const [row] = yield* sql<{ wakeupId: KinWakeupId; chatId: string | null }>`SELECT
        wakeup_id AS "wakeupId", json_extract(json, '$.chatId') AS "chatId"
      FROM kin_events WHERE org_id = ${orgId} AND event_id = ${found!.eventId}`;
    assert.strictEqual(row!.chatId, devChat);
    assert.deepInclude(
      Option.getOrThrow(yield* laneFor({ orgId, agentId: tech, wakeupId: row!.wakeupId })),
      { chatId: devChat },
    );
    yield* end("completed");
    const [ended] = yield* sql<{ state: string; wakeupId: string | null }>`SELECT state,
        wakeup_id AS "wakeupId" FROM kin_events WHERE org_id = ${orgId} AND event_id = ${gone!.eventId}`;
    assert.deepStrictEqual(ended, { state: "expired", wakeupId: null });
    assert.deepStrictEqual(yield* told(ownerChat), []);
    assert.lengthOf(yield* told(devChat), 1);
  }).pipe(Effect.provide(layer));
});

// GitHub's rate limit mid-ask: what it refused is said as refused, never as missing.
it.effect(
  "GitHub refusing the third of five reads: two queue, three are told as refused for now",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      for (let index = 0; index < 5; index++)
        github.openItem({
          repo: APP,
          pull: true,
          author: "dev-gh",
          association: "MEMBER",
          title: `Change ${index}`,
        });
      const { review, ask, directOf } = yield* ambermill(github);
      yield* ask("dev", yield* directOf("dev"), "Review my PRs");
      github.world.limit = { reads: 2, retryAfter: 600 };
      const answer = (yield* review({ repo: APP })).value;
      const told = outcomes(answer);
      assert.deepStrictEqual(
        told.map(([, outcome]) => outcome),
        ["queued", "queued", ...Array<string>(3).fill(PULL_REFUSAL.refused)],
      );
      const refusedRefs = told.slice(2).map(([ref]) => ref);
      assert.include(
        String(answer.next),
        ` GitHub refused Kin's requests for now, so ${refusedRefs.join(", ")} weren't queued; GitHub takes requests again in about 10 minutes`,
      );
    }).pipe(Effect.provide(layer));
  },
);

// A teammate asked the Tech lead how a product works; the turn could not open the code and sent
// them to the owner. A repo is read through Kin's GitHub connection, by the review ask's own check.
it.effect(
  "a repo is read for whoever GitHub lets see it: a folder, a file whole or by lines, a search, at a ref; everything else is its one line",
  () => {
    const { github, layer } = harness({}, { app: true });
    return Effect.gen(function* () {
      const late = "export const lateAfter = (eta: number) => eta + 15 * 60_000;\n";
      const long = Array.from({ length: 3000 }, (_, index) => `const line${index} = ${index};`);
      const huge = `${"x".repeat(99)}\n`.repeat(12_000);
      const retry =
        "export const retry = { attempts: 3 }; // retry:3\nexport const wait = (): Promise<void> => Promise.resolve();\n";
      const repoOf = (name: string) => github.world.repos.find((one) => one.full_name === name)!;
      const pull = github.openItem({
        repo: APP,
        pull: true,
        author: "dev-gh",
        association: "MEMBER",
        title: "Alert sooner",
      });
      repoOf(APP).files = {
        main: {
          "README.md": "# App\n",
          "src/alerts/late.ts": late,
          "src/retry.ts": retry,
          "src/oneline.js": `${"x".repeat(DIFF_CAP + 5_000)}\n`,
          "src/long.ts": `${long.join("\n")}\n`,
          "src/huge.txt": huge,
          "logo.png": "\u0089PNG\r\n\u001a\n\u0000\u0000",
        },
        "release/1": { "src/alerts/late.ts": "export const lateAfter = () => 0;\n" },
        [headOf(github, APP, pull)]: {
          "src/alerts/late.ts": "export const lateAfter = () => 1;\n",
        },
      };
      repoOf(LEDGER).files = { main: { "totals.ts": "export const round = Math.round;\n" } };
      const page = "<h1>Late alerts</h1>\n";
      repoOf(SITE).files = {
        main: {
          "index.html": page,
          // A folder whose listing is larger than one answer Kin reads.
          ...Object.fromEntries(
            Array.from({ length: 25_000 }, (_, index) => [`gen/f${index}.ts`, ""]),
          ),
        },
      };
      repoOf(SITE).links = {
        "latest.html": { type: "symlink", target: "index.html" },
        lib: { type: "submodule" },
      };
      repoOf(SITE).unindexed = true;
      // Kin's memory repo, as GitHub also answers it under another name, by the same id.
      repoOf(MEMORY).id = 77;
      github.addRepo({ full_name: NOTES, private: true, id: 77 });
      github.addRepo({ full_name: MOVED, private: false, movedTo: APP });
      const { ask, directOf, sql, orgId, owner, review, runReview, githubEvents } =
        yield* ambermill(github);
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES ('room', ${orgId}, 'team_group', 0, ${at})`;
      for (const [member, kind, person, agent] of [
        ["room-dev", "person", "dev", null],
        ["room-meera", "person", "meera", null],
        ["room-tech", "agent", null, "tech"],
      ] as const)
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            person_id, agent_id, role, joined_at)
          VALUES (${member}, ${orgId}, 'room', ${kind}, ${person}, ${agent}, 'member', ${at})`;
      const chatOf = {
        dev: yield* directOf("dev"),
        zoya: yield* directOf("zoya"),
        meera: yield* directOf("meera"),
        owner: yield* directOf(owner.personId),
        room: KinChatId.make("room"),
      };
      const read = (args: Record<string, unknown>) => callAs("tech", "kin_github_read", args);
      const running = sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
        FROM kin_wakeups WHERE org_id = ${orgId} AND agent_id = 'tech' AND status = 'running'
        ORDER BY rowid DESC LIMIT 1`.pipe(Effect.map(([row]) => row!.wakeupId));
      const refusal = (message: string, reason = "not_allowed") => ({
        _tag: "KinChatError",
        reason,
        message,
      });
      const longPage = (from: number) => {
        let to = from - 1;
        let size = 0;
        while (to < long.length && size + long[to]!.length + 1 <= DIFF_CAP)
          size += long[to++]!.length + 1;
        return { to, text: long.slice(from - 1, to).join("\n") };
      };
      const first = longPage(1);
      const second = longPage(first.to + 1);
      const byLogin = (from: number) =>
        github.requests.slice(from).filter((request) => request.by === "login");

      // Without Kin's GitHub App nothing is read, and nothing asks GitHub as the owner's login.
      yield* ask("zoya", chatOf.zoya, "Read without the App");
      const unasked = github.requests.length;
      assert.deepStrictEqual(
        (yield* read({ repo: APP, path: "README.md" })).value,
        refusal(READ_REFUSAL.noApp),
      );
      assert.deepStrictEqual(github.requests.slice(unasked), []);
      const installation = {
        id: 7,
        account: "ambermill",
        repos: [APP, SITE, LEDGER, MEMORY, NOTES, MOVED],
        permissions: { contents: "read", metadata: "read", pull_requests: "read" },
      };
      installApp(github, [installation]);
      yield* (yield* KinGitHubApp).refresh();

      const table: ReadonlyArray<{
        readonly name: string;
        readonly who: keyof typeof chatOf;
        readonly args: Record<string, unknown>;
        readonly ownerOnly?: true;
        readonly before?: (now: number) => void;
        readonly after?: () => void;
        /** As each call reaches GitHub during the read. */
        readonly during?: (call: string) => void;
        readonly answer?: Record<string, unknown>;
        readonly refused?: Record<string, unknown>;
        /** No call reached GitHub's collaborator reads. */
        readonly unchecked?: true;
      }> = [
        {
          name: "a teammate lists the top of a public repo",
          who: "zoya",
          args: { repo: APP },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "",
            entries: [
              { path: "logo.png", type: "file", size: 11 },
              { path: "README.md", type: "file", size: 6 },
              { path: "src", type: "dir" },
            ],
            next: READ_NEXT.listed,
          },
        },
        {
          name: "a folder",
          who: "zoya",
          args: { repo: APP.toUpperCase(), path: "/src/alerts/" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/alerts",
            entries: [{ path: "src/alerts/late.ts", type: "file", size: late.length }],
            next: READ_NEXT.listed,
          },
        },
        {
          name: "a small file, whole",
          who: "zoya",
          args: { repo: APP, path: "src/alerts/late.ts" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/alerts/late.ts",
            text: late,
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "a long file's first part, saying how many lines and where to go on",
          who: "zoya",
          args: { repo: APP, path: "src/long.ts" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/long.ts",
            text: first.text,
            lines: { from: 1, to: first.to, of: 3000 },
            next: READ_NEXT.more(first.to + 1, 3000),
          },
        },
        {
          name: "and on from that line",
          who: "zoya",
          args: { repo: APP, path: "src/long.ts", line: first.to + 1 },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/long.ts",
            text: second.text,
            lines: { from: first.to + 1, to: second.to, of: 3000 },
            next: second.to < 3000 ? READ_NEXT.more(second.to + 1, 3000) : READ_NEXT.end,
          },
        },
        {
          name: "a line past the end",
          who: "zoya",
          args: { repo: APP, path: "src/long.ts", line: 4000 },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/long.ts",
            text: "",
            lines: { from: 4000, to: 3000, of: 3000 },
            next: READ_NEXT.past(3000),
          },
        },
        {
          name: "a binary file is said plainly, none of its bytes",
          who: "zoya",
          args: { repo: APP, path: "logo.png" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "logo.png",
            next: READ_REFUSAL.binary("logo.png", 11),
          },
        },
        {
          name: "at a branch",
          who: "zoya",
          args: { repo: APP, path: "src/alerts/late.ts", ref: "release/1" },
          answer: {
            repo: APP,
            ref: "release/1",
            path: "src/alerts/late.ts",
            text: "export const lateAfter = () => 0;\n",
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "at a pull request's head",
          who: "zoya",
          args: { repo: APP, path: "src/alerts/late.ts", ref: `pull/${pull}` },
          answer: {
            repo: APP,
            ref: `pull/${pull}`,
            path: "src/alerts/late.ts",
            text: "export const lateAfter = () => 1;\n",
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "a pull request that isn't there",
          who: "zoya",
          args: { repo: APP, path: "README.md", ref: "pull/999" },
          refused: refusal(READ_REFUSAL.noPull(APP, 999), "not_found"),
        },
        {
          name: "a path that isn't there",
          who: "zoya",
          args: { repo: APP, path: "src/nowhere.ts" },
          refused: refusal(
            READ_REFUSAL.missing(APP, "src/nowhere.ts", "the default branch"),
            "not_found",
          ),
        },
        {
          name: "a path that climbs out",
          who: "zoya",
          args: { repo: APP, path: "src/../../other" },
          refused: refusal(READ_REFUSAL.path),
        },
        {
          name: "a search, scoped to the repo",
          who: "zoya",
          args: { repo: APP, search: "lateAfter  eta" },
          answer: {
            repo: APP,
            ref: "the default branch",
            matches: [{ path: "src/alerts/late.ts", fragments: [late.trimEnd()] }],
            next: READ_NEXT.found,
          },
        },
        {
          name: "a folder with a symlink and a submodule, each named as what it is",
          who: "zoya",
          args: { repo: SITE },
          answer: {
            repo: SITE,
            ref: "the default branch",
            path: "",
            entries: [
              { path: "gen", type: "dir" },
              { path: "index.html", type: "file", size: page.length },
              { path: "latest.html", type: "symlink" },
              { path: "lib", type: "submodule" },
            ],
            next: READ_NEXT.listed,
          },
        },
        {
          name: "a symlink GitHub follows to a file is named, not followed",
          who: "zoya",
          args: { repo: SITE, path: "latest.html" },
          answer: {
            repo: SITE,
            ref: "the default branch",
            path: "latest.html",
            next: READ_REFUSAL.link("latest.html", "index.html"),
          },
        },
        {
          name: "a submodule",
          who: "zoya",
          args: { repo: SITE, path: "lib" },
          answer: {
            repo: SITE,
            ref: "the default branch",
            path: "lib",
            next: READ_REFUSAL.other("lib", "submodule"),
          },
        },
        {
          name: "a folder larger than one answer is said to be, not GitHub out of reach",
          who: "zoya",
          args: { repo: SITE, path: "gen" },
          refused: refusal(READ_REFUSAL.tooLarge("gen"), "unavailable"),
        },
        {
          name: "one line longer than an answer holds says its tail can't be read",
          who: "zoya",
          args: { repo: APP, path: "src/oneline.js" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "src/oneline.js",
            text: `${"x".repeat(DIFF_CAP)}…[this line goes on past what one answer holds]`,
            lines: { from: 1, to: 1, of: 1 },
            next: `${READ_NEXT.tail(1)} ${READ_NEXT.end}`,
          },
        },
        {
          name: "code that reads like a qualifier is searched as words",
          who: "zoya",
          args: { repo: APP, search: "retry:3" },
          answer: {
            repo: APP,
            ref: "the default branch",
            matches: [{ path: "src/retry.ts", fragments: [retry.split("\n")[0]] }],
            next: READ_NEXT.found,
          },
        },
        {
          name: "a type is searched as written",
          who: "zoya",
          args: { repo: APP, search: "Promise<void>" },
          answer: {
            repo: APP,
            ref: "the default branch",
            matches: [{ path: "src/retry.ts", fragments: [retry.split("\n")[1]] }],
            next: READ_NEXT.found,
          },
        },
        {
          name: "words naming another repo search only this one",
          who: "zoya",
          args: { repo: APP, search: `repo:${LEDGER} round` },
          answer: {
            repo: APP,
            ref: "the default branch",
            matches: [],
            next: READ_NEXT.none(APP, `repo:${LEDGER} round`),
          },
        },
        {
          name: "a hit from another repo in GitHub's answer is dropped, and the search not trusted",
          who: "zoya",
          args: { repo: APP, search: "round" },
          before: () => {
            github.world.searchLeak = LEDGER;
          },
          after: () => {
            delete github.world.searchLeak;
          },
          answer: {
            repo: APP,
            ref: "the default branch",
            matches: [],
            next: READ_NEXT.untrusted(APP),
          },
        },
        {
          name: "a search GitHub hasn't indexed the repo for",
          who: "zoya",
          args: { repo: SITE, search: "late" },
          answer: {
            repo: SITE,
            ref: "the default branch",
            matches: [],
            next: READ_NEXT.none(SITE, "late"),
          },
        },
        {
          name: "a search at a ref",
          who: "zoya",
          args: { repo: APP, search: "late", ref: "release/1" },
          refused: refusal(READ_REFUSAL.searchRef),
          unchecked: true,
        },
        {
          name: "words GitHub can't take as a search, told apart from a repo not indexed",
          who: "zoya",
          args: { repo: APP, search: "late" },
          before: () => {
            github.world.refusing = ["search/code"];
          },
          after: () => {
            delete github.world.refusing;
          },
          refused: refusal(READ_REFUSAL.badSearch),
        },
        {
          name: "a path with a lone surrogate",
          who: "zoya",
          args: { repo: APP, path: "src/\uD800.ts" },
          refused: refusal(READ_REFUSAL.malformed),
          unchecked: true,
        },
        {
          name: "a path longer than Kin sends",
          who: "zoya",
          args: { repo: APP, path: "a/".repeat(600) },
          refused: refusal(READ_REFUSAL.tooLong),
          unchecked: true,
        },
        {
          name: "a repo the connection doesn't reach",
          who: "zoya",
          args: { repo: "elsewhere/tool" },
          refused: refusal(READ_REFUSAL.unreached("elsewhere/tool")),
          unchecked: true,
        },
        {
          name: "Kin's memory repo",
          who: "dev",
          args: { repo: MEMORY },
          refused: refusal(READ_REFUSAL.memory(MEMORY)),
          unchecked: true,
        },
        {
          name: "Kin's memory repo under another name, by its id",
          who: "owner",
          ownerOnly: true,
          args: { repo: NOTES },
          refused: refusal(READ_REFUSAL.memory(NOTES)),
          unchecked: true,
        },
        {
          name: "a repo taken off the App a moment ago, which the owner's own login still reads",
          who: "zoya",
          args: { repo: SITE, path: "index.html" },
          before: () => {
            installation.repos = installation.repos.filter((name) => name !== SITE);
          },
          after: () => {
            installation.repos.push(SITE);
          },
          refused: refusal(READ_REFUSAL.unreached(SITE)),
          unchecked: true,
        },
        {
          name: "a repo GitHub says has moved, whose redirect Kin doesn't follow",
          who: "zoya",
          args: { repo: MOVED, path: "README.md" },
          refused: refusal(READ_REFUSAL.moved(MOVED)),
          unchecked: true,
        },
        {
          name: "a private repo for a collaborator",
          who: "dev",
          args: { repo: LEDGER, path: "totals.ts" },
          answer: {
            repo: LEDGER,
            ref: "the default branch",
            path: "totals.ts",
            text: "export const round = Math.round;\n",
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "a collaborator taken off the private repo while the file was read",
          who: "dev",
          args: { repo: LEDGER, path: "totals.ts" },
          during: (call) => {
            if (call === `GET repos/${LEDGER}/contents/totals.ts`)
              repoOf(LEDGER).collaborators = [];
          },
          after: () => {
            repoOf(LEDGER).collaborators = ["dev-gh"];
          },
          refused: refusal(READ_REFUSAL.notCollaborator(LEDGER, "Dev Malhotra")),
        },
        {
          name: "a repo taken off the App while the file was read",
          who: "zoya",
          args: { repo: APP, path: "README.md" },
          during: (call) => {
            if (call === `GET repos/${APP}/contents/README.md`)
              installation.repos = installation.repos.filter((name) => name !== APP);
          },
          after: () => {
            installation.repos.push(APP);
          },
          refused: refusal(READ_REFUSAL.unreached(APP)),
        },
        {
          name: "a private repo GitHub doesn't let her see",
          who: "meera",
          args: { repo: LEDGER, path: "totals.ts" },
          refused: refusal(READ_REFUSAL.notCollaborator(LEDGER, "Meera Iyer")),
        },
        {
          name: "a private repo, no GitHub username on file",
          who: "zoya",
          args: { repo: LEDGER, search: "round" },
          refused: refusal(READ_REFUSAL.noLogin(LEDGER, "Zoya Sheikh")),
        },
        {
          name: "a private repo in a chat with other people, a collaborator asking",
          who: "room",
          args: { repo: LEDGER, path: "totals.ts" },
          refused: refusal(READ_REFUSAL.notHere(LEDGER)),
        },
        {
          name: "a public repo in that chat",
          who: "room",
          args: { repo: APP, path: "README.md" },
          answer: {
            repo: APP,
            ref: "the default branch",
            path: "README.md",
            text: "# App\n",
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "the owner alone reads any repo the App is on, with no collaborator check",
          who: "owner",
          ownerOnly: true,
          args: { repo: LEDGER, path: "totals.ts" },
          unchecked: true,
          answer: {
            repo: LEDGER,
            ref: "the default branch",
            path: "totals.ts",
            text: "export const round = Math.round;\n",
            lines: { from: 1, to: 1, of: 1 },
            next: READ_NEXT.end,
          },
        },
        {
          name: "GitHub's 429",
          who: "zoya",
          args: { repo: APP, path: "README.md" },
          before: () => {
            github.world.limit = { reads: 0, retryAfter: 600, hit: true };
          },
          refused: refusal(READ_REFUSAL.refused(10), "unavailable"),
        },
        {
          name: "GitHub's 403, by its reset time",
          who: "owner",
          ownerOnly: true,
          args: { repo: APP, search: "late" },
          before: (now) => {
            github.world.limit = {
              reads: 0,
              retryAfter: 0,
              hit: true,
              status: 403,
              reset: Math.floor((now + 30 * 60_000) / 1000),
            };
          },
          refused: refusal(READ_REFUSAL.refused(30), "unavailable"),
        },
      ];
      const before = github.world.calls.length;
      for (const row of table) {
        delete github.world.limit;
        row.before?.(yield* Clock.currentTimeMillis);
        const limit = github.world.limit;
        delete github.world.limit;
        const asker = row.who === "room" ? "dev" : row.who === "owner" ? owner.personId : row.who;
        yield* ask(asker, chatOf[row.who], `Read (${row.name})`);
        const turn = { orgId, wakeupId: yield* running };
        if (row.ownerOnly === true) yield* recordAudience(turn, "owner_only");
        if (limit !== undefined) github.world.limit = limit;
        const calls = github.world.calls.length;
        const requests = github.requests.length;
        github.onRequest = row.during;
        const called = yield* read(row.args);
        github.onRequest = undefined;
        row.after?.();
        const checked = github.world.calls
          .slice(calls)
          .filter((call) => /^GET repos\/[^/]+\/[^/]+\/collaborators\//.test(call));
        if (row.unchecked === true) assert.deepStrictEqual(checked, [], row.name);
        assert.deepStrictEqual(byLogin(requests), [], row.name);
        const stamp = yield* outsideStamp(turn);
        if (row.refused !== undefined) {
          assert.deepStrictEqual(called.value, row.refused, row.name);
          assert.strictEqual(stamp, undefined, row.name);
          continue;
        }
        assert.deepStrictEqual(called.value, row.answer, row.name);
        // What the repo said is outside text for the rest of the turn, as a diff is.
        const shown =
          row.answer?.text !== undefined ||
          row.answer?.entries !== undefined ||
          row.answer?.matches !== undefined;
        assert.strictEqual(
          stamp === undefined ? undefined : stampKey(stamp),
          shown ? "github" : undefined,
          row.name,
        );
      }
      delete github.world.limit;
      // A file over GitHub's 1 MB comes raw, and gh's output stops at Kin's limit: said, not hidden.
      yield* ask("zoya", chatOf.zoya, "Read the huge file");
      const hugeRead = (yield* read({ repo: APP, path: "src/huge.txt" })).value;
      const hugeLines = hugeRead.lines as { from: number; to: number; of: number };
      assert.isBelow(hugeLines.of, 12_000);
      assert.strictEqual(
        hugeRead.next,
        `${READ_NEXT.more(hugeLines.to + 1, hugeLines.of)} ${READ_NEXT.partial(hugeLines.of)}`,
      );
      assert.strictEqual(
        (yield* read({ repo: APP, path: "src/huge.txt", line: hugeLines.of })).value.next,
        READ_NEXT.partial(hugeLines.of),
      );
      // What was read for one person stays in their chat: the turn only reads and answers there.
      yield* ask("zoya", chatOf.zoya, "How do late alerts work?");
      assert.isTrue((yield* read({ repo: APP, path: "src/alerts/late.ts" })).ok);
      const passOn = { to: "Meera Iyer", text: "The late alert code, as asked" };
      const relayed = yield* callAs("tech", "kin_relay", passOn);
      assert.deepStrictEqual(
        [relayed.ok, relayed.value.message],
        [false, REPO_READ_REFUSAL("Zoya Sheikh")],
      );
      assert.isTrue((yield* callAs("tech", "people_read", {})).ok);
      assert.isTrue((yield* read({ repo: APP, path: "README.md" })).ok);
      // The owner's own turn has no such limit.
      yield* ask(owner.personId, chatOf.owner, "How do late alerts work?");
      yield* recordAudience({ orgId, wakeupId: yield* running }, "owner_only");
      assert.isTrue((yield* read({ repo: APP, path: "src/alerts/late.ts" })).ok);
      assert.notStrictEqual(
        (yield* callAs("tech", "kin_relay", passOn)).value.message,
        REPO_READ_REFUSAL("Rhea Rao"),
      );
      // A turn a person's coding agent started through its key reads no repo, as it asks no review.
      yield* ask("zoya", chatOf.zoya, "Read the alerts for my coding agent");
      yield* markOutside({ orgId, wakeupId: yield* running }, codingAgentSource("Zoya's laptop"));
      assert.deepStrictEqual((yield* read({ repo: APP, path: "README.md" })).value, {
        message: OUTSIDE_REFUSAL,
      });
      // Reach is checked as a review ask checks it: a restricted pair reads nothing.
      yield* ask("dev", chatOf.dev, "Read the alerts");
      const limit = (restricted: boolean) =>
        Reach.setLimit({
          orgId,
          by: owner.personId,
          a: Reach.person(KinPersonId.make("dev")),
          b: Reach.agent(tech),
          restricted,
        });
      yield* limit(true);
      assert.deepStrictEqual(
        (yield* read({ repo: APP, path: "README.md" })).value,
        refusal(READ_REFUSAL.restricted("Dev Malhotra")),
      );
      yield* limit(false);
      // A review someone asked for reads only its pull request's repo.
      yield* ask("dev", chatOf.dev, "Review my PR");
      assert.isTrue((yield* review({ repo: APP, number: pull })).ok);
      yield* runReview((yield* githubEvents).at(-1)!.eventId);
      assert.deepStrictEqual(
        (yield* read({ repo: SITE, path: "index.html" })).value,
        refusal(READ_REFUSAL.reviewOnly(APP)),
      );
      assert.isTrue((yield* read({ repo: APP, path: "README.md" })).ok);

      // Its own row in a shared turn's table, tied to no review; and nothing it did wrote to GitHub.
      assert.strictEqual(SHARED_TOOLS.kin_github_read, "allowed");
      assert.deepStrictEqual(
        github.world.calls.slice(before).filter((call) => !call.startsWith("GET ")),
        [],
      );
    }).pipe(Effect.provide(layer));
  },
);

const TRIAGE_REPO = "tidewater/portal";
const TRIAGE_OTHER = "tidewater/billing";
const TRIAGE_DENIED =
  "This turn can only read this repo's code with kin_github_read and post its one comment on this issue with kin_github_comment. Nothing else ran.";
const TRIAGE_NEXT = "Posted on the issue. Nothing you write now goes anywhere.";
const TRIAGE_INSIDE_NEXT =
  "Posted on the issue. Kin tells the owner itself when you set owner: end with kin_skip.";

const tidewater = Effect.fn("test.tidewater")(function* (github: FakeGitHub, appOn: boolean) {
  github.addRepo({
    full_name: TRIAGE_REPO,
    private: true,
    files: { main: { "digest.ts": "export const hour = 3;\n" } },
  });
  github.addRepo({ full_name: TRIAGE_OTHER, private: false });
  if (appOn) {
    installApp(github, [
      {
        id: 11,
        account: "tidewater",
        repos: [TRIAGE_REPO, TRIAGE_OTHER],
        permissions: { contents: "read", metadata: "read", issues: "write" },
      },
    ]);
    yield* (yield* KinGitHubApp).refresh();
  }
  const fixture = yield* ambermill(github);
  const { sql, orgId, queue, directOf, owner, runReview } = fixture;
  yield* sql`UPDATE kin_orgs SET name = 'Tidewater Freight' WHERE org_id = ${orgId}`;
  yield* sql`UPDATE kin_people SET github_login = 'zoya-gh' WHERE org_id = ${orgId} AND person_id = 'zoya'`;
  yield* sql`UPDATE kin_people SET access = CASE person_id WHEN 'meera' THEN 'co_owner' ELSE 'member' END
    WHERE org_id = ${orgId} AND person_id IN ('meera', 'arjun')`;
  const startIssue = Effect.fn("test.startIssue")(function* (inside = false, replyTo?: number) {
    const author = inside ? "zoya-gh" : "mallory";
    const title = "Digest arrives early";
    const association = inside ? "COLLABORATOR" : "NONE";
    const number =
      replyTo ?? github.openItem({ repo: TRIAGE_REPO, pull: false, author, association, title });
    const kind = replyTo === undefined ? "triage" : "triage_reply";
    const key = `${kind}:${TRIAGE_REPO}#${number}${replyTo === undefined ? "" : ":c2"}`;
    const eventId = KinEventId.make(`test-${kind}-${number}`);
    const url = `https://github.com/${TRIAGE_REPO}/issues/${number}`;
    const source = {
      _tag: "github",
      eventId,
      agentId: tech,
      orgId,
      dedupeKey: null,
      provenance: { _tag: "system" },
      receivedAt: yield* DateTime.now,
      deliveryId: eventId,
      eventName: "issues",
      repo: TRIAGE_REPO,
      summary: title,
      trigger: {
        kind,
        item: "issue",
        key,
        number,
        url,
        title,
        author,
        association,
        inside,
        text: title,
      },
    } satisfies KinEvent;
    yield* sql`INSERT INTO kin_github_handled (org_id, trigger_key, repo, number, agent_id, outcome, at)
      VALUES (${orgId}, ${key}, ${TRIAGE_REPO}, ${number}, ${tech}, 'woke', 0)`;
    yield* queue.enqueue(source);
    yield* runReview(eventId);
    const [running] = yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId"
      FROM kin_events WHERE org_id = ${orgId} AND event_id = ${eventId}`;
    return { ...source.trigger, eventId, orgId, agentId: tech, wakeupId: running!.wakeupId };
  });
  return { ...fixture, startIssue, ownerChat: yield* directOf(owner.personId) };
});

const postTriage = (body: string, owner?: string) =>
  callAs("tech", "kin_github_comment", { body, ...(owner === undefined ? {} : { owner }) });

it.effect.each([
  [
    "external link",
    "[Digest](https://example.org/track)",
    "Kin posts links only into tidewater/portal on GitHub.",
  ],
  [
    "image",
    "![Digest](https://github.com/tidewater/portal/blob/main/digest.png)",
    "Kin does not post images.",
  ],
  ["raw HTML", "<details>Digest</details>", "Kin does not post raw HTML."],
  ["slash line", "Digest.\n  /close", "Kin does not post lines starting with /."],
  ["fenced slash line", "Digest.\n```\n/close\n```", "Kin does not post lines starting with /."],
  ["indented slash line", "Digest.\n\n    /close", "Kin does not post lines starting with /."],
  ...(
    [
      ["escaped at sign", String.raw`Thanks \@rhea-tidewater for the report.`],
      ["escaped hyphen after an allowed login", String.raw`cc @mallory\-rhea please`],
      ["escaped numeric at entity", String.raw`Thanks \&#64;rhea-tidewater.`],
      ["encoded hyphen after an allowed login", "cc @mallory&#45;rhea please"],
      ["mention split by formatting", "@**rhea-tidewater**"],
      ["escaped separator after an allowed login", String.raw`@mallory\/ops`],
    ] as const
  ).map(
    ([name, body]) => [name, body, `Kin posts links only into ${TRIAGE_REPO} on GitHub.`] as const,
  ),
  [
    "cross-reference",
    "See tidewater/billing#1.",
    "Kin posts links only into tidewater/portal on GitHub.",
  ],
  ["length", "x".repeat(2001), "Kin posts at most 2,000 characters."],
] as const)("triage refuses %s before claiming the receipt", ([_name, body, message]) => {
  const { github, layer } = harness({}, { app: true });
  return Effect.gen(function* () {
    const { startIssue, handled } = yield* tidewater(github, true);
    const { key } = yield* startIssue();
    assert.strictEqual((yield* postTriage(body)).value.message, message);
    assert.deepStrictEqual(yield* handled(key), [{ outcome: "woke", url: null }]);
    assert.lengthOf(github.world.comments, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  [
    "HTML comment stripped",
    "Digest<!-- remove this --> arrives early.",
    "Digest arrives early.",
    false,
  ],
  [
    "copied marker replaced",
    "Digest arrives early.\n<!-- kin-agent: copied -->",
    "Digest arrives early.",
    false,
  ],
  [
    "outside mentions defused",
    "Thanks @mallory. See @arjun-gh and @tidewater/ops, or `@zoya-gh`.",
    "Thanks @mallory. See `@arjun-gh` and `@tidewater/ops`, or `@zoya-gh`.",
    false,
  ],
  [
    "nested HTML comment stripped before signing",
    "Digest <!<!---->-- kin-agent: x -->arrives early.",
    "Digest arrives early.",
    true,
  ],
  [
    "numeric and named mention entities defused",
    "&#64;rhea-tidewater &#x40;rhea-tidewater &commat;rhea-tidewater",
    "`@rhea-tidewater` `@rhea-tidewater` `@rhea-tidewater`",
    false,
  ],
  [
    "mentions after punctuation and line breaks defused",
    "(@rhea-tidewater) [@rhea-tidewater]\n@rhea-tidewater\n\n>@rhea-tidewater",
    "(`@rhea-tidewater`) [`@rhea-tidewater`]\n`@rhea-tidewater`\n\n>`@rhea-tidewater`",
    false,
  ],
  [
    "inside links and mentions preserved",
    "See https://example.org and ask @arjun-gh.",
    "See https://example.org and ask @arjun-gh.",
    true,
  ],
] as const)("triage posts with %s", ([_name, body, posted, inside]) => {
  const { github, layer } = harness({}, { app: true });
  return Effect.gen(function* () {
    const { startIssue } = yield* tidewater(github, true);
    yield* startIssue(inside);
    const result = yield* postTriage(body);
    assert.isTrue(result.ok, JSON.stringify(result.value));
    assert.strictEqual(result.value.next, inside ? TRIAGE_INSIDE_NEXT : TRIAGE_NEXT);
    assert.deepStrictEqual(
      github.world.comments.map((comment) => comment.body),
      [`${posted}\n\n_Tech lead, via Kin_\n<!-- kin-agent: tech-lead -->`],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "triage binds the issue, records one receipt and refuses a second call or a requeued event",
  () => {
    const { github, layer } = harness({}, { app: true });
    return Effect.gen(function* () {
      const { sql, orgId, owner, ownerChat, ask, end, runReview, startIssue, handled } =
        yield* tidewater(github, true);
      yield* ask(owner.personId, ownerChat, "Check the digest");
      assert.strictEqual(
        (yield* postTriage("The digest arrives early.")).value.message,
        "kin_github_comment posts only the one comment a new issue's turn is for. Comment anywhere else with gh issue comment.",
      );
      yield* end("completed");
      const triage = yield* startIssue();
      const first = yield* postTriage("The digest arrives early.");
      assert.isTrue(first.ok, JSON.stringify(first.value));
      assert.deepStrictEqual(yield* handled(triage.key), [
        { outcome: "woke", url: String(first.value.url) },
      ]);
      const [lastPost] = yield* sql<{ at: number }>`SELECT at FROM kin_github_handled
        WHERE org_id = ${orgId} AND trigger_key = ${triagedKey(TRIAGE_REPO, triage.number)}`;
      assert.strictEqual(lastPost?.at, github.world.comments[0]?.created_at);
      const again = `The comment on ${TRIAGE_REPO}#${triage.number} is already posted. Nothing more was posted.`;
      assert.strictEqual((yield* postTriage("A second comment.")).value.message, again);
      yield* end("completed");
      yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL
      WHERE org_id = ${orgId} AND event_id = ${triage.eventId}`;
      yield* runReview(triage.eventId);
      assert.strictEqual((yield* postTriage("A third comment.")).value.message, again);
      assert.deepStrictEqual(
        github.world.comments.map(({ repo, number, user }) => [repo, number, user]),
        [[TRIAGE_REPO, triage.number, "invented-kin[bot]"]],
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "triage returns a receipt on GitHub refusal, keeps it on no answer, and never falls back outside",
  () => {
    const { github, layer } = harness({}, { app: true });
    return Effect.gen(function* () {
      const { startIssue, end, handled } = yield* tidewater(github, true);
      const rejected = yield* startIssue();
      const path = (number: number) => `repos/${TRIAGE_REPO}/issues/${number}/comments`;
      github.world.refusing = [path(rejected.number)];
      assert.isFalse((yield* postTriage("Digest arrives early.")).ok);
      assert.deepStrictEqual(yield* handled(rejected.key), [{ outcome: "woke", url: null }]);
      assert.deepStrictEqual(yield* handled(`commentfail:${rejected.key}`), [
        { outcome: "failed", url: null },
      ]);
      assert.lengthOf(github.world.comments, 0);
      github.world.refusing = [];
      assert.isTrue((yield* postTriage("Digest arrives early.")).ok);
      assert.deepStrictEqual(yield* handled(`commentfail:${rejected.key}`), []);
      yield* end("completed");

      const unknown = yield* startIssue();
      github.world.failing = [path(unknown.number)];
      const ref = `${TRIAGE_REPO}#${unknown.number}`;
      assert.strictEqual(
        (yield* postTriage("Digest arrives early.")).value.message,
        `GitHub didn't say whether it took the comment on ${ref}, so Kin won't send it again. It may be on the issue.`,
      );
      assert.deepStrictEqual(yield* handled(unknown.key), [{ outcome: "woke", url: POSTING }]);
      github.world.failing = [];
      assert.strictEqual(
        (yield* postTriage("Digest arrives early.")).value.message,
        `A comment on ${ref} was sent and GitHub never said whether it took it, so Kin sends no other. Nothing was posted.`,
      );
    }).pipe(Effect.provide(layer));
  },
);

it.effect("triage outside requires the app and inside can post as the owner", () => {
  const { github, layer } = harness({}, { app: true });
  return Effect.gen(function* () {
    const { startIssue, end, sql, ownerChat, orgId } = yield* tidewater(github, false);
    yield* startIssue();
    assert.strictEqual(
      (yield* postTriage("Digest arrives early.")).value.message,
      "Kin's GitHub App isn't installed on tidewater/portal. Nothing was posted.",
    );
    assert.lengthOf(github.world.comments, 0);
    yield* end("completed");
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
      person_id, role, joined_at)
      VALUES ('triage-owner-chat-zoya', ${orgId}, ${ownerChat}, 'person', 'zoya', 'member', ${at})`;
    const issue = yield* startIssue(true);
    assert.strictEqual(yield* turnAudience(issue), "shared");
    const posted = yield* postTriage("Digest arrives early.");
    assert.isTrue(posted.ok, JSON.stringify(posted.value));
    assert.deepStrictEqual(
      github.world.comments.map(({ number, user }) => [number, user]),
      [[issue.number, OWNER_LOGIN]],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("kin_github_watch lists triage and turns it off and on per repo", () => {
  const { github, layer } = harness({}, { app: true });
  return Effect.gen(function* () {
    const { sql, orgId, startIssue } = yield* tidewater(github, true);
    yield* startIssue(true);
    const repos = JSON.stringify([{ repo: TRIAGE_REPO, fork: false }]);
    yield* sql`INSERT INTO kin_github_watch (org_id, login, started_at, since_at, next_at, repos_json)
      VALUES (${orgId}, ${OWNER_LOGIN}, 0, 0, 0, ${repos})
      ON CONFLICT (org_id) DO UPDATE SET repos_json = excluded.repos_json`;
    const triageOf = (answer: { readonly value: Record<string, unknown> }) =>
      (answer.value.repos as ReadonlyArray<{ readonly triage?: boolean }>).map(
        (repo) => repo.triage,
      );
    assert.deepStrictEqual(triageOf(yield* callAs("tech", "kin_github_watch", {})), [true]);
    for (const triage of [false, true])
      assert.deepStrictEqual(
        triageOf(yield* callAs("tech", "kin_github_watch", { repo: TRIAGE_REPO, triage })),
        [triage],
      );
  }).pipe(Effect.provide(layer));
});

it.effect("triage keeps the outside seat when two issues share a wake-up", () => {
  const { github, layer } = harness({}, { app: true });
  return Effect.gen(function* () {
    const { startIssue, end, sql } = yield* tidewater(github, true);
    const inside = yield* startIssue(true);
    yield* end("completed");
    const outside = yield* startIssue();
    yield* sql`UPDATE kin_events SET wakeup_id = ${outside.wakeupId}
      WHERE org_id = ${inside.orgId} AND event_id = ${inside.eventId}`;
    assert.strictEqual(yield* turnAudience(outside), "shared");
    assert.strictEqual((yield* callAs("tech", "kin_relay", {})).value.message, TRIAGE_DENIED);
    assert.isTrue((yield* postTriage("Digest arrives early.")).ok);
    assert.deepStrictEqual(
      github.world.comments.map(({ number }) => number),
      [outside.number],
    );
  }).pipe(Effect.provide(layer));
});

it.effect(
  "triage outside is shared and quiet, refuses other tools and reads only the bound private repo",
  () => {
    const { github, layer } = harness({}, { app: true });
    return Effect.gen(function* () {
      const { startIssue } = yield* tidewater(github, true);
      const turn = yield* startIssue();
      assert.isTrue(isOutsideTriage(turn));
      assert.strictEqual(yield* turnAudience(turn), "shared");
      const lane = Option.getOrThrow(yield* laneFor(turn));
      assert.include(lane, { mode: "notice", quiet: true, owed: false });
      for (const {
        tool: { name },
      } of (yield* McpServer.McpServer).tools) {
        if (name === "kin_github_read" || name === "kin_github_comment") continue;
        assert.strictEqual((yield* callAs("tech", name, {})).value.message, TRIAGE_DENIED, name);
      }
      const before = github.requests.length;
      assert.strictEqual(
        (yield* callAs("tech", "kin_github_read", { repo: TRIAGE_OTHER })).value.message,
        "This turn answers an issue in tidewater/portal, so it reads only tidewater/portal.",
      );
      assert.deepStrictEqual(github.requests.slice(before), []);
      const read = yield* callAs("tech", "kin_github_read", {
        repo: TRIAGE_REPO,
        path: "digest.ts",
      });
      assert.isTrue(read.ok, JSON.stringify(read.value));
      assert.strictEqual(read.value.text, "export const hour = 3;\n");
      assert.strictEqual((yield* callAs("tech", "kin_relay", {})).value.message, TRIAGE_DENIED);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "triage settlement sends each owner line once and stays quiet for a clean or skipped comment",
  () => {
    const { github, layer } = harness({}, { app: true });
    return Effect.gen(function* () {
      const { sql, orgId, ownerChat, startIssue, runReview, end, told } = yield* tidewater(
        github,
        true,
      );
      const lines: string[] = [];
      for (const [reason, words] of [
        ["security", "reads as a security report"],
        ["data_loss", "reports lost data"],
        ["decision", "asks for something only you can decide"],
        ["rule", "is one your standing rules ask to hear of"],
        ["refused", ""],
        ["unknown", ""],
        ["clean", ""],
        ["skipped", ""],
        ["flagged without a post", "reads as a security report"],
        ["flagged on GitHub refusal", "reports lost data"],
        ["flagged on unknown receipt", "is one your standing rules ask to hear of"],
      ] as const) {
        const inside = reason === "decision";
        const issue = yield* startIssue(inside);
        const ref = `${TRIAGE_REPO}#${issue.number}`;
        const path = `repos/${TRIAGE_REPO}/issues/${issue.number}/comments`;
        if (reason === "flagged without a post") {
          for (const flag of ["security", "decision", "data_loss"]) {
            const result = yield* postTriage("[Report](https://example.org/report)", flag);
            assert.strictEqual(
              result.value.message,
              `Kin posts links only into ${TRIAGE_REPO} on GitHub.`,
            );
          }
          lines.push(
            `"Digest arrives early" (#${issue.number}) on ${TRIAGE_REPO}, mallory's new issue from outside the company, ${words}: ${issue.url}`,
          );
        } else if (
          reason === "flagged on GitHub refusal" ||
          reason === "flagged on unknown receipt"
        ) {
          const unknown = reason === "flagged on unknown receipt";
          if (unknown) github.world.failing = [path];
          else github.world.refusing = [path];
          assert.isFalse(
            (yield* postTriage("The digest arrives early.", unknown ? "rule" : "data_loss")).ok,
          );
          lines.push(
            `"Digest arrives early" (#${issue.number}) on ${TRIAGE_REPO}, mallory's new issue from outside the company, ${words}: ${issue.url}`,
          );
        } else if (reason === "refused") {
          github.world.refusing = [path];
          assert.isFalse((yield* postTriage("The digest arrives early.")).ok);
          lines.push(
            `The reply to ${ref}, a new issue from outside the company, did not post: ${issue.url}`,
          );
        } else if (reason === "unknown") {
          github.world.failing = [path];
          assert.isFalse((yield* postTriage("The digest arrives early.")).ok);
          lines.push(`Kin sent a reply to ${ref} and GitHub didn't confirm it: ${issue.url}`);
        } else if (reason !== "skipped") {
          const posted = yield* postTriage(
            "The digest arrives early.",
            reason === "clean" ? undefined : reason,
          );
          assert.isTrue(posted.ok, JSON.stringify(posted.value));
          if (reason !== "clean")
            lines.push(
              `"Digest arrives early" (#${issue.number}) on ${TRIAGE_REPO}, ${inside ? "Zoya Sheikh's new issue" : "mallory's new issue from outside the company"}, ${words}: ${posted.value.url}`,
            );
        }
        yield* end("completed");
        yield* sql`UPDATE kin_events SET state = 'queued', wakeup_id = NULL
        WHERE org_id = ${orgId} AND event_id = ${issue.eventId}`;
        yield* runReview(issue.eventId);
        yield* end("completed");
        if (reason === "flagged without a post") {
          yield* startIssue(false, issue.number);
          assert.isTrue((yield* postTriage("Thanks for following up.", "rule")).ok);
          yield* end("completed");
        }
      }
      assert.deepStrictEqual(yield* told(ownerChat), lines);
    }).pipe(Effect.provide(layer));
  },
);
