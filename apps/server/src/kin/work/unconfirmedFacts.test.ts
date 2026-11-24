// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import { markOutside } from "../lead/OutsideContent.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { billedParty } from "./billTo.ts";
import * as KinRecords from "./KinRecords.ts";
import * as LeadWork from "./leadWork.ts";
import { fieldText, parseFields } from "./lists.ts";
import { answerUnconfirmed } from "./unconfirmedFacts.ts";

// Invented company, people, clients and numbers only.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const mateId = KinPersonId.make("mate");
const lead = KinAgentId.make("lead");
const at = "2026-11-11T00:00:00.000Z";
const NOW = Date.parse("2026-11-24T06:00:00.000Z");
const OLD = "29AAAAA0000A1Z5";
const NEW = "29ABCDE1234F1Z5";
const isChatError = Schema.is(KinChatError);

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
// Kin's card for one person, stored and bound in one transaction, as the chat service does; held
// with nothing posted while the company has quiet hours set.
const gate = Layer.unwrap(
  Effect.map(SqlClient.SqlClient, (sql) =>
    Layer.mock(KinLevelGate)({
      askTo: (_agent, personId, input, bind) =>
        Effect.gen(function* () {
          const [quiet] = yield* sql<{ on: number }>`SELECT quiet_hours_json != '{}' AS "on"
            FROM kin_trigger_settings WHERE org_id = ${orgId}`;
          if (quiet?.on === 1) {
            yield* bind(null);
            return { _tag: "held" } as never;
          }
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
              'choice', 1, ${JSON.stringify(state)}, ${JSON.stringify([personId])}, ${at})
            ON CONFLICT DO NOTHING`;
          yield* bind({ widgetId } as never);
          return { widgetId } as never;
        }).pipe(sql.withTransaction, Effect.orDie),
      closeReplaced: (_agent, widgetIds) =>
        Effect.forEach(
          widgetIds,
          (widgetId) => sql`UPDATE kin_widgets SET closed_at = ${at} WHERE widget_id = ${widgetId}`,
        ).pipe(Effect.asVoid, Effect.orDie),
    }),
  ),
);
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-unconfirmed-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Rhea owns the company, Meera is a member; one lead, its chat with Rhea, and a team room. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
      sees_clients)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner', 0),
      (${mateId}, ${orgId}, 'meera', 'Meera', ${at}, 'member', 1)`;
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
  const records = yield* KinRecords.KinRecords;
  const rhea = { actor: { _tag: "person" as const, personId: ownerId }, via: "owner" as const };
  for (const [title, holder, fields] of [
    ["Invented Harbourline", ownerId, {}],
    ["Invented Quayside", ownerId, {}],
    ["Invented Tidewater", ownerId, {}],
    ["Invented Saltmarsh", mateId, {}],
    ["रीमा ट्रेडर्स", ownerId, { terms: "Net 30, 1.5% late fee", address: "Flat 1, 23 Quay Road" }],
  ] as const)
    yield* records.create(orgId, rhea, {
      list: "clients",
      originKey: `seed:${title}`,
      title,
      owner: { _tag: "person", personId: holder },
      fields: { address: "Invented 1 Quay Road", gstin: OLD, ...fields },
    });
});

let turns = 0;
/** How the waking message reached the lead, other than a person typing it. */
type Road = {
  readonly author?: "agent";
  readonly eventOrigin?: true;
  readonly originJson?: string;
  readonly clientMessageId?: string;
  readonly tap?: true;
  readonly outside?: true;
};
/** A turn woken by one person's message, or (`body` null) by Kin's own pulse; returns its event. */
const turn = (body: string | null, who: "owner" | "mate" = "owner", how: Road = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const n = ++turns;
    const [personId, chatId, memberId, audience] =
      who === "owner"
        ? [ownerId, "lead-chat", "lead-chat-owner", "owner_only"]
        : [mateId, "team-chat", "team-chat-mate", "shared"];
    yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at,
        status, event_ids, audience)
      VALUES (${`wake-${n}`}, ${orgId}, ${lead}, 'lead-thread', 'test', 0, 'running',
        ${JSON.stringify([`event-${n}`])}, ${body === null ? "owner_only" : audience})`;
    if (body !== null && how.author === "agent")
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_agent_id, author_owner_person_id, author_thread_id, author_member_id,
          author_role, kind, body, mentions_json, status, created_at)
        VALUES (${`msg-${n}`}, ${orgId}, ${chatId}, ${n}, 'agent', ${lead}, ${ownerId},
          'lead-thread', 'lead-chat-lead', 'member', 'text', ${body}, '[]', 'posted', ${at})`;
    else if (body !== null)
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
          created_at, client_message_id, origin_json)
        VALUES (${`msg-${n}`}, ${orgId}, ${chatId}, ${n}, 'human', ${personId}, ${memberId},
          'member', ${how.tap === true ? "widget_action" : "text"}, ${body}, '[]', 'posted',
          ${at}, ${how.clientMessageId ?? null}, ${how.originJson ?? null})`;
    const event =
      body === null
        ? { _tag: "pulse", orgId, agentId: lead, eventId: `event-${n}`, receivedAt: at }
        : {
            _tag: how.tap === true ? "widget.action" : "chat.message",
            orgId,
            agentId: lead,
            eventId: `event-${n}`,
            receivedAt: at,
            dedupeKey: null,
            provenance: { _tag: "human", personId, memberId },
            chatId,
            messageId: `msg-${n}`,
            ...(how.tap === true ? { actionId: "choose" } : {}),
            ...(how.eventOrigin === true ? { origin: { agentId: lead, chatId, personId } } : {}),
          };
    yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
        received_at, queued_at, state, wakeup_id)
      VALUES (${`event-${n}`}, ${orgId}, ${lead}, ${event._tag}, 'P0', ${JSON.stringify(event)},
        0, 0, 'claimed', ${`wake-${n}`})`;
    if (how.outside === true)
      yield* markOutside({ orgId, wakeupId: `wake-${n}` }, "web:example.org");
    return `event-${n}`;
  });

