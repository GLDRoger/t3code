import {
  type KinAgentId,
  KinChatId,
  type KinEvent,
  KinEventId,
  KinMessageId,
  KinOrgId,
  KinScheduledTaskCard,
  KinWidgetId,
  type KinWidget,
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
import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinEventQueue from "./KinEventQueue.ts";

export type DeliveryKind = "reminder" | "routine" | "scheduled_task";

/**
 * What the server does once the lead's wake-up for `eventId` ends. `reminder` and `routine`
 * attach a new card to the lead's message; `scheduled_task` records the run on its standing card.
 * A routine or scheduled run whose finished wake-up wrote nothing had nothing to report: no message.
 */
export interface Delivery {
  readonly orgId: KinOrgId;
  readonly eventId: KinEventId;
  readonly kind: DeliveryKind;
  readonly agentId: KinAgentId;
  /** The wake-up's lane: where the lead's message lands. */
  readonly chatId: KinChatId;
  readonly widget: {
    readonly widgetId: KinWidgetId;
    readonly type: string;
    readonly state: unknown;
  };
  /** Kin's own line when the lead can't write it, saying so. */
  readonly fallbackBody: string;
  readonly deadlineAt: number;
}

export class KinLeadDeliveryError extends Schema.TaggedError<KinLeadDeliveryError>()(
  "KinLeadDeliveryError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

export class KinLeadDelivery extends Context.Service<
  KinLeadDelivery,
  {
    /**
     * In the caller's transaction: queues the lead's wake-up and records the delivery. False when
     * the event was already queued, so a replayed fire records nothing new.
     */
    readonly handOff: (
      event: KinEvent,
      delivery: Delivery,
    ) => Effect.Effect<boolean, KinLeadDeliveryError>;
    /** Records a delivery for an event already queued or claimed. Idempotent. */
    readonly track: (delivery: Delivery) => Effect.Effect<void, KinLeadDeliveryError>;
    /** Posts Kin's own line now, for when no wake-up can run. */
    readonly fallback: (delivery: Delivery) => Effect.Effect<void, KinLeadDeliveryError>;
    /** Settles this org's pending deliveries whose wake-up ended, failed or waited too long. */
    readonly settle: (orgId: KinOrgId) => Effect.Effect<void, KinLeadDeliveryError>;
  }
>()("t3/kin/lead/LeadDelivery/KinLeadDelivery") {}

/** A reminder waits this long for its wake-up; a routine and a scheduled run wait longer. */
export const DELIVERY_DEADLINE_MS: Record<DeliveryKind, number> = {
  reminder: 10 * 60_000,
  routine: 20 * 60_000,
  scheduled_task: 30 * 60_000,
};
const EXCERPT_MAX = 200;
const NOTHING_TO_REPORT = "nothing to report.";
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeScheduledCard = Schema.decodeUnknownEffect(KinScheduledTaskCard);
const encodeScheduledCard = Schema.encodeEffect(KinScheduledTaskCard);

const excerpt = (body: string) => {
  const chars = Array.from(body.replace(/\s+/g, " ").trim());
  return chars.length > EXCERPT_MAX
    ? `${chars.slice(0, EXCERPT_MAX - 1).join("")}…`
    : chars.join("");
};

/** Server card writes shared by deliveries and the cards they settle. Runs in the caller's transaction. */
export const makeCardWriter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const publish = (event: Parameters<KinChatHub["Service"]["publish"]>[0]) =>
    Option.isSome(hub) ? sql.afterCommit(hub.value.publish(event)) : Effect.void;

  const widgetRow = (
    orgId: KinOrgId,
    chatId: KinChatId,
    messageId: KinMessageId,
    widget: Delivery["widget"],
    at: string,
  ): Omit<KinWidget, "revision"> => ({
    orgId,
    chatId,
    messageId,
    widgetId: widget.widgetId,
    widgetClass: "native",
    type: widget.type,
    state: widget.state,
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  });

  /** Links a new card to an existing message, which clients then redraw with it. */
  const attach = Effect.fn("KinCards.attach")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    messageId: KinMessageId,
    widget: Delivery["widget"],
    now: number,
  ) {
    const row = widgetRow(orgId, chatId, messageId, widget, iso(now));
    yield* repo.insertWidget(row);
    const message = yield* repo.getMessage({ orgId, messageId });
    if (Option.isSome(message))
      yield* publish({ type: "message.posted", orgId, message: message.value });
    yield* publish({ type: "widget.updated", orgId, widget: { ...row, revision: 1 } });
  });

  /** Posts a system line carrying a new card. Idempotent on `messageId`. */
  const post = Effect.fn("KinCards.post")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    messageId: KinMessageId,
    body: string,
    widget: Delivery["widget"],
    now: number,
  ) {
    const existing = yield* repo.getWidget({ orgId, widgetId: widget.widgetId });
    if (Option.isSome(existing)) return existing.value;
    const at = iso(now);
    const message = yield* repo.insertMessage({
      orgId,
      chatId,
      messageId,
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
      createdAt: at,
      editedAt: null,
    });
    const row = widgetRow(orgId, chatId, message.messageId, widget, at);
    yield* repo.insertWidget(row);
    yield* publish({
      type: "message.posted",
      orgId,
      message: { ...message, widgetId: widget.widgetId },
    });
    yield* publish({ type: "widget.updated", orgId, widget: { ...row, revision: 1 } });
    return { ...row, revision: 1 };
  });

  /** Rewrites a card's state in place; a closed card stays closed unless `closed` says otherwise. */
  const update = Effect.fn("KinCards.update")(function* (
    widget: KinWidget,
    state: unknown,
    now: number,
    closed?: boolean,
  ) {
    const at = iso(now);
    const updated = yield* repo.updateWidget({
      ...widget,
      state,
      expectedRevision: widget.revision,
      closedAt: closed === undefined ? widget.closedAt : closed ? at : null,
      updatedAt: at,
    });
    yield* publish({ type: "widget.updated", orgId: widget.orgId, widget: updated });
    return updated;
  });
  return { attach, post, update };
});

