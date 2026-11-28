import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinMessageId,
  KinRoutineCard,
  KinWidgetId,
  type KinWidget,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { fakeRepository } from "../memory/__fixtures__/repository.ts";
import * as Memory from "../memory/Memory.ts";
import { MemoryConfig } from "../memory/MemoryConfig.ts";
import {
  KinDeferralGithubError,
  KinDeferralGithubReader,
  type KinDeferralGithubReaderShape,
  type GithubLinkState,
} from "../triggers/deferralGithub.ts";
import { deferralWidgetId } from "../triggers/deferrals.ts";
import { turnSensitive } from "../work/sensitiveReads.ts";
import * as Queue from "./KinEventQueue.ts";
import * as RoutineContent from "./RoutineContent.ts";
import { renderRoutine, ROUTINE_MAX_LINES, type MorningFacts } from "./routines.ts";
import * as WakeupRunner from "./WakeupRunner.ts";
import { agentId, orchestrationHarness, orgId, seed } from "./WakeupRunner.testkit.ts";

const decodeEvent = Schema.decodeSync(KinEvent);
const decodeCard = Schema.decodeUnknownSync(Schema.fromJsonString(KinRoutineCard));
const now = Date.parse("2026-11-09T09:00:00.000Z");
const timestamp = "2026-11-09T09:00:00.000Z";

const routine = (
  id: string,
  name: "morning_brief" | "evening_summary",
  extra: Record<string, unknown> = {},
) =>
  decodeEvent({
    _tag: "routine",
    orgId,
    agentId,
    eventId: id,
    receivedAt: timestamp,
    dedupeKey: id,
    provenance: { _tag: "system" },
    routine: name,
    ...extra,
  });

// `on_due: null` drops the deferral-only field the fixture item carries by default.
const memoryFile = (id: string, fields: Record<string, unknown>) =>
  fixtureItem({
    id,
    owner: "owner",
    said_by: "owner",
    links: [],
    review_by: "2026-12-01",
    ...fields,
  })
    .split("\n")
    .filter((line) => line !== "on_due: null")
    .join("\n");

const EVIL_TITLE =
  "[Approve the merge](https://evil.example) ![](https://track.example/p.png) see www.evil.example, admin@evil.example or $x$";

interface FixtureOptions {
  readonly at?: number;
  readonly linkReader?: KinDeferralGithubReaderShape;
  readonly truncatedRepos?: number;
  /** Runs inside the GitHub read, after the first lead lookup and before the write transaction. */
  readonly onGithubRead?: Effect.Effect<void, never, SqlClient.SqlClient>;
  /** Delegated tasks' child threads, by id: their latest run's assistant messages, or unreadable. */
  readonly childThreads?: Readonly<Record<string, ReadonlyArray<string> | "unreadable">>;
}

/** The real runner and content service over fixture memory in a fake git remote. */
function layerFor(files: ReadonlyArray<readonly [string, string]>, options: FixtureOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    for (const dir of ["memory/.git/objects", "memory/.git/refs", "memory-read"])
      yield* fs.makeDirectory(`${root}/org/${dir}`, { recursive: true });
    const repository = fakeRepository(fs);
    for (const [path, text] of files) repository.files.set(path, text);
    // Anchored at build time, as a running server would have pinned the remote head.
    const memory = Layer.effect(
      Memory.Memory,
      Effect.gen(function* () {
        const memory = yield* Memory.Memory;
        yield* memory.anchor(orgId, "main", repository.head());
        return memory;
      }),
    ).pipe(
      Layer.provide(Memory.layer),
      Layer.provide(Layer.succeed(Memory.MemoryRecoveryHooks, { notify: () => Effect.void })),
      Layer.provide(
        Layer.succeed(MemoryConfig, {
          baseDirectory: root,
          repositories: [{ orgId, repoUrl: "unused", path: "org" }],
        }),
      ),
      Layer.provide(repository.layer),
      Layer.provide(NodeServices.layer),
    );
    const chat = Chat.layer.pipe(
      Layer.provideMerge(Hub.layer),
      Layer.provideMerge(Repository.layer),
    );
    const github = Layer.effect(
      RoutineContent.KinRoutineGithubReader,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return {
          read: () =>
            (options.onGithubRead ?? Effect.void).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.as({
                reviews: [
                  {
                    repo: "acme/app",
                    number: 7,
                    title: EVIL_TITLE,
                    url: "https://github.com/acme/app/pull/7",
                  },
                ],
                ciRed: [{ repo: "acme/app", branch: "main" }],
                failedRepos: 0,
                truncatedRepos: options.truncatedRepos ?? 0,
                repos: 1,
              }),
            ),
        };
      }),
    );
    const children = options.childThreads ?? {};
    const threads = Layer.effect(
      ThreadManagement.ThreadManagementService,
      Effect.map(ThreadManagement.ThreadManagementService, (service) => ({
        ...service,
        getThreadRecords: ((
          threadId: ThreadId,
          fields: ReadonlyArray<string>,
          filter?: Parameters<typeof service.getThreadRecords>[2],
        ) => {
          const child = children[threadId];
          if (child === undefined)
            return service.getThreadRecords(threadId, fields as never, filter);
          if (child === "unreadable") return Effect.die("unreadable child thread");
          const runId = `${threadId}:run`;
          return Effect.succeed(
            fields.includes("runs")
              ? { runs: [{ id: runId }] }
              : {
                  messages: child.map((text) => ({
                    role: "assistant",
                    runId,
                    text,
                    streaming: false,
                  })),
                },
          );
        }) as typeof service.getThreadRecords,
      })),
    );
    // The runner keeps the harness's memory stub; only the content service reads fixture memory.
    const content = RoutineContent.layer.pipe(
      Layer.provide(memory),
      Layer.provideMerge(chat),
      Layer.provide(github),
      Layer.provide(
        Layer.succeed(
          KinDeferralGithubReader,
          options.linkReader ?? KinDeferralGithubReader.defaultValue(),
        ),
      ),
      Layer.provide(threads),
    );
    return WakeupRunner.layer.pipe(
      Layer.provideMerge(content),
      Layer.provideMerge(orchestrationHarness()),
    );
  });
}

