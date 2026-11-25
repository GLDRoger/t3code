import type {
  EnvironmentId,
  KinActionId,
  KinChatId,
  KinMemberId,
  KinOrgId,
  KinPendingAction,
  KinPersonId,
  KinPushCategory,
  KinPushChannel,
  KinPushData,
  KinPushPlatform,
  KinPushSendingStatus,
  KinPushSubject,
  KinPushToken,
  KinPushTopic,
  KinPushWithdrawn,
  KinRecordKey,
  KinWidgetId,
} from "@t3tools/contracts";
import {
  KIN_DEVICE_LINKED_NOTICE,
  KIN_PUSH_TOPICS_MAX,
  KinPushError,
  KinChoiceCardState,
  KinMessageId,
  KinMessageRelay,
  kinGreeting,
  kinIsBrief,
  kinIsPeopleChat,
  kinMessageSubject,
  kinPageGist,
  kinPageShape,
  kinPlainBody,
  kinThreadLinksAsWords,
  kinWhenParts,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ApproverKeys } from "../approvals/ApproverKeys.ts";
import { KinPendingActions } from "../approvals/PendingActions.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { withLinks } from "../chat/messageLinks.ts";
import { memberReads } from "../chat/sharing.ts";
import { MemoryCache } from "../memory/MemoryCache.ts";
import { isHolderNotice } from "../pulse/holderNotice.ts";
import { DM_NEWS, HELD_ID } from "../triggers/heldDelivery.ts";
import { answerRings, personHoldNow, personQuietUntil } from "../triggers/quietHold.ts";
import { taskNewsBanner } from "../work/assignNotices.ts";
import { KinApnsTransport } from "./Apns.ts";
import { KinFcmTransport } from "./Fcm.ts";
import { KinPushDevices, kinPushDeviceId, type KinPushDevice } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";
import {
  approvalTopic,
  bundleTopic,
  cardTopic,
  chatTopic,
  kinTopicCollapseId,
  makeKinPushTopics,
  noticeTopic,
  questionTopic,
  taskTopic,
  troubleTopic,
  uniqueTopic,
  type KinPushSentRow,
  type KinPushSettled,
} from "./KinPushTopics.ts";
import { lastAsk, turnAsks } from "./turnAsks.ts";

/**
 * What server code asks to announce. Only ids: the sender reads everything else, including
 * who receives it, from the database, so nothing an agent wrote picks recipients or text.
 */
export type KinPushNotification =
  | { readonly _tag: "approval"; readonly orgId: KinOrgId; readonly actionId: KinActionId }
  | { readonly _tag: "message"; readonly orgId: KinOrgId; readonly messageId: KinMessageId }
  | {
      readonly _tag: "widget";
      readonly orgId: KinOrgId;
      readonly widgetId: KinWidgetId;
      /** The turn's own messages that posted the card: whoever they rang already heard of it. */
      readonly covered?: ReadonlyArray<KinMessageId>;
    }
  /** A person linked one more device themself: their other phones hear of it, every time. */
  | { readonly _tag: "device"; readonly orgId: KinOrgId; readonly sessionId: string }
  /** Task news held for one person from one mover (`deliverHeld`): one banner, opening Tasks. */
  | { readonly _tag: "tasks"; readonly orgId: KinOrgId; readonly holdIds: ReadonlyArray<string> }
  /** A teammate's messages held from one reader's quiet hours (`deliverHeld`): one banner. */
  | { readonly _tag: "dm"; readonly orgId: KinOrgId; readonly holdIds: ReadonlyArray<string> }
  /**
   * A message an agent took back or put right: the chat banner that shows it now shows, quietly,
   * the newest words still unread there, or goes (`restate`).
   */
  | {
      readonly _tag: "restate";
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly messageId: KinMessageId;
    }
  /** A member's read mark moved: their other devices get the new badge, with no banner. */
  | {
      readonly _tag: "read";
      readonly orgId: KinOrgId;
      readonly chatId: KinChatId;
      readonly memberId: KinMemberId;
    };

export type KinPushOutcome = {
  readonly status: KinPushSendingStatus;
  readonly sent: number;
  /** Devices showing that chat right now. */
  readonly suppressed: number;
  readonly failed: number;
};

/**
 * How a push reaches someone's phones: `ring` with sound and a banner; `quiet` listed in their
 * notifications with no sound, banner or lit screen (their quiet hours, or off hours they hold
 * to); `badge` only the badge (a chat they muted).
 */
export type KinPushDelivery = "ring" | "quiet" | "badge";

type Recipient = {
  readonly personId: KinPersonId;
  readonly delivery: KinPushDelivery;
  /**
   * A rationed ring: once per half hour, or with `since` once since then (a turn's start),
   * claimed only when the push reaches a phone of theirs (`deliver`). Spent, it goes as `spent`.
   */
  readonly capped?: { readonly since?: number; readonly spent: "quiet" | "badge" };
  /** What a tap opens for them, from what they may open. */
  readonly subject?: KinPushSubject;
};

type Push = {
  readonly category: KinPushCategory;
  /** Where an Android phone shows it, so each kind can be silenced on its own. */
  readonly channel: KinPushChannel;
  readonly title: string;
  readonly body: string;
  readonly chatId: KinChatId | undefined;
  /** The message, or card's anchor, it tells of: each send checks the recipient still reads it. */
  readonly source: KinMessageId | undefined;
  /** One per message: a resend replaces its own banner. The chat groups them (`thread-id`). */
  readonly collapseId?: string;
  /** What it is about: to a build that matches by topic, a newer push about it replaces it. */
  readonly topic: KinPushTopic;
  /** A chat's name, titled "<name> · 3 new" when the reader has more than one unread there. */
  readonly countTitle?: string;
  /** A chat's topic: the newest message position the banner covers, which settles it once read. */
  readonly seq?: number;
  /** What a bundle is about (`task:<record key>`): it stands while any of them does. */
  readonly about?: ReadonlyArray<string>;
  readonly data: KinPushData;
  readonly recipients: ReadonlyArray<Recipient>;
  /** A device the push is about, which needs no word of itself. */
  readonly exceptSession?: string;
};

/** APNs refuses a regular push whose JSON payload is longer than this many bytes. */
const KIN_APNS_PAYLOAD_MAX = 4096;
/** FCM refuses a message whose data keys and values come to more than this many bytes. */
const KIN_FCM_DATA_MAX = 4096;
/** A withdrawal's data, leaving room for `aps` on iOS and the `body` key's JSON on Android. */
const WITHDRAW_PAYLOAD_MAX = 3_600;

const utf8 = new TextEncoder();
const jsonBytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length;
const dataBytes = (data: Readonly<Record<string, string>>) =>
  Object.entries(data).reduce(
    (total, [key, value]) => total + utf8.encode(key).length + utf8.encode(value).length,
    0,
  );
const wordSegments = new Intl.Segmenter(undefined, { granularity: "word" });
const sentenceSegments = new Intl.Segmenter(undefined, { granularity: "sentence" });
// A sentence end within the last fifth before the word cut is where the cut goes instead.
const SENTENCE_NEAR = 0.8;

/**
 * `text` whole when its JSON string fits `room` bytes, else cut to fit and marked "…": at a
 * sentence end when one is near, else at a word boundary, in any script.
 */
export function kinPushFit(text: string, room: number): string {
  const clip = (end: number) => `${text.slice(0, end).trimEnd()}…`;
  const fits = (cut: string) => jsonBytes(cut) - 2 <= room;
  if (fits(text)) return text;
  const longest = (ends: ReadonlyArray<number>) => {
    let [low, high, best] = [0, ends.length - 1, -1];
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (fits(clip(ends[mid]!))) [best, low] = [mid, mid + 1];
      else high = mid - 1;
    }
    return best < 0 ? undefined : ends[best];
  };
  const endsOf = (segmenter: Intl.Segmenter) =>
    Array.from(segmenter.segment(text), (part) => part.index + part.segment.length);
  const word = longest(endsOf(wordSegments));
  // One word longer than the room: cut it at a character, the only cut left.
  if (word === undefined) {
    let at = 0;
    for (const char of text) {
      if (!fits(clip(at + char.length))) break;
      at += char.length;
    }
    return clip(at);
  }
  const sentence = longest(endsOf(sentenceSegments));
  return clip(sentence !== undefined && sentence >= word * SENTENCE_NEAR ? sentence : word);
}

const kinRelayWords = (text: string) =>
  /^[^\n]+ asked [^\n]+:\n"([\s\S]*)"$/.exec(text)?.[1] ?? text;

/** A message as plain text for a banner, its line breaks kept; `sendTo` cuts it to fit. */
const kinPushBody = (text: string) =>
  kinThreadLinksAsWords(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/```[^\s`]*/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();

/** What a card asks, in its own words: its message, else its question or title. */
const kinCardWords = (body: string, state: unknown) => {
  const said = kinPushBody(kinPageShape(body) === "page" ? kinPageGist(body) : kinPlainBody(body));
  if (said !== "") return said;
  const field = (key: string) =>
    typeof state === "object" && state !== null && key in state
      ? (state as Record<string, unknown>)[key]
      : undefined;
  for (const key of ["question", "title"]) {
    const value = field(key);
    if (typeof value === "string" && value.trim() !== "") return kinPushBody(value);
  }
  return undefined;
};

/**
 * A banner's title: who wrote it, and in a group the group's name before them. In a direct chat
 * the kind of notice follows, as in "Finance · Question".
 */
const kinBannerTitle = (
  chat: { readonly direct: boolean; readonly name: string },
  author: string | null,
  kind?: string,
) =>
  chat.direct
    ? `${author ?? chat.name}${kind === undefined ? "" : ` · ${kind}`}`
    : author === null
      ? chat.name
      : `${chat.name} · ${author}`;

/**
 * The check-in of the turn that wrote message `m`, by its own wake-up or the author's turn it was
 * written in, so a banner sent after that turn ended still names it.
 */
