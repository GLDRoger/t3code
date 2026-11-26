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
  it.effect("keeps live work and status out of the standing key and lists them now", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orgId = KinOrgId.make("org-tidewater");
      const at = "2026-11-27T06:30:00.000Z";
      yield* sql`INSERT INTO kin_orgs VALUES (${orgId}, 'Tidewater Freight', ${at})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
          role_tags_json, time_zone, work_hours_json)
        VALUES ('person-rhea', ${orgId}, 'rhea', 'Rhea Kapoor', ${at}, 'owner', '[]', NULL, NULL),
          ('person-arjun', ${orgId}, 'arjun', 'Arjun Rao', ${at}, 'member', '["engineering"]',
            'Asia/Kolkata', '{"days":[1,2,3,4,5],"start":"09:00","end":"18:00"}')`;
      yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
        VALUES ('session-rhea', ${orgId}, 'person-rhea', ${at}),
          ('session-arjun', ${orgId}, 'person-arjun', ${at})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${orgId}, 'work', 'Work', 'W', 1, 0), (${orgId}, 'projects', 'Projects', 'P', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
          owner_id, sensitive, due_at, created_by_kind, created_by_id, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'rec-arjun-manifest', 'work', 'W-7', 'Audit the Tidewater Freight port manifest',
          'doing', 'person', 'person-arjun', 0, ${Date.parse(at) - 1}, 'person', 'person-rhea',
          'owner:manifest', 0, 0),
          (${orgId}, 'rec-port-sync', 'projects', 'P-1', 'Tidewater Freight port sync', 'open', 'person',
            'person-arjun', 0, NULL, 'person', 'person-rhea', 'owner:port-sync', 0, 0)`;
      const seat = (now: number) =>
        buildSeat({ orgId, agentId: KinAgentId.make("chief"), ownerOnly: true, now, memory: [] });
      const first = yield* seat(Date.parse(at));
      const arjun = first.team.find((line) => line.startsWith('- "Arjun Rao":'));
      expect(arjun).toBe(
        '- "Arjun Rao": member, engineering, leads Tidewater Freight port sync; ' +
          'Mon–Fri 09:00–18:00 Asia/Kolkata, working now; 1 open, 1 late; on "Audit the Tidewater Freight port manifest"',
      );
      expect(first.keys.team).toContain(
        '- "Arjun Rao": member, engineering; Mon–Fri 09:00–18:00 Asia/Kolkata',
      );
      expect(first.now).toContain(
        '- "Arjun Rao": leads Tidewater Freight port sync; working now; 1 open, 1 late; on "Audit the Tidewater Freight port manifest"',
      );
      expect(first.seat[0]).toBe("- You hold 0 open.");
      expect(first.keys.seat).not.toContain(first.seat[0]);
      expect(first.now[0]).toBe("- You: 0 open");

      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
          owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at)
        VALUES (${orgId}, 'rec-arjun-dispatch', 'work', 'W-8', 'Check the dispatch book', 'open',
          'person', 'person-arjun', 'person', 'person-rhea', 'owner:dispatch', 0, 0)`;
      const later = yield* seat(Date.parse("2026-11-27T14:00:00.000Z"));
      expect(later.keys).toEqual(first.keys);
      expect(later.team).not.toEqual(first.team);
      expect(later.now).toContain(
        '- "Arjun Rao": leads Tidewater Freight port sync; off now; 2 open, 1 late; on "Audit the Tidewater Freight port manifest"',
      );
    }).pipe(Effect.provide(Persistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});
