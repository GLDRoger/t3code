import {
  CommandId,
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KinChatId,
  KinMessageId,
  MessageId,
  type KinAgentId,
  type KinOrgId,
  type KinPresenceState,
  type KinWakeupId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  KinChatService,
  KIN_WAKEUP_CHAR_LIMIT,
  KIN_WAKEUP_MESSAGE_LIMIT,
} from "../chat/KinChatService.ts";
import { KinIdentity, rescueMessageId, type AgentIdentity } from "../chat/KinIdentity.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import {
  classifySegment,
  cutLabel,
  draftReplyText,
  isEndCall,
  isToolItem,
  NOTE_MAX_CHARS,
  PHASE_LABELS,
  stripTrailingSilenceMarker,
  toolLabel,
  type SegmentNext,
} from "./classify.ts";
import { KinPresence, syncQueued } from "./KinPresence.ts";

/** One rescue turn asks for the reply the run owed; its text is posted like any other. */
const RESCUE_PROMPT =
  "You ended without replying to the owner. Write your reply now as plain text.";
export { rescueMessageId };
/** No turn-item or provider-turn update for this long shows the owner a stall and Stop. */
const STALL_MS = 120_000;
/** A streaming segment this old becomes a visible draft even while still short. */
const DRAFT_AFTER_MS = 1_000;
const RESCUE_TIMEOUT_MS = 120_000;
const OVERFLOW_SUFFIX = "\n\n…more in the lead's thread";

/**
 * Where a wake-up's text goes. One wake-up answers one chat: the chat of its highest-priority
 * human message or card tap, else (a notice wake-up) the lead's direct chat with its owner.
 */
export type Lane = {
  readonly chatId: KinChatId;
  readonly mode: "reply" | "notice";
  readonly leadName: string;
};

export type FailedOutcome = "partway" | "retrying" | "gave_up";
// Plain words with the lead's name: the inbox shows this as the chat's latest line.
const failedNotices: Record<FailedOutcome, { prefix: string; body: (lead: string) => string }> = {
  partway: { prefix: "kin-partway", body: (lead) => `${lead} stopped partway.` },
  retrying: {
    prefix: "kin-retrying",
    body: (lead) => `${lead} couldn't start. Trying again in a moment.`,
  },
  gave_up: {
    prefix: "kin-failed",
    body: (lead) => `${lead} couldn't start. It won't try again on its own.`,
  },
};

type Outcome = "posted" | "note" | "silent" | "empty" | "withheld" | "overflow" | "dropped";
type Segment = {
  readonly id: TurnItemId;
  ordinal: number;
  text: string;
  complete: boolean;
  firstSeenAt: number;
  drafting: boolean;
  outcome: Outcome | null;
};
type Wake = {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly wakeupId: KinWakeupId;
  readonly threadId: ThreadId;
  readonly startedAt: number;
  // A message steered into a notice wake-up makes it owe a reply in the same chat.
  lane: Lane;
  readonly lock: Semaphore.Semaphore;
  readonly segments: Map<TurnItemId, Segment>;
  // Ordinals of tool items seen live, to decide a short segment once the next item lands.
  readonly tools: Array<number>;
  readonly notes: Array<Segment>;
  readonly overflow: Array<string>;
  posted: number;
  chars: number;
  // A segment of this wake-up reached the chat, or will with the overflow.
  replied: boolean;
  // Ordinal of the first kin_end call.
  endedAt: number | null;
  // A post or withheld segment answered the lane, or nothing could have.
  answered: boolean;
  lastOutputAt: number;
  state: KinPresenceState;
  label: string | null;
  // What a stall interrupted, so the line returns to it when output resumes.
  live: { readonly state: KinPresenceState; readonly label: string | null };
  // The highest item ordinal seen live: only the latest tool's end turns the line to Thinking.
  latest: number;
  since: number;
  stall: Fiber.Fiber<void> | undefined;
  // What the line reads once the model has the turn: its files, when the message brought some.
  readonly opening: string;
  // What the line's timer counts from: the wake-up's start, then each posted reply.
  timerFrom: number;
  // The reply is settled or the wake-up ended: nothing may show a line for it again.
  done: boolean;
  // Latency stages already stamped on the wake-up row.
  stamped: Set<"first_token_at" | "posted_at">;
};

