import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinEventId,
  KinWidgetId,
  ThreadId,
  kinApprovalWidgetId,
  type KinActionTarget,
  type KinPendingAction,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Audit from "../approvals/Audit.ts";
import * as PendingActions from "../approvals/PendingActions.ts";
import { KIN_LEVEL_REQUESTER } from "../approvals/PendingActions.ts";
import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as ApprovalCards from "./approvalCards.ts";
import * as Chat from "./layer.ts";
import { KinChatService } from "./KinChatService.ts";
import * as Repository from "./KinChatRepository.ts";
import { KinIdentity } from "./KinIdentity.ts";

const session = {
  sessionId: AuthSessionId.make("owner-session"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const agentId = KinAgentId.make("lead");

/** `stale` makes the next `get` return that snapshot instead of the row: a read from earlier. */
const pendingWithStaleRead = (stale: Ref.Ref<Option.Option<KinPendingAction>>) =>
  Layer.effect(
    PendingActions.KinPendingActions,
    Effect.gen(function* () {
      const real = yield* PendingActions.KinPendingActions;
      return PendingActions.KinPendingActions.of({
        ...real,
        get: (ref) =>
          Effect.gen(function* () {
            const snapshot = yield* Ref.getAndSet(stale, Option.none());
            return Option.isSome(snapshot) ? snapshot : yield* real.get(ref);
          }),
      });
    }),
  );

const layer = (stale: Ref.Ref<Option.Option<KinPendingAction>>) =>
  pendingWithStaleRead(stale).pipe(
    Layer.provideMerge(Chat.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
    Layer.provideMerge(PendingActions.layer.pipe(Layer.provideMerge(Audit.layer))),
    Layer.provideMerge(Sqlite.layerMemory),
  );

const seed = Effect.gen(function* () {
  const repo = yield* Repository.KinChatRepository;
  const chat = yield* KinChatService;
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(session.sessionId);
  const [owner] = yield* (yield* KinIdentity).resolve(session);
  assert.isDefined(owner);
  yield* repo.insertAgent({
    orgId: owner.orgId,
    agentId,
    displayName: "Lead",
    role: "lead",
    ownerPersonId: owner.personId,
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  const direct = yield* chat.createDirect(owner, { orgId: owner.orgId, agentId });
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json, worker_projects_json, owner_chat_id)
    VALUES (${agentId}, ${owner.orgId}, 'Lead', 'L0', 0, '{}', '[]', ${direct.chatId})`;
  const target: KinActionTarget = { _tag: "level", agentId, level: "L1" };
  const { action } = yield* (yield* PendingActions.KinPendingActions).create({
    orgId: owner.orgId,
    kind: "set_level",
    target,
    resolved: { _tag: "none" },
    targetDigest: PendingActions.kinTargetDigest("set_level", target, { _tag: "none" }),
    reason: "Raise the lead.",
    requestedBy: {
      agentId: KinAgentId.make(KIN_LEVEL_REQUESTER),
      threadId: ThreadId.make(KIN_LEVEL_REQUESTER),
    },
    provenance: {
      startedBy: { humanId: owner.personId },
      startedByRole: "owner",
      chain: [],
      ceilingBelowOwner: false,
    },
    source: KinEventId.make("evt-raise"),
  });
  return { owner, action, ref: { orgId: action.orgId, actionId: action.id } };
});

const startupRace = (stale: Ref.Ref<Option.Option<KinPendingAction>>) =>
  Effect.gen(function* () {
    const { action, ref } = yield* seed;
    const pending = yield* PendingActions.KinPendingActions;
    const repo = yield* Repository.KinChatRepository;
    const sql = yield* SqlClient.SqlClient;
    const cards = yield* ApprovalCards.make;
    const widgetId = KinWidgetId.make(kinApprovalWidgetId(action.id));
    const card = repo
      .getWidget({ orgId: action.orgId, widgetId })
      .pipe(Effect.map((found) => Option.getOrThrow(found)));
    const openWaiting = sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_waiting
      WHERE widget_id = ${widgetId} AND resolved_at IS NULL`.pipe(Effect.map((rows) => rows[0]?.n));

    yield* cards.startup();
    assert.isNull((yield* card).closedAt);
    assert.strictEqual(yield* openWaiting, 1);

    // Startup read the action while it waited; the owner's decline then settles it and its
    // change closes the card; startup's write lands last.
    const readByStartup = Option.getOrThrow(yield* pending.get(ref));
    assert.isTrue(yield* pending.transition({ ...ref, revision: action.revision, to: "rejected" }));
    yield* cards.sync(ref);
    assert.isNotNull((yield* card).closedAt);
    yield* Ref.set(stale, Option.some(readByStartup));
    yield* cards.sync(ref);

    const after = yield* card;
    assert.isNotNull(after.closedAt);
    assert.deepStrictEqual(after.state, {
      actionId: action.id,
      revision: action.revision,
      state: "rejected",
    });
    assert.deepStrictEqual(after.awaiting, []);
    assert.strictEqual(yield* openWaiting, 0);
  }).pipe(Effect.provide(layer(stale)));

it.effect("a startup pass that read the action before it settled doesn't reopen its card", () =>
  Ref.make(Option.none<KinPendingAction>()).pipe(Effect.flatMap(startupRace)),
);
