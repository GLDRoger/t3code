import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  KinChatId,
  KinEventId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWidgetId,
  type KinPushError,
  type KinPushToken,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ApproverKeys from "../approvals/ApproverKeys.ts";
import * as KeySeal from "../approvals/KeySeal.ts";
import * as Audit from "../approvals/Audit.ts";
import { KinAttestationTrust } from "../approvals/attestation/AttestationTrust.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import { layerKinAuthTest, repairProofKey } from "../auth/ProofKeySessions.testkit.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinApnsTransport, type KinApnsPush, type KinApnsResult } from "./Apns.ts";
import { KinPushDevices, type KinPushCaller } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";
import * as Devices from "./KinPushDevices.ts";
import * as Presence from "./KinPushPresence.ts";
import * as Sender from "./KinPushSender.ts";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const T = "2026-11-07T00:00:00.000Z";
const orgId = Schema.decodeSync(KinOrgId)("org_01");
const owner = Schema.decodeSync(KinPersonId)("h_owner");
const member = Schema.decodeSync(KinPersonId)("h_member");
const token = (fill: string) => fill.repeat(64) as KinPushToken;
const ownerPhone = token("a");
const ownerTablet = token("b");
const memberPhone = token("c");

const caller = (
  session: string,
  personId: KinPersonId,
  options: { readonly orgId?: KinOrgId; readonly proofKeyThumbprint?: string } = {},
): KinPushCaller => ({
  session: {
    sessionId: AuthSessionId.make(session),
    subject: session,
    method: "bearer-access-token",
    scopes: [],
    ...(options.proofKeyThumbprint === undefined
      ? {}
      : { proofKeyThumbprint: options.proofKeyThumbprint }),
  },
  people: [{ _tag: "person", orgId: options.orgId ?? orgId, personId }],
});

/** A fake APNs: records every push and answers each token as told (200 by default). */
const makeApns = (
  status: "ready" | "unconfigured" = "ready",
  respond: (push: KinApnsPush) => Effect.Effect<void> = () => Effect.void,
) => {
  const sent: Array<KinApnsPush> = [];
  const answers = new Map<string, KinApnsResult>();
  const layer = Layer.succeed(KinApnsTransport, {
    status,
    send: (push) =>
      Effect.sync(() => sent.push(push)).pipe(
        Effect.andThen(respond(push)),
        Effect.as(answers.get(push.token) ?? { status: 200, reason: undefined }),
      ),
  });
  return { sent, answers, layer };
};

const buildOn = <A, E, R>(apns: ReturnType<typeof makeApns>, database: Layer.Layer<A, E, R>) =>
  Sender.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Devices.layer, Presence.layer, apns.layer)),
    Layer.provideMerge(ApproverKeys.layer),
    Layer.provide(MemoryCache.layer),
    Layer.provideMerge(PendingActions.layer),
    Layer.provideMerge(Audit.layer),
    Layer.provide(Layer.succeed(KinAttestationTrust, { load: () => Effect.die("unused") })),
    Layer.provide(KeySeal.layerTest()),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env_kin")),
      }),
    ),
    Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, database)),
  );
const build = (apns: ReturnType<typeof makeApns>) => buildOn(apns, Sqlite.layerMemory);
// Real T3 auth with Kin's proof key hooks, so revocations write what #54 writes.
const buildRelay = (apns: ReturnType<typeof makeApns>) =>
  buildOn(apns, layerKinAuthTest("kin-push-"));

