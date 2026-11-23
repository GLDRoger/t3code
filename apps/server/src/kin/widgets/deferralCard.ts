import {
  KIN_DEFERRAL_CARD_ACTIONS,
  KinChatError,
  KinDeferralCard,
  type KinDeferralCardAction,
  KinMemoryItemId,
  type KinMemberId,
  KinTriggerSchedule,
  type MemoryItemHead,
  kinAgentPausedRefusal,
  type KinPersonId,
  type KinWidget,
  kinDeferralWidgetId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Repository from "../chat/KinChatRepository.ts";
import { textLocale } from "../work/companyProfile.ts";
import { ownerZone } from "../work/recordRows.ts";
import {
  DeferralSnapshot,
  HEADS_UP_MS,
  agentPaused,
  confirmText,
  deferralFingerprint,
  deferralLead,
  deferralOpen,
  deferralTriggerId,
  makeDeferralCards,
  makeDeferralRedraw,
  makeDeferralStarter,
  nextMondayDue,
} from "../triggers/deferrals.ts";

/** A deferral's committed item as a tap found it, or none when it is gone. */
export type DeferralCommitted = Option.Option<{
  readonly head: MemoryItemHead;
  readonly body: string;
}>;
import { pauseTriggers } from "../triggers/KinTriggerStore.ts";

const decodeCard = Schema.decodeUnknownEffect(KinDeferralCard);
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSchedule));
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
  /** The committed item, read before this transaction; `undefined` where no reader is attached. */
  committed: DeferralCommitted | undefined,
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
  if (committed === undefined)
    return yield* new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
  // The tap answers the card as drawn, on work that is still that work; otherwise the card is
  // drawn again from the item as it is now, and that redraw commits with the refusal.
  const item = Option.getOrUndefined(committed);
  if (
    item === undefined ||
    !deferralOpen(item.head) ||
    snapshot.drawn?.fingerprint !== deferralFingerprint(item)
  ) {
    const redraw = yield* makeDeferralRedraw;
    yield* redraw({
      orgId,
      itemId,
      run: { state: run.state, dueAt, onDue: card.onDue, snapshot },
      item,
      why: ["it changed since you were asked"],
      clock: { zone: yield* ownerZone(orgId), locale: yield* textLocale(orgId) },
      now,
    });
    return changed;
  }
  switch (action) {
    case "start_now": {
      // Starting work for the company is the owner's or a co-owner's, as a due start is.
      if (!who.owner)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "Only the owner or a co-owner can start this.",
        });
      const lead = yield* deferralLead(sql, orgId, item.head);
      if (lead !== undefined && (yield* agentPaused(sql, orgId, lead.agentId)))
        return yield* invalid(kinAgentPausedRefusal(lead.name));
      const start = yield* makeDeferralStarter;
      // The section check and the work handed off are the item's as committed now.
      const started = yield* start({
        orgId,
        itemId,
        dueAt,
        card: { ...card, title: item.head.title },
        provenance: { _tag: "human", personId: who.personId, memberId: who.memberId },
        at: now,
        now,
        from: run.state,
        item: {
          ...(item.head.chat === undefined ? {} : { chat: item.head.chat }),
          ...(item.head.source_event === undefined ? {} : { source_event: item.head.source_event }),
          links: item.head.links,
        },
        ...(snapshot.restarts === undefined ? {} : { restarts: snapshot.restarts }),
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
      const fires: ReadonlyArray<readonly [string, number]> = [
        [deferralTriggerId(itemId, "due"), monday],
        ...(card.onDue === "start"
          ? [[deferralTriggerId(itemId, "heads_up"), monday - HEADS_UP_MS] as const]
          : []),
      ];
      // Both columns carry the new instant, so a later replan from memory rewrites them whole.
      for (const [triggerId, at] of fires) {
        const schedule = yield* encodeSchedule({ type: "once", runAt: iso(at) });
        yield* sql`UPDATE kin_triggers SET enabled = 1, schedule_json = ${schedule},
            next_run_at = ${at}, updated_at = max(updated_at, ${now})
          WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
      }
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
