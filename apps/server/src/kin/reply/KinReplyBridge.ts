import {
  CommandId,
  KIN_DOC_CARD,
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KinChatId,
  kinHasSections,
  kinPageSections,
  kinPageShape,
  KIN_FIGURE_SCHEME,
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
import { KIN_VISUAL_CARD_TYPE } from "@t3tools/shared/kinVisual";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { isClaudeThinkingItem } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import {
  KinChatService,
  KIN_WAKEUP_CHAR_LIMIT,
  KIN_WAKEUP_MESSAGE_LIMIT,
} from "../chat/KinChatService.ts";
import { isPrivateWriteRefused } from "../chat/KinChatRepository.ts";
import {
  KinIdentity,
  isSteerMessage,
  rescueMessageId,
  type AgentIdentity,
} from "../chat/KinIdentity.ts";
import { laneFor, type Lane } from "./replyLane.ts";
import { AUDIENCE_MOVED, aborted, ownerOnlyChat } from "../lead/Audience.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import {
  CAPTION_PROMPT,
  classifySegment,
  cutLabel,
  draftReplyText,
  isToolItem,
  NOTE_MAX_CHARS,
  PHASE_LABELS,
  isProviderErrorText,
  normalized,
  repeats,
  RESCUE_PROMPT,
  setupFailureIn,
  stripTrailingSilenceMarker,
  toolLabel,
  type SegmentNext,
  type SetupFailure,
  withoutAsked,
} from "./classify.ts";
import { KinPresence, syncQueued } from "./KinPresence.ts";
import { missingCard, NUDGE_PREFIX, relayPrefix, unkeptPromise } from "./promises.ts";
import { weeklyFigures } from "../pulse/weekly.ts";
import { flagTextQuestion } from "../questions/openQuestions.ts";

export { rescueMessageId };
/** No turn-item or provider-turn update for this long shows the owner a stall and Stop. */
const STALL_MS = 120_000;
/** A streaming segment this old becomes a visible draft even while still short. */
const DRAFT_AFTER_MS = 1_000;
const RESCUE_TIMEOUT_MS = 120_000;
const OVERFLOW_SUFFIX = "\n\n…more in the agent's thread";
// Room left for the heading and for entry keys Kin replaces with longer names when it stores.
const MORNING_HEADROOM = 200;
/** The morning page Kin posts when the turn wrote none: its one quiet line, under Needs you. */
export const QUIET_PAGE = "## Needs you\n\nNothing new needs you this morning.";
const isPage = (text: string) =>
  kinHasSections(text) && kinPageSections(text).some(({ title }) => title !== null);
/** The text in parts of at most `max` characters, cut between lines. */
const fitParts = (text: string, max: number) =>
  text.split("\n").reduce<Array<string>>((parts, line) => {
    const last = parts.at(-1);
    if (last !== undefined && last.length + 1 + line.length <= max)
      parts[parts.length - 1] = `${last}\n${line}`;
    else parts.push(line.slice(0, max));
    return parts;
  }, []);

// Which wake-ups owe words: a message, card tap or reaction asked in its chat (`reply`); an entry
// someone gave the lead and finished work wait on it too (`owedNotice`). Reminders, briefs and
// scheduled runs owe theirs through `LeadDelivery`; the rest may end on NO_REPLY.

// `replied`: the turn failed after its reply answered every message it held.
export type FailedOutcome = "partway" | "replied" | "retrying" | "gave_up" | SetupFailure;
// Plain words with the lead's name: the inbox shows this as the chat's latest line.
const failedNotices: Record<
  Exclude<FailedOutcome, SetupFailure | "replied">,
  { prefix: string; body: (lead: string) => string }
