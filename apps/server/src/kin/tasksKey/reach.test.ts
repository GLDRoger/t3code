import { assert, it } from "@effect/vitest";
import { KinChatId, KinOrgId, KinPersonId, KinRecordKey, KinWaitingId } from "@t3tools/contracts";
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
