import { assert, describe, it } from "@effect/vitest";
import { KinAgentId, KinOrgId, KinPersonId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { setAway } from "./awaySet.ts";

const orgId = KinOrgId.make("ambermill");
const agentId = KinAgentId.make("chief");
const at = "2026-11-18T00:00:00.000Z";
// Wednesday 18 Nov 2026, 11:30 in Zoya's Kolkata.
const NOW = Date.UTC(2026, 10, 18, 6);
const layer = Layer.provideMerge(KinPersistence.layer, Sqlite.layerMemory);

const message = (chatId: string, messageId: string, extra: Record<string, unknown> = {}) => ({
  _tag: "chat.message",
  chatId,
  messageId,
  provenance: { _tag: "human", personId: "zoya", memberId: "member-zoya-own" },
  ...extra,
});
/** What wakes each turn: Zoya's own words in her own chat, and the ways that are not that. */
const TURNS: Record<string, ReadonlyArray<Record<string, unknown>>> = {
  own: [message("zoya-chief", "zoya-own")],
  group: [message("group", "zoya-group")],
  passedOn: [
    message("zoya-chief", "zoya-own", { origin: { chatId: "group", agentId: "finance" } }),
  ],
  copy: [message("zoya-chief", "zoya-copy")],
  routine: [{ _tag: "routine", routine: "morning_brief", provenance: { _tag: "system" } }],
  deferral: [
    {
      _tag: "deferral.due",
      subject: { type: "reminder", itemId: "item-1" },
      lateByMs: 0,
      provenance: { _tag: "system" },
      origin: { chatId: "zoya-chief", agentId: "chief", personId: "zoya" },
    },
  ],
  reaction: [{ ...message("zoya-chief", "zoya-own"), _tag: "chat.reaction", emoji: "👍" }],
  twoSpeakers: [message("zoya-chief", "zoya-own"), message("rhea-chief", "rhea-own")],
  owner: [message("rhea-chief", "rhea-own")],
};

/** One lead runs one turn at a time: the one `name` names. */
const setup = Effect.fn(function* (name: keyof typeof TURNS) {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES (${orgId}, 'Ambermill', ${at})`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, access, created_at, time_zone) VALUES
    ('rhea', ${orgId}, 'rhea', 'Rhea Kapoor', 'owner', ${at}, NULL),
    ('zoya', ${orgId}, 'zoya', 'Zoya Sheikh', 'member', ${at}, 'Asia/Kolkata'),
    ('arjun', ${orgId}, 'arjun', 'Arjun Rao', 'member', ${at}, NULL)`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${agentId}, ${orgId}, 'Chief of staff', 'lead', 'rhea', ${at})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at, direct_key) VALUES
    ('rhea-chief', ${orgId}, 'direct', 0, ${at}, 'rhea:chief'),
    ('zoya-chief', ${orgId}, 'direct', 0, ${at}, 'zoya:chief'),
    ('group', ${orgId}, 'team_group', 0, ${at}, NULL)`;
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${orgId}, 'Chief of staff', 'L1', 0, 'chief-thread', '{}', '[]', 'rhea-chief')`;
  for (const [member, chat, person] of [
    ["member-rhea-own", "rhea-chief", "rhea"],
    ["member-zoya-own", "zoya-chief", "zoya"],
    ["member-rhea-group", "group", "rhea"],
    ["member-zoya-group", "group", "zoya"],
    ["member-arjun-group", "group", "arjun"],
  ] as const)
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id, role, joined_at)
      VALUES (${member}, ${orgId}, ${chat}, 'person', ${person}, ${person === "rhea" ? "owner" : "member"}, ${at})`;
  for (const [id, chat, person, member] of [
    ["rhea-own", "rhea-chief", "rhea", "member-rhea-own"],
    ["zoya-own", "zoya-chief", "zoya", "member-zoya-own"],
    ["zoya-group", "group", "zoya", "member-zoya-group"],
  ] as const)
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_person_id,
        author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${id}, ${orgId}, ${chat}, 1, 'human', ${person}, ${member},
        ${person === "rhea" ? "owner" : "member"}, 'text', 'I am off till Monday.', '[]', 'posted', ${at})`;
  {
    const events = TURNS[name]!;
    const ids = events.map((_, index) => `event-${name}-${index}`);
    yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model, started_at, status, event_ids, audience)
      VALUES (${`wake-${name}`}, ${orgId}, ${agentId}, 'chief-thread', ${`run-${name}`}, 'fixture', 0,
        'running', ${JSON.stringify(ids)}, 'shared')`;
    for (const [index, event] of events.entries())
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, wakeup_id)
        VALUES (${ids[index]!}, ${orgId}, ${agentId}, ${String(event._tag)}, 'P0',
          ${JSON.stringify({ ...event, orgId, agentId, eventId: ids[index], receivedAt: at, dedupeKey: null })},
          0, 0, 'claimed', ${`wake-${name}`})`;
  }
  yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
    VALUES (${orgId}, 'work', 'Work', 'W', 1, 0)`;
  // Zoya's: due Friday, due next week, done. Arjun's private one, due Friday, she can't see.
  for (const [id, key, owner, state, due, sensitive] of [
    ["r1", "W-1", "zoya", "open", Date.UTC(2026, 10, 20, 9), 0],
    ["r2", "W-2", "zoya", "doing", Date.UTC(2026, 10, 27, 9), 0],
    ["r3", "W-3", "zoya", "done", Date.UTC(2026, 10, 20, 9), 0],
    ["r4", "W-4", "arjun", "open", Date.UTC(2026, 10, 20, 9), 1],
  ] as const)
    yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, created_by_kind, created_by_id, origin_key, created_at, updated_at, due_at, sensitive)
      VALUES (${orgId}, ${id}, 'work', ${key}, 'Invented task', ${state}, 'person', ${owner},
        'person', 'rhea', ${`o-${id}`}, 0, 0, ${due}, ${sensitive})`;
});