type Setup = Effect.Effect<
  void,
  never,
  SqlClient.SqlClient | Repository.KinChatRepository | Chat.KinChatService
>;

const runRoutine = (event: KinEvent, setup: Setup = Effect.void) =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE kin_chats SET kind = 'direct', direct_key = 'owner-direct' WHERE org_id = ${orgId} AND chat_id = 'owner-chat'`;
    // Unset, the host's zone would stand in; these briefs are read in UTC.
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
        dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${orgId}, 'UTC', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
    yield* setup;
    yield* (yield* Queue.KinEventQueue).enqueue(event);
    const runner = yield* WakeupRunner.WakeupRunner;
    const fiber = yield* runner.runOnce(orgId, agentId).pipe(Effect.forkChild);
    yield* TestClock.adjust("20 seconds");
    yield* Fiber.join(fiber);
    const messages = yield* sql<{
      messageId: string;
      chatId: string;
      body: string;
      widgetId: string | null;
    }>`
      SELECT message_id AS "messageId", chat_id AS "chatId", body, widget_id AS "widgetId"
      FROM kin_messages WHERE org_id = ${orgId} ORDER BY seq`;
    const widgets = yield* sql<{
      widgetId: string;
      messageId: string;
      type: string;
      state: string;
    }>`
      SELECT widget_id AS "widgetId", message_id AS "messageId", type, state_json AS state
      FROM kin_widgets WHERE org_id = ${orgId} AND type = 'routine' ORDER BY widget_id`;
    const wakeups = yield* sql<{ status: string; threadId: string | null }>`
      SELECT status, thread_id AS "threadId" FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY started_at`;
    const [stored] = yield* sql<{ state: string }>`
      SELECT state FROM kin_events WHERE org_id = ${orgId} AND event_id = ${event.eventId} ORDER BY event_id`;
    return { messages, widgets, wakeups, eventState: stored?.state };
  });

const withFixture = <A, E>(
  files: ReadonlyArray<readonly [string, string]>,
  test: Effect.Effect<A, E, Layer.Success<Effect.Success<ReturnType<typeof layerFor>>>>,
  options: FixtureOptions = {},
) =>
  Effect.gen(function* () {
    // Before the runtime starts its timers, so none of them replays the years since the epoch.
    yield* TestClock.setTime(options.at ?? now);
    const layer = yield* layerFor(files, options);
    return yield* test.pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const OTHER_MODELS = '{"instanceId":"codex","model":"gpt-5.1-codex"}';
const otherReport = JSON.stringify({
  result: "done",
  summary: "Other org shipped",
  evidence: [],
  openQuestions: [],
  memorySuggestions: [],
  misleadingMemory: [],
  parsed: true,
});

/**
 * Another org's rows, inserted before this org's so an unfiltered query reads them first. Its
 * waiting row names this org's owner, as a corrupt cross-org row would.
 */
const otherOrg: Setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES ('a-other', 'Other', ${timestamp})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at) VALUES ('other-owner', 'a-other', 'other', 'Other', ${timestamp})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at) VALUES ('other-lead', 'a-other', 'Other lead', 'lead', 'other-owner', ${timestamp})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at) VALUES ('other-chat', 'a-other', 'direct', 'other-direct', 0, ${timestamp})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id) VALUES ('other-lead', 'a-other', 'Other lead', 0, ${OTHER_MODELS}, '[]', 'other-chat')`;
  for (const day of ["2026-11-08", "2026-11-09"])
    yield* sql`INSERT INTO kin_budget (org_id, day, lead_units) VALUES ('a-other', ${day}, 9000000)`;
  yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES ('a-other', 'other-wake', 'other-lead', 'fixture', ${now - 7_200_000}, 'timed_out', '[]')`;
  yield* sql`INSERT INTO kin_budget_charges (org_id, wakeup_id, day, units, tokens_json) VALUES ('a-other', 'other-wake', '2026-11-09', 10, '[{"turnTokenUsage":{"inputTokens":3000,"cachedInputTokens":0}}]')`;
  yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at) VALUES ('other-queued', 'a-other', 'other-lead', 'other-wake', 'build', 'other-thread-1', '{}', '{}', 'queued', ${now - 3_600_000})`;
  yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, report_json, started_at, ended_at) VALUES ('other-done', 'a-other', 'other-lead', 'other-wake', 'build', 'other-thread-2', '{}', '{}', 'completed', ${otherReport}, ${now - 3_600_000}, ${now - 1_800_000})`;
  yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, reason, created_at) VALUES ('other-waiting', 'a-other', 'owner', 'other-chat', 'decision', ${timestamp})`;
  yield* sql`INSERT INTO kin_ping_ledger (org_id, person, item_id, day, pinged_at) VALUES ('a-other', 'owner', 'com-docs', '2026-11-08', 0)`;
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, budget_deferred) VALUES ('other-event', 'a-other', 'other-lead', 'routine', 'P2', '{}', 0, 0, 1)`;
  yield* sql`INSERT INTO kin_dream_runs (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at, ended_at) VALUES ('a-other', '2026-11-09', 'dream', 0, 'failed', 'dream/2026-11-09', 0, 0, 0, 1)`;
}).pipe(Effect.orDie);

const ownerLogin: Setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_people SET github_login = 'owner' WHERE org_id = ${orgId} AND person_id = 'owner'`;
}).pipe(Effect.orDie);

// A deferral card for one due item, as the deferral flow would have posted it.
const deferralCard: Setup = Effect.gen(function* () {
  const chat = yield* Chat.KinChatService;
  const repo = yield* Repository.KinChatRepository;
  const widgetId = KinWidgetId.make(deferralWidgetId(orgId, "def-standup"));
  const { message } = yield* chat.notice({
    audience: "chat",
    orgId,
    chatId: KinChatId.make("owner-chat"),
    messageId: KinMessageId.make(widgetId),
    body: "Deferred to Mon 9 Nov, 10:00",
  });
  const widget: KinWidget = {
    orgId,
    chatId: message.chatId,
    widgetId,
    messageId: message.messageId,
    widgetClass: "native",
    type: "deferral",
    revision: 1,
    state: {},
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: timestamp,
  };
  yield* repo.insertWidget({ ...widget, audience: "chat" });
}).pipe(Effect.orDie);

