import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinChatId,
  KinKeyThumbprint,
  KinLevelRpcs,
  KinOrgId,
  KinPersonId,
  KinPromotionCard,
  KinShadowReviewCard,
  KinWidgetId,
  RpcScopeAuthorization,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Audit from "../approvals/Audit.ts";
import { makeSetLevelHandler } from "../approvals/handlers/setLevel.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import * as Chat from "../chat/layer.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as Kin from "../layer.ts";
import { makeKinHandlers } from "../rpcHandlers.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { dormantLeadDependencies } from "../lead/layer.testkit.ts";
import { KinPromotion } from "./Promotion.ts";

const DAY = 86_400_000;
const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const agentId = KinAgentId.make("lead");
const group = KinChatId.make("group");
const memberId = KinPersonId.make("priya");
const kid = KinKeyThumbprint.make("Y0ZkXVc6eNfxv3xVNHZJp1x7m3kQqb2O8s5vB1aWc9E");
const root = Kin.layer.pipe(
  Layer.provide(dormantLeadDependencies),
  Layer.provideMerge(Chat.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
  Layer.provideMerge(PendingActions.layer.pipe(Layer.provideMerge(Audit.layer))),
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
const decodePromotion = Schema.decodeUnknownSync(KinPromotionCard);
const decodeReview = Schema.decodeUnknownSync(KinShadowReviewCard);

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
  const entries = (
    ids: ReadonlyArray<string>,
    options: { readonly level?: string; readonly unlocks?: string } = {},
  ) =>
    Effect.forEach(
      ids,
      (id) => sql`INSERT INTO kin_shadow_entries
          (entry_id, org_id, agent_id, wakeup_id, level, unlocks_level, tool, input_json, would_target, created_at)
        VALUES (${id}, ${orgId}, ${agentId}, 'wake', ${options.level ?? "L0"}, ${options.unlocks ?? "L1"},
          'kin_chat_post', ${JSON.stringify({ body: `Draft ${id}` })}, ${group}, ${DAY})`,
      { discard: true },
    );
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
  const widget = (id: string) =>
    repo
      .getWidget({ orgId, widgetId: KinWidgetId.make(id) })
      .pipe(Effect.map(Option.getOrUndefined));
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
    entries,
    widget,
    level,
    client: yield* clientFor(handlers),
    member: yield* clientFor(memberHandlers),
    readOnly: yield* clientFor(handlers, [AuthOrchestrationReadScope]),
  };
});

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

it.effect(
  "eligibility: 20 reviewed, 16 Fine, none Harmful after 7 days; one Harmful blocks it",
  () =>
    Effect.gen(function* () {
      const { lead, client, entries, widget, services } = yield* seed;
      yield* entries(ids("e", 21));
      // Entries that unlock another level never count toward this one.
      yield* entries(ids("l2", 5), { unlocks: "L2" });
      for (const [index, id] of ids("e", 20).entries())
        yield* client["kin.levels.review"]({
          orgId: lead.orgId,
          entryId: id,
          verdict: index < 16 ? "fine" : "change",
        });
      for (const id of ids("l2", 5))
        yield* client["kin.levels.review"]({ orgId: lead.orgId, entryId: id, verdict: "fine" });
      let view = yield* client["kin.levels.get"](lead);
      assert.deepInclude(view.promotion, { from: "L0", to: "L1", reviewed: 20, fine: 16 });
      assert.isFalse(view.promotion.eligible);
      // That day's evening: the review card holds its entries and their verdicts.
      const promotion = Context.get(services, KinPromotion);
      yield* TestClock.adjust("36 hours");
      yield* promotion.evening(lead);
      assert.isUndefined(yield* widget(`promotion:${agentId}:L1`));
      const review = yield* widget(`shadow-review:${agentId}:1970-01-02`);
      assert.isDefined(review);
      const reviewed = decodeReview(review.state);
      assert.strictEqual(reviewed.total, 26);
      assert.strictEqual(
        reviewed.entries.find((entry) => entry.entryId === "e-0")?.verdict,
        "fine",
      );
      assert.strictEqual(reviewed.entries.find((entry) => entry.entryId === "e-20")?.verdict, null);

      yield* TestClock.adjust("6 days");
      yield* promotion.evening(lead);
      view = yield* client["kin.levels.get"](lead);
      assert.isTrue(view.promotion.eligible);
      const card = yield* widget(`promotion:${agentId}:L1`);
      assert.isDefined(card);
      assert.deepInclude(decodePromotion(card.state), {
        status: "ready",
        title: "Lead is ready for L1: 16 of 20 would have gone out unchanged, none harmful.",
      });
      assert.strictEqual(card.closedAt, null);

      // One Harmful, even at L0, means no promotion and no demotion.
      const harmful = yield* client["kin.levels.review"]({
        orgId: lead.orgId,
        entryId: "e-20",
        verdict: "harmful",
      });
      assert.strictEqual(harmful.loweredTo, null);
      view = yield* client["kin.levels.get"](lead);
      assert.isFalse(view.promotion.eligible);
      const closed = yield* widget(`promotion:${agentId}:L1`);
      assert.strictEqual(closed && decodePromotion(closed.state).status, "closed");
      assert.isNotNull(closed?.closedAt ?? null);
      assert.include(
        yield* client["kin.levels.raise"]({ ...lead, level: "L1" }).pipe(Effect.flip),
        { reason: "invalid_state" },
      );
    }).pipe(Effect.provide(root)),
);

