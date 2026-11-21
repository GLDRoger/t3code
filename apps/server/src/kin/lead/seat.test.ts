import { assert, describe, expect, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, type MemoryItemHead } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Persistence from "../persistence/KinPersistence.ts";
import { buildSeat, positionsLine } from "./seat.ts";

const position = (recorded_at: string) =>
  ({ title: "Invented: ship the booking screens first", recorded_at }) as MemoryItemHead;

describe("positionsLine", () => {
  it.each([
    ["2026-11-20T03:00:00.000Z", "America/Los_Angeles", "2026-11-19"],
    ["2026-11-20T12:30:00.000Z", "Pacific/Auckland", "2026-11-21"],
    ["2026-11-20", "Pacific/Auckland", "2026-11-20"],
  ])("dates a position taken at %s on the company's day in %s", (at, zone, day) => {
    expect(positionsLine([position(at)], zone)).toBe(
      `- Your positions: "Invented: ship the booking screens first" (${day}).`,
    );
  });
});

describe("buildSeat", () => {
  it.effect("says how many people the People list leaves out, and where to read them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orgId = KinOrgId.make("org-ambermill");
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Ambermill', '2026-11-15T00:00:00.000Z')`;
      for (let index = 0; index < 27; index++) {
        const id = `person-${String(index).padStart(2, "0")}`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
          VALUES (${id}, ${orgId}, ${id}, ${`Teammate ${String(index).padStart(2, "0")}`},
            '2026-11-15T00:00:00.000Z', ${index === 0 ? "owner" : "member"})`;
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
          VALUES (${`session-${id}`}, ${orgId}, ${id}, '2026-11-15T00:00:00.000Z')`;
      }
      const seat = (ownerOnly: boolean) =>
        buildSeat({ orgId, agentId: KinAgentId.make("finance"), ownerOnly, now: 0, memory: [] });
      const { team } = yield* seat(false);
      assert.lengthOf(team, 26);
      assert.strictEqual(team.at(-1), "- 2 more: people_read lists everyone.");
      yield* sql`UPDATE kin_people SET removed_at = '2026-11-16T00:00:00.000Z'
        WHERE person_id IN ('person-25', 'person-26')`;
      assert.notInclude((yield* seat(true)).team.join("\n"), "more: people_read");
    }).pipe(Effect.provide(Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});