const checkInLinks = [
  "https://github.com/tidewater/app/pull/41",
  "W-12",
  "https://github.com/tidewater/app/issues/44",
];
const accountsCommitment: [string, string] = [
  "commitments/com-accounts.md",
  memoryFile("com-accounts", {
    kind: "commitment",
    title: "Rhea to sign in to the Accounts mailbox",
    due: "2026-11-09T08:00Z",
    recorded_at: "2026-11-05T00:30:00Z",
    links: checkInLinks,
  }),
];

const seedCheckIn = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_people SET display_name = 'Rhea' WHERE org_id = ${orgId}`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
    VALUES ('zoya', ${orgId}, 'zoya', 'Zoya', 'member', ${timestamp})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'Asia/Kolkata', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
      auth, reach, state, account_label, created_at, updated_at, person_id)
    VALUES (${orgId}, 'accounts', 'google', 'Accounts', 'builtin', 'gmail.googleapis.com',
      'oauth', 'closed', 'active', 'accounts@tidewater.example', 0, 0, NULL),
      (${orgId}, 'rhea', 'google', 'Rhea mail', 'builtin', 'gmail.googleapis.com',
      'oauth', 'closed', 'active', 'rhea@tidewater.example', 0, 0, 'owner'),
      (${orgId}, 'zoya', 'google', 'Zoya mail', 'builtin', 'gmail.googleapis.com',
      'oauth', 'closed', 'active', 'zoya@tidewater.example', 0, 0, 'zoya')`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'work', 'Work', 'W', 1, 0)`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
      owner_kind, owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at)
    VALUES (${orgId}, 'r-W-12', 'work', 'W-12', 'Invented site copy', 'done',
      'person', 'owner', 'person', 'owner', 'o-W-12', 0, 0)`;
});

const readMorning = Effect.fn("test.readMorning")(function* (wakeupId?: string) {
  const content = yield* RoutineContent.KinRoutineContent;
  const facts = yield* content.morningFacts(orgId, agentId, wakeupId);
  assert.isNotNull(facts);
  return JSON.parse(facts) as MorningFacts;
});

it.effect("morning keeps the four-day-old commitment beside the live company mailbox", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const statements: Array<string> = [];
      const transformer: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile()[0]);
          return statement;
        });
      const facts = yield* readMorning().pipe(
        Effect.provideService(Statement.CurrentTransformer, transformer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      assert.lengthOf(statements, 13);
      assert.include(facts.dueToday[0], {
        title: "Rhea to sign in to the Accounts mailbox",
        written: "Thu 5 Nov, 4 days ago",
      });
      assert.include(facts.now?.lines, "Accounts (accounts@tidewater.example): signed in");
    }),
  ),
);

it.effect("morning shows a company mailbox that needs signing in again", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_connections SET state = 'needs_sign_in' WHERE connection_id = 'accounts'`;
      const facts = yield* readMorning();
      assert.include(
        facts.now?.lines ?? [],
        "Accounts (accounts@tidewater.example): needs signing in again",
      );
    }),
  ),
);

it.effect.each(["merged", "unavailable"] as const)(
  "morning reports GitHub link state when the reader is %s",
  (mode) =>
    withFixture(
      [accountsCommitment],
      Effect.gen(function* () {
        yield* seedCheckIn;
        const facts = yield* readMorning();
        assert.include(
          facts.now?.lines ?? [],
          mode === "merged"
            ? "tidewater/app#41 by zoya-dev: merged"
            : "https://github.com/tidewater/app/pull/41: Kin couldn't check it now",
        );
        if (mode === "merged")
          assert.include(
            facts.now?.lines,
            "tidewater/app#44 by zoya-dev: open, assigned to zoya-dev",
          );
      }),
      {
        linkReader: {
          readRepo: (id, repo, numbers) =>
            mode === "unavailable"
              ? Effect.fail(new KinDeferralGithubError({ orgId: id, reason: "unavailable" }))
              : Effect.sync(() => {
                  if (repo !== "tidewater/app") return new Map();
                  assert.deepStrictEqual(numbers, [41, 44]);
                  return new Map<number, Omit<GithubLinkState, "link">>([
                    [41, { state: "merged", assignees: [], linkedPrs: [], author: "zoya-dev" }],
                    [
                      44,
                      { state: "open", assignees: ["zoya-dev"], linkedPrs: [], author: "zoya-dev" },
                    ],
                  ]);
                }),
        },
      },
    ),
);

it.effect("morning shows the live state from a secondary link to Work", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const facts = yield* readMorning();
      assert.include(facts.now?.lines ?? [], "W-12 Invented site copy: done");
    }),
  ),
);

it.effect("morning includes Rhea's mailbox and omits Zoya's mailbox", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const facts = yield* readMorning();
      assert.include(facts.now?.lines ?? [], "Rhea mail (rhea@tidewater.example): signed in");
      assert.notInclude(facts.now.lines.join("\n"), "zoya@tidewater.example");
    }),
  ),
);

it.effect("a teammate lead does not receive live state for a private record or a mailbox", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET sensitive = 1 WHERE org_id = ${orgId} AND key = 'W-12'`;
      const owner = yield* readMorning("rhea-checkin");
      assert.include(owner.now.lines, "W-12 Invented site copy: done");
      assert.isTrue(yield* turnSensitive(orgId, "rhea-checkin"));
      yield* sql`UPDATE kin_agents SET owner_person_id = 'zoya' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      const teammate = yield* readMorning();
      assert.notProperty(teammate, "now");
      assert.notProperty(teammate.dueToday[0], "written");
    }),
  ),
);

it.effect("a three-paragraph waiting message supplies a single short row to the agent", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      const chat = yield* Chat.KinChatService;
      const day = "2026-11-08T18:45:00Z";
      yield* chat.notice({
        audience: "chat",
        orgId,
        chatId: KinChatId.make("owner-chat"),
        messageId: KinMessageId.make("needs-rhea"),
        body: "Pick the Tidewater launch day.\n\nReview the copy.\n\nApprove the design.",
      });
      yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, reason, created_at)
      VALUES ('waiting-rhea', ${orgId}, 'owner', 'owner-chat', 'needs-rhea', 'question', ${day})`;
      const facts = yield* readMorning();
      assert.deepStrictEqual(facts.waiting, [
        {
          title: "Pick the Tidewater launch day.",
          note: "question, since Mon 9 Nov",
          written: "Mon 9 Nov, today",
          more: true,
        },
      ]);
    }),
  ),
);

