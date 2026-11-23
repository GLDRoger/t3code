import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import {
  type KinAuthor,
  KinChatId,
  KinDeferralCard,
  type KinDeferralCardAction,
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinTriggerId,
  type KinWakeupId,
  KinWidgetId,
  type MemoryItemHead,
  kinDeferralWidgetId,
  formatKinWhen,
  kinWhenParts,
} from "@t3tools/contracts";
import * as KinShell from "../shell/KinShell.ts";
import { looksLikeRecordReference, resolveSections } from "../shell/sections.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous fingerprint hash.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinChatHub } from "../chat/KinChatHub.ts";
import type { TextClock } from "../work/companyProfile.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { cardAudience } from "../lead/LeadDelivery.ts";
import { type DeferralSource, firingOrigin } from "./deferralOrigin.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import { GithubLinkState, githubRef } from "./deferralGithub.ts";

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
export const deferralWidgetId = kinDeferralWidgetId;
/** The due fire's id: starting is keyed by it, so taps and replays share one start. */
const deferralStartKey = (itemId: string, dueAt: number, restarts = 0) =>
  `${deferralTriggerId(itemId, "due")}:${dueAt}${restarts === 0 ? "" : `:${restarts}`}`;

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
    item.every === undefined &&
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
  /** The re-armed due fire's instant while a reminder is `snoozed`. */
  snoozedUntil: Schema.optional(Schema.Number),
  /** The item's chat and source event, kept when its decision card is posted, for [Start now]. */
  source: Schema.optional(
    Schema.Struct({ chat: Schema.optional(KinChatId), sourceEvent: Schema.optional(KinEventId) }),
  ),
  /** The due time memory still holds after a [Monday] tap moved the run. */
  movedFrom: Schema.optional(Schema.Number),
  /** The committed item a decision card was drawn from (`deferralFingerprint`); taps bind to it. */
  drawn: Schema.optional(Schema.Struct({ fingerprint: Schema.String })),
  /** Starts a changed item dropped before their turn; each new start takes its own key. */
  restarts: Schema.optional(Schema.Number),
});
export type DeferralSnapshot = typeof DeferralSnapshot.Type;

/** The work a committed deferral hands off: what it does, its body, links, due, mode and status. */
export const deferralFingerprint = (item: {
  readonly head: MemoryItemHead;
  readonly body: string;
}) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        item.head.title,
        item.head.what ?? null,
        item.body,
        item.head.links,
        item.head.due,
        item.head.on_due ?? null,
        item.head.status,
        item.head.invalid_at,
        item.head.superseded_by,
      ]),
    )
    .digest("hex");
/** Whether a committed item still stands as an open deferral a tap may act on. */
export const deferralOpen = (head: MemoryItemHead) =>
  head.kind === "deferral" &&
  head.status === "open" &&
  head.invalid_at === null &&
  head.superseded_by === null;
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

// Starts ask first until LEAD-11's stop switch exists (`KinDeferralStopSwitch`).
const then: Record<OnDue, string> = {
  start: "I'll ask you to start it then.",
  remind: "I'll remind you then.",
  ask: "I'll ask you then.",
  chase: "I'll chase it then.",
};

export function confirmText(dueAt: number, onDue: OnDue, clock: TextClock): string {
  return `Deferred to ${ownerDateTime(dueAt, clock)}. ${then[onDue]}`;
}

/** Owner-local "Fri 13 Nov, 09:00", on the company's clock. */
export function ownerDateTime(at: number, clock: TextClock): string {
  return formatKinWhen(at, "dayTime", clock);
}

/** Owner-local "09:00", with the day when it isn't today. */
export function ownerTime(at: number, now: number, clock: TextClock): string {
  return kinWhenParts(at, clock.zone).isoDay === kinWhenParts(now, clock.zone).isoDay
    ? formatKinWhen(at, "time", clock)
    : ownerDateTime(at, clock);
}

export const lateNote = (dueAt: number, now: number, clock: TextClock) =>
  now - dueAt > LATE_NOTE_MS ? ` This was due at ${ownerTime(dueAt, now, clock)}.` : "";

