// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadMoney from "./leadMoney.ts";
import * as LeadWork from "./leadWork.ts";
import { KinWorkToolkit } from "./mcp/tools.ts";
import * as Clients from "./ownerClients.ts";
import * as OwnerWork from "./ownerWork.ts";
import { effectivelySensitive } from "./recordRows.ts";
import { PRESETS } from "./registers.ts";
import { buildWorkSection } from "./workPrompt.ts";

// Invented org, people, clients and work only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const owner = { _tag: "person" as const, orgId, personId: ownerId };
const mate = { _tag: "person" as const, orgId, personId: mateId };
const DAY = 24 * 60 * 60 * 1000;
type Services = KinIdentity | KinLevelGate | KinRecords.KinRecords | SqlClient.SqlClient;

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  issuedAt: 0,
  capabilities: new Set(),
  client: undefined,
  thread: {
    threadId: ThreadId.make("lead-thread"),
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
};
const identity = Layer.mock(KinIdentity)({
  owner,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: lead,
      ownerPersonId: ownerId,
      threadId: ThreadId.make("lead-thread"),
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
);

/** The owner, a teammate, one lead with its direct chat, and a running turn the owner woke. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at}), ('elsewhere', 'Other', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'owner', 'Owner', ${at}), (${mateId}, ${orgId}, 'mate', 'Mate', ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at, retired_at) VALUES (${lead}, ${orgId}, 'Lead lead', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 1, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Lead lead', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
      author_member_id, author_role, kind, body, mentions_json, status, created_at)
    VALUES ('ask', ${orgId}, 'lead-chat', 1, 'human', ${ownerId}, 'lead-chat-owner', 'owner',
      'text', 'Set up the invented client', '[]', 'posted', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status,
      event_ids, audience)
    VALUES ('wake', ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running', '["ask-event"]', 'owner_only')`;
  for (const eventId of ["ask-event", "again-event"]) {
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId: ownerId, memberId: "lead-chat-owner" },
      chatId: "lead-chat",
      messageId: "ask",
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      VALUES (${eventId}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
        'claimed', 'wake')`;
  }
});

/** "Set up Acme from this contract": one call, client first, then its people and obligations. */
const setup = (sourceEventId: string) =>
  LeadWork.create(scope, {
    sourceEventId,
    records: [
      { list: "clients", title: "Invented Acme", terms: "Invented retainer, monthly" },
      { list: "contacts", title: "Invented Mira", client: "Invented Acme", role: "marketing" },
      {
        list: "contacts",
        title: "Invented Ravi",
        client: "invented acme",
        email: "ravi@x.invalid",
      },
      {
        list: "projects",
        title: "Invented site",
        client: "Invented Acme",
        due: "1970-01-31",
        repos: ["invented/site"],
      },
      { title: "Invented monthly report", client: "Invented Acme", due: "1970-01-05" },
      { title: "Invented homepage copy", client: "Invented Acme", due: "1970-01-03" },
      { title: "Invented report, no date", client: "Invented Acme" },
      {
        title: "Invented brand assets",
        client: "Invented Acme",
        side: "theirs",
        owner: "owner",
        due: "1970-01-02",
      },
      { title: "Invented signed SOW", client: "Invented Acme", side: "theirs", due: "1970-01-09" },
      { title: "Invented launch checklist", project: "Invented site", due: "1970-01-04" },
    ],
  });

it.effect(
  "a lead sets up a client, its contacts and both-way obligations in one idempotent call",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const first = yield* setup("ask-event");
      assert.deepStrictEqual(
        first.records.map((row) => [row.key, row.created]),
        [
          ["C-1", true],
          ["CT-1", true],
          ["CT-2", true],
          ["P-1", true],
          ["W-1", true],
          ["W-2", true],
          ["W-3", true],
          ["W-4", true],
          ["W-5", true],
          ["W-6", true],
        ],
      );
      // A retry makes nothing; setting the same client up from another message finds it.
      assert.isTrue((yield* setup("ask-event")).records.every((row) => !row.created));
      const again = yield* LeadWork.create(scope, {
        sourceEventId: "again-event",
        records: [
          { list: "clients", title: "invented acme" },
          { list: "contacts", title: "Invented Mira", client: "C-1" },
        ],
      });
      assert.deepStrictEqual(
        again.records.map((row) => [row.key, row.created]),
        [
          ["C-1", false],
          ["CT-1", false],
        ],
      );
      // The project's entry takes the project's client.
      assert.include(yield* LeadWork.get(scope, { key: "W-6" }), {
        client: "Invented Acme (C-1)",
        project: "Invented site (P-1)",
      });
      // "What do we owe Acme": filter by client and side, and count per side.
      const owed = yield* LeadWork.query(scope, {
        client: "Invented Acme",
        side: "ours",
        open: true,
        groupBy: "side",
      });
      assert.deepStrictEqual(
        owed.records.map((row) => row.key),
        ["W-2", "W-6", "W-1", "W-3"],
      );
      const bySide = yield* LeadWork.query(scope, { client: "C-1", groupBy: "side" });
      assert.sameDeepMembers(
        [...bySide.groups!],
        [
          { group: "ours", count: 4, late: 0 },
          { group: "theirs", count: 2, late: 0 },
        ],
      );
      // Contacts and the client itself, with what each side owes.
      const client = yield* LeadWork.get(scope, { key: "C-1" });
      assert.include(client, {
        list: "clients",
        kind: "client",
        terms: "Invented retainer, monthly",
      });
      assert.deepStrictEqual(client.owed, { weOwe: 4, theyOwe: 2, late: 0, overdue: 0 });
      assert.deepStrictEqual(
        client.contacts!.map((row) => [row.title, row.role ?? row.email]),
        [
          ["Invented Mira", "marketing"],
          ["Invented Ravi", "ravi@x.invalid"],
        ],
      );
      assert.deepStrictEqual(client.projects, [
        { key: "P-1", title: "Invented site", health: "on_track" },
      ]);
      // Fields a list doesn't have, and a client that isn't there, are refused with nothing written.
      for (const records of [
        [{ title: "Invented", email: "a@x.invalid" }],
        [{ list: "contacts" as const, title: "Invented orphan" }],
        [{ title: "Invented", client: "Invented Nobody" }],
        [{ list: "clients" as const, title: "Invented Beta", state: "doing" as const }],
      ])
        assert.include(
          yield* Effect.flip(LeadWork.create(scope, { sourceEventId: "again-event", records })),
          { _tag: "KinChatError" },
        );
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_records`, 10);
      // The lead leads the project it made, which is not work in hand: only its five entries count.
      const section = yield* buildWorkSection({
        orgId,
        agentId: lead,
        chatId: "lead-chat" as never,
        now: 0,
      });
      assert.strictEqual(section.open, 5);
    }).pipe(Effect.provide(layer)),
);

it.effect("the client page shows both directions, its contacts, projects and one history", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* setup("ask-event");
    yield* TestClock.adjust(2.5 * DAY);
    const page = yield* Clients.party([owner], { orgId, key: "C-1" });
    assert.include(page.party, {
      key: "C-1",
      name: "Invented Acme",
      kind: "client",
      active: true,
      weOwe: 4,
      theyOwe: 2,
      late: 0,
      overdue: 1,
      terms: "Invented retainer, monthly",
    });
    assert.deepStrictEqual(page.party.sensitiveFields, ["terms"]);
    assert.deepInclude(page.party.next, { key: "W-2", late: false });
    // We owe: soonest first, undated last. They owe: overdue first.
    assert.deepStrictEqual(
      page.weOwe.records.map((record) => record.key),
      ["W-2", "W-6", "W-1", "W-3"],
    );
    assert.deepStrictEqual(
      page.theyOwe.records.map((record) => [record.key, record.late]),
      [
        ["W-4", true],
        ["W-5", false],
      ],
    );
    assert.deepStrictEqual(
      page.contacts.map((contact) => [contact.key, contact.name, contact.sensitiveFields]),
      [
        ["CT-1", "Invented Mira", ["email", "phone"]],
        ["CT-2", "Invented Ravi", ["email", "phone"]],
      ],
    );
    assert.deepStrictEqual(
      page.projects.map((project) => [project.key, project.health, project.open]),
      [["P-1", "on_track", 1]],
    );
    // The history is the change log of the client and everything pointing at it, newest first.
    yield* OwnerWork.update([owner], { orgId, key: "W-2", rev: 1, state: "done" });
    const first = yield* Clients.history([owner], { orgId, key: "C-1", limit: 3 });
    assert.deepStrictEqual(
      first.items.map((item) => [item.record.key, item.record.list, item.kind]),
      [
        ["W-2", "work", "updated"],
        ["W-6", "work", "created"],
        ["W-5", "work", "created"],
      ],
    );
    const rest = yield* Clients.history([owner], { orgId, key: "C-1", cursor: first.nextCursor! });
    assert.deepStrictEqual(
      rest.items.map((item) => item.record.key),
      ["W-4", "W-3", "W-2", "W-1", "P-1", "CT-2", "CT-1", "C-1"],
    );
    assert.isNull(rest.nextCursor);
    // The Work screen's groupings and the directory read the same counts.
    const summary = yield* OwnerWork.summary([owner], { orgId });
    assert.include(summary, { open: 5 });
    assert.deepInclude(summary.parties![0], { weOwe: 3, theyOwe: 2, late: 0, overdue: 1 });
    assert.deepInclude(summary.projects![0], { open: 1, late: 0, health: "on_track" });
    const directory = yield* Clients.parties([owner], { orgId });
    assert.deepStrictEqual(
      directory.parties.map((row) => [row.key, row.weOwe]),
      [["C-1", 3]],
    );
    // The list filters by client and project, and its rows name them.
    const listed = yield* OwnerWork.list([owner], { orgId, party: "C-1", side: "theirs" });
    assert.deepStrictEqual(
      listed.records.map((record) => [record.key, record.party?.key]),
      [
        ["W-4", "C-1"],
        ["W-5", "C-1"],
      ],
    );
    assert.deepStrictEqual(
      (yield* OwnerWork.list([owner], { orgId, project: "P-1" })).records.map((r) => r.key),
      ["W-6"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("project health moves on read as entries go late or wait, with no turn", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const project = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented app",
      targetAt: "1970-01-20",
      targetAllDay: true,
      repos: ["invented/app"],
      clientRequestId: "p",
    });
    const entry = (title: string, dueAt: string | undefined, id: string) =>
      OwnerWork.create([owner], {
        orgId,
        title,
        project: project.key,
        category: "issue",
        repo: "invented/app",
        clientRequestId: id,
        ...(dueAt === undefined ? {} : { dueAt }),
      });
    const soon = yield* entry("Invented login bug", "1970-01-03T00:00:00.000Z", "a");
    const later = yield* entry("Invented docs", "1970-01-10T00:00:00.000Z", "b");
    const status = Clients.project([owner], { orgId, key: project.key });
    const first = yield* status;
    assert.include(first.project, { health: "on_track", open: 2, late: 0 });
    assert.deepStrictEqual(first.project.repos, ["invented/app"]);
    assert.strictEqual(first.nextDue?.key, soon.key);
    // A day after the bug's due date it is late, so the project is at risk; nobody typed that.
    yield* TestClock.adjust(4 * DAY);
    const risky = yield* status;
    assert.include(risky.project, { health: "at_risk", late: 1 });
    assert.deepInclude(risky.project.healthBecause, { late: 1, targetPassed: false });
    assert.strictEqual(risky.nextDue?.key, later.key);
    // The bug is fixed; the docs wait on the owner for more than a week.
    yield* OwnerWork.update([owner], { orgId, key: soon.key, rev: soon.rev, state: "done" });
    yield* OwnerWork.update([owner], {
      orgId,
      key: later.key,
      rev: later.rev,
      state: "waiting",
      waitingOn: { _tag: "person", personId: ownerId },
      dueAt: null,
    });
    assert.include((yield* status).project, { health: "on_track" });
    yield* TestClock.adjust(8 * DAY);
    const waited = yield* status;
    assert.include(waited.project, { health: "at_risk" });
    assert.deepInclude(waited.project.healthBecause, { waitingOverAWeek: 1 });
    assert.deepStrictEqual(
      waited.blocked.map((row) => [row.record.key, row.on, row.since]),
      [[later.key, { _tag: "person", personId: ownerId }, "1970-01-05T00:00:00.000Z"]],
    );
    assert.deepInclude(waited.counts, { open: 0, waiting: 1, done: 1, late: 0 });
    // A pull request on an open entry shows; the target date passing makes it late.
    yield* sql`INSERT INTO kin_record_links (org_id, record_id, kind, target, relation, created_at)
      VALUES (${orgId}, ${later.recordId}, 'pull_request', 'https://github.com/invented/app/pull/9',
        'relates', 0)`;
    yield* TestClock.adjust(8 * DAY);
    const overdue = yield* status;
    assert.include(overdue.project, { health: "late" });
    assert.deepStrictEqual(
      overdue.pullRequests.map((pull) => [pull.number, pull.record.key]),
      [[9, later.key]],
    );
    assert.deepStrictEqual(
      (yield* OwnerWork.list([owner], { orgId, repo: "invented/app" })).total,
      2,
    );
    // What changed in the last seven days: nothing since the waiting change.
    assert.strictEqual(overdue.changedThisWeek.total, 0);
    // Done is refused while an entry is still open in it; then allowed; then reopened.
    assert.include(
      yield* Effect.flip(
        Clients.updateProject([owner], { orgId, key: project.key, rev: 1, state: "done" }),
      ),
      { reason: "invalid_state" },
    );
    const current = yield* OwnerWork.get([owner], { orgId, key: later.key });
    yield* OwnerWork.update([owner], { orgId, key: later.key, rev: current.rev, state: "dropped" });
    const done = yield* Clients.updateProject([owner], {
      orgId,
      key: project.key,
      rev: 1,
      state: "done",
    });
    assert.include(done, { state: "done", health: null });
    assert.include(
      yield* Clients.updateProject([owner], { orgId, key: project.key, rev: 2, state: "open" }),
      { state: "open" },
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "the owner edits clients and contacts by revision, field by field, and closes by rule",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const created = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Juniper",
        kind: "vendor",
        clientRequestId: "j",
      });
      assert.include(created, {
        key: "C-1",
        kind: "vendor",
        active: true,
        terms: null,
        address: null,
      });
      // A retry is the same client; another of the same name is refused, naming the one there.
      assert.include(
        yield* Clients.createParty([owner], {
          orgId,
          name: "Invented Juniper",
          kind: "vendor",
          clientRequestId: "j",
        }),
        { key: "C-1" },
      );
      // QA Q16: the same request id with other words was taken as saved, as chat refuses.
      assert.include(
        yield* Effect.flip(
          Clients.createParty([owner], { orgId, name: "x", clientRequestId: "j" }),
        ),
        { reason: "not_allowed" },
      );
      assert.include(
        yield* Effect.flip(
          Clients.createParty([owner], { orgId, name: "invented juniper", clientRequestId: "k" }),
        ),
        { reason: "conflict" },
      );
      const edited = yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: 1,
        kind: "client",
        terms: "Invented net 30",
        address: "12 Invented Road, Pune 411001",
      });
      assert.include(edited, {
        rev: 2,
        kind: "client",
        terms: "Invented net 30",
        address: "12 Invented Road, Pune 411001",
      });
      assert.include(
        yield* Clients.updateParty([owner], {
          orgId,
          key: "C-1",
          rev: 1,
          terms: "Invented net 30",
        }),
        { rev: 2 },
      );
      assert.include(
        yield* Effect.flip(
          Clients.updateParty([owner], { orgId, key: "C-1", rev: 1, name: "Invented other" }),
        ),
        { reason: "conflict" },
      );
      const history = yield* Clients.history([owner], { orgId, key: "C-1" });
      assert.deepStrictEqual(history.items[0]!.fields, [
        { field: "terms", from: null, to: "Invented net 30" },
        { field: "address", from: null, to: "12 Invented Road, Pune 411001" },
        { field: "category", from: "vendor", to: "client" },
      ]);
      assert.deepStrictEqual(history.items[0]!.by, { _tag: "person", personId: ownerId });
      const contact = yield* Clients.createContact([owner], {
        orgId,
        party: "C-1",
        name: "Invented Ana",
        phone: "000",
        clientRequestId: "c",
      });
      assert.include(contact, { key: "CT-1", phone: "000", email: null, active: true });
      assert.include(
        yield* Clients.updateContact([owner], { orgId, key: "CT-1", rev: 1, phone: null }),
        { phone: null, rev: 2 },
      );
      // An entry for the client: its client, project and side are the owner's to set and clear.
      const entry = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented pay the invoice",
        party: "C-1",
        clientRequestId: "e",
      });
      assert.deepInclude(entry, {
        party: { recordId: created.recordId, key: "C-1", title: "Invented Juniper" },
      });
      const theirs = yield* OwnerWork.update([owner], {
        orgId,
        key: entry.key,
        rev: 1,
        side: "theirs",
      });
      assert.include(theirs, { side: "theirs" });
      // Closing the client is refused while its entry is open; the entry moves off, then it closes.
      assert.include(
        yield* Effect.flip(
          Clients.updateParty([owner], { orgId, key: "C-1", rev: 2, active: false }),
        ),
        { reason: "invalid_state" },
      );
      const moved = yield* OwnerWork.update([owner], {
        orgId,
        key: entry.key,
        rev: 2,
        party: null,
      });
      assert.notProperty(moved, "party");
      const closed = yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: 2,
        active: false,
      });
      assert.include(closed, { active: false });
      assert.isNotNull(closed.closedAt);
      assert.lengthOf((yield* Clients.parties([owner], { orgId })).parties, 0);
      assert.lengthOf((yield* Clients.parties([owner], { orgId, active: false })).parties, 1);
      const reopened = yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: 3,
        active: true,
      });
      assert.include(reopened, { active: true, closedAt: null });
      // A key from the wrong list, and another org's client, are not found.
      const wrongList: ReadonlyArray<Effect.Effect<unknown, KinChatError, Services>> = [
        Clients.updateParty([owner], { orgId, key: entry.key, rev: 1, name: "x" }),
        Clients.party([owner], { orgId, key: "CT-1" }),
        OwnerWork.update([owner], { orgId, key: "C-1", rev: 4, title: "x" }),
        OwnerWork.create([owner], { orgId, title: "x", party: "CT-1", clientRequestId: "z" }),
      ];
      for (const refused of wrongList)
        assert.include(yield* refused.pipe(Effect.asVoid, Effect.flip), { reason: "not_found" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
      VALUES ('elsewhere', 'clients', 'Clients', 'C', 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at)
      VALUES ('elsewhere', 'rec_elsewhere', 'clients', 'C-9', 'Invented Other Co', 'person', 'p',
        'person', 'x', 0, 0)`;
      assert.include(
        yield* Effect.flip(
          Clients.party([owner], { orgId, recordId: KinRecordId.make("rec_elsewhere") }),
        ),
        { reason: "not_found" },
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("every Work tool whose result shows the lead a sensitive entry marks its wake-up", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* setup("ask-event");
    yield* LeadWork.update(scope, { key: "C-1", sourceEventId: "ask-event", sensitive: true });
    // An invoices list as if defined, and an invoice for the payment row.
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(PRESETS.invoices)})`;
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [{ list: "invoices", title: "Invented October retainer", amount: "1 lakh" }],
    });
    // One row per tool the lead has: a tool added without one fails to typecheck and here.
    // A definition shows no entry, so proposing one marks nothing.
    const calls = {
      records_query: [LeadWork.query(scope, { keys: ["W-2"] }), true],
      record_get: [LeadWork.get(scope, { key: "W-2" }), true],
      // Setting up a client that exists returns it, and shows it, sensitive.
      record_create: [
        LeadWork.create(scope, {
          sourceEventId: "again-event",
          records: [{ list: "clients", title: "Invented Acme" }],
        }),
        true,
      ],
      record_update: [
        LeadWork.update(scope, {
          key: "W-2",
          sourceEventId: "ask-event",
          notes: "Invented note",
        }),
        true,
      ],
      list_define: [
        LeadMoney.define(scope, { sourceEventId: "ask-event", name: "Invented leave" }),
        false,
      ],
      payment_record: [
        LeadMoney.payment(scope, {
          sourceEventId: "ask-event",
          key: "INV-1",
          amount: "10,000",
          paidOn: "2026-11-11",
        }),
        true,
      ],
      money_summary: [LeadMoney.money(scope, {}), true],
      dates_query: [LeadMoney.datesQuery(scope, { from: "1970-01-01", to: "2030-12-31" }), true],
      company_profile: [LeadMoney.profile(scope, {}), true],
    } satisfies Record<
      keyof typeof KinWorkToolkit.tools,
      readonly [Effect.Effect<unknown, unknown, Services>, boolean]
    >;
    assert.deepStrictEqual(
      Object.keys(calls).toSorted(),
      Object.keys(KinWorkToolkit.tools).toSorted(),
    );
    for (const [tool, [call, marks]] of Object.entries(calls)) {
      yield* sql`DELETE FROM kin_wakeup_sensitive_reads`;
      yield* call;
      assert.deepStrictEqual(
        yield* sql`SELECT wakeup_id FROM kin_wakeup_sensitive_reads`,
        marks ? [{ wakeup_id: "wake" }] : [],
        tool,
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "what a turn shown something sensitive writes is labelled, and reading it marks a later turn",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const ownLabel = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => row!.sensitive));
      const plain = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented plain task" }, { title: "Invented second task" }],
      });
      const [first, second] = plain.records.map((row) => row.key);
      yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
      VALUES (${orgId}, 'wake', 0) ON CONFLICT DO NOTHING`;
      const written = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented follow-up on the figure" }],
      });
      yield* LeadWork.update(scope, { key: first!, sourceEventId: "ask-event", notes: "Invented" });
      // Marking a task done carries nothing it read.
      yield* LeadWork.update(scope, { key: second!, sourceEventId: "ask-event", state: "done" });
      assert.deepStrictEqual(
        [
          yield* ownLabel(written.records[0]!.key),
          yield* ownLabel(first!),
          yield* ownLabel(second!),
        ],
        [1, 1, 0],
      );
      // A later turn that reads it is marked as any sensitive read marks it.
      yield* sql`DELETE FROM kin_wakeup_sensitive_reads`;
      yield* LeadWork.get(scope, { key: written.records[0]!.key });
      assert.deepStrictEqual(yield* sql`SELECT wakeup_id FROM kin_wakeup_sensitive_reads`, [
        { wakeup_id: "wake" },
      ]);
      // Only the owner lowers it.
      const entry = yield* OwnerWork.get([owner], { orgId, key: first! });
      yield* OwnerWork.update([owner], { orgId, key: first!, rev: entry.rev, sensitive: false });
      assert.strictEqual(yield* ownLabel(first!), 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("a sensitive client or project labels what points at it; only the owner lowers it", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* setup("ask-event");
    yield* LeadWork.update(scope, { key: "C-1", sourceEventId: "ask-event", sensitive: true });
    yield* LeadWork.update(scope, {
      key: "C-1",
      sourceEventId: "ask-event",
      terms: "Invented fee",
    });
    const listed = yield* OwnerWork.list([owner], { orgId, party: "C-1" });
    assert.isTrue(listed.records.every((record) => record.sensitiveInherited === true));
    assert.isTrue(listed.records.every((record) => !record.sensitive));
    const page = yield* Clients.party([owner], { orgId, key: "C-1" });
    assert.isTrue(page.party.sensitive);
    assert.isTrue(page.contacts.every((contact) => contact.sensitive));
    assert.isTrue(page.projects.every((project) => project.sensitiveInherited));
    // The project's own entries inherit through the project too, and the lead reads them so.
    assert.include(yield* LeadWork.get(scope, { key: "W-6" }), { sensitive: true });
    // Every lead result says what is sensitive, as the owner's do: the entry and its fields.
    const client = yield* LeadWork.get(scope, { key: "C-1" });
    assert.deepInclude(client, { sensitive: true, sensitiveFields: ["terms"] });
    assert.include(
      client.history.find((change) => change.change.startsWith("terms")),
      {
        sensitive: true,
      },
    );
    assert.isTrue(
      client.contacts!.every(
        (row) => row.sensitive === true && row.sensitiveFields?.join() === "email,phone",
      ),
    );
    assert.deepStrictEqual(
      client.projects!.map((row) => row.sensitive),
      [true],
    );
    const contacts = yield* LeadWork.query(scope, { list: "contacts", groupBy: "client" });
    assert.isTrue(contacts.records.every((row) => row.sensitive && row.sensitiveFields?.length));
    assert.deepStrictEqual(contacts.groups, [
      { group: "Invented Acme (C-1)", count: 2, late: 0, sensitive: true },
    ]);
    const byOwner = yield* LeadWork.query(scope, { groupBy: "owner" });
    assert.isTrue(byOwner.groups!.every((group) => group.sensitive === undefined));
    // As a turn shown nothing sensitive: an unrelated entry stays plain.
    yield* (yield* SqlClient.SqlClient)`DELETE FROM kin_wakeup_sensitive_reads`;
    const made = yield* LeadWork.create(scope, {
      sourceEventId: "again-event",
      records: [
        { list: "contacts", title: "Invented Mira", client: "C-1" },
        { title: "Invented kickoff", client: "C-1" },
        { title: "Invented unrelated chore" },
      ],
    });
    assert.deepStrictEqual(
      made.records.map((row) => [row.created, row.sensitive, row.sensitiveFields]),
      [
        [false, true, ["email", "phone"]],
        [true, true, undefined],
        [true, undefined, undefined],
      ],
    );
    assert.include(
      yield* LeadWork.update(scope, { key: "W-2", sourceEventId: "ask-event", notes: "x" }),
      { sensitive: true },
    );
    const lowered = yield* Clients.updateParty([owner], {
      orgId,
      key: "C-1",
      rev: page.party.rev,
      sensitive: false,
    });
    assert.isFalse(lowered.sensitive);
    const after = yield* OwnerWork.get([owner], { orgId, key: "W-1" });
    assert.notProperty(after, "sensitiveInherited");
  }).pipe(Effect.provide(layer)),
);

