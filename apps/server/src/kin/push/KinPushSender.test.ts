import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  KinAgentId,
  KinChatId,
  KinChoiceCardState,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinRecordKey,
  KinWidgetId,
  type KinPushError,
  type KinPushToken,
  type KinPushTopic,
  kinPeopleChatTeamId,
  KIN_DEVICE_LINKED_NOTICE,
} from "@t3tools/contracts";
import * as Arbitrary from "effect/Arbitrary";
import * as DateTime from "effect/DateTime";
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
import { KinKeyNotices } from "../approvals/ExecutionNotices.ts";
import * as GrantPorts from "../approvals/GrantPorts.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import { layerKinAuthTest, repairProofKey } from "../auth/ProofKeySessions.testkit.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import { KinApnsTransport, type KinApnsPush, type KinApnsResult } from "./Apns.ts";
import { KinFcmTransport, type KinFcmPush, type KinFcmResult } from "./Fcm.ts";
import { KinPushDevices, type KinPushCaller } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";
import * as Devices from "./KinPushDevices.ts";
import { layerTrusting, watcher } from "./KinPushPresence.testkit.ts";
import { deliverHeld } from "../triggers/heldDelivery.ts";
import { tellOnTasks } from "../work/assignNotices.ts";
import { byId } from "../work/recordRows.ts";
import * as Sender from "./KinPushSender.ts";
import { kinTopicCollapseId, prunePushSent } from "./KinPushTopics.ts";

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

/** A fake FCM, unconfigured unless a test gives Android phones a sender. */
const makeFcm = (
  status: "ready" | "unconfigured" = "unconfigured",
  respond: (push: KinFcmPush) => Effect.Effect<KinFcmResult | undefined> = () => Effect.undefined,
) => {
  const sent: Array<KinFcmPush> = [];
  const layer = Layer.succeed(KinFcmTransport, {
    status,
    send: (push) =>
      Effect.sync(() => sent.push(push)).pipe(
        Effect.andThen(respond(push)),
        Effect.map((answer) => answer ?? { status: 200, reason: undefined }),
      ),
  });
  return { sent, layer };
};

const buildOn = <A, E, R>(
  apns: ReturnType<typeof makeApns>,
  database: Layer.Layer<A, E, R>,
  fcm: ReturnType<typeof makeFcm> = makeFcm(),
) =>
  Sender.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(Devices.layer, layerTrusting, apns.layer, fcm.layer)),
    Layer.provideMerge(ApproverKeys.layer),
    Layer.provide(MemoryCache.layer),
    Layer.provideMerge(Repository.layer),
    Layer.provideMerge(PendingActions.layer),
    Layer.provideMerge(Audit.layer),
    Layer.provide(Layer.succeed(KinAttestationTrust, { load: () => Effect.die("unused") })),
    Layer.provide(KeySeal.layerTest()),
    Layer.provide(
      Layer.mergeAll(
        GrantPorts.orgRolesLayer,
        Layer.succeed(KinKeyNotices, { changed: () => Effect.void }),
      ),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env_kin")),
      }),
    ),
    Layer.provideMerge(Layer.provideMerge(KinPersistence.layer, database)),
  );
const build = (apns: ReturnType<typeof makeApns>, fcm?: ReturnType<typeof makeFcm>) =>
  buildOn(apns, Sqlite.layerMemory, fcm);
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
    readonly messageId?: string;
    readonly kind?: "text" | "system";
  } = {},
) =>
  Effect.gen(function* () {
    const [{ seq }] = (yield* sql<{ seq: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM kin_messages`) as [{ seq: number }];
    const messageId = KinMessageId.make(options.messageId ?? `msg_${seq}`);
    const human = typeof author === "object" && "personId" in author;
    const agent = typeof author === "object" && "agentMemberId" in author;
    yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind,
        author_person_id, author_agent_id, author_owner_person_id, author_thread_id,
        author_member_id, author_role, kind, body, mentions_json, reply_to, status, created_at, silent)
      VALUES (${messageId}, 'org_01', ${options.chatId ?? "chat_team"}, ${seq},
        ${human ? "human" : agent ? "agent" : "system"}, ${human ? author.personId : null},
        ${agent ? "lead_fin" : null}, ${agent ? owner : null}, ${agent ? "thread-fin" : null},
        ${human ? author.memberId : agent ? author.agentMemberId : null}, 'member',
        ${options.kind ?? "text"},
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
  body?: string,
) =>
  Effect.gen(function* () {
    const messageId = yield* postMessage(
      sql,
      "system",
      "posted",
      body === undefined ? {} : { body },
    );
    const widgetId = KinWidgetId.make(`w_${messageId}`);
    yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type,
        revision, state_json, awaiting_json, updated_at)
      VALUES (${widgetId}, 'org_01', 'chat_team', ${messageId}, 'native', ${type}, 3,
        ${JSON.stringify(state)}, ${JSON.stringify(awaiting)}, ${T})`;
    return widgetId;
  });

/** The owner and Priya's own chat, as a direct message between two people. */
const pairChat = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, last_seq, created_at)
      VALUES ('chat_pair', 'org_01', 'team_group', NULL, ${kinPeopleChatTeamId(owner, member)},
        0, ${T})`;
    for (const [memberId, person] of [
      ["m_owner_pair", owner],
      ["m_priya_pair", member],
    ] as const)
      yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
          person_id, role, joined_at)
        VALUES (${memberId}, 'org_01', 'chat_pair', 'person', ${person}, 'member', ${T})`;
  });

const alerts = (sent: ReadonlyArray<KinApnsPush>) =>
  sent.map(
    (push) => (push.payload as { aps: { alert?: { title: string; body: string } } }).aps.alert,
  );

