// Loaded first: the chat and trigger modules import each other.
import { KinChatService } from "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import {
  EnvironmentId,
  KIN_WORK_WS_METHODS,
  KinAgentId,
  KinChat,
  KinChatError,
  KinChatId,
  KinEvent,
  KinFinanceRpcs,
  KinMemberId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type MemoryItemHead,
  ProviderInstanceId,
  ThreadId,
  kinRpcAccess,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnAudience, turnChat, turnPeople } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import * as LeadAccess from "../lead/LeadAccess.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { TEAMMATE_WORDS, workEventText } from "../lead/LeadPrompt.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
import { readPeople } from "../lead/peopleRead.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { importWork } from "./importWork.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadMoney from "./leadMoney.ts";
import * as LeadWork from "./leadWork.ts";
import { KinWorkToolkit } from "./mcp/tools.ts";
import * as OwnerWork from "./ownerWork.ts";
import { buildWorkSection } from "./workPrompt.ts";

// Invented org, people and work only; nothing here reads a real database or memory.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const other = KinAgentId.make("other");
const at = "2026-11-11T00:00:00.000Z";
const owner = { _tag: "person" as const, orgId, personId: ownerId };
const mate = { _tag: "person" as const, orgId, personId: mateId };

const scopeOf = (agent: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make(`${agent}-thread`),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
});

const identity = Layer.mock(KinIdentity)({
  owner,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: (scope) =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make(scope.thread!.threadId.replace(/-thread$/, "")),
      ownerPersonId: ownerId,
      threadId: scope.thread!.threadId,
    }),
});
// No chat to show a card in: a proposal stands on the owner's typed answer.
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-records-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Two leads with direct chats with the owner, and a teammate. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}), (${mateId}, ${orgId}, 'mate', 'Mate', ${at})`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('mate-session', ${orgId}, ${mateId}, 0)`;
  for (const agent of [lead, other]) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 'lead', ${ownerId}, ${at}, NULL)`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES (${`${agent}-chat`}, ${orgId}, 'direct', ${`owner:${agent}`}, 1, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${`${agent}-chat-owner`}, ${orgId}, ${`${agent}-chat`}, 'person', ${ownerId}, 'owner', ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
      VALUES (${`${agent}-chat-lead`}, ${orgId}, ${`${agent}-chat`}, 'agent', ${agent}, 'member', ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
        worker_projects_json, owner_chat_id)
      VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 0, ${`${agent}-thread`}, '{}', '[]', ${`${agent}-chat`})`;
  }
});

/** A running turn of `lead`, woken by the owner's (or the teammate's) message in its chat. */
const turn = Effect.fn("KinRecordsTest.turn")(function* (
  from: "owner" | "mate" = "owner",
  audience: "owner_only" | "shared" = "owner_only",
) {
  const sql = yield* SqlClient.SqlClient;
  const author = from === "owner" ? ownerId : mateId;
  if (from === "mate")
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES ('ask', ${orgId}, 'lead-chat', 1, 'human', ${author},
      ${from === "owner" ? "lead-chat-owner" : "lead-chat-mate"}, ${from === "owner" ? "owner" : "member"},
      'text', 'Track the invented launch steps', '[]', 'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES ('wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '["ask-event"]', ${audience})`;
  const event = {
    _tag: "chat.message",
    orgId,
    agentId: lead,
    eventId: "ask-event",
    receivedAt: at,
    dedupeKey: null,
    provenance: {
      _tag: "human",
      personId: author,
      memberId: from === "owner" ? "lead-chat-owner" : "lead-chat-mate",
    },
    chatId: "lead-chat",
    messageId: "ask",
  };
  yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
      queued_at, state, wakeup_id)
    VALUES ('ask-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
      'claimed', 'wake')`;
});

const steps = [
  { title: "Write the invented PRD" },
  { title: "Draft the invented pricing page", due: "2026-11-20" },
  { title: "Chase the invented logo", side: "theirs" as const, owner: "owner" },
];
const assignedEvents = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql<{ agentId: string; json: string }>`SELECT agent_id AS "agentId", json
      FROM kin_events WHERE tag = 'record.changed' ORDER BY event_id`,
  ),
);

it.effect("record_create makes many entries in one call and a retry makes none", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    const input = { sourceEventId: "ask-event", records: steps };
    const first = yield* LeadWork.create(scopeOf(lead), input);
    assert.deepStrictEqual(
      first.records.map((row) => [row.key, row.created]),
      [
        ["W-1", true],
        ["W-2", true],
        ["W-3", true],
      ],
    );
    // QA Q12: a lead's 30 February is refused too, as a day or a time.
    for (const due of ["2026-02-30", "2026-02-30T18:00+05:30"])
      assert.include(
        yield* Effect.flip(
          LeadWork.create(scopeOf(lead), {
            sourceEventId: "ask-event",
            records: [{ title: "Invented: an impossible day", due }],
          }),
        ),
        { reason: "invalid_state" },
      );
    const retry = yield* LeadWork.create(scopeOf(lead), input);
    assert.deepStrictEqual(
      retry.records.map((row) => [row.key, row.created]),
      [
        ["W-1", false],
        ["W-2", false],
        ["W-3", false],
      ],
    );
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(yield* sql`SELECT 1 FROM kin_records`, 3);
    // The owner said it, so it is confirmed, linked to the message, and the owner is its assigner.
    const got = yield* LeadWork.get(scopeOf(lead), { key: "W-2" });
    assert.include(got, { state: "open", due: "2026-11-20", owner: "you", assignedBy: "owner" });
    assert.notProperty(got, "suggested");
    assert.deepInclude(got.links, { kind: "message", relation: "source", target: "ask" });
    assert.include(yield* LeadWork.get(scopeOf(lead), { key: "W-3" }), { owner: "owner" });
    // Its own entries, and the owner's, wake nobody.
    assert.lengthOf(yield* assignedEvents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("record_update changes only named fields, logs each change, and both of two land", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn();
    yield* LeadWork.create(scopeOf(lead), { sourceEventId: "ask-event", records: steps });
    const records = yield* KinRecords.KinRecords;
    const moved = yield* LeadWork.update(scopeOf(lead), {
      key: "W-2",
      sourceEventId: "ask-event",
      state: "doing",
    });
    assert.deepStrictEqual(moved, { key: "W-2", rev: 2, state: "doing", changed: ["state"] });
    // The owner retitles it from a client while the lead moves its due date: both land.
    yield* records.update(
      orgId,
      { actor: { _tag: "person", personId: ownerId }, via: "owner", askedBy: ownerId },
      "W-2",
      { title: "Draft the invented pricing page v2" },
    );
    yield* LeadWork.update(scopeOf(lead), { key: "W-2", sourceEventId: "ask-event", due: null });
    const got = yield* LeadWork.get(scopeOf(lead), { key: "W-2" });
    assert.include(got, { title: "Draft the invented pricing page v2", state: "doing", rev: 4 });
    assert.notProperty(got, "due");
    assert.deepStrictEqual(
      got.history.map((line) => [line.by, line.change]),
      [
        ["you", "due: cleared"],
        ["owner", "title: Draft the invented pricing page v2"],
        ["you", "state: doing"],
        ["you", "created"],
      ],
    );
    // Nothing to change is no change, and a stale revision is refused.
    assert.deepInclude(
      yield* LeadWork.update(scopeOf(lead), {
        key: "W-2",
        sourceEventId: "ask-event",
        state: "doing",
      }),
      { rev: 4, changed: [] },
    );
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scopeOf(lead), {
          key: "W-2",
          sourceEventId: "ask-event",
          state: "done",
          expectedRev: 2,
        }),
      ),
      { reason: "conflict" },
    );
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scopeOf(lead), {
          key: "W-2",
          sourceEventId: "not-this-turn",
          state: "done",
        }),
      ),
      { reason: "invalid_state" },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "the owner's assignment wakes the lead once, owner-only, in its chat with the owner",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: compare the two hosting quotes",
        clientRequestId: "new-1",
      });
      assert.include(created, { key: "W-1", state: "open" });
      const retry = {
        orgId,
        title: "Invented: compare the two hosting quotes",
        clientRequestId: "new-1",
      };
      assert.include(yield* OwnerWork.create([owner], retry), { key: "W-1" });
      assert.include(
        yield* Effect.flip(OwnerWork.create([owner], { ...retry, title: "Invented: other" })),
        { reason: "not_allowed" },
      );
      // QA Q12: 30 February was saved as 2 March.
      for (const dueAt of ["2026-02-30T00:00:00.000Z", "2026-02-30"])
        assert.include(
          yield* Effect.flip(
            OwnerWork.create([owner], {
              orgId,
              title: "Invented: an impossible day",
              clientRequestId: `day-${dueAt}`,
              dueAt,
              dueAllDay: dueAt.length === 10,
            }),
          ),
          { reason: "invalid_state" },
        );
      assert.lengthOf(yield* assignedEvents, 0);
      const assigned = yield* OwnerWork.assign([owner], {
        orgId,
        key: "W-1",
        to: { _tag: "agent", agentId: other },
      });
      assert.deepInclude(assigned, { assignedBy: { _tag: "person", personId: ownerId } });
      // Assigning again to the same lead is no change and no second wake-up.
      yield* OwnerWork.assign([owner], {
        orgId,
        key: "W-1",
        to: { _tag: "agent", agentId: other },
      });
      const events = yield* assignedEvents;
      assert.lengthOf(events, 1);
      assert.strictEqual(events[0]!.agentId, other);
      assert.deepInclude(JSON.parse(events[0]!.json), {
        key: "W-1",
        reason: "assigned",
        provenance: { _tag: "human", personId: ownerId, memberId: "other-chat-owner" },
      });
      // The turn it wakes is the owner's alone and answers in that lead's chat with the owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids)
      VALUES ('other-wake', ${orgId}, ${other}, 'other-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'other-wake'
      WHERE tag = 'record.changed'`;
      const woken = { orgId, agentId: other, wakeupId: "other-wake" };
      assert.strictEqual(yield* turnAudience(woken), "owner_only");
      assert.deepStrictEqual(yield* turnChat(woken), { chatId: "other-chat", asked: false });
      // The lead moving its own entry wakes nothing.
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = 'other-wake'`;
      yield* LeadWork.update(scopeOf(other), {
        key: "W-1",
        sourceEventId: events[0]!.json.match(/"eventId":"([^"]+)"/)![1]!,
        state: "doing",
      });
      assert.lengthOf(yield* assignedEvents, 1);
      // The owner's task is his alone until he shares it: to a teammate it is no task at all.
      for (const hidden of [
        OwnerWork.assign([mate], { orgId, key: "W-1", to: { _tag: "agent", agentId: lead } }),
        OwnerWork.get([mate], { orgId, key: "W-1" }),
      ])
        assert.deepInclude(yield* hidden.pipe(Effect.asVoid, Effect.flip), {
          reason: "not_found",
          message: "No entry W-1 in Work.",
        });
      assert.lengthOf((yield* OwnerWork.list([mate], { orgId })).records, 0);
      assert.include(yield* OwnerWork.summary([mate], { orgId }), { open: 0, closed: 0, seq: 0 });
    }).pipe(Effect.provide(layer)),
);

