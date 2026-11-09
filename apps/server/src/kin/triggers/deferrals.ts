import {
  KinAgentId,
  type KinAuthor,
  KinChatId,
  KinDeferralCard,
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinTriggerId,
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
import { stringify } from "yaml";

import { KinChatHub } from "../chat/KinChatHub.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { WorkerLaunchGate } from "../lead/Workers.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import * as MemoryWriter from "../memory/MemoryWriter.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import { deferralCardActions } from "../widgets/deferralCard.ts";
import { GithubLinkState, githubRef } from "./deferralGithub.ts";
import { verifyOwnerTap } from "./ownerCheck.ts";

export const HEADS_UP_MS = 30 * 60_000;
export const GRACE_MS = 30 * 60_000;
export const LATE_NOTE_MS = 10 * 60_000;
export type OnDue = KinDeferralCard["onDue"];
export type DeferralPhase = "heads_up" | "due";

export interface DeferralPlan {
  readonly armed: boolean;
  readonly dueAt: number | null;
  readonly onDue: OnDue;
  readonly phases: ReadonlyArray<{ readonly phase: DeferralPhase; readonly runAt: number }>;
}

export const deferralTriggerId = (itemId: string, phase: DeferralPhase) =>
  KinTriggerId.make(`deferral:${itemId}:${phase}`);
export const deferralWidgetId = (orgId: string, itemId: string) => `deferral:${orgId}:${itemId}`;
/** The due fire's id: starting is keyed by it, so taps and replays share one start. */
const deferralStartKey = (itemId: string, dueAt: number) =>
  `${deferralTriggerId(itemId, "due")}:${dueAt}`;

// A deferral without on_due only reminds: silence never starts work. Pre-epoch run
// times would fail every scheduler tick, so they leave the item unarmed.
export function planDeferral(
  item: MemoryItemHead & { readonly duplicate?: boolean },
): DeferralPlan {
  const onDue = item.on_due ?? "remind";
  const due = memoryDateMillis(item.due);
  const dueAt = Number.isFinite(due) ? due : null;
  const armed =
    item.kind === "deferral" &&
    item.status === "open" &&
    item.invalid_at === null &&
    item.superseded_by === null &&
    item.duplicate !== true &&
    dueAt !== null;
  if (!armed || dueAt === null) return { armed: false, dueAt, onDue, phases: [] };
  const dueFire = { phase: "due" as const, runAt: dueAt };
  const phases: DeferralPlan["phases"] =
    onDue === "start" ? [{ phase: "heads_up", runAt: dueAt - HEADS_UP_MS }, dueFire] : [dueFire];
  if (phases.some(({ runAt }) => runAt < 0)) return { armed: false, dueAt, onDue, phases: [] };
  return { armed, dueAt, onDue, phases };
}

/** The recheck baseline. `github` is null when GitHub couldn't be read at arm time. */
export const DeferralSnapshot = Schema.Struct({
  recordedAt: Schema.String,
  supersededBy: Schema.NullOr(KinMemoryItemId),
  links: Schema.Array(Schema.String),
  github: Schema.optional(Schema.NullOr(Schema.Array(GithubLinkState))),
  /** The re-armed due fire's instant while the run is in `grace`. */
  graceEndsAt: Schema.optional(Schema.Number),
});
export type DeferralSnapshot = typeof DeferralSnapshot.Type;
export const deferralSnapshot = (
  item: MemoryItemHead,
  github: ReadonlyArray<GithubLinkState> | null,
): DeferralSnapshot => ({
  recordedAt: item.recorded_at,
  supersededBy: item.superseded_by,
  links: item.links,
  github,
});

const label = (link: string) => {
  const ref = githubRef(link);
  return ref === undefined ? link : `${ref.repo}#${ref.number}`;
};

/** What changed since arm time; empty means unchanged. */
export function snapshotChanges(
  before: DeferralSnapshot,
  item: MemoryItemHead | undefined,
  github: ReadonlyArray<GithubLinkState> | null,
): ReadonlyArray<string> {
  if (item === undefined) return ["the item is gone"];
  const changes: Array<string> = [];
  if (item.status !== "open") changes.push(`the item is ${item.status}`);
  if (item.invalid_at !== null) changes.push("the item was invalidated");
  if (item.superseded_by !== before.supersededBy)
    changes.push(`the item was superseded by ${item.superseded_by}`);
  if (item.recorded_at !== before.recordedAt) changes.push("the item was edited");
  const sameLinks =
    item.links.length === before.links.length &&
    item.links.every((link) => before.links.includes(link));
  if (!sameLinks) changes.push("its links changed");
  if (before.github === undefined || before.github === null)
    changes.push("changed: couldn't verify GitHub when it was deferred");
  else if (github === null) changes.push("changed: couldn't verify GitHub");
  else
    for (const previous of before.github) {
      const current = github.find((entry) => entry.link === previous.link);
      const name = label(previous.link);
      if (current === undefined) continue;
      if (current.state !== previous.state) changes.push(`${name} is ${current.state}`);
      for (const person of current.assignees)
        if (!previous.assignees.includes(person)) changes.push(`${person} was assigned to ${name}`);
      for (const person of previous.assignees)
        if (!current.assignees.includes(person))
          changes.push(`${person} was unassigned from ${name}`);
      for (const pr of current.linkedPrs)
        if (!previous.linkedPrs.includes(pr)) changes.push(`PR #${pr} was linked to ${name}`);
    }
  return changes;
}

const then: Record<OnDue, string> = {
  start: "I'll start then.",
  remind: "I'll remind you then.",
  ask: "I'll ask you then.",
  chase: "I'll chase it then.",
};

const parts = (at: number, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );

export function confirmText(dueAt: number, onDue: OnDue, timeZone: string): string {
  return `Deferred to ${ownerDateTime(dueAt, timeZone)}. ${then[onDue]}`;
}

/** Owner-local "Fri 13 Nov, 9:00". */
export function ownerDateTime(at: number, timeZone: string): string {
  const p = parts(at, timeZone);
  return `${p.weekday} ${p.day} ${p.month}, ${Number(p.hour)}:${p.minute}`;
}

/** Owner-local "9:00", with the day when it isn't today. */
export function ownerTime(at: number, now: number, timeZone: string): string {
  const p = parts(at, timeZone);
  const today = parts(now, timeZone);
  return p.day === today.day && p.month === today.month && p.year === today.year
    ? `${Number(p.hour)}:${p.minute}`
    : ownerDateTime(at, timeZone);
}

export const lateNote = (dueAt: number, now: number, timeZone: string) =>
  now - dueAt > LATE_NOTE_MS ? ` This was due at ${ownerTime(dueAt, now, timeZone)}.` : "";

/** Next Monday 09:00 owner time, strictly after today, as a front-matter date-time. */
function nextMondayDue(now: number, timeZone: string): string {
  const today = DateTime.makeZonedUnsafe(now, { timeZone });
  const weekDay = DateTime.toParts(today).weekDay;
  const ahead = (8 - weekDay) % 7 || 7;
  const monday = DateTime.setParts(DateTime.add(today, { days: ahead }), {
    hour: 9,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return DateTime.formatIsoOffset(monday);
}

// LEAD-11's stop switch isn't built; until it is every org reads as stopped, so
// silence never starts work.
export const KinDeferralStopSwitch = Context.Reference<{
  readonly isStopped: (orgId: KinOrgId) => Effect.Effect<boolean>;
}>("t3/kin/triggers/deferrals/KinDeferralStopSwitch", {
  defaultValue: () => ({ isStopped: () => Effect.succeed(true) }),
});

/** The lead level work may start at; an owner tap is not a level grant. */
export const startsAtLevel = (level: string) => level === "L2" || level === "L3";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

/** Code posts deferral cards, never the model. */
export const makeDeferralCards = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const hub = yield* Effect.serviceOption(KinChatHub);
  const publish = (event: Parameters<KinChatHub["Service"]["publish"]>[0]) =>
    Option.isSome(hub) ? sql.afterCommit(hub.value.publish(event)) : Effect.void;

  /** Updates the item's card in place, or posts it to `chatId`. */
  const write = Effect.fn("Deferrals.writeCard")(function* (input: {
    readonly orgId: KinOrgId;
    readonly itemId: KinMemoryItemId;
    readonly state: KinDeferralCard;
    readonly chatId: KinChatId | null;
    readonly now: number;
  }) {
    const { orgId, state } = input;
    const widgetId = KinWidgetId.make(deferralWidgetId(orgId, input.itemId));
    const existing = yield* repo.getWidget({ orgId, widgetId });
    const at = iso(input.now);
    if (Option.isSome(existing)) {
      const widget = yield* repo.updateWidget({
        ...existing.value,
        expectedRevision: existing.value.revision,
        state,
        closedAt: null,
        updatedAt: at,
      });
      yield* publish({ type: "widget.updated", orgId, widget });
      return true;
    }
    if (input.chatId === null) return false;
    const message = yield* repo.insertMessage({
      orgId,
      chatId: input.chatId,
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
      chatId: input.chatId,
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
    return true;
  });
  return { write, publish };
});

const hex = (value: string) =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

export const makeDeferralStarter = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;
  const cards = yield* makeDeferralCards;
  /**
   * Marks the run started and hands the work to the lead as `deferral.due`, inside the
   * caller's transaction. The event dedupes on the due fire id, so a replay, a late fire
   * and a [Start now] tap share one start. `at` is the fire's time, so a replay enqueues
   * the same event.
   */
  return Effect.fn("Deferrals.start")(function* (input: {
    readonly orgId: KinOrgId;
    readonly itemId: KinMemoryItemId;
    readonly dueAt: number;
    readonly card: KinDeferralCard;
    readonly provenance: KinAuthor;
    readonly at: number;
    readonly now: number;
    /** The run state the caller read in this transaction. */
    readonly from: string;
  }) {
    const { orgId, itemId, dueAt, at, now } = input;
    const [lead] = yield* sql<{ agentId: string }>`SELECT l.agent_id AS "agentId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
    if (lead === undefined) return false;
    const moved = yield* sql`UPDATE kin_deferral_runs SET state = 'started', updated_at = ${now}
      WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${dueAt}
        AND state = ${input.from} RETURNING item_id`;
    if (moved.length === 0) return false;
    const dedupeKey = deferralStartKey(itemId, dueAt);
    yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "deferral.due",
          eventId: KinEventId.make(`deferral_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`),
          orgId,
          agentId: KinAgentId.make(lead.agentId),
          receivedAt: iso(at),
          provenance: input.provenance,
          dedupeKey,
          subject: { type: "deferral", itemId, phase: "due" },
          lateByMs: Math.max(0, at - dueAt),
        }),
      )
      .pipe(
        // A start under this key from another path (tap vs fire) already handed the work over.
        Effect.catchTags({
          KinEventQueueConflict: Effect.fn("Deferrals.startConflict")(function* (conflict) {
            const [stored] = yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId"
              FROM kin_events WHERE org_id = ${orgId} AND dedupe_key = ${dedupeKey}
                AND tag = 'deferral.due' ORDER BY event_id`;
            if (stored === undefined) return yield* conflict;
            if (stored.agentId !== lead.agentId) {
              yield* Effect.logWarning("Kin deferral start went to another lead", {
                orgId,
                itemId,
                agentId: lead.agentId,
                storedAgentId: stored.agentId,
              });
              return yield* conflict;
            }
          }),
        }),
      );
    yield* cards.write({
      orgId,
      itemId,
      state: { ...input.card, text: `Started ${input.card.title}.`, phase: "started" },
      chatId: null,
      now,
    });
    return true;
  });
});