const isChoiceCard = Schema.is(KinChoiceCardState);

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
          // A tap opens the card itself, in its chat.
          subject: { _tag: "message", messageId: `msg_${widgetId.slice("w_msg_".length)}` },
          deepLink: "/kin/env_kin/org_01/chats/chat_team",
        },
      });
      assert.isUndefined(apns.sent[0]?.collapseId);
      // A due start asks first, so its heads-up promises no start.
      apns.sent.length = 0;
      const headsUp = yield* postWidget(sql, "deferral", { phase: "heads_up" }, [owner]);
      yield* notify({ _tag: "widget", orgId, widgetId: headsUp });
      assert.deepNestedInclude(apns.sent[0]?.payload, {
        "aps.alert": { title: "Payments team", body: "A deferred task is due soon." },
      });

      // A question card with no message of its own says what it asks, in the card's words.
      apns.sent.length = 0;
      const asked = yield* postWidget(
        sql,
        "choice",
        { question: "Confirm receipt R-12 from Harbourline?", options: [] },
        [member],
        "",
      );
      yield* notify({ _tag: "widget", orgId, widgetId: asked });
      assert.deepStrictEqual(alerts(apns.sent), [
        { title: "Payments team", body: "Confirm receipt R-12 from Harbourline?" },
      ]);
      // It carries an id of its own, as its messages do.
      assert.match(apns.sent[0]?.collapseId ?? "", /^kin:/);

      // An agent's open question with two plain answers carries them as the notice's buttons.
      const question = (labels: ReadonlyArray<string>, extra: object = {}) => ({
        question: "Is the Harbourline NDA signed?",
        detail: null,
        options: labels.map((label, index) => ({ optionId: `option-${index + 1}`, label })),
        answer: null,
        ...extra,
      });
      const ask = (state: object, open: boolean, draft: string | null = null) =>
        Effect.gen(function* () {
          const widgetId = yield* postWidget(sql, "choice", state, [member], "Quick one on W-8.");
          if (open)
            yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id,
                chat_id, kind, widget_id, question, safe, asked_at, due_at, act_at, state,
                draft_json)
              VALUES (${`q_${widgetId}`}, 'org_01', 'lead_fin', ${member}, 'chat_team', 'card',
                ${widgetId}, 'Is it signed?', 0, ${NOW}, ${NOW}, ${NOW}, 'open', ${draft})`;
          apns.sent.length = 0;
          yield* notify({ _tag: "widget", orgId, widgetId });
          return widgetId;
        });
      const choice = yield* ask(question(["Signed", "Not yet"]), true);
      assert.deepStrictEqual(categories(apns.sent), ["kin.choice"]);
      assert.deepStrictEqual(alerts(apns.sent), [
        {
          title: "Payments team",
          body: "Is the Harbourline NDA signed?\n1 · Signed\n2 · Not yet",
        },
      ]);
      assert.deepStrictEqual(
        (apns.sent[0]?.payload as { body: { choices: unknown } } | undefined)?.body.choices,
        ["option-1", "option-2"],
      );
      assert.isUndefined(apns.sent[0]?.collapseId, choice);
      // Three answers, Kin's own Confirm (no open question), an answer that acts or sends, a
      // sent-up draft (approved where it is read, R12): a plain notice whose tap opens the card.
      for (const [state, open, draft] of [
        [question(["Signed", "Not yet", "Lost it"]), true],
        [question(["Confirm", "Cancel"]), false],
        [
          question(["Start W-8", "Not yet"], {
            options: [
              { optionId: "option-1", label: "Start W-8", action: { line: "Starts W-8." } },
              { optionId: "option-2", label: "Not yet" },
            ],
          }),
          true,
        ],
        [
          question(["Confirm", "Cancel"], {
            send: {
              service: "Gmail",
              action: "email",
              from: "rhea@ambermill.example",
              to: ["legal@harbourline.example"],
              cc: [],
              subject: "NDA",
              body: "Signed copy attached.",
              attachments: [],
              outcome: null,
            },
          }),
          true,
        ],
        [
          question(["Approve", "Changes first"], {
            draft: "## Harbourline retainer\n\nMonthly fee: ₹2,50,000",
          }),
          true,
          '{"kind":"proposal","text":"## Harbourline retainer"}',
        ],
      ] as const) {
        assert.isTrue(isChoiceCard(state));
        yield* ask(state, open, draft);
        assert.deepStrictEqual(categories(apns.sent), ["kin.message"], JSON.stringify(state));
        assert.deepStrictEqual(alerts(apns.sent), [
          { title: "Payments team", body: "Quick one on W-8." },
        ]);
      }

      // Kin's own unprompted card (a recommendation) waits on them without ringing: a badge only.
      apns.sent.length = 0;
      const unprompted = yield* postWidget(
        sql,
        "choice",
        { question: "Let Meera message Tech lead directly?", options: [] },
        [member],
        "",
      );
      yield* sql`UPDATE kin_messages SET silent = 1 WHERE message_id =
        (SELECT message_id FROM kin_widgets WHERE widget_id = ${unprompted})`;
      yield* notify({ _tag: "widget", orgId, widgetId: unprompted });
      assert.isAbove(apns.sent.length, 0);
      assert.deepStrictEqual(
        alerts(apns.sent).filter((alert) => alert !== undefined),
        [],
      );

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

  it.effect("a push opens the one entry it names, as the person it reaches may open it", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      yield* sql`UPDATE kin_people SET access = CASE person_id WHEN ${owner} THEN 'owner'
        ELSE 'member' END`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES ('org_01', 'clients', 'Clients', 'C', 1, 0), ('org_01', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org_01', 'c1', 'clients', 'C-1', 'Orbit Dental', 'person', ${owner}, 0,
            'person', 'c1', 0, 0),
          ('org_01', 'w1', 'work', 'W-1', 'Logo files', 'person', ${member}, 0, 'person', 'w1', 0, 0)`;
      // A line from one of them to the other: what each tap opens for whoever it reached.
      const subjects = (from: "owner" | "priya", body: string) =>
        Effect.gen(function* () {
          apns.sent.length = 0;
          const author =
            from === "owner"
              ? { personId: owner, memberId: "m_owner" }
              : { personId: member, memberId: "m_priya" };
          const messageId = yield* postMessage(sql, author, "posted", {
            mentions: [from === "owner" ? "m_priya" : "m_owner"],
            body,
          });
          yield* notify({ _tag: "message", orgId, messageId });
          return apns.sent.map(
            (push) => (push.payload as { body: { subject?: unknown } }).body.subject,
          );
        });
      const task = { _tag: "record", key: "W-1", kind: "task" };
      const client = { _tag: "record", key: "C-1", kind: "client" };
      // Priya may open her task, not the owner's client: only the task is hers to land on.
      assert.deepStrictEqual(yield* subjects("owner", "W-1 is ready to send."), [task]);
      assert.deepStrictEqual(yield* subjects("owner", "C-1 and W-1 wait on the files."), [task]);
      assert.deepStrictEqual(yield* subjects("owner", "Orbit Dental renews next week."), [
        undefined,
      ]);
      // The owner may open both, so a line naming both is about neither; one naming one opens it.
      assert.deepStrictEqual(yield* subjects("priya", "C-1 and W-1 wait on the files."), [
        undefined,
        undefined,
      ]);
      assert.deepStrictEqual(yield* subjects("priya", "Orbit Dental signed."), [client, client]);

      // Kin's notice of Priya's late work lands on her Tasks; of one task, on that task.
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org_01', 'w2', 'work', 'W-2', 'Brand deck', 'person', ${member}, 0, 'person',
            'w2', 0, 0),
          ('org_01', 'w3', 'work', 'W-3', 'Print run', 'person', ${member}, 0, 'person', 'w3', 0, 0),
          ('org_01', 'w9', 'work', 'W-9', 'Payroll', 'person', ${owner}, 1, 'person', 'w9', 0, 0)`;
      let notices = 0;
      const told = (
        body: string,
        author: "system" | { agentMemberId: string } = "system",
        id = `kin-holder-${notices + 1}`,
      ) =>
        Effect.gen(function* () {
          apns.sent.length = 0;
          notices += 1;
          const messageId = yield* postMessage(sql, author, "posted", {
            ...(author === "system" ? { messageId: id, kind: "system" as const } : {}),
            mentions: ["m_priya"],
            body,
          });
          yield* notify({ _tag: "message", orgId, messageId });
          return apns.sent.map(
            (push) => (push.payload as { body: { subject?: unknown } }).body.subject,
          );
        });
      const lines =
        "3 of your tasks need you:\n• W-1 Logo files\n• W-2 Brand deck\n• W-3 Print run";
      assert.deepStrictEqual(yield* told(lines), [{ _tag: "tasks" }]);
      assert.deepStrictEqual(yield* told("W-1 Logo files due today."), [task]);
      // Held through her away time, it posts under the hold's id and still opens Tasks.
      yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
          audience, held_at, deliver_at)
        VALUES ('hold-1', 'org_01', 'chat_team', ${member}, 'kin-holder-held', ${lines}, 'chat',
          0, 0)`;
      assert.deepStrictEqual(yield* told(lines, "system", "kin-held:hold-1"), [{ _tag: "tasks" }]);
      // An agent naming several still opens the chat; a key she may not open is never counted.
      assert.deepStrictEqual(yield* told(lines, { agentMemberId: "m_fin" }), [undefined]);
      assert.deepStrictEqual(yield* told("2 of your tasks need you:\n• W-1\n• W-9"), [task]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("rings a page's takeaway without its figure reference", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const messageId = yield* postMessage(sql, { agentMemberId: "m_fin" }, "posted", {
        body: "Two tasks are late.\n\n```kin_visual This week\nf_example000\n```",
      });
      yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm' WHERE message_id = ${messageId}`;
      yield* notify({ _tag: "message", orgId, messageId });
      assert.isAbove(apns.sent.length, 0);
      for (const alert of alerts(apns.sent)) assert.strictEqual(alert?.body, "Two tasks are late.");
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("a card its turn's reply already rang for rings only those the reply didn't", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      // The lead asks both people in the group; its reply goes on to name only Priya.
      const card = yield* postWidget(
        sql,
        "choice",
        { question: "Which projects are finished?", options: [] },
        [owner, member],
        "",
      );
      const reply = yield* postMessage(sql, { agentMemberId: "m_fin" }, "posted", {
        body: "PR #87 isn't ready to merge.",
        mentions: ["m_priya"],
      });
      // Only a ring tells: before the reply rang Priya, she still hears of the card.
      apns.sent.length = 0;
      yield* notify({ _tag: "widget", orgId, widgetId: card, covered: [reply] });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token).toSorted(),
        [ownerPhone, ownerTablet, memberPhone].toSorted(),
      );
      yield* notify({ _tag: "message", orgId, messageId: reply });
      apns.sent.length = 0;
      yield* notify({ _tag: "widget", orgId, widgetId: card, covered: [reply] });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [ownerPhone, ownerTablet],
      );
      // A reply that only set her badge, the half hour's ring spent, left her the card's banner.
      const again = yield* postMessage(sql, { agentMemberId: "m_fin" }, "posted", {
        body: "Still waiting on CI.",
        mentions: ["m_priya"],
      });
      yield* TestClock.adjust("1 minute");
      yield* sql`UPDATE kin_messages SET created_at = ${DateTime.formatIso(DateTime.makeUnsafe(NOW + 60_000))}
        WHERE message_id = ${again}`;
      yield* notify({ _tag: "message", orgId, messageId: again });
      assert.deepStrictEqual(alerts(apns.sent.slice(-1)), [undefined]);
      apns.sent.length = 0;
      yield* notify({ _tag: "widget", orgId, widgetId: card, covered: [again] });
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token).toSorted(),
        [ownerPhone, ownerTablet, memberPhone].toSorted(),
      );
      // In the owner's DM the reply rings him, so the card adds no second banner.
      yield* sql`UPDATE kin_widgets SET chat_id = 'chat_dm' WHERE widget_id = ${card}`;
      yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm' WHERE message_id IN (${reply},
        (SELECT message_id FROM kin_widgets WHERE widget_id = ${card}))`;
      yield* notify({ _tag: "message", orgId, messageId: reply });
      apns.sent.length = 0;
      assert.strictEqual(
        (yield* notify({ _tag: "widget", orgId, widgetId: card, covered: [reply] })).sent,
        0,
      );
      // The card's own message has no words, so it never rings as a message either.
      const [{ messageId: anchor }] = (yield* sql<{ messageId: KinMessageId }>`
        SELECT message_id AS "messageId" FROM kin_widgets WHERE widget_id = ${card}`) as [
        { messageId: KinMessageId },
      ];
      yield* sql`UPDATE kin_messages SET body = 'The review is tomorrow.', source_wakeup_id = 'asked', widget_id = ${card}
        WHERE message_id = ${anchor}`;
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: anchor })).sent, 0);
      yield* sql`UPDATE kin_widgets SET awaiting_json = '[]' WHERE widget_id = ${card}`;
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: anchor })).sent, 0);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("says what each notice is, and rings for your own work and Kin's choices", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const dm = { agentMemberId: "m_fin_dm" } as const;
      const told = () =>
        apns.sent.slice(0, 1).map((push) => {
          const { aps, body } = push.payload as {
            aps: { alert?: { title: string; body: string } };
            body: { subject?: unknown };
          };
          return { alert: aps.alert ?? null, subject: body.subject ?? null };
        })[0];
      const say = (body: string, options: { messageId?: string; kind?: "system" } = {}) =>
        Effect.gen(function* () {
          apns.sent.length = 0;
          const messageId = yield* postMessage(
            sql,
            options.kind === "system" ? "system" : dm,
            "posted",
            { chatId: "chat_dm", body, ...options },
          );
          yield* notify({ _tag: "message", orgId, messageId });
          return { messageId, ...told() };
        });
      // 09:00 in New York: the morning brief rings and spends the half hour's one ring.
      yield* TestClock.setTime(Date.parse("2026-11-08T14:00:00Z"));
      apns.sent.length = 0;
      const brief = yield* postMessage(sql, dm, "posted", {
        chatId: "chat_dm",
        body: "## Needs you\n- The Orbit Dental renewal waits on you.\n\n## Money\nNothing new.",
      });
      yield* sql`UPDATE kin_messages SET form = 'brief' WHERE message_id = ${brief}`;
      yield* notify({ _tag: "message", orgId, messageId: brief });
      assert.deepStrictEqual(told(), {
        alert: {
          title: "Finance · Morning brief",
          body: "Good morning · The Orbit Dental renewal waits on you.",
        },
        // A tap opens the brief itself, not wherever the chat was left.
        subject: { _tag: "message", messageId: brief },
      });
      // Kin's word on her own work rings after it; an agent's other unprompted line doesn't.
      const due = yield* say("W-8 Sign the NDA due today.", {
        messageId: "kin-holder-due",
        kind: "system",
      });
      assert.deepStrictEqual(due.alert, {
        title: "Finance · Your tasks",
        body: "W-8 Sign the NDA due today.",
      });
      assert.isNull((yield* say("Payroll for November is ready.")).alert);
      // So does a default Kin took for her, as a line or as a card with Undo.
      const taken = yield* say("Nobody answered, so I went with “Same terms” for C-2 Orbit.", {
        messageId: "kin-default-taken:q1",
      });
      assert.deepStrictEqual(taken.alert?.title, "Finance · Decided for you");
      // Held through her quiet hours, it rings at their end though another held line rang first.
      yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00Z"));
      yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
          audience, held_at, deliver_at, agent_id)
        VALUES ('hold-relay', 'org_01', 'chat_dm', ${owner}, 'kin-relay:wk:1', 'From Priya', 'chat',
            0, 0, 'lead_fin'),
          ('hold-taken', 'org_01', 'chat_dm', ${owner}, 'kin-default-taken:q2', 'I went', 'chat',
            1, 0, 'lead_fin')`;
      assert.isNotNull(
        (yield* say("Priya asked: are we closed Friday?", { messageId: "kin-held:hold-relay" }))
          .alert,
      );
      assert.deepStrictEqual(
        (yield* say("Nobody answered, so I went with “Keep it”.", {
          messageId: "kin-held:hold-taken",
        })).alert?.title,
        "Finance · Decided for you",
      );
      const card = (type: string, state: object, clientId: string | null, body = "") =>
        Effect.gen(function* () {
          const widgetId = yield* postWidget(sql, type, state, [owner], body);
          yield* sql`UPDATE kin_widgets SET chat_id = 'chat_dm' WHERE widget_id = ${widgetId}`;
          yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm', client_message_id = ${clientId}
            WHERE message_id = (SELECT message_id FROM kin_widgets WHERE widget_id = ${widgetId})`;
          apns.sent.length = 0;
          yield* notify({ _tag: "widget", orgId, widgetId });
          return told()?.alert;
        });
      assert.deepStrictEqual(
        yield* card("choice", { question: "Renew Orbit on the same terms?", options: [] }, null),
        { title: "Finance · Question", body: "Renew Orbit on the same terms?" },
      );
      assert.strictEqual(
        (yield* card("choice", { question: "Undo?", options: [] }, "send:kin-default-taken:q3"))
          ?.title,
        "Finance · Decided for you",
      );
      // A brief that carries a card opens under its greeting, as one without a card does.
      const briefCard = yield* postWidget(
        sql,
        "choice",
        { question: "Renew?", options: [] },
        [owner],
        "## Needs you\n- Renew Orbit Dental on the same terms?",
      );
      yield* sql`UPDATE kin_widgets SET chat_id = 'chat_dm' WHERE widget_id = ${briefCard}`;
      yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm', form = 'brief'
        WHERE message_id = (SELECT message_id FROM kin_widgets WHERE widget_id = ${briefCard})`;
      apns.sent.length = 0;
      yield* notify({ _tag: "widget", orgId, widgetId: briefCard });
      assert.deepStrictEqual(told()?.alert, {
        title: "Finance · Morning brief",
        body: "Good morning · Renew Orbit Dental on the same terms?",
      });

      // A reply whose turn left a card waiting on her opens at that card, wherever it sits.
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead_fin', 'org_01', 'Finance', 0, '[]', '[]', 'chat_dm')`;
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids)
        VALUES ('wk_plan', 'org_01', 'lead_fin', 'opus', ${NOW}, 'running', '[]')`;
      const asked = yield* postWidget(sql, "choice", { question: "Meera?", options: [] }, [owner]);
      const [{ anchor }] = (yield* sql<{ anchor: KinMessageId }>`SELECT message_id AS anchor
        FROM kin_widgets WHERE widget_id = ${asked}`) as [{ anchor: KinMessageId }];
      yield* sql`UPDATE kin_widgets SET chat_id = 'chat_dm' WHERE widget_id = ${asked}`;
      yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm', body = '', source_wakeup_id = 'wk_plan'
        WHERE message_id = ${anchor}`;
      const plan = yield* say("I've written next week's plan; Meera waits on your yes.");
      assert.deepStrictEqual(plan.subject, { _tag: "message", messageId: anchor });
      // Answered, the card no longer waits, and the reply opens the chat as before.
      yield* sql`UPDATE kin_widgets SET awaiting_json = '[]' WHERE widget_id = ${asked}`;
      assert.isNull((yield* say("One more change to the plan.")).subject);
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
      const earlier = new Set<string | undefined>();
      for (const [name, author, options, expected] of cases) {
        apns.sent.length = 0;
        const messageId = yield* postMessage(sql, author, "posted", options);
        yield* notify({ _tag: "message", orgId, messageId });
        assert.deepStrictEqual(
          apns.sent.map((push) => push.token),
          [...expected],
          name,
        );
        for (const push of apns.sent) earlier.add(push.collapseId);
      }

      // Another unprompted line for Priya inside half an hour lands without ringing; after it, rings.
      apns.sent.length = 0;
      const again = yield* postMessage(sql, fin, "posted", { mentions: ["m_priya"] });
      yield* notify({ _tag: "message", orgId, messageId: again });
      assert.deepStrictEqual(alerts(apns.sent), [undefined]);
      yield* TestClock.adjust("31 minutes");

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
      // Each message is its own notification: a phone tells taps apart by this id.
      assert.isFalse(earlier.has(apns.sent[0]?.collapseId));

      apns.sent.length = 0;
      const dm = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
        body: long,
      });
      yield* notify({ _tag: "message", orgId, messageId: dm });
      const [first] = alerts(apns.sent);
      // In a direct chat the title says what kind of notice it is.
      assert.strictEqual(first?.title, "Finance · Update");
      // The whole reply: the lock screen shows it all, nothing cut at a banner's length.
      assert.strictEqual(first?.body, long.trim());

      // One past APNs' payload limit is cut to fit it, at the end of a sentence.
      apns.sent.length = 0;
      const essay = yield* postMessage(sql, { personId: member, memberId: "m_priya" }, "posted", {
        mentions: ["m_owner"],
        body: "The Q3 ledger reconciles against the bank statement line by line. ".repeat(90),
      });
      yield* notify({ _tag: "message", orgId, messageId: essay });
      assert.lengthOf(alerts(apns.sent), 2);
      for (const push of apns.sent) {
        assert.isAtMost(new TextEncoder().encode(JSON.stringify(push.payload)).length, 4096);
        assert.match(alerts([push])[0]?.body ?? "", /line by line\.…$/);
      }

      // A check-in greets only when it has sections, and then leads with its first real line.
      for (const [body, expected] of [
        ["Done.", /^Done\.$/],
        [
          "## Work\nW-2 is due today.\n\n## Money\nNothing new.",
          /^Good (morning|afternoon|evening) · W-2 is due today\.$/,
        ],
      ] as const) {
        yield* TestClock.adjust("31 minutes");
        apns.sent.length = 0;
        const brief = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
          chatId: "chat_dm",
          body,
        });
        yield* sql`UPDATE kin_messages SET form = 'brief' WHERE message_id = ${brief}`;
        yield* notify({ _tag: "message", orgId, messageId: brief });
        assert.match(alerts(apns.sent)[0]?.body ?? "", expected);
      }

      apns.sent.length = 0;
      yield* sql`UPDATE kin_people SET display_name = 'Rhea Das' WHERE person_id = ${member}`;
      const words = "Can you review the Lumen invoice?";
      const relayed = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
        body: `Rhea Das asked Finance:\n"${words}"`,
      });
      yield* sql`UPDATE kin_messages SET relay_json = ${JSON.stringify({
        kind: "sent_by",
        personId: member,
        agentId: "lead_fin",
      })} WHERE message_id = ${relayed}`;
      yield* notify({ _tag: "message", orgId, messageId: relayed });
      assert.deepStrictEqual(alerts(apns.sent), [
        { title: "Rhea, via Finance", body: words },
        { title: "Rhea, via Finance", body: words },
      ]);

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

  it.effect(
    "the first unprompted line after a quiet spell rings, even before a phone was there",
    () => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { notify, sql, devices } = yield* seed;
        const fin = { agentMemberId: "m_fin" } as const;
        const mention = () => postMessage(sql, fin, "posted", { mentions: ["m_priya"] });
        // Priya's phone is not registered yet: what was meant to ring her reached nothing.
        yield* sql`DELETE FROM kin_push_devices WHERE person_id = ${member}`;
        yield* notify({ _tag: "message", orgId, messageId: yield* mention() });
        yield* devices.register(caller("sess-member", member), {
          orgId,
          token: memberPhone,
          platform: "ios",
          apsEnvironment: "development",
        });
        yield* TestClock.adjust("2 minutes");
        apns.sent.length = 0;
        yield* notify({ _tag: "message", orgId, messageId: yield* mention() });
        assert.deepStrictEqual(alerts(apns.sent).length, 1);
        assert.isDefined(alerts(apns.sent)[0]);
        // Inside the half hour after a ring, the next lands without one.
        apns.sent.length = 0;
        yield* notify({ _tag: "message", orgId, messageId: yield* mention() });
        assert.deepStrictEqual(alerts(apns.sent), [undefined]);

        // A line she reads as it lands, with the chat open, spends no ring either.
        yield* TestClock.adjust("31 minutes");
        const presence = yield* KinPushPresence;
        const watching = yield* presence
          .watch(watcher(AuthSessionId.make("sess-member")), KinChatId.make("chat_team"))
          .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
        apns.sent.length = 0;
        yield* notify({ _tag: "message", orgId, messageId: yield* mention() });
        assert.deepStrictEqual(apns.sent, []);
        yield* Fiber.interrupt(watching);
        yield* notify({ _tag: "message", orgId, messageId: yield* mention() });
        assert.isDefined(alerts(apns.sent)[0]);
      }).pipe(Effect.provide(build(apns)));
    },
  );

  it.effect("rings each person on their own clock and working hours", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const fin = { agentMemberId: "m_fin" } as const;
      const tokens = () => apns.sent.map((push) => push.token);
      const rung = () =>
        apns.sent.flatMap((push) =>
          (push.payload as { aps: { sound?: unknown } }).aps.sound === undefined
            ? []
            : [push.token],
        );
      // Priya is in India and works Monday to Friday, 10:00 to 18:00 there.
      yield* sql`UPDATE kin_people SET time_zone = 'Asia/Kolkata',
          work_hours_json = '{"days":[1,2,3,4,5],"start":"10:00","end":"18:00"}'
        WHERE person_id = ${member}`;
      // Sunday 12:00 in India: her day off. 01:30 in New York: the owner's quiet hours.
      yield* TestClock.setTime(Date.parse("2026-11-08T06:30:00Z"));
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, fin, "posted", { mentions: ["m_priya", "m_owner"] }),
      });
      assert.deepStrictEqual(
        tokens().toSorted(),
        [ownerPhone, ownerTablet, memberPhone].toSorted(),
      );
      assert.deepStrictEqual(rung(), []);
      // Her tap on Friday started work whose helper finished now: its result answers her, so it
      // rings on her day off. The owner, who asked nothing and isn't named, hears nothing.
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
          worker_projects_json, owner_chat_id)
        VALUES ('lead_fin', 'org_01', 'Finance', 0, '[]', '[]', 'chat_dm')`;
      const tapped = yield* postMessage(sql, { personId: member, memberId: "m_priya" });
      yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status,
          event_ids)
        VALUES ('wk_friday', 'org_01', 'lead_fin', 'opus', 0, 'completed', '[]'),
          ('wk_result', 'org_01', 'lead_fin', 'opus', ${NOW}, 'running', '[]')`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('ev_tap', 'org_01', 'lead_fin', 'widget.action', 'P0',
            ${JSON.stringify({ _tag: "widget.action", chatId: "chat_team", messageId: tapped })},
            0, 0, 'done', 'wk_friday'),
          ('ev_done', 'org_01', 'lead_fin', 'task.finished', 'P1',
            ${JSON.stringify({ _tag: "task.finished", chatId: "chat_team", askedIn: ["wk_friday"] })},
            0, 0, 'claimed', 'wk_result')`;
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, fin, "posted", { body: "The vendor list is merged." }),
      });
      assert.deepStrictEqual(tokens(), [memberPhone]);
      assert.deepStrictEqual(rung(), [memberPhone]);
      yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE wakeup_id = 'wk_result'`;
      // A person writing to her still rings, off hours; the owner's quiet hours stay quiet.
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, { personId: owner, memberId: "m_owner" }, "posted", {
          mentions: ["m_priya"],
        }),
      });
      assert.deepStrictEqual(rung(), [memberPhone]);
      // Her switch off: the agent's line rings her on her day off too.
      yield* sql`UPDATE kin_people SET hold_outside_hours = 0 WHERE person_id = ${member}`;
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, fin, "posted", { mentions: ["m_priya"] }),
      });
      assert.deepStrictEqual(rung(), [memberPhone]);
      // Switched back on, Monday 12:00 in India: working, so it rings.
      yield* sql`UPDATE kin_people SET hold_outside_hours = NULL WHERE person_id = ${member}`;
      yield* TestClock.setTime(Date.parse("2026-11-09T06:30:00Z"));
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, fin, "posted", { mentions: ["m_priya"] }),
      });
      assert.deepStrictEqual(rung(), [memberPhone]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("counts the Chats list's unread across chats in the badge, and nothing else", () => {
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
      // One unread in the group and one in the DM; Waiting on you isn't unread, so it isn't counted.
      assert.deepStrictEqual(
        apns.sent.map((push) => (push.payload as { aps: { badge: number } }).aps.badge),
        [2, 2],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  // Generated chats, readers and waiting items: the icon says what the Chats list adds up.
  const said = Arbitrary.all({
    inTeam: Arbitrary.schema(Schema.Boolean),
    by: Arbitrary.schema(Schema.Literals(["owner", "priya", "lead", "system"])),
    silent: Arbitrary.schema(Schema.Boolean),
  });
  const state = Arbitrary.all({
    messages: Arbitrary.array(said, { maxLength: 12 }),
    teamRead: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 }))),
    dmRead: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 14 }))),
    waiting: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
    teamArchived: Arbitrary.schema(Schema.Boolean),
    leftTeam: Arbitrary.schema(Schema.Boolean),
  });
  it.effect.prop(
    "the badge is the unread total of the chats the Chats list shows",
    [state],
    ([world]) => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { notify, sql } = yield* seed;
        const chats = yield* Repository.KinChatRepository;
        for (const message of world.messages) {
          const chatId = message.inTeam ? "chat_team" : "chat_dm";
          const author: Author =
            message.by === "owner"
              ? { personId: owner, memberId: message.inTeam ? "m_owner" : "m_owner_dm" }
              : message.by === "priya" && message.inTeam
                ? { personId: member, memberId: "m_priya" }
                : message.by === "lead"
                  ? { agentMemberId: message.inTeam ? "m_fin" : "m_fin_dm" }
                  : "system";
          yield* postMessage(sql, author, "posted", { chatId, silent: message.silent });
        }
        for (const [chatId, memberId, seq] of [
          ["chat_team", "m_owner", world.teamRead],
          ["chat_dm", "m_owner_dm", world.dmRead],
        ] as const)
          yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq,
              updated_at) VALUES ('org_01', ${chatId}, ${memberId}, ${seq}, ${T})`;
        for (let index = 0; index < world.waiting; index++)
          yield* sql`INSERT INTO kin_waiting (waiting_id, org_id, person_id, chat_id, reason,
              created_at) VALUES (${`wait_${index}`}, 'org_01', ${owner}, 'chat_dm', 'question', ${T})`;
        if (world.teamArchived)
          yield* sql`UPDATE kin_chats SET archived_at = ${T} WHERE chat_id = 'chat_team'`;
        if (world.leftTeam)
          yield* sql`UPDATE kin_chat_members SET left_at = ${T} WHERE member_id = 'm_owner'`;
        const ring = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
          chatId: "chat_dm",
        });
        // What the Chats list shows: each chat's own unread, for the chats it lists.
        let listed = 0;
        for (const [chatId, memberId] of [
          ["chat_team", "m_owner"],
          ["chat_dm", "m_owner_dm"],
        ] as const) {
          if (chatId === "chat_team" && (world.teamArchived || world.leftTeam)) continue;
          listed += yield* chats.unreadCount({
            orgId,
            chatId: KinChatId.make(chatId),
            memberId: KinMemberId.make(memberId),
          });
        }
        yield* notify({ _tag: "message", orgId, messageId: ring });
        const badges = apns.sent.map(
          (push) => (push.payload as { aps: { badge: number } }).aps.badge,
        );
        // The DM rings both of the owner's devices with the same number.
        assert.deepStrictEqual(badges, [listed, listed]);
      }).pipe(Effect.provide(build(apns)));
    },
    { arbitrary: { runs: 30 } },
  );

  it.effect("tells a person on their phones each time they link a device, loud", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at,
          expires_at, client_label)
        VALUES ('sess-laptop', 'kin-member', '[]', 'bearer-access-token', ${T},
          '2026-12-07T00:00:00.000Z', 'Laptop')`;
      for (const id of ["sess-member", "sess-laptop"])
        yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
          VALUES (${id}, 'org_01', ${member}, ${NOW})`;
      // The new device has a phone token of its own; it needs no word of itself.
      yield* (yield* KinPushDevices).register(caller("sess-laptop", member), {
        orgId,
        token: token("d"),
        platform: "ios",
        apsEnvironment: "development",
      });
      const linked = { _tag: "device", orgId, sessionId: "sess-laptop" } as const;
      assert.deepStrictEqual(yield* notify(linked), {
        status: "ready",
        sent: 1,
        suppressed: 0,
        failed: 0,
      });
      const [push] = apns.sent;
      assert.equal(push!.token, memberPhone);
      assert.deepStrictEqual((push!.payload as { aps: { alert: unknown } }).aps.alert, {
        title: "New device linked",
        body: KIN_DEVICE_LINKED_NOTICE,
      });
      assert.equal(
        (push!.payload as { body: { deepLink: string } }).body.deepLink,
        "/kin/env_kin/org_01/people/h_member/devices",
      );
      // A device already removed again announces nothing.
      apns.sent.length = 0;
      yield* sql`UPDATE kin_session_bindings SET revoked_at = ${NOW} WHERE session_id = 'sess-laptop'`;
      yield* notify(linked);
      assert.deepStrictEqual(apns.sent, []);
      // Nor does one signed out outside Kin, or one whose session has run out.
      yield* sql`UPDATE kin_session_bindings SET revoked_at = NULL WHERE session_id = 'sess-laptop'`;
      yield* sql`UPDATE auth_sessions SET revoked_at = ${T} WHERE session_id = 'sess-laptop'`;
      yield* notify(linked);
      yield* sql`UPDATE auth_sessions SET revoked_at = NULL, expires_at = ${T}
        WHERE session_id = 'sess-laptop'`;
      yield* notify(linked);
      assert.deepStrictEqual(apns.sent, []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("sends a read's new badge, with no banner, to the reader's other devices", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql } = yield* seed;
      const presence = yield* KinPushPresence;
      const dm = KinChatId.make("chat_dm");
      const read = { _tag: "read", orgId, chatId: dm, memberId: KinMemberId.make("m_owner_dm") };
      const messageId = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
      });
      yield* postMessage(sql, { agentMemberId: "m_fin" });
      yield* notify({ _tag: "message", orgId, messageId });
      // The phone is where the owner reads it, so only the tablet hears.
      yield* presence
        .watch(watcher(AuthSessionId.make("sess-owner-phone")), dm)
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_dm', 'm_owner_dm', seq, ${T} FROM kin_messages
        WHERE message_id = ${messageId}`;
      apns.sent.length = 0;
      assert.deepStrictEqual(yield* notify(read as Sender.KinPushNotification), {
        status: "ready",
        sent: 1,
        suppressed: 1,
        failed: 0,
      });
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, push.collapseId, push.payload]),
        [
          [
            ownerTablet,
            undefined,
            {
              // It wakes the app, which takes the DM's banners off the pane: nothing there is unread.
              aps: { badge: 1, "content-available": 1 },
              body: {
                kin: 1,
                orgId,
                chatId: dm,
                deepLink: "/kin/env_kin/org_01/chats/chat_dm",
                cleared: true,
              },
            },
          ],
        ],
      );
      // An unchanged badge sends nothing; a member who left hears nothing.
      apns.sent.length = 0;
      yield* notify(read as Sender.KinPushNotification);
      yield* sql`UPDATE kin_chat_members SET left_at = ${T} WHERE member_id = 'm_owner_dm'`;
      yield* notify(read as Sender.KinPushNotification);
      assert.deepStrictEqual(apns.sent, []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("keeps quiet hours quiet, except for what the owner timed", () => {
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
      // Listed in the notifications with its words, passive: no sound, banner or lit screen.
      assert.deepStrictEqual(apns.sent[0]?.payload, {
        aps: {
          alert: { title: "Finance · Update", body: "Your reminder: call the bank" },
          badge: 1,
          category: "kin.message",
          "interruption-level": "passive",
          "thread-id": "kin:org_01:chat_dm",
        },
        body: {
          kin: 1,
          orgId,
          chatId: "chat_dm",
          deepLink: "/kin/env_kin/org_01/chats/chat_dm",
        },
      });
      // A question with answer buttons arrives quietly as a plain one does, its buttons kept.
      const asked = yield* postWidget(
        sql,
        "choice",
        {
          question: "Renew Orbit on the same terms?",
          detail: null,
          options: [
            { optionId: "option-1", label: "Same terms" },
            { optionId: "option-2", label: "New terms" },
          ],
          answer: null,
        },
        [owner],
      );
      yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id,
          kind, widget_id, question, safe, asked_at, due_at, act_at, state)
        VALUES ('q_renew', 'org_01', 'lead_fin', ${owner}, 'chat_team', 'card', ${asked},
          'Renew?', 0, ${NOW}, ${NOW}, ${NOW}, 'open')`;
      apns.sent.length = 0;
      yield* notify({ _tag: "widget", orgId, widgetId: asked });
      const quietly = {
        badge: 2,
        category: "kin.choice",
        "interruption-level": "passive",
        "thread-id": "kin:org_01:chat_team",
      };
      assert.deepStrictEqual(
        apns.sent.map((push) => {
          const { alert: _alert, ...aps } = (push.payload as { aps: Record<string, unknown> }).aps;
          return aps;
        }),
        [quietly, quietly],
      );

      // A teammate writing in their chat with you lands at once, unread, but rings only when your
      // quiet hours end (`deliverHeld`).
      yield* pairChat(sql);
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(
          sql,
          { personId: member, memberId: "m_priya_pair" },
          "posted",
          { chatId: "chat_pair", body: "Are you free tomorrow?" },
        ),
      });
      assert.deepStrictEqual(sound(), [null, null]);

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
      // A group's own reminder is for everyone there, each on their own quiet hours: the owner's
      // hold it now; Priya's, in Kolkata, are over.
      yield* sql`UPDATE kin_people SET time_zone = 'Asia/Kolkata' WHERE person_id = ${member}`;
      yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
          received_at, queued_at, state, wakeup_id)
        VALUES ('ev_2', 'org_01', 'lead_fin', 'deferral.due', 'P1', '{}', ${NOW}, ${NOW},
          'claimed', 'wk_1')`;
      yield* sql`INSERT INTO kin_lead_deliveries (org_id, event_id, kind, agent_id, chat_id,
          widget_id, widget_type, state_json, fallback_body, deadline_at, status, created_at,
          updated_at)
        VALUES ('org_01', 'ev_2', 'reminder', 'lead_fin', 'chat_team', 'w_group', 'reminder',
          '{}', 'Reminder: send the report.', ${NOW}, 'pending', ${NOW}, ${NOW})`;
      apns.sent.length = 0;
      yield* notify({
        _tag: "message",
        orgId,
        messageId: yield* postMessage(sql, { agentMemberId: "m_fin" }, "posted", {
          body: "Time to send the report.",
        }),
      });
      assert.deepStrictEqual(
        apns.sent
          .map((push) => [
            push.token,
            (push.payload as { aps: { sound?: string } }).aps.sound ?? null,
          ])
          .toSorted(),
        [
          [memberPhone, "default"],
          [ownerPhone, null],
          [ownerTablet, null],
        ].toSorted(),
      );
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
        .watch(watcher(phone), chat)
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
        .watch(watcher(phone), dm)
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
      yield* presence.watch(watcher(phone), chat).pipe(
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

  it.effect("sends what a key change owes from its stored row to the owner, loud, and once", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sender, notify, sql } = yield* seed;
      const notice = yield* postMessage(sql, "system", "posted", { chatId: "chat_dm" });
      const body = `"Phone" (iOS) can now approve for Kin. It was set up on Sun 8 Nov, 00:00 UTC. ${"x".repeat(120)} If that wasn't you, remove it in Settings, then Approvals.`;
      // As a key change's transaction leaves them: one with its chat notice, one with none.
      yield* sql`INSERT INTO kin_key_pushes (org_id, thumbprint, change, body, message_id, owed_at)
        VALUES ('org_01', ${"k".repeat(43)}, 'added', ${body}, ${notice}, ${NOW}),
          ('org_01', ${"k".repeat(43)}, 'removed', 'Removed.', NULL, ${NOW + 1})`;
      // The notice doesn't ring for itself: its key push says the same.
      assert.strictEqual((yield* notify({ _tag: "message", orgId, messageId: notice })).sent, 0);

      // 22:00 in New York: quiet hours, which a key change rings through.
      yield* TestClock.setTime(NOW + 3 * 60 * 60 * 1000);
      assert.strictEqual(yield* sender.flushKeyPushes, 2);
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [ownerPhone, ownerTablet, ownerPhone, ownerTablet],
      );
      assert.deepStrictEqual(alerts(apns.sent), [
        { title: "Kin approvals", body },
        { title: "Kin approvals", body },
        { title: "Kin approvals", body: "Removed." },
        { title: "Kin approvals", body: "Removed." },
      ]);
      assert.deepStrictEqual((apns.sent[0]!.payload as { body: unknown }).body, {
        kin: 1,
        orgId,
        deepLink: "/kin/env_kin/org_01/approvals",
      });
      // Settled once sent, so the next start's pass sends nothing again.
      assert.strictEqual(yield* sender.flushKeyPushes, 0);
      assert.strictEqual(apns.sent.length, 4);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("tells a person's taps on someone's tasks in one banner per mover, in no chat", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sender, sql } = yield* seed;
      const chats = yield* Repository.KinChatRepository;
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('h_dev', 'org_01', 'dev', 'Dev', ${T})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES ('org_01', 'work', 'Work', 'W', 1, 0)`;
      for (let n = 31; n <= 40; n++)
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title,
            owner_kind, owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
          VALUES ('org_01', ${`w${n}`}, 'work', ${`W-${n}`}, ${`Invented task ${n}`}, 'person',
            ${owner}, 0, 'person', ${`w${n}`}, 0, 0)`;
      const handBack = (by: KinPersonId, n: number) =>
        Effect.gen(function* () {
          const row = (yield* byId(orgId, `w${n}`))!;
          yield* tellOnTasks(
            { orgId, personId: by, agentId: KinAgentId.make("lead_fin"), change: `screen:w${n}` },
            [{ personId: owner, kind: "returned", row, why: "Invented: not mine" }],
          );
        });
      const deliver = deliverHeld(
        orgId,
        { notice: () => Effect.die("a task move is no chat line") },
        { notify: (notification) => sender.notify(notification).pipe(Effect.tap(Fiber.join)) },
      );
      const banners = () =>
        apns.sent.map((push) => {
          const { aps, body } = push.payload as {
            aps: { alert?: { title: string; body: string }; badge: number };
            body: { deepLink: string; subject?: unknown };
          };
          return { alert: aps.alert ?? null, badge: aps.badge, link: body.deepLink };
        });
      const unread = yield* chats.unreadTotal({ orgId, personId: owner });
      const messages = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_messages`;
      const posted = (yield* messages)[0]!.n;
      // Priya hands seven back within the minute; nothing is posted and nothing rings yet.
      for (let n = 31; n <= 37; n++) {
        yield* handBack(member, n);
        yield* TestClock.adjust(Duration.seconds(5));
      }
      apns.sent.length = 0;
      yield* deliver;
      assert.deepStrictEqual(banners(), []);
      // Dev hands one back inside Priya's minute; each is told for themself.
      yield* handBack(KinPersonId.make("h_dev"), 38);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* deliver;
      assert.deepStrictEqual(banners(), [
        {
          alert: { title: "Tasks", body: "priya handed back 7 tasks" },
          badge: unread,
          link: "/kin/env_kin/org_01/work",
        },
        {
          alert: { title: "Tasks", body: "priya handed back 7 tasks" },
          badge: unread,
          link: "/kin/env_kin/org_01/work",
        },
        // Work handed back is his again: it rings though the half hour's one ring is spent.
        {
          alert: { title: "Tasks", body: "Dev handed back W-38 Invented task 38" },
          badge: unread,
          link: "/kin/env_kin/org_01/work/W-38",
        },
        {
          alert: { title: "Tasks", body: "Dev handed back W-38 Invented task 38" },
          badge: unread,
          link: "/kin/env_kin/org_01/work/W-38",
        },
      ]);
      // A comment on his task is not: the first rings, the next in the half hour sets the badge.
      const comment = (n: number) =>
        Effect.gen(function* () {
          apns.sent.length = 0;
          yield* tellOnTasks(
            {
              orgId,
              personId: KinPersonId.make("h_dev"),
              agentId: KinAgentId.make("lead_fin"),
              change: `comment:w${n}`,
            },
            [
              {
                personId: owner,
                kind: "commented",
                row: (yield* byId(orgId, `w${n}`))!,
                why: null,
              },
            ],
          );
          yield* TestClock.adjust(Duration.seconds(61));
          yield* deliver;
          return banners().map((banner) => banner.alert?.body ?? null);
        });
      assert.deepStrictEqual(yield* comment(31), [
        "Dev commented on W-31 Invented task 31",
        "Dev commented on W-31 Invented task 31",
      ]);
      assert.deepStrictEqual(yield* comment(32), [null, null]);
      assert.strictEqual((yield* messages)[0]!.n, posted);
      assert.strictEqual(yield* chats.unreadTotal({ orgId, personId: owner }), unread);
      apns.sent.length = 0;
      yield* deliver;
      assert.deepStrictEqual(banners(), []);

      // In his quiet hours (22:00 in New York) it waits, and is told once when they end.
      yield* TestClock.setTime(Date.parse("2026-11-08T03:00:00Z"));
      yield* sql`DELETE FROM kin_push_rings`;
      yield* handBack(member, 39);
      yield* TestClock.adjust(Duration.minutes(5));
      yield* deliver;
      assert.deepStrictEqual(banners(), []);
      yield* TestClock.setTime(Date.parse("2026-11-08T13:00:00Z"));
      yield* deliver;
      yield* deliver;
      assert.deepStrictEqual(
        banners().map((banner) => banner.alert?.body),
        ["priya handed back W-39 Invented task 39", "priya handed back W-39 Invented task 39"],
      );
      assert.deepStrictEqual(
        (apns.sent[0]!.payload as { body: { subject?: unknown } }).body.subject,
        { _tag: "record", key: "W-39", kind: "task" },
      );

      // Muted, his chat with the agent keeps it silent.
      yield* sql`DELETE FROM kin_push_rings`;
      yield* sql`UPDATE kin_chat_members SET muted_until = '2026-12-01T00:00:00.000Z'
        WHERE member_id = 'm_owner_dm'`;
      apns.sent.length = 0;
      yield* handBack(member, 40);
      yield* TestClock.adjust(Duration.minutes(2));
      yield* deliver;
      assert.deepStrictEqual(
        banners().map((banner) => banner.alert),
        [null, null],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  describe("an answer to what you asked, in your quiet hours", () => {
    /** The Finance lead's owner chat, and its turns: each with the events that woke it. */
    const turns = (sql: SqlClient.SqlClient) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json,
            worker_projects_json, owner_chat_id)
          VALUES ('lead_fin', 'org_01', 'Finance', 0, '[]', '[]', 'chat_dm')`;
        const turn = (
          wakeupId: string,
          startedAt: number,
          events: ReadonlyArray<readonly [tag: string, json: object]>,
        ) =>
          Effect.gen(function* () {
            // One turn runs at a time: the one before it has ended.
            yield* sql`UPDATE kin_wakeups SET status = 'completed' WHERE status = 'running'`;
            yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at,
                status, event_ids)
              VALUES (${wakeupId}, 'org_01', 'lead_fin', 'opus', ${startedAt}, 'running', '[]')`;
            for (const [index, [tag, json]] of events.entries())
              yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json,
                  received_at, queued_at, state, wakeup_id)
                VALUES (${`${wakeupId}:${index}`}, 'org_01', 'lead_fin', ${tag}, 'P1',
                  ${JSON.stringify({ _tag: tag, ...json })}, ${startedAt}, ${startedAt},
                  'claimed', ${wakeupId})`;
          });
        /** The owner taps a card in his chat with Finance at `at`, which starts a turn. */
        const tap = (wakeupId: string, at: number) =>
          Effect.gen(function* () {
            const messageId = yield* postMessage(
              sql,
              { personId: owner, memberId: "m_owner_dm" },
              "posted",
              { chatId: "chat_dm", body: "Go ahead" },
            );
            yield* sql`UPDATE kin_messages SET created_at = ${DateTime.formatIso(DateTime.makeUnsafe(at))}
              WHERE message_id = ${messageId}`;
            yield* turn(wakeupId, at, [["widget.action", { chatId: "chat_dm", messageId }]]);
          });
        return { turn, tap };
      });

    /** What each of the owner's two iPhones made of each push: rang, listed quietly, or badge. */
    const heard = (apns: ReturnType<typeof makeApns>) =>
      apns.sent
        .filter((push) => push.token === ownerPhone)
        .map((push) => {
          const { aps } = push.payload as { aps: { alert?: unknown; sound?: string } };
          return aps.sound === "default" ? "ring" : aps.alert === undefined ? "badge" : "quiet";
        });

    const zones = [
      ["America/New_York", "-05:00"],
      ["Asia/Kolkata", "+05:30"],
    ] as const;

    it.effect.each(zones)(
      "asked at 21:35, its result at 23:26 rings once a turn, past the half hour; asked at 18:00 or unasked, it arrives quietly (%s)",
      ([zone, offset]) => {
        const apns = makeApns();
        const at = (day: string, time: string) => Date.parse(`2026-11-${day}T${time}:00${offset}`);
        return Effect.gen(function* () {
          const { notify, sql } = yield* seed;
          // The company's quiet hours, 22:00 to 07:00 on its clock; the owner has none of his own.
          yield* sql`UPDATE kin_trigger_settings SET time_zone = ${zone},
            quiet_hours_json = '{"from":"22:00","to":"07:00"}'`;
          const { turn, tap } = yield* turns(sql);
          const say = (body: string) =>
            Effect.gen(function* () {
              apns.sent.length = 0;
              const messageId = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
                chatId: "chat_dm",
                body,
              });
              yield* notify({ _tag: "message", orgId, messageId });
              return messageId;
            });
          yield* tap("wk_tap", at("07", "21:35"));
          // An unprompted line rang him at 23:10, which holds other unprompted ones to 23:40.
          yield* sql`INSERT INTO kin_push_rings (org_id, person_id, rang_at)
            VALUES ('org_01', ${owner}, ${at("07", "23:10")})`;
          // 23:26: the helper it handed the work to finishes, and that wakes Finance.
          yield* TestClock.setTime(at("07", "23:26"));
          yield* turn("wk_done", at("07", "23:26"), [
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_tap"] }],
          ]);
          const first = yield* say("All three reminders are drafted.");
          assert.deepStrictEqual(heard(apns), ["ring"]);
          assert.deepStrictEqual(alerts(apns.sent.slice(0, 1)), [
            { title: "Finance · Reply", body: "All three reminders are drafted." },
          ]);
          // Its next words that turn wait quietly in his notifications: one ring a turn.
          yield* TestClock.adjust("4 minutes");
          const second = yield* say("Orbit's is the largest, ₹47,200.");
          assert.deepStrictEqual(heard(apns), ["quiet"]);
          // Its card, released at the turn's end, came with those words: nothing more.
          const card = yield* postWidget(sql, "choice", { question: "Send them?", options: [] }, [
            owner,
          ]);
          yield* sql`UPDATE kin_widgets SET chat_id = 'chat_dm' WHERE widget_id = ${card}`;
          yield* sql`UPDATE kin_messages SET chat_id = 'chat_dm', body = '', source_wakeup_id = 'wk_done'
            WHERE message_id = (SELECT message_id FROM kin_widgets WHERE widget_id = ${card})`;
          apns.sent.length = 0;
          yield* notify({ _tag: "widget", orgId, widgetId: card, covered: [first, second] });
          assert.deepStrictEqual(heard(apns), []);

          // Asked at 18:00 and answered at 23:30: quiet, listed with its words, not badge only.
          yield* tap("wk_evening", at("08", "18:00"));
          yield* TestClock.setTime(at("08", "23:30"));
          yield* turn("wk_late", at("08", "23:30"), [
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_evening"] }],
          ]);
          yield* say("The quarter's numbers are in.");
          assert.deepStrictEqual(heard(apns), ["quiet"]);
          // A webhook woke it, at 23:35: nobody asked, so quiet as before.
          yield* TestClock.adjust("5 minutes");
          yield* turn("wk_hook", at("08", "23:35"), [["github", { summary: "CI failed" }]]);
          yield* say("CI failed on main.");
          assert.deepStrictEqual(heard(apns), ["quiet"]);

          // His switch off: quiet hours keep even the 21:35 ask's result quiet.
          yield* sql`UPDATE kin_people SET answers_ring = 0 WHERE person_id = ${owner}`;
          yield* tap("wk_tap_2", at("09", "21:35"));
          yield* TestClock.setTime(at("09", "23:26"));
          yield* turn("wk_done_2", at("09", "23:26"), [
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_tap_2"] }],
          ]);
          yield* say("Done.");
          assert.deepStrictEqual(heard(apns), ["quiet"]);
          // Back on, a chat he muted only sets the badge, answer or not.
          yield* sql`UPDATE kin_people SET answers_ring = NULL WHERE person_id = ${owner}`;
          yield* sql`UPDATE kin_chat_members SET muted_until = '2026-12-01T00:00:00.000Z'
            WHERE member_id = 'm_owner_dm'`;
          yield* tap("wk_tap_3", at("10", "21:35"));
          yield* TestClock.setTime(at("10", "23:26"));
          yield* turn("wk_done_3", at("10", "23:26"), [
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_tap_3"] }],
          ]);
          yield* say("Done again.");
          assert.deepStrictEqual(heard(apns), ["badge"]);
        }).pipe(Effect.provide(build(apns)));
      },
    );

    it.effect(
      "a helper's result, a deferral the turn set up and another lead's answer each answer the asker; a schedule's chain answers nobody",
      () => {
        const apns = makeApns();
        return Effect.gen(function* () {
          const { notify, sql } = yield* seed;
          const { turn, tap } = yield* turns(sql);
          // The seed's quiet hours: 21:00 to 08:00 in New York. He asks at 22:00.
          const asked = Date.parse("2026-11-08T03:00:00Z");
          yield* tap("wk_ask", asked);
          yield* turn("wk_sched", asked, [
            ["deferral.due", { subject: { type: "scheduled_task", itemId: "s1", runId: "r1" } }],
          ]);
          const cases = [
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_ask"] }, "ring"],
            ["deferral.due", { subject: { type: "deferral" }, askedIn: ["wk_ask"] }, "ring"],
            [
              "chat.message",
              { chatId: "chat_dm", messageId: "kin-handoff-back:1", askedIn: ["wk_ask"] },
              "ring",
            ],
            // A helper of a helper: two hops back to his tap.
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_case_0"] }, "ring"],
            ["task.finished", { chatId: "chat_dm", askedIn: ["wk_sched"] }, "quiet"],
          ] as const;
          for (const [index, [tag, json, expected]] of cases.entries()) {
            const startedAt = asked + (index + 1) * 60_000;
            yield* TestClock.setTime(startedAt);
            yield* turn(`wk_case_${index}`, startedAt, [[tag, json]]);
            apns.sent.length = 0;
            yield* notify({
              _tag: "message",
              orgId,
              messageId: yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
                chatId: "chat_dm",
                body: `Case ${index}`,
              }),
            });
            assert.deepStrictEqual(heard(apns), [expected], `${index} ${tag}`);
          }
        }).pipe(Effect.provide(build(apns)));
      },
    );
  });

  it.effect("a teammate's messages in your quiet hours ring once per sender, at their end", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { sender, notify, sql } = yield* seed;
      const chats = yield* Repository.KinChatRepository;
      yield* pairChat(sql);
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('h_dev', 'org_01', 'dev', 'Dev Rao', ${T})`;
      yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, title, team_id, last_seq, created_at)
        VALUES ('chat_dev', 'org_01', 'team_group', NULL,
          ${kinPeopleChatTeamId(owner, KinPersonId.make("h_dev"))}, 0, ${T})`;
      for (const [memberId, person] of [
        ["m_owner_dev", owner],
        ["m_dev", "h_dev"],
      ] as const)
        yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind,
            person_id, role, joined_at)
          VALUES (${memberId}, 'org_01', 'chat_dev', 'person', ${person}, 'member', ${T})`;
      const write = (chatId: string, memberId: string, person: string, body: string) =>
        Effect.gen(function* () {
          const messageId = yield* postMessage(
            sql,
            { personId: KinPersonId.make(person), memberId },
            "posted",
            { chatId, body },
          );
          yield* notify({ _tag: "message", orgId, messageId });
          return messageId;
        });
      const deliver = deliverHeld(
        orgId,
        { notice: () => Effect.die("a held ring is no chat line") },
        { notify: (notification) => sender.notify(notification).pipe(Effect.tap(Fiber.join)) },
      );
      const rung = () =>
        apns.sent
          .filter((push) => push.token === ownerPhone)
          .map((push) => {
            const { aps, body } = push.payload as {
              aps: { alert?: { title: string; body: string }; badge: number; sound?: string };
              body: { subject?: unknown };
            };
            // What rang: one listed quietly has words but no sound.
            const alert = aps.sound === undefined ? null : (aps.alert ?? null);
            return { alert, badge: aps.badge, subject: body.subject ?? null };
          });
      // 22:00 in New York, inside the owner's quiet hours: each lands now and counts as unread.
      yield* TestClock.setTime(Date.parse("2026-11-08T03:00:00Z"));
      apns.sent.length = 0;
      const first = yield* write("chat_pair", "m_priya_pair", member, "Are you free tomorrow?");
      yield* write("chat_pair", "m_priya_pair", member, "For the Harbourline call.");
      const devSaid = yield* write("chat_dev", "m_dev", "h_dev", "The billing email is in.");
      assert.deepStrictEqual(rung(), [
        { alert: null, badge: 1, subject: null },
        { alert: null, badge: 2, subject: null },
        { alert: null, badge: 3, subject: null },
      ]);
      assert.strictEqual(yield* chats.unreadTotal({ orgId, personId: owner }), 3);
      apns.sent.length = 0;
      yield* TestClock.adjust("1 hour");
      yield* deliver;
      assert.deepStrictEqual(apns.sent, []);
      // At 08:00 their end brings one banner per sender: a count, or the one message itself.
      yield* TestClock.setTime(Date.parse("2026-11-08T13:00:00Z"));
      yield* deliver;
      yield* deliver;
      assert.deepStrictEqual(rung(), [
        {
          alert: { title: "priya", body: "priya sent 2 messages" },
          badge: 3,
          subject: { _tag: "message", messageId: first },
        },
        {
          alert: { title: "Dev Rao", body: "The billing email is in." },
          badge: 3,
          subject: { _tag: "message", messageId: devSaid },
        },
      ]);
      // One read before then rings nothing at the end.
      yield* TestClock.setTime(Date.parse("2026-11-09T03:00:00Z"));
      const late = yield* write("chat_pair", "m_priya_pair", member, "Never mind, sorted.");
      yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_pair', 'm_owner_pair', seq, ${T} FROM kin_messages
        WHERE message_id = ${late}`;
      yield* TestClock.setTime(Date.parse("2026-11-09T13:00:00Z"));
      apns.sent.length = 0;
      yield* deliver;
      assert.deepStrictEqual(apns.sent, []);
      // Outside them a teammate's message rings at once, as an agent's answer to you does.
      apns.sent.length = 0;
      yield* write("chat_pair", "m_priya_pair", member, "Lunch?");
      assert.deepStrictEqual(
        rung().map((one) => one.alert),
        [{ title: "priya", body: "Lunch?" }],
      );
      const asked = yield* postMessage(sql, { personId: owner, memberId: "m_owner_dm" }, "posted", {
        chatId: "chat_dm",
        body: "What is still owed this month?",
      });
      apns.sent.length = 0;
      const answer = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
        body: "Two invoices, ₹47,200 in all.",
        replyTo: asked,
      });
      yield* notify({ _tag: "message", orgId, messageId: answer });
      assert.deepStrictEqual(
        rung().map((one) => one.alert),
        [{ title: "Finance · Reply", body: "Two invoices, ₹47,200 in all." }],
      );
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