it.effect(
  "a co-owner's lead sees the company mailbox and its own, never the owner's or a teammate's",
  () =>
    withFixture(
      [],
      Effect.gen(function* () {
        yield* seedCheckIn;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
        VALUES ('meera', ${orgId}, 'meera', 'Meera', 'co_owner', ${timestamp})`;
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
          auth, reach, state, account_label, created_at, updated_at, person_id)
        VALUES (${orgId}, 'meera', 'google', 'Meera mail', 'builtin', 'gmail.googleapis.com',
          'oauth', 'closed', 'needs_sign_in', 'meera@tidewater.example', 0, 0, 'meera')`;
        yield* sql`UPDATE kin_agents SET owner_person_id = 'meera' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
        const facts = yield* readMorning();
        assert.deepStrictEqual(facts.now.lines, [
          "Accounts (accounts@tidewater.example): signed in",
          "Meera mail (meera@tidewater.example): needs signing in again",
          "https://github.com/acme/app/pull/7: Kin couldn't check it now",
        ]);
      }),
    ),
);

it.effect("a member's lead gets no live state and marks nothing sensitive", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_records SET sensitive = 1 WHERE org_id = ${orgId} AND key = 'W-12'`;
      yield* sql`UPDATE kin_agents SET owner_person_id = 'zoya' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      const facts = yield* readMorning("zoya-checkin");
      assert.notProperty(facts, "now");
      assert.isFalse(yield* turnSensitive(orgId, "zoya-checkin"));
    }),
  ),
);

it.effect("a Work key in another company or no longer there adds no line and marks nothing", () =>
  withFixture(
    [
      [
        "commitments/com-keys.md",
        memoryFile("com-keys", {
          kind: "commitment",
          title: "Check the other keys",
          due: "2026-11-09T08:00Z",
          recorded_at: "2026-11-08T00:30:00Z",
          links: ["W-77", "W-99"],
        }),
      ],
    ],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs VALUES ('other-org', 'Other', ${timestamp})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES ('other-org', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at, sensitive)
        VALUES ('other-org', 'r-W-77', 'work', 'W-77', 'Invented other secret', 'open',
          'person', 'owner', 'person', 'owner', 'o-W-77', 0, 0, 1)`;
      const facts = yield* readMorning("keys-checkin");
      assert.notInclude(facts.now.lines.join("\n"), "W-77");
      assert.notInclude(facts.now.lines.join("\n"), "W-99");
      assert.isFalse(yield* turnSensitive(orgId, "keys-checkin"));
    }),
  ),
);

const agedItem = (id: string, recordedAt: string, due: string): [string, string] => [
  `commitments/${id}.md`,
  memoryFile(id, { kind: "commitment", title: id, due, recorded_at: recordedAt }),
];
const ages = (facts: MorningFacts) =>
  Object.fromEntries(
    [...facts.dueToday, ...facts.overdue].map((row) => [row.title, row.written ?? "none"]),
  );

it.effect("written ages by the owner's calendar day just after midnight in Kolkata", () =>
  withFixture(
    [
      agedItem("late-sunday", "2026-11-08T18:29:00Z", "2026-11-09T08:00Z"),
      agedItem("first-minute", "2026-11-08T18:30:00Z", "2026-11-09T08:00Z"),
      agedItem("ahead", "2026-11-09T19:00:00Z", "2026-11-09T08:00Z"),
    ],
    Effect.gen(function* () {
      yield* seedCheckIn;
      assert.deepStrictEqual(ages(yield* readMorning()), {
        "late-sunday": "Sun 8 Nov, 1 day ago",
        "first-minute": "Mon 9 Nov, today",
        ahead: "Tue 10 Nov, in 1 day",
      });
    }),
    { at: Date.parse("2026-11-08T18:31:00Z") },
  ),
);

it.effect("written ages by calendar day across the end of summer time in London", () =>
  withFixture(
    [
      agedItem("sat-late-bst", "2026-10-24T22:30:00Z", "2026-10-26T09:00Z"),
      agedItem("sun-early-bst", "2026-10-24T23:30:00Z", "2026-10-26T09:00Z"),
      agedItem("sun-late-gmt", "2026-10-25T23:59:00Z", "2026-10-26T09:00Z"),
    ],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Europe/London' WHERE org_id = ${orgId}`;
      assert.deepStrictEqual(ages(yield* readMorning()), {
        "sat-late-bst": "Sat 24 Oct, 2 days ago",
        "sun-early-bst": "Sun 25 Oct, 1 day ago",
        "sun-late-gmt": "Sun 25 Oct, 1 day ago",
      });
    }),
    { at: Date.parse("2026-10-26T00:30:00Z") },
  ),
);

const hangStarted = Deferred.makeUnsafe<void>();
it.effect("a GitHub read that never answers leaves the morning facts whole after its budget", () =>
  withFixture(
    [accountsCommitment],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const fiber = yield* readMorning().pipe(Effect.forkChild);
      yield* Deferred.await(hangStarted);
      yield* TestClock.adjust("10 seconds");
      const facts = yield* Fiber.join(fiber);
      assert.deepStrictEqual(facts.now.lines, [
        "Accounts (accounts@tidewater.example): signed in",
        "Rhea mail (rhea@tidewater.example): signed in",
        "https://github.com/tidewater/app/pull/41: Kin couldn't check it now",
        "https://github.com/tidewater/app/issues/44: Kin couldn't check it now",
        "https://github.com/acme/app/pull/7: Kin couldn't check it now",
        "W-12 Invented site copy: done",
      ]);
      assert.lengthOf(facts.dueToday, 1);
    }),
    {
      linkReader: {
        readRepo: () => Deferred.succeed(hangStarted, undefined).pipe(Effect.andThen(Effect.never)),
      },
    },
  ),
);

