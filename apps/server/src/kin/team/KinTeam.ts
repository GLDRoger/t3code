import {
  KIN_TEAM_ROOM_TEAM_ID,
  KinAgentId,
  KinChatError,
  KinChatId,
  KinDiscussionId,
  KinEventId,
  KinMemberId,
  KinMessageId,
  KinPersonId,
  KinWakeupId,
  ThreadId,
  TrimmedNonEmptyString,
  type KinAuthor,
  type KinChat,
  type KinMessage,
  type KinOrgId,
  type KinPrincipal,
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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { SHARED_REFUSAL, aborted } from "../lead/Audience.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { outsideStamp, stampEvent } from "../lead/OutsideContent.ts";
import { teamAgent } from "../lead/LeadAccess.ts";
import { resolveLead } from "../lead/LeadMemory.ts";
import { CHIEF_OF_STAFF_DOMAIN } from "../lead/orgLeads.ts";
import { ownerLevel, ownerLevelPeople } from "../people/KinAccess.ts";
import { dayIn } from "../work/money.ts";
import { owedInvoices, ownerZone, startOfDay } from "../work/recordRows.ts";
import { personQuietUntil } from "../triggers/quietHold.ts";
import { changesIn } from "../lead/undoSection.ts";
import { discussionDecision } from "../memory/decisions.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import { stakeholders } from "./stakes.ts";
import { TEAM_ROOM_MUTED, TEAM_ROOM_TITLE, namedAgents, teamRoomOf } from "./teamRoom.ts";
import * as Turns from "./turns.ts";

const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const Intent = Schema.Literals(["answer", "evidence", "objection", "decision", "question"]);

export const TeamOpenInput = Schema.Struct({
  topic: TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
    description: 'What it is about, in a few words, such as "Brochure for new clients".',
  }),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
    description: "The one question to settle.",
  }),
  decider: Name.annotate({
    description:
      "Whose call it is, by name as kin_leads lists them: the agent whose lane the matter is in, else the Chief of staff.",
  }),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)).annotate({
    description: "Your opening message, with what you already know.",
  }),
  to: Schema.optional(
    Schema.Array(Name).check(Schema.isMaxLength(2)).annotate({
      description: "Up to two agents your message asks. Leave out to ask the decider.",
    }),
  ),
});
export const TeamSayInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  intent: Intent,
  discussion: Schema.optional(
    KinDiscussionId.annotate({ description: "Only when you are in more than one discussion." }),
  ),
  to: Schema.optional(
    Schema.Array(Name)
      .check(Schema.isMaxLength(2))
      .annotate({ description: "Up to two agents your message asks, by name." }),
  ),
  widen: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
      description:
        "The decider or the Chief of staff only, once: the wider question that replaces the current one.",
    }),
  ),
  end: Schema.optional(
    Schema.Literals(["decide", "park", "bring"]).annotate({
      description:
        "decide: the decider or the Chief of staff settles it. park: the Chief of staff stops it for now, saying where it stands. bring: the Chief of staff takes a disagreement that is the owner's to decide to him.",
    }),
  ),
  outcome: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(280)).annotate({
      description: "With end: the one line the owner reads, saying what was decided.",
    }),
  ),
  positions: Schema.optional(
    Schema.Array(
      Schema.Struct({
        agent: Name,
        position: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
      }),
    )
      .check(Schema.isMinLength(2), Schema.isMaxLength(2))
      .annotate({ description: "With bring: each side in one line." }),
  ),
  lean: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(240)).annotate({
      description: "With bring: which way you lean and why, in one line.",
    }),
  ),
  options: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(60)))
      .check(Schema.isMinLength(2), Schema.isMaxLength(2))
      .annotate({ description: "With bring: the owner's two taps." }),
  ),
});
export const TeamResult = Schema.Struct({
  discussion: Schema.String,
  // Who Kin wakes next, by name; null once it has ended.
  next: Schema.NullOr(Schema.String),
  state: Schema.String,
});

type Agent = {
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly domain: string;
  readonly ownerChatId: KinChatId;
};
type StoredTurn = Turns.Turn & {
  readonly eventId: string | null;
  readonly said: boolean;
};
type Row = {
  readonly discussionId: KinDiscussionId;
  readonly chatId: KinChatId;
  readonly topic: string;
  readonly question: string;
  readonly origin: "owner" | "agent";
  readonly askChatId: KinChatId | null;
  readonly askAgentId: KinAgentId | null;
  readonly outcome: string | null;
  /** A disagreement card an agent-started discussion holds for the owner's next note. */
  readonly card: HeldCard | null;
  readonly lastAt: number;
  readonly toldAt: number | null;
  readonly d: Turns.Discussion;
  readonly turn: StoredTurn | null;
};

const HeldCard = Schema.Struct({
  chatId: KinChatId,
  agentId: KinAgentId,
  ownerPersonId: KinPersonId,
  threadId: ThreadId,
  question: Schema.String,
  detail: Schema.String,
  options: Schema.Array(Schema.String),
});
type HeldCard = typeof HeldCard.Type;
const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(HeldCard));
const encodeCard = Schema.encodeSync(Schema.fromJsonString(HeldCard));
const Json = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeSync(Json);
const NOTHING = "Nothing was posted.";
const refuse = (message: string) =>
  new KinChatError({ reason: "not_allowed", message: `${message} ${NOTHING}` });
const missing = (message = "Kin record not found.") =>
  new KinChatError({ reason: "not_found", message });
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
            "Kin Team room failed",
            isSqlError(error) ? toPersistenceSqlError(label)(error) : error,
          ).pipe(Effect.andThen(Effect.fail(unavailable()))),
      ),
    );
const fold = (value: string) => value.trim().toLowerCase();
const hash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * The Team room: where agents hold discussions with each other, the one place an agent's message
 * wakes another. Each discussion is a record whose turns, caps and ending are plain code
 * (`turns.ts`); the agents only speak (`team_say`) or pass.
 */
