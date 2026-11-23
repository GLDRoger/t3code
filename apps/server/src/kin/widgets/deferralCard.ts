import {
  KIN_DEFERRAL_CARD_ACTIONS,
  KinChatError,
  KinDeferralCard,
  type KinDeferralCardAction,
  KinMemoryItemId,
  type KinMemberId,
  type KinPersonId,
  type KinWidget,
  kinDeferralWidgetId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Repository from "../chat/KinChatRepository.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import {
  DeferralSnapshot,
  HEADS_UP_MS,
  confirmText,
  deferralTriggerId,
  makeDeferralCards,
  makeDeferralStarter,
  nextMondayDue,
} from "../triggers/deferrals.ts";
import { pauseTriggers } from "../triggers/KinTriggerStore.ts";

const decodeCard = Schema.decodeUnknownEffect(KinDeferralCard);
// Suspended: `deferrals.ts` reaches this module through the chat service, mid-load.
const SnapshotJson = Schema.fromJsonString(Schema.suspend(() => DeferralSnapshot));
const decodeSnapshot = Schema.decodeUnknownEffect(SnapshotJson);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const changed = new KinChatError({
  reason: "widget_changed",
  message: "This card changed or was answered. Look at it again.",
});
const PENDING = ["heads_up", "asked", "grace"];

const isDeferralAction = (actionId: string): actionId is KinDeferralCardAction =>
  KIN_DEFERRAL_CARD_ACTIONS.some((action) => action === actionId);

/** The taps the host takes on a card; one written before cards carried them offers Undo only. */
const deferralCardActions = (card: KinDeferralCard): ReadonlyArray<string> =>
  card.actions ?? (card.phase === undefined ? ["undo"] : []);

const LABELS: Record<KinDeferralCardAction, string> = {
  undo: "Undo",
  change: "Change",
  remind: "Just remind me",
  start_now: "Start now",
  monday: "Monday",
  cancel: "Cancel",
};

/**
 * What a tap on a deferral card says, before anything changes. A tap the card no longer
 * offers was drawn from an older card, so it reads as changed.
 */
export const describeDeferralTap = Effect.fn("KinDeferralCard.describe")(function* (
  widget: KinWidget,
  actionId: string,
  value: unknown,
) {
  const card = yield* decodeCard(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (
    !isDeferralAction(actionId) ||
    card.itemId !== value ||
    widget.widgetId !== kinDeferralWidgetId(widget.orgId, card.itemId)
  )
    return yield* invalid("Unknown card action.");
  if (!deferralCardActions(card).includes(actionId)) return yield* changed;
  return { card, action: actionId, text: `Tapped "${LABELS[actionId]}" on "${card.title}"` };
});

/**
 * Applies a described tap other than Undo in the tap's transaction, from the run the card
 * shows: [Start now] starts it as the due fire would, [Monday] re-arms it for next Monday 9:00,
 * [Cancel] stops it and closes the card. No model runs any of them.
 */
export const applyDeferralTap = Effect.fn("KinDeferralCard.apply")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describeDeferralTap>>,
  who: { readonly personId: KinPersonId; readonly memberId: KinMemberId; readonly owner: boolean },
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const { card, action } = tap;
  const orgId = widget.orgId;
  const itemId = KinMemoryItemId.make(card.itemId);
  const dueAt = Date.parse(card.dueAt);
  const [run] = yield* sql<{ state: string; dueAt: number | null; snapshot: string }>`SELECT
      state, due_at AS "dueAt", snapshot_json AS snapshot FROM kin_deferral_runs
    WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`;
  if (run === undefined || run.dueAt !== dueAt || !PENDING.includes(run.state))
    return yield* changed;
  const snapshot = yield* decodeSnapshot(run.snapshot).pipe(Effect.mapError(() => changed));
  switch (action) {
    case "start_now": {
      // Starting work for the company is the owner's or a co-owner's, as a due start is.
      if (!who.owner)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner or a co-owner can start this.",
        });
      if (snapshot.source === undefined) return yield* changed;
      const start = yield* makeDeferralStarter;
      const started = yield* start({
        orgId,
        itemId,
        dueAt,
        card,
        provenance: { _tag: "human", personId: who.personId, memberId: who.memberId },
        at: now,
        now,
        from: run.state,
        item: {
          ...(snapshot.source.chat === undefined ? {} : { chat: snapshot.source.chat }),
          ...(snapshot.source.sourceEvent === undefined
            ? {}
            : { source_event: snapshot.source.sourceEvent }),
          links: snapshot.links,
        },
      }).pipe(
        Effect.catchTags({
          KinEventQueueConflict: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueUnknownEvent: () => Effect.succeed(false),
        }),
      );
      if (!started) return yield* invalid("Kin couldn't start it now. Ask your agent in the chat.");
      return;
    }
    case "monday": {
      const monday = Date.parse(nextMondayDue(now, yield* ownerZone(orgId)));
      const { graceEndsAt: _grace, ...rest } = snapshot;
      const moved = yield* encodeSnapshot({ ...rest, movedFrom: snapshot.movedFrom ?? dueAt });
      yield* sql`UPDATE kin_deferral_runs SET state = 'armed', due_at = ${monday},
          snapshot_json = ${moved}, updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${itemId} AND state = ${run.state}`;
      // The schedules keep memory's due time, so a sync finds them current; only the fires move.
      const fires: ReadonlyArray<readonly [string, number]> = [
        [deferralTriggerId(itemId, "due"), monday],
        ...(card.onDue === "start"
          ? [[deferralTriggerId(itemId, "heads_up"), monday - HEADS_UP_MS] as const]
          : []),
      ];
      for (const [triggerId, at] of fires)
        yield* sql`UPDATE kin_triggers SET enabled = 1, next_run_at = ${at},
            updated_at = max(updated_at, ${now})
          WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
      const { phase: _phase, graceEndsAt: _ends, ...confirm } = card;
      const cards = yield* makeDeferralCards;
      yield* cards.write({
        orgId,
        itemId,
        state: {
          ...confirm,
          dueAt: iso(monday),
          text: confirmText(monday, card.onDue, {
            zone: yield* ownerZone(orgId),
            locale: yield* textLocale(orgId),
          }),
          actions: ["undo"],
        },
        chatId: null,
        now,
      });
      return;
    }
    case "cancel": {
      yield* sql`UPDATE kin_deferral_runs SET state = 'undone', updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${itemId} AND state = ${run.state}`;
      yield* pauseTriggers(
        orgId,
        [deferralTriggerId(itemId, "heads_up"), deferralTriggerId(itemId, "due")],
        now,
      );
      const cards = yield* makeDeferralCards;
      const at = iso(now);
      const closed = yield* repo.updateWidget({
        ...widget,
        // Closing writes no words.
        audience: "chat",
        state: { ...card, actions: [] },
        expectedRevision: widget.revision,
        closedAt: at,
        updatedAt: at,
      });
      yield* cards.publish({ type: "widget.updated", orgId, widget: closed });
      return;
    }
    case "undo":
    case "change":
    case "remind":
      return yield* changed;
  }
});
