// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecord,
  KinWorkHistoryItem,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

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
import { presetDefinition } from "./registers.ts";
import { teamSeesKey } from "./teamView.ts";

// Invented company, people, clients and deals only; nothing here reads a real database.
const orgId = KinOrgId.make("org");
const ownerId = KinPersonId.make("owner");
const zoyaId = KinPersonId.make("zoya");
const devId = KinPersonId.make("dev");
const at = "2026-11-11T00:00:00.000Z";
const owner = { _tag: "person" as const, orgId, personId: ownerId };
const zoya = { _tag: "person" as const, orgId, personId: zoyaId };
const dev = { _tag: "person" as const, orgId, personId: devId };
const asZoya = { _tag: "person" as const, personId: zoyaId };
const isChatError = Schema.is(KinChatError);
// An older build's row: the same, without `listName`.
const { listName: _listName, ...olderFields } = KinRecord.fields;
const encodeRecord = Schema.encodeEffect(KinRecord);
const decodeOlder = Schema.decodeEffect(Schema.Struct(olderFields));
const encodeHistory = Schema.encodeEffect(KinWorkHistoryItem);

const identity = Layer.mock(KinIdentity)({
  owner,
  isAgentThread: () => true,
  isLeadThread: () => true,
  resolveAgent: () =>
    Effect.succeed({
      _tag: "agent" as const,
      orgId,
      agentId: KinAgentId.make("lead"),
      ownerPersonId: ownerId,
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
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kin-deals-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** Rhea the owner; Zoya sells with Clients on; Dev delivers with Clients off. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Invented Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}), (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${at}),
      (${devId}, ${orgId}, 'dev', 'Dev', ${at})`;
  yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
    VALUES ('s-zoya', ${orgId}, ${zoyaId}, 0), ('s-dev', ${orgId}, ${devId}, 0)`;
  yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${zoyaId}`;
  const party = (name: string, extra: object) =>
    Clients.createParty([owner], { orgId, name, clientRequestId: name, ...extra });
  return {
    brightwater: (yield* party("Invented Brightwater", { prospect: true })).key,
    corran: (yield* party("Invented Corran Tiles", {})).key,
    hush: (yield* party("Invented Hush Clinic", { sensitive: true })).key,
    supplies: (yield* party("Invented Supplies", { kind: "vendor" })).key,
  };
});

const refusal = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isChatError(error) ? error.reason : error._tag)),
  );
const euros = (minor: number) => ({ minor, currency: "EUR" });
const newDeal = (party: string, title: string, extra: object = {}) => ({
  orgId,
  party,
  title,
  clientRequestId: title,
  ...extra,
});

it.effect(
  "stages: the defaults on first use, set by the owner level only, kept by the lazy insert, and a removed stage's open deals move",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran } = yield* seed;
      const first = yield* Deals.stages([zoya], { orgId });
      assert.deepStrictEqual(
        first.stages.map((stage) => stage.name),
        ["New", "In talks", "Proposal", "Deciding"],
      );
      assert.isFalse(first.can);
      // Only the owner level writes them, whoever reads.
      assert.strictEqual(
        yield* refusal(Deals.setStages([zoya], { orgId, rev: 0, stages: [{ name: "Invented" }] })),
        "not_allowed",
      );
      const renamed = yield* Deals.setStages([owner], {
        orgId,
        rev: 0,
        stages: [
          { id: "new", name: "New" },
          { id: "proposal", name: "Proposal sent" },
          { id: "in-talks", name: "In talks" },
          { id: "deciding", name: "Deciding" },
          { name: "Pilot" },
        ],
      });
      assert.deepStrictEqual(
        renamed.stages.map((stage) => [stage.id, stage.name]),
        [
          ["new", "New"],
          ["proposal", "Proposal sent"],
          ["in-talks", "In talks"],
          ["deciding", "Deciding"],
          ["pilot", "Pilot"],
        ],
      );
      // A stale version, a stage named twice and a stage id that isn't one are refused.
      assert.strictEqual(
        yield* refusal(Deals.setStages([owner], { orgId, rev: 0, stages: [{ name: "Late" }] })),
        "conflict",
      );
      assert.strictEqual(
        yield* refusal(
          Deals.setStages([owner], {
            orgId,
            rev: 1,
            stages: [{ name: "Pilot" }, { name: " pilot " }],
          }),
        ),
        "invalid_state",
      );
      // The first deal makes the register row the lazy way; the stages written stay.
      const a = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented stock system", { stage: "pilot" }),
      );
      const b = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented orders app", { stage: "pilot" }),
      );
      yield* Deals.create([owner], newDeal(corran, "Invented training"));
      assert.strictEqual(a.deal.stage, "pilot");
      assert.strictEqual((yield* Deals.stages([owner], { orgId })).stages.at(-1)?.name, "Pilot");
      assert.strictEqual(
        yield* refusal(Deals.create([owner], newDeal(corran, "Invented ghost", { stage: "nope" }))),
        "invalid_state",
      );
      // Removing Pilot needs where its two open deals go; then each moves with one history line.
      const without = renamed.stages.filter((stage) => stage.id !== "pilot");
      assert.strictEqual(
        yield* refusal(Deals.setStages([owner], { orgId, rev: 1, stages: without })),
        "invalid_state",
      );
      const before = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_changes`;
      const after = yield* Deals.setStages([owner], {
        orgId,
        rev: 1,
        stages: without,
        moveTo: { pilot: "deciding" },
      });
      assert.deepStrictEqual(after.open, { deciding: 2, new: 1 });
      const moved = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_record_changes`;
      assert.strictEqual(moved[0]!.n - before[0]!.n, 2);
      const page = yield* Deals.page([owner], { orgId, key: b.deal.key });
      assert.deepInclude(page.changes[0]!.fields[0]!, {
        field: "stage",
        from: "pilot",
        to: "Deciding",
      });
      // A refused removal changes nothing: the stages and the deals stay as they were.
      assert.strictEqual(
        yield* refusal(
          Deals.setStages([owner], {
            orgId,
            rev: 2,
            stages: [{ id: "new", name: "New" }],
            moveTo: { deciding: "gone" },
          }),
        ),
        "invalid_state",
      );
      assert.strictEqual((yield* Deals.stages([owner], { orgId })).stages.length, 4);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "who sees and does what: the owner level everything, Zoya with Clients on her own, Dev with Clients off nothing",
  () =>
    Effect.gen(function* () {
      const { brightwater, corran, hush, supplies } = yield* seed;
      // Dev, Clients off: no deals anywhere, not even the list.
      assert.strictEqual(yield* refusal(Deals.deals([dev], { orgId })), "not_allowed");
      assert.strictEqual(
        yield* refusal(Deals.create([dev], newDeal(corran, "Invented by Dev"))),
        "not_allowed",
      );
      // A vendor never has a deal; a private client is no client at all to Zoya.
      assert.strictEqual(
        yield* refusal(Deals.create([owner], newDeal(supplies, "Invented supply deal"))),
        "invalid_state",
      );
      assert.strictEqual(
        yield* refusal(Deals.create([zoya], newDeal(hush, "Invented hush deal"))),
        "not_found",
      );
      // Zoya adds a deal she looks after on a client she sees; never someone else's, never private.
      assert.strictEqual(
        yield* refusal(
          Deals.create(
            [zoya],
            newDeal(corran, "Invented for Rhea", { owner: { _tag: "person", personId: ownerId } }),
          ),
        ),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refusal(
          Deals.create([zoya], newDeal(corran, "Invented private", { sensitive: true })),
        ),
        "not_allowed",
      );
      const hers = yield* Deals.create(
        [zoya],
        newDeal(corran, "Invented stock system", { value: euros(1_800_000) }),
      );
      assert.deepInclude(hers.deal, { owner: asZoya, stage: "new", state: "open" });
      assert.deepStrictEqual(hers.deal.can, { edit: true, move: true, give: true, mark: false });
      const rheas = yield* Deals.create([owner], newDeal(brightwater, "Invented pilot"));
      const hidden = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented private renewal", { sensitive: true }),
      );
      // One she looks after that the owner then keeps private leaves her Clients (`crmSees`).
      const forZoya = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented private, Zoya's", { owner: asZoya }),
      );
      const keptForZoya = yield* Deals.update([owner], {
        orgId,
        key: forZoya.deal.key,
        rev: forZoya.deal.rev,
        sensitive: true,
      });
      const underHush = yield* Deals.create([owner], newDeal(hush, "Invented clinic system"));
      // She sees the deals of clients she sees; never a private one or one under a private
      // client, even hers.
      const seen = (yield* Deals.deals([zoya], { orgId })).deals.map((deal) => deal.key);
      assert.sameMembers(seen, [hers.deal.key, rheas.deal.key]);
      for (const key of [hidden.deal.key, underHush.deal.key, keptForZoya.deal.key]) {
        assert.strictEqual(yield* refusal(Deals.page([zoya], { orgId, key })), "not_found");
        assert.isFalse(yield* teamSeesKey(orgId, zoyaId, key));
      }
      assert.isTrue(yield* teamSeesKey(orgId, zoyaId, hers.deal.key));
      assert.isFalse(yield* teamSeesKey(orgId, devId, hers.deal.key));
      // The owner's deal she reads but does not change, move or hand over.
      const theirs = (yield* Deals.deals([zoya], { orgId })).deals.find(
        (deal) => deal.key === rheas.deal.key,
      )!;
      assert.deepStrictEqual(theirs.can, { edit: false, move: false, give: false, mark: false });
      const key = rheas.deal.key;
      const rev = rheas.deal.rev;
      for (const write of [
        Deals.move([zoya], { orgId, key, rev, to: { _tag: "stage", stage: "in-talks" } }),
        Deals.move([zoya], { orgId, key, rev, to: { _tag: "won" } }),
        Deals.move([zoya], { orgId, key, rev, to: { _tag: "lost", reason: "Invented" } }),
        Deals.update([zoya], { orgId, key, rev, title: "Invented other" }),
        Deals.update([zoya], { orgId, key, rev, owner: asZoya }),
        Deals.step([zoya], { orgId, key, step: { title: "Invented call" }, clientRequestId: "x" }),
      ])
        assert.strictEqual(yield* refusal(write), "not_allowed");
      // Her own she moves, wins, reopens and hands over; Keep private stays the owner level's.
      const moved = yield* Deals.move([zoya], {
        orgId,
        key: hers.deal.key,
        rev: hers.deal.rev,
        to: { _tag: "stage", stage: "proposal" },
      });
      assert.strictEqual(moved.deal.stage, "proposal");
      assert.strictEqual(
        yield* refusal(
          Deals.update([zoya], { orgId, key: hers.deal.key, rev: moved.deal.rev, sensitive: true }),
        ),
        "not_allowed",
      );
      // She hands her own only to someone who would still see it: never to Dev, Clients off.
      const toDev = Deals.update([zoya], {
        orgId,
        key: hers.deal.key,
        rev: moved.deal.rev,
        owner: { _tag: "person", personId: devId },
      });
      assert.strictEqual(yield* refusal(toDev), "invalid_state");
      const given = yield* Deals.update([zoya], {
        orgId,
        key: hers.deal.key,
        rev: moved.deal.rev,
        owner: { _tag: "person", personId: ownerId },
      });
      assert.deepStrictEqual(given.deal.can.move, false);
      // The owner level hands any deal over, and back, to whoever would see it; the move is
      // the deal's Activity.
      const toZoya = yield* Deals.update([owner], {
        orgId,
        key: rheas.deal.key,
        rev: rheas.deal.rev,
        owner: asZoya,
      });
      assert.deepStrictEqual(toZoya.deal.owner, asZoya);
      assert.isTrue((yield* Deals.page([zoya], { orgId, key: rheas.deal.key })).deal.can.give);
      const back = yield* Deals.update([owner], {
        orgId,
        key: rheas.deal.key,
        rev: toZoya.deal.rev,
        owner: { _tag: "person", personId: ownerId },
      });
      const moves = (yield* Deals.page([owner], { orgId, key: rheas.deal.key })).changes.flatMap(
        (change) => change.fields.filter((field) => field.field === "owner").map((f) => f.to),
      );
      // Newest first, down to the line that added it.
      assert.sameOrderedMembers(moves, ["person:owner", "person:zoya", "person:owner"]);
      const underHushNow = yield* Deals.update([owner], {
        orgId,
        key: underHush.deal.key,
        rev: underHush.deal.rev,
        owner: { _tag: "person", personId: ownerId },
      });
      for (const write of [
        Deals.update([owner], {
          orgId,
          key: back.deal.key,
          rev: back.deal.rev,
          owner: { _tag: "person", personId: devId },
        }),
        // Under a private client she sees nothing, so it can't become hers.
        Deals.update([owner], {
          orgId,
          key: underHush.deal.key,
          rev: underHushNow.deal.rev,
          owner: asZoya,
        }),
      ])
        assert.strictEqual(yield* refusal(write), "invalid_state");
      assert.deepStrictEqual(
        (yield* Deals.page([owner], { orgId, key: underHush.deal.key })).deal.owner,
        { _tag: "person", personId: ownerId },
      );
      // Nothing writes a deal but Deals: Work's own edit, as an older phone sends it, finds no
      // entry, and the repository refuses any other writer, so its stage stays.
      assert.strictEqual(
        yield* refusal(
          OwnerWork.update([owner], {
            orgId,
            key: hers.deal.key,
            rev: given.deal.rev,
            fields: { stage: null },
          }),
        ),
        "not_found",
      );
      const records = yield* KinRecords.KinRecords;
      assert.strictEqual(
        yield* refusal(
          records.update(orgId, OwnerWork.ownerWriter(owner), hers.deal.key, {
            fields: { stage: null },
          }),
        ),
        "invalid_state",
      );
      assert.strictEqual(
        (yield* Deals.page([owner], { orgId, key: hers.deal.key })).deal.stage,
        "proposal",
      );
      const corranId = (yield* records.get(orgId, corran))!.recordId;
      assert.strictEqual(
        yield* refusal(
          records.create(orgId, OwnerWork.ownerWriter(owner), {
            list: "deals",
            originKey: "around-deals",
            title: "Invented written around Deals",
            owner: { _tag: "person", personId: ownerId },
            partyId: corranId,
            fields: { stage: "nope" },
          }),
        ),
        "invalid_state",
      );
      // Its client's History shows the deal's moves to Zoya, by stage name, with its value.
      const history = yield* Clients.history([zoya], { orgId, key: corran });
      const lines = history.items
        .filter((item) => item.record.key === hers.deal.key)
        .flatMap((item) => item.fields.map((field) => `${field.field}:${field.to}`));
      assert.includeMembers(lines, ["stage:Proposal", "owner:person:owner"]);
      assert.isTrue(history.items.some((item) => item.record.listName === "deals"));
      for (const item of history.items)
        assert.notInclude([hidden.deal.key, underHush.deal.key], item.record.key);
      // Turning her Clients switch off takes every deal away.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE kin_people SET sees_clients = 0 WHERE person_id = ${zoyaId}`;
      assert.strictEqual(yield* refusal(Deals.deals([zoya], { orgId })), "not_allowed");
      assert.isFalse(yield* teamSeesKey(orgId, zoyaId, hers.deal.key));
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a new deal is looked after only by someone who sees it, whoever makes it: the hand-over's rule",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran, hush } = yield* seed;
      const meeraId = KinPersonId.make("meera");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${meeraId}, ${orgId}, 'meera', 'Meera', ${at}, 'co_owner')`;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
          created_at, retired_at)
        VALUES ('lead', ${orgId}, 'Chief of staff', 'lead', ${ownerId}, ${at}, NULL)`;
      // Rhea's and Meera's direct chats with it, where a deal given to it is reported.
      for (const [chat, personId] of [
        ["lead-chat", ownerId],
        ["meera-chat", meeraId],
      ] as const) {
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
          VALUES (${chat}, ${orgId}, 'direct', ${`${personId}:lead`}, 0, ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            person_id, role, joined_at)
          VALUES (${`${chat}-person`}, ${orgId}, ${chat}, 'person', ${personId}, 'owner', ${at})`;
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            agent_id, role, joined_at)
          VALUES (${`${chat}-lead`}, ${orgId}, ${chat}, 'agent', 'lead', 'member', ${at})`;
      }
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead', ${orgId}, 'Chief of staff', 0, 'lead-thread', '{}', '[]', 'lead-chat')`;
      const meera = { _tag: "person" as const, orgId, personId: meeraId };
      const person = (personId: KinPersonId) => ({ _tag: "person" as const, personId });
      const agent = { _tag: "agent" as const, agentId: KinAgentId.make("lead") };
      const cantSee = (name: string) =>
        `${name} can't see the new deal: give it to the owner, a co-owner or someone with Clients on who sees its client.`;
      // What an agent's write goes through, in the turn of these people (none: an owner-only turn).
      const viaAgent = (people: ReadonlyArray<KinPersonId>) => (draft: Deals.DealDraft) =>
        Effect.gen(function* () {
          const actor = yield* Deals.agentActor(orgId, {
            actor: agent,
            via: "lead",
            askedBy: people[0] ?? ownerId,
            ...(people.length === 0 ? {} : { view: { people, askers: people } }),
          });
          yield* sql.withTransaction(Deals.createAs(actor, draft));
        });
      const viaApp = (who: typeof owner) => (draft: Deals.DealDraft) =>
        Effect.asVoid(
          Deals.create([who], {
            orgId,
            party: draft.partyKey,
            title: draft.title,
            clientRequestId: draft.originKey,
            ...(draft.owner === undefined ? {} : { owner: draft.owner }),
            ...(draft.sensitive === undefined ? {} : { sensitive: draft.sensitive }),
          }),
        );
      type Holder =
        | "rhea"
        | "meera"
        | "zoya"
        | "dev"
        | "zoya, private"
        | "zoya, private client"
        | "agent";
      const holders: ReadonlyArray<[Holder, string, object]> = [
        ["rhea", corran, { owner: person(ownerId) }],
        ["meera", corran, { owner: person(meeraId) }],
        ["zoya", corran, { owner: asZoya }],
        ["dev", corran, { owner: person(devId) }],
        ["zoya, private", corran, { owner: asZoya, sensitive: true }],
        ["zoya, private client", hush, { owner: asZoya }],
        ["agent", corran, { owner: agent }],
      ];
      const ownerLevel = {
        rhea: "made",
        meera: "made",
        zoya: "made",
        dev: cantSee("Dev"),
        "zoya, private": cantSee("Zoya"),
        "zoya, private client": cantSee("Zoya"),
        agent: "made",
      } as const;
      // A teammate makes only her own, never kept private, on a client she sees.
      const teammate = {
        rhea: "not_allowed",
        meera: "not_allowed",
        zoya: "made",
        dev: "not_allowed",
        "zoya, private": "not_allowed",
        "zoya, private client": "not_found",
        agent: "not_allowed",
      } as const;
      const makers = [
        ["Rhea", viaApp(owner), ownerLevel],
        ["Meera", viaApp(meera), ownerLevel],
        ["Zoya", viaApp(zoya), teammate],
        ["an agent for Rhea", viaAgent([]), ownerLevel],
        ["an agent for Zoya", viaAgent([zoyaId]), teammate],
      ] as const;
      for (const [maker, make, expected] of makers)
        for (const [holder, party, extra] of holders) {
          const title = `Invented ${holder} by ${maker}`;
          const outcome = yield* Effect.result(
            make({ partyKey: party, title, originKey: title, ...extra }),
          );
          const got =
            outcome._tag === "Success"
              ? "made"
              : isChatError(outcome.failure)
                ? outcome.failure.reason === "invalid_state"
                  ? outcome.failure.message
                  : outcome.failure.reason
                : outcome.failure._tag;
          assert.strictEqual(got, expected[holder], `${maker} for ${holder}`);
        }
      // A refused one left nothing behind.
      const [{ n } = { n: -1 }] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE register_id = 'deals' AND title LIKE 'Invented dev by %'`;
      assert.strictEqual(n, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "winning makes the prospect a client once, logged; reopening keeps it a client; lost keeps its reason",
  () =>
    Effect.gen(function* () {
      const { brightwater } = yield* seed;
      const deal = (yield* Deals.create([owner], newDeal(brightwater, "Invented pilot"))).deal;
      assert.isTrue(deal.party.prospect);
      const won = yield* Deals.move([owner], {
        orgId,
        key: deal.key,
        rev: deal.rev,
        to: { _tag: "won" },
      });
      assert.isTrue(won.becameClient);
      assert.strictEqual(won.deal.state, "won");
      assert.isUndefined(won.deal.party.prospect);
      const page = yield* Clients.party([owner], { orgId, key: brightwater });
      assert.isUndefined(page.party.prospect);
      const history = yield* Clients.history([owner], { orgId, key: brightwater });
      const kinds = history.items
        .filter((item) => item.record.key === brightwater)
        .flatMap((item) => item.fields.filter((field) => field.field === "category"));
      assert.deepStrictEqual(
        kinds.map((field) => [field.from, field.to]),
        [["prospect", "client"]],
      );
      // The same tap again changes nothing and makes no second client line.
      const again = yield* Deals.move([owner], {
        orgId,
        key: deal.key,
        rev: won.deal.rev,
        to: { _tag: "won" },
      });
      assert.isUndefined(again.becameClient);
      // A won deal doesn't move stage; reopening puts it back where it was, still a client's.
      assert.strictEqual(
        yield* refusal(
          Deals.move([owner], {
            orgId,
            key: deal.key,
            rev: won.deal.rev,
            to: { _tag: "stage", stage: "deciding" },
          }),
        ),
        "invalid_state",
      );
      const reopened = yield* Deals.move([owner], {
        orgId,
        key: deal.key,
        rev: won.deal.rev,
        to: { _tag: "reopen" },
      });
      assert.deepInclude(reopened.deal, { state: "open", stage: "new" });
      assert.isUndefined(
        (yield* Clients.party([owner], { orgId, key: brightwater })).party.prospect,
      );
      // Lost needs its line of reason and keeps it; reopening takes it off.
      assert.strictEqual(
        yield* refusal(
          Deals.move([owner], {
            orgId,
            key: deal.key,
            rev: reopened.deal.rev,
            to: { _tag: "lost", reason: "   " },
          }),
        ),
        "invalid_state",
      );
      const lost = yield* Deals.move([owner], {
        orgId,
        key: deal.key,
        rev: reopened.deal.rev,
        to: { _tag: "lost", reason: "Invented: chose a cheaper offer" },
      });
      assert.deepInclude(lost.deal, {
        state: "lost",
        lostReason: "Invented: chose a cheaper offer",
      });
      const back = yield* Deals.move([owner], {
        orgId,
        key: deal.key,
        rev: lost.deal.rev,
        to: { _tag: "reopen" },
      });
      assert.isUndefined(back.deal.lostReason);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a deal and its first next step are one transaction: a retry makes one of each, a bad date makes neither",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran } = yield* seed;
      const count = (list: string) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = ${list}`.pipe(
          Effect.map((rows) => rows[0]!.n),
        );
      const input = newDeal(corran, "Invented stock system", {
        expectedOn: "2026-12-18",
        next: { title: "Invented: send the pilot outline", dueAt: "2026-11-20", dueAllDay: true },
      });
      const made = yield* Deals.create([zoya], input);
      yield* Deals.create([zoya], input);
      assert.strictEqual(yield* count("deals"), 1);
      assert.strictEqual(yield* count("work"), 1);
      assert.deepInclude(made.deal.next!, {
        title: "Invented: send the pilot outline",
        dueAllDay: true,
      });
      assert.isTrue(made.deal.expectedAllDay);
      // The same key asking for something else is refused.
      assert.strictEqual(
        yield* refusal(Deals.create([zoya], { ...input, title: "Invented other" })),
        "not_allowed",
      );
      assert.strictEqual(
        yield* refusal(
          Deals.create(
            [zoya],
            newDeal(corran, "Invented broken", { next: { title: "Invented", dueAt: "not a day" } }),
          ),
        ),
        "invalid_state",
      );
      assert.strictEqual(yield* count("deals"), 1);
      // With no step it shows as having none at once; a step added later is its next.
      const bare = yield* Deals.create([zoya], newDeal(corran, "Invented training"));
      assert.isNull(bare.deal.next);
      const stepped = yield* Deals.step([zoya], {
        orgId,
        key: bare.deal.key,
        step: { title: "Invented: book the call" },
        clientRequestId: "book",
      });
      assert.strictEqual(stepped.deal.next?.title, "Invented: book the call");
      // The owner's own follow-up, not shared with the team, is his deal's next step and not hers,
      // as on the client's row (`crmSees`).
      const rheas = yield* Deals.step([owner], {
        orgId,
        key: bare.deal.key,
        step: { title: "Invented: owner's call", dueAt: "2026-11-12", dueAllDay: true },
        clientRequestId: "owners",
      });
      assert.strictEqual(rheas.deal.next?.title, "Invented: owner's call");
      const forZoya = yield* Deals.page([zoya], { orgId, key: bare.deal.key });
      assert.notInclude(
        forZoya.steps.map((step) => step.title),
        "Invented: owner's call",
      );
      const row = (yield* Clients.parties([zoya], { orgId })).parties.find(
        (party) => party.key === corran,
      );
      assert.notStrictEqual(row?.next?.title, "Invented: owner's call");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "open deals total per currency, never summed across; a deal with no value counts only",
  () =>
    Effect.gen(function* () {
      const { corran, brightwater } = yield* seed;
      yield* Deals.create([owner], newDeal(corran, "Invented A", { value: euros(1_000_00) }));
      yield* Deals.create([owner], newDeal(corran, "Invented B", { value: euros(250_00) }));
      yield* Deals.create(
        [owner],
        newDeal(brightwater, "Invented C", { value: { minor: 5_000_00, currency: "INR" } }),
      );
      yield* Deals.create([owner], newDeal(brightwater, "Invented D"));
      const all = yield* Deals.deals([owner], { orgId });
      assert.strictEqual(all.open.count, 4);
      assert.deepStrictEqual(all.open.values, [
        euros(1_250_00),
        { minor: 5_000_00, currency: "INR" },
      ]);
      const one = yield* Deals.deals([owner], { orgId, party: brightwater });
      assert.deepStrictEqual(one.open, {
        count: 2,
        values: [{ minor: 5_000_00, currency: "INR" }],
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a linked quote marked Accepted is shown, to who may see it, and wins nothing by itself",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { corran, brightwater } = yield* seed;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
        created_at, definition_json)
      VALUES (${orgId}, 'quotes', 'Quotes', 'QT', 0, 0, ${JSON.stringify(presetDefinition("quotes", "EUR"))})`;
      const records = yield* KinRecords.KinRecords;
      const writer = OwnerWork.ownerWriter(owner);
      const corranRow = (yield* records.get(orgId, corran))!;
      const { row: quote } = yield* records.create(orgId, writer, {
        list: "quotes",
        originKey: "invented-quote",
        title: "Invented stock system quote",
        owner: { _tag: "person", personId: ownerId },
        partyId: corranRow.recordId,
        amount: euros(1_800_000),
      });
      assert.strictEqual(
        yield* refusal(
          Deals.create(
            [owner],
            newDeal(brightwater, "Invented wrong client", { quote: quote.key }),
          ),
        ),
        "invalid_state",
      );
      const made = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented stock system", { quote: quote.key, owner: asZoya }),
      );
      assert.deepInclude(made.deal.quote!, { key: quote.key, accepted: false });
      yield* records.update(orgId, writer, quote.key, { state: "done" });
      const after = yield* Deals.deals([owner], { orgId });
      assert.deepInclude(after.deals[0]!, { state: "open" });
      assert.isTrue(after.deals[0]!.quote?.accepted);
      // Edit offers only this client's quotes; another client's is refused all the same.
      const brightwaterRow = (yield* records.get(orgId, brightwater))!;
      const { row: theirQuote } = yield* records.create(orgId, writer, {
        list: "quotes",
        originKey: "invented-other-quote",
        title: "Invented clinic quote",
        owner: { _tag: "person", personId: ownerId },
        partyId: brightwaterRow.recordId,
        amount: euros(500_000),
      });
      const offered = (yield* Deals.page([owner], { orgId, key: made.deal.key })).quotes;
      assert.deepStrictEqual(
        offered?.map((one) => [one.key, one.accepted]),
        [[quote.key, true]],
      );
      assert.strictEqual(
        yield* refusal(
          Deals.update([owner], {
            orgId,
            key: made.deal.key,
            rev: after.deals[0]!.rev,
            quote: theirQuote.key,
          }),
        ),
        "invalid_state",
      );
      // A quote is money: Zoya, without the Money switch, sees the deal and not its quote, and
      // Edit offers her none.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${zoyaId}`;
      const hers = yield* Deals.deals([zoya], { orgId });
      assert.isUndefined(hers.deals[0]!.quote);
      assert.deepStrictEqual((yield* Deals.page([zoya], { orgId, key: made.deal.key })).quotes, []);
      // Unlinking takes it off.
      const off = yield* Deals.update([owner], {
        orgId,
        key: made.deal.key,
        rev: after.deals[0]!.rev,
        quote: null,
      });
      assert.isUndefined(off.deal.quote);
    }).pipe(Effect.provide(layer)),
);

it.effect("an older client reads a deal as a Work entry, with its true list beside it", () =>
  Effect.gen(function* () {
    const { corran } = yield* seed;
    const made = yield* Deals.create([owner], newDeal(corran, "Invented stock system"));
    const detail = yield* OwnerWork.get([owner], { orgId, key: made.deal.key });
    assert.isUndefined(detail.list);
    assert.strictEqual(detail.listName, "deals");
    // A schema without `listName` (an older build) still decodes the row and its history line.
    const wire = yield* encodeRecord(detail);
    const older = yield* decodeOlder(wire);
    assert.strictEqual(older.key, made.deal.key);
    const history = yield* Clients.history([owner], { orgId, key: corran });
    const line = history.items.find((item) => item.record.key === made.deal.key)!;
    assert.deepInclude((yield* encodeHistory(line)).record, {
      list: "work",
      listName: "deals",
    });
  }).pipe(Effect.provide(layer)),
);
