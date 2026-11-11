import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinScheduledTaskCard,
  KinTriggerSchedule,
  KinTriggerSubject,
  type KinTriggerFired,
  KinWidgetId,
  type MemoryItemEvery,
  type MemoryItemHead,
  kinScheduledTaskWidgetId,
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
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinBudget from "../lead/KinBudget.ts";
import * as LeadDelivery from "../lead/LeadDelivery.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import {
  nextRun,
  readScheduledTask,
  scheduleOf,
  scheduledTaskTriggerId,
} from "../widgets/scheduledTaskCard.ts";
import { cardChatFor, firingOrigin } from "./deferralOrigin.ts";
import { hex } from "./deferrals.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinSchedules from "./kinSchedules.ts";

/** A run more than this late (the host was off) is skipped; the next slot runs as usual. */
const SCHEDULED_RUN_LATE_MS = 2 * 60 * 60_000;

export const scheduledTaskWidgetId = (orgId: KinOrgId, itemId: string) =>
  KinWidgetId.make(kinScheduledTaskWidgetId(orgId, itemId));

type SyncItem = MemoryItemHead & { readonly duplicate?: boolean };

/** A deferral with `every` is a scheduled task; it runs while open, valid and unique. */
export const isScheduledTask = (item: MemoryItemHead) =>
  item.kind === "deferral" && item.every !== undefined;
const armed = (item: SyncItem) =>
  isScheduledTask(item) &&
  item.status === "open" &&
  item.invalid_at === null &&
  item.superseded_by === null &&
  item.duplicate !== true;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const encodeSchedule = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSchedule));
const encodeSubject = Schema.encodeEffect(Schema.fromJsonString(KinTriggerSubject));
const decodeCard = Schema.decodeUnknownEffect(KinScheduledTaskCard);
const encodeCard = Schema.encodeEffect(KinScheduledTaskCard);
const cardJson = Schema.encodeEffect(Schema.fromJsonString(KinScheduledTaskCard));
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

const triggerNext = (sql: SqlClient.SqlClient, orgId: KinOrgId, itemId: string) =>
  sql<{ nextRunAt: number | null }>`SELECT next_run_at AS "nextRunAt" FROM kin_triggers
    WHERE org_id = ${orgId} AND trigger_id = ${scheduledTaskTriggerId(itemId)} ORDER BY trigger_id`.pipe(
    Effect.map((rows) => rows[0]?.nextRunAt ?? null),
  );

/** Writes the standing card: in place when it exists, else posted to `chatId`. */
const writeCard = Effect.fn("KinScheduledTasks.writeCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly itemId: string;
  readonly chatId: KinChatId | null;
  readonly state: KinScheduledTaskCard;
  readonly closed: boolean;
  readonly now: number;
}) {
  const repo = yield* Repository.KinChatRepository;
  const cards = yield* LeadDelivery.makeCardWriter;
  const widgetId = scheduledTaskWidgetId(input.orgId, input.itemId);
  const existing = yield* repo.getWidget({ orgId: input.orgId, widgetId });
  const state = yield* encodeCard(input.state);
  if (Option.isSome(existing)) {
    const before = yield* decodeCard(existing.value.state).pipe(Effect.option);
    const same =
      Option.isSome(before) &&
      (yield* cardJson(before.value)) === (yield* cardJson(input.state)) &&
      (existing.value.closedAt !== null) === input.closed;
    if (same) return existing.value;
    return yield* cards.update(existing.value, state, input.now, input.closed);
  }
  if (input.chatId === null || input.closed) return undefined;
  return yield* cards.post(
    input.orgId,
    input.chatId,
    KinMessageId.make(widgetId),
    `Scheduled: ${input.state.title}.`,
    { widgetId, type: "scheduled_task", state },
    input.now,
  );
});

const cardState = (
  item: { readonly id: string; readonly title: string; readonly every: MemoryItemEvery },
  timeZone: string,
  status: KinScheduledTaskCard["status"],
  nextRunAt: number | null,
  lastRun: KinScheduledTaskCard["lastRun"],
): KinScheduledTaskCard => ({
  itemId: KinMemoryItemId.make(item.id),
  title: item.title,
  every: item.every,
  timeZone,
  status,
  nextRunAt: nextRunAt === null ? null : iso(nextRunAt),
  lastRun,
});