it.effect("work given away with no stored owner assigner is recorded and wakes nobody", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    // Kin itself (no human asked) and a lead acting on a teammate's word.
    yield* records.create(
      orgId,
      { actor: { _tag: "system" }, via: "import" },
      {
        originKey: "invented:1",
        title: "Invented: renew the domain",
        owner: { _tag: "agent", agentId: other },
      },
    );
    yield* records.create(
      orgId,
      { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: mateId },
      {
        originKey: "invented:2",
        title: "Invented: update the deck",
        owner: { _tag: "agent", agentId: other },
      },
    );
    const [system, teammate] = (yield* records.query(orgId, {})).rows.toSorted((a, b) =>
      a.key.localeCompare(b.key),
    );
    assert.include(system, { assignedBy: null, ownerId: other });
    assert.include(teammate, { assignedBy: mateId, ownerId: other });
    assert.lengthOf(yield* assignedEvents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a turn others read gets only Work's tasks, and a member reaches only task RPCs", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn("mate", "shared");
    const shared = { orgId, agentId: lead, wakeupId: "wake" };
    // Tasks are read and changed at the teammate's view; lists and money stay the owner's.
    const view = new Set([
      "records_query",
      "record_get",
      "record_create",
      "record_update",
      "record_hand_back",
    ]);
    assert.lengthOf(Object.keys(KinWorkToolkit.tools), 13);
    for (const tool of Object.keys(KinWorkToolkit.tools))
      assert.strictEqual(yield* sharedToolAllowed(shared, tool, {}), view.has(tool), tool);
    // Only the owner names who else holds a task.
    assert.include(
      yield* Effect.flip(
        LeadWork.create(scopeOf(lead), { sourceEventId: "ask-event", records: steps }),
      ),
      { reason: "not_allowed" },
    );
    // The services check again, so a turn that became shared since the gate is refused too.
    const refused = [
      yield* Effect.flip(
        LeadMoney.define(scopeOf(lead), { sourceEventId: "ask-event", template: "expenses" }),
      ),
      yield* Effect.flip(
        LeadMoney.payment(scopeOf(lead), {
          sourceEventId: "ask-event",
          key: "INV-1",
          amount: "100",
          paidOn: "2026-11-11",
        }),
      ),
      yield* Effect.flip(LeadMoney.profile(scopeOf(lead), {})),
    ];
    for (const error of refused) assert.include(error, { reason: "not_allowed" });
    // Every Work method declares whether a member reaches it: tasks do, and the service shows
    // them only their view; clients, lists, money and the profile are owner-level.
    const teammate = new Set([
      "kin.work.summary",
      "kin.work.list",
      "kin.work.get",
      "kin.work.subscribe",
      "kin.work.create",
      "kin.work.assign",
      "kin.work.handBack",
      "kin.work.update",
    ]);
    const methods = [
      ...Object.values(KIN_WORK_WS_METHODS),
      ...KinFinanceRpcs.map((rpc) => rpc._tag),
    ];
    assert.lengthOf(methods, 37);
    for (const method of methods)
      assert.strictEqual(kinRpcAccess(method) === "person", teammate.has(method), method);
  }).pipe(Effect.provide(layer)),
);

const head = (id: string, fields: Partial<MemoryItemHead>) =>
  ({
    id,
    orgId,
    path: `commitments/${id}.md`,
    kind: "commitment",
    title: `Invented ${id}`,
    status: "open",
    due: null,
    invalid_at: null,
    superseded_by: null,
    sensitive: false,
    ...fields,
  }) as MemoryItemHead;

it.effect("the import brings running workers and open commitments and objectives in once", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
      VALUES ('old', ${orgId}, ${lead}, 'test', 0, 'completed', '[]')`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
        model_json, provenance_json, status, started_at, title)
      VALUES ('running', ${orgId}, ${lead}, 'old', 'build', 'running-thread', '{}', '{}', 'running',
        0, 'Invented README fix'),
        ('ended', ${orgId}, ${lead}, 'old', 'build', 'ended-thread', '{}', '{}', 'completed', 0,
        'Invented old fix')`;
    yield* sql`UPDATE kin_workers SET ended_at = 1 WHERE worker_id = 'ended'`;
    const items = [
      head("promise", { due: "2026-11-20", chat: "other-chat" as never }),
      head("goal", { kind: "objective", sensitive: undefined }),
      head("kept", { status: "done" }),
      head("fact", { kind: "claim" }),
      head("wrong", { invalid_at: at }),
    ];
    assert.deepStrictEqual(yield* importWork(orgId, items), { workers: 1, memory: 2 });
    const records = yield* KinRecords.KinRecords;
    const rows = (yield* records.query(orgId, {})).rows;
    assert.sameDeepMembers(
      rows.map((row) => [row.title, row.state, row.ownerId, row.sensitive]),
      [
        ["Invented README fix", "doing", lead, 0],
        ["Invented promise", "open", other, 0],
        // Unlabelled memory stays sensitive.
        ["Invented goal", "open", lead, 1],
      ],
    );
    // Run again, after someone moved one and dropped another: nothing new, nothing overwritten.
    const promise = rows.find((row) => row.title === "Invented promise")!;
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "owner" }, promise.key, {
      state: "done",
    });
    const goal = rows.find((row) => row.title === "Invented goal")!;
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "owner" }, goal.key, {
      state: "dropped",
    });
    assert.deepStrictEqual(yield* importWork(orgId, items), { workers: 0, memory: 0 });
    assert.lengthOf((yield* records.query(orgId, {})).rows, 3);
    assert.include(yield* records.get(orgId, promise.key), { state: "done" });
    assert.include(yield* records.get(orgId, goal.key), { state: "dropped" });
  }).pipe(Effect.provide(layer)),
);

