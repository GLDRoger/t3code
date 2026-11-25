import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { changedParts } from "./edits.ts";
import { collectMaterial } from "./material.ts";

const at = "2026-11-10T00:00:00.000Z";
const orgId = KinOrgId.make("org");
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

it.effect("attributes each journal entry to the lead that wrote it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const [org, agents] of [
      ["org", ["lead-tech", "lead-growth"]],
      ["other", ["lead-other"]],
    ] as const) {
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, ${org}, ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${`owner-${org}`}, ${org}, ${`owner-${org}`}, 'Owner', ${at})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${`chat-${org}`}, ${org}, 'team_group', 0, ${at})`;
      for (const agent of agents) {
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES (${agent}, ${org}, ${agent}, 'lead', ${`owner-${org}`}, ${at})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
          VALUES (${agent}, ${org}, ${agent}, 0, '{}', '[]', ${`chat-${org}`})`;
      }
    }
    const entry = (wakeup: string, agent: string, line: string) =>
      `\n## 09:00 · wake-up ${wakeup} · ${agent} · L2\n\nOutcome: completed\nEvents: e\n\n- ${line}\n`;
    const path = "journal/2026/11-10.md";
    const material = yield* collectMaterial({
      orgId,
      from: 0,
      until: Date.parse("2026-11-10T12:00:00.000Z"),
      full: false,
      timeZone: "UTC",
      files: new Map([
        [
          path,
          entry("w1", "lead-growth", "Launch post Friday.") +
            entry("w2", "lead-tech", "Merged the fix.") +
            // A dream may edit journal files; another org's lead is nobody here.
            entry("w3", "lead-other", "Planted."),
        ],
        ["journal/2026/11-09.md", entry("w0", "lead-tech", "One entry, whole file.")],
      ]),
    });
    assert.deepStrictEqual(
      material.entries.map(({ ref, saidBy, trust }) => ({ ref, saidBy, trust })),
      [
        { ref: "memory:journal/2026/11-09.md", saidBy: "lead-tech", trust: "agent" },
        { ref: `memory:${path}#w1`, saidBy: "lead-growth", trust: "agent" },
        { ref: `memory:${path}#w2`, saidBy: "lead-tech", trust: "agent" },
        { ref: `memory:${path}#w3`, saidBy: "kin", trust: "agent" },
      ],
    );
    assert.include(material.entries[1]?.text, "Launch post Friday.");
    assert.notInclude(material.entries[1]?.text, "Merged the fix.");
  }).pipe(Effect.provide(layer)),
);

