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
  KinRecordKey,
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
import * as Deals from "./deals.ts";
import * as OwnerDocs from "./ownerDocs.ts";
import * as Marketing from "./ownerMarketing.ts";
import * as OwnerMoney from "./ownerMoney.ts";
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
    yield* sql`UPDATE kin_trigger_settings SET time_zone = 'Etc/GMT-14' WHERE org_id = ${orgId}`;
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
      yield* sql`UPDATE kin_trigger_settings SET time_zone = ${zone} WHERE org_id = ${orgId}`;
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

it.effect("an overdue invoice or a long silence with the client puts a project at risk", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))})`;
    const client = yield* Clients.createParty([owner], {
      orgId,
      name: "Invented VIOM",
      clientRequestId: "viom",
    });
    const build = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented VIOM build",
      party: client.key,
      clientRequestId: "viom-build",
    });
    const health = (key: string) =>
      Clients.project([owner], { orgId, key }).pipe(Effect.map((page) => page.project));
    yield* Clients.logTouch([owner], {
      orgId,
      party: client.key,
      kind: "call",
      clientRequestId: "kickoff",
    });
    assert.include(yield* health(build.key), { health: "on_track" });
    // The deposit names only the client, the build only its project; both fall due on day 3.
    const invoice = (title: string, project?: string) => ({
      list: "invoices" as const,
      title,
      client: client.key,
      ...(project === undefined ? {} : { project }),
      amount: "50000",
      state: "waiting" as const,
      due: "1970-01-03",
    });
    yield* LeadWork.create(scope, {
      sourceEventId: "ask-event",
      records: [
        invoice("Invented VIOM deposit"),
        invoice("Invented VIOM build invoice", build.key),
      ],
    });
    yield* TestClock.adjust(4 * DAY);
    // Never guessed: the deposit isn't the build's, though it's the client's only open project.
    const owed = yield* health(build.key);
    assert.include(owed, { health: "at_risk" });
    assert.deepInclude(owed.healthBecause, { overdueInvoices: 1 });
    assert.isUndefined(owed.healthBecause.noContact);
    // Every surface reads the same rule: the list, the Work summary and the lead's own read.
    const listed = yield* Clients.projects([owner], { orgId });
    assert.strictEqual(listed.projects.find((row) => row.key === build.key)?.health, "at_risk");
    const summary = yield* OwnerWork.summary([owner], { orgId });
    assert.deepInclude(
      summary.projects!.find((one) => one.project.key === build.key),
      { health: "at_risk" },
    );
    // Another project for the client doesn't take the build's invoice.
    const second = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented VIOM app",
      party: client.key,
      clientRequestId: "viom-app",
    });
    assert.include(yield* health(second.key), { health: "on_track" });
    // No contact past the client's check-in days (14 by default) puts both at risk.
    yield* TestClock.adjust(11 * DAY);
    const quiet = yield* health(build.key);
    assert.include(quiet, { health: "at_risk" });
    assert.deepStrictEqual(quiet.healthBecause.noContact, {
      lastContactAt: "1970-01-01T00:00:00.000Z",
      days: 15,
    });
    // The client's own playbook gives them longer than the company's 14 days.
    const viom = (yield* Clients.party([owner], { orgId, key: client.key })).party;
    yield* Docs.create(
      orgId,
      { actor: { _tag: "person", personId: ownerId }, via: "owner" },
      {},
      {
        title: "Invented VIOM playbook",
        body: "# VIOM\n\n```kin\nclient_checkin_days: 30\n```\n",
        owner: { _tag: "person", personId: ownerId },
        summary: "Created",
        originKey: "test:viom-playbook",
        kind: "playbook",
        partyId: viom.recordId,
      },
    );
    assert.include(yield* health(second.key), { health: "on_track" });
    // A client nobody has contacted at all: no contact recorded, counted from their adding.
    const silent = yield* Clients.createParty([owner], {
      orgId,
      name: "Invented Silent Co",
      clientRequestId: "silent",
    });
    const silentBuild = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented silent build",
      party: silent.key,
      clientRequestId: "silent-build",
    });
    assert.include(yield* health(silentBuild.key), { health: "on_track" });
    yield* TestClock.adjust(14 * DAY);
    const never = yield* health(silentBuild.key);
    assert.include(never, { health: "at_risk" });
    assert.deepStrictEqual(never.healthBecause.noContact, { lastContactAt: null, days: 14 });
    // Twenty healthy projects that sort ahead by name don't push a quiet client's out of the summary.
    const busy = yield* Clients.createParty([owner], {
      orgId,
      name: "Invented Busy Co",
      clientRequestId: "busy",
    });
    yield* Clients.logTouch([owner], {
      orgId,
      party: busy.key,
      kind: "call",
      clientRequestId: "busy-call",
    });
    for (let n = 1; n <= 20; n++)
      yield* Clients.createProject([owner], {
        orgId,
        name: `Alpha ${String(n).padStart(2, "0")}`,
        party: busy.key,
        clientRequestId: `alpha-${n}`,
      });
    const crowded = (yield* OwnerWork.summary([owner], { orgId })).projects!;
    assert.lengthOf(crowded, 20);
    assert.deepInclude(
      crowded.find((one) => one.project.key === silentBuild.key),
      { health: "at_risk" },
    );
    // A returning client: the project we finished last week counts as contact, as client_quiet reads it.
    const back = yield* Clients.createParty([owner], {
      orgId,
      name: "Invented Returning Co",
      clientRequestId: "returning",
    });
    yield* Clients.logTouch([owner], {
      orgId,
      party: back.key,
      kind: "call",
      clientRequestId: "returning-call",
    });
    const first = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented returning first",
      party: back.key,
      clientRequestId: "returning-first",
    });
    yield* TestClock.adjust(23 * DAY);
    yield* Clients.updateProject([owner], { orgId, key: first.key, rev: first.rev, state: "done" });
    const again = yield* Clients.createProject([owner], {
      orgId,
      name: "Invented returning second",
      party: back.key,
      clientRequestId: "returning-second",
    });
    yield* TestClock.adjust(7 * DAY);
    const returning = yield* health(again.key);
    assert.include(returning, { health: "on_track" });
    assert.isUndefined(returning.healthBecause.noContact);
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
      assert.deepInclude(contact, { emails: [], phones: ["000"] });
      const records = yield* KinRecords.KinRecords;
      const storedFields = (key: string) =>
        records.get(orgId, key).pipe(Effect.map((row) => JSON.parse(row!.fieldsJson)));
      // One of each is stored as it always was.
      assert.deepStrictEqual(yield* storedFields("CT-1"), { phone: "000" });
      assert.include(
        yield* Clients.updateContact([owner], { orgId, key: "CT-1", rev: 1, phone: null }),
        { phone: null, rev: 2 },
      );
      // Several, main first: trimmed, blanks and repeats dropped (emails in any case), and the
      // list wins over the single field given beside it.
      const several = yield* Clients.createContact([owner], {
        orgId,
        party: "C-1",
        name: "Invented Bo",
        email: "ignored@x.invalid",
        emails: [" bo@x.invalid", "", "Bo@X.invalid", "bo.home@x.invalid"],
        phones: ["+1 555 0100", "+1 555 0100", " ", "+1 555 0101"],
        clientRequestId: "bo",
      });
      assert.deepInclude(several, {
        email: "bo@x.invalid",
        phone: "+1 555 0100",
        emails: ["bo@x.invalid", "bo.home@x.invalid"],
        phones: ["+1 555 0100", "+1 555 0101"],
      });
      const eight = Array.from({ length: 8 }, (_, at) => `bo${at}@x.invalid`);
      assert.include(
        yield* Effect.flip(
          Clients.updateContact([owner], {
            orgId,
            key: several.key,
            rev: several.rev,
            emails: [...eight, "bo8@x.invalid"],
          }),
        ),
        { reason: "invalid_state", message: "A contact has at most 8 emails." },
      );
      const full = yield* Clients.updateContact([owner], {
        orgId,
        key: several.key,
        rev: several.rev,
        emails: eight,
      });
      assert.deepStrictEqual(full.emails, eight);
      // Taking the main one off makes the next one main; an older client's single field
      // replaces the main one and keeps the rest.
      const promoted = yield* Clients.updateContact([owner], {
        orgId,
        key: several.key,
        rev: full.rev,
        emails: eight.slice(1, 3),
        phones: ["+1 555 0101"],
      });
      assert.deepInclude(promoted, {
        email: "bo1@x.invalid",
        emails: ["bo1@x.invalid", "bo2@x.invalid"],
        phone: "+1 555 0101",
        phones: ["+1 555 0101"],
      });
      assert.deepStrictEqual(yield* storedFields(several.key), {
        email: "bo1@x.invalid",
        emails: ["bo1@x.invalid", "bo2@x.invalid"],
        phone: "+1 555 0101",
      });
      const replaced = yield* Clients.updateContact([owner], {
        orgId,
        key: several.key,
        rev: promoted.rev,
        email: "bo.new@x.invalid",
      });
      assert.deepStrictEqual(replaced.emails, ["bo.new@x.invalid", "bo2@x.invalid"]);
      const cleared = yield* Clients.updateContact([owner], {
        orgId,
        key: several.key,
        rev: replaced.rev,
        email: null,
      });
      assert.deepInclude(cleared, { email: "bo2@x.invalid", emails: ["bo2@x.invalid"] });
      assert.deepStrictEqual(yield* storedFields(several.key), {
        email: "bo2@x.invalid",
        phone: "+1 555 0101",
      });
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
      // Stage names only: nothing of a deal.
      deal_stages: [LeadWork.dealStages(scope, {}), false],
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
      Stream.take(3),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);
    yield* Clients.updateParty([owner], { orgId, key: "C-1", rev: 1, name: "Invented Acme Ltd" });
    // A logged contact moves its client's page alone, and only for those who see that client.
    yield* Clients.logTouch([owner], {
      orgId,
      party: "C-1",
      kind: "call",
      note: "Invented call",
      clientRequestId: "owner-call",
    });
    const [, tick, touched] = yield* Fiber.join(ticks);
    assert.strictEqual(tick?.key, "C-1");
    assert.include(touched, { key: "C-1", registerId: "clients" });
    assert.deepStrictEqual([...(touched?.team?.keys() ?? [])], []);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate with Clients on works their own prospects; terms, tax, labels and closing stay the owner's",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      const acme = (yield* Clients.party([owner], { orgId, key: "C-1" })).party;
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: acme.rev,
        gstin: "27ABCDE1234F1Z5",
        placeOfSupply: "Invented Province",
      });
      const quiet = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Quiet Co",
        sensitive: true,
        clientRequestId: "quiet",
      });
      const refused = (effect: Effect.Effect<unknown, KinChatError, Services>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      const add = { orgId, name: "Invented Tallmoor Logistics", clientRequestId: "tallmoor" };
      // A prospect is theirs to add; a client or vendor, terms, tax, a label or someone else's
      // name on it are not.
      for (const extra of [
        {},
        { prospect: true, kind: "vendor" as const },
        { prospect: true, terms: "Invented net 30" },
        { prospect: true, gstin: "27ABCDE1234F1Z5" },
        { prospect: true, placeOfSupply: "Invented Province" },
        { prospect: true, address: "Invented street" },
        { prospect: true, sensitive: true },
        { prospect: true, owner: { _tag: "person" as const, personId: ownerId } },
      ])
        assert.strictEqual(
          yield* refused(Clients.createParty([mate], { ...add, ...extra })),
          "not_allowed",
        );
      const tallmoor = yield* Clients.createParty([mate], {
        ...add,
        prospect: true,
        source: "Invented trade fair",
        tags: ["freight", "freight", "north"],
      });
      assert.deepInclude(tallmoor, {
        kind: "client",
        prospect: true,
        source: "Invented trade fair",
        tags: ["freight", "north"],
        owner: { _tag: "person", personId: mateId },
      });
      const key = tallmoor.key;
      // Only the prospect's own words are theirs to change, and whether it is a client yet.
      for (const change of [
        { terms: "Invented net 30" },
        { gstin: "27ABCDE1234F1Z5" },
        { placeOfSupply: "Invented Province" },
        { address: "Invented street" },
        { sensitive: true },
        { active: false },
        { owner: { _tag: "person" as const, personId: ownerId } },
        { kind: "vendor" as const },
      ])
        assert.strictEqual(
          yield* refused(Clients.updateParty([mate], { orgId, key, rev: tallmoor.rev, ...change })),
          "not_allowed",
        );
      const won = yield* Clients.updateParty([mate], {
        orgId,
        key,
        rev: tallmoor.rev,
        name: "Invented Tallmoor Freight",
        notes: "Invented: met at the fair",
        source: null,
        tags: [],
        prospect: false,
      });
      assert.deepInclude(won, { kind: "client", name: "Invented Tallmoor Freight" });
      assert.notProperty(won, "prospect");
      assert.notProperty(won, "source");
      assert.notProperty(won, "tags");
      const back = yield* Clients.updateParty([mate], {
        orgId,
        key,
        rev: won.rev,
        prospect: true,
      });
      assert.isTrue(back.prospect);
      // Both moves are in its history, for them as for the owner.
      const moves = (yield* Clients.history([mate], { orgId, key })).items.flatMap((item) =>
        item.fields.filter((field) => field.field === "category").map((field) => field.to),
      );
      assert.deepStrictEqual(moves, ["prospect", "client"]);
      // A client someone else looks after: contact is theirs to log, the record is not.
      assert.strictEqual(
        yield* refused(Clients.updateParty([mate], { orgId, key: "C-1", rev: 9, name: "x" })),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refused(
          Clients.createContact([mate], { orgId, party: "C-1", name: "x", clientRequestId: "c" }),
        ),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refused(Clients.updateContact([mate], { orgId, key: "CT-1", rev: 1, name: "x" })),
        "not_allowed",
      );
      const call = yield* Clients.logTouch([mate], {
        orgId,
        party: "C-1",
        kind: "call",
        note: "Invented call about the pilot",
        clientRequestId: "mate-call",
      });
      const ownerCall = yield* Clients.logTouch([owner], {
        orgId,
        party: "C-1",
        kind: "email",
        note: "Invented owner's email",
        clientRequestId: "owner-mail",
      });
      // Its page and history: the contact log, never its terms or tax details.
      const page = yield* Clients.party([mate], { orgId, key: "C-1" });
      assert.deepStrictEqual(page.can, { edit: false, log: true, owner: false, contacts: false });
      assert.include(
        { terms: page.party.terms, gstin: page.party.gstin, place: page.party.placeOfSupply },
        { terms: null, gstin: null, place: null },
      );
      assert.sameMembers(
        (page.touches ?? []).filter((one) => one.logged).map((one) => one.id),
        [call.id, ownerCall.id],
      );
      const history = yield* Clients.history([mate], { orgId, key: "C-1" });
      for (const read of [page, history])
        assert.notMatch(JSON.stringify(read), /retainer|27ABCDE1234F1Z5|Invented Province/u);
      assert.deepStrictEqual((yield* Clients.party([mate], { orgId, key })).can, {
        edit: true,
        log: true,
        owner: false,
        contacts: true,
      });
      // A logged contact goes back by whoever logged it; someone else's stays.
      assert.strictEqual(
        yield* refused(Clients.removeTouch([mate], { orgId, touchId: ownerCall.id })),
        "not_allowed",
      );
      assert.deepStrictEqual(yield* Clients.removeTouch([mate], { orgId, touchId: call.id }), {
        removed: true,
      });
      // Their prospect's people are theirs; a label on one, or moving one, is not.
      const ingrid = yield* Clients.createContact([mate], {
        orgId,
        party: key,
        name: "Invented Ingrid",
        email: "ingrid@x.invalid",
        phones: ["+46 8 555 0100", "+46 8 555 0101"],
        clientRequestId: "ingrid",
      });
      assert.deepInclude(ingrid, {
        emails: ["ingrid@x.invalid"],
        phones: ["+46 8 555 0100", "+46 8 555 0101"],
      });
      // Several on a client someone else looks after are refused as one always was.
      assert.strictEqual(
        yield* refused(
          Clients.createContact([mate], {
            orgId,
            party: "C-1",
            name: "Invented Ola",
            emails: ["ola@x.invalid", "ola.home@x.invalid"],
            clientRequestId: "ola-acme",
          }),
        ),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refused(
          Clients.createContact([mate], {
            orgId,
            party: key,
            name: "Invented Ola",
            sensitive: true,
            clientRequestId: "ola",
          }),
        ),
        "not_allowed",
      );
      for (const change of [{ sensitive: true }, { party: "C-1" }])
        assert.strictEqual(
          yield* refused(
            Clients.updateContact([mate], { orgId, key: ingrid.key, rev: ingrid.rev, ...change }),
          ),
          "not_allowed",
        );
      assert.deepInclude(
        yield* Clients.updateContact([mate], {
          orgId,
          key: ingrid.key,
          rev: ingrid.rev,
          role: "Invented head of operations",
          emails: ["ingrid.work@x.invalid", "ingrid@x.invalid"],
        }),
        {
          role: "Invented head of operations",
          email: "ingrid.work@x.invalid",
          emails: ["ingrid.work@x.invalid", "ingrid@x.invalid"],
          phones: ["+46 8 555 0100", "+46 8 555 0101"],
        },
      );
      // A private client they don't look after is no client at all to them.
      for (const effect of [
        Clients.party([mate], { orgId, key: quiet.key }),
        Clients.history([mate], { orgId, key: quiet.key }),
        Clients.updateParty([mate], { orgId, key: quiet.key, rev: quiet.rev, name: "x" }),
        Clients.createContact([mate], { orgId, party: quiet.key, name: "x", clientRequestId: "q" }),
        Clients.logTouch([mate], {
          orgId,
          party: quiet.key,
          kind: "call",
          clientRequestId: "q",
        }),
      ])
        assert.strictEqual(yield* refused(effect), "not_found");
      assert.notInclude(
        (yield* Clients.parties([mate], { orgId })).parties.map((row) => row.key),
        quiet.key,
      );
      // Looked after by me: the list narrows to theirs.
      assert.deepStrictEqual(
        (yield* Clients.parties([mate], {
          orgId,
          owner: { _tag: "person", personId: mateId },
        })).parties.map((row) => row.key),
        [key],
      );
      assert.deepStrictEqual(
        (yield* Clients.parties([owner], { orgId, prospect: true })).parties.map((row) => row.key),
        [key],
      );
      // A task of theirs may name a client they see, and they read it there.
      const task = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented send the outline",
        party: key,
        clientRequestId: "outline",
      });
      assert.strictEqual(task.party?.key, key);
      assert.strictEqual(
        yield* refused(
          OwnerWork.create([mate], {
            orgId,
            title: "Invented hidden",
            party: quiet.key,
            clientRequestId: "hidden",
          }),
        ),
        "not_found",
      );
      const plain = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented no client",
        clientRequestId: "plain",
      });
      // The write's own guard decides it again, whatever named the client.
      const records = yield* KinRecords.KinRecords;
      const guarded = (originKey: string, partyId: string) =>
        records.create(
          orgId,
          { actor: { _tag: "person", personId: mateId }, via: "owner", teammate: true },
          {
            originKey,
            title: "Invented guarded",
            owner: { _tag: "person", personId: mateId },
            partyId,
          },
        );
      assert.strictEqual(yield* refused(guarded("guard-hidden", quiet.recordId)), "not_allowed");
      // With the switch off, none of it, as before.
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${mateId}`;
      assert.strictEqual(yield* refused(guarded("guard-off", tallmoor.recordId)), "not_allowed");
      assert.strictEqual(
        yield* refused(
          records.update(
            orgId,
            { actor: { _tag: "person", personId: mateId }, via: "owner", teammate: true },
            plain.key,
            { partyId: null },
          ),
        ),
        "not_allowed",
      );
      for (const effect of [
        Clients.createParty([mate], { ...add, prospect: true, clientRequestId: "again" }),
        Clients.updateParty([mate], { orgId, key, rev: back.rev, name: "x" }),
        Clients.logTouch([mate], { orgId, party: key, kind: "call", clientRequestId: "off" }),
        Clients.history([mate], { orgId, key }),
        OwnerWork.create([mate], {
          orgId,
          title: "Invented off",
          party: key,
          clientRequestId: "off",
        }),
      ])
        assert.include(["not_allowed", "not_found"], yield* refused(effect));
      assert.isUndefined((yield* OwnerWork.get([mate], { orgId, key: task.key })).party);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a member's Clients is read only from what they may see there; hidden and absent answer alike",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      yield* seed;
      yield* setup("ask-event");
      const now = Date.parse("2026-11-20T09:00:00.000Z");
      yield* TestClock.setTime(now);
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      const acme = (yield* Clients.party([owner], { orgId, key: "C-1" })).party;
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: acme.rev,
        owner: { _tag: "person", personId: mateId },
      });
      const failure = (effect: Effect.Effect<unknown, KinChatError, Services>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.flip,
          Effect.map(({ reason, message }) => ({ reason, message })),
        );
      const writer = { ...OwnerWork.ownerWriter(owner) };
      // A private project of a public client, and an unmarked task in it the team shares: Tasks
      // shows it to them; Clients never counts, names or dates it.
      const quietProject = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented quiet pilot",
        party: "C-1",
        sensitive: true,
        clientRequestId: "quiet-pilot",
      });
      const entry = (originKey: string, extra: Partial<KinRecords.CreateInput>) =>
        records.create(orgId, writer, {
          originKey,
          title: `Invented ${originKey}`,
          owner: { _tag: "person", personId: ownerId },
          partyId: acme.recordId,
          ...extra,
        });
      const hiddenStep = yield* entry("hidden step", {
        projectId: quietProject.recordId,
        dueAt: Date.parse("1969-12-31T00:00:00.000Z"),
        team: true,
      });
      yield* entry("visible step", { dueAt: Date.parse("1970-01-06T00:00:00.000Z"), team: true });
      // Contact the member can't see: meetings in the private project, newer than any they can,
      // and one marked private on its own.
      const call = yield* Clients.logTouch([mate], {
        orgId,
        party: "C-1",
        kind: "call",
        at: "2026-11-15T09:00:00.000Z",
        clientRequestId: "seen-call",
      });
      for (let n = 0; n < 6; n += 1)
        yield* entry(`hidden meeting ${n}`, {
          category: "meeting",
          projectId: quietProject.recordId,
          dateAt: now - 4 * DAY + n * 60_000,
          team: true,
        });
      yield* entry("private meeting", { category: "meeting", dateAt: now - DAY, sensitive: true });
      const tasks = (yield* OwnerWork.list([mate], { orgId, limit: 100 })).records.map(
        (one) => one.key,
      );
      assert.include(tasks, hiddenStep.row.key);

      const row = (yield* Clients.parties([mate], { orgId })).parties.find(
        (one) => one.key === "C-1",
      );
      const page = yield* Clients.party([mate], { orgId, key: "C-1" });
      for (const read of [row, page.party]) {
        assert.include(read, { weOwe: 1, lastContactAt: call.at });
        assert.strictEqual(read?.next?.title, "Invented visible step");
      }
      assert.deepStrictEqual(
        (page.touches ?? []).map((one) => one.id),
        [call.id],
      );
      assert.notInclude(JSON.stringify([row, page]), "Invented hidden");
      assert.notInclude(JSON.stringify([row, page]), "Invented private meeting");
      // The owner reads it all.
      const owners = (yield* Clients.party([owner], { orgId, key: "C-1" })).party;
      assert.strictEqual(owners.next?.key, hiddenStep.row.key);
      assert.notStrictEqual(owners.lastContactAt, call.at);

      // History: the hidden task's lines and the owner's terms are left out before a page is cut,
      // so a page with a cursor always has something on it.
      for (let n = 0; n < 4; n += 1) {
        const rev = (yield* Clients.party([owner], { orgId, key: "C-1" })).party.rev;
        yield* Clients.updateParty([owner], {
          orgId,
          key: "C-1",
          rev,
          terms: `Invented terms ${n}`,
        });
      }
      const walked: Array<string> = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 50; pages += 1) {
        const one = yield* Clients.history([mate], {
          orgId,
          key: "C-1",
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (one.nextCursor !== null) assert.lengthOf(one.items, 1);
        walked.push(...one.items.map((item) => `${item.record.key}:${item.kind}`));
        if (one.nextCursor === null) break;
        cursor = one.nextCursor;
      }
      assert.isNotEmpty(walked);
      assert.notInclude(walked.join(" "), hiddenStep.row.key);

      // A private contact on a client they look after is no contact: the same answer as none,
      // before its revision is checked, and it stays as it was.
      const hana = yield* Clients.createContact([owner], {
        orgId,
        party: "C-1",
        name: "Invented Hana",
        notes: "Invented private notes",
        sensitive: true,
        clientRequestId: "hana",
      });
      const absent = yield* failure(
        Clients.updateContact([mate], { orgId, key: "CT-99", rev: 1, notes: "x" }),
      );
      for (const rev of [hana.rev, hana.rev + 5])
        assert.deepStrictEqual(
          yield* failure(Clients.updateContact([mate], { orgId, key: hana.key, rev, notes: "x" })),
          { reason: absent.reason, message: absent.message.replace("CT-99", hana.key) },
        );
      assert.strictEqual(absent.reason, "not_found");
      const contacts = (yield* Clients.party([owner], { orgId, key: "C-1" })).contacts;
      assert.strictEqual(
        contacts.find((one) => one.key === hana.key)?.notes,
        "Invented private notes",
      );

      // A name they can't see is no clash: theirs is made and the owner sees both. One they see
      // still is.
      const quiet = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Quiet Co",
        sensitive: true,
        clientRequestId: "quiet",
      });
      yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Hush Ltd",
        prospect: true,
        sensitive: true,
        clientRequestId: "hush",
      });
      const twin = yield* Clients.createContact([mate], {
        orgId,
        party: "C-1",
        name: "Invented Hana",
        clientRequestId: "twin-hana",
      });
      assert.notStrictEqual(twin.key, hana.key);
      const twinCo = yield* Clients.createParty([mate], {
        orgId,
        name: "Invented Quiet Co",
        prospect: true,
        clientRequestId: "twin-quiet",
      });
      assert.notStrictEqual(twinCo.key, quiet.key);
      const spare = yield* Clients.createParty([mate], {
        orgId,
        name: "Invented Spare Co",
        prospect: true,
        clientRequestId: "spare",
      });
      assert.strictEqual(
        (yield* Clients.updateParty([mate], {
          orgId,
          key: spare.key,
          rev: spare.rev,
          name: "Invented Hush Ltd",
        })).name,
        "Invented Hush Ltd",
      );
      assert.deepStrictEqual(
        (yield* Clients.parties([owner], { orgId, text: "Invented Quiet Co" })).parties
          .map((one) => one.key)
          .toSorted(),
        [quiet.key, twinCo.key].toSorted(),
      );
      for (const clash of [
        Clients.createContact([mate], {
          orgId,
          party: "C-1",
          name: "Invented Mira",
          clientRequestId: "mira-again",
        }),
        Clients.createParty([mate], {
          orgId,
          name: "Invented Acme",
          prospect: true,
          clientRequestId: "acme-again",
        }),
      ])
        assert.strictEqual((yield* failure(clash)).reason, "conflict");

      // A retry gets back only what they may see now: one made private since, or moved to a
      // private client, is not found.
      const retryCo = {
        orgId,
        name: "Invented Retry Co",
        prospect: true as const,
        clientRequestId: "retry-co",
      };
      const made = yield* Clients.createParty([mate], retryCo);
      yield* Clients.updateParty([owner], { orgId, key: made.key, rev: made.rev, sensitive: true });
      const ola = {
        orgId,
        party: "C-1",
        name: "Invented Ola",
        email: "ola@x.invalid",
        clientRequestId: "ola",
      };
      const olaRow = yield* Clients.createContact([mate], ola);
      yield* Clients.updateContact([owner], {
        orgId,
        key: olaRow.key,
        rev: olaRow.rev,
        party: quiet.key,
        email: "ola.private@x.invalid",
      });
      for (const [retry, name] of [
        [Clients.createParty([mate], retryCo), retryCo.name],
        [Clients.createContact([mate], ola), ola.name],
      ] as const)
        assert.deepStrictEqual(yield* failure(retry), {
          reason: "not_found",
          message: `No entry ${name} in Work.`,
        });

      // Removing a contact on a client they can't see answers as an id never there.
      const hiddenTouch = yield* Clients.logTouch([owner], {
        orgId,
        party: quiet.key,
        kind: "call",
        clientRequestId: "quiet-call",
      });
      for (const touchId of [hiddenTouch.id, "tch_never_there"])
        assert.deepStrictEqual(yield* Clients.removeTouch([mate], { orgId, touchId }), {
          removed: false,
        });
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${mateId}`;
      const offAnswers = [];
      for (const touchId of [hiddenTouch.id, call.id, "tch_never_there"])
        offAnswers.push(yield* failure(Clients.removeTouch([mate], { orgId, touchId })));
      assert.deepStrictEqual(offAnswers, [offAnswers[0], offAnswers[0], offAnswers[0]]);
      assert.strictEqual(offAnswers[0]?.reason, "not_allowed");
      const offContact = [];
      for (const key of [hana.key, twin.key, "CT-99"])
        offContact.push(
          (yield* failure(Clients.updateContact([mate], { orgId, key, rev: 1, notes: "x" })))
            .reason,
        );
      assert.deepStrictEqual(offContact, ["not_allowed", "not_allowed", "not_allowed"]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a task's client follows the member's sight of it, a project keeps its client, and terms stay the owner's",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      const switchTo = (on: boolean) =>
        sql`UPDATE kin_people SET sees_clients = ${on ? 1 : 0} WHERE person_id = ${mateId}`;
      yield* switchTo(true);
      const me = { _tag: "person" as const, personId: mateId };
      const rev = (key: string) =>
        Clients.party([owner], { orgId, key }).pipe(Effect.map((page) => page.party.rev));
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: yield* rev("C-1"),
        gstin: "27ABCDE1234F1Z5",
        placeOfSupply: "Invented Province",
      });
      // Its terms and tax details are the owner's in its changes too, on the generic sheet.
      const sheet = yield* OwnerWork.get([mate], { orgId, key: "C-1" });
      assert.notMatch(JSON.stringify(sheet), /retainer|27ABCDE1234F1Z5|Invented Province/u);

      // A task they hold in a project of Acme's: another client would take it out of the
      // project, which isn't theirs to do, so its client isn't either.
      const other = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Brightwell",
        clientRequestId: "brightwell",
      });
      const held = yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented held in the site project",
        project: "P-1",
        owner: me,
        clientRequestId: "held",
      });
      assert.isFalse((yield* OwnerWork.get([mate], { orgId, key: held.key })).can.party);
      const kept = yield* OwnerWork.update([mate], {
        orgId,
        key: held.key,
        rev: held.rev,
        party: other.key,
      }).pipe(Effect.flip);
      assert.deepInclude(kept, {
        reason: "not_allowed",
        message: `${held.key} is part of a project for another client, so it keeps that client. The owner or a co-owner can take it out of the project first.`,
      });
      const still = yield* OwnerWork.get([owner], { orgId, key: held.key });
      assert.deepStrictEqual([still.project?.key, still.party?.key], ["P-1", "C-1"]);
      const moved = yield* OwnerWork.update([owner], {
        orgId,
        key: held.key,
        rev: still.rev,
        party: other.key,
      });
      assert.deepStrictEqual([moved.project?.key, moved.party?.key], [undefined, other.key]);

      // A task they file in a project they lead with no client keeps a client only while they
      // see it: switched off, or the client made private, and it is gone, past values too.
      const own = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented own project",
        owner: me,
        clientRequestId: "own-project",
      });
      const task = yield* OwnerWork.create([mate], {
        orgId,
        title: "Invented filed under Acme",
        project: own.key,
        party: "C-1",
        clientRequestId: "filed",
      });
      const refiled = yield* OwnerWork.update([mate], {
        orgId,
        key: task.key,
        rev: task.rev,
        party: other.key,
      });
      assert.strictEqual(refiled.party?.key, other.key);
      const named = (read: unknown) =>
        ["C-1", other.key, "Invented Acme", "Invented Brightwell"].filter((word) =>
          JSON.stringify(read).includes(word),
        );
      const views = () =>
        Effect.gen(function* () {
          const detail = yield* OwnerWork.get([mate], { orgId, key: task.key });
          const rows = (yield* OwnerWork.list([mate], { orgId, limit: 100 })).records.filter(
            (one) => one.key === task.key,
          );
          return { detail, rows };
        });
      // While they see both, the task names its client and its change from Acme.
      assert.includeMembers(named(yield* views()), ["C-1", other.key, "Invented Brightwell"]);
      yield* switchTo(false);
      assert.deepStrictEqual(named(yield* views()), []);
      const written = yield* OwnerWork.update([mate], {
        orgId,
        key: task.key,
        rev: refiled.rev,
        title: "Invented filed, renamed",
      });
      assert.deepStrictEqual(named(written), []);
      yield* switchTo(true);
      yield* Clients.updateParty([owner], {
        orgId,
        key: other.key,
        rev: yield* rev(other.key),
        sensitive: true,
      });
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: yield* rev("C-1"),
        sensitive: true,
      });
      assert.deepStrictEqual(named(yield* views()), []);
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: yield* rev("C-1"),
        sensitive: false,
      });

      // Switched off, a project's lead reads its client's name as before this branch: no prospect,
      // where it came from or tags, and the Clients filters do nothing.
      yield* switchTo(false);
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: yield* rev("C-1"),
        prospect: true,
        source: "Invented trade fair",
        tags: ["invented"],
      });
      yield* Clients.updateProject([owner], {
        orgId,
        key: "P-1",
        rev: (yield* Clients.project([owner], { orgId, key: "P-1" })).project.rev,
        owner: me,
      });
      const plain = yield* Clients.parties([mate], { orgId });
      assert.deepStrictEqual(
        plain.parties.map((one) => one.key),
        ["C-1"],
      );
      const page = yield* Clients.party([mate], { orgId, key: "C-1" });
      for (const read of [plain.parties[0], page.party])
        for (const field of ["prospect", "source", "tags"]) assert.notProperty(read, field);
      // Nor does a kind tell him: Acme is a prospect, and Clients or Vendors still lists it.
      for (const kind of ["client", "vendor"] as const)
        assert.deepStrictEqual(
          (yield* Clients.parties([mate], { orgId, kind })).parties.map((one) => one.key),
          ["C-1"],
        );
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-1",
        rev: yield* rev("C-1"),
        prospect: false,
      });
      // Neither filter would keep Acme now; to a lead without Clients they are no filters.
      for (const filtered of [{ prospect: true as const }, { owner: me }])
        assert.deepStrictEqual(
          (yield* Clients.parties([mate], { orgId, ...filtered })).parties.map((one) => one.key),
          ["C-1"],
        );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a client's money reaches only whoever Money lets see it, on its page and every read the page makes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      yield* TestClock.adjust(20 * DAY);
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'invoices', 'Invoices', 'INV', 0, 0, ${JSON.stringify(presetDefinition("invoices", "INR"))}),
        (${orgId}, 'quotes', 'Quotes', 'QT', 0, 0, ${JSON.stringify(presetDefinition("quotes", "INR"))}),
        (${orgId}, 'receipts', 'Receipts', 'RC', 0, 0, ${JSON.stringify(presetDefinition("receipts", "INR"))})`;
      // Who reads: Clients and Money as each teammate's switches say; mate is Clients off, no project.
      const roles = [
        ["co", "co_owner", 0, 0],
        ["both", "member", 1, 1],
        ["onLead", "member", 1, 0],
        ["offLead", "member", 0, 0],
      ] as const;
      for (const [id, access, clients, money] of roles) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access, sees_clients, sees_money)
          VALUES (${id}, ${orgId}, ${id}, ${id}, ${at}, ${access}, ${clients}, ${money})`;
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
          VALUES (${`s-${id}`}, ${orgId}, ${id}, 0)`;
      }
      yield* sql`UPDATE kin_people SET sees_clients = 0, sees_money = 0 WHERE person_id = ${mateId}`;
      const who = (id: string) => ({
        _tag: "person" as const,
        orgId,
        personId: KinPersonId.make(id),
      });
      const ledBy = (id: string) => ({ _tag: "person" as const, personId: KinPersonId.make(id) });
      const projectA = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented app build",
        party: "C-1",
        owner: ledBy("onLead"),
        clientRequestId: "project-a",
      });
      const projectB = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented booking build",
        party: "C-1",
        owner: ledBy("offLead"),
        clientRequestId: "project-b",
      });
      const made = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          {
            list: "quotes",
            title: "Invented accepted quote",
            client: "C-1",
            project: projectB.key,
            amount: "7319",
            state: "done",
          },
          {
            list: "quotes",
            title: "Invented sent quote",
            client: "C-1",
            project: projectA.key,
            amount: "5837",
            state: "waiting",
          },
          {
            list: "invoices",
            title: "Invented overdue invoice",
            client: "C-1",
            project: projectA.key,
            amount: "4623",
            state: "waiting",
            due: "1970-01-05",
          },
          {
            list: "invoices",
            title: "Invented booking invoice",
            client: "C-1",
            project: projectB.key,
            amount: "2381",
            state: "waiting",
            due: "1970-01-06",
          },
          {
            list: "receipts",
            title: "Invented advance receipt",
            client: "C-1",
            project: projectA.key,
            amount: "2971",
          },
        ],
      });
      const overdue = made.records.find((one) => one.title === "Invented overdue invoice")!.key;
      yield* LeadMoney.payment(scope, {
        sourceEventId: "ask-event",
        key: overdue,
        amount: "1457",
        paidOn: "1970-01-10",
      });
      const acme = yield* Clients.party([owner], { orgId, key: "C-1" });
      yield* Docs.create(
        orgId,
        { actor: { _tag: "agent", agentId: lead }, via: "lead", askedBy: ownerId },
        {},
        {
          title: "Invented quote document",
          body: "Invented: the price",
          owner: { _tag: "agent", agentId: lead },
          summary: "Created",
          originKey: "test:quote-doc",
          kind: "quote",
          partyId: acme.party.recordId,
          projectId: projectA.recordId,
        },
      );
      // Shared with the team, so Money's own rule shows every entry to a teammate with Money on;
      // a quote and its doc the owner unmarked private, so only the Money switch keeps them back.
      yield* sql`UPDATE kin_records SET team_shared = 1
        WHERE register_id IN ('quotes', 'invoices', 'receipts')`;
      yield* sql`UPDATE kin_records SET sensitive = 0
        WHERE title IN ('Invented sent quote', 'Invented quote document')`;

      const amounts = ["7319", "5837", "4623", "2381", "1457", "2971", "3166"];
      const titles = [...made.records.map((one) => one.title), "Invented quote document"];
      const keys = made.records.map((one) => one.key);
      const answer = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.match(effect, {
          onFailure: (error) => `refused ${isChatError(error) ? error.reason : "otherwise"}`,
          onSuccess: (value) => JSON.stringify(value),
        });
      // Every read a client's page makes, web and phone alike, for C-1.
      const pageReads = (person: ReturnType<typeof who>) =>
        Effect.all([
          answer(Clients.party([person], { orgId, key: "C-1" })),
          answer(Clients.parties([person], { orgId })),
          answer(Clients.history([person], { orgId, key: "C-1" })),
          answer(Clients.projects([person], { orgId, party: "C-1" })),
          ...["quotes", "invoices", "receipts"].map((list) =>
            answer(OwnerWork.list([person], { orgId, list, party: "C-1", totalsBy: "none" })),
          ),
          answer(OwnerMoney.money([person], { orgId, upcomingRows: false, party: "C-1" })),
          answer(OwnerDocs.list([person], { orgId, party: "C-1" })),
        ]).pipe(Effect.map((all) => all.join("\n")));
      const money = (read: string) =>
        [...amounts, ...titles, ...keys].filter((word) => read.includes(word));

      for (const person of [owner, who("co")]) {
        const read = yield* pageReads(person);
        assert.deepStrictEqual(money(read), [...amounts, ...titles, ...keys]);
      }
      // Money on: the client's figures as Money shows them (its docs are Docs' to share).
      assert.deepStrictEqual(money(yield* pageReads(who("both"))), [
        ...amounts,
        ...titles.filter((one) => one !== "Invented quote document"),
        ...keys,
      ]);
      // Money off: none of it, whichever of its projects they lead, Clients on or off.
      for (const id of ["onLead", "offLead", "mate"])
        assert.deepStrictEqual(money(yield* pageReads(who(id))), [], id);
      // The name-only page still carries the client and the project its lead sees.
      const named = yield* Clients.party([who("offLead")], { orgId, key: "C-1" });
      assert.deepStrictEqual(
        [named.party.name, named.projects.map((one) => one.key)],
        ["Invented Acme", [projectB.key]],
      );
      // Money's own place is unchanged: a lead reads their project's quote there.
      assert.include(
        JSON.stringify(yield* OwnerWork.list([who("offLead")], { orgId, list: "quotes" })),
        "Invented accepted quote",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a new client or prospect takes its first contact in the same save, for whoever may add both, or neither is made",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      for (const [id, access, clients] of [
        ["co", "co_owner", 0],
        ["off", "member", 0],
      ] as const) {
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access, sees_clients)
          VALUES (${id}, ${orgId}, ${id}, ${id}, ${at}, ${access}, ${clients})`;
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
          VALUES (${`s-${id}`}, ${orgId}, ${id}, 0)`;
      }
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      const who = (id: string) => ({
        _tag: "person" as const,
        orgId,
        personId: KinPersonId.make(id),
      });
      const co = who("co");
      const off = who("off");
      const refused = (effect: Effect.Effect<unknown, KinChatError, Services>) =>
        effect.pipe(
          Effect.asVoid,
          Effect.flip,
          Effect.map((error) => error.reason),
        );
      const count = (title: string) =>
        sql<{ n: number }>`SELECT count(*) AS n FROM kin_records
          WHERE org_id = ${orgId} AND title = ${title}`.pipe(Effect.map(([row]) => row!.n));
      const contactsOf = (person: typeof owner, key: string) =>
        Clients.party([person], { orgId, key }).pipe(
          Effect.map((page) =>
            page.contacts.map((one) => [one.name, one.role, one.email, one.phone]),
          ),
        );
      const ingrid = {
        name: "Invented Ingrid",
        role: "Invented buyer",
        email: "ingrid@tallmoor.invalid",
        phone: "+00 1234 5678",
      };

      // Without one, nothing changes: the company alone.
      const plain = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Plain Co",
        clientRequestId: "plain",
      });
      assert.deepStrictEqual(yield* contactsOf(owner, plain.key), []);

      // The owner, a co-owner and a teammate with Clients on each add one with the person there.
      const byOwner = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Harbour Co",
        kind: "vendor",
        contact: { name: "Invented Ola", phone: "+00 555" },
        clientRequestId: "harbour",
      });
      assert.deepStrictEqual(yield* contactsOf(owner, byOwner.key), [
        ["Invented Ola", null, null, "+00 555"],
      ]);
      const byCo = yield* Clients.createParty([co], {
        orgId,
        name: "Invented Fennick Co",
        contact: {
          name: "Invented Pia",
          emails: ["pia@fennick.invalid", "pia.home@fennick.invalid"],
          phones: ["+00 556", "+00 557"],
        },
        clientRequestId: "fennick",
      });
      assert.deepStrictEqual(yield* contactsOf(co, byCo.key), [
        ["Invented Pia", null, "pia@fennick.invalid", "+00 556"],
      ]);
      assert.deepStrictEqual(
        (yield* Clients.party([co], { orgId, key: byCo.key })).contacts.map((one) => [
          one.emails,
          one.phones,
        ]),
        [
          [
            ["pia@fennick.invalid", "pia.home@fennick.invalid"],
            ["+00 556", "+00 557"],
          ],
        ],
      );
      const mine = {
        orgId,
        name: "Invented Tallmoor Freight",
        prospect: true,
        source: "Invented trade fair",
        contact: ingrid,
        clientRequestId: "tallmoor",
      };
      const tallmoor = yield* Clients.createParty([mate], mine);
      assert.deepInclude(tallmoor, {
        prospect: true,
        owner: { _tag: "person", personId: mateId },
      });
      const row = [ingrid.name, ingrid.role, ingrid.email, ingrid.phone];
      assert.deepStrictEqual(yield* contactsOf(mate, tallmoor.key), [row]);
      assert.deepStrictEqual(yield* contactsOf(owner, tallmoor.key), [row]);
      // History tells it as it tells a contact added from the page.
      const [contact] = (yield* Clients.party([owner], { orgId, key: tallmoor.key })).contacts;
      const later = yield* Clients.createContact([mate], {
        orgId,
        party: tallmoor.key,
        name: "Invented Ivo",
        clientRequestId: "ivo",
      });
      const lines = (yield* Clients.history([mate], { orgId, key: tallmoor.key })).items.map(
        (item) => JSON.stringify(item).replace(later.key, "KEY").replace(contact!.key, "KEY"),
      );
      assert.strictEqual(lines.filter((line) => line.includes("KEY")).length, 2);

      // A press again, or a retried request, makes neither twice; other details under it, nothing.
      const again = yield* Clients.createParty([mate], mine);
      assert.strictEqual(again.key, tallmoor.key);
      assert.strictEqual(
        yield* refused(
          Clients.createParty([mate], { ...mine, contact: { ...ingrid, phone: "+00 999" } }),
        ),
        "not_allowed",
      );
      assert.deepStrictEqual([yield* count(mine.name), yield* count(ingrid.name)], [1, 1]);

      // A contact refused leaves no company behind: here its request was another contact's.
      yield* Clients.createContact([owner], {
        orgId,
        party: "C-1",
        name: "Invented Ravi Two",
        clientRequestId: "spent",
      });
      assert.strictEqual(
        yield* refused(
          Clients.createParty([owner], {
            orgId,
            name: "Invented Orphan Co",
            contact: { name: "Invented Una" },
            clientRequestId: "spent",
          }),
        ),
        "not_allowed",
      );
      assert.deepStrictEqual(
        [yield* count("Invented Orphan Co"), yield* count("Invented Una")],
        [0, 0],
      );

      // A name already there is the one already there: no second company, no contact on it.
      assert.strictEqual(
        yield* refused(
          Clients.createParty([owner], {
            orgId,
            name: "invented tallmoor freight",
            contact: { name: "Invented Vera" },
            clientRequestId: "twin",
          }),
        ),
        "conflict",
      );
      assert.strictEqual(yield* count("Invented Vera"), 0);

      // A teammate adds only a prospect, and with Clients off, nothing; neither leaves a contact.
      assert.strictEqual(
        yield* refused(
          Clients.createParty([mate], {
            orgId,
            name: "Invented Client Co",
            contact: { name: "Invented Wes" },
            clientRequestId: "client-co",
          }),
        ),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refused(
          Clients.createParty([off], {
            orgId,
            name: "Invented Off Co",
            prospect: true,
            contact: { name: "Invented Wes" },
            clientRequestId: "off-co",
          }),
        ),
        "not_allowed",
      );
      assert.deepStrictEqual(
        [
          yield* count("Invented Client Co"),
          yield* count("Invented Off Co"),
          yield* count("Invented Wes"),
        ],
        [0, 0, 0],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate's agent adds the prospect their own form adds, with its next step theirs; never a client",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      // The teammate asks in their own chat with the lead: a turn only they are behind.
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('mate-chat', ${orgId}, 'direct', 'mate:lead', 1, ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('mate-chat-mate', ${orgId}, 'mate-chat', 'person', ${mateId}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
        VALUES ('mate-chat-lead', ${orgId}, 'mate-chat', 'agent', ${lead}, 'member', ${at})`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
          author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES ('mate-ask', ${orgId}, 'mate-chat', 1, 'human', ${mateId}, 'mate-chat-mate', 'member',
          'text', 'Add the invented prospect from the fair and remind me to call Tuesday', '[]', 'posted', ${at})`;
      const event = {
        _tag: "chat.message",
        orgId,
        agentId: lead,
        eventId: "mate-event",
        receivedAt: at,
        dedupeKey: null,
        provenance: { _tag: "human", personId: mateId, memberId: "mate-chat-mate" },
        chatId: "mate-chat",
        messageId: "mate-ask",
      };
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
          queued_at, state, wakeup_id)
        VALUES ('mate-event', ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)}, 0, 0,
          'claimed', 'wake')`;
      yield* sql`UPDATE kin_events SET wakeup_id = NULL, state = 'done' WHERE event_id != 'mate-event'`;
      yield* sql`UPDATE kin_wakeups SET event_ids = '["mate-event"]', audience = 'shared'
        WHERE wakeup_id = 'wake'`;
      const me = { _tag: "person" as const, personId: mateId };
      const refused = (records: Parameters<typeof LeadWork.create>[1]["records"]) =>
        LeadWork.create(scope, { sourceEventId: "mate-event", records }).pipe(
          Effect.flip,
          Effect.map((error) =>
            isChatError(error)
              ? { reason: error.reason, message: error.message }
              : assert.fail(String(error)),
          ),
        );
      const stored = () =>
        sql<{ key: string }>`SELECT key FROM kin_records
          WHERE org_id = ${orgId} AND title LIKE 'Invented Tallmoor%' ORDER BY key`;

      // A new client with terms stays the owner's: the refusal says who, and nothing is made.
      assert.deepStrictEqual(
        yield* refused([
          { list: "clients", title: "Invented Tallmoor Freight", terms: "Invented net 30" },
        ]),
        { reason: "not_allowed", message: "Only the owner or a co-owner changes that." },
      );
      // A prospect is theirs only as their form makes it: no terms, nobody else to look after it.
      for (const extra of [{ terms: "Invented net 30" }, { owner: "owner" }])
        assert.include(
          (yield* refused([
            { list: "clients", title: "Invented Tallmoor Freight", kind: "prospect", ...extra },
          ])).message,
          "Only the owner or a co-owner sets a client's terms",
        );
      assert.deepStrictEqual(yield* stored(), []);

      // The prospect and its next step, in one call: theirs to look after, the call theirs to make.
      const made = yield* LeadWork.create(scope, {
        sourceEventId: "mate-event",
        records: [
          {
            list: "clients",
            title: "Invented Tallmoor Freight",
            kind: "prospect",
            cameFrom: "Invented trade fair",
            tags: ["invented"],
          },
          {
            title: "Invented: call Tallmoor",
            client: "Invented Tallmoor Freight",
            owner: "me",
            due: "1970-01-06",
          },
          {
            list: "contacts",
            title: "Invented Ingrid",
            client: "Invented Tallmoor Freight",
            phones: ["+00 1234 5678", "+00 1234 5679"],
            emails: ["ingrid@tallmoor.invalid", "ingrid.home@tallmoor.invalid"],
          },
        ],
      });
      const [prospect, call] = made.records;
      const page = yield* Clients.party([mate], { orgId, key: prospect!.key });
      assert.deepInclude(page.party, {
        prospect: true,
        source: "Invented trade fair",
        tags: ["invented"],
        owner: me,
      });
      // The person there, as their own form adds them: on the page, with what they typed.
      assert.deepStrictEqual(
        page.contacts.map((one) => [one.name, one.phone, one.email, one.phones, one.emails]),
        [
          [
            "Invented Ingrid",
            "+00 1234 5678",
            "ingrid@tallmoor.invalid",
            ["+00 1234 5678", "+00 1234 5679"],
            ["ingrid@tallmoor.invalid", "ingrid.home@tallmoor.invalid"],
          ],
        ],
      );
      // Her agent reads them all back, main first, and the same row again is a retry.
      const [, , ingridRow] = made.records;
      assert.deepInclude(yield* LeadWork.get(scope, { key: ingridRow!.key }), {
        email: "ingrid@tallmoor.invalid",
        emails: ["ingrid@tallmoor.invalid", "ingrid.home@tallmoor.invalid"],
        phones: ["+00 1234 5678", "+00 1234 5679"],
      });
      // Her agent changes them as her Edit contact does: the main one off makes the next main.
      const changed = yield* LeadWork.update(scope, {
        key: ingridRow!.key,
        sourceEventId: "mate-event",
        emails: ["ingrid.home@tallmoor.invalid"],
        phones: ["+00 1234 5678", "+00 1234 5679", "+00 1234 5670"],
      });
      assert.includeMembers([...changed.changed], ["email", "emails", "phones"]);
      assert.deepInclude(
        (yield* Clients.party([mate], { orgId, key: prospect!.key })).contacts[0],
        {
          email: "ingrid.home@tallmoor.invalid",
          emails: ["ingrid.home@tallmoor.invalid"],
          phones: ["+00 1234 5678", "+00 1234 5679", "+00 1234 5670"],
        },
      );
      // Not its client or label, and not a contact on a client someone else looks after.
      const acme = (yield* Clients.parties([owner], { orgId })).parties.find(
        (one) => one.name === "Invented Acme",
      );
      const odd = yield* Clients.createContact([owner], {
        orgId,
        party: acme!.key,
        name: "Invented Oddny",
        phone: "+00 2",
        clientRequestId: "odd",
      });
      for (const [key, change, message] of [
        [ingridRow!.key, { client: "Invented Acme" }, "Only the owner or a co-owner sets"],
        [ingridRow!.key, { sensitive: true as const }, "Only the owner or a co-owner sets"],
        [odd.key, { phones: ["+00 2", "+00 3"] }, "Only whoever looks after"],
      ] as const)
        assert.include(
          (yield* LeadWork.update(scope, { key, sourceEventId: "mate-event", ...change }).pipe(
            Effect.flip,
          )).message,
          message,
        );
      assert.deepStrictEqual(
        (yield* Clients.party([owner], { orgId, key: acme!.key })).contacts.find(
          (one) => one.key === odd.key,
        )?.phones,
        ["+00 2"],
      );
      // Not on a client someone else looks after, and never Keep private, as on their form.
      assert.include(
        (yield* refused([
          { list: "contacts", title: "Invented Odd", client: "Invented Acme", phone: "+00 1" },
        ])).message,
        "Only whoever looks after",
      );
      assert.include(
        (yield* refused([
          {
            list: "contacts",
            title: "Invented Odd",
            client: "Invented Tallmoor Freight",
            sensitive: true,
          },
        ])).message,
        "Only the owner or a co-owner sets a client's terms",
      );
      const row = (yield* Clients.parties([mate], { orgId, owner: me })).parties.find(
        (one) => one.key === prospect!.key,
      );
      assert.deepInclude(row?.next, { key: call!.key, title: "Invented: call Tallmoor" });
      const task = yield* OwnerWork.get([mate], { orgId, key: call!.key });
      assert.deepStrictEqual([task.owner, task.party?.key], [me, prospect!.key]);
      // Clients switched off, their agent adds no prospect either.
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${mateId}`;
      assert.include(
        yield* refused([{ list: "clients", title: "Invented Tallmoor Two", kind: "prospect" }]),
        { reason: "not_allowed" },
      );
      assert.lengthOf(yield* stored(), 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("an agent finds a prospect as the client of that name, and calls it a client", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* setup("ask-event");
    const fennick = yield* Clients.createParty([owner], {
      orgId,
      name: "Invented Fennick",
      prospect: true,
      clientRequestId: "fennick",
    });
    const again = yield* LeadWork.create(scope, {
      sourceEventId: "again-event",
      records: [{ list: "clients", title: "Invented Fennick" }],
    });
    assert.deepInclude(again.records[0], { key: fennick.key, created: false });
    const vendor = yield* LeadWork.create(scope, {
      sourceEventId: "third-event",
      records: [{ list: "clients", title: "Invented Fennick", kind: "vendor" }],
    });
    assert.include(vendor.records[0]?.alsoNamed, `(${fennick.key}) is a client of the same name`);
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at,
        queued_at, state, wakeup_id)
      SELECT 'fourth-event', org_id, agent_id, tag, priority,
        json_set(json, '$.eventId', 'fourth-event'), received_at, queued_at, state, wakeup_id
      FROM kin_events WHERE event_id = 'ask-event'`;
    const which = yield* LeadWork.create(scope, {
      sourceEventId: "fourth-event",
      records: [{ list: "contacts", title: "Invented Noor", client: "Invented Fennick" }],
    }).pipe(Effect.flip);
    assert.include(String(which.message), `Invented Fennick (${fennick.key}, client)`);
    assert.notInclude(String(which.message), "prospect");
  }).pipe(Effect.provide(layer)),
);

it.effect("logging contact with a next step makes the follow-up in the same transaction", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed;
    yield* setup("ask-event");
    const log = (clientRequestId: string, dueAt: string) =>
      Clients.logTouch([owner], {
        orgId,
        party: "C-1",
        kind: "call",
        note: "Invented call",
        next: { title: "Invented send the outline", dueAt, dueAllDay: true },
        clientRequestId,
      });
    yield* log("call", "1970-01-03");
    yield* log("call", "1970-01-03");
    const made = yield* sql<{ key: string; owner: string; side: string; party: string }>`SELECT
        r.key, r.owner_id AS owner, r.side, c.key AS party FROM kin_records r
      JOIN kin_records c ON c.record_id = r.party_id
      WHERE r.org_id = ${orgId} AND r.title = 'Invented send the outline'`;
    assert.deepStrictEqual(
      made.map(({ owner: holder, side, party }) => ({ holder, side, party })),
      [{ holder: ownerId, side: "ours", party: "C-1" }],
    );
    // A step that can't be made leaves no contact behind either.
    assert.strictEqual((yield* Effect.flip(log("bad", "not a day"))).reason, "invalid_state");
    const [touches] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM kin_client_touches WHERE org_id = ${orgId}`;
    assert.strictEqual(touches?.count, 1);
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
      // Its terms and tax details too, through the agent's reads, whatever the turn asks.
      const open = (yield* Clients.party([owner], { orgId, key: "C-2" })).party;
      yield* Clients.updateParty([owner], {
        orgId,
        key: "C-2",
        rev: open.rev,
        terms: "Invented net 45 retainer",
        gstin: "29ABCDE1234F1Z5",
        placeOfSupply: "Invented Province",
      });
      const owners = /net 45|29ABCDE1234F1Z5|Invented Province/u;
      const agentReads = Effect.all([
        LeadWork.query(scope, { list: "clients" }),
        LeadWork.get(scope, { key: "C-2" }),
      ]);
      // An owner-only turn still reads them (the first test's `LeadWork.get` of C-1).
      assert.notMatch(JSON.stringify(yield* agentReads), owners);

      // A client on a task made or changed for the room is one each of them could set there:
      // with Clients off, a project's lead sees its client's name but files nothing under it.
      yield* Clients.createProject([owner], {
        orgId,
        name: "Invented Open project",
        party: "C-2",
        owner: { _tag: "person", personId: mateId },
        clientRequestId: "open-project",
      });
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('s-mate', ${orgId}, ${mateId}, 0)`;
      const roomTask = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ title: "Invented room task" }],
      });
      const roomKey = roomTask.records[0]!.key;
      const forRoom = [
        LeadWork.create(scope, {
          sourceEventId: "again-event",
          records: [{ title: "Invented room task for Open Co", client: "C-2" }],
        }).pipe(Effect.asVoid),
        LeadWork.update(scope, { key: roomKey, sourceEventId: "ask-event", client: "C-2" }).pipe(
          Effect.asVoid,
        ),
      ];
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${mateId}`;
      for (const write of forRoom) {
        const error = yield* Effect.flip(write);
        assert.strictEqual(isChatError(error) ? error.reason : error._tag, "not_allowed");
      }
      const [filed] = yield* sql<{ party: string | null }>`SELECT party_id AS party
        FROM kin_records WHERE org_id = ${orgId} AND key = ${roomKey}`;
      assert.isNull(filed?.party ?? null);
      assert.lengthOf(
        yield* sql`SELECT 1 FROM kin_records WHERE title = 'Invented room task for Open Co'`,
        0,
      );
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      for (const write of forRoom) yield* write;
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
      // Once it is issued, the client page names it by its number.
      yield* sql`UPDATE kin_records SET fields_json = json_set(fields_json, '$.number', 'AM/1')
        WHERE key = 'INV-1'`;
      const edited = yield* Clients.party([owner], { orgId, key: "C-1" });
      assert.deepStrictEqual(
        edited.touches?.filter((touch) => touch.record !== null).map((touch) => touch.number),
        ["AM/1", "AM/1"],
      );
      const read = yield* LeadClients.contact(scope, { key: "C-1" });
      assert.deepStrictEqual(
        read.touches.flatMap((touch) => ("from" in touch ? [touch.from] : [])),
        ["AM/1 (INV-1)", "AM/1 (INV-1)"],
      );
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
      assert.match(owes.money.invoices[0]!, /^AM\/1 \(INV-1\): .*500.* overdue for \d+ days$/);

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
      // A prospect is no client yet: it never goes cold, though what we owe it still waits on us.
      const prospect = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Fennick Prospect",
        prospect: true,
        clientRequestId: "fennick",
      });
      yield* sql`UPDATE kin_records SET created_at = 0 WHERE key = ${prospect.key}`;
      assert.deepStrictEqual(yield* senses(prospect.key), []);
      // Nor quiet, with a pilot under way.
      yield* Clients.createProject([owner], {
        orgId,
        name: "Invented Fennick pilot",
        party: prospect.key,
        clientRequestId: "fennick-pilot",
      });
      assert.deepStrictEqual(yield* senses(prospect.key), []);
      yield* OwnerWork.create([owner], {
        orgId,
        title: "Invented reply to Fennick",
        party: prospect.key,
        category: "obligation",
        dueAt: "1970-01-02",
        dueAllDay: true,
        clientRequestId: "fennick-reply",
      });
      assert.deepStrictEqual(yield* senses(prospect.key), ["client_waiting_on_us"]);
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
      // The grouped read answers what the per-client subqueries it replaced did.
      const today = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      for (const at of [DAY, today, today + 400 * DAY])
        assert.deepStrictEqual(
          yield* Touches.clientRows(orgId, at),
          yield* sql`SELECT c.record_id AS "partyId", c.key, c.title, c.sensitive,
              c.created_at AS "createdAt", COALESCE(c.category, 'client') = 'prospect' AS prospect,
              (SELECT COUNT(*) FROM kin_records p WHERE p.org_id = c.org_id
                AND p.register_id = 'projects' AND p.party_id = c.record_id AND p.state = 'open')
                AS "openProjects",
              (SELECT MAX(p.closed_at) FROM kin_records p WHERE p.org_id = c.org_id
                AND p.register_id = 'projects' AND p.party_id = c.record_id AND p.state = 'done'
                AND p.closed_at <= ${at}) AS "lastProjectAt",
              (SELECT MIN(w.due_at) FROM kin_records w WHERE w.org_id = c.org_id
                AND w.register_id = 'work' AND w.party_id = c.record_id AND w.side = 'ours'
                AND w.category = 'obligation' AND w.state IN ('open', 'doing', 'waiting')
                AND w.due_at < ${at}) AS "dueAt"
            FROM kin_records c
            WHERE c.org_id = ${orgId} AND c.register_id = 'clients' AND c.state = 'open'
              AND COALESCE(c.category, 'client') IN ('client', 'prospect')
            ORDER BY c.key`,
        );
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
        {
          key: "M-1",
          title: "Invented beta",
          state: "open",
          due: "1970-01-20",
          dueDay: "Tue 20 Jan 1970",
          done: 0,
          total: 2,
        },
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