it.effect("the Work section shows a change once: after the lead's reply it is not new again", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords.KinRecords;
    const section = buildWorkSection({
      orgId,
      agentId: lead,
      chatId: "lead-chat" as never,
      now: 0,
    });
    // The 10 Nov shape: a worker's entry finished between two of the owner's messages.
    yield* records.create(
      orgId,
      { actor: { _tag: "agent", agentId: lead }, via: "worker" },
      {
        originKey: "worker:readme",
        title: "Invented README worker",
        state: "doing",
        owner: { _tag: "agent", agentId: lead },
      },
    );
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, "W-1", {
      state: "done",
    });
    const first = yield* section;
    assert.deepStrictEqual(
      first.changed.map((change) => [change.key, change.state, change.changes]),
      [["W-1", "done", ["state → done (Kin)"]]],
    );
    // A silent turn told nobody, so the change is still new.
    const reply = (seq: number, silent: number) =>
      sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
          author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
          mentions_json, status, created_at, silent)
        VALUES (${`reply-${seq}`}, ${orgId}, 'lead-chat', ${seq}, 'agent', ${lead}, ${ownerId},
          'lead-thread', 'lead-chat-lead', 'member', 'text', 'Invented reply', '[]', 'posted', ${at},
          ${silent})`;
    yield* reply(2, 1);
    assert.lengthOf((yield* section).changed, 1);
    yield* sql`UPDATE kin_chats SET last_seq = 2 WHERE chat_id = 'lead-chat'`;
    yield* section;
    // The lead's reply posted: the second prompt does not present the finished item again.
    yield* reply(3, 0);
    const second = yield* section;
    assert.deepStrictEqual(second.changed, []);
    assert.strictEqual(second.open, 0);
  }).pipe(Effect.provide(layer)),
);

/** Every Work wake-up so far: who, why, which entry, and whose authority. */
const wakes = assignedEvents.pipe(
  Effect.map((rows) =>
    rows
      .map((row) => {
        const event = JSON.parse(row.json) as {
          reason: string;
          key: string;
          seq: number;
          provenance: { personId: string; memberId: string };
        };
        return {
          seq: event.seq,
          wake: [row.agentId, event.reason, event.key, event.provenance.personId],
        };
      })
      .toSorted((a, b) => a.seq - b.seq)
      .map((row) => row.wake),
  ),
);
const toLead = { _tag: "agent" as const, agentId: lead };

it.effect(
  "the owner edits an entry field by field, in the owner's name, and a retry is a no-op",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: book the venue",
        dueAt: "2026-11-20T10:00:00.000Z",
        clientRequestId: "edit-1",
      });
      const edit = {
        orgId,
        key: created.key,
        rev: created.rev,
        title: "Invented: book the bigger venue",
        notes: "Invented notes",
        category: "obligation" as const,
        dueAt: null,
      };
      const edited = yield* OwnerWork.update([owner], edit);
      assert.include(edited, { rev: 2, title: edit.title, notes: edit.notes, dueAt: null });
      assert.deepStrictEqual(edited.changes[0], {
        seq: edited.seq!,
        at: edited.changes[0]!.at,
        by: { _tag: "person", personId: ownerId },
        via: "owner",
        kind: "updated",
        fields: [
          { field: "title", from: "Invented: book the venue", to: edit.title },
          { field: "due", from: "2026-11-20T10:00:00.000Z", to: null },
          { field: "notes", from: "", to: "Invented notes" },
          { field: "category", from: null, to: "obligation" },
        ],
      });
      // The same edit again, on the revision it was based on, changes nothing and succeeds.
      const retried = yield* OwnerWork.update([owner], edit);
      assert.include(retried, { rev: 2, seq: edited.seq });
      assert.lengthOf(retried.changes, 2);
      assert.include(
        yield* Effect.flip(OwnerWork.update([owner], { ...edit, title: "Invented: other" })),
        { reason: "conflict" },
      );
      // Waiting on someone who is here, then closed, then reopened, then due on a day.
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([owner], {
            orgId,
            key: created.key,
            rev: 2,
            state: "waiting",
            waitingOn: { _tag: "agent", agentId: KinAgentId.make("nobody") },
          }),
        ),
        { reason: "not_found" },
      );
      const waiting = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 2,
        state: "waiting",
        waitingOn: { _tag: "person", personId: mateId },
      });
      assert.deepInclude(waiting, { waitingOn: { _tag: "person", personId: mateId } });
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 3,
        state: "done",
      });
      assert.include(done, { state: "done", waitingOn: null });
      assert.isNotNull(done.closedAt);
      const reopened = yield* OwnerWork.update([owner], {
        orgId,
        key: created.key,
        rev: 4,
        state: "open",
        dueAt: "2026-11-25",
        dueAllDay: true,
      });
      assert.include(reopened, { state: "open", closedAt: null, dueAllDay: true });
      assert.deepStrictEqual(
        reopened.changes.slice(0, 3).map((change) => change.fields.map((field) => field.field)),
        [
          ["state", "due", "dueAllDay"],
          ["state", "waitingOn"],
          ["state", "waitingOn"],
        ],
      );
      // The owner's own entry: nobody to tell.
      assert.lengthOf(yield* wakes, 0);
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: created.key, rev: 5, title: "Invented" }),
        ),
        { reason: "not_found" },
      );
      for (const refused of [
        OwnerWork.confirm([mate], { orgId, key: created.key, rev: 5 }),
        OwnerWork.decline([mate], { orgId, key: created.key, rev: 5 }),
      ])
        assert.include(yield* refused.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "closing, reopening or taking back a lead's open entry tells that lead in an owner-only turn",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const give = (id: string) =>
        OwnerWork.create([owner], {
          orgId,
          title: `Invented: ${id}`,
          owner: toLead,
          clientRequestId: id,
        });
      const first = yield* give("first");
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: first.key,
        rev: 1,
        state: "done",
      });
      const reopened = yield* OwnerWork.update([owner], {
        orgId,
        key: first.key,
        rev: done.rev,
        state: "doing",
      });
      assert.deepInclude(reopened, { assignedBy: { _tag: "person", personId: ownerId } });
      const back = yield* OwnerWork.assign([owner], { orgId, key: first.key, to: null });
      assert.deepInclude(back, { owner: { _tag: "person", personId: ownerId } });
      const second = yield* give("second");
      yield* OwnerWork.assign([owner], {
        orgId,
        key: second.key,
        to: { _tag: "agent", agentId: other },
      });
      assert.deepStrictEqual(yield* wakes, [
        [lead, "assigned", "W-1", ownerId],
        [lead, "withdrawn", "W-1", ownerId],
        [lead, "assigned", "W-1", ownerId],
        [lead, "withdrawn", "W-1", ownerId],
        [lead, "assigned", "W-2", ownerId],
        [lead, "withdrawn", "W-2", ownerId],
        [other, "assigned", "W-2", ownerId],
      ]);
      // A withdrawn turn is the owner's alone and answers in the lead's chat with the owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids)
        VALUES ('told', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'told'
        WHERE tag = 'record.changed' AND agent_id = ${lead}
          AND json_extract(json, '$.reason') = 'withdrawn'`;
      const told = { orgId, agentId: lead, wakeupId: "told" };
      assert.strictEqual(yield* turnAudience(told), "owner_only");
      assert.deepStrictEqual(yield* turnChat(told), { chatId: "lead-chat", asked: false });
      // Its own close, Kin's close on a merge, and the owner's own entry wake nobody.
      const third = yield* give("third");
      const fourth = yield* give("fourth");
      const before = (yield* wakes).length;
      yield* sql`UPDATE kin_wakeups SET audience = 'owner_only' WHERE wakeup_id = 'told'`;
      const toldEvent = (yield* sql<{ eventId: string }>`SELECT event_id AS "eventId"
        FROM kin_events WHERE wakeup_id = 'told' ORDER BY event_id LIMIT 1`)[0]!.eventId;
      yield* LeadWork.update(scopeOf(lead), {
        key: third.key,
        sourceEventId: toldEvent,
        state: "done",
      });
      yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, fourth.key, {
        state: "done",
      });
      yield* OwnerWork.update([owner], { orgId, key: first.key, rev: back.rev, state: "dropped" });
      assert.lengthOf(yield* wakes, before);
    }).pipe(Effect.provide(layer)),
);

