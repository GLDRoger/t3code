// @effect-diagnostics nodeBuiltinImport:off -- the guard reads source files synchronously, outside any Effect.
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_STREAMS,
  AuthSessionId,
  AuthStandardClientScopes,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as RetiredActions from "../approvals/retiredActions.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Provision from "../lead/KinLeadProvision.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { newCompanyProfileJson, setProfile } from "../work/companyProfile.ts";
import { KinIdentity } from "./KinIdentity.ts";
import * as RefreshHub from "./KinRefreshHub.ts";
import { announceRefreshes, subscribeRefreshes } from "./refreshes.ts";

const layer = Layer.mergeAll(Provision.layer, RetiredActions.hostLayer).pipe(
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest({})),
);
const paired = Layer.effectDiscard(pairSession("phone")).pipe(Layer.provideMerge(layer));
const withRecords = KinRecords.layer.pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(paired),
);
const owner: Provision.LeadCreator = {
  _tag: "session",
  session: {
    sessionId: AuthSessionId.make("phone"),
    subject: "phone",
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
  },
};
const lead = (name: string, domain: string) => ({
  creator: owner,
  name,
  domain,
  charter: "",
  model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
  workerProjects: [],
});
const watch = (orgId: KinOrgId) =>
  Effect.gen(function* () {
    const hub = yield* RefreshHub.KinRefreshHub;
    const queue = yield* Stream.toQueue(hub.changes(orgId), { capacity: "unbounded" });
    return { queue, first: yield* Queue.take(queue) };
  });

