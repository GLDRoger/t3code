// Loaded first: the chat and trigger modules import each other.
import "../chat/KinChatService.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  KinAgentId,
  KinChatError,
  type KinDealMove,
  type KinDealNumbers,
  KinOrgId,
  KinPersonId,
  KinRecord,
  KinWorkHistoryItem,
  KIN_DEAL_STEP_FIELD,
  KIN_LEFT_FIELD,
  type KinWorkPrincipal,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import { pipelineLines, weeklyFigures } from "../pulse/weekly.ts";
import { setProfile } from "./companyProfile.ts";
import { setWeeklyPipeline } from "./dealStages.ts";
import * as Deals from "./deals.ts";
import * as KinRecords from "./KinRecords.ts";
import * as Clients from "./ownerClients.ts";
import * as OwnerDocs from "./ownerDocs.ts";
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
  // Rhea owns the org, which makes a quote she writes kept; here no agent row says so.
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${ownerId}, ${orgId}, 'rhea', 'Rhea', ${at}, 'owner'),
      (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${at}, NULL), (${devId}, ${orgId}, 'dev', 'Dev', ${at}, NULL)`;
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
        from: "Pilot",
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
      // Each move reads in the names its stages had then, through a later rename too.
      yield* Deals.move([owner], {
        orgId,
        key: b.deal.key,
        rev: page.deal.rev,
        to: { _tag: "stage", stage: "new" },
      });
      yield* Deals.setStages([owner], {
        orgId,
        rev: 2,
        stages: without.map((stage) => (stage.id === "new" ? { ...stage, name: "Fresh" } : stage)),
      });
      const later = yield* Deals.page([owner], { orgId, key: b.deal.key });
      assert.deepStrictEqual(
        later.changes.slice(0, 2).map((change) => [change.fields[0]!.from, change.fields[0]!.to]),
        [
          ["Deciding", "New"],
          ["Pilot", "Deciding"],
        ],
      );
      // The client's History reads the move the same way.
      const told = (yield* Clients.history([owner], { orgId, key: corran })).items.find(
        (item) => item.record.key === b.deal.key && item.fields[0]?.field === "stage",
      );
      assert.deepInclude(told!.fields[0]!, { from: "Deciding", to: "New" });
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
  "a deal's next steps its keeper held go with it to the new keeper, logged on the deal; anyone else's stay",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const { corran } = yield* seed;
      yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
          created_at, retired_at)
        VALUES ('sales', ${orgId}, 'Sales', 'lead', ${ownerId}, ${at}, NULL)`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
        VALUES ('sales-chat', ${orgId}, 'direct', ${`${ownerId}:sales`}, 0, ${at})`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, thread_id, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('sales', ${orgId}, 'Sales', 0, 'sales-thread', '{}', '[]', 'sales-chat')`;
      const person = (personId: KinPersonId) => ({ _tag: "person" as const, personId });
      const agent = { _tag: "agent" as const, agentId: KinAgentId.make("sales") };
      const deal = (yield* Deals.create([owner], newDeal(corran, "Invented revised quote"))).deal;
      const dealRow = (yield* records.get(orgId, deal.key))!;
      const step = (title: string, holder: KinWorkPrincipal, extra: object = {}) =>
        records
          .create(orgId, OwnerWork.ownerWriter(owner), {
            originKey: title,
            title,
            owner: holder,
            category: "task",
            side: "ours",
            partyId: dealRow.partyId,
            links: [{ kind: "record", target: dealRow.recordId, relation: "relates" }],
            ...extra,
          })
          .pipe(Effect.map(({ row }) => row.key));
      const theirs = yield* step("Invented: send revised quote", person(ownerId));
      const devs = yield* step("Invented: Dev's install check", person(devId));
      const agents = yield* step("Invented: Sales drafts the follow-up", agent);
      const kept = yield* step("Invented: Rhea's private call", person(ownerId), {
        sensitive: true,
      });
      const finished = yield* step("Invented: first call", person(ownerId));
      yield* records.update(orgId, OwnerWork.ownerWriter(owner), finished, { state: "done" });
      const given = yield* Deals.update([owner], {
        orgId,
        key: deal.key,
        rev: deal.rev,
        owner: asZoya,
      });
      const holders = Object.fromEntries(
        yield* Effect.forEach([theirs, devs, agents, kept, finished], (key) =>
          records
            .get(orgId, key)
            .pipe(Effect.map((row) => [key, `${row!.ownerKind}:${row!.ownerId}`])),
        ),
      );
      assert.deepStrictEqual(holders, {
        [theirs]: "person:zoya",
        [devs]: "person:dev",
        [agents]: "agent:sales",
        [kept]: "person:owner",
        [finished]: "person:owner",
      });
      // Zoya's deal, its client's row and her page now show the step; Rhea no longer holds it.
      assert.strictEqual(given.deal.next?.key, theirs);
      const hers = yield* Deals.page([zoya], { orgId, key: deal.key });
      assert.include(
        hers.steps.map((one) => one.key),
        theirs,
      );
      const row = (yield* Clients.parties([zoya], { orgId })).parties.find(
        (party) => party.key === corran,
      );
      assert.strictEqual(row?.next?.title, "Invented: send revised quote");
      // One line on the deal names it: by title to the owner level, by key to a member.
      const stepOf = (page: typeof hers) =>
        page.changes[0]!.fields.filter((field) => field.field === KIN_DEAL_STEP_FIELD);
      assert.deepStrictEqual(
        stepOf(yield* Deals.page([owner], { orgId, key: deal.key })).map((field) => field.to),
        [`${theirs} Invented: send revised quote`],
      );
      assert.deepStrictEqual(
        stepOf(hers).map((field) => field.to),
        [theirs],
      );
      // An agent's hand-over follows the same rule and names the step to whoever takes it.
      const back = yield* sql.withTransaction(
        Effect.gen(function* () {
          const actor = yield* Deals.agentActor(orgId, {
            actor: agent,
            via: "lead",
            askedBy: ownerId,
          });
          return yield* Deals.updateAs(actor, deal.key, { owner: person(ownerId) });
        }),
      );
      assert.strictEqual((yield* records.get(orgId, theirs))!.ownerId, ownerId);
      assert.strictEqual((yield* records.get(orgId, agents))!.ownerKind, "agent");
      assert.deepStrictEqual(
        back.notices.map((notice) => [notice.kind, notice.personId, notice.row.key]),
        [
          ["given", ownerId, theirs],
          ["taken", zoyaId, theirs],
        ],
      );
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
      assert.isUndefined(bare.deal.nextHidden);
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
      // A step the owner writes with a deal she gives Zoya is the deal's first, so it is Zoya's.
      const given = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented rollout", {
          owner: asZoya,
          next: { title: "Invented: send the rollout plan" },
        }),
      );
      const hers = yield* Deals.page([zoya], { orgId, key: given.deal.key });
      assert.strictEqual(hers.deal.next?.title, "Invented: send the rollout plan");
      const [held] = yield* sql<{ ownerId: string }>`SELECT owner_id AS "ownerId" FROM kin_records
        WHERE register_id = 'work' AND title = 'Invented: send the rollout plan'`;
      assert.strictEqual(held?.ownerId, zoyaId);
      // The owner's deal whose only step is the owner's: Zoya learns it has one she isn't shown,
      // and nothing of the step itself; the owner reads it as ever.
      const signage = yield* Deals.create(
        [owner],
        newDeal(corran, "Invented signage", {
          next: { title: "Invented: send the drawings", dueAt: "2026-11-24", dueAllDay: true },
        }),
      );
      const zoyas = yield* Deals.page([zoya], { orgId, key: signage.deal.key });
      assert.isNull(zoyas.deal.next);
      assert.isTrue(zoyas.deal.nextHidden);
      assert.deepStrictEqual(zoyas.steps, []);
      const [step] = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE register_id = 'work' AND title = 'Invented: send the drawings'`;
      const sent = JSON.stringify(zoyas);
      for (const hidden of ["Invented: send the drawings", step!.key, "2026-11-24"])
        assert.notInclude(sent, hidden);
      const ownersView = yield* Deals.page([owner], { orgId, key: signage.deal.key });
      assert.strictEqual(ownersView.deal.next?.title, "Invented: send the drawings");
      assert.isUndefined(ownersView.deal.nextHidden);
      // Where she sees a step of her own, that is its next step and nothing is said hidden.
      assert.isUndefined(
        (yield* Deals.page([zoya], { orgId, key: bare.deal.key })).deal.nextHidden,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a new client with its deal is one transaction: a retry returns both, a refused deal keeps no client",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      const count = (list: string) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records WHERE register_id = ${list}`.pipe(
          Effect.map((rows) => rows[0]!.n),
        );
      const clients = yield* count("clients");
      const input = {
        orgId,
        name: "Invented Tidewater",
        prospect: true,
        contact: { name: "Invented Ira", phones: ["+1 555 0100"] },
        deal: { title: "Invented Tidewater", value: euros(400_000) },
        clientRequestId: "tidewater",
      };
      const made = yield* Clients.createPartyWithDeal([zoya], input);
      const again = yield* Clients.createPartyWithDeal([zoya], input);
      assert.strictEqual(again.party.key, made.party.key);
      assert.strictEqual(again.deal.key, made.deal.key);
      assert.isTrue(made.party.prospect);
      assert.strictEqual(made.deal.party.key, made.party.key);
      assert.deepStrictEqual(made.deal.value, euros(400_000));
      assert.deepStrictEqual(made.deal.owner, asZoya);
      assert.strictEqual(yield* count("clients"), clients + 1);
      assert.strictEqual(yield* count("deals"), 1);
      assert.strictEqual(yield* count("contacts"), 1);
      // A deal refused after its client is written takes the client, and its contact, with it.
      const ghost = { ...input, name: "Invented Ghost Co", clientRequestId: "ghost" };
      assert.strictEqual(
        yield* refusal(
          Clients.createPartyWithDeal([owner], {
            ...ghost,
            deal: { ...ghost.deal, stage: "nope" },
          }),
        ),
        "invalid_state",
      );
      assert.strictEqual(
        yield* refusal(Clients.createPartyWithDeal([dev], { ...ghost, clientRequestId: "dev" })),
        "not_allowed",
      );
      assert.strictEqual(yield* count("clients"), clients + 1);
      assert.strictEqual(yield* count("contacts"), 1);
      assert.strictEqual(yield* count("deals"), 1);
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
      // her page has no quotes to pick from at all, so nothing says there are none.
      yield* sql`UPDATE kin_people SET sees_clients = 1 WHERE person_id = ${zoyaId}`;
      const hers = yield* Deals.deals([zoya], { orgId });
      assert.isUndefined(hers.deals[0]!.quote);
      assert.isUndefined((yield* Deals.page([zoya], { orgId, key: made.deal.key })).quotes);
      // With Money on she picks among those Money shows her.
      yield* sql`UPDATE kin_people SET sees_money = 1 WHERE person_id = ${zoyaId}`;
      assert.deepStrictEqual((yield* Deals.page([zoya], { orgId, key: made.deal.key })).quotes, []);
      yield* sql`UPDATE kin_people SET sees_money = 0 WHERE person_id = ${zoyaId}`;
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

