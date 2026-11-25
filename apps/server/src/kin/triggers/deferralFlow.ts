import {
  KinAgentId,
  KinChatId,
  KinDeferralCard,
  KinEvent,
  KinEventId,
  KinMemoryItemId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  type KinCardAsker,
  type KinReminderCard,
  type KinTriggerFired,
  type KinTriggerFireId,
  KinWidgetId,
  type MemoryItemHead,
  kinReminderWidgetId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { PersistenceDecodeError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Chat from "../chat/KinChatService.ts";
import { textLocale, type TextClock } from "../work/companyProfile.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as KinBudget from "../lead/KinBudget.ts";
import type * as KinLevels from "../lead/KinLevels.ts";
import * as LeadDelivery from "../lead/LeadDelivery.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { isOrgPaused } from "../lead/orgState.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import { readGithubLinks } from "./deferralGithub.ts";
import {
  askerOf,
  askersChat,
  cardChatFor,
  directChatWith,
  sharedChatOf,
  wordsReadable,
} from "./deferralOrigin.ts";
import {
  DeferralSnapshot,
  GRACE_MS,
  HEADS_UP_MS,
  LATE_NOTE_MS,
  KinDeferralStopSwitch,
  deferralTriggerId,
  lateNote,
  ownerDateTime,
  ownerTime,
  snapshotChanges,
  askText,
  decisionActions,
  deferralFingerprint,
  deferralLead,
  promiserLead,
  makeDeferralRedraw,
  deferredSectionOff,
  startsAtLevel,
  makeDeferralCards,
  makeDeferralStarter,
  hex,
} from "./deferrals.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as Pings from "./pings.ts";
import { KinPushSender } from "../push/KinPushSender.ts";
import { deliverHeld } from "./heldDelivery.ts";
import { settleDue } from "../questions/openQuestions.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";

export class KinDeferralFlowError extends Schema.TaggedError<KinDeferralFlowError>()(
  "KinDeferralFlowError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

export class KinDeferralFlow extends Context.Service<
  KinDeferralFlow,
  {
    /**
     * Consumes this org's pending deferral fires (recheck, heads-up, grace, start or ask),
     * then sweeps its pings so chases deliver once quiet hours end.
     */
    readonly drain: (orgId: KinOrgId) => Effect.Effect<void, KinDeferralFlowError>;
  }
>()("t3/kin/triggers/deferralFlow/KinDeferralFlow") {}

interface Run {
  readonly state: string;
  readonly dueAt: number | null;
  readonly onDue: string;
  readonly snapshot: string;
}
type Step =
  | { readonly kind: "drop" }
  | { readonly kind: "heads_up"; readonly dueAt: number }
  | { readonly kind: "due"; readonly dueAt: number; readonly grace: boolean };

/** Which step a fire takes, from its run row. Disarmed, moved and handled runs drop it. */
function classifyFire(
  run: Run | undefined,
  graceEndsAt: number | undefined,
  snoozedUntil: number | undefined,
  phase: "heads_up" | "due",
  fireAt: number,
  now: number,
): Step {
  if (run === undefined || run.state === "disarmed" || run.dueAt === null) return { kind: "drop" };
  const dueAt = run.dueAt;
  if (phase === "heads_up")
    return run.onDue === "start" &&
      run.state === "armed" &&
      fireAt === dueAt - HEADS_UP_MS &&
      now < dueAt
      ? { kind: "heads_up", dueAt }
      : { kind: "drop" };
  if (fireAt === dueAt)
    return run.state === "armed" || (run.onDue === "start" && run.state === "heads_up")
      ? { kind: "due", dueAt, grace: false }
      : { kind: "drop" };
  // A snoozed reminder re-arms its due trigger at the snooze's end.
  if (run.onDue === "remind" && run.state === "snoozed" && fireAt === snoozedUntil)
    return { kind: "due", dueAt, grace: false };
  // A late due fire re-arms the due trigger at the end of its grace window.
  return run.onDue === "start" && run.state === "grace" && fireAt === graceEndsAt
    ? { kind: "due", dueAt, grace: true }
    : { kind: "drop" };
}

const decodeOnDue = Schema.decodeUnknownEffect(KinDeferralCard.fields.onDue);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(DeferralSnapshot));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(DeferralSnapshot));
const isDecodeError = Schema.is(PersistenceDecodeError);
const isPermanent = (error: unknown) => {
  let current = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (Schema.isSchemaError(current) || isDecodeError(current)) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
};
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const SWEEP_EVERY_MS = 60_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const memory = yield* Memory.Memory;
  const cache = yield* MemoryCache.MemoryCache;
  const chat = yield* Chat.KinChatService;
  const pings = yield* Pings.KinPings;
  const ticks = yield* Scheduler.Scheduler;
  const cards = yield* makeDeferralCards;
  const start = yield* makeDeferralStarter;
  const redraw = yield* makeDeferralRedraw;
  const budget = yield* KinBudget.KinBudget;
  const deliveries = yield* LeadDelivery.KinLeadDelivery;
  const queue = yield* KinEventQueue.KinEventQueue;
  // A question's default that runs its own action writes through it (`settleDue`).
  const records = yield* Effect.serviceOption(KinRecords);
  // Task news held for a banner rings through it (`deliverHeld`).
  const push = Option.getOrUndefined(yield* Effect.serviceOption(KinPushSender));

  /**
   * Hands a due reminder to its lead, who writes it in its own voice; the server attaches the
   * card. Without a lead, budget or a running Kin, Kin posts its own line with the card at once.
   */
  const remind = Effect.fn("KinDeferralFlow.remind")(function* (input: {
    readonly orgId: KinOrgId;
    readonly itemId: KinMemoryItemId;
    readonly title: string;
    readonly fire: KinTriggerFired;
    readonly fireAt: number;
    readonly now: number;
    readonly clock: TextClock;
    /** Set when a wake-up can run now. */
    readonly lead:
      | {
          readonly agentId: KinAgentId;
          readonly ownerChatId: KinChatId;
          readonly origin: KinLevels.KinOrigin | undefined;
        }
      | undefined;
    readonly leadName: string | undefined;
    readonly fallbackChat: KinChatId | null;
    /** Set when someone set it in their own chat with the lead: Kin reminds them there. */
    readonly askersChat: { readonly chatId: KinChatId; readonly theirs: boolean } | undefined;
    /**
     * A shared chat's own (`sharedChatOf`): its lead writes it there. Once it can't (`moved`),
     * Kin's line goes to whoever asked, saying where it was meant for.
     */
    readonly inChat:
      | {
          readonly chatId: KinChatId;
          readonly askedBy: KinCardAsker | undefined;
          readonly moved: { readonly to: KinChatId; readonly why: string } | undefined;
          /** The chat's bare line, when someone there now couldn't read where it was set. */
          readonly bare: string | undefined;
          /** One bare line for the owner, when neither the chat nor the asker can be reached. */
          readonly owner: { readonly to: KinChatId; readonly body: string } | undefined;
        }
      | undefined;
  }) {
    const { orgId, itemId, title, fire, fireAt, now } = input;
    const card = {
      itemId,
      title,
      dueAt: iso(fireAt),
      status: "due",
    } as const satisfies KinReminderCard;
    const widgetId = KinWidgetId.make(kinReminderWidgetId(orgId, itemId, fireAt));
    const reminder = `Reminder: ${title}.${lateNote(fireAt, now, input.clock)}`;
    const fallbackBody = `${reminder} (${input.leadName ?? "Your agent"} couldn't write this one, so Kin sent it.)`;
    if (input.inChat !== undefined) {
      const { chatId, askedBy, moved, bare, owner } = input.inChat;
      const state = { ...card, ...(askedBy === undefined ? {} : { askedBy }) };
      if (bare !== undefined)
        yield* chat.notice({
          orgId,
          chatId,
          messageId: KinMessageId.make(`reminder-bare-${fire.fireId}`),
          audience: "chat",
          body: bare,
        });
      if (owner !== undefined)
        yield* chat.notice({
          orgId,
          chatId: owner.to,
          messageId: KinMessageId.make(`reminder-unreached-${fire.fireId}`),
          audience: "owner",
          body: owner.body,
        });
      if (bare !== undefined || owner !== undefined || moved !== undefined) {
        if (moved === undefined) return;
        yield* deliveries.fallback({
          orgId,
          eventId: KinEventId.make(`reminder-moved-${fire.fireId}`),
          kind: "reminder",
          agentId: KinAgentId.make("kin"),
          chatId: moved.to,
          widget: { widgetId, type: "reminder", state: card },
          fallbackBody: `${reminder} ${moved.why}`,
          deadlineAt: now,
          forChat: true,
        });
        return;
      }
      if (input.lead !== undefined) {
        const dedupeKey = fire.fireId;
        const eventId = KinEventId.make(`reminder_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`);
        const event = yield* decodeEvent({
          _tag: "deferral.due",
          eventId,
          orgId,
          agentId: input.lead.agentId,
          receivedAt: fire.firedAt,
          provenance: { _tag: "system" },
          dedupeKey,
          subject: { type: "reminder", itemId },
          lateByMs: Math.max(0, now - fireAt),
          origin: { agentId: input.lead.agentId, chatId },
          chatId,
        });
        yield* deliveries.handOff(event, {
          orgId,
          eventId,
          kind: "reminder",
          agentId: input.lead.agentId,
          chatId,
          widget: { widgetId, type: "reminder", state },
          fallbackBody,
          deadlineAt: now + LeadDelivery.DELIVERY_DEADLINE_MS.reminder,
        });
        return;
      }
      yield* deliveries.fallback({
        orgId,
        eventId: KinEventId.make(`reminder-fallback-${fire.fireId}`),
        kind: "reminder",
        agentId: KinAgentId.make("kin"),
        chatId,
        widget: { widgetId, type: "reminder", state: { ...state, fallback: true } },
        fallbackBody,
        deadlineAt: now,
        forChat: true,
      });
      return;
    }
    // The lead's wake-up answers in its owner's chat, so a teammate's own reminder is Kin's line.
    if (input.askersChat !== undefined) {
      const theirs = input.askersChat.theirs;
      yield* deliveries.fallback({
        orgId,
        eventId: KinEventId.make(`reminder-own-${fire.fireId}`),
        kind: "reminder",
        agentId: KinAgentId.make("kin"),
        chatId: input.askersChat.chatId,
        widget: { widgetId, type: "reminder", state: { ...card, theirs } },
        fallbackBody: reminder,
        deadlineAt: now,
        forChat: true,
      });
      return;
    }
    if (input.lead !== undefined) {
      const dedupeKey = fire.fireId;
      const eventId = KinEventId.make(`reminder_${hex(`${orgId.length}:${orgId}${dedupeKey}`)}`);
      const event = yield* decodeEvent({
        _tag: "deferral.due",
        eventId,
        orgId,
        agentId: input.lead.agentId,
        receivedAt: fire.firedAt,
        provenance: { _tag: "system" },
        dedupeKey,
        subject: { type: "reminder", itemId },
        lateByMs: Math.max(0, now - fireAt),
        ...(input.lead.origin === undefined ? {} : { origin: input.lead.origin }),
      });
      yield* deliveries.handOff(event, {
        orgId,
        eventId,
        kind: "reminder",
        agentId: input.lead.agentId,
        chatId: input.lead.ownerChatId,
        widget: { widgetId, type: "reminder", state: card },
        fallbackBody,
        deadlineAt: now + LeadDelivery.DELIVERY_DEADLINE_MS.reminder,
      });
      return;
    }
    if (input.fallbackChat === null) return;
    yield* deliveries.fallback({
      orgId,
      eventId: KinEventId.make(`reminder-fallback-${fire.fireId}`),
      kind: "reminder",
      agentId: KinAgentId.make("kin"),
      chatId: input.fallbackChat,
      widget: { widgetId, type: "reminder", state: { ...card, fallback: true } },
      fallbackBody,
      deadlineAt: now,
    });
  });
  // Per process: the 24 h give-up is the durable bound, so a restart only retries sooner.
  const retries = new Map<
    KinOrgId,
    Map<string, { readonly notBefore: number; readonly failures: number }>
  >();
  const sweptAt = new Map<KinOrgId, number>();

  const readRun = (orgId: KinOrgId, itemId: KinMemoryItemId) =>
    sql<Run>`SELECT state, due_at AS "dueAt", on_due AS "onDue", snapshot_json AS snapshot
      FROM kin_deferral_runs WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`.pipe(
      Effect.map((rows) => rows[0]),
    );
  /** The committed item with its body, which a decision card's fingerprint covers. */
  const readCommitted = (orgId: KinOrgId, itemId: KinMemoryItemId) =>
    memory.readItemQuietly(orgId, itemId, "triggers").pipe(
      Effect.map((item): { head: MemoryItemHead; body: string } | undefined => item),
      Effect.catchTags({
        MemoryNotFound: () => Effect.undefined,
        MemoryDuplicateId: () => Effect.undefined,
      }),
    );
  const readItem = (orgId: KinOrgId, itemId: KinMemoryItemId) =>
    memory.readItemQuietly(orgId, itemId, "triggers").pipe(
      Effect.map((item): MemoryItemHead | undefined => item.head),
      Effect.catchTags({
        MemoryNotFound: () => Effect.undefined,
        MemoryDuplicateId: () => Effect.undefined,
      }),
    );
  // The item's chat when it belongs to the org and was never shared, else an owner chat: the
  // owner chat of the lead it fires with once that chat was shared, else the first lead's.
  const cardChat = Effect.fn("KinDeferralFlow.cardChat")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead | undefined,
  ) {
    if (item?.chat !== undefined) {
      const lead = yield* promiserLead(sql, orgId, item);
      const chatId = yield* cardChatFor(sql, orgId, item.chat, lead?.ownerChatId ?? null);
      if (chatId !== null) return chatId;
    }
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    return lead === undefined ? null : lead.ownerChatId;
  });

  /** Whether the item asks a person here other than whoever asked for it. */
  const asksAnother = Effect.fn("KinDeferralFlow.asksAnother")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead,
  ) {
    if (item.owner === undefined || item.owner === item.said_by) return false;
    const [person] = yield* sql`SELECT 1 FROM kin_people WHERE org_id = ${orgId}
      AND handle = ${item.owner} AND removed_at IS NULL ORDER BY person_id LIMIT 1`;
    return person !== undefined;
  });

  /**
   * Where a shared chat's own reminder goes and who asked. Its words go to the chat only while
   * everyone reading it now could read where it was set (`wordsReadable`); else the chat gets a
   * bare line and the asker the reminder, in their own chat with a live agent. Gone, archived or
   * left by its agent: the asker alone; with no chat of theirs, the owner one bare line.
   */
  const inChatReminder = Effect.fn("KinDeferralFlow.inChatReminder")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead | undefined,
    chat: NonNullable<Effect.Success<ReturnType<typeof sharedChatOf>>>,
    clock: TextClock,
  ) {
    const askedBy = item === undefined ? undefined : yield* askerOf(sql, orgId, item.said_by);
    const readable =
      item?.source_event !== undefined && (yield* wordsReadable(sql, orgId, item.source_event));
    const base = {
      chatId: chat.chatId,
      askedBy,
      moved: undefined,
      bare: undefined,
      owner: undefined,
    };
    if (chat.open && readable) return base;
    const agent =
      chat.lead === undefined
        ? (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.agentId
        : chat.agentId;
    const theirs =
      askedBy === undefined || askedBy.left === true || agent === undefined
        ? undefined
        : yield* directChatWith(sql, orgId, askedBy.personId, agent);
    const name = askedBy?.left === true ? "Someone who has left" : (askedBy?.name ?? "Someone");
    const set =
      item === undefined ? "" : ` on ${ownerDateTime(Date.parse(item.recorded_at), clock)}`;
    if (chat.open)
      return {
        ...base,
        bare: `A reminder ${name} set${set} is due.`,
        moved:
          theirs === undefined
            ? undefined
            : {
                to: theirs,
                why: `${chat.name} got only that it is due: someone there now couldn't read where you set it.`,
              },
      };
    if (theirs !== undefined)
      return {
        ...base,
        moved: {
          to: theirs,
          why: `It was for ${chat.name}, which ${chat.lead?.name ?? "its agent"} can no longer post in.`,
        },
      };
    const lead = yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
    if (lead === undefined) return base;
    const [inRoom] = yield* sql`SELECT 1 FROM kin_chat_members WHERE org_id = ${orgId}
      AND chat_id = ${chat.chatId} AND principal_kind = 'person'
      AND person_id = ${lead.ownerPersonId} AND left_at IS NULL LIMIT 1`;
    return {
      ...base,
      owner: {
        to: lead.ownerChatId,
        body: `A reminder ${name} set${set}${inRoom === undefined ? "" : ` for ${chat.name}`} is due, but it couldn't reach them or that chat.`,
      },
    };
  });

  const prepareChase = Effect.fn("KinDeferralFlow.prepareChase")(function* (
    orgId: KinOrgId,
    item: MemoryItemHead,
    dueAt: number,
    clock: TextClock,
  ) {
    const handle = item.owner ?? item.said_by;
    const [person] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
      FROM kin_people WHERE org_id = ${orgId} AND handle = ${handle} ORDER BY person_id`;
    const owner = yield* promiserLead(sql, orgId, item);
    if (person === undefined || owner === undefined || item.chat === undefined)
      return `I couldn't chase ${handle}`;
    const put = yield* pings
      .put(
        {
          orgId,
          person: KinPersonId.make(person.personId),
          itemId: item.id,
          chatId: item.chat,
          owner: owner.ownerPersonId,
          ownerChatId: owner.ownerChatId,
          nextStep: `${item.title} was due ${ownerDateTime(dueAt, clock)}. What's the status?`,
        },
        item,
      )
      .pipe(Effect.result);
    if (put._tag === "Failure") {
      yield* Effect.logWarning("Kin deferral chase failed", { orgId, itemId: item.id });
      return `I couldn't chase ${handle}`;
    }
    return null;
  });

  const process = Effect.fn("KinDeferralFlow.process")(function* (
    orgId: KinOrgId,
    fire: KinTriggerFired,
    itemId: KinMemoryItemId,
    phase: "heads_up" | "due",
    now: number,
    clock: TextClock,
  ) {
    const fireAt = Date.parse(fire.dueAt);
    const run = yield* readRun(orgId, itemId).pipe(NodeSqliteClient.readOnly);
    const snapshot = run === undefined ? undefined : yield* decodeSnapshot(run.snapshot);
    const step = classifyFire(
      run,
      snapshot?.graceEndsAt,
      snapshot?.snoozedUntil,
      phase,
      fireAt,
      now,
    );
    if (step.kind === "drop" || run === undefined || snapshot === undefined)
      return yield* inbox.markConsumed(orgId, [fire.fireId]).pipe(Effect.as(false));

    // Read-only or idempotent I/O; a replay repeats it.
    const committed = yield* readCommitted(orgId, itemId);
    const item = committed?.head;
    const onDue = run.onDue;
    const decodedOnDue = yield* decodeOnDue(onDue);
    const gates: Array<string> = [];
    if (onDue === "start") {
      const github = yield* readGithubLinks(orgId, item?.links ?? snapshot.links);
      gates.push(...snapshotChanges(snapshot, item, github));
      if (yield* (yield* KinDeferralStopSwitch).isStopped(orgId))
        gates.push("Kin asks before every start for now");
    }
    // A reminder is the lead's to write when a wake-up can run; budget is read outside the writer.
    const chatOwn = onDue === "remind" ? yield* sharedChatOf(sql, orgId, item) : undefined;
    const inChat =
      chatOwn === undefined ? undefined : yield* inChatReminder(orgId, item, chatOwn, clock);
    const ownChat =
      onDue === "remind" && chatOwn === undefined ? yield* askersChat(sql, orgId, item) : undefined;
    const reminderLead =
      onDue === "remind" && ownChat === undefined
        ? chatOwn === undefined
          ? yield* deferralLead(sql, orgId, item)
          : inChat?.moved === undefined &&
              inChat?.bare === undefined &&
              inChat?.owner === undefined &&
              chatOwn.lead !== undefined
            ? { agentId: chatOwn.agentId, ...chatOwn.lead, origin: undefined }
            : undefined
        : undefined;
    const reminderAdmitted =
      reminderLead === undefined
        ? false
        : (yield* budget.admit(orgId, "P1").pipe(
            // Held for a limit: the owner hears it once a day, with what waits.
            Effect.tap((admission) =>
              admission.allowed ? Effect.void : budget.notifyOwner(orgId, "org"),
            ),
            Effect.map((admission) => admission.allowed),
            Effect.orElseSucceed(() => false),
          )) && !(yield* isOrgPaused(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)));
    // No memory or GitHub I/O below: the memory lock can wait on this writer.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (!(yield* KinTriggerInbox.fireOpen(sql, orgId, fire.fireId))) return false;
        const reasons = [...gates];
        const current = yield* readRun(orgId, itemId);
        // Moved or handled since the reads above: classify again on the next tick.
        if (
          current?.state !== run.state ||
          current.dueAt !== run.dueAt ||
          current.snapshot !== run.snapshot
        )
          return false;
        const dueAt = step.dueAt;
        const title = item?.title ?? itemId;
        if (
          yield* deferredSectionOff(orgId, title, item?.links).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          )
        ) {
          return "section_off" as const;
        }
        // A reminder never asks, so it needs no lead here.
        const lead = onDue === "remind" ? undefined : yield* deferralLead(sql, orgId, item);
        // A tap's start needs the item's chat and source event, which the run keeps from here on.
        const startable = item !== undefined && lead !== undefined;
        // What the card is drawn from: the links just checked and the committed work, which a
        // tap must still find (`deferralFingerprint`).
        const kept: DeferralSnapshot =
          committed === undefined
            ? snapshot
            : {
                ...snapshot,
                links: committed.head.links,
                source: {
                  ...(committed.head.chat === undefined ? {} : { chat: committed.head.chat }),
                  ...(committed.head.source_event === undefined
                    ? {}
                    : { sourceEvent: committed.head.source_event }),
                },
                drawn: { fingerprint: deferralFingerprint(committed) },
              };
        const card = (phase: KinDeferralCard["phase"], text: string, graceEndsAt?: number) => ({
          itemId,
          title,
          dueAt: iso(dueAt),
          onDue: decodedOnDue,
          text,
          phase,
          ...(graceEndsAt === undefined ? {} : { graceEndsAt: iso(graceEndsAt) }),
          actions: phase === "started" ? [] : decisionActions(startable),
          ...(lead === undefined ? {} : { agent: lead.name }),
        });
        const setState = Effect.fn("KinDeferralFlow.setState")(function* (
          state: string,
          next: DeferralSnapshot = kept,
        ) {
          const json = yield* encodeSnapshot(next);
          yield* sql`UPDATE kin_deferral_runs SET state = ${state}, snapshot_json = ${json},
              updated_at = ${now}
            WHERE org_id = ${orgId} AND item_id = ${itemId} AND due_at = ${dueAt}
              AND state = ${run.state}`;
        });
        const post = Effect.fn("KinDeferralFlow.post")(function* (state: KinDeferralCard) {
          const chatId = yield* cardChat(orgId, item);
          yield* cards.write({ orgId, itemId, state, chatId, now });
        });
        const ask = Effect.fn("KinDeferralFlow.ask")(function* (why: ReadonlyArray<string>) {
          yield* post(card("asked", askText({ dueAt, now, clock, startable, why })));
          yield* setState("asked");
        });

        if (onDue === "start") {
          if (lead === undefined) reasons.push("there is no active agent");
          else if (!startsAtLevel(lead.level)) reasons.push("starting work isn't open to me here");
        }

        if (step.kind === "heads_up") {
          if (reasons.length > 0) yield* ask(reasons);
          else {
            yield* post(card("heads_up", `Starting ${title} at ${ownerTime(dueAt, now, clock)}.`));
            yield* setState("heads_up");
          }
        } else if (onDue === "start") {
          const anchor = step.grace ? fireAt : dueAt;
          const late = now - anchor;
          if (late > GRACE_MS) yield* ask([...reasons, "it's more than 30 minutes late"]);
          else if (reasons.length > 0) yield* ask(reasons);
          else if (!step.grace && (run.state === "armed" || late > LATE_NOTE_MS)) {
            // No heads-up was shown, or it was shown too long ago: give the grace from now.
            const graceEnd = now + GRACE_MS;
            yield* post(
              card(
                "heads_up",
                `Starting ${title} at ${ownerTime(graceEnd, now, clock)}.${lateNote(dueAt, now, clock)}`,
                graceEnd,
              ),
            );
            yield* sql`UPDATE kin_triggers SET next_run_at = ${graceEnd},
              updated_at = max(updated_at, ${now})
              WHERE org_id = ${orgId} AND trigger_id = ${deferralTriggerId(itemId, "due")}
                AND enabled = 1`;
            yield* setState("grace", { ...kept, graceEndsAt: graceEnd });
          } else {
            const started = yield* start({
              orgId,
              itemId,
              dueAt,
              card: card("started", ""),
              provenance: { _tag: "system" },
              at: Date.parse(fire.firedAt),
              now,
              from: run.state,
              item,
            });
            if (!started) return false;
          }
        } else if (onDue === "ask") {
          // A promise to ask someone else: its lead asks them itself. Asking the asker is a card.
          const started =
            item !== undefined &&
            (yield* asksAnother(orgId, item)) &&
            (yield* start({
              orgId,
              itemId,
              dueAt,
              card: card("started", ""),
              provenance: { _tag: "system" },
              at: Date.parse(fire.firedAt),
              now,
              from: run.state,
              item,
            }));
          if (!started) yield* ask([]);
        } else if (onDue === "chase") {
          // Inside the transaction, so a chased run always has its ping row.
          const failure =
            item === undefined
              ? "the item is gone"
              : yield* prepareChase(orgId, item, dueAt, clock);
          if (failure !== null) yield* ask([failure]);
          else {
            yield* setState("chased");
            yield* inbox.markConsumed(orgId, [fire.fireId]);
            return true;
          }
        } else {
          yield* remind({
            orgId,
            itemId,
            title,
            fire,
            fireAt,
            now,
            clock,
            lead: reminderAdmitted ? reminderLead : undefined,
            leadName: reminderLead?.name,
            fallbackChat: reminderLead?.ownerChatId ?? (yield* cardChat(orgId, item)),
            askersChat: ownChat,
            inChat,
          });
          yield* setState("reminded");
        }
        yield* inbox.markConsumed(orgId, [fire.fireId]);
        return false;
      }),
    );
  });

  // Best effort: the owner hears about a deferral Kin gave up on.
  const noticeFailure = Effect.fn("KinDeferralFlow.noticeFailure")(function* (
    orgId: KinOrgId,
    fire: KinTriggerFired,
    itemId: KinMemoryItemId,
    clock: TextClock,
  ) {
    const run = yield* readRun(orgId, itemId);
    if (run === undefined || !["start", "ask", "chase"].includes(run.onDue)) return;
    const chatId = yield* cardChat(orgId, undefined);
    if (chatId === null) return;
    const title = (yield* readItem(orgId, itemId))?.title ?? itemId;
    const dueAt = run.dueAt ?? Date.parse(fire.dueAt);
    yield* chat.notice({
      orgId,
      chatId,
      messageId: KinMessageId.make(`deferral-failed:${orgId}:${fire.fireId}`),
      audience: "owner",
      body: `I couldn't handle the deferral ${title} due ${ownerDateTime(dueAt, clock)}.`,
    });
  });

  /**
   * Decision cards drawn before taps bound to their item (no fingerprint): drawn again from the
   * committed item with a new revision, so their taps work and an old revision gains none.
   */
  const redrawUnbound = Effect.fn("KinDeferralFlow.redrawUnbound")(function* (
    orgId: KinOrgId,
    now: number,
    clock: TextClock,
  ) {
    const rows = yield* sql<{ itemId: string }>`SELECT item_id AS "itemId" FROM kin_deferral_runs
      WHERE org_id = ${orgId} AND state IN ('asked', 'heads_up', 'grace')
        AND json_extract(snapshot_json, '$.drawn') IS NULL ORDER BY item_id`;
    for (const row of rows) {
      const itemId = KinMemoryItemId.make(row.itemId);
      const committed = yield* readCommitted(orgId, itemId);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const run = yield* readRun(orgId, itemId);
          if (run === undefined || run.dueAt === null) return;
          const snapshot = yield* decodeSnapshot(run.snapshot);
          if (snapshot.drawn !== undefined || !["asked", "heads_up", "grace"].includes(run.state))
            return;
          yield* redraw({
            orgId,
            itemId,
            run: {
              state: run.state,
              dueAt: run.dueAt,
              onDue: yield* decodeOnDue(run.onDue),
              snapshot,
            },
            item: committed,
            why: [],
            clock,
            now,
          });
        }),
      );
    }
  });

  const drain = Effect.fn("KinDeferralFlow.drain")(
    function* (orgId: KinOrgId) {
      const now = yield* Clock.currentTimeMillis;
      let chased = false;
      // The only pings sweeper: chases and their day-two escalations deliver from here.
      const sweep = Effect.suspend(() => {
        const last = sweptAt.get(orgId);
        if (!chased && last !== undefined && now - last < SWEEP_EVERY_MS) return Effect.void;
        sweptAt.set(orgId, now);
        return pings.sweep(orgId).pipe(
          Effect.catch((cause) => Effect.logWarning("Kin pings sweep failed", { orgId, cause })),
          // Lines held through someone's quiet hours post once those end.
          Effect.andThen(
            deliverHeld(orgId, chat, push).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catch((cause) =>
                Effect.logWarning("Kin held lines not delivered", { orgId, cause }),
              ),
            ),
          ),
          // Open questions whose day came: a default taken, or raised once more, once each.
          Effect.andThen(
            settleDue(orgId, now, { chat, queue, records: Option.getOrUndefined(records) }).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catch((cause) =>
                Effect.logWarning("Kin open questions not settled", { orgId, cause }),
              ),
            ),
          ),
        );
      });
      yield* Effect.gen(function* () {
        const clock = {
          zone: yield* cache.ownerTimeZone(orgId),
          locale: yield* textLocale(orgId).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        };
        yield* redrawUnbound(orgId, now, clock).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin couldn't redraw an older deferral card", { orgId, cause }),
          ),
        );
        const orgRetries = retries.get(orgId) ?? new Map();
        retries.set(orgId, orgRetries);
        const unseenRetries = new Set(orgRetries.keys());
        let remaining = 100;
        let after: KinTriggerFireId | undefined;
        while (remaining > 0) {
          const limit = remaining;
          const fires = yield* inbox.listPending(orgId, limit, "deferral", undefined, after);
          // Catch-up fires share received_at; handle them by due time.
          for (const fire of fires.toSorted(
            (a, b) =>
              Date.parse(a.dueAt) - Date.parse(b.dueAt) ||
              (a.fireId < b.fireId ? -1 : a.fireId > b.fireId ? 1 : 0),
          )) {
            unseenRetries.delete(fire.fireId);
            remaining--;
            if (fire.payload.kind !== "time" || fire.payload.subject.type !== "deferral") continue;
            const { itemId, phase } = fire.payload.subject;
            const retry = orgRetries.get(fire.fireId);
            const giveUp = now - Date.parse(fire.dueAt) > GIVE_UP_MS;
            if (retry !== undefined && now < retry.notBefore && !giveUp) continue;
            const result = yield* process(orgId, fire, itemId, phase, now, clock).pipe(
              Effect.tap((put) =>
                Effect.sync(() => {
                  orgRetries.delete(fire.fireId);
                  if (put === true) chased = true;
                }),
              ),
              Effect.mapError((cause) =>
                isSqlError(cause) ? toPersistenceSqlError("KinDeferralFlow.drain")(cause) : cause,
              ),
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  const consume = isPermanent(cause) || giveUp;
                  const failures = (retry?.failures ?? 0) + 1;
                  yield* (consume || failures === 1 ? Effect.logWarning : Effect.logDebug)(
                    "Kin deferral fire processing failed",
                    {
                      orgId,
                      fireId: fire.fireId,
                      cause,
                      failures,
                      disposition: consume ? "consumed" : "retry",
                    },
                  );
                  if (!consume) {
                    const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
                    orgRetries.set(fire.fireId, { notBefore: now + delay, failures });
                    return;
                  }
                  orgRetries.delete(fire.fireId);
                  yield* noticeFailure(orgId, fire, itemId, clock).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Kin deferral failure notice failed", {
                        orgId,
                        fireId: fire.fireId,
                        cause,
                      }),
                    ),
                  );
                  yield* inbox.markConsumed(orgId, [fire.fireId]);
                }),
              ),
            );
            if (result === "section_off") remaining++;
          }
          if (fires.length < limit) {
            for (const fireId of unseenRetries) orgRetries.delete(fireId);
            break;
          }
          after = fires.at(-1)?.fireId;
        }
      }).pipe(Effect.ensuring(sweep));
    },
    (effect, orgId) =>
      effect.pipe(Effect.mapError((cause) => new KinDeferralFlowError({ orgId, cause }))),
  );

  yield* ticks.register(
    "kin-deferrals",
    Effect.gen(function* () {
      // Scheduler maintenance scans organizations; each drain is org-scoped.
      const orgs = yield* sql<{ orgId: string }>`SELECT org_id AS "orgId" FROM kin_orgs
        ORDER BY org_id`;
      for (const { orgId } of orgs)
        yield* drain(KinOrgId.make(orgId)).pipe(
          Effect.catch((cause) => Effect.logWarning("Kin deferral tick failed", { orgId, cause })),
        );
    }).pipe(Effect.catch((cause) => Effect.logWarning("Kin deferral scan failed", { cause }))),
  );
  return KinDeferralFlow.of({ drain });
});

export const layer = Layer.effect(KinDeferralFlow, make).pipe(
  Layer.provide(Pings.layer),
  Layer.provide(MemoryCache.layer),
);
