import { assert, describe, it } from "@effect/vitest";
import { KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as KinRetention from "../persistence/KinRetention.ts";
import { context } from "../pulse/KinPulse.ts";
import { KinWatchdogGithubReader, type GithubItemState } from "../triggers/watchdogs.ts";
import { KIN_OWNER_LEVEL, viewerOfPeople } from "../work/teamView.ts";
import { invoicePaid } from "./kinds/invoicePaid.ts";
import type { CodeOutcome, WatchKind } from "./kinds/kind.ts";
import { pr } from "./kinds/pr.ts";
import { taskOut } from "./kinds/taskOut.ts";
import { turnFailed } from "./kinds/turnFailed.ts";
import * as KinWatchRounds from "./KinWatchRounds.ts";
import * as KinWatches from "./KinWatches.ts";
import * as WatchReads from "./readRpcs.ts";

// Invented company, people, clients and money only (Ambermill; Rhea, Meera; Brightwell Labs).
const orgId = KinOrgId.make("ambermill");
const otherOrg = KinOrgId.make("other-co");
const rhea = KinPersonId.make("rhea");
const meera = KinPersonId.make("meera");
const owner: WatchReads.WatchReader = { personId: rhea, viewer: KIN_OWNER_LEVEL };
const member: WatchReads.WatchReader = { personId: meera, viewer: viewerOfPeople([meera]) };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 25 Nov 2026, 14:10 in Kolkata.
const T0 = Date.UTC(2026, 10, 25, 8, 40);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const layer = KinPersistence.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const stamp = "2026-10-01T00:00:00.000Z";
  for (const org of [orgId, otherOrg]) {
    yield* sql`INSERT INTO kin_orgs VALUES (${org}, 'Invented', ${stamp})`;
    yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
        dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES (${org}, 'Asia/Kolkata', '08:30', '18:00', '02:00', 0, 1, '09:00', '{}')`;
    for (const [id, prefix] of [
      ["invoices", "INV"],
      ["clients", "C"],
      ["work", "W"],
    ] as const)
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in, created_at)
        VALUES (${org}, ${id}, ${id}, ${prefix}, 1, 0)`;
  }
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
    VALUES (${rhea}, ${orgId}, 'rhea', 'Rhea', ${stamp}, 'owner'),
      (${meera}, ${orgId}, 'meera', 'Meera', ${stamp}, 'member')`;
  for (const [agent, domain] of [
    ["chief", "chief-of-staff"],
    ["finance", "finance"],
  ] as const) {
    yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
      VALUES (${agent}, ${orgId}, ${agent === "chief" ? "Chief of staff" : "Finance"}, 'lead', ${rhea}, ${stamp})`;
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
      VALUES (${`chat-${agent}`}, ${orgId}, 'team_group', 0, ${stamp})`;
    yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
        worker_projects_json, owner_chat_id, domain)
      VALUES (${agent}, ${orgId}, ${agent}, 0, '{}', '[]', ${`chat-${agent}`}, ${domain})`;
  }
  const record = (org: string, id: string, list: string, fields: Record<string, unknown>) =>
    sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
        owner_id, side, party_id, due_at, amount_minor, currency, confirmed, created_by_kind,
        created_by_id, origin_key, created_at, updated_at, fields_json)
      VALUES (${org}, ${`r-${id}`}, ${list}, ${id}, ${`Invented ${id}`},
        ${list === "invoices" ? "waiting" : "open"}, 'agent', 'finance', 'ours',
        ${list === "invoices" ? "r-C-1" : null}, ${list === "invoices" ? T0 - 10 * DAY : null},
        ${list === "invoices" ? 9_500_000 : null}, ${list === "invoices" ? "INR" : null}, 1,
        'person', ${rhea}, ${`origin-${org}-${id}`}, ${T0 - 30 * DAY}, ${T0 - 30 * DAY},
        ${JSON.stringify(fields)})`;
  yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state, owner_kind,
      owner_id, side, confirmed, created_by_kind, created_by_id, origin_key, created_at,
      updated_at, fields_json)
    VALUES (${orgId}, 'r-C-1', 'clients', 'C-1', 'Brightwell Labs', 'open', 'person', ${rhea},
      'ours', 1, 'person', ${rhea}, 'origin-c1', 0, 0, '{}')`;
  yield* record(orgId, "INV-11", "invoices", { number: "INV/26/011" });
  yield* record(otherOrg, "INV-1", "invoices", {});
  // What the pulse stored: INV-11 is overdue.
  yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id, scope_json,
      first_seen_at, last_seen_at)
    VALUES (${orgId}, 'invoice_overdue:INV-11:base=0', 'invoice_overdue', 'r-INV-11', '{}', ${T0}, ${T0})`;
});

const pay = Effect.fn("test.pay")(function* (at: number, amount = 9_500_000) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_record_payments (org_id, payment_id, record_id, amount_minor,
      currency, paid_on, origin_key, created_at, created_by_kind)
    VALUES (${orgId}, ${`pay-${at}`}, 'r-INV-11', ${amount}, 'INR', '2026-11-25', ${`p-${at}`}, ${at}, 'person')`;
  yield* touchRecord(at);
});

