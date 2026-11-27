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
  KinMailRuleCardState,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWakeupId,
  KinWidgetId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventQueue from "../lead/KinEventQueue.ts";
import { turnAudience, turnChat } from "../lead/Audience.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { DAY_MS, MINUTE_MS } from "../durations.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import * as ChatHub from "../chat/KinChatHub.ts";
import * as ChatRepository from "../chat/KinChatRepository.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import { subscribeRefreshes } from "../chat/refreshes.ts";
import { kinMigrations, runKinMigrations } from "../persistence/KinMigrations.ts";
import RemovedRuleCards from "../persistence/migrations/K238_RemovedRuleCards.ts";
import * as MailRules from "./KinMailRules.ts";
import { sealPlans } from "../widgets/cardPlans.ts";
import { mailRuleTap } from "./mailRuleTap.ts";
import { prepareMailRule } from "./ruleDraft.ts";
import { holdRuleWake } from "./ruleRunStore.ts";
import { monthlyMailRuleLimit, recordMailRuleWake } from "./ruleLimit.ts";
import { pauseMailRulesFor } from "./ruleLifecycle.ts";
import {
  checkRuleWake,
  claimRuleMail,
  flushRuleMail,
  mailRuleLimitNotice,
  matchingRules,
} from "./ruleWake.ts";

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
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeCard = Schema.decodeUnknownEffect(KinMailRuleCardState);
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
const chats = ChatHub.layer.pipe(Layer.provideMerge(ChatRepository.layer));
const rulesWithQueue = MailRules.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Layer.mock(KinConnections)({}), EventQueue.layer, chats)),
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
      for (const [domain, shown] of [
        ["co.uk", "co.uk"],
        [" COM. ", "com"],
        ["github.io", "github.io"],
      ] as const) {
        const refused = yield* rules
          .createFromTap(owners, { ...tap, match: { ...match, from: [{ domain }] }, tapId: domain })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid_state");
        assert.strictEqual(
          refused.message,
          `${shown} is a domain ending that many companies share, so a rule can't match all mail under it. Name the sender's own domain instead.`,
        );
      }
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

