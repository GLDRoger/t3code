import {
  KinChatId,
  type KinDeferralCard,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinTriggerSchedule,
  KinTriggerSubject,
  KinWidgetId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import {
  confirmText,
  DeferralSnapshot,
  deferralSnapshot,
  deferralTriggerId,
  deferralWidgetId,
  planDeferral,
  type DeferralPhase,
  type DeferralPlan,
} from "./deferrals.ts";

export class KinTriggerSyncError extends Schema.TaggedError<KinTriggerSyncError>()(
  "KinTriggerSyncError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

type SyncItem = MemoryItemHead & { readonly duplicate?: boolean };
export type SyncResult = "armed" | "disarmed" | "unchanged";

export class KinTriggerService extends Context.Service<
  KinTriggerService,
  {
    /** Upserts or disarms one deferral's triggers from its front matter. Idempotent. */
    readonly syncItem: (item: SyncItem) => Effect.Effect<SyncResult, KinTriggerSyncError>;
    /** Syncs a whole snapshot; armed deferrals missing from it are disarmed. */
    readonly syncOrg: (
      orgId: KinOrgId,
      items: ReadonlyArray<SyncItem>,
    ) => Effect.Effect<void, KinTriggerSyncError>;
  }
>()("t3/kin/triggers/KinTriggerService") {}

const phases: ReadonlyArray<DeferralPhase> = ["heads_up", "due"];
const disarmedPlan: DeferralPlan = { armed: false, dueAt: null, onDue: "remind", phases: [] };
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSchedule));
const decodeSchedule = Schema.decodeUnknownEffect(Schema.fromJsonString(KinTriggerSchedule));
const encodeSubject = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSubject));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DeferralSnapshot));
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = yield* MemoryCache.MemoryCache;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const publish = (event: Parameters<KinChatHub["Service"]["publish"]>[0]) =>
    Option.isSome(hub) ? sql.afterCommit(hub.value.publish(event)) : Effect.void;

  const syncTrigger = Effect.fn("KinTriggerService.syncTrigger")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    phase: DeferralPhase,
    runAt: number | undefined,
    timeZone: string,
    now: number,
  ) {
    const id = deferralTriggerId(itemId, phase);
    const [row] = yield* sql<{ schedule: string; enabled: number; nextRunAt: number | null }>`
      SELECT schedule_json AS schedule, enabled, next_run_at AS "nextRunAt" FROM kin_triggers
      WHERE org_id = ${orgId} AND trigger_id = ${id} ORDER BY trigger_id
    `;
    if (runAt === undefined) {
      if (row === undefined || (row.enabled === 0 && row.nextRunAt === null)) return false;
      yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
        updated_at = max(updated_at, ${now}) WHERE org_id = ${orgId} AND trigger_id = ${id}`;
      return true;
    }
    if (row !== undefined && row.enabled === 1) {
      const stored = yield* decodeSchedule(row.schedule);
      // A fired `once` keeps its runAt with next_run_at cleared; re-syncing must not refire it.
      if (stored.type === "once" && Date.parse(stored.runAt) === runAt) return false;
    }
    const schedule = yield* encodeSchedule({ type: "once", runAt: iso(runAt) });
    const subject = yield* encodeSubject({ type: "deferral", itemId, phase });
    const inserted = yield* sql`
      INSERT INTO kin_triggers (trigger_id, org_id, subject_json, schedule_json, time_zone, enabled,
        next_run_at, last_fire_id, created_at, updated_at)
      VALUES (${id}, ${orgId}, ${subject}, ${schedule}, ${timeZone}, 1, ${runAt}, NULL, ${now}, ${now})
      ON CONFLICT DO NOTHING RETURNING trigger_id
    `;
    if (inserted.length === 0)
      yield* sql`UPDATE kin_triggers SET subject_json = ${subject}, schedule_json = ${schedule},
        time_zone = ${timeZone}, enabled = 1, next_run_at = ${runAt},
        updated_at = max(updated_at, ${now})
        WHERE org_id = ${orgId} AND trigger_id = ${id}`;
    return true;
  });

  const syncCard = Effect.fn("KinTriggerService.syncCard")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    item: SyncItem | undefined,
    plan: DeferralPlan,
    timeZone: string,
    now: number,
  ) {
    const widgetId = KinWidgetId.make(deferralWidgetId(orgId, itemId));
    const existing = yield* repo.getWidget({ orgId, widgetId });
    const at = iso(now);
    if (!plan.armed || plan.dueAt === null || item === undefined) {
      if (Option.isNone(existing) || existing.value.closedAt !== null) return;
      const widget = yield* repo.updateWidget({
        ...existing.value,
        expectedRevision: existing.value.revision,
        closedAt: at,
        updatedAt: at,
      });
      return yield* publish({ type: "widget.updated", orgId, widget });
    }
    const state: KinDeferralCard = {
      itemId,
      title: item.title,
      dueAt: iso(plan.dueAt),
      onDue: plan.onDue,
      text: confirmText(plan.dueAt, plan.onDue, timeZone),
    };
    if (Option.isSome(existing)) {
      const widget = yield* repo.updateWidget({
        ...existing.value,
        expectedRevision: existing.value.revision,
        state,
        closedAt: null,
        updatedAt: at,
      });
      return yield* publish({ type: "widget.updated", orgId, widget });
    }
    // Only kin_defer items name a chat; other deferrals arm without a card.
    if (item.chat === undefined) return;
    const chatId = KinChatId.make(item.chat);
    const [chat] = yield* sql`SELECT 1 FROM kin_chats
      WHERE org_id = ${orgId} AND chat_id = ${chatId} ORDER BY chat_id`;
    if (chat === undefined)
      return yield* Effect.logWarning("Deferral chat is not in its organization", {
        orgId,
        itemId,
      });
    const message = yield* repo.insertMessage({
      orgId,
      chatId,
      messageId: KinMessageId.make(widgetId),
      author: { _tag: "system" },
      kind: "system",
      body: state.text,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: at,
      editedAt: null,
    });
    const widget = {
      orgId,
      chatId,
      messageId: message.messageId,
      widgetId,
      widgetClass: "native" as const,
      type: "deferral",
      state,
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: at,
    };
    yield* repo.insertWidget(widget);
    yield* publish({ type: "message.posted", orgId, message });
    yield* publish({ type: "widget.updated", orgId, widget: { ...widget, revision: 1 } });
  });

  const apply = Effect.fn("KinTriggerService.apply")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    item: SyncItem | undefined,
  ) {
    const plan = item === undefined ? disarmedPlan : planDeferral(item);
    const timeZone = yield* cache.ownerTimeZone(orgId);
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [org] = yield* sql`SELECT 1 FROM kin_orgs WHERE org_id = ${orgId} ORDER BY org_id`;
        if (org === undefined) return yield* Effect.fail("unknown_org" as const);
        let changed = false;
        for (const phase of phases) {
          const runAt = plan.phases.find((entry) => entry.phase === phase)?.runAt;
          if (yield* syncTrigger(orgId, itemId, phase, runAt, timeZone, now)) changed = true;
        }
        const [run] = yield* sql<{ state: string; dueAt: number | null; onDue: string }>`
          SELECT state, due_at AS "dueAt", on_due AS "onDue" FROM kin_deferral_runs
          WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id
        `;
        let result: SyncResult = "unchanged";
        if (plan.armed && item !== undefined) {
          const snapshot = yield* encodeSnapshot(deferralSnapshot(item));
          const inserted = yield* sql`
            INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
            VALUES (${orgId}, ${itemId}, 'armed', ${plan.dueAt}, ${plan.onDue}, ${snapshot}, ${now})
            ON CONFLICT DO NOTHING RETURNING item_id
          `;
          if (inserted.length === 1) result = "armed";
          else if (
            changed ||
            run?.state === "disarmed" ||
            run?.dueAt !== plan.dueAt ||
            run?.onDue !== plan.onDue
          ) {
            yield* sql`UPDATE kin_deferral_runs SET state = 'armed', due_at = ${plan.dueAt},
              on_due = ${plan.onDue}, snapshot_json = ${snapshot}, updated_at = ${now}
              WHERE org_id = ${orgId} AND item_id = ${itemId}`;
            result = "armed";
          }
        } else if (changed || (run !== undefined && run.state !== "disarmed")) {
          yield* sql`UPDATE kin_deferral_runs SET state = 'disarmed', updated_at = ${now}
            WHERE org_id = ${orgId} AND item_id = ${itemId} AND state <> 'disarmed'`;
          result = "disarmed";
        }
        if (result !== "unchanged") yield* syncCard(orgId, itemId, item, plan, timeZone, now);
        return result;
      }),
    );
  });

  const wrap = (orgId: KinOrgId) =>
    Effect.mapError(
      (cause: unknown) =>
        new KinTriggerSyncError({
          orgId,
          cause: isSqlError(cause) ? toPersistenceSqlError("KinTriggerService.sync")(cause) : cause,
        }),
    );

  const syncItem = Effect.fn("KinTriggerService.syncItem")(function* (item: SyncItem) {
    if (item.kind !== "deferral") return "unchanged" as const;
    return yield* apply(item.orgId, item.id, item).pipe(wrap(item.orgId));
  });

  return KinTriggerService.of({
    syncItem,
    syncOrg: Effect.fn("KinTriggerService.syncOrg")(function* (orgId, items) {
      const present = new Set<string>();
      for (const item of items) {
        if (item.orgId !== orgId || item.kind !== "deferral") continue;
        present.add(item.id);
        yield* syncItem(item);
      }
      const runs = yield* sql<{ itemId: KinMemoryItemId }>`
        SELECT item_id AS "itemId" FROM kin_deferral_runs
        WHERE org_id = ${orgId} AND state <> 'disarmed' ORDER BY item_id
      `.pipe(wrap(orgId));
      for (const run of runs)
        if (!present.has(run.itemId)) yield* apply(orgId, run.itemId, undefined).pipe(wrap(orgId));
    }),
  });
});

export const layer = Layer.effect(KinTriggerService, make).pipe(Layer.provide(MemoryCache.layer));

/** Feeds each front-matter cache snapshot into deferral arming. */
export const syncHooksLayer = Layer.effect(
  Memory.MemorySyncHooks,
  Effect.gen(function* () {
    const service = yield* KinTriggerService;
    return Memory.MemorySyncHooks.of({
      syncItems: Effect.fn("KinTriggerService.syncItems")(function* (orgId, items) {
        yield* service
          .syncOrg(orgId, items)
          .pipe(Effect.mapError((cause) => new Memory.MemorySyncHookError({ orgId, cause })));
      }),
    });
  }),
);