/** The cards still waiting for a tap. */
const cards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    widgetId: string;
    chatId: string;
    awaiting: string;
    detail: string;
    recordId: string;
  }>`
    SELECT w.widget_id AS "widgetId", w.chat_id AS "chatId", w.awaiting_json AS awaiting,
      json_extract(w.state_json, '$.detail') AS detail,
      json_extract(c.patch_json, '$.recordId') AS "recordId"
    FROM kin_profile_changes c JOIN kin_widgets w ON w.widget_id = c.widget_id
    WHERE substr(c.change_id, 1, 3) = 'uf_' AND w.closed_at IS NULL AND c.applied_at IS NULL
      AND c.declined_at IS NULL
    ORDER BY c.rowid`;
});
const stored = (key: string) =>
  Effect.gen(function* () {
    const row = (yield* (yield* KinRecords.KinRecords).get(orgId, key))!;
    const field = (name: string) =>
      name === "title" ? row.title : fieldText(parseFields(row.fieldsJson), name);
    return { row, gstin: field("gstin"), field };
  });
const answer = (widgetId: string, personId: KinPersonId, confirmed: boolean) =>
  answerUnconfirmed({ orgId, widgetId, personId, confirmed, via: "tap", now: NOW });

it.effect("an agent's printed client detail goes straight in only as a person typed it", () =>
  Effect.gen(function* () {
    yield* seed;
    const cases: ReadonlyArray<{
      readonly key: string;
      readonly said: string | null;
      readonly how?: Road;
      readonly set: Partial<
        Record<"gstin" | "terms" | "address" | "placeOfSupply", string | null>
      > & { readonly title?: string };
      readonly straight: boolean;
    }> = [
      {
        key: "C-1",
        said: `Harbourline's GSTIN is 29abcde 1234 f1z5`,
        set: { gstin: NEW },
        straight: true,
      },
      { key: "C-2", said: "Use the number from their mail", set: { gstin: NEW }, straight: false },
      { key: "C-3", said: null, set: { gstin: NEW }, straight: false },
      // A different value waits however close its letters and digits are: points, signs, marks.
      {
        key: "C-5",
        said: null,
        set: {
          title: "रामा ट्रेडर्स",
          terms: "Net 30, 15% late fee",
          address: "Flat 12, 3 Quay Road",
        },
        straight: false,
      },
      {
        key: "C-5",
        said: "Their terms are Net 30, 1.5% late fee",
        set: { terms: "Net 30, 15% late fee" },
        straight: false,
      },
      // Typed means whole words of the message: "look at" is not "KA", "the 29th" is not "29".
      {
        key: "C-1",
        said: "Please take a look at their mail and fix the place of supply",
        set: { placeOfSupply: "KA" },
        straight: false,
      },
      {
        key: "C-2",
        said: "Invoice them on the 29th, thanks",
        set: { placeOfSupply: "29" },
        straight: false,
      },
      {
        key: "C-1",
        said: "Their place of supply is KA.",
        set: { placeOfSupply: "KA" },
        straight: true,
      },
      {
        key: "C-3",
        said: "Tidewater's number is (29 abcde-1234f1z5)",
        set: { gstin: NEW },
        straight: true,
      },
      // None of these is Rhea's own words: an agent's message, one passed on, Kin's private
      // copy, a key's send, a card tap.
      ...(
        [
          { author: "agent" },
          { eventOrigin: true },
          { originJson: JSON.stringify({ agentId: lead }) },
          { clientMessageId: "send:private:msg-1" },
          { clientMessageId: "send:key:session:req-1" },
          { tap: true },
        ] as const
      ).map((how) => ({
        key: "C-2",
        said: `Quayside's GSTIN is ${NEW}`,
        how,
        set: { gstin: NEW },
        straight: false,
      })),
      // A removal waits after outside content and in a wake nobody started; else it goes in.
      {
        key: "C-3",
        said: "Clear their address",
        how: { outside: true },
        set: { address: null },
        straight: false,
      },
      { key: "C-3", said: null, set: { address: null }, straight: false },
      { key: "C-3", said: "Clear their address", set: { address: null }, straight: true },
    ];
    for (const one of cases) {
      const before = yield* stored(one.key);
      const sourceEventId = yield* turn(one.said, "owner", one.how);
      const result = yield* LeadWork.update(scope, { key: one.key, sourceEventId, ...one.set });
      const after = yield* stored(one.key);
      for (const [name, value] of Object.entries(one.set))
        assert.strictEqual(after.field(name), one.straight ? value : before.field(name), one.key);
      assert.strictEqual(result.unconfirmed === undefined, one.straight, one.key);
      // Each that waits has its card in Rhea's chat with the lead.
      if (!one.straight)
        assert.deepStrictEqual(
          (yield* cards)
            .filter((card) => card.recordId === after.row.recordId)
            .map((card) => [card.chatId, JSON.parse(card.awaiting)]),
          [["lead-chat", [ownerId]]],
          one.key,
        );
    }
    // A value typed in an earlier wake-up does not count in a later one nobody started.
    const newer = "29EEEEE4444E1Z5";
    yield* turn(`Quayside's GSTIN is ${newer}`);
    const later = yield* LeadWork.update(scope, {
      key: "C-2",
      sourceEventId: yield* turn(null),
      gstin: newer,
    });
    assert.isDefined(later.unconfirmed);
    assert.strictEqual((yield* stored("C-2")).gstin, OLD);
    // The same change to two clients in one wake-up waits on each, on its own card.
    const both = yield* LeadWork.updateMany(scope, {
      keys: ["C-1", "C-4"],
      sourceEventId: yield* turn(null),
      terms: "Net 30",
      heardFrom: "their group mail of 3 Nov",
    });
    assert.lengthOf(both.entries ?? [], 2);
    for (const key of ["C-1", "C-4"]) {
      const { row } = yield* stored(key);
      const mine = (yield* cards).filter((card) => card.recordId === row.recordId);
      assert.lengthOf(mine, 1, key);
      assert.include(mine[0]?.detail, "Terms: Net 30", key);
      assert.isDefined((yield* LeadWork.get(scope, { key })).unconfirmed, key);
    }
    // record_create on an existing client proposes its untyped tax number and leaves the field.
    const existing = yield* LeadWork.create(scope, {
      sourceEventId: yield* turn("Add the client from that mail"),
      records: [{ list: "clients", title: "Invented Tidewater", gstin: "29DDDDD3333D1Z5" }],
    });
    assert.include(existing.records[0], { key: "C-3", created: false });
    assert.isDefined(existing.records[0]?.unconfirmed);
    assert.strictEqual((yield* stored("C-3")).gstin, NEW);
    // A new client keeps the name it was made with; its tax number from a mail waits.
    const made = yield* LeadWork.create(scope, {
      sourceEventId: yield* turn("Add the client from that mail"),
      records: [{ list: "clients", title: "Invented Keelson", gstin: NEW }],
    });
    assert.include(made.records[0], { title: "Invented Keelson", created: true });
    assert.include(made.records[0]?.unconfirmed, "or give it as Invented Keelson's.");
    assert.isNull((yield* stored(made.records[0]!.key)).gstin);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a waiting value asks once, prints nowhere, and is written or dropped only by a person's tap",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* (yield* SqlClient.SqlClient)`UPDATE kin_people SET access = 'co_owner'
        WHERE person_id = ${mateId}`;
      const asked = yield* turn("Use the number from their mail");
      const first = yield* LeadWork.update(scope, {
        key: "C-1",
        sourceEventId: asked,
        gstin: NEW,
        heardFrom: "their mail of 3 Nov",
      });
      assert.strictEqual(
        first.unconfirmed,
        `Not saved, and nothing on Invented Harbourline changed: no one here typed GSTIN "${NEW}", so Rhea confirms it on a card Kin showed them. Until they tap Use it, invoices and quotes print what they had. Say in one line that it needs Rhea's confirmation; never say it is added or on the record, or give it as Invented Harbourline's.`,
      );
      // The same value again, in a later turn, asks nothing more.
      yield* LeadWork.update(scope, {
        key: "C-1",
        sourceEventId: yield* turn(null),
        gstin: ` ${NEW} `,
      });
      const [card, ...more] = yield* cards;
      assert.lengthOf(more, 0);
      assert.strictEqual(
        card?.detail,
        `GSTIN: ${NEW}\nNow: ${OLD}\nThe agent says it came from: their mail of 3 Nov\n\nInvoices and quotes print it only after you tap Use it.`,
      );
      // The record says it waits; an invoice made now prints the confirmed number.
      const read = yield* LeadWork.get(scope, { key: "C-1" });
      assert.strictEqual(read.gstin, OLD);
      assert.deepStrictEqual(read.unconfirmed, [
        `Unconfirmed GSTIN: "${NEW}", from their mail of 3 Nov. It waits for Rhea's tap and is not on invoices or quotes; never state it as fact.`,
      ]);
      const before = (yield* stored("C-1")).row;
      assert.strictEqual(billedParty(undefined, before)?.taxNumber, OLD);
      // Only an owner-level person answers it, by a tap: Meera, a co-owner made a member since,
      // and a reaction are refused. Rhea's Use it writes it, in her name.
      const people = yield* SqlClient.SqlClient;
      yield* people`UPDATE kin_people SET access = 'member' WHERE person_id = ${mateId}`;
      const refused = yield* Effect.flip(answer(card!.widgetId, mateId, true));
      assert.isTrue(isChatError(refused) && refused.reason === "not_allowed");
      const reacted = yield* Effect.flip(
        answerUnconfirmed({
          orgId,
          widgetId: card!.widgetId,
          personId: ownerId,
          confirmed: true,
          via: "reaction",
          now: NOW,
        }),
      );
      assert.isTrue(isChatError(reacted) && reacted.reason === "not_allowed");
      assert.deepStrictEqual(yield* answer(card!.widgetId, ownerId, true), {
        title: "Saved",
        text: "Saved. Invoices and quotes made from now on print it.",
      });
      const after = (yield* stored("C-1")).row;
      assert.strictEqual(billedParty(undefined, after)?.taxNumber, NEW);
      const [latest] = (yield* (yield* KinRecords.KinRecords).detail(after, 1)).changes;
      assert.deepStrictEqual(latest?.by, { _tag: "person", personId: ownerId });
      assert.deepStrictEqual(
        latest?.fields.map((field) => [field.field, field.from, field.to]),
        [["gstin", OLD, NEW]],
      );
      assert.isUndefined((yield* LeadWork.get(scope, { key: "C-1" })).unconfirmed);
      const again = yield* Effect.flip(answer(card!.widgetId, ownerId, true));
      assert.isTrue(isChatError(again) && again.reason === "widget_changed");

      // Not this drops it: the address stays, and the record says nothing waits.
      yield* LeadWork.update(scope, {
        key: "C-2",
        sourceEventId: yield* turn(null),
        address: "Invented 9 Dock Lane",
      });
      const [dropped] = yield* cards;
      assert.deepStrictEqual(yield* answer(dropped!.widgetId, ownerId, false), {
        title: "Not used",
        text: "You said no, so the client's details stay as they were.",
      });
      const kept = yield* LeadWork.get(scope, { key: "C-2" });
      assert.strictEqual(kept.address, "Invented 1 Quay Road");
      assert.isUndefined(kept.unconfirmed);

      // A field changed since it was proposed no longer waits: Rhea typed the same number, so
      // its card's Use it leaves it as it is; another number since refuses the card.
      for (const key of ["C-3", "C-4"])
        yield* LeadWork.update(scope, { key, sourceEventId: yield* turn(null), gstin: NEW });
      yield* LeadWork.update(scope, {
        key: "C-3",
        sourceEventId: yield* turn(`Tidewater's GSTIN is ${NEW}`),
        gstin: NEW,
      });
      const other = "29ZZZZZ9999Z1Z5";
      yield* (yield* KinRecords.KinRecords).update(
        orgId,
        { actor: { _tag: "person", personId: ownerId }, via: "owner" },
        "C-4",
        { fields: { gstin: other } },
      );
      for (const key of ["C-3", "C-4"])
        assert.isUndefined((yield* LeadWork.get(scope, { key })).unconfirmed, key);
      const [typed, changed] = yield* cards;
      assert.strictEqual((yield* answer(typed!.widgetId, ownerId, true))?.title, "Saved");
      assert.strictEqual((yield* stored("C-3")).gstin, NEW);
      const stale = yield* Effect.flip(answer(changed!.widgetId, ownerId, true));
      assert.isTrue(isChatError(stale) && stale.reason === "conflict");
      assert.strictEqual((yield* stored("C-4")).gstin, other);
      // Proposed again, it is asked again on a new card, which writes it.
      yield* LeadWork.update(scope, { key: "C-4", sourceEventId: yield* turn(null), gstin: NEW });
      const [anew, ...rest] = yield* cards;
      assert.lengthOf(rest, 0);
      assert.include(anew?.detail, `Now: ${other}`);
      assert.strictEqual((yield* answer(anew!.widgetId, ownerId, true))?.title, "Saved");
      assert.strictEqual((yield* stored("C-4")).gstin, NEW);
      // A card that no longer takes the tap of who confirms now is asked again on a new one.
      const sql = yield* SqlClient.SqlClient;
      const tidewater = (yield* stored("C-3")).row.recordId;
      const open = Effect.map(cards, (all) => all.filter((one) => one.recordId === tidewater));
      yield* LeadWork.update(scope, {
        key: "C-3",
        sourceEventId: yield* turn(null),
        terms: "Net 45",
      });
      for (const dead of [
        (widgetId: string) =>
          sql`UPDATE kin_widgets SET closed_at = ${at} WHERE widget_id = ${widgetId}`,
        (widgetId: string) =>
          sql`UPDATE kin_widgets SET awaiting_json = ${JSON.stringify([mateId])} WHERE widget_id = ${widgetId}`,
      ]) {
        const [gone] = yield* open;
        yield* dead(gone!.widgetId);
        yield* LeadWork.update(scope, {
          key: "C-3",
          sourceEventId: yield* turn(null),
          terms: "Net 45",
        });
        const [anew, ...extra] = yield* open;
        assert.lengthOf(extra, 0);
        assert.notStrictEqual(anew?.widgetId, gone?.widgetId);
        assert.deepStrictEqual(JSON.parse(anew!.awaiting), [ownerId]);
      }
      // A newer value that can't be shown now waits with no card; the person keeps the card they had.
      const [shown] = yield* open;
      yield* sql`UPDATE kin_trigger_settings SET quiet_hours_json = '{"weekdays":"22:00-07:00"}'`;
      yield* LeadWork.update(scope, {
        key: "C-3",
        sourceEventId: yield* turn(null),
        terms: "Net 60",
      });
      yield* sql`UPDATE kin_trigger_settings SET quiet_hours_json = '{}'`;
      assert.deepStrictEqual(
        (yield* open).map((one) => one.widgetId),
        [shown!.widgetId],
      );
      assert.include((yield* LeadWork.get(scope, { key: "C-3" })).unconfirmed?.[0], '"Net 60"');
      // Only the exact value is the card's: 15% since 1.5% was asked is a change, so it refuses.
      yield* LeadWork.update(scope, {
        key: "C-2",
        sourceEventId: yield* turn(null),
        terms: "Net 30, 1.5% late fee",
      });
      yield* (yield* KinRecords.KinRecords).update(
        orgId,
        { actor: { _tag: "person", personId: ownerId }, via: "owner" },
        "C-2",
        { fields: { terms: "Net 30, 15% late fee" } },
      );
      const [terms] = (yield* cards).filter((one) => one.recordId !== tidewater);
      const moved = yield* Effect.flip(answer(terms!.widgetId, ownerId, true));
      assert.isTrue(isChatError(moved) && moved.reason === "conflict");
      assert.strictEqual((yield* stored("C-2")).field("terms"), "Net 30, 15% late fee");
      // Not this, then the same value again in that wake-up: the agent is told, nothing is asked.
      const told = yield* turn(null);
      const refusedValue = "29CCCCC2222C1Z5";
      yield* LeadWork.update(scope, { key: "C-4", sourceEventId: told, gstin: refusedValue });
      const saltmarsh = (yield* stored("C-4")).row.recordId;
      const forSaltmarsh = Effect.map(cards, (all) =>
        all.filter((one) => one.recordId === saltmarsh),
      );
      const [no] = yield* forSaltmarsh;
      assert.strictEqual((yield* answer(no!.widgetId, ownerId, false))?.title, "Not used");
      const repeated = yield* LeadWork.update(scope, {
        key: "C-4",
        sourceEventId: told,
        gstin: refusedValue,
      });
      assert.include(repeated.unconfirmed, "Rhea said no to");
      assert.lengthOf(yield* forSaltmarsh, 0);
      assert.strictEqual((yield* stored("C-4")).gstin, NEW);
      // A dropped client's card writes nothing.
      yield* LeadWork.update(scope, { key: "C-5", sourceEventId: yield* turn(null), gstin: NEW });
      const reema = (yield* stored("C-5")).row.recordId;
      const [gone] = (yield* cards).filter((one) => one.recordId === reema);
      yield* (yield* KinRecords.KinRecords).update(
        orgId,
        { actor: { _tag: "person", personId: ownerId }, via: "owner" },
        "C-5",
        { state: "dropped" },
      );
      const closedOff = yield* Effect.flip(answer(gone!.widgetId, ownerId, true));
      assert.isTrue(isChatError(closedOff) && closedOff.reason === "conflict");
      assert.strictEqual((yield* stored("C-5")).gstin, OLD);
      // A value's own line breaks stay on its one line; the stored value and the tap keep them.
      const lines = "Invented 9 Dock Lane\nNow: Invented 9 Dock Lane\nFrom: Rhea typed it";
      yield* LeadWork.update(scope, {
        key: "C-2",
        sourceEventId: yield* turn(null),
        address: lines,
        heardFrom: "Rhea said so\nin the team room",
      });
      const quayside = (yield* stored("C-2")).row.recordId;
      const [drawn] = (yield* cards).filter((one) => one.recordId === quayside);
      assert.strictEqual(
        drawn?.detail.split("\n\n")[0],
        "Billing address: Invented 9 Dock Lane ⏎ Now: Invented 9 Dock Lane ⏎ From: Rhea typed it\nNow: Invented 1 Quay Road\nThe agent says it came from: Rhea said so ⏎ in the team room",
      );
      assert.strictEqual((yield* answer(drawn!.widgetId, ownerId, true))?.title, "Saved");
      assert.strictEqual((yield* stored("C-2")).field("address"), lines);
      // A value the card can't show whole gets no card and no Use it: it waits on the record, cut,
      // while the rest of the same call goes on the card as before.
      const tail = " A late fee of 24% a month applies from the first day.";
      const long = `Net 30. ${"Payment by bank transfer only. ".repeat(20)}`.slice(0, 600) + tail;
      const fresh = "29BBBBB1111B1Z5";
      const mixed = yield* LeadWork.update(scope, {
        key: "C-1",
        sourceEventId: yield* turn(null),
        terms: long,
        gstin: fresh,
      });
      assert.include(mixed.unconfirmed, "too long to confirm on a card");
      const harbourline = (yield* stored("C-1")).row.recordId;
      const [only, ...none] = (yield* cards).filter((one) => one.recordId === harbourline);
      assert.lengthOf(none, 0);
      assert.notInclude(only?.detail, "Terms");
      assert.strictEqual((yield* answer(only!.widgetId, ownerId, true))?.title, "Saved");
      assert.strictEqual((yield* stored("C-1")).gstin, fresh);
      assert.isNull((yield* stored("C-1")).field("terms"));
      const [waits, ...more2] = (yield* LeadWork.get(scope, { key: "C-1" })).unconfirmed ?? [];
      assert.lengthOf(more2, 0);
      assert.include(waits, `Unconfirmed Terms: "Net 30. Payment`);
      assert.include(waits, `… (${tail.length} more characters)"`);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a member's turn writes a client's printed details as before, and only an owner-level person is asked",
  () =>
    Effect.gen(function* () {
      yield* seed;
      // Meera may not change a client's tax details, typed or not: refused as before, nothing asked.
      for (const said of [`Their GSTIN is ${NEW}`, "Use the number from their mail"]) {
        const refused = yield* Effect.flip(
          LeadWork.update(scope, {
            key: "C-4",
            sourceEventId: yield* turn(said, "mate"),
            gstin: NEW,
          }),
        );
        assert.isTrue(isChatError(refused), said);
        assert.lengthOf(yield* cards, 0, said);
      }
      // Saltmarsh is Meera's to look after, but its card goes to Rhea, who may edit it.
      yield* LeadWork.update(scope, { key: "C-4", sourceEventId: yield* turn(null), gstin: NEW });
      const [card] = yield* cards;
      assert.deepStrictEqual(JSON.parse(card!.awaiting), [ownerId]);
      assert.strictEqual((yield* stored("C-4")).gstin, OLD);
      // A teammate's turn reads no waiting values.
      yield* turn("What is Saltmarsh's GSTIN?", "mate");
      assert.isUndefined((yield* LeadWork.get(scope, { key: "C-4" })).unconfirmed);
    }).pipe(Effect.provide(layer)),
);