export class KinReplyBridge extends Context.Service<
  KinReplyBridge,
  {
    /** Read once the wake-up's events are claimed. */
    readonly lane: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
    }) => Effect.Effect<Option.Option<Lane>>;
    /** A wake-up claimed its events and is preparing: its lane reads "Catching up". */
    readonly preparing: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly startedAt: number;
    }) => Effect.Effect<void>;
    /** Starts mirroring the wake-up's thread into its lane. Call before its run starts. */
    readonly begin: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly threadId: ThreadId;
      readonly startedAt: number;
      /** The messages it answers brought files: the line says it is looking at them. */
      readonly attachments?: boolean;
    }) => Effect.Effect<void>;
    /**
     * After the wake-up's run ends: posts what the live stream did not, then, when the lane
     * still owes a reply and `rescue` is set, one rescue turn and finally an honest notice.
     */
    readonly complete: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly projectId: ProjectId;
      readonly rootRunId: RunId;
      readonly rescueUntil: number | null;
    }) => Effect.Effect<void>;
    /** A message was steered into the wake-up: re-reads its lane, which may now owe a reply. */
    readonly steered: (orgId: KinOrgId, wakeupId: KinWakeupId) => Effect.Effect<void>;
    /**
     * The wake-up failed, in the lane read before the queue closed it: `partway` after
     * something visible (not retried), `retrying` when it showed nothing and will run again,
     * `gave_up` when that was its last try.
     */
    readonly failed: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly outcome: FailedOutcome;
    }) => Effect.Effect<void>;
    /** Clears the wake-up's line; a queue line stays, or comes back, where a message still waits. */
    readonly end: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/reply/KinReplyBridge") {}

const textOf = (
  item: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>,
  projection?: OrchestrationV2ThreadProjection,
) =>
  item.textOmitted === true
    ? (projection?.messages.find((message) => message.id === item.messageId)?.text ?? item.text)
    : item.text;
const normalized = (text: string) => text.trim().replace(/\s+/g, " ");
const capBody = (text: string) =>
  text.length <= KIN_MESSAGE_BODY_MAX_LENGTH
    ? text
    : `${text.slice(0, KIN_MESSAGE_BODY_MAX_LENGTH - OVERFLOW_SUFFIX.length)}${OVERFLOW_SUFFIX}`;