it.effect("only the lead's owner reads, reviews, lowers or raises; others are refused", () =>
  Effect.gen(function* () {
    const { lead, client, member, readOnly, entries, sql, level } = yield* seed;
    yield* entries(["e-0"]);
    yield* sql`UPDATE kin_leads SET level = 'L2' WHERE org_id = ${lead.orgId}`;
    const lowerGroup = { ...lead, chatId: group, level: "L0" as const };
    const refusals = yield* Effect.all([
      member["kin.levels.get"](lead).pipe(Effect.flip),
      member["kin.levels.review"]({ orgId: lead.orgId, entryId: "e-0", verdict: "harmful" }).pipe(
        Effect.flip,
      ),
      member["kin.levels.lower"](lowerGroup).pipe(Effect.flip),
      member["kin.levels.raise"]({ ...lead, level: "L3" }).pipe(Effect.flip),
      member["kin.levels.deferPromotion"](lead).pipe(Effect.flip),
      member["kin.levels.shadowMemory"]({ ...lead, choice: "keep" }).pipe(Effect.flip),
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
      readOnly["kin.levels.review"]({ orgId: lead.orgId, entryId: "e-0", verdict: "fine" }).pipe(
        Effect.flip,
      ),
    ]);
    for (const refusal of forbidden)
      assert.strictEqual(refusal._tag, "EnvironmentAuthorizationError");
    const [entry] = yield* sql<{
      verdict: string | null;
    }>`SELECT verdict FROM kin_shadow_entries ORDER BY entry_id`;
    assert.strictEqual(entry?.verdict, null);
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
  }).pipe(Effect.provide(root)),
);