// Review of 0a2a431b26: a nightly dream read every chat, so a teammate's words and a lead's reply
// to them could become the owner's memory.
it.effect("leaves out what a teammate could read or steer: their chats and shared turns", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Org', ${at})`;
    for (const person of ["owner", "teammate"])
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${person}, ${orgId}, ${person}, ${person}, ${at})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${at})`;
    for (const chat of ["dm", "team"])
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${chat}, ${orgId}, 'team_group', 0, ${at})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
      VALUES ('lead', ${orgId}, 'Lead', 0, '{}', '[]', 'dm')`;
    for (const [member, chat, kind, who, role] of [
      ["dm-owner", "dm", "person", "owner", "owner"],
      ["dm-lead", "dm", "agent", "lead", "member"],
      ["team-owner", "team", "person", "owner", "owner"],
      ["team-mate", "team", "person", "teammate", "member"],
      ["team-lead", "team", "agent", "lead", "member"],
    ] as const)
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, agent_id, role, joined_at)
        VALUES (${member}, ${orgId}, ${chat}, ${kind}, ${kind === "person" ? who : null},
          ${kind === "agent" ? who : null}, ${role}, ${at})`;
    // The teammate has left, but was there to read it.
    yield* sql`UPDATE kin_chat_members SET left_at = ${at} WHERE member_id = 'team-mate'`;
    const hour = (h: number) => Date.parse(`2026-11-10T0${h}:00:00.000Z`);
    for (const [id, audience, thread, start] of [
      ["w-owner", "owner_only", "kin:one", 1],
      ["w-shared", "shared", "kin-shared:two", 2],
      // Built for the owner alone, then found readable by someone else mid-turn.
      ["w-widened", "owner_only", "kin:three", 3],
    ] as const)
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, ended_at,
          status, event_ids, audience, shared_since)
        VALUES (${id}, ${orgId}, 'lead', ${thread}, 'model', ${hour(start)}, ${hour(start) + 60_000},
          'completed', '[]', ${audience}, ${id === "w-widened" ? hour(start) + 1 : null})`;
    let seq = 0;
    const say = (chat: string, member: string, body: string, minute: number, thread?: string) => {
      seq++;
      const createdAt = DateTime.formatIso(DateTime.makeUnsafe(minute));
      return thread === undefined
        ? sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
              author_member_id, author_role, kind, body, mentions_json, status, created_at)
            VALUES (${`m${seq}`}, ${orgId}, ${chat}, ${seq},
              'human', ${member === "team-mate" ? "teammate" : "owner"}, ${member},
              ${member === "team-mate" ? "member" : "owner"}, 'text', ${body}, '[]', 'posted', ${createdAt})`
        : sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_agent_id,
              author_owner_person_id, author_thread_id, author_member_id, author_role, kind, body,
              mentions_json, status, created_at)
            VALUES (${`m${seq}`}, ${orgId}, ${chat}, ${seq}, 'agent', 'lead', 'owner', ${thread},
              ${member}, 'member', 'text', ${body}, '[]', 'posted', ${createdAt})`;
    };
    yield* say("dm", "dm-owner", "Invented owner note", hour(1));
    yield* say("dm", "dm-lead", "Invented private reply", hour(1) + 30_000, "kin:one");
    yield* say("team", "team-mate", "Invented teammate ask", hour(2));
    yield* say("team", "team-lead", "Invented team reply", hour(2) + 30_000, "kin-shared:two");
    // A shared turn answering in the owner's chat, as a teammate's reminder does.
    yield* say("dm", "dm-lead", "Invented shared reply", hour(3) + 30_000, "kin:three");
    const entry = (wakeup: string, line: string) =>
      `\n## 09:00 · wake-up ${wakeup} · lead · L2\n\nOutcome: completed\nEvents: e\n\n- ${line}\n`;
    const material = yield* collectMaterial({
      orgId,
      from: 0,
      until: Date.parse("2026-11-10T12:00:00.000Z"),
      full: false,
      timeZone: "UTC",
      files: new Map([
        [
          "journal/2026/11-10.md",
          entry("w-owner", "Invented owner journal") +
            entry("w-shared", "Invented shared journal") +
            entry("w-widened", "Invented widened journal"),
        ],
      ]),
    });
    assert.deepStrictEqual(
      material.entries.map((entry) => entry.text.trim().split("\n").at(-1)),
      ["- Invented owner journal", "Invented owner note", "Invented private reply"],
    );
    // An item made from the teammate's ask is theirs to have read, so a full dream leaves it out.
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state)
      VALUES ('e-team', ${orgId}, 'lead', 'chat.message', 'P0', ${JSON.stringify({
        _tag: "chat.message",
        orgId,
        agentId: "lead",
        eventId: "e-team",
        receivedAt: at,
        dedupeKey: null,
        provenance: { _tag: "human", personId: "teammate", memberId: "team-mate" },
        chatId: "team",
        messageId: "m3",
      })}, 0, 0, 'done')`;
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state)
      VALUES ('e-dm', ${orgId}, 'lead', 'chat.message', 'P0', ${JSON.stringify({
        _tag: "chat.message",
        orgId,
        agentId: "lead",
        eventId: "e-dm",
        receivedAt: at,
        dedupeKey: null,
        provenance: { _tag: "human", personId: "owner", memberId: "dm-owner" },
        chatId: "dm",
        messageId: "m1",
      })}, 0, 0, 'done')`;
    const full = yield* collectMaterial({
      orgId,
      from: 0,
      until: Date.parse("2026-11-10T12:00:00.000Z"),
      full: true,
      timeZone: "UTC",
      files: new Map([
        [
          "deferrals/def-owner.md",
          fixtureItem({ id: "def-owner", chat: "dm", source_event: "e-dm" }),
        ],
        ["deferrals/def-team.md", fixtureItem({ id: "def-team", source_event: "e-team" })],
        // Fifth review of cfb0c8993b: a chat but no source event read as the owner's here and
        // as asked elsewhere in the index. Unresolved provenance is left out of both.
        ["deferrals/def-legacy.md", fixtureItem({ id: "def-legacy", chat: "dm" })],
      ]),
    });
    // A reminder is marked so, so nothing made from it reads as what the owner stated.
    assert.deepStrictEqual(
      full.entries
        .filter((entry) => entry.kind === "item")
        .map(({ ref, reminder }) => ({ ref, reminder })),
      [{ ref: "memory:deferrals/def-owner.md", reminder: true }],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a night takes only what was said since the last good one, so a quiet lead adds nothing",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Org', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES ('owner', ${orgId}, 'owner', 'Owner', ${at})`;
      const leads = ["lead-chief", "lead-tech", "lead-growth"];
      for (const lead of leads) {
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES (${lead}, ${orgId}, ${lead}, 'lead', 'owner', ${at})`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
        VALUES (${`dm-${lead}`}, ${orgId}, 'team_group', 0, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
        VALUES (${`owner-${lead}`}, ${orgId}, ${`dm-${lead}`}, 'person', 'owner', 'owner', ${at})`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES (${lead}, ${orgId}, ${lead}, 0, '{}', '[]', ${`dm-${lead}`})`;
      }
      const lastGood = Date.parse("2026-11-10T03:00:00.000Z");
      for (const [id, lead, createdAt] of [
        ["m-old", "lead-growth", "2026-11-09T15:00:00.000Z"],
        ["m-new", "lead-tech", "2026-11-10T09:00:00.000Z"],
      ] as const)
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
          author_member_id, author_role, kind, body, mentions_json, status, created_at)
        VALUES (${id}, ${orgId}, ${`dm-${lead}`}, 1, 'human', 'owner', ${`owner-${lead}`}, 'owner',
          'text', 'Invented note', '[]', 'posted', ${createdAt})`;
      const claim = (id: string, fields: Record<string, unknown> = {}) =>
        fixtureItem({ id, kind: "claim", due: null, ...fields });
      const teammate = { person: "p1", chat: "c1", name: "Invented person", chat_name: "Room" };
      const entry = (wakeup: string, agent: string) =>
        `\n## 09:00 · wake-up ${wakeup} · ${agent} · L2\n\nOutcome: completed\nEvents: e\n\n- Invented.\n`;
      const material = yield* collectMaterial({
        orgId,
        from: lastGood,
        until: Date.parse("2026-11-10T12:00:00.000Z"),
        full: false,
        timeZone: "UTC",
        files: new Map([
          ["journal/2026/11-09.md", entry("w-old", "lead-growth")],
          ["journal/2026/11-10.md", entry("w-new", "lead-tech")],
          ["claims/labelled.md", claim("labelled", { sensitive: true })],
          ["claims/legacy.md", claim("legacy")],
          ["claims/said.md", claim("said", { shared_from: teammate })],
        ]),
      });
      // An item nobody has labelled is material every night until it is; what a teammate's chat
      // left never is, labelled or not.
      assert.deepStrictEqual(
        material.entries.map(({ ref, saidBy, unlabelled }) => ({ ref, saidBy, unlabelled })),
        [
          { ref: "memory:journal/2026/11-10.md", saidBy: "lead-tech", unlabelled: undefined },
          { ref: "kin:chat:dm-lead-tech:message:m-new", saidBy: "owner", unlabelled: undefined },
          { ref: "memory:claims/legacy.md", saidBy: "demo-owner", unlabelled: true },
        ],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("a client's touches are material, stated by whoever logged them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Org', ${at})`;
    for (const person of ["owner", "teammate"])
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${person}, ${orgId}, ${person}, ${person}, ${at})`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('lead', ${orgId}, 'Lead', 'lead', 'owner', ${at})`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'clients', 'Clients', 'C', 1, 0)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, created_at, updated_at)
      VALUES (${orgId}, 'c1', 'clients', 'C-1', 'Invented Harbour', 'person', 'owner', 'person',
        'c1', 0, 0)`;
    const day = Date.parse("2026-11-10T09:00:00.000Z");
    for (const [id, kind, by, note] of [
      ["t-owner", "person", "owner", "Invented: prefers calls to email"],
      ["t-mate", "person", "teammate", "Invented: wants the revised quote by Friday"],
      ["t-lead", "agent", "lead", "Invented: asked about Android"],
    ] as const)
      yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, note,
          logged_by_kind, logged_by_id, origin_key, created_at)
        VALUES (${orgId}, ${id}, 'c1', ${day}, 'call', ${note}, ${kind}, ${by}, ${id}, ${day})`;
    const material = yield* collectMaterial({
      orgId,
      from: day - 1,
      until: day + 1,
      full: false,
      timeZone: "UTC",
      files: new Map(),
    });
    assert.deepStrictEqual(
      material.entries
        .filter((entry) => entry.kind === "touch")
        .map(({ ref, saidBy, trust, text }) => ({ ref, saidBy, trust, text })),
      [
        {
          ref: "kin:touch:t-lead",
          saidBy: "lead",
          trust: "agent",
          text: "Invented Harbour (C-1): call: Invented: asked about Android",
        },
        {
          ref: "kin:touch:t-mate",
          saidBy: "teammate",
          trust: "member",
          text: "Invented Harbour (C-1): call with teammate: Invented: wants the revised quote by Friday",
        },
        {
          ref: "kin:touch:t-owner",
          saidBy: "owner",
          trust: "owner",
          text: "Invented Harbour (C-1): call with owner: Invented: prefers calls to email",
        },
      ],
    );
  }).pipe(Effect.provide(layer)),
);

