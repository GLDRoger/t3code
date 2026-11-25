// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL } from "../lead/Audience.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import {
  followsOutsideRead,
  inheritOutside,
  outsideToolAllowed,
  stampEvent,
} from "../lead/OutsideContent.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { answerChange } from "../work/companyProfile.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as LeadMoney from "../work/leadMoney.ts";
import { answerShellChange, shellDecision } from "./changes.ts";
import { propose } from "./mcp.ts";
import * as KinShell from "./KinShell.ts";

const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T06:00:00.000Z");

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
  owner: { _tag: "person" as const, orgId, personId: ownerId },
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
// Kin's card for the owner, stored as the chat service stores a lead's question and bound in the
// same transaction; a replaced card is marked as `KinChatService.closeReplaced` marks it.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      ask: (_agent, input, bind) =>
        Effect.gen(function* () {
          const widgetId = `choice:${input.clientMessageId}`;
          const state = { question: input.question, detail: input.detail ?? null, answer: null };
          const [{ seq }] = (yield* sql<{ seq: number }>`SELECT 1000 + COUNT(*) AS seq
            FROM kin_widgets`) as [{ seq: number }];
          yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
              author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
              author_role, kind, body, mentions_json, status, created_at)
            VALUES (${`card-${widgetId}`}, ${orgId}, ${input.chatId}, ${seq}, 'agent', ${lead},
              ${ownerId}, 'lead-thread', 'lead-chat-lead', 'member', 'text', '', '[]', 'posted',
              ${at})
            ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
              type, revision, state_json, awaiting_json, updated_at)
            VALUES (${widgetId}, ${orgId}, ${input.chatId}, ${`card-${widgetId}`}, 'native',
              'choice', 1, ${JSON.stringify(state)}, ${JSON.stringify([ownerId])}, ${at})
            ON CONFLICT DO NOTHING`;
          if (bind !== undefined) yield* bind({ widgetId } as never);
          return { widgetId } as never;
        }).pipe(sql.withTransaction, Effect.orDie),
      closeReplaced: (_agent, widgetIds) =>
        Effect.forEach(
          widgetIds,
          (widgetId) => sql`UPDATE kin_widgets SET closed_at = ${at},
            state_json = json_set(state_json, '$.replaced', json('true'))
            WHERE widget_id = ${widgetId}`,
        ).pipe(Effect.asVoid, Effect.orDie),
    }),
  ),
);
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-shell-changes-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** The owner (Rhea), a member (Meera) and one lead with its direct chat with the owner. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${mateId}, ${orgId}, 'meera', 'Meera', ${at}, 'member')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
      created_at, retired_at)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 'lead', ${ownerId}, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('lead-chat', ${orgId}, 'direct', 'owner:lead', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES ('lead-chat-owner', ${orgId}, 'lead-chat', 'person', ${ownerId}, 'owner', ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
      role, joined_at)
    VALUES ('lead-chat-lead', ${orgId}, 'lead-chat', 'agent', ${lead}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('team-chat', ${orgId}, 'team_group', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      role, joined_at)
    VALUES ('team-chat-mate', ${orgId}, 'team-chat', 'person', ${mateId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
      worker_projects_json, owner_chat_id)
    VALUES (${lead}, ${orgId}, 'Chief of staff', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
});

/** A turn woken by the owner in their chat with the lead, or by Meera in a group; the turn before it ends. */
const turn = (n: number, audience: "owner_only" | "shared" = "owner_only") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [personId, chatId, memberId] =
      audience === "owner_only"
        ? [ownerId, "lead-chat", "lead-chat-owner"]
        : [mateId, "team-chat", "team-chat-mate"];
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
        created_at)
      VALUES (${`msg-${n}`}, ${orgId}, ${chatId}, ${n}, 'human', ${personId}, ${memberId},
        'member', 'text', 'Invented: we don''t do deals, turn that off',
        '[]', 'posted', ${at})`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, ${audience})`;
    const event = {
      _tag: "chat.message",
      orgId,
      agentId: lead,
      eventId: `event-${n}`,
      receivedAt: at,
      dedupeKey: null,
      provenance: { _tag: "human", personId, memberId },
      chatId,
      messageId: `msg-${n}`,
    };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, 'chat.message', 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
  });

const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ widgetId: string; detail: string; closed: number }>`SELECT w.widget_id AS
      "widgetId", json_extract(w.state_json, '$.detail') AS detail, w.closed_at IS NOT NULL AS closed
    FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id
    ORDER BY c.rowid`;
});
const answer = (widgetId: string, personId: string, confirmed = true) =>
  answerShellChange({ orgId, widgetId, personId, confirmed, via: "tap", now: NOW });
const DEFAULT_SECTIONS = [
  { id: "clients", on: true },
  { id: "deals", on: true },
  { id: "money", on: true },
  { id: "invoices", on: true },
  { id: "docs", on: true },
];

it.effect("an agent only proposes: one card the owner level confirms, applied exactly, once", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* turn(1);
    const proposed = yield* propose(scope, {
      sections: [
        { id: "deals", on: false },
        { id: "clients", name: "Patients", noun: "patient" },
      ],
    });
    assert.deepStrictEqual(proposed.proposed, [
      'Call Clients "Patients"',
      'Call one client "patient"',
      "Turn off Deals",
    ]);
    assert.deepStrictEqual(yield* KinShell.get(orgId), { rev: 0, sections: DEFAULT_SECTIONS });
    const [card] = yield* cards;
    assert.strictEqual(card!.detail, proposed.proposed.join("\n"));
    // The company profile's answers are not this card's, nor this card's answer a profile card's.
    assert.isUndefined(
      yield* answerChange({
        orgId,
        widgetId: card!.widgetId,
        personId: ownerId,
        confirmed: true,
        via: "tap",
        now: NOW,
      }),
    );
    assert.isUndefined(yield* answer("choice:other", ownerId));

    // A member's Confirm, and a reaction, are refused; the shell stays as it was.
    assert.include(yield* Effect.flip(answer(card!.widgetId, mateId)), {
      reason: "not_allowed",
    });
    assert.include(
      yield* Effect.flip(
        answerShellChange({
          orgId,
          widgetId: card!.widgetId,
          personId: ownerId,
          confirmed: true,
          via: "reaction",
          now: NOW,
        }),
      ),
      { reason: "not_allowed" },
    );
    assert.strictEqual((yield* KinShell.get(orgId)).rev, 0);

    // The owner's Confirm applies exactly the listed changes and nothing else, once.
    assert.deepInclude(yield* answer(card!.widgetId, ownerId), { title: "Changed" });
    assert.deepStrictEqual(yield* KinShell.get(orgId), {
      rev: 1,
      sections: [
        { id: "clients", on: true, name: "Patients", noun: "patient" },
        { id: "deals", on: false },
        { id: "money", on: true },
        { id: "invoices", on: true },
        { id: "docs", on: true },
      ],
    });
    assert.include(yield* Effect.flip(answer(card!.widgetId, ownerId)), {
      reason: "widget_changed",
    });
    // Memory keeps Kin's own line for the answer, never the card's text.
    assert.strictEqual(
      yield* shellDecision(orgId, card!.widgetId, true),
      'Called Clients "Patients". Called one client "patient". Turned off Deals.',
    );
    assert.strictEqual(
      yield* shellDecision(orgId, card!.widgetId, false),
      'Said no to calling Clients "Patients". Said no to calling one client "patient". Said no to turning off Deals.',
    );
    assert.isUndefined(yield* shellDecision(orgId, "choice:other", true));

    // The way back is the same card the other way round.
    yield* turn(2);
    const back = yield* propose(scope, {
      sections: [
        { id: "deals", on: true },
        { id: "clients", name: null, noun: null },
      ],
    });
    assert.deepStrictEqual(back.proposed, [
      'Call Clients "Clients" (now "Patients")',
      'Call one client "client" (now "patient")',
      "Turn on Deals",
    ]);
    yield* answer((yield* cards).at(-1)!.widgetId, ownerId);
    assert.deepStrictEqual(yield* KinShell.get(orgId), { rev: 2, sections: DEFAULT_SECTIONS });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a newer card replaces the unanswered older one, and a card older than the shell is refused",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      yield* propose(scope, { sections: [{ id: "deals", on: false }] });
      yield* turn(2);
      yield* propose(scope, { sections: [{ id: "clients", name: "Donors" }] });
      const [older, newer] = yield* cards;
      assert.deepStrictEqual(
        [older!.closed, newer!.closed],
        [1, 0],
        "the older card closes as replaced",
      );
      assert.include((yield* Effect.flip(answer(older!.widgetId, ownerId))).message, "replaced");

      // The owner changed the shell in Settings since the card was made: nothing is applied.
      yield* KinShell.set(orgId, ownerId, 0, [{ id: "deals", on: false }]);
      const stale = yield* Effect.flip(answer(newer!.widgetId, ownerId));
      assert.include(stale, { reason: "conflict" });
      assert.include(stale.message, "Ask for the change again");
      const after = yield* KinShell.get(orgId);
      assert.strictEqual(after.rev, 1);
      assert.isUndefined(after.sections[0]!.name);
      // Cancel changes nothing.
      yield* turn(3);
      yield* propose(scope, { sections: [{ id: "deals", on: true }] });
      assert.deepInclude(yield* answer((yield* cards).at(-1)!.widgetId, ownerId, false), {
        title: "Not changed",
      });
      assert.strictEqual((yield* KinShell.get(orgId)).rev, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a shared turn can't propose, and a turn that follows an outside read only proposes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* turn(1, "shared");
      const shared = yield* Effect.flip(propose(scope, { sections: [{ id: "deals", on: false }] }));
      assert.deepInclude(shared, { reason: "not_allowed", message: SHARED_REFUSAL });
      assert.lengthOf(yield* sql`SELECT 1 FROM kin_profile_changes`, 0);

      // The owner's turn that a passed-on mail woke: it may still ask, and nothing applies.
      yield* turn(2);
      yield* stampEvent(orgId, "event-2", "connection:conn-mail");
      yield* inheritOutside({ orgId, wakeupId: "wake-2", eventIds: ["event-2"] });
      assert.isTrue(yield* followsOutsideRead(orgId, "wake-2"));
      const outsideTurn = { orgId, agentId: lead, wakeupId: "wake-2" };
      assert.isTrue(yield* outsideToolAllowed(outsideTurn, "company_sections", {}));
      yield* propose(scope, { sections: [{ id: "deals", on: false }] });
      assert.lengthOf(yield* cards, 1);
      assert.deepStrictEqual(yield* KinShell.get(orgId), { rev: 0, sections: DEFAULT_SECTIONS });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a card names each section by Kin's title, offers only what Confirm can save, and takes plain names only",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* KinShell.set(orgId, ownerId, 0, [
        { id: "clients", on: true, name: "Patients" },
        { id: "invoices", on: false },
      ]);
      yield* turn(1);
      // A switch says which section it writes, with the company's word after Kin's title.
      const off = yield* propose(scope, { sections: [{ id: "clients", on: false }] });
      assert.deepStrictEqual(off.proposed, ['Turn off Clients (called "Patients" here)']);
      yield* KinShell.set(orgId, ownerId, 1, [
        { id: "clients", on: true, name: "Patients" },
        { id: "invoices", on: true },
      ]);
      yield* turn(2);
      const allowed = yield* propose(scope, { sections: [{ id: "clients", on: false }] });
      assert.deepStrictEqual(allowed.proposed, ['Turn off Clients (called "Patients" here)']);
      const before = (yield* cards).length;
      // A name is one line of plain text, at the tool and at the setter: one check for both.
      for (const name of ["Patients\nTurn off Money", "Patients\u202e", "Pat\u2028ients"]) {
        const refused = yield* Effect.flip(propose(scope, { sections: [{ id: "clients", name }] }));
        assert.strictEqual(refused.message, "A name is one line of plain text.", name);
        const set = yield* Effect.flip(
          KinShell.set(orgId, ownerId, 2, [{ id: "clients", on: true, name }]),
        );
        assert.strictEqual(set.message, "A name is one line of plain text.", name);
      }
      assert.strictEqual((yield* cards).length, before);
      // Ordinary names in any script stay allowed.
      const named = yield* propose(scope, { sections: [{ id: "clients", name: "Пациенты" }] });
      assert.deepStrictEqual(named.proposed, ['Call Clients "Пациенты" (now "Patients")']);
      // Only Clients takes the company's word.
      assert.strictEqual(
        (yield* Effect.flip(propose(scope, { sections: [{ id: "deals", name: "Leads" }] })))
          .message,
        "Only Clients can be called by the company's own word.",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("an older stored label is shown with what a label may not hold removed", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_company_shell (org_id, shell_json, rev, set_by, set_at)
      VALUES (${orgId}, ${JSON.stringify([{ id: "clients", on: true, name: "Pat\u202eients\nX" }])},
        1, ${ownerId}, 0)`;
    const shell = yield* KinShell.get(orgId);
    assert.strictEqual(shell.sections[0]!.name, "PatientsX");
    yield* turn(1);
    const card = yield* propose(scope, { sections: [{ id: "clients", name: "Members" }] });
    assert.deepStrictEqual(card.proposed, ['Call Clients "Members" (now "PatientsX")']);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "an identical retry returns its first card and closes nothing; profile and sections cards ignore each other",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* turn(1);
      const first = yield* propose(scope, { sections: [{ id: "deals", on: false }] });
      yield* propose(scope, { sections: [{ id: "clients", name: "Members" }] });
      // The retry of the first: the same card, and the newer one stays open.
      assert.deepStrictEqual(
        yield* propose(scope, { sections: [{ id: "deals", on: false }] }),
        first,
      );
      const [older, newer] = yield* cards;
      assert.deepStrictEqual([older!.closed, newer!.closed], [1, 0]);
      assert.lengthOf(yield* cards, 2);

      // A real company-profile card beside it: neither answer nor replacement touches the other.
      const profile = yield* LeadMoney.profile(scope, {
        sourceEventId: "event-1",
        set: { tradeName: "Ambermill" },
      });
      assert.deepStrictEqual(profile.proposed, ["Trade name: none → Ambermill"]);
      const sql = yield* SqlClient.SqlClient;
      const [profileCard] = yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
        FROM kin_profile_changes WHERE substr(change_id, 1, 3) = 'pc_'`;
      assert.isUndefined(yield* answer(profileCard!.widgetId, ownerId));
      assert.isUndefined(
        yield* answerChange({
          orgId,
          widgetId: newer!.widgetId,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        }),
      );
      yield* propose(scope, { sections: [{ id: "money", on: false }] });
      yield* LeadMoney.profile(scope, { sourceEventId: "event-1", set: { tradeName: "Amber" } });
      const open = yield* sql<{ id: string }>`SELECT substr(change_id, 1, 3) AS id
        FROM kin_profile_changes WHERE applied_at IS NULL AND declined_at IS NULL ORDER BY rowid`;
      assert.deepStrictEqual(
        open.map((row) => row.id),
        ["sc_", "pc_"],
      );
      assert.deepInclude(
        yield* answerChange({
          orgId,
          widgetId: (yield* sql<{ widgetId: string }>`SELECT widget_id AS "widgetId"
            FROM kin_profile_changes WHERE substr(change_id, 1, 3) = 'pc_' ORDER BY rowid DESC`)[0]!
            .widgetId,
          personId: ownerId,
          confirmed: true,
          via: "tap",
          now: NOW,
        }),
        { title: "Company details changed" },
      );
      assert.strictEqual((yield* KinShell.get(orgId)).rev, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect("shows a company list as a section, docks it and turns it off, each on a card", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'stock', 'Stock', 'STK', 0, 1, '{"sensitive":false}')`;
    yield* turn(1);
    for (const [sections, message] of [
      [[{ id: "deals", dock: true }], "Only a list section is put in the phone's dock here."],
      [[{ id: "list:shelves" }], "There is no list shelves to show as a section."],
    ] as const)
      assert.include(yield* Effect.flip(propose(scope, { sections })), { message });
    const dock = { id: "list:stock", dock: true };
    assert.include(yield* Effect.flip(propose(scope, { sections: [dock] })), {
      message: "The dock holds five places. Turn one off first.",
    });
    assert.lengthOf(yield* cards, 0);
    const shown = yield* propose(scope, { sections: [{ id: "clients", on: false }, dock] });
    assert.deepStrictEqual(shown.proposed, [
      "Turn off Clients",
      `Show the list "Stock" as a section, also in the phone's dock`,
    ]);
    assert.strictEqual((yield* KinShell.get(orgId)).rev, 0);
    const [first] = yield* cards;
    yield* answer(first!.widgetId, ownerId);
    assert.deepStrictEqual((yield* KinShell.get(orgId)).sections.slice(5), [
      { id: "list:stock", on: true, dock: true },
    ]);
    assert.strictEqual(
      yield* shellDecision(orgId, first!.widgetId, true),
      'Turned off Clients. Showed the list "Stock" as a section.',
    );
    yield* turn(2);
    const off = yield* propose(scope, { sections: [{ id: "list:stock", on: false, dock: false }] });
    assert.deepStrictEqual(off.proposed, [
      'Turn off the "Stock" section',
      `Take "Stock" out of the phone's dock`,
    ]);
    const [, second] = yield* cards;
    yield* answer(second!.widgetId, ownerId);
    assert.deepStrictEqual((yield* KinShell.get(orgId)).sections.slice(5), [
      { id: "list:stock", on: false, dock: false },
    ]);
    yield* turn(3);
    const back = yield* propose(scope, { sections: [{ id: "list:stock", on: true }] });
    assert.deepStrictEqual(back.proposed, ['Turn on the "Stock" section']);
  }).pipe(Effect.provide(layer)),
);
