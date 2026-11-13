import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinChatId,
  type KinGrantPayload,
  type KinActionId,
  kinApprovalWidgetId,
  KinLevelRpcs,
  KinOrgId,
  KinPersonId,
  RpcScopeAuthorization,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Audit from "../approvals/Audit.ts";
import { makeSetLevelHandler } from "../approvals/handlers/setLevel.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import * as Chat from "../chat/layer.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Kin from "../layer.ts";
import { insertActiveKey, makeApprovalKey, signCompact } from "../approvals/grant.testkit.ts";
import { recordFacts } from "../approvals/grantFacts.ts";
import * as KeySeal from "../approvals/KeySeal.ts";
import { makeKinHandlers } from "../rpcHandlers.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { kinHostDependencies } from "../lead/layer.testkit.ts";

const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const agentId = KinAgentId.make("lead");
const group = KinChatId.make("group");
const memberId = KinPersonId.make("priya");
const ownerKey = makeApprovalKey();
const memberKey = makeApprovalKey();
// The test seal, so `seed` can write key rows as the server activates them.
const root = Kin.layerWithSeal(KeySeal.layerTest()).pipe(
  Layer.provideMerge(kinHostDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(
    Layer.merge(PendingActions.layer, PendingActions.ledgerLayer).pipe(
      Layer.provideMerge(Audit.layer),
    ),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
);
const probe = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);
const rpcs = RpcGroup.make(...KinLevelRpcs, ...probe.requests.values()).middleware(
  RpcScopeAuthorization,
);

const clientFor = (
  handlers: Effect.Success<ReturnType<typeof makeKinHandlers>>,
  scopes: ReadonlyArray<(typeof AuthStandardClientScopes)[number]> = AuthStandardClientScopes,
) =>
  RpcTest.makeClient(rpcs).pipe(
    Effect.provide(
      Layer.merge(
        rpcs.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
        RpcAuthorization.layer(scopes),
      ),
    ),
  );

/** An L0 lead, its owner's direct chat, a group it is in, and one finished wake-up. */
const seed = Effect.gen(function* () {
  const kin = yield* Kin.KinServer;
  const services = Option.getOrThrow(kin.services);
  const identity = Context.get(services, KinIdentity);
  const chat = Context.get(services, KinChatService);
  const repo = yield* Repository.KinChatRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(session.sessionId);
  const [owner] = yield* identity.resolve(session);
  assert.isDefined(owner);
  const { orgId } = owner;
  const at = "1970-01-01T00:00:00.000Z";
  yield* repo.insertAgent({
    orgId,
    agentId,
    displayName: "Lead",
    role: "lead",
    ownerPersonId: owner.personId,
    createdAt: at,
  });
  const direct = yield* chat.createDirect(owner, { orgId, agentId });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${orgId}, 'Lead', 'L0', 0, '{}', '[]', ${direct.chatId})`;
  yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at)
    VALUES (${group}, ${orgId}, 'team_group', 0, ${at})`;
  yield* sql`INSERT INTO kin_chat_members (member_id, org_id, chat_id, principal_kind, agent_id, role, joined_at)
    VALUES ('group-lead', ${orgId}, ${group}, 'agent', ${agentId}, 'member', ${at})`;
  yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, thread_id, model, started_at, status, event_ids)
    VALUES ('wake', ${orgId}, ${agentId}, 'lead-thread', 'test', 0, 'completed', '[]')`;
  yield* repo.insertPerson({
    orgId,
    personId: memberId,
    handle: "priya",
    displayName: "Priya",
    githubLogin: null,
    createdAt: at,
  });
  const lead = { orgId, agentId };
  for (const [humanId, key] of [
    [owner.personId, ownerKey],
    [memberId, memberKey],
  ] as const)
    yield* insertActiveKey({ key, orgId, humanId }).pipe(Effect.provide(KeySeal.layerTest()));
  const pending = {
    ...(yield* PendingActions.KinPendingActions),
    ...(yield* PendingActions.KinExecutionLedger),
  };
  let jti = 0;
  /** Signs the action as `human`, then claims it as the executor would unless `claim` is false. */
  const sign = (
    actionId: KinActionId,
    { human = owner.personId, claim = true }: { human?: KinPersonId; claim?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      const action = Option.getOrThrow(yield* pending.get({ orgId, actionId }));
      const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const key = human === owner.personId ? ownerKey : memberKey;
      const grantJti = `jti-raise-${String(jti++).padStart(16, "0")}`;
      const payload = {
        v: 1,
        orgId,
        actionId,
        revision: action.revision,
        nonce: action.nonce,
        ...recordFacts(action),
        approver: { humanId: human, kid: key.kid },
        decision: "approve",
        jti: grantJti,
        iat,
        exp: iat + 600,
      } as unknown as KinGrantPayload;
      const approved = yield* pending.approve({
        orgId,
        actionId,
        revision: action.revision,
        nonce: action.nonce,
        jti: grantJti,
        approverHumanId: human,
        keyThumbprint: key.kid,
        compact: signCompact(key, { typ: "kin-grant+jws", alg: "ES256", kid: key.kid }, payload),
        iat,
        exp: iat + 600,
      });
      if (approved._tag !== "approved") return assert.fail(`not approved: ${approved._tag}`);
      if (!claim) return { action, grant: approved.grant };
      assert.isTrue(
        yield* pending.claim({
          orgId,
          actionId,
          revision: action.revision,
          grantId: approved.grant.id,
        }),
      );
      return { action: { ...action, state: "executing" as const }, grant: approved.grant };
    });
  const handlers = yield* makeKinHandlers(session);
  const memberHandlers = yield* makeKinHandlers(session).pipe(
    Effect.provideService(Kin.KinServer, {
      ...kin,
      services: Option.some(
        Context.add(services, KinIdentity, {
          ...identity,
          resolve: () => Effect.succeed([{ _tag: "person", orgId, personId: memberId }]),
        }),
      ),
    }),
  );
  const level = Effect.gen(function* () {
    const [row] = yield* sql<{
      level: string;
    }>`SELECT level FROM kin_leads WHERE org_id = ${orgId} ORDER BY agent_id`;
    return row?.level;
  });
  return {
    owner,
    lead,
    direct,
    sql,
    services,
    pending,
    sign,
    level,
    client: yield* clientFor(handlers),
    member: yield* clientFor(memberHandlers),
    readOnly: yield* clientFor(handlers, [AuthOrchestrationReadScope]),
  };
});

it.effect("only the lead's owner reads, lowers or raises; others are refused", () =>
  Effect.gen(function* () {
    const { lead, client, member, readOnly, sql, level, direct } = yield* seed;
    yield* sql`UPDATE kin_leads SET level = 'L2' WHERE org_id = ${lead.orgId}`;
    const lowerGroup = { ...lead, chatId: group, level: "L0" as const };
    const refusals = yield* Effect.all([
      member["kin.levels.get"](lead).pipe(Effect.flip),
      member["kin.levels.lower"](lowerGroup).pipe(Effect.flip),
      member["kin.levels.raise"]({ ...lead, level: "L3" }).pipe(Effect.flip),
    ]);
    for (const refusal of refusals)
      assert.include(refusal, { _tag: "KinChatError", reason: "not_allowed" });
    assert.include(
      yield* client["kin.levels.get"]({ orgId: KinOrgId.make("foreign"), agentId }).pipe(
        Effect.flip,
      ),
      { reason: "not_found" },
    );
    // A read-only session may look, never change.
    assert.strictEqual((yield* readOnly["kin.levels.get"](lead)).level, "L2");
    const forbidden = yield* Effect.all([
      readOnly["kin.levels.lower"](lowerGroup).pipe(Effect.flip),
      readOnly["kin.levels.raise"]({ ...lead, level: "L3" }).pipe(Effect.flip),
    ]);
    for (const refusal of forbidden)
      assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
    assert.strictEqual(yield* level, "L2");

    // Lowering applies at once and shows; a chat goes back up only through a grant.
    let view = yield* client["kin.levels.lower"](lowerGroup);
    assert.deepStrictEqual(
      view.chats.map(({ chatId, level }) => ({ chatId, level })),
      [{ chatId: group, level: "L0" }],
    );
    assert.strictEqual(
      yield* KinLevels.effectiveLevel({ ...lead, chatId: group }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ),
      "L0",
    );
    view = yield* client["kin.levels.lower"]({ ...lead, level: "L1" });
    assert.strictEqual(view.level, "L1");
    // The owner's DM stays at L2 without a row of its own, and shows it.
    assert.deepStrictEqual(
      view.chats.map(({ chatId, level }) => ({ chatId, level })),
      [
        { chatId: group, level: "L0" },
        { chatId: direct.chatId, level: "L2" },
      ],
    );
    assert.include(yield* client["kin.levels.lower"]({ ...lead, level: "L1" }).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    const raised = yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L1" });
    assert.strictEqual(
      (yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L1" })).actionId,
      raised.actionId,
    );
    view = yield* client["kin.levels.get"](lead);
    assert.strictEqual(view.chats[0]?.level, "L0");
    assert.include(
      yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L2" }).pipe(Effect.flip),
      { reason: "invalid_state" },
    );
    // Once the lead has left the chat, no raise for it is created or handed back.
    yield* sql`UPDATE kin_chat_members SET left_at = '1970-01-02T00:00:00.000Z'
      WHERE org_id = ${lead.orgId} AND member_id = 'group-lead'`;
    yield* sql`UPDATE kin_pending_actions SET state = 'rejected' WHERE org_id = ${lead.orgId}`;
    assert.include(
      yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L1" }).pipe(Effect.flip),
      { reason: "not_found" },
    );
    const [actions] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_pending_actions
      WHERE org_id = ${lead.orgId} ORDER BY n`;
    assert.strictEqual(actions?.n, 1);
  }).pipe(Effect.provide(root)),
);

