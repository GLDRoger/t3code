// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthKinChatScope,
  EnvironmentId,
  KinAgentId,
  type KinChatError,
  KinOrgId,
  KinPersonId,
  type MemoryItemHead,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { authorizeRpc } from "../../auth/RpcAuthorization.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnAudience, turnChat } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { importWork } from "./importWork.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadWork from "./leadWork.ts";
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
const layer = Layer.mergeAll(KinRecords.layer, identity).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

/** Two leads with direct chats with the owner, and a teammate. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}), (${mateId}, ${orgId}, 'mate', 'Mate', ${at})`;
  for (const agent of [lead, other]) {
    yield* sql`INSERT INTO kin_agents VALUES (${agent}, ${orgId}, ${`Lead ${agent}`}, 'lead', ${ownerId}, ${at}, NULL)`;
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
      // A teammate can't create or assign, and can't read Work yet.
      const refusals: ReadonlyArray<
        Effect.Effect<
          unknown,
          KinChatError,
          KinIdentity | KinRecords.KinRecords | SqlClient.SqlClient
        >
      > = [
        OwnerWork.assign([mate], { orgId, key: "W-1", to: { _tag: "agent", agentId: lead } }),
        OwnerWork.create([mate], { orgId, title: "Invented", clientRequestId: "mate-1" }),
        OwnerWork.list([mate], { orgId }),
        OwnerWork.get([mate], { orgId, key: "W-1" }),
        OwnerWork.summary([mate], { orgId }),
      ];
      for (const refused of refusals)
        assert.include(yield* refused.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
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

it.effect(
  "every Work tool is refused in a turn others read, and a chat-only session gets no RPC",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn("mate", "shared");
      const shared = { orgId, agentId: lead, wakeupId: "wake" };
      for (const tool of ["records_query", "record_get", "record_create", "record_update"])
        assert.isFalse(yield* sharedToolAllowed(shared, tool, {}), tool);
      assert.include(
        yield* Effect.flip(
          LeadWork.create(scopeOf(lead), { sourceEventId: "ask-event", records: steps }),
        ),
        { reason: "not_allowed" },
      );
      for (const method of [
        "kin.work.summary",
        "kin.work.list",
        "kin.work.get",
        "kin.work.subscribe",
        "kin.work.create",
        "kin.work.assign",
      ])
        assert.isTrue(
          (yield* Effect.exit(authorizeRpc([AuthKinChatScope], method, { orgId })))._tag ===
            "Failure",
          method,
        );
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
    // Run again, after someone moved one: nothing new, nothing overwritten.
    const promise = rows.find((row) => row.title === "Invented promise")!;
    yield* records.update(orgId, { actor: { _tag: "system" }, via: "owner" }, promise.key, {
      state: "done",
    });
    assert.deepStrictEqual(yield* importWork(orgId, items), { workers: 0, memory: 0 });
    assert.lengthOf((yield* records.query(orgId, {})).rows, 3);
    assert.include(yield* records.get(orgId, promise.key), { state: "done" });
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
