import type {
  EnvironmentId,
  KinActionId,
  KinChatId,
  KinMemberId,
  KinMessageId,
  KinOrgId,
  KinPendingAction,
  KinPersonId,
  KinPushCategory,
  KinPushData,
  KinPushSendingStatus,
  KinPushSubject,
  KinPushToken,
  KinRecordKey,
  KinWidgetId,
} from "@t3tools/contracts";
import {
  KIN_DEVICE_LINKED_NOTICE,
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
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import { personHoldNow } from "../triggers/quietHold.ts";
import { taskNewsBanner } from "../work/assignNotices.ts";
import { KinApnsTransport } from "./Apns.ts";
import { KinPushDevices, kinPushDeviceId, type KinPushDevice } from "./KinPushDevices.ts";
import { KinPushPresence } from "./KinPushPresence.ts";

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
 * Silent recipients get the badge only: no banner, no sound. A `capped` one rings at most once per
 * half hour, claimed only when the push reaches a phone of theirs (`deliver`).
 */
type Recipient = {
  readonly personId: KinPersonId;
  readonly silent: boolean;
  readonly capped?: true;
  /** What a tap opens for them, from what they may open. */
  readonly subject?: KinPushSubject;
};

type Push = {
  readonly category: KinPushCategory;
  readonly title: string;
  readonly body: string;
  readonly chatId: KinChatId | undefined;
  /** The message, or card's anchor, it tells of: each send checks the recipient still reads it. */
  readonly source: KinMessageId | undefined;
  /** Message pushes collapse per chat, so a busy chat shows one banner. */
  readonly collapseId?: string;
  readonly data: KinPushData;
  readonly recipients: ReadonlyArray<Recipient>;
  /** A device the push is about, which needs no word of itself. */
  readonly exceptSession?: string;
};

/** APNs refuses a regular push whose JSON payload is longer than this many bytes. */
const KIN_APNS_PAYLOAD_MAX = 4096;

const utf8 = new TextEncoder();
const jsonBytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length;
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

/** A banner's title: who wrote it, and in a group the group's name before them. */
const kinBannerTitle = (
  chat: { readonly direct: boolean; readonly name: string },
  author: string | null,
) =>
  chat.direct ? (author ?? chat.name) : author === null ? chat.name : `${chat.name} · ${author}`;

// APNs docs, "Handling notification responses". A 410 is handled by its timestamp instead.
const DEAD_TOKEN_REASONS = new Set(["BadDeviceToken"]);
// The token is fine; our `KIN_APNS_TOPIC` doesn't match the app that registered it.
const CONFIG_REASONS = new Set(["DeviceTokenNotForTopic", "TopicDisallowed"]);
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
/** Fits `apns-collapse-id`'s 64 bytes whatever the ids' length. */
const kinPushCollapseId = (orgId: KinOrgId, chatId: KinChatId) =>
  `kin:${kinPushDeviceId(`${orgId}\u0000${chatId}`)}`;
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const UNPROMPTED_RING_GAP_MS = 30 * 60_000;
const decodeRelay = Schema.decodeUnknownOption(Schema.fromJsonString(KinMessageRelay));

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

export class KinPushSender extends Context.Service<
  KinPushSender,
  {
    readonly status: KinPushSendingStatus;
    /** Call after the commit; it sends in the background, outliving the request, and never fails. */
    readonly notify: (
      notification: KinPushNotification,
    ) => Effect.Effect<Fiber.Fiber<KinPushOutcome>>;
    /** Sends every push an approver key change still owes, then settles it. Returns how many. */
    readonly flushKeyPushes: Effect.Effect<number>;
  }
>()("t3/kin/push/KinPushSender") {}

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const sql = yield* SqlClient.SqlClient;
  const apns = yield* KinApnsTransport;
  const devices = yield* KinPushDevices;
  const presence = yield* KinPushPresence;
  const keys = yield* ApproverKeys;
  const cache = yield* MemoryCache;
  const actions = yield* KinPendingActions;
  const chats = yield* KinChatRepository;
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

  /** The hour of the owner's day, for a brief's greeting: check-ins are his. */
  const ownerHour = Effect.fn("KinPushSender.ownerHour")(function* (orgId: KinOrgId) {
    const zone = yield* cache.ownerTimeZone(orgId);
    return kinWhenParts(yield* Clock.currentTimeMillis, zone).hour;
  });

  /**
   * Whether an unprompted post may ring `personId` now: at most once per half hour across every
   * agent. One that may not still lands, silently. Claimed here, when the push is decided.
   */
  const mayRing = Effect.fn("KinPushSender.mayRing")(function* (
    orgId: KinOrgId,
    personId: KinPersonId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* sql`INSERT INTO kin_push_rings (org_id, person_id, rang_at)
      VALUES (${orgId}, ${personId}, ${now})
      ON CONFLICT (org_id, person_id) DO UPDATE SET rang_at = excluded.rang_at
        WHERE kin_push_rings.rang_at <= ${now - UNPROMPTED_RING_GAP_MS}
      RETURNING rang_at`;
    return claimed.length > 0;
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
    // An approval is asked for now: only an approver's quiet hours keep it silent.
    for (const personId of approvers)
      recipients.push({ personId, silent: (yield* holdNow(orgId, personId)) === "quiet" });
    return {
      category: "kin.approval",
      title: lead?.display_name ?? "Approval needed",
      body: approvalPushText(action.value),
      chatId: undefined,
      source: undefined,
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
      asked_json: string;
      awaits_card: number;
      is_card: number;
      owner_timed: number;
      seq: number;
      relay_json: string | null;
    }>`
      SELECT m.chat_id, m.seq, m.author_kind, m.author_person_id, m.author_member_id, m.body,
        m.form, m.mentions_json, m.relay_json,
        COALESCE(
          (SELECT display_name FROM kin_agents a
            WHERE a.org_id = m.org_id AND a.agent_id = m.author_agent_id),
          (SELECT display_name FROM kin_people p
            WHERE p.org_id = m.org_id AND p.person_id = m.author_person_id)
        ) AS author_name,
        (SELECT r.author_person_id FROM kin_messages r
          WHERE r.org_id = m.org_id AND r.message_id = m.reply_to) AS reply_author,
        -- Whose messages in this chat the lead's running wake-up answers.
        (SELECT COALESCE(json_group_array(DISTINCT q.author_person_id), '[]') FROM kin_wakeups k
          JOIN kin_events e ON e.org_id = k.org_id AND e.wakeup_id = k.wakeup_id
            AND e.tag IN ('chat.message', 'widget.action')
          JOIN kin_messages q ON q.org_id = e.org_id AND q.chat_id = m.chat_id
            AND q.message_id = json_extract(e.json, '$.messageId') AND q.author_kind = 'human'
          WHERE k.org_id = m.org_id AND k.agent_id = m.author_agent_id
            AND k.status = 'running') AS asked_json,
        EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id AND w.closed_at IS NULL
          AND w.awaiting_json != '[]') AS awaits_card,
        EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
          AND w.message_id = m.message_id) AS is_card,
        (EXISTS (SELECT 1 FROM kin_widgets w WHERE w.org_id = m.org_id
            AND w.message_id = m.message_id AND w.type IN ('reminder', 'scheduled_task'))
          OR EXISTS (SELECT 1 FROM kin_lead_deliveries d
            JOIN kin_events e ON e.org_id = d.org_id AND e.event_id = d.event_id
            JOIN kin_wakeups k ON k.org_id = e.org_id AND k.wakeup_id = e.wakeup_id
            WHERE d.org_id = m.org_id AND d.chat_id = m.chat_id
              AND d.agent_id = m.author_agent_id AND d.kind IN ('reminder', 'scheduled_task')
              AND k.status = 'running')) AS owner_timed
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
    const body = kinPushBody(
      relay?.personId !== undefined
        ? kinRelayWords(row.body)
        : kinIsBrief(row.body, row.form)
          ? `${kinGreeting(yield* ownerHour(orgId))} · ${kinPageGist(row.body)}`
          : kinPageShape(row.body) === "page"
            ? kinPageGist(row.body)
            : kinPlainBody(row.body),
    );
    if (row.is_card === 1 && body === "") return undefined;
    const chat = yield* chatName(orgId, row.chat_id);
    const mentions = new Set<string>(yield* decodeIds(row.mentions_json));
    const asked = new Set<string>(yield* decodeIds(row.asked_json));
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
    const push: Push = {
      category: "kin.message",
      title: kinBannerTitle(chat, author),
      body: body || "New message",
      chatId: row.chat_id,
      source: messageId,
      collapseId: kinPushCollapseId(orgId, row.chat_id),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        deepLink: chatLink(orgId, row.chat_id),
      },
      recipients: people
        .filter(
          (person) =>
            person.joinedSeq <= row.seq &&
            person.personId !== row.author_person_id &&
            person.memberId !== row.author_member_id &&
            kinPushConcerns({
              direct: chat.direct,
              mentioned: mentions.has(person.memberId),
              repliesToThem: row.reply_author === person.personId || asked.has(person.personId),
            }),
        )
        .map((person) => ({ personId: person.personId, silent: person.muted })),
    };
    // Each on their own clock. Reminders and scheduled runs come at the time someone chose, and a
    // teammate writing to them directly is a person, not Kin: those ring whatever the hour. In
    // quiet hours nothing else rings; outside the hours someone holds to, only a person's words or
    // an answer to what they asked do. Anything else from Kin or an agent rings once per half hour.
    const recipients: Array<Recipient> = [];
    for (const recipient of push.recipients) {
      const answers = row.reply_author === recipient.personId || asked.has(recipient.personId);
      const hold =
        row.owner_timed === 1 || (chat.people && row.author_kind === "human")
          ? undefined
          : yield* holdNow(orgId, recipient.personId);
      const silent =
        recipient.silent || hold === "quiet" || (hold === "off" && !fromPerson && !answers);
      const subject =
        row.is_card === 1
          ? ({ _tag: "message", messageId } as const)
          : yield* subjectFor(orgId, messageId, recipient.personId);
      const told = subject === undefined ? recipient : { ...recipient, subject };
      recipients.push(
        silent
          ? { ...told, silent: true }
          : fromPerson || answers || row.owner_timed === 1
            ? told
            : { ...told, capped: true },
      );
    }
    return { ...push, recipients } satisfies Push;
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
      silent: number;
      author_name: string | null;
    }>`SELECT w.chat_id, w.type, w.revision, json_extract(w.state_json, '$.phase') AS phase,
        w.state_json, w.awaiting_json, m.seq, m.message_id, m.body, m.silent,
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
    const kind =
      row.type !== "deferral"
        ? ({
            category: "kin.message",
            body:
              kinCardWords(row.body, Option.getOrNull(decodeState(row.state_json))) ??
              "A card is waiting on you",
          } as const)
        : row.phase === "confirmed" || row.phase === null
          ? ({ category: "kin.deferral.confirmed", body: "A deferral needs a look" } as const)
          : row.phase === "heads_up"
            ? ({ category: "kin.deferral.heads_up", body: "A deferred task starts soon" } as const)
            : undefined;
    if (kind === undefined) return undefined;
    const awaiting = new Set<string>(yield* decodeIds(row.awaiting_json));
    // Whoever the turn's own words rang heard of the card with them: one event, one banner.
    for (const messageId of covered) {
      const said = yield* messagePush(orgId, messageId);
      for (const recipient of said?.recipients ?? []) awaiting.delete(recipient.personId);
    }
    const chat = yield* chatName(orgId, row.chat_id);
    const people = yield* chatPeople(orgId, row.chat_id);
    const recipients: Array<Recipient> = [];
    for (const person of people) {
      if (person.joinedSeq > row.seq || !awaiting.has(person.personId)) continue;
      // A heads-up comes at the time the owner deferred the task to.
      const held = row.phase === "heads_up" ? undefined : yield* holdNow(orgId, person.personId);
      recipients.push({
        personId: person.personId,
        silent: person.muted || held !== undefined || row.silent === 1,
        subject: { _tag: "message", messageId: row.message_id },
      });
    }
    return {
      ...kind,
      title: kinBannerTitle(chat, row.author_name),
      chatId: row.chat_id,
      source: row.message_id,
      // A deferral keeps its own banner, which carries its buttons.
      ...(kind.category === "kin.message"
        ? { collapseId: kinPushCollapseId(orgId, row.chat_id) }
        : {}),
      data: {
        kin: 1,
        orgId,
        chatId: row.chat_id,
        widgetId,
        revision: row.revision,
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

  const sendTo = Effect.fn("KinPushSender.sendTo")(function* (
    orgId: KinOrgId,
    push: Push,
    device: KinPushDevice,
    recipient: {
      readonly silent: boolean;
      readonly badge: number;
      readonly subject: KinPushSubject | undefined;
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
    const payload = (body: string) => ({
      aps: recipient.silent
        ? { badge: recipient.badge }
        : {
            alert: { title: push.title, body },
            badge: recipient.badge,
            category: push.category,
            sound: "default",
            ...(push.chatId === undefined ? {} : { "thread-id": `kin:${orgId}:${push.chatId}` }),
          },
      // expo-notifications reads a remote push's `content.data` from `body`.
      body:
        recipient.subject === undefined ? push.data : { ...push.data, subject: recipient.subject },
    });
    const result = yield* apns.send({
      token: device.token,
      environment: device.apsEnvironment,
      // A badge-only push must not replace the banner a loud one left under the same id.
      ...(push.collapseId === undefined || recipient.silent ? {} : { collapseId: push.collapseId }),
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
    )).filter((device) => device.sessionId !== push.exceptSession);
    const recipients = new Map<
      KinPersonId,
      { silent: boolean; badge: number; subject: KinPushSubject | undefined }
    >();
    for (const recipient of push.recipients) {
      let silent = recipient.silent;
      // The half hour's one ring is spent only on a phone that will show it, so a push decided
      // before they had one, or while they watch the chat, leaves it for the next.
      if (recipient.capped === true) {
        let shows = false;
        for (const device of targets)
          if (
            device.personId === recipient.personId &&
            (push.chatId === undefined ||
              !(yield* presence.isWatching(device.sessionId, push.chatId)))
          )
            shows = true;
        if (shows && !(yield* mayRing(orgId, recipient.personId))) silent = true;
      }
      recipients.set(recipient.personId, {
        silent,
        badge: yield* badgeFor(orgId, recipient.personId),
        subject: recipient.subject,
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
    const count = (outcome: (typeof results)[number]) =>
      results.filter((result) => result === outcome).length;
    return { sent: count("sent"), suppressed: count("suppressed"), failed: count("failed") };
  });

  /**
   * A badge-only push to the reader's other devices; the one reading watches the chat. It wakes
   * the app too, which takes the chat's banners off the pane once nothing in it is unread.
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
    const badge = yield* badgeFor(orgId, row.person_id);
    const cleared = (yield* chats.unreadCount({ orgId, chatId, memberId })) === 0;
    const targets = yield* devices.forPeople(orgId, [row.person_id]);
    const data: KinPushData = {
      kin: 1,
      orgId,
      chatId,
      deepLink: chatLink(orgId, chatId),
      ...(cleared ? { cleared: true } : {}),
    };
    const results = yield* Effect.forEach(
      targets,
      Effect.fnUntraced(function* (device) {
        if (shownBadge.get(device.token) === badge) return "suppressed" as const;
        if (yield* presence.isWatching(device.sessionId, chatId)) return "suppressed" as const;
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
   * so it leaves the badge as it is. Their mute of the chat it once came in keeps it silent, and
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
      title: "Tasks",
      body: news.body,
      chatId: undefined,
      source: undefined,
      data: {
        kin: 1,
        orgId,
        deepLink:
          news.opens === undefined
            ? `${base}/work`
            : `${base}/${news.opens.project ? "projects" : "work"}/${segment(news.opens.key)}`,
      },
      recipients: [{ personId: news.personId, silent: muted, capped: true, subject }],
    } satisfies Push;
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
      title: "New device linked",
      body: KIN_DEVICE_LINKED_NOTICE,
      chatId: undefined,
      source: undefined,
      data: {
        kin: 1,
        orgId,
        deepLink: `/kin/${host}/${segment(orgId)}/people/${segment(row.person_id)}/devices`,
      },
      // Someone else signing in as them rings through quiet hours.
      recipients: [{ personId: row.person_id, silent: false }],
      exceptSession: sessionId,
    };
    return push;
  });

  const nothing: KinPushOutcome = { status: apns.status, sent: 0, suppressed: 0, failed: 0 };

  const run = Effect.fn("KinPushSender.run")(
    function* (notification: KinPushNotification) {
      if (apns.status === "unconfigured") return nothing;
      if (notification._tag === "read") {
        const outcome: KinPushOutcome = {
          status: apns.status,
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
              : notification._tag === "message"
                ? yield* messagePush(notification.orgId, notification.messageId)
                : yield* widgetPush(
                    notification.orgId,
                    notification.widgetId,
                    notification.covered ?? [],
                  );
      if (push === undefined || push.recipients.length === 0) return nothing;
      const outcome: KinPushOutcome = {
        status: apns.status,
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
          if (apns.status === "ready")
            yield* deliver(row.org_id, {
              category: "kin.message",
              title: "Kin approvals",
              // The server's own text, whole, so where to remove the phone is never cut off.
              body: row.body,
              chatId: undefined,
              source: undefined,
              data: {
                kin: 1,
                orgId: row.org_id,
                deepLink: `/kin/${host}/${segment(row.org_id)}/approvals`,
              },
              // A phone that can approve came or went: it rings through quiet hours.
              recipients: [{ personId: row.human_id, silent: false }],
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

  return KinPushSender.of({ status: apns.status, notify, flushKeyPushes: flushKeyPushes() });
});

export const layer = Layer.effect(KinPushSender, make);
