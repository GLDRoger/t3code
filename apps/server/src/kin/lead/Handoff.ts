import {
  KinAgentId,
  KinChatError,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL, aborted, effectiveAudience } from "./Audience.ts";
import { wakeEvent } from "./ChatWake.ts";
import { KinEventQueue } from "./KinEventQueue.ts";
import { resolveLead } from "./LeadMemory.ts";
import { messageBodyLimit } from "./LeadPrompt.ts";
import { outsideStamp, stampEvent } from "./OutsideContent.ts";

export const LeadsResult = Schema.Struct({
  leads: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // Both only when the owner alone set off this wake-up; anywhere else, names only.
      domain: Schema.optional(Schema.String),
      // What the owner said it is for.
      charter: Schema.optional(Schema.String),
      you: Schema.Boolean,
    }),
  ),
});
export const HandOffInput = Schema.Struct({
  to: TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
    description: "The agent to pass it to, by name or domain, as kin_leads lists them.",
  }),
  request: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
    description:
      "What you are passing on, in the owner's terms, with anything useful you already found. The owner's own message goes along with it.",
  }),
  sourceEventId: TrimmedNonEmptyString.annotate({
    description: "The event of the owner's message you are passing on.",
  }),
});
export const HandOffResult = Schema.Struct({
  // The lead it went to, by name, to tell the owner.
  to: Schema.String,
  passed: Schema.Literal(true),
});
export const TakePrivateInput = Schema.Struct({
  sourceEventId: TrimmedNonEmptyString.annotate({
    description: "The event of the person's own message in this group that you are taking private.",
  }),
  agent: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(80)).annotate({
      description:
        "Another agent in this group who should answer it, by name or domain. Leave out to answer it yourself.",
    }),
  ),
});
export const TakePrivateResult = Schema.Struct({
  // Who asked, by name, and the agent answering them in their direct chat.
  person: Schema.String,
  agent: Schema.String,
  continued: Schema.Literal(true),
});

const NOTHING = "Nothing was passed on.";
const refuse = (message: string) =>
  new KinChatError({ reason: "not_allowed", message: `${message} ${NOTHING}` });
const missing = () => new KinChatError({ reason: "not_found", message: "Kin record not found." });
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });
const isChatError = Schema.is(KinChatError);
const guarded =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (error): error is Exclude<E, KinChatError> => !isChatError(error),
        (error) =>
          Effect.logError(
            "Kin hand-off failed",
            isSqlError(error) ? toPersistenceSqlError(label)(error) : error,
          ).pipe(Effect.andThen(Effect.fail(unavailable()))),
      ),
    );

const Colleague = Schema.Struct({
  agentId: KinAgentId,
  name: Schema.String,
  domain: Schema.String,
  charter: Schema.String,
  ownerChatId: KinChatId,
  ownerPersonId: KinPersonId,
  memberId: Schema.NullOr(KinMemberId),
});
type Colleague = typeof Colleague.Type;
const decodeColleagues = Schema.decodeUnknownEffect(Schema.Array(Colleague));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(KinEvent));
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(Schema.fromJsonString(KinEvent)));
/**
 * Whether only the owner could have put this in front of the lead: their own words in its own
 * chat with them, a routine, or a reminder they asked for there. Anything a teammate, another
 * lead, GitHub or a worker could have shaped is not.
 */
const fromOwnerAlone = (event: KinEvent, self: Colleague) => {
  switch (event._tag) {
    case "chat.message":
    case "widget.action":
    case "chat.reaction":
      return (
        event.chatId === self.ownerChatId &&
        (event._tag !== "chat.message" || event.origin === undefined) &&
        event.provenance._tag === "human" &&
        event.provenance.personId === self.ownerPersonId
      );
    case "routine":
      return true;
    case "deferral.due":
      return event.origin === undefined;
    default:
      return false;
  }
};
const fold = (value: string) => value.trim().toLowerCase();
const describe = (leads: ReadonlyArray<{ readonly name: string; readonly domain: string }>) =>
  leads.map((lead) => `${lead.name} (${lead.domain})`).join(", ");