interface Row {
  readonly eventId: string;
  readonly kind: DeliveryKind;
  readonly agentId: string;
  readonly chatId: string;
  readonly widgetId: string;
  readonly widgetType: string;
  readonly state: string;
  readonly fallbackBody: string;
  readonly deadlineAt: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const queue = yield* KinEventQueue.KinEventQueue;
  const ticks = yield* Scheduler.Scheduler;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const cards = yield* makeCardWriter;

  const record = Effect.fn("KinLeadDelivery.record")(function* (delivery: Delivery, now: number) {
    const state = yield* encodeJson(delivery.widget.state);
    yield* sql`INSERT INTO kin_lead_deliveries (org_id, event_id, kind, agent_id, chat_id, widget_id,
        widget_type, state_json, fallback_body, deadline_at, status, message_id, created_at, updated_at)
      VALUES (${delivery.orgId}, ${delivery.eventId}, ${delivery.kind}, ${delivery.agentId},
        ${delivery.chatId}, ${delivery.widget.widgetId}, ${delivery.widget.type}, ${state},
        ${delivery.fallbackBody}, ${delivery.deadlineAt}, 'pending', NULL, ${now}, ${now})
      ON CONFLICT (org_id, event_id) DO NOTHING`;
  });

  // A scheduled run settles on its standing card: the run's result, or why there is none.
  const settleRun = Effect.fn("KinLeadDelivery.settleRun")(function* (
    orgId: KinOrgId,
    widgetId: KinWidgetId,
    lastRun: KinScheduledTaskCard["lastRun"],
    now: number,
  ) {
    const widget = yield* repo.getWidget({ orgId, widgetId });
    if (Option.isNone(widget) || widget.value.type !== "scheduled_task") return;
    const card = yield* decodeScheduledCard(widget.value.state);
    yield* cards.update(widget.value, yield* encodeScheduledCard({ ...card, lastRun }), now);
  });