> = {
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
/** Only the owner can fix the account, so only the owner's own chat hears how. */
const setupNotice = (lead: string, failure: SetupFailure, ownerOnly: boolean) =>
  !ownerOnly
    ? `${lead} is unavailable right now.`
    : failure === "signin"
      ? `${lead} couldn't start: its model account needs signing in again on the server.`
      : failure === "model"
        ? `${lead} couldn't start: its model account doesn't offer the model it's set to use. Choose another model for it.`
        : failure === "program"
          ? `${lead} couldn't start: the server couldn't run its model program. Check the provider's binary path in Settings.`
          : `${lead} couldn't start: its model account can't use its model. Check the account on the server.`;

type Outcome = "posted" | "note" | "silent" | "empty" | "withheld" | "overflow" | "dropped";

const WITHHELD_ANY = "Kin couldn't save it. Send your message again.";
/** Why Kin held a reply back, for everyone in the chat, never what it said; none for the chat's own no. */
const withheldWhy = (error: { readonly reason: string }): string | null =>
  isPrivateWriteRefused(error)
    ? "it included things only the owner and co-owners see, and someone else is in this chat. Ask again and the answer will be one everyone here may read."
    : error.reason === "limit"
      ? "this chat reached its message limit for now. Try again later."
      : error.reason === "floor_not_granted" || error.reason === "floor_closed"
        ? "it came after the time to answer ran out. Send your message again."
        : error.reason === "not_allowed"
          ? null
          : WITHHELD_ANY;
/** The one message a turn's reply to one request lives in; later segments grow it. */
type Slot = { readonly messageId: KinMessageId; body: string };
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
  // A segment reached the chat, so the lane is answered.
  answered: boolean;
  // Kin refused a segment: nothing reached the chat for it, and a rescue would be refused too.
  withheld: string | null;
  // Why, in words for the people in the chat (`withheldWhy`).
  withheldWhy: string | null;
  // Keyed by the ordinal of the steered message a reply answers, -1 for the wake-up's own.
  readonly slots: Map<number, Slot>;
  readonly steers: Array<number>;
  // The events the model had read by an ordinal: the claim's own at -1, then each steer's.
  readonly heard: Array<{ readonly ordinal: number; readonly eventIds: ReadonlyArray<string> }>;
  // Events a steer carries, by its number, until its message shows in the thread.
  readonly steerEvents: Map<number, ReadonlyArray<string>>;
  movedNoticed: boolean;
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
    /**
     * A message was steered into the wake-up: re-reads its lane, which may now owe a reply.
     * `steer` names its number and events, so a reply after it marks them answered.
     */
    readonly steered: (
      orgId: KinOrgId,
      wakeupId: KinWakeupId,
      steer?: { readonly n: number; readonly eventIds: ReadonlyArray<string> },
    ) => Effect.Effect<void>;
    /**
     * The wake-up failed, in the lane read before the queue closed it: `partway` after
     * something visible (not retried), `replied` when its reply already answered every message
     * (a line only for a card the reply named and never posted, or a promise not kept),
     * `retrying` when it showed nothing and will run again, `gave_up` when that was its last try.
     */
    readonly failed: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly outcome: FailedOutcome;
    }) => Effect.Effect<void>;
    /**
     * The wake-up was aborted for its audience: its line goes and its drafts end without the
     * rest of their text, and nothing it streams shows again.
     */
    readonly abort: (orgId: KinOrgId, wakeupId: KinWakeupId) => Effect.Effect<void>;
    /** Clears the wake-up's line; a queue line stays, or comes back, where a message still waits. */
    readonly end: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: KinWakeupId;
    }) => Effect.Effect<void>;
  }
>()("t3/kin/reply/KinReplyBridge") {}

type AnswerItem = Extract<OrchestrationV2TurnItem, { type: "assistant_message" }>;
/** The model's own words. Its reasoning never reaches a chat, even shown as an update. */
const isAnswer = (item: OrchestrationV2TurnItem) =>
  item.type === "assistant_message" && !isClaudeThinkingItem(item);
const textOf = (item: AnswerItem, projection?: OrchestrationV2ThreadProjection) =>
  item.textOmitted === true
    ? (projection?.messages.find((message) => message.id === item.messageId)?.text ?? item.text)
    : item.text;
