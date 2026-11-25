import { assert, it } from "@effect/vitest";
import {
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  KinRpcs,
  KinWaitingId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Numbers from "../numbers/KinNumbers.ts";
import { lists, updateList } from "../work/ownerMoney.ts";
import { MONEY_LISTS } from "../work/keyGuard.ts";
import * as Records from "../work/KinRecords.ts";
import { create, keyedWrite } from "../work/ownerWork.ts";
import { defineList, presetDefinition, proposalFor } from "../work/registers.ts";
import * as Acts from "./acts.ts";
import { waitingRows } from "./acts.ts";
import { TASKS_KEY_TOOLS } from "./mcp.ts";
import {
  asPerson,
  createProject,
  createTask,
  getMine,
  setStateMine,
  updateProject,
  updateTask,
} from "./tasks.ts";
import { admitted, layer, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";

const reason = <A, E extends { readonly reason?: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));
const withNumbers = Numbers.layer.pipe(
  Layer.provide(Layer.succeed(KinRefreshObserver, { touch: () => Effect.void })),
  Layer.provideMerge(layer),
);

/** Shares a company list with the team, as the owner's list settings do. */
const shared = Effect.fn("test.shared")(function* (list: string) {
  const { owner } = yield* KinIdentity;
  const people = [owner];
  const def = (yield* lists(people, { orgId: owner.orgId })).lists.find((one) => one.list === list);
  yield* updateList(people, { orgId: owner.orgId, list, rev: def!.rev, team: true });
});

/** Ambermill's owner, her key, and a key-marked writer as the endpoint's calls make one. */
const setup = Effect.gen(function* () {
  const { orgId, rhea, zoya } = yield* team;
  const records = yield* Records.KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const key = yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret);
  const person = (personId: KinPersonId) => ({
    actor: { _tag: "person" as const, personId },
    via: "owner" as const,
    askedBy: personId,
  });
  const byKey = { ...person(rhea.personId), codingAgentKey: key.sessionId };
  for (const list of ["expenses", "invoices"] as const)
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, ${list}, ${list}, ${list === "expenses" ? "EXP" : "INV"}, 0, 0,
        ${JSON.stringify(presetDefinition(list, "INR"))})`;
  const make = (originKey: string, fields: Partial<Records.CreateInput>) =>
    records
      .create(orgId, person(rhea.personId), {
        originKey,
        title: `Invented: ${originKey}`,
        owner: { _tag: "person", personId: rhea.personId },
        ...fields,
      })
      .pipe(Effect.map(({ row }) => row));
  const stateOf = (rowKey: string) =>
    records.get(orgId, rowKey).pipe(Effect.map((row) => [row?.state, row?.rev, row?.title]));
  return { orgId, rhea, zoya, key, records, sql, byKey, person, make, stateOf };
});

it.effect(
  "the repository refuses any key-marked write that drops anything or touches money, but an invoice draft",
  () =>
    Effect.gen(function* () {
      const { orgId, records, byKey, make, stateOf } = yield* setup;
      assert.deepStrictEqual(
        [...MONEY_LISTS],
        [
          "expenses",
          "invoices",
          "receipts",
          "quotes",
          "payments",
          "bank_transactions",
          "subscriptions",
        ],
      );
      const bill = yield* make("taxi bill", { list: "expenses", state: "open" });
      const invoice = yield* make("launch invoice", { list: "invoices" });
      const task = yield* make("call the printer", {});
      const refused = <A, R>(write: Effect.Effect<A, { readonly message: string }, R>) =>
        Effect.flip(write).pipe(Effect.map((error) => error.message));
      const sentence =
        "A coding agent's key never deletes or archives anything, nor records or changes money: the person does that in Kin.";
      // Each of the review's calls, at the repository with a key-marked writer: nothing changes.
      for (const [rowKey, patch] of [
        [bill.key, { state: "done" as const }],
        [bill.key, { fields: { reimbursement: "repaid" } }],
        [invoice.key, { state: "waiting" as const, fields: { number: "MANUAL-1" } }],
        [invoice.key, { state: "done" as const }],
        [invoice.key, { title: "Invented: renamed" }],
        [task.key, { state: "dropped" as const }],
      ] as const) {
        const before = yield* stateOf(rowKey);
        assert.strictEqual(yield* refused(records.update(orgId, byKey, rowKey, patch)), sentence);
        assert.deepStrictEqual(yield* stateOf(rowKey), before);
      }
      // Made through the key: an expense or an issued invoice never; an invoice draft, yes.
      for (const input of [
        { list: "expenses", originKey: "key-expense", state: "done" as const },
        { list: "invoices", originKey: "key-issued", state: "waiting" as const },
        { list: "invoices", originKey: "key-numbered", fields: { number: "MANUAL-2" } },
      ])
        assert.strictEqual(
          yield* refused(
            records.create(orgId, byKey, {
              ...input,
              title: "Invented",
              owner: byKey.actor,
            }),
          ),
          sentence,
        );
      const draft = yield* records.create(orgId, byKey, {
        list: "invoices",
        originKey: "key-draft",
        title: "Invented: draft",
        owner: byKey.actor,
      });
      assert.strictEqual(draft.row.state, "open");
      // Priced from its own lines while it stays a draft, as draft_invoice does: its amount alone.
      const priced = yield* records.update(orgId, byKey, draft.row.key, {
        amount: { minor: 50_000, currency: "INR" },
      });
      assert.strictEqual(priced.amountMinor, 50_000);
    }).pipe(Effect.provide(layer)),
);

it.effect("each of the six groups is tried through a key, directly and the indirect way", () =>
  Effect.gen(function* () {
    const { orgId, records, key, make, stateOf, sql } = yield* setup;
    // Direct: no tool answers a card, pays, invites, connects, runs the host or deletes.
    for (const word of [
      "confirm",
      "approve",
      "answer",
      "pay",
      "paid",
      "invite",
      "connect",
      "backup",
      "delete",
      "archive",
      "void",
      "record_expense",
      "read_chat",
    ])
      assert.notInclude(
        TASKS_KEY_TOOLS.flatMap((tool) => [tool, ...tool.split("_")]),
        word,
      );
    // Indirect: task and entry tools named on an expense or an invoice find nothing, and nothing
    // is written (a key-started turn's kin_issue: gendocs/documents.test.ts).
    const bill = yield* make("hotel bill", { list: "expenses", state: "open" });
    const invoice = yield* make("fair invoice", { list: "invoices" });
    for (const rowKey of [bill.key, invoice.key]) {
      const before = yield* stateOf(rowKey);
      const recordKey = KinRecordKey.make(rowKey);
      assert.strictEqual(
        yield* reason(setStateMine(key, { key: recordKey, state: "done" })),
        "not_found",
      );
      assert.strictEqual(yield* reason(Acts.closePromise(key, recordKey)), "not_found");
      assert.strictEqual(
        yield* reason(Acts.updateEntry(key, { key: recordKey, state: "done" })),
        "not_found",
      );
      assert.strictEqual(yield* reason(getMine(key, rowKey)), "not_found");
      assert.deepStrictEqual(yield* stateOf(rowKey), before);
    }
    // A shared list whose first state is dropped takes no entry through a key.
    yield* defineList(
      orgId,
      yield* proposalFor(orgId, {
        name: "Shelved pots",
        states: ["dropped", "done"],
        fields: [{ label: "Note", type: "text" }],
      }),
      0,
    );
    const [archive] = yield* sql<{ id: string }>`SELECT register_id AS id FROM kin_registers
      WHERE org_id = ${orgId} AND name = 'Shelved pots'`;
    yield* shared(archive!.id);
    assert.strictEqual(
      yield* reason(Acts.addEntry(key, { list: archive!.id, title: "Invented: put away" })),
      "not_allowed",
    );
    const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
      WHERE title = 'Invented: put away'`;
    assert.strictEqual(count?.n, 0);
    // Money lists are no company list to an entry tool, listed or named.
    assert.isFalse((yield* Acts.listLists(key)).lists.some((one) => one.list === "expenses"));
    assert.strictEqual(yield* reason(Acts.listEntries(key, { list: "invoices" })), "not_found");
    assert.strictEqual(
      yield* reason(Acts.addEntry(key, { list: "expenses", title: "Invented" })),
      "not_found",
    );
    void records;
  }).pipe(Effect.provide(layer)),
);

