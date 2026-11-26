import {
  CommandId,
  KIN_DOC_CARD,
  KIN_MESSAGE_BODY_MAX_LENGTH,
  KIN_REPLY_BUBBLES_MAX,
  KinAgentMessageBody,
  KinChatId,
  KIN_TEAM_ROOM_TEAM_ID,
  KinText,
  KinChatError,
  kinIsPage,
  KIN_MONEY_SECTION,
  kinPageWithLines,
  kinPageSections,
  kinPageShape,
  kinReplyBubbles,
  KIN_FIGURE_SCHEME,
  KinMessageId,
  KIN_TROUBLE_WHY,
  MessageId,
  formatKinWhen,
  type KinAgentId,
  type KinTroubleCause,
  type KinOrgId,
  type KinPersonId,
  type KinPresenceState,
  type KinWakeupId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
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
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { KIN_VISUAL_CARD_TYPE } from "@t3tools/shared/kinVisual";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import {
  isContinuation,
  isPrivateWriteRefused,
  storedClientId,
} from "../chat/KinChatRepository.ts";
import { refusedReplyRun } from "../floor/KinFloor.ts";
import {
  KinIdentity,
  isSteerMessage,
  rescueMessageId,
  type AgentIdentity,
} from "../chat/KinIdentity.ts";
import { isClaudeThinkingItem } from "./claudeThinkingItem.ts";
import { laneFor, type Lane } from "./replyLane.ts";
import { followUpFor, PERSON_TAGS, sendClientMessageId } from "./turnVoice.ts";
import { AUDIENCE_MOVED, aborted, ownerOnlyChat } from "../lead/Audience.ts";
import { stoppedByJoinNotice } from "../lead/ChatSharing.ts";
import {
  didVisibleWork,
  endLostToJoin,
  LAST_RETRY_MS,
  requeueForAudience,
  wasPersonStopped,
} from "../lead/KinEventQueue.ts";
import * as KinLevels from "../lead/KinLevels.ts";
import { leftNote } from "../lead/Handoff.ts";
import { directKey } from "../lead/LeadAccess.ts";
import { nextCheckIn } from "../pulse/leftForCheckIn.ts";
import { holdLine } from "../triggers/quietHold.ts";
import { activityAt, waitWhileActive } from "../lead/runSilence.ts";
import { KinLevelGate } from "../lead/LevelGate.ts";
import * as Reach from "../lead/Reach.ts";
import { turnRecords } from "../lead/wakeupRuns.ts";
import * as Writer from "../memory/MemoryWriter.ts";
import {
  CAPTION_PROMPT,
  classifySegment,
  cutLabel,
  isToolItem,
  PHASE_LABELS,
  isProviderErrorText,
  normalized,
  RESCUE_PROMPT,
  SILENT_REPLY,
  stripTrailingSilenceMarker,
  toolLabel,
  toolNext,
  uniqueParagraphs,
  type SegmentNext,
  type SetupFailure,
  withoutAsked,
} from "./classify.ts";
import { KinHostCare } from "../host/KinHostCare.ts";
import { KinPresence, syncQueued } from "./KinPresence.ts";
import { missingCard, NUDGE_PREFIX, relayPrefix, unkeptPromise } from "./promises.ts";
import { morningMoneyFor } from "../pulse/morningMoney.ts";
import * as KinPulse from "../pulse/KinPulse.ts";
import { reservedByFailures, settleCheckInTold, toldBy } from "../pulse/told.ts";
import { weeklyFigures } from "../pulse/weekly.ts";
import { textLocale } from "../work/companyProfile.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { flagTextQuestion } from "../questions/openQuestions.ts";
import { tellDraftMade } from "../questions/sentUpDraft.ts";

export { rescueMessageId };
/** No turn-item or provider-turn update for this long shows the owner a stall and Stop. */
const STALL_MS = 120_000;
// Room left for the heading and for entry keys Kin replaces with longer names when it stores.
const MORNING_HEADROOM = 200;
/** The morning page Kin posts when the turn wrote none: its one quiet line, under Needs you. */
export const QUIET_PAGE = "## Needs you\n\nNothing new needs you this morning.";
const NEEDS_YOU_HEADING = "## Needs you\n";
const LINE_MAX = 200;
const hasNeedsYou = (body: string) =>
  kinPageSections(body).some(({ title }) => title?.trim().toLowerCase() === "needs you");
/** The quiet line, unless cards from earlier turns still wait: then it counts them. */
const quietPage = (before: number) =>
  before === 0
    ? QUIET_PAGE
    : `${NEEDS_YOU_HEADING}\nNothing new this morning; ${before === 1 ? "1 card" : `${before} cards`} from before still ${before === 1 ? "waits" : "wait"} on you.`;
/** The page's Needs you: one item per card the turn left waiting on them, within `room`. */
const needsYouSection = (lines: ReadonlyArray<string>, before: number, room: number) => {
  if (lines.length === 0) return quietPage(before);
  let section = NEEDS_YOU_HEADING;
  for (const [index, text] of lines.entries()) {
    const line = text.length <= LINE_MAX ? text : `${text.slice(0, LINE_MAX - 1).trimEnd()}…`;
    const next = `${section}\n- ${line}`;
    if (next.length <= room) section = next;
    else if (index === 0) section = next.slice(0, Math.max(room, NEEDS_YOU_HEADING.length + 4));
    else break;
  }
  return section;
};
/** Split at section starts or lines where possible, retaining all text between them. */
const fitParts = (text: string, max: number) => {
  if (text.length <= max) return [text];
  const headings: Array<number> = [];
  let offset = 0;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && kinPageSections(`${line}\n.\n`).some(({ title }) => title !== null))
      headings.push(offset);
    offset += line.length + 1;
  }
  const parts: Array<string> = [];
  let boundary = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      let heading = start;
      for (; boundary < headings.length && headings[boundary]! <= end; boundary++)
        heading = headings[boundary]!;
      const line = start + text.slice(start, end).lastIndexOf("\n") + 1;
      const split = heading > start ? heading : line;
      if (split > start && text.slice(start, split).trim() !== "") end = split;
      else if (/[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    }
    const part = text.slice(start, end);
    if (part.trim() !== "") parts.push(part);
    start = end;
  }
  return parts;
};

// Which wake-ups owe words: a message, card tap or reaction asked in its chat (`reply`); an entry
// someone gave the lead and finished work wait on it too (`owedNotice`). Reminders, briefs and
// scheduled runs owe theirs through `LeadDelivery`; the rest may end on NO_REPLY.

// `replied`: the turn failed after its reply answered every message it held.
// `held`: Kin keeps its events until the cause clears (`KinHostCare`).
export type FailedOutcome =
  | "partway"
  | "replied"
  | "retrying"
  | "retrying_later"
  | "gave_up"
  | "stopped"
  | "held"
  | SetupFailure;
/** "<lead> couldn't start" and why, from the one table (`KIN_TROUBLE_WHY`); bare when unknown. */
const couldnt = (lead: string, cause: KinTroubleCause | undefined) =>
  cause === undefined
    ? `${lead} couldn't start`
    : `${lead} couldn't start: ${KIN_TROUBLE_WHY[cause]}`;
// Plain words with the lead's name: the inbox shows this as the chat's latest line.
const failedNotices: Record<
  Exclude<FailedOutcome, SetupFailure | "replied" | "held">,
  { prefix: string; body: (lead: string, cause: KinTroubleCause | undefined) => string }
> = {
  partway: {
    prefix: "kin-partway",
    body: (lead, cause) =>
      cause === undefined
        ? `${lead} stopped partway.`
        : `${lead} stopped partway: ${KIN_TROUBLE_WHY[cause]}.`,
  },
  retrying: {
    prefix: "kin-retrying",
    body: (lead, cause) => `${couldnt(lead, cause)}. Trying again in a moment.`,
  },
  // Before the long wait: the same kind of line for clients, now saying when.
  retrying_later: {
    prefix: "kin-retrying",
    body: (lead, cause) =>
      `${couldnt(lead, cause)}. Trying once more in about ${Math.round(LAST_RETRY_MS / 60_000)} minutes.`,
  },
  gave_up: {
    prefix: "kin-failed",
    body: (lead, cause) => `${couldnt(lead, cause)}. It won't try again on its own.`,
  },
  // A run that ignored Stop, ended for certain (`WakeupRunner`); clients offer Retry by this prefix.
  stopped: {
    prefix: "kin-failed",
    body: (lead) =>
      `${lead} took too long and was stopped. Nothing it hadn't finished was sent. Ask again to start fresh.`,
  },
};
/**
 * Only the owner level can fix the cause, so only an owner-only chat hears which; everyone else
 * hears that the owner was told, when a notice reached them. The request waits either way.
 */