const seed = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org_01', 'Kin', ${T})`;
  for (const [person, handle] of [
    [owner, "owner"],
    [member, "priya"],
  ] as const) {
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
      VALUES (${person}, 'org_01', ${handle}, ${handle}, ${T})`;
  }
  for (const id of ["sess-owner-phone", "sess-owner-tablet", "sess-member", "sess-key"]) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${id}, ${id}, '[]', 'bearer-access-token', ${T}, '2026-12-07T00:00:00.000Z')`;
  }
  // The owner holds the org's active approver key; Priya's key never got past pending.
  for (const [thumbprint, person, state] of [
    ["k".repeat(43), owner, "active"],
    ["m".repeat(43), member, "pending"],
  ] as const) {
    yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
        device_label, platform, hardware, attested, session_id, state, created_at)
      VALUES (${thumbprint}, 'org_01', '{}', ${person}, 'Phone', 'ios', 'secure_enclave', 1,
        'sess-key', ${state}, ${NOW})`;
  }
  // The owner's quiet hours are 21:00 to 08:00 in New York; NOW is 19:00 there.
  yield* sql`INSERT INTO kin_trigger_settings (org_id, time_zone, morning_brief, evening_summary,
      dream, full_rebuild_weekday, owner_check_weekday, owner_check, quiet_hours_json)
    VALUES ('org_01', 'America/New_York', '08:00', '18:00', '03:00', 0, 1, '09:00',
      '{"from":"21:00","to":"08:00"}')`;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id,
      created_at)
    VALUES ('lead_fin', 'org_01', 'Finance', 'lead', ${owner}, ${T})`;
  // A group of both people and the Finance lead, and the owner's direct chat with the lead.
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, last_seq, created_at)
    VALUES ('chat_team', 'org_01', 'project_group', 'Payments team', 0, ${T})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, direct_key, last_seq, created_at)
    VALUES ('chat_dm', 'org_01', 'direct', 'h_owner:lead_fin', 0, ${T})`;
  for (const [memberId, chat, person, role] of [
    ["m_owner", "chat_team", owner, "owner"],
    ["m_priya", "chat_team", member, "member"],
    ["m_owner_dm", "chat_dm", owner, "owner"],
  ] as const) {
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        role, joined_at)
      VALUES (${memberId}, 'org_01', ${chat}, 'person', ${person}, ${role}, ${T})`;
  }
  for (const [memberId, chat] of [
    ["m_fin", "chat_team"],
    ["m_fin_dm", "chat_dm"],
  ] as const) {
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id,
        role, joined_at)
      VALUES (${memberId}, 'org_01', ${chat}, 'agent', 'lead_fin', 'member', ${T})`;
  }
  const devices = yield* KinPushDevices;
  yield* devices.register(caller("sess-owner-phone", owner), {
    orgId,
    token: ownerPhone,
    platform: "ios",
    apsEnvironment: "development",
  });
  yield* devices.register(caller("sess-owner-tablet", owner), {
    orgId,
    token: ownerTablet,
    platform: "ios",
    apsEnvironment: "production",
  });
  yield* devices.register(caller("sess-member", member), {
    orgId,
    token: memberPhone,
    platform: "ios",
    apsEnvironment: "development",
  });
  const sender = yield* Sender.KinPushSender;
  // Waits for the background send so tests can read its outcome.
  const notify = (notification: Sender.KinPushNotification) =>
    sender.notify(notification).pipe(Effect.flatMap(Fiber.join));
  return { sql, devices, sender, notify };
});

type Author =
  | { readonly personId: KinPersonId; readonly memberId: string }
  | { readonly agentMemberId: string }
  | "system";

const postMessage = (
  sql: SqlClient.SqlClient,
  author: Author,
  status = "posted",
  options: {
    readonly chatId?: string;
    readonly body?: string;
    readonly mentions?: ReadonlyArray<string>;
    readonly replyTo?: KinMessageId;
    readonly silent?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const [{ seq }] = (yield* sql<{ seq: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM kin_messages`) as [{ seq: number }];
    const messageId = KinMessageId.make(`msg_${seq}`);
    const human = typeof author === "object" && "personId" in author;
    const agent = typeof author === "object" && "agentMemberId" in author;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_agent_id, author_owner_person_id, author_thread_id,
        author_member_id, author_role, kind, body, mentions_json, reply_to, status, created_at, silent)
      VALUES (${messageId}, 'org_01', ${options.chatId ?? "chat_team"}, ${seq},
        ${human ? "human" : agent ? "agent" : "system"}, ${human ? author.personId : null},
        ${agent ? "lead_fin" : null}, ${agent ? owner : null}, ${agent ? "thread-fin" : null},
        ${human ? author.memberId : agent ? author.agentMemberId : null}, 'member', 'text',
        ${options.body ?? "Ship it before Friday, the secret is hunter2"},
        ${JSON.stringify(options.mentions ?? [])}, ${options.replyTo ?? null}, ${status}, ${T},
        ${options.silent === true ? 1 : 0})`;
    return messageId;
  });

const postWidget = (
  sql: SqlClient.SqlClient,
  type: string,
  state: object,
  awaiting: ReadonlyArray<KinPersonId>,
) =>
  Effect.gen(function* () {
    const messageId = yield* postMessage(sql, "system");
    const widgetId = KinWidgetId.make(`w_${messageId}`);
    yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
        revision, state_json, awaiting_json, updated_at)
      VALUES (${widgetId}, 'org_01', 'chat_team', ${messageId}, 'native', ${type}, 3,
        ${JSON.stringify(state)}, ${JSON.stringify(awaiting)}, ${T})`;
    return widgetId;
  });

const alerts = (sent: ReadonlyArray<KinApnsPush>) =>
  sent.map(
    (push) => (push.payload as { aps: { alert?: { title: string; body: string } } }).aps.alert,
  );

const categories = (sent: ReadonlyArray<KinApnsPush>) =>
  sent.map((push) => (push.payload as { aps: { category: string } }).aps.category);