export class DeferralError extends Schema.TaggedError<DeferralError>()("DeferralError", {
  orgId: KinOrgId,
  cause: Schema.Defect(),
}) {}

const decodeCard = Schema.decodeUnknownEffect(KinDeferralCard);
const decodeAction = Schema.decodeUnknownEffect(
  Schema.Struct({ actionId: Schema.Literals(deferralCardActions), value: KinMemoryItemId }),
);
type DeferralAction = (typeof deferralCardActions)[number];
const actionsFor = (phase: KinDeferralCard["phase"]): ReadonlyArray<DeferralAction> =>
  phase === undefined
    ? ["change", "remind"]
    : phase === "started"
      ? []
      : ["start_now", "monday", "cancel"];

export class Deferrals extends Context.Service<
  Deferrals,
  {
    /**
     * Applies a verified owner tap on a deferral card. [Change] hands the item to the lead;
     * [Just remind me], [Monday] and [Cancel] stage memory writes; [Start now] starts.
     */
    readonly act: (
      orgId: KinOrgId,
      wakeupId: string,
      eventId: KinEventId,
    ) => Effect.Effect<
      {
        readonly chatId: KinChatId;
        readonly itemId: KinMemoryItemId;
        readonly action: DeferralAction;
        readonly due?: string;
      },
      DeferralError,
      MemoryWriter.MemoryWriter
    >;
  }