it.effect("no lead write makes anything less sensitive; the owner's own may", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* setup("ask-event");
    const records = yield* KinRecords.KinRecords;
    const sensitive = (key: string) =>
      records
        .get(orgId, key)
        .pipe(Effect.flatMap((row) => effectivelySensitive(orgId, row!.recordId)));
    const ownLabel = (key: string) =>
      records.get(orgId, key).pipe(Effect.map((row) => row!.sensitive));
    // Each write as a turn shown nothing sensitive, so only Kin's own rules label anything here.
    const sql = yield* SqlClient.SqlClient;
    const unmarked = <A, E, R>(write: Effect.Effect<A, E, R>) =>
      Effect.andThen(sql`DELETE FROM kin_wakeup_sensitive_reads`, write);
    const update = (input: Omit<typeof LeadWork.UpdateInput.Type, "sourceEventId">) =>
      unmarked(LeadWork.update(scope, { ...input, sourceEventId: "ask-event" }));
    yield* update({ key: "C-1", sensitive: true });
    // W-6 is sensitive through its project's client; unlinking both keeps it so, as Kin's change.
    assert.isTrue(yield* sensitive("W-6"));
    const unlinked = yield* update({ key: "W-6", client: null, project: null });
    assert.deepInclude(unlinked, { changed: ["party", "project", "sensitive"], sensitive: true });
    const w6 = yield* LeadWork.get(scope, { key: "W-6" });
    assert.notProperty(w6, "client");
    assert.deepInclude(w6.history[0], { by: "Kin", change: "sensitive: true" });
    assert.isTrue(yield* sensitive("W-6"));
    // A project moved to another client, or off any, labels the project: its entries stay sensitive.
    yield* unmarked(
      LeadWork.create(scope, {
        sourceEventId: "again-event",
        records: [
          { list: "clients", title: "Invented Beta" },
          { list: "projects", title: "Invented app" },
          { list: "projects", title: "Invented api" },
          { title: "Invented app login", project: "Invented app" },
          { title: "Invented api keys", project: "Invented api" },
        ],
      }),
    );
    yield* update({ key: "P-2", client: "C-1" });
    yield* update({ key: "P-3", client: "C-1" });
    assert.isTrue(yield* sensitive("W-7"));
    assert.strictEqual(yield* ownLabel("P-2"), 0);
    yield* update({ key: "P-2", client: "Invented Beta" });
    yield* update({ key: "P-3", client: null });
    for (const key of ["P-2", "P-3"]) assert.strictEqual(yield* ownLabel(key), 1);
    for (const key of ["W-7", "W-8"]) {
      assert.isTrue(yield* sensitive(key));
      assert.strictEqual(yield* ownLabel(key), 0);
    }
    // A contact moved to another client, renames and closes keep it too; a repeat changes nothing.
    yield* update({ key: "CT-2", client: "Invented Beta" });
    assert.isTrue(yield* sensitive("CT-2"));
    yield* update({ key: "C-1", title: "Invented Acme Ltd" });
    yield* update({ key: "W-7", title: "Invented app sign-in", state: "done" });
    const again = yield* LeadWork.create(scope, {
      sourceEventId: "again-event",
      records: [{ list: "clients", title: "invented acme ltd" }],
    });
    assert.deepStrictEqual(again.records, [
      {
        key: "C-1",
        title: "Invented Acme Ltd",
        created: false,
        sensitive: true,
        sensitiveFields: ["terms"],
      },
    ]);
    for (const key of ["C-1", "W-7", "P-2"]) assert.isTrue(yield* sensitive(key));
    // The owner moving an entry off the client lowers it, as before: only they may.
    const w1 = yield* OwnerWork.get([owner], { orgId, key: "W-1" });
    yield* OwnerWork.update([owner], { orgId, key: "W-1", rev: w1.rev, party: null });
    assert.isFalse(yield* sensitive("W-1"));
    assert.strictEqual(yield* ownLabel("W-1"), 0);
    assert.isUndefined(yield* effectivelySensitive(orgId, "rec_missing"));
  }).pipe(Effect.provide(layer)),
);