it.effect("assigning refuses closed entries and records the session's owner as the assigner", () =>
  Effect.gen(function* () {
    yield* seed;
    const created = yield* OwnerWork.create([owner], {
      orgId,
      title: "Invented: send the invoice",
      clientRequestId: "assign-1",
    });
    const toMate = yield* OwnerWork.assign([owner], {
      orgId,
      key: created.key,
      to: { _tag: "person", personId: mateId },
      rev: created.rev,
    });
    assert.deepInclude(toMate, {
      owner: { _tag: "person", personId: mateId },
      assignedBy: { _tag: "person", personId: ownerId },
    });
    assert.deepInclude(toMate.changes[0], { by: { _tag: "person", personId: ownerId } });
    for (const state of ["done", "dropped"] as const) {
      const current = yield* OwnerWork.get([owner], { orgId, key: created.key });
      yield* OwnerWork.update([owner], { orgId, key: created.key, rev: current.rev, state });
      for (const to of [toLead, null])
        assert.include(
          yield* Effect.flip(OwnerWork.assign([owner], { orgId, key: created.key, to })),
          { reason: "invalid_state" },
        );
    }
    assert.lengthOf(yield* wakes, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "confirming keeps a lead's suggestion, declining drops it, and a kept one can't be declined",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const suggest = (id: string) =>
        records.create(
          orgId,
          { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
          { originKey: id, title: `Invented: ${id}`, owner: toLead, confirmed: false },
        );
      const kept = (yield* suggest("kept")).row;
      const confirmed = yield* OwnerWork.confirm([owner], { orgId, key: kept.key, rev: kept.rev });
      assert.include(confirmed, { confirmed: true, rev: 2 });
      assert.deepInclude(confirmed.changes[0], {
        by: { _tag: "person", personId: ownerId },
        fields: [{ field: "confirmed", from: "false", to: "true" }],
      });
      assert.include(
        yield* Effect.flip(OwnerWork.decline([owner], { orgId, key: kept.key, rev: 2 })),
        { reason: "invalid_state" },
      );
      const declined = (yield* suggest("declined")).row;
      const dropped = yield* OwnerWork.decline([owner], {
        orgId,
        key: declined.key,
        rev: declined.rev,
      });
      assert.include(dropped, { state: "dropped", confirmed: false, rev: 2 });
      // Retried on the revision it saw: already declined, so it succeeds and changes nothing.
      assert.include(
        yield* OwnerWork.decline([owner], { orgId, key: declined.key, rev: declined.rev }),
        { rev: 2 },
      );
      // The lead held it open, so it is told once.
      assert.deepStrictEqual(yield* wakes, [[lead, "withdrawn", declined.key, ownerId]]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the list filters on not late, due after, category and side, and pages keep their time",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const day = 24 * 60 * 60 * 1000;
      const rows = [
        { title: "a", dueAt: 1 * day, category: "task" },
        { title: "b", dueAt: 3 * day, category: "issue", side: "theirs" },
        { title: "c", dueAt: 5 * day, category: "task" },
        { title: "d", dueAt: null, category: "obligation" },
        { title: "e", dueAt: 2 * day, category: "task" },
      ] as const;
      for (const row of rows)
        yield* records.create(
          orgId,
          { actor: { _tag: "person", personId: ownerId }, via: "owner", askedBy: ownerId },
          {
            ...row,
            originKey: row.title,
            title: `Invented ${row.title}`,
            owner: { _tag: "person", personId: ownerId },
          },
        );
      yield* records.update(orgId, { actor: { _tag: "system" }, via: "github" }, "W-5", {
        state: "done",
      });
      yield* TestClock.adjust("36 hours");
      const titles = (input: Omit<Parameters<typeof OwnerWork.list>[1], "orgId">) =>
        OwnerWork.list([owner], { orgId, ...input }).pipe(
          Effect.map((page) => page.records.map((record) => record.title)),
        );
      assert.deepStrictEqual(yield* titles({ late: false }), [
        "Invented b",
        "Invented c",
        "Invented d",
        "Invented e",
      ]);
      assert.deepStrictEqual(yield* titles({ category: "task", open: true }), [
        "Invented a",
        "Invented c",
      ]);
      assert.deepStrictEqual(yield* titles({ side: "theirs" }), ["Invented b"]);
      // Due this week and not late, a page at a time: b turns late between the pages, and the
      // second page is still judged as of the first, so c is neither skipped nor repeated.
      const week = {
        open: true,
        late: false,
        dueAfter: "1970-01-02T12:00:00.000Z",
        dueBy: "1970-01-09T12:00:00.000Z",
        limit: 1,
      };
      const first = yield* OwnerWork.list([owner], { orgId, ...week });
      assert.deepInclude(first, { total: 2, nextCursor: `o:1:${1.5 * day}` });
      assert.deepStrictEqual(
        first.records.map((record) => [record.title, record.late]),
        [["Invented b", false]],
      );
      yield* TestClock.adjust("3 days");
      const second = yield* OwnerWork.list([owner], { orgId, ...week, cursor: first.nextCursor! });
      assert.deepInclude(second, { total: 2, nextCursor: null, asOf: first.asOf });
      assert.deepStrictEqual(
        second.records.map((record) => record.title),
        ["Invented c"],
      );
      // The cursor the screens already hold still reads.
      assert.lengthOf((yield* OwnerWork.list([owner], { orgId, cursor: "o:4" })).records, 1);
      assert.include(yield* Effect.flip(OwnerWork.list([owner], { orgId, cursor: "o:x" })), {
        reason: "invalid_state",
      });
      assert.include(yield* OwnerWork.summary([owner], { orgId }), { open: 4, closed: 1 });
    }).pipe(Effect.provide(layer)),
);

it.effect("an entry opens by id, and its links carry what opens the other end", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const records = yield* KinRecords.KinRecords;
    const writer = { actor: { _tag: "agent" as const, agentId: lead }, via: "lead" as const };
    const parent = (yield* records.create(orgId, writer, {
      originKey: "parent",
      title: "Invented launch",
      owner: toLead,
    })).row;
    const step = (yield* records.create(orgId, writer, {
      originKey: "step",
      title: "Invented launch step",
      owner: toLead,
    })).row;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
      VALUES ('old', ${orgId}, ${lead}, 'test', 0, 'completed', '[]')`;
    yield* sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
        model_json, provenance_json, status, started_at, title, pull_request_url, pull_request_number)
      VALUES ('wk', ${orgId}, ${lead}, 'old', 'build', 'wk-thread', '{}', '{}', 'running', 0,
        'Invented worker', 'https://github.com/invented/repo/pull/7', 7)`;
    yield* records.link(orgId, writer, step.recordId, {
      kind: "record",
      target: parent.recordId,
      relation: "parent",
    });
    yield* records.link(orgId, writer, step.recordId, {
      kind: "worker",
      target: "wk",
      relation: "attempt",
    });
    yield* records.link(orgId, writer, step.recordId, {
      kind: "record",
      target: "rec_gone",
      relation: "relates",
    });
    const byId = yield* OwnerWork.get([owner], {
      orgId,
      recordId: KinRecordId.make(step.recordId),
    });
    assert.strictEqual(byId.key, step.key);
    assert.deepStrictEqual(
      byId.links.map((link) => [link.target, link.record ?? null, link.worker ?? null]),
      [
        [
          parent.recordId,
          { recordId: KinRecordId.make(parent.recordId), key: parent.key, title: parent.title },
          null,
        ],
        ["rec_gone", null, null],
        [
          "wk",
          null,
          {
            threadId: ThreadId.make("wk-thread"),
            remoteEnvironmentId: null,
            running: true,
            pullRequest: { url: "https://github.com/invented/repo/pull/7", number: 7 },
          },
        ],
      ],
    );
    // Its own change number moves with its links, not with another entry's change.
    assert.strictEqual(byId.seq, byId.changes[0]!.seq);
    yield* records.update(orgId, writer, parent.key, { state: "doing" });
    assert.strictEqual((yield* OwnerWork.get([owner], { orgId, key: step.key })).seq, byId.seq);
    assert.include(
      yield* Effect.flip(OwnerWork.get([owner], { orgId, recordId: KinRecordId.make("rec_x") })),
      { reason: "not_found" },
    );
    assert.include(
      yield* Effect.flip(
        OwnerWork.get([mate], { orgId, recordId: KinRecordId.make(step.recordId) }),
      ),
      { reason: "not_found", message: "No entry with that id in Work." },
    );
  }).pipe(Effect.provide(layer)),
);

const ownerWrites = {
  actor: { _tag: "person" as const, personId: ownerId },
  via: "owner" as const,
  askedBy: ownerId,
};
const keysOf = (page: { readonly records: ReadonlyArray<{ readonly key: string }> }) =>
  page.records.map((record) => record.key).toSorted();
const ownerTask = (title: string, extra: Partial<KinRecords.CreateInput> = {}) =>
  KinRecords.KinRecords.pipe(
    Effect.flatMap((records) =>
      records.create(orgId, ownerWrites, {
        originKey: title,
        title: `Invented ${title}`,
        owner: { _tag: "person", personId: ownerId },
        ...extra,
      }),
    ),
    Effect.map(({ row }) => row),
  );

it.effect(
  "the people behind a turn come from stored authors, reactors, assigners and origins",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("owner");
      const sql = yield* SqlClient.SqlClient;
      const behind = (
        events: ReadonlyArray<{ readonly tag: string; readonly json: Record<string, unknown> }>,
      ) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM kin_events WHERE event_id != 'ask-event'`;
          for (const [index, event] of events.entries())
            yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
              received_at, queued_at, state, wakeup_id)
            VALUES (${`extra-${index}`}, ${orgId}, ${lead}, ${event.tag}, 'P2',
              ${JSON.stringify(event.json)}, 0, 0, 'claimed', 'wake')`;
          return yield* turnPeople({ orgId, agentId: lead, wakeupId: "wake" });
        });
      const human = (personId: string) => ({ _tag: "human", personId, memberId: "m" });
      const rows = [
        { why: "the owner alone", events: [], people: [], askers: [] },
        {
          why: "the owner's message and a teammate's reaction",
          events: [
            { tag: "chat.reaction", json: { chatId: "lead-chat", provenance: human(mateId) } },
          ],
          people: [mateId],
          askers: [mateId],
        },
        {
          why: "a task a teammate gave it",
          events: [{ tag: "record.changed", json: { provenance: human(mateId) } }],
          people: [mateId],
          askers: [mateId],
        },
        {
          why: "a deferral a teammate's turn set up",
          events: [
            { tag: "deferral.due", json: { origin: { chatId: "lead-chat", personId: mateId } } },
          ],
          people: [mateId],
          askers: [mateId],
        },
      ];
      for (const row of rows)
        assert.deepInclude(
          yield* behind(row.events),
          { people: row.people, askers: row.askers },
          row.why,
        );
    }).pipe(Effect.provide(layer)),
);