const githubCalls: Array<string> = [];
it.effect("a company with nothing linked reads GitHub only for its reviews and adds one read", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      yield* seedCheckIn;
      const statements: Array<string> = [];
      const transformer: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile()[0]);
          return statement;
        });
      yield* readMorning().pipe(
        Effect.provideService(Statement.CurrentTransformer, transformer),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      assert.deepStrictEqual(githubCalls, ["acme/app 7"]);
      assert.lengthOf(
        statements.filter((statement) => statement.includes("kin_connections")),
        1,
      );
      assert.lengthOf(statements, 12);
    }),
    {
      linkReader: {
        readRepo: (_org, repo, numbers) =>
          Effect.sync(() => {
            githubCalls.push(`${repo} ${numbers.join(",")}`);
            return new Map();
          }),
      },
    },
  ),
);

it.effect(
  "a morning brief routine posts one server-written message with its card and no lead run",
  () =>
    withFixture(
      [
        [
          "deferrals/def-standup.md",
          memoryFile("def-standup", {
            title: "Start the rate-limit work",
            due: "2026-11-09T10:00Z",
            links: ["https://github.com/acme/app/issues/12"],
          }),
        ],
        [
          "deferrals/def-week.md",
          memoryFile("def-week", { title: "Ship the SDK", due: "2026-11-12T15:00Z" }),
        ],
        [
          "deferrals/def-next.md",
          memoryFile("def-next", { title: "Next week's work", due: "2026-11-16T10:00Z" }),
        ],
        [
          "commitments/com-docs.md",
          memoryFile("com-docs", {
            kind: "commitment",
            title: "Docs for the API",
            due: "2026-11-05T17:00Z",
            on_due: null,
          }),
        ],
        [
          "objectives/obj-launch.md",
          memoryFile("obj-launch", {
            kind: "objective",
            title: "Public beta",
            due: "2026-11-12",
            on_due: null,
          }),
        ],
        [
          "claims/claim-old.md",
          memoryFile("claim-old", {
            kind: "claim",
            title: "Staging uses Postgres 16",
            due: null,
            on_due: null,
            review_by: "2026-11-01",
          }),
        ],
        [
          "deferrals/def-done.md",
          memoryFile("def-done", {
            title: "Already done",
            status: "done",
            due: "2026-11-09T11:00Z",
          }),
        ],
      ],
      Effect.gen(function* () {
        const event = routine("brief-1", "morning_brief", {
          dueAt: "2026-11-09T08:30:00.000Z",
          lateByMs: 30 * 60_000,
          foldedRoutines: [{ routine: "evening_summary", dueAt: "2026-11-06T18:30:00.000Z" }],
        });
        const result = yield* runRoutine(
          event,
          Effect.all([otherOrg, ownerLogin, deferralCard], { discard: true }),
        );
        const posted = result.messages.filter((message) =>
          message.messageId.startsWith("routine:"),
        );
        assert.lengthOf(posted, 1);
        assert.equal(posted[0]?.chatId, "owner-chat");
        assert.deepStrictEqual(posted[0]?.body.split("\n"), [
          "Morning brief, Mon 9 Nov, 30 min late (due 08:30)",
          "Also covers the missed evening summary of Fri 6 Nov.",
          "Due today: Start the rate-limit work (10\\:00, owner)",
          "Due this week: Ship the SDK (Thu 12 Nov 15\\:00, owner)",
          "Overdue: Docs for the API (since Thu 5 Nov, no ping yet)",
          "PRs for your review: acme/app\\#7 \\[Approve the merge\\]\\(https\\://evil\\.example\\) \\!\\[\\]\\(https\\://track\\.example/p\\.png\\) see www\\.evil\\.example, admin\\@evil\\.example or \\$x\\$",
          "CI red on the default branch: acme/app main",
          "Objectives at risk: Public beta (due Thu 12 Nov)",
        ]);
        // Memory upkeep and spend stay out of the owner's brief; the card still lists the row.
        assert.notInclude(posted[0]?.body ?? "", "review by");
        assert.lengthOf(result.widgets, 1);
        const [widget] = result.widgets;
        assert.equal(posted[0]?.widgetId, widget?.widgetId);
        assert.equal(widget?.messageId, posted[0]?.messageId);
        const card = decodeCard(widget?.state);
        assert.equal(card.routine, "morning_brief");
        assert.equal(card.day, "2026-11-09");
        assert.deepStrictEqual(
          card.rows.map((row) => [row.section, row.itemId ?? row.title, row.widgetId ?? null]),
          [
            ["due_today", "def-standup", deferralWidgetId(orgId, "def-standup")],
            ["due_this_week", "def-week", null],
            ["overdue", "com-docs", null],
            // The card's fields are plain text, so they stay unescaped.
            ["review_requested", `acme/app#7 ${EVIL_TITLE}`, null],
            ["ci_red", "acme/app main", null],
            ["objective_at_risk", "obj-launch", null],
            ["past_review", "claim-old", null],
          ],
        );
        assert.equal(result.eventState, "done");
        assert.deepStrictEqual(result.wakeups, [{ status: "completed", threadId: null }]);
      }),
    ),
);

it.effect(
  "a server-written morning brief keeps its waiting message whole and reads no live state",
  () =>
    withFixture(
      [],
      Effect.gen(function* () {
        const whole = "Pick the Tidewater launch day.\n\nReview the copy.\n\nApprove the design.";
        const result = yield* runRoutine(
          routine("brief-waiting", "morning_brief"),
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* (yield* Chat.KinChatService).notice({
              audience: "chat",
              orgId,
              chatId: KinChatId.make("owner-chat"),
              messageId: KinMessageId.make("needs-owner"),
              body: whole,
            });
            yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, message_id, reason, created_at)
            VALUES ('waiting-owner', ${orgId}, 'owner', 'owner-chat', 'needs-owner', 'question', ${timestamp})`;
            yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
              auth, reach, state, account_label, created_at, updated_at, person_id)
            VALUES (${orgId}, 'accounts', 'google', 'Accounts', 'builtin', 'gmail.googleapis.com',
              'oauth', 'closed', 'active', 'accounts@tidewater.example', 0, 0, NULL)`;
          }).pipe(Effect.orDie),
        );
        const card = decodeCard(result.widgets[0]?.state);
        const waiting = card.rows.filter((row) => row.section === "waiting");
        assert.deepStrictEqual(
          waiting.map((row) => row.title),
          ["Pick the Tidewater launch day. Review the copy. Approve the design."],
        );
        assert.notInclude(JSON.stringify(result.widgets), "written");
        assert.notInclude(JSON.stringify(result.messages), "accounts@tidewater.example");
      }),
      { linkReader: { readRepo: () => Effect.die("a server-written brief read live state") } },
    ),
);

