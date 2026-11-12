import {
  KinAgentId,
  type KinChatId,
  KinEventId,
  KinMessageId,
  KinOrgId,
  TrimmedNonEmptyString,
  type KinEvent,
  type KinMessage,
  type KinPersonId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { forkParked } from "../../serverActivation.ts";
import { KinChatHub, type KinChatHubEvent } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { speakerOrder } from "../floor/KinFloor.ts";
import { KinPresence, queueLabel, syncQueued } from "../reply/KinPresence.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { RETIRED_NOTICE_PREFIX, retiredAgentNotice, retiredNoticeId } from "./Retirement.ts";
import * as LeadAccess from "./LeadAccess.ts";

const decodeTap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ actionId: TrimmedNonEmptyString, handled: Schema.optional(Schema.Boolean) }),
  ),
);
// Matches the resume expiry: older unanswered messages are not worth a wake-up after downtime.
const CATCH_UP_WINDOW = { hours: 24 } as const;
const CATCH_UP_LIMIT_PER_ORG = 200;
/** Lead turns one teammate's messages and taps may ask for in any 24 hours, unless configured. */
const DEFAULT_TEAMMATE_DAILY_TURNS = 50;

/**
 * Turns committed human chat posts and widget taps into `chat.message` and `widget.action`
 * events for the leads the floor grants a reply: the leads a message mentions, else the chat's
 * lead. Only a person's message wakes anyone, so two leads never set each other off, and each
 * message wakes a lead at most once (its event id is the message and the lead).
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* KinChatHub;
  const repo = yield* KinChatRepository;
  const queue = yield* KinEventQueue;
  const presence = yield* Effect.serviceOption(KinPresence);
  const dailyTurns = yield* Config.Int("KIN_TEAMMATE_DAILY_TURNS").pipe(
    Config.withDefault(DEFAULT_TEAMMATE_DAILY_TURNS),
    Effect.map((value) => Math.max(0, value)),
    Effect.catch((cause) =>
      Effect.logWarning("KIN_TEAMMATE_DAILY_TURNS is not a number; using the default", {
        cause,
      }).pipe(Effect.as(DEFAULT_TEAMMATE_DAILY_TURNS)),
    ),
  );
  // The working line shows the moment a message is accepted, before any wake-up claims it.
  const showQueued = Effect.fn("KinChatWake.showQueued")(
    function* (orgId: KinOrgId, chatId: KinChatId, agentId: KinAgentId) {
      if (Option.isNone(presence)) return;
      const label = yield* queueLabel(orgId, agentId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* presence.value.queued(orgId, chatId, agentId, label, yield* Clock.currentTimeMillis);
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin queue line failed", { cause })),
  );

  /**
   * A teammate wakes a lead (in a direct chat, only while its owner allows them) for at most
   * `dailyTurns` turns in any 24 hours across every chat: the owner pays for each. Past that the
   * chat says so once. Run in the transaction that enqueues, so the count and the turn are one step.
   */
  const admitted = Effect.fn("KinChatWake.admitted")(function* (
    message: KinMessage,
    personId: KinPersonId,
    target: { readonly agentId: KinAgentId; readonly name: string; readonly direct: boolean },
    dedupeKey: string,
  ) {
    const pair = { orgId: message.orgId, agentId: target.agentId, personId };
    const known = yield* sql`SELECT 1 FROM kin_events
      WHERE org_id = ${message.orgId} AND dedupe_key = ${dedupeKey} LIMIT 1`;
    if (known.length > 0) return true;
    const access = Effect.provideService(SqlClient.SqlClient, sql);
    if (target.direct && !(yield* LeadAccess.allowed(pair).pipe(access))) return false;
    const used = yield* LeadAccess.recentTurns({
      ...pair,
      now: yield* Clock.currentTimeMillis,
    }).pipe(access);
    if (used.turns < dailyTurns) return true;
    // One line per full day of turns: it is said again only once the oldest of them has aged out.
    const messageId = KinMessageId.make(
      `kin-dm-limit-${NodeCrypto.createHash("sha256")
        .update(`${personId}:${message.chatId}:${used.oldestAt}`)
        .digest("hex")
        .slice(0, 32)}`,
    );
    if (Option.isSome(yield* repo.getMessage({ orgId: message.orgId, messageId }))) return false;
    // Everyone in a group reads the line, so there it names who it is about.
    const [person] = target.direct
      ? []
      : yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
          WHERE org_id = ${message.orgId} AND person_id = ${personId}`;
    const notice = yield* repo.insertMessage({
      orgId: message.orgId,
      chatId: message.chatId,
      // Fixed words, about the asker, said where they asked.
      audience: "chat",
      messageId,
      author: { _tag: "system" },
      kind: "system",
      body:
        person === undefined
          ? `${target.name} has answered as much as it can for you today and didn't see your last message. Send it again later.`
          : `${target.name} has answered as much as it can for ${person.name} today and didn't see their last message. ${person.name} can send it again later.`,
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      editedAt: null,
    });
    yield* sql.afterCommit(
      hub.publish({ type: "message.posted", orgId: message.orgId, message: notice }),
    );
    return false;
  });

  /**
   * A person writes to a retired agent in their direct chat with it: Kin's fixed line, never a
   * turn. Only its name, which they already see. In a group it simply doesn't answer.
   */
  const retiredNotice = Effect.fn("KinChatWake.retiredNotice")(function* (message: KinMessage) {
    const [agent] = yield* sql<{ name: string }>`SELECT a.display_name AS name
      FROM kin_chats c
      JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
        AND m.principal_kind = 'agent' AND m.left_at IS NULL
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NOT NULL
      WHERE c.org_id = ${message.orgId} AND c.chat_id = ${message.chatId} AND c.kind = 'direct'
      ORDER BY a.agent_id LIMIT 1`.pipe(
      Effect.mapError(toPersistenceSqlError("KinChatWake.retiredNotice")),
    );
    if (agent === undefined) return;
    const messageId = retiredNoticeId(message.messageId);
    if (Option.isSome(yield* repo.getMessage({ orgId: message.orgId, messageId }))) return;
    const notice = yield* repo.insertMessage({
      orgId: message.orgId,
      chatId: message.chatId,
      // Fixed words naming only the agent, in the chat the person wrote in.
      audience: "chat",
      messageId,
      author: { _tag: "system" },
      kind: "system",
      body: retiredAgentNotice(agent.name),
      intent: null,
      mentions: [],
      replyTo: null,
      widgetId: null,
      floorRunId: null,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      editedAt: null,
    });
    yield* hub.publish({ type: "message.posted", orgId: message.orgId, message: notice });
  });

  const enqueue = (event: KinEvent) =>
    queue.enqueue(event).pipe(
      Effect.map((result) => !result.duplicate),
      Effect.catchTags({
        KinEventQueueRetiredAgent: () => Effect.succeed(false),
        KinEventQueueUnknownAgent: () => Effect.succeed(false),
        KinEventQueueConflict: (error) =>
          Effect.logWarning("Kin chat wake-up conflicts with a stored event", error).pipe(
            Effect.as(false),
          ),
      }),
    );

  const wake = Effect.fn("KinChatWake.wake")(
    function* (message: KinMessage) {
      if (message.author._tag !== "human" || message.status !== "posted") return;
      if (message.kind !== "text" && message.kind !== "widget_action") return;
      const leads = yield* sql<{
        agentId: string;
        memberId: string;
        name: string;
        ownerPersonId: string;
        kind: string;
      }>`
        SELECT l.agent_id AS "agentId", m.member_id AS "memberId", l.name,
          a.owner_person_id AS "ownerPersonId", c.kind FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = ${message.chatId}
          AND c.archived_at IS NULL
        JOIN kin_chat_members m ON m.org_id = l.org_id AND m.chat_id = c.chat_id
          AND m.principal_kind = 'agent' AND m.agent_id = l.agent_id AND m.left_at IS NULL
        WHERE l.org_id = ${message.orgId}
        ORDER BY ${speakerOrder(sql)}`.pipe(
        Effect.mapError(toPersistenceSqlError("KinChatWake.leads")),
      );
      const mentioned = leads.filter((lead) =>
        message.mentions.some((memberId) => memberId === lead.memberId),
      );
      const targets = mentioned.length > 0 ? mentioned : leads.slice(0, 1);
      if (targets.length === 0) return yield* retiredNotice(message);
      const tap =
        message.kind === "widget_action"
          ? yield* decodeTap(message.body).pipe(Effect.option)
          : Option.none();
      // A tap the server finished alone, such as Snooze or Pause, is not the lead's to answer.
      if (Option.isSome(tap) && tap.value.handled === true) return;
      const actionId = tap.pipe(Option.map((value) => value.actionId));
      if (message.kind === "widget_action" && Option.isNone(actionId))
        return yield* Effect.logWarning("Kin widget action has no readable action id", {
          orgId: message.orgId,
          messageId: message.messageId,
        });
      for (const target of targets) {
        const agentId = KinAgentId.make(target.agentId);
        // Every field comes from the stored message, so a replay enqueues byte-identical JSON.
        const prefix = message.kind === "widget_action" ? "widget-action" : "chat-message";
        const dedupeKey = `${prefix}:${message.messageId}:${agentId}`;
        // The memory writer accepts only [a-zA-Z0-9_-] in event ids, so hash the readable key.
        const eventId = KinEventId.make(
          `${prefix}-${NodeCrypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32)}`,
        );
        const base = {
          orgId: message.orgId,
          eventId,
          agentId,
          receivedAt: DateTime.makeUnsafe(message.createdAt),
          dedupeKey,
          provenance: message.author,
          chatId: message.chatId,
          messageId: message.messageId,
        };
        const event: KinEvent = Option.isSome(actionId)
          ? { ...base, _tag: "widget.action", actionId: actionId.value }
          : { ...base, _tag: "chat.message" };
        // The owner is never capped. Anyone else's turn is counted and enqueued in one step.
        const personId = message.author.personId;
        const queued =
          personId === target.ownerPersonId
            ? yield* enqueue(event)
            : yield* sql
                .withTransaction(
                  admitted(
                    message,
                    personId,
                    { agentId, name: target.name, direct: target.kind === "direct" },
                    dedupeKey,
                  ).pipe(
                    Effect.flatMap((admit) => (admit ? enqueue(event) : Effect.succeed(false))),
                  ),
                )
                .pipe(Effect.mapError(toPersistenceSqlError("KinChatWake.admitted")));
        if (queued) yield* showQueued(message.orgId, message.chatId, agentId);
      }
    },
    Effect.catchCause((cause) => Effect.logError("Kin chat wake-up failed", { cause })),
  );

  // A waking reaction (the chat service decides) becomes `chat.reaction`; withdrawing it before
  // a wake-up claims it cancels the event and its working line. Withdrawing a yes the lead already
  // took up wakes it with `withdrawn`. Other reactions are feedback only.
  const react = Effect.fn("KinChatWake.react")(
    function* (event: Extract<KinChatHubEvent, { type: "reaction.updated" }>) {
      const { reaction } = event;
      const dedupeKey = `chat-reaction:${reaction.messageId}:${reaction.memberId}:${reaction.emoji}:${reaction.createdAt}`;
      if (reaction.removedAt !== null) {
        const expired = yield* sql<{ agentId: string }>`UPDATE kin_events SET state = 'expired'
          WHERE org_id = ${reaction.orgId} AND tag = 'chat.reaction' AND dedupe_key = ${dedupeKey}
            AND state = 'queued' RETURNING agent_id AS "agentId"`.pipe(
          Effect.mapError(toPersistenceSqlError("KinChatWake.unreact")),
        );
        if (Option.isSome(presence))
          for (const row of expired)
            yield* syncQueued(presence.value, reaction.orgId, KinAgentId.make(row.agentId)).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
        if (expired.length > 0) return;
      }
      if (!event.woke) return;
      const withdrawn = reaction.removedAt !== null;
      const key = withdrawn
        ? `chat-reaction-withdrawn:${reaction.messageId}:${reaction.memberId}:${reaction.emoji}:${reaction.removedAt}`
        : dedupeKey;
      const message = yield* repo.getMessage({
        orgId: reaction.orgId,
        messageId: reaction.messageId,
      });
      if (Option.isNone(message) || message.value.author._tag !== "agent") return;
      const agentId = message.value.author.agentId;
      const queued = yield* queue
        .enqueue({
          _tag: "chat.reaction",
          orgId: reaction.orgId,
          eventId: KinEventId.make(
            `chat-reaction-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
          ),
          agentId,
          receivedAt: DateTime.makeUnsafe(reaction.removedAt ?? reaction.createdAt),
          dedupeKey: key,
          provenance: event.by,
          chatId: reaction.chatId,
          messageId: reaction.messageId,
          emoji: reaction.emoji,
          ...(event.changedFrom === undefined ? {} : { changedFrom: event.changedFrom }),
          ...(withdrawn ? { withdrawn: true } : {}),
        })
        .pipe(
          Effect.map((result) => !result.duplicate),
          Effect.catchTags({
            KinEventQueueRetiredAgent: () => Effect.succeed(false),
            KinEventQueueUnknownAgent: () => Effect.succeed(false),
            KinEventQueueConflict: (error) =>
              Effect.logWarning("Kin reaction wake-up conflicts with a stored event", error).pipe(
                Effect.as(false),
              ),
          }),
        );
      if (queued) yield* showQueued(reaction.orgId, reaction.chatId, agentId);
    },
    Effect.catchCause((cause) => Effect.logError("Kin reaction wake-up failed", { cause })),
  );

  // Messages posted while the server was down or Kin was off never reached the hub.
  const catchUpOrg = Effect.fn("KinChatWake.catchUpOrg")(
    function* (orgId: KinOrgId, since: string) {
      const rows = yield* sql<{ messageId: string }>`
      SELECT DISTINCT m.message_id AS "messageId", m.created_at AS "createdAt"
      FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id AND a.retired_at IS NULL
      JOIN kin_chat_members am ON am.org_id = l.org_id AND am.principal_kind = 'agent'
        AND am.agent_id = l.agent_id AND am.left_at IS NULL
      JOIN kin_chats c ON c.org_id = am.org_id AND c.chat_id = am.chat_id
        AND c.archived_at IS NULL
      JOIN kin_messages m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
      WHERE l.org_id = ${orgId}
        AND m.author_kind = 'human' AND m.status = 'posted' AND m.kind IN ('text', 'widget_action')
        -- In a group, only what this lead would answer: it is named, or nobody is and it leads.
        AND (c.kind = 'direct'
          OR EXISTS (SELECT 1 FROM json_each(m.mentions_json) j WHERE j.value = am.member_id)
          OR (COALESCE(c.lead_agent_id, l.agent_id) = l.agent_id AND NOT EXISTS (
            SELECT 1 FROM json_each(m.mentions_json) j
            JOIN kin_chat_members x ON x.org_id = m.org_id AND x.chat_id = m.chat_id
              AND x.member_id = j.value AND x.principal_kind = 'agent' AND x.left_at IS NULL)))
        AND m.created_at > ${since}
        -- Written while it was retired: Kin already answered, and a restored agent doesn't.
        AND NOT EXISTS (SELECT 1 FROM kin_messages n WHERE n.org_id = m.org_id
          AND n.message_id = ${RETIRED_NOTICE_PREFIX} || m.message_id)
        AND m.seq > COALESCE((SELECT MAX(x.seq) FROM kin_messages x
          WHERE x.org_id = m.org_id AND x.chat_id = m.chat_id AND x.author_kind = 'agent'
            AND x.author_agent_id = l.agent_id), 0)
      ORDER BY m.created_at DESC, m.message_id DESC LIMIT ${CATCH_UP_LIMIT_PER_ORG}`.pipe(
        Effect.mapError(toPersistenceSqlError("KinChatWake.catchUpOrg")),
      );
      for (const row of rows) {
        const message = yield* repo.getMessage({
          orgId,
          messageId: KinMessageId.make(row.messageId),
        });
        if (Option.isSome(message)) yield* wake(message.value);
      }
    },
    (effect, orgId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Kin chat wake-up catch-up failed", { orgId, cause }),
        ),
      ),
  );
  const catchUp = Effect.fn("KinChatWake.catchUp")(
    function* () {
      const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, CATCH_UP_WINDOW));
      const orgs = yield* sql<{ orgId: string }>`
        SELECT DISTINCT org_id AS "orgId" FROM kin_leads ORDER BY org_id`.pipe(
        Effect.mapError(toPersistenceSqlError("KinChatWake.catchUp")),
      );
      // Per organization, so one busy organization cannot use up another's catch-up.
      for (const org of orgs) yield* catchUpOrg(KinOrgId.make(org.orgId), since);
    },
    Effect.catchCause((cause) => Effect.logError("Kin chat wake-up catch-up failed", { cause })),
  );

  // Subscribe before activation so nothing posted from here on is missed.
  const events = yield* hub.subscribeAll;
  yield* catchUp().pipe(
    Effect.andThen(
      Stream.runForEach(events, (event) =>
        event.type === "message.posted"
          ? wake(event.message)
          : event.type === "reaction.updated"
            ? react(event)
            : Effect.void,
      ),
    ),
    forkParked,
  );
});

export const layer = Layer.effectDiscard(make);