/** Next Monday 09:00 owner time, strictly after today, as a front-matter date-time. */
export function nextMondayDue(now: number, timeZone: string): string {
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
// silence never starts work. A person's own [Start now] is not silence: it doesn't read this.
export const KinDeferralStopSwitch = Context.Reference<{
  readonly isStopped: (orgId: KinOrgId) => Effect.Effect<boolean>;
}>("t3/kin/triggers/deferrals/KinDeferralStopSwitch", {
  defaultValue: () => ({ isStopped: () => Effect.succeed(true) }),
});

/** The lead level work may start at by itself; an owner-level person's own [Start now] needs none. */
export const startsAtLevel = (level: string) => level === "L2" || level === "L3";

/** What a deferral's due work is traced back by: the chat it names and the event it came from. */

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

/**
 * The lead a deferral's due work goes to: its chat's lead, else the chief of staff, else the first
 * lead. Its level is the one in its owner's direct chat, where a `deferral.due` wake-up runs,
 * capped by the chat the deferral was asked from.
 */
export const deferralLead = Effect.fn("Deferrals.lead")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  item: DeferralSource | undefined,
) {
  const lead = yield* liveLead(sql, orgId, { chatId: item?.chat, prefer: CHIEF_OF_STAFF_DOMAIN });
  if (lead === undefined) return undefined;
  const origin = yield* firingOrigin(sql, orgId, item, lead);
  const level = yield* KinLevels.effectiveLevel({
    orgId,
    agentId: lead.agentId,
    chatId: lead.ownerChatId,
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchTags({ KinLevelRefused: () => Effect.undefined }),
  );
  if (level === undefined) return undefined;
  const asked =
    origin === undefined
      ? level
      : yield* KinLevels.originLevel(orgId, origin).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
  return { ...lead, origin, level: KinLevels.lowest(level, asked) };
});

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
        audience: cardAudience(state),
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
      audience: cardAudience(state),
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
    yield* repo.insertWidget({ ...widget, audience: cardAudience(state) });
    // The insert links the message to the card; clients only attach a card through that link.
    yield* publish({ type: "message.posted", orgId, message: { ...message, widgetId } });
    yield* publish({ type: "widget.updated", orgId, widget: { ...widget, revision: 1 } });
    return true;
  });
  return { write, publish };
});

export const hex = (value: string) =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

export const deferredSectionOff = Effect.fn("Deferrals.sectionOff")(function* (
  orgId: KinOrgId,
  title: string,
  links: ReadonlyArray<string> = [],
) {
  const mentioned =
    title.match(
      /(?<![\w/-])(?:[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}|[A-Z0-9-]+(?:\/[A-Z0-9-]+)+)(?![\w/-])/gi,
    ) ?? [];
  const references = new Set([
    ...links.map((value) => value.trim()).filter((value) => looksLikeRecordReference(value, true)),
    ...mentioned.filter((value) => looksLikeRecordReference(value)),
  ]);
  if (references.size === 0) return false;
  const shell = yield* KinShell.get(orgId);
  if (shell.sections.every(({ on }) => on)) return false;
  const sectionOfReference = yield* resolveSections(orgId, references, KIN_OWNER_LEVEL);
  return [...references].some((reference) => {
    const section = sectionOfReference(reference);
    return section !== null && !KinShell.sectionOn(shell, section);
  });
});

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
    /** The item: its chat's lead gets the work, capped by where it was asked from. */
    readonly item: (DeferralSource & { readonly links?: ReadonlyArray<string> }) | undefined;
    /** A start after a dropped one (`DeferralSnapshot.restarts`). */
    readonly restarts?: number;
  }) {
    const { orgId, itemId, dueAt, at, now } = input;
    if (
      yield* deferredSectionOff(orgId, input.card.title, input.item?.links).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      )
    )
      return false;
    const lead = yield* liveLead(sql, orgId, {
      chatId: input.item?.chat,
      prefer: CHIEF_OF_STAFF_DOMAIN,
    });
    if (lead === undefined) return false;
    const origin = yield* firingOrigin(sql, orgId, input.item, lead);
    // The turn that set it up: what it does when due answers whoever asked there.
    const asked =
      input.item?.source_event === undefined
        ? []
        : yield* sql<{ wakeupId: KinWakeupId }>`SELECT wakeup_id AS "wakeupId" FROM kin_events
            WHERE org_id = ${orgId} AND event_id = ${input.item.source_event}
              AND wakeup_id IS NOT NULL ORDER BY event_id`;
    const moved = yield* sql`UPDATE kin_deferral_runs SET state = 'started', updated_at = ${now}
      WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${dueAt}
        AND state = ${input.from} RETURNING item_id`;
    if (moved.length === 0) return false;
    const dedupeKey = deferralStartKey(itemId, dueAt, input.restarts);
    yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "deferral.due",
          eventId: KinEventId.make(`deferral_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`),
          orgId,
          agentId: lead.agentId,
          receivedAt: iso(at),
          provenance: input.provenance,
          dedupeKey,
          subject: { type: "deferral", itemId, phase: "due" },
          lateByMs: Math.max(0, at - dueAt),
          ...(origin === undefined ? {} : { origin }),
          ...(asked.length === 0 ? {} : { askedIn: asked.map((row) => row.wakeupId) }),
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
      // Its turn may still wait on the day's budget, so the card says who was asked, not that it ran.
      state: {
        ...input.card,
        text: `Asked ${lead.name} to start it.`,
        phase: "started",
        actions: [],
        agent: lead.name,
      },
      chatId: null,
      now,
    });
    return true;
  });
});