it.effect("a deal is found by its key and its title by whoever sees it, and by nobody else", () =>
  Effect.gen(function* () {
    const { corran, hush } = yield* seed;
    const open = yield* Deals.create(
      [owner],
      newDeal(corran, "Invented scheduling pilot", { owner: asZoya }),
    );
    const kept = yield* Deals.create([owner], newDeal(hush, "Invented confidential pilot"));
    // The phone's Tasks box asks for what is not a task: clients, contacts, projects, docs, deals.
    const elsewhere = { kinds: ["clients", "contacts", "projects", "docs"], deals: true } as const;
    const found = (who: typeof owner, text: string, only: object = {}) =>
      OwnerDocs.search([who], { orgId, text, ...only }).pipe(
        Effect.map((result) => result.hits.map((hit) => `${hit.key} ${hit.kind}: ${hit.snippet}`)),
      );
    // Its stored fields (a stage id, a value in minor units) are no one's words to show.
    const shown = `${open.deal.key} work: Invented scheduling pilot`;
    for (const text of [open.deal.key, open.deal.key.toLowerCase(), "scheduling pilot"]) {
      for (const only of [{}, elsewhere]) {
        assert.deepStrictEqual(yield* found(owner, text, only), [shown], `owner: ${text}`);
        assert.deepStrictEqual(yield* found(zoya, text, only), [shown], `zoya: ${text}`);
        // Dev, with Clients off, sees no deals anywhere.
        assert.deepStrictEqual(yield* found(dev, text, only), [], `dev: ${text}`);
      }
      // Docs' own box finds docs alone.
      assert.deepStrictEqual(yield* found(owner, text, { kinds: ["docs"] }), [], `docs: ${text}`);
    }
    // Under a client kept private, the owner level finds it and a teammate doesn't.
    for (const text of [kept.deal.key, "confidential"]) {
      assert.deepStrictEqual(yield* found(owner, text), [
        `${kept.deal.key} work: Invented confidential pilot`,
      ]);
      assert.deepStrictEqual(yield* found(zoya, text), []);
    }
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

it.effect(
  "numbers: each figure against a hand count on an invented month, in the company's zone, for each role, and Monday's three lines",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The company keeps Auckland time: 1 Nov 01:00 there is still 31 Oct in UTC.
      yield* TestClock.setTime(Date.parse("2026-10-05T00:00:00.000Z"));
      const { brightwater, corran } = yield* seed;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
          dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
        VALUES (${orgId}, 'Pacific/Auckland', '08:00', '18:00', '02:00', 0, 1, '09:00', '[]')`;
      const arjunId = KinPersonId.make("arjun");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access, sees_clients)
        VALUES (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${at}, NULL, 1)`;
      const arjun = { _tag: "person" as const, orgId, personId: arjunId };
      // A company with no deals sees no figures at all.
      assert.isUndefined((yield* Deals.deals([owner], { orgId })).numbers);

      const make = (party: string, title: string, extra: object) =>
        Deals.create([owner], newDeal(party, title, extra)).pipe(Effect.map((made) => made.deal));
      const nok = (minor: number) => ({ minor, currency: "NOK" });
      const stock = yield* make(corran, "Invented stock system", {
        value: euros(1_800_000),
        owner: asZoya,
      });
      yield* make(brightwater, "Invented pilot", { value: nok(24_000_000) });
      const orders = yield* make(corran, "Invented orders app", {
        value: euros(900_000),
        owner: { _tag: "person", personId: arjunId },
      });
      const old = yield* make(corran, "Invented old win", { value: euros(500_000), owner: asZoya });
      yield* make(corran, "Invented private renewal", { value: euros(100_000), sensitive: true });
      const move = (deal: { key: string; rev: number }, to: KinDealMove) =>
        Deals.move([owner], { orgId, key: deal.key, rev: deal.rev, to }).pipe(
          Effect.map((done) => done.deal),
        );
      // Won last month; lost on 1 Nov in Auckland, which is this month there.
      yield* TestClock.setTime(Date.parse("2026-10-20T00:00:00.000Z"));
      yield* move(old, { _tag: "won" });
      yield* TestClock.setTime(Date.parse("2026-10-31T12:00:00.000Z"));
      yield* move(orders, { _tag: "lost", reason: "Invented: went cheaper" });
      // New prospects this month: one from a typed source, one that says nowhere, one from a
      // campaign renamed since, and one from a campaign no longer there.
      yield* TestClock.setTime(Date.parse("2026-11-10T00:00:00.000Z"));
      const expo = yield* Clients.createProject([owner], {
        orgId,
        name: "Invented Fenvale fair",
        campaign: true,
        clientRequestId: "expo",
      });
      for (const [name, source] of [
        ["Invented Halden", "Harbour trade fair"],
        ["Invented Lumen", undefined],
        ["Invented Fenvale Mills", `campaign:${expo.key}`],
        ["Invented Gone Bay", `campaign:${expo.key}`],
        ["Invented Gone Ridge", `campaign:${expo.key}`],
      ] as const)
        yield* Clients.createParty([owner], {
          orgId,
          name,
          clientRequestId: name,
          prospect: true,
          ...(source === undefined ? {} : { source }),
        });
      yield* (yield* KinRecords.KinRecords).update(orgId, OwnerWork.ownerWriter(owner), expo.key, {
        title: "Invented Fenvale Expo",
      });
      // Two campaigns gone read as one row.
      for (const [title, key] of [
        ["Invented Gone Bay", "P-998"],
        ["Invented Gone Ridge", "P-999"],
      ])
        yield* sql`UPDATE kin_records
          SET fields_json = json_set(fields_json, '$.source', ${`campaign:${key}`})
          WHERE org_id = ${orgId} AND title = ${title}`;
      // This week (from Monday 16 Nov there): the stock system moves twice, a new deal is won.
      yield* TestClock.setTime(Date.parse("2026-11-16T00:00:00.000Z"));
      const talks = yield* move(stock, { _tag: "stage", stage: "in-talks" });
      yield* TestClock.adjust("1 hour");
      yield* move(talks, { _tag: "stage", stage: "proposal" });
      const training = yield* Deals.create(
        [zoya],
        newDeal(corran, "Invented training", { value: euros(200_000) }),
      );
      yield* move(training.deal, { _tag: "won" });
      // Its next step's day, 17 Nov, is behind today (18 Nov); the pilot's is today, so not late.
      yield* Deals.step([zoya], {
        orgId,
        key: stock.key,
        step: {
          title: "Invented: send the revised proposal",
          dueAt: "2026-11-17",
          dueAllDay: true,
        },
        clientRequestId: "late",
      });
      const pilot = (yield* Deals.deals([owner], { orgId })).deals.find(
        (deal) => deal.title === "Invented pilot",
      )!;
      yield* Deals.step([owner], {
        orgId,
        key: pilot.key,
        step: { title: "Invented: call Ingrid", dueAt: "2026-11-18", dueAllDay: true },
        clientRequestId: "today",
      });
      // Wednesday 18 Nov, 10:00 in Auckland.
      yield* TestClock.setTime(Date.parse("2026-11-17T21:00:00.000Z"));

      const eur = (count: number, minor: number) => ({
        count,
        values: [{ minor, currency: "EUR" }],
      });
      const none = { count: 0, values: [] };
      const rhea: KinDealNumbers = (yield* Deals.deals([owner], { orgId })).numbers!;
      assert.deepInclude(rhea, {
        month: "2026-11",
        lastMonth: "2026-10",
        weekStart: "2026-11-16",
        open: {
          count: 3,
          values: [
            { minor: 1_900_000, currency: "EUR" },
            { minor: 24_000_000, currency: "NOK" },
          ],
        },
        wonThisMonth: eur(1, 200_000),
        wonLastMonth: eur(1, 500_000),
        lostThisMonth: eur(1, 900_000),
        lostLastMonth: none,
        winRate: { won: 2, decided: 3 },
        sources: [
          { source: "A campaign that was removed", count: 2 },
          { source: null, count: 1 },
          { source: "Harbour trade fair", count: 1 },
          { source: "Invented Fenvale Expo", count: 1 },
        ],
        late: 1,
      });
      assert.deepStrictEqual(
        rhea.stages.map((stage) => [stage.name, stage.count]),
        [
          ["New", 2],
          ["In talks", 0],
          ["Proposal", 1],
          ["Deciding", 0],
        ],
      );
      assert.deepStrictEqual(rhea.week!.counts, { won: 1, lost: 0, new: 1, moved: 1 });
      assert.deepInclude(rhea.week!.moved[0]!, {
        title: "Invented stock system",
        from: "New",
        to: "Proposal",
      });
      assert.deepStrictEqual(
        rhea.week!.won.map((row) => row.title),
        ["Invented training"],
      );
      assert.deepStrictEqual(rhea.people, [
        {
          owner: { _tag: "person", personId: ownerId },
          open: {
            count: 2,
            values: [
              { minor: 100_000, currency: "EUR" },
              { minor: 24_000_000, currency: "NOK" },
            ],
          },
          wonThisMonth: none,
          late: 0,
        },
        { owner: asZoya, open: eur(1, 1_800_000), wonThisMonth: eur(1, 200_000), late: 1 },
        // Arjun's only deal was lost this month: he keeps his row, at zero.
        { owner: { _tag: "person", personId: arjunId }, open: none, wonThisMonth: none, late: 0 },
      ]);

      // Zoya sells: the team's open and won this month as she sees them, her own row and week.
      const hers = (yield* Deals.deals([zoya], { orgId })).numbers!;
      assert.deepStrictEqual(hers.open, {
        count: 2,
        values: [
          { minor: 1_800_000, currency: "EUR" },
          { minor: 24_000_000, currency: "NOK" },
        ],
      });
      assert.deepStrictEqual(hers.wonThisMonth, eur(1, 200_000));
      assert.deepStrictEqual(hers.people, [
        { owner: asZoya, open: eur(1, 1_800_000), wonThisMonth: eur(1, 200_000), late: 1 },
      ]);
      assert.deepStrictEqual(hers.week!.counts, { won: 1, lost: 0, new: 1, moved: 1 });
      for (const owners of [
        "wonLastMonth",
        "lostThisMonth",
        "lostLastMonth",
        "winRate",
        "sources",
        "late",
      ])
        assert.notProperty(hers, owners);
      // Arjun sells and has nothing open: his own row is zeros, nobody else's shows.
      const his = (yield* Deals.deals([arjun], { orgId })).numbers!;
      assert.deepStrictEqual(his.people, [
        { owner: { _tag: "person", personId: arjunId }, open: none, wonThisMonth: none, late: 0 },
      ]);
      assert.deepStrictEqual(his.week!.counts, { won: 0, lost: 0, new: 0, moved: 0 });
      // Dev, Clients off: refused, as every deals read is.
      assert.strictEqual(yield* refusal(Deals.deals([dev], { orgId })), "not_allowed");
      // A client's own deals carry no figures.
      assert.isUndefined((yield* Deals.deals([owner], { orgId, party: corran })).numbers);

      // Monday's page: the same while the switch is off, three lines while it is on.
      const now = yield* Clock.currentTimeMillis;
      const before = yield* weeklyFigures({ orgId, now });
      assert.notInclude(before, "Pipeline:");
      yield* setWeeklyPipeline(orgId, true, now);
      const lines = yield* pipelineLines(orgId, now - 7 * 86_400_000, now);
      // Two currencies with no rate: each stands alone. Last week's are all in one: no estimate.
      assert.deepStrictEqual(lines, [
        "Pipeline: €19,000 open in 2 deals, and NOK\u00a0240,000 in 1.",
        "Last week: won 1 for €2,000, lost 0; 1 new deal.",
        "Follow-ups late: 1 (Zoya 1).",
      ]);
      const on = yield* weeklyFigures({ orgId, now });
      assert.include(on, lines.join("\n"));
      assert.strictEqual(on.replace(`\n\n${lines.join("\n")}`, ""), before);
      // Off again: the next Monday is byte for byte what it was.
      yield* setWeeklyPipeline(orgId, false, now);
      assert.strictEqual(yield* weeklyFigures({ orgId, now }), before);
      // With euros at home and a krone rate, the krone line says what it is about, and as of when.
      yield* setProfile(
        orgId,
        { _tag: "person", personId: ownerId },
        { homeCurrency: "EUR", rates: [{ currency: "NOK", rate: "0.0846", asOf: "2026-11-17" }] },
        undefined,
      );
      assert.strictEqual(
        (yield* pipelineLines(orgId, now - 7 * 86_400_000, now))[0],
        "Pipeline: €19,000 open in 2 deals, and NOK\u00a0240,000 in 1 (about €20,304 at your rate of 17 Nov).",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a leaver's hand-over moves every kind and logs it, all or nothing, only by the owner level and only to someone who can hold them",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const records = yield* KinRecords.KinRecords;
      const { brightwater, corran, hush, supplies } = yield* seed;
      const arjunId = KinPersonId.make("arjun");
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
          access, sees_clients) VALUES (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${at}, NULL, 1)`;
      const byOwner = {
        actor: { _tag: "person" as const, personId: ownerId },
        via: "owner" as const,
      };
      const toZoya = { _tag: "person" as const, personId: zoyaId };
      for (const key of [brightwater, corran, supplies])
        yield* records.update(orgId, byOwner, key, { owner: toZoya });
      const deal = (yield* Deals.create([owner], newDeal(corran, "Invented stock system"))).deal;
      // Only the owner level sees Hush: Zoya's deal there can't go to Arjun.
      const hushDeal = (yield* Deals.create([owner], newDeal(hush, "Invented hush refit"))).deal;
      for (const key of [deal.key, hushDeal.key])
        yield* records.update(orgId, { ...byOwner, deal: true }, key, { owner: toZoya });
      const party = (yield* records.get(orgId, corran))!.recordId;
      const task = (title: string, extra: object) =>
        records
          .create(orgId, byOwner, { title, owner: toZoya, originKey: title, ...extra })
          .pipe(Effect.map((made) => made.row.key));
      const followUp = yield* task("Invented: call Corran back", { partyId: party });
      const promise = yield* task("Invented: send the revised quote", { category: "obligation" });
      const own = yield* task("Invented: tidy the shared drive", {});
      yield* sql`UPDATE kin_people SET removed_at = 1 WHERE person_id = ${zoyaId}`;

      const handOver = (by: KinPersonId, to: KinPersonId) =>
        sql.withTransaction(Deals.handOverLeaver({ orgId, by, from: zoyaId, to }));
      const message = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (isChatError(error) ? error.message : "not a refusal")),
        );
      assert.deepStrictEqual(yield* Deals.leaverHeld(orgId, zoyaId), {
        deals: 2,
        prospects: 1,
        clients: 1,
        followUps: 1,
        promises: 1,
      });
      assert.strictEqual(
        yield* message(handOver(arjunId, arjunId)),
        "Only the owner or a co-owner gives away what someone who left looked after.",
      );
      assert.strictEqual(
        yield* message(handOver(ownerId, devId)),
        "Dev can't take them: Clients is off for Dev. Give them to the owner, a co-owner or someone with Clients on.",
      );
      const ownersOf = (keys: ReadonlyArray<string>) =>
        Effect.forEach(keys, (key) =>
          records.get(orgId, key).pipe(Effect.map((row) => row?.ownerId)),
        );
      const moving = [brightwater, corran, deal.key, hushDeal.key, followUp, promise];
      // The Hush deal is refused after the clients moved: nothing moves.
      assert.match(yield* message(handOver(ownerId, arjunId)), /^Arjun can't see DL-/);
      assert.deepStrictEqual(
        yield* ownersOf(moving),
        moving.map(() => zoyaId),
      );

      yield* records.update(orgId, { ...byOwner, deal: true }, hushDeal.key, {
        owner: { _tag: "person", personId: ownerId },
      });
      assert.deepStrictEqual(yield* handOver(ownerId, arjunId), {
        deals: 1,
        prospects: 1,
        clients: 1,
        followUps: 1,
        promises: 1,
      });
      const moved = moving.filter((key) => key !== hushDeal.key);
      assert.deepStrictEqual(
        yield* ownersOf(moved),
        moved.map(() => arjunId),
      );
      // Her own task and the vendor are not a client's: they stay hers.
      assert.deepStrictEqual(yield* ownersOf([own, supplies]), [zoyaId, zoyaId]);
      const lines = yield* sql<{ key: string; actor: string; fields: string }>`SELECT r.key,
          c.actor_id AS actor, c.fields_json AS fields FROM kin_record_changes c
        JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
        WHERE c.org_id = ${orgId} AND c.fields_json LIKE ${`%${KIN_LEFT_FIELD}%`}
        ORDER BY r.key`;
      assert.deepStrictEqual(
        lines.map((line) => line.key),
        [...moved].sort(),
      );
      for (const line of lines) {
        assert.strictEqual(line.actor, ownerId);
        assert.deepInclude(JSON.parse(line.fields), {
          field: "owner",
          from: `person:${zoyaId}`,
          to: `person:${arjunId}`,
        });
        assert.deepInclude(JSON.parse(line.fields), {
          field: KIN_LEFT_FIELD,
          from: `person:${zoyaId}`,
          to: null,
        });
      }
    }).pipe(Effect.provide(layer)),
);