describe("kinTasksSubject", () => {
  it("opens the one task a notice names, and Tasks when it names more", () => {
    const [a, b] = [KinRecordKey.make("W-4"), KinRecordKey.make("W-7")];
    assert.isUndefined(Sender.kinTasksSubject([]));
    assert.deepStrictEqual(Sender.kinTasksSubject([a, a]), {
      _tag: "record",
      key: a,
      kind: "task",
    });
    assert.deepStrictEqual(Sender.kinTasksSubject([a, b]), { _tag: "tasks" });
  });
});

describe("kinPushFit", () => {
  const bytes = (text: string) => new TextEncoder().encode(JSON.stringify(text)).length - 2;
  const sentence = "Payroll for November matches the ledger and is ready for you. ";
  const words = Array.from({ length: 400 }, (_, at) => `item${at}`).join(" ");
  const hindi = "बजट की समीक्षा शुक्रवार तक पूरी होगी। ".repeat(60);
  const chinese = "会议定在周五下午三点。".repeat(200);
  it.each([
    ["a short line whole", "Ship it Friday.", 3900, "Ship it Friday."],
    ["a 600-character reply whole", sentence.repeat(10).trim(), 3900, sentence.repeat(10).trim()],
    ["at a sentence end when one is near", sentence.repeat(100), 3900, /ready for you\.…$/],
    ["at a word when no sentence ends near", words, 1000, /item\d+…$/],
    ["Hindi at its sentence end, in bytes", hindi, 3900, /होगी।…$/],
    ["Chinese at its sentence end, in bytes", chinese, 3900, /三点。…$/],
    ["quotes and line breaks counted escaped", `"Done"\n`.repeat(800), 3900, /"Done"…$/],
    ["a word longer than the room at a character", "x".repeat(5000), 100, /^x+…$/],
  ] as const)("cuts %s", (_name, text, room, expected) => {
    const cut = Sender.kinPushFit(text, room);
    assert.isAtMost(bytes(cut), room);
    if (typeof expected === "string") assert.strictEqual(cut, expected);
    else {
      assert.match(cut, expected);
      // What it keeps is the text's own start, whole words, and nearly the room it had.
      assert.isTrue(text.startsWith(cut.slice(0, -1)));
      assert.isAbove(bytes(cut), room * 0.75);
    }
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
      // T3 Connect rotates to a new session id while the socket stays open, and nothing moves
      // the registration to it: the phone keeps hearing on its first session's row.
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('sess-owner-phone-2', 'sess-owner-phone', '[]', 'bearer-access-token', ${T},
          '2026-12-07T00:00:00.000Z')`;
      assert.deepStrictEqual(
        (yield* devices.forPeople(orgId, [owner])).map((device) => device.token),
        [ownerPhone],
      );
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

describe("KinPushSender to Android phones", () => {
  const androidPhone = "fcm-owner:APA91b_android-phone-token-0001" as KinPushToken;
  type Banner = {
    aps: Record<string, unknown> & { alert?: { title: string; body: string } };
    body: unknown;
  };

  /** The seed, and the owner's Android phone besides her iPhone and tablet. */
  const seedAndroid = Effect.gen(function* () {
    const seeded = yield* seed;
    yield* seeded.sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at,
        expires_at)
      VALUES ('sess-owner-android', 'sess-owner-android', '[]', 'bearer-access-token', ${T},
        '2026-12-07T00:00:00.000Z')`;
    yield* seeded.devices.register(caller("sess-owner-android", owner), {
      orgId,
      token: androidPhone,
      platform: "android",
      apsEnvironment: "production",
    });
    return seeded;
  });

  /** What the Android phone got, beside what the owner's iPhone got for the same push. */
  const pair = (apns: ReturnType<typeof makeApns>, fcm: ReturnType<typeof makeFcm>) => {
    const iphone = apns.sent.find((push) => push.token === ownerPhone);
    const android = fcm.sent.find((push) => push.token === androidPhone);
    return { iphone, ios: iphone?.payload as Banner | undefined, android };
  };

  it.effect("an Android phone gets each banner the iPhone gets, in its kind's channel", () => {
    const apns = makeApns();
    const fcm = makeFcm("ready");
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedAndroid;
      assert.strictEqual(sender.statusFor("android"), "ready");
      // 09:00 in New York, inside the owner's day.
      yield* TestClock.setTime(Date.parse("2026-11-08T14:00:00Z"));
      const told = (notification: Sender.KinPushNotification, channel: string) =>
        Effect.gen(function* () {
          apns.sent.length = 0;
          fcm.sent.length = 0;
          yield* notify(notification);
          const { iphone, ios, android } = pair(apns, fcm);
          assert.isDefined(ios?.aps.alert, channel);
          // One push, the same words, buttons, badge, landing and collapse on both phones.
          assert.deepStrictEqual(android, {
            token: androidPhone,
            priority: "HIGH",
            data: {
              title: ios?.aps.alert?.title ?? "",
              message: ios?.aps.alert?.body ?? "",
              body: JSON.stringify(ios?.body),
              categoryId: String(ios?.aps.category),
              channelId: channel,
              badge: String(ios?.aps.badge),
              ...(ios?.aps["thread-id"] === undefined
                ? {}
                : { threadIdentifier: String(ios.aps["thread-id"]) }),
              ...(iphone?.collapseId === undefined ? {} : { tag: iphone.collapseId }),
            },
          });
          return android?.data ?? {};
        });

      const said = yield* postMessage(sql, { personId: member, memberId: "m_priya" }, "posted", {
        mentions: ["m_owner"],
        body: "Can you look at the **Orbit** invoice?",
      });
      const message = yield* told({ _tag: "message", orgId, messageId: said }, "kin.messages");
      assert.deepStrictEqual(
        [message.title, message.message],
        ["Payments team · priya", "Can you look at the Orbit invoice?"],
      );
      assert.match(message.tag ?? "", /^kin:/);

      const brief = yield* postMessage(sql, { agentMemberId: "m_fin_dm" }, "posted", {
        chatId: "chat_dm",
        body: "## Needs you\n- The Orbit Dental renewal waits on you.",
      });
      yield* sql`UPDATE kin_messages SET form = 'brief' WHERE message_id = ${brief}`;
      const morning = yield* told({ _tag: "message", orgId, messageId: brief }, "kin.briefs");
      assert.strictEqual(morning.title, "Finance · Morning brief");

      // An open question with two answers keeps its own banner and carries its buttons' answers.
      const widgetId = yield* postWidget(
        sql,
        "choice",
        {
          question: "Is the Harbourline NDA signed?",
          detail: null,
          options: [
            { optionId: "option-1", label: "Signed" },
            { optionId: "option-2", label: "Not yet" },
          ],
          answer: null,
        },
        [owner],
        "Quick one on W-8.",
      );
      yield* sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
          widget_id, question, safe, asked_at, due_at, act_at, state)
        VALUES ('q_nda', 'org_01', 'lead_fin', ${owner}, 'chat_team', 'card', ${widgetId},
          'Is it signed?', 0, ${NOW}, ${NOW}, ${NOW}, 'open')`;
      const question = yield* told({ _tag: "widget", orgId, widgetId }, "kin.questions");
      assert.strictEqual(question.categoryId, "kin.choice");
      assert.isUndefined(question.tag);
      assert.deepInclude(JSON.parse(question.body ?? "{}"), { choices: ["option-1", "option-2"] });

      const deferral = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner]);
      const deferred = yield* told({ _tag: "widget", orgId, widgetId: deferral }, "kin.questions");
      assert.strictEqual(deferred.categoryId, "kin.deferral.confirmed");
      const task = yield* postWidget(sql, "task", { status: "needs_decision" }, [owner]);
      yield* told({ _tag: "widget", orgId, widgetId: task }, "kin.messages");
    }).pipe(Effect.provide(build(apns, fcm)));
  });

  it.effect(
    "quiet hours list a push without sound on both phones, a muted chat only sets the badge, and a read elsewhere takes its banners off",
    () => {
      const apns = makeApns();
      const fcm = makeFcm("ready");
      return Effect.gen(function* () {
        const { notify, sql, devices } = yield* seedAndroid;
        const say = Effect.gen(function* () {
          apns.sent.length = 0;
          fcm.sent.length = 0;
          const said = yield* postMessage(
            sql,
            { personId: member, memberId: "m_priya" },
            "posted",
            {
              mentions: ["m_owner"],
              body: "Is the Orbit invoice out?",
            },
          );
          yield* notify({ _tag: "message", orgId, messageId: said });
          return pair(apns, fcm);
        });
        // 22:00 in New York: the owner's quiet hours. Her iPhone lists it passively, no sound.
        yield* TestClock.setTime(Date.parse("2026-11-08T03:00:00Z"));
        const quiet = yield* say;
        assert.deepInclude(quiet.ios?.aps, {
          alert: { title: "Payments team · priya", body: "Is the Orbit invoice out?" },
          "interruption-level": "passive",
        });
        assert.notProperty(quiet.ios?.aps, "sound");
        assert.isDefined(quiet.iphone?.collapseId);
        // A build without the quiet channel would show it in Expo's loud fallback: nothing.
        assert.deepStrictEqual(fcm.sent, []);
        // One that made the channel lists it there, the same words and collapse as the iPhone.
        yield* devices.register(caller("sess-owner-android", owner), {
          orgId,
          token: androidPhone,
          platform: "android",
          apsEnvironment: "production",
          quietChannel: true,
        });
        const listed = yield* say;
        assert.deepInclude(listed.android?.data, {
          title: "Payments team · priya",
          message: "Is the Orbit invoice out?",
          channelId: "kin.quiet",
          tag: listed.iphone?.collapseId,
        });
        // A chat she muted sets only the badge, on her iPhone; Android shows nothing.
        yield* sql`UPDATE kin_chat_members SET muted_until = '2026-12-01T00:00:00.000Z'
          WHERE member_id = 'm_owner'`;
        const muted = yield* say;
        assert.deepStrictEqual(Object.keys(muted.ios?.aps ?? {}), ["badge"]);
        assert.isUndefined(muted.iphone?.collapseId);
        assert.deepStrictEqual(fcm.sent, []);
        yield* sql`UPDATE kin_chat_members SET muted_until = NULL WHERE member_id = 'm_owner'`;

        // Read on the web: the iPhone's badge push wakes it to clear; Android gets the same data.
        yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_team', 'm_owner', MAX(seq), ${T} FROM kin_messages`;
        apns.sent.length = 0;
        const read = {
          _tag: "read",
          orgId,
          chatId: KinChatId.make("chat_team"),
          memberId: KinMemberId.make("m_owner"),
        } as const;
        yield* notify(read);
        const ios = apns.sent.find((push) => push.token === ownerPhone)?.payload as Banner;
        assert.deepStrictEqual(ios.body, {
          kin: 1,
          orgId,
          chatId: "chat_team",
          deepLink: "/kin/env_kin/org_01/chats/chat_team",
          cleared: true,
        });
        assert.deepStrictEqual(fcm.sent, [
          { token: androidPhone, priority: "NORMAL", data: { body: JSON.stringify(ios.body) } },
        ]);

        // A read that leaves something unread sends Android nothing: it has no banner count to set.
        fcm.sent.length = 0;
        yield* postMessage(sql, { personId: member, memberId: "m_priya" });
        yield* postMessage(sql, { personId: member, memberId: "m_priya" });
        yield* sql`UPDATE kin_read_state SET last_read_seq = last_read_seq + 1
        WHERE member_id = 'm_owner'`;
        yield* notify(read);
        assert.deepStrictEqual(fcm.sent, []);
      }).pipe(Effect.provide(build(apns, fcm)));
    },
  );

  it.effect(
    "a token Google calls unregistered is retired; a failure at Google spares Apple",
    () => {
      const apns = makeApns();
      let google: KinFcmResult = { status: 503, reason: "UNAVAILABLE" };
      const fcm = makeFcm("ready", () => Effect.sync(() => google));
      return Effect.gen(function* () {
        const { notify, sql, devices } = yield* seedAndroid;
        const ring = Effect.gen(function* () {
          const said = yield* postMessage(
            sql,
            { personId: member, memberId: "m_priya" },
            "posted",
            {
              mentions: ["m_owner"],
            },
          );
          return yield* notify({ _tag: "message", orgId, messageId: said });
        });
        assert.deepStrictEqual(yield* ring, { status: "ready", sent: 2, suppressed: 0, failed: 1 });
        assert.deepStrictEqual(
          apns.sent.map((push) => push.token),
          [ownerPhone, ownerTablet],
        );
        const owned = () =>
          devices.forPeople(orgId, [owner]).pipe(Effect.map((all) => all.map((one) => one.token)));
        assert.include(yield* owned(), androidPhone);

        // Google says the app is gone from that phone: the token goes, as APNs' dead tokens do.
        google = { status: 404, reason: "UNREGISTERED" };
        assert.deepStrictEqual(yield* ring, { status: "ready", sent: 2, suppressed: 0, failed: 1 });
        assert.deepStrictEqual(yield* owned(), [ownerPhone, ownerTablet]);
        fcm.sent.length = 0;
        yield* ring;
        assert.deepStrictEqual(fcm.sent, []);
      }).pipe(Effect.provide(build(apns, fcm)));
    },
  );

  it.effect("with no FCM key, Android phones are skipped and iPhones ring as before", () => {
    const apns = makeApns();
    const fcm = makeFcm();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedAndroid;
      assert.strictEqual(sender.statusFor("android"), "unconfigured");
      assert.strictEqual(sender.statusFor("ios"), "ready");
      const said = yield* postMessage(sql, { personId: member, memberId: "m_priya" }, "posted", {
        mentions: ["m_owner"],
      });
      assert.deepStrictEqual(yield* notify({ _tag: "message", orgId, messageId: said }), {
        status: "ready",
        sent: 2,
        suppressed: 0,
        failed: 0,
      });
      assert.deepStrictEqual(fcm.sent, []);
    }).pipe(Effect.provide(build(apns, fcm)));
  });
});