it.effect(
  "an agent makes and moves a deal through the same rules: a prospect's win makes it a client, a vendor has none, lost needs its reason",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* setup("ask-event");
      const prospect = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Brightwater",
        prospect: true,
        source: "Invented trade fair",
        clientRequestId: "brightwater",
      });
      const vendor = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Supplies",
        kind: "vendor",
        clientRequestId: "supplies",
      });
      // The stages an agent may name, in the company's order.
      assert.strictEqual(
        (yield* LeadWork.dealStages(scope, {})).answer,
        "4 stages: New, In talks, Proposal, Deciding.",
      );
      const refused = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (isChatError(error) ? error.reason : error._tag)),
        );
      assert.strictEqual(
        yield* refused(
          LeadWork.create(scope, {
            sourceEventId: "ask-event",
            records: [{ list: "deals", title: "Invented supply deal", client: vendor.key }],
          }),
        ),
        "invalid_state",
      );
      for (const fields of [{ stage: "nope" }, { offering: "Invented" }])
        assert.strictEqual(
          yield* refused(
            LeadWork.create(scope, {
              sourceEventId: "ask-event",
              records: [{ list: "deals", title: "Invented pilot", client: prospect.key, fields }],
            }),
          ),
          "invalid_state",
        );
      const made = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          {
            list: "deals",
            title: "Invented pilot",
            client: prospect.key,
            fields: { stage: "in-talks" },
            amount: "18000",
            currency: "EUR",
            due: "2026-12-18",
          },
        ],
      });
      const key = made.records[0]!.key;
      // The same row from the same event is a retry.
      const again = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [{ list: "deals", title: "Invented pilot", client: prospect.key }],
      });
      assert.deepStrictEqual(again.records[0]!, { ...again.records[0]!, key, created: false });
      const deal = (yield* Deals.page([owner], { orgId, key })).deal;
      assert.deepInclude(deal, {
        stage: "in-talks",
        value: { minor: 1_800_000, currency: "EUR" },
        source: "Invented trade fair",
        // Looked after by the person the agent made it for.
        owner: { _tag: "person", personId: ownerId },
      });
      assert.strictEqual(
        yield* refused(
          LeadWork.update(scope, {
            key: KinRecordKey.make(key),
            sourceEventId: "ask-event",
            state: "dropped",
          }),
        ),
        "invalid_state",
      );
      const won = yield* LeadWork.update(scope, {
        key: KinRecordKey.make(key),
        sourceEventId: "ask-event",
        state: "done",
      });
      assert.strictEqual(won.state, "done");
      assert.isUndefined(
        (yield* Clients.party([owner], { orgId, key: prospect.key })).party.prospect,
      );
      const reopened = yield* LeadWork.update(scope, {
        key: KinRecordKey.make(key),
        sourceEventId: "ask-event",
        state: "open",
        fields: { stage: "deciding" },
      });
      assert.strictEqual(reopened.state, "open");
      assert.strictEqual((yield* Deals.page([owner], { orgId, key })).deal.stage, "deciding");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent reads a deal as its page shows whoever the turn is for: its next step, or that it has none",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* setup("ask-event");
      const prospect = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Brightwater",
        prospect: true,
        clientRequestId: "brightwater",
      });
      // The owner's own follow-up from the deal, not shared with the team.
      const stepped = yield* Deals.create([owner], {
        orgId,
        party: prospect.key,
        title: "Invented scheduling pilot",
        clientRequestId: "pilot",
        stage: "proposal",
        value: { minor: 2_000_000, currency: "EUR" },
        expectedOn: "2026-12-15",
        next: { title: "Invented: call Ingrid", dueAt: "2026-11-24", dueAllDay: true },
      });
      const bare = yield* Deals.create([owner], {
        orgId,
        party: prospect.key,
        title: "Invented renewal",
        clientRequestId: "renewal",
      });
      const deals = LeadWork.query(scope, { list: "deals" });
      const of = (result: Effect.Success<typeof deals>, key: string) =>
        result.records.find((row) => row.key === key)?.deal;
      // The owner's own turn: her unshared follow-up is her deal's next step, as on her page.
      const hers = yield* deals;
      const pilot = {
        stage: "Proposal",
        value: "€20,000.00",
        expected: "2026-12-15",
        expectedDay: "Tue 15 Dec 2026",
        lookedAfterBy: "owner",
        next: {
          key: stepped.deal.next!.key,
          title: "Invented: call Ingrid",
          due: "2026-11-24",
          dueDay: "Tue 24 Nov 2026",
        },
      };
      assert.deepStrictEqual(of(hers, stepped.deal.key), pilot);
      assert.deepInclude(of(hers, bare.deal.key), { stage: "New", next: null });
      assert.deepStrictEqual(
        (yield* LeadWork.get(scope, { key: KinRecordKey.make(stepped.deal.key) })).deal,
        pilot,
      );
      // A teammate's turn: the owner's unshared step is not theirs, so the deal has none for
      // them, and nothing in the read names it.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      const theirs = yield* deals;
      assert.deepInclude(of(theirs, stepped.deal.key), { stage: "Proposal", next: null });
      const got = yield* LeadWork.get(scope, { key: KinRecordKey.make(stepped.deal.key) });
      assert.deepInclude(got.deal, { next: null });
      assert.notInclude(JSON.stringify([theirs, got]), "call Ingrid");
      assert.notInclude(JSON.stringify([theirs, got]), stepped.deal.next!.key);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a campaign is a project's category with an audience tag, made, read and changed back",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const fair = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented harbour fair",
        campaign: true,
        audience: " harbour ",
        clientRequestId: "fair",
      });
      const plain = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented site build",
        clientRequestId: "site",
      });
      assert.include(fair, { campaign: true, audience: "harbour" });
      assert.notProperty(plain, "campaign");
      assert.notProperty(plain, "audience");
      const campaigns = yield* Clients.projects([owner], { orgId, campaign: true });
      assert.deepStrictEqual(
        campaigns.projects.map((one) => one.key),
        [fair.key],
      );
      // A teammate makes no campaign: projects are the owner level's to make.
      assert.strictEqual(
        (yield* Clients.createProject([mate], {
          orgId,
          name: "Invented own fair",
          campaign: true,
          clientRequestId: "mine",
        }).pipe(Effect.flip)).reason,
        "not_allowed",
      );
      // The way back: an ordinary project again, its audience kept for if it returns.
      const back = yield* Clients.updateProject([owner], {
        orgId,
        key: fair.key,
        rev: fair.rev,
        campaign: false,
      });
      assert.notProperty(back, "campaign");
      // The kept audience is read with it, so turning Campaign on again shows what Save keeps.
      assert.strictEqual(back.audience, "harbour");
      assert.lengthOf((yield* Clients.projects([owner], { orgId, campaign: true })).projects, 0);
      const again = yield* Clients.updateProject([owner], {
        orgId,
        key: fair.key,
        rev: back.rev,
        campaign: true,
      });
      assert.include(again, { campaign: true, audience: "harbour" });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an agent makes a campaign with its audience and tags a contact by the screens' rule, and reads the campaign by name",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Lumen",
        tags: ["Dentists"],
        clientRequestId: "lumen",
      });
      const made = yield* LeadWork.create(scope, {
        sourceEventId: "ask-event",
        records: [
          { list: "clients", title: "Invented Orbit" },
          {
            list: "contacts",
            title: "Invented Tara",
            client: "Invented Orbit",
            tags: ["dentists"],
          },
          {
            list: "projects",
            title: "Invented spring offer",
            category: "campaign",
            audience: "DENTISTS",
          },
        ],
      });
      const [orbit, tara, spring] = made.records.map((one) => one.key);
      const project = (yield* Clients.project([owner], { orgId, key: spring! })).project;
      assert.include(project, { campaign: true, audience: "Dentists" });
      const contactTags = () =>
        Clients.party([owner], { orgId, key: orbit! }).pipe(
          Effect.map((page) => page.contacts.find((one) => one.key === tara)?.tags),
        );
      assert.deepStrictEqual(yield* contactTags(), ["Dentists"]);
      // The whole list on update, cleaned the same way; the notes are left alone.
      yield* LeadWork.update(scope, {
        key: tara!,
        sourceEventId: "again-event",
        tags: ["Dentists", " referrals "],
      });
      assert.deepStrictEqual(yield* contactTags(), ["Dentists", "referrals"]);
      const read = yield* LeadWork.get(scope, { key: tara! });
      assert.deepStrictEqual(read.tags, ["Dentists", "referrals"]);
      assert.strictEqual(read.notes, "");
      // A twenty-first tag is refused in the screens' own words, and nothing changes.
      const refused = yield* LeadWork.update(scope, {
        key: tara!,
        sourceEventId: "again-event",
        tags: Array.from({ length: 21 }, (_, at) => `Invented tag ${at}`),
      }).pipe(Effect.flip);
      assert.include(refused, {
        reason: "invalid_state",
        message: "A client, prospect or contact has at most 20 tags.",
      });
      assert.deepStrictEqual(yield* contactTags(), ["Dentists", "referrals"]);
      // A tag goes only where tags live.
      assert.include(
        yield* LeadWork.update(scope, {
          key: spring!,
          sourceEventId: "again-event",
          tags: ["Dentists"],
        }).pipe(Effect.flip),
        { reason: "invalid_state" },
      );
      yield* LeadWork.update(scope, { key: tara!, sourceEventId: "again-event", tags: [] });
      assert.isUndefined(yield* contactTags());
      // The agent reads the campaign, and where a client came from by the campaign's name and key.
      assert.include(yield* LeadWork.get(scope, { key: spring! }), {
        category: "campaign",
        audience: "Dentists",
      });
      yield* Clients.updateParty([owner], {
        orgId,
        key: orbit!,
        rev: (yield* Clients.party([owner], { orgId, key: orbit! })).party.rev,
        source: `campaign:${spring}`,
      });
      const client = yield* LeadWork.get(scope, { key: orbit! });
      assert.strictEqual(client.cameFrom, `Invented spring offer (${spring})`);
      assert.include(
        client.history.map((one) => one.change),
        `source: Invented spring offer (${spring})`,
      );
      assert.notInclude(JSON.stringify(client), "campaign:");
      // Back to an ordinary project: its audience is kept for when it returns, and not read.
      yield* LeadWork.update(scope, { key: spring!, sourceEventId: "again-event", category: null });
      const ordinary = yield* LeadWork.get(scope, { key: spring! });
      assert.notProperty(ordinary, "category");
      assert.notProperty(ordinary, "audience");
      assert.deepStrictEqual(
        yield* sql`SELECT json_extract(fields_json, '$.audience') AS audience FROM kin_records
          WHERE org_id = ${orgId} AND key = ${spring!}`,
        [{ audience: "Dentists" }],
      );
      // A campaign the turn's people can't see in Clients reads as the word alone.
      yield* Clients.updateProject([owner], {
        orgId,
        key: spring!,
        rev: (yield* Clients.project([owner], { orgId, key: spring! })).project.rev,
        campaign: true,
        sensitive: true,
      });
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES ('lead-chat-mate', ${orgId}, 'lead-chat', 'person', ${mateId}, 'member', ${at})`;
      yield* sql`UPDATE kin_wakeups SET audience = 'shared' WHERE wakeup_id = 'wake'`;
      const shared = JSON.stringify(yield* LeadWork.get(scope, { key: orbit! }));
      assert.notInclude(shared, "Invented spring offer");
      assert.notInclude(shared, "campaign:");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "tags are cleaned once on the server: trimmed, one per spelling in any case, the company's first spelling, at most twenty",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const client = yield* Clients.createParty([owner], {
        orgId,
        name: "Invented Brightwater",
        prospect: true,
        tags: ["Harbour", "Clinics"],
        clientRequestId: "bw",
      });
      const contact = yield* Clients.createContact([owner], {
        orgId,
        party: client.key,
        name: "Invented Ingrid",
        tags: [" harbour ", "HARBOUR", "newsletter", "clinics", "Ünited", "ünited"],
        clientRequestId: "ingrid",
      });
      assert.deepStrictEqual(contact.tags, ["Harbour", "newsletter", "Clinics", "Ünited"]);
      // A campaign's audience is spelled the company's way too.
      const fair = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented fair",
        campaign: true,
        audience: "NEWSLETTER",
        clientRequestId: "fair",
      });
      assert.strictEqual(fair.audience, "newsletter");
      const many = Array.from({ length: 21 }, (_, at) => `Invented tag ${at}`);
      const refused = yield* Clients.updateContact([owner], {
        orgId,
        key: contact.key,
        rev: contact.rev,
        tags: many,
      }).pipe(Effect.flip);
      assert.include(refused, { reason: "invalid_state" });
      assert.include(refused.message, "at most 20 tags");
      // Twenty-one typed, twenty once repeats in another case fold away.
      const twenty = yield* Clients.updateContact([owner], {
        orgId,
        key: contact.key,
        rev: contact.rev,
        tags: [...many.slice(0, 20), "INVENTED TAG 0"],
      });
      assert.lengthOf(twenty.tags ?? [], 20);
      // The way out: empty clears them.
      const cleared = yield* Clients.updateContact([owner], {
        orgId,
        key: contact.key,
        rev: twenty.rev,
        tags: [],
      });
      assert.notProperty(cleared, "tags");
      // A teammate with Clients on tags the contacts of a prospect they look after, and no other's.
      yield* (yield* SqlClient.SqlClient)`UPDATE kin_people SET sees_clients = 1
        WHERE person_id = ${mateId}`;
      const theirs = yield* Clients.createParty([mate], {
        orgId,
        name: "Invented Corran",
        prospect: true,
        contact: { name: "Invented Ola" },
        clientRequestId: "corran",
      });
      const ola = (yield* Clients.party([mate], { orgId, key: theirs.key })).contacts[0]!;
      const tagged = yield* Clients.updateContact([mate], {
        orgId,
        key: ola.key,
        rev: ola.rev,
        tags: ["CLINICS", "fair"],
      });
      assert.deepStrictEqual(tagged.tags, ["Clinics", "fair"]);
      const untagged = yield* Clients.updateContact([mate], {
        orgId,
        key: ola.key,
        rev: tagged.rev,
        tags: ["fair"],
      });
      assert.deepStrictEqual(untagged.tags, ["fair"]);
      assert.include(
        yield* Clients.updateContact([mate], {
          orgId,
          key: contact.key,
          rev: cleared.rev,
          tags: ["harbour"],
        }).pipe(Effect.flip),
        { reason: "not_allowed" },
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a campaign's results are counted from what each reader sees, never revealing a hidden row, and its lists and export carry only what they may read",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const fair = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented harbour fair",
        campaign: true,
        audience: "Harbour",
        members: [{ _tag: "person", personId: mateId }],
        clientRequestId: "fair",
      });
      const source = `campaign:${fair.key}`;
      const party = (
        name: string,
        input: { prospect?: boolean; sensitive?: boolean; source?: string },
      ) => Clients.createParty([owner], { orgId, name, clientRequestId: name, ...input });
      const tallmoor = yield* party("Invented Tallmoor", { prospect: true, source });
      const hidden = yield* party("Invented Quietbay", { prospect: true, source, sensitive: true });
      const corran = yield* party("Invented Corran", { source });
      const other = yield* party("Invented Northgate", { source: "Invented referral" });
      const deal = (on: string, title: string, minor: number, currency: string) =>
        Deals.create([owner], {
          orgId,
          party: on,
          title,
          value: { minor, currency: currency as never },
          clientRequestId: title,
        });
      yield* deal(tallmoor.key, "Invented pilot", 1_000_000, "EUR");
      yield* deal(tallmoor.key, "Invented support", 500_000, "USD");
      yield* deal(hidden.key, "Invented quiet deal", 5_000_000, "EUR");
      yield* deal(other.key, "Invented other deal", 100, "EUR");
      // A private deal on a client everyone sees stays with the owner level.
      yield* Deals.create([owner], {
        orgId,
        party: tallmoor.key,
        title: "Invented private deal",
        value: { minor: 300_000, currency: "EUR" },
        sensitive: true,
        clientRequestId: "private-deal",
      });
      const won = yield* deal(corran.key, "Invented stand system", 900_000, "EUR");
      yield* Deals.move([owner], {
        orgId,
        key: won.deal.key,
        rev: won.deal.rev,
        to: { _tag: "won" },
      });
      const contact = (on: string, name: string, tags: ReadonlyArray<string>, extra = {}) =>
        Clients.createContact([owner], {
          orgId,
          party: on,
          name,
          tags,
          clientRequestId: name,
          ...extra,
        });
      yield* contact(tallmoor.key, "=Invented Ingrid", ["harbour"], {
        role: "@Head of operations",
        emails: ["ingrid@tallmoor.invalid", "-ops@tallmoor.invalid"],
        phones: ["+47 900 00 000"],
      });
      yield* contact(tallmoor.key, 'Invented Ola, "the buyer"', ["Harbour", "clinics"]);
      yield* contact(hidden.key, "Invented Hidden", ["harbour"], { email: "h@quietbay.invalid" });
      yield* contact(other.key, "Invented Nils", ["HARBOUR"]);
      const gone = yield* contact(other.key, "Invented Gone", ["harbour"]);
      yield* Clients.updateContact([owner], { orgId, key: gone.key, rev: gone.rev, active: false });
      // Counted by hand: two open prospects, one client; four open deals in two currencies, never
      // summed across them; one won; four open contacts carry the tag.
      const ownerPage = yield* Clients.project([owner], { orgId, key: fair.key });
      assert.deepStrictEqual(ownerPage.results, {
        prospects: 2,
        clients: 1,
        open: {
          count: 4,
          values: [
            { minor: 6_300_000, currency: "EUR" },
            { minor: 500_000, currency: "USD" },
          ],
        },
        won: { count: 1, values: [{ minor: 900_000, currency: "EUR" }] },
        audience: 4,
      });
      // A teammate on the campaign without Clients sees the project but none of its results.
      const mateOff = yield* Clients.project([mate], { orgId, key: fair.key });
      assert.notProperty(mateOff, "results");
      // With Clients on, the private prospect, its deal and its contact are in no count.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${mateId}`;
      const matePage = yield* Clients.project([mate], { orgId, key: fair.key });
      assert.deepStrictEqual(matePage.results, {
        prospects: 1,
        clients: 1,
        open: {
          count: 2,
          values: [
            { minor: 1_000_000, currency: "EUR" },
            { minor: 500_000, currency: "USD" },
          ],
        },
        won: { count: 1, values: [{ minor: 900_000, currency: "EUR" }] },
        audience: 3,
      });
      assert.notInclude(JSON.stringify(matePage), "Quietbay");
      // Each count opens what it counts: the Deals list at what came from the campaign, by state.
      const listed = (who: typeof owner, state?: "won") =>
        Deals.deals([who], {
          orgId,
          campaign: fair.key,
          ...(state === undefined ? {} : { state }),
        });
      const ownerOpen = yield* listed(owner);
      assert.sameMembers(
        ownerOpen.deals.map((one) => one.title),
        ["Invented pilot", "Invented support", "Invented quiet deal", "Invented private deal"],
      );
      assert.deepStrictEqual(ownerOpen.open, ownerPage.results!.open);
      assert.deepStrictEqual(
        (yield* listed(owner, "won")).deals.map((one) => one.title),
        ["Invented stand system"],
      );
      const mateOpen = yield* listed(mate);
      assert.sameMembers(
        mateOpen.deals.map((one) => one.title),
        ["Invented pilot", "Invented support"],
      );
      assert.deepStrictEqual(mateOpen.open, matePage.results!.open);
      // Results move with the rows: winning makes a prospect a client.
      const pilot = (yield* Deals.deals([owner], { orgId, party: tallmoor.key })).deals.find(
        (one) => one.title === "Invented pilot",
      )!;
      yield* Deals.move([owner], { orgId, key: pilot.key, rev: pilot.rev, to: { _tag: "won" } });
      assert.include((yield* Clients.project([owner], { orgId, key: fair.key })).results, {
        prospects: 1,
        clients: 2,
      });
      // "Came from" reads the campaign by name, and the Clients filter finds by it and by tag.
      const fromIt = yield* Clients.parties([owner], { orgId, source });
      assert.sameMembers(
        fromIt.parties.map((one) => one.name),
        ["Invented Tallmoor", "Invented Quietbay", "Invented Corran"],
      );
      assert.include(fromIt.parties[0], { source: "Invented harbour fair" });
      assert.include(fromIt.parties[0]!.campaign, { key: fair.key });
      assert.sameMembers(
        (yield* Clients.parties([mate], { orgId, source })).parties.map((one) => one.name),
        ["Invented Tallmoor", "Invented Corran"],
      );
      assert.sameMembers(
        (yield* Clients.parties([mate], { orgId, tag: "clinics" })).parties.map((one) => one.name),
        ["Invented Tallmoor"],
      );
      // A contact's name finds its client, which says which contact; only where its reader sees it.
      const foundBy = (who: typeof owner, text: string) =>
        Clients.parties([who], { orgId, text }).pipe(
          Effect.map((page) => page.parties.map((one) => [one.name, one.contact])),
        );
      assert.deepStrictEqual(yield* foundBy(owner, " OLA "), [
        ["Invented Tallmoor", 'Invented Ola, "the buyer"'],
      ]);
      assert.deepStrictEqual(yield* foundBy(mate, "ola"), [
        ["Invented Tallmoor", 'Invented Ola, "the buyer"'],
      ]);
      assert.deepStrictEqual(yield* foundBy(owner, "hidden"), [
        ["Invented Quietbay", "Invented Hidden"],
      ]);
      assert.deepStrictEqual(yield* foundBy(mate, "hidden"), []);
      assert.deepStrictEqual(yield* foundBy(owner, "gone"), []);
      assert.deepStrictEqual(yield* foundBy(owner, "tallmoor"), [["Invented Tallmoor", undefined]]);
      // A deal made on the prospect came from the campaign, and reads it by name.
      assert.strictEqual(pilot.source, "Invented harbour fair");
      // The audience as a list: the owner's four, the teammate's three.
      const audience = { orgId, campaign: fair.key };
      const ownerList = yield* Marketing.contactList([owner], audience);
      assert.include(ownerList, { total: 4, title: "Invented harbour fair", details: true });
      const mateList = yield* Marketing.contactList([mate], audience);
      assert.strictEqual(mateList.total, 3);
      assert.notInclude(JSON.stringify(mateList), "Hidden");
      // The export: its columns, a row per contact, and nothing a spreadsheet would run.
      const file = yield* Marketing.exportContacts([mate], { orgId, tag: "HARBOUR" });
      assert.strictEqual(file.rows, 3);
      assert.strictEqual(file.filename, "HARBOUR-contacts.csv");
      const lines = file.csv.replace(/^﻿/, "").split("\r\n");
      assert.deepStrictEqual(lines, [
        "Name,Client,Role,Main email,Other emails,Main phone,Other phones,Tags,Looked after by",
        "Invented Nils,Invented Northgate,,,,,,Harbour,Owner",
        "'=Invented Ingrid,Invented Tallmoor,'@Head of operations,ingrid@tallmoor.invalid,'-ops@tallmoor.invalid,'+47 900 00 000,,Harbour,Owner",
        '"Invented Ola, ""the buyer""",Invented Tallmoor,,,,,,Harbour; clinics,Owner',
        "",
      ]);
      assert.notInclude(file.csv, "quietbay");
      // A campaign under a private project is no campaign to a teammate who can't see it.
      yield* Clients.updateProject([owner], {
        orgId,
        key: fair.key,
        rev: (yield* Clients.project([owner], { orgId, key: fair.key })).project.rev,
        sensitive: true,
      });
      assert.include(yield* Marketing.exportContacts([mate], audience).pipe(Effect.flip), {
        reason: "not_found",
      });
      assert.include(yield* listed(mate).pipe(Effect.flip), { reason: "not_found" });
      assert.include((yield* Clients.parties([mate], { orgId, text: "Tallmoor" })).parties[0], {
        source: "Campaign",
      });
      assert.notProperty(
        (yield* Clients.parties([mate], { orgId, text: "Tallmoor" })).parties[0],
        "campaign",
      );
      // Clients off: no list, no export, nothing about tags.
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${mateId}`;
      for (const input of [
        { orgId, tag: "harbour" },
        { orgId, parties: {} },
      ])
        assert.include(yield* Marketing.exportContacts([mate], input).pipe(Effect.flip), {
          reason: "not_allowed",
        });
      assert.include(yield* Marketing.marketing([mate], { orgId }).pipe(Effect.flip), {
        reason: "not_allowed",
      });
      // Leading a project for a client gives its people's names, never how to reach them.
      yield* Clients.createProject([owner], {
        orgId,
        name: "Invented Tallmoor rollout",
        party: tallmoor.key,
        owner: { _tag: "person", personId: mateId },
        clientRequestId: "rollout",
      });
      const named = yield* Marketing.exportContacts([mate], { orgId, parties: {} });
      assert.strictEqual(named.rows, 2);
      assert.notInclude(named.csv, "@tallmoor");
      assert.notInclude(named.csv, "+47");
      assert.notInclude(named.csv, "clinics");
      assert.include(
        yield* Marketing.contactList([mate], { orgId, tag: "harbour" }).pipe(Effect.flip),
        {
          reason: "not_allowed",
        },
      );
      assert.deepStrictEqual(yield* Marketing.marketing([mate], { orgId }), {
        tags: [],
        cameFrom: [],
      });
      // The owner's choices: the company's tags in its first spellings, and where clients came from.
      assert.deepStrictEqual(yield* Marketing.marketing([owner], { orgId }), {
        tags: ["clinics", "Harbour"],
        cameFrom: [
          { source, label: "Invented harbour fair", campaign: true },
          { source: "Invented referral", label: "Invented referral", campaign: false },
        ],
      });
    }).pipe(Effect.provide(layer)),
);