describe("KinRefreshHub", () => {
  it.effect("moves a topic once per commit, and not for a rollback or another org", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { touch } = yield* RefreshHub.KinRefreshObserver;
      const orgId = KinOrgId.make("org");
      const { queue, first } = yield* watch(orgId);
      assert.strictEqual(first.company, 0);
      yield* sql
        .withTransaction(touch(orgId, "company").pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.flip);
      yield* touch(KinOrgId.make("other"), "company");
      yield* sql.withTransaction(
        Effect.all([touch(orgId, "company"), touch(orgId, "company"), touch(orgId, "memory")]),
      );
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      const next = yield* Queue.take(queue);
      assert.deepInclude(next, { company: 1, memory: 1, people: 0 });
      assert.strictEqual(yield* Queue.size(queue), 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("turns a burst of hundreds of commits into one change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { touch } = yield* RefreshHub.KinRefreshObserver;
      const orgId = KinOrgId.make("org");
      const { queue } = yield* watch(orgId);
      for (let row = 0; row < 300; row += 1)
        yield* sql.withTransaction(touch(orgId, row % 2 === 0 ? "memory" : "recipes"));
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), { memory: 150, recipes: 150 });
      assert.strictEqual(yield* Queue.size(queue), 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "tells a teammate only about their own lead list, people, the time zone, the lists she sees and what needs attention, never the owner's reads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner: me } = yield* KinIdentity;
        const finance = (yield* Provision.create(lead("Finance", "finance"))).lead;
        const tech = (yield* Provision.create(lead("Tech", "engineering"))).lead;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('priya', ${me.orgId}, 'priya', 'Priya', '2026-11-09T00:00:00.000Z')`;
        const priya = { ...me, personId: KinPersonId.make("priya") };
        // A company created now, its country not chosen yet.
        yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
            updated_by_kind, updated_by_id)
          VALUES (${me.orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${me.personId})`;
        const { boot } = yield* RefreshHub.KinRefreshHub;
        const ownerSees = yield* Stream.toQueue(subscribeRefreshes([me], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const priyaSees = yield* Stream.toQueue(subscribeRefreshes([priya], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const start = yield* Queue.take(ownerSees);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), {
          timeZone: 0,
          people: 0,
          leads: 0,
          pulse: 0,
          workLists: 0,
          company: 0,
          boot,
          streams: KIN_STREAMS,
        });

        // Things only the owner reads: the company, and a lead Priya can't message.
        yield* setProfile(
          me.orgId,
          { _tag: "person", personId: me.personId },
          { legalName: "Acme Tools" },
          0,
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        yield* Provision.update({
          editor: owner,
          orgId: me.orgId,
          agentId: tech.agentId,
          fields: { charter: "Private: the Acme migration." },
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          company: (start.company ?? 0) + 1,
          leads: start.leads,
        });
        assert.deepInclude(yield* Queue.take(ownerSees), { leads: (start.leads ?? 0) + 1 });
        // A list definition she sees no entry of, such as a money list the owner renamed.
        yield* sql.withTransaction(
          (yield* RefreshHub.KinRefreshObserver).touch(me.orgId, "workLists"),
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          workLists: (start.workLists ?? 0) + 1,
        });

        // Priya may now message Finance: her list changed, so hers is the next thing she hears.
        yield* Provision.allow({
          editor: owner,
          orgId: me.orgId,
          agentId: finance.agentId,
          personId: priya.personId,
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        const moved = {
          timeZone: 0,
          people: 0,
          leads: 1,
          pulse: 0,
          workLists: 0,
          company: 0,
          boot,
          streams: KIN_STREAMS,
        };
        assert.deepStrictEqual(yield* Queue.take(priyaSees), moved);
        assert.strictEqual(yield* Queue.size(priyaSees), 0);
        // Her reconnect with nothing moved since hears the same numbers, so she reads nothing again.
        const again = yield* Stream.toQueue(subscribeRefreshes([priya], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        assert.deepStrictEqual(yield* Queue.take(again), moved);
        // The country chosen, her company topic moves once, so her Money step clears.
        yield* setProfile(
          me.orgId,
          { _tag: "person", personId: me.personId },
          { country: "GB" },
          undefined,
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), { ...moved, company: 1 });
      }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  it.effect("moves the lists a new company made while waiting when its country is saved", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { owner: me } = yield* KinIdentity;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${me.orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${me.personId})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json, rev)
        VALUES (${me.orgId}, 'expenses', 'Expenses', 'EXP', 0, 0,
          ${JSON.stringify({ currency: "INR", currencyPending: true })}, 1)`;
      const { queue, first } = yield* watch(me.orgId);
      yield* setProfile(
        me.orgId,
        { _tag: "person", personId: me.personId },
        { country: "GB" },
        undefined,
      );
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), {
        company: (first.company ?? 0) + 1,
        workLists: (first.workLists ?? 0) + 1,
      });
    }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  it.effect(
    "refuses to start Kin's services on the no-op observer, which would drop every notice",
    () =>
      Effect.gen(function* () {
        const bare = yield* Effect.exit(RefreshHub.requireRefreshObserver(Context.empty()));
        assert.isTrue(Exit.hasDies(bare));
        const wired = yield* Effect.context<never>();
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(RefreshHub.requireRefreshObserver(wired))));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "moves Work choices when a client changes, and takes the owner's word for another process's writes",
    () =>
      Effect.gen(function* () {
        const { owner: me } = yield* KinIdentity;
        const records = yield* KinRecords.KinRecords;
        const ownerSees = yield* Stream.toQueue(subscribeRefreshes([me], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const work = yield* Stream.toQueue(records.changes(me.orgId), { capacity: "unbounded" });
        const start = yield* Queue.take(ownerSees);
        const first = yield* Queue.take(work);
        yield* records.create(
          me.orgId,
          { actor: { _tag: "system" }, via: "import" },
          {
            list: "clients",
            title: "Invented Acme",
            owner: { _tag: "person", personId: me.personId },
            originKey: "acme",
          },
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          workChoices: (start.workChoices ?? 0) + 1,
        });
        const created = yield* Queue.take(work);
        assert.isAbove(created.seq, first.seq);
        assert.strictEqual(created.key, "C-1");

        // What the `kin` CLI wrote in its own process reaches these listeners through the owner.
        yield* announceRefreshes([me], {
          orgId: me.orgId,
          topics: ["leads", "workChoices", "leads"],
          records: true,
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          leads: (start.leads ?? 0) + 1,
          workChoices: (start.workChoices ?? 0) + 2,
        });
        const announced = yield* Queue.take(work);
        assert.strictEqual(announced.seq, created.seq + 1);
        // Everyone's own number moves too, so a viewer who resumes later reads again.
        assert.deepStrictEqual([...(announced.team?.keys() ?? [])], [me.personId]);
        const someone = { ...me, personId: KinPersonId.make("someone") };
        assert.include(
          yield* announceRefreshes([someone], {
            orgId: me.orgId,
            topics: ["leads"],
            records: true,
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        assert.strictEqual(yield* Queue.size(work), 0);
      }).pipe(Effect.scoped, Effect.provide(withRecords)),
  );

  // Every write to a table behind one of these reads is in a file that tells the hub. A new file
  // that writes one fails here until it touches the topic and is listed.
  it("finds no write to a refreshed table outside the files that touch its topic", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const writers: Record<string, ReadonlyArray<string>> = {
      // The repository writes only a new company's first profile, at first start, before any client.
      kin_company_profile: ["work/companyProfile.ts", "chat/KinChatRepository.ts"],
      kin_recipe_defaults: ["gendocs/recipeDefaults.ts"],
      kin_recipe_labels: ["gendocs/recipeLabels.ts"],
      kin_memory_heads: ["memory/Memory.ts"],
      // Binding a suggestion as it is shown, in `bindSuggestions`, is part of reading the list.
      kin_memory_labels: ["memory/sensitivity.ts"],
      // The repository writes only the first-start owner, before any client, and test seeds.
      kin_people: [
        "people/KinPeople.ts",
        "chat/KinChatRepository.ts",
        "lead/peopleUpdate.ts",
        "lead/awaySet.ts",
      ],
      // A sign-out's cascade (auth/linkedDevices.ts) runs in the session store, below Kin's hub.
      // Kin's Remove touches the topic itself; one from Sharing & access shows at the next read,
      // and the signed-out devices' sockets close at once.
      kin_people_invites: ["people/KinPeople.ts", "auth/linkedDevices.ts"],
      kin_session_bindings: ["people/KinPeople.ts", "auth/linkedDevices.ts"],
      // The runner's thread and the hidden level are never part of a lead's list.
      kin_leads: ["lead/KinLeadProvision.ts", "lead/WakeupRunner.ts", "lead/KinLevels.ts"],
      kin_lead_access: ["lead/KinLeadProvision.ts", "people/KinPeople.ts"],
      kin_team_agents: ["lead/KinLeadProvision.ts"],
      kin_trigger_settings: ["triggers/routines.ts"],
      kin_visual_hosts: ["chat/KinVisualHosts.ts"],
      kin_money_budgets: ["work/budgets.ts"],
      // A key's last use, written as the key is admitted, shows at the next read.
      kin_tasks_keys: ["tasksKey/TasksKeys.ts", "people/KinPeople.ts"],
    };
    const write = new RegExp(
      `(?:INSERT INTO|UPDATE|DELETE FROM)\\s+(${Object.keys(writers).join("|")})\\b`,
      "g",
    );
    const found: Array<string> = [];
    for (const file of NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || /\.test\.ts$|\.testkit\.ts$|migrations\//.test(file)) continue;
      for (const match of NodeFS.readFileSync(NodePath.join(root, file), "utf8").matchAll(write))
        if (!writers[match[1]!]!.includes(file)) found.push(`${file}: ${match[1]}`);
    }
    assert.deepStrictEqual(found, []);
  });
});