it.effect("task tools take only tasks, and a promise tool only promises", () =>
  Effect.gen(function* () {
    const { key, make, orgId, records } = yield* setup;
    const client = yield* make("Invented Kilnworks", { list: "clients" });
    const task = yield* make("glaze the pots", {});
    const promise = yield* make("samples by Friday", {
      category: "obligation",
      partyId: client.recordId,
    });
    assert.strictEqual(yield* reason(getMine(key, client.key)), "not_found");
    assert.strictEqual(
      yield* reason(Acts.closePromise(key, KinRecordKey.make(task.key))),
      "not_found",
    );
    assert.strictEqual(
      (yield* Acts.closePromise(key, KinRecordKey.make(promise.key))).state,
      "done",
    );
    assert.strictEqual((yield* records.get(orgId, task.key))?.state, "open");
  }).pipe(Effect.provide(layer)),
);

it.effect("nothing a key can't reach comes back by a side door", () =>
  Effect.gen(function* () {
    const { orgId, key, make, records, sql, person, rhea } = yield* setup;
    // Decision 7: an invoice's lines come only from a document the key reaches.
    const invoice = yield* make("pottery invoice", { list: "invoices" });
    yield* sql`INSERT INTO kin_doc_jobs (org_id, worker_id, agent_id, wakeup_id, mode, recipe,
        recipe_commit, entry_record_id, inputs_sha256, sensitive, doc_origin, worktree_path,
        branch, audience, created_at, given_json, outcome_json)
      VALUES (${orgId}, 'w-1', 'finance', 'turn', 'recipe', 'invoice', 'c', ${invoice.recordId},
        'h', 0, 'origin-1', '', '', 'owner_only', 0,
        ${JSON.stringify({ lines: [{ description: "Invented mug", sac: null, quantity: "2", rate: "₹100" }] })},
        '{}')`;
    const doc = yield* make("invoice pdf", { list: "docs", originKey: "origin-1:invoice.pdf" });
    const linesOf = Acts.openInvoice(key, KinRecordKey.make(invoice.key)).pipe(
      Effect.map((one) => one.lines?.length ?? null),
    );
    assert.strictEqual(yield* linesOf, 1);
    yield* records.update(orgId, person(rhea.personId), doc.key, { sensitive: true });
    assert.strictEqual(yield* linesOf, null);

    // Decision 12: no money aggregate and no card about an entry the key can't reach.
    yield* TestClock.setTime(20 * 86_400_000);
    const late = yield* make("late invoice", {
      list: "invoices",
      amount: { minor: 70_000, currency: "INR" },
      dueAt: 86_400_000,
    });
    yield* sql`UPDATE kin_records SET state = 'waiting' WHERE record_id = ${late.recordId}`;
    yield* records.update(orgId, person(rhea.personId), late.key, { sensitive: true });
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('finance', ${orgId}, 'Finance', 'lead', ${rhea.personId}, '1970-01-01')`;
    const waiting = (yield* Acts.listWaiting(key)).waiting;
    assert.isFalse(waiting.some((row) => (row.what as string) === "money"));

    // A link to an entry the key can't reach is left out of a read and refused in a write.
    yield* defineList(
      orgId,
      yield* proposalFor(orgId, {
        name: "Loan book",
        fields: [{ label: "Lender", type: "link", link: "clients" }],
      }),
      0,
    );
    const [loans] = yield* sql<{ id: string }>`SELECT register_id AS id FROM kin_registers
      WHERE org_id = ${orgId} AND name = 'Loan book'`;
    yield* shared(loans!.id);
    const hidden = yield* make("Invented Quiet Client", { list: "clients", sensitive: true });
    const open = yield* make("Invented Open Client", { list: "clients" });
    assert.strictEqual(
      yield* reason(
        Acts.addEntry(key, {
          list: loans!.id,
          title: "Invented: kiln",
          fields: { lender: hidden.recordId },
        }),
      ),
      "not_found",
    );
    const lent = yield* Acts.addEntry(key, {
      list: loans!.id,
      title: "Invented: wheel",
      fields: { lender: open.recordId },
    });
    yield* records.update(orgId, person(rhea.personId), open.key, { sensitive: true });
    const listed = (yield* Acts.listEntries(key, { list: loans!.id })).entries.find(
      (one) => one.key === lent.key,
    );
    assert.notProperty(listed?.fields ?? {}, "lender");

    // Decision 13: replayed after the entry was labelled, a create answers not found; a name
    // clash or an open blocker names nothing the key can't reach.
    const stocked = yield* Acts.addEntry(key, { list: loans!.id, title: "Invented: kiln shelf" });
    yield* records.update(orgId, person(rhea.personId), stocked.key, { sensitive: true });
    assert.strictEqual(
      yield* reason(Acts.addEntry(key, { list: loans!.id, title: "Invented: kiln shelf" })),
      "not_found",
    );
    const clash = yield* Effect.flip(
      Acts.createClient(key, { name: "Invented: Invented Quiet Client" }),
    );
    assert.strictEqual(clash.message, "Another entry already has that name.");
    const project = yield* createProject(key, { title: "Invented: fair stall" });
    const blocker = yield* make("Invented: private stall task", {
      projectId: (yield* records.get(orgId, project.key))!.recordId,
      sensitive: true,
    });
    const closing = yield* Effect.flip(
      updateProject(key, { key: KinRecordKey.make(project.key), state: "done" }),
    );
    assert.notInclude(closing.message, blocker.key);
    assert.include(closing.message, "open entries you cannot see here");
  }).pipe(Effect.provide(layer)),
);

it.effect("checks run inside the write, and one change is one transaction", () =>
  Effect.gen(function* () {
    const { orgId, key, make, records, person, rhea, sql } = yield* setup;
    // Decision 14: the entries a call names are checked in the write's own transaction.
    const project = yield* make("Invented: launch", { list: "projects" });
    yield* records.update(orgId, person(rhea.personId), project.key, { sensitive: true });
    const { connection, people } = asPerson(key);
    assert.strictEqual(
      yield* reason(
        create(
          people,
          {
            orgId,
            title: "Invented: follow up",
            project: KinRecordKey.make(project.key),
            clientRequestId: "x",
          },
          { ...connection, names: [project.key] },
        ),
      ),
      "not_found",
    );
    // ...and the write is the person's as they are now, not as they were read before it.
    const live = yield* keyedWrite({ person: people[0]!, teammate: true }, connection, (viewer) =>
      Effect.succeed(viewer.teammate),
    );
    assert.isFalse(live);

    // Decision 16: a refused hand-over saves none of the change it came with.
    const task = yield* createTask(key, { title: "Invented: wrap mugs" });
    yield* setStateMine(key, { key: KinRecordKey.make(task.key), state: "done" });
    assert.isDefined(
      yield* Effect.flip(
        updateTask(key, {
          key: KinRecordKey.make(task.key),
          title: "Invented: renamed",
          holder: "Zoya",
        }),
      ),
    );
    assert.strictEqual((yield* records.get(orgId, task.key))?.title, "Invented: wrap mugs");
    void sql;
  }).pipe(Effect.provide(layer)),
);

it.effect("a watched number reports what was recorded, and computed ones carry no value", () =>
  Effect.gen(function* () {
    const { orgId, key, sql } = yield* setup;
    const goal = (number: string, fields: object) =>
      sql`INSERT INTO kin_records (org_id, record_id, key, title, register_id, owner_kind,
          owner_id, created_by_kind, origin_key, fields_json, created_at, updated_at, confirmed)
        VALUES (${orgId}, ${number}, ${number}, ${number}, 'goals', 'person', 'kin-default-owner',
          'system', ${number}, ${JSON.stringify({ measure: "manual", ...fields })}, 0, 0, 1)`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'goals', 'Goals', 'G', 1, 0) ON CONFLICT DO NOTHING`;
    yield* goal("G-1", { unit: "users" });
    yield* goal("G-2", { spec: '{"builtin":"overdue_over_30"}' });
    const number = KinRecordKey.make("G-1");
    assert.deepStrictEqual(
      yield* Acts.recordNumber(key, { number, value: "9", day: "1970-01-01" }),
      { number, recorded: true },
    );
    // The same value again, however the store would spell it ("09" is 9), records nothing.
    for (const value of ["9", "09"])
      assert.deepStrictEqual(yield* Acts.recordNumber(key, { number, value, day: "1970-01-01" }), {
        number,
        recorded: false,
      });
    // Its history shows it came through her coding agent.
    assert.match(
      (yield* Acts.readNumbers(key, { number, from: "1970-01-01", to: "1970-01-01" })).values?.[0]
        ?.by ?? "",
      / \(coding agent\)$/,
    );
    const listed = (yield* Acts.readNumbers(key, {})).numbers ?? [];
    assert.deepInclude(
      listed.find((one) => one.key === "G-2"),
      { computed: true, value: null },
    );
    assert.strictEqual(
      yield* reason(Acts.readNumbers(key, { number: KinRecordKey.make("G-2") })),
      "not_allowed",
    );
  }).pipe(Effect.provide(withNumbers)),
);