/** Cards that show a chart, visual or file but say nothing: the turn still owes a line. */
const SHOWS_ONLY = ["chart", KIN_VISUAL_CARD_TYPE, KIN_DOC_CARD];
const capBody = (text: string) =>
  text.length <= KIN_MESSAGE_BODY_MAX_LENGTH
    ? text
    : `${text.slice(0, KIN_MESSAGE_BODY_MAX_LENGTH - OVERFLOW_SUFFIX.length)}${OVERFLOW_SUFFIX}`;

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
  // The messages the model had read before a reply are answered for good, in the reply's own
  // transaction (the gate's `bind`): no restart finds the reply stored and its message unanswered.
  const repliedBy = (wake: Wake, ordinal: number) => () =>
    Effect.gen(function* () {
      const eventIds = wake.heard
        .filter((one) => one.ordinal < ordinal)
        .flatMap((one) => one.eventIds);
      if (eventIds.length === 0) return;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_events SET replied_at = COALESCE(replied_at, ${now})
        WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}
          AND event_id IN ${sql.in(eventIds)}`;
    });
  const markReplied = Effect.fn("KinReplyBridge.markReplied")(
    function* (wake: Wake, ordinal: number) {
      yield* repliedBy(wake, ordinal)();
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin couldn't mark a reply", { cause })),
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

  // The questions on cards this turn posted in the lane: the card asks it, so the reply needn't.
  const asked = Effect.fn("KinReplyBridge.asked")(function* (wake: Wake) {
    const rows = yield* sql<{ question: string | null }>`
      SELECT json_extract(w.state_json, '$.question') AS question FROM kin_widgets w
      JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
      WHERE w.org_id = ${wake.orgId} AND w.chat_id = ${wake.lane.chatId} AND w.type = 'choice'
        AND m.author_kind = 'agent' AND m.author_agent_id = ${wake.agentId}
        AND m.author_thread_id = ${wake.threadId} AND m.created_at >= ${iso(wake.startedAt)}
      ORDER BY m.seq`;
    return rows.flatMap((row) => (row.question === null ? [] : [row.question]));
  });

  const deliver = Effect.fn("KinReplyBridge.deliver")(function* (
    wake: Wake,
    clientMessageId: string,
    body: string,
    ordinal: number,
  ) {
    const lead = yield* agent(wake);
    if (lead === undefined)
      return {
        _tag: "withheld" as const,
        reason: "wake-up ended",
        why: WITHHELD_ANY,
        moved: false,
      };
    return yield* gate
      .post(
        lead,
        {
          chatId: wake.lane.chatId,
          clientMessageId,
          body: capBody(body),
          placeReplyFigures: true,
          intent: wake.lane.mode === "reply" ? "answer" : "evidence",
        },
        repliedBy(wake, ordinal),
      )
      .pipe(
        Effect.map((result) => ({
          _tag: "posted" as const,
          messageId: result.messageId,
          body: result.body,
        })),
        Effect.catch((error) =>
          Effect.succeed({
            _tag: "withheld" as const,
            reason: error.reason,
            why: withheldWhy(error),
            moved: error.message === AUDIENCE_MOVED,
          }),
        ),
      );
  });

  // The segment joins the reply already posted for its request, a blank line between them.
  const extend = Effect.fn("KinReplyBridge.extend")(function* (
    wake: Wake,
    slot: Slot,
    text: string,
    ordinal: number,
  ) {
    const joined = slot.body === "" ? text : text === "" ? slot.body : `${slot.body}\n\n${text}`;
    const body =
      joined.length <= KIN_MESSAGE_BODY_MAX_LENGTH
        ? joined
        : slot.body.length <= KIN_MESSAGE_BODY_MAX_LENGTH - OVERFLOW_SUFFIX.length
          ? capBody(joined)
          : null;
    if (body === null) return { _tag: "full" as const };
    const lead = yield* agent(wake);
    if (lead === undefined)
      return {
        _tag: "withheld" as const,
        reason: "wake-up ended",
        why: WITHHELD_ANY,
        moved: false,
      };
    return yield* gate
      .extend(
        lead,
        { chatId: wake.lane.chatId, messageId: slot.messageId, body },
        repliedBy(wake, ordinal),
      )
      .pipe(
        Effect.map((message) => {
          slot.body = message.body;
          return { _tag: "posted" as const, messageId: slot.messageId, body: message.body };
        }),
        Effect.catch((error) =>
          Effect.succeed({
            _tag: "withheld" as const,
            reason: error.reason,
            why: withheldWhy(error),
            moved: error.message === AUDIENCE_MOVED,
          }),
        ),
      );
  });
  // A steered message is a new request: its answer gets a message of its own.
  const slotKey = (wake: Wake, ordinal: number) =>
    Math.max(-1, ...wake.steers.filter((steer) => steer < ordinal));

  const hasFigures = Effect.fn("KinReplyBridge.hasFigures")(function* (wake: Wake) {
    const rows = yield* sql`SELECT 1 FROM kin_turn_figures
      WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}
        AND agent_id = ${wake.agentId} AND chat_id = ${wake.lane.chatId} AND message_id IS NULL LIMIT 1`;
    return rows.length > 0;
  });
  // The seeded brief this wake-up runs alone (`pulse/checkInSeeds.ts`), not a turn someone asked.
  const briefIn = (wake: Wake, scheduleIds: ReadonlyArray<string>) =>
    sql<{ figures: number | null }>`SELECT CASE
        WHEN json_extract(e.json, '$.checkIn.scheduleId') = 'checkin-weekly' THEN 1
        ELSE json_extract(e.json, '$.checkIn.figures') END AS figures
      FROM kin_events e WHERE e.org_id = ${wake.orgId}
      AND e.wakeup_id = ${wake.wakeupId} AND e.tag = 'pulse'
      AND json_extract(e.json, '$.checkIn.scheduleId') IN ${sql.in(scheduleIds)}
      AND NOT EXISTS (SELECT 1 FROM kin_events m WHERE m.org_id = e.org_id
        AND m.wakeup_id = e.wakeup_id AND m.tag = 'chat.message')
      ORDER BY e.event_id LIMIT 1`.pipe(Effect.map((rows) => rows[0]));
  // The morning brief and evening summary read as a page with sections however they were written:
  // the reply gets a heading when it opens with none, or with only a label such as "Today:".
  const underMorningHeading = Effect.fn("KinReplyBridge.underMorningHeading")(function* (
    wake: Wake,
    text: string,
  ) {
    if (wake.posted > 0 || isPage(text)) return text;
    if ((yield* briefIn(wake, ["checkin-morning", "checkin-evening"])) === undefined) return text;
    const page = `## Today\n\n${text}`;
    const room = KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM;
    return page.length <= room
      ? page
      : `${page.slice(0, room - OVERFLOW_SUFFIX.length)}${OVERFLOW_SUFFIX}`;
  });
  // A page the turn posted itself, with a tool.
  const postedPage = Effect.fn("KinReplyBridge.postedPage")(function* (wake: Wake) {
    const rows = yield* sql<{
      messageId: KinMessageId;
      body: string;
    }>`SELECT message_id AS "messageId",
        body FROM kin_messages
      WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
        AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
        AND created_at >= ${iso(wake.startedAt)} AND form = 'brief' AND status = 'posted'
      ORDER BY seq`;
    return rows.find((row) => isPage(row.body));
  });
  // The morning page is Kin's, whatever the turn wrote (`pulse/checkIn.ts`): with no page of the
  // turn's own, Kin posts one with its quiet line; on the weekly brief's day Kin's figures go on
  // it, or follow it in messages of their own when it has no room, so none is cut or retyped.
  const settlePage = Effect.fn("KinReplyBridge.settlePage")(
    function* (wake: Wake) {
      if (wake.withheld !== null) return;
      const brief = yield* briefIn(wake, ["checkin-morning", "checkin-weekly"]);
      if (brief === undefined) return;
      let slot = wake.slots.get(-1) ?? (yield* postedPage(wake));
      if (slot === undefined) {
        const result = yield* deliver(wake, `kin-page:${wake.wakeupId}`, QUIET_PAGE, -1);
        if (result._tag !== "posted") {
          wake.withheldWhy ??= result.why;
          wake.withheld ??= result.reason;
          return;
        }
        slot = { messageId: result.messageId, body: result.body };
        wake.slots.set(-1, slot);
        wake.posted++;
        wake.answered = true;
        wake.replied = true;
      }
      if (brief.figures !== 1) return;
      const figures = yield* weeklyFigures({
        orgId: wake.orgId,
        now: yield* Clock.currentTimeMillis,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (slot.body.length + 2 + figures.length <= KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM) {
        const result = yield* extend(wake, slot, figures, -1);
        if (result._tag === "posted") return;
        if (result._tag === "withheld" && result.reason !== "not_found") {
          wake.withheld = result.reason;
          return;
        }
      }
      for (const [index, part] of fitParts(
        figures,
        KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM,
      ).entries()) {
        const result = yield* deliver(wake, `kin-week:${wake.wakeupId}:${index}`, part, -1);
        if (result._tag === "withheld") {
          wake.withheld = result.reason;
          return;
        }
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin morning page not settled", { cause })),
  );
  const post = Effect.fn("KinReplyBridge.post")(function* (wake: Wake, segment: Segment) {
    const end = (messageId: KinMessageId | null) =>
      segment.drafting
        ? presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, messageId)
        : Effect.void;
    // In the Team room an agent speaks with team_say; what else it writes is its own thinking.
    if (wake.lane.team === true) {
      segment.outcome = "dropped";
      return yield* end(null);
    }
    const key = slotKey(wake, segment.ordinal);
    const slot = wake.slots.get(key);
    const text = withoutAsked(
      stripTrailingSilenceMarker(segment.text.trim()),
      yield* asked(wake).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    );
    // Nothing left once the card's question is dropped: the card speaks, this answers nothing.
    // The same answer again, after a tool call, would read twice in the one message.
    if (text === "" || (slot !== undefined && repeats(text, slot.body))) {
      segment.outcome = "empty";
      return yield* end(null);
    }
    if (yield* alreadySaid(wake, text).pipe(Effect.orElseSucceed(() => false))) {
      segment.outcome = "posted";
      wake.answered = true;
      wake.replied = true;
      yield* markReplied(wake, segment.ordinal);
      return yield* end(null);
    }
    // The last allowed message carries everything past the bound, joined at the run's end.
    if (
      slot === undefined &&
      (wake.posted >= KIN_WAKEUP_MESSAGE_LIMIT - 1 ||
        wake.chars + text.length > KIN_WAKEUP_CHAR_LIMIT)
    ) {
      segment.outcome = "overflow";
      wake.replied = true;
      wake.overflow.push(text);
      return yield* end(null);
    }
    const lead = slot === undefined ? yield* agent(wake) : undefined;
    if (
      !wake.replied &&
      lead !== undefined &&
      wake.lane.mode === "reply" &&
      text.length <= 600 &&
      !text.includes(KIN_FIGURE_SCHEME) &&
      kinPageShape(text) === "bubble" &&
      !(yield* hasFigures(wake)) &&
      (yield* gate
        .setChoiceOutcome(
          lead,
          { chatId: wake.lane.chatId, text },
          repliedBy(wake, segment.ordinal),
        )
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      segment.outcome = "posted";
      wake.answered = true;
      wake.replied = true;
      yield* stamp(wake, "posted_at");
      return yield* end(null);
    }
    const cardId =
      lead === undefined
        ? null
        : yield* chat.replyCard(lead, wake.lane.chatId).pipe(Effect.orElseSucceed(() => null));
    const opening =
      slot === undefined
        ? yield* underMorningHeading(wake, text).pipe(Effect.orElseSucceed(() => text))
        : text;
    const result = yield* slot !== undefined
      ? extend(wake, slot, text, segment.ordinal)
      : cardId === null
        ? deliver(wake, `reply:${segment.id}`, opening, segment.ordinal)
        : Effect.gen(function* () {
            const joined = yield* extend(
              wake,
              { messageId: cardId, body: "" },
              opening,
              segment.ordinal,
            );
            if (joined._tag === "withheld" && joined.reason === "not_found")
              return yield* deliver(wake, `reply:${segment.id}`, opening, segment.ordinal);
            return joined;
          });
    switch (result._tag) {
      case "full":
        segment.outcome = "dropped";
        yield* journal(wake, [`Past the reply's length: ${cutLabel(text)}`]);
        return yield* end(slot?.messageId ?? null);
      case "posted":
        segment.outcome = "posted";
        if (slot === undefined) {
          wake.posted++;
          // As stored: Kin may have named an entry key, and the next part extends this text.
          wake.slots.set(key, { messageId: result.messageId, body: result.body });
        }
        wake.chars += text.length;
        wake.answered = true;
        wake.replied = true;
        // Work after a reply is new work: its timer doesn't count against the answered message.
        wake.timerFrom = yield* Clock.currentTimeMillis;
        yield* stamp(wake, "posted_at");
        return yield* end(result.messageId);
      case "withheld":
        segment.outcome = "withheld";
        wake.withheldWhy ??= result.why;
        wake.withheld ??= result.reason;
        yield* end(null);
        yield* journal(wake, [`Withheld (${result.reason}): ${cutLabel(text)}`]);
        // Lost, not refused: the owner hears it once and can ask again, now as a shared chat.
        // An aborted turn says nothing: a fresh wake-up answers instead.
        if (
          result.moved &&
          !wake.movedNoticed &&
          !(yield* aborted(wake).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orElseSucceed(() => true),
          ))
        ) {
          wake.movedNoticed = true;
          yield* chat.notice({
            messageId: KinMessageId.make(`kin-audience-moved:${wake.wakeupId}`),
            orgId: wake.orgId,
            chatId: wake.lane.chatId,
            audience: "chat",
            body: `${wake.lane.leadName} didn't reply: someone joined while it was working. Send it again.`,
          });
        }
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
    const decision = classifySegment(segment.text, next);
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
        segment.outcome = decision;
        if (segment.drafting)
          yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
    }
  });

  // A message steered in asks something new: the text answering it is a reply of its own.
  const reopen = (wake: Wake, item: OrchestrationV2TurnItem) => {
    if (item.type !== "user_message" || !isSteerMessage(wake.wakeupId, item.messageId)) return;
    if (!wake.steers.includes(item.ordinal)) {
      wake.steers.push(item.ordinal);
      const n = Number(item.messageId.slice(item.messageId.lastIndexOf(":") + 1));
      wake.heard.push({ ordinal: item.ordinal, eventIds: wake.steerEvents.get(n) ?? [] });
    }
  };
  // Unknown until the next item or the run's end: a short segment then is the reply.
  const nextAfter = (wake: Wake, ordinal: number): SegmentNext | null =>
    wake.tools.some((tool) => tool > ordinal) ? "tool" : null;

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
    reopen(wake, item);
    if (item.type === "assistant_message" && isAnswer(item)) {
      const segment = segmentFor(wake, item.id, item.ordinal, now);
      for (const earlier of pendingBefore(wake, item.ordinal)) yield* decide(wake, earlier, "text");
      if (segment.outcome !== null) return;
      segment.text = textOf(item);
      segment.ordinal = item.ordinal;
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
            wakeupId: wake.wakeupId,
            text: draft,
          });
        }
        return;
      }
      segment.complete = true;
      return yield* decide(wake, segment, nextAfter(wake, segment.ordinal));
    }
    if (item.type === "reasoning" || item.type === "assistant_message")
      return yield* show(wake, "thinking", PHASE_LABELS.thinking);
    if (!isToolItem(item)) return;
    if (!wake.tools.includes(item.ordinal)) wake.tools.push(item.ordinal);
    for (const earlier of pendingBefore(wake, item.ordinal)) yield* decide(wake, earlier, "tool");
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
  const settleFigures = Effect.fn("KinReplyBridge.settleFigures")(function* (wake: Wake) {
    if (!(yield* hasFigures(wake))) return;
    const lead = yield* agent(wake);
    if (lead === undefined) return;
    const slot = [...wake.slots.values()].at(-1);
    if (wake.withheld === null && slot !== undefined) {
      const result = yield* extend(wake, slot, "", -1);
      if (result._tag === "withheld") wake.withheld = result.reason;
    }
    if (!(yield* hasFigures(wake))) return;
    if (wake.withheld === null && slot === undefined) {
      const posted = yield* gate
        .settleFigures(lead, wake.lane.chatId, wake.lane.mode === "reply" ? "answer" : "evidence")
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (posted) return;
    }
    const removed = yield* chat.discardFigures({ ...wake, chatId: wake.lane.chatId });
    if (removed > 0) yield* journal(wake, [`Omitted ${removed} unplaced answer figures.`]);
  });
  const settle = Effect.fn("KinReplyBridge.settle")(function* (wake: Wake, rootRunId: RunId) {
    const projection = yield* threads.getThreadProjection(wake.threadId);
    const root = projection.runs.find((run) => run.id === rootRunId);
    if (root === undefined) return;
    // What a run that could not sign in "said" is the provider's, never the lead's.
    if (setupFailureIn(projection, rootRunId) !== null) {
      wake.notes.length = 0;
      for (const segment of wake.segments.values()) {
        if (segment.outcome !== null) continue;
        segment.outcome = "dropped";
        if (segment.drafting)
          yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
      }
      return;
    }
    const runs = new Set(
      projection.runs.filter((run) => run.ordinal >= root.ordinal).map((run) => run.id),
    );
    const items = projection.turnItems
      .filter((item) => item.runId !== null && runs.has(item.runId))
      .toSorted((a, b) => a.ordinal - b.ordinal);
    const failedRuns = new Set(
      items.flatMap((item) =>
        item.type === "error" && item.status === "failed" ? [item.runId] : [],
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    for (const [index, item] of items.entries()) {
      reopen(wake, item);
      if (item.type !== "assistant_message" || !isAnswer(item) || item.streaming) continue;
      const segment = segmentFor(wake, item.id, item.ordinal, now);
      if (segment.outcome !== null) continue;
      segment.text = textOf(item, projection);
      segment.complete = true;
      if (failedRuns.has(item.runId) && isProviderErrorText(segment.text)) {
        segment.outcome = "dropped";
        if (segment.drafting)
          yield* presence.endDraft(wake.orgId, wake.lane.chatId, segment.id, null);
        continue;
      }
      const following = items.slice(index + 1).find((next) => isAnswer(next) || isToolItem(next));
      yield* decide(
        wake,
        segment,
        following === undefined ? "end" : following.type === "assistant_message" ? "text" : "tool",
      );
    }
  });

  // Replies given another way. A lead's reaction counts only when all the wake-up owed was the
  // owner's text without a "?" and it reacted to one of those: a question or a tap needs words.
  // Kin's line answers a teammate's request passed on when every message the wake-up held went;
  // one cancelled since counts by Kin's line saying so, which a tap that sent nothing lacks.
  const answered = Effect.fn("KinReplyBridge.answered")(function* (wake: Wake) {
    if (wake.answered || !wake.lane.owed) return true;
    if (
      wake.lane.mode === "reply" &&
      [...wake.segments.values()].some((segment) => segment.outcome === "silent")
    ) {
      const spoken = yield* sql`SELECT 1 FROM kin_events
        WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}
          AND (tag = 'widget.action' OR (tag = 'chat.message' AND event_id NOT GLOB 'handoff-back-*')
            OR (tag = 'chat.reaction'
            AND (json_extract(json, '$.changedFrom') IS NOT NULL
              OR json_extract(json, '$.withdrawn') = 1)))
        LIMIT 1`;
      if (spoken.length === 0) return true;
    }
    const owed = sql`SELECT e.event_id, e.tag, e.priority, q.body FROM kin_events e
      LEFT JOIN kin_messages q ON q.org_id = e.org_id
        AND q.message_id = json_extract(e.json, '$.messageId') AND q.chat_id = ${wake.lane.chatId}
      WHERE e.org_id = ${wake.orgId} AND e.wakeup_id = ${wake.wakeupId}
        AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')`;
    // A relay or nudge this turn sent the asker is someone else's message, not their answer.
    const relay = `send:${relayPrefix(wake.wakeupId)}`;
    const nudge = `send:${NUDGE_PREFIX}`;
    const rows = yield* sql`SELECT 1 FROM kin_messages a
        WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
          AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
          AND created_at >= ${iso(wake.startedAt)}
          AND substr(COALESCE(client_message_id, ''), 1, ${relay.length}) <> ${relay}
          AND substr(COALESCE(client_message_id, ''), 1, ${nudge.length}) <> ${nudge}
          AND NOT EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = a.org_id
            AND w.message_id = a.message_id AND w.type IN ${sql.in(SHOWS_ONLY)})
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
      UNION ALL SELECT 1 FROM kin_events e
        WHERE e.org_id = ${wake.orgId} AND e.wakeup_id = ${wake.wakeupId}
          AND e.tag IN ('chat.message', 'widget.action', 'chat.reaction')
          AND NOT EXISTS (SELECT 1 FROM kin_events o
            WHERE o.org_id = e.org_id AND o.wakeup_id = e.wakeup_id
              AND o.tag IN ('chat.message', 'widget.action', 'chat.reaction')
              AND NOT (o.tag = 'chat.message' AND EXISTS (SELECT 1 FROM kin_handoffs h
                WHERE h.org_id = o.org_id AND h.message_id = json_extract(o.json, '$.messageId')
                  AND h.from_agent_id = ${wake.agentId} AND (h.route_state = 'passed'
                    OR (h.route_state = 'stale' AND EXISTS (SELECT 1 FROM kin_messages n
                      WHERE n.org_id = h.org_id
                        AND n.message_id = 'kin-forward-stale:' || h.event_id))))))
      ORDER BY 1 LIMIT 1`;
    return rows.length > 0;
  });

  // Whether the turn's only answer so far is a chart, visual or file: the rescue asks for its line.
  const showed = Effect.fn("KinReplyBridge.showed")(function* (wake: Wake) {
    const rows = yield* sql`SELECT 1 FROM kin_messages m JOIN kin_widgets w
        ON w.org_id = m.org_id AND w.message_id = m.message_id AND w.type IN ${sql.in(SHOWS_ONLY)}
      WHERE m.org_id = ${wake.orgId} AND m.chat_id = ${wake.lane.chatId} AND m.author_kind = 'agent'
        AND m.author_agent_id = ${wake.agentId} AND m.author_thread_id = ${wake.threadId}
        AND m.created_at >= ${iso(wake.startedAt)}
      LIMIT 1`;
    return rows.length > 0;
  });

  const unsent = (
    wake: { readonly orgId: KinOrgId; readonly wakeupId: KinWakeupId },
    chatId: KinChatId,
    name: string,
  ) =>
    chat.notice({
      orgId: wake.orgId,
      chatId,
      audience: "chat",
      messageId: KinMessageId.make(`kin-unsent:${wake.wakeupId}`),
      body: `That did not reach ${name}; ask again or tell them directly.`,
    });
  // "I'll tell Ishaan" with nothing sent: the asker hears it didn't reach him, not a false promise.
  const keptPromises = Effect.fn("KinReplyBridge.keptPromises")(
    function* (wake: Wake) {
      const name = yield* unkeptPromise({ ...wake, chatId: wake.lane.chatId }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (name === undefined) return;
      yield* unsent(wake, wake.lane.chatId, name);
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin promise check failed", { cause })),
  );

  const flushOverflow = Effect.fn("KinReplyBridge.flushOverflow")(function* (wake: Wake) {
    if (wake.overflow.length === 0) return;
    const room = Math.max(0, KIN_WAKEUP_CHAR_LIMIT - wake.chars);
    const joined = wake.overflow.join("\n\n");
    wake.overflow.length = 0;
    const body =
      joined.length <= Math.min(room, KIN_MESSAGE_BODY_MAX_LENGTH)
        ? joined
        : `${joined.slice(0, Math.max(0, Math.min(room, KIN_MESSAGE_BODY_MAX_LENGTH) - OVERFLOW_SUFFIX.length))}${OVERFLOW_SUFFIX}`;
    const result = yield* deliver(wake, `reply-overflow:${wake.wakeupId}`, body, Infinity);
    if (result._tag === "posted") {
      wake.answered = true;
    } else {
      wake.withheldWhy ??= result.why;
      wake.withheld ??= result.reason;
    }
  });

  const rescue = Effect.fn("KinReplyBridge.rescue")(function* (
    wake: Wake,
    projectId: ProjectId,
    until: number,
    shown: boolean,
  ) {
    const messageId = MessageId.make(rescueMessageId(wake.wakeupId));
    const sent = yield* threads.sendToThread({
      commandId: CommandId.make(`kin-rescue:${wake.wakeupId}`),
      projectId,
      threadId: wake.threadId,
      messageId,
      text: shown ? CAPTION_PROMPT : RESCUE_PROMPT,
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
          yield* settlePage(wake);
          yield* settleFigures(wake);
          yield* keptPromises(wake);
          // A reply ending on a question to the one person here: stored as open, for every agent.
          yield* flagTextQuestion({ ...wake, chatId: wake.lane.chatId }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) => Effect.logWarning("Kin question check failed", { cause })),
          );
          return yield* answered(wake);
        }),
      );
      // What follows, such as the memory commit, isn't work on the owner's message.
      const settled = settleLine(wake);
      // A failed or stopped run is retried or was the owner's choice; only a finished one is owed.
      if ((yield* finish) || input.rescueUntil === null) return yield* settled;
      const shown = yield* showed(wake).pipe(Effect.orElseSucceed(() => false));
      // A refusal would refuse the rescue's text too.
      if (wake.withheld === null) {
        yield* rescue(wake, input.projectId, input.rescueUntil, shown);
        if (yield* finish) return yield* settled;
      }
      yield* settled;
      // What it showed stands without its line: "didn't reply" under a chart would be false.
      if (shown && wake.withheld === null) return;
      // The chat itself said no (a mute, a level), or someone joining already said so.
      if (wake.movedNoticed || (wake.withheld !== null && wake.withheldWhy === null)) return;
      // Honest, never faked: whoever asked sees that no reply came, and why Kin held one back.
      yield* chat.notice({
        messageId: KinMessageId.make(`kin-no-reply:${wake.wakeupId}`),
        orgId: wake.orgId,
        chatId: wake.lane.chatId,
        audience: "chat",
        body:
          wake.withheld === null
            ? `${wake.lane.leadName} didn't reply.`
            : `${wake.lane.leadName}'s reply couldn't be posted: ${wake.withheldWhy ?? WITHHELD_ANY}`,
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin reply completion failed", { cause })),
  );

  const steered = Effect.fn("KinReplyBridge.steered")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
    steer?: { readonly n: number; readonly eventIds: ReadonlyArray<string> },
  ) {
    const wake = byWakeup.get(wakeupId);
    if (wake === undefined || wake.orgId !== orgId) return;
    if (steer !== undefined) wake.steerEvents.set(steer.n, steer.eventIds);
    const found = yield* lane(wake);
    // The queue steers only within the lane, so only the mode can change.
    if (Option.isSome(found) && found.value.chatId === wake.lane.chatId)
      yield* wake.lock.withPermits(1)(Effect.sync(() => (wake.lane = found.value)));
  });

  // Once per burst: a line this lead already left in the chat, with nobody writing since, stands.
  const standing = Effect.fnUntraced(function* (
    input: { readonly orgId: KinOrgId; readonly lane: Lane },
    agentId: KinAgentId,
    prefixes: ReadonlyArray<string>,
  ) {
    const rows = yield* sql`SELECT 1 FROM kin_messages n
      JOIN kin_wakeups w ON w.org_id = n.org_id
        AND substr(n.message_id, instr(n.message_id, ':') + 1) = w.wakeup_id
        AND substr(n.message_id, 1, instr(n.message_id, ':') - 1) IN ${sql.in(prefixes)}
      WHERE n.org_id = ${input.orgId} AND n.chat_id = ${input.lane.chatId} AND w.agent_id = ${agentId}
        AND NOT EXISTS (SELECT 1 FROM kin_messages h WHERE h.org_id = n.org_id
          AND h.chat_id = n.chat_id AND h.author_kind = 'human' AND h.seq > n.seq)
      LIMIT 1`;
    return rows.length > 0;
  });
  const agentOf = Effect.fnUntraced(function* (orgId: KinOrgId, wakeupId: KinWakeupId) {
    const [wakeup] = yield* sql<{ agentId: KinAgentId }>`SELECT agent_id AS "agentId"
      FROM kin_wakeups WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId} ORDER BY wakeup_id`;
    return wakeup?.agentId;
  });

  const failed = Effect.fn("KinReplyBridge.failed")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly outcome: FailedOutcome;
    }) {
      if (
        input.outcome === "signin" ||
        input.outcome === "access" ||
        input.outcome === "model" ||
        input.outcome === "program"
      )
        return yield* setupFailed({ ...input, outcome: input.outcome });
      if (input.outcome === "replied") return yield* failedAfterReply(input);
      const notice = failedNotices[input.outcome];
      if (input.outcome === "retrying") {
        const agentId = yield* agentOf(input.orgId, input.wakeupId);
        if (agentId === undefined) return;
        if (yield* standing(input, agentId, ["kin-retrying", "kin-setup"])) return;
      }
      yield* chat.notice({
        messageId: KinMessageId.make(`${notice.prefix}:${input.wakeupId}`),
        orgId: input.orgId,
        chatId: input.lane.chatId,
        audience: "chat",
        body: notice.body(input.lane.leadName),
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin failure notice failed", { cause })),
  );

  // A reply already answered: a second line comes only when what it promised did not happen.
  const failedAfterReply = Effect.fn("KinReplyBridge.failedAfterReply")(function* (input: {
    readonly orgId: KinOrgId;
    readonly wakeupId: KinWakeupId;
    readonly lane: Lane;
  }) {
    const provide = Effect.provideService(SqlClient.SqlClient, sql);
    if (yield* missingCard(input).pipe(provide))
      return yield* chat.notice({
        messageId: KinMessageId.make(`kin-no-card:${input.wakeupId}`),
        orgId: input.orgId,
        chatId: input.lane.chatId,
        audience: "chat",
        body: `${input.lane.leadName} stopped before posting the card it mentioned. Ask again for it.`,
      });
    const [wake] = yield* sql<{ agentId: KinAgentId; threadId: string | null; startedAt: number }>`
      SELECT agent_id AS "agentId", thread_id AS "threadId", started_at AS "startedAt"
      FROM kin_wakeups WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
    const name =
      wake === undefined || wake.threadId === null
        ? undefined
        : yield* unkeptPromise({
            ...input,
            agentId: wake.agentId,
            threadId: wake.threadId,
            startedAt: wake.startedAt,
            chatId: input.lane.chatId,
          }).pipe(provide);
    // The same line, and id, the completed turn's check posts: it shows once.
    if (name !== undefined) return yield* unsent(input, input.lane.chatId, name);
    yield* Effect.logInfo("Kin turn failed after its reply; nothing it promised is missing", {
      orgId: input.orgId,
      wakeupId: input.wakeupId,
    });
  });

  const setupFailed = Effect.fn("KinReplyBridge.setupFailed")(function* (input: {
    readonly orgId: KinOrgId;
    readonly wakeupId: KinWakeupId;
    readonly lane: Lane;
    readonly outcome: SetupFailure;
  }) {
    const { orgId, wakeupId, lane } = input;
    const agentId = yield* agentOf(orgId, wakeupId);
    if (agentId === undefined) return;
    if (yield* standing(input, agentId, ["kin-setup"])) return;
    const ownerOnly = yield* ownerOnlyChat({ orgId, agentId }, lane.chatId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    const setup = (ownerOnly: boolean) =>
      chat.notice({
        messageId: KinMessageId.make(`kin-setup:${wakeupId}`),
        orgId,
        chatId: lane.chatId,
        audience: ownerOnly ? "owner" : "chat",
        body: setupNotice(lane.leadName, input.outcome, ownerOnly),
      });
    // Someone may join after `ownerOnly` was read: then they get the line anyone may read.
    yield* setup(ownerOnly).pipe(Effect.catchIf(isPrivateWriteRefused, () => setup(false)));
  });

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
    yield* chat
      .discardFigures(input)
      .pipe(Effect.catchCause(() => Effect.logWarning("Kin could not discard unplaced figures")));
    yield* syncQueued(presence, orgId, agentId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  const abort = Effect.fn("KinReplyBridge.abort")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) {
    const held = prepared.get(wakeupId);
    if (held !== undefined && held.orgId === orgId && byWakeup.get(wakeupId) === undefined)
      yield* presence.clear(orgId, held.chatId, held.agentId);
    const wake = byWakeup.get(wakeupId);
    // Presence refuses the drafts' tails itself: the mark is already committed.
    if (wake !== undefined && wake.orgId === orgId) yield* settleLine(wake);
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
      const own = yield* sql<{ eventId: string }>`SELECT event_id AS "eventId" FROM kin_events
        WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId} AND state = 'claimed'`;
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
        answered: false,
        withheld: null,
        withheldWhy: null,
        slots: new Map(),
        steers: [],
        heard: [{ ordinal: -1, eventIds: own.map((row) => row.eventId) }],
        steerEvents: new Map(),
        movedNoticed: false,
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
    abort,
    end,
  });
});

export const layer = Layer.effect(KinReplyBridge, make);