const heldNotice = (lead: string, cause: KinTroubleCause, ownerOnly: boolean, told: boolean) =>
  ownerOnly
    ? `${couldnt(lead, cause)}. Kin is keeping this and will run it as soon as it can.`
    : told
      ? `${lead} is unavailable right now. Kin has told the owner, and will run this as soon as it can.`
      : `${lead} is unavailable right now. Kin will run this as soon as it can.`;

type SendInput = {
  readonly orgId: KinOrgId;
  readonly wakeupId: KinWakeupId;
  readonly text: string;
  readonly level: "now" | "quiet" | "check_in";
};

type SendResult =
  | { readonly sent: true; readonly messageId: KinMessageId }
  | { readonly held: true; readonly when: string };

// Words under eval: change them only with the send cases.
const SEND_REFUSALS = {
  team: "Nothing was sent: use team_say to speak in the Team room.",
  quiet: "Nothing was sent: this turn does not post to a chat.",
  marker: "Nothing was sent: NO_REPLY means send nothing; end the turn with it",
  "already sent": "This turn's message is already sent; end the turn",
  "non-owner check-in": "Nothing was sent: check_in is only for the owner's own chat.",
  "no check-in": "Nothing was sent: no check-in is on. Use now or quiet to send it to the chat.",
  "not running": "Nothing was sent: this turn is no longer running.",
  "not posted": "Nothing was sent: Kin could not post this message.",
} as const;

class KinReplySendError extends Schema.TaggedError<KinReplySendError>()("KinReplySendError", {
  reason: Schema.Literals([
    "team",
    "quiet",
    "marker",
    "already sent",
    "non-owner check-in",
    "no check-in",
    "not running",
    "not posted",
  ]),
}) {
  override get message() {
    return SEND_REFUSALS[this.reason];
  }
}

const decodeCheckInText = Schema.decodeUnknownEffect(KinAgentMessageBody);
const decodeSendText = Schema.decodeUnknownEffect(
  KinText.check(Schema.makeFilter((body) => body.trim() !== "")),
);

type Ending = "text" | "marker" | "none" | "rescued_text" | "rescued_none" | "failed";

type Outcome = "held" | "posted" | "note" | "silent" | "empty" | "withheld" | "dropped";

const WITHHELD_ANY = "Kin couldn't save it. Send your message again.";
type Withheld = {
  readonly _tag: "withheld";
  readonly reason: KinChatError["reason"] | "wake-up ended" | "past_its_day";
  readonly message: string;
  readonly moved?: boolean;
  readonly private?: boolean;
  readonly floorRunId?: string | undefined;
  readonly ownMessageId?: KinMessageId | undefined;
  readonly auxiliary?: true;
};

const refusedWrite = (error: KinChatError, ownMessageId?: KinMessageId): Withheld => ({
  _tag: "withheld",
  reason: error.reason,
  message: error.message,
  moved: error.message === AUDIENCE_MOVED,
  private: isPrivateWriteRefused(error),
  floorRunId: refusedReplyRun(error),
  ownMessageId: error.reason === "not_found" ? ownMessageId : undefined,
});

const missingAuthor: Withheld = {
  _tag: "withheld",
  reason: "wake-up ended",
  message: "No active agent identity for this wake-up.",
};