describe("KinPushSender", () => {
  it.effect("sends approval pushes only to approvers' devices, with ids and fixed text", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sender, notify, sql } = yield* seed;
      const actions = yield* PendingActions.KinPendingActions;
      const { action } = yield* actions.create({
        orgId,
        kind: "merge_pull_request",
        target: {
          _tag: "pull_request",
          host: "github.com",
          repo: "GLDRoger/t3code",
          number: 212,
          mergeMethod: "squash",
          deleteBranchAfter: false,
        },
        resolved: {
          _tag: "pull_request",
          headSha: "a".repeat(40),
          base: "main",
          head: "kin/fix-212",
          title: "Fix the flaky payments test",
          additions: 3,
          deletions: 1,
          files: 1,
          checks: [],
        },
        targetDigest: "1".repeat(64),
        reason: "Approve now, the token is ghp_secret",
        requestedBy: { agentId: "lead", threadId: "thread-lead" },
        provenance: {
          startedBy: { humanId: member },
          startedByRole: "member",
          chain: [],
          ceilingBelowOwner: true,
        },
        source: KinEventId.make("evt-212"),
      } as unknown as PendingActions.KinPendingActionCreateInput);

      // The send outlives the request that asked for it.
      const handed = yield* Deferred.make<Fiber.Fiber<Sender.KinPushOutcome>>();
      const request = yield* sender.notify({ _tag: "approval", orgId, actionId: action.id }).pipe(
        Effect.flatMap((delivery) => Deferred.succeed(handed, delivery)),
        Effect.andThen(Effect.never),
        Effect.forkChild,
      );
      const delivery = yield* Deferred.await(handed);
      yield* Fiber.interrupt(request);
      const outcome = yield* Fiber.join(delivery);
      assert.deepStrictEqual(outcome, { status: "ready", sent: 2, suppressed: 0, failed: 0 });
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, push.environment]),
        [
          [ownerPhone, "development"],
          [ownerTablet, "production"],
        ],
      );
      assert.deepStrictEqual(apns.sent[0]?.payload, {
        aps: {
          alert: { title: "Approval needed", body: "Merge #212 is waiting on you" },
          badge: 0,
          category: "kin.approval",
          sound: "default",
        },
        body: {
          kin: 1,
          orgId,
          pendingActionId: action.id,
          deepLink: `/kin/env_kin/org_01/actions/${encodeURIComponent(action.id)}`,
        },
      });
      const wire = JSON.stringify(apns.sent.map((push) => push.payload));
      for (const leaked of ["ghp_secret", "flaky payments", "a".repeat(40)])
        assert.notInclude(wire, leaked);

      // Once the approver's key session is revoked, nobody is an approver and nothing is sent.
      yield* sql`UPDATE auth_sessions SET revoked_at = ${T} WHERE session_id = 'sess-key'`;
      const after = yield* notify({ _tag: "approval", orgId, actionId: action.id });
      assert.strictEqual(after.sent, 0);
      assert.strictEqual(apns.sent.length, 2);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("picks the category from the widget and routes only to who it awaits", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const cases = [
        ["deferral", { phase: "confirmed" }, [member], ["kin.deferral.confirmed"]],
        // Lane A's card (#64) carries no phase until TRIG-8; a fresh one is a confirmed deferral.
        [
          "deferral",
          {
            itemId: "item-1",
            title: "Ship it",
            dueAt: "2026-11-13T09:00:00.000Z",
            onDue: "start",
            text: "Deferred",
          },
          [member],
          ["kin.deferral.confirmed"],
        ],
        [
          "deferral",
          { phase: "heads_up" },
          [owner],
          ["kin.deferral.heads_up", "kin.deferral.heads_up"],
        ],
        ["deferral", { phase: "done" }, [owner], []],
        ["task", { status: "needs_decision" }, [member], ["kin.message"]],
        // Approval cards announce nothing themselves; the pending action does, to approvers.
        ["approval", { pendingActionId: "act_1" }, [member], []],
      ] as const;
      for (const [type, state, awaiting, expected] of cases) {
        apns.sent.length = 0;
        const widgetId = yield* postWidget(sql, type, state, awaiting);
        yield* notify({ _tag: "widget", orgId, widgetId });
        assert.deepStrictEqual(
          categories(apns.sent),
          [...expected],
          `${type} ${JSON.stringify(state)}`,
        );
      }
      apns.sent.length = 0;
      const widgetId = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [member]);
      yield* notify({ _tag: "widget", orgId, widgetId });
      assert.deepStrictEqual(apns.sent[0]?.payload, {
        aps: {
          alert: { title: "Payments team", body: "A deferral needs a look" },
          // Seven unread card messages in the group, nothing in Waiting on you.
          badge: 7,
          category: "kin.deferral.confirmed",
          sound: "default",
          "thread-id": "kin:org_01:chat_team",
        },
        body: {
          kin: 1,
          orgId,
          chatId: "chat_team",
          widgetId,
          revision: 3,
          deepLink: "/kin/env_kin/org_01/chats/chat_team",
        },
      });
      assert.isUndefined(apns.sent[0]?.collapseId);

      // A card that waits on someone rings as a card, not again as its message.
      const card = yield* postWidget(sql, "task", { status: "needs_decision" }, [member]);
      const [{ messageId: carded }] = (yield* sql<{ messageId: KinMessageId }>`
        SELECT message_id AS "messageId" FROM kin_widgets WHERE widget_id = ${card}`) as [
        { messageId: KinMessageId },
      ];
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: carded })).sent, 0);
      // A suggestion only the owner can see isn't announced to anyone.
      const suggested = yield* postMessage(sql, "system", "suggested");
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: suggested })).sent, 0);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("rings a person in a group only for what concerns them, and always in a DM", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const fin = { agentMemberId: "m_fin" } as const;
      const priyaSaid = yield* postMessage(sql, { personId: member, memberId: "m_priya" });
      const long = `Payroll for November is ready to review. ${"The totals match the ledger. ".repeat(8)}`;
      const cases = [
        ["an agent line in the group", fin, {}, []],
        ["a mention of Priya", fin, { mentions: ["m_priya"] }, [memberPhone]],
        [
          "the owner's reply to Priya",
          { personId: owner, memberId: "m_owner" },
          { replyTo: priyaSaid },
          [memberPhone],
        ],
        // The owner mentions Priya; the owner never hears their own message.
        [
          "the owner's own mention",
          { personId: owner, memberId: "m_owner" },
          { mentions: ["m_priya", "m_owner"] },
          [memberPhone],
        ],
        [
          "the lead in the owner's DM",
          { agentMemberId: "m_fin_dm" },
          { chatId: "chat_dm" },
          [ownerPhone, ownerTablet],
        ],
      ] as const;
      for (const [name, author, options, expected] of cases) {
        apns.sent.length = 0;
        const messageId = yield* postMessage(sql, author, "posted", options);
        yield* notify({ _tag: "message", orgId, messageId });
        assert.deepStrictEqual(
          apns.sent.map((push) => push.token),
          [...expected],
          name,
        );
      }

      apns.sent.length = 0;
      const mention = yield* postMessage(sql, fin, "posted", {
        mentions: ["m_priya"],
        body: "**Priya**, can you check the [invoice](https://x.test/1)?",
      });
      yield* notify({ _tag: "message", orgId, messageId: mention });
      assert.deepStrictEqual(alerts(apns.sent), [
        { title: "Payments team · Finance", body: "Priya, can you check the invoice?" },
      ]);
      assert.match(apns.sent[0]?.collapseId ?? "", /^kin:[0-9a-f]{12}$/);
      assert.include(
        JSON.stringify(apns.sent[0]?.payload),
        '"deepLink":"/kin/env_kin/org_01/chats/chat_team"',
      );

      apns.sent.length = 0;
      const dm = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
        body: long,
      });
      yield* notify({ _tag: "message", orgId, messageId: dm });
      const [first] = alerts(apns.sent);
      assert.strictEqual(first?.title, "Finance");
      // Cut at a word, under the banner's length, and marked as cut.
      assert.isAtMost(Array.from(first?.body ?? "").length, 160);
      assert.match(first?.body ?? "", /^Payroll for November is ready to review\. .*ledger\.…$/);

      // The lead's answer in the group rings whoever it is answering, named or not.
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead_fin', 'org_01', 'Finance', 0, '[]', '[]', 'chat_dm')`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids)
        VALUES ('wk_answer', 'org_01', 'lead_fin', 'opus', ${NOW}, 'running', '["ev_answer"]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('ev_answer', 'org_01', 'lead_fin', 'chat.message', 'P2',
          ${JSON.stringify({ chatId: "chat_team", messageId: priyaSaid })}, ${NOW}, ${NOW},
          'claimed', 'wk_answer')`;
      apns.sent.length = 0;
      yield* notify({ _tag: "message", orgId, messageId: yield* postMessage(sql, fin, "posted") });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [memberPhone],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("counts unread and waiting across chats in the badge", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const dm = { agentMemberId: "m_fin_dm" } as const;
      const read = yield* postMessage(sql, dm, "posted", { chatId: "chat_dm" });
      yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_dm', 'm_owner_dm', seq, ${T} FROM kin_messages
        WHERE message_id = ${read}`;
      // Unread: one agent line in the group (it rang nobody, but it counts) and one in the DM.
      yield* postMessage(sql, { agentMemberId: "m_fin" });
      // The owner's own message isn't unread to them.
      yield* postMessage(sql, { personId: owner, memberId: "m_owner" });
      for (const [waitingId, resolvedAt] of [
        ["wait_open", null],
        ["wait_done", T],
      ] as const)
        yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, reason,
            created_at, resolved_at)
          VALUES (${waitingId}, 'org_01', ${owner}, 'chat_team', 'question', ${T}, ${resolvedAt})`;
      // Kin's silent bookkeeping rings nobody and never counts.
      apns.sent.length = 0;
      const silent = { chatId: "chat_dm", silent: true } as const;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, "system", "posted", silent),
      });
      assert.deepStrictEqual(apns.sent, []);
      const messageId = yield* postMessage(sql, dm, "posted", { chatId: "chat_dm" });
      yield* notify({ _tag: "message", orgId, messageId });
      // Two unread in the group, one in the DM, one open waiting item.
      assert.deepStrictEqual(
        apns.sent.map((push) => (push.payload as { aps: { badge: number } }).aps.badge),
        [3, 3],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("keeps quiet hours silent, except for what the owner timed", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const dm = { agentMemberId: "m_fin_dm" } as const;
      const sound = () =>
        apns.sent.map((push) => (push.payload as { aps: { sound?: string } }).aps.sound ?? null);
      const lead = (chatId: string) =>
        postMessage(sql, dm, "posted", { chatId, body: "Your reminder: call the bank" });
      // 22:00 in New York.
      yield* TestClock.setTime(Date.parse("2026-11-08T03:00:00Z"));
      apns.sent.length = 0;
      yield* notify({ _tag: "message", orgId, messageId: yield* lead("chat_dm") });
      assert.deepStrictEqual(sound(), [null, null]);
      assert.deepStrictEqual(apns.sent[0]?.payload, {
        aps: { badge: 1 },
        body: {
          kin: 1,
          orgId,
          chatId: "chat_dm",
          deepLink: "/kin/env_kin/org_01/chats/chat_dm",
        },
      });

      // Kin's own fallback for a reminder carries the reminder card.
      const fallback = yield* postMessage(sql, "system", "posted", { chatId: "chat_dm" });
      yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
          type, revision, state_json, awaiting_json, updated_at)
        VALUES ('w_reminder', 'org_01', 'chat_dm', ${fallback}, 'native', 'reminder', 1, '{}',
          '[]', ${T})`;
      // The lead writing a scheduled task's result while that wake-up runs.
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead_fin', 'org_01', 'Finance', 0, '[]', '[]', 'chat_dm')`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids)
        VALUES ('wk_1', 'org_01', 'lead_fin', 'opus', ${NOW}, 'running', '["ev_1"]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('ev_1', 'org_01', 'lead_fin', 'scheduled_task', 'P2', '{}', ${NOW}, ${NOW},
          'claimed', 'wk_1')`;
      yield* sql`INSERT INTO kin_lead_deliveries (org_id, event_id, kind, agent_id, chat_id,
          widget_id, widget_type, state_json, fallback_body, deadline_at, status, created_at,
          updated_at)
        VALUES ('org_01', 'ev_1', 'scheduled_task', 'lead_fin', 'chat_dm', 'w_task',
          'scheduled_task', '{}', 'Kin ran it', ${NOW}, 'pending', ${NOW}, ${NOW})`;
      for (const messageId of [fallback, yield* lead("chat_dm")]) {
        apns.sent.length = 0;
        yield* notify({ _tag: "message", orgId, messageId });
        assert.deepStrictEqual(sound(), ["default", "default"], messageId);
      }
      // Once that wake-up ends, the lead's next line is quiet again.
      yield* sql`UPDATE kin_wakeups SET status = 'completed', ended_at = ${NOW}`;
      apns.sent.length = 0;
      yield* notify({ _tag: "message", orgId, messageId: yield* lead("chat_dm") });
      assert.deepStrictEqual(sound(), [null, null]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("skips a device while its session watches the chat and acks", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const presence = yield* KinPushPresence;
      const phone = AuthSessionId.make("sess-owner-phone");
      const chat = KinChatId.make("chat_team");
      const messageId = yield* postMessage(
        sql,
        { personId: member, memberId: "m_priya" },
        "posted",
        {
          mentions: ["m_owner"],
        },
      );
      const watching = yield* presence
        .watch(phone, chat)
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      const watched = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(watched, { status: "ready", sent: 1, suppressed: 1, failed: 0 });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [ownerTablet],
      );
      // Watching one chat quiets only that chat: the DM still reaches the phone, until the
      // phone opens the DM too, say beside the group on a wide screen.
      const dm = KinChatId.make("chat_dm");
      const lead = () =>
        postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", { chatId: "chat_dm" });
      const elsewhere = yield* notify({ _tag: "message", orgId, messageId: yield* lead() });
      assert.deepStrictEqual(elsewhere, { status: "ready", sent: 2, suppressed: 0, failed: 0 });
      const both = yield* presence
        .watch(phone, dm)
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      const bothOpen = yield* notify({ _tag: "message", orgId, messageId: yield* lead() });
      assert.deepStrictEqual(bothOpen, { status: "ready", sent: 1, suppressed: 1, failed: 0 });
      assert.deepStrictEqual((yield* notify({ _tag: "message", orgId, messageId })).suppressed, 1);
      yield* Fiber.interrupt(both);
      // Closing the watch ends the suppression.
      yield* Fiber.interrupt(watching);
      const closed = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(closed, { status: "ready", sent: 2, suppressed: 0, failed: 0 });

      // A phone that dropped off without closing its socket stops acking. After an idle hour,
      // the next message reaches it.
      yield* presence.watch(phone, chat).pipe(
        Stream.runForEach(() => Effect.never),
        Effect.forkChild({ startImmediately: true }),
      );
      for (let minute = 0; minute < 60; minute += 1) yield* TestClock.adjust("1 minute");
      const idle = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(idle, { status: "ready", sent: 2, suppressed: 0, failed: 0 });
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("reaches only people still in the chat and in this org; muted gets the badge", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, devices } = yield* seed;
      // Someone in another org with a device there hears nothing about this org's chat.
      const elsewhere = KinOrgId.make("org_02");
      const stranger = KinPersonId.make("h_stranger");
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org_02', 'Other', ${T})`;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${stranger}, 'org_02', 'stranger', 'Stranger', ${T})`;
      yield* devices.register(caller("sess-member", stranger, { orgId: elsewhere }), {
        orgId: elsewhere,
        token: token("e"),
        platform: "ios",
        apsEnvironment: "production",
      });
      const recipients = (mutedUntil: string | null, left: string | null) =>
        Effect.gen(function* () {
          yield* sql`UPDATE kin_chat_members SET muted_until = ${mutedUntil}, left_at = ${left}
            WHERE member_id = 'm_priya'`;
          apns.sent.length = 0;
          const messageId = yield* postMessage(
            sql,
            { personId: owner, memberId: "m_owner" },
            "posted",
            {
              mentions: ["m_priya"],
            },
          );
          yield* notify({ _tag: "message", orgId, messageId });
          return apns.sent.map((push) => [
            push.token,
            "alert" in (push.payload as { aps: object }).aps ? "alert" : "badge only",
          ]);
        });
      assert.deepStrictEqual(yield* recipients(null, null), [[memberPhone, "alert"]]);
      // 03:00 at +05:00 is 22:00Z yesterday: the mute is over, though the text sorts later.
      assert.deepStrictEqual(yield* recipients("2026-11-08T03:00:00+05:00", null), [
        [memberPhone, "alert"],
      ]);
      // Muted: no banner or sound, but the badge still counts.
      assert.deepStrictEqual(yield* recipients("2026-11-08T01:00:00Z", null), [
        [memberPhone, "badge only"],
      ]);
      assert.isUndefined(apns.sent[0]?.collapseId);
      assert.deepStrictEqual(yield* recipients(null, T), []);
      // A phone whose session was revoked hears nothing, even before anything reconciles.
      yield* sql`UPDATE auth_sessions SET revoked_at = ${T} WHERE session_id = 'sess-member'`;
      assert.deepStrictEqual(yield* recipients(null, null), []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("sends to several devices at once, at most four", () => {
    let inFlight = 0;
    let peak = 0;
    const started: Array<string> = [];
    const gate = Deferred.makeUnsafe<void>();
    // Each send waits until four are in flight, so sending one at a time never finishes.
    const apns = makeApns("ready", (push) =>
      Effect.gen(function* () {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        started.push(push.token);
        if (inFlight === 4) yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(gate);
        inFlight -= 1;
      }),
    );
    return Effect.gen(function* () {
      const { notify, sql, devices } = yield* seed;
      for (const fill of ["d", "e", "f", "1"])
        yield* devices.register(caller("sess-owner-phone", owner), {
          orgId,
          token: token(fill),
          platform: "ios",
          apsEnvironment: "production",
        });
      const messageId = yield* postMessage(
        sql,
        { personId: member, memberId: "m_priya" },
        "posted",
        {
          mentions: ["m_owner"],
        },
      );
      const outcome = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(outcome, { status: "ready", sent: 6, suppressed: 0, failed: 0 });
      assert.strictEqual(peak, 4);
      assert.strictEqual(started.length, 6);
    }).pipe(Effect.provide(build(apns)));
  });

  // Review of 422a82327b: a send waits behind slow ones, and who may hear of it changes meanwhile.
  it.effect(
    "drops a waiting send to someone removed, re-added after the message, or whose chat was cleared",
    () => {
      // Each round, the first four sends hold every slot until released.
      let round = {
        parked: 0,
        full: Deferred.makeUnsafe<void>(),
        release: Deferred.makeUnsafe<void>(),
      };
      const apns = makeApns("ready", () =>
        Effect.gen(function* () {
          const current = round;
          if (current.parked >= 4) return;
          current.parked += 1;
          if (current.parked === 4) yield* Deferred.succeed(current.full, undefined);
          yield* Deferred.await(current.release);
        }),
      );
      return Effect.gen(function* () {
        const { sql, devices, sender } = yield* seed;
        // Two more owner devices fill the four slots; Yan and Zed sort after the owner.
        for (const fill of ["d", "e"])
          yield* devices.register(caller("sess-owner-phone", owner), {
            orgId,
            token: token(fill),
            platform: "ios",
            apsEnvironment: "production",
          });
        for (const [person, memberId, fill] of [
          [KinPersonId.make("h_yan"), "m_yan", "7"],
          [KinPersonId.make("h_zed"), "m_zed", "8"],
        ] as const) {
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES (${person}, 'org_01', ${memberId}, ${memberId}, ${T})`;
          yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
              person_id, role, joined_at)
            VALUES (${memberId}, 'org_01', 'chat_team', 'person', ${person}, 'member', ${T})`;
          yield* devices.register(caller("sess-member", person), {
            orgId,
            token: token(fill),
            platform: "ios",
            apsEnvironment: "production",
          });
        }
        const ownerDevices = [ownerPhone, ownerTablet, token("d"), token("e")];
        /** Sends Priya's message, changes the rows while the owner's sends hold the slots. */
        const parkedSend = (change: (messageId: KinMessageId) => Effect.Effect<void, SqlError>) =>
          Effect.gen(function* () {
            round = { parked: 0, full: Deferred.makeUnsafe(), release: Deferred.makeUnsafe() };
            apns.sent.length = 0;
            const messageId = yield* postMessage(
              sql,
              { personId: member, memberId: "m_priya" },
              "posted",
              { mentions: ["m_owner", "m_yan", "m_zed"] },
            );
            const sending = yield* sender.notify({ _tag: "message", orgId, messageId });
            yield* Deferred.await(round.full);
            yield* change(messageId);
            yield* Deferred.succeed(round.release, undefined);
            yield* Fiber.join(sending);
            return apns.sent.map((push) => push.token);
          });
        // Zed is removed, and Yan removed and added back after the message.
        assert.sameMembers(
          yield* parkedSend(() =>
            Effect.gen(function* () {
              yield* sql`UPDATE kin_chat_members SET left_at = ${T} WHERE member_id = 'm_zed'`;
              yield* sql`UPDATE kin_chat_members SET joined_seq = 99 WHERE member_id = 'm_yan'`;
            }),
          ),
          ownerDevices,
        );
        yield* sql`UPDATE kin_chat_members SET left_at = NULL, joined_seq = 0
          WHERE member_id IN ('m_yan', 'm_zed')`;
        // A clear deletes the chat's messages before the waiting sends reach them.
        assert.sameMembers(
          yield* parkedSend((messageId) =>
            Effect.gen(function* () {
              yield* sql`DELETE FROM kin_messages WHERE message_id = ${messageId}`;
              yield* sql`UPDATE kin_chats SET cleared_seq = 99 WHERE chat_id = 'chat_team'`;
            }),
          ),
          ownerDevices,
        );
      }).pipe(Effect.provide(build(apns)));
    },
  );

  it.effect("sends nothing without an APNs key", () => {
    const apns = makeApns("unconfigured");
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const messageId = yield* postMessage(sql, { personId: owner, memberId: "m_owner" });
      assert.deepStrictEqual(yield* notify({ _tag: "message", orgId, messageId }), {
        status: "unconfigured",
        sent: 0,
        suppressed: 0,
        failed: 0,
      });
      assert.strictEqual(apns.sent.length, 0);
    }).pipe(Effect.provide(build(apns)));
  });
});

describe("KinPushDevices", () => {
  const tokens = (sql: SqlClient.SqlClient) =>
    sql<{ token: string; person_id: string; session_id: string }>`
      SELECT token, person_id, session_id FROM kin_push_devices ORDER BY token`;

  it.effect("removes devices on unregister and session revoke", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const outsider: KinPushCaller = { ...caller("sess-member", member), people: [] };
      const refused = yield* Effect.exit(
        devices.register(outsider, {
          orgId,
          token: token("d"),
          platform: "ios",
          apsEnvironment: "production",
        }),
      );
      assert.isTrue(
        Exit.isFailure(refused) &&
          (refused.cause.reasons[0] as { error?: KinPushError }).error?.reason === "not_member",
      );
      // Someone else can't unregister your phone.
      assert.isFalse(
        (yield* devices.unregister(caller("sess-member", member), { orgId, token: ownerPhone }))
          .removed,
      );
      assert.isTrue(
        (yield* devices.unregister(caller("sess-owner-tablet", owner), {
          orgId,
          token: ownerTablet,
        })).removed,
      );
      yield* sql`UPDATE auth_sessions SET revoked_at = ${T} WHERE session_id = 'sess-member'`;
      // An expired session isn't revoked: its socket can outlive it.
      yield* sql`UPDATE auth_sessions SET expires_at = ${T} WHERE session_id = 'sess-owner-phone'`;
      assert.strictEqual(yield* devices.reconcileSessions(), 1);
      assert.deepStrictEqual(yield* tokens(sql), [
        { token: ownerPhone, person_id: owner, session_id: "sess-owner-phone" },
      ]);
      yield* sql`ALTER TABLE kin_push_devices RENAME TO kin_push_devices_gone`;
      const broken = yield* Effect.exit(
        devices.unregister(caller("sess-owner-phone", owner), { orgId, token: ownerPhone }),
      );
      assert.isTrue(
        Exit.isFailure(broken) &&
          (broken.cause.reasons[0] as { error?: KinPushError }).error?.reason === "unavailable",
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("moves a re-registered device to the caller's session and DPoP key", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const row = sql<{
        session_id: string;
        proof_key_thumbprint: string | null;
        updated_at: number;
      }>`
        SELECT session_id, proof_key_thumbprint, updated_at FROM kin_push_devices
        WHERE token = ${ownerPhone}`;
      assert.deepStrictEqual(yield* row, [
        { session_id: "sess-owner-phone", proof_key_thumbprint: null, updated_at: NOW },
      ]);
      yield* TestClock.adjust("1 hour");
      yield* devices.register(
        caller("sess-owner-relay", owner, { proofKeyThumbprint: "p".repeat(43) }),
        { orgId, token: ownerPhone, platform: "ios", apsEnvironment: "development" },
      );
      assert.deepStrictEqual(yield* row, [
        {
          session_id: "sess-owner-relay",
          proof_key_thumbprint: "p".repeat(43),
          updated_at: NOW + 3_600_000,
        },
      ]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect(
    "hands a token to another person only once its session is revoked, gone, or expired and re-paired",
    () => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { sql, devices } = yield* seed;
        const phoneKey = "p".repeat(43);
        const registerFrom = (from: KinPushCaller) =>
          devices.register(from, {
            orgId,
            token: ownerPhone,
            platform: "ios",
            apsEnvironment: "development",
          });
        const takeover = registerFrom(caller("sess-member", member));
        const repair = registerFrom(
          caller("sess-member", member, { proofKeyThumbprint: phoneKey }),
        );
        const owners = sql<{ person_id: string }>`
        SELECT person_id FROM kin_push_devices WHERE token = ${ownerPhone}`;
        const refuses = (attempt: typeof takeover) =>
          Effect.gen(function* () {
            const refused = yield* Effect.exit(attempt);
            assert.isTrue(
              Exit.isFailure(refused) &&
                (refused.cause.reasons[0] as { error?: KinPushError }).error?.reason ===
                  "registered_to_someone_else",
            );
            assert.deepStrictEqual(yield* owners, [{ person_id: owner }]);
          });
        yield* refuses(takeover);
        // Two keyless callers never share a proof key, even after expiry.
        yield* sql`UPDATE auth_sessions SET expires_at = ${T} WHERE session_id = 'sess-owner-phone'`;
        yield* refuses(takeover);
        yield* sql`UPDATE auth_sessions SET expires_at = '2026-12-07T00:00:00.000Z'
        WHERE session_id = 'sess-owner-phone'`;
        yield* sql`UPDATE kin_push_devices SET proof_key_thumbprint = ${phoneKey}
        WHERE token = ${ownerPhone}`;
        // The same proof key can't take a device whose session is still live.
        yield* refuses(repair);
        yield* sql`UPDATE auth_sessions SET expires_at = ${T} WHERE session_id = 'sess-owner-phone'`;
        // Expiry alone doesn't free it for another key.
        yield* refuses(takeover);
        yield* refuses(
          registerFrom(caller("sess-member", member, { proofKeyThumbprint: "q".repeat(43) })),
        );
        yield* repair;
        assert.deepStrictEqual(yield* owners, [{ person_id: member }]);
        for (const release of [
          sql`UPDATE auth_sessions SET revoked_at = ${T} WHERE session_id = 'sess-owner-phone'`,
          sql`DELETE FROM auth_sessions WHERE session_id = 'sess-owner-phone'`,
        ]) {
          yield* sql`UPDATE kin_push_devices SET person_id = ${owner},
          session_id = 'sess-owner-phone' WHERE token = ${ownerPhone}`;
          yield* sql`INSERT OR REPLACE INTO auth_sessions (session_id, subject, scopes, method,
            issued_at, expires_at)
          VALUES ('sess-owner-phone', 'x', '[]', 'bearer-access-token', ${T},
            '2026-12-07T00:00:00.000Z')`;
          yield* release;
          yield* takeover;
          assert.deepStrictEqual(yield* owners, [{ person_id: member }]);
        }
      }).pipe(Effect.provide(build(apns)));
    },
  );

  /** A relay phone: a DPoP session that renews under a new id with the same proof key. */
  const relay = (personId: KinPersonId, proofKeyThumbprint: string, ttl: Duration.Duration) =>
    SessionStore.SessionStore.pipe(
      Effect.flatMap((sessions) => sessions.issue({ proofKeyThumbprint, ttl })),
      Effect.map((issued) => caller(issued.sessionId, personId, { proofKeyThumbprint })),
    );
  const registerToken = (from: KinPushCaller, deviceToken: KinPushToken) =>
    KinPushDevices.pipe(
      Effect.flatMap((devices) =>
        devices.register(from, {
          orgId,
          token: deviceToken,
          platform: "ios",
          apsEnvironment: "development",
        }),
      ),
    );
  const holder = (sql: SqlClient.SqlClient, deviceToken: KinPushToken) =>
    sql<{ person_id: string }>`SELECT person_id FROM kin_push_devices WHERE token = ${deviceToken}`;
  const relayToken = token("e");

  it.effect(
    "drops a relay phone revoked by its renewed session, until the owner repairs it",
    () => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { sql, devices } = yield* seed;
        const sessions = yield* SessionStore.SessionStore;
        // The phone's socket keeps the session it registered under while the session renews.
        yield* registerToken(yield* relay(owner, "relay-a", Duration.minutes(1)), relayToken);
        yield* TestClock.adjust(Duration.minutes(2));
        const renewed = yield* relay(owner, "relay-a", Duration.hours(1));
        yield* sessions.revoke(renewed.session.sessionId);
        yield* devices.reconcileSessions();
        assert.deepStrictEqual(yield* holder(sql, relayToken), []);

        const repaired = yield* repairProofKey("relay-a");
        yield* registerToken(
          caller(repaired.sessionId, owner, { proofKeyThumbprint: "relay-a" }),
          relayToken,
        );
        yield* devices.reconcileSessions();
        assert.deepStrictEqual(yield* holder(sql, relayToken), [{ person_id: owner }]);
      }).pipe(Effect.provide(buildRelay(apns)));
    },
  );

  it.effect("signing out other devices from a phone keeps its own device", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const sessions = yield* SessionStore.SessionStore;
      const otherToken = token("f");
      yield* registerToken(yield* relay(owner, "relay-a", Duration.hours(1)), relayToken);
      yield* registerToken(yield* relay(member, "relay-b", Duration.hours(1)), otherToken);
      yield* TestClock.adjust(Duration.minutes(30));
      // Both renew early; the phone's first session is still live when it signs the others out.
      const current = yield* relay(owner, "relay-a", Duration.hours(1));
      yield* relay(member, "relay-b", Duration.hours(1));
      yield* sessions.revokeAllExcept(current.session.sessionId);
      yield* devices.reconcileSessions();
      assert.deepStrictEqual(yield* holder(sql, relayToken), [{ person_id: owner }]);
      assert.deepStrictEqual(yield* holder(sql, otherToken), []);
    }).pipe(Effect.provide(buildRelay(apns)));
  });

  it.effect("revoking a session after it expired keeps its device", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const sessions = yield* SessionStore.SessionStore;
      const phone = yield* relay(owner, "relay-a", Duration.minutes(1));
      yield* registerToken(phone, relayToken);
      yield* TestClock.adjust(Duration.minutes(2));
      yield* sessions.revoke(phone.session.sessionId);
      yield* devices.reconcileSessions();
      assert.deepStrictEqual(yield* holder(sql, relayToken), [{ person_id: owner }]);
    }).pipe(Effect.provide(buildRelay(apns)));
  });

  it.effect(
    "hands a relay phone's token to another person only once reconcile would drop it",
    () => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { sql } = yield* seed;
        const sessions = yield* SessionStore.SessionStore;
        const first = yield* relay(owner, "relay-a", Duration.minutes(1));
        yield* registerToken(first, relayToken);
        yield* TestClock.adjust(Duration.minutes(2));
        const takeover = registerToken(caller("sess-member", member), relayToken);
        yield* sessions.revoke(first.session.sessionId);
        const refused = yield* Effect.exit(takeover);
        assert.isTrue(
          Exit.isFailure(refused) &&
            (refused.cause.reasons[0] as { error?: KinPushError }).error?.reason ===
              "registered_to_someone_else",
        );
        yield* sessions.revoke(
          (yield* relay(owner, "relay-a", Duration.hours(1))).session.sessionId,
        );
        yield* takeover;
        assert.deepStrictEqual(yield* holder(sql, relayToken), [{ person_id: member }]);
      }).pipe(Effect.provide(buildRelay(apns)));
    },
  );

  it.effect("keeps the ten most recently registered devices per person", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const fills = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
      for (const fill of fills) {
        yield* TestClock.adjust("1 minute");
        yield* devices.register(caller("sess-owner-phone", owner), {
          orgId,
          token: token(fill),
          platform: "ios",
          apsEnvironment: "production",
        });
      }
      const owned = sql<{ token: string }>`SELECT token FROM kin_push_devices
        WHERE person_id = ${owner} ORDER BY updated_at, token`;
      // The phone and tablet from the seed were the oldest two of twelve.
      assert.deepStrictEqual(
        (yield* owned).map((row) => row.token),
        fills.map(token),
      );
      assert.strictEqual(fills.length, Devices.KIN_PUSH_DEVICES_PER_PERSON);
      // Someone else's devices don't count against the owner's.
      assert.deepStrictEqual(
        (yield* tokens(sql)).filter((row) => row.person_id === member).map((row) => row.token),
        [memberPhone],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("drops a dead token, unless the phone registered it again since", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const notifyOwner = Effect.gen(function* () {
        const messageId = yield* postMessage(
          sql,
          { personId: member, memberId: "m_priya" },
          "posted",
          {
            mentions: ["m_owner"],
          },
        );
        return yield* notify({ _tag: "message", orgId, messageId });
      });
      // A wrong topic is our misconfiguration: the token stays.
      apns.answers.set(ownerTablet, { status: 400, reason: "DeviceTokenNotForTopic" });
      // Apple saw the phone's token die before the phone registered it (at NOW).
      apns.answers.set(ownerPhone, { status: 410, reason: "Unregistered", timestamp: NOW - 1 });
      assert.deepStrictEqual(yield* notifyOwner, {
        status: "ready",
        sent: 0,
        suppressed: 0,
        failed: 2,
      });
      assert.deepStrictEqual(
        (yield* tokens(sql)).map((row) => row.token),
        [ownerPhone, ownerTablet, memberPhone],
      );

      apns.answers.set(ownerPhone, { status: 410, reason: "Unregistered", timestamp: NOW + 1 });
      apns.answers.set(ownerTablet, { status: 400, reason: "BadDeviceToken" });
      yield* notifyOwner;
      assert.deepStrictEqual(
        (yield* tokens(sql)).map((row) => row.token),
        [memberPhone],
      );
    }).pipe(Effect.provide(build(apns)));
  });
});
