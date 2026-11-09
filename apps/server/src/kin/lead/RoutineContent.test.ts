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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Chat from "../chat/KinChatService.ts";
import * as Hub from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as JudgeShadow from "../floor/JudgeShadow.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import { fakeRepository } from "../memory/__fixtures__/repository.ts";
import * as Memory from "../memory/Memory.ts";
import { MemoryConfig } from "../memory/MemoryConfig.ts";
import { deferralWidgetId } from "../triggers/deferrals.ts";
import * as Queue from "./KinEventQueue.ts";
import * as RoutineContent from "./RoutineContent.ts";
import { ROUTINE_MAX_LINES } from "./routines.ts";
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

const EVIL_TITLE = "[Approve the merge](https://evil.example) ![](https://track.example/p.png)";

interface FixtureOptions {
  readonly at?: number;
  readonly truncatedRepos?: number;
  /** Runs inside the GitHub read, after the first lead lookup and before the write transaction. */
  readonly onGithubRead?: Effect.Effect<void, never, SqlClient.SqlClient>;
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
      Layer.provide(JudgeShadow.layerOff),
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
    // The runner keeps the harness's memory stub; only the content service reads fixture memory.
    const content = RoutineContent.layer.pipe(
      Layer.provide(memory),
      Layer.provideMerge(chat),
      Layer.provide(github),
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

const OTHER_MODELS =
  '{"strong":{"instanceId":"codex","model":"gpt-5.1-codex"},"cheap":{"instanceId":"codex","model":"gpt-5.1-codex-mini"}}';
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
  yield* repo.insertWidget(widget);
}).pipe(Effect.orDie);

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
          "Due today: Start the rate-limit work (10:00, owner) https://github.com/acme/app/issues/12",
          "Due this week: Ship the SDK (Thu 12 Nov 15:00, owner)",
          "Overdue: Docs for the API (since Thu 5 Nov, no ping yet)",
          "PRs for your review: acme/app\\#7 \\[Approve the merge\\]\\(https://evil.example\\) \\!\\[\\]\\(https://track.example/p.png\\)",
          "CI red on the default branch: acme/app main",
          "Objectives at risk: Public beta (due Thu 12 Nov)",
          "Past review date: Staging uses Postgres 16 (review by 2026-11-01)",
        ]);
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
      ],
      Effect.gen(function* () {
        const result = yield* runRoutine(
          routine("summary-1", "evening_summary"),
          Effect.gen(function* () {
            yield* otherOrg;
            const sql = yield* SqlClient.SqlClient;
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
          "Slipped or moved: Migrate the cron jobs (was due 07:00, still open)",
          "Promised today: Review the billing PR (sam)",
          "Due tomorrow: Review the billing PR (12:00)",
          "Usage: 150k units today; cache hits 75%; 1 failed wake-up",
        ]);
        assert.equal(decodeCard(result.widgets[0]?.state).routine, "evening_summary");
        assert.equal(result.eventState, "done");
      }),
    ),
);

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
        "PRs for your review: acme/app\\#7 \\[Approve the merge\\]\\(https://evil.example\\) \\!\\[\\]\\(https://track.example/p.png\\)",
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
              post: (_agentId, event) =>
                Effect.fail(
                  new RoutineContent.KinRoutineContentError({
                    orgId: event.orgId,
                    cause: "fixture",
                  }),
                ),
            }),
          ),
          Layer.provideMerge(orchestrationHarness()),
        ),
      ),
    );
  }),
);
