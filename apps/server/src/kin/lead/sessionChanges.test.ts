import { expect, it } from "@effect/vitest";
import { KinAgentId, KinChatId, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinConnectionsToolkit } from "../connections/mcp.ts";
import { KinDocumentToolkit } from "../gendocs/mcp.ts";
import { KinChatToolkit } from "../mcp/KinChatToolkit.ts";
import { KinPictureToolkit } from "../pictures/mcp.ts";
import { KinPulseToolkit } from "../pulse/mcp.ts";
import { KinSalesToolkit } from "../sales/mcp.ts";
import { KinSocialToolkit } from "../social/mcp.ts";
import { KinBillToolkit } from "../work/mcp/billTools.ts";
import { KinDocsToolkit } from "../work/mcp/docTools.ts";
import { KinStatementToolkit } from "../work/mcp/statementTools.ts";
import { KinWorkToolkit } from "../work/mcp/tools.ts";
import { KinLeadToolkit } from "./mcp/tools.ts";
import { Memory } from "../memory/Memory.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { decodeHead, memory } from "./LeadPrompt.testkit.ts";
import { commentIdFor } from "../work/recordComments.ts";
import { renderSessionChanges } from "./LeadPrompt.ts";
import { readCursor, sessionChanges } from "./sessionChanges.ts";
import * as TestClock from "effect/testing/TestClock";

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const orgId = KinOrgId.make("tidewater");
const agentId = KinAgentId.make("finance");
const chatId = KinChatId.make("owner-chat");
const wakeupId = KinWakeupId.make("owner-turn");
const now = Date.UTC(2026, 10, 26, 14, 5);
const from = {
  changeSeq: 0,
  at: now - 3_600_000,
  memoryHead: null,
  chatSeq: 0,
  chatId,
  chatChangeSeq: 0,
  chatVersions: [],
};
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(now);
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
    VALUES (${orgId}, 'Tidewater Freight', '2026-11-26')`;
  yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, access, created_at)
    VALUES (${orgId}, 'rhea', 'rhea', 'Rhea', 'owner', '2026-11-26'),
      (${orgId}, 'meera', 'meera', 'Meera', 'co_owner', '2026-11-26'),
      (${orgId}, 'zoya', 'zoya', 'Zoya', 'member', '2026-11-26'),
      (${orgId}, 'arjun', 'arjun', 'Arjun', 'member', '2026-11-26')`;
  yield* sql`INSERT INTO kin_agents (org_id, agent_id, owner_person_id, display_name, role, created_at)
    VALUES (${orgId}, ${agentId}, 'rhea', 'Finance', 'lead', '2026-11-26')`;
  yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, title, last_seq, created_at)
    VALUES (${orgId}, ${chatId}, 'team_group', 'Owner room', 9, '2026-11-26'),
      (${orgId}, 'team', 'team_group', 'Team room', 0, '2026-11-26')`;
  yield* sql`INSERT INTO kin_leads
    (org_id, agent_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${orgId}, ${agentId}, 'Finance', ${now}, '{}', '[]', ${chatId})`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, created_at)
    VALUES (${orgId}, 'invoices', 'Invoices', 'INV', ${now}),
      (${orgId}, 'clients', 'Clients', 'CL', ${now}),
      (${orgId}, 'docs', 'Docs', 'DOC', ${now}),
      (${orgId}, 'work', 'Work', 'W', ${now}),
      (${orgId}, 'numbers', 'Numbers', 'NUM', ${now}),
      (${orgId}, 'expenses', 'Expenses', 'EXP', ${now})`;
  return sql;
});
const record = Effect.fn("Test.record")(function* (
  key: string,
  list: string,
  title: string,
  sensitive = false,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_records (org_id, record_id, key, register_id, title, owner_kind,
      owner_id, created_by_kind, origin_key, sensitive, created_at, updated_at)
    VALUES (${orgId}, ${key}, ${key}, ${list}, ${title}, 'person', 'rhea', 'person',
      ${key}, ${Number(sensitive)}, ${from.at}, ${now})`;
});

const change = Effect.fn("Test.change")(function* (
  key: string,
  fields: ReadonlyArray<{ field: string; from?: string; to: string }>,
  options: {
    actorId?: string;
    actorKind?: string;
    via?: string;
    wake?: string;
    chat?: string;
    codingKey?: string;
    at?: number;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number }>`INSERT INTO kin_record_changes (org_id, record_id,
      rev, at, actor_kind, actor_id, via, kind, fields_json, wakeup_id, chat_id, coding_agent_key)
    VALUES (${orgId}, ${key}, 2, ${options.at ?? now}, ${options.actorKind ?? "person"},
      ${options.actorId ?? "meera"}, ${options.via ?? "owner"}, 'updated',
      ${JSON.stringify(fields)}, ${options.wake ?? null}, ${options.chat ?? null},
      ${options.codingKey ?? null})
    RETURNING seq`;
  return row!.seq;
});
const input = {
  orgId,
  agentId,
  chatId,
  sessionWakeupIds: [wakeupId],
  from,
  now,
  zone: "UTC",
};
const unchangedMemory = memory;
const changes = Effect.fn("Test.changes")(function* () {
  const to = yield* readCursor(orgId, chatId, null, agentId);
  return yield* sessionChanges({ ...input, to }).pipe(Effect.provide(unchangedMemory));
});

it.effect("lists a co-owner's payment on an invoice", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* record("INV-12", "invoices", "October warehouse transfers");
    const seq = yield* change("INV-12", [{ field: "payment", to: "$1,000.00 on 2026-11-26" }]);
    const to = yield* readCursor(orgId, chatId, null, agentId);
    expect(to).toMatchObject({ changeSeq: seq, at: now, memoryHead: null, chatSeq: 9 });
    expect((yield* changes()).lines).toEqual([
      'INV-12 "October warehouse transfers" (Invoices): payment $1,000.00 on 2026-11-26 by Meera (co-owner), 14:05',
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists a client edit, a doc version and a comment without their text", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("CL-7", "clients", "Harborview Cold Storage");
    yield* record("DOC-5", "docs", "Pier 4 handling notes");
    yield* record("NUM-3", "numbers", "Trucks out");
    yield* change("CL-7", [
      { field: "terms", to: "Net 15" },
      { field: "billing email", to: "ap@harborview.example" },
    ]);
    yield* change(
      "DOC-5",
      [
        { field: "version", from: "3", to: "4" },
        { field: "body", to: "body-secret" },
      ],
      { actorId: "zoya" },
    );
    yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
        author_id, body, request_hash, created_at, removed_at, removed_by_kind, removed_by_id)
      VALUES (${orgId}, 'comment', 'DOC-5', 1, 'agent', ${agentId}, 'comment-secret',
        'fake', ${now - 1}, ${now}, 'person', 'zoya'),
        (${orgId}, 'added', 'DOC-5', 2, 'person', 'arjun', 'comment-secret',
        'other', ${now}, NULL, NULL, NULL)`;
    yield* sql`INSERT INTO kin_number_values (org_id, record_id, as_of, seq, value, person_id, recorder_name, created_at)
      VALUES (${orgId}, 'NUM-3', '2026-11-26', 1, '14', 'zoya', 'Zoya', ${now})`;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, principal_kind, agent_id, role, joined_at)
      VALUES (${orgId}, 'team', 'finance-team', 'agent', ${agentId}, 'member', '2026-11-26')`;
    yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${orgId}, 'team', 'signal', 1, 'system', 'member', 'text', 'chat-secret',
        '[]', 'posted', '2026-11-26T14:05:00.000Z')`;
    yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, first_seen_at, last_seen_at,
        handled_at, handled_by_kind, handled_by_id, handled_note)
      VALUES (${orgId}, 'fact', 'invented', ${now}, ${now}, ${now}, 'person', 'meera', 'pulse-secret')`;
    const { lines } = yield* changes();
    expect(lines).toEqual(
      expect.arrayContaining([
        'CL-7 "Harborview Cold Storage" (Clients): terms → "Net 15", billing email → "ap@harborview.example" by Meera (co-owner), 14:05',
        'DOC-5 "Pier 4 handling notes" (Docs): edited, version 3 → 4, body edited by Zoya, 14:05',
        'DOC-5 "Pier 4 handling notes" (Docs): comment removed by Zoya, 14:05',
        'DOC-5 "Pier 4 handling notes" (Docs): comment added by Arjun, 14:05',
        'NUM-3 "Trucks out" (Numbers): 14 recorded by Zoya, 14:05',
        "Team room: 1 new message from Kin",
        "Pulse: 1 new signal, 1 handled by Meera (co-owner)",
      ]),
    );
    expect(lines.join("\n")).not.toContain("-secret");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "leaves out the session's own writes and keeps the same agent's from another session",
  () =>
    Effect.gen(function* () {
      yield* setup;
      yield* record("W-1", "work", "Check loading bay");
      yield* record("W-2", "work", "Check cold storage");
      for (const [wake, chat, value] of [
        [wakeupId, chatId, "own-value"],
        ["other-turn", "team", "other-value"],
        [null, "team", "worker-value"],
      ] as const) {
        yield* change("W-1", [{ field: "state", to: value }], {
          actorKind: "agent",
          actorId: agentId,
          via: wake === null ? "worker" : "lead",
          ...(wake === null ? {} : { wake }),
          chat,
        });
      }
      const shown = yield* change("W-2", [{ field: "state", to: "work-already-shown" }]);
      const to = yield* readCursor(orgId, chatId, null, agentId);
      yield* change("W-1", [{ field: "state", to: "after-cursor" }]);
      const { lines } = yield* sessionChanges({
        ...input,
        to,
        workChanges: new Map([["W-2", new Set([shown])]]),
      }).pipe(Effect.provide(unchangedMemory));
      expect(lines).toEqual([
        'W-1 "Check loading bay" (Work): state → "other-value" by you, in Team room, 14:05',
        'W-1 "Check loading bay" (Work): state → "worker-value" by your task, 14:05',
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("shows a sensitive entry and an outside change by key and list only", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("INV-9", "invoices", "sensitive-title", true);
    yield* record("W-22", "work", "external-title");
    for (const [key, options, secret] of [
      ["INV-9", {}, "sensitive"],
      ["W-22", { codingKey: "invented-key" }, "external"],
      ["W-22", { via: "github" }, "github"],
      ["W-22", {}, "stamped"],
    ] as const) {
      const seq = yield* change(
        key,
        [
          { field: "amount", to: `${secret}-value` },
          { field: "notes", to: `${secret}-note` },
        ],
        options,
      );
      if (secret === "stamped")
        yield* sql`INSERT INTO kin_event_outside (org_id, event_id, outside_from)
          VALUES (${orgId}, ${`record-change:${key}:${seq}`}, 'web:example.invalid')`;
    }
    const { lines } = yield* changes();
    expect(lines).toEqual([
      "INV-9 (Invoices): changed by Meera (co-owner), 14:05; a sensitive entry, not shown here",
      "W-22 (Work): changed from outside content (a coding agent), 14:05; its words aren't shown here",
      "W-22 (Work): changed from outside content, 14:05; its words aren't shown here",
      "W-22 (Work): changed from outside content, 14:05; its words aren't shown here",
    ]);
    for (const secret of [
      "sensitive-title",
      "sensitive-value",
      "sensitive-note",
      "external-title",
      "external-value",
      "external-note",
      "github-value",
      "github-note",
      "stamped-value",
      "stamped-note",
    ])
      expect(lines.join("\n")).not.toContain(secret);
    expect(yield* sql`SELECT 1 FROM kin_wakeup_sensitive_reads WHERE org_id = ${orgId}`).toEqual(
      [],
    );
    expect(yield* sql`SELECT 1 FROM kin_wakeup_outside_reads WHERE org_id = ${orgId}`).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect("past 30 things, groups the rest by list and who", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* record("EXP-1", "expenses", "Fuel");
    yield* record("INV-12", "invoices", "Transfers");
    yield* change("EXP-1", [{ field: "amount", to: "$20" }], {
      actorId: "arjun",
      via: "import",
      at: now - 3 * 60_000,
    });
    yield* change("INV-12", [{ field: "state", to: "open" }]);
    for (let i = 1; i <= 30; i++) {
      const key = `W-${i}`;
      yield* record(key, "work", `Item ${i}`);
      yield* change(key, [{ field: "state", to: "done" }]);
    }
    const result = yield* changes();
    expect(result).toMatchObject({ shown: 30, total: 32 });
    expect(result.lines.map((line) => line.split(" ", 1)[0])).toEqual(
      Array.from({ length: 30 }, (_, i) => `W-${i + 1}`),
    );
    expect(renderSessionChanges(result.lines, result.overflow.slice(0, 1))).toContain(
      "Not listed here: 1 more change since your previous turn:",
    );
    expect(renderSessionChanges(result.lines, result.overflow)).toContain(
      "Not listed here: 2 more changes since your previous turn: 1 in Expenses by Arjun (import, 14:02), 1 in Invoices by Meera (co-owner). Read again what you need from those lists before you rely on it.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("counts changes past the SQL limit and the four per-entry lines", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("W-14", "work", "Check loading bay");
    yield* sql`WITH RECURSIVE edits(rev) AS (
        VALUES (2) UNION ALL SELECT rev + 1 FROM edits WHERE rev < 201
      )
      INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind,
        actor_id, via, kind, fields_json)
      SELECT ${orgId}, 'W-14', rev, ${now}, 'person', 'arjun', 'owner', 'updated',
        json_array(json_object('field', 'due', 'to', '2026-11-30'))
      FROM edits`;
    const result = yield* changes();
    expect(result).toMatchObject({
      shown: 4,
      total: 200,
      overflow: [{ list: "Work", who: "Arjun", count: 196 }],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("lists a memory item another commit edited and skips the session's own", () =>
  Effect.gen(function* () {
    yield* setup;
    const before = "a".repeat(40);
    const after = "b".repeat(40);
    const item = "claims/harborview-terms.md";
    const own = "claims/another-note.md";
    const outside = "claims/outside-note.md";
    function head(path: string, title: string) {
      return decodeHead({
        orgId,
        id: path.split("/")[1]?.replace(".md", ""),
        path,
        title,
        kind: "claim",
        status: "open",
        owner: "finance",
        recorded_at: "2026-11-26T14:05:00Z",
        valid_from: "2026-11-26T14:05:00Z",
        source: "https://example.invalid",
        trust: "owner",
        said_by: "rhea",
        links: [],
        sensitive: false,
        due: null,
        invalid_at: null,
        superseded_by: null,
        review_by: null,
      });
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_wakeups (org_id, agent_id, wakeup_id, model, started_at, ended_at, status, event_ids)
      VALUES (${orgId}, ${agentId}, 'memory-team-turn', 'test', ${now - 1}, ${now}, 'completed', '[]')`;
    yield* sql`INSERT INTO kin_events (org_id, agent_id, event_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES (${orgId}, ${agentId}, 'memory-ask', 'chat.message', 'P0', '{"chatId":"team"}',
        ${now - 1}, ${now - 1}, 'done', 'memory-team-turn')`;
    const stub = yield* Effect.provide(Memory, memory);
    const result = yield* sessionChanges({
      ...input,
      from: { ...from, memoryHead: before },
      to: { ...(yield* readCursor(orgId, chatId, null, agentId)), memoryHead: after },
    }).pipe(
      Effect.provideService(Memory, {
        ...stub,
        changedItems: (_org, _from, _to, options) =>
          Effect.sync(() => {
            expect(options.excludeSubjects).toContain(`kin(${agentId}): wake-up ${wakeupId}`);
            return {
              items: [
                {
                  path: item,
                  at: now,
                  subject: `kin(${agentId}): wake-up memory-team-turn`,
                  coding: false,
                  head: head(item, "Harborview renewal terms"),
                },
                {
                  path: outside,
                  at: now,
                  subject: "kin: owner edits item",
                  coding: true,
                  head: head(outside, "external-memory-title"),
                },
                { path: own, at: now, subject: "kin: owner edits item", coding: false },
              ],
              overflow: 0,
            };
          }),
      }),
    );
    expect(result.lines).toEqual([
      'memory "Harborview renewal terms" (claims/harborview-terms.md): edited by you, in Team room, 14:05',
      "outside-note (Memory): changed from outside content (a coding agent), 14:05; its words aren't shown here",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists Zoya's comment stamped just before the cursor and committed after it", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("DOC-5", "docs", "Pier 4 handling notes");
    const cursor = yield* readCursor(orgId, chatId, null, agentId);
    yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
        author_id, body, request_hash, created_at)
      VALUES (${orgId}, 'late', 'DOC-5', 1, 'person', 'zoya', 'comment-secret', 'late', ${now - 100})`;
    const { lines } = yield* sessionChanges({ ...input, from: cursor, to: cursor }).pipe(
      Effect.provide(unchangedMemory),
    );
    expect(lines).toEqual(['DOC-5 "Pier 4 handling notes" (Docs): comment added by Zoya, 14:04']);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists Rhea undoing an import after its expenses and change log disappeared", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* sql`INSERT INTO kin_import_runs (org_id, batch, action, person_id, started_at,
        finished_at, lists_json, summary_json)
      VALUES (${orgId}, 'expenses-200', 'apply', 'rhea', ${from.at}, ${from.at}, '["expenses"]', '{}'),
        (${orgId}, 'expenses-200', 'undo', 'rhea', ${now - 180000}, ${now - 180000}, '[]',
          '{"expenses":200,"note":"import-secret"}')`;
    expect((yield* changes()).lines).toEqual(["Expenses: import undone by Rhea (owner), 14:02"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses the Team room before reading any change source", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    const to = yield* readCursor(orgId, chatId, null, agentId);
    yield* sql`DROP TABLE kin_record_changes`;
    const error = yield* sessionChanges({ ...input, chatId: "team", to }).pipe(
      Effect.provide(unchangedMemory),
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "SessionChangesNotOwnerChat" });
  }).pipe(Effect.provide(layer)),
);

it.effect("reports which source failed when the comments table is missing", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    const to = yield* readCursor(orgId, chatId, null, agentId);
    yield* sql`DROP TABLE kin_record_comments`;
    const error = yield* sessionChanges({ ...input, to }).pipe(
      Effect.provide(unchangedMemory),
      Effect.flip,
    );
    expect(error).toMatchObject({ _tag: "SessionChangesSourceFailed", source: "comments" });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps Arjun's new due date when Work renders only an older change to W-14", () =>
  Effect.gen(function* () {
    yield* setup;
    yield* record("W-14", "work", "Check loading bay");
    const shown = yield* change("W-14", [{ field: "state", to: "doing" }]);
    yield* change("W-14", [{ field: "due", to: "2026-11-30" }], { actorId: "arjun" });
    const to = yield* readCursor(orgId, chatId, null, agentId);
    const options = {
      ...input,
      to,
      workChanges: new Map([["W-14", new Set([shown])]]),
    };
    expect((yield* sessionChanges(options).pipe(Effect.provide(unchangedMemory))).lines).toEqual([
      'W-14 "Check loading bay" (Work): due → "2026-11-30" by Arjun, 14:05',
    ]);
    expect((yield* changes()).lines).toHaveLength(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("counts edits and withdrawals by chat without selecting any message text", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, member_id, principal_kind, agent_id, role, joined_at)
      VALUES (${orgId}, 'team', 'finance-team', 'agent', ${agentId}, 'member', '2026-11-26')`;
    yield* sql`INSERT INTO kin_messages (org_id, chat_id, message_id, seq, author_kind, author_role,
        kind, body, mentions_json, status, created_at)
      VALUES (${orgId}, 'team', 'edit', 1, 'system', 'member', 'text', 'rate-secret', '[]', 'posted', '2026-11-25'),
        (${orgId}, 'team', 'withdraw', 2, 'system', 'member', 'text', 'withdraw-secret', '[]', 'posted', '2026-11-25')`;
    yield* sql`UPDATE kin_chats SET last_seq = 2 WHERE org_id = ${orgId} AND chat_id = 'team'`;
    const before = yield* readCursor(orgId, chatId, null, agentId);
    yield* sql`UPDATE kin_messages SET edited_at = '2026-11-26T14:05:00.000Z'
      WHERE message_id = 'edit'`;
    yield* sql`UPDATE kin_messages SET withdrawn_json = '{"at":"2026-11-26T14:05:00.000Z"}'
      WHERE message_id = 'withdraw'`;
    const to = yield* readCursor(orgId, chatId, null, agentId);
    expect(
      (yield* sessionChanges({ ...input, from: before, to }).pipe(Effect.provide(unchangedMemory)))
        .lines,
    ).toEqual(["Team room: 2 messages edited or withdrawn"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("lists Harborview contact activity and withholds sensitive and outside titles", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("CL-7", "clients", "Harborview Cold Storage");
    yield* record("CL-8", "clients", "sensitive-client-secret", true);
    yield* record("CL-9", "clients", "outside-client-secret");
    yield* change("CL-9", [{ field: "title", to: "outside-client-secret" }], { via: "github" });
    yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, note,
        logged_by_kind, logged_by_id, origin_key, created_at, removed_at)
      VALUES (${orgId}, 'harborview', 'CL-7', ${now - 200}, 'call', 'touch-secret',
          'person', 'zoya', 'harborview', ${now - 100}, ${now}),
        (${orgId}, 'sensitive', 'CL-8', ${now}, 'call', 'touch-secret',
          'person', 'zoya', 'sensitive', ${now}, NULL),
        (${orgId}, 'outside', 'CL-9', ${now}, 'call', 'touch-secret',
          'person', 'zoya', 'outside', ${now}, NULL)`;
    const { lines } = yield* changes();
    expect(lines).toEqual(
      expect.arrayContaining([
        'CL-7 "Harborview Cold Storage" (Clients): contact logged by Zoya, 14:04',
        'CL-7 "Harborview Cold Storage" (Clients): contact removed by Kin, 14:05',
        "CL-8 (Clients): changed by Zoya, 14:05; a sensitive entry, not shown here",
        "CL-9 (Clients): changed from outside content, 14:05; its words aren't shown here",
      ]),
    );
    expect(lines.join("\n")).not.toContain("-secret");
  }).pipe(Effect.provide(layer)),
);

it.effect("lists the Finance agent's own comment from the Team room", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    yield* record("DOC-5", "docs", "Pier 4 handling notes");
    yield* sql`INSERT INTO kin_wakeups (org_id, agent_id, wakeup_id, model, started_at, ended_at, status, event_ids)
      VALUES (${orgId}, ${agentId}, 'team-turn', 'test', ${now - 1}, ${now}, 'completed', '["team-ask"]')`;
    yield* sql`INSERT INTO kin_events (org_id, agent_id, event_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
      VALUES (${orgId}, ${agentId}, 'team-ask', 'chat.message', 'P0',
        '{"chatId":"team"}', ${now - 1}, ${now - 1}, 'done', 'team-turn')`;
    const id = commentIdFor(
      orgId,
      "DOC-5",
      { _tag: "agent", agentId, askedBy: null },
      "team-turn:note",
    );
    yield* sql`INSERT INTO kin_record_comments (org_id, comment_id, record_id, seq, author_kind,
        author_id, body, request_hash, created_at)
      VALUES (${orgId}, ${id}, 'DOC-5', 1, 'agent', ${agentId}, 'comment-secret', 'note', ${now})`;
    expect((yield* changes()).lines).toEqual([
      'DOC-5 "Pier 4 handling notes" (Docs): comment added by you, in Team room, 14:05',
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "every tool registered for the owner seat has a change source or an explicit exception",
  () =>
    Effect.sync(() => {
      const coverage: Readonly<Record<string, string | { readonly uncovered: string }>> = {
        records_query: "record changes",
        record_get: "record changes and comments",
        client_read: "record changes and contacts",
        money_summary: "record changes (including payments)",
        money_query: "record changes (including payments)",
        dates_query: "record changes; ends carry: zone",
        deal_stages: "ends carry: lists",
        pulse_read: "pulse facts",
        pipeline_read: "record changes",
        people_read: "ends carry: standing",
        kin_leads: "ends carry: standing/lead",
        kin_computer: {
          uncovered: "live state, excepted in the note's words (step 3)",
        },
        docs_search: "record changes",
        doc_read: "record changes",
        doc_history: "record changes",
        memory_read: "memory commit history and index",
        memory_search: "memory commit history and index",
        kin_chat_read: "chat message change sequences",
        read_numbers: "number values and record changes",
        numbers_read: "number values and record changes",
        list_define: "ends carry: lists",
        budgets: "ends carry: budgets; expenses in record changes",
        kin_recipes: "ends carry: recipes",
        kin_connection_tools: {
          uncovered: "live state, excepted in the note's words (step 3)",
        },
        kin_github_read: "outside read",
        web_page: "outside read",
        kin_connection_call: "outside read",
        social_read: "outside read",
        social_lookup: "outside read",
        bill_read: "confined bills turn, never the owner carry seat",
        statement_read: "ends carry: sensitive read",
        statement_rows: "ends carry: sensitive read",
        people_update: "write-only",
        away_set: "write-only",
        agent_update: "write-only",
        kin_hand_off: "write-only",
        kin_take_private: "write-only",
        kin_relay: "write-only",
        team_open: "write-only",
        team_say: "write-only",
        kin_ask: "write-only",
        kin_ask_close: "write-only",
        kin_ask_person: "write-only",
        kin_chart: "write-only",
        kin_visual: "write-only",
        kin_react: "write-only",
        message_withdraw: "write-only",
        message_replace: "write-only",
        memory_write: "write-only",
        memory_label: "write-only",
        kin_defer: "write-only",
        kin_schedule: "write-only",
        kin_cancel: "write-only",
        kin_journal: "write-only",
        kin_github_review_ask: "write-only",
        kin_github_watch: "write-only",
        kin_github_link: "write-only",
        number_record: "write-only",
        touch_log: "write-only",
        record_create: "write-only",
        record_update: "write-only",
        record_assign: "write-only",
        record_hand_back: "write-only",
        record_comment: "write-only",
        record_link: "write-only",
        project_note: "write-only",
        payment_record: "write-only",
        budget_set: "write-only",
        numbers_watch: "write-only",
        doc_create: "write-only",
        doc_edit: "write-only",
        doc_rewrite: "write-only",
        doc_move: "write-only",
        doc_link: "write-only",
        doc_restore: "write-only",
        bills_add: "write-only",
        kin_document: "write-only",
        kin_issue: "write-only",
        kin_receipt: "write-only",
        kin_recipe_undo: "write-only",
        kin_picture: "write-only",
        pulse_handle: "write-only",
        pulse_nudge: "write-only",
        kin_chat_post: "write-only",
        kin_widget_upsert: "write-only",
        kin_connection_offer: "write-only",
        kin_connection_note: "write-only",
        kin_github_review: "outside read",
        kin_github_diff: "outside read",
        company_profile: "ends carry: standing",
        company_sections: "ends carry: standing",
        social_draft: "outside read",
        social_week: "outside read",
        social_pack: "outside read",
      };
      const registered = [
        KinLeadToolkit,
        KinWorkToolkit,
        KinDocsToolkit,
        KinStatementToolkit,
        KinBillToolkit,
        KinDocumentToolkit,
        KinPictureToolkit,
        KinPulseToolkit,
        KinSalesToolkit,
        KinSocialToolkit,
        KinChatToolkit,
        KinConnectionsToolkit,
      ].flatMap((toolkit) => Object.keys(toolkit.tools));
      expect(registered.filter((name) => !Object.hasOwn(coverage, name))).toEqual([]);
      for (const [tool, source] of Object.entries(coverage)) {
        if (typeof source !== "string")
          process.stdout.write(`Not covered: ${tool}: ${source.uncovered}\n`);
      }
    }),
);