/**
 * Arms, re-arms or disarms one org's scheduled tasks from a memory snapshot. Pause and Delete are
 * server state: a pause holds until Resume, and a delete until the item changes or is cancelled.
 */
export const syncScheduledTasks = Effect.fn("KinScheduledTasks.sync")(function* (input: {
  readonly orgId: KinOrgId;
  readonly items: ReadonlyArray<SyncItem>;
  /** True when `items` is the whole snapshot, so a missing task is disarmed. */
  readonly complete: boolean;
  readonly timeZone: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const { orgId, timeZone, now } = input;
  const tasks = input.items.filter((item) => item.orgId === orgId && isScheduledTask(item));
  const present = new Set<string>(tasks.map((item) => item.id));
  const stored = yield* sql<{ itemId: string }>`SELECT item_id AS "itemId"
    FROM kin_scheduled_tasks WHERE org_id = ${orgId} AND state <> 'disarmed' ORDER BY item_id`;
  const gone = input.complete ? stored.filter((row) => !present.has(row.itemId)) : [];
  const disarm = Effect.fn("KinScheduledTasks.disarm")(function* (itemId: string) {
    yield* sql`UPDATE kin_scheduled_tasks SET state = 'disarmed', run_now_at = NULL,
          updated_at = ${now}
        WHERE org_id = ${orgId} AND item_id = ${itemId} AND state <> 'disarmed'`;
    yield* sql`UPDATE kin_triggers SET enabled = 0, next_run_at = NULL,
          updated_at = max(updated_at, ${now})
        WHERE org_id = ${orgId} AND trigger_id = ${scheduledTaskTriggerId(itemId)}`;
    const widget = yield* repo.getWidget({ orgId, widgetId: scheduledTaskWidgetId(orgId, itemId) });
    if (Option.isSome(widget) && widget.value.closedAt === null) {
      const card = yield* decodeCard(widget.value.state);
      yield* writeCard({
        orgId,
        itemId,
        chatId: null,
        state: { ...card, status: "deleted", nextRunAt: null },
        closed: true,
        now,
      });
    }
  });
  for (const { itemId } of gone) yield* sql.withTransaction(disarm(itemId));
  for (const item of tasks) {
    const every = item.every;
    if (every === undefined) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* readScheduledTask(sql, orgId, item.id);
        if (!armed(item)) {
          if (row !== undefined && row.state !== "disarmed") yield* disarm(item.id);
          return;
        }
        // Delete holds until the lead cancels the item, or the owner changes it.
        if (row?.state === "deleted" && row.recordedAt === item.recorded_at) return;
        let chatId: KinChatId | null = null;
        // Once its chat was shared, a scheduled task speaks in its lead's owner chat instead.
        if (item.chat !== undefined) {
          const lead = yield* liveLead(sql, orgId, {
            chatId: item.chat,
            prefer: CHIEF_OF_STAFF_DOMAIN,
          });
          chatId = yield* cardChatFor(sql, orgId, item.chat, lead?.ownerChatId ?? null);
        }
        if (chatId === null)
          chatId =
            (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.ownerChatId ?? null;
        const paused = row?.state === "active" && row.paused === 1;
        yield* sql`INSERT INTO kin_scheduled_tasks (org_id, item_id, chat_id, state, paused,
            recorded_at, run_now_at, updated_at)
          VALUES (${orgId}, ${item.id}, ${chatId}, 'active', 0, ${item.recorded_at}, NULL, ${now})
          ON CONFLICT (org_id, item_id) DO UPDATE SET chat_id = excluded.chat_id,
            state = 'active', paused = ${paused ? 1 : 0}, recorded_at = excluded.recorded_at,
            updated_at = excluded.updated_at
          WHERE kin_scheduled_tasks.state <> 'active' OR kin_scheduled_tasks.recorded_at <> excluded.recorded_at
            OR kin_scheduled_tasks.chat_id IS NOT excluded.chat_id`;
        const triggerId = scheduledTaskTriggerId(item.id);
        const schedule = yield* encodeSchedule(scheduleOf(every));
        const [trigger] = yield* sql<{
          schedule: string;
          enabled: number;
          nextRunAt: number | null;
          timeZone: string;
        }>`
          SELECT schedule_json AS schedule, enabled, next_run_at AS "nextRunAt", time_zone AS "timeZone"
          FROM kin_triggers WHERE org_id = ${orgId} AND trigger_id = ${triggerId} ORDER BY trigger_id`;
        const next = paused
          ? null
          : trigger !== undefined &&
              trigger.schedule === schedule &&
              trigger.timeZone === timeZone &&
              trigger.enabled === 1 &&
              trigger.nextRunAt !== null
            ? trigger.nextRunAt
            : nextRun(every, now, timeZone);
        if (trigger === undefined) {
          const subject = yield* encodeSubject({ type: "scheduled_task", itemId: item.id });
          yield* sql`INSERT INTO kin_triggers (trigger_id, org_id, subject_json, schedule_json,
              time_zone, enabled, next_run_at, last_fire_id, created_at, updated_at)
            VALUES (${triggerId}, ${orgId}, ${subject}, ${schedule}, ${timeZone}, ${paused ? 0 : 1},
              ${next}, NULL, ${now}, ${now})`;
        } else if (
          trigger.schedule !== schedule ||
          trigger.timeZone !== timeZone ||
          trigger.enabled !== (paused ? 0 : 1) ||
          trigger.nextRunAt !== next
        )
          yield* sql`UPDATE kin_triggers SET schedule_json = ${schedule}, time_zone = ${timeZone},
              enabled = ${paused ? 0 : 1}, next_run_at = ${next}, updated_at = max(updated_at, ${now})
            WHERE org_id = ${orgId} AND trigger_id = ${triggerId}`;
        const existing = yield* repo.getWidget({
          orgId,
          widgetId: scheduledTaskWidgetId(orgId, item.id),
        });
        const lastRun = Option.isSome(existing)
          ? Option.match(yield* decodeCard(existing.value.state).pipe(Effect.option), {
              onNone: () => null,
              onSome: (card) => card.lastRun,
            })
          : null;
        yield* writeCard({
          orgId,
          itemId: item.id,
          chatId,
          state: cardState(
            { id: item.id, title: item.title, every },
            timeZone,
            paused ? "paused" : "active",
            next,
            lastRun,
          ),
          closed: false,
          now,
        });
      }),
    );
  }
});

