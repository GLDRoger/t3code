import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
import * as Provision from "../lead/KinLeadProvision.ts";
import { setProfile } from "../work/companyProfile.ts";
import { KinIdentity } from "./KinIdentity.ts";
import * as RefreshHub from "./KinRefreshHub.ts";
import { subscribeRefreshes } from "./refreshes.ts";

const layer = Layer.mergeAll(Provision.layer, RetiredActions.hostLayer).pipe(
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest({})),
);
const paired = Layer.effectDiscard(pairSession("phone")).pipe(Layer.provideMerge(layer));
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
  models: {
    strong: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
    cheap: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-4-5" },
  },
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
    "tells a teammate only about their own lead list and the time zone, never the owner's reads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner: me } = yield* KinIdentity;
        const finance = (yield* Provision.create(lead("Finance", "finance"))).lead;
        const tech = (yield* Provision.create(lead("Tech", "engineering"))).lead;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('priya', ${me.orgId}, 'priya', 'Priya', '2026-11-09T00:00:00.000Z')`;
        const priya = { ...me, personId: KinPersonId.make("priya") };
        const ownerSees = yield* Stream.toQueue(subscribeRefreshes([me], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const priyaSees = yield* Stream.toQueue(subscribeRefreshes([priya], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const start = yield* Queue.take(ownerSees);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), { timeZone: 0, leads: 0 });

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

        // Priya may now message Finance: her list changed, so hers is the next thing she hears.
        yield* Provision.allow({
          editor: owner,
          orgId: me.orgId,
          agentId: finance.agentId,
          personId: priya.personId,
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), { timeZone: 0, leads: 1 });
        assert.strictEqual(yield* Queue.size(priyaSees), 0);
      }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  // Every write to a table behind one of these reads is in a file that tells the hub. A new file
  // that writes one fails here until it touches the topic and is listed.
  it("finds no write to a refreshed table outside the files that touch its topic", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const writers: Record<string, ReadonlyArray<string>> = {
      kin_company_profile: ["work/companyProfile.ts"],
      kin_recipe_defaults: ["gendocs/recipeDefaults.ts"],
      kin_recipe_labels: ["gendocs/recipeLabels.ts"],
      kin_memory_heads: ["memory/Memory.ts"],
      // Binding a suggestion as it is shown, in `bindSuggestions`, is part of reading the list.
      kin_memory_labels: ["memory/sensitivity.ts"],
      // The repository writes only the first-start owner, before any client, and test seeds.
      kin_people: ["people/KinPeople.ts", "chat/KinChatRepository.ts"],
      kin_people_invites: ["people/KinPeople.ts"],
      kin_session_bindings: ["people/KinPeople.ts"],
      // The runner's thread and the hidden level are never part of a lead's list.
      kin_leads: ["lead/KinLeadProvision.ts", "lead/WakeupRunner.ts", "lead/KinLevels.ts"],
      kin_lead_access: ["lead/KinLeadProvision.ts", "people/KinPeople.ts"],
      kin_trigger_settings: ["triggers/routines.ts"],
      kin_visual_hosts: ["chat/KinVisualHosts.ts"],
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
