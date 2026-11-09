import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
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

/** The real runner and content service over fixture memory in a fake git remote. */
function layerFor(files: ReadonlyArray<readonly [string, string]>) {
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
    const github = Layer.succeed(RoutineContent.KinRoutineGithubReader, {
      read: () =>
        Effect.succeed({
          reviews: [
            {
              repo: "acme/app",
              number: 7,
              title: "Add rate limits",
              url: "https://github.com/acme/app/pull/7",
            },
          ],
          ciRed: [{ repo: "acme/app", branch: "main" }],
          failedRepos: 0,
          repos: 1,
        }),
    });
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
    const messages = yield* sql<{ messageId: string; body: string; widgetId: string | null }>`
      SELECT message_id AS "messageId", body, widget_id AS "widgetId" FROM kin_messages
      WHERE org_id = ${orgId} ORDER BY seq`;
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
) =>
  Effect.gen(function* () {
    // Before the runtime starts its timers, so none of them replays the years since the epoch.
    yield* TestClock.setTime(now);
    const layer = yield* layerFor(files);
    return yield* test.pipe(Effect.provide(layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

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
        const result = yield* runRoutine(event, deferralCard);
        const posted = result.messages.filter((message) =>
          message.messageId.startsWith("routine:"),
        );
        assert.lengthOf(posted, 1);
        assert.deepStrictEqual(posted[0]?.body.split("\n"), [
          "Morning brief, Mon 9 Nov, 30 min late (due 08:30)",
          "Also covers the missed evening summary of Fri 6 Nov.",
          "Due today: Start the rate-limit work (10:00, owner) https://github.com/acme/app/issues/12",
          "Overdue: Docs for the API (since Thu 5 Nov, no ping yet)",
          "PRs for your review: acme/app#7 Add rate limits",
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
            ["overdue", "com-docs", null],
            ["review_requested", "acme/app#7 Add rate limits", null],
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
      assert.equal(lines.at(-1), "+7 more lines in the card");
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
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO kin_budget (org_id, day, lead_units, worker_units) VALUES (${orgId}, '2026-11-09', 120000, 30000)`;
            yield* sql`INSERT INTO kin_wakeups (org_id, wakeup_id, agent_id, model, started_at, status, event_ids) VALUES (${orgId}, 'earlier', ${agentId}, 'fixture', ${now - 3_600_000}, 'failed', '[]')`;
            // Another organization's failures must never reach this owner's summary.
            yield* sql`INSERT INTO kin_orgs VALUES ('other', 'Other', ${timestamp})`;
            yield* sql`INSERT INTO kin_budget (org_id, day, lead_units) VALUES ('other', '2026-11-09', 1)`;
            yield* sql`INSERT INTO kin_dream_runs (org_id, owner_date, dream_id, full, status, branch, material_from, material_until, started_at, ended_at) VALUES ('other', '2026-11-09', 'dream', 0, 'failed', 'dream/2026-11-09', 0, 0, 0, 1)`;
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