describe("KinPushSender withdrawals", () => {
  const memberAndroid = "fcm-member:APA91b_android-phone-token-0002" as KinPushToken;
  type Silent = { aps: Record<string, unknown>; body: Record<string, unknown> };
  const payloadOf = (push: KinApnsPush) => push.payload as Silent;
  const titleOf = (push: KinApnsPush) =>
    (payloadOf(push).aps.alert as { title: string } | undefined)?.title;
  const work = "/kin/env_kin/org_01/work";

  /** The seed, with the owner's phone on a build that matches notifications by topic. */
  const seedTopical = Effect.gen(function* () {
    const seeded = yield* seed;
    yield* seeded.devices.register(caller("sess-owner-phone", owner), {
      orgId,
      token: ownerPhone,
      platform: "ios",
      apsEnvironment: "development",
      withdraws: true,
    });
    return seeded;
  });

  /** After a commit: what the batch window then sends. */
  const afterBatch = (sender: Sender.KinPushSender["Service"]) =>
    TestClock.adjust(Sender.KIN_WITHDRAW_BATCH).pipe(Effect.andThen(sender.drainWithdrawals));

  const sentRows = (sql: SqlClient.SqlClient) =>
    sql<{ person_id: string; topic: string; withdrawn: number }>`SELECT person_id, topic,
        withdrawn_at IS NOT NULL AS withdrawn
      FROM kin_push_sent ORDER BY person_id, topic`;

  it.effect("a chat's pushes replace one another; a read on the web withdraws them, once", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const from = { personId: member, memberId: "m_priya_pair" };
      for (const body of ["The deck is ready", "Printer says Tuesday"]) {
        const messageId = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body });
        yield* notify({ _tag: "message", orgId, messageId });
      }
      const collapseId = kinTopicCollapseId("env_kin", orgId, "c:chat_pair" as KinPushTopic);
      assert.isAtMost(new TextEncoder().encode(collapseId).length, 64);
      // Another host's company of the same id never shares it.
      assert.notStrictEqual(
        collapseId,
        kinTopicCollapseId("env_other", orgId, "c:chat_pair" as KinPushTopic),
      );
      const phone = apns.sent.filter((push) => push.token === ownerPhone);
      // The newer replaces the older, and says how many are unread.
      assert.deepStrictEqual(
        phone.map((push) => [
          push.collapseId,
          payloadOf(push).body.topic,
          payloadOf(push).body.version,
          titleOf(push),
        ]),
        [
          [collapseId, "c:chat_pair", 1, "priya"],
          [collapseId, "c:chat_pair", 2, "priya · 2 new"],
        ],
      );
      // A build that doesn't match by topic keeps a banner per message, as before.
      const tablet = apns.sent.filter((push) => push.token === ownerTablet);
      assert.lengthOf(new Set(tablet.map((push) => push.collapseId)), 2);
      assert.notInclude(tablet.map((push) => push.collapseId).join(), "kin:t:");
      assert.isTrue(tablet.every((push) => payloadOf(push).body.topic === undefined));
      assert.deepStrictEqual(yield* sentRows(sql), [
        { person_id: owner, topic: "c:chat_pair", withdrawn: 0 },
      ]);

      // Read on the web: no device of hers watches the chat.
      yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_pair', 'm_owner_pair', MAX(seq), ${T} FROM kin_messages
        WHERE chat_id = 'chat_pair'`;
      const read = {
        _tag: "read",
        orgId,
        chatId: KinChatId.make("chat_pair"),
        memberId: KinMemberId.make("m_owner_pair"),
      } as const;
      apns.sent.length = 0;
      yield* notify(read);
      // The older build hears at once, as before; the phone in the batch.
      assert.deepStrictEqual(
        apns.sent.map((push) => push.token),
        [ownerTablet],
      );
      apns.sent.length = 0;
      yield* afterBatch(sender);
      // Apple's background push: `content-available` alone in `aps`; the app sets the badge.
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, push.collapseId, push.background, push.payload]),
        [
          [
            ownerPhone,
            undefined,
            true,
            {
              aps: { "content-available": 1 },
              body: {
                kin: 1,
                orgId,
                deepLink: work,
                withdraw: [{ topic: "c:chat_pair", version: 2 }],
                badge: 0,
              },
            },
          ],
        ],
      );
      assert.deepStrictEqual(yield* sentRows(sql), [
        { person_id: owner, topic: "c:chat_pair", withdrawn: 1 },
      ]);
      // Read again: nothing is left to withdraw and the badge hasn't moved.
      apns.sent.length = 0;
      yield* notify(read);
      yield* afterBatch(sender);
      assert.deepStrictEqual(apns.sent, []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect(
    "a withdrawal names the version it settles, so it never takes a newer push down",
    () => {
      const apns = makeApns();
      return Effect.gen(function* () {
        const { notify, sql, sender } = yield* seedTopical;
        yield* pairChat(sql);
        const from = { personId: member, memberId: "m_priya_pair" };
        const phoneData = () =>
          apns.sent.filter((push) => push.token === ownerPhone).map((push) => payloadOf(push).body);
        const a = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "A" });
        yield* notify({ _tag: "message", orgId, messageId: a });
        // Read A on the web; its withdrawal goes, naming version 1.
        yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        SELECT 'org_01', 'chat_pair', 'm_owner_pair', MAX(seq), ${T} FROM kin_messages
        WHERE chat_id = 'chat_pair'`;
        yield* notify({
          _tag: "read",
          orgId,
          chatId: KinChatId.make("chat_pair"),
          memberId: KinMemberId.make("m_owner_pair"),
        });
        yield* afterBatch(sender);
        // B replaces it on the lock screen as version 2: a late withdrawal of 1 can't remove it.
        const b = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "B" });
        yield* notify({ _tag: "message", orgId, messageId: b });
        assert.deepStrictEqual(
          phoneData().map((data) => [data.topic, data.version, data.withdraw]),
          [
            ["c:chat_pair", 1, undefined],
            [undefined, undefined, [{ topic: "c:chat_pair", version: 1 }]],
            ["c:chat_pair", 2, undefined],
          ],
        );

        // A card dismissed, then reopened by undo before the dismissal's withdrawal lands.
        apns.sent.length = 0;
        const card = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner]);
        yield* notify({ _tag: "widget", orgId, widgetId: card });
        yield* sql`UPDATE kin_widgets SET closed_at = ${T} WHERE widget_id = ${card}`;
        yield* sender.settle(orgId, { topics: [`w:${card}` as KinPushTopic] });
        yield* afterBatch(sender);
        yield* sql`UPDATE kin_widgets SET closed_at = NULL WHERE widget_id = ${card}`;
        yield* notify({ _tag: "widget", orgId, widgetId: card });
        assert.deepStrictEqual(
          phoneData().map((data) => [data.topic, data.version, data.withdraw]),
          [
            [`w:${card}`, 1, undefined],
            [undefined, undefined, [{ topic: `w:${card}`, version: 1 }]],
            [`w:${card}`, 2, undefined],
          ],
        );
        // The host now answers for version 2: it stands.
        assert.deepStrictEqual(
          (yield* sender.reconcile(orgId, owner, [`w:${card}` as KinPushTopic])).remove,
          [],
        );
      }).pipe(Effect.provide(build(apns)));
    },
  );

  it.effect("an agent's withdrawn or replaced message changes its chat's banner quietly", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const from = { personId: member, memberId: "m_priya_pair" };
      const chatId = KinChatId.make("chat_pair");
      const shown = () =>
        apns.sent
          .filter((push) => push.token === ownerPhone && !push.background)
          .map((push) => {
            const { aps } = push.payload as {
              aps: { alert?: { body: string }; sound?: string };
            };
            return [aps.alert?.body ?? null, aps.sound ?? null, payloadOf(push).body.version];
          });
      const withdrawn = () =>
        apns.sent
          .filter((push) => push.token === ownerPhone)
          .flatMap((push) => (payloadOf(push).body.withdraw as Array<unknown> | undefined) ?? []);
      const a = yield* postMessage(sql, from, "posted", { chatId, body: "The deck is ready" });
      yield* notify({ _tag: "message", orgId, messageId: a });
      const b = yield* postMessage(sql, from, "posted", { chatId, body: "Printer says Tuesday" });
      yield* notify({ _tag: "message", orgId, messageId: b });
      apns.sent.length = 0;

      // Put right: the banner shows the new words, with no sound.
      yield* sql`UPDATE kin_messages SET body = 'Printer says Wednesday' WHERE message_id = ${b}`;
      yield* notify({ _tag: "restate", orgId, chatId, messageId: b });
      assert.deepStrictEqual(shown(), [["Printer says Wednesday", null, 3]]);
      // A message the banner no longer shows changes nothing on the phone.
      apns.sent.length = 0;
      yield* notify({ _tag: "restate", orgId, chatId, messageId: a });
      yield* afterBatch(sender);
      assert.deepStrictEqual([shown(), withdrawn()], [[], []]);

      // Taken back: the banner shows the older unread one's words, quietly.
      yield* sql`UPDATE kin_messages SET status = 'deleted' WHERE message_id = ${b}`;
      yield* notify({ _tag: "restate", orgId, chatId, messageId: b });
      assert.deepStrictEqual(shown(), [["The deck is ready", null, 4]]);
      // With nothing older unread, it goes.
      apns.sent.length = 0;
      yield* sql`UPDATE kin_messages SET status = 'deleted' WHERE message_id = ${a}`;
      yield* notify({ _tag: "restate", orgId, chatId, messageId: a });
      yield* afterBatch(sender);
      assert.deepStrictEqual(shown(), []);
      assert.deepStrictEqual(withdrawn(), [{ topic: "c:chat_pair", version: 4 }]);

      // Read by the time it is built: no banner comes back.
      const c = yield* postMessage(sql, from, "posted", { chatId, body: "Invoice sent" });
      yield* notify({ _tag: "message", orgId, messageId: c });
      yield* sql`INSERT OR REPLACE INTO kin_read_state (org_id, chat_id, member_id, last_read_seq,
          updated_at)
        SELECT 'org_01', 'chat_pair', 'm_owner_pair', seq, ${T} FROM kin_messages
        WHERE message_id = ${c}`;
      yield* sql`UPDATE kin_messages SET body = 'Invoice sent to Orbit' WHERE message_id = ${c}`;
      apns.sent.length = 0;
      yield* notify({ _tag: "restate", orgId, chatId, messageId: c });
      assert.deepStrictEqual(shown(), []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("a chat's banner goes once its newest message is read, whatever came after", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const from = { personId: member, memberId: "m_priya_pair" };
      const withdrawn = () =>
        apns.sent
          .filter((push) => push.token === ownerPhone)
          .flatMap((push) => (payloadOf(push).body.withdraw as Array<unknown> | undefined) ?? []);
      const readTo = (messageId: string) =>
        sql`INSERT OR REPLACE INTO kin_read_state (org_id, chat_id, member_id, last_read_seq,
            updated_at)
          SELECT 'org_01', 'chat_pair', 'm_owner_pair', seq, ${T} FROM kin_messages
          WHERE message_id = ${messageId}`.pipe(
          Effect.andThen(
            notify({
              _tag: "read",
              orgId,
              chatId: KinChatId.make("chat_pair"),
              memberId: KinMemberId.make("m_owner_pair"),
            }),
          ),
        );
      const a = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "A" });
      yield* notify({ _tag: "message", orgId, messageId: a });
      // Read A on the web; B lands before the batch goes, ringing no one: not part of A's banner.
      yield* readTo(a);
      yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "B" });
      apns.sent.length = 0;
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawn(), [{ topic: "c:chat_pair", version: 1 }]);

      // Held direct messages arrive as one banner covering both: read up to the first, it stays.
      const c = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "C" });
      const d = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "D" });
      yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
          audience, held_at, deliver_at)
        VALUES ('hold-c', 'org_01', 'chat_pair', ${owner}, ${`kin-dm-news:${c}`}, ${c}, 'chat',
            ${T}, ${T}),
          ('hold-d', 'org_01', 'chat_pair', ${owner}, ${`kin-dm-news:${d}`}, ${d}, 'chat',
            ${T}, ${T})`;
      yield* notify({ _tag: "dm", orgId, holdIds: ["hold-c", "hold-d"] });
      apns.sent.length = 0;
      yield* readTo(c);
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawn(), []);
      yield* readTo(d);
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawn(), [{ topic: "c:chat_pair", version: 2 }]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect(
    "cards settling together are one silent push per phone, in quiet hours too, to who heard",
    () => {
      const apns = makeApns();
      const fcm = makeFcm("ready");
      return Effect.gen(function* () {
        const { notify, sql, sender, devices } = yield* seedTopical;
        yield* devices.register(caller("sess-member", member), {
          orgId,
          token: memberAndroid,
          platform: "android",
          apsEnvironment: "production",
          withdraws: true,
        });
        const both = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner, member]);
        const hers = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner]);
        for (const widgetId of [both, hers]) yield* notify({ _tag: "widget", orgId, widgetId });
        const androidCard = fcm.sent.find((push) => push.token === memberAndroid);
        assert.strictEqual(
          androidCard?.data.tag,
          kinTopicCollapseId("env_kin", orgId, `w:${both}` as KinPushTopic),
        );
        assert.deepStrictEqual(yield* sentRows(sql), [
          { person_id: member, topic: `w:${both}`, withdrawn: 0 },
          { person_id: owner, topic: `w:${both}`, withdrawn: 0 },
          { person_id: owner, topic: `w:${hers}`, withdrawn: 0 },
        ]);

        // 22:00 in New York, inside the owner's quiet hours: a withdrawal still goes.
        yield* TestClock.setTime(NOW + 3 * 60 * 60_000);
        apns.sent.length = 0;
        fcm.sent.length = 0;
        yield* sql`UPDATE kin_widgets SET closed_at = ${T}`;
        for (const widgetId of [both, hers])
          yield* sender.settle(orgId, { topics: [`w:${widgetId}` as KinPushTopic] });
        // Still open, nothing settles: a card waiting on her stays.
        yield* sender.settle(orgId, { topics: ["w:w_nothing" as KinPushTopic] });
        yield* afterBatch(sender);
        assert.deepStrictEqual(
          apns.sent.map((push) => [push.token, payloadOf(push).body.withdraw]),
          [
            [
              ownerPhone,
              [
                { topic: `w:${both}`, version: 1 },
                { topic: `w:${hers}`, version: 1 },
              ],
            ],
          ],
        );
        assert.deepStrictEqual(
          fcm.sent.map((push) => [push.token, push.priority, JSON.parse(push.data.body ?? "")]),
          [
            [
              memberAndroid,
              "NORMAL",
              { kin: 1, orgId, deepLink: work, withdraw: [{ topic: `w:${both}`, version: 1 }] },
            ],
          ],
        );
        // Nothing to draw: no title or message, so the phone shows nothing for it.
        assert.deepStrictEqual(Object.keys(fcm.sent[0]!.data), ["body"]);

        // Settled again, or for a person with no phone left: marked, and nothing is sent.
        yield* devices.unregister(caller("sess-member", member), { orgId, token: memberAndroid });
        yield* sql`UPDATE kin_push_sent SET withdrawn_at = NULL WHERE person_id = ${member}`;
        apns.sent.length = 0;
        fcm.sent.length = 0;
        yield* sender.settle(orgId, { topics: [`w:${both}` as KinPushTopic] });
        yield* afterBatch(sender);
        assert.deepStrictEqual([apns.sent, fcm.sent], [[], []]);
        assert.deepStrictEqual(
          (yield* sentRows(sql)).map((row) => row.withdrawn),
          [1, 1, 1],
        );
      }).pipe(Effect.provide(build(apns, fcm)));
    },
  );

  it.effect("Kin's notice of one task goes with the task; of several, once none is hers", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender, devices } = yield* seedTopical;
      yield* devices.register(caller("sess-member", member), {
        orgId,
        token: memberPhone,
        platform: "ios",
        apsEnvironment: "development",
        withdraws: true,
      });
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES ('org_01', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org_01', 'w1', 'work', 'W-1', 'Logo files', 'person', ${member}, 0, 'person',
            'w1', 0, 0),
          ('org_01', 'w2', 'work', 'W-2', 'Brand deck', 'person', ${member}, 0, 'person',
            'w2', 0, 0)`;
      const tell = (id: string, body: string) =>
        Effect.gen(function* () {
          const messageId = yield* postMessage(sql, "system", "posted", {
            messageId: id,
            kind: "system",
            mentions: ["m_priya"],
            body,
          });
          yield* notify({ _tag: "message", orgId, messageId });
        });
      yield* tell("kin-holder-one", "W-1 Logo files due today.");
      yield* tell(
        "kin-holder-two",
        "2 of your tasks need you:\n• W-1 Logo files\n• W-2 Brand deck",
      );
      assert.deepStrictEqual(
        (yield* sentRows(sql)).map((row) => row.topic),
        ["f:kin-holder-two", "r:W-1"],
      );
      const doneWith = (key: string) =>
        sql`UPDATE kin_records SET state = 'done' WHERE key = ${key}`.pipe(
          Effect.andThen(
            sender.settle(orgId, { topics: [`r:${key}` as KinPushTopic], keys: [`task:${key}`] }),
          ),
          Effect.andThen(afterBatch(sender)),
        );
      apns.sent.length = 0;
      yield* doneWith("W-1");
      // W-2 is still hers: the notice naming both stays.
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, payloadOf(push).body.withdraw]),
        [[memberPhone, [{ topic: "r:W-1", version: 1 }]]],
      );
      apns.sent.length = 0;
      yield* doneWith("W-2");
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, payloadOf(push).body.withdraw]),
        [[memberPhone, [{ topic: "f:kin-holder-two", version: 1 }]]],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("a quiet-hours bundle of tasks goes once the last of them is no longer hers", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender, devices } = yield* seedTopical;
      yield* devices.register(caller("sess-member", member), {
        orgId,
        token: memberPhone,
        platform: "ios",
        apsEnvironment: "development",
        withdraws: true,
      });
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES ('org_01', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org_01', 'w1', 'work', 'W-1', 'Logo files', 'person', ${member}, 0, 'person',
            'w1', 0, 0),
          ('org_01', 'w2', 'work', 'W-2', 'Brand deck', 'person', ${member}, 0, 'person',
            'w2', 0, 0)`;
      // Two tasks the owner gave her while she slept, released as one banner.
      for (const [hold, recordId, key] of [
        ["news-1", "w1", "W-1"],
        ["news-2", "w2", "W-2"],
      ] as const)
        yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
            audience, held_at, deliver_at)
          VALUES (${hold}, 'org_01', '', ${member}, ${`kin-task-news:${hold}`},
            ${JSON.stringify({ by: owner, name: "Owner", kind: "given", recordId, key, title: key, register: "work", to: null })},
            'chat', ${T}, ${T})`;
      yield* notify({ _tag: "tasks", orgId, holdIds: ["news-1", "news-2"] });
      const [banner] = apns.sent.filter((push) => push.token === memberPhone);
      const topic = payloadOf(banner!).body.topic as string;
      assert.match(topic, /^b:/);
      assert.deepStrictEqual(
        (yield* sentRows(sql)).filter((row) => row.person_id === member),
        [{ person_id: member, topic, withdrawn: 0 }],
      );
      // It keeps which tasks, never their words.
      assert.deepStrictEqual(
        (yield* sql<{ key: string }>`SELECT key FROM kin_push_about WHERE ref = ${topic}
          ORDER BY key`).map((row) => row.key),
        ["task:W-1", "task:W-2"],
      );
      const doneWith = (key: string) =>
        sql`UPDATE kin_records SET state = 'done' WHERE key = ${key}`.pipe(
          Effect.andThen(
            sender.settle(orgId, { topics: [`r:${key}` as KinPushTopic], keys: [`task:${key}`] }),
          ),
          Effect.andThen(afterBatch(sender)),
        );
      apns.sent.length = 0;
      yield* doneWith("W-1");
      assert.deepStrictEqual(apns.sent, []);
      yield* doneWith("W-2");
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, payloadOf(push).body.withdraw]),
        [[memberPhone, [{ topic, version: 1 }]]],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("Kin's notice of a fact goes once the fact is handled, though its task is open", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender, devices } = yield* seedTopical;
      yield* devices.register(caller("sess-member", member), {
        orgId,
        token: memberPhone,
        platform: "ios",
        apsEnvironment: "development",
        withdraws: true,
      });
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at)
        VALUES ('org_01', 'work', 'Work', 'W', 1, 0)`;
      yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, owner_kind,
          owner_id, sensitive, created_by_kind, origin_key, created_at, updated_at)
        VALUES ('org_01', 'w1', 'work', 'W-1', 'Logo files', 'person', ${member}, 0, 'person',
            'w1', 0, 0)`;
      const fact = "task_late:W-1:due=1";
      yield* sql`INSERT INTO kin_pulse_facts (org_id, fact_key, sense, subject_record_id,
          first_seen_at, last_seen_at)
        VALUES ('org_01', ${fact}, 'task_late', 'w1', ${NOW}, ${NOW})`;
      // The pulse notes what its notice is about as it posts it.
      yield* sql`INSERT INTO kin_push_about (org_id, ref, key, at)
        VALUES ('org_01', 'kin-holder-late', ${`fact:${fact}`}, ${NOW})`;
      const messageId = yield* postMessage(sql, "system", "posted", {
        messageId: "kin-holder-late",
        kind: "system",
        mentions: ["m_priya"],
        body: "W-1 Logo files was due yesterday.",
      });
      yield* notify({ _tag: "message", orgId, messageId });
      assert.deepStrictEqual(
        (yield* sentRows(sql)).map((row) => row.topic),
        ["r:W-1"],
      );
      const settleFact = sender
        .settle(orgId, { keys: [`fact:${fact}`] })
        .pipe(Effect.andThen(afterBatch(sender)));
      apns.sent.length = 0;
      yield* settleFact;
      assert.deepStrictEqual(apns.sent, []);
      // She says she has it in hand: the fact no longer needs her, and its notice goes.
      yield* sql`UPDATE kin_pulse_facts SET handled_by_kind = 'person', handled_by_id = ${member},
          handled_at = ${NOW}, handled_until = ${NOW + 3 * 24 * 60 * 60_000}
        WHERE fact_key = ${fact}`;
      yield* settleFact;
      assert.deepStrictEqual(
        apns.sent.map((push) => [push.token, payloadOf(push).body.withdraw]),
        [[memberPhone, [{ topic: "r:W-1", version: 1 }]]],
      );
    }).pipe(Effect.provide(build(apns)));
  });

  const readChat = (sql: SqlClient.SqlClient) =>
    sql`INSERT OR REPLACE INTO kin_read_state (org_id, chat_id, member_id, last_read_seq,
        updated_at)
      SELECT 'org_01', 'chat_pair', 'm_owner_pair', MAX(seq), ${T} FROM kin_messages
      WHERE chat_id = 'chat_pair'`;
  const withdrawnFrom = (apns: ReturnType<typeof makeApns>) =>
    apns.sent
      .filter((push) => push.token === ownerPhone)
      .flatMap((push) => (payloadOf(push).body.withdraw as Array<unknown> | undefined) ?? []);

  it.effect("the recovery pass withdraws what a restart's lost batch held, then is silent", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const from = { personId: member, memberId: "m_priya_pair" };
      const a = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "A" });
      yield* notify({ _tag: "message", orgId, messageId: a });
      // Read on the web, then the host restarts inside the batch window: no batch holds it.
      yield* readChat(sql);
      apns.sent.length = 0;
      yield* sender.recover;
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawnFrom(apns), [{ topic: "c:chat_pair", version: 1 }]);
      apns.sent.length = 0;
      yield* sender.recover;
      yield* afterBatch(sender);
      assert.deepStrictEqual(apns.sent, []);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect(
    "a card settled while its push was with the gateway is withdrawn after the send",
    () => {
      let during: (push: KinApnsPush) => Effect.Effect<void> = () => Effect.void;
      const apns = makeApns("ready", (push) => Effect.suspend(() => during(push)));
      return Effect.gen(function* () {
        const { notify, sql, sender } = yield* seedTopical;
        const card = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner]);
        // Closed while APNs has its push; the commit's own settle ran before the row stood.
        during = (push) =>
          push.token === ownerPhone && payloadOf(push).body.topic === `w:${card}`
            ? sql`UPDATE kin_widgets SET closed_at = ${T} WHERE widget_id = ${card}`.pipe(
                Effect.asVoid,
                Effect.orDie,
              )
            : Effect.void;
        yield* notify({ _tag: "widget", orgId, widgetId: card });
        during = () => Effect.void;
        apns.sent.length = 0;
        yield* afterBatch(sender);
        assert.deepStrictEqual(withdrawnFrom(apns), [{ topic: `w:${card}`, version: 1 }]);
      }).pipe(Effect.provide(build(apns)));
    },
  );

  it.effect("a withdrawal the gateway refused stays owed, and goes again", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const from = { personId: member, memberId: "m_priya_pair" };
      const a = yield* postMessage(sql, from, "posted", { chatId: "chat_pair", body: "A" });
      yield* notify({ _tag: "message", orgId, messageId: a });
      yield* readChat(sql);
      apns.answers.set(ownerPhone, { status: 503, reason: "ServiceUnavailable" });
      apns.sent.length = 0;
      yield* sender.settle(orgId, { topics: ["c:chat_pair" as KinPushTopic] });
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawnFrom(apns), [{ topic: "c:chat_pair", version: 1 }]);
      assert.deepStrictEqual(yield* sentRows(sql), [
        { person_id: owner, topic: "c:chat_pair", withdrawn: 0 },
      ]);
      apns.answers.delete(ownerPhone);
      apns.sent.length = 0;
      yield* sender.settle(orgId, { topics: ["c:chat_pair" as KinPushTopic] });
      yield* afterBatch(sender);
      assert.deepStrictEqual(withdrawnFrom(apns), [{ topic: "c:chat_pair", version: 1 }]);
      assert.deepStrictEqual(yield* sentRows(sql), [
        { person_id: owner, topic: "c:chat_pair", withdrawn: 1 },
      ]);
    }).pipe(Effect.provide(build(apns)));
  });

  it.effect("a phone's reconcile answers only its person's topics, from what stands now", () => {
    const apns = makeApns();
    return Effect.gen(function* () {
      const { notify, sql, sender } = yield* seedTopical;
      yield* pairChat(sql);
      const said = yield* postMessage(
        sql,
        { personId: member, memberId: "m_priya_pair" },
        "posted",
        {
          chatId: "chat_pair",
        },
      );
      yield* notify({ _tag: "message", orgId, messageId: said });
      const card = yield* postWidget(sql, "deferral", { phase: "confirmed" }, [owner]);
      yield* notify({ _tag: "widget", orgId, widgetId: card });
      const shown = ["c:chat_pair", `w:${card}`, "c:chat_dm", "u:device-1"] as Array<KinPushTopic>;
      // Topics it never sent her it doesn't know: the phone decides on those by their age.
      assert.deepStrictEqual(yield* sender.reconcile(orgId, owner, shown), {
        remove: [],
        unknown: ["c:chat_dm", "u:device-1"],
        badge: 2,
      });
      // Someone else's phone asking about her topics learns nothing of them.
      assert.deepStrictEqual((yield* sender.reconcile(orgId, member, shown)).remove, []);
      // Read elsewhere, and out of the card's chat: both settled, though no withdrawal went.
      yield* sql`INSERT INTO kin_read_state (org_id, chat_id, member_id, last_read_seq, updated_at)
        VALUES ('org_01', 'chat_pair', 'm_owner_pair', ${Number.MAX_SAFE_INTEGER}, ${T})`;
      yield* sql`UPDATE kin_chat_members SET left_at = ${T} WHERE member_id = 'm_owner'`;
      assert.deepStrictEqual(yield* sender.reconcile(orgId, owner, shown), {
        remove: [
          { topic: "c:chat_pair", version: 1 },
          { topic: `w:${card}`, version: 1 },
        ],
        unknown: ["c:chat_dm", "u:device-1"],
        badge: 0,
      });
      // Forgotten after a week: the store keeps no row to answer from, and says so.
      yield* prunePushSent(NOW + 8 * 24 * 60 * 60_000);
      assert.deepStrictEqual(yield* sentRows(sql), []);
      assert.deepStrictEqual((yield* sender.reconcile(orgId, owner, shown)).unknown, shown);
    }).pipe(Effect.provide(build(apns)));
  });
});
