import { assert, describe, it } from "@effect/vitest";
import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  type KinWidget,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { recordAudience, turnAudience } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { repoScopeLayer } from "../triggers/githubEvents.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import * as PullRequestCare from "./PullRequestCare.ts";
import { fakeGitHub, type RecordedRequest } from "./testFakes.ts";

// Invented company, repos and PRs; GitHub is a fake that never leaves the process.
const orgId = KinOrgId.make("org-1");
const agentId = KinAgentId.make("tech");
const owner = KinPersonId.make("owner");
const at = "2026-11-10T09:00:00.000Z";
const lead = {
  _tag: "agent",
  orgId,
  agentId,
  ownerPersonId: owner,
  threadId: ThreadId.make("thread-tech"),
  wakeupId: KinWakeupId.make("wake-1"),
  startedAt: 0,
} as const;

const seed = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Org', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${owner}, ${orgId}, 'owner', 'Owner', ${at}), ('mate', ${orgId}, 'mate', 'Mate', ${at})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, ${orgId}, 'Tech', 'lead', ${owner}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key)
      VALUES ('dm', ${orgId}, 'direct', 1, ${at}, ${`owner:${agentId}`})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agentId}, ${orgId}, 'Tech', 0, '{}', '[]', 'dm', 'engineering')`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
      VALUES ('wake-1', ${orgId}, ${agentId}, 'model', 0, 'running', '[]')`;
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      VALUES ('event-1', ${orgId}, ${agentId}, 'pulse', 'P2',
        ${JSON.stringify({ _tag: "pulse", provenance: { _tag: "system" } })}, 0, 0, 'done', 'wake-1')`;
    yield* recordAudience(lead, yield* turnAudience(lead));
  }),
).pipe(Layer.provideMerge(KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))));

const listed = (number: number) => ({
  number,
  title: `Invented ${number}`,
  html_url: `https://github.com/acme/app/pull/${number}`,
  created_at: "2026-11-01T00:00:00Z",
  user: { login: "mate" },
  head: { sha: `sha-${number}`, ref: `branch-${number}`, repo: { full_name: "acme/app" } },
});

const route = (request: RecordedRequest) => {
  if (request.path === "/repos/acme/app/pulls?state=open&per_page=100")
    return { status: 200, body: [listed(7), listed(8)] };
  if (request.path === "/repos/acme/app")
    return { status: 200, body: { private: true, owner: { login: "Acme" } } };
  if (request.path === "/repos/acme/site")
    return { status: 200, body: { private: false, owner: { login: "Acme" } } };
  if (request.path === "/repos/client/portal")
    return { status: 200, body: { private: true, owner: { login: "client" } } };
  const pull = /^\/repos\/([^/]+\/[^/]+)\/pulls\/7(\/reviews)?$/.exec(request.path);
  if (pull !== null && pull[2] === undefined)
    return {
      status: 200,
      body: {
        number: 7,
        title: "Invented change",
        head: { sha: "sha-7", ref: "feature", repo: { full_name: pull[1] } },
        base: { ref: "main" },
      },
    };
  if (pull !== null && request.method === "POST")
    return { status: 200, body: { html_url: `https://github.com/${pull[1]}/pull/7#review` } };
  return { status: 404, body: { message: "Not Found" } };
};

const setup = () => {
  const github = fakeGitHub(route);
  const cards: Array<string> = [];
  const app = Layer.succeed(
    KinGitHubApp.KinGitHubApp,
    KinGitHubApp.KinGitHubApp.of({
      app: Effect.succeed({
        id: 1,
        slug: "kin",
        name: "Kin",
        owner: { login: "acme" },
        permissions: {},
        events: [],
      }),
      installations: Effect.die("unused"),
      patchHookConfig: () => Effect.die("unused"),
      installationToken: (input) =>
        Effect.succeed({
          token: Redacted.make("ghs_invented"),
          repo: input.repo,
          expiresAt: "2026-11-10T13:00:00Z",
          permissions: { ...input.permissions },
        }),
    }),
  );
  const gate = Layer.mock(KinLevelGate)({
    ask: (_agent, input, bind) =>
      Effect.gen(function* () {
        const widget = { widgetId: `card-${cards.length + 1}` } as KinWidget;
        cards.push(input.question);
        if (bind !== undefined) yield* Effect.orDie(bind(widget));
        return widget;
      }),
  });
  const layer = Layer.mergeAll(
    PullRequestCare.layer.pipe(
      Layer.provide(Layer.mock(KinRecords)({})),
      Layer.provideMerge(Layer.mergeAll(app, github.layer, repoScopeLayer, seed)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KIN_GITHUB_REPOS: "acme/app, acme/site, client/portal",
            KIN_MEMORY_REPOSITORIES: JSON.stringify([
              { orgId: "org-1", repoUrl: "https://github.com/acme/kin-memory.git" },
            ]),
          }),
        ),
      ),
    ),
    gate,
  );
  return { requests: github.requests, cards, layer };
};