it.effect("in a teammate's turn the lead reads and changes Work as their own screens do", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn("mate", "shared");
    const hidden = yield* ownerTask("private");
    const shared = yield* ownerTask("shared", { amount: { minor: 500_000, currency: "INR" } });
    const theirs = yield* ownerTask("theirs", { owner: { _tag: "person", personId: mateId } });
    const sharing = yield* OwnerWork.share([owner], { orgId, keys: [shared.key], shared: true });
    assert.strictEqual(sharing.records[0]?.shared, true);
    const scope = scopeOf(lead);
    const listed = yield* LeadWork.query(scope, {});
    assert.deepStrictEqual(keysOf(listed), keysOf(yield* OwnerWork.list([mate], { orgId })));
    assert.deepStrictEqual(keysOf(listed), [shared.key, theirs.key]);
    for (const row of listed.records) assert.notProperty(row, "amount");
    assert.include(yield* Effect.flip(LeadWork.query(scope, { groupBy: "client" })), {
      reason: "not_allowed",
    });
    // A task they can't see is answered exactly as one that never was, read or changed.
    const unknown = (key: string) =>
      new KinChatError({ reason: "not_found", message: `No entry ${key} in Work.` });
    assert.deepStrictEqual(
      yield* Effect.flip(LeadWork.get(scope, { key: "W-99" })),
      unknown("W-99"),
    );
    assert.deepStrictEqual(
      yield* Effect.flip(LeadWork.get(scope, { key: hidden.key })),
      unknown(hidden.key),
    );
    assert.deepStrictEqual(
      yield* Effect.flip(
        LeadWork.update(scope, { key: hidden.key, sourceEventId: "ask-event", state: "done" }),
      ),
      unknown(hidden.key),
    );
    assert.notProperty(yield* LeadWork.get(scope, { key: shared.key }), "amount");
    assert.include(
      yield* LeadWork.update(scope, {
        key: theirs.key,
        sourceEventId: "ask-event",
        state: "doing",
      }),
      { state: "doing" },
    );
    // Shared with them is theirs to read, not to change.
    assert.include(
      yield* Effect.flip(
        LeadWork.update(scope, { key: shared.key, sourceEventId: "ask-event", state: "done" }),
      ),
      { reason: "not_allowed" },
    );
    // What it files for them is theirs, so they see it.
    const made = yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ title: "Invented: fix the login bug" }],
    });
    assert.include(keysOf(yield* OwnerWork.list([mate], { orgId })), made.records[0]!.key);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "in a group the lead reads only what every teammate there may see, and files nothing",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("mate", "shared");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('mate-2', ${orgId}, 'mate2', 'Mate Two', ${at})`;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES ('mate-2-session', ${orgId}, 'mate-2', 0)`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES ('lead-chat-mate-2', ${orgId}, 'lead-chat', 'person', 'mate-2', 'member', ${at})`;
      const theirs = yield* ownerTask("theirs", { owner: { _tag: "person", personId: mateId } });
      yield* ownerTask("the other's", {
        owner: { _tag: "person", personId: KinPersonId.make("mate-2") },
      });
      const shared = yield* ownerTask("shared");
      yield* OwnerWork.share([owner], { orgId, keys: [shared.key], shared: true });
      const scope = scopeOf(lead);
      assert.deepStrictEqual(keysOf(yield* LeadWork.query(scope, {})), [shared.key]);
      // Even the asker's own task: the other teammate may not see it.
      assert.include(
        yield* Effect.flip(
          LeadWork.update(scope, { key: theirs.key, sourceEventId: "ask-event", state: "done" }),
        ),
        { reason: "not_found" },
      );
      assert.isFalse(
        yield* sharedToolAllowed({ orgId, agentId: lead, wakeupId: "wake" }, "record_create", {}),
      );
      // In the company chat, everyone on the team reads: what it files is shared with them all.
      yield* sql`UPDATE kin_chats SET kind = 'team_group', direct_key = NULL, team_id = 'company'
        WHERE chat_id = 'lead-chat'`;
      assert.isTrue(
        yield* sharedToolAllowed({ orgId, agentId: lead, wakeupId: "wake" }, "record_create", {}),
      );
      const [made] = (yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented: book the launch room" }],
      })).records;
      assert.deepStrictEqual(
        keysOf(yield* LeadWork.query(scope, {})).toSorted(),
        [shared.key, made!.key].toSorted(),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate sees only tasks shared with them or theirs, never a sensitive one or any money",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const records = yield* KinRecords.KinRecords;
      const task = (title: string, extra: Partial<KinRecords.CreateInput> = {}) =>
        records
          .create(orgId, ownerWrites, {
            originKey: title,
            title: `Invented ${title}`,
            owner: { _tag: "person", personId: ownerId },
            ...extra,
          })
          .pipe(Effect.map(({ row }) => row));
      // Every task that exists before sharing is the owner's alone.
      yield* task("private");
      const shared = yield* task("shared");
      const priced = yield* task("priced", { amount: { minor: 500_000, currency: "INR" } });
      yield* task("theirs", { owner: { _tag: "person", personId: mateId } });
      // Never given to them private: labelled after it was theirs.
      const labelled = yield* task("theirs but sensitive", {
        owner: { _tag: "person", personId: mateId },
      });
      yield* records.update(orgId, ownerWrites, labelled.key, { sensitive: true });
      const client = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "client",
        title: "Invented Confidential Client",
        owner: { _tag: "person", personId: ownerId },
        sensitive: true,
      })).row;
      const forClient = yield* task("for the client", { partyId: client.recordId });
      // A client and project nobody labelled: still the owner's, and no more known to them.
      const plain = (yield* records.create(orgId, ownerWrites, {
        list: "clients",
        originKey: "plain client",
        title: "Invented Plain Client",
        owner: { _tag: "person", personId: ownerId },
      })).row;
      const project = (yield* records.create(orgId, ownerWrites, {
        list: "projects",
        originKey: "plain project",
        title: "Invented Plain Project",
        owner: { _tag: "person", personId: ownerId },
        partyId: plain.recordId,
      })).row;
      const forPlain = yield* task("for the plain project", { projectId: project.recordId });
      const before = yield* OwnerWork.summary([mate], { orgId });
      // Their change number counts only changes to what they could see: their two tasks, until
      // one was labelled.
      assert.include(before, { open: 1, seq: 3 });
      yield* OwnerWork.share([owner], {
        orgId,
        keys: [shared.key, priced.key, forClient.key, forPlain.key],
        shared: true,
      });
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        "W-2",
        "W-3",
        "W-4",
        forPlain.key,
      ]);
      // The shared task names no client or project to them, on the row, the sheet or its history.
      const plainRow = (yield* OwnerWork.list([mate], { orgId, text: "plain project" }))
        .records[0]!;
      const plainSheet = yield* OwnerWork.get([mate], { orgId, key: forPlain.key });
      for (const shown of [plainRow, plainSheet]) {
        assert.notProperty(shown, "party");
        assert.notProperty(shown, "project");
        for (const name of ["Invented Plain", plain.key, project.key, plain.recordId])
          assert.notInclude(JSON.stringify(shown), name);
      }
      // Keys of a client or project that exist answer exactly as keys that never did.
      const same = Effect.fnUntraced(function* <R>(
        absent: Effect.Effect<object, KinChatError, R>,
        present: Effect.Effect<object, KinChatError, R>,
        absentKey: string,
        presentKey: string,
      ) {
        const missing = yield* Effect.flip(absent);
        const there = yield* Effect.flip(present);
        assert.strictEqual(missing.reason, "not_found");
        assert.deepStrictEqual(
          [there.reason, there.message],
          [missing.reason, missing.message.replace(absentKey, presentKey)],
        );
      });
      yield* same(
        OwnerWork.list([mate], { orgId, party: "C-99" }),
        OwnerWork.list([mate], { orgId, party: plain.key }),
        "C-99",
        plain.key,
      );
      yield* same(
        OwnerWork.list([mate], { orgId, project: "P-99" }),
        OwnerWork.list([mate], { orgId, project: project.key }),
        "P-99",
        project.key,
      );
      const theirs = yield* OwnerWork.get([mate], { orgId, key: "W-4" });
      for (const [field, absentKey, presentKey] of [
        ["party", "C-99", plain.key],
        ["project", "P-99", project.key],
      ] as const) {
        yield* same(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            [field]: absentKey,
            clientRequestId: `absent-${field}`,
          }),
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            [field]: presentKey,
            clientRequestId: `present-${field}`,
          }),
          absentKey,
          presentKey,
        );
        yield* same(
          OwnerWork.update([mate], { orgId, key: theirs.key, rev: theirs.rev, [field]: absentKey }),
          OwnerWork.update([mate], {
            orgId,
            key: theirs.key,
            rev: theirs.rev,
            [field]: presentKey,
          }),
          absentKey,
          presentKey,
        );
      }
      // Counts and the change number cover only what they see, and no client or project sums.
      const summary = yield* OwnerWork.summary([mate], { orgId });
      assert.include(summary, { open: 4, closed: 0 });
      assert.deepStrictEqual([summary.parties, summary.projects], [[], []]);
      assert.isBelow(summary.seq, (yield* OwnerWork.summary([owner], { orgId })).seq);
      // The priced task, without its amount anywhere: not on the row, the sheet or its history.
      const row = (yield* OwnerWork.list([mate], { orgId, text: "priced" })).records[0]!;
      assert.notProperty(row, "amount");
      const sheet = yield* OwnerWork.get([mate], { orgId, key: priced.key });
      assert.notProperty(sheet, "amount");
      assert.deepStrictEqual(sheet.source, { chatId: null, messageId: null });
      assert.notInclude(JSON.stringify(sheet), "5,000");
      assert.notInclude(JSON.stringify(sheet.changes), "team");
      // Hidden ones look exactly like keys that were never there, and ids alike.
      const unknown = yield* Effect.flip(OwnerWork.get([mate], { orgId, key: "W-99" }));
      for (const key of ["W-1", "W-5", forClient.key]) {
        const hidden = yield* Effect.flip(OwnerWork.get([mate], { orgId, key }));
        assert.deepStrictEqual(
          [hidden.reason, hidden.message],
          [unknown.reason, unknown.message.replace("W-99", key)],
        );
      }
      assert.include(
        yield* Effect.flip(
          OwnerWork.get([mate], { orgId, recordId: KinRecordId.make(forClient.recordId) }),
        ),
        { reason: "not_found", message: "No entry with that id in Work." },
      );
      // The sensitive client is no client to them, as a filter or on a new task.
      const noClient = yield* Effect.flip(OwnerWork.list([mate], { orgId, party: "C-99" }));
      assert.deepInclude(yield* Effect.flip(OwnerWork.list([mate], { orgId, party: client.key })), {
        reason: noClient.reason,
        message: noClient.message.replace("C-99", client.key),
      });
      assert.include(
        yield* Effect.flip(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented",
            party: client.key,
            clientRequestId: "c",
          }),
        ),
        { reason: "not_found" },
      );
      // Lists, sums and money filters are the owner's.
      assert.include(yield* Effect.flip(OwnerWork.list([mate], { orgId, list: "expenses" })), {
        reason: "not_found",
      });
      for (const asked of [{ totalsBy: "none" as const }, { paidFrom: "2026-11-01" }])
        assert.include(yield* Effect.flip(OwnerWork.list([mate], { orgId, ...asked })), {
          reason: "not_allowed",
        });
      // The owner hides one by labelling it and takes another back: both are gone at once.
      const current = yield* OwnerWork.get([owner], { orgId, key: shared.key });
      yield* OwnerWork.update([owner], {
        orgId,
        key: shared.key,
        rev: current.rev,
        sensitive: true,
      });
      const unshared = yield* OwnerWork.share([owner], {
        orgId,
        keys: [priced.key],
        shared: false,
      });
      // The row says it is shared only while it is, so the owner's switch shows the truth.
      assert.notProperty(unshared.records[0], "shared");
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([mate], { orgId })), [
        "W-4",
        forPlain.key,
      ]);
      // Sharing is his: a teammate can't share, confirm or lower a label.
      assert.include(
        yield* Effect.flip(OwnerWork.share([mate], { orgId, keys: ["W-4"], shared: true })),
        { reason: "not_allowed" },
      );
      assert.include(
        yield* Effect.flip(OwnerWork.share([owner], { orgId, keys: ["C-1"], shared: true })),
        {
          reason: "not_found",
        },
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate files tasks of their own and changes only theirs, never a label or money",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const filed = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: draft the launch post",
        clientRequestId: "same-id",
      });
      assert.deepInclude(filed, {
        owner: { _tag: "person", personId: mateId },
        createdBy: { _tag: "person", personId: mateId },
        assignedBy: { _tag: "person", personId: mateId },
      });
      // A retry is the same task; the owner's request with the same id is his own.
      assert.include(
        yield* OwnerWork.create([mate], {
          orgId,
          title: "Invented: draft the launch post",
          clientRequestId: "same-id",
        }),
        { key: filed.key },
      );
      const owners = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: the owner's own",
        clientRequestId: "same-id",
      });
      assert.notStrictEqual(owners.key, filed.key);
      // What a teammate files is in the open for the team, and the owner sees it as usual.
      assert.deepStrictEqual(keysOf(yield* OwnerWork.list([owner], { orgId })), ["W-1", "W-2"]);
      const done = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: filed.rev,
        state: "done",
        notes: "Invented: posted",
      });
      assert.include(done, { state: "done", notes: "Invented: posted" });
      const reopened = yield* OwnerWork.update([mate], {
        orgId,
        key: filed.key,
        rev: done.rev,
        state: "open",
      });
      assert.include(reopened, { state: "open" });
      for (const owned of [
        { sensitive: true },
        { amount: { minor: 100, currency: "INR" } },
        { repeat: { every: "month" as const } },
      ])
        assert.deepInclude(
          yield* Effect.flip(
            OwnerWork.update([mate], { orgId, key: filed.key, rev: reopened.rev, ...owned }),
          ),
          { reason: "not_allowed", message: "Only the owner or a co-owner changes that." },
        );
      // A task the owner shared with them is theirs to read, not to change.
      yield* OwnerWork.share([owner], { orgId, keys: [owners.key], shared: true });
      const seen = yield* OwnerWork.get([mate], { orgId, key: owners.key });
      for (const change of [
        OwnerWork.update([mate], { orgId, key: owners.key, rev: seen.rev, state: "done" }),
        OwnerWork.assign([mate], { orgId, key: owners.key, to: null }),
      ])
        assert.include(yield* change.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
      // Given to the owner, it stays theirs to change: they gave it.
      const given = yield* OwnerWork.assign([mate], {
        orgId,
        key: filed.key,
        to: { _tag: "person", personId: ownerId },
      });
      assert.deepInclude(given, { assignedBy: { _tag: "person", personId: mateId } });
      assert.include(
        yield* OwnerWork.update([mate], {
          orgId,
          key: filed.key,
          rev: given.rev,
          title: "Invented: v2",
        }),
        { title: "Invented: v2" },
      );
      // Hidden from them since, a retry of its request finds no entry, whatever it asks for now.
      const later = yield* OwnerWork.get([owner], { orgId, key: filed.key });
      yield* OwnerWork.update([owner], { orgId, key: filed.key, rev: later.rev, sensitive: true });
      const retried = yield* Effect.flip(
        OwnerWork.create([mate], {
          orgId,
          title: "Invented: draft the launch post",
          clientRequestId: "same-id",
        }),
      );
      const changed = yield* Effect.flip(
        OwnerWork.create([mate], {
          orgId,
          title: "Invented: something else",
          clientRequestId: "same-id",
        }),
      );
      assert.strictEqual(retried.reason, "not_found");
      assert.deepStrictEqual([changed.reason, changed.message], [retried.reason, retried.message]);
    }).pipe(Effect.provide(layer)),
);

/** The teammate may message `lead`, and has their direct chat with it. */
const mateMayMessage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at)
    VALUES (${orgId}, ${lead}, ${mateId}, ${ownerId}, 0)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('mate-chat', ${orgId}, 'direct', ${`${mateId}:${lead}`}, 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('mate-chat-mate', ${orgId}, 'mate-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('mate-chat-lead', ${orgId}, 'mate-chat', 'agent', ${lead}, 'member', ${at})`;
});