it("Needs you through a key: no money aggregate, and no card about an entry it can't reach", () => {
  const card = (waitingId: string, question: string) => ({
    id: `waiting:${waitingId}`,
    late: false,
    item: {
      _tag: "waiting" as const,
      waiting: {
        waitingId: KinWaitingId.make(waitingId),
        orgId: KinOrgId.make("ambermill"),
        personId: KinPersonId.make("rhea"),
        chatId: KinChatId.make("chat"),
        messageId: null,
        widgetId: null,
        reason: "question" as const,
        createdAt: "1970-01-01T00:00:00.000Z",
        resolvedAt: null,
        resolution: null,
        question,
      },
    },
  });
  const rows = waitingRows(
    [
      { id: "money:overdue", late: true, item: { _tag: "money", invoices: 2 } },
      card("about-private", "Invented: chase INV-9?"),
      card("plain", "Invented: which day suits you?"),
    ],
    new Set(["INV-9"]),
    new Map([
      ["about-private", ["INV-9"]],
      ["plain", []],
    ]),
  );
  assert.deepStrictEqual(
    rows.map((row) => [row.what, row.text]),
    [["card", "Invented: which day suits you?"]],
  );
});

const reach: Readonly<Record<string, ReadonlyArray<string> | string>> = {
  "kin.orgs.list":
    "not a person action (screens only: which companies this session belongs to; a key is one company)",
  "kin.chats.subscribe": "not a person action (screens only: live chat list)",
  "kin.chats.createDirect": ["ask_agent"],
  "kin.chats.withPerson":
    "not reached yet: direct chat with a teammate; ask_agent reaches Kin's agents only",
  "kin.chats.mute": "not a person action (screens only: notification preference of a screen)",
  "kin.chats.pin": "not a person action (screens only: screen ordering preference)",
  "kin.chats.clear": "stays in the app: 6 (deleting or archiving)",
  "kin.chat.members": "not a person action (screens only: member list of an open chat)",
  "kin.chat.working": "not a person action (screens only: live 'agent is working' line)",
  "kin.chat.subscribe": "not a person action (screens only: live chat stream)",
  "kin.chat.history":
    "not reached yet: an agent's words and a chat's history can carry private entries",
  "kin.messages.send": ["ask_agent"],
  "kin.messages.markRead": "not a person action (screens only: read receipts)",
  "kin.widgets.act": "stays in the app: 1 (tapping a card)",
  "kin.messages.react":
    "stays in the app: 1 (tapping a card) (a reaction is an answer to an agent's ask)",
  "kin.groups.create": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.groups.setCompany": "stays in the app: 5 (host, company sections and settings)",
  "kin.groups.addMember": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.groups.removeMember": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.groups.setLead": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.groups.rename": "stays in the app: 5 (host, company sections and settings)",
  "kin.groups.delete": "stays in the app: 6 (deleting or archiving)",
  "kin.budget.get": "not a person action (screens only: Settings → Company details daily limit)",
  "kin.budget.set": "stays in the app: 5 (host, company sections and settings)",
  "kin.org.get": "not a person action (screens only: company settings screen)",
  "kin.org.pause": "stays in the app: 5 (host, company sections and settings)",
  "kin.org.resume": "stays in the app: 5 (host, company sections and settings)",
  "kin.lead.access.list": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.lead.access.grant": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.lead.access.revoke": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.reach.list": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.reach.set": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.leads.list": ["list_people"],
  "kin.lead.update": "stays in the app: 5 (host, company sections and settings) (an agent's setup)",
  "kin.lead.retire": "stays in the app: 6 (deleting or archiving)",
  "kin.lead.restore": "stays in the app: 5 (agent setup)",
  "kin.lead.page": "not a person action (screens only: an agent's page)",
  "kin.lead.undoChange": "stays in the app: 5 (host, company sections and settings)",
  "kin.lead.character.set": "stays in the app: 5 (host, company sections and settings)",
  "kin.lead.pause": "stays in the app: 5 (host, company sections and settings)",
  "kin.lead.resume": "stays in the app: 5 (host, company sections and settings)",
  "kin.agents.defaults": "not a person action (screens only: Settings → Agents)",
  "kin.agents.defaults.set": "stays in the app: 5 (host, company sections and settings)",
  "kin.lead.interrupt": "stays in the app: 5 (running agent turns)",
  "kin.lead.create": "stays in the app: 5 (host, company sections and settings) (adding an agent)",
  "kin.triggers.getTimeZone": "not a person action (screens only: settings screen)",
  "kin.triggers.setTimeZone": "stays in the app: 5 (host, company sections and settings)",
  "kin.visuals.hosts.list": "not a person action (screens only: settings screen)",
  "kin.visuals.hosts.allow": "stays in the app: 5 (host, company sections and settings)",
  "kin.visuals.hosts.remove": "stays in the app: 5 (host, company sections and settings)",
  "kin.approvals.list": ["list_waiting"],
  "kin.approvals.get": "not a person action (screens only: an approval card's detail)",
  "kin.approvals.challenge": "stays in the app: 1 (tapping a card)",
  "kin.approvals.submitGrant": "stays in the app: 1 (tapping a card)",
  "kin.approvals.reject": "stays in the app: 1 (tapping a card)",
  "kin.approvals.keyChallenge": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.approvals.registerKey": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.approvals.listKeys": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.approvals.revokeKey": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.audit.list": "not a person action (screens only: audit screen)",
  "kin.audit.verify": "not a person action (screens only: audit screen)",
  "kin.levels.get": "not a person action (screens only: agent levels screen)",
  "kin.levels.lower": "stays in the app: 5 (host, company sections and settings)",
  "kin.levels.raise": "stays in the app: 5 (host, company sections and settings)",
  "kin.memory.undo": ["undo_memory_change"],
  "kin.memory.list": ["search_memory"],
  "kin.memory.setVisibility": "stays in the app: 3 (access to memory)",
  "kin.memory.confirmSuggestions": "stays in the app: 1 (tapping a card)",
  "kin.memory.forget": "stays in the app: 6 (deleting or archiving)",
  "kin.memory.restore":
    "not reached yet: forgetting ends the sharing approval and search_memory only reads current lines",
  "kin.memory.setTeamMemory": "stays in the app: 5 (host, company sections and settings)",
  "kin.work.summary": "not a person action (screens only: Tasks screen counts)",
  "kin.work.list": ["list_tasks", "list_my_tasks", "list_invoices", "list_entries"],
  "kin.work.get": ["get_task", "open_invoice"],
  "kin.work.subscribe": "not a person action (screens only: live Tasks stream)",
  "kin.work.create": ["create_task", "add_promise", "add_entry"],
  "kin.work.assign": ["update_task"],
  "kin.work.update": ["update_task", "set_task_state", "close_promise", "update_entry"],
  "kin.work.tickStep": ["tick_task_step"],
  "kin.work.handBack": ["hand_task_back"],
  "kin.work.nudge": ["nudge_task"],
  "kin.work.handOver": ["hand_over_tasks"],
  "kin.work.comment": ["comment_on_task"],
  "kin.work.commentRemove": "stays in the app: 6 (deleting or archiving)",
  "kin.work.comments": ["get_task"],
  "kin.work.linkAdd": ["add_link"],
  "kin.work.linkRemove": "stays in the app: 6 (deleting or archiving)",
  "kin.work.projectNote": ["set_project_note"],
  "kin.work.confirm": "stays in the app: 1 (tapping a card) (keeping an agent's suggestion)",
  "kin.work.share":
    "stays in the app: 3 (people, roles, switches, invitations, removing) (sharing tasks with the team: who sees what)",
  "kin.work.decline": "stays in the app: 1 (tapping a card) (declining an agent's suggestion)",
  "kin.work.parties": ["find"],
  "kin.work.party": ["open_client"],
  "kin.work.projects": ["find"],
  "kin.work.project": ["open_project"],
  "kin.work.history": "not a person action (screens only: a client's history timeline)",
  "kin.work.createParty": ["create_client"],
  "kin.work.updateParty": ["update_client"],
  "kin.work.createContact": ["update_client"],
  "kin.work.updateContact": ["update_client"],
  "kin.work.createProject": ["create_project"],
  "kin.work.updateProject": ["update_project"],
  "kin.work.projectPeople": "stays in the app: 3 (project membership and access)",
  "kin.work.logTouch": ["log_contact"],
  "kin.work.removeTouch": "stays in the app: 6 (deleting or archiving)",
  "kin.work.marketing": "not a person action (screens only: marketing screen filters)",
  "kin.work.contactList": "not a person action (screens only: marketing list screen)",
  "kin.work.exportContacts":
    "stays in the app: 2 (money or mail leaving, money paid/received) (contact data leaving as a file)",
  "kin.work.deals": ["list_deals"],
  "kin.work.deal": ["create_deal", "update_deal"],
  "kin.work.createDeal": ["create_deal"],
  "kin.work.createPartyWithDeal": ["create_client", "create_deal"],
  "kin.work.updateDeal": ["update_deal"],
  "kin.work.moveDeal": ["update_deal"],
  "kin.work.dealStep": ["update_deal"],
  "kin.work.dealStages": "not a person action (screens only: Settings → Deals)",
  "kin.work.setDealStages": "stays in the app: 5 (host, company sections and settings)",
  "kin.work.setDealQuietDays": "stays in the app: 5 (host, company sections and settings)",
  "kin.import.check": "not reached yet: importing a file needs an uploaded file; not exposed",
  "kin.import.apply": "not reached yet: importing a file; not exposed",
  "kin.import.undo": "stays in the app: 6 (deleting or archiving)",
  "kin.import.runs": "not a person action (screens only: import history screen)",
  "kin.docs.list": ["find"],
  "kin.docs.get": ["read_doc"],
  "kin.docs.history": "not a person action (screens only: a doc's version list)",
  "kin.docs.diff": "not a person action (screens only: version comparison view)",
  "kin.docs.restore": ["restore_doc_version"],
  "kin.docs.subscribe": "not a person action (screens only: live Docs stream)",
  "kin.search": ["find", "search_memory"],
  "kin.docs.recipes": "not a person action (screens only: document recipe picker)",
  "kin.docs.render":
    "not reached yet: making a document file from a recipe; agents do this (ask_agent)",
  "kin.docs.undoRecipe": "not reached yet: undoing a recipe change; not exposed",
  "kin.docs.label": "stays in the app: 3 (access to documents)",
  "kin.docs.file": "not a person action (screens only: a doc's file download)",
  "kin.docs.clearRecipeLabel": "stays in the app: 3 (access to documents)",
  "kin.docs.labelRecipe": "stays in the app: 3 (access to documents)",
  "kin.docs.setDefaultRecipe": "stays in the app: 5 (host, company sections and settings)",
  "kin.docs.startWhatWeSell": "stays in the app: 5 (host, company sections and settings)",
  "kin.docs.editSection": ["write_doc"],
  "kin.docs.sendUp":
    "not reached yet: sending a draft doc up to an agent; ask_agent is the nearest",
  "kin.docs.delete": "stays in the app: 6 (deleting or archiving)",
  "kin.work.lists": ["list_lists"],
  "kin.work.updateList":
    "stays in the app: 5 (host, company sections and settings) (a list's definition)",
  "kin.work.dates": "not a person action (screens only: Money dates screen)",
  "kin.work.money": ["money_summary"],
  "kin.work.cash":
    "not reached yet: statement and bank alert balances have no per-entry breakdown that can exclude private transactions",
  "kin.money.subscribe": "not a person action (screens only: live Money stream)",
  "kin.work.outlook":
    "not reached yet: runway includes the same unfilterable statement balances as cash and uses them in its figures",
  "kin.work.budgets": ["budgets"],
  "kin.work.setBudget": "stays in the app: 5 (host, company sections and settings)",
  "kin.work.entryLines": ["open_invoice"],
  "kin.work.invoiceFromQuote":
    "not reached yet: its unnumbered draft adds a backlink to the quote and writes to its money-list history",
  "kin.work.newInvoice": ["draft_invoice"],
  "kin.work.newExpense": "stays in the app: 2 (money)",
  "kin.work.matchPartner": "not reached yet: matching an import's partner to a person; not exposed",
  "kin.work.recordPayment": "stays in the app: 2 (money or mail leaving, money paid/received)",
  "kin.work.voidPayment": "stays in the app: 2 (money or mail leaving, money paid/received)",
  "kin.work.files": "not a person action (screens only: file picker for a form)",
  "kin.work.companyProfile": "not a person action (screens only: Settings → Company)",
  "kin.work.exportLink":
    "stays in the app: 2 (money or mail leaving, money paid/received) (data leaving as a download)",
  "kin.work.setCompanyProfile": "stays in the app: 5 (host, company sections and settings)",
  "kin.shell.set": "stays in the app: 5 (host, company sections and settings)",
  "kin.work.issue":
    "stays in the app: 2 (money or mail leaving, money paid/received) (numbering and issuing)",
  "kin.work.nextNumber": "not a person action (screens only: next number preview)",
  "kin.work.void": "stays in the app: 6 (deleting or archiving)",
  "kin.work.unvoid": "stays in the app: 2 (money state)",
  "kin.work.receipts": "not a person action (screens only: receipts list)",
  "kin.work.makeReceipt": "stays in the app: 2 (money or mail leaving, money paid/received)",
  "kin.work.statementUnlock":
    "stays in the app: 4 (connections, sign-ins, keys) (statement passwords)",
  "kin.work.statementForgetPassword": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.work.statementApply":
    "stays in the app: 2 (money or mail leaving, money paid/received) (recording bank money)",
  "kin.work.statementUndo": "stays in the app: 6 (deleting or archiving)",
  "kin.work.statementReread": "not reached yet: rereading a statement; not exposed",
  "kin.work.statementSelect": "not a person action (screens only: statement row selection)",
  "kin.work.statementRows": "not a person action (screens only: statement rows view)",
  "kin.work.statementPasswords": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.work.statementForgetAccount": "stays in the app: 6 (deleting or archiving)",
  "kin.bills.add": "stays in the app: 2 (money)",
  "kin.bills.list": "not a person action (screens only: Money bills list)",
  "kin.bills.keepRead": "stays in the app: 2 (money)",
  "kin.bills.addAnyway": "stays in the app: 2 (money)",
  "kin.bills.dismiss": "stays in the app: 6 (deleting or archiving)",
  "kin.bills.readAgain": "not reached yet: reading bills again; not exposed",
  "kin.push.registerDevice": "not a person action (screens only: this device's notifications)",
  "kin.push.unregisterDevice": "not a person action (screens only: this device's notifications)",
  "kin.push.watch": "not a person action (screens only: notification stream)",
  "kin.people.listInvites": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.people.revokeInvite": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.people.list": ["list_people"],
  "kin.people.createInvite": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.people.listDevices": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.people.revokeDevice": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.people.linkDevice": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.people.removeAccess": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.people.setGithubLogin": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.people.setAccess": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.people.setPlaces": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.access.me": "not a person action (screens only: what the signed-in screen may show)",
  "kin.tasksKeys.issue": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.tasksKeys.list": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.tasksKeys.revoke": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.refreshes.subscribe": "not a person action (screens only: live refresh stream)",
  "kin.pulse.read": ["list_waiting"],
  "kin.pulse.subscribe": "not a person action (screens only: live Pulse stream)",
  "kin.pulse.handle": "stays in the app: 1 (tapping a card) (marking a Pulse item handled)",
  "kin.pulse.aside": "stays in the app: 1 (tapping a card) (setting a Pulse item aside)",
  "kin.open.read": ["list_waiting"],
  "kin.open.subscribe": "not a person action (screens only: live Needs you stream)",
  "kin.recommendations.list": "not a person action (screens only: Settings → Recommendations)",
  "kin.recommendations.askAgain": "stays in the app: 5 (host, company sections and settings)",
  "kin.host.status": "not a person action (screens only: host screen)",
  "kin.host.freeSpace": "stays in the app: 5 (host, company sections and settings)",
  "kin.host.backUpNow": "stays in the app: 5 (host, company sections and settings)",
  "kin.host.retry": "stays in the app: 5 (host, company sections and settings)",
  "kin.watches.list": "not a person action (screens only: Kin keeps watch screen)",
  "kin.watches.log": "not a person action (screens only: watch log)",
  "kin.watches.look": "not a person action (screens only: watch detail)",
  "kin.watches.stop": "stays in the app: 6 (deleting or archiving)",
  "kin.watches.again": ["restart_watch"],
  "kin.goals.list": "not a person action (screens only: goals screen)",
  "kin.goals.save": ["save_goal"],
  "kin.numbers.list": ["read_numbers"],
  "kin.numbers.values": ["read_numbers"],
  "kin.numbers.record": ["record_number"],
  "kin.numbers.definitions": "not a person action (screens only: number setup form)",
  "kin.numbers.save":
    "stays in the app: 5 (host, company sections and settings) (a watched number's definition)",
  "kin.checkIns.list": "not a person action (screens only: Settings → Check-ins)",
  "kin.checkIns.save": "stays in the app: 5 (host, company sections and settings)",
  "kin.checkIns.act": "stays in the app: 1 (tapping a card)",
  "kin.briefs.list": "not a person action (screens only: Settings → Briefs)",
  "kin.briefs.save": "stays in the app: 5 (host, company sections and settings)",
  "kin.people.setOwnerName": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.refreshes.announce": "not a person action (screens only: screen refresh announcement)",
  "kin.people.profiles": ["list_people"],
  "kin.people.updateProfile":
    "stays in the app: 3 (people, roles, switches, invitations, removing) (a person's profile)",
  "kin.org.setTeamAgent": "stays in the app: 3 (people, roles, switches, invitations, removing)",
  "kin.connections.list": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.get": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.add": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.setKey": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.refreshTools": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.setToolModes": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.acceptToolChanges": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.update": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.setReach": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.remove": "stays in the app: 4 (connections, sign-ins, keys) / 6",
  "kin.connections.calls": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.signInStart": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.signInFinish": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.setSignInClient": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.setSendFrom": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.sendEdited":
    "stays in the app: 2 (money or mail leaving, money paid/received) (sending mail)",
  "kin.connections.saveEdited": "stays in the app: 1 (tapping a card) (editing a send card)",
  "kin.connections.mine": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.mineSignInStart": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.mineSignInFinish": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.connections.mineRemove": "stays in the app: 4 (connections, sign-ins, keys) / 6",
  "kin.connections.moveMailbox": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.connect.status": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.connect.start": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.connect.cancel": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.disconnect": "stays in the app: 4 (connections, sign-ins, keys) / 6",
  "kin.github.repos": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.repos.set": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.app.repos.set": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.guard.set": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.app.create": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.app.disconnect": "stays in the app: 4 (connections, sign-ins, keys) / 6",
  "kin.github.app.hook.allow": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.github.app.look": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.social.list": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.social.check": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.social.connect": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.social.refresh": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.social.remove": "stays in the app: 4 (connections, sign-ins, keys) / 6",
  "kin.social.link": "stays in the app: 4 (connections, sign-ins, keys)",
  "kin.pictures.get": "not a person action (screens only: agent pictures)",
  "kin.pictures.set": "stays in the app: 5 (host, company sections and settings)",
  "kin.push.reconcile": "not a person action (screens only: refresh device push state)",
};

it("the reach table covers every Kin RPC and names exactly the coding agent tools", () => {
  assert.sameMembers(
    Object.keys(reach),
    KinRpcs.map((rpc) => rpc._tag),
  );
  const tools = Object.values(reach).flatMap((entry) => (typeof entry === "string" ? [] : entry));
  assert.sameMembers([...new Set(tools)], TASKS_KEY_TOOLS);
});