/** The lane of a running wake-up, from its stored events; `kin_ask` posts its card there too. */
export const laneFor = Effect.fn("KinReplyBridge.lane")(
  function* (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const [lead] = yield* sql<{ ownerChatId: string; name: string }>`
      SELECT owner_chat_id AS "ownerChatId", name FROM kin_leads
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} ORDER BY agent_id`;
    const [human] = yield* sql<{ chatId: string | null }>`
      SELECT json_extract(json, '$.chatId') AS "chatId" FROM kin_events
      WHERE org_id = ${input.orgId} AND agent_id = ${input.agentId} AND wakeup_id = ${input.wakeupId}
        AND tag IN ('chat.message', 'widget.action', 'chat.reaction')
      ORDER BY priority, received_at, event_id LIMIT 1`;
    const chatId = human?.chatId ?? lead?.ownerChatId;
    if (chatId === undefined || chatId === null) return Option.none<Lane>();
    return Option.some<Lane>({
      chatId: KinChatId.make(chatId),
      mode: human?.chatId === undefined || human.chatId === null ? "notice" : "reply",
      leadName: lead?.name ?? "Lead",
    });
  },
  Effect.catchCause((cause) =>
    Effect.logWarning("Kin reply lane unavailable", { cause }).pipe(Effect.as(Option.none<Lane>())),
  ),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const gate = yield* KinLevelGate;
  const chat = yield* KinChatService;
  const identity = yield* KinIdentity;
  const presence = yield* KinPresence;
  const writer = yield* Effect.serviceOption(Writer.MemoryWriter);
  const scope = yield* Effect.scope;
  const wakes = new Map<ThreadId, Wake>();
  const byWakeup = new Map<KinWakeupId, Wake>();
  // Wake-ups between their claim and `begin`, and the chat whose line they hold.
  const prepared = new Map<
    KinWakeupId,
    { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly chatId: KinChatId }
  >();

  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const stamp = Effect.fn("KinReplyBridge.stamp")(
    function* (wake: Wake, column: "first_token_at" | "posted_at") {
      if (wake.stamped.has(column)) return;
      wake.stamped.add(column);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_wakeups SET ${sql(column)} = COALESCE(${sql(column)}, ${now})
        WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}`.pipe(
        Effect.mapError(toPersistenceSqlError("KinReplyBridge.stamp")),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin wake-up timing failed", { cause })),
  );
  const journal = (wake: Wake, lines: ReadonlyArray<string>) =>
    Option.isSome(writer)
      ? writer.value
          .appendJournal(wake.orgId, wake.wakeupId, lines)
          .pipe(Effect.catchCause(() => Effect.logWarning("Kin reply journal failed")))
      : Effect.void;

  const show = Effect.fnUntraced(function* (
    wake: Wake,
    state: KinPresenceState,
    label: string | null,
    since?: number,
  ) {
    if (wake.done) return;
    if (wake.state === state && wake.label === label && since === undefined) return;
    wake.state = state;
    wake.label = label;
    if (state !== "stalled") wake.live = { state, label };
    wake.since = since ?? (yield* Clock.currentTimeMillis);
    yield* presence.set(wake.orgId, wake.lane.chatId, {
      agentId: wake.agentId,
      wakeupId: wake.wakeupId,
      state,
      label,
      startedAt: iso(wake.timerFrom),
      since: iso(wake.since),
    });
  });

  const lane = (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) => laneFor(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  // The bridge's identity comes from stored rows, never from anything the model wrote.
  const agent = (wake: Wake) =>
    identity.agentForWakeup({ orgId: wake.orgId, wakeupId: wake.wakeupId }).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed((): AgentIdentity | undefined => undefined),
    );

  // A lead that still posted with kin_chat_post, out of habit, already said this.
  const alreadySaid = Effect.fn("KinReplyBridge.alreadySaid")(function* (wake: Wake, text: string) {
    const rows = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
        AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
        AND created_at >= ${iso(wake.startedAt)}
      ORDER BY seq`;
    const target = normalized(text);
    return rows.some((row) => normalized(row.body) === target);
  });

  const deliver = Effect.fn("KinReplyBridge.deliver")(function* (
    wake: Wake,
    clientMessageId: string,
    body: string,
  ) {
    const lead = yield* agent(wake);
    if (lead === undefined) return { _tag: "withheld" as const, reason: "wake-up ended" };
    return yield* gate
      .post(lead, {
        chatId: wake.lane.chatId,
        clientMessageId,
        body: capBody(body),
        intent: wake.lane.mode === "reply" ? "answer" : "evidence",
      })
      .pipe(
        Effect.map((result) => ({ _tag: "posted" as const, messageId: result.messageId })),
        Effect.catch((error) =>
          Effect.succeed({ _tag: "withheld" as const, reason: error.reason }),
        ),
      );
  });

  const post = Effect.fn("KinReplyBridge.post")(function* (wake: Wake, segment: Segment) {
    const end = (messageId: KinMessageId | null) =>
      segment.drafting
        ? presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, messageId)
        : Effect.void;
    const text = stripTrailingSilenceMarker(segment.text.trim());
    if (yield* alreadySaid(wake, text).pipe(Effect.orElseSucceed(() => false))) {
      segment.outcome = "posted";
      wake.answered = true;
      wake.replied = true;
      return yield* end(null);
    }
    // The last allowed message carries everything past the bound, joined at the run's end.
    if (
      wake.posted >= KIN_WAKEUP_MESSAGE_LIMIT - 1 ||
      wake.chars + text.length > KIN_WAKEUP_CHAR_LIMIT
    ) {
      segment.outcome = "overflow";
      wake.replied = true;
      wake.overflow.push(text);
      return yield* end(null);
    }
    const result = yield* deliver(wake, `reply:${segment.id}`, text);
    switch (result._tag) {
      case "posted":
        segment.outcome = "posted";
        wake.posted++;
        wake.chars += text.length;
        wake.answered = true;
        wake.replied = true;
        // Work after a reply is new work: its timer doesn't count against the answered message.
        wake.timerFrom = yield* Clock.currentTimeMillis;
        yield* stamp(wake, "posted_at");
        return yield* end(result.messageId);
      case "withheld":
        segment.outcome = "withheld";
        // Nothing it writes can land, so a rescue would not help either.
        wake.answered = true;
        yield* end(null);
        yield* journal(wake, [`Withheld (${result.reason}): ${cutLabel(text)}`]);
        if (result.reason === "limit")
          yield* show(
            wake,
            wake.state,
            wake.lane.mode === "notice" ? "Couldn't post: notice limit" : "Couldn't post: limit",
          );
    }
  });

  const decide = Effect.fn("KinReplyBridge.decide")(function* (
    wake: Wake,
    segment: Segment,
    next: SegmentNext | null,
  ) {
    if (segment.outcome !== null || !segment.complete) return;
    const decision = afterReply(wake, segment) ? "dropped" : classifySegment(segment.text, next);
    if (decision === null) return;
    if (decision === "post" || decision === "note")
      segment.text = stripTrailingSilenceMarker(segment.text);
    switch (decision) {
      case "post":
        return yield* post(wake, segment);
      case "note":
        segment.outcome = "note";
        wake.notes.push(segment);
        yield* journal(wake, [`Note: ${cutLabel(segment.text)}`]);
        if (segment.drafting)
          yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
        return;
      case "silent":
      case "empty":
      case "dropped":
        segment.outcome = decision;
        if (decision === "dropped")
          yield* journal(wake, [`Dropped after kin_end: ${cutLabel(segment.text)}`]);
        if (segment.drafting)
          yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
    }
  });

  // A lead that replied and then called kin_end is done: text after it would answer twice.
  const afterReply = (wake: Wake, segment: Segment) =>
    wake.replied && wake.endedAt !== null && segment.ordinal > wake.endedAt;
  const nextAfter = (wake: Wake, ordinal: number): SegmentNext | null => {
    const tool = Math.min(...wake.tools.filter((tool) => tool > ordinal));
    if (tool === Infinity) return null;
    return tool === wake.endedAt ? "end" : "tool";
  };

  const segmentFor = (wake: Wake, id: TurnItemId, ordinal: number, now: number) => {
    let segment = wake.segments.get(id);
    if (segment === undefined) {
      segment = {
        id,
        ordinal,
        text: "",
        complete: false,
        firstSeenAt: now,
        drafting: false,
        outcome: null,
      };
      wake.segments.set(id, segment);
    }
    return segment;
  };
  const pendingBefore = (wake: Wake, ordinal: number) =>
    [...wake.segments.values()]
      .filter(
        (segment) => segment.outcome === null && segment.complete && segment.ordinal < ordinal,
      )
      .toSorted((a, b) => a.ordinal - b.ordinal);

  // Per stream event for registered lead threads only; a span each would swamp tracing.
  const onItem = Effect.fnUntraced(function* (wake: Wake, item: OrchestrationV2TurnItem) {
    const now = yield* Clock.currentTimeMillis;
    wake.lastOutputAt = now;
    wake.latest = Math.max(wake.latest, item.ordinal);
    if (item.type === "assistant_message") {
      const segment = segmentFor(wake, item.id, item.ordinal, now);
      for (const earlier of pendingBefore(wake, item.ordinal)) yield* decide(wake, earlier, "text");
      if (segment.outcome !== null) return;
      segment.text = textOf(item);
      segment.ordinal = item.ordinal;
      // Held back from its first token, so it never shows as a draft or a writing line.
      if (afterReply(wake, segment)) {
        segment.complete = !item.streaming;
        return yield* decide(wake, segment, null);
      }
      if (segment.text.trim() !== "") yield* stamp(wake, "first_token_at");
      if (item.streaming) {
        yield* show(wake, "writing", PHASE_LABELS.writing);
        // Drafts are append-only, so a marker shown here could not be taken back at the end.
        const draft = draftReplyText(segment.text);
        if (
          draft.trim() !== "" &&
          (segment.drafting ||
            draft.trim().length > NOTE_MAX_CHARS ||
            now - segment.firstSeenAt >= DRAFT_AFTER_MS)
        ) {
          segment.drafting = true;
          yield* presence.draft(wake.orgId, wake.lane.chatId, {
            draftId: segment.id,
            agentId: wake.agentId,
            text: draft,
          });
        }
        return;
      }
      segment.complete = true;
      return yield* decide(wake, segment, nextAfter(wake, segment.ordinal));
    }
    if (item.type === "reasoning") return yield* show(wake, "thinking", PHASE_LABELS.thinking);
    if (!isToolItem(item)) return;
    if (!wake.tools.includes(item.ordinal)) wake.tools.push(item.ordinal);
    if (isEndCall(item)) wake.endedAt = Math.min(wake.endedAt ?? item.ordinal, item.ordinal);
    for (const earlier of pendingBefore(wake, item.ordinal))
      yield* decide(wake, earlier, isEndCall(item) ? "end" : "tool");
    if (item.ordinal < wake.latest) return;
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
      const label = toolLabel(item);
      if (label !== null) yield* show(wake, "working", label);
      return;
    }
    // The latest call ended: the model is deciding what comes next.
    yield* show(wake, "thinking", PHASE_LABELS.thinking);
  });

  const onEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const wake = wakes.get(event.threadId);
    if (wake === undefined) return;
    yield* wake.lock
      .withPermits(1)(
        Effect.gen(function* () {
          // An event read before the wake-up ended must not bring its line or draft back.
          if (wake.done) return;
          if (event.type === "turn-item.updated") return yield* onItem(wake, event.payload);
          if (event.type === "provider-turn.updated" || event.type === "run.updated") {
            wake.lastOutputAt = yield* Clock.currentTimeMillis;
            if (wake.state === "stalled") yield* show(wake, wake.live.state, wake.live.label);
          }
          // The provider has the turn: the model is running.
          if (
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            wake.live.state === "starting"
          )
            yield* show(wake, "thinking", wake.opening);
        }),
      )
      .pipe(
        Effect.catchCause((cause) => Effect.logWarning("Kin reply bridge event failed", { cause })),
      );
  });

  const watchStall = Effect.fn("KinReplyBridge.watchStall")((wake: Wake) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const due = wake.lastOutputAt + STALL_MS - now;
      if (due > 0) return yield* Effect.sleep(due);
      if (wake.state !== "stalled")
        yield* wake.lock.withPermits(1)(show(wake, "stalled", null, wake.lastOutputAt));
      yield* Effect.sleep(STALL_MS);
    }).pipe(Effect.forever),
  );

  // Every lead run's items, in order, from the projection: what a restart or a missed live
  // event would otherwise lose, and the exact next item for each short segment.
  const settle = Effect.fn("KinReplyBridge.settle")(function* (wake: Wake, rootRunId: RunId) {
    const projection = yield* threads.getThreadProjection(wake.threadId);
    const root = projection.runs.find((run) => run.id === rootRunId);
    if (root === undefined) return;
    const runs = new Set(
      projection.runs.filter((run) => run.ordinal >= root.ordinal).map((run) => run.id),
    );
    const items = projection.turnItems
      .filter((item) => item.runId !== null && runs.has(item.runId))
      .toSorted((a, b) => a.ordinal - b.ordinal);
    const now = yield* Clock.currentTimeMillis;
    for (const [index, item] of items.entries()) {
      if (isEndCall(item)) wake.endedAt = Math.min(wake.endedAt ?? item.ordinal, item.ordinal);
      if (item.type !== "assistant_message" || item.streaming) continue;
      const segment = segmentFor(wake, item.id, item.ordinal, now);
      if (segment.outcome !== null) continue;
      segment.text = textOf(item, projection);
      segment.complete = true;
      const following = items
        .slice(index + 1)
        .find((next) => next.type === "assistant_message" || isToolItem(next));
      yield* decide(
        wake,
        segment,
        following === undefined || isEndCall(following)
          ? "end"
          : following.type === "assistant_message"
            ? "text"
            : "tool",
      );
    }
  });

  // Replies given another way. A lead's reaction (kin_react) counts only when everything the
  // wake-up owed was the owner's text without a "?", and it reacted to one of those messages:
  // "thanks, that's all" can take a 👍; a question, a card tap or a reaction still needs words.
  const answered = Effect.fn("KinReplyBridge.answered")(function* (wake: Wake) {
    if (wake.answered || wake.lane.mode === "notice") return true;
    const owed = sql`SELECT e.event_id, e.tag, e.priority, q.body FROM kin_events e
      LEFT JOIN kin_messages q ON q.org_id = e.org_id
        AND q.message_id = json_extract(e.json, '$.messageId') AND q.chat_id = ${wake.lane.chatId}
      WHERE e.org_id = ${wake.orgId} AND e.wakeup_id = ${wake.wakeupId}
        AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')`;
    const rows = yield* sql`SELECT 1 FROM kin_messages
        WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
          AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
          AND created_at >= ${iso(wake.startedAt)}
      UNION ALL SELECT 1 FROM kin_reactions r
        JOIN kin_chat_members m ON m.org_id = r.org_id AND m.chat_id = r.chat_id
          AND m.member_id = r.member_id AND m.principal_kind = 'agent' AND m.agent_id = ${wake.agentId}
        WHERE r.org_id = ${wake.orgId} AND r.chat_id = ${wake.lane.chatId}
          AND r.removed_at IS NULL AND r.created_at >= ${wake.startedAt}
          AND r.message_id IN (SELECT json_extract(e.json, '$.messageId') FROM kin_events e
            WHERE e.org_id = ${wake.orgId} AND e.wakeup_id = ${wake.wakeupId} AND e.tag = 'chat.message')
          AND NOT EXISTS (SELECT 1 FROM (${owed}) o
            WHERE o.tag != 'chat.message' OR o.priority != 'P0' OR o.body IS NULL
              OR instr(o.body, '?') > 0)
      ORDER BY 1 LIMIT 1`;
    return rows.length > 0;
  });

  const flushOverflow = Effect.fn("KinReplyBridge.flushOverflow")(function* (wake: Wake) {
    if (wake.overflow.length === 0) return;
    const room = Math.max(0, KIN_WAKEUP_CHAR_LIMIT - wake.chars);
    const joined = wake.overflow.join("\n\n");
    wake.overflow.length = 0;
    const body =
      joined.length <= Math.min(room, KIN_MESSAGE_BODY_MAX_LENGTH)
        ? joined
        : `${joined.slice(0, Math.max(0, Math.min(room, KIN_MESSAGE_BODY_MAX_LENGTH) - OVERFLOW_SUFFIX.length))}${OVERFLOW_SUFFIX}`;
    const result = yield* deliver(wake, `reply-overflow:${wake.wakeupId}`, body);
    if (result._tag !== "withheld") wake.answered = true;
  });

  const rescue = Effect.fn("KinReplyBridge.rescue")(function* (
    wake: Wake,
    projectId: ProjectId,
    until: number,
  ) {
    const messageId = MessageId.make(rescueMessageId(wake.wakeupId));
    const sent = yield* threads.sendToThread({
      commandId: CommandId.make(`kin-rescue:${wake.wakeupId}`),
      projectId,
      threadId: wake.threadId,
      messageId,
      text: RESCUE_PROMPT,
      attachments: [],
      mode: "queue",
      createdBy: "system",
      creationSource: "server",
    });
    const run = sent.run;
    yield* wake.lock.withPermits(1)(show(wake, "thinking", PHASE_LABELS.thinking));
    const timeoutMs = Math.max(
      0,
      Math.min(RESCUE_TIMEOUT_MS, until - (yield* Clock.currentTimeMillis)),
    );
    const result = yield* threads.waitForThread({
      projectId,
      threadId: wake.threadId,
      runId: run.id,
      timeoutMs,
    });
    if (result.timedOut)
      yield* threads.interruptThread({
        projectId,
        threadId: wake.threadId,
        runId: run.id,
        commandId: CommandId.make(`kin-rescue-timeout:${wake.wakeupId}`),
      });
  });

  // Ends the wake-up's line and drafts for good; queue lines are the queue's, not the wake-up's.
  const settleLine = (wake: Wake) =>
    wake.lock.withPermits(1)(
      Effect.gen(function* () {
        wake.done = true;
        if (wake.stall !== undefined) yield* Fiber.interrupt(wake.stall);
        for (const segment of wake.segments.values())
          if (segment.drafting && segment.outcome === null) {
            segment.outcome = "empty";
            yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
          }
        yield* presence.clear(wake.orgId, wake.lane.chatId, wake.agentId);
      }),
    );

  const complete = Effect.fn("KinReplyBridge.complete")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly projectId: ProjectId;
      readonly rootRunId: RunId;
      readonly rescueUntil: number | null;
    }) {
      const wake = byWakeup.get(input.wakeupId);
      if (wake === undefined || wake.orgId !== input.orgId) return;
      const finish = wake.lock.withPermits(1)(
        Effect.gen(function* () {
          yield* settle(wake, input.rootRunId);
          // Rakazo's fallback: the run's last status note is better than silence.
          const note = wake.notes.at(-1);
          if (note !== undefined && !(yield* answered(wake))) {
            note.outcome = null;
            yield* post(wake, note);
          }
          yield* flushOverflow(wake);
          return yield* answered(wake);
        }),
      );
      // What follows, such as the memory commit, isn't work on the owner's message.
      const settled = settleLine(wake);
      // A failed or stopped run is retried or was the owner's choice; only a finished one is owed.
      if ((yield* finish) || input.rescueUntil === null) return yield* settled;
      yield* rescue(wake, input.projectId, input.rescueUntil);
      if (yield* finish) return yield* settled;
      yield* settled;
      // Honest, never faked: the owner sees that no reply came.
      yield* chat.notice({
        messageId: KinMessageId.make(`kin-no-reply:${wake.wakeupId}`),
        orgId: wake.orgId,
        chatId: wake.lane.chatId,
        body: `${wake.lane.leadName} didn't reply.`,
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin reply completion failed", { cause })),
  );

  const steered = Effect.fn("KinReplyBridge.steered")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) {
    const wake = byWakeup.get(wakeupId);
    if (wake === undefined || wake.orgId !== orgId) return;
    const found = yield* lane(wake);
    // The queue steers only within the lane, so only the mode can change.
    if (Option.isSome(found) && found.value.chatId === wake.lane.chatId)
      yield* wake.lock.withPermits(1)(Effect.sync(() => (wake.lane = found.value)));
  });

  const failed = Effect.fn("KinReplyBridge.failed")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly outcome: FailedOutcome;
    }) {
      const notice = failedNotices[input.outcome];
      yield* chat.notice({
        messageId: KinMessageId.make(`${notice.prefix}:${input.wakeupId}`),
        orgId: input.orgId,
        chatId: input.lane.chatId,
        body: notice.body(input.lane.leadName),
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin failure notice failed", { cause })),
  );

  const end = Effect.fn("KinReplyBridge.end")(function* (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) {
    const { orgId, agentId, wakeupId } = input;
    const held = prepared.get(wakeupId);
    if (held !== undefined && held.orgId === orgId) {
      prepared.delete(wakeupId);
      if (byWakeup.get(wakeupId) === undefined)
        yield* presence.clear(orgId, held.chatId, held.agentId);
    }
    const wake = byWakeup.get(wakeupId);
    if (wake !== undefined && wake.orgId === orgId) {
      byWakeup.delete(wakeupId);
      if (wakes.get(wake.threadId) === wake) wakes.delete(wake.threadId);
      yield* settleLine(wake);
    }
    yield* syncQueued(presence, orgId, agentId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  const preparing = Effect.fn("KinReplyBridge.preparing")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly startedAt: number;
    }) {
      if (byWakeup.has(input.wakeupId) || prepared.has(input.wakeupId)) return;
      const { orgId, agentId, wakeupId, lane, startedAt } = input;
      prepared.set(wakeupId, { orgId, agentId, chatId: lane.chatId });
      yield* presence.set(orgId, lane.chatId, {
        agentId,
        wakeupId,
        state: "starting",
        label: PHASE_LABELS.preparing,
        startedAt: iso(startedAt),
        since: iso(startedAt),
      });
      // Messages in other chats now wait behind this wake-up.
      yield* syncQueued(presence, orgId, agentId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin preparing line failed", { cause })),
  );

  const begin = Effect.fn("KinReplyBridge.begin")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
      readonly threadId: ThreadId;
      readonly startedAt: number;
      readonly attachments?: boolean;
    }) {
      if (byWakeup.has(input.wakeupId)) return;
      const found = yield* lane(input);
      if (Option.isNone(found)) return;
      const now = yield* Clock.currentTimeMillis;
      const wake: Wake = {
        ...input,
        lane: found.value,
        lock: yield* Semaphore.make(1),
        segments: new Map(),
        tools: [],
        notes: [],
        overflow: [],
        posted: 0,
        chars: 0,
        replied: false,
        endedAt: null,
        answered: false,
        lastOutputAt: now,
        state: "starting",
        label: PHASE_LABELS.preparing,
        live: { state: "starting", label: PHASE_LABELS.preparing },
        latest: -1,
        since: input.startedAt,
        stall: undefined,
        opening: input.attachments === true ? PHASE_LABELS.attachments : PHASE_LABELS.thinking,
        timerFrom: input.startedAt,
        done: false,
        stamped: new Set(),
      };
      const previous = wakes.get(input.threadId);
      if (previous !== undefined) yield* end(previous);
      wakes.set(input.threadId, wake);
      byWakeup.set(input.wakeupId, wake);
      prepared.delete(input.wakeupId);
      yield* show(wake, "starting", PHASE_LABELS.preparing, input.startedAt);
      wake.stall = yield* watchStall(wake).pipe(Effect.forkIn(scope));
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin reply bridge could not start", { cause })),
  );

  yield* threads.streamDomainEvents.pipe(
    Stream.runForEach(onEvent),
    Effect.tapCause(() => Effect.logWarning("Kin reply bridge stream failed; reconnecting.")),
    Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
    Effect.forkIn(scope),
  );

  return KinReplyBridge.of({
    lane,
    preparing,
    begin,
    complete,
    steered,
    failed,
    end,
  });
});

export const layer = Layer.effect(KinReplyBridge, make);