it.effect("caps a crowded brief at twelve lines and keeps every row on the card", () =>
  withFixture(
    Array.from({ length: 15 }, (_, index) => {
      const id = `def-${String(index).padStart(2, "0")}`;
      return [
        `deferrals/${id}.md`,
        memoryFile(id, {
          title: `Task ${index}`,
          due: `2026-11-09T${String(9 + (index % 14)).padStart(2, "0")}:30Z`,
        }),
      ] as const;
    }),
    Effect.gen(function* () {
      const result = yield* runRoutine(routine("brief-crowded", "morning_brief"));
      const [message] = result.messages;
      const lines = message?.body.split("\n") ?? [];
      assert.lengthOf(result.messages, 1);
      assert.lengthOf(lines, ROUTINE_MAX_LINES);
      assert.equal(lines.at(-1), "+8 more lines in the card");
      const card = decodeCard(result.widgets[0]?.state);
      assert.lengthOf(
        card.rows.filter((row) => row.section === "due_today"),
        15,
      );
    }),
  ),
);

it.effect(
  "an evening summary reports promises, slips and tomorrow from memory and today's usage",
  () =>
    withFixture(
      [
        [
          "commitments/com-new.md",
          memoryFile("com-new", {
            kind: "commitment",
            title: "Review the billing PR",
            said_by: "sam",
            recorded_at: "2026-11-09T08:00:00.000Z",
            due: "2026-11-10T12:00Z",
            on_due: null,
          }),
        ],
        [
          "deferrals/def-late.md",
          memoryFile("def-late", { title: "Migrate the cron jobs", due: "2026-11-09T07:00Z" }),
        ],
        // A tap moved this one to Monday and cancelled the other: memory still says today.
        [
          "deferrals/def-moved.md",
          memoryFile("def-moved", { title: "Rotate the keys", due: "2026-11-09T06:00Z" }),
        ],
        [
          "deferrals/def-cancelled.md",
          memoryFile("def-cancelled", { title: "Archive the logs", due: "2026-11-09T05:00Z" }),
        ],
      ],
      Effect.gen(function* () {
        const result = yield* runRoutine(
          routine("summary-1", "evening_summary"),
          Effect.gen(function* () {
            yield* otherOrg;
            const sql = yield* SqlClient.SqlClient;
            const movedFrom = Date.parse("2026-11-09T06:00Z");
            yield* sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due,
                snapshot_json, updated_at)
              VALUES (${orgId}, 'def-moved', 'armed', ${Date.parse("2026-11-16T09:00Z")}, 'start',
                ${JSON.stringify({ movedFrom })}, ${now - 60_000}),
                (${orgId}, 'def-cancelled', 'undone', ${Date.parse("2026-11-09T05:00Z")}, 'start',
                '{}', ${now - 60_000})`;
            yield* sql`INSERT INTO kin_budget (org_id, day, lead_units, worker_units) VALUES (${orgId}, '2026-11-09', 120000, 30000)`;
            yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, 'earlier', ${agentId}, 'fixture', ${now - 3_600_000}, 'failed', '[]')`;
            yield* sql`INSERT INTO kin_budget_charges (org_id, wakeup_id, day, units, tokens_json) VALUES (${orgId}, 'earlier', '2026-11-09', 10, '[{"providerTurnId":"t","turnTokenUsage":{"inputTokens":1000,"cachedInputTokens":750}}]')`;
          }).pipe(Effect.orDie),
        );
        const posted = result.messages.filter((message) =>
          message.messageId.startsWith("routine:"),
        );
        assert.lengthOf(posted, 1);
        assert.deepStrictEqual(posted[0]?.body.split("\n"), [
          "Evening summary, Mon 9 Nov",
          "Slipped or moved: Rotate the keys (now Mon 16 Nov); Migrate the cron jobs (was due 07\\:00, still open)",
          "Promised today: Review the billing PR (sam)",
          "Due tomorrow: Review the billing PR (12\\:00)",
          "1 reply failed today; ask again if something went unanswered.",
        ]);
        assert.equal(decodeCard(result.widgets[0]?.state).routine, "evening_summary");
        assert.equal(result.eventState, "done");
      }),
    ),
);

it.effect("an evening whose only news is in Kin's records is summed up, by the company's day", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // 18:00 on Mon 9 Nov at UTC+9; 23:59 on Sun 8 Nov there is the same UTC day.
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
          dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
        VALUES (${orgId}, 'Etc/GMT-9', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'work', 'work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
          owner_kind, owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'r-W-6', 'work', 'W-6', 'Beta release to two pilot clinics', 'done',
          'person', 'owner', 'person', 'owner', 'o-W-6', 0, 0)`;
      const done = (at: number) =>
        sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id, via,
            kind, fields_json)
          VALUES (${orgId}, 'r-W-6', 2, ${at}, 'person', 'owner', 'owner', 'updated',
            '[{"field":"state","from":"open","to":"done"}]')`;
      const content = yield* RoutineContent.KinRoutineContent;
      yield* done(Date.parse("2026-11-08T14:59:00.000Z"));
      assert.isNull(yield* content.eveningFacts(orgId, agentId));
      yield* done(Date.parse("2026-11-09T00:32:54.000Z"));
      const facts = yield* content.eveningFacts(orgId, agentId);
      assert.deepStrictEqual(JSON.parse(facts ?? "{}").today, {
        finished: ["W-6 Beta release to two pilot clinics (task): marked done by Owner (owner)"],
      });
    }).pipe(Effect.orDie),
  ),
);