const posts = (requests: ReadonlyArray<RecordedRequest>) =>
  requests.filter((request) => request.method === "POST").map((request) => request.path);
const review = (repo: string, extra: Partial<typeof PullRequestCare.ReviewInput.Type> = {}) =>
  Effect.gen(function* () {
    const care = yield* PullRequestCare.KinPullRequestCare;
    return yield* care.review(lead, { repo, number: 7, sourceEventId: "event-1", ...extra });
  });

describe("KinPullRequestCare.review", () => {
  it.effect(
    "posts at once only on the company's private repos; elsewhere on the owner's tap",
    () => {
      const { requests, cards, layer } = setup();
      return Effect.gen(function* () {
        const posted = yield* review("acme/app", { body: "Looks right; one nit." });
        assert.strictEqual(posted.status, "posted");
        assert.deepStrictEqual(posts(requests), ["/repos/acme/app/pulls/7/reviews"]);
        assert.deepStrictEqual(requests.at(-1)?.body, {
          body: "Looks right; one nit.",
          event: "COMMENT",
          commit_id: "sha-7",
          comments: [],
        });

        // Public, and private but a client's: a proposal and a card, nothing posted.
        for (const repo of ["acme/site", "client/portal"]) {
          const proposed = yield* review(repo, {
            body: `Findings for ${repo}`,
            event: "REQUEST_CHANGES",
          });
          assert.strictEqual(proposed.status, "proposed");
        }
        assert.lengthOf(posts(requests), 1);
        assert.deepStrictEqual(cards, [
          "Post this review on acme/site#7?",
          "Post this review on client/portal#7?",
        ]);

        const sql = yield* SqlClient.SqlClient;
        const [site] = yield* sql<{ postId: string }>`SELECT post_id AS "postId"
        FROM kin_pr_review_posts WHERE repo = 'acme/site'`;
        const again = (repo: string, proposal: string) => review(repo, { proposal });
        assert.strictEqual((yield* again("acme/site", site!.postId)).status, "waiting");

        // A teammate's tap is no answer; the owner's posts exactly what the card showed, once,
        // from Kin itself (the PR care tick), with no call from the agent.
        for (const personId of ["mate", owner])
          yield* PullRequestCare.answerReviewCard({
            orgId,
            widgetId: "card-1",
            personId,
            confirmed: true,
            now: 1,
          });
        const care = yield* PullRequestCare.KinPullRequestCare;
        assert.strictEqual(
          yield* care.postConfirmed(orgId, site!.postId),
          "https://github.com/acme/site/pull/7#review",
        );
        assert.isUndefined(yield* care.postConfirmed(orgId, site!.postId));
        const done = yield* again("acme/site", site!.postId);
        assert.strictEqual(done.status, "posted");
        assert.deepStrictEqual(requests.at(-1)?.body, {
          body: "Findings for acme/site",
          event: "REQUEST_CHANGES",
          commit_id: "sha-7",
          comments: [],
        });
        assert.strictEqual((yield* again("acme/site", site!.postId)).status, "posted");
        assert.lengthOf(posts(requests), 2);

        yield* PullRequestCare.answerReviewCard({
          orgId,
          widgetId: "card-2",
          personId: owner,
          confirmed: false,
          now: 2,
        });
        const [portal] = yield* sql<{ postId: string }>`SELECT post_id AS "postId"
        FROM kin_pr_review_posts WHERE repo = 'client/portal'`;
        assert.strictEqual((yield* again("client/portal", portal!.postId)).status, "declined");
        assert.lengthOf(posts(requests), 2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "backfills open PRs no webhook reported, and closes ones GitHub no longer lists",
    () => {
      const { layer } = setup();
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_pull_requests (org_id, repo, number, title, url, state, opened_at,
          review, updated_at)
        VALUES (${orgId}, 'acme/app', 3, 'Gone', 'https://github.com/acme/app/pull/3', 'open', 0,
          NULL, 0),
          (${orgId}, 'acme/app', 8, 'Known', 'https://github.com/acme/app/pull/8', 'open', 0,
          'approved', 0)`;
        const care = yield* PullRequestCare.KinPullRequestCare;
        assert.strictEqual(yield* care.backfill(orgId), 2);
        const rows = yield* sql<{ number: number; state: string; review: string | null }>`SELECT
          number, state, review FROM kin_pull_requests WHERE repo = 'acme/app' ORDER BY number`;
        assert.deepStrictEqual(rows, [
          { number: 3, state: "closed", review: null },
          { number: 7, state: "open", review: null },
          // What a webhook already said is kept.
          { number: 8, state: "open", review: "approved" },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );
});