>()("t3/kin/triggers/deferrals") {}

const make = Effect.gen(function* () {
  const memory = yield* Memory.Memory;
  const cache = yield* MemoryCache.MemoryCache;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const start = yield* makeDeferralStarter;
  return Deferrals.of({
    act: Effect.fn("Deferrals.act")((orgId, wakeupId, eventId) =>
      Effect.gen(function* () {
        const writer = yield* MemoryWriter.MemoryWriter;
        const tap = yield* verifyOwnerTap(orgId, wakeupId, eventId, "deferral").pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Repository.KinChatRepository, repo),
        );
        const action = yield* decodeAction(tap.action);
        const card = yield* decodeCard(tap.widget.state);
        if (
          card.itemId !== action.value ||
          tap.widget.widgetId !== deferralWidgetId(orgId, card.itemId)
        )
          return yield* Effect.fail("unknown_item" as const);
        if (!actionsFor(card.phase).includes(action.actionId))
          return yield* Effect.fail("stale_card" as const);
        const result = { chatId: tap.chatId, itemId: card.itemId, action: action.actionId };
        if (action.actionId === "change") return result;
        const item = yield* memory.readItemQuietly(orgId, card.itemId);
        if (item.head.kind !== "deferral" || item.head.status !== "open")
          return yield* Effect.fail("not_open" as const);
        const { orgId: _org, path, ...frontMatter } = item.head;
        const stage = (fields: Partial<typeof frontMatter>) =>
          writer.stage(orgId, wakeupId, {
            path,
            content: `---\n${stringify({ ...frontMatter, ...fields })}---\n${item.body}`,
            sourceEventId: eventId,
          });
        switch (action.actionId) {
          case "remind":
            if (item.head.on_due !== "remind") yield* stage({ on_due: "remind" });
            return result;
          case "cancel":
            yield* stage({ status: "cancelled" });
            return result;
          case "monday": {
            const due = nextMondayDue(
              yield* Clock.currentTimeMillis,
              yield* cache.ownerTimeZone(orgId),
            );
            yield* stage({ due });
            return { ...result, due };
          }
          case "start_now": {
            const dueAt = Date.parse(card.dueAt);
            if (yield* (yield* KinDeferralStopSwitch).isStopped(orgId))
              return yield* Effect.fail("stopped" as const);
            if (!(yield* WorkerLaunchGate)) return yield* Effect.fail("workers_blocked" as const);
            const [lead] = yield* sql<{ level: string }>`SELECT l.level FROM kin_leads l
              JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
              WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
            if (lead === undefined || !startsAtLevel(lead.level))
              return yield* Effect.fail("below_l2" as const);
            const now = yield* Clock.currentTimeMillis;
            const started = yield* sql.withTransaction(
              Effect.gen(function* () {
                const [run] = yield* sql<{ state: string }>`SELECT state FROM kin_deferral_runs
                  WHERE org_id = ${orgId} AND item_id = ${card.itemId} AND due_at = ${dueAt}
                  ORDER BY item_id`;
                if (run === undefined || !["heads_up", "asked", "grace"].includes(run.state))
                  return false;
                return yield* start({
                  orgId,
                  itemId: card.itemId,
                  dueAt,
                  card,
                  provenance: tap.provenance,
                  at: now,
                  now,
                  from: run.state,
                });
              }),
            );
            if (!started) return yield* Effect.fail("not_pending" as const);
            return result;
          }
        }
      }).pipe(Effect.mapError((cause) => new DeferralError({ orgId, cause }))),
    ),
  });
});

export const layer = Layer.effect(Deferrals, make).pipe(Layer.provide(MemoryCache.layer));
