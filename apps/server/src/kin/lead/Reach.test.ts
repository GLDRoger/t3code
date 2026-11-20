import { assert, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as Reach from "./Reach.ts";

const at = "2026-11-20T00:00:00.000Z";
const orgId = KinOrgId.make("ambermill");
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);
const p = (id: string) => Reach.person(KinPersonId.make(id));
const a = (id: string) => Reach.agent(KinAgentId.make(id));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const org of ["ambermill", "other"])
    yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${org}, ${org}, ${at})`;
  for (const [personId, org, access] of [
    ["rhea", "ambermill", "owner"],
    ["meera", "ambermill", "co_owner"],
    ["dev", "ambermill", "member"],
    ["zoya", "ambermill", "member"],
    ["arjun", "ambermill", "member"],
    ["stranger", "other", "member"],
  ] as const)
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES (${personId}, ${org}, ${personId}, ${personId}, ${at}, ${access})`;
  for (const agentId of ["chief", "finance"])
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agentId}, 'ambermill', ${agentId}, 'lead', 'rhea', ${at})`;
  return sql;
});

it.effect(
  "mayReach: everyone reaches everyone but a restricted pair, both ways, until it is lifted",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed;
      const reach = (x: Reach.KinParty, y: Reach.KinParty) => Reach.mayReach(orgId, x, y);
      const limit = (by: string, x: Reach.KinParty, y: Reach.KinParty, restricted = true) =>
        Reach.setLimit({ orgId, by: KinPersonId.make(by), a: x, b: y, restricted });
      // Open by default: a teammate and any agent, two teammates, a co-owner, two agents.
      for (const [x, y] of [
        [p("dev"), a("finance")],
        [a("chief"), p("zoya")],
        [p("dev"), p("zoya")],
        [p("meera"), a("finance")],
        [a("chief"), a("finance")],
      ] as const)
        assert.strictEqual(yield* reach(x, y), "allowed");
      assert.strictEqual(yield* reach(p("dev"), p("dev")), "self");
      assert.strictEqual(yield* reach(p("dev"), p("stranger")), "unknown");
      assert.strictEqual(yield* reach(p("dev"), a("nobody")), "unknown");

      // A restriction holds both ways, by whichever side asks.
      assert.deepStrictEqual(yield* limit("meera", p("dev"), a("finance")), { _tag: "changed" });
      assert.strictEqual(yield* reach(p("dev"), a("finance")), "restricted");
      assert.strictEqual(yield* reach(a("finance"), p("dev")), "restricted");
      assert.strictEqual(yield* reach(p("dev"), a("chief")), "allowed");
      assert.deepStrictEqual(yield* limit("rhea", a("finance"), p("dev")), { _tag: "unchanged" });
      assert.deepStrictEqual(yield* limit("rhea", p("zoya"), p("dev")), { _tag: "changed" });
      assert.strictEqual(yield* reach(p("dev"), p("zoya")), "restricted");

      // Only owner-level people set or lift one, and never on someone who reads everything.
      assert.include(yield* limit("dev", p("arjun"), a("finance")), {
        _tag: "refused",
        reason: "not_allowed",
      });
      assert.deepStrictEqual(yield* limit("rhea", p("meera"), a("finance")), {
        _tag: "refused",
        reason: "not_allowed",
        message: Reach.UNRESTRICTABLE,
      });
      assert.deepStrictEqual(yield* limit("meera", p("rhea"), a("chief")), {
        _tag: "refused",
        reason: "not_allowed",
        message: Reach.UNRESTRICTABLE,
      });
      assert.include(yield* limit("rhea", a("chief"), a("finance")), { reason: "not_found" });
      assert.include(yield* limit("rhea", p("dev"), p("stranger")), { reason: "not_found" });
      // A restriction stored before someone became a co-owner no longer binds them.
      yield* limit("rhea", p("arjun"), a("chief"));
      yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = 'arjun'`;
      assert.strictEqual(yield* reach(p("arjun"), a("chief")), "allowed");
      yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'arjun'`;
      assert.strictEqual(yield* reach(p("arjun"), a("chief")), "restricted");

      // Lifting reopens the pair; the lifted row stays, and a new restriction is a new row.
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* limit("rhea", a("finance"), p("dev"), false), {
        _tag: "changed",
      });
      assert.strictEqual(yield* reach(p("dev"), a("finance")), "allowed");
      assert.deepStrictEqual(yield* limit("rhea", p("dev"), a("finance"), false), {
        _tag: "unchanged",
      });
      yield* TestClock.adjust("1 minute");
      yield* limit("meera", p("dev"), a("finance"));
      assert.deepStrictEqual(
        yield* sql`SELECT set_by_person_id AS "by", lifted_by_person_id AS lifted
          FROM kin_reach_limits WHERE one_id = 'finance' AND other_id = 'dev' ORDER BY set_at`,
        [
          { by: "meera", lifted: "rhea" },
          { by: "meera", lifted: null },
        ],
      );
      assert.deepStrictEqual(
        (yield* Reach.liveLimits(orgId)).map((row) => [row.oneId, row.otherId]).toSorted(),
        [
          ["chief", "arjun"],
          ["dev", "zoya"],
          ["finance", "dev"],
        ],
      );

      // Lifted and restricted again in the same moment: restricted.
      yield* limit("rhea", p("dev"), p("zoya"), false);
      assert.deepStrictEqual(yield* limit("rhea", p("dev"), p("zoya")), { _tag: "changed" });
      assert.strictEqual(yield* reach(p("zoya"), p("dev")), "restricted");

      // Someone removed, or an agent retired, is reached by no one.
      yield* sql`UPDATE kin_people SET removed_at = 1 WHERE person_id = 'zoya'`;
      assert.strictEqual(yield* reach(a("chief"), p("zoya")), "removed");
      yield* sql`UPDATE kin_agents SET retired_at = ${at} WHERE agent_id = 'chief'`;
      assert.strictEqual(yield* reach(p("dev"), a("chief")), "removed");
    }).pipe(Effect.provide(layer)),
);
