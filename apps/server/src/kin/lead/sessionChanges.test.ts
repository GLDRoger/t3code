import { expect, it } from "@effect/vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { KinAgentId, KinChatId, KinOrgId, KinWakeupId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { KIN_READ_TOOLS } from "../mcp/readTools.ts";
import { Memory } from "../memory/Memory.ts";
import { fakeRepository } from "../memory/__fixtures__/repository.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { decodeHead, memory } from "./LeadPrompt.testkit.ts";
import { renderSessionChanges } from "./LeadPrompt.ts";
import { readCursor, sessionChanges } from "./sessionChanges.ts";
import * as TestClock from "effect/testing/TestClock";

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const orgId = KinOrgId.make("tidewater");
const agentId = KinAgentId.make("finance");
const chatId = KinChatId.make("owner-chat");
const wakeupId = KinWakeupId.make("owner-turn");
const now = Date.UTC(2026, 10, 26, 14, 5);
const from = { changeSeq: 0, at: now - 3_600_000, memoryHead: null, chatSeq: 0, chatId, chatChangeSeq: 0, chatVersions: [] };
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
const unchangedMemory = Layer.mergeAll(
  memory,
  NodeFileSystem.layer,
  Layer.succeed(VcsProcess, { run: () => Effect.die("Unchanged memory must not use git") }),
);
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
      yield* change("W-2", [{ field: "state", to: "work-already-shown" }]);
      const to = yield* readCursor(orgId, chatId, null, agentId);
      yield* change("W-1", [{ field: "state", to: "after-cursor" }]);
      const { lines } = yield* sessionChanges({
        ...input,
        to,
        workChangedKeys: new Set(["W-2"]),
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
    expect(renderSessionChanges(result.lines, result.overflow)).toContain(
      "Not listed here: 2 more changes since your previous turn: 1 in Expenses by Arjun (import, 14:02), 1 in Invoices by Meera (co-owner). Read again what you need from those lists before you rely on it.",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("lists a memory item another commit edited and skips the session's own", () =>
  Effect.gen(function* () {
    yield* setup;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${directory}/.git/objects`, { recursive: true });
    const git = fakeRepository(fs);
    const before = git.commit();
    const after = git.commit();
    const fallback = yield* Effect.provide(VcsProcess, git.layer);
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
    const stub = yield* Effect.provide(Memory, memory);
    const result = yield* sessionChanges({
      ...input,
      from: { ...from, memoryHead: before },
      to: { ...(yield* readCursor(orgId, chatId, null, agentId)), memoryHead: after },
    }).pipe(
      Effect.provideService(Memory, {
        ...stub,
        ensureCheckouts: () => Effect.succeed({ writer: directory, read: directory }),
        readPromptSnapshot: () =>
          Effect.succeed({
            rules: "",
            index: "",
            items: [
              head(item, "Harborview renewal terms"),
              head(own, "own title"),
              head(outside, "external-memory-title"),
            ],
            bodies: new Map(),
          }),
      }),
      Effect.provideService(VcsProcess, {
        run: (request) =>
          Effect.map(fallback.run(request), (response) => {
            const { args } = request;
            const subject =
              args.at(-1) === own
                ? `kin(${agentId}): wake-up ${wakeupId}`
                : `kin(${agentId}): owner edits item`;
            const stdout = args.includes("diff")
              ? `M\0${item}\0M\0${own}\0M\0${outside}\0`
              : `1795701900\0${subject}\0${args.at(-1) === outside ? "Kin-Coding-Agent-For: rhea" : ""}\0`;
            return { ...response, stdout };
          }),
      }),
    );
    expect(result.lines).toEqual([
      'memory "Harborview renewal terms" (claims/harborview-terms.md): edited by the owner in Memory, 14:05',
      "outside-note (Memory): changed from outside content (a coding agent), 14:05; its words aren't shown here",
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeFileSystem.layer))),
);

it("every Kin read tool has a change source", () => {
  const coverage: Readonly<Record<string, string | { readonly uncovered: string }>> = {
    records_query: "record changes",
    record_get: "record changes and comments",
    client_read: {
      uncovered:
        "Client edits are listed, but touches of a client can change in kin_client_touches without a record change.",
    },
    money_summary: "record changes (including payments)",
    money_query: "record changes (including payments)",
    dates_query: {
      uncovered:
        "All-day timezone re-anchoring rewrites existing history without advancing its seq.",
    },
    deal_stages: "ends carry: lists",
    pulse_read: "pulse facts",
    pipeline_read: "record changes",
    people_read: "ends carry: standing",
    kin_leads: "ends carry: standing/lead",
    kin_computer: {
      uncovered: "Host and tool availability can change independently of the five sources.",
    },
    docs_search: "record changes",
    doc_read: "record changes",
    doc_history: "record changes",
    memory_read: "memory git diff and index",
    memory_search: "memory git diff and index",
    kin_chat_read: { uncovered: "New messages are listed, but edits and deletions are not." },
    read_numbers: "number values and record changes",
    numbers_read: "number values and record changes",
    list_define: "ends carry: lists",
    budgets: { uncovered: "Budget edits do not use the record change log." },
    kin_recipes: {
      uncovered: "Generated-document recipe edits are not list entry or list definition changes.",
    },
    kin_connection_tools: {
      uncovered: "Connection tool catalog changes have no source in this design.",
    },
    kin_github_read: "outside read",
    web_page: "outside read",
    kin_connection_call: "outside read",
    social_read: "outside read",
    social_lookup: "outside read",
    bill_read: "confined bills turn, never the owner carry seat",
    statement_read: "ends carry: sensitive read",
    statement_rows: "ends carry: sensitive read",
  };
  expect(Object.keys(coverage)).toEqual(
    expect.arrayContaining([
      ...KIN_READ_TOOLS,
      "memory_read",
      "memory_search",
      "kin_chat_read",
      "read_numbers",
      "numbers_read",
      "list_define",
      "budgets",
      "statement_read",
      "statement_rows",
      "bill_read",
      "kin_recipes",
      "kin_connection_tools",
      "kin_github_read",
      "web_page",
      "kin_connection_call",
      "social_read",
      "social_lookup",
    ]),
  );
  for (const [tool, source] of Object.entries(coverage)) {
    if (typeof source !== "string")
      process.stdout.write(`Not covered: ${tool}: ${source.uncovered}\n`);
  }
});
