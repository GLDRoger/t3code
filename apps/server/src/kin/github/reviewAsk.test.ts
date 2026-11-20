import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinEvent,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import { McpInvocationContext, type McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer, startAgentWakeup } from "../chat/WakeupAuthority.testkit.ts";
import { KinGitHubLogin } from "../connections/GitHubLogin.ts";
import * as Kin from "../layer.ts";
import * as KinToolGate from "../mcp/KinToolGate.ts";
import * as Handoff from "../lead/Handoff.ts";
import { LeadMemory } from "../lead/LeadMemory.ts";
import { handlers as leadHandlers } from "../lead/mcp/handlers.ts";
import { KinLeadToolkit } from "../lead/mcp/tools.ts";
import * as Reach from "../lead/Reach.ts";
import * as Team from "../team/KinTeam.ts";
import { signed } from "./agentMark.ts";
import { emptyWorld, FakeGitHub, ghApiOutput, ghApiStderr, runGh } from "./fakeGitHub.ts";
import * as GitHubWatch from "./GitHubWatch.ts";
import { ASK_REFUSAL, reviewAskSettled, unfinishedLine } from "./reviewAsk.ts";

/**
 * Ambermill (invented): Rhea owns it and the GitHub login Kin watches with; Dev and Zoya are
 * members. Kin has Dev's GitHub login, not Zoya's. The watched repos are the company's own.
 */
const at = "2026-11-01T00:00:00.000Z";
const APP = "ambermill/app";
const SITE = "ambermill/site";
const BATCH = "ambermill/batch";
const FORK = "ambermill/old-fork";
const MEMORY = "ambermill/kin-memory";
const OWNER_LOGIN = "rhea-gh";
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
      Effect.succeed({ login: OWNER_LOGIN, orgs: ["ambermill"], scopes: ["repo"], problem: null }),
    ghDirectory: "/nonexistent",
    gh: (args, stdin) =>
      Effect.sync(() => {
        const run = runGh(github, args, stdin ?? "");
        return { code: run.code, out: run.out + (run.err ?? "") };
      }),
  });