it.effect(
  "a task a teammate gives an agent runs as theirs: shared, capped, and answered in their chat",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      const sql = yield* SqlClient.SqlClient;
      // An agent its owner doesn't let them message is no agent to them, and nothing is written.
      assert.deepInclude(
        yield* Effect.flip(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented: for the other lead",
            owner: { _tag: "agent", agentId: other },
            clientRequestId: "other",
          }),
        ),
        { reason: "not_found", message: "No agent other here to own it." },
      );
      assert.lengthOf((yield* OwnerWork.list([owner], { orgId })).records, 0);
      const given = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: summarise the call notes",
        owner: toLead,
        clientRequestId: "lead",
      });
      assert.deepInclude(given, { assignedBy: { _tag: "person", personId: mateId } });
      const [event] = yield* assignedEvents;
      assert.deepInclude(JSON.parse(event!.json), {
        reason: "assigned",
        provenance: { _tag: "human", personId: mateId, memberId: "mate-chat-mate" },
        chatId: "mate-chat",
        origin: { agentId: lead, chatId: "mate-chat", personId: mateId },
      });
      // Its turn: shared, in their chat, at a teammate's level, and asked by no owner.
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
          status, event_ids)
        VALUES ('mate-wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '[]')`;
      yield* sql`UPDATE kin_events SET state = 'claimed', wakeup_id = 'mate-wake'
        WHERE tag = 'record.changed'`;
      const woken = { orgId, agentId: lead, wakeupId: "mate-wake" };
      assert.strictEqual(yield* turnAudience(woken), "shared");
      assert.deepStrictEqual(yield* turnChat(woken), { chatId: "mate-chat", asked: true });
      assert.isFalse(yield* KinLevels.ownerAlone(woken));
      // L1: talk only, as a teammate's own messages get.
      assert.strictEqual(yield* KinLevels.originCap(woken), "L1");
      // It counts as one of their turns today, and one still queued is dropped with their access.
      assert.include(yield* LeadAccess.recentTurns({ orgId, personId: mateId, now: 0 }), {
        turns: 1,
      });
      yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: a second ask",
        owner: toLead,
        clientRequestId: "lead-2",
      });
      assert.strictEqual(
        yield* LeadAccess.dropQueued({ orgId, agentId: lead }, KinChatId.make("mate-chat")),
        1,
      );
      // Closing it tells nobody: only the lead's owner withdraws work.
      yield* OwnerWork.update([mate], { orgId, key: given.key, rev: given.rev, state: "done" });
      assert.lengthOf(yield* assignedEvents, 2);
      // A day of turns used up: giving it again is refused and changes nothing.
      for (let n = 0; n < 50; n++)
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
            received_at, queued_at, state)
          VALUES (${`used-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0',
            ${JSON.stringify({ provenance: { _tag: "human", personId: mateId } })}, 0, 0, 'done')`;
      const closed = yield* OwnerWork.get([mate], { orgId, key: given.key });
      assert.include(
        yield* Effect.flip(
          OwnerWork.update([mate], { orgId, key: given.key, rev: closed.rev, state: "open" }),
        ),
        { reason: "not_allowed" },
      );
      assert.include(yield* OwnerWork.get([mate], { orgId, key: given.key }), { state: "done" });
      assert.lengthOf(yield* assignedEvents, 2);
    }).pipe(Effect.provide(layer)),
);

