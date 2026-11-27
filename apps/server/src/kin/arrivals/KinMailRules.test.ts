// @effect-diagnostics nodeBuiltinImport:off -- the source-level boundary guard scans this checkout.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventQueue from "../lead/KinEventQueue.ts";
import { turnAudience, turnChat } from "../lead/Audience.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import { subscribeRefreshes } from "../chat/refreshes.ts";
import { runKinMigrations } from "../persistence/KinMigrations.ts";
import * as MailRules from "./KinMailRules.ts";
import { monthlyMailRuleLimit, recordMailRuleWake } from "./ruleLimit.ts";
import { pauseMailRulesFor } from "./ruleLifecycle.ts";
import { checkRuleWake } from "./ruleWake.ts";

const orgId = KinOrgId.make("org");
const agentId = KinAgentId.make("finance");
const chatId = KinChatId.make("meera-finance");
const meera = KinPersonId.make("meera");
const zoya = KinPersonId.make("zoya");
const rhea = KinPersonId.make("rhea");
const owners = [{ _tag: "person", orgId, personId: meera }] satisfies ReadonlyArray<PersonIdentity>;
const teammates = [
  { _tag: "person", orgId, personId: zoya },
] satisfies ReadonlyArray<PersonIdentity>;
const connectionId = "mail";
const match = {
  from: [{ domain: "juniper.example" }],
  subjectHas: [],
  withFile: null,
  classes: null,
};
const tap = {
  orgId,
  connectionId,
  match,
  what: "File the bill.",
  agentId,
  chatId,
  tapId: "settings-tap",
};
const sqlLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const rulesWithQueue = MailRules.layer.pipe(
  Layer.provideMerge(Layer.merge(Layer.mock(KinConnections)({}), EventQueue.layer)),
);
const fixture = rulesWithQueue.pipe(Layer.provideMerge(sqlLayer));

