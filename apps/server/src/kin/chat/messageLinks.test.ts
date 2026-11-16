import { assert, describe, it } from "@effect/vitest";
import {
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  type KinMessage,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { keysIn, matchLinks, withLinks, type LinkName } from "./messageLinks.ts";

// Invented company, people and records only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("rhea");
const mateId = KinPersonId.make("zoya");
const at = "2026-11-12T00:00:00.000Z";
const layer = KinPersistence.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
);

const finance: LinkName = {
  name: "Finance",
  to: { _tag: "chat", chatId: "finance-chat" },
  note: null,
  chat: true,
};
const orbit: LinkName = {
  name: "Orbit Dental",
  to: { _tag: "record", key: "C-1", kind: "client" },
  note: "Orbit Dental",
};
const orbitRetainer: LinkName = {
  name: "Orbit Dental retainer",
  to: { _tag: "record", key: "P-2", kind: "project" },
  note: "Orbit Dental retainer",
};
const invoice = { to: { _tag: "record" as const, key: "INV-1", kind: "entry" as const }, note: "INV-1" };

describe("matchLinks", () => {
  it("links exact names and document numbers once each, and nothing in code or links", () => {
    const body = [
      "Talk to Finance about INV-1 and the Orbit Dental retainer.",
      "Orbit Dental paid. finance was slow, INV-1 again, and `INV-1` in code.",
      "[INV-1](https://x.example) and https://x.example/INV-1 stay as written. FINANCE too.",
    ].join("\n");
    const links = matchLinks(body, [finance, orbit, orbitRetainer], new Map([["INV-1", invoice]]), false);
    assert.deepStrictEqual(
      links.map((link) => [link.text, link.to]),
      [
        ["Finance", finance.to],
        ["INV-1", invoice.to],
        // The longer name wins where they overlap; the client alone then links later.
        ["Orbit Dental retainer", orbitRetainer.to],
        ["Orbit Dental", orbit.to],
      ],
    );
  });

  it("links an agent named as a chat in any case, and Settings only when asked", () => {
    const body = "Ask the finance chat, then open Settings.";
    assert.deepStrictEqual(
      matchLinks(body, [finance], new Map(), true).map((link) => link.text),
      ["finance chat", "Settings"],
    );
    assert.deepStrictEqual(
      matchLinks(body, [finance], new Map(), false).map((link) => link.text),
      ["finance chat"],
    );
  });

  it("leaves words inside other words and keys it doesn't know alone", () => {
    const body = "Refinanced. COVID-19 and W-12x and XW-1 are not ours.";
    assert.deepStrictEqual(matchLinks(body, [finance], new Map([["W-1", invoice]]), false), []);
    assert.deepStrictEqual(keysIn("W-3, INV-12 and `D-7`"), ["W-3", "INV-12"]);
  });
});

const message = (body: string): KinMessage => ({
  orgId,
  chatId: KinChatId.make("room"),
  messageId: KinMessageId.make(`m-${body.length}`),
  seq: 1,
  author: {
    _tag: "agent",
    agentId: "chief" as never,
    memberId: KinMemberId.make("chief-member"),
    ownerPersonId: ownerId,
    threadId: "thread" as never,
  },
  authorRole: "member",
  kind: "text",
  body,
  intent: null,
  mentions: [],
  replyTo: null,
  widgetId: null,
  floorRunId: null,
  status: "posted",
  sentBy: null,
  createdAt: at,
  editedAt: null,
});

it.effect("links for each reader only what they may open; a hidden client leaves no trace", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Co', ${at})`;
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea Kapoor', ${at}, 'owner'),
        (${mateId}, ${orgId}, 'zoya', 'Zoya Sheikh', ${at}, 'member')`;
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES ('finance', ${orgId}, 'Finance', 'lead', ${ownerId}, ${at})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
      VALUES ('finance-chat', ${orgId}, 'direct', 'rhea:finance', 0, ${at})`;
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        agent_id, role, joined_at)
      VALUES ('rhea-in-finance', ${orgId}, 'finance-chat', 'person', ${ownerId}, NULL, 'owner', ${at}),
        ('finance-in-finance', ${orgId}, 'finance-chat', 'agent', NULL, 'finance', 'member', ${at})`;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
      VALUES (${orgId}, 'clients', 'Clients', 'C', 1, 0), (${orgId}, 'work', 'Work', 'W', 1, 0),
        (${orgId}, 'invoices', 'Invoices', 'INV', 1, 0)`;
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
        owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
      VALUES (${orgId}, 'c1', 'clients', 'C-1', 'Orbit Dental', 'person', ${ownerId}, 0, 'person', 'c1', 0, 0),
        (${orgId}, 'c3', 'clients', 'C-3', 'Lumen Grove', 'person', ${ownerId}, 1, 'person', 'c3', 0, 0),
        (${orgId}, 'w1', 'work', 'W-1', 'Logo files', 'person', ${mateId}, 0, 'person', 'w1', 0, 0),
        (${orgId}, 'i1', 'invoices', 'INV-1', 'Orbit Dental retainer', 'person', ${ownerId}, 0, 'person', 'i1', 0, 0)`;
    const said = message(
      "Talk to Finance about INV-1 for Orbit Dental. W-1 is with Zoya Sheikh. Lumen Grove and C-3 can wait. See Settings.",
    );
    const linksOf = (personId: KinPersonId) =>
      withLinks(orgId, { _tag: "person", personId }, [said]).pipe(
        Effect.map(([one]) => one!.links ?? []),
      );

    const owner = yield* linksOf(ownerId);
    assert.deepStrictEqual(
      owner.map((link) => [link.text, link.to._tag]),
      [
        ["Finance", "chat"],
        ["INV-1", "record"],
        ["Orbit Dental", "record"],
        ["W-1", "record"],
        ["Zoya Sheikh", "person"],
        ["Lumen Grove", "record"],
        ["C-3", "record"],
        ["Settings", "settings"],
      ],
    );
    assert.strictEqual(owner.find((link) => link.text === "W-1")?.note, "Logo files · Open");

    // Zoya has no Clients or Money place and no chat with Finance: only her own task links.
    const mate = yield* linksOf(mateId);
    assert.deepStrictEqual(mate, [
      { text: "W-1", to: { _tag: "record", key: "W-1", kind: "task" }, note: "Logo files · Open" },
    ]);
    // The private client is not named, numbered or hinted at anywhere in what she is sent.
    const sent = JSON.stringify(mate);
    for (const hidden of ["Lumen Grove", "C-3", "Orbit Dental", "INV-1", "finance-chat"])
      assert.notInclude(sent, hidden);

    // Agents read the words as written.
    const agent = yield* withLinks(orgId, { _tag: "agent", agentId: "finance" as never }, [said]);
    assert.isUndefined(agent[0]!.links);
  }).pipe(Effect.provide(layer)),
);