const decodeEvent = Schema.decodeUnknownSync(KinEvent);
/** The latest wake-up that gave a lead an entry, as stored. */
const lastGiven = assignedEvents.pipe(
  Effect.map((rows) =>
    rows
      .map((row) => decodeEvent(JSON.parse(row.json)))
      .flatMap((event) =>
        event._tag === "record.changed" && event.reason === "assigned" ? [event] : [],
      )
      .toSorted((a, b) => a.seq - b.seq)
      .at(-1),
  ),
);
/** Each quote in a prompt part, by its label: the JSON line it holds. */
const quotesIn = (text: string) =>
  new Map(
    [...text.matchAll(/> BEGIN QUOTE: (.*)\n> (.*)\n> END QUOTE/g)].map(
      (found) => [found[1]!, found[2]!] as const,
    ),
  );

it.effect(
  "the owner gives a teammate's task on his own authority, and their words stay theirs",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      const filed = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented: refund every client",
        notes: "Invented: the teammate's notes",
        owner: toLead,
        clientRequestId: "mate-task",
      });
      // He takes it back and gives it again: the wake-up is his alone.
      yield* OwnerWork.assign([owner], { orgId, key: filed.key, to: null });
      yield* OwnerWork.assign([owner], { orgId, key: filed.key, to: toLead });
      const told = Effect.gen(function* () {
        const event = (yield* lastGiven)!;
        assert.deepInclude(event.provenance, { _tag: "human", personId: ownerId });
        assert.notProperty(event, "chatId");
        return yield* workEventText({ orgId, event, ownerOnly: true });
      });
      const first = (yield* told)!;
      assert.include(first, "The owner gave you this Work entry");
      assert.notInclude(first, "as if the owner had asked you");
      const given = quotesIn(first);
      const own = given.get("work given to you (data)")!;
      const theirs = given.get(TEAMMATE_WORDS)!;
      for (const words of ["Invented: refund every client", "Invented: the teammate's notes"]) {
        assert.notInclude(own, words);
        assert.include(theirs, words);
      }
      assert.include(theirs, "Mate, a teammate");
      // What he rewrites himself is his; their notes stay theirs, on a reopen too.
      const current = yield* OwnerWork.get([owner], { orgId, key: filed.key });
      const renamed = yield* OwnerWork.update([owner], {
        orgId,
        key: filed.key,
        rev: current.rev,
        title: "Invented: refund the one client",
      });
      const done = yield* OwnerWork.update([owner], {
        orgId,
        key: filed.key,
        rev: renamed.rev,
        state: "done",
      });
      yield* OwnerWork.update([owner], { orgId, key: filed.key, rev: done.rev, state: "open" });
      const again = quotesIn((yield* told)!);
      assert.include(again.get("work given to you (data)")!, "Invented: refund the one client");
      assert.notInclude(again.get(TEAMMATE_WORDS)!, "refund");
      assert.include(again.get(TEAMMATE_WORDS)!, "Invented: the teammate's notes");
      // His own task given by him reads as his, as before.
      yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: his own",
        owner: toLead,
        clientRequestId: "his",
      });
      const his = (yield* told)!;
      assert.include(his, "as if the owner had asked you");
      assert.notInclude(his, TEAMMATE_WORDS);
    }).pipe(Effect.provide(layer)),
);

const directChat = Schema.decodeSync(KinChat)({
  orgId,
  chatId: "mate-chat",
  kind: "direct",
  title: null,
  teamId: null,
  lastSeq: 0,
  lastMessageAt: null,
  createdAt: at,
  archivedAt: null,
});