const seed = Effect.fn("KinMailRulesTest.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runKinMigrations();
  yield* sql`INSERT INTO kin_orgs VALUES ('org', 'Tidewater Freight', '2026-11-27')`;
  yield* sql`INSERT INTO kin_people (org_id, person_id, handle, display_name, created_at, access)
    VALUES ('org', 'meera', 'meera', 'Meera', '2026-11-27', 'co_owner'),
      ('org', 'rhea', 'rhea', 'Rhea', '2026-11-27', 'owner'),
      ('org', 'zoya', 'zoya', 'Zoya', '2026-11-27', 'member')`;
  yield* sql`INSERT INTO kin_agents (org_id, agent_id, display_name, role, owner_person_id, created_at)
    VALUES ('org', 'finance', 'Finance', 'lead', 'rhea', '2026-11-27')`;
  yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, direct_key, last_seq, created_at)
    VALUES ('org', 'meera-finance', 'direct', 'meera:finance', 0, '2026-11-27')`;
  yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, principal_kind, person_id, member_id,
    role, joined_at) VALUES ('org', 'meera-finance', 'person', 'meera', 'meera-m',
      'member', '2026-11-27')`;
  yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, principal_kind, agent_id, member_id,
    role, joined_at) VALUES ('org', 'meera-finance', 'agent', 'finance', 'finance-m',
      'member', '2026-11-27')`;
  yield* sql`INSERT INTO kin_leads (org_id, agent_id, name, level, level_since, thread_id,
    models_json, worker_projects_json, owner_chat_id, domain, charter)
    VALUES ('org', 'finance', 'Finance', 'L0', 0, 'lead-thread', '{}', '[]', 'meera-finance',
      'finance', 'File the bill.')`;
  yield* sql`INSERT INTO kin_connections (org_id, connection_id, preset, label, kind, url_host, auth,
    reach, state, created_at, updated_at, person_id)
    VALUES ('org', 'mail', 'google', 'Mail', 'builtin', 'gmail.googleapis.com', 'oauth', 'closed', 'active', 1, 1, NULL),
      ('org', 'own', 'google', 'Own', 'builtin', 'gmail.googleapis.com', 'oauth', 'closed', 'active', 1, 1, 'meera')`;
  return sql;
});

it.effect(
  "checks owner level inside every call and refuses to act on changed words or filters",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed();
      const rules = yield* MailRules.KinMailRules;
      const rule = yield* rules.createFromTap(owners, tap);
      const ref = { orgId, ruleId: rule.ruleId };
      const resume = { ...ref, agentId, chatId, tapId: "resume-tap" };
      const [stored] = yield* sql<{ what: string; match_json: string; content_sha256: string }>`
      SELECT what, match_json, content_sha256 FROM kin_mail_rules`;
      assert.strictEqual(
        stored?.content_sha256,
        NodeCrypto.createHash("sha256")
          .update(stored!.match_json + stored!.what)
          .digest("hex"),
      );
      assert.strictEqual((yield* rules.createFromTap(owners, tap)).ruleId, rule.ruleId);
      assert.strictEqual(
        (yield* rules.createFromTap(owners, { ...tap, what: "Send it." }).pipe(Effect.flip)).reason,
        "invalid_state",
      );
      assert.strictEqual(
        (yield* rules
          .createFromTap(owners, { ...tap, connectionId: "own", tapId: "own-tap" })
          .pipe(Effect.flip)).reason,
        "invalid_state",
      );
      assert.strictEqual((yield* rules.list(owners, { orgId })).rules.length, 1);
      const forbidden: ReadonlyArray<Effect.Effect<unknown, KinChatError>> = [
        rules.createFromTap(teammates, tap),
        rules.list(teammates, { orgId }),
        rules.history(teammates, ref),
        rules.preview(teammates, ref),
        rules.runNow(teammates, ref),
        rules.pause(teammates, ref),
        rules.resume(teammates, resume),
        rules.remove(teammates, ref),
      ];
      for (const refused of forbidden)
        assert.strictEqual((yield* refused.pipe(Effect.asVoid, Effect.flip)).reason, "not_allowed");
      assert.strictEqual((yield* rules.pause(owners, ref)).pausedWhy, "person");
      assert.strictEqual((yield* rules.resume(owners, resume)).state, "on");
      yield* rules.pause(owners, ref);
      assert.strictEqual(
        (yield* rules.resume(owners, resume).pipe(Effect.flip)).reason,
        "invalid_state",
      );
      assert.strictEqual(
        (yield* rules.resume(owners, { ...resume, tapId: "new-resume" })).state,
        "on",
      );
      yield* sql`UPDATE kin_mail_rules SET what = 'Send the bill.'`;
      assert.strictEqual(
        (yield* rules.runNow(owners, ref).pipe(Effect.flip)).reason,
        "invalid_state",
      );
      const other = yield* rules.createFromTap(owners, { ...tap, tapId: "second-tap" });
      const listed = (yield* rules.list(owners, { orgId })).rules;
      assert.deepStrictEqual(
        new Map(
          listed.map(({ ruleId, match, wordingChanged }) => [ruleId, [match, wordingChanged]]),
        ),
        new Map([
          [rule.ruleId, [null, true]],
          [other.ruleId, [match, false]],
        ]),
      );
      assert.strictEqual((yield* rules.pause(owners, ref)).pausedWhy, "person");
      assert.strictEqual(
        (yield* rules.resume(owners, { ...resume, tapId: "changed-resume" }).pipe(Effect.flip))
          .reason,
        "invalid_state",
      );
      yield* rules.remove(owners, { orgId, ruleId: other.ruleId });
      yield* sql`UPDATE kin_mail_rules SET state = 'on' WHERE rule_id = ${rule.ruleId}`;
      yield* sql`UPDATE kin_mail_rules SET state = 'paused', what = 'File the bill.', match_json = '{}'`;
      assert.strictEqual(
        (yield* rules.resume(owners, resume).pipe(Effect.flip)).reason,
        "invalid_state",
      );
      yield* sql`UPDATE kin_people SET removed_at = 42 WHERE person_id = 'meera'`;
      assert.strictEqual(
        (yield* rules.list(owners, { orgId }).pipe(Effect.flip)).reason,
        "not_allowed",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "counts only admitted automatic wakes and resets on the local first, not UTC midnight",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed();
      const rules = yield* MailRules.KinMailRules;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream,
      full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES ('org', 'Asia/Kolkata', '09:00', '18:00', '02:00', 1, 1, '10:00', '{}')`;
      const last = Date.parse("2026-11-30T18:29:59Z");
      const first = Date.parse("2026-11-30T18:30:00Z");
      yield* TestClock.setTime(last);
      const rule = yield* rules.createFromTap(owners, { ...tap, monthlyCap: 1 });
      const ref = { orgId, ruleId: rule.ruleId };
      assert.deepStrictEqual(yield* sql.withTransaction(recordMailRuleWake(ref, last)), {
        status: "counted",
        month: "2026-11",
        fired: 1,
      });
      assert.strictEqual((yield* rules.list(owners, { orgId })).rules[0]?.fired, 1);
      assert.deepStrictEqual(yield* sql.withTransaction(recordMailRuleWake(ref, last)), {
        status: "held",
        month: "2026-11",
        fired: 1,
      });
      yield* TestClock.setTime(first);
      assert.strictEqual((yield* rules.list(owners, { orgId })).rules[0]?.fired, 0);
      assert.deepStrictEqual(yield* sql.withTransaction(recordMailRuleWake(ref, first)), {
        status: "counted",
        month: "2026-12",
        fired: 1,
      });
      assert.deepStrictEqual(monthlyMailRuleLimit(rule, first, "Asia/Kolkata"), {
        month: "2026-12",
        fired: 0,
        atLimit: false,
      });
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "previews only the latest 200 eligible headers and reads no headers for stored-only filters",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed();
      const calls: string[][] = [];
      const headers = Layer.mock(KinConnections)({
        arrivals: (_org, _connection, ids) =>
          Effect.sync(() => {
            calls.push([...ids]);
            return ids.map((messageId) => ({
              _tag: "read",
              messageId,
              arrival: {
                messageId,
                threadId: "thread",
                receivedAt: 0,
                from: "bill@juniper.example",
                fromAddress: "bill@juniper.example",
                to: [],
                cc: [],
                deliveredTo: [],
                subject: "Juniper invoice",
                date: null,
                internetId: null,
                authResults: [],
                listUnsubscribe: false,
                precedence: null,
                autoSubmitted: null,
                bulk: false,
                hasFile: true,
              },
            }));
          }),
      });
      const rules = yield* Effect.provide(
        MailRules.KinMailRules,
        MailRules.layer.pipe(Layer.provide(Layer.merge(headers, EventQueue.layer))),
      );
      yield* sql`WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 202)
      INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, from_address,
        received_at, noticed_at, class, state, has_file, sender_check, rule_state, rule_id)
      SELECT 'org', 'a-' || i, 'mail', 'm-' || i, 'bill@juniper.example', i, i, 'known_biller',
        'settled', 1, CASE WHEN i = 202 THEN 'failed' ELSE 'passed' END, NULL, NULL FROM n`;
      yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, received_at,
      noticed_at, class, state) VALUES ('org', 'gap', 'mail', 'gap:20', 20, 40, 'gap', 'settled')`;
      const rule = yield* rules.createFromTap(owners, { ...tap, monthlyCap: 1 });
      const ref = { orgId, ruleId: rule.ruleId };
      const stored = yield* rules.preview(owners, ref);
      assert.isNull(stored.subjectCheckLimit);
      assert.lengthOf(stored.matches, 202);
      assert.lengthOf(calls, 0);
      assert.deepStrictEqual(
        stored.matches.slice(0, 2).map(({ state }) => state),
        ["held_unverified", "held_cap"],
      );
      const draft = yield* rules.preview(owners, {
        orgId,
        connectionId,
        match: { ...match, subjectHas: ["invoice"] },
        monthlyCap: 1,
      });
      assert.strictEqual(draft.partial, true);
      assert.strictEqual(draft.subjectCheckLimit, 200);
      assert.deepStrictEqual(
        calls.map((batch) => [batch.length, batch[0], batch.at(-1)]),
        [[200, "m-202", "m-3"]],
      );
      assert.strictEqual(draft.matches[0]?.subject, "Juniper invoice");
      assert.strictEqual(draft.matches.at(-1)?.arrivalId, "a-3");
      // a-202 is the newest match, but its sender check failed: Run now never picks it.
      const result = yield* rules.runNow(owners, ref);
      assert.include(result, { status: "queued", arrivalId: "a-201" });
      const missed = yield* rules.createFromTap(owners, {
        ...tap,
        tapId: "other-tap",
        match: { ...match, subjectHas: ["credit note"] },
      });
      assert.deepStrictEqual(yield* rules.runNow(owners, { orgId, ruleId: missed.ruleId }), {
        status: "no_match",
        message: "No mail in the last 30 days matches this rule.",
      });
      assert.deepStrictEqual(
        calls.slice(1).flat(),
        Array.from({ length: 50 }, (_, i) => `m-${201 - i}`),
      );
      assert.deepStrictEqual(yield* rules.history(owners, ref), {
        entries: [
          {
            kind: "mail",
            arrivalId: "a-201",
            fromAddress: "bill@juniper.example",
            receivedAt: 201,
            noticedAt: 201,
            state: "woke",
            outcome: null,
            eventId: "eventId" in result ? result.eventId : null,
            wakeupId: null,
            settledAt: null,
            refs: null,
            holdReason: null,
            runOutcome: null,
          },
          { kind: "gap", arrivalId: "gap", from: 20, to: 40 },
        ],
      });
      assert.deepStrictEqual(
        yield* sql`SELECT fired, last_wake_at FROM kin_mail_rules ORDER BY rule_id`,
        [
          { fired: 0, last_wake_at: null },
          { fired: 0, last_wake_at: null },
        ],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT agent_id, tag, json_extract(json, '$.chatId') AS chat_id,
          json_extract(json, '$.rule.ruleId') AS rule_id, json_extract(json, '$.rule.manual') AS manual
        FROM kin_events`,
        [{ agent_id: agentId, tag: "pulse", chat_id: chatId, rule_id: rule.ruleId, manual: 1 }],
      );
    }).pipe(Effect.provide(sqlLayer)),
);