it.effect("a teammate gets none of the client calls, and a client change ticks subscribers", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* setup("ask-event");
    const refusals: ReadonlyArray<
      Effect.Effect<
        unknown,
        KinChatError,
        KinIdentity | KinRecords.KinRecords | SqlClient.SqlClient
      >
    > = [
      Clients.parties([mate], { orgId }),
      Clients.party([mate], { orgId, key: "C-1" }),
      Clients.projects([mate], { orgId }),
      Clients.project([mate], { orgId, key: "P-1" }),
      Clients.history([mate], { orgId, key: "C-1" }),
      Clients.createParty([mate], { orgId, name: "x", clientRequestId: "m" }),
      Clients.updateParty([mate], { orgId, key: "C-1", rev: 1, name: "x" }),
      Clients.createContact([mate], { orgId, party: "C-1", name: "x", clientRequestId: "m" }),
      Clients.updateContact([mate], { orgId, key: "CT-1", rev: 1, name: "x" }),
      Clients.createProject([mate], { orgId, name: "x", clientRequestId: "m" }),
      Clients.updateProject([mate], { orgId, key: "P-1", rev: 1, name: "x" }),
    ];
    for (const refused of refusals)
      assert.include(yield* refused.pipe(Effect.asVoid, Effect.flip), { reason: "not_allowed" });
    const records = yield* KinRecords.KinRecords;
    const subscribed = yield* Deferred.make<void>();
    const ticks = yield* records.changes(orgId).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* Clients.updateParty([owner], { orgId, key: "C-1", rev: 1, name: "Invented Acme Ltd" });
    const [, tick] = yield* Fiber.join(ticks);
    assert.strictEqual(tick?.key, "C-1");
  }).pipe(Effect.provide(layer)),
);