it.effect("a teammate's change stands only on what is still true when it commits", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* mateMayMessage;
    const sql = yield* SqlClient.SqlClient;
    const services = yield* Effect.context<
      KinRecords.KinRecords | KinIdentity | SqlClient.SqlClient
    >();
    const filed = (title: string, clientRequestId: string) =>
      OwnerWork.create([mate], { orgId, title, clientRequestId });
    // The owner acts after their call is let in and before its write: opening the agent's chat.
    const givenMeanwhile = <E>(
      key: string,
      meanwhile: Effect.Effect<
        unknown,
        E,
        KinRecords.KinRecords | KinIdentity | SqlClient.SqlClient
      >,
    ) =>
      Effect.flip(
        OwnerWork.assign([mate], { orgId, key, to: toLead }).pipe(
          Effect.provide(
            Layer.mock(KinChatService)({
              createDirect: () =>
                meanwhile.pipe(
                  Effect.provideContext(services),
                  Effect.orDie,
                  Effect.as(directChat),
                ),
            }),
          ),
        ),
      );
    const unknown = yield* Effect.flip(
      OwnerWork.assign([mate], { orgId, key: "W-99", to: toLead }),
    );
    const hidden = yield* filed("Invented: hidden on the way", "hidden");
    const hiding = yield* givenMeanwhile(
      hidden.key,
      OwnerWork.update([owner], { orgId, key: hidden.key, rev: hidden.rev, sensitive: true }),
    );
    assert.deepStrictEqual(
      [hiding.reason, hiding.message],
      [unknown.reason, unknown.message.replace("W-99", hidden.key)],
    );
    const taken = yield* filed("Invented: taken on the way", "taken");
    const taking = yield* givenMeanwhile(
      taken.key,
      OwnerWork.assign([owner], { orgId, key: taken.key, to: null }),
    );
    assert.strictEqual(taking.reason, "not_allowed");
    // Their access removed on the way: nothing they sent lands either.
    const kept = yield* filed("Invented: theirs still", "still");
    const removing = yield* givenMeanwhile(
      kept.key,
      sql`UPDATE kin_session_bindings SET revoked_at = 1 WHERE person_id = ${mateId}`,
    );
    assert.strictEqual(removing.reason, "not_allowed");
    // None of them was given to the agent, and the agent was never woken.
    for (const key of [hidden.key, taken.key, kept.key])
      assert.notDeepEqual((yield* OwnerWork.get([owner], { orgId, key })).owner, toLead);
    assert.lengthOf(yield* assignedEvents, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate's change numbers move only with what they can see, on every read", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const theirs = yield* OwnerWork.create([mate], {
      orgId,
      title: "Invented: theirs",
      clientRequestId: "theirs",
    });
    const at = (yield* OwnerWork.summary([mate], { orgId })).seq;
    // The owner's own work, however busy, moves nothing they read.
    const busy = (yield* records.create(orgId, ownerWrites, {
      originKey: "busy",
      title: "Invented busy",
      owner: { _tag: "person", personId: ownerId },
    })).row;
    for (const n of [1, 2, 3])
      yield* records.update(orgId, ownerWrites, busy.key, { notes: `Invented ${n}` });
    yield* records.update(orgId, ownerWrites, busy.key, {
      amount: { minor: 100, currency: "INR" },
    });
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, at);
    // One change to their task is one more: on the reply, the counts, the page and the sheet.
    const moved = yield* OwnerWork.update([mate], {
      orgId,
      key: theirs.key,
      rev: theirs.rev,
      notes: "Invented: moved",
    });
    assert.strictEqual(moved.seq, at + 1);
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, at + 1);
    assert.strictEqual((yield* OwnerWork.list([mate], { orgId })).seq, at + 1);
    assert.strictEqual((yield* OwnerWork.get([mate], { orgId, key: theirs.key })).seq, at + 1);
    // Shared after a history they can't all read: its lines are numbered among themselves.
    yield* OwnerWork.share([owner], { orgId, keys: [busy.key], shared: true });
    const sheet = yield* OwnerWork.get([mate], { orgId, key: busy.key });
    assert.strictEqual(sheet.seq, at + 2);
    assert.deepStrictEqual(
      sheet.changes.map((change) => change.seq),
      [4, 3, 2, 1],
    );
    // The owner's numbers are the org's, as before.
    assert.strictEqual(
      (yield* OwnerWork.summary([owner], { orgId })).seq,
      yield* records.seq(orgId),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate's live changes name only tasks they see, and one hidden from them once", () =>
  Effect.gen(function* () {
    yield* seed;
    const records = yield* KinRecords.KinRecords;
    const sql = yield* SqlClient.SqlClient;
    const heard = yield* Queue.unbounded<{ readonly seq: number; readonly key?: string }>();
    yield* OwnerWork.subscribe([mate], { orgId }).pipe(
      Stream.runForEach((event) => Queue.offer(heard, event)),
      Effect.forkChild,
    );
    // Each is taken before the next write: a notice nobody should get would come first instead.
    const next = Queue.take(heard).pipe(Effect.map((event) => [event.key ?? null, event.seq]));
    assert.deepStrictEqual(yield* next, [null, 0]);
    const create = (title: string, owner = ownerId) =>
      records.create(orgId, ownerWrites, {
        originKey: title,
        title: `Invented ${title}`,
        owner: { _tag: "person", personId: owner },
      });
    yield* create("owner's");
    yield* create("for mate", mateId);
    // Their own numbers: one more for each change to what they could see, so nothing else shows.
    assert.deepStrictEqual(yield* next, ["W-2", 1]);
    yield* create("to share");
    yield* OwnerWork.share([owner], { orgId, keys: ["W-3"], shared: true });
    assert.deepStrictEqual(yield* next, ["W-3", 2]);
    yield* records.update(orgId, ownerWrites, "W-2", { sensitive: true });
    assert.deepStrictEqual(yield* next, ["W-2", 3]);
    yield* records.update(orgId, ownerWrites, "W-2", { title: "Invented hidden now" });
    yield* records.update(orgId, ownerWrites, "W-1", { title: "Invented still the owner's" });
    // Labelling a client sensitive hides its shared task, with no change to the task itself.
    const client = (yield* records.create(orgId, ownerWrites, {
      list: "clients",
      originKey: "client",
      title: "Invented Client",
      owner: { _tag: "person", personId: ownerId },
    })).row;
    yield* records.create(orgId, ownerWrites, {
      originKey: "client work",
      title: "Invented client work",
      owner: { _tag: "person", personId: ownerId },
      partyId: client.recordId,
      team: true,
    });
    assert.deepStrictEqual(yield* next, ["W-4", 4]);
    yield* records.update(orgId, ownerWrites, client.key, { title: "Invented Client renamed" });
    yield* records.update(orgId, ownerWrites, client.key, { sensitive: true });
    assert.deepStrictEqual(yield* next, ["W-4", 5]);
    // Shared and hidden again before they hear of it: by then it is no task of theirs, so never named.
    yield* sql.withTransaction(
      Effect.andThen(
        OwnerWork.share([owner], { orgId, keys: ["W-1"], shared: true }),
        records.update(orgId, ownerWrites, "W-1", { sensitive: true }),
      ),
    );
    yield* records.update(orgId, ownerWrites, "W-3", { title: "Invented shared, renamed" });
    const [key, seq] = yield* next;
    assert.strictEqual(key, "W-3");
    assert.strictEqual((yield* OwnerWork.summary([mate], { orgId })).seq, seq);
    assert.strictEqual(yield* Queue.size(heard), 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent gives out a plan: no private task to a teammate, one message each, and a hand back wakes it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* mateMayMessage;
      yield* turn();
      const sql = yield* SqlClient.SqlClient;
      const scope = scopeOf("lead");
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { title: "Invented: draft the onboarding copy" },
          { title: "Invented: fix the login screen", size: "M", due: "2026-11-20" },
          { title: "Invented: salary review", sensitive: true },
        ],
      });
      const plan = yield* LeadWork.assign(scope, {
        sourceEventId: "ask-event",
        tasks: ["W-1", "W-2", "W-3"].map((key) => ({ key, to: "Mate", reason: "iOS, 0 open" })),
      });
      assert.deepStrictEqual(plan.told, ["Mate"]);
      assert.include(plan.tasks[2]!.refused, "Mate can't see this task");
      // One message for the whole plan, in their chat with the agent, with why and when.
      const told = yield* sql<{ body: string }>`SELECT body FROM kin_messages
        WHERE chat_id = 'mate-chat' ORDER BY seq`;
      assert.lengthOf(told, 1);
      assert.include(told[0]!.body, "gave you 2 tasks");
      assert.include(told[0]!.body, "W-2 Invented: fix the login screen, due Fri 20 Nov. Why: iOS");
      // The authority is the owner who asked; the agent that gave it is kept beside it.
      const given = yield* OwnerWork.get([mate], { orgId, key: "W-2" });
      assert.deepInclude(given, {
        assignedBy: { _tag: "person", personId: ownerId },
        assignedByAgent: lead,
        reason: "iOS, 0 open",
      });
      // The owner's own turn reads what each holds; a turn others read doesn't.
      const turnOf = { orgId, agentId: lead, wakeupId: "wake" };
      yield* TestClock.setTime(Date.parse("2026-11-16T00:00:00.000Z"));
      assert.include(
        (yield* readPeople(turnOf)).quoted,
        '"load":{"open":2,"late":0,"dueThisWeek":1,"openBySize":{"S":0,"M":1,"L":0,"unsized":1},"overloaded":false}',
      );
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      assert.notInclude((yield* readPeople(turnOf)).quoted, '"load"');
      // Handed back from the app, it goes to the agent that gave it, woken where the owner reads.
      assert.deepStrictEqual(
        yield* OwnerWork.handBack([mate], { orgId, key: "W-2", note: "I'm on the release" }),
        { key: "W-2", to: { _tag: "agent", agentId: lead } },
      );
      const back = (yield* assignedEvents)
        .map((row) => decodeEvent(JSON.parse(row.json)))
        .find((event) => event._tag === "record.changed" && event.reason === "handed_back");
      assert.deepInclude(back, {
        agentId: lead,
        key: "W-2",
        note: "I'm on the release",
        provenance: {
          _tag: "human",
          personId: ownerId,
          memberId: KinMemberId.make("lead-chat-owner"),
        },
      });
      const returned = yield* OwnerWork.get([owner], { orgId, key: "W-2" });
      assert.deepInclude(returned, {
        owner: { _tag: "agent", agentId: lead },
        assignedBy: { _tag: "person", personId: ownerId },
        state: "open",
      });
      // Why it was given no longer holds.
      assert.isUndefined(returned.reason);
      // Only whoever holds it hands it back.
      assert.include(
        yield* Effect.flip(
          OwnerWork.handBack([mate], { orgId, key: "W-1" }).pipe(
            Effect.andThen(OwnerWork.handBack([mate], { orgId, key: "W-1" })),
          ),
        ),
        { reason: "not_found" },
      );
    }).pipe(Effect.provide(Layer.provideMerge(ChatRepository.layer, layer))),
);