/**
 * A lead passes a request the owner made to another of that owner's leads, and sees which leads
 * there are. The request lands in the other lead's own chat with the owner as Kin's row, saying
 * who passed it on, and wakes that lead. The wake-up carries the chat it was first asked in, as a
 * due deferral does, so it works at no more than that chat allows (`KinLevels.originCap`).
 */
export class KinHandoff extends Context.Service<
  KinHandoff,
  {
    readonly leads: (
      scope: McpInvocationScope,
    ) => Effect.Effect<typeof LeadsResult.Type, KinChatError>;
    readonly handOff: (
      scope: McpInvocationScope,
      input: typeof HandOffInput.Type,
    ) => Effect.Effect<typeof HandOffResult.Type, KinChatError>;
    /**
     * A person's own message in a group goes on in their direct chat with this lead or another in
     * the group: Kin posts their words there as theirs, which wakes that lead with that person's
     * access and nothing of the group's chat. Once per message.
     */
    readonly takePrivate: (
      scope: McpInvocationScope,
      input: typeof TakePrivateInput.Type,
    ) => Effect.Effect<typeof TakePrivateResult.Type, KinChatError>;
  }
>()("t3/kin/lead/Handoff/KinHandoff") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const chat = yield* KinChatService;
  const repo = yield* KinChatRepository;
  const queue = yield* KinEventQueue;
  const lead = (scope: McpInvocationScope) =>
    resolveLead(scope).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  type Lead = Effect.Success<ReturnType<typeof lead>>;

  /**
   * The live leads of the caller's owner, the caller included, oldest first, each with a direct
   * chat that binds exactly that owner and that lead. Another person's leads and another org's
   * are never listed, so they can't be reached either.
   */
  const colleagues = Effect.fn("KinHandoff.colleagues")(function* (ctx: Lead) {
    const rows = yield* sql`
      SELECT l.agent_id AS "agentId", l.name, l.domain, l.charter,
        l.owner_chat_id AS "ownerChatId", a.owner_person_id AS "ownerPersonId",
        (SELECT m.member_id FROM kin_chat_members m WHERE m.org_id = l.org_id
          AND m.chat_id = l.owner_chat_id AND m.principal_kind = 'agent'
          AND m.agent_id = l.agent_id AND m.left_at IS NULL
          ORDER BY m.joined_at, m.member_id LIMIT 1) AS "memberId"
      FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      JOIN kin_agents me ON me.org_id = l.org_id AND me.agent_id = ${ctx.agentId}
        AND me.role = 'lead' AND me.retired_at IS NULL
      JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        AND c.kind = 'direct' AND c.direct_key = a.owner_person_id || ':' || l.agent_id
      WHERE l.org_id = ${ctx.orgId} AND a.role = 'lead' AND a.retired_at IS NULL
        AND a.owner_person_id = me.owner_person_id
      ORDER BY a.created_at, l.agent_id`;
    return yield* decodeColleagues(rows);
  });

  /** The events that woke this lead now, as stored. */
  const wakeEvents = Effect.fn("KinHandoff.wakeEvents")(function* (ctx: Lead) {
    const rows = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
      ORDER BY event_id`;
    return yield* decodeEvents(rows.map((row) => row.json));
  });

  /** A person's own text in a live group, from this wake-up's stored events and messages. */
  const groupAsk = Effect.fn("KinHandoff.groupAsk")(function* (ctx: Lead, sourceEventId: string) {
    const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
      WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
        AND event_id = ${sourceEventId} ORDER BY event_id`;
    if (stored === undefined) return yield* missing();
    const event = yield* decodeEvent(stored.json);
    if (event._tag !== "chat.message" || event.origin !== undefined) return undefined;
    const message = yield* repo
      .getMessage({ orgId: ctx.orgId, messageId: event.messageId })
      .pipe(Effect.map(Option.getOrUndefined));
    if (
      message === undefined ||
      message.chatId !== event.chatId ||
      message.author._tag !== "human" ||
      message.kind !== "text" ||
      message.status !== "posted"
    )
      return undefined;
    const [room] = yield* sql<{ title: string | null }>`SELECT title FROM kin_chats
      WHERE org_id = ${ctx.orgId} AND chat_id = ${event.chatId} AND kind <> 'direct'
        AND archived_at IS NULL ORDER BY chat_id`;
    if (room === undefined) return undefined;
    const [person] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
      WHERE org_id = ${ctx.orgId} AND person_id = ${message.author.personId} ORDER BY person_id`;
    return {
      message,
      personId: message.author.personId,
      personName: person?.name ?? "them",
      room: room.title ?? "the group",
    };
  });

  /** The live leads in a chat now, who joined first first. */
  const roomAgents = Effect.fn("KinHandoff.roomAgents")(function* (ctx: Lead, chatId: string) {
    return yield* sql<{ agentId: KinAgentId; name: string; domain: string }>`
      SELECT l.agent_id AS "agentId", l.name, l.domain FROM kin_chat_members m
      JOIN kin_leads l ON l.org_id = m.org_id AND l.agent_id = m.agent_id
      JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE m.org_id = ${ctx.orgId} AND m.chat_id = ${chatId} AND m.principal_kind = 'agent'
        AND m.left_at IS NULL
      ORDER BY m.joined_at, l.agent_id`;
  });

  /** One of these by name, else by domain; the refusal names the ones there are. */
  const pick = <T extends { readonly name: string; readonly domain: string }>(
    agents: ReadonlyArray<T>,
    to: string,
  ) => {
    const wanted = fold(to);
    const byName = agents.filter((entry) => fold(entry.name) === wanted);
    const matches =
      byName.length > 0 ? byName : agents.filter((entry) => fold(entry.domain) === wanted);
    if (matches.length === 1) return Effect.succeed(matches[0]!);
    return Effect.fail(
      new KinChatError({
        reason: matches.length === 0 ? "not_found" : "invalid_state",
        message: `${matches.length === 0 ? "No agent here answers to that name or domain" : "Several agents answer to that"}. The agents are: ${describe(agents)}. ${NOTHING} Call again with one of those names.`,
      }),
    );
  };

  /**
   * In a group: the agent there whose domain owns a person's message answers it there, as if they
   * had named it. One agent per message, and it can't be passed on again.
   */
  const passInRoom = Effect.fn("KinHandoff.passInRoom")(function* (
    ctx: Lead,
    input: typeof HandOffInput.Type,
  ) {
    const ask = yield* groupAsk(ctx, input.sourceEventId);
    if (ask === undefined)
      return yield* refuse(
        "In a chat with other people, only a person's own message in a group can be passed on, to an agent in that group. Answer what everyone here may see.",
      );
    const others = (yield* roomAgents(ctx, ask.message.chatId)).filter(
      (entry) => entry.agentId !== ctx.agentId,
    );
    if (others.length === 0)
      return yield* refuse(
        "No other agent is in this group. Answer it yourself, or take it private with kin_take_private.",
      );
    const target = yield* pick(others, input.to);
    const { messageId } = ask.message;
    const claimed = yield* sql<{ toAgentId: KinAgentId }>`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at)
      VALUES (${ctx.orgId}, ${messageId}, ${ctx.agentId}, ${target.agentId},
        ${wakeEvent(ask.message, target.agentId, undefined).eventId}, ${yield* Clock.currentTimeMillis})
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id AS "toAgentId"`;
    if (claimed.length === 0) {
      const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
        FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${messageId}
        ORDER BY message_id`;
      if (record?.toAgentId === target.agentId) return { to: target.name, passed: true as const };
      return yield* refuse(
        "This was already passed on, and a request goes to one agent only. Answer what you can, or say in one line who has it.",
      );
    }
    // The same event a mention makes: an agent named in the message already has it, so it answers once.
    yield* queue
      .enqueue(wakeEvent(ask.message, target.agentId, undefined))
      .pipe(Effect.catchTags({ KinEventQueueConflict: () => Effect.void }));
    return { to: target.name, passed: true as const };
  });

  const takePrivate = Effect.fn("KinHandoff.takePrivate")(function* (
    scope: McpInvocationScope,
    input: typeof TakePrivateInput.Type,
  ) {
    const ctx = yield* lead(scope);
    const ask = yield* groupAsk(ctx, input.sourceEventId);
    if (ask === undefined)
      return yield* refuse(
        "Only a person's own message in a group can be taken private. Answer it here with what everyone here may see.",
      );
    const agents = yield* roomAgents(ctx, ask.message.chatId);
    const target =
      input.agent === undefined
        ? agents.find((entry) => entry.agentId === ctx.agentId)
        : yield* pick(agents, input.agent);
    if (target === undefined) return yield* missing();
    const key = `private:${ask.message.messageId}`;
    const claimed = yield* sql`INSERT INTO kin_handoffs
        (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at)
      VALUES (${ctx.orgId}, ${key}, ${ctx.agentId}, ${target.agentId}, ${key},
        ${yield* Clock.currentTimeMillis})
      ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id`;
    if (claimed.length === 0) {
      const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
        FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${key} ORDER BY message_id`;
      if (record?.toAgentId !== target.agentId)
        return yield* refuse(
          "This was already taken private with another agent. Say in one line that it is answered directly.",
        );
    }
    const asker = { _tag: "person" as const, orgId: ctx.orgId, personId: ask.personId };
    const direct = yield* chat.createDirect(asker, { orgId: ctx.orgId, agentId: target.agentId });
    // The person's own words, posted as theirs in their own chat: that wakes the lead there at
    // their access, from stored rows, and carries nothing of the group's chat or this turn.
    yield* chat.notice({
      orgId: ctx.orgId,
      chatId: direct.chatId,
      audience: "chat",
      messageId: KinMessageId.make(
        `kin-private-${NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}`,
      ),
      body: `From ${ask.room}. ${target.name} answers you here.`,
    });
    yield* chat.send(asker, {
      chatId: direct.chatId,
      clientMessageId: key,
      body: ask.message.body,
    });
    return { person: ask.personName, agent: target.name, continued: true as const };
  }, guarded("KinHandoff.takePrivate"));

  const leads = Effect.fn("KinHandoff.leads")(function* (scope: McpInvocationScope) {
    const ctx = yield* lead(scope);
    const all = yield* colleagues(ctx);
    const self = all.find((entry) => entry.agentId === ctx.agentId);
    if (self === undefined) return yield* missing();
    const events = yield* wakeEvents(ctx);
    if (
      (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
      "owner_only"
    )
      return {
        leads: all.map(({ agentId, name, domain, charter }) => ({
          name,
          domain,
          charter,
          you: agentId === ctx.agentId,
        })),
      };
    // Someone else may be reading the answer: only the leads already in the chats asked from.
    const chats = [
      ...new Set(
        events.flatMap((event) =>
          event._tag === "chat.message" ||
          event._tag === "widget.action" ||
          event._tag === "chat.reaction"
            ? [event.chatId]
            : [],
        ),
      ),
    ];
    const present =
      chats.length === 0
        ? []
        : yield* sql<{ agentId: string }>`SELECT DISTINCT agent_id AS "agentId"
            FROM kin_chat_members WHERE org_id = ${ctx.orgId} AND chat_id IN ${sql.in(chats)}
              AND principal_kind = 'agent' AND left_at IS NULL
            ORDER BY agent_id`;
    const seen = new Set(present.map((row) => row.agentId));
    return {
      leads: all
        .filter((entry) => entry.agentId === ctx.agentId || seen.has(entry.agentId))
        .map(({ agentId, name }) => ({ name, you: agentId === ctx.agentId })),
    };
  }, guarded("KinHandoff.leads"));

  const handOff = Effect.fn("KinHandoff.handOff")(function* (
    scope: McpInvocationScope,
    input: typeof HandOffInput.Type,
  ) {
    const ctx = yield* lead(scope);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const access = Effect.provideService(SqlClient.SqlClient, sql);
        if (yield* aborted(ctx).pipe(access)) return yield* refuse(SHARED_REFUSAL);
        // Others read this turn: only within the group it answers, never to a private chat.
        if (
          (yield* effectiveAudience(ctx).pipe(Effect.provideService(SqlClient.SqlClient, sql))) !==
          "owner_only"
        )
          return yield* passInRoom(ctx, input);
        const all = yield* colleagues(ctx);
        const self = all.find((entry) => entry.agentId === ctx.agentId);
        if (self === undefined || self.memberId === null) return yield* missing();
        const [stored] = yield* sql<{ json: string }>`SELECT json FROM kin_events
          WHERE org_id = ${ctx.orgId} AND agent_id = ${ctx.agentId} AND wakeup_id = ${ctx.wakeupId}
            AND event_id = ${input.sourceEventId} ORDER BY event_id`;
        if (stored === undefined) return yield* missing();
        const event = yield* decodeEvent(stored.json);
        // Asked in a group of the owner and agents: the agent there answers it there.
        if (event._tag === "chat.message" && event.chatId !== self.ownerChatId)
          return yield* passInRoom(ctx, input);
        // One hop: what was passed on is answered where it landed, so two leads can't trade it.
        if (event._tag === "chat.message" && event.origin !== undefined)
          return yield* refuse(
            "This was already passed on to you by another agent, so it stops with you. Answer it, or say in one line what you can't do.",
          );
        // Only the owner's own words in this lead's own chat with them: the owner could have
        // written to the other lead directly, so passing it on reaches nothing new.
        const [asked] =
          event._tag !== "chat.message"
            ? []
            : yield* sql<{ body: string }>`SELECT m.body FROM kin_messages m
                WHERE m.org_id = ${ctx.orgId} AND m.message_id = ${event.messageId}
                  AND m.chat_id = ${event.chatId} AND m.chat_id = ${self.ownerChatId}
                  AND m.author_kind = 'human' AND m.author_person_id = ${self.ownerPersonId}
                  AND m.kind = 'text' AND m.status = 'posted'
                ORDER BY m.message_id`;
        if (asked === undefined || event._tag !== "chat.message")
          return yield* refuse(
            "A request can be passed on only when the owner wrote it to you in your own chat with them. Say in one line which agent owns it instead.",
          );
        // What the lead adds was written with all of this wake-up in view, so it carries only
        // when the owner alone set it off.
        if (!(yield* wakeEvents(ctx)).every((entry) => fromOwnerAlone(entry, self)))
          return yield* refuse(
            "Something from outside your own chat with the owner came in with this, so it can't be passed on now. Say in one line which agent owns it instead.",
          );
        const others = all.filter((entry) => entry.agentId !== ctx.agentId);
        if (others.length === 0)
          return yield* refuse("There is no other agent to pass this to. Answer it yourself.");
        const wanted = fold(input.to);
        const byName = others.filter((entry) => fold(entry.name) === wanted);
        const matches =
          byName.length > 0 ? byName : others.filter((entry) => fold(entry.domain) === wanted);
        if (matches.length !== 1)
          return yield* new KinChatError({
            reason: matches.length === 0 ? "not_found" : "invalid_state",
            message: `${matches.length === 0 ? "No agent here answers to that name or domain" : "Several agents answer to that"}. The agents are: ${describe(others)}. ${NOTHING} Call again with one of those names.`,
          });
        const [target] = matches;
        /** Where this owner message already went: there again is the same hand-off, else refused. */
        const already = Effect.fnUntraced(function* () {
          const [record] = yield* sql<{ toAgentId: KinAgentId }>`SELECT to_agent_id AS "toAgentId"
            FROM kin_handoffs WHERE org_id = ${ctx.orgId} AND message_id = ${event.messageId}
            ORDER BY message_id`;
          if (record === undefined) return undefined;
          if (record.toAgentId === target!.agentId)
            return { to: target!.name, passed: true as const };
          const went = all.find((entry) => entry.agentId === record.toAgentId)?.name;
          return yield* refuse(
            `This was already passed on${went === undefined ? "" : ` to ${went}`}, and a request goes to one agent only. Tell the owner where it went instead.`,
          );
        });
        const before = yield* already();
        if (before !== undefined) return before;
        const dedupeKey = `handoff:${event.messageId}`;
        const id = NodeCrypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 32);
        // The owner's words whole, then one line named as the lead's, so neither passes for the
        // other or for Kin's.
        const note = input.request.replace(/\s+/g, " ");
        const head = `Passed on by ${self.name}`;
        const quoted = `"${asked.body}"`;
        const adds = fold(note) === fold(asked.body) ? [] : [`${self.name} adds: ${note}`];
        const body = [head, quoted, ...adds].join("\n");
        // The other lead is shown no more than this of a message; Kin won't pass on part of one.
        if (body.length > messageBodyLimit)
          return yield* refuse(
            [head, quoted].join("\n").length > messageBodyLimit
              ? "The owner's message is too long for another agent to be shown whole, and Kin won't pass on part of it. Say in one line which agent owns it, so the owner can send it there."
              : "With what you add, this is too long for another agent to be shown whole. Add less and call again.",
          );
        // One hand-off per owner message, whatever words, lead name or wake-up a retry uses. The
        // row is claimed before anything is posted, so a second destination never gets it.
        const claimed = yield* sql<{ toAgentId: KinAgentId }>`INSERT INTO kin_handoffs
            (org_id, message_id, from_agent_id, to_agent_id, event_id, created_at)
          VALUES (${ctx.orgId}, ${event.messageId}, ${ctx.agentId}, ${target!.agentId},
            ${`handoff-${id}`}, ${yield* Clock.currentTimeMillis})
          ON CONFLICT (org_id, message_id) DO NOTHING RETURNING to_agent_id AS "toAgentId"`;
        if (claimed.length === 0) return (yield* already()) ?? (yield* unavailable());
        const { message } = yield* chat.notice({
          orgId: ctx.orgId,
          chatId: target!.ownerChatId,
          audience: "owner",
          messageId: KinMessageId.make(`kin-handoff:${id}`),
          body,
        });
        yield* queue.enqueue({
          _tag: "chat.message",
          orgId: ctx.orgId,
          eventId: KinEventId.make(`handoff-${id}`),
          agentId: target!.agentId,
          receivedAt: DateTime.makeUnsafe(message.createdAt),
          dedupeKey,
          // The passing lead said it, so what the other lead remembers of it is agent-trust.
          provenance: {
            _tag: "agent",
            agentId: ctx.agentId,
            memberId: self.memberId,
            ownerPersonId: self.ownerPersonId,
            threadId: ctx.threadId,
          },
          chatId: target!.ownerChatId,
          messageId: message.messageId,
          origin: { agentId: ctx.agentId, chatId: self.ownerChatId },
        });
        // Passed on after an outside read: the other lead's turn starts outside-read too.
        yield* outsideStamp(ctx).pipe(
          Effect.flatMap((source) => stampEvent(ctx.orgId, `handoff-${id}`, source)),
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return { to: target!.name, passed: true as const };
      }),
    );
  }, guarded("KinHandoff.handOff"));

  return KinHandoff.of({ leads, handOff, takePrivate });
});

export const layer = Layer.effect(KinHandoff, make);