const CHECK_IN_OF_MESSAGE = `(SELECT json_extract(e.json, '$.checkIn.scheduleId') FROM kin_events e
  WHERE e.org_id = m.org_id AND e.tag = 'pulse'
    AND json_extract(e.json, '$.checkIn.scheduleId') IS NOT NULL
    AND e.wakeup_id = COALESCE(m.source_wakeup_id, (SELECT k.wakeup_id FROM kin_wakeups k
      WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id
        AND strftime('%Y-%m-%dT%H:%M:%fZ', k.started_at / 1000.0, 'unixepoch') <= m.created_at
        AND (k.ended_at IS NULL
          OR strftime('%Y-%m-%dT%H:%M:%fZ', k.ended_at / 1000.0, 'unixepoch') >= m.created_at)
      ORDER BY k.started_at DESC, k.wakeup_id LIMIT 1))
  ORDER BY e.event_id LIMIT 1)`;

/** What a brief is called on its banner: its check-in's name, else its hour's. */
const kinBriefKind = (checkIn: string | null, greeting: string) =>
  checkIn === "checkin-weekly"
    ? "Weekly brief"
    : checkIn === "checkin-morning"
      ? "Morning brief"
      : checkIn === "checkin-evening"
        ? "Evening summary"
        : checkIn !== null
          ? "Check-in"
          : greeting === "Good morning"
            ? "Morning brief"
            : greeting === "Good afternoon"
              ? "Check-in"
              : "Evening summary";

/** What a card is called on its banner: what it asks of the reader. */
const kinCardKind = (
  card: { readonly type: string; readonly client_message_id: string | null },
  state: unknown,
) =>
  card.client_message_id?.startsWith(TAKEN_CARD) === true
    ? "Decided for you"
    : typeof state === "object" && state !== null && "send" in state
      ? "Ready to send"
      : card.type === "deferral"
        ? "Deferred task"
        : card.type === "task"
          ? "Task"
          : card.type === "reminder"
            ? "Reminder"
            : card.type === "scheduled_task"
              ? "Scheduled task"
              : "Question";

/** A card's Android channel: what waits on the reader's answer, else their messages. */
const kinCardChannel = (kind: string): KinPushChannel =>
  kind === "Task" || kind === "Reminder" || kind === "Scheduled task"
    ? "kin.messages"
    : "kin.questions";

const decodeChoiceCard = Schema.decodeUnknownOption(KinChoiceCardState);

const kinOpenQuestionWords = (state: unknown, asked: boolean) => {
  if (!asked) return undefined;
  const card = Option.getOrUndefined(decodeChoiceCard(state));
  if (
    card === undefined ||
    card.answer !== null ||
    card.replaced === true ||
    card.send !== undefined ||
    card.question.trim() === ""
  )
    return undefined;
  return kinPushBody(card.question);
};

/**
 * The two answers a notice shows as buttons, or none. Only an agent's open question (`asked`,
 * in `kin_questions`, carrying no sent-up draft) with exactly two plain options: Kin's own Confirm
 * cards (money, mail, a company change) are no open question, an option that runs an action or
 * sends needs the card, and a draft is approved where it is read (R12).
 */
const kinNoticeChoices = (state: unknown, asked: boolean) => {
  if (!asked) return undefined;
  const card = Option.getOrUndefined(decodeChoiceCard(state));
  if (card === undefined || card.answer !== null || card.replaced === true) return undefined;
  if (card.send !== undefined || card.options.length !== 2) return undefined;
  const [first, second] = card.options;
  if (first === undefined || second === undefined) return undefined;
  if (first.action !== undefined || second.action !== undefined) return undefined;
  return { question: card.question, options: [first, second] as const };
};

const HOLDER_ID = "kin-holder-";
const ASSIGN_ID = "kin-assign-";
const TAKEN_ID = "kin-default-taken:";
/** A default-taken note posted as a card (`tellTaken`), as its stored client id reads. */
const TAKEN_CARD = `send:${TAKEN_ID}`;

// APNs docs, "Handling notification responses". A 410 is handled by its timestamp instead.
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken"]);
// The token is fine; our `KIN_APNS_TOPIC` doesn't match the app that registered it.
const CONFIG_REASONS = new Set(["DeviceTokenNotForTopic", "TopicDisallowed"]);
// FCM's "Error codes for FCM": the app was removed or the token replaced.
const FCM_DEAD_REASONS = new Set(["UNREGISTERED"]);
// The token is from another Firebase project than the service account's.
const FCM_CONFIG_REASONS = new Set(["SENDER_ID_MISMATCH"]);
const SEND_CONCURRENCY = 4;

const segment = encodeURIComponent;
/** Every Kin host shares org id `kin-default`, so links name the host too (mobile spec, routes). */
export const kinPushChatLink = (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId) =>
  `/kin/${segment(environmentId)}/${segment(orgId)}/chats/${segment(chatId)}`;
/** A notice about the reader's tasks opens the one it names, or their Tasks when it names more. */
export const kinTasksSubject = (keys: ReadonlyArray<KinRecordKey>): KinPushSubject | undefined => {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return undefined;
  return unique.length === 1
    ? { _tag: "record", key: unique[0]!, kind: "task" }
    : { _tag: "tasks" };
};
// One per message, not per chat: iOS and Android make it the notification's identifier, and a
// phone acts once per identifier, so a shared id left every later tap from that chat dead.
/** Fits `apns-collapse-id`'s 64 bytes whatever the ids' length. */
const kinPushCollapseId = (orgId: KinOrgId, chatId: KinChatId, messageId: KinMessageId) =>
  `kin:${kinPushDeviceId(`${orgId}\u0000${chatId}\u0000${messageId}`)}`;
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const UNPROMPTED_RING_GAP_MS = 30 * 60_000;
/** Withdrawals for one person wait this long, so many settling at once make one silent push. */
export const KIN_WITHDRAW_BATCH = Duration.seconds(3);
/** The recovery pass runs at start and this often, over at most `RECOVER_ROWS` live rows. */
const KIN_PUSH_RECOVER_EVERY = Duration.minutes(10);
const RECOVER_ROWS = 200;
const decodeRelay = Schema.decodeUnknownOption(Schema.fromJsonString(KinMessageRelay));
const decodeTurnCards = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ messageId: KinMessageId, awaiting: Schema.Array(Schema.String) })),
  ),
);

/**
 * Whether a message concerns someone enough to ring their phone. A direct chat is theirs; in a
 * group only a mention of them, a reply to their message, or a lead's answer to what they asked
 * does (cards push on their own).
 */
const kinPushConcerns = (input: {
  readonly direct: boolean;
  readonly mentioned: boolean;
  readonly repliesToThem: boolean;
}) => input.direct || input.mentioned || input.repliesToThem;

/** Fixed text per kind: ids and numbers from the action, never the agent's reason. */
const approvalPushText = (action: KinPendingAction) => {
  switch (action.target._tag) {
    case "pull_request":
      return action.kind === "merge_pull_request"
        ? `Merge #${action.target.number} is waiting on you`
        : `A pull request action is waiting on you`;
    case "branch":
      return "Deleting a branch is waiting on you";
    case "device_key":
      return "Adding an approver key is waiting on you";
    case "level":
      return "A permission change for an agent is waiting on you";
    case "content":
      return action.kind === "memory_purge"
        ? "A memory purge is waiting on you"
        : "A rules change is waiting on you";
  }
};

import { KinPushSender } from "./KinPushSenderService.ts";