const turn = (name: string) => ({
  _tag: "agent" as const,
  orgId,
  agentId,
  ownerPersonId: KinPersonId.make("rhea"),
  threadId: ThreadId.make("chief-thread"),
  wakeupId: `wake-${name}`,
  startedAt: 0,
});

const awayDates = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ person: string; away: string | null; at: number | null }>`SELECT
      person_id AS person, away_until AS away, profile_updated_at AS at
    FROM kin_people WHERE org_id = ${orgId} ORDER BY person_id`;
});

describe("away_set", () => {
  it.effect("sets and clears the speaker's own date in her own chat, once per change", () =>
    Effect.gen(function* () {
      yield* setup("own");
      const set = yield* setAway(turn("own"), { until: "2026-11-23" });
      assert.deepStrictEqual(set, {
        person: "Zoya Sheikh",
        until: "2026-11-23",
        saved:
          "Zoya Sheikh is away through Mon 23 Nov and back on Tue 24 Nov, on Asia/Kolkata time.",
        dueWhileAway: 1,
        keys: ["W-1"],
      });
      const saved = yield* awayDates();
      assert.deepStrictEqual(
        saved.map((row) => [row.person, row.away]),
        [
          ["arjun", null],
          ["rhea", null],
          ["zoya", "2026-11-24"],
        ],
      );
      // An identical retry, later: the same answer and no new write.
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* setAway(turn("own"), { until: "2026-11-23" }), set);
      assert.deepStrictEqual(yield* awayDates(), saved);
      // Today is the last day: back tomorrow.
      assert.strictEqual(
        (yield* setAway(turn("own"), { until: "2026-11-18" })).saved,
        "Zoya Sheikh is away through Wed 18 Nov and back on Thu 19 Nov, on Asia/Kolkata time.",
      );
      const cleared = yield* setAway(turn("own"), {});
      assert.deepStrictEqual(cleared, {
        person: "Zoya Sheikh",
        until: null,
        saved: "Zoya Sheikh is not away.",
        dueWhileAway: 0,
        keys: [],
      });
      assert.isNull((yield* awayDates()).find((row) => row.person === "zoya")?.away);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    ["a group", "group"],
    ["a request another agent passed on", "passedOn"],
    ["a routine", "routine"],
    ["a reminder she set", "deferral"],
    ["a reaction", "reaction"],
    ["two speakers", "twoSpeakers"],
  ] as const)("a turn woken by %s sets nothing", ([, name]) =>
    Effect.gen(function* () {
      yield* setup(name);
      const before = yield* awayDates();
      const exit = yield* Effect.exit(setAway(turn(name), { until: "2026-11-23" }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(JSON.stringify(exit), "in their own chat with you");
      assert.deepStrictEqual(yield* awayDates(), before);
    }).pipe(Effect.provide(layer)),
  );

  // Kin's copy of her words in another chat (`kin_hand_off`) is never her own message there.
  it.effect(
    `a teammate's "I'm off till Monday" that is passed on sets no away date for anyone`,
    () =>
      Effect.gen(function* () {
        yield* setup("copy");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
            author_person_id, author_member_id, author_role, kind, body, mentions_json, status,
            created_at, origin_json)
          VALUES ('zoya-copy', ${orgId}, 'zoya-chief', 2, 'human', 'zoya', 'member-zoya-own',
            'member', 'text', 'I am off till Monday.', '[]', 'posted', ${at},
            '{"agentId":"finance","chatId":"group","messageId":"zoya-group"}')`;
        const before = yield* awayDates();
        const exit = yield* Effect.exit(setAway(turn("copy"), { until: "2026-11-23" }));
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(yield* awayDates(), before);
        assert.isTrue(before.every((row) => row.away === null));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("the owner's own chat reaches only the owner's own date", () =>
    Effect.gen(function* () {
      yield* setup("owner");
      const set = yield* setAway(turn("owner"), { until: "2026-11-23" });
      assert.strictEqual(set.person, "Rhea Kapoor");
      assert.isNull((yield* awayDates()).find((row) => row.person === "zoya")?.away);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    ["2026-11-17", "Tue 17 Nov has passed on their calendar (today is Wed 18 Nov)"],
    ["2027-11-19", "Fri 19 Nov 2027 is more than a year away"],
  ] as const)("%s is refused", ([until, why]) =>
    Effect.gen(function* () {
      yield* setup("own");
      const before = yield* awayDates();
      const exit = yield* Effect.exit(setAway(turn("own"), { until }));
      assert.include(JSON.stringify(exit), why);
      assert.deepStrictEqual(yield* awayDates(), before);
      // A year from today is still allowed.
      assert.strictEqual(
        (yield* setAway(turn("own"), { until: "2027-11-18" })).until,
        "2027-11-18",
      );
    }).pipe(Effect.provide(layer)),
  );
});
