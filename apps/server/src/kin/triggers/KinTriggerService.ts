import {
  KinChatId,
  type KinDeferralCard,
  KinMemoryItemId,
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
  makeDeferralCards,
  type DeferralPhase,
  type DeferralPlan,
} from "./deferrals.ts";
import { type GithubLinkState, readGithubLinks } from "./deferralGithub.ts";

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

interface StoredTrigger {
  readonly runAt: number | undefined;
  readonly enabled: boolean;
  readonly nextRunAt: number | null;
}
interface Stored {
  readonly run: { readonly state: string; readonly dueAt: number | null; readonly onDue: string };
  readonly triggers: Map<DeferralPhase, StoredTrigger>;
}

// A fired `once` keeps its runAt with next_run_at cleared; re-syncing must not refire it.
const triggerCurrent = (runAt: number | undefined, row: StoredTrigger | undefined) =>
  runAt === undefined
    ? row === undefined || (!row.enabled && row.nextRunAt === null)
    : row?.enabled === true && row.runAt === runAt;

const isCurrent = (plan: DeferralPlan, stored: Stored | undefined) =>
  phases.every((phase) =>
    triggerCurrent(
      plan.phases.find((entry) => entry.phase === phase)?.runAt,
      stored?.triggers.get(phase),
    ),
  ) &&
  (plan.armed
    ? stored !== undefined &&
      stored.run.state !== "disarmed" &&
      stored.run.dueAt === plan.dueAt &&
      stored.run.onDue === plan.onDue
    : stored === undefined || stored.run.state === "disarmed");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = yield* MemoryCache.MemoryCache;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const publish = (event: Parameters<KinChatHub["Service"]["publish"]>[0]) =>
    Option.isSome(hub) ? sql.afterCommit(hub.value.publish(event)) : Effect.void;
  const cards = yield* makeDeferralCards;

  // Trigger rows are only written in the same transaction as their run row.
  const readStored = Effect.fn("KinTriggerService.readStored")(function* (
    orgId: KinOrgId,
    itemId?: KinMemoryItemId,
  ) {
    const rows = yield* sql<{
      itemId: string;
      state: string;
      dueAt: number | null;
      onDue: string;
      triggerId: string | null;
      schedule: string | null;
      enabled: number | null;
      nextRunAt: number | null;
    }>`
      SELECT r.item_id AS "itemId", r.state, r.due_at AS "dueAt", r.on_due AS "onDue",
        t.trigger_id AS "triggerId", t.schedule_json AS schedule,
        t.enabled, t.next_run_at AS "nextRunAt"
      FROM kin_deferral_runs r
      LEFT JOIN kin_triggers t ON t.org_id = r.org_id
        AND t.trigger_id IN ('deferral:' || r.item_id || ':heads_up', 'deferral:' || r.item_id || ':due')
      WHERE r.org_id = ${orgId} ${itemId === undefined ? sql`` : sql`AND r.item_id = ${itemId}`}
      ORDER BY r.item_id, t.trigger_id
    `;
    const stored = new Map<string, Stored>();
    for (const row of rows) {
      let entry = stored.get(row.itemId);
      if (entry === undefined) {
        entry = {
          run: { state: row.state, dueAt: row.dueAt, onDue: row.onDue },
          triggers: new Map(),
        };
        stored.set(row.itemId, entry);
      }
      const phase = phases.find((each) => deferralTriggerId(row.itemId, each) === row.triggerId);
      if (phase === undefined || row.schedule === null) continue;
      // An undecodable row reads as stale, so the next apply overwrites it instead of failing the org.
      const schedule = yield* decodeSchedule(row.schedule).pipe(Effect.option);
      entry.triggers.set(phase, {
        runAt:
          Option.isSome(schedule) && schedule.value.type === "once"
            ? Date.parse(schedule.value.runAt)
            : Number.NaN,
        enabled: row.enabled === 1,
        nextRunAt: row.nextRunAt,
      });
    }
    return stored;
  });

  const writeTrigger = Effect.fn("KinTriggerService.writeTrigger")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    phase: DeferralPhase,
    runAt: number | undefined,
    timeZone: string,
    now: number,
  ) {
    const id = deferralTriggerId(itemId, phase);
    if (runAt === undefined)
      return yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
        updated_at = max(updated_at, ${now}) WHERE org_id = ${orgId} AND trigger_id = ${id}`;
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
  });

  const syncCard = Effect.fn("KinTriggerService.syncCard")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    item: SyncItem | undefined,
    plan: DeferralPlan,
    timeZone: string,
    now: number,
  ) {
    if (!plan.armed || plan.dueAt === null || item === undefined) {
      const widgetId = KinWidgetId.make(deferralWidgetId(orgId, itemId));
      const existing = yield* repo.getWidget({ orgId, widgetId });
      if (Option.isNone(existing) || existing.value.closedAt !== null) return;
      const at = iso(now);
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
    // Only kin_defer items name a chat; other deferrals arm without a card.
    let chatId: KinChatId | null = null;
    if (item.chat !== undefined) {
      const [chat] = yield* sql`SELECT 1 FROM kin_chats
        WHERE org_id = ${orgId} AND chat_id = ${item.chat} ORDER BY chat_id`;
      if (chat === undefined)
        yield* Effect.logWarning("Deferral chat is not in its organization", { orgId, itemId });
      else chatId = KinChatId.make(item.chat);
    }
    yield* cards.write({ orgId, itemId, state, chatId, now });
  });

  const apply = Effect.fn("KinTriggerService.apply")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    item: SyncItem | undefined,
    plan: DeferralPlan,
    timeZone: string,
    now: number,
    github: ReadonlyArray<GithubLinkState> | null,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [org] = yield* sql`SELECT 1 FROM kin_orgs WHERE org_id = ${orgId} ORDER BY org_id`;
        if (org === undefined) return yield* Effect.fail("unknown_org" as const);
        const stored = (yield* readStored(orgId, itemId)).get(itemId);
        if (isCurrent(plan, stored)) return "unchanged" as const;
        for (const phase of phases) {
          const runAt = plan.phases.find((entry) => entry.phase === phase)?.runAt;
          if (!triggerCurrent(runAt, stored?.triggers.get(phase)))
            yield* writeTrigger(orgId, itemId, phase, runAt, timeZone, now);
        }
        if (plan.armed && item !== undefined) {
          const snapshot = yield* encodeSnapshot(deferralSnapshot(item, github));
          const inserted = yield* sql`
            INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
            VALUES (${orgId}, ${itemId}, 'armed', ${plan.dueAt}, ${plan.onDue}, ${snapshot}, ${now})
            ON CONFLICT DO NOTHING RETURNING item_id
          `;
          if (inserted.length === 0)
            yield* sql`UPDATE kin_deferral_runs SET state = 'armed', due_at = ${plan.dueAt},
              on_due = ${plan.onDue}, snapshot_json = ${snapshot}, updated_at = ${now}
              WHERE org_id = ${orgId} AND item_id = ${itemId}`;
        } else
          yield* sql`UPDATE kin_deferral_runs SET state = 'disarmed', updated_at = ${now}
            WHERE org_id = ${orgId} AND item_id = ${itemId} AND state <> 'disarmed'`;
        yield* syncCard(orgId, itemId, item, plan, timeZone, now);
        return plan.armed ? ("armed" as const) : ("disarmed" as const);
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

  return KinTriggerService.of({
    syncItem: Effect.fn("KinTriggerService.syncItem")(function* (item) {
      if (item.kind !== "deferral") return "unchanged" as const;
      const timeZone = yield* cache.ownerTimeZone(item.orgId);
      const now = yield* Clock.currentTimeMillis;
      const plan = planDeferral(item);
      const github = plan.armed ? yield* readGithubLinks(item.orgId, item.links) : null;
      return yield* apply(item.orgId, item.id, item, plan, timeZone, now, github).pipe(
        wrap(item.orgId),
      );
    }),
    syncOrg: Effect.fn("KinTriggerService.syncOrg")(function* (orgId, items) {
      const stored = yield* readStored(orgId).pipe(wrap(orgId));
      const present = new Set<string>();
      const pending: Array<readonly [KinMemoryItemId, SyncItem | undefined, DeferralPlan]> = [];
      for (const item of items) {
        if (item.orgId !== orgId || item.kind !== "deferral") continue;
        present.add(item.id);
        const plan = planDeferral(item);
        if (!isCurrent(plan, stored.get(item.id))) pending.push([item.id, item, plan]);
      }
      for (const [itemId, entry] of stored)
        if (!present.has(itemId) && entry.run.state !== "disarmed")
          pending.push([KinMemoryItemId.make(itemId), undefined, disarmedPlan]);
      if (pending.length === 0) return;
      const timeZone = yield* cache.ownerTimeZone(orgId);
      const now = yield* Clock.currentTimeMillis;
      const failures: Array<KinTriggerSyncError> = [];
      for (const [itemId, item, plan] of pending)
        yield* (
          plan.armed && item !== undefined
            ? readGithubLinks(orgId, item.links)
            : Effect.succeed(null)
        ).pipe(
          Effect.flatMap((github) => apply(orgId, itemId, item, plan, timeZone, now, github)),
          wrap(orgId),
          Effect.catch((error) => {
            failures.push(error);
            return Effect.logWarning("Could not sync deferral", { orgId, itemId, cause: error });
          }),
        );
      if (failures.length > 0) return yield* failures[0]!;
    }),
  });
});

export const layer = Layer.effect(KinTriggerService, make).pipe(Layer.provide(MemoryCache.layer));

const maxSyncAttempts = 3;

/** Arms deferrals from each new memory head; a failed sync retries on the next few loads. */
export const syncHooksLayer = Layer.effect(
  Memory.MemorySyncHooks,
  Effect.gen(function* () {
    const service = yield* KinTriggerService;
    const syncedHeads = new Map<KinOrgId, string>();
    const failedAttempts = new Map<KinOrgId, { head: string; count: number }>();
    return {
      syncItems: Effect.fn("KinTriggerService.syncItems")(function* (orgId, snapshot) {
        if (syncedHeads.get(orgId) === snapshot.head) return;
        const failed = failedAttempts.get(orgId);
        const attempt = failed?.head === snapshot.head ? failed.count + 1 : 1;
        yield* service
          .syncOrg(
            orgId,
            snapshot.items.map(({ head }) => ({
              ...head,
              duplicate: snapshot.duplicateIds.has(head.id),
            })),
          )
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                syncedHeads.set(orgId, snapshot.head);
                failedAttempts.delete(orgId);
              }),
            ),
            Effect.catch((error) => {
              // A permanent failure would otherwise rerun the sync inside the memory lock on every load.
              const giveUp = attempt >= maxSyncAttempts;
              if (giveUp) syncedHeads.set(orgId, snapshot.head);
              else failedAttempts.set(orgId, { head: snapshot.head, count: attempt });
              return Effect.logWarning(
                giveUp
                  ? "Could not sync deferral triggers; skipping this head"
                  : "Could not sync deferral triggers; retrying on next load",
                { orgId, attempt, cause: error },
              );
            }),
          );
      }),
    };
  }),
);