const touchRecord = Effect.fn("test.touchRecord")(function* (at: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_record_changes (org_id, record_id, rev, at, actor_kind, actor_id, via,
      kind, fields_json)
    VALUES (${orgId}, 'r-INV-11', 2, ${at}, 'person', ${rhea}, 'owner', 'updated', '[]')`;
});

const taskCard = (status: string, updatedAt: number, pullRequests: ReadonlyArray<object> = []) =>
  JSON.stringify({
    taskId: "task-1",
    environmentId: "env-1",
    threadId: "thread-1",
    remoteEnvironmentId: null,
    title: "Invented: build the quote page",
    model: null,
    status,
    pullRequests,
    lastError: null,
    updatedAt: iso(updatedAt),
  });

const watches = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    kind: string;
    state: string;
    nextLookAt: number;
    intervalMs: number;
    lastOutcome: string | null;
    closedHow: string | null;
    aside: number;
  }>`SELECT kind, state, next_look_at AS "nextLookAt", interval_ms AS "intervalMs",
      last_outcome AS "lastOutcome", closed_how AS "closedHow", aside
    FROM kin_watches WHERE org_id = ${orgId} ORDER BY kind, watch_id`;
});

const looks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    at: number;
    why: string | null;
    outcome: string | null;
    did: string | null;
    line: string | null;
  }>`SELECT at, why, outcome, did, line FROM kin_watch_looks
    WHERE org_id = ${orgId} AND watch_id IS NOT NULL ORDER BY at, look_id`;
});

const runAt = (at: number, find = true) =>
  TestClock.setTime(at).pipe(Effect.andThen(KinWatchRounds.round(orgId, at, { find })));

describe("Kin watches", () => {
  it.effect("each kind: found from its seeded row, then each code outcome", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          agent_id, role, joined_at)
        VALUES ('member-cos', ${orgId}, 'chat-chief', 'agent', 'chief', 'member', 0)`;
      yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
          author_agent_id, author_owner_person_id, author_thread_id, author_member_id, author_role,
          kind, body, mentions_json, status, created_at)
        VALUES ('m-1', ${orgId}, 'chat-chief', 1, 'agent', 'chief', ${rhea}, 'thread-cos',
          'member-cos', 'member', 'text', '', '[]', 'posted', '2026-11-25T00:00:00.000Z')`;
      const setCard = (status: string, updatedAt: number, closed: string | null = null) =>
        sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
            revision, state_json, awaiting_json, closed_at, updated_at)
          VALUES ('card-1', ${orgId}, 'chat-chief', 'm-1', 'native', 'task', 1,
            ${taskCard(status, updatedAt, [{ url: "https://github.com/ambermill/shop/pull/7", number: 7 }])},
            '[]', ${closed}, ${iso(updatedAt)})
          ON CONFLICT (widget_id) DO UPDATE SET state_json = excluded.state_json,
            closed_at = excluded.closed_at, updated_at = excluded.updated_at`;
      yield* setCard("working", T0);
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state)
        VALUES ('ev-1', ${orgId}, 'chief', 'chat.message', 'P0', '{}', 0, 0, 'queued')`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, run_id, model,
          started_at, ended_at, status, event_ids, audience)
        VALUES ('wake-1', ${orgId}, 'chief', 'lead-thread', 'run-1', 'fixture', ${T0 - HOUR},
          ${T0 - HOUR + MINUTE}, 'failed', '["ev-1"]', 'owner_only')`;
      let github: GithubItemState["state"] = "open";
      const reader = {
        readRepo: (_org: KinOrgId, _repo: string, numbers: ReadonlyArray<number>) =>
          Effect.succeed(
            numbers.map((number) => ({
              number,
              kind: "pull" as const,
              state: github,
              reviewRequests: [],
            })),
          ),
      };
      const at = (ms: number) => context(orgId, ms);
      const check = (kind: WatchKind, ms: number) =>
        Effect.gen(function* () {
          const [watch] = (yield* KinWatches.openWatches(orgId)).filter(
            (one) => one.kind === kind.kind,
          );
          assert.isDefined(watch);
          return yield* kind.check(yield* at(ms), watch!);
        }).pipe(Effect.provideService(KinWatchdogGithubReader, reader));
      const tag = (outcome: CodeOutcome) =>
        outcome._tag === "closed"
          ? `closed: ${outcome.how}`
          : outcome._tag === "problem" || outcome._tag === "changed" || outcome._tag === "cant_tell"
            ? `${outcome._tag}: ${outcome.line}`
            : outcome._tag;
      const rows: ReadonlyArray<{
        readonly kind: WatchKind;
        readonly about: string;
        readonly steps: ReadonlyArray<
          readonly [Effect.Effect<unknown, SqlError.SqlError, SqlClient.SqlClient>, number, string]
        >;
      }> = [
        {
          kind: invoicePaid,
          about: "Brightwell Labs' INV/26/011",
          steps: [
            [Effect.void, T0, "nothing_new"],
            [pay(T0 + HOUR, 5_000_000), T0 + HOUR, "nothing_new"],
            [pay(T0 + 2 * HOUR, 4_500_000), T0 + 2 * HOUR, "closed: INV/26/011 was paid on 25 Nov"],
            [
              sql`UPDATE kin_records SET state = 'dropped' WHERE record_id = 'r-INV-11'`,
              T0,
              "closed: no longer applies: Brightwell Labs' INV/26/011 was removed",
            ],
          ],
        },
        {
          kind: pr,
          about: "PR #7 for Invented: build the quote page",
          steps: [
            [Effect.void, T0, "nothing_new"],
            [Effect.sync(() => (github = "merged")), T0, "closed: PR #7 was merged"],
            [
              Effect.sync(() => (github = "closed")),
              T0,
              "closed: PR #7 was closed without merging",
            ],
          ],
        },
        {
          kind: taskOut,
          about: "Invented: build the quote page",
          steps: [
            [Effect.void, T0 + HOUR, "nothing_new"],
            [Effect.void, T0 + 2 * HOUR + MINUTE, "problem: no change for 2 hours"],
            [setCard("blocked", T0), T0, "problem: the work is blocked"],
            [setCard("needs_decision", T0), T0, "problem: the work waits on a decision"],
            [setCard("failed", T0), T0, "problem: the work failed"],
            [setCard("done", T0), T0, "closed: the work is done"],
            [setCard("cancelled", T0), T0, "closed: the work was stopped"],
            [
              setCard("working", T0, iso(T0)),
              T0,
              "closed: no longer applies: its task card was closed",
            ],
          ],
        },
        {
          kind: turnFailed,
          about: "Chief of staff's turn from Wed 25 Nov, 13:10",
          steps: [
            [Effect.void, T0, "nothing_new"],
            [
              sql`UPDATE kin_events SET state = 'done' WHERE event_id = 'ev-1'`,
              T0,
              "closed: the work ran later",
            ],
            [
              sql`UPDATE kin_events SET state = 'failed' WHERE event_id = 'ev-1'`,
              T0,
              "problem: its work failed 3 times and stopped",
            ],
            [
              sql`UPDATE kin_events SET state = 'expired' WHERE event_id = 'ev-1'`,
              T0,
              "closed: no longer applies: its work was dropped",
            ],
          ],
        },
      ];
      for (const row of rows) {
        const found = yield* row.kind
          .find(yield* at(T0))
          .pipe(Effect.provideService(KinWatchdogGithubReader, reader));
        assert.deepStrictEqual(
          found.map((one) => one.about),
          [row.about],
          row.kind.kind,
        );
        yield* KinWatches.upsert({ orgId, at: T0, kind: row.kind, found });
        // Found again, it is the same watch.
        assert.strictEqual(yield* KinWatches.upsert({ orgId, at: T0, kind: row.kind, found }), 0);
        const said: Array<string> = [];
        for (const [change, ms] of row.steps) {
          yield* change;
          said.push(tag(yield* check(row.kind, ms)));
        }
        assert.deepStrictEqual(
          said,
          row.steps.map(([, , expected]) => expected),
          row.kind.kind,
        );
      }
      // Without a GitHub reader no pull request is found, and an existing one can't be read.
      assert.deepStrictEqual(yield* pr.find(yield* at(T0)), []);
      const [prWatch] = (yield* KinWatches.openWatches(orgId)).filter((one) => one.kind === "pr");
      assert.deepStrictEqual(yield* pr.check(yield* at(T0), prWatch!), {
        _tag: "cant_tell",
        line: "GitHub isn't connected",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "backs off from 45 minutes to a day, snaps back when the invoice moves, and closes the moment it is paid",
    () =>
      Effect.gen(function* () {
        yield* seed;
        // Nothing open and nothing found: nothing is written.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE kin_pulse_facts SET cleared_at = ${T0}`;
        assert.isUndefined(yield* runAt(T0));
        assert.deepStrictEqual(yield* looks, []);
        yield* sql`UPDATE kin_pulse_facts SET cleared_at = NULL`;

        let at = T0;
        const gaps: Array<number> = [];
        for (let look = 0; look < 7; look++) {
          yield* runAt(at, look === 0);
          const [watch] = yield* watches;
          gaps.push((watch!.nextLookAt - at) / MINUTE);
          // Not due yet: a round finds nothing to look at.
          assert.isUndefined(yield* runAt(watch!.nextLookAt - 1, false));
          at = watch!.nextLookAt;
        }
        assert.deepStrictEqual(gaps, [45, 90, 180, 360, 720, 1440, 1440]);
        assert.deepStrictEqual(
          [...new Set((yield* looks).map((one) => `${one.why} ${one.outcome} ${one.did}`))],
          ["routine nothing_new nothing_new"],
        );
        // A change on the invoice: due at once, and the back-off starts over.
        yield* touchRecord(at + HOUR);
        yield* runAt(at + HOUR + MINUTE);
        assert.strictEqual((yield* looks).length, 8);
        assert.strictEqual((yield* watches)[0]!.nextLookAt, at + HOUR + MINUTE + 45 * MINUTE);
        // Paid in full: closed in the round the payment's change starts, with its words.
        yield* pay(at + 2 * HOUR);
        yield* runAt(at + 2 * HOUR + 5_000);
        assert.deepInclude((yield* watches)[0], {
          state: "closed",
          closedHow: "INV/26/011 was paid on 25 Nov",
        });
        assert.deepInclude((yield* looks).at(-1), { outcome: "closed", did: "closed" });
        const line = yield* WatchReads.lineOn(orgId, owner, "r-INV-11");
        assert.deepInclude(line, {
          state: "closed",
          closedHow: "INV/26/011 was paid on 25 Nov",
          closedBy: { kind: "code", name: null, you: false },
        });
      }).pipe(Effect.provide(layer)),
  );

  it.effect("never looks past its latest-by, and a latest-by passing is a problem", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* TestClock.setTime(T0);
      const [found] = yield* invoicePaid.find(yield* context(orgId, T0));
      yield* KinWatches.upsert({
        orgId,
        at: T0,
        kind: invoicePaid,
        found: [{ ...found!, latestBy: T0 + HOUR }],
      });
      yield* runAt(T0, false);
      assert.strictEqual((yield* watches)[0]!.nextLookAt, T0 + 45 * MINUTE);
      yield* runAt(T0 + 45 * MINUTE, false);
      assert.strictEqual((yield* watches)[0]!.nextLookAt, T0 + HOUR);
      yield* runAt(T0 + HOUR, false);
      assert.deepInclude((yield* looks).at(-1), {
        outcome: "problem",
        did: "problem",
        line: "due by Wed 25 Nov, not done yet",
      });
      assert.deepInclude((yield* watches)[0], { state: "open", lastOutcome: "problem" });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("Look now twice queues one look; Stop, then Watch again, looks once more", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* runAt(T0);
      const [watch] = (yield* WatchReads.list(orgId, owner, {})).watches;
      yield* TestClock.setTime(T0 + MINUTE);
      const first = yield* KinWatches.look(orgId, owner, watch!.watchId);
      assert.isTrue(first.watch.looking);
      yield* TestClock.setTime(T0 + 2 * MINUTE);
      yield* KinWatches.look(orgId, owner, watch!.watchId);
      yield* runAt(T0 + 3 * MINUTE, false);
      yield* runAt(T0 + 4 * MINUTE, false);
      assert.deepStrictEqual(
        (yield* looks).map((one) => one.why),
        ["routine", "asked"],
      );
      assert.isFalse((yield* WatchReads.one(orgId, owner, watch!.watchId)).looking);

      yield* TestClock.setTime(T0 + 5 * MINUTE);
      const stopped = yield* KinWatches.stop(orgId, owner, watch!.watchId);
      assert.deepInclude(stopped.watch, {
        state: "stopped",
        closedBy: { kind: "person", name: "Rhea", you: true },
      });
      assert.deepInclude(yield* Effect.flip(KinWatches.look(orgId, owner, watch!.watchId)), {
        reason: "invalid_state",
      });
      // Stopped, it is looked at no more, however long it waits.
      yield* runAt(T0 + 3 * DAY);
      assert.lengthOf(yield* looks, 2);
      yield* TestClock.setTime(T0 + 3 * DAY + MINUTE);
      const again = yield* KinWatches.again(orgId, owner, watch!.watchId);
      assert.deepInclude(again.watch, { state: "open", looking: true, closedBy: null });
      yield* runAt(T0 + 3 * DAY + 2 * MINUTE, false);
      assert.deepStrictEqual(
        (yield* looks).map((one) => one.why),
        ["routine", "asked", "asked"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a set-aside invoice sleeps, then wakes when its hold ends", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seed;
      yield* sql`INSERT INTO kin_holds (hold_id, org_id, record_id, until_at, set_by_kind,
          set_by_id, set_at)
        VALUES ('hold-1', ${orgId}, 'r-INV-11', ${T0 + 2 * DAY}, 'person', ${rhea}, ${T0 - HOUR})`;
      yield* runAt(T0);
      assert.deepStrictEqual(yield* looks, []);
      const line = yield* WatchReads.lineOn(orgId, owner, "r-INV-11");
      assert.deepStrictEqual(line?.aside, { until: iso(T0 + 2 * DAY) });
      // Each first interval it reads the hold again, and still sleeps.
      for (let at = T0 + 45 * MINUTE; at < T0 + 2 * DAY; at += 45 * MINUTE) yield* runAt(at, false);
      assert.deepStrictEqual(yield* looks, []);
      yield* runAt(T0 + 2 * DAY + MINUTE);
      assert.deepStrictEqual(
        (yield* looks).map((one) => one.outcome),
        ["nothing_new"],
      );
      assert.isNull((yield* WatchReads.lineOn(orgId, owner, "r-INV-11"))?.aside);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a teammate never reaches a money watch, nor anyone another company's", () =>
    Effect.gen(function* () {
      yield* seed;
      yield* runAt(T0);
      const [watch] = (yield* WatchReads.list(orgId, owner, {})).watches;
      assert.deepInclude(watch, {
        kind: "invoice_paid",
        recordKey: "INV-11",
        agentName: "Finance",
      });
      assert.deepStrictEqual((yield* WatchReads.list(orgId, member, {})).watches, []);
      assert.isUndefined(yield* WatchReads.lineOn(orgId, member, "r-INV-11"));
      for (const act of [KinWatches.look, KinWatches.stop, KinWatches.again])
        assert.deepInclude(yield* Effect.flip(act(orgId, member, watch!.watchId)), {
          reason: "not_found",
        });
      assert.strictEqual((yield* WatchReads.log(orgId, member, {})).rows.length, 0);
      // Another company's: unknown, even to its own owner level.
      for (const act of [KinWatches.look, KinWatches.stop, KinWatches.again])
        assert.deepInclude(yield* Effect.flip(act(otherOrg, owner, watch!.watchId)), {
          reason: "not_found",
        });
      assert.deepStrictEqual((yield* WatchReads.list(otherOrg, owner, {})).watches, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "the log folds runs of nothing-new looks, pages by day, and looks go after 30 days",
    () =>
      Effect.gen(function* () {
        yield* seed;
        let at = T0;
        for (let look = 0; look < 3; look++) {
          yield* runAt(at, look === 0);
          at = (yield* watches)[0]!.nextLookAt;
        }
        yield* pay(at + MINUTE);
        yield* runAt(at + 2 * MINUTE);
        yield* TestClock.setTime(at + 3 * MINUTE);
        const day = yield* WatchReads.log(orgId, owner, { timeZone: "Asia/Kolkata" });
        assert.strictEqual(day.day, "2026-11-25");
        assert.deepStrictEqual(
          day.rows.map((row) =>
            row._tag === "look"
              ? `${row.look.outcome}: ${row.look.line}`
              : `folded ${row.folded.count}`,
          ),
          ["closed: INV/26/011 was paid on 25 Nov", "folded 3"],
        );
        assert.strictEqual(day.watching, 0);
        assert.isNull(day.earlier);
        // A day with no looks pages back to the latest that had some.
        const before = yield* WatchReads.log(orgId, owner, { day: "2026-11-24" });
        assert.deepStrictEqual(before.rows, []);
        assert.isNull(before.earlier);
        const after = yield* WatchReads.log(orgId, owner, { day: "2026-11-26" });
        assert.strictEqual(after.earlier, "2026-11-25");

        yield* TestClock.setTime(T0 + 31 * DAY);
        yield* KinRetention.prune();
        assert.deepStrictEqual(yield* looks, []);
        assert.lengthOf(yield* watches, 1);
      }).pipe(Effect.provide(layer)),
  );
});
