import {
  KinChatError,
  formatKinMoney,
  type KinChartUnit,
  type KinAgentIntent,
  KinChatId,
  type KinMessage,
  type KinMessageRelay,
  KinMessageId,
  type KinMessagesSendInput,
  type KinReaction,
  type KinReactionEmoji,
  type KinWidget,
  KinWidgetId,
  KinAgentId,
  KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import type { AgentIdentity } from "../chat/KinIdentity.ts";
import {
  AUDIENCE_MOVED,
  PRIVATE_DESTINATION,
  SHARED_ELSEWHERE,
  SHARED_OTHER_CHAT,
  OTHERS_CHAT,
  behindAllIn,
  ownerAlone,
  SHARED_REFUSAL,
  aborted,
  askedIn,
  destination,
  effectiveAudience,
  turnPeople,
} from "./Audience.ts";
import * as KinLevels from "./KinLevels.ts";
import { directKey } from "./LeadAccess.ts";
import { holdFor, holdLine, urgentNow } from "../triggers/quietHold.ts";
import { unreadableBy } from "../work/teamView.ts";

type PostInput = KinMessagesSendInput & {
  readonly intent: KinAgentIntent;
  readonly placeReplyFigures?: true;
};
type PostToInput = PostInput & {
  /** Why it can't wait for their quiet hours: logged, and it posts now. */
  readonly urgent?: string | undefined;
  /** It waits at least until then, as a nudge does for their working hours. */
  readonly notBefore?: number | undefined;
  /** Another person's words the agent passes on (`kin_relay`), drawn as sent by them. */
  readonly relay?: KinMessageRelay | undefined;
};
/**
 * A message for a person that waits, stored, for their quiet hours to end or their working
 * hours to start (`why`), and is delivered by `deliverHeld`.
 */
export type HeldPost = {
  readonly _tag: "held";
  readonly at: number;
  readonly zone: string;
  readonly why: "quiet" | "off" | "away";
};
export const isHeld = (posted: KinMessage | HeldPost): posted is HeldPost =>
  "_tag" in posted && posted._tag === "held";
type WidgetInput = Parameters<KinChatService["Service"]["upsertWidget"]>[1];
type AskInput = Parameters<KinChatService["Service"]["ask"]>[1];
type ChartInput = Parameters<KinChatService["Service"]["chart"]>[1];
type VisualInput = Parameters<KinChatService["Service"]["visual"]>[1];
type ReadInput = Parameters<KinChatService["Service"]["read"]>[1];

/**
 * A lead's posts, cards, questions and reactions behind its permission in the chat: below L1 it
 * is refused, except in its own direct chat with its owner, where it always talks.
 */
export class KinLevelGate extends Context.Service<
  KinLevelGate,
  {
    /** `bind` runs in the post's own transaction: what the message settles commits with it. */
    readonly post: (
      agent: AgentIdentity,
      input: PostInput,
      bind?: (message: KinMessage) => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<KinMessage, KinChatError>;
    /**
     * A message written for one teammate, in their own direct chat with the lead. An owner-level
     * turn may send it, though they are not the owner, when its text holds nothing they can't
     * see (`unreadableBy`): a nudge, a relayed answer, a question about their work. In their
     * quiet hours it is held to their end, unless urgent or it answers what they just wrote.
     */
    readonly postTo: (
      agent: AgentIdentity,
      personId: KinPersonId,
      input: PostToInput,
    ) => Effect.Effect<(KinMessage & { readonly replaced?: number }) | HeldPost, KinChatError>;
    /** The turn's one reply grows by its next segment, gated like the post that began it. */
    readonly extend: (
      agent: AgentIdentity,
      input: Parameters<KinChatService["Service"]["extendReply"]>[1],
      bind?: (message: KinMessage) => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<KinMessage, KinChatError>;
    readonly upsertWidget: (
      agent: AgentIdentity,
      input: WidgetInput,
    ) => Effect.Effect<KinWidget, KinChatError>;
    /**
     * `kin_ask`'s choice card, gated like a post: it is the lead's reply too. `bind` runs in the
     * card's own transaction, so no tap reaches the card before what it answers knows it.
     */
    readonly ask: (
      agent: AgentIdentity,
      input: AskInput,
      bind?: (widget: KinWidget) => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<KinWidget, KinChatError>;
    /**
     * A question card for one person in their own direct chat with the lead (`askPerson.ts`),
     * under every check `ask` makes; a shared turn may post there too, its route checked by the
     * caller. Kin posts it, spending no floor grant. Held for their quiet hours or away days,
     * nothing is posted and `bind` gets null.
     */
    readonly askTo: (
      agent: AgentIdentity,
      personId: KinPersonId,
      input: AskInput,
      bind: (widget: KinWidget | null) => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<KinWidget | HeldPost, KinChatError>;
    /**
     * `askTo` for a person's own press on a card in their chat with the lead (`draftCards`): no
     * turn of the lead's is running or borrowed, so the caller has checked the press itself.
     * The destination's level, their own direct chat and their quiet hours are checked as for
     * `askTo`.
     */
    readonly askToOnPress: (
      agent: AgentIdentity,
      personId: KinPersonId,
      input: AskInput,
      bind: (widget: KinWidget | null) => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<KinWidget | HeldPost, KinChatError>;
    /** A doc card, gated like a post. */
    /** Closes the agent's own unanswered choice cards that a newer card replaced. */
    readonly closeReplaced: (
      agent: Turn,
      widgetIds: ReadonlyArray<string>,
      /** The newer card that replaces them. */
      by?: KinWidgetId,
    ) => Effect.Effect<void, KinChatError>;
    readonly showCard: (
      agent: AgentIdentity,
      input: Parameters<KinChatService["Service"]["showCard"]>[1],
    ) => Effect.Effect<KinWidget, KinChatError>;
    /** `kin_chart`'s chart card, gated like a post: it says what the reply could have in text. */
    readonly chart: (
      agent: AgentIdentity,
      input: ChartInput,
    ) => Effect.Effect<KinWidget | { readonly figure: string }, KinChatError>;
    /** `kin_visual`'s card, gated like a post. */
    readonly visual: (
      agent: AgentIdentity,
      input: VisualInput,
    ) => Effect.Effect<KinWidget | { readonly figure: string }, KinChatError>;
    readonly settleFigures: (
      ...args: Parameters<KinChatService["Service"]["settleFigures"]>
    ) => Effect.Effect<void, KinChatError>;
    readonly setChoiceOutcome: (
      agent: AgentIdentity,
      input: Parameters<KinChatService["Service"]["setChoiceOutcome"]>[1],
      bind: () => Effect.Effect<void, SqlError.SqlError>,
    ) => Effect.Effect<boolean, KinChatError>;
    /** `kin_react`: the lead's reaction, gated like a post since it can stand for its reply. */
    readonly react: (
      agent: AgentIdentity,
      input: {
        readonly chatId: KinChatId;
        readonly messageId: KinMessageId;
        readonly emoji: KinReactionEmoji;
      },
    ) => Effect.Effect<KinReaction, KinChatError>;
    /** `kin_chat_read`: a turn someone besides the owner reads reads only the chat it was asked in. */
    readonly read: (
      agent: AgentIdentity,
      input: ReadInput,
    ) => Effect.Effect<ReadonlyArray<KinMessage>, KinChatError>;
  }
>()("t3/kin/lead/LevelGate/KinLevelGate") {}

const isChatError = Schema.is(KinChatError);
type Turn = { readonly orgId: KinOrgId; readonly agentId: KinAgentId; readonly wakeupId: string };
/** An owner-only turn tried to write where someone else reads; nothing is written there. */
class PrivateDestination extends Schema.TaggedError<PrivateDestination>()("PrivateDestination", {
  orgId: KinOrgId,
  agentId: KinAgentId,
  wakeupId: Schema.String,
}) {}
const isPrivateDestination = Schema.is(PrivateDestination);
const isLevelRefused = Schema.is(KinLevels.KinLevelRefused);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const chat = yield* KinChatService;

  // The lead's own direct chat with its owner, read from stored rows only.
  const isOwnerChat = Effect.fn("KinLevelGate.isOwnerChat")(
    function* (agent: AgentIdentity, chatId: KinChatId) {
      const rows = yield* sql<{ chatId: string }>`
        SELECT c.chat_id AS "chatId" FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = l.owner_chat_id
        WHERE l.org_id = ${agent.orgId} AND l.agent_id = ${agent.agentId}
          AND a.role = 'lead' AND a.retired_at IS NULL
          AND c.kind = 'direct' AND c.chat_id = ${chatId}
        ORDER BY l.agent_id`;
      return rows.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.isOwnerChat")),
  );

  // The running wake-up of the calling lead thread; the reply bridge names its own.
  /**
   * A page in a turn others read carries only figures every one of them may see, as a message
   * to each would; the page's text and data are read as its words.
   */
  const everyoneSees = Effect.fn("KinLevelGate.everyoneSees")(
    function* (agent: AgentIdentity, text: string) {
      const turn = yield* turnOf(agent);
      if (turn === undefined || (yield* effectiveAudience(turn)) !== "shared") return;
      for (const person of (yield* turnPeople(turn))?.people ?? [])
        if ((yield* unreadableBy(agent.orgId, KinPersonId.make(person), text)) !== undefined)
          return yield* new KinChatError({
            reason: "not_allowed",
            message:
              "Nothing was posted: this picture has figures not everyone in this chat may see. Make it from what they all see, or show it to the owner in their own chat.",
          });
    },
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError((error) =>
      isChatError(error)
        ? error
        : new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
    ),
  );

  const turnOf = Effect.fn("KinLevelGate.turnOf")(
    function* (agent: AgentIdentity) {
      if (agent.wakeupId !== undefined)
        return { orgId: agent.orgId, agentId: agent.agentId, wakeupId: agent.wakeupId };
      const [row] = yield* sql<{ wakeupId: string }>`SELECT wakeup_id AS "wakeupId"
        FROM kin_wakeups WHERE org_id = ${agent.orgId} AND agent_id = ${agent.agentId}
          AND thread_id = ${agent.threadId} AND status = 'running'
        ORDER BY wakeup_id`;
      return row === undefined
        ? undefined
        : { orgId: agent.orgId, agentId: agent.agentId, wakeupId: row.wakeupId };
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.turnOf")),
  );

  const notAllowed = new KinChatError({
    reason: "not_allowed",
    message: "You can't post in this chat. Nothing was sent.",
  });

  // Said once per wake-up in the lead's owner chat, so a routine's lost post isn't silent.
  const tellOwner = Effect.fn("KinLevelGate.tellOwner")(
    function* (turn: Turn, chatId: KinChatId) {
      const [row] = yield* sql<{ ownerChatId: string; name: string; title: string | null }>`
        SELECT l.owner_chat_id AS "ownerChatId", l.name, c.title FROM kin_leads l
        JOIN kin_chats c ON c.org_id = l.org_id AND c.chat_id = ${chatId}
        WHERE l.org_id = ${turn.orgId} AND l.agent_id = ${turn.agentId}
        ORDER BY l.agent_id`;
      if (row === undefined) return;
      yield* chat.notice({
        orgId: turn.orgId,
        chatId: KinChatId.make(row.ownerChatId),
        messageId: KinMessageId.make(`kin-private-destination:${turn.wakeupId}`),
        audience: "owner",
        body: `${row.name} couldn't post in ${row.title ?? "a group"}: other people are in it.`,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Kin could not tell the owner about a withheld post", { cause }),
    ),
  );

  /**
   * Runs `allowed` in one transaction with the check; refuses below L1 outside the owner's DM.
   * The level is the lower of the target chat's and the asking wake-up's, so a chat can't post
   * through the lead where it couldn't itself.
   */
  /** Whether `chatId` is this person's own direct chat with the lead, and they are in it. */
  const theirDirect = Effect.fn("KinLevelGate.theirDirect")(
    function* (agent: AgentIdentity, personId: KinPersonId, chatId: KinChatId) {
      const rows = yield* sql`SELECT 1 FROM kin_chats c
        JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
          AND m.principal_kind = 'person' AND m.person_id = ${personId} AND m.left_at IS NULL
        WHERE c.org_id = ${agent.orgId} AND c.chat_id = ${chatId} AND c.kind = 'direct'
          AND c.direct_key = ${directKey(personId, agent.agentId)}
        LIMIT 1`;
      return rows.length > 0;
    },
    Effect.mapError(toPersistenceSqlError("KinLevelGate.theirDirect")),
  );

  const gated = <A, E>(
    operation: string,
    agent: AgentIdentity,
    chatId: KinChatId,
    allowed: Effect.Effect<A, E>,
    to?: {
      readonly personId: KinPersonId;
      readonly text: string;
      /** A shared turn may write there too: the person's own chat, its route checked already. */
      readonly outside?: true;
    },
  ): Effect.Effect<A, KinChatError> =>
    // A turn found shared stays shared: settled before the write's transaction, which a
    // refusal rolls back. The destination is checked again inside it.
    turnOf(agent).pipe(
      Effect.flatMap((turn) =>
        turn === undefined
          ? Effect.void
          : effectiveAudience(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
      Effect.ignore,
      Effect.andThen(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const target = yield* KinLevels.effectiveLevel({
                orgId: agent.orgId,
                agentId: agent.agentId,
                chatId,
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
              const level =
                agent.wakeupId === undefined
                  ? target
                  : KinLevels.lowest(
                      target,
                      yield* KinLevels.wakeupLevel({
                        orgId: agent.orgId,
                        agentId: agent.agentId,
                        wakeupId: agent.wakeupId,
                      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
                    );
              if (!KinLevels.atLeast(level, "L1") && !(yield* isOwnerChat(agent, chatId)))
                return yield* notAllowed;
              // Authorised against the destination chat, in this transaction: a shared turn speaks
              // only in its own chat, an owner-only prompt only where every human is the owner.
              const turn = yield* turnOf(agent);
              if (turn === undefined) return yield* notAllowed;
              const where = yield* destination(turn, chatId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
              if (where === "moved" || where === "aborted")
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: AUDIENCE_MOVED,
                });
              if (where === "elsewhere" && to?.outside !== true)
                return yield* new KinChatError({
                  reason: "not_allowed",
                  message: SHARED_ELSEWHERE,
                });
              // A message for a person goes only to their own direct chat: it skips the floor.
              if (to !== undefined && !(yield* theirDirect(agent, to.personId, chatId)))
                return where === "private"
                  ? yield* new PrivateDestination(turn)
                  : yield* notAllowed;
              if (where === "private") {
                if (to === undefined) return yield* new PrivateDestination(turn);
                const why = yield* unreadableBy(agent.orgId, to.personId, to.text).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                );
                if (why !== undefined)
                  return yield* new KinChatError({
                    reason: "not_allowed",
                    message: `Nothing was sent: ${why}. Send it again without that, or ask the owner to share it with them.`,
                  });
              }
              return yield* allowed;
            }),
          )
          .pipe(
            Effect.catch((error) =>
              isPrivateDestination(error)
                ? tellOwner(error, chatId).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new KinChatError({ reason: "not_allowed", message: PRIVATE_DESTINATION }),
                      ),
                    ),
                  )
                : isChatError(error)
                  ? Effect.fail(error)
                  : isLevelRefused(error)
                    ? Effect.fail(notAllowed)
                    : Effect.logError(`Kin ${operation} failed`, error).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new KinChatError({
                              reason: "unavailable",
                              message: "Kin is unavailable.",
                            }),
                          ),
                        ),
                      ),
            ),
          ),
      ),
    );

  /** Kin's question card for one person, or held for their quiet hours: `bind` gets null. */
  const askHeld = Effect.fn("KinLevelGate.askHeld")(
    function* (
      agent: AgentIdentity,
      personId: KinPersonId,
      input: AskInput,
      bind: (widget: KinWidget | null) => Effect.Effect<void, SqlError.SqlError>,
    ) {
      const where = { orgId: agent.orgId, personId, chatId: input.chatId, unasked: true };
      const held = yield* holdFor(where);
      if (held === undefined)
        return yield* chat
          .ask({ ...agent, hostPosted: true }, { ...input, forChat: true })
          .pipe(Effect.tap(bind));
      yield* bind(null);
      return { _tag: "held" as const, at: held.at, zone: held.zone, why: held.why };
    },
    Effect.provideService(SqlClient.SqlClient, sql),
  );

  const read = Effect.fn("KinLevelGate.read")(
    function* (agent: AgentIdentity, input: ReadInput) {
      const turn = yield* turnOf(agent);
      if (turn === undefined) return yield* notAllowed;
      if (yield* aborted(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
        return yield* new KinChatError({ reason: "not_allowed", message: SHARED_REFUSAL });
      const shared =
        (yield* effectiveAudience(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql))) ===
        "shared";
      if (
        shared &&
        !(yield* askedIn(turn, input.chatId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(toPersistenceSqlError("KinLevelGate.read")),
        ))
      )
        return yield* new KinChatError({ reason: "not_allowed", message: SHARED_OTHER_CHAT });
      // A co-owner's owner-tier turn reads the chats they are in, never the owner's own.
      if (
        !shared &&
        !(yield* ownerAlone(turn).pipe(Effect.provideService(SqlClient.SqlClient, sql))) &&
        !(yield* behindAllIn(turn, input.chatId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        ))
      )
        return yield* new KinChatError({ reason: "not_allowed", message: OTHERS_CHAT });
      return yield* chat.read(agent, input);
    },
    Effect.catchIf(
      (error) => !isChatError(error),
      (error) =>
        Effect.logError("Kin gated read failed", error).pipe(
          Effect.andThen(
            Effect.fail(
              new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
            ),
          ),
        ),
    ),
  );

  return KinLevelGate.of({
    read,
    post: Effect.fn("KinLevelGate.post")((agent, input, bind) =>
      gated(
        "gated post",
        agent,
        input.chatId,
        bind === undefined
          ? chat.send(agent, input)
          : chat.send(agent, input).pipe(Effect.tap(bind)),
      ),
    ),
    // Words only: a file or a doc reference could carry what the text check can't read.
    postTo: Effect.fn("KinLevelGate.postTo")((agent, personId, input) =>
      gated(
        "gated message",
        agent,
        input.chatId,
        Effect.gen(function* () {
          const where = { orgId: agent.orgId, personId, chatId: input.chatId };
          const replaced =
            input.urgent === undefined
              ? 0
              : yield* urgentNow({
                  ...where,
                  agentId: agent.agentId,
                  wakeupId: agent.wakeupId,
                  reason: input.urgent,
                });
          const held =
            input.urgent === undefined
              ? yield* holdFor({ ...where, notBefore: input.notBefore })
              : undefined;
          if (held !== undefined)
            return {
              _tag: "held" as const,
              zone: held.zone,
              why: held.why,
              at: yield* holdLine({
                ...where,
                key: input.clientMessageId,
                body: input.body,
                audience: "chat",
                at: held.at,
                agentId: agent.agentId,
                relay: input.relay,
              }),
            };
          const sent = yield* chat.send(agent, {
            chatId: input.chatId,
            clientMessageId: input.clientMessageId,
            body: input.body,
            intent: input.intent,
            forChat: true,
            ...(input.relay === undefined ? {} : { relay: input.relay }),
          });
          return replaced === 0 ? sent : { ...sent, replaced };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        { personId, text: input.body },
      ),
    ),
    extend: Effect.fn("KinLevelGate.extend")((agent, input, bind) =>
      gated(
        "gated reply",
        agent,
        input.chatId,
        bind === undefined
          ? chat.extendReply(agent, input)
          : chat.extendReply(agent, input).pipe(Effect.tap(bind)),
      ),
    ),
    upsertWidget: Effect.fn("KinLevelGate.upsertWidget")((agent, input) =>
      gated("gated widget upsert", agent, input.chatId, chat.upsertWidget(agent, input)),
    ),
    ask: Effect.fn("KinLevelGate.ask")((agent, input, bind) =>
      gated(
        "gated ask",
        agent,
        input.chatId,
        bind === undefined ? chat.ask(agent, input) : chat.ask(agent, input).pipe(Effect.tap(bind)),
      ),
    ),
    closeReplaced: Effect.fn("KinLevelGate.closeReplaced")(
      function* (agent, widgetIds, by) {
        for (const widgetId of widgetIds)
          yield* chat.closeReplaced({
            orgId: agent.orgId,
            widgetId: KinWidgetId.make(widgetId),
            ...(by === undefined ? {} : { by }),
          });
      },
      Effect.catchIf(
        (error) => !isChatError(error),
        (error) =>
          Effect.logError("Kin closing a replaced card failed", error).pipe(
            Effect.andThen(
              Effect.fail(
                new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
              ),
            ),
          ),
      ),
    ),
    askTo: Effect.fn("KinLevelGate.askTo")((agent, personId, input, bind) =>
      gated("gated ask to", agent, input.chatId, askHeld(agent, personId, input, bind), {
        personId,
        text: [input.question, input.detail ?? "", ...input.options.map((one) => one.label)].join(
          "\n",
        ),
        outside: true,
      }),
    ),
    askToOnPress: Effect.fn("KinLevelGate.askToOnPress")((agent, personId, input, bind) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const level = yield* KinLevels.effectiveLevel({
              orgId: agent.orgId,
              agentId: agent.agentId,
              chatId: input.chatId,
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            if (!KinLevels.atLeast(level, "L1") && !(yield* isOwnerChat(agent, input.chatId)))
              return yield* notAllowed;
            if (!(yield* theirDirect(agent, personId, input.chatId))) return yield* notAllowed;
            return yield* askHeld(agent, personId, input, bind);
          }),
        )
        .pipe(
          Effect.catch((error) =>
            isChatError(error)
              ? Effect.fail(error)
              : isLevelRefused(error)
                ? Effect.fail(notAllowed)
                : Effect.logError("Kin ask on a press failed", error).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new KinChatError({ reason: "unavailable", message: "Kin is unavailable." }),
                      ),
                    ),
                  ),
          ),
        ),
    ),
    showCard: Effect.fn("KinLevelGate.showCard")((agent, input) =>
      gated("gated card", agent, input.chatId, chat.showCard(agent, input)),
    ),
    settleFigures: Effect.fn("KinLevelGate.settleFigures")((agent, chatId, intent) =>
      gated("gated figures", agent, chatId, chat.settleFigures(agent, chatId, intent)),
    ),
    setChoiceOutcome: Effect.fn("KinLevelGate.setChoiceOutcome")((agent, input, bind) =>
      gated(
        "gated choice outcome",
        agent,
        input.chatId,
        chat
          .setChoiceOutcome(agent, input)
          .pipe(Effect.tap((saved) => (saved ? bind() : Effect.void))),
      ),
    ),
    chart: Effect.fn("KinLevelGate.chart")(function* (agent, input) {
      const label = (unit: KinChartUnit, value: number | null) =>
        value === null
          ? ""
          : unit.kind === "money"
            ? formatKinMoney(Math.round(value), unit.currency)
            : String(value);
      const words = [
        input.title,
        input.caption,
        ...(input.labels ?? []),
        ...(input.series ?? []).flatMap((series) => [
          series.name,
          ...series.values.map((value) => label(input.unit, value)),
        ]),
        ...(input.comparison === undefined
          ? []
          : [
              input.comparison.name,
              ...input.comparison.values.map((value) => label(input.unit, value)),
            ]),
        ...(input.target === undefined
          ? []
          : [input.target.name, label(input.unit, input.target.value)]),
        input.scatter?.xName,
        input.scatter?.yName,
        ...(input.scatter?.series ?? []).flatMap((series) => [
          series.name,
          ...series.points.flatMap((point) => [
            point.label,
            label(input.scatter?.xUnit ?? { kind: "count" }, point.x),
            label(input.unit, point.y),
          ]),
        ]),
      ];
      yield* everyoneSees(agent, words.join("\n"));
      return yield* gated("gated chart", agent, input.chatId, chat.chart(agent, input));
    }),
    visual: Effect.fn("KinLevelGate.visual")(function* (agent, input) {
      yield* everyoneSees(agent, `${input.title}\n${input.html.replace(/<[^>]*>/g, " ")}`);
      return yield* gated("gated visual", agent, input.chatId, chat.visual(agent, input));
    }),
    react: Effect.fn("KinLevelGate.react")((agent, input) =>
      gated("gated reaction", agent, input.chatId, chat.react(agent, { ...input, on: true })),
    ),
  });
});

export const layer = Layer.effect(KinLevelGate, make);