it.effect("lists only recently removed rules and reads history after mailbox removal", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const old = yield* rules.createFromTap(owners, tap);
    yield* rules.remove(owners, { orgId, ruleId: old.ruleId });
    yield* TestClock.adjust(28 * DAY_MS);
    const recent = yield* rules.createFromTap(owners, { ...tap, tapId: "recent-tap" });
    const ref = { orgId, ruleId: recent.ruleId };
    yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id,
      from_address, noticed_at, class, state, sender_check)
      VALUES ('org', 'juniper-invoice', 'mail', 'juniper-invoice', 'bill@juniper.example',
        ${28 * DAY_MS}, 'known_biller', 'settled', 'passed')`;
    const run = yield* rules.runNow(owners, ref);
    assert.strictEqual(run.status, "queued");
    yield* rules.remove(owners, ref);
    yield* TestClock.adjust(3 * DAY_MS);
    const active = yield* rules.createFromTap(owners, { ...tap, tapId: "active-tap" });
    yield* sql`UPDATE kin_connections SET removed_at = ${31 * DAY_MS} WHERE connection_id = 'mail'`;
    const removed = { orgId, removed: true } as const;
    assert.deepStrictEqual(
      (yield* rules.list(owners, removed)).rules.map(({ ruleId }) => ruleId),
      [recent.ruleId],
    );
    assert.isEmpty((yield* rules.list(owners, { ...removed, connectionId: "own" })).rules);
    assert.strictEqual(
      (yield* rules.list(teammates, removed).pipe(Effect.flip)).reason,
      "not_allowed",
    );
    assert.deepStrictEqual(
      (yield* rules.list(owners, { orgId })).rules.map(({ ruleId }) => ruleId),
      [active.ruleId],
    );
    const { entries } = yield* rules.history(owners, ref);
    assert.lengthOf(entries, 1);
    assert.include(entries[0], { arrivalId: "juniper-invoice", kind: "mail" });
  }).pipe(Effect.provide(fixture)),
);

it.effect("applies a changed cap to the next matching mail and keeps held mail held", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const queue = yield* EventQueue.KinEventQueue;
    yield* TestClock.setTime(Date.parse("2026-11-27T12:00:00Z"));
    yield* sql`UPDATE kin_people SET time_zone = 'UTC', hold_outside_hours = 0 WHERE person_id = ${meera}`;
    const rule = yield* rules.createFromTap(owners, { ...tap, monthlyCap: 10 });
    const ref = { orgId, ruleId: rule.ruleId };
    const feed = Effect.fn("KinMailRulesTest.feed")(function* (arrivalId: string) {
      yield* TestClock.adjust(10 * MINUTE_MS);
      const now = yield* Clock.currentTimeMillis;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id,
            from_address, received_at, noticed_at, class, state, sender_check)
            VALUES ('org', ${arrivalId}, 'mail', ${arrivalId}, 'bill@juniper.example',
              ${now}, ${now}, 'known_biller', 'settled', 'passed')`;
          const matches = yield* matchingRules(orgId, connectionId);
          yield* claimRuleMail(matches[0]!.rule, arrivalId, null, "match", null);
          yield* flushRuleMail(matches, now);
        }),
      );
    });
    const claim = Effect.fn("KinMailRulesTest.claim")(function* (wakeupId: KinWakeupId) {
      yield* TestClock.adjust(MINUTE_MS);
      const [ready] = yield* queue.readyLeads(orgId);
      assert.isAtMost(ready?.readyAt ?? Infinity, yield* Clock.currentTimeMillis);
      const [event] = yield* Effect.scoped(
        queue.claim({ orgId, agentId, wakeupId, model: "fixture" }),
      );
      yield* queue.finish({ orgId, wakeupId, status: "completed" });
      return event;
    });
    const before =
      yield* sql`SELECT content_sha256, said_by, source_event, activation FROM kin_mail_rules`;
    yield* feed("first");
    const lower = yield* rules.setLimit(owners, { ...ref, monthlyCap: 1 });
    assert.include(lower, { ...ref, monthlyCap: 1, fired: 1, atLimit: true, setterName: "Meera" });
    yield* claim(KinWakeupId.make("01KA4Y3GD3FC3FR2A9G7K80JD4"));
    const firstRanAt = iso(yield* Clock.currentTimeMillis);
    assert.strictEqual((yield* rules.list(owners, { orgId })).rules[0]?.lastRanAt, firstRanAt);
    yield* feed("held");
    assert.deepInclude((yield* rules.history(owners, ref)).entries, {
      kind: "mail",
      arrivalId: "held",
      fromAddress: "bill@juniper.example",
      receivedAt: yield* Clock.currentTimeMillis,
      noticedAt: yield* Clock.currentTimeMillis,
      state: "held_cap",
      outcome: null,
      holdReason: "monthly_limit",
      runOutcome: "held",
      eventId: null,
      wakeupId: null,
      settledAt: yield* Clock.currentTimeMillis,
      refs: null,
    });
    const manual = yield* rules.runNow(owners, ref);
    assert.include(manual, { status: "queued", arrivalId: "held" });
    if (manual.status !== "queued") return assert.fail("Expected Run now to queue the held mail.");
    assert.strictEqual((yield* rules.list(owners, { orgId })).rules[0]?.lastRanAt, firstRanAt);
    const second = yield* claim(KinWakeupId.make("01KA4Y3GD3FC3FR2A9G7K80JD5"));
    assert.strictEqual(second?.eventId, manual.eventId);
    assert.strictEqual(
      (yield* rules.list(owners, { orgId })).rules[0]?.lastRanAt,
      iso(yield* Clock.currentTimeMillis),
    );
    const higher = yield* rules.setLimit(owners, { ...ref, monthlyCap: 10 });
    assert.include(higher, { monthlyCap: 10, fired: 1, atLimit: false });
    yield* feed("next");
    const { entries } = yield* rules.history(owners, ref);
    assert.sameDeepMembers(
      entries.flatMap((entry) =>
        entry.kind === "mail" ? [[entry.arrivalId, entry.state, "manual" in entry]] : [],
      ),
      [
        ["next", "woke", false],
        ["held", "held_cap", false],
        ["held", "woke", true],
        ["first", "woke", false],
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT content_sha256, said_by, source_event, activation FROM kin_mail_rules`,
      before,
    );
  }).pipe(Effect.provide(rulesWithQueue.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

const withChats = rulesWithQueue.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect("marks the answered rule card removed in open chats only once", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const repo = yield* ChatRepository.KinChatRepository;
    const hub = yield* ChatHub.KinChatHub;
    const identity = { _tag: "person", orgId, personId: rhea } as const;
    const chatId = KinChatId.make("rhea-finance");
    yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, direct_key, last_seq, created_at)
      VALUES ('org', ${chatId}, 'direct', 'rhea:finance', 0, '2026-11-27')`;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, principal_kind, person_id, member_id,
      role, joined_at) VALUES ('org', ${chatId}, 'person', 'rhea', 'rhea-m', 'owner', '2026-11-27')`;
    yield* sql`INSERT INTO kin_chat_members (org_id, chat_id, principal_kind, agent_id, member_id,
      role, joined_at) VALUES ('org', ${chatId}, 'agent', 'finance', 'rhea-finance-m', 'member', '2026-11-27')`;
    const now = 10_000;
    yield* TestClock.setTime(now);
    const at = iso(now);
    const { contentSha256, monthlyCap } = yield* prepareMailRule(tap);
    const shown = {
      mailbox: { connectionId, label: "Mail" },
      lead: { agentId, name: "Finance" },
      monthlyCap,
      contentSha256,
      expiresAt: now + MINUTE_MS,
    };
    const widgetId = KinWidgetId.make("mail-rule-card");
    const messageId = KinMessageId.make("mail-rule-message");
    yield* repo.insertMessage({
      orgId,
      chatId,
      messageId,
      audience: "owner",
      author: { _tag: "system" },
      kind: "system",
      body: "",
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: at,
      editedAt: null,
    });
    yield* repo.insertWidget({
      orgId,
      chatId,
      widgetId,
      messageId,
      audience: "owner",
      widgetClass: "native",
      type: "mail_rule",
      state: {
        ...shown,
        what: tap.what,
        match,
        fromAscii: ["juniper.example"],
        decision: { status: "proposed" },
      },
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: at,
    });
    yield* sealPlans({
      orgId,
      chatId,
      widgetId,
      now,
      plans: [{ optionId: "turn_on", plan: { kind: "mail_rule", personId: rhea, shown } }],
    });
    const getCard = repo.getWidget({ orgId, widgetId }).pipe(Effect.map(Option.getOrThrow));
    const widget = yield* getCard;
    const answered = yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* mailRuleTap({
          identity,
          widget,
          revision: widget.revision,
          action: "turn_on",
          tapId: KinMessageId.make("rhea-tap"),
        });
        return yield* repo.updateWidget({
          ...widget,
          state,
          audience: "owner",
          expectedRevision: widget.revision,
          closedAt: at,
          updatedAt: at,
        });
      }),
    );
    const state = yield* decodeCard(answered.state);
    if (state.decision.status !== "on") return assert.fail("Expected a rule turned on by Rhea.");
    assert.deepStrictEqual(state.decision.by, { personId: rhea, name: "Rhea" });
    const ref = { orgId, ruleId: state.decision.ruleId };
    const updates = yield* Stream.toQueue(yield* hub.subscribeForViewer(identity, chatId), {
      capacity: "unbounded",
    });
    yield* rules.pause([identity], ref);
    assert.deepStrictEqual(yield* getCard, answered);
    yield* rules.resume([identity], { ...ref, chatId, agentId, tapId: "rhea-resume" });
    assert.deepStrictEqual(yield* getCard, answered);
    yield* TestClock.adjust("1 second");
    const removedAt = iso(yield* Clock.currentTimeMillis);
    const removed = yield* rules.remove([identity], ref);
    const updated = yield* getCard;
    assert.deepStrictEqual(updated.state, { ...state, decision: { ...state.decision, removedAt } });
    assert.strictEqual(updated.revision, answered.revision + 1);
    assert.deepStrictEqual(yield* Queue.take(updates), {
      type: "widget.updated",
      orgId,
      widget: updated,
    });

    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(yield* rules.remove([identity], ref), removed);
    assert.deepStrictEqual(yield* getCard, updated);
    assert.strictEqual(yield* Queue.size(updates), 0);

    // Nothing on the card or in Settings turns a removed rule back on.
    const tapAgain = yield* mailRuleTap({
      identity,
      widget: updated,
      revision: updated.revision,
      action: "turn_on",
      tapId: KinMessageId.make("rhea-tap-again"),
    }).pipe(Effect.flip);
    assert.strictEqual(tapAgain.message, "This mail rule card was already answered.");
    const resumeAgain = yield* rules
      .resume([identity], { ...ref, chatId, agentId, tapId: "rhea-resume-removed" })
      .pipe(Effect.flip);
    assert.strictEqual(
      resumeAgain.message,
      "This mail rule isn't paused, so there's nothing to resume.",
    );
    assert.strictEqual(
      (yield* rules.list([identity], { orgId, removed: true })).rules[0]?.state,
      "removed",
    );
  }).pipe(Effect.scoped, Effect.provide(withChats)),
);

it.effect("tells the card of a rule removed before cards learnt it when that was", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const repo = yield* ChatRepository.KinChatRepository;
    yield* TestClock.setTime(Date.parse("2026-11-20T09:00:00Z"));
    const card = Effect.fn("KinMailRulesTest.card")(function* (
      name: string,
      decision: KinMailRuleCardState["decision"],
    ) {
      const at = iso(yield* Clock.currentTimeMillis);
      const messageId = KinMessageId.make(`${name}-message`);
      yield* repo.insertMessage({
        orgId,
        chatId,
        messageId,
        audience: "owner",
        author: { _tag: "system" },
        kind: "system",
        body: "",
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: at,
        editedAt: null,
      });
      const { contentSha256, monthlyCap } = yield* prepareMailRule(tap);
      yield* repo.insertWidget({
        orgId,
        chatId,
        widgetId: KinWidgetId.make(name),
        messageId,
        audience: "owner",
        widgetClass: "native",
        type: "mail_rule",
        state: {
          mailbox: { connectionId, label: "Mail" },
          lead: { agentId, name: "Finance" },
          monthlyCap,
          contentSha256,
          expiresAt: 0,
          what: tap.what,
          match,
          fromAscii: ["juniper.example"],
          decision,
        },
        source: null,
        feed: null,
        awaiting: [],
        pinnedAt: null,
        closedAt: decision.status === "proposed" ? null : at,
        updatedAt: at,
      });
      return Option.getOrThrow(yield* repo.getWidget({ orgId, widgetId: KinWidgetId.make(name) }));
    });
    const by = { personId: meera, name: "Meera" };
    const gone = yield* rules.createFromTap(owners, { ...tap, tapId: "gone-tap" });
    const kept = yield* rules.createFromTap(owners, { ...tap, tapId: "kept-tap" });
    const other = yield* rules.createFromTap(owners, { ...tap, tapId: "other-tap" });
    const widgets = [
      yield* card("gone", { status: "on", ruleId: gone.ruleId, by }),
      yield* card("kept", { status: "on", ruleId: kept.ruleId, by }),
      yield* card("open", { status: "proposed" }),
      yield* card("other", { status: "on", ruleId: other.ruleId, by }),
    ];
    // As the earlier remove left it: the rule removed, its card still saying it was turned on.
    const removedAt = Date.parse("2026-11-21T10:30:00.250Z");
    yield* sql`UPDATE kin_mail_rules SET state = 'removed', updated_at = ${removedAt}
      WHERE rule_id = ${gone.ruleId}`;
    const stored = sql`SELECT widget_id, revision, state_json, updated_at FROM kin_widgets
      ORDER BY widget_id`;
    const before = yield* stored;
    yield* TestClock.setTime(Date.parse("2026-11-28T00:00:00Z"));
    yield* RemovedRuleCards;
    const cards = yield* Effect.forEach(widgets, (widget) =>
      repo.getWidget(widget).pipe(Effect.map(Option.getOrThrow)),
    );
    assert.deepStrictEqual(cards[0]!.state, {
      ...(yield* decodeCard(widgets[0]!.state)),
      decision: { status: "on", ruleId: gone.ruleId, by, removedAt: "2026-11-21T10:30:00.250Z" },
    });
    assert.strictEqual(cards[0]!.revision, widgets[0]!.revision + 1);
    assert.deepStrictEqual(cards.slice(1), widgets.slice(1));
    const after = yield* stored;
    yield* RemovedRuleCards;
    assert.deepStrictEqual(yield* stored, after);
    assert.notDeepEqual(after, before);
    assert.deepInclude(kinMigrations, [238, "RemovedRuleCards"]);

    // Removing one rule now tells its own card and no other.
    yield* rules.remove(owners, { orgId, ruleId: kept.ruleId });
    const now = yield* Effect.forEach(widgets, (widget) =>
      repo.getWidget(widget).pipe(Effect.map(Option.getOrThrow)),
    );
    assert.deepStrictEqual(now[1]!.state, {
      ...(yield* decodeCard(widgets[1]!.state)),
      decision: { status: "on", ruleId: kept.ruleId, by, removedAt: "2026-11-28T00:00:00.000Z" },
    });
    assert.deepStrictEqual([now[0], now[2], now[3]], [cards[0], widgets[2], widgets[3]]);
  }).pipe(Effect.scoped, Effect.provide(withChats)),
);

it.effect("shows when a run started after a paused automatic wake", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const queue = yield* EventQueue.KinEventQueue;
    const now = Date.parse("2026-11-27T12:00:00Z");
    yield* TestClock.setTime(now);
    yield* sql`UPDATE kin_people SET time_zone = 'UTC', hold_outside_hours = 0 WHERE person_id = ${meera}`;
    const rule = yield* rules.createFromTap(owners, tap);
    const ref = { orgId, ruleId: rule.ruleId };
    const getRule = rules.list(owners, { orgId }).pipe(Effect.map(({ rules }) => rules[0]!));
    yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id,
      from_address, received_at, noticed_at, class, state, sender_check)
      VALUES ('org', 'paused-mail', 'mail', 'paused-mail', 'bill@juniper.example',
        ${now}, ${now}, 'known_biller', 'settled', 'passed')`;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const matches = yield* matchingRules(orgId, connectionId);
        yield* claimRuleMail(matches[0]!.rule, "paused-mail", null, "match", null);
        yield* flushRuleMail(matches, now);
      }),
    );
    assert.strictEqual((yield* rules.pause(owners, ref)).lastWakeAt, now);
    assert.isUndefined((yield* getRule).lastRanAt);
    yield* rules.resume(owners, { ...ref, agentId, chatId, tapId: "resume-after-pause" });
    const manual = yield* rules.runNow(owners, ref);
    if (manual.status !== "queued") return assert.fail("Expected Run now to queue the held mail.");
    assert.isUndefined((yield* getRule).lastRanAt);
    const [ready] = yield* queue.readyLeads(orgId);
    yield* TestClock.setTime(ready!.readyAt);
    const wakeupId = KinWakeupId.make("01KA4Y3GD3FC3FR2A9G7K80JD3");
    assert.lengthOf(yield* queue.claim({ orgId, agentId, wakeupId, model: "fixture" }), 1);
    assert.strictEqual((yield* getRule).lastRanAt, iso(ready!.readyAt));
    yield* sql.withTransaction(holdRuleWake(orgId, manual.eventId, wakeupId, "paused"));
    assert.isUndefined((yield* getRule).lastRanAt);
  }).pipe(Effect.scoped, Effect.provide(withChats)),
);