/** A stored message Kin can still add to, such as the brief or an earlier review. */
type Slot = {
  readonly messageId: KinMessageId;
  body: string;
  /** An earlier turn's message of the same ask (`askMessage`): joined only while still last. */
  readonly earlier?: true;
};
type Segment = {
  readonly id: TurnItemId;
  ordinal: number;
  text: string;
  complete: boolean;
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
  readonly startedByPerson: boolean;
  readonly lock: Semaphore.Semaphore;
  sendReceipt?: {
    readonly text: string;
    readonly level: SendInput["level"];
    readonly result: SendResult;
    readonly lastSteer: number;
  };
  readonly segments: Map<TurnItemId, Segment>;
  readonly tools: Map<number, ReturnType<typeof toolNext>>;
  readonly notes: Array<Segment>;
  // A reply of this wake-up reached the chat.
  replied: boolean;
  // A segment reached the chat, so the lane is answered.
  answered: boolean;
  // Kin refused a segment: nothing reached the chat for it, and a rescue would be refused too.
  withheld: Withheld | null;
  lastReply?: Slot;
  // Steer number by transcript ordinal, with -1 as the original request's slot.
  readonly steers: Map<number, number>;
  // The events the model had read by an ordinal: the claim's own at -1, then each steer's.
  readonly heard: Array<{ readonly ordinal: number; readonly eventIds: ReadonlyArray<string> }>;
  // Events a steer carries, by its number, until its message shows in the thread.
  readonly steerEvents: Map<number, ReadonlyArray<string>>;
  movedNoticed: boolean;
  lastOutputAt: number;
  // When the provider last worked on the thread, by the event's own time (`activityAt`).
  workedAt: number;
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
      readonly rescue: boolean;
      readonly stopped?: boolean;
    }) => Effect.Effect<void>;
    readonly send: (input: SendInput) => Effect.Effect<SendResult, KinReplySendError>;
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
     * `retrying` (`retrying_later` before the long wait) when it showed nothing, `gave_up` last.
     */
    readonly failed: (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly lane: Lane;
      readonly outcome: FailedOutcome;
      readonly cause?: KinTroubleCause;
      /** The owner was told of the cause in a chat only they read. */
      readonly told?: boolean;
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
const withoutNul = (text: string) => text.replaceAll("\u0000", "");
const textOf = (item: AnswerItem, projection?: Pick<OrchestrationV2ThreadProjection, "messages">) =>
  withoutNul(
    item.textOmitted === true
      ? (projection?.messages.find((message) => message.id === item.messageId)?.text ?? item.text)
      : item.text,
  );
/** Cards that show a chart, visual or file but say nothing: the turn still owes a line. */
const SHOWS_ONLY = ["chart", KIN_VISUAL_CARD_TYPE, KIN_DOC_CARD];
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const gate = yield* KinLevelGate;
  const chat = yield* KinChatService;
  const care = yield* Effect.serviceOption(KinHostCare);
  const troubleOpen = (orgId: KinOrgId, cause: KinTroubleCause) =>
    Option.isSome(care) ? care.value.troubleOpen(orgId, cause) : Effect.succeed(false);
  const identity = yield* KinIdentity;
  const presence = yield* KinPresence;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
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
  const recordEnding = Effect.fn("KinReplyBridge.recordEnding")(
    function* (
      input: { readonly orgId: KinOrgId; readonly wakeupId: KinWakeupId },
      ending: Ending,
    ) {
      yield* sql`UPDATE kin_wakeups SET ending = ${ending}
        WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin wake-up ending write failed", { cause })),
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
      startedAt: iso(wake.startedAt),
      since: iso(wake.since),
    });
  });

  const lane = (input: {
    readonly orgId: KinOrgId;
    readonly agentId: KinAgentId;
    readonly wakeupId: KinWakeupId;
  }) => {
    const lookup = laneFor(input).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    return Option.isSome(settings)
      ? lookup.pipe(Effect.provideService(ServerSettingsService, settings.value))
      : lookup;
  };

  // The bridge's identity comes from stored rows, never from anything the model wrote.
  const agent = (wake: Wake) =>
    identity.agentForWakeup({ orgId: wake.orgId, wakeupId: wake.wakeupId }).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed((): AgentIdentity | undefined => undefined),
    );

  // A lead that still posted with kin_chat_post, out of habit, already said this.
  const saidBodies = Effect.fn("KinReplyBridge.saidBodies")(
    function* (wake: Wake) {
      const rows = yield* sql<{ body: string }>`SELECT body FROM kin_messages
      WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
        AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
        AND created_at >= ${iso(wake.startedAt)}
      ORDER BY seq`;
      return new Set(rows.map((row) => normalized(row.body)));
    },
    Effect.orElseSucceed(() => new Set<string>()),
  );
  // The morning page may have gained its heading when stored.
  const alreadySaid = (said: ReadonlySet<string>, body: string) =>
    said.has(normalized(body)) || said.has(normalized(`## Today\n\n${body}`));

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

  // The evening summary is posted on its own day in the company's zone or not at all.
  const pastItsDay = Effect.fn("KinReplyBridge.pastItsDay")(
    function* (wake: Wake) {
      const [row] = yield* sql<{ day: string | null }>`SELECT
          json_extract(json, '$.checkIn.day') AS day FROM kin_events
        WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId} AND tag = 'pulse'
          AND json_extract(json, '$.checkIn.scheduleId') = 'checkin-evening'
        ORDER BY event_id LIMIT 1`;
      if (row?.day == null) return false;
      const zone = yield* ownerZone(wake.orgId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return dayIn(yield* Clock.currentTimeMillis, zone) !== row.day;
    },
    Effect.orElseSucceed(() => false),
  );

  const deliver = Effect.fn("KinReplyBridge.deliver")(function* (
    wake: Wake,
    clientMessageId: string,
    parts: ReadonlyArray<string>,
    ordinal: number,
    silent?: true,
    namedOnly = false,
  ) {
    const lead = yield* agent(wake);
    if (lead === undefined) return missingAuthor;
    if (yield* pastItsDay(wake))
      return {
        _tag: "withheld" as const,
        reason: "past_its_day" as const,
        message: "The check-in's day has passed.",
      };
    return yield* gate
      .postReply(
        lead,
        wake.lane.chatId,
        parts.map((body, i) => ({
          clientMessageId: i === 0 ? clientMessageId : `${clientMessageId}~b${i + 1}`,
          body,
          placeReplyFigures: i === parts.length - 1 && !namedOnly ? true : "named",
          ...(silent === true || i > 0 ? { silent: true as const } : {}),
          intent: wake.lane.mode === "reply" ? "answer" : "evidence",
          reply: true,
        })),
        repliedBy(wake, ordinal)(),
      )
      .pipe(
        Effect.tap((messages) =>
          messages.length > KIN_REPLY_BUBBLES_MAX
            ? Effect.logWarning("Kin reply posted in many parts", {
                wakeupId: wake.wakeupId,
                parts: messages.length,
                chars: messages.reduce((total, message) => total + message.body.length, 0),
              })
            : Effect.void,
        ),
        Effect.map((messages) => {
          const last = messages.at(-1)!;
          return {
            _tag: "posted" as const,
            messageId: messages[0]!.messageId,
            last: { messageId: last.messageId, body: last.body },
          };
        }),
        Effect.catch((error) => Effect.succeed(refusedWrite(error))),
      );
  });

  const appendTo = (wake: Wake, slot: Slot, text: string, ordinal: number) =>
    store(
      wake,
      slot,
      { body: slot.body === "" || text === "" ? slot.body + text : `${slot.body}\n\n${text}` },
      ordinal,
    );

  // Kin's own section put before the page as stored (`settlePage`).
  const lead = (wake: Wake, slot: Slot, body: string) =>
    store(wake, slot, { body, lead: true }, -1);
  const store = Effect.fn("KinReplyBridge.store")(function* (
    wake: Wake,
    slot: Slot,
    input: {
      readonly body: string;
      readonly lead?: true;
      readonly money?: ReadonlyArray<string>;
    },
    ordinal: number,
  ) {
    const author = yield* agent(wake);
    if (author === undefined) return missingAuthor;
    return yield* gate
      .extend(
        author,
        {
          chatId: wake.lane.chatId,
          messageId: slot.messageId,
          ...input,
          ...(slot.earlier === true ? { onlyIfLast: true as const } : {}),
        },
        repliedBy(wake, ordinal),
      )
      .pipe(
        Effect.map((message) => {
          slot.body = message.body;
          return { _tag: "posted" as const, messageId: slot.messageId, body: message.body };
        }),
        Effect.catch((error) =>
          Effect.succeed(refusedWrite(error, slot.earlier === true ? undefined : slot.messageId)),
        ),
      );
  });
  // A steered message is a new request: its answer gets a message of its own.
  const slotKey = (wake: Wake, ordinal: number) =>
    Math.max(-1, ...[...wake.steers.keys()].filter((steer) => steer < ordinal));

  const hasFigures = Effect.fn("KinReplyBridge.hasFigures")(function* (wake: Wake) {
    const rows = yield* sql`SELECT 1 FROM kin_turn_figures
      WHERE org_id = ${wake.orgId} AND wakeup_id = ${wake.wakeupId}
        AND agent_id = ${wake.agentId} AND chat_id = ${wake.lane.chatId} AND message_id IS NULL LIMIT 1`;
    return rows.length > 0;
  });
  // The seeded brief this wake-up runs alone (`pulse/checkInSeeds.ts`), not a turn someone asked.
  const briefIn = (wake: Wake, scheduleIds: ReadonlyArray<string>) =>
    sql<{ eventId: string; figures: number | null }>`SELECT e.event_id AS "eventId", CASE
        WHEN json_extract(e.json, '$.checkIn.scheduleId') = 'checkin-weekly' THEN 1
        ELSE json_extract(e.json, '$.checkIn.figures') END AS figures
      FROM kin_events e WHERE e.org_id = ${wake.orgId}
      AND e.wakeup_id = ${wake.wakeupId} AND e.tag = 'pulse'
      AND json_extract(e.json, '$.checkIn.scheduleId') IN ${sql.in(scheduleIds)}
      AND NOT EXISTS (SELECT 1 FROM kin_events m WHERE m.org_id = e.org_id
        AND m.wakeup_id = e.wakeup_id AND m.tag = 'chat.message')
      ORDER BY e.event_id LIMIT 1`.pipe(Effect.map((rows) => rows[0]));
  // The evening summary reads as a page with sections however it was written: the reply gets a
  // heading when it opens with none, or with only a label such as "Today:". The morning page's is
  // `KinChatRepository.briefForm`'s.
  const underMorningHeading = Effect.fn("KinReplyBridge.underMorningHeading")(function* (
    wake: Wake,
    text: string,
  ) {
    if (wake.replied || kinIsPage(text)) return text;
    if (
      (yield* briefIn(wake, ["checkin-evening", "checkin-morning", "checkin-weekly"])) === undefined
    )
      return text;
    return `## Today\n\n${text}`;
  });
  // The turn's page: the first text it stored in its chat, by tool or reply (`briefForm`).
  const pageOf = Effect.fn("KinReplyBridge.pageOf")(function* (wake: Wake) {
    const [row] = yield* sql<{ messageId: KinMessageId; body: string }>`SELECT
        message_id AS "messageId", body FROM kin_messages
      WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_kind = 'agent'
        AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
        AND created_at >= ${iso(wake.startedAt)} AND kind = 'text' AND body <> ''
        AND form = 'brief' AND status = 'posted'
      ORDER BY seq LIMIT 1`;
    return wake.lastReply?.messageId === row?.messageId ? wake.lastReply : row;
  });
  // Cards this turn raised that wait on the lane's person, as each card itself says it.
  const waitingOn = Effect.fn("KinReplyBridge.waitingOn")(function* (wake: Wake) {
    const since = iso(wake.startedAt);
    const rows = yield* sql<{ line: string | null }>`SELECT line FROM (
      SELECT w.created_at AS at, w.waiting_id AS id, CASE WHEN w.reason = 'approval' THEN m.body
          ELSE COALESCE(json_extract(g.state_json, '$.question'), json_extract(g.state_json, '$.title'),
            NULLIF(m.body, '')) END AS line
        FROM kin_waiting w
        JOIN kin_messages m ON m.org_id = w.org_id AND m.message_id = w.message_id
        LEFT JOIN kin_widgets g ON g.org_id = w.org_id AND g.widget_id = w.widget_id
        WHERE w.org_id = ${wake.orgId} AND w.resolved_at IS NULL AND w.reason <> 'mention'
          AND w.person_id IN (SELECT person_id FROM kin_chat_members WHERE org_id = ${wake.orgId}
            AND chat_id = ${wake.lane.chatId} AND person_id IS NOT NULL AND left_at IS NULL)
          AND ((m.author_kind = 'agent' AND m.author_agent_id = ${wake.agentId}
              AND m.author_thread_id = ${wake.threadId} AND m.created_at >= ${since})
            OR (g.type = 'approval' AND EXISTS (SELECT 1 FROM kin_pending_actions a
              WHERE a.org_id = w.org_id AND a.action_id = json_extract(g.state_json, '$.actionId')
                AND a.requested_by_thread_id = ${wake.threadId} AND a.created_at >= ${wake.startedAt})))
      UNION ALL
      SELECT created_at, message_id, body FROM kin_messages
        WHERE org_id = ${wake.orgId} AND status = 'suggested' AND author_kind = 'agent'
          AND author_agent_id = ${wake.agentId} AND author_thread_id = ${wake.threadId}
          AND created_at >= ${since})
      ORDER BY at, id`;
    return rows.flatMap((row) => {
      const line = row.line?.split("\n").find((one) => one.trim() !== "");
      return line === undefined ? [] : [normalized(line)];
    });
  });
  // Open cards from earlier turns that wait on the lane's person, counted on the quiet line.
  const waitingBefore = Effect.fn("KinReplyBridge.waitingBefore")(function* (wake: Wake) {
    const [row] = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM kin_waiting w
      WHERE w.org_id = ${wake.orgId} AND w.resolved_at IS NULL AND w.reason <> 'mention'
        AND w.person_id IN (SELECT person_id FROM kin_chat_members WHERE org_id = ${wake.orgId}
          AND chat_id = ${wake.lane.chatId} AND person_id IS NOT NULL AND left_at IS NULL)`;
    return row?.count ?? 0;
  });
  // The morning page is Kin's, whatever a finished turn wrote (`pulse/checkIn.ts`): with no page
  // of the turn's own, Kin posts one with its quiet line; on the weekly brief's day Kin's figures
  // go on it, or follow it as ordinary messages when it has no room. A failed turn posts nothing.
  const settlePage = Effect.fn("KinReplyBridge.settlePage")(
    function* (wake: Wake, finished: boolean) {
      if (!finished || wake.withheld !== null) return;
      const brief = yield* briefIn(wake, ["checkin-morning", "checkin-weekly"]);
      if (brief === undefined) return;
      let slot = yield* pageOf(wake);
      const waiting = slot !== undefined && hasNeedsYou(slot.body) ? [] : yield* waitingOn(wake);
      const before =
        waiting.length > 0 || (slot !== undefined && hasNeedsYou(slot.body))
          ? 0
          : yield* waitingBefore(wake);
      if (slot === undefined) {
        const page = needsYouSection(
          waiting,
          before,
          KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM,
        );
        const result = yield* deliver(wake, `kin-page:${wake.wakeupId}`, [page], -1);
        if (result._tag !== "posted") {
          wake.withheld ??= result;
          return;
        }
        slot = result.last;
        wake.lastReply = slot;
        wake.answered = true;
        wake.replied = true;
      } else if (
        !hasNeedsYou(slot.body) &&
        slot.body.length <= KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM
      ) {
        const room = KIN_MESSAGE_BODY_MAX_LENGTH - slot.body.length - 2;
        const result = yield* lead(
          wake,
          slot,
          `${needsYouSection(waiting, before, room)}\n\n${slot.body}`,
        );
        if (result._tag === "withheld" && result.reason !== "not_found") {
          wake.withheld = { ...result, auxiliary: true };
          return;
        }
      }
      // Each morning but the figures' day, which lists them, Kin's own Money lines go on the page.
      if (brief.figures !== 1) {
        const money = yield* morningMoneyFor({
          orgId: wake.orgId,
          chatId: wake.lane.chatId,
          now: yield* Clock.currentTimeMillis,
          offeredFacts: yield* toldBy(wake.orgId, [brief.eventId]).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
          said: kinPageSections(slot.body)
            .filter(({ title }) => title !== null && KIN_MONEY_SECTION.match.test(title.trim()))
            .map(({ markdown }) => markdown)
            .join("\n"),
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        if (money.length === 0) return;
        const page = kinPageWithLines(slot.body, KIN_MONEY_SECTION, money);
        if (page.length <= KIN_MESSAGE_BODY_MAX_LENGTH) {
          const result = yield* store(wake, slot, { body: page, money }, -1);
          if (result._tag === "posted") return;
          if (result.reason !== "not_found") {
            wake.withheld = { ...result, auxiliary: true };
            return;
          }
        }
        const section = kinPageWithLines("", KIN_MONEY_SECTION, money);
        const result = yield* deliver(wake, `kin-money:${wake.wakeupId}`, [section], -1);
        if (result._tag === "withheld") wake.withheld = { ...result, auxiliary: true };
        return;
      }
      // The figures and the chat's owner-level readership must still agree at the write.
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const figures = yield* weeklyFigures({
            orgId: wake.orgId,
            chatId: wake.lane.chatId,
            now: yield* Clock.currentTimeMillis,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          if (
            slot.body.length + 2 + figures.length <=
            KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM
          ) {
            const result = yield* appendTo(wake, slot, figures, -1);
            if (result._tag === "posted") return;
            if (result._tag === "withheld" && result.reason !== "not_found") {
              wake.withheld = { ...result, auxiliary: true };
              return;
            }
          }
          for (const [index, part] of fitParts(
            figures,
            KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM,
          ).entries()) {
            const result = yield* deliver(wake, `kin-week:${wake.wakeupId}:${index}`, [part], -1);
            if (result._tag === "withheld") {
              wake.withheld = { ...result, auxiliary: true };
              return;
            }
          }
        }),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin morning page not settled", { cause })),
  );
  // The reviews one ask queued answer in one message, while nothing but Kin's lines came after it.
  const askMessage = Effect.fn("KinReplyBridge.askMessage")(function* (wake: Wake) {
    const [row] = yield* sql<Slot>`SELECT m.message_id AS "messageId", m.body FROM kin_events e
      JOIN kin_events o ON o.org_id = e.org_id AND o.agent_id = e.agent_id AND o.tag = 'github'
        AND o.wakeup_id <> e.wakeup_id
        AND json_extract(o.json, '$.askedIn[0]') = json_extract(e.json, '$.askedIn[0]')
      JOIN kin_messages m ON m.org_id = o.org_id AND m.source_wakeup_id = o.wakeup_id
        AND m.chat_id = ${wake.lane.chatId} AND m.author_kind = 'agent'
        AND m.author_agent_id = ${wake.agentId} AND m.author_thread_id = ${wake.threadId}
        AND m.status = 'posted' AND m.kind = 'text' AND NOT ${isContinuation(sql, "m")}
      WHERE e.org_id = ${wake.orgId} AND e.wakeup_id = ${wake.wakeupId} AND e.tag = 'github'
        AND json_extract(e.json, '$.chatId') = ${wake.lane.chatId}
        AND NOT EXISTS (SELECT 1 FROM kin_messages n WHERE n.org_id = m.org_id
          AND n.chat_id = m.chat_id AND n.seq > m.seq AND n.author_kind <> 'system')
      ORDER BY m.seq DESC LIMIT 1`;
    return row;
  });
  const replyText = Effect.fn("KinReplyBridge.replyText")(function* (wake: Wake, text: string) {
    return withoutAsked(
      stripTrailingSilenceMarker(
        withoutNul(text)
          .replace(/^(?:[ \t]*\r?\n)+/, "")
          .trimEnd(),
      ),
      yield* asked(wake).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    );
  });

  const wholeReply = Effect.fn("KinReplyBridge.wholeReply")(function* (wake: Wake) {
    const [row] = yield* sql<{ whole: number }>`SELECT (
      c.team_id = ${KIN_TEAM_ROOM_TEAM_ID} OR EXISTS (
        SELECT 1 FROM kin_events e WHERE e.org_id = c.org_id AND e.wakeup_id = ${wake.wakeupId}
          AND ((e.tag = 'pulse' AND json_extract(e.json, '$.checkIn') IS NOT NULL)
            OR (e.tag = 'routine' AND json_extract(e.json, '$.routine') IN ('morning_brief', 'evening_summary')))
          AND NOT EXISTS (SELECT 1 FROM kin_events m WHERE m.org_id = e.org_id
            AND m.wakeup_id = e.wakeup_id AND m.tag = 'chat.message')
      )
    ) AS whole FROM kin_chats c WHERE c.org_id = ${wake.orgId} AND c.chat_id = ${wake.lane.chatId}`;
    return row?.whole === 1;
  });

  const replyParts = Effect.fn("KinReplyBridge.replyParts")(function* (wake: Wake, text: string) {
    const opening = yield* underMorningHeading(wake, text);
    let body = opening;
    if (
      body.length > KIN_MESSAGE_BODY_MAX_LENGTH - MORNING_HEADROOM &&
      !wake.replied &&
      !hasNeedsYou(body) &&
      (yield* briefIn(wake, ["checkin-morning", "checkin-weekly"])) !== undefined &&
      (yield* pageOf(wake)) === undefined
    ) {
      const waiting = yield* waitingOn(wake);
      const before = waiting.length > 0 ? 0 : yield* waitingBefore(wake);
      body = `${needsYouSection(waiting, before, MORNING_HEADROOM)}\n\n${body}`;
    }
    const bubbles = (yield* wholeReply(wake)) ? [body] : kinReplyBubbles(body);
    return bubbles.flatMap((bubble) => fitParts(bubble, KIN_MESSAGE_BODY_MAX_LENGTH));
  });

  const sentWords = Effect.fn("KinReplyBridge.sentWords")(function* (
    wake: Wake,
    key: string,
    body: string,
    silent?: true,
  ) {
    const text = yield* replyText(wake, body);
    if (text === "" || alreadySaid(yield* saidBodies(wake), text)) return;
    const parts = yield* replyParts(wake, text);
    const result = yield* deliver(wake, key, parts, Infinity, silent);
    if (result._tag === "withheld") return;
    wake.lastReply = result.last;
    wake.replied = true;
    yield* stamp(wake, "posted_at");
    return result.messageId;
  });

  const refusedReply = Effect.fn("KinReplyBridge.refusedReply")(function* (
    wake: Wake,
    text: string,
    result: Withheld,
  ) {
    wake.withheld ??= result;
    yield* journal(wake, [`Withheld (${result.reason}): ${cutLabel(text)}`]);
    // Lost, not refused. An aborted turn says nothing: a fresh wake-up answers instead, and
    // one that did nothing visible is aborted for that, once; otherwise the chat hears it once.
    if (
      result.moved &&
      !wake.movedNoticed &&
      !(yield* aborted(wake).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => true),
      ))
    ) {
      wake.movedNoticed = true;
      if (
        yield* requeueForAudience(wake).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.orElseSucceed(() => false),
        )
      )
        return;
      const partway = yield* didVisibleWork(wake).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orElseSucceed(() => false),
      );
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* endLostToJoin({ ...wake, chatId: wake.lane.chatId }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          yield* chat.notice({
            messageId: KinMessageId.make(`kin-audience-moved:${wake.wakeupId}`),
            orgId: wake.orgId,
            chatId: wake.lane.chatId,
            audience: "chat",
            body: stoppedByJoinNotice(wake.lane.leadName, partway),
          });
        }),
      );
    }
    if (result.reason === "limit")
      yield* show(
        wake,
        wake.state,
        wake.lane.mode === "notice" ? "Couldn't post: notice limit" : "Couldn't post: limit",
      );
  });

  const wasStopped = (wake: Wake) =>
    wasPersonStopped(wake).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  const flushReplies = Effect.fn("KinReplyBridge.flushReplies")(function* (
    wake: Wake,
    interrupted: boolean,
  ) {
    let stopped = interrupted || (yield* wasStopped(wake));
    const held = [...wake.segments.values()]
      .filter((segment) => segment.outcome === "held")
      .toSorted((a, b) => a.ordinal - b.ordinal);
    const note = wake.notes.at(-1);
    if (
      !stopped &&
      held.length === 0 &&
      note?.outcome === "note" &&
      wake.sendReceipt === undefined &&
      !(yield* answered(wake))
    )
      held.push(note);
    const slots = [...Map.groupBy(held, (segment) => slotKey(wake, segment.ordinal))];
    for (const [index, [slot, segments]] of slots.entries()) {
      const heldText = uniqueParagraphs(segments.map((segment) => segment.text).join("\n\n"));
      const setOutcome = (outcome: Outcome) => {
        for (const segment of segments) segment.outcome = outcome;
      };
      const drop = journal(wake, [`Not sent: ${cutLabel(heldText)}`]).pipe(
        Effect.tap(() => Effect.sync(() => setOutcome("dropped"))),
      );
      if (stopped) {
        yield* drop;
        continue;
      }
      const text = yield* replyText(wake, heldText);
      const last = segments.at(-1)!;
      if (wake.lane.team === true || wake.lane.quiet === true) {
        setOutcome("dropped");
        continue;
      }
      if (
        wake.sendReceipt !== undefined &&
        (wake.steers.get(slot) ?? -1) <= wake.sendReceipt.lastSteer
      ) {
        setOutcome("dropped");
        if (text !== "") yield* journal(wake, [`Not sent: ${cutLabel(text)}`]);
        continue;
      }
      if (text === "") {
        setOutcome("empty");
        continue;
      }
      const said = yield* saidBodies(wake);
      const parts = alreadySaid(said, text)
        ? []
        : (yield* replyParts(wake, text)).filter((body) => !alreadySaid(said, body));
      if (parts.length === 0) {
        setOutcome("posted");
        wake.answered = true;
        wake.replied = true;
        yield* markReplied(wake, last.ordinal);
        continue;
      }
      const author = parts.length === 1 && !wake.replied ? yield* agent(wake) : undefined;
      const body = parts[0]!;
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          // Serialize with Stop: nothing from this slot can commit after its fence.
          if (yield* wasStopped(wake)) return;
          if (
            author !== undefined &&
            wake.lane.mode === "reply" &&
            body.length <= 600 &&
            !body.includes(KIN_FIGURE_SCHEME) &&
            kinPageShape(body) === "bubble" &&
            !(yield* hasFigures(wake)) &&
            (yield* gate
              .setChoiceOutcome(
                author,
                { chatId: wake.lane.chatId, text: body },
                repliedBy(wake, last.ordinal),
              )
              .pipe(Effect.orElseSucceed(() => false)))
          )
            return { _tag: "choice" } as const;
          const earlier = wake.replied
            ? undefined
            : yield* askMessage(wake).pipe(Effect.orElseSucceed(() => undefined));
          const sameAsk =
            earlier !== undefined &&
            earlier.body.length + text.length + 2 <= KIN_MESSAGE_BODY_MAX_LENGTH;
          const cardId =
            author === undefined || sameAsk
              ? null
              : yield* chat
                  .replyCard(author, wake.lane.chatId)
                  .pipe(Effect.orElseSucceed(() => null));
          const join: Slot | undefined = sameAsk
            ? { ...earlier, earlier: true }
            : cardId !== null
              ? { messageId: cardId, body: "" }
              : undefined;
          const joined =
            join === undefined
              ? undefined
              : yield* appendTo(wake, join, join.earlier === true ? text : body, last.ordinal);
          if (
            joined !== undefined &&
            !(joined._tag === "withheld" && joined.reason === "not_found")
          )
            return { ...joined, ...(join?.earlier === true ? { earlier: true } : {}) };
          return yield* deliver(
            wake,
            `reply:${segments[0]!.id}`,
            parts,
            last.ordinal,
            undefined,
            index < slots.length - 1,
          );
        }),
      );
      if (result === undefined) {
        stopped = true;
        yield* drop;
        continue;
      }
      if (result._tag === "withheld") {
        setOutcome("withheld");
        yield* refusedReply(wake, text, result);
        continue;
      }
      setOutcome("posted");
      wake.answered = true;
      wake.replied = true;
      if (result._tag !== "choice") wake.lastReply = "last" in result ? result.last : result;
      yield* stamp(wake, "posted_at");
    }
    return stopped || (yield* wasStopped(wake));
  });

  const holdSend = Effect.fn("KinReplyBridge.holdSend")(
    function* (wake: Wake, clientMessageId: string, text: string) {
      const lead = yield* agent(wake);
      if (lead === undefined) return yield* new KinReplySendError({ reason: "not running" });
      const [owner] = yield* sql<{ name: string }>`SELECT p.display_name AS name FROM kin_leads l
        JOIN kin_people p ON p.org_id = l.org_id AND p.person_id = ${lead.ownerPersonId}
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        WHERE l.org_id = ${wake.orgId} AND l.agent_id = ${wake.agentId}
          AND c.chat_id = ${wake.lane.chatId} AND c.kind = 'direct'
          AND c.direct_key = ${directKey(lead.ownerPersonId, wake.agentId)}`;
      if (owner === undefined)
        return yield* new KinReplySendError({ reason: "non-owner check-in" });
      const next = yield* nextCheckIn(wake.orgId, wake.agentId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      if (next === undefined) return yield* new KinReplySendError({ reason: "no check-in" });
      yield* gate.amend(
        lead,
        wake.lane.chatId,
        holdLine({
          orgId: wake.orgId,
          chatId: wake.lane.chatId,
          personId: lead.ownerPersonId,
          key: clientMessageId,
          body: text,
          audience: "chat",
          at: next.fallbackAt,
          agentId: wake.agentId,
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(
            () => new KinChatError({ reason: "unavailable", message: SEND_REFUSALS["not posted"] }),
          ),
        ),
      );
      return { held: true as const, when: leftNote(owner.name, next, owner.name) };
    },
    Effect.catchTags({
      KinChatError: () => Effect.fail(new KinReplySendError({ reason: "not posted" })),
      SqlError: () => Effect.fail(new KinReplySendError({ reason: "not posted" })),
    }),
  );

  const send = Effect.fn("KinReplyBridge.send")(function* (input: SendInput) {
    const wake = byWakeup.get(input.wakeupId);
    if (wake === undefined || wake.orgId !== input.orgId)
      return yield* new KinReplySendError({ reason: "not running" });
    return yield* wake.lock.withPermits(1)(
      Effect.gen(function* () {
        if (wake.lane.team === true) return yield* new KinReplySendError({ reason: "team" });
        if (wake.lane.quiet === true) return yield* new KinReplySendError({ reason: "quiet" });
        if (input.text.includes(SILENT_REPLY))
          return yield* new KinReplySendError({ reason: "marker" });
        if (wake.sendReceipt !== undefined) {
          if (wake.sendReceipt.text !== input.text || wake.sendReceipt.level !== input.level)
            return yield* new KinReplySendError({ reason: "already sent" });
          return wake.sendReceipt.result;
        }
        if (wake.done) return yield* new KinReplySendError({ reason: "not running" });
        const decode = input.level === "check_in" ? decodeCheckInText : decodeSendText;
        const body = yield* decode(input.text).pipe(
          Effect.mapError(() => new KinReplySendError({ reason: "not posted" })),
        );
        const clientMessageId = sendClientMessageId(wake.wakeupId);
        const [posted] = yield* sql<{
          messageId: KinMessageId;
        }>`SELECT message_id AS "messageId" FROM kin_messages
          WHERE org_id = ${wake.orgId} AND chat_id = ${wake.lane.chatId} AND author_agent_id = ${wake.agentId}
            AND source_wakeup_id = ${wake.wakeupId} AND client_message_id = ${storedClientId("send", clientMessageId)}
          LIMIT 1`;
        const [held] = yield* sql`SELECT 1 FROM kin_held_posts WHERE org_id = ${wake.orgId}
          AND chat_id = ${wake.lane.chatId} AND agent_id = ${wake.agentId} AND kind = ${clientMessageId} LIMIT 1`;
        const lastSteer = Math.max(-1, ...wake.steerEvents.keys(), ...wake.steers.values());
        let result: SendResult;
        if (posted !== undefined) result = { sent: true, messageId: posted.messageId };
        else {
          const [reminder] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${wake.orgId}
            AND agent_id = ${wake.agentId} AND wakeup_id = ${wake.wakeupId} AND tag = 'deferral.due'
            AND json_extract(json, '$.subject.type') = 'reminder' LIMIT 1`;
          const level = reminder === undefined ? input.level : "now";
          if (level === "check_in") result = yield* holdSend(wake, clientMessageId, body);
          else {
            if (held !== undefined) return yield* new KinReplySendError({ reason: "already sent" });
            const messageId = yield* sentWords(
              wake,
              clientMessageId,
              body,
              level === "quiet" ? true : undefined,
            );
            if (messageId === undefined)
              return yield* new KinReplySendError({ reason: "not posted" });
            result = { sent: true, messageId };
          }
        }
        wake.sendReceipt = { text: input.text, level: input.level, result, lastSteer };
        wake.answered = true;
        return result;
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "KinReplySendError"
            ? error
            : new KinReplySendError({ reason: "not posted" }),
        ),
        Effect.uninterruptible,
      ),
    );
  });

  const decide = Effect.fn("KinReplyBridge.decide")(function* (
    wake: Wake,
    segment: Segment,
    next: SegmentNext | null,
  ) {
    if (segment.outcome !== null || !segment.complete) return;
    const decision = classifySegment(segment.text, next, wake.startedByPerson);
    if (decision === null) return;
    if (decision === "post" || decision === "note")
      segment.text = stripTrailingSilenceMarker(segment.text);
    switch (decision) {
      case "post":
        segment.outcome = "held";
        return;
      case "note":
        segment.outcome = "note";
        wake.notes.push(segment);
        yield* journal(wake, [`Note: ${cutLabel(segment.text)}`]);
        return;
      case "silent":
      case "empty":
        segment.outcome = decision;
    }
  });

  // A message steered in asks something new: the text answering it is a reply of its own.
  const reopen = (wake: Wake, item: OrchestrationV2TurnItem) => {
    if (item.type !== "user_message" || !isSteerMessage(wake.wakeupId, item.messageId)) return;
    if (!wake.steers.has(item.ordinal)) {
      const n = Number(item.messageId.slice(item.messageId.lastIndexOf(":") + 1));
      wake.steers.set(item.ordinal, n);
      wake.heard.push({ ordinal: item.ordinal, eventIds: wake.steerEvents.get(n) ?? [] });
    }
  };
  // Unknown until the next item or the run's end: a short segment then is the reply.
  const nextAfter = (wake: Wake, ordinal: number): SegmentNext | null => {
    let nearest = Infinity;
    let next: SegmentNext | null = null;
    for (const [position, kind] of wake.tools) {
      if (position <= ordinal || position >= nearest) continue;
      nearest = position;
      next = kind;
    }
    for (const segment of wake.segments.values()) {
      if (segment.ordinal <= ordinal || segment.ordinal >= nearest) continue;
      nearest = segment.ordinal;
      next = "text";
    }
    return next;
  };

  const segmentFor = (wake: Wake, id: TurnItemId, ordinal: number) => {
    let segment = wake.segments.get(id);
    if (segment === undefined) {
      segment = {
        id,
        ordinal,
        text: "",
        complete: false,
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
      const segment = segmentFor(wake, item.id, item.ordinal);
      for (const earlier of pendingBefore(wake, item.ordinal))
        yield* decide(wake, earlier, nextAfter(wake, earlier.ordinal));
      if (segment.outcome !== null) return;
      segment.text = textOf(item);
      segment.ordinal = item.ordinal;
      if (segment.text.trim() !== "") yield* stamp(wake, "first_token_at");
      if (item.streaming) {
        yield* wake.lane.voice === "send"
          ? show(wake, "thinking", PHASE_LABELS.thinking)
          : show(wake, "writing", PHASE_LABELS.writing);
        return;
      }
      segment.complete = true;
      // The final transcript item can be the terminal diagnostic, even when it is structured.
      const next = nextAfter(wake, segment.ordinal);
      if (next !== null) return yield* decide(wake, segment, next);
      return;
    }
    if (item.type === "reasoning" || item.type === "assistant_message")
      return yield* show(wake, "thinking", PHASE_LABELS.thinking);
    if (!isToolItem(item)) return;
    wake.tools.set(item.ordinal, toolNext(item));
    for (const earlier of pendingBefore(wake, item.ordinal))
      yield* decide(wake, earlier, nextAfter(wake, earlier.ordinal));
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
    const at = activityAt(event);
    if (at !== undefined) wake.workedAt = Math.max(wake.workedAt, at);
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

  const settleFigures = Effect.fn("KinReplyBridge.settleFigures")(function* (wake: Wake) {
    if (!(yield* hasFigures(wake))) return;
    const lead = yield* agent(wake);
    if (lead === undefined) return;
    const slot = wake.lastReply;
    if (wake.withheld === null && slot !== undefined) {
      const result = yield* appendTo(wake, slot, "", -1);
      if (result._tag === "withheld") wake.withheld = { ...result, auxiliary: true };
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
    const projection = yield* turnRecords(threads, wake.threadId, rootRunId);
    const root = projection.runs.find((run) => run.id === rootRunId);
    if (root === undefined) return;
    const runs = new Set(
      projection.runs.filter((run) => run.ordinal >= root.ordinal).map((run) => run.id),
    );
    const items = projection.turnItems
      .filter((item) => item.runId !== null && runs.has(item.runId))
      .toSorted((a, b) => a.ordinal - b.ordinal);
    const failures = new Map<RunId, OrchestrationV2ProviderFailure>();
    const lastAnswers = new Map<RunId, TurnItemId>();
    for (const item of items) {
      if (item.runId === null) continue;
      if (item.type === "error" && item.status === "failed") failures.set(item.runId, item.failure);
      if (isAnswer(item)) lastAnswers.set(item.runId, item.id);
    }
    for (const [index, item] of items.entries()) {
      reopen(wake, item);
      if (
        item.type !== "assistant_message" ||
        item.runId === null ||
        !isAnswer(item) ||
        item.streaming
      )
        continue;
      const segment = segmentFor(wake, item.id, item.ordinal);
      if (segment.outcome !== null && segment.outcome !== "held") continue;
      segment.text = textOf(item, projection);
      segment.complete = true;
      const failure = failures.get(item.runId);
      if (
        failure !== undefined &&
        lastAnswers.get(item.runId) === item.id &&
        isProviderErrorText(segment.text, failure)
      ) {
        segment.outcome = "dropped";
        continue;
      }
      segment.outcome = null;
      const following = items.slice(index + 1).find((next) => isAnswer(next) || isToolItem(next));
      yield* decide(
        wake,
        segment,
        following === undefined
          ? "end"
          : following.type === "assistant_message"
            ? "text"
            : toolNext(following),
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
        AND e.tag IN ${sql.in(PERSON_TAGS)}`;
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
          AND e.tag IN ${sql.in(PERSON_TAGS)}
          AND NOT EXISTS (SELECT 1 FROM kin_events o
            WHERE o.org_id = e.org_id AND o.wakeup_id = e.wakeup_id
              AND o.tag IN ${sql.in(PERSON_TAGS)}
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

  const rescue = Effect.fn("KinReplyBridge.rescue")(function* (
    wake: Wake,
    projectId: ProjectId,
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
    // It runs while it works, as the wake-up's run did; only silence ends it.
    wake.workedAt = Math.max(wake.workedAt, yield* Clock.currentTimeMillis);
    const result = yield* waitWhileActive(
      threads,
      { projectId, threadId: wake.threadId, runId: run.id },
      () => wake.workedAt,
      Effect.void,
    );
    if (result.timedOut)
      yield* threads.interruptThread({
        projectId,
        threadId: wake.threadId,
        runId: run.id,
        commandId: CommandId.make(`kin-rescue-timeout:${wake.wakeupId}`),
      });
  });

  /**
   * Why a reply refused in a person's direct chat didn't land, for them: a restricted pair, or a
   * level the owner set below talking. Anything else there (a mute) is the chat's own no.
   */
  const refusedHere = Effect.fn("KinReplyBridge.refusedHere")(
    function* (wake: Wake) {
      const [row] = yield* sql<{ personId: KinPersonId }>`SELECT p.person_id AS "personId"
        FROM kin_chats c JOIN kin_people p ON p.org_id = c.org_id
          AND c.direct_key = p.person_id || ':' || ${wake.agentId}
        WHERE c.org_id = ${wake.orgId} AND c.chat_id = ${wake.lane.chatId} AND c.kind = 'direct'
        ORDER BY p.person_id LIMIT 1`;
      if (row === undefined) return null;
      const lead = wake.lane.leadName;
      const ask = Effect.provideService(SqlClient.SqlClient, sql);
      if (
        (yield* Reach.mayReach(
          wake.orgId,
          Reach.person(row.personId),
          Reach.agent(wake.agentId),
        ).pipe(ask)) === "restricted"
      )
        return `you and ${lead} can't message each other here.`;
      const level = yield* KinLevels.effectiveLevel({
        orgId: wake.orgId,
        agentId: wake.agentId,
        chatId: wake.lane.chatId,
      }).pipe(ask);
      return KinLevels.atLeast(level, "L1") ? null : `the owner has set ${lead} not to post here.`;
    },
    Effect.orElseSucceed(() => null),
  );

  const failureNotice = Effect.fn("KinReplyBridge.failureNotice")(function* (
    wake: Wake,
    wasAnswered: boolean,
  ) {
    const { orgId, agentId, wakeupId, threadId, lane } = wake;
    const { chatId, leadName, mode } = lane;
    const refusal = wake.withheld;
    if ((yield* wasStopped(wake)) || refusal?.reason === "past_its_day") return;
    const retryId = KinMessageId.make(`kin-no-reply:${wakeupId}`);
    const plainId = KinMessageId.make(`kin-not-posted:${wakeupId}`);
    const [state] = yield* sql<{
      alreadyNoticed: number;
      retired: number;
      stopped: number;
      leftChat: number;
      deletedReply: number;
      answeredByAnother: number;
    }>`SELECT
      EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.message_id IN (${retryId}, ${plainId})) AS "alreadyNoticed",
      EXISTS (SELECT 1 FROM kin_agents a WHERE a.org_id = c.org_id AND a.agent_id = ${agentId}
        AND a.retired_at IS NOT NULL) AS retired,
      (EXISTS (SELECT 1 FROM kin_wakeups w WHERE w.org_id = c.org_id AND w.wakeup_id = ${wakeupId}
        AND w.agent_id = ${agentId} AND w.status <> 'running')
      OR EXISTS (SELECT 1 FROM kin_agent_threads t WHERE t.org_id = c.org_id
        AND t.agent_id = ${agentId} AND t.thread_id = ${threadId} AND t.ended_at IS NOT NULL)) AS stopped,
      EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'agent' AND m.agent_id = ${agentId} AND m.left_at IS NOT NULL) AS "leftChat",
      EXISTS (SELECT 1 FROM kin_messages m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.message_id = ${refusal?.ownMessageId ?? null} AND m.author_agent_id = ${agentId}
        AND m.source_wakeup_id = ${wakeupId} AND m.status <> 'posted') AS "deletedReply",
      EXISTS (SELECT 1 FROM kin_floor_runs r JOIN kin_events e ON e.org_id = r.org_id
          AND json_extract(e.json, '$.messageId') = r.opened_by AND e.wakeup_id = ${wakeupId}
          AND e.agent_id = ${agentId}
        WHERE r.org_id = c.org_id AND r.chat_id = c.chat_id AND r.run_id = ${refusal?.floorRunId ?? null}
          AND r.agent_turns > 0 AND r.last_speaker <> ${agentId}) AS "answeredByAnother"
      FROM kin_chats c WHERE c.org_id = ${orgId} AND c.chat_id = ${chatId}`;
    if (state === undefined)
      return yield* new KinChatError({ reason: "not_found", message: "Kin record not found." });
    if (state.alreadyNoticed === 1) return;
    if (refusal?.auxiliary === true && refusal.reason !== "not_allowed" && state.deletedReply !== 1)
      return;

    const notice = (body: string, messageId = retryId) =>
      chat.notice({ orgId, chatId, messageId, audience: "chat", body }).pipe(Effect.asVoid);
    const explain = (why: string, messageId = retryId) =>
      notice(`${leadName}'s reply couldn't be posted: ${why}`, messageId);
    if (refusal === null) return yield* notice(`${leadName} didn't reply.`);
    // A deleted part needs a line even when the original post marked the request answered.
    if (wasAnswered && state.deletedReply !== 1) return;
    if (state.retired === 1)
      return yield* explain(
        `${leadName} has been retired, so nothing more will come from it here.`,
        plainId,
      );
    if (state.stopped === 1)
      return yield* explain(`${leadName} was stopped before it finished. Send your message again.`);
    if (state.leftChat === 1)
      return yield* explain(
        `${leadName} is no longer in this chat. Add ${leadName} back to ask here.`,
        plainId,
      );
    if (state.deletedReply === 1)
      return yield* explain(`someone deleted it while ${leadName} was still writing.`, plainId);
    if (refusal.reason === "unavailable")
      return yield* explain("Kin couldn't save it just now. Send your message again.");
    if (state.answeredByAnother === 1)
      return yield* explain("another agent had already answered here.", plainId);
    if (refusal.private === true && refusal.auxiliary !== true)
      return yield* explain(
        "it included things only the owner and co-owners see, and someone else is in this chat. Ask again and the answer will be one everyone here may read.",
      );
    if (refusal.reason === "not_allowed") {
      const why = yield* refusedHere(wake);
      if (why !== null) yield* explain(why);
      return;
    }
    if (refusal.reason === "limit")
      return yield* explain("this chat reached its message limit for now. Try again later.");
    if (refusal.reason === "floor_not_granted" || refusal.reason === "floor_closed")
      return yield* explain("it came after the time to answer ran out. Send your message again.");

    yield* explain(WITHHELD_ANY);
    yield* sql.afterCommit(
      Effect.logWarning("Kin reply withheld for an unknown reason", {
        orgId,
        agentId,
        wakeupId,
        chatId,
        mode,
        reason: refusal.reason,
        message: refusal.message,
      }),
    );
  });

  // Ends the wake-up's line for good; queue lines belong to the queue.
  const settleLine = (wake: Wake) =>
    wake.lock.withPermits(1)(
      Effect.gen(function* () {
        wake.done = true;
        if (wake.stall !== undefined) yield* Fiber.interrupt(wake.stall);
        yield* presence.clear(wake.orgId, wake.lane.chatId, wake.agentId);
      }),
    );

  const complete = Effect.fn("KinReplyBridge.complete")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly wakeupId: KinWakeupId;
      readonly projectId: ProjectId;
      readonly rootRunId: RunId;
      readonly rescue: boolean;
      readonly stopped?: boolean;
    }) {
      const wake = byWakeup.get(input.wakeupId);
      if (wake === undefined || wake.orgId !== input.orgId || wake.done) return;
      let stopped = input.stopped === true;
      const finish = wake.lock.withPermits(1)(
        Effect.gen(function* () {
          if (wake.done) return true;
          yield* settle(wake, input.rootRunId);
          stopped = yield* flushReplies(wake, stopped);
          if (stopped) return false;
          yield* settlePage(wake, input.rescue);
          yield* settleFigures(wake);
          yield* keptPromises(wake);
          // A reply ending on a question to the one person here: stored as open, for every agent.
          yield* flagTextQuestion({ ...wake, chatId: wake.lane.chatId }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) => Effect.logWarning("Kin question check failed", { cause })),
          );
          // The owner's turn on an approved draft: the teammate who asked hears it was made.
          yield* tellDraftMade(wake, chat).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) => Effect.logWarning("Kin draft notice failed", { cause })),
          );
          return yield* answered(wake);
        }),
      );
      // What follows, such as the memory commit, isn't work on the owner's message.
      const settled = (stopped: boolean) =>
        settleLine(wake).pipe(
          Effect.andThen(
            settleCheckInTold({
              orgId: wake.orgId,
              wakeupId: wake.wakeupId,
              chatId: wake.lane.chatId,
              completed: input.rescue && !stopped,
              readFacts: (factKeys) =>
                Effect.flatMap(Clock.currentTimeMillis, (at) =>
                  KinPulse.read({
                    orgId: wake.orgId,
                    at,
                    viewer: { _tag: "owner" },
                    includeHandled: true,
                    factKeys,
                    limit: 200,
                  }),
                ).pipe(Effect.map((read) => read.facts)),
            }).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              // The reply stands; a fact left reserved is only offered a check-in late.
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin check-in ledger failed", { cause }),
              ),
            ),
          ),
        );
      // A failed or stopped run is retried or was the owner's choice; only a finished one is owed.
      const answeredOnFirstRun = yield* finish;
      const endingFor = (rescued: boolean): Ending => {
        const segments = [...wake.segments.values()];
        if (segments.some((segment) => segment.outcome === "posted"))
          return rescued ? "rescued_text" : "text";
        if (rescued) return "rescued_none";
        return segments.some(
          (segment) => segment.outcome === "silent" && segment.text.includes(SILENT_REPLY),
        )
          ? "marker"
          : "none";
      };
      if (
        stopped ||
        !input.rescue ||
        (answeredOnFirstRun && wake.withheld?.ownMessageId === undefined)
      ) {
        yield* settled(stopped);
        return endingFor(false);
      }
      const shown = yield* showed(wake).pipe(Effect.orElseSucceed(() => false));
      // A refusal would refuse the rescue's text too.
      const followUp = followUpFor({
        owed: wake.lane.owed,
        answered: answeredOnFirstRun,
        withheld: wake.withheld !== null,
      });
      if (followUp === "rescue") {
        yield* rescue(wake, input.projectId, shown);
        if ((yield* finish) || stopped) {
          yield* settled(stopped);
          return endingFor(!stopped);
        }
      }
      yield* settled(stopped);
      const ending = endingFor(followUp === "rescue");
      if (wake.movedNoticed || (shown && wake.withheld === null)) return ending;
      yield* sql.withTransaction(failureNotice(wake, answeredOnFirstRun));
      return ending;
    },
    (effect, input) =>
      effect.pipe(
        Effect.tap((ending) => (ending === undefined ? Effect.void : recordEnding(input, ending))),
        Effect.asVoid,
      ),
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
      readonly cause?: KinTroubleCause;
      readonly told?: boolean;
    }) {
      if (input.lane.bills === true) return;
      if (
        input.outcome === "signin" ||
        input.outcome === "access" ||
        input.outcome === "model" ||
        input.outcome === "program"
      )
        return yield* setupFailed({ ...input, cause: input.outcome });
      if (input.outcome === "held")
        return yield* setupFailed({ ...input, cause: input.cause ?? "unknown" });
      if (input.outcome === "replied") return yield* failedAfterReply(input);
      if (input.outcome === "gave_up" && !input.lane.owed) {
        const missed = yield* missedCheckIn(input.orgId, input.wakeupId);
        if (missed !== undefined) {
          // The owner's standing notice for the cause already said it; a second line would repeat it.
          if (input.cause !== undefined && (yield* troubleOpen(input.orgId, input.cause))) return;
          return yield* chat.notice({
            messageId: KinMessageId.make(`kin-failed:${input.wakeupId}`),
            orgId: input.orgId,
            chatId: input.lane.chatId,
            audience: "chat",
            body: missed.body,
            silent: true,
            when: missed.when,
          });
        }
      }
      const notice = failedNotices[input.outcome];
      if (input.outcome === "retrying" || input.outcome === "retrying_later") {
        const agentId = yield* agentOf(input.orgId, input.wakeupId);
        if (agentId === undefined) return;
        const shown = input.outcome === "retrying" ? ["kin-retrying", "kin-setup"] : ["kin-setup"];
        if (yield* standing(input, agentId, shown)) return;
      }
      // Kin is still trying, or the owner's notice for this cause already rang: shown, not pushed.
      const quiet =
        input.outcome === "retrying" ||
        input.outcome === "retrying_later" ||
        (input.cause !== undefined && (yield* troubleOpen(input.orgId, input.cause)));
      yield* chat.notice({
        messageId: KinMessageId.make(`${notice.prefix}:${input.wakeupId}`),
        orgId: input.orgId,
        chatId: input.lane.chatId,
        audience: "chat",
        body: notice.body(input.lane.leadName, input.cause),
        ...(quiet ? { silent: true as const } : {}),
      });
    },
    (effect, input) => effect.pipe(Effect.ensuring(recordEnding(input, "failed"))),
    Effect.catchCause((cause) => Effect.logWarning("Kin failure notice failed", { cause })),
  );

  /**
   * The check-in this wake-up gave up on, as one line: which, when it first tried to run on the
   * company's clock (each reader's client says it on theirs), and what the next one won't bring up:
   * the connections' new items it carried (their cursors moved on when it was queued), and facts
   * three failed check-ins now reserve. Untold facts and left lines go to the next check-in.
   */
  const missedCheckIn = Effect.fn("KinReplyBridge.missedCheckIn")(function* (
    orgId: KinOrgId,
    wakeupId: KinWakeupId,
  ) {
    const [row] = yield* sql<{
      eventId: string;
      title: string;
      outside: number;
      startedAt: number;
    }>`SELECT e.event_id AS "eventId", json_extract(e.json, '$.checkIn.title') AS title,
        COALESCE(json_array_length(e.json, '$.outside'), 0)
          + COALESCE(json_extract(e.json, '$.outsideNotListed'), 0) AS outside,
        (SELECT MIN(f.started_at) FROM kin_wakeups f, json_each(f.event_ids) k
          WHERE f.org_id = w.org_id AND f.agent_id = w.agent_id AND k.value = e.event_id) AS "startedAt"
      FROM kin_wakeups w, json_each(w.event_ids) j
      JOIN kin_events e ON e.org_id = w.org_id AND e.event_id = j.value
      WHERE w.org_id = ${orgId} AND w.wakeup_id = ${wakeupId} AND e.tag = 'pulse'
        AND e.state = 'failed' AND json_extract(e.json, '$.checkIn.title') IS NOT NULL
      ORDER BY e.event_id LIMIT 1`;
    if (row === undefined) return undefined;
    const provide = Effect.provideService(SqlClient.SqlClient, sql);
    const zone = yield* ownerZone(orgId).pipe(provide);
    const locale = yield* textLocale(orgId).pipe(provide);
    const part = (style: "time" | "day") =>
      formatKinWhen(row.startedAt, style, { zone, locale }).replace(/,/g, "");
    const at = `${part("time")} (${part("day")})`;
    const reserved = yield* reservedByFailures(orgId, row.eventId).pipe(provide);
    const left = [
      ...(row.outside > 0 ? ["the new items from connections it would have listed"] : []),
      ...(reserved > 0
        ? [`${reserved} open ${reserved === 1 ? "item" : "items"} it has now missed three times`]
        : []),
    ];
    return {
      body: `${row.title} didn't run at ${at}. ${
        left.length === 0
          ? "Nothing was lost: the next check-in covers it."
          : `The next check-in covers it, except ${left.join(" and ")}.`
      }`,
      when: { at: DateTime.formatIso(DateTime.makeUnsafe(row.startedAt)), zone, text: at },
    };
  });

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

  // Held or unable to start for a cause the owner fixes: one line per chat while nobody writes,
  // shown without a push, since the owner's notice for the cause is the one that rings.
  const setupFailed = Effect.fn("KinReplyBridge.setupFailed")(function* (input: {
    readonly orgId: KinOrgId;
    readonly wakeupId: KinWakeupId;
    readonly lane: Lane;
    readonly cause: KinTroubleCause;
    readonly told?: boolean;
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
        body: heldNotice(lane.leadName, input.cause, ownerOnly, input.told === true),
        silent: true,
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
        startedByPerson: found.value.mode === "reply",
        lock: yield* Semaphore.make(1),
        segments: new Map(),
        tools: new Map(),
        notes: [],
        replied: false,
        answered: false,
        withheld: null,
        steers: new Map(),
        heard: [{ ordinal: -1, eventIds: own.map((row) => row.eventId) }],
        steerEvents: new Map(),
        movedNoticed: false,
        lastOutputAt: now,
        workedAt: now,
        state: "starting",
        label: PHASE_LABELS.preparing,
        live: { state: "starting", label: PHASE_LABELS.preparing },
        latest: -1,
        since: input.startedAt,
        stall: undefined,
        opening: input.attachments === true ? PHASE_LABELS.attachments : PHASE_LABELS.thinking,
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
    send,
    steered,
    failed,
    abort,
    end,
  });
});

export const layer = Layer.effect(KinReplyBridge, make);