export class KinTeam extends Context.Service<
  KinTeam,
  {
    readonly open: (
      scope: McpInvocationScope,
      input: typeof TeamOpenInput.Type,
    ) => Effect.Effect<typeof TeamResult.Type, KinChatError>;
    /** Whether a person's Team-room message has a discussion of its agents, opened now or before. */
    readonly personAsked: (message: KinMessage) => Effect.Effect<boolean, KinChatError>;
    readonly say: (
      scope: McpInvocationScope,
      input: typeof TeamSayInput.Type,
    ) => Effect.Effect<typeof TeamResult.Type, KinChatError>;
    /** A lead's wake-up ended: a turn it held and spoke nothing in is a pass. */
    readonly wakeupEnded: (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
    }) => Effect.Effect<void>;
    /** The Team room for the org's owner side and live agents, made or brought up to date. */
    readonly ensureRoom: (orgId: KinOrgId) => Effect.Effect<KinChat, KinChatError>;
    /** Idle discussions close, and a turn whose wake-up never ran passes. */
    readonly sweep: () => Effect.Effect<void>;
  }
>()("t3/kin/team/KinTeam") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* KinIdentity;
  const repo = yield* KinChatRepository;
  const chat = yield* KinChatService;
  const memory = yield* Effect.serviceOption(KinMemoryChanges);
  const hub = yield* KinChatHub;
  const queue = yield* KinEventQueue;
  const access = Effect.provideService(SqlClient.SqlClient, sql);
  const lead = (scope: McpInvocationScope) =>
    resolveLead(scope).pipe(
      Effect.provideService(KinIdentity, identity),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  type Lead = Effect.Success<ReturnType<typeof lead>>;

  /** The owner's live leads, oldest first. */
  const agents = Effect.fn("KinTeam.agents")(function* (orgId: KinOrgId) {
    return yield* sql<Agent>`SELECT l.agent_id AS "agentId", l.name, l.domain,
        l.owner_chat_id AS "ownerChatId" FROM kin_leads l
      JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId} AND a.owner_person_id = ${identity.owner.personId}
      ORDER BY a.created_at, l.agent_id`;
  });

  /** The Chief of staff: the team agent, else the chief-of-staff lead, else the oldest. */
  const chairOf = Effect.fn("KinTeam.chair")(function* (
    orgId: KinOrgId,
    all: ReadonlyArray<Agent>,
  ) {
    const team = yield* teamAgent(orgId).pipe(access);
    return (
      all.find((agent) => agent.agentId === team) ??
      all.find((agent) => agent.domain === CHIEF_OF_STAFF_DOMAIN) ??
      all[0]
    );
  });

  const ensureRoom = Effect.fn("KinTeam.ensureRoom")(function* (orgId: KinOrgId) {
    const all = yield* agents(orgId);
    const now = DateTime.formatIso(yield* DateTime.now);
    const found = yield* teamRoomOf(orgId).pipe(access);
    const chair = yield* chairOf(orgId, all);
    const room =
      found === null
        ? yield* repo.createChat({
            orgId,
            chatId: KinChatId.make(SecureRandom.uuidV4Unsafe()),
            kind: "team_group",
            directKey: null,
            title: TEAM_ROOM_TITLE,
            teamId: KIN_TEAM_ROOM_TEAM_ID,
            lastMessageAt: null,
            createdAt: now,
            archivedAt: null,
            leadAgentId: chair?.agentId ?? null,
          })
        : Option.getOrUndefined(yield* repo.getChat({ orgId, chatId: found }));
    if (room === undefined) return yield* missing();
    const members = (yield* repo.listMembers(room)).filter((member) => member.leftAt === null);
    const join = (principal: KinPrincipal, role: "owner" | "member", mutedUntil: string | null) =>
      repo.addMember({
        orgId,
        chatId: room.chatId,
        memberId: KinMemberId.make(SecureRandom.uuidV4Unsafe()),
        principal,
        role,
        joinedAt: now,
        leftAt: null,
        mutedUntil,
      });
    const present = new Set(
      members.flatMap((m) => (m.principal._tag === "person" ? [m.principal.personId] : [])),
    );
    // The owner and co-owners only, muted for good: the room never notifies anyone.
    if (!present.has(identity.owner.personId)) {
      yield* join({ _tag: "person", personId: identity.owner.personId }, "owner", TEAM_ROOM_MUTED);
      present.add(identity.owner.personId);
    }
    for (const personId of yield* ownerLevelPeople(orgId).pipe(access))
      if (!present.has(personId as KinPersonId))
        yield* join(
          { _tag: "person", personId: personId as KinPersonId },
          "member",
          TEAM_ROOM_MUTED,
        );
    for (const agent of all)
      if (
        !members.some((m) => m.principal._tag === "agent" && m.principal.agentId === agent.agentId)
      )
        yield* join({ _tag: "agent", agentId: agent.agentId }, "member", null);
    if (found === null)
      yield* sql.afterCommit(hub.publish({ type: "chat.created", orgId, chat: room }));
    return room;
  });

  const read = Effect.fn("KinTeam.read")(function* (orgId: KinOrgId, discussionId: string) {
    const [row] = yield* sql<{
      discussionId: KinDiscussionId;
      chatId: KinChatId;
      topic: string;
      question: string;
      widened: number;
      decider: string;
      openedBy: string;
      origin: "owner" | "agent";
      askChatId: KinChatId | null;
      askAgentId: KinAgentId | null;
      state: Turns.DiscussionState;
      final: number;
      outcome: string | null;
      card: string | null;
      messages: number;
      units: number;
      objectionUsed: number;
      afterObjection: number | null;
      pending: string;
      turn: string | null;
      offers: string;
      speakers: string;
      chaired: number;
      lastAt: number;
      toldAt: number | null;
    }>`SELECT discussion_id AS "discussionId", chat_id AS "chatId", topic, question, widened,
        decider_agent_id AS decider, opened_by_agent_id AS "openedBy", origin,
        ask_chat_id AS "askChatId", ask_agent_id AS "askAgentId", state, final, outcome,
        card_json AS card, messages, units, objection_used AS "objectionUsed",
        after_objection AS "afterObjection", pending_json AS pending, turn_json AS turn,
        offers_json AS offers, speakers_json AS speakers, chaired, last_at AS "lastAt",
        told_at AS "toldAt"
      FROM kin_discussions WHERE org_id = ${orgId} AND discussion_id = ${discussionId}`;
    if (row === undefined) return undefined;
    const all = yield* agents(orgId);
    const chair = (yield* chairOf(orgId, all))?.agentId ?? row.decider;
    const turn = row.turn === null ? null : (decodeJson(row.turn) as StoredTurn);
    return {
      discussionId: row.discussionId,
      chatId: row.chatId,
      topic: row.topic,
      question: row.question,
      origin: row.origin,
      askChatId: row.askChatId,
      askAgentId: row.askAgentId,
      outcome: row.outcome,
      card: row.card === null ? null : Option.getOrNull(decodeCard(row.card)),
      lastAt: row.lastAt,
      toldAt: row.toldAt,
      turn,
      d: {
        state: row.state,
        final: row.final === 1,
        decider: row.decider,
        chair,
        openedBy: row.openedBy,
        messages: row.messages,
        units: row.units,
        widened: row.widened === 1,
        objectionUsed: row.objectionUsed === 1,
        afterObjection: row.afterObjection,
        pending: decodeJson(row.pending) as ReadonlyArray<Turns.Turn>,
        turn: turn === null ? null : { agentId: turn.agentId, kind: turn.kind },
        offers: decodeJson(row.offers) as Record<string, number>,
        speakers: decodeJson(row.speakers) as ReadonlyArray<string>,
        chaired: row.chaired === 1,
      },
    } satisfies Row;
  });

  /** The message a turn answers: the discussion's latest. */
  const latest = Effect.fn("KinTeam.latest")(function* (orgId: KinOrgId, row: Row) {
    const [found] = yield* sql<{ messageId: KinMessageId }>`SELECT message_id AS "messageId"
      FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${row.chatId}
        AND discussion_id = ${row.discussionId} AND status = 'posted'
      ORDER BY seq DESC LIMIT 1`;
    return found === undefined
      ? undefined
      : Option.getOrUndefined(yield* repo.getMessage({ orgId, messageId: found.messageId }));
  });

  /** Wakes the agent whose turn it is now, in the Team room, from the discussion's latest message. */
  const wakeTurn = Effect.fn("KinTeam.wakeTurn")(function* (
    orgId: KinOrgId,
    row: Row,
    turn: Turns.Turn,
    /** The speaker's turn had read outside text: the next one starts from it (`stampEvent`). */
    outside?: string,
  ) {
    const message = yield* latest(orgId, row);
    if (message === undefined) return null;
    const dedupeKey = `team:${row.discussionId}:${message.seq}:${turn.agentId}:${turn.kind}`;
    const eventId = KinEventId.make(`team-${hash(dedupeKey)}`);
    yield* queue
      .enqueue({
        _tag: "chat.message",
        orgId,
        eventId,
        agentId: KinAgentId.make(turn.agentId),
        receivedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        dedupeKey,
        // The speaker's words: what the woken agent reads of them is agent-trust.
        provenance: message.author,
        chatId: row.chatId,
        messageId: message.messageId,
      })
      .pipe(
        Effect.tap(() => stampEvent(orgId, eventId, outside).pipe(access)),
        Effect.catchTags({
          KinEventQueueConflict: () => Effect.void,
          KinEventQueueRetiredAgent: () => Effect.void,
          KinEventQueueUnknownAgent: () => Effect.void,
        }),
      );
    return eventId;
  });

  /** Stores `d`, wakes its turn if it has a new one, and tells the owner once it has ended. */
  const settle = Effect.fn("KinTeam.settle")(function* (
    orgId: KinOrgId,
    row: Row,
    d: Turns.Discussion,
    changes: {
      readonly said?: boolean;
      readonly question?: string;
      readonly outcome?: string;
      readonly card?: HeldCard;
      readonly lastAt?: number;
      /** The speaking turn's outside stamp, which the next speaker's wake carries. */
      readonly outside?: string | undefined;
    } = {},
  ) {
    const now = yield* Clock.currentTimeMillis;
    const sameTurn =
      d.turn !== null &&
      row.turn !== null &&
      d.turn.agentId === row.turn.agentId &&
      d.turn.kind === row.turn.kind &&
      changes.said !== true;
    let turn: StoredTurn | null = null;
    if (d.turn !== null) turn = sameTurn ? row.turn : { ...d.turn, eventId: null, said: false };
    yield* sql`UPDATE kin_discussions SET state = ${d.state}, final = ${d.final ? 1 : 0},
        question = ${changes.question ?? row.question}, widened = ${d.widened ? 1 : 0},
        outcome = ${changes.outcome ?? row.outcome},
        card_json = ${changes.card === undefined ? (row.card === null ? null : encodeCard(row.card)) : encodeCard(changes.card)},
        messages = ${d.messages}, units = ${d.units}, objection_used = ${d.objectionUsed ? 1 : 0},
        after_objection = ${d.afterObjection}, pending_json = ${encodeJson(d.pending)},
        turn_json = ${turn === null ? null : encodeJson(turn)}, offers_json = ${encodeJson(d.offers)},
        speakers_json = ${encodeJson(d.speakers)}, chaired = ${d.chaired ? 1 : 0},
        last_at = ${changes.lastAt ?? row.lastAt}, ended_at = ${d.final ? now : null}
      WHERE org_id = ${orgId} AND discussion_id = ${row.discussionId}`;
    const next = { ...row, d, turn, question: changes.question ?? row.question };
    // Its latest message is read again, so an open room stops saying it is still going.
    if (d.final && !row.d.final) {
      const touched = yield* sql<{ messageId: KinMessageId }>`UPDATE kin_messages
        SET edited_at = edited_at WHERE org_id = ${orgId} AND message_id = (
          SELECT message_id FROM kin_messages WHERE org_id = ${orgId} AND chat_id = ${row.chatId}
            AND discussion_id = ${row.discussionId} AND status = 'posted'
          ORDER BY seq DESC LIMIT 1)
        RETURNING message_id AS "messageId"`;
      for (const { messageId } of touched) {
        const message = yield* repo.getMessage({ orgId, messageId });
        if (Option.isSome(message))
          yield* sql.afterCommit(
            hub.publish({ type: "message.changed", orgId, message: message.value }),
          );
      }
    }
    if (turn !== null && turn.eventId === null) {
      const eventId = yield* wakeTurn(orgId, next, turn, changes.outside);
      if (eventId !== null)
        yield* sql`UPDATE kin_discussions SET turn_json = ${encodeJson({ ...turn, eventId })}
          WHERE org_id = ${orgId} AND discussion_id = ${row.discussionId}`;
    }
    const outcome = changes.outcome ?? row.outcome;
    if (d.final && d.state === "decided" && outcome !== null && Option.isSome(memory)) {
      const last = yield* latest(orgId, next);
      if (last !== undefined) {
        const decision = discussionDecision({
          orgId,
          discussionId: row.discussionId,
          topic: row.topic,
          question: next.question,
          outcome,
          decider: KinAgentId.make(d.decider),
          chatId: row.chatId,
          messageId: last.messageId,
        });
        // Saving it is a git commit; the turn that ended the discussion doesn't wait for it.
        yield* sql.afterCommit(
          memory.value.recordDecision(orgId, decision).pipe(Effect.forkDetach, Effect.asVoid),
        );
      }
    }
    if (d.final) yield* tell(orgId, row.discussionId);
  });

  /** Posts a disagreement card in the Chief of staff's chat with the owner: two taps. */
  const postCard = (orgId: KinOrgId, discussionId: string, card: HeldCard) =>
    chat.ask(
      {
        _tag: "agent",
        orgId,
        agentId: card.agentId,
        ownerPersonId: card.ownerPersonId,
        threadId: card.threadId,
        hostPosted: true,
      },
      {
        chatId: card.chatId,
        clientMessageId: `kin-team-bring:${discussionId}`,
        question: card.question,
        detail: card.detail,
        options: card.options.map((label) => ({ label, kind: undefined })),
      },
    );

  /**
   * The owner hears an ended discussion once. His own request hears it at once and rings, as one
   * line in the opener's chat with what changed and a link. One the agents started waits for his
   * next note: the check-in that runs next, or the sweep's first pass outside his quiet hours when
   * no check-in is set (`deliverHeld`). A disagreement is told by its card, held the same way.
   */
  const tell = Effect.fn("KinTeam.tell")(function* (
    orgId: KinOrgId,
    discussionId: string,
    when: "final" | "check-in" | "note" = "final",
  ) {
    const row = yield* read(orgId, discussionId);
    if (row === undefined || !row.d.final) return;
    if (row.askChatId === null) return;
    if (when === "final" && row.origin !== "owner") return;
    const claimed =
      yield* sql`UPDATE kin_discussions SET told_at = ${yield* Clock.currentTimeMillis}
      WHERE org_id = ${orgId} AND discussion_id = ${discussionId} AND told_at IS NULL
      RETURNING discussion_id`;
    if (claimed.length === 0) return;
    // His own request's card went out when it was brought; only a held one is stored.
    if (row.d.state === "escalated") {
      if (row.card !== null) yield* postCard(orgId, discussionId, row.card);
      return;
    }
    const last = yield* latest(orgId, row);
    const from =
      last?.author._tag === "agent" ? last.author.agentId : KinAgentId.make(row.d.decider);
    const said =
      row.d.state === "parked"
        ? `Parked: ${row.outcome ?? "the agents couldn't settle it, and nothing changed."}`
        : (row.outcome ?? "Decided.");
    // What it changed, by name, from the record of changes: the same list "undo it" reads.
    const changed = new Map<string, string>();
    for (const change of (yield* changesIn(orgId, discussionId).pipe(access)).toReversed())
      if (!changed.has(change.key) || change.kind === "created")
        changed.set(
          change.key,
          `${change.title.replace(/\s+/g, " ").trim()} (${change.kind === "created" ? "new" : "changed"})`,
        );
    yield* chat.notice({
      orgId,
      chatId: row.askChatId,
      audience: "owner",
      messageId: KinMessageId.make(`kin-team-back:${hash(`${orgId}:${discussionId}`)}`),
      body: [
        oneLine(said),
        ...(changed.size > 0 ? [`Done: ${[...changed.values()].slice(0, 6).join("; ")}`] : []),
      ].join("\n"),
      relay: { kind: "reply_from", agentId: from },
      discussionId: row.discussionId,
      ...(when === "check-in" ? { silent: true as const } : {}),
    });
  });

  /** Agent-started outcomes and cards not yet told, told at the owner's note time. */
  const deliverHeld = Effect.fn("KinTeam.deliverHeld")(function* (
    orgId: KinOrgId,
    when: "check-in" | "note",
  ) {
    const held = yield* sql<{ discussionId: string }>`SELECT discussion_id AS "discussionId"
      FROM kin_discussions WHERE org_id = ${orgId} AND final = 1 AND told_at IS NULL
        AND origin = 'agent' ORDER BY ended_at, discussion_id`;
    for (const { discussionId } of held) yield* tell(orgId, discussionId, when);
  });

  const nameOf = (all: ReadonlyArray<Agent>, agentId: string | undefined) =>
    all.find((agent) => agent.agentId === agentId)?.name ?? null;

  const pick = (all: ReadonlyArray<Agent>, wanted: string) => {
    const byName = all.filter((agent) => fold(agent.name) === fold(wanted));
    const matches =
      byName.length > 0 ? byName : all.filter((agent) => fold(agent.domain) === fold(wanted));
    if (matches.length === 1) return Effect.succeed(matches[0]!);
    return Effect.fail(
      new KinChatError({
        reason: matches.length === 0 ? "not_found" : "invalid_state",
        message: `No one agent answers to "${wanted}". The agents are: ${all.map((agent) => agent.name).join(", ")}. ${NOTHING}`,
      }),
    );
  };

  /** Clients with an open invoice, by name: whatever a message says of them is Finance's too. */
  const owedClients = Effect.fn("KinTeam.owedClients")(function* (orgId: KinOrgId) {
    // The Team room is owner-level, so the company's own figures, unfiltered.
    const owed = yield* owedInvoices({ orgId, now: yield* Clock.currentTimeMillis }).pipe(
      access,
      Effect.orElseSucceed(() => []),
    );
    return [
      ...new Set(
        owed.flatMap((invoice) => (invoice.partyTitle === null ? [] : [invoice.partyTitle])),
      ),
    ].filter((name) => name.trim().length >= 3);
  });

  /** Posts one agent message in the discussion, as that agent's own words in its running turn. */
  const post = Effect.fn("KinTeam.post")(function* (
    ctx: Lead,
    row: { readonly chatId: KinChatId; readonly discussionId: KinDiscussionId },
    input: {
      readonly text: string;
      readonly intent: typeof Intent.Type;
      readonly mentions: ReadonlyArray<KinMemberId>;
    },
  ) {
    const [me] = yield* sql<{ memberId: KinMemberId }>`SELECT member_id AS "memberId"
      FROM kin_chat_members WHERE org_id = ${ctx.orgId} AND chat_id = ${row.chatId}
        AND principal_kind = 'agent' AND agent_id = ${ctx.agentId} AND left_at IS NULL LIMIT 1`;
    if (me === undefined) return yield* missing();
    const author: KinAuthor = {
      _tag: "agent",
      agentId: ctx.agentId,
      memberId: me.memberId,
      ownerPersonId: ctx.ownerPersonId,
      threadId: ctx.threadId,
    };
    const message = yield* repo.insertMessage({
      orgId: ctx.orgId,
      chatId: row.chatId,
      messageId: KinMessageId.make(SecureRandom.uuidV4Unsafe()),
      author,
      // The room holds only the owner side: owner words, checked against its members here.
      audience: "owner",
      kind: "text",
      body: input.text,
      intent: input.intent,
      mentions: [...input.mentions],
      replyTo: null,
      widgetId: null,
      floorRunId: `team:${row.discussionId}`,
      status: "posted",
      sentBy: null,
      clientMessageId: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      editedAt: null,
      discussionId: row.discussionId,
      wakeupId: KinWakeupId.make(ctx.wakeupId),
    });
    yield* sql.afterCommit(hub.publish({ type: "message.posted", orgId: ctx.orgId, message }));
    return message;
  });

  const memberIds = Effect.fn("KinTeam.memberIds")(function* (
    orgId: KinOrgId,
    chatId: KinChatId,
    agentIds: ReadonlyArray<string>,
  ) {
    if (agentIds.length === 0) return [];
    const rows = yield* sql<{ memberId: KinMemberId }>`SELECT member_id AS "memberId"
      FROM kin_chat_members WHERE org_id = ${orgId} AND chat_id = ${chatId}
        AND principal_kind = 'agent' AND agent_id IN ${sql.in(agentIds)} AND left_at IS NULL`;
    return rows.map((r) => r.memberId);
  });

  /** Whether the owner side's own words set off this wake-up: then he asked for this. */
  const askedByOwner = Effect.fn("KinTeam.askedByOwner")(function* (ctx: Lead) {
    const rows = yield* sql<{ personId: KinPersonId }>`SELECT m.author_person_id AS "personId"
      FROM kin_events e JOIN kin_messages m ON m.org_id = e.org_id
        AND m.message_id = json_extract(e.json, '$.messageId') AND m.author_kind = 'human'
      WHERE e.org_id = ${ctx.orgId} AND e.agent_id = ${ctx.agentId} AND e.wakeup_id = ${ctx.wakeupId}
        AND e.tag = 'chat.message' AND json_extract(e.json, '$.origin') IS NULL`;
    for (const row of rows)
      if (yield* ownerLevel(ctx.orgId, row.personId).pipe(access)) return true;
    return false;
  });

  /** Spent by Team-room turns today, against the daily lead limit when the owner set one. */
  const overShare = Effect.fn("KinTeam.overShare")(function* (orgId: KinOrgId, since: number) {
    const [limit] = yield* sql<{ lead: number | null }>`SELECT
        json_extract(limits_json, '$.leadUnits') AS lead FROM kin_budget_limits
      WHERE org_id = ${orgId}`.pipe(Effect.orElseSucceed(() => []));
    if (limit?.lead === null || limit?.lead === undefined) return false;
    const [spent] = yield* sql<{ units: number }>`SELECT COALESCE(SUM(c.units), 0) AS units
      FROM kin_budget_charges c WHERE c.org_id = ${orgId} AND c.wakeup_id IN (
        SELECT e.wakeup_id FROM kin_events e WHERE e.org_id = ${orgId}
          AND e.dedupe_key LIKE 'team:%' AND e.received_at >= ${since})`.pipe(
      Effect.orElseSucceed(() => [{ units: 0 }]),
    );
    // At 80% of the share only discussions the owner asks for open (KinBudget's warning line).
    return (spent?.units ?? 0) >= limit.lead * Turns.TEAM_DAILY_SHARE * 0.8;
  });

  /**
   * The one way a discussion is made, for team_open and for a person's ask: the open caps (an
   * owner-level ask always opens), the same opening retried by `key`, then its row holding `d`.
   */
  const create = Effect.fn("KinTeam.create")(function* (input: {
    readonly orgId: KinOrgId;
    readonly roomId: KinChatId;
    readonly key: string;
    readonly topic: string;
    readonly question: string;
    readonly opener: Agent;
    readonly decider: Agent;
    readonly byOwner: boolean;
    readonly d: Turns.Discussion;
  }) {
    const { orgId } = input;
    const now = yield* Clock.currentTimeMillis;
    const zone = yield* ownerZone(orgId).pipe(access);
    const since = startOfDay(dayIn(now, zone), zone);
    const [counts] = yield* sql<{ today: number; openNow: number }>`SELECT
        COALESCE(SUM(CASE WHEN origin = 'agent' AND created_at >= ${since} THEN 1 ELSE 0 END), 0) AS today,
        COALESCE(SUM(CASE WHEN origin = 'agent' AND final = 0 THEN 1 ELSE 0 END), 0) AS "openNow"
      FROM kin_discussions WHERE org_id = ${orgId}`;
    const refusal = Turns.openRefusal({
      byOwner: input.byOwner,
      agentStartedToday: counts?.today ?? 0,
      openNow: counts?.openNow ?? 0,
      overShare: yield* overShare(orgId, since),
    });
    if (refusal !== null) return yield* refuse(`${refusal} Work it out in your own lane.`);
    const [again] = yield* sql<{ discussionId: string }>`SELECT discussion_id AS "discussionId"
      FROM kin_discussions WHERE org_id = ${orgId} AND open_key = ${input.key}`.pipe(
      Effect.orElseSucceed(() => []),
    );
    if (again !== undefined) {
      const row = yield* read(orgId, again.discussionId);
      if (row !== undefined) return { row, again: true };
    }
    const [max] = yield* sql<{
      n: number | null;
    }>`SELECT MAX(CAST(SUBSTR(discussion_id, 4) AS INTEGER)) AS n
      FROM kin_discussions WHERE org_id = ${orgId}`;
    const discussionId = KinDiscussionId.make(`TD-${(max?.n ?? 0) + 1}`);
    yield* sql`INSERT INTO kin_discussions (org_id, discussion_id, chat_id, topic, question,
        decider_agent_id, opened_by_agent_id, origin, ask_chat_id, ask_agent_id, state,
        pending_json, turn_json, created_at, last_at, open_key)
      VALUES (${orgId}, ${discussionId}, ${input.roomId}, ${oneLine(input.topic)},
        ${oneLine(input.question)}, ${input.decider.agentId}, ${input.opener.agentId},
        ${input.byOwner ? "owner" : "agent"}, ${input.opener.ownerChatId}, ${input.opener.agentId},
        'open', ${encodeJson(input.d.pending)},
        ${encodeJson({ ...input.d.turn, eventId: null, said: false })}, ${now}, ${now}, ${input.key})`;
    const row = yield* read(orgId, discussionId);
    if (row === undefined) return yield* missing();
    return { row, again: false };
  });

  const open = Effect.fn("KinTeam.open")(function* (
    scope: McpInvocationScope,
    input: typeof TeamOpenInput.Type,
  ) {
    const ctx = yield* lead(scope);
    if (yield* aborted(ctx).pipe(access)) return yield* refuse(SHARED_REFUSAL);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Kin opened one for a person's ask and this agent holds its turn: a second would split it.
        const [mine] = yield* sql<{ discussionId: string }>`SELECT discussion_id AS "discussionId"
          FROM kin_discussions WHERE org_id = ${ctx.orgId} AND final = 0
            AND open_key LIKE 'message:%'
            AND json_extract(turn_json, '$.agentId') = ${ctx.agentId}
          ORDER BY created_at LIMIT 1`;
        if (mine !== undefined)
          return yield* refuse(
            `Kin already opened ${mine.discussionId} for what was asked, and it is your turn in it. Answer there with team_say.`,
          );
        const room = yield* ensureRoom(ctx.orgId);
        const all = yield* agents(ctx.orgId);
        const self = all.find((agent) => agent.agentId === ctx.agentId);
        if (self === undefined) return yield* missing();
        const chair = (yield* chairOf(ctx.orgId, all)) ?? self;
        const decider = yield* pick(all, input.decider);
        const to = yield* Effect.forEach(input.to ?? [], (name) => pick(all, name));
        const byOwner = yield* askedByOwner(ctx);
        const d = Turns.opened({
          openedBy: ctx.agentId,
          decider: decider.agentId,
          chair: chair.agentId,
        });
        // The same opening retried in this wake-up is the same discussion.
        const { row, again } = yield* create({
          orgId: ctx.orgId,
          roomId: room.chatId,
          key: `${ctx.wakeupId}:${fold(input.topic)}`,
          topic: input.topic,
          question: input.question,
          opener: self,
          decider,
          byOwner,
          d,
        });
        if (again)
          return {
            discussion: row.discussionId,
            next: nameOf(all, row.d.turn?.agentId),
            state: row.d.state,
          };
        const now = yield* Clock.currentTimeMillis;
        const discussionId = row.discussionId;
        const asked = to.length > 0 ? to : [decider];
        const message = yield* post(ctx, row, {
          text: input.text,
          intent: "question",
          mentions: yield* memberIds(
            ctx.orgId,
            room.chatId,
            asked.map((agent) => agent.agentId),
          ),
        });
        const said: Turns.Said = {
          agentId: ctx.agentId,
          intent: "question",
          to: asked.map((agent) => agent.agentId).filter((id) => id !== ctx.agentId),
          widen: false,
          end: null,
          stakes: stakeholders(
            `${input.topic} ${input.question} ${input.text}`,
            all.filter((agent) => agent.agentId !== chair.agentId),
            yield* owedClients(ctx.orgId),
          ),
        };
        const next = Turns.afterSay(d, said);
        yield* settle(ctx.orgId, row, next, {
          said: true,
          lastAt: now,
          outside: yield* outsideStamp(ctx).pipe(access),
        });
        // Asked by the owner: the agent it went to shows it in its chat with him, sent by the opener.
        const receiver = asked.find((agent) => agent.agentId !== ctx.agentId);
        if (byOwner && receiver !== undefined)
          yield* chat.notice({
            orgId: ctx.orgId,
            chatId: receiver.ownerChatId,
            audience: "owner",
            messageId: KinMessageId.make(`kin-team-sent:${hash(`${ctx.orgId}:${discussionId}`)}`),
            body: `${oneLine(input.question)}\n${message.body}`,
            relay: { kind: "sent_by", agentId: ctx.agentId },
            discussionId,
            silent: true,
          });
        // Where he asked, one quiet line that it started, linking to it.
        if (byOwner)
          yield* chat.notice({
            orgId: ctx.orgId,
            chatId: self.ownerChatId,
            audience: "owner",
            messageId: KinMessageId.make(
              `kin-team-started:${hash(`${ctx.orgId}:${discussionId}`)}`,
            ),
            body: `Started a Team room discussion: ${oneLine(input.topic)}`,
            discussionId,
            silent: true,
          });
        return {
          discussion: discussionId,
          next: nameOf(all, next.turn?.agentId),
          state: next.state,
        };
      }),
    );
  }, guarded("KinTeam.open"));

  /**
   * A person's Team-room message naming two or more of the room's agents opens their discussion,
   * as the first-named agent's team_open would, with no turn spent opening it. True when this
   * message has its discussion, so no agent answers it as a plain reply. While another
   * discussion is open, it stays an ordinary message.
   */
  const personAsked = Effect.fn("KinTeam.personAsked")(function* (message: KinMessage) {
    const { orgId } = message;
    if (message.author._tag !== "human") return false;
    if ((yield* teamRoomOf(orgId).pipe(access)) !== message.chatId) return false;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Handled again after a restart: the discussion it opened is its answer.
        const key = `message:${message.messageId}`;
        const [seen] = yield* sql`SELECT 1 FROM kin_discussions
          WHERE org_id = ${orgId} AND open_key = ${key}`;
        if (seen !== undefined) return true;
        const stored = Option.getOrUndefined(
          yield* repo.getMessage({ orgId, messageId: message.messageId }),
        );
        if (
          stored === undefined ||
          stored.chatId !== message.chatId ||
          stored.author._tag !== "human" ||
          stored.status !== "posted" ||
          stored.kind !== "text" ||
          stored.origin !== undefined ||
          !(yield* ownerLevel(orgId, stored.author.personId).pipe(access))
        )
          return false;
        const all = yield* agents(orgId);
        const members = new Set(
          (yield* sql<{ agentId: string }>`SELECT agent_id AS "agentId" FROM kin_chat_members
            WHERE org_id = ${orgId} AND chat_id = ${message.chatId} AND principal_kind = 'agent'
              AND left_at IS NULL ORDER BY agent_id`).map((row) => row.agentId),
        );
        const named = namedAgents(
          stored.body,
          all.filter((agent) => members.has(agent.agentId)),
        );
        const [first] = named;
        if (first === undefined || named.length < 2) return false;
        // Answered as an ordinary message once (another discussion was open): that stands.
        const [plain] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
          AND dedupe_key LIKE ${`chat-message:${message.messageId}:%`} LIMIT 1`;
        const [busy] = yield* sql`SELECT 1 FROM kin_discussions
          WHERE org_id = ${orgId} AND final = 0 LIMIT 1`;
        if (plain !== undefined || busy !== undefined) return false;
        const chair = (yield* chairOf(orgId, all)) ?? first;
        const decider = named.find((agent) => agent.agentId === chair.agentId) ?? first;
        const d = Turns.askedByPerson({
          first: first.agentId,
          asked: named.map((agent) => agent.agentId),
          decider: decider.agentId,
          chair: chair.agentId,
        });
        const question = oneLine(stored.body);
        const { row } = yield* create({
          orgId,
          roomId: message.chatId,
          key,
          topic: question.length <= 120 ? question : `${question.slice(0, 119).trimEnd()}…`,
          question,
          opener: first,
          decider,
          byOwner: true,
          d,
        });
        // The discussion's first message: its first turn answers it.
        yield* sql`UPDATE kin_messages SET discussion_id = ${row.discussionId}
          WHERE org_id = ${orgId} AND message_id = ${message.messageId} AND discussion_id IS NULL`;
        yield* settle(orgId, row, d);
        return true;
      }),
    );
  }, guarded("KinTeam.personAsked"));

  const say = Effect.fn("KinTeam.say")(function* (
    scope: McpInvocationScope,
    input: typeof TeamSayInput.Type,
  ) {
    const ctx = yield* lead(scope);
    if (yield* aborted(ctx).pipe(access)) return yield* refuse(SHARED_REFUSAL);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const mine = yield* sql<{ discussionId: string }>`SELECT discussion_id AS "discussionId"
          FROM kin_discussions WHERE org_id = ${ctx.orgId} AND final = 0
            AND json_extract(turn_json, '$.agentId') = ${ctx.agentId}
            AND (${input.discussion ?? null} IS NULL OR discussion_id = ${input.discussion ?? null})
          ORDER BY created_at`;
        const all = yield* agents(ctx.orgId);
        if (mine.length === 0 && input.discussion === undefined) {
          const [open] = yield* sql`SELECT 1 FROM kin_discussions
            WHERE org_id = ${ctx.orgId} AND final = 0 LIMIT 1`;
          return yield* refuse(
            open === undefined
              ? "No Team-room discussion is open. team_open starts one: the question, whose call it is and who joins."
              : "It isn't your turn in any Team-room discussion. Kin wakes you when it is.",
          );
        }
        if (mine.length === 0)
          return yield* refuse("It isn't your turn in that discussion. Kin wakes you when it is.");
        if (mine.length > 1)
          return yield* refuse(
            `You hold a turn in ${mine.map((m) => m.discussionId).join(" and ")}: say which in discussion.`,
          );
        const row = yield* read(ctx.orgId, mine[0]!.discussionId);
        if (row === undefined) return yield* missing();
        const to = yield* Effect.forEach(input.to ?? [], (name) => pick(all, name));
        const end = input.end ?? null;
        const said: Turns.Said = {
          agentId: ctx.agentId,
          intent: input.intent,
          to: to.map((agent) => agent.agentId),
          widen: input.widen !== undefined,
          end,
          stakes: stakeholders(
            input.text,
            all.filter((agent) => agent.agentId !== row.d.chair),
            yield* owedClients(ctx.orgId),
          ),
        };
        const refusal = Turns.sayRefusal(row.d, said);
        if (refusal !== null) return yield* refuse(refusal);
        if (end !== null && input.outcome === undefined)
          return yield* refuse("Say the outcome: the one line the owner reads.");
        if (
          end === "bring" &&
          (input.positions === undefined || input.lean === undefined || input.options === undefined)
        )
          return yield* refuse(
            "To bring it to the owner, give both positions, your lean and his two options.",
          );
        yield* post(ctx, row, {
          text: input.text,
          intent: end === "decide" ? "decision" : input.intent,
          mentions: yield* memberIds(ctx.orgId, row.chatId, said.to),
        });
        const now = yield* Clock.currentTimeMillis;
        const next = Turns.afterSay(row.d, said);
        yield* settle(ctx.orgId, row, next, {
          said: true,
          lastAt: now,
          outside: yield* outsideStamp(ctx).pipe(access),
          ...(input.widen === undefined ? {} : { question: oneLine(input.widen) }),
          ...(input.outcome === undefined ? {} : { outcome: oneLine(input.outcome) }),
        });
        if (end === "bring" && input.positions !== undefined && input.options !== undefined) {
          const chair = all.find((agent) => agent.agentId === row.d.chair);
          const card: HeldCard | undefined =
            chair === undefined
              ? undefined
              : {
                  chatId: chair.ownerChatId,
                  agentId: ctx.agentId,
                  ownerPersonId: ctx.ownerPersonId,
                  threadId: ctx.threadId,
                  question: (input.outcome ?? row.topic).slice(0, 240),
                  detail: [
                    ...input.positions.map((p) => `${p.agent}: ${oneLine(p.position)}`),
                    `I lean: ${oneLine(input.lean ?? "")}`,
                  ].join("\n"),
                  options: input.options,
                };
          // His own request asks him now; one the agents started waits for his next note.
          if (card !== undefined && row.origin === "owner")
            yield* postCard(ctx.orgId, row.discussionId, card);
          else if (card !== undefined)
            yield* sql`UPDATE kin_discussions SET card_json = ${encodeCard(card)}
              WHERE org_id = ${ctx.orgId} AND discussion_id = ${row.discussionId}`;
        }
        return {
          discussion: row.discussionId,
          next: nameOf(all, next.turn?.agentId),
          state: next.state,
        };
      }),
    );
  }, guarded("KinTeam.say"));

  const wakeupEnded = Effect.fn("KinTeam.wakeupEnded")(
    function* (input: {
      readonly orgId: KinOrgId;
      readonly agentId: KinAgentId;
      readonly wakeupId: string;
    }) {
      const held = yield* sql<{ discussionId: string }>`SELECT d.discussion_id AS "discussionId"
        FROM kin_discussions d JOIN kin_events e ON e.org_id = d.org_id
          AND e.event_id = json_extract(d.turn_json, '$.eventId')
        WHERE d.org_id = ${input.orgId} AND d.final = 0
          AND json_extract(d.turn_json, '$.agentId') = ${input.agentId}
          AND e.wakeup_id = ${input.wakeupId}
        ORDER BY d.created_at`;
      // What this wake-up cost counts against the discussions it took turns in.
      const ran = yield* sql<{ discussionId: string }>`SELECT DISTINCT
          substr(dedupe_key, 6, instr(substr(dedupe_key, 6), ':') - 1) AS "discussionId"
        FROM kin_events WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}
          AND dedupe_key LIKE 'team:TD-%' ORDER BY 1`;
      const [charged] = yield* sql<{ units: number }>`SELECT COALESCE(SUM(units), 0) AS units
        FROM kin_budget_charges WHERE org_id = ${input.orgId} AND wakeup_id = ${input.wakeupId}`;
      const share = ran.length === 0 ? 0 : Math.ceil((charged?.units ?? 0) / ran.length);
      if (share > 0)
        for (const { discussionId } of ran)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const row = yield* read(input.orgId, discussionId);
              if (row === undefined || row.d.final) return;
              const next = Turns.afterUnits(row.d, share);
              yield* settle(input.orgId, row, next);
            }),
          );
      const checkIn = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${input.orgId}
        AND wakeup_id = ${input.wakeupId} AND tag = 'pulse'
        AND json_extract(json, '$.checkIn') IS NOT NULL LIMIT 1`;
      if (checkIn.length > 0) yield* sql.withTransaction(deliverHeld(input.orgId, "check-in"));
      for (const { discussionId } of held)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* read(input.orgId, discussionId);
            if (row === undefined || row.turn === null || row.turn.said) return;
            yield* settle(input.orgId, row, Turns.afterPass(row.d, input.agentId));
          }),
        );
    },
    Effect.catchCause((cause) => Effect.logError("Kin Team room turn end failed", { cause })),
  );

  /**
   * A day without a message closes a discussion; a turn whose event never ran counts as a pass.
   * Each org with two or more agents gets its Team room, and new agents and co-owners join it.
   */
  const sweep = Effect.fn("KinTeam.sweep")(
    function* () {
      const now = yield* Clock.currentTimeMillis;
      // Scheduler maintenance across orgs; each room is org-scoped.
      const orgs = yield* sql<{ orgId: KinOrgId }>`SELECT l.org_id AS "orgId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
          AND a.role = 'lead' AND a.retired_at IS NULL
        GROUP BY l.org_id HAVING COUNT(*) >= 2 ORDER BY l.org_id`;
      for (const { orgId } of orgs)
        yield* sql
          .withTransaction(ensureRoom(orgId))
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Kin Team room upkeep failed", { orgId, cause }),
            ),
          );
      // With no check-in set, the next note is the first pass outside the owner's quiet hours.
      const held = yield* sql<{ orgId: KinOrgId; owner: KinPersonId }>`SELECT DISTINCT
          d.org_id AS "orgId", a.owner_person_id AS owner FROM kin_discussions d
        JOIN kin_agents a ON a.org_id = d.org_id AND a.agent_id = d.opened_by_agent_id
        WHERE d.final = 1 AND d.told_at IS NULL AND d.origin = 'agent'
          AND NOT EXISTS (SELECT 1 FROM kin_schedules s JOIN scheduled_tasks t ON t.task_id = s.task_id
            JOIN kin_agents o ON o.org_id = s.org_id AND o.agent_id = s.agent_id
            WHERE s.org_id = d.org_id AND o.owner_person_id = a.owner_person_id AND s.check_in = 1
              AND s.deleted_at IS NULL AND t.enabled = 1)
        ORDER BY d.org_id`;
      for (const { orgId, owner } of held)
        if ((yield* personQuietUntil(orgId, owner, now).pipe(access)) === undefined)
          yield* sql
            .withTransaction(deliverHeld(orgId, "note"))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Kin held Team-room outcome not told", { orgId, cause }),
              ),
            );
      const rows = yield* sql<{
        orgId: KinOrgId;
        discussionId: string;
        lastAt: number;
        eventState: string | null;
      }>`SELECT d.org_id AS "orgId", d.discussion_id AS "discussionId", d.last_at AS "lastAt",
          (SELECT e.state FROM kin_events e WHERE e.org_id = d.org_id
            AND e.event_id = json_extract(d.turn_json, '$.eventId')) AS "eventState"
        FROM kin_discussions d WHERE d.final = 0 ORDER BY d.org_id, d.created_at LIMIT 200`;
      for (const found of rows)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* read(found.orgId, found.discussionId);
            if (row === undefined || row.d.final) return;
            if (now - row.lastAt >= Turns.TEAM_IDLE_MS)
              return yield* settle(found.orgId, row, Turns.afterIdle(row.d), { lastAt: now });
            if (
              row.turn !== null &&
              !row.turn.said &&
              (found.eventState === "expired" || found.eventState === "failed")
            )
              yield* settle(found.orgId, row, Turns.afterPass(row.d, row.turn.agentId));
          }),
        );
    },
    Effect.catchCause((cause) => Effect.logWarning("Kin Team room sweep failed", { cause })),
  );

  return KinTeam.of({
    open,
    personAsked,
    say,
    wakeupEnded,
    ensureRoom: Effect.fn("KinTeam.ensureRoomNow")(
      (orgId: KinOrgId) => sql.withTransaction(ensureRoom(orgId)),
      guarded("KinTeam.ensureRoomNow"),
    ),
    sweep,
  });
});

export const layer = Layer.effect(KinTeam, make);
