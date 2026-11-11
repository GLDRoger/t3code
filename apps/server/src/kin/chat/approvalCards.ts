import {
  KinActionId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWaitingId,
  KinWidgetId,
  kinApprovalWidgetId,
  type KinActionKind,
  type KinPendingAction,
  type KinWidget,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { ActionRef } from "../approvals/PendingActions.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { KinChatHub } from "./KinChatHub.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import { KinChatService } from "./KinChatService.ts";

/**
 * Kinds carried in a lead's direct chat. A new phone's `register_approver_key` belongs to no lead,
 * so its card is on the owner's Approvals screen instead (`listKeys`' `enrolments`).
 */
const CARD_KINDS = [
  "merge_pull_request",
  "set_level",
] as const satisfies ReadonlyArray<KinActionKind>;
const isCardKind = (kind: KinActionKind) =>
  (CARD_KINDS as ReadonlyArray<KinActionKind>).includes(kind);

const decodeWaitingId = Schema.decodeEffect(KinWaitingId);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The lead whose direct chat carries the card: a raise names its lead, a merge its requester. */
const leadOf = (action: KinPendingAction) =>
  action.target._tag === "level" ? action.target.agentId : action.requestedBy.agentId;

const noticeBody = (action: KinPendingAction) => {
  switch (action.target._tag) {
    case "pull_request":
      return `Approval needed: merge ${action.target.repo} #${action.target.number}.`;
    case "level":
      return "Approval needed: change what an agent may do.";
    default:
      return "Approval needed.";
  }
};

/** A failure's log entry in the persistence error shape, whatever layer it came from. */
const logFailure = (operation: string, message: string) => (cause: Cause.Cause<unknown>) =>
  Effect.logWarning(message, toPersistenceSqlError(operation)(Cause.squash(cause)));

/**
 * Keeps one server-drawn approval card per action in the lead's direct chat, waiting on the
 * owner while the action does. The card carries only the action's id and where it stands; apps
 * read the facts from `kin.approvals.get`, so nothing an agent wrote reaches it.
 */
export const make = Effect.gen(function* () {
  const pending = yield* KinPendingActions;
  const repo = yield* KinChatRepository;
  const chat = yield* KinChatService;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* pending.changes;

  const ownerChat = Effect.fn("KinApprovalCards.ownerChat")(function* (action: KinPendingAction) {
    const [row] = yield* sql<{ chatId: string; owner: string }>`
        SELECT l.owner_chat_id AS "chatId", a.owner_person_id AS owner FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id AND c.kind = 'direct'
        WHERE l.org_id = ${action.orgId} AND l.agent_id = ${leadOf(action)} AND a.role = 'lead'
        ORDER BY l.agent_id`.pipe(
      Effect.mapError(toPersistenceSqlError("KinApprovalCards.ownerChat")),
    );
    return row;
  });

  const open = Effect.fn("KinApprovalCards.open")(function* (
    action: KinPendingAction,
    widgetId: KinWidgetId,
  ) {
    const owner = yield* ownerChat(action);
    if (owner === undefined) {
      yield* Effect.logInfo("Kin approval card has no chat", { actionId: action.id });
      return;
    }
    const updatedAt = iso(yield* Clock.currentTimeMillis);
    const personId = KinPersonId.make(owner.owner);
    const { message } = yield* chat.notice({
      orgId: action.orgId,
      chatId: KinChatId.make(owner.chatId),
      messageId: KinMessageId.make(widgetId),
      audience: "owner",
      body: noticeBody(action),
    });
    const widget: KinWidget = {
      orgId: action.orgId,
      chatId: message.chatId,
      widgetId,
      messageId: message.messageId,
      widgetClass: "native",
      type: "approval",
      revision: 1,
      state: { actionId: action.id, revision: action.revision, state: action.state },
      source: null,
      feed: null,
      awaiting: [personId],
      pinnedAt: null,
      closedAt: null,
      updatedAt,
    };
    yield* repo.insertWidget({ ...widget, audience: "owner" });
    const item = {
      waitingId: yield* decodeWaitingId(SecureRandom.uuidV4Unsafe()),
      orgId: action.orgId,
      personId,
      chatId: message.chatId,
      messageId: message.messageId,
      widgetId,
      reason: "approval" as const,
      createdAt: updatedAt,
      resolvedAt: null,
      resolution: null,
    };
    yield* repo.addApprovalWaiting(item);
    yield* hub.publish({ type: "widget.updated", orgId: action.orgId, widget });
    yield* hub.publish({ type: "waiting.updated", orgId: action.orgId, item });
  });

  const update = Effect.fn("KinApprovalCards.update")(function* (
    action: KinPendingAction,
    current: KinWidget,
  ) {
    const settled = action.state !== "awaiting_approval";
    const state = { actionId: action.id, revision: action.revision, state: action.state };
    const shown =
      typeof current.state === "object" &&
      current.state !== null &&
      "revision" in current.state &&
      typeof current.state.revision === "number" &&
      "state" in current.state
        ? { revision: current.state.revision, state: current.state.state }
        : null;
    // One way only: a settled action never waits again, and revisions only grow. So a card
    // that closed stays closed, and a read older than the card can't redraw it.
    if (current.closedAt !== null && !settled) return;
    if (shown !== null && shown.revision > state.revision) return;
    if (
      shown !== null &&
      shown.revision === state.revision &&
      shown.state === state.state &&
      (current.closedAt !== null) === settled
    )
      return;
    const now = iso(yield* Clock.currentTimeMillis);
    const widget = yield* repo.updateWidget({
      ...current,
      audience: "owner",
      state,
      awaiting: settled ? [] : current.awaiting,
      closedAt: settled ? (current.closedAt ?? now) : null,
      expectedRevision: current.revision,
      updatedAt: now,
    });
    if (settled)
      for (const item of yield* repo.waitingForWidget(widget)) {
        if (!(yield* repo.resolveWaiting({ ...item, resolution: action.state, resolvedAt: now })))
          continue;
        const resolved = yield* repo.getWaiting(item);
        if (Option.isSome(resolved))
          yield* hub.publish({
            type: "waiting.updated",
            orgId: item.orgId,
            item: resolved.value,
          });
      }
    yield* hub.publish({ type: "widget.updated", orgId: action.orgId, widget });
  });

  // The action is read inside the card's transaction, so a settlement that commits first is
  // what this pass draws, never a value read before it.
  const sync = Effect.fn("KinApprovalCards.sync")(
    function* (ref: ActionRef) {
      const widgetId = KinWidgetId.make(kinApprovalWidgetId(ref.actionId));
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const found = yield* pending.get(ref);
          if (Option.isNone(found) || !isCardKind(found.value.kind)) return;
          const action = found.value;
          const existing = yield* repo.getWidget({ orgId: action.orgId, widgetId });
          if (Option.isSome(existing)) {
            if (existing.value.type === "approval") yield* update(action, existing.value);
            return;
          }
          if (action.state === "awaiting_approval") yield* open(action, widgetId);
        }),
      );
    },
    Effect.catchCause(logFailure("KinApprovalCards.sync", "Kin approval card not updated")),
  );

  /** One org's open actions and still-open cards: whatever changed while the server was down. */
  const reconcileOrg = Effect.fn("KinApprovalCards.reconcileOrg")(
    function* (orgId: KinOrgId) {
      const rows = yield* sql<{ actionId: string }>`
          SELECT action_id AS "actionId" FROM kin_pending_actions
          WHERE org_id = ${orgId} AND state = 'awaiting_approval' AND kind IN ${sql.in(CARD_KINDS)}
          UNION
          SELECT p.action_id FROM kin_widgets w
          JOIN kin_pending_actions p ON p.org_id = w.org_id
            AND w.widget_id = 'kin-approval:' || p.action_id
          WHERE w.org_id = ${orgId} AND w.type = 'approval' AND w.closed_at IS NULL
          ORDER BY 1`.pipe(Effect.mapError(toPersistenceSqlError("KinApprovalCards.reconcileOrg")));
      yield* Effect.forEach(
        rows,
        (row) => sync({ orgId, actionId: KinActionId.make(row.actionId) }),
        { discard: true },
      );
    },
    Effect.catchCause(
      logFailure("KinApprovalCards.reconcileOrg", "Kin approval cards startup pass failed"),
    ),
  );

  const startup = Effect.fn("KinApprovalCards.startup")(
    function* () {
      const orgs = yield* sql<{ orgId: string }>`
          SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinApprovalCards.startup")),
      );
      yield* Effect.forEach(orgs, (org) => reconcileOrg(KinOrgId.make(org.orgId)), {
        discard: true,
      });
    },
    Effect.catchCause(
      logFailure("KinApprovalCards.startup", "Kin approval cards startup pass failed"),
    ),
  );

  // A clear takes the cards with the chat; an action still waiting on the owner gets its card back.
  const cleared = (yield* hub.subscribeAll).pipe(
    Stream.filter((event) => event.type === "chat.cleared"),
    Stream.runForEach((event) => reconcileOrg(event.orgId)),
  );

  return { changes, sync, startup, cleared };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cards = yield* make;
    yield* PubSub.take(cards.changes).pipe(
      Effect.flatMap(cards.sync),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* cards.cleared.pipe(Effect.forkScoped);
    yield* cards.startup().pipe(Effect.forkScoped);
  }),
);