const executor = (ctx: Effect.Success<typeof seed>) =>
  Effect.gen(function* () {
    const withSql = Effect.provideService(SqlClient.SqlClient, ctx.sql);
    const handler = yield* makeSetLevelHandler.pipe(withSql);
    const raiseByGrant = (actionId: KinActionId) =>
      KinLevels.raiseByGrant({ orgId: ctx.lead.orgId, actionId }).pipe(withSql, Effect.flip);
    return { handler, raiseByGrant };
  });

it.effect("a raise applies only through the claimed set_level action its own owner signed", () =>
  Effect.gen(function* () {
    const ctx = yield* seed;
    const { lead, client, sql, level, pending, sign } = ctx;
    assert.include(yield* client["kin.levels.raise"]({ ...lead, level: "L0" }).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    const { actionId } = yield* client["kin.levels.raise"]({ ...lead, level: "L1" });
    assert.strictEqual(
      (yield* client["kin.levels.raise"]({ ...lead, level: "L1" })).actionId,
      actionId,
    );
    const action = Option.getOrThrow(yield* pending.get({ orgId: lead.orgId, actionId }));
    // The owner's approval reads in plain words, never as a level.
    assert.deepInclude(action, {
      kind: "set_level",
      state: "awaiting_approval",
      reason: "Let Lead post.",
    });
    assert.deepStrictEqual(action.requestedBy, {
      agentId: "kin-promotion",
      threadId: "kin-promotion",
    });
    assert.deepStrictEqual((yield* client["kin.levels.get"](lead)).pendingRaises, [
      { actionId, chatId: null, level: "L1", state: "awaiting_approval" },
    ]);

    const { handler, raiseByGrant } = yield* executor(ctx);
    const notGranted = { _tag: "KinLevelRefused", reason: "not_granted" } as const;
    // Without a verified, claimed grant nothing raises the level.
    assert.include(yield* raiseByGrant(actionId), notGranted);
    // Approved but not claimed by the executor is still not enough.
    const approved = yield* sign(actionId, { human: memberId, claim: false });
    assert.include(yield* handler.run(action, approved.grant).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    // Claimed under another person's grant, even an owner of the org, it never applies.
    assert.isTrue(
      yield* pending.claim({
        orgId: lead.orgId,
        actionId,
        revision: action.revision,
        grantId: approved.grant.id,
      }),
    );
    const claimedByMember = { ...action, state: "executing" as const };
    assert.include(yield* handler.run(claimedByMember, approved.grant).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    assert.include(yield* raiseByGrant(actionId), notGranted);
    assert.strictEqual(yield* level, "L0");
    // Once that execution failed, the action never applies.
    yield* pending.finish({ orgId: lead.orgId, actionId, outcome: "failed", error: "refused" });
    assert.include(yield* raiseByGrant(actionId), notGranted);
    assert.strictEqual(yield* level, "L0");

    const second = (yield* client["kin.levels.raise"]({ ...lead, level: "L1" })).actionId;
    assert.notStrictEqual(second, actionId);
    const signed = yield* sign(second);
    yield* handler.precheck(signed.action);
    assert.strictEqual(yield* handler.run(signed.action, signed.grant), "succeeded");
    assert.strictEqual(yield* level, "L1");
    assert.strictEqual(yield* handler.reconcile(signed.action), "done");
    // After success the action is spent: with the lead back at L0, it still refuses.
    yield* pending.finish({ orgId: lead.orgId, actionId: second, outcome: "succeeded" });
    yield* sql`UPDATE kin_leads SET level = 'L0', level_since = 0 WHERE org_id = ${lead.orgId}`;
    assert.include(yield* raiseByGrant(second), notGranted);
    assert.strictEqual(yield* level, "L0");
  }).pipe(Effect.provide(root)),
);

it.effect("the executor applies an approved raise on a host without GitHub configured", () =>
  Effect.gen(function* () {
    const ctx = yield* seed;
    const { lead, client, level, pending, sign, services, direct, owner, sql } = ctx;
    const events = yield* Context.get(services, KinChatHub).subscribeAll;
    const { actionId } = yield* client["kin.levels.raise"]({ ...lead, level: "L1" });
    // The raise waits on the owner as an approval card in the lead's direct chat.
    const approvalCard = (closed: boolean) =>
      events.pipe(
        Stream.filterMap((event) =>
          event.type === "widget.updated" &&
          event.widget.widgetId === kinApprovalWidgetId(actionId) &&
          (event.widget.closedAt !== null) === closed
            ? Result.succeed(event.widget)
            : Result.failVoid,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
    const waiting = sql<{ person: string; resolution: string | null }>`
      SELECT person_id AS person, resolution FROM kin_waiting
      WHERE widget_id = ${kinApprovalWidgetId(actionId)} AND reason = 'approval'`;
    assert.deepInclude(yield* approvalCard(false), {
      chatId: direct.chatId,
      type: "approval",
      awaiting: [owner.personId],
      state: { actionId, revision: 0, state: "awaiting_approval" },
    });
    assert.deepStrictEqual(yield* waiting, [{ person: owner.personId, resolution: null }]);
    // Approved only: the production worker claims and runs it, with no credential check.
    yield* sign(actionId, { claim: false });
    assert.deepInclude(yield* approvalCard(true), {
      awaiting: [],
      state: { actionId, revision: 0, state: "approved" },
    });
    assert.deepStrictEqual(yield* waiting, [{ person: owner.personId, resolution: "approved" }]);
    yield* TestClock.adjust("1 second");
    assert.deepInclude(Option.getOrThrow(yield* pending.get({ orgId: lead.orgId, actionId })), {
      state: "succeeded",
    });
    assert.strictEqual(yield* level, "L1");
  }).pipe(Effect.scoped, Effect.provide(root)),
);

it.effect("lowering withdraws the raises it overtook and shows what stays open", () =>
  Effect.gen(function* () {
    const ctx = yield* seed;
    const { lead, client, sql, pending, sign } = ctx;
    const state = (actionId: KinActionId) =>
      pending
        .get({ orgId: lead.orgId, actionId })
        .pipe(Effect.map((action) => Option.getOrThrow(action).state));
    yield* sql`UPDATE kin_leads SET level = 'L3' WHERE org_id = ${lead.orgId}`;
    yield* client["kin.levels.lower"]({ ...lead, chatId: group, level: "L1" });
    const toL2 = (yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L2" }))
      .actionId;
    const toL3 = (yield* client["kin.levels.raise"]({ ...lead, chatId: group, level: "L3" }))
      .actionId;
    assert.deepStrictEqual(
      (yield* client["kin.levels.get"](lead)).pendingRaises.map(({ level }) => level),
      ["L2", "L3"],
    );
    // A lower lead level withdraws a chat raise above it and keeps the one it still allows.
    let view = yield* client["kin.levels.lower"]({ ...lead, level: "L2" });
    assert.deepStrictEqual(
      view.pendingRaises.map(({ actionId }) => actionId),
      [toL2],
    );
    assert.strictEqual(yield* state(toL3), "cancelled");
    view = yield* client["kin.levels.lower"]({ ...lead, chatId: group, level: "L0" });
    assert.deepStrictEqual(view.pendingRaises, []);
    assert.strictEqual(yield* state(toL2), "cancelled");

    // An approved raise of the lead itself is voided when the lead goes below it.
    yield* sql`UPDATE kin_leads SET level = 'L1', level_since = 0 WHERE org_id = ${lead.orgId}`;
    const toLeadL2 = (yield* client["kin.levels.raise"]({ ...lead, level: "L2" })).actionId;
    yield* sign(toLeadL2, { claim: false });
    assert.strictEqual(yield* state(toLeadL2), "approved");
    view = yield* client["kin.levels.lower"]({ ...lead, level: "L0" });
    assert.deepStrictEqual(view.pendingRaises, []);
    assert.strictEqual(yield* state(toLeadL2), "voided");
  }).pipe(Effect.provide(root)),
);