it.effect("the evening's done tasks say who started each and what its child thread found", () => {
  const long = `Reviewed PR #12 (refunds export). Requested changes: ${"the refund totals round each line before summing, ".repeat(5)}and the new column has no test.`;
  return withFixture(
    [],
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
          dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
        VALUES (${orgId}, 'Asia/Kolkata', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
      yield* sql`UPDATE kin_agents SET display_name = 'Chief of staff' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('finance', ${orgId}, 'Finance', 'lead', 'owner', ${timestamp})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
          role, joined_at)
        VALUES ('lead-member', ${orgId}, 'owner-chat', 'agent', ${agentId}, 'member', ${timestamp})`;
      const card = (
        n: number,
        input: { starter?: string; thread: string | null; status?: string; pr?: string },
      ) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at)
            VALUES (${`task-message-${n}`}, ${orgId}, 'owner-chat', ${n}, 'agent',
              ${input.starter ?? agentId}, 'owner', 'lead-thread', 'lead-member', 'member', 'text',
              '', '[]', 'posted', ${timestamp})`;
          const state = JSON.stringify({
            taskId: `task-${n}`,
            threadId: input.thread,
            title: `Task ${n}`,
            status: input.status ?? "done",
            pullRequests: input.pr === undefined ? [] : [{ url: input.pr, number: 12 }],
          });
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
              type, revision, state_json, awaiting_json, updated_at)
            VALUES (${`task:${n}`}, ${orgId}, 'owner-chat', ${`task-message-${n}`}, 'native',
              'task', 1, ${state},
              '[]', ${`2026-11-09T00:${String(n).padStart(2, "0")}:00.000Z`})`;
        });
      // Two done before the newest eight, read for no outcome; one still working, not done.
      yield* card(1, { thread: "child-1" });
      yield* card(2, { thread: "child-2", starter: "finance" });
      yield* card(3, { thread: "child-3", status: "working" });
      yield* card(4, { thread: "child-review", pr: "https://github.com/acme/app/pull/12" });
      yield* card(5, { thread: "child-long" });
      yield* card(6, { thread: "child-silent", starter: "finance" });
      yield* card(7, { thread: "child-unreadable" });
      yield* card(8, { thread: null });
      for (const n of [9, 10, 11]) yield* card(n, { thread: `child-${n}` });
      const facts = yield* (yield* RoutineContent.KinRoutineContent).eveningFacts(orgId, agentId);
      const notes = (JSON.parse(facts ?? "{}").done as ReadonlyArray<{ note?: string }>).map(
        (row) => row.note,
      );
      const cutNote = notes[3] ?? "";
      assert.deepStrictEqual(notes, [
        "Chief of staff's task",
        "Finance's task",
        "Chief of staff's task; it reported: Requested changes: totals round each line before summing; the new column has no test.",
        cutNote,
        "Finance's task; Kin couldn't read what it found",
        "Chief of staff's task; Kin couldn't read what it found",
        "Chief of staff's task; Kin couldn't read what it found",
        "Chief of staff's task; it reported: Found 9",
        "Chief of staff's task; it reported: Found 10",
        "Chief of staff's task; it reported: Found 11",
      ]);
      const opening = cutNote.split("this is the start): ")[1] ?? "";
      assert.isTrue(
        cutNote.startsWith(
          `Chief of staff's task; it reported (${long.length} characters, this is the start): Reviewed PR #12`,
        ),
      );
      assert.isTrue(opening.endsWith("…") && Array.from(opening).length <= 240);
      assert.isTrue(long.startsWith(opening.slice(0, -1)) && !opening.endsWith(" …"));
    }).pipe(Effect.orDie),
    {
      at: Date.parse("2026-11-09T13:00:00.000Z"),
      childThreads: {
        "child-1": ["Found 1"],
        "child-2": ["Found 2"],
        "child-review": [
          "Looking at the diff now.",
          "Requested changes: totals round each line before summing; the new column has no test.",
        ],
        "child-long": [long],
        "child-silent": [],
        "child-unreadable": "unreadable",
        "child-9": ["Found 9"],
        "child-10": ["Found 10"],
        "child-11": ["Found 11"],
      },
    },
  );
});

it.effect("a brief on a weekday other than Monday skips the week ahead and names GitHub gaps", () =>
  withFixture(
    [
      [
        "deferrals/def-week.md",
        memoryFile("def-week", { title: "Ship the SDK", due: "2026-11-12T15:00Z" }),
      ],
    ],
    Effect.gen(function* () {
      const result = yield* runRoutine(routine("brief-tuesday", "morning_brief"));
      assert.deepStrictEqual(result.messages[0]?.body.split("\n"), [
        "Morning brief, Tue 10 Nov",
        "PRs for your review: acme/app\\#7 \\[Approve the merge\\]\\(https\\://evil\\.example\\) \\!\\[\\]\\(https\\://track\\.example/p\\.png\\) see www\\.evil\\.example, admin\\@evil\\.example or \\$x\\$",
        "CI red on the default branch: acme/app main",
        "GitHub, partial: only the 50 most recently updated open PRs per repository were checked; your profile has no GitHub login, so review requests were not checked.",
      ]);
      assert.notInclude(
        decodeCard(result.widgets[0]?.state).rows.map((row) => row.section),
        "due_this_week",
      );
    }),
    { at: Date.parse("2026-11-10T09:00:00.000Z"), truncatedRepos: 1 },
  ),
);

it.effect("a summary with nothing to report posts nothing and wakes nobody", () =>
  withFixture(
    [
      [
        "decisions/dec-color.md",
        memoryFile("dec-color", { kind: "decision", title: "Use blue", on_due: null }),
      ],
    ],
    Effect.gen(function* () {
      const result = yield* runRoutine(routine("summary-empty", "evening_summary"));
      assert.deepStrictEqual(result.messages, []);
      assert.deepStrictEqual(result.widgets, []);
      assert.strictEqual(result.eventState, "done");
      assert.isTrue(result.wakeups.every((wakeup) => wakeup.threadId === null));
    }),
  ),
);

it.effect("posts to the owner chat as it stands when the write starts", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      const result = yield* runRoutine(
        routine("brief-moved", "morning_brief"),
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at) VALUES ('new-owner-chat', ${orgId}, 'direct', 'new-direct', 0, ${timestamp})`;
        }).pipe(Effect.orDie),
      );
      assert.deepStrictEqual(
        result.messages.map((message) => message.chatId),
        ["new-owner-chat"],
      );
    }),
    {
      onGithubRead: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_leads SET owner_chat_id = 'new-owner-chat' WHERE org_id = ${orgId} AND agent_id = ${agentId}`;
      }).pipe(Effect.orDie),
    },
  ),
);