const day = Date.parse("2026-11-10T00:00:00.000Z");
const minute = (n: number) => day + n * 60_000;
/** Ambermill: Rhea owns it, Meera co-owns it, Zoya is a teammate; Finance drafts. */
const draftsOrg = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Ambermill', ${at})`;
  for (const [person, access] of [
    ["rhea", "owner"],
    ["meera", "co_owner"],
    ["zoya", "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at)
      VALUES (${person}, ${orgId}, ${person}, ${person}, ${access}, ${at})`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES ('finance', ${orgId}, 'Finance', 'lead', 'rhea', ${at})`;
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'docs', 'Docs', 'D', 1, 0)`;
  return sql;
});
/** A doc and its versions in order: who wrote each, when, and what it says. */
const doc = (
  sql: SqlClient.SqlClient,
  key: string,
  versions: ReadonlyArray<{
    readonly by: "finance" | "rhea" | "meera" | "zoya";
    readonly at: number;
    readonly body: string;
    readonly wakeup?: string;
    readonly origin?: string;
  }>,
  sensitive = false,
) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, created_by_kind, origin_key, sensitive, created_at, updated_at)
      VALUES (${orgId}, ${`r-${key}`}, 'docs', ${key}, ${`Follow-up to Tidewater Freight ${key}`},
        'agent', 'finance', 'agent', ${`r-${key}`}, ${sensitive ? 1 : 0}, 0, 0)`;
    for (const [index, version] of versions.entries()) {
      const agent = version.by === "finance";
      yield* sql`INSERT INTO kin_doc_versions (org_id, record_id, version, body, title, kind, summary,
          operations_json, actor_kind, actor_id, via, wakeup_id, origin_key, created_at)
        VALUES (${orgId}, ${`r-${key}`}, ${index + 1}, ${version.body}, ${key},
          ${index === 0 ? "created" : "rewritten"}, 's', '[]', ${agent ? "agent" : "person"},
          ${version.by}, 'kin', ${version.wakeup ?? null}, ${version.origin ?? `${key}-${index + 1}`},
          ${version.at})`;
    }
  });