export { KinPushSender };

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const sql = yield* SqlClient.SqlClient;
  const apns = yield* KinApnsTransport;
  const fcm = yield* KinFcmTransport;
  const statusFor = (platform: KinPushPlatform) =>
    platform === "android" ? fcm.status : apns.status;
  const status: KinPushSendingStatus =
    apns.status === "ready" || fcm.status === "ready" ? "ready" : "unconfigured";
  const devices = yield* KinPushDevices;
  const presence = yield* KinPushPresence;
  const keys = yield* ApproverKeys;
  const cache = yield* MemoryCache;
  const actions = yield* KinPendingActions;
  const chats = yield* KinChatRepository;
  const topics = yield* makeKinPushTopics;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const host = segment(environmentId);
  const chatLink = (orgId: KinOrgId, chatId: KinChatId) =>
    kinPushChatLink(environmentId, orgId, chatId);

  /** People in the chat now, each with whether they muted it. */
  const chatPeople = Effect.fn("KinPushSender.chatPeople")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* sql<{
      person_id: KinPersonId;
      member_id: string;
      muted_until: string | null;
      joined_seq: number;
    }>`
      SELECT person_id, member_id, muted_until, joined_seq FROM kin_chat_members
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND principal_kind = 'person'
        AND left_at IS NULL
      ORDER BY person_id`;
    return rows.map((row) => ({
      personId: row.person_id,
      memberId: row.member_id,
      muted: row.muted_until !== null && Date.parse(row.muted_until) > now,
      joinedSeq: row.joined_seq,
    }));
  });

  /** What a chat is called on a banner: its title, or the lead a direct chat is with. */
  const chatName = Effect.fn("KinPushSender.chatName")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
  ) {
    const [row] = yield* sql<{
      kind: string;
      team_id: string | null;
      title: string | null;
      agent: string | null;
    }>`
      SELECT c.kind, c.team_id, c.title, (
          SELECT a.display_name FROM kin_chat_members m
          JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
          WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'agent'
            AND m.left_at IS NULL
          ORDER BY m.joined_at, m.member_id LIMIT 1
        ) AS agent
      FROM kin_chats c WHERE c.org_id = ${orgId} AND c.chat_id = ${chatId}`;
    const people = row !== undefined && kinIsPeopleChat({ kind: row.kind, teamId: row.team_id });
    const direct = row?.kind === "direct" || people;
    return { direct, people, name: row?.title ?? (direct ? (row?.agent ?? "Kin") : "Group") };
  });

  /**
   * Whether `personId` is in their quiet hours, or outside the working hours they hold to, now:
   * the rule that holds lines to them (`quietHold.ts`), on their own clock.
   */
  const holdNow = (orgId: KinOrgId, personId: KinPersonId) =>
    personHoldNow(orgId, personId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  /** Whose asks a turn carries out (`turnAsks`). */
  const turnOf = (orgId: KinOrgId, wakeupId: string) =>
    turnAsks(orgId, wakeupId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  /** In their quiet hours, whether an answer to what they asked at `askedAt` rings. */
  const quietAnswerRings = (orgId: KinOrgId, personId: KinPersonId, askedAt: number) =>
    answerRings(orgId, personId, askedAt).pipe(Effect.provideService(SqlClient.SqlClient, sql));

  /** The hour of the owner's day, for a brief's greeting: check-ins are his. */
  const ownerHour = Effect.fn("KinPushSender.ownerHour")(function* (orgId: KinOrgId) {
    const zone = yield* cache.ownerTimeZone(orgId);
    return kinWhenParts(yield* Clock.currentTimeMillis, zone).hour;
  });

  /**
   * Whether a rationed post may ring `personId` now: an unprompted one at most once per half hour
   * across every agent, an answer in their quiet hours once since `since` (its turn's start). One
   * that may not still lands, without a ring. Claimed here, when the push is decided.
   */
  const mayRing = Effect.fn("KinPushSender.mayRing")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    since: number | undefined,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* sql`INSERT INTO kin_push_rings (org_id, person_id, rang_at)
      VALUES (${orgId}, ${personId}, ${now})
      ON CONFLICT (org_id, person_id) DO UPDATE SET rang_at = excluded.rang_at
        WHERE kin_push_rings.rang_at < ${since ?? now - UNPROMPTED_RING_GAP_MS + 1}
      RETURNING rang_at`;
    return claimed.length > 0;
  });

  /** Whether a capped push rang `personId` since `messageId` was posted (`mayRing`'s claim). */
  const rangSince = Effect.fn("KinPushSender.rangSince")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    messageId: KinMessageId,
  ) {
    const [row] = yield* sql<{ rangAt: number; createdAt: string }>`SELECT r.rang_at AS "rangAt",
        m.created_at AS "createdAt"
      FROM kin_push_rings r JOIN kin_messages m ON m.org_id = r.org_id
        AND m.message_id = ${messageId}
      WHERE r.org_id = ${orgId} AND r.person_id = ${personId}`;
    return row !== undefined && row.rangAt >= Date.parse(row.createdAt);
  });

  /**
   * What `messageId` is about for `personId`, from the names in it they may open: what the chat
   * shows them. None when it can't be read; the push still opens the chat.
   */
  const subjectFor = Effect.fn("KinPushSender.subjectFor")(
    function* (orgId: KinOrgId, messageId: KinMessageId, personId: KinPersonId) {
      const message = yield* chats.getMessage({ orgId, messageId });
      if (Option.isNone(message)) return undefined;
      const reader = { _tag: "person", personId } as const;
      // Kin's notice of someone's late or due work names only their tasks: it opens them.
      if (
        message.value.author._tag === "system" &&
        (yield* isHolderNotice(orgId, messageId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ))
      ) {
        const [listed] = yield* withLinks(orgId, reader, [{ ...message.value, kind: "text" }]).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return kinTasksSubject(
          (listed?.links ?? []).flatMap(({ to }) =>
            to._tag === "record" && to.kind === "task" ? [to.key] : [],
          ),
        );
      }
      const [linked] = yield* withLinks(orgId, reader, [message.value]).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return linked === undefined ? undefined : (kinMessageSubject(linked) ?? undefined);
    },
    Effect.catch((error) =>
      Effect.logWarning("Kin push couldn't read its subject.", { error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

  /**
   * Kin's own notice about the reader's work ("work": given to them, due, late) or a default it
   * took for them ("decided"), posted now or after a hold (`deliverHeld`); else undefined.
   */
  const ownNotice = Effect.fn("KinPushSender.ownNotice")(function* (
    orgId: KinOrgId,
    messageId: KinMessageId,
  ) {
    const [held] = messageId.startsWith(HELD_ID)
      ? yield* sql<{ kind: string }>`SELECT kind FROM kin_held_posts
          WHERE org_id = ${orgId} AND hold_id = ${messageId.slice(HELD_ID.length)}`
      : [];
    const kind = held?.kind ?? messageId;
    if (kind.startsWith(TAKEN_ID)) return "decided" as const;
    return kind.startsWith(HOLDER_ID) || kind.startsWith(ASSIGN_ID) ? ("work" as const) : undefined;
  });

  /** The Chats list's unread total, from the same read, so the icon and the list agree. */
  const badgeFor = (orgId: KinOrgId, personId: KinPersonId) =>
    chats.unreadTotal({ orgId, personId });

  const approvalPush = Effect.fn("KinPushSender.approvalPush")(function* (
    orgId: KinOrgId,
    actionId: KinActionId,
  ) {
    const action = yield* actions.get({ orgId, actionId });
    if (Option.isNone(action) || action.value.state !== "awaiting_approval") return undefined;
    const [lead] = yield* sql<{ display_name: string }>`
      SELECT display_name FROM kin_agents
      WHERE org_id = ${orgId} AND agent_id = ${action.value.requestedBy.agentId}`;
    const deepLink = `/kin/${host}/${segment(orgId)}/actions/${segment(actionId)}`;
    // DESIGN 9.3: approvers only, read from their keys, never from the request.
    const approvers = yield* keys.activeApprovers(orgId);
    const recipients: Array<Recipient> = [];
    // An approval is asked for now: only an approver's quiet hours keep it from ringing.
    for (const personId of approvers)
      recipients.push({
        personId,
        delivery: (yield* holdNow(orgId, personId)) === "quiet" ? "quiet" : "ring",
      });
    return {
      category: "kin.approval",
      channel: "kin.questions",
      title: lead?.display_name ?? "Approval needed",
      body: approvalPushText(action.value),
      chatId: undefined,
      source: undefined,
      topic: approvalTopic(actionId),
      data: { kin: 1, orgId, pendingActionId: actionId, deepLink },
      recipients,
    } satisfies Push;
  });

  const messagePush = Effect.fn("KinPushSender.messagePush")(function* (
    orgId: KinOrgId,
    messageId: KinMessageId,
  ) {
    const [row] = yield* sql<{
      chat_id: KinChatId;
      author_kind: string;
      author_person_id: KinPersonId | null;
      author_member_id: string | null;
      author_name: string | null;
      body: string;
      form: string | null;
      mentions_json: string;
      reply_author: KinPersonId | null;
      reply_at: string | null;
      turn_id: string | null;
      awaits_card: number;
      is_card: number;
      card_type: string | null;
      timed: string | null;
      check_in: string | null;
      turn_cards: string;
      seq: number;
      relay_json: string | null;
      client_message_id: string | null;
    }>`
      SELECT m.chat_id, m.seq, m.author_kind, m.author_person_id, m.author_member_id, m.body,
        m.form, m.mentions_json, m.relay_json, m.client_message_id,
        COALESCE(
          (SELECT display_name FROM kin_agents a
            WHERE a.org_id = m.org_id AND a.agent_id = m.author_agent_id),
          (SELECT display_name FROM kin_people p
            WHERE p.org_id = m.org_id AND p.person_id = m.author_person_id)
        ) AS author_name,
        (SELECT r.author_person_id FROM kin_messages r
          WHERE r.org_id = m.org_id AND r.message_id = m.reply_to) AS reply_author,
        (SELECT r.created_at FROM kin_messages r
          WHERE r.org_id = m.org_id AND r.message_id = m.reply_to) AS reply_at,
        -- The turn that posted it: what it answers (\`turnAsks\`).
        COALESCE(m.source_wakeup_id, (SELECT k.wakeup_id FROM kin_wakeups k
          WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id AND k.status = 'running'
          ORDER BY k.started_at DESC, k.wakeup_id LIMIT 1)) AS turn_id,
        EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id AND w.closed_at IS NULL
          AND w.awaiting_json != '[]') AS awaits_card,
        EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id) AS is_card,
        (SELECT w.type FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id ORDER BY w.widget_id LIMIT 1) AS card_type,
        COALESCE((SELECT w.type FROM kin_widgets w WHERE w.org_id = m.org_id
            AND w.message_id = m.message_id AND w.type IN ('reminder', 'scheduled_task')
            ORDER BY w.widget_id LIMIT 1),
          (SELECT d.kind FROM kin_lead_deliveries d
            JOIN kin_events e ON e.org_id = d.org_id AND e.event_id = d.event_id
            JOIN kin_wakeups k ON k.org_id = e.org_id AND k.wakeup_id = e.wakeup_id
            WHERE d.org_id = m.org_id AND d.chat_id = m.chat_id
              AND d.agent_id = m.author_agent_id AND d.kind IN ('reminder', 'scheduled_task')
              AND k.status = 'running' ORDER BY d.event_id LIMIT 1)) AS timed,
        ${sql.literal(CHECK_IN_OF_MESSAGE)} AS check_in,
        -- Open cards the same running wake-up posted in this chat, oldest first.
        (SELECT COALESCE(json_group_array(json_object('messageId', t.message_id,
            'awaiting', json(t.awaiting_json))), '[]') FROM (
          SELECT c.message_id, w.awaiting_json FROM kin_wakeups k
          JOIN kin_messages c ON c.org_id = k.org_id AND c.source_wakeup_id = k.wakeup_id
            AND c.chat_id = m.chat_id AND c.message_id != m.message_id AND c.status = 'posted'
          JOIN kin_widgets w ON w.org_id = c.org_id AND w.message_id = c.message_id
            AND w.closed_at IS NULL AND w.awaiting_json != '[]'
          WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id AND k.status = 'running'
          ORDER BY c.seq) t) AS turn_cards
      FROM kin_messages m
      WHERE m.org_id = ${orgId} AND m.message_id = ${messageId} AND m.status = 'posted'
        AND m.kind != 'widget_action' AND m.silent = 0
        AND NOT (m.widget_id IS NOT NULL AND m.source_wakeup_id IS NOT NULL AND m.body != '')
        -- A key change's notice rings as that change's own push instead.
        AND NOT EXISTS (SELECT 1 FROM kin_key_pushes p
          WHERE p.org_id = m.org_id AND p.message_id = m.message_id)`;
    // A card that waits on someone announces itself through its widget push; one with no words of
    // its own (a chart, a doc) is seen in the chat and rings nobody.
    if (row === undefined || row.awaits_card === 1) return undefined;
    const relay = Option.getOrUndefined(decodeRelay(row.relay_json ?? undefined));
    const brief = relay?.personId === undefined && kinIsBrief(row.body, row.form);
    const greeting = brief ? kinGreeting(yield* ownerHour(orgId)) : undefined;
    const body = kinPushBody(
      relay?.personId !== undefined
        ? kinRelayWords(row.body)
        : greeting !== undefined
          ? `${greeting} · ${kinPageGist(row.body)}`
          : kinPageShape(row.body) === "page"
            ? kinPageGist(row.body)
            : kinPlainBody(row.body),
    );
    const own =
      row.client_message_id?.startsWith(TAKEN_CARD) === true
        ? ("decided" as const)
        : yield* ownNotice(orgId, messageId);
    const ownerTimed = row.timed !== null;
    const turnCards = yield* decodeTurnCards(row.turn_cards);
    if (row.is_card === 1 && body === "") return undefined;
    const chat = yield* chatName(orgId, row.chat_id);
    const mentions = new Set<string>(yield* decodeIds(row.mentions_json));
    const turn = row.turn_id === null ? undefined : yield* turnOf(orgId, row.turn_id);
    // When each person asked what this answers: their message it replies to, one its turn
    // carries out here, or one in an earlier turn whose work this one carries on.
    const askedAt = (personId: KinPersonId) => {
      const asked = lastAsk(turn?.asks ?? [], personId, row.chat_id);
      const replied =
        row.reply_author === personId && row.reply_at !== null
          ? Date.parse(row.reply_at)
          : undefined;
      return asked === undefined || replied === undefined
        ? (asked ?? replied)
        : Math.max(asked, replied);
    };
    const people = yield* chatPeople(orgId, row.chat_id);
    const [sender] =
      relay?.personId === undefined
        ? []
        : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
            WHERE org_id = ${orgId} AND person_id = ${relay.personId}`;
    const author =
      sender === undefined
        ? row.author_name
        : `${sender.name.split(" ")[0] ?? sender.name}, via ${row.author_name ?? "Kin"}`;
    const fromPerson = row.author_kind === "human" || sender !== undefined;
    const kind = (answers: boolean) =>
      fromPerson
        ? undefined
        : greeting !== undefined
          ? kinBriefKind(row.check_in, greeting)
          : own === "decided"
            ? "Decided for you"
            : own === "work"
              ? "Your tasks"
              : row.timed === "reminder" || row.card_type === "reminder"
                ? "Reminder"
                : row.timed === "scheduled_task" || row.card_type === "scheduled_task"
                  ? "Scheduled task"
                  : answers
                    ? "Reply"
                    : "Update";
    const candidates = people
      .filter(
        (person) =>
          person.joinedSeq <= row.seq &&
          person.personId !== row.author_person_id &&
          person.memberId !== row.author_member_id &&
          kinPushConcerns({
            // A timed line in a chat with other people is for everyone there (a shared chat's own).
            direct: chat.direct || ownerTimed,
            mentioned: mentions.has(person.memberId),
            repliesToThem: askedAt(person.personId) !== undefined,
          }),
      )
      .map((person) => ({ personId: person.personId, muted: person.muted }));
    // On their own clock: what someone timed rings at any hour. In quiet hours only an answer to
    // what they asked lately rings, once a turn; the rest arrives quietly (a teammate's word rings
    // at their end, `later`). Off hours, only a person or an answer rings. Their own work's word
    // passes the half-hour cap on Kin and agents; a muted chat sets only the badge.
    const recipients: Array<Recipient> = [];
    const later: Array<KinPersonId> = [];
    let answersAnyone = false;
    const now = yield* Clock.currentTimeMillis;
    for (const recipient of candidates) {
      const asked = askedAt(recipient.personId);
      const answers = asked !== undefined;
      answersAnyone ||= answers;
      const direct = chat.people && row.author_kind === "human";
      // In a chat with other people each reader keeps their own quiet hours.
      const hold =
        ownerTimed && chat.direct ? undefined : yield* holdNow(orgId, recipient.personId);
      if (direct && hold === "quiet" && !recipient.muted) later.push(recipient.personId);
      // A brief opens at itself; a reply whose turn left a card waiting on them, at the card.
      const card = turnCards.find((one) => one.awaiting.includes(recipient.personId));
      const subject =
        row.is_card === 1 || brief
          ? ({ _tag: "message", messageId } as const)
          : card !== undefined
            ? ({ _tag: "message", messageId: card.messageId } as const)
            : yield* subjectFor(orgId, messageId, recipient.personId);
      const told = { personId: recipient.personId, ...(subject === undefined ? {} : { subject }) };
      recipients.push(
        recipient.muted
          ? { ...told, delivery: "badge" }
          : hold === "quiet"
            ? asked !== undefined && (yield* quietAnswerRings(orgId, recipient.personId, asked))
              ? {
                  ...told,
                  delivery: "ring",
                  capped: { since: turn?.startedAt ?? now, spent: "quiet" },
                }
              : { ...told, delivery: "quiet" }
            : hold === "off" && !fromPerson && !answers
              ? { ...told, delivery: "quiet" }
              : fromPerson || answers || ownerTimed || own !== undefined
                ? { ...told, delivery: "ring" }
                : { ...told, delivery: "ring", capped: { spent: "badge" } },
      );
    }
    // Kin's notice of a trouble, or of the reader's work, is its own topic; the rest, the chat's.
    const [trouble] =
      row.author_kind === "system"
        ? yield* sql<{ cause: string }>`SELECT cause FROM kin_troubles
            WHERE org_id = ${orgId} AND trouble_id = ${messageId}`
        : [];
    const told = recipients.find((recipient) => recipient.subject !== undefined)?.subject;
    const topic =
      trouble !== undefined
        ? troubleTopic(trouble.cause)
        : own === "work" && told?._tag === "record"
          ? taskTopic(told.key)
          : own === "work" && told?._tag === "tasks"
            ? noticeTopic(messageId)
            : chatTopic(row.chat_id);
    const push: Push = {
      category: "kin.message",
      channel: brief ? "kin.briefs" : "kin.messages",
      title: kinBannerTitle(chat, author, kind(answersAnyone)),
      body: body || "New message",
      chatId: row.chat_id,
      source: messageId,
      collapseId: kinPushCollapseId(orgId, row.chat_id, messageId),
      topic,
      ...(topic === chatTopic(row.chat_id)
        ? { countTitle: chat.direct ? (author ?? chat.name) : chat.name, seq: row.seq }
        : {}),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients,
    };
    return { ...push, later: { chatId: row.chat_id, people: later } };
  });

  const widgetPush = Effect.fn("KinPushSender.widgetPush")(function* (
    orgId: KinOrgId,
    widgetId: KinWidgetId,
    covered: ReadonlyArray<KinMessageId>,
  ) {
    const [row] = yield* sql<{
      chat_id: KinChatId;
      type: string;
      revision: number;
      phase: unknown;
      state_json: string;
      awaiting_json: string;
      seq: number;
      message_id: KinMessageId;
      body: string;
      form: string | null;
      client_message_id: string | null;
      silent: number;
      author_name: string | null;
      asked: number;
      turn_id: string | null;
      check_in: string | null;
    }>`SELECT w.chat_id, w.type, w.revision, json_extract(w.state_json, '$.phase') AS phase,
        w.state_json, w.awaiting_json, m.seq, m.message_id, m.body, m.form, m.client_message_id,
        m.silent, ${sql.literal(CHECK_IN_OF_MESSAGE)} AS check_in,
        COALESCE(m.source_wakeup_id, (SELECT k.wakeup_id FROM kin_wakeups k
          WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id AND k.status = 'running'
          ORDER BY k.started_at DESC, k.wakeup_id LIMIT 1)) AS turn_id,
        EXISTS (SELECT 1 FROM kin_questions q WHERE q.org_id = w.org_id AND q.state = 'open'
          AND (q.widget_id = w.widget_id OR q.raise_widget_id = w.widget_id)
          AND q.draft_json IS NULL) AS asked,
        COALESCE(
          (SELECT display_name FROM kin_agents a
            WHERE a.org_id = m.org_id AND a.agent_id = m.author_agent_id),
          (SELECT display_name FROM kin_people p
            WHERE p.org_id = m.org_id AND p.person_id = m.author_person_id)
        ) AS author_name
      FROM kin_widgets w JOIN kin_messages m ON m.message_id = w.message_id
      WHERE w.org_id = ${orgId} AND w.widget_id = ${widgetId} AND w.closed_at IS NULL
        AND m.status = 'posted'`;
    if (row === undefined) return undefined;
    // An approval card can be posted by an agent and await anyone; its push comes from the
    // pending action and goes to approvers.
    if (row.type === "approval") return undefined;
    const state = Option.getOrNull(decodeState(row.state_json));
    // A brief that carries a card opens as the brief does on its own: under its greeting.
    const greeting = kinIsBrief(row.body, row.form)
      ? kinGreeting(yield* ownerHour(orgId))
      : undefined;
    const words =
      kinOpenQuestionWords(state, row.type === "choice" && row.asked === 1) ??
      kinCardWords(row.body, state);
    const choices = row.type === "choice" ? kinNoticeChoices(state, row.asked === 1) : undefined;
    const kind =
      choices !== undefined
        ? ({
            category: "kin.choice",
            body: [
              `${greeting === undefined ? "" : `${greeting} · `}${kinPushBody(choices.question)}`,
              ...choices.options.map(
                (option, index) => `${index + 1} · ${option.label.replace(/\s+/g, " ")}`,
              ),
            ].join("\n"),
          } as const)
        : row.type !== "deferral"
          ? ({
              category: "kin.message",
              body:
                greeting !== undefined && words !== undefined
                  ? `${greeting} · ${words}`
                  : (words ?? "A card is waiting on you"),
            } as const)
          : row.phase === "confirmed" || row.phase === null
            ? ({ category: "kin.deferral.confirmed", body: "A deferral needs a look" } as const)
            : row.phase === "heads_up"
              ? ({
                  category: "kin.deferral.heads_up",
                  body: "A deferred task is due soon.",
                } as const)
              : undefined;
    if (kind === undefined) return undefined;
    const awaiting = new Set<string>(yield* decodeIds(row.awaiting_json));
    // Whoever the turn's own words reached, rung or listed quietly, heard of the card with them:
    // one event, one notification. A word that only set their badge (muted, the half hour's ring
    // spent) told nothing.
    for (const messageId of covered) {
      const said = yield* messagePush(orgId, messageId);
      for (const recipient of said?.recipients ?? [])
        if (
          recipient.delivery === "quiet" ||
          (recipient.delivery === "ring" &&
            (recipient.capped === undefined ||
              recipient.capped.spent === "quiet" ||
              (yield* rangSince(orgId, recipient.personId, messageId))))
        )
          awaiting.delete(recipient.personId);
    }
    const chat = yield* chatName(orgId, row.chat_id);
    const people = yield* chatPeople(orgId, row.chat_id);
    const turn = row.turn_id === null ? undefined : yield* turnOf(orgId, row.turn_id);
    const now = yield* Clock.currentTimeMillis;
    const recipients: Array<Recipient> = [];
    for (const person of people) {
      if (person.joinedSeq > row.seq || !awaiting.has(person.personId)) continue;
      // A heads-up comes at the time the owner deferred the task to.
      const held = row.phase === "heads_up" ? undefined : yield* holdNow(orgId, person.personId);
      // A card its turn posted for what they asked answers them, as that turn's words do.
      const asked = lastAsk(turn?.asks ?? [], person.personId, row.chat_id);
      const subject = { _tag: "message", messageId: row.message_id } as const;
      recipients.push(
        person.muted || row.silent === 1 || held === "away"
          ? { personId: person.personId, delivery: "badge", subject }
          : held === "quiet"
            ? asked !== undefined && (yield* quietAnswerRings(orgId, person.personId, asked))
              ? {
                  personId: person.personId,
                  delivery: "ring",
                  capped: { since: turn?.startedAt ?? now, spent: "quiet" },
                  subject,
                }
              : { personId: person.personId, delivery: "quiet", subject }
            : held === "off" && asked === undefined
              ? { personId: person.personId, delivery: "quiet", subject }
              : { personId: person.personId, delivery: "ring", subject },
      );
    }
    const cardKind =
      greeting !== undefined ? kinBriefKind(row.check_in, greeting) : kinCardKind(row, state);
    // A question asked again on a new card replaces the old card's notification.
    const [question] = yield* sql<{ questionId: string }>`SELECT question_id AS "questionId"
      FROM kin_questions WHERE org_id = ${orgId} AND state = 'open'
        AND (widget_id = ${widgetId} OR raise_widget_id = ${widgetId})
      ORDER BY asked_at DESC, question_id LIMIT 1`;
    return {
      ...kind,
      channel: greeting !== undefined ? "kin.briefs" : kinCardChannel(cardKind),
      title: kinBannerTitle(chat, row.author_name, cardKind),
      chatId: row.chat_id,
      source: row.message_id,
      // A notice with buttons keeps its own banner.
      ...(kind.category === "kin.message"
        ? { collapseId: kinPushCollapseId(orgId, row.chat_id, row.message_id) }
        : {}),
      topic: question === undefined ? cardTopic(widgetId) : questionTopic(question.questionId),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        widgetId,
        revision: row.revision,
        ...(choices === undefined
          ? {}
          : { choices: [choices.options[0].optionId, choices.options[1].optionId] as const }),
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients,
    } satisfies Push;
  });

  /**
   * Whether `personId` may still hear of `messageId`, from the rows as they are now: in its chat,
   * the message still there (a clear deletes it), and one they may read (`readableBy`).
   */
  const stillReads = Effect.fn("KinPushSender.stillReads")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    chatId: KinChatId,
    messageId: KinMessageId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [member] = yield* sql<{ memberId: string }>`SELECT m.member_id AS "memberId"
          FROM kin_chat_members m JOIN kin_messages msg ON msg.org_id = m.org_id
            AND msg.chat_id = m.chat_id AND msg.message_id = ${messageId} AND msg.status = 'posted'
          JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
            AND msg.seq > c.cleared_seq
          WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND m.principal_kind = 'person'
            AND m.person_id = ${personId} AND m.left_at IS NULL
          ORDER BY m.member_id LIMIT 1`;
        if (member === undefined) return false;
        return yield* memberReads(sql, { orgId, memberId: member.memberId, messageId });
      }),
    );
  });

  // The badge each device was last sent, so a read that leaves it unchanged sends nothing.
  const shownBadge = new Map<KinPushToken, number>();

  /** What FCM's answer means for the device: sent, or failed and logged, a dead token retired. */
  const fcmOutcome = Effect.fn("KinPushSender.fcmOutcome")(function* (
    orgId: KinOrgId,
    device: KinPushDevice,
    result: { readonly status: number; readonly reason: string | undefined },
    badge: number,
  ) {
    if (result.status === 200) {
      shownBadge.set(device.token, badge);
      return "sent" as const;
    }
    const deviceId = kinPushDeviceId(device.token);
    if (FCM_DEAD_REASONS.has(result.reason ?? "")) {
      yield* devices.forget(orgId, device.token);
      yield* Effect.logInfo("Kin push device token is gone.", { deviceId, reason: result.reason });
    } else if (result.status === 429) {
      yield* Effect.logWarning("FCM is throttling Kin pushes; this one was dropped.", { deviceId });
    } else if (FCM_CONFIG_REASONS.has(result.reason ?? "")) {
      yield* Effect.logError(
        "FCM refused a Kin push: the phone's Firebase project isn't KIN_FCM_SERVICE_ACCOUNT_FILE's.",
        { deviceId, reason: result.reason },
      );
    } else {
      yield* Effect.logWarning("FCM refused a Kin push.", {
        deviceId,
        status: result.status,
        reason: result.reason,
      });
    }
    return "failed" as const;
  });

  const sendTo = Effect.fn("KinPushSender.sendTo")(function* (
    orgId: KinOrgId,
    push: Push,
    device: KinPushDevice,
    recipient: {
      readonly delivery: KinPushDelivery;
      readonly badge: number;
      readonly subject: KinPushSubject | undefined;
      /** Their unread in the push's chat, for a chat topic's count. */
      readonly unread: number;
      /** Their next version of the push's topic, taken once, by the first phone that shows it. */
      readonly version: Effect.Effect<number | undefined> | undefined;
    },
  ) {
    if (push.chatId !== undefined && (yield* presence.isWatching(device.sessionId, push.chatId)))
      return "suppressed" as const;
    // A send waits behind others; who may hear of it is decided now. One already sent stays sent.
    if (
      push.chatId !== undefined &&
      (push.source === undefined ||
        !(yield* stillReads(orgId, device.personId, push.chatId, push.source)))
    )
      return "dropped" as const;
    if (statusFor(device.platform) === "unconfigured") return "skipped" as const;
    // A build that matches by topic: the push replaces the last about the same thing, and says
    // how many are unread in a chat it stands for.
    const topical = device.withdraws;
    const version =
      topical && recipient.delivery !== "badge" && recipient.version !== undefined
        ? yield* recipient.version
        : undefined;
    const data = {
      ...push.data,
      ...(recipient.subject === undefined ? {} : { subject: recipient.subject }),
      ...(topical ? { topic: push.topic } : {}),
      ...(version === undefined ? {} : { version }),
    };
    const collapseId = topical
      ? kinTopicCollapseId(environmentId, orgId, push.topic)
      : push.collapseId;
    const title =
      topical && push.countTitle !== undefined && recipient.unread > 1
        ? `${push.countTitle} · ${recipient.unread} new`
        : push.title;
    if (device.platform === "android") {
      // An Android launcher counts the banners shown, so a badge-only push would show nothing. A
      // build without the quiet channel would draw a quiet one in Expo's loud fallback channel.
      if (
        recipient.delivery === "badge" ||
        (recipient.delivery === "quiet" && !device.quietChannel)
      )
        return "skipped" as const;
      const encoded = yield* encodeJson(data);
      // Data only: the app draws the banner, with its category's buttons, even when killed.
      const message = (body: string) => ({
        title,
        message: body,
        // expo-notifications reads a remote push's `content.data` from `body`, as on iOS.
        body: encoded,
        categoryId: push.category,
        channelId: recipient.delivery === "quiet" ? "kin.quiet" : push.channel,
        badge: String(recipient.badge),
        ...(push.chatId === undefined ? {} : { threadIdentifier: `kin:${orgId}:${push.chatId}` }),
        // The shown banner with this tag is replaced, as `apns-collapse-id` replaces on iOS.
        ...(collapseId === undefined ? {} : { tag: collapseId }),
      });
      const result = yield* fcm.send({
        token: device.token,
        priority: "HIGH",
        data: message(kinPushFit(push.body, KIN_FCM_DATA_MAX - dataBytes(message("")))),
      });
      return yield* fcmOutcome(orgId, device, result, recipient.badge);
    }
    const payload = (body: string) => ({
      aps:
        recipient.delivery === "badge"
          ? { badge: recipient.badge }
          : {
              alert: { title, body },
              badge: recipient.badge,
              category: push.category,
              // Passive: listed in Notification Center with no sound, banner or lit screen.
              ...(recipient.delivery === "ring"
                ? { sound: "default" }
                : { "interruption-level": "passive" }),
              ...(push.chatId === undefined ? {} : { "thread-id": `kin:${orgId}:${push.chatId}` }),
            },
      // expo-notifications reads a remote push's `content.data` from `body`.
      body: data,
    });
    const result = yield* apns.send({
      token: device.token,
      environment: device.apsEnvironment,
      // A badge-only push must not replace the banner a loud one left under the same id.
      ...(collapseId === undefined || recipient.delivery === "badge" ? {} : { collapseId }),
      payload: payload(kinPushFit(push.body, KIN_APNS_PAYLOAD_MAX - jsonBytes(payload("")))),
    });
    if (result.status === 200) {
      shownBadge.set(device.token, recipient.badge);
      return "sent" as const;
    }
    const deviceId = kinPushDeviceId(device.token);
    if (result.status === 410) {
      yield* devices.forget(orgId, device.token, result.timestamp);
      yield* Effect.logInfo("Kin push device token is gone.", { deviceId, reason: result.reason });
    } else if (DEAD_TOKEN_REASONS.has(result.reason ?? "")) {
      yield* devices.forget(orgId, device.token);
      // Often a token sent to the wrong APNs environment, so say which one it went to.
      yield* Effect.logWarning("APNs called a Kin push device token bad; it was removed.", {
        deviceId,
        reason: result.reason,
        environment: device.apsEnvironment,
      });
    } else if (result.status === 429) {
      yield* Effect.logWarning("APNs is throttling Kin pushes; this one was dropped.", {
        deviceId,
        reason: result.reason,
      });
    } else if (CONFIG_REASONS.has(result.reason ?? "")) {
      yield* Effect.logError("APNs refused a Kin push: check KIN_APNS_TOPIC.", {
        deviceId,
        reason: result.reason,
      });
    } else {
      yield* Effect.logWarning("APNs refused a Kin push.", {
        deviceId,
        status: result.status,
        reason: result.reason,
      });
    }
    return "failed" as const;
  });

  const deliver = Effect.fn("KinPushSender.deliver")(function* (orgId: KinOrgId, push: Push) {
    const targets = (yield* devices.forPeople(
      orgId,
      push.recipients.map((recipient) => recipient.personId),
    )).filter(
      // A phone whose platform has no sender gets nothing, and so spends no ring.
      (device) => device.sessionId !== push.exceptSession && statusFor(device.platform) === "ready",
    );
    // Who a version was taken for: checked once more after the sends (`recheck`).
    const reserved = new Set<KinPersonId>();
    const recipients = new Map<
      KinPersonId,
      {
        delivery: KinPushDelivery;
        badge: number;
        subject: KinPushSubject | undefined;
        unread: number;
        version: Effect.Effect<number | undefined> | undefined;
      }
    >();
    // A chat's own topic says how many are unread there, to a build that replaces by topic.
    const counted =
      push.chatId !== undefined &&
      push.topic === chatTopic(push.chatId) &&
      targets.some((device) => device.withdraws)
        ? push.chatId
        : undefined;
    for (const recipient of push.recipients) {
      let delivery = recipient.delivery;
      // A rationed ring is spent only on a phone that will show it, so a push decided before
      // they had one, or while they watch the chat, leaves it for the next.
      if (recipient.capped !== undefined && delivery === "ring") {
        let shows = false;
        for (const device of targets)
          if (
            device.personId === recipient.personId &&
            (push.chatId === undefined ||
              !(yield* presence.isWatching(device.sessionId, push.chatId)))
          )
            shows = true;
        if (shows && !(yield* mayRing(orgId, recipient.personId, recipient.capped.since)))
          delivery = recipient.capped.spent;
      }
      recipients.set(recipient.personId, {
        delivery,
        badge: yield* badgeFor(orgId, recipient.personId),
        subject: recipient.subject,
        unread:
          counted === undefined ? 0 : yield* topics.unreadIn(orgId, recipient.personId, counted),
        // Taken only when a phone that matches by topic shows it. A unique topic has none.
        version: push.topic.startsWith("u:")
          ? undefined
          : yield* Effect.cached(
              topics
                .reserve({
                  orgId,
                  personId: recipient.personId,
                  topic: push.topic,
                  chatId: push.chatId,
                  messageId: push.source,
                  seq: push.seq,
                  about: push.about,
                })
                .pipe(
                  Effect.tap(() => Effect.sync(() => reserved.add(recipient.personId))),
                  Effect.catch((error) =>
                    Effect.logWarning("Kin couldn't note a push it sends.", {
                      error: error._tag,
                    }).pipe(Effect.as(undefined)),
                  ),
                ),
            ),
      });
    }
    // Bounded, so one slow device doesn't hold up the rest and a big org doesn't flood APNs.
    const results = yield* Effect.forEach(
      targets,
      (device) => {
        const recipient = recipients.get(device.personId);
        return recipient === undefined
          ? Effect.succeed("failed" as const)
          : sendTo(orgId, push, device, recipient);
      },
      { concurrency: SEND_CONCURRENCY },
    );
    // What settled while this was with the gateway, before its row stood to be found: withdrawn now.
    if (reserved.size > 0)
      yield* topics.live(orgId, { topics: [push.topic] }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows.filter((row) => reserved.has(row.personId)),
            (row) =>
              topics
                .stands(orgId, row)
                .pipe(Effect.flatMap((stands) => (stands ? Effect.void : enqueue(orgId, [row])))),
            { discard: true },
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Kin couldn't recheck a push it sent.", { error: error._tag }),
        ),
      );
    const count = (outcome: (typeof results)[number]) =>
      results.filter((result) => result === outcome).length;
    return { sent: count("sent"), suppressed: count("suppressed"), failed: count("failed") };
  });

  const batches = yield* FiberSet.make<void, never>();
  /** Each person's settled rows waiting for their batch to go, by org and person. */
  const waiting = new Map<
    string,
    {
      readonly orgId: KinOrgId;
      readonly personId: KinPersonId;
      readonly rows: Map<KinPushTopic, KinPushSentRow>;
    }
  >();

  const withdrawalData = (
    orgId: KinOrgId,
    withdraw: ReadonlyArray<KinPushWithdrawn>,
  ): KinPushData => ({
    kin: 1,
    orgId,
    deepLink: `/kin/${host}/${segment(orgId)}/work`,
    ...(withdraw.length === 0 ? {} : { withdraw }),
  });

  /** Topics in lists that each fit one silent push on either platform. */
  const fitted = (orgId: KinOrgId, withdraw: ReadonlyArray<KinPushWithdrawn>) => {
    const lists: Array<Array<KinPushWithdrawn>> = [];
    let list: Array<KinPushWithdrawn> = [];
    for (const topic of withdraw) {
      if (
        list.length > 0 &&
        (list.length >= KIN_PUSH_TOPICS_MAX ||
          jsonBytes(withdrawalData(orgId, [...list, topic])) > WITHDRAW_PAYLOAD_MAX)
      ) {
        lists.push(list);
        list = [];
      }
      list.push(topic);
    }
    return list.length === 0 && lists.length > 0 ? lists : [...lists, list];
  };

  /**
   * A silent push to one phone that matches by topic: it removes `withdraw`'s notifications and,
   * on iOS, sets the badge. With nothing to withdraw it goes only to move an iOS badge.
   */
  const sendWithdrawal = Effect.fn("KinPushSender.sendWithdrawal")(function* (
    orgId: KinOrgId,
    device: KinPushDevice,
    withdraw: ReadonlyArray<KinPushWithdrawn>,
    badge: number,
  ) {
    // Taken: the gateway accepted it, or the phone is gone and shows nothing any more.
    let taken = true;
    if (device.platform === "android") {
      if (withdraw.length === 0) return taken;
      for (const list of fitted(orgId, withdraw)) {
        const encoded = yield* encodeJson(withdrawalData(orgId, list));
        const result = yield* fcm.send({
          token: device.token,
          priority: "NORMAL",
          data: { body: encoded },
        });
        yield* fcmOutcome(orgId, device, result, badge);
        if (result.status !== 200 && !FCM_DEAD_REASONS.has(result.reason ?? "")) taken = false;
      }
      return taken;
    }
    if (withdraw.length === 0 && shownBadge.get(device.token) === badge) return taken;
    for (const list of fitted(orgId, withdraw)) {
      // Apple's background push carries no badge of its own: the app sets it when woken.
      const result = yield* apns.send({
        token: device.token,
        environment: device.apsEnvironment,
        background: true,
        payload: {
          aps: { "content-available": 1 },
          body: { ...withdrawalData(orgId, list), badge },
        },
      });
      if (result.status === 200) shownBadge.set(device.token, badge);
      else if (result.status !== 410 && !DEAD_TOKEN_REASONS.has(result.reason ?? "")) taken = false;
    }
    return taken;
  });

  /** Withdraws what in one person's batch is settled now, once, and tells their phones. */
  const flushWithdrawals = Effect.fn("KinPushSender.flushWithdrawals")(function* (key: string) {
    const batch = waiting.get(key);
    waiting.delete(key);
    if (batch === undefined) return;
    const { orgId, personId } = batch;
    // As they are now: a newer version sent since is checked, and withdrawn, as itself.
    const settled: Array<KinPushSentRow> = [];
    if (batch.rows.size > 0)
      for (const row of yield* topics.live(orgId, { topics: [...batch.rows.keys()], personId }))
        if (!(yield* topics.stands(orgId, row))) settled.push(row);
    const withdraw = settled.map((row) => ({ topic: row.topic, version: row.version }));
    // Withdrawals are silent, so quiet hours never hold one.
    const targets = (yield* devices.forPeople(orgId, [personId])).filter(
      (device) => device.withdraws && statusFor(device.platform) === "ready",
    );
    const badge = targets.length === 0 ? 0 : yield* badgeFor(orgId, personId);
    const taken = yield* Effect.forEach(
      targets,
      (device) => sendWithdrawal(orgId, device, withdraw, badge),
      { concurrency: SEND_CONCURRENCY },
    );
    // Marked only once every phone's gateway took it; else the recovery pass sends it again.
    const sent = taken.every(Boolean);
    if (sent) for (const row of settled) yield* topics.withdraw(orgId, row);
    if (settled.length > 0)
      yield* Effect.logInfo("Kin push withdraws settled notifications", {
        orgId,
        personId,
        topics: withdraw.map((one) => `${one.topic}@${one.version}`),
        devices: targets.length,
        sent,
      });
  });

  /** Adds rows to their people's batches; `badgeOf` gets a batch even with none, for its badge. */
  const enqueue = Effect.fn("KinPushSender.enqueue")(function* (
    orgId: KinOrgId,
    rows: ReadonlyArray<KinPushSentRow>,
    badgeOf?: KinPersonId,
  ) {
    const people = [
      ...rows.map((row) => row.personId),
      ...(badgeOf === undefined ? [] : [badgeOf]),
    ];
    for (const personId of people) {
      const key = `${orgId}\u0000${personId}`;
      if (waiting.has(key)) continue;
      waiting.set(key, { orgId, personId, rows: new Map() });
      yield* Effect.sleep(KIN_WITHDRAW_BATCH).pipe(
        Effect.andThen(flushWithdrawals(key)),
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin push couldn't withdraw settled notifications.", { cause }),
        ),
        FiberSet.run(batches),
      );
    }
    for (const row of rows) waiting.get(`${orgId}\u0000${row.personId}`)?.rows.set(row.topic, row);
  });

  const settle = Effect.fn("KinPushSender.settle")(
    function* (orgId: KinOrgId, settled: KinPushSettled) {
      yield* enqueue(orgId, yield* topics.live(orgId, settled));
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin push couldn't read what settled.", { cause }),
    ),
  );

  let recovered: { readonly sentAt: number; readonly rowid: number } | undefined;
  const recover = Effect.fn("KinPushSender.recover")(
    function* () {
      const rows = yield* topics.due(recovered, RECOVER_ROWS);
      const last = rows.at(-1);
      recovered =
        rows.length < RECOVER_ROWS || last === undefined
          ? undefined
          : { sentAt: last.sentAt, rowid: last.rowid };
      for (const row of rows)
        if (!(yield* topics.stands(row.orgId, row))) yield* enqueue(row.orgId, [row]);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin push couldn't look for settled notifications.", { cause }),
    ),
  );

  const reconcile = Effect.fn("KinPushSender.reconcile")(
    function* (orgId: KinOrgId, personId: KinPersonId, asked: ReadonlyArray<KinPushTopic>) {
      const { remove, unknown } = yield* topics.settledOf(orgId, personId, asked);
      return { remove, unknown, badge: yield* badgeFor(orgId, personId) };
    },
    Effect.catch((error) =>
      Effect.logWarning("Kin push reconcile failed.", { error: error._tag }).pipe(
        Effect.andThen(
          Effect.fail(
            new KinPushError({
              reason: "unavailable",
              message: "Kin couldn't check notifications.",
            }),
          ),
        ),
      ),
    ),
  );

  /**
   * A badge-only push to the reader's other devices that don't match by topic; the one reading
   * watches the chat. It wakes the app too, which takes the chat's banners off the pane once
   * nothing in it is unread. Phones that match by topic hear of it in the reader's batch.
   */
  const readBadge = Effect.fn("KinPushSender.readBadge")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    memberId: KinMemberId,
  ) {
    const [row] = yield* sql<{ person_id: KinPersonId }>`
      SELECT person_id FROM kin_chat_members
      WHERE org_id = ${orgId} AND chat_id = ${chatId} AND member_id = ${memberId}
        AND principal_kind = 'person' AND left_at IS NULL`;
    if (row === undefined) return { sent: 0, suppressed: 0, failed: 0 };
    yield* enqueue(
      orgId,
      yield* topics.live(orgId, { chatId, topics: [chatTopic(chatId)], personId: row.person_id }),
      row.person_id,
    );
    const badge = yield* badgeFor(orgId, row.person_id);
    const cleared = (yield* chats.unreadCount({ orgId, chatId, memberId })) === 0;
    const targets = (yield* devices.forPeople(orgId, [row.person_id])).filter(
      (device) => !device.withdraws,
    );
    const data: KinPushData = {
      kin: 1,
      orgId,
      chatId,
      deepLink: chatLink(orgId, chatId),
      ...(cleared ? { cleared: true } : {}),
    };
    const encoded = yield* encodeJson(data);
    const results = yield* Effect.forEach(
      targets,
      Effect.fnUntraced(function* (device) {
        if (shownBadge.get(device.token) === badge) return "suppressed" as const;
        if (yield* presence.isWatching(device.sessionId, chatId)) return "suppressed" as const;
        if (statusFor(device.platform) === "unconfigured") return "skipped" as const;
        if (device.platform === "android") {
          // Only to take the chat's banners off: an Android launcher's count follows them.
          if (!cleared) return "skipped" as const;
          const result = yield* fcm.send({
            token: device.token,
            priority: "NORMAL",
            data: { body: encoded },
          });
          return yield* fcmOutcome(orgId, device, result, badge);
        }
        const result = yield* apns.send({
          token: device.token,
          environment: device.apsEnvironment,
          payload: { aps: { badge, "content-available": 1 }, body: data },
        });
        if (result.status !== 200) return "failed" as const;
        shownBadge.set(device.token, badge);
        return "sent" as const;
      }),
      { concurrency: SEND_CONCURRENCY },
    );
    const count = (outcome: (typeof results)[number]) =>
      results.filter((result) => result === outcome).length;
    return { sent: count("sent"), suppressed: count("suppressed"), failed: count("failed") };
  });

  /**
   * What someone did to the recipient's tasks on their own screen, as Kin's own words: in no chat,
   * so it leaves the badge as it is. Their mute of the chat it once came in leaves only the badge, and
   * like any unprompted post it rings once per half hour.
   */
  const tasksPush = Effect.fn("KinPushSender.tasksPush")(function* (
    orgId: KinOrgId,
    holdIds: ReadonlyArray<string>,
  ) {
    const news = yield* taskNewsBanner(orgId, holdIds).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (news === undefined) return undefined;
    const muted =
      news.chatId !== undefined &&
      (yield* chatPeople(orgId, news.chatId)).some(
        (person) => person.personId === news.personId && person.muted,
      );
    const subject: KinPushSubject =
      news.opens === undefined
        ? { _tag: "tasks" }
        : { _tag: "record", key: news.opens.key, kind: news.opens.project ? "project" : "task" };
    const base = `/kin/${host}/${segment(orgId)}`;
    return {
      category: "kin.message",
      channel: "kin.messages",
      title: "Tasks",
      body: news.body,
      chatId: undefined,
      source: undefined,
      // Several tasks: tracked by which, so it goes once the last no longer stands for them.
      topic: news.opens === undefined ? bundleTopic(holdIds) : taskTopic(news.opens.key),
      ...(news.opens === undefined ? { about: news.tasks.map((key) => `task:${key}`) } : {}),
      data: {
        kin: 1,
        orgId,
        deepLink:
          news.opens === undefined
            ? `${base}/work`
            : `${base}/${news.opens.project ? "projects" : "work"}/${segment(news.opens.key)}`,
      },
      // Work now theirs always rings; the rest of what was done to their tasks, once a half hour.
      recipients: [
        {
          personId: news.personId,
          delivery: muted ? "badge" : "ring",
          ...(news.gives ? {} : { capped: { spent: "badge" } }),
          subject,
        },
      ],
    } satisfies Push;
  });

  /**
   * A teammate's direct messages that landed in the reader's quiet hours (`later`), as one banner
   * when those end: the one message, or how many, of those still unread.
   */
  const dmPush = Effect.fn("KinPushSender.dmPush")(function* (
    orgId: KinOrgId,
    holdIds: ReadonlyArray<string>,
  ) {
    if (holdIds.length === 0) return undefined;
    const held = yield* sql<{ personId: KinPersonId; chatId: KinChatId; messageId: string }>`
      SELECT person_id AS "personId", chat_id AS "chatId", body AS "messageId"
      FROM kin_held_posts WHERE org_id = ${orgId} AND hold_id IN ${sql.in(holdIds)}
        AND substr(kind, 1, ${DM_NEWS.length}) = ${DM_NEWS}
      ORDER BY held_at, rowid`;
    const first = held[0];
    if (first === undefined) return undefined;
    const [reader] = (yield* chatPeople(orgId, first.chatId)).filter(
      (person) => person.personId === first.personId,
    );
    if (reader === undefined) return undefined;
    const unread = yield* sql<{
      messageId: KinMessageId;
      seq: number;
      body: string;
      name: string | null;
    }>`
      SELECT m.message_id AS "messageId", m.seq, m.body, p.display_name AS name FROM kin_messages m
      LEFT JOIN kin_people p ON p.org_id = m.org_id AND p.person_id = m.author_person_id
      WHERE m.org_id = ${orgId} AND m.chat_id = ${first.chatId} AND m.status = 'posted'
        AND m.message_id IN ${sql.in(held.filter((row) => row.chatId === first.chatId).map((row) => row.messageId))}
        AND m.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r
          WHERE r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.member_id = ${reader.memberId}), 0)
      ORDER BY m.seq`;
    const [oldest] = unread;
    if (oldest === undefined) return undefined;
    const name = oldest.name ?? "Someone";
    const one = kinPushBody(kinPlainBody(oldest.body));
    return {
      category: "kin.message",
      channel: "kin.messages",
      title: name,
      body: unread.length === 1 && one !== "" ? one : `${name} sent ${unread.length} messages`,
      chatId: first.chatId,
      source: oldest.messageId,
      collapseId: kinPushCollapseId(orgId, first.chatId, oldest.messageId),
      topic: chatTopic(first.chatId),
      countTitle: name,
      seq: unread.at(-1)!.seq,
      data: { kin: 1, orgId, chatId: first.chatId, deepLink: chatLink(orgId, first.chatId) },
      recipients: [
        {
          personId: first.personId,
          delivery: reader.muted ? "badge" : "ring",
          subject: { _tag: "message", messageId: oldest.messageId },
        },
      ],
    } satisfies Push;
  });

  /** Holds a ring `messagePush` kept from a reader in their quiet hours, for `deliverHeld`. */
  const holdDm = Effect.fn("KinPushSender.holdDm")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
    chatId: KinChatId,
    messageId: KinMessageId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const at = yield* personQuietUntil(orgId, personId, now).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (at === undefined) return;
    const kind = `${DM_NEWS}${messageId}`;
    yield* sql`INSERT INTO kin_held_posts (hold_id, org_id, chat_id, person_id, kind, body,
        audience, held_at, deliver_at)
      SELECT ${SecureRandom.uuidV4Unsafe()}, ${orgId}, ${chatId}, ${personId}, ${kind},
        ${messageId}, 'chat', ${now}, ${at}
      WHERE NOT EXISTS (SELECT 1 FROM kin_held_posts WHERE org_id = ${orgId}
        AND person_id = ${personId} AND kind = ${kind})`;
  });

  const devicePush = Effect.fn("KinPushSender.devicePush")(function* (
    orgId: KinOrgId,
    sessionId: string,
  ) {
    // Told only while it is still signed in: a device removed meanwhile has nothing to warn of.
    const [row] = yield* sql<{ person_id: KinPersonId }>`
      SELECT b.person_id FROM kin_session_bindings b
      JOIN auth_sessions a ON a.session_id = b.session_id
      WHERE b.org_id = ${orgId} AND b.session_id = ${sessionId} AND b.revoked_at IS NULL
        AND a.revoked_at IS NULL AND a.expires_at > ${DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))}`;
    if (row === undefined) return undefined;
    const push: Push = {
      category: "kin.message",
      channel: "kin.account",
      title: "New device linked",
      body: KIN_DEVICE_LINKED_NOTICE,
      chatId: undefined,
      source: undefined,
      topic: uniqueTopic(`device-${kinPushDeviceId(sessionId)}`),
      data: {
        kin: 1,
        orgId,
        deepLink: `/kin/${host}/${segment(orgId)}/people/${segment(row.person_id)}/devices`,
      },
      // Someone else signing in as them rings through quiet hours.
      recipients: [{ personId: row.person_id, delivery: "ring" }],
      exceptSession: sessionId,
    };
    return push;
  });

  const nothing: KinPushOutcome = { status, sent: 0, suppressed: 0, failed: 0 };

  /**
   * Each person's banner for the chat that shows `messageId`: replaced, never rung, by their newest
   * message still unread among those it covers, with that message's own push; with none left, or
   * none they would be told of, it goes in their batch.
   */
  const restate = Effect.fn("KinPushSender.restate")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    messageId: KinMessageId,
  ) {
    const topic = chatTopic(chatId);
    const rows = (yield* topics.live(orgId, { topics: [topic] })).filter(
      (row) => row.messageId === messageId,
    );
    const total = { sent: 0, suppressed: 0, failed: 0 };
    for (const row of rows) {
      const [newest] = yield* sql<{ message_id: KinMessageId }>`SELECT m.message_id
        FROM kin_messages m
        JOIN kin_chats c ON c.org_id = m.org_id AND c.chat_id = m.chat_id
        JOIN kin_chat_members p ON p.org_id = m.org_id AND p.chat_id = m.chat_id
          AND p.principal_kind = 'person' AND p.person_id = ${row.personId} AND p.left_at IS NULL
        WHERE m.org_id = ${orgId} AND m.chat_id = ${chatId} AND m.status = 'posted'
          AND m.silent = 0 AND m.kind = 'text' AND m.seq > c.cleared_seq
          AND m.seq <= ${row.seq ?? Number.MAX_SAFE_INTEGER}
          AND m.seq > COALESCE((SELECT r.last_read_seq FROM kin_read_state r
            WHERE r.org_id = m.org_id AND r.chat_id = m.chat_id AND r.member_id = p.member_id), 0)
        ORDER BY m.seq DESC LIMIT 1`;
      const push = newest === undefined ? undefined : yield* messagePush(orgId, newest.message_id);
      const told = push?.recipients.find((one) => one.personId === row.personId);
      if (push === undefined || push.topic !== topic || told === undefined) {
        yield* enqueue(orgId, [row]);
        continue;
      }
      const outcome = yield* deliver(orgId, {
        ...push,
        recipients: [{ ...told, delivery: told.delivery === "badge" ? "badge" : "quiet" }],
      });
      total.sent += outcome.sent;
      total.suppressed += outcome.suppressed;
      total.failed += outcome.failed;
    }
    return total;
  });

  const run = Effect.fn("KinPushSender.run")(
    function* (notification: KinPushNotification) {
      if (status === "unconfigured") return nothing;
      if (notification._tag === "restate")
        return {
          status,
          ...(yield* restate(notification.orgId, notification.chatId, notification.messageId)),
        };
      if (notification._tag === "read") {
        const outcome: KinPushOutcome = {
          status,
          ...(yield* readBadge(notification.orgId, notification.chatId, notification.memberId)),
        };
        return outcome;
      }
      const push =
        notification._tag === "approval"
          ? yield* approvalPush(notification.orgId, notification.actionId)
          : notification._tag === "device"
            ? yield* devicePush(notification.orgId, notification.sessionId)
            : notification._tag === "tasks"
              ? yield* tasksPush(notification.orgId, notification.holdIds)
              : notification._tag === "dm"
                ? yield* dmPush(notification.orgId, notification.holdIds)
                : notification._tag === "message"
                  ? yield* messagePush(notification.orgId, notification.messageId).pipe(
                      // A ring a teammate's message waits on, until the reader's quiet hours end.
                      Effect.tap((said) =>
                        said === undefined
                          ? Effect.void
                          : Effect.forEach(said.later.people, (personId) =>
                              holdDm(
                                notification.orgId,
                                personId,
                                said.later.chatId,
                                notification.messageId,
                              ),
                            ),
                      ),
                    )
                  : yield* widgetPush(
                      notification.orgId,
                      notification.widgetId,
                      notification.covered ?? [],
                    );
      if (push === undefined || push.recipients.length === 0) return nothing;
      const outcome: KinPushOutcome = {
        status,
        ...(yield* deliver(notification.orgId, push)),
      };
      return outcome;
    },
    Effect.catch((error) =>
      Effect.logWarning("Kin push failed.", { error: error._tag }).pipe(
        Effect.as({ ...nothing, failed: 1 }),
      ),
    ),
  );

  const notify = Effect.fn("KinPushSender.notify")(function* (notification: KinPushNotification) {
    return yield* Effect.forkIn(run(notification), scope);
  });

  const flushKeyPushes = Effect.fn("KinPushSender.flushKeyPushes")(
    function* () {
      // A scan across orgs, at start and after each key change: whatever is still owed.
      const owed = yield* sql<{
        org_id: KinOrgId;
        thumbprint: string;
        change: string;
        body: string;
        human_id: KinPersonId;
      }>`SELECT p.org_id, p.thumbprint, p.change, p.body, k.human_id FROM kin_key_pushes p
        JOIN kin_approver_keys k ON k.org_id = p.org_id AND k.thumbprint = p.thumbprint
        WHERE p.sent_at IS NULL ORDER BY p.owed_at, p.org_id, p.thumbprint, p.change`;
      let settled = 0;
      for (const row of owed) {
        const sent = Effect.gen(function* () {
          if (status === "ready")
            yield* deliver(row.org_id, {
              category: "kin.message",
              channel: "kin.account",
              title: "Kin approvals",
              // The server's own text, whole, so where to remove the phone is never cut off.
              body: row.body,
              chatId: undefined,
              source: undefined,
              topic: uniqueTopic(`key-${kinPushDeviceId(`${row.thumbprint}\u0000${row.change}`)}`),
              data: {
                kin: 1,
                orgId: row.org_id,
                deepLink: `/kin/${host}/${segment(row.org_id)}/approvals`,
              },
              // A phone that can approve came or went: it rings through quiet hours.
              recipients: [{ personId: row.human_id, delivery: "ring" }],
            });
          yield* sql`UPDATE kin_key_pushes SET sent_at = ${yield* Clock.currentTimeMillis}
            WHERE org_id = ${row.org_id} AND thumbprint = ${row.thumbprint}
              AND change = ${row.change} AND sent_at IS NULL`;
          settled++;
        });
        // Left owed, it goes again at the next key change or start.
        yield* sent.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Kin key change push failed.", { error: error._tag }),
          ),
        );
      }
      return settled;
    },
    Effect.catch((error) =>
      Effect.logWarning("Kin couldn't read owed key pushes.", { error: error._tag }).pipe(
        Effect.as(0),
      ),
    ),
  );

  return KinPushSender.of({
    status,
    statusFor,
    notify,
    flushKeyPushes: flushKeyPushes(),
    settle,
    reconcile,
    drainWithdrawals: FiberSet.awaitEmpty(batches),
    recover: recover(),
  });
});

export const layer = Layer.effect(KinPushSender, make);

/** The recovery pass, at start and every `KIN_PUSH_RECOVER_EVERY`, for as long as Kin runs. */
export const recoverLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sender = yield* KinPushSender;
    yield* sender.recover.pipe(
      Effect.repeat(Schedule.spaced(KIN_PUSH_RECOVER_EVERY)),
      Effect.forkScoped,
    );
  }),
);
