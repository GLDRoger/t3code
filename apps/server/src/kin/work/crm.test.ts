// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerConfig } from "../../config.ts";
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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
import * as LeadClients from "./leadClients.ts";
import * as LeadMoney from "./leadMoney.ts";
import * as LeadWork from "./leadWork.ts";
import { KinWorkToolkit } from "./mcp/tools.ts";
import * as Clients from "./ownerClients.ts";
import * as OwnerWork from "./ownerWork.ts";
import * as Docs from "./docs.ts";
import * as Search from "./search.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { sectionsOf } from "./docBody.ts";
import { milestoneRisk } from "./projectSpine.ts";
import { effectivelySensitive } from "./recordRows.ts";
import { presetDefinition } from "./registers.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "./teamView.ts";
import * as Touches from "./touches.ts";
import * as Comments from "./workComments.ts";
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
const isChatError = Schema.is(KinChatError);
type Services =
  | KinIdentity
  | KinLevelGate
  | KinRecords.KinRecords
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | ServerConfig;

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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-crm-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** The owner, a teammate, one lead with its direct chat, and a running turn the owner woke. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at}), ('elsewhere', 'Other', ${at})`;
  // The company's clock, which its due days follow, on any host.
  yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Asia/Kolkata', '08:00', '18:00', '02:00',
      0, 1, '09:00', '{}') ON CONFLICT (org_id) DO UPDATE SET time_zone = 'Asia/Kolkata'`;
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
  for (const eventId of ["ask-event", "again-event", "third-event"]) {
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
      // V06: a project that exists by name with new details is refused, not silently kept as it was.
      const project = { list: "projects" as const, title: "Invented site", client: "C-1" };
      const changed = yield* Effect.flip(
        LeadWork.create(scope, {
          sourceEventId: "again-event",
          records: [{ ...project, value: "6 lakh" }],
        }),
      );
      assert.strictEqual(
        changed.message,
        'P-1 "Invented site" exists already. To change its value, call record_update with key P-1.',
      );
      const [stored] = yield* (yield* SqlClient.SqlClient)<{ fields: string }>`SELECT fields_json
        AS fields FROM kin_records WHERE key = 'P-1'`;
      assert.notProperty(JSON.parse(stored!.fields), "value");
      const same = yield* LeadWork.create(scope, {
        sourceEventId: "again-event",
        records: [{ ...project, due: "1970-01-31", repos: ["invented/site"] }],
      });
      assert.deepStrictEqual(
        same.records.map((row) => [row.key, row.created]),
        [["P-1", false]],
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
      assert.deepStrictEqual(client.owed, {
        tasksWeOwe: 4,
        tasksTheyOwe: 2,
        tasksWeOweLate: 0,
        tasksTheyOweLate: 0,
        money: { unpaid: [], overdue: [], invoices: [] },
      });
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

// The company is UTC+14; the four TZ runs put the server 14, 8.5, 22 and 1 hours from it.
it.effect("a timed due is told on the company's day and clock, whatever the server's zone", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, 'Etc/GMT-14', '08:30', '18:30',
      '03:00', 0, 1, '09:00', '[]')`;
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [
        { list: "projects", title: "Invented booking app" },
        {
          list: "milestones",
          title: "Invented booking flow ready",
          project: "Invented booking app",
          due: "2026-12-04T10:16:00.000Z",
        },
      ],
    });
    const companyClock = "2026-12-05T00:16:00.000+14:00";
    assert.include(yield* LeadWork.get(scope, { key: "M-1" }), { due: companyClock });
    const dates = yield* LeadMoney.datesQuery(scope, { from: "2026-12-05", to: "2026-12-05" });
    assert.deepStrictEqual(
      dates.dates.map((one) => [one.key, one.on]),
      [["M-1", companyClock]],
    );
  }).pipe(Effect.provide(layer)),
);

// An all-day due is stored as the last millisecond of the company's day, its UTC day the next one
// west of UTC: the plan names the day the person picked, wherever the company is.
it.effect.each(["America/Los_Angeles", "Pacific/Auckland"])(
  "a project's plan names an all-day due on the day picked (%s)",
  (zone) =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_trigger_settings VALUES (${orgId}, ${zone}, '08:30', '18:30',
        '03:00', 0, 1, '09:00', '[]')`;
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { list: "projects", title: "Invented booking app" },
          {
            list: "milestones",
            title: "Invented booking flow ready",
            project: "Invented booking app",
            due: "2026-12-04",
          },
          { title: "Invented booking screens", milestone: "M-1", due: "2026-12-01" },
        ],
      });
      const plan = (yield* LeadWork.get(scope, { key: "P-1" })).plan!;
      assert.deepStrictEqual(
        plan.milestones.map((one) => [one.key, one.due]),
        [["M-1", "2026-12-04"]],
      );
      assert.deepStrictEqual(
        plan.openTasks.map((one) => [one.key, one.due]),
        [["W-1", "2026-12-01"]],
      );
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
  "a row repeating an open entry from another turn is refused by name; a near one is made and said",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* setup("ask-event");
      const sql = yield* SqlClient.SqlClient;
      const make = (sourceEventId: string, records: typeof LeadWork.CreateInput.Type.records) =>
        LeadWork.create(scope, { sourceEventId, records });
      const shown = (result: typeof LeadWork.CreateResult.Type) =>
        result.records.map((row) => [row.key, row.created, row.alsoOpen]);
      // V28: the same title, client and due day in a later turn is the entry already there.
      const report = { title: "Invented monthly report", client: "C-1", due: "1970-01-05" };
      assert.include(yield* Effect.flip(make("again-event", [report])), {
        reason: "conflict",
        message:
          'W-1 "Invented monthly report" is open with the same title, client and due day. Use W-1, or pass besides: ["W-1"] to add another.',
      });
      // Named as known, a second is made.
      assert.deepStrictEqual(shown(yield* make("again-event", [{ ...report, besides: ["W-1"] }])), [
        ["W-7", true, undefined],
      ]);
      // Next month's is honest work: made, with the open ones near it named.
      assert.deepStrictEqual(
        shown(
          yield* make("third-event", [
            { ...report, title: "invented Monthly report", due: "1970-02-05" },
          ]),
        ),
        [
          [
            "W-8",
            true,
            [
              {
                key: "W-1",
                title: "Invented monthly report",
                differs: 'titled "Invented monthly report", due 1970-01-05',
              },
              {
                key: "W-7",
                title: "Invented monthly report",
                differs: 'titled "Invented monthly report", due 1970-01-05',
              },
            ],
          ],
        ],
      );
      // K013: a name others also answer to asks which, with what tells them apart.
      yield* make("again-event", [
        { list: "clients", title: "Invented Apex", address: "1 Invented Road, Pune" },
        { list: "clients", title: "Invented Apex Dental" },
      ]);
      assert.include(
        yield* Effect.flip(make("third-event", [{ title: "Call", client: "invented apex" }])),
        {
          message:
            "Several clients could be invented apex: Invented Apex (C-2, client, 1 Invented Road, Pune); Invented Apex Dental (C-3, client). Ask which one is meant, or use the key.",
        },
      );
      const exact = yield* make("third-event", [{ title: "Call", client: "Invented Apex" }]);
      assert.include(yield* LeadWork.get(scope, { key: exact.records[0]!.key }), {
        client: "Invented Apex (C-2)",
      });
      // K199: a vendor may share a client's name; a party on an expense is the vendor, said so.
      const vendor = yield* make("again-event", [
        { list: "clients", title: "Invented Acme", kind: "vendor" },
      ]);
      assert.deepInclude(vendor.records[0], {
        key: "C-4",
        created: true,
        alsoNamed:
          "Invented Acme (C-1) is a client of the same name; this is the vendor Invented Acme (C-4).",
      });
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'expenses', 'Expenses', 'EXP', 0, 0, ${JSON.stringify(presetDefinition("expenses", "INR"))})`;
      const paper = {
        list: "expenses",
        title: "Invented printer paper",
        client: "Invented Acme",
        amount: "1,200",
        date: "1970-01-10",
      };
      const spent = yield* make("again-event", [paper]);
      assert.deepInclude(spent.records[0], {
        key: "EXP-1",
        alsoNamed:
          "Invented Acme (C-1), a client, also answers to Invented Acme; this is the vendor Invented Acme (C-4).",
      });
      assert.include(yield* LeadWork.get(scope, { key: "EXP-1" }), {
        client: "Invented Acme (C-4)",
      });
      // The same money to the same party on the same day, even paid, is refused; days apart is said.
      assert.include(
        yield* Effect.flip(make("third-event", [{ ...paper, title: "Invented paper" }])),
        {
          reason: "conflict",
          message:
            'EXP-1 "Invented printer paper" records the same amount for the same party on the same day. Use EXP-1, or pass besides: ["EXP-1"] to add another.',
        },
      );
      assert.deepStrictEqual(
        shown(yield* make("third-event", [{ ...paper, date: "1970-01-12" }])),
        [
          [
            "EXP-2",
            true,
            [
              {
                key: "EXP-1",
                title: "Invented printer paper",
                differs: "dated 1970-01-10",
                sensitive: true,
              },
            ],
          ],
        ],
      );
      // K204: an email another contact has is said, on a new contact and on an edit.
      const twin = yield* make("again-event", [
        { list: "contacts", title: "Invented R. Rao", client: "C-1", email: " Ravi@x.invalid" },
      ]);
      assert.deepStrictEqual(twin.records[0]!.sameEmail, [{ key: "CT-2", title: "Invented Ravi" }]);
      const edited = yield* LeadWork.update(scope, {
        key: "CT-1",
        sourceEventId: "again-event",
        email: "ravi@x.invalid",
      });
      assert.sameDeepMembers(
        [...edited.sameEmail!],
        [
          { key: "CT-2", title: "Invented Ravi" },
          { key: twin.records[0]!.key, title: "Invented R. Rao" },
        ],
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
      // K199: a vendor and a client may share a name; two vendors may not.
      assert.include(
        yield* Effect.flip(
          Clients.createParty([owner], {
            orgId,
            name: "invented juniper",
            kind: "vendor",
            clientRequestId: "k",
          }),
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
      // Its tax details, under the keys an invoice reads them by; null clears one.
      const taxed = yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: 2,
        gstin: "27BBBBB2222B1Z5",
        placeOfSupply: "Maharashtra",
      });
      assert.include(taxed, { rev: 3, gstin: "27BBBBB2222B1Z5", placeOfSupply: "Maharashtra" });
      const stored = yield* (yield* KinRecords.KinRecords).get(orgId, "C-1");
      assert.deepInclude(JSON.parse(stored!.fieldsJson), {
        gstin: "27BBBBB2222B1Z5",
        placeOfSupply: "Maharashtra",
      });
      assert.include(
        yield* Clients.updateParty([owner], { orgId, key: "C-1", rev: 3, gstin: null }),
        { gstin: null, placeOfSupply: "Maharashtra" },
      );
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
        party: {
          recordId: created.recordId,
          key: "C-1",
          title: "Invented Juniper",
          kind: "client",
        },
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
        rev: 4,
        active: false,
      });
      assert.include(closed, { active: false });
      assert.isNotNull(closed.closedAt);
      assert.lengthOf((yield* Clients.parties([owner], { orgId })).parties, 0);
      assert.lengthOf((yield* Clients.parties([owner], { orgId, active: false })).parties, 1);
      const reopened = yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: 5,
        active: true,
      });
      assert.include(reopened, { active: true, closedAt: null });
      // A key from the wrong list, and another org's client, are not found.
      const wrongList: ReadonlyArray<Effect.Effect<unknown, KinChatError, Services>> = [
        Clients.updateParty([owner], { orgId, key: entry.key, rev: 1, name: "x" }),
        Clients.party([owner], { orgId, key: "CT-1" }),
        OwnerWork.update([owner], { orgId, key: "C-1", rev: 6, title: "x" }),
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
      // QA: a project's or entry's chip couldn't say its client is a vendor.
      const supplier = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Supplier",
        kind: "vendor",
        clientRequestId: "supplier",
      });
      const supplyRun = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented supply run",
        party: supplier.key,
        clientRequestId: "vendor-project",
      });
      assert.include(supplyRun.party, { key: supplier.key, kind: "vendor" });
      const payment = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented: pay the supplier",
        party: supplier.key,
        clientRequestId: "vendor-entry",
      });
      assert.include(payment.party, { key: supplier.key, kind: "vendor" });
    }).pipe(Effect.provide(layer)),
);

it.effect("every Work tool whose result shows the lead a sensitive entry marks its wake-up", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* setup("ask-event");
    yield* LeadWork.update(scope, { key: "C-1", sourceEventId: "ask-event", sensitive: true });
    // A task is private only by its own label.
    yield* LeadWork.update(scope, { key: "W-2", sourceEventId: "ask-event", sensitive: true });
    // An invoices list as if defined, and an invoice for the payment row.
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))}),
        (${orgId}, 'expenses', 'Expenses', 'EXP', 0, 0, ${JSON.stringify(presetDefinition("expenses", "INR"))})`;
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [
        {
          list: "invoices",
          title: "Invented October retainer",
          amount: "1 lakh",
          state: "waiting",
        },
      ],
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
      // Who holds it and why: no entry's content.
      record_assign: [
        LeadWork.assign(scope, {
          sourceEventId: "ask-event",
          tasks: [{ key: "W-2", to: "you", reason: "Invented: free today" }],
        }),
        false,
      ],
      record_hand_back: [
        LeadWork.handBack(scope, { key: "W-2", sourceEventId: "ask-event", note: "Invented" }),
        false,
      ],
      // The comment's own key and id: nothing of the entry.
      record_comment: [Comments.leadComment(scope, { key: "W-2", body: "Invented note" }), false],
      // The entry's key and its web links: nothing of its content.
      record_link: [
        Comments.leadLink(scope, { key: "W-2", url: "https://invented.example/brief" }),
        false,
      ],
      project_note: [Comments.leadProjectNote(scope, { key: "P-1", note: "Invented" }), false],
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
      money_query: [LeadMoney.moneyQuery(scope, { view: "outlook" }), true],
      budget_set: [
        LeadMoney.budget(scope, { sourceEventId: "ask-event", category: "travel", limit: "50k" }),
        true,
      ],
      dates_query: [LeadMoney.datesQuery(scope, { from: "1970-01-01", to: "2030-12-31" }), true],
      company_profile: [LeadMoney.profile(scope, {}), true],
      // Its record part is record_get's; contact and memory show no entry of their own.
      client_read: [LeadClients.contact(scope, { key: "C-1" }), false],
      touch_log: [
        LeadClients.logTouch(scope, {
          sourceEventId: "ask-event",
          client: "C-1",
          kind: "call",
          note: "Invented call",
        }),
        false,
      ],
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
  "G03: what a turn writes is private only when marked so, whatever it was shown, and reading it marks a later turn",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const ownLabel = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => row!.sensitive));
      const plain = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented plain task" }],
      });
      const first = plain.records[0]!.key;
      yield* sql`INSERT INTO kin_wakeup_sensitive_reads (org_id, wakeup_id, read_at)
      VALUES (${orgId}, 'wake', 0) ON CONFLICT DO NOTHING`;
      const written = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { title: "Invented follow-up with the client" },
          { title: "Invented note on the figure", sensitive: true },
        ],
      });
      yield* LeadWork.update(scope, { key: first, sourceEventId: "ask-event", notes: "Invented" });
      const [follow, marked] = written.records.map((row) => row.key);
      assert.deepStrictEqual(
        [yield* ownLabel(follow!), yield* ownLabel(marked!), yield* ownLabel(first)],
        [0, 1, 0],
      );
      // A later turn that reads the private one is marked as any sensitive read marks it.
      yield* sql`DELETE FROM kin_wakeup_sensitive_reads`;
      yield* LeadWork.get(scope, { key: marked! });
      assert.deepStrictEqual(yield* sql`SELECT wakeup_id FROM kin_wakeup_sensitive_reads`, [
        { wakeup_id: "wake" },
      ]);
      // Only the owner lowers it.
      const entry = yield* OwnerWork.get([owner], { orgId, key: marked! });
      yield* OwnerWork.update([owner], { orgId, key: marked!, rev: entry.rev, sensitive: false });
      assert.strictEqual(yield* ownLabel(marked!), 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a sensitive client labels its contacts and projects, never a task; only the owner lowers it",
  () =>
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
      // G03: a task is private only by its own label.
      for (const record of listed.records) {
        assert.notProperty(record, "sensitiveInherited");
        assert.isFalse(record.sensitive);
      }
      const page = yield* Clients.party([owner], { orgId, key: "C-1" });
      assert.isTrue(page.party.sensitive);
      assert.isTrue(page.contacts.every((contact) => contact.sensitive));
      assert.isTrue(page.projects.every((project) => project.sensitiveInherited));
      assert.notProperty(yield* LeadWork.get(scope, { key: "W-6" }), "sensitive");
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
          [true, undefined, undefined],
          [true, undefined, undefined],
        ],
      );
      assert.notProperty(
        yield* LeadWork.update(scope, { key: "W-2", sourceEventId: "ask-event", notes: "x" }),
        "sensitive",
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
    const update = (
      input: Omit<typeof LeadWork.UpdateInput.Type, "sourceEventId"> & { readonly key: string },
    ) => unmarked(LeadWork.update(scope, { ...input, sourceEventId: "ask-event" }));
    yield* update({ key: "C-1", sensitive: true });
    // W-6 is a task: its project's client never labels it, so unlinking labels nothing.
    assert.isFalse(yield* sensitive("W-6"));
    const unlinked = yield* update({ key: "W-6", client: null, project: null });
    assert.deepInclude(unlinked, { changed: ["party", "project"] });
    assert.notProperty(unlinked, "sensitive");
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
    assert.isTrue(yield* sensitive("P-2"));
    assert.strictEqual(yield* ownLabel("P-2"), 0);
    yield* update({ key: "P-2", client: "Invented Beta" });
    yield* update({ key: "P-3", client: null });
    for (const key of ["P-2", "P-3"]) assert.strictEqual(yield* ownLabel(key), 1);
    for (const key of ["W-7", "W-8"]) assert.isFalse(yield* sensitive(key));
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
    for (const key of ["C-1", "P-2"]) assert.isTrue(yield* sensitive(key));
    assert.isFalse(yield* sensitive("W-7"));
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

it.effect(
  "in a teammate's turn a client they can't see answers like no client, and no name comes back",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ list: "clients", title: "Invented Open Co" }],
      });
      yield* LeadWork.update(scope, { key: "C-1", sourceEventId: "ask-event", sensitive: true });
      // The teammate sees clients, joins the chat, and the turn becomes one they read.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      const log = (client: string) =>
        LeadClients.logTouch(scope, {
          sourceEventId: "ask-event",
          client,
          kind: "call",
          note: "Invented call",
        }).pipe(
          Effect.flip,
          Effect.map((error) => (isChatError(error) ? error : assert.fail(String(error)))),
        );
      const hidden = yield* log("C-1");
      const missing = yield* log("C-9");
      assert.strictEqual(hidden.reason, "not_found");
      assert.strictEqual(hidden.message, missing.message.replace("C-9", "C-1"));
      assert.notInclude((yield* log("Invented Acme")).message, "C-1");
      for (const error of [hidden, missing]) assert.notInclude(error.message, "Invented Acme");
      assert.deepStrictEqual(
        yield* sql`SELECT party_id FROM kin_client_touches WHERE org_id = ${orgId}`,
        [],
      );
      // A client everyone there sees still takes the teammate's contact, by name.
      assert.strictEqual(
        (yield* LeadClients.logTouch(scope, {
          sourceEventId: "ask-event",
          client: "C-2",
          kind: "call",
          note: "Invented call",
        })).client,
        "Invented Open Co (C-2)",
      );
      // Setting up a client by a hidden one's name finds nothing to show: it isn't there for them.
      const again = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ list: "clients", title: "Invented Acme" }],
      }).pipe(Effect.flip);
      assert.notInclude(String(again.message), "C-1");
      // The whole client stays the owner's, even past the gate.
      assert.include(yield* Effect.flip(LeadClients.contact(scope, { key: "C-2" })), {
        reason: "not_allowed",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "contact is what people logged and what Kin issued or received, never a draft or a chat",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))}),
        (${orgId}, 'quotes', 'Quotes', 'QT', 0, 0, ${JSON.stringify(presetDefinition("quotes", "INR"))})`;
      const senses = (key: string) =>
        Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
          Effect.flatMap((now) => Touches.clientSenses(orgId, now)),
          Effect.map((all) => all.filter((one) => one.key === key).map((one) => one.sense)),
        );
      // Its project is open: quiet after the playbook's 14 days with nothing logged, not on day 13.
      yield* TestClock.adjust(13 * DAY);
      assert.notInclude(yield* senses("C-1"), "client_quiet");
      yield* TestClock.adjust(DAY);
      assert.include(yield* senses("C-1"), "client_quiet");
      // The chat that set the client up mentions it; a draft quote is not sent. Neither is contact.
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { list: "quotes", title: "Invented redesign quote", client: "C-1", amount: "500" },
        ],
      });
      const quiet = yield* Clients.parties([owner], { orgId });
      assert.strictEqual(quiet.parties.find((row) => row.key === "C-1")?.lastContactAt, null);

      const call = {
        sourceEventId: "ask-event",
        client: "Invented Acme",
        kind: "call",
        note: "Invented: wants the revised quote by Friday",
        at: "1970-01-10",
      } as const;
      const logged = yield* LeadClients.logTouch(scope, call);
      yield* LeadClients.logTouch(scope, call);
      assert.include(logged.touch, { kind: "call", who: "Owner" });
      // Logged today for an earlier day: new to the dream that runs next, though it happened before.
      const loggedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      assert.deepStrictEqual(
        (yield* Touches.touchesBetween(orgId, loggedAt - 1, loggedAt)).map((one) => one.note),
        [call.note],
      );
      // An issued invoice and a payment against it count by themselves.
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          {
            list: "invoices",
            title: "Invented November work",
            client: "C-1",
            amount: "900",
            state: "waiting",
          },
        ],
      });
      yield* LeadMoney.payment(scope, {
        sourceEventId: "ask-event",
        key: "INV-1",
        amount: "400",
        paidOn: "1970-01-10",
      });
      const page = yield* Clients.party([owner], { orgId, key: "C-1" });
      assert.deepStrictEqual(page.touches?.map((touch) => touch.kind).toSorted(), [
        "call",
        "invoice",
        "payment",
      ]);
      assert.isNotNull(page.party.lastContactAt);
      assert.notInclude(yield* senses("C-1"), "client_quiet");

      // The owner takes the logged call back; what Kin knows from its records stays.
      const touchId = page.touches!.find((touch) => touch.logged)!.id;
      assert.deepStrictEqual(yield* Clients.removeTouch([owner], { orgId, touchId }), {
        removed: true,
      });
      assert.deepStrictEqual(yield* Clients.removeTouch([owner], { orgId, touchId }), {
        removed: false,
      });
      const after = yield* Clients.party([owner], { orgId, key: "C-1" });
      assert.deepStrictEqual(after.touches?.map((touch) => touch.kind).toSorted(), [
        "invoice",
        "payment",
      ]);
      // The agent's retry of that call answers, and leaves it removed.
      assert.include((yield* LeadClients.logTouch(scope, call)).touch, { kind: "call" });
      // An edit to the invoice later, such as a payment, is no new contact.
      const invoiceAt = after.touches!.find((touch) => touch.kind === "invoice")!.at;
      yield* sql`UPDATE kin_records SET updated_at = updated_at + ${5 * DAY} WHERE key = 'INV-1'`;
      const edited = yield* Clients.party([owner], { orgId, key: "C-1" });
      assert.deepStrictEqual(
        edited.touches?.map((touch) => [touch.kind, touch.kind === "invoice" ? touch.at : ""]),
        after.touches?.map((touch) => [touch.kind, touch.kind === "invoice" ? invoiceAt : ""]),
      );

      // With no open project, cold at the playbook's 30 days: one episode per last contact.
      yield* sql`UPDATE kin_records SET state = 'done' WHERE register_id = 'projects'`;
      yield* TestClock.adjust(29 * DAY);
      assert.notInclude(yield* senses("C-1"), "client_cold");
      yield* TestClock.adjust(DAY);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const cold = (yield* Touches.clientSenses(orgId, now)).find(
        (one) => one.key === "C-1" && one.sense === "client_cold",
      );
      const later = (yield* Touches.clientSenses(orgId, now + DAY)).find(
        (one) => one.key === "C-1" && one.sense === "client_cold",
      );
      assert.strictEqual(cold?.episode, later?.episode);
      assert.strictEqual(cold?.from, "contact");
      yield* Clients.logTouch([owner], {
        orgId,
        party: "C-1",
        kind: "email",
        note: "Invented check-in",
        clientRequestId: "check-in",
      });
      assert.notInclude(yield* senses("C-1"), "client_cold");

      // What a client owes counts its unpaid invoices by the rule Money uses, not only its tasks.
      yield* sql`UPDATE kin_records SET state = 'waiting', due_at = ${3 * DAY} WHERE key = 'INV-1'`;
      const owes = (yield* LeadWork.get(scope, { key: "C-1" })).owed!;
      assert.deepStrictEqual(owes.money.overdue, owes.money.unpaid);
      assert.match(owes.money.invoices[0]!, /^INV-1: .*500.* overdue for \d+ days$/);

      // A client added today with work that ended long ago reads cold from that day, and a typed
      // name finds it: any case, a start of it, or a close spelling.
      yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { list: "clients", title: "Invented Harbourline Logistics" },
          {
            list: "projects",
            title: "Invented tracking app",
            client: "invented harbourline",
            state: "done",
            finishedOn: "1970-01-02",
          },
        ],
      });
      const harbour = (yield* LeadWork.get(scope, { key: "C-2" })).key;
      assert.include(yield* senses(harbour), "client_cold");
      // Its fact says what the days count from, as the client page does.
      const harbourCold = (yield* Touches.clientSenses(
        orgId,
        yield* Effect.clockWith((clock) => clock.currentTimeMillis),
      )).find((one) => one.key === harbour && one.sense === "client_cold");
      assert.strictEqual(harbourCold?.from, "project");
      for (const typed of [
        "INVENTED HARBOURLINE LOGISTICS",
        "Invented Harbor",
        "Invnted Harbourline",
      ])
        assert.include(
          yield* LeadWork.get(scope, {
            key: (yield* LeadWork.create(scope, {
              sourceEventId: "ask-event",
              records: [{ title: `Invented call ${typed}`, client: typed }],
            })).records[0]!.key,
          }),
          { client: "Invented Harbourline Logistics (C-2)" },
        );
      // No match names the nearest instead of saying there is none.
      const missed = yield* Effect.flip(
        LeadWork.create(scope, {
          sourceEventId: "ask-event",
          records: [{ title: "Invented call", client: "Invented Harbourlime Freight" }],
        }),
      );
      assert.include(missed.message, "Nearest: Invented Harbourline Logistics (C-2)");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a project's plan: milestones, tasks from spec sections that flag when the section changes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const spec = [
        "# Invented spec",
        "",
        "## Login",
        "",
        "Email and password.",
        "",
        "## Billing",
        "",
        "Monthly invoices.",
        "",
      ].join("\n");
      const doc = yield* Docs.create(
        orgId,
        { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
        {},
        {
          title: "Invented spec",
          body: spec,
          owner: { _tag: "agent", agentId: lead },
          summary: "Created",
          originKey: "test:spec",
          kind: "spec",
        },
      );
      const made = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          {
            list: "projects",
            title: "Invented app",
            due: "1970-03-01",
            billing: "fixed",
            value: "6 lakh",
            members: ["Mate", "me"],
          },
          {
            list: "milestones",
            title: "Invented beta",
            project: "Invented app",
            due: "1970-01-20",
          },
          {
            title: "Invented login form",
            milestone: "Invented beta",
            owner: "Mate",
            size: "M",
            reason: "Mate: tech, free this week",
            from: { doc: doc.row.key, section: "login" },
          },
          {
            title: "Invented password reset",
            milestone: "M-1",
            size: "S",
            from: { doc: doc.row.key, section: "login" },
          },
          {
            title: "Invented invoice run",
            project: "Invented app",
            from: { doc: doc.row.key, section: "billing" },
          },
          {
            title: "Invented kickoff",
            project: "Invented app",
            category: "meeting",
            at: "1970-01-02T15:00+05:30",
            attendees: ["Mate"],
          },
        ],
      });
      assert.deepStrictEqual(
        made.records.map((row) => row.key),
        ["P-1", "M-1", "W-1", "W-2", "W-3", "W-4"],
      );
      const sql = yield* SqlClient.SqlClient;
      const [projectRow] = yield* sql<{ id: string }>`SELECT record_id AS id FROM kin_records
      WHERE key = 'P-1'`;
      yield* Docs.move(
        orgId,
        { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
        { key: doc.row.key },
        { projectId: projectRow!.id },
      );
      const first = (yield* LeadWork.get(scope, { key: "P-1" })).plan!;
      // A milestone brings its project; its tasks count towards it.
      assert.deepStrictEqual(first.milestones, [
        { key: "M-1", title: "Invented beta", state: "open", due: "1970-01-20", done: 0, total: 2 },
      ]);
      assert.include(
        first.people.find((one) => one.name === "Mate"),
        { member: true, open: 1 },
      );
      assert.deepStrictEqual(first.docs, [
        { key: doc.row.key, title: "Invented spec", kind: "spec" },
      ]);
      assert.deepStrictEqual(
        first.meetings.map((one) => one.key),
        ["W-4"],
      );
      assert.deepStrictEqual(first.specChanged, []);
      assert.include(yield* LeadWork.get(scope, { key: "W-1" }), {
        milestone: "M-1",
        size: "M",
        reason: "Mate: tech, free this week",
        project: "Invented app (P-1)",
      });
      // A task's sheet names its milestone; a milestone's lists its tasks.
      assert.equal((yield* OwnerWork.get([owner], { orgId, key: "W-1" })).milestone?.key, "M-1");
      assert.deepStrictEqual(
        (yield* OwnerWork.get([owner], { orgId, key: "M-1" })).tasks?.map((one) => one.key),
        ["W-1", "W-2"],
      );
      assert.isUndefined((yield* OwnerWork.get([owner], { orgId, key: "W-3" })).milestone);
      // An unknown section is refused, naming the ones there are.
      const refused = yield* Effect.flip(
        LeadWork.create(scope, {
          sourceEventId: "again-event",
          records: [{ title: "Invented", from: { doc: doc.row.key, section: "nope" } }],
        }),
      );
      assert.include(refused.message, "login, billing");

      // Editing the login section flags exactly the two tasks written from it.
      yield* Docs.edit(
        orgId,
        { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
        {},
        { key: doc.row.key },
        {
          operations: [
            {
              op: "replace_section",
              section: "login",
              hash: sectionsOf(spec).find((one) => one.id === "login")!.hash,
              text: "Email, password and a magic link.",
            },
          ],
          summary: "Magic link",
          originKey: "test:magic",
        },
      );
      const changed = (yield* LeadWork.get(scope, { key: "P-1" })).plan!;
      assert.deepStrictEqual(
        changed.specChanged.map((one) => one.task),
        ["W-1", "W-2"],
      );
      assert.include(yield* LeadWork.get(scope, { key: "W-1" }), { specChanged: true });
      const page = yield* Clients.project([owner], { orgId, key: "P-1" });
      assert.deepStrictEqual(
        page.specChanged!.map((one) => one.record.key),
        ["W-1", "W-2"],
      );
      assert.deepStrictEqual(page.project.billing, "fixed");
      assert.deepStrictEqual(page.project.value, { minor: 60_000_000, currency: "INR" });

      // Re-anchoring one clears it; the other stays flagged until it is looked at.
      yield* LeadWork.update(scope, {
        key: "W-1",
        sourceEventId: "again-event",
        from: { doc: doc.row.key, section: "login" },
      });
      assert.deepStrictEqual(
        (yield* LeadWork.get(scope, { key: "P-1" })).plan!.specChanged.map((one) => one.task),
        ["W-2"],
      );

      // The owner marks the agent's W-2 private while it waits: its project's lead, Mate, no
      // longer finds it anywhere on the project page, nor in the counts.
      yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${mateId}
        WHERE key = 'P-1'`;
      yield* sql`UPDATE kin_records SET sensitive = 1, state = 'waiting' WHERE key = 'W-2'`;
      const theirs = yield* Clients.project([mate], { orgId, key: "P-1" });
      const ours = yield* Clients.project([owner], { orgId, key: "P-1" });
      assert.deepStrictEqual(
        ours.blocked.map((one) => one.record.key),
        ["W-2"],
      );
      assert.deepStrictEqual(theirs.blocked, []);
      assert.strictEqual(ours.counts.waiting, 1);
      assert.strictEqual(theirs.counts.waiting, 0);
      assert.strictEqual(ours.milestones?.[0]?.total, 2);
      assert.strictEqual(theirs.milestones?.[0]?.total, 1);
      assert.notInclude(
        theirs.changedThisWeek.items.map((one) => one.record.key),
        "W-2",
      );
      assert.notInclude(
        (yield* Clients.projects([mate], { orgId })).projects.map((one) => one.open),
        ours.project.open,
      );
      // A task Mate holds, written from a doc he can't open: its changed section names no doc.
      yield* sql`UPDATE kin_records SET sensitive = 0, owner_kind = 'person', owner_id = ${mateId}
        WHERE key = 'W-2'`;
      yield* sql`UPDATE kin_records SET sensitive = 1 WHERE key = ${doc.row.key}`;
      assert.deepStrictEqual(
        (yield* Clients.project([mate], { orgId, key: "P-1" })).specChanged,
        [],
      );
      assert.deepStrictEqual(
        (yield* Clients.project([owner], { orgId, key: "P-1" })).specChanged?.map(
          (one) => one.doc.key,
        ),
        [doc.row.key],
      );
      yield* sql`UPDATE kin_records SET sensitive = 1, owner_kind = 'agent', owner_id = ${lead}
        WHERE key = 'W-2'`;
      yield* sql`UPDATE kin_records SET sensitive = 0 WHERE key = ${doc.row.key}`;
      // Run 4: one the owner holds, marked private, in Mate's project and milestone. Only the
      // owner side and its holder see it: not its title, count, search hit or pulse fact.
      yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${ownerId}, sensitive = 1,
          due_at = 1 WHERE key = 'W-1'`;
      const late = DAY;
      const sees = Effect.fn("test.sees")(function* (viewer: typeof owner) {
        const view = viewer === owner ? ([owner] as const) : ([mate] as const);
        const page = yield* Clients.project(view, { orgId, key: "P-1" });
        const found = yield* Search.search(orgId, {
          text: "Invented login form",
          limit: 10,
          ...(viewer === owner
            ? { viewer: "owner", scope: KIN_OWNER_LEVEL }
            : { viewer: "team", scope: viewerOfPeople([mateId]) }),
        });
        const pulse = yield* KinPulse.read({
          orgId,
          at: late,
          viewer: viewer === owner ? { _tag: "owner" } : { _tag: "people", people: [mateId] },
        });
        return {
          tasks: (yield* OwnerWork.list(view, { orgId })).records.map((one) => one.key),
          milestone: (yield* OwnerWork.get(view, { orgId, key: "M-1" })).tasks?.map(
            (one) => one.key,
          ),
          counted: page.milestones?.[0]?.total,
          open: page.counts.open + page.counts.waiting,
          search: found.hits.map((hit) => hit.key),
          pulse: pulse.facts.filter((fact) => fact.key.includes("W-1")).length,
        };
      });
      const ownerSees = yield* sees(owner);
      assert.include(ownerSees.tasks, "W-1");
      assert.deepStrictEqual(
        { milestone: ownerSees.milestone, search: ownerSees.search, counted: ownerSees.counted },
        { milestone: ["W-1", "W-2"], search: ["W-1"], counted: 2 },
      );
      assert.isAbove(ownerSees.pulse, 0);
      const mateSees = yield* sees(mate);
      assert.notInclude(mateSees.tasks, "W-1");
      assert.deepStrictEqual(
        { ...mateSees, tasks: undefined },
        {
          tasks: undefined,
          milestone: [],
          counted: 0,
          open: ownerSees.open - 2,
          search: [],
          pulse: 0,
        },
      );
      // J14: the project's lead takes its milestone back and may make it private; only the owner
      // un-marks it.
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      const taken = yield* OwnerWork.assign([mate], { orgId, key: "M-1", to: null });
      assert.deepStrictEqual(taken.owner, { _tag: "person", personId: mateId });
      yield* OwnerWork.update([mate], { orgId, key: "M-1", rev: taken.rev, sensitive: true });
      const marked = yield* OwnerWork.get([owner], { orgId, key: "M-1" });
      assert.isTrue(marked.sensitive);
      yield* OwnerWork.update([owner], { orgId, key: "M-1", rev: marked.rev, sensitive: false });
      // Run 4: someone who holds a task in a project they don't lead opens its page, with no
      // Clients place: their task and what they see, never its price, billing or notes.
      yield* sql`UPDATE kin_records SET owner_kind = 'agent', owner_id = ${lead}, notes = 'Invented 6 lakh fixed'
        WHERE key = 'P-1'`;
      yield* sql`UPDATE kin_records SET owner_kind = 'person', owner_id = ${mateId}, sensitive = 0
        WHERE key = 'W-2'`;
      const inIt = yield* Clients.project([mate], { orgId, key: "P-1" });
      assert.deepStrictEqual(
        {
          blocked: inIt.blocked.map((one) => one.record.key),
          billing: inIt.project.billing,
          value: inIt.project.value,
          notes: inIt.project.notes,
        },
        { blocked: ["W-2"], billing: null, value: null, notes: "" },
      );
      assert.notMatch(JSON.stringify(inIt), /60000000|6 lakh/u);

      // The milestone rule: late once passed while open; at risk within the heads-up days (3 by
      // default) with late or later work.
      const day = (n: number) => n * DAY;
      for (const [state, dueAt, tasks, late, atRisk] of [
        ["open", day(4), [{ dueAt: day(8), open: true }], false, false],
        ["open", day(2), [{ dueAt: day(3), open: true }], false, true],
        ["open", day(2), [{ dueAt: day(-1), open: true }], false, true],
        ["open", day(2), [{ dueAt: day(3), open: false }], false, false],
        ["open", day(-1), [], true, false],
        ["done", day(-1), [], false, false],
      ] as const)
        assert.deepStrictEqual(milestoneRisk({ state, dueAt, now: 0, headsUpDays: 3, tasks }), {
          late,
          atRisk,
        });
    }).pipe(Effect.provide(layer)),
);