const nightOf = (sql: SqlClient.SqlClient) =>
  collectMaterial({
    orgId,
    from: day,
    until: day + 86_400_000,
    full: false,
    timeZone: "UTC",
    files: new Map(),
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
const DRAFT = "Dear Sir/Madam,\n\nYour invoice is due.\n\nWe look forward to hearing from you.";
const RHEAS = "Hi Sam,\n\nYour invoice is due.";
/** The only words she typed: what she cut is no statement. */
const GREETING = [{ was: "Dear Sir/Madam", now: "Hi Sam" }];

it.effect(
  "an owner-level person's change to an agent's draft is an edit entry, whole on both sides",
  () =>
    Effect.gen(function* () {
      const sql = yield* draftsOrg;
      yield* sql`INSERT INTO kin_private_turns (org_id, wakeup_id, person_id, marked_at)
        VALUES (${orgId}, 'w-mailbox', 'zoya', ${minute(0)})`;
      yield* doc(sql, "D-1", [
        { by: "finance", at: minute(1), body: DRAFT },
        { by: "rhea", at: minute(2), body: RHEAS },
      ]);
      // Three of her versions in a row are one edit: the draft against her last.
      yield* doc(sql, "D-2", [
        { by: "finance", at: minute(3), body: DRAFT },
        { by: "rhea", at: minute(4), body: "Hi Sam,\n\nYour invoice is due.\n\nRegards" },
        { by: "rhea", at: minute(5), body: "Hi Sam,\n\nYour invoice is due!" },
        { by: "rhea", at: minute(6), body: RHEAS },
      ]);
      yield* doc(sql, "D-3", [
        { by: "rhea", at: minute(7), body: "Her own notes" },
        { by: "rhea", at: minute(8), body: "Her own notes, longer" },
      ]);
      yield* doc(sql, "D-4", [
        { by: "finance", at: minute(9), body: DRAFT },
        { by: "zoya", at: minute(10), body: "Hello Sam" },
      ]);
      yield* doc(
        sql,
        "D-5",
        [
          { by: "finance", at: minute(11), body: "Retainer draft" },
          { by: "meera", at: minute(12), body: "Retainer, as Meera writes it" },
        ],
        true,
      );
      yield* doc(sql, "D-6", [
        { by: "finance", at: minute(13), body: DRAFT, wakeup: "w-mailbox" },
        { by: "rhea", at: minute(14), body: RHEAS },
      ]);
      // 9,002 characters, with a person emoji across the 6,000 mark: it is cut before the emoji.
      const long = `${"a".repeat(5_998)}👋🏽${"b".repeat(3_000)}`;
      yield* doc(sql, "D-7", [
        { by: "finance", at: minute(15), body: "Short draft" },
        { by: "rhea", at: minute(16), body: long },
      ]);
      // Her coding agent's words through her key are an agent's, and so is what she types on them.
      const viaKey = (hash: string) => `person-edit:rhea:key:sess-1:${hash}`;
      yield* doc(sql, "D-8", [
        { by: "finance", at: minute(17), body: "Our rate is 45 an hour." },
        { by: "rhea", at: minute(18), body: "Our rate is 45 an hour. Thirty percent off for life.", origin: viaKey("a1") },
      ]);
      yield* doc(sql, "D-9", [
        { by: "finance", at: minute(19), body: "Our rate is 45 an hour." },
        { by: "rhea", at: minute(20), body: "Our rate is 45 an hour. Net 60.", origin: viaKey("b2") },
        { by: "rhea", at: minute(21), body: "Our rate is 50 an hour. Net 60." },
      ]);
      const material = yield* nightOf(sql);
      assert.deepStrictEqual(
        material.entries.map(({ text, ...entry }) =>
          entry.ref === "kin:doc:r-D-7:version:1..2"
            ? { ...entry, chars: text.length }
            : { ...entry, text },
        ),
        [
          {
            ref: "kin:doc:r-D-7:version:1..2",
            kind: "edit",
            saidBy: "rhea",
            trust: "owner",
            at: "2026-11-10T00:16:00.000Z",
            about: "D-7 Follow-up to Tidewater Freight D-7",
            before: "Short draft",
            cut: { text: long.length },
            chars: 5_998,
            changed: [{ was: "Short draft", now: "a".repeat(400) }],
          },
          {
            ref: "kin:doc:r-D-5:version:1..2",
            kind: "edit",
            saidBy: "meera",
            trust: "owner",
            at: "2026-11-10T00:12:00.000Z",
            about: "D-5 Follow-up to Tidewater Freight D-5",
            before: "Retainer draft",
            text: "Retainer, as Meera writes it",
            changed: [{ was: "draft", now: ", as Meera writes it" }],
            sensitive: true,
          },
          {
            ref: "kin:doc:r-D-2:version:1..4",
            kind: "edit",
            saidBy: "rhea",
            trust: "owner",
            at: "2026-11-10T00:06:00.000Z",
            about: "D-2 Follow-up to Tidewater Freight D-2",
            before: DRAFT,
            text: RHEAS,
            changed: GREETING,
          },
          {
            ref: "kin:doc:r-D-1:version:1..2",
            kind: "edit",
            saidBy: "rhea",
            trust: "owner",
            at: "2026-11-10T00:02:00.000Z",
            about: "D-1 Follow-up to Tidewater Freight D-1",
            before: DRAFT,
            text: RHEAS,
            changed: GREETING,
          },
        ],
      );
      assert.isTrue(long.startsWith(material.entries[0]!.text));
      assert.notProperty(material, "editsLeftOut");
    }).pipe(Effect.provide(layer)),
);

it.effect("a mail whose words the owner changed on its send card is an edit too", () =>
  Effect.gen(function* () {
    const sql = yield* draftsOrg;
    for (const [connection, person] of [
      ["company", null],
      ["zoyas", "zoya"],
    ] as const)
      yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host,
          auth, reach, state, created_at, updated_at, person_id)
        VALUES (${orgId}, ${connection}, 'google', 'Mail', 'builtin', 'mail.invalid', 'oauth',
          'closed', 'active', 0, 0, ${person})`;
    const mail = (subject: string, body: string) => ({
      _tag: "email",
      to: ["sam@tidewater.invalid"],
      cc: [],
      subject,
      body,
      threadId: null,
      inReplyTo: null,
      references: null,
      attachments: [],
    });
    for (const [ask, connection, by, confirmed] of [
      ["ask-edited", "company", "rhea", { subject: "Invoice", body: RHEAS }],
      ["ask-as-drafted", "company", "rhea", undefined],
      ["ask-own-mailbox", "zoyas", "zoya", { subject: "Invoice", body: "Hi Sam" }],
    ] as const)
      yield* sql`INSERT INTO kin_connection_asks (org_id, ask_id, connection_id, tool_name, pin_digest,
          payload_json, agent_id, wakeup_id, chat_id, state, proposed_at, decided_at, decided_by)
        VALUES (${orgId}, ${ask}, ${connection}, 'send', 'p', ${JSON.stringify({
          ...mail("Invoice", DRAFT),
          ...(confirmed === undefined
            ? {}
            : { confirmed: { to: ["sam@tidewater.invalid"], cc: [], ...confirmed } }),
        })}, 'finance', 'w', 'chat', 'sent', ${minute(1)}, ${minute(2)}, ${by})`;
    const material = yield* nightOf(sql);
    assert.deepStrictEqual(material.entries, [
      {
        ref: "kin:send:ask-edited",
        kind: "edit",
        saidBy: "rhea",
        trust: "owner",
        at: "2026-11-10T00:02:00.000Z",
        about: "Mail to sam@tidewater.invalid",
        before: `Subject: Invoice\n\n${DRAFT}`,
        text: `Subject: Invoice\n\n${RHEAS}`,
        changed: GREETING,
      },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("a night reads the newest 20 edits and says how many it left out", () =>
  Effect.gen(function* () {
    const sql = yield* draftsOrg;
    for (let n = 1; n <= 23; n++)
      yield* doc(sql, `D-${n}`, [
        { by: "finance", at: minute(2 * n), body: DRAFT },
        { by: "rhea", at: minute(2 * n + 1), body: `${RHEAS} ${n}` },
      ]);
    const material = yield* nightOf(sql);
    assert.deepStrictEqual(
      material.entries.map((entry) => entry.ref),
      Array.from({ length: 20 }, (_, i) => `kin:doc:r-D-${23 - i}:version:1..2`),
    );
    assert.strictEqual(material.editsLeftOut, 3);
  }).pipe(Effect.provide(layer)),
);

it.each([
  {
    name: "a changed word and an added clause",
    before: "Our rate is 45 an hour.",
    after: "Our rate is 50 an hour, from 1 January.",
    changed: [
      { was: "45", now: "50" },
      { was: "", now: ", from 1 January" },
    ],
  },
  {
    name: "a figure is one word",
    before: "Tidewater Freight owes 1,200 on INV/2026/015.",
    after: "Tidewater Freight owes 1,450 on INV/2026/015.",
    changed: [{ was: "1,200", now: "1,450" }],
  },
  {
    name: "a cut sentence states nothing",
    before: "Hi Sam. Thanks for the call. Your invoice is due.",
    after: "Hi Sam. Your invoice is due.",
    changed: [],
  },
  {
    name: "the same words wrapped differently are not typed",
    before: "Hi Sam,  your invoice\nis due.",
    after: "Hi Sam, your invoice is due.",
    changed: [],
  },
  {
    name: "a script written without spaces is compared word by word",
    before: "运费每公斤四十五元。",
    after: "运费每公斤五十元。",
    changed: [{ was: "四十五", now: "五十" }],
  },
  {
    name: "a rewritten run keeps what it replaced, cut where no character splits",
    before: "Old.",
    after: `${"a".repeat(399)}👋🏽 more`,
    changed: [{ was: "Old.", now: "a".repeat(399) }],
  },
  {
    name: "at most 12 runs from one edit",
    before: Array.from({ length: 14 }, (_, n) => `w${n} keep${n}`).join(" "),
    after: Array.from({ length: 14 }, (_, n) => `v${n} keep${n}`).join(" "),
    changed: Array.from({ length: 12 }, (_, n) => ({ was: `w${n}`, now: `v${n}` })),
  },
])("changedParts: $name", ({ before, after, changed }) => {
  assert.deepStrictEqual(changedParts(before, after), changed);
});