it.effect("pausing or disconnecting a rule settles its waiting mail before a feed tick", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const first = yield* rules.createFromTap(owners, tap);
    const second = yield* rules.createFromTap(owners, { ...tap, tapId: "tap_53ea" });
    for (const [n, rule] of [first, second].entries())
      yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, noticed_at,
        class, state, rule_id, rule_state) VALUES (${orgId}, ${`arr_660bf${n}`}, ${connectionId},
        ${`m_532ca${n}`}, 1, 'known_biller', 'new', ${rule.ruleId}, 'batched')`;
    yield* rules.pause(owners, { orgId, ruleId: first.ruleId });
    yield* sql.withTransaction(pauseMailRulesFor(orgId, { kind: "mailbox", id: connectionId }, 2));
    assert.deepStrictEqual(
      yield* sql`SELECT rule_state, rule_hold_reason AS reason FROM kin_arrivals ORDER BY arrival_id`,
      [
        { rule_state: "held_paused", reason: "paused" },
        { rule_state: "held_paused", reason: "mailbox_unavailable" },
      ],
    );
  }).pipe(Effect.provide(fixture)),
);

it.effect("a rule pulse claims alone and keeps the setter's private destination", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(9 * 60 * 60_000);
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const queue = yield* EventQueue.KinEventQueue;
    yield* sql`UPDATE kin_people SET time_zone = 'UTC', hold_outside_hours = 0,
      quiet_hours_json = '{"from":"22:00","to":"07:00"}' WHERE person_id = ${meera}`;
    const rule = yield* rules.createFromTap(owners, tap);
    yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, direct_key, last_seq, created_at)
      VALUES ('org', 'rhea-finance', 'direct', 'rhea:finance', 0, '2026-11-27')`;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, principal_kind, person_id, member_id,
      role, joined_at) VALUES ('org', 'rhea-finance', 'person', 'zoya', 'rhea-finance-zoya',
      'member', '2026-11-27')`;
    yield* sql`UPDATE kin_leads SET owner_chat_id = 'rhea-finance' WHERE agent_id = ${agentId}`;
    yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, from_address,
      received_at, noticed_at, class, state, sender_check)
      VALUES ('org', 'arr_a99512', 'mail', 'm_7bcaf2', 'bill@juniper.example',
        0, 0, 'known_biller', 'settled', 'passed')`;
    const ref = { orgId, ruleId: rule.ruleId };
    yield* rules.runNow(owners, ref);
    yield* rules.runNow(owners, ref);
    yield* sql`UPDATE kin_events SET json = json_set(json, '$.factKeys', json('["fixture"]'))`;
    assert.deepStrictEqual(yield* sql`SELECT not_before FROM kin_events`, [
      { not_before: null },
      { not_before: null },
    ]);
    const wakeupId = KinWakeupId.make("01KA4Y3GD3FC3FR2A9G7K80JD1");
    const [ready] = yield* queue.readyLeads(orgId);
    assert.strictEqual(ready?.agentId, agentId);
    yield* TestClock.setTime(ready!.readyAt);
    const events = yield* queue.claim({ orgId, agentId, wakeupId, model: "fixture" });
    assert.lengthOf(events, 1);
    const [event] = events;
    if (event?._tag !== "pulse") return assert.fail("Expected a rule pulse.");
    assert.deepStrictEqual(yield* turnChat({ orgId, agentId, wakeupId }), { chatId, asked: true });
    assert.strictEqual(yield* turnAudience({ orgId, agentId, wakeupId }), "owner_only");
    assert.deepStrictEqual(yield* checkRuleWake(event), { setterName: "Meera", what: tap.what });
    yield* TestClock.setTime(9 * 60 * 60_000);
    yield* rules.pause(owners, ref);
    assert.deepStrictEqual(yield* checkRuleWake(event), { held: "paused" });
    // A wake queued before a pause stays stopped after a resume, even by the same setter.
    yield* rules.resume(owners, { ...ref, agentId, chatId, tapId: "resume-tap" });
    assert.deepStrictEqual(yield* checkRuleWake(event), { held: "paused" });
  }).pipe(Effect.provide(rulesWithQueue.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("every rule change and run reaches each owner-level screen, and never a teammate's", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(9 * 60 * 60_000);
    const sql = yield* seed();
    yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, from_address,
      received_at, noticed_at, class, state, sender_check)
      VALUES ('org', 'arr_c41e07', 'mail', 'm_19d2ab', 'bill@juniper.example',
        0, 0, 'known_biller', 'settled', 'passed')`;
    // As the server builds them: the hub is in the services' own layers, never in a caller's.
    const hub = yield* Layer.build(RefreshHub.layer);
    const services = yield* Layer.build(
      rulesWithQueue.pipe(Layer.provide(Layer.succeedContext(hub))),
    );
    const rules = Context.get(services, MailRules.KinMailRules);
    const queue = Context.get(services, EventQueue.KinEventQueue);
    const viewers = Layer.mergeAll(
      Layer.succeedContext(hub),
      Layer.mock(KinIdentity)({
        owner: { _tag: "person", orgId, personId: rhea },
        isAgentThread: () => false,
        isLeadThread: () => false,
      }),
      Layer.mock(KinConnections)({
        mine: () =>
          Effect.succeed({
            orgId,
            mailbox: null,
            mailboxes: [],
            services: [],
            signInAddress: "https://tidewater.example/sign-in",
          }),
      }),
    );
    const screen = (personId: KinPersonId) =>
      Stream.toQueue(subscribeRefreshes([{ _tag: "person", orgId, personId }], { orgId }), {
        capacity: "unbounded",
      }).pipe(Effect.provide(viewers));
    const rheaPhone = yield* screen(rhea);
    const rheaLaptop = yield* screen(rhea);
    const meeraLaptop = yield* screen(meera);
    const zoyaLaptop = yield* screen(zoya);
    const ownerScreens = [rheaPhone, rheaLaptop, meeraLaptop];
    yield* Queue.take(zoyaLaptop);
    for (const owner of ownerScreens) assert.strictEqual((yield* Queue.take(owner)).connections, 0);
    let moves = 0;
    const settles = Effect.fn("KinMailRulesTest.settles")(function* (step: string) {
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      moves += 1;
      for (const owner of ownerScreens) {
        const heard = yield* Queue.poll(owner);
        assert.strictEqual(Option.getOrUndefined(heard)?.connections, moves, step);
      }
      assert.strictEqual(yield* Queue.size(zoyaLaptop), 0, step);
    });

    const rule = yield* rules.createFromTap(owners, tap);
    yield* settles("turned on");
    const ref = { orgId, ruleId: rule.ruleId };
    yield* rules.pause(owners, ref);
    yield* settles("paused");
    yield* rules.resume(owners, { ...ref, agentId, chatId, tapId: "resume-tap" });
    yield* settles("resumed");
    const ran = yield* rules.runNow(owners, ref);
    yield* settles("run now");
    const wakeupId = KinWakeupId.make("01KA4Y3GD3FC3FR2A9G7K80JD2");
    const [ready] = yield* queue.readyLeads(orgId);
    yield* TestClock.setTime(ready!.readyAt);
    assert.lengthOf(yield* queue.claim({ orgId, agentId, wakeupId, model: "fixture" }), 1);
    yield* settles("run started");
    yield* queue.finish({ orgId, wakeupId, status: "completed" });
    yield* settles("run settled");
    const [entry] = (yield* rules.history(owners, ref)).entries;
    assert.deepInclude(entry, {
      eventId: "eventId" in ran ? ran.eventId : null,
      wakeupId,
      runOutcome: "nothing",
    });
    assert.isNotNull(entry?.kind === "mail" ? entry.settledAt : null, "read as finished");
    yield* rules.remove(owners, ref);
    yield* settles("removed");
  }).pipe(Effect.scoped, Effect.provide(Sqlite.layerMemory)),
);

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// A rule is made or turned on only by the person's tap: no SQL an agent tool reaches may do either.
const makesRule = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+kin_mail_rules\b/i;
const turnsRuleOn =
  /\bUPDATE\s+kin_mail_rules\s+SET\b(?:(?!\bWHERE\b)[\s\S])*?\bstate\s*=\s*(?!\s|'paused'|'removed')/i;

it("keeps mail-rule writes out of the MCP import graph", () => {
  const seen = new Set<string>();
  const graph = (file: string, via: ReadonlyArray<string> = []): void => {
    if (seen.has(file)) return;
    seen.add(file);
    assert.notStrictEqual(
      file,
      NodePath.resolve(here, "KinMailRules.ts"),
      [...via, file].join(" → "),
    );
    const source = NodeFS.readFileSync(file, "utf8");
    assert.notMatch(source, makesRule, [...via, file].join(" → "));
    assert.notMatch(source, turnsRuleOn, [...via, file].join(" → "));
    const imports =
      /^(?:import|export)\s+(?!type\b)(?:[^;"']*?\sfrom\s+)?["'](\.[^"']+\.tsx?)["']|\bimport\(\s*["'](\.[^"']+\.tsx?)["']\s*\)/gm;
    for (const [, declaration, dynamic] of source.matchAll(imports)) {
      const specifier = declaration ?? dynamic;
      if (specifier !== undefined)
        graph(NodePath.resolve(NodePath.dirname(file), specifier), [...via, file]);
    }
  };
  const source = (name: string) =>
    name.endsWith(".ts") && !/\.(?:test|testkit|integration)\./.test(name);
  for (const folder of ["../lead/mcp", "../mcp", "../../mcp"]) {
    const root = NodePath.resolve(here, folder);
    for (const name of NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (source(name)) graph(NodePath.resolve(root, name));
    }
  }
  // Every agent tool, wherever it is declared: the coding-agent key's own tools are one.
  const server = NodePath.resolve(here, "../..");
  for (const name of NodeFS.readdirSync(server, { recursive: true, encoding: "utf8" })) {
    const file = NodePath.resolve(server, name);
    if (
      source(name) &&
      /McpToolAccess\.toLayer\(|Toolkit\.make\(/.test(NodeFS.readFileSync(file, "utf8"))
    )
      graph(file);
  }
});
