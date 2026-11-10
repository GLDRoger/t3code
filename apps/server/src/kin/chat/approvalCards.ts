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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import type { ActionRef } from "../approvals/PendingActions.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { KinChatHub } from "./KinChatHub.ts";
import { KinChatRepository } from "./KinChatRepository.ts";
import { KinChatService } from "./KinChatService.ts";

/** Kinds the phone can approve today; other kinds have no card yet and stay off the owner's list. */
const CARD_KINDS: ReadonlySet<KinActionKind> = new Set(["merge_pull_request", "set_level"]);

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
      return `Approval needed: raise to ${action.target.level}.`;
    default:
      return "Approval needed.";
  }
};

/**
 * Keeps one server-drawn approval card per action in the lead's direct chat, waiting on the
 * owner while the action does. The card carries only the action's id and where it stands; apps
 * read the facts from `kin.approvals.get`, so nothing an agent wrote reaches it.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
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
        ORDER BY l.agent_id`;
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
      yield* repo.insertWidget(widget);
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
      const sameState =
        typeof current.state === "object" &&
        current.state !== null &&
        "revision" in current.state &&
        "state" in current.state &&
        current.state.revision === state.revision &&
        current.state.state === state.state;
      if (sameState && (current.closedAt !== null) === settled) return;
      const now = iso(yield* Clock.currentTimeMillis);
      const widget = yield* repo.updateWidget({
        ...current,
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

    const sync = Effect.fn("KinApprovalCards.sync")(
      function* (ref: ActionRef) {
        const found = yield* pending.get(ref);
        if (Option.isNone(found) || !CARD_KINDS.has(found.value.kind)) return;
        const action = found.value;
        const widgetId = KinWidgetId.make(kinApprovalWidgetId(action.id));
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* repo.getWidget({ orgId: action.orgId, widgetId });
            if (Option.isSome(existing)) {
              if (existing.value.type === "approval") yield* update(action, existing.value);
              return;
            }
            if (action.state === "awaiting_approval") yield* open(action, widgetId);
          }),
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Kin approval card not updated", Cause.pretty(cause).slice(0, 500)),
      ),
    );

    // Anything that changed while the server was down: open actions, and cards still open.
    const startup = Effect.gen(function* () {
      const rows = yield* sql<{ orgId: string; actionId: string }>`
        SELECT org_id AS "orgId", action_id AS "actionId" FROM kin_pending_actions
        WHERE state = 'awaiting_approval' AND kind IN ('merge_pull_request', 'set_level')
        UNION
        SELECT p.org_id, p.action_id FROM kin_widgets w
        JOIN kin_pending_actions p ON p.org_id = w.org_id
          AND w.widget_id = 'kin-approval:' || p.action_id
        WHERE w.type = 'approval' AND w.closed_at IS NULL
        ORDER BY 1, 2`;
      yield* Effect.forEach(
        rows,
        (row) =>
          sync({ orgId: KinOrgId.make(row.orgId), actionId: KinActionId.make(row.actionId) }),
        { discard: true },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "Kin approval cards startup pass failed",
          Cause.pretty(cause).slice(0, 500),
        ),
      ),
    );

    yield* PubSub.take(changes).pipe(Effect.flatMap(sync), Effect.forever, Effect.forkScoped);
    yield* startup.pipe(Effect.forkScoped);
  }),
);