export class KinScheduledTasksError extends Schema.TaggedError<KinScheduledTasksError>()(
  "KinScheduledTasksError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

export class KinScheduledTasks extends Context.Service<
  KinScheduledTasks,
  {
    /** Starts this org's due runs and Run now taps: each wakes the lead with the task. */
    readonly drain: (orgId: KinOrgId) => Effect.Effect<void, KinScheduledTasksError>;
  }
>()("t3/kin/triggers/scheduledTasks/KinScheduledTasks") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const memory = yield* Memory.Memory;
  const cache = yield* MemoryCache.MemoryCache;
  const repo = yield* Repository.KinChatRepository;
  const budget = yield* KinBudget.KinBudget;
  const deliveries = yield* LeadDelivery.KinLeadDelivery;
  const ticks = yield* Scheduler.Scheduler;
  const cards = yield* LeadDelivery.makeCardWriter;
  const schedules = yield* KinSchedules.KinSchedules;

  const notice = (orgId: KinOrgId, chatId: KinChatId, runId: string, body: string, now: number) =>
    repo
      .insertMessage({
        orgId,
        chatId,
        audience: "owner",
        messageId: KinMessageId.make(`kin-run-skipped:${hex(runId)}`),
        author: { _tag: "system" },
        kind: "system",
        body,
        intent: null,
        mentions: [],
        replyTo: null,
        widgetId: null,
        floorRunId: null,
        status: "posted",
        sentBy: null,
        clientMessageId: null,
        createdAt: iso(now),
        editedAt: null,
      })
      .pipe(Effect.asVoid);

  /** The lead a schedule's row names, if it is still a live lead. */
  const scheduleLead = Effect.fn("KinScheduledTasks.scheduleLead")(function* (
    orgId: KinOrgId,
    agentId: string,
  ) {
    const [row] = yield* sql<{ agentId: string; name: string; ownerChatId: string }>`
      SELECT l.agent_id AS "agentId", l.name, l.owner_chat_id AS "ownerChatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId} AND l.agent_id = ${agentId}`;
    return row === undefined
      ? undefined
      : {
          agentId: KinAgentId.make(row.agentId),
          name: row.name,
          ownerChatId: KinChatId.make(row.ownerChatId),
        };
  });

  /**
   * One run of a native schedule. Its row says which lead, chat and audience; the task's prompt
   * is acted on only while it hashes to what the owner set up. An edited one is put to the lead
   * once, in the owner's chat, to ask; later runs skip until the owner confirms it.
   */
  const runNative = Effect.fn("KinScheduledTasks.runNative")(function* (
    orgId: KinOrgId,
    schedule: KinSchedules.KinSchedule,
    fire: KinTriggerFired,
    now: number,
  ) {
    const consume = inbox.markConsumed(orgId, [fire.fireId]);
    const manual = fire.fireId.endsWith(":manual");
    const task = yield* KinSchedules.readNativeTask(sql, schedule.taskId);
    const lead = yield* scheduleLead(orgId, schedule.agentId);
    const hash = task === undefined ? undefined : yield* KinSchedules.promptSha256(task.prompt);
    const confirmed = hash === schedule.contentSha256;
    // An unconfirmed wording is asked about in the owner's chat, as an owner-only turn.
    const origin =
      lead === undefined || !confirmed
        ? undefined
        : yield* firingOrigin(
            sql,
            orgId,
            { chat: schedule.chatId, source_event: KinEventId.make(schedule.sourceEvent) },
            lead,
          );
    const admitted =
      lead === undefined
        ? false
        : yield* budget.admit(orgId, "P2").pipe(
            Effect.map((admission) => admission.allowed),
            Effect.orElseSucceed(() => false),
          );
    const paused = yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* KinSchedules.readSchedule(sql, orgId, schedule.scheduleId);
        // Deleted, or paused (from the card or T3's screen) since the slot fired: drop the fire.
        if (
          row === undefined ||
          task === undefined ||
          hash === undefined ||
          row.deletedAt !== null ||
          (!manual && (row.pendingEnabled ?? task.enabled) !== 1)
        )
          return yield* consume;
        const itemId = row.scheduleId;
        const widget = yield* repo.getWidget({
          orgId,
          widgetId: scheduledTaskWidgetId(orgId, itemId),
        });
        const card = Option.isSome(widget)
          ? Option.getOrUndefined(yield* decodeCard(widget.value.state).pipe(Effect.option))
          : undefined;
        const every = KinSchedules.everyOf(task) ?? card?.every;
        if (every === undefined) return yield* consume;
        const base: KinScheduledTaskCard = {
          itemId,
          title: task.title,
          every,
          timeZone: KinSchedules.hostTimeZone(),
          status: task.enabled === 1 ? "active" : "paused",
          nextRunAt: task.nextRunAt,
          lastRun: card?.lastRun ?? null,
        };
        const at = fire.dueAt;
        const settleCard = (lastRun: KinScheduledTaskCard["lastRun"]) =>
          Option.isSome(widget)
            ? cards.update(widget.value, { ...base, lastRun }, now)
            : Effect.void;
        const title = task.title;
        const skip = Effect.fn("KinScheduledTasks.skipNative")(function* (why: string) {
          yield* settleCard({ at, status: "skipped", note: why });
          const chatId = yield* cardChatFor(sql, orgId, row.chatId, lead?.ownerChatId ?? null);
          if (chatId !== null)
            yield* notice(orgId, chatId, fire.fireId, `Skipped "${title}": ${why}`, now);
          yield* consume;
        });
        if (paused) return yield* skip("Kin is paused.");
        if (lead === undefined) return yield* skip("there is no agent to run it.");
        if (!admitted) return yield* skip("today's budget is used up.");
        if (!confirmed) {
          if (row.askedSha256 === hash) {
            yield* settleCard({
              at,
              status: "skipped",
              note: "waiting for you to confirm its new wording.",
            });
            return yield* consume;
          }
          yield* sql`UPDATE kin_schedules SET asked_sha256 = ${hash}, updated_at = ${now}
            WHERE task_id = ${row.taskId}`;
        }
        const runId = fire.fireId;
        const dedupeKey = `scheduled:${runId}`;
        const eventId = KinEventId.make(`scheduled_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`);
        const event = yield* decodeEvent({
          _tag: "deferral.due",
          eventId,
          orgId,
          agentId: lead.agentId,
          receivedAt: fire.firedAt,
          provenance: { _tag: "system" },
          dedupeKey,
          subject: { type: "scheduled_task", itemId, runId },
          lateByMs: fire.lateByMs,
          ...(origin === undefined ? {} : { origin }),
        });
        const running = { ...base, lastRun: { at, status: "running" as const } };
        yield* deliveries.handOff(event, {
          orgId,
          eventId,
          kind: "scheduled_task",
          agentId: lead.agentId,
          chatId: lead.ownerChatId,
          widget: {
            widgetId: scheduledTaskWidgetId(orgId, itemId),
            type: "scheduled_task",
            state: running,
          },
          fallbackBody: `${lead.name} couldn't finish "${title}" this time.`,
          deadlineAt: now + LeadDelivery.DELIVERY_DEADLINE_MS.scheduled_task,
        });
        yield* settleCard(running.lastRun);
        yield* consume;
      }),
    );
  });

  /**
   * Keeps each native schedule's card a view of its task: posted once, in its chat or, once that
   * was shared, the lead's owner chat; closed when the task is gone, whichever screen removed it.
   */
  const syncNative = Effect.fn("KinScheduledTasks.syncNative")(function* (orgId: KinOrgId) {
    const write = (input: Parameters<typeof writeCard>[0]) =>
      writeCard(input).pipe(
        Effect.provideService(Repository.KinChatRepository, repo),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    const now = yield* Clock.currentTimeMillis;
    for (const row of yield* KinSchedules.listSchedules(sql, orgId)) {
      const task =
        row.deletedAt === null ? yield* KinSchedules.readNativeTask(sql, row.taskId) : undefined;
      const widgetId = scheduledTaskWidgetId(orgId, row.scheduleId);
      const widget = yield* repo.getWidget({ orgId, widgetId });
      const card = Option.isSome(widget)
        ? Option.getOrUndefined(yield* decodeCard(widget.value.state).pipe(Effect.option))
        : undefined;
      if (task === undefined) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kin_schedules WHERE task_id = ${row.taskId}`;
            if (card !== undefined)
              yield* write({
                orgId,
                itemId: row.scheduleId,
                chatId: null,
                state: { ...card, status: "deleted", nextRunAt: null },
                closed: true,
                now,
              });
          }),
        );
        continue;
      }
      const every = KinSchedules.everyOf(task) ?? card?.every;
      if (every === undefined) continue;
      const lead = yield* scheduleLead(orgId, row.agentId);
      const chatId = yield* cardChatFor(sql, orgId, row.chatId, lead?.ownerChatId ?? null);
      const enabled = row.pendingEnabled === null ? task.enabled === 1 : row.pendingEnabled === 1;
      yield* sql.withTransaction(
        write({
          orgId,
          itemId: row.scheduleId,
          chatId,
          state: {
            itemId: row.scheduleId,
            title: task.title,
            every,
            timeZone: KinSchedules.hostTimeZone(),
            status: enabled ? "active" : "paused",
            nextRunAt: enabled ? task.nextRunAt : null,
            lastRun: card?.lastRun ?? null,
          },
          closed: false,
          now,
        }),
      );
    }
  });

  /** One run: a fire (`fire`) or a Run now tap (`runNowAt`). */
  const run = Effect.fn("KinScheduledTasks.run")(function* (
    orgId: KinOrgId,
    itemId: KinMemoryItemId,
    source:
      | { readonly kind: "fire"; readonly fire: KinTriggerFired }
      | { readonly kind: "now"; readonly at: number },
    now: number,
  ) {
    const native = yield* KinSchedules.readSchedule(sql, orgId, itemId);
    if (native !== undefined)
      return source.kind === "fire" ? yield* runNative(orgId, native, source.fire, now) : undefined;
    const runId =
      source.kind === "fire"
        ? source.fire.fireId
        : `${scheduledTaskTriggerId(itemId)}:now:${source.at}`;
    const dueAt = source.kind === "fire" ? Date.parse(source.fire.dueAt) : source.at;
    const consume =
      source.kind === "fire"
        ? inbox.markConsumed(orgId, [source.fire.fireId])
        : sql`UPDATE kin_scheduled_tasks SET run_now_at = NULL
            WHERE org_id = ${orgId} AND item_id = ${itemId} AND run_now_at = ${source.at}`.pipe(
            Effect.asVoid,
          );
    // Read-only I/O first: memory takes its own lock.
    const item = yield* memory.readItemQuietly(orgId, itemId, "triggers").pipe(
      Effect.map((found) => found.head),
      Effect.catchTags({
        MemoryNotFound: () => Effect.undefined,
        MemoryDuplicateId: () => Effect.undefined,
      }),
    );
    const timeZone = yield* cache.ownerTimeZone(orgId);
    const lead =
      item === undefined
        ? undefined
        : yield* liveLead(sql, orgId, { chatId: item.chat, prefer: CHIEF_OF_STAFF_DOMAIN });
    // Run at no more than the chat the owner set it up from.
    const origin = lead === undefined ? undefined : yield* firingOrigin(sql, orgId, item, lead);
    const admitted =
      lead === undefined
        ? false
        : yield* budget.admit(orgId, "P2").pipe(
            Effect.map((admission) => admission.allowed),
            Effect.orElseSucceed(() => false),
          );
    const paused = yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Taken, or held by a retirement, since the drain read it: it stays as it is.
        if (
          source.kind === "fire" &&
          !(yield* KinTriggerInbox.fireOpen(sql, orgId, source.fire.fireId))
        )
          return;
        const row = yield* readScheduledTask(sql, orgId, itemId);
        const widget = yield* repo.getWidget({
          orgId,
          widgetId: scheduledTaskWidgetId(orgId, itemId),
        });
        // A paused, deleted or disarmed task drops its fire; Run now still runs while paused.
        if (
          row === undefined ||
          row.state !== "active" ||
          item === undefined ||
          !armed(item) ||
          (source.kind === "fire" && row.paused === 1) ||
          (source.kind === "now" && row.runNowAt !== source.at)
        )
          return yield* consume;
        const card = Option.isSome(widget)
          ? yield* decodeCard(widget.value.state).pipe(Effect.option)
          : Option.none<KinScheduledTaskCard>();
        const nextRunAt = yield* triggerNext(sql, orgId, itemId);
        const base =
          Option.isSome(card) && item.every !== undefined
            ? card.value
            : item.every === undefined
              ? undefined
              : cardState(
                  { id: item.id, title: item.title, every: item.every },
                  timeZone,
                  "active",
                  nextRunAt,
                  null,
                );
        if (base === undefined) return yield* consume;
        const at = iso(dueAt);
        const settleCard = (lastRun: KinScheduledTaskCard["lastRun"]) =>
          Option.isSome(widget)
            ? cards.update(
                widget.value,
                { ...base, nextRunAt: nextRunAt === null ? null : iso(nextRunAt), lastRun },
                now,
              )
            : Effect.void;
        const skip = Effect.fn("KinScheduledTasks.skip")(function* (why: string) {
          yield* settleCard({ at, status: "skipped", note: why });
          const chatId =
            row.chatId === null
              ? lead?.ownerChatId
              : yield* cardChatFor(sql, orgId, row.chatId, lead?.ownerChatId ?? null);
          if (chatId !== undefined && chatId !== null)
            yield* notice(
              orgId,
              KinChatId.make(chatId),
              runId,
              `Skipped "${item.title}": ${why}`,
              now,
            );
          yield* consume;
        });
        if (paused) return yield* skip("Kin is paused.");
        if (lead === undefined) return yield* skip("there is no agent to run it.");
        if (!admitted) return yield* skip("today's budget is used up.");
        if (source.kind === "fire" && now - dueAt > SCHEDULED_RUN_LATE_MS)
          return yield* skip("it was due too long ago to run now.");
        const dedupeKey = `scheduled:${runId}`;
        const eventId = KinEventId.make(`scheduled_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`);
        const event = yield* decodeEvent({
          _tag: "deferral.due",
          eventId,
          orgId,
          agentId: lead.agentId,
          receivedAt: iso(source.kind === "fire" ? Date.parse(source.fire.firedAt) : source.at),
          provenance: { _tag: "system" },
          dedupeKey,
          subject: { type: "scheduled_task", itemId, runId },
          lateByMs: Math.max(0, now - dueAt),
          ...(origin === undefined ? {} : { origin }),
        });
        const running = {
          ...base,
          nextRunAt: nextRunAt === null ? null : iso(nextRunAt),
          lastRun: { at, status: "running" as const },
        };
        yield* deliveries.handOff(event, {
          orgId,
          eventId,
          kind: "scheduled_task",
          agentId: KinAgentId.make(lead.agentId),
          chatId: lead.ownerChatId,
          widget: {
            widgetId: scheduledTaskWidgetId(orgId, itemId),
            type: "scheduled_task",
            state: running,
          },
          fallbackBody: `${lead.name} couldn't finish "${item.title}" this time.`,
          deadlineAt: now + LeadDelivery.DELIVERY_DEADLINE_MS.scheduled_task,
        });
        yield* settleCard(running.lastRun);
        yield* consume;
      }),
    );
  });

  const drain = Effect.fn("KinScheduledTasks.drain")(
    function* (orgId: KinOrgId) {
      // Card taps reach the native tasks first, so a Run now fires in this same pass.
      yield* schedules
        .applyTaps(orgId)
        .pipe(
          Effect.catch((cause) => Effect.logWarning("Kin schedule taps failed", { orgId, cause })),
        );
      const now = yield* Clock.currentTimeMillis;
      const fires = yield* inbox.listPending(orgId, 100, "scheduled_task");
      for (const fire of fires) {
        if (fire.payload.kind !== "time" || fire.payload.subject.type !== "scheduled_task")
          continue;
        yield* run(orgId, fire.payload.subject.itemId, { kind: "fire", fire }, now).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin scheduled run failed", { orgId, fireId: fire.fireId, cause }),
          ),
        );
      }
      const taps = yield* sql<{ itemId: string; runNowAt: number }>`SELECT item_id AS "itemId",
          run_now_at AS "runNowAt" FROM kin_scheduled_tasks
        WHERE org_id = ${orgId} AND run_now_at IS NOT NULL ORDER BY run_now_at, item_id LIMIT 100`;
      for (const tap of taps)
        yield* run(
          orgId,
          KinMemoryItemId.make(tap.itemId),
          { kind: "now", at: tap.runNowAt },
          now,
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin scheduled run now failed", { orgId, itemId: tap.itemId, cause }),
          ),
        );
      yield* syncNative(orgId);
    },
    (effect, orgId) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new KinScheduledTasksError({
              orgId,
              cause: isSqlError(cause) ? toPersistenceSqlError("KinScheduledTasks")(cause) : cause,
            }),
        ),
      ),
  );

  yield* ticks.register(
    "kin-scheduled-tasks",
    Effect.gen(function* () {
      const orgs = yield* sql<{
        orgId: string;
      }>`SELECT org_id AS "orgId" FROM kin_orgs ORDER BY org_id`;
      for (const { orgId } of orgs)
        yield* drain(KinOrgId.make(orgId)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin scheduled tasks tick failed", { orgId, cause }),
          ),
        );
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Kin scheduled tasks scan failed", { cause })),
    ),
  );
  return KinScheduledTasks.of({ drain });
});

export const layer = Layer.effect(KinScheduledTasks, make).pipe(
  Layer.provide(MemoryCache.layer),
  Layer.provideMerge(KinSchedules.layer),
);