it.effect("a raise applies only through the claimed, owner-granted set_level action", () =>
  Effect.gen(function* () {
    const { owner, lead, client, entries, widget, sql, services, level } = yield* seed;
    const pending = yield* PendingActions.KinPendingActions;
    yield* entries(ids("e", 20));
    for (const id of ids("e", 20))
      yield* client["kin.levels.review"]({ orgId: lead.orgId, entryId: id, verdict: "fine" });
    yield* TestClock.adjust("7 days");
    yield* Context.get(services, KinPromotion).evening(lead);
    assert.include(yield* client["kin.levels.raise"]({ ...lead, level: "L2" }).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    const { actionId } = yield* client["kin.levels.raise"]({ ...lead, level: "L1" });
    assert.strictEqual(
      (yield* client["kin.levels.raise"]({ ...lead, level: "L1" })).actionId,
      actionId,
    );
    const action = Option.getOrThrow(yield* pending.get({ orgId: lead.orgId, actionId }));
    assert.deepInclude(action, { kind: "set_level", state: "awaiting_approval" });
    assert.deepStrictEqual(action.requestedBy, {
      agentId: "kin-promotion",
      threadId: "kin-promotion",
    });
    const card = yield* widget(`promotion:${agentId}:L1`);
    assert.deepInclude(card && decodePromotion(card.state), {
      status: "awaiting_approval",
      actionId,
    });

    const withSql = Effect.provideService(SqlClient.SqlClient, sql);
    const cards = Effect.provideService(
      KinLevels.KinPromotionCards,
      Context.get(services, KinLevels.KinPromotionCards),
    );
    const handler = yield* makeSetLevelHandler.pipe(withSql);
    // Without a verified, claimed grant nothing raises the level.
    assert.include(
      yield* KinLevels.raiseByGrant({ orgId: lead.orgId, actionId }).pipe(withSql, Effect.flip),
      { _tag: "KinLevelRefused", reason: "not_granted" },
    );
    yield* sql`INSERT INTO kin_approver_keys (thumbprint, org_id, public_jwk_json, human_id,
        device_label, platform, hardware, attested, state, created_at)
      VALUES (${kid}, ${lead.orgId}, '{}', ${owner.personId}, 'Pixel 9', 'android', 'tee', 1, 'active', 0)`;
    const iat = Math.floor((7 * DAY) / 1000);
    const approved = yield* pending.approve({
      orgId: lead.orgId,
      actionId,
      revision: action.revision,
      nonce: action.nonce,
      jti: "jti-raise-0000000000000",
      approverHumanId: owner.personId,
      keyThumbprint: kid,
      compact: "compact",
      iat,
      exp: iat + 600,
    });
    if (approved._tag !== "approved") return assert.fail(`not approved: ${approved._tag}`);
    // Approved but not claimed by the executor is still not enough.
    assert.include(yield* handler.run(action, approved.grant).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    assert.strictEqual(yield* level, "L0");
    assert.isTrue(
      yield* pending.claim({
        orgId: lead.orgId,
        actionId,
        revision: action.revision,
        grantId: approved.grant.id,
      }),
    );
    const claimed = { ...action, state: "executing" as const };
    yield* handler.precheck(claimed);
    assert.strictEqual(yield* handler.run(claimed, approved.grant).pipe(cards), "succeeded");
    assert.strictEqual(yield* level, "L1");
    assert.strictEqual(yield* handler.reconcile(claimed), "done");
    const raised = yield* widget(`promotion:${agentId}:L1`);
    assert.deepInclude(raised && decodePromotion(raised.state), {
      status: "raised",
      shadowMemory: "pending",
    });
    // The same claim can't raise a second level.
    assert.include(
      yield* KinLevels.raiseByGrant({ orgId: lead.orgId, actionId }).pipe(withSql, Effect.flip),
      { _tag: "KinLevelRefused" },
    );
    assert.strictEqual(yield* level, "L1");
  }).pipe(Effect.provide(root)),
);

it.effect("Harmful on what the lead did at L1 or above lowers it a level and tells the owner", () =>
  Effect.gen(function* () {
    const { lead, client, entries, sql, direct, level } = yield* seed;
    yield* sql`UPDATE kin_leads SET level = 'L1' WHERE org_id = ${lead.orgId}`;
    yield* entries(["at-l1"], { level: "L1", unlocks: "L2" });
    const first = yield* client["kin.levels.review"]({
      orgId: lead.orgId,
      entryId: "at-l1",
      verdict: "harmful",
    });
    assert.strictEqual(first.loweredTo, "L0");
    assert.strictEqual(yield* level, "L0");
    const [notice] = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${lead.orgId} AND chat_id = ${direct.chatId}
        AND message_id = 'kin-level-lowered:at-l1'
      ORDER BY message_id`;
    assert.include(notice?.body ?? "", "moved down to L0");
    // The same verdict again lowers nothing further.
    assert.strictEqual(
      (yield* client["kin.levels.review"]({
        orgId: lead.orgId,
        entryId: "at-l1",
        verdict: "harmful",
      })).loweredTo,
      null,
    );
    assert.strictEqual(yield* level, "L0");
  }).pipe(Effect.provide(root)),
);

it.effect("shadow memory is settled only after L0, through the attached writer", () =>
  Effect.gen(function* () {
    const { lead, client, sql, services } = yield* seed;
    const input = { ...lead, choice: "keep" as const };
    assert.include(yield* client["kin.levels.shadowMemory"](input).pipe(Effect.flip), {
      reason: "invalid_state",
    });
    yield* sql`UPDATE kin_leads SET level = 'L1' WHERE org_id = ${lead.orgId}`;
    assert.include(yield* client["kin.levels.shadowMemory"](input).pipe(Effect.flip), {
      reason: "unavailable",
    });
    const settled: Array<{ agentId: string; keep: boolean }> = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Context.get(services, KinPromotion).attachShadowMemory((_org, agent, keep) =>
          Effect.sync(() => settled.push({ agentId: agent, keep })),
        );
        yield* client["kin.levels.shadowMemory"](input);
        yield* client["kin.levels.shadowMemory"]({ ...input, choice: "discard" });
      }),
    );
    assert.deepStrictEqual(settled, [
      { agentId, keep: true },
      { agentId, keep: false },
    ]);
    // Detached with its runtime: nothing settles memory any more.
    assert.include(yield* client["kin.levels.shadowMemory"](input).pipe(Effect.flip), {
      reason: "unavailable",
    });
  }).pipe(Effect.provide(root)),
);

it.effect("level cards take no taps through the lead's widget path; Another week waits", () =>
  Effect.gen(function* () {
    const { lead, client, entries, services, owner, widget } = yield* seed;
    yield* entries(ids("e", 20));
    for (const id of ids("e", 20))
      yield* client["kin.levels.review"]({ orgId: lead.orgId, entryId: id, verdict: "fine" });
    yield* TestClock.adjust("36 hours");
    yield* Context.get(services, KinPromotion).evening(lead);
    yield* TestClock.adjust("6 days");
    yield* Context.get(services, KinPromotion).evening(lead);
    const chat = Context.get(services, KinChatService);
    for (const widgetId of [`promotion:${agentId}:L1`, `shadow-review:${agentId}:1970-01-02`])
      assert.include(
        yield* chat
          .act(owner, {
            widgetId: KinWidgetId.make(widgetId),
            revision: 1,
            actionId: "raise",
            clientActionId: widgetId,
          })
          .pipe(Effect.flip),
        { reason: "not_allowed" },
      );
    yield* client["kin.levels.deferPromotion"](lead);
    const deferred = yield* widget(`promotion:${agentId}:L1`);
    assert.strictEqual(deferred && decodePromotion(deferred.state).status, "deferred");
    // The card comes back after the week; Raise works from settings meanwhile.
    yield* TestClock.adjust("7 days");
    yield* Context.get(services, KinPromotion).evening(lead);
    const back = yield* widget(`promotion:${agentId}:L1`);
    assert.strictEqual(back && decodePromotion(back.state).status, "ready");
    assert.isString((yield* client["kin.levels.raise"]({ ...lead, level: "L1" })).actionId);
  }).pipe(Effect.provide(root)),
);
