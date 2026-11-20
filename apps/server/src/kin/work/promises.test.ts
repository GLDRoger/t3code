// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { KinAgentId, KinChatError, KinOrgId, KinPersonId, ThreadId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Deals from "./deals.ts";
import * as KinRecords from "./KinRecords.ts";
import * as Clients from "./ownerClients.ts";
import * as OwnerWork from "./ownerWork.ts";

// Invented company, people, clients and deals only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const rheaId = KinPersonId.make("rhea");
const coraId = KinPersonId.make("cora");
const zoyaId = KinPersonId.make("zoya");
const arjunId = KinPersonId.make("arjun");
const devId = KinPersonId.make("dev");
const growth = KinAgentId.make("growth");
const stamp = "2026-11-01T00:00:00.000Z";
/** Friday 20 November 2026, 10:00 UTC. */
const NOW = Date.UTC(2026, 10, 20, 10);
const person = (personId: KinPersonId) => ({ _tag: "person" as const, orgId, personId });
const rhea = person(rheaId);
const cora = person(coraId);
const zoya = person(zoyaId);
const arjun = person(arjunId);
const dev = person(devId);
const asPrincipal = (personId: KinPersonId) => ({ _tag: "person" as const, personId });
const isChatError = Schema.is(KinChatError);

const identity = Layer.mock(KinIdentity)({
  owner: rhea,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make("lead"),
      ownerPersonId: rheaId,
      threadId: ThreadId.make("lead-thread"),
    }),
});
const gate = Layer.mock(KinLevelGate)({
  ask: () => Effect.fail(new KinChatError({ reason: "unavailable", message: "No chat here." })),
});
const layer = Layer.mergeAll(KinRecords.layer, identity, gate).pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(KinPersistence.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-promises-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * Rhea owns it, Cora co-owns it; Zoya sells and looks after Corran Tiles, Arjun has Clients on
 * too, and Dev has Clients off. Corran has a deal of Zoya's; a meeting and a chat message where
 * promises were made.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* TestClock.setTime(NOW);
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${stamp})`;
  // The company's days are UTC's, whatever zone this machine is in.
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES (${orgId}, 'UTC', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
      sees_clients)
    VALUES (${rheaId}, ${orgId}, 'rhea', 'Rhea', ${stamp}, 'owner', 0),
      (${coraId}, ${orgId}, 'cora', 'Cora', ${stamp}, 'co_owner', 0),
      (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${stamp}, NULL, 1),
      (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${stamp}, NULL, 1),
      (${devId}, ${orgId}, 'dev', 'Dev', ${stamp}, NULL, 0)`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('s-cora', ${orgId}, ${coraId}, 0), ('s-zoya', ${orgId}, ${zoyaId}, 0),
      ('s-arjun', ${orgId}, ${arjunId}, 0), ('s-dev', ${orgId}, ${devId}, 0)`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${growth}, ${orgId}, 'Growth', 'lead', ${rheaId}, ${stamp})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('growth-room', ${orgId}, 'team_group', 0, ${stamp})`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
      worker_projects_json, owner_chat_id, domain)
    VALUES (${growth}, ${orgId}, 'Growth', 0, '{}', '[]', 'growth-room', 'growth')`;
  const corran = yield* Clients.createParty([rhea], {
    orgId,
    name: "Invented Corran Tiles",
    owner: asPrincipal(zoyaId),
    clientRequestId: "corran",
  });
  const orbit = yield* Clients.createParty([rhea], {
    orgId,
    name: "Invented Orbit Dental",
    clientRequestId: "orbit",
  });
  const deal = yield* Deals.create([zoya], {
    orgId,
    party: corran.key,
    title: "Invented stock system",
    clientRequestId: "deal",
  });
  const records = yield* KinRecords.KinRecords;
  const corranId = (yield* records.get(orgId, corran.key))!.recordId;
  yield* sql`INSERT INTO kin_client_touches (org_id, touch_id, party_id, at, kind, logged_by_kind,
      logged_by_id, origin_key, created_at)
    VALUES (${orgId}, 't-meeting', ${corranId}, ${Date.UTC(2026, 10, 18, 9)}, 'meeting', 'person',
      ${zoyaId}, 't-meeting', ${Date.UTC(2026, 10, 18, 9)})`;
  // Zoya's direct chat with Growth, where she said it; Arjun is in no such chat.
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('zoya-growth', ${orgId}, 'direct', 'zoya:growth', 1, ${stamp})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
      agent_id, role, joined_at)
    VALUES ('zoya-in', ${orgId}, 'zoya-growth', 'person', ${zoyaId}, NULL, 'owner', ${stamp}),
      ('growth-in', ${orgId}, 'zoya-growth', 'agent', NULL, ${growth}, 'member', ${stamp})`;
  yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
      author_person_id, author_member_id, author_role, kind, body, intent, mentions_json, status,
      created_at)
    VALUES ('m-said', ${orgId}, 'zoya-growth', 1, 'human', ${zoyaId}, 'zoya-in', 'owner', 'text',
      'Invented: they send the staff list by Wednesday', NULL, '[]', 'posted',
      '2026-11-20T09:30:00.000Z')`;
  return { corran: corran.key, orbit: orbit.key, deal: deal.deal.key };
});

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isChatError(error) ? error.reason : error._tag)),
  );
const promise = (title: string, extra: object) => ({
  orgId,
  title,
  category: "obligation" as const,
  dueAt: "2026-11-25",
  dueAllDay: true,
  clientRequestId: title,
  ...extra,
});

it.effect(
  "a promise made naming a deal sits on it, in the same write; dropped it leaves the deal, a closed deal keeps it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran, orbit, deal } = yield* seed;
      // Named by its deal alone, it takes the deal's client.
      const ours = yield* OwnerWork.create([zoya], promise("Invented send the plan", { deal }));
      const theirs = yield* OwnerWork.create(
        [rhea],
        promise("Invented staff list", { deal, party: corran, side: "theirs" }),
      );
      assert.strictEqual(ours.party?.key, corran);
      const links = yield* sql<{ key: string; label: string }>`SELECT r.key, l.label
        FROM kin_record_links l JOIN kin_records r ON r.org_id = l.org_id
          AND r.record_id = l.record_id
        WHERE l.kind = 'record' AND l.relation = 'relates' AND r.register_id = 'work'
        ORDER BY r.key`;
      assert.deepStrictEqual(links, [
        { key: ours.key, label: deal },
        { key: theirs.key, label: deal },
      ]);
      // Another client's deal, or a deal nobody here sees, is refused and writes nothing.
      assert.strictEqual(
        yield* refusal(OwnerWork.create([rhea], promise("Invented wrong", { deal, party: orbit }))),
        "invalid_state",
      );
      assert.strictEqual(
        yield* refusal(OwnerWork.create([rhea], promise("Invented ghost", { deal: "DL-99" }))),
        "not_found",
      );
      const page = yield* Deals.page([zoya], { orgId, key: deal });
      assert.deepStrictEqual(
        page.promises?.map((one) => [one.key, one.side]),
        [
          [ours.key, "ours"],
          [theirs.key, "theirs"],
        ],
      );
      // Its follow-ups stay what they were: a promise is not a next step.
      // Dropped, it leaves the deal; reopened, it is back.
      const dropped = yield* OwnerWork.update([zoya], {
        orgId,
        key: ours.key,
        rev: ours.rev,
        state: "dropped",
      });
      assert.deepStrictEqual(
        (yield* Deals.page([zoya], { orgId, key: deal })).promises?.map((one) => one.key),
        [theirs.key],
      );
      yield* OwnerWork.update([zoya], { orgId, key: ours.key, rev: dropped.rev, state: "open" });
      assert.lengthOf((yield* Deals.page([zoya], { orgId, key: deal })).promises ?? [], 2);
      // The deal won: its promises stay as they were.
      const dealRow = (yield* Deals.page([zoya], { orgId, key: deal })).deal;
      yield* Deals.move([zoya], { orgId, key: deal, rev: dealRow.rev, to: { _tag: "won" } });
      const after = yield* Deals.page([zoya], { orgId, key: deal });
      assert.deepStrictEqual(
        after.promises?.map((one) => one.state),
        ["open", "open"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "where it was made: a meeting, a mail or a message here, or typed words; anything else is refused",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran, orbit, deal } = yield* seed;
      const meeting = yield* OwnerWork.create(
        [zoya],
        promise("Invented revised quote", { party: corran, from: "meeting:t-meeting" }),
      );
      const chat = yield* OwnerWork.create(
        [zoya],
        promise("Invented staff list", { deal, side: "theirs", from: "chat:m-said" }),
      );
      const typed = yield* OwnerWork.create(
        [zoya],
        promise("Invented site photos", { party: corran, from: "At the site visit" }),
      );
      const stored = yield* sql<{ key: string; from: string }>`SELECT key,
          json_extract(fields_json, '$.from') AS "from" FROM kin_records
        WHERE register_id = 'work' ORDER BY key`;
      assert.deepStrictEqual(stored, [
        { key: meeting.key, from: "meeting:t-meeting" },
        { key: chat.key, from: "chat:m-said" },
        { key: typed.key, from: "At the site visit" },
      ]);
      // A contact logged on another client, a message that isn't here, and a mail with no
      // client at all are refused.
      for (const [from, extra] of [
        ["meeting:t-meeting", { party: orbit }],
        ["chat:m-nowhere", { party: corran }],
        ["mail:t-meeting", {}],
      ] as const)
        assert.strictEqual(
          yield* refusal(OwnerWork.create([rhea], promise(`Invented ${from}`, { from, ...extra }))),
          "not_found",
          from,
        );
      // Zoya, in the chat, may open the message; Arjun and the owner read words and the day.
      const page = (who: typeof zoya) => Clients.party([who], { orgId, key: corran });
      const fromOf = (rows: ReadonlyArray<{ key: string; from?: unknown }>, key: string) =>
        rows.find((one) => one.key === key)?.from;
      const zoyas = yield* page(zoya);
      assert.deepStrictEqual(fromOf(zoyas.weOwe.records, meeting.key), {
        kind: "meeting",
        at: "2026-11-18T09:00:00.000Z",
      });
      assert.deepStrictEqual(fromOf(zoyas.theyOwe.records, chat.key), {
        kind: "chat",
        at: "2026-11-20T09:30:00.000Z",
        chatId: "zoya-growth",
        messageId: "m-said",
      });
      assert.deepStrictEqual(fromOf(zoyas.weOwe.records, typed.key), {
        kind: "note",
        note: "At the site visit",
      });
      for (const reader of [arjun, rhea])
        assert.deepStrictEqual(fromOf((yield* page(reader)).theyOwe.records, chat.key), {
          kind: "chat",
          at: "2026-11-20T09:30:00.000Z",
        });
      // A plain task says nothing of where it came from.
      const task = yield* OwnerWork.create([rhea], {
        orgId,
        title: "Invented plain task",
        party: corran,
        clientRequestId: "plain",
      });
      assert.isUndefined(fromOf((yield* page(rhea)).weOwe.records, task.key));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "what a client owes is held by whoever looks after it, else the owner, and moves with the client",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const { corran, orbit } = yield* seed;
      const theirs = (title: string, party: string) =>
        OwnerWork.create([rhea], promise(title, { party, side: "theirs" }));
      // Corran is Zoya's: hers, though Rhea wrote it. Orbit is Rhea's own.
      const signed = yield* theirs("Invented signed form", corran);
      assert.deepStrictEqual(signed.owner, asPrincipal(zoyaId));
      assert.deepStrictEqual((yield* theirs("Invented logo", orbit)).owner, asPrincipal(rheaId));
      // Given to someone by name, it is theirs; ours stays with whoever wrote it.
      const named = yield* OwnerWork.create(
        [rhea],
        promise("Invented named", { party: corran, side: "theirs", owner: asPrincipal(arjunId) }),
      );
      assert.deepStrictEqual(named.owner, asPrincipal(arjunId));
      const ours = yield* OwnerWork.create([rhea], promise("Invented ours", { party: corran }));
      assert.deepStrictEqual(ours.owner, asPrincipal(rheaId));
      // An agent looks after Orbit: the owner holds what it owes.
      const orbitRow = (yield* records.get(orgId, orbit))!;
      yield* records.update(orgId, OwnerWork.ownerWriter(rhea), orbit, {
        owner: { _tag: "agent", agentId: growth },
      });
      assert.deepStrictEqual(
        (yield* theirs("Invented for an agent's client", orbit)).owner,
        asPrincipal(rheaId),
      );
      assert.isDefined(orbitRow);
      // Handed to Arjun: the open ones Zoya held go with it; done ones and Arjun's named one stay.
      const done = yield* theirs("Invented already in", corran);
      yield* OwnerWork.update([zoya], { orgId, key: done.key, rev: done.rev, state: "done" });
      const party = (yield* Clients.party([rhea], { orgId, key: corran })).party;
      yield* Clients.updateParty([rhea], {
        orgId,
        key: corran,
        rev: party.rev,
        owner: asPrincipal(arjunId),
      });
      const holders = yield* sql<{ key: string; owner: string }>`SELECT key, owner_id AS owner
        FROM kin_records WHERE register_id = 'work' AND side = 'theirs' ORDER BY key`;
      assert.deepStrictEqual(Object.fromEntries(holders.map((row) => [row.key, row.owner])), {
        [signed.key]: arjunId,
        [named.key]: arjunId,
        [done.key]: zoyaId,
        ...Object.fromEntries(
          holders.filter((row) => row.owner === rheaId).map((row) => [row.key, rheaId]),
        ),
      });
      // Arjun leaves: a new one goes to the owner; Zoya, back on it, takes Rhea's held ones.
      yield* sql`UPDATE kin_people SET removed_at = ${NOW} WHERE person_id = ${arjunId}`;
      assert.deepStrictEqual(
        (yield* theirs("Invented after Arjun", corran)).owner,
        asPrincipal(rheaId),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a teammate adds a promise on a client they see, with where it was made and its deal; Clients off, none",
  () =>
    Effect.gen(function* () {
      const { corran, deal } = yield* seed;
      const made = yield* OwnerWork.create(
        [arjun],
        promise("Invented by Arjun", { deal, from: "At the trade fair" }),
      );
      assert.strictEqual(made.party?.key, corran);
      assert.deepStrictEqual(
        (yield* Deals.page([arjun], { orgId, key: deal })).promises?.map((one) => one.key),
        [made.key],
      );
      assert.strictEqual(
        yield* refusal(OwnerWork.create([dev], promise("Invented by Dev", { deal }))),
        "not_found",
      );
      assert.strictEqual(
        yield* refusal(
          OwnerWork.create([dev], promise("Invented by Dev", { party: corran, from: "Here" })),
        ),
        "not_found",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a deal's promises and a client's contract dates, to each role: owner, co-owner, looker-after, another with Clients on; Clients off sees nothing",
  () =>
    Effect.gen(function* () {
      const { corran, deal } = yield* seed;
      yield* OwnerWork.create([zoya], promise("Invented plan", { deal, from: "chat:m-said" }));
      yield* OwnerWork.create(
        [zoya],
        promise("Invented staff list", { deal, side: "theirs", dueAt: "2026-11-24" }),
      );
      const project = yield* Clients.createProject([rhea], {
        orgId,
        name: "Invented rota system",
        party: corran,
        renewsOn: "2027-03-01",
        noticeDays: 60,
        clientRequestId: "rota",
      });
      assert.strictEqual(project.noticeDays, 60);
      for (const who of [rhea, cora, zoya, arjun]) {
        const page = yield* Deals.page([who], { orgId, key: deal });
        assert.deepStrictEqual(
          page.promises?.map((one) => [one.title, one.side]),
          [
            ["Invented plan", "ours"],
            ["Invented staff list", "theirs"],
          ],
          who.personId,
        );
        const client = yield* Clients.party([who], { orgId, key: corran });
        assert.deepStrictEqual(
          client.contract,
          { project: project.key, renewsOn: "2027-03-01", noticeBy: "2026-12-31" },
          who.personId,
        );
      }
      assert.strictEqual(yield* refusal(Deals.page([dev], { orgId, key: deal })), "not_allowed");
      // Within the heads-up (14 days by default) of the notice day the line is amber.
      const contract = Effect.map(
        Clients.party([rhea], { orgId, key: corran }),
        (page) => page.contract,
      );
      yield* TestClock.setTime(Date.UTC(2026, 11, 16, 12));
      assert.isUndefined((yield* contract)?.soon);
      yield* TestClock.setTime(Date.UTC(2026, 11, 17, 12));
      assert.isTrue((yield* contract)?.soon);
      // With no notice days, the renewal alone; the soonest of two projects is the line.
      const stored = yield* Clients.project([rhea], { orgId, key: project.key });
      yield* Clients.updateProject([rhea], {
        orgId,
        key: project.key,
        rev: stored.project.rev,
        noticeDays: null,
      });
      yield* Clients.createProject([rhea], {
        orgId,
        name: "Invented later one",
        party: corran,
        renewsOn: "2027-06-01",
        noticeDays: 30,
        clientRequestId: "later",
      });
      assert.deepStrictEqual(yield* contract, { project: project.key, renewsOn: "2027-03-01" });
      // Past its renewal day, the next one ahead is the line.
      yield* TestClock.setTime(Date.UTC(2027, 2, 2, 12));
      assert.deepStrictEqual(yield* contract, {
        project: "P-2",
        renewsOn: "2027-06-01",
        noticeBy: "2027-05-02",
      });
    }).pipe(Effect.provide(layer)),
);
