import {
  KIN_REMINDER_CARD_ACTIONS,
  KinChatError,
  KinReminderCard,
  KinTrigger,
  type KinReminderCardAction,
  type KinOrgId,
  type KinWidget,
  kinReminderWidgetId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { DeferralSnapshot, deferralTriggerId } from "../triggers/deferrals.ts";

const decodeCard = Schema.decodeUnknownEffect(KinReminderCard);
const decodeZone = Schema.decodeUnknownOption(KinTrigger.fields.timeZone);
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DeferralSnapshot));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DeferralSnapshot));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

const isReminderAction = (actionId: string): actionId is KinReminderCardAction =>
  KIN_REMINDER_CARD_ACTIONS.some((action) => action === actionId);

/** The owner's zone, for "tomorrow 9:00"; UTC before trigger settings exist. */
const ownerZone = Effect.fn("KinReminderCard.ownerZone")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ timeZone: string }>`SELECT time_zone AS "timeZone"
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`;
  return Option.getOrElse(decodeZone(row?.timeZone), () => "UTC");
});

/** Owner-local 9:00 on the day after `now`. */
function tomorrowAtNine(now: number, timeZone: string): number {
  const tomorrow = DateTime.add(DateTime.makeZonedUnsafe(now, { timeZone }), { days: 1 });
  return DateTime.toEpochMillis(
    DateTime.setParts(tomorrow, { hour: 9, minute: 0, second: 0, millisecond: 0 }),
  );
}

const snoozeEnd = (
  action: Exclude<KinReminderCardAction, "done" | "change">,
  now: number,
  timeZone: string,
) =>
  action === "snooze_10m"
    ? now + 10 * 60_000
    : action === "snooze_1h"
      ? now + 60 * 60_000
      : tomorrowAtNine(now, timeZone);

/**
 * What a tap on a reminder card says, before anything changes: the lead reads `text`. Only
 * Change wakes the lead, since it needs a new time; the server finishes Done and Snooze alone.
 */
export const describeReminderTap = Effect.fn("KinReminderCard.describe")(function* (
  widget: KinWidget,
  actionId: string,
  value: unknown,
) {
  const card = yield* decodeCard(widget.state).pipe(
    Effect.mapError(() => invalid("Invalid widget state.")),
  );
  if (
    !isReminderAction(actionId) ||
    card.itemId !== value ||
    widget.widgetId !== kinReminderWidgetId(widget.orgId, card.itemId, Date.parse(card.dueAt))
  )
    return yield* invalid("Unknown card action.");
  return {
    card,
    action: actionId,
    text: `Tapped "${LABELS[actionId]}" on the reminder "${card.title}"`,
    wake: actionId === "change",
  };
});

/**
 * Applies a described tap in the tap's transaction. Done and Snooze change the deferral run
 * here and finish there. Returns the card's next state, or null.
 */
export const applyReminderTap = Effect.fn("KinReminderCard.apply")(function* (
  widget: KinWidget,
  tap: Effect.Success<ReturnType<typeof describeReminderTap>>,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const { card, action } = tap;
  if (action === "change") return null;
  if (card.status === "done") return yield* invalid("This reminder is already done.");
  const orgId = widget.orgId;
  const [run] = yield* sql<{ state: string; snapshot: string }>`SELECT state,
      snapshot_json AS snapshot FROM kin_deferral_runs
    WHERE org_id = ${orgId} AND item_id = ${card.itemId} AND on_due = 'remind' ORDER BY item_id`;
  const current = run !== undefined && (run.state === "reminded" || run.state === "snoozed");
  const triggerId = deferralTriggerId(card.itemId, "due");
  if (action === "done") {
    // A run that moved on (re-armed for a new due time) is not this card's to finish.
    if (current && run !== undefined) {
      yield* sql`UPDATE kin_deferral_runs SET state = 'done', updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${card.itemId} AND state = ${run.state}`;
      yield* sql`UPDATE kin_triggers SET next_run_at = NULL, updated_at = max(updated_at, ${now})
        WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
    }
    const { snoozedUntil: _until, ...rest } = card;
    return { ...rest, status: "done" } satisfies KinReminderCard;
  }
  if (!current || run === undefined)
    return yield* invalid("This reminder changed. Check it again.");
  const until = snoozeEnd(action, now, yield* ownerZone(orgId));
  const snapshot = yield* decodeSnapshot(run.snapshot).pipe(
    Effect.mapError(() => invalid("This reminder changed. Check it again.")),
  );
  const snoozed = yield* encodeSnapshot({ ...snapshot, snoozedUntil: until });
  yield* sql`UPDATE kin_deferral_runs SET state = 'snoozed', snapshot_json = ${snoozed},
      updated_at = ${now}
    WHERE org_id = ${orgId} AND item_id = ${card.itemId} AND state = ${run.state}`;
  yield* sql`UPDATE kin_triggers SET enabled = 1, next_run_at = ${until},
      updated_at = max(updated_at, ${now})
    WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
  return { ...card, status: "snoozed", snoozedUntil: iso(until) } satisfies KinReminderCard;
});

const LABELS: Record<KinReminderCardAction, string> = {
  done: "Done",
  snooze_10m: "Snooze 10 min",
  snooze_1h: "Snooze 1 h",
  snooze_tomorrow: "Snooze to tomorrow 9:00",
  change: "Change",
};