/** The same fake as the watch reads it. */
const watchApi = (github: FakeGitHub) =>
  GitHubWatch.KinGitHubApi.of({
    connected: () => Effect.succeed({ login: OWNER_LOGIN, orgs: ["ambermill"] }),
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

const harness = () => {
  const github = new FakeGitHub(emptyWorld(OWNER_LOGIN, 0));
  for (const repo of [APP, SITE, BATCH, MEMORY])
    github.addRepo({ full_name: repo, private: false });
  github.addRepo({ full_name: FORK, fork: true });
  const kinServices = Layer.unwrap(
    Effect.gen(function* () {
      const services = Option.getOrThrow((yield* Kin.KinServer).services);
      return Layer.mergeAll(Handoff.layer, Team.layer, Layer.mock(LeadMemory)({})).pipe(
        Layer.provideMerge(Layer.succeedContext(services)),
      );
    }),
  );
  const layer = Layer.mergeAll(
    McpHttpServer.toolkitRegistration(KinLeadToolkit, leadHandlers),
    KinToolGate.layer,
  ).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(fakeLogin(github)),
    // Kin's memory repo, which the watch and an ask both leave alone; past Kin's own config.
    Layer.provideMerge(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          KIN_ENABLED: true,
          KIN_MEMORY_REPOSITORIES: JSON.stringify([
            { orgId: "kin-memory-org", repoUrl: `https://github.com/${MEMORY}.git` },
          ]),
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
  const result = yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext, scopeOf(agent)),
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return { ok: result.isError !== true, value: JSON.parse(text) as Record<string, unknown> };
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
  for (const [id, name, login] of [
    ["dev", "Dev Malhotra", "dev-gh"],
    ["zoya", "Zoya Sheikh", null],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, github_login,
        created_at, access)
      VALUES (${id}, ${orgId}, ${id}, ${name}, ${login}, ${at}, 'member')`;
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
  // (a fork isn't watched) and the PRs are older than the watch: GitHub's review request is new.
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
  /** A turn of the Tech lead's, woken by `who` saying `body` in `chatId`. */
  const ask = Effect.fn("test.ask")(function* (who: string, chatId: KinChatId, body: string) {
    // Reviews already queued have had their turns, so this wake-up takes the person's message.
    yield* sql`UPDATE kin_events SET state = 'done'
      WHERE org_id = ${orgId} AND tag = 'github' AND state = 'queued'`;
    yield* startAgentWakeup({
      orgId,
      agentId: tech,
      threadId: ThreadId.make("tech-thread"),
      message: yield* chats.send(person(who), { chatId, body, clientMessageId: `${who}:${body}` }),
    });
  });
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
  return { sql, owner, orgId, look, directOf, ask, review, githubEvents };
});

const outcomes = (value: Record<string, unknown>) =>
  (value.pulls as ReadonlyArray<{ repo: string; number: number; outcome: string }>).map(
    (pull) => [`${pull.repo}#${pull.number}`, pull.outcome] as const,
  );
const DRAFT = "It is a draft: mark it ready and ask again. Nothing was started.";
const already = (sha: string) => `already reviewed at ${sha.slice(0, 7)}; nothing new since`;

// A teammate wrote "Check the latest changes to the PRs" in his own chat with the Tech lead, and it
// could only pass that to the owner and wait. Now an ask is a review request, ruled by the server.
it.effect(
  "a review asked in a person's own chat starts where the rule allows it; each refusal is its sentence",
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
      const head = (repo: string, number: number) =>
        github.world.items.find((item) => item.repo === repo && item.number === number)!.head_sha;
      const firstHead = head(APP, devApp);
      const { review, ask, directOf, githubEvents, sql, orgId, owner } = yield* ambermill(github);
      const devChat = yield* directOf("dev");
      const zoyaChat = yield* directOf("zoya");

      const table: ReadonlyArray<{
        readonly name: string;
        readonly who: "dev" | "zoya";
        readonly args: Record<string, unknown>;
        readonly refused?: string;
        readonly expect?: ReadonlyArray<readonly [string, string]>;
        readonly before?: () => void;
      }> = [
        {
          name: "no GitHub login on file and no repo",
          who: "zoya",
          args: {},
          refused: ASK_REFUSAL.noLogin("Zoya Sheikh"),
        },
        {
          name: "another person's PR, by repo and number",
          who: "zoya",
          args: { repo: APP, number: arjunApp },
          expect: [[`${APP}#${arjunApp}`, "started"]],
        },
        {
          name: "his own open PRs on every watched repo",
          who: "dev",
          args: {},
          expect: [
            [`${APP}#${devApp}`, "started"],
            [`${APP}#${devDraft}`, DRAFT],
            [`${SITE}#${devSite}`, "started"],
          ],
        },
        {
          name: "a PR Kin wrote",
          who: "dev",
          args: { repo: APP, number: kinsOwn },
          expect: [
            [`${APP}#${kinsOwn}`, "Kin wrote it, so Kin doesn't review it. Nothing was started."],
          ],
        },
        {
          name: "the same heads again",
          who: "dev",
          args: {},
          expect: [
            [`${APP}#${devApp}`, already(firstHead)],
            [`${APP}#${devDraft}`, DRAFT],
            [`${SITE}#${devSite}`, already(head(SITE, devSite))],
          ],
        },
        {
          name: "a new head after a review",
          who: "dev",
          args: { repo: APP },
          before: () => github.push({ repo: APP, number: devApp }),
          expect: [
            [`${APP}#${devApp}`, "started"],
            [`${APP}#${devDraft}`, DRAFT],
          ],
        },
        {
          name: "a repo Kin doesn't watch",
          who: "dev",
          args: { repo: FORK },
          refused: ASK_REFUSAL.unwatched(FORK),
        },
        {
          name: "Kin's memory repo",
          who: "dev",
          args: { repo: MEMORY },
          refused: ASK_REFUSAL.memory(MEMORY),
        },
      ];
      for (const row of table) {
        row.before?.();
        yield* ask(row.who, row.who === "dev" ? devChat : zoyaChat, `Check the PRs (${row.name})`);
        const called = yield* review(row.args);
        if (row.refused !== undefined) {
          assert.isFalse(called.ok, row.name);
          assert.strictEqual(called.value.message, row.refused, row.name);
          continue;
        }
        assert.isTrue(called.ok, `${row.name}: ${JSON.stringify(called.value)}`);
        assert.deepStrictEqual(outcomes(called.value), row.expect, row.name);
      }
      // One event per head started, in the asker's name, its diff read for a turn with no shell.
      const queued = yield* githubEvents;
      assert.deepStrictEqual(
        queued.map((event) => [event.trigger.key, event.askedBy]),
        [
          [`review:${APP}#${arjunApp}:${head(APP, arjunApp)}`, "zoya"],
          [`review:${APP}#${devApp}:${firstHead}`, "dev"],
          [`review:${SITE}#${devSite}:${head(SITE, devSite)}`, "dev"],
          [`review:${APP}#${devApp}:${head(APP, devApp)}`, "dev"],
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
      yield* ask("dev", devChat, "Check my PRs again");
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
      assert.lengthOf(yield* githubEvents, 4);
    }).pipe(Effect.provide(layer));
  },
);

it.effect("six open PRs: five start, and the sixth is named as left for the next ask", () => {
  const { github, layer } = harness();
  return Effect.gen(function* () {
    const numbers = Array.from({ length: 6 }, (_, index) =>
      github.openItem({
        repo: BATCH,
        pull: true,
        author: `author-${index}`,
        association: "COLLABORATOR",
        title: `Change ${index + 1}`,
      }),
    );
    const { review, ask, directOf } = yield* ambermill(github);
    const zoyaChat = yield* directOf("zoya");
    yield* ask("zoya", zoyaChat, "Review everything open on batch");
    const first = yield* review({ repo: BATCH });
    assert.isTrue(first.ok, JSON.stringify(first.value));
    assert.deepStrictEqual(
      outcomes(first.value),
      numbers.slice(0, 5).map((number) => [`${BATCH}#${number}`, "started"] as const),
    );
    assert.strictEqual(
      first.value.left,
      `5 start per ask, so these wait: ${BATCH}#${numbers[5]}. Ask again for them.`,
    );
    const again = yield* review({ repo: BATCH });
    assert.deepStrictEqual(outcomes(again.value).at(-1), [`${BATCH}#${numbers[5]!}`, "started"]);
    assert.isUndefined(again.value.left);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "the queued review is the watch's own, and a turn that didn't finish tells the asker and retries on the next ask",
  () => {
    const { github, layer } = harness();
    return Effect.gen(function* () {
      const number = github.openItem({
        repo: APP,
        pull: true,
        author: "dev-gh",
        association: "MEMBER",
        title: "Parse invoice dates",
      });
      const { review, ask, directOf, githubEvents, sql, orgId, look } = yield* ambermill(github);
      const devChat = yield* directOf("dev");
      yield* ask("dev", devChat, "Check the latest changes to my PRs");
      assert.isTrue((yield* review({})).ok);
      const [asked] = yield* githubEvents;
      const key = asked!.trigger.key;
      assert.deepInclude(asked!, {
        dedupeKey: `poll:${key}`,
        deliveryId: `poll:${key}`,
        eventName: "review_request",
        provenance: { _tag: "system" },
        askedBy: KinPersonId.make("dev"),
      });
      // GitHub then asks the owner to review the same head: the watch finds it handled.
      github.requestReview({ repo: APP, number, actor: "dev-gh" });
      yield* look;
      assert.lengthOf(yield* githubEvents, 1);
      const handled = sql<{ outcome: string }>`SELECT outcome FROM kin_github_handled
      WHERE org_id = ${orgId} AND trigger_key = ${key}`;
      assert.deepStrictEqual(yield* handled, [{ outcome: "woke" }]);

      // Its turn failed for good: Dev's chat gets Kin's line once, and asking again retries it.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status, event_ids)
      VALUES ('review-wake', ${orgId}, ${tech}, 'tech-thread', 'test', 0, 'failed', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'failed', wakeup_id = 'review-wake'
      WHERE org_id = ${orgId} AND event_id = ${asked!.eventId}`;
      const settle = reviewAskSettled({ orgId, agentId: tech, wakeupId: "review-wake" });
      yield* settle;
      yield* settle;
      assert.deepStrictEqual(
        yield* sql`SELECT body, author_kind AS kind FROM kin_messages
        WHERE org_id = ${orgId} AND chat_id = ${devChat} AND author_kind <> 'human' ORDER BY seq`,
        [{ body: unfinishedLine("Tech lead", `${APP}#${number}`), kind: "system" }],
      );
      assert.deepStrictEqual(yield* handled, [{ outcome: "unfinished" }]);
      yield* ask("dev", devChat, "Try that review again");
      const retried = yield* review({});
      assert.deepStrictEqual(outcomes(retried.value), [[`${APP}#${number}`, "started"]]);
      const events = yield* githubEvents;
      assert.lengthOf(events, 2);
      assert.strictEqual(events[1]!.trigger.key, key);
      assert.notStrictEqual(events[1]!.eventId, asked!.eventId);
      assert.deepStrictEqual(yield* handled, [{ outcome: "woke" }]);
    }).pipe(Effect.provide(layer));
  },
);