it.effect("refuses limit changes for a teammate and for a proposed or removed rule", () =>
  Effect.gen(function* () {
    const sql = yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const rule = yield* rules.createFromTap(owners, tap);
    const input = { orgId, ruleId: rule.ruleId, monthlyCap: 10 };
    assert.strictEqual(
      (yield* rules.setLimit(teammates, input).pipe(Effect.flip)).reason,
      "not_allowed",
    );
    yield* rules.pause(owners, input);
    assert.include(yield* rules.setLimit(owners, input), { state: "paused", monthlyCap: 10 });
    yield* sql`UPDATE kin_mail_rules SET state = 'proposed'`;
    assert.strictEqual(
      (yield* rules.setLimit(owners, input).pipe(Effect.flip)).reason,
      "invalid_state",
    );
    yield* rules.remove(owners, input);
    assert.strictEqual(
      (yield* rules.setLimit(owners, input).pipe(Effect.flip)).reason,
      "not_found",
    );
  }).pipe(Effect.provide(fixture)),
);

it.effect(
  "a lower limit holds at once below what fired, and the owner's local first clears it",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed();
      const rules = yield* MailRules.KinMailRules;
      yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary, dream,
      full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
      VALUES ('org', 'Asia/Kolkata', '09:00', '18:00', '02:00', 1, 1, '10:00', '{}')`;
      const last = Date.parse("2026-11-30T18:29:59Z");
      yield* TestClock.setTime(last);
      const rule = yield* rules.createFromTap(owners, { ...tap, monthlyCap: 10 });
      const ref = { orgId, ruleId: rule.ruleId };
      for (let wake = 0; wake < 3; wake++)
        assert.strictEqual(
          (yield* sql.withTransaction(recordMailRuleWake(ref, last))).status,
          "counted",
        );
      assert.include(yield* rules.setLimit(owners, { ...ref, monthlyCap: 2 }), {
        monthlyCap: 2,
        fired: 3,
        atLimit: true,
      });
      assert.strictEqual(
        (yield* sql.withTransaction(recordMailRuleWake(ref, last))).status,
        "held",
      );
      const elsewhere = KinOrgId.make("elsewhere");
      assert.strictEqual(
        (yield* rules
          .setLimit(owners, { orgId: elsewhere, ruleId: rule.ruleId, monthlyCap: 10 })
          .pipe(Effect.flip)).reason,
        "not_allowed",
      );
      assert.strictEqual(
        (yield* rules
          .setLimit(owners, { orgId, ruleId: "rule_elsewhere", monthlyCap: 10 })
          .pipe(Effect.flip)).reason,
        "not_found",
      );
      yield* TestClock.setTime(Date.parse("2026-11-30T18:30:00Z"));
      assert.include((yield* rules.list(owners, { orgId })).rules[0], {
        monthlyCap: 2,
        month: "2026-12",
        fired: 0,
        atLimit: false,
      });
      assert.strictEqual(
        (yield* sql.withTransaction(recordMailRuleWake(ref, yield* Clock.currentTimeMillis)))
          .status,
        "counted",
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect("lists a removed rule for exactly 30 days, and no path turns it back on", () =>
  Effect.gen(function* () {
    yield* seed();
    const rules = yield* MailRules.KinMailRules;
    const rule = yield* rules.createFromTap(owners, tap);
    const ref = { orgId, ruleId: rule.ruleId };
    yield* rules.remove(owners, ref);
    const removed = { orgId, removed: true } as const;
    yield* TestClock.adjust(30 * DAY_MS);
    const resume = { ...ref, agentId, chatId, tapId: "resume-tap" };
    assert.strictEqual(
      (yield* rules.resume(owners, resume).pipe(Effect.flip)).reason,
      "invalid_state",
    );
    assert.strictEqual(
      (yield* rules.setLimit(owners, { ...ref, monthlyCap: 5 }).pipe(Effect.flip)).reason,
      "not_found",
    );
    yield* rules.remove(owners, ref);
    assert.deepInclude((yield* rules.list(owners, removed)).rules[0], {
      ruleId: rule.ruleId,
      state: "removed",
      updatedAt: 0,
    });
    yield* TestClock.adjust(1);
    assert.isEmpty((yield* rules.list(owners, removed)).rules);
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
        MailRules.layer.pipe(Layer.provide(Layer.mergeAll(headers, EventQueue.layer, chats))),
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
      yield* sql`INSERT INTO kin_mail_rule_runs (org_id, event_id, arrival_id, rule_id, state, manual)
        VALUES ('org', 'automatic', 'a-201', ${rule.ruleId}, 'woke', 0)`;
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
      const history = yield* rules.history(owners, ref);
      const automatic = history.entries.find(
        (entry) => entry.kind === "mail" && entry.eventId === "automatic",
      );
      assert.include(automatic, { kind: "mail", arrivalId: "a-201" });
      assert.notProperty(automatic, "manual");
      assert.deepStrictEqual(
        history.entries.filter((entry) => entry !== automatic),
        [
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
            manual: true,
          },
          { kind: "gap", arrivalId: "gap", from: 20, to: 40 },
        ],
      );
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
    const limit = { ...ref, monthlyCap: 10 };
    const updated = yield* rules.setLimit(owners, limit);
    yield* settles("limit changed");
    assert.strictEqual((yield* rules.setLimit(owners, limit)).updatedAt, updated.updatedAt);
    yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
    for (const screen of [...ownerScreens, zoyaLaptop])
      assert.strictEqual(yield* Queue.size(screen), 0);
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

it.effect(
  "a rule whose setter is no longer owner level says so on the next read and runs nothing",
  () =>
    Effect.gen(function* () {
      const sql = yield* seed();
      const rules = yield* MailRules.KinMailRules;
      const rheas = [
        { _tag: "person", orgId, personId: rhea },
      ] satisfies ReadonlyArray<PersonIdentity>;
      yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id, from_address,
      received_at, noticed_at, class, state, sender_check)
      VALUES ('org', 'arr_5d0f3e', 'mail', 'm_8a61c4', 'bill@juniper.example',
        0, 0, 'known_biller', 'settled', 'passed')`;
      const rule = yield* rules.createFromTap(owners, tap);
      const ref = { orgId, ruleId: rule.ruleId };
      assert.notProperty(rule, "setterDemoted");
      const stored = sql`SELECT state, paused_why, updated_at FROM kin_mail_rules`;
      const before = yield* stored;
      // Rhea makes Meera a member: the rule row is untouched, and the next read says why it won't run.
      yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${meera}`;
      const [demoted] = (yield* rules.list(rheas, { orgId })).rules;
      assert.include(demoted, { state: "on", setterDemoted: true });
      assert.deepStrictEqual(yield* stored, before);
      assert.strictEqual(
        (yield* rules.runNow(rheas, ref).pipe(Effect.flip)).reason,
        "not_allowed",
        "Run now",
      );
      assert.deepStrictEqual(yield* sql`SELECT event_id FROM kin_events`, []);
      for (const viewer of [teammates, owners])
        assert.strictEqual(
          (yield* rules.list(viewer, { orgId }).pipe(Effect.flip)).reason,
          "not_allowed",
        );
      // A co-owner again: the flag clears.
      yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = ${meera}`;
      const [restored] = (yield* rules.list(rheas, { orgId })).rules;
      assert.include(restored, { state: "on" });
      assert.notProperty(restored, "setterDemoted");
      // A setter with no profile left is the leaver's pause to tell, as the wake holds it `setter_left`.
      yield* sql`UPDATE kin_mail_rules SET said_by = 'person_9c1e2a'`;
      assert.notProperty((yield* rules.list(rheas, { orgId })).rules[0], "setterDemoted");
    }).pipe(Effect.provide(fixture)),
);

it("the limit notice names the rule as Settings lists it, and counts one run or many", () => {
  const notice = (monthlyCap: number) =>
    mailRuleLimitNotice({
      match: { ...match, subjectHas: ["invoice"] },
      mailbox: "Accounts",
      monthlyCap,
      until: "Tuesday, 1 December",
    });
  assert.strictEqual(
    notice(1),
    "From juniper.example, subject has “invoice”: this mail rule on Accounts reached its limit of 1 run and is held until Tuesday, 1 December. Matched mail stays in the rule’s history in Settings → Connections.",
  );
  assert.strictEqual(
    notice(30),
    "From juniper.example, subject has “invoice”: this mail rule on Accounts reached its limit of 30 runs and is held until Tuesday, 1 December. Matched mail stays in the rule’s history in Settings → Connections.",
  );
});

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
