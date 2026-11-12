// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
import {
  AuthKinChatScope,
  EnvironmentId,
  KIN_WORK_WS_METHODS,
  KinAgentId,
  KinChatError,
  KinFinanceRpcs,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type MemoryItemHead,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { authorizeRpc } from "../../auth/RpcAuthorization.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { turnAudience, turnChat } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { sharedToolAllowed } from "../lead/SharedTools.ts";
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
      // Slice 5's list and money tools too: none of them is shared-safe yet.
      assert.lengthOf(Object.keys(KinWorkToolkit.tools), 9);
      for (const tool of Object.keys(KinWorkToolkit.tools))
        assert.isFalse(yield* sharedToolAllowed(shared, tool, {}), tool);
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
      // Every Work method: the clients, contacts and projects ones, lists, money, the profile,
      // issuing and voiding numbered entries, and receipts.
      const methods = [
        ...Object.values(KIN_WORK_WS_METHODS),
        ...KinFinanceRpcs.map((rpc) => rpc._tag),
      ];
      assert.lengthOf(methods, 33);
      for (const method of methods)
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
      for (const refused of [
        OwnerWork.update([mate], { orgId, key: created.key, rev: 5, title: "Invented" }),
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
      {
        reason: "not_allowed",
      },
    );
  }).pipe(Effect.provide(layer)),
);