  const fallbackIn = Effect.fn("KinLeadDelivery.fallbackIn")(function* (
    delivery: Delivery,
    now: number,
  ) {
    const { orgId } = delivery;
    if (delivery.kind === "scheduled_task") {
      yield* repo
        .insertMessage({
          orgId,
          chatId: delivery.chatId,
          messageId: KinMessageId.make(`kin-run-failed:${delivery.eventId}`),
          author: { _tag: "system" },
          kind: "system",
          body: delivery.fallbackBody,
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
        .pipe(
          Effect.tap((message) =>
            Option.isSome(hub)
              ? sql.afterCommit(hub.value.publish({ type: "message.posted", orgId, message }))
              : Effect.void,
          ),
        );
      const state = yield* decodeScheduledCard(delivery.widget.state).pipe(Effect.option);
      yield* settleRun(
        orgId,
        delivery.widget.widgetId,
        {
          at: Option.match(state, {
            onNone: () => iso(now),
            onSome: (card) => card.lastRun?.at ?? iso(now),
          }),
          status: "failed",
          note: excerpt(delivery.fallbackBody),
        },
        now,
      );
      return;
    }
    const { widget } = delivery;
    const marked =
      delivery.kind === "reminder" && typeof widget.state === "object" && widget.state !== null
        ? { ...widget, state: { ...widget.state, fallback: true } }
        : widget;
    yield* cards.post(
      orgId,
      delivery.chatId,
      KinMessageId.make(widget.widgetId),
      delivery.fallbackBody,
      marked,
      now,
    );
  });
  const settleOne = Effect.fn("KinLeadDelivery.settleOne")(function* (
    orgId: KinOrgId,
    row: Row,
    now: number,
  ) {
    const delivery: Delivery = {
      orgId,
      eventId: KinEventId.make(row.eventId),
      kind: row.kind,
      agentId: row.agentId as KinAgentId,
      chatId: KinChatId.make(row.chatId),
      widget: {
        widgetId: KinWidgetId.make(row.widgetId),
        type: row.widgetType,
        state: yield* decodeJson(row.state),
      },
      fallbackBody: row.fallbackBody,
      deadlineAt: row.deadlineAt,
    };
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const [pending] = yield* sql`SELECT 1 FROM kin_lead_deliveries
          WHERE org_id = ${orgId} AND event_id = ${row.eventId} AND status = 'pending'
          ORDER BY event_id`;
        if (pending === undefined) return;
        const [event] = yield* sql<{
          state: string;
          budgetDeferred: number;
          startedAt: number | null;
          endedAt: number | null;
        }>`SELECT e.state, e.budget_deferred AS "budgetDeferred", w.started_at AS "startedAt",
            w.ended_at AS "endedAt"
          FROM kin_events e
          LEFT JOIN kin_wakeups w ON w.org_id = e.org_id AND w.wakeup_id = e.wakeup_id
          WHERE e.org_id = ${orgId} AND e.event_id = ${row.eventId} ORDER BY e.event_id`;
        const finish = (status: "delivered" | "fallback", messageId: string | null) =>
          sql`UPDATE kin_lead_deliveries SET status = ${status}, message_id = ${messageId},
            updated_at = ${now} WHERE org_id = ${orgId} AND event_id = ${row.eventId}`;
        const fallback = Effect.gen(function* () {
          yield* fallbackIn(delivery, now);
          yield* finish("fallback", null);
        });
        if (event === undefined || event.state === "failed" || event.state === "expired")
          return yield* fallback;
        if (event.state === "claimed") return;
        if (event.state === "queued") {
          // Out of budget, or waiting past the deadline: Kin says it now, and the lead won't later.
          if (event.budgetDeferred !== 1 && now < row.deadlineAt) return;
          const expired = yield* sql`UPDATE kin_events SET state = 'expired'
            WHERE org_id = ${orgId} AND event_id = ${row.eventId} AND state = 'queued'
            RETURNING event_id`;
          if (expired.length === 0) return;
          return yield* fallback;
        }
        // Done: the lead's last message in its lane during that wake-up carries the card.
        const from = iso(event.startedAt ?? now);
        const until = iso(event.endedAt ?? now);
        const [message] = yield* sql<{ messageId: string; body: string }>`
          SELECT message_id AS "messageId", body FROM kin_messages
          WHERE org_id = ${orgId} AND chat_id = ${row.chatId} AND author_kind = 'agent'
            AND author_agent_id = ${row.agentId} AND status = 'posted' AND kind = 'text'
            AND widget_id IS NULL AND created_at >= ${from} AND created_at <= ${until}
          ORDER BY seq DESC LIMIT 1`;
        if (message === undefined) {
          // A reminder is owed; a routine or scheduled run that found nothing to say posts nothing.
          if (row.kind === "reminder") return yield* fallback;
          if (row.kind === "scheduled_task") {
            const state = yield* decodeScheduledCard(delivery.widget.state);
            yield* settleRun(
              orgId,
              delivery.widget.widgetId,
              { at: state.lastRun?.at ?? iso(now), status: "skipped", note: NOTHING_TO_REPORT },
              now,
            );
          }
          return yield* finish("delivered", null);
        }
        const messageId = KinMessageId.make(message.messageId);
        if (row.kind === "scheduled_task") {
          const state = yield* decodeScheduledCard(delivery.widget.state);
          yield* settleRun(
            orgId,
            delivery.widget.widgetId,
            {
              at: state.lastRun?.at ?? iso(now),
              status: "posted",
              note: excerpt(message.body),
              messageId,
            },
            now,
          );
        } else yield* cards.attach(orgId, delivery.chatId, messageId, delivery.widget, now);
        yield* finish("delivered", message.messageId);
      }),
    );
  });

  const settle = Effect.fn("KinLeadDelivery.settle")(
    function* (orgId: KinOrgId) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<Row>`SELECT event_id AS "eventId", kind, agent_id AS "agentId",
          chat_id AS "chatId", widget_id AS "widgetId", widget_type AS "widgetType",
          state_json AS state, fallback_body AS "fallbackBody", deadline_at AS "deadlineAt"
        FROM kin_lead_deliveries WHERE org_id = ${orgId} AND status = 'pending'
        ORDER BY created_at, event_id LIMIT 100`;
      for (const row of rows)
        yield* settleOne(orgId, row, now).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin lead delivery failed", { orgId, eventId: row.eventId, cause }),
          ),
        );
    },
    (effect, orgId) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new KinLeadDeliveryError({
              orgId,
              cause: isSqlError(cause) ? toPersistenceSqlError("KinLeadDelivery")(cause) : cause,
            }),
        ),
      ),
  );

  const wrap = (orgId: KinOrgId) =>
    Effect.mapError(
      (cause: unknown) =>
        new KinLeadDeliveryError({
          orgId,
          cause: isSqlError(cause) ? toPersistenceSqlError("KinLeadDelivery")(cause) : cause,
        }),
    );

  yield* ticks.register(
    "kin-lead-deliveries",
    Effect.gen(function* () {
      const orgs = yield* sql<{ orgId: string }>`SELECT DISTINCT org_id AS "orgId"
        FROM kin_lead_deliveries WHERE status = 'pending' ORDER BY org_id`;
      for (const { orgId } of orgs)
        yield* settle(KinOrgId.make(orgId)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin lead deliveries failed", { orgId, cause }),
          ),
        );
    }).pipe(Effect.catch((cause) => Effect.logWarning("Kin lead delivery scan failed", { cause }))),
  );

  return KinLeadDelivery.of({
    handOff: Effect.fn("KinLeadDelivery.handOff")((event, delivery) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const queued = yield* queue.enqueue(event);
        if (queued.duplicate) return false;
        yield* record(delivery, now);
        return true;
      }).pipe(wrap(delivery.orgId)),
    ),
    track: Effect.fn("KinLeadDelivery.track")((delivery) =>
      Effect.gen(function* () {
        yield* record(delivery, yield* Clock.currentTimeMillis);
      }).pipe(wrap(delivery.orgId)),
    ),
    fallback: Effect.fn("KinLeadDelivery.fallback")((delivery) =>
      Effect.gen(function* () {
        yield* fallbackIn(delivery, yield* Clock.currentTimeMillis);
      }).pipe(wrap(delivery.orgId)),
    ),
    settle,
  });
});

export const layer = Layer.effect(KinLeadDelivery, make);
