import { assert, it } from "@effect/vitest";
import { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import { fixtureItem } from "../memory/__fixtures__/items.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
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
    const full = yield* collectMaterial({
      orgId,
      from: 0,
      until: Date.parse("2026-11-10T12:00:00.000Z"),
      full: true,
      timeZone: "UTC",
      files: new Map([
        ["deferrals/def-owner.md", fixtureItem({ id: "def-owner", chat: "dm" })],
        ["deferrals/def-team.md", fixtureItem({ id: "def-team", source_event: "e-team" })],
      ]),
    });
    assert.deepStrictEqual(
      full.entries.filter((entry) => entry.kind === "item").map((entry) => entry.ref),
      ["memory:deferrals/def-owner.md"],
    );
  }).pipe(Effect.provide(layer)),
);
