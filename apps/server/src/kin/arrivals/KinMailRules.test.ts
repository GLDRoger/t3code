// @effect-diagnostics nodeBuiltinImport:off -- the source-level boundary guard scans this checkout.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import { KinAgentId, KinChatError, KinChatId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { KinConnections } from "../connections/ConnectionsService.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { runKinMigrations } from "../persistence/KinMigrations.ts";
import * as MailRules from "./KinMailRules.ts";
import { monthlyMailRuleLimit, recordMailRuleWake } from "./ruleLimit.ts";

const orgId = KinOrgId.make("org");
const agentId = KinAgentId.make("finance");
const chatId = KinChatId.make("meera-finance");
const meera = KinPersonId.make("meera");
const zoya = KinPersonId.make("zoya");
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
const fixture = MailRules.layer.pipe(
  Layer.provide(Layer.mock(KinConnections)({})),
  Layer.provideMerge(sqlLayer),
);

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
        MailRules.layer.pipe(Layer.provide(headers)),
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
      assert.deepStrictEqual(yield* rules.runNow(owners, ref), {
        status: "not_yet",
        arrivalId: "a-202",
        message: "Kin can't run mail rules yet. Nothing ran.",
      });
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
        Array.from({ length: 50 }, (_, i) => `m-${202 - i}`),
      );
      assert.deepStrictEqual(yield* rules.history(owners, ref), {
        entries: [{ kind: "gap", arrivalId: "gap", from: 20, to: 40 }],
      });
      assert.deepStrictEqual(
        yield* sql`SELECT fired, last_wake_at FROM kin_mail_rules ORDER BY rule_id`,
        [
          { fired: 0, last_wake_at: null },
          { fired: 0, last_wake_at: null },
        ],
      );
      assert.deepStrictEqual(yield* sql`SELECT event_id FROM kin_events`, []);
    }).pipe(Effect.provide(sqlLayer)),
);

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

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