/** The asked card's words: what a tap does, and why Kin won't or can't start it itself. */
export function askText(input: {
  readonly title: string;
  readonly dueAt: number;
  readonly now: number;
  readonly clock: TextClock;
  readonly startable: boolean;
  readonly why: ReadonlyArray<string>;
}): string {
  const taps = input.startable
    ? "Tap Start now to start it, Monday to move it, or Cancel."
    : "Tap Monday to move it, or Cancel.";
  const reason =
    input.why.length === 0
      ? ""
      : input.startable
        ? ` I won't start it on my own: ${input.why.join("; ")}.`
        : ` I can't start it now: ${input.why.join("; ")}.`;
  return `${input.title} is due at ${ownerTime(input.dueAt, input.now, input.clock)}. ${taps}${reason}${lateNote(input.dueAt, input.now, input.clock)}`;
}

/** Whether an agent is paused: a person's [Start now] never queues work for it then. */
export const agentPaused = Effect.fn("Deferrals.agentPaused")(function* (
  sql: SqlClient.SqlClient,
  orgId: KinOrgId,
  agentId: string,
) {
  const rows = yield* sql`SELECT 1 FROM kin_agents WHERE org_id = ${orgId} AND agent_id = ${agentId}
    AND paused_at IS NOT NULL`;
  return rows.length > 0;
});

/**
 * Draws a pending run's decision card again from its committed item, with a new revision: the
 * run asks, keeps the item's chat, source event, links and fingerprint, and lists the taps it can
 * take. A gone or closed item closes the card instead. In the caller's transaction; no memory I/O.
 */
export const makeDeferralRedraw = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Repository.KinChatRepository;
  const cards = yield* makeDeferralCards;
  const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DeferralSnapshot));
  return Effect.fn("Deferrals.redraw")(function* (input: {
    readonly orgId: KinOrgId;
    readonly itemId: KinMemoryItemId;
    readonly run: {
      readonly state: string;
      readonly dueAt: number;
      readonly onDue: KinDeferralCard["onDue"];
      readonly snapshot: DeferralSnapshot;
    };
    readonly item: { readonly head: MemoryItemHead; readonly body: string } | undefined;
    readonly why: ReadonlyArray<string>;
    readonly clock: TextClock;
    readonly now: number;
  }) {
    const { orgId, itemId, run, item, now } = input;
    const widgetId = KinWidgetId.make(deferralWidgetId(orgId, itemId));
    if (item === undefined || !deferralOpen(item.head)) {
      const existing = yield* repo.getWidget({ orgId, widgetId });
      if (Option.isNone(existing) || existing.value.closedAt !== null) return;
      const at = iso(now);
      const widget = yield* repo.updateWidget({
        ...existing.value,
        // Closing writes no words.
        audience: "chat",
        expectedRevision: existing.value.revision,
        closedAt: at,
        updatedAt: at,
      });
      return yield* cards.publish({ type: "widget.updated", orgId, widget });
    }
    const lead = yield* deferralLead(sql, orgId, item.head);
    const snapshot: DeferralSnapshot = {
      ...run.snapshot,
      links: item.head.links,
      source: {
        ...(item.head.chat === undefined ? {} : { chat: item.head.chat }),
        ...(item.head.source_event === undefined ? {} : { sourceEvent: item.head.source_event }),
      },
      drawn: { fingerprint: deferralFingerprint(item) },
      ...(run.state === "started" ? { restarts: (run.snapshot.restarts ?? 0) + 1 } : {}),
    };
    const { graceEndsAt: _grace, ...kept } = snapshot;
    const json = yield* encodeSnapshot(kept);
    yield* sql`UPDATE kin_deferral_runs SET state = 'asked', snapshot_json = ${json},
        updated_at = ${now}
      WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${run.dueAt}
        AND state = ${run.state}`;
    const startable = lead !== undefined;
    yield* cards.write({
      orgId,
      itemId,
      state: {
        itemId,
        title: item.head.title,
        dueAt: iso(run.dueAt),
        onDue: run.onDue,
        text: askText({
          title: item.head.title,
          dueAt: run.dueAt,
          now,
          clock: input.clock,
          startable,
          why: lead === undefined ? [...input.why, "there is no active agent"] : input.why,
        }),
        phase: "asked",
        actions: decisionActions(startable),
        ...(lead === undefined ? {} : { agent: lead.name }),
      },
      chatId: null,
      now,
    });
  });
});

/** What a decision card offers: [Start now] only when the tap has what a start needs. */
export const decisionActions = (startable: boolean): ReadonlyArray<KinDeferralCardAction> =>
  startable ? ["start_now", "monday", "cancel"] : ["monday", "cancel"];