it.effect("never posts for a lead of another org", () =>
  withFixture(
    [],
    Effect.gen(function* () {
      yield* seed;
      yield* otherOrg;
      const content = yield* RoutineContent.KinRoutineContent;
      const event = decodeEvent({
        _tag: "routine",
        orgId,
        agentId: "other-lead",
        eventId: "brief-cross",
        receivedAt: timestamp,
        dedupeKey: "brief-cross",
        provenance: { _tag: "system" },
        routine: "morning_brief",
      });
      if (!RoutineContent.isRoutineContent(event)) return assert.fail("not a routine event");
      assert.isNull(yield* content.post(KinAgentId.make("other-lead"), event));
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* sql`SELECT message_id FROM kin_messages ORDER BY seq`, []);
    }),
  ),
);

it.effect("a failed brief retries on its own with a counted attempt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    yield* Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* Queue.KinEventQueue).enqueue(routine("brief-fails", "morning_brief"));
      const fiber = yield* (yield* WakeupRunner.WakeupRunner)
        .runOnce(orgId, agentId)
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        yield* sql`SELECT state, attempts, not_before AS "notBefore" FROM kin_events WHERE org_id = ${orgId} ORDER BY event_id`,
        [{ state: "queued", attempts: 1, notBefore: now + 20_000 + 5 * 60_000 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT status, thread_id AS "threadId" FROM kin_wakeups WHERE org_id = ${orgId} ORDER BY started_at`,
        [{ status: "failed", threadId: null }],
      );
    }).pipe(
      Effect.provide(
        WakeupRunner.layer.pipe(
          Layer.provide(
            Layer.succeed(RoutineContent.KinRoutineContent, {
              prepare: (_agentId, event) =>
                Effect.fail(
                  new RoutineContent.KinRoutineContentError({
                    orgId: event.orgId,
                    cause: "fixture",
                  }),
                ),
              post: (_agentId, event) =>
                Effect.fail(
                  new RoutineContent.KinRoutineContentError({
                    orgId: event.orgId,
                    cause: "fixture",
                  }),
                ),
              morningFacts: () => Effect.succeed(null),
              eveningFacts: () => Effect.succeed(null),
            }),
          ),
          Layer.provideMerge(orchestrationHarness()),
        ),
      ),
    );
  }),
);

it.effect.each([
  { scenario: "alone", anotherFails: false },
  { scenario: "beside a failing turn", anotherFails: true },
])(
  "an evening summary past its own day is skipped and its facts are untold ($scenario)",
  ({ anotherFails }) =>
    Effect.gen(function* () {
      // Monday 22:30 in Tokyo, held by quiet hours to 08:00 there: still Monday on a UTC host.
      yield* TestClock.setTime(now + 14 * 60 * 60_000);
      yield* Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
          dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
        VALUES (${orgId}, 'Asia/Tokyo', '09:00', '18:00', '02:00', 0, 1, '09:00', '{}')`;
        const monday = "2026-11-09";
        yield* (yield* Queue.KinEventQueue).enqueue(
          decodeEvent({
            _tag: "pulse",
            orgId,
            agentId,
            eventId: "pulse-evening",
            receivedAt: timestamp,
            dedupeKey: `checkin:checkin-evening:${monday}`,
            provenance: { _tag: "system" },
            factKeys: [],
            checkIn: {
              scheduleId: "checkin-evening",
              title: "Evening summary",
              what: "Evening summary.",
              slot: monday,
              day: monday,
            },
          }),
        );
        yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
        VALUES (${orgId}, 'owner', 'task_late:r-W-1', 'pulse-evening', 'sig', ${now})`;
        if (anotherFails) {
          yield* (yield* Queue.KinEventQueue).enqueue(
            decodeEvent({
              _tag: "pulse",
              orgId,
              agentId,
              eventId: "pulse-other",
              receivedAt: timestamp,
              dedupeKey: "pulse-other",
              provenance: { _tag: "system" },
              factKeys: [],
            }),
          );
        }
        const fiber = yield* (yield* WakeupRunner.WakeupRunner)
          .runOnce(orgId, agentId)
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgId} AND event_id = 'pulse-evening'`,
          [{ state: "expired" }],
        );
        if (anotherFails)
          assert.deepStrictEqual(
            yield* sql`SELECT state, attempts FROM kin_events WHERE org_id = ${orgId} AND event_id = 'pulse-other'`,
            [{ state: "queued", attempts: 1 }],
          );
        else
          assert.deepStrictEqual(
            yield* sql`SELECT status, thread_id AS "threadId" FROM kin_wakeups WHERE org_id = ${orgId}`,
            [{ status: "completed", threadId: null }],
          );
        assert.lengthOf(yield* sql`SELECT 1 FROM kin_pulse_told WHERE org_id = ${orgId}`, 0);
      }).pipe(
        Effect.provide(
          WakeupRunner.layer.pipe(
            Layer.provide(
              Layer.succeed(RoutineContent.KinRoutineContent, {
                prepare: () => Effect.succeed(null),
                post: () => Effect.succeed(null),
                morningFacts: () => Effect.succeed(null),
                eveningFacts: () => Effect.succeed('{"routine":"evening_summary"}'),
              }),
            ),
            Layer.provideMerge(orchestrationHarness({ failed: anotherFails })),
          ),
        ),
      );
    }),
);

it("a clipped line never ends on half of an escape pair", () => {
  const { body } = renderRoutine(
    { day: "2026-11-09", dayLabel: "Mon 9 Nov", dueLabel: null, lateByMs: 0, folded: [] },
    {
      routine: "evening_summary",
      done: [{ title: "[".repeat(300) }],
      slipped: [],
      promised: [],
      waiting: [],
      dueTomorrow: [],
      units: null,
      cacheHitRate: null,
      failedWakeups: 0,
      failedDreams: 0,
    },
  );
  assert.isTrue(body.split("\n")[1]?.endsWith("\\[…"));
});
