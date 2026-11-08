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
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SessionStore from "../../auth/SessionStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ApproverKeys from "../approvals/ApproverKeys.ts";
import { KinAttestationTrust } from "../approvals/attestation/AttestationTrust.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import { layerKinAuthTest, repairProofKey } from "../auth/ProofKeySessions.testkit.ts";
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
    Layer.provideMerge(PendingActions.layer),
    Layer.provide(Layer.succeed(KinAttestationTrust, { load: () => Effect.die("unused") })),
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
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES ('chat_team', 'org_01', 'project_group', 0, ${T})`;
  for (const [memberId, person, role] of [
    ["m_owner", owner, "owner"],
    ["m_priya", member, "member"],
  ] as const) {
    yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, person_id,
        role, joined_at)
      VALUES (${memberId}, 'org_01', 'chat_team', 'person', ${person}, ${role}, ${T})`;
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

const postMessage = (
  sql: SqlClient.SqlClient,
  author: { readonly personId: KinPersonId; readonly memberId: string } | "system",
  status = "posted",
) =>
  Effect.gen(function* () {
    const [{ seq }] = (yield* sql<{ seq: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM kin_messages`) as [{ seq: number }];
    const messageId = KinMessageId.make(`msg_${seq}`);
    const human = author !== "system";
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_member_id, author_role, kind, body, mentions_json, status, created_at)
      VALUES (${messageId}, 'org_01', 'chat_team', ${seq}, ${human ? "human" : "system"},
        ${human ? author.personId : null}, ${human ? author.memberId : null}, 'member', 'text',
        'Ship it before Friday, the secret is hunter2', '[]', ${status}, ${T})`;
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
        provenance: { startedBy: { humanId: member }, startedByRole: "member", chain: [] },
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
          alert: { title: "Deferred", body: "A deferral needs a look" },
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

      apns.sent.length = 0;
      const messageId = yield* postMessage(sql, { personId: owner, memberId: "m_owner" });
      yield* notify({ _tag: "message", orgId, messageId });
      // The author doesn't hear about their own message, and the text never leaves the server.
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [memberPhone],
      );
      assert.deepStrictEqual(categories(apns.sent), ["kin.message"]);
      assert.include(
        JSON.stringify(apns.sent[0]?.payload),
        '"deepLink":"/kin/env_kin/org_01/chats/',
      );
      assert.notInclude(JSON.stringify(apns.sent), "hunter2");
      // Messages collapse per chat; cards don't, since each one waits on something different.
      assert.match(apns.sent[0]?.collapseId ?? "", /^kin:[0-9a-f]{12}$/);
      // A suggestion only the owner can see isn't announced to anyone.
      const suggested = yield* postMessage(sql, "system", "suggested");
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: suggested })).sent, 0);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("skips a device while its session watches the chat and acks", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const presence = yield* KinPushPresence;
      const phone = AuthSessionId.make("sess-owner-phone");
      const chat = KinChatId.make("chat_team");
      const messageId = yield* postMessage(sql, { personId: member, memberId: "m_priya" });
      const watching = yield* presence
        .watch(phone, chat)
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      const watched = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(watched, { status: "ready", sent: 1, suppressed: 1, failed: 0 });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [ownerTablet],
      );
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

  it.effect("reaches only people still in the chat, in this org, and not muted", () => {
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
          const messageId = yield* postMessage(sql, { personId: owner, memberId: "m_owner" });
          yield* notify({ _tag: "message", orgId, messageId });
          return apns.sent.map((push) => push.token);
        });
      assert.deepStrictEqual(yield* recipients(null, null), [memberPhone]);
      // 03:00 at +05:00 is 22:00Z yesterday: the mute is over, though the text sorts later.
      assert.deepStrictEqual(yield* recipients("2026-11-08T03:00:00+05:00", null), [memberPhone]);
      assert.deepStrictEqual(yield* recipients("2026-11-08T01:00:00Z", null), []);
      assert.deepStrictEqual(yield* recipients(null, T), []);
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
      const messageId = yield* postMessage(sql, { personId: member, memberId: "m_priya" });
      const outcome = yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(outcome, { status: "ready", sent: 6, suppressed: 0, failed: 0 });
      assert.strictEqual(peak, 4);
      assert.strictEqual(started.length, 6);
    }).pipe(Effect.provide(build(apns)));
  });

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

  it.effect("hands a token to another person only once its session is revoked or gone", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sql, devices } = yield* seed;
      const takeover = devices.register(caller("sess-member", member), {
        orgId,
        token: ownerPhone,
        platform: "ios",
        apsEnvironment: "development",
      });
      const owners = sql<{ person_id: string }>`
        SELECT person_id FROM kin_push_devices WHERE token = ${ownerPhone}`;
      const refused = yield* Effect.exit(takeover);
      assert.isTrue(
        Exit.isFailure(refused) &&
          (refused.cause.reasons[0] as { error?: KinPushError }).error?.reason === "not_member",
      );
      assert.deepStrictEqual(yield* owners, [{ person_id: owner }]);
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
  });

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
            (refused.cause.reasons[0] as { error?: KinPushError }).error?.reason === "not_member",
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
        const messageId = yield* postMessage(sql, { personId: member, memberId: "m_priya" });
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
